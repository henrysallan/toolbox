# After Effects geometry host: live points and splines from toolbox graphs (spec, 2026-10-21)

Today's After Effects export writes **results**. Toolbox evaluates the graph,
and AE receives finished positions, paths and, more and more, baked footage.
Points and splines fare worst: of the controls designers touched on point
and spline nodes, 12% survive in AE.

This spec makes those graphs **live** in AE. One generic effect, the
**geometry host** (Toolbox Geometry, match name `TBX Geometry`), runs
toolbox's own engine code for a region of the graph inside AE. The region's
params become AE controls, and copies of the effect pass geometry to each
other through hidden data layers. It's the Toolbox Shader idea applied to
points and splines: toolbox ships bundles, not binaries, and nobody writes a
plugin per graph.

Builds on [091926_after-effects-handoff.md](091926_after-effects-handoff.md):
the package (§5), the Toolbox Shader host (§7) and the M4 lanes (§15), in
particular the Controls null in
[ae-m4/essential-properties.md](ae-m4/essential-properties.md). The plugin
side lives in `../AE_Plugins`, next to `toolbox-shader/`, whose
[SPEC.md](../../AE_Plugins/toolbox-shader/SPEC.md) the host copies for its
param pool, bundle storage and rendering flags.

## Summary

- **The AE_Plugins suite is required.** The goal is to cut baked footage
  sharply, and a plugin that runs toolbox's code is the only way to keep
  complex point and spline graphs live. Stock AE (shape layers,
  expressions) stays the route for regions that are fully native anyway.
- **Points and splines first.** Image work already has Toolbox Shader and
  native effects. The host targets low-level geometry with many
  interconnected params; text, 3D and ML can adapt later.
- **It runs toolbox's own code.** The host embeds JavaScriptCore and loads
  toolbox's engine. Over the owner's 133 projects, 1,417 of 1,619 point
  and spline nodes (88%, 75 types) already compute their geometry with no
  browser and a do-nothing GL. A whole composition evaluates in 1.1 ms
  per frame at the median and 70 ms at worst (§3.2).
- **Interconnected params work because the region runs as a graph.**
  Drivers inside the region (Scene Time → Seed, Math, Point Expression)
  evaluate in the host exactly as in the editor. The params you touched
  become the effect's controls, and controls on different hosts link
  through AE's own pick-whip and expressions.
- **Data layers are the wire.** When a region has to split, the upstream
  host writes its points or splines into a hidden 32-bpc float layer.
  Splits happen at an image step such as a Noise field on Toolbox Shader,
  at a native AE layer, or for size. The downstream host reads that layer
  through a layer input, as Toolbox Shader and Luma Grid already read
  layers. Expressions can `sampleImage()` the same layer to drive native
  AE layers.
- **What gets written by hand.** The host itself, once. Small ports for
  the two node types whose geometry comes from a GPU pass: Spline Merge's
  flow field and SDF → Spline. Shims for the browser APIs the engine
  touches. Per export, toolbox writes a bundle. A hand-written effect is a
  choice for speed or for a standalone product, never a requirement.
- **Measured potential.** On point and spline nodes, live touched controls
  go from 12% today to 93% with the host running the code as it is, and
  96% once the two GPU-bound types are ported. Sketch_017 goes from 1 of
  31 to 31 of 31 (§2).
- **M1 is a set of host spikes in AE.** JavaScriptCore inside an MFR
  effect, a data-layer round trip, Canvas 2D on Skia, layer fields, and
  stateful replay. Each one gets a measured answer, like the M4 lanes did.

## 1. Decisions (owner, 2026-10-21)

1. **Require the plugin suite.** A rig export may depend on AE_Plugins
   effects; the package README and the plan's `requires` list them. Bakes
   are the last resort for nodes nothing can run.
2. **Points and splines are the priority.** Graphs where many params
   interconnect over low-level data come first. The rest can adapt later.
3. **Plugins communicate to replicate graphs.** The AE side is a graph of
   effects, not one opaque render.
