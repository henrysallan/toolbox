# After Effects handoff: direct export, exportability analysis, and the shader-plugin MCP flow

Research + proposal — 2026-09-19. Status: **nothing built.** This doc records
what was verified about After Effects as a target (AE 26.5, September 2026),
what toolbox's data model maps onto it exactly and where it does not, and a
design for three things the owner asked for:

1. **An MCP flow** where an agent points at a toolbox node network and produces
   an After Effects plugin that replicates it.
2. **Direct export** of the easy subset — transforming a spline, layers with
   masks, fills and strokes, keyframed transforms — into an AE project.
3. **In-app analysis** that says, per graph, whether direct export covers it or
   the agent path is needed, and how faithful each part will be.

Sibling specs: `091626_graph-to-glsl.md` (the fused-shader loop this design
reuses as stage one of the plugin flow), `081426_live-link-designer.md` (the
existing external handoff, parameterized UI + graph), `070926_merge-layer-masks.md`
(matte semantics), `091726_easing-editor.md` (the easing data model).

## Summary

- **Direct export should be a `.jsx` builder plus a JSON scene plus baked
  footage, not a project file.** `.aep` is undocumented binary; `.aepx` still
  opens in 26.x but Adobe says use it only as an intermediate; UXP has not
  reached After Effects; ExtendScript remains the API and is still growing in
  26.5. Everything the easy subset needs is scriptable — comps, shape layers
  with bezier paths, fills, strokes, trim/offset/round-corners/repeater/merge
  modifiers, masks, track mattes by reference, separated position dimensions,
  parenting, precomps, blend modes, built-in effects by match name, text,
  expressions, and per-key `KeyframeEase` — with **one wall: gradient stop
  colors cannot be set by script.** LottieFiles' importer works around it by
  generating a binary `.ffx` preset and calling `applyPreset`; we can do the
  same, or import an SVG (native, editable, gradients preserved since 26.0)
  for static gradients.
- **The analysis is a deterministic planner over a class table** — the exact
  shape of `planTranslation` / `TRANSLATION_CLASSES` — that assigns every node
  to a rung of an exportability ladder: `vector`, `style`, `transform`, `layer`,
  `mask`, `effect`, `expression`, `instances`, `text`, `shader`, `bake`,
  `unsupported`. "Can this graph export directly?" is "does the plan contain
  `shader` rungs"; everything below `shader` is direct, and `bake` (render the
  region to ProRes 4444 / QuickTime Animation with alpha through the existing
  export pipeline) means the answer is never "no" for an image region.
- **The plugin flow should not have an LLM write C++ per graph.** The fused
  GLSL Expression the graph-to-glsl loop already produces *is* an AE effect
  kernel: `u_a..u_d` are layer parameters, channels are sliders/colors/
  checkboxes, `u_time` is comp time. Ship **one signed generic "Toolbox
  Shader" host plugin** that loads shader bundles (translated shader + param
  manifest) — an open-source Rust + wgpu host with exactly this design exists
  (MIT) and can be forked — and let the agent produce bundles, not binaries.
  The agent verifies parity by rendering frames through `aerender` and
  comparing them with `compareRgba`, the same oracle `compare_renders` uses.
  Per-graph identity plugins (own name in the Effects menu) become a CI build
  of the same core; a fully LLM-authored bespoke plugin stays an engineer's
  "eject" path.
- **Fidelity is high for the easy subset.** Coordinates and transforms map
  exactly (same operation order, pivot = anchor point). Nine easing presets
  map exactly onto AE's speed/influence handles; sine and expo fit within
  0.25%; bounce is exact with 5 keys; elastic fits 8 keys within 0.6%. The
  real fidelity gap is **color**: toolbox interpolates keyframed colors in
  OKLab, AE in RGB, and a red→blue tween needs 63 intermediate keys to hide
  it — so color tracks export as an expression or densified keys.

## 1. What After Effects can take (verified September 2026)

Confidence: **H** primary source read; **M** secondary or single source;
**L** inference. Sources are listed in Appendix C.

