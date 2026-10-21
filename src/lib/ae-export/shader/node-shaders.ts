// Single-node shader regions: a node whose image the engine draws in ONE
// fullscreen pass of its own fragment shader runs in the Toolbox Shader host
// as that very shader — no fused GLSL Expression, no "Convert with Claude"
// step (results: specdocs/ae-m4/single-node-shaders.md).
//
// Per node type, NODE_SHADERS says how compute() feeds its shader, so the
// host can feed it the same way from AE controls:
//
//   node      the definition (params: names, labels, kinds, ranges)
//   fs        the fragment source compute() hands ctx.getShader
//   controls  the params that become host controls, named and labelled after
//             the params: scalar → slider, boolean → checkbox, color →
//             color. `when` drops one the baked state never reads.
//   uniforms  EVERY uniform the source declares (bundleFromNodeShader
//             refuses one without a rule, so a new uniform can't drift in
//             silently) → a GLSL expression evaluated at the top of main(),
//             over `$param` (a control, or the param's current value as a
//             literal when it is not one) and the host clock (u_res,
//             u_time, u_frame, u_aspect). An expression that reads neither
//             is a constant: enum params and wiring are baked that way (the
//             host has no popups). `{ input }` maps a sampler to the node
//             input it reads: wired → an image slot a–d, unwired → the
//             engine's 1×1 transparent placeholder.
//   helpers   GLSL ports of the JS compute() evaluates per frame.
//   bakes     params read only through constants: keyed or wired → the
//             region bakes (scene/shader.ts says why).
//   ignores   params compute() doesn't feed the image's shader (the
//             universal opacity — the AE layer's Opacity — and aux-only
//             params). Every param is a control, a bake or ignored: the gate
//             fails on one that is none, so a new param gets classified.
//
// Every rule mirrors compute() line for line; check-shader-nodes runs the
// real compute() on a recording GL and renders both sides (WebGL2 vs Metal).

import type { NodeDefinition } from "@/engine/types";
import { NOISE_FS, noiseTypeToInt, perlinNoiseNode } from "@/nodes/source/perlin-noise";

export interface NodeShaderEnv {
  // The node's params (defaults filled in) at their current values.
  params: Record<string, unknown>;
  // Wired input sockets → what arrives: an image (texture) or a value.
  inputs: Record<string, "image" | "value">;
}

export type NodeShaderRule = string | ((env: NodeShaderEnv) => string) | { input: string };

export interface NodeShaderControl {
  param: string;
  when?: (env: NodeShaderEnv) => boolean;
}

export interface NodeShaderSpec {
  node: NodeDefinition;
  fs: (env: NodeShaderEnv) => string;
  controls: (string | NodeShaderControl)[];
  uniforms: Record<string, NodeShaderRule>;
  helpers?: string;
  bakes?: string[];
  ignores?: string[];
  // A state the host can't run yet (the region bakes with this reason).
  refuse?: (env: NodeShaderEnv) => string | null;
}

export const glslFloat = (x: number): string => {
  const v = Number.isFinite(x) ? x : 0;
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};
export const glslInt = (x: number): string => String(Math.trunc(x));

const typeOf = (e: NodeShaderEnv) => String(e.params.type ?? "simplex");

// ---- Noise (src/nodes/source/perlin-noise.ts) --------------------------------------
// compute() → NOISE_FS, uniform for uniform. `type` is baked (u_type and
// the per-type branches below), so each type ships only the controls its
// branch reads. Animated evolution walks loopEvolutionOffset /
// loopEvolutionPhase (engine/noise.ts) — ported here against u_frame, the
// host's frame of the layer's own clock, as compute() uses ctx.tick / tpf.
const NOISE: NodeShaderSpec = {
  node: perlinNoiseNode,
  fs: () => NOISE_FS,
  controls: [
    "scale",
    "octaves",
    "persistence",
    "lacunarity",
    "offset_x",
    "offset_y",
    "seed",
    "w",
    "animated",
    "anim_start",
    "anim_end",
    "anim_rate",
    "contrast",
    { param: "flow_time", when: (e) => typeOf(e) === "flow" },
    { param: "phasor_frequency", when: (e) => typeOf(e) === "phasor" },
    { param: "phasor_orientation", when: (e) => typeOf(e) === "phasor" },
    { param: "phasor_isotropy", when: (e) => typeOf(e) === "phasor" },
    { param: "color_a", when: (e) => typeOf(e) !== "curl" },
    { param: "color_b", when: (e) => typeOf(e) !== "curl" },
    "alpha",
  ],
  uniforms: {
    u_type: (e) => glslInt(noiseTypeToInt(typeOf(e))),
    u_scale: "$scale",
    u_octaves: "int(clamp(floor($octaves + 0.5), 1.0, 8.0))",
    u_persistence: "$persistence",
    u_lacunarity: "$lacunarity",
    u_offset: "vec2($offset_x, $offset_y)",
    u_seed: "$seed",
    u_contrast: "$contrast",
    u_colorA: "$color_a.rgb",
    u_colorB: "$color_b.rgb",
    u_alpha: "$alpha",
    u_flowTime: (e) =>
      typeOf(e) === "flow" ? "$animated ? loopEvolutionPhase(u_frame, $anim_start, $anim_end) * 6.283185307179586 : $flow_time" : "$flow_time",
    u_phasorFreq: "$phasor_frequency",
    u_phasorOrient: "$phasor_orientation * 0.017453292519943295",
    u_phasorIsotropy: "$phasor_isotropy",
    u_w: "$animated ? 0.0 : $w",
    u_animOffset: (e) =>
      typeOf(e) === "flow" ? "vec2(0.0)" : "$animated ? loopEvolutionOffset(u_frame, $anim_start, $anim_end, $anim_rate) : vec2(0.0)",
    u_hasUvIn: (e) => (e.inputs.uv_in === "image" ? "1" : "0"),
    u_uvIn: { input: "uv_in" },
    u_uvConst: "vec2(0.0)",
    u_canvasSize: "u_res",
  },
  helpers: `// engine/noise.ts loopEvolutionPhase / loopEvolutionOffset.
float loopEvolutionPhase(float frameNow, float start, float end) {
  float period = end - start;
  if (period <= 0.0) return 0.0;
  return fract((frameNow - start) / period);
}
vec2 loopEvolutionOffset(float frameNow, float start, float end, float rate) {
  if (rate == 0.0 || end - start <= 0.0) return vec2(0.0);
  float theta = loopEvolutionPhase(frameNow, start, end) * 6.283185307179586;
  return vec2(rate * cos(theta), rate * sin(theta));
}`,
  bakes: ["type"],
  ignores: ["opacity", "field_lo", "field_hi"],
  refuse: (e) => (e.inputs.uv_in === "value" ? "a value wired into UV (the constant-UV mode) has no host form yet" : null),
};

export const NODE_SHADERS: Record<string, NodeShaderSpec> = {
  noise: NOISE,
};

export function nodeShaderSpec(type: string | undefined): NodeShaderSpec | undefined {
  return type ? NODE_SHADERS[type] : undefined;
}
