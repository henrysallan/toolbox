# EXR import + color pipeline (2026-07-09)

Goal: work with 3D renders natively. Single and multilayer EXR files load
into **Image Source** (stills) and **Video Source** (numbered sequences),
with a per-node dropdown choosing which layer/AOV feeds the image socket.
A new **Color Space Transform** node handles ACES/linear↔display
conversions, and the existing **Apply LUT** node grows HDR support so
OCIO-baked LUTs work on scene-linear input.

Requirements confirmed in design Q&A (2026-07-09):

- Compression in practice: **DWAA usually, ZIP occasionally**.
- Layers: mostly **color AOVs** (combined/denoised/diffuse/spec…); data
  passes (Z, normals) are nice-to-have, not the driver.
- "OCIO" means **ACES / color-space conversion handling** — NOT arbitrary
  `.ocio` studio config loading. That rules out wasm-OCIO entirely (see
  Non-goals).
- Sources up to **4K 60fps** sequences.
- **Image Source takes single EXRs** too, not just the video node.

## Why this is tractable (what already exists)

- **The engine is HDR end-to-end.** The texture pool is RGBA16F
  (gl.ts), FLOAT uploads into 16F targets are the documented path, and
  readback is float. Scene-linear values > 1 survive wires, blends, and
  effects without clamping. No engine-format work needed.
- **The sequence chassis is done.** Video Source's sequence kind
  (video.ts) already has lazy per-frame decode, an LRU texture cache,
  offline-export settles, and pipeline-bump re-evals. EXR is a second
  decode path inside that machinery, not a new node.
- **The decoder is already in node_modules.** three r184's `EXRLoader`
  (single MIT file) decodes ZIP(S), RLE, PIZ, PXR24, B44/A and **DWA/B**,
  scanline + tiled layouts, parses **multi-part** headers and offsets
  multi-part chunk data. Both of our real-world formats (DWAA, ZIP) are
  covered.
- **Apply LUT exists** (.cube → TEXTURE_3D trilinear) — the HDR upgrade
  is two contained changes, not a new node.

## The decoder: a vendored fork (`src/engine/exr/`)

The stock EXRLoader decodes *every* channel generically, but its final
packing stage hard-codes the output to top-level `R/G/B/A`, `Y`, or
`Y/RY/BY` names and **throws** on multilayer files (`diffuse.R` →
"unsupported data channels"). The fork keeps all the decompression
machinery and replaces that last stage with a caller-supplied channel
mapping.

