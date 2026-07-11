// Playback clock store — the master transport clock, held OUTSIDE React
// state so advancing it 60×/s doesn't re-render the whole editor shell.
// Design: specdocs/071026_clock-store.md.
//
// The rAF advancer (EffectsApp) writes through `playbackClock.set`;
// components read via `useClock(selector)` and re-render only when their
// selected value changes. `tick` is THE integer-tick derivation — the
// exact-equality keyframe model depends on it being computed in one place
// from (time × fps × ticksPerFrame).
//
// Offline export drivers bypass this entirely (they step time explicitly
// through renderFrame), same as before the store existed.

import { useSyncExternalStore } from "react";
import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";

export interface ClockState {
  // Seconds — the source of truth the rAF advancer moves.
  time: number;
  // Integer tick (round(time × fps × ticksPerFrame)) — safe for exact
  // equality against keyframe ticks.
  tick: number;
  // Integer frame (floor(time × fps)).
  frame: number;
  playing: boolean;
}

let fps = 60;
let ticksPerFrame = DEFAULT_TICKS_PER_FRAME;

function derive(time: number, playing: boolean): ClockState {
  return {
    time,
    tick: Math.round(time * fps * ticksPerFrame),
    frame: Math.floor(time * fps),
    playing,
  };
}

let state: ClockState = derive(0, false);
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

export const playbackClock = {
  get(): ClockState {
    return state;
  },
  set(partial: { time?: number; playing?: boolean }): void {
    const time = partial.time ?? state.time;
    const playing = partial.playing ?? state.playing;
    if (time === state.time && playing === state.playing) return;
    state = derive(time, playing);
    notify();
  },
  // Timing config lives here so `tick` derives in one place. EffectsApp
  // pushes fps changes; ticksPerFrame is constant today but plumbed for
  // symmetry.
  configure(cfg: { fps?: number; ticksPerFrame?: number }): void {
    const nextFps = cfg.fps ?? fps;
    const nextTpf = cfg.ticksPerFrame ?? ticksPerFrame;
    if (nextFps === fps && nextTpf === ticksPerFrame) return;
    fps = nextFps;
    ticksPerFrame = nextTpf;
    state = derive(state.time, state.playing);
    notify();
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

// Select a PRIMITIVE (time, tick, playing…) — an object selection would
// have a fresh identity every notify and re-render unconditionally. Use
// one useClock call per field instead.
export function useClock<T>(selector: (s: ClockState) => T): T {
  return useSyncExternalStore(
    playbackClock.subscribe,
    () => selector(playbackClock.get()),
    // SSR snapshot: the store's initial state (the editor is client-only
    // interactive; first paint at t=0 matches today's useState(0)).
    () => selector(playbackClock.get())
  );
}
