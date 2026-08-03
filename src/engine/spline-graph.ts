import type { SplineSubpath } from "./types";
import { subpathToBeziers } from "./spline-math";

// Walkable graphs behind the Shortest Path node. Two builders, one shape:
//
//  - buildSplineGraph: vertices are anchor positions welded within a
//    tolerance (branching networks connect where subpath endpoints/anchors
//    touch — mid-segment crossings are NOT junctions); edges are the
//    original cubic segments between consecutive anchors, weighted by arc
//    length.
//  - buildPointsGraph: vertices are the points themselves (vertex id ==
//    point index, so callers can map back to point attributes); edges join
//    every pair within a max hop distance (Connect Points semantics),
//    weighted by euclidean distance.
//
// Routing over either graph: shortestPathInGraph (multi-source Dijkstra)
// and buildTreeInGraph (rooted-tree growth, SPT↔MST morph — tree mode).
// Pure CPU, deterministic, engine-self-contained.
// See specdocs/071026_spline-points-nodes.md +
// specdocs/073126_shortest-path-tree-mode.md.

type V2 = [number, number];

export interface GraphEdge {
  a: number; // vertex id at the segment's start anchor
  b: number; // vertex id at the segment's end anchor
  length: number;
  // Spline graphs only — points-graph edges carry -1 for both.
  subIndex: number; // owning subpath
  segIndex: number; // segment i runs anchors[i] → anchors[(i+1) % n]
}

export interface SplineGraph {
  vertexPos: V2[]; // representative (first-seen) position per vertex
  edges: GraphEdge[];
  adjacency: number[][]; // per-vertex incident edge indices
  // groupIndex buckets (missing tag ⇒ 0, matching Select by Index) of the
  // subpaths incident to each vertex.
  vertexGroups: Set<number>[];
  component: Int32Array; // connected-component id per vertex
  componentCount: number;
}

// Build the graph. `weldDistance` merges anchors into one vertex when
// closer than the tolerance — quantized grid + 3×3 neighbor scan so pairs
// straddling a cell boundary still weld (first-come representative).
export function buildSplineGraph(
  subpaths: SplineSubpath[],
  weldDistance: number
): SplineGraph {
  const weld = Math.max(1e-9, weldDistance);
  const weld2 = weld * weld;
  const vertexPos: V2[] = [];
  const grid = new Map<string, number[]>();

  const vertexAt = (x: number, y: number): number => {
    const cx = Math.floor(x / weld);
    const cy = Math.floor(y / weld);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cx + dx}|${cy + dy}`);
        if (!bucket) continue;
        for (const v of bucket) {
          const ex = vertexPos[v][0] - x;
          const ey = vertexPos[v][1] - y;
          if (ex * ex + ey * ey <= weld2) return v;
        }
      }
    }
    const v = vertexPos.length;
    vertexPos.push([x, y]);
    const key = `${cx}|${cy}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(v);
    return v;
  };

  const edges: GraphEdge[] = [];
  const vertexGroups: Set<number>[] = [];
  const groupOf = (v: number): Set<number> =>
    (vertexGroups[v] ??= new Set<number>());

  for (let s = 0; s < subpaths.length; s++) {
    const sub = subpaths[s];
    const n = sub.anchors.length;
    if (n < 2) continue;
    const segs = subpathToBeziers(sub); // pairs 0-1, 1-2, …, closing last
    const bucket = sub.groupIndex ?? 0;
    // Weld each anchor once so a subpath's interior chain shares vertices.
    const vs: number[] = [];
    for (let i = 0; i < n; i++) {
      vs.push(vertexAt(sub.anchors[i].pos[0], sub.anchors[i].pos[1]));
    }
    for (let i = 0; i < segs.length; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % n];
      groupOf(a).add(bucket);
      groupOf(b).add(bucket);
      if (a === b && segs[i].length <= 1e-9) continue; // degenerate self-loop
      edges.push({ a, b, length: Math.max(segs[i].length, 1e-9), subIndex: s, segIndex: i });
    }
  }
  for (let v = 0; v < vertexPos.length; v++) groupOf(v);

  return finishGraph(vertexPos, edges, vertexGroups);
}

// Shared tail of both builders: adjacency lists + connected components.
function finishGraph(
  vertexPos: V2[],
  edges: GraphEdge[],
  vertexGroups: Set<number>[]
): SplineGraph {
  const adjacency: number[][] = vertexPos.map(() => []);
  for (let e = 0; e < edges.length; e++) {
    adjacency[edges[e].a].push(e);
    adjacency[edges[e].b].push(e);
  }

  // Connected components via BFS.
  const component = new Int32Array(vertexPos.length).fill(-1);
  let componentCount = 0;
  const queue: number[] = [];
  for (let v = 0; v < vertexPos.length; v++) {
    if (component[v] !== -1) continue;
    const id = componentCount++;
    component[v] = id;
    queue.length = 0;
    queue.push(v);
    while (queue.length) {
      const cur = queue.pop()!;
      for (const e of adjacency[cur]) {
        const other = edges[e].a === cur ? edges[e].b : edges[e].a;
        if (component[other] === -1) {
          component[other] = id;
          queue.push(other);
        }
      }
    }
  }

  return { vertexPos, edges, adjacency, vertexGroups, component, componentCount };
}

