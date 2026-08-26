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
const {
  OVER_FS: TRAILS_OVER_FS,
  FADE_FS: TRAILS_FADE_FS,
  VELOCITY_FS: TRAILS_VELOCITY_FS,
} = await import("@/nodes/effect/trails");

const out: Record<string, string> = { pairwise: BLEND_FS };
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
out.trailsOver = TRAILS_OVER_FS;
out.trailsFade = TRAILS_FADE_FS;
out.trailsVelocity = TRAILS_VELOCITY_FS;

writeFileSync(process.argv[2] ?? "shaders.json", JSON.stringify(out));
console.log(`emitted ${Object.keys(out).length} shader sources`);
