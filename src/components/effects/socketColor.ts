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
  // Group socket colors reuse the same hue as their inner type but
  // shift toward the dark end so the group and its elements read as
  // related-but-distinct.
  image_group: "#1d4ed8",
  spline_group: "#0891b2",
  points_group: "#c2410c",
};

export function colorForSocket(type: string): string {
  return socketColor[type] ?? "#9ca3af";
}
