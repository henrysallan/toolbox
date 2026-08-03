import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  PointsValue,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  buildPointsGraph,
  buildSplineGraph,
  buildTreeInGraph,
  shortestPathInGraph,
  type SplineGraph,
} from "@/engine/spline-graph";
import { makePoints } from "@/engine/points";
import {
  computeSegmentShapeHandles,
  readSegmentShapeParams,
  segmentShapeModeParams,
  segmentShapePathParam,
  type SegmentShapeEdge,
} from "@/engine/segment-shape";

// Shortest Path — route through a network and emit the route as a spline.
// Three modes behind a `mode` header control (mode-anchored resolvers,
// the group-pick pattern):
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
//  - tree: the "easy mode" — one root point (picked by index slider)
//    fans out to EVERY reachable point over the same hop graph as a
//    rooted tree: paths split but never re-join. `wander` morphs a
//    shortest-path tree (direct, radial) into a minimum spanning tree
//    (minimal wire, meandering) via one generalized Prim/Dijkstra pass;
//    `jitter` + seed wobble the routing; max branches / depth limit
//    shape it. Emit root→leaf branch subpaths (overlapping trunks — Trim
//    Path grows the whole tree from the root) or unique per-edge
//    segments. `update` locked captures the topology at frame 0 (and on
//    topology-param/count change) so edges stretch as points animate;
//    live rebuilds per frame, with `smooth` gliding reconfigured
//    connections to their new parent (per-node state; the ONLY stateful
//    corner of this node — see fingerprintExtras/dispose).
//    Spec: specdocs/073126_shortest-path-tree-mode.md.
//
// Path shaping: points + tree modes share Connect Points' `path` mode
// enum (engine/segment-shape.ts — arcs/S-curves, sag, flow, network,
// bundle, attract) applied per emitted hop, with interior chain anchors
// taking the in-handle of one edge and the out-handle of the next
// (network mode ⇒ through-point smoothing; at tree junctions branches
// stay tangent-consistent). Spline mode is exempt — it re-emits the
// network's own authored curved segments, which shaping would destroy.
// Spec: specdocs/073126_connect-points-curved-paths.md.
//
// Group indices use Select by Index semantics everywhere (missing tags ⇒
// bucket 0; indices pick into the sorted distinct buckets and clamp).
// Pairs with Trim Path's trim_offset for the animated traversal look.
// Pure CPU + deterministic (hash-based PRNG, no Math.random) — normal
// fingerprint caching. Spec: specdocs/071026_spline-points-nodes.md.

type Mode = "points" | "spline" | "tree";

const stateKey = (nodeId: string) => `shortest-path:${nodeId}`;

// Gate for the shared path-shaping params: everything but spline mode.
const notSplineMode = (p: Record<string, unknown>) =>
  (((p.mode as string) ?? "points") as Mode) !== "spline";

// Tree-mode per-node state (ctx.state). `locked` holds the captured
// topology; `glide` the displayed parent-end per point (parent glide).
interface TreeModeState {
  locked?: {
    captureKey: string;
    parent: Int32Array;
    depth: Int32Array;
    order: number[];
  };
  glide?: {
    prevParent: Int32Array;
    displayed: Float32Array; // 2N displayed far-ends, canvas-normalized
    flight: Uint8Array; // 1 while that point's connection is mid-glide
    lastTime: number;
    inFlight: boolean;
  };
}

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

