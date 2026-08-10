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

const out: Record<string, string> = { pairwise: BLEND_FS };
// 1..8 covers every real layer count; the per-pass cap is 7 on a
// minimum-spec 16-unit device and 15 on a 32-unit one.
for (let n = 1; n <= 8; n++) out[`fused${n}`] = fusedMergeFs(n);
// Blend Intersections' GPU field pass — compile/link coverage here; its
// numeric equivalence gate is npm run check:blend-gpu.
out.blendField = BLEND_FIELD_FS;

writeFileSync(process.argv[2] ?? "shaders.json", JSON.stringify(out));
console.log(`emitted ${Object.keys(out).length} shader sources`);
