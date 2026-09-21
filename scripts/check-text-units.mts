// Guards the Text px / % units toggle (specdocs/091926_text-size-units.md),
// the pure half — the raster itself needs canvas2d:
//   - px is a pass-through at any canvas width; % scales linearly with the
//     width, for all three governed metrics (font_size, letter_spacing,
//     strokeWidth), and an absent `units` reads as px (old saves),
//   - the raster signature differs between px and % at equal values, and
//     a % node's RELATIVE framing is the same at 1920 and 3840 (the sig
//     changes with W, so it re-rasterizes, and the resolved size doubles),
//   - the def: `units` sits beside `font_size`, defaults to px, governs the
//     three metrics, and the range hints swap to the percent scale under %
//     (a hard min of 4 would forbid every sane percent) and fall back to
//     the static px range otherwise,
//   - flipping units converts constants + keyframe values by one factor
//     against the PROJECT width, round-trips px → % → px, leaves ticks /
//     easings / non-numeric values alone, and is a no-op when the unit
//     doesn't change,
//   - Point Labels / Points to Text carry the same toggle as `size_units`
//     (their `units` is the coordinate axis) and the Stroke-family retrofit
//     declares what each toggle governs.
//
//   npx tsx scripts/check-text-units.mts

import {
  computeRasterSig,
  resolveTextMetrics,
  TEXT_UNITS_GOVERNS,
  textNode,
} from "../src/nodes/source/text.ts";
import {
  convertGovernedUnits,
  convertUnitsValue,
  resolveStrokePx,
  strokeUnitsParam,
  unitsConversionFactor,
  unitsRangeHints,
} from "../src/engine/stroke-units.ts";
import { pointLabelsNode } from "../src/nodes/effect/point-labels.ts";
import { pointsToTextNode } from "../src/nodes/effect/points-to-text.ts";
import { strokeNode } from "../src/nodes/effect/stroke.ts";
import type { AnimationMap } from "../src/engine/keyframes.ts";
import type { NodeDefinition, ParamDef } from "../src/engine/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const param = (def: NodeDefinition, name: string): ParamDef | undefined =>
  def.params.find((p) => p.name === name);

// ---------------------------------------------------------------- resolve
{
  const px = { font_size: 96, letter_spacing: 2, strokeWidth: 3, units: "px" };
  for (const W of [1024, 1920, 3840]) {
    const m = resolveTextMetrics(px, W);
    check(`px pass-through at W=${W}`, m.size === 96 && m.letterSpacing === 2 && m.strokeWidth === 3);
  }
  const legacy = { font_size: 96, letter_spacing: 2, strokeWidth: 3 };
  const ml = resolveTextMetrics(legacy, 3840);
  check("absent units reads as px (old saves)", ml.size === 96 && ml.letterSpacing === 2 && ml.strokeWidth === 3);

  const pct = { font_size: 5, letter_spacing: 0.1, strokeWidth: 0.25, units: "%" };
  const a = resolveTextMetrics(pct, 1920);
  const b = resolveTextMetrics(pct, 3840);
  check("% resolves against canvas width", near(a.size, 96) && near(a.letterSpacing, 1.92) && near(a.strokeWidth, 4.8));
  check("% scales linearly with width", near(b.size, 2 * a.size) && near(b.letterSpacing, 2 * a.letterSpacing) && near(b.strokeWidth, 2 * a.strokeWidth));
  check("resolveStrokePx is the shared convention", resolveStrokePx(5, "%", 1920) === a.size);

  const defaults = resolveTextMetrics({}, 1920);
  check("defaults: 64 px size, 0 spacing, 0 stroke", defaults.size === 64 && defaults.letterSpacing === 0 && defaults.strokeWidth === 0);
}

// -------------------------------------------------------------- signature
{
  const base = { text: "Hi", font_size: 10 };
  const sPx = computeRasterSig({ ...base, units: "px" }, "Inter", 1920, 1080);
  const sPct = computeRasterSig({ ...base, units: "%" }, "Inter", 1920, 1080);
  check("sig differs between px and % at equal values", sPx !== sPct);
  const sPct4k = computeRasterSig({ ...base, units: "%" }, "Inter", 3840, 2160);
  check("sig changes with canvas width (re-raster on resize)", sPct !== sPct4k);
  const sPctAgain = computeRasterSig({ ...base, units: "%" }, "Inter", 1920, 1080);
  check("sig is stable for identical inputs", sPct === sPctAgain);
  // Relative framing: size / W is constant under % across resolutions.
  const r1 = resolveTextMetrics({ font_size: 5, units: "%" }, 1920).size / 1920;
  const r2 = resolveTextMetrics({ font_size: 5, units: "%" }, 3840).size / 3840;
  check("% keeps size/width ratio across 1080p → 4K", near(r1, r2));
  const p1 = resolveTextMetrics({ font_size: 96, units: "px" }, 1920).size / 1920;
  const p2 = resolveTextMetrics({ font_size: 96, units: "px" }, 3840).size / 3840;
  check("px halves its ratio at 4K (the bug the toggle fixes)", near(p1, 2 * p2));
}

