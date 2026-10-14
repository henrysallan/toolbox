import "@/engine/skia/library/helpers-noise";
import { bindStatic, type Bind } from "@/engine/skia/scene-ir";
import { mirrorParams, type SkslLibFunctionDef, type SkslLibParam } from "@/engine/skia/library";
import { perlinNoiseNode } from "../source/perlin-noise";
import { defineSkslVariantNode, type SkslVariant } from "./sksl-variants";

// Noise (Skia) — the Skia-layer port of Noise (specdocs/101326_skia-target.md
// §3.2), all eleven NOISE_FS algorithms plus the looping evolution. The math
// is NOISE_FS line for line: the same aspect-corrected sample point, seed
// offset, fBm, W slice blend, contrast and curl packing, with only Skia's
// ES2 rules applied (a float octave count against a constant loop bound).
// The algorithms themselves are shared helpers
// (engine/skia/library/helpers-noise.ts; simplex in helpers.ts).
//
// One library function per (type × animated × uv wired) — see
// sksl-variants.ts for why the type is not a uniform. The default,
// `tbx.noise.simplex@1`, is the Wave 1 reference port unchanged.
//
// animated=true: Noise derives the loop from the frame (ctx.tick /
// ticksPerFrame). Here the frame is `iTime × fps`, computed in the shader:
// iTime is the master clock in seconds on both sides (the fuser binds it to
// ctx.time = tick / (ticksPerFrame × fps); the exporter drives it from the
// device clock), and `fps` is a static uniform from the project timeline.
// So an exported loop plays, scrubs and closes on the device clock with no
// per-frame uniform — binding the computed offset instead would make the
// exporter sample it every frame (scene-plan.ts: an untagged moving value).
// fp32 iTime × fps strays from the true frame by ~6e-8 relative (2e-4
// frames a minute into the timeline), far below a visible change in the
// circle offset.

const TYPES = perlinNoiseNode.params.find((p) => p.name === "type")!.options as readonly string[];

interface Algo {
  // Entry suffix — none is a prefix of another (gather copies rename by
  // entry prefix; keep the namespace clean even though noise has none).
  slug: string;
  helper: string;
  // The noise at `p` inside the fBm loop.
  sample: (p: string) => string;
  // Params beyond the shared frame (static / looping variant).
  extra: string[];
  extraLoop: string[];
  // Extra fBm arguments: signature, and how the entry passes them.
  fbmSig: string;
  fbmArgs: string;
  fbmArgsLoop: string;
  // Relative cost of one call (one simplex octave ≈ 1) × 4 octaves.
  cost: number;
}

const PHASOR = ["phasor_frequency", "phasor_orientation", "phasor_isotropy"];
const ALGOS: Record<string, Algo> = {
  perlin: plain("perlin", "tbx.noise.perlin2d", (p) => `tbx_noise2_perlin(${p})`, 4),
  simplex: plain("simplex", "tbx.noise.simplex2d", (p) => `tbx_snoise2(${p})`, 4),
  value: plain("value", "tbx.noise.value2d", (p) => `tbx_noise2_value(${p})`, 3),
  opensimplex: plain("opensimplex", "tbx.noise.opensimplex2d", (p) => `tbx_noise2_os(${p})`, 4),
  opensimplex2: plain("os2f", "tbx.noise.os2f2d", (p) => `tbx_noise2_os2f(${p})`, 5),
  opensimplex2s: plain("os2s", "tbx.noise.os2s2d", (p) => `tbx_noise2_os2s(${p})`, 6),
  "super-simplex": plain("supersimplex", "tbx.noise.ss2d", (p) => `tbx_noise2_ss(${p})`, 6),
  "perlin-deriv": plain("deriv", "tbx.noise.deriv2d", (p) => `tbx_noise2_deriv(${p}).x`, 5),
  flow: {
    slug: "flow",
    helper: "tbx.noise.flow2d",
    sample: (p) => `tbx_noise2_flow(${p}, ft)`,
    extra: ["flow_time"],
    extraLoop: [],
    fbmSig: ", float ft",
    fbmArgs: ", flow_time",
    fbmArgsLoop: ", theta",
    cost: 5,
  },
  curl: plain("curl", "tbx.noise.deriv2d", () => "", 5),
  phasor: {
    slug: "phasor",
    helper: "tbx.noise.phasor2d",
    sample: (p) => `tbx_noise2_phasor(${p}, pf, po, pi)`,
    extra: PHASOR,
    extraLoop: PHASOR,
    fbmSig: ", float pf, float po, float pi",
    fbmArgs: ", phasor_frequency, phasor_orientation, phasor_isotropy",
    fbmArgsLoop: ", phasor_frequency, phasor_orientation, phasor_isotropy",
    // Nine Gabor kernels (cos, sin, exp each) per octave.
    cost: 16,
  },
};

