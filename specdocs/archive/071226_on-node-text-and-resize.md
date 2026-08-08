# On-node text input + universal node resize (2026-07-12)

Two small, composable node-chrome features requested together:

- **On-node string control** — an actual editable text box rendered on the
  node body for the **String** (`string-literal`) source and the **Text**
  node's `text` param. Type directly on the node instead of opening the
  param panel. (Follows #146, which already shipped the `string` socket so
  a String node can drive any exposed string param.)
- **Universal resize grip** — a small drag target on the **lower-left**
  corner of *every* node. Resizes **width + height**; the size **persists**
  with the project. Reflow quirks for other node types are explicitly
  out of scope for v1 ("figure out weird spacing later").

They meet at the String/Text node: the inline textarea fills the
resizable body, so the resize grip is what makes a big block of text
comfortable to edit on-canvas.

## Decisions (from design Q&A)

1. **Reusable control, String + Text.** Build one on-node string control
   and use it for both the String source (`value` param) and the Text node
   (`text` param). Not a per-node one-off.
2. **Width + height, persisted.** The grip resizes both axes and the size
   serializes into the project (additive, schema-compatible). Height mostly
   benefits the text box; other nodes get harmless bottom dead-space for now.
3. **Lower-left grip on all nodes.** Honoured literally — a bottom-left
   handle. Because it's the *left* edge, dragging it also shifts the node's
   `position.x` so the right edge stays anchored (standard corner-resize).

## Invariants respected

