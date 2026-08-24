# Motion Tracking — Point Tracker, Planar Tracker, Corner Pin

Spec (2026-08-22). Designed from the owner's brief (point tracker with a
loupe for placement, planar tracker from a dragged quad, transport
buttons in the Parameters tab, smoothing + error correction, adjustable
per-frame track path in the viewport, bake-to-Point-node AND a live point
socket, research SOTA first; 3D camera solve deferred). Decisions
resolved with the owner (2026-08-22):

- **N tracks per Point Tracker node**, managed in a track list in the
  panel (Nuke-Tracker-style: shared settings, per-track rows). Planar
  Tracker stays one plane per node.
- **Bake rewires**: baking spawns keyframed Point node(s) and moves the
  tracker's consumers onto them (Make Editable semantics); the tracker
  is left in place, un-bypassed, as the revert point.
- **Corner Pin ships in v1** (M3).
- Planar smoothing smooths the **corners, then re-fits H**.
- **Track data lives in `params`** (owner asked for the trade-offs; §4.4
  states them and the fingerprint rule that makes it safe).
- Keyboard chords for step-tracking: yes.
- Loupe only in place mode and during anchor drags.
- Warp default `translate`; `translate_rotate_scale` available as an
  option.
- Deep backend stays deferred; tracking resolution = canvas resolution.

## 0. TL;DR

- Three new nodes: **Point Tracker** (`tracker-point`), **Planar Tracker**
  (`tracker-planar`), **Corner Pin** (`corner-pin`, the planar track's
  consumer — nothing in the graph can do a perspective warp today).
- Tracking is **classical and deterministic**: ZNCC coarse search +
  Lucas-Kanade sub-pixel refinement over an image pyramid, the same
  engine Nuke/AE/Blender use. Planar = a grid of those trackers inside the
  quad + RANSAC homography + a direct (ESM) polish. Research (§1) says
  the deep "track any point" models are a real upgrade for occlusion and
  long-range drift, but none has a shipped browser build and the cheapest
  viable one (CoTracker3 online) is ~50 MB fp16 over ONNX Runtime
  WebGPU, whose GridSample support only landed in ORT 1.26. So the
  kernel is written behind a **`TrackerBackend` interface** and an ML
  backend is a deferred milestone (§11), not a v1 bet.
- Tracking does NOT run in `compute`. A **tracking session** owned by the
  editor steps the scene clock with the export-grade frame stepper
  (`renderSettledFrameAt`), pulls the upstream `ImageValue` from the eval
  cache, runs one kernel step per frame, and writes the result into a new
  **`track_data` param** on the node. `compute` is pure: `track_data` +
  `ctx.tick` → outputs. This sidesteps the settle double-step, the
  export-resolution state wipe, and makes the kernel testable offline in
  `scripts/check-tracker.mts`.
- Tracks are **authored data** (like spline anchors): normalized authored
  space, saved with the project, edited per-frame in the viewport,
  non-destructively smoothed/repaired at output time, bakeable into
  keyframed Point nodes that take over the tracker's wires.
- A Point Tracker holds **N tracks** (a list in the panel); its `points`
  output carries one point per track (`groupIndex` = track row), and each
  track also gets its own `position_<n>` vec2 socket.

## 1. Research: what's state of the art, and what to build

### 1.1 Deep point trackers ("Tracking Any Point")

| Model | Params | Mode | Notes |
|---|---|---|---|
| CoTracker3 (Meta, Oct 2024) | ~25 M (102 MB fp32 ckpt) | online (sliding window, causal) + offline (bidirectional) | Best robustness per parameter; tracks points jointly; grid_sample-based correlation. Community ONNX exports exist. |
| LocoTrack (ECCV 2024) | small | offline-ish | Local all-pair 4D correlation; ~6× faster than CoTracker2 at equal accuracy. |
| TAPNext / TAPNext++ (DeepMind 2025–26) | ViT-scale | purely online, recurrent | 1024 queries real-time on a GPU; TAPNext++ adds occlusion + re-detection. Heavy for browser. |
| AllTracker (2025) | 16 M | dense all-pixel, high-res | Dense fields, 768×1024 on a 40 GB GPU — not a browser target. |
| Track-On (ICLR 25) | — | online with memory | Ships inference wrappers for every model above. |

What they buy over classical: tracking through occlusion, re-acquisition,
no template drift, and semantic-ish robustness (a point on a rotating
head). What they cost: model download (tens of MB), WebGPU-only
performance, a fixed temporal window (CoTracker online = 8–16 frames with
a 4-frame stride), and non-determinism across GPUs/backends.

Browser feasibility: `@huggingface/transformers` (already a dependency)
bundles onnxruntime-web, so the runtime is already in the tree. The ops
CoTracker needs (GridSample, the transformer blocks) are covered by the
WebGPU EP as of ORT 1.26; older versions fall back to WASM (seconds per
window). Exporting the online model needs a fixed-shape ONNX export
(window T, N queries padded) and a re-implementation of the query/window
bookkeeping in TS. That's a 1–2 week item on its own with real risk —
hence deferred, but the interfaces below leave the slot open.

### 1.2 Classical planar tracking

Direct methods (Lucas-Kanade / inverse-compositional / ESM on the whole
region) are what mocha descends from; feature-based (KLT points + RANSAC
homography) is what Blender's plane track and OpenCV-style pipelines do.
Recent work (WOFT 2023, HVC-Net) replaces the flow with a learned one and
weights the homography fit — useful later as a backend swap, same slot.
Hybrid (features for the big motion, direct refinement for sub-pixel) is
the robust default and is what §5 builds.

### 1.3 Preprocessing that actually helps (from Nuke / mocha's knobs)

Nuke's Tracker: *pre-track filter* = none / **adjust contrast** (default)
/ median; *adjust for luminance changes*; *track channels*; *warp type*
translate → affine; *pattern grab behavior* (first frame / every frame /
every N / on error thresholds); *predict track*; *max error*. mocha 9.5
added a pre-processing stage (gamma, contrast, blur, flicker removal)
for hard shots. These map onto §6's toggles. Two that matter most in
practice and cost nothing: tracking on a **band-passed (DoG) luminance**
image (kills lighting drift, keeps texture) and **zero-mean normalized
correlation** (free brightness/contrast invariance — ZNCC already is
that).

### 1.4 Decision

Build the classical engine now (deterministic, offline-testable, fast on
CPU at the patch sizes involved), expose the pro-tool knobs, and keep a
backend slot for a deep tracker. Nothing in the UI, data model, or
outputs depends on which backend produced a sample.

