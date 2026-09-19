// Emit Merge's shader sources to JSON for scripts/check-shaders.mjs, which
// compiles and pixel-tests them in a real WebGL2 context under Electron.
// GLSL errors and blend-formula mistakes are runtime-only — typecheck and the
// other check-*.mts gates cannot see them.
//
//   npx tsx scripts/emit-shaders.mts <out.json>
import { writeFileSync } from "node:fs";

const { fusedMergeFs, BLEND_FS } = await import("@/nodes/effect/merge");
const { BLEND_FIELD_FS } = await import(
  "@/engine/spline-blend-intersections-gpu"
);
const { GAUSS_FS, TENSOR_FS, EIGEN_FS } = await import(
  "@/engine/orientation-field"
);
const { FLOW_BLUR_FS } = await import("@/nodes/effect/flow-blur");
const { COHERENCE_FS } = await import("@/nodes/effect/image-flow-field");
const { KUWAHARA_FS } = await import("@/nodes/effect/kuwahara");
const { FLOW_BILATERAL_FS } = await import("@/nodes/effect/flow-bilateral");
const { SHOCK_SMOOTH_FS, SHOCK_FS } = await import(
  "@/nodes/effect/shock-filter"
);
const {
  LINE_LUM_FS,
  LINE_COMBINE_FS,
  FDOG_ACROSS_FS,
  FDOG_ALONG_FS,
  LINE_THRESH_FS,
} = await import("@/nodes/effect/line-art");
const { TRANSFORM_FS, TRANSFORM_MATRIX_FS } = await import("@/nodes/effect/transform");
const { DISPLACE_FS } = await import("@/nodes/effect/displace");
const { VECTOR_FIELD_IMAGE_FS, buildVectorFieldSdfFS } = await import(
  "@/nodes/effect/vector-field"
);
const {
  OVER_FS: TRAILS_OVER_FS,
  FADE_FS: TRAILS_FADE_FS,
  VELOCITY_FS: TRAILS_VELOCITY_FS,
} = await import("@/nodes/effect/trails");

const { glslExpressionSource } = await import("@/nodes/effect/glsl-expression");
const { LYAPUNOV_FS } = await import("@/nodes/source/lyapunov");
// Ramp LUT consumers (091626_ramp-space-interp.md) — the shared
// colorRampLutGlsl snippet must compile inside each host shader.
const { COLOR_RAMP_FS } = await import("@/nodes/effect/color-ramp");
const { ASCII_FS } = await import("@/nodes/effect/ascii");
const { SHAPE_CELLS_FS } = await import("@/nodes/source/shape-cells");
const { NOISE_FS } = await import("@/nodes/source/perlin-noise");
// Grain v2 (091626_grain-node-v2.md): the legacy shader kept for saved
// projects, plus the noise-plate and composite passes of the fine model.
const {
  GRAIN_FS,
  GRAIN_NOISE_FS,
  GRAIN_FILM_FS,
  GRAIN_PLATE_FS,
  GRAIN_TILE_FS,
  GRAIN_BLUR_FS,
  GRAIN_COMPOSITE_FS,
} = await import("@/nodes/effect/grain");
const {
  SH_INIT_FS,
  SH_SEED_FS,
  SH_LAP_FS,
  SH_STEP_FS,
  SH_OUTPUT_FS,
} = await import("@/nodes/effect/swift-hohenberg");

