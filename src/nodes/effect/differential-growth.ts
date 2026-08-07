import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { measureSubpath, resampleSubpath } from "@/engine/spline-math";
import {
  buildSpatialHash,
  cellStart,
  evenPolylinePoints,
  readMapBuffer,
  sampleMap,
  type MapCacheEntry,
  type SpatialHash,
} from "@/engine/sim-kernel";
import { makePoints, EMPTY_POINTS } from "@/engine/points";

// Differential Growth — specdocs/080226_differential-growth.md.
//
// A polyline where every node repels its neighbours, is pulled along the
// chain, and INSERTS a new node whenever an edge stretches past a
// threshold. Length is created faster than the surrounding space can
// absorb it, so the curve has nowhere to go but buckle: brain coral,
// kelp, ruffled leaf margins, intestines.
//
// This is Family B of the growth survey and the one property that sets it
// apart from Accretive Growth: the geometry at frame N does NOT contain
// frame N-1 — nodes move and edges merge. There is no trace to slice and
// therefore no `progress` param; putting one on this node would be a lie
// in the UI. It is a genuine per-frame simulation, with the Advect Points
// advance-gate and reset rules.
//
// Everything runs in true CANVAS PIXEL space (x = u*W, y = v*H) so a
// repulsion radius is a circle on screen. Scaling both axes by width
// instead would be isotropic only in the normalized square, which renders
// as a vertically squashed ellipse on any non-square canvas.

