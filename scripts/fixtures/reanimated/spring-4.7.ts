// A transcription of React Native Reanimated 4.7.0's withSpring for plain
// numbers — src/animation/spring/{spring,springUtils,springConfigs}.ts
// (MIT, Software Mansion), statement for statement, minus the parts a
// numeric, uninterrupted spring never reaches: the logger, reduce-motion,
// prefix/suffix / color / array decoration (decorateAnimation passes a
// number straight to the base onStart), and the callback.
//
// scripts/check-spring-easing.mts runs the REAL source when
// skia-harness/node_modules is installed (bundled with esbuild, stubbing
// only `logger` and `defineAnimation`) and asserts this file returns the
// same doubles frame for frame; CI, which doesn't install the harness,
// runs this transcription instead.

/* eslint-disable @typescript-eslint/no-explicit-any */

const GentleSpringConfig = { damping: 120, mass: 4, stiffness: 900 };
const GentleSpringConfigWithDuration = { duration: 550, dampingRatio: 1 };

function checkIfConfigIsValid(config: any): boolean {
  let errorMessage = "";
  (["stiffness", "damping", "dampingRatio", "mass", "energyThreshold"] as const).forEach((prop) => {
    const value = config[prop];
    if (value <= 0) {
      errorMessage += `, ${prop} must be grater than zero but got ${value}`;
    }
  });
  if (config.duration < 0) {
    errorMessage += `, duration can't be negative, got ${config.duration}`;
  }
  if (config.clamp?.min && config.clamp?.max && config.clamp.min > config.clamp.max) {
    errorMessage += `, clamp.min should be lower than clamp.max`;
  }
  return errorMessage === "";
}

function safeMergeConfigs(defaults: any, userConfig?: any): any {
  if (!userConfig) {
    return defaults;
  }
  const filtered = Object.fromEntries(Object.entries(userConfig).filter(([, v]) => v !== undefined));
  return { ...defaults, ...filtered };
}

function bisectRoot({
  min,
  max,
  func,
  precision,
  maxIterations = 20,
}: {
  min: number;
  max: number;
  func: (x: number) => number;
  precision: number;
  maxIterations?: number;
}) {
  const direction = func(max) >= func(min) ? 1 : -1;
  let idx = maxIterations;
  let current = (max + min) / 2;
  while (Math.abs(func(current)) > precision && idx > 0) {
    idx -= 1;
    if (func(current) * direction < 0) {
      min = current;
    } else {
      max = current;
    }
    current = (min + max) / 2;
  }
  return current;
}

function initialCalculations(stiffness = 0, config: any): { zeta: number; omega0: number; omega1: number } {
  if (config.skipAnimation) {
    return { zeta: 0, omega0: 0, omega1: 0 };
  }
  if (config.useDuration) {
    const { mass: m, dampingRatio: zeta } = config;
    const omega0 = Math.sqrt(stiffness / m);
    const omega1 = zeta < 1 ? omega0 * Math.sqrt(1 - zeta ** 2) : 0;
    return { zeta, omega0, omega1 };
  } else {
    const { damping: c, mass: m, stiffness: k } = config;
    const zeta = c / (2 * Math.sqrt(k * m));
    const omega0 = Math.sqrt(k / m);
    const omega1 = zeta < 1 ? omega0 * Math.sqrt(1 - zeta ** 2) : 0;
    return { zeta, omega0, omega1 };
  }
}

function getEnergy(displacement: number, velocity: number, stiffness: number, mass: number) {
  const potentialEnergy = 0.5 * stiffness * displacement ** 2;
  const kineticEnergy = 0.5 * mass * velocity ** 2;
  return potentialEnergy + kineticEnergy;
}

function calculateNewStiffnessToMatchDuration(x0: number, config: any, v0: number) {
  if (config.skipAnimation) {
    return 0;
  }
  const { dampingRatio: zeta, energyThreshold: threshold, mass: m, duration: targetDuration } = config;
  const energyDiffForStiffness = (stiffness: number) => {
    const perceptualCoefficient = 1.5;
    const MILLISECONDS_IN_SECOND = 1000;
    const settlingDuration = (targetDuration * perceptualCoefficient) / MILLISECONDS_IN_SECOND;
    const omega0 = Math.sqrt(stiffness / m) * zeta;
    const xtk = (x0 + (v0 + x0 * omega0) * settlingDuration) * Math.exp(-omega0 * settlingDuration);
    const vtk =
      (x0 + (v0 + x0 * omega0) * settlingDuration) * Math.exp(-omega0 * settlingDuration) * -omega0 +
      (v0 + x0 * omega0) * Math.exp(-omega0 * settlingDuration);
    const e0 = getEnergy(x0, v0, stiffness, m);
    const etk = getEnergy(xtk, vtk, stiffness, m);
    const energyFraction = etk / e0;
    return energyFraction - threshold;
  };
  const precision = config.energyThreshold * 1e-3;
  return bisectRoot({ min: Number.EPSILON, max: 8e3, func: energyDiffForStiffness, precision, maxIterations: 100 });
}

