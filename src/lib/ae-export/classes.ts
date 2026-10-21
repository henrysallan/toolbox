// After Effects exportability classes — every registered node type on one
// rung of the §3 ladder (spec 091926_after-effects-handoff.md §3).
//
// Lib-level guidance like src/lib/glsl-translation/classes.ts: nothing in
// src/engine or src/nodes imports it, exported apps never ship it, and a
// wrong class is a one-line data fix here. scripts/ae-export/check-classes.mts
// fails when a visible node type has no entry, when an entry names an
// unregistered type, or when the `shader` rung disagrees with the GLSL
// translation table. planAeExport (plan.ts) refines these per node from the
// node's params (gradient mode, blend modes, stroke sources…); this table is
// the static default.
//
// Conventions for `ae`:
//   "ADBE …" / "VISINF …" / "Keylight 906"  an effect match name
//   "shape:<kind>"   an AeShapeItem kind inside a shape layer's contents
//   "layer:<kind>"   an AeLayerKind (layer:null for gizmos, layer:footage for bakes)
//   "mask:path"      an AeMask on the consuming layer
//   "expression"     AE expression text on the driven property
//   TBX_SHADER_MATCH_NAME   the Toolbox Shader host (§7.3)
//
// Fidelity on the `shader` rung: "exact" means the parity loop converges on
// the node's math; `multipass` GLSL nodes are "approx" because their fused
// form is a one-pass approximation (the GLSL docs name it).

import { TRANSLATION_CLASSES } from "@/lib/glsl-translation/classes";
import type { AeBlendMode, AeExportEntry } from "./types";
import { TBX_SHADER_MATCH_NAME } from "./types";

// ---- shared entries ----------------------------------------------------------

const HOST = TBX_SHADER_MATCH_NAME;

const shader = (note?: string): AeExportEntry => ({
  class: "shader",
  ae: HOST,
  fidelity: "exact",
  requires: ["host"],
  ...(note ? { note } : {}),
});
const shaderApprox = (note: string): AeExportEntry => ({
  class: "shader",
  ae: HOST,
  fidelity: "approx",
  requires: ["host"],
  note,
});
const bake = (note: string): AeExportEntry => ({
  class: "bake",
  ae: "layer:footage",
  fidelity: "bake",
  requires: ["footage"],
  note,
});
const value = (note?: string): AeExportEntry => ({
  class: "expression",
  ae: "expression",
  fidelity: "exact",
  ...(note ? { note } : {}),
});
const sampledValue = (note: string): AeExportEntry => ({
  class: "expression",
  ae: "expression",
  fidelity: "sampled",
  note,
});
const path = (note?: string, params?: Record<string, string>): AeExportEntry => ({
  class: "vector",
  ae: "shape:path",
  fidelity: "exact",
  ...(note ? { note } : {}),
  ...(params ? { params } : {}),
});
const sampledPath = (note?: string): AeExportEntry => ({
  class: "vector",
  ae: "shape:path",
  fidelity: "sampled",
  note:
    note ??
    "Exported as the evaluated path. Static → exact; animated → path keys per frame, which need a constant anchor count (resample) or the segment bakes.",
});
const live = (what: string): AeExportEntry => ({
  class: "unsupported",
  fidelity: "bake",
  requires: ["footage"],
  note: `${what} — record a take (it then bakes) or replace it with keyframes.`,
});
const instances = (note: string, fidelity: AeExportEntry["fidelity"] = "exact"): AeExportEntry => ({
  class: "instances",
  fidelity,
  note,
});

const TRIM = "trim_start/trim_end → Trim Paths Start/End ·100 %, trim_offset → Offset ·360°";
const STROKE = "stroke_thickness → Stroke Width (px pass through; % → ·W/100), stroke_color → Color (0–1 RGB)";
const RADIUS_PX = "width-relative → ·W px on both axes (§4.1)";

const SKIA_NOTE = "Skia-layer node (CanvasKit, not the engine's GL): bake the Skia layer, or port the default-layer node it mirrors.";
const AUDIO_NOTE = "Audio has no visual effect: the mixdown ships as a WAV footage layer (or is dropped).";
const MESH_NOTE = "3D geometry: baked with the Scene Render it feeds (re-importing the GLB natively in AE 24.1+ is M4).";
const SIM_INPUT_NOTE = "Simulation input: baked with the particle / matter simulation it feeds.";

// Skia-layer types (spec 101326_skia-target.md) — one rule for all of them.
const SKIA_LAYER_TYPES = [
  "skia-array",
  "skia-bake",
  "skia-bevel-emboss",
  "skia-bloom",
  "skia-blur",
  "skia-canvas",
  "skia-chromatic-aberration",
  "skia-circle",
  "skia-color-correction",
  "skia-color-matrix",
  "skia-color-ramp",
  "skia-color-space-transform",
  "skia-copy-to-points",
  "skia-dash",
  "skia-displace",
  "skia-dither",
  "skia-drop-shadow",
  "skia-edge-detect",
  "skia-fill",
  "skia-flow-blur",
  "skia-gradient",
  "skia-gradient-fill",
  "skia-grain",
  "skia-group",
  "skia-image",
  "skia-keyer",
  "skia-kuwahara",
  "skia-lens-flare",
  "skia-line",
  "skia-lyapunov",
  "skia-merge",
  "skia-mirror",
  "skia-morphology",
  "skia-noise",
  "skia-pixelate",
  "skia-polar-coords",
  "skia-posterize",
  "skia-rect",
  "skia-rgb-curves",
  "skia-round-corners",
  "skia-sdf-bevel",
  "skia-sdf-rasterize",
  "skia-sdf-shade",
  "skia-sdf-to-distance-image",
  "skia-sdf-to-mask",
  "skia-shape",
  "skia-shape-cells",
  "skia-sharpen",
  "skia-sksl-filter",
  "skia-solid-color",
  "skia-spline-fill",
  "skia-stroke",
  "skia-text",
  "skia-texture-coordinate",
  "skia-threshold",
  "skia-transform",
  "skia-trim-path",
  "skia-vector-field",
] as const;