4. **No per-graph plugins.** If a graph needs its own C++ to export, that's
   a gap in the host, and the host gets fixed.

These replace the first draft's direction: a stock-AE rig of Expression
Controls, a `createPath()` points bus and a `.jsx` kernel library. That
route survives in two places. It covers regions that are fully native
(§8.2), and it's the bridge that drives native layers from data layers
(§6.4).

## 2. The model case: Sketch_017

As the owner saved it on 2026-10-21 (Layer 2, 1024², 60 fps, 300 frames).
Advect Points sits between Transform and Mirror but is bypassed:

```
Scene Time (seconds) → Scatter Points seed (23 points)
  → Transform (translate, scale 0.68) → Mirror (points, x, keeps the source)
  → Reroute ─┬→ Copy to Points (Circle r 0.0587, Scale field = Noise B)
             │     → Spline Merge (flow) → Round Corners → Relax
             │     → Rasterize Spline (layered, holes) ─┐
             └→ Copy to Points (Cross)                   ├→ Merge over a white Solid
                   → Rasterize Spline (layered, holes) ─┘
```

**Today.** Scene Time reseeds the scatter, so the points move every frame.
Both Rasterize Splines bake ("hole punching on animated geometry"), taking
both branches with them: 2 × 300 frames, ≈472 MB of ProRes 4444. Only the
Solid stays live: 1 of 31 touched controls.

**With the host** (`census.mts --explain Sketch_017`):

| node | touched | host as-is | host + ports | how |
|---|---|---|---|---|
| Scene Time → Scatter, Transform, Mirror | 0 + 2 + 4 + 0 | live | live | inside the host region |
| Copy to Points (Cross), Cross, Rasterize Spline | 1 + 1 + 5 | live | live | the host draws it (Canvas 2D on Skia, §5.4) |
| Copy to Points (Circle), Circle | 1 + 2 | dead | live | they only feed Spline Merge |
| Noise B | 1 | dead | live | a Toolbox Shader layer, read by the host as its Scale field |
| Spline Merge | 5 | dead | live | flow field passes ported (§5.5) |
| Round Corners, Relax, Rasterize Spline | 1 + 2 + 5 | live | live | inside the host region |
| Merge, Solid | 0 + 1 | native | native | a precomp and a solid, as today |
| **total** | **31** | **22 (71%)** | **31 (100%)** | |

In AE that's three layers instead of ≈472 MB of footage:

```
[Toolbox Shader: Noise B]  hidden, comp-sized solid
          │ layer input (Scale field)
[Toolbox Geometry: Layer 2 region]  draws circles-blob + crosses, controls:
          │                         Scatter · Count / Seed, Transform · Position / Scale,
          │                         Circle · Radius, Spline Merge · Tension …
[Solid: white]
```

What the case teaches:

1. **Freeze propagation still decides the outcome.** Spline Merge was the
   keystone under every earlier design. In the host it's a port, not a gap.
2. **One region is the common case.** The whole layer's geometry is one
   connected region with one image input. Splitting into data layers is
   for the exceptions.
3. **Animated points stop being a problem.** One Scene Time wire turned this
   graph from mostly native into fully baked today. In the host it's just
   the graph evaluating at AE's current time.

## 3. Evidence

### 3.1 The census: what's live, through freeze propagation

`scripts/ae-rig/census.mts` plans every project in the corpus with the real
planner and measures which touched controls (non-default, keyframed or
exposed params) survive. A node is live when its tier is live and some path
to the Output passes only through consumers that recompute from that input
in AE. A frozen or baked node kills every control upstream of it. The
corpus is the owner's cloud library (§10.1): 133 projects, 105 with touched
controls.

| scenario | all nodes | point / spline nodes |
|---|---|---|
| today (result export) | 2188 / 5193 (42%) | 236 / 1911 (12%) |
| stock-AE expression rig (first draft) | 4651 (90%) | 1667 (87%) |
| geometry host, code as it runs today | 4760 (92%) | 1768 (93%) |
| geometry host, Spline Merge + SDF → Spline ported | 4822 (93%) | 1826 (96%) |
| a plugin for every remaining gap | 5193 (100%) | 1911 (100%) |