// -------------------------------------------------------------------- def
{
  const names = textNode.params.map((p) => p.name);
  const iSize = names.indexOf("font_size");
  const iUnits = names.indexOf("units");
  check("units param exists and follows font_size", iUnits === iSize + 1, `font_size@${iSize} units@${iUnits}`);
  const units = param(textNode, "units")!;
  check("units defaults to px", units.default === "px");
  check("units is a segmented px | % enum", units.type === "enum" && units.control === "segmented" && JSON.stringify(units.options) === '["px","%"]');
  check("units governs the three metrics", JSON.stringify(units.unitsConvert?.governs) === JSON.stringify(TEXT_UNITS_GOVERNS) && TEXT_UNITS_GOVERNS.length === 3);
  for (const g of TEXT_UNITS_GOVERNS) {
    const p = param(textNode, g);
    check(`governed param ${g} is a scalar`, !!p && p.type === "scalar");
  }
  const size = param(textNode, "font_size")!;
  check("font_size label dropped the (px) suffix", size.label === "Size");
  const pxP = { units: "px" };
  const pctP = { units: "%" };
  check("font_size static px range intact", size.min === 4 && size.max === 1000 && size.softMax === 200 && size.step === 1);
  check("font_size hints are undefined under px (static fallback)", size.minFrom?.(pxP) === undefined && size.maxFrom?.(pxP) === undefined && size.softMaxFrom?.(pxP) === undefined && size.stepFrom?.(pxP) === undefined);
  check("font_size % range: 0.1…100, soft 20, step 0.1", size.minFrom?.(pctP) === 0.1 && size.maxFrom?.(pctP) === 100 && size.softMaxFrom?.(pctP) === 20 && size.stepFrom?.(pctP) === 0.1);
  const ls = param(textNode, "letter_spacing")!;
  check("letter_spacing % range allows negatives", ls.minFrom?.(pctP) === -1 && ls.maxFrom?.(pctP) === 4 && ls.stepFrom?.(pctP) === 0.05);
  const sw = param(textNode, "strokeWidth")!;
  check("strokeWidth % range: max 5, soft 2", sw.maxFrom?.(pctP) === 5 && sw.softMaxFrom?.(pctP) === 2 && sw.minFrom === undefined);
  check("facts keep font_size in the pixels space", textNode.facts?.space?.["param:font_size"] === "pixels");
  check("facts gotcha mentions units=%", (textNode.facts?.gotchas ?? []).some((g) => g.includes("units=%")));

  // unitsRangeHints only emits the fields it was given.
  const h = unitsRangeHints("u", { max: 7 });
  check("unitsRangeHints emits only requested fields", h.maxFrom !== undefined && h.minFrom === undefined && h.softMaxFrom === undefined && h.stepFrom === undefined);
  check("unitsRangeHints reads the named units param", h.maxFrom?.({ u: "%" }) === 7 && h.maxFrom?.({ u: "px" }) === undefined);
}

