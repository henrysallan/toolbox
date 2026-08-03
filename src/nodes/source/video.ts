import { OPACITY_PARAM } from "@/engine/conventions";
import type {
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

// Video source. Each frame: optionally sync the <video> element's clock to
// ctx.time, upload whatever's currently decoded to a GL texture, then draw
// it through the same fit math as Image Source. Texture alpha is left at
// whatever the video decoded (usually opaque); flip-Y on sample because
// <video> sits in DOM y-down but the pipeline expects y-up.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
uniform vec2 u_offset; // placement pan, screen convention (Y down)
uniform float u_zoom;  // placement zoom about the canvas center
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  // Placement pan/zoom before the aspect fit — see image-source.ts FIT_FS.
  uv = 0.5 + (uv - vec2(u_offset.x, -u_offset.y) - 0.5) / u_zoom;
  vec2 s = 0.5 + (uv - 0.5) * u_invScale;
  if (u_letterbox > 0.5 && (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = texture(u_src, vec2(s.x, 1.0 - s.y));
}`;

interface VideoState {
  videoRef: HTMLVideoElement | null;
  tex: WebGLTexture | null;
  // True once we've successfully uploaded at least one decoded frame.
  // Lets us render the last good frame while a seek is in flight —
  // setting currentTime is async, so readyState drops to 1 until the
  // new frame decodes. Without this, sync_to_scene_time mode flickers
  // black every frame because every tick triggers a fresh seek.
  hasUploadedFrame: boolean;
  lastVideoWidth: number;
  lastVideoHeight: number;
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
    videoRef: null, tex,
    hasUploadedFrame: false,
    lastVideoWidth: 0, lastVideoHeight: 0,
  };
  ctx.state[key] = s;
  return s;
}

// ── Image-sequence playback state ──────────────────────────────────────
// Parallel to VideoState but for the sequence source kind. Frames are kept
// as encoded Blobs in the param value; here we lazily decode the currently-
// needed frame to a GL texture and keep a small LRU of recent ones so
// scrubbing back is instant. Offline export registers a settle promise on
// the in-flight decode so capture waits for the right frame.
interface SequenceState {
  tex: WebGLTexture | null; // last-good texture currently being shown
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
const SEQ_PENDING_CAP = 8;
const SEQ_CACHE_BYTES = 512 * 1024 * 1024;
// Frames to decode ahead of the playhead during playback (EXR only — decode
// is seconds-per-frame at 4K, so playback survives on cache + held frames).
const SEQ_DECODE_AHEAD = 3;

function ensureSeqState(ctx: RenderContext, nodeId: string): SequenceState {
  const key = `video-seq:${nodeId}`;
  const existing = ctx.state[key] as SequenceState | undefined;
  if (existing) return existing;
  const s: SequenceState = {
    tex: null,
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
  backend: "webgl2",
  // Always re-evaluate — video frames change over time regardless of params.
  stable: false,
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
    // Placement within the canvas — sampling-time pan/zoom, Transform-node
    // conventions (+Y down). Same trio as Image Source / Webcam.
    {
      name: "offsetX",
      label: "Offset X",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "offsetY",
      label: "Offset Y",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "zoom",
      label: "Zoom",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
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

  // Mix the video element's currentTime into the fingerprint. Scene-time
  // already busts downstream caches for sync'd playback, but free-running
  // playback (sync off) advances the video clock independently — this
  // ensures downstream nodes see a fresh output whenever a new frame lands.
  fingerprintExtras(params) {
    const v = params.file as VideoFileParamValue | null | undefined;
    if (!v?.video) return "";
    return `vt:${v.video.currentTime.toFixed(4)}`;
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

      const speed = (params.speed as number) ?? 1;
      const startOffset = (params.start_offset as number) ?? 0;
      const seqFps = Math.max(1, (params.seq_fps as number) ?? 24);
      const length = s.resolved.length;

      let localFrame = Math.floor((ctx.time * speed + startOffset) * seqFps);
      if (params.loop) {
        localFrame = ((localFrame % length) + length) % length;
      } else {
        localFrame = Math.max(0, Math.min(length - 1, localFrame));
      }
      const targetIdx = s.resolved[localFrame] ?? 0;

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

      let frameTex = s.cache.get(targetIdx) ?? null;
      if (frameTex) {
        touchLru(s, targetIdx);
      } else if (s.pending.has(targetIdx)) {
        // Decoded last eval — upload to GL now (the GL context is here).
        const decoded = s.pending.get(targetIdx)!;
        s.pending.delete(targetIdx);
        if (decoded instanceof ImageBitmap) {
          frameTex = uploadBitmapTexture(gl, decoded);
          s.lastW = decoded.width;
          s.lastH = decoded.height;
          recordCacheBytes(s, targetIdx, decoded.width * decoded.height * 4);
          decoded.close();
        } else {
          frameTex = uploadFloatTexture(gl, decoded);
          s.lastW = decoded.width;
          s.lastH = decoded.height;
          recordCacheBytes(s, targetIdx, decoded.width * decoded.height * 8);
        }
        s.cache.set(targetIdx, frameTex);
        touchLru(s, targetIdx);
        evictSeq(gl, s, targetIdx);
      } else {
        kickDecode(targetIdx, true);
      }

      // Decode-ahead: EXR decode costs seconds per 4K frame, so while
      // playing, keep the worker pool primed with the next few frames.
      // Modest and backlog-aware — the playhead's own decode always wins.
      if (seq.exr && ctx.playing && !ctx.offline && exrDecodeBacklog() < 4) {
        for (let ahead = 1; ahead <= SEQ_DECODE_AHEAD; ahead++) {
          let f = localFrame + ahead;
          if (params.loop) f = ((f % length) + length) % length;
          else if (f >= length) break;
          kickDecode(s.resolved[f] ?? 0, false);
        }
      }

      if (frameTex) {
        s.tex = frameTex;
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

      const offsetXSeq = (params.offsetX as number) ?? 0;
      const offsetYSeq = (params.offsetY as number) ?? 0;
      const zoomSeq = Math.max(0.0001, (params.zoom as number) ?? 1);

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
        gl2.uniform2f(
          gl2.getUniformLocation(progSeq, "u_offset"),
          offsetXSeq,
          offsetYSeq
        );
        gl2.uniform1f(gl2.getUniformLocation(progSeq, "u_zoom"), zoomSeq);
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
    const audioAux = {
      audio: {
        kind: "audio",
        element: video,
        source: "video",
      } satisfies AudioValue,
    };

    const sync = !!params.sync_to_scene_time;
    const speed = (params.speed as number) ?? 1;
    const startOffset = (params.start_offset as number) ?? 0;

    if (sync) {
      const dur = Math.max(0.0001, video.duration || paramFile.duration || 1);
      let target = ctx.time * speed + startOffset;
      if (params.loop) {
        target = ((target % dur) + dur) % dur;
      } else {
        target = Math.max(0, Math.min(dur - 0.0001, target));
      }
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
        // entry tick) — freeze the video at exactly `target` so the
        // soft-sync loop doesn't creep forward and hard-seek back every
        // ~0.3s. A pre-rolling video thereby parks silently on its entry
        // frame, so the cut needs no seek at all.
        if (!video.paused) video.pause();
        // Coalesced seeking is what makes scrubbing usable: while a seek
        // is in flight, do NOT retarget it — every currentTime write
        // cancels the in-flight seek and restarts decode from the
        // previous keyframe, so a moving playhead would never land a
        // single frame (the picture freezes until the drag stops).
        // Letting each seek finish shows real intermediate frames at
        // whatever rate the decoder manages, and the `seeked` bump wired
        // in lib/video.ts guarantees a re-eval that chains the next seek
        // to the freshest playhead time.
        if (absDrift > 0.01 && !video.seeking) {
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

    const gl = ctx.gl;
    const ready =
      video.readyState >= 2 /* HAVE_CURRENT_DATA */ &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;

    // Try to upload a fresh frame if the video is in a uploadable state.
    // If it isn't (mid-seek, no decoded data yet), fall through to render
    // with whatever we last uploaded — that's much better than flashing
    // black every other frame.
    if (ready) {
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
      }
    }

    // If we've never managed to upload, there's no last-good frame to
    // show — clear to EMPTY (not black; a black plate is real content that
    // mattes downstream) and bail. Audio still flows (it may be loaded
    // before the first frame decodes).
    if (!state.hasUploadedFrame) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output, aux: audioAux };
    }

    // Fit math uses the dimensions of the LAST successful upload. They
    // only change when the user loads a different file, in which case
    // the next successful upload will rewrite both atomically.
    const srcW = state.lastVideoWidth;
    const srcH = state.lastVideoHeight;
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

    const offsetX = (params.offsetX as number) ?? 0;
    const offsetY = (params.offsetY as number) ?? 0;
    const zoom = Math.max(0.0001, (params.zoom as number) ?? 1);

    const prog = ctx.getShader("video-source/fit", FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.tex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_invScale"),
        invScale[0],
        invScale[1]
      );
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_letterbox"), letterbox);
      gl2.uniform2f(gl2.getUniformLocation(prog, "u_offset"), offsetX, offsetY);
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_zoom"), zoom);

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
    if (state?.tex) ctx.gl.deleteTexture(state.tex);
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
