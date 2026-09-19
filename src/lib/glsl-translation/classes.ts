// Translation classes — which image-producing nodes can be fused into one
// GLSL Expression, and how (spec 091626_graph-to-glsl.md §1).
//
// This is agent guidance, deliberately kept OUT of the engine: nothing in
// src/engine imports it, exported apps never ship it, and a wrong class is a
// one-line data fix here rather than a node-file edit. The gate
// (scripts/check-glsl-translation.mts) fails when a visible node that emits
// an image (primary or aux) has no entry, so "unclassified" cannot happen
// silently — planTranslation still treats an unknown type as `opaque` and
// says so in its warnings.
//
// Classes:
//   pure       f(uv, params, inputs sampled at the SAME uv). Fuses by
//              composition — one hoisted helper per node.
//   gather     samples its inputs at OTHER uvs (displace: 1 tap, sharpen: 9,
//              blur: radius-driven). Fuses when the upstream is a function
//              (re-evaluate it at the offset uv) or a wired u_ sampler.
//   multipass  separable / pyramid / iterative on the GPU. A one-pass form
//              is an APPROXIMATION and the node doc must say which.
//   compiled   the engine already emits GLSL for it (SDF chain, Merge
//              stack). The agent should port the generated source.
//   stateful   feedback across frames (accumulators, simulations, video).
//              glsl-expression has no self-texture (081426 M3 unbuilt).
//   opaque     CPU / geometry / 3D / ML / element layout. Never fused;
//              its output becomes a wired input of the fused node.
//
// `taps` is the gather cost hint (evaluations of the upstream per pixel);
// "param" means it follows a radius-like param and the planner assumes 9.
// `time` marks nodes that read the clock without saying so in facts.reads.

export type TranslationClass =
  | "pure"
  | "gather"
  | "multipass"
  | "compiled"
  | "stateful"
  | "opaque";

export interface TranslationEntry {
  class: TranslationClass;
  // Slug under docs/nodes/ (e.g. "displace" → docs/nodes/displace.md).
  // Required by the gate for pure | gather | multipass once the node's doc
  // has been authored (M3); until then the planner points the agent at
  // get_node_source instead.
  doc?: string;
  taps?: number | "param";
  time?: boolean;
  // One sentence the planner echoes next to the node — the thing the agent
  // must know before reading anything else.
  note?: string;
}

export const FUSABLE_CLASSES: ReadonlySet<TranslationClass> = new Set([
  "pure",
  "gather",
  "multipass",
  "compiled",
]);

// Socket types that may cross the region boundary into the fused node.
// Image-like wires take one of the four `u_a..u_d` samplers; channel-like
// wires drive a GLSL channel socket (`<glsl>:in:<channelName>`) so the
// producer keeps driving the value at eval time.
export const IMAGE_LIKE_SOCKETS: ReadonlySet<string> = new Set(["image", "mask", "uv"]);
export const CHANNEL_LIKE_SOCKETS: ReadonlySet<string> = new Set([
  "scalar",
  "vec4",
  "color_ramp",
]);

