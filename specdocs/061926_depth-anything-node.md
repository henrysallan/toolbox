# Depth Anything node + per-frame video bake (spec — 2026-06-19)

## Goal

Add a **Depth Anything** effect node: monocular depth estimation that runs
entirely in the browser (HuggingFace Transformers.js), takes an `image`
input and outputs a depth map. A header toggle switches the primary output
between **Depth map** and **Normal map** (normals derived from the depth
gradient in-shader). Because depth estimation is expensive (~hundreds of ms
per frame, model download ~100 MB–1.3 GB), the node supports a **per-frame
bake** over an in/out range so animated/video inputs play back and export
smoothly — reusing the exact machinery the Segment Anything node already
uses.

## Decisions (from design Q&A, 2026-06-19)

1. **Bake infra:** node-specific. Mirror `lib/ai/segment-session.ts` into a
   new `lib/ai/depth-session.ts`. No changes to the working Segment node.
2. **Preview:** live single-frame inference (debounced, latest-wins) **plus**
   an explicit per-frame "Bake range". Not bake-only.
3. **Output:** one primary `image` output with a header dropdown toggle
   **Depth ↔ Normal**. Normals computed from the depth gradient in the node's
   shader (the bake stores depth only; the toggle is a cheap shader switch).
4. **Models:** Depth Anything **V2 Small / Base / Large**, selectable via an
   enum param.

## Why this is mostly assembly, not new infra

The two hard parts already exist and are proven:

