# Export resolution override + Export App un-breaking (2026-07-31)

Two changes from the 2026-07-30 export audit, approved by the owner:
(A) per-export **resolution control** on the Output node, and (B) fixing +
slimming the **Export App** bundle. A File → Export dialog was considered
and **deferred** to a later round (owner decision 2026-07-31).

## Findings this spec responds to

1. **Exports inherit the preview render scale (bug).** Every export path
   captures the preview canvas (`canvasRef`), which is sized
   `renderRes = canvasRes × previewScale` (EffectsApp ~:715). Lower the
   preview scale for editing fps and all exports silently shrink.
2. **No export resolution control** — exports are locked to canvas res.
3. **Export App throws its own 25 MB cap for every project.** The
   packager (export-packager.ts) sums the entire template — including the
   22 MB `ort-wasm-simd-threaded.asyncify` ONNX runtime that landed with
   the ML nodes — against `SIZE_CAP_BYTES = 25 MB`. Template dist alone is
   ~25 MB, so `packageExportApp` always throws before zipping.
4. **The ONNX wasm ships regardless of use.** ML code is dynamically
   imported (`await import("@huggingface/transformers")` behind the
   session stores in lib/ai), so the wasm is fetched at runtime only when
   an ML node computes — a non-ML export never touches it, yet it's 81%
   of the bundle.
5. The Export App modal's size estimate measures the manifest JSON only
   (~KBs), while the real payload lives in the graph + template.

## A. Export resolution override

### Params (EXPORT_PARAMS in src/nodes/output/output.ts)

Placed at the top of the list (applies to every product: image, video,
sequence, GIF; Layer Outputs and Render Queue rows inherit for free):

- `resolution` — enum `["canvas","scale","custom"]`, default `canvas`,
  `control: "segmented"`.
- `resScale` — scalar 0.25–4, step 0.05, default 1, visibleIf scale.
- `resWidth` / `resHeight` — scalar 16–8192, step 1, defaults 1920/1080,
  visibleIf custom.

No schema bump: new params with defaults; old saves resolve `canvas`
via `??` fallbacks (same pattern as every other export param).

### Resolution seam (EffectsApp)

`resolveExportResolution(params, canvasRes, { even }) → [w,h]` (lib/
export.ts): canvas → `canvasRes` verbatim; scale → rounded
`canvasRes × resScale`; custom → clamped W×H. `even: true` (video + GIF
paths) rounds down to even dims — H.264/H.265 reject odd sizes.

`withExportResolution([w,h], fn)` in EffectsApp:

- If `[w,h]` already equals the live backend res → run `fn` directly.
- Else set `exportResOverride` state; the `renderRes` memo returns the
  override **verbatim** (previewScale deliberately not applied — this is
  what fixes finding #1). The existing backend-recreation effect
  (~:1745, the battle-tested project-resolution-change path) tears down
  and rebuilds the engine at the target res; the preview canvas element
  resizes with it, so `canvas.toBlob` / `captureStream` / native-ffmpeg
  readback all capture at target res with **zero per-path changes**.
- Await readiness by polling `backendRef.current?.width` + the canvas
  element's width per rAF (timeout ~5 s → friendly error).
- `finally`: clear the override (restore recreation is fire-and-forget).

Wrapped around the full driver bodies (font pre-warm included):
`exportImage`, `exportVideo`, `exportSequence`, `exportGif`,
`renderImageToBlobAtFrame`. `renderQueue` rows go through the last two,
so per-row resolutions work; the wrapper is re-entrant (equal-res calls
pass through) so nesting is harmless. In-place `backend.resize()` was
rejected: it only resizes the hidden canvas — pool textures, eval cache,
and per-node size-keyed state would all go stale.

Behavior notes:
- **Fast-tier video now exports at the chosen resolution** (previously:
  whatever the preview happened to render at). Real-time capture at big
  res costs fps; that's the user's call via the tier.
- During an offline export the preview shows export-res frames; the
  RecordingBanner already covers this state.

### M0 groundwork — settled-frame helper

The two-pass deterministic render block (render → `awaitMediaSettle` →
conditional re-render → rAF flush) is duplicated in five places
(exportVideo's renderAt, renderImageToBlobAtFrame, exportSequence,
exportGif's renderAt, captureNodeFrames). Extract one
`renderSettledFrameAt(t, fps)` helper first; the resolution work then
touches one function instead of five.

## B. Export App fix + slim

- `ML_NODE_TYPES = ["bg-remove", "segment-anything", "depth-anything"]`
  (exported beside the packager). If **no node of these types exists
  anywhere in the serialized graph** (conservative: all compositions,
  reachable or not), `runExportApp` filters `assets/ort-*.wasm` out of
  `distManifest.distFiles` **before fetching** — the 22 MB file is
  neither downloaded nor zipped. Safe per finding #4 (runtime reference
  only fires when an ML node computes, which a graph without ML nodes
  never does).
- **Cap re-scope:** the 25 MB cap now applies to **user content** — one
  copy of the pretty-printed graph JSON + manifest — not the fixed,
  known-good template weight. This un-breaks Export App for every
  project, including ML ones (which keep the wasm). The modal warns when
  the ML runtime is included ("+22 MB ML runtime").
- **Real size estimate (M3):** `build-export-template.mjs` adds per-file
  byte counts to the template manifest; the modal estimate becomes
  template bytes (post-wasm-filter) + serialized graph length (graph is
  serialized once when the modal opens; estimate shows "…" until then).
  Old manifests without byte counts fall back to the current behavior.

## Out of scope (recorded, not forgotten)

- File → Export dialog (deferred by owner; MenuBar's disabled "Export…"
  stays as-is this round).
- Building the export template into the **web** deploy (Vercel build
  never runs `build:export-template`, so hosted Export App 404s —
  separate deploy-pipeline decision).
- Native ffmpeg for Render Queue / wedge batches; ffmpeg-core's unpkg
  fetch; GLB export cleanup.

## Shipped 2026-08-01 — behavior notes + incidental fixes

- All milestones implemented. Gates: typecheck / `npm run check` /
  lint:ratchet green on this slice (concurrent WIP in TrackEditor /
  GizmoTickOverlays / SplineEditorOverlay had its own in-flight errors).
- **Behavior changes beyond the spec:**
  - The Output footer's **Image button now always exports that Output's
    image** (forced terminal, settled two-pass render) — previously it
    snapshotted whatever the live canvas showed (the Active node).
  - **Fast-tier video** now records at the chosen export resolution
    (was: whatever the preview happened to render at).
- **Known small window:** `beginExportResolution`'s fast path re-checks
  dims one rAF later to dodge a pending restore recreation; changing the
  preview render scale mid-export remains as hazardous as it always was
  (guarded by the existing busy locks for user-driven paths).
- **Incidental fixes** (template build was broken by unrelated WIP; the
  release CI would have failed): `@/wasm` alias added to the template
  vite.config (engine/vector-kernel.ts), `FRAME_XY_PROPS` copy added to
  src/shims/state-graph.ts. Rule recorded in the devguide: new
  `@/state/graph` imports in graph-ops (or new `@/*` roots reaching the
  engine tree) must be mirrored in the shim/aliases or
  `build:export-template` breaks.
- lint:ratchet reports 1 error FIXED vs baseline — tighten with
  `npm run lint:ratchet -- --update` when the concurrent WIP settles.

## Milestones

- **M0** — extract `renderSettledFrameAt` (no behavior change).
- **M1** — resolution params + seam + wire all export paths.
- **M2** — wasm strip + cap re-scope (+ modal ML warning).
- **M3** — size-estimate fix (manifest bytes + modal).
- **M4** — devguide Export section + devlist notes; gates
  (`npm run typecheck`, `npm run check`, `npm run lint:ratchet`).

Verification is manual in the browser per repo convention; the export
paths especially need a hands-on pass (fast/high/max video, sequence,
GIF, queue, wedges, Export App with and without an ML node).
