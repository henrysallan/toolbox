// Native-mode drift, offline (specdocs/101326_skia-target.md §3.5c): load a
// native export's animations.ts against the Reanimated stand-in
// (reanimated-sim.ts), play every value on a synthetic display clock, and
// compare each frame with the worklet-mode value — evaluateTrack on the
// bundle's own TRACKS, which check-skia-export proves bit-identical to the
// editor. Used by check-skia-native; the same rows come out of the real
// Reanimated in `npm run parity:skia -- --bundle native*` (drift()).

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { simulate, type SimClock } from "./reanimated-sim";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

export interface NativeModuleHandle {
  mod: Record<string, any>;
  dispose(): void;
}

export const HARNESS_REANIMATED = path.join(ROOT, "skia-harness", "node_modules", "react-native-reanimated");

// The real Reanimated animation sources, when skia-harness is installed.
export function realReanimatedAvailable(): boolean {
  return fs.existsSync(path.join(HARNESS_REANIMATED, "src", "animation", "timing.ts"));
}

// Bundle the emitted files (animations.ts + toolbox-native.ts +
// toolbox-timeline.ts) with "react-native-reanimated" → the simulator, and
// import the result. reanimated "real": withTiming / withDelay /
// withSequence / withRepeat / withSpring / Easing are Reanimated 4.7's own
// source (skia-harness/node_modules), bundled with only `defineAnimation`
// (→ the bare factory: decoration is a pass-through for numbers with reduce
// motion off), `getReduceMotionForAnimation` and the logger stubbed — as
// check-spring-easing does. "transcription" (default): reanimated-sim.ts.
export async function loadNativeModule(
  files: Record<string, string>,
  opts: { reanimated?: "transcription" | "real" } = {}
): Promise<NativeModuleHandle> {
  const esbuild = await import("esbuild");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skia-native-"));
  let reanimated = path.join(HERE, "reanimated-sim.ts");
  if (opts.reanimated === "real") {
    const src = path.join(HARNESS_REANIMATED, "src");
    reanimated = path.join(dir, "real-reanimated.ts");
    fs.writeFileSync(
      reanimated,
      [
        `export { withTiming } from ${JSON.stringify(path.join(src, "animation/timing"))};`,
        `export { withDelay } from ${JSON.stringify(path.join(src, "animation/delay"))};`,
        `export { withSequence } from ${JSON.stringify(path.join(src, "animation/sequence"))};`,
        `export { withRepeat } from ${JSON.stringify(path.join(src, "animation/repeat"))};`,
        `export { withSpring } from ${JSON.stringify(path.join(src, "animation/spring/spring"))};`,
        `export { Easing } from ${JSON.stringify(path.join(src, "Easing"))};`,
        `export { cancelAnimation, useSharedValue, useDerivedValue, useFrameCallback } from ${JSON.stringify(path.join(HERE, "reanimated-sim.ts"))};`,
        "",
      ].join("\n")
    );
  }
  for (const f of ["animations.ts", "toolbox-native.ts", "toolbox-timeline.ts", "timeline.ts", "toolbox-clock.ts"]) {
    if (files[f] !== undefined) fs.writeFileSync(path.join(dir, f), files[f]);
  }
  fs.writeFileSync(
    path.join(dir, "entry.ts"),
    `export * from "./animations";\nexport { colorAt } from "./toolbox-native";\nexport { evaluateTrack } from "./toolbox-timeline";\n`
  );
  fs.writeFileSync(path.join(dir, "react-stub.ts"), `export const useCallback = () => { throw new Error("hook"); };\nexport const useEffect = useCallback;\nexport const useMemo = useCallback;\n`);
  fs.writeFileSync(
    path.join(dir, "worklets-stub.ts"),
    `export const scheduleOnUI = () => { throw new Error("scheduleOnUI"); };\nexport const scheduleOnRN = scheduleOnUI;\nexport const isWorkletFunction = () => false;\n`
  );
  const out = path.join(dir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [path.join(dir, "entry.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "error",
    define: { __DEV__: "false" },
    alias: {
      "react-native-reanimated": reanimated,
      react: path.join(dir, "react-stub.ts"),
      "react-native-worklets": path.join(dir, "worklets-stub.ts"),
      "@": path.join(ROOT, "src"),
    },
    plugins: [
      {
        name: "reanimated-stubs",
        setup(b) {
          // (node_modules may be a symlink: esbuild reports real paths.)
          const roots = fs.existsSync(HARNESS_REANIMATED) ? [HARNESS_REANIMATED, fs.realpathSync(HARNESS_REANIMATED)] : [];
          const inHarness = (p: string) => roots.some((r) => p.startsWith(r));
          b.onResolve({ filter: /^\.\.?\/util$/ }, (a) => (inHarness(a.importer) ? { path: "util", namespace: "rea-stub" } : undefined));
          b.onResolve({ filter: /^(\.\.\/)+common$/ }, (a) => (inHarness(a.importer) ? { path: "common", namespace: "rea-stub" } : undefined));
          b.onLoad({ filter: /.*/, namespace: "rea-stub" }, (a) => ({
            loader: "js",
            contents:
              a.path === "util"
                ? "export function defineAnimation(_s, factory) { return factory(); }\nexport function getReduceMotionForAnimation() { return undefined; }\nexport function assertEasingIsWorklet() {}\n"
                : "export const logger = { warn() {}, error() {} };\n",
          }));
        },
      },
    ],
  });
  const mod = await import(pathToFileURL(out).href);
  return { mod, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface NativeValueInfo {
  key: string;
  kind: "scalar" | "color";
  initial?: number;
  steps: { segment: number }[];
}

export interface DriftRow {
  key: string;
  kind: "scalar" | "color" | "clock";
  maxAbs: number;
  maxAt: number;
  range: number;
  framesDiffer: number;
  framesOff: number;
  lagOne: number;
}

const ident = (k: string) => k.replace(/[^A-Za-z0-9_$]/g, "_");

// Every native value (and the clock) at frames 0..frames-1 after play() —
// or, with `segment`, after playSegment(segment) (values start at
// SEGMENT_STARTS[segment], as the hook puts them).
export function playNative(
  mod: Record<string, any>,
  native: { values: NativeValueInfo[]; clock: string | null },
  frames: number,
  clock: SimClock,
  platform: "web" | "native" = "native",
  segment?: string
): Record<string, (number | number[])[]> {
  const series: Record<string, (number | number[])[]> = {};
  const starts = segment !== undefined ? mod.SEGMENT_STARTS[segment] : null;
  const run = (fn: any, seg: any, init: number) =>
    fn ? simulate(() => (segment !== undefined ? seg(segment, false) : fn(false)), init, frames, clock, platform) : new Array(frames).fill(init);
  for (const v of native.values) {
    if (v.kind === "scalar") {
      const init = starts ? starts[v.key] : (v.initial ?? 0);
      const fn = mod[`${ident(v.key)}Animation`];
      series[v.key] = run(fn, mod[`${ident(v.key)}SegmentAnimation`], init);
      continue;
    }
    const track = mod.TRACKS[v.key];
    const nSeg = track.keys.length - 1;
    const p: number[][] = [];
    for (let k = 0; k < nSeg; k++) {
      const init = starts ? starts[v.key][k] : track.keys[k + 1].tick <= 0 ? 1 : 0;
      const seg = mod[`${ident(v.key)}Progress${k}SegmentAnimation`];
      const fn = segment !== undefined ? seg : mod[`${ident(v.key)}Progress${k}Animation`];
      p.push(run(fn, seg, init));
    }
    series[v.key] = Array.from({ length: frames }, (_, f) => mod.colorAt(track, p.map((s) => s[f])));
  }
  if (native.clock) {
    series[native.clock] = run(mod[`${native.clock}Animation`], mod[`${native.clock}SegmentAnimation`], starts ? starts[native.clock] : 0);
  }
  return series;
}

// The harness's drift() rows (native-harness.tsx), from a series. The
// reference is the worklet-mode value at the same instant: by default the
// exact frame time f / fps; with `secondsAt` (a jittered clock) the time the
// device's frame actually carried, which is what the worklet master clock
// (useToolboxClock: the sum of frame deltas) would show there too.
export function driftRows(
  series: Record<string, (number | number[])[]>,
  tracks: Record<string, unknown>,
  evaluateTrack: (t: any, tick: number) => number | number[],
  timeline: { fps: number; ticksPerFrame: number },
  secondsAt: (f: number) => number = (f) => f / timeline.fps
): DriftRow[] {
  const tickAt = (f: number) => {
    const tick = secondsAt(f) * timeline.fps * timeline.ticksPerFrame;
    const r = Math.round(tick);
    return Math.abs(tick - r) < 1e-6 ? r : tick; // ticksAt
  };
  return Object.entries(series).map(([key, vals]) => {
    const track = tracks[key];
    const kind: DriftRow["kind"] = !track ? "clock" : Array.isArray(vals[0]) ? "color" : "scalar";
    const ref = (f: number) => (track ? evaluateTrack(track, tickAt(f)) : secondsAt(f));
    const diff = (a: number | number[], b: number | number[]) =>
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
}
