# Video Source — draw-frame fingerprint + WebCodecs frame cache (2026-09-04)

Status: **shipped** same day, both parts, from the audit in
[090426_video-scrub-audit.md](090426_video-scrub-audit.md) (R1 + R3 there).
No design Q&A round — the audit's measurements decided the shape. Verified
offline by `scripts/check-video-frame-cache.mts` (in the `npm run check`
chain) and live in an Electron harness driving the real node against a real
WebGL2 backend (§5). Not yet exercised in the editor UI itself — the MCP
bridge was down; the live harness is the substitute.

## 1. What changed, in one paragraph each

**R1 — upload before you seek, and stamp the drawn frame.**
[video.ts](../src/nodes/source/video.ts) now runs the element texture upload
*before* the sync block can write `currentTime` (a currentTime write drops
`readyState` synchronously, so the old order discarded every frame that
landed while the pointer was still moving — the picture froze until the
drag stopped). `fingerprintExtras` no longer stamps `currentTime` (which
reports the *pending* seek target while seeking, so "still seeking to T"
and "landed at T, uploading" were fingerprint-identical and downstream
caches kept the stale composite). It stamps the frame the eval will draw.
The image-sequence kind had the same latent bug (a decode landing at an
unchanged scene time) and gets the same treatment: `sq:<frames[] index>`.

