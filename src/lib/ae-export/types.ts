// After Effects export — shared types (spec 091926_after-effects-handoff.md).
//
// Lib-level, not engine-level, for the same reason as src/lib/glsl-translation:
// agent/export guidance must not ship in exported apps. Nothing in src/engine
// or src/nodes imports this folder.
//
// Layout (who owns what):
//   types.ts        this file — the contracts every other module speaks
//   classes.ts      node type → exportability rung (§3), gated for coverage
//   plan.ts         planAeExport — the deterministic analysis (§6)
//   convert/        pure unit/easing/color/time math (§4), gated offline
//   runtime/        build.jsx (ES3 interpreter of scene.json) + .ffx synthesis
//   scene/          the exporter walk: graph → AeScene (§5.2)
//   package/        package writer, bakes, README (§5.1)
//   shader/         fused GLSL → host shader bundle (§7.4)
//
// Two coordinate systems meet here. Toolbox authors in canvas01 (Y-down,
// width-relative; src/engine/aspect.ts). Everything typed `Ae*` below is
// already in AE terms: layer pixels, seconds, degrees, 0–100 percentages,
// colors as 0–1 RGB(A) floats. Conversion happens once, in convert/, before
// anything reaches scene.json — build.jsx never does math.

// ---------------------------------------------------------------------------
// §3 — the exportability ladder
// ---------------------------------------------------------------------------

export type AeExportClass =
  | "vector" // spline geometry → shape-layer path(s); parametric where exact
  | "style" // fill / stroke / gradient → shape Fill / Stroke / Gradient Fill
  | "transform" // Transform / Gizmo → layer transform, anchor = pivot, parenting
  | "layer" // Layer / Merge → comp layers, blend mode, opacity, track mattes
  | "mask" // universal mask, spline-as-mask → layer mask / matte / effect mask
  | "effect" // an AE built-in effect reproduces it (fidelity: exact | approx)
  | "expression" // pure value node → AE expression text on the driven property
  | "instances" // copy-to-points / array / stagger → Repeater or exploded layers
  | "text" // text → AE text layer (+ animators)
  | "shader" // image node with no native form → fused GLSL → Toolbox Shader host
  | "bake" // stateful / sim / ML / 3D scene → footage layer (ProRes 4444 / qtrle)
  | "unsupported"; // live input (pointer, webcam, cursor, audio-in) — needs a recording

// Ladder order, top (most editable) to bottom. The planner's route and the
// modal's chips sort by this.
export const AE_CLASS_ORDER: readonly AeExportClass[] = [
  "vector",
  "style",
  "transform",
  "layer",
  "mask",
  "effect",
  "expression",
  "instances",
  "text",
  "shader",
  "bake",
  "unsupported",
];

export type AeFidelity = "exact" | "approx" | "sampled" | "bake";

export type AeRequirement = "ffx" | "host" | "footage" | "explode";

export interface AeExportEntry {
  class: AeExportClass;
  // Match name or object: "ADBE Gaussian Blur 2", "shape:ellipse", "layer:null".
  ae?: string;
  fidelity: AeFidelity;
  // The one thing the exporter/agent must know about this node.
  note?: string;
  // Toolbox param → AE property + unit rule, e.g. { radius: "Blurriness ← radius·W·k" }.
  params?: Record<string, string>;
  requires?: AeRequirement[];
}

// ---------------------------------------------------------------------------
// Policies (§4.2, §4.3, §5.4; owner decisions §11, 2026-10-19)
// ---------------------------------------------------------------------------

export type AeFidelityPolicy = "editable" | "exact";

// "auto" = the §11.4 decision: expression when the track drives a shape or
// solid color, dense keys elsewhere.
export type AeColorPolicy = "auto" | "expression" | "dense" | "rgb";

export type AeBakeCodec = "qtrle" | "prores4444";

export interface AeExportPolicy {
  fidelity: AeFidelityPolicy;
  color: AeColorPolicy;
  // Max per-channel deviation (0–255 scale) dense color keys may leave.
  colorTolerance: number;
  // Exploded instance layers before the planner warns / asks (§11.5).
  layerBudget: number;
  // Total baked footage size before the planner warns (§11.5).
  bakeWarnMB: number;
  bakeCodec: AeBakeCodec;
  bitsPerChannel: 8 | 16 | 32;
  // Accept `effect`-class approximations; false routes them to `shader`.
  acceptApprox: boolean;
  // The Toolbox Shader host is installed (or will be): `shader` regions
  // become host effects; false bakes them instead.
  shaderHost: boolean;
}

