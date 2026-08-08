# Point Expression node (per-point field expressions)

Spec — snapshot 2026-07-07. Owner-approved scope: **math + path sampling +
filtering** (the superset).

## Why

The engine has no per-element field/expression system. A `PointsValue` is a
struct-of-arrays (`positions/scales/rotations/groupIndices`) whose attributes
are baked at generation time; per-point *variation* today comes only from
(a) attributes baked by the producer and (b) image fields sampled at each
point's spatial UV (Modulate Points, Sample Texture at Points, Displace).

There is no way to compute a value **as a function of a point's index** and
time. The scalar Expression node (`expression.ts`) looks like the answer but
runs **once per frame**, not once per point.

This blocks the whole class of "animate N elements by f(index, time)" effects
— e.g. the reference Blender tree where glyphs flow along guide curves with a
per-point phase `fract(sample_factor_at_length(id_on_curve × glyph, curve_id)
− frame/600)`, index-hashed window starts, exponential easing, and gated Y-hop.
The points already carry an *implicit* index (array order — Copy to Points
relies on it) but nothing exposes it as an operand, and Points on Path leaves
the `groupIndices` tag slot empty so there isn't even a stored `curve_id`.

## What it is

A new node **Point Expression** (`type: "point-expression"`) that runs a small
JavaScript expression **once per point** over an incoming `points` value, with
optional access to a guide `spline` for arc-length sampling. It reads per-point
attributes + a clock + wired uniform scalars, writes back position / scale /
rotation, and can cull points. This is the general primitive the reference tree
needs; the scalar Expression node stays as-is for the once-per-frame case.

Mirrors `expression.ts` for compile/cache/error/env; reuses the `expr_inputs`
param UI (type-driven in `param-controls.tsx`) and `measureSpline`/
`sampleSplineAt` from `spline-math.ts`. Pure CPU, zero GL.

## Node shape

- `category: "point"`, `subcategory: "modifier"`, `backend: "webgl2"`
  (CPU-only, matches Set Position / Modulate Points), `stable: true`,
  `noMaskInput: true`.
- **Inputs** (`resolveInputs`): `points` (points, required) · `path` (spline,
  optional) · then the dynamic `in:<id>` **channel** sockets from the `inputs`
  param (universal coercions let image / audio collapse to a scalar). Unlike
  the scalar Expression node, these are **not** injected as bare variables —
  they're read via `ch("name")` (see Channels).
- **Params**: `inputs` (`expr_inputs`, default `[]`, `channelSync: true`) ·
  `expression` (`string`, `multiline`, default a commented starter) ·
  `on_error` (`enum` `passthrough | zero`, default `passthrough`).
- **Output**: `primaryOutput: "points"` (always).

## Expression environment

Compiled once per source string (the kernel signature is fixed —
`(__env, __pt)` — so nothing user-named enters its scope). The function is
invoked **per point**; the env globals object is built **once per frame**
(constant across points), and per-point values are injected through a single
reused mutable object (no per-point allocation).

**Read-only per point:** `index`, `count`, `groupIndex`, `px`, `py`,
`rot0` (current rotation, rad), `sx0`, `sy0` (current scale).

**Writable (initialised to current, read back after the block runs):**
`x` (=px), `y` (=py), `rot` (=rot0), `sx` (=sx0), `sy` (=sy0),
`scale` (=1, uniform multiplier), `keep` (=true).
Final scale written = `sx*scale`, `sy*scale`. A point with `keep` falsy is
dropped from the output (count shrinks — Copy to Points then instances fewer).

**Clock + math globals:** same whitelist as Expression (`t`, `time`, `frame`,
`fps`, `PI`, `TAU`, trig, `clamp`, `lerp`, `mix`, `smoothstep`, `fract`,
`mod`, …).

**Randomness:**
- `rand(seed)` → deterministic hash → [0,1), **frame-independent** (for
  index-hashed window starts / booleans; cache-stable). Uses `triple32` (flat
  on sequential integer seeds — the naïve finalizer folded the range into the
  bottom half; see fix note below).
- `random()` → mulberry32 reseeded per frame (frame-varying noise), like
  Expression.

**Channels (`ch` / `pick`) — Houdini-style tunables:**
- `ch("name", default[, min, max])` → a **slider** channel's value: its wired
  scalar, else its slider value, else the inline `default` (so the expression
  is valid *before* the control exists). `min`/`max` are optional slider bounds
  (metadata for the scanner; ignored at eval).
