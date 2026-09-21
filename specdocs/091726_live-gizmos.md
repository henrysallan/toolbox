# Live Link gizmos — on-canvas handles in the live link (2026-09-17)

Status: designed with owner (Q&A 2026-09-17), implemented the same day.
Prereq reading: 081426_live-link-designer.md (the LiveDesign block, the
designer, how `/live` and the exported app share `lib/live-viewer/`),
082826_gizmo-node.md (the Gizmo node + `transform` socket),
070826_multiselect-gizmos.md (several gizmos up at once).

## What this is

Today a live link's control panel is built from **params**: the emerald
Control toggle on a parameter row adds that param to `controlParams`, the
manifest builder turns it into a knob, and the viewer renders the knob. But
a lot of what the editor lets you do is not a param — it is an **on-canvas
GUI**: the transform gizmo (Transform, Gizmo, Image / Video / SVG Source),
the primitive handles (Circle, Rectangle, Line Segment, Triangle, Text,
Auto Layout, …), the gradient handles. None of that reaches the live link.

This spec adds a **node-level** Control toggle that ships a node's on-canvas
GUI to the live link, and a **visibility toggle per shipped GUI** in the live
panel so a visitor can show / hide each set of handles and drag them.

Owner decisions (2026-09-17):

1. The visibility toggles are **visitor-facing**, flipped at runtime in the
   live panel. They start **off** when the link loads: the canvas loads
   clean and a visitor opts into a set of handles from its row. (The first
   cut started them on; the owner flipped it after trying it, same day.)
2. Ships to **both** surfaces — the hosted `/live/[slug]` page and the
   exported standalone app. One design drives both already.
3. A shipped GUI is **independent** of param controls: the node's params do
   not have to be controls too. If they are, the slider follows the drag
   (same per-session param path).
4. Handles on a **keyframe-animated** param get whatever treatment the
   sliders get today: the handle displays the keyframe-effective value and
   a drag writes the constant, which the keyframes then override at eval.

Some GUIs never ship: the spline editor (pen suite), segment dots, the
keyer sample picker, the tracker, the MIDI editor, the 3D scene. They are
authoring tools, not controls. Eligibility is an allow-list (below), so a
new overlay is out until someone opts it in.

## Vocabulary

- **Control gizmo** (`controlGizmo`) — the per-node boolean: "this node's
  on-canvas GUI is part of the live link". Parallel to `controlParams`
  (expose = engine socket; control = live-link / exported-app concept).
- **Gizmo row** — the visibility toggle the live panel renders for one
  shipped GUI.
- **Kind** — which overlay draws it: `transform` | `primitive` | `gradient`.

## Data model

```ts
// state/graph.ts NodeDataPayload (+ lib/project.ts SavedNode, same name,
// plain JSON, additive/optional — no schema bump)
controlGizmo?: boolean;
```

Eligibility lives in **`src/lib/live-gizmo.ts`** (one source of truth for
the editor toggle, the manifest builder and the gate):

```ts
export function liveGizmoKind(defType: string): LiveGizmoKind | null
//  supportsTransformGizmo on the def       → "transform"
//  PRIMITIVE_GIZMO_ADAPTERS[defType]       → "primitive"
//  defType === "gradient"                  → "gradient"
export function liveGizmoWiringBlocker(defType, kind, edges): string | null
//  Transform with `in:transform` wired     → its own TRS is ignored
//  primitive adapter `hideWhenWired` wired → the handles would lie
//  (same two rules EffectsApp applies to the editor's own overlays)
```

The Gradient node is eligible whatever its current mode; the overlay draws
nothing in the modes that have no positional handles (polar, linear wave),
exactly as the editor does.

## Manifest (`lib/live-viewer/manifest-types.ts`)

```ts
export type LiveGizmoKind = "transform" | "primitive" | "gradient";
export interface ExportManifestGizmo {
  nodeId: string;
  nodeName: string;   // same dedupe counter as controls: "Transform (2)"
  defType: string;
  kind: LiveGizmoKind;
}
// ExportManifest: additive, schemaVersion stays 1; old blobs lack it.
gizmos?: ExportManifestGizmo[];
```

`buildExportManifest` emits one entry per reachable node with
`controlGizmo` whose def is eligible and whose wiring doesn't block it. A
blocked node produces a `gizmo-hidden-by-wiring` warning (the Export App
modal shows it) and no entry. The node-name counter is shared with the
node's param controls so "Transform (2) — Handles" and "Transform (2) —
Rotate" agree. Unreachable nodes (not upstream of the active terminal) are
skipped like everything else.

## Editor

- **Toggle**: the parameter panel's title bar gains a Control-style button
  (the emerald ControlSymbol) between the node-name field and the filter
  field, only for eligible nodes. Same undo / dirty path as the per-param
  Control toggle (`pushGraph` + `setNodes`). Tooltip says what it does.
