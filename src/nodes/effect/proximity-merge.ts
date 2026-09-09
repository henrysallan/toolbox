import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointAttribute,
  PointsValue,
  SocketType,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  concatPoints,
  copyPointsWith,
  EMPTY_POINTS,
  ensurePointArray,
  gatherPoints,
  pointsFromArray,
} from "@/engine/points";

// Proximity Join/Merge — combine multiple splines (or point sets) and
// weld the parts that fall within a UV-space distance threshold. Two
// operations, selected by `op` (spline mode only; points always snap):
//
//  - SNAP: cluster nearby anchors/points (O(N²) union-find) and move each
//    member to its cluster centroid. No topology change — coincident
//    anchors, same subpath/point count (until dedupe). This is the
//    node's original behavior.
//
//  - JOIN: stitch OPEN subpath endpoints. When two free endpoints fall
//    within the threshold they weld into one anchor and their subpaths
//    concatenate into a single continuous path; a chain whose two free
//    ends also meet becomes closed. This is a real topology change
//    (N paths → fewer), the thing you want before Stroke / Fill /
//    Offset Path. Closed subpaths have no free ends and pass through.
//
// Inputs auto-grow: the node always shows one spare empty socket, and
// wiring it spawns the next spare (see the `slots` param + the
// normalization effect in EffectsApp). A single socket still accepts a
// Collect'd multi-subpath spline "group" — join/snap operate across
// every connected input at once.
//
// Animate/`t` (0..1) reuses the same gate for both ops: at t<1 positions
// slide together (endpoints toward their weld point; snap members toward
// their centroid) with NO topology/count change; the actual stitch (join)
// or cluster-collapse (snap+dedupe) commits only once t reaches 1, so the
// animation never pops. With animate off, t is 1 and the op commits.
//
// Coordinates are raw normalized UV (anisotropic on non-square canvases),
// matching the distance metric the snap path has always used.

type Mode = "spline" | "points";
type Op = "join" | "snap";

const EPS = 1e-6;

function innerType(mode: Mode): SocketType {
  return mode === "spline" ? "spline" : "points";
}

export const proximityMergeNode: NodeDefinition = {
  type: "proximity-merge",
  name: "Proximity Join/Merge",
  category: "utility",
  description:
    "Combine multiple splines (or point sets) and weld the parts that fall within a distance threshold in UV space. Join stitches open subpath endpoints into continuous / closed paths (a real topology change); Snap clusters nearby anchors/points to their shared centroid. Inputs auto-grow — there's always one spare empty socket — and a single socket also accepts a spline group from the Combine node. Animate exposes a `t` scalar (0..1) that slides parts together, committing the join/collapse at t=1 with no pop.",
  facts: {
    space: { "param:distance": "uv01", out: "in:in" },
    gotchas: [
      "distance measures raw per-axis UV deltas, not aspect-corrected canvas distance: on a non-square canvas the same value reaches further in x than in y or vice versa.",
      "mode=points also blends rotation and scale.x/y (and any named point attribute) toward the cluster mean at the same t as position, not just position.",
      "dedupe only fires once t reaches 1 (the commit); with animate on and t<1 the checkbox has no visible effect yet.",
      "join's weld anchor is marked broken whenever both welded ends carried real handles, so the seam reads as a sharp corner, not a smoothed curve.",
      "A joined chain only self-closes into a closed subpath when it has 3+ anchors and its two free ends also land within distance; shorter chains stay open.",
    ],
  },
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [{ name: "in", type: "spline", required: false }],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    const animate = !!params.animate;
    const slots = readSlots(params);
    const type = innerType(mode);
    const label = mode === "spline" ? "Spline" : "Points";
    const out: InputSocketDef[] = slots.map((name, i) => ({
      name,
      type,
      required: false,
      label: slots.length > 1 ? `${label} ${i + 1}` : label,
    }));
    // Only surface the `t` input when animate is on — otherwise there's
    // nothing to drive.
    if (animate) {
      out.push({ name: "t", type: "scalar", required: false });
    }
    return out;
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
      name: "op",
      label: "Operation",
      type: "enum",
      options: ["join", "snap"],
      control: "segmented",
      default: "snap",
      // Join is meaningless for a point cloud (no endpoints / topology) —
      // points always snap.
      visibleIf: (p) => ((p.mode as string) ?? "spline") === "spline",
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
      // Dedupe only means something for snap (join always reduces count).
      visibleIf: (p) =>
        ((p.mode as string) ?? "spline") === "points" ||
        ((p.op as string) ?? "snap") === "snap",
    },
  ],
  primaryOutput: "spline",
  resolvePrimaryOutput(params): SocketType {
    return innerType(((params.mode as string) ?? "spline") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    const op = (((params.op as string) ?? "snap") as Op);
    const distance = Math.max(0, (params.distance as number) ?? 0.05);
    const animate = !!params.animate;
    // `t` param is the fallback; the scalar input overrides when
    // connected. When animate is off, t is clamped to 1 regardless — the
    // param row is hidden in that state anyway.
    const tParam = (params.t as number) ?? 1;
    const tIn = inputs.t?.kind === "scalar" ? inputs.t.value : tParam;
    const t = animate ? Math.max(0, Math.min(1, tIn)) : 1;
    // "Commit" — the topology/count change lands — only once t has
    // effectively reached 1. The epsilon swallows float drift on scalar
    // inputs so a ramp driven from scene time still lands on the endpoint.
    const commit = t >= 1 - EPS;

    const slots = readSlots(params);

    if (mode === "points") {
      const dedupe = !!params.dedupe && commit;
      // SoA concat (channel-presence union) instead of a Point[] splat, so
      // z/normals/attributes survive into the merge.
      const sources: PointsValue[] = [];
      for (const name of slots) {
        const v = inputs[name];
        if (v && v.kind === "points") sources.push(v);
      }
      return {
        primary: mergePoints(concatPoints(sources), distance, t, dedupe),
      };
    }

    // spline mode — concatenate every connected input's subpaths.
    const subpaths: SplineSubpath[] = [];
    for (const name of slots) {
      const v = inputs[name];
      if (v && v.kind === "spline") subpaths.push(...v.subpaths);
    }
    const combined: SplineValue = { kind: "spline", subpaths };

    if (op === "join") {
      return { primary: joinSpline(combined, distance, t, commit) };
    }
    const dedupe = !!params.dedupe && commit;
    return { primary: mergeSpline(combined, distance, t, dedupe) };
  },
};