const out: Record<string, string> = { pairwise: BLEND_FS };
// GLSL Expression's owned template with one channel of every kind minted
// (090426_expression-channel-kinds.md) — the uniform / const / lookup
// declarations must compile and link with a body that touches each.
out.glslExpressionChannels = glslExpressionSource({
  inputs: [
    { id: "e1", name: "amount", default: 0.5, min: 0, max: 1 },
    { id: "e2", name: "invert", kind: "toggle", default: true },
    { id: "e3", name: "mode", kind: "enum", default: "soft", options: ["soft", "hard edge", "3"] },
    { id: "e4", name: "tint", kind: "color", default: "#ff8800" },
    { id: "e5", name: "ink", kind: "ramp", default: [] },
    { id: "e6", name: "falloff", kind: "curve", default: [] },
  ],
  expression: `vec4 a = texture(u_a, v_uv);
float t = invert ? 1.0 - v_uv.x : v_uv.x;
vec4 c = ink(t) * tint;
float f = falloff(v_uv.y);
if (mode == mode_hard_edge) f = step(0.5, f);
if (mode == mode_3) f = 0.0;
fragColor = mix(a, c, amount * f);`,
});
// 1..8 covers every real layer count; the per-pass cap is 7 on a
// minimum-spec 16-unit device and 15 on a 32-unit one.
for (let n = 1; n <= 8; n++) out[`fused${n}`] = fusedMergeFs(n);
// Blend Intersections' GPU field pass — compile/link coverage here; its
// numeric equivalence gate is npm run check:blend-gpu.
out.blendField = BLEND_FIELD_FS;
// Orientation-field program (082426 specs) — compile/link coverage.
out.orientationGauss = GAUSS_FS;
out.orientationTensor = TENSOR_FS;
out.orientationEigen = EIGEN_FS;
out.flowBlur = FLOW_BLUR_FS;
out.flowFieldCoherence = COHERENCE_FS;
out.kuwahara = KUWAHARA_FS;
out.flowBilateral = FLOW_BILATERAL_FS;
out.shockSmooth = SHOCK_SMOOTH_FS;
out.shock = SHOCK_FS;
out.lineLum = LINE_LUM_FS;
out.lineCombine = LINE_COMBINE_FS;
out.fdogAcross = FDOG_ACROSS_FS;
out.fdogAlong = FDOG_ALONG_FS;
out.lineThresh = LINE_THRESH_FS;
out.shInit = SH_INIT_FS;
out.shSeed = SH_SEED_FS;
out.shLap = SH_LAP_FS;
out.shStep = SH_STEP_FS;
out.shOutput = SH_OUTPUT_FS;
out.trailsOver = TRAILS_OVER_FS;
out.trailsFade = TRAILS_FADE_FS;
out.trailsVelocity = TRAILS_VELOCITY_FS;
out.transform = TRANSFORM_FS;
out.transformMatrix = TRANSFORM_MATRIX_FS;
out.displace = DISPLACE_FS;
out.vectorFieldImage = VECTOR_FIELD_IMAGE_FS;
out.vectorFieldSdf = buildVectorFieldSdfFS("", "length(p - vec2(0.5))");
out.lyapunov = LYAPUNOV_FS;
out.noise = NOISE_FS;
out.colorRamp = COLOR_RAMP_FS;
out.asciiMain = ASCII_FS;
out.shapeCells = SHAPE_CELLS_FS;
out.grainClassic = GRAIN_FS;
out.grainNoise = GRAIN_NOISE_FS;
out.grainFilm = GRAIN_FILM_FS;
out.grainPlate = GRAIN_PLATE_FS;
out.grainTile = GRAIN_TILE_FS;
out.grainBlur = GRAIN_BLUR_FS;
out.grainComposite = GRAIN_COMPOSITE_FS;

// Graph → GLSL node docs (091626_graph-to-glsl.md): every ```glsl-body fence
// is a fused-shader snippet written against the GLSL Expression template.
// Compile each one inside the template with the channels its comments
// declare — a doc snippet that does not compile is a lie the gate catches.
{
  const { GLSL_DOCS } = await import("@/lib/glsl-translation/docs.generated");
  const { syncChannelInputs } = await import("@/engine/expr-channels");
  const FENCE = /```glsl-body\r?\n([\s\S]*?)```/g;
  for (const doc of Object.values(GLSL_DOCS)) {
    let m: RegExpExecArray | null;
    let i = 0;
    FENCE.lastIndex = 0;
    while ((m = FENCE.exec(doc.body))) {
      const body = m[1];
      out[`doc:${doc.slug}#${i++}`] = glslExpressionSource({
        inputs: syncChannelInputs([], body),
        expression: body,
      });
    }
  }
}

writeFileSync(process.argv[2] ?? "shaders.json", JSON.stringify(out));
console.log(`emitted ${Object.keys(out).length} shader sources`);