- Edits flow through the existing `effect-node-param` → `onParamChange`
  path ([EffectsApp.tsx:4576](../../src/components/effects/EffectsApp.tsx#L4576)),
  so undo history, autokey, and `resolveInputs/PrimaryOutput/AuxOutputs`
  all fire naturally — exactly like the Color node's on-node swatches and
  the header dropdowns. **No new mutation path.**
- Structural size/position changes go through graph state the normal way
  (invariant #5): a resize dispatches an event EffectsApp turns into a
  `setNodes` update (size is UI state on `data`, position is xyflow's).
- `src/engine` + `src/nodes` untouched — this is pure editor chrome
  (invariant #1). `string-literal` / `text` node defs are unchanged; the UI
  reads their existing `value` / `text` params.

## Feature A — on-node string control

### Component

A small `NodeStringInput` in [EffectNode.tsx](../../src/components/effects/EffectNode.tsx)
(or a sibling file it imports), rendered as its own section **below** the
socket body — the socket rows are absolutely positioned inside the
`height: bodyH` box, so the input must NOT live inside it. Same structural
slot the Output node's export-button footer uses.

```
defType === "string-literal"  → edits param "value"
defType === "text"            → edits param "text"
```

- **Controlled-but-buffered.** Keep a local `useState` seeded from
  `data.params[name]`, sync it from props on external change (wire drives
  the param, undo, AI edit) via a `useEffect` guarded so it doesn't clobber
  mid-typing. Dispatch `effect-node-param` (`{id, name, value}`) on every
  input. This avoids caret-jump from round-tripping a fully controlled
  value through the event → onParamChange → re-render loop.
- **Event hygiene (the real work):**
  - `className="nodrag"` so xyflow doesn't start a node drag.
  - `onPointerDown` / `onMouseDown` `stopPropagation` — don't deselect /
    start marquee / begin the shift-drag fuzzy-connect (NodeEditor's
    capture-phase body interceptor).
  - `onKeyDown` `stopPropagation` — Backspace/Delete must edit text, not
    delete the node; Space/Cmd-C/Cmd-V/Cmd-A must not hit canvas shortcuts.
  - Let `wheel` through only when the textarea actually scrolls (tall
    content) — otherwise canvas zoom still works over the node.
- **Sizing.** `<textarea>` fills the section width and its height tracks
  the node's resized height (Feature B) — `flex: 1` / `height: 100%` inside
  a flex column, `resize: none` (our grip owns resizing). Default height
  when unresized: ~3 rows, matching the current single-output String node
  footprint plus room to type.
- **Placeholder / styling** reuse the param's `placeholder` ("type here…")
  and the node's mono font. Disabled/read-only when the param is wired
  (an incoming `string` edge drives `value`) — show the wired value greyed,
  same principle as the Color node's palette-mode swatches.

### Notes

- Text node keeps its full param panel; only the `text` field is mirrored
  on-node. The two stay in sync automatically (both read/write the same
  param via onParamChange).
- Multiline is already declared on both params (`multiline: true`), so a
  textarea is the correct control (not a single-line input).

## Feature B — universal resize grip

### Where the size lives

Add to `NodeDataPayload` ([graph.ts](../../src/state/graph.ts)):

```ts
// User-resized node box (px). Absent ⇒ auto: width = content minWidth,
// height = content-driven bodyH. Editor-only UI state; persisted so a
// resized node keeps its size across reloads.
uiWidth?: number;
uiHeight?: number;
```

Applied on the outer node `<div>` in EffectNode:
- `width: data.uiWidth ?? undefined` (falls back to the existing per-type
  `minWidth`).
- `height: data.uiHeight ?? undefined` with `minHeight` = the computed
  content height so a node can't be shrunk below its rows. The socket body
  keeps its intrinsic `bodyH`; extra height flows to the string section
  (Feature A) or to bottom dead-space (everything else — accepted for v1).

### The grip

A custom pointer-drag handle (not xyflow's `NodeResizeControl` — our layout
is content-sized, not driven by xyflow's `node.width/height`, so a custom
handle keeps full control and avoids fighting its assumptions). ~10px hit
target, bottom-left corner, `className="nodrag"`, `cursor: nesw-resize`,
visible on hover / when selected (quiet otherwise).

Drag math (pointer capture on the handle):
- `newWidth  = startWidth  + (startX - clientX)`  (left edge follows cursor)
- `newHeight = startHeight + (clientY - startY)`  (bottom edge follows)
- Clamp to `[minWidth, …]` / `[minContentHeight, …]`.
- Because the **left** edge moved, shift `position.x` by the *actual*
  applied `-Δwidth` (after clamping) so the right edge stays put.

Dispatch a `effect-node-resize` event `{id, width, height, dx}`; EffectsApp
adds a listener (mirroring `effect-node-param`) that does one `setNodes`:
set `data.uiWidth/uiHeight` and `position.x += dx`. Then call
`updateNodeInternals(id)` so xyflow re-measures handle positions (left
sockets moved with the left edge; right sockets moved with width) and wires
stay attached — same re-measure the rename path already relies on
([EffectNode.tsx:194](../../src/components/effects/EffectNode.tsx#L194)).

- **Undo:** wrap the resize commit in the same history snapshot mechanism
  param edits use (coalesce a drag into one undo step — push on pointer-up,
  not per-move).
- **Double-click the grip → reset** to auto (clear `uiWidth/uiHeight`).

### Persistence

- `serializeGraph`/`deserializeGraph` ([project.ts](../../src/lib/project.ts)):
  carry `uiWidth`/`uiHeight` through. Additive — old saves simply lack them
  and auto-size, so **no schema bump / migration** is required (confirm
  serialize's field handling: if it whitelists node-data fields, add these
  two; if it spreads, they ride along free).
- `.toolbox` files inherit this through the same serialize path.

## Milestones

1. **On-node String box** — `NodeStringInput` for `string-literal` only;
   event hygiene; buffered controlled value. Verify: type on node, value
   drives downstream, undo works, node doesn't drag/delete while typing.
2. **Extend to Text** — same control for the `text` param; confirm on-node
   ↔ param-panel sync and that wired `text` disables the box.
3. **Resize grip (session)** — `uiWidth/uiHeight` on data + outer-div
   sizing + bottom-left grip + `effect-node-resize` handler + reposition +
   `updateNodeInternals`. Verify on a plain node, a String node (textarea
   grows), and one with many sockets (wires stay attached).
4. **Persist + polish** — serialize sizes; double-click reset; undo
   coalescing; hover affordance. Verify save→reload keeps sizes.

## Risks / open questions

- **Bottom-left vs sockets.** The grip sits in the bottom padding below the
  last input socket row; on a short node the last left socket and the grip
  are close. If they collide in practice, nudge the grip inboard a few px
  (still visually "lower-left"). Cheap to adjust — flagged, not blocking.
- **Height on socket-heavy nodes.** Extra height is dead-space (sockets
  stay top-anchored). Accepted for v1; a later pass could vertically center
  or evenly distribute rows when `uiHeight` exceeds `bodyH`.
- **Serialize field handling** — one lookup during M4 decides "add two
  fields" vs "already rides along." No expected surprise.

## Amendment — 2026-08-02: grip moved to the bottom-right

Superseded by the node-UI restyle. The grip is now a **bottom-right**
quarter-round bracket that overhangs the corner by 4px
([EffectNode.tsx `ResizeGrip`](../../src/components/effects/EffectNode.tsx)),
`cursor: nwse-resize`.

Consequences for the spec above:

- Drag math is now `newWidth = startWidth + (clientX - startX)` — the
  **right** edge follows the cursor.
- The `position.x` compensation is gone. The top-left corner is the drag
  anchor, so the node never moves while resizing; `effect-node-resize` no
  longer carries `dx` and the EffectsApp handler no longer touches
  `position`. This retires decision 3 above and its "reposition" step in M3.
- The "bottom-left vs sockets" risk carries over mirrored (the grip now
  neighbours the last *output* socket) with the same ~3px overlap and the
  same cheap fix.