- The flag rides duplicate / copy (shallow node-data copy), save / load
  (`SavedNode.controlGizmo`), and the export packager (`runExportApp` builds
  from the live editor nodes). LiveClient's dummy nodes copy it through,
  same as `controlParams`.

## Viewer (`lib/live-viewer/`)

- **Gizmo rows** render in the **Controls** section, one per manifest
  gizmo, label `"<nodeName> — Handles"` + the shared `TogglePill`. Their
  design ref is `"<nodeId>::@gizmo"` (`gizmoControlRef` in design.ts —
  `@gizmo` can't collide with a param name), so `design.controls.order`
  and `design.controls.labels` apply to them like any control row. Default
  order: gizmo rows first in the section, then param rows (manifest order);
  the author reorders in the designer. `data-type="gizmo"` on the row so a
  pack can restyle it.
- **Visibility state** is per session in LiveViewer: a `shownGizmos` set
  of the rows switched on (empty = all hidden, per decision 1). Rows on an
  unpicked Switch branch hide with their handles (the active-branch
  filter).
- **`LiveGizmoLayer.tsx`** (new) renders the visible gizmos over the live
  canvas with the editor's own overlay components — `TransformGizmo`,
  `PrimitiveGizmo` / `PrimitivePointHandles`, `GradientOverlay` — the same
  way `GizmoTickOverlays.tsx` hosts them in the editor, minus the motion
  paths (they edit keyframes; not a live-link affordance):
  - Effective values: keyframe-evaluated at the viewer's tick
    (`floor(time × fps) × DEFAULT_TICKS_PER_FRAME`, what `makeContext`
    derives without a timeline) else the session param value. Decision 4.
  - Writes go through the viewer's `onParamChange` — the same path the
    sliders use, so a slider on the same param follows the drag and the
    eval bump repaints. Since 2026-09-19 the viewer has its own per-session
    undo / redo (`lib/live-viewer/param-history.ts`, ⌘Z / ⇧⌘Z via the
    editor's `useUndoShortcuts`): a gizmo passes `gizmo:<nodeId>` as the
    coalesce key, as `GizmoTickOverlays` does, so a drag that writes
    several params is one undo step; a slider coalesces on its own param.
    Guarded by `check-live-param-history`.
  - Transform bounds in spline / points mode come from the eval cache of
    the node feeding `in:image` (`geometryAABBFromOutput`), the Gizmo node
    uses `GIZMO_REST_AABB`, pivot space follows `params.space` — all as the
    editor does. Two or more visible gizmos → `boxTranslate` (the
    multi-select rule), so stacked gizmos don't fight over empty-canvas
    drags.
  - Snap to canvas edges / centre stays on (component default); there are
    no ruler guides in a live link.
  - The overlays are `position: fixed` at `z-index: 2`. The floating panel
    card gets `z-index: 3` so it stays above handles it overlaps; the
    shared controls' popups already sit at 10000.
- The exported app is the same code: `vite.config.ts` aliases the three
  overlay components (and their relative `overlay-rect` import) into the
  template bundle; their imports are all `@/lib` / `@/engine` leaves.

## Designer

- The Controls list shows gizmo rows tagged `gui` beside `file` / `ctl`,
  reorderable and renameable like the rest.
- The preview panel renders the rows with **ephemeral** visibility state
  (flip them to feel the chrome). It does **not** draw handles over the
  poster: the poster is a static image, and the overlays bind pointer
  listeners on the editor's `window`, which the preview iframe's drags
  would never reach. Deferred (below).

## Gates

- `scripts/check-export-manifest.mts` — a Transform with `controlGizmo`
  emits a `transform` gizmo; the same Transform with `in:transform` wired
  emits none and warns `gizmo-hidden-by-wiring`; a Circle emits
  `primitive`; a Gizmo node emits `transform`; a node with the flag but no
  eligible GUI emits nothing; an unreachable flagged node emits nothing;
  the gizmo's `nodeName` matches the same node's control `nodeName`.
- `check-persistence` / `check-fragment-roundtrip` cover the saved field
  through the existing serialize → deserialize round trips.
- Visual correctness (handles over the live canvas, the toggle rows, the
  editor button) is a live-app question: mark a Transform's handles
  live, open File → Live Link… for the rows, publish for the handles.

## Deferred / open

- Handles over the designer's poster canvas (needs the overlays to bind
  listeners on their own document's window — a `PanelWindow`-aware refactor
  of the three components).
- Per-gizmo **default** visibility (author picks which start visible) —
  the design block would grow a `gizmos.shown` list; today all start
  hidden.
- Motion-path overlays in the live link (keyframe editing is not a live
  affordance).
- Instance names in row labels — the manifest uses def names + a counter,
  as controls do; rename in the designer.
- An MCP / recipe op for the flag (`controlParams` has one; the toggle is
  editor-only today).
- The spline editor and the other authoring overlays stay out by design.

On ship: devguide § Repo map (live-viewer entry) + § Export paragraph;
TESTING.md check-export-manifest entry.
