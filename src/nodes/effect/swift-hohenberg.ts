import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";

// Swift–Hohenberg node. Self-iterating pattern-forming PDE on a reduced-
// resolution ping-pong grid:
//
//   ∂u/∂t = εu − (k₀² + ∇²)² u + g₂ u² − g₃ u³
//
// k₀ = 2π / λ_texels selects a preferred wavelength; g₂ = 0 preserves
// ±u symmetry (labyrinthine stripes / rolls) and g₂ ≠ 0 breaks it into
// hexagons or spots. The biharmonic is Laplacian-of-Laplacian via a
// two-pass 9-point Mehrstellen stencil in texel units (square pixels,
// so patterns stay isotropic on a non-square canvas).
//
// The internal grid is sized from wavelength so one period is ~8 texels
// at resolution=0.5. That keeps k₀ = O(1) and the k=0 mode damped
// (ε < k₀⁴). A canvas-fraction grid with a long λ makes k₀ ≪ 1, the
// zero mode grows as fast as the pattern, and the field washes out.
//
// On scene-time=0 (or first eval after reset), the field re-seeds: from
// the `seed` input if connected (luma → signed u), otherwise from hash
// noise. Output is grayscale of the signed field. Pipe through Color
// Ramp for colorization; same philosophy as Reaction Diffusion.

// ---- shaders -----------------------------------------------------------

export const SH_INIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_amp;
uniform float u_seed;
out vec4 outColor;
void main() {
  float h = fract(sin(dot(v_uv, vec2(12.9898, 78.233)) + u_seed) * 43758.5453);
  float u = (h - 0.5) * 2.0 * u_amp;
  outColor = vec4(u, 0.0, 0.0, 1.0);
}`;

// Seed image: luma mapped through (luma − 0.5) × 2 × intensity onto the
// signed field. Mid-grey is the quiescent u=0 state; bright/dark become
// the two wells. Matches "pipe noise in" the way users expect.
export const SH_SEED_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_intensity;
out vec4 outColor;
void main() {
  vec3 rgb = texture(u_src, v_uv).rgb;
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  float u = (luma - 0.5) * 2.0 * u_intensity;
  outColor = vec4(u, 0.0, 0.0, 1.0);
}`;

// 9-point Mehrstellen Laplacian, h = 1 texel. Writes u in R (copy) and
// ∇²u in G so the step pass can take ∇⁴u = ∇²(∇²u) with the same stencil.
export const SH_LAP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
out vec4 outColor;

float samp(vec2 uv) {
  return texture(u_src, uv).r;
}

void main() {
  // gl_FragCoord is the texel center; v_uv sits on the texel corner and
  // NEAREST-samples the boundary (the engine fullscreen triangle).
  vec2 uv = gl_FragCoord.xy * u_invRes;
  float c  = samp(uv);
  float n  = samp(uv + u_invRes * vec2( 0.0,  1.0));
  float s  = samp(uv + u_invRes * vec2( 0.0, -1.0));
  float e  = samp(uv + u_invRes * vec2( 1.0,  0.0));
  float w  = samp(uv + u_invRes * vec2(-1.0,  0.0));
  float ne = samp(uv + u_invRes * vec2( 1.0,  1.0));
  float nw = samp(uv + u_invRes * vec2(-1.0,  1.0));
  float se = samp(uv + u_invRes * vec2( 1.0, -1.0));
  float sw = samp(uv + u_invRes * vec2(-1.0, -1.0));
  float lap = (4.0 * (n + s + e + w) + (ne + nw + se + sw) - 20.0 * c) / 6.0;
  outColor = vec4(c, lap, 0.0, 1.0);
}`;

export const SH_STEP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
uniform float u_k0sq;
uniform float u_eps;
uniform float u_g2;
uniform float u_g3;
uniform float u_dt;
out vec4 outColor;

vec2 samp(vec2 uv) {
  return texture(u_src, uv).rg;
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_invRes;
  vec2 c  = samp(uv);
  vec2 n  = samp(uv + u_invRes * vec2( 0.0,  1.0));
  vec2 s  = samp(uv + u_invRes * vec2( 0.0, -1.0));
  vec2 e  = samp(uv + u_invRes * vec2( 1.0,  0.0));
  vec2 w  = samp(uv + u_invRes * vec2(-1.0,  0.0));
  vec2 ne = samp(uv + u_invRes * vec2( 1.0,  1.0));
  vec2 nw = samp(uv + u_invRes * vec2(-1.0,  1.0));
  vec2 se = samp(uv + u_invRes * vec2( 1.0, -1.0));
  vec2 sw = samp(uv + u_invRes * vec2(-1.0, -1.0));
  float u = c.r;
  float L = c.g;
  float biharm = (4.0 * (n.g + s.g + e.g + w.g) + (ne.g + nw.g + se.g + sw.g) - 20.0 * L) / 6.0;
  float k2 = u_k0sq;
  float linear = u_eps * u - (k2 * k2 * u + 2.0 * k2 * L + biharm);
  float nonlin = u_g2 * u * u - u_g3 * u * u * u;
  float nu = clamp(u + u_dt * (linear + nonlin), -4.0, 4.0);
  outColor = vec4(nu, 0.0, 0.0, 1.0);
}`;

