export const socketColor: Record<string, string> = {
  image: "#60a5fa",
  mask: "#f472b6",
  uv: "#34d399",
  vector: "#f97316",
  scalar: "#facc15",
  vec2: "#a78bfa",
  vec3: "#a78bfa",
  vec4: "#a78bfa",
  spline: "#22d3ee",
  points: "#fb923c",
  audio: "#ec4899",
  // Image groups reuse the image hue but shift darker so a grouped
  // wire reads as related-but-distinct from a single image. Spline
  // and points no longer have a distinct group type — they carry
  // groupIndex metadata on the base value.
  image_group: "#1d4ed8",
};

export function colorForSocket(type: string): string {
  return socketColor[type] ?? "#9ca3af";
}
