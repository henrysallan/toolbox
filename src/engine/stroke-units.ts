import type { ParamDef } from "./types";
import type { AnimationMap } from "./keyframes";

// Shared px / % units for pixel metrics — stroke thickness, dash/dot
// lengths (the #174 fix, spec: 071226_multi-stroke.md) and, since
// 091926_text-size-units.md, Text's font size / letter spacing / in-raster
// stroke. Rasterizers historically measured in absolute canvas pixels, so
// the same project rendered visually thinner strokes and smaller type at
// higher resolutions (and the reverse in a lowered preview scale). The `%`
// unit resolves against the CANVAS WIDTH (value / 100 × width) — the same
// width-relative convention as multi-stroke band widths and SDF aspect
// correction — so a `%` metric keeps its look at any resolution.
//
// Every node keeps `px` as its default: #174 is fixed by opting a project
// into `%`, never by silently changing saved output.

export type StrokeUnits = "px" | "%";

export function resolveStrokePx(
  value: number,
  units: unknown,
  canvasWidth: number
): number {
  return units === "%" ? (value / 100) * canvasWidth : value;
}

// Multiplier that carries a value from one unit to the other at a given
// canvas width, so the rendered size is unchanged: px → % is 100 / W,
// % → px is W / 100, anything else (same unit, unknown unit) is 1.
export function unitsConversionFactor(
  from: unknown,
  to: unknown,
  canvasWidth: number
): number {
  if (from === to) return 1;
  const w = Math.max(1, canvasWidth);
  if (from === "px" && to === "%") return 100 / w;
  if (from === "%" && to === "px") return w / 100;
  return 1;
}

// Rescale a numeric value by `factor` and round to the TARGET unit's
// display precision: 0.01 px, 0.0001 % (= 0.004 px on a 4K comp). Fixed
// decimals per unit (not significant digits) is what makes the px → % → px
// round trip land back on the original: the % rounding error, carried
// back to px, stays under the px half-step for any comp under ~5000 px
// wide (2 px → 0.1042 % → 2.00064 → 2.00 px). A shared significant-digit
// trim can't promise that — a % value with a leading 1 holds less relative
// precision than a px value with a leading 9, so 2 px came back 2.00001.
export function convertUnitsValue(
  value: number,
  factor: number,
  to: unknown
): number {
  const decimals = to === "%" ? 4 : 2;
  return parseFloat((value * factor).toFixed(decimals));
}

export interface UnitsConvertResult {
  params: Record<string, unknown>;
  animation: AnimationMap | undefined;
}

// Apply a units flip to a node's params + animation: every param the units
// def `governs` has its constant and every keyframe value multiplied by
// the conversion factor. Non-numeric values are left alone. Returns null
// when nothing changes (same unit, no unitsConvert on the def, factor 1)
// so callers can skip the write. Pure — the editor's onParamChange wraps
// it in one undo step; the check gate drives it directly.
export function convertGovernedUnits(
  unitsDef: ParamDef,
  from: unknown,
  to: unknown,
  params: Record<string, unknown>,
  animation: AnimationMap | undefined,
  env: { canvasWidth: number; canvasHeight: number }
): UnitsConvertResult | null {
  const uc = unitsDef.unitsConvert;
  if (!uc || from === to) return null;
  const factor = uc.factor(from, to, env);
  if (!Number.isFinite(factor) || factor === 1) return null;
  const nextParams = { ...params };
  let nextAnimation = animation;
  for (const name of uc.governs) {
    const v = nextParams[name];
    if (typeof v === "number" && Number.isFinite(v)) {
      nextParams[name] = convertUnitsValue(v, factor, to);
    }
    const block = nextAnimation?.[name];
    if (block && block.keyframes.length > 0) {
      nextAnimation = {
        ...nextAnimation,
        [name]: {
          ...block,
          keyframes: block.keyframes.map((k) =>
            typeof k.value === "number" && Number.isFinite(k.value)
              ? { ...k, value: convertUnitsValue(k.value, factor, to) }
              : k
          ),
        },
      };
    }
  }
  return { params: nextParams, animation: nextAnimation };
}

// The units toggle ParamDef. `name` varies per node ("units" on the stroke
// rasterizer nodes, "stroke_units" / "size_units" where params are
// prefixed or `units` is taken). `governs` lists the sibling pixel-metric
// params this toggle converts when flipped (see ParamDef.unitsConvert);
// omit it and the flip leaves values alone (4 px becomes 4 %).
export function strokeUnitsParam(
  name: string,
  visibleIf?: ParamDef["visibleIf"],
  opts?: { governs?: string[] }
): ParamDef {
  const def: ParamDef = {
    name,
    label: "Units",
    type: "enum",
    options: ["px", "%"],
    default: "px",
    control: "segmented",
  };
  if (visibleIf) def.visibleIf = visibleIf;
  if (opts?.governs && opts.governs.length > 0) {
    def.unitsConvert = {
      governs: opts.governs,
      factor: (from, to, env) => unitsConversionFactor(from, to, env.canvasWidth),
    };
  }
  return def;
}

// Range hints for a pixel metric that also has a `%` reading. Returns the
// `minFrom` / `maxFrom` / `softMaxFrom` / `stepFrom` ParamDef fields that
// swap in the `%` range while `params[unitsName] === "%"` and fall back to
// the def's static px fields otherwise (returning undefined keeps the
// static value and, for step, disables snapping).
export function unitsRangeHints(
  unitsName: string,
  pct: { min?: number; max?: number; softMax?: number; step?: number }
): Pick<ParamDef, "minFrom" | "maxFrom" | "softMaxFrom" | "stepFrom"> {
  const isPct = (p: Record<string, unknown>) => p[unitsName] === "%";
  const out: Pick<ParamDef, "minFrom" | "maxFrom" | "softMaxFrom" | "stepFrom"> = {};
  if (pct.min !== undefined) out.minFrom = (p) => (isPct(p) ? pct.min : undefined);
  if (pct.max !== undefined) out.maxFrom = (p) => (isPct(p) ? pct.max : undefined);
  if (pct.softMax !== undefined)
    out.softMaxFrom = (p) => (isPct(p) ? pct.softMax : undefined);
  if (pct.step !== undefined) out.stepFrom = (p) => (isPct(p) ? pct.step : undefined);
  return out;
}