- `pick("name", "optA", "optB", …)` → a **dropdown** channel's selected string
  (first option is the default). Dropdowns are panel-only (no socket).
- Channels are read only through `ch()` / `pick()`; because the name is a
  **string**, it can never collide with a built-in identifier (`ch("x")` is
  fine — this is why the kernel dropped bare-variable inputs). Values flow:
  input `in:<id>` (scalar socket, label = name; omitted for enums) → the
  per-frame `channels` map (`number | string`) → `ch()`/`pick()`.
- The panel **Sync** button (shown because `inputs.channelSync` is set) scans
  the sibling `expression` (`scanChannelRefs` — string-literal regex, zero
  false positives) and mints a control per new name (`syncChannelInputs`,
  **add-only** — existing controls keep their id, wires, and value; prune with
  the row ×).
- **Rendering mirrors every other param.** Each channel row is
  `[compact name][ParamControl(synth)][×]`: the `expr_inputs` renderer
  synthesizes a `ParamDef` per channel — a `scalar` (→ the standard
  `ScalarSliderRow`) or an `enum` (→ `Dropdown`) from `pick`'s options — and
  renders it through the shared `ParamControl`. Gated on `param.channelSync`,
  so the scalar Expression node keeps its plain name+number rows. `ExprInput`
  gained optional `min/max/softMax/step/options` and `default: number | string`.
