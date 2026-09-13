import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SocketType,
} from "@/engine/types";
import {
  copyPointsWith,
  gatherPoints,
  makePoints,
  RESERVED_POINT_ATTR_NAMES,
} from "@/engine/points";

// Keep or discard points by predicate. Four modes:
//
//   bbox:   keep points whose (x, y) falls inside the [x_min..x_max] ×
//           [y_min..y_max] window. Invert flips inside ↔ outside.
//
//   mask:   sample an image's luminance at each point's position; keep
//           points where the value is ≥ threshold. Invert flips the
//           comparison so the mask's dark areas keep instead.
//
//   index:  keep points by their position in the incoming array. Select
//           picks the predicate: every Nth (Every + Offset — the original
//           decimation), a single Equal index, an inclusive Range, First,
//           Last, or First and last. Invert drops that set.
//
//   random: keep a random SUBSET, but stably. Each point's keep/drop is a
//           frame-independent hash of its index, so points don't flicker in
//           and out — raising Amount only ever REVEALS more of the same
//           points (monotonic), and Seed re-rolls which points are chosen
//           without changing the count. Same hash as Point Expression's
//           `rand(index)`, so the two nodes agree. This is the fix for the
//           classic per-frame-random shimmer.
//
//   attribute: keep points whose named channel (component 0) is ≥
//           Threshold — the consumption half of the attribute system
//           (081326_point-attributes.md M4). Space-blind; a missing
//           channel passes through unchanged.
//
// Result compact (default) drops unmatched points — output count is
// unbounded by the input, empty is valid. Result flag writes a 0/1
// float channel (default `keep`) and leaves every point in place, so
// downstream Map Attribute / Copy to Points / Filter attribute-mode can
// consume the selection without a topology change. Invert flips the
// predicate before either compacting or writing the flag.
//
// Per-point attributes (scale / rotation / groupIndex) are preserved
// for the kept points; in compact mode their indices in the output are
// sequential starting at 0 (i.e. the input order is kept, gaps closed
// up). Flag mode does not renumber.
//
// Stability note (index/random): both key off the point's INDEX, so a
// fixed upstream point set stays put frame-to-frame. If the incoming count
// changes, which indices exist changes with it.
//
// 3D upgrade (081026 spec §2.3) — the polymorphic in-place pattern for
// point utilities: the `points` input accepts points OR points3d
// (editorCanCoerce exception; the node is in CONNECTED_TYPE_RETYPE_NODES
// so the stored sockets track the wire), and the output re-advertises the
// input's type. On a 3D input, bbox switches to the WORLD-space box rows
// (wx/wy/wz, default −10..10 = keep everything — the 2D rows' [0..1]
// authored defaults would clip an origin-centered world cloud), index and
// random work unchanged (count-based, space-blind), and mask passes
// through untouched (it samples authored space, which 3D points don't
// live in — threshold row hides to signal it). Compaction goes through
// typed arrays only, carrying z + normals — never the 2D Point[] view.

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

function sampleLuma(buf: ImageBuffer, u: number, v: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  const i = (py * buf.w + px) * 4;
  return (
    (0.2126 * buf.data[i] +
      0.7152 * buf.data[i + 1] +
      0.0722 * buf.data[i + 2]) /
    255
  );
}

// Frame-independent per-seed hash → [0,1). triple32 (Wellons) — strong
// avalanche on sequential integer seeds (0,1,2,…), our exact input pattern.
// Byte-for-byte the "Random Value hashed on Index" primitive Point
// Expression exposes as `rand()`, so a Filter Points "random" cull and an
// expression `keep = rand(index) < amount` select the identical points.
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

const MODES = ["bbox", "mask", "index", "random", "attribute"] as const;
type Mode = (typeof MODES)[number];

const INDEX_BY = [
  "every",
  "equal",
  "range",
  "first",
  "last",
  "first and last",
] as const;
type IndexBy = (typeof INDEX_BY)[number];

const RESULTS = ["compact", "flag"] as const;
type Result = (typeof RESULTS)[number];

function indexHit(
  i: number,
  n: number,
  by: IndexBy,
  every: number,
  offset: number,
  equal: number,
  rangeMin: number,
  rangeMax: number
): boolean {
  switch (by) {
    case "equal":
      return i === equal;
    case "range": {
      const lo = Math.min(rangeMin, rangeMax);
      const hi = Math.max(rangeMin, rangeMax);
      return i >= lo && i <= hi;
    }
    case "first":
      return i === 0;
    case "last":
      return n > 0 && i === n - 1;
    case "first and last":
      return n > 0 && (i === 0 || i === n - 1);
    default: {
      // every — floor-mod so negative offsets still land on a residue.
      return (((i + offset) % every) + every) % every === 0;
    }
  }
}

