import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  buildPointsGraph,
  buildSplineGraph,
  shortestPathInGraph,
  type SplineGraph,
} from "@/engine/spline-graph";
import { makePoints } from "@/engine/points";

// Shortest Path — route through a network and emit the route as a spline.
// Two network sources behind a `mode` header control (mode-anchored
// resolvers, the group-pick pattern):
//
//  - points (default): the network is IMPLICIT — every pair of input points
//    within `max_distance` is a walkable hop (Connect Points semantics).
//    `start` snaps to the nearest point of a vec2 position (wire a Point /
//    Cursor / gizmo, or use the X/Y params); the end is either another
//    position or a groupIndex (routes to the nearest member of that group).
//    Primary output is the route as an open polyline (chain Set Spline Type
//    to smooth it); the `points` aux carries the visited points in path
//    order with their original attributes, for Copy to Points stamps.
//
//  - spline: walk a wired spline network's own segments (subpaths connect
//    where anchors touch within `weld_distance` — branching structures,
//    grids, Connect Points output). The route follows the ORIGINAL curved
//    geometry (segments re-emitted with handles, reversed where traversed
//    backwards). `groups` select routes between two groupIndex groups
//    (multi-source Dijkstra, any vertex of A to any vertex of B); `random`
//    emits `count` seeded pairs, each tagged groupIndex = path index.
//
// Group indices use Select by Index semantics everywhere (missing tags ⇒
// bucket 0; indices pick into the sorted distinct buckets and clamp).
// Pairs with Trim Path's trim_offset for the animated traversal look.
// Pure CPU + deterministic (hash-based PRNG, no Math.random) — normal
// fingerprint caching. Spec: specdocs/071026_spline-points-nodes.md.

type Mode = "points" | "spline";

// triple32-style avalanche hash → [0, 1). Deterministic stream keyed on
// (seed, n) — same primitive family as Point Expression's rand().
function rand01(seed: number, n: number): number {
  let x = (Math.imul(seed | 0, 0x9e3779b9) ^ Math.imul(n | 0, 0x85ebca6b)) >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb) >>> 0;
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab) >>> 0;
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

