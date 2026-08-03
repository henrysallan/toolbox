import type { ParamDef } from "./types";
import { snoise } from "./noise";

// Segment shaping — the shared "curved path modes" machinery behind
// Connect Points and Shortest Path (points + tree modes). Both nodes
// emit polyline connections between indexed points; a `path` mode enum
// decides each segment's SHAPE by choosing cubic handle offsets:
//
//   straight — no handles (the classic chord)
//   curved   — circular arcs ↔ S-curves (curvature / s_curve / flip)
//   sag      — hanging-wire droop along a gravity angle
//   flow     — snoise-field tangents at each endpoint
//   network  — ONE shared tangent per point: connections read as
//              continuous curves flowing THROUGH the points (on a
//              chain this degenerates to through-point smoothing;
//              at junctions branches stay tangent-consistent)
//   bundle   — one-shot edge bundling: parallel nearby segments bow
//              toward their common trunk
//   attract  — bow toward/away from the point centroid or a custom
//              center
//
// Everything is pure emit-time math over an EDGE LIST (index pairs
// into a caller-supplied position table): callers hand in authored-
// space positions, get authored-space handle offsets back, and stay
// in charge of assembling subpaths (independent 2-anchor segments in
// Connect Points; multi-anchor chains in Shortest Path, where an
// interior anchor takes the in-handle of one edge and the out-handle
// of the next). Handle math runs in ISO space internally (x·aspect)
// so arcs render round and angle params read visually true on
// non-square canvases.
//
// Determinism: no Math.random. Per-segment randomness (jitter, random
// flip) keys on the unordered point-index pair — NOT the edge's array
// position — so values stay stable frame-to-frame while connectivity
// changes (no shimmer). Edges may override the key pair (`ki`/`kj`)
// when an endpoint's table index is synthetic (e.g. a gliding tree
// stub). `alternate` flip is by emission index, inherently
// order-dependent — documented.
//
// Spec: specdocs/073126_connect-points-curved-paths.md.

type V2 = [number, number];

export type SegmentShapeMode =
  | "straight"
  | "curved"
  | "sag"
  | "flow"
  | "network"
  | "bundle"
  | "attract";

export interface SegmentShapeEdge {
  i: number;
  j: number;
  // Stable identity pair for seeded randomness; defaults to (i, j).
  ki?: number;
  kj?: number;
}

export interface SegmentHandles {
  out: V2 | null; // outHandle offset for the edge's `i` end (authored space)
  in: V2 | null; // inHandle offset for the edge's `j` end (authored space)
}

export interface SegmentShapeParams {
  mode: SegmentShapeMode;
  curvature: number;
  sCurve: number;
  flip: "none" | "alternate" | "random";
  slack: number;
  gravityAngle: number;
  fieldAngle: number;
  flowNoise: number;
  noiseScale: number;
  handleLength: number;
  tension: number;
  bundling: number;
  bundleRadius: number;
  compatibility: number;
  attractStrength: number;
  attractCenter: "centroid" | "custom";
  centerX: number;
  centerY: number;
  jitter: number;
  seed: number;
}

// triple32-style avalanche hash → [0, 1). Deterministic stream keyed
// on (seed, n) — same primitive family as Shortest Path / Point
// Expression's rand().
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

function pairRand(seed: number, i: number, j: number, stream: number): number {
  return rand01(
    (seed ^ Math.imul(i + 1, 0x27d4eb2f) ^ Math.imul(stream + 1, 0x165667b1)) | 0,
    j
  );
}

// The `path` mode enum ParamDef. Kept separate from the mode params so
// callers control placement (Connect Points puts it first as a header
// control; Shortest Path slots it after its own mode params).
export function segmentShapePathParam(
  gate?: (p: Record<string, unknown>) => boolean
): ParamDef {
  const def: ParamDef = {
    name: "path",
    label: "Path",
    type: "enum",
    options: ["straight", "curved", "sag", "flow", "network", "bundle", "attract"],
    default: "straight",
  };
  if (gate) def.visibleIf = gate;
  return def;
}

