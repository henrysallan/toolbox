# Playback clock store — getting `time` out of React state

Design doc for the last (structural) piece of riskfix-plan 070826 §4 /
area 4. Everything cheaper has already landed (07-10): memo(EffectNode),
memo(NodeEditor) + stable ReactFlow handler shells, memo(ParamPanel),
memoized `projectTimeline` / `queueRenderInfo`, `currentTickRef` for the
param/animation handlers, and the edge-pruning identity guard. What
remains is the root cause.

## The problem

`time` is a `useState` advanced inside a rAF loop (EffectsApp ~:1560).
Every playback frame therefore re-renders the entire ~9.9k-line
EffectsShell, and every component that receives `time` / `currentTick` /
`playing` as a prop re-renders with it — 60×/s:

- ParamPanel (`currentTick` — keyframe diamonds + input readouts)
- TrackEditor (`currentTick` — playhead + diamond states)
- GraphEditor (`currentTick` — playhead)
- LayersEditor (`currentTick` — playhead over the layer bars)
- PlaybackBar (`time`, `playing` — transport readout)
- MotionPathOverlay + canvas gizmos (`currentTick` — path playhead dot)

The memo pass keeps everything that does NOT receive the clock out of
those frames (NodeEditor/xyflow, modals, dock chrome). But the six
consumers above re-render fully per frame even though most of them only
need to move a playhead line or restyle a diamond. TrackEditor maps its
full lane list twice per render; ParamPanel rebuilds its rows pipeline.

The rAF loop itself (renderFrame → evaluateGraph → blit) does NOT need
React at all — it already reads `nodesRef/edgesRef/timeRef` and draws
into canvases. React is only in the loop because `setTime` is how the
clock advances.

## Design

One module-level subscription store, engine-adjacent but UI-owned
(`src/state/playback-clock.ts`):

```ts
export interface ClockState {
  time: number;      // seconds — source of truth (rAF advances it)
  tick: number;      // derived integer tick (fps × tpf), exact-equality safe
  frame: number;     // derived integer frame
  playing: boolean;
}
// get(): ClockState (stable object identity per commit of values)
// set(partial): void — setTime/seek/play/pause all route through here
// subscribe(cb): () => void
// useClock(selector, isEqual?): React hook via useSyncExternalStore
```

