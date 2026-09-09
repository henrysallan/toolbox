# Video Source — timeline scrub audit (2026-09-04)

Status: **audit; R1 and R3 shipped the same day** — see
[090426_video-frame-cache.md](090426_video-frame-cache.md). R2 (as a
decoder-only proxy) and R4 shipped 2026-09-06 in
[090526_video-scrub-optimizations.md](090526_video-scrub-optimizations.md);
R5 (`-g` on transcode-for-playback) and R6 (per-frame seek threshold)
remain open. Line
references below are to the tree BEFORE those changes. Findings carry
file:line evidence against the working tree on 2026-09-04 (owner WIP
included, audited as it sits).
Seek latencies below were measured in a headless-ish Electron 42 harness on
this Mac (`scripts/bench-video-seek.cjs`, see §5), not in the editor — the
MCP bridge was down this session, so the editor's own per-frame overhead
(§2 F3) is described from code, not measured.

## 1. Verdict

Scrubbing is slow for two compounding reasons, one of which is a plain bug:

1. **The node throws away every frame that lands while the pointer is still
   moving.** In `compute`, the paused branch issues the *next* seek before the
   upload block runs, and writing `currentTime` drops `readyState` below
   `HAVE_CURRENT_DATA` synchronously (measured 60/60). So the frame that just
   landed is never uploaded — the picture freezes at the pre-drag frame and
   only updates once the pointer rests long enough for a seek to land *and*
   an eval to run with drift ≤ 10 ms. The comment in that branch ("Letting
   each seek finish shows real intermediate frames") describes intended
   behavior that the ordering defeats. [video.ts:771-797](../src/nodes/source/video.ts#L771-L797)
   vs the upload at [video.ts:842-875](../src/nodes/source/video.ts#L842-L875).
2. **Each `<video>` seek re-decodes from the previous keyframe, in both
   directions, even for a +1-frame step.** Cost is set by the source's
   keyframe interval (GOP), not by the app. libx264's default GOP is 250
   frames; a 4K GOP-250 file costs 150–240 ms per landed frame (4–7 fps
   ceiling before any app overhead); the same content re-encoded 1080p
   all-intra costs 6.7 ms in any direction.

Fixing (1) is a small change inside video.ts and gets scrubbing to the
decoder's rate. Getting "much, much faster" on long-GOP 4K sources needs one
of the decode-path options in §3 (a scrub proxy on desktop, or a WebCodecs
GOP frame cache — mediabunny is already a dependency).

## 2. Findings

Severity: **bug** = wrong behavior · **cost** = dominant measured latency ·
**overhead** = app-side latency in the chain · **minor**.

**F1 · bug · intermediate frames never reach the texture while dragging.**
Sequence during a paused drag: pointermove → `setTime` → store → one rAF →
eval A issues seek T1 (`currentTime = T1`, readyState → 1). Pointer moves to
T2 → eval B: `video.seeking`, no retarget (correct), `ready` false, draws
the old texture. T1 lands → `seeked` → pipeline-bump → eval C: the sync
block runs first, sees drift T2−T1 > 0.01 and not seeking, writes
`currentTime = T2` — readyState drops again — then the upload block finds
`ready === false`. T1 is never uploaded. Repeat for every frame until the
pointer stops. Net: the texture only changes when the playhead is at rest.

Fix shape: upload before you seek. Either move the whole `ready`/upload
block ahead of the `if (sync)` block (the offline two-pass in
[EffectsApp.tsx:8305-8320](../src/components/effects/EffectsApp.tsx#L8305-L8320)
still works — pass 2 uploads the settled frame, then sees drift < 0.005 and
issues nothing), or in the paused branch snapshot readiness and upload
before writing `currentTime`.

**F1b · bug (latent, surfaces once F1 is fixed) · downstream nodes would
still miss the intermediate frame.** `fingerprintExtras` stamps
`vt:currentTime`, and `currentTime` reports the *pending seek target* while
seeking (measured identical before/after landing, 100/100). Fingerprints are
computed before compute runs ([evaluator.ts:1765-1778](../src/engine/evaluator.ts#L1765-L1778)),
so eval B (seeking to T1, no upload) and eval C (T1 landed, uploads) carry
the same `vt:T1` → every cacheable node downstream hits its cache and keeps
compositing the T0 texture. Today this is masked because C never uploads
either. The fix must make the stamp describe *the frame this eval will
upload*: `vt:` = `currentTime` when `!seeking && readyState ≥ 2`, else the
last-uploaded time kept in `VideoState`. `fingerprintExtras` already
receives `ctx` and `nodeId`, so it can read the node's state.
[video.ts:451-455](../src/nodes/source/video.ts#L451-L455).

**F2 · cost · seek latency is the source's keyframe interval.** Chromium's
seek path is: flush decoder → demuxer seeks to the preceding keyframe →
decode forward to the target. Distance from the keyframe is the cost, so a
backward 1-frame step costs a full GOP and a forward step costs on average
half of one. Measured medians (ms per landed seek, `<video>` + `seeked`,
30 fps synthetic content, local Blob URL):

| clip | +1 frame | −1 frame | random | retarget every 16 ms: landed / writes |
|---|---:|---:|---:|---:|
| 1080p H.264 GOP 250 (libx264 default) | 38.5 | 63.4 | 46.3 (p90 92) | 8 / 59 |
| 1080p H.264 GOP 30 | 10.1 | 9.2 | 8.9 | 59 / 59 |
| 1080p H.264 all-intra | 6.7 | 6.7 | 6.7 | 58 / 58 |
| 4K H.264 GOP 250 | 146 | 236 | 171 (p90 334) | 1 / 59 |
| 4K H.264 GOP 30 | 37.9 | 34.6 | 34.5 | 5 / 59 |
| 4K H.264 all-intra | 26.3 | 26.3 | 26.3 | 1 / 60 |
| 1080p all-intra proxy made from the 4K GOP-250 file | 6.7 | 6.7 | 6.6 | 58 / 58 |

Synthetic `testsrc2` frames decode faster than camera footage; treat the
ratios as the finding, not the absolute numbers. Typical sources: iPhone
≈ 1 s GOP (30–60 frames), screen recorders and libx264 defaults 250 frames,
web downloads 2–5 s. Anything the desktop app transcodes on import (§F5)
is GOP 250.

**F3 · overhead · the chain between "frame landed" and "next seek issued"
goes through a React render of the whole shell.** `seeked` →
`pipeline-bump` ([lib/video.ts:139](../src/lib/video.ts#L139)) → rAF →
`setPipelineBumpKey` ([EffectsApp.tsx:2062-2075](../src/components/effects/EffectsApp.tsx#L2062-L2075))
→ EffectsApp re-renders → the state-driven eval effect
([EffectsApp.tsx:3082-3110](../src/components/effects/EffectsApp.tsx#L3082-L3110))
→ `renderFrame` → full graph eval → the video node issues the next seek.
The decoder idles for that whole span. The clock-store migration
(072226 review) took playback and scrubs *off* React; media bumps were
left on it, and webcam / audio-meter bumps ride the same path. With a
short-GOP or proxy source (7–10 ms seeks) this chain, not decode, becomes
the bottleneck. Not measured this session.

**F4 · correct · the in-flight coalescing guard must stay.** Retargeting
`currentTime` on every pointer event lands almost nothing on long-GOP
sources (measured: 59 writes → 8 landed at 1080p GOP 250, 1 at 4K); the
guard at [video.ts:788](../src/nodes/source/video.ts#L788) is the reason
the drag currently lands *any* frames. Short-GOP sources tolerate
retargeting (59/59), which is why the proxy route in §3 also makes the
guard nearly moot.

**F5 · minor · the desktop transcode-on-import path produces worst-case
files.** [electron/ffmpeg.js:228-233](../electron/ffmpeg.js#L228-L233)
uses libx264 with no `-g`, so a file that needed transcoding (HEVC, ProRes,
10-bit) comes back GOP 250 — the slowest-scrubbing class above. Adding
`-g 30` (or `-g 1` for scrub-first) is free. Only applies to files
Chromium could not decode natively.

**F6 · unmeasured · cloud (R2) sources seek over HTTP range requests.**
`registerVideoUrl` streams instead of downloading, so every seek can be a
network round trip on top of decode. Not measured; worth a separate check
before assuming the local numbers apply.

**F7 · minor · the paused seek threshold is absolute, not per-frame.**
`absDrift > 0.01` ([video.ts:788](../src/nodes/source/video.ts#L788))
blocks single-frame steps on ≥ 100 fps timelines (a 120 fps frame is
8.3 ms). Use half a frame of the timeline fps.

## 3. Options, in the order I'd do them

**R1 · Fix F1 + F1b in video.ts (small).** Upload the landed frame before
issuing the next seek; make `vt:` describe the uploadable frame. Expected
result on today's sources: scrub shows frames at the decoder's rate —
roughly 15–25 fps forward / 10–15 fps backward on 1080p GOP 250, 4–7 fps on
4K GOP 250 — instead of freezing until the pointer rests. Not "much much
faster" on long-GOP 4K, but it changes the feel from broken to slow, and
every later option builds on it.

**R2 · Scrub proxy on desktop (medium, Electron only).** ffmpeg-static is
already bundled. Generate a 1080p (or 720p) all-intra H.264 proxy per clip
— at import, or lazily on the first scrub — and hold a second `<video>`
element on it. Use the proxy while `ctx.playing` is false (scrubbing,
paused stepping) and the original for playback, audio and export. Measured
seek cost on the proxy: 6.7 ms in every direction; the 4K native all-intra
variant is 26 ms and 1.6× the file size, so downscaling is the better
trade for a scrub-only surface. Costs: encode time roughly real-time or
faster at `veryfast`; ~80 MB per minute at 1080p CRF 20 (13.7 MB for the
10 s test clip); the relink/asset flows need to know the proxy is derived
and disposable. This is what every NLE does and it makes F2 disappear on
desktop. Web builds fall back to R1 behavior.

**R3 · WebCodecs GOP frame cache via mediabunny (larger, all platforms).**
mediabunny 1.41 is already a dependency (export-webcodecs.ts). Decoding
*forward* through a GOP is nearly free — measured 0.3 ms/frame at 1080p
and 1.4 ms at 4K pipelined — while random access pays the same
keyframe-distance cost as `<video>` (60 ms / 187 ms). So the win is not
"decode the target frame", it is "decode the whole GOP once and keep it":
scrubbing anywhere inside a decoded GOP is then a texture bind, in either
direction, and first touch of a GOP costs one forward pass (≈ 75–350 ms
for 250 frames). Byte-budgeted LRU exactly like `SequenceState` in
video.ts (a 1080p RGBA texture is 8 MB; keep `VideoFrame`s or a reduced
scrub resolution via `CanvasSink`'s `width` option to stretch the budget).
Keep `<video>` for playback, audio and export; the cache is a paused-path
read side. Chrome/Safari/Electron only (`track.canDecode()` gates it).

**R4 · Take media bumps off React (small, verify).** In the bump listener
call `renderFrameRef.current(clock.time, fps, false)` on the coalescing
rAF instead of `setPipelineBumpKey`, the way the clock store path does.
`pipelineBumpKey` has exactly one consumer (the eval effect), so the
change is contained; verify that nothing in the shell relied on that
re-render (node thumbnails, spreadsheet panel's follow-up read). Helps
webcam and audio meters too.

**R5 · `-g` on the transcode path (trivial).** F5.

**R6 · per-frame seek threshold (trivial).** F7.

R1 alone is the fix for "the picture freezes while I drag". R1 + R2 is the
fix for "make it much, much faster" on desktop. R3 is the cross-platform
version of R2 and the only route that also speeds up backward scrubbing on
long-GOP web sources.

## 4. What was checked and ruled out

- Fingerprinting the `file` param each eval is cheap: `stableStringify`
  sees no own enumerable props on the element ([evaluator.ts:242-272](../src/engine/evaluator.ts#L242-L272)).
- Scrub events are already frame-quantized and coalesced to one eval per
  rAF ([TrackEditor.tsx:2430-2452](../src/components/effects/TrackEditor.tsx#L2430-L2452),
  [EffectsApp.tsx:3112-3182](../src/components/effects/EffectsApp.tsx#L3112-L3182));
  there is no pointer-rate eval storm.
- `retimeable: false` / Time Offset boundary feeding is unrelated to scrub
  speed.
- The rvfc + `seeked` double bump is harmless: both collapse into one rAF.

## 5. Reproducing the numbers

```
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/bench-video-seek.cjs
```

Generates seven 10 s H.264 clips with ffmpeg-static into a temp dir (1080p
and 4K at GOP 250 / 30 / 1, plus a 1080p intra proxy from the 4K GOP-250
file), then for each clip measures `<video>` seek latency (+1 frame, −1
frame, random; `currentTime` write → `seeked`), what `currentTime` and
`readyState` report mid-seek, how many seeks land when retargeted every
16 ms, and mediabunny `VideoSampleSink` latency (pipelined forward,
independent backward, independent random). Prints one JSON line per clip
and kind. Needs a visible window (a backgrounded one records nothing —
same trap as TESTING.md §3).