function emptyPoints(is3d: boolean): PointsValue {
  // Mirror the input's dimensionality so downstream consumers see a
  // consistent shape (a 3D-empty keeps its z array ⇒ is3DPoints holds).
  if (is3d) return makePoints(0, { withZ: true });
  return {
    kind: "points",
    count: 0,
    positions: new Float32Array(0),
    points: [],
  };
}

// One world-space box row (3D bbox). Full-range default = keep everything.
function worldRow(
  name: string,
  label: string,
  def: number
): NodeDefinition["params"][number] {
  return {
    name,
    label,
    type: "scalar",
    min: -10,
    max: 10,
    step: 0.01,
    default: def,
    visibleIf: (p, meta) =>
      p.mode === "bbox" && meta?.inputTypes?.points === "points3d",
  };
}

export const filterPointsNode: NodeDefinition = {
  type: "filter-points",
  name: "Filter Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Keep or discard points by predicate, or write the predicate as a 0/1 flag and leave every point in place. Bbox keeps points inside an XY window; Mask keeps points where the wired image's luminance is ≥ threshold; Index selects by array position (every Nth, a single index, a range, first, last, or first and last); Random keeps a stable random subset (hashed on index, so points don't flicker in/out — raising Amount reveals more of the same points, Seed re-rolls the selection). Invert flips which side is kept. Result compact drops the rest; flag writes a named 0/1 channel (default keep). Also accepts 3D points (from 3D Scatter Points): bbox becomes a world-space box with Z rows, index/random work identically, mask passes through.",
  facts: {
    space: {
      "in:points": ["canvas01", "world3d"],
      out: "in:points",
      "param:x_min": "canvas01",
      "param:x_max": "canvas01",
      "param:y_min": "canvas01",
      "param:y_max": "canvas01",
      "param:wx_min": "world3d",
      "param:wx_max": "world3d",
      "param:wy_min": "world3d",
      "param:wy_max": "world3d",
      "param:wz_min": "world3d",
      "param:wz_max": "world3d",
    },
    writes: ["attr:keep"],
    gotchas: [
      "points is polymorphic: a points3d wire switches bbox to world-space X/Y/Z rows (wx/wy/wz, default −10..10) and hides the 2D X/Y rows and the mask threshold.",
      "mask mode ignores a points3d input entirely (authored-space sampling has no meaning for world points) and passes it through unchanged, same as an unwired mask on 2D input.",
      "attribute mode compares a named channel's component 0 against attr_threshold; a missing channel passes every point through unchanged instead of dropping them.",
      "index_by (index mode) selects every-Nth, a single index, an inclusive range, first, last, or first and last; invert flips the predicate before compacting or writing the flag.",
      "result=flag writes a 0/1 float channel named flag_name (default keep) and leaves count unchanged; result=compact drops unmatched points and renumbers survivors from 0.",
      "index/random key off each point's position in the incoming array, not any stored identity, so a changed upstream count changes which points survive.",
      "random mode's hash matches Point Expression's rand(index) byte-for-byte (seed 0 == hash01(index)), so an equivalent expression selects the identical subset.",
      "Compact mode carries scale/rotation/group and named attributes through gatherPoints; flag mode overlays flag_name on the existing cloud without gathering.",
    ],
  },
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "mask", type: "image", required: false, label: "Mask" },
  ],
  // Polymorphic `points` input: adopts points3d when a 3D wire lands
  // (editorCanCoerce lets it land; CONNECTED_TYPE_RETYPE_NODES keeps the
  // stored sockets in sync). The mask input STAYS visible on 3D — hiding
  // it would orphan an existing mask edge — it's just ignored there.
  resolveInputs(params, ctx): InputSocketDef[] {
    const t: SocketType =
      ctx?.connectedTypes?.points === "points3d" ? "points3d" : "points";
    return [
      { name: "points", type: t, required: true },
      { name: "mask", type: "image", required: false, label: "Mask" },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "bbox",
    },
    // attribute mode: keep points whose named channel (component 0) is
    // ≥ threshold — space-blind, so it works on 2D and 3D alike
    // (081326_point-attributes.md M4).
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      visibleIf: (p) => p.mode === "attribute",
    },
    {
      name: "attr_threshold",
      label: "Threshold",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "attribute",
    },
    {
      name: "x_min",
      label: "X min",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0,
      visibleIf: (p, meta) =>
        p.mode === "bbox" && meta?.inputTypes?.points !== "points3d",
    },
    {
      name: "x_max",
      label: "X max",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p, meta) =>
        p.mode === "bbox" && meta?.inputTypes?.points !== "points3d",
    },
    {
      name: "y_min",
      label: "Y min",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0,
      visibleIf: (p, meta) =>
        p.mode === "bbox" && meta?.inputTypes?.points !== "points3d",
    },
    {
      name: "y_max",
      label: "Y max",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p, meta) =>
        p.mode === "bbox" && meta?.inputTypes?.points !== "points3d",
    },
    // World-space box rows — the 3D input's bbox (081026 spec §2.3).
    worldRow("wx_min", "X min", -10),
    worldRow("wx_max", "X max", 10),
    worldRow("wy_min", "Y min", -10),
    worldRow("wy_max", "Y max", 10),
    worldRow("wz_min", "Z min", -10),
    worldRow("wz_max", "Z max", 10),
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      // Hidden on 3D input: mask sampling is authored-space, so mask mode
      // passes 3D points through untouched.
      visibleIf: (p, meta) =>
        p.mode === "mask" && meta?.inputTypes?.points !== "points3d",
    },
    {
      name: "index_by",
      label: "Select",
      type: "enum",
      options: INDEX_BY as unknown as string[],
      default: "every",
      visibleIf: (p) => p.mode === "index",
    },
    {
      // index mode: keep 1 of every N points.
      name: "every",
      label: "Keep 1 of every",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 10,
      step: 1,
      default: 2,
      visibleIf: (p) =>
        p.mode === "index" && ((p.index_by as string) ?? "every") === "every",
    },
    {
      // index mode: phase — which residue class survives.
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 10,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.mode === "index" && ((p.index_by as string) ?? "every") === "every",
    },
    {
      name: "index_value",
      label: "Index",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 64,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "index" && p.index_by === "equal",
    },
    {
      name: "index_min",
      label: "From",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 64,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "index" && p.index_by === "range",
    },
    {
      name: "index_max",
      label: "To",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 64,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "index" && p.index_by === "range",
    },
    {
      // random mode: fraction kept. Monotonic — raising this only ever adds
      // points, so dragging it feels like a stable reveal, not a reshuffle.
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "random",
    },
    {
      // random mode: re-roll WHICH points are kept (not how many).
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
    {
      name: "result",
      label: "Result",
      type: "enum",
      options: RESULTS as unknown as string[],
      default: "compact",
    },
    {
      name: "flag_name",
      label: "Flag",
      type: "string",
      default: "keep",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      visibleIf: (p) => p.result === "flag",
    },
  ],
  primaryOutput: "points",
  // Filtered stream re-advertises whatever came in.
  resolvePrimaryOutput(params, ctx): SocketType {
    return ctx?.connectedTypes?.points === "points3d" ? "points3d" : "points";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") {
      return { primary: emptyPoints(false) };
    }

    const is3d = src.z !== undefined;
    const mode = ((params.mode as string) ?? "bbox") as Mode;
    const invert = !!params.invert;
    const result = ((params.result as string) ?? "compact") as Result;
    const n = src.count;

    // Build a per-point keep mask, then either compact or stamp a flag.
    const keep = new Uint8Array(n);
    let keepCount = 0;
    const mark = (i: number, pred: boolean) => {
      const k = invert ? !pred : pred;
      if (k) {
        keep[i] = 1;
        keepCount++;
      }
    };

    if (mode === "bbox" && is3d) {
      // World-space box. Guaranteed-present z (is3d) read from src.z.
      const z = src.z!;
      const lo = [
        (params.wx_min as number) ?? -10,
        (params.wy_min as number) ?? -10,
        (params.wz_min as number) ?? -10,
      ];
      const hi = [
        (params.wx_max as number) ?? 10,
        (params.wy_max as number) ?? 10,
        (params.wz_max as number) ?? 10,
      ];
      for (let a = 0; a < 3; a++) {
        if (lo[a] > hi[a]) {
          const t = lo[a];
          lo[a] = hi[a];
          hi[a] = t;
        }
      }
      for (let i = 0; i < n; i++) {
        const x = src.positions[i * 2];
        const y = src.positions[i * 2 + 1];
        mark(
          i,
          x >= lo[0] && x <= hi[0] &&
            y >= lo[1] && y <= hi[1] &&
            z[i] >= lo[2] && z[i] <= hi[2]
        );
      }
    } else if (mode === "bbox") {
      const xMin = (params.x_min as number) ?? 0;
      const xMax = (params.x_max as number) ?? 1;
      const yMin = (params.y_min as number) ?? 0;
      const yMax = (params.y_max as number) ?? 1;
      const lo = Math.min(xMin, xMax);
      const hi = Math.max(xMin, xMax);
      const tlo = Math.min(yMin, yMax);
      const thi = Math.max(yMin, yMax);
      for (let i = 0; i < n; i++) {
        const x = src.positions[i * 2];
        const y = src.positions[i * 2 + 1];
        mark(i, x >= lo && x <= hi && y >= tlo && y <= thi);
      }
    } else if (mode === "index") {
      const by = ((params.index_by as string) ?? "every") as IndexBy;
      const every = Math.max(1, Math.round((params.every as number) ?? 2));
      const offset = Math.round((params.offset as number) ?? 0);
      const equal = Math.round((params.index_value as number) ?? 0);
      const rangeMin = Math.round((params.index_min as number) ?? 0);
      const rangeMax = Math.round((params.index_max as number) ?? 0);
      for (let i = 0; i < n; i++) {
        mark(i, indexHit(i, n, by, every, offset, equal, rangeMin, rangeMax));
      }
    } else if (mode === "random") {
      const amount = Math.max(0, Math.min(1, (params.amount as number) ?? 0.5));
      const seed = Math.round((params.seed as number) ?? 0);
      // Mix the seed in strongly so adjacent seeds give unrelated selections.
      // seed 0 collapses to hash01(index) == Point Expression's rand(index).
      const seedMix = Math.imul(seed, 0x9e3779b1);
      for (let i = 0; i < n; i++) {
        // Strict `<`: amount 0 keeps nothing, amount 1 keeps everything.
        mark(i, hash01(i ^ seedMix) < amount);
      }
    } else if (mode === "attribute") {
      const name = ((params.attr_name as string) ?? "").trim();
      const attr = name ? src.attributes?.[name] : undefined;
      // No such channel — pass through unchanged, same grammar as an
      // unwired mask (the red name-field tint already explains why).
      if (!attr) return { primary: src };
      const threshold = (params.attr_threshold as number) ?? 0.5;
      const k = attr.arity;
      for (let i = 0; i < n; i++) {
        mark(i, attr.data[i * k] >= threshold);
      }
    } else {
      // mask mode
      if (is3d) {
        // Authored-space sampling has no meaning for world-space points —
        // pass through unchanged (threshold row is hidden to signal it).
        return { primary: src };
      }
      const maskImg = inputs.mask;
      if (!maskImg || maskImg.kind !== "image") {
        // No mask wired — pass through unchanged so the user can wire it.
        return { primary: src };
      }
      const threshold = (params.threshold as number) ?? 0.5;
      const buf = readImage(ctx, maskImg);
      if (!buf) return { primary: src };
      for (let i = 0; i < n; i++) {
        const x = src.positions[i * 2];
        const y = src.positions[i * 2 + 1];
        mark(i, sampleLuma(buf, x, y) >= threshold);
      }
    }

    if (result === "flag") {
      const flagName = ((params.flag_name as string) ?? "keep").trim();
      if (!flagName || RESERVED_POINT_ATTR_NAMES.has(flagName)) {
        return { primary: src };
      }
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = keep[i] ? 1 : 0;
      return {
        primary: copyPointsWith(src, {
          attributes: { ...src.attributes, [flagName]: { arity: 1, data } },
        }),
      };
    }

    if (keepCount === n) return { primary: src };
    if (keepCount === 0) return { primary: emptyPoints(is3d) };

    // gatherPoints carries every channel — the fixed arrays AND named
    // attributes — through one index map (this loop used to hand-gather
    // and silently dropped attributes).
    const map = new Int32Array(keepCount);
    let w = 0;
    for (let i = 0; i < n; i++) if (keep[i]) map[w++] = i;
    return { primary: gatherPoints(src, map) };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`filter-points:${nodeId}`];
  },
};
