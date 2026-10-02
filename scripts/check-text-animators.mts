// Guards the Text animators' "Based on" unit and custom easing curve
// (engine/text-animators.ts), the pure half — the raster needs canvas2d:
//   - wordIndices: runs of non-whitespace are words, whitespace joins the
//     word before it, every line starts a new word, ids run across lines,
//     and an all-whitespace text still counts one word,
//   - wordCentres: the midpoint of a word's visible glyphs on a run,
//   - by=character is the old behaviour (an absent `by` reads as character),
//     by=word gives every glyph of a word the same cascade t and counts words
//     for the sweep, and word animators land in the word transform (the
//     word-centre pivot) while character ones stay on the glyph,
//   - easing=custom samples anim_<p>_easing_curve (identity when absent) and
//     blends with ease_intensity; Scene Time's custom route is unchanged,
//   - the def rows: `by` is a segmented character/word enum per animator,
//     every easing enum offers custom, the curve row is a float_curve shown
//     only for custom, and validateGraph accepts a Float Curve aux:curve on
//     the exposed curve param.
//
//   npx tsx scripts/check-text-animators.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

// Minimal DOM stubs — registering the node set pulls the whole engine in.
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};
g.WebGL2RenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { paramSocketType } = await import("@/engine/graph-helpers");
const { validateGraph } = await import("@/engine/graph-validation");
import type { ValEdge, ValNode } from "@/engine/graph-validation";
import type { GlyphIndex } from "@/engine/text-animators";
const {
  parseAnimators,
  resolveGlyphAnim,
  resolveTrackingExtra,
  wordCentres,
  wordIndices,
  TEXT_ANIMATOR_PARAMS,
} = await import("@/engine/text-animators");
const { CUSTOM_EASING, applyEasing, applyEasingOrCurve } = await import("@/engine/easing");
const { sampleFloatCurve } = await import("@/engine/float-curve");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const arr = (a: Int32Array) => Array.from(a).join(",");

// ---------------------------------------------------------------------
// 1. word indexing
// ---------------------------------------------------------------------
{
  const w = wordIndices([Array.from("ab cd"), Array.from("ef  g")]);
  check("words number across lines", arr(w.ids[0]) === "0,0,0,1,1" && arr(w.ids[1]) === "2,2,2,2,3", `${arr(w.ids[0])} | ${arr(w.ids[1])}`);
  check("word total counts words", w.total === 4, String(w.total));
  const lead = wordIndices([Array.from("  hi")]);
  check("leading whitespace joins word 0", arr(lead.ids[0]) === "0,0,0,0" && lead.total === 1);
  const cont = wordIndices([Array.from("ab"), Array.from("cd")]);
  check("a line break starts a new word", arr(cont.ids[1]) === "1,1" && cont.total === 2);
  const blank = wordIndices([Array.from("   ")]);
  check("all-whitespace text counts one word", blank.total === 1);
  check("tabs / newlines are whitespace", arr(wordIndices([Array.from("a\tb")]).ids[0]) === "0,0,1");

  const chars = Array.from("ab cd");
  const ids = wordIndices([chars]).ids[0];
  const xs = [0, 10, 20, 30, 40];
  const advs = [10, 10, 10, 10, 10];
  const mid = wordCentres(chars, ids, xs, advs);
  check("word centre spans its visible glyphs", mid.get(0) === 10 && mid.get(1) === 40, JSON.stringify([...mid]));
  const tail = wordCentres(Array.from(" x"), new Int32Array([4, 5]), [0, 10], [10, 10]);
  check("a whitespace-only word has no centre", !tail.has(4) && tail.get(5) === 15);
}