export const DEFAULT_AE_POLICY: AeExportPolicy = {
  fidelity: "editable",
  color: "auto",
  colorTolerance: 2,
  layerBudget: 200,
  bakeWarnMB: 500,
  bakeCodec: "prores4444",
  bitsPerChannel: 16,
  acceptApprox: true,
  shaderHost: true,
};

// ---------------------------------------------------------------------------
// §6 — the plan
// ---------------------------------------------------------------------------

export type AeRoute = "direct" | "direct+bake" | "direct+shader" | "blocked";

export interface AePlanNode {
  id: string;
  type: string;
  name?: string;
  class: AeExportClass;
  ae?: string;
  fidelity: AeFidelity;
  notes: string[];
  // Index into the owning AePlanLayer.segments. A value node compiled into
  // an expression carries the segment of the property it drives; -1 when it
  // drives nothing that exports.
  segment: number;
  // What this node needs at export beyond its class's default (e.g. "ffx"
  // for a gradient stroke) — the planner's per-node refinement of
  // AeExportEntry.requires.
  requires?: AeRequirement[];
}

export type AeSegmentKind =
  | "vector" // spline producer → modifiers → transforms → style → rasterize: one shape layer
  | "raster" // image effects: effects on the layer, or on an adjustment layer
  | "shader" // a fused region → Toolbox Shader effect (or a bake without the host)
  | "bake" // footage layer
  | "text"
  | "instances"
  | "source" // image/video source, solid, gradient generator → footage / solid layer
  | "composite"; // Merge / Collect: its inputs become layers of a precomp (blend modes, mattes)

export type AeLayerKind =
  | "shape"
  | "solid"
  | "footage"
  | "precomp"
  | "null"
  | "text"
  | "adjustment"
  | "camera"
  | "light";

export interface AeSegment {
  kind: AeSegmentKind;
  // Toolbox node ids, topological (producers first).
  nodes: string[];
  // Endpoint whose value the segment represents ("<id>:out" | "<id>:aux:<name>").
  output: string;
  aeLayer: AeLayerKind;
}

// One clip window of a toolbox layer in composition frames: visible on
// [inFrame, outFrame); the interior's local frame 0 sits at
// inFrame − sourceInFrame (AE startTime). Several windows = one AE layer each.
export interface AePlanWindow {
  inFrame: number;
  outFrame: number;
  sourceInFrame: number;
}

export interface AePlanLayer {
  // Toolbox layer node id (or the composition root when there are no layers).
  id: string;
  name: string;
  windows: AePlanWindow[];
  segments: AeSegment[];
  nodes: AePlanNode[];
}

export interface AeShaderRegion {
  id: string;
  // Endpoint the fused shader replaces.
  target: string;
  nodes: string[];
  frames: number[];
  // One-line summary of the plan_glsl_translation result for this target.
  summary?: string;
}

export interface AeBakeItem {
  id: string;
  output: string;
  // Inclusive frame range at the composition fps.
  frames: [number, number];
  codec: AeBakeCodec;
  estimatedMB: number;
  reason: string;
}

export interface AeExpressionItem {
  // The driven node + param ("<id>:param:<name>").
  drives: string;
  // Value-graph nodes compiled into the expression (topological).
  nodes: string[];
  sampled: boolean;
}

export interface AeBlocker {
  id: string;
  type: string;
  reason: string;
}

