import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  SocketType,
  SplineAnchor,
  SplineValue,
} from "@/engine/types";

// Proximity merge — snap nearby spline anchors or point positions
// together when they fall within a distance threshold in UV space.
//
// Clustering is O(N²) union-find; N (anchor count per evaluation) is
// realistically in the tens or low hundreds, so path compression is
// cheap and the naive pairwise pass fits comfortably in a frame.
// Each cluster's centroid is the weighted mean of its members.
//
// When `animate` is on, the `t` scalar (0..1) lerps each item from
// its original position toward its cluster centroid. At t=0 the input
// passes through unchanged; at t=1 everyone in a cluster coincides.
// Between those, positions smoothly slide together — no pops.
//
// When `dedupe` is on, the final merge step collapses each cluster
// down to a single item once t has reached 1 (up to a tiny epsilon).
// Before that threshold, counts stay unchanged so the animation
// doesn't pop. Past it, the node actually reduces count for points
// and drops adjacent coincident anchors within each spline subpath.
// Subpath-to-subpath topology joins are intentionally out of scope —
// a later Join node can pick that up.
//
// Spline notes:
//  - Anchor handles are stored relative to anchors, so moving `pos`
//    carries `inHandle`/`outHandle` along naturally; we don't touch
//    them.
//  - Two anchors on the same subpath that fall within the threshold
//    end up coincident (a degenerate segment). With dedupe at t=1,
//    those get collapsed to one anchor.
//  - Splines that visually overlap but have no anchors in each
//    other's neighborhoods don't merge. The node operates on anchor
//    positions, not geometry.

type Mode = "spline" | "points";

function innerType(mode: Mode): SocketType {
  return mode === "spline" ? "spline" : "points";
}

