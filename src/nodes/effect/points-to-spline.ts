import type {
  NodeDefinition,
  PointsValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { catmullRomSubpath } from "@/engine/spline-math";
import { namedAttrsAt, type ObjectAttrs } from "@/engine/spline-attrs";

// Points to Spline — chain a points value into spline subpaths. The inverse
// of Points on Path / the ordered sibling of Connect Points (which pairs by
// proximity instead of order).
//
// `layout` picks the walk:
//   chain (default) — index order, split by groupIndex. Each distinct group
//     becomes one subpath; wholly untagged input becomes one untagged
//     subpath. Groups with fewer than 2 points emit nothing.
//   grid — lattice walk. `gridWalk` picks rows (left-to-right), columns
//     (top-to-bottom), or both (default: rows then columns). A Grid (or
//     any row-major lattice) stays a grid after a warp. Lattice coords
//     come from Grid's `ix`/`iy` attributes when present; otherwise
//     `columns` is the row-major width. Each input group is latticed on
//     its own. `closed` is ignored (open polylines).
//   stride — every `stride` consecutive points (index order) become one
//     subpath. Non-overlapping windows; a leftover shorter than k is
//     dropped. Default k=2 is pairs — the inverse of tagging
//     `groupIndex = floor(index/2)` then chaining. Each input group is
//     windowed on its own. `closed` applies per window.
//   zip — pair corresponding points across groupIndex groups: emit one
//     subpath per index connecting group0[i] → group1[i] → … Length is
//     the shortest group (extras dropped). Two curves Collect'd together
//     then zipped is "connect corresponding points." `closed` applies
//     per zipper line.
//
// `curve` picks the anchor style: linear = corner anchors (polyline),
// smooth = catmull-rom auto handles through every point (same math as
// Spiral / Sine Wave). Chain Set Spline Type to change your mind later.
//
// Spec: specdocs/archive/071026_spline-points-nodes.md.

type V2 = [number, number];

type LatticeSlot = { along: number; i: number };

function groupedIndices(src: PointsValue): {
  key: number | undefined;
  indices: number[];
}[] {
  const groups = src.groupIndices;
  const runs = new Map<number | undefined, number[]>();
  for (let i = 0; i < src.count; i++) {
    const key = groups ? groups[i] : undefined;
    let run = runs.get(key);
    if (!run) {
      run = [];
      runs.set(key, run);
    }
    run.push(i);
  }
  const keys = Array.from(runs.keys()).sort(
    (a, b) => (a ?? -Infinity) - (b ?? -Infinity)
  );
  return keys.map((key) => ({ key, indices: runs.get(key)! }));
}

function scalarAttr(src: PointsValue, name: string): Float32Array | null {
  const attr = src.attributes?.[name];
  if (!attr || attr.arity !== 1 || attr.data.length < src.count) return null;
  return attr.data;
}

function attrsAlong(
  src: PointsValue,
  indices: number[]
): Array<ObjectAttrs | undefined> | undefined {
  if (!src.attributes) return undefined;
  return indices.map((i) => namedAttrsAt(src.attributes, i));
}

function attachAnchorAttrs(
  sub: SplineSubpath,
  attrs: Array<ObjectAttrs | undefined> | undefined
): void {
  if (!attrs) return;
  const n = Math.min(sub.anchors.length, attrs.length);
  for (let i = 0; i < n; i++) {
    const a = attrs[i];
    if (a) sub.anchors[i].attrs = a;
  }
}

function emitPath(
  pts: V2[],
  smooth: boolean,
  closed: boolean,
  groupIndex: number | undefined,
  pointAttrs?: Array<ObjectAttrs | undefined>
): SplineSubpath | null {
  if (pts.length < 2) return null;
  const sub: SplineSubpath = smooth
    ? catmullRomSubpath(pts, closed)
    : { anchors: pts.map((p) => ({ pos: p })), closed };
  if (groupIndex !== undefined) sub.groupIndex = groupIndex;
  attachAnchorAttrs(sub, pointAttrs);
  return sub;
}

function sortSlots(slots: LatticeSlot[]): LatticeSlot[] {
  return slots.sort((a, b) => a.along - b.along || a.i - b.i);
}

function emitGridGroup(
  src: PointsValue,
  indices: number[],
  columns: number,
  walk: "rows" | "columns" | "both",
  smooth: boolean,
  nextGroup: { n: number },
  subpaths: SplineSubpath[]
) {
  const pos = src.positions;
  const ix = scalarAttr(src, "ix");
  const iy = scalarAttr(src, "iy");
  const useAttr = !!(ix && iy);
  const nCols = Math.max(1, Math.floor(columns));

  const rows = new Map<number, LatticeSlot[]>();
  const cols = new Map<number, LatticeSlot[]>();
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const col = useAttr ? Math.round(ix![i]) : k % nCols;
    const row = useAttr ? Math.round(iy![i]) : Math.floor(k / nCols);
    let rowRun = rows.get(row);
    if (!rowRun) {
      rowRun = [];
      rows.set(row, rowRun);
    }
    rowRun.push({ along: col, i });
    let colRun = cols.get(col);
    if (!colRun) {
      colRun = [];
      cols.set(col, colRun);
    }
    colRun.push({ along: row, i });
  }

  const pushRun = (slots: LatticeSlot[]) => {
    const ordered = sortSlots(slots);
    const pts: V2[] = ordered.map((s) => [
      pos[s.i * 2],
      pos[s.i * 2 + 1],
    ]);
    const sub = emitPath(
      pts,
      smooth,
      false,
      nextGroup.n,
      attrsAlong(
        src,
        ordered.map((s) => s.i)
      )
    );
    if (sub) {
      subpaths.push(sub);
      nextGroup.n++;
    }
  };

  if (walk !== "columns") {
    for (const row of Array.from(rows.keys()).sort((a, b) => a - b)) {
      pushRun(rows.get(row)!);
    }
  }
  if (walk !== "rows") {
    for (const col of Array.from(cols.keys()).sort((a, b) => a - b)) {
      pushRun(cols.get(col)!);
    }
  }
}