The expression rig and the host look close in total, but they aren't the
same 90%. The expression rig's number assumes every kernel runs in AE's
expression engine at acceptable cost, including the heavy ones (Relax,
Autolayout, Loop Weave), which M1 might rule out. It also leaves the
stateful and GPU-bound nodes out. The host's number is the engine code
that already ran.

### 3.2 Portability: does toolbox's geometry code run outside the browser?

`scripts/ae-rig/portability.mts` evaluates every project's active
composition with the real evaluator on a GL-less context (the Skia
exporter's `dataOnlyContext`). GL is a shim where every call is a no-op and
readbacks return zeros. Each node that outputs points or a spline is
evaluated at frames 0 and 30.

- **1,619 nodes, 75 types: 1,417 computed geometry, 192 computed nothing,
  10 threw.**
- **Ran:** every high-frequency type, including Copy to Points (152 nodes),
  Points on Path (99), Point Expression (96), Grid (85), Transform (78),
  Scatter (36), Filter Points, Points to Spline, Connect Points, Spline
  Resample / Interpolate / Morph / Boolean / Offset, Relax, Shortest Path,
  Rope / Rigid Body Simulator, Differential Growth, Advect Points and
  Lissajous. Points on Path keeps GPU textures for an image output on the
  side; its points are CPU.
- **Threw (geometry comes from a GPU pass):** Spline Merge (6: flow
  rasterizes coverage, blurs and relaxes a field with fragment passes,
  then marching-squares the read-back field) and SDF → Spline (4: a jump
  flood read back).
- **Computed nothing:** mostly expected. Cursor (16) and the ML trackers
  (9) are live inputs. Image Trace (3) and nodes fed image fields got
  blank pixels; in the host they'd get the real layer. The rest come down
  to unwired or empty inputs upstream.
- **Speed (Node / V8, warm, image nodes stubbed):** 1.1 ms median, 30 ms
  p95, 70 ms max per frame for a whole composition. The slowest were
  simulation tests and a 205-node points graph.

## 4. Architecture

```
            AE comp
┌──────────────────────────────────────────────────────────────────────┐
│ [Toolbox Shader]  noise / ramps / any pixel region   (hidden or shown) │
│        │ layer input = field                                           │
│ [Toolbox Geometry · region A]  ── data mode ──▶ [data layer, hidden]   │
│                                                      │ layer input      │
│ [Toolbox Geometry · region B]  ◀────────────────────┘                  │
│        │ draw mode: pixels into the comp                               │
│ [native shape / text / solid layers]  ◀── sampleImage() bridge (§6.4) │
└──────────────────────────────────────────────────────────────────────┘
```

- **Region:** a maximal connected set of point / spline nodes, the value
  drivers feeding them, and the Rasterize Spline / Stroke / Fill nodes that
  end them. Each region is one host instance with one bundle.
- **Inputs:** image fields come from layers (Toolbox Shader, footage, any
  layer). Geometry comes from data layers written by other hosts.
- **Outputs:** **draw** (the region's pixels, at the layer's place in the
  stack) or **data** (geometry for another host, or for the native bridge).
- **Controls:** the effect's pooled params, renamed to the region's touched
  params (§7).

## 5. The geometry host

### 5.1 Runtime

- **JavaScriptCore**, the macOS system framework, through its C API: one
  context group per render thread under MFR, created lazily and reused.
  AE's JavaScript expression engine is V8, so the process probably allows
  JIT, but that's unverified. M1 measures whether JSC gets its JIT or falls
  back to the interpreter.
- **The engine bundle** is an esbuild build of the engine and the node
  registry, from `src/engine` and `src/nodes`. Image nodes stay registered
  but never run on the GPU.
- **Shims**, the browser surface the engine touches:
  - WebGL: no-op (as in the probe);
  - readbacks: answered from the region's layer inputs (§5.3);
  - Canvas 2D and `Path2D`: native Skia (§5.4);
  - `window` events and `performance.now`: stubs.
  The probe found exactly these. WebAssembly (vtracer for Image Trace) is
  an M1 question for JSC. The kurbo vector kernel can also link as a native
  Rust library.
- **Where the engine lives.** Proposed: in the bundle, deduplicated by hash.
  Each project then renders with the engine version that exported it, and
  the host doesn't have to ship in lockstep with toolbox. The cost is
  bundle size (several MB, measured in M1). The alternative is the engine
  in the host with an `engineMin` gate. That's smaller but ties every
  toolbox engine change to a host release.

### 5.2 The region bundle (`.tbxgeo`)

Like `.tbxfx`, with a gate (`hostMin`, `version`) read first:

- `graph`: the region's flattened nodes and edges (ids as the planner sees
  them), plus the keyframes of params that aren't on the pool;