// Build the graph over a point cloud: vertex id == point index; every pair
// within `maxDistance` becomes an edge weighted by euclidean distance
// (Connect Points hop semantics, spatial-hash accelerated). `groupIndices`
// (missing ⇒ bucket 0) feed vertexGroups for group-targeted routing.
export function buildPointsGraph(
  positions: Float32Array,
  count: number,
  groupIndices: Int32Array | undefined,
  maxDistance: number
): SplineGraph {
  const vertexPos: V2[] = new Array(count);
  const vertexGroups: Set<number>[] = new Array(count);
  for (let i = 0; i < count; i++) {
    vertexPos[i] = [positions[i * 2], positions[i * 2 + 1]];
    vertexGroups[i] = new Set([groupIndices ? groupIndices[i] : 0]);
  }

  const edges: GraphEdge[] = [];
  const maxD = Math.max(0, maxDistance);
  if (maxD > 0 && count > 1) {
    const d2 = maxD * maxD;
    const cell = maxD;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const k = `${Math.floor(positions[i * 2] / cell)}|${Math.floor(positions[i * 2 + 1] / cell)}`;
      let arr = grid.get(k);
      if (!arr) {
        arr = [];
        grid.set(k, arr);
      }
      arr.push(i);
    }
    for (let i = 0; i < count; i++) {
      const ax = positions[i * 2];
      const ay = positions[i * 2 + 1];
      const cx = Math.floor(ax / cell);
      const cy = Math.floor(ay / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(`${cx + dx}|${cy + dy}`);
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const j = arr[k];
            if (j <= i) continue;
            const ex = ax - positions[j * 2];
            const ey = ay - positions[j * 2 + 1];
            const dd = ex * ex + ey * ey;
            if (dd > d2) continue;
            edges.push({
              a: i,
              b: j,
              length: Math.max(Math.sqrt(dd), 1e-9),
              subIndex: -1,
              segIndex: -1,
            });
          }
        }
      }
    }
  }

  return finishGraph(vertexPos, edges, vertexGroups);
}

// Grow a rooted tree over the graph — the Shortest Path node's tree mode
// (073126_shortest-path-tree-mode.md). One generalized Prim/Dijkstra pass:
// a vertex settles via the candidate edge minimizing
// `alpha * label(parent) + cost(edge)`, so alpha 1 is a shortest-path tree
// (direct, radial) and alpha 0 is a minimum spanning tree (least total
// wire, meandering); between is a continuous morph. `edgeCosts` (parallel
// to graph.edges) overrides raw lengths — jittered costs plug in here.
// `maxChildren` caps branching per vertex, root included (0 = off): the
// budget is charged at settle time, and a vertex popping with a full
// parent re-bids through settled neighbors with budget or parks until one
// settles next to it. `depthLimit` stops relaxation that many hops from
// the root (0 = off). Returns parent (-1 root, -2 unreached), depth
// (-1 unreached) and the deterministic settle order (root first).
export function buildTreeInGraph(
  graph: SplineGraph,
  root: number,
  opts: {
    alpha: number;
    maxChildren?: number;
    depthLimit?: number;
    edgeCosts?: Float64Array;
  }
): { parent: Int32Array; depth: Int32Array; order: number[] } {
  const N = graph.vertexPos.length;
  const parent = new Int32Array(N).fill(-2);
  const depth = new Int32Array(N).fill(-1);
  const order: number[] = [];
  if (N === 0 || root < 0 || root >= N) return { parent, depth, order };

  const alpha = Math.min(1, Math.max(0, opts.alpha));
  const cap = Math.max(0, Math.floor(opts.maxChildren ?? 0));
  const depthLimit = Math.max(0, Math.floor(opts.depthLimit ?? 0));
  const costs = opts.edgeCosts;
  const costOf = (e: number) =>
    Math.max(costs ? costs[e] : graph.edges[e].length, 1e-9);

  const dist = new Float64Array(N).fill(Infinity);
  const prevV = new Int32Array(N).fill(-1);
  const settled = new Uint8Array(N);
  const children = cap > 0 ? new Int32Array(N) : null;

  // Flat [key, vertex] min-heap (same layout as shortestPathInGraph). Pop
  // returns the key too: stale entries are skipped by the key === dist
  // check, which the max-children re-bid path relies on.
  const heap: number[] = [];
  const push = (d: number, v: number) => {
    heap.push(d, v);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= heap[i * 2]) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[p * 2 + k];
        heap[p * 2 + k] = heap[i * 2 + k];
        heap[i * 2 + k] = t;
      }
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const key = heap[0];
    const v = heap[1];
    const n = heap.length / 2 - 1;
    heap[0] = heap[n * 2];
    heap[1] = heap[n * 2 + 1];
    heap.length = n * 2;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && heap[l * 2] < heap[m * 2]) m = l;
      if (r < n && heap[r * 2] < heap[m * 2]) m = r;
      if (m === i) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[m * 2 + k];
        heap[m * 2 + k] = heap[i * 2 + k];
        heap[i * 2 + k] = t;
      }
      i = m;
    }
    return [key, v];
  };

  const full = (v: number) => children !== null && children[v] >= cap;
  const atLimit = (v: number) => depthLimit > 0 && depth[v] >= depthLimit;

  dist[root] = 0;
  push(0, root);
  while (heap.length) {
    const [key, v] = pop();
    if (settled[v] || key !== dist[v]) continue;
    const u = prevV[v];
    if (u !== -1 && full(u)) {
      // Recorded parent filled up since this entry was pushed — re-bid via
      // the cheapest settled neighbor with budget. No candidate ⇒ park with
      // dist reset to Infinity; a later adjacent settle re-relaxes it.
      let bestD = Infinity;
      let bestU = -1;
      for (const e of graph.adjacency[v]) {
        const edge = graph.edges[e];
        const w = edge.a === v ? edge.b : edge.a;
        if (!settled[w] || full(w) || atLimit(w)) continue;
        const nd = alpha * dist[w] + costOf(e);
        if (nd < bestD) {
          bestD = nd;
          bestU = w;
        }
      }
      dist[v] = bestD;
      prevV[v] = bestU;
      if (bestU !== -1) push(bestD, v);
      continue;
    }
    settled[v] = 1;
    if (u === -1) {
      parent[v] = -1;
      depth[v] = 0;
    } else {
      parent[v] = u;
      depth[v] = depth[u] + 1;
      if (children) children[u]++;
    }
    order.push(v);
    if (atLimit(v)) continue;
    for (const e of graph.adjacency[v]) {
      const edge = graph.edges[e];
      const other = edge.a === v ? edge.b : edge.a;
      if (settled[other]) continue;
      const nd = alpha * dist[v] + costOf(e);
      if (nd < dist[other]) {
        dist[other] = nd;
        prevV[other] = v;
        push(nd, other);
      }
    }
  }
  return { parent, depth, order };
}

