# Video Source — scrub optimizations round 2 (2026-09-05)

Status: **shipped** 2026-09-06, all seven milestones (verification in §Results). Follows
[090426_video-frame-cache.md](090426_video-frame-cache.md) (the draw-frame
stamp + WebCodecs frame cache) and the audit in
[090426_video-scrub-audit.md](090426_video-scrub-audit.md). Owner asked for
all seven ideas from the follow-up review; no separate design Q&A.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M5 | One frame store per FILE, shared by every node reading it (fixes duplicate textures and the two-iterators-on-one-sink risk) | shipped |
| M1 | Sliding forward window: a forward drag is one continuous decode, no keyframe restart per second of timeline | shipped |
| M2 | GOP-sized windows when a whole GOP fits in half the budget (typical camera footage → fully bidirectional after one pass) | shipped |
| M3 | Park the element after the playhead rests (instant play-after-scrub) + serve playback from the cache while the element's hard seek is in flight | shipped |
| M7 | Image-sequence decode-ahead in the drag direction, all decoded frames uploaded promptly | shipped |
| M6 | Media bumps off React: the bump re-evaluates directly on the next animation frame; the shell re-renders on a 250 ms trailing timer for UI that reads async results | shipped (typecheck + reasoning only — not exercised in the UI this session) |
| M4 | Desktop decoder proxy: ffmpeg-static writes a 1080p all-intra proxy that only the WebCodecs decode source reads (element, audio, export keep the original) | shipped (verified through the real preload + IPC in the harness) |

## Design

### M5 — per-file store (`src/engine/video-frame-store.ts`)

The cache, the decode job, the scratch canvas and the GL reference move
out of `VideoState` into a `FrameStore` keyed by `VideoFileParamValue`
(WeakMap). Nodes `acquire(file, gl, nodeId)` / `release(file, nodeId)`;
when the last user releases, the store drops its textures (the decode
source stays with the param value until `disposeVideoFile`). A backend
recreation (resolution change) hands the store a different `gl`; it
clears — the textures died with the old context. One job chain per store
means one iterator per decode sink, which is the concurrency mediabunny's
`VideoSampleSink` is known to be safe for. Also moved
`video-decode-source.ts` from lib/ into engine/ — invariant #1 (nothing
under nodes/ imports lib/).

### M1 — sliding forward window

Jobs iterate `samples(start, ∞)` and stop at a live `limit`. A forward
target that is ahead of the job's cursor by ≤ `MAX_FOLLOW` (2 s) is
accepted: the job's target moves and the limit slides to
`target + WINDOW_FAR`. Only a jump further than that, a backward target,
or a target the job has already passed restarts the job (keyframe cost).
Backward jobs keep a fixed limit (`target + WINDOW_NEAR`). Pure:
`jobAccepts()` / `slideLimit()` in video-frame-cache.ts.

The part that made it work: the decoder is ~50× faster than any drag, so
a forward job reaches its limit long before the pointer does. It must not
FINISH there — the first version did, and a 4 s drag cost 17 restarts.
Now a forward job **idles at its limit with the iterator open**, holding
the next frame (`idleUntilSlid`); a slid limit resumes it in place, and
`JOB_IDLE_MS` (1.5 s) without a new target closes it to free the
decoder. After the change the same drag started 0 jobs.

### M2 — GOP-sized windows

Before a job starts, `source.gopAround(target)` (mediabunny
`EncodedPacketSink.getKeyPacket` / `getNextKeyPacket`) gives the GOP span;
`widenToGop()` extends the window to the whole GOP when
`frames × bytesPerFrame ≤ budget/2`. Decoding from the keyframe is paid
anyway; the GOP rule only adds uploads and memory, and it is what makes
every frame of a 1–2 s GOP a hit in both directions after one pass.

### M3 — park + playback catch-up