| Fact | Conf. |
|---|---|
| Current release is AE **26.5** (Sept 2026). ExtendScript (`.jsx`) is the scripting language; the scripting guide's changelog has entries for 26.0, 26.3 and 26.5 (parametric meshes, variable-font axes, guides API). | H |
| **UXP is not in After Effects** — not shipped, not in public beta. Adobe's UXP hub lists Photoshop, InDesign, Premiere, Media Encoder; staff said (Mar 2026) the order is Premiere → AME → AE, "more later this year". CEP panels still work; no CEP end-of-life date. | H |
| Script-buildable: comps (`addComp`), solids, shape layers with `Shape` (vertices + relative in/out tangents + closed), fills, strokes (caps, joins, 3 dash/gap pairs + offset), gradient fill/stroke *objects*, Trim Paths, Offset Paths, Round Corners, Repeater, Merge Paths, masks (7 modes, feather, expansion, inverted), transforms with separated dimensions, parenting, precomps, `setTrackMatte(layer, type)` by reference (23.0+), blend modes, built-in effects by match name, text (`TextDocument`), expressions, 3D layers, cameras, lights. | H |
| Keyframes: `setValuesAtTimes`, `setTemporalEaseAtKey(k, in[], out[])` with `KeyframeEase(speed, influence)`, influence **0.1–100**; ease arrays are length 1 for spatial, 1-D and COLOR properties, 2 for 2-D and 3 for 3-D non-spatial ones; `setInterpolationTypeAtKey` LINEAR / BEZIER / HOLD; spatial tangents; roving. | H |
| **Gradient stop colors (`ADBE Vector Grad Colors`) are `NO_VALUE` to scripting**, unchanged through 26.5 (open feature request). Workarounds in the wild: `layer.applyPreset(.ffx)` with a synthesized preset (LottieFiles 4.12.0 generates the binary `.ffx` with up to 256 stops), duplicating a template layer, or post-writing the `.aep` with `py-aep`. | H |
| Curves, Colorama output cycle, Levels histogram and other `CUSTOM_VALUE` params are equally opaque to scripting. | H |
| Path keyframes animate the whole `Shape`; vertex count must stay constant across keys. | H/M |
| Headless: Windows `afterfx -r script.jsx` / `-s "code"`; macOS via AppleScript `DoScriptFile` (`osascript`); `aerender -r script.jsx` works in practice (nexrender) though undocumented. `app.beginSuppressDialogs()`, `app.project.save(File)`. Reading a JSON file needs no preference; **writing** files needs "Allow Scripts to Write Files and Access Network". ExtendScript is ES3: no native `JSON` — bundle json2 or `eval` our own trusted payload. | H |
| Project formats: `.aepx` XML still supported in 26.x, "intermediate format for automation… not your primary format", mostly hex-encoded binary blobs. Binary `.aep` writers: `py-aep` (Python, MIT, active Sept 2026; writes comps/solids/shapes/text/keyframes incl. gradients; **cannot add effects not already in the file**); Go/Rust/TS parsers are read-only. | H |
| **Native SVG import as editable shape layers since 26.0** (Jan 2026); 26.2 adds import options; 26.3 adds Edit → Paste SVG as shape layers. Gradient fills/strokes preserved. Static only. | H |
| Lottie: **no native Lottie in AE** through 26.5. The LottieFiles for After Effects plugin (v4.12.0, Sept 8 2026, free with login, CEP + ExtendScript) imports Lottie JSON as editable layers incl. effects, expressions, gradients (via `.ffx`). The Lottie 1.0.1 spec covers far less (trim is the only modifier; no text/effects/expressions); the de-facto lottie-web format covers what we would need. | H |
| The `.jsx`-reconstruction pattern is industry standard: Blender's official "Export to After Effects" add-on (samples every frame, dedups runs, HOLD for constants), Google's AEUX and its successor "Figma to AE" (JSON over localhost into a CEP panel), Overlord, Cinema 4D's `.aec`. | H |
| Effect plugin SDK: C/C++ (26.5 SDK, Sept 2 2026, behind an Adobe ID); PiPL resource; params are fixed after `PARAMS_SETUP` but `PF_UpdateParamUI` can rename/hide them; `PF_Param_LAYER` gives a second input; `PF_Param_ARBITRARY_DATA` serializes custom blobs into the project; SmartFX for 32-bit float; `PF_OutFlag2_SUPPORTS_THREADED_RENDERING` for multi-frame rendering (AE 22+); arm64 slice required for native Apple silicon AE (22.3+). | H |
| GPU effects since AE 15.0: Metal on macOS; CUDA / DirectX / OpenCL on Windows; 32-bit float BGRA frames; a plugin may also just create its **own** GPU device and read back (ISF4AE, tweak_shader, the SDK's own GLator sample did this). Runtime shader compilation inside AE is established practice. | H/M |
| Prior art for GLSL in AE: **ISF4AE** (C++/OpenGL, MIT, 319★, active May 2026), **tweak_shader_ae_plugin** (Rust + `after-effects` crate + wgpu, MIT, Shadertoy-style GLSL 450 with `#pragma input` manifest, 224 pooled params hidden when unused, multipass, macOS + Windows), Gyroflow (Rust, zero-copy via the AE GPU suite), ntsc-rs (production Rust plugin). `after-effects` crate 0.4.0 (Apr 2026) generates the PiPL without Rez. | H |
| macOS 15+ **refuses unsigned plugins**; ship Developer-ID-signed, notarized `.plugin` bundles into `/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/`. Windows: `.aex`, no AE-imposed signing. | H |
| `AEGP_UtilitySuite::AEGP_ExecuteScript` lets a plugin run ExtendScript; AEGP Comp/Layer/Stream/Keyframe suites can build projects from a plugin, main thread only. | H |
| Unofficial AE MCP servers exist (Dakkshin 627★, JUNKDOGE with a native AEGP, kumoproductions, Engine-Room-Games, mikechambers/adb-mcp 709★ — an Adobe employee's personal PoC); all bridge through a CEP panel running ExtendScript. Adobe shipped an **After Effects AI Assistant public beta on Sept 8 2026** (project organization, writing/fixing expressions, generative media) and says it plans to expose pro tools to third-party models "like Anthropic's Claude"; no Adobe MCP server exists yet. Adobe MAX is Nov 10–12 2026. | H/M |

Follow-up checks, resolved (H unless marked):

- **SVG by script**: the import dialog offers "Composition – Retain Layer
  Sizes" and keeps gradient fills/strokes as native, animatable Gradient
  Fill properties; `ImportOptions.importAs` takes
  `ImportAsType.COMP_CROPPED_LAYERS` and `canImportAs()` probes it — the
  mapping is undocumented for SVG (M; M0 checks it). This is the
  static-gradient fallback.
- **Temporal ease arrays**: "If the property value type is TwoD, the array
  contains 2 objects… ThreeD, 3… For all other value types, the array
  contains 1 object" — COLOR and spatial position take one ease.
- **Project settings are read/write by script**: `workingSpace`,
  `workingGamma` (2.2|2.4), `linearBlending`, `linearizeWorkingSpace`,
  `compensateForSceneReferredProfiles`, `bitsPerChannel` (8|16|32),
  `timeDisplayType`, `expressionEngine`; `CompItem.frameRate`,
  `displayStartTime`, `motionBlur`, `resolutionFactor`, `renderer`.
- **Path expressions** (`points()`, `inTangents()`, `outTangents()`,
  `isClosed()`, `pointOnPath()`, `tangentOnPath()`, `normalOnPath()`,
  `createPath()`) exist since AE 15.0; the JavaScript expression engine
  (16.0) is ECMAScript 2018 (`let`/`const`, arrows); `seedRandom(offset,
  timeless)`.
- **Stroke Taper and Wave**: scriptable since 17.1.1 (`ADBE Vector Stroke
  Taper` → Start/End Length/Width/Ease; `ADBE Vector Stroke Wave` → Amount,
  Units, Wavelength, Phase).
- **Per-effect Compositing Options masks are scriptable**: `ADBE Effect
  Built In Params` → `ADBE Effect Mask Parade` → `addProperty("ADBE Effect
  Mask")` → `ADBE Effect Path Stream Ref` = mask index, plus `ADBE Effect
  Mask Opacity` — Adobe's own `UpgradeLegacyBlurs.jsx` in the 26.5 install
  does exactly this.
- **Essential Properties / MOGRT**: `Property.addToMotionGraphicsTemplate(As)`
  (15.0/16.1), `CompItem.exportAsMotionGraphicsTemplate`, precomp overrides
  as `ADBE Layer Overrides` ("Essential Properties", 18.0) readable via
  `layer.essentialProperty` (22.0) — exposed toolbox knobs can surface as
  comp-level controls.
- **`aerender`**: `-s N -e N` is inclusive, so one frame renders; **no PNG
  output-module template ships in 26.5** ("Lossless with Alpha", "High
  Quality with Alpha", "TIFF Sequence with Alpha" do) and the output
  module's format is not settable by script — use TIFF with alpha or create
  a PNG template once. 26.5 adds `-renderSettings` / `-outputSettings
  "key: value; …"`.
- **3D models**: AE 24.1+ imports GLB, glTF, OBJ, FBX (Advanced 3D
  renderer; `ThreeDModelLayer` in scripting since 24.4); `importFile` for
  models is undocumented and the renderer id `"ADBE Advanced 3d"` comes from
  the Scripting plugin binary and community code (M).
- **Fonts**: `TextDocument.font` is a PostScript name; `fontObject` /
  `app.fonts` (24.0) resolve installed fonts; variable-font axes are
  scriptable only inside text animators (`addVariableFontAxis`, 26.0).

## 2. What toolbox has to map (from the codebase)

Numbers below are from the current tree (uncommitted work included).

- **Hierarchy is already AE's.** Project → Composition → Layer → nodes
  (`specdocs/archive/062926_compositions-and-project-view.md`). A root-level
  `layer` node composites its interior over the stack below with `blendMode`
  + `opacity` (`src/nodes/group/layer.ts:41-100`), runs its interior on a
  **layer-local clock** (`evaluator.ts:1318-1341`) and has `clips` (in/out
  windows, `src/engine/clips.ts:31`). That is an AE layer with in/out points
  and a start-time offset.
- **Time is integer ticks, 1000 per frame** (`keyframes.ts:14`); scene
  `fps`, `loopFrames`, `width`, `height` per composition (`project.ts:220`).
  AE keys are seconds: `t = tick / 1000 / fps`, exact.
- **Keyframes carry one outgoing easing per key** (`easingOut`), as an
  18-preset name, a scalar-only 2-D `customBezier`, or a normalized CSS
  `cubicBezier` (`keyframes.ts:82-91`); `normalizedBezierOfSegment`
  (`:464`) yields the segment's cubic and returns `null` for hold, expo,
  back, bounce, elastic. Extrapolation clamps; there are no loop modes or
  spatial tangents. Keyframable types: scalar, vec2, vec3, vec4, color,
  boolean, enum (step-only), `spline_anchors`. Sub-object tracks live under
  virtual keys — `layer_opacity:`, `gpoint_*:`, `ramp_c|a|p:`, `anchor_p|in|out:`
  (`conventions.ts:38-310`) — an exporter must parse them.
- **X and Y of a position are independent scalar tracks** with their own
  ticks and easing (`translateX`/`translateY`; `specdocs/archive/062926_motion-paths.md`).
  AE's separated position dimensions (`dimensionsSeparated`) are the same
  model.
- **Colors are hex params, interpolated in OKLab by default** (per-track
  switch to RGB, `keyframes.ts:105`); ramps default to **sRGB** blending
  with 11 interpolation curves and 5 spaces (`color-ramp.ts:41-70`).
- **Splines are cubic beziers with relative handles**, per-subpath `closed`,
  per-anchor `cornerRadius` (live fillet applied at emit), `width`
  (stroke-thickness multiplier), and attrs (`types.ts:203-292`). Points are
  SoA typed arrays with attributes. No polyline type.
- **Authored 2-D space is [0,1]² Y-down, origin top-left, width-relative**:
  `px = [x·W, (0.5 + (y − 0.5)·W/H)·H] = [x·W, H/2 + (y − 0.5)·W]`
  (`src/engine/aspect.ts:15-24`). AE is Y-down pixels: the mapping is a
  scale and a Y offset, exact. `uv01` (Gradient, `v_uv`) is Y-up — the one
  inversion trap.
- **Transform is `translate · pivot · rotate · scale · pivot⁻¹`**
  (`transform-value.ts:252-268`), degrees, canvas01 translation/pivot,
  signed scale; `space=local` (default) makes the pivot a fraction of the
  incoming geometry's AABB (`transform-pivot.ts`). AE's layer transform is
  `T(position) · R · S · T(−anchorPoint)` — identical order; **anchor point =
  pivot**, position = pivot + translation. Gizmo nodes are AE nulls; a wired
  `transform` chain is AE parenting (`composeTransform`, `transform-value.ts:156`).
- **Merge** composites `base` + N layers, each with its own `mask:<id>` track
  matte, `srcA = layerA · opacity · matte`, straight-alpha source-over, 29
  blend modes (`merge.ts:8-104`, `specdocs/archive/070926_merge-layer-masks.md`).
  Every other image node has a universal `mask` input meaning
  `mix(firstImageInput, output, mask)` — "reveal the effect through the
  matte" (`conventions.ts:431-450`).
- **323 registered node types, 301 visible** (Image 69, Spline 51, Point 28,
  Audio 27, 3D 39, Utility 90, Effect 17, Output 2). Three arbitrary-code
  nodes: `expression` (JS → scalar/vec), `point-expression` (JS per point),
  `glsl-expression` (fragment body). The image-node translation table
  already classifies 104 image producers (`src/lib/glsl-translation/classes.ts`).
- **Exports today**: standalone web app zip (`runExportApp`,
  `EffectsApp.tsx:10400`), PNG/GIF/video incl. ProRes 4444 and **QuickTime
  Animation (`qtrle`), whose arg-builder comment already reads "After Effects
  and Premiere read this"** (`src/lib/export-ffmpeg-args.js:72-87`), all on
  a deterministic two-pass offline frame render (`renderSettledFrameAt`,
  `EffectsApp.tsx:8780`) with `forcedTerminalRef` to pin the rendered node.
  `svg-export` (`src/nodes/output/svg-export.ts`) is the precedent for a
  terminal node that stashes an evaluated value and lets the host serialize
  a text artifact. `buildExportManifest` (`src/lib/export-manifest.ts:93`)
  already walks reachability with the evaluator's own `computeNeededSet`.
- **Two agent hosts** speak the same bridged tools: Claude Desktop/Code over
  `scripts/mcp-server.mjs`, and the in-app panel over `scripts/agent-host.mjs`
  (`useAgentSession.send(text)` is programmatic — a button can start a
  conversation). Desktop Electron can spawn external binaries with the
  `runFfmpeg` pattern (`electron/ffmpeg.js:93`) and never lets the renderer
  choose paths or flags.

## 3. The exportability ladder

Every node type gets one class in `src/lib/ae-export/classes.ts`
(lib-level, not engine-level, for the same reason as the GLSL table:
agent/export guidance must not ship in exported apps).

```ts
type AeExportClass =
  | "vector"       // spline geometry → shape-layer path(s); parametric where exact
  | "style"        // fill / stroke / gradient → shape Fill / Stroke / Gradient Fill
  | "transform"    // Transform / Gizmo → layer transform, anchor = pivot, parenting
  | "layer"        // Layer / Merge → comp layers, blend mode, opacity, track mattes
  | "mask"         // universal mask, spline-as-mask → layer mask / matte / effect mask
  | "effect"       // an AE built-in effect reproduces it (fidelity: exact | approx)
  | "expression"   // pure value node → AE expression text on the driven property
  | "instances"    // copy-to-points / array / stagger → Repeater or exploded layers
  | "text"         // text → AE text layer (+ animators)
  | "shader"       // image node with no native form → fused GLSL → Toolbox Shader host
  | "bake"         // stateful / sim / ML / 3D scene → footage layer (ProRes 4444 / qtrle)
  | "unsupported"; // live input (pointer, webcam, cursor, audio-in) — needs a recording

interface AeExportEntry {
  class: AeExportClass;
  ae?: string;                       // match name or object ("ADBE Gaussian Blur 2", "shape:ellipse")
  fidelity: "exact" | "approx" | "sampled" | "bake";
  note?: string;                     // the one thing the exporter/agent must know
  params?: Record<string, string>;   // toolbox param → AE property + unit rule
  requires?: ("ffx" | "host" | "footage" | "explode")[];
}
```

Rungs, top to bottom, with what "exact" means on each:

1. **vector / style / transform / layer / mask** — editable AE objects, exact
   geometry and timing (§4.1–4.4). This is the whole "transform a spline,
   layers with masks" ask.
2. **effect** — an AE built-in stands in. `exact` where the math is the same
   (Transform effect for an image `transform`, solid layers, Gradient Ramp for
   a 2-stop `gradient`, precomp `startTime` for `time-offset`); `approx` where
   the algorithm differs (Gaussian Blur for `blur`, Mosaic for `pixelate`,
   Fractal Noise for `noise`, Glow for `bloom`, Add Grain for `grain`,
   Displacement Map for `displace`). The planner reports approx nodes by
   name; a fidelity policy (§6) decides whether approx is accepted or the
   node goes to `shader`.
3. **expression** — the scalar DAG feeding a property (`constant`, `math`,
   `clamp`, `lerp`, `remap`, `compare`, `logic`, `switch` with a constant
   index, `float-curve`, `lfo`, `scene-time`, `random` via `seedRandom`,
   `split/combine-vec2`, and the `expression` node itself — it is already
   JavaScript, and AE's expression engine since 16.0 is ECMAScript 2018)
   compiles to one AE expression on the driven property; `random()` becomes
   `seedRandom(seed, false); random()` — different noise, same statistics —
   and along-path drivers (`sample-along-path`, `points-on-path` positions)
   become `pointOnPath()` / `tangentOnPath()` (AE 15.0+). Exact
   for pure functions of time and params. Stateful value nodes (`smooth`,
   `accumulator`, `sample-hold`, `trigger-envelope`) and audio analysis are
   `sampled`: per-frame keys.
4. **instances / text** — structurally native but bounded or approximate:
   `copy-to-points` explodes into N layers (Repeater when the point source is
   a regular `grid` or radial `array`), capped by a layer budget; `text`
   becomes an AE text layer whose metrics depend on the font installed in AE.
5. **shader** — the agent path (§7). Anything the GLSL table classes `pure` /
   `gather` / `multipass` / `compiled`, plus the 5 blend modes AE lacks
   (Average, Negation, Reflect, Glow, Phoenix), conic gradients, animated
   multi-stop gradients, OKLab ramps, `rgb-curves`, `color-ramp` with >2
   stops, `dither`, `kuwahara`, `line-art`, `liquid-glass`, SDF chains with
   smooth ops.
6. **bake** — render the region's image output through the existing offline
   renderer to a QuickTime Animation / ProRes 4444 footage layer placed at
   the same stack position with the same in/out points. Always available for
   an image region; loses editability, keeps the look. Default for
   `stateful`/`opaque` GLSL classes (sims, particles, trails, fluids, ML,
   `scene-render`, `datamosh`, video/webcam sources become footage refs).
7. **unsupported** — `pointer`, `draggable`, `hit-region`, `cursor`,
   `cursor-trail-points`, `webcam-source`, audio-in: the plan says "record a
   take or replace with keyframes"; with a recorded take they bake.

### Family table (counts from the inventory)

| toolbox family (types) | rung | AE object | fidelity |
|---|---|---|---|
| Spline primitives: circle, rectangle, polygon, star (4) | vector | parametric Ellipse / Rectangle (roundness) / Polystar | exact, stays parametric |
| line, arc, cross, wave, spiral, arrow, spline-draw, svg-source (8) | vector | `Shape` path per subpath | exact |
| Procedural spline generators (l-system, space-fill, accretive-growth, lissajous, loop-weave, string-art, shortest-path, connect-points, points-to-spline, spline-trails, differential-growth, voronoi cells…) (≈14) | vector | path keyframes of the *evaluated* geometry | sampled; needs constant anchor count (resample) else bake |
| Spline modifiers with native twins: trim-path → Trim Paths, round-corners → Round Corners, spline-offset → Offset Paths, spline-repeat → Offset Paths copies, spline-boolean → Merge Paths, set-spline-type (5–6) | vector | shape modifiers | exact or approx (AA / corner math) |
| Other spline modifiers (resample, optimize, taper, morph, interpolate, pack, blend-intersections, filter/modulate, rope/rigid sims) (≈13) | vector | sampled path keyframes | sampled; sims are bake-by-default |
| spline-fill, spline-stroke, rasterize-spline (3) | style | Fill (rule), Stroke (width, cap, join, dashes ≤3 pairs), Gradient Fill/Stroke | exact; gradients need `.ffx`; per-anchor `width` → Taper approx; `repeats` → Offset Paths copies approx; conic → shader |
| transform, gizmo (2) | transform | layer transform / null + parent | exact (§4.1) |
| layer, merge (2) | layer | comp layers, `blendingMode`, opacity keys, `setTrackMatte` LUMA/LUMA_INVERTED | exact for 24 modes; 5 modes → shader/bake |
| universal `mask` on any node; spline → mask coercion | mask | layer mask path (spline), effect Compositing Options mask, or duplicate layer + track matte | exact by construction (`mix` = matted effected copy over original) |
| Image generators: solid-color, gradient (2-stop linear/radial), image-source, video-source (4) | effect / footage | solid layer, Gradient Ramp effect, footage items | exact |
| Image effects with AE twins: blur, sharpen, transform(image), mirror, polar-coords, pixelate, array(image), posterize, threshold, edge-detect, color-correction, displace, bloom, grain, keyer, bevel-emboss, trails, chromatic-aberration, lut (≈19) | effect | Gaussian Blur 2, Sharpen, Transform, Mirror, Polar Coordinates, Mosaic, Motion Tile, Posterize, Threshold, Find Edges, Hue/Saturation + Brightness & Contrast, Displacement Map, Glow, Add Grain, Keylight/Linear Color Key, Bevel Alpha, Echo, VR Chromatic Aberrations, Apply Color LUT | mostly approx; Transform/solid exact; Curves/Colorama unscriptable → shader |
| Image effects with no AE twin: noise (as authored), voronoi, lyapunov, shape-cells, color-ramp (>2 stops), rgb-curves, color-space-transform, dither, kuwahara, flow-*, shock-filter, line-art, image-flow-field, adaptive-pixelate, bento-slice, stipple, ascii, liquid-glass, lens-flare, diffusion-curves, glsl-expression, SDF chains (≈30) | shader | Toolbox Shader host effect | exact by parity loop (approximations named by the GLSL docs for `multipass`) |
| Stateful / sims / ML / capture: fluid, physarum, watercolor, reaction-diffusion, swift-hohenberg, particles, matter, behavioral-growth, advect, datamosh, bg-remove, segment-anything, depth-anything, trackers, scene-render (≈20) | bake | footage layer with alpha | look-exact, not editable |
| Value graph: constant, math, expression, clamp, lerp, remap, compare, logic, float-curve, lfo, scene-time, random, switch, split/combine (≈16) | expression | expression on the driven property | exact when pure |
| Stateful values + audio analysis: smooth, accumulator, sample-hold, trigger-envelope, audio-bands, audio-pitch (6) | expression (sampled) | per-frame keys | sampled |
| time-offset, animated-value (wired clock), clips, layer-local time (3 + structure) | layer | precomp `startTime` / in-out points / time remap | exact for offsets and windows; non-monotonic clocks → sampled |
| copy-to-points, array (geometry), stagger, point generators + attribute nodes (≈25) | instances | Repeater for regular patterns; else N layers with per-layer values/keys | exact up to the layer budget; animated point clouds → per-frame keys or bake |
| text + animators (1) | text | text layer, Path Options, animators + Range Selector | approx (fonts, cascade shape) |
| 3D: camera-3d, light-3d, nulls, import-3d; primitives/materials; scene-render (39) | layer / bake | AE camera / lights / 3D nulls; the same GLB/glTF/OBJ/FBX file re-imported natively (AE 24.1+, Advanced 3D, `ThreeDModelLayer`); render → footage | camera/lights exact-ish; materials differ; meshes bake by default |
| Interaction: pointer, draggable, hit-region, cursor(+trail), webcam, audio-in (≈8) | unsupported | — | needs a recorded take |

The full per-type table (323 rows) lives in `classes.ts`, gated like the
GLSL table: every visible node type must have an entry.

## 4. Fidelity

### 4.1 Coordinates and transforms — exact

- Position/pivot: `x_px = x·W`, `y_px = H/2 + (y − 0.5)·W`. Radii and stroke
  widths authored width-relative scale by `W` on both axes; stroke `px`
  units pass through; `%` units resolve against `W` (`stroke-units.ts:14`).
- Transform node → layer: `anchorPoint = pivot_px`, `position = pivot_px +
  translate_px`, `scale = [sx, sy]·100`, `rotation = rotateDeg` (both
  clockwise-positive on a Y-down screen). Same composition order, so
  non-uniform scale under rotation matches. `space=local` pivots resolve
  against the geometry's AABB at export; if that AABB animates, the anchor
  is keyed per frame (or the exporter switches the node to a canvas pivot
  and says so).
- An image `transform` maps to the **Transform effect** (`ADBE Geometry2`:
  anchor, position, scale, rotation, opacity) on the layer instead of the
  layer transform when the node sits mid-chain.
- Gizmo → null layer; `transform` wire → `layer.parent`. Toolbox composes
  `parent ∘ local` — AE parenting is the same.

### 4.2 Easing — exact for most presets, measured

AE's value graph between two keys is a cubic bezier in (time, value) whose
handles are `(influence/100 · D, speed · influence/100 · D)`. Any normalized
`cubic-bezier(x1,y1,x2,y2)` with `x ∈ [0.001, 1]` therefore maps **exactly**:

```
outInfluence = 100·x1            outSpeed = (y1 / x1) · ΔV / D
inInfluence  = 100·(1 − x2)      inSpeed  = ((1 − y2) / (1 − x2)) · ΔV / D
```

(`D` seconds, `ΔV` value delta; clamp influence to [0.1, 100]; hold →
`HOLD`; this is Bodymovin's import formula, and its export is the inverse.)
Per-dimension arrays for non-spatial 2-D/3-D properties; one ease for
separated-dimension followers and spatial position. Overshoot (`y` outside
[0,1]) is representable; AE's own Easy Ease is not CSS `ease`.

Measured against `easeOf()` (`scripts` in this session; max |Δ| in
normalized value over the segment):

| preset | AE representation | max error |
|---|---|---|
| linear, easeIn/OutQuad, easeIn/OutCubic | table cubic (x at thirds) | 0 (polynomial) |
| **easeInBack, easeOutBack** | `(1/3, 0, 2/3, −0.5672)` / `(1/3, 1.5672, 2/3, 1)` — the table lacks these; they are exact cubics | **0** |
| easeInOutQuad / easeInOutCubic | one best-fit cubic | 0.37% / 0.27% |
| easeInOutQuad / easeInOutCubic | midpoint key + the in/out halves | **0** |
| easeInSine / easeOutSine / easeInOutSine | best-fit cubic `(0.403,−0.014,0.805,0.705)` / `(0.384,0.609,0.663,0.996)` / `(0.380,0.016,0.640,1.010)` | 0.13% / 0.05% / 0.23% |
| (same, using the editor's CSS table) | — | 3.0% / 3.1% / 1.8% — do not export the UI table |
| easeInExpo / easeOutExpo | best-fit `(0.631,0.021,0.845,−0.066)` / `(0.155,1.064,0.368,0.979)` | 0.09% / 0.10% (customary CSS values: 1.2%) |
| easeOutBounce | 5 keys at u = 0, .364, .727, .909, 1; first segment easeInQuad, then three parabolas with symmetric ±speed (`4(1−c)/D` for floor `c` = .75, .9375, .984) | **0** |
| easeOutElastic | 8 keys (start, 7 extrema with zero speed, end), fitted cubic per segment | 0.61% (first segment), <0.1% after |
| hold | HOLD interpolation | 0 |
| customBezier / cubicBezier | direct | 0 |

Policy: **"Editable"** (default) uses one segment per toolbox segment with the
best-fit cubic (worst case 0.6%, i.e. 6 px on a 1000 px move at the worst
instant); **"Exact"** inserts the midpoint/bounce/elastic keys. Both are
sub-frame timing-exact; the difference is value shape. `easeOf` is the
oracle in the offline gate. An upstream nicety falls out: `EASING_PRESET_BEZIER`
could gain the exact back entries and best-fit sine/expo entries so the
Graph Editor ghost handles stop lying by 3%.

### 4.3 Color — the real gap

Keyframed colors interpolate in OKLab (default) in toolbox and in RGB in AE.
Midpoints differ badly for hue-changing tweens (red→blue: OKLab `[140,83,162]`
vs sRGB `[128,0,128]`). Intermediate keys needed for AE's piecewise-linear
RGB to stay within 2/255 of the OKLab curve: red→blue **63**, orange→teal 56,
black→white 9, navy→sky 3; red→green exceeds 64. Options the exporter offers
per color track: (a) **expression** — an AE expression that OKLab-lerps
between `key(n)` values (exact, two keys, not graph-editable); (b) **dense
keys** to a tolerance (exact at frames); (c) **accept RGB** (report the
worst ΔE). Ramps: sample the toolbox ramp sampler into N stops (AE gradients
take many stops via `.ffx`) so `oklab`/`oklch`/`linear` ramps export within
tolerance; `srgb` ramps map 1:1. AE's project color management (linearized
working space, OCIO) changes both the blend math and the gradient math — the
builder sets the project's color settings explicitly (`workingSpace`,
`workingGamma`, `linearBlending`, `linearizeWorkingSpace`, `bitsPerChannel`
are all read/write by script) and the plan says which it assumed.

### 4.4 Alpha, mattes, blend modes

Toolbox composites straight alpha (`081426_glsl-expression.md`); AE
composites premultiplied. Fills, strokes and mattes match; anti-aliased
edges of blended layers differ at the sub-pixel level. Merge's per-layer
matte (`srcA = layerA·opacity·matte`) is AE's luma track matte
(`setTrackMatte(matteLayer, LUMA)`, inverted variant for `maskInvert`).
The universal `mask` (`mix(input, output, mask)`) is reconstructed as: the
effected layer above with the mask as its matte, the un-effected copy below
— exact by construction; when the mask is a spline and the node maps to an
AE effect, the effect's Compositing Options mask is the tidy form — scriptable
(`ADBE Effect Built In Params` → `ADBE Effect Mask Parade` →
`addProperty("ADBE Effect Mask")`, `ADBE Effect Path Stream Ref` = mask
index), exactly as Adobe's own `UpgradeLegacyBlurs.jsx` does. Blend modes: 24 of 29 map by name; Average, Negation,
Reflect, Glow, Phoenix have no AE mode. Toolbox's formulas (`BLEND_FS`)
may differ from AE's in details (soft-light variant, clamping in 8/16 bpc);
the parity loop measures it; 32 bpc projects avoid clamping RGBA16F ranges.

### 4.5 Strokes and gradients

Caps, joins, miter limit, up to 3 dash/gap pairs + offset map directly.
Per-anchor `width` (variable width) has no AE equivalent; Taper approximates
monotonic tapers, otherwise the stroke bakes to a fill outline. Gradients:
linear/radial stops via `.ffx` (static) — animated stops are not scriptable
in any form, so they go to `shader` (a `ramp()` channel is native to the
host) or bake. Conic gradients: shader/bake. Radial highlight/scale: AE has
Highlight Length/Angle; toolbox's `gradient_scale/offset` map to Start/End
points.

### 4.6 Time

Comp `frameRate = fps`, `duration = loopFrames / fps` or the Output node's
frame range. Layer clips → `inPoint`/`outPoint`; layer-local time → `startTime`.
`time-offset` → the offset branch becomes a precomp whose `startTime` is
shifted (exact; toolbox's boundary rule for sims/live sources applies
because those bake anyway). `animated-value` with a wired monotonic clock →
time-remapped precomp; otherwise sampled. Stagger phases are baked into the
exploded layers' offsets or per-frame keys.

### 4.7 Text

Font (by PostScript name, or `fontObject` via `app.fonts`), size, tracking,
leading, case, alignment, box → `TextDocument`; variable-font axes are
scriptable only inside text animators (`addVariableFontAxis`, 26.0);
toolbox's px units at the working resolution are AE px. Text-on-path →
Path Options with a mask path (native). The seven animators (type-on,
opacity, position, scale, rotation, tracking, color) map to AE animators
with a Range Selector; `cascade` ≈ selector shape + Ease High/Low +
direction/randomize; `uniform` = 100% range; `field` drivers have no
selector form → bake or shader. Glyph metrics differ between toolbox's CPU
rasterizer and AE; the plan flags text as `approx` and offers outline export
(`text` aux `spline` is a polyline, so outlines are `sampled`).

## 5. Design A — direct export ("AE package")

### 5.1 Artifact

`<name>.aepkg/` (folder, or zip on the web build):

```
scene.json          the AE scene in AE's own object model (comps → layers → properties → keys)
build.jsx           a static ES3 builder we own; reads scene.json, never contains project data
presets/*.ffx       synthesized gradient presets (one per static gradient), applied by name
footage/*.mov|png   baked regions (QuickTime Animation RGBA or ProRes 4444), image/video sources
shaders/*.tbxfx     Toolbox Shader bundles for shader regions (Design C) — optional
README.txt          how to run, what was approximated, what was baked (the plan's report)
```

**All conversion math lives in TypeScript** (`src/lib/ae-export/`), gated
offline; `build.jsx` is a thin interpreter (~800 lines of ES3 + json2) that
maps one JSON node type to one ExtendScript call. This is the testability
decision: the interesting code runs in `npm run check`, and the AE-side
runtime is small, static and versioned once per AE release.

`scene.json` is **our schema, shaped after AE, not Lottie**: Lottie 1.0.1 is
narrower than we need (no effects, expressions, adjustment layers, custom
effects, footage), the de-facto format is un-spec'd, and a 1:1 mapping to
`app.project` calls keeps the builder dumb. A Lottie emitter can share the
same scene walk later (it would give the web/iOS handoff a third route, and
the LottieFiles importer as a zero-code fallback).

```ts
interface AeScene {
  schemaVersion: 1; generatedAt: string; toolboxVersion: string;
  project: { bitsPerChannel: 8|16|32; workingSpace?: string; linearBlending: boolean };
  footage: { id: string; path: string; kind: "video"|"image"|"sequence"; alpha: "straight"|"premultiplied" }[];
  comps: { id: string; name: string; width: number; height: number; fps: number; duration: number;
           layers: AeLayer[] }[];
  main: string;                              // comp id to open
  report: AePlanReport;                      // §6 — what was native / approx / baked
}
type AeLayer = { id; name; kind: "shape"|"solid"|"footage"|"precomp"|"null"|"text"|"adjustment"|"camera"|"light";
  inPoint; outPoint; startTime; parent?; blendingMode; threeD?;
  matte?: { layer: string; type: "LUMA"|"LUMA_INVERTED"|"ALPHA"|"ALPHA_INVERTED" };
  transform: { anchor: AeProp; position: AeProp & { separated?: true }; scale: AeProp; rotation: AeProp; opacity: AeProp };
  masks?: { path: AeProp; mode; inverted; feather: AeProp; expansion: AeProp; opacity: AeProp }[];
  contents?: AeShapeItem[];                  // groups, paths, parametric shapes, fills, strokes, modifiers
  effects?: { match: string; name?: string; props: Record<string, AeProp>; preset?: string; compositingMask?: number }[];
  text?: { document: AeTextDocument; animators?: AeTextAnimator[]; pathMask?: number };
  source?: string;                           // footage id or comp id
};
type AeProp = { v: unknown }                 // static
            | { keys: AeKey[]; expression?: string; dims: 1|2|3|4 };
type AeKey = { t: number; v: unknown; interp: "linear"|"bezier"|"hold";
               ease?: { in: { speed: number; influence: number }[]; out: { speed: number; influence: number }[] } };
```

Keys arrive **already in AE terms** (seconds, speed/influence, HOLD),
so the builder only calls `setValuesAtTimes` then `setTemporalEaseAtKey` /
`setInterpolationTypeAtKey` per key, then `expression` if present.

### 5.2 Exporter walk (TypeScript)

1. `resolveComposition` → the active composition's layer chain
   (`getLayerChain`, `graph-ops.ts:2817`) → one AE comp; each toolbox layer →
   an AE layer or, when its interior is not a single shape/style chain, a
   precomp.
2. Inside a layer, partition the interior DAG into **segments** by class:
   a vector segment (spline producer → modifiers → transforms → style →
   rasterize) becomes one shape layer (groups per subpath; modifiers in
   toolbox order; style items last); a raster segment (image effects) becomes
   effects on that layer or on an adjustment layer; a `shader` segment
   becomes a Toolbox Shader effect (Design C) or, without the host, a bake;
   a `bake` segment becomes a footage layer.
3. Every keyframed param → `AeProp.keys` via the easing converter
   (§4.2), colors via the color policy (§4.3), virtual keys (`anchor_*`,
   `ramp_*`, `layer_opacity:`) resolved to whole-path keys, `.ffx` presets,
   and opacity tracks. Wired scalar inputs compile to expressions or sample
   to per-frame keys.
4. Bakes render through `renderSettledFrameAt` with `forcedTerminalRef`
   pinned to the region's output node at the comp resolution, encoded with
   `buildEncoderArgs("qtrle"|"prores", …)` — the existing ProRes-alpha path,
   web (ffmpeg.wasm) or native.
5. Emit `scene.json`, `build.jsx` (static asset), presets, the report.

### 5.3 Running it

- **Manual**: File → Scripts → Run Script File on `build.jsx` (AE asks
  nothing; reading JSON needs no preference). The builder wraps everything in
  one undo group, opens the main comp, and shows one summary alert with the
  approximations list.
- **Desktop app**: a `platform.runAfterEffects?(packageDir)` capability
  (optional, like `encodeVideo`), implemented in `electron/ae.js` on the
  `runFfmpeg` pattern: main locates AE (well-known paths + env override,
  reported like `CLAUDE_BIN_CANDIDATES`), writes nothing the renderer chose,
  spawns `osascript` (`DoScriptFile`) on macOS or `afterfx.exe -r` on
  Windows, and waits for `build-log.json` (written by the script only if the
  write-files preference is on; otherwise it polls for the saved `.aep`).
  `aerender -r` is the headless variant for parity renders (§7.5).
- **Web build**: download the zip; no launch.

### 5.4 UI

"Export to After Effects…" joins the Output node's export menu (`kind: "ae"`
next to `kind: "app"`, `EffectNode.tsx:1178`) and opens a modal built like
`ExportAppModal`: the coverage tree from the plan (§6) with rung chips per
layer/node, per-node overrides (force bake / keep procedural / skip),
options (fidelity policy Editable|Exact, color policy, layer budget, bake
codec, 8/16/32 bpc, AE version ≥ 23 for matte-by-reference), and three
actions: **Export package**, **Build in After Effects** (desktop, when AE is
detected), **Convert shader regions with Claude** (opens the agent panel with
a prepared prompt; §7.6).

## 6. Design B — the exportability analysis

`planAeExport(input): AeExportPlan` in `src/lib/ae-export/plan.ts` — pure,
deterministic, registry-free like `planTranslation` (`plan.ts:247`); the
handler feeds it GroupSpec-shaped nodes/edges plus lookups, the gate runs it
on fixtures.

1. **Classify** every node reached from the composition's Output (unknown
   type ⇒ `unsupported` with a warning, never a guess).
2. **Segment** each layer's interior by class transitions (vector → style
   boundary, image-effect chains, shader regions, bake regions). A `shader`
   region is exactly what `planTranslation` would fuse, so the AE plan
   embeds one `plan_glsl_translation` target per region (the GLSL planner is
   called for cost/frontier detail).
3. **Score fidelity** per node from the entry plus data: easing presets in
   use (which need Exact-policy keys), color tracks (OKLab), gradient stop
   animation, variable-width strokes, blend modes outside AE's set, instance
   counts vs the layer budget, anchor-count stability for sampled paths,
   text fonts, pivot space.
4. **Decide the route**: `direct` (no shader/unsupported), `direct+bake`,
   `direct+shader` (host required; agent needed for the fused shaders),
   `blocked` (unsupported inputs without a recording).
5. **Emit**: `report` (per layer → per node: rung, AE object, fidelity,
   notes), `shaderRegions[]` (targets + frontier summary), `bakes[]`
   (node, frames, codec, estimated MB), `expressions[]`, `warnings[]`,
   `estimates` (layers, keyframes, footage size), and the scene-walk
   skeleton the exporter consumes.

Bridged tool `plan_ae_export({ scope?, target?, policy? })` — read-only,
`resultKind: "text"` — returns the same plan to both agent hosts; the modal
renders it. Gate `scripts/check-ae-export.mts` (in `npm run check`):
coverage (every visible type classified; no stale entries), fixtures built
from the real registry (circle → transform keys → fill + spline mask ⇒
`direct`, all exact; noise → color-ramp → displace ⇒ one `shader` region;
particles → particles-to-image ⇒ `bake`; a pointer-driven param ⇒ `blocked`
with the named node; a 500-point copy-to-points ⇒ layer budget warning), the
easing converter (round trip cubic → speed/influence → cubic; the §4.2 error
table as regression numbers against `easeOf`), coordinate mapping
(`px ↔ canvas01` round trip at three aspects), the color densifier
(red→blue within 2/255 at ≤ 64 segments), the expression compiler (emitted
JS evaluated under a mini AE-expression shim equals the TS evaluator on
fixtures), `.ffx` golden bytes, `scene.json` schema validation, and an
ES3 parse of `build.jsx`.

## 7. Design C — the MCP flow for shader effects (the "plugin")

### 7.1 Why the fused shader is the plugin kernel

`glsl-expression`'s contract (`glsl-expression.ts:395-413`) is already an
effect: four image inputs, `u_res/u_time/u_frame/u_aspect`, channels with
ranges and current values, straight-alpha `fragColor`. `plan_glsl_translation`
+ `compare_renders` produce it and prove it. The AE plugin question reduces
to **hosting that kernel inside AE with the same conventions** and binding
channels to AE parameters. Nothing in the graph-to-glsl loop changes; the
AE flow starts where it ends.

### 7.2 Three ways to make it a plugin

| | A. generic host + bundles | B. per-graph identity plugin | C. LLM-authored bespoke plugin |
|---|---|---|---|
| What the agent produces | shader bundle (`.tbxfx`: WGSL/GLSL + manifest) | bundle + PiPL/manifest stub; CI builds & signs | C++/Rust source; builds locally |
| Compiler on the designer's machine | no | no (CI) | yes (Xcode CLT / MSVC, SDK behind Adobe ID) |
| Signing / notarization | once | per build, automated | ad-hoc local only (macOS 15+ blocks unsigned downloads) |
| Effect identity in AE | "Toolbox Shader" with renamed params | own name, own params, MOGRT/Premiere-friendly | own |
| Param model | pooled slots renamed/hidden via `PF_UpdateParamUI` (proven: tweak_shader 224 params, ISF4AE 16 inputs) | native | native |
| Risk surface for the LLM | shader + JSON | shader + JSON | PiPL/flag mismatches, ARGB vs RGBA, premult, 8/16/32 paths, MFR statics, arm64 exceptions |
| Windows | one build | CI matrix | designer builds |
| Verdict | **default** | later, for shipped effects | engineer's eject |

**Recommendation: A first.** Fork `tweak_shader_ae_plugin` (Rust, MIT,
`after-effects` crate + wgpu; already GLSL 450 + `#pragma input` manifest,
multipass, pooled hidden params, macOS + Windows builds) into a sibling repo
`toolbox-ae-host`, harden it (below), sign and notarize it under the Brex
Developer ID the desktop app already uses, and install it into MediaCore.
Alternative: ISF4AE (C++/OpenGL, more mature) — but OpenGL on macOS is on
borrowed time and its inputs are capped at 16; new C++ from the SDK Skeleton
is the fallback if Rust is unwelcome.

### 7.3 Host plugin contract ("Toolbox Shader", match name `TBX Shader`)

- **Params pool**: layer inputs `a..d` (4 × `PF_Param_LAYER`), 32 float
  sliders, 8 colors, 8 points, 8 checkboxes, plus `Time` (float, default
  expression `time`), `Time Offset`, `Loop Frames`, `Aspect override`, and
  a `Bundle` arbitrary-data param that stores the whole `.tbxfx` so the
  `.aep` is self-contained (no external file dependency, unlike ISF4AE).
  Unused slots hidden and used ones renamed at `UPDATE_PARAMS_UI`. Enums
  (`pick()`) are baked into the shader at export — the graph-to-glsl docs
  already tell the agent to port only the selected branch. Ramps and curves
  ship as LUT textures in the bundle (static); an animated ramp is `bake`.
- **Conventions baked into the host**: `v_uv` Y-up over the layer's extent,
  `u_res` = output size at the current downsample, `u_aspect` = W/H,
  `u_time` = `(current_time / time_scale) + offset`, `u_frame` = time ×
  the bundle's fps; **unpremultiply inputs, run straight-alpha, premultiply
  output**; 8/16/32 bpc via SmartFX (`FLOAT_COLOR_AWARE`), color-management
  note in the bundle (assumes display-referred sRGB working space unless the
  export said otherwise). Apply to a comp-sized solid or adjustment layer —
  the builder does this — so `u_aspect` and canvas01 match the toolbox canvas.
- **Rendering**: phase 1 — SmartFX + `SUPPORTS_THREADED_RENDERING`, own wgpu
  device (Metal / DX12 / Vulkan), upload checked-out inputs, render, read
  back (tweak_shader's path; works regardless of AE's GPU preference).
  Phase 2 — opt into `PF_OutFlag2_SUPPORTS_GPU_RENDER_F32` and wrap
  `gpu_world_data` zero-copy on Metal (Gyroflow's precedent).
- **Failure mode**: a bundle that fails to compile renders transparent and
  puts the compiler message in a visible text param — the AE twin of
  `on_error: "transparent"` + `get_shader_errors`.

### 7.4 Translation pipeline (deterministic, in toolbox)

`src/lib/ae-export/shader/`: fused body + template → GLSL 450 (drop
`#version 300 es` and precision qualifiers, rename `u_a..u_d`/`v_uv`/
`u_res`/`u_time`/`u_frame`/`u_aspect` to the host's bindings, emit
`#pragma input(...)` from the channel list with current values and ranges)
→ **naga (WASM) validation** → WGSL canonical + MSL/HLSL text (naga, or
glslang + SPIRV-Cross) in the bundle. This is the AE `get_shader_errors`:
`validate_ae_shader` fails before anything reaches AE. Known seams: Y
convention (once, in the host), premultiplication (host), `mediump` →
float, combined samplers split (naga), integer-free channel types.

### 7.5 New bridged tools (both hosts)

| tool | mutates | what |
|---|---|---|
| `plan_ae_export` | no | §6 plan |
| `get_ae_docs({slugs})` | no | bundled docs: `ae-conventions` (coordinates, time, alpha, color management, bit depth), `ae-host` (bundle format, translation rules, param pool), `ae-parity` (reading aerender diffs: premult fringes, Y flips, gamma/working-space shifts, blur-radius calibration), `ae-nodes/<type>` mapping notes for `effect`-class approximations |
| `export_ae_package({plan?, options})` | yes (writes files) | runs Design A; for shader regions expects the fused `glsl-expression` nodes the agent inserted (unwired downstream, as the GLSL skill leaves them) and translates them into bundles; returns the package path and the report |
| `run_ae_script({package})` | yes (spawns AE) | desktop only; builds the `.aep`; returns the build log |
| `compare_ae_renders({package, frames})` | no | desktop only; `aerender -s N -e N` (inclusive) the built comp at the plan's frames through the shipped "TIFF Sequence with Alpha" output module (no PNG template ships and the format is not scriptable), `readImagePixels` the toolbox side at the same frames, `compareRgba` → the same `A | B | heat` grid and metrics as `compare_renders` |

`compare_ae_renders` is what makes the agent's claims checkable; without
AE installed it degrades to "package exported, not verified", said plainly.

### 7.6 Choreography

`.claude/skills/graph-to-after-effects/SKILL.md` (thin, like graph-to-glsl;
facts live in `get_ae_docs`), plus one paragraph in the panel's
`SYSTEM_PROMPT` (`agent-host.mjs:359`):

1. **Orient** — `get_status`, `get_graph`; confirm the composition.
2. **Plan** — `plan_ae_export`. Relay the route and the report in five
   lines: native / approx (named) / shader regions (named) / bakes (named)
   / blocked. Stop if blocked. Ask before exploding more than the layer
   budget or baking more than N seconds of footage.
3. **Shader regions** — for each: run the graph-to-glsl loop
   (`plan_glsl_translation` → docs → write → `get_shader_errors` →
   `compare_renders` to `match`). Then `get_ae_docs(["ae-host"])` and
   `validate_ae_shader`.
4. **Export** — `export_ae_package`. Read the report back to the user.
5. **Build and verify** — `run_ae_script`, `compare_ae_renders` at the
   plan's frames. Fix the highest-ranked cause from `ae-parity` (a unit
   mismatch is a param edit; a premult fringe or Y flip is a host bug to
   report, not a shader edit); re-export; stop on match, after 4 rounds, or
   on no progress — say which.
6. **Report** — what is native, what is approximate and by how much (the
   metric), what is baked, what the AE user must install (the host plugin
   version), which fonts are needed. Never call a bake a port.

Route B/C (identity or bespoke plugins) get their own skill later; the
bespoke one would start from the `after-effects` crate's `simplest`
example (~50 lines + a 30-line `build.rs` PiPL) with the kernel as a CPU
per-pixel function, and verify with the same `compare_ae_renders`.

## 8. Trust boundary

`plan_ae_export`, `get_ae_docs`, `compare_ae_renders` are read-only and
marshal through the existing bridge. `export_ae_package` writes only under a
folder the user picked (`pickSaveFolder` tokens, `files.js` rules); the web
build downloads a zip. `run_ae_script` is native-only, spawns a binary main
located (never a renderer-supplied path), passes only the package path it
wrote, and inherits the ffmpeg session pattern (abort, quit-time sweep).
`build.jsx` is a static asset — project data is data in `scene.json`, so a
crafted project cannot inject ExtendScript. Shader bundles are inert text;
the host compiles them in its own GPU context — DoS-shaped at worst, like a
GLSL Expression. Baked footage carries user content and goes only where the
user pointed. The panel's permission model is unchanged: the two mutating
tools need the session grant like `insert_recipe`.

## 9. Verification

Offline (`npm run check`): `check-ae-export` (§6) and `check:mcp` cases for
the five tools (registration, hub/proxy hop, `compare` marshalling reuse).
GL (`check:shaders`): every `glsl-body` snippet in `ae-nodes/*` docs still
compiles; plus a **naga round trip** of the three gold GLSL docs through the
translation pipeline. Live protocol, recorded in this doc's §Results when
run: fixture A (circle → transform keys with easeOutBack → fill + spline
mask), fixture B (two layers, Merge with a luma matte and Screen, Gaussian
blur), fixture C (noise → color-ramp → displace as a shader region), fixture
D (particles baked) built in AE 26.5 on macOS through `run_ae_script`, with
`compare_ae_renders` metrics per frame and the iteration count to `match`.
The two facts §1 still marks medium (SVG import-as-composition by script;
the Advanced 3D renderer id) get confirmed in M0.

## 10. Milestones

- **M0 — spike (2–3 days).** Hand-write `scene.json` + `build.jsx` for
  fixture A and run it in AE 26.5: confirm ease exactness against
  `easeOf` at sampled frames, the synthesized `.ffx` gradient technique
  (or SVG import by script as the fallback), json2 loading, `osascript`
  launch and `aerender -r`, TIFF-with-alpha frames and `compareRgba` on the
  result, and `ImportOptions.canImportAs(COMP_CROPPED_LAYERS)` on an SVG. Fork tweak_shader locally, render one toolbox fused shader (noise
  → ramp) inside AE at 32 bpc, check premultiplication and Y. Go/no-go on
  the host approach and on Rust.
- **M1 — analysis.** `classes.ts` (all 323 types), `plan.ts`,
  `plan_ae_export`, the modal's coverage tree, `check-ae-export`.
- **M2 — direct export v1.** The easy subset end to end: layers, primitive
  and drawn splines, fills/strokes/dashes, transforms and gizmo parenting,
  masks and mattes, blend modes, keyframes with the easing converter and the
  color policy, clips/time offsets, bake fallback through the existing
  encoder, `build.jsx`, desktop launch, the modal's Export/Build actions.
- **M3 — shader host.** Harden and sign `toolbox-ae-host`; translation
  pipeline + `validate_ae_shader`; bundle format; `export_ae_package`
  bundles; `compare_ae_renders`; `get_ae_docs` core docs; the skill and the
  panel paragraph; live protocol fixtures C.
- **M4 — reach.** `effect`-class approximation table with calibrated unit
  maps (blur radius ↔ blurriness, etc.) and `ae-nodes/*` docs; the value-
  graph expression compiler; text layers + animators; instances → Repeater
  / exploded layers; SDF hard chains → Merge Paths; 3D cameras/lights/nulls
  and GLB passthrough; exposed knobs → Essential Properties; Windows host
  build; zero-copy GPU path.
- **M5 — optional.** Lottie emitter over the same scene walk (web/iOS
  reuse; LottieFiles importer as a zero-code fallback); identity plugins via
  CI from the host core.

## 11. Decisions needed (owner)

1. **Host plugin language/base**: fork tweak_shader (Rust + wgpu; new
   language for the org, but the crate generates the PiPL and Gyroflow/
   ntsc-rs prove the stack) vs ISF4AE (C++/OpenGL) vs SDK Skeleton C++.
   Recommended: fork tweak_shader in a sibling repo.
2. **Direct-export carrier**: `.jsx` + JSON (recommended) vs `py-aep` (Python
   dependency, cannot add effects) vs Lottie through the LottieFiles plugin
   (third-party login, importer fidelity not ours).
3. **Default fidelity policy**: Editable (best-fit single segments, ≤0.6%)
   vs Exact (extra keys). Recommended: Editable, with Exact one click away.
4. **Default color policy**: expression vs dense keys vs accept-RGB for
   OKLab tracks. Recommended: expression when the track drives a shape/solid
   color, dense keys (tolerance 2/255) elsewhere.
5. **Layer budget** for exploded instances (proposed 200) and bake size
   warnings (proposed 500 MB).
6. **Where AE runs**: designer machines with AE installed (desktop app
   spawns it) now; a render box with `aerender` for CI-style parity later.
7. **Windows** timing for the host build.
8. **Scope of v1 coverage** — the "common operations" list: transform a
   spline, layers with masks, fills/strokes, blur, gradient, text? Confirm.

## 12. Risks

- The `.ffx` gradient technique is reverse-engineered (LottieFiles, GradientHub
  rely on it); if Adobe changes the preset format it breaks. Mitigation:
  M0 verification, SVG-import fallback for static gradients, shader host for
  animated ones, and a scripting-surface watch (Adobe's request is "Open for
  Voting").
- Font availability and glyph metrics make text `approx`; offer outlines.
- Color management: a linearized or ACES working space changes blends and
  gradients; the exporter must set or detect it, and the plan must say so.
- UXP may arrive in AE after MAX 2026; the JSON-first design isolates the
  builder, so a UXP builder replaces `build.jsx` without touching the
  exporter.
- Host plugin engineering is real work (MFR safety, three bit depths,
  premult, readback cost at 4K, signing pipeline): weeks, not days; forking
  buys most of it.
- AE performance with hundreds of exploded layers or per-frame keys; the
  budget and bake fallback exist for this.
- Version drift on the AE side (match names are stable for a decade; the
  builder is versioned per AE release and reports the host version).

## Appendix A — easing conversion, worked

For a 1 s, 100 px segment: easeOutCubic → out `(influence 33.33, speed 300)`,
in `(33.33, 0)`; easeOutBack → out `(33.33, 470.16)`, in `(33.33, 0)`;
easeInOutQuad (best-fit) → out `(45.5, 6.59)`, in `(48.5, 9.28)`.
Bounce as 5 keys on the same segment (normalized speeds ×100 px/s):
`u0=0..0.364` out 0 / in 550; `0.364..0.727` out −275 / in 275;
`0.727..0.909` out −137.5 / in 137.5; `0.909..1` out −68.7 / in 68.7; all
influences 33.33. Exact back cubics: `easeInBack = (1/3, 0, 2/3, −c1/3)`,
`easeOutBack = (1/3, 1 + c1/3, 2/3, 1)`, `c1 = 1.70158`. Scripts that
produced every number in §4.2 and §4.3: `scripts/research/ae-easing-fidelity.mjs`
(single-segment fits, OKLab densification) and
`scripts/research/ae-easing-fidelity-sparse.mjs` (bounce and elastic as
sparse keys); run with `node`. They become fixtures of `check-ae-export`.

## Appendix B — coordinate formulas

`px_x = x·W`; `px_y = H/2 + (y − 0.5)·W` (equivalently
`aspectCorrectY(y, W/H)·H`); inverse `y = 0.5 + (px_y − H/2)/W`. A
width-relative radius `r` is `r·W` px on both axes. Stroke `px` passes
through; `%` is `·W/100`. `uv01`/`v_uv` is `(x, 1 − y_raster)`. Degrees
everywhere on the layer transform; toolbox `sample-along-path` angles and
`copy-to-points` rotation fields are radians — convert.

## Appendix C — sources

AE scripting guide: https://ae-scripting.docsforadobe.dev/ (changelog,
`Property`, `KeyframeEase`, `Shape`, `MaskPropertyGroup`, `Layer`,
`LayerCollection`, `TextDocument`, shape-layer and effect match names).
Adobe Help: scripts.html, projects.html (aepx), whats-new.html (26.x, SVG
import), import-svg-files, automated-rendering-network-rendering (aerender),
creating-shapes-masks. UXP status: https://developer.adobe.com/uxp/ ,
https://forums.creativeclouddeveloper.com/t/when-will-uxp-come-to-after-effect/11777 .
Gradient scripting wall: community.adobe.com feature request
"a-usable-propertyvaluetype-for-adbe-vector-grad-colors-1214765".
Bodymovin keyframe math: bodymovin-extension `bundle/jsx/utils/keyframeHelper.jsx`
and `src/helpers/importers/lottie/property.js`. LottieFiles for AE:
https://aescripts.com/lottiefiles/ , releases.lottiefiles.com (4.11.0,
4.12.0), plugin ZXP v4.12.0. Lottie spec: https://lottie.github.io/lottie-spec/ ;
lottie-docs. py-aep: https://github.com/forticheprod/py-aep . Blender
exporter: https://extensions.blender.org/add-ons/io-export-after-effects/ .
AEUX / Figma to AE: https://github.com/google/aeux , https://nvdreamspace.com/figma-to-ae .
SDK: https://ae-plugins.docsforadobe.dev/ (entry point, PiPL, command
selectors, parameters, parameter supervision, multi-frame rendering, GPU
build instructions, Apple silicon, where installers put plug-ins, AEGP
suites). ISF4AE: https://github.com/baku89/ISF4AE . tweak_shader:
https://github.com/mobile-bungalow/tweak_shader_ae_plugin . after-effects
crate: https://github.com/virtualritz/after-effects . Gyroflow plugins:
https://github.com/gyroflow/gyroflow-plugins . naga: wgpu `naga/README.md`;
SPIRV-Cross, glslang (KhronosGroup). AE MCP servers: Dakkshin, JUNKDOGE-JOE,
kumoproductions, ishu86, Arman-Luthra/aftr, Engine-Room-Games,
mikechambers/adb-mcp. Adobe AE AI Assistant beta (Sept 8 2026):
blog.adobe.com "generate-create-directly-in-your-timeline…".
