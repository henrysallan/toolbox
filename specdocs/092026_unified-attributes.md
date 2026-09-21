# Unified Attributes — one schema for built-in and named channels

Status: M1–M4 landed 2026-09-20 (gate: `scripts/check-unified-attrs.mts`); M5 cleanup pending · Touches: `src/engine/points.ts`,
`src/engine/spline-attrs.ts`, `src/engine/spline-color-source.ts`, Set Named
Attribute, Attribute Math, Map Attribute, Attribute Transfer, Point Expression,
Stagger, Filter Points, Sample Texture at Points, Copy to Points, the driver
producers (Space Fill, Differential Growth, Voronoi, growth emitters).

## 0. Audit against the code (2026-09-20)

The proposal was written from the 09/19–09/20 session. Checked line by line
against the working tree before starting; these findings change the plan:

- **Collect already carries everything.** Spline mode spreads `...sub`
  (driver, subpath attrs, anchor attrs survive; only `groupIndex` is
  rewritten — fixed 2026-09-20). Points mode goes through `concatPoints`,
  which unions channels by name and zero-fills sources that lack one, first-
  seen arity wins. §4.3's Collect row is therefore tests only.
- **Attribute Math already has `modulo` / `wrap` / `fraction` / `log` /
  `exp`** (2026-09-20). What remains is built-in names in and out.
- **MCP tooling is mostly done**: `set_param` accepts `float_curve` as
  `[{x, y}]`, `get_graph` prints non-default curves id-free, `get_node_data`
  reports `attrNames` / `subpathAttrNames` over the whole value (TESTING.md
  §check-mcp). M4 shrinks to catalog facts + the `driver` row in inspect.
- **Map Attribute's identity curve is exactly linear.** A two-point
  (0,0)→(1,1) Fritsch–Carlson curve has unit end tangents, so the Hermite
  segment reduces to `y = x` (float-curve.ts). The "S-curve" seen on 09/19
  had another cause (a curve with more than two points, or a `set_param`
  that predated the `[{x, y}]` accept path and fell back). `curve_enabled`
  is dropped: it would add a param + a migration to make identity what it
  already is. `map_target → output_name` stays.
- **`driver` was never reserved.** Set Named Attribute target=subpaths
  name=driver already writes `attrs.driver`. The gap is the consumer:
  `makeSubpathDriverFn` reads `sub.driver` only when `cfg.attr` is empty.
  Fix is on the read side (§4.4).
- **There is no `ctx.warn`.** `RenderContext` has no per-node warning
  surface; nodes `console.warn` once. A non-writable name (`index`, `z`,
  `nx/ny/nz`) makes `withPointAttr` return its input unchanged; the name
  field's red tint (attr-name-source's writable filter) is the user-facing
  signal, and a dev-only `console.warn` fires once per name.
- **`writableBuiltinPointColumn` & co. have one caller** (Attribute
  Transfer). They are replaced in M1, not kept until M5.
- **`z` is its own arity-1 storage**, not `position` lane 2; `normal` is
  arity 3 with `nx/ny/nz` lanes. Neither is writable (2D↔3D is a socket-type
  change).

## 1. Summary

Points and spline subpaths carry two kinds of per-element data stored,
named, written and propagated differently:

- **Built-ins** — position, scale, rotation, group on points; groupIndex and
  driver on subpaths. Packed typed arrays / top-level fields. The only
  per-element values the renderer consumes on its own.
- **Named channels** — `PointsValue.attributes[name]`, `SplineSubpath.attrs`,
  `SplineAnchor.attrs`. Arbitrary user data.

Reading already crosses the line (`readPointAttr` resolves `x`, `scale.x`,
`group` or any channel through one path). Writing does not:
`RESERVED_POINT_ATTR_NAMES` makes every generic writer refuse the built-in
names, so the only routes from "a number I computed" to "a scale the
renderer honors" are Point Expression or Map Attribute.

This spec makes the write side symmetric with the read side: every
attribute is addressed by name through one schema-aware API; built-ins are
channels that are required, typed, defaulted and stored in packed arrays.
Reserved-name blocking is deleted. `driver` becomes `attrs.driver`.

## 2. Motivation (09/19–09/20)

