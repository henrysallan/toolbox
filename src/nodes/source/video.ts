import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  AudioChainElementLeaf,
  AudioValue,
  ImageSequenceParamValue,
  NodeDefinition,
  RenderContext,
  UvValue,
  VideoFileParamValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";
import { pushMediaSettle, videoSeekSettle } from "@/engine/offline-settle";
import {
  decodeExrLayerAsync,
  exrDecodeBacklog,
  findExrLayer,
  type ExrDecodeResult,
} from "@/engine/exr";
import {
  NEAREST_MAX,
  PARK_AFTER_MS,
  SEQ_AHEAD,
  SEQ_BEHIND,
  drawPlanStamp,
  planPausedDraw,
  planPlayingDraw,
  planSeqWindow,
  type DrawPlan,
  type DrawProbe,
} from "@/engine/video-frame-cache";
import {
  ensureVideoDecodeSource,
  getVideoDecodeSource,
} from "@/engine/video-decode-source";
import {
  acquireFrameStore,
  cancelStoreJob,
  peekFrameStore,
  releaseFrameStore,
  requestFrames,
  sourceIsExact,
  type FrameStore,
} from "@/engine/video-frame-store";
import {
  TRANSFORM_TRS_PARAMS,
  bindTrsUniforms,
} from "@/engine/transform-value";

