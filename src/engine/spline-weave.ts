// Loop Weave geometry — the pure math behind the Loop Weave node
// (specdocs/071926_loop-weave.md). Takes a point set and builds a single
// open spline that visits the points in order, wrapping each in an
// elliptical orbit and connecting consecutive orbits with Hermite
// bridges anchored on the common-tangent construction. Handedness
// decides the transition: opposite-handed neighbors take the crossing
// (internal) tangent — the weave "X" — same-handed take the outside
// (external) tangent, the cursive look. Overlapping orbits (the common
// case at default radius) have no true tangent line; the clamped
// tangent points kiss and the Hermite's turn-scaled handles bridge them
// smoothly.
//
// Everything runs in canvas PIXEL space so orbits stay round on
// non-square canvases; positions cross the boundary as normalized
// [0,1]² y-down. All per-point randomness hashes on SOURCE point index
// (hash01) so appending a point never reshuffles what's already built.
//
// Reveal model: the path is a chain of tour UNITS — unit k is the
// connector arriving from orbit k−1 (k>0) plus orbit k's arc. `progress`
// (0..1 of the whole tour) and the per-orbit `orbitLimit` hook (the
// node's auto-reveal clock) each cap how much of a unit is drawn; the
// path stops at the first incomplete unit, cut by arc length.

