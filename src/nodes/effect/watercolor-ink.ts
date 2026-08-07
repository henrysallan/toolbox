import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { OPACITY_PARAM, colorValueToHex } from "@/engine/conventions";

// Watercolor Ink node. Cellular-automaton ink/water/paper simulation after
// Zhang, Sato, Takahashi, Muraoka & Chiba, "Simple Cellular Automaton-based
// Simulation of Ink Behaviour..." (J. Vis. Comput. Animat. 10, 1999).
// Spec: specdocs/watercolorshaderspec.md. Self-iterating like Reaction
// Diffusion: ping-pong state textures stepped `substeps_per_frame` times
// per eval while the timeline plays (or a wired `time` scalar advances).
//
// Ink is COLORED: suspended and dried ink are per-channel absorption
// densities (Beer–Lambert σ per RGB channel), so a wired `color` image's
// hues survive advection, diffusion, and drying. Per-cell state, split
// across two ping-pong pairs:
//   tex1 = (W, Ir, Ig, Ib)   water + suspended ink absorption
//   texD = (Dr, Dg, Db, -)   dried (fixed) ink absorption
// Paper structure (B = bottom height, C = capillary capacity) is generated
// CPU-side once per (seed, fiber count, dims) and uploaded as a static
// texture — fibers lower B and raise C along random segments, which is
// what makes thin ink wick into feathery fringes (nijimi).
//
// Deposition inputs:
//   `deposit` (mask)  — coverage: where and how much water+ink lands.
//   `color`   (image) — per-pixel ink color, deposited as normalized
//                       optical density -ln(rgb) (see INJECT_FS). When
//                       unwired, ink color falls back to the `ink_color`
//                       param (black = classic monochrome sumi). When
//                       `color` is wired but `deposit` is not, the color
//                       image's own alpha doubles as coverage, so one wire
//                       carries both shape and hue.
//
// Numerical note: the dynamic state lives in NODE-OWNED RGBA32F textures,
// not pool RGBA16F. Half floats have ~2^-11 relative precision, and the
// sim accumulates tiny deltas into large values (evapRate 0.004 against a
// wet cell's W of ~60 is far below half-ulp there — ink would never dry).
// The paper texture and the final canvas-res output stay on engine
// conventions. Own textures are deleted via gl.deleteTexture in dispose,
// never ctx.releaseTexture (the pool doesn't own them).

// ---- constants ----------------------------------------------------------

const EPS = 1e-6;

// Paper generation defaults (per the paper / spec §4). fiber_count in the
// UI is calibrated for a 1024² grid and scaled by actual cell count.
const PAPER_B0 = 8.0;
const PAPER_C0 = 1.0;
const FIBER_LEN = 14;
const FIBER_DB = 0.35;
const FIBER_DC = 0.12;
const FIBER_B_FLOOR = 0.05;

// Beer–Lambert composite weights (spec §6).
const K_DRIED = 0.9;
const K_WET = 0.55;

// Resolution independence. The CA's laws are per-CELL, so a bigger grid
// natively shrinks every visual length scale relative to the canvas:
// blooms spread fewer canvas-fractions per frame, washes dry after
// covering less relative distance, fibers shorten — "2048 never looks
// as good as 1024" no matter the sliders. All cell-scale quantities are
// therefore normalized to a REFERENCE grid, simScale =
// sqrt(cells)/REF_CELLS. Crucially the water update is a degenerate
// LAPLACIAN RELAXATION — the surface diffuses, radius ∝ cell·√substeps,
// NOT a ballistic front — so holding relative spread needs substeps ×
// simScale² (linear scaling leaves 2× grids ~30% slow, verified by
// eye). Per-substep rates (evap, rewet, continuous contact strength)
// divide by the same simScale² so scene-time behavior holds; beta needs
// NO scaling (β·substeps·cell² is then constant — the cancellation also
// retires its stability-cap caveat); fibers scale in length (×
// simScale) at conserved total fiber material (count ÷ simScale beyond
// the area term). REF_CELLS = 512 = the default-resolution sweet spot
// the model was tuned at, so existing setups keep their exact look and
// other sizes now match it. Cost is honest: substeps × simScale² on top
// of quadratic pixel growth (2048@0.5 ≈ 16× the reference); the substep
// cap below degrades spread speed gracefully past simScale ≈ 2.8 — drop
// `resolution` instead.
const REF_CELLS = 512;
const MAX_SUBSTEPS = 48;

// ---- shaders ------------------------------------------------------------

// All sim passes run at sim resolution with source and target the same
// size, so texelFetch(ivec2(gl_FragCoord.xy)) addresses the matching cell
// exactly — no filtering, no normalized-uv rounding. Out-of-grid neighbors
// are handled explicitly (no-flow boundary): a missing edge contributes
// zero flux, so ink can neither pool at nor escape through the border.

