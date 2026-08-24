import type {
  InputSocketDef,
  NodeDefinition,
  PointAttribute,
  RenderContext,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  copyPointsWith,
  EMPTY_POINTS,
  RESERVED_POINT_ATTR_NAMES,
} from "@/engine/points";

// Set Named Attribute — write a named channel onto points or splines
// (081326_point-attributes.md M2 + M3). The authoring counterpart to the
// Spreadsheet panel: pick a name, a type, a target domain, and a source,
// and every element gains that channel. Downstream nodes carry channels
// automatically; Point Expression reads point channels via attr("name").
//
// Targets: Points (SoA channel on PointsValue.attributes), Spline Anchors
// / Spline Subpaths (object-attached `attrs` on each anchor/subpath — the
// width/driver precedent; spread-copying spline ops carry them free).
// The input socket keeps its shipped name `points` and retypes with the
// target (the set-position resolveInputs pattern), so saved wires hold.
//
// Sources: Constant, Index (0→1 ramp over element order), Random
// (deterministic per-index hash — stable across frames), Image (sample
// the wired image at the element's position: a point's position, an
// anchor's position, a subpath's anchor centroid).
//
// A reserved or empty name passes the input through unchanged.

const KIND_OPTIONS = ["float", "vec2", "vec3", "vec4", "color"] as const;
type Kind = (typeof KIND_OPTIONS)[number];

const TARGET_OPTIONS = [
  "points",
  "spline anchors",
  "spline subpaths",
] as const;
type Target = (typeof TARGET_OPTIONS)[number];

const SOURCE_OPTIONS = ["constant", "index", "random", "image"] as const;
type Source = (typeof SOURCE_OPTIONS)[number];

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
    o.kind === "float" && o.source !== "constant"
      ? o.lo + (o.hi - o.lo) * v
      : v;
  if (o.source === "constant") {
    for (let c = 0; c < o.arity; c++) out[c] = o.constant[c] ?? 0;
  } else if (o.source === "index") {
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

export const setNamedAttributeNode: NodeDefinition = {
  type: "set-named-attribute",
  name: "Set Named Attribute",
  category: "point",
  subcategory: "modifier",
  description:
    "Writes a named channel (a Blender-style attribute) onto points, spline anchors, or spline subpaths: pick a name, a type, and a source — a constant, a 0→1 ramp over element order, a stable per-element random, or an image sampled at each element's position. Channels flow through downstream nodes, show as columns in the Spreadsheet panel, and point channels read back in Point Expression via attr(\"name\"). Reserved names (the built-in x/y/index/rotation/scale/group columns) pass through unchanged.",
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
      if (!name || RESERVED_POINT_ATTR_NAMES.has(name)) {
        return { primary: src, aux };
      }
      const n = src.count;
      const data = new Float32Array(n * arity);
      const pos: [number, number] = [0, 0];
      for (let i = 0; i < n; i++) {
        pos[0] = src.positions[i * 2];
        pos[1] = src.positions[i * 2 + 1];
        const v = valueAt(opts, i, n, pos);
        for (let c = 0; c < arity; c++) data[i * arity + c] = v[c];
      }
      const attr: PointAttribute = {
        arity: ARITY[kind],
        color: kind === "color" ? true : undefined,
        data,
      };
      return {
        primary: copyPointsWith(src, {
          attributes: { ...src.attributes, [name]: attr },
        }),
      };
    }

    // Spline targets. Values store as number (float) / number[] on the
    // object-attached `attrs` (no color tag on splines — the spreadsheet
    // shows these numerically).
    if (!src || src.kind !== "spline") {
      return { primary: { kind: "spline", subpaths: [] } as SplineValue, aux };
    }
    if (!name || RESERVED_POINT_ATTR_NAMES.has(name)) {
      return { primary: src };
    }
    const store = (v: number[]): number | number[] =>
      arity === 1 ? v[0] : v;
    if (target === "spline subpaths") {
      const nSub = src.subpaths.length;
      const subpaths = src.subpaths.map((sub, i) => ({
        ...sub,
        attrs: {
          ...sub.attrs,
          [name]: store(valueAt(opts, i, nSub, subpathCentroid(sub))),
        },
      }));
      return { primary: { kind: "spline", subpaths } as SplineValue, aux };
    }
    // spline anchors — index runs across ALL anchors in subpath order,
    // matching the spreadsheet's row order.
    let total = 0;
    for (const sub of src.subpaths) total += sub.anchors.length;
    let row = 0;
    const subpaths = src.subpaths.map((sub) => ({
      ...sub,
      anchors: sub.anchors.map((a) => ({
        ...a,
        attrs: {
          ...a.attrs,
          [name]: store(valueAt(opts, row++, total, a.pos)),
        },
      })),
    }));
    return { primary: { kind: "spline", subpaths } as SplineValue, aux };
  },
};