const AUDIO_TYPES = [
  "audio-bitcrusher",
  "audio-channel",
  "audio-chorus",
  "audio-compressor",
  "audio-crossfade",
  "audio-delay",
  "audio-distortion",
  "audio-eq3",
  "audio-filter",
  "audio-fm-synth",
  "audio-lfo",
  "audio-limiter",
  "audio-merge",
  "audio-noise",
  "audio-oscillator",
  "audio-phaser",
  "audio-player",
  "audio-reverb",
  "audio-sampler",
  "audio-step-pattern",
  "audio-synth",
  "audio-transpose",
  "midi-editor",
] as const;

const MESH_TYPES = [
  "align-to-camera-3d",
  "ambient-occlusion-3d",
  "array-3d",
  "bevel-3d",
  "bezier-path-3d",
  "bump-3d",
  "capsule-3d",
  "circle-3d",
  "cone-3d",
  "copy-to-points-3d",
  "cube-3d",
  "cylinder-3d",
  "extrude-3d",
  "extrude-spline-3d",
  "instance-color-3d",
  "instance-transform-3d",
  "lathe-3d",
  "material-3d",
  "mesh-to-points-3d",
  "plane-3d",
  "polygon-3d",
  "polyhedron-3d",
  "realize-instances-3d",
  "rect-3d",
  "ring-3d",
  "rounded-cube-3d",
  "scatter-points-3d",
  "scene-merge",
  "sphere-3d",
  "spline-3d",
  "texture-projection-3d",
  "torus-3d",
  "torus-knot-3d",
  "transform-3d",
] as const;

const SIM_INPUT_TYPES = [
  "collider-circle",
  "collider-image-mask",
  "collider-line",
  "emitter-image-mask",
  "emitter-point",
  "force-drag",
  "force-gravity",
  "force-point",
  "force-turbulence",
  "force-vortex",
  "force-wind",
] as const;

// SDF tree nodes: they carry an `sdf` / `position` value that compiles INTO
// the sdf-rasterize / sdf-to-mask / sdf-shade / sdf-bevel /
// sdf-to-distance-image consumer (compileSdf), so they fuse with it. The GLSL
// table leaves them unclassified (only the compiled consumers are listed);
// planAeExport passes them to planTranslation as `compiled`. Not here:
// sdf-from-image and sdf-spline, whose distance textures are computed per
// eval (JFA / spline distance) and are not a closed-form part of the shader.
export const SDF_CHAIN_TYPES: ReadonlySet<string> = new Set([
  "sdf-circle",
  "sdf-displace",
  "sdf-intersection",
  "sdf-line-segment",
  "sdf-material",
  "sdf-mirror",
  "sdf-morph",
  "sdf-onion",
  "sdf-polar",
  "sdf-polygon",
  "sdf-rectangle",
  "sdf-repeat",
  "sdf-rotate",
  "sdf-round",
  "sdf-scale",
  "sdf-smooth-intersection",
  "sdf-smooth-subtraction",
  "sdf-smooth-union",
  "sdf-star",
  "sdf-subtraction",
  "sdf-translate",
  "sdf-triangle",
  "sdf-twist",
  "sdf-union",
]);

// Live inputs (§3 rung 7): no offline value exists without a recording.
export const LIVE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "pointer",
  "draggable",
  "hit-region",
  "cursor",
  "cursor-trail-points",
  "drag-points",
  "webcam-source",
]);

// Engine plumbing the planner walks through instead of classifying: group
// boundaries, reroutes, the layer shell itself, eval-only helpers, frames.
export const AE_STRUCTURAL_TYPES: ReadonlySet<string> = new Set([
  "layer",
  "node-group",
  "group-input",
  "group-output",
  "reroute",
  "layer-xform",
  "frame-zone",
  "iterate-input",
  "iterate-feed",
  "repeat-input",
  "foreach-input",
  "time-offset-feed",
]);

const STRUCTURAL: AeExportEntry = {
  class: "layer",
  fidelity: "exact",
  note: "Engine structure (group boundary, reroute, layer shell, eval-only helper) — the planner walks through it.",
};

// ---- the table -------------------------------------------------------------------