export const TRANSLATION_CLASSES: Record<string, TranslationEntry> = {
  // ---- generators -----------------------------------------------------------
  "solid-color": { class: "pure", note: "One color() channel; alpha comes from the param, straight." },
  gradient: { class: "pure", note: "uv01 Y-UP already (the one node whose space matches v_uv); multipoint mode is a weighted sum over its points." },
  noise: { class: "pure", doc: "noise", note: "Port ONLY the branch `type` selects from NOISE_FS (11 algorithms); fBm/contrast/colorA-B wrap it. Looping uses loopEvolutionOffset — a circle in noise space, not a linear time." },
  lyapunov: { class: "pure", note: "Per-pixel iteration inside the shader; port LYAPUNOV_FS as is." },
  "texture-coordinate": { class: "pure", note: "Emits uv as RG; downstream consumers read it as a per-pixel warp." },
  "shape-cells": { class: "pure", time: true, note: "Grid of parametric shapes per cell — port SHAPE_CELLS_FS; the cell hash is the seed." },
  "image-source": { class: "opaque", note: "A texture. Wire it into u_a..u_d." },
  paint: { class: "opaque", note: "User-painted texture. Wire it in." },
  "image-generate": { class: "opaque", note: "Model-generated texture. Wire it in." },
  "video-source": { class: "stateful", note: "Decoded frames. Wire it in; time is the video's, not u_time." },
  "webcam-source": { class: "stateful", note: "Live capture. Wire it in." },
  "cube-3d-test": { class: "opaque" },
  text: { class: "opaque", note: "CPU rasterized glyphs. Wire the image in." },
  "audio-spectral": { class: "stateful", note: "FFT history texture. Wire it in." },
  "scene-render": { class: "opaque", note: "three.js render. Wire it in." },
  "ambient-occlusion-3d": { class: "opaque" },
  frame: { class: "opaque" },
  autolayout: { class: "opaque" },

  // ---- spline / point rasters (opaque: geometry in, pixels out) -------------
  circle: { class: "opaque", note: "Its aux:image is a CPU raster of a spline; if the graph only needs the disc, an SDF circle (compiled class) is the fusable equivalent." },
  rectangle: { class: "opaque" },
  line: { class: "opaque" },
  spiral: { class: "opaque" },
  cross: { class: "opaque" },
  polygon: { class: "opaque" },
  star: { class: "opaque" },
  arc: { class: "opaque" },
  wave: { class: "opaque" },
  arrow: { class: "opaque" },
  "spline-draw": { class: "opaque" },
  "svg-source": { class: "opaque" },
  cursor: { class: "stateful" },
  "image-trace": { class: "opaque" },
  "bezier-handles": { class: "opaque" },
  "spline-stroke": { class: "opaque" },
  "spline-fill": { class: "opaque" },
  "rasterize-spline": { class: "opaque", note: "Spline → pixels on the CPU/GPU raster path; wire its image in." },
  "spline-boolean": { class: "opaque" },
  "spline-morph": { class: "opaque" },
  "copy-to-points": { class: "opaque" },
  "points-on-path": { class: "opaque" },
  "point-labels": { class: "opaque" },
  "diffusion-curves": { class: "opaque", note: "Spline-seeded Jacobi relaxation — geometry in AND iterative." },
  "spline-flow-field": { class: "opaque" },
  "group-pick": { class: "opaque" },
  "bento-slice": { class: "opaque", note: "CPU slicing layout." },
  "adaptive-pixelate": { class: "multipass", taps: 4, note: "Quadtree passes; the fused form is a fixed-depth approximation." },
  "object-tracker": { class: "stateful" },
  "tracker-point": { class: "stateful" },
  "hand-tracker": { class: "stateful" },

  // ---- per-pixel color / tone (pure) ---------------------------------------
  "color-ramp": { class: "pure", note: "Declare a ramp() channel seeded from the node's stops; sample it with the same input channel (luma/r/g/b/a) the node uses. Ramp interpolation SPACE matters (091626_ramp-space-interp) — match `interp`/`space`." },
  posterize: { class: "pure" },
  threshold: { class: "pure" },
  "color-correction": { class: "pure" },
  "rgb-curves": { class: "pure", note: "One curve() channel per curve the node has (master + R/G/B); seed each from its points." },
  lut: { class: "opaque", note: "The .cube data lives in a param, unreachable from a GLSL channel; wire the node's OUTPUT in instead." },
  "color-space-transform": { class: "pure", note: "Port the matching matrices/transfer functions from color-space.ts." },
  keyer: { class: "pure", taps: 1, note: "Key + despill are per pixel; matte softening, if enabled, is a gather." },
  dither: { class: "pure", note: "Ordered/Bayer modes are pure; error-diffusion modes run on the CPU and do NOT translate — check `algorithm` first." },
  merge: { class: "pure", note: "Per-pixel blend of layers in order (straight-alpha over). Blend formulas are in BLEND_FS; each layer is an image input, so a 3-layer Merge alone uses 3 of the 4 samplers." },
  "glsl-expression": { class: "pure", note: "Already GLSL. Inline its body as a helper: rename its u_a..u_d to whatever you wired, re-declare its channels (names must not collide), keep its own helpers hoisted." },

  // ---- warps / inverse samplers (pure, 1 tap at a transformed uv) ----------
  transform: { class: "pure", taps: 1, note: "Inverse-sample: compute the source uv from the output uv (TRANSFORM_FS), then evaluate the upstream there. Rotation is degrees in the param, radians in the shader." },
  mirror: { class: "pure", taps: 1 },
  "polar-coords": { class: "pure", taps: 1 },
  pixelate: { class: "pure", taps: 1, note: "Quantize uv to the cell grid (aspect-aware), then evaluate upstream at the cell center." },
  array: { class: "gather", taps: "param", note: "Tiles/copies: one upstream evaluation per copy that covers the pixel." },

  // ---- gathers -------------------------------------------------------------
  displace: { class: "gather", doc: "displace", taps: 1, note: "Image branch only. Reads the map at v_uv, offsets in uv01 units (NOT canvas01), then samples the source once. Wrap mode matters at the edges." },
  "advect-image": { class: "gather", taps: 1, note: "Backward advection by a velocity image — one offset tap; the `steps` param multiplies taps." },
  "chromatic-aberration": { class: "gather", taps: 3, note: "Three taps (R,G,B) at radially scaled uvs." },
  sharpen: { class: "gather", taps: 9 },
  "edge-detect": { class: "gather", taps: 9 },
  "bevel-emboss": { class: "gather", taps: 9 },
  "vector-field": { class: "gather", taps: 4, note: "Image source: gradient from 4 taps. SDF source is the compiled class (buildVectorFieldSdfFS)." },
  "flow-obstacle": { class: "gather", taps: 4 },
  "flow-blur": { class: "gather", taps: "param", note: "Line-integral convolution along the flow: `steps` taps per side." },
  kuwahara: { class: "gather", taps: "param", note: "Radius² samples across 4 (or 8 anisotropic) sectors." },
  "liquid-glass": { class: "multipass", taps: 4 },
  "lens-flare": { class: "multipass", taps: 1, note: "Mostly per-pixel math; the ghost/streak passes are the multipass part." },
  stipple: { class: "multipass", taps: "param" },

  // ---- multipass (approximate in one pass, say so) --------------------------
  blur: { class: "multipass", doc: "blur", taps: "param", note: "Separable gaussian with radius-driven pass count. One-pass form: fixed N taps along both axes (N² evaluations) — keep the node instead when the upstream is itself a gather." },
  bloom: { class: "multipass", taps: "param", note: "Threshold → pyramid blur → add. One-pass form approximates the pyramid with a few wide taps." },
  "image-flow-field": { class: "multipass", taps: 9, note: "Structure tensor (gauss → tensor → eigen) — three passes." },
  "flow-bilateral": { class: "multipass", taps: "param", note: "Iterated bilateral along/across flow." },
  "shock-filter": { class: "multipass", taps: 9, note: "Iterated; `iterations` is the pass count." },
  "line-art": { class: "multipass", taps: 9, note: "Five passes (lum → FDoG across/along → threshold → combine)." },
  grain: { class: "multipass", taps: 1, note: "The `classic` mode is a pure hash-noise overlay; film/plate modes add blur passes." },
  ascii: { class: "multipass", taps: 1, note: "Cell average (downsample) + glyph atlas lookup; the atlas is a CPU texture — the fused form keeps the atlas as a wired input or draws glyphs procedurally." },
  datamosh: { class: "stateful" },

  // ---- SDF pipeline (compiled — the engine emits this GLSL already) ----------
  "sdf-rasterize": { class: "compiled", note: "compileSdf(root, mode) emits the fragment body; uniforms are the shape params. Fusable by pasting that body with values inlined." },
  "sdf-shade": { class: "compiled" },
  "sdf-bevel": { class: "compiled" },
  "sdf-to-mask": { class: "compiled" },
  "sdf-to-distance-image": { class: "compiled" },

  // ---- stateful (no feedback texture in glsl-expression) --------------------
  "simulation-start": { class: "stateful" },
  "simulation-end": { class: "stateful" },
  "particles-to-image": { class: "stateful" },
  "reaction-diffusion": { class: "stateful" },
  "swift-hohenberg": { class: "stateful" },
  "watercolor-ink": { class: "stateful" },
  physarum: { class: "stateful" },
  "fluid-simulator": { class: "stateful" },
  trails: { class: "stateful" },
  "behavioral-growth": { class: "stateful" },
  voronoi: { class: "opaque", note: "Cell geometry is computed on the CPU (readbacks); a pure Worley/cellular noise is the usual GLSL stand-in — an approximation, not a port." },

  // ---- ML / capture -----------------------------------------------------------
  "bg-remove": { class: "opaque" },
  "segment-anything": { class: "opaque" },
  "depth-anything": { class: "opaque" },
};

const UNCLASSIFIED: TranslationEntry = {
  class: "opaque",
  note: "Not in the translation table — treated as opaque (wired input).",
};

export function translationEntry(type: string): TranslationEntry {
  return TRANSLATION_CLASSES[type] ?? UNCLASSIFIED;
}

export function isClassified(type: string): boolean {
  return type in TRANSLATION_CLASSES;
}