## 2. What already exists (load-bearing precedents)

- **Frame stepping**: `renderSettledFrameAt(t, fps, {flush})`
  (EffectsApp ~:7793) + `captureNodeFrames(sourceNodeId, frames, onFrame)`
  (~:8934) — sets `offlineRenderingRef`, seeks exactly via Video's
  `ctx.offline` branch (video.ts ~:754, `pushMediaSettle` /
  `videoSeekSettle`), two-pass settle, reads a specific node's output from
  `evalCacheRef` / `lastEvalOutputsRef`. Used by Segment / Depth /
  Datamosh bakes. Gap: it hands back a PNG blob — we add an `ImageValue`
  variant (§7.1).
- **CPU readback**: `ctx.readImagePixels(image, w?, h?)` — full-frame,
  resampled, RGBA8. Gap: no region crop (§7.2).
- **Overlays**: hand-mounted per node type in EffectsApp (~:12696–12880),
  `*AtTick` wrappers in GizmoTickOverlays.tsx subscribe to the clock
  themselves; mandatory `rectsEqual` rect guard (overlay-rect.ts) and
  `claimPointerGesture` (lib/pointer-claim.ts). MotionPathOverlay is the
  closest relative (dashed trajectory + draggable per-tick diamonds writing
  both axes at an off-playhead tick with a shared undo coalesce key).
  KeyerSampleOverlay is the pick-a-pixel precedent (`cursor:none`, ring
  cursor, pixels frozen per pointerdown). **No loupe exists.**
- **Editor "modes"**: no global mode; an enum/boolean param on the node +
  a `useMemo` gate decides whether the overlay mounts (Keyer `mode ===
  "sample"`). Tracker follows this.
- **Custom panels**: a `defType` branch chain in ParamPanel (~:640–800);
  panels receive `captureNodeFrames`, `fps`, `sceneFrames`,
  `onParamChange`. **No `button` ParamType** — buttons live in custom
  panels.
- **Keyframe writes**: `onAnimationChange(nodeId, param, block,
  coalesceKey)` (one undo entry per coalesce key);
  `onMotionPathPointChange` writes X and Y at an arbitrary tick;
  `upsertKeyframe` / `framesToTicks` in keyframes.ts. Evaluation is a
  binary search, so one key per frame is fine.
- **Point node** (source/point.ts): `x`, `y`, `rotation_deg`, `scale`
  scalars + a `position` vec2 input that overrides x/y. This is the bake
  target and the shape the live output mirrors.
- **Existing ML trackers** (object-tracker.ts, hand-tracker.ts): run in
  `compute`, `stable:false` + `retimeable:false`, feed MediaPipe via
  `blitToGLCanvas`, throttle, dispatch `pipeline-bump`, export exponential
  smoothing. They are live detectors, not authored tracks — different
  contract, and §3 explains why we don't copy it.
- **Smoothing**: only exponential (effect/smooth.ts, hand-tracker's
  `smoothHand`). No Gaussian-over-keyframes, Savitzky–Golay, Kalman, or
  1-euro anywhere.
- **Camera**: `CameraValue` is position + look-at target + fov (no roll,
  no intrinsics) — a future solve must extend it (§11).
- **Coordinates**: `points` sockets are authored [0,1]² Y-down; overlays
  aspect-correct on the way to pixels (aspect.ts). Tracks are stored in
  authored space; the kernel works in canvas pixels and converts at the
  boundary (§4.3).

## 3. Architecture: session-driven tracking, pure compute

Why not track inside `compute` like the MediaPipe nodes:

1. The evaluator runs `compute` many times per frame (socket peek,
   spreadsheet, nested Iterate / Time Offset evals, settle re-renders).
   A stateful "advance one frame" step inside compute would double-step or
   skip — the exact hazard the Pointer spec's "publish facts, derive
   edges" rule exists for.
2. Tracking needs to *drive* time (track forward/backward) — compute can
   only react to it.
3. Backward tracking, re-grab from an arbitrary frame, and "fix this one
   frame by hand" are edits to a data set, not frame-to-frame state.
4. The result must survive export-resolution switches (which wipe
   `ctx.state`) and must save with the project.

So:

```
┌─ ParamPanel: TrackerPanel ──────────────┐   ┌─ EffectsApp ────────────────────────┐
│ ⏮ ◀ ▶ ⏭ ⏸  clear  regrab  fix  bake     │──▶│ trackingSession.run(nodeId, dir, n) │
└─────────────────────────────────────────┘   │   for each frame:                   │
                                              │     renderSettledFrameAt(t)         │
                                              │     img = evalCache[upstream].primary│
                                              │     sample = backend.step(img, …)   │
                                              │     trackData = upsert(sample)      │
                                              │   onParamChange(id,"track",data,key)│
                                              └─────────────────────────────────────┘
┌─ node compute (pure) ───────────────────────────────────────────────────┐
│ track_data + ctx.tick → smooth/repair (non-destructive) → points / vec2 │
└─────────────────────────────────────────────────────────────────────────┘
```

The kernel (`src/engine/tracking/*`) is pure TS over `Float32Array`
grayscale patches — no GL, no DOM — so `scripts/check-tracker.mts` can
drive it with synthetic footage. GL is used for exactly two things: the
pre-process pass (§6) and the region readback (§7.2).

## 4. Data model

### 4.1 `track_data` ParamType (engine/types.ts)

