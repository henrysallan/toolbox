# GIF export + Image-sequence Video Source (spec, 2026-06-18)

Two independent features. Design settled with the owner via Q&A; this doc is
the build contract. Read alongside `061226_devguide.md` (architecture) and
`061726_png-sequence-export.md` (the export-mode precedent this extends).

## Locked decisions (owner Q&A, 2026-06-18)

- **GIF "compression" = a lossy slider.** Not a JPEG-style quality number and
  not just dithering — an explicit lossy-LZW knob. ffmpeg's gif encoder cannot
  do lossy, so a lossy-capable encoder is required (new dependency — see
  "Encoder" below). The other two GIF knobs are **number of colors** (palette
  size) and a **transparency toggle**.
- **Image sequences are selected by multi-selecting files** (`<input
  multiple>`), not a folder picker. Works in every browser.
- **Gaps in the trailing numbers are honored** (held/repeated frames, AE-style)
  — NOT packed. Timeline length = `maxNumber − minNumber + 1`.
- **Sequences relink on load** (same class as video/audio): the decoded frames
  are not embedded in cloud saves; the user re-picks on reopen.

---

## Feature A — GIF export (Output node)

### UI / params (`src/nodes/output/output.ts`)

`exportMode` enum gains a third option: `["video", "sequence", "gif"]` (still a
`control: "segmented"` pill). New GIF-only params, all `visibleIf p.exportMode
=== "gif"`:

| param            | type    | range / options          | default | maps to                       |
|------------------|---------|--------------------------|---------|-------------------------------|
| `gifColors`      | scalar  | 2–256, step 1            | 256     | palette size (quantization)   |
| `gifDither`      | enum    | none / bayer / floyd     | floyd   | dithering during quantize     |
| `gifLossy`       | scalar  | 0–200, step 1 (softMax 100) | 0    | gifsicle `--lossy=N`          |
| `gifTransparent` | boolean | —                        | false   | keep source alpha as GIF transparency |

Frame range (`startFrame`/`endFrame`) and `videoFps` are shared with video/
sequence and already exist. GIF delay is `round(100 / fps)` centiseconds per
frame (GIF time base is 1/100 s; effective cap ~50fps). `gifDither` is kept
even though "compression" maps to `gifLossy`, because dithering is the other
real quality/size lever and pairs with `gifColors`.

### Encoder pipeline (`src/lib/export-gif.ts`, new)

Reuses the offline capture loop already used by video/sequence
(`renderAt(frameIndex, t)` → canvas → bytes). Two-stage:

1. **Build the animated GIF** from captured RGBA frames with palette +
   transparency + dithering. Recommended: **ffmpeg.wasm palettegen/paletteuse**
   (already bundled for "max" video; highest-quality palette). Knobs:
   `palettegen=max_colors=<gifColors>:reserve_transparent=<gifTransparent>`,
   `paletteuse=dither=<none|bayer|floyd_steinberg>:alpha_threshold=128`.
   Capture frames as PNG (already alpha-preserving) so transparency survives.
2. **Lossy pass** (only when `gifLossy > 0`): pipe the GIF through
   **gifsicle-wasm** with `--lossy=<gifLossy> -O3`. This is the new dependency.

DECISION TO CONFIRM (owner): encoder for stage 1.
  - (rec) ffmpeg.wasm — best palette, already a dependency, BUT forces the
    ~30MB ffmpeg core download for anyone exporting a GIF (cached per session).
  - gifenc — tiny pure-JS, avoids the 30MB download, slightly weaker palette.
  Either way stage 2 (`gifsicle-wasm`) is the new dep that delivers the lossy
  slider. If owner wants zero ffmpeg dependency for GIF → gifenc + gifsicle.

### Dispatch (`src/components/effects/EffectsApp.tsx`)

- New `exportGif(nodeId)` callback alongside `exportVideo` / `exportSequence`,
  reusing the offline render scaffold (`offlineRenderingRef`,
  `forcedTerminalRef`, `renderAt`, `awaitMediaSettle`, progress via
  `setRecording`). Delivers via `downloadBlob(..., 'gif')`.
