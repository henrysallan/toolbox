# Graph → GLSL: fusing an image subgraph into one GLSL Expression node

Spec — 2026-09-16. Status: **M0, M1, M2 built; M3 started 2026-09-18** (see
§Milestones and §Decisions taken). Offline gates green and the three gold
node docs compile through `check:shaders`; the live editor run (noise-floor
calibration, the three fixture graphs driven end to end) has NOT happened
yet — no editor was paired during the build. M3's bulk authoring pass and
M4 reach not started.

"Convert this graph to GLSL" should be one request. The agent reads the
graph, works out which upstream nodes can be fused, pulls the translation
guidance for exactly those node types, looks at the original over time,
writes the shader, inserts a `glsl-expression` node beside the originals,
and then iterates on code and channels against a numeric diff of the two
renders until they match. This doc says what has to exist for that loop to
run reliably in **both** agent hosts — Claude Desktop / Claude Code over
`scripts/mcp-server.mjs`, and the in-app assistant panel over
`scripts/agent-host.mjs` — and what the agent is told to do with it.

## Why

- **One pass instead of N.** A noise → color ramp → displace → mirror chain
  is four fullscreen passes and four pooled RGBA16F textures per frame; the
  same math in one `glsl-expression` is one pass and no intermediates. For
  the pure per-pixel part of a graph this is the cheapest thing the engine
  can run, and it is also what a user copies out to Shadertoy, TouchDesigner,
  or a hand-written exported app.
- **The engine already fuses in two places, by hand.** `compileSdf`
  (`src/engine/sdf-compile.ts`) turns a whole SDF / position / scalar-field
  subgraph into one fragment shader; `fusedMergeFs` (`src/nodes/effect/merge.ts`)
  fuses a Merge layer stack. Both prove that fusion is idiomatic here; neither
  helps the 60-odd other image nodes.
- **Agents write GLSL well and this engine's conventions badly.** The failure
  modes are known and repeat: `v_uv` is Y-up while every point/spline node is
  Y-down canvas01 (`Y_ORIENT_DOC`, `src/engine/node-catalog.ts:172`); geometry
  is width-relative with y scaled about 0.5 by W/H (`aspectCorrectY`,
  `src/engine/aspect.ts`); alpha is straight, never premultiplied
  (`081426_glsl-expression.md`); targets are RGBA16F so values run past 1;
  ramps interpolate in a chosen color space (`091626_ramp-space-interp.md`);
  mask and opacity are evaluator post-passes a node never implements
  (`src/engine/conventions.ts`). Today the only way to learn any of this is to
  read five node files through `get_node_source`.
- **The in-app panel cannot read files.** `agent-host.mjs` removes `Skill`,
  `Bash`, `Glob`, `Grep`, and gates `Read` to spill files
  (`scripts/agent-host.mjs:82-97`, panel spec Decision 10). A `.claude/skills/`
  reference doc is invisible there. Whatever guidance the translation needs
  has to arrive through a **tool**, or the panel gets a worse translator than
  Desktop — the exact asymmetry the panel spec set out to remove.

## What exists and is reused