`DrawProbe.restingMs` (time since the node's target last changed) and
`DrawPlan.park`: when the plan is not already chasing and the element is
not at the target, `park` turns on after `PARK_AFTER_MS` (300 ms) and
compute issues the usual coalesced seek — the element is then already at
the resting playhead when play is pressed, and 4K proxies refine at rest
without racing the cache during the drag. `planPlayingDraw()`: while
playing, if the element is seeking or its texture is more than 0.3 s from
the target (a hard seek in flight), a cached frame at the target is drawn
instead of the stale element texture; during steady playback the element
always wins (no source flipping, no proxy resolution flips). Stamped like
the paused plan. No decode jobs are kicked during playback.

### M7 — sequence decode-ahead

`planSeqWindow()` lists timeline frames to decode around the playhead,
direction-aware (24 ahead / 4 behind, mirrored for backward drags,
loop-aware). Compute now uploads EVERY decoded-pending frame each eval, not
just the target, so the pending cap stops throttling the window; ahead
decodes are limited by in-flight count. EXR sequences keep a small window
(decode is seconds per 4K frame) gated by `exrDecodeBacklog()`.

### M6 — media bumps off React

The `pipeline-bump` listener in EffectsApp schedules
`renderFrameRef.current(clock.time, fps, false)` on one coalescing rAF —
the same imperative path the clock store already uses — unless playback is
active (the playback loop renders every frame anyway). A trailing 250 ms
timer still bumps `pipelineBumpKey` so UI that reads async results after a
bump (model-cache's `peekModelObjects`, panels) refreshes, but at most four
times a second instead of once per landed frame; the eval effect no longer
depends on that key (it would double-evaluate).

### M4 — desktop decoder proxy

Eligibility (engine-side, after the source is ready): source long side
> 1920, or estimated GOP > 2 s (first two key packets). The engine asks a
`ScrubProxyProvider` registered by lib/video.ts (native platform only) for
a handle `{ size, read(start,end), dispose }`; the provider sends the
file's bytes to the main process, which writes the input to a temp file,
runs `ffmpeg -vf scale=min(1920,iw):-2 -c:v libx264 -preset veryfast
-crf 23 -g 1 -fps_mode passthrough -an` (ffmpeg's autorotate bakes phone
rotation in), keeps the output in tmp and serves byte ranges over IPC
(`toolbox:scrubProxyRead`). The engine reads it through mediabunny's
`StreamSource` (fileSystem prefetch profile), swaps the sink, marks the
source `proxy` so every cached frame is `exact:false` (a re-encode is
never pixel-exact — the element refines at rest via M3's park), and bumps.
The original stays the element's and export's source; the proxy is a
disposable cache file unlinked on dispose and on quit. Skipped for cloud
URLs and files over 2 GB.

## Results (2026-09-06)

Live Electron harness, real node def + real backend (640×360), synthetic
30 fps clips, forward drag = 121 single-frame evals at 12 ms:

| clip | forward drag | GOP window | park | catch-up | shared store | proxy |
|---|---|---|---|---|---|---|
| 1080p GOP 30 | 115/121 hits, **0 jobs started** | GOP [8,9): 30/30 resident, backward 30/30, 0 jobs | element 0 → 4.5 after rest | `vf:c:` while seeking, `vf:e:` steady | 2nd node hits on its first eval | n/a (not eligible) |
| 1080p GOP 250 + proxy | 114/121, 0 jobs | 1-frame GOPs (intra proxy) | rest → element at target, stamp flips `vf:c:`→`vf:e:` (proxy refined) | same | same | built in background; frames 1920×1080 `exact:false`; vs element mean 0.16 / max 15 |
| 4K GOP 250 + proxy | 114/121, 0 jobs | same | same | same | same | proxy 10 MB; frames 1920×1080; vs element mean 0.43 / max 32 |

Image sequence (90 PNG stills, M7): forward window fills 13–36 via the
bump→eval loop; backward drag 36→5 at 12 ms/eval: 32/32 exact stamps;
loop wrap decodes 0–5 past 89; pending and decoding drain to 0.

Gates: typecheck, `npm run check` (the frame-cache script now covers
jobAccepts/slideLimit, widenToGop, park timing, planPlayingDraw,
planSeqWindow — one real planner bug caught: backward sequence windows
got the short side), eslint clean on every touched file, lint ratchet
above baseline only in pre-existing owner WIP files, export-template
build green.

Not exercised: the editor UI itself (M6 in particular — bridge down), a
real phone clip through the proxy (ffmpeg autorotate is relied on), cloud
sources, and Firefox.

## Verification plan

- `scripts/check-video-frame-cache.mts`: jobAccepts/slideLimit,
  widenToGop, park timing, planPlayingDraw table, planSeqWindow order and
  wrap.
- Live Electron harness (as in 090426 §5, adapted to the store): forward
  drag over 5 s counts job restarts (M1: 1), the GOP-30 clip is fully
  bidirectional after one miss (M2), after 300 ms rest the element sits at
  the target (M3), a playing eval with the element seeking stamps `vf:c:`
  (M3), a second node on the same file hits immediately (M5), a proxy
  swapped in via a harness provider yields `exact:false` frames whose
  pixels are close to the element's (M4).
- Gates: typecheck, check, lint on touched files, export-template build.
