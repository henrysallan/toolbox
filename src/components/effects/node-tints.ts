// NOT THEMED, and must stay that way: a picked tint is PERSISTED onto the
// node (state/graph.ts `tint`), so these have to be literal hex. A
// var(--tb-…) here would be written into saved project files and would not
// resolve outside the editor. scripts/theme-scope.mts excludes this file.
//
// The 7 node tint presets (right-click menu) + the rgba helper shared by
// EffectNode / FrameNode / the context-menu swatches. Tailwind-400 register
// so tints read as siblings of the socket hues (socketColor.ts), applied at
// low alpha so a tinted node is never mistaken for a wire type. Spec:
// specdocs/archive/073026_node-cosmetics-and-frames.md.

export const NODE_TINTS: string[] = [
  "#f87171", // red
  "#fb923c", // orange
  "#a3e635", // lime
  "#34d399", // emerald
  "#38bdf8", // sky
  "#a78bfa", // violet
  "#f472b6", // pink
];

// Neutral hue frames fall back to before a tint is picked.
export const FRAME_NEUTRAL = "#94a3b8";

// 6-digit hex → rgba() string. Tints are preset-controlled so the parse is
// deliberately minimal (no 3/8-digit forms); malformed input falls back to
// a neutral grey rather than throwing mid-render.
export function tintRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(148, 163, 184, ${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}
