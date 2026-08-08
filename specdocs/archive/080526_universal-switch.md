# Universal Switch

Snapshot 2026-08-05. The Switch node stops being "a mux over five hand-listed
socket types" and becomes **a mux over any socket type**, adopting what you
wire into it and coercing mixed inputs to the one type they share. Plus an
on-node Index slider, because which slot is live is the thing you flip while
looking at the graph.

## Problem

`switch.ts` shipped with a fixed shortlist:

```ts
const TYPES: SocketType[] = ["scalar", "image", "vec2", "points", "spline"];
```

Everything else in the type system — `vec4` (the ask that started this),
`vec3`, `mask`, `uv`, `string`, `element`, `image_group`, `text_instance`,
`audio`, the SDF ASTs, `object3d` / `camera`, the particle descriptors — could
not be switched at all. And the type was a pure manual choice: you wired a
vec4 into a Switch that was still in `scalar` mode and the wire simply refused
to land, with no hint that a dropdown three rows down was the reason.

Two smaller bugs surfaced on the way:

- **Switch never declared `ownsTextures: false`.** A mux passes its input
  through untouched, so the textures belong to the UPSTREAM node — but the
  evaluator's default is "the node owns what it returned", so evicting a
  Switch's cache entry released a texture still owned (and still to be
  released) by its source. Reroute, the other passthrough, has always set it.
- **Mixed vec arities had no coercion.** `scalar → vecN` broadcast existed;
  `vec2 → vec4` did not, so any node with vec sockets of different arities
  needed a manual adapter.

## Decision (design Q&A)

- **Polymorphic like Reroute, but N-ary.** A new `type: "auto"` (the default)
  resolves the node's type from `connectedTypes`: one wire types every slot AND
  the output. Explicit types stay in the enum — saved projects store one, and
  pinning the family is genuinely useful — so `auto` is an addition, not a
  replacement.
- **Homogeneous slots, not per-slot types.** Every `in{i}` resolves to the SAME
  type, which is what makes autocoercion free: the evaluator already coerces
  each incoming value to its socket type before `compute` runs, so a scalar
  beside a vec4 arrives pre-broadcast. Per-slot types would make the output
  type depend on the runtime index — unsound, since downstream sockets are
  resolved statically.
- **Unify on a type that is actually present**, never an invented supertype:
  `unifySocketTypes` picks a wired type that every other wired type coerces
  INTO, preferring the richer one on ties (`{image, mask} → image`, so a mask
  widens rather than an image flattening to luminance). Note the common
  denominator can be the narrow one: `{image, scalar} → scalar`, because
  `image → scalar` is a 1×1 readback and `scalar → image` doesn't exist —
  both slots keep producing a value, which beats picking `image` and leaving
  the scalar slot dead. When nothing unifies (`spline` + `points`) the first
  wire wins and the odd one out yields nothing; there is no honest answer.
- **Vec widening, not narrowing.** `vec2→vec3/vec4`, `vec3→vec4`, padding
  `z = 0` and `w = 1` (a point's homogeneous coordinate; a colour's opaque
  alpha). Narrowing would silently drop components — a vec4 landing on a vec2
  socket is far more often a mistake than an intent. Bonus: a vec3 can now
  drive a `color` param (vec4 socket) as opaque RGB.

## Model

| Concern | Where |
| --- | --- |
| `coercible` (pure type table) | moved to `engine/graph-helpers.ts` (leaf) |
| `SWITCH_TYPE` / `SWITCH_AUTO` / `isSwitchSlot` / `unifySocketTypes` | `engine/graph-helpers.ts` |
| runtime vec widening | `engine/coerce.ts` |
| wildcard slots in the editor | `editorCanCoerce`'s new `targetParams` arg |
| socket resync on param edits | `EffectsApp`'s `polyOutTypeSig` |
| on-node Index bar | `EffectNode`'s `SCALAR_INPUT_PARAMS` + `ParamDef.maxFrom` |

**Why `coercible` moved.** Switch needs the coercion table to unify types, but
it lived in `graph-validation.ts`, which imports the registry, which imports
every node def — importing it from a node def would close a cycle.
`graph-helpers.ts` is a leaf (types only) and already hosts `REROUTE_TYPE` for
the same reason. `graph-validation.ts` re-exports it, so every existing import
site is unchanged.

**`editorCanCoerce(src, tgt, targetDefType?, targetHandle?, targetParams?)`.**
The existing polymorphic exceptions are all defType-wide; Switch's depends on a
param (its slots are wildcards only while Type is `auto` — with an explicit
type the sockets are honestly typed and the plain table already decided). The
new arg is optional and callers that omit it get the permissive answer, which
is how every other row here behaves. All five call sites (NodeEditor's
`isValidConnection`, splice input/output/detach-bridge; EffectsApp's two
wire-drop paths) now pass it.

**`polyOutTypeSig`.** `CONNECTED_TYPE_RETYPE_NODES` members are excluded from
the param-edit path's socket re-resolution (re-resolving there WITHOUT
`connectedTypes` would reset a Transform's output to `image` on every param
edit), so the edges-keyed effect owns their sockets. Switch is the first
member whose own params ALSO change its socket list — `count` mints slots —
so the effect's signature now includes the params of retype nodes. It's scoped
to that set: every other node's params churn constantly and would re-run this
for nothing.

**`ParamDef.maxFrom`.** Parallel to the existing `stepFrom`: derive a scalar
control's upper bound from the node's current params. Switch's `index` uses
`count - 1`, so the slider spans exactly the slots that exist instead of
always reaching 7. UI-only hint — the engine ignores it and `compute` clamps
regardless; the static `max` remains the fallback for contexts without sibling
params in reach (exported-app controls).

## Behaviour

- **Fresh Switch:** Type `auto`, resting type `scalar` — visually identical to
  what it was, so nothing about an empty Switch changed.
- **One wire types it:** drop a vec4 (or a camera, or a spline) on any slot and
  every slot plus the output become that type.
- **Mixed wires coerce:** scalar + vec4 → a vec4 switch, scalar broadcast to
  (s,s,s,s); mask + image → an image switch; spline + mask → a mask switch
  (the spline rasterizes to its filled silhouette).
- **`index` and the universal `mask` input never vote** on the type, and a wire
  hanging off a slot past a lowered `count` is ignored.
- **On-node slider:** the Index bar renders under the sockets (the Constant
  node's control, reused). Wire the `index` socket and it goes read-only —
  the wire outranks the stored param at eval, so the bar must not invite an
  edit the evaluator will ignore.
- **Saved projects:** a stored `type` is an explicit pin and keeps working; an
  unknown one falls back to `scalar`.

## Verified

`npx tsc --noEmit`, `npm run check` (all green), lint error count unchanged,
plus a scratch harness over `unifySocketTypes` / `resolveInputs` /
`resolvePrimaryOutput` / `editorCanCoerce` / `compute` / the new coercions
(50 assertions: unification per pair, slot resolution, count clamping, stale
wires, wildcard landing rules, index rounding/clamping, borrow semantics).
