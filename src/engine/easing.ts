// Shared easing library — a named set of Penner-style curves plus a single
// "intensity" coefficient, used anywhere a 0→1 value gets shaped (Scene Time's
// ping-pong / stepped modes, the Text node's per-character animators, …).
//
// Kept engine-side so both src/engine/* and src/nodes/* can import it without
// tripping the engine self-containment invariant (nodes → engine is fine;
// engine → engine is fine).

export type EasingFn = (t: number) => number;

// Each family is defined by its "ease-in" shape; the "out" and "in-out"
// variants are derived by the usual reflections, so adding a family is one line.
const toOut =
  (inFn: EasingFn): EasingFn =>
  (t) =>
    1 - inFn(1 - t);
const toInOut =
  (inFn: EasingFn): EasingFn =>
  (t) =>
    t < 0.5 ? inFn(2 * t) / 2 : 1 - inFn(2 * (1 - t)) / 2;

const inQuad: EasingFn = (t) => t * t;
const inCubic: EasingFn = (t) => t * t * t;
const inQuart: EasingFn = (t) => t * t * t * t;
const inQuint: EasingFn = (t) => t * t * t * t * t;
const inSine: EasingFn = (t) => 1 - Math.cos((t * Math.PI) / 2);
const inExpo: EasingFn = (t) => (t <= 0 ? 0 : Math.pow(2, 10 * (t - 1)));
const inCirc: EasingFn = (t) => 1 - Math.sqrt(Math.max(0, 1 - t * t));
const BACK_C1 = 1.70158;
const inBack: EasingFn = (t) => (BACK_C1 + 1) * t * t * t - BACK_C1 * t * t;
const inElastic: EasingFn = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
};
const outBounce: EasingFn = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
};
const inBounce: EasingFn = (t) => 1 - outBounce(1 - t);

export const EASINGS: Record<string, EasingFn> = {
  // Basics. NOTE: `linear`, `step`, `smoothstep`, `smootherstep`,
  // `ease-in`/`ease-out`/`ease-in-out` (quadratic), and the two `*-cubic` keys
  // are the original Scene Time option names — keep them so saved projects that
  // reference them by string still resolve (back-compat invariant #2).
  linear: (t) => t,
  step: (t) => (t < 1 ? 0 : 1),
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  "ease-in": inQuad,
  "ease-out": toOut(inQuad),
  "ease-in-out": toInOut(inQuad),
};

// Register in/out/in-out for a family under a shared suffix.
function addFamily(suffix: string, inFn: EasingFn): void {
  EASINGS[`ease-in-${suffix}`] = inFn;
  EASINGS[`ease-out-${suffix}`] = toOut(inFn);
  EASINGS[`ease-in-out-${suffix}`] = toInOut(inFn);
}
// `cubic` re-registers the two legacy cubic keys with identical functions and
// adds the missing `ease-in-out-cubic`.
addFamily("cubic", inCubic);
addFamily("quart", inQuart);
addFamily("quint", inQuint);
addFamily("sine", inSine);
addFamily("expo", inExpo);
addFamily("circ", inCirc);
addFamily("back", inBack);
addFamily("elastic", inElastic);
addFamily("bounce", inBounce);

export const EASING_OPTIONS = Object.keys(EASINGS);

// Apply an easing curve at a given intensity. Intensity blends the eased value
// against the raw linear input: 0 → linear (no easing), 1 → the exact curve,
// >1 → exaggerated (overshoots the curve, deepening back/elastic/bounce kicks).
// Output is intentionally NOT clamped so overshoot curves can push past [0,1].
export function applyEasing(name: string, t: number, intensity = 1): number {
  const fn = EASINGS[name] ?? EASINGS.linear;
  const tt = Math.max(0, Math.min(1, t));
  const eased = fn(tt);
  return tt + intensity * (eased - tt);
}