import type {
  PointsValue,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "./types";
import { fitSplineToPolyline } from "./spline-math";
import { hash01 } from "./spline-color-source";

type V2 = [number, number];

export interface WeaveParams {
  order: "index" | "nearest";
  // Canvas-width fraction (spline-repeat's distance unit).
  radius: number;
  radiusJitter: number; // 0..1, ± fraction of radius, hashed per point
  usePointScale: boolean;
  squash: number; // 0..1 → ry = rx·(1−squash)
  orient: "travel" | "fixed" | "random" | "point";
  orientAngle: number; // radians (node converts from its degree param)
  loops: number; // windings per point; rounds per point, jitter dithers
  loopsJitter: number; // 0..1
  direction: "alternate" | "cw" | "ccw" | "random";
  seed: number;
  ends: "center" | "orbit";
  // --- Shape modulation (rev 4). All per-point randomness hashed on
  // source index; all mods fold into ONE radius-scale function of arc
  // progress `a`, and connector endpoints re-anchor on the MODULATED
  // geometry so joins stay G1.
  // Radius factor per full winding: 1 = off, <1 spirals inward (the
  // telephone-doodle — exits from inside its own coils), >1 outward.
  spiralPerTurn: number;
  lobes: number; // integer petal count on r(θ), 0 = off
  lobeDepth: number; // 0..1 petal amplitude
  wobble: number; // 0..1 hand-tremor noise on the radius
  // Blend orbit size toward 0.45 × the distance to the nearest tour
  // neighbor: isolated points get big lassos, clusters tight curls.
  // Caveat: the previous LAST orbit re-sizes when a new point lands
  // (it gains a neighbor) — same tail-only instability as travel
  // orientation, disclosed not prevented.
  radiusFromSpacing: number; // 0..1
  // --- Connector character. tension multiplies both Hermite handles
  // (taut string → swooping flourish); swing biases exit vs entry
  // handle (−1..1); sag bows the connector toward screen-down (+) or
  // up (−) with a zero-slope-at-ends bump, so end tangents — and G1
  // joins — are untouched.
  tension: number;
  swing: number;
  sag: number;
  fitError: number; // px — fitSplineToPolyline tolerance
  progress: number; // 0..1 of the whole tour
  // Auto-reveal hook: per-orbit draw fraction 0..1 (1 = fully drawn).
  // Called with the source point index and tour position. Optional —
  // omitted means every orbit is fully available.
  orbitLimit?: (srcIndex: number, tourIndex: number) => number;
}

export interface WeaveResult {
  weave: SplineValue;
  orbits: SplineValue; // full orbit ellipses, groupIndex = source index
  skipped: SplineValue; // untraveled arc per orbit, groupIndex = source
  // True when nothing was held back by progress/orbitLimit — the node
  // uses this to know whether an auto-reveal is still in flight.
  complete: boolean;
}

interface Orbit {
  srcIndex: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  cosPhi: number;
  sinPhi: number;
  dir: 1 | -1; // +1 = θ increasing (visually clockwise in y-down px)
  turns: number; // extra full windings (integer ≥ 0)
  entryTheta: number;
  exitTheta: number;
  sweep: number; // total angular travel ≥ 0 (radians, in `dir`)
  // Hashed phases for the shape modulations (lobe pattern + the two
  // wobble octaves) — per point, append-stable.
  lobePhase: number;
  w1: number;
  w2: number;
}

const TAU = Math.PI * 2;

// Distinct salts per property so one hash stream never aliases another.
const SALT_RADIUS = 101;
const SALT_LOOPS = 211;
const SALT_DIR = 307;
const SALT_ORIENT = 401;
const SALT_LOBE = 503;
const SALT_W1 = 601;
const SALT_W2 = 701;

function orbitPoint(o: Orbit, theta: number, radiusScale: number): V2 {
  const ex = o.rx * radiusScale * Math.cos(theta);
  const ey = o.ry * radiusScale * Math.sin(theta);
  return [
    o.cx + o.cosPhi * ex - o.sinPhi * ey,
    o.cy + o.sinPhi * ex + o.cosPhi * ey,
  ];
}

// Traversal direction (unit-ish, unnormalized) at theta, honoring dir.
function orbitTangent(o: Orbit, theta: number): V2 {
  const dx = -o.rx * Math.sin(theta);
  const dy = o.ry * Math.cos(theta);
  return [
    o.dir * (o.cosPhi * dx - o.sinPhi * dy),
    o.dir * (o.sinPhi * dx + o.cosPhi * dy),
  ];
}

// Tangent point on an orbit for a line through an external point,
// choosing the candidate whose traversal direction is consistent:
// "leave" = travel heads toward the external point, "arrive" = travel
// continues away from it. Solved in the orbit's affine-normalized frame
// (tangency is affine-invariant); the consistency test runs in real px
// space. An external point inside the orbit degrades continuously (the
// acos clamp) to the facing point — overlapping orbits kiss instead of
// exploding.
function tangentPoint(
  o: Orbit,
  ext: V2,
  mode: "leave" | "arrive"
): { theta: number; pt: V2 } {
  const px = ext[0] - o.cx;
  const py = ext[1] - o.cy;
  const ex = (px * o.cosPhi + py * o.sinPhi) / Math.max(o.rx, 1e-6);
  const ey = (-px * o.sinPhi + py * o.cosPhi) / Math.max(o.ry, 1e-6);
  const rho = Math.hypot(ex, ey);
  const face = Math.atan2(ey, ex);
  const alpha = Math.acos(Math.min(1, 1 / Math.max(rho, 1e-6)));
  let best: { theta: number; pt: V2 } | null = null;
  for (const s of [1, -1] as const) {
    const theta = face + s * alpha;
    const pt = orbitPoint(o, theta, 1);
    const t = orbitTangent(o, theta);
    const vx = mode === "leave" ? ext[0] - pt[0] : pt[0] - ext[0];
    const vy = mode === "leave" ? ext[1] - pt[1] : pt[1] - ext[1];
    if (t[0] * vx + t[1] * vy > 0) {
      best = { theta, pt };
      break;
    }
    if (!best) best = { theta, pt };
  }
  return best!;
}

// Angular travel from `from` to `to` in direction `dir`, in [0, 2π).
function sweepBetween(from: number, to: number, dir: 1 | -1): number {
  let d = (to - from) * dir;
  d = d % TAU;
  if (d < 0) d += TAU;
  return d;
}

function fitToSubpath(
  poly: V2[],
  width: number,
  height: number,
  error: number,
  closed: boolean,
  groupIndex?: number
): SplineSubpath | null {
  if (poly.length < 2) return null;
  const anchors = fitSplineToPolyline(poly, error);
  if (anchors.length < 2) return null;
  const norm: SplineAnchor[] = anchors.map((a) => {
    const out: SplineAnchor = {
      pos: [a.pos[0] / width, a.pos[1] / height],
    };
    if (a.inHandle) out.inHandle = [a.inHandle[0] / width, a.inHandle[1] / height];
    if (a.outHandle)
      out.outHandle = [a.outHandle[0] / width, a.outHandle[1] / height];
    return out;
  });
  const sub: SplineSubpath = { anchors: norm, closed };
  if (groupIndex !== undefined) sub.groupIndex = groupIndex;
  return sub;
}

// Full orbit ellipse as an exact 4-anchor bezier ring (kappa handles),
// normalized. Cheaper and cleaner than sampling + fitting.
const KAPPA = 0.5522847498307936;
function orbitEllipseSubpath(
  o: Orbit,
  width: number,
  height: number
): SplineSubpath {
  const anchors: SplineAnchor[] = [];
  for (let q = 0; q < 4; q++) {
    const theta = (q * TAU) / 4;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Anchor on the ellipse; handles along the tangent, kappa-scaled.
    const hx = -o.rx * s * KAPPA;
    const hy = o.ry * c * KAPPA;
    const rot = (x: number, y: number): V2 => [
      o.cosPhi * x - o.sinPhi * y,
      o.sinPhi * x + o.cosPhi * y,
    ];
    const pos = rot(o.rx * c, o.ry * s);
    const h = rot(hx, hy);
    anchors.push({
      pos: [(o.cx + pos[0]) / width, (o.cy + pos[1]) / height],
      inHandle: [-h[0] / width, -h[1] / height],
      outHandle: [h[0] / width, h[1] / height],
    });
  }
  return { anchors, closed: true, groupIndex: o.srcIndex };
}

// Adaptive arc sample count from approximate arc length in px.
function arcSampleCount(o: Orbit, sweep: number): number {
  const avgR = (o.rx + o.ry) * 0.5;
  const len = sweep * Math.max(avgR, 1);
  return Math.max(8, Math.min(1024, Math.ceil(len / 3)));
}

export function buildLoopWeave(
  pts: PointsValue,
  width: number,
  height: number,
  p: WeaveParams,
  wantOrbits: boolean,
  wantSkipped: boolean
): WeaveResult {
  const empty = (): SplineValue => ({ kind: "spline", subpaths: [] });
  const n = pts.count;
  if (n < 2 || width <= 0 || height <= 0) {
    return { weave: empty(), orbits: empty(), skipped: empty(), complete: true };
  }

  // --- Tour ------------------------------------------------------------
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pts.positions[i * 2] * width;
    py[i] = pts.positions[i * 2 + 1] * height;
  }
  let tour: number[];
  if (p.order === "nearest") {
    // Greedy nearest-neighbor from point 0. O(N²) — Connect Points
    // precedent; fine at the point counts this targets.
    tour = [0];
    const used = new Uint8Array(n);
    used[0] = 1;
    for (let step = 1; step < n; step++) {
      const last = tour[tour.length - 1];
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const dx = px[i] - px[last];
        const dy = py[i] - py[last];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      tour.push(best);
      used[best] = 1;
    }
  } else {
    tour = Array.from({ length: n }, (_, i) => i);
  }

  // --- Orbits ----------------------------------------------------------
  const baseR = Math.max(0.5, p.radius * width);
  const seed = Math.floor(p.seed);
  const orbits: Orbit[] = [];
  for (let k = 0; k < n; k++) {
    const i = tour[k];
    const jr = 1 + (hash01(i, seed + SALT_RADIUS) - 0.5) * 2 * p.radiusJitter;
    // Adaptive radius: blend the base toward 0.45 × the nearest tour
    // neighbor's distance (orbits kiss at 0.5), then jitter on top.
    let effBase = baseR;
    if (p.radiusFromSpacing > 0) {
      const dPrev =
        k > 0
          ? Math.hypot(px[i] - px[tour[k - 1]], py[i] - py[tour[k - 1]])
          : Infinity;
      const dNext =
        k < n - 1
          ? Math.hypot(px[i] - px[tour[k + 1]], py[i] - py[tour[k + 1]])
          : Infinity;
      const nd = Math.min(dPrev, dNext);
      effBase = Math.max(0.5, baseR + (nd * 0.45 - baseR) * p.radiusFromSpacing);
    }
    let rx = effBase * Math.max(0.05, jr);
    let ry = rx * Math.max(0.05, 1 - p.squash);
    if (p.usePointScale && pts.scales) {
      rx *= Math.max(0.05, Math.abs(pts.scales[i * 2]));
      ry *= Math.max(0.05, Math.abs(pts.scales[i * 2 + 1]));
    }
    let phi: number;
    if (p.orient === "fixed") {
      phi = p.orientAngle;
    } else if (p.orient === "random") {
      phi = hash01(i, seed + SALT_ORIENT) * Math.PI;
    } else if (p.orient === "point") {
      phi = pts.rotations ? pts.rotations[i] : 0;
    } else {
      // travel: incoming→outgoing direction through this stop.
      const a = tour[Math.max(0, k - 1)];
      const b = tour[Math.min(n - 1, k + 1)];
      phi = Math.atan2(py[b] - py[a], px[b] - px[a]);
    }
    let dir: 1 | -1;
    if (p.direction === "cw") dir = 1;
    else if (p.direction === "ccw") dir = -1;
    else if (p.direction === "random")
      dir = hash01(i, seed + SALT_DIR) < 0.5 ? 1 : -1;
    else dir = k % 2 === 0 ? 1 : -1; // alternate along the tour
    const w =
      p.loops + (hash01(i, seed + SALT_LOOPS) - 0.5) * 2 * p.loopsJitter;
    orbits.push({
      srcIndex: i,
      cx: px[i],
      cy: py[i],
      rx,
      ry,
      cosPhi: Math.cos(phi),
      sinPhi: Math.sin(phi),
      dir,
      turns: Math.max(0, Math.round(w)),
      entryTheta: 0,
      exitTheta: 0,
      sweep: 0,
      lobePhase: hash01(i, seed + SALT_LOBE) * TAU,
      w1: hash01(i, seed + SALT_W1) * TAU,
      w2: hash01(i, seed + SALT_W2) * TAU,
    });
  }

  // --- Common tangents -------------------------------------------------
  // Places entry/exit ANGLES on the base ellipses via 2–3 fixed-point
  // refinements of tangent-toward-the-other-tangent-point. The actual
  // connector endpoints are re-derived later from the MODULATED geometry
  // at those angles (spiral/lobes/wobble move the radius).
  for (let k = 0; k < n - 1; k++) {
    const A = orbits[k];
    const B = orbits[k + 1];
    const target: V2 = [B.cx, B.cy];
    let exit = tangentPoint(A, target, "leave");
    let entry = tangentPoint(B, exit.pt, "arrive");
    for (let iter = 0; iter < 2; iter++) {
      exit = tangentPoint(A, entry.pt, "leave");
      entry = tangentPoint(B, exit.pt, "arrive");
    }
    A.exitTheta = exit.theta;
    B.entryTheta = entry.theta;
  }

  // --- Arc spans -------------------------------------------------------
  for (let k = 0; k < n; k++) {
    const o = orbits[k];
    if (k === 0) o.entryTheta = o.exitTheta; // free start: whole turns only
    if (k === n - 1) o.exitTheta = o.entryTheta; // free end
    const base = sweepBetween(o.entryTheta, o.exitTheta, o.dir);
    o.sweep = base + TAU * o.turns;
    // A free end with zero base sweep still deserves its windings; with
    // turns = 0 the orbit contributes nothing (slalom degenerate — fine).
  }

  // --- Shape modulation -----------------------------------------------
  // One radius-scale function of arc progress `a` (px-space, applied on
  // top of the base ellipse). Spiral compounds per winding; lobes are a
  // fixed petal pattern in the orbit's own frame (function of θ); wobble
  // is two non-harmonic cosine octaves of `a` so successive windings
  // don't retrace each other. Everything is per-point-hashed → append-
  // stable. Connector endpoints/tangents come from the SAME function so
  // the modulated arc and its bridge stay G1.
  const spiralF = Math.max(0.1, p.spiralPerTurn || 1);
  const lobesN = Math.max(0, Math.round(p.lobes));
  const lobeAmt = Math.max(0, Math.min(1, p.lobeDepth));
  const wobbleAmt = Math.max(0, Math.min(1, p.wobble));
  const modActive =
    spiralF !== 1 || (lobesN > 0 && lobeAmt > 0) || wobbleAmt > 0;
  const modScale = (o: Orbit, a: number): number => {
    if (!modActive) return 1;
    let s = 1;
    if (spiralF !== 1) s *= Math.pow(spiralF, a / TAU);
    if (lobesN > 0 && lobeAmt > 0) {
      const theta = o.entryTheta + o.dir * a;
      s *= 1 + lobeAmt * Math.cos(lobesN * theta + o.lobePhase);
    }
    if (wobbleAmt > 0) {
      s *=
        1 +
        wobbleAmt *
          0.5 *
          (0.6 * Math.cos(2.3 * a + o.w1) + 0.4 * Math.cos(4.7 * a + o.w2));
    }
    return Math.max(0.05, s);
  };
  const modPoint = (o: Orbit, a: number): V2 =>
    orbitPoint(o, o.entryTheta + o.dir * a, modScale(o, a));
  // Traversal direction at arc progress `a` (unnormalized) — central
  // difference over the full modulated position, so the spiral/lobe/
  // wobble radial-velocity terms are included. Exact direction when the
  // modulation is off (matches orbitTangent).
  const modTangent = (o: Orbit, a: number): V2 => {
    const e = 1e-3;
    const p0 = modPoint(o, a - e);
    const p1 = modPoint(o, a + e);
    return [p1[0] - p0[0], p1[1] - p0[1]];
  };

  // --- Sample units ----------------------------------------------------
  // Unit k = connector (k−1 → k, when k > 0) + orbit k's arc. Ends mode
  // `center` prepends the first center / appends the last center with a
  // quarter-turn radius ramp so the stroke lands ON the points.
  const units: V2[][] = [];
  for (let k = 0; k < n; k++) {
    const o = orbits[k];
    const unit: V2[] = [];
    if (k > 0) {
      // Connector as a Hermite cubic whose end tangents are the two
      // orbits' traversal directions, anchored on the MODULATED exit/
      // entry points (spiral exits from inside its coils, a lobe may
      // hand over from a petal tip). When the orbits are separated and
      // unmodulated this degenerates to the straight common-tangent
      // line; when they OVERLAP (closer than the radii sum — the
      // common case at default radius) no tangent line exists and the
      // clamped tangent points face each other — the Hermite bridges
      // them smoothly where a straight segment would cusp.
      const A = orbits[k - 1];
      const from = modPoint(A, A.sweep);
      const to = modPoint(o, 0);
      const t0raw = modTangent(A, A.sweep);
      const t1raw = modTangent(o, 0);
      const l0 = Math.hypot(t0raw[0], t0raw[1]) || 1;
      const l1 = Math.hypot(t1raw[0], t1raw[1]) || 1;
      const t0x = t0raw[0] / l0;
      const t0y = t0raw[1] / l0;
      const t1x = t1raw[0] / l1;
      const t1y = t1raw[1] / l1;
      const m = Math.hypot(to[0] - from[0], to[1] - from[1]);
      // Handle lengths: m/3 reproduces the straight tangent line when
      // the orbits are separated (tangents ≈ chord). When they overlap,
      // the chord shrinks toward zero while the end tangents still
      // disagree — m/3 would hairpin. Grow each handle with the turn
      // its end must make, using the orbit radius as the length scale,
      // so the bridge swings a smooth radius-sized curl instead.
      // `tension` scales both handles (taut → flourish); `swing`
      // biases exit vs entry. Directions are untouched, so G1 holds.
      let chx = t0x;
      let chy = t0y;
      if (m > 1e-6) {
        chx = (to[0] - from[0]) / m;
        chy = (to[1] - from[1]) / m;
      }
      const a0 = Math.acos(Math.max(-1, Math.min(1, t0x * chx + t0y * chy)));
      const a1 = Math.acos(Math.max(-1, Math.min(1, t1x * chx + t1y * chy)));
      const rA = (A.rx + A.ry) / 2;
      const rB = (o.rx + o.ry) / 2;
      const tens = Math.max(0.05, p.tension);
      const swingOut = Math.max(0.05, 1 + p.swing);
      const swingIn = Math.max(0.05, 1 - p.swing);
      const h0 =
        Math.max(m / 3, rA * 0.6 * (a0 / Math.PI)) * tens * swingOut;
      const h1 =
        Math.max(m / 3, rB * 0.6 * (a1 / Math.PI)) * tens * swingIn;
      const p1x = from[0] + t0x * h0;
      const p1y = from[1] + t0y * h0;
      const p2x = to[0] - t1x * h1;
      const p2y = to[1] - t1y * h1;
      // Sag: bow the run toward screen-down (+) or up (−). Applied as
      // a (t(1−t))² bump on the SAMPLES — zero value AND zero slope at
      // both ends, so the end tangents (and the G1 joins) are exact.
      let sagX = 0;
      let sagY = 0;
      if (p.sag !== 0 && m > 1e-6) {
        let perpX = -chy;
        let perpY = chx;
        if (perpY < 0) {
          perpX = -perpX;
          perpY = -perpY;
        }
        const amp = p.sag * m * 0.5;
        sagX = perpX * amp;
        sagY = perpY * amp;
      }
      const approxLen = m + h0 + h1;
      const segs = Math.max(8, Math.min(200, Math.ceil(approxLen / 3)));
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const u = 1 - t;
        const b0 = u * u * u;
        const b1 = 3 * u * u * t;
        const b2 = 3 * u * t * t;
        const b3 = t * t * t;
        const bump = 16 * t * t * u * u;
        unit.push([
          b0 * from[0] + b1 * p1x + b2 * p2x + b3 * to[0] + sagX * bump,
          b0 * from[1] + b1 * p1y + b2 * p2y + b3 * to[1] + sagY * bump,
        ]);
      }
    } else if (p.ends === "center") {
      unit.push([o.cx, o.cy]);
    }
    if (o.sweep > 1e-6) {
      // Denser sampling when shape modulation is on — lobes/wobble add
      // radial detail the base arc-length estimate doesn't see.
      const density = modActive ? 1 + wobbleAmt + (lobesN > 0 ? 1 : 0) : 1;
      const count = Math.min(
        2048,
        Math.ceil(arcSampleCount(o, o.sweep) * density)
      );
      // Quarter-turn (or shorter) radius ramps at the free ends.
      const rampIn = k === 0 && p.ends === "center" ? Math.min(TAU / 4, o.sweep) : 0;
      const rampOut =
        k === n - 1 && p.ends === "center" ? Math.min(TAU / 4, o.sweep) : 0;
      for (let s = 0; s <= count; s++) {
        const a = (s / count) * o.sweep;
        let scale = modScale(o, a);
        if (rampIn > 0 && a < rampIn) {
          const t = a / rampIn;
          scale *= t * t * (3 - 2 * t);
        }
        const fromEnd = o.sweep - a;
        if (rampOut > 0 && fromEnd < rampOut) {
          const t = fromEnd / rampOut;
          scale *= t * t * (3 - 2 * t);
        }
        unit.push(orbitPoint(o, o.entryTheta + o.dir * a, scale));
      }
    }
    if (k === n - 1 && p.ends === "center") unit.push([o.cx, o.cy]);
    units.push(unit);
  }

  // --- Reveal cut ------------------------------------------------------
  // Per-unit draw fraction = min(progress-derived, orbitLimit). The path
  // is one continuous stroke, so it stops at the first incomplete unit.
  const progressUnits = Math.max(0, Math.min(1, p.progress)) * n;
  const drawnUnits: V2[][] = [];
  let complete = true;
  let unitsDrawn = 0; // fractional tour position actually drawn
  for (let k = 0; k < n; k++) {
    const fromProgress = Math.max(0, Math.min(1, progressUnits - k));
    const fromReveal = p.orbitLimit
      ? Math.max(0, Math.min(1, p.orbitLimit(orbits[k].srcIndex, k)))
      : 1;
    const f = Math.min(fromProgress, fromReveal);
    const unit = units[k];
    if (f >= 1) {
      drawnUnits.push(unit);
      unitsDrawn = k + 1;
      continue;
    }
    complete = false;
    if (f > 0 && unit.length >= 2) {
      // Cut the unit at fraction f of its arc length.
      let total = 0;
      for (let s = 1; s < unit.length; s++) {
        total += Math.hypot(
          unit[s][0] - unit[s - 1][0],
          unit[s][1] - unit[s - 1][1]
        );
      }
      let want = total * f;
      const cut: V2[] = [unit[0]];
      for (let s = 1; s < unit.length && want > 0; s++) {
        const seg = Math.hypot(
          unit[s][0] - unit[s - 1][0],
          unit[s][1] - unit[s - 1][1]
        );
        if (seg <= want) {
          cut.push(unit[s]);
          want -= seg;
        } else {
          const t = seg > 0 ? want / seg : 0;
          cut.push([
            unit[s - 1][0] + (unit[s][0] - unit[s - 1][0]) * t,
            unit[s - 1][1] + (unit[s][1] - unit[s - 1][1]) * t,
          ]);
          want = 0;
        }
      }
      drawnUnits.push(cut);
      unitsDrawn = k + f;
    }
    break; // everything after the first incomplete unit stays undrawn
  }

  // --- Fit -------------------------------------------------------------
  // Fit each unit INDEPENDENTLY and stitch. The least-squares fit is
  // global over its input — fitting the whole path at once would let an
  // appended point redistribute anchors along ink that's already drawn
  // (the append-stability invariant). Per-unit polylines are
  // byte-identical under append, so their fits are too; consecutive
  // units share their boundary point (a tangent point, so the join is
  // G1 by construction) and the duplicate anchor merges away.
  const weave: SplineValue = { kind: "spline", subpaths: [] };
  const joinEps = Math.max(1e-3, p.fitError * 0.5);
  const stitched: SplineAnchor[] = [];
  for (const unitPoly of drawnUnits) {
    const fitted = fitSplineToPolyline(unitPoly, p.fitError);
    if (fitted.length < 2) continue;
    if (stitched.length === 0) {
      stitched.push(...fitted);
      continue;
    }
    const prev = stitched[stitched.length - 1];
    const first = fitted[0];
    if (
      Math.hypot(prev.pos[0] - first.pos[0], prev.pos[1] - first.pos[1]) <
      joinEps
    ) {
      prev.outHandle = first.outHandle;
      stitched.push(...fitted.slice(1));
    } else {
      stitched.push(...fitted);
    }
  }
  if (stitched.length >= 2) {
    const norm: SplineAnchor[] = stitched.map((a) => {
      const out: SplineAnchor = { pos: [a.pos[0] / width, a.pos[1] / height] };
      if (a.inHandle)
        out.inHandle = [a.inHandle[0] / width, a.inHandle[1] / height];
      if (a.outHandle)
        out.outHandle = [a.outHandle[0] / width, a.outHandle[1] / height];
      return out;
    });
    weave.subpaths.push({ anchors: norm, closed: false });
  }

  // --- Aux: orbits + skipped arcs -------------------------------------
  // A guide exists once its unit has started drawing (unitsDrawn > k).
  const orbitsOut: SplineValue = { kind: "spline", subpaths: [] };
  const skippedOut: SplineValue = { kind: "spline", subpaths: [] };
  if (wantOrbits || wantSkipped) {
    for (let k = 0; k < n; k++) {
      if (unitsDrawn <= k) break;
      const o = orbits[k];
      if (wantOrbits) orbitsOut.subpaths.push(orbitEllipseSubpath(o, width, height));
      if (wantSkipped && o.sweep < TAU - 1e-6) {
        // Untraveled complement: exit → entry in the travel direction.
        const gap = TAU - sweepBetween(o.entryTheta, o.exitTheta, o.dir);
        if (gap > 0.05) {
          const count = arcSampleCount(o, gap);
          const arc: V2[] = [];
          for (let s = 0; s <= count; s++) {
            arc.push(orbitPoint(o, o.exitTheta + o.dir * (s / count) * gap, 1));
          }
          const sub = fitToSubpath(arc, width, height, p.fitError, false, o.srcIndex);
          if (sub) skippedOut.subpaths.push(sub);
        }
      }
    }
  }

  return { weave, orbits: orbitsOut, skipped: skippedOut, complete };
}