const MAX_ITER_PASSES = 20;
// Per-frame split probability at `growth_rate` 1. Keeps insertion gradual
// enough to read as growth rather than as a pop.
const SPLIT_RATE = 0.04;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Deterministic spatial hash in [0,1) — the `noise` growth driver. Keyed
// on the QUANTISED midpoint rather than on an index so a region keeps its
// growth character as nodes are inserted and renumbered around it.
function hash01(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = (h ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

interface Curve {
  // Interleaved px, length capacity*2.
  pos: Float32Array;
  count: number;
  closed: boolean;
  groupIndex?: number;
  initialLength: number;
}

interface DGState {
  curves: Curve[];
  initialized: boolean;
  lastTime: number;
  inputSig: string;
  frame: number;
  hash?: SpatialHash;
  maps: Record<string, MapCacheEntry | undefined>;
  // Per-frame scratch, reallocated only when the node count grows.
  flat?: Float32Array;
  delta?: Float32Array;
  owner?: Int32Array;
}

const stateKey = (nodeId: string) => `differential-growth:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): DGState {
  let s = ctx.state[stateKey(nodeId)] as DGState | undefined;
  if (!s) {
    s = {
      curves: [],
      initialized: false,
      lastTime: -1,
      inputSig: "",
      frame: 0,
      maps: {},
    };
    ctx.state[stateKey(nodeId)] = s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function polylineLength(pos: Float32Array, count: number, closed: boolean): number {
  let total = 0;
  const segs = closed ? count : count - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % count;
    total += Math.hypot(pos[j * 2] - pos[i * 2], pos[j * 2 + 1] - pos[i * 2 + 1]);
  }
  return total;
}

function seedCurves(
  src: SplineValue,
  W: number,
  H: number,
  spacingPx: number,
  maxAnchors: number
): Curve[] {
  const out: Curve[] = [];
  let budget = maxAnchors;
  for (const sub of src.subpaths) {
    if (sub.anchors.length < 2 || budget < 3) continue;
    const pxSub: SplineSubpath = {
      ...sub,
      anchors: sub.anchors.map((a) => {
        const o: SplineAnchor = { pos: [a.pos[0] * W, a.pos[1] * H] };
        if (a.inHandle) o.inHandle = [a.inHandle[0] * W, a.inHandle[1] * H];
        if (a.outHandle) o.outHandle = [a.outHandle[0] * W, a.outHandle[1] * H];
        return o;
      }),
    };
    const m = measureSubpath(pxSub);
    if (m.total <= 1e-3) continue;
    const minCount = sub.closed ? 3 : 2;
    let count = Math.max(
      minCount,
      Math.round(m.total / spacingPx) + (sub.closed ? 0 : 1)
    );
    if (count > budget) count = budget;
    if (count < minCount) continue;
    // Dense-sample the beziers first so a curved input seeds evenly
    // (rope-simulator's precedent — a handle-less segment otherwise
    // samples as smoothstep rather than linearly).
    const denseCount = Math.min(2048, Math.max(count * 3, 16));
    const rs = resampleSubpath(pxSub, denseCount);
    const pts = evenPolylinePoints(
      rs.anchors.map((a) => a.pos),
      !!sub.closed,
      count
    );
    const cap = Math.max(count * 2, 16);
    const pos = new Float32Array(cap * 2);
    for (let i = 0; i < count * 2; i++) pos[i] = pts[i];
    out.push({
      pos,
      count,
      closed: !!sub.closed,
      groupIndex: sub.groupIndex,
      initialLength: polylineLength(pos, count, !!sub.closed),
    });
    budget -= count;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface SimParams {
  mode: string;
  splitPx: number;
  collapsePx: number;
  growthRate: number;
  repulsionPx: number;
  repulsion: number;
  attraction: number;
  bend: number;
  pressure: number;
  damping: number;
  iterations: number;
  interCurve: boolean;
  pinEnds: boolean;
  containment: number;
  maxAnchors: number;
  seed: number;
}

interface Fields {
  region: { data: Float32Array; w: number; h: number } | null;
  obstacles: { data: Float32Array; w: number; h: number } | null;
  growth: { data: Float32Array; w: number; h: number } | null;
}

// Signed area — tells us the winding so positive `pressure` always
// inflates a closed loop rather than depending on how it was drawn.
function signedArea(pos: Float32Array, count: number): number {
  let a = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    a += pos[i * 2] * pos[j * 2 + 1] - pos[j * 2] * pos[i * 2 + 1];
  }
  return a * 0.5;
}

function relax(
  st: DGState,
  p: SimParams,
  f: Fields,
  W: number,
  H: number
): void {
  const curves = st.curves;
  let total = 0;
  for (const c of curves) total += c.count;
  if (total === 0) return;

  if (!st.flat || st.flat.length < total * 2) {
    st.flat = new Float32Array(total * 2);
    st.delta = new Float32Array(total * 2);
    st.owner = new Int32Array(total);
  }
  const flat = st.flat;
  const delta = st.delta!;
  const owner = st.owner!;

  for (let pass = 0; pass < p.iterations; pass++) {
    // ---- gather ----
    let w = 0;
    for (let ci = 0; ci < curves.length; ci++) {
      const c = curves[ci];
      for (let i = 0; i < c.count; i++) {
        flat[w * 2] = c.pos[i * 2];
        flat[w * 2 + 1] = c.pos[i * 2 + 1];
        owner[w] = ci;
        w++;
      }
    }
    delta.fill(0, 0, total * 2);

    // ---- repulsion (Jacobi: accumulate all pairs, apply once) ----
    // Order-independent by construction, which is what keeps the result
    // stable frame to frame — relax.ts's precedent.
    st.hash = buildSpatialHash(flat, total, p.repulsionPx, W, H, st.hash);
    const hash = st.hash;
    const { gw, gh, counts, entries, cell } = hash;
    const rr = p.repulsionPx;
    const rr2 = rr * rr;
    for (let i = 0; i < total; i++) {
      const xi = flat[i * 2];
      const yi = flat[i * 2 + 1];
      const cx = Math.max(0, Math.min(gw - 1, Math.floor(xi / cell)));
      const cy = Math.max(0, Math.min(gh - 1, Math.floor(yi / cell)));
      for (let oy = -1; oy <= 1; oy++) {
        const gy = cy + oy;
        if (gy < 0 || gy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          if (gx < 0 || gx >= gw) continue;
          const cc = gy * gw + gx;
          const end = counts[cc];
          for (let e = cellStart(hash, cc); e < end; e++) {
            const j = entries[e];
            if (j === i) continue;
            if (!p.interCurve && owner[j] !== owner[i]) continue;
            let dx = xi - flat[j * 2];
            let dy = yi - flat[j * 2 + 1];
            const d2 = dx * dx + dy * dy;
            if (d2 >= rr2) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-6) {
              // Coincident nodes separate along a deterministic hashed
              // direction so the sim stays reproducible.
              const a = hash01(i, j, p.seed) * Math.PI * 2;
              dx = Math.cos(a);
              dy = Math.sin(a);
              d = 1;
            } else {
              dx /= d;
              dy /= d;
            }
            const push = ((rr - d) / rr) * p.repulsion;
            delta[i * 2] += dx * push * rr * 0.5;
            delta[i * 2 + 1] += dy * push * rr * 0.5;
          }
        }
      }
    }

    // ---- attraction + bending ----
    const rest = p.repulsionPx;
    let base = 0;
    for (const c of curves) {
      const n = c.count;
      for (let i = 0; i < n; i++) {
        const hasPrev = c.closed || i > 0;
        const hasNext = c.closed || i < n - 1;
        const pi = (i - 1 + n) % n;
        const ni = (i + 1) % n;
        const gi = base + i;
        const xi = flat[gi * 2];
        const yi = flat[gi * 2 + 1];
        let ax = 0;
        let ay = 0;
        let neighbours = 0;
        if (hasPrev) {
          ax += c.pos[pi * 2];
          ay += c.pos[pi * 2 + 1];
          neighbours++;
        }
        if (hasNext) {
          ax += c.pos[ni * 2];
          ay += c.pos[ni * 2 + 1];
          neighbours++;
        }
        if (neighbours === 0) continue;
        ax /= neighbours;
        ay /= neighbours;

        // Bending: Laplacian smoothing toward the neighbour midpoint. This
        // affects SHAPE only — for an evenly spaced node the midpoint is
        // where it already is, so it never changes edge lengths.
        delta[gi * 2] += (ax - xi) * p.bend;
        delta[gi * 2 + 1] += (ay - yi) * p.bend;

        // Attraction: a one-sided spring toward each neighbour, active
        // only past the rest length. Aiming it at the midpoint instead
        // (the obvious first cut) makes it identical to bending, so the
        // two sliders would do the same thing and neither would control
        // chain tautness. Pull only — repulsion owns the pushing.
        if (p.attraction > 0) {
          for (let k = 0; k < 2; k++) {
            if (k === 0 ? !hasPrev : !hasNext) continue;
            const q = k === 0 ? pi : ni;
            const dx = c.pos[q * 2] - xi;
            const dy = c.pos[q * 2 + 1] - yi;
            const d = Math.hypot(dx, dy);
            if (d <= rest || d < 1e-6) continue;
            const s = ((d - rest) / d) * p.attraction;
            delta[gi * 2] += dx * s;
            delta[gi * 2 + 1] += dy * s;
          }
        }
      }
      base += n;
    }

    // ---- pressure (closed curves only) ----
    if (p.pressure !== 0) {
      base = 0;
      for (const c of curves) {
        const n = c.count;
        if (!c.closed || n < 3) {
          base += n;
          continue;
        }
        const wind = signedArea(c.pos, n) >= 0 ? 1 : -1;
        for (let i = 0; i < n; i++) {
          const pi = (i - 1 + n) % n;
          const ni = (i + 1) % n;
          const tx = c.pos[ni * 2] - c.pos[pi * 2];
          const ty = c.pos[ni * 2 + 1] - c.pos[pi * 2 + 1];
          const tl = Math.hypot(tx, ty);
          if (tl < 1e-6) continue;
          // Outward normal, oriented by winding so positive pressure
          // always inflates.
          const nx = (ty / tl) * wind;
          const ny = (-tx / tl) * wind;
          const gi = base + i;
          delta[gi * 2] += nx * p.pressure * p.repulsionPx * 0.5;
          delta[gi * 2 + 1] += ny * p.pressure * p.repulsionPx * 0.5;
        }
        base += n;
      }
    }

    // ---- integrate + confine ----
    base = 0;
    for (const c of curves) {
      const n = c.count;
      for (let i = 0; i < n; i++) {
        if (p.pinEnds && !c.closed && (i === 0 || i === n - 1)) continue;
        const gi = base + i;
        const ox = c.pos[i * 2];
        const oyy = c.pos[i * 2 + 1];
        let nx = ox + delta[gi * 2] * p.damping;
        let ny = oyy + delta[gi * 2 + 1] * p.damping;
        if (p.containment > 0 && (f.region || f.obstacles)) {
          const u = nx / W;
          const v = ny / H;
          let blocked = false;
          if (f.region && sampleMap(f.region, u, v) < 0.5) blocked = true;
          if (!blocked && f.obstacles && sampleMap(f.obstacles, u, v) >= 0.5) {
            blocked = true;
          }
          if (blocked) {
            // Refuse the move rather than push along a gradient: a binary
            // mask has no usable gradient more than a texel from its
            // boundary, so a gradient push would do nothing for a node
            // that has already strayed well outside.
            nx = ox + (nx - ox) * (1 - p.containment);
            ny = oyy + (ny - oyy) * (1 - p.containment);
          }
        }
        c.pos[i * 2] = nx;
        c.pos[i * 2 + 1] = ny;
      }
      base += n;
    }
  }
}

// Split-eligibility for the edge starting at node `i`, in [0,1].
function edgeWeight(
  c: Curve,
  i: number,
  p: SimParams,
  f: Fields,
  W: number,
  H: number
): number {
  const n = c.count;
  const j = (i + 1) % n;
  switch (p.mode) {
    case "curvature": {
      // Convex regions grow faster, so a bulge sharpens, which makes it
      // grow faster still — the feedback that produces cauliflower.
      const pi = (i - 1 + n) % n;
      const ax = c.pos[i * 2] - c.pos[pi * 2];
      const ay = c.pos[i * 2 + 1] - c.pos[pi * 2 + 1];
      const bx = c.pos[j * 2] - c.pos[i * 2];
      const by = c.pos[j * 2 + 1] - c.pos[i * 2 + 1];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6) return 0;
      const dot = (ax * bx + ay * by) / (la * lb);
      return clamp((1 - dot) * 0.5 * 2, 0, 1);
    }
    case "field": {
      if (!f.growth) return 1;
      const mx = (c.pos[i * 2] + c.pos[j * 2]) * 0.5;
      const my = (c.pos[i * 2 + 1] + c.pos[j * 2 + 1]) * 0.5;
      return clamp(sampleMap(f.growth, mx / W, my / H), 0, 1);
    }
    case "noise": {
      const mx = (c.pos[i * 2] + c.pos[j * 2]) * 0.5;
      const my = (c.pos[i * 2 + 1] + c.pos[j * 2 + 1]) * 0.5;
      const q = Math.max(1, p.repulsionPx);
      return hash01(Math.floor(mx / q), Math.floor(my / q), p.seed);
    }
    default:
      return 1;
  }
}

// Insert past `split_length`, merge under `collapse_length`. One rebuild
// pass does both — collapse is not cosmetic: without it, repulsion in a
// tight concavity drives the anchor count up without bound and the sim
// degrades into mush.
function retopologize(
  st: DGState,
  p: SimParams,
  f: Fields,
  W: number,
  H: number,
  rng: () => number
): void {
  let totalAnchors = 0;
  for (const c of st.curves) totalAnchors += c.count;

  for (const c of st.curves) {
    const n = c.count;
    if (n < 2) continue;
    const segs = c.closed ? n : n - 1;
    const out: number[] = [];
    let lastX = c.pos[0];
    let lastY = c.pos[1];
    out.push(lastX, lastY);

    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const jx = c.pos[j * 2];
      const jy = c.pos[j * 2 + 1];
      const ex = jx - c.pos[i * 2];
      const ey = jy - c.pos[i * 2 + 1];
      const len = Math.hypot(ex, ey);

      // Growth is RATE-driven, with the length threshold as a hard cap.
      //
      // Splitting only once an edge exceeds `split_length` sounds right
      // and cannot start: seed a circle at that spacing and it sits in
      // perfect equilibrium — each node's two chain neighbours repel it
      // equally and cancel, so no edge ever stretches, so nothing ever
      // splits. Insertion has to be the thing that DRIVES growth; the
      // crowding it creates is what repulsion then relieves by buckling.
      // The threshold stays on as a mandatory split so spacing can never
      // run away.
      const eligible = len > p.collapsePx * 2;
      const mustSplit = len > p.splitPx;
      if (
        totalAnchors < p.maxAnchors &&
        (mustSplit ||
          (eligible &&
            rng() < p.growthRate * SPLIT_RATE * edgeWeight(c, i, p, f, W, H)))
      ) {
        lastX = c.pos[i * 2] + ex * 0.5;
        lastY = c.pos[i * 2 + 1] + ey * 0.5;
        out.push(lastX, lastY);
        totalAnchors++;
      }

      // The closing edge of a loop must not re-append node 0.
      if (c.closed && i === segs - 1) break;
      const dx = jx - lastX;
      const dy = jy - lastY;
      if (Math.hypot(dx, dy) >= p.collapsePx) {
        out.push(jx, jy);
        lastX = jx;
        lastY = jy;
      } else {
        totalAnchors--;
      }
    }

    const newCount = out.length >> 1;
    const minCount = c.closed ? 3 : 2;
    if (newCount < minCount) continue;
    if (newCount * 2 > c.pos.length) {
      const grown = new Float32Array(Math.max(newCount * 2 * 2, 32));
      grown.set(out);
      c.pos = grown;
    } else {
      for (let k = 0; k < out.length; k++) c.pos[k] = out[k];
    }
    c.count = newCount;
  }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function emit(
  st: DGState,
  W: number,
  H: number
): { spline: SplineValue; points: PointsValue } {
  const subpaths: SplineSubpath[] = [];
  let total = 0;
  for (const c of st.curves) total += c.count;
  if (total === 0) {
    return { spline: { kind: "spline", subpaths: [] }, points: EMPTY_POINTS };
  }
  const points = makePoints(total, {
    withScales: true,
    withRotations: true,
    withGroupIndices: true,
  });

  let w = 0;
  for (const c of st.curves) {
    const n = c.count;
    if (n < 2) continue;
    const anchors: SplineAnchor[] = new Array(n);
    for (let i = 0; i < n; i++) {
      anchors[i] = { pos: [c.pos[i * 2] / W, c.pos[i * 2 + 1] / H] };
    }
    // How far this curve has outgrown its seed. Mapped asymptotically into
    // [0,1) so the driver channel stays in range no matter how far it runs.
    const len = polylineLength(c.pos, n, c.closed);
    const ratio = c.initialLength > 1e-6 ? len / c.initialLength : 1;
    subpaths.push({
      anchors,
      closed: c.closed,
      groupIndex: c.groupIndex,
      driver: clamp(1 - 1 / Math.max(1, ratio), 0, 1),
    });

    for (let i = 0; i < n; i++) {
      const pi = (i - 1 + n) % n;
      const ni = (i + 1) % n;
      const tx = c.pos[ni * 2] - c.pos[pi * 2];
      const ty = c.pos[ni * 2 + 1] - c.pos[pi * 2 + 1];
      points.positions[w * 2] = c.pos[i * 2] / W;
      points.positions[w * 2 + 1] = c.pos[i * 2 + 1] / H;
      points.rotations![w] = Math.atan2(ty, tx);
      // Local edge density: short edges mean the curve is crowded here,
      // which is a legible proxy for growth pressure.
      const sp = Math.hypot(tx, ty) * 0.5;
      points.scales![w * 2] = sp;
      points.scales![w * 2 + 1] = sp;
      points.groupIndices![w] = c.groupIndex ?? 0;
      w++;
    }
  }
  points.count = w;
  return { spline: { kind: "spline", subpaths }, points };
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

function readField(
  ctx: RenderContext,
  st: DGState,
  name: string,
  val: unknown
): { data: Float32Array; w: number; h: number } | null {
  const buf = readMapBuffer(
    ctx,
    st.maps,
    name,
    val as Parameters<typeof readMapBuffer>[3]
  );
  return buf ? { data: buf.data, w: buf.w, h: buf.h } : null;
}

export const differentialGrowthNode: NodeDefinition = {
  type: "differential-growth",
  name: "Differential Growth",
  category: "spline",
  subcategory: "modifier",
  description:
    "Grow a curve faster than the space around it can hold, so it has no choice but to buckle — brain coral, kelp, ruffled leaf margins, intestines. Every node pushes its neighbours apart while the chain pulls itself together, and any edge stretched past Split length inserts a new node, so the curve keeps lengthening in place. Closed input loops become inflating blobs (raise Pressure), open ones become tendrils. The mode sets WHERE new length appears: Uniform ruffles evenly, Curvature grows convex regions faster so bulges sharpen and sub-divide into cauliflower lobes, Field takes a wired mask so you can paint exactly where it crinkles, and Noise breaks it up patchily. Region confines the curve and Obstacles carve holes it must ruffle around. This is a live simulation, not a cached one — it evolves while the timeline plays and resets when the scene loops, so there is no Progress slider. Bend stiffness trades a smooth ruffle for a jagged one; Collapse length keeps the anchor count from running away.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  stable: false,
  simulation: true,
  inputs: [
    { name: "spline", label: "Spline", type: "spline", required: true },
    { name: "region", label: "Region", type: "mask", required: false },
    { name: "obstacles", label: "Obstacles", type: "mask", required: false },
    {
      name: "growth_field",
      label: "Growth field",
      type: "mask",
      required: false,
    },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["uniform", "curvature", "field", "noise"],
      default: "uniform",
    },
    {
      name: "split_length",
      label: "Split length",
      type: "scalar",
      min: 0.002,
      max: 0.1,
      step: 0.0005,
      default: 0.012,
    },
    {
      name: "collapse_length",
      label: "Collapse length",
      type: "scalar",
      min: 0,
      max: 0.05,
      step: 0.0005,
      default: 0.003,
    },
    {
      name: "growth_rate",
      label: "Growth rate",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "repulsion_radius",
      label: "Repulsion radius",
      type: "scalar",
      min: 0.002,
      max: 0.2,
      step: 0.0005,
      default: 0.009,
    },
    {
      name: "repulsion_strength",
      label: "Repulsion",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "attraction_strength",
      label: "Attraction",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.6,
    },
    {
      name: "bend_stiffness",
      label: "Bend stiffness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
    },
    {
      name: "pressure",
      label: "Pressure",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "damping",
      label: "Damping",
      type: "scalar",
      min: 0.01,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: MAX_ITER_PASSES,
      step: 1,
      default: 3,
    },
    {
      name: "inter_curve",
      label: "Curves collide",
      type: "boolean",
      default: true,
    },
    {
      name: "pin_ends",
      label: "Pin ends",
      type: "boolean",
      default: false,
    },
    {
      name: "containment",
      label: "Containment",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "max_anchors",
      label: "Max anchors",
      type: "scalar",
      min: 32,
      max: 100000,
      softMax: 20000,
      step: 1,
      default: 8000,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ inputs, params, ctx, nodeId }) {
    const st = getState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;
    const src = inputs.spline;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      st.curves = [];
      st.initialized = false;
      return {
        primary: { kind: "spline", subpaths: [] } satisfies SplineValue,
        aux: { points: EMPTY_POINTS },
      };
    }

    const splitPx = clamp(num(params.split_length, 0.012), 0.002, 0.1) * W;
    // Kept under the split length so equilibrium spacing can never sit
    // above the mandatory-split threshold (see the note on collapsePx).
    const repulsionPx = clamp(
      clamp(num(params.repulsion_radius, 0.009), 0.002, 0.2) * W,
      splitPx * 0.35,
      splitPx * 0.9
    );
    const p: SimParams = {
      mode: typeof params.mode === "string" ? params.mode : "uniform",
      splitPx,
      // The three lengths are not independent, and getting their ORDER
      // wrong is what makes this simulation misbehave — silently, in both
      // directions. Repulsion sets the equilibrium edge spacing, which
      // settles at roughly 0.6-0.8x the radius, so:
      //
      //   2 x collapse  <  equilibrium (~0.7 x repulsion)  <  split
      //
      // Above `split`, every edge permanently exceeds the mandatory-split
      // threshold and the curve subdivides without bound every frame until
      // it hits the anchor cap. Below `2 x collapse`, no edge is ever long
      // enough for its halves to survive a merge, so nothing splits and the
      // curve never grows at all.
      //
      // Collapse is therefore clamped against REPULSION, not against
      // split: anchoring it to split let a fine-split setup land its
      // eligibility threshold at 6.7px against an equilibrium of 6.65px,
      // which stopped growth dead while every slider still looked sane.
      collapsePx: Math.min(
        clamp(num(params.collapse_length, 0.003), 0, 0.05) * W,
        repulsionPx * 0.25
      ),
      growthRate: clamp(num(params.growth_rate, 1), 0, 1),
      repulsionPx,
      repulsion: clamp(num(params.repulsion_strength, 1), 0, 2),
      attraction: clamp(num(params.attraction_strength, 0.6), 0, 2),
      bend: clamp(num(params.bend_stiffness, 0.3), 0, 1),
      pressure: clamp(num(params.pressure, 0), -1, 1),
      damping: clamp(num(params.damping, 0.5), 0.01, 1),
      iterations: clamp(
        Math.round(num(params.iterations, 3)),
        1,
        MAX_ITER_PASSES
      ),
      interCurve: params.inter_curve !== false,
      pinEnds: params.pin_ends === true,
      containment: clamp(num(params.containment, 1), 0, 1),
      maxAnchors: clamp(Math.round(num(params.max_anchors, 8000)), 32, 100000),
      seed: Math.max(0, Math.round(num(params.seed, 0))),
    };

    // Topology of the SEED, not its geometry: an animated upstream mints a
    // fresh SplineValue every frame and must not reset a running sim.
    const inputSig = src.subpaths
      .map((s) => `${s.anchors.length}:${s.closed ? 1 : 0}:${s.groupIndex ?? -1}`)
      .join("|");

    const time = ctx.time;
    // Scene-time wrap (Sim Start's rule) restarts the growth with the loop.
    const wrapped = st.lastTime > 0.05 && time < 0.05;
    if (!st.initialized || st.inputSig !== inputSig || wrapped) {
      st.curves = seedCurves(src, W, H, splitPx, p.maxAnchors);
      st.inputSig = inputSig;
      st.initialized = true;
      st.frame = 0;
    }

    const fields: Fields = {
      region: readField(ctx, st, "region", inputs.region),
      obstacles: readField(ctx, st, "obstacles", inputs.obstacles),
      growth: readField(ctx, st, "growth_field", inputs.growth_field),
    };

    // Advance only when the clock moved. A paused param tweak re-emits the
    // current state instead of secretly stepping the sim — Advect Points'
    // deliberate improvement over the Sim Zone.
    if (time !== st.lastTime) {
      st.frame++;
      let a = (p.seed ^ Math.imul(st.frame, 0x9e3779b9)) >>> 0;
      const rng = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      relax(st, p, fields, W, H);
      retopologize(st, p, fields, W, H, rng);
      st.lastTime = time;
    }

    const { spline, points } = emit(st, W, H);
    return { primary: spline, aux: { points } };
  },

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time}`;
  },

  dispose(ctx, nodeId) {
    delete ctx.state[stateKey(nodeId)];
  },
};