// Nearest point index to (x, y) — linear scan, fine at points-socket sizes.
function nearestPoint(
  positions: Float32Array,
  count: number,
  x: number,
  y: number
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const ex = positions[i * 2] - x;
    const ey = positions[i * 2 + 1] - y;
    const d = ex * ex + ey * ey;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Re-emit traversed spline segments as one open subpath. The joint anchor
// at each junction takes the arriving segment's end position/in-handle and
// the departing segment's out-handle (welded anchors can differ by up to
// weld_distance — the arriving position wins; the error is sub-weld).
function buildPathSubpath(
  subpaths: SplineSubpath[],
  graph: SplineGraph,
  path: { vertices: number[]; edges: number[] }
): SplineSubpath | null {
  const { vertices, edges } = path;
  if (edges.length === 0) return null;
  const anchors: SplineAnchor[] = [];
  for (let k = 0; k < edges.length; k++) {
    const e = graph.edges[edges[k]];
    const sub = subpaths[e.subIndex];
    const n = sub.anchors.length;
    const startA = sub.anchors[e.segIndex];
    const endA = sub.anchors[(e.segIndex + 1) % n];
    // e.a is the vertex at the segment's start anchor; traversing from
    // vertices[k] means forward when they match. A reversed cubic swaps
    // the roles of the two anchors' handles (offsets unchanged).
    const forward = e.a === vertices[k];
    const from = forward ? startA : endA;
    const to = forward ? endA : startA;
    const departing = forward ? startA.outHandle : endA.inHandle;
    const arriving = forward ? endA.inHandle : startA.outHandle;
    if (k === 0) {
      const head: SplineAnchor = { pos: [from.pos[0], from.pos[1]] };
      if (departing) head.outHandle = [departing[0], departing[1]];
      anchors.push(head);
    } else if (departing) {
      anchors[anchors.length - 1].outHandle = [departing[0], departing[1]];
    }
    const next: SplineAnchor = { pos: [to.pos[0], to.pos[1]] };
    if (arriving) next.inHandle = [arriving[0], arriving[1]];
    anchors.push(next);
  }
  return { anchors, closed: false };
}

export const shortestPathNode: NodeDefinition = {
  type: "shortest-path",
  name: "Shortest Path",
  category: "spline",
  // Generator in its default (points) mode — points in, spline out, like
  // Connect Points. Spline mode is modifier-flavored but menus key off one
  // subcategory.
  subcategory: "generator",
  description:
    "Route through a network and output the path as a spline. Points mode: hops between points within the max distance, from a start position (snapped to the nearest point) to an end position or group — visited points ride the aux output. Spline mode: walks a wired network's own curved segments between two groups, or emits N seeded random routes. Animate the draw-on with Trim Path.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "start", type: "vec2", required: false, label: "Start" },
    { name: "end", type: "vec2", required: false, label: "End" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "points") as Mode;
    if (mode === "spline") {
      return [{ name: "network", type: "spline", required: true }];
    }
    const sockets: InputSocketDef[] = [
      { name: "points", type: "points", required: true },
      { name: "start", type: "vec2", required: false, label: "Start" },
    ];
    if (((params.end_mode as string) ?? "position") === "position") {
      sockets.push({ name: "end", type: "vec2", required: false, label: "End" });
    }
    return sockets;
  },
  params: [
    {
      name: "mode",
      label: "Network",
      type: "enum",
      options: ["points", "spline"],
      default: "points",
    },
    // ---- points mode ----
    {
      name: "max_distance",
      label: "Max hop distance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "points",
    },
    {
      name: "start_x",
      label: "Start X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "points",
    },
    {
      name: "start_y",
      label: "Start Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "points",
    },
    {
      name: "end_mode",
      label: "End",
      type: "enum",
      options: ["position", "group"],
      control: "segmented",
      default: "position",
      visibleIf: (p) => ((p.mode as string) ?? "points") === "points",
    },
    {
      name: "end_x",
      label: "End X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.9,
      visibleIf: (p) =>
        ((p.mode as string) ?? "points") === "points" &&
        ((p.end_mode as string) ?? "position") === "position",
    },
    {
      name: "end_y",
      label: "End Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) =>
        ((p.mode as string) ?? "points") === "points" &&
        ((p.end_mode as string) ?? "position") === "position",
    },
    // Shared: points mode's group target AND spline groups-select's end.
    {
      name: "end_group",
      label: "End group",
      type: "scalar",
      min: 0,
      max: 100,
      step: 1,
      default: 1,
      visibleIf: (p) => {
        const mode = ((p.mode as string) ?? "points") as Mode;
        if (mode === "points") {
          return ((p.end_mode as string) ?? "position") === "group";
        }
        return ((p.select as string) ?? "groups") === "groups";
      },
    },
    // ---- spline mode ----
    {
      name: "select",
      label: "Endpoints",
      type: "enum",
      options: ["groups", "random"],
      default: "groups",
      visibleIf: (p) => ((p.mode as string) ?? "points") === "spline",
    },
    {
      name: "start_group",
      label: "Start group",
      type: "scalar",
      min: 0,
      max: 100,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        ((p.mode as string) ?? "points") === "spline" &&
        ((p.select as string) ?? "groups") === "groups",
    },
    {
      name: "count",
      label: "Paths",
      type: "scalar",
      min: 1,
      max: 100,
      softMax: 10,
      step: 1,
      default: 3,
      visibleIf: (p) =>
        ((p.mode as string) ?? "points") === "spline" &&
        ((p.select as string) ?? "groups") === "random",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        ((p.mode as string) ?? "points") === "spline" &&
        ((p.select as string) ?? "groups") === "random",
    },
    {
      name: "weld_distance",
      label: "Weld distance",
      type: "scalar",
      min: 0,
      max: 0.05,
      step: 0.0001,
      default: 0.002,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "spline",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const mode = ((params.mode as string) ?? "points") as Mode;
    return mode === "points" ? [{ name: "points", type: "points" }] : [];
  },

  compute({ inputs, params }) {
    const empty: SplineValue = { kind: "spline", subpaths: [] };
    const mode = ((params.mode as string) ?? "points") as Mode;

    if (mode === "points") {
      const src = inputs.points;
      if (!src || src.kind !== "points" || src.count < 2) {
        return { primary: empty, aux: { points: makePoints(0) } };
      }
      const maxD = Math.max(0, (params.max_distance as number) ?? 0.1);
      const graph = buildPointsGraph(
        src.positions,
        src.count,
        src.groupIndices,
        maxD
      );
      const emptyOut = { primary: empty, aux: { points: makePoints(0) } };
      if (graph.edges.length === 0) return emptyOut;

      const start = inputs.start;
      const sx =
        start?.kind === "vec2" ? start.value[0] : ((params.start_x as number) ?? 0.1);
      const sy =
        start?.kind === "vec2" ? start.value[1] : ((params.start_y as number) ?? 0.5);
      const startIdx = nearestPoint(src.positions, src.count, sx, sy);

      const targets = new Set<number>();
      if (((params.end_mode as string) ?? "position") === "group") {
        const groups = src.groupIndices;
        const buckets = Array.from(
          new Set(
            Array.from({ length: src.count }, (_, i) => (groups ? groups[i] : 0))
          )
        ).sort((a, b) => a - b);
        const bucket =
          buckets[
            Math.max(
              0,
              Math.min(
                buckets.length - 1,
                Math.floor((params.end_group as number) ?? 1)
              )
            )
          ];
        for (let i = 0; i < src.count; i++) {
          if ((groups ? groups[i] : 0) === bucket) targets.add(i);
        }
      } else {
        const end = inputs.end;
        const ex =
          end?.kind === "vec2" ? end.value[0] : ((params.end_x as number) ?? 0.9);
        const ey =
          end?.kind === "vec2" ? end.value[1] : ((params.end_y as number) ?? 0.5);
        targets.add(nearestPoint(src.positions, src.count, ex, ey));
      }

      const path = shortestPathInGraph(graph, [startIdx], targets);
      if (!path || path.edges.length === 0) return emptyOut; // incl. start ∈ targets

      // Route polyline — vertex ids ARE point indices, positions verbatim.
      const anchors: SplineAnchor[] = path.vertices.map((v) => ({
        pos: [graph.vertexPos[v][0], graph.vertexPos[v][1]],
      }));
      const route: SplineValue = {
        kind: "spline",
        subpaths: [{ anchors, closed: false }],
      };

      // Visited points in path order, original attributes intact.
      const visited = makePoints(path.vertices.length, {
        withScales: !!src.scales,
        withRotations: !!src.rotations,
        withGroupIndices: !!src.groupIndices,
      });
      for (let k = 0; k < path.vertices.length; k++) {
        const i = path.vertices[k];
        visited.positions[k * 2] = src.positions[i * 2];
        visited.positions[k * 2 + 1] = src.positions[i * 2 + 1];
        if (src.scales) {
          visited.scales![k * 2] = src.scales[i * 2];
          visited.scales![k * 2 + 1] = src.scales[i * 2 + 1];
        }
        if (src.rotations) visited.rotations![k] = src.rotations[i];
        if (src.groupIndices) visited.groupIndices![k] = src.groupIndices[i];
      }
      return { primary: route, aux: { points: visited } };
    }

    // ---- spline mode ----
    const src = inputs.network;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: empty };
    }
    const weld = Math.max(0, (params.weld_distance as number) ?? 0.002);
    const graph = buildSplineGraph(src.subpaths, weld);
    if (graph.edges.length === 0) return { primary: empty };

    const out: SplineSubpath[] = [];

    if (((params.select as string) ?? "groups") === "groups") {
      // Distinct buckets present, sorted — Select by Index semantics.
      const buckets = Array.from(
        new Set(src.subpaths.map((s) => s.groupIndex ?? 0))
      ).sort((a, b) => a - b);
      const clampIdx = (raw: number) =>
        buckets[Math.max(0, Math.min(buckets.length - 1, Math.floor(raw)))];
      const startBucket = clampIdx((params.start_group as number) ?? 0);
      const endBucket = clampIdx((params.end_group as number) ?? 1);
      if (startBucket !== endBucket) {
        const sources: number[] = [];
        const targets = new Set<number>();
        for (let v = 0; v < graph.vertexPos.length; v++) {
          if (graph.vertexGroups[v].has(startBucket)) sources.push(v);
          if (graph.vertexGroups[v].has(endBucket)) targets.add(v);
        }
        const path = shortestPathInGraph(graph, sources, targets);
        if (path) {
          const sub = buildPathSubpath(src.subpaths, graph, path);
          if (sub) out.push(sub);
        }
      }
    } else {
      const count = Math.max(1, Math.floor((params.count as number) ?? 3));
      const seed = Math.floor((params.seed as number) ?? 0);
      // Vertices eligible as endpoints: their component has a partner.
      const compSize = new Array<number>(graph.componentCount).fill(0);
      for (let v = 0; v < graph.vertexPos.length; v++) {
        compSize[graph.component[v]]++;
      }
      const eligible: number[] = [];
      for (let v = 0; v < graph.vertexPos.length; v++) {
        if (compSize[graph.component[v]] >= 2) eligible.push(v);
      }
      if (eligible.length >= 2) {
        // Per-component vertex lists so the end pick shares the start's
        // component — every emitted pair is guaranteed a route.
        const byComp = new Map<number, number[]>();
        for (const v of eligible) {
          const c = graph.component[v];
          let arr = byComp.get(c);
          if (!arr) {
            arr = [];
            byComp.set(c, arr);
          }
          arr.push(v);
        }
        for (let p = 0; p < count; p++) {
          const start = eligible[Math.floor(rand01(seed, p * 2) * eligible.length)];
          const mates = byComp.get(graph.component[start])!;
          let end = mates[Math.floor(rand01(seed, p * 2 + 1) * mates.length)];
          if (end === start) end = mates[(mates.indexOf(start) + 1) % mates.length];
          const path = shortestPathInGraph(graph, [start], new Set([end]));
          if (!path) continue;
          const sub = buildPathSubpath(src.subpaths, graph, path);
          if (sub) {
            sub.groupIndex = p;
            out.push(sub);
          }
        }
      }
    }

    const result: SplineValue = { kind: "spline", subpaths: out };
    return { primary: result };
  },
};