export const SH_OUTPUT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_contrast;
out vec4 outColor;
void main() {
  float u = texture(u_src, v_uv).r;
  // tanh keeps a shifted hexagon mean (u ~ 0.5–1) from clipping to white
  // so the lattice still reads; contrast scales the argument, not a linear gain.
  float g = 0.5 + 0.5 * tanh(u * u_contrast);
  outColor = vec4(g, g, g, 1.0);
}`;

// ---- presets -----------------------------------------------------------

interface PresetParams {
  eps: number;
  g2: number;
  g3: number;
  dt: number;
}

const PRESETS: Record<string, PresetParams> = {
  // g₂ = 0 keeps ±u symmetry → labyrinthine stripes / rolls.
  labyrinth: { eps: 0.3, g2: 0.0, g3: 1.0, dt: 0.03 },
  // Quadratic term breaks the symmetry into a hexagonal lattice.
  hexagons: { eps: 0.3, g2: 0.35, g3: 1.0, dt: 0.03 },
  // Stronger quadratic, weaker ε → isolated spots rather than a packed lattice.
  spots: { eps: 0.2, g2: 0.6, g3: 1.0, dt: 0.03 },
};
const PRESET_NAMES = [...Object.keys(PRESETS), "custom"];

// ---- persistent state --------------------------------------------------

interface SHState {
  a: ImageValue;
  b: ImageValue;
  readIdx: 0 | 1;
  width: number;
  height: number;
  lastTime: number;
  initialized: boolean;
  lastDriver: number;
}

function stateKey(nodeId: string): string {
  return `swift-hohenberg:${nodeId}`;
}

function targetForIdx(state: SHState, idx: 0 | 1): ImageValue {
  return idx === 0 ? state.a : state.b;
}

function configureSimTex(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  periodic: boolean
) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const wrap = periodic ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  reqW: number,
  reqH: number
): SHState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as SHState | undefined;
  if (existing && existing.width === reqW && existing.height === reqH) {
    return existing;
  }
  if (existing) {
    ctx.releaseTexture(existing.a.texture);
    ctx.releaseTexture(existing.b.texture);
  }
  const a = ctx.allocImage({ width: reqW, height: reqH });
  const b = ctx.allocImage({ width: reqW, height: reqH });
  ctx.clearTarget(a, [0, 0, 0, 1]);
  ctx.clearTarget(b, [0, 0, 0, 1]);
  const state: SHState = {
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

let warnedNoFloat = false;

// ---- node definition ---------------------------------------------------

export const swiftHohenbergNode: NodeDefinition = {
  type: "swift-hohenberg",
  name: "Swift-Hohenberg",
  category: "image",
  subcategory: "modifier",
  description:
    "Swift–Hohenberg pattern formation (labyrinthine stripes, hexagons, spots). Pick a preset, tune wavelength; optional seed image sets the initial signed field.",
  searchAliases: [
    "pattern formation",
    "hohenberg",
    "rolls",
    "hexagon",
    "stripes",
    "SH",
  ],
  facts: {
    space: { "param:wavelength": "canvas01" },
    reads: ["time"],
    gotchas: [
      "wavelength is the pattern period as a canvas-width fraction; the sim grid is sized so one period is ~8 texels at resolution=0.5 (resolution scales texels-per-wave, not canvas size).",
      "Steps run while ctx.playing or (ctx.offline and time advanced); pause/scrub freezes unless drive_by_scene_time, which steps when the wired time input increases.",
      "Resets the field (seed image or hash noise) on first eval or when scene time wraps back near 0.",
      "preset != custom ignores epsilon/quadratic/cubic/dt.",
      "Seed image stores (luma-0.5)*2*seed_intensity as the signed field; unwired, init is hash noise in ±seed_intensity.",
      "Output is 0.5+0.5*tanh(u*contrast) of the signed field; quadratic=0 gives stripes/rolls, nonzero quadratic breaks ±u symmetry into hexagons/spots.",
      "periodic=true (default) sets REPEAT wrap so patterns tile; periodic=false clamps and tends to pin rolls to the frame edges.",
    ],
  },
  backend: "webgl2",
  stable: false,
  simulation: true,
  inputs: [{ name: "seed", type: "image", required: false }],
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
      default: "hexagons",
    },
    {
      name: "epsilon",
      label: "Epsilon",
      type: "scalar",
      min: 0,
      max: 1.5,
      step: 0.01,
      default: 0.3,
      visibleIf: (p) => p.preset === "custom",
    },
    {
      name: "quadratic",
      label: "Quadratic",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0.35,
      visibleIf: (p) => p.preset === "custom",
    },
    {
      name: "cubic",
      label: "Cubic",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.preset === "custom",
    },
    {
      name: "dt",
      label: "Time step",
      type: "scalar",
      min: 0.001,
      max: 0.2,
      step: 0.001,
      default: 0.03,
      visibleIf: (p) => p.preset === "custom",
    },
    {
      name: "wavelength",
      label: "Wavelength",
      type: "scalar",
      min: 0.01,
      max: 0.25,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "steps_per_frame",
      label: "Steps / frame",
      type: "scalar",
      min: 1,
      max: 80,
      softMax: 32,
      step: 1,
      default: 16,
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
      default: 0.15,
    },
    {
      name: "init_seed",
      label: "Init seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
    {
      name: "contrast",
      label: "Contrast",
      type: "scalar",
      min: 0.05,
      max: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "periodic",
      label: "Periodic",
      type: "boolean",
      default: true,
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

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const gl = ctx.gl;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      if (!warnedNoFloat) {
        console.warn(
          "swift-hohenberg: EXT_color_buffer_float unavailable — simulation disabled."
        );
        warnedNoFloat = true;
      }
      const blank = ctx.allocImage();
      ctx.clearTarget(blank, [0.5, 0.5, 0.5, 1]);
      return { primary: blank };
    }

    const presetName = (params.preset as string) ?? "hexagons";
    let resolved: PresetParams;
    if (presetName !== "custom" && PRESETS[presetName]) {
      resolved = PRESETS[presetName];
    } else {
      resolved = {
        eps: (params.epsilon as number) ?? 0.3,
        g2: (params.quadratic as number) ?? 0.35,
        g3: (params.cubic as number) ?? 1,
        dt: (params.dt as number) ?? 0.03,
      };
    }

    const rez = Math.max(0.1, Math.min(1, (params.resolution as number) ?? 0.5));
    const wavelength = Math.max(
      0.01,
      Math.min(0.25, (params.wavelength as number) ?? 0.05)
    );
    // ~8 texels/wave at resolution=0.5 keeps k₀ ~ 0.8 so ε < k₀⁴ and
    // the mean does not run away. Grid size tracks wavelength: fewer
    // waves (larger wavelength) → smaller sim, then upsample.
    const texelsPerWave = Math.max(6, Math.round(16 * rez));
    const simW = Math.max(
      32,
      Math.min(ctx.width, Math.round(texelsPerWave / wavelength))
    );
    const simH = Math.max(
      32,
      Math.min(
        ctx.height,
        Math.round((simW * ctx.height) / Math.max(1, ctx.width))
      )
    );
    const state = ensureState(ctx, nodeId, simW, simH);
    const periodic = params.periodic !== false;
    configureSimTex(gl, state.a.texture, periodic);
    configureSimTex(gl, state.b.texture, periodic);

    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const shouldReset = !state.initialized || (wasNonZero && isNearZero);

    if (shouldReset) {
      const target = targetForIdx(state, state.readIdx);
      const seed = inputs.seed;
      const intensity = Math.max(
        0,
        Math.min(1, (params.seed_intensity as number) ?? 0.15)
      );
      if (seed && seed.kind === "image") {
        const seedProg = ctx.getShader("sh/seed", SH_SEED_FS);
        ctx.drawFullscreen(seedProg, target, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, seed.texture);
          g.uniform1i(g.getUniformLocation(seedProg, "u_src"), 0);
          g.uniform1f(
            g.getUniformLocation(seedProg, "u_intensity"),
            intensity
          );
        });
      } else {
        const initProg = ctx.getShader("sh/init", SH_INIT_FS);
        const initSeed = (params.init_seed as number) ?? 0;
        ctx.drawFullscreen(initProg, target, (g) => {
          g.uniform1f(g.getUniformLocation(initProg, "u_amp"), intensity);
          g.uniform1f(g.getUniformLocation(initProg, "u_seed"), initSeed);
        });
      }
      state.initialized = true;
      const resetDriver =
        inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      state.lastDriver = resetDriver;
    }

    const driveByTime = !!params.drive_by_scene_time;
    let active: boolean;
    if (driveByTime) {
      const driver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      active = driver > state.lastDriver + 1e-6;
      state.lastDriver = driver;
    } else {
      active =
        ctx.playing || (ctx.offline && ctx.time > state.lastTime + 1e-6);
    }
    state.lastTime = ctx.time;

    const steps = active
      ? Math.max(1, Math.floor((params.steps_per_frame as number) ?? 16))
      : 0;

    // λ in texels; floor at 6 so k₀ stays O(1) even if the grid clamp
    // squeezed the requested period below a few samples.
    const lambdaTexels = Math.max(6, wavelength * simW);
    const k0 = (Math.PI * 2) / lambdaTexels;
    const k0sq = k0 * k0;
    const dt = Math.max(0.001, Math.min(0.2, resolved.dt));

    const lapProg = ctx.getShader("sh/lap-fc", SH_LAP_FS);
    const stepProg = ctx.getShader("sh/step-fc", SH_STEP_FS);
    const invW = 1 / simW;
    const invH = 1 / simH;

    for (let i = 0; i < steps; i++) {
      const src = targetForIdx(state, state.readIdx);
      const tmp = targetForIdx(state, (state.readIdx ^ 1) as 0 | 1);
      ctx.drawFullscreen(lapProg, tmp, (g) => {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, src.texture);
        g.uniform1i(g.getUniformLocation(lapProg, "u_src"), 0);
        g.uniform2f(g.getUniformLocation(lapProg, "u_invRes"), invW, invH);
      });
      ctx.drawFullscreen(stepProg, src, (g) => {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, tmp.texture);
        g.uniform1i(g.getUniformLocation(stepProg, "u_src"), 0);
        g.uniform2f(g.getUniformLocation(stepProg, "u_invRes"), invW, invH);
        g.uniform1f(g.getUniformLocation(stepProg, "u_k0sq"), k0sq);
        g.uniform1f(g.getUniformLocation(stepProg, "u_eps"), resolved.eps);
        g.uniform1f(g.getUniformLocation(stepProg, "u_g2"), resolved.g2);
        g.uniform1f(g.getUniformLocation(stepProg, "u_g3"), resolved.g3);
        g.uniform1f(g.getUniformLocation(stepProg, "u_dt"), dt);
      });
    }

    const output = ctx.allocImage();
    const outProg = ctx.getShader("sh/output-tanh", SH_OUTPUT_FS);
    const read = targetForIdx(state, state.readIdx);
    const contrast = Math.max(
      0.05,
      Math.min(2, (params.contrast as number) ?? 1)
    );
    // Linear filter only for the upsample so a reduced-res sim doesn't
    // present as blocky; the sim passes themselves sample NEAREST.
    gl.bindTexture(gl.TEXTURE_2D, read.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    ctx.drawFullscreen(outProg, output, (g) => {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, read.texture);
      g.uniform1i(g.getUniformLocation(outProg, "u_src"), 0);
      g.uniform1f(g.getUniformLocation(outProg, "u_contrast"), contrast);
    });
    configureSimTex(gl, read.texture, periodic);

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as SHState | undefined;
    if (s) {
      ctx.releaseTexture(s.a.texture);
      ctx.releaseTexture(s.b.texture);
    }
    delete ctx.state[key];
  },
};
