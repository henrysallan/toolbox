export type SocketType =
  | "image"
  | "mask"
  | "uv"
  | "vector"
  | "scalar"
  | "vec2"
  | "vec3"
  | "vec4"
  | "spline"
  | "points"
  | "audio"
  | "image_group";

export type ImageValue = {
  kind: "image";
  texture: WebGLTexture;
  width: number;
  height: number;
};

export type MaskValue = {
  kind: "mask";
  texture: WebGLTexture;
  width: number;
  height: number;
};

// Per-pixel UV field. R channel stores u, G stores v. Backed by the same
// half-float RGBA texture allocation as images so values outside [0, 1]
// keep precision — essential for warps that sample past the frame edge.
export type UvValue = {
  kind: "uv";
  texture: WebGLTexture;
  width: number;
  height: number;
};

export type ScalarValue = { kind: "scalar"; value: number };
export type Vec2Value = { kind: "vec2"; value: [number, number] };
export type Vec3Value = { kind: "vec3"; value: [number, number, number] };
export type Vec4Value = {
  kind: "vec4";
  value: [number, number, number, number];
};

// Authoring-space spline. Anchors hold CPU-side control points in normalized
// [0,1]² coordinates with Y-DOWN orientation (row 0 at top) so the pen-tool
// overlay and 2D canvas rasterization line up without a flip. Handle offsets
// are relative to their anchor's position, also in normalized space. A curve
// segment from anchor A to B uses the cubic { A.pos, A.pos+A.outHandle,
// B.pos+B.inHandle, B.pos }; missing handles collapse the CP to the anchor
// itself, producing a straight line.
//
// A SplineValue carries MULTIPLE subpaths — SVGs routinely contain
// disconnected regions (the dot on an "i", the inner hole of an "O") and
// downstream nodes that iterate paths need to treat each one independently.
// The Spline Draw node authors a single subpath; SVG Source emits as many
// as its source file has.
export interface SplineAnchor {
  pos: [number, number];
  inHandle?: [number, number];
  outHandle?: [number, number];
}
export interface SplineSubpath {
  anchors: SplineAnchor[];
  closed: boolean;
  // Optional per-item identity tag assigned by the Group node when
  // multiple splines were combined into this one. Downstream
  // per-index operations (Select by Index, Count Indices, Copy-to-
  // Points' pick-source mode) key off this. Undefined means the
  // subpath isn't group-tagged; treat it as its own implicit group
  // or ignore entirely depending on the operation.
  groupIndex?: number;
}
export type SplineValue = {
  kind: "spline";
  subpaths: SplineSubpath[];
};

// CPU-side list of points in normalized [0,1]² Y-DOWN. Each point carries
// an optional rotation (radians) and scale so Copy-to-Points can emit
// meaningful variation — a scattered forest of trees wants per-instance
// rotation; animating rockets along a path wants per-instance orientation
// aligned to the tangent. Consumers that don't care can ignore them.
export interface Point {
  pos: [number, number];
  rotation?: number;
  scale?: [number, number];
  // Same group-identity semantics as SplineSubpath.groupIndex —
  // assigned by the Group node when point sets are combined. See
  // the comment there for details.
  groupIndex?: number;
}
export type PointsValue = {
  kind: "points";
  points: Point[];
};

// Audio stream reference. Carries a live HTMLAudioElement that's either
// driving an uploaded file or a microphone MediaStream. The element plays
// its audio to the system's default output by itself — routing through
// the node graph just means "this audio is active while the graph
// evaluates it." Downstream nodes (filters, analyzers) would process
// ctx.state rather than exchange data through the value.
export type AudioValue = {
  kind: "audio";
  element: HTMLAudioElement;
  source: "file" | "mic";
};

// Homogeneous image collection. Carries an ordered list of images —
// `items[i]` always exists and is non-null up to the length.
// Consumers index in via Select by Index, collapse via Merge Group,
// or iterate via Foreach (coming in a follow-up).
//
// Splines and points don't need a parallel "_group" type: their base
// values already carry a collection (SplineValue.subpaths, PointsValue.
// points). Group-identity there rides on the optional `groupIndex`
// field on each SplineSubpath / Point. Only images — which are a
// single texture each — need a separate group wrapper.
export type ImageGroupValue = {
  kind: "image_group";
  items: ImageValue[];
};

export type SocketValue =
  | ImageValue
  | MaskValue
  | UvValue
  | ScalarValue
  | Vec2Value
  | Vec3Value
  | Vec4Value
  | SplineValue
  | PointsValue
  | AudioValue
  | ImageGroupValue;

export interface NodeOutput {
  primary?: SocketValue;
  aux?: Record<string, SocketValue>;
}

export interface InputSocketDef {
  name: string;
  label?: string;
  type: SocketType;
  required: boolean;
  defaultValue?: SocketValue;
}

export interface OutputSocketDef {
  name: string;
  type: SocketType;
  description?: string;
  // Renders the socket but refuses connections and paints it muted. Used as
  // a signpost for features that aren't implemented yet.
  disabled?: boolean;
}

