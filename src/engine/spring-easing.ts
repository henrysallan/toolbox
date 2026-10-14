// The `spring` easing: a keyframe segment that plays React Native
// Reanimated 4.7's withSpring response (specdocs/101326_skia-target.md
// §3.5d), normalised to the segment like every other easing — a time remap
// u ∈ [0,1] → progress, 0 at key A, exactly 1 from the spring's rest point
// to key B. Overshoot is allowed (progress above 1 while it bounces).
//
// The math IS Reanimated's: underDampedSpringCalculations /
// criticallyDampedSpringCalculations and isAnimationTerminatingCalculation
// from react-native-reanimated/src/animation/spring/springUtils.ts,
// transcribed with Reanimated's own operation order, started from rest
// (x0 = −1, v0 = 0, toValue = 1) and timed in segment units (omega0 = Ω
// radians per segment, t = u). Reanimated has TWO branches, not three:
// ζ < 1 runs the under-damped solution; ζ ≥ 1 runs the critically damped
// one at omega0 (ζ is ignored there — Reanimated 4.7 has no over-damped
// solution), so every ζ ≥ 1 plays the same curve here.
//
// Rest point. Reanimated stops a spring when its energy (½k·Δ² + ½m·v²)
// falls to energyThreshold (6e-9, the withSpring default) of the start
// energy and snaps it to toValue. That fraction is a function of ζ and the
// dimensionless time s = ω0·t alone, so its first crossing `rest(ζ)` is one
// number per ζ (springRestTime, bisected on Reanimated's own energy test).
// A segment with `settle` = σ picks Ω = SPRING_SETTLE_MARGIN · rest(ζ) / σ:
// Reanimated's snap then lands at u = σ / 1.01, 1% before the settle point
// — so on device, under any frame phase or rounding, withSpring has
// already finished (current === toValue, exactly) before the next key, and
// toolbox returns exactly 1 from that same point. The 1.01 (rather than a
// round 0.99) keeps the snap off round fractions of the segment, which
// regular frame grids would otherwise hit exactly — where toolbox and the
// device could round the energy test differently.
//
// Why not Reanimated's `duration` config: its duration → stiffness solve
// bisects a critically-damped envelope at ζ·ω0, so the real spring stops
// at ~0.78–0.85 × 1.5·duration for ζ < 1 and ~ζ × later for ζ > 1, and its
// stiffness search is capped at 8000 — with the default mass of 4, short
// bouncy springs (ζ 0.3 under ~0.6 s) silently run 2–28× long. Its
// bisection tolerance also makes ω0 depend on the absolute duration at the
// 4e-5 level, so the curve wouldn't be the same at every segment length.
// The exporters instead emit the physics config whose run IS this curve
// (src/lib/skia-export/spring.ts: springToReanimated).
//
// Shipped twice: this module (the editor) and
// src/lib/skia-export/runtime/toolbox-timeline.ts (the worklet runtime, which
// must stay import-free). scripts/check-spring-easing.mts holds them
// bit-identical and checks the curve against Reanimated's own withSpring.

// The keyframe's spring parameters (Keyframe.spring, read when easingOut is
// "spring"; a missing or junk shape plays DEFAULT_SPRING).
export interface SpringEasing {
  // Reanimated's dampingRatio (ζ): < 1 bounces, ≥ 1 is Reanimated's
  // critically damped branch. Clamped into [SPRING_DAMPING_MIN, MAX].
  dampingRatio: number;
  // Fraction of the segment where the spring comes to rest (default 1:
  // at the next key). Reanimated's snap lands at settle / 1.01. Clamped
  // into [SPRING_SETTLE_MIN, 1] — a spring can't outlast its segment.
  settle?: number;
}

export const DEFAULT_SPRING: Readonly<Required<SpringEasing>> = {
  dampingRatio: 0.5,
  settle: 1,
};
// withSpring's default energyThreshold (springs/spring.ts).
export const SPRING_ENERGY_THRESHOLD = 6e-9;
export const SPRING_SETTLE_MARGIN = 1.01;
export const SPRING_DAMPING_MIN = 0.01;
export const SPRING_DAMPING_MAX = 10;
export const SPRING_SETTLE_MIN = 0.05;