- **Range editing.** `channelDef` gives the **inferred base** range (`min 0`,
  `max ≈ 2×|default|`, adaptive `step`) — the "reset" fallback. The channel's
  explicit range (from `ch(…, min, max)` at sync, or a **right-click** on the
  slider → the standard `SliderRangeEditor`) rides on top as a `rangeOverride`
  and is stored back on the `ExprInput` via `onRangeChange` (Reset clears it →
  back to inferred). Reusing the shared editor means its diff-vs-default logic
  works unchanged; the slider top tracks the effective max (base uses hard
  `max`, not `softMax`, so an override max isn't capped).

**Path helpers** (no-ops returning safe defaults when `path` is unwired;
`measureSpline` computed once per frame):
- `pathCount()` → number of subpaths.
- `pathLen(sub?)` → arc length of subpath `sub` (normalised, anisotropic —
  matches Points on Path), or the whole concatenation if omitted. Returns 0
  with no path.
- `pathPos(factor, sub?)` → `[x,y]` at `fract(factor)` along subpath `sub`
  (implemented via `sampleSplineAt` over `offsets[sub] + fract(factor)*len`),
  or the whole spline if omitted.
- `pathX(factor, sub?)`, `pathY(factor, sub?)` → scalar conveniences.
- `pathAngle(factor, sub?)` → tangent angle (rad), for orienting to the path.

The block uses assignments, not `return` (a stray `return` early-exits and we
keep the point unchanged). It runs under `"use strict"`, so **intermediate
variables must be declared with `let`/`const`** (a bare `cid = …` throws, which
fails safe: console warn + the point passes through). The writable outputs
(`x/y/rot/sx/sy/scale/keep`) are pre-declared, so you assign them directly.
Example reproducing the reference tree over a 7-subpath guide spline, with the
tunables exposed as sliders via `ch()` (hit **Sync** to create them):

```js
const cid = floor(index / ch("slots", 40));   // curve_id
const ion = index % ch("slots", 40);          // id_on_curve
const phase = fract(ion * ch("glyph", 0.03) / pathLen(cid)
              + frame / ch("speed", 600));    // + = fly in, - = fly out
const p = pathPos(phase, cid);
x = p[0];
y = p[1] + (rand(index) > 0.5 ? 1 : 0)
         * ch("hop", 0.35) * smoothstep(0.1, 0.0, phase);
keep = rand(index) > ch("cull", 0.1);         // cull ~10%
```

Sync → sliders `slots, glyph, speed, hop, cull` (wire an LFO into any of them
to drive it). Direction is the sign of the `frame` term; in-vs-out is the
`smoothstep` window direction.

## Evaluation & caching

- `compute`: bail to empty on missing/empty `points`. Compile-on-change (source
  only). Build the `channels` map (wired scalar ?? slider default) and the env
  once. Loop points: set the reused per-point object, `fn(env, pt)`, read back
  `[x,y,sx,sy,scale,rot,keep]`, write into fresh typed arrays; collect kept
  indices; emit a `PointsValue` sized to the kept count (preserve
  `groupIndices`). Errors: park message on state, `warnOnce`, and per
  `on_error` either pass the point through unchanged or zero it.
- `fingerprintExtras`: `TIME_RE.test(source) ? "t:"+ctx.time : ""` — identical
  to Expression, so a static per-point expression caches as a constant while a
  time-dependent one recomputes each frame. Wired uniforms and an animating
  `path` already bust the fingerprint via input fingerprints. `rand()` is
  frame-independent by design, so it does **not** force per-frame recompute.
- `dispose`: drop `ctx.state[\`point-expression:${nodeId}\`]`.

## Back-compat / invariants

- New `type` string, no migration needed.
- Reuses the existing `expr_inputs` param type — no new ParamType. Adds one
  optional `ParamDef.channelSync` flag (types.ts) that renders a **Sync**
  button in the `expr_inputs` panel (param-controls.tsx); the button reads
  `allParams.expression` and calls `syncChannelInputs`. The panel `+` still
  self-serves via `onChange`.
- Engine self-containment: node imports only from `@/engine/*` (+ a re-export
  of `newExprInput`/`newExprInputId` from the sibling Expression node). ✅
  param-controls (lib) importing `syncChannelInputs` from the node mirrors its
  existing `newExprInput` import — UI-side, not engine-side.
- Filtering changes point count — documented; that's the intended Blender
  "Delete Geometry" parity.

## Milestones

1. **Node** — `src/nodes/effect/point-expression.ts`; register in
   `src/nodes/index.ts`. (This spec's core.)
2. **Verify** — manual: Points on Path (7-subpath guide) → Point Expression →
   Copy to Points; scrub the flow, confirm per-point phase + cull.
3. **Docs/devlist** — devlist entry + devguide "sharp edges" note that per-point
   field logic lives here (the one per-element expression seam).
4. **Follow-ups (not V1):** per-point vec output channel so a factor can feed a
   separate sampler; GLSL codegen for image-domain per-pixel expressions
   (shared with `062926_expression-node.md`).

## Addendum (2026-07-09): AI Recipe Generation integration

The AI generate/edit node paths (062526_ai-recipe-generation.md) can author
this node — `expression` is a settable string param, and the catalog line
carries the full env description. Three things were added to make that safe:

- **Packed-result arity guard.** Only an exact 7-tuple (what the compiled
  epilogue returns) is honored in `compute`. Previously a user/AI
  `return [x, y]` hit the array path with `raw[6]` undefined → `keep` falsy →
  **every point culled**. Now any other return shape keeps the point as-is,
  same as a non-array `return`.
- **`validateParams` (new optional NodeDefinition hook, types.ts), called by
  `validateGraph` (graph-validation.ts) as `PARAM_INVALID` errors.** This node
  compiles the expression and smoke-runs the kernel once against a dummy
  point + no-path env. Catches, at generation time, the two silent runtime
  no-ops: strict-mode ReferenceErrors (undeclared temps) and `return`-style
  blocks (non-7-tuple result). Errors feed the generate/edit repair loop.
  Never runs during evaluation.
- **Channel auto-sync at build/apply.** `expr_inputs` isn't LLM-settable, so
  `buildRecipe` / `applyRecipeEdit`'s `applyParams` run
  `syncExpressionChannels` (recipe-builder.ts, wraps `syncChannelInputs`)
  whenever a recipe/patch authored the `expression` param — the ch()/pick()
  tunables arrive as real sliders/dropdowns (and sockets) without the user
  hitting Sync. Gated on the expression actually being authored so the
  default placeholder's `ch("name", default)` comment doesn't mint junk.
- **Channels are wireable by NAME in recipes.** Channel sockets are id-based
  (`in:<exprInputId>`, stable across renames) and ids are minted at build
  time, so the LLM can't know them — instead a recipe edge/group-input may
  target the channel *name* as if it were a socket (`pe:in:speed`), and
  `resolveChannelHandle` (recipe-builder.ts) aliases it onto the real
  id-based handle. Applied in `buildRecipe` (edges + recipe `inputs`) and
  `applyRecipeEdit` (`add_edge`/`remove_edge`); the nodes-then-edges build
  order guarantees the channel exists by wiring time. Literal sockets
  (`points`, `path`) win a name collision; an unknown name passes through
  and the validator's `EDGE_UNKNOWN_INPUT` feeds the repair loop. Scalar
  (`ch`) channels only — `pick` dropdowns have no socket. The node
  description tells the model channels are name-addressable.
