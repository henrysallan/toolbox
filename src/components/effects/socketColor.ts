// Wire/socket colours — one hue per socket type.
//
// THEMED, but only in lightness. A socket's identity is its HUE, so the hue
// is byte-identical in both modes; light mode just caps perceptual lightness
// at ~0.56 so a bright dark-mode yellow (#facc15, OKLCH L 0.86) doesn't turn
// into unreadable pale text on a white node. Light values are derived, not
// hand-picked — see specdocs/archive/080226_theme-modes.md.
//
// The dark column is exactly what the editor used before theming, so dark
// mode is unchanged.
//
// Adding a socket type? Invariant #7 in the devguide lists everywhere else
// that ripples; add the pair here and run `npm run gen:theme-css`.

export interface SocketColorPair {
  dark: string;
  light: string;
}

export const SOCKET_PALETTE: Record<string, SocketColorPair> = {
  image: { dark: "#60a5fa", light: "#2274cf" },
  mask: { dark: "#f472b6", light: "#c13185" },
  uv: { dark: "#34d399", light: "#009156" },
  vector: { dark: "#f97316", light: "#cb3d00" },
  scalar: { dark: "#facc15", light: "#9d6b00" },
  vec2: { dark: "#a78bfa", light: "#7c58d1" },
  vec3: { dark: "#a78bfa", light: "#7c58d1" },
  vec4: { dark: "#a78bfa", light: "#7c58d1" },
  spline: { dark: "#22d3ee", light: "#0089a6" },
  points: { dark: "#fb923c", light: "#be4e00" },
  audio: { dark: "#ec4899", light: "#c62c7c" },
  // Note wires (symbolic note events → instruments) — green, the classic
  // DAW MIDI-clip hue. Audio's pink stays the signal; notes read as the
  // "vector" side of that pipeline, well clear of string's lime-yellow and
  // uv's teal-leaning emerald.
  notes: { dark: "#4ade80", light: "#15803d" },
  // String wires — lime. A plain text value, distinct from scalar's pure
  // yellow and scalar_field's amber so a string signal reads as its own type.
  string: { dark: "#a3e635", light: "#4e8800" },
  // Image groups reuse the image hue but shift darker so a grouped
  // wire reads as related-but-distinct from a single image. Spline
  // and points no longer have a distinct group type — they carry
  // groupIndex metadata on the base value. Already dark enough for light
  // mode, so it's the one pair that doesn't move.
  image_group: { dark: "#1d4ed8", light: "#1d4ed8" },
  // List wires — sky blue. Sits in the widest free slice of the hue circle
  // (spline 212° → image 255°), which was free because the ramp type
  // deliberately passed on it. A list is a CONTAINER, so the neutral slate
  // treatment (like `render`) was tempting — but a list carries real data
  // through the graph, and slate reads as "organizational, ignore me".
  // Spec: 080526_list-socket.md.
  list: { dark: "#38bdf8", light: "#0079ab" },
  // Live text carrier (Text → Copy to Points) — fuchsia. A text-family
  // cousin of string's lime, but clearly its own pipeline: it holds a
  // style + variant strings, not a plain value.
  text_instance: { dark: "#e879f9", light: "#a83fb8" },
  // Particle-engine sockets. Forces and emitters are descriptor
  // socket types — distinct from data sockets, so warm-tinted to set
  // them apart from the cool image/spline pipeline.
  force: { dark: "#fda4af", light: "#ae5462" },
  emitter: { dark: "#fcd34d", light: "#996d00" },
  collider: { dark: "#fb7185", light: "#ca3153" },
  particles: { dark: "#f43f5e", light: "#cf2849" },
  // SDF wires — soft purple, distinct from vec2/3/4 lavender so a
  // distance-field signal reads as its own pipeline.
  sdf: { dark: "#c084fc", light: "#914ace" },
  // Position wires — green-cyan. Visually distinct from SDF and uv
  // (which is also green-ish but emerald): position is a "where to
  // sample" signal, paired with sdf as the "what to evaluate" signal.
  position: { dark: "#5eead4", light: "#008e79" },
  // Scalar field — yellow-amber, distinct from scalar's bright yellow
  // so users can tell at a glance whether a wire carries a single CPU
  // value or a per-pixel shader expression.
  scalar_field: { dark: "#eab308", light: "#a36700" },
  // Render reference wire (Output → Render Queue). Neutral slate — it's an
  // organizational link, not a data pipeline, so it shouldn't read as one
  // of the colorful signal types.
  render: { dark: "#94a3b8", light: "#66768c" },
  // Element wires (Auto Layout) — indigo, distinct from image blue and
  // the vec lavender: an intrinsically-sized renderable, not yet pixels.
  element: { dark: "#818cf8", light: "#5e63d9" },
  // 3D scene wires. object3d is a warm amber (a placed thing in the
  // scene); camera a cooler teal-green so the "which view" signal reads
  // distinctly from the scene contents.
  object3d: { dark: "#f59e0b", light: "#b55800" },
  camera: { dark: "#2dd4bf", light: "#008f7b" },
  // Geometry (raw mesh data in the modeling chain) — object3d's hue
  // shifted darker, the image/image_group "related but distinct"
  // treatment: not yet a placed thing, but the same pipeline.
  geometry: { dark: "#d97706", light: "#8f4f00" },
  // 3D points (world-space, Y-up) — the points family's orange shifted
  // deeper/redder. Related to 2D points at a glance, but its own wire:
  // the two deliberately never coerce (space differs — 081026 spec §2).
  points3d: { dark: "#c2410c", light: "#9c3a10" },
  // Instance streams (081026 spec §4.4) — fuchsia, a deliberate cousin of
  // text_instance's lighter fuchsia (both are "copies awaiting placement")
  // while staying clear of the 3D ambers and the vec lavenders.
  instances: { dark: "#d946ef", light: "#a21caf" },
  // 3D noise field (spec M6.5) — a darker cousin of scalar_field's amber:
  // both are "per-position scalar signal" wires; this one is the CPU/
  // world-space face.
  noise_field: { dark: "#ca8a04", light: "#8a5c00" },
  // 3D curve (spec M11) — spline's cyan shifted deeper, the same
  // related-but-distinct family treatment as points/points3d: a curve,
  // but living in world space.
  curve3d: { dark: "#0891b2", light: "#0e7490" },
  // Colour-ramp wires — coral. Sits in the widest free slice of the hue
  // circle (31° between particles at 16° and vector at 48°), so it reads
  // apart from both the pink-red particle descriptors and pure orange. The
  // wide blue gap (spline 212° → image 255°) was rejected on purpose:
  // rasterize-spline carries a spline input, an image output AND two ramp
  // params, so a blue ramp wire would be ambiguous on the very node that
  // wants it most. Spec: 080526_on-node-color-ramp.md.
  color_ramp: { dark: "#f87962", light: "#ca3a23" },
  // Transform wires (Gizmo → primitives / Transform) — cyan-300, a cousin
  // of spline's cyan the way points3d is of points. Spec: 082826_gizmo-node.md.
  transform: { dark: "#67e8f9", light: "#0e7490" },
};

