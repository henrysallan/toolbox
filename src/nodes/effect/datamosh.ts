import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { pushMediaSettle } from "@/engine/offline-settle";
import {
  getDecoded,
  hasDecoded,
  peekDatamosh,
  prefetchDecodes,
  recordScopedFrame,
  requestDecode,
  type StripName,
} from "@/engine/datamosh-session";

// Datamosh — flow-based clip-overlap glitch.
//
// THE IDEA. Datamosh is "motion from one clip applied to the pixels of another
// (or a frozen frame)." This node bakes its two inputs into owned frame strips,
// lets the panel slide them on a node-local timeline so they overlap, and in
// the overlap runs an optical-flow advection: the incoming clip's per-frame
// motion field warps an accumulation buffer that starts as the outgoing clip's
// frozen frame — the classic "one scene melts into the motion of another."
//
// WHY BAKE. An `image` socket only ever hands compute the CURRENT frame, so a
// node-local drag-overlap timeline is impossible on live inputs, and optical
// flow needs adjacent frames. So the panel frame-steps each input's upstream
// into a PNG strip (engine/datamosh-session, the depth-session pattern). Once
// the clips are owned data the mosh is a deterministic function of (strips,
// params, frame).
//
// THREE COMPUTE MODES (see compute()):
//   1. output baked  → sample the moshed output strip at the scoped frame
//                      (fast, scrub- and export-accurate; the deliverable).
//   2. inputs baked  → run the flow advection LIVE (forward-accumulating in
//                      ctx.state). Correct playing forward; a paused scrub
//                      reseeds and replays as decodes land. This is the preview,
//                      and it's also what the "Mosh" build records frame-by-frame.
//   3. nothing baked → pass the live imageA input through so wiring is visible.
//
// The codec (true bitstream) engine is M2 — `engine: "codec"` is accepted and
// serialized but currently renders identically to flow (the panel disables it).

// ─── Shaders ─────────────────────────────────────────────────────────────────

// Plain passthrough of an engine-native (Y-up) texture — used for acc → output.
const PASS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main(){ outColor = texture(u_src, v_uv); }`;

// Passthrough of an uploaded strip bitmap. Decoded PNGs are row-0-top (uploaded
// with FLIP_Y false), so sample flipped to land upright in engine space.
const PASS_FLIP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main(){ outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y)); }`;

// One mosh step. Estimate the incoming clip's motion (bprev→bcur), backward-warp
// the accumulation buffer along it (a decaying multi-tap smear), then mix in a
// little of the real incoming pixels (refresh). acc is engine-native; the strip
// samplers are flipped.
const MOSH_STEP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_acc;     // engine-native (Y-up)
uniform sampler2D u_bprev;   // strip (flipped)
uniform sampler2D u_bcur;    // strip (flipped)
uniform vec2  u_texel;       // 1.0 / size, for the gradient
uniform float u_scale;       // flow scale (max displacement, normalized)
uniform int   u_taps;        // smear length
uniform float u_decay;       // per-tap falloff
uniform float u_refresh;     // 0 = pure melt, 1 = snap to incoming
uniform int   u_estimator;   // 0 = gradient, 1 = residual, 2 = block-match
uniform int   u_search;      // block-match search radius in texels (1..8)
out vec4 outColor;

vec2 flip(vec2 uv){ return vec2(uv.x, 1.0 - uv.y); }
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float lprev(vec2 uv){ return luma(texture(u_bprev, flip(uv)).rgb); }
float lcur(vec2 uv){ return luma(texture(u_bcur, flip(uv)).rgb); }