// Pass 1 — flux. Each cell computes the NET signed flux across its RIGHT
// and DOWN edges only (canonical edge ownership: every edge is computed by
// exactly one cell, so the apply gather conserves mass by construction).
// Positive = out of this cell. Four flux lanes (water + 3 ink channels)
// don't fit one RGBA target, so the pass runs twice from a shared
// template — part "a" writes (rightW, downW, rightIr, downIr), part "b"
// writes (rightIg, downIg, rightIb, downIb). Advected ink (Step 2) uses
// PRE-update concentrations — that's why it's computed here and not in
// the apply pass — and each directional dW is clamped >= 0 BEFORE the
// concentration multiply.
function fluxSource(part: "a" | "b"): string {
  const swizzleRight =
    part === "a" ? "f.x = e.x; f.z = e.y;" : "f.x = e.z; f.z = e.w;";
  const swizzleDown =
    part === "a" ? "f.y = e.x; f.w = e.y;" : "f.y = e.z; f.w = e.w;";
  return `#version 300 es
precision highp float;
uniform sampler2D u_state;   // (W, Ir, Ig, Ib)
uniform sampler2D u_paper;   // (B, C, -, -)
uniform float u_alpha;
out vec4 outColor;

// Net (W, Ir, Ig, Ib) OUT of o toward k across one edge.
vec4 edgeFlux(vec4 so, vec2 po, vec4 sk, vec2 pk) {
  float Wo = so.x, Wk = sk.x;
  float Bo = po.x, Co = po.y, Bk = pk.x, Ck = pk.y;
  float ho = Bo + Wo;
  float hk = Bk + Wk;
  // PipeHeight gates flow through the fiber structure (capillary trap).
  float pipeKO = max(Bo, Bk + Ck);  // controls flow k -> o
  float pipeOK = max(Bk, Bo + Co);  // controls flow o -> k
  float dWko = max(0.0, 0.25 * u_alpha * min(hk - ho, hk - pipeKO));
  float dWok = max(0.0, 0.25 * u_alpha * min(ho - hk, ho - pipeOK));
  vec3 dIko = dWko * sk.yzw / max(Wk, ${EPS});
  vec3 dIok = dWok * so.yzw / max(Wo, ${EPS});
  return vec4(dWok - dWko, dIok - dIko);
}

void main() {
  ivec2 sz = textureSize(u_state, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 so = texelFetch(u_state, p, 0);
  vec2 po = texelFetch(u_paper, p, 0).rg;
  vec4 f = vec4(0.0);
  if (p.x + 1 < sz.x) {
    ivec2 q = p + ivec2(1, 0);
    vec4 e = edgeFlux(so, po, texelFetch(u_state, q, 0),
                      texelFetch(u_paper, q, 0).rg);
    ${swizzleRight}
  }
  if (p.y + 1 < sz.y) {
    ivec2 q = p + ivec2(0, 1);
    vec4 e = edgeFlux(so, po, texelFetch(u_state, q, 0),
                      texelFetch(u_paper, q, 0).rg);
    ${swizzleDown}
  }
  outColor = f;
}`;
}

// Pass 2 — apply. Gather: my own right/down out-flux (negated) plus the
// left neighbor's right-flux and the up neighbor's down-flux (in-flux),
// for water and all three ink channels.
const APPLY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform sampler2D u_fluxA;   // (rW, dW, rIr, dIr)
uniform sampler2D u_fluxB;   // (rIg, dIg, rIb, dIb)
out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(u_state, p, 0);
  vec4 aS = texelFetch(u_fluxA, p, 0);
  vec4 bS = texelFetch(u_fluxB, p, 0);
  vec4 aL = p.x > 0 ? texelFetch(u_fluxA, p - ivec2(1, 0), 0) : vec4(0.0);
  vec4 bL = p.x > 0 ? texelFetch(u_fluxB, p - ivec2(1, 0), 0) : vec4(0.0);
  vec4 aU = p.y > 0 ? texelFetch(u_fluxA, p - ivec2(0, 1), 0) : vec4(0.0);
  vec4 bU = p.y > 0 ? texelFetch(u_fluxB, p - ivec2(0, 1), 0) : vec4(0.0);
  float dW = -aS.x - aS.y + aL.x + aU.y;
  vec3 dI = vec3(-aS.z - aS.w + aL.z + aU.w,
                 -bS.x - bS.y + bL.x + bU.y,
                 -bS.z - bS.w + bL.z + bU.w);
  outColor = vec4(max(s.x + dW, 0.0), max(s.yzw + dI, vec3(0.0)));
}`;

// Pass 3 — ink diffusion (concentration balancing), per channel. The
// paper's corrected antisymmetric form (the printed formula has a typo:
// I_o*W_o should be I_o*W_k); antisymmetry under o<->k swap makes the
// 4-neighbor gather conservative without edge ownership. Off-grid
// neighbors read as (W=0, I=0), whose term is exactly zero. W rides
// through unchanged. Evaporation is split into the next two passes: it
// mutates both tex1 and texD, and a fragment pass has one render target.
const DIFFUSE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform float u_beta;
out vec4 outColor;

void main() {
  ivec2 sz = textureSize(u_state, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(u_state, p, 0);
  float Wo = s.x;
  vec3 Io = s.yzw;
  vec3 dI = vec3(0.0);
  ivec2 offs[4];
  offs[0] = ivec2(-1, 0);
  offs[1] = ivec2(1, 0);
  offs[2] = ivec2(0, -1);
  offs[3] = ivec2(0, 1);
  for (int i = 0; i < 4; i++) {
    ivec2 q = p + offs[i];
    if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
    vec4 nk = texelFetch(u_state, q, 0);
    float denom = Wo + nk.x;
    if (denom > ${EPS}) {
      dI += u_beta * (nk.yzw * Wo - Io * nk.x) / denom;
    }
  }
  outColor = vec4(Wo, max(Io + dI, vec3(0.0)));
}`;

// Pass 4a — evaporation on the wet state. Uniform evaporation; a cell
// whose water hits zero drops its suspended ink (pass 4b banks the same
// ink into D — both passes derive the dried test from the SAME
// post-diffusion input, so they can't disagree). Cells that stay wet
// optionally RE-WET: standing water lifts a fraction of the dried ink
// back into suspension (u_rewet per substep; 4b subtracts the same
// amount). This is an extension beyond the paper — its fixing is
// permanent, right for sumi — so the default is 0; without it, dried
// absorption accumulates monotonically and a long-running comp drifts
// toward an opaque filter of whatever channel its inks absorb most.
const EVAP_WI_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform sampler2D u_dried;
uniform float u_evap;
uniform float u_rewet;
uniform float u_fade;    // per-substep fade factor (1 = off)
out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(u_state, p, 0);
  float W2 = s.x - u_evap;
  if (W2 <= 0.0) {
    outColor = vec4(0.0, vec3(0.0));
  } else {
    vec3 D = texelFetch(u_dried, p, 0).rgb;
    outColor = vec4(W2, (s.yzw + u_rewet * D) * u_fade);
  }
}`;

// Pass 4b — fixing + fade + lifetime. Cells that just dried bank their
// suspended ink into the dried accumulator; cells that stay wet give up
// the re-wetted fraction 4a lifted (same inputs, same test — exactly
// conservative; both sides of the transfer scale by the same u_fade, so
// fading doesn't unbalance it). The dried buffer's alpha channel is an
// AGE clock (seconds since fresh pigment landed): the dry test is a
// STATE that recurs every substep, so the clock resets only when actual
// ink is banked — otherwise dried marks would reset forever and
// lifetime could never fire. Past u_lifetime the mark dissolves by
// u_dissolve per substep. Fade and lifetime are deliberately
// non-conservative (like evaporation for water).
const FIX_D_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;   // post-diffusion wet state
uniform sampler2D u_dried;
uniform float u_evap;
uniform float u_rewet;
uniform float u_fade;        // per-substep fade factor (1 = off)
uniform float u_dt;          // seconds per substep
uniform float u_lifetime;    // seconds; 0 = infinite
uniform float u_dissolve;    // per-substep dissolve factor past lifetime
out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(u_state, p, 0);
  vec4 d = texelFetch(u_dried, p, 0);
  vec3 D = d.rgb;
  float age = d.a + u_dt;
  if (s.x - u_evap <= 0.0) {
    vec3 fresh = s.yzw;
    D += fresh;
    if (dot(fresh, vec3(1.0)) > 1e-5) age = 0.0;
  } else {
    D -= u_rewet * D;
  }
  D *= u_fade;
  if (u_lifetime > 0.0 && age > u_lifetime) D *= u_dissolve;
  outColor = vec4(D, age);
}`;