// ---------------------------------------------------------------------
// 2. by = character vs word
// ---------------------------------------------------------------------
{
  // "ab cd" → chars 0..4, words 0,0,0,1,1.
  const w = wordIndices([Array.from("ab cd")]);
  const gi = (i: number): GlyphIndex => ({ char: i, charTotal: 5, word: w.ids[0][i], wordTotal: w.total });
  const base = {
    anim_opacity_enabled: true,
    anim_opacity_driver: "cascade",
    anim_opacity_amount: 0.5,
    anim_opacity_softness: 0.3,
    anim_opacity_direction: "forward",
    anim_opacity_min: 0,
    anim_opacity_max: 1,
  };
  const alphas = (params: Record<string, unknown>) => {
    const a = parseAnimators(params);
    return [0, 1, 2, 3, 4].map((i) => resolveGlyphAnim(a, gi(i), {}).alpha);
  };
  const byChar = alphas(base);
  const byCharExplicit = alphas({ ...base, anim_opacity_by: "character" });
  check("absent `by` reads as character", byChar.every((v, i) => close(v, byCharExplicit[i])));
  // Chars 1 and 2 are both word 0 (2 is its trailing space).
  check("by character: glyphs of a word differ", !close(byChar[1], byChar[2]), byChar.join(","));
  const byWord = alphas({ ...base, anim_opacity_by: "word" });
  check("by word: every glyph of a word shares t", close(byWord[0], byWord[1]) && close(byWord[1], byWord[2]) && close(byWord[3], byWord[4]), byWord.join(","));
  // 2 words, softness 0.3: word 0 starts at 0, word 1 at 0.7 → amount 0.5:
  // word 0 = clamp(0.5/0.3) = 1, word 1 = 0.
  check("by word: the sweep counts words", close(byWord[0], 1) && close(byWord[3], 0), byWord.join(","));

  const typeWord = parseAnimators({
    anim_typeon_enabled: true,
    anim_typeon_amount: 0.5,
    anim_typeon_softness: 0.3,
    anim_typeon_by: "word",
  });
  const ta = [0, 1, 3].map((i) => resolveGlyphAnim(typeWord, gi(i), {}).alpha);
  check("type on by word reveals whole words", close(ta[0], 1) && close(ta[1], 1) && close(ta[2], 0), ta.join(","));

  const xfParams = {
    anim_scale_enabled: true,
    anim_scale_min: 1,
    anim_scale_max: 2,
    anim_scale_amount: 1,
    anim_rotation_enabled: true,
    anim_rotation_min: 0,
    anim_rotation_max: 90,
    anim_rotation_amount: 1,
    anim_rotation_by: "word",
    anim_position_enabled: true,
    anim_position_maxX: 5,
    anim_position_amount: 1,
    anim_position_by: "word",
  };
  const r = resolveGlyphAnim(parseAnimators(xfParams), gi(0), {});
  check("a character animator stays on the glyph transform", close(r.scale, 2) && close(r.word.scale, 1));
  check("word animators land on the word transform", close(r.word.rotation, Math.PI / 2) && close(r.rotation, 0) && close(r.word.offsetX, 5) && close(r.offsetX, 0));

  const trk = parseAnimators({
    anim_tracking_enabled: true,
    anim_tracking_driver: "cascade",
    anim_tracking_amount: 0.5,
    anim_tracking_softness: 0.3,
    anim_tracking_min: 0,
    anim_tracking_max: 10,
    anim_tracking_by: "word",
  });
  check("tracking by word shares the word's t", close(resolveTrackingExtra(trk, gi(0)), resolveTrackingExtra(trk, gi(1))) && close(resolveTrackingExtra(trk, gi(3)), 0));
}