| Need | Have | Where |
|---|---|---|
| Fused-shader target | `glsl-expression`: owns the template, 4 image inputs `u_a..u_d`, `u_res/u_time/u_frame/u_aspect`, channel comments → uniforms, hoisted helpers, `tryShader` with cached failures | `src/nodes/effect/glsl-expression.ts:395-413` (template), `:123-162` (channel decls) |
| Compile errors as data | `get_shader_errors`, `shaderError` + `shaderPreludeLines` on `get_graph` / `screenshot` | `mcp-handlers.ts:1314` |
| Frames over time in one image | `screenshot_strip` (2–12 labelled cells, `nodeId` peek, `frames` or `start/end/every`) | `mcp-handlers.ts:507` |
| Render a specific node's output deterministically | `forcedTerminalRef` / `forcedTerminalHandleRef` + `renderFrame` | `mcp-handlers.ts:452-502` |
| CPU pixels of an `ImageValue` | `readImagePixels` (FBO + readPixels, RGBA8, pooled) | `src/engine/gl.ts:332-360` |
| Per-node operational facts, incl. `reads: ["time"]` and `simulation` / `unstable` flags | NodeFacts + `catalogFlags` | `090626_node-facts.md`, `node-catalog.ts:181` |
| Insert + wire + tune without a new tool | `edit_group` add_node / add_edge / set_param, `tidy` | `toolbox-tool-defs.mjs` |
| Tools shared by both hosts | `BRIDGED_TOOLS` + `marshalResult` (`text` / `image` / `strip`) | `scripts/toolbox-tool-defs.mjs` |
| Headless GLSL compile gate | `emit-shaders.mts` → `check-shaders.cjs` (Electron GL) | `npm run check:shaders` |
| The choreography precedent | `blender-to-toolbox` skill: orient → extract → choose target → translate → build → **look** → report honestly | `.claude/skills/blender-to-toolbox/SKILL.md` |

What does not exist: any per-node statement of *how* a node translates to
GLSL, any machine-readable notion of *which* nodes can, a way to render two
nodes side by side with a number attached, and a doc channel that reaches
the panel.

## Design

Four pieces. Three are new bridged tools (so both hosts get them from the
shared defs); one is a docs tree bundled into the editor so the tools can
serve it.

```
                 ┌─ plan_glsl_translation ─┐   walks upstream, classifies, cuts,
   get_graph ──▶ │  (read-only, editor)    │─▶ proposes frames, lists doc slugs,
                 └─────────────────────────┘   emits an edit_group skeleton
                                │
                 ┌─ get_glsl_docs ─────────┐   conventions + fusion + parity docs,
                 │  (read-only, editor)    │─▶ plus one doc per node type in the plan
                 └─────────────────────────┘
                                │
      agent writes GLSL ─▶ edit_group add_node(glsl-expression) + add_edge ─▶ get_shader_errors
                                │
                 ┌─ compare_renders ───────┐   A | B | diff grid per frame + metrics
                 │  (read-only, editor)    │─▶ (mean/p95 abs error, alpha error,
                 └─────────────────────────┘    worst region) — the parity oracle
                                │
                     adjust code / channels, repeat; stop on threshold / cap / no progress
```

### 1. Translation classes — the data the plan tool runs on

`src/lib/glsl-translation/classes.ts`: one entry per visible image-producing
node type (66 defs carry `category: "image"` today; `check-glsl-translation`
fails when a visible one is missing, the `check-node-facts` pattern).

```ts
type TranslationClass =
  | "pure"       // f(uv, params, inputs sampled at the SAME uv). Fuses by composition.
  | "gather"     // samples its inputs at OTHER uvs (displace 1 tap, blur N taps,
                 // kuwahara, edge-detect). Fuses if the input is a function or a wired u_.
  | "multipass"  // separable / pyramid / iterative (bloom, JFA, reaction-diffusion steps).
                 // One-pass form is an approximation the doc must state.
  | "compiled"   // the engine already emits GLSL for it (sdf-rasterize + its sdf /
                 // position / scalar_field upstream; Merge stacks). Hand the agent
                 // the generated source with uniform values inlined.
  | "stateful"   // accumulator, trails, time-offset, simulations, video/webcam,
                 // particles: no feedback texture in glsl-expression (081426 M3 unbuilt).
  | "opaque";    // CPU / geometry / 3D / ML: rasterize-spline, text, scene-render,
                 // trackers, bg-remove. Never fused; becomes a wired input.

interface TranslationEntry {
  class: TranslationClass;
  doc?: string;            // slug under docs/nodes/, required for pure|gather|multipass
  taps?: number | "param"; // gather cost hint (blur: "param" → radius-driven)
  time?: boolean;          // reads the clock even when facts.reads omits it
}
```