- Wire the export-trigger event (currently `video`/`sequence`/`image`) to also
  accept `gif`; PlaybackBar/Output export button routes `exportMode==="gif"`
  there. Render Queue: out of scope for v1 (note it; GIF stays standalone).

### Back-compat

`exportMode` default stays `video`; old saves unaffected. New params are
additive with defaults.

---

## Feature B — Image sequence on Video Source (`src/nodes/source/video.ts`)

### Source-kind toggle

Add `source_kind` enum (`["video", "sequence"]`, segmented, default `video`).
`file` (video_file) stays visible for `video`; a new `sequence` param
(`image_sequence` type) shows for `sequence`. `fit` / `speed` / `loop` /
`start_offset` / `sync_to_scene_time` are shared. New `seq_fps` scalar (1–120,
default 24) only `visibleIf source_kind==="sequence"` — image sequences have no
intrinsic frame rate.

### New param type `image_sequence`

`ParamType` union gains `"image_sequence"`. Value shape (`types.ts`):

```ts
export interface ImageSequenceFrame {
  number: number;     // trailing integer parsed from the filename
  blob: Blob;         // ENCODED bytes (png/jpeg…), NOT decoded — memory-cheap
  filename: string;
  size: number;
}
export interface ImageSequenceParamValue {
  frames: ImageSequenceFrame[]; // sorted by `number`
  min: number; max: number;     // numbering bounds
  length: number;               // max − min + 1 (timeline frames, gaps included)
  width: number; height: number;// from the first decoded frame (dims only)
}
```

We store **encoded blobs**, not decoded ImageBitmaps — hundreds of frames stay
RAM-reasonable; decode is lazy in the node (below).

### Loader UI (`src/lib/image-sequence.ts` + ParamPanel control)

- `registerImageSequence(files: File[]): Promise<ImageSequenceParamValue>`:
  - Parse trailing integer per filename: `/(\d+)(?=\D*$)/` (last run of digits).
    Files with no number are dropped (warn).
  - Sort by `number`; `min`/`max`/`length = max-min+1`.
  - Decode ONLY the first frame to read `width`/`height`; keep the rest as blobs.
- `ParamPanel` `image_sequence` control: a `<input type="file" accept="image/*"
  multiple>` "Load Sequence" button + a pill showing
  `name pattern · N frames (min–max)` and a thumb of frame 0. Mirrors
  `VideoFileControl`.

### Node compute (lazy decode + offline settle)

Mirror the existing Video Source structure (`hasUploadedFrame` last-good-frame
trick + `pushMediaSettle`/`videoSeekSettle` for offline). Differences:

- **Time → frame index.** `localFrame = floor((ctx.time*speed +
  start_offset) * seq_fps)`; `loop` ⇒ `((localFrame % length)+length)%length`,
  else clamp `[0, length-1]`.
- **Honor gaps.** Precompute (cache on node state, keyed by value identity) a
  forward-filled `resolved[length]` mapping each timeline index → the
  `frames[]` entry to show (largest present `number ≤ index+min`; leading gap
  shows the first present frame). The displayed frame for `localFrame` is
  `resolved[localFrame]`.
