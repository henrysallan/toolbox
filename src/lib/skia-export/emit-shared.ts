// Source text shared by both React Native Skia emitters (emit.ts for an
// SkSL Shader node, scene-emit.ts for a Skia Canvas scene), so the two
// bundles keep one clock and one timeline header.

export interface EmitTimeline {
  fps: number;
  ticksPerFrame: number;
  durationTicks: number;
}

export function durationSecOf(t: EmitTimeline): number {
  return t.durationTicks / (t.fps * t.ticksPerFrame);
}

// `export const TIMELINE = {…}` exactly as M0 writes it.
export function timelineConstSource(t: EmitTimeline): string {
  return `\nexport const TIMELINE = {\n  fps: ${t.fps},\n  ticksPerFrame: ${t.ticksPerFrame},\n  durationTicks: ${t.durationTicks},\n  durationSec: ${JSON.stringify(durationSecOf(t))},\n} as const;\n`;
}

// useToolboxClock(): the master clock, in the component module (it reads
// TIMELINE.durationSec, which the component imports from ./timeline).
export function toolboxClockSource(): string {
  return (
    `\n// One master clock in seconds, advanced on the UI thread. \`loop\` wraps at\n// the toolbox scene length; pass playing=false to hold (and drive time.value\n// yourself — a gesture, a scroll position, withTiming to a marker).\n` +
    `export function useToolboxClock(opts: { playing?: boolean; loop?: boolean; start?: number } = {}) {\n` +
    `  const { playing = true, loop = true, start = 0 } = opts;\n` +
    `  const time = useSharedValue(start);\n` +
    `  useFrameCallback((frame) => {\n` +
    `    "worklet";\n` +
    `    const dt = (frame.timeSincePreviousFrame ?? 0) / 1000;\n` +
    `    const next = time.value + dt;\n` +
    `    time.value = loop ? next % TIMELINE.durationSec : Math.min(next, TIMELINE.durationSec);\n` +
    `  }, playing);\n` +
    `  return time;\n}\n`
  );
}
