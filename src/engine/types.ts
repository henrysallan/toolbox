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
  | "image_group"
  // Particle-engine sockets. `force`, `emitter`, and `collider` carry
  // small CPU-side descriptor structs (the actual sim runs as
  // fragment-shader GPGPU inside the Particle Simulator). `particles`
  // carries a pair of floating-point textures owned by the simulator.
  | "force"
  | "emitter"
  | "collider"
  | "particles"
  // Signed distance function. Carries an opaque AST that the SDF
  // Rasterize node compiles into a single fragment shader. SDF nodes
  // do no GL work themselves — they just build tree nodes — so any
  // chain of SDF ops costs one shader compile + one fullscreen pass
  // total at the Rasterize boundary.
  | "sdf"
  // Per-pixel position field. Carries a `PositionNode` AST that the
  // SDF compiler emits as a `vec2` GLSL expression. The pipeline is
  // strictly compile-time — no GL work happens until a shape primitive
  // (or the SDF Rasterize node, transitively) consumes it. Default
  // when unwired into a shape's position input is canvas UV.
  | "position"
  // Per-pixel scalar field. Carries a `ScalarFieldNode` AST that the
  // SDF compiler emits as a `float` GLSL expression evaluated per
  // pixel. Wire one into a position op's scalar input (Rotate.angle,
  // Twist.strength) for per-pixel/per-tile/per-anything modulation —
  // the only path to per-instance variation through a node graph (a
  // CPU scalar uniform can only carry one value per draw).
  | "scalar_field";

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
// Authoritative storage is typed-array (positions/scales/rotations/
// groupIndices). The legacy `points: Point[]` view is preserved as a
// lazily-built compatibility surface — see `src/engine/points.ts` for
// `ensurePointArray()` and the `makePoints` / `pointsFromArray` helpers
// that producers should use. Hot consumers (modulate-points, copy-to-
// points, simulation, transform feedback path) read the typed arrays
// directly to avoid per-point allocations.
export type PointsValue = {
  kind: "points";
  count: number;
  // Length = count * 2, interleaved [x0,y0, x1,y1, ...].
  positions: Float32Array;
  // Length = count * 2 if present. Absent ⇒ all [1, 1].
  scales?: Float32Array;
  // Length = count if present. Absent ⇒ all 0.
  rotations?: Float32Array;
  // Length = count if present. Absent ⇒ all 0.
  groupIndices?: Int32Array;
  // Lazy view onto the typed arrays. Producers may emit `[]` and let
  // `ensurePointArray()` build it on demand. Never mutate this without
  // also writing back into the typed arrays — they are the source of
  // truth.
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

// =====================================================================
// Particle-engine descriptors
// =====================================================================
//
// Forces and emitters are CPU-side description structs. The actual sim
// runs as a fragment-shader GPGPU pass inside the Particle Simulator —
// these descriptors are read as uniforms on each frame.
//
// Coordinate convention: positions and velocities are in normalized
// [0,1]² Y-DOWN canvas-UV space (matches every other engine value).
// "vy = 1" means "one canvas-height downward per second".
//
// New force/emitter kinds: extend the union AND the simulator's switch
// in nodes/effect/particle-simulator.ts. Both ends are in the same repo
// so the contract stays in sync.

export type ForceDescriptor =
  // Constant pull. (gx, gy) in canvas-UV/sec². Negative gy = up.
  | { kind: "gravity"; gx: number; gy: number }
  // Linear-in-velocity damping. v *= (1 - coeff * dt). 0 = no drag.
  | { kind: "drag"; coeff: number }
  // Radial force from a point. Sign +1 = repel, -1 = attract.
  // `falloff` controls 1/r^falloff (clamped, see shader).
  | {
      kind: "point";
      px: number;
      py: number;
      strength: number;
      falloff: number;
      sign: number;
      radius: number;
    }
  // Tangential swirl around a point. Strength = peak angular velocity.
  | {
      kind: "vortex";
      px: number;
      py: number;
      strength: number;
      falloff: number;
      radius: number;
    }
  // Constant directional push. (dx, dy) is the unit direction;
  // `strength` is its magnitude in canvas-UV/sec.
  | {
      kind: "wind";
      dx: number;
      dy: number;
      strength: number;
    }
  // Curl-noise turbulence. `scale` = noise frequency (cells per canvas).
  // `strength` = peak displacement velocity. `speed` advects the noise
  // field through time (so the same particle gets different noise on
  // subsequent frames).
  | {
      kind: "turbulence";
      scale: number;
      strength: number;
      speed: number;
    };

export type ForceValue = {
  kind: "force";
  descriptor: ForceDescriptor;
};

export type EmitterDescriptor =
  // Spawn near a single point each frame. `rate` = particles per second.
  // (vx, vy) seeds initial velocity; vJitter randomizes it. `spread` is
  // a positional radius around (px, py) for jittery position seeding.
  | {
      kind: "point";
      px: number;
      py: number;
      spread: number;
      rate: number;
      vx: number;
      vy: number;
      vJitter: number;
      lifetime: number;
    }
  // Spawn into pixels of a mask weighted by alpha. The simulator
  // samples the mask texture at random UVs and rejects below threshold.
  | {
      kind: "image_mask";
      mask: ImageValue;
      threshold: number;
      rate: number;
      vx: number;
      vy: number;
      vJitter: number;
      lifetime: number;
    };

export type EmitterValue = {
  kind: "emitter";
  descriptor: EmitterDescriptor;
};

// Colliders deflect particles. The simulator checks each collider per
// particle per frame and reflects velocity (or kills the particle,
// depending on the collider's `mode`).
//
// Coordinate convention: positions in [0,1]² Y-DOWN canvas-UV,
// matching forces and emitters.

export type ColliderDescriptor =
  // Circular collider. `inside`=false treats the disc as solid (particles
  // bounce off the outside); `inside`=true treats it as a contained
  // boundary (particles bounce off the inside, like a fish-tank).
  | {
      kind: "circle";
      cx: number;
      cy: number;
      radius: number;
      inside: boolean;
      restitution: number;
    }
  // Half-plane collider, defined by a unit normal (nx, ny) and a
  // signed offset `d`. The plane equation is `n · p = d`; the
  // collider blocks points with `n · p < d` (the side opposite the
  // normal). For "ground at y=0.9", set normal=(0, -1), d=-0.9.
  | {
      kind: "line";
      nx: number;
      ny: number;
      d: number;
      restitution: number;
    }
  // Image-mask collider. The mask's alpha channel (above `threshold`)
  // is treated as solid. Particles entering an opaque pixel either
  // bounce (using a sampled gradient as the surface normal) or die.
  | {
      kind: "image_mask";
      mask: ImageValue;
      threshold: number;
      restitution: number;
      kill: boolean;
    };

export type ColliderValue = {
  kind: "collider";
  descriptor: ColliderDescriptor;
};

// Particle state held in floating-point textures, ping-ponged each
// frame inside the Particle Simulator. `width × height` gives the layout
// (pixel index = particle index); `count = width × height` is the
// allocation cap, not the live particle count (dead slots have age=0
// and are eligible for respawn).
//
// Channel layout:
//   positionTex.RGBA = (pos.x, pos.y, age, lifetime)   — age 0 = dead
//   velocityTex.RGBA = (vel.x, vel.y, _, _)
export type ParticlesValue = {
  kind: "particles";
  positionTex: WebGLTexture;
  velocityTex: WebGLTexture;
  width: number;
  height: number;
  count: number;
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
  | ImageGroupValue
  | ForceValue
  | EmitterValue
  | ColliderValue
  | ParticlesValue
  | SdfValue
  | PositionValue
  | ScalarFieldValue;

// SDF AST. Every SDF node's compute() returns one of these — a small
// data tree, no GL work. The Rasterize node walks the tree, emits a
// single GLSL shader, compiles it (once per tree-shape via the shader
// cache), and binds the leaf parameters as uniforms each frame.
//
// Coordinates are in normalized canvas-UV [0, 1]² Y-DOWN, matching
// every other engine value. Distances are also in canvas-UV units —
// a circle with radius 0.2 covers 20% of the canvas width.
// Per-pixel scalar AST. Compiles to a `float` GLSL expression
// evaluated per pixel. Wire into a position op's scalar input
// (Rotate.angle, Twist.strength) to get true per-pixel modulation.
// `noise` samples noise at a position pipeline; `constant` wraps a
// CPU scalar (so a uniform `scalar_field` slot can be partially
// upgraded — same socket, varying behavior).
export type ScalarFieldNode =
  | { kind: "constant"; value: number }
  | {
      kind: "noise";
      position: PositionNode;
      noiseType: "simplex" | "perlin" | "value";
      scale: number;
      octaves: number;
      persistence: number;
      lacunarity: number;
      offsetX: number;
      offsetY: number;
      seed: number;
      // 4D evolution parameter — same slice-blend trick the image
      // and value paths use. Optional so old graphs (and consumers
      // that don't expose W) keep rendering identically.
      w?: number;
      // Linear remap applied after the fbm sample so users don't
      // have to chain a separate Math/Remap. Defaults to identity
      // (lo=-1, hi=1, out=[-1,1]).
      outLo: number;
      outHi: number;
    }
  // Linear remap of a child field. Used by the Remap node's
  // scalar_field path so existing graphs that drop a Remap between
  // a Noise.field and a downstream consumer keep working — same
  // params, same math, just inlined into the SDF shader.
  | {
      kind: "remap";
      child: ScalarFieldNode;
      inMin: number;
      inMax: number;
      outMin: number;
      outMax: number;
      clamp: boolean;
    }
  // Math operation on 1–3 field children. `op` is the same string
  // enum the Math node uses; `clamp` mirrors Math's "Clamp to 0–1"
  // toggle. Field-graph-version of Math — emits the corresponding
  // GLSL expression inline so chained Math nodes inside an SDF
  // graph compile to a single fragment shader, not a chain of
  // intermediate textures.
  | {
      kind: "mathOp";
      op: string;
      a: ScalarFieldNode;
      b: ScalarFieldNode;
      c: ScalarFieldNode;
      clamp: boolean;
    };

// Per-pixel position AST. Compiles to a GLSL `vec2` expression. Each
// shape primitive carries a PositionNode; chaining position operators
// (Translate, Repeat, Mirror, etc.) builds nested expressions that
// fold the per-pixel position before the shape evaluates against it.
//
// `canvasUv` is the identity — the bare per-pixel UV. It's the
// default when a shape's `position` input is unwired.
export type PositionNode =
  | { kind: "canvasUv" }
  | { kind: "translate"; child: PositionNode; tx: number; ty: number }
  | {
      kind: "scale";
      child: PositionNode;
      sx: number;
      sy: number;
      cx: number;
      cy: number;
    }
  // Rotation in radians around (cx, cy). When `rotation` is a
  // ScalarFieldNode, the per-pixel field value drives the angle
  // (used for per-tile / per-cell / per-pixel rotation variation).
  | {
      kind: "rotate";
      child: PositionNode;
      rotation: number | ScalarFieldNode;
      cx: number;
      cy: number;
    }
  // Tile the coordinate space. Cost is O(1) regardless of tile count.
  // Jitter fields (`rotJitter` / `posJitterX/Y` / `scaleJitter`) hash
  // the cell ID inside the GLSL fold so each tile gets independent
  // pseudo-random rotation / offset / scale. When all jitter values
  // are 0 the helper degenerates to a plain tile fold.
  | {
      kind: "repeat";
      child: PositionNode;
      spacingX: number;
      spacingY: number;
      cx: number;
      cy: number;
      bounded: boolean;
      limitX: number;
      limitY: number;
      rotJitter?: number;
      posJitterX?: number;
      posJitterY?: number;
      scaleJitter?: number;
      seed?: number;
    }
  // Per-pixel cell ID for a Repeat-style fold. Returns the integer
  // cell index as a vec2 (constant within a tile, varies between
  // tiles). Used as the `position` input to SDF Noise to drive
  // per-tile variation.
  | {
      kind: "cellId";
      child: PositionNode;
      spacingX: number;
      spacingY: number;
      cx: number;
      cy: number;
    }
  | {
      kind: "mirror";
      child: PositionNode;
      // Bitmask: 1 = mirror X, 2 = mirror Y, 3 = both.
      axis: 1 | 2 | 3;
      cx: number;
      cy: number;
    }
  // N-fold rotational symmetry. `rotation` rotates the sector boundary.
  | {
      kind: "polar";
      child: PositionNode;
      cx: number;
      cy: number;
      segments: number;
      rotation: number;
    }
  // Spiral around (cx, cy) by `strength` radians per unit distance.
  // `strength` accepts a per-pixel scalar field for per-pixel /
  // per-tile twist variation.
  | {
      kind: "twist";
      child: PositionNode;
      cx: number;
      cy: number;
      strength: number | ScalarFieldNode;
    };

export type PositionValue = {
  kind: "position";
  root: PositionNode;
};

export type ScalarFieldValue = {
  kind: "scalar_field";
  root: ScalarFieldNode;
};

// SDF AST. Shape primitives carry an explicit `position` field — the
// position pipeline that produces this shape's per-pixel sample
// coordinate. Default for `position` is `{ kind: "canvasUv" }`.
//
// Domain-style operators (Translate / Rotate / Repeat / etc.) used to
// live on the SDF tree as wrappers, but they're now in the position
// pipeline. The SDF tree is purely about distance composition
// (booleans, smoothing, modifiers).
export type SdfNode =
  // Sentinel for "no input wired". Emits a very large positive
  // distance so combiners degrade gracefully (Union with empty = the
  // other side; Intersection with empty = empty).
  | { kind: "empty" }
  | { kind: "circle"; position: PositionNode; cx: number; cy: number; r: number }
  | {
      kind: "rect";
      position: PositionNode;
      cx: number;
      cy: number;
      sx: number;
      sy: number;
      cornerRadius: number;
    }
  | {
      kind: "lineSegment";
      position: PositionNode;
      ax: number;
      ay: number;
      bx: number;
      by: number;
      r: number;
    }
  | {
      kind: "polygon";
      position: PositionNode;
      cx: number;
      cy: number;
      r: number;
      // Sides is polymorphic — number for a fixed-side polygon, or
      // a ScalarFieldNode for per-pixel/per-tile variation. When the
      // field is active, `quantizeSides` rounds the per-pixel value
      // to an integer so you get clean 3/4/5-sided polygons rather
      // than smooth interpolations.
      sides: number | ScalarFieldNode;
      quantizeSides?: boolean;
    }
  | {
      kind: "triangle";
      position: PositionNode;
      ax: number;
      ay: number;
      bx: number;
      by: number;
      cx: number;
      cy: number;
    }
  | {
      kind: "star";
      position: PositionNode;
      cx: number;
      cy: number;
      r: number;
      sides: number;
      sharpness: number;
    }
  // Distance to a flattened spline (pre-subdivided line segments
  // packed into an RGBA32F data texture). Each texel holds one
  // segment as vec4(ax, ay, bx, by). When `closed` is true, sign
  // comes from a horizontal-ray winding count; when false, distance
  // is unsigned (acts like a stroke). The texture lives on the
  // runtime AST node — never serialized.
  | {
      kind: "splineSdf";
      position: PositionNode;
      segmentTexture: WebGLTexture;
      segCount: number;
      closed: boolean;
    }
  // Sampled distance field from a precomputed image (typically a
  // JFA-derived signed distance). The texture's R channel holds
  // values in [0, 1] with 0.5 = boundary; `range` un-normalizes
  // back to canvas-UV signed distance: `d = (R - 0.5) * 2 * range`.
  // The Y axis is flipped inside the helper to match the JFA's
  // y-up texture convention vs the SDF graph's y-down position
  // pipeline. Used by the Text node to expose its JFA distance
  // field as a first-class sdf socket.
  | {
      kind: "sdfFromImage";
      position: PositionNode;
      image: WebGLTexture;
      range: number;
    }
  | { kind: "union"; a: SdfNode; b: SdfNode }
  | { kind: "intersection"; a: SdfNode; b: SdfNode }
  | { kind: "subtraction"; a: SdfNode; b: SdfNode }
  | { kind: "smoothUnion"; a: SdfNode; b: SdfNode; k: number }
  | { kind: "smoothIntersection"; a: SdfNode; b: SdfNode; k: number }
  | { kind: "smoothSubtraction"; a: SdfNode; b: SdfNode; k: number }
  | { kind: "round"; child: SdfNode; r: number }
  | { kind: "onion"; child: SdfNode; thickness: number }
  // Sample an image's red channel at the rendered position and add
  // `(v - 0.5) * 2 * amount` to the distance. The image lives on the
  // runtime AST node — never serialized.
  | { kind: "displace"; child: SdfNode; amount: number; image: ImageValue };

export type SdfValue = {
  kind: "sdf";
  root: SdfNode;
};

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
  | "font_variations"
  | "video_file"
  | "paint"
  | "merge_layers"
  | "color_ramp"
  | "curves"
  | "spline_anchors"
  | "svg_file"
  | "audio_file";

// One axis declared by a variable font's `fvar` table. Surfaced in
// FontParamValue.axes when the user uploads a variable .ttf/.otf;
// drives the per-axis sliders the Text node renders. Tag is the
// 4-char OpenType tag (wght / wdth / slnt / opsz / GRAD / …); name
// is the human label resolved from the font's name table at parse
// time, with a fallback to a built-in alias for known tags.
export interface FontAxis {
  tag: string;
  name: string;
  min: number;
  max: number;
  default: number;
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
  // Variation axes declared by the font's `fvar` table. Empty /
  // undefined when the font isn't variable (or the format isn't
  // parseable — e.g. WOFF2). Drives the per-axis sliders the Text
  // node renders.
  axes?: FontAxis[];
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

// Passed to resolveInputs / resolvePrimaryOutput so polymorphic nodes
// can retype themselves based on what's actually wired into them.
// `connectedTypes[inputName]` is the resolved primary/aux output type
// of whatever's wired into that input socket, or undefined if nothing
// is wired. The evaluator computes this in topological order, so the
// source's type is already finalized by the time this is queried.
export interface ResolveCtx {
  connectedTypes: Record<string, SocketType | undefined>;
}

export interface NodeDefinition {
  type: string;
  name: string;
  category: NodeCategory;
  // Only meaningful for typed categories (image/spline/point/audio).
  // Top-level utility/effect/output ignore it.
  subcategory?: NodeSubcategory;
  description?: string;
  // Which GPU API this node uses. Today almost every node is "webgl2";
  // "webgpu" is reserved for compute-heavy nodes that own their own
  // WebGPU pipeline (Phase 0: WebGPU Particle Test). The evaluator
  // does not yet bucket by this — Phase 1+ will use it to schedule a
  // WebGPU pass after the WebGL2 pass each frame (see
  // specdocs/webgpu-particles.md).
  backend: "webgl2" | "webgpu";
  terminal?: boolean;
  // When false, the evaluator will not cache this node's output — it is
  // assumed to read time or other external state that isn't captured by its
  // params/inputs fingerprint. Defaults to true (cacheable).
  stable?: boolean;
  inputs: InputSocketDef[];
  // Optional: derive the active input socket list from params and from
  // the source-output types of any currently-wired edges. The
  // `connectedTypes` map is keyed by input socket name and populated
  // by the evaluator before this is called — undefined entries mean
  // "nothing wired into that socket". Use it for input-driven socket
  // retyping (e.g. Math morphing between scalar / scalar_field based
  // on what the user pipes in). Falls back to static `inputs` when
  // omitted.
  resolveInputs?: (
    params: Record<string, unknown>,
    ctx?: ResolveCtx
  ) => InputSocketDef[];
  params: ParamDef[];
  primaryOutput: SocketType | null;
  // Optional: derive the primary output socket type from current
  // params and connected source types. Same `connectedTypes` map as
  // resolveInputs. Used by polymorphic nodes (Math returning
  // scalar_field when any input is wired with a field, etc.). Falls
  // back to `primaryOutput` when omitted.
  resolvePrimaryOutput?: (
    params: Record<string, unknown>,
    ctx?: ResolveCtx
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
  // Project-time scalars. `tick` is the integer subframe time
  // (`ticksPerFrame` per frame, default 1000). `time` is seconds and
  // `frame` is the integer frame index — both derived from tick.
  // Existing nodes consume `time` / `frame`; new code (keyframe
  // evaluator, Track Editor) should prefer `tick` so equality with
  // stored keyframe ticks is exact.
  time: number;
  frame: number;
  tick: number;
  ticksPerFrame: number;
  fps: number;
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
  // ===================================================================
  // WebGPU / WebGL2 interop bridges
  // ===================================================================
  // The engine is primarily WebGL2 — that's where rendering and most
  // existing nodes live. Some nodes (heavy compute kernels: particle
  // sims, neighbor lookups, sort, scan) benefit from WebGPU's compute
  // shaders. The pattern: a node calls getWebGPUDevice() to lazily
  // boot a WebGPU device; runs its compute pass; then bridges results
  // back to WebGL via readImageToFloat32 / uploadFloat32ToTexture (or
  // the inverse for WebGL → WebGPU).
  //
  // Both bridges are CPU-mediated for v1 (one Float32Array hop). True
  // GPU-shared-memory interop (importing a GPUTexture into WebGL or
  // vice-versa) requires platform extensions that aren't available in
  // browsers yet. The Float32 hop is fast for ≤ ~1MB of float data,
  // which covers up to ~64k 4-channel pixels per readback.

  // Returns a WebGPU device, or null if the browser/hardware doesn't
  // expose one. Cached after the first successful call. Async because
  // device creation requires an awaited adapter request.
  getWebGPUDevice(): Promise<GPUDevice | null>;

  // Read every pixel of an RGBA16F-or-RGBA8 image back as a flat
  // Float32Array of length width*height*4. Forces a sync GPU stall —
  // expensive, use sparingly. RGBA8 sources scale 0..255 → 0..1 so
  // the consumer doesn't have to branch on internal format.
  readImageToFloat32(image: ImageValue): Float32Array;

  // Inverse of readImageToFloat32: upload a Float32Array into a fresh
  // RGBA16F image. Length must equal width*height*4. Caller owns the
  // returned image — release it via ctx.releaseTexture(img.texture)
  // when done.
  uploadFloat32ToImage(
    data: Float32Array,
    width: number,
    height: number
  ): ImageValue;
}