// Video source. Each frame: optionally sync the <video> element's clock to
// ctx.time, upload whatever's currently decoded to a GL texture, then draw
// it through the same fit+TRS math as Image Source. Texture alpha is left at
// whatever the video decoded (usually opaque); contain letterboxes with
// transparent alpha. Flip-Y on sample because <video> sits in DOM y-down
// but the pipeline expects y-up.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
uniform vec2 u_translate; // screen convention (Y down)
uniform vec2 u_scale;
uniform float u_angle;    // radians
uniform vec2 u_pivot;     // screen convention (Y down)
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  // Inverse TRS in output space before the aspect fit — see image-source.ts.
  vec2 pivot = vec2(u_pivot.x, 1.0 - u_pivot.y);
  vec2 translate = vec2(u_translate.x, -u_translate.y);
  uv = uv - translate;
  vec2 p = uv - pivot;
  float c = cos(u_angle);
  float s = sin(u_angle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  vec2 sc = u_scale;
  if (abs(sc.x) < 1e-4) sc.x = 1e-4;
  if (abs(sc.y) < 1e-4) sc.y = 1e-4;
  p /= sc;
  uv = p + pivot;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec2 samp = 0.5 + (uv - 0.5) * u_invScale;
  if (u_letterbox > 0.5 && (samp.x < 0.0 || samp.x > 1.0 || samp.y < 0.0 || samp.y > 1.0)) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, vec2(samp.x, 1.0 - samp.y));
}`;

interface VideoState {
  videoRef: HTMLVideoElement | null;
  // Identity-stable element-leaf chain descriptor for the audio aux
  // (080826_audio-nodes.md) — minted once per element/url so the audio
  // reconciler's identity diff short-circuits (this node is stable:false).
  audioLeaf: AudioChainElementLeaf | null;
  tex: WebGLTexture | null;
  // True once we've successfully uploaded at least one decoded frame.
  // Lets us render the last good frame while a seek is in flight —
  // setting currentTime is async, so readyState drops to 1 until the
  // new frame decodes. Without this, sync_to_scene_time mode flickers
  // black every frame because every tick triggers a fresh seek.
  hasUploadedFrame: boolean;
  lastVideoWidth: number;
  lastVideoHeight: number;
  // Media time of the frame currently in `tex` (-1 before the first
  // upload). fingerprintExtras stamps it while the element is mid-seek so
  // the fingerprint describes the frame this eval will draw, not the
  // element's clock — see the note there.
  lastUploadedTime: number;
  // ── WebCodecs frame cache (specs 090426_video-frame-cache.md and
  // 090526_video-scrub-optimizations.md). The cache itself is per FILE and
  // shared by every node reading it (engine/video-frame-store.ts); the
  // node only binds to it. Playback, audio and offline export never touch
  // it except to serve frames while the element catches up after a seek.
  store: FrameStore | null;
  storeFor: VideoFileParamValue | null; // param value the binding is for
  // Per-node scrub bookkeeping: the last paused target and when it last
  // changed (the park timer), plus the timer that re-evaluates once the
  // playhead has rested long enough to park the element.
  lastTarget: number | null;
  targetChangedAt: number;
  parkTimer: ReturnType<typeof setTimeout> | null;
}

function ensureState(
  ctx: import("@/engine/types").RenderContext,
  nodeId: string
): VideoState {
  const key = `video-source:${nodeId}`;
  const existing = ctx.state[key] as VideoState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("video-source: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: VideoState = {
    videoRef: null, audioLeaf: null, tex,
    hasUploadedFrame: false,
    lastVideoWidth: 0, lastVideoHeight: 0,
    lastUploadedTime: -1,
    store: null,
    storeFor: null,
    lastTarget: null,
    targetChangedAt: 0,
    parkTimer: null,
  };
  ctx.state[key] = s;
  return s;
}

// ── Paused-path frame cache plumbing ──────────────────────────────────

// The element's media target for scene time `time` — the one number the
// sync branch, the cache lookup and the fingerprint stamp all key on.
function elementTarget(
  params: Record<string, unknown>,
  video: HTMLVideoElement,
  paramFile: VideoFileParamValue,
  time: number
): number {
  const speed = (params.speed as number) ?? 1;
  const startOffset = (params.start_offset as number) ?? 0;
  const dur = Math.max(0.0001, video.duration || paramFile.duration || 1);
  let target = time * speed + startOffset;
  if (params.loop) {
    target = ((target % dur) + dur) % dur;
  } else {
    target = Math.max(0, Math.min(dur - 0.0001, target));
  }
  return target;
}

// The cache serves only the sync'd, paused (or pre-rolling), realtime
// path. Playback rides the element's decoder; offline export keeps its
// deterministic seek + settle.
function onPausedPath(params: Record<string, unknown>, ctx: RenderContext): boolean {
  return (
    !!params.sync_to_scene_time && !ctx.offline && (!ctx.playing || ctx.preroll === true)
  );
}

// Sync'd realtime playback: the cache may cover for the element while a
// hard seek is in flight.
function onCatchupPath(params: Record<string, unknown>, ctx: RenderContext): boolean {
  return (
    !!params.sync_to_scene_time && !ctx.offline && ctx.playing && ctx.preroll !== true
  );
}

// Pure read of what compute will find — shared by compute and
// fingerprintExtras so the stamp predicts the drawn frame exactly.
function probeDraw(
  state: VideoState | null,
  video: HTMLVideoElement,
  paramFile: VideoFileParamValue,
  target: number
): DrawProbe<WebGLTexture> {
  const source = getVideoDecodeSource(paramFile);
  // No state yet (a node's first eval) → the shared store, if another
  // node already filled it, is what compute will bind to.
  const store = state
    ? state.storeFor === paramFile
      ? state.store
      : null
    : peekFrameStore(paramFile);
  const cacheReady = source !== null && store !== null && store.gl !== null;
  const uploadable = !video.seeking && video.readyState >= 2;
  return {
    target,
    elementTexTime: uploadable
      ? video.currentTime
      : (state?.lastUploadedTime ?? -1),
    elementSeeking: video.seeking,
    restingMs:
      state && state.lastTarget === target
        ? performance.now() - state.targetChangedAt
        : 0,
    cacheReady,
    cacheExact: cacheReady && source ? sourceIsExact(source) : true,
    hit: cacheReady ? store!.cache.lookup(target) : null,
    nearest: cacheReady ? store!.cache.nearest(target, NEAREST_MAX) : null,
  };
}

// While playing the store is read-only: serve a cached frame only while
// the element is catching up after a hard seek (see planPlayingDraw).
function probePlaying(
  state: VideoState,
  video: HTMLVideoElement,
  paramFile: VideoFileParamValue,
  target: number
) {
  const store = state.storeFor === paramFile ? state.store : null;
  const uploadable = !video.seeking && video.readyState >= 2;
  return {
    target,
    elementTexTime: uploadable ? video.currentTime : state.lastUploadedTime,
    elementSeeking: video.seeking,
    hit: store && store.gl ? store.cache.lookup(target) : null,
  };
}

// Bind the node to the file's shared store (a re-pick rebinds) and kick
// the decoder init. Idempotent per eval.
function syncStore(
  state: VideoState,
  paramFile: VideoFileParamValue,
  gl: WebGL2RenderingContext,
  nodeId: string
): void {
  ensureVideoDecodeSource(paramFile);
  if (state.storeFor !== paramFile) {
    if (state.storeFor) releaseFrameStore(state.storeFor, nodeId);
    state.store = acquireFrameStore(paramFile, gl, nodeId);
    state.storeFor = paramFile;
    state.lastTarget = null;
  } else if (state.store && state.store.gl !== gl) {
    // Backend recreated under us — rebind to the new context.
    state.store = acquireFrameStore(paramFile, gl, nodeId);
  }
}

function bumpPipeline(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

// The park timer: nothing re-evaluates a resting editor on its own, so
// when the plan is waiting on the rest period, schedule one bump for the
// moment it elapses. Cleared whenever the target moves.
function armParkTimer(state: VideoState, restingMs: number): void {
  if (state.parkTimer) return;
  const wait = Math.max(0, PARK_AFTER_MS - restingMs) + 5;
  state.parkTimer = setTimeout(() => {
    state.parkTimer = null;
    bumpPipeline();
  }, wait);
}

function clearParkTimer(state: VideoState): void {
  if (state.parkTimer) {
    clearTimeout(state.parkTimer);
    state.parkTimer = null;
  }
}

// ── Image-sequence playback state ──────────────────────────────────────
// Parallel to VideoState but for the sequence source kind. Frames are kept
// as encoded Blobs in the param value; here we lazily decode the currently-
// needed frame to a GL texture and keep a small LRU of recent ones so
// scrubbing back is instant. Offline export registers a settle promise on
// the in-flight decode so capture waits for the right frame.
interface SequenceState {
  tex: WebGLTexture | null; // last-good texture currently being shown
  // frames[] index that `tex` holds (-1 before the first upload) — the
  // fingerprint stamps it when the playhead's frame is not decoded yet.
  texIdx: number;
  // Previous timeline frame — the decode-ahead window leans in the drag
  // direction (090526_video-scrub-optimizations.md M7).
  lastFrame: number | null;
  hasUploadedFrame: boolean;
  lastW: number;
  lastH: number;
  // Identity of the param value the cache was built for — a new pick resets.
  valueRef: ImageSequenceParamValue | null;
  // EXR frames decode per (layer, unpremultiply); a change invalidates every
  // cached texture. Empty string for bitmap sequences.
  exrKey: string;
  // For each timeline index [0, length), the frames[] array index to show
  // (forward-filled so gaps hold the previous present frame).
  resolved: number[];
  cache: Map<number, WebGLTexture>; // frames[] index → uploaded texture
  cacheBytes: Map<number, number>; // frames[] index → GPU byte estimate
  totalBytes: number;
  lru: number[]; // frames[] indices, least-recent first
  // Decoded, awaiting GL upload — ImageBitmap for stills, float RGBA for EXR.
  pending: Map<number, ImageBitmap | ExrDecodeResult>;
  decoding: Set<number>; // decode in flight
}

// Pending decodes are capped by count; uploaded textures by a byte budget —
// counting frames is the wrong unit when a 4K RGBA16F frame is ~66MB but a
// 720p bitmap is ~3.7MB. The budget always keeps at least the current frame.
const SEQ_PENDING_CAP = 40;
const SEQ_CACHE_BYTES = 512 * 1024 * 1024;
// EXR decode is seconds-per-frame at 4K: keep its decode-ahead small and
// backlog-gated. Bitmap stills decode in a few ms, so they get the full
// planSeqWindow (SEQ_AHEAD / SEQ_BEHIND) with this many decodes in flight.
const SEQ_DECODE_AHEAD = 3;
const SEQ_DECODE_CONCURRENCY = 6;

function ensureSeqState(ctx: RenderContext, nodeId: string): SequenceState {
  const key = `video-seq:${nodeId}`;
  const existing = ctx.state[key] as SequenceState | undefined;
  if (existing) return existing;
  const s: SequenceState = {
    tex: null,
    texIdx: -1,
    lastFrame: null,
    hasUploadedFrame: false,
    lastW: 0,
    lastH: 0,
    valueRef: null,
    exrKey: "",
    resolved: [],
    cache: new Map(),
    cacheBytes: new Map(),
    totalBytes: 0,
    lru: [],
    pending: new Map(),
    decoding: new Set(),
  };
  ctx.state[key] = s;
  return s;
}

// Free every GL texture + decoded frame held by a sequence cache. Called on
// a fresh pick (value identity change), an EXR layer switch, and on dispose.
function clearSeqCache(gl: WebGL2RenderingContext, s: SequenceState): void {
  for (const tex of s.cache.values()) gl.deleteTexture(tex);
  s.cache.clear();
  s.cacheBytes.clear();
  s.totalBytes = 0;
  s.lru.length = 0;
  for (const decoded of s.pending.values()) {
    if (decoded instanceof ImageBitmap) decoded.close();
  }
  s.pending.clear();
  s.decoding.clear();
  s.tex = null;
  s.texIdx = -1;
  s.lastFrame = null;
  s.hasUploadedFrame = false;
}

// Forward-fill the timeline→frame map so missing numbers hold the previous
// present frame (AE-style). frames[] is sorted ascending by `number`.
function buildResolved(value: ImageSequenceParamValue): number[] {
  const resolved = new Array<number>(Math.max(1, value.length));
  let fi = 0;
  for (let i = 0; i < resolved.length; i++) {
    const num = value.min + i;
    while (fi + 1 < value.frames.length && value.frames[fi + 1].number <= num) {
      fi++;
    }
    resolved[i] = fi;
  }
  return resolved;
}

// Create a texture configured like the video upload path (LINEAR, clamp,
// straight alpha) and upload an ImageBitmap into it.
function uploadBitmapTexture(
  gl: WebGL2RenderingContext,
  bmp: ImageBitmap
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("image-sequence: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// HDR sibling of uploadBitmapTexture: straight-alpha float RGBA → RGBA16F
// (filterable in core WebGL2; values > 1 survive). Rows are already in
// ImageBitmap order, so the same fit-shader Y-flip applies.
function uploadFloatTexture(
  gl: WebGL2RenderingContext,
  frame: ExrDecodeResult
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("exr-sequence: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16F,
    frame.width,
    frame.height,
    0,
    gl.RGBA,
    gl.FLOAT,
    frame.data
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// Scene time → (timeline frame, frames[] index) for the sequence kind.
// Shared by compute and fingerprintExtras so the stamp predicts exactly
// the frame compute will look up. Requires s.resolved to be current.
function seqTarget(
  params: Record<string, unknown>,
  s: SequenceState,
  time: number
): { localFrame: number; targetIdx: number } {
  const length = s.resolved.length;
  const speed = (params.speed as number) ?? 1;
  const startOffset = (params.start_offset as number) ?? 0;
  const seqFps = Math.max(1, (params.seq_fps as number) ?? 24);
  let localFrame = Math.floor((time * speed + startOffset) * seqFps);
  if (params.loop) {
    localFrame = ((localFrame % length) + length) % length;
  } else {
    localFrame = Math.max(0, Math.min(length - 1, localFrame));
  }
  return { localFrame, targetIdx: s.resolved[localFrame] ?? 0 };
}

function touchLru(s: SequenceState, idx: number): void {
  const at = s.lru.indexOf(idx);
  if (at >= 0) s.lru.splice(at, 1);
  s.lru.push(idx);
}

// Record a cached texture's GPU byte estimate for the eviction budget.
function recordCacheBytes(s: SequenceState, idx: number, bytes: number): void {
  s.totalBytes += bytes - (s.cacheBytes.get(idx) ?? 0);
  s.cacheBytes.set(idx, bytes);
}

// Evict least-recently-used textures past the byte budget, never the
// current index.
function evictSeq(
  gl: WebGL2RenderingContext,
  s: SequenceState,
  keepIdx: number
): void {
  while (s.totalBytes > SEQ_CACHE_BYTES && s.lru.length > 1) {
    const victim = s.lru[0] === keepIdx ? s.lru[1] : s.lru[0];
    const at = s.lru.indexOf(victim);
    if (at >= 0) s.lru.splice(at, 1);
    const tex = s.cache.get(victim);
    if (tex) gl.deleteTexture(tex);
    s.cache.delete(victim);
    s.totalBytes -= s.cacheBytes.get(victim) ?? 0;
    s.cacheBytes.delete(victim);
  }
}

export const videoNode: NodeDefinition = {
  type: "video-source",
  name: "Video Source",
  category: "image",
  subcategory: "generator",
  description:
    "Load a video file and render its current frame. Sync the clock to scene time for deterministic playback (good for exports), or let it play on its own.",
  facts: {
    space: {
      "param:translateX": "uv01",
      "param:translateY": "uv01",
      "param:pivotX": "uv01",
      "param:pivotY": "uv01",
    },
    reads: ["time"],
    gotchas: [
      "sync_to_scene_time drives currentTime to time*speed+start_offset (looped or clamped to duration); off, the element free-runs and only tracks scene play/pause.",
      "source_kind=sequence maps scene time to a frame index via seq_fps and forward-fills gaps between numbered frames; exr_layer/exr_unpremultiply apply only to EXR sequences.",
      "The video's own audio track stays muted unless this node's audio aux output is wired into Output's audio socket; volume only matters when audible.",
      "translateX/Y, scaleX/Y, rotate and pivotX/Y apply as inverse TRS in output UV before the fit; pixels outside the transformed unit square are transparent.",
      "fit=contain letterboxes with transparent alpha outside the video bounds, not opaque black.",
      "Offline export always pauses and hard-seeks to the exact frame and waits for the decode to settle before capture, regardless of playbackRate soft-sync used live.",
      "One <video> element has one currentTime, so this node is not retimeable; a wrapping Time Offset passes scene time through unshifted instead of retiming it.",
    ],
  },
  backend: "webgl2",
  supportsTransformGizmo: true,
  // Always re-evaluate — video frames change over time regardless of params.
  stable: false,
  // One media element, one currentTime — cannot exist at two clocks in one
  // eval. Time Offset boundary-feeds the outer frame through un-shifted.
  retimeable: false,
  inputs: [{ name: "uv_in", label: "UV", type: "uv", required: false }],
  params: [
    OPACITY_PARAM,
    // Source kind: a single video file, or an image sequence (numbered
    // stills played as frames). Default "video" so existing saves — which
    // lack this param — keep their video behavior.
    {
      name: "source_kind",
      label: "Source",
      type: "enum",
      options: ["video", "sequence"],
      default: "video",
      control: "segmented",
    },
    {
      name: "file",
      label: "Video",
      type: "video_file",
      default: null,
      visibleIf: (p) => (p.source_kind ?? "video") !== "sequence",
    },
    {
      name: "sequence",
      label: "Image sequence",
      type: "image_sequence",
      default: null,
      visibleIf: (p) => p.source_kind === "sequence",
    },
    // Image sequences have no intrinsic frame rate — this maps scene time to
    // frame index. Only meaningful for the sequence kind.
    {
      name: "seq_fps",
      label: "Sequence FPS",
      type: "scalar",
      min: 1,
      max: 120,
      step: 1,
      default: 24,
      visibleIf: (p) => p.source_kind === "sequence",
    },
    // EXR sequences only: which layer/AOV of a multilayer file feeds the
    // image output. Options come from the loaded file's header (the
    // `exr_layer` control reads them off the sequence param value); the
    // stored value is the layer's stable id, "" = the default (first) layer.
    {
      name: "exr_layer",
      label: "Layer",
      type: "enum",
      options: [],
      control: "exr_layer",
      default: "",
      visibleIf: (p) =>
        p.source_kind === "sequence" &&
        !!(p.sequence as ImageSequenceParamValue | null)?.exr,
    },
    // EXR stores associated (premultiplied) alpha; the engine is straight-
    // alpha. Off = trust the file to be straight already (rare) or preserve
    // premultiplied compositing math downstream.
    {
      name: "exr_unpremultiply",
      label: "Un-premultiply alpha",
      type: "boolean",
      default: true,
      visibleIf: (p) =>
        p.source_kind === "sequence" &&
        !!(p.sequence as ImageSequenceParamValue | null)?.exr,
    },
    {
      name: "fit",
      label: "Fit",
      type: "enum",
      options: ["cover", "contain", "stretch"],
      default: "cover",
    },
    // Standard TRS block — same names as Transform / Image Source so the
    // on-canvas gizmo drives them. Inverse-sampled in output UV before fit.
    ...TRANSFORM_TRS_PARAMS,
    {
      name: "sync_to_scene_time",
      label: "Sync to scene time",
      type: "boolean",
      default: true,
    },
    {
      name: "speed",
      label: "Speed",
      type: "scalar",
      min: -4,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "start_offset",
      label: "Start offset (s)",
      type: "scalar",
      min: 0,
      max: 3600,
      softMax: 60,
      step: 0.01,
      default: 0,
    },
    {
      name: "loop",
      label: "Loop",
      type: "boolean",
      default: true,
    },
    // Volume for the video's own audio track. Only reaches the speakers when
    // the node's `audio` output is wired into the Output node's audio socket
    // (see the muting logic in compute). Hidden for image sequences, which
    // carry no audio.
    {
      name: "volume",
      label: "Volume",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => (p.source_kind ?? "video") !== "sequence",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],
  // The video's audio track rides out an `audio` aux output (parallel to
  // Audio Source's primary). Image sequences have no audio, so the socket
  // only appears for the video source kind.
  resolveAuxOutputs(params) {
    if ((params.source_kind ?? "video") === "sequence") return [];
    return [{ name: "audio", type: "audio" }];
  },
  linkedPairs: [{ a: "scaleX", b: "scaleY" }],

  // Mix the video element's currentTime into the fingerprint. Scene-time
  // already busts downstream caches for sync'd playback, but free-running
  // playback (sync off) advances the video clock independently — this
  // ensures downstream nodes see a fresh output whenever a new frame lands.
  //
  // Both kinds stamp THE FRAME THIS EVAL WILL DRAW rather than the clock.
  // A media frame can change without scene time changing (a seek or a
  // decode lands, the paused editor re-evaluates via pipeline-bump), and a
  // frame can fail to change when time does (the seek is still in flight).
  // Fingerprints are computed before compute runs, so the stamp has to
  // predict compute's choice: the element's frame is uploadable exactly
  // when `!seeking && readyState >= 2` (a currentTime write drops
  // readyState synchronously; while seeking, currentTime already reports
  // the pending target, so stamping it would make "still seeking to T" and
  // "landed at T, uploading" fingerprint-identical and every cacheable
  // node downstream would keep compositing the stale texture). Audit:
  // specdocs/090426_video-scrub-audit.md F1b.
  fingerprintExtras(params, ctx, nodeId) {
    if ((params.source_kind as string) === "sequence") {
      const seq = params.sequence as ImageSequenceParamValue | null | undefined;
      const s = nodeId
        ? (ctx.state[`video-seq:${nodeId}`] as SequenceState | undefined)
        : undefined;
      if (!seq || !s || s.valueRef !== seq || s.resolved.length === 0) {
        return "sq:-";
      }
      const { targetIdx } = seqTarget(params, s, ctx.time);
      const ready = s.cache.has(targetIdx) || s.pending.has(targetIdx);
      return `sq:${ready ? targetIdx : s.texIdx}`;
    }
    const v = params.file as VideoFileParamValue | null | undefined;
    if (!v?.video) return "";
    const video = v.video;
    const s = nodeId
      ? (ctx.state[`video-source:${nodeId}`] as VideoState | undefined)
      : undefined;
    if (onPausedPath(params, ctx)) {
      // Paused: the frame may come from the WebCodecs cache rather than
      // the element — stamp whichever the draw planner picks.
      const target = elementTarget(params, video, v, ctx.time);
      return drawPlanStamp(
        planPausedDraw(probeDraw(s ?? null, video, v, target))
      );
    }
    if (s && onCatchupPath(params, ctx)) {
      const target = elementTarget(params, video, v, ctx.time);
      return drawPlanStamp(planPlayingDraw(probePlaying(s, video, v, target)));
    }
    const uploadable = !video.seeking && video.readyState >= 2;
    const t = uploadable ? video.currentTime : (s?.lastUploadedTime ?? -1);
    return `vt:${t.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();

    // ── Image-sequence path ───────────────────────────────────────────
    // Independent of the <video> machinery below: map scene time → frame
    // index (honoring gaps), lazily decode that frame, and draw it through
    // the same fit shader. Returns early so the video path is untouched.
    if ((params.source_kind as string) === "sequence") {
      const gl = ctx.gl;
      const s = ensureSeqState(ctx, nodeId);
      const seq = params.sequence as ImageSequenceParamValue | null | undefined;
      if (!seq || !seq.frames || seq.frames.length === 0) {
        if (s.valueRef) {
          clearSeqCache(gl, s);
          s.valueRef = null;
        }
        // Nothing loaded ⇒ empty frame, not a black plate. See the same
        // clear in image-source.ts for why alpha 0 is the honest value.
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }
      // EXR decode identity: layer + alpha handling. A change invalidates
      // every cached texture (they were packed for the old selection).
      const exrLayer = seq.exr
        ? findExrLayer(seq.exr.layers, params.exr_layer as string)
        : undefined;
      const exrUnpremult = (params.exr_unpremultiply as boolean) ?? true;
      const exrKey = seq.exr ? `${exrLayer?.id ?? ""}|${exrUnpremult}` : "";

      // Fresh pick → drop the old cache and rebuild the gap-filled map.
      if (s.valueRef !== seq || s.exrKey !== exrKey) {
        clearSeqCache(gl, s);
        s.valueRef = seq;
        s.exrKey = exrKey;
        s.resolved = buildResolved(seq);
        s.lastW = seq.width || 0;
        s.lastH = seq.height || 0;
      }

      const length = s.resolved.length;
      const { localFrame, targetIdx } = seqTarget(params, s, ctx.time);

      // Kick an async decode for a frame index; show the last-good frame
      // meanwhile. Offline export settles on the current frame's decode so
      // capture waits for the right pixels. Shared by the playhead frame and
      // the playback decode-ahead below.
      const kickDecode = (idx: number, settle: boolean) => {
        if (s.cache.has(idx) || s.pending.has(idx) || s.decoding.has(idx)) {
          return;
        }
        if (s.pending.size >= SEQ_PENDING_CAP) {
          if (!settle) return; // ahead-decodes yield; the playhead evicts
          const first = s.pending.keys().next().value;
          if (first !== undefined) {
            const decoded = s.pending.get(first);
            if (decoded instanceof ImageBitmap) decoded.close();
            s.pending.delete(first);
          }
        }
        s.decoding.add(idx);
        const decode: Promise<ImageBitmap | ExrDecodeResult> = seq.exr
          ? seq.frames[idx].blob
              .arrayBuffer()
              .then((buf) =>
                decodeExrLayerAsync(buf, {
                  layer: exrLayer,
                  unpremultiply: exrUnpremult,
                })
              )
          : createImageBitmap(seq.frames[idx].blob);
        const p = decode
          .then((decoded) => {
            // A layer switch may have reset the cache mid-flight — drop stale
            // results instead of parking them under the new key.
            if (s.valueRef !== seq || s.exrKey !== exrKey) return;
            s.pending.set(idx, decoded);
            s.decoding.delete(idx);
            // Nudge a re-eval so a paused scrub updates once the decode lands.
            if (typeof window !== "undefined") {
              window.dispatchEvent(new Event("pipeline-bump"));
            }
          })
          .catch((e) => {
            s.decoding.delete(idx);
            if (seq.exr) console.warn("EXR frame decode failed:", e);
          });
        if (settle && ctx.offline) pushMediaSettle(ctx, p);
      };

      // Upload EVERY decoded frame parked since the last eval (the GL
      // context is here), not just the playhead's — decode-ahead relies on
      // pending draining each eval, and a bitmap upload is ~1 ms.
      const uploadPending = (idx: number): WebGLTexture => {
        const decoded = s.pending.get(idx)!;
        s.pending.delete(idx);
        let tex: WebGLTexture;
        if (decoded instanceof ImageBitmap) {
          tex = uploadBitmapTexture(gl, decoded);
          s.lastW = decoded.width;
          s.lastH = decoded.height;
          recordCacheBytes(s, idx, decoded.width * decoded.height * 4);
          decoded.close();
        } else {
          tex = uploadFloatTexture(gl, decoded);
          s.lastW = decoded.width;
          s.lastH = decoded.height;
          recordCacheBytes(s, idx, decoded.width * decoded.height * 8);
        }
        s.cache.set(idx, tex);
        touchLru(s, idx);
        return tex;
      };
      for (const idx of [...s.pending.keys()]) {
        if (idx !== targetIdx) uploadPending(idx);
      }
      let frameTex = s.cache.get(targetIdx) ?? null;
      if (frameTex) {
        touchLru(s, targetIdx);
      } else if (s.pending.has(targetIdx)) {
        frameTex = uploadPending(targetIdx);
      } else {
        kickDecode(targetIdx, true);
      }
      evictSeq(gl, s, targetIdx);

      // Decode-ahead (M7): a window of timeline frames around the playhead,
      // leaning in the drag direction while paused, forward while playing.
      // EXR keeps a small backlog-gated window; the playhead's own decode
      // always wins (kickDecode above runs first).
      if (!ctx.offline) {
        const exr = !!seq.exr;
        if (!exr || exrDecodeBacklog() < 4) {
          const paused = !ctx.playing || ctx.preroll === true;
          const frames = paused
            ? planSeqWindow(
                localFrame,
                s.lastFrame,
                length,
                !!params.loop,
                exr ? SEQ_DECODE_AHEAD : SEQ_AHEAD,
                exr ? 1 : SEQ_BEHIND
              )
            : planSeqWindow(
                localFrame,
                null,
                length,
                !!params.loop,
                exr ? SEQ_DECODE_AHEAD : 8,
                0
              );
          for (const f of frames) {
            if (s.decoding.size >= SEQ_DECODE_CONCURRENCY) break;
            kickDecode(s.resolved[f] ?? 0, false);
          }
        }
      }
      s.lastFrame = localFrame;

      if (frameTex) {
        s.tex = frameTex;
        s.texIdx = targetIdx;
        s.hasUploadedFrame = true;
      }
      if (!s.hasUploadedFrame || !s.tex) {
        // No frame decoded yet — empty, not black (same rule as above).
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }

      // Fit + UV-input + draw (mirrors the video path below).
      const srcW = s.lastW || seq.width || output.width;
      const srcH = s.lastH || seq.height || output.height;
      const imgAspect = srcW / srcH;
      const outAspect = output.width / output.height;
      const aspect = imgAspect / outAspect;
      const fit = (params.fit as string) ?? "cover";
      let invScale: [number, number];
      let letterbox = 0;
      if (fit === "stretch") {
        invScale = [1, 1];
      } else if (fit === "cover") {
        invScale = aspect > 1 ? [1 / aspect, 1] : [1, aspect];
      } else {
        invScale = aspect > 1 ? [1, aspect] : [1 / aspect, 1];
        letterbox = 1;
      }

      const uvInSeq = inputs.uv_in;
      const placeholderKeySeq = `video-source:${nodeId}:zero`;
      let uvInModeSeq = 0;
      let uvInTexSeq: WebGLTexture = getPlaceholderTex(
        ctx.gl,
        ctx.state,
        placeholderKeySeq
      );
      let uvConstSeq: [number, number] = [0, 0];
      if (uvInSeq) {
        if (uvInSeq.kind === "uv") {
          uvInModeSeq = 1;
          uvInTexSeq = (uvInSeq as UvValue).texture;
        } else if (uvInSeq.kind === "scalar") {
          uvInModeSeq = 2;
          uvConstSeq = [uvInSeq.value, uvInSeq.value];
        }
      }

      const progSeq = ctx.getShader("video-source/fit", FS);
      const curTex = s.tex;
      ctx.drawFullscreen(progSeq, output, (gl2) => {
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, curTex);
        gl2.uniform1i(gl2.getUniformLocation(progSeq, "u_src"), 0);
        gl2.uniform2f(
          gl2.getUniformLocation(progSeq, "u_invScale"),
          invScale[0],
          invScale[1]
        );
        gl2.uniform1f(gl2.getUniformLocation(progSeq, "u_letterbox"), letterbox);
        bindTrsUniforms(gl2, progSeq, params);
        gl2.activeTexture(gl2.TEXTURE1);
        gl2.bindTexture(gl2.TEXTURE_2D, uvInTexSeq);
        gl2.uniform1i(gl2.getUniformLocation(progSeq, "u_uvIn"), 1);
        gl2.uniform1i(gl2.getUniformLocation(progSeq, "u_hasUvIn"), uvInModeSeq);
        gl2.uniform2f(
          gl2.getUniformLocation(progSeq, "u_uvConst"),
          uvConstSeq[0],
          uvConstSeq[1]
        );
      });

      return { primary: output };
    }

    const paramFile = params.file as VideoFileParamValue | null | undefined;
    if (!paramFile?.video) {
      // No file loaded ⇒ empty frame, not a black plate.
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const video = paramFile.video;
    const state = ensureState(ctx, nodeId);
    state.videoRef = video;
    video.loop = !!params.loop;

    // Audio: a <video> plays its own audio track. The element is created
    // muted (lib/video.ts) — un-mute it only while this node's `audio`
    // output is routed into the Output node's audio socket
    // (ctx.audioRoutedToOutput, recomputed each eval). When used only for
    // data (amplitude → param) it keeps advancing but stays silent. This
    // mirrors Audio Source. The aux value is emitted on every frame the
    // node renders so downstream analysers see a stable element identity.
    const audible = ctx.audioRoutedToOutput?.has(nodeId) ?? false;
    video.volume = Math.max(0, Math.min(1, (params.volume as number) ?? 1));
    video.muted = !audible;
    if (
      !state.audioLeaf ||
      state.audioLeaf.element !== video ||
      state.audioLeaf.url !== (paramFile.url ?? null) ||
      state.audioLeaf.sync !== !!params.sync_to_scene_time ||
      state.audioLeaf.loop !== !!params.loop ||
      state.audioLeaf.startOffset !== ((params.start_offset as number) ?? 0) ||
      state.audioLeaf.volume !== video.volume
    ) {
      state.audioLeaf = {
        kind: "element",
        nodeId,
        element: video,
        source: "video",
        url: paramFile.url ?? null,
        // Offline playback hints (080926 M-B). Playback `speed` ≠ 1 is a
        // known offline-audio limitation, same as the legacy export path.
        sync: !!params.sync_to_scene_time,
        loop: !!params.loop,
        startOffset: (params.start_offset as number) ?? 0,
        volume: video.volume,
      };
    }
    const audioAux = {
      audio: {
        kind: "audio",
        element: video,
        source: "video",
        chain: state.audioLeaf,
      } satisfies AudioValue,
    };

    // Upload BEFORE the sync logic below. That logic may write currentTime,
    // and a currentTime write drops readyState synchronously — so if the
    // upload ran after it, a frame that landed since the last eval would be
    // discarded every time the playhead had moved on (every eval of a
    // drag): the picture froze until the pointer rested. Uploading first
    // shows each landed frame and then chases the newest target. Offline
    // export's two-pass render (pass 1 seeks + settles, pass 2 draws) is
    // unchanged: pass 2 uploads the settled frame, then sees zero drift.
    // Audit: specdocs/090426_video-scrub-audit.md F1.
    const gl = ctx.gl;
    const ready =
      !video.seeking &&
      video.readyState >= 2 /* HAVE_CURRENT_DATA */ &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    // Paused, the presented frame only changes when a seek lands — skip
    // the re-upload of an unchanged frame (the cache path can otherwise
    // pay a 4K upload on every cursor move).
    if (
      ready &&
      (ctx.playing || !state.hasUploadedFrame || video.currentTime !== state.lastUploadedTime)
    ) {
      gl.bindTexture(gl.TEXTURE_2D, state.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      let uploaded = false;
      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video
        );
        uploaded = true;
      } catch {
        // Some browsers refuse the upload until the first metadata frame
        // is decoded. Keep the previous frame (if any) and try again next
        // eval rather than flashing black.
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (uploaded) {
        state.hasUploadedFrame = true;
        state.lastVideoWidth = video.videoWidth;
        state.lastVideoHeight = video.videoHeight;
        state.lastUploadedTime = video.currentTime;
      }
    }

    const sync = !!params.sync_to_scene_time;
    const speed = (params.speed as number) ?? 1;
    const target = sync ? elementTarget(params, video, paramFile, ctx.time) : 0;

    // Paused-path frame cache: decide what this eval draws BEFORE the sync
    // block can move the element. Must mirror fingerprintExtras exactly.
    let plan: DrawPlan<WebGLTexture> | null = null;
    if (onPausedPath(params, ctx)) {
      syncStore(state, paramFile, ctx.gl, nodeId);
      if (state.lastTarget !== target) {
        state.lastTarget = target;
        state.targetChangedAt = performance.now();
        clearParkTimer(state);
      }
      plan = planPausedDraw(probeDraw(state, video, paramFile, target));
    } else {
      clearParkTimer(state);
      if (onCatchupPath(params, ctx)) {
        syncStore(state, paramFile, ctx.gl, nodeId);
        plan = planPlayingDraw(probePlaying(state, video, paramFile, target));
      }
      // Playback / export took over — stop decoding behind it. (The store
      // is shared; only our own request chain is ours to cancel.)
      if (state.store && state.store.job && state.store.users.size === 1) {
        cancelStoreJob(state.store);
      }
    }

    if (sync) {
      const drift = target - video.currentTime;
      const absDrift = Math.abs(drift);

      // Hard-seek thresholds. The big one catches genuine jumps —
      // timeline scrubs, loop wrap-around, the first eval. Anything
      // smaller is corrected by playbackRate so the decoder stays on
      // the smooth continuous-playback path, which is the only way
      // browsers reliably hit 60fps on video.
      const HARD_SEEK = 0.3;
      // Soft-sync only runs while playing forward; reverse playback
      // can't be served by playbackRate so it falls back to seek.
      const wantsForward = speed > 0;

      if (ctx.offline) {
        // Deterministic offline export — the clock is stepped frame by
        // frame, NOT wall-clock, so the soft-sync playbackRate path
        // (which assumes realtime advance) would drift and snap. Always
        // pause and hard-seek to the exact target, and register a settle
        // promise so the export waits for the decode before capturing —
        // otherwise we'd record the previous frame, and two videos would
        // visibly fall out of sync.
        if (!video.paused) video.pause();
        if (absDrift > 0.005) {
          try {
            video.currentTime = target;
            pushMediaSettle(ctx, videoSeekSettle(video, target));
          } catch {
            // Metadata may be partial — next pass retries.
          }
        }
      } else if (!ctx.playing || ctx.preroll) {
        // Scene is paused — or this node is PRE-ROLLING inside a
        // not-yet-active layer (ctx.preroll: clock pinned to the window's
        // entry tick). Freeze the element so the soft-sync loop can't
        // creep forward and hard-seek back every ~0.3 s; a pre-rolling
        // video parks silently on its entry frame.
        if (!video.paused) video.pause();
        // The frame cache serves this path (`plan`): when the WebCodecs
        // decoder is up, frames come from the cache and the element is
        // only asked to seek when the plan says the cached frame is a
        // proxy (source larger than VIDEO_CACHE_MAX_DIM) or nothing is
        // cached yet and the cache can never be exact. Without a decoder
        // the plan degrades to the old behavior: chase with the element.
        if (plan?.kick && state.store) requestFrames(state.store, target);
        // Park (M3): the drag has rested and the element is elsewhere —
        // one seek positions it under the playhead so play is instant.
        // Arm the timer while the rest period is still running.
        const wantsPark =
          plan !== null &&
          !plan.chase &&
          !plan.park &&
          plan.src !== "none" &&
          Math.abs(state.lastUploadedTime - target) > 0.01;
        if (wantsPark) {
          armParkTimer(state, performance.now() - state.targetChangedAt);
        }
        if (
          (plan ? plan.chase || plan.park : true) &&
          absDrift > 0.01 &&
          !video.seeking
        ) {
          try {
            video.currentTime = target;
          } catch {
            // Retry next eval.
          }
        }
      } else if (absDrift > HARD_SEEK || !wantsForward) {
        if (!video.paused) video.pause();
        // Same coalescing as the paused path: retargeting the in-flight
        // seek every rAF restarts decode forever on long-GOP sources —
        // visible as a long stale-frame hang when playback jumps (loop
        // wrap, entering a layer's clip window) and as no motion at all
        // during reverse playback (which is seek-per-frame by design).
        if (!video.seeking) {
          try {
            video.currentTime = target;
          } catch {
            // Some browsers throw if metadata is partial — next frame retries.
          }
        }
        // Leave playbackRate at the user's nominal speed for when we
        // resume soft-sync next frame.
        video.playbackRate = Math.max(0.0625, Math.abs(speed));
      } else {
        if (video.paused) {
          video.play().catch(() => {
            // Autoplay blocked until user interaction; retry next eval.
          });
        }
        // Aim to close the drift over ~1 second of wall clock. A
        // positive drift means the video is behind, so we speed up;
        // negative means we're ahead and slow down. Clamp so we never
        // pause (0) or run wildly fast.
        const correctedRate = speed * (1 + drift);
        video.playbackRate = Math.max(0.0625, Math.min(8, correctedRate));
      }
    } else {
      // Non-sync (free-running) mode. Track scene play state so pausing
      // the scene also pauses the video — otherwise a paused scene
      // would still have the video element running underneath, which
      // would surprise downstream nodes that key off video.currentTime.
      video.playbackRate = Math.max(0.0625, Math.abs(speed));
      if (!ctx.playing) {
        if (!video.paused) video.pause();
      } else if (video.paused) {
        video.play().catch(() => {
          // Autoplay can be blocked until user interaction; we'll retry
          // next frame. Not fatal.
        });
      }
    }

    // If we've never managed to upload, there's no last-good frame to
    // show — clear to EMPTY (not black; a black plate is real content that
    // mattes downstream) and bail. Audio still flows (it may be loaded
    // before the first frame decodes).
    // What goes on screen: a cached frame when the paused-path plan picked
    // one, else the element texture. Fit math uses the drawn frame's own
    // dimensions (the element's last successful upload, or the cache
    // entry's stored size — same aspect either way).
    let drawTex = state.tex;
    let srcW = state.lastVideoWidth;
    let srcH = state.lastVideoHeight;
    if (plan?.src === "cache" && plan.entry && state.store) {
      drawTex = plan.entry.payload;
      srcW = plan.entry.w;
      srcH = plan.entry.h;
      state.store.drawnTs = plan.entry.ts;
      state.store.cache.touch(plan.entry.ts);
    } else if (plan?.src === "none" || !state.hasUploadedFrame) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output, aux: audioAux };
    }
    const imgAspect = srcW / srcH;
    const outAspect = output.width / output.height;
    const alpha = imgAspect / outAspect;
    const fit = (params.fit as string) ?? "cover";
    let invScale: [number, number];
    let letterbox = 0;
    if (fit === "stretch") {
      invScale = [1, 1];
    } else if (fit === "cover") {
      invScale = alpha > 1 ? [1 / alpha, 1] : [1, alpha];
    } else {
      invScale = alpha > 1 ? [1, alpha] : [1 / alpha, 1];
      letterbox = 1;
    }

    // UV input handling (parallel to Image Source).
    const uvIn = inputs.uv_in;
    const placeholderKey = `video-source:${nodeId}:zero`;
    let uvInMode = 0;
    let uvInTex: WebGLTexture = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      placeholderKey
    );
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = (uvIn as UvValue).texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    const prog = ctx.getShader("video-source/fit", FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, drawTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_invScale"),
        invScale[0],
        invScale[1]
      );
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_letterbox"), letterbox);
      bindTrsUniforms(gl2, prog, params);

      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, uvInTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_uvIn"), 1);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );
    });

    return { primary: output, aux: audioAux };
  },

  dispose(ctx, nodeId) {
    const key = `video-source:${nodeId}`;
    const state = ctx.state[key] as VideoState | undefined;
    if (state) {
      clearParkTimer(state);
      if (state.storeFor) releaseFrameStore(state.storeFor, nodeId);
      state.store = null;
      state.storeFor = null;
      if (state.tex) ctx.gl.deleteTexture(state.tex);
    }
    delete ctx.state[key];
    disposePlaceholderTex(ctx.gl, ctx.state, `video-source:${nodeId}:zero`);
    // Image-sequence cache (textures + any in-flight decoded bitmaps).
    const seqKey = `video-seq:${nodeId}`;
    const seqState = ctx.state[seqKey] as SequenceState | undefined;
    if (seqState) {
      clearSeqCache(ctx.gl, seqState);
      delete ctx.state[seqKey];
    }
  },
};
