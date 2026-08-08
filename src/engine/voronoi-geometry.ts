import { Delaunay } from "d3-delaunay";
import type { Point, PointsValue, SplineSubpath } from "./types";

// Shared Voronoi geometry derivation for the unified Voronoi node
// (specdocs/archive/073026_voronoi-unified.md). Given a feature-point set in an
// isotropic "metric space" (where euclidean distance matches what the
// shader measures), derives the actual diagram as splines + points:
//
//   cells     — one closed subpath per cell (groupIndex = stable id,
//               driver = per-cell random), optionally edge-bowed
//   edges     — deduplicated 2-anchor open segments (cell walls)
//   vertices  — cell corners incl. bounding-box clip points
//   centers   — the feature points themselves; groupIndices = cell ids,
//               scales = per-cell polygon area (mean-normalized to 1) so
//               Copy-to-Points sizes instances by cell area for free
//   neighbors — the Delaunay dual: segments connecting adjacent cell
//               centers (plexus / mesh looks; feeds String Art etc.)
//
// All outputs are mapped via the caller-provided diagonal affine map
// into AUTHORED spline/points space: normalized Y-DOWN with the
// engine's aspect convention (engine/aspect.ts — consumers apply
// y_canvas = 0.5 + (y − 0.5)·aspect at render time, so authored y is in
// width-units, centered). Callers fold aspectUncorrectY into `map`; on
// a square canvas authored == canvas uv. The geometry is always the
// EUCLIDEAN diagram — under other metrics (manhattan/chebyshev/
// minkowski) the rendered cell walls aren't straight lines, so the
// splines won't overlay the image exactly; documented on the node.