// ---------------------------------------------------------------------
// 3. custom easing curve
// ---------------------------------------------------------------------
{
  const dip = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 0.5, y: 0.1 },
    { id: "c", x: 1, y: 1 },
  ];
  const gi: GlyphIndex = { char: 0, charTotal: 1, word: 0, wordTotal: 1 };
  const params = (over: Record<string, unknown>) => ({
    anim_opacity_enabled: true,
    anim_opacity_amount: 0.5,
    anim_opacity_min: 0,
    anim_opacity_max: 1,
    anim_opacity_easing: CUSTOM_EASING,
    ...over,
  });
  const a = (over: Record<string, unknown>) => resolveGlyphAnim(parseAnimators(params(over)), gi, {}).alpha;
  check("custom samples the easing curve", close(a({ anim_opacity_easing_curve: dip }), sampleFloatCurve(dip, 0.5)));
  check("custom with no curve is the identity", close(a({}), 0.5));
  check(
    "custom blends with ease_intensity",
    close(a({ anim_opacity_easing_curve: dip, anim_opacity_ease_intensity: 0.5 }), 0.5 + 0.5 * (0.1 - 0.5), 1e-6)
  );
  check("named easings are unchanged", close(applyEasingOrCurve("ease-in", 0.3, 1, dip), applyEasing("ease-in", 0.3, 1)));
}

// ---------------------------------------------------------------------
// 4. def rows + the exposed-param wire
// ---------------------------------------------------------------------
{
  const text = getNodeDef("text")!;
  const row = (name: string) => text.params.find((p) => p.name === name);
  const props = ["typeon", "opacity", "position", "scale", "rotation", "tracking", "color"];
  check(
    "every animator has a segmented character/word `by`",
    props.every((p) => {
      const r = row(`anim_${p}_by`);
      return r?.type === "enum" && r.control === "segmented" && r.default === "character" && r.options?.join(",") === "character,word" && r.group === p;
    })
  );
  check("every easing enum offers custom", props.every((p) => row(`anim_${p}_easing`)?.options?.includes(CUSTOM_EASING)));
  check(
    "every animator has an exposable float_curve easing curve",
    props.every((p) => {
      const r = row(`anim_${p}_easing_curve`);
      return r?.type === "float_curve" && paramSocketType(r.type) === "float_curve" && r.group === p;
    })
  );
  const curveRow = row("anim_scale_easing_curve")!;
  check(
    "the curve row shows only for an enabled custom easing",
    curveRow.visibleIf!({ anim_scale_enabled: true, anim_scale_easing: CUSTOM_EASING }) &&
      !curveRow.visibleIf!({ anim_scale_enabled: true, anim_scale_easing: "linear" }) &&
      !curveRow.visibleIf!({ anim_scale_enabled: false, anim_scale_easing: CUSTOM_EASING })
  );
  check("TEXT_ANIMATOR_PARAMS names are unique", new Set(TEXT_ANIMATOR_PARAMS.map((p) => p.name)).size === TEXT_ANIMATOR_PARAMS.length);

  const paramsOf = (type: string, over: Record<string, unknown> = {}) => {
    const p: Record<string, unknown> = {};
    for (const d of getNodeDef(type)!.params) p[d.name] = d.default;
    return { ...p, ...over };
  };
  const N = (id: string, defType: string, params: Record<string, unknown>): ValNode => ({ id, defType, params });
  const E = (source: string, sourceHandle: string, target: string, targetHandle: string): ValEdge => ({
    id: `${source}->${target}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  });
  const errs = (nodes: ValNode[], edges: ValEdge[]) =>
    validateGraph(nodes, edges)
      .issues.filter((i) => i.severity === "error")
      .map((i) => i.code);
  const tx = N("tx", "text", paramsOf("text", { anim_opacity_enabled: true, anim_opacity_easing: CUSTOM_EASING }));
  check(
    "Float Curve aux:curve → Text in:param:anim_opacity_easing_curve is valid",
    errs([N("fc", "float-curve", paramsOf("float-curve")), tx], [E("fc", "out:aux:curve", "tx", "in:param:anim_opacity_easing_curve")]).length === 0
  );
  check(
    "a scalar → the easing curve param is a type mismatch",
    errs([N("st", "scene-time", paramsOf("scene-time")), tx], [E("st", "out:primary", "tx", "in:param:anim_opacity_easing_curve")]).includes("EDGE_TYPE_MISMATCH")
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall text-animator checks passed");