function emitStrideGroup(
  src: PointsValue,
  indices: number[],
  stride: number,
  smooth: boolean,
  closed: boolean,
  nextGroup: { n: number },
  subpaths: SplineSubpath[]
) {
  const pos = src.positions;
  const k = Math.max(2, Math.floor(stride));
  for (let start = 0; start + k <= indices.length; start += k) {
    const window = indices.slice(start, start + k);
    const pts: V2[] = [];
    for (let j = 0; j < k; j++) {
      const i = window[j];
      pts.push([pos[i * 2], pos[i * 2 + 1]]);
    }
    const sub = emitPath(
      pts,
      smooth,
      closed,
      nextGroup.n,
      attrsAlong(src, window)
    );
    if (sub) {
      subpaths.push(sub);
      nextGroup.n++;
    }
  }
}

function emitZip(
  src: PointsValue,
  groups: { key: number | undefined; indices: number[] }[],
  smooth: boolean,
  closed: boolean,
  subpaths: SplineSubpath[]
) {
  if (groups.length < 2) return;
  const pos = src.positions;
  const n = Math.min(...groups.map((g) => g.indices.length));
  for (let i = 0; i < n; i++) {
    const idxs = groups.map((g) => g.indices[i]);
    const pts: V2[] = idxs.map((j) => [pos[j * 2], pos[j * 2 + 1]]);
    const sub = emitPath(pts, smooth, closed, i, attrsAlong(src, idxs));
    if (sub) subpaths.push(sub);
  }
}

function parseLayout(raw: unknown): "chain" | "grid" | "stride" | "zip" {
  if (raw === "grid" || raw === "stride" || raw === "zip") return raw;
  return "chain";
}

function parseGridWalk(raw: unknown): "rows" | "columns" | "both" {
  if (raw === "rows" || raw === "columns") return raw;
  return "both";
}

