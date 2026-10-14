// A frame-accurate stand-in for Reanimated 4.7's animation engine, for the
// native-mode gate (scripts/check-skia-native.mts; specdocs/101326_skia-
// target.md §3.5c). It runs a native export's emitted animation functions
// (animations.ts, bundled with "react-native-reanimated" aliased here) on a
// synthetic display clock and reports every value at every frame, so the
// drift between native mode and the worklet timeline is measured offline,
// under any clock (perfect 60 Hz, jittered vsync, other rates).
//
// Transcribed from react-native-reanimated 4.7.0 — src/valueSetter.ts,
// src/animation/{timing,delay,sequence,repeat}.ts and the number path of
// utilCommon.ts decorateAnimation (reduce motion off) — with the easing math
// from src/lib/skia-export/reanimated-easing.ts and lane C's withSpring
// transcription. native-drift.ts can swap the animations for Reanimated's
// REAL sources (skia-harness installed), and check-skia-native asserts the
// two play the same doubles; `parity:skia --bundle native*` runs the real
// Reanimated (web) on the same clock.
//
// Platform difference that matters: a fresh shared value's `_animation` is
// null on native (mutablesCommon.ts) but undefined on web (mutables.ts), and
// withSequence substitutes its own last step for an undefined previous
// animation.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReanimatedEasing, type ReanimatedEasingFactory, type ReanimatedEasingFunction } from "@/lib/skia-export/reanimated-easing";
import { withSpring as springTranscription } from "../fixtures/reanimated/spring-4.7";

type Anim = any;

export const Easing = ReanimatedEasing;

// ---- animations ------------------------------------------------------------------

export function withTiming(toValue: number, userConfig?: { duration?: number; easing?: ReanimatedEasingFunction | ReanimatedEasingFactory }, callback?: (f: boolean) => void): any {
  const config: { duration: number; easing: ReanimatedEasingFunction | ReanimatedEasingFactory } = {
    duration: 300,
    easing: Easing.inOut(Easing.quad),
  };
  if (userConfig) for (const k of Object.keys(userConfig) as (keyof typeof config)[]) (config as any)[k] = (userConfig as any)[k];
  function timing(animation: Anim, now: number): boolean {
    const { toValue, startTime, startValue } = animation;
    const runtime = now - startTime;
    if (runtime >= config.duration) {
      animation.startTime = 0;
      animation.current = toValue;
      return true;
    }
    const progress = animation.easing(runtime / config.duration);
    animation.current = startValue + (toValue - startValue) * progress;
    return false;
  }
  function onStart(animation: Anim, value: number, now: number, previousAnimation: Anim): void {
    if (previousAnimation && previousAnimation.type === "timing" && previousAnimation.toValue === toValue && previousAnimation.startTime) {
      animation.startTime = previousAnimation.startTime;
      animation.startValue = previousAnimation.startValue;
    } else {
      animation.startTime = now;
      animation.startValue = value;
    }
    animation.current = value;
    animation.easing = typeof config.easing === "object" ? config.easing.factory() : config.easing;
  }
  return { type: "timing", onFrame: timing, onStart, progress: 0, toValue, startValue: 0, startTime: 0, easing: () => 0, current: toValue, callback };
}

export function withDelay(delayMs: number, nextAnimation: Anim): any {
  function delay(animation: Anim, now: number): boolean {
    const { startTime, started, previousAnimation } = animation;
    const current = animation.current;
    if (now - startTime >= delayMs) {
      if (!started) {
        nextAnimation.onStart(nextAnimation, current, now, previousAnimation);
        animation.previousAnimation = null;
        animation.started = true;
      }
      const finished = nextAnimation.onFrame(nextAnimation, now);
      animation.current = nextAnimation.current;
      return finished;
    } else if (previousAnimation) {
      const finished = previousAnimation.finished || previousAnimation.onFrame(previousAnimation, now);
      animation.current = previousAnimation.current;
      if (finished) animation.previousAnimation = null;
    }
    return false;
  }
  function onStart(animation: Anim, value: number, now: number, previousAnimation: Anim): void {
    animation.startTime = now;
    animation.started = false;
    animation.current = value;
    animation.previousAnimation = previousAnimation === animation ? previousAnimation.previousAnimation : previousAnimation;
  }
  return {
    isHigherOrder: true,
    onFrame: delay,
    onStart,
    current: nextAnimation.current,
    callback: (f?: boolean) => nextAnimation.callback?.(f),
    previousAnimation: null,
    startTime: 0,
    started: false,
  };
}

export function withSequence(...input: Anim[]): any {
  const animations = input.map((a) => {
    const r = typeof a === "function" ? a() : a;
    r.finished = false;
    return r;
  });
  function sequence(animation: Anim, now: number): boolean {
    const currentAnim = animations[animation.animationIndex];
    const finished = currentAnim.onFrame(currentAnim, now);
    animation.current = currentAnim.current;
    if (finished) {
      if (currentAnim.callback) currentAnim.callback(true);
      currentAnim.finished = true;
      animation.animationIndex += 1;
      if (animation.animationIndex < animations.length) {
        const nextAnim = animations[animation.animationIndex];
        nextAnim.onStart(nextAnim, currentAnim.current, now, currentAnim);
        return false;
      }
      return true;
    }
    return false;
  }
  function onStart(animation: Anim, value: number, now: number, previousAnimation: Anim): void {
    animation.animationIndex = 0;
    if (previousAnimation === undefined) previousAnimation = animations[animations.length - 1];
    const currentAnimation = animations[animation.animationIndex];
    currentAnimation.onStart(currentAnimation, value, now, previousAnimation);
  }
  return { isHigherOrder: true, onFrame: sequence, onStart, animationIndex: 0, current: animations[0].current, callback: () => {} };
}