- **The rAF driver moves out of React.** A plain module/hook owns the
  loop: advance `clock.time`, call `renderFrameRef.current(...)`
  imperatively, wrap at `loopFrames/fps` (today's logic verbatim). No
  setState in the hot path.
- **Consumers subscribe to what they need.**
  `useClock(s => s.tick)` re-renders only that component, only when the
  selected value changes. PlaybackBar selects `{time, playing}`;
  TrackEditor/GraphEditor/LayersEditor select `tick` — and each should
  take the next step of subscribing INSIDE a small playhead child
  (`<Playhead/>`, `<DiamondState/>`) so the lane lists stop re-rendering
  per frame entirely. ParamPanel: only KeyframeDiamond / KeyframeCaret
  and the animated-value readouts consume the tick — subscribe there,
  drop the `currentTick` prop.
- **Writers stay unchanged in shape.** `onSeek`, transport buttons, the
  timeline scrub, `setPlaying` all become `clock.set(...)` calls. The
  existing `timeRef/playingRef/fpsRef` mirrors become reads of
  `clock.get()` (or are deleted where the store replaces them).
- **Eval scheduling.** Today: playing → rAF re-eval; paused → the eval
  effect re-runs on state change (structFp, params, cursorTick…). That
  split stays: the paused path keeps its React effect (it's driven by
  graph edits, which ARE React state); the playing path is fully
  imperative. `pipeline-bump` keeps dispatching a one-shot render either
  way.
- **Autokey** already reads `currentTickRef` — that ref becomes
  `clock.get().tick` behind the same name, or the handlers read the
  store directly. No behavior change.
- **Exports are unaffected**: the offline drivers already step time
  explicitly via `renderFrameRef.current(t, fps, true)` — they bypass
  the clock entirely, same as today. Only the interactive loop changes.
- **editor-session stash / project load**: stash `clock.get().time` on
  unmount, `clock.set({time})` on rehydrate — mechanical swap.

## What must not change (invariants)

1. Integer-tick keyframe model: `tick = round(time × fps × tpf)` derived
   in ONE place (the store), consumers never re-derive.
2. Loop wrap semantics (`loopFrames/fps`, wrap → sim zones re-seed on
   near-zero time — simulation-start's `shouldReset` watches for the
   wrap; verify a looped sim still re-seeds).
3. Param precedence + autokey tick source (wire > keyframe > constant;
   keys land at the tick visible when the edit happened).
4. Offline export determinism (explicit-time path untouched).
5. The eval effect's dependency list keeps working for paused
   interactions — nothing that currently triggers a paused re-eval may
   stop triggering one when `time` leaves React state. Audit its deps:
   `time` is in them today; the store's one-shot "render now" call
   replaces that edge.

## Migration plan (each step ships alone, manual smoke after each)

1. ✅ **Store.** (07-10) `src/state/playback-clock.ts` — state +
   `set`/`configure`/`subscribe` + `useClock` (useSyncExternalStore,
   primitive selectors only). PlaybackBar detached as the plumbing
   proof: it reads time/playing via `useClock`, props deleted.
2. ✅ **Flip authority.** (07-10, merged with step 1 — shadow mode was
   skipped: the shim writers made it unnecessary.) `useState(time)` /
   `useState(playing)` are GONE from EffectsApp; the shell reads via
   `useClock` (preserving today's re-render-per-frame behavior until
   step 3) and `setTime`/`setPlaying` became store-writing shims with
   the same value-or-updater signature, so all ~30 call sites (rAF
   advancer, transport, seeks, export save/restore) stayed verbatim.
   The store owns the tick derivation; EffectsApp pushes fps via
   `configure`. A mount effect resets to t=0/paused (the old
   useState-default behavior across docs round-trips). DEVIATION from
   the original plan: renderFrame stays eval-effect-driven — the
   imperative driver call lands with the SHELL detach (end of step 3),
   otherwise the effect + driver would double-eval each frame.
3. **Consumer-by-consumer detach** — ✅ props detached 07-10:
   TrackEditor (also dropped its dead `playing` prop), GraphEditor,
   LayersEditor, ParamPanel, MotionPathOverlay (×2 call sites) all read
   the tick via `useClock(s => s.tick)` internally; every
   `currentTick`/`playing` clock prop deleted from EffectsApp's JSX.
   Each still re-renders per frame BY DESIGN (playheads/diamonds/path
   dot); the follow-up leaf-subscription pass (per-lane `<Playhead/>`
   children, per-diamond subscriptions) is optional polish.
   ✅ SHELL DETACH landed 07-11 — EffectsApp no longer subscribes to the
   clock at all (`useClock` gone from the shell):
   - The four gizmo-derivation blocks moved to `GizmoTickOverlays.tsx`
     (TransformGizmoAtTick, PrimitiveGizmoAtTick, GradientOverlayAtTick,
     SplineEditorOverlayAtTick) — each subscribes to the tick itself and
     owns its keyframe-at-playhead derivation; the shell passes tick-free
     props (node, canvas, callbacks, evalCacheRef, spline-mode
     boundsSourceId).
   - Eval scheduling split in two: a STATE-driven effect (deps structFp,
     backendReady, fps, pipelineBumpKey, cursorTick, scrubbing,
     selectedId — reads time/playing via `playbackClock.get()`) and the
     imperative CLOCK driver: one effect owns a rAF loop while
     `playing && !scrubbing` (advance store clock with the old wrap logic
     verbatim, call `renderFrameRef.current(next, fps, true)`), plus a
     store subscription that schedules ONE coalesced rAF render (hint
     false) for any paused/scrubbing time-or-playing change — seeks,
     scrubs, pause itself, export restores. The subscription also keeps
     `playbackActiveRef` (cursor-bump gate) in sync, replacing its
     [playing, scrubbing] effect. Every old eval-effect dep was
     re-audited; export `finally` blocks already clear
     `offlineRenderingRef` BEFORE restoring time/playing, so the one-shot
     drives the restored render (it re-checks the flag at fire time).
   - The selectedPoints (PointsOverlay) capture moved from its
     [time]-dep effect into the tail of renderFrame (skipped for offline
     export frames), keeping the same cadence on every trigger path.
   - `currentTick`/`currentTickRef` deleted; autokey reads
     `playbackClock.get().tick` at edit time. `timeRef`/`playingRef`
     became store-SUBSCRIPTION-synced mirrors (still needed as refs by
     the export drivers + MCP handlers, but no longer render-synced).
     MCP `get_status` frame/playing became live getters into the store.
   - Detach casualty handled: the live-capture (MediaRecorder) progress
     readout relied on per-frame shell re-renders for its wall-clock
     fraction — a 200ms interval pulse while `recording?.mode === "live"`
     keeps it moving.
   Verified: typecheck clean, 6/6 checks green, lint errors identical to
   baseline (2 pre-existing), warnings 15 vs 16. Deliberate deltas, all
   invisible-or-better: scrub renders coalesce to one per display frame;
   the first playing-hint render after Play lands on the next rAF
   (~16ms) instead of synchronously.
4. **Cleanup:** `timeRef/playingRef` survived the detach as
   subscription-synced mirrors (the export drivers + MCP handlers consume
   them as MutableRefObjects) — the remaining cleanup is teaching those
   consumers to read `playbackClock.get()` directly, then deleting the
   mirrors. The render-synced ref writes are already gone. (07-12: CI
   lint now gates through the ratchet — scripts/lint-ratchet.mts vs
   scripts/lint-baseline.json — so it's already blocking for NEW errors;
   as ref-mirror fixes land, tighten with
   `npm run lint:ratchet -- --update`, and at zero swap in plain
   `npm run lint`.)

Step 3's shell detach was the highest-blast-radius commit; it shipped
alone (07-11) so it stays revertable.

## Smoke script (after steps 2 and 4 — and re-run after the 07-11 shell detach)

Play/pause/seek/scrub; loop wrap with a Simulation Zone (re-seeds);
autokey while playing and while paused (key lands at the visible tick);
graph edit while paused re-renders once; export all three video tiers +
sequence + gif (deterministic, same as before); split viewport;
`pipeline-bump` sources (font load, video frame, image-gen) still
trigger a render while paused; React DevTools highlight during playback
— only playheads/diamonds/transport paint.

## Relationship to other work

- Pairs with EffectsApp decomposition Phase 5 (the render-loop extraction
  in the 070326 review) — doing the clock store first makes that
  extraction smaller, since `useRenderLoop` then owns the store driver
  and no clock state.
- Unblocks flipping CI lint to blocking (ref-mirror cleanup).
- TrackEditor per-lane memoization (review item) becomes worthwhile only
  after step 3 — before it, the per-frame prop defeats it.