function plain(slug: string, helper: string, sample: (p: string) => string, cost: number): Algo {
  return { slug, helper, sample, extra: [], extraLoop: [], fbmSig: "", fbmArgs: "", fbmArgsLoop: "", cost };
}

const decl = (names: string[]) => names.map((n) => `float ${n}`).join(", ");

function noiseFunction(type: string, loop: boolean, uv: boolean): SkslLibFunctionDef {
  const a = ALGOS[type];
  const curl = type === "curl";
  const entry = `tbx_noise${loop ? "loop" : ""}${uv ? "uv" : ""}_${a.slug}`;
  const fbm = `${entry}_fbm`;
  const extra = loop ? a.extraLoop : a.extra;
  const args = loop ? a.fbmArgsLoop : a.fbmArgs;
  const scalars = [
    "scale", "octaves", "persistence", "lacunarity", "offset_x", "offset_y", "seed",
    ...(loop ? ["anim_start", "anim_end", "anim_rate", "fps"] : ["w"]),
    "contrast",
    ...extra,
  ];
  const colors = curl ? [] : ["color_a", "color_b"];
  const params: SkslLibParam[] = [
    ...scalars.map((name) => ({ name, type: "float" as const })),
    ...colors.map((name) => ({ name, type: "color" as const })),
    { name: "alpha", type: "float" },
    { name: "opacity", type: "float" },
  ];
  const sig = [
    "float2 uv",
    "float2 res",
    decl(scalars),
    ...colors.map((c) => `float4 ${c}`),
    "float alpha",
    "float opacity",
    ...(uv ? ["float4 uv_in"] : []),
  ].join(", ");
  const T = curl ? "float2" : "float";

  const fbmSource = curl
    ? `float2 ${fbm}(float2 p, float octaves, float persistence, float lacunarity) {
  // 2D curl of the Perlin stream function: v = (∂ψ/∂y, −∂ψ/∂x).
  float2 total = float2(0.0);
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    float3 d = tbx_noise2_deriv(p * freq);
    total += float2(d.z, -d.y) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}`
    : `float ${fbm}(float2 p, float octaves, float persistence, float lacunarity${a.fbmSig}) {
  float total = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    total += ${a.sample("p * freq")} * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}`;

  const evolve = loop
    ? `  // Looping evolution (engine/noise.ts loopEvolutionPhase / Offset), from
  // the shader clock: frame = iTime × fps. W is 0 while looping.
  float theta = tbx_noise2_loop_phase(iTime * fps, anim_start, anim_end) * 6.283185307179586;
${
  type === "flow"
    ? `  // Flow sweeps flow_time through one full turn instead of moving p.
  p += float2(offset_x, offset_y) + seedOffset;`
    : `  float2 animOffset = anim_end - anim_start <= 0.0 ? float2(0.0) : anim_rate * float2(cos(theta), sin(theta));
  p += float2(offset_x, offset_y) + seedOffset + animOffset;`
}
  ${T} n = ${fbm}(p, oct, persistence, lacunarity${args});`
    : `  p += float2(offset_x, offset_y) + seedOffset;
  // W slice blend: smoothstep between hashed integer slices.
  float wi = floor(w);
  float wf = w - wi;
  wf = wf * wf * (3.0 - 2.0 * wf);
  float2 o0 = tbx_noise_slice_offset(wi);
  ${T} n;
  if (wf == 0.0) {
    n = ${fbm}(p + o0, oct, persistence, lacunarity${args});
  } else {
    float2 o1 = tbx_noise_slice_offset(wi + 1.0);
    n = mix(${fbm}(p + o0, oct, persistence, lacunarity${args}),
            ${fbm}(p + o1, oct, persistence, lacunarity${args}), wf);
  }`;

  const finish = curl
    ? `  // Signed curl vector packed 0.5-centred in RG (what Displace reads).
  n = clamp(n * contrast, -1.0, 1.0);
  return float4(n * 0.5 + 0.5, 0.0, alpha * opacity);`
    : `  float t = n * 0.5 + 0.5;
  t = clamp(0.5 + (t - 0.5) * contrast, 0.0, 1.0);
  return float4(mix(color_a.rgb, color_b.rgb, t), alpha * opacity);`;

  const source = `${fbmSource}

float4 ${entry}(${sig}) {
  // The GL node rounds octaves to an int in 1..8 (Math.round = floor(x + 0.5)).
  float oct = clamp(floor(octaves + 0.5), 1.0, 8.0);
  float2 seedOffset = float2(seed * 127.1, seed * 311.7);
  // Aspect-correct so cells stay square: scale counts cells across the width.
  float aspect = res.x / res.y;
  float2 p = (${uv ? "uv_in.rg" : "uv"} - 0.5) * scale;
  p.y /= aspect;
${evolve}
${finish}
}`;

  return {
    id: `tbx.noise.${a.slug}${loop ? ".loop" : ""}${uv ? ".uv" : ""}@1`,
    entry,
    source,
    params,
    inputs: uv ? [{ name: "uv_in", mode: "pure" }] : [],
    uses: [a.helper, loop ? "tbx.noise.loop" : "tbx.noise.slice"],
    cost: a.cost,
    ...(loop ? { usesTime: true } : {}),
  };
}

