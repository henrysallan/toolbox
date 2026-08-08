# Output-socket peek popover (shipped 07/21/26)

Hover an **output socket** for ~2 seconds → a popover appears next to the
socket showing the data currently flowing out of it. Complements the
per-node `i` inspector (NodeInspectorPopup) with a zero-click,
single-socket peek that includes visual previews.

## Behavior

- Dwell 2s (`PEEK_DWELL_MS` in EffectNode.tsx) on any output handle —
  primary or aux — without a button held. Disabled and virtual sockets
  don't arm. Pressing down (starting a wire drag) or leaving the handle
  cancels; leaving after the popover opened hides it with a ~250ms grace
  so the pointer can travel into the popover (e.g. to scroll a long
  string). Hovering the popover holds it open.
- The popover is anchored to the right of the node at the socket's row,
  rendered in flow coordinates inside `<ViewportPortal>` (pans/zooms with
  the graph, same contract as NodeInspectorPopup).
- Content = one summary line (shared `ValueSummary` from
  NodeInspectorPopup) plus a visual per kind:
  - `image` / `mask` / `uv` — live thumbnail via the engine's pooled
    `readImagePixels` readback (never blitToCanvas+getImageData). Masks
    are R-channel textures; the readback is expanded to grayscale
    CPU-side. Checkerboard backdrop shows real alpha. 2× backing store
    so zooming in stays sharp.
  - `image_group` — thumbnail of the first item (+ count in the summary).
  - `spline` — path drawing (cubics, normalized Y-down coords mapped
    straight to a 2D canvas) in a box of the composition's aspect.
  - `points` — dot drawing, stride-sampled above 4000 points (true count
    stays in the summary line).
  - `vec3` / `vec4` — color swatch (the Color node's outputs) + numbers.
  - `string` — the text itself, scrollable, pre-wrap.
  - everything else (sdf, element, audio, particles…) — summary only;
    the fallback names the kind.
- The popover refreshes every eval while open (rAF-coalesced via the
  inspector's `inspectTick` bump), so playing graphs peek live.

## How it evaluates (the load-bearing part)

Hovered sockets must show data even when the branch is disconnected or
the aux output is consumption-gated:

- EffectsApp keeps the peek target in `socketPeekRef`; `renderFrame`
  passes it to `evaluateGraph` as `opts.extraTargets` (forces the node
  into the needed set) plus the new `opts.extraConsumed` (marks the
  hovered handle — `"primary"` / `"aux:<name>"` — consumed, so
  `consumedOutputs`-gating nodes like Text build the peeked aux).
- Opening a peek dispatches `pipeline-bump`, so paused editors evaluate
  once immediately.
- Values are read from `evalCacheRef` / `lastEvalOutputsRef` (same
  freshness contract as getRefImageBlob); thumbnails copy pixels into a
  2D canvas immediately, so later texture releases can't show garbage.
- Offline export skips the forced target (no popover is visible).
- Known gaps (popover shows "(not evaluated)"): group boundary nodes
  (dissolved at flatten) and Iterate members (extracted into the shell's
  private eval).

## Events

`socket-peek` on window, dispatched by EffectNode:
- show: `{ id, handle: "out:primary" | "out:aux:<name>", anchorY }` —
  anchorY is the socket-row center in node-local px.
- hide: `{ id, handle, hide: true }` (also fired on node unmount).

## Files

- `src/components/effects/SocketPeekPopover.tsx` — the popover (new).
- `src/components/effects/EffectNode.tsx` — dwell timer + events.
- `src/components/effects/EffectsApp.tsx` — peek state, forced eval,
  readback callback, overlay mount next to the inspect popups.
- `src/components/effects/NodeInspectorPopup.tsx` — `ValueSummary`
  exported + string/kind-name fallbacks improved.
- `src/engine/evaluator.ts` — `opts.extraConsumed`.