// Reanimated's position + velocity from rest at x0 = −1 toward 1, after t
// (any time unit, omega0 in radians per that unit). Operation order follows
// springUtils.ts so the doubles match a transcription line for line.
export function springState(
  zeta: number,
  omega0: number,
  t: number
): { position: number; velocity: number } {
  const x0 = -1;
  const v0 = 0;
  const toValue = 1;
  if (zeta < 1) {
    const omega1 = omega0 * Math.sqrt(1 - zeta ** 2);
    const sin1 = Math.sin(omega1 * t);
    const cos1 = Math.cos(omega1 * t);
    const underDampedEnvelope = Math.exp(-zeta * omega0 * t);
    const underDampedFrag1 =
      underDampedEnvelope *
      (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
    return {
      position: toValue + underDampedFrag1,
      velocity:
        -zeta * omega0 * underDampedFrag1 +
        underDampedEnvelope *
          (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1),
    };
  }
  const criticallyDampedEnvelope = Math.exp(-omega0 * t);
  return {
    position:
      toValue + criticallyDampedEnvelope * (x0 + (v0 + omega0 * x0) * t),
    velocity:
      criticallyDampedEnvelope * -omega0 * (x0 + (v0 + omega0 * x0) * t) +
      criticallyDampedEnvelope * (v0 + omega0 * x0),
  };
}

// Reanimated's termination ratio currentEnergy / initialEnergy at
// dimensionless time s: getEnergy(toValue − current, velocity, stiffness,
// mass) over getEnergy(x0, 0, …) with omega0 = 1, so stiffness = mass = 1
// and the initial energy is ½·(−1)² = 0.5.
export function springEnergyFraction(zeta: number, s: number): number {
  const st = springState(zeta, 1, s);
  const d = 1 - st.position;
  const currentEnergy = 0.5 * d ** 2 + 0.5 * st.velocity ** 2;
  return currentEnergy / 0.5;
}

// The first dimensionless time at which Reanimated's energy test passes.
// Energy is non-increasing (dE/dt = −c·v²), so the passing set is [rest, ∞):
// double an upper bound until it passes, then bisect to adjacent doubles.
// Fixed bounds (≤ 64 doublings, ≤ 60 halvings — enough for every ζ ≥
// SPRING_DAMPING_MIN) so the runtime twin agrees bit for bit.
export function solveSpringRest(zeta: number): number {
  let hi = 1;
  for (let i = 0; i < 64 && !(springEnergyFraction(zeta, hi) <= SPRING_ENERGY_THRESHOLD); i++) {
    hi *= 2;
  }
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (springEnergyFraction(zeta, mid) <= SPRING_ENERGY_THRESHOLD) hi = mid;
    else lo = mid;
  }
  return hi;
}

// solveSpringRest, memoized per ζ (it's ~120 energy evaluations and the
// editor asks once per sample).
const restCache = new Map<number, number>();
export function springRestTime(zeta: number): number {
  let r = restCache.get(zeta);
  if (r === undefined) {
    if (restCache.size >= 512) restCache.clear();
    r = solveSpringRest(zeta);
    restCache.set(zeta, r);
  }
  return r;
}

function clampNum(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// Evaluation-time reading of a key's (untrusted) `spring`: never throws,
// never NaNs. Junk ζ → the default; junk settle → 1; both clamped.
export function resolveSpring(v: unknown): { zeta: number; settle: number } {
  const o = v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const z = o.dampingRatio;
  const s = o.settle;
  const zeta =
    typeof z === "number" && Number.isFinite(z) && z > 0
      ? clampNum(z, SPRING_DAMPING_MIN, SPRING_DAMPING_MAX)
      : DEFAULT_SPRING.dampingRatio;
  const settle =
    typeof s === "number" && Number.isFinite(s) && s > 0
      ? clampNum(s, SPRING_SETTLE_MIN, 1)
      : 1;
  return { zeta, settle };
}

// Gate an untrusted shape (an MCP payload, a hand-edited file) before it is
// WRITTEN: dampingRatio a finite number > 0, settle (optional) a finite
// number > 0; both clamped into range. null for anything else.
export function sanitizeSpringEasing(v: unknown): SpringEasing | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const { dampingRatio, settle } = v as Record<string, unknown>;
  if (typeof dampingRatio !== "number" || !Number.isFinite(dampingRatio) || dampingRatio <= 0) {
    return null;
  }
  if (settle !== undefined && (typeof settle !== "number" || !Number.isFinite(settle) || settle <= 0)) {
    return null;
  }
  const r = resolveSpring({ dampingRatio, settle });
  return { dampingRatio: r.zeta, settle: r.settle };
}

// Ω: the spring's natural frequency in radians per SEGMENT.
export function springOmega(spring?: SpringEasing): number {
  const { zeta, settle } = resolveSpring(spring);
  return (SPRING_SETTLE_MARGIN * springRestTime(zeta)) / settle;
}

// The time remap: progress at u ∈ [0,1] of the segment. Exactly 0 at u ≤ 0,
// exactly 1 from Reanimated's snap (u·Ω ≥ rest) and at u ≥ 1.
export function springEase(spring: SpringEasing | undefined, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const { zeta, settle } = resolveSpring(spring);
  const rest = springRestTime(zeta);
  const omega = (SPRING_SETTLE_MARGIN * rest) / settle;
  if (u * omega >= rest) return 1;
  return springState(zeta, omega, u).position;
}

// Polyline samples that keep a drawn spring smooth: ~12 per oscillation
// (ω1 / 2π cycles per segment), at least 32, at most 512.
export function springPathSamples(spring?: SpringEasing): number {
  const { zeta } = resolveSpring(spring);
  const omega = springOmega(spring);
  const cycles = zeta < 1 ? (omega * Math.sqrt(1 - zeta * zeta)) / (2 * Math.PI) : 1;
  return Math.max(32, Math.min(512, Math.ceil(cycles * 12)));
}
