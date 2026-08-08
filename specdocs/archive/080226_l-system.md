# L-System (spec, 2026-08-02)

Status: **M1+M2 implemented 2026-08-02.** Typecheck + lint + full
`npm run check` green, plus a standalone smoke test of the real compute
against a stubbed RenderContext (72 checks: all eight presets, prefix and
depth invariants, level-by-level reveal, integer and fractional
iterations, custom/malformed/empty grammars, non-drawing moves,
stochastic determinism and weighting, shape params, budgets, caching,
emission, dispose). **Needs an in-browser pass.** M3 (docs page, devlist)
outstanding. Deviation from the spec text in §6 — see §10.

Split out of
[080226_accretive-growth.md](080226_accretive-growth.md) M5 — see §1.
Shared conventions (determinism, trace-and-slice, attribute channels,
emission) are Accretive Growth §2 and are reused verbatim through
`src/engine/growth-emit.ts`.

```
type:        "l-system"
name:        "L-System"
file:        src/nodes/source/l-system.ts
category:    "spline"      subcategory: "generator"
backend:     "webgl2"
noMaskInput: true
inputs:      none
```

## 1. Why it left Accretive Growth

It was specced as that node's seventh mode. Building the other six made
the mismatch obvious: every one of them is a **stochastic spatial process
constrained by a region**, and they all genuinely use the shared socket
surface.

| | seeds | region / obstacles | field | budget |
|---|---|---|---|---|
| space_col, dla, percolation, laplacian, crack, hyphal | ✅ | ✅ | ✅ | `max_elements` |
| l_system | one origin | meaningless | tropism is a global vector, not a field | `iterations` |

An L-system does not avoid obstacles, does not respond to a field, and is
not seeded by a cloud — it executes a grammar. Its authoring surface is a
*text rule set plus a preset library*, a different interaction model from
every other mode. Shipping it there meant ~8 params visible for exactly one
mode and four dead sockets.

What is actually reusable is `growth-emit.ts` — trace format, the four
emissions, Da Vinci widths, branch ids — and a separate node gets all of
it. The duplicated per-node plumbing is ~80 lines of state and slice code.
"L-System" is also far more discoverable as a node name than as a buried
enum value.

## 2. Alphabet

Turtle interpretation, Prusinkiewicz & Lindenmayer conventions:

| symbol | meaning |
|---|---|
| `F` `G` | move forward, **drawing** a segment |
| `f` `g` | move forward without drawing (starts a disconnected subtree) |
| `+` `-` | turn left / right by `angle` |
| `\|` | turn 180° |
| `[` `]` | push / pop turtle state |
| anything else | no-op for the turtle; rewriting symbols only (`X`, `Y`, `A`, `B`, …) |

`G` draws because several classic grammars (Sierpiński) need a second
drawing symbol with its own production.

## 3. Rules

One production per line, `SYMBOL=REPLACEMENT`:

```
X=F+[[X]-X]-F[-FX]+X
F=FF
```

**Stochastic** productions use `|`-separated weighted alternatives:

```
A=0.7:F[+A] | 0.3:F[-A]
```

Weights are normalised; a bare alternative weighs 1. The choice is drawn
from the node's seeded PRNG, so it stays deterministic and export-exact.

Both `axiom` and `rules` are `string` params, so either can be exposed as
an input socket and driven by the String node (devguide § socket types) —
that is the escape hatch for grammar-authoring workflows without putting a
text editor in the param panel.

## 4. Presets

`preset` supplies the grammar; `custom` reveals the `axiom` / `rules`
fields.

A preset also carries the turn angle its grammar was designed around —
Koch and Hilbert are meaningless at 25°, Sierpiński needs 120°. A node's
compute cannot write back into params, so rather than have the preset
*silently override* sliders the user can see, a `use_preset_shape`
boolean (default on) governs `angle` / `start_angle`, and those rows
appear the moment it is turned off.

fern · bush · plant · tree · koch · hilbert · dragon · sierpinski · custom

## 5. Params

