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
  optional) · then the dynamic `in:<id>` named-scalar sockets from the
  `inputs` param, exactly like Expression (universal coercions let image /
  audio collapse to a scalar).
- **Params**: `inputs` (`expr_inputs`, default `[]`) · `expression`
  (`string`, `multiline`, default a commented starter) · `on_error`
  (`enum` `passthrough | zero`, default `passthrough`) — optional, see below.
- **Output**: `primaryOutput: "points"` (always).

## Expression environment

Compiled once per (source + ordered named-var names), like Expression. The
function is invoked **per point**; the env globals object is built **once per
frame** (constant across points), and per-point values are injected through a
single reused mutable object (no per-point allocation).

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
  index-hashed window starts / booleans; cache-stable).
- `random()` → mulberry32 reseeded per frame (frame-varying noise), like
  Expression.

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
keep the point unchanged). It runs under `"use strict"` — same as the scalar
Expression node — so **intermediate variables must be declared with `let`/
`const`** (a bare `cid = …` throws, which fails safe: console warn + the point
passes through). The writable outputs (`x/y/rot/sx/sy/scale/keep`) are
pre-declared, so you assign them directly. Example reproducing the reference
tree over a 7-subpath guide spline (`slots` wired as a named input):

```js
const cid = floor(index / slots);   // curve_id
const ion = index % slots;          // id_on_curve
const phase = fract(ion * 0.03 / pathLen(cid) - frame / 600);
const p = pathPos(phase, cid);
x = p[0];
y = p[1] + (rand(index) > 0.5 ? 1 : 0) * 0.35 * smoothstep(0.0, 0.1, phase);
keep = rand(index + 1000) > 0.1;    // cull ~10%
```

## Evaluation & caching

- `compute`: bail to empty on missing/empty `points`. Compile-on-change.
  Build env once. Loop points: set the reused per-point object, `fn(...named,
  env, pt)`, read back `[x,y,sx,sy,scale,rot,keep]`, write into fresh typed
  arrays; collect kept indices; emit a `PointsValue` sized to the kept count
  (preserve `groupIndices`). Errors: park message on state, `warnOnce`, and
  per `on_error` either pass the point through unchanged or zero it.
- `fingerprintExtras`: `TIME_RE.test(source) ? "t:"+ctx.time : ""` — identical
  to Expression, so a static per-point expression caches as a constant while a
  time-dependent one recomputes each frame. Wired uniforms and an animating
  `path` already bust the fingerprint via input fingerprints. `rand()` is
  frame-independent by design, so it does **not** force per-frame recompute.
- `dispose`: drop `ctx.state[\`point-expression:${nodeId}\`]`.

## Back-compat / invariants

- New `type` string, no migration needed.
- Reuses existing `expr_inputs` param type + `newExprInput` — no new ParamType,
  no ParamPanel work, no `effect-node-toggle` changes (the panel `+` in
  `param-controls.tsx` self-serves; the node-header `+` `exprAddInput` path in
  EffectsApp already keys off `params.inputs` generically — verify it fires for
  this def or add the header `+` only if wanted).
- Engine self-containment: node imports only from `@/engine/*`. ✅
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
