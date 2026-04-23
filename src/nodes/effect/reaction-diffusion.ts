import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";

// Reaction-Diffusion node. Self-iterating: runs `steps_per_frame` passes
// of whatever model the preset selects (Gray-Scott or FitzHugh-Nagumo)
// each eval, using a pair of persistent ping-pong textures at a reduced
// resolution for speed.
//
// On scene-time=0 (or first eval after reset), the simulation re-seeds:
// from the `seed` input if connected (R channel → U, G channel → V),
// otherwise from a canonical starting state — U=1 everywhere, V=splat
// in the center — which gives predictable organic growth from a single
// disturbance.
//
// Output is grayscale of the V channel. Pipe through Color Ramp for
// colorization; same philosophy as Noise.

// ---- shaders -----------------------------------------------------------

// Canonical starting state for RD when no seed input is attached.
//
// Pearson's standard init for Gray-Scott: quiescent field (U=1, V=0)
// with a small central disturbance zone (U=0.5, V=0.25). These values
// matter — starting with V=1 saturates the clamp and the reactants
// burn out before the pattern has room to propagate (the "fades to
// black" failure mode). The disturbance is also sprinkled with a
// small pseudo-random per-pixel jitter to break radial symmetry, so
// patterns feel organic instead of concentric rings.
//
// Larger disturbance radius (0.2–0.28) gives the reaction more cells
// to work with before the stable front reaches the edge.
const INIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec2 d = v_uv - vec2(0.5);
  float r = length(d) * 2.0;
  float splat = smoothstep(0.28, 0.20, r);
  // Hash-based per-pixel jitter — small enough to stay in the
  // linearized regime but big enough to break perfect symmetry.
  float h = fract(sin(dot(v_uv, vec2(12.9898, 78.233))) * 43758.5453);
  float u = mix(1.0, 0.5, splat) + (h - 0.5) * 0.02;
  float v = mix(0.0, 0.25, splat) + (h - 0.5) * 0.02;
  outColor = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), 0.0, 1.0);
}`;

// Seed the sim texture from a user-supplied image. Interprets the R
// channel as "disturbance intensity" — bright pixels become strong V
// reactant, and U is displaced where V grows so the field stays near
// mass-conservation (U + V ≈ 1).
//
// Earlier version treated the image literally (R→U, G→V), which broke
// for the common "pipe noise in" case: mid-gray noise sets U=0.5,
// V=0.5 uniformly, which burns U out in a handful of steps and
// dissipates to black before any pattern forms. The intensity-based
// interpretation matches what users expect: "where my seed is bright,
// reaction happens; where it's dark, the field stays quiescent."
const SEED_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_intensity;
out vec4 outColor;
void main() {
  float brightness = texture(u_src, v_uv).r;
  float v = brightness * u_intensity;
  outColor = vec4(clamp(1.0 - v, 0.0, 1.0), clamp(v, 0.0, 1.0), 0.0, 1.0);
}`;

// Gray-Scott single step. 9-point weighted Laplacian (corners 0.05,
// edges 0.20, center -1.0) — standard Pearson-Ellingsworth weights
// that produce smoother patterns than a plain 5-point stencil.
const GS_STEP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
uniform float u_dU;
uniform float u_dV;
uniform float u_feed;
uniform float u_kill;
uniform float u_dt;
out vec4 outColor;

vec2 lap(vec2 uv) {
  vec2 s = vec2(0.0);
  s += texture(u_src, uv + u_invRes * vec2(-1.0,-1.0)).rg * 0.05;
  s += texture(u_src, uv + u_invRes * vec2( 0.0,-1.0)).rg * 0.20;
  s += texture(u_src, uv + u_invRes * vec2( 1.0,-1.0)).rg * 0.05;
  s += texture(u_src, uv + u_invRes * vec2(-1.0, 0.0)).rg * 0.20;
  s += texture(u_src, uv).rg * -1.0;
  s += texture(u_src, uv + u_invRes * vec2( 1.0, 0.0)).rg * 0.20;
  s += texture(u_src, uv + u_invRes * vec2(-1.0, 1.0)).rg * 0.05;
  s += texture(u_src, uv + u_invRes * vec2( 0.0, 1.0)).rg * 0.20;
  s += texture(u_src, uv + u_invRes * vec2( 1.0, 1.0)).rg * 0.05;
  return s;
}