export function withRepeat(nextAnimation: Anim, numberOfReps = 2, reverse = false): any {
  function repeat(animation: Anim, now: number): boolean {
    const finished = nextAnimation.onFrame(nextAnimation, now);
    animation.current = nextAnimation.current;
    if (finished) {
      animation.reps += 1;
      if (nextAnimation.callback) nextAnimation.callback(true, animation.current);
      if (numberOfReps > 0 && animation.reps >= numberOfReps) return true;
      const startValue = reverse ? nextAnimation.current : animation.startValue;
      if (reverse) {
        nextAnimation.toValue = animation.startValue;
        animation.startValue = startValue;
      }
      nextAnimation.onStart(nextAnimation, startValue, now, nextAnimation.previousAnimation);
      return false;
    }
    return false;
  }
  function onStart(animation: Anim, value: number, now: number, previousAnimation: Anim): void {
    animation.startValue = value;
    animation.reps = 0;
    nextAnimation.onStart(nextAnimation, value, now, previousAnimation);
  }
  return { isHigherOrder: true, onFrame: repeat, onStart, reps: 0, current: nextAnimation.current, callback: () => {}, startValue: 0 };
}

// withSpring: lane C's transcription (scripts/fixtures/reanimated/spring-
// 4.7.ts), which starts from rest only. Inside a sequence a spring always
// gets a previous animation, but every one the native export can hand it —
// a finished step (a spring resets velocity and lastTimestamp to 0 when it
// rests), a timing / delay (no velocity, no lastTimestamp), or on web a
// sequence's fresh last step — makes Reanimated's onStart take the
// from-rest path: velocity (prev.velocity + 0) || 0 = 0, lastTimestamp =
// prev.lastTimestamp || now = now, not "triggered twice". Anything else
// throws rather than simulate a start this file doesn't model.
export function withSpring(toValue: number, userConfig?: any): any {
  const a = springTranscription(toValue, userConfig);
  const baseOnStart = a.onStart;
  a.onStart = (animation: Anim, value: number, now: number, previousAnimation: Anim) => {
    if (previousAnimation && (previousAnimation.lastTimestamp || previousAnimation.velocity)) {
      throw new Error("reanimated-sim: a spring started over a moving animation (not modelled)");
    }
    baseOnStart(animation, value, now, undefined);
  };
  return a;
}

export function cancelAnimation(): void {
  throw new Error("reanimated-sim: cancelAnimation is not simulated");
}
export function useSharedValue(): never {
  throw new Error("reanimated-sim: hooks are not simulated — call the *Animation() functions");
}
export const useDerivedValue = useSharedValue;
export const useFrameCallback = useSharedValue;

// ---- the display clock + valueSetter ------------------------------------------------

export interface SimClock {
  fps: number;
  // performance.now() at play() (the fake clock's t0).
  t0?: number;
  // Uniform vsync jitter, ± ms per frame (deterministic per frame and seed).
  jitterMs?: number;
  seed?: number;
}

// The same deterministic per-frame jitter the harness's fake clock uses.
export function jitter01(frame: number, seed: number): number {
  let a = (Math.imul(frame, 0x9e3779b1) ^ seed) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function frameTime(c: SimClock, f: number): number {
  const t0 = c.t0 ?? 10_000;
  const j = c.jitterMs && f > 0 ? c.jitterMs * (2 * jitter01(f, c.seed ?? 1) - 1) : 0;
  return t0 + (f * 1000) / c.fps + j;
}

// One shared value from play(): `sv.value = initial; sv.value = animation`
// at frame 0, then one step per display frame. Returns the value after each
// frame 0..frames-1. platform "web" starts the value with _animation
// undefined (React Native web), "native" with null.
export function simulate(make: () => any, initial: number, frames: number, clock: SimClock, platform: "web" | "native" = "native"): number[] {
  const mutable: { _value: number; _animation: any } = { _value: initial, _animation: platform === "web" ? undefined : null };
  let queue: ((ts: number) => void)[] = [];
  const set = (value: any, now: number) => {
    const previousAnimation = mutable._animation;
    if (previousAnimation) {
      mutable._animation = null;
      if (!previousAnimation.finished) {
        previousAnimation.cancelled = true;
        previousAnimation.callback?.(false);
      }
    }
    if (typeof value === "object" && value !== null && value.onFrame !== undefined && value.onStart !== undefined) {
      const animation = value;
      if (mutable._value === animation.current && !animation.isHigherOrder) {
        animation.callback?.(true);
        return;
      }
      animation.onStart(animation, mutable._value, now, previousAnimation);
      const step = (timestamp: number) => {
        if (animation.cancelled) return;
        const finished = animation.onFrame(animation, timestamp);
        animation.timestamp = timestamp;
        mutable._value = animation.current;
        if (finished) {
          animation.finished = true;
          animation.callback?.(true);
        } else queue.push(step);
      };
      mutable._animation = animation;
      step(now);
    } else if (mutable._value !== value) {
      mutable._value = value;
    }
  };
  const out: number[] = [];
  const t0 = frameTime(clock, 0);
  set(initial, t0);
  set(make(), t0);
  out.push(mutable._value);
  for (let f = 1; f < frames; f++) {
    const ts = frameTime(clock, f);
    const q = queue;
    queue = [];
    for (const cb of q) cb(ts);
    out.push(mutable._value);
  }
  return out;
}
