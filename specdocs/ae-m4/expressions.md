# M4 lane 1 — the value graph as After Effects expressions

Spec: `specdocs/091926_after-effects-handoff.md` §3 rung 3, §10 M4.
Branch: `claude/ae-m4-expressions-5c2792`. Measured 2026-10-21 in After
Effects 26.5 (26.5x89), headless aerender only.

## What it does

A value graph wired into a property used to be sampled: per-frame keys at
every frame of the layer. It now compiles to **one AE expression on that
property**, live in AE. The expression is toolbox's own arithmetic,
operation for operation, and the walk only keeps it if it equals the
sampled value at every frame of the layer's window. If the compiler
refuses, or the per-frame check fails, the property gets the per-frame
keys as before, and the report says why.

Code: `src/lib/ae-export/scene/expressions/`.

- `compile.ts`: `AeBuilder`, a subclass of the Skia exporter's driver
  `Builder` (`skia-export/procedural/compile.ts`). That Builder already
  lowers Expression, LFO, Math, Scene Time, seeded Random and Constant to a
  small IR, bit-exact to the editor and gated by `check:skia-procedural`.
  The only change to the Skia file is four `export` keywords. `AeBuilder`
  adds the rest of rung 3 in the same IR: Clamp, Lerp (scalar / vec2),
  Remap (scalar), Compare, Logic, Switch (constant index), Float Curve (its
  monotone cubic unrolled per segment), Split / Combine Vec2, and the Vec2 /
  Vec3 / Color literals. It also adds frame-mode Random as AE's
  `seedRandom` and the `exprLeaf` hook. Keyed params inside the graph are
  refused rather than inlined.
- `emit.ts`: the IR as AE JavaScript. It writes plain `var` / `function`
  code with every operator parenthesised and numbers in shortest
  round-trip form. Each helper is the engine's own code (hash01,
  mulberry32, the easings, the curve evaluator, the env helpers). The tick
  comes from `time`.
- `index.ts`: what the walk calls.
  - `exprProp(ctx, clock, spec)` takes the params an AE property reads, how
    they become AE units (IR), and the site's own sampler. It compiles,
    checks every frame with the IR interpreter, emits the text, and reports.
  - `exprLeaf` is the hook for knobs.
  - `finalizeExpressionProps` runs once the scene is built. Inside the walk
    a compiled prop is a one-key prop, so every `"v" in p` check treats it
    as animated; this pass rewrites each one to `{ v, expression }`, so the
    AE project has no stray keyframe.

Wired into every place that sampled a driver:

| site | file | AE property |
|---|---|---|
| `scalarProp` | scene/context.ts | any scalar prop (radius, trim, stroke width, rotation, opacity …) |
| `pairProp` | scene/context.ts | 2-D props, spatial positions included |
| `colorProp` | scene/context.ts | color `[r, g, b, 1]` + its opacity from the alpha channel |
| `nodeTransform` | scene/trs.ts | Transform / Gizmo / image / layer TRS. Each AE prop that reads a wired param is an expression; the others still convert as tracks. |
| `mapParam` | scene/effects.ts | effect params through the calibration map's `linear` rule, checked against the map itself |
| `productOpacity`, Gradient Ramp points | scene/effects.ts | opacity × alpha, Start / End of Ramp |
| TBX Shader sliders | scene/shader.ts | a fused node's wired channel |

`scaleProp` (and the opacity products that used to rebuild keys inline) now
scale a compiled expression too.

The new policy `drivers: "expression" | "keys"` defaults to "expression".
"keys" brings back the old sampling everywhere. It's wired through
`types.ts`, `vetAePolicy` and the MCP policy schema. The gate also builds
its oracle with it.

A value graph that is constant over the layer becomes a static value, not
an expression.

### Clocks