void main() {
  vec2 c = texture(u_src, v_uv).rg;
  vec2 L = lap(v_uv);
  float u = c.r;
  float v = c.g;
  float uvv = u * v * v;
  float du = u_dU * L.r - uvv + u_feed * (1.0 - u);
  float dv = u_dV * L.g + uvv - (u_feed + u_kill) * v;
  float nu = clamp(u + du * u_dt, 0.0, 1.0);
  float nv = clamp(v + dv * u_dt, 0.0, 1.0);
  outColor = vec4(nu, nv, 0.0, 1.0);
}`;

// FitzHugh-Nagumo step. Produces spiral waves / oscillating fronts.
// Values can exceed [0,1] naturally — RGBA16F storage accommodates.
const FN_STEP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
uniform float u_dU;
uniform float u_dV;
uniform float u_alpha;
uniform float u_beta;
uniform float u_gamma;
uniform float u_dt;
out vec4 outColor;

vec2 lap(vec2 uv) {
  vec2 s = vec2(0.0);
  s += texture(u_src, uv + u_invRes * vec2(-1.0,-1.0)).rg * 0.05;
  s += texture(u_src, uv + u_invRes * vec2( 0.0,-1.0)).rg * 0.20;
  s += texture(u_src, uv + u_invRes * vec2( 1.0,-1.0)).rg * 0.05;
  s += texture(u_src, uv + u_invRes * vec2(-1.0, 0.0)).rg * 0.20;
  s += texture(u_src, uv).rg * -1.0;
  s += texture(u_src, uv + u_invRes * vec2( 1.0, 0.0)).rg * 0.20;
  s += texture(u_src, uv + u_invRes * vec2(-1.0, 1.0)).rg * 0.05;
  s += texture(u_src, uv + u_invRes * vec2( 0.0, 1.0)).rg * 0.20;
  s += texture(u_src, uv + u_invRes * vec2( 1.0, 1.0)).rg * 0.05;
  return s;
}

void main() {
  vec2 c = texture(u_src, v_uv).rg;
  vec2 L = lap(v_uv);
  float u = c.r;
  float v = c.g;
  float du = u_dU * L.r + u - u*u*u - v + u_alpha;
  float dv = u_dV * L.g + u_beta * (u - u_gamma * v);
  outColor = vec4(u + du * u_dt, v + dv * u_dt, 0.0, 1.0);
}`;

