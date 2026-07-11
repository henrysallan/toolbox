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
   REMAINING — the shell detach (the high-blast-radius commit, do
   fresh): EffectsApp's own render still consumes the clock in four
   `evaluateKeyframesAt(..., currentTick)` gizmo-derivation blocks
   (~:7768, :8671, :8791, :8887 — move into the gizmo components or a
   subscribed wrapper), the eval effect (`renderFrame(time, fps, …)` on
   `[time, fps, playing, …]` — becomes the rAF driver's imperative call,
   with a re-audit of every paused-interaction trigger), and the
   `currentTick`/`currentTickRef` derivation (ref reads move to
   `playbackClock.get().tick`). Only after those does removing the
   shell's `useClock(time/playing)` subscriptions stop EffectsShell
   re-rendering during playback.
4. **Cleanup:** delete `timeRef/playingRef` mirrors that the store
   obsoletes; this also clears a large slice of the 127 "refs during
   render" lint errors — flip the CI lint job to blocking when the count
   hits zero.

Step 2 is the highest-blast-radius commit; keep it revertable (one
commit, no consumer changes mixed in).

## Smoke script (after steps 2 and 4)

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