export const AE_EXPORT_CLASSES: Record<string, AeExportEntry> = {
  // ---- vector: parametric spline primitives (stay parametric) --------------
  circle: {
    class: "vector",
    ae: "shape:ellipse",
    fidelity: "exact",
    note: "Ellipse + its own Fill/Stroke (fill_enabled / stroke_enabled) + Trim Paths when trimmed. A wired `fill` image becomes that image's layer with this shape as its alpha matte.",
    params: {
      "centerX/centerY": "Ellipse Position px (§4.1: x·W, H/2 + (y − 0.5)·W)",
      "radiusX/radiusY": `Ellipse Size = 2·r ${RADIUS_PX}`,
      trim: TRIM,
      stroke: STROKE,
      opacity: "layer Opacity ·100",
    },
  },
  rectangle: {
    class: "vector",
    ae: "shape:rect",
    fidelity: "exact",
    note: "Rectangle path; corner_style squircle has no AE form (Roundness is circular) — approx when corner_radius > 0.",
    params: {
      "originX/originY": "Rect Position px (§4.1)",
      "width/height": `Rect Size ${RADIUS_PX}`,
      corner_radius: `Roundness px (${RADIUS_PX})`,
      rotate: "group Rotation °",
      trim: TRIM,
      stroke: STROKE,
    },
  },
  polygon: {
    class: "vector",
    ae: "shape:polystar",
    fidelity: "exact",
    note: "Polystar type polygon; toolbox rotation 0 points the first vertex up like AE's — confirm in M2's parity fixture.",
    params: { sides: "Points", radius: `Outer Radius ${RADIUS_PX}`, rotation: "Rotation °", trim: TRIM, stroke: STROKE },
  },
  star: {
    class: "vector",
    ae: "shape:polystar",
    fidelity: "exact",
    note: "Polystar type star.",
    params: {
      points: "Points",
      outerRadius: `Outer Radius ${RADIUS_PX}`,
      innerRadius: `Inner Radius ${RADIUS_PX}`,
      rotation: "Rotation °",
      trim: TRIM,
      stroke: STROKE,
    },
  },
  // ---- vector: explicit paths -----------------------------------------------
  line: path("Straight or bezier segment → one open Shape.", { "start*/end*": "vertices px (§4.1); *In/*Out handles → relative tangents ·W", trim: TRIM, stroke: STROKE }),
  arc: path("Arc → bezier Shape (open, pie or chord).", { "startAngle/endAngle": "baked into the path; animated angles → path keys", trim: TRIM, stroke: STROKE }),
  cross: path(undefined, { trim: TRIM, stroke: STROKE }),
  wave: path("Wave → bezier Shape; animated phase → path keys per frame (constant anchor count).", { trim: TRIM, stroke: STROKE }),
  spiral: path(undefined, { trim: TRIM, stroke: STROKE }),
  arrow: path(undefined, { trim: TRIM, stroke: STROKE }),
  "spline-draw": path("Drawn anchors → Shape vertices with relative tangents. Per-anchor tracks (anchor_p/in/out) resolve to whole-path keys; per-anchor cornerRadius is a live fillet → Round Corners approx; per-anchor `width` has no AE form.", { spline: "vertices px (§4.1), tangents ·W", trim: TRIM, stroke: STROKE }),
  "svg-source": path("Imported SVG → Shape paths (or AE 26 native SVG import for gradients)."),
  "set-position": path("Moves the spline — folds into the path / group position."),
  "svg-export": path("Passes its spline through; the .svg side artifact is not part of the AE export."),
  "bezier-handles": sampledPath("Editor overlay of handles/anchors → stroked paths and dots, sampled."),
  // ---- vector: modifiers with native twins ----------------------------------
  "trim-path": {
    class: "vector",
    ae: "shape:trim",
    fidelity: "exact",
    note: "Trim Paths. mode combined → Trim Multiple Shapes: Individually; per subpath → Simultaneously. Non-value start/end sources (attribute, index, random…) → per-subpath trims (explode) or sampled.",
    params: { trim_start: "Start ·100 %", trim_end: "End ·100 %", trim_offset: "Offset ·360°" },
  },
  "round-corners": {
    class: "vector",
    ae: "shape:round-corners",
    fidelity: "approx",
    note: "Round Corners: AE's fillet math differs from toolbox's per-corner arc.",
    params: { radius: `Radius px (${RADIUS_PX})` },
  },
  "spline-offset": {
    class: "vector",
    ae: "shape:offset",
    fidelity: "approx",
    note: "Offset Paths; overlap keep/sharp/smooth ≈ Line Join miter/round.",
    params: { distance: `Amount px (${RADIUS_PX})` },
  },
  "spline-repeat": {
    class: "vector",
    ae: "shape:offset",
    fidelity: "approx",
    note: "Offset Paths with Copies / Copy Offset; a non-linear spacing_curve has no AE form.",
    params: { count: "Copies", width: `Copy Offset px (${RADIUS_PX})` },
  },
  "spline-boolean": {
    class: "vector",
    ae: "shape:merge",
    fidelity: "approx",
    note: "Merge Paths (subtract/union/intersect/exclude); toolbox polygonizes at `resolution`, AE merges the beziers — edges differ sub-pixel.",
  },
  "set-spline-type": sampledPath("Retangents the path — exported as the evaluated path (linear → straight tangents, exact)."),
  // ---- vector: procedural modifiers / generators (evaluated geometry) -------
  "spline-resample": sampledPath("Resampled path. Its fixed count is what keeps path keys valid downstream of animated geometry."),
  "optimize-path": sampledPath(),
  "taper-spline": sampledPath(),
  "spline-morph": sampledPath("Morph between two splines → path keys; AE needs equal anchor counts on both sides (resample)."),
  "spline-interpolate": sampledPath(),
  "spline-pack": sampledPath(),
  "blend-intersections": sampledPath(),
  "filter-splines": sampledPath(),
  "modulate-splines": sampledPath(),
  "spline-merge": sampledPath(),
  "spline-outline": sampledPath("Stroke outline as a fill path — the variable-width route when a Taper can't match."),
  "proximity-merge": sampledPath(),
  "points-to-surface": sampledPath(),
  "points-to-spline": sampledPath(),
  "connect-points": sampledPath(),
  "string-art": sampledPath(),
  "loop-weave": sampledPath(),
  "l-system": sampledPath(),
  "lissajous-2d": sampledPath(),
  "lissajous-3d": sampledPath("3D curve projected to 2D → path keys."),
  "space-fill": sampledPath(),
  "accretive-growth": sampledPath("Growth is revealed by Progress — animated reveal → path keys per frame (anchor count changes; resample or bake)."),
  "shortest-path": sampledPath(),
  "image-trace": sampledPath("Traced from an image; an animated source changes the anchor count every frame → bake."),
  "sdf-to-spline": sampledPath("Contour of an SDF → path; animated SDFs change the anchor count → bake."),
  // ---- vector: simulations (bake by default) ---------------------------------
  "differential-growth": bake("Spline simulation — its frames depend on history; bakes (or sampled path keys if the anchor count is held)."),
  "rope-simulator": bake("Spline simulation — bakes."),
  "rigid-body-simulator": bake("Spline simulation — bakes."),
  "spline-trails": bake("Trail history across frames — bakes."),
  // ---- style ------------------------------------------------------------------
  "spline-fill": {
    class: "style",
    ae: "shape:fill",
    fidelity: "exact",
    note: "Fill (rule evenodd → Even-Odd, nonzero → Non-Zero). Image fills come from the shape's `fill` input → matte; gradient fills live on Rasterize Spline (needs .ffx).",
    params: { color: "Color 0–1 RGB (OKLab tweens → expression, §11.4)", rule: "Fill Rule" },
  },
  "spline-stroke": {
    class: "style",
    ae: "shape:stroke",
    fidelity: "exact",
    note: "Stroke: cap/join/miter map; dashed/dotted → ≤3 dash/gap pairs. color_source ramp → Gradient Stroke (stops via synthesized .ffx, static only) or per-subpath strokes; thickness_source vary → per-subpath strokes or Taper (approx); repeats > 1 → Offset Paths copies (approx).",
    params: {
      thickness: "Stroke Width (px pass through; % → ·W/100)",
      color: "Color 0–1 RGB",
      "dash_length/dash_gap": "Dash / Gap px",
      cap: "Line Cap",
      join: "Line Join",
      miter_limit: "Miter Limit",
    },
  },
  "rasterize-spline": {
    class: "style",
    ae: "shape:fill",
    fidelity: "exact",
    note: "Fill + Stroke items. fill_source gradient (linear/radial) → Gradient Fill with stops via synthesized .ffx (static only); conic → bake; ramp fills → per-subpath fills.",
    params: {
      fill_color: "Fill Color",
      stroke_color: "Stroke Color",
      thickness: "Stroke Width (px / % → ·W/100)",
      gradient_angle: "Gradient Start/End points from the shape AABB",
      fill_rule: "Fill Rule",
    },
  },
  // ---- transform -------------------------------------------------------------
  transform: {
    class: "transform",
    ae: "layer:transform",
    fidelity: "exact",
    note: "anchor = pivot, position = pivot + translate (§4.1). Last in a shape/text/footage chain → the layer transform; mid-chain on an image → Transform effect (ADBE Geometry2). space=local pivots on animated geometry are keyed per frame. tile → Motion Tile (approx).",
    params: {
      "translateX/translateY": "Position = pivot_px + translate·W",
      "pivotX/pivotY": "Anchor Point px (§4.1; space=local → fraction of the input AABB)",
      "scaleX/scaleY": "Scale ·100 %",
      rotate: "Rotation ° (clockwise on both)",
    },
  },
  gizmo: {
    class: "transform",
    ae: "layer:null",
    fidelity: "exact",
    note: "A null layer; a wired `transform` chain is AE parenting (parent ∘ local).",
    params: { "translateX/translateY": "Position px", "pivotX/pivotY": "Anchor Point px", "scaleX/scaleY": "Scale ·100 %", rotate: "Rotation °" },
  },
  // ---- layer / compositing ---------------------------------------------------
  merge: {
    class: "layer",
    ae: "layer:precomp",
    fidelity: "exact",
    note: "Each input → a layer in a precomp with its blend mode and opacity; mask:<id> → luma track matte (inverted for maskInvert). Average, Negation, Reflect, Glow and Phoenix have no AE mode → shader.",
    params: { "layers[].mode": "blendingMode (24 of 29 by name)", "layers[].opacity": "Opacity ·100 % (layer_opacity:<id> keys)" },
  },
  collect: {
    class: "layer",
    ae: "layer:precomp",
    fidelity: "exact",
    note: "An image group → one layer per item (a spline/points group stays one shape layer with groups).",
  },
  "group-pick": {
    class: "layer",
    ae: "layer:precomp",
    fidelity: "exact",
    note: "Picks one item: a constant index selects that layer; an animated index → HOLD opacity keys per item.",
  },
  "time-offset": {
    class: "layer",
    ae: "layer:precomp",
    fidelity: "exact",
    note: "The offset branch → a precomp whose startTime is shifted by `offset` frames (an expression driver uses valueAtTime(time − offset/fps)).",
    params: { offset: "precomp startTime −offset/fps s" },
  },
  output: { class: "layer", ae: "layer:precomp", fidelity: "exact", note: "The composition: frameRate = fps, duration = the frame range / fps." },
  "render-queue": { class: "layer", fidelity: "exact", note: "Render batches are not exported — the package carries the active composition." },
  // ---- effects: generators -----------------------------------------------------
  "solid-color": {
    class: "effect",
    ae: "layer:solid",
    fidelity: "exact",
    note: "A comp-sized solid layer (alpha → layer Opacity).",
    params: { color: "Solid color 0–1 RGB", "alpha/opacity": "Opacity ·100 %" },
  },
  gradient: {
    class: "effect",
    ae: "ADBE Ramp",
    fidelity: "exact",
    note: "linear/radial (2 stops) → Gradient Ramp on a solid, exact (Ramp Scatter 0). polar, wave and multipoint modes → shader. uv01 is Y-UP here: flip y when placing Start/End.",
    params: {
      "start_x/start_y": "Start of Ramp px (canvas01 → px, §4.1)",
      "end_x/end_y": "End of Ramp px",
      "center_x/center_y + radius": "radial: Start = center, End = center + radius·W",
      "color_a/color_b": "Start Color / End Color (OKLab tweens → dense keys)",
    },
  },
  "image-source": {
    class: "effect",
    ae: "layer:footage",
    fidelity: "exact",
    requires: ["footage"],
    note: "The same file as a footage item; fit cover/contain/stretch → layer Scale; its own TRS → layer transform.",
  },
  "video-source": {
    class: "effect",
    ae: "layer:footage",
    fidelity: "exact",
    requires: ["footage"],
    note: "The same file as footage; speed / start_offset → time remap; a clip window → in/out points; image sequences import as sequences.",
  },
  // ---- effects with AE twins (§3 rung 2) --------------------------------------
  // Measured in AE 26.5 (spec §14); the unit maps are src/lib/ae-export/calibration.ts.
  blur: {
    class: "effect",
    ae: "ADBE Gaussian Blur 2",
    fidelity: "approx",
    note: "Gaussian Blur, calibrated: Blurriness = 1.7464·radius, Repeat Edge Pixels on. AE blurs in linear light (γ 2.4), so it stands in for linearize on (≤ 0.033 mean, a 1-px grid's worst); linearize off, bokeh / convolve and radius > 42.7 (toolbox's 64-tap cap) → shader.",
    params: { radius: "Blurriness = 1.7464·radius (calibration.ts)" },
  },
  "gaussian-blur": {
    class: "effect",
    ae: "ADBE Gaussian Blur 2",
    fidelity: "approx",
    note: "Legacy blur — the calibrated `blur` map; its saves migrate to linearize off, which Gaussian Blur 2 cannot do, so most go to shader.",
  },
  sharpen: {
    class: "effect",
    ae: "ADBE Sharpen",
    fidelity: "approx",
    note: "box → Sharpen, Amount 50·amount (≤ 0.023 off the frame edge); unsharp → Unsharp Mask, radius 0.5, Amount 100·amount (exact, ≤ 0.007); diamond / cross → shader.",
    params: { amount: "Sharpen Amount = 50·amount (box) / Unsharp Mask Amount = 100·amount (unsharp)" },
  },
  mirror: {
    class: "effect",
    ae: "ADBE Mirror",
    fidelity: "approx",
    note: "bisect → Mirror, Reflection Angle by kept side (−x 0°, −y 90°, x 180°, y 270°), ≤ 0.006 mean; x / y / both / radial composite copies over the source → shader.",
    params: { "centerX/centerY": "Reflection Center px (canvas01 → px)", keep: "Reflection Angle 0 / 90 / 180 / 270°" },
  },
  "polar-coords": shader(
    "AE's Polar Coordinates is fixed — source top at the centre, 12 o'clock origin, the source height across the inscribed circle, transparent outside — and toolbox's defaults (bottom at the centre, 3 o'clock, radius scale 1, clamp) have no setting there (measured: mean 0.19–0.44)."
  ),
  pixelate: {
    class: "effect",
    ae: "ADBE Mosaic",
    fidelity: "approx",
    note: "Mosaic, Sharp Colors off: AE averages each block where toolbox samples its centre (≤ 0.035 mean on noise; Sharp Colors on takes the bottom-right pixel, worse). Cells must divide the comp; circle cells → shader.",
    params: { "size/aspect": "Horizontal Blocks = W/(size·aspect), Vertical Blocks = H/size" },
  },
  posterize: {
    class: "effect",
    ae: "ADBE Posterize",
    fidelity: "exact",
    note: "Levels (output 0.5/L … (L − 0.5)/L) then Posterize: AE bins at floor(v·L), toolbox rounds — the Levels makes them agree (≤ 0.002). gamma ≠ 1 and luma mode → shader.",
    params: { levels: "Level = levels (+ the Levels pre-step)" },
  },
  threshold: {
    class: "effect",
    ae: "ADBE Threshold2",
    fidelity: "approx",
    note: "Channel Mixer (monochrome, Rec.709 weights) then Threshold, Level = threshold (0–1): AE's Threshold reads Rec.601 luma. Exact but for pixels on the threshold itself (≤ 0.5%); softness / invert → shader.",
    params: { threshold: "Level = threshold (0–1)" },
  },
  "edge-detect": shader("AE's Find Edges is not a Sobel / Prewitt magnitude (measured on noise: mean 0.063 with Invert on, 0.79 without)."),
  "color-correction": {
    class: "effect",
    ae: "ADBE HUE SATURATION",
    fidelity: "approx",
    note: "Brightness & Contrast (legacy) then Hue/Saturation Master Hue: ≤ 0.009 mean. saturation (toolbox HSV, AE HSL), the wheels, temp / tint, pivot ≠ 0.5 and the curves (Curves is CUSTOM_VALUE) → shader.",
    params: { hue: "Master Hue °", brightness: "Brightness = 255·b (legacy)", contrast: "Contrast = 100(1 − 1/k) for k ≥ 1, 100(k − 1) below (legacy)" },
  },
  displace: {
    class: "effect",
    ae: "ADBE Displacement Map",
    fidelity: "approx",
    note: "Displacement Map (Stretch Map to Fit, no wrap) with the map as a hidden layer: Max H = amountX·W/2, Max V = −amountY·H/2 (≤ 0.008 mean). AE leaves pixels pushed past the edge transparent where toolbox's default clamps (an alpha band ≤ 0.06); midlevel ≠ 0.5, rotate, mirror edges → shader.",
    params: { "amountX/amountY": "Max Horizontal = amountX·W/2, Max Vertical = −amountY·H/2 px", "channelX/channelY": "Use For Horizontal/Vertical: r 1, g 2, b 3, a 4, luminance 5" },
  },
  bloom: {
    class: "effect",
    ae: "ADBE Glo2",
    fidelity: "approx",
    note: "Glow on color: Radius = 2^(levels+1) px, Intensity = 3·intensity, Threshold = 255·threshold. A look match only (mean 0.007–0.028, p95 ≤ 0.17): the pyramid and the soft knee differ; tint / anamorphic → shader.",
    params: { threshold: "Glow Threshold = 255·threshold", intensity: "Glow Intensity = 3·intensity", levels: "Glow Radius = 2^(levels+1) px" },
  },
  grain: {
    class: "effect",
    ae: "VISINF Grain Implant",
    fidelity: "approx",
    note: "Add Grain (Final Output, Blending Mode 5, monochromatic), Intensity = 8.67·luminance: the per-luminance std matches within 4% and both are white noise at 1 px, but the random field differs. Only the custom fine model at 1 px, overlay, no chroma / tint / response.",
    params: { luminance: "Intensity = 8.67·luminance", seed: "Random Seed" },
  },
  keyer: {
    class: "effect",
    ae: "ADBE Linear Color Key2",
    fidelity: "approx",
    note: "color mode → Linear Color Key, Using RGB (toolbox's own |ΔRGB|/√3): Tolerance = 100·tol, Softness = 150·((tol + soft)² − tol²) — AE ramps linearly in d², toolbox smoothsteps in d (α ≤ 0.027). chroma, luma, sample mode and despill → shader.",
    params: { key_color: "Key Color", tolerance: "Matching Tolerance = 100·tol", softness: "Matching Softness = 150·((tol + soft)² − tol²)" },
  },
  "bevel-emboss": shader("AE's Bevel Alpha (one light, alpha edges) is not toolbox's JFA bevel / emboss (measured: mean 0.21 at every light angle)."),
  trails: {
    class: "effect",
    ae: "ADBE Echo",
    fidelity: "approx",
    note: "feedback → Echo, Composite In Back, Echo Time −1/fps, Decay = decay, echoes until decay^n < 0.5/255 (α ≤ 0.019). Echo reads the layer's source frames: precompose its input. ring / velocity → bake.",
    params: { decay: "Decay = decay; Number Of Echoes = ⌈ln(0.5/255)/ln decay⌉" },
  },
  "chromatic-aberration": shader("No flat-image built-in: VR Chromatic Aberrations (Mettle SkyBox Chromatic Aberrat) is for equirectangular 360° frames."),
  lut: bake(
    "Apply Color LUT cannot be scripted: adding it opens a file dialog (measured — it hangs aerender's core) and its LUT is not a property; the GLSL table calls lut opaque, so it bakes."
  ),
  array: {
    class: "instances",
    ae: "shape:repeater",
    fidelity: "exact",
    note: "spline/point mode → Repeater(s) on a regular grid; image mode → Motion Tile (ADBE Tile, approx, measured ≤ 0.013 mean: Tile Width/Height = 100/count %, centred on the bottom-left tile; fit, or a step grid that covers the frame, no per-copy offsets) or exploded layers; modulator fields → exploded layers.",
    params: { "countX/countY": "Repeater Copies (one Repeater per axis)", "sizeW/sizeH": "Repeater Position offset px" },
  },
  // ---- expression: the value graph (§3 rung 3) --------------------------------
  constant: value(),
  math: value("Math ops → JS (Math.*); vector modes per component."),
  clamp: value(),
  lerp: value(),
  remap: value("Range remap → linear(); the scalar_field aux output is shader-only."),
  compare: value(),
  logic: value(),
  switch: value("Scalar/vector switch → index-select expression; image/spline switching → HOLD opacity keys per branch."),
  "float-curve": value("Curve → piecewise expression (the curve points inlined)."),
  lfo: value("sine/triangle/sawtooth/square of time → expression."),
  "scene-time": value("time·fps (frames) or time (seconds)."),
  random: { class: "expression", ae: "expression", fidelity: "approx", note: "seedRandom(seed, false); random() — different noise, same statistics (mode frame → timeless false)." },
  "split-vec2": value(),
  "combine-vec2": value(),
  "vec2-literal": value(),
  "vec3-literal": value(),
  "string-literal": value("Feeds Source Text."),
  "number-to-string": value("→ Source Text expression (toFixed)."),
  expression: value("Already JavaScript — AE's engine is ECMAScript 2018; rename inputs to the driven property's references."),
  "animated-value": value("Wired monotonic clock → time remap / valueAtTime; otherwise its keys export directly."),
  wedge: value("Batch-render variation — exports the current iteration's value."),
  list: value("Parsed list → an array literal in the expression."),
  csv: value("The selected row's cells → literals (CSV data inlined)."),
  "group-length": value(),
  "color-literal": value("Color literal → [r, g, b, a] array."),
  "sample-along-path": value("→ pointOnPath() / tangentOnPath() on the path's shape layer (AE 15.0+); angles in radians → degrees."),
  "bounding-box": { class: "expression", ae: "expression", fidelity: "approx", note: "→ sourceRectAtTime() on the measured layer (AE's bounds include strokes/effects; toolbox's alpha extent may differ)." },
  "attribute-read": sampledValue("Reads a per-point attribute — per-frame keys unless the source points are static."),
  smooth: sampledValue("Frame-history smoothing — per-frame keys."),
  accumulator: sampledValue("Accumulates across frames — per-frame keys."),
  "sample-hold": sampledValue("Holds across frames — per-frame keys (HOLD)."),
  "trigger-envelope": sampledValue("Envelope on trigger history — per-frame keys."),
  "audio-bands": sampledValue("Audio analysis — per-frame keys from an offline pass over the mixdown."),
  "audio-pitch": sampledValue("Audio analysis — per-frame keys from an offline pass over the mixdown."),
  "points-to-string": sampledValue("Point data → Source Text per frame."),
  // ---- instances (§3 rung 4) ---------------------------------------------------
  "copy-to-points": {
    class: "instances",
    ae: "layer:precomp",
    fidelity: "exact",
    requires: ["explode"],
    note: "One layer (or shape group) per point with per-instance position/rotation/scale/tint — capped by the layer budget; a single instance on a regular grid/array → Repeater instead.",
  },
  grid: instances("Regular grid → two Repeaters when instances are identical; else exploded positions."),
  "scatter-points": instances("Seeded scatter → exploded positions (static values per instance)."),
  point: instances("One point → a null / one instance position."),
  "points-on-path": instances("Points along a path → per-instance pointOnPath() expressions (exact) or positions."),
  "spline-to-points": instances("Anchor positions → instance positions."),
  "spline-intersections": instances("Intersections → instance positions; animated → per-frame keys.", "sampled"),
  stagger: instances("Per-instance phase → offsets baked into each exploded layer's keys (or startTime)."),
  "attribute-blur": instances("Per-instance attribute values (static → exact; animated → per-frame keys).", "sampled"),
  "attribute-math": instances("Per-instance attribute values (static → exact; animated → per-frame keys).", "sampled"),
  "attribute-transfer": instances("Per-instance attribute values (static → exact; animated → per-frame keys).", "sampled"),
  "map-attribute": instances("Per-instance attribute values (static → exact; animated → per-frame keys).", "sampled"),
  "modulate-points": instances("Per-instance scale/rotation (static → exact; animated → per-frame keys).", "sampled"),
  "sample-texture-at-points": instances("Per-instance values sampled from an image (static → exact; animated → per-frame keys).", "sampled"),
  "set-named-attribute": instances("Per-instance attribute values (static → exact; animated → per-frame keys).", "sampled"),
  "filter-points": instances("Keeps a subset of instances; an animated filter → per-instance HOLD opacity keys.", "sampled"),
  "point-expression": instances("JS per point → per-instance values evaluated at export (per-frame keys when animated).", "sampled"),
  relax: instances("Relaxed positions → static instance positions (or per-frame keys).", "sampled"),
  "project-to-screen-3d": instances("3D points projected by the camera → per-frame 2D positions.", "sampled"),
  repeat: instances("Repeat zone: each pass → its own group/layer, values per iteration (sampled when the loop feeds back).", "sampled"),
  foreach: instances("For Each zone: one group/layer per element with that element's values.", "sampled"),
  // ---- text (§3 rung 4, §4.7) ---------------------------------------------------
  text: {
    class: "text",
    ae: "layer:text",
    fidelity: "approx",
    note: "Text layer (TextDocument): font by PostScript name (must be installed in AE), size px, tracking, leading, case, alignment, box; on-path → Path Options. Glyph metrics differ from toolbox's rasterizer; animators → AE animators (M4); gradient fills → Gradient Ramp on the layer.",
    params: {
      font_family: "TextDocument.font (PostScript name via app.fonts)",
      font_size: "fontSize px (% → ·W/100)",
      letter_spacing: "tracking (1/1000 em)",
      leading: "leading = font_size·leading px",
      color: "fillColor 0–1 RGB",
      alignment: "justification",
    },
  },
  "points-to-text": { class: "text", ae: "layer:text", fidelity: "approx", requires: ["explode"], note: "One text layer per point (layer budget applies); fonts as Text." },
  "point-labels": { class: "text", ae: "layer:text", fidelity: "approx", requires: ["explode"], note: "One text layer per labelled point (layer budget applies)." },
  // ---- shader: no AE twin (§3 rung 5) -------------------------------------------
  noise: shader("Fractal Noise is a look-alike, not a port — the fused shader reproduces the selected algorithm exactly."),
  lyapunov: shader(),
  "shape-cells": shader(),
  "texture-coordinate": shader("UV field — only meaningful inside a fused region."),
  voronoi: bake("Cell geometry is computed on the CPU; a Worley-noise shader is a stand-in, not a port — bakes."),
  "color-ramp": shader("A ramp() LUT in the bundle (static stops); animated stops → bake. ≤2 sRGB stops could be Tint (M4)."),
  "rgb-curves": shader("Curves are CUSTOM_VALUE in AE (unscriptable) — curve() LUTs in the bundle."),
  "color-space-transform": shader(),
  dither: shader("Ordered/Bayer modes fuse; error-diffusion modes are CPU → those bake."),
  "glsl-expression": shader("Already the kernel — the host runs it after the MSL translation."),
  "advect-image": shader(),
  "vector-field": shader(),
  "flow-obstacle": shader(),
  "flow-blur": shader(),
  kuwahara: shader(),
  "adaptive-pixelate": shaderApprox("Quadtree passes; the fused form is a fixed-depth approximation."),
  "liquid-glass": shaderApprox("Multipass; the fused form approximates."),
  "lens-flare": shaderApprox("AE's Lens Flare is a different look; the fused ghost/streak passes approximate."),
  stipple: shaderApprox("Multipass; the fused form approximates."),
  "image-flow-field": shaderApprox("Structure-tensor passes; the fused form approximates."),
  "flow-bilateral": shaderApprox("Iterated bilateral; the fused form approximates."),
  "shock-filter": shaderApprox("Iterated; the fused form approximates."),
  "line-art": shaderApprox("Five passes; the fused form approximates."),
  ascii: shaderApprox("Cell average + glyph atlas; the atlas ships as a LUT texture or the glyphs are drawn procedurally."),
  "sdf-rasterize": shader("compileSdf emits the body; the SDF tree upstream fuses with it."),
  "sdf-shade": shader(),
  "sdf-bevel": shader(),
  "sdf-to-mask": shader(),
  "sdf-to-distance-image": shader(),
  "sdf-from-image": bake("JFA distance transform of an image, computed per eval — not part of a closed-form shader; the SDF chain it feeds bakes."),
  "sdf-spline": bake("Spline distance texture computed per eval — the SDF chain it feeds bakes (an analytic spline SDF in the fused shader is possible, not planned)."),
  // ---- bake: stateful / sims / ML / opaque (§3 rung 6) ---------------------------
  "particle-simulator": bake("Particle simulation — bakes with its Particles to Image."),
  "matter-simulator": bake("Matter simulation — bakes."),
  "particles-to-image": bake("Renders a simulation — the bake output."),
  "simulation-start": bake("Feedback loop across frames — bakes."),
  "simulation-end": bake("Feedback loop across frames — bakes."),
  "webgpu-particle-test": bake("WebGPU spike node — renders on an overlay; nothing to export."),
  "fluid-simulator": bake("Fluid simulation — bakes."),
  physarum: bake("Agent simulation — bakes."),
  "reaction-diffusion": bake("Reaction–diffusion — bakes."),
  "swift-hohenberg": bake("Pattern simulation — bakes."),
  "watercolor-ink": bake("Paint simulation — bakes."),
  datamosh: bake("Frame-history effect — bakes."),
  "behavioral-growth": bake("Point simulation — bakes."),
  "advect-points": bake("Point advection across frames — bakes (or per-frame instance keys within the layer budget)."),
  "bg-remove": bake("ML matte — bakes."),
  "segment-anything": bake("ML matte — bakes."),
  "depth-anything": bake("ML depth — bakes."),
  "object-tracker": bake("Tracked from video — the track becomes per-frame keys (sampled) when the source is a file."),
  "tracker-point": bake("Tracked from video — per-frame keys (sampled) when the source is a file."),
  "hand-tracker": bake("ML hand tracking — per-frame keys (sampled) when the source is a file."),
  "image-generate": bake("Generated still — one-frame footage (look-exact)."),
  paint: bake("Painted still — one-frame footage (look-exact)."),
  "cube-3d-test": bake("3D test render — bakes."),
  "scene-render": bake("three.js render — bakes, unless every object is an Import 3D model (under Transform 3D) or a light and the camera is a Camera node: then a native 3-D precomp (three-plan.ts)."),
  "import-3d": bake("3D model — in a native 3-D scene the same GLB / glTF / OBJ becomes an AE 3D model layer (Advanced 3D); otherwise baked with its Scene Render."),
  "camera-3d": { class: "layer", ae: "layer:camera", fidelity: "exact", note: "AE camera: Point of Interest = target, Zoom = (H/2)/tan(fov/2), 512 px per world unit; orthographic → a far camera (approx). Bakes with a non-native Scene Render." },
  "light-3d": { class: "layer", ae: "layer:light", fidelity: "approx", note: "AE light (Parallel / Point / Spot / Ambient); intensity the least-squares match over N·L (approx). Bakes with a non-native Scene Render." },
  "sksl-shader": bake("Rendered by Skia (CanvasKit) — bakes; porting it is a manual SkSL → GLSL rewrite."),
  "diffusion-curves": bake("Spline-seeded Jacobi relaxation — geometry in AND iterative; bakes."),
  "spline-flow-field": bake("CPU flow-field render — bakes."),
  "bento-slice": bake("CPU slicing layout — bakes."),
  frame: bake("Element layout — bakes."),
  autolayout: bake("Element layout — bakes."),
  "audio-spectral": bake("FFT history texture — bakes."),
  iterate: bake("Iterate zone: an evaluation loop inside one frame — bakes its collected output."),
  "perlin-noise": bake("Legacy noise node — swap it for Noise to get a shader region; bakes as is."),
  "uv-coords": bake("Legacy UV field — swap it for Texture Coordinate; bakes as is."),
  fracture: bake("Legacy Fracture (now Voronoi) — bakes."),
  jitter: sampledPath("Legacy per-anchor jitter → path keys per frame."),
  group: { class: "layer", ae: "layer:precomp", fidelity: "exact", note: "Legacy Group — same as Collect." },
  "audio-source": {
    class: "bake",
    ae: "layer:footage",
    fidelity: "exact",
    requires: ["footage"],
    note: "A file → the same audio as a footage layer; mode microphone is a live input (unsupported until recorded).",
  },
  // ---- unsupported: live inputs (§3 rung 7) --------------------------------------
  pointer: live("Pointer input"),
  draggable: live("Draggable handle (pointer)"),
  "hit-region": live("Hit region (pointer)"),
  cursor: live("Cursor follower"),
  "cursor-trail-points": live("Cursor trail"),
  "drag-points": live("Dragged points (pointer)"),
  "webcam-source": live("Webcam capture"),
};