// Upsample the reduced-res sim into a full-canvas grayscale image.
// Linear filtering on the source texture produces smooth upscales.
const OUTPUT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  float v = texture(u_src, v_uv).g;
  outColor = vec4(v, v, v, 1.0);
}`;

// ---- presets -----------------------------------------------------------

// Gray-Scott feed/kill pairs for the recognizable pattern families,
// plus a couple of FitzHugh-Nagumo parameterizations. Sourced from
// Pearson's classic table — exact numbers differ across references by
// ±0.001 and these are values that produce clean visuals at default
// diffusion rates (dU=1.0, dV=0.5).
type Model = "gray-scott" | "fitzhugh-nagumo";
interface PresetParams {
  model: Model;
  dU: number;
  dV: number;
  dt: number;
  // Gray-Scott
  feed?: number;
  kill?: number;
  // FitzHugh-Nagumo
  alpha?: number;
  beta?: number;
  gamma?: number;
}

const PRESETS: Record<string, PresetParams> = {
  spots:    { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.030, kill: 0.062 },
  stripes:  { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.025, kill: 0.055 },
  maze:     { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.029, kill: 0.057 },
  mitosis:  { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.028, kill: 0.062 },
  worms:    { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.054, kill: 0.063 },
  coral:    { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.0545, kill: 0.062 },
  solitons: { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.030, kill: 0.060 },
  zebra:    { model: "gray-scott", dU: 1.0, dV: 0.5, dt: 1.0, feed: 0.035, kill: 0.060 },
  spirals:  { model: "fitzhugh-nagumo", dU: 1.0, dV: 0.2, dt: 0.08, alpha: 0.1, beta: 0.5, gamma: 2.0 },
};
const PRESET_NAMES = [...Object.keys(PRESETS), "custom"];

// ---- persistent state --------------------------------------------------

interface RDState {
  // Two ping-pong textures at reduced resolution. `readIdx` tells us
  // which is the current source; the other is the destination each
  // step, then they swap.
  a: ImageValue;
  b: ImageValue;
  readIdx: 0 | 1;
  width: number;
  height: number;
  lastTime: number;
  initialized: boolean;
  // For drive-by-input mode: last-seen value of the `time` input
  // scalar. Steps run whenever the new value exceeds this. `-Infinity`
  // as the sentinel for "never received a value yet."
  lastDriver: number;
}

function stateKey(nodeId: string): string {
  return `reaction-diffusion:${nodeId}`;
}

function targetForIdx(state: RDState, idx: 0 | 1): ImageValue {
  return idx === 0 ? state.a : state.b;
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  reqW: number,
  reqH: number
): RDState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as RDState | undefined;
  if (
    existing &&
    existing.width === reqW &&
    existing.height === reqH
  ) {
    return existing;
  }
  if (existing) {
    ctx.releaseTexture(existing.a.texture);
    ctx.releaseTexture(existing.b.texture);
  }
  const a = ctx.allocImage({ width: reqW, height: reqH });
  const b = ctx.allocImage({ width: reqW, height: reqH });
  ctx.clearTarget(a, [1, 0, 0, 1]);
  ctx.clearTarget(b, [1, 0, 0, 1]);
  const state: RDState = {
    a,
    b,
    readIdx: 0,
    width: reqW,
    height: reqH,
    lastTime: ctx.time,
    initialized: false,
    lastDriver: -Infinity,
  };
  ctx.state[key] = state;
  return state;
}

// ---- node definition ---------------------------------------------------

export const reactionDiffusionNode: NodeDefinition = {
  type: "reaction-diffusion",
  name: "Reaction Diffusion",
  category: "effect",
  description:
    "Gray-Scott / FitzHugh-Nagumo reaction-diffusion patterns. Pick a preset, tune step count. Optional seed image sets the initial U/V fields (R → U, G → V); otherwise starts from a central splat.",
  backend: "webgl2",
  // Stateful — the simulation's output depends on accumulated steps,
  // not just current params. Force re-eval each tick by mixing time
  // into the fingerprint.
  stable: false,
  inputs: [{ name: "seed", type: "image", required: false }],
  // When `drive_by_scene_time` is on, expose a scalar `time` input so
  // the user can wire any monotonic source (Scene Time, Accumulator,
  // Math, etc.) to drive the sim. Steps run whenever that input's
  // value has advanced since the last eval.
  resolveInputs(params): InputSocketDef[] {
    const drive = !!params.drive_by_scene_time;
    const base: InputSocketDef[] = [
      { name: "seed", type: "image", required: false },
    ];
    if (drive) {
      base.push({ name: "time", type: "scalar", required: false });
    }
    return base;
  },
  params: [
    {
      name: "preset",
      label: "Preset",
      type: "enum",
      options: PRESET_NAMES,
      default: "coral",
    },
    {
      name: "model",
      label: "Model",
      type: "enum",
      options: ["gray-scott", "fitzhugh-nagumo"],
      default: "gray-scott",
      visibleIf: (p) => p.preset === "custom",
    },
    // Gray-Scott raw params (custom mode only).
    {
      name: "feed",
      label: "Feed",
      type: "scalar",
      min: 0,
      max: 0.1,
      step: 0.0001,
      default: 0.055,
      visibleIf: (p) => p.preset === "custom" && p.model === "gray-scott",
    },
    {
      name: "kill",
      label: "Kill",
      type: "scalar",
      min: 0,
      max: 0.1,
      step: 0.0001,
      default: 0.062,
      visibleIf: (p) => p.preset === "custom" && p.model === "gray-scott",
    },
    // FitzHugh-Nagumo raw params.
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => p.preset === "custom" && p.model === "fitzhugh-nagumo",
    },
    {
      name: "beta",
      label: "Beta",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.preset === "custom" && p.model === "fitzhugh-nagumo",
    },
    {
      name: "gamma",
      label: "Gamma",
      type: "scalar",
      min: 0,
      max: 5,
      step: 0.001,
      default: 2.0,
      visibleIf: (p) => p.preset === "custom" && p.model === "fitzhugh-nagumo",
    },
    // Shared knobs — always visible.
    {
      name: "steps_per_frame",
      label: "Steps / frame",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 60,
      step: 1,
      default: 20,
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
      name: "seed_intensity",
      label: "Seed intensity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "drive_by_scene_time",
      label: "Drive by scene time",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  // Include the node id (so two RD nodes in the same graph don't fight
  // over state) and ctx.time (so each frame re-evaluates).
  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    // Resolve the active parameters from preset (or read raw params
    // when in "custom" mode). Keeps the step shaders agnostic to how
    // the user chose the numbers.
    const presetName = (params.preset as string) ?? "coral";
    let resolved: PresetParams;
    if (presetName !== "custom" && PRESETS[presetName]) {
      resolved = PRESETS[presetName];
    } else {
      const model = (params.model as Model) ?? "gray-scott";
      resolved = {
        model,
        dU: 1.0,
        dV: model === "fitzhugh-nagumo" ? 0.2 : 0.5,
        dt: model === "fitzhugh-nagumo" ? 0.08 : 1.0,
        feed: (params.feed as number) ?? 0.055,
        kill: (params.kill as number) ?? 0.062,
        alpha: (params.alpha as number) ?? 0.1,
        beta: (params.beta as number) ?? 0.5,
        gamma: (params.gamma as number) ?? 2.0,
      };
    }

    // Reduced-resolution internal textures. 4-pixel minimum so the
    // Laplacian stencil doesn't collapse to nonsense.
    const rez = Math.max(0.1, Math.min(1, (params.resolution as number) ?? 0.5));
    const simW = Math.max(4, Math.round(ctx.width * rez));
    const simH = Math.max(4, Math.round(ctx.height * rez));
    const state = ensureState(ctx, nodeId, simW, simH);

    // Reset when: first eval, scene time wrapped back to 0, or the
    // texture dimensions just changed (ensureState handled the realloc
    // already but we still need to re-seed so the field isn't blank).
    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const shouldReset =
      !state.initialized || (wasNonZero && isNearZero);

    if (shouldReset) {
      const target = targetForIdx(state, state.readIdx);
      const seed = inputs.seed;
      if (seed && seed.kind === "image") {
        // Seed the V disturbance field from the input image's brightness.
        // u_intensity scales how "hot" the seed is — 0.4 keeps us in
        // Gray-Scott's stable operating regime; bump higher for more
        // aggressive initial reaction.
        const seedProg = ctx.getShader("rd/seed", SEED_FS);
        const intensity = Math.max(
          0,
          Math.min(1, (params.seed_intensity as number) ?? 0.4)
        );
        ctx.drawFullscreen(seedProg, target, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, seed.texture);
          gl.uniform1i(gl.getUniformLocation(seedProg, "u_src"), 0);
          gl.uniform1f(
            gl.getUniformLocation(seedProg, "u_intensity"),
            intensity
          );
        });
      } else {
        const initProg = ctx.getShader("rd/init", INIT_FS);
        ctx.drawFullscreen(initProg, target);
      }
      state.initialized = true;
      // Re-baseline the driver on reset so the first post-reset eval
      // doesn't see a huge jump (which would burn an unbounded number
      // of steps).
      const resetDriver =
        inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      state.lastDriver = resetDriver;
    }
    state.lastTime = ctx.time;

    // Run N simulation steps. Each step reads from state.readIdx,
    // writes to the other, then swaps. At the end, state.readIdx
    // holds the most recent frame's output.
    //
    // Two gating modes:
    //   - default: ctx.playing — steps only while the timeline is
    //     actively playing. Pausing freezes the sim; scrubbing does
    //     nothing.
    //   - drive_by_scene_time: use the connected `time` scalar input
    //     as the driver. Steps run whenever the input's value exceeds
    //     the last-seen value. Wire Scene Time for playback-tied
    //     evolution, an Accumulator for user-paced control, or any
    //     other monotonic scalar source to pump the sim.
    const driveByTime = !!params.drive_by_scene_time;
    let active: boolean;
    if (driveByTime) {
      const driver =
        inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      active = driver > state.lastDriver + 1e-6;
      state.lastDriver = driver;
    } else {
      active = ctx.playing;
    }
    const steps = active
      ? Math.max(1, Math.floor((params.steps_per_frame as number) ?? 20))
      : 0;
    const isGS = resolved.model === "gray-scott";
    const stepProg = isGS
      ? ctx.getShader("rd/gray-scott", GS_STEP_FS)
      : ctx.getShader("rd/fitzhugh-nagumo", FN_STEP_FS);

    for (let i = 0; i < steps; i++) {
      const src = targetForIdx(state, state.readIdx);
      const dst = targetForIdx(state, (state.readIdx ^ 1) as 0 | 1);
      ctx.drawFullscreen(stepProg, dst, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(stepProg, "u_src"), 0);
        gl.uniform2f(
          gl.getUniformLocation(stepProg, "u_invRes"),
          1 / simW,
          1 / simH
        );
        gl.uniform1f(gl.getUniformLocation(stepProg, "u_dU"), resolved.dU);
        gl.uniform1f(gl.getUniformLocation(stepProg, "u_dV"), resolved.dV);
        gl.uniform1f(gl.getUniformLocation(stepProg, "u_dt"), resolved.dt);
        if (isGS) {
          gl.uniform1f(
            gl.getUniformLocation(stepProg, "u_feed"),
            resolved.feed ?? 0.055
          );
          gl.uniform1f(
            gl.getUniformLocation(stepProg, "u_kill"),
            resolved.kill ?? 0.062
          );
        } else {
          gl.uniform1f(
            gl.getUniformLocation(stepProg, "u_alpha"),
            resolved.alpha ?? 0.1
          );
          gl.uniform1f(
            gl.getUniformLocation(stepProg, "u_beta"),
            resolved.beta ?? 0.5
          );
          gl.uniform1f(
            gl.getUniformLocation(stepProg, "u_gamma"),
            resolved.gamma ?? 2.0
          );
        }
      });
      state.readIdx = (state.readIdx ^ 1) as 0 | 1;
    }

    // Upsample the V channel to full canvas as grayscale.
    const output = ctx.allocImage();
    const outProg = ctx.getShader("rd/output", OUTPUT_FS);
    const read = targetForIdx(state, state.readIdx);
    ctx.drawFullscreen(outProg, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, read.texture);
      gl.uniform1i(gl.getUniformLocation(outProg, "u_src"), 0);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as RDState | undefined;
    if (s) {
      ctx.releaseTexture(s.a.texture);
      ctx.releaseTexture(s.b.texture);
    }
    delete ctx.state[key];
  },
};
