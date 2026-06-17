# Output node — PNG sequence export (spec)

Snapshot 2026-06-17. Owner-requested feature: the Output node should be able
to render a **PNG (image) sequence** — one uniquely-named still per frame over
a frame range — as an alternative to a single video file. Also replaces the
Output node's "Duration (frames)" param with explicit **start / end frame**
inputs shared by both video and sequence export.

## Design decisions (settled with owner)

- **A sequence is an animated export delivered as N stills** — a sibling of
  Video, not of the single-still Image button. So the mode toggle and the
  frame range live with the existing animated-export params, and the per-frame
  render reuses the offline frame-stepping machinery the video exporters and
  `renderImageToBlobAtFrame` already use.
- **Toggle placement: a segmented "pill" in the ParamPanel** (`Video | Sequence`),
  rendered from a declared enum `ParamDef` (so it serializes + is back-compat
  safe for free). The Output node footer's second button reflects the active
  mode (label flips to "Sequence", dispatches the sequence path).
- **Delivery reuses the Render Queue's three modes** — `zip` (default, JSZip),
  `folder` (File System Access, Chromium-only), `sequential` (N downloads).
  Same param string values as Render Queue's `delivery` for consistency.

## Param changes (`src/nodes/output/output.ts`)

New / changed `ParamDef`s in the export block:

- `exportMode` — enum `["video","sequence"]`, default `"video"`, rendered as a
  segmented pill (`control: "segmented"`, a new optional `ParamDef` UI hint).
- `startFrame` — scalar, min 0, max 12000, step 1, default **0**.
- `endFrame` — scalar, min 1, max 12000, step 1, default **240**.
  Replaces `videoFrames`. Range is **half-open `[startFrame, endFrame)`** →
  frame count = `endFrame − startFrame`. Default `0..240` = 240 frames,
  identical to the old `videoFrames: 240`. Files are named by their true frame
  index so they line up with the timeline / keyframe ticks (0-indexed app-wide).
- `seqDelivery` — enum `["zip","folder","sequential"]`, default `"zip"`,
  `visibleIf exportMode === "sequence"`.
- Video-only params (`videoQuality`, `videoFormat`, `videoCodec`,
  `videoBitrateMbps`, `videoCrf`, `videoProresProfile`) gain
  `exportMode === "video"` to their `visibleIf`.
- `videoFps` becomes visible in sequence mode too (sequence always renders
  offline, so fps governs the timebase): `visibleIf` =
  `exportMode === "sequence" || videoQuality !== "fast"`.
- `imageFormat` / `imageQuality` stay always-visible — they already drive the
  single Image still and now also the sequence frame format (one format control
  for both).

Naming: `${base}.${frame.padStart(max(4, digits(endFrame-1)),'0')}.${ext}`
(e.g. `myrender.0000.png`). `base` = sanitized filename, or a timestamp base
derived from `defaultFilename()` when blank. Zip is `${base}.zip`.

## Back-compat (invariant #2 — no schema bump)

Additive param introduction, handled in `migrateLoadedParams`
(`src/lib/project.ts`) exactly like the gradient `angle → start/end` precedent:

```
if (defType === "output" && params.startFrame === undefined
    && typeof params.videoFrames === "number") {
  params.startFrame = 0;
  params.endFrame = params.videoFrames;
}
```

`exportVideo`/`exportSequence` also read `startFrame ?? 0` and
`endFrame ?? (startFrame + (videoFrames ?? 240))` defensively for any in-memory
node that never went through deserialize. Old `videoFrames` value is left in
params untouched (harmless; no longer declared).

## Code changes

1. **`engine/types.ts`** — add optional `control?: "segmented"` to `ParamDef`
   (declarative UI hint; engine ignores it, ParamPanel honors it).
2. **`ParamPanel.tsx`** — in the `enum` branch, render a `SegmentedControl`
   pill when `param.control === "segmented"`, else the existing `Dropdown`.
3. **`EffectsApp.tsx`**
   - `exportVideo`: derive `startFrame`/`endFrame`/`durationFrames`; offline
     `renderAt` computes `t = (startFrame + frameIndex) / exportFps`; fast path
     seeks to `startFrame/previewFps` before recording; audio buffer offset by
     `startFrame/exportFps`.
   - new `exportSequence(nodeId)`: take over offline rendering once, loop
     `[startFrame, endFrame)`, deterministic two-pass render per frame
     (issue media seeks → `awaitMediaSettle` → re-render), read canvas blob,
     deliver per `seqDelivery`. Progress via the existing
     `setRecording({mode:"offline",…})` overlay. Mirrors the Render Queue
     delivery loop (`zip`/`folder`/`sequential`).
   - `effect-node-export` handler: add `kind: "sequence" → exportSequence`.
4. **`EffectNode.tsx`** — footer's 2nd export button reads
   `data.params.exportMode`; label/`kind` = `"sequence"` vs `"video"`.
5. **`export-audio.ts`** — `renderExportAudioBuffer(spec, durationSec, startSec=0)`
   shifts the source offset so the rendered window begins at project time
   `startSec` (keeps audio aligned when `startFrame > 0`).

## Limitations

- `folder` delivery needs a Chromium browser (File System Access) — inherited
  from the Render Queue; `zip` is the cross-browser default.
- `sequential` delivery fires one browser download per frame — fine for short
  ranges, noisy for long ones; that's the user's explicit choice.

## Out of scope (for now)

- Render Queue items don't get a per-item sequence mode; a queued Output still
  renders video/still per its kind. (Could revisit if requested.)
- Exported-app / live-viewer sequence export.