// Deposition — brush/paper CONTACT. Two pacing modes share this shader
// via u_strength:
//   continuous (sample_rate = 0): once per SUBSTEP at strength 0.25·α
//     (the paper folds brush contact into the same n-iteration loop as
//     transfer/diffusion, so contact competes with outflow and
//     evaporation on equal terms);
//   sampled (sample_rate > 0 Hz): once per 1/rate seconds of scene time
//     at strength 1.0 — a full stamp of the current input (video frame,
//     animated mask...), which then blooms/dries untouched until the
//     next tick.
// The wired deposit is idealized as an infinite reservoir riding the
// paper surface at water level `coverage * deposit_water`: substituting
// a brush cell with Bb = Bo, Cb = 0 into the paper's Step-1 pipe
// formula collapses both min-arguments to the plain level difference,
// so the exchange is exactly
//   dW = max(0, strength·(cov·head − W))
// — an exponential approach to W = cov·head. Deposition is therefore
// SELF-LIMITING: dwell tops a pool up against evaporation and outflow
// but never floods past the head, and ink (riding at the reservoir's
// concentration, per Step 2) stops accumulating once the cell
// equilibrates — which also bounds optical density, so a conserved
// color settles at its own hue instead of deepening forever. Backflow
// (paper wetter than the reservoir) is clamped off; the two-way
// exchange belongs to the real brush CA (M4).
//
// Coverage comes from the deposit mask when wired, else from the color
// image's alpha. Ink absorption is the color's OPTICAL DENSITY,
// -ln(rgb), normalized so pure black = 1 (white pixels are clear
// water). NOT the linear approximation (1 - rgb): the render is
// exp(-k·σ), so with -ln an accumulated wash renders rgb^s — a pale or
// deepened version of the SAME hue, like real glazing — whereas (1-rgb)
// diverges channel ratios exponentially (a warm photo drifts
// olive-brown as blue dies). The param fallback goes through the same
// formula on the CPU, so black ink is byte-identical either way.
const SIGMA_MIN_T = 0.004; // ~1/255; caps -ln at ~5.5 and kills log(0)
const CONTACT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform sampler2D u_deposit;  // canvas-res mask, linear-sampled
uniform sampler2D u_color;    // canvas-res image, linear-sampled
uniform sampler2D u_water;    // canvas-res mask — reservoir head field
uniform sampler2D u_ink;      // canvas-res mask — concentration field
uniform int u_hasDeposit;
uniform int u_hasColor;
uniform int u_hasWater;
uniform int u_hasInk;
uniform vec3 u_sigmaParam;    // normalized -ln(ink_color)
uniform float u_head;         // reservoir water level at full coverage
uniform float u_strength;     // 0.25·α continuous; 1.0 = sampled full stamp
uniform float u_conc;
out vec4 outColor;