export type ParamType =
  | "scalar"
  | "vec2"
  | "vec3"
  | "vec4"
  | "color"
  | "boolean"
  | "enum"
  | "string"
  | "file"
  | "font"
  | "video_file"
  | "paint"
  | "merge_layers"
  | "color_ramp"
  | "curves"
  | "timeline_curve"
  | "spline_anchors"
  | "svg_file"
  | "audio_file";

// Authored curve for the Timeline node. Stored as a sequence of control
// points sorted by x in [0,1]; the first must be at x=0 and the last at x=1.
// y is typically in [0,1] but not hard-clamped — the editor allows overshoot.
// Each point carries a left/right bezier handle relative to its position
// and a handle mode that constrains how the two move together.
export type TimelineCurveHandleMode =
  | "aligned"
  | "mirrored"
  | "free"
  | "vector";

export interface TimelineCurvePoint {
  x: number;
  y: number;
  handleMode: TimelineCurveHandleMode;
  leftHandle: { dx: number; dy: number };
  rightHandle: { dx: number; dy: number };
}

export interface TimelineCurveValue {
  controlPoints: TimelineCurvePoint[];
}

export interface AudioFileParamValue {
  // Persistent HTMLAudioElement bound to an ObjectURL — kept alive for
  // the tab's lifetime. Audio Source plays it directly; the element
  // emits sound to the system default output without going through
  // WebAudio. Not serializable: save/load stores null and the user
  // re-picks the file on reload (same as VideoFileParamValue).
  element: HTMLAudioElement;
  url: string;
  filename?: string;
  duration: number;
}

export interface VideoFileParamValue {
  // Live <video> element bound to an ObjectURL; kept alive for the lifetime
  // of the tab. Texture upload samples whatever frame the element is
  // currently showing, and the registration helper wires per-frame
  // pipeline-bumps so downstream nodes re-evaluate on new frames.
  video: HTMLVideoElement;
  url: string;
  filename?: string;
  duration: number;
  width: number;
  height: number;
}

export interface FontParamValue {
  // Synthetic @font-face family name registered via `document.fonts`. Lives
  // for the lifetime of the tab; not persisted across save/load.
  family: string;
  // Original filename (for display — e.g. "MyCustom-Regular.otf").
  filename?: string;
}

export interface PaintParamValue {
  canvas: HTMLCanvasElement;
  snapshot: ImageBitmap | null;
}

// Parsed SVG payload. All geometry is normalized to cubic-bezier subpaths at
// import time (see lib/svg-parse). Anchor positions are in [0,1]² Y-DOWN,
// pre-fit to the source viewBox preserving aspect — downstream transforms
// then operate on top of that normalized frame.
export interface SvgFileParamValue {
  subpaths: SplineSubpath[];
  filename?: string;
  // Source viewBox aspect, for reference. The subpaths are already normalized
  // to fit inside [0,1]², so this is informational (e.g. for a future
  // "original size" restore button).
  aspect: number;
}

export interface ParamDef {
  name: string;
  label?: string;
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  // Soft upper bound for scalar sliders. When present the range input caps
  // here, but the number input and stored value are only bounded by `max`
  // (or unbounded if `max` is absent). Useful for params with a "normal"
  // working range and an escape hatch for extreme values.
  softMax?: number;
  default: unknown;
  options?: string[];
  // Placeholder text for string-type params when the value is empty.
  placeholder?: string;
  // For "string" params: render a textarea instead of a single-line input.
  multiline?: boolean;
  hidden?: boolean;
  // Optional predicate over the node's current params. Returning false hides
  // the row in the UI without affecting the underlying stored value.
  visibleIf?: (params: Record<string, unknown>) => boolean;
}

export interface ComputeArgs {
  inputs: Record<string, SocketValue | undefined>;
  auxIn: Record<string, Record<string, SocketValue | undefined>>;
  params: Record<string, unknown>;
  ctx: RenderContext;
  nodeId: string;
}

// Top-level bucket in the Node menu. Nodes of `image` / `spline` /
// `point` / `audio` type additionally declare a `subcategory` so the
// menu can split them into Generator / Modifier / Utility columns.
// `utility`, `effect`, and `output` are flat (no subcategory).
//
// Classification rule: use the node's *purpose* as seen by the user,
// which is usually its primary output — but for nodes that consume one
// type and extract/transform into another (stroke, object-tracker,
// fill, sample-along-path), classify by the primary input. Examples
// are in specdocs/devlist.md.
export type NodeCategory =
  | "image"
  | "spline"
  | "point"
  | "audio"
  | "utility"
  | "effect"
  | "output";

export type NodeSubcategory = "generator" | "modifier" | "utility";