The table is **lib-level, not engine-level**. Docs and translation classes
are agent guidance; the engine must not import them (devguide invariant #1 —
the engine subtree ships verbatim into exported apps). `facts` stayed on
`NodeDefinition` because the catalog renders it; nothing in the app renders
this, so it does not belong there.

### 2. `plan_glsl_translation` — read-only, `resultKind: "text"`

Input: `{ target: nodeRef, scope?: string, maxInputs?: 1–4 }`. `target` is
the node whose output should be reproduced (the selected node, or the node
wired into the scope's Output — the tool resolves "the thing you're looking
at" from `get_status` when omitted).

Pure function `planTranslation(nodes, edges, target, classes)` in
`src/lib/glsl-translation/plan.ts`, tested offline. It walks upstream from
`target` and:

1. **Classifies** every node reached, from the table (unknown type ⇒
   `opaque` with a warning, never a guess).
2. **Cuts.** The fusable region is the connected set of `pure` / `gather` /
   `multipass` / `compiled` nodes ending at `target`. Every wire crossing into
   that region from a `stateful` / `opaque` node — or from an `image` /
   `mask` / `uv` socket whose producer is outside the region — is a
   **frontier input**. Frontier inputs are assigned to `u_a..u_d` in
   topological order. A wired universal `mask` on an interior node is a
   frontier input too (the fused node inherits mask/opacity only for its own
   output; interior mattes must be fused explicitly).
3. **Shrinks when the cap is hit.** More than 4 frontier inputs (or
   `maxInputs`) ⇒ drop the cheapest-to-exclude upstream node from the
   region (the one whose exclusion removes the most frontier wires) and
   retry; the dropped node becomes a frontier input. The result names what
   was excluded and why. Chaining two GLSL nodes is M4.
4. **Estimates cost.** Composition through a `gather` multiplies upstream
   evaluations by its tap count; a gather of a gather (blur of a displace of
   noise) is flagged with the product so the agent can decide to keep the
   upstream as a separate node instead of fusing it.
5. **Decides time dependence** from `facts.reads` containing `"time"`,
   `catalogFlags` `simulation`, keyframed params in the region, and the
   table's `time` override. Static graphs get one frame; animated ones get a
   proposed frame list: keyframe frames in the region, plus even spacing to
   fill 4–8 cells, capped by the loop length from `get_status`.
6. **Collects the numbers the shader needs**: non-default params per node
   (the same data `get_graph` prints), keyframed params (these should become
   channels driven by re-created tracks or by a wired scalar), the canvas
   size / aspect, fps and loop length.
7. **Emits an `edit_group` skeleton**: `add_node` of `glsl-expression` with
   `parent`/scope matching `target`, one `add_edge` per frontier input into
   `a..d`, `rename_node` to `"<target name> (GLSL)"`, and **no** edge into the
   Output — the node lands beside the originals, unwired downstream, so the
   user's render never changes until they (or a later explicit step) swap it.
8. **Lists doc slugs**: `conventions`, `fusion`, `parity`, plus one per
   distinct node type in the region, plus `source:` hints (which exported
   `*_FS` constant to fetch via `get_node_source` for nodes whose doc says
   "port the shader branch for param X").

Output is JSON: `{ region, frontier: [{socket:"a", from:"<id>:out", type}],
excluded: [{id, type, class, reason}], order: [...], nodes: [{id, type,
class, params, keyframed, doc}], time: {dependent, frames}, cost:
{evaluationsPerPixel, warnings}, skeleton: {groupId, ops}, docs: [slugs] }`.
When the region is empty (target is `opaque` or `stateful`) the result is a
plain refusal with the reason; the agent is told to relay it, not to
improvise.

The `compiled` class has a fast path: for an `sdf-rasterize` region the tool
calls `compileSdf` on the live AST and returns the generated fragment body
with uniform values substituted, ready to paste into the GLSL Expression
template (the `p` / `v_uv` conventions match — the SDF compiler already
targets this engine). This is the one place translation is exact by
construction.

### 3. `get_glsl_docs` — read-only, `resultKind: "text"`

Input: `{ slugs?: string[], types?: string[] }`. `types` resolves through
the class table; `conventions` is always prepended unless `slugs` explicitly
omits it. Returns concatenated markdown with a `## <slug>` header per doc and
a trailing line listing slugs that do not exist. Per-call size is capped
(~40k chars — under the spill threshold the panel spec measured) and the
result says which slugs were cut so the agent asks again.

Docs live in `src/lib/glsl-translation/docs/` as markdown and are **bundled
into the editor** (webpack `asset/source` rule in `next.config.ts`; TS
template literals as the fallback if the loader fights Next 16). Bundling,
rather than reading the checkout, is deliberate:

- Both hosts speak bridged tools; only the Desktop lane has source tools,
  and `mcp-source.mjs` scopes those to `src/nodes` + `src/engine`
  (`SCOPE_DIRS`). Widening the scope helps one host.
- The docs describe the **running** editor's nodes. Serving them from the
  same bundle removes the version-skew problem `mcp-source.mjs` has to
  solve with GitHub-tag fallbacks.
- Exported apps do not ship `src/lib` UI code, so the bundle cost lands on
  the editor only.

Doc set:

| slug | Content |
|---|---|
| `conventions` | The template contract verbatim from `glsl-expression.ts` (what `u_*`, `v_uv`, `fragColor` are); Y: `v_uv` Y-up vs canvas01 Y-down and the exact `aspectCorrectY` mapping for anything positioned in geometry space; straight alpha; RGBA16F range (do not clamp unless the node did); mask and opacity are evaluator-owned — do not re-implement for the fused node's own output, DO fuse interior mattes; channel grammar and seeding (`// ch("k", <current value>, min, max)` etc., `u_` reserved, no `__`, 12-LUT cap); the 4-input cap; time: `u_time` seconds, `u_frame`, fps/loop from `get_status`, how looping nodes (Perlin `loopEvolution*`) close the loop. |
| `fusion` | The composition pattern: one `vec4 node_<id>(vec2 uv)` helper per fused node, hoisted; frontier inputs sampled as `texture(u_a, uv)`; inverse-sampling operators (transform, mirror, polar, displace) compute `uv'` and call upstream at `uv'`; N-tap gathers loop over upstream calls; fixed-tap approximations for separable blur and when to leave a blur as its own node instead; keeping the original param names as channels so the two sides stay comparable knob for knob. |
| `parity` | Reading `compare_renders`: what mean/p95/alpha numbers mean at the calibrated noise floor, and the ranked list of usual causes — Y flip (mirror-image diff), aspect (stretched diff), premultiplied alpha (dark fringes), ramp interpolation space and `color-space.ts` transforms (banding along gradients), missing clamp/wrap mode at edges, dithering/noise seeds (uniform speckle — expected, not a bug), gather tap count (soft halo). |
| `nodes/<type>` | One per `pure` / `gather` / `multipass` type: class; param → GLSL table with unit conversions (degrees→radians, canvas01→uv, width-relative radii → `× u_aspect` where the node does it); sampling structure (taps, wrap modes); an **idiomatic fused snippet** in a ```` ```glsl-body ```` fence written against the template (compiled by the shader gate, below); gotchas that bite in translation specifically; `source:` pointer to the exported shader constant and which branch (Perlin Noise has 11 algorithms — port the one `type` selects, not all). |

Docs do not duplicate the node shader. The shader is reachable through
`get_node_source` and changes with the node; the doc says how to *use* it.

### 4. `compare_renders` — read-only, new `resultKind: "compare"` (image + text)

Input: `{ a: nodeRef, b: nodeRef, frames?: number[], maxSize?, threshold? }`
(`nodeRef` grammar as `screenshot`: bare id, `:out`, `:aux:<name>`). For each
frame (2–8): force-render `a`, force-render `b`, read both back through
`readImagePixels` at a fixed analysis size (256 long edge — the metrics are
for convergence, not for pixel-exactness at 4K), compute per-frame metrics,
and tile `A | B | |A−B| heat` per row into one labelled grid built exactly
like `screenshot_strip`'s canvas. Restore the user's playhead afterwards.

Metrics per frame: mean and p95 absolute RGB error (straight-alpha RGB, so
transparent regions do not hide colour errors — compared on RGB where both
alphas exceed a floor, plus a separate alpha error), fraction of pixels over
`threshold`, and the bounding box of the worst 5% region in uv so the agent
can say "the top-left corner is wrong" without measuring the image. The
text block carries the numbers and a verdict line per frame
(`match` / `close` / `off`) against calibrated thresholds; the image is for
the agent's eyes. `readImagePixels` returns RGBA8, so the comparison floor
is 1/255 per channel plus float16 rounding — M0 measures the floor on
identical nodes and sets the default `threshold` above it.

`marshalResult` grows a `compare` branch: one image block plus the metrics
text (`toolbox-tool-defs.mjs:668`). `check-mcp` gets a case that a compare
result crosses the hub/proxy hop as image + text, like the strip case.

### Why three new tools and not choreography

The panel spec closed the tool surface (Decision 6: "new tools require
evidence from a real loop failure, not anticipation"). Each of these clears
that bar differently:

- `get_glsl_docs`: the panel **cannot** read a doc any other way. Not a
  convenience.
- `plan_glsl_translation`: the walk-classify-cut could be done agent-side
  from `get_graph` + `get_catalog`, but it needs the class table (data that
  lives in the repo, so it needs a tool anyway) and it is the step where a
  wrong guess wastes the whole translation — the blender skill's §"choose
  the target pipeline" lesson. Deterministic code beats prose here.
- `compare_renders`: two `screenshot` calls put the images in different
  tool results with no alignment and no number. The agent panel spec's own
  principle — "prefer numbers over pixels for numeric work" — applies to
  parity more than to anything else in the app.

Insertion, wiring, tuning, compile checking, and looking over time are all
existing tools, and the plan tool hands back a ready `edit_group` batch so
the agent does not have to re-derive the wiring.

## Choreography

The same loop in both hosts; only the carrier differs.

**Desktop / Claude Code**: `.claude/skills/graph-to-glsl/SKILL.md` (symlinked
into `~/.claude/skills` like `node-facts`). Thin on purpose — prerequisites,
the steps below, the honesty rules; every fact about GLSL conventions lives
in the served docs so the skill and the panel cannot drift.

**Panel**: one paragraph in `SYSTEM_PROMPT` (`agent-host.mjs:359`) —
"when asked to convert / fuse / bake a graph or node to GLSL, start with
`plan_glsl_translation`, read every doc it lists via `get_glsl_docs`, and
judge parity with `compare_renders`, not by eye." The 8-turn cap stands; a
turn may hold many tool calls, and the loop below is sized to fit.

Steps:

1. **Orient.** `get_status`, `get_graph` of the scope the user is looking
   at. Resolve the target: selection, else the node wired into Output, else
   ask.
2. **Plan.** `plan_glsl_translation({target})`. If the region is empty,
   relay the reason and stop. Otherwise restate the plan in three lines:
   what fuses, what stays wired as `a..d`, what is approximated
   (`multipass`) — before writing any code.
3. **Read.** `get_glsl_docs({slugs: plan.docs})`; `get_node_source` for any
   `source:` hint. Do not skip `conventions` on the grounds of already
   knowing GLSL — every failure this spec lists came from an agent that knew
   GLSL.
4. **Look at the original.** `screenshot_strip({nodeId: target, frames:
   plan.time.frames})`. These frames are the reference for the whole loop;
   do not change them between iterations or the comparison is meaningless.
5. **Write and insert.** One hoisted helper per fused node named after its
   node id; frontier inputs through `u_a..u_d`; every non-default param that
   a user might tune becomes a channel seeded with its **current value**
   (`// ch("radius", 0.24, 0, 1)`), constants stay constants; time through
   `u_time`/`u_frame`. Apply `plan.skeleton` with `edit_group` (the
   `add_node` carries `expression`, which Syncs the channels), then
   `get_shader_errors` and fix compile errors **before** any visual step —
   a broken shader renders passthrough and looks plausibly right.
6. **Parity loop.** `compare_renders({a: target, b: glslId, frames})`. Read
   the numbers first, the diff heat second, the two renders last. Fix the
   cause the `parity` doc ranks for that diff shape; tune with `set_param`
   on the channel **name**; re-compare. Stop when every frame is `match`,
   after 6 comparisons, or when two consecutive comparisons fail to move
   any frame's mean error — then say so.
7. **Report.** What fused, what stayed wired, what was approximated and how
   (with the metric it settled at), and that the GLSL node is unwired
   downstream. Offer the swap (`add_edge` GLSL → Output, `remove_edge` the
   original) as a separate confirmed action. `tidy` the scope.

Honesty rules carry over from the blender skill verbatim: never call an
approximation a port; never drop a node silently; if the core of the graph
is `stateful`, say that before building a partial version.

## Trust boundary

All three tools are read-only and marshal through the existing bridge; no
new mutation path, no new permission class (`mutates: false`, so the
panel's session grant is unchanged). Docs are static repo content, bundled;
they carry no user data. `compare_renders` renders arbitrary nodes exactly
as `screenshot` already does. GLSL remains inert as an exfiltration surface
and DoS-shaped as a risk (081426 §Trust boundary) — a fused shader is not
worse than the same math across N nodes.

## Verification

Per `TESTING.md`: the offline gates cannot see GLSL, so this lands with
both an offline gate and a GL gate.

- `scripts/check-glsl-translation.mts` (in `npm run check`): every visible
  `category: "image"` def has a class entry; every `pure|gather|multipass`
  entry has a doc; docs have frontmatter (`type`, `class`) matching the
  table; `planTranslation` on three fixture graphs yields the expected
  region / frontier / exclusions — a pure chain (noise → ramp → displace →
  mirror: one region, zero frontier), a chain with a video source (video is
  `stateful`: one frontier input), a chain through an accumulator
  (accumulator splits the region; downstream fuses, upstream is a frontier);
  a 6-frontier graph shrinks to 4 with a named exclusion.
- `check:shaders`: `emit-shaders.mts` gains every ```` ```glsl-body ````
  fence from `docs/nodes/*.md`, wrapped in `glslExpressionSource` with
  the channels its comments declare. A doc snippet that does not compile
  fails the gate — the docs stay honest the same way the Merge blend
  formulas do.
- `check:mcp`: the three tools register on hub and proxy; `compare`
  marshals as image + text across the hop; `get_glsl_docs` with an unknown
  slug returns the missing-slug line rather than an error.
- Live protocol (manual, recorded in this doc's §Results when run): the
  three fixture graphs driven from Claude Desktop **and** from the panel,
  with the transcript's compare metrics per iteration and the iteration
  count to `match`. The panel run is the one that matters — it is the host
  with no fallback.

## Milestones

- **M0 — spike the assumptions (½ day).** Confirm `edit_group add_node` with
  an `expression` param Syncs channels (the recipe path does; the op path
  is asserted, not verified). Confirm whether a channel row can carry
  keyframes via `set_keyframes` — if not, keyframed params translate to a
  channel driven by an `animated-value` / `lfo` node, and the doc says so.
  Measure the `compare_renders` noise floor on identical nodes (RGBA16F →
  RGBA8 readback) at 256px and set default thresholds above it. Confirm
  the `asset/source` markdown import under `next dev --webpack`.
- **M1 — plumbing.** `classes.ts` (all 66 image types classified; docs only
  for the classes that need them), `plan.ts` + `plan_glsl_translation`,
  `get_glsl_docs` with `conventions` / `fusion` / `parity` written,
  `check-glsl-translation`, `check-mcp` cases, the skill, the system-prompt
  paragraph. Ship gate: the pure fixture chain translates end to end from
  the panel using only `screenshot_strip` for parity.
- **M2 — `compare_renders`.** Metrics, grid, `compare` marshalling,
  calibrated thresholds, `parity` doc rewritten against real diffs.
- **M3 — node docs.** Authoring pass over every `pure|gather|multipass`
  type, run the way `090626_node-facts.md` §Authoring pass ran: one
  subagent per batch of node files carrying a style guide
  (`.claude/skills/graph-to-glsl/references/doc-style.md`, with three gold
  docs — `perlin-noise`, `displace`, `blur` — written by hand first), agents
  write markdown only and write each file as soon as it is done (the
  lesson from that pass: batched writers lost everything on a stall), the
  gate validates centrally and SKIPs go back to the author. The `glsl-body`
  compile gate is what makes a bulk pass safe.
- **M4 — reach.** `compiled`-class handoff (`compileSdf` body with values
  inlined; Merge stacks via `fusedMergeFs`); chaining two GLSL nodes when
  the frontier exceeds 4; the confirmed swap-in as a plan-emitted op batch;
  keyframe migration onto channels if M0 says channels can hold tracks.

## Decisions taken (owner, 2026-09-16)

1. **Class table is a separate module** — `src/lib/glsl-translation/classes.ts`,
   not a field on `NodeDefinition`. Agent guidance stays out of the shipped
   engine; the gate makes a missing entry as loud as missing facts.
2. **Docs are bundled markdown** — `src/lib/glsl-translation/docs/**/*.md`,
   generated into `docs.generated.ts` by `scripts/gen-glsl-docs.mts` (a TS
   module rather than a webpack `asset/source` import so the tsx gates can
   load the same bundle; `--check` keeps it fresh in `npm run check`).
3. **The fused node lands beside the originals, unwired downstream.** The
   swap is a separate confirmed step.
4. **Thresholds** are set by measurement once `compare_renders` exists; the
   design constraint stands — a correct translation of a hashed-noise node
   must be able to read `close`, never `off`.
5. **Panel model / turn cap** are left as they are; the panel is not the
   priority. The system prompt paragraph is in, so the panel can run the
   loop when it is.

## M0 results (2026-09-17)

- **`add_node` with an `expression` param does Sync channels** —
  `applyRecipeEdit` routes patched params through `syncExpressionChannels`
  (`src/state/recipe-edit.ts:839`). The skeleton's `add_node` can carry the
  finished shader and channel edges resolve in the same batch.
- **Channels cannot hold keyframes.** `set_keyframes` resolves `param`
  against `def.params` (`mcp-handlers.ts`), and `expr-channels.ts` has no
  animation path. Keyframed params translate to a channel driven by a wired
  scalar (a `constant` / `animated-value` carrying the track) or are
  reported as not carried over. The conventions doc says so; extending
  `set_keyframes` to channel names is M4.
- **Docs bundling**: generated TS, not a loader (see Decision 2).
- **Noise floor**: not measured yet — needs the live editor and
  `compare_renders` (M2). The `parity` doc describes the metric shape and
  says `match` is not "identical".

## M1 as built (2026-09-17)

- `src/lib/glsl-translation/classes.ts` — 104 visible image producers
  classified (primary `image`/`mask`/`uv` or an image aux); the gate fails
  on any new one.
- `src/lib/glsl-translation/plan.ts` — `planTranslation` + `proposeFrames`;
  region growth with an exclusion set, the sampler-cap shrink loop (drops
  the deepest frontier-carrying node), matte vs target-mask split, channel
  wires for scalar/vec4/color_ramp frontiers, `manual` frontiers for
  vec2/vec3, per-node evaluation counts, time dependence from
  `facts.reads`/`simulation`/keyframes/`u_time` in a GLSL body, and the
  `edit_group` skeleton (`on_error: "transparent"`, no Output wire).
- `src/lib/glsl-translation/index.ts` — `getGlslDocs` (core three lead,
  missing slugs named, 40k-char cap that says what it cut).
- Docs: `conventions`, `fusion`, `parity`. Node docs are M3.
- Tools `plan_glsl_translation` and `get_glsl_docs` in
  `scripts/toolbox-tool-defs.mjs` (both hosts) with handlers in
  `mcp-handlers.ts`; server `instructions` list them.
- `scripts/check-glsl-translation.mts` in `npm run check` (eight fixture
  graphs against the real registry); `check:mcp` covers the hop.
- `.claude/skills/graph-to-glsl/SKILL.md`; a GRAPH → GLSL paragraph in the
  panel's `SYSTEM_PROMPT`.

## M2 as built (2026-09-17)

- `src/lib/glsl-translation/compare.ts` — `compareRgba` (meanAbs on RGB
  where both alphas clear a 0.02 floor, `alphaMeanAbs` over all pixels,
  `p95Abs`, `overThreshold`, `compared`, Y-up `worstBox`, verdict),
  `diffHeatRgba` (×4 gain heat, blue = alpha mismatch), `describeMetrics`,
  and `COMPARE_DEFAULTS` — the provisional bands (match: mean ≤ 0.01, p95 ≤
  0.06, alpha ≤ 0.01; close: 0.03 / 0.15 / 0.03) that the parity doc and
  the tool text both quote from this one place.
- `EngineBackend.readImagePixels` exposed (`src/engine/gl.ts`), the
  `tryShader` precedent: MCP reads a rendered node's pixels without holding
  a RenderContext.
- `compare_renders` handler (`mcp-handlers.ts`): force-renders A then B per
  frame, blits each into a 3-column grid row, reads both back at 256 px
  long edge immediately (before the pool recycles the texture), computes
  metrics, paints the heat cell, restores the playhead, and appends the
  GLSL compile error when B failed to compile. `resultKind: "compare"`
  marshals as image + the metrics text in `toolbox-tool-defs.mjs`.
- Gate: six synthetic-buffer cases in `check-glsl-translation` (identical →
  match with zero error; gross right-half error → off with the worst box on
  the right; 2/255 uniform error → match; alpha-only mismatch lands in
  alphaMeanAbs; RGB under alpha 0 is ignored and `compared` reports it; heat
  image shape). `check:mcp` proves the compare result crosses the hop as
  image + text.
- Still owed to M2: the **noise-floor measurement** on identical nodes in
  the live editor, which sets the bands for real. Until then the bands are
  the provisional numbers above and every consumer says so.

## M3 so far (2026-09-18)

- Gold docs, hand-written from the shaders: `docs/nodes/displace.md`
  (gather — one offset tap, uv01 amounts, wrap rule, rotate), `blur.md`
  (multipass — the premultiplied linear-light boundary, the `(2h+1)²`
  one-pass cost and a 12-tap cap, only `gaussian` translates), `noise.md`
  (pure — the frame around the eleven-way `type` branch, W slice-blend, the
  circular loop offset, aspect divide on `p.y`, a compiling stand-in the
  agent replaces with the ported branch). `classes.ts` points `doc:` at
  them; the planner now lists `nodes/…` slugs and drops those types from
  `sourceHints`.
- **Snippet compile gate**: `emit-shaders.mts` extracts every
  ```` ```glsl-body ```` fence from the bundled docs, wraps it in
  `glslExpressionSource` with the channels `syncChannelInputs` mints from
  its comments, and `check:shaders` compiles + links it in real WebGL2
  (`doc:nodes/<type>#<n>` keys). All three pass.
- `.claude/skills/graph-to-glsl/references/doc-style.md` — the style guide
  for the bulk pass (frontmatter, five sections, snippet rules incl. no
  GLSL reserved words as names, the write-each-file-immediately rule).
- Remaining: the fan-out over the other ~40 `pure|gather|multipass` types.
