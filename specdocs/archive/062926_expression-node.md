# Expression node — design spec (draft 2026-06-29)

A node that replaces "wire up ten Math nodes" with a single typed
expression. One polymorphic input socket, a `+` button to add more (like
Merge), and a multiline code field in the panel. Each input is bound to a
named variable; the expression is JavaScript evaluated once per frame.

Status: **design draft** — V1 is scalar-only (decided). Image-as-GLSL is a
separate follow-up spec (see §V2).

## Motivation

Complex scalar math today means a spaghetti of Math/Compare/Lerp nodes,
each doing one operation. For anything beyond a couple of steps that's
tedious to build and impossible to read. An Expression node lets you type
`radius * sin(t * speed) + offset` and be done.

## Decisions locked

- **V1 is scalar-only.** Inputs evaluate as numbers (or vec arrays); output
  is a scalar or a vec. Image inputs coerce to a scalar (level) — no
  per-pixel evaluation in V1.
- **Variables are user-named and editable**, first socket defaults to `x`,
  then `y`, `z`, `a`, `b`, … Names are self-documenting and persist with the
  socket.

## The core architectural fork (why V1 is scalar-only)

Scalar and image are two different evaluation engines:

- **Scalar** — the expression runs once per frame on the CPU. Compile the
  source string to a function once (cache on the string), run per eval.
  Cheap, safe, no GL.
- **Image** — an expression "over an image" is a *per-pixel* op. You cannot
  run JS per pixel (millions/frame). The only real path is transpiling the
  expression to GLSL and running a fullscreen shader — a mini-compiler that
  constrains the language to a GLSL-mappable math subset. That's a project
  of its own; deferred to §V2.

The socket/variable/UI model is identical for both, so V1 builds all of it
and leaves a clean seam for the GLSL backend.

## Node anatomy

- `type: "expression"`, `name: "Expression"`, `category: "utility"`
  (same bucket as Math). `backend: "webgl2"` (nominal; no GL work in V1).
- **Inputs** — driven by a new `expr_inputs` param (array, ordered). Each
  entry: `{ id: string; name: string; default?: number }`.
  - `resolveInputs(params, ctx)` emits one socket per entry, named
    `in:<id>`, labelled with the variable name. **Per-socket retyping
    mirrors `math.ts`:** the socket adopts `ctx.connectedTypes["in:<id>"]`
    when it is one of `scalar | vec2 | vec3 | vec4`; otherwise it stays
    `scalar`. (Image stays `image` and coerces to scalar at read.)
  - Default seed: one entry `{ id, name: "x" }`.
- **Params**
  - `inputs` — type `expr_inputs` (NEW param type, see §Param type). The
    `+` button and per-row name editing live in its custom ParamPanel UI.
  - `expression` — type `string`, `multiline: true` (existing param type;
    renders a textarea today — see `text.ts:701`). The code field.
  - `out_type` — `enum` of `scalar | vec2 | vec3 | vec4`, default `scalar`.
    Must be a param: `resolvePrimaryOutput` only sees params, never the
    runtime return value, so output type can't be inferred from what the
    expression returns.
- **Output** — `resolvePrimaryOutput` returns `out_type`. `primaryOutput`
  static fallback: `scalar`.

## Variable binding

For each input entry, read `inputs["in:<id>"]` and bind the variable
`<name>`:

| Connected socket type | Bound JS value                          |
|-----------------------|-----------------------------------------|
| `scalar`              | `number`                                |
| `vec2/3/4`            | `number[]` (so `x[0]`, `x[1]`, …)       |
| `image`/`mask`        | `number` via `image→scalar` coercion (level) |
| unconnected           | `entry.default ?? 0`                    |

> "Access other data along that input" (image dims, audio spectrum, cursor
> xy, etc.) is a noted **extension**: later, bind the variable to a small
> object exposing `.x/.y`, `.w/.h`, etc. Out of scope for V1 to keep the
> binding a plain number/array. Note: original image dimensions aren't
> recoverable downstream (devguide known sharp edge), so an image var could
> only ever expose canvas dims.

## Evaluation model

- **Compile**: `new Function(...varNames, GLOBALS, body)` where `body` is
  the user source. Cache the compiled function in
  `ctx.state["expression:<nodeId>"]`, keyed on the source string + the
  ordered variable-name list; recompile only when either changes.
- **Body shape**: accept either an expression (`a + b`) or statements with
  an explicit `return`. Wrap: if the trimmed source contains no `return`,
  evaluate it as `return (<source>)`; else use it verbatim.
- **Globals exposed** (curated, passed as one frozen object destructured at
  the top of the body — keeps the surface explicit):
  - Constants: `t` (seconds), `time` (alias), `frame`, `PI`, `TAU`, `E`.
  - Functions: `sin cos tan asin acos atan atan2 abs min max pow sqrt floor
    ceil round sign exp log mod` plus helpers `clamp(v,lo,hi)`,
    `lerp(a,b,t)`/`mix`, `smoothstep(e0,e1,x)`, `fract`. (No `random` in V1
    — non-deterministic, breaks caching; revisit with a seeded PRNG.)
- **Return → output coercion**:
  - `out_type = scalar`: number → `{kind:"scalar"}`. Array → take `[0]`.
  - `out_type = vecN`: array → first N components (pad missing with 0).
    number → broadcast to all N (reuse existing scalar→vec coercion
    semantics).
- **Errors**: wrap compile and per-eval in try/catch. On error, output 0
  (scalar) / zero-vec, stash the message in
  `ctx.state["expression:<nodeId>"].error`, and `console.warn` once per
  distinct message. (Inline panel error display is a milestone-3 polish —
  see §Milestones.)

