# Datamosh node (spec — draft)

Snapshot 2026-06-25. Backlog item #151. Owner: "I think this is a node where
you need to bake — maybe not! And you need 2 input layers with time. A node with
2 image sockets; in the params window a little custom UI (reuse the layers panel)
where you drag the two clips around so they overlap, and the overlap is what gets
moshed. Lots of control over the moshing, different algorithms, parameters."

## What datamosh is (the mechanism we're modeling)

Strip the codec lore and datamosh is one idea: **motion from one source applied
to the pixels of another (or to a frozen frame).** Two canonical looks:

- **Transition mosh / "I-frame removal"** — at a cut A→B, B's keyframe is
  dropped so B's *motion vectors* drive A's *last pixels*. A melts/smears along
  B's movement until B's real pixels bleed back in. **This is the two-clip
  overlap.**
- **Bloom / "P-frame duplication"** — motion vectors repeated on one clip with no
  refresh; the image blooms/pulses outward. Falls out for free from a single
  input.

## Decisions (settled with owner)

1. **Two mosh engines, both shipped** (`engine` enum):
   - **`flow`** — optical-flow advection. Estimate a motion field per frame on
     the GPU, advect an accumulation buffer (feedback warp). Real-time, every
     knob a param. Built **node-side** (pure GL).
   - **`codec`** — authentic bitstream datamosh via ffmpeg.wasm (strip I-frame at
     the mosh point, optionally dup P-frames, re-decode). Heavier, coarser
     control, the "real" glitch. Built **panel-side** (ffmpeg lives in `src/lib`,
     which nodes can't import — invariant #1).
2. **Bake the inputs into the node** (owned frame strips). An `image` socket only
   ever hands you the *current* frame, so a node-local drag-to-overlap timeline is
   impossible on live inputs. The panel frame-steps each input's upstream into
   PNG strips (the Segment/Depth pattern), and the node then owns the frames —
   making the mosh a deterministic function of (strips, params, local frame),
   scrub- and export-safe by construction.
3. **First milestone = two-clip transition** with the `flow` engine (fastest path
   to a working overlap mosh; no ffmpeg round-trip). Codec engine is M2.

## Architecture — one pipeline, two engines

```
input A upstream ──┐                              ┌─ flow engine (node-side GL)
                   ├─ bake (captureNodeFrames) ─► strips ─┤
input B upstream ──┘   PNG, session store              └─ codec engine (panel ffmpeg)
                                                          │
                              node-local timeline ───────►│  build → OUTPUT strip (cache)
                                  (drag/overlap)          │
                                                          ▼
                              compute() samples OUTPUT strip at local ctx.frame
```

Unified contract: **bake inputs → choose engine → produce a cached output strip →
`compute` is a pure cache reader.** Codec *must* bake (full offline op); flow
*could* run live but reuses the same cache so scrubbing/export stay deterministic.

### Session store (`globalThis`, mirrors depth-session.ts)

Holds, keyed by nodeId: `clipA`/`clipB` (baked input strips:
`Map<localFrame, Blob>` + in/out + version), `output` (moshed strip, same shape),
per-strip LRU decode caches, `status`, `version`. **Session-only — not
serialized** (like Depth/Segment bakes): params save, frames don't, so reopen →
re-bake. Location must satisfy invariant #1 (node imports it): put it
**engine-side** (`src/engine/datamosh-session.ts`), *not* `src/lib` — confirm how
`depth-session` avoids the export-bundle problem before copying its location.

### Serialized params (`node.data.params`, plain JSON)

- `timeline`: `{ aStart, aLen, bStart, bLen }` in node-frames — the custom-panel
  value; defines the overlap = intersection; output length = max end.
- `engine`: `"flow" | "codec"`.
- `motionFrom` / `pixelsFrom`: `"A" | "B" | "both"` (transition mosh = motion B,
  pixels start A).
- **flow:** `estimator` (`block | gradient | residual`), `blockSize`,
  `searchRadius`, `flowScale`, `smear` (advection iterations), `decay`,
  `refresh` (real-pixel bleed / I-frame leak), `directionBias` vec2, `colorBleed`.
- **codec:** `iframeRemoval` (count at mosh point), `pframeDup` (count), `gop`,
  `bitrate`.
- `outRange` / `fps` for the node-local timeline.

### `compute` (node-side, pure reader)

`stable: true`. At top, `recordScopedFrame(nodeId, ctx.frame)` (layer-clock
bridge). Map scoped `ctx.frame` → output-strip frame; if cached+decoded, upload &
return; else for `flow` build it on demand (replay accumulation from overlap start
with a memoized buffer in `ctx.state`), for `codec` return the last good frame /
empty until the panel build lands. `fingerprintExtras` →
`v{version}:f{frame}:{decoded?}` when output exists, else `v{version}:none`
(constant ⇒ caches as a still). `dispose` releases any `ctx.state` GL buffers.
Offline: `requestDecode(frame)` wrapped in `pushMediaSettle` for frame accuracy.

### Flow engine internals (M1)

Per output frame k across the overlap, in order:
1. `F_k` = estimate flow between motion-source frames k−1, k (`estimator`).
2. advect accumulation by `F_k * flowScale`, `smear` iterations, apply `decay`.
3. bleed in real pixels of the pixel source by `refresh`.
4. store accumulation → `output[k]`. Seed accumulation at overlap start with the
   frozen last frame of A.

Reuses: the uv-offset warp from [effect/displace.ts](../src/nodes/effect/displace.ts#L27)
(sample `u_src` at `v_uv + flow*scale`); the persistent ping-pong buffer pattern
from [effect/trails.ts](../src/nodes/effect/trails.ts) and the particle simulator
(alloc in compute, never release to pool, tear down in `dispose`). **No optical
flow exists in the repo** — the estimators are new GL (block-match is the
codec-authentic look; gradient is smooth; residual is the cheap glitch).

### Codec engine internals (M2)

Panel-driven: assemble positioned strips → encode to a known-GOP stream via the
[export-ffmpeg.ts](../src/lib/export-ffmpeg.ts) `getFfmpeg` singleton → bitstream
surgery (drop I-frame at overlap start; optional P-frame dup) → re-decode →
write `output` strip. **Open risk:** reliable I-frame removal in ffmpeg.wasm
(classic recipe is AVI-container index/keyframe-chunk removal; the `noise` bsf
does *not* remove keyframes). Spike this before committing the M2 estimate.

## Custom panel (`DatamoshPanel`, dispatched in ParamPanel by `defType`)

Slots in at [ParamPanel.tsx:434+](../src/components/effects/ParamPanel.tsx#L434)
alongside `autolayout`/`rgb-curves`/`depth-anything`, `key={selected.id}`.
Contents:
- **Bake A / Bake B** buttons: resolve the upstream node feeding each input
  handle, `captureNodeFrames(upstreamId, frames, onFrame)` → write strip via
  `addBakeFrame`/`commitBake`; progress + status; lock edits while baking.
- **Mini-timeline**: two draggable strips on a horizontal tick axis with the
  overlap region highlighted. Lift `tickToPx`/`pxToTick` + clip-bar JSX + in/out
  grips + snapshot-baseline drag from
  [TrackEditor.tsx](../src/components/effects/TrackEditor.tsx#L486) (not a reusable
  component — copy ~80 lines, self-contained). Writes `timeline` via the normal
  `onChange` path ⇒ undo + autokey for free.
- **Engine selector + engine params** (segmented pill for `engine`; std ParamDefs
  below, `visibleIf` on engine). **Mosh** build button + progress.

## Status — M1 shipped (2026-06-26)

Two-clip flow transition is implemented end to end. Files:

- [engine/datamosh-session.ts](../src/engine/datamosh-session.ts) — `globalThis`
  session store generalized to three strips (clipA / clipB / output): PNG frame
  maps, per-strip decode LRU, shared bake lifecycle (`beginStripBake` /
  `addStripFrame` / `commitStripBake` / `freeStrip` / `freeOutput`), the
  `recordScopedFrame` / `getScopedFrame` clock bridge, and a 768 MB global
  ceiling. Freeing an input cascades to free the (now-stale) output.
- [nodes/effect/datamosh.ts](../src/nodes/effect/datamosh.ts) — the node. Two
  `image` inputs (clip A / clip B). Flow shaders: gradient (brightness-constancy
  normal flow) and residual estimators feeding a multi-tap backward-warp smear
  (`MOSH_STEP_FS`). Three compute modes: baked-output playback (depth-style LRU
  + `pushMediaSettle`), live overlap advection (forward-accumulating in
  `ctx.state`, reseed-on-discontinuity), and pre/post-overlap single-clip
  passthrough. `fingerprintExtras` keys per frame + decode-readiness so the
  offline settle dance re-runs and advances the accumulation.
- [components/effects/DatamoshPanel.tsx](../src/components/effects/DatamoshPanel.tsx)
  — Bake Clip A / B (frame-steps each input's upstream), the draggable
  overlap mini-timeline (move + right-edge length trim, overlap highlighted),
  engine pill (codec disabled), flow param sliders, and the Mosh build (frame-
  steps the node itself → output strip) / Free Mosh.
- Registered in [nodes/index.ts](../src/nodes/index.ts); panel dispatched in
  [ParamPanel.tsx](../src/components/effects/ParamPanel.tsx) on
  `defType === "datamosh"`.

## Status — M2 + M3 shipped (2026-06-26)

Full buildout landed on top of M1. Added/changed:

- [lib/datamosh-codec.ts](../src/lib/datamosh-codec.ts) — **codec engine**. The
  authentic bitstream route: ffmpeg.wasm encodes the assembled A→B sequence to
  MPEG-4-ASP-in-AVI (keyframes forced only at frame 0 + the cut, `-bf 0
  -sc_threshold 0 -g 1000000`), then pure byte surgery on the RIFF — parse `movi`
  chunks, classify I/P from `idx1` (VOP-type fallback), drop interior I-frames,
  optionally duplicate post-cut P-frames (bloom), rebuild movi + idx1 + frame
  counts (`avih.dwTotalFrames`, vids `strh.dwLength`), re-decode to PNG frames.
  Lives in `src/lib` because ffmpeg can't be imported engine-side (invariant #1);
  the node never touches it — the panel runs it and writes the result into the
  output strip, which plays back like any baked strip. Throws a clear message on
  failure → user falls back to Flow.
- [nodes/effect/datamosh.ts](../src/nodes/effect/datamosh.ts) — added the
  **block-match** estimator (3×3 SAD local search, stepped, `searchRadius` 1–8) as
  `u_estimator==2`; **source-in trim** (`sourceInA/B`) folded into the strip
  index math (`aFrame`/`bFrame`, used by compute + fingerprint); codec params
  (`iframeRemoval`, `pframeDup`) declared + serialized. compute is unchanged for
  codec (it just plays the baked output strip).
- [components/effects/DatamoshPanel.tsx](../src/components/effects/DatamoshPanel.tsx)
  — codec pill enabled; engine-gated controls (flow: algorithm + block search +
  scale/smear/decay/refresh; codec: remove-I-frames + P-frame-dup); `Mosh`
  branches flow (frame-step the node) vs codec (assemble strips → `buildCodecMosh`
  → output strip); timeline bars gained **left-edge in-point trim** grips
  alongside move + right-edge length.
- Docs auto-generate from the registry — the node's description drives its page;
  no manual manifest entry.

`tsc --noEmit` clean (1 pre-existing unrelated error in depth-anything.ts).
**Still not verified in-browser** (no test runner). The codec path carries the
most risk — see below.

## Milestones — all complete

- **M1 — flow transition (two-clip):** ✅ session store, bake-inputs, mini-timeline,
  gradient/residual estimators + advection, output bake, offline settle.
- **M2 — codec engine:** ✅ ffmpeg AVI encode + I-frame-removal/P-frame-dup
  surgery + re-decode, panel-driven into the shared output strip, engine switch.
- **M3 — palette + polish:** ✅ block-match estimator, source-in trim, full param
  set, status frame counts. Single-input "bloom" mode NOT added (the codec
  P-frame-dup + flow refresh=0/high-smear both bloom; a dedicated one-input mode
  was judged redundant for now).

## Back-compat / invariants

- New `type: "datamosh"`, image sockets only — **no SocketType change** (invariant
  #7 untouched). Register in index.ts; never repurpose the type later.
- Strips/output session-only, not serialized → reload re-bakes (invariant #2:
  only plain-JSON params persist).
- **Invariant #1 is the load-bearing constraint:** node imports only the
  engine-side session store; *all* ffmpeg/`src/lib` work stays in the panel.
  Verify the depth-session import precedent before mirroring it.
- Texture discipline (invariant #3): accumulation buffers live in `ctx.state`,
  released only in `dispose`; intermediates released each compute.

## Resolved decisions

1. Session store lives **engine-side** (`src/engine/datamosh-session.ts`) — holds
   only plain data, so the node imports it without tripping invariant #1.
2. Memory ceiling: 768 MB global across all datamosh strips; decode LRU 32/strip.
3. Flow build is an **explicit Mosh pass** (frame-steps the node); live advection
   is the preview. Codec must bake (offline op).

## Risks / verify in-browser first

1. **Codec engine is unverified and the highest-risk piece.** Assumptions that
   need a real run: (a) `@ffmpeg/core` 0.12.10 ships the `mpeg4` encoder; (b) the
   AVI `idx1` offset base (we use ffmpeg's "4 from movi data" convention) decodes
   back cleanly; (c) the rebuilt index/frame-counts satisfy ffmpeg's demuxer. If
   any fail, the user sees an error and the Flow engine still works. Likely first
   fix-up area.
2. Block-match is heavy (~81 candidates × 3×3 SAD per pixel) — fine for a
   deliberate Mosh bake, may be sluggish as live preview at high res. Gradient is
   the fast default.
3. Codec output frame count ≠ timeline length (I-frame removal drops one, dup
   adds) — playback maps output 1:1 over scene frames and holds at the end;
   acceptable, surfaced as "Moshed · Nf".
4. Output scoped-frame keying trusts `ctx.frame` (correct at root; layer-offset
   mirrors depth precedent, untested).