**R3 — a WebCodecs frame cache on the paused path.** When the scene is
paused (or a layer pre-rolls), a sync'd Video Source now fills a window of
decoded frames around the playhead through mediabunny + WebCodecs and draws
from that cache. Frames inside a cached window are a texture bind in either
direction; a miss costs one forward decode pass from the preceding
keyframe. The `<video>` element keeps playback, audio and offline export
exactly as before, and every failure mode (no WebCodecs, an undecodable
codec, a container mediabunny can't parse, an insecure context) degrades to
the R1 behavior without a visible seam.

## 2. Files

- `src/engine/video-frame-cache.ts` — pure, GL-free: `FrameCache<P>`
  (byte-budgeted LRU keyed by media timestamp, `lookup(t)` = frame covering
  t, `nearest(t, max)`), `planWindow()` (the decode window leans in the
  drag direction), `planPausedDraw()` (the per-eval decision) and
  `drawPlanStamp()` (its fingerprint segment). Constants:
  `VIDEO_CACHE_BYTES` 512 MB per node (parity with the image-sequence
  cache), `VIDEO_CACHE_MAX_DIM` 1920, `WINDOW_NEAR` 0.25 s / `WINDOW_FAR`
  1.0 s, `NEAREST_MAX` 0.5 s, `ELEMENT_EPS` 1/240 s.
- `src/engine/video-decode-source.ts` (moved from lib/ on 2026-09-06 —
  invariant #1) — the mediabunny wrapper, one per
  `VideoFileParamValue` (WeakMap): dynamic `import("mediabunny")`,
  `BlobSource` for ObjectURLs (fetching a `blob:` URL is a no-copy Blob over
  the picked bytes), `UrlSource` for cloud clips, `canDecode()` gate,
  timestamps re-origined by `getFirstTimestamp()` so cache time 0 = the
  element's `currentTime` 0. `ensureVideoDecodeSource` kicks init and bumps
  the pipeline when ready; `disposeVideoDecodeSource` is called from
  `disposeVideoFile` (lib/video.ts) because the source belongs to the param
  value, not the node.
- `src/nodes/source/video.ts` — `VideoState` gains the cache, the decode
  job, and `lastUploadedTime`; `elementTarget()` / `onPausedPath()` /
  `probeDraw()` are shared by compute and `fingerprintExtras` so the stamp
  predicts the draw; `kickDecodeWindow()` + `runDecodeJob()` +
  `uploadSample()` are the background half.
- `scripts/check-video-frame-cache.mts` — offline guard (§5).

## 3. How an eval goes now (paused, sync on, realtime)

1. **Upload first.** If the element is not seeking and has data, and its
   `currentTime` differs from the last upload, upload it and record
   `lastUploadedTime`. (Paused, the same frame is no longer re-uploaded on
   every cursor move.)
2. **Probe.** `probeDraw()` reads: the media target for `ctx.time`; the time
   the element texture holds *after* step 1 (this is what makes a probe
   taken before compute — the fingerprint — agree with one taken inside it);
   whether the decoder is ready for this param value; whether cached frames
   are exact (source long side ≤ 1920) or proxies; the cache `hit` and
   `nearest`.
3. **Plan** (`planPausedDraw`, checked table in the script):
   - exact hit → draw it; the element is left parked.
   - proxy hit → draw it and *chase*: issue the coalesced element seek so
     the picture refines to full resolution when the playhead rests. Once
     the element is at the target it wins.
   - element already at the target, no hit → draw the element, kick a
     window so the next step is a bind.
   - miss with a cached neighbour within 0.5 s → draw the neighbour (a fast
     drag shows motion, not a frozen frame), kick a window.
   - cold miss → draw the element's last texture (or nothing), kick a
     window; chase only when the cache can never be exact.
   - no decoder → the R1 behavior: element + coalesced chase.
4. **Sync block.** Uses the plan's `chase`/`kick` in the paused branch;
   the playing, hard-seek and free-running branches are untouched.
5. **Draw.** Binds the plan's texture (cache entry or element) through the
   unchanged fit shader; the cache entry's own w/h feed the fit math (same
   aspect either way). The drawn cache ts is eviction-protected.

The decode job: `samples(start, end)` in presentation order; mediabunny
decodes from the keyframe and discards what precedes `start`, so uploads
are paid only for the window. Each sample goes to an RGBA8 texture straight
from the `VideoFrame` (GPU-backed NV12, ~0.5 ms at 1080p, 1.4 ms at 4K);
rotated (phone) or oversized sources go through an `OffscreenCanvas`
`sample.draw()` which applies rotation metadata and the downscale in one
step. A running job whose window still contains a new target and hasn't
passed it is left alone; otherwise it is cancelled and replaced, chained so
only one iterator drives the decoder. The job bumps the pipeline when the
target's frame lands, then at most every 120 ms, then once at the end.
Playback, offline export and dispose cancel it.

## 4. Decisions and their reasons

- **Window, not GOP.** Decoding "the GOP containing T" would upload up to
  250 frames per miss; a 0.25 s / 1.0 s window leaning in the drag
  direction uploads ≤ 38 frames (300 MB at 1080p) and mediabunny's iterator
  already does the keyframe walk. Backward drags get the long side behind
  them because each new window restarts at a keyframe.
- **RGBA8 textures, capped at 1920.** Holding `VideoFrame`s would stall the
  decoder's frame pool; a 4K RGBA8 frame is 33 MB (15 per budget), at 1920
  it is 8.3 MB (61). Sources ≤ 1920 are stored exact; larger ones are scrub
  proxies and the element refines them at rest — measured proxy path on the
  4K clip: draws from cache while moving, `vf:e:` once the element lands.
- **The stamp is a decision, not a clock.** Downstream caches must see a
  change exactly when the drawn frame changes. `drawPlanStamp` encodes
  source + timestamp (`vf:c:2.0000` / `vf:e:2.0000` / `vf:-`), the same
  frame from a different probe yields the same stamp (checked).
- **Element stays parked for exact-capable sources.** No element seeks
  while paused when the cache can be exact — one decoder pipeline per
  scrub, and the element's pipeline is idle until play. Pressing play after
  a scrub pays one hard seek, as any jump already did.
- **Secure context required.** `VideoDecoder` exists only in secure
  contexts (https, localhost, Electron `file://`); a `data:` page has none
  and the cache silently stays off (this is how the first harness run
  failed). The editor, the live viewer and exported apps all qualify.
- **Per-node budget, not global.** Parity with the sequence cache; two 4K
  nodes can hold 1 GB of textures. Revisit if a project pattern needs it.
- **Exported apps grow.** `src/export-template` now bundles mediabunny
  (dynamic import; the single-file build inlines it). Confirmed the
  template resolves it from the repo root's node_modules (§5).

## 5. Verification

Offline: `npm run check:video-frame-cache` (also in `npm run check`) —
lookup/nearest, budget + protected eviction + replacement accounting,
window direction/clamping, the full draw-plan table, stamp distinctness and
stability. `npm run typecheck`, `npm run check`, `npm run lint:ratchet`
green on 2026-09-04.

Live (Electron 42, real backend at 640×360, synthetic 30 fps clips from
`scripts/bench-video-seek.cjs`, 10 s each):

| clip | decoder ready | cold miss → first hit | forward scrub 27 evals | backward scrub 52 evals | cache vs element pixels |
|---|---:|---:|---:|---:|---:|
| 1080p H.264 GOP 250 | 25 ms | 157 ms | 27/27 hits, 1.1 ms/eval | 3 not exact (window restart) | max abs diff 0 |
| same, rotate=90 metadata | 22 ms | 78 ms | 27/27, 1.1 ms | 2 not exact | max abs diff 0, stored 1080×1920 |
| 4K H.264 GOP 250 (proxy path) | 53 ms | 327 ms | 26/27, 1.4 ms | 11 not exact | element wins at rest (`vf:e:`) |

Also checked live: the stamp changes when a frame lands at unchanged scene
time and is stable otherwise; an offline eval cancels the job and stamps
`vt:`; a playing eval stamps `vt:`; `dispose` drops state and the source.
Per-eval cost includes a 64×36 readback, so the 1.1 ms is an upper bound.

Not verified this session: the editor UI end to end (bridge down), cloud
`UrlSource` clips over range requests, Firefox (no WebCodecs `canDecode`
for many codecs → falls back to R1), and a 120 fps timeline (F7 in the
audit still applies to the element chase; the cache path is unaffected).

## 6. Follow-ups — all shipped 2026-09-06, see 090526_video-scrub-optimizations.md

- R4 from the audit: take media bumps off React so a landed frame costs
  one rAF, not a shell render — the decode job now lands frames at
  ~2000 fps and the shell render is the remaining per-frame overhead.
- R5: `-g` on the Electron transcode-for-playback path.
- Window continuation: when a forward job completes and the pointer is
  near `end`, chain the next window so a long forward drag doesn't pay a
  keyframe restart every second of timeline.
- A global (cross-node) texture budget if projects with several 4K
  sources appear.