// ---------------------------------------------------------------------
// pcg3d integer hash (Jarzynski & Olano, "Hash Functions for GPU
// Rendering"). This is THE shared hash between the Voronoi shaders and
// this CPU mirror — uint32 arithmetic is bit-exact on both sides
// (Math.imul / >>> here, native uints in GLSL 300 es), which is what
// makes the spline outputs overlay the render exactly. The old
// fract(sin(x)*43758) hash could NOT be mirrored: GPU sin() precision at
// large arguments is implementation-defined and the ×43758 amplification
// makes the divergence chaotic, not epsilon.
//
// Keep this function in lockstep with PCG3D_GLSL in nodes/source/
// voronoi.ts — same constants, same statement order (each component
// update reads the previously-updated components).
export function pcg3d(
  xIn: number,
  yIn: number,
  zIn: number
): [number, number, number] {
  let x = (Math.imul(xIn, 1664525) + 1013904223) >>> 0;
  let y = (Math.imul(yIn, 1664525) + 1013904223) >>> 0;
  let z = (Math.imul(zIn, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  return [x, y, z];
}

// uint32 → [0,1). Math.fround replicates GLSL's float(uint) rounding
// (uint has up to 32 significant bits, fp32 keeps 24); dividing by the
// exact power of two 2^32 introduces no further rounding, so the fp64
// result here equals the fp32 result on the GPU exactly.
export function pcgUnit(h: number): number {
  return Math.fround(h >>> 0) / 4294967296;
}

export interface VoronoiGeometryInput {
  // Feature points in metric space, interleaved [x0,y0, x1,y1, ...].
  sites: Float64Array | Float32Array;
  siteCount: number;
  // Canvas rect in metric space — cells are clipped to it.
  bounds: [number, number, number, number];
  // Diagonal affine metric→AUTHORED-space map:
  // authored = (m.x*sx + ox, m.y*sy + oy). Both metric and authored
  // space are isotropic, so sx === sy in practice (conformal — edge-bow
  // perpendiculars stay perpendicular after mapping).
  map: { sx: number; sy: number; ox: number; oy: number };
  // Stable id per site. null ⇒ dense sequential ids are assigned to the
  // sites that actually produce a (non-empty, clipped) cell, in site
  // order — keeps groupIndex contiguous 0..N-1 for pickers.
  ids?: Int32Array | null;
  // Per-site random in [0,1] for the cells' `driver` field. null ⇒ none.
  drivers?: Float32Array | null;
  // Bow each cell edge into a bezier: >0 bulges outward (bubble
  // packing), <0 inward (pebble mosaic). Cells only — the deduped
  // `edges` output has no owning cell to define "outward".
  edgeBow?: number;
}

export interface VoronoiGeometry {
  cells: SplineSubpath[];
  edges: SplineSubpath[];
  vertices: Point[];
  centers: PointsValue;
  neighbors: SplineSubpath[];
}

const EMPTY_POINTS: PointsValue = {
  kind: "points",
  count: 0,
  positions: new Float32Array(0),
  points: [],
};

export function emptyVoronoiGeometry(): VoronoiGeometry {
  return {
    cells: [],
    edges: [],
    vertices: [],
    centers: EMPTY_POINTS,
    neighbors: [],
  };
}

// Max bulge ≈ 0.3 × edge length at |bow| = 1 (handles at the third
// points, displaced 0.4·L along the normal).
const BOW_HANDLE = 0.4;

export function deriveVoronoiGeometry(
  input: VoronoiGeometryInput
): VoronoiGeometry {
  const n = input.siteCount;
  if (n < 2) return emptyVoronoiGeometry();
  const { sites, bounds, map, ids, drivers } = input;
  const bow = input.edgeBow ?? 0;

  const delaunay = new Delaunay(
    sites.length === n * 2 ? sites : sites.subarray(0, n * 2)
  );
  const voronoi = delaunay.voronoi(bounds);

  const cells: SplineSubpath[] = [];
  const edges: SplineSubpath[] = [];
  const vertices: Point[] = [];
  const neighbors: SplineSubpath[] = [];

  // Quantize to a 1e-6 grid for dedup keys — same rationale as the old
  // Fracture derivation: d3 shares circumcenter coords between adjacent
  // cells, but bounding-box clip intersections can land on slightly
  // different values from each cell's perspective.
  const q = (v: number) => Math.round(v * 1e6) / 1e6;
  const vk = (x: number, y: number) => `${q(x)},${q(y)}`;
  const seenEdges = new Set<string>();
  const seenVerts = new Set<string>();

  const toUvX = (x: number) => x * map.sx + map.ox;
  const toUvY = (y: number) => y * map.sy + map.oy;

  // First pass: collect the clipped polygons + areas so ids can be
  // assigned densely and areas mean-normalized before emitting.
  const polys: Array<{
    site: number;
    poly: ArrayLike<[number, number]>;
    area: number;
    cx: number;
    cy: number;
  }> = [];
  for (let i = 0; i < n; i++) {
    const poly = voronoi.cellPolygon(i);
    // d3 closes the ring (first === last); need ≥3 distinct vertices.
    if (!poly || poly.length < 4) continue;
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < poly.length - 1; j++) {
      const [x0, y0] = poly[j];
      const [x1, y1] = poly[j + 1];
      area += x0 * y1 - x1 * y0;
      cx += x0;
      cy += y0;
    }
    area = Math.abs(area) / 2;
    if (area < 1e-12) continue;
    cx /= poly.length - 1;
    cy /= poly.length - 1;
    polys.push({ site: i, poly, area, cx, cy });
  }
  if (polys.length === 0) return emptyVoronoiGeometry();

  let meanArea = 0;
  for (const p of polys) meanArea += p.area;
  meanArea /= polys.length;

  const centerCount = polys.length;
  const centerPositions = new Float32Array(centerCount * 2);
  const centerScales = new Float32Array(centerCount * 2);
  const centerGroups = new Int32Array(centerCount);
  // Site → emitted-cell id, for the neighbors pass.
  const siteId = new Int32Array(n).fill(-1);

  for (let k = 0; k < polys.length; k++) {
    const { site, poly, area, cx, cy } = polys[k];
    const id = ids ? ids[site] : k;
    siteId[site] = id;

    // ---- cells ------------------------------------------------------
    const count = poly.length - 1; // drop the duplicate closing vertex
    const anchors: SplineSubpath["anchors"] = [];
    for (let j = 0; j < count; j++) {
      anchors.push({
        pos: [toUvX(poly[j][0]), toUvY(poly[j][1])] as [number, number],
      });
    }
    if (bow !== 0) {
      // Per edge j → j+1: handles at the third points, displaced along
      // the outward normal (checked against the centroid so winding
      // doesn't matter). Computed in metric space — perpendicular is
      // only meaningful there — then mapped as offsets.
      for (let j = 0; j < count; j++) {
        const jn = (j + 1) % count;
        const [ax, ay] = poly[j];
        const [bx, by] = poly[jn];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        let nx = -dy / len;
        let ny = dx / len;
        const mx = (ax + bx) / 2 - cx;
        const my = (ay + by) / 2 - cy;
        if (nx * mx + ny * my < 0) {
          nx = -nx;
          ny = -ny;
        }
        const h = bow * BOW_HANDLE * len;
        const ox = dx / 3 + nx * h;
        const oy = dy / 3 + ny * h;
        anchors[j].outHandle = [ox * map.sx, oy * map.sy];
        anchors[jn].inHandle = [
          (-dx / 3 + nx * h) * map.sx,
          (-dy / 3 + ny * h) * map.sy,
        ];
      }
    }
    const cell: SplineSubpath = { anchors, closed: true, groupIndex: id };
    if (drivers) cell.driver = drivers[site];
    cells.push(cell);

    // ---- centers ----------------------------------------------------
    centerPositions[k * 2] = toUvX(sites[site * 2]);
    centerPositions[k * 2 + 1] = toUvY(sites[site * 2 + 1]);
    const s = meanArea > 0 ? area / meanArea : 1;
    centerScales[k * 2] = s;
    centerScales[k * 2 + 1] = s;
    centerGroups[k] = id;

    // ---- edges + vertices (deduped) ---------------------------------
    for (let j = 0; j < count; j++) {
      const [x0, y0] = poly[j];
      const [x1, y1] = poly[(j + 1) % count];
      const a = vk(x0, y0);
      const b = vk(x1, y1);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({
          anchors: [
            { pos: [toUvX(x0), toUvY(y0)] },
            { pos: [toUvX(x1), toUvY(y1)] },
          ],
          closed: false,
        });
      }
      if (!seenVerts.has(a)) {
        seenVerts.add(a);
        vertices.push({ pos: [toUvX(x0), toUvY(y0)] });
      }
    }
  }

  // ---- neighbors (Delaunay dual) ------------------------------------
  // Each interior Delaunay edge appears as two halfedges; emit it once
  // (e > halfedges[e] also catches hull edges, where halfedges[e] = -1).
  // Only segments with at least one endpoint inside the canvas rect —
  // off-canvas sites (the lattice ring) would otherwise add a halo.
  const [bx0, by0, bx1, by1] = bounds;
  const inside = (s: number) => {
    const x = sites[s * 2];
    const y = sites[s * 2 + 1];
    return x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
  };
  const { triangles, halfedges } = delaunay;
  for (let e = 0; e < triangles.length; e++) {
    if (e <= halfedges[e]) continue;
    const p = triangles[e];
    const r = triangles[e % 3 === 2 ? e - 2 : e + 1];
    if (!inside(p) && !inside(r)) continue;
    neighbors.push({
      anchors: [
        { pos: [toUvX(sites[p * 2]), toUvY(sites[p * 2 + 1])] },
        { pos: [toUvX(sites[r * 2]), toUvY(sites[r * 2 + 1])] },
      ],
      closed: false,
    });
  }

  const centers: PointsValue = {
    kind: "points",
    count: centerCount,
    positions: centerPositions,
    scales: centerScales,
    groupIndices: centerGroups,
    points: [],
  };

  return { cells, edges, vertices, centers, neighbors };
}