for (const t of SKIA_LAYER_TYPES) AE_EXPORT_CLASSES[t] = bake(SKIA_NOTE);
for (const t of AUDIO_TYPES) AE_EXPORT_CLASSES[t] = bake(AUDIO_NOTE);
for (const t of MESH_TYPES) AE_EXPORT_CLASSES[t] = bake(MESH_NOTE);
AE_EXPORT_CLASSES["transform-3d"] = bake("3D transform — over Import 3D models in a native 3-D scene it becomes a 3-D null the model is parented to; otherwise baked with its Scene Render.");
for (const t of SIM_INPUT_TYPES) AE_EXPORT_CLASSES[t] = bake(SIM_INPUT_NOTE);
for (const t of SDF_CHAIN_TYPES)
  AE_EXPORT_CLASSES[t] = shader("SDF tree node — compiles into the sdf-rasterize / sdf-to-mask it feeds (one shader region).");
for (const t of AE_STRUCTURAL_TYPES) AE_EXPORT_CLASSES[t] ??= STRUCTURAL;

const UNCLASSIFIED: AeExportEntry = {
  class: "unsupported",
  fidelity: "bake",
  note: "Not in the After Effects class table — treated as unsupported (never guessed).",
};

export function aeExportEntry(type: string): AeExportEntry {
  return AE_EXPORT_CLASSES[type] ?? UNCLASSIFIED;
}

