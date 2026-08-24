# Spreadsheet panel (devlist #89 — viewer half)

A Blender-style spreadsheet editor: a new `PanelKind` that shows the
evaluated data flowing out of the selected node as a real table — click a
Point Expression node and see every point's index, position, scale,
rotation, group. The point is an *intelligibility layer* over socket
values, built so richer data (named attributes, the #135 Debug node, the
CSV preview from 062926_csv-node.md M2) can ride the same projection
later.

Design decisions (owner Q&A, 08/13/26):

- **v1 tabular types: `points`/`points3d`, `list`, `spline`.** Everything
  else falls back to the shared `ValueSummary` line (same fallback grammar
  as the peek popover). `notes` and CSV are follow-ups.
- **Socket selector + pin.** The panel follows the selected node and
  defaults to its primary output; a dropdown picks any output (primary +
  aux), and a Blender-style pin freezes the panel on the current
  node+socket so it stops following selection. Inputs are out of scope
  (they'd need the `inspectIds` pre-compute capture; outputs don't).
- **Fixed point schema only.** No named-attribute engine work now — but
  the projection is column-driven so future `attributes` arrays become
  extra columns with zero panel changes.
- **Throttled live refresh.** Identity-guarded polling at ~300ms
  (PerfPanel's reasoning: never re-render a grid at frame rate).

## Architecture

### 1. Table projection — `src/engine/table-model.ts` (new, engine-side)

Engine placement is deliberate: invariant #1 lets nodes/engine import it
(the future Debug node needs it) and components import engine freely.
Mirrors the `point-labels.ts` precedent — a points value has a *fixed,
knowable schema*, so columns are enumerated, not scraped.

```ts
export interface TableColumn {
  key: string;                 // stable id ("x", "scale.x", …)
  label: string;               // header text
  kind: "index" | "number" | "angle" | "text";
  // authored-space tag so the UI can offer normalized↔pixel display
  // (POINT_LABEL_UNITS precedent; y is anisotropic on purpose):
  space?: "norm-x" | "norm-y";
  get(row: number): number | string;
}
export interface TableModel {
  kind: string;                // source socket kind, for the header
  rowCount: number;
  columns: TableColumn[];
}
export function tableForValue(value: SocketValue | undefined): TableModel | null;
```

Rules:

- **Lazy cells.** Columns close over the value's typed arrays; nothing is
  materialized. The grid calls `get()` for visible rows only. Never
  `ensurePointArray()` (allocates N objects, dev-warns on 3D).
- **Raw values out, formatting in the panel.** The model returns numbers;
  the component owns display (decimals via `formatNum`, degrees for
  `angle`, pixel-unit conversion for `space`-tagged columns — engine must
  not import lib/).
- Projections:
  - `points`/`points3d`: `index` always; `x`,`y` from `positions`; `z` when
    3D; `scale.x`,`scale.y` when `scales` present; `rotation` (kind
    `angle`) when `rotations` present; `group` when `groupIndices`
    present; `nx`,`ny`,`nz` when `normals` present. Absent-array defaults
    via points.ts readers (`getScaleX`…) are NOT used — absent array =
    absent column (the truth of the value, not the render default).
    2D positions get `space` tags; 3D are world meters (no unit toggle).
  - `spline`: one row per anchor across subpaths — `subpath`, `index`,
    `x`, `y`, `in.x`, `in.y`, `out.x`, `out.y` (authored space, `space`
    tags). A prefix-sum over subpath lengths keeps row lookup O(log n).
  - `list`: homogeneous scalar/vec/string lists expand into real value
    columns (`x`/`y`/`z`/`w` for vecs); mixed or non-numeric lists read as
    `index`, `type`, `value` via the existing engine-side
    `describeListItem`. Items are BORROWED (list-value.ts contract) —
    read-only display, never release.

### 2. The panel — `src/components/effects/SpreadsheetPanel.tsx` (new)

PerfPanel is the structural template: takes `kindMenu` and renders it in
its own header row, polls instead of subscribing.

- Header row: kind-menu chip · node title (or "no selection") · socket
  dropdown (primary + aux handles, type-colored dots via SOCKET_PALETTE) ·
  pin toggle · units toggle (normalized/pixels; points-2D + spline only) ·
  row count.
- Grid: hand-rolled virtualization (no grid dep exists) — fixed row
  height, one absolutely-positioned window of rows inside a scroll
  container with a full-height spacer, sticky header, ~10-row overscan.
  Numbers right-aligned, index column left. Handles 100k+ rows because
  only ~40 render.
- Fallback body for non-tabular values: `ValueSummary` (exported from
  NodeInspectorPopup) + the kind name, `evaluated={!!out}` distinguishing
  "empty" from "never evaluated" (peek's grammar).

### 3. Data path (the peek popover's, generalized)

- EffectsApp keeps `spreadsheetTargetsRef: Map<leafId, {nodeId, handle}>`.
  `renderFrame` merges its entries into `evaluateGraph`'s
  `opts.extraTargets`/`extraConsumed` beside the peek target — a
  disconnected or consumption-gated selected node still produces rows.
  Skipped during offline export (peek precedent).
- The panel reads via a callback prop:
  `evalCacheRef.current.get(nodeId)?.output ?? lastEvalOutputsRef.current?.get(nodeId)`,
  then `out.primary` / `out.aux[name]` per the chosen handle.
- Refresh: 300ms `setInterval` while mounted; re-read the value, compare
  **object identity** (cache hits return the same object; recompute mints
  a new one), `setState` only on change. A `pipeline-bump` is dispatched
  on mount/target-change so paused editors evaluate once immediately.
- Per-panel state (pinned target, chosen handle, units, scroll) follows
  the `dockTabs` pattern — component state keyed by `leafId`; leaf ids
  are session-only and that's fine (pin is a working gesture, not a
  document property). Duplicates of the panel are legal, each with its
  own target.

### 4. Panel-kind plumbing (the checklist)

1. `layout/model.ts`: `PanelKind` union + `PANEL_KINDS` + `PANEL_LABELS`
   ("Spreadsheet").
2. `layout/PanelKindMenu.tsx`: `KindIcon` branch (else it silently gets
   the params icon).
3. `EffectsApp.tsx` `panelKindMenuFor`: add to the hand-enumerated
   last-viewport `disabledReason` map (else the chip can retire the last
   viewport).
4. `EffectsApp.tsx` `renderLayoutPanel`: branch before the params
   fallthrough.
5. Pop-out works with zero extra code; any window listener must use
   `usePanelWindow()`.

Back-compat note (model.ts:16): an older build loading a layout containing
`"spreadsheet"` rejects the whole tree and falls back to the default
preset — layout-only loss, acceptable and pre-existing behavior for any
new kind.

## Milestones

- **M1 — points end-to-end.** table-model.ts (points projection only) +
  SpreadsheetPanel (virtualized grid, socket selector, pin, units toggle,
  throttled refresh, summary fallback) + kind plumbing + forced-eval
  wiring. Ships alone as a useful feature.
- **M2 — spline + list projections.** Plus the `type`/`value` summary
  columns for lists.
- **Future (explicitly out of scope now):** `notes` projection; CSV/table
  preview reuse; named point attributes (extra columns slot in via
  TableColumn); the #135 Debug node (params-panel widget riding the same
  TableModel); row selection ↔ viewport highlight; column
  filtering/sorting.

## Gates

`npm run typecheck`, `npm run check`, `npm run lint:ratchet`. Manual:
select a Scatter Points / Point Expression node → rows appear and animate
while playing; pin + select elsewhere → panel holds; 100k-point scatter
scrolls smoothly; disconnected branch still shows data; pop-out window
works; kind menu can't kill the last viewport.