// ---------------------------------------------------------------------
// Slots — the auto-grow input list. Names are just socket ids; the
// normalization effect in EffectsApp keeps this equal to (connected
// sockets) + one spare. Default ["in"] is the legacy single-socket name,
// so old saves load and evaluate unchanged with no migration.
// ---------------------------------------------------------------------

function readSlots(params: Record<string, unknown>): string[] {
  const s = params.slots;
  if (Array.isArray(s) && s.every((x) => typeof x === "string") && s.length) {
    return s as string[];
  }
  return ["in"];
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

// Disjoint-set (union-find) with path compression. `union(i, j)` any time
// a pair passes the distance check; `find(i)` gives the cluster root.
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

function dist2(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------
// SNAP (points)
// ---------------------------------------------------------------------

function mergePoints(
  src: PointsValue,
  distance: number,
  t: number,
  dedupe: boolean
): PointsValue {
  const points = ensurePointArray(src);
  const n = src.count;
  if (n === 0) return EMPTY_POINTS;
  const { find, union } = unionFind(n);
  const d2 = distance * distance;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dist2(points[i].pos, points[j].pos) <= d2) union(i, j);
    }
  }
  // Per-cluster sums for position + rotation + scale so every attribute
  // lerps smoothly, not just pos.
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
      a = { sumX: 0, sumY: 0, sumRot: 0, sumSx: 0, sumSy: 0, count: 0 };
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
    return {
      pos: [px + (tx - px) * t, py + (ty - py) * t],
      rotation: prot + (trot - prot) * t,
      scale: [psx + (tsx - psx) * t, psy + (tsy - psy) * t],
      groupIndex: p.groupIndex,
    };
  });
  // SoA the blended geometry, re-attaching carried channels from the
  // source. Named attributes blend toward their cluster mean at the same
  // t as the geometry.
  const m = pointsFromArray(merged);
  let attributes = src.attributes;
  if (attributes) {
    const blendedAttrs: Record<string, PointAttribute> = {};
    for (const name of Object.keys(attributes)) {
      const a = attributes[name];
      const k = a.arity;
      // Per-cluster sums; slot k holds the member count.
      const sums = new Map<number, Float64Array>();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        let s = sums.get(r);
        if (!s) {
          s = new Float64Array(k + 1);
          sums.set(r, s);
        }
        for (let c = 0; c < k; c++) s[c] += a.data[i * k + c];
        s[k] += 1;
      }
      const data = new Float32Array(n * k);
      for (let i = 0; i < n; i++) {
        const s = sums.get(find(i))!;
        for (let c = 0; c < k; c++) {
          const p = a.data[i * k + c];
          data[i * k + c] = p + (s[c] / s[k] - p) * t;
        }
      }
      blendedAttrs[name] = { arity: a.arity, color: a.color, data };
    }
    attributes = blendedAttrs;
  }
  const blended = copyPointsWith(src, {
    positions: m.positions,
    scales: m.scales,
    rotations: m.rotations,
    groupIndices: m.groupIndices,
    attributes,
  });
  if (!dedupe) return blended;
  // Per-cluster representative: lowest groupIndex wins (earliest socket),
  // matching Collect's ordering; ties fall back to first-seen index.
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
  const map = new Int32Array(winnerByRoot.size);
  let w = 0;
  for (const idx of winnerByRoot.values()) map[w++] = idx;
  return gatherPoints(blended, map);
}

