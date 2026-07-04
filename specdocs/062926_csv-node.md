# CSV node — design spec (draft 2026-06-29)

A node that loads a CSV and makes its data usable in the graph two ways:
**data-driven values** (pick/drive a row → per-column cell outputs that feed
Text, counters, scoreboards) and **data viz** (two columns → a `points` set
that feeds the existing points/spline pipeline for line/scatter plots).

Status: **design draft.** Scope locked below. Devlist #146-adjacent (#89
"spreadsheet viewer and node for using data"). Builds on the new `string`
socket (062926, this session).

## Motivation

Data-driven motion graphics — leaderboards, stat cards, dynamic lower-thirds,
animated charts — currently have no on-ramp. Everything is hand-typed into Text
nodes and hand-placed. A CSV node turns a spreadsheet into graph values: wire a
column straight into a Text node's `text` socket, or plot two columns as a line.

## Decisions locked (from design Q&A)

- **Self-contained node.** No `table`/dataset socket type. The node parses the
  CSV internally and emits only existing socket types (`string`, `scalar`,
  `points`). Leaner now; the cost is that Filter/Sort/Debug/live-data would each
  reload the file rather than chain — accepted for v1. (A first-class `table`
  socket remains the natural future backbone if a data *pipeline* is wanted —
  see §Future.)
- **Per-column type inference.** A column whose every non-empty cell parses as a
  finite number outputs `scalar`; otherwise `string`. The output socket's *type*
  follows the data. This is the bridge that lets numeric columns reach scalar
  inputs (there is no `string→scalar` coercion, by design).
