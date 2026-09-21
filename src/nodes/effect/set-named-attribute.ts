import type {
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  EMPTY_POINTS,
  isWritablePointAttr,
  withPointAttr,
  type PointAttrWriteMode,
} from "@/engine/points";
import { readSubpathAttr, withSubpathAttr } from "@/engine/spline-attrs";

// Set Named Attribute — write an attribute onto points or splines by name
// (081326_point-attributes.md M2 + M3; 092026_unified-attributes.md). The
// authoring counterpart to the Spreadsheet panel: pick a name, a type, a
// target domain, and a source, and every element gains that value.
//
// The name is ANY attribute. A named channel (`weight`, `color`) lands in
// PointsValue.attributes / the anchor or subpath `attrs`; a built-in name
// (`scale`, `scale.x`, `rotation`, `x`, `y`, `group`; `group` / `driver`
// on subpaths) lands in the element's own transform data through the
// unified attribute API, so "index → scale" is one node. `index`, `z` and
// normals are read-only and pass the input through (the name field tints).
//
// Targets: Points (SoA channel on PointsValue.attributes), Spline Anchors
// / Spline Subpaths (object-attached `attrs` on each anchor/subpath — the
// width/driver precedent; spread-copying spline ops carry them free).
// The input socket keeps its shipped name `points` and retypes with the
// target (the set-position resolveInputs pattern), so saved wires hold.
//
// Sources: Constant, Index (0→1 ramp over element order, remapped lo..hi),
// Exponential (the geometric ramp lo · (hi/lo)^t — a scale ladder in one
// node; falls back to the linear ramp when lo/hi straddle zero), Random
// (deterministic per-index hash — stable across frames), Image (sample the
// wired image at the element's position: a point's position, an anchor's
// position, a subpath's anchor centroid).
//
// Mode: set replaces; multiply / add combine with the element's current
// value (a built-in's default where absent — scale 1, rotation 0; a
// missing channel reads as the op's identity).

const KIND_OPTIONS = ["float", "vec2", "vec3", "vec4", "color"] as const;
type Kind = (typeof KIND_OPTIONS)[number];

const TARGET_OPTIONS = [
  "points",
  "spline anchors",
  "spline subpaths",
] as const;
type Target = (typeof TARGET_OPTIONS)[number];

const SOURCE_OPTIONS = [
  "constant",
  "index",
  "exponential",
  "random",
  "image",
] as const;
type Source = (typeof SOURCE_OPTIONS)[number];

const MODE_OPTIONS = ["set", "multiply", "add"] as const;

const ARITY: Record<Kind, 1 | 2 | 3 | 4> = {
  float: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  color: 4,
};

function innerTypeFor(target: Target): SocketType {
  return target === "points" ? "points" : "spline";
}

// Frame-independent per-seed hash → [0,1) — triple32 (Wellons), the same
// primitive Point Expression's rand() uses, so Random channels are stable
// across frames and the node caches statically.
function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

// Straight-alpha hex → [0,1] rgba. Handles the color param's canonical
// 6-digit form and its 8-digit #rrggbbaa form while translucent.
function hexToRgba01(hex: string): [number, number, number, number] {
  const h = hex.replace(/^#/, "");
  const read = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  if (h.length >= 6) {
    const a = h.length >= 8 ? read(6) : 1;
    const r = read(0);
    const g = read(2);
    const b = read(4);
    if ([r, g, b, a].every((v) => Number.isFinite(v))) return [r, g, b, a];
  }
  return [1, 1, 1, 1];
}

interface ImageBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function readImage(
  ctx: RenderContext,
  img: { texture: WebGLTexture; width: number; height: number }
): ImageBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  const data = ctx.readImagePixels({
    kind: "image",
    texture: img.texture,
    width: img.width,
    height: img.height,
  });
  if (!data) return null;
  return { data, w: img.width, h: img.height };
}