// The per-mode ParamDefs, each visibleIf-gated on `path` (composed
// with the caller's own gate, e.g. Shortest Path's mode !== "spline").
// Names are shared across consuming nodes; `path_jitter`/`path_seed`
// are prefixed because host nodes commonly own plain `jitter`/`seed`.
export function segmentShapeModeParams(
  gate?: (p: Record<string, unknown>) => boolean
): ParamDef[] {
  const on = (
    pred: (p: Record<string, unknown>) => boolean
  ): ((p: Record<string, unknown>) => boolean) =>
    gate ? (p) => gate(p) && pred(p) : pred;
  const is = (mode: string) => on((p) => p.path === mode);
  return [
    {
      name: "curvature",
      label: "Curvature",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: is("curved"),
    },
    {
      name: "s_curve",
      label: "S curve",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
      visibleIf: is("curved"),
    },
    {
      name: "flip",
      label: "Flip",
      type: "enum",
      options: ["none", "alternate", "random"],
      default: "none",
      visibleIf: is("curved"),
    },
    {
      name: "slack",
      label: "Slack",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.3,
      visibleIf: is("sag"),
    },
    {
      name: "gravity_angle",
      label: "Gravity angle",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 90,
      visibleIf: is("sag"),
    },
    {
      name: "field_angle",
      label: "Field angle",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: is("flow"),
    },
    {
      name: "flow_noise",
      label: "Noise",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: is("flow"),
    },
    {
      name: "noise_scale",
      label: "Noise scale",
      type: "scalar",
      min: 0.1,
      max: 20,
      step: 0.01,
      default: 4,
      visibleIf: is("flow"),
    },
    {
      name: "handle_length",
      label: "Handle length",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.4,
      visibleIf: is("flow"),
    },
    {
      name: "tension",
      label: "Tension",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      visibleIf: is("network"),
    },
    {
      name: "bundling",
      label: "Bundling",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: is("bundle"),
    },
    {
      name: "bundle_radius",
      label: "Radius",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.15,
      visibleIf: is("bundle"),
    },
    {
      name: "compatibility",
      label: "Compatibility",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: is("bundle"),
    },
    {
      name: "attract_strength",
      label: "Strength",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: is("attract"),
    },
    {
      name: "attract_center",
      label: "Center",
      type: "enum",
      options: ["centroid", "custom"],
      default: "centroid",
      visibleIf: is("attract"),
    },
    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: on((p) => p.path === "attract" && p.attract_center === "custom"),
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: on((p) => p.path === "attract" && p.attract_center === "custom"),
    },
    {
      name: "path_jitter",
      label: "Jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
      visibleIf: on(
        (p) => p.path === "curved" || p.path === "sag" || p.path === "attract"
      ),
    },
    {
      name: "path_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: on(
        (p) =>
          p.path === "curved" ||
          p.path === "sag" ||
          p.path === "flow" ||
          p.path === "attract"
      ),
    },
  ];
}

export function readSegmentShapeParams(
  params: Record<string, unknown>
): SegmentShapeParams {
  return {
    mode: ((params.path as string) ?? "straight") as SegmentShapeMode,
    curvature: (params.curvature as number) ?? 0.5,
    sCurve: (params.s_curve as number) ?? 0,
    flip: ((params.flip as string) ?? "none") as SegmentShapeParams["flip"],
    slack: (params.slack as number) ?? 0.3,
    gravityAngle: (params.gravity_angle as number) ?? 90,
    fieldAngle: (params.field_angle as number) ?? 0,
    flowNoise: (params.flow_noise as number) ?? 0.5,
    noiseScale: (params.noise_scale as number) ?? 4,
    handleLength: (params.handle_length as number) ?? 0.4,
    tension: (params.tension as number) ?? 1,
    bundling: (params.bundling as number) ?? 0.5,
    bundleRadius: (params.bundle_radius as number) ?? 0.15,
    compatibility: (params.compatibility as number) ?? 0.5,
    attractStrength: (params.attract_strength as number) ?? 0.5,
    attractCenter: ((params.attract_center as string) ??
      "centroid") as SegmentShapeParams["attractCenter"],
    centerX: (params.center_x as number) ?? 0.5,
    centerY: (params.center_y as number) ?? 0.5,
    jitter: (params.path_jitter as number) ?? 0,
    seed: Math.floor((params.path_seed as number) ?? 0),
  };
}