- `inputs`: layer input slot → the socket it feeds (an image field, or a
  data layer decoded into points / spline);
- `outputs`: draw (which terminal) or data (which endpoint, its encoding);
- `controls`: pool slot → node param, label, range, default, keyframes;
- `comp`: canvas size, fps, loop frames (the engine's `ctx`);
- `engine`: its hash, and the engine itself when bundled (§5.1).

Stored in sequence data with the same layout, cache and reset rules as
Toolbox Shader's §5.

### 5.3 Params

The same pattern as Toolbox Shader's pool: fixed slots at PARAMS_SETUP,
renamed and shown per bundle at UPDATE_PARAMS_UI, the rest hidden through
`AEGP_SetDynamicStreamFlag`.

| slots | for |
|---|---|
| Bundle ID, Status | as Toolbox Shader |
| Time Speed, Time Offset, Loop Frames | the region's clock |
| Layer 1–8 | image fields and data layers, read after masks and effects, before transform; hidden layers work |
| Slider 1–64, Angle 1–8, Point 1–16, Color 1–16, Checkbox 1–16 | touched params |
| Popup 1–8 | enum params, if a pooled popup's items can be replaced at UPDATE_PARAMS_UI (M1); otherwise enums stay constants in the bundle, as Toolbox Shader bakes `pick()` |

A region with more touched params than slots splits, or its least-used
params stay in the bundle; the plan says which.

### 5.4 Drawing

Rasterize Spline, Stroke and Fill draw through the browser's Canvas 2D API
(`buildPath2D`, `getContext("2d")`). In the editor that's Skia, underneath
Chromium and Electron. So the host implements the Canvas 2D subset toolbox
uses on native Skia: paths, fill rules, strokes, dashes, gradients and
`putImageData`. Toolbox's own drawing code then runs unchanged, which is
the closest parity available. Skia's CPU raster first; Metal later if
drawing dominates. `skia-canvas` and `@napi-rs/canvas` are existing Canvas
2D implementations on Skia, worth reading before writing one.

SmartFX with `FLOAT_COLOR_AWARE` and `THREADED_RENDERING`, like Toolbox
Shader. A failure renders transparent, and Status names the node and its
error.

### 5.5 What doesn't run yet

| | what | fix |
|---|---|---|
| Spline Merge (flow) | coverage → blur → relax a persistent field → marching squares; the passes are fragment shaders and the field persists across frames | port the three passes to CPU (or Metal). The field becomes replayed state (§5.6). Ideally the CPU path also lands in toolbox, so the editor and the host share it |
| SDF → Spline | jump flood on the GPU, read back | CPU jump flood or exact distance; same shared-path argument |
| Image Trace | vtracer in WebAssembly, reads pixels | pixels from the layer input; WebAssembly in JSC (M1) or link vtracer natively |
| Text-on-geometry (Point Labels, text inputs) | fonts and Canvas 2D `measureText` | later: Skia text with the same fonts |
| ML trackers, Cursor, Webcam | live input / ML | out of scope: record a take, then bake |

### 5.6 Time and state

AE renders frames in any order and in parallel. Pure nodes evaluate at the
requested time. Stateful ones (Advect accumulate, Spline Merge flow, rope
and rigid-body simulators, Accumulator) replay from frame 0. Their per-frame
state is cached through AE's Compute Cache (the MFR-safe cache API added in
AE 22; M1 verifies it), keyed by bundle hash, the control values and the
frame. A cold scrub to frame N costs N steps; then it's cached. That
matches toolbox's own export, which also plays from 0.