// Sample rgba (straight, [0,1]) at authored-space (u, v) — nearest texel,
// the Sample Texture at Points convention.
function sampleRgba(
  buf: ImageBuffer,
  u: number,
  v: number
): [number, number, number, number] {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  const i = (py * buf.w + px) * 4;
  return [
    buf.data[i] / 255,
    buf.data[i + 1] / 255,
    buf.data[i + 2] / 255,
    buf.data[i + 3] / 255,
  ];
}

function luminance(rgba: [number, number, number, number]): number {
  return 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2];
}

interface ValueOpts {
  kind: Kind;
  source: Source;
  arity: number;
  constant: number[];
  seedBase: number;
  lo: number;
  hi: number;
  buf: ImageBuffer | null;
}

// lo · (hi/lo)^t — the geometric ramp. Only defined when lo and hi share a
// sign and neither is 0; otherwise the linear lerp so a slider dragged
// through zero degrades instead of producing NaN.
export function geometricRamp(lo: number, hi: number, t: number): number {
  if (lo !== 0 && hi !== 0 && Math.sign(lo) === Math.sign(hi)) {
    return lo * Math.pow(hi / lo, t);
  }
  return lo + (hi - lo) * t;
}

// The per-element value, shared across all three targets. `pos` is the
// element's authored-space sample position (image source only).
function valueAt(
  o: ValueOpts,
  i: number,
  nRows: number,
  pos: [number, number]
): number[] {
  const out = new Array<number>(o.arity).fill(0);
  const remap = (v: number) =>
    o.kind !== "float" || o.source === "constant"
      ? v
      : o.source === "exponential"
        ? geometricRamp(o.lo, o.hi, v)
        : o.lo + (o.hi - o.lo) * v;
  if (o.source === "constant") {
    for (let c = 0; c < o.arity; c++) out[c] = o.constant[c] ?? 0;
  } else if (o.source === "index" || o.source === "exponential") {
    const t = remap(nRows > 1 ? i / (nRows - 1) : 0);
    for (let c = 0; c < o.arity; c++) out[c] = t;
    if (o.kind === "color") out[3] = 1;
  } else if (o.source === "random") {
    for (let c = 0; c < o.arity; c++) {
      out[c] = remap(hash01(o.seedBase ^ (i * 4 + c)));
    }
    if (o.kind === "color") out[3] = 1;
  } else if (o.buf) {
    const rgba = sampleRgba(o.buf, pos[0], pos[1]);
    if (o.kind === "float") out[0] = remap(luminance(rgba));
    else for (let c = 0; c < o.arity; c++) out[c] = rgba[c];
  }
  return out;
}

function subpathCentroid(sub: SplineSubpath): [number, number] {
  const n = sub.anchors.length;
  if (n === 0) return [0.5, 0.5];
  let cx = 0;
  let cy = 0;
  for (const a of sub.anchors) {
    cx += a.pos[0];
    cy += a.pos[1];
  }
  return [cx / n, cy / n];
}

// Object-attr combine for the spline targets: componentwise against the
// current value (missing → the op's identity), stored as number for arity
// 1 and number[] otherwise (spline-attrs' number | number[] convention).
function combineObj(
  cur: number | number[] | undefined,
  v: number[],
  mode: PointAttrWriteMode
): number | number[] {
  const out = v.slice();
  if (mode !== "set") {
    const c = cur === undefined ? [] : Array.isArray(cur) ? cur : [cur];
    const id = mode === "multiply" ? 1 : 0;
    for (let k = 0; k < out.length; k++) {
      const x = typeof c[k] === "number" ? c[k] : id;
      out[k] = mode === "multiply" ? x * out[k] : x + out[k];
    }
  }
  return out.length === 1 ? out[0] : out;
}