export interface NodeDefinition {
  type: string;
  name: string;
  category: NodeCategory;
  // Only meaningful for typed categories (image/spline/point/audio).
  // Top-level utility/effect/output ignore it.
  subcategory?: NodeSubcategory;
  description?: string;
  backend: "webgl2";
  terminal?: boolean;
  // When false, the evaluator will not cache this node's output — it is
  // assumed to read time or other external state that isn't captured by its
  // params/inputs fingerprint. Defaults to true (cacheable).
  stable?: boolean;
  inputs: InputSocketDef[];
  // Optional: derive the active input socket list from params (for nodes with
  // a user-extensible number of inputs). Falls back to static `inputs`.
  resolveInputs?: (params: Record<string, unknown>) => InputSocketDef[];
  params: ParamDef[];
  primaryOutput: SocketType | null;
  // Optional: derive the primary output socket type from current params. Used
  // by nodes whose output kind depends on a mode param (e.g. Math switching
  // between scalar and UV). Falls back to `primaryOutput` when absent.
  resolvePrimaryOutput?: (
    params: Record<string, unknown>
  ) => SocketType | null;
  auxOutputs: OutputSocketDef[];
  // Optional: derive the active aux output list from params. Parallel to
  // `resolveInputs` — used by nodes whose visible output sockets depend on a
  // toggle (e.g. Spline Draw only exposes its image aux when stroke or fill
  // is on). Falls back to the static `auxOutputs` when absent.
  resolveAuxOutputs?: (params: Record<string, unknown>) => OutputSocketDef[];
  // When true, EffectsApp renders the on-canvas transform gizmo while this
  // node is selected. Nodes must expose `translateX/translateY/scaleX/scaleY/
  // rotate/pivotX/pivotY` params for the gizmo to have something to drive.
  supportsTransformGizmo?: boolean;
  // Pairs of params that the user can chain-lock so editing one updates
  // the other proportionally. Both params must be type:"scalar". The
  // pair key is `${a}:${b}` (using the order declared here); state lives
  // on `NodeDataPayload.linkedParams[key]` as the captured ratio
  // `b / a` at link time. The UI renders a chain icon next to both rows.
  linkedPairs?: { a: string; b: string }[];
  // Render a specific enum param as a compact dropdown on the node's
  // header, in addition to its normal row in the params panel. Used by
  // the Group family (Group / Pick / Length) so users can flip
  // image/spline/points modes without opening the panel — the mode
  // choice retypes the node's sockets, so quick access matters.
  headerControl?: { paramName: string };
  consumes?: string[];
  init?: (ctx: RenderContext, nodeId: string) => void;
  compute: (args: ComputeArgs) => NodeOutput | void;
  dispose?: (ctx: RenderContext, nodeId: string) => void;
  // Returns a string that's appended to this node's fingerprint. Lets a
  // node key its cache on external state that isn't in params or inputs —
  // e.g. the Cursor node reflects `ctx.cursor` so downstream caches bust
  // when the pointer moves. Return an empty string for "no extra".
  fingerprintExtras?: (
    params: Record<string, unknown>,
    ctx: RenderContext
  ) => string;
}

// Pointer position in canvas-normalized UV. `active` is true while the
// cursor is inside the preview canvas's rendered box; false otherwise
// (cursor outside canvas, window unfocused, etc.). Nodes that care about
// the cursor should read this each compute — it always reflects the
// latest pointer position when evaluation fires.
export interface CursorState {
  x: number;
  y: number;
  active: boolean;
}

export interface RenderContext {
  gl: WebGL2RenderingContext;
  width: number;
  height: number;
  time: number;
  frame: number;
  // Whether the scene's RAF playback is active right now. Used by
  // time-sensitive sources (Audio, Video) to decide whether to play or
  // pause their media elements; image-only nodes can safely ignore it.
  playing: boolean;
  cursor: CursorState;
  state: Record<string, unknown>;
  allocImage(opts?: { width?: number; height?: number }): ImageValue;
  allocMask(opts?: { width?: number; height?: number }): MaskValue;
  allocUv(opts?: { width?: number; height?: number }): UvValue;
  releaseTexture(tex: WebGLTexture | null | undefined): void;
  drawFullscreen(
    program: WebGLProgram,
    target: ImageValue | MaskValue | UvValue | null,
    setup?: (gl: WebGL2RenderingContext) => void
  ): void;
  clearTarget(
    target: ImageValue | MaskValue | UvValue,
    rgba?: [number, number, number, number]
  ): void;
  getShader(key: string, fragSrc: string): WebGLProgram;
  blitToCanvas(image: ImageValue, targetCanvas: HTMLCanvasElement): void;
  // Renders the image to the backend's internal WebGL canvas at the
  // requested size and returns that canvas. MediaPipe + other GPU
  // consumers can sample it directly over WebGL→WebGL channels, no
  // CPU readback. The internal canvas is scratch — its content is
  // overwritten by the next blit call, so consumers must read it
  // synchronously before yielding.
  blitToGLCanvas(
    image: ImageValue,
    width: number,
    height: number
  ): HTMLCanvasElement;
}