| name | type | default | notes |
|---|---|---|---|
| `preset` | enum | `fern` | §4; headerControl |
| `axiom` | string | preset | |
| `rules` | string | preset | one production per line |
| `iterations` | scalar | 5 | **fractional** — see §6 |
| `use_preset_shape` | boolean | true | preset's angle/start heading; off reveals the manual rows |
| `angle` | scalar (deg) | 25 | turn amount; `visibleIf` custom or override off |
| `angle_jitter` | 0–1 | 0 | seeded per-turn wobble; the thing that stops L-system plants looking like clip art |
| `length` | scalar | 0.04 | initial segment length, canvas-width fraction |
| `length_decay` | 0.5–1.2 | 0.9 | multiplier per depth level |
| `tropism_angle` | deg | 90 | global bend direction (gravity/light) |
| `tropism_strength` | 0–1 | 0 | |
| `origin_x` / `origin_y` | 0–1 | 0.5 / 0.92 | start position |
| `start_angle` | deg | −90 | up; same visibility as `angle` |
| `seed` | int | 0 | stochastic rules + jitter |
| `max_elements` | int | 20000 | hard budget (rewriting is exponential) |
| `progress` `emit` `id_mode` `id_groups` `tip_width` | — | — | identical to Accretive Growth |

## 6. Fractional iterations

`iterations` is a float. The string is expanded to `ceil(iterations)`
levels, and the **deepest ring of elements is retracted toward its
parents** by `frac`, so the newest growth extends smoothly rather than the
whole structure popping between integer levels.

The spec originally proposed tagging each symbol with the rewrite
generation that produced it and scaling the newest generation. That does
not work — see §10.

That makes `iterations` keyframable as a *morph* between structural
levels, which is a different animation from `progress` (a reveal of a
fixed structure). Both are available; `iterations` is the expensive one
because it changes the trace signature and therefore re-expands.

## 7. Growth order

The turtle walks depth-first, so elements are produced one branch at a
time. Revealing in that order reads as a pen drawing the plant rather than
a plant growing.

Elements are therefore **re-indexed by depth** before the trace is
finalised: sorting by `(depth, turtleOrder)` keeps `parent[i] < i` intact
(a parent is always one level shallower) while making `iter = depth`, so
`progress` grows the structure outward level by level — the same semantics
every Accretive Growth mode has.

## 8. Milestones

1. **M1 — Core.** *(done)* Rewriter with symbol/length caps,
   turtle interpreter with bracket stack, depth re-index, trace →
   `growth-emit`. Presets, integer `iterations`, angle/length/decay.
   Verify: each preset renders; `progress` grows outward by level.
2. **M2 — Character.** Stochastic productions, `angle_jitter`, tropism,
   fractional `iterations`. *(done)*
3. **M3 — Bookkeeping.** Docs page, devlist entry. *(outstanding)*

## 9. Deliberately not doing

- **No parametric L-systems** (`F(3.2)`) in v1 — a real expression
  grammar, and the numeric params cover the same ground for far less
  surface.
- **No context-sensitive productions** (`A<B>C`) in v1.
- **No region/obstacle clipping.** Growth that stops at a mask is what
  Accretive Growth is for; clipping a grammar mid-production changes
  nothing structurally and reads as an accident.

## 10. Implementation deviation — generation tags don't identify new growth

The original §6 design tagged every symbol with the rewrite level that
produced it and scaled segments from the final generation. Measuring
killed it: at `iterations` 3.5 the plant *shrank* to a quarter of its
level-3 extent instead of landing between levels.

The reason is structural. A production like `F=F[+F]F[-F]F` rewrites
**every** drawing symbol on every pass, so after the final pass every
symbol in the string carries the newest generation — and the whole plant
scales by `frac`, not just its tips. Generation marks *when a symbol was
written*, which for most interesting grammars is "just now, all of it".

Depth is the honest signal. Elements at max depth are provably leaves, so
retracting them toward their parents drags nothing with them and needs no
second turtle pass. That is what ships.