## Caching / `stable`

- Default `stable: true` (like Math — pure, cache-safe).
- Flip to `stable: false` when the source references time: regex
  `/\b(t|time|frame)\b/` (and `random` if/when added). Implemented via
  `stable` being a function-of-params if supported, else a `fingerprintExtras`
  that folds `ctx.time` in only when the source is time-dependent. **Check
  whether `NodeDefinition.stable` accepts a predicate; if not, use
  `fingerprintExtras` to inject `ctx.time` conditionally.** Static
  expressions must keep caching as constants.
- Fingerprint already includes `stableStringify(params)` (the source string
  + input list) and input fingerprints, so structural changes bust the
  cache for free.

## New param type: `expr_inputs`

Follows the `merge_layers` precedent end-to-end (devguide "new node" recipe
step 5). Touch-list:

1. `src/engine/types.ts` — add `"expr_inputs"` to the `ParamType` union;
   declare the row shape `ExprInput = { id; name; default? }`.
2. `src/components/effects/ParamPanel.tsx` — custom renderer: a list of
   rows (editable name field + optional default + remove `×`) and an
   `+ Add input` button. Mints a new `{ id: newId(), name: nextFreeName() }`.
   Reuse the merge_layers row/add UI as the template.
3. `keyframes.ts` `isKeyframable` — **not** keyframable (returns false).
4. `export-manifest.ts` — no control surface (skip; it's structural).
5. Serialization — plain JSON, serializes verbatim. No media envelope.

`nextFreeName()`: walk `x, y, z, a, b, c, … w, then in1, in2…` skipping
names already in use.

## Files to create / touch

- **NEW** `src/nodes/effect/expression.ts` — the `NodeDefinition`.
- `src/nodes/index.ts` — register it.
- `src/engine/types.ts` — `expr_inputs` in `ParamType`, `ExprInput` shape.
- `src/components/effects/ParamPanel.tsx` — `expr_inputs` renderer.
- `src/engine/keyframes.ts` — `isKeyframable` false for `expr_inputs`.
- Docs page renders from the def (devguide recipe step 6) — verify.

## Invariants honored

- Engine self-containment: `expression.ts` imports only from
  `@/engine/*`. `new Function` + the globals object live in the node file
  (no `src/lib` import). ✔
- Saved-project back-compat: new `type` string + new param type, additive.
  ✔
- No texture alloc in V1 (scalar path) → no texture discipline concerns. ✔

## Decisions (resolved 2026-06-29)

1. **`new Function` sandbox — flag, defer.** The expression string travels
   with the project; in a public `/live` viewer it executes in the
   visitor's browser and `new Function` can reach page globals (`fetch`,
   etc.). Acceptable for V1 (local/personal authoring). True sandboxing
   (Worker/realm, or an AST-walking interpreter over a whitelist) is
   **required before expression-bearing projects are exported publicly** —
   tracked, not built now.
2. **Per-socket default constants — included, default value `1`.** Each
   `ExprInput` carries a `default` (the value bound when the socket is
   unwired), itself defaulting to `1`. Panel renders a small numeric field
   per row next to the name.
3. **`random()` — seeded PRNG.** Expose a deterministic `random()` (and
   `random(seed)`) backed by a per-node seeded generator so caching stays
   sound. Seeded off `nodeId` + call index; advancing only when the
   expression is time-dependent. (No `Math.random`.)

## Open questions / risks

- **`stable` as predicate vs `fingerprintExtras`** — confirm which the
  evaluator supports (see §Caching).

## Milestones

1. **Eval core + single socket.** ✅ Shipped. `expression.ts`: compile-cache
   keyed on source + ordered var names, whitelisted globals (`t`, `frame`,
   `PI`, `TAU`, Math.*, `clamp`/`lerp`/`mix`/`smoothstep`/`fract`/`step`),
   seeded `random()`, time-aware caching via `fingerprintExtras` (not
   `stable` — it's a boolean; `stable: true` + extras folds `ctx.time` in
   only when the source mentions `t`/`time`/`frame`/`random`).
2. **Dynamic sockets + variable names.** ✅ Shipped. `expr_inputs` param
   type (types.ts), ParamControl renderer (param-controls.tsx) with editable
   name + per-socket default + remove + `+ Add input`, the node-header `+`
   (EffectNode → `exprAddInput` → EffectsApp handler), per-socket defaults
   (default `1`), `resolveInputs` emitting one `scalar` socket per variable.
3. **Vec output + error surfacing.** ✅ Mostly shipped. `out_type` enum
   (scalar/vec2/vec3/vec4), array-return → vec, number → broadcast.
   Compile/runtime errors caught → output 0 + `console.warn` once per
   distinct message.
   **Remaining:**
   - **Vec _inputs_** — needs a `vec→scalar` rule for the `expression` node
     in NodeEditor `canCoerce` + `resolveInputs` retyping the socket to the
     connected vec type (so it binds as an array `x[0]`/`x[1]`). Deferred to
     avoid touching connection validity (invariant #7) in the first pass.
     Today image/scalar/mask/audio inputs work (all coerce to scalar).
   - **Inline panel error display** — surface `ctx.state.error` in the panel
     (dispatch an event like `node-timings`, show under the textarea)
     instead of console-only.

## V2 (separate spec, not now): image expressions

Transpile the expression to GLSL and run a fullscreen shader so the node
can output an `image` per-pixel. Constrains the language to a GLSL-mappable
subset (no arbitrary JS control flow; vec-aware ops). Shares this node's
socket/variable UI; adds a `mode: scalar | image` switch and a GLSL
codegen pass. Reuse the `scalar_field` AST precedent (`math.ts` field path)
where it fits SDF consumers.