export interface AeExportPlan {
  route: AeRoute;
  composition: { id: string; name: string; width: number; height: number; fps: number; durationFrames: number };
  layers: AePlanLayer[];
  shaderRegions: AeShaderRegion[];
  bakes: AeBakeItem[];
  expressions: AeExpressionItem[];
  blocked: AeBlocker[];
  // Nodes whose fidelity is "approx", by name — the five-line relay's line 2.
  approximations: { id: string; type: string; note: string }[];
  estimates: { layers: number; keyframes: number; footageMB: number };
  // Font families text layers name — AE needs them installed (§4.7).
  fonts: string[];
  policy: AeExportPolicy;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// §5.1 — scene.json (our schema, shaped after AE's object model, not Lottie)
// ---------------------------------------------------------------------------

export const AE_SCENE_SCHEMA_VERSION = 1;

// The host effect's match name (§7.3).
export const TBX_SHADER_MATCH_NAME = "TBX Shader";

export type AeInterp = "linear" | "bezier" | "hold";

// One KeyframeEase. influence is 0.1–100; speed is in the property's units
// per second (for spatial position: px/s along the path).
export interface AeEase {
  speed: number;
  influence: number;
}

export interface AeKey<T = unknown> {
  // Seconds, in the time of the comp that contains the layer (setValueAtTime's
  // convention). Confirmed in AE 26.5 (spec §13): keys written at comp time t
  // on a layer with startTime 0.5 read back keyTime() = t.
  t: number;
  v: T;
  inInterp: AeInterp;
  outInterp: AeInterp;
  // Length 1 for 1-D, color and spatial properties; `dims` for non-spatial
  // 2-D / 3-D ones (AE's own rule, §1 follow-ups). AE's Scale is ThreeD even
  // on a 2-D layer: build.jsx completes a short list with its last entry.
  easeIn?: AeEase[];
  easeOut?: AeEase[];
  // Spatial tangents (position-like properties only), relative, layer px.
  // Omitted = zero (a straight motion path; build.jsx turns AE's auto-bezier
  // off). [x, y] on a 2-D layer's Position gets z = 0.
  spatialIn?: number[];
  spatialOut?: number[];
}

export type AeProp<T = unknown> =
  | { v: T; expression?: string }
  | { keys: AeKey<T>[]; dims: 1 | 2 | 3 | 4; expression?: string };

// A bezier path in layer pixels with relative tangents — AE's Shape object.
// Path keyframes need a constant vertex count across keys.
export interface AePath {
  vertices: [number, number][];
  inTangents: [number, number][];
  outTangents: [number, number][];
  closed: boolean;
}

export type AeBlendMode =
  | "normal"
  | "dissolve"
  | "darken"
  | "multiply"
  | "color-burn"
  | "classic-color-burn"
  | "linear-burn"
  | "darker-color"
  | "add"
  | "lighten"
  | "screen"
  | "color-dodge"
  | "classic-color-dodge"
  | "linear-dodge"
  | "lighter-color"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "linear-light"
  | "vivid-light"
  | "pin-light"
  | "hard-mix"
  | "difference"
  | "classic-difference"
  | "exclusion"
  | "subtract"
  | "divide"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "stencil-alpha"
  | "stencil-luma"
  | "silhouette-alpha"
  | "silhouette-luma"
  | "alpha-add"
  | "luminescent-premul";

export type AeRGB = [number, number, number];
export type AeRGBA = [number, number, number, number];

export interface AeGradientStops {
  // Offsets 0–1 along the gradient; colors 0–1 RGB.
  colors: { offset: number; color: AeRGB; midpoint?: number }[];
  opacities: { offset: number; opacity: number; midpoint?: number }[];
}

export interface AeShapeTransform {
  anchor?: AeProp<[number, number]>;
  position?: AeProp<[number, number]>;
  scale?: AeProp<[number, number]>; // percent
  rotation?: AeProp<number>; // degrees, clockwise
  opacity?: AeProp<number>; // percent
  skew?: AeProp<number>;
  skewAxis?: AeProp<number>;
}

export type AeShapeItem =
  | { kind: "group"; name?: string; contents: AeShapeItem[]; transform?: AeShapeTransform; blendMode?: AeBlendMode }
  | { kind: "path"; name?: string; path: AeProp<AePath> }
  | { kind: "rect"; name?: string; size: AeProp<[number, number]>; position: AeProp<[number, number]>; roundness: AeProp<number> }
  | { kind: "ellipse"; name?: string; size: AeProp<[number, number]>; position: AeProp<[number, number]> }
  | {
      kind: "polystar";
      name?: string;
      type: "star" | "polygon";
      points: AeProp<number>;
      position: AeProp<[number, number]>;
      rotation: AeProp<number>;
      outerRadius: AeProp<number>;
      outerRoundness: AeProp<number>;
      innerRadius?: AeProp<number>;
      innerRoundness?: AeProp<number>;
    }
  | { kind: "fill"; name?: string; color: AeProp<AeRGB>; opacity: AeProp<number>; rule: "nonzero" | "evenodd"; blendMode?: AeBlendMode }
  | {
      kind: "stroke";
      name?: string;
      color: AeProp<AeRGB>;
      opacity: AeProp<number>;
      width: AeProp<number>;
      cap: "butt" | "round" | "square";
      join: "miter" | "round" | "bevel";
      miterLimit: number;
      // At most 3 pairs (AE's limit).
      dashes?: { dash: AeProp<number>; gap: AeProp<number> }[];
      dashOffset?: AeProp<number>;
      taper?: { startLength: AeProp<number>; endLength: AeProp<number>; startWidth: AeProp<number>; endWidth: AeProp<number>; startEase: AeProp<number>; endEase: AeProp<number> };
      blendMode?: AeBlendMode;
    }
  | {
      kind: "gradient-fill" | "gradient-stroke";
      name?: string;
      type: "linear" | "radial";
      start: AeProp<[number, number]>;
      end: AeProp<[number, number]>;
      // Static only — stop colors are not scriptable; applied via `preset`
      // (a synthesized .ffx under presets/, runtime/ffx.ts) or an SVG import
      // fallback (an SVG-seeded shape layer, see AeLayer.source). A preset
      // needs the After Effects app: applyPreset hangs aerender's core, so a
      // headless build leaves AE's default gradient and says so.
      stops: AeGradientStops;
      preset?: string;
      highlightLength?: AeProp<number>;
      highlightAngle?: AeProp<number>;
      opacity: AeProp<number>;
      rule?: "nonzero" | "evenodd";
      // gradient-stroke only
      width?: AeProp<number>;
      cap?: "butt" | "round" | "square";
      join?: "miter" | "round" | "bevel";
      miterLimit?: number;
    }
  | { kind: "trim"; name?: string; start: AeProp<number>; end: AeProp<number>; offset: AeProp<number>; mode: "simultaneous" | "individual" }
  | { kind: "offset"; name?: string; amount: AeProp<number>; join: "miter" | "round" | "bevel"; miterLimit: number; copies?: AeProp<number>; copyOffset?: AeProp<number> }
  | { kind: "round-corners"; name?: string; radius: AeProp<number> }
  | {
      kind: "repeater";
      name?: string;
      copies: AeProp<number>;
      offset: AeProp<number>;
      composite: "above" | "below";
      transform: AeShapeTransform & { startOpacity?: AeProp<number>; endOpacity?: AeProp<number> };
    }
  | { kind: "merge"; name?: string; mode: "merge" | "add" | "subtract" | "intersect" | "exclude" };

export interface AeMask {
  name?: string;
  path: AeProp<AePath>;
  mode: "none" | "add" | "subtract" | "intersect" | "lighten" | "darken" | "difference";
  inverted: boolean;
  feather: AeProp<[number, number]>;
  expansion: AeProp<number>;
  opacity: AeProp<number>;
}

// An effect property value that names another layer (PF_Param_LAYER inputs,
// Displacement Map's map layer, the Toolbox Shader's layer slots). build.jsx
// resolves the id to the layer's index in the same comp.
export interface AeLayerRef {
  layerRef: string;
}

export interface AeEffect {
  // AE match name, e.g. "ADBE Gaussian Blur 2", or TBX_SHADER_MATCH_NAME.
  match: string;
  name?: string;
  // Keyed by property match name (or "#<index>" when an effect's params have
  // no stable match names). Values may be AeLayerRef for layer params.
  props: Record<string, AeProp>;
  // A synthesized preset under presets/ applied after the effect is added.
  preset?: string;
  // Toolbox Shader only: bundle id under shaders/.
  bundle?: string;
  // Compositing Options → mask reference (1-based mask index on the layer).
  // Measured in AE 26.5 (spec §13): the effect follows the mask's mode — add
  // = inside, subtract = outside, "none" is IGNORED — and a mask an effect
  // references stops masking the layer. So an effect-only mask is mode
  // "add" (or "subtract" for the inverse), never "none".
  compositingMask?: { mask: number; opacity?: AeProp<number> };
  enabled?: boolean;
}

export interface AeTextDocument {
  text: string;
  // PostScript name.
  font: string;
  fontSize: number;
  fillColor?: AeRGB;
  strokeColor?: AeRGB;
  strokeWidth?: number;
  strokeOverFill?: boolean;
  tracking: number;
  leading?: number;
  justification: "left" | "center" | "right" | "full-left" | "full-center" | "full-right" | "full";
  allCaps?: boolean;
  // Paragraph (box) text when present; point text otherwise.
  box?: { size: [number, number]; position: [number, number] };
}

export interface AeTextAnimator {
  name: string;
  // Keyed by animator property match name, e.g. "ADBE Text Opacity".
  properties: Record<string, AeProp>;
  selector: {
    basedOn: "characters" | "characters-excluding-spaces" | "words" | "lines";
    units: "percentage" | "index";
    start: AeProp<number>;
    end: AeProp<number>;
    offset: AeProp<number>;
    shape: "square" | "ramp-up" | "ramp-down" | "triangle" | "round" | "smooth";
    easeHigh: AeProp<number>;
    easeLow: AeProp<number>;
    randomize?: boolean;
    seed?: number;
  };
}

export interface AeLayerTransform {
  anchor: AeProp<number[]>;
  // `separated` = AE's separated dimensions; then `position` must be omitted
  // and xPosition / yPosition (and zPosition for 3-D) carry the tracks.
  position?: AeProp<number[]>;
  separated?: { x: AeProp<number>; y: AeProp<number>; z?: AeProp<number> };
  scale: AeProp<number[]>; // percent
  rotation: AeProp<number>; // degrees, clockwise (Z rotation for 3-D)
  opacity: AeProp<number>; // percent
  orientation?: AeProp<[number, number, number]>;
  xRotation?: AeProp<number>;
  yRotation?: AeProp<number>;
}

export interface AeLayer {
  id: string;
  name: string;
  kind: AeLayerKind;
  inPoint: number; // seconds, containing comp time
  outPoint: number;
  startTime: number;
  parent?: string;
  blendingMode: AeBlendMode;
  threeD?: boolean;
  enabled?: boolean;
  // Guide/hidden layers used as matte sources stay enabled=false in AE terms
  // (AE renders a matte source's contribution only through the matte).
  matte?: { layer: string; type: "LUMA" | "LUMA_INVERTED" | "ALPHA" | "ALPHA_INVERTED" };
  transform: AeLayerTransform;
  masks?: AeMask[];
  contents?: AeShapeItem[];
  effects?: AeEffect[];
  text?: { document: AeProp<AeTextDocument>; animators?: AeTextAnimator[]; pathMask?: number };
  // Footage id or comp id (precomp / footage layers). On a shape layer: an
  // "svg" footage id whose imported shapes (native, editable Gradient Fills
  // included) seed the contents; `contents` are then added after them.
  source?: string;
  // Solid / adjustment layers.
  solid?: { color: AeRGB; width: number; height: number };
  timeRemap?: AeProp<number>;
  // Toolbox node ids this layer came from — traceability for the report and
  // for compare_ae_renders' diagnostics. Written into the layer comment.
  origin?: string[];
}

export interface AeFootage {
  id: string;
  // Relative to the package root, forward slashes.
  path: string;
  kind: "video" | "image" | "sequence" | "svg" | "model";
  alpha: "straight" | "premultiplied" | "ignore";
  name?: string;
  fps?: number;
}

export interface AeComp {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // seconds
  bgColor?: AeRGB;
  // Top first: layers[0] is AE layer index 1. build.jsx adds bottom-up.
  layers: AeLayer[];
}

export interface AeProjectSettings {
  bitsPerChannel: 8 | 16 | 32;
  // An ICC profile description, e.g. "sRGB IEC61966-2.1"; omitted = leave AE's.
  workingSpace?: string;
  linearBlending: boolean;
  linearizeWorkingSpace?: boolean;
  expressionEngine: "javascript-1.0";
}

export interface AeReportLine {
  id: string;
  type: string;
  name?: string;
  class: AeExportClass;
  fidelity: AeFidelity;
  note?: string;
}

export interface AePlanReport {
  route: AeRoute;
  native: AeReportLine[];
  approx: AeReportLine[];
  shader: AeReportLine[];
  baked: AeReportLine[];
  blocked: AeReportLine[];
  warnings: string[];
  // What the AE user must have: host plugin version, fonts.
  requires: { shaderHost?: string; fonts: string[] };
}

export interface AeScene {
  schemaVersion: typeof AE_SCENE_SCHEMA_VERSION;
  generatedAt: string;
  toolboxVersion: string;
  project: AeProjectSettings;
  footage: AeFootage[];
  // Synthesized presets under presets/, by id → file name.
  presets: { id: string; path: string }[];
  // Precomps first, main last is NOT required: build.jsx creates every comp
  // before filling any, so precomp layers may reference any comp id.
  comps: AeComp[];
  main: string;
  report: AePlanReport;
}

// ---------------------------------------------------------------------------
// §7.3 — shader bundles for the Toolbox Shader host
// ---------------------------------------------------------------------------

// Host decision (§11.1, 2026-10-19): a C++/Metal AE effect built from the
// owner's AE_Plugins/dither skeleton (../AE_Plugins/toolbox-shader). toolbox
// translates the fused GLSL ES 3.00 to Metal Shading Language and the host
// compiles that at runtime (newLibraryWithSource), as Dither does.

export const TBX_SHADER_BUNDLE_VERSION = 1;

// The host's fixed parameter pool. Unused slots are hidden and used ones
// renamed per bundle (PF_UpdateParamUI), so scripts must address params by
// MATCH name, never by display name.
export const TBX_SHADER_POOL = { layers: 4, sliders: 32, colors: 8, points: 8, checkboxes: 8 } as const;

export type TbxShaderParamKind = "bundle" | "time" | "timeOffset" | "loopFrames" | "layer" | "slider" | "color" | "point" | "checkbox";

// Param disk IDs, fixed forever once a host ships (projects store them):
//   1 Bundle ID · 2 Time · 3 Time Offset · 4 Loop Frames
//   10–13 layers a–d · 20–51 sliders 1–32 · 60–67 colors · 70–77 points · 80–87 checkboxes
const TBX_DISK_ID_BASE: Record<TbxShaderParamKind, number> = {
  bundle: 1,
  time: 2,
  timeOffset: 3,
  loopFrames: 4,
  layer: 10,
  slider: 20,
  color: 60,
  point: 70,
  checkbox: 80,
};

export function tbxShaderDiskId(kind: TbxShaderParamKind, slot = 1): number {
  return TBX_DISK_ID_BASE[kind] + (slot - 1);
}

// AE names a third-party effect param "<effect match name>-<4-digit disk id>".
// The host lane confirms this in AE 26.5 (M3); if AE differs, fix it here only.
export function tbxShaderParamMatch(kind: TbxShaderParamKind, slot = 1): string {
  return `${TBX_SHADER_MATCH_NAME}-${String(tbxShaderDiskId(kind, slot)).padStart(4, "0")}`;
}

export interface AeShaderParam {
  // Channel name in the fused GLSL (uniform name).
  name: string;
  label: string;
  kind: "slider" | "color" | "point" | "checkbox";
  // 1-based slot in the pool of this kind (TBX_SHADER_POOL).
  slot: number;
  default: number | number[] | boolean;
  min?: number;
  max?: number;
}

export interface AeShaderBundle {
  format: "tbxfx";
  version: typeof TBX_SHADER_BUNDLE_VERSION;
  // The value build.jsx writes into the effect's Bundle ID param (a float
  // slider; keep it < 2^24). The host loads `shaders/<id>.tbxfx` relative to
  // the .aep on first use and then keeps the bundle in its sequence data, so
  // a saved project no longer needs the file.
  id: number;
  // Minimum Toolbox Shader host version that can run this bundle: an older
  // host refuses with "update Toolbox Shader" instead of rendering wrong.
  hostMin: string;
  name: string;
  // Target language → source text. `msl` is what the host compiles; `glsl`
  // (the fused GLSL ES 3.00 as proven in toolbox) is kept for traceability.
  source: Partial<Record<"glsl" | "msl", string>>;
  // Layer inputs a..d actually sampled.
  inputs: ("a" | "b" | "c" | "d")[];
  params: AeShaderParam[];
  // Static ramps / curves baked to 1-D LUT textures (RGBA, 0–1 floats).
  luts?: { name: string; width: number; data: number[] }[];
  readsTime: boolean;
  fps: number;
  loopFrames: number;
  // Toolbox canvas the shader was proven against.
  canvas: { width: number; height: number };
}