- **Decode.** Per-node LRU cache `Map<frameArrayIndex, {bitmap; tex}>` (cap ~12).
  On compute: target = resolved frame's array index. If a texture is cached,
  bind it. Else kick `createImageBitmap(blob)` → upload to a pooled GL texture,
  evict LRU. While the decode is in flight, render the last-good texture (no
  black flash). `createImageBitmap` is a Web API (no `src/lib` import) so the
  engine self-containment invariant (#1) holds.
- **Offline export.** When `ctx.offline`, if the target frame's texture isn't
  ready, `pushMediaSettle(ctx, <decode promise>)` so the export waits for the
  decode before capturing — same contract video seeks use. Dispatch a
  `pipeline-bump` on async decode completion during realtime playback.
- `stable: false` already set (video re-evals every frame) — keep it.
- `fingerprintExtras`: for sequences return `seq:${resolvedFrameNumber}` so
  downstream busts when the displayed frame changes (parallels the video
  `currentTime` extra).

Fit math / UV-input handling / shader are unchanged (reuse the existing
`video-source/fit` program; uploaded ImageBitmap samples the same way).

### Persistence + relink (`project.ts`, `media-relink.ts`)

- `image_sequence` serializes like `video_file`: the value is replaced with a
  **lightweight descriptor** (no blobs) under the `__missingMedia` marker —
  `{ kind: "image_sequence", frames: [{number, filename, size}], min, max }`.
  Save stays small.
- On load: descriptor → a "missing media" entry. Relink UI gets a sequence
  branch: the user multi-picks files; we re-parse/sort and match the set by
  filename (+size when available) to rebuild `ImageSequenceParamValue`. No
  File System Access handle (multi-file picks don't yield persistable handles),
  so sequences are manual-relink only — acceptable per the owner decision.
- `.toolbox` local files: out of scope for v1, but note the natural follow-up
  is bundling frames as content-hashed assets so local files need no relink.

### Type ripple (per devguide invariant #7 / new-ParamType checklist)

`image_sequence` is a media param, NOT a socket type — lighter than a
SocketType addition. Touch points: `types.ts` (union + value interface) →
`ParamPanel` renderer + media-pill branch (~line 2512) → serialization in
`project.ts` (missing-media path) + `media-relink.ts` → it is not keyframable,
not exposable, not an export control. Confirm it's excluded from
`controlParams`/exposable lists.

---

## Milestones

GIF and sequence are independent; ship in this order.

1. **GIF UI** — DONE. `exportMode: "gif"` + Colors/Dithering/Lossy/Transparency
   params on the Output node.
2. **GIF encoder** — DONE. `export-gif.ts` (ffmpeg palettegen/paletteuse +
   gifsicle-wasm lossy), `exportGif` dispatch in EffectsApp, EffectNode button
   + event wiring, download. Dep `gifsicle-wasm-browser@1.5.19` added.
3. **Sequence param + loader** — DONE. `image_sequence` ParamType + value
   interfaces (types.ts), `registerImageSequence` (lib/image-sequence.ts),
   `ImageSequenceControl` in ParamPanel, `source_kind`/`sequence`/`seq_fps`
   params on Video Source.
4. **Sequence playback** — DONE. Video Source compute branch: time→frame,
   honor-gaps `resolved[]`, lazy `createImageBitmap` decode + LRU texture cache
   + offline `pushMediaSettle` + pipeline-bump.
5. **Sequence persistence** — PARTIAL. Serialize strips blobs to a descriptor
   (crash-safe); deserialize → null. **TODO**: the multi-file relink re-pick UI
   (MediaRelinkModal + a set-aware matcher) so a saved sequence reloads — until
   then sequences are session-only across reloads.
6. **Docs** — DONE for the devguide (export tiers + Video Source notes).
   **TODO**: in-app docs pages for the GIF mode + sequence source kind.

## Remaining follow-ups

- **Sequence relink re-pick UI** (milestone 5 tail): extend `MediaEnvelope` /
  `MissingMedia` with an `image_sequence` kind carrying the per-frame
  descriptor, park it under the `__missingMedia` marker on load, and teach
  MediaRelinkModal to let one multi-pick satisfy a whole sequence (match the
  picked set to the descriptor's filenames, rebuild via `registerImageSequence`).
- In-app docs for both nodes.
- `.toolbox` local-file bundling of sequence frames (content-hashed assets) so
  local saves need no relink at all.

## Manual verification still needed (no test runner; browser-only)

- GIF: export a short animation with transparency on/off, low color counts, and
  a few Lossy values; confirm palette/transparency/file-size behave and the GIF
  loops. First GIF export pulls the ~30MB ffmpeg core (expected).
- Sequence: multi-pick a numbered set (incl. a gap), confirm playback order,
  gap-holding, `seq_fps`/speed/loop, fit, scrub responsiveness, and a clean
  frame-accurate offline export (video/GIF) of the sequence.
