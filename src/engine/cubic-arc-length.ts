import type { Bezier } from "bezier-js";

// Exact arc length on one cubic, both ways: the length between two curve
// parameters, and the parameter at a given length. bezier-js maps neither
// way finely enough for a cut: its `length()` is one fixed 24-point
// Gauss–Legendre pass, and nothing in it inverts length → t. Trim Path's
// arc-length measure needs both, because a cubic's parameter is not its
// length — on a handle-less line (cp1 = p0, cp2 = p3) the point at t is
// p0 + (3t² − 2t³)(p3 − p0), so t = 0.25 sits only 16 % of the way along.
//
// Length: adaptive Gauss–Legendre (8 points per interval, halved until the
// halves agree with the whole). The speed |B′| of a straight segment that
// runs one way (every in-line handle within the chord) is a quadratic, which
// 8 points integrate exactly, so lines measure exactly in one pass. Plain
// adaptive quadrature is blind to a feature narrower than its nodes'
// spacing, and a cubic has one where it nearly cusps (or a handle is nearly
// collapsed): around a speed minimum v the speed is √(v² + |B″|²x²), a
// corner rounded over a width w = v / |B″| that can be 1e-5 of the
// parameter range, where both the whole and the halves miss it and agree.
// So the integrator splits at every speed minimum (the real roots of
// d|B′|²/dt, a cubic) and, toward each sharp one (1e-7 ≤ w < 0.01), grades
// its intervals geometrically down to w / 16, each smooth at its own scale.
// An exact cusp (w = 0) needs only the split: the speed is |x|·|B″| there,
// linear on each side.
//
// Inverse: Newton on s(t) − target, bracketed, falling back to bisection
// whenever a step leaves the bracket (the speed is zero at a collapsed
// handle's end, so a plain Newton step there would fly off).
//
// Tolerance: relative to the cubic's control-polygon length P (an upper
// bound on its arc length): integration to 1e-13·P, the parameter solve to
// |s(t) − target| ≤ 1e-13·P. check-trim-path measures it against a dense
// graded reference (≤ 1e-11·P on random cubics, a loop, an exact and a
// near cusp); on a 4K-wide canvas that is ~1e-8 px.

// 8-point Gauss–Legendre nodes / weights on [−1, 1] (positive half).
const GL_X = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

const INTEGRATE_REL_TOL = 1e-13;
const SOLVE_REL_TOL = 1e-13;
const MAX_DEPTH = 30;
const MAX_SOLVE_STEPS = 100;
// A speed minimum narrower than this (in t) is resolved by grading…
const SHARP_W = 0.01;
// …unless it is this narrow: the rounding then moves the length by
// ≤ |B″|·w² ≤ 12·P·w² ≈ 1e-13·P, and the plain split is exact enough.
const CUSP_W = 1e-7;

// The derivative in power form, B′(t) = a t² + b t + c, per axis, and the
// sharp speed minima (t, rounding width w) in [0, 1].
export interface CubicSpeed {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
  // Control-polygon length — the tolerance scale.
  scale: number;
  // Every interior speed minimum, sorted — the integrator splits there.
  minima: number[];
  // The sharp ones (incl. ends), with their rounding width, to grade toward.
  sharp: { t: number; w: number }[];
}

type XY = { x: number; y: number };

export function cubicSpeed(curve: Bezier): CubicSpeed {
  const p = curve.points;
  const p0: XY = p[0];
  // bezier-js also builds quadratics (3 points); elevate one to a cubic so
  // the same power form covers it: cp1 = p0 + 2/3 (q1 − p0), cp2 = p2 + 2/3 (q1 − p2).
  let p1: XY = p[1];
  let p2: XY = p[2];
  let p3: XY = p[3];
  if (p.length === 3) {
    const q1 = p[1];
    const q2 = p[2];
    p1 = { x: p0.x + (2 / 3) * (q1.x - p0.x), y: p0.y + (2 / 3) * (q1.y - p0.y) };
    p2 = { x: q2.x + (2 / 3) * (q1.x - q2.x), y: q2.y + (2 / 3) * (q1.y - q2.y) };
    p3 = q2;
  }
  const k: CubicSpeed = {
    cx: 3 * (p1.x - p0.x),
    cy: 3 * (p1.y - p0.y),
    bx: 6 * (p2.x - 2 * p1.x + p0.x),
    by: 6 * (p2.y - 2 * p1.y + p0.y),
    ax: 3 * (p3.x - 3 * p2.x + 3 * p1.x - p0.x),
    ay: 3 * (p3.y - 3 * p2.y + 3 * p1.y - p0.y),
    scale:
      Math.hypot(p1.x - p0.x, p1.y - p0.y) +
      Math.hypot(p2.x - p1.x, p2.y - p1.y) +
      Math.hypot(p3.x - p2.x, p3.y - p2.y),
    minima: [],
    sharp: [],
  };
  findSpeedMinima(k);
  return k;
}