export const setNamedAttributeNode: NodeDefinition = {
  type: "set-named-attribute",
  name: "Set Named Attribute",
  category: "point",
  subcategory: "modifier",
  description:
    "Writes an attribute by name onto points, spline anchors, or spline subpaths: pick a name, a type, and a source — a constant, a 0→1 ramp over element order (linear or exponential lo→hi), a stable per-element random, or an image sampled at each element's position. Set replaces the value; multiply / add combine with what the element already has. A named channel flows through downstream nodes, shows as a column in the Spreadsheet panel, and reads back in Point Expression via attr(\"name\"); a built-in name (scale, scale.x, rotation, x, y, group — group or driver on subpaths) writes the element's own transform data directly, so index → scale needs no Map Attribute. index, z and normals are read-only and pass the input through.",
  facts: {
    space: { "in:points": "canvas01", out: "in:points" },
    writes: ["attr:scale", "attr:rotation", "attr:position", "attr:group", "attr:driver"],
    gotchas: [
      "attr_name is any attribute: a channel, or a built-in (scale, scale.x, rotation, x, y, group) landing in the point's own data. Empty or read-only (index, z, nx/ny/nz) passes the input through.",
      "target=points writes PointsValue.attributes (the typed array for a built-in); spline anchors/subpaths write object-attached attrs. On subpaths group is groupIndex, driver is what ramps read.",
      "source=image samples nearest-texel at each element's own position (point, anchor, or subpath centroid) — float kind uses luminance, vec/color kinds use RGBA.",
      "index, exponential and random remap through lo/hi only when kind=float; other kinds use the raw [0,1) value. exponential is lo·(hi/lo)^t and falls back to linear when lo/hi straddle or touch zero.",
      "source=random is a deterministic hash keyed on seed and element index, not Math.random, so it's stable across frames and re-evaluations.",
      "mode=multiply / add combine with the current value: an absent built-in reads its default (scale 1, rotation 0), a missing channel the op's identity. A float into scale fills both lanes; group rounds.",
      "The `name` aux output is the channel's name as a string, meant to be wired into another node's attribute-name param so a rename here ripples downstream.",
    ],
  },
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "image", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const target = ((params.target as string) ?? "points") as Target;
    return [
      {
        name: "points",
        type: innerTypeFor(target),
        required: true,
        label: target === "points" ? "Points" : "Spline",
      },
      { name: "image", type: "image", required: false },
    ];
  },
  params: [
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      // Shown by the on-node text field (EffectNode's STRING_INPUT_PARAMS
      // renders this param on the node body — the name IS the node).
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      // Offer the writable built-ins alongside the upstream channels;
      // index / z / normals tint red.
      suggestAttrsIncludeBuiltins: true,
      suggestAttrsBuiltinFilter: isWritablePointAttr,
    },
    {
      name: "target",
      label: "Target",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "points",
    },
    {
      name: "kind",
      label: "Type",
      type: "enum",
      options: KIND_OPTIONS as unknown as string[],
      default: "float",
    },
    {
      name: "source",
      label: "Source",
      type: "enum",
      options: SOURCE_OPTIONS as unknown as string[],
      default: "constant",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODE_OPTIONS as unknown as string[],
      default: "set",
    },
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.kind === "float" && p.source === "constant",
    },
    {
      name: "value_vec",
      label: "Value",
      type: "vec4",
      default: [0, 0, 0, 0],
      visibleIf: (p) =>
        (p.kind === "vec2" || p.kind === "vec3" || p.kind === "vec4") &&
        p.source === "constant",
    },
    {
      name: "color",
      label: "Color",
      type: "color",
      alpha: true,
      default: "#ffffff",
      visibleIf: (p) => p.kind === "color" && p.source === "constant",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      softMax: 100,
      step: 1,
      default: 0,
      visibleIf: (p) => p.source === "random",
    },
    {
      name: "lo",
      label: "Lo",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) =>
        p.kind === "float" && p.source !== "constant",
    },
    {
      name: "hi",
      label: "Hi",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 1,
      visibleIf: (p) =>
        p.kind === "float" && p.source !== "constant",
    },
  ],
  primaryOutput: "points",
  resolvePrimaryOutput(params): SocketType {
    return innerTypeFor(((params.target as string) ?? "points") as Target);
  },
  // The channel's NAME as a string — the reference wire. Drop it on any
  // exposed attribute-name param downstream (Map Attribute, Filter,
  // Copy-to-Points' tint, another Set Named Attribute) and renames here
  // ripple through every consumer; the data itself rides the points wire
  // (081326_point-attributes.md M4).
  auxOutputs: [{ name: "name", type: "string" }],

  compute({ inputs, params, ctx }) {
    const target = ((params.target as string) ?? "points") as Target;
    const src = inputs.points;
    const name = ((params.attr_name as string) ?? "").trim();
    const aux = { name: { kind: "string", value: name } as const };
    const kind = ((params.kind as string) ?? "float") as Kind;
    const source = ((params.source as string) ?? "constant") as Source;
    const mode = (
      (MODE_OPTIONS as readonly string[]).includes(params.mode as string)
        ? params.mode
        : "set"
    ) as PointAttrWriteMode;
    const arity = ARITY[kind];

    let constant: number[] = [];
    if (source === "constant") {
      if (kind === "float") constant = [(params.value as number) ?? 1];
      else if (kind === "color")
        constant = hexToRgba01((params.color as string) ?? "#ffffff");
      else
        constant = ((params.value_vec as number[]) ?? [0, 0, 0, 0]).slice(
          0,
          arity
        );
    }
    const img = inputs.image;
    const opts: ValueOpts = {
      kind,
      source,
      arity,
      constant,
      seedBase: Math.imul(
        Math.floor((params.seed as number) ?? 0) + 1,
        0x9e3779b9
      ),
      lo: (params.lo as number) ?? 0,
      hi: (params.hi as number) ?? 1,
      buf:
        source === "image" && img && img.kind === "image"
          ? readImage(ctx, img)
          : null,
    };

    if (target === "points") {
      if (!src || src.kind !== "points") return { primary: EMPTY_POINTS, aux };
      if (!isWritablePointAttr(name)) return { primary: src, aux };
      const n = src.count;
      const data = new Float32Array(n * arity);
      const pos: [number, number] = [0, 0];
      for (let i = 0; i < n; i++) {
        pos[0] = src.positions[i * 2];
        pos[1] = src.positions[i * 2 + 1];
        const v = valueAt(opts, i, n, pos);
        for (let c = 0; c < arity; c++) data[i * arity + c] = v[c];
      }
      return {
        primary: withPointAttr(src, name, data, {
          arity,
          mode,
          color: kind === "color" ? true : undefined,
        }),
        aux,
      };
    }

    // Spline targets. Values store as number (float) / number[] on the
    // object-attached `attrs` (no color tag on splines — the spreadsheet
    // shows these numerically).
    if (!src || src.kind !== "spline") {
      return { primary: { kind: "spline", subpaths: [] } as SplineValue, aux };
    }
    if (!name) return { primary: src, aux };
    if (target === "spline subpaths") {
      const nSub = src.subpaths.length;
      const subpaths = src.subpaths.map((sub, i) =>
        withSubpathAttr(
          sub,
          name,
          combineObj(
            readSubpathAttr(sub, name),
            valueAt(opts, i, nSub, subpathCentroid(sub)),
            mode
          )
        )
      );
      return { primary: { kind: "spline", subpaths } as SplineValue, aux };
    }
    // spline anchors — index runs across ALL anchors in subpath order,
    // matching the spreadsheet's row order. Anchors have no built-in
    // schema, so every name is an anchor channel.
    let total = 0;
    for (const sub of src.subpaths) total += sub.anchors.length;
    let row = 0;
    const subpaths = src.subpaths.map((sub) => ({
      ...sub,
      anchors: sub.anchors.map((a) => ({
        ...a,
        attrs: {
          ...a.attrs,
          [name]: combineObj(
            a.attrs?.[name] ?? sub.attrs?.[name],
            valueAt(opts, row++, total, a.pos),
            mode
          ),
        },
      })),
    }));
    return { primary: { kind: "spline", subpaths } as SplineValue, aux };
  },
};
