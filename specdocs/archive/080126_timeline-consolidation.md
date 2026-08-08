# Timeline consolidation — shared core, policy unification, bug pass

**Date:** 2026-08-01
**Files:** `src/components/effects/timeline/*` (new),
`TrackEditor.tsx`, `LayersEditor.tsx`, `GraphEditor.tsx`,
`scripts/check-no-nul.mts`
**Origin:** deep audit of the tracks editor (owner: "feels a little
cobbled together"). The audit found the engine model
(keyframes.ts/clips.ts) solid and TrackEditor internally decent — the
cobbled feel came from 2–4 drifted copies of every timeline behavior
across the dock editors, a cluster of real interaction bugs, and mixed
integration patterns.

## 1. The shared core: `src/components/effects/timeline/`

| File | Contents |
|---|---|
| `theme.ts` | One palette + metrics. Previously 3 palettes with conflicts (selected keyframe amber in Layers vs blue in Tracks; 3 background blacks; hit radii 9/7/6px). Selected keyframe is now accent blue everywhere. |
| `view.ts` | `useTimelineView` — tick↔px transforms, cursor-anchored `zoomTo`, `fit` with an optional `leftGutterPx`. Each editor keeps its own event wiring (wheel/middle-drag semantics differ deliberately) and calls into the hook for the math. |
| `keyframe-ops.ts` | Pure move/scale/stagger over `GroupBase` drag-start snapshots, plus `SelectionKey`/`selKey`/`laneKey`/`groupSelection`/`buildGroupBases` and `nextGestureKey`. |
| `clip-ops.ts` | Pure bar move/trim: snap, ≥0 clamp, 1-frame min width, `sourceInTick` slip on in-trim (predicate-gated), footage-end clamp. |
| `ruler.ts` | The 1/2/5 nice-number frame-interval ladder (was 2 copies + 2 unrelated algorithms). |
| `EasingTile.tsx` | The easing-preview tile (was 3 copies; grew an `active` prop for GraphEditor's context menu). |
| `DiamondNav.tsx` | The ‹ ◆ › lane cluster, now self-subscribing to the clock. Moved out of TrackEditor (LayersEditor used to import it FROM TrackEditor). |
| `PlayheadChrome.tsx` | `PlayheadLine` + `PlayheadHandle` (self-subscribing clock leaves) and `HoverLine` (imperative ref handle — mousemove updates style directly, no re-render). |

## 2. Unified policies (these were the divergences users could feel)

- **Snapping**: frame-snap by default, **Shift unlocks sub-frame** —
  everywhere (keyframe drags, clip drags, scrubbing, both editors).
  Layers previously hard-snapped with no override.
- **Tick ≥ 0**: enforced everywhere, and clamped on the **gesture
  delta**, not per key — a selection pushed against 0 stops as a unit
  instead of piling keys onto tick 0 where dedup would destroy them.
  (Tracks previously allowed negative ticks; Layers clamped per-key.)
- **Collision = dragged key wins**, both directions. The old
  single-pass dedup was asymmetric: dragging a key rightward onto a
  stationary key silently discarded the *dragged* key on release.
- **Scale can't collapse or mirror**: the factor is clamped so the
  selected span never drops below one frame; dragging through the
  anchor pins at the minimum instead of mirroring into dedup data loss.
- **Undo granularity**: every multi-lane gesture (delete, paste,
  easing-set, drag, stagger) passes one `nextGestureKey(...)` per
  gesture to `onAnimationChange` → ONE history entry. Distinct default
  coalesce keys previously made a 5-lane delete cost 5 undos. Unique
  per-gesture keys also stop two rapid drags <700ms apart from merging.
- **Selection keys**: NUL-escape separators everywhere. Layers'
  space-delimited `selKey` could collide on names containing spaces.
- **`clipSlipsOnInTrim`** is consulted by both editors (Layers used to
  hardcode the slip); the video footage-end clamp now lives in the
  shared trim op.
- **`animated` flag untouched by transforms**: moving keys on a
  disabled block keeps it disabled (Layers used to force
  `animated: true` on any move — violated the non-destructive
  disable contract).

## 3. TrackEditor bug fixes

- **Stale keyboard shortcuts** (the audit's worst bug): the window
  keydown listener re-subscribed only on selection identity, so Cmd+V
  pasted at the tick the playhead had *when the selection last
  changed*. Now: one subscription, latest closures via a render-synced
  `keyActionsRef` (synced in an every-render effect to satisfy
  react-hooks/refs), and all playhead-dependent actions read
  `playbackClock.get().tick` at event time.
- **Label-gutter dead zone**: fit now reserves `PARAM_LABEL_WIDTH`, so
  tick 0 lands just right of the floating gutter — early keyframes are
  visible and clickable out of the box.
- **Shift-click deselect inside the selection box** (the interior-drag
  branch used to swallow it as a group-move).
- **Ghost clips materialize on first drag movement, not on mousedown**
  — clicking a clip ghost no longer dirties the save.
- **Virtual-key lanes** (merge layer opacity, ramp stops):
  `toggleKeyAtPlayhead` resolves the stored value through the virtual
  shape (`storedParamValue`) instead of inserting an
  `undefined`-valued keyframe; unresolvable → no insert.
- **Window-blur cancels drags** (both editors) — Cmd+Tab mid-drag no
  longer leaves the gesture stuck.
- **Shift-marquee is additive** (both editors already cleared on
  plain marquee; Tracks used to *replace* even with Shift held).
- **Home = fit, F = focus selection** — the spec'd shortcuts
  (updatedtimelinespecv2 §3.7) that were a TODO.
- Scrubbing clamps ≥0 in both editors.

## 4. Perf pass (clock-store spec's leaf-subscription pass)

TrackEditor and LayersEditor no longer subscribe to the clock at their
top level. The tick is consumed by: `PlayheadLine`/`PlayheadHandle`
leaves, per-lane `DiamondNav` leaves, and imperative reads in actions.
**Playback no longer re-renders the editor shells at 60fps** — the
open item flagged as "highest-value UI perf item left" in the 072226
architecture review (B3), for these two editors. GraphEditor and
ParamPanel still subscribe at top level (future work).

Also: hover playhead-preview lines are imperative (`HoverLine` ref —
no re-render per mousemove); keyframe diamonds and easing connectors
cull outside the viewport (the old right-edge cull compared against a
hardcoded `99999`); the inspector's `allScalar`/`stepOnly` gating is
one memo instead of an O(presets × selection × lanes) scan per render.
Dead code dropped: the never-wired `trackHeight` state (+ MIN/MAX
constants), `void minorFrames`, GraphEditor's unreachable
`setEasingFor` and `void`-discarded computations.

## 5. NUL-byte CI guard

`scripts/check-no-nul.mts`, first in the `npm run check` chain (which
CI runs). A literal NUL byte in source makes grep classify the file as
binary and silently return nothing — this bit TrackEditor (070326
review), then recurred in EffectsApp, and cost the audit an hour of
false conclusions. Separators use the backslash-u0000 ESCAPE; the raw byte is
now a CI failure. Lint ratchet baseline tightened 126 → 121 (the
render-time ref writes in Track/Layers moved into effects).

## 6. Deliberately NOT unified

- **GraphEditor's transform ops** (point/handle drags, modal G/S,
  box-resize): value-axis semantics and index-based selection make them
  structurally different; forcing them through the lane-keyed ops would
  obscure both. It did adopt the shared `EasingTile` and got its dead
  code removed.
- **GraphEditor's Shift = axis-constraint** on point drags (vs
  snap-bypass elsewhere): Shift is genuinely taken there.
- **`PRESET_CTRL` legacy keys and `HEIGHT`** (flagged as dead by the
  audit scout): both load-bearing — legacy easing names still arrive in
  old project files and are consulted for curve *drawing*; `HEIGHT` is
  the pre-measure fallback.
- **PlaybackBar**: seconds-domain transport, no tick math to share.
- **Per-editor wheel wiring**: Tracks' device-dependent zoom/scroll
  split vs Layers' `wheelWantsZoom` predicate — same zoom math via the
  hook, intentionally different gestures.
