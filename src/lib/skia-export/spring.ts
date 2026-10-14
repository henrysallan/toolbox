// The `spring` easing for the React Native Skia exporters
// (specdocs/101326_skia-target.md §3.5). The curve itself lives in
// engine/spring-easing.ts (editor) and runtime/toolbox-timeline.ts (worklet
// twin); this module turns a keyframe's spring into what each export shape
// needs. scripts/check-spring-easing.mts proves all three against the
// engine and against Reanimated's own withSpring.
//
// API
//   timelineSpringOf(spring)          → TimelineSpring for a TimelineKey:
//                                       resolved params + the precomputed rest
//                                       time, so the device skips the solve.
//   springToReanimated(key, segmentMs) → the withSpring(B, config) config
//                                       (physics form) whose run from A
//                                       reproduces the segment A→B:
//                                       ≤ 1e-11 × |B − A| at frame timestamps,
//                                       and finished (=== B) before B's time.
//                                       Start it from rest — an interrupted
//                                       withSpring inherits velocity.
//   springSksl                         → SkSL (strict ES2, float, no loops):
//                                       `float tbx_spring(float u, float zeta,
//                                       float omega, float rest)`.
//   springSkslArgs(spring)             → { zeta, omega, rest } for it.
//   springSkslCall(spring, uExpr)      → `tbx_spring(<uExpr>, …literals)`.
//   springSkslReference(u, z, w, r)    → tbx_spring in JS fp32 (GPU-precision
//                                       oracle: ≤ 2e-6 from springEase).

import {
  resolveSpring,
  springOmega,
  springRestTime,
  SPRING_ENERGY_THRESHOLD,
  type SpringEasing,
} from "@/engine/spring-easing";
import type { TimelineSpring } from "./runtime/toolbox-timeline";

export function timelineSpringOf(spring: SpringEasing | undefined): TimelineSpring {
  const { zeta, settle } = resolveSpring(spring);
  return { dampingRatio: zeta, settle, rest: springRestTime(zeta) };
}

// Reanimated 4.7's SpringConfig, physics form (springConfigs.ts), with every
// default this curve depends on spelled out so a future default change
// can't move it.
export interface ReanimatedSpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  velocity: number;
  overshootClamping: boolean;
  energyThreshold: number;
}

// The double next to x toward +∞ (dir 1) or −∞ (dir −1); x finite, > 0.
function nextDouble(x: number, dir: 1 | -1): number {
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  b[0] += BigInt(dir);
  return f[0];
}

// Physics config, mass 1: stiffness = ω0² so Reanimated's
// omega0 = √(stiffness / mass) is ω0 itself, and damping = 2ζω0 nudged by
// an ulp or two (when one exists) so its zeta = damping / (2√(stiffness ·
// mass)) is ζ to the bit. Not the `duration` form: Reanimated's duration →
// stiffness bisection is an approximation (engine/spring-easing.ts).
export function springToReanimated(
  key: { spring?: SpringEasing } | SpringEasing | undefined,
  segmentMs: number
): ReanimatedSpringConfig {
  if (!(typeof segmentMs === "number" && Number.isFinite(segmentMs) && segmentMs > 0)) {
    throw new Error(`springToReanimated: segmentMs must be a positive number of milliseconds (got ${segmentMs}).`);
  }
  const spring =
    key && "dampingRatio" in key ? (key as SpringEasing) : (key as { spring?: SpringEasing } | undefined)?.spring;
  const { zeta } = resolveSpring(spring);
  const omega0 = springOmega(spring) / (segmentMs / 1000);
  const stiffness = omega0 * omega0;
  const mass = 1;
  const zetaOf = (c: number) => c / (2 * Math.sqrt(stiffness * mass));
  let damping = 2 * zeta * omega0;
  if (zetaOf(damping) !== zeta) {
    for (const dir of [1, -1] as const) {
      let c = damping;
      for (let i = 0; i < 4; i++) {
        c = nextDouble(c, dir);
        if (zetaOf(c) === zeta) break;
      }
      if (zetaOf(c) === zeta) {
        damping = c;
        break;
      }
    }
  }
  return {
    stiffness,
    damping,
    mass,
    velocity: 0,
    overshootClamping: false,
    energyThreshold: SPRING_ENERGY_THRESHOLD,
  };
}

// The same normalised curve in SkSL: progress at u of a segment whose spring
// has damping ratio `zeta`, natural frequency `omega` (radians per segment)
// and rest time `rest` (dimensionless, ω0·t) — springSkslArgs. fp32 on
// device; check-spring-easing compiles it in CanvasKit and bounds it
// against the JS curve.
export const springSksl = `// toolbox spring easing — Reanimated 4.7 withSpring from rest, normalised to the segment.
float tbx_spring(float u, float zeta, float omega, float rest) {
  if (u <= 0.0) { return 0.0; }
  if (u >= 1.0 || u * omega >= rest) { return 1.0; }
  if (zeta < 1.0) {
    float omega1 = omega * sqrt(1.0 - zeta * zeta);
    float env = exp(-zeta * omega * u);
    return 1.0 + env * (sin(omega1 * u) * ((-zeta * omega) / omega1) - cos(omega1 * u));
  }
  return 1.0 + exp(-omega * u) * (-1.0 - omega * u);
}
`;

// tbx_spring's arithmetic in JS fp32 — every operation rounded with
// Math.fround, builtins IEEE-accurate then rounded: what a GPU computes
// (within its builtins' own ulps). For gates comparing a baked shader's
// output. Skia's CPU raster backend (CanvasKit in Node) approximates exp
// (~6e-5 relative) and sin / cos (~2e-4 absolute), so CPU renders differ
// from this by that much more.
export function springSkslReference(u0: number, zeta0: number, omega0: number, rest0: number): number {
  const f = Math.fround;
  const u = f(u0);
  const zeta = f(zeta0);
  const omega = f(omega0);
  const rest = f(rest0);
  if (u <= 0) return 0;
  if (u >= 1 || f(u * omega) >= rest) return 1;
  if (zeta < 1) {
    const omega1 = f(omega * f(Math.sqrt(f(1 - f(zeta * zeta)))));
    const env = f(Math.exp(f(f(-zeta * omega) * u)));
    const ph = f(omega1 * u);
    const k = f(f(-zeta * omega) / omega1);
    return f(1 + f(env * f(f(f(Math.sin(ph)) * k) - f(Math.cos(ph)))));
  }
  const ou = f(omega * u);
  return f(1 + f(f(Math.exp(f(-omega * u))) * f(-1 - ou)));
}

export function springSkslArgs(spring: SpringEasing | undefined): { zeta: number; omega: number; rest: number } {
  const { zeta } = resolveSpring(spring);
  return { zeta, omega: springOmega(spring), rest: springRestTime(zeta) };
}

// A float literal SkSL parses back to the same fp32 (9 significant digits).
function skslFloat(x: number): string {
  const s = Math.fround(x).toPrecision(9);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

export function springSkslCall(spring: SpringEasing | undefined, uExpr: string): string {
  const a = springSkslArgs(spring);
  return `tbx_spring(${uExpr}, ${skslFloat(a.zeta)}, ${skslFloat(a.omega)}, ${skslFloat(a.rest)})`;
}
