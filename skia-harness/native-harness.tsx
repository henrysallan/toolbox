// The native-mode slots (specdocs/101326_skia-target.md §3.5c): bundles
// exported with `animation: "native"` own their animations
// (useToolboxAnimations) instead of reading a master clock, so the harness
// can't freeze time by setting a value. On the web with ?clock=fake
// (fake-clock.ts) it steps Reanimated's own clock instead, one 60 Hz frame
// at a time from play(), and records every animated value at every frame:
//
//   window.__toolboxHarness.capture(t)  step to frame round(t·fps), snapshot
//                                       (t must not go backwards)
//   window.__toolboxHarness.values()    every value at frames 0..current
//   window.__toolboxHarness.drift()     those values vs the worklet-mode
//                                       curves (evaluateTrack on TRACKS)
//
// Without ?clock=fake (a device, or `npm --prefix skia-harness run web`) it
// just plays, looping.
import React, { useEffect, useRef } from "react";
import { PixelRatio, StyleSheet, Text, View } from "react-native";
import { useCanvasRef, type CanvasRef } from "react-native-skia";
import type { SharedValue } from "react-native-reanimated";
import { fakeClock } from "./fake-clock";
import { nextFrames, snapshot, toBase64 } from "./capture";

type Value = number | number[];

export interface NativeBundle {
  NAME: string;
  TIMELINE: { fps: number; ticksPerFrame: number; durationTicks: number; durationSec: number };
  CANVAS: { width: number; height: number };
  TRACKS: Record<string, unknown>;
  useToolboxAnimations(opts?: { autoplay?: boolean; loop?: boolean }): {
    values: object;
    play(opts?: { loop?: boolean }): void;
    stop(): void;
  };
  ToolboxEffect: React.ComponentType<{
    animations: never;
    width: number;
    height: number;
    canvasRef?: React.Ref<CanvasRef>;
  }>;
  // The bundle's own runtime (./toolbox-timeline), for drift().
  evaluateTrack(track: never, tick: number): Value;
}

interface DriftRow {
  key: string;
  kind: "scalar" | "color" | "clock";
  // max |native − worklet| (colors: over r, g, b, a, in 0..1).
  maxAbs: number;
  maxAt: number;
  // The worklet value's range over the run (0 for a constant).
  range: number;
  // Frames whose value differs at all / by more than 1e-9 / and of those,
  // how many equal the worklet value one frame EARLIER (a one-frame lag).
  framesDiffer: number;
  framesOff: number;
  lagOne: number;
}

export function NativeHarness({ bundle, chrome }: { bundle: NativeBundle; chrome: boolean }) {
  const clock = fakeClock();
  const canvasRef = useCanvasRef();
  const anim = bundle.useToolboxAnimations({ autoplay: true, loop: !clock });
  const animRef = useRef(anim);
  animRef.current = anim;
  const sizePx = Number(new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("size") ?? bundle.CANVAS.width);
  const sizePt = sizePx / PixelRatio.get();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fps = bundle.TIMELINE.fps;
    const series: Record<string, Value[]> = {};
    // Seconds since play() at each recorded frame (the fake clock's own
    // time, jitter included): the worklet master clock would show the same.
    const times: number[] = [];
    const record = (frame: number) => {
      if (clock) times[frame] = (clock.now() - clock.t0) / 1000;
      const values = animRef.current.values as Record<string, SharedValue<Value>>;
      for (const [k, sv] of Object.entries(values)) {
        const v = sv.value;
        (series[k] ??= [])[frame] = Array.isArray(v) ? [...v] : v;
      }
    };
    const drift = (): DriftRow[] => {
      const tpf = bundle.TIMELINE.ticksPerFrame;
      return Object.entries(series).map(([key, vals]) => {
        const track = bundle.TRACKS[key];
        const kind: DriftRow["kind"] = !track ? "clock" : Array.isArray(vals[0]) ? "color" : "scalar";
        const secondsAt = (f: number) => times[f] ?? f / fps;
        const tickAt = (f: number) => {
          const tick = secondsAt(f) * fps * tpf;
          const r = Math.round(tick);
          return Math.abs(tick - r) < 1e-6 ? r : tick; // ticksAt
        };
        const ref = (f: number): Value => (track ? bundle.evaluateTrack(track as never, tickAt(f)) : secondsAt(f));
        const diff = (a: Value, b: Value) =>
          Array.isArray(a) && Array.isArray(b) ? Math.max(...a.map((x, i) => Math.abs(x - b[i]))) : Math.abs((a as number) - (b as number));
        let maxAbs = 0;
        let maxAt = 0;
        let framesDiffer = 0;
        let framesOff = 0;
        let lagOne = 0;
        let lo = Infinity;
        let hi = -Infinity;
        vals.forEach((v, f) => {
          const r = ref(f);
          for (const x of Array.isArray(r) ? r : [r]) {
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
          const d = diff(v, r);
          if (d > 0) framesDiffer++;
          if (d > 1e-9) {
            framesOff++;
            if (f > 0 && diff(v, ref(f - 1)) <= 1e-9) lagOne++;
          }
          if (d > maxAbs) {
            maxAbs = d;
            maxAt = f;
          }
        });
        return { key, kind, maxAbs, maxAt, range: hi - lo, framesDiffer, framesOff, lagOne };
      });
    };
    let ready = false;
    (async () => {
      // play() starts its animations in a frame callback a frame or two
      // after mount (scheduleOnUI → requestAnimationFrame), at fake t0.
      await nextFrames(4);
      if (clock) record(clock.frame());
      ready = true;
    })();
    const w = window as unknown as Record<string, unknown>;
    w.__toolboxHarness = {
      name: bundle.NAME,
      timeline: bundle.TIMELINE,
      size: sizePx,
      native: true,
      async capture(t: number) {
        if (!clock) throw new Error("native capture needs ?clock=fake");
        for (let i = 0; i < 120 && !ready; i++) await nextFrames(1);
        const f = Math.round(t * fps);
        if (f < clock.frame()) throw new Error(`native capture can't go back in time (at frame ${clock.frame()}, asked ${f})`);
        await clock.advanceTo(f, record);
        const s = await snapshot(canvasRef);
        return { width: s.width, height: s.height, rgba: toBase64(s.rgba), attempts: s.attempts, frame: f };
      },
      values: () => ({ fps, frames: clock ? clock.frame() + 1 : 0, jitterMs: clock?.jitterMs ?? 0, times, series }),
      drift,
    };
    w.__toolboxHarnessReady = true;
  }, [bundle, canvasRef, clock, sizePx]);

  return (
    <View style={styles.root}>
      <bundle.ToolboxEffect animations={anim as never} width={sizePt} height={sizePt} canvasRef={canvasRef} />
      {chrome && (
        <Text style={styles.label}>
          {bundle.NAME} · toolbox export (Reanimated-native) · {bundle.TIMELINE.durationSec}s
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#111" },
  label: { color: "#bbb", marginTop: 12, fontSize: 12 },
});
