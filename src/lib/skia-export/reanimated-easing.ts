// Reanimated 4.7.0's easing math, transcribed for toolbox's Node / editor
// side (specdocs/101326_skia-target.md §1.3, §3.5c). The native export
// (emit-native.ts) needs it to decide, per cubic-bezier segment, whether
// Reanimated's own `Easing.bezier` solver lands on toolbox's curve (it does
// to ~1e-6 for ordinary shapes and misses by up to 0.1 for shapes with a
// vertical tangent, e.g. (1, 0, 0, 1)); check-skia-native asserts the
// mapping table against it and, when skia-harness is installed, asserts
// this transcription against the real source
// (skia-harness/node_modules/react-native-reanimated/src/Easing.ts +
// Bezier.ts) bit for bit.
//
// Transcribed line for line from react-native-reanimated 4.7.0
// (src/Easing.ts, src/Bezier.ts; MIT, Software Mansion; Bezier from
// gre/bezier-easing, MIT, Gaëtan Renaudeau). Only the "worklet" directives
// and the name symbols are dropped. Do not "fix" anything here: the point
// is to be wrong exactly where Reanimated is.

export type ReanimatedEasingFunction = (t: number) => number;

// ---- Bezier.ts -----------------------------------------------------------------

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 0.0000001;
const SUBDIVISION_MAX_ITERATIONS = 10;

const kSplineTableSize = 11;
const kSampleStepSize = 1.0 / (kSplineTableSize - 1.0);

function A(aA1: number, aA2: number): number {
  return 1.0 - 3.0 * aA2 + 3.0 * aA1;
}
function B(aA1: number, aA2: number): number {
  return 3.0 * aA2 - 6.0 * aA1;
}
function C(aA1: number) {
  return 3.0 * aA1;
}

function calcBezier(aT: number, aA1: number, aA2: number): number {
  return ((A(aA1, aA2) * aT + B(aA1, aA2)) * aT + C(aA1)) * aT;
}

function getSlope(aT: number, aA1: number, aA2: number): number {
  return 3.0 * A(aA1, aA2) * aT * aT + 2.0 * B(aA1, aA2) * aT + C(aA1);
}

function binarySubdivide(aX: number, aA: number, aB: number, mX1: number, mX2: number): number {
  let currentX;
  let currentT;
  let i = 0;
  do {
    currentT = aA + (aB - aA) / 2.0;
    currentX = calcBezier(currentT, mX1, mX2) - aX;
    if (currentX > 0.0) {
      aB = currentT;
    } else {
      aA = currentT;
    }
  } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
  return currentT;
}

function newtonRaphsonIterate(aX: number, aGuessT: number, mX1: number, mX2: number): number {
  for (let i = 0; i < NEWTON_ITERATIONS; ++i) {
    const currentSlope = getSlope(aGuessT, mX1, mX2);
    if (currentSlope === 0.0) {
      return aGuessT;
    }
    const currentX = calcBezier(aGuessT, mX1, mX2) - aX;
    aGuessT -= currentX / currentSlope;
  }
  return aGuessT;
}

export function Bezier(mX1: number, mY1: number, mX2: number, mY2: number): (x: number) => number {
  function LinearEasing(x: number): number {
    return x;
  }

  if (!(mX1 >= 0 && mX1 <= 1 && mX2 >= 0 && mX2 <= 1)) {
    throw new Error("[Reanimated] Bezier x values must be in [0, 1] range.");
  }

  if (mX1 === mY1 && mX2 === mY2) {
    return LinearEasing;
  }

  const sampleValues = new Array(kSplineTableSize);

  for (let i = 0; i < kSplineTableSize; ++i) {
    sampleValues[i] = calcBezier(i * kSampleStepSize, mX1, mX2);
  }

  function getTForX(aX: number): number {
    let intervalStart = 0.0;
    let currentSample = 1;
    const lastSample = kSplineTableSize - 1;

    for (; currentSample !== lastSample && sampleValues[currentSample] <= aX; ++currentSample) {
      intervalStart += kSampleStepSize;
    }
    --currentSample;

    const dist = (aX - sampleValues[currentSample]) / (sampleValues[currentSample + 1] - sampleValues[currentSample]);
    const guessForT = intervalStart + dist * kSampleStepSize;

    const initialSlope = getSlope(guessForT, mX1, mX2);
    if (initialSlope >= NEWTON_MIN_SLOPE) {
      return newtonRaphsonIterate(aX, guessForT, mX1, mX2);
    } else if (initialSlope === 0.0) {
      return guessForT;
    } else {
      return binarySubdivide(aX, intervalStart, intervalStart + kSampleStepSize, mX1, mX2);
    }
  }

  return function BezierEasing(x) {
    if (mX1 === mY1 && mX2 === mY2) {
      return x; // linear
    }
    if (x === 0) {
      return 0;
    }
    if (x === 1) {
      return 1;
    }
    return calcBezier(getTForX(x), mY1, mY2);
  };
}