// ---------------------------------------------------------------------
// SNAP (spline) — cluster anchors across all subpaths, move to centroid.
// ---------------------------------------------------------------------

function mergeSpline(
  spline: SplineValue,
  distance: number,
  t: number,
  dedupe: boolean
): SplineValue {
  type FlatAnchor = { x: number; y: number };
  const flat: FlatAnchor[] = [];
  for (const sub of spline.subpaths) {
    for (const anchor of sub.anchors) {
      flat.push({ x: anchor.pos[0], y: anchor.pos[1] });
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
  // iteration order, so a running counter lines up with the originals.
  let flatIdx = 0;
  const rebuilt: SplineValue = {
    kind: "spline",
    subpaths: spline.subpaths.map((sub) => ({
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
  return {
    kind: "spline",
    subpaths: rebuilt.subpaths.map((sub) => ({
      closed: sub.closed,
      groupIndex: sub.groupIndex,
      anchors: dropCoincidentNeighbors(sub.anchors, sub.closed),
    })),
  };
}

// Drop consecutive near-duplicate anchors within one subpath (the only
// dedupe snap attempts). Closed subpaths also compare last vs first.
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
    if (dist2(prev.pos, curr.pos) <= eps2) continue;
    out.push(curr);
  }
  if (closed && out.length > 1) {
    if (dist2(out[0].pos, out[out.length - 1].pos) <= eps2) out.pop();
  }
  return out;
}

// ---------------------------------------------------------------------
// JOIN (spline) — stitch open subpath endpoints into continuous paths.
// ---------------------------------------------------------------------

function cloneAnchor(a: SplineAnchor): SplineAnchor {
  return {
    pos: [a.pos[0], a.pos[1]],
    inHandle: a.inHandle ? [a.inHandle[0], a.inHandle[1]] : undefined,
    outHandle: a.outHandle ? [a.outHandle[0], a.outHandle[1]] : undefined,
    broken: a.broken,
  };
}

// Reverse a chain's direction: flip the array and swap each anchor's
// in/out handles (they point the opposite way once traversal reverses).
function reverseAnchors(anchors: SplineAnchor[]): SplineAnchor[] {
  return anchors
    .slice()
    .reverse()
    .map((a) => ({
      pos: [a.pos[0], a.pos[1]] as [number, number],
      inHandle: a.outHandle ? [a.outHandle[0], a.outHandle[1]] as [number, number] : undefined,
      outHandle: a.inHandle ? [a.inHandle[0], a.inHandle[1]] as [number, number] : undefined,
      broken: a.broken,
    }));
}

// Weld the tail anchor of a left chain into the head anchor of a right
// chain: one anchor at the midpoint that keeps the incoming (`endA`)
// in-handle and the outgoing (`startB`) out-handle. Handles are relative
// offsets, so they stay valid as the anchor moves to the midpoint.
function weldJoint(endA: SplineAnchor, startB: SplineAnchor): SplineAnchor {
  const mid: [number, number] = [
    (endA.pos[0] + startB.pos[0]) / 2,
    (endA.pos[1] + startB.pos[1]) / 2,
  ];
  const inHandle = endA.inHandle;
  const outHandle = startB.outHandle;
  return {
    pos: mid,
    inHandle: inHandle ? [inHandle[0], inHandle[1]] : undefined,
    outHandle: outHandle ? [outHandle[0], outHandle[1]] : undefined,
    // The two paths were independent — treat the join as a corner so the
    // pen tool doesn't try to mirror unrelated tangents.
    broken: !!(inHandle && outHandle),
  };
}

function joinSpline(
  spline: SplineValue,
  distance: number,
  t: number,
  commit: boolean
): SplineValue {
  const d2 = distance * distance;
  const open: SplineSubpath[] = [];
  const closed: SplineSubpath[] = [];
  for (const sub of spline.subpaths) {
    if (sub.anchors.length === 0) continue;
    (sub.closed ? closed : open).push(sub);
  }
  if (open.length === 0) return spline;

  // Animated preview (t<1): no topology change — just slide each open
  // subpath's endpoints toward their proximity-cluster centroid so paths
  // visibly approach. Interior anchors and closed subpaths are untouched.
  if (!commit) {
    return {
      kind: "spline",
      subpaths: [
        ...previewSlideEndpoints(open, d2, t),
        ...closed.map(passThroughSub),
      ],
    };
  }

  // Commit: greedy matching on original endpoints (Kruskal). Candidate
  // pairs within `distance` are gathered via a uniform grid, sorted by
  // distance, then accepted when both endpoints are still free and the
  // join wouldn't cycle a chain (self-close is a later pass). Flatten
  // each chain in one walk — same matching as repeatedly welding the
  // closest remaining pair, without an O(N³) rescan or per-merge copies.
  const m = open.length;
  type EP = { sub: number; end: 0 | 1; pos: [number, number] };
  const eps: EP[] = new Array(m * 2);
  for (let i = 0; i < m; i++) {
    const a = open[i].anchors;
    eps[i * 2] = { sub: i, end: 0, pos: a[0].pos };
    eps[i * 2 + 1] = { sub: i, end: 1, pos: a[a.length - 1].pos };
  }

  type Pair = { i: number; j: number; dd: number };
  const pairs: Pair[] = [];
  forProximityPairs(eps, d2, (i, j, dd) => {
    pairs.push({ i, j, dd });
  });
  pairs.sort((a, b) => a.dd - b.dd || a.i - b.i || a.j - b.j);

  type Link = { other: number; otherEnd: 0 | 1 };
  const headLink: (Link | null)[] = new Array(m).fill(null);
  const tailLink: (Link | null)[] = new Array(m).fill(null);
  const setLink = (sub: number, end: 0 | 1, link: Link) => {
    if (end === 0) headLink[sub] = link;
    else tailLink[sub] = link;
  };
  const used = new Uint8Array(eps.length);
  const { find, union } = unionFind(m);
  for (let p = 0; p < pairs.length; p++) {
    const a = pairs[p].i;
    const b = pairs[p].j;
    if (used[a] || used[b]) continue;
    const sa = eps[a].sub;
    const sb = eps[b].sub;
    if (find(sa) === find(sb)) continue;
    used[a] = 1;
    used[b] = 1;
    union(sa, sb);
    setLink(sa, eps[a].end, { other: sb, otherEnd: eps[b].end });
    setLink(sb, eps[b].end, { other: sa, otherEnd: eps[a].end });
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < m; i++) {
    const r = find(i);
    let arr = members.get(r);
    if (!arr) {
      arr = [];
      members.set(r, arr);
    }
    arr.push(i);
  }

  const joined: SplineSubpath[] = [];
  for (const group of members.values()) {
    let startSub = group[0];
    let startEnd: 0 | 1 = 0;
    for (let g = 0; g < group.length; g++) {
      const s = group[g];
      if (!headLink[s]) {
        startSub = s;
        startEnd = 0;
        break;
      }
      if (!tailLink[s]) {
        startSub = s;
        startEnd = 1;
        break;
      }
    }
    const anchors = flattenChain(open, startSub, startEnd, headLink, tailLink);
    if (anchors.length >= 3 && dist2(anchors[0].pos, anchors[anchors.length - 1].pos) <= d2) {
      const joint = weldJoint(anchors[anchors.length - 1], anchors[0]);
      joined.push({
        closed: true,
        anchors: [joint, ...anchors.slice(1, anchors.length - 1)],
      });
    } else {
      joined.push({ closed: false, anchors });
    }
  }

  return {
    kind: "spline",
    subpaths: [...joined, ...closed.map(passThroughSub)],
  };
}

// Walk a chain from a free endpoint, welding joints as we concatenate.
function flattenChain(
  open: SplineSubpath[],
  startSub: number,
  startEnd: 0 | 1,
  headLink: ({ other: number; otherEnd: 0 | 1 } | null)[],
  tailLink: ({ other: number; otherEnd: 0 | 1 } | null)[]
): SplineAnchor[] {
  const out: SplineAnchor[] = [];
  let sub = startSub;
  let enterEnd: 0 | 1 = startEnd;
  const m = open.length;
  for (let guard = 0; guard < m; guard++) {
    const src = open[sub].anchors;
    const reversed = enterEnd === 1;
    const oriented = reversed
      ? reverseAnchors(src.map(cloneAnchor))
      : src.map(cloneAnchor);
    if (out.length === 0) {
      for (let i = 0; i < oriented.length; i++) out.push(oriented[i]);
    } else {
      const joint = weldJoint(out[out.length - 1], oriented[0]);
      out[out.length - 1] = joint;
      for (let i = 1; i < oriented.length; i++) out.push(oriented[i]);
    }
    const exitEnd: 0 | 1 = enterEnd === 0 ? 1 : 0;
    const link = exitEnd === 0 ? headLink[sub] : tailLink[sub];
    if (!link) break;
    sub = link.other;
    enterEnd = link.otherEnd;
  }
  return out;
}

// Visit every pair of endpoints from different subpaths whose squared
// distance is ≤ d2. Uniform grid so a typical sparse join is O(N + K)
// instead of O(N²); a distance that covers everyone degrades to the
// all-pairs scan (same as before, just once).
function forProximityPairs(
  eps: readonly { sub: number; pos: [number, number] }[],
  d2: number,
  visit: (i: number, j: number, dd: number) => void
): void {
  const n = eps.length;
  if (n < 2) return;
  const cell = Math.sqrt(d2) || 1e-12;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(eps[i].pos[0] / cell);
    const cy = Math.floor(eps[i].pos[1] / cell);
    const key = `${cx}|${cy}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }
  for (let i = 0; i < n; i++) {
    const ax = eps[i].pos[0];
    const ay = eps[i].pos[1];
    const si = eps[i].sub;
    const cx = Math.floor(ax / cell);
    const cy = Math.floor(ay / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cx + dx}|${cy + dy}`);
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const j = bucket[b];
          if (j <= i) continue;
          if (eps[j].sub === si) continue;
          const ex = ax - eps[j].pos[0];
          const ey = ay - eps[j].pos[1];
          const dd = ex * ex + ey * ey;
          if (dd <= d2) visit(i, j, dd);
        }
      }
    }
  }
}