- **Local file / paste only.** CSV text stored inline in the project (the
  `lut_file` pattern); round-trips through save/load, no "missing media" relink.
  URL / Google-Sheets / API sources (devlist #90) are out of scope for v1.
- **No batch render.** "Render once per row" needs a `foreach`/iteration
  primitive the engine lacks; explicitly deferred (its own epic).

## The node

`type: "csv"`, `name: "CSV"`, `category: "utility"`, `backend: "webgl2"`,
`stable: true`, `noMaskInput: true`. Produces no image, so it is never a
terminal/preview node.

### Params

| param | type | notes |
|---|---|---|
| `csv` | `csv_file` *(new)* | `{ filename?, text }`. Loaded via upload or paste; serializes inline. |
| `hasHeader` | `boolean` | default `true`. When off, columns are named `col 1`, `col 2`, … |
| `delimiter` | `enum` | `auto` \| `comma` \| `tab` \| `semicolon`, default `auto` (sniff the first line). |
| `row` | `scalar` | the active row index. **Exposable** as a scalar socket → drive it with scene-time, an LFO, `floor(time)`, an index. Fractional → `floor`. |
| `rowMode` | `enum` | `clamp` \| `wrap`, default `clamp` (how `row` behaves past the ends). |
| `plotX` | `enum` | x column for the `points` output (header list; `index` = use row number). |
| `plotY` | `enum` | y column for the `points` output. |
| `normalize` | `enum` | `auto` \| `manual`, default `auto`. `auto` fits each axis to its column min/max; `manual` exposes explicit domain params. |
| `xMin/xMax/yMin/yMax` | `scalar` | manual domain, `visibleIf normalize === "manual"`. |

`plotX/plotY/normalize/domain` are the "viz face." They sit on the same node
(the self-contained tradeoff) but only the points output reads them, so the
data-driven user can ignore them.

### Outputs

- **Primary: `points`** — the plot. Each data row → one point; x from `plotX`,
  y from `plotY`, mapped into normalized `[0,1]²` via the domain. Feeds
  Connect Points → a line, Copy-to-Points → scatter markers, etc. Empty when no
  CSV is loaded or fewer than 2 plottable columns.
- **Aux, one per column (dynamic):** the **cell at the current `row`**, typed
  `scalar`/`string` by inference, labelled by header. Built via
  `resolveAuxOutputs(params)` reading the parsed headers — the Expression /
  Merge dynamic-socket pattern. Socket **id is positional** (`col:<index>`,
  stable across header text edits); **label is the header**.

> **Why points as primary:** it's the one "headline" wire and makes the node
> drag-to-plot by default; cells are the fan-out. A data-driven-only user grabs
> the aux they want. (Soft choice — revisit if it reads wrong in use.)

## Parsing

- RFC-4180-ish: quoted fields (`"a,b"`), escaped quotes (`""`), CRLF/LF. Keep a
  small hand-rolled parser — no dependency.
- `delimiter: auto` sniffs the first line (count `,` vs `\t` vs `;`, pick the
  max).
- Ragged rows pad/truncate to the header width.
- Parsed table cached on `ctx.state["csv:<id>"]` keyed by a cheap hash of
  `text + options`; re-parsed only when those change. `resolveAuxOutputs` shares
  the same memoized parse (it runs off `params`, not `ctx`, so it keeps its own
  tiny module-level `text→headers` cache).

### Numeric inference

Per column: trim each cell; strip thousands commas / leading `$` / trailing `%`
*only if the result still parses*; a column is **numeric** iff every non-empty
cell is then `Number.isFinite`. Empty / non-parsing cells in a numeric column →
`0`. (`%` divides by 100; `$1,234` → `1234`. Modest on purpose; a manual
per-column type override is a v2 nicety.)

## Reactivity & caching

`stable: true`; the node caches perfectly unless `row` is animated/driven, which
already flows through the wire>keyframe>param fingerprint. The CSV text lives in
`params`, so `stableStringify(params)` covers content changes for free.
**Note (shared with `lut_file`):** a very large CSV makes the per-frame params
fingerprint heavy. Acceptable for v1; if it bites, fold a text *hash* into
`fingerprintExtras` and exclude the raw text from the hot path.

## Param-panel UI

- **File control** for `csv_file`: "Load .csv" button (`FileReader.readAsText`,
  mirrors the `.cube` control in `param-controls.tsx`) **+ a paste textarea**.
- **Spreadsheet preview** (read-only): a compact scrollable table of the parsed
  data, the active `row` highlighted, a `#`/`abc` type badge per column header.
  High authoring value, and the seed of the devlist #135 Debug node. v1 = basic;
  it does not need to be editable.

## Data-viz notes (what v1 does and doesn't give)

v1 ships the **data→geometry bridge** (Table-less): CSV `points` → existing
nodes. The hard part is the **domain mapping** (years `2010–2024`, dollars
`0–1M` → canvas space), which `normalize: auto` handles by fitting each column's
min/max. Points are emitted in the engine's normalized `[0,1]²` **Y-DOWN**
convention; charts usually want value-up, so the points are emitted with y
flipped (larger value = higher on screen) — call this out in the node docs.

**Deferred to phase 2 (real charts):** axes, ticks, gridlines, value/row labels,
and bar charts (per-row rectangles whose height = value — needs per-row geometry,
likely Copy-to-Points with value-driven scale or a dedicated Bar node). v1 users
compose lines/scatter from points by hand.

## New socket / type / ripple

- **New `ParamType: "csv_file"`** + `CsvFileParamValue { filename?: string;
  text: string }` in `types.ts`. Touches: ParamPanel/param-controls renderer
  (new control), `node-catalog.ts` `SETTABLE_PARAM_TYPES` (**not** settable by
  the AI — it's a media-ish blob, leave out), serialization (plain JSON, already
  round-trips), `isKeyframable` (no). No new *socket* type — outputs reuse
  `string`/`scalar`/`points`.
- No coercion changes: `string` and `points` already exist; numeric cells are
  `scalar`.

## Milestones

1. **M1 — data-driven cells.** `csv_file` param + file/paste control; parser +
   inference; `row`/`rowMode`; dynamic per-column aux outputs (string/scalar).
   Register node. Ship: CSV → Text via the `string` socket; CSV → scalar inputs.
2. **M2 — viz + preview.** `points` primary with `plotX/plotY` + `auto`/`manual`
   domain; spreadsheet preview in the panel.
3. **M3 (later) — charts.** Axes/labels/bars; possibly promote to a `table`
   socket + Filter/Sort/Debug/API family if the data pipeline earns its keep.

## Future / explicitly out of scope

- `table` socket backbone → Filter / Sort / Debug-spreadsheet (#135) / API-live
  (#90) family. The clean extensibility path if data-as-pipeline is wanted.
- Batch render per row (needs `foreach`).
- Editable spreadsheet / in-app data authoring.

## Files (anticipated)

- `src/engine/types.ts` — `csv_file` ParamType + `CsvFileParamValue`.
- `src/engine/csv-parse.ts` *(new)* — pure parser + inference (engine-side,
  self-contained per invariant #1).
- `src/nodes/source/csv.ts` *(new)* + register in `src/nodes/index.ts`.
- `src/lib/param-controls.tsx` + `src/components/effects/ParamPanel.tsx` —
  `csv_file` control (load/paste) + spreadsheet preview.
- `src/engine/node-catalog.ts` — leave `csv_file` out of `SETTABLE_PARAM_TYPES`.
- `specdocs/061226_devguide.md` — note the node + param type once shipped.
