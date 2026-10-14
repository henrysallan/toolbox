// SkSL helpers for the merge & blend family (specdocs/101326_skia-target.md
// §3.2, Wave 2 family 6): Merge's blend formulas and the mask → coverage
// rule, for Skia Merge (src/nodes/skia/merge.ts) and any later port that
// composites the toolbox way.
//
// The blend formulas are NOT a second copy. Merge keeps its twenty-nine
// formulas in one GLSL string on purpose (merge.ts: "two copies … would
// drift the first time one of them was touched"), so this module DERIVES
// the SkSL from that string: the block between BLEND_FS's `out vec4
// outColor;` and its `void main()`, with every function renamed into the
// library's namespace (blendRgb → tbx_blend_rgb, compositeOver →
// tbx_blend_over, overlayCh → tbx_blend_overlayCh, …) and vecN spelled
// floatN. The math is untouched, statement for statement, so a formula fixed
// in Merge is fixed in Skia Merge on the next load. The engine never imports
// a node module: the node hands BLEND_FS in (registerMergeBlendHelper).
//
// Helpers:
//   tbx.blend.merge    tbx_blend_rgb(int mode, float3 a, float3 b) — Merge's
//                      modeToInt numbering, straight color — and
//                      tbx_blend_over(float4 base, float4 layer, float
//                      opacity, float matte, int mode): Merge's straight-
//                      alpha source-over (compositeOver)
//   tbx.mask.coverage  tbx_mask_coverage(float4 c): a straight-alpha color
//                      read as a matte, Rec.709 luma × alpha — the engine's
//                      image → mask coercion (engine/coerce.ts
//                      IMAGE_TO_MASK_FS), so a shader wired into a mask
//                      socket mattes exactly like the same image wired into
//                      a toolbox mask socket.

import { registerSkslHelper } from "./registry";

export const MERGE_BLEND_HELPER_ID = "tbx.blend.merge";
export const MASK_COVERAGE_HELPER_ID = "tbx.mask.coverage";

// The modes BLEND_FS's chain must dispatch: Merge's modeToInt is 0..28.
export const MERGE_BLEND_MODE_COUNT = 29;

registerSkslHelper({
  id: MASK_COVERAGE_HELPER_ID,
  source: `float tbx_mask_coverage(float4 c) {
  return dot(c.rgb, float3(0.2126, 0.7152, 0.0722)) * c.a;
}`,
});

const RENAMED: Record<string, string> = {
  blendRgb: "tbx_blend_rgb",
  compositeOver: "tbx_blend_over",
};

export interface DerivedBlendSksl {
  source: string;
  // Function renames applied (GLSL name → SkSL name), in definition order.
  renames: [string, string][];
  problems: string[];
}

// Merge's GLSL blend block → library SkSL. Problems (markers gone, a
// function missing, a mode branch missing, something a runtime effect
// cannot do) are reported, never thrown: the node turns them into
// `unsupported` problems and check:skia-merge fails on them.
export function deriveMergeBlendSksl(blendFs: string): DerivedBlendSksl {
  const problems: string[] = [];
  const at = "deriving Skia Merge's blend helper from Merge's BLEND_FS";
  const head = "out vec4 outColor;";
  const start = blendFs.indexOf(head);
  const end = blendFs.lastIndexOf("void main()");
  if (start < 0 || end < 0 || end <= start) {
    return { source: "", renames: [], problems: [`${at}: markers \`${head}\` / \`void main()\` not found`] };
  }
  let body = blendFs.slice(start + head.length, end).trim();
  const names = [...body.matchAll(/^\s*(?:vec[234]|float|int|bool|void)\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]);
  for (const need of Object.keys(RENAMED)) {
    if (!names.includes(need)) problems.push(`${at}: no \`${need}\` function in the block`);
  }
  for (const banned of [/\buniform\b/, /\btexture\s*\(/, /\bsampler2D\b/, /\bv_uv\b/, /\bgl_\w+/]) {
    if (banned.test(body)) problems.push(`${at}: the block uses ${banned.source}, which a library helper cannot`);
  }
  for (let k = 0; k < MERGE_BLEND_MODE_COUNT; k++) {
    if (!new RegExp(`\\bmode\\s*==\\s*${k}\\)`).test(body)) problems.push(`${at}: no branch for mode ${k}`);
  }
  const renames: [string, string][] = names.map((n) => [n, RENAMED[n] ?? `tbx_blend_${n}`]);
  for (const [from, to] of renames) body = body.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  body = body.replace(/\bvec([234])\b/g, "float$1");
  const header = "// Derived from Merge's BLEND_FS (src/nodes/effect/merge.ts) by helpers-merge.ts — edit the GLSL there.";
  return { source: `${header}\n${body}`, renames, problems };
}

let registered: DerivedBlendSksl | null = null;

// Registers tbx.blend.merge from Merge's BLEND_FS (the node module calls this
// at load). Returns the derivation problems; re-registering replaces it.
export function registerMergeBlendHelper(blendFs: string): string[] {
  const d = deriveMergeBlendSksl(blendFs);
  registered = d;
  // A broken derivation still registers (an empty body would make every
  // caller fail to compile with a confusing message): the node reports
  // `problems` instead, and nothing renders.
  registerSkslHelper({ id: MERGE_BLEND_HELPER_ID, source: d.problems.length ? "" : d.source });
  return d.problems;
}

export function mergeBlendHelperProblems(): string[] {
  return registered ? registered.problems : [`${MERGE_BLEND_HELPER_ID} is not registered (src/nodes/skia/merge.ts registers it)`];
}