// ---- Easing.ts -----------------------------------------------------------------

export interface ReanimatedEasingFactory {
  factory: () => ReanimatedEasingFunction;
  bezier?: [number, number, number, number];
}

function linear(t: number): number {
  return t;
}

function ease(t: number): number {
  return Bezier(0.42, 0, 1, 1)(t);
}

function quad(t: number): number {
  return t * t;
}

function cubic(t: number): number {
  return t * t * t;
}

function poly(n: number): ReanimatedEasingFunction {
  return (t) => {
    return Math.pow(t, n);
  };
}

function sin(t: number): number {
  return 1 - Math.cos((t * Math.PI) / 2);
}

function circle(t: number): number {
  return 1 - Math.sqrt(1 - t * t);
}

function exp(t: number): number {
  return Math.pow(2, 10 * (t - 1));
}

function elastic(bounciness = 1): ReanimatedEasingFunction {
  const p = bounciness * Math.PI;
  return (t) => {
    return 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p);
  };
}

function back(s = 1.70158): (t: number) => number {
  return (t) => {
    return t * t * ((s + 1) * t - s);
  };
}

function bounce(t: number): number {
  if (t < 1 / 2.75) {
    return 7.5625 * t * t;
  }

  if (t < 2 / 2.75) {
    const t2 = t - 1.5 / 2.75;
    return 7.5625 * t2 * t2 + 0.75;
  }

  if (t < 2.5 / 2.75) {
    const t2 = t - 2.25 / 2.75;
    return 7.5625 * t2 * t2 + 0.9375;
  }

  const t2 = t - 2.625 / 2.75;
  return 7.5625 * t2 * t2 + 0.984375;
}

function bezier(x1: number, y1: number, x2: number, y2: number): ReanimatedEasingFactory {
  return {
    bezier: [x1, y1, x2, y2],
    factory: () => {
      return Bezier(x1, y1, x2, y2);
    },
  };
}

function bezierFn(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  return Bezier(x1, y1, x2, y2);
}

function in_(easing: ReanimatedEasingFunction): ReanimatedEasingFunction {
  return easing;
}

function out(easing: ReanimatedEasingFunction): ReanimatedEasingFunction {
  return (t) => {
    return 1 - easing(1 - t);
  };
}

function inOut(easing: ReanimatedEasingFunction): ReanimatedEasingFunction {
  return (t) => {
    if (t < 0.5) {
      return easing(t * 2) / 2;
    }
    return 1 - easing((1 - t) * 2) / 2;
  };
}

function steps(n = 10, roundToNextStep = true): ReanimatedEasingFunction {
  return (t) => {
    const value = Math.min(Math.max(t, 0), 1) * n;
    if (roundToNextStep) {
      return Math.ceil(value) / n;
    }
    return Math.floor(value) / n;
  };
}

export const ReanimatedEasing = {
  linear,
  ease,
  quad,
  cubic,
  poly,
  sin,
  circle,
  exp,
  elastic,
  back,
  bounce,
  bezier,
  bezierFn,
  steps,
  in: in_,
  out,
  inOut,
};

export type ReanimatedEasingModule = typeof ReanimatedEasing;