- **The bake frame-stepper** — `captureNodeFrames(sourceNodeId, frames,
  onFrame)` ([EffectsApp.tsx:4580](../src/components/effects/EffectsApp.tsx#L4580)).
  It pauses playback, sets `offlineRenderingRef`, steps each frame, renders
  deterministically (settling Video seeks via `awaitMediaSettle`), reads the
  upstream node's primary image back as a PNG `Blob`, and invokes `onFrame`.
  It is **not Segment-specific** — already passed to `SegmentPanel` from
  ParamPanel. We pass the same prop to the new panel.
- **The per-frame cache + LRU decode + offline-settle + byte-budget** —
  `lib/ai/segment-session.ts`. We copy it near-verbatim; depth maps are
  single-channel grayscale, so PNG storage + `getDecodedMask`-style decode
  apply unchanged.
- **The Transformers.js load/cache pattern** — `lib/ai/bg-remove.ts`
  (lazy dynamic import, model-handle cache keyed by id, in-flight dedupe,
  HF-token from user prefs, progress callback forwarding).

Transformers.js `4.2.0` is installed and its dist references the
`depth-estimation` pipeline and `depth-anything-v2-small`, so no dependency
bump is required (verify exact repo ids at implementation time).

## Files

New:
- `src/lib/ai/depth-anything.ts` — the model helper. `estimateDepth(blob,
  {model, device, onProgress}) → ImageBitmap` (grayscale depth) +
  `depthToPngBlob` for baking. Lazy import + handle cache, mirroring
  `bg-remove.ts`.
- `src/lib/ai/depth-session.ts` — session store (live bitmap + per-frame
  bake), copied from `segment-session.ts`, depth-specialized (single mask
  kind, no `emb`/`dots`/`liveKind`). globalThis-parked; `useSyncExternalStore`
  subscription; `recordScopedFrame`/`getScopedFrame` bridge for layer-local
  frame keying.
- `src/nodes/effect/depth-anything.ts` — the NodeDefinition. Modeled on
  `nodes/effect/segment.ts` (no ML in `compute`; resolve which bitmap applies
  at `ctx.frame`, upload, run shader; `fingerprintExtras` folds session
  version + frame + decoded-readiness).
- `src/components/effects/DepthAnythingPanel.tsx` — model picker, Preview
  button, output toggle mirror, bake range (In/End), Bake / Cancel / Free
  Bake, status + progress bar. Modeled on `SegmentPanel.tsx` minus dots.

Edited:
- `src/nodes/index.ts` — register the node.
- `src/components/effects/ParamPanel.tsx` — dispatch `defType ===
  "depth-anything"` to `DepthAnythingPanel` (same block as Segment ~L482),
  passing `getRefImageBlob`, `captureNodeFrames`, `fps`, `sceneFrames`,
  `onParamChange`.
- `specdocs/061226_devguide.md` — add Depth Anything to the ML-node /
  known-edges notes after it ships.

No engine/types changes: output is a plain `image`, input is `image`. No new
socket type, no coercion changes, no schema bump (params are plain JSON;
the bake is session-only and deliberately not serialized).

## Node definition

```
type:        "depth-anything"
name:        "Depth Anything"
category:    "image"   subcategory: "modifier"
backend:     "webgl2"
inputs:      [{ name: "image", type: "image", required: true }]
primaryOutput: "image"
auxOutputs:  [{ name: "depth", type: "mask", description: "Depth as a single-channel mask" }]
headerControl: output mode enum on the node header — "depth" | "normal"
```

Params:
- `outputMode` enum `["depth","normal"]` default `"depth"` — surfaced as the
  header dropdown (`headerControl`) AND drives the shader path.
- `model` enum `["v2-small","v2-base","v2-large"]` default `"v2-small"`.
- `invert` bool default false — flip near/far.
- `near` / `far` scalars `[0,1]` (default 0 / 1) — remap the normalized depth
  (black/white points), applied in-shader.
- `normalStrength` scalar — gradient gain for the normal-map path
  (`visibleIf` outputMode === "normal").
- `inFrame` / `outFrame` scalars, hidden — bake range, edited via the panel
  (copy Segment).

### compute() (no ML here)

1. `recordScopedFrame(nodeId, ctx.frame)` (layer-local frame keying).
2. Resolve the depth bitmap for now: if baked, `getDecodedMask(nodeId,
   clamp(ctx.frame))` (request decode + `pushMediaSettle` when offline and not
   yet decoded; else `prefetchMaskDecodes`); else use the session `live`
   bitmap. (Identical control flow to `segment.ts` compute.)
3. Upload the bitmap to a cached texture (`ctx.state["depth-anything:"+id]`).
4. No bitmap yet → passthrough the input image (so downstream wiring works
   before first Preview/Bake), matching bg-remove/Segment pre-bake behavior.
5. Draw the selected shader to `primary`:
   - **depth:** sample depth (Y-flip — uploaded bitmap is Y-down), apply
     invert + near/far remap, write grayscale RGB, alpha 1.
   - **normal:** Sobel the depth texture (`u_invSize` neighbor step), build
     `normalize(vec3(-dx*strength, -dy*strength, 1.0))`, map to `[0,1]`.
6. `aux.depth` = the remapped grayscale as a `mask`.

### fingerprintExtras

Copy Segment's: `v<version>:f<frame>:<decoded?1:0>` when baked, else
`v<version>:<live?live:none>`. Folds in `outputMode`/`invert`/`near`/`far`/
`normalStrength` via the normal param fingerprint already (they're declared
params), so the shader path re-renders on toggle without busting the cache
across frames.

## depth-anything.ts helper (Transformers.js)

Mirror `bg-remove.ts`. Use the high-level pipeline (depth-estimation is a
recognized task, unlike RMBG):

```ts
const tx = await import("@huggingface/transformers");
// try WebGPU first, fall back to wasm
const pipe = await tx.pipeline("depth-estimation", repo(model), {
  device: "webgpu",            // fallback to undefined (wasm) on failure
  progress_callback: cb,
});
const out = await pipe(await tx.RawImage.fromBlob(blob));
// out.depth is a RawImage already normalized to 0..255 grayscale
// out.predicted_depth is the raw Tensor (kept in reserve, see flicker note)
const canvas = out.depth.toCanvas();
return await createImageBitmap(canvas);
```

Repo ids (verify on HF at build time):
`onnx-community/depth-anything-v2-small` / `-base` / `-large`.

Handle cache keyed by model id; in-flight dedupe; HF token from
`loadUserPreferences()` for any gated repo; forward `progress_callback` →
session status as `{phase:"loading-model", progress}`.

## depth-session.ts (copied from segment-session.ts)

Same shape, simplified:
- Drop `emb/embKey/dots/liveKind` and the `MaskKind` union (depth is one
  kind). Keep `live`, `bake {inFrame,outFrame,expected,masks:Map<frame,Blob>,
  bytes,complete}`, `decoded` LRU, `decodePending`, `status`, `version`,
  `scopedFrame`.
- Keep `MAX_BAKE_BYTES` (512 MB, shared budget — name it distinctly so it
  doesn't collide with Segment's), `DECODED_MAX`, `PREFETCH_AHEAD`.
- Same exports: `peek*`, `getStatus`, `isBaked`/`isLocked`, `recordScopedFrame`/
  `getScopedFrame`, `setLiveDepth`/`clearLive`, `runLivePreview` (latest-wins
  queue), `beginBake`/`addBakeMask`/`commitBake`/`freeBake`, `hasDecoded`/
  `getDecoded`/`requestDecode`/`prefetch`, `subscribe`/`getRev`.

## DepthAnythingPanel.tsx (copied from SegmentPanel.tsx, minus dots)

- Model `<select>` (V2 Small/Base/Large) — locked while baked (changing model
  under a bake would desync; require Free Bake first, like Segment's prompt
  lock).
- Output toggle (Depth / Normal) — mirrors the header control; writes
  `outputMode`. Editable anytime (cheap shader switch, no re-bake).
- **Preview** button → `runLivePreview(id, () => getRefImageBlob(upstreamId))`:
  debounced latest-wins single-frame inference on the current frame; stores
  the result as the session `live` bitmap. Auto-fire once when an input is
  first wired.
- Sliders: invert, near, far, normalStrength (normal mode only).
- Bake range In / End (copy Segment's `FrameInput` + "End" → `sceneFrames`).
- Bake / Cancel Bake / Free Bake driving `captureNodeFrames` exactly like
  `SegmentPanel.bake()`: build `frames[inFrame..outFrame]`, `beginBake`,
  per-frame `estimateDepth(blob) → depthToPngBlob → captured[]` (key by
  scoped frame if it advanced, else global), `commitBake`. Same identical-
  frames warning and byte-budget abort.
- Status row + progress bar (model download %, then bake N/total). Copy
  Segment's `Field/Slider/FrameInput/SmallButton/ActionButton/InlineSpinner`
  helpers (or extract shared — out of scope for v1).

## Known subtleties / call-outs

- **Temporal flicker (video):** Depth Anything is affine-invariant; the
  pipeline normalizes each frame's depth to its own min/max, so absolute
  brightness drifts frame-to-frame even on static scenes. v1 stores the
  pipeline's per-frame normalized 8-bit depth (simple, matches the live
  preview). Document this as a known limitation; a future "global normalize"
  option (capture raw `predicted_depth` min/max across the bake, renormalize
  to a fixed range) is the fix — note it but don't build it now.
- **Coordinate/alpha:** uploaded bitmaps are Y-down → flip in the shader
  (`1.0 - uv.y`), straight alpha, same as Segment/bg-remove.
- **Layer-local frame keying:** key baked frames by the node's scoped clock
  (`getScopedFrame`), trusting it only if it advanced across the capture —
  copy Segment's `scopedOk` check verbatim (prevents the freeze-at-first-frame
  bug for nodes inside offset layers).
- **Offline export:** the baked path already settles correctly — `compute`
  pushes the decode promise to `pushMediaSettle` when `ctx.offline`. An
  un-baked node during export holds its last live bitmap (or passthrough); a
  banner/doc should tell users to Bake the range before a video/gif export
  for frame-accurate depth.
- **Engine self-containment (invariant #1):** the node + helper sit in
  `src/nodes` / `src/lib/ai`. `nodes/effect/depth-anything.ts` must NOT import
  the session store from `src/lib` — wait: Segment's node DOES import
  `@/lib/ai/segment-session` from `src/nodes`. Confirm this is the accepted
  pattern (it ships today) and follow it; the ML helpers are panel+engine
  shared by design. (Flagged so we don't "fix" it.)
- **WebGPU vs WASM:** prefer `device:"webgpu"` for inference speed, fall back
  to wasm. This is inference-time only (the render path stays WebGL2).

## Milestones

1. **[DONE]** **Helper + session store** — `lib/ai/depth-anything.ts` (load +
   `estimateDepth` + `estimateDepthPng`, WebGPU→WASM fallback) and
   `lib/ai/depth-session.ts` (live + per-frame bake, copied from
   segment-session). tsc + eslint clean.
2. **[DONE]** **Node** — `nodes/effect/depth-anything.ts` (depth + normal
   shaders, compute, fingerprint), registered in `nodes/index.ts`. Passthrough
   until a preview/bake exists.
3. **[DONE]** **Panel + wiring** — `DepthAnythingPanel.tsx`; dispatched in
   `ParamPanel.tsx` on `defType === "depth-anything"`.
4. **[NEEDS IN-BROWSER TEST]** **Video bake** — wire an image → Preview shows
   depth, header/panel toggle to Normal; Bake over a Video Source range; scrub
   + play the baked range; export a short clip and confirm frame-accurate
   depth. Requires a GPU + ~100 MB model download + a video — manual. Tune
   byte budget / LRU / default dtype if needed.
5. **[DONE]** **Docs** — `061226_devguide.md` ML-node note added + this spec's
   status. (In-app docs page renders automatically from the node def.)

## Verified automatically (2026-06-19)

- `tsc --noEmit` clean across the whole project; `eslint` clean on all four
  new files.
- Node registered once, no duplicate `type` string.
- Model repos exist on HF with the ONNX weights transformers.js needs:
  `onnx-community/depth-anything-v2-{small,base,large}` → HTTP 200, each with
  `onnx/model.onnx` + fp16/quantized variants. (HF lists a newer `-ONNX`
  mirror; current ids are live and carry weights — no change needed.)

## Open questions (none blocking M1–M2)

- Exact onnx-community repo ids / whether V2 Large is worth shipping given the
  ~1.3 GB download (could ship Small+Base first, add Large behind the same
  enum later).
- Whether to extract the shared panel widgets + a generic ML-bake-session now
  or after a 3rd ML node justifies it (deferred per the Q&A).