Building "concentric rings on a geometric scale ladder, cycling with time"
with built-in nodes only: Set Named Attribute `u = index` → Attribute Math
`ut = u + clock` → Attribute Math `s = ratio ^ ut` gave the right per-point
scale in a channel, and no node could apply `s` as scale. The equivalent
Point Expression is one line: `scale = Math.pow(r, index + t)`. Point
Expression already behaves as if the split did not exist, which is why it
keeps being the escape hatch.

## 3. Goals / non-goals

Goals: one name space (`scale`, `scale.x`, `x`, `rotation`, `group`,
`driver` readable and writable by any attribute node, by name, with the
same coercion Point Expression applies); attribute nodes lose their
built-in-specific enums; `driver` folded into attrs; propagation uniform;
tooling parity.

Non-goals: changing storage layout (positions/scales/rotations/groupIndices
stay packed; the schema routes to them; hot paths untouched); making
`index`, `z`, normals writable; anchor-level built-ins (width, handles).

## 4. Design

### 4.1 Point attribute schema (`points.ts`)

```ts
interface PointAttrSchema {
  name: "position" | "scale" | "rotation" | "group" | "index" | "z" | "normal";
  aliases: readonly string[];      // full-vector aliases ("sx" is a LANE alias, see below)
  arity: 1 | 2 | 3;
  default: readonly number[];      // scale [1,1]; rotation [0]; group [0]; position none
  kind: "float" | "int";           // group rounds on write
  unit: "canvas01" | "radians" | "multiplier" | "unitless" | "world";
  storage: "positions" | "scales" | "rotations" | "groupIndices" | "z" | "normals" | "derived";
  writable: boolean;               // index, z, normal: false
  required: boolean;               // position: true
  broadcastScalar: boolean;        // scale: an arity-1 write fills both lanes
}
```

Lane forms resolve everywhere a name is accepted: `<name>.<x|y|z>`,
`<name> <x|y|z>`, and the short aliases `x y` (position), `sx sy` (scale),
`nx ny nz` (normal). `z` is the arity-1 `z` schema entry. Anything not in
the table is a named channel: storage `attributes`, writable, default 0,
arity from the value.

### 4.2 Unified read/write API

```ts
readPointAttr(p, name, i)          // unchanged contract
readPointAttrVec2(p, name, i)      // unchanged contract
pointAttrExists(p, name)           // unchanged contract
pointAttrArity(p, name)            // schema arity / lane 1 / channel arity
readPointAttrColumn(p, name)       // { arity, data, color? } — count × arity interleaved
isBuiltinPointAttrName(name)
isWritablePointAttr(name)          // false for "", index, z, nx/ny/nz; true for any channel

withPointAttr(p, name, data, opts?) // opts: { arity?, mode?: "set"|"multiply"|"add", color? }
withPointAttrs(p, { name: { data, arity?, color? } }, mode?)
```

`withPointAttr` routes per schema. Coercion: an arity-1 write into a
`broadcastScalar` target fills every lane; otherwise a shorter write fills
the leading lanes and keeps the rest; a longer write is truncated; `int`
rounds; NaN / ±Inf fall back to the schema default (0 for channels). A
lane name writes one lane and keeps the others. `multiply` / `add` combine
with the current value (absent optional arrays read as their default). Non-
writable → returns `p` unchanged. Never mutates `p` (`copyPointsWith`).

### 4.3 Node changes