void main(){
  vec2 uv = v_uv;
  // Spatial gradient of the current frame (central difference).
  float lx = lcur(uv + vec2(u_texel.x, 0.0)) - lcur(uv - vec2(u_texel.x, 0.0));
  float ly = lcur(uv + vec2(0.0, u_texel.y)) - lcur(uv - vec2(0.0, u_texel.y));
  vec2 grad = vec2(lx, ly);
  float It = lcur(uv) - lprev(uv);              // temporal difference

  vec2 flow;
  if (u_estimator == 0) {
    // Brightness-constancy normal flow: motion in the gradient direction.
    float g2 = dot(grad, grad) + 1e-4;
    flow = -It * grad / g2;
  } else if (u_estimator == 1) {
    // Residual: push along the gradient by the raw difference (glitchier).
    flow = normalize(grad + vec2(1e-5)) * It;
  } else {
    // Block-match: search the previous frame for the patch around uv (3x3 SAD,
    // stepped). The codec-authentic blocky motion. Heavy — prefer Mosh-baking.
    vec2 best = vec2(0.0);
    float bestErr = 1e9;
    for (int dy = -8; dy <= 8; dy += 2) {
      if (dy < -u_search || dy > u_search) continue;
      for (int dx = -8; dx <= 8; dx += 2) {
        if (dx < -u_search || dx > u_search) continue;
        vec2 d = vec2(float(dx), float(dy)) * u_texel;
        float err = 0.0;
        for (int oy = -1; oy <= 1; oy++) {
          for (int ox = -1; ox <= 1; ox++) {
            vec2 o = vec2(float(ox), float(oy)) * u_texel;
            err += abs(lcur(uv + o) - lprev(uv + d + o));
          }
        }
        if (err < bestErr) { bestErr = err; best = d; }
      }
    }
    flow = -best;
  }

  // Backward-warp the accumulation along the motion, multi-tap for a smear.
  vec2 step = -flow * u_scale;
  vec4 sum = texture(u_acc, uv);
  float w = 1.0;
  float wsum = 1.0;
  for (int i = 1; i <= 64; i++) {
    if (i > u_taps) break;
    w *= u_decay;
    vec2 p = clamp(uv + step * (float(i) / float(u_taps)), 0.0, 1.0);
    sum += texture(u_acc, p) * w;
    wsum += w;
  }
  vec4 warped = sum / wsum;
  vec4 bcur = texture(u_bcur, flip(uv));
  outColor = mix(warped, bcur, clamp(u_refresh, 0.0, 1.0));
}`;

// ─── Timeline math (shared by compute + fingerprint) ────────────────────────

interface Timeline {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  aCount: number;
  bCount: number;
  sourceInA: number;
  sourceInB: number;
  length: number; // total node-local frames
  overlapStart: number;
  overlapEnd: number; // exclusive
}

function readTimeline(
  params: Record<string, unknown>,
  aCount: number,
  bCount: number
): Timeline {
  const aStart = Math.max(0, Math.round((params.aStart as number) ?? 0));
  const bStart = Math.max(0, Math.round((params.bStart as number) ?? 0));
  const sourceInA = Math.max(0, Math.round((params.sourceInA as number) ?? 0));
  const sourceInB = Math.max(0, Math.round((params.sourceInB as number) ?? 0));
  // Length defaults to (and is capped at) the available baked frames after the
  // source-in trim.
  const aAvail = Math.max(0, aCount - sourceInA);
  const bAvail = Math.max(0, bCount - sourceInB);
  const aLenRaw = Math.round((params.aLen as number) ?? aAvail);
  const bLenRaw = Math.round((params.bLen as number) ?? bAvail);
  const aLen = Math.max(0, Math.min(aAvail, aLenRaw || aAvail));
  const bLen = Math.max(0, Math.min(bAvail, bLenRaw || bAvail));
  const aEnd = aStart + aLen;
  const bEnd = bStart + bLen;
  return {
    aStart,
    aLen,
    bStart,
    bLen,
    aCount,
    bCount,
    sourceInA,
    sourceInB,
    length: Math.max(aEnd, bEnd, 1),
    overlapStart: Math.max(aStart, bStart),
    overlapEnd: Math.min(aEnd, bEnd),
  };
}

// Resolve a node-local frame to the underlying strip index (with source-in trim,
// clamped to the baked range).
function aFrame(t: Timeline, f: number): number {
  return Math.max(0, Math.min(t.aCount - 1, f - t.aStart + t.sourceInA));
}
function bFrame(t: Timeline, f: number): number {
  return Math.max(0, Math.min(t.bCount - 1, f - t.bStart + t.sourceInB));
}

type Region =
  | { kind: "a"; idx: number }
  | { kind: "b"; idx: number }
  | { kind: "mosh"; f: number }
  | { kind: "empty" };

// Resolve what node-local frame f shows. Before the overlap the leading clip
// plays; inside it we mosh; after it the trailing clip's real pixels resume.
function regionAt(t: Timeline, f: number): Region {
  const aActive = f >= t.aStart && f < t.aStart + t.aLen;
  const bActive = f >= t.bStart && f < t.bStart + t.bLen;
  const inOverlap =
    t.overlapStart < t.overlapEnd && f >= t.overlapStart && f < t.overlapEnd;
  if (inOverlap) return { kind: "mosh", f };
  if (f < t.overlapStart) {
    if (aActive) return { kind: "a", idx: aFrame(t, f) };
    if (bActive) return { kind: "b", idx: bFrame(t, f) };
  } else {
    if (bActive) return { kind: "b", idx: bFrame(t, f) };
    if (aActive) return { kind: "a", idx: aFrame(t, f) };
  }
  return { kind: "empty" };
}

// ─── Per-node GL state ───────────────────────────────────────────────────────

interface StripTex {
  tex: WebGLTexture;
  ref: ImageBitmap;
  w: number;
  h: number;
}

interface DatamoshState {
  acc: ImageValue;
  scratch: ImageValue;
  width: number;
  height: number;
  // The node-local frame the accumulation currently represents (-1 = none).
  builtFrame: number;
  // Invalidation signature: when the timeline/flow params or the baked strips
  // change, the accumulation is stale and must reseed.
  sig: string;
  // Uploaded strip-bitmap textures, keyed `${strip}:${idx}`, LRU-evicted.
  texCache: Map<string, StripTex>;
  // Single-slot upload for the baked output strip (playback mode).
  outTex: { tex: WebGLTexture | null; ref: ImageBitmap | null };
}

const TEX_CACHE_MAX = 8;

function stateKey(nodeId: string): string {
  return `datamosh:${nodeId}`;
}

function uploadBitmap(
  gl: WebGL2RenderingContext,
  bitmap: ImageBitmap,
  reuse: WebGLTexture | null
): WebGLTexture | null {
  const tex = reuse ?? gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  sig: string
): DatamoshState {
  const key = stateKey(nodeId);
  let s = ctx.state[key] as DatamoshState | undefined;
  const W = ctx.width;
  const H = ctx.height;
  if (s && s.width === W && s.height === H) {
    if (s.sig !== sig) {
      s.sig = sig;
      s.builtFrame = -1; // params/strips changed → accumulation is stale
    }
    return s;
  }
  if (s) {
    ctx.releaseTexture(s.acc.texture);
    ctx.releaseTexture(s.scratch.texture);
    for (const e of s.texCache.values()) ctx.gl.deleteTexture(e.tex);
    if (s.outTex.tex) ctx.gl.deleteTexture(s.outTex.tex);
  }
  const acc = ctx.allocImage({ width: W, height: H });
  const scratch = ctx.allocImage({ width: W, height: H });
  ctx.clearTarget(acc, [0, 0, 0, 0]);
  ctx.clearTarget(scratch, [0, 0, 0, 0]);
  s = {
    acc,
    scratch,
    width: W,
    height: H,
    builtFrame: -1,
    sig,
    texCache: new Map(),
    outTex: { tex: null, ref: null },
  };
  ctx.state[key] = s;
  return s;
}

// Resolve a decoded strip frame to a GL texture, uploading + caching on demand.
// Returns null when the frame isn't decoded yet (and kicks the decode, settling
// it offline so the build/export is frame-accurate).
function getStripTex(
  ctx: RenderContext,
  st: DatamoshState,
  nodeId: string,
  strip: StripName,
  idx: number
): StripTex | null {
  const bmp = getDecoded(nodeId, strip, idx);
  if (!bmp) {
    const settle = requestDecode(nodeId, strip, idx);
    if (ctx.offline) pushMediaSettle(ctx, settle);
    return null;
  }
  prefetchDecodes(nodeId, strip, idx);
  const cacheKey = `${strip}:${idx}`;
  const cached = st.texCache.get(cacheKey);
  if (cached && cached.ref === bmp) {
    st.texCache.delete(cacheKey);
    st.texCache.set(cacheKey, cached);
    return cached;
  }
  const tex = uploadBitmap(ctx.gl, bmp, cached?.tex ?? null);
  if (!tex) return null;
  const entry: StripTex = { tex, ref: bmp, w: bmp.width, h: bmp.height };
  st.texCache.set(cacheKey, entry);
  while (st.texCache.size > TEX_CACHE_MAX) {
    const oldestKey = st.texCache.keys().next().value as string;
    const old = st.texCache.get(oldestKey);
    if (old && old !== entry) ctx.gl.deleteTexture(old.tex);
    st.texCache.delete(oldestKey);
  }
  return entry;
}

function blitFlip(ctx: RenderContext, srcTex: WebGLTexture, target: ImageValue) {
  const prog = ctx.getShader("datamosh/passflip", PASS_FLIP_FS);
  ctx.drawFullscreen(prog, target, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
}

function blitPlain(ctx: RenderContext, srcTex: WebGLTexture, target: ImageValue) {
  const prog = ctx.getShader("datamosh/pass", PASS_FS);
  ctx.drawFullscreen(prog, target, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
}

interface FlowParams {
  estimator: number;
  scale: number;
  taps: number;
  decay: number;
  refresh: number;
  search: number;
}

function moshStep(
  ctx: RenderContext,
  st: DatamoshState,
  bprev: StripTex,
  bcur: StripTex,
  fp: FlowParams
) {
  const prog = ctx.getShader("datamosh/step", MOSH_STEP_FS);
  ctx.drawFullscreen(prog, st.scratch, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.acc.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_acc"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bprev.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_bprev"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bcur.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_bcur"), 2);
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_texel"),
      1 / Math.max(1, st.width),
      1 / Math.max(1, st.height)
    );
    gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), fp.scale);
    gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), fp.taps);
    gl.uniform1f(gl.getUniformLocation(prog, "u_decay"), fp.decay);
    gl.uniform1f(gl.getUniformLocation(prog, "u_refresh"), fp.refresh);
    gl.uniform1i(gl.getUniformLocation(prog, "u_estimator"), fp.estimator);
    gl.uniform1i(gl.getUniformLocation(prog, "u_search"), fp.search);
  });
  // Swap: scratch now holds the advanced accumulation.
  const tmp = st.acc;
  st.acc = st.scratch;
  st.scratch = tmp;
}

// ─── Node ────────────────────────────────────────────────────────────────────

function estimatorToInt(s: string): number {
  return s === "residual" ? 1 : s === "block" ? 2 : 0;
}

export const datamoshNode: NodeDefinition = {
  type: "datamosh",
  name: "Datamosh",
  category: "image",
  subcategory: "modifier",
  description:
    "Glitch-melt two clips into each other. Wire two image inputs, then in the panel Bake each clip into the node, drag the two clips on the mini-timeline so they overlap, and the overlap is moshed: the incoming clip's motion warps a frozen frame of the outgoing clip (optical-flow advection). Flow Scale sets the smear distance, Smear its length, Decay its falloff, Refresh how fast the real incoming pixels bleed back. Preview plays forward live; Mosh bakes the result for clean scrubbing and export. (Inputs are session-only — reopen → re-bake.)",
  backend: "webgl2",
  // Cached per-frame via fingerprintExtras (not stable:false) so a static graph
  // holds a constant and a moshed range re-fingerprints only per frame.
  simulation: true,
  inputs: [
    { name: "imageA", label: "clip A", type: "image", required: false },
    { name: "imageB", label: "clip B", type: "image", required: false },
  ],
  params: [
    {
      name: "engine",
      label: "Engine",
      type: "enum",
      options: ["flow", "codec"],
      default: "flow",
    },
    {
      name: "estimator",
      label: "Algorithm",
      type: "enum",
      options: ["gradient", "residual", "block"],
      default: "gradient",
    },
    {
      name: "searchRadius",
      label: "Search",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 4,
      visibleIf: (p) => p.estimator === "block",
    },
    {
      name: "flowScale",
      label: "Flow Scale",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.08,
    },
    {
      name: "smear",
      label: "Smear",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 24,
      step: 1,
      default: 8,
    },
    {
      name: "decay",
      label: "Decay",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.85,
    },
    {
      name: "refresh",
      label: "Refresh",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.05,
    },
    // Codec engine (M2) — true bitstream datamosh.
    {
      name: "iframeRemoval",
      label: "Remove I-frames",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.engine === "codec",
    },
    {
      name: "pframeDup",
      label: "P-frame Dup",
      type: "scalar",
      min: 0,
      max: 8,
      step: 1,
      default: 0,
      visibleIf: (p) => p.engine === "codec",
    },
    // Node-local timeline placement (frames). Edited by the custom panel.
    { name: "aStart", label: "A Start", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "aLen", label: "A Length", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "bStart", label: "B Start", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "bLen", label: "B Length", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "sourceInA", label: "A Source In", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "sourceInB", label: "B Source In", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    // Per-clip bake ranges (global frames). Edited by the custom panel.
    { name: "bakeInA", label: "Bake In A", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "bakeOutA", label: "Bake Out A", type: "scalar", min: 0, step: 1, default: 60, hidden: true },
    { name: "bakeInB", label: "Bake In B", type: "scalar", min: 0, step: 1, default: 0, hidden: true },
    { name: "bakeOutB", label: "Bake Out B", type: "scalar", min: 0, step: 1, default: 60, hidden: true },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  // Per-frame cache key. Baked → output frame + decode readiness. Live overlap
  // → frame + readiness of the step's source frames (so a post-decode re-render
  // actually re-runs and advances the accumulation, like depth's settle dance).
  fingerprintExtras(params, ctx, nodeId) {
    if (!nodeId) return "";
    const peek = peekDatamosh(nodeId);
    if (peek.outComplete && peek.outRange) {
      const f = Math.min(
        peek.outRange.outFrame,
        Math.max(peek.outRange.inFrame, ctx.frame)
      );
      return `v${peek.version}:out:f${f}:${hasDecoded(nodeId, "out", f) ? 1 : 0}`;
    }
    if (!peek.aCount || !peek.bCount) return `v${peek.version}:none`;
    const t = readTimeline(params, peek.aCount, peek.bCount);
    const f = Math.min(t.length - 1, Math.max(0, ctx.frame));
    const r = regionAt(t, f);
    if (r.kind === "a")
      return `v${peek.version}:a${r.idx}:${hasDecoded(nodeId, "A", r.idx) ? 1 : 0}`;
    if (r.kind === "b")
      return `v${peek.version}:b${r.idx}:${hasDecoded(nodeId, "B", r.idx) ? 1 : 0}`;
    if (r.kind === "mosh") {
      const seedIdx = aFrame(t, t.overlapStart);
      const bcur = bFrame(t, r.f);
      const bprev = bFrame(t, r.f - 1);
      const ready =
        hasDecoded(nodeId, "A", seedIdx) &&
        hasDecoded(nodeId, "B", bcur) &&
        hasDecoded(nodeId, "B", bprev);
      return `v${peek.version}:m${r.f}:${ready ? 1 : 0}`;
    }
    return `v${peek.version}:empty`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    recordScopedFrame(nodeId, ctx.frame);
    const output = ctx.allocImage();
    const peek = peekDatamosh(nodeId);

    const fp: FlowParams = {
      estimator: estimatorToInt((params.estimator as string) ?? "gradient"),
      scale: Math.max(0, (params.flowScale as number) ?? 0.08),
      taps: Math.max(1, Math.min(64, Math.round((params.smear as number) ?? 8))),
      decay: Math.max(0, Math.min(1, (params.decay as number) ?? 0.85)),
      refresh: Math.max(0, Math.min(1, (params.refresh as number) ?? 0.05)),
      search: Math.max(1, Math.min(8, Math.round((params.searchRadius as number) ?? 4))),
    };
    const sig = `${params.engine}|${fp.estimator}|${fp.scale}|${fp.taps}|${fp.decay}|${fp.refresh}|${fp.search}|${params.aStart}|${params.aLen}|${params.bStart}|${params.bLen}|${params.sourceInA}|${params.sourceInB}|v${peek.version}`;

    // ── Mode 1: baked output ──────────────────────────────────────────────
    if (peek.outComplete && peek.outRange) {
      const st = ensureState(ctx, nodeId, sig);
      const f = Math.min(
        peek.outRange.outFrame,
        Math.max(peek.outRange.inFrame, ctx.frame)
      );
      const bmp = getDecoded(nodeId, "out", f);
      if (bmp) {
        prefetchDecodes(nodeId, "out", f);
        if (st.outTex.ref !== bmp) {
          st.outTex.tex = uploadBitmap(ctx.gl, bmp, st.outTex.tex);
          st.outTex.ref = bmp;
        }
        if (st.outTex.tex) blitFlip(ctx, st.outTex.tex, output);
        else ctx.clearTarget(output, [0, 0, 0, 0]);
      } else {
        const settle = requestDecode(nodeId, "out", f);
        if (ctx.offline) pushMediaSettle(ctx, settle);
        // Hold the last decoded output frame until this one lands.
        if (st.outTex.tex) blitFlip(ctx, st.outTex.tex, output);
        else ctx.clearTarget(output, [0, 0, 0, 0]);
      }
      return { primary: output };
    }

    // ── Mode 3: nothing baked → pass live imageA through ───────────────────
    if (!peek.aCount || !peek.bCount) {
      const src = inputs.imageA;
      if (src && src.kind === "image") blitPlain(ctx, src.texture, output);
      else ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    // ── Mode 2: inputs baked → live flow advection ─────────────────────────
    const st = ensureState(ctx, nodeId, sig);
    const t = readTimeline(params, peek.aCount, peek.bCount);
    const f = Math.min(t.length - 1, Math.max(0, ctx.frame));
    const region = regionAt(t, f);

    if (region.kind === "empty") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    if (region.kind === "a" || region.kind === "b") {
      const strip: StripName = region.kind === "a" ? "A" : "B";
      const tex = getStripTex(ctx, st, nodeId, strip, region.idx);
      if (tex) blitFlip(ctx, tex.tex, output);
      else ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    // Overlap → mosh. Seed the accumulation with clip A frozen at overlap start.
    const seedIdx = aFrame(t, t.overlapStart);
    const needReseed = st.builtFrame < t.overlapStart || st.builtFrame > f;
    if (needReseed) {
      const seed = getStripTex(ctx, st, nodeId, "A", seedIdx);
      if (!seed) {
        // Seed not decoded yet — hold whatever the accumulation has.
        blitPlain(ctx, st.acc.texture, output);
        return { primary: output };
      }
      blitFlip(ctx, seed.tex, st.acc);
      st.builtFrame = t.overlapStart;
    }

    // Advance the accumulation forward to f, one motion step per frame. Bails if
    // a step's source frames aren't decoded; the readiness flip in
    // fingerprintExtras re-runs us once they land (and offline we settle).
    while (st.builtFrame < f) {
      const k = st.builtFrame + 1;
      const bcurIdx = bFrame(t, k);
      const bprevIdx = bFrame(t, k - 1);
      const bcur = getStripTex(ctx, st, nodeId, "B", bcurIdx);
      const bprev = getStripTex(ctx, st, nodeId, "B", bprevIdx);
      if (!bcur || !bprev) break;
      moshStep(ctx, st, bprev, bcur, fp);
      st.builtFrame = k;
    }

    blitPlain(ctx, st.acc.texture, output);
    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as DatamoshState | undefined;
    if (s) {
      ctx.releaseTexture(s.acc.texture);
      ctx.releaseTexture(s.scratch.texture);
      for (const e of s.texCache.values()) ctx.gl.deleteTexture(e.tex);
      if (s.outTex.tex) ctx.gl.deleteTexture(s.outTex.tex);
      delete ctx.state[key];
    }
  },
};
