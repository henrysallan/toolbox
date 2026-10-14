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

// The bundle barrel's (index.ts) clock exports.
export const CLOCK_BARREL =
  `export {\n  useToolboxClock,\n  SEGMENTS,\n  MARKERS,\n  DURATION_SEC,\n  type ToolboxClock,\n  type ToolboxClockOptions,\n  type PlaySegmentOptions,\n  type SegmentName,\n  type MarkerName,\n} from "./toolbox-clock";\n`;

// useToolboxClock(): the master clock lives in its own generated module,
// toolbox-clock.ts (segments.ts clockModuleSource — SEGMENTS, MARKERS and
// the controls). The component module re-exports it, so app code importing
// the hook from the component keeps resolving.
export function toolboxClockSource(): string {
  return (
    `\n// The master clock and its controls (play, pause, seek, playSegment, …).\n` +
    `export {\n  useToolboxClock,\n  SEGMENTS,\n  MARKERS,\n  type ToolboxClock,\n  type ToolboxClockOptions,\n  type SegmentName,\n} from "./toolbox-clock";\n`
  );
}
