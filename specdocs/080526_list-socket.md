# List socket + List node — design spec (draft 2026-08-05)

A first-class **`list` socket type** and the node family that rides it. The
entry point is a **List node**: the CSV node's "paste data, get values" idea
generalized to *any* list format, but where CSV is deliberately self-contained,
List emits a real `list` wire so list-specific transformations can chain.

Also in scope (small, unrelated): a **Number to String** node.

Status: **design draft, M1 implemented this session.** Devlist-adjacent to #89
("spreadsheet viewer and node for using data"). This is the "first-class data
socket" that 062926_csv-node.md §Future explicitly deferred.

## Motivation

The CSV node proved the data→graph on-ramp but locked it in one node: every
consumer re-parses the file, and there is no way to *reshape* data in the graph
(sort a leaderboard, take the top 5, filter blanks, join names into a caption).
A `list` socket makes the collection itself a value, so those become ordinary
nodes — the Toolbox way — instead of params that accrete on one god node.

## Decisions locked (from design Q&A)

- **`list` is a real SocketType**, not a self-contained node. Accepted cost:
  invariant #7 ripple (below).
- **Items are heterogeneous `SocketValue`s.** A list can hold mixed kinds, and
  in principle GPU-backed values (images, particles), not just CPU data. Chosen
  over a homogeneous typed list for headroom — list-of-image and list-of-spline
  need no new type later. Accepted cost: op nodes need runtime `kind` checks,
  and texture ownership needs the rule in §Texture ownership.
- **Cleanup on the source, transforms as nodes.** The List node owns
  *parse-level* concerns (format sniffing, range expansion, trim, drop empties,
  dedupe). *Graph-level* reshaping (sort / reverse / slice / filter / join /
  get) is chainable nodes — one way to do each thing, and it is what the list
  socket buys.
- **Source text is a plain `string` param** (multiline) plus a Load button, NOT
  a `csv_file`-style param. `paramSocketType("string") === "string"`, so the
  param is exposable: a String node — or a CSV cell — can *drive* the list at
  runtime. A `csv_file` param can never be wired.
- **Broad format support + range expansion** in v1 (see §Parsing).
- **No coercions, in either direction** (the `string` / `text_instance`
  precedent). With heterogeneous items there is no honest `list → image`, and
  an implicit `list → scalar` (count? first item?) would hide bugs. Everything
  is an explicit node. `coercible` needs no new line — `src === tgt` covers it.

## The `list` socket type

```ts
// engine/types.ts
export type ListValue = {
  kind: "list";
  items: SocketValue[];
};
```

Deliberately minimal — no `itemType` field. The item kinds are discoverable by
inspection (`items[i].kind`), a mixed list is representable, and an empty list
needs no type. Nodes that need one type derive it (see `listItemType()` in
engine/list-value.ts, which returns the single shared kind or `null` for mixed).

### Texture ownership (the load-bearing rule)

The evaluator's release paths — `releaseCachedTextures` (eviction) and the
transient collector (uncacheable outputs) — only inspect **top-level**
`image`/`mask`/`uv` values. Neither recurses into containers. `image_group` has
relied on this since Collect shipped: a group holds **borrowed** references, and
the *producing* node's cache entry owns the textures. `list` inherits that
contract exactly. Therefore:

- **List op nodes must never allocate per-item textures.** They reorder, select,
  and pass references through. That keeps them free of ownership entirely.
- A node that *builds* GPU values per item (a future "rasterize each") must own
  them in `ctx.state["<type>:<id>"]`, return `ownsTextures: false`, and release
  in `dispose` — the Text / Simulation Zones precedent.