/** Fallback for an unknown socket type — the neutral slate. */
export const SOCKET_FALLBACK: SocketColorPair = {
  dark: "#9ca3af",
  light: "#6b7280",
};

export const socketVar = (type: string): string => `--tb-s-${type}`;

/**
 * Socket colour for a DOM or SVG context — a `var(--tb-s-…)` reference, so it
 * tracks the theme without the caller re-rendering.
 *
 * NOT usable in a canvas 2D context: `var()` is CSS, and the 2D context would
 * silently paint black. Use {@link resolveSocketColor} there.
 */
export function colorForSocket(type: string): string {
  return SOCKET_PALETTE[type] ? `var(${socketVar(type)})` : `var(--tb-s-fallback)`;
}

/**
 * Socket colour as a concrete hex for the CURRENT theme — for canvas 2D
 * (SocketPeekPopover's spline/points previews). Reads the resolved custom
 * property so it can't drift from the DOM.
 */
export function resolveSocketColor(type: string): string {
  const pair = SOCKET_PALETTE[type] ?? SOCKET_FALLBACK;
  if (typeof document === "undefined") return pair.dark;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(SOCKET_PALETTE[type] ? socketVar(type) : "--tb-s-fallback")
    .trim();
  return v || pair.dark;
}

/**
 * Back-compat view: socket type → the DOM colour reference. Kept because
 * callers indexed this map directly before the theme layer landed.
 */
export const socketColor: Record<string, string> = Object.fromEntries(
  Object.keys(SOCKET_PALETTE).map((t) => [t, colorForSocket(t)])
);