export interface SegmentShapeArgs {
  edges: SegmentShapeEdge[];
  // Authored-space positions, indexed by edge.i/j. May contain more
  // entries than real points (synthetic indices for transient ends).
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  aspect: number; // canvas width / height
  p: SegmentShapeParams;
  // attract centroid averages x[0..centroidCount) — pass the REAL
  // point count when the table carries synthetic entries.
  centroidCount?: number;
}

// One handle pair per edge, in edge order. `straight` (and every
// degenerate case) yields {out: null, in: null}.
export function computeSegmentShapeHandles(
  args: SegmentShapeArgs
): SegmentHandles[] {
  const { edges, aspect, p } = args;
  const E = edges.length;
  const none: SegmentHandles = { out: null, in: null };
  const out: SegmentHandles[] = new Array(E);
  if (p.mode === "straight" || E === 0) {
    out.fill(none);
    return out;
  }

  // Iso-space position table: isotropic in px, so arcs render round
  // and angle params read visually true.
  const M = args.x.length;
  const px = new Float64Array(M);
  const py = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    px[i] = args.x[i] * aspect;
    py[i] = args.y[i];
  }

  const key = (e: SegmentShapeEdge): [number, number] => [e.ki ?? e.i, e.kj ?? e.j];
  const jitterMul = (e: SegmentShapeEdge) => {
    if (p.jitter <= 0) return 1;
    const [ki, kj] = key(e);
    return 1 + p.jitter * (pairRand(p.seed, ki, kj, 1) * 2 - 1);
  };
  // Handle offsets convert back to authored space on the way out.
  const mk = (ox: number, oy: number, ix: number, iy: number, k: number) => {
    out[k] = {
      out: [ox / aspect, oy],
      in: [ix / aspect, iy],
    };
  };
  // Quadratic-through-Q → cubic: bow the segment so its curve midpoint
  // lands at Q's half-way pull. Q = M means exact straight.
  const bow = (
    k: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    qx: number,
    qy: number
  ) => {
    mk(
      ((qx - ax) * 2) / 3,
      ((qy - ay) * 2) / 3,
      ((qx - bx) * 2) / 3,
      ((qy - by) * 2) / 3,
      k
    );
  };

  if (p.mode === "curved") {
    const theta0 = p.curvature * Math.PI;
    const MAX_TH = Math.PI * 1.75;
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const ax = px[e.i], ay = py[e.i];
      const cx = px[e.j] - ax, cy = py[e.j] - ay;
      const L = Math.hypot(cx, cy);
      let th = theta0;
      if (p.flip === "alternate") {
        if (k & 1) th = -th;
      } else if (p.flip === "random") {
        const [ki, kj] = key(e);
        if (pairRand(p.seed, ki, kj, 0) < 0.5) th = -th;
      }
      th *= jitterMul(e);
      if (th > MAX_TH) th = MAX_TH;
      else if (th < -MAX_TH) th = -MAX_TH;
      if (L < 1e-9 || Math.abs(th) < 1e-4) {
        out[k] = none;
        continue;
      }
      // Exact circle cubic: R from the chord/angle relation, handle
      // distance d = 4/3·tan(θ/4)·R (→ L/3 as θ → 0). Tangents make
      // θ/2 with the chord at each end; s_curve morphs the B end from
      // mirrored (arc) to parallel (S).
      const half = th / 2;
      const R = L / (2 * Math.sin(Math.abs(half)));
      const d = (4 / 3) * Math.tan(Math.abs(th) / 4) * R;
      const ux = cx / L, uy = cy / L;
      const aAng = -half;
      const bAng = half * (1 - 2 * p.sCurve);
      const ca = Math.cos(aAng), sa = Math.sin(aAng);
      const cb = Math.cos(bAng), sb = Math.sin(bAng);
      mk(
        (ux * ca - uy * sa) * d,
        (ux * sa + uy * ca) * d,
        -(ux * cb - uy * sb) * d,
        -(ux * sb + uy * cb) * d,
        k
      );
    }
  } else if (p.mode === "sag") {
    const ga = (p.gravityAngle * Math.PI) / 180;
    const gx = Math.cos(ga), gy = Math.sin(ga);
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const ax = px[e.i], ay = py[e.i];
      const bx = px[e.j], by = py[e.j];
      const L = Math.hypot(bx - ax, by - ay);
      const dev = p.slack * jitterMul(e) * L * 0.5;
      bow(
        k,
        ax, ay, bx, by,
        (ax + bx) / 2 + gx * 2 * dev,
        (ay + by) / 2 + gy * 2 * dev
      );
    }
  } else if (p.mode === "flow") {
    const fa = (p.fieldAngle * Math.PI) / 180;
    // Seed shifts the noise domain — cheap decorrelated reroll.
    const ox = rand01(p.seed, 101) * 100;
    const oy = rand01(p.seed, 202) * 100;
    const angleAt = (x: number, y: number) =>
      fa +
      (p.flowNoise > 0
        ? snoise(x * p.noiseScale + ox, y * p.noiseScale + oy) *
          p.flowNoise *
          Math.PI
        : 0);
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const ax = px[e.i], ay = py[e.i];
      const cx = px[e.j] - ax, cy = py[e.j] - ay;
      const L = Math.hypot(cx, cy);
      if (L < 1e-9 || p.handleLength <= 0) {
        out[k] = none;
        continue;
      }
      const h = p.handleLength * L;
      const phiA = angleAt(ax, ay);
      const phiB = angleAt(ax + cx, ay + cy);
      // Sign-correct each endpoint's field direction along the chord
      // so segments never run backward.
      let dax = Math.cos(phiA), day = Math.sin(phiA);
      if (dax * cx + day * cy < 0) {
        dax = -dax;
        day = -day;
      }
      let dbx = Math.cos(phiB), dby = Math.sin(phiB);
      if (dbx * cx + dby * cy < 0) {
        dbx = -dbx;
        dby = -dby;
      }
      mk(dax * h, day * h, -dbx * h, -dby * h, k);
    }
  } else if (p.mode === "network") {
    // ONE tangent per position-table index, shared by all its edges,
    // so connections read as continuous curves flowing THROUGH the
    // points. Incident edge directions are sign-corrected against the
    // point's first edge (opposite arms reinforce instead of
    // cancelling), then averaged. Degree-1 points get their own chord
    // — straight, natural line-ends.
    const refX = new Float64Array(M), refY = new Float64Array(M);
    const sumX = new Float64Array(M), sumY = new Float64Array(M);
    const deg = new Uint32Array(M);
    const addDir = (pt: number, dx: number, dy: number) => {
      if (deg[pt] === 0) {
        refX[pt] = dx;
        refY[pt] = dy;
      }
      const s = dx * refX[pt] + dy * refY[pt] < 0 ? -1 : 1;
      sumX[pt] += dx * s;
      sumY[pt] += dy * s;
      deg[pt]++;
    };
    for (const e of edges) {
      const cx = px[e.j] - px[e.i], cy = py[e.j] - py[e.i];
      const L = Math.hypot(cx, cy);
      if (L < 1e-9) continue;
      addDir(e.i, cx / L, cy / L);
      addDir(e.j, -cx / L, -cy / L);
    }
    for (let i = 0; i < M; i++) {
      const len = Math.hypot(sumX[i], sumY[i]);
      if (len > 1e-9) {
        sumX[i] /= len;
        sumY[i] /= len;
      } else {
        sumX[i] = refX[i];
        sumY[i] = refY[i];
      }
    }
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const cx = px[e.j] - px[e.i], cy = py[e.j] - py[e.i];
      const L = Math.hypot(cx, cy);
      if (L < 1e-9 || p.tension <= 0) {
        out[k] = none;
        continue;
      }
      const h = (p.tension * L) / 3;
      const sA = sumX[e.i] * cx + sumY[e.i] * cy < 0 ? -1 : 1;
      const sB = sumX[e.j] * cx + sumY[e.j] * cy < 0 ? -1 : 1;
      mk(
        sumX[e.i] * sA * h,
        sumY[e.i] * sA * h,
        -sumX[e.j] * sB * h,
        -sumY[e.j] * sB * h,
        k
      );
    }
  } else if (p.mode === "bundle") {
    // One-shot simplified edge bundling: bow each segment toward the
    // alignment-weighted average midpoint of its neighborhood.
    // Parallel nearby segments merge into trunks; lone or
    // perpendicular ones stay put (self weight = 1 anchors the
    // average). Duplicate edges (overlapping tree trunks) only weight
    // their own trunk — harmless.
    const radius = Math.max(1e-6, p.bundleRadius);
    const kPow = 1 + p.compatibility * 7;
    const mx = new Float64Array(E), my = new Float64Array(E);
    const ex = new Float64Array(E), ey = new Float64Array(E);
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const ax = px[e.i], ay = py[e.i];
      const bx = px[e.j], by = py[e.j];
      mx[k] = (ax + bx) / 2;
      my[k] = (ay + by) / 2;
      const L = Math.hypot(bx - ax, by - ay);
      if (L > 1e-9) {
        ex[k] = (bx - ax) / L;
        ey[k] = (by - ay) / L;
      }
    }
    const grid = new Map<string, number[]>();
    for (let k = 0; k < E; k++) {
      const gk = `${Math.floor(mx[k] / radius)}|${Math.floor(my[k] / radius)}`;
      let arr = grid.get(gk);
      if (!arr) {
        arr = [];
        grid.set(gk, arr);
      }
      arr.push(k);
    }
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const ax = px[e.i], ay = py[e.i];
      const bx = px[e.j], by = py[e.j];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-9 || p.bundling <= 0) {
        out[k] = none;
        continue;
      }
      const gx = Math.floor(mx[k] / radius);
      const gy = Math.floor(my[k] / radius);
      let wSum = 0, tx = 0, ty = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(`${gx + dx}|${gy + dy}`);
          if (!arr) continue;
          for (const f of arr) {
            const ddx = mx[f] - mx[k], ddy = my[f] - my[k];
            const dist = Math.hypot(ddx, ddy);
            if (dist > radius) continue;
            const align = Math.abs(ex[k] * ex[f] + ey[k] * ey[f]);
            const w = (1 - dist / radius) * Math.pow(align, kPow);
            wSum += w;
            tx += w * mx[f];
            ty += w * my[f];
          }
        }
      }
      if (wSum < 1e-9) {
        out[k] = none;
        continue;
      }
      bow(
        k,
        ax, ay, bx, by,
        mx[k] + (tx / wSum - mx[k]) * 2 * p.bundling,
        my[k] + (ty / wSum - my[k]) * 2 * p.bundling
      );
    }
  } else if (p.mode === "attract") {
    let ctrX = 0, ctrY = 0;
    if (p.attractCenter === "custom") {
      ctrX = p.centerX * aspect;
      ctrY = p.centerY;
    } else {
      // Centroid of the REAL points (synthetic table entries excluded)
      // — stable as connectivity changes.
      const n = Math.max(1, Math.min(args.centroidCount ?? M, M));
      for (let i = 0; i < n; i++) {
        ctrX += px[i];
        ctrY += py[i];
      }
      ctrX /= n;
      ctrY /= n;
    }
    for (let k = 0; k < E; k++) {
      const e = edges[k];
      const ax = px[e.i], ay = py[e.i];
      const bx = px[e.j], by = py[e.j];
      const L = Math.hypot(bx - ax, by - ay);
      const mxe = (ax + bx) / 2, mye = (ay + by) / 2;
      const vx = ctrX - mxe, vy = ctrY - mye;
      const dist = Math.hypot(vx, vy);
      const amt = p.attractStrength * jitterMul(e);
      if (L < 1e-9 || dist < 1e-9 || amt === 0) {
        out[k] = none;
        continue;
      }
      // Positive bows toward the center, capped so the curve's
      // midpoint kisses it but never overshoots past; negative
      // repels, uncapped.
      let dev = amt * L * 0.5;
      if (dev > dist) dev = dist;
      bow(
        k,
        ax, ay, bx, by,
        mxe + (vx / dist) * 2 * dev,
        mye + (vy / dist) * 2 * dev
      );
    }
  } else {
    out.fill(none);
  }
  return out;
}