function speedAt(k: CubicSpeed, t: number): number {
  const dx = (k.ax * t + k.bx) * t + k.cx;
  const dy = (k.ay * t + k.by) * t + k.cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function accelAt(k: CubicSpeed, t: number): number {
  return Math.hypot(2 * k.ax * t + k.bx, 2 * k.ay * t + k.by);
}

// Real roots in (0, 1) of c3 t³ + c2 t² + c1 t + c0: bracket by the
// derivative's roots (monotone pieces), then bisect each sign change.
function rootsIn01(c3: number, c2: number, c1: number, c0: number): number[] {
  const f = (t: number) => ((c3 * t + c2) * t + c1) * t + c0;
  const cuts = [0];
  // f′ = 3c3 t² + 2c2 t + c1
  const a = 3 * c3;
  const b = 2 * c2;
  if (Math.abs(a) > 1e-300) {
    const disc = b * b - 4 * a * c1;
    if (disc > 0) {
      const sq = Math.sqrt(disc);
      for (const r of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) if (r > 0 && r < 1) cuts.push(r);
    }
  } else if (Math.abs(b) > 1e-300) {
    const r = -c1 / b;
    if (r > 0 && r < 1) cuts.push(r);
  }
  cuts.push(1);
  cuts.sort((x, y) => x - y);
  const out: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    let lo = cuts[i];
    let hi = cuts[i + 1];
    let flo = f(lo);
    const fhi = f(hi);
    if (flo === 0) {
      if (lo > 0 && lo < 1) out.push(lo);
      continue;
    }
    if (flo * fhi > 0) continue;
    for (let it = 0; it < 80 && hi - lo > 1e-16; it++) {
      const m = 0.5 * (lo + hi);
      const fm = f(m);
      if (fm === 0) {
        lo = hi = m;
        break;
      }
      if (fm * flo < 0) hi = m;
      else {
        lo = m;
        flo = fm;
      }
    }
    const r = 0.5 * (lo + hi);
    if (r > 0 && r < 1) out.push(r);
  }
  return out;
}

// Critical points of |B′|²: d/dt |B′|² = 2 B′·B″ with B′ = A t² + B t + C,
// B″ = 2A t + B → 2|A|² t³ + 3 A·B t² + (|B|² + 2 A·C) t + B·C. Minima are
// where it crosses from − to +; the ends count as minima when the speed
// rises away from them.
function findSpeedMinima(k: CubicSpeed): void {
  const AA = k.ax * k.ax + k.ay * k.ay;
  const AB = k.ax * k.bx + k.ay * k.by;
  const AC = k.ax * k.cx + k.ay * k.cy;
  const BB = k.bx * k.bx + k.by * k.by;
  const BC = k.bx * k.cx + k.by * k.cy;
  const g = (t: number) => ((2 * AA * t + 3 * AB) * t + (BB + 2 * AC)) * t + BC;
  const roots = rootsIn01(2 * AA, 3 * AB, BB + 2 * AC, BC);
  const eps = 1e-9;
  for (const r of roots) {
    if (g(Math.max(0, r - eps)) <= 0 && g(Math.min(1, r + eps)) >= 0) k.minima.push(r);
  }
  const candidates = [...k.minima];
  if (g(0) >= 0) candidates.push(0);
  if (g(1) <= 0) candidates.push(1);
  for (const t of candidates) {
    const acc = accelAt(k, t);
    if (!(acc > 0)) continue;
    const w = speedAt(k, t) / acc;
    if (w >= CUSP_W && w < SHARP_W) k.sharp.push({ t, w });
  }
}

function gl8(k: CubicSpeed, a: number, b: number): number {
  const h = 0.5 * (b - a);
  const m = 0.5 * (a + b);
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const d = h * GL_X[i];
    s += GL_W[i] * (speedAt(k, m - d) + speedAt(k, m + d));
  }
  return s * h;
}