## 6. Data layers: the wire

### 6.1 Format

A comp-sized-or-smaller solid, eye off, with a host in data mode. The
project is 32 bpc (the exporter's default today is 16). Whether 16 bpc can
carry data by packing values into pairs is a §6.5 question. One RGBA float
pixel holds four values:

- **Header** (the first pixels): magic `TBXG`, format version, kind
  (points / spline), counts, the attribute table (name → plane, arity),
  and the layout (records per row).
- **Points:** position x, y (z), then attributes in further planes.
- **Splines:** a subpath table (first anchor, count, closed, per-subpath
  attributes), then anchors (pos, in, out tangents, per-anchor attributes).
- **Space:** toolbox's authored space (canvas01, Y-down, width-relative).
  Hosts never convert, so a round trip is exact.

### 6.2 Capacity and preview resolution

At Half or Quarter resolution AE renders the data layer smaller. The writer
lays records out in the buffer AE hands it and records that layout in the
header. The reader decodes from the same downsampled buffer, so a single
render agrees with itself. Capacity drops with the resolution
(W·H·4 / d² values). The exporter sizes each data layer from the evaluated
counts, with headroom for Quarter and for growth. On overflow the writer
keeps the first records and Status warns.

### 6.3 Reading

A layer input, checked out at the current time. Checking out at other times
gives history, for nodes that read past frames. AE's render cache makes
fan-out free: ten readers of one data layer render it once per frame.

### 6.4 The native bridge

An expression can read a data layer with `sampleImage()` and drive native
AE layers. That covers positions for copies that must be real layers (text,
footage, precomps), or a `createPath()` for a native path. The header is
designed to be expression-readable, and the package ships the decoder as
one expression function. It's slower than host-to-host and meant for small
counts.

### 6.5 To test (M1)

Exact values through checkout:
- at Full, Half and Quarter resolution;
- under a non-sRGB and a linearized working space;
- with comp motion blur on;
- with the layer's eye off;
- with Collapse Transformations on a parent precomp.

Also, `sampleImage()` precision on float values, and what 16 bpc does (pack
values into pairs, or refuse data mode).

## 7. Controls and interconnected params

- **Inside a region**, drivers evaluate in the engine: Scene Time, Math,
  LFO, Point Expression, channels, keyframes and exposed group knobs. The
  graph behaves as it does in the editor, interconnections included.
- **On the effect**, the region's touched and exposed params become pooled
  controls, labelled "Node · Param" in graph order. Their toolbox keyframes
  become AE keyframes, through the existing easing conversion. Untouched
  params stay in the bundle at their values.
- **Across regions and layers**, controls link through AE: the pick-whip,
  expressions, Essential Properties (the M4 lane promotes group knobs on
  the precomp).
- **A wired param** whose driver sits in another region reads that driver
  through an expression on the pooled control (`effect("Toolbox Geometry")
  ("Scatter · Seed")`). Value graphs compile to AE expressions the way the
  M4 expression compiler already does.

## 8. The rig planner

### 8.1 Regions

Built on `planAeExport`'s flattened layers:

1. Mark geometry nodes: their resolved output is points, a spline or 3D
   points. Polymorphic nodes (Copy to Points, Mirror, Transform) resolve
   from their wiring.
2. Add the value drivers that feed only them, and the Rasterize Spline /
   Stroke / Fill nodes they end in.
3. Connected components are regions. An image node inside a component
   (a field) splits it only if it depends on the region's own geometry;
   otherwise it becomes a layer input.
4. Split further when the region passes the slot pool or a size budget,
   joining the parts with data layers.

### 8.2 The native exception

A region whose nodes all have exact native AE forms stays native shape
layers, as today. That covers parametric shapes and shape modifiers with
static positions. It stays editable without the plugin, and nothing is
lost. Anything else goes into the host whole: the planner never mixes
native shapes and host output inside one region.

### 8.3 Fallbacks

A node the host can't run yet (§5.5) takes today's route: sampled keys
where its output is geometry, a bake where it's an image. The plan names
it, its dead controls, and the port that would fix it.

### 8.4 Policy and report

- `rig: "host" | "off"` (`off` = today's result export).
- The plan's report gains, per region: its nodes, live controls, inputs,
  output mode, and host and engine versions.
- `requires` lists Toolbox Geometry and Toolbox Shader.

## 9. Later: one effect per node

The same engine can be wrapped as thin per-node effects, like TBX Scatter or
TBX Copy to Points. Their params come from the node registry at build time
(names, ranges, defaults, so no pool), they take inputs through layer
params, and they write data layers. The graph then shows in AE's layer
stack and a designer can rewire it there. That's a code generator, not
hand-written effects.

Costs:
- a layer per node;
- dynamic-socket nodes (Merge layers, Point Expression channels) don't fit
  fixed PiPL params;
- 60-odd entries in the Effects menu.

Worth building once the region host is proven, for the graphs people want
to keep editing structurally in AE.

## 10. The census

### 10.1 Corpus

`scripts/ae-rig/fetch-corpus.mts --owner-of Sketch_017` downloads the
owner's cloud library as SavedProject JSON into the gitignored
`.corpus/ae-rig/`. It uses the service-role key read-only, scoped to the
owner's rows, with inline media stripped. 2026-10-21: 137 projects, 133
downloaded (4 old rows time out on their inline media), 63 of them in the
Tests folder, 205 node types.

The census output names projects, some of them client work, and the repo
is public. So reports stay in `.corpus/`, and this spec quotes aggregates;
the only projects it names are the owner's own sketches chosen as case
studies.

### 10.2 Tools

- **`census.mts [--explain <project>]`.** Today's tier comes from the
  planner. The first draft's expression-rig tier comes from
  [tiers.mts](../scripts/ae-rig/tiers.mts). The host tier comes from
  `portability.json`. It runs freeze propagation, the leave-one-out and
  add-one rankings, and per-project keystones.
- **`portability.mts`** runs every geometry node headless through the real
  evaluator (§3.2).

Both need only Node; rerun them after any engine or exporter change.

### 10.3 Case studies

One per keystone, from design work, not the Tests folder. Each one gets
built in AE once the host runs (M2/M3) and checked with
`compare_ae_renders`. Today → expression rig, in touched controls:

| project | why | today → rig |
|---|---|---|
| Sketch_017 | Spline Merge, one region with a field | 3% → 71% (host + ports 100%) |
| pixelgridtest | 503 touched controls: the scale and speed test | 1% → 100% |
| Brex_chartExploration_01 | points, labels and text together | 24% → 100% |
| sketch_016 | Image Trace (pixels to geometry) | 4% → 38% |
| sketch_015 | Rope Simulator (state) | 65% → 75% |
| sketch06 | Shortest Path growth (state) | 33% → 92% |
| sketch09 | 3D and materials: the edge of scope | 38% → 81% |

## 11. Plugins beyond the host

- **Toolbox Shader** stays the route for pixel regions, and for fields
  feeding geometry.
- **Dedicated effects** are a choice, for speed or as standalone products:
  - Dither (exists; a conversion entry and a parity check away);
  - Luma Grid (exists; Copy to Points on a lattice with a luma field);
  - a gooey union or image-trace effect, if they're worth having in AE on
    their own.
- **The blob question is settled.** The host runs Spline Merge itself once
  ported, so no approximation (Merge Paths, blur + threshold) is needed.

## 12. Milestones

- **M0 — Census. Done 2026-10-21:** corpus fetch, census, portability,
  this spec.
- **M1 — Host spikes.** Each spike gets a measured answer in a results
  doc, built headless under the AE lock, never in the owner's open AE:
  1. **JSC in an AE effect.** A minimal effect loads the engine bundle and
     evaluates Scatter → Copy to Points (Cross) at the current time, under
     MFR. Measure: JIT or interpreter, per-frame time, memory per context,
     bundle size, and positions bit-identical to the portability probe.
  2. **Data-layer round trip.** A writer and a reader effect, through every
     case in §6.5, plus the `sampleImage()` decoder.
  3. **Canvas 2D on Skia.** Rasterize Spline (layered, holes, ramps, dashes)
     drawn by toolbox's own code, checked against the editor with
     `compare_ae_renders` on Sketch_017's crosses branch.
  4. **Fields.** Noise on a Toolbox Shader layer → a layer input → the
     engine's readback → Copy to Points' Scale field.
  5. **Stateful replay.** The Compute Cache with Advect accumulate: cold and
     warm cost, MFR safety.
  6. **Pooled popups.** Can items be replaced per bundle?

  1 and 2 gate the rest.
- **M2 — Host v1.** `TBX Geometry` in `../AE_Plugins/toolbox-geometry`, the
  `.tbxgeo` bundle, the planner's regions (§8), and the export wired up.
  Done when Sketch_017 exports live with 22 / 31 (every node but the Spline
  Merge branch) and pixelgridtest runs.
- **M3 — Ports and splits.** Spline Merge flow and SDF → Spline (shared
  with toolbox if possible), data-layer splits, the fallbacks of §8.3.
  Done when Sketch_017 reaches 31 / 31 and the case studies build.
- **M4 — The native bridge and links:** the `sampleImage()` decoder,
  cross-region drivers, Essential Properties for host controls.
- **Then:** per-node effects (§9), Windows (§13), text-on-geometry.

## 13. Decisions still open (owner)

1. **Where the engine lives:** in the bundle (proposed: exact parity per
   project, no lockstep releases) or in the host (smaller projects, a
   release per engine change). M1 measures the size.
2. **Windows.** Toolbox Shader is Mac-only. Proposed: the host is too,
   until the Mac version is proven. Windows has no JavaScriptCore, so it
   needs V8 (heavy to embed) or QuickJS (much slower).
3. **Untouched params:** stay in the bundle (proposed; re-export to change
   them), or a per-region "all controls" switch while the pool allows.
4. **The native exception (§8.2):** keep fully native regions as shape
   layers (proposed), or put all geometry through the host for one
   consistent model.

## 14. Risks

- **JSC under AE.** No JIT inside AE's process, or contexts that don't hold
  up under MFR, would cost speed, not correctness. The probe's 70 ms worst
  case has room; an interpreter could be several times slower. Spike 1.
- **Data layers corrupted by AE's own pipeline**: downsampling, color
  management, motion blur. Spike 2. The fallback is a single region per
  layer (no wires) with fields only from Toolbox Shader.
- **Engine drift.** Bundling the engine per project trades size for
  stability; a host-side engine needs `engineMin` and releases.
- **Drawing parity.** Native Skia against Chromium's Skia should agree
  closely; fonts and AA settings are where it won't.
- **Scale.** 4K drawing of large paths and 200-node graphs at every frame.
  pixelgridtest is the test case.
- **The browser surface grows.** New engine code that touches the DOM or
  the GPU breaks the host silently. Making `portability.mts` a gate would
  catch it, failing when a geometry type newly throws. It needs a
  committed fixture set, since the corpus isn't in the repo.

## 15. Open questions

- Does JSC get its JIT inside AE, and what does a context cost?
- Do data layers survive every preview setting bit-exact (§6.5)?
- Can a pooled popup change its items per bundle?
- Does AE's Compute Cache work for per-frame state under MFR, headless
  included?
- How large is the geometry engine bundle, and does it fit comfortably in
  sequence data?