// Copy the points at `indices` (in that order) with original attributes
// intact — the aux-output contract of both points and tree modes.
function pickPoints(src: PointsValue, indices: ArrayLike<number>): PointsValue {
  const out = makePoints(indices.length, {
    withScales: !!src.scales,
    withRotations: !!src.rotations,
    withGroupIndices: !!src.groupIndices,
  });
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    out.positions[k * 2] = src.positions[i * 2];
    out.positions[k * 2 + 1] = src.positions[i * 2 + 1];
    if (src.scales) {
      out.scales![k * 2] = src.scales[i * 2];
      out.scales![k * 2 + 1] = src.scales[i * 2 + 1];
    }
    if (src.rotations) out.rotations![k] = src.rotations[i];
    if (src.groupIndices) out.groupIndices![k] = src.groupIndices[i];
  }
  return out;
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
    "Route through a network and output the path as a spline. Points mode: hops between points within the max distance, from a start position (snapped to the nearest point) to an end position or group — visited points ride the aux output. Spline mode: walks a wired network's own curved segments between two groups, or emits N seeded random routes. Tree mode: one root point (by index) fans out to every reachable point as a branching tree that never re-crosses — wander morphs direct↔minimal branching, and the update mode locks the topology at frame 0 (edges stretch as points move) or rebuilds live with an optional glide. Points and tree modes share Connect Points' path shaping (arcs / S-curves, sag, flow, network smoothing, bundling, attract). Animate the draw-on with Trim Path.",
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
    if (mode === "tree") {
      // The root is a param (exposable ⇒ wireable as a scalar for free).
      return [{ name: "points", type: "points", required: true }];
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
      options: ["points", "spline", "tree"],
      default: "points",
    },
    // ---- points + tree modes ----
    {
      name: "max_distance",
      label: "Max hop distance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.1,
      visibleIf: (p) => ((p.mode as string) ?? "points") !== "spline",
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
    // Shared: spline random-select's seed AND tree jitter's seed.
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
      visibleIf: (p) => {
        const mode = ((p.mode as string) ?? "points") as Mode;
        if (mode === "tree") return true;
        return (
          mode === "spline" && ((p.select as string) ?? "groups") === "random"
        );
      },
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
    // ---- tree mode ----
    {
      name: "root_index",
      label: "Root index",
      type: "scalar",
      min: 0,
      max: 10000,
      softMax: 99,
      step: 1,
      default: 0,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    // 0 = direct routes to the root (shortest-path tree, radial /
    // lightning); 1 = minimal total wire (spanning tree, meandering veins).
    {
      name: "wander",
      label: "Wander",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    {
      name: "jitter",
      label: "Jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    {
      name: "max_children",
      label: "Max branches",
      type: "scalar",
      min: 0,
      max: 12,
      step: 1,
      default: 0,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    {
      name: "depth_limit",
      label: "Depth limit",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 50,
      step: 1,
      default: 0,
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    {
      name: "emit",
      label: "Emit",
      type: "enum",
      options: ["branches", "segments"],
      control: "segmented",
      default: "branches",
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    {
      name: "update",
      label: "Update",
      type: "enum",
      options: ["locked", "live"],
      control: "segmented",
      default: "locked",
      visibleIf: (p) => ((p.mode as string) ?? "points") === "tree",
    },
    {
      name: "smooth",
      label: "Glide",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) =>
        ((p.mode as string) ?? "points") === "tree" &&
        ((p.update as string) ?? "locked") === "live",
    },
    // ---- path shaping (points + tree; spline mode keeps its authored
    // geometry) ----
    segmentShapePathParam(notSplineMode),
    ...segmentShapeModeParams(notSplineMode),
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const mode = ((params.mode as string) ?? "points") as Mode;
    return mode === "spline" ? [] : [{ name: "points", type: "points" }];
  },

  // Tree-mode glide re-evaluates per frame ONLY while a transition is in
  // flight (state flag) — at rest the node is fully cacheable again.
  // Locked mode needs no extras: its state only changes when topology
  // params / point count change (already fingerprinted) or at tick 0,
  // where recapture is a no-op unless upstream changed (also
  // fingerprinted).
  fingerprintExtras(params, ctx, nodeId) {
    if (!nodeId) return "";
    if (((params.mode as string) ?? "points") !== "tree") return "";
    if (((params.update as string) ?? "locked") !== "live") return "";
    if (((params.smooth as number) ?? 0) <= 0) return "";
    const st = ctx.state[stateKey(nodeId)] as TreeModeState | undefined;
    return st?.glide?.inFlight ? `glide:${ctx.time}` : "";
  },
  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const empty: SplineValue = { kind: "spline", subpaths: [] };
    const mode = ((params.mode as string) ?? "points") as Mode;

    if (mode === "tree") {
      const src = inputs.points;
      if (!src || src.kind !== "points" || src.count < 2) {
        return { primary: empty, aux: { points: makePoints(0) } };
      }
      const count = src.count;
      const positions = src.positions;
      const maxD = Math.max(0, (params.max_distance as number) ?? 0.1);
      const rootIdx = Math.max(
        0,
        Math.min(count - 1, Math.floor((params.root_index as number) ?? 0))
      );
      const wander = Math.min(1, Math.max(0, (params.wander as number) ?? 0.5));
      const jitter = Math.min(1, Math.max(0, (params.jitter as number) ?? 0));
      const seed = Math.floor((params.seed as number) ?? 0);
      const maxChildren = Math.max(
        0,
        Math.floor((params.max_children as number) ?? 0)
      );
      const depthLimit = Math.max(
        0,
        Math.floor((params.depth_limit as number) ?? 0)
      );
      const update = ((params.update as string) ?? "locked") as
        | "locked"
        | "live";
      const smooth =
        update === "live" ? Math.max(0, (params.smooth as number) ?? 0) : 0;

      const buildTopology = () => {
        const graph = buildPointsGraph(
          positions,
          count,
          src.groupIndices,
          maxD
        );
        let edgeCosts: Float64Array | undefined;
        if (jitter > 0) {
          // Jitter keys on the unordered point-index PAIR (not the edge's
          // array slot) so live rebuilds don't reshuffle the wobble.
          // Inflate-only multiplier in [1, 1 + 3·jitter) — never ≤ 0.
          edgeCosts = new Float64Array(graph.edges.length);
          for (let e = 0; e < graph.edges.length; e++) {
            const edge = graph.edges[e];
            const lo = Math.min(edge.a, edge.b);
            const hi = Math.max(edge.a, edge.b);
            const r = rand01(seed ^ Math.imul(lo + 1, 0x27d4eb2f), hi);
            edgeCosts[e] = edge.length * (1 + 3 * jitter * r);
          }
        }
        return buildTreeInGraph(graph, rootIdx, {
          alpha: 1 - wander,
          maxChildren,
          depthLimit,
          edgeCosts,
        });
      };

      const state = ((ctx.state[stateKey(nodeId)] as
        | TreeModeState
        | undefined) ?? (ctx.state[stateKey(nodeId)] = {})) as TreeModeState;

      let topo: { parent: Int32Array; depth: Int32Array; order: number[] };
      if (update === "locked") {
        // Topology captured; recapture on tick 0 (loop restart / playhead
        // at frame 0), topology-param change, or count change. Emission
        // below always uses CURRENT positions → edges stretch.
        const captureKey = [
          rootIdx,
          maxD,
          wander,
          jitter,
          seed,
          maxChildren,
          depthLimit,
          count,
        ].join("|");
        if (
          !state.locked ||
          state.locked.captureKey !== captureKey ||
          ctx.tick === 0
        ) {
          const t = buildTopology();
          state.locked = {
            captureKey,
            parent: t.parent,
            depth: t.depth,
            order: t.order,
          };
        }
        topo = state.locked;
        state.glide = undefined;
      } else {
        topo = buildTopology();
        state.locked = undefined;
      }
      const { parent, depth, order } = topo;

      // Parent glide (live + smooth): each point's displayed far-end pins
      // to its parent while the connection is stable, and exponentially
      // glides to the new parent when a rebuild reassigns it.
      let glide: TreeModeState["glide"];
      if (smooth > 0) {
        let g = state.glide;
        const now = ctx.time;
        if (!g || g.prevParent.length !== count) {
          // (Re)seed pinned at targets — no intro flight on first build
          // or count change.
          g = state.glide = {
            prevParent: Int32Array.from(parent),
            displayed: new Float32Array(count * 2),
            flight: new Uint8Array(count),
            lastTime: now,
            inFlight: false,
          };
          for (let v = 0; v < count; v++) {
            const u = parent[v] >= 0 ? parent[v] : v;
            g.displayed[v * 2] = positions[u * 2];
            g.displayed[v * 2 + 1] = positions[u * 2 + 1];
          }
        }
        const dt = Math.max(0, now - g.lastTime); // loop wrap / scrub-back ⇒ 0
        g.lastTime = now;
        const k = 1 - Math.exp(-dt / Math.max(smooth, 1e-6));
        const EPS2 = 1e-4 * 1e-4;
        let inFlight = false;
        for (let v = 0; v < count; v++) {
          const u = parent[v];
          if (u < 0) {
            // Root/unreached: park at the point itself so a future
            // connection grows out of it instead of flying in from stale
            // positions.
            g.displayed[v * 2] = positions[v * 2];
            g.displayed[v * 2 + 1] = positions[v * 2 + 1];
            g.flight[v] = 0;
            g.prevParent[v] = u;
            continue;
          }
          if (g.prevParent[v] !== u) {
            g.flight[v] = 1; // reconfigured (or retargeted mid-flight)
            g.prevParent[v] = u;
          }
          const tx = positions[u * 2];
          const ty = positions[u * 2 + 1];
          if (!g.flight[v]) {
            g.displayed[v * 2] = tx;
            g.displayed[v * 2 + 1] = ty;
            continue;
          }
          const dx = tx - g.displayed[v * 2];
          const dy = ty - g.displayed[v * 2 + 1];
          if (dx * dx + dy * dy <= EPS2) {
            g.displayed[v * 2] = tx;
            g.displayed[v * 2 + 1] = ty;
            g.flight[v] = 0;
          } else {
            g.displayed[v * 2] += dx * k;
            g.displayed[v * 2 + 1] += dy * k;
            inFlight = true;
          }
        }
        g.inFlight = inFlight;
        glide = g;
      } else {
        state.glide = undefined;
      }

      const farX = (v: number) =>
        glide ? glide.displayed[v * 2] : positions[parent[v] * 2];
      const farY = (v: number) =>
        glide ? glide.displayed[v * 2 + 1] : positions[parent[v] * 2 + 1];

      const emit = ((params.emit as string) ?? "branches") as
        | "branches"
        | "segments";
      const subpathsOut: SplineSubpath[] = [];

      // Path shaping (shared segment-shape machinery). Position table =
      // the input points; a GLIDING far-end appends a synthetic entry
      // (memoized per vertex), while a resting far-end reuses the
      // parent's own index so network tangents stay shared at
      // junctions. Random keys always use the true (parent, child)
      // pair — stable across glide states.
      const shape = readSegmentShapeParams(params);
      const shaping = shape.mode !== "straight";
      const shapeAspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
      const tblX: number[] = [];
      const tblY: number[] = [];
      const stubIdx = new Map<number, number>();
      if (shaping) {
        for (let v = 0; v < count; v++) {
          tblX.push(positions[v * 2]);
          tblY.push(positions[v * 2 + 1]);
        }
      }
      const farIdx = (v: number): number => {
        if (glide && glide.flight[v]) {
          let idx = stubIdx.get(v);
          if (idx === undefined) {
            tblX.push(farX(v));
            tblY.push(farY(v));
            idx = tblX.length - 1;
            stubIdx.set(v, idx);
          }
          return idx;
        }
        return parent[v];
      };

      if (emit === "segments") {
        // Every edge exactly once; groupIndex = the child's depth.
        const treeEdges: SegmentShapeEdge[] = [];
        for (const v of order) {
          if (parent[v] < 0) continue;
          subpathsOut.push({
            anchors: [
              { pos: [farX(v), farY(v)] },
              { pos: [positions[v * 2], positions[v * 2 + 1]] },
            ],
            closed: false,
            groupIndex: depth[v],
          });
          if (shaping) treeEdges.push({ i: farIdx(v), j: v, ki: parent[v], kj: v });
        }
        if (shaping) {
          const hs = computeSegmentShapeHandles({
            edges: treeEdges,
            x: tblX,
            y: tblY,
            aspect: shapeAspect,
            p: shape,
            centroidCount: count,
          });
          for (let k = 0; k < hs.length; k++) {
            const h = hs[k];
            if (h.out) subpathsOut[k].anchors[0].outHandle = h.out;
            if (h.in) subpathsOut[k].anchors[1].inHandle = h.in;
          }
        }
      } else {
        // branches: one root→leaf chain per effective leaf (overlapping
        // trunks — Trim Path grows the tree from the root). In-flight
        // edges CUT the tree: each detached subtree emits its own chains
        // from the gliding stub and re-fuses once converged.
        const nonCutChildren = new Int32Array(count);
        for (const v of order) {
          const u = parent[v];
          if (u >= 0 && !(glide && glide.flight[v])) nonCutChildren[u]++;
        }
        let branchIndex = 0;
        // Per chain: the anchors plus parallel table-index / key-vertex
        // arrays, so handles can be assigned after one whole-tree
        // segment-shape pass (network/bundle need every edge at once).
        const chains: {
          anchors: SplineAnchor[];
          idx: number[];
          keys: number[];
        }[] = [];
        for (const leaf of order) {
          if (nonCutChildren[leaf] > 0) continue;
          const anchors: SplineAnchor[] = [
            { pos: [positions[leaf * 2], positions[leaf * 2 + 1]] },
          ];
          const idx: number[] = [leaf];
          const keys: number[] = [leaf];
          let v = leaf;
          while (parent[v] >= 0) {
            if (glide && glide.flight[v]) {
              anchors.push({ pos: [farX(v), farY(v)] }); // gliding stub end
              if (shaping) {
                idx.push(farIdx(v));
                keys.push(parent[v]);
              }
              break;
            }
            const u = parent[v];
            anchors.push({ pos: [positions[u * 2], positions[u * 2 + 1]] });
            if (shaping) {
              idx.push(u);
              keys.push(u);
            }
            v = u;
          }
          if (anchors.length < 2) continue; // isolated root
          anchors.reverse();
          if (shaping) {
            idx.reverse();
            keys.reverse();
            chains.push({ anchors, idx, keys });
          }
          subpathsOut.push({
            anchors,
            closed: false,
            groupIndex: branchIndex++,
          });
        }
        if (shaping && chains.length > 0) {
          const chainEdges: SegmentShapeEdge[] = [];
          for (const c of chains) {
            for (let k = 0; k + 1 < c.idx.length; k++) {
              chainEdges.push({
                i: c.idx[k],
                j: c.idx[k + 1],
                ki: c.keys[k],
                kj: c.keys[k + 1],
              });
            }
          }
          const hs = computeSegmentShapeHandles({
            edges: chainEdges,
            x: tblX,
            y: tblY,
            aspect: shapeAspect,
            p: shape,
            centroidCount: count,
          });
          let e = 0;
          for (const c of chains) {
            for (let k = 0; k + 1 < c.idx.length; k++, e++) {
              const h = hs[e];
              if (h.out) c.anchors[k].outHandle = h.out;
              if (h.in) c.anchors[k + 1].inHandle = h.in;
            }
          }
        }
      }

      // Aux: reachable points in settle order (≈ distance-from-root order
      // — staggered Copy to Points cascades), original attributes intact.
      return {
        primary: { kind: "spline", subpaths: subpathsOut } as SplineValue,
        aux: { points: pickPoints(src, order) },
      };
    }

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

      // Path shaping: hop edges through the shared segment-shape pass;
      // interior anchors take edge k's in-handle and edge k+1's
      // out-handle (network mode ⇒ through-point smoothing of the
      // route). Table = the whole cloud so attract's centroid matches
      // Connect Points semantics.
      const shape = readSegmentShapeParams(params);
      if (shape.mode !== "straight" && anchors.length >= 2) {
        const V = graph.vertexPos.length;
        const x = new Float64Array(V);
        const y = new Float64Array(V);
        for (let v = 0; v < V; v++) {
          x[v] = graph.vertexPos[v][0];
          y[v] = graph.vertexPos[v][1];
        }
        const chainEdges: SegmentShapeEdge[] = [];
        for (let k = 0; k + 1 < path.vertices.length; k++) {
          chainEdges.push({ i: path.vertices[k], j: path.vertices[k + 1] });
        }
        const hs = computeSegmentShapeHandles({
          edges: chainEdges,
          x,
          y,
          aspect: ctx.height > 0 ? ctx.width / ctx.height : 1,
          p: shape,
        });
        for (let k = 0; k < hs.length; k++) {
          const h = hs[k];
          if (h.out) anchors[k].outHandle = h.out;
          if (h.in) anchors[k + 1].inHandle = h.in;
        }
      }

      const route: SplineValue = {
        kind: "spline",
        subpaths: [{ anchors, closed: false }],
      };

      // Visited points in path order, original attributes intact.
      return { primary: route, aux: { points: pickPoints(src, path.vertices) } };
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
