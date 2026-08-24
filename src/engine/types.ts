import type { Object3DValue, CameraValue } from "./three-types";
import type { TextStyle } from "./text-raster";
import type { ColorRampInterp, ColorRampStop } from "./color-ramp";

export type SocketType =
  | "image"
  | "mask"
  | "uv"
  | "vector"
  | "scalar"
  | "vec2"
  | "vec3"
  | "vec4"
  // Plain CPU string. Carries a StringValue (a JS string). Produced by the
  // String node and by any string-typed param exposed as an input socket
  // (Text's `text`, Output's filename, etc.); drives those same string params
  // when wired. No cross-type coercions — string wires only meet string
  // sockets.
  | "string"
  | "spline"
  | "points"
  | "audio"
  // Symbolic note events (a NotesValue) — the "vector" side of the audio
  // pipeline, as `spline` is to `image`. Produced by note-domain nodes
  // (Step Pattern, later the sequencer/piano-roll); consumed by instrument
  // nodes, which are the audio "rasterizers" (notes in → audio out). Note
  // times are integer ticks (the keyframe/clip timebase). Data-only, no
  // cross-type coercions. Spec: specdocs/080826_audio-nodes.md.
  | "notes"
  | "image_group"
  // Ordered, possibly-mixed collection of socket values (see ListValue).
  // Produced by the List node; consumed by the list transform nodes. Like
  // `image_group` it holds BORROWED references — the producing node's cache
  // entry owns any textures inside, so a list op must never release them
  // (engine/list-value.ts documents the contract). No coercions: with mixed
  // items there's no honest list→anything, so every conversion is a node.
  | "list"
  // Live, still-editable text. Carries a TextInstanceValue — a resolved
  // base TextStyle + a set of variant strings — so text can be placed and
  // varied per-copy (string / size / weight / leading / font) *before* it's
  // committed to a raster. Produced by the Text node's `instances` aux;
  // consumed by Copy to Points (which retypes its `instance` socket to it,
  // picks a string per copy, applies per-copy typographic modulation, and
  // re-rasterizes). Data-only, no cross-type coercions (like `string`).
  | "text_instance"
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
  | "scalar_field"
  // Render reference. Carries no pixels — it's an organizational link
  // from an Output node's `render` aux output into a Render Queue node,
  // marking that output as a queue item. The evaluator deliberately
  // ignores `render` edges when computing what to evaluate, so the queue
  // stays inert until the user presses Render.
  | "render"
  // Intrinsically-sized renderable (see ElementValue). Carries deferred
  // measure/render closures instead of a texture, so Auto Layout can ask
  // "how big do you want to be?" before any GL work happens — the SDF
  // precedent of runtime-only data with the terminal node doing the
  // rendering. Plain `image` wires coerce both ways (coerce.ts).
  | "element"
  // 3D scene sockets (M1). Carry references to retained three.js objects
  // (object3d) or a CPU camera descriptor (camera). Runtime-only — see
  // engine/three-types.ts. The 3D context renders these to an `image` at
  // its Scene Render / Scene Output boundary. `geometry` and `material`
  // join in M2.
  | "object3d"
  | "camera"
  // A colour ramp as a value (see ColorRampValue) — a CPU descriptor, no
  // texture, in the same shape as sdf/position/force. Produced by the Color
  // Ramp node's `ramp` aux output; consumed by every `color_ramp` PARAM, all
  // of which become exposable the moment paramSocketType maps this type
  // (graph-helpers.ts). That's what lets one authored palette drive Stroke's
  // colour, Rasterize Spline's fill AND stroke ramps, Ascii, Diffusion
  // Curves… instead of each node carrying a hand-rebuilt copy.
  // Spec: 080526_on-node-color-ramp.md.
  | "color_ramp";

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
export type StringValue = { kind: "string"; value: string };
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
  // Stable identity (spec 072726 M6): minted by every editor op that
  // creates an anchor (short random slug); pre-existing anchors get one
  // lazily when per-anchor animation first touches them. Keys the
  // per-anchor keyframe tracks (anchor_p/in/out:<id> — conventions.ts) so
  // animation survives reordering/inserts. Optional — plain JSON, no
  // migration; geometry never reads it.
  id?: string;
  pos: [number, number];
  inHandle?: [number, number];
  outHandle?: [number, number];
  // Editor-only authoring hint: when true the two handles are "broken"
  // (independent) — dragging one in the pen tool doesn't mirror the other.
  // Falsy = smooth (the default), where a handle drag mirrors its partner.
  // The rasterizer ignores this entirely; it only reads inHandle/outHandle.
  broken?: boolean;
  // Live corner radius (Spline Draw "Live Corners" — spec
  // 071926_spline-draw-authoring-upgrade.md M1). A handle-less corner anchor
  // with a positive radius is replaced by a circular fillet AT EMIT TIME
  // (roundCornersPerAnchor in spline-math.ts, applied by Spline Draw's
  // compute): the stored anchor keeps its logical sharp position, so the
  // rounding stays re-editable and the anchor count is topology-stable for
  // Path Animation morphs (the radius itself lerps in keyframes.ts).
  // Normalized units, same space as `pos`, capped per corner at half each
  // adjacent edge (matching the Round Corners node). Downstream consumers
  // never see it — the fillet has already been applied when the spline
  // leaves the node. Inert on handled (curved) anchors and open-path
  // endpoints.
  cornerRadius?: number;
  // Live corner STYLE (spec 080226_font-precision-toolkit.md M1) — how the
  // cornerRadius fillet is shaped: absent = round (the circular arc),
  // "chamfer" = a straight cut between the inset points, "scoop" = the arc
  // reflected across the chord (concave fillet). Inert without a radius;
  // Path Animation lerps the radius and snaps the style (like `broken`).
  cornerStyle?: "chamfer" | "scoop";
  // Width profile (spec 072726_spline-animation-program.md M3): a MULTIPLIER
  // on the consuming stroke's base thickness at this anchor (absent = 1).
  // Interpolated smoothly along arc length between anchors; consumed by the
  // variable-width envelope renderer (spline-width.ts) in the Stroke node
  // and the shared spline rasterizer. Authored with the Width tool (W);
  // lerps in Path Animation like cornerRadius.
  width?: number;
}
export interface SplineSubpath {
  anchors: SplineAnchor[];
  closed: boolean;
  // Optional per-item identity tag assigned by the Collect node when
  // multiple splines were combined into this one. Downstream
  // per-index operations (Select by Index, Count Indices, Copy-to-
  // Points' pick-source mode) key off this. Undefined means the
  // subpath isn't group-tagged; treat it as its own implicit group
  // or ignore entirely depending on the operation.
  groupIndex?: number;
  // Optional producer-authored per-subpath scalar in [0,1] — the
  // continuous sibling of groupIndex's discrete identity. Consumed by the
  // shared subpath-driver system (spline-color-source.ts `by: "driver"`),
  // so Rasterize/Stroke ramps and Stroke's per-subpath thickness can map
  // it. First producer: Space Fill's per-line weight
  // (072726_space-fill.md). Runtime-only, like the rest of the value.
  driver?: number;
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
  // assigned by the Collect node when point sets are combined. See
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

// Audio stream reference. Two generations live in one value
// (specdocs/080826_audio-nodes.md):
//
//   element — a live HTMLMediaElement (uploaded file / mic / video track).
//             The legacy carrier: when the value reaches the Output node's
//             `audio` socket with no processing in between, the element
//             plays element-direct exactly as before this spec.
//   chain   — an AudioChainNode descriptor: the processable signal chain.
//             Synthesis/effect nodes exchange ONLY descriptors — cheap
//             immutable CPU values; zero audio work happens in compute().
//             engine/audio-engine.ts reconciles the descriptor trees that
//             arrive each eval into a persistent Tone.js graph (and renders
//             the same descriptors offline for export). Element-backed
//             sources attach an `element`-kind leaf chain so they can enter
//             chains; pure synth chains carry no element at all.
export type AudioValue = {
  kind: "audio";
  // HTMLMediaElement (not just HTMLAudioElement) so a Video Source can flow
  // its decoded audio track through this same socket — a <video> is an
  // HTMLMediaElement and plays audio identically. Absent for pure synth
  // chains (Oscillator, instruments) — consumers that tap elements
  // (audio-analysis, coerce audio→scalar) must null-guard.
  element?: HTMLMediaElement;
  source?: "file" | "mic" | "video";
  chain?: AudioChainNode;
};

// ---------------------------------------------------------------------------
// Audio chain descriptors (specdocs/080826_audio-nodes.md)
//
// The audio analog of the SDF AST: audio node defs do ZERO audio work — they
// return one of these small immutable trees, and engine/audio-engine.ts
// reconciles the trees against a live Tone.js graph (create / dispose /
// ramp-params) once per eval. `nodeId` is the reconciliation key: it is the
// graph node's id, stable across frames, so a param tweak retunes the same
// live object instead of rebuilding it. Cache hits return the identical
// descriptor object, which lets the reconciler short-circuit on identity.
//
// INVARIANT: node defs never import Tone or touch an AudioContext. All
// execution lives behind audio-engine.ts — that is what keeps live playback
// and deterministic offline export two interpretations of one description.
// ---------------------------------------------------------------------------

export type AudioStageParamValue = number | string | boolean;
export type AudioStageParams = Record<string, AudioStageParamValue>;

// One symbolic note. Times are integer ticks (ticksPerFrame × frame — the
// keyframe/clip timebase) so note starts compare exactly against clip
// windows and keyframes; convert to seconds only at the audio boundary
// (audio-chain.ts noteEventsToSeconds).
export interface NoteEvent {
  // MIDI note number (69 = A4 = 440 Hz). Fractional values are legal and
  // read as detune.
  pitch: number;
  // 0..1.
  velocity: number;
  startTick: number;
  durationTicks: number;
  // Optional stable identity for EDITOR selection and gestures (the piano
  // roll — 080926_midi-editor.md M1). The audio engine never reads it:
  // scheduling and the reschedule diff compare the four musical fields
  // only. Minted lazily by the editor; absent on generated notes (Step
  // Pattern) and on pre-M1 saves.
  id?: string;
}

export type NotesValue = {
  kind: "notes";
  notes: NoteEvent[];
};

// An element-backed source entering a processable chain. Carries the live
// element reference (the reconciler wraps it via the SHARED element-source
// registry in audio-analysis.ts — createMediaElementSource is one-shot per
// element, so analysis taps and chains must reuse one wrap). `url` is the
// source media ObjectURL for deterministic offline decode; null = no
// offline form (mic), rendered silent in exports.
export interface AudioChainElementLeaf {
  kind: "element";
  nodeId: string;
  element: HTMLMediaElement;
  source: "file" | "mic" | "video";
  url: string | null;
  // Offline playback hints (080926 M-B): how the element maps to scene
  // time, snapshotted from the source node's params at emit time so an
  // export can re-create the audible behavior from the url alone.
  // Absent (older values): synced from 0, no loop, unity volume.
  sync?: boolean;
  loop?: boolean;
  startOffset?: number;
  volume?: number;
}

// Audio-rate modulation edge (080926_audio-v2-integration.md M-C): routes
// another chain's output INTO one of this stage's Tone Signals, where
// WebAudio SUMS it with the knob value — so a modulator's amplitude
// expresses DEVIATION in the destination param's units (the Audio LFO's
// min/max, source-side attenuation). `param` names the target; the def's
// `<param>_mod` input socket and the adapter's `modTarget(param)` must
// agree on the name. Any chain is a legal modulator.
export interface AudioChainMod {
  param: string;
  chain: AudioChainNode;
}

// Free-running signal source (no note input): oscillator, noise, player.
// `gen` is the adapter key inside audio-engine.ts.
export interface AudioChainGenerator {
  kind: "generator";
  nodeId: string;
  gen: string;
  params: AudioStageParams;
  mods?: AudioChainMod[];
}

// Notes → audio. The domain-crossing stage ("rasterizer"): the reconciler
// schedules `notes` onto the slaved transport for live playback and into
// the offline transport for export. `inst` is the adapter key.
export interface AudioChainInstrument {
  kind: "instrument";
  nodeId: string;
  inst: string;
  params: AudioStageParams;
  notes: NoteEvent[];
  mods?: AudioChainMod[];
}

// Audio → audio processor. `fx` is the adapter key.
export interface AudioChainEffect {
  kind: "effect";
  nodeId: string;
  fx: string;
  params: AudioStageParams;
  input: AudioChainNode;
  mods?: AudioChainMod[];
}

// One mixer lane. `gain` is linear, `pan` is -1..1. Solo is resolved by the
// emitting node at descriptor-build time (a soloed set mutes the rest) so
// the engine only ever sees effective gains.
export interface AudioChainMixInput {
  chain: AudioChainNode;
  gain: number;
  pan: number;
  mute: boolean;
}

// N-input summing stage (Audio Merge). Per-lane gain/pan/mute mirror the
// visual Merge node's per-layer opacity semantics.
export interface AudioChainMix {
  kind: "mix";
  nodeId: string;
  params: AudioStageParams;
  inputs: AudioChainMixInput[];
}

export type AudioChainNode =
  | AudioChainElementLeaf
  | AudioChainGenerator
  | AudioChainInstrument
  | AudioChainEffect
  | AudioChainMix;

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

// An ordered, possibly-MIXED collection of socket values — the generic
// container behind the List node family (080526_list-socket.md). Items are
// full `SocketValue`s, so a list can carry text, numbers, and (in principle)
// GPU-backed values side by side; nodes that need one item type derive it with
// `listItemType()` rather than trusting a declared field.
//
// Deliberately minimal (no `itemType`): the kinds are discoverable by
// inspection, a mixed list stays representable, and an empty list needs no
// type. Ownership: items are BORROWED, exactly like ImageGroupValue's — see
// engine/list-value.ts for the rule a list op node must follow.
export type ListValue = {
  kind: "list";
  items: SocketValue[];
};

// Live text ready to be placed at points and varied per copy. Carries a
// resolved base style plus the variant string set — NOT a raster, so a
// consumer (Copy to Points) can re-derive each copy's TextStyle (override
// size / weight / leading / font, swap the string) and rasterize per copy,
// where each copy's index / position finally exists. `base.text` is ignored
// by placement consumers — the displayed string comes from `strings`.
// v1: variants differ only by string; a future widening can carry per-variant
// style overrides.
export type TextInstanceValue = {
  kind: "text_instance";
  base: TextStyle;
  strings: string[];
};

// A colour ramp travelling as a wire. Plain CPU data — the same
// `ColorRampStop[]` every `color_ramp` param already stores, so a wired ramp
// substitutes into `params[<name>]` with no shape change at all
// (socketToParamRaw returns `stops` verbatim; consumers keep their
// `Array.isArray` check and their `sampleColorRamp` call).
//
// `interp` rides along but is NOT yet applied at the consuming end: the param
// stores a bare array and saved projects depend on that (invariant #2), so
// there is nowhere for a wired interpolation mode to land. A ramp set to
// `ease` here samples `linear` once wired into Stroke. Carried anyway so
// giving consumers an `<ramp>_interp` sibling param later is purely additive.
export type ColorRampValue = {
  kind: "color_ramp";
  stops: ColorRampStop[];
  interp: ColorRampInterp;
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

// =====================================================================
// Auto Layout / element sockets
// =====================================================================

// Constraints flow FORWARD into measure — this is how text reflow works
// without back-propagating params. All px values are canvas pixels.
export interface LayoutConstraints {
  maxWidth?: number; // undefined = unconstrained
  maxHeight?: number;
}

export interface ElementSize {
  width: number;
  height: number;
}

// How an Auto Layout slot (or the container itself, per axis) sizes:
// `fixed` = explicit layout units, `hug` = the child's natural size,
// `fill` = share of the container's leftover space.
export type SizeMode = "fixed" | "hug" | "fill";

// Intrinsically-sized renderable. Like SdfValue, this is runtime-only —
// closures and texture refs are never serialized; params on the producing
// node are the persistent state, and the fingerprint chain (producer params
// → producer fp → consumer input fp) already handles invalidation.
//
// Lifetime contract: closures are valid while the producing node's cache
// entry is alive (same as SdfValue.segmentTexture). Consumers only invoke
// them inside their own compute(), during the same eval or while
// fingerprints hold.
export type ElementValue = {
  kind: "element";
  // Natural size under constraints. Pure CPU (canvas2d measureText at
  // most). May be called several times per layout pass; must be cheap
  // and re-entrant.
  measure(constraints: LayoutConstraints): ElementSize;
  // Render content into an exactly width×height texture. CALLER OWNS the
  // returned texture and must release it after compositing. Must be safe
  // to call repeatedly (each call allocates fresh). `fit` is honored by
  // raster-content elements (wrapped images); intrinsic renderers (text,
  // nested layouts) ignore it. `alignX`/`alignY` place the content within
  // the rect when fit leaves slack (contain letterbox / cover crop) —
  // Auto Layout passes its container alignment so "center-left" leans
  // content left; default is centered.
  render(
    ctx: RenderContext,
    width: number,
    height: number,
    opts?: {
      fit?: "contain" | "cover" | "stretch";
      alignX?: "start" | "center" | "end";
      alignY?: "start" | "center" | "end";
    }
  ): ImageValue;
  // Default slot sizing when first wired (text → hug/hug, wrapped
  // full-canvas image → fixed). Advisory only.
  preferredSizing?: { width: SizeMode; height: SizeMode };
  // Present when this element wraps a plain texture (coercion or Frame
  // around an image). Lets Auto Layout's per-slot "trim" re-derive the
  // content rect from alpha. NOT owned by the element — never release.
  sourceImage?: ImageValue;
};

// One row in an Auto Layout node's `items` param — the per-slot sizing
// config for the child wired into `item:<id>`. Width/height are in layout
// units (1/1000 of the canvas's smaller dimension) and only apply in
// `fixed` mode. Plain JSON, serializes with the params blob.
export interface AutoLayoutItem {
  id: string;
  widthMode: SizeMode;
  heightMode: SizeMode;
  width: number;
  height: number;
  fit: "cover" | "contain" | "stretch";
  trim: boolean;
}

export type SocketValue =
  | ImageValue
  | MaskValue
  | UvValue
  | ScalarValue
  | StringValue
  | Vec2Value
  | Vec3Value
  | Vec4Value
  | SplineValue
  | PointsValue
  | AudioValue
  | NotesValue
  | ImageGroupValue
  | ListValue
  | TextInstanceValue
  | ForceValue
  | EmitterValue
  | ColliderValue
  | ParticlesValue
  | SdfValue
  | PositionValue
  | ScalarFieldValue
  | ElementValue
  | Object3DValue
  | CameraValue
  | ColorRampValue;

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
  // Linear interpolation of two distance fields: mix(a, b, t). At t=0 the
  // shape is A, at t=1 it's B; in between the zero-isoline sweeps smoothly
  // from one to the other (topology can change for free). `t` is a uniform,
  // so animating it never recompiles the shader.
  | { kind: "morph"; a: SdfNode; b: SdfNode; t: number }
  | { kind: "round"; child: SdfNode; r: number }
  | { kind: "onion"; child: SdfNode; thickness: number }
  // Sample an image's red channel at the rendered position and add
  // `(v - 0.5) * 2 * amount` to the distance. The image lives on the
  // runtime AST node — never serialized.
  | { kind: "displace"; child: SdfNode; amount: number; image: ImageValue }
  // Paint a subtree. Distance is untouched — this is purely the color
  // channel, consumed by the Surf emitter (sdf-compile.ts) and ignored
  // by the float emitter, so distance-only consumers (SDF to Mask /
  // to Distance Image / to Spline) see straight through it.
  //
  // Materials INHERIT: the nearest enclosing material paints every leaf
  // below it, and a nested material overrides for its own subtree (CSS
  // `fill` semantics). A tree with no material at all takes the
  // terminal's own foreground, which is why unmaterialed graphs render
  // exactly as they did before materials existed.
  //
  // Runtime-only — built in `compute` from params, never serialized,
  // same as `splineSdf`'s texture and `displace`'s image. `color` and
  // `bleed` are UNIFORMS, so keyframing them rebinds rather than
  // recompiles (structuralHash deliberately ignores their values).
  | {
      kind: "material";
      child: SdfNode;
      color: [number, number, number];
      // Weight this material's contribution to the color-bleed
      // accumulator. 1 = participates normally, 0 = paints itself but
      // adds nothing to the surrounding wash.
      bleed: number;
      // Ramp mode: colour is `lut` sampled at a per-pixel scalar field
      // instead of the flat `color`. The LUT is a 1x256 RGBA texture
      // baked from the node's stops and owned by the node (runtime-only,
      // never serialized — like splineSdf's segment texture).
      //
      // Riding a TEXTURE rather than uniform arrays is deliberate: the
      // emitted GLSL is identical for any stop count, so adding or
      // moving a stop rebakes a texture and leaves the shader cache hot,
      // and there is no uniform-budget ceiling on how many ramp
      // materials one tree can hold. Only `t`'s field topology is
      // structural.
      ramp?: { lut: WebGLTexture; t: ScalarFieldNode };
    };

export type SdfValue = {
  kind: "sdf";
  root: SdfNode;
};

export interface NodeOutput {
  primary?: SocketValue;
  aux?: Record<string, SocketValue>;
  // Set `false` when the returned texture-backed values live in the node's
  // persistent `ctx.state` (redrawn in place across evals — e.g. Text's
  // raster, a Simulation Zone's ping-pong buffer) rather than being freshly
  // allocated this compute. The evaluator then never releases them: not in
  // the universal mask/opacity post-passes, not as end-of-eval transients,
  // and not on cache eviction. State textures are torn down by the node's
  // own `dispose`. Default (absent/true): the evaluator owns the textures.
  ownsTextures?: boolean;
}

export interface InputSocketDef {
  name: string;
  label?: string;
  type: SocketType;
  required: boolean;
  defaultValue?: SocketValue;
  // Not rendered on the node (no handle, no row) — the socket exists
  // only for the evaluator to bind edges that a compile pass synthesizes
  // (e.g. the layer node's `content` input, wired by the flatten pass
  // from the layer's interior Group Output).
  hidden?: boolean;
}

export interface OutputSocketDef {
  name: string;
  // Optional display label shown on the node in place of `name`. Lets a node
  // keep a stable, machine-friendly socket id (e.g. the CSV node's positional
  // `col:<index>`) while showing a human label (the column header). Falls back
  // to `name` when absent.
  label?: string;
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
  | "image_sequence"
  | "paint"
  // Paint-node brush settings blob (BrushSettingsValue). Plain JSON, hidden
  // from the generic panel (edited via the Brush Editor window), not
  // keyframable/exposable/controllable. Spec: 071926_paint-toolkit.md.
  | "brush_settings"
  // Authored motion-track samples. Not keyframable or exposable; the
  // TrackerPanel owns the editor. Spec: 082226_motion-tracking.md §4.1.
  | "track_data"
  | "merge_layers"
  | "color_ramp"
  | "curves"
  // CurvePoint[] (engine/float-curve.ts) — a single monotone-cubic curve
  // mapping x∈[0,1] → y∈[0,1]. Generic "shape this falloff" knob (multi-
  // stroke spacing/thickness/opacity). Plain-JSON serialization, not
  // keyframable. The ParamDef `default` carries the endpoint choice —
  // defaultFloatCurve(0,1) linear ramp, defaultFloatCurve(1,1) flat
  // identity multiplier.
  | "float_curve"
  | "spline_anchors"
  | "svg_file"
  | "audio_file"
  | "lut_file"
  | "model_file"
  // CsvFileParamValue — a loaded/pasted CSV. Stored inline as raw text (the
  // `lut_file` pattern), so it round-trips through save/load with no relink.
  // The CSV node parses it (engine/csv-parse.ts) into per-column outputs.
  | "csv_file"
  | "render_queue"
  // AutoLayoutItem[] — per-slot sizing rows on the Auto Layout node
  // (merge_layers pattern: array param drives dynamic `item:<id>` sockets).
  | "autolayout_items"
  // GradientPoint[] — the Gradient node's "multipoint" mode. Like
  // merge_layers, the array itself isn't keyframable; each point's x / y /
  // color animate via virtual keys (gpoint_x/y/c:<id> — see conventions.ts).
  | "gradient_points"
  // ExprInput[] — the Expression node's named input variables. Same
  // merge_layers pattern: the array drives the node's dynamic `in:<id>`
  // sockets (one per variable) and the panel renders an editable name +
  // default per row. Not keyframable (structural). See
  // src/nodes/effect/expression.ts.
  | "expr_inputs"
  // WedgeValueItem[] — the Wedge node's explicit value list (one row per
  // batch-render variation). Plain-JSON serialization, not keyframable.
  // See src/nodes/source/wedge.ts + specdocs/archive/071026_wedge-render-batching.md.
  | "wedge_values"
  // NoteEvent[] — the MIDI Editor node's authored piano-roll clip
  // (080926_midi-editor.md). Edited exclusively in the viewport piano
  // roll (declared `hidden` on the def, like spline_anchors' on-canvas
  // editing); plain-JSON serialization, not keyframable.
  | "notes_clip";

// One named input variable on the Expression node. `name` is the JS
// identifier the bound socket value is exposed as inside the expression
// (e.g. "x"); `default` is the value used when the socket is unwired
// (defaults to 1). `id` is the stable socket key (`in:<id>`) — never reused
// across renames so wires survive a name change.
export interface ExprInput {
  id: string;
  name: string;
  // Current/default value. Number for the scalar Expression node and for
  // Point Expression's ch() channels; a string for Point Expression's pick()
  // (enum) channels.
  default?: number | string;
  // Point Expression channels only (auto-populated by the Sync button from
  // ch(…, min, max) / pick(…, ...options)) so each row renders as the standard
  // scalar slider or enum dropdown instead of a bare number field. Absent for
  // the scalar Expression node (its rows keep the simple name + number field).
  min?: number;
  max?: number;
  softMax?: number;
  step?: number;
  options?: string[]; // present ⇒ enum (dropdown); `default` is a string
}

// One row of a Wedge node's explicit value list. `value`'s runtime shape is
// keyed by the node's `type` param: number (scalar), [x,y] (vec2), RGBA hex
// string (color — same stored form as color params), or plain string. The
// scalar-only v1 UI writes numbers; the union is declared up front so the
// param type doesn't churn when the other row editors land.
export interface WedgeValueItem {
  id: string;
  value: number | string | [number, number];
}

// Imported 3D model. The Import 3D node loads the file (GLB/glTF/OBJ) and
// retains the parsed three.Object3D. Like video/audio, the live ObjectURL
// can't round-trip a save — it's stripped on serialize and the user re-picks
// (no relink yet). `format` selects which loader the node uses.
export interface ModelFileParamValue {
  url?: string; // object URL (blob:); absent after reload → re-pick
  filename: string;
  size?: number;
  format: "glb" | "gltf" | "obj";
}

// One color point of a multipoint gradient. Position is normalized UV,
// Y-UP (matching the Gradient shader's sampling space — the opposite of the
// CPU Y-DOWN convention). Color is a hex string in the stored param; a
// keyframe-resolved color may arrive as an RGBA float tuple instead (the
// engine interpolates colors as [r,g,b,a] in 0..1).
export interface GradientPoint {
  id: string;
  x: number;
  y: number;
  color: string;
}

// One row in a Render Queue node. `outputNodeId` is resolved from the wire
// on the matching `item:<id>` socket at render time (not stored), so this
// only persists the queue-local choices: render as image or video, and —
// for image items — which frame to capture the still at.
export interface RenderQueueItem {
  id: string;
  kind: "image" | "video";
  // Frame to capture for `kind: "image"`. Ignored for video (which uses
  // the output node's own frame-count param).
  frame: number;
}

// A loaded .cube 3D LUT. Stored as the raw .cube text (plus the original
// file name) so it round-trips through JSON save/load; the node parses the
// text into a GPU 3D texture lazily and caches by reference.
export interface LutFileParamValue {
  filename: string;
  text: string;
}

// A loaded/pasted CSV. Stored as raw text (plus the original file name when
// loaded from disk) so it round-trips through JSON save/load with no relink —
// same pattern as LutFileParamValue. The CSV node parses it lazily
// (engine/csv-parse.ts) and caches the parse by reference.
export interface CsvFileParamValue {
  filename?: string;
  text: string;
}

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
  // Source file byte size — identity key for the relink handle store
  // (lib/media-relink.ts) and for filename+size matching on manual relink.
  size?: number;
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
  // Source file byte size — identity key for the relink handle store
  // (lib/media-relink.ts) and for filename+size matching on manual relink.
  size?: number;
  duration: number;
  width: number;
  height: number;
}

// One frame of an image sequence loaded into the Video Source node. The
// `number` is the trailing integer parsed from the filename; frames are kept
// as ENCODED bytes (the Blob), not decoded ImageBitmaps, so a long sequence
// stays RAM-reasonable — the node decodes the current frame lazily. Not
// serialized: like video/audio, sequences relink on load (the project stores
// a lightweight per-frame descriptor and re-picks the files).
export interface ImageSequenceFrame {
  number: number;
  blob: Blob;
  filename: string;
  size: number;
}

export interface ImageSequenceParamValue {
  // Sorted ascending by `number`.
  frames: ImageSequenceFrame[];
  // Numbering bounds and the gap-honoring timeline length
  // (length = max − min + 1; missing numbers become held frames).
  min: number;
  max: number;
  length: number;
  // Dimensions of the first decoded frame (the sequence is assumed uniform).
  width: number;
  height: number;
  // Present when the frames are EXR files (magic-byte sniffed at pick time):
  // the first frame's grouped layer list, driving the Video Source node's
  // layer dropdown. Frames decode through engine/exr instead of
  // createImageBitmap. See specdocs/archive/070926_exr-color-pipeline.md.
  exr?: {
    layers: import("@/engine/exr/layers").ExrLayer[];
  };
}

// A single EXR still loaded into Image Source's `file` param (which holds a
// plain ImageBitmap for ordinary images — compute branches on `kind`). The
// original bytes are the canonical source: layer switches re-decode from
// them, and serialization persists exactly these bytes (an `exr` data-URL
// envelope — the `.toolbox` writer extracts it into a binary asset).
export interface ExrImageParamValue {
  kind: "exr";
  blob: Blob;
  filename?: string;
  layers: import("@/engine/exr/layers").ExrLayer[];
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

// Brush settings for the Paint node's stamp engine (the `brush_settings`
// param). Plain JSON; the node stores the full blob (not a preset reference)
// so projects stay self-contained. Brush size is NOT here — it stays the
// node's visible `size` scalar param (in canvas px). The editor-side model
// (defaults, presets, stamp cache) lives in components/effects/paint-editor.
// Spec: 071926_paint-toolkit.md.
export interface BrushSettingsValue {
  hardness: number; // 0..1 — stamp edge: 1 = hard disc, 0 = full falloff
  opacity: number; // 0..1 — per-stroke alpha cap
  flow: number; // 0..1 — per-stamp alpha
  spacing: number; // stamp interval as a fraction of brush diameter
  smoothing: number; // 0..1 — pointer stabilizer strength
  pressureSize: boolean; // pen pressure scales stamp size
  pressureOpacity: boolean; // pen pressure scales stamp alpha
}

// Shared default so the node def, the load migration (lib/project.ts), and
// the editor resolve missing/partial blobs identically. Treat as frozen —
// read sites spread it, never mutate it.
export const DEFAULT_BRUSH_SETTINGS: BrushSettingsValue = {
  hardness: 0.8,
  opacity: 1,
  flow: 1,
  spacing: 0.15,
  smoothing: 0.35,
  pressureSize: true,
  pressureOpacity: false,
};

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

// Authored motion-track samples (082226_motion-tracking.md §4.1). Stored
// as a param (`tracks` / `plane`); edits go through engine/tracking/track-data
// helpers that return a new object with `rev` bumped from a session-wide
// counter. Positions are authored [0,1]² Y-down; pattern/search boxes are
// canvas pixels; planar H is canvas-pixel homography (ref → this frame).
export type TrackSampleStatus =
  | 0 // tracked  — kernel, confidence ≥ lost threshold
  | 1 // manual   — user dragged this frame; kernel never overwrites
  | 2 // repaired — spike/gap repair pass
  | 3 // predicted — kernel lost the pattern; motion-model fallback
  | 4; // lost     — no usable position (output holds last good)

export interface PointTrack {
  id: number; // stable per-node ordinal, never reused
  name: string;
  enabled: boolean;
  offset: [number, number];
  ref: { frame: number; x: number; y: number };
  patternW: number;
  patternH: number;
  searchW: number;
  searchH: number;
  frames: number[];
  x: number[];
  y: number[];
  rot?: number[];
  scale?: number[];
  conf: number[];
  status: TrackSampleStatus[];
}

export interface PointTrackerData {
  kind: "track_data";
  version: 1;
  rev: number;
  nextId: number;
  tracks: PointTrack[];
}

export interface PlanarTrackerData {
  kind: "track_data";
  version: 1;
  rev: number;
  ref: { frame: number; corners: [number, number][] };
  frames: number[];
  corners: number[]; // 8 per frame, authored space
  H: number[]; // 9 per frame: ref → this-frame homography in canvas px
  conf: number[];
  status: TrackSampleStatus[];
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
  // For "scalar" params: derive the control's increment from the node's
  // CURRENT param values instead of the static `step` (e.g. Constant's
  // `value` slider follows its sibling `step` param). When it returns a
  // number, edits also SNAP to zero-based multiples of it (k·step, clamped
  // to the range) so the stored value lands on the increments the user set
  // — not the offset grid a native range's `min + n·step` would produce.
  // UI-only hint like `visibleIf`: the engine ignores it, it doesn't
  // survive export-manifest serialization, and `step` stays the fallback
  // wherever sibling params aren't in reach (exported-app controls).
  stepFrom?: (params: Record<string, unknown>) => number | undefined;
  // For "scalar" params: derive the control's upper bound from the node's
  // CURRENT param values instead of the static `max` (e.g. Switch's `index`
  // tops out at `count - 1`, so the slider spans exactly the slots that
  // exist). A per-node range override still wins, and `max` stays the
  // fallback wherever sibling params aren't in reach. UI-only hint like
  // `stepFrom`: the engine ignores it (clamp in `compute`), and it doesn't
  // survive export-manifest serialization.
  maxFrom?: (params: Record<string, unknown>) => number | undefined;
  default: unknown;
  options?: string[];
  // Placeholder text for string-type params when the value is empty.
  placeholder?: string;
  // For "string" params: render a textarea instead of a single-line input.
  multiline?: boolean;
  // For "expr_inputs" params: show a "Sync" button that scans the node's
  // sibling `expression` param for ch("name", default) channel references and
  // mints the matching slider inputs (Houdini-style). See Point Expression.
  channelSync?: boolean;
  // For "enum" params: override the default dropdown rendering. Purely a
  // ParamPanel rendering hint — the engine ignores it, and the value stays a
  // plain option string either way.
  //   "segmented" — a pill toggle, best for 2–3 inline modes.
  //   "font"      — a searchable font picker that merges the user's installed
  //                 (local) fonts with this param's `options` (the curated
  //                 baseline). The selected value is just the family name.
  //   "exr_layer" — a dropdown whose options come from the EXR layer list on
  //                 the node's sibling media param (`sequence`/`file`), not
  //                 from `options`. The value is the layer's stable id.
  // For "string" params (multiline):
  //   "file_text"  — the textarea plus a "Load…" button that reads a text file
  //                 into this same param, and a live item-count summary. The
  //                 param stays a plain `string`, so unlike a `csv_file`-style
  //                 param it remains exposable and wire-drivable (that's the
  //                 whole reason the List node's source isn't a file param —
  //                 080526_list-socket.md).
  control?: "segmented" | "font" | "exr_layer" | "file_text";
  // For "color" params: the value may carry an alpha channel as 8-digit
  // `#rrggbbaa` hex. 6-digit always reads as fully opaque, controls keep
  // writing 6-digit while alpha is 1 (so opting in never rewrites stored
  // values), and the trailing byte is STRAIGHT alpha (the engine-wide
  // non-premultiplied convention). OPT-IN per param because many compute
  // functions parse hex with local helpers that mis-read 8 digits — set
  // this only after verifying the node's parse path handles `#rrggbbaa`
  // end to end. Spec: 072026_color-alpha.md.
  alpha?: boolean;
  // For "scalar" params: a CSS gradient hinting what the axis means
  // (Temp's blue↔amber, Hue's rainbow). ScalarSliderRow paints it inside
  // the track — dim across the full width, vivid under the fill — so the
  // leading edge shows the current setting's color. UI-only hint like
  // `stepFrom`: the engine ignores it.
  trackGradient?: string;
  hidden?: boolean;
  // Optional predicate over the node's current params. Returning false hides
  // the row in the UI without affecting the underlying stored value.
  visibleIf?: (params: Record<string, unknown>) => boolean;
  // Collapsible grouping (ParamPanel-only hint; engine ignores it). Params
  // sharing a `group` id are rendered nested under the one flagged
  // `groupHeader: true` (typically a boolean toggle), with a caret on the
  // header that collapses/expands the rest. Children still obey their own
  // `visibleIf`, so a disabled group shows just its header. Used by the Text
  // node's per-character animators to keep the panel scannable.
  group?: string;
  groupHeader?: boolean;
}

export interface ComputeArgs {
  inputs: Record<string, SocketValue | undefined>;
  auxIn: Record<string, Record<string, SocketValue | undefined>>;
  params: Record<string, unknown>;
  ctx: RenderContext;
  nodeId: string;
  // Output handle keys that something actually consumes this eval —
  // `"primary"` and `"aux:<name>"` for each output wired to an evaluated
  // node (or shown by the viewport). Lets a node skip building expensive
  // outputs nobody reads: e.g. Text skips its JFA SDF and marching-squares
  // spline when only its image/element output is wired, which is what
  // keeps dragging text smooth. Undefined ⇒ the caller didn't compute it;
  // treat every output as potentially consumed (compute everything).
  consumedOutputs?: ReadonlySet<string>;
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
  | "3d"
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
  // Hidden from the add-node menus and the docs reference. Used by
  // back-compat aliases (the same def registered under a retired type
  // string so old projects keep loading) and by defs that can only be
  // created through compound actions.
  hidden?: boolean;
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
  // specdocs/archive/webgpu-particles.md).
  backend: "webgl2" | "webgpu";
  terminal?: boolean;
  // Opt out of the universal appended `mask` input (see
  // engine/conventions.ts). For organizational nodes (Render Queue) that
  // produce no image a mask socket is meaningless.
  noMaskInput?: boolean;
  // Force the universal `mask` input to always MATTE (multiply the output's
  // alpha) rather than blend the output against the node's first image input.
  // The default mask post-pass treats a node's first non-mask image input as
  // a "base" and does `mix(base, output, mask)` — correct for effects (reveal
  // the effect through the mask), wrong for image SOURCES that happen to take
  // image inputs for other purposes (Text's `fill`/font-morph inputs). Such
  // nodes set this so the mask cuts the source out by its own alpha.
  noMaskBase?: boolean;
  // When false, the evaluator will not cache this node's output — it is
  // assumed to read time or other external state that isn't captured by its
  // params/inputs fingerprint. Defaults to true (cacheable).
  stable?: boolean;
  // Set by a CACHEABLE def that skips building outputs nobody consumes (see
  // ComputeArgs.consumedOutputs). Without it there is a trap: the fingerprint
  // has no idea which outputs were requested, so wiring a previously-unbuilt
  // aux would hit the cache and hand back an output that was never rendered.
  // Declaring this folds the consumed handle set into the fingerprint, so the
  // node recomputes exactly once when its consumers change.
  //
  // NOT needed for `stable: false` defs (Text) — they never hit the cache, so
  // internal validity flags suffice. Opt-in rather than automatic because it
  // makes selection/wiring changes bust that node's cache, which is only
  // worth paying for where an output is genuinely expensive.
  gatesOutputs?: boolean;
  // Marks a node whose output depends on state ACCUMULATED ACROSS FRAMES in
  // ctx.state — every real simulation, plus temporal filters (Smooth) and
  // feedback buffers (Trails, Accumulator, the Simulation Zone pair). Such a
  // node cannot be rendered correctly at an arbitrary frame from a cold
  // start; it has to be stepped there from frame 0.
  //
  // The export drivers read this (via lib/sim-preroll.ts) to decide whether
  // switching the engine to the export resolution — which recreates the
  // backend and therefore WIPES ctx.state — needs a pre-roll to rebuild the
  // accumulated state before capture. Set it only when a state wipe would
  // visibly change the node's output AND ctx.time (never wall-clock) drives
  // the accumulation, since a pre-roll can only reproduce the former.
  simulation?: boolean;
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
  // the Collect family (Collect / Pick / Length) so users can flip
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
  // when the pointer moves, or Segment Anything keying on its per-node
  // session-store version (hence the node id). Return an empty string for
  // "no extra".
  fingerprintExtras?: (
    params: Record<string, unknown>,
    ctx: RenderContext,
    nodeId?: string
  ) => string;
  // Static sanity check of a node's params, run by the AI-recipe validator
  // (graph-validation.ts) — never during evaluation. Return human-readable
  // problems (empty array = fine); each becomes a validation error the
  // generate/repair loop can fix. Point Expression compiles + smoke-runs its
  // kernel here so expression code that fails silently at runtime (a
  // strict-mode ReferenceError from an undeclared temp, a user `return`)
  // surfaces as a repairable error instead of a no-op recipe.
  validateParams?: (params: Record<string, unknown>) => string[];
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
  // True while the primary pointer button is held down after a press that
  // STARTED inside the preview canvas — the drawing gesture (Cursor Trail
  // Points' `emit: press`). Optional so contexts that don't track buttons
  // (gl.ts fallback, older embedders) stay valid; absent reads as false.
  pressed?: boolean;
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
  // Project tempo in beats per minute (default 120 when absent). Musical
  // time for the note-domain nodes: authoring nodes (Step Pattern, the
  // future sequencer) convert beats → ticks through this at compute time,
  // so stored note data stays in ticks while a BPM change re-generates
  // patterns. Serialized on the project's scene block.
  bpm?: number;
  // Whether the scene's RAF playback is active right now. Used by
  // time-sensitive sources (Audio, Video) to decide whether to play or
  // pause their media elements; image-only nodes can safely ignore it.
  playing: boolean;
  // True while this node evaluates inside a layer's PRE-ROLL: the playhead
  // hasn't reached the layer's in-point yet, but the cut is imminent, so
  // the interior evaluates invisibly — with the clock pinned to the
  // window's entry tick — to warm caches and media decoders before the
  // cut (see the pre-roll block in evaluator.ts). Media nodes must NOT
  // audibly play or advance while set: hold paused/parked on the current
  // target (Video routes to its paused-freeze path, Audio stays paused).
  // Set per-node by evaluateGraph; absent/false everywhere else.
  preroll?: boolean;
  // Audio-source node ids whose primary output is wired into an Output
  // node's `audio` socket. The Audio Source node keeps its element
  // advancing for data regardless, but only un-mutes (plays to the
  // speakers) when it appears here. Populated per-eval by evaluateGraph;
  // absent for callers that don't set it (treated as "audible").
  audioRoutedToOutput?: ReadonlySet<string>;
  // True during a deterministic, frame-by-frame offline export (WebCodecs /
  // ffmpeg). Each frame is rendered once and captured immediately, so nodes
  // that normally defer work across frames — async GPU passes whose result
  // lands a frame or two later via a pipeline-bump — MUST instead settle
  // synchronously here, or the export captures stale/unsettled frames.
  // Realtime playback leaves this false (the continuous loop lets deferred
  // results catch up).
  offline: boolean;
  // Wedge batch-render iteration index. Set ONLY by the batch export driver
  // (one full render per variation); undefined everywhere else — editor
  // preview, live viewer, exported apps — where the Wedge node falls back to
  // its `preview` param. A node that reads this must fold the resolved value
  // into `fingerprintExtras` so caches bust between variations. See
  // specdocs/archive/071026_wedge-render-batching.md.
  wedgeIndex?: number;
  // Per-iteration values during an Iterate node's nested evaluation
  // (specdocs/archive/071826_iterate-node.md). Set ONLY by the Iterate shell's
  // compute around each nested evaluateGraph call; undefined everywhere
  // else. Read by the iterate-source boundary def, which emits `index`
  // / `t` / `random` plus the shell's exterior input values (`values`,
  // keyed by socket name). `runId` increments per shell compute so the
  // private interior cache busts when exterior inputs change without
  // the index changing; iterate-source folds runId + index into its
  // fingerprintExtras.
  iteration?: {
    index: number;
    count: number;
    t: number;
    random: number;
    runId: number;
    values: Record<string, SocketValue | undefined>;
  };
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

  // Read an image back to CPU memory as RGBA8 bytes in canvas ImageData
  // row order (row 0 = visual top). Renders into a small pooled offscreen
  // framebuffer at the requested size (GPU downsample, LINEAR-filtered
  // like any texture sample) and readPixels from there — the drop-in
  // replacement for the old blitToCanvas + getImageData recipe, which
  // resized hiddenCanvas (reallocating the context's default framebuffer
  // twice per frame) and round-tripped pixels through premultiplied 2D
  // canvas memory. Omitted dimensions default to the image's own. Still
  // a synchronous GPU stall — read at the smallest size that works and
  // cache the result while inputs are unchanged. Returns null if the
  // readback framebuffer can't be built.
  readImagePixels(
    image: ImageValue,
    width?: number,
    height?: number
  ): Uint8ClampedArray<ArrayBuffer> | null;

  // Crop-and-readback: draw a pixel-space rectangle of `image` (or a
  // single-channel tracking mask) through a crop shader into a pooled
  // RGBA8 target and readPixels. Coordinates are canvas ImageData space
  // (y-down, row 0 = visual top), matching `readImagePixels`. `gray`
  // returns one float per pixel from the R channel (the tracking-image
  // convention: preprocess writes the signal into R). Sync GPU stall —
  // one region per frame-step is the budget. Returns null if the
  // readback framebuffer can't be built. Spec: 082226_motion-tracking.md §7.2.
  readImageRegion(
    image: ImageValue | MaskValue,
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: { gray?: boolean }
  ): Float32Array | null;
}