export const pointsToSplineNode: NodeDefinition = {
  type: "points-to-spline",
  name: "Points to Spline",
  category: "spline",
  subcategory: "generator",
  description:
    "Turn points into a spline. Chain walks index order (each groupIndex is one subpath). Grid walks rows, columns, or both (default both: rows then columns) — use after a Grid (or set Columns to match count X) so a warp keeps the lattice instead of a zigzag. Stride emits one subpath per k consecutive points (k=2 is pairs). Zip pairs corresponding points across groupIndex groups (Collect two curves, then zip — connect a_i to b_i). Curve = linear polyline or smooth catmull-rom; Close wraps each chain/stride/zip subpath. Named point channels land on the matching anchors so Spline to Points, Rope, and Points on Path can round-trip them.",
  facts: {
    reads: ["attr:group", "attr:ix", "attr:iy"],
    gotchas: [
      "layout=grid reads a group's own attr:ix/attr:iy (e.g. from Grid) for lattice coordinates when both are present, else treats indices as row-major with columns width.",
      "layout=zip's subpath count is the shortest group's point count; extra points in longer groups are dropped.",
      "layout=stride drops a trailing run shorter than stride; every layout also drops groups with fewer than 2 points.",
      "Each output subpath gets a fresh groupIndex per layout (chain reuses the input's group key; grid/stride number sequentially; zip uses the pair index), not the input's original tags.",
      "point attributes carry onto the matching spline anchors (so Spline to Points, Rope, and Points on Path can round-trip named channels).",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  headerControl: { paramName: "layout" },
  params: [
    {
      name: "layout",
      label: "Layout",
      type: "enum",
      options: ["chain", "grid", "stride", "zip"],
      default: "chain",
    },
    {
      name: "columns",
      label: "Columns",
      type: "scalar",
      min: 1,
      max: 64,
      step: 1,
      default: 5,
      visibleIf: (p) => p.layout === "grid",
    },
    {
      name: "gridWalk",
      label: "Walk",
      type: "enum",
      options: ["rows", "columns", "both"],
      default: "both",
      visibleIf: (p) => p.layout === "grid",
    },
    {
      name: "stride",
      label: "Stride",
      type: "scalar",
      min: 2,
      max: 1024,
      softMax: 32,
      step: 1,
      default: 2,
      visibleIf: (p) => p.layout === "stride",
    },
    {
      name: "curve",
      label: "Curve",
      type: "enum",
      options: ["linear", "smooth"],
      default: "linear",
    },
    {
      name: "closed",
      label: "Close",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.layout !== "grid",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count < 2) {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const smooth = ((params.curve as string) ?? "linear") === "smooth";
    const closed = !!params.closed;
    const layout = parseLayout(params.layout);
    const columns = (params.columns as number) ?? 5;
    const stride = (params.stride as number) ?? 2;
    const walk = parseGridWalk(params.gridWalk);

    const pos = src.positions;
    const groups = groupedIndices(src);
    const subpaths: SplineSubpath[] = [];

    if (layout === "grid") {
      const nextGroup = { n: 0 };
      for (const g of groups) {
        emitGridGroup(src, g.indices, columns, walk, smooth, nextGroup, subpaths);
      }
    } else if (layout === "stride") {
      const nextGroup = { n: 0 };
      for (const g of groups) {
        emitStrideGroup(
          src,
          g.indices,
          stride,
          smooth,
          closed,
          nextGroup,
          subpaths
        );
      }
    } else if (layout === "zip") {
      emitZip(src, groups, smooth, closed, subpaths);
    } else {
      for (const g of groups) {
        const run: V2[] = g.indices.map((i) => [pos[i * 2], pos[i * 2 + 1]]);
        const sub = emitPath(
          run,
          smooth,
          closed,
          g.key,
          attrsAlong(src, g.indices)
        );
        if (sub) subpaths.push(sub);
      }
    }

    const out: SplineValue = { kind: "spline", subpaths };
    return { primary: out };
  },
};