- Never release a texture reachable from a list you *received* (invariant #3).

### Invariant #7 ripple — what a SocketType addition touches

| file | change |
|---|---|
| `engine/types.ts` | `SocketType` member, `ListValue`, `SocketValue` union |
| `engine/clips.ts` | `emptyClipOutput` → `{ kind: "list", items: [] }` |
| `components/effects/socketColor.ts` | palette pair, then `npm run gen:theme-css` |
| `NodeInspectorPopup.tsx` | `ValueSummary` case (`list · 24 × string`) |
| `SocketPeekPopover.tsx` | `PeekVisual` case (first N items as rows) |
| devguide § Socket types | one line |

Verified **not** needed: `coerce.ts` (no coercions), `graph-validation.ts`
`editorCanCoerce` (no polymorphic sockets take a list yet), EffectsApp's
Copy-to-Points type maps, `paramSocketType` (there is no `list` *param* type).

## Node: List

`type: "list"`, `name: "List"`, `category: "utility"`, `backend: "webgl2"`,
`stable: true`, `noMaskInput: true`. Produces no image, so never terminal.

### Params

| param | type | notes |
|---|---|---|
| `text` | `string`, `multiline`, `control: "file_text"` *(new hint)* | the raw list. **Exposable** → drive it from a String node / CSV cell. The control adds a "Load list…" button (`.txt/.csv/.json/.md`) that reads the file into this same param, plus a live item count. |
| `format` | `enum` | `auto｜lines｜comma｜semicolon｜tab｜pipe｜whitespace｜json｜range`, default `auto` |
| `trim` | `boolean` | default `true` — trim each item |
| `dropEmpty` | `boolean` | default `true` — drop empty items |
| `dedupe` | `boolean` | default `false` — keep first occurrence |
| `itemType` | `enum` | `auto｜text｜number`, default `auto` (infer). See below. |
| `index` | `scalar`, step 1 | which item `item` emits. **Exposable/keyframable** — the CSV `row` pattern (scene-time, LFO, floor(time)). |
| `indexMode` | `enum` | `clamp｜wrap`, default `clamp` |

`itemType` exists because inference is not always available or right:

- **It has to be.** `auto` reads the *stored* `text`, but `text` is exposable —
  when a wire drives it, `resolveAuxOutputs` still sees the stale stored value,
  so an incoming numeric list would advertise a `string` socket and the editor
  would refuse to drop `item` on a scalar input. Switch's `type` param solves
  the same problem the same way.
- **It's also the escape hatch.** `auto` reads `007, 008` as the numbers 7 and
  8; `text` keeps the padding. `number` forces the other direction, with
  unparseable items landing on 0.

A force retypes the **whole list**, not just the indexed item, so a downstream
sort sees the type the user asked for. Either way the emitted `item` kind always
matches the socket type `resolveAuxOutputs` advertised.

### Outputs

- **Primary `list`** — the parsed list. The headline wire.
- **Aux `item`** — the item at `index`, **retyped** per `itemType` above
  (`auto`: every item numeric ⇒ `scalar`, otherwise `string`). This is the
  CSV-column trick, and the only bridge from text to a scalar socket (there is
  no `string → scalar` coercion, by design).
- **Aux `count`** — `scalar`, the item count. Feeds `wrap`/modulo math and
  "3 of 12" captions.

Per-item fan-out sockets (`item:0`, `item:1`, …) were considered and **cut** —
the list wire plus a List Get node covers it without a socket explosion.

## Parsing (engine/list-parse.ts)

Engine-side, self-contained (invariant #1), pure, with a small keyed memo (a
bounded `Map`, not a `WeakMap` — the key is a plain string, so entries are
capped and evicted FIFO rather than leaked).

**Reuses the CSV parser.** `parseRows(text, delim)` is exported from
`csv-parse.ts` and does newline + delimiter + RFC-4180 quote handling in one
pass; List flattens its rows. So `"a,b\nc,d"` → 4 items, `"x"\n"y,z"` → 2 items
with the comma preserved. One parser, two nodes. Numeric item detection reuses
`parseNumericCell` (trims, strips `$`/`%`/thousands commas only when the
remainder is still a plain numeric literal).

`format: auto` sniffs in this order — first match wins:

1. **Range shorthand** — the whole text is one range expression:
   `1..10`, `1-10`, `0..20 step 2`, `0..20 x2`, `a..e`, `A..Z`. Descending when
   start > end. Expansion is capped at 10,000 items.
2. **JSON array** — starts with `[` and parses. Nested arrays/objects are
   stringified back to JSON for their item (v1: no vec2 items — see §Future).
   A tolerant retry handles Python/JS-ish input (single quotes, trailing
   commas) only when the text contains no double quotes, so real JSON is never
   mangled.
3. **Bulleted / numbered lines** — ≥2 lines and most start with `-`, `*`, `•`,
   `–`, `N.` or `N)` → split by lines, strip the marker.
4. **Delimited** — a delimiter (`,` `;` tab `|`) appears consistently on the
   first few lines → `parseRows` with it, flattened.
5. **Lines** — text contains newlines → one item per line.
6. **Whitespace** — a single line with no delimiter → split on whitespace runs.
7. Otherwise a one-item list.

Explicit `format` values skip the sniff and force step 1–6 directly.

Then, in order: `trim` → `dropEmpty` → `dedupe` → item typing (numeric ⇒
`{kind:"scalar"}`, else `{kind:"string"}`).

## Node: Number to String

`type: "number-to-string"`, `name: "Number to String"`, `category: "utility"`,
`stable: true`, `noMaskInput: true`. The missing scalar→text bridge: wire an
animated scalar into a Text node and get a counter / scoreboard / readout.

- **Input** `value` (`scalar`, optional) with a `value` scalar **param** as the
  unwired fallback — the Math/Compare pattern (`readScalar(inputs.a, params.a)`).
- **Params**: `decimals` (0–10), `trimZeros` (drop trailing zeros, default
  `false`), `pad` (min integer digits, zero-padded), `thousands` (grouping
  separator), `prefix`, `suffix`.
- **Output**: primary `string`.

## Milestones

- **M1 (this session)** — `list` SocketType + ripple, `engine/list-parse.ts`,
  the List node, the `file_text` string control, Number to String.
- **M2 — transforms.** List Get (index → retyped item), List Length, List Join
  (→ `string`, with separator / prefix / suffix / last-separator), List Sort
  (alpha / numeric / shuffle+seed, asc/desc), List Reverse, List Slice
  (start / count / step), List Filter (contains / starts / ends / regex /
  numeric compare, invert), List Merge (Collect-style dynamic inputs).
- **M3 — bridges.** List to Points (numeric list → index/value plot with
  CSV-style auto-normalize; pair list → xy). CSV node grows a per-column `list`
  aux so a spreadsheet feeds the transform chain. `list(image) ↔ image_group`
  coercion. vec2/vec3/colour item typing (nested JSON pairs, `#rrggbb` items).
- **M4 — speculative.** List Map (per-item expression, reusing the Expression
  kernel). Iterate driven by a list. Copy to Points taking one instance per
  item — the "for each" primitive the CSV spec deferred.

## Open / soft choices

- **Socket colour** — sky blue (`#38bdf8` dark / `#0284c7` light, ~225°), the
  widest free slice of the hue circle (spline 200° → image 255°). A list is a
  *container*, so a case could be made for a neutral like `render`'s slate;
  it's one line in `SOCKET_PALETTE` to repaint.
- **Newline vs delimiter precedence.** `"a,b\nc,d"` flattens to 4 items rather
  than 2 rows of 2. A list is flat by definition, and the CSV node owns tables.
- **Where the ops line falls.** `dedupe` sits on the source (cleanup) while
  `filter` is a node (reshaping). Defensible but a judgement call; if `dedupe`
  starts wanting options it should become a node.