export const proximityMergeNode: NodeDefinition = {
  type: "proximity-merge",
  name: "Proximity Merge",
  category: "utility",
  description:
    "Snap nearby spline anchors or points together when they're within a distance threshold in UV space. Clusters merge to their shared centroid. Animate exposes a `t` scalar (0..1) for smoothly lerping positions, and Dedupe collapses each cluster to a single item once t reaches 1 — turning a snap into a true count-reducing merge.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "in", type: "spline", required: true },
    { name: "t", type: "scalar", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    const animate = !!params.animate;
    const base: InputSocketDef[] = [
      {
        name: "in",
        type: innerType(mode),
        required: true,
        label: mode === "spline" ? "Spline" : "Points",
      },
    ];
    // Only surface the `t` input when animate is on — otherwise the
    // node snaps and there's nothing to drive.
    if (animate) {
      base.push({ name: "t", type: "scalar", required: false });
    }
    return base;
  },
  params: [
    {
      name: "mode",
      label: "Type",
      type: "enum",
      options: ["spline", "points"],
      default: "spline",
    },
    {
      name: "distance",
      label: "Distance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "animate",
      label: "Animate",
      type: "boolean",
      default: false,
    },
    {
      name: "t",
      label: "t",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
      visibleIf: (p) => !!p.animate,
    },
    {
      name: "dedupe",
      label: "Dedupe at t=1",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "spline",
  resolvePrimaryOutput(params): SocketType {
    return innerType(((params.mode as string) ?? "spline") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    const distance = Math.max(0, (params.distance as number) ?? 0.05);
    const animate = !!params.animate;
    // `t` param is the fallback; the scalar input overrides when
    // connected. When animate is off, t is clamped to 1 regardless —
    // the param row is hidden in that state anyway.
    const tParam = (params.t as number) ?? 1;
    const tIn =
      inputs.t?.kind === "scalar" ? inputs.t.value : tParam;
    const t = animate ? Math.max(0, Math.min(1, tIn)) : 1;
    // Dedupe only activates once t has effectively reached 1. The
    // epsilon tolerance swallows floating-point drift on scalar
    // inputs so a ramp driven from scene time still collapses when
    // it lands "on" the endpoint.
    const dedupe = !!params.dedupe && t >= 1 - 1e-6;

    const src = inputs.in;

    if (mode === "points") {
      if (!src || src.kind !== "points") {
        const empty: PointsValue = { kind: "points", points: [] };
        return { primary: empty };
      }
      return { primary: mergePoints(src.points, distance, t, dedupe) };
    }

    // spline mode
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    return { primary: mergeSpline(src, distance, t, dedupe) };
  },
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Disjoint-set (union-find) with path compression. Cluster assignment
// is "are these two items within threshold": `union(i, j)` any time
// the pair passes the distance check. `find(i)` at the end gives the
// cluster root.
function unionFind(n: number) {
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  return { find, union };
}

function mergePoints(
  points: Point[],
  distance: number,
  t: number,
  dedupe: boolean
): PointsValue {
  const n = points.length;
  if (n === 0) return { kind: "points", points: [] };
  const { find, union } = unionFind(n);
  const d2 = distance * distance;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i].pos[0] - points[j].pos[0];
      const dy = points[i].pos[1] - points[j].pos[1];
      if (dx * dx + dy * dy <= d2) union(i, j);
    }
  }
  // Per-cluster sums for position + rotation + scale so every
  // attribute lerps smoothly, not just pos.
  type Acc = {
    sumX: number;
    sumY: number;
    sumRot: number;
    sumSx: number;
    sumSy: number;
    count: number;
  };
  const acc = new Map<number, Acc>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let a = acc.get(r);
    if (!a) {
      a = {
        sumX: 0,
        sumY: 0,
        sumRot: 0,
        sumSx: 0,
        sumSy: 0,
        count: 0,
      };
      acc.set(r, a);
    }
    a.sumX += points[i].pos[0];
    a.sumY += points[i].pos[1];
    a.sumRot += points[i].rotation ?? 0;
    a.sumSx += points[i].scale?.[0] ?? 1;
    a.sumSy += points[i].scale?.[1] ?? 1;
    a.count += 1;
  }
  const merged: Point[] = points.map((p, i) => {
    const a = acc.get(find(i))!;
    const tx = a.sumX / a.count;
    const ty = a.sumY / a.count;
    const trot = a.sumRot / a.count;
    const tsx = a.sumSx / a.count;
    const tsy = a.sumSy / a.count;
    const px = p.pos[0];
    const py = p.pos[1];
    const prot = p.rotation ?? 0;
    const psx = p.scale?.[0] ?? 1;
    const psy = p.scale?.[1] ?? 1;
    // Carry groupIndex through the lerp unchanged. When a cluster
    // crosses groups the mixed state is ambiguous, so we keep each
    // member's original tag until the dedupe step chooses a winner.
    return {
      pos: [px + (tx - px) * t, py + (ty - py) * t],
      rotation: prot + (trot - prot) * t,
      scale: [psx + (tsx - psx) * t, psy + (tsy - psy) * t],
      groupIndex: p.groupIndex,
    };
  });
  if (!dedupe) return { kind: "points", points: merged };
  // Per-cluster representative: pick the member with the lowest
  // groupIndex. When groups mix, that deterministically corresponds
  // to "the earliest socket wins" (socket a before b before c…),
  // matching the Group node's ordering convention. Ties (or
  // un-grouped clusters) fall back to the first-seen index.
  const winnerByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const existing = winnerByRoot.get(r);
    if (existing === undefined) {
      winnerByRoot.set(r, i);
      continue;
    }
    const iIdx = points[i].groupIndex ?? Number.POSITIVE_INFINITY;
    const eIdx = points[existing].groupIndex ?? Number.POSITIVE_INFINITY;
    if (iIdx < eIdx) winnerByRoot.set(r, i);
  }
  const reduced: Point[] = [];
  for (const idx of winnerByRoot.values()) reduced.push(merged[idx]);
  return { kind: "points", points: reduced };
}

