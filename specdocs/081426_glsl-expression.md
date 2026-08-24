# GLSL Expression node

**M1 SHIPPED 08/14/26** — with these deltas from the plan below: all four
image inputs (a–d) landed in M1, not just a/b (unwired ones bind a 1×1
transparent fallback held in node state); `ctx.tryShader` landed on
RenderContext/gl.ts exactly as specced (per-key source-aware cache,
in-place replace, cached failures); channels are authored as
`// ch("name", default, min, max)` COMMENTS (GLSL-legal, and the existing
scanner/Sync machinery reads them verbatim) and surface as float uniforms
named `name`; the compile-error surface is v1-simple — console-warn once
per source with the trimmed info log, output per On error (passthrough a /
transparent) — the panel log UI and debounced recompile remain M2. The
shader body edits on the node (STRING_INPUT_PARAMS textarea) and
`check:shaders` passes with the node in the registry.

The per-pixel member of the expression family. The family picture (owner
Q&A 08/14, recorded in 081326_point-attributes.md): one expression
*language surface* per element domain — Expression (once per eval), Point
Expression (per point / per spline anchor via its Target param), and this
node for pixels, where the element count (2M+ at 1080p, per frame) makes
JS physically wrong and GLSL is the engine's native per-pixel language.
The TouchDesigner GLSL TOP, adapted to this engine's conventions.

## What it is

A node whose `source` param is a user-written GLSL 300 es fragment
snippet, compiled through the existing shader cache and drawn as one
fullscreen pass. Category `image/modifier`.

```glsl
// read: v_uv (Y-UP, the engine texture convention), u_a..u_d (wired
// images), u_res, u_time/u_frame, plus one uniform per ch() channel.
// write: fragColor (straight alpha, like every node shader).
vec4 a = texture(u_a, v_uv);
float wave = sin(v_uv.x * 40.0 + u_time * 3.0) * 0.5 + 0.5;
fragColor = vec4(a.rgb * wave, a.a);
```

The snippet is the BODY of main() in a fixed template — the node owns the
`#version`, precision, io declarations, and uniform block, so user code
can't break the contract (same philosophy as Point Expression's
prologue/epilogue: the wrapper defines the element contract, the user
writes only the middle).

## Node surface

- **Inputs**: `a`–`d` image inputs (a required, b–d optional; absent
  samplers bind the engine's 1×1 transparent black). Universal mask input
  applies as normal (evaluator-owned).
- **Channels**: reuse Point Expression's `expr_inputs` + Sync machinery
  verbatim — `ch("name", default)` scans mint scalar sliders that are
  wireable sockets, delivered as `uniform float u_ch_<name>`. `pick()`
  has no GLSL story in v1 (no string uniforms) — omit.
- **Built-in uniforms**: `u_res` (vec2 canvas px), `u_time` (sec),
  `u_frame` (float), `u_aspect` (w/h). Growing this set later is
  additive.
- **Params**: `source` (multiline string, on-node textarea via
  STRING_INPUT_PARAMS — the Expression precedent: the code IS the node),
  `on_error` (passthrough | transparent-black).
- **Output**: one `image`. (Aux mask/uv outputs are a later maybe — they
  need MRT or extra passes; not v1.)

## Compilation & errors (the load-bearing part)

- Shader key: `glsl-expr:<hash(source)>` through `ctx.getShader`'s cache —
  BUT getShader assumes valid source (compile failure today is a dev
  bug, not user input). This node needs a TRY variant:
  `ctx.tryShader(key, fs)` returning `{prog} | {error}` with the compile
  log, added to RenderContext (engine-side, small). On error: node error
  state (the `data.error` surface EffectNode already renders), output per
  `on_error`, and the GLSL compile log shown in the param panel under the
  editor (line numbers offset-corrected for the template prologue —
  report the USER's line, not the template's).
- Recompile only when `source` changes (state-cached like Point
  Expression's compile). A typing user recompiles per keystroke via the
  on-node textarea — debounce at the state layer (recompile at most every
  ~300ms, keep last good program running meanwhile) so mid-edit garbage
  never flashes the canvas.
- `stable: false` is wrong (kills caching for static shaders);
  `fingerprintExtras` folds `ctx.time` in only when the source references
  `u_time`/`u_frame` — the TIME_RE pattern, textually on the source.

## Conventions the template must own

- Y: `v_uv` is Y-UP (texture convention). The template documents it in
  its header comment; no flips — user code sees raw engine space.
- Alpha: straight, non-premultiplied in and out (the engine invariant).
  The doc page must say "do not premultiply".
- Aspect: `u_aspect` provided; nothing auto-corrected.
- Texture pool: output via ctx.allocImage + drawFullscreen — the node is
  an ordinary single-pass modifier; no persistent GL state, nothing to
  dispose beyond the compile cache entry.

## Trust boundary

GLSL is inert as an exfiltration surface (no I/O), so the risk profile is
DoS-shaped: a pathological shader can hang a GPU tick (driver resets,
watchdog kills). Accepted — the same is true of heavy-but-legit graphs.
The AI-recipe validator CANNOT compile GLSL offline (check scripts stub
GL), so `validateParams` does text-level sanity only (nonempty, mentions
`fragColor`, no `#version`/`void main` of its own — the template owns
those); real validation happens at first eval, surfaced via the error
path. `npm run check:shaders` covers the TEMPLATE (compile it with a
trivial body), not user snippets.

## Export

Engine-side node ⇒ works in exported standalone apps for free (the
export bundle copies the engine subtree; shader cache exists there).
Live-viewer control panels get the ch() channels like any exposed param.

## Milestones

- **M1**: template + tryShader + compile-error surface + a/b inputs +
  built-in uniforms + ch() scalar channels + on-node editor + docs page
  section. Ships alone.
- **M2**: c/d inputs; error-log line mapping polish; debounced recompile;
  `check-glsl-expr` script (template + a corpus of known-good bodies
  through the headless Electron GL harness, riding check:shaders'
  infrastructure).
- **M3 (maybe)**: aux `mask` output (second pass or MRT); a small
  `#include`-style helper library (noise, hsv) prepended on demand;
  image-sequence feedback (self-texture) — each its own decision, none
  assumed.

## Open questions for build time

1. Does `ctx.getShader`'s cache eviction handle high-churn keys (one per
   source hash while typing)? If not, the node keys by nodeId and
   recompiles in place instead of minting new cache entries.
2. The on-node textarea is the Expression node's; is its size adequate
   for shader code or does this node want the resized-node default
   bumped?
3. Error-log UX: panel-only, or also a red on-node badge (the EffectNode
   error surface already exists — probably free).