const variantKey = (type: string, loop: boolean, uv: boolean) => `${type}${loop ? ".loop" : ""}${uv ? ".uv" : ""}`;
const UV_SOCKET = { name: "uv_in", label: "UV" };

// Simplex first: variant 0 is the default the factory registers as the node.
const ORDER = ["simplex", ...TYPES.filter((t) => t !== "simplex")];
const variants: SkslVariant[] = ORDER.flatMap((type) =>
  [false, true].flatMap((loop) =>
    [false, true].map((uv) => ({
      key: variantKey(type, loop, uv),
      fn: noiseFunction(type, loop, uv),
      ...(uv ? { inputs: [UV_SOCKET] } : {}),
      binds: ({ params, nodeId, ctx }) => {
        const out: Record<string, Bind<number | number[]>> = {};
        if (loop) out.fps = bindStatic(ctx.fps);
        if (type === "phasor") {
          // Degrees in the param, radians in the shader (NOISE_FS's
          // u_phasorOrient): a scaled ref, so a track exports scaled.
          const deg = typeof params.phasor_orientation === "number" ? params.phasor_orientation : 0;
          const scale = Math.PI / 180;
          out.phasor_orientation = { v: deg * scale, ref: { node: nodeId, param: "phasor_orientation", scale } };
        }
        return out;
      },
    }))
  )
);

export const SKIA_NOISE_FUNCTION_IDS = variants.map((v) => v.fn.id);

export const skiaNoiseNode = defineSkslVariantNode({
  type: "skia-noise",
  name: "Noise (Skia)",
  mirrors: "noise",
  subcategory: "generator",
  description:
    "Skia-layer Noise: every Noise algorithm (perlin, simplex, value, the OpenSimplex family, super simplex, perlin-deriv, flow, curl, phasor) as an SkSL function that fuses into the layer's one runtime shader. Same params as Noise, including the looping evolution, flow time and the phasor controls; `UV` re-samples at a wired shader's R/G. The `preview` output renders it through CanvasKit; the shader output feeds other Skia nodes.",
  searchAliases: ["noise", "perlin", "simplex", "fbm", "curl", "phasor", "flow", "skia", "sksl"],
  facts: {
    gotchas: [
      "Each type × animated × UV-wired combination fuses its own SkSL function, so the shader holds only the chosen algorithm; a keyframed type refuses to export.",
      "animated=true reads the shader clock (frame = iTime × fps) and loops on the device clock with no per-frame uniforms; it forces w to 0, and type=flow sweeps flow_time one turn instead.",
      "uv_in replaces the sample uv with the wired shader's R/G at the same pixel, in fp32 (Noise reads a half-float texture there).",
      "offset_x/offset_y are in noise-lattice units added after scale and the y aspect compression, exactly as Noise; seed adds (127.1, 311.7) per unit.",
      "w is a smoothstep blend between hashed integer slices, so fractional w costs two fBm evaluations; integer w costs one.",
      "type=curl writes the curl vector as RG = v×0.5+0.5 with B = 0 and ignores color_a/color_b; phasor_orientation is degrees (radians in the shader).",
      "opacity is folded into the shader's alpha; the preview output is faded by the evaluator instead, so it is not applied twice.",
      "Noise's value / field / field3d outputs, position inputs and field_lo/field_hi are not ported; a type outside the enum emits transparent and is reported.",
    ],
  },
  variants,
  sockets: [UV_SOCKET],
  pick(params, wired) {
    const t = typeof params.type === "string" && ALGOS[params.type] ? params.type : "simplex";
    return variantKey(t, params.animated === true, wired("uv_in"));
  },
  params: mirrorParams(perlinNoiseNode, [
    "opacity",
    "type",
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
    "flow_time",
    "phasor_frequency",
    "phasor_orientation",
    "phasor_isotropy",
    "color_a",
    "color_b",
    "alpha",
  ]),
  unsupported(params) {
    const type = params.type === undefined ? "simplex" : params.type;
    if (typeof type === "string" && ALGOS[type]) return [];
    return [`Noise (Skia) has no algorithm "${String(type)}" (types: ${TYPES.join(", ")}).`];
  },
});