function mergeSpline(
  spline: SplineValue,
  distance: number,
  t: number,
  dedupe: boolean
): SplineValue {
  // Flatten anchors across subpaths into one addressable list so
  // clustering treats the whole spline uniformly — anchors from
  // different subpaths can cluster together just like anchors on
  // the same subpath.
  type FlatAnchor = {
    subIdx: number;
    anchorIdx: number;
    x: number;
    y: number;
  };
  const flat: FlatAnchor[] = [];
  for (let s = 0; s < spline.subpaths.length; s++) {
    const sub = spline.subpaths[s];
    for (let a = 0; a < sub.anchors.length; a++) {
      const anchor = sub.anchors[a];
      flat.push({
        subIdx: s,
        anchorIdx: a,
        x: anchor.pos[0],
        y: anchor.pos[1],
      });
    }
  }
  const n = flat.length;
  if (n === 0) return { kind: "spline", subpaths: [] };
  const { find, union } = unionFind(n);
  const d2 = distance * distance;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = flat[i].x - flat[j].x;
      const dy = flat[i].y - flat[j].y;
      if (dx * dx + dy * dy <= d2) union(i, j);
    }
  }
  type Acc = { sumX: number; sumY: number; count: number };
  const acc = new Map<number, Acc>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let a = acc.get(r);
    if (!a) {
      a = { sumX: 0, sumY: 0, count: 0 };
      acc.set(r, a);
    }
    a.sumX += flat[i].x;
    a.sumY += flat[i].y;
    a.count += 1;
  }
  // Rebuild subpaths anchor-by-anchor. flat was populated in exact
  // (subIdx, anchorIdx) iteration order, so a running counter lines
  // up with the original indices — no lookup needed.
  let flatIdx = 0;
  const rebuilt: SplineValue = {
    kind: "spline",
    subpaths: spline.subpaths.map((sub) => ({
      // groupIndex rides on the subpath, not the anchor — it
      // passes through unchanged by the proximity merge.
      closed: sub.closed,
      groupIndex: sub.groupIndex,
      anchors: sub.anchors.map<SplineAnchor>((anchor) => {
        const a = acc.get(find(flatIdx))!;
        const tx = a.sumX / a.count;
        const ty = a.sumY / a.count;
        const next: SplineAnchor = {
          ...anchor,
          pos: [
            anchor.pos[0] + (tx - anchor.pos[0]) * t,
            anchor.pos[1] + (ty - anchor.pos[1]) * t,
          ],
        };
        flatIdx++;
        return next;
      }),
    })),
  };
  if (!dedupe) return rebuilt;
  // Drop consecutive coincident anchors within each subpath so the
  // user doesn't end up with a chain of zero-length segments after
  // a merge. Subpath count is preserved — we don't attempt to join
  // subpaths whose endpoints happen to coincide (that's a topology
  // change better handled by a future Join node).
  return {
    kind: "spline",
    subpaths: rebuilt.subpaths.map((sub) => ({
      closed: sub.closed,
      anchors: dropCoincidentNeighbors(sub.anchors, sub.closed),
    })),
  };
}

// Consecutive near-duplicates within a single subpath are the only
// dedupe we attempt: if anchor[i] and anchor[i+1] land within a
// squared-distance epsilon of each other, drop the later one. For
// closed subpaths the last anchor is also compared against the
// first so a wrap-around duplicate is collapsed.
function dropCoincidentNeighbors(
  anchors: SplineAnchor[],
  closed: boolean
): SplineAnchor[] {
  const eps2 = 1e-12;
  if (anchors.length <= 1) return anchors;
  const out: SplineAnchor[] = [anchors[0]];
  for (let i = 1; i < anchors.length; i++) {
    const prev = out[out.length - 1];
    const curr = anchors[i];
    const dx = prev.pos[0] - curr.pos[0];
    const dy = prev.pos[1] - curr.pos[1];
    if (dx * dx + dy * dy <= eps2) continue;
    out.push(curr);
  }
  if (closed && out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    const dx = first.pos[0] - last.pos[0];
    const dy = first.pos[1] - last.pos[1];
    if (dx * dx + dy * dy <= eps2) out.pop();
  }
  return out;
}