// ------------------------------------------------------------- conversion
{
  check("factor px→% at 1920 is 100/1920", near(unitsConversionFactor("px", "%", 1920), 100 / 1920));
  check("factor %→px at 1920 is 19.2", near(unitsConversionFactor("%", "px", 1920), 19.2));
  check("factor same unit is 1", unitsConversionFactor("px", "px", 1920) === 1 && unitsConversionFactor("%", "%", 1920) === 1);
  check("factor unknown unit is 1", unitsConversionFactor("em", "%", 1920) === 1);
  check("factor guards a zero width", Number.isFinite(unitsConversionFactor("px", "%", 0)));
  check("convertUnitsValue trims float noise", convertUnitsValue(96, 100 / 1024, "%") === 9.375 && convertUnitsValue(96, 100 / 1920, "%") === 5);
  check("convertUnitsValue rounds to 0.0001 % / 0.01 px", convertUnitsValue(2, 100 / 1920, "%") === 0.1042 && convertUnitsValue(0.1042, 19.2, "px") === 2);

  const units = param(textNode, "units")!;
  const env = { canvasWidth: 1920, canvasHeight: 1080 };
  const params = {
    text: "Hi",
    font_size: 96,
    letter_spacing: 4,
    strokeWidth: 2,
    strokeEnabled: true,
    leading: 1.2,
    units: "%",
  };
  const anim: AnimationMap = {
    font_size: {
      animated: true,
      trackVisible: true,
      keyframes: [
        { tick: 0, value: 48, easingOut: "easeInOut" },
        { tick: 60000, value: 192, easingOut: "linear", bezierHandles: { out: [0.3, 0], in: [0.7, 1] } as never },
      ],
    },
    leading: {
      animated: true,
      trackVisible: true,
      keyframes: [{ tick: 0, value: 1.2, easingOut: "linear" }],
    },
  };
  const r = convertGovernedUnits(units, "px", "%", params, anim, env);
  check("conversion returns a result for px→%", !!r);
  if (r) {
    check("constants rescale: 96 px → 5 %", r.params.font_size === 5);
    check("letter_spacing rescales too", near(r.params.letter_spacing as number, 4 / 19.2, 1e-4));
    check("strokeWidth rescales too", near(r.params.strokeWidth as number, 2 / 19.2, 1e-4));
    check("non-governed params untouched", r.params.leading === 1.2 && r.params.text === "Hi" && r.params.strokeEnabled === true);
    check("units value itself untouched", r.params.units === "%");
    const kf = r.animation!.font_size.keyframes;
    check("keyframe values rescale", kf[0].value === 2.5 && kf[1].value === 10);
    check("keyframe ticks / easing / handles untouched", kf[0].tick === 0 && kf[1].tick === 60000 && kf[1].easingOut === "linear" && kf[1].bezierHandles !== undefined);
    check("non-governed tracks untouched (same object)", r.animation!.leading === anim.leading);
    check("block flags preserved", r.animation!.font_size.animated === true && r.animation!.font_size.trackVisible === true);
    check("input not mutated", params.font_size === 96 && anim.font_size.keyframes[0].value === 48);

    // Round trip: flip back at the same width restores the px values.
    const back = convertGovernedUnits(units, "%", "px", { ...r.params, units: "px" }, r.animation, env);
    check("round trip px → % → px restores constants", !!back && back.params.font_size === 96 && back.params.letter_spacing === 4 && back.params.strokeWidth === 2);
    check("round trip restores keyframes", !!back && back.animation!.font_size.keyframes[0].value === 48 && back.animation!.font_size.keyframes[1].value === 192);
    // What renders is unchanged: resolve both at the project width.
    const pxRender = resolveTextMetrics({ ...params, units: "px" }, 1920).size;
    const pctRender = resolveTextMetrics(r.params, 1920).size;
    check("rendered size identical after the flip at the project width", near(pxRender, pctRender, 1e-6));
  }
  check("same unit is a no-op (null)", convertGovernedUnits(units, "px", "px", params, anim, env) === null);
  check("a def without unitsConvert is a no-op", convertGovernedUnits(strokeUnitsParam("u"), "px", "%", params, anim, env) === null);
  const noAnim = convertGovernedUnits(units, "px", "%", params, undefined, env);
  check("missing animation map stays undefined", !!noAnim && noAnim.animation === undefined);
  const strAnim = convertGovernedUnits(units, "px", "%", { font_size: "12" as unknown as number }, undefined, env);
  check("non-numeric governed values are left alone", !!strAnim && strAnim.params.font_size === "12");
}

// -------------------------------------------------------- sibling nodes
{
  for (const [label, def] of [["Point Labels", pointLabelsNode], ["Points to Text", pointsToTextNode]] as const) {
    const su = param(def, "size_units");
    check(`${label} has size_units (its units is the coordinate axis)`, !!su && su.default === "px" && !!param(def, "units"));
    check(`${label} size_units governs size`, JSON.stringify(su?.unitsConvert?.governs) === '["size"]');
    const size = param(def, "size")!;
    check(`${label} size label dropped (px)`, size.label === "Size");
    check(`${label} size % range: 0.1…50 soft 10`, size.minFrom?.({ size_units: "%" }) === 0.1 && size.maxFrom?.({ size_units: "%" }) === 50 && size.softMaxFrom?.({ size_units: "%" }) === 10);
    check(`${label} size px range intact`, size.min === 1 && size.max === 512 && size.softMax === 128 && size.minFrom?.({ size_units: "px" }) === undefined);
    check(`${label} facts keep size in pixels + gotcha`, def.facts?.space?.["param:size"] === "pixels" && (def.facts?.gotchas ?? []).some((g) => g.includes("size_units=%")));
  }
  check(
    "Points to Text fingerprint keys canvas size under size_units=%",
    pointsToTextNode.fingerprintExtras?.({ units: "normalized", size_units: "%" }, { width: 1920, height: 1080 } as never) === "1920x1080" &&
      pointsToTextNode.fingerprintExtras?.({ units: "normalized", size_units: "px" }, { width: 1920, height: 1080 } as never) === ""
  );
  // Stroke-family retrofit: the toggle now declares what it converts.
  const su = param(strokeNode, "units")!;
  check("Stroke units governs thickness + dash/dot metrics", JSON.stringify(su.unitsConvert?.governs) === '["thickness","dash_length","dash_gap","dot_spacing"]');
  const r = convertGovernedUnits(su, "px", "%", { thickness: 19.2, dash_length: 10, units: "%" }, undefined, { canvasWidth: 1920, canvasHeight: 1080 });
  check("Stroke flip converts thickness 19.2 px → 1 %", !!r && r.params.thickness === 1 && near(r.params.dash_length as number, 0.5208, 1e-4));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall text-units checks passed");