function passThroughSub(sub: SplineSubpath): SplineSubpath {
  return {
    closed: sub.closed,
    groupIndex: sub.groupIndex,
    anchors: sub.anchors.map(cloneAnchor),
  };
}

// Cluster the head/tail anchors of the open subpaths by proximity and
// lerp each toward its cluster centroid by `t`. Topology is untouched —
// this is the animated approach the commit lands on at t=1.
function previewSlideEndpoints(
  open: SplineSubpath[],
  d2: number,
  t: number
): SplineSubpath[] {
  // Endpoint records: (subIdx, which end, pos). Singletons (1 anchor)
  // contribute a single endpoint used for both head and tail.
  type EP = { sub: number; head: boolean; pos: [number, number] };
  const eps: EP[] = [];
  open.forEach((s, i) => {
    eps.push({ sub: i, head: true, pos: s.anchors[0].pos });
    if (s.anchors.length > 1) {
      eps.push({
        sub: i,
        head: false,
        pos: s.anchors[s.anchors.length - 1].pos,
      });
    }
  });
  const n = eps.length;
  const { find, union } = unionFind(n);
  forProximityPairs(eps, d2, (i, j) => union(i, j));
  const acc = new Map<number, { x: number; y: number; c: number }>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let a = acc.get(r);
    if (!a) {
      a = { x: 0, y: 0, c: 0 };
      acc.set(r, a);
    }
    a.x += eps[i].pos[0];
    a.y += eps[i].pos[1];
    a.c += 1;
  }
  // Target position per endpoint record.
  const targetFor = (idx: number): [number, number] => {
    const a = acc.get(find(idx))!;
    return [a.x / a.c, a.y / a.c];
  };
  const headTarget = new Map<number, [number, number]>();
  const tailTarget = new Map<number, [number, number]>();
  eps.forEach((e, idx) => {
    (e.head ? headTarget : tailTarget).set(e.sub, targetFor(idx));
  });

  return open.map((s, i) => {
    const anchors = s.anchors.map(cloneAnchor);
    const slide = (anchor: SplineAnchor, target: [number, number]) => {
      anchor.pos = [
        anchor.pos[0] + (target[0] - anchor.pos[0]) * t,
        anchor.pos[1] + (target[1] - anchor.pos[1]) * t,
      ];
    };
    const h = headTarget.get(i);
    if (h) slide(anchors[0], h);
    const tl = tailTarget.get(i);
    if (tl && anchors.length > 1) slide(anchors[anchors.length - 1], tl);
    return { closed: false, groupIndex: s.groupIndex, anchors };
  });
}