The expression computes the toolbox tick the sampler used:
`tick = time · fps · 1000`, snapped to the integer within 1e-6 (the Skia
runtime's `ticksAt`), minus `WalkClock.offsetTicks`.

- A layer in the main comp with a clip window subtracts its offset.
- Inside a precomp the offset is 0, because `time` is already the precomp's.
- Sub-frame times (motion blur) give a fractional tick, so the clock
  interpolates.

The gate checks frame-aligned values on an offset layer (`- 10000`) and on
a two-run precomp. AE agrees on both.

### Random

The brief said `seedRandom` + `random()` (spec §3: "different noise, same
statistics"). Seeded mode, the default, can do better. Its noise is
`hash01(seed, frame, salt)`, pure integer `Math.imul` arithmetic, and that
runs unchanged in AE's ES2018 engine. So seeded Random exports **the
editor's own numbers**: bit-identical at every frame in AE, and reported
exact.

Frame mode calls `Math.random()` on every evaluation in the editor, so no
export can repeat it. That is where `seedRandom(<hash of the node id>,
false); random()` goes, through the node's own lo / hi / Box-Muller
arithmetic. It gives the same distribution with other numbers, stable
across AE renders, and is reported approx. The Expression node's `random()`
is its seeded mulberry32 (node id × frame), also exact.

## What stays sampled, and why

| kept per-frame | why |
|---|---|
| Smooth, Accumulator, Sample & Hold, Trigger Envelope | They depend on frame history. An AE expression would need `valueAtTime` recursion over the whole history. |
| Audio Bands / Pitch, audio coercions | They come from an offline analysis of the mixdown, which has no expression form. |
| any non-value node in the closure (geometry, points, images, Bounding Box, Sample Along Path, Animated Value …) | The compiler only takes rung-3 value nodes. Animated Value and the along-path drivers are candidates for later. |
| a param **keyed inside the driver graph** | Toolbox's eases have no inline AE form yet. Slider Control keys plus an expression that reads them would fix it. |
| an AE property that also reads a **keyed** param of its own (e.g. translate keyed, pivot wired) | One AE property can't hold both keys and a live graph. |
| Switch with a wired index, or an index that picks an empty slot | An empty pick outputs nothing, and the consumer then falls back to its param. |
| Math in uv mode, Remap in image mode, a scalar_field input | These are per-pixel shaders, not values. |
| Expression: `Math.random()`, strings, objects, assignment, loops, unknown names, `out_type: curve`, a wired / keyed source | These are outside the parsed math subset, or can't be repeated. |
| effect params whose calibration map has no `linear` rule, and derived (multi-param) effect props | The map is arbitrary TypeScript. |
| a local-space pivot over an animated bounding box | The box is geometry. |
| Random frame mode, under `drivers: "keys"` | It is sampled as before. |

Each refusal is a reason string that lands in the report, both on the
consumer ("… → per-frame keys (reason)") and on every node of the graph.

## Verification

### Offline: `npx tsx scripts/check-ae-export.mts expressions`

The corpus is `scripts/fixtures/ae-export/graphs/expressions-corpus.mts`:
130 cases, each in its own layer with one consumer.

- Constant (float / integer).
- Math: all 41 operations, half of them clamped. A and B are ramps that
  cross 0 exactly.
- Clamp (swapped and wired bounds), Lerp scalar / clamped / vec2, Remap
  (normal, clamped, inverted range), Compare (6 ops), Logic (4 ops).
- Switch (index 0, 1, clamped, rounded, vec2 auto type).
- Float Curve (with flat and zero-width segments, and the default curve).
- LFO (4 shapes, wired clock in seconds / frames, wired frequency).
- Scene Time (2 units × 4 modes, and 15 easings including custom with
  intensity 0.5 / 1 / 1.5).
- Random (seeded uniform / gauss / vec2, frame uniform / gauss).
- Split / Combine.
- 12 Expression sources covering every env global, `random()`, `?:`,
  `**`, and vec2 / vec4 outputs.
- Consumers: Transform TRS, blur radius, solid alpha, Gradient Ramp
  point.
- Clocks: offset layer, precomp.
- Refusals: Smooth, keyed-in-closure, empty and wired Switch,
  `Math.random()`, an unknown name, strings, uv-mode Math, an image input.

The gate builds the corpus twice, with `drivers: "expression"` and with
`"keys"`. It runs each of the 125 compiled expressions in `node:vm` with
an AE shim (`time`, `thisComp`, `seedRandom` / `random`, `linear` /
`ease`, vector math). At each of 7330 frames the result must equal the
sampled key, and sub-frame times must give numbers. Facts: the offset
and precomp clocks, seeded Random reported exact, frame Random as
`seedRandom(…, false)`, Expression `random()` as mulberry32, a wired
Transform compiling only position and rotation, a static graph exporting
as a static value, and a wired TBX Shader channel equal to its slider
keys.

`p-expressions` (fixtures.mts, 24 cases, 26 expressions) is the corpus
subset snapshotted by `check-scene-snapshots`. The only existing snapshot
that moved is `l-driver`, on purpose: its LFO-driven radius is now one
expression, and `check-scene-facts` holds that and the old 60 keys under
`drivers: "keys"`.

### Live: `npx tsx scripts/fixtures/ae-export/graphs/expressions-roundtrip.mts`

Both scenes, `p-expressions` and the whole corpus, are built by `build.jsx`
in **one** headless aerender launch (`calibrate/ae.mts runAeJob`, the
one-launch Startup hook, under the shared AE lock; the GUI was never
contacted). The job then reads every compiled property back with
`valueAtTime(t, false)` at every frame
(`calibrate/expressions.jsx`), as `toPrecision(17)` text. Each AE value
is compared with toolbox's sampled key, and with the same text run under
node's V8. The per-case summary is in
`scripts/ae-export-spike/calibrate/measured/expressions.json`
(`--record`).

| package | compiled props | frames compared | bit-identical | worst \|AE − toolbox\| (relative) | expression errors |
|---|---|---|---|---|---|
| p-expressions (24 cases) | 26 | 1450 | 1441 | 3.4e-16 | 0 |
| corpus (123 cases that compile; the other 7 must stay sampled) | 125 | 7330 | 7312 | 3.4e-16 | 0 |
| …of which frame-mode Random (3 props in all) | 3 | 180 | — (AE's own draws) | in range on every frame | 0 |

Frames compared exclude frame-mode Random.

One aerender launch built and read both packages: 11.1 s when the lock was
free (builds 0.44 s + 1.69 s, reads 0.14 s + 0.69 s). Later runs waited
up to ~3 min for other lanes' AE jobs first.

Findings:

- **No expression errors.** AE 26.5's JavaScript engine accepts every
  compiled text: `expressionError` is empty and the expression stays
  enabled on all 151 properties.
- **Bit-identical, apart from the last bit of a few transcendentals.**
  The job encodes each double exactly as sign, exponent and two 26-bit
  mantissa halves. That was needed because ExtendScript prints numbers to
  15 significant digits, and `toPrecision(17)` isn't exact either: both
  showed a false ~5e-15 gap on the first runs.
  - 7312 of 7330 corpus frames are the same double toolbox samples.
  - The other 18 frames differ by 1–2 ulp (≤ 3.4e-16 relative). All of
    them are in cases that call `Math.sin` / `cos` (math-sine 1,
    math-cosine 2, the LFOs on a wired clock 2–3, lerp-vec2 1,
    consumer-alpha 1, consumer-trs 2), `pow` / `cbrt` / `log2` (expr-pow 1),
    or `log` / `sqrt` / `cos` (seeded gauss Random 2).
  - AE's expression engine therefore rounds an occasional transcendental's
    last bit differently from Node's V8. Toolbox and Node agree exactly
    (check-expressions). Every arithmetic-only case is bit-identical,
    including the integer hashes (`Math.imul`) of seeded Random and
    `random()`.
- **Random:** seeded is the editor's numbers (above). Frame mode stays
  inside its range on every frame (uniform [−10, 30]; gauss: finite and
  varying). Its numbers are AE's own, as designed.
- **The Expression node's Math** (`sin`, `pow`, `cbrt`, `log2`, `hypot`,
  `atan2`, `**`, `Math.max` …): the same as the Math node. The env helpers
  and operators are exact. Only `sin` / `pow`-class calls can differ, by
  an ulp.
- **Unrelated to this lane, for the integrator:** every build on this Mac
  logs the problem `project bitsPerChannel: … Unable to set
  "bitsPerChannel". Value is 16. Not supported for OCIO color managed
  mode.` (build.jsx line 508). The startup project in this AE install is in
  OCIO color-managed mode. `build.jsx` still builds and saves, but the
  project keeps its own bit depth. run.mts's "no build problems" check
  would flag it.

## Not verified

- **Rendered pixels** of the expressions. This lane read property values,
  not frames. The values are what AE renders from, and the `l-driver`
  pixel probes in `roundtrip.mts` still cover one radius. A pixel run of
  `p-expressions` is open: it has no probes yet, because the 24 layers sit
  on top of one another.
- **Motion-blur sub-frame values in AE.** Only Node evaluated them, giving
  finite numbers; AE was sampled at frame times only.
- **The editor UI.** No modal control for `drivers` was added. The policy
  is reachable through MCP / `plan_ae_export` / `export_ae_package`, and
  verified by typecheck and the gates; the editor needs sign-in.
- **Exposed knobs → Essential Properties** (lane 6). `exprLeaf(ctx,
  nodeId, param, value)` in `scene/expressions/index.ts` returns `{ value
  }` today. Returning `{ value, code }` makes the expression read `code`
  live, while the per-frame check keeps running on `value`.
  check-expressions covers that path with a stand-in `code`; no real
  Essential Property has been linked in AE yet.
- Text props driven by a value graph go through `scalarProp` / `pairProp`
  in `text.ts` (lane 2's file) and compile. `text.ts`'s own
  "pivot and translate both animate" branch, and its opacity × fill-alpha
  product, still sample or drop the product as before. Neither was touched.

## Follow-ups

- Keyed params inside a driver graph: put the keys on a Slider Control and
  have the expression read the slider, keeping them editable keys.
- Animated Value (a keyed value on a wired clock) → `valueAtTime`.
- `sample-along-path` / `points-on-path` → `pointOnPath()` (spec §3).
- The plan (`plan.ts` expression items) still estimates `sampled` from the
  class table. It could run the compiler for an exact count. It also misses
  an Expression node's variable inputs from its closure; the walk reports
  them correctly.