New `ParamType` `"track_data"`. Plain JSON (no media envelope), NOT
keyframable (`isKeyframable` → false), hidden from the generic param
rows (the TrackerPanel owns it), copied verbatim by presets / clipboard
(it's inside `params`, so it rides the existing fragment envelope).

```ts
export type TrackSampleStatus =
  | 0   // tracked     — produced by the kernel, confidence ≥ lost threshold
  | 1   // manual      — user dragged this frame in the viewport (kernel never overwrites)
  | 2   // repaired    — replaced by the spike/gap repair pass (§9)
  | 3   // predicted   — kernel lost the pattern; position is the motion-model prediction
  | 4;  // lost        — no usable position (output holds last good, confidence 0)

// One track. Lives inside PointTrackerData.tracks.
export interface PointTrack {
  id: number;            // stable per-node ordinal, never reused — socket names + bake
                         // targets key off it, so reorder/rename never breaks a wire
  name: string;          // user label ("Eye L"); default "Track <id>"
  enabled: boolean;      // muted tracks drop out of every output (still drawn, dimmed)
  offset: [number, number];   // authored units added to the output (Nuke offset track)
  // Authored space [0,1]² Y-down, like every `points` value.
  ref: { frame: number; x: number; y: number };     // the seed (where the user clicked)
  patternW: number; patternH: number;               // pattern box, canvas px (kernel units)
  searchW: number;  searchH: number;                // search box, canvas px
  // Sparse, sorted by frame. Parallel arrays keep JSON small (§4.4).
  frames: number[];
  x: number[];
  y: number[];
  rot?: number[];      // radians, present when warp ≠ translate
  scale?: number[];    // uniform, present when warp ≠ translate
  conf: number[];      // ZNCC peak ∈ [-1, 1] (backends map their own score into this range)
  status: TrackSampleStatus[];
}

export interface PointTrackerData {   // ParamType "track_data", param name `tracks`
  kind: "track_data";
  version: 1;
  rev: number;           // fingerprint stamp — see §4.4; bumped by every edit helper
  nextId: number;
  tracks: PointTrack[];  // list order = panel order = groupIndex order in the points output
}

export interface PlanarTrackerData {  // ParamType "track_data", param name `plane`
  kind: "track_data";
  version: 1;
  rev: number;
  ref: { frame: number; corners: [number, number][] };   // 4 authored-space corners, TL TR BR BL
  frames: number[];
  corners: number[];   // 8 per frame, authored space
  H: number[];         // 9 per frame: ref-frame → this-frame homography in CANVAS PX
  conf: number[];      // inlier ratio ∈ [0,1]
  status: TrackSampleStatus[];
}
```

All edits go through pure helpers in `engine/tracking/track-data.ts`
(`addTrack`, `removeTrack`, `upsertSample`, `setSampleManual`,
`clearRange`, `repairSpikes`, …) that return a NEW object with `rev`
bumped from a module-level monotonic counter (not `rev + 1` — a
session-wide counter can't collide across undo/redo branches). The
overlay and panel never mutate in place: the same rule Spline Draw's
anchors follow, for the same reason (cached outputs share structure).

Why authored space for positions but canvas px for boxes/H: positions
must survive a canvas-resolution change (the track stays on the feature);
the pattern/search boxes are pixel quantities by nature and are what the
user sizes in the viewport; the homography is an intermediate that Corner
Pin re-derives from corners anyway (it's stored so the planar overlay can
draw the warped grid without a solve).

Frames are **scene frames** (integer, `ctx.tick / ticksPerFrame`). A
tracker inside an offset layer records the layer-local frame, which is
what its compute sees — consistent with how keyframes on the node behave.

### 4.2 Canvas-resolution dependence (say it once)

The kernel sees the upstream `ImageValue` at the *current canvas
resolution*. Sub-pixel accuracy is relative to that grid, so a 1080p
clip tracked on a 540p canvas is ≈ 2× coarser. The panel shows the
tracking resolution next to the transport; the docs say "track at 1:1 or
higher". Tracks are not re-run at export — they're data.

### 4.3 Space conversions (one helper, `engine/tracking/space.ts`)

`authoredToCanvasPx(x, y, W, H)` / `canvasPxToAuthored(px, py, W, H)` —
positions in authored space are anisotropic-normalized, and the kernel's
patch grid is square pixels, so the conversion is just `x*W, y*H`.
Rotation/scale from a similarity warp are isotropic in px and carried as
is. Do NOT aspect-correct here: `points` consumers correct on their way
to pixels (devguide coordinate conventions), and the overlay uses the
same `aspectCorrectY` path as PointsOverlay / MotionPathOverlay.

### 4.4 Where track data lives: `params` — and what it costs

The alternatives were (a) a param on the node, (b) a session-only
sidecar like the Segment/Depth/Datamosh bakes (`globalThis` store,
deliberately not serialized), (c) a param holding a compact binary
envelope (base64 Float32). Trade-offs:

| | (a) plain param | (b) session sidecar | (c) binary-envelope param |
|---|---|---|---|
| Survives reload / cloud save / `.toolbox` | yes, for free | **no** — the bakes are session-only because they're re-derivable from a model in seconds; a track is minutes of human work | yes |
| Undo, copy/paste, duplicate, presets, shared projects, exported live apps | all free (it's inside `params`) | none without bespoke plumbing per feature | free, but every reader must decode |
| Cache invalidation | automatic (params are in the fingerprint) | manual `fingerprintExtras` + version (the datamosh pattern) | automatic |
| Evaluator cost | **`stableStringify(node.params)` runs every eval** — a 3 MB JSON param would cost ms/frame | zero | zero (one string) |
| Size on disk | ~35 B/frame/track rounded (§ below) | zero | ~22 B/frame/track |
| Readability / spreadsheet / MCP / AI recipes | plain JSON, inspectable | opaque | opaque |

Decision: **(a)**, with two rules that remove its only real cost:

1. **Identity-token fingerprinting.** `stableStringify` in evaluator.ts
   already short-circuits `ImageBitmap` / `HTMLCanvasElement` / `Blob`
   to an opaque id. Add a fourth case: an object with `kind ===
   "track_data"` stringifies to `"trk:" + rev`. Every edit helper bumps
   `rev` (§4.1), so the fingerprint changes exactly when the data does,
   and the per-eval cost is constant regardless of track length. This
   is the whole reason `rev` exists.
2. **Compact encoding.** Positions rounded to 6 decimals (≈ 1/250 px at
   4K — below the kernel's own precision), `conf` to 3, `status` as
   small ints, parallel arrays (no per-sample objects). Measured budget:
   ~35 bytes per frame per track → a typical motion-design clip (300
   frames × 4 tracks) is ~40 KB; the pathological case (10 000 frames ×
   10 tracks) is ~3.5 MB, which the project envelope already tolerates
   for inlined media. If that ever matters, (c) is a drop-in change to
   the serializer with no API impact — the value shape in memory stays
   the same.

Undo snapshots share node references (`getGraphSnapshot` returns
`nodesRef.current`), so a track edit costs one node copy, not a deep copy
of the graph. Autosave/cloud writes serialize the whole project anyway;
a few hundred KB more is noise next to an inlined image.

## 5. The nodes

### 5.1 Point Tracker — `src/nodes/effect/tracker-point.ts`

Category `point` / `generator` (it emits points), but it takes an image.
`stable: false` (output depends on `ctx.tick`; the fingerprint already
covers `track_data` changes via params).

Inputs: `image` (required). Universal mask input opted out
(`noMaskInput`) — a matte is a pre-process concern, see §6 `mask` param.

The node holds N tracks (`tracks: PointTrackerData`, §4.1). Settings
below are **per node** (shared by every track, the Nuke Tracker model);
the per-track quantities — name, enabled, offset, pattern/search box
sizes, the samples — live in the track row and are edited in the panel's
track list (§8.3) and the overlay (§8.1). Newly placed tracks copy the
node's `pattern_size`/`search_size` defaults into their row.

Params (generic rows, grouped):

- **Pattern** — `pattern_size` (px, default 31, 9…201, odd), `search_size`
  (px, default 61, ≥ pattern+8, softMax 255) — defaults for new tracks;
  `warp` enum
  `translate | translate_rotate | translate_scale | translate_rotate_scale`
  (default translate).
- **Tracking** — `predict` boolean (constant-velocity prediction of the
  next search center; default on), `regrab` enum
  `never | adaptive | every_frame | every_n` + `regrab_n` (default
  adaptive: re-grab the pattern when conf < 0.85 but ≥ lost), `lost_below`
  (ZNCC, default 0.6), `verify` boolean (forward-backward check, default
  off: doubles cost; bumps conf down when the round-trip error > 1 px),
  `stop_when_lost` boolean (default on).
- **Preprocess** — §6.
- **Output** — `smooth_radius` (frames, default 0 = off), `smooth_mode`
  `gaussian | savgol`, `gap_fill` `hold | interpolate` (what the output does
  across `lost` frames), `reference` enum `none | first_sample` (when
  `first_sample`, each track also gets an `offset_<n>` aux = position −
  that track's first sample: the stabilize/parent vector).
- Hidden: `tracks` (`track_data`), `place_mode` boolean (the overlay's
  "click to place" state, like Keyer's `mode: sample`; each click adds a
  track and clears the mode). Track *selection* (which rows the transport
  and overlay handles act on) is NOT a param — it's editor state in a
  tiny module store, `state/tracker-selection.ts` (the playback-clock
  pattern: `get/set/subscribe` + a `useTrackerSelection(nodeId)` hook),
  so the panel and the `*AtTick` overlay agree without lifting state
  into EffectsApp, and selecting a row neither re-fingerprints the node
  nor lands in undo.

Outputs (`resolveAuxOutputs(params)` mints the per-track sockets from
`tracks`, the hand-tracker pattern; socket names use the track **id**,
labels show the track name):

- primary `points` — one point per enabled track, in list order, each
  at its (smoothed, repaired, offset) position with `groupIndex` = list
  row (so Select by Index / Copy-to-Points pick mode address tracks the
  same way they address Combine's inputs); `rotation`/`scale` from the
  warp when enabled; named attribute `confidence` (arity 1). A single-
  track node is exactly the old "one point" contract.
- aux `position_<id>` (`vec2`) per track — the track as a bare vector,
  wiring straight into any exposed vec2 param (Transform `translate`,
  Point `position`, Circle center…). This is the owner's "live point
  output socket". Disabled tracks keep their socket (so wires survive a
  temporary mute) and emit their last value.
- aux `offset_<id>` (`vec2`) per track, only while `reference =
  first_sample`. Negate it into a Transform and the shot is stabilized.
- aux `confidence_<id>` (`scalar`) per track, only while
  `confidence_sockets` is on (default off — keeps the node compact; the
  per-point attribute is always there for point-graph consumers).
- aux `path` (`spline`) — every track's trajectory as one open subpath
  each (raw, not smoothed, `groupIndex` = row) for trails/motion-graphics;
  `consumedOutputs`-gated.
- aux `image` — passthrough of the input, or the preprocessed tracking
  image when `view_tracking_image` is on. This is what the preview shows
  when the node is selected, which is what the loupe magnifies (§8.2).

Track data → value at tick T, per track: binary-search `frames` for T;
exact hit → that sample; miss → per `gap_fill` (hold the nearest earlier
sample, or interpolate between neighbors). Smoothing is applied to the
full sample arrays once per `tracks` identity (cached in `ctx.state`,
keyed on `rev` + smoothing params), not per tick.

### 5.2 Planar Tracker — `src/nodes/effect/tracker-planar.ts`

Same category/flags. The user drags 4 corner handles to outline a planar
region on the reference frame (default: a centered quad at 40% of the
canvas, so it's visible immediately).

Algorithm per step (forward or backward, from the nearest tracked frame):

1. **Feature set** — on (re)seed, detect Shi–Tomasi corners inside the
   quad (min eigenvalue of the structure tensor over the tracking image;
   grid-bucketed so features spread; default 48–96 features, param
   `feature_count`). Each feature is a Point-Tracker kernel instance
   (small pattern, e.g. 15 px; search sized from the predicted motion).
2. **Flow** — track every feature from the previous frame to this one
   (translate warp, pyramid for large motion). Predict each with the
   previous frame's H applied to the previous position.
3. **Homography** — RANSAC (4-point DLT, normalized coordinates,
   reprojection threshold `inlier_px`, default 1.5) over the feature
   correspondences *reference → current* (features carry their reference
   coordinates, so H is always anchored to the reference frame — no
   frame-to-frame chaining drift). Refine on all inliers with
   Levenberg–Marquardt (8 DoF, Gauss-Newton is enough in practice).
4. **Direct polish** (param `refine: none | esm`, default esm) —
   inverse-compositional ESM on the reference region warped by H: 2–4
   iterations at the fine pyramid level, only on pixels inside the quad
   and not masked. Gives the sub-pixel stability mocha is known for.
5. **Maintenance** — drop features whose reprojection error exceeds
   `inlier_px` for 2 consecutive frames; when inliers < `feature_count/2`,
   re-detect inside the current quad. Confidence = inlier ratio; lost when
   below `lost_below` (default 0.3) or when H is degenerate (condition
   number / corners cross).
6. Corners = H · ref corners.

Params: `feature_count`, `inlier_px`, `refine`, `lost_below`, `predict`,
`stop_when_lost`, the §6 preprocess block, `smooth_radius`/`smooth_mode`
(applied to corners, then H re-fit from the smoothed corners so the
homography and the corners never disagree — owner's call, §0), `mask`
(§6). Hidden: `plane` (`track_data`, §4.1 `PlanarTrackerData`). One
plane per node: a second surface is a second node, since its consumers
(Corner Pin, quad matte) are per-plane anyway.

Outputs:

- primary `points` — the 4 corners, ordered TL TR BR BL, attribute
  `confidence`.
- aux `quad` (`spline`) — the closed 4-anchor subpath (garbage matte,
  Rasterize → mask, Keyer region).
- aux `center` (`vec2`), aux `confidence` (`scalar`).
- aux `uv` — the UV field that maps the canvas through H⁻¹: wire it into
  any node's `uv` input and that node renders corner-pinned for free
  (the Displace/warp vocabulary already in the engine). Corner Pin (5.3)
  is the discoverable version of the same thing.
- aux `image` — passthrough / tracking-image view.

### 5.3 Corner Pin — `src/nodes/effect/corner-pin.ts`

Category `image` / `modifier`. Inputs: `image` + `corners` (`points`,
exactly 4 used; extra ignored, fewer → passthrough) OR four `vec2` inputs
`tl/tr/br/bl` (resolveInputs: when `corners` is wired the vec2 sockets
hide). Params: `from` — `canvas | custom` source quad (custom shows 4
vec2 params with gizmo handles; default canvas = the full frame), `fill`
`transparent | edge | tile`, `filter` `bilinear | bicubic`. One fullscreen
shader: H from source quad → dest quad (DLT on CPU, 3×3 uniform), FS
inverts per pixel (`p' = H⁻¹·p`, homogeneous divide), samples the input,
zero alpha outside the source quad. Also honors a `uv` input like Video /
Image Source (placement before the warp).

Outputs: primary `image`, aux `uv` (the same mapping as a field).

The Transform node already accepts the point tracker's `position` for
2-DoF follow, and its rotation/scale can be fed from the similarity warp
via Point Expression — no Transform changes needed in v1.

## 6. Pre-processing (the "tracking image")

One GL pass, `engine/tracking/preprocess.ts`, produces a **single-channel
float tracking image** the kernel reads. Declared as a shared param
block (`TRACKING_PREPROCESS_PARAMS`) on both trackers:

- `channel` — `luminance | red | green | blue | saturation` (Nuke "track
  channels", mocha's channel pick; saturation is what saves a track on a
  colored marker against a gray wall).
- `denoise` — `none | median3 | blur` + `denoise_radius`.
- `bandpass` — boolean + `bandpass_low`/`bandpass_high` sigmas: DoG
  high-pass that removes lighting gradients and slow flicker while
  keeping texture. This is the "adjust for luminance changes" trick in
  its cheapest robust form.
- `contrast` — `none | stretch | local` — global min/max stretch over
  the search region, or local mean/variance normalization (the LK stage
  is brightness-sensitive; ZNCC is not, so this mainly helps refinement
  and the planar ESM step).
- `invert`, `gamma`.
- `mask` (`mask` input socket, optional) — pixels with mask < 0.5 are
  excluded from correlation and feature detection (track a logo through
  a passing hand; planar: ignore the reflection in the screen).
- `view_tracking_image` — boolean; when on, the `image` aux shows the
  tracking image so the user can see what the kernel sees.

All of these are fingerprinted into the session: changing one mid-track
does not invalidate existing samples (they're data), but the panel flags
"settings changed since last track" and offers re-track.

## 7. Engine plumbing

### 7.1 `captureNodeImages` (EffectsApp)

Generalize `captureNodeFrames` into an internal
`walkNodeFrames(sourceNodeId, frames, onImage: (frame, img: ImageValue,
ctx) => Promise<boolean|void>)`; `captureNodeFrames` becomes the PNG
adapter over it. The tracking session uses the `ImageValue` form directly:
no PNG encode, and the readback is a region, not a frame. Same
`offlineRenderingRef` / `setPlaying(false)` / restore-in-`finally`
discipline. New: the session reports progress through the existing
`node-progress` banner AND keeps the playhead visibly moving (it already
calls `setTime` per frame) so the user sees the track being laid down,
Nuke-style. A `cancel` flag checked between frames is how ⏸ works.

Upstream resolution: the session resolves the edge into the tracker's
`in:image` and reads THAT node's output — the tracker's own output is
never what we track on. If the upstream is in a different clock scope
(offset layer), the frame list is the tracker's local frames and
`renderSettledFrameAt` is given the global time — the `walk` helper
converts through the node's scope (same as `recordScopedFrame` in the
datamosh session).

### 7.2 `readImageRegion` (engine/gl.ts)

`ctx.readImageRegion(image, x, y, w, h, opts?: {gray?: boolean})` →
`Float32Array` (w·h, or w·h·4). Draws the region through a crop shader
into a small pooled RGBA8 target and `readPixels` — the same readback-FBO
machinery as `readImagePixels` with an added rect uniform. `gray:true`
returns luminance (the preprocess pass has already written the tracking
image into a pooled single-channel-in-R texture, so the region read is
one channel). Sync readback is fine here: the memory note says sync
`readPixels` has a ~7 ms floor regardless of size; one region read per
frame step is the budget, and the planar tracker reads one bounding-box
region per frame (not one per feature).

### 7.3 Kernel — `src/engine/tracking/`

Pure TS, no GL/DOM, every function takes `Float32Array` + width/height.

- `pyramid.ts` — Gaussian pyramid (levels chosen from search size).
- `zncc.ts` — zero-mean normalized cross-correlation of a pattern over a
  search window at integer offsets; returns the score map, best peak,
  and second-best-outside-radius (peak sharpness). Separable sums keep it
  O(search·pattern) with small constants; 61²×31² ≈ 3.6 M MACs ≈ 2–4 ms
  in JS, the coarse pyramid level cuts that further for large searches.
- `lk.ts` — inverse-compositional Lucas–Kanade refinement. Warps:
  translation (2), similarity (4), affine (6 — used by planar features
  only). Precomputed steepest-descent images + Hessian on the template;
  2–5 iterations; bilinear sampling with the pattern's sub-pixel origin.
- `homography.ts` — normalized DLT, RANSAC, LM refinement, `applyH`,
  `invertH`, degeneracy checks.
- `esm.ts` — efficient second-order minimization of a homography over a
  region (planar refine step).
- `features.ts` — Shi–Tomasi detection with grid bucketing + mask.
- `filters.ts` — Gaussian-over-frames and Savitzky–Golay smoothing over
  sparse sample arrays; MAD spike detector; gap interpolation; constant-
  velocity (and optional constant-acceleration) prediction.
- `backend.ts` — the interface:

```ts
export interface PointTrackerBackend {
  seed(img: GrayImage, x: number, y: number, opts: SeedOpts): TrackerHandle;
  step(handle: TrackerHandle, img: GrayImage, predicted: {x,y}): StepResult; // {x,y,rot?,scale?,conf}
  regrab(handle: TrackerHandle, img: GrayImage, x: number, y: number): void;
}
```

The classical backend is `classical.ts`. A deep backend (§11) implements
the same three calls over a frame window instead of a frame pair; the
session doesn't care. `GrayImage` is `{data: Float32Array, width,
height}` — the session provides the region *and* its canvas offset so the
kernel works in local coordinates and the session converts back.

### 7.4 Determinism + offline coverage — `scripts/check-tracker.mts`

Added to `npm run check`. Synthetic sequences built in-script:

1. Textured patch translated by known sub-pixel offsets with noise +
   a brightness ramp → mean error < 0.1 px, no lost frames.
2. Patch occluded for 6 frames → status `predicted` during, re-acquired
   after (conf back above threshold), forward-backward verify catches a
   decoy.
3. A spike injected into a clean track → repair pass flags exactly that
   frame; Gaussian and Savitzky–Golay smoothing preserve endpoints and a
   constant-velocity segment (SG reproduces a quadratic exactly).
4. Planar: a textured quad under a synthetic homography per frame →
   corner error < 0.25 px; RANSAC survives 30% outliers.
5. Corner Pin's H derivation: `applyH(H, src_i) ≈ dst_i` for the four
   corners, invert round-trips.

## 8. Editor: overlay, loupe, panel

### 8.1 Tracker overlay — `components/effects/tracking/TrackerOverlay.tsx`

Mounted like the others (`activeTrackerNode` gate: a tracker node is
selected; not gated on `place_mode`). Wrapped in an `*AtTick` so the
playhead drives it without re-rendering the shell. Draws (SVG, fixed,
zIndex 2, `pointerEvents:none` except handles):

- **Every track** of the node is drawn; tracks in the selection store
  (§5.1) get handles and full-strength color, the rest draw dimmed with
  their anchor only (click an anchor → select; shift-click → add to
  selection; click on bare canvas → keep selection, so the viewport never
  fights the panel). Each track has a color from a small cycling palette
  (index-based, deterministic — the same color appears in the panel row
  and on the `points` output's dots in PointsOverlay via `groupIndex`).
- **Anchor** (crosshair + pattern box + search box) per selected track at
  the current frame's position. The boxes are draggable/resizable
  (corner handles) — they write that track's `patternW/H`, `searchW/H`
  (px); dragging the anchor itself on a frame with a sample writes that
  frame's sample (status `manual`); on a frame without a sample it moves
  the seed (`ref`) if the track has no samples yet, else inserts a
  manual sample.
- **Trajectory** per track: polyline through every sample (raw, and the
  smoothed curve as a second thinner line when smoothing > 0), one **dot
  per frame** colored by status (tracked = track color, manual = white,
  repaired = amber, predicted = amber hollow, lost = red). Dots are
  `pointerEvents:auto`; drag = edit that frame (`manual`); ⌥-click
  removes the sample so a re-track fills it. Shift-drag moves the
  frame's dot AND shifts every later sample of that track by the same
  delta (the "correct the drift from here on" gesture). Dot density:
  above ~2 000 visible samples, dots decimate to every k-th frame (the
  polyline stays exact) — a 10 k-frame bake must not mint 10 k SVG
  nodes.
- Planar: 4 corner handles (drag edits that frame's corners, `manual`),
  edge midpoints for convenience, the warped grid (H · a 4×4 lattice)
  when `show_grid` is on, and the same per-frame status dots on the
  quad's center path.
- Undo: every drag is one `onParamChange(id, "tracks"|"plane", next,
  coalesceKey)` per gesture — the data is a param, so the existing
  700 ms coalesce + snapshot undo covers it with zero new plumbing.
- Pointer hygiene: `claimPointerGesture`, `rectsEqual` rect state,
  aspect-correct mapping identical to MotionPathOverlay's
  `toPx`/inverse.

### 8.2 Loupe — `components/effects/tracking/Loupe.tsx`

Shown while `place_mode` is on (cursor hidden, ring cursor like Keyer)
and while dragging the anchor / a corner handle. A 160×160 CSS-px canvas
pinned beside the cursor (flips side near the viewport edge) showing the
preview canvas region under the cursor at `zoom` (4× default, ⌘-wheel
2–16×), `imageSmoothingEnabled = false` so pixels are visible, a 1-px
crosshair and the pattern box outline at true scale. Source: the
**preview canvas is a 2D canvas** (`blitToCanvas` draws the hidden GL
canvas into it), so `drawImage(previewCanvas, sx, sy, sw, sh, 0, 0,
W, H)` is a zero-readback copy of exactly what the user sees. When the
tracker node is selected the preview shows its `image` aux (the input, or
the tracking image with `view_tracking_image`), so the loupe magnifies
the footage, not the points. Sub-pixel placement: the click lands in
authored space at float precision; the kernel seeds with bilinear
sampling at that sub-pixel origin.

Placement flow: select tracker → panel's **Add track** button (or `P`
with the viewport focused) sets `place_mode` → click in the viewport →
a new track row is appended with its seed (`ref.frame` = current frame,
boxes from the node's defaults), it becomes the selection, and
`place_mode` clears → the anchor + boxes appear → transport buttons
enable. Shift-click keeps `place_mode` on so several tracks can be
dropped in a row. The loupe is shown ONLY in place mode and while an
anchor / corner handle is being dragged (owner's call) — never while
nudging trajectory dots.

### 8.3 TrackerPanel — `components/effects/TrackerPanel.tsx`

A `defType` branch in ParamPanel for both tracker types (Corner Pin uses
the generic rows). Layout, top to bottom:

1. **Status line** — `4 tracks · 120/240 frames · 3 lost · conf 0.91 ·
   1920×1080` (tracking resolution), plus "settings changed since last
   track" when applicable. Selection-aware: with rows selected it
   reports those.
2. **Track list** (Point Tracker only) — one row per track: color chip,
   name (double-click to rename), enabled toggle, sample count + lost
   count, a per-row confidence sparkline (tiny canvas, conf over frames,
   red where lost), offset x/y fields, and a hover-×. Rows select on
   click, shift/⌘ for multi-select, drag to reorder (reorder changes
   `groupIndex` order, never socket names). `Add track` enters place
   mode. Above the list: `All` / `None` selection shortcuts. Transport and
   tools act on the **selected tracks, or all enabled tracks when
   nothing is selected**; the buttons' tooltips say which.
3. **Transport** — `⏮ Track to start` · `◀ Back one` · `▶ Forward one`
   · `⏭ Track to end` · `⏸ Stop` (only while running). Range = the
   node's clip window if it has one, else the scene. `Track to end` runs
   each selected track from its latest sample at/after the playhead (or
   its seed); `to start` mirrors. One-frame steps also step the playhead.
   With several tracks selected, one frame walk serves all of them (one
   seek + one region readback per track per frame).
4. **Tools** — `Regrab here` (pattern from the current frame; samples
   stay), `Clear` ▾ (`all`, `after playhead`, `before playhead`, `lost
   frames only`), `Fix spikes` with a threshold slider (§9.2, previews
   the count: "would fix 4 frames in 2 tracks"), `Fill gaps`.
5. **Bake** — `Bake → Point nodes` (§10; planar: `Bake → 4 Point nodes`
   and `Add Corner Pin`, which inserts a Corner Pin downstream wired to
   the tracker's `corners`, so it's also the fastest way to get the pin
   set up).
6. The generic param rows (pattern, tracking, preprocess, output groups).

Buttons are panel-owned (no `button` ParamType — consistent with BgRemove
/ Segment). The panel receives `runTrackingSession`, `bakeTracks`, and
`insertNodeNear` as props from ParamPanel, which gets them from
EffectsApp like `captureNodeFrames` today.

Keyboard (viewport focused, a tracker selected): `⌥→` / `⌥←` = track
one frame forward/back; `⌥⇧→` / `⌥⇧←` = track to end/start; `Esc` =
stop (and exits place mode); `P` = add track (place mode). Same chord
family as frame-step, so it reads as "frame-step with tracking". The
chords register through the existing viewport key handler with the
tracker-selected guard first, so they're inert everywhere else.

## 9. Smoothing and error correction

### 9.1 Smoothing (non-destructive, output-time)

`smooth_radius` r (frames) with `smooth_mode`:

- `gaussian` — σ = r/2, kernel truncated at ±r, **renormalized at the
  ends** so the first/last frames don't pull toward the interior. Applied
  over the sample arrays in frame order; gaps (lost) are excluded from
  the window (their weights redistribute).
- `savgol` — Savitzky–Golay, polynomial order 2, window 2r+1: preserves
  accelerations and turn-arounds that a Gaussian rounds off; the better
  default for camera-like motion. Same end handling (asymmetric windows
  at the ends, i.e. fit the polynomial on what's there).

Manual samples are smoothed like any other (the user asked for a smooth
result; if they want a hard key they bake and edit keyframes). The
overlay draws raw and smoothed so the effect is visible. Bake writes the
smoothed values.

### 9.2 Error correction

- **Online (during tracking)** — three signals feed confidence: ZNCC
  peak, peak sharpness (best / second-best-outside-3px; a flat score map
  means "it could be anywhere"), and optional forward-backward round-trip
  error. `conf` stored = ZNCC peak; `lost` when conf < `lost_below` or
  sharpness < 1.15 or round-trip > 1 px. On lost with `stop_when_lost`
  off, the session writes a `predicted` sample from the motion model
  (constant velocity over the last 4 tracked frames; decays to zero
  velocity after 8 predicted frames so a lost track doesn't fly off) and
  keeps searching at the prediction with the search box grown by 1.5×
  per lost frame (capped at 3×) — the cheap re-acquisition trick. On
  re-acquisition (conf ≥ `lost_below` + 0.1 hysteresis) the search
  box resets.
- **Offline (`Fix spikes`)** — per-frame residual against a running
  median (window 7) of the track, normalized by the MAD of residuals; a
  frame with residual > `threshold` (default 3.5 MAD, slider 2–8) is
  flagged. The fix replaces the flagged sample with a cubic Hermite
  interpolation through the nearest unflagged neighbors on each side
  (2 + 2), marks it `repaired`, keeps conf. Manual samples are never
  flagged. The panel previews the count before applying; applying is one
  undoable `track_data` write.
- **`Fill gaps`** — replaces `lost`/`predicted` runs shorter than
  `max_gap` (default 12 frames) with the same Hermite interpolation,
  status `repaired`; longer gaps stay (the output's `gap_fill` decides
  what the node emits across them).
- **Live "lost" feedback** — the node's `confidence` aux and the
  trajectory dot colors; the status line counts lost frames and the
  `⏭` button stops at the first lost frame when `stop_when_lost` is on
  (playhead parked there so the user can regrab or nudge and continue —
  the Nuke/AE muscle memory).

## 10. Baking (rewires — Make Editable semantics)

`Bake → Point nodes` bakes the selected tracks (or all enabled when
nothing is selected). Pure graph op in `state/graph-ops.ts`
(`bakeTracksToPoints`) so it gets coverage in `check-graph-ops.mts`, with
EffectsApp supplying the evaluated output positions like it does for
Make Editable:

1. For each baked track, create a `point` node (count 1) next to the
   tracker (same placement helper the GLB auto-expand / preset insertion
   uses), named after the track (`Eye L`), in the tracker's group/layer
   scope. Write `x` and `y` `KeyframeAnimationBlock`s: one keyframe per
   sampled frame at `framesToTicks(frame)`, values = the node's *output*
   positions (smoothed, repaired, offset applied), easing `linear`
   (per-frame keys; curvature is in the data, an easeInOut between
   adjacent frames would wobble). When the warp carries rotation/scale,
   also write `rotation_deg` and `scale`. `animated: true`,
   `trackVisible: true`. Frames the output holds/interpolates across
   (lost with `gap_fill`) get no key — the Point node's interpolation
   reproduces `interpolate`; for `hold` we write the held value at the
   gap's first frame with `hold` easing.
2. **Rewire consumers** (this is the owner's "rewire" call):
   - wires from `out:aux:position_<id>` → move to the baked Point node's
     **`out:aux:position`**. The Point node gains a `position` vec2 aux
     (its effective x/y — tiny change, generally useful: a Point node
     can now drive a Transform directly). Wires from `offset_<id>`
     (reference mode) move to a **Vec2 Literal** node named `<track>
     offset` with the same per-frame keyframes on its x/y — an offset is
     a vector, not a point, so it gets the vector node.
   - wires from `out:primary` (`points`): if exactly one track was baked
     and the node has one enabled track → move to that Point node's
     primary. Otherwise insert a **Combine** node in `points` mode with
     one input per baked track in list order (it reproduces the same
     `groupIndex` tagging the tracker emitted) and move the wires to
     its output. Consumers see identical data.
   - wires from `path`, `confidence_<id>`, and `image` stay on the
     tracker — there's nothing to bake them into, and the tracker keeps
     computing (its compute is data + tick, negligible).
   - The tracker is **not** bypassed: bypass would pass the input image
     through its `points` primary and corrupt whatever is still wired.
     It stays as the revert point (undo, or re-wire by hand); the panel
     shows "baked → Eye L, Eye R" on the rows so the relationship is
     visible. Baking again overwrites nothing — it creates fresh nodes.
3. One undo entry: node inserts + wire moves + all animation blocks via
   a single `pushGraph` + `setNodes`/`setEdges`, the
   `onMotionPathPointChange` pattern with a shared coalesce key
   (`bake:<trackerId>`).

Planar: `Bake → 4 Point nodes` writes one Point node per corner
(TL/TR/BR/BL) into a node group `<label> corners` and rewires `corners`
consumers to a Combine of the four; `Add Corner Pin` inserts a Corner Pin
wired to the tracker's `corners` (nothing baked — it's live; the tracker
IS the data). Keyframe density: a 1 000-frame track = 1 000 keys per
axis; evaluation is a binary search and the Track/Graph editors already
render dense keys (no new risk, but watch the Graph Editor's per-key SVG
cost on 10 k-frame clips; decimation is a later nicety — §11).

## 11. Deferred (designed-for, not built)

- **Deep tracker backend** (`engine/tracking/deep-cotracker.ts`) —
  CoTracker3-online exported to ONNX at a fixed window (T=16, N≤64
  queries padded) run through onnxruntime-web's WebGPU EP (≥1.26 for
  GridSample), weights self-hosted on R2 (~50 MB fp16, downloaded on
  first use with the `node-progress` banner like the MediaPipe models).
  Same `PointTrackerBackend` surface: `seed` records a query, `step`
  pushes a frame into the window and returns the newest estimate, with
  the window's visibility logit mapped into `conf`. The planar tracker
  would run its features through it unchanged. The panel gets a
  `backend: classical | deep` enum. Also the right host for TAPNext++ if
  a browser-sized checkpoint appears.
- **Sequential-decode fast path** — forward tracking over a plain Video
  Source could decode via WebCodecs `VideoDecoder` sequentially (no
  per-frame seek) for ~5–10× the speed. It bypasses the graph (no
  upstream nodes, no clip/layer remap), so it's only valid when the
  tracker's input is a bare Video Source with identity placement; the
  session would detect that and take the fast path. Not in v1.
- **Multi-point tracker / auto-tracks** — N trackers in one node with a
  `tracks: PointTrackData[]` param, auto-seeded by feature detection over
  the whole frame. This is the front half of a camera solve and of a
  "mesh warp from tracks" node; the data model above generalizes by
  wrapping, nothing changes in the kernel.
- **3D camera solve** — needs: auto-tracks (above), intrinsics (focal
  length + principal point, a `camera_intrinsics` param or a Camera
  node extension — `CameraValue` today has no roll/intrinsics, so the
  solve must add an `up` vector or quaternion), incremental SfM
  (essential matrix init on two keyframes, PnP for the rest, sparse
  bundle adjustment — Rust/WASM in the vector-kernel crate is the right
  home; it's far too slow in JS at BA scale), and outputs `camera` per
  frame + `points3d` cloud + a ground-plane fit. The feed-forward models
  (VGGT, π³, MapAnything) are ~1 B params — Electron-only via a local
  runtime if ever. Research fresh when it's picked up.
- **Keyframe decimation on bake** (Douglas–Peucker on the value curve,
  tolerance in px) for editable results.
- **Mesh / "track to spline"** — drive Spline Draw anchors from N point
  trackers (the anchor virtual-track machinery in conventions.ts already
  exists).
- **Stabilize node** — a Transform-with-tracker-input convenience; the
  `offset` aux + Transform covers it in v1.

## 12. Resolved questions (2026-08-22) and what each changed

1. **N tracks per node** → §4.1 `PointTrackerData.tracks`, per-track
   `position_<id>` sockets (§5.1), track list + selection store (§8.3,
   §5.1), multi-track overlay (§8.1), Combine on bake (§10).
2. **Bake rewires** → §10: wires move to the Point nodes (and a Combine /
   Vec2 Literal where the types demand), tracker stays un-bypassed.
   Side change: Point node gains a `position` vec2 aux.
3. **Corner Pin in v1** → M3.
4. **Planar smoothing = corners, then re-fit H** → §5.2.
5. **Track data in `params`** → §4.4 (trade-offs) + the `rev`
   fingerprint token in `stableStringify` and the compact encoding.
6. **Keyboard chords** → §8.3.
7. **Loupe only in place mode + anchor drags** → §8.2.
8. **Warp**: default `translate`, `translate_rotate_scale` offered →
   §5.1 (unchanged).
9. **Deep backend deferred** → §11.
10. **Canvas resolution** → §4.2 status-line note only.

Still open (small, can be settled during M1 without a design round):
the track palette colors (reuse the socket-color palette?), whether
`confidence_sockets` defaults on for single-track nodes, and the exact
chord bindings if `⌥→` turns out to be taken in the viewport.

## 13. Milestones

**M0 — Engine kernel + offline gate (no UI).** `engine/tracking/*`
(pyramid, zncc, lk, features, homography, esm, filters, backend,
classical), `scripts/check-tracker.mts` wired into `npm run check`,
`track_data` ParamType (types.ts union, `isKeyframable` false,
serialization check), `readImageRegion` in gl.ts, the preprocess pass.
Exit: all five synthetic checks pass.

**M1 — Point Tracker end-to-end.** Node def + multi-track outputs
(§5.1), `track-data.ts` edit helpers + selection store, tracking session
+ `walkNodeFrames` (§7.1), TrackerPanel track list + transport + tools
(§8.3) + keyboard chords, TrackerOverlay anchors + boxes + trajectory
dots with per-frame drag for N tracks (§8.1), Loupe + place mode (§8.2),
online lost handling (§9.2 online), output-time smoothing (§9.1). Exit:
drop three points on a clip, track them forward/backward together, see
the paths, nudge a frame, wire one `position_<id>` into a Transform and
the `points` primary into Copy to Points, watch both follow.

**M2 — Repair + bake + warp modes.** Fix spikes / Fill gaps (§9.2
offline), Bake → Point nodes with rewiring + Point node `position` aux
+ `bakeTracksToPoints` coverage in check-graph-ops (§10), similarity
warp (rotation/scale into the points output), `offset_<id>`/reference
aux, forward-backward verify, regrab policies, `path` aux. Docs page.
Devguide update.

**M3 — Planar Tracker + Corner Pin.** Features/RANSAC/ESM pipeline
(§5.2), quad overlay with warped grid, Corner Pin node (§5.3) + `uv` aux,
planar bakes, planar smoothing. Exit: track a phone screen, corner-pin a
Text node onto it, keyer-mask with the `quad` aux.

**M4 — Polish + perf.** WASM port of zncc/lk/esm if JS timings bite on
4K canvases, Graph Editor density check on long bakes, keyframe
decimation option, sequential-decode fast path investigation, in-app
docs for the tracking workflow, then the deep-backend spike (§11) as its
own spec.