export function criticallyDampedSpringCalculations(
  animation: any,
  precalculatedValues: { v0: number; x0: number; omega0: number; t: number }
): { position: number; velocity: number } {
  const { toValue } = animation;
  const { v0, x0, omega0, t } = precalculatedValues;
  const criticallyDampedEnvelope = Math.exp(-omega0 * t);
  const criticallyDampedPosition = toValue + criticallyDampedEnvelope * (x0 + (v0 + omega0 * x0) * t);
  const criticallyDampedVelocity =
    criticallyDampedEnvelope * -omega0 * (x0 + (v0 + omega0 * x0) * t) + criticallyDampedEnvelope * (v0 + omega0 * x0);
  return { position: criticallyDampedPosition, velocity: criticallyDampedVelocity };
}

export function underDampedSpringCalculations(
  animation: any,
  precalculatedValues: { zeta: number; v0: number; x0: number; omega0: number; omega1: number; t: number }
): { position: number; velocity: number } {
  const { toValue } = animation;
  const { zeta, t, omega0, omega1, x0, v0 } = precalculatedValues;
  const sin1 = Math.sin(omega1 * t);
  const cos1 = Math.cos(omega1 * t);
  const underDampedEnvelope = Math.exp(-zeta * omega0 * t);
  const underDampedFrag1 = underDampedEnvelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
  const underDampedPosition = toValue + underDampedFrag1;
  const underDampedVelocity =
    -zeta * omega0 * underDampedFrag1 + underDampedEnvelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1);
  return { position: underDampedPosition, velocity: underDampedVelocity };
}

function isAnimationTerminatingCalculation(animation: any, config: any): boolean {
  const { toValue, velocity, startValue, current, initialEnergy } = animation;
  if (config.overshootClamping) {
    const leftBound = startValue >= 0 ? toValue : toValue + startValue;
    const rightBound = leftBound + Math.abs(startValue);
    if (current < leftBound || current > rightBound) {
      return true;
    }
  }
  const currentEnergy = getEnergy(toValue - current, velocity, config.stiffness, config.mass);
  return initialEnergy === 0 || currentEnergy / initialEnergy <= config.energyThreshold;
}

// withSpring(toValue, userConfig) for a number, as defineAnimation's
// factory builds it (spring.ts). No `clamp` support (scaleZetaToMatchClamps)
// — toolbox never emits one.
export function withSpring(toValue: number, userConfig?: any): any {
  const defaultConfig = {
    ...GentleSpringConfig,
    ...GentleSpringConfigWithDuration,
    overshootClamping: false,
    energyThreshold: 6e-9,
    velocity: 0,
    reduceMotion: undefined,
    clamp: undefined,
  };
  const config = safeMergeConfigs(
    { ...defaultConfig, useDuration: !!(userConfig?.duration || userConfig?.dampingRatio), skipAnimation: false },
    userConfig
  );
  config.skipAnimation = !checkIfConfigIsValid(config);
  if (config.duration === 0) {
    config.skipAnimation = true;
  }
  if (config.clamp !== undefined) throw new Error("transcription: clamp is not transcribed");

  function springOnFrame(animation: any, now: number): boolean {
    const { toValue, current } = animation;
    if (config.skipAnimation) {
      animation.current = toValue;
      animation.lastTimestamp = 0;
      return true;
    }
    const { lastTimestamp, velocity } = animation;
    const deltaTime = Math.min(Math.max(now - lastTimestamp, 0), 64);
    animation.lastTimestamp = now;
    const t = deltaTime / 1000;
    const v0 = velocity as number;
    const x0 = current - toValue;
    const { zeta, omega0, omega1 } = animation;
    const { position: newPosition, velocity: newVelocity } =
      zeta < 1
        ? underDampedSpringCalculations(animation, { zeta, v0, x0, omega0, omega1, t })
        : criticallyDampedSpringCalculations(animation, { v0, x0, omega0, t });
    animation.current = newPosition;
    animation.velocity = newVelocity;
    if (isAnimationTerminatingCalculation(animation, config)) {
      animation.velocity = 0;
      animation.current = toValue;
      animation.lastTimestamp = 0;
      return true;
    }
    return false;
  }

  // onStart without a previous animation (the only start toolbox emits).
  function onStart(animation: any, value: number, now: number, previousAnimation: any): void {
    if (previousAnimation) throw new Error("transcription: interrupted springs are not transcribed");
    animation.current = value;
    let stiffness = config.stiffness;
    const duration = config.duration;
    const x0 = value - animation.toValue;
    animation.startValue = x0;
    animation.velocity = config.velocity || 0;
    const toValueNum = Number(animation.toValue);
    if ((toValueNum > value && animation.velocity < 0) || (toValueNum < value && animation.velocity > 0)) {
      animation.velocity = 0;
    }
    if (config.useDuration) {
      const actualDuration = duration;
      config.duration = actualDuration;
      stiffness = calculateNewStiffnessToMatchDuration(x0, config, animation.velocity);
      config.stiffness = stiffness;
    }
    const { zeta, omega0, omega1 } = initialCalculations(stiffness, config);
    animation.zeta = zeta;
    animation.omega0 = omega0;
    animation.omega1 = omega1;
    const initialEnergy = getEnergy(x0, config.velocity, config.stiffness, config.mass);
    animation.initialEnergy = initialEnergy;
    animation.lastTimestamp = now;
    animation.startTimestamp = now;
  }

  return {
    onFrame: springOnFrame,
    onStart,
    toValue,
    velocity: config.velocity || 0,
    current: toValue,
    startValue: 0,
    lastTimestamp: 0,
    startTimestamp: 0,
    zeta: 0,
    omega0: 0,
    omega1: 0,
    initialEnergy: 0,
  };
}