function adaptive(
  k: CubicSpeed,
  a: number,
  b: number,
  whole: number,
  tol: number,
  depth: number
): number {
  const m = 0.5 * (a + b);
  const left = gl8(k, a, m);
  const right = gl8(k, m, b);
  const both = left + right;
  if (depth <= 0 || Math.abs(both - whole) <= tol) return both;
  return (
    adaptive(k, a, m, left, tol * 0.5, depth - 1) +
    adaptive(k, m, b, right, tol * 0.5, depth - 1)
  );
}

function plain(k: CubicSpeed, a: number, b: number, tolUnit: number): number {
  return b > a ? adaptive(k, a, b, gl8(k, a, b), tolUnit * (b - a), MAX_DEPTH) : 0;
}

// Integrate from `far` to `near` (either order) in intervals halving toward
// `near`, down to `minWidth`.
function graded(k: CubicSpeed, far: number, near: number, minWidth: number, tolUnit: number): number {
  let sum = 0;
  let x = far;
  for (let i = 0; i < 64 && Math.abs(x - near) > minWidth; i++) {
    const y = near + 0.5 * (x - near);
    sum += plain(k, Math.min(x, y), Math.max(x, y), tolUnit);
    x = y;
  }
  return sum + plain(k, Math.min(x, near), Math.max(x, near), tolUnit);
}

// The finest width piece [a, b] must grade down to toward its end `x`
// (Infinity: none). Pieces never hold a minimum inside (cubicArcLength
// splits there), so a sharp minimum is at an end, rounding the speed at
// scale w, or outside, nearer one end, at scale max(w, distance).
function gradeWidthAt(k: CubicSpeed, x: number, a: number, b: number): number {
  const other = x === a ? b : a;
  let width = Infinity;
  for (const s of k.sharp) {
    const outside = s.t < a || s.t > b;
    if (s.t !== x && !(outside && Math.abs(s.t - x) < Math.abs(s.t - other))) continue;
    const scale = Math.max(s.w, Math.abs(s.t - x));
    if (scale < b - a) width = Math.min(width, scale / 16);
  }
  return width;
}

function piece(k: CubicSpeed, a: number, b: number, tolUnit: number): number {
  if (!(b > a)) return 0;
  if (k.sharp.length === 0) return plain(k, a, b, tolUnit);
  const wa = gradeWidthAt(k, a, a, b);
  const wb = gradeWidthAt(k, b, a, b);
  if (wa === Infinity && wb === Infinity) return plain(k, a, b, tolUnit);
  if (wa !== Infinity && wb !== Infinity) {
    const m = 0.5 * (a + b);
    return graded(k, m, a, wa, tolUnit) + graded(k, m, b, wb, tolUnit);
  }
  return wa !== Infinity ? graded(k, b, a, wa, tolUnit) : graded(k, a, b, wb, tolUnit);
}

// Arc length of the cubic between parameters a ≤ b (both in [0, 1]).
export function cubicArcLength(k: CubicSpeed, a = 0, b = 1): number {
  if (!(b > a)) return 0;
  const tolUnit = INTEGRATE_REL_TOL * k.scale;
  let sum = 0;
  let lo = a;
  for (const m of k.minima) {
    if (m <= a || m >= b) continue;
    sum += piece(k, lo, m, tolUnit);
    lo = m;
  }
  return sum + piece(k, lo, b, tolUnit);
}

// Parameter t at which the arc length from t = 0 reaches `target`, given
// the cubic's whole length `total` (from cubicArcLength(k)). Clamps outside
// (0, total).
export function cubicParamAtLength(
  k: CubicSpeed,
  target: number,
  total: number
): number {
  if (!(total > 0) || !(target > 0)) return 0;
  if (target >= total) return 1;
  const tol = SOLVE_REL_TOL * k.scale;
  // Bracket [lo, hi] with s(lo) known, so each step integrates only the
  // stretch between the bracket's low end and the guess.
  let lo = 0;
  let hi = 1;
  let sLo = 0;
  let t = target / total;
  for (let i = 0; i < MAX_SOLVE_STEPS; i++) {
    const s = sLo + cubicArcLength(k, lo, t);
    const f = s - target;
    if (Math.abs(f) <= tol) return t;
    if (f < 0) {
      lo = t;
      sLo = s;
    } else {
      hi = t;
    }
    if (hi - lo <= 1e-15) return t;
    const v = speedAt(k, t);
    let next = v > 0 ? t - f / v : Number.NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    t = next;
  }
  return t;
}