void main() {
  ivec2 sz = textureSize(u_state, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(u_state, p, 0);
  vec2 uv = (vec2(p) + 0.5) / vec2(sz);
  vec4 col = texture(u_color, uv);
  // Coverage: deposit mask > color alpha > full sheet (the last so a
  // water map wired alone pre-wets without needing a deposit wire).
  float cov = u_hasDeposit == 1
    ? texture(u_deposit, uv).r
    : (u_hasColor == 1 ? clamp(col.a, 0.0, 1.0) : 1.0);
  // Delivery fields (spec §5.1): water map scales the reservoir HEAD
  // per cell (how wet), ink map scales pigment CONCENTRATION (how
  // inky). Ink still rides water — an ink map over dry cells delivers
  // nothing, which is the dry-brush limit, not a bug.
  float waterField = u_hasWater == 1 ? texture(u_water, uv).r : 1.0;
  float inkField = u_hasInk == 1 ? texture(u_ink, uv).r : 1.0;
  // Straight-alpha discipline: RGB under zero/low alpha is arbitrary in
  // this engine (stale pool contents, a Merge's base color under a
  // transparent stack...), so it must NEVER be read as pigment — a
  // deposit mask that overlaps the color image's transparent regions
  // would otherwise lay down whatever ghost hue sits there. Recover the
  // true ink hue at linear-filtered soft edges by un-weighting the rgb
  // by its own alpha, and scale the pigment by alpha so uncovered
  // regions contribute CLEAR water only.
  float ca = clamp(col.a, 0.0, 1.0);
  vec3 inkRgb = clamp(col.rgb / max(col.a, 1e-4), 0.0, 1.0);
  vec3 sigma = u_hasColor == 1
    ? log(clamp(inkRgb, ${SIGMA_MIN_T}, 1.0)) / log(${SIGMA_MIN_T}) * ca
    : u_sigmaParam;
  float dW = max(0.0, u_strength * (cov * waterField * u_head - s.x));
  outColor = vec4(s.x + dW, s.yzw + dW * u_conc * inkField * sigma);
}`;

// Render — upsample the reduced-res sim to full canvas and Beer–Lambert
// composite. Manual bilinear via texelFetch: the 32F state textures are
// NEAREST-filtered (linear filtering of float32 needs an extension we
// don't want to depend on), so the shader interpolates by hand.
// u_view selects debug channels (composite/water/ink/dried/paper).
const RENDER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_state;
uniform sampler2D u_dried;
uniform sampler2D u_paper;
uniform int u_view;
uniform float u_kDried;
uniform float u_kWet;
uniform float u_b0;
uniform int u_paperBg;
uniform vec3 u_paperColor;
out vec4 outColor;

vec4 sampleBilinear(sampler2D t, vec2 uv) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 xy = uv * sz - 0.5;
  vec2 f = fract(xy);
  ivec2 p0 = ivec2(floor(xy));
  ivec2 mx = ivec2(sz) - 1;
  ivec2 a = clamp(p0, ivec2(0), mx);
  ivec2 b = clamp(p0 + ivec2(1, 0), ivec2(0), mx);
  ivec2 c = clamp(p0 + ivec2(0, 1), ivec2(0), mx);
  ivec2 d = clamp(p0 + ivec2(1, 1), ivec2(0), mx);
  return mix(mix(texelFetch(t, a, 0), texelFetch(t, b, 0), f.x),
             mix(texelFetch(t, c, 0), texelFetch(t, d, 0), f.x), f.y);
}

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec4 s = sampleBilinear(u_state, v_uv);
  vec3 D = sampleBilinear(u_dried, v_uv).rgb;
  vec2 bc = sampleBilinear(u_paper, v_uv).rg;
  float W = s.x;
  vec3 I = s.yzw;
  float normB = clamp(bc.x / max(u_b0, 1e-3), 0.0, 1.0);
  // Debug views. Ink/dried show the pigment's appearance on white
  // (absorption inverted) so a red wash previews red, not cyan.
  if (u_view == 1) { outColor = vec4(vec3(W / 20.0), 1.0); return; }
  if (u_view == 2) {
    outColor = vec4(vec3(1.0) - clamp(I / 5.0, 0.0, 1.0), 1.0);
    return;
  }
  if (u_view == 3) {
    outColor = vec4(vec3(1.0) - clamp(D / 5.0, 0.0, 1.0), 1.0);
    return;
  }
  if (u_view == 4) { outColor = vec4(vec3(normB), 1.0); return; }
  vec3 density = u_kDried * D + u_kWet * I;
  vec3 trans = exp(-density);
  // Paper color is a param (neutral by default — the early hardcoded
  // warm-cream constants read as a strong yellow cast on a full-canvas
  // background); the fiber grain modulates brightness only, hue-free.
  vec3 paperTint = u_paperColor * mix(0.97, 1.0, normB);
  vec3 color = paperTint * trans;
  // Suspended (wet) ink reads slightly cool so strokes visibly "set".
  float wetness = clamp(u_kWet * lum(I) / max(lum(density), ${EPS}), 0.0, 1.0);
  color = mix(color, color * vec3(0.96, 0.97, 1.0), wetness * 0.3);
  if (u_paperBg == 1) {
    outColor = vec4(color, 1.0);
  } else {
    // Transparent ink: solve straight-alpha (rgb, a) so that source-over
    // on a white backdrop reproduces the multiplicative stain exactly
    // (rgb*a + (1-a) == trans), which keeps other backdrops plausible.
    float a = 1.0 - min(trans.r, min(trans.g, trans.b));
    vec3 rgb = a > 1e-4 ? (trans - (1.0 - a)) / a : vec3(0.0);
    outColor = vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
  }
}`;

// ---- paper generation (CPU, one-time) -----------------------------------

// Deterministic PRNG so a given paper_seed regenerates the same sheet.
function mulberry32(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform sheet (B0, C0) with `fiberCount` random short segments stamped
// in: each fiber lowers B (easier flow along it) and raises C (traps ink)
// — the source of feathery nijimi fringes. fiberCount is calibrated for
// 1024² and scaled by actual cell count so "paper coarseness" reads the
// same at any resolution.
function generatePaper(
  simW: number,
  simH: number,
  fiberCount: number,
  seed: number,
  simScale: number
): Float32Array {
  const data = new Float32Array(simW * simH * 4);
  for (let i = 0; i < simW * simH; i++) {
    data[i * 4] = PAPER_B0;
    data[i * 4 + 1] = PAPER_C0;
  }
  const rand = mulberry32(seed);
  // Fibers hold their CANVAS-relative length across resolutions
  // (len × simScale) at conserved total fiber material per cell
  // (count ÷ simScale beyond the area term) — a finer grid gets
  // proportionally more, longer, thinner fibers rather than a
  // different-looking sheet.
  const len = Math.max(2, Math.round(FIBER_LEN * simScale));
  const count = Math.round(
    (fiberCount * (simW * simH)) /
      (1024 * 1024) /
      Math.max(simScale, 1e-3)
  );
  for (let f = 0; f < count; f++) {
    const x0 = rand() * simW;
    const y0 = rand() * simH;
    const theta = rand() * Math.PI;
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    for (let t = 0; t < len; t++) {
      const x = Math.round(x0 + dx * t);
      const y = Math.round(y0 + dy * t);
      if (x < 0 || y < 0 || x >= simW || y >= simH) continue;
      const idx = (y * simW + x) * 4;
      data[idx] = Math.max(FIBER_B_FLOOR, data[idx] - FIBER_DB);
      data[idx + 1] += FIBER_DC;
    }
  }
  return data;
}

// ---- persistent state ----------------------------------------------------

// Node-owned RGBA32F texture wrapped in an ImageValue shell so
// ctx.drawFullscreen / clearTarget accept it as a render target. NOT a
// pool texture — delete with gl.deleteTexture, never ctx.releaseTexture.
function createSimTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number
): ImageValue {
  const tex = gl.createTexture();
  if (!tex) throw new Error("watercolor-ink: createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  // NEAREST: float32 linear filtering needs OES_texture_float_linear and
  // the sim reads exact texels anyway; the render pass bilinears by hand.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { kind: "image", texture: tex, width: w, height: h };
}

interface WCState {
  // Wet-state ping-pong (W, Ir, Ig, Ib) + dried-ink ping-pong (Dr, Dg,
  // Db, -) + the two per-substep edge-flux scratch textures. All
  // node-owned RGBA32F.
  bufs: [ImageValue, ImageValue];
  dbufs: [ImageValue, ImageValue];
  fluxA: ImageValue;
  fluxB: ImageValue;
  readIdx: 0 | 1;
  driedIdx: 0 | 1;
  // Static paper (B, C) — engine-owned 16F upload (release via ctx).
  paper: ImageValue | null;
  paperKey: string;
  width: number;
  height: number;
  lastTime: number;
  initialized: boolean;
  // Drive-by-input mode: last-seen `time` scalar; -Infinity = never.
  lastDriver: number;
  // Sampled-deposition mode: scene time of the last full stamp;
  // -Infinity = stamp immediately on the first active frame.
  lastSample: number;
}

function stateKey(nodeId: string): string {
  return `watercolor-ink:${nodeId}`;
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  simW: number,
  simH: number
): WCState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as WCState | undefined;
  if (existing && existing.width === simW && existing.height === simH) {
    return existing;
  }
  if (existing) releaseState(ctx, existing);
  const gl = ctx.gl;
  const state: WCState = {
    bufs: [createSimTexture(gl, simW, simH), createSimTexture(gl, simW, simH)],
    dbufs: [createSimTexture(gl, simW, simH), createSimTexture(gl, simW, simH)],
    fluxA: createSimTexture(gl, simW, simH),
    fluxB: createSimTexture(gl, simW, simH),
    readIdx: 0,
    driedIdx: 0,
    paper: null,
    paperKey: "",
    width: simW,
    height: simH,
    lastTime: ctx.time,
    initialized: false,
    lastDriver: -Infinity,
    lastSample: -Infinity,
  };
  ctx.state[key] = state;
  return state;
}

function releaseState(ctx: RenderContext, s: WCState): void {
  const gl = ctx.gl;
  gl.deleteTexture(s.bufs[0].texture);
  gl.deleteTexture(s.bufs[1].texture);
  gl.deleteTexture(s.dbufs[0].texture);
  gl.deleteTexture(s.dbufs[1].texture);
  gl.deleteTexture(s.fluxA.texture);
  gl.deleteTexture(s.fluxB.texture);
  if (s.paper) ctx.releaseTexture(s.paper.texture);
}

function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const VIEW_OPTIONS = ["composite", "water", "ink", "dried", "paper"];

// One-time warn if the device can't render to float targets — the sim
// needs them (see the precision note up top).
let warnedNoFloat = false;

// ---- node definition -----------------------------------------------------

export const watercolorInkNode: NodeDefinition = {
  type: "watercolor-ink",
  name: "Watercolor Ink",
  category: "image",
  subcategory: "generator",
  description:
    "Cellular-automaton watercolor / sumi ink simulation (Zhang et al. 1999). Wire any mask/spline/shape into `deposit` to lay down ink; water spreads through fibrous paper (nijimi), suspended ink rides and diffuses with it, and ink fixes permanently where the water dries. Wire an image into `color` and the deposited ink keeps its hues (white = clear water; with `deposit` unwired the image's alpha doubles as coverage). Low concentration = thin ink that wicks far along fibers; high = dense marks. `water map` scales the delivered water per cell (wired alone = pre-wet the sheet, wet-on-wet); `ink map` scales pigment concentration per cell (needs water to ride — dry areas deliver nothing). Sample rate 0 = continuous contact; above 0, the input (e.g. a video frame) is stamped as a full wash every 1/rate seconds and left to bloom/dry between stamps. Plays while the timeline runs; restarting the timeline clears the sheet.",
  backend: "webgl2",
  // Self-iterating — output depends on accumulated substeps, not just
  // current params. Time is mixed into the fingerprint below.
  stable: false,
  simulation: true,
  inputs: [
    { name: "deposit", type: "mask", required: false },
    { name: "color", type: "image", required: false },
    { name: "water_map", label: "water map", type: "mask", required: false },
    { name: "ink_map", label: "ink map", type: "mask", required: false },
  ],
  // Like Reaction Diffusion: `drive_by_scene_time` swaps the ctx.playing
  // gate for a wired monotonic scalar (Scene Time, Accumulator, Math...).
  resolveInputs(params): InputSocketDef[] {
    const base: InputSocketDef[] = [
      { name: "deposit", type: "mask", required: false },
      { name: "color", type: "image", required: false },
      { name: "water_map", label: "water map", type: "mask", required: false },
      { name: "ink_map", label: "ink map", type: "mask", required: false },
    ];
    if (params.drive_by_scene_time) {
      base.push({ name: "time", type: "scalar", required: false });
    }
    return base;
  },
  params: [
    {
      name: "deposit_water",
      label: "Deposit water",
      type: "scalar",
      min: 0,
      max: 200,
      step: 1,
      default: 60,
    },
    {
      name: "dip_concentration",
      label: "Ink concentration",
      type: "scalar",
      min: 0.02,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "sample_rate",
      label: "Sample rate (Hz)",
      type: "scalar",
      min: 0,
      max: 30,
      step: 0.1,
      default: 0,
    },
    {
      name: "alpha",
      label: "Flow rate",
      type: "scalar",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.8,
    },
    {
      name: "beta",
      label: "Diffusion",
      type: "scalar",
      min: 0,
      max: 0.25,
      step: 0.005,
      default: 0.12,
    },
    {
      name: "evap_rate",
      label: "Evaporation",
      type: "scalar",
      min: 0,
      max: 0.05,
      step: 0.0005,
      default: 0.004,
    },
    {
      name: "rewet",
      label: "Re-wetting",
      type: "scalar",
      min: 0,
      max: 0.05,
      step: 0.0005,
      default: 0,
    },
    {
      name: "fade",
      label: "Fade / sec",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.005,
      default: 0,
    },
    {
      name: "lifetime",
      label: "Dried lifetime (s)",
      type: "scalar",
      min: 0,
      max: 60,
      step: 0.1,
      default: 0,
    },
    {
      name: "dissolve",
      label: "Dissolve (s)",
      type: "scalar",
      min: 0.05,
      max: 10,
      step: 0.05,
      default: 1,
      visibleIf: (p) => ((p.lifetime as number) ?? 0) > 0,
    },
    {
      name: "substeps_per_frame",
      label: "Substeps / frame",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 6,
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 0.1,
      max: 1,
      step: 0.05,
      default: 0.5,
    },
    {
      name: "fiber_count",
      label: "Paper coarseness",
      type: "scalar",
      min: 0,
      max: 200000,
      step: 1000,
      default: 50000,
    },
    {
      name: "paper_seed",
      label: "Paper seed",
      type: "scalar",
      min: 0,
      max: 1000000,
      step: 1,
      default: 0,
    },
    {
      name: "wet_strength",
      label: "Wet ink strength",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.55,
    },
    {
      name: "dried_strength",
      label: "Dried ink strength",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.9,
    },
    {
      name: "ink_color",
      label: "Ink color",
      type: "color",
      default: "#000000",
    },
    {
      name: "paper_color",
      label: "Paper color",
      type: "color",
      default: "#f7f7f6",
    },
    {
      name: "paper_bg",
      label: "Paper background",
      type: "boolean",
      default: true,
    },
    {
      name: "view",
      label: "View",
      type: "enum",
      options: VIEW_OPTIONS,
      default: "composite",
    },
    {
      name: "drive_by_scene_time",
      label: "Drive by time input",
      type: "boolean",
      default: false,
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],
  headerControl: { paramName: "view" },

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const gl = ctx.gl;
    // Float render targets are required (see precision note). Without
    // EXT_color_buffer_float the RGBA32F attachments are unrenderable —
    // emit blank paper instead of a black screen or GL errors.
    if (!gl.getExtension("EXT_color_buffer_float")) {
      if (!warnedNoFloat) {
        console.warn(
          "watercolor-ink: EXT_color_buffer_float unavailable — simulation disabled."
        );
        warnedNoFloat = true;
      }
      const blank = ctx.allocImage();
      ctx.clearTarget(blank, [0.94, 0.92, 0.88, 1]);
      return { primary: blank };
    }

    const rez = Math.max(0.1, Math.min(1, (params.resolution as number) ?? 0.5));
    const simW = Math.max(4, Math.round(ctx.width * rez));
    const simH = Math.max(4, Math.round(ctx.height * rez));
    // Reference cell scale — see the REF_CELLS note. 1.0 at a 512² sim
    // (1024 canvas at the default 0.5 resolution).
    const simScale = Math.sqrt(simW * simH) / REF_CELLS;
    const state = ensureState(ctx, nodeId, simW, simH);

    // Paper regenerates when seed/coarseness change (and implicitly on
    // resize, since ensureState reset paperKey with the realloc).
    const fiberCount = Math.max(0, (params.fiber_count as number) ?? 50000);
    const seed = Math.floor((params.paper_seed as number) ?? 0);
    const paperKey = `${seed}:${fiberCount}`;
    if (!state.paper || state.paperKey !== paperKey) {
      if (state.paper) ctx.releaseTexture(state.paper.texture);
      state.paper = ctx.uploadFloat32ToImage(
        generatePaper(simW, simH, fiberCount, seed, simScale),
        simW,
        simH
      );
      state.paperKey = paperKey;
      // New sheet = clean sheet.
      state.initialized = false;
    }

    // Reset to dry blank paper on first eval or a scene-time wrap
    // (timeline restart) — same detection as Reaction Diffusion.
    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    if (!state.initialized || (wasNonZero && isNearZero)) {
      // ALL FOUR channels are packed state — (W, Ir, Ig, Ib) and
      // (Dr, Dg, Db, -) — so the clear color must be all-zero. A
      // reflexive [0,0,0,1] "opaque black" clear plants a full unit of
      // blue-absorbing (yellow) ink in every cell's Ib, which the first
      // substep's fix pass banks into D as a permanent uniform veil.
      ctx.clearTarget(state.bufs[0], [0, 0, 0, 0]);
      ctx.clearTarget(state.bufs[1], [0, 0, 0, 0]);
      ctx.clearTarget(state.dbufs[0], [0, 0, 0, 0]);
      ctx.clearTarget(state.dbufs[1], [0, 0, 0, 0]);
      state.readIdx = 0;
      state.driedIdx = 0;
      state.initialized = true;
      state.lastDriver =
        inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      state.lastSample = -Infinity;
    }

    // Step gating. Default: run while the timeline plays — plus during
    // offline export, where playing is false but time advances frame by
    // frame (RD predates exports stepping; without this the exported
    // video would freeze the wash). drive_by_scene_time swaps the gate
    // for a wired monotonic scalar.
    let active: boolean;
    if (params.drive_by_scene_time) {
      const driver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      active = driver > state.lastDriver + 1e-6;
      state.lastDriver = driver;
    } else {
      active = ctx.playing || (ctx.offline && ctx.time > state.lastTime + 1e-6);
    }
    state.lastTime = ctx.time;

    // --- deposition setup ---
    // deposit_water is the reservoir LEVEL the wired deposit sustains
    // (the paper's brush-dip water quantity — see CONTACT_FS), not a
    // rate. The contact pass runs inside the substep loop below.
    const deposit =
      inputs.deposit && inputs.deposit.kind === "mask"
        ? inputs.deposit
        : null;
    const colorImg =
      inputs.color && inputs.color.kind === "image" ? inputs.color : null;
    const waterMap =
      inputs.water_map && inputs.water_map.kind === "mask"
        ? inputs.water_map
        : null;
    const inkMap =
      inputs.ink_map && inputs.ink_map.kind === "mask"
        ? inputs.ink_map
        : null;
    const head = Math.max(0, (params.deposit_water as number) ?? 60);
    const conc = Math.max(
      0,
      Math.min(1, (params.dip_concentration as number) ?? 0.5)
    );
    // A water map alone deposits too (clear pre-wetting at cov = 1); an
    // ink map alone can't — pigment needs carrier water to ride.
    const depositing =
      (deposit || colorImg || waterMap) != null && head > 0;
    const sampleRate = Math.max(0, (params.sample_rate as number) ?? 0);
    const ink = hexToRgb01(colorValueToHex(params.ink_color, "#000000"));
    // Same normalized optical density as the shader's image path.
    const sigmaOf = (c: number) =>
      Math.log(Math.max(c, SIGMA_MIN_T)) / Math.log(SIGMA_MIN_T);

    // --- substeps (resolution-normalized; see the REF_CELLS note) ---
    // Water spreads DIFFUSIVELY (radius ∝ cell·√substeps), so holding
    // relative bloom speed needs substeps × simScale²; per-substep
    // rates (evap, rewet, contact) divide by the same factor to hold
    // scene-time behavior; beta cancels exactly and stays raw.
    const dynScale = simScale * simScale;
    const substeps = active
      ? Math.max(
          1,
          Math.min(
            MAX_SUBSTEPS,
            Math.round(
              ((params.substeps_per_frame as number) ?? 6) * dynScale
            )
          )
        )
      : 0;
    if (substeps > 0) {
      const alpha = Math.max(
        0.05,
        Math.min(1, (params.alpha as number) ?? 0.8)
      );
      const beta = Math.max(
        0,
        Math.min(0.25, (params.beta as number) ?? 0.12)
      );
      const evap =
        Math.max(0, Math.min(0.05, (params.evap_rate as number) ?? 0.004)) /
        dynScale;
      const rewet =
        Math.max(0, Math.min(0.05, (params.rewet as number) ?? 0)) /
        dynScale;
      // Fade / lifetime are authored in SECONDS, converted to
      // per-substep factors here — framerate- and resolution-
      // independent by construction (dtSub already reflects the
      // simScale²-scaled substep count).
      const dtSub = 1 / (Math.max(ctx.fps, 1) * substeps);
      const fade = Math.max(0, Math.min(1, (params.fade as number) ?? 0));
      const fadeFactor = fade > 0 ? Math.pow(1 - fade, dtSub) : 1;
      const lifetime = Math.max(0, (params.lifetime as number) ?? 0);
      const dissolve = Math.max(0.05, (params.dissolve as number) ?? 1);
      // Decays a mark to 1% over `dissolve` seconds once expired.
      const dissolveFactor = Math.pow(0.01, dtSub / dissolve);
      const fluxAProg = ctx.getShader("watercolor/flux-a", fluxSource("a"));
      const fluxBProg = ctx.getShader("watercolor/flux-b", fluxSource("b"));
      const applyProg = ctx.getShader("watercolor/apply", APPLY_FS);
      const diffProg = ctx.getShader("watercolor/diffuse", DIFFUSE_FS);
      const evapProg = ctx.getShader("watercolor/evap-wi", EVAP_WI_FS);
      const fixProg = ctx.getShader("watercolor/fix-d", FIX_D_FS);
      const contactProg = depositing
        ? ctx.getShader("watercolor/contact", CONTACT_FS)
        : null;
      // Contact exchange: src -> other, flips readIdx. Shared by both
      // pacing modes; only the equilibration strength differs.
      const runContact = (strength: number) => {
        if (!contactProg) return;
        const cSrc = state.bufs[state.readIdx];
        const cDst = state.bufs[(state.readIdx ^ 1) as 0 | 1];
        // Every sampler needs a valid binding — reuse whichever input
        // exists for the missing ones; the u_has* flags gate their use.
        const anyTex = (deposit ?? colorImg ?? waterMap)!.texture;
        const depositTex = deposit?.texture ?? anyTex;
        const colorTex = colorImg?.texture ?? anyTex;
        const waterTex = waterMap?.texture ?? anyTex;
        const inkTex = inkMap?.texture ?? anyTex;
        ctx.drawFullscreen(contactProg, cDst, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, cSrc.texture);
          g.uniform1i(g.getUniformLocation(contactProg, "u_state"), 0);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, depositTex);
          g.uniform1i(g.getUniformLocation(contactProg, "u_deposit"), 1);
          g.activeTexture(g.TEXTURE2);
          g.bindTexture(g.TEXTURE_2D, colorTex);
          g.uniform1i(g.getUniformLocation(contactProg, "u_color"), 2);
          g.activeTexture(g.TEXTURE3);
          g.bindTexture(g.TEXTURE_2D, waterTex);
          g.uniform1i(g.getUniformLocation(contactProg, "u_water"), 3);
          g.activeTexture(g.TEXTURE4);
          g.bindTexture(g.TEXTURE_2D, inkTex);
          g.uniform1i(g.getUniformLocation(contactProg, "u_ink"), 4);
          g.uniform1i(
            g.getUniformLocation(contactProg, "u_hasDeposit"),
            deposit ? 1 : 0
          );
          g.uniform1i(
            g.getUniformLocation(contactProg, "u_hasColor"),
            colorImg ? 1 : 0
          );
          g.uniform1i(
            g.getUniformLocation(contactProg, "u_hasWater"),
            waterMap ? 1 : 0
          );
          g.uniform1i(
            g.getUniformLocation(contactProg, "u_hasInk"),
            inkMap ? 1 : 0
          );
          g.uniform3f(
            g.getUniformLocation(contactProg, "u_sigmaParam"),
            sigmaOf(ink[0]),
            sigmaOf(ink[1]),
            sigmaOf(ink[2])
          );
          g.uniform1f(g.getUniformLocation(contactProg, "u_head"), head);
          g.uniform1f(
            g.getUniformLocation(contactProg, "u_strength"),
            strength
          );
          g.uniform1f(g.getUniformLocation(contactProg, "u_conc"), conc);
        });
        state.readIdx = (state.readIdx ^ 1) as 0 | 1;
      };
      // Sampled deposition: one full-strength stamp of the current input
      // every 1/rate seconds of scene time (first active frame stamps
      // immediately), then the wash evolves untouched until the next
      // tick. Continuous deposition runs inside the substep loop instead.
      if (contactProg && sampleRate > 0) {
        if (ctx.time >= state.lastSample + 1 / sampleRate) {
          runContact(1.0);
          state.lastSample = ctx.time;
        }
      }
      for (let i = 0; i < substeps; i++) {
        // 0. continuous brush/paper contact: inside the loop, per the
        // paper's n-iteration procedure, so the reservoir competes with
        // outflow/evaporation every step (÷ dynScale: same per-frame
        // equilibration at any grid size).
        if (sampleRate <= 0) runContact(Math.min(1, (0.25 * alpha) / dynScale));
        const src = state.bufs[state.readIdx];
        const other = state.bufs[(state.readIdx ^ 1) as 0 | 1];
        // 1. flux (both halves): src -> fluxA, fluxB
        for (const [prog, target] of [
          [fluxAProg, state.fluxA],
          [fluxBProg, state.fluxB],
        ] as const) {
          ctx.drawFullscreen(prog, target, (g) => {
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, src.texture);
            g.uniform1i(g.getUniformLocation(prog, "u_state"), 0);
            g.activeTexture(g.TEXTURE1);
            g.bindTexture(g.TEXTURE_2D, state.paper!.texture);
            g.uniform1i(g.getUniformLocation(prog, "u_paper"), 1);
            g.uniform1f(g.getUniformLocation(prog, "u_alpha"), alpha);
          });
        }
        // 2. apply: src + fluxes -> other
        ctx.drawFullscreen(applyProg, other, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, src.texture);
          g.uniform1i(g.getUniformLocation(applyProg, "u_state"), 0);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, state.fluxA.texture);
          g.uniform1i(g.getUniformLocation(applyProg, "u_fluxA"), 1);
          g.activeTexture(g.TEXTURE2);
          g.bindTexture(g.TEXTURE_2D, state.fluxB.texture);
          g.uniform1i(g.getUniformLocation(applyProg, "u_fluxB"), 2);
        });
        // 3. diffuse: other -> src (src's content is dead after apply)
        ctx.drawFullscreen(diffProg, src, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, other.texture);
          g.uniform1i(g.getUniformLocation(diffProg, "u_state"), 0);
          g.uniform1f(g.getUniformLocation(diffProg, "u_beta"), beta);
        });
        // 4a. evaporate + re-wet: src (post-diffuse) + dried -> other
        const dSrc = state.dbufs[state.driedIdx];
        const dDst = state.dbufs[(state.driedIdx ^ 1) as 0 | 1];
        ctx.drawFullscreen(evapProg, other, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, src.texture);
          g.uniform1i(g.getUniformLocation(evapProg, "u_state"), 0);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, dSrc.texture);
          g.uniform1i(g.getUniformLocation(evapProg, "u_dried"), 1);
          g.uniform1f(g.getUniformLocation(evapProg, "u_evap"), evap);
          g.uniform1f(g.getUniformLocation(evapProg, "u_rewet"), rewet);
          g.uniform1f(g.getUniformLocation(evapProg, "u_fade"), fadeFactor);
        });
        // 4b. fix dried ink: src (post-diffuse) + dried -> other dried.
        // Reads the SAME post-diffuse input as 4a so the dried test
        // can't disagree between the two writes.
        ctx.drawFullscreen(fixProg, dDst, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, src.texture);
          g.uniform1i(g.getUniformLocation(fixProg, "u_state"), 0);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, dSrc.texture);
          g.uniform1i(g.getUniformLocation(fixProg, "u_dried"), 1);
          g.uniform1f(g.getUniformLocation(fixProg, "u_evap"), evap);
          g.uniform1f(g.getUniformLocation(fixProg, "u_rewet"), rewet);
          g.uniform1f(g.getUniformLocation(fixProg, "u_fade"), fadeFactor);
          g.uniform1f(g.getUniformLocation(fixProg, "u_dt"), dtSub);
          g.uniform1f(g.getUniformLocation(fixProg, "u_lifetime"), lifetime);
          g.uniform1f(
            g.getUniformLocation(fixProg, "u_dissolve"),
            dissolveFactor
          );
        });
        // 4a wrote the newest wet state into `other`; 4b flipped dried.
        state.readIdx = (state.readIdx ^ 1) as 0 | 1;
        state.driedIdx = (state.driedIdx ^ 1) as 0 | 1;
      }
    }

    // --- render to full canvas ---
    const output = ctx.allocImage();
    const renderProg = ctx.getShader("watercolor/render", RENDER_FS);
    const read = state.bufs[state.readIdx];
    const dRead = state.dbufs[state.driedIdx];
    const viewIdx = Math.max(0, VIEW_OPTIONS.indexOf(params.view as string));
    ctx.drawFullscreen(renderProg, output, (g) => {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, read.texture);
      g.uniform1i(g.getUniformLocation(renderProg, "u_state"), 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, dRead.texture);
      g.uniform1i(g.getUniformLocation(renderProg, "u_dried"), 1);
      g.activeTexture(g.TEXTURE2);
      g.bindTexture(g.TEXTURE_2D, state.paper!.texture);
      g.uniform1i(g.getUniformLocation(renderProg, "u_paper"), 2);
      g.uniform1i(g.getUniformLocation(renderProg, "u_view"), viewIdx);
      g.uniform1f(
        g.getUniformLocation(renderProg, "u_kDried"),
        Math.max(0, Math.min(2, (params.dried_strength as number) ?? K_DRIED))
      );
      g.uniform1f(
        g.getUniformLocation(renderProg, "u_kWet"),
        Math.max(0, Math.min(2, (params.wet_strength as number) ?? K_WET))
      );
      g.uniform1f(g.getUniformLocation(renderProg, "u_b0"), PAPER_B0);
      g.uniform1i(
        g.getUniformLocation(renderProg, "u_paperBg"),
        params.paper_bg === false ? 0 : 1
      );
      const paper = hexToRgb01(
        colorValueToHex(params.paper_color, "#f7f7f6")
      );
      g.uniform3f(
        g.getUniformLocation(renderProg, "u_paperColor"),
        paper[0],
        paper[1],
        paper[2]
      );
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as WCState | undefined;
    if (s) releaseState(ctx, s);
    delete ctx.state[key];
  },
};