// Multi-source Dijkstra: cost-0 seeds at every `sources` vertex, settle
// until the first `targets` vertex pops. Returns the walked edge ids in
// order plus the vertex chain (one longer), or null when unreachable.
// A vertex that is both source and target yields the empty path.
export function shortestPathInGraph(
  graph: SplineGraph,
  sources: number[],
  targets: Set<number>
): { vertices: number[]; edges: number[] } | null {
  const N = graph.vertexPos.length;
  if (N === 0 || sources.length === 0 || targets.size === 0) return null;
  const dist = new Float64Array(N).fill(Infinity);
  const prevEdge = new Int32Array(N).fill(-1);
  const prevVertex = new Int32Array(N).fill(-1);
  const settled = new Uint8Array(N);

  // Binary min-heap of [dist, vertex] pairs, laid flat.
  const heap: number[] = [];
  const push = (d: number, v: number) => {
    heap.push(d, v);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= heap[i * 2]) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[p * 2 + k];
        heap[p * 2 + k] = heap[i * 2 + k];
        heap[i * 2 + k] = t;
      }
      i = p;
    }
  };
  const pop = (): number => {
    const v = heap[1];
    const n = heap.length / 2 - 1;
    heap[0] = heap[n * 2];
    heap[1] = heap[n * 2 + 1];
    heap.length = n * 2;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && heap[l * 2] < heap[m * 2]) m = l;
      if (r < n && heap[r * 2] < heap[m * 2]) m = r;
      if (m === i) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[m * 2 + k];
        heap[m * 2 + k] = heap[i * 2 + k];
        heap[i * 2 + k] = t;
      }
      i = m;
    }
    return v;
  };

  for (const s of sources) {
    if (s >= 0 && s < N && dist[s] > 0) {
      dist[s] = 0;
      push(0, s);
    }
  }

  while (heap.length) {
    const v = pop();
    if (settled[v]) continue;
    settled[v] = 1;
    if (targets.has(v)) {
      const edgePath: number[] = [];
      const vertPath: number[] = [v];
      let cur = v;
      while (prevEdge[cur] !== -1) {
        edgePath.push(prevEdge[cur]);
        cur = prevVertex[cur];
        vertPath.push(cur);
      }
      edgePath.reverse();
      vertPath.reverse();
      return { vertices: vertPath, edges: edgePath };
    }
    for (const e of graph.adjacency[v]) {
      const edge = graph.edges[e];
      const other = edge.a === v ? edge.b : edge.a;
      if (settled[other]) continue;
      const nd = dist[v] + edge.length;
      if (nd < dist[other]) {
        dist[other] = nd;
        prevEdge[other] = e;
        prevVertex[other] = v;
        push(nd, other);
      }
    }
  }
  return null;
}
