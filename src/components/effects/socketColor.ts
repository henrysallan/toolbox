export const socketColor: Record<string, string> = {
  image: "#60a5fa",
  mask: "#f472b6",
  scalar: "#facc15",
  vec2: "#a78bfa",
  vec3: "#a78bfa",
  vec4: "#a78bfa",
};

export function colorForSocket(type: string): string {
  return socketColor[type] ?? "#9ca3af";
}
