import type { NodeDefinition } from "@/engine/types";
import {
  EMPTY_POINTS,
  isWritablePointAttr,
  pointAttrExists,
  readPointAttr,
  withPointAttr,
  type PointAttrWriteMode,
} from "@/engine/points";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";

// Map Attribute — remap any point attribute onto any other through a range
// and a curve (081326_point-attributes.md M4; 092026_unified-attributes.md).
// Pipeline per point:
//
//   1. Read the named column — a named channel's component 0, a dotted
//      axis (`color.y`), or a built-in (index, x, y, scale.x, rotation,
//      group, …). Normalize [In Lo..In Hi] → [0,1] (clamped).
//   2. Sample the 0..1 float curve. The default two-point (0,0)→(1,1)
//      curve is EXACTLY linear (a two-point monotone-cubic segment has
//      unit end tangents), so an untouched curve leaves this a no-op.
//   3. Map the curve's y through [Out Lo..Out Hi] and store it into the
//      output attribute by name (`scale`, `rotation`, `x`, `y`, a channel…)
//      with the chosen mode: multiply the current value, add to it, or set.
//
// The legacy `map_target` enum (scale = multiply, rotation = add, position
// x / y = add) migrates to output_name + mode on load (see
// migrateMapAttributeParams; lib/project.ts calls it). A missing named
// channel passes through unchanged (the name field's red tint explains
// why). Built-ins always resolve.

const MODE_OPTIONS = ["multiply", "add", "set"] as const;

// Pre-2026-09-20 saves stored the destination as an enum. Each maps to the
// attribute it wrote and the op it applied — behaviour-identical.
const LEGACY_TARGETS: Record<string, [string, PointAttrWriteMode]> = {
  scale: ["scale", "multiply"],
  rotation: ["rotation", "add"],
  "position x": ["x", "add"],
  "position y": ["y", "add"],
};

// Called by migrateLoadedParams (lib/project.ts) for every loaded node and
// fragment. Idempotent: once `output_name` exists nothing happens.
export function migrateMapAttributeParams(params: Record<string, unknown>): void {
  if (params.output_name !== undefined) return;
  const legacy = LEGACY_TARGETS[(params.map_target as string) ?? "scale"];
  if (!legacy) return;
  params.output_name = legacy[0];
  params.mode = legacy[1];
  delete params.map_target;
}

export const mapAttributeNode: NodeDefinition = {
  type: "map-attribute",
  name: "Map Attribute",
  category: "point",
  subcategory: "modifier",
  description:
    "Remaps any point attribute onto any other — read a named channel or a built-in like index, x, y, scale.x, rotation, or group; normalize through In Lo/Hi, shape with a 0–1 curve, map through Out Lo/Hi, then multiply, add, or set the output attribute (scale, rotation, x, y, group, or a named channel). The default curve is a straight diagonal, so an untouched curve is a plain In→Out linear remap. A missing named channel passes through unchanged.",
  facts: {
    space: { "param:out_lo": "canvas01", "param:out_hi": "canvas01" },
    reads: ["attr:scale", "attr:rotation", "attr:position"],
    writes: ["attr:scale", "attr:rotation", "attr:position", "attr:group"],
    gotchas: [
      "attr_name is read at runtime and can be any named channel or a built-in (index, x, y, scale.x, rotation, group, ...); an unknown name passes points through unchanged.",
      "output_name is any writable attribute — scale, scale.x, rotation, x, y, group, or a channel; index, z, nx/ny/nz pass through. mode multiply scales the current value, add offsets, set replaces.",
      "out_lo/out_hi are in the OUTPUT attribute's units: a scale multiplier for scale, radians for rotation, canvas01 for x / y (an add on x/y offsets the stored coordinate directly).",
      "The curve defaults to a two-point (0,0)-(1,1) ramp, which the monotone-cubic sampler renders exactly linear, so an untouched curve behaves as a plain In Lo/Hi -> Out Lo/Hi remap.",
      "Saved nodes with the old map_target enum load as output_name + mode (scale -> scale/multiply, rotation -> rotation/add, position x/y -> x/y add) and render identically.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      suggestAttrsIncludeBuiltins: true,
    },
    {
      name: "output_name",
      label: "Output",
      type: "string",
      default: "scale",
      placeholder: "scale, rotation, x, y, …",
      suggestAttrsFrom: "points",
      suggestAttrsIncludeBuiltins: true,
      suggestAttrsBuiltinFilter: isWritablePointAttr,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODE_OPTIONS as unknown as string[],
      default: "multiply",
    },
    {
      // 0..1 shaper after In-range normalize, before Out-range. The
      // two-point default is exactly linear, so old graphs keep their
      // linear remap.
      name: "curve",
      label: "Curve",
      type: "float_curve",
      default: defaultFloatCurve(0, 1),
    },
    {
      name: "in_lo",
      label: "In Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "in_hi",
      label: "In Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "out_lo",
      label: "Out Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "out_hi",
      label: "Out Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") return { primary: EMPTY_POINTS };
    const name = ((params.attr_name as string) ?? "").trim();
    if (!name || src.count === 0 || !pointAttrExists(src, name)) {
      return { primary: src };
    }
    // An un-migrated legacy node (a recipe that still says map_target)
    // resolves the same way the load migration would.
    const legacy = LEGACY_TARGETS[(params.map_target as string) ?? ""];
    const outName =
      ((params.output_name as string) ?? legacy?.[0] ?? "scale").trim();
    const mode = (
      (MODE_OPTIONS as readonly string[]).includes(params.mode as string)
        ? params.mode
        : legacy?.[1] ?? "multiply"
    ) as PointAttrWriteMode;
    if (!isWritablePointAttr(outName)) return { primary: src };

    const inLo = (params.in_lo as number) ?? 0;
    const inHi = (params.in_hi as number) ?? 1;
    const outLo = (params.out_lo as number) ?? 0;
    const outHi = (params.out_hi as number) ?? 1;
    const span = inHi - inLo;
    const curve = sanitizeFloatCurve(params.curve, 0, 1);

    const n = src.count;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const raw = readPointAttr(src, name, i) ?? 0;
      const t = Math.min(
        Math.max(span === 0 ? 0 : (raw - inLo) / span, 0),
        1
      );
      data[i] = outLo + sampleFloatCurve(curve, t) * (outHi - outLo);
    }
    return { primary: withPointAttr(src, outName, data, { arity: 1, mode }) };
  },
};