export function isAeClassified(type: string): boolean {
  return type in AE_EXPORT_CLASSES;
}

// GLSL classes the fused shader can absorb (the `shader` rung's source). SDF
// tree nodes count: they compile into their consumer.
export function isGlslFusable(type: string): boolean {
  const c = TRANSLATION_CLASSES[type]?.class;
  return c === "pure" || c === "gather" || c === "multipass" || c === "compiled" || SDF_CHAIN_TYPES.has(type);
}

// ---- blend modes (§4.4) ------------------------------------------------------------

// The five toolbox modes with no AE blendingMode — shader (or bake).
export const AE_MISSING_BLEND_MODES: ReadonlySet<string> = new Set(["average", "negation", "reflect", "glow", "phoenix"]);

const BLEND_ALIASES: Record<string, AeBlendMode> = { mix: "normal" };

// Toolbox blend mode → AE blendingMode; null for the five without one (and
// for anything unknown, so a typo can't silently become Normal).
export function aeBlendModeOf(mode: string | undefined): AeBlendMode | null {
  const m = mode ?? "normal";
  if (AE_MISSING_BLEND_MODES.has(m)) return null;
  if (m in BLEND_ALIASES) return BLEND_ALIASES[m];
  return AE_BLEND_MODES.has(m) ? (m as AeBlendMode) : null;
}

const AE_BLEND_MODES: ReadonlySet<string> = new Set([
  "normal",
  "add",
  "subtract",
  "multiply",
  "divide",
  "difference",
  "screen",
  "overlay",
  "hard-light",
  "soft-light",
  "vivid-light",
  "pin-light",
  "linear-light",
  "hard-mix",
  "lighten",
  "darken",
  "lighter-color",
  "darker-color",
  "color-dodge",
  "color-burn",
  "linear-dodge",
  "linear-burn",
  "exclusion",
]);