- **Files**: `src/engine/exr/parse.ts` (the fork), `layers.ts` (grouping
  heuristics), `worker.ts` + `decode-pool.ts` (off-main-thread decode).
  Engine-side so the export bundle gets it (invariant #1) — engine already
  imports npm libs (bezier-js, polygon-clipping); the fork keeps
  EXRLoader's one import, `unzlibSync` from
  `three/examples/jsm/libs/fflate.module.js`. Strip the three
  `DataTextureLoader` wrapper and all THREE.* texture-constant plumbing.
  **Checklist**: verify the export-template build resolves both that
  import and the worker (`new Worker(new URL(...))` — webpack and Vite
  both support the syntax, but confirm on the template build).
- **API**:
  - `parseExrHeader(buf: ArrayBuffer)` → `{ width, height, parts:
    [{ name, channels: [{ name, pixelType }], compression }] }`. Header
    only — no pixel decode, cheap enough to run at pick time.
  - `groupExrLayers(header)` → `[{ id, label, mapping: { r, g, b, a? } }]`
    (see heuristics below).
  - `decodeExr(buf, { part, mapping, unpremultiply })` →
    `{ data: Float32Array /* RGBA, GL-oriented */, width, height }`.
- **Layer grouping heuristics.** EXR has no formal layer object — layers
  are dot-separated channel-name prefixes with renderer-specific suffix
  conventions. Group by last-dot prefix; map suffix sets `R/G/B(/A)`,
  `X/Y/Z`→RGB, `U/V/W`→RGB; a lone channel (`Z`, `depth`, `id`,
  `Combined.A`-style orphans) broadcasts to RGB with A=1. Top-level RGBA
  = the "default" layer, always listed first. Multi-part files (Arnold/
  Karma write one part per AOV) contribute their parts as layers — the
  vendored core already parses all part headers and offsets part-numbered
  chunks; **verify against real samples in M1** and de-scope to part 0 if
  it fights back.
- **Alpha**: EXR color is **associated (premultiplied)** by spec; the
  engine is straight-alpha everywhere (invariant #4). Decode
  un-premultiplies (guarding a=0), behind a toggle param (default on).
  Known caveat: pure-emission pixels with a=0 (fire/glow renders) lose
  RGB under unpremultiply — the toggle is the escape hatch.
- **Orientation**: EXR scanlines are top-down; pack flipped to the GL
  y-up orientation at decode (the standard boundary flip, same as
  image-source).
- **Precision**: all channel types (half/float/uint) decode and pack to
  Float32Array, upload as **RGBA16F** (filterable in core WebGL2; 32F
  isn't without an extension, and the pool is 16F anyway). Color AOVs:
  perfect. Z/normals: fine in practice. World-position/cryptomatte
  exactness: not preserved — documented limitation (see Non-goals).
- **Workers**: DWAA decode of a 4K frame costs real milliseconds
  (~100–300ms/thread expected — measure in M1). Decode runs in a small
  worker pool (`min(4, hardwareConcurrency - 2)`), transferable buffers,
  main thread only uploads. Same async shape as the existing
  `createImageBitmap` path: `decoding` set / `pending` map /
  pipeline-bump / `pushMediaSettle` when `ctx.offline`.

## Video Source: EXR sequences

- **Registration** (lib/image-sequence.ts): detect EXR by magic bytes
  (`76 2F 31 01`) or extension; for the first frame run `parseExrHeader`
  instead of `createImageBitmap` for dims, and store the grouped layer
  list on the param value: `ImageSequenceParamValue.exr?: { layers }`.
  Picker `accept` becomes `"image/*,.exr"`; Electron native-dialog
  filters get `exr` added.
- **New params** (visibleIf the loaded sequence is EXR):
  - `exr_layer` — the dropdown. `ParamDef.options` is a static
    `string[]`, so this is a custom control (font-picker precedent for
    dynamically-populated options) reading the layer list from the
    sibling `sequence` param's value. Persists as a plain string; a
    missing layer on reload falls back to the default layer.
  - `exr_unpremultiply` — boolean, default true.
- **Decode path**: EXR frames route to the worker pool with the selected
  layer mapping; upload via `texImage2D(RGBA16F, RGBA, FLOAT)`, LINEAR
  filtering, straight alpha — a float sibling of `uploadBitmapTexture`.
  Layer choice is a param, so fingerprinting/caching is automatic; a
  layer switch clears the frame cache (decoded frames are layer-specific).
- **Cache becomes byte-budgeted.** `SEQ_CACHE_CAP = 12` frames is the
  wrong unit when a 4K RGBA16F frame is ~66MB. Replace with a byte
  budget (~512MB default) counting `w*h*8` per cached frame — bitmap
  frames keep effectively the old behavior, EXR frames cache fewer.
- **Decode-ahead**: while playing, speculatively enqueue the next N
  frames into the pool so playback consumes from cache.
- **Honest performance expectation**: 4K@60 *realtime raw* EXR playback
  is not achievable with JS decode (~6–20fps aggregate from a 4-worker
  pool at 4K DWAA, per M1 measurements). Behavior under starvation is
  the existing one — hold the last-good frame, never stall the rAF loop.
  Scrubbing while paused is responsive on cached frames. **Offline
  export is exact regardless** (frame-stepped + settles), which is the
  path that actually matters for output. A proxy-bake mode is the future
  escape hatch if interactive playback needs to be full-rate (Non-goals).

## Image Source: single EXR

- Picker accepts `.exr` (+ Electron filters). Detection as above.
- The param value keeps **the original EXR bytes** as the canonical
  source alongside the decoded float pixels; same `exr_layer` +
  `exr_unpremultiply` params (visibleIf EXR is loaded). Layer switches
  re-decode from the retained bytes.
- **Serialization**: float pixels don't fit the PNG-data-URL envelope,
  but the original bytes do — a new `{ kind: "exr", dataUrl }` envelope
  (base64 of the file bytes). The `.toolbox` writer already extracts any
  `dataUrl` envelope into a content-hashed binary asset, so local saves
  are efficient automatically; cloud saves inline it (DWAA stills are
  compact; a huge ZIP still is an accepted cost). Deserialize re-decodes
  via the engine module. New envelope kind = wire-shape change →
  **bump `CURRENT_SCHEMA` to 7** (invariant #2).
- Rendering is unchanged: fit/center at canvas res; the EXR branch
  uploads float data instead of an ImageBitmap.

## Color Space Transform node (`color-space-transform`)

Per-pixel shader node, `image → image`, category image/modifier.
Everything analytic — no LUTs, no config files.

- **Params**: `from` / `to` enums over a curated set:
  - Scene-linear: `Linear Rec.709/sRGB`, `ACEScg (AP1)`,
    `ACES2065-1 (AP0)`
  - Display: `sRGB`, `Rec.709 (BT.1886)`, `Gamma 2.2`
    (Display P3 later if wanted)
  - Implementation: decode transfer → 3×3 gamut matrix (through XYZ D65,
    Bradford-adapted constants, baked as literals) → encode transfer.
    No clamping except what the encode step mathematically requires.
- **View transform**: `view` enum — `none` / `ACES SDR` (the fitted
  RRT+ODT, Hill approximation) / `AgX` / `Filmic` — applied between
  gamut conversion and display encode, shown when `to` is a display
  space. This is the "make my linear render look right on screen" step
  and, with `from: ACEScg → to: sRGB, view: ACES SDR`, covers the stated
  OCIO need in one node.
- Alpha passes through untouched (straight-alpha RGB transforms are
  correct as-is).
- Canonical graph: `EXR (ACEScg) → [effects in linear] → CST → Output`.
- Future convenience (not v1): an `input_transform` param directly on
  Image/Video Source so footage lands in the working space without a
  separate node.

## Apply LUT: HDR upgrade

`ociobakelut` output (shaper + 3D cube) is the standard way ACES
transforms ship as LUTs; the current node breaks on scene-linear input
in two ways: the `[0,1]` domain clamp kills values > 1, and the RGBA8
volume bands on subtle grades.

- Add `shaper` enum (`none` / `log2`) with `shaper_min_stops` /
  `shaper_max_stops` params (defaults matching ociobakelut's) — encodes
  input into the cube domain before lookup.
- Upload the volume as **RGBA16F** from the parsed floats (drop the
  8-bit quantize in `lutToRgba8Volume`).
- Back-compat: defaults preserve current behavior exactly (`shaper:
  none`); the 16F volume is visually invisible on existing saves.

CST + HDR LUT together **are** the "OCIO node" for this project's needs.

## Milestones

1. **Decoder core** — vendored fork + layer grouping + worker pool.
   Verify against a real sample set: Blender multilayer ZIP, DWAA
   beauty+AOVs, a multi-part file, a data-pass file. Record 4K DWAA
   decode timings (they calibrate the cache/decode-ahead numbers and the
   playback expectations above). Manual harness: scratch page or console
   that logs headers/layers and blits a decoded layer.
2. **Video Source sequences** — registration, layer dropdown control,
   float upload, byte-budgeted LRU, decode-ahead, offline settles.
3. **Image Source stills** — picker, retained bytes, layer dropdown,
   `exr` envelope + schema bump to 7.
4. **Color Space Transform node** (+ docs page entries for it and the
   new source params).
5. **LUT HDR upgrade** (shaper + 16F volume).

## Implementation notes (shipped 2026-07-10)

All five milestones landed in one pass. Deviations and discoveries:

- **Schema landed at v8**, not 7 — v7 was taken by Merge per-layer masks in
  the same working period.
- **The DWA multilayer surgery was bigger than "swap the packing stage".**
  Upstream's decoder had never run on a multilayer file (its channel
  validation rejected them first), and four latent bugs surfaced once the
  fork let them through, all confirmed against real Blender output:
  1. The **unknown-rule channel block** (float `Depth.Z`, `Normal.X/Z` —
     anything without a standard DWA suffix rule) sits FIRST in each chunk
     and upstream never read *or skipped* it — every following stream
     misaligned, garbling all channels.
  2. One **CSC set per layer prefix** (upstream kept a single R/G/B trio
     that later layers overwrote), decoded sets-first-then-singles against
     shared sequential AC/DC counters.
  3. **RLE and UNKNOWN staging buffers are channel-planar** (per-channel
     regions; RLE byte-planes within each channel's region) — determined
     empirically: Depth decoded exactly under channel-planar, alphas under
     channel-major byte-planes.
  4. A **float channel caught by a lossy rule** (`Normal.Y` matches the
     float-typed "Y" luminance rule!) is DCT-coded and needs the
     half→float in-place expansion that only the trio path had. Note this
     also means Normal.Y is genuinely lossy in Blender DWAA files while
     X/Z are lossless — a file quirk, not a decoder bug.
  Plus mixed HALF/FLOAT support (per-channel byte sizes + readers) for ZIP
  and PIZ — Blender writes half color next to float data passes, so this
  was mandatory, not an edge case. B44 keeps a uniform-type guard; PXR24
  guards against UINT (its decoder silently skips them, shifting the rest).
- **Verification**: headless Blender 4.5 renders (64×48 Cycles cube;
  single-layer + multilayer × DWAA/ZIP/PIZ, 16- and 32-bit) decoded and
  compared cross-codec; ffmpeg (`-pix_fmt gbrapf32le` rawvideo) as an
  independent reference decoder for values + orientation; a hand-written
  multilayer ZIPS file (known values, premultiplied alpha, float depth
  ramp) for mapping/unpremultiply/broadcast/row-order exactness. All pass.
- **Measured decode cost** (M-series MBP, node ≈ browser V8): 4K
  (3840×2160) × 15-channel multilayer ≈ **4.2s/frame DWAA, 2.1s ZIP**;
  header-only parse ≈ 1ms. Chunk decompression covers ALL channels
  regardless of the selected layer, so channel count — not layer choice —
  drives cost. HD multilayer ≈ ¼ of that; single-layer roughly another ¼.
  Consequence: the 4K60 sequences from design-Q&A #4 will scrub-from-cache
  and hold frames during raw playback exactly as the perf section above
  predicted (the numbers are just ~10× the optimistic estimate for
  multilayer files). Proxy-bake remains the future escape hatch.
- **Worker pool details**: min(4, cores−2) module workers; job buffers
  TRANSFER, so a fresh worker is pinged before it gets a real job — the
  single-file exported app can't inline worker chunks (Tier-B dist/ ships
  the chunk fine), and on ping failure the pool drains synchronously on
  the main thread. `exrDecodeBacklog()` keeps Video Source's 3-frame
  decode-ahead from flooding the queue.
- **Image Source is cached** (stable), so decode readiness is folded into
  `fingerprintExtras` (uploaded-key + pending flag) — the bg-remove
  pattern, state-side instead of session-store.
- The **texture LRU byte budget** is 512MB, counting w·h·8 per EXR frame
  (RGBA16F) and w·h·4 per bitmap frame; eviction never drops the current
  frame. Pending (decoded, un-uploaded) frames cap at 8.
- The layer dropdown ids are label-derived (`p<part>/<prefix>`) so a saved
  selection survives re-picking a structurally-identical file.

## Non-goals (v1)

- **wasm OCIO / arbitrary `.ocio` configs** — explicitly not needed
  (design Q&A #3); CST + baked LUTs cover ACES handling.
- **Cryptomatte** — needs exact 32F + manifest parsing + ID picking UI;
  a separate feature if ever.
- **Deep EXR** — the vendored core has deep-scanline parsing, but
  nothing in the pipeline consumes deep samples. Flat-composite or
  reject politely.
- **32F exact data mode** — a possible future `data` option (RGBA32F +
  NEAREST) for position passes; 16F is the v1 contract.
- **Proxy bake** for full-rate 4K interactive playback.
- **EXR export** — natural follow-up (float readback exists; writing
  ZIP EXR is simple) and would close the linear-in→linear-out loop, but
  not part of this spec.