| Node | After |
|---|---|
| Set Named Attribute | Any name (built-ins included). `mode: set / multiply / add`. `source: exponential` (lo · (hi/lo)^t, lo=0 → linear). Spline subpaths: `group` → groupIndex, everything else → `attrs`. |
| Attribute Math | `attr_name` / `operand_attr` / `output_name` accept built-ins and lane names via `readPointAttrColumn` / `withPointAttr`. Existing ops unchanged. |
| Map Attribute | `output_name` (any writable attribute) replaces `map_target`; `mode: multiply / add / set` (multiply is the legacy scale behaviour, add the legacy rotation / position behaviour). Load migration: `scale → output_name "scale", mode multiply`; `rotation → "rotation", add`; `position x/y → "x"/"y", add`. |
| Attribute Transfer | `readPointAttrColumn` + `withPointAttr`; `group` stays nearest-only. No behaviour change. |
| Point Expression | `setattr("scale", v)` writes scale (rows the expression did not call `setattr` on keep the kernel's value). Anchor `setattr` accepts any name. |
| Stagger, Filter Points (flag), Sample Texture at Points (named attribute) | Route through `withPointAttr`; reserved check gone. |
| Collect | Already carries everything (audit). Tests only. |
| Copy to Points | Spline mode writes `attrs.driver` (legacy `sub.driver` kept for the shim window). Point mode already writes a `driver` channel. |
| Space Fill, Differential Growth, Voronoi, growth emitters | Write `attrs.driver` alongside the legacy field. |
| Rasterize / Stroke (`spline-color-source.ts`) | `by: driver` reads `attrs[cfg.attr || "driver"]` → legacy `sub.driver` → 0.5. |

### 4.4 Spline side

`SplineSubpath.driver` stays for one release as a deprecated field: every
producer writes `attrs.driver`, every consumer reads `readSubpathAttr(sub,
"driver")` which checks `attrs.driver` then the legacy field, then the
schema default 0.5 (keeping today's "missing = mid-ramp"). Subpath schema:
`group` (groupIndex, int), `driver` (float, default 0.5). Anchor attrs
unchanged. Propagators that spread `...sub` need nothing; the ones that
copy fields explicitly (trim, halfplane, accumulator, mirror, vector-kernel)
already copy `attrs`.

### 4.5 Tooling (MCP)

Done before this spec: `float_curve` set/get, spline `attrNames` /
`subpathAttrNames`. Remaining: `get_node_data` spline rows show `driver`
from `attrs.driver` too; node `facts` gotchas stop mentioning reserved
names; node-facts' well-known set derives from the schema.

## 5. Compatibility

- Saved graphs cannot contain a channel named `scale` / `x` / … (writers
  refused them), so opening `attr_name` creates no ambiguity.
- `map_target` migrates to `output_name` + `mode` in `migrateLoadedParams`.
- `driver`: shim per §4.4. Rasterize's empty `stroke_driver_attr` reading
  `attrs.driver` is behaviour-identical where only the legacy field exists.
- Point Expression `setattr("scale", …)` used to be a silent no-op.
- Performance: a built-in write is one typed-array copy, the same as
  `withBuiltinPointColumn` was. Hot consumers still read `p.scales`.

## 6. Milestones

- **M1 — Engine core.** Schema table; `readPointAttrColumn` / `withPointAttr`
  / `withPointAttrs`; delete `RESERVED_POINT_ATTR_NAMES` and the
  `*BuiltinPointColumn` family; Point Expression, Attribute Transfer,
  Stagger, Filter Points, Sample Texture routed through it; attr-name UI
  accepts writable built-ins on writers. Gate: `check-unified-attrs.mts`.
- **M2 — Point nodes.** Set Named Attribute (any name, mode, exponential),
  Attribute Math (built-in in/out), Map Attribute (`output_name` + `mode`,
  migration).
- **M3 — Spline side.** `readSubpathAttr`; driver consumers read attrs;
  producers write attrs; Collect / Copy to Points propagation tests.
- **M4 — Tooling.** Inspect `driver` from attrs; facts text; node-facts
  well-known set.
- **M5 — Cleanup (later).** Remove the `driver` field; Spreadsheet editable
  built-ins.

## 7. Open questions

- `group` under add/multiply: round after the op (implemented).
- `driver` default 0.5 (implemented; documented as the schema default).
- Position unit safety: no clamp, same as Point Expression today.
- `z` writable via an explicit promote-to-3D node: deferred.
- Anchor built-ins (width, handles): later.

## 8. Acceptance tests (`scripts/check-unified-attrs.mts`)

1. Set Named Attribute name=scale source=index lo=0.5 hi=2 → scales 0.5…2.
2. Attribute Math attr=index op=power operand=const 1.35 output=scale.
3. Attribute Math attr=u op=wrap → cyclic phase.
4. Marker attr survives Collect (points and splines) and Copy to Points spline mode.
5. Rasterize `stroke_ramp_by=driver` with Set Named Attribute target=subpaths name=driver ramps with no `stroke_driver_attr`.
6. `withPointAttr` coercion: scalar→vec2 broadcast, int round, NaN→default, lane write, non-writable no-op, no mutation, multiply/add.
7. Point Expression `setattr("scale", v)` writes scale; unwritten rows keep the kernel's value.
8. Map Attribute legacy `map_target` params migrate and render identically.
