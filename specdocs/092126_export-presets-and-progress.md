# Export presets, "what you get", and two-bar progress (2026-09-21)

**Status:** built 2026-09-21 on top of 092126_export-capture-readback.md.
Offline gates green; needs a desktop run (§Verify).

## Why

Testing the readback fix surfaced three UX problems in the same afternoon:

1. **Max · mov · h264-lossless** made 2.3–4.5 GB files (4.7–9 Gbps) that
   QuickTime and Preview could not play. Correct behaviour — lossless 4:4:4
   H.264 has no hardware decoder anywhere — but nothing in the UI said so.
2. **Max · mov · hevc** silently encoded **x264 CRF 18 in 4:2:0**: `hevc` is
   a WebCodecs name the Max tier does not know. The user believed they had
   exported HEVC. Likewise **High · mov** writes an `.mp4`.
3. The progress bar "jumped": the frame loop wrote "Encoding 120/240" while
   ffmpeg's stderr wrote "Encoding 61/240" into the same bar. Both were true
   — x264 trails the capture by its lookahead — and one bar cannot say so.

Underneath, the Output node exposed the pipeline raw: a tier, a container
list the tiers only partly honour, one codec menu mixing both tiers' names.

## Presets (`src/lib/export-presets.ts`)

`videoPreset` names the outcome and resolves to the same underlying settings
the exporter always used (`tier / container / codec / bitrate / crf / ProRes
profile / alpha`). `custom` shows the raw rows.

| Preset | Tier · file | For |
|---|---|---|
| Master · ProRes 4444 (mov) | max · prores 4444 | grain-safe master, hardware decode on Macs |
| Master · ProRes 4444 + alpha (mov) | max · prores 4444, alpha | transparent master (desktop app) |
| Master · ProRes 422 HQ (mov) | max · prores hq | 10-bit 4:2:2 mastering standard |
| Review · H.264 near-lossless CRF 12 (mov) | max · h264 crf 12 | keeps grain, plays in QuickTime, slow |
| Review · H.264 high quality CRF 16 (mp4) | max · h264 crf 16 | clean, plays everywhere |
| Delivery · HEVC hardware 150 Mbps (mp4) | high · hevc 150 | **default** — fast, small, Apple-wide |
| Delivery · HEVC hardware 60 Mbps (mp4) | high · hevc 60 | sharing copy |
| Web · H.264 hardware 40 Mbps (mp4) | high · avc 40 | most universal |
| Web · VP9 (webm) | high · vp9 30 | open web |
| Alpha · QuickTime Animation (mov) | max · qtrle | AE / Premiere transparency |
| Archive · H.264 lossless 4:4:4 (mov) | max · h264-lossless | archives, ffmpeg / Resolve only |
| Preview · quick real-time capture (mp4) | fast | MediaRecorder |
| Custom… | the raw rows | |

Rules:

- `effectiveVideoPreset(params)`: stored id if known or `custom`; an
  untouched node → the default; a save that predates presets but has any raw
  encoder row → `custom` (so nothing silently changes); an unknown id (a
  preset removed later) → the default. `project.ts` also writes `custom`
  into such saves on load so the panel and the exporter cannot disagree.
- `resolveVideoExportSettings(params)`: a preset's table, or the raw rows
  with the defaults they always had (High / mp4 / avc / 16 Mbps / CRF 18 /
  ProRes HQ / alpha on).
- The raw rows (`videoQuality` … `videoAlpha`) are visible only under
  Custom; their labels now name the encoder each value means
  ("hevc — HEVC (WebCodecs, high tier)", "h264 — x264 CRF (ffmpeg, max
  tier)"). Bitrate's hard max rose to 400 Mbps (soft 200).

### `describeVideoExport(settings, ctx)`

The single description of what the pipeline really does: the container
and codec after the tier's substitutions (hevc under Max → h265, h264 or
mov under High → avc / .mp4, ProRes or Animation → .mov), the encoder that
runs, the chroma / bit depth, what plays the file, a size estimate (fixed
bitrates and Apple's ProRes data rates; "content-dependent" with measured
numbers for CRF and lossless), and warnings for the traps: lossless H.264
playback, browser ProRes alpha, browser AV1, wasm memory at large sizes,
low bitrates at large sizes. `ExportSummary` in ParamPanel renders it under
the export rows for both the Output node and a Layer Output; `exportVideo`
logs the same lines, so the log matches the promise.

## Two-bar progress

`recording` gains `encode?: { label, progress }`. The frame loop owns the
first bar (`Rendering 120/240 · 2.2 fps · 55 s left`); an encoder that
reports separately owns the second: the native session's ffmpeg frame
counter (then "Finalizing…" while x264 drains its lookahead), the wasm
tier's encode pass, the GIF palette / encode / optimize steps. Writers merge
through functional `setRecording` updates (`setCaptureProgress`,
`setEncodeProgress`, `setPhaseProgress`) so they no longer overwrite each
other. Exporter `onProgress` callbacks carry an optional `phase`
(`export-capture.ts: ExportPhase`); WebCodecs, the sequence exporter and
stills stay single-bar.

## Verify

- `npm run check:export-presets` — table, resolution rules, description,
  Output rows.
- Desktop: pick a preset, read the "you get" block, export. The log's first
  lines are the same block. Try Custom · Max · hevc: the block warns "will
  use h265" before you export.
- Watch the banner on a Max export: two bars, the second trailing by ~60
  frames, then "Finalizing…".

## Not here

Asynchronous pipelined readback (`092126_async-pipelined-readback.md`,
handed to a separate session), hardware ffmpeg encoders
(`prores_videotoolbox`, `hevc_videotoolbox`), a lossless-preset change from
veryslow to medium (the Archive preset still uses veryslow as shipped in
`export-ffmpeg-args.js`), streaming transport, the browser pixel budget.
