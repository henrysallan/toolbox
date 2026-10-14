# Skia target: SkSL authoring, Skia layers, and React Native Skia + Reanimated export

Spike + proposal — 2026-10-13. Status: **M0 built and measured** (§2);
**owner decisions taken (§5)**; **Wave 1 (§2b) and Wave 2 (§2c) merged and measured**. The owner's three questions, and the answers this doc
substantiates:

1. **Can toolbox have an SkSL node?** Yes. It exists: `sksl-shader`, rendered
   by Skia itself (CanvasKit) inside the editor.
2. **A toolkit of SkSL nodes + a per-layer mode that limits the catalog to
   it + an exporter that compiles a layer to one shader with the animation
   baked in?** Feasible. The restriction is the point: when every node in a
   layer has a Skia lowering, export becomes deterministic codegen instead of
   the agent loop graph-to-glsl needs. We recommend the export target be a
   *small Skia tree* (one fused shader + native filters/paths), with "one
   shader" as its common case, and a timeline that ships as a Reanimated
   worklet by default (baked-into-shader as an option).
3. **How much Reanimated parity can toolbox give as a staging environment?**
   M0 measured it on the web target: **pixel-identical frames** (8/8 frames,
   0/255 max error) between toolbox and the exported React Native Skia
   bundle, and a timeline that is **bit-identical** to toolbox's keyframe
   engine for every easing preset. iOS/Android (Graphite on Metal/Vulkan)
   is the remaining unmeasured gap. It runs in CI, since this machine can't
   use Xcode (§5.4, lane L5).

Sibling specs: `081426_glsl-expression.md` (the node template this follows),
`091626_graph-to-glsl.md` (planner, class table, `compare_renders`: the
parity oracle reused here), `091926_after-effects-handoff.md` (the other
export target; same planner/ladder pattern), `091726_easing-editor.md`
(easing data model), `081426_time-offset.md` (Animated Value's clock).

---

## Summary

- **Preview what ships.** The SkSL node compiles the user's SkSL with
  CanvasKit (`canvaskit-wasm` 0.41.0: the exact build React Native Skia's
  web target loads) and renders it on Skia's own WebGL context, then hands
  the pixels to the engine. A transpile to the engine's GLSL was rejected:
  SkSL accepts things GLSL ES 3 does not (implicit int→float, `float2(1)*4`).
  Its compile errors are also the device's errors, which a transpile cannot
  reproduce.
- **One master clock, toolbox's own curve math.** The export does not chain
  `withTiming` per keyframe. It ships `toolbox-timeline.ts`, the keyframe
  evaluator as worklets, plus the track data, driven by one shared value in
  seconds. The gate proves bit-identity with `evaluateKeyframesAt` for every
  preset, `cubicBezier`, `customBezier`, `hold`, OKLab/RGB colors, and the
  Color node's 8-bit hex round trip. App code still controls time: play,
  loop, scrub with a gesture, or `withTiming`/`withSpring` the clock to a
  marker.
- **Single-shader fusion is the common case, not the only one.** Of the
  image-producing node types: 20 pure and 11 gather fuse into one pass; 12
  multipass (blur, bloom, …) need Skia's native image filters or a
  `RuntimeShader` filter stage; 5 compiled (SDF) port their emitted code.
  18 stateful + 42 opaque never fuse; in a Skia layer they are either
  replaced by native Skia drawing (vector nodes → `Path`) or not offered.
- **Skia's ES2 rules are the porting cost.** Verified in CanvasKit: no
  `uint`, no bitwise ops, no `while`, constant loop bounds, no `round`,
  `tanh`, derivatives, bool uniforms, array constructors, dynamic indexing or
  recursion. Grain, Shape Cells, Voronoi, Lyapunov, Stipple, ASCII, Physarum
  hash with `uint`/bitwise ops today, so their Skia versions need float hashes
  and will not be pixel-equal to the GL originals. Inside a Skia layer the
  Skia version *is* the node, so that is acceptable.

---

## 1. Verified facts (2026-10-13)

### 1.1 React Native Skia

- **v3** is `react-native-skia` on npm (not `@shopify/react-native-skia`, which
  is v2). Latest installable 3.4.0 (3.4.2 published today; the registry's
  minimum-age guard suppresses it). Requires RN ≥ 0.79 (New Architecture), React
  19, iOS 15.1, Android API 26; **Reanimated ≥ 4.0 + react-native-worklets ≥
  0.7** (optional peer). Does **not** run in Expo Go (dev build required).
- Renders with **Graphite** on device (Dawn → Metal on iOS, Vulkan on Android;
  prebuilt Skia m154). **Web = CanvasKit 0.41.0 on WebGL (Ganesh)**, loaded
  from `canvaskit-wasm/bin/full`. So even the web target is not the device
  renderer.
- Reanimated integration: shared/derived values pass **directly** as props and
  shader `uniforms` (no `useAnimatedProps`); Canvas content is read on the UI
  runtime and replayed off-thread. `select()` binds one object-valued shared
  value to many props. `useClock()` exists.
- Native primitives available for a Skia node library (v3 component list):
  `Path` (with `start`/`end` trim), `Circle`, `Rect`, `RoundedRect`, `Oval`,
  `Line`, `Points`, `Vertices`, `Patch`, `Atlas`, `Text`, `TextPath`,
  `Paragraph`, `Glyphs`, `Image`, `ImageSVG`, `Picture`, `Skottie`, gradients
  (`LinearGradient`, `RadialGradient`, `SweepGradient`,
  `TwoPointConicalGradient`), `Turbulence`, `FractalNoise`, `Shader`,
  `ImageShader`, `ColorShader`, image filters (`Blur`, `BackdropBlur`,
  `Shadow`, `Morphology`, `DisplacementMap`, `Offset`, **`RuntimeShader`**:
  an SkSL program applied to rendered content), color filters (`ColorMatrix`,
  `BlendColor`, `Lerp`, `LumaColorFilter`, gamma), path effects (`Dash`,
  `Corner`, `Discrete`, `Path1D/2D`, `Line2D`, `Sum`), mask filters
  (`BlurMask`), `Group` (transform, opacity, clip, blendMode, layer), `Mask`.
- `Canvas` has `highBitDepth` (16-bit float surface on iOS, 10-bit Android)
  and `opaque`.

### 1.2 Skia runtime effects (probed in CanvasKit 0.41.0, Node)

`SkRuntimeEffect::Options::maxVersionAllowed` defaults to `k100`: strict GLSL
ES 1.00 rules. Probe results (`RuntimeEffect.Make`):

| feature | result |
|---|---|
| `half4 main(float2 p)`, `vec*`/`mat*` aliases, structs, `const float4` | OK |
| int literal promotion (`p / 256`, `n * 4`) | OK (GLSL ES 3 rejects; this is why we don't transpile) |
| `for (int i=0;i<8;i++) { if (…) break; }` | OK |
| loop bound from a uniform | **rejected** ("loop index must be compared with a constant expression") |
| `while` / `do` | **rejected** |
| `uint`, `&` `|` `^` `<<` `>>` | **rejected** |
| `round`, `tanh` (and the other `$es3` builtins) | **rejected** |
| `dFdx`, `fwidth` | **rejected** |
| `uniform bool` | **rejected** (use `int`) |
| uniform array, dynamic index (`a[k]`) | **rejected**; loop-index access OK |
| array constructor `float[3](…)` | **rejected** |
| recursion | **rejected** |
| `sk_FragCoord` in a runtime shader | **rejected** |
| `layout(color) uniform float4` | OK (sRGB → working space on non-sRGB surfaces) — no longer used (§5.5) |
| `toLinearSrgb` / `fromLinearSrgb` (half3) | OK (probed on sRGB, Display P3 and Adobe RGB surfaces, 2026-10-14). **CPU backend bug:** inside a conditional, after a child was sampled, the conversion is skipped — call them unconditionally and select the result |
| `uniform shader x; x.eval(p)` | OK |

Semantics: `main` receives **local** coordinates, Y-down, pixel centres at
+0.5. The return value is **premultiplied**: an unpremultiplied return with
a < 1 composites too bright (probe: `(1, .5, 0, .5)` over blue → `(1, .5,
.5, 1)`). Int uniforms are passed as floats and cast per `isInteger`.
Unused uniforms are kept in the layout. CanvasKit exposes no child-shader
names (we parse them from source).

### 1.3 Reanimated 4.7 easing vs toolbox presets

Read from `react-native-reanimated/src/Easing.ts`. Only relevant for
app-authored transitions (§3.5c). The master-clock export uses toolbox's
math and is exact regardless.

| toolbox | Reanimated | parity |
|---|---|---|
| linear, easeInQuad, easeInCubic, easeInSine, easeInBack | `linear`, `quad`, `cubic`, `sin`, `back()` | same formula |
| easeOut*/easeInOut* (quad, cubic, sine, back) | `out(f)` = `1 − f(1−t)`, `inOut(f)` | algebraically equal; last-ulp float differences |
| easeOutBounce | `bounce` | same formula (Penner constants) |
| easeInExpo / easeOutExpo | `exp` = `2^(10(t−1))` | **not special-cased at 0/1**: starts at 0.00098 / ends 0.1% short |
| easeOutElastic | — (`elastic(b)` is a different curve) | **none**: ship toolbox's formula as a worklet easing |
| cubicBezier | `Easing.bezier(x1,y1,x2,y2)` | same curve; different solver (4 Newton + 10 subdivision steps): ~1e-6 |
| hold | — | `withSequence` + `withDelay` + 0-ms set |
| springs | `withSpring` | **toolbox has none** (§3.5d) |

### 1.4 Toolchain notes

- Expo SDK 58 (`latest`) ships **RN 0.88.0-rc.4**. Reanimated 4.7.0's peer range
  (`0.86 - 0.88`) rejects the release candidate, so the harness installs with
  `legacy-peer-deps=true` (`skia-harness/.npmrc`). Revisit when RN 0.88 is final.
- RN Skia web loads `canvaskit-wasm/bin/full`; toolbox loads `bin/` (6.8 MB vs
  7.7 MB, same Skia build, same SkSL compiler). M0 frames were bit-identical
  across the two, but switching toolbox to `full` removes the asterisk (M1).
- This Mac has Command Line Tools only (no Xcode, no simulators, no
  CocoaPods). iOS work needs Xcode installed (owner action).

---

## 2. M0: what was built and measured

### 2.1 SkSL Shader node (`sksl-shader`)

Files: `src/nodes/effect/sksl-shader.ts`, `src/engine/skia/canvaskit.ts`
(loader), `src/engine/skia/sksl-program.ts` (prelude, lint, compile cache,
uniform packing), `src/engine/skia/sksl-render.ts` (Skia surface → engine
image), `scripts/copy-canvaskit.mjs` (postinstall → `public/canvaskit/0.41.0/`,
gitignored).

- **Authoring contract.** The user writes a full SkSL shader, helpers plus
  `half4 main(float2 fragCoord)`, with tunables as the GLSL Expression comment
  grammar (`// ch("k", 0.5, 0, 1)`, `color()`, `toggle()`, `pick()`). The
  node owns a prelude: `uniform float3 iResolution; uniform float iTime;`
  (shaders.skia.org names, so playground shaders paste), `uniform shader
  iImage1..4` **only when referenced**, then one uniform per channel. Mapping:
  scalar → `float`, toggle → `int` (no bool uniforms), pick → `int` + consts,
  color → `float4` (straight alpha, sRGB numbers; was `layout(color)` until
  the 2026-10-14 color-management change, §5.5). ramp/curve → reported
  unsupported (M2). The prelude plus the source is the shipped file.
- **Render path.** CanvasKit runs in its own WebGL2 context (one shared
  offscreen canvas, `premultipliedAlpha: false`, sRGB surface).
  `drawPaint(Src)` → `texImage2D(canvas)` into a temp texture → a tiny FS
  flips Y-down→Y-up and divides alpha out in float → `ctx.allocImage`. Wired
  images go the other way via `readImagePixels` → `MakeImage`: 8-bit, CPU
  round trip, flagged as an M2 cost.
- **Lifecycle.** The WASM is fetched once via a script tag (avoids webpack
  resolving emscripten's `require("fs")`). Until it lands the node renders
  transparent. On load a `pipeline-bump` re-evaluates; `fingerprintExtras`
  folds `ck0/ck1` (and `iTime` when referenced) so the placeholder isn't
  cached.
- **Errors.** CanvasKit's message, line numbers rewritten to the user's
  source, flows to `get_shader_errors`, `get_graph` (`shaderError`), the
  screenshot sidecar and the console. Lint adds what Skia can't know: stray
  `uniform` lines (rejected), missing `main`, `half` declarations (warning:
  fp16 on Metal).
- **Wiring.** Channels are wireable by name in recipes. Fixing that exposed a
  pre-existing bug: `insert_recipe` never resolved `<glsl>:in:<channel>` for
  channelSync nodes, despite the tool docs saying it did. Fixed in
  `growExprVarHandle` (`src/state/recipe-builder.ts`); covered by the gate
  for both GLSL Expression and SkSL Shader.

### 2.2 Port: Aurora (one shader)

`scripts/fixtures/skia/aurora.sksl`: Noise (simplex fBm, 4 octaves) → Color
Ramp (4 stops, linear, OKLab), ported line for line from `NOISE_FS` and
`makeColorRampSampler`. The only change is the coordinate frame (Skia Y-down
px → toolbox `v_uv`). Built in the live editor with three Animated Value
drivers wired into **both** the native nodes and the SkSL channels (drift
linear; scale `easeOutBack` → `easeInOutCubic`; contrast `easeOutElastic` →
`easeInOutSine` → `hold`).

**`compare_renders` (native A vs SkSL B), frames 0/45/120/200/299, 256 px
analysis: MATCH on every frame, meanAbs 0.0006 (≈ 0.15/255), p95 0.004
(≈ 1/255), alpha 0.** The residual is the Color Ramp's 1024-entry LUT and
the fp16 intermediate between Noise and Ramp.

### 2.3 Export + worklet timeline

Files: `src/lib/skia-export/{plan,emit,index}.ts`,
`src/lib/skia-export/runtime/toolbox-timeline.ts`, CLI
`scripts/export-skia.mts` (`npm run export:skia`), gate
`scripts/check-skia-export.mts` (in `npm run check`).

- `planSkiaExport(nodes, edges, sksl-node)` resolves every channel to
  **static** (its row), **Animated Value** (scalar track; clock must be
  unwired), **Constant** (static; keyframed is refused because Constant snaps
  to its step), or **Color** (color track: OKLab/RGB, 8-bit quantised,
  node alpha). It refuses, with reasons, any other driver, wired `iImage*`,
  ramp/curve channels, clip windows/retimes, palette extraction, and
  keyframed alpha.
- `emitSkiaBundle` writes `effect.ts` (SkSL verbatim), `timeline.ts` (track
  data + `sampleUniforms(seconds, w, h)` worklet), `toolbox-timeline.ts` (the
  runtime, verbatim), `ToolboxEffect.tsx` (`<ToolboxEffect time width height>`
  + `useToolboxClock({playing, loop, start})`), `manifest.json`, `index.ts`.
- Time: `ticksAt(seconds)` snaps frame-aligned times to exact ticks, so hold
  keys and segment boundaries resolve as in the editor.

**Gate results:** scalar runtime bit-identical to `evaluateKeyframesAt` over
21 easings × 6,759 ticks (incl. before/after/between keys and fractional
ticks); `customBezier` with explicit and default handles bit-identical; color
interpolation bit-identical in OKLab and RGB; Color-node hex round trip
bit-identical; **Aurora: emitted `sampleUniforms` == the real evaluator's
driver outputs at all 301 frames**; emitted SkSL compiles in CanvasKit and
declares exactly the uniforms the timeline supplies; refusals fire.

### 2.4 Device harness + parity

`skia-harness/`: Expo SDK 58 app, `react-native-skia` 3.4.0, Reanimated 4.7.0,
worklets 0.13.0. It plays `src/bundle/` on the master clock. On web, `?t=`
freezes the clock and `window.__toolboxHarness.capture(t)` returns
`makeImageSnapshot().readPixels()` (Skia's pixels, not the compositor's).
`npm run parity:skia` (`scripts/skia-parity.cjs` + `scripts/skia/parity-page.ts`)
serves the static web build, captures the device frames, then renders the
same fixture through toolbox's real path (`evaluateGraph` → drivers →
`sksl-shader` → CanvasKit → engine image → `readImagePixels`) in the same
Electron window. It scores the pair with `compareRgba` (compare_renders'
metrics) and writes PNGs, heat maps and `report.json` to
`skia-harness/parity-out/`.

**Result (512², frames 0/45/90/120/150/200/240/299): MATCH, meanAbs 0,
max 0/255, 100.00% identical pixels on every frame.** Motion check (f0 vs
f150 on device) meanAbs 0.21, so the clock really moved. The pink peak of
the OKLab-animated `c2` stop is visible at f150 on both sides.

**Not measured:** iOS/Android. No Xcode here. Expected deltas, to measure in
M1: Graphite vs Ganesh rasterisation (irrelevant for `drawPaint`), `half` →
fp16 on Metal (the Aurora port uses `float` throughout), the canvas color
space (sRGB vs Display P3, §3.8), and density (shader evaluated per device
pixel at 3×, coordinates in points).

Trap hit and fixed: a hidden Electron window suspends `requestAnimationFrame`
(TESTING.md §Traps) and RN Skia web only redraws on rAF, so every capture
hung. The parity script uses `offscreen: true` + `setFrameRate(60)` and
times out each call.

### 2.5 Reproduce

```bash
npm run check:skia-export                                         # timeline + plan + compile gate
npm run export:skia -- --fixture aurora --out skia-harness/src/bundle
npm --prefix skia-harness run export:web                          # static web build
npm run parity:skia                                               # device(web) vs toolbox diff
npm --prefix skia-harness run web                                 # watch it play
```

---

## 2b. Wave 1 results (2026-10-13, branch `skia-wave1`)

All six lanes merged (integration notes in the merge commits). Measured:

| what | result |
|---|---|
| Aurora built from Skia-layer nodes (Noise (Skia) → Color Ramp (Skia) → Skia Fill → Skia Canvas) vs native Noise → Color Ramp, real engine, 512², 8 frames (`compare:skia -- --a aurora-scene:ramp --b aurora-scene:skc`) | **MATCH**, max 1/255, mean meanAbs 0.00025 |
| …exported through the **scene exporter** and played by React Native Skia web vs toolbox's Skia Canvas (`parity:skia -- --bundle scene`) | **pixel-identical**, 8/8 frames, 0/255 |
| M0 SkSL-node bundle after CanvasKit `bin/full` + runtime changes (`parity:skia`) | pixel-identical, 8/8 |
| Fused library ports vs the hand-written Aurora SkSL (`check:skia-library`) | max 1/255, 9 of 369,408 px differ |
| Exported timeline vs the evaluator, channel keyframes incl. translucent color (`check:skia-export`) | bit-identical, frames 0..300 |
| Scene exporter: 22 animated binds × 61 frames replayed from the emitted worklets (`check:skia-scene-export`) | bit-identical |
| Emitted scene bundles type-check against react-native-skia 3.4.0 + Reanimated 4.7 | pass |

What exists now:
- Nodes: `skia-canvas`, `skia-fill`, `skia-group`, `skia-shape`, `skia-noise` (simplex only), `skia-color-ramp` (the closed-form interpolations; srgb / linear / oklab).
- Library: the fuser, `defineSkslNode`.
- Exporters: the scene renderer and the scene exporter (`exportSkia` on a Skia Canvas).
- Keyframes on channels.
- Editor: the Skia layer target, the catalog filter and validator, "Export for React Native Skia…" (zip), and the `plan_skia_export` / `export_skia` MCP tools.
- Device parity: the `compare:skia` harness, the device driver with its CI workflow (`.github/workflows/skia-device-parity.yml`, dispatch-only, never run), and golden frames.

**Findings that change plans:**
- **iOS renders in Display P3 on P3 screens, with no option.** react-native-skia
  3.4.0 picks the color space from `UIScreen.displayGamut`
  (`RNSkApplePlatformContext::mainScreenSupportsP3`), and `Canvas` exposes no
  color-space prop. Android always uses sRGB. Without a fix, uniform colors
  stay correct (`layout(color)` converts them) but procedural colors computed
  in the shader are read as P3, so they come out more saturated.
  **Resolved 2026-10-14 (§5.5): P3 accepted, programs color-managed.** Every
  generated program runs its math on sRGB numbers and converts at its
  boundaries (`tbx.color.cm`, `engine/skia/library/color-management.ts`);
  `check:skia-color-management` holds every program to ≤ 1/255 between sRGB
  and Display P3 surfaces. Device snapshots (`makeImageSnapshot` of
  declarative content) replay into an UNTAGGED offscreen surface
  (`RNSkView::makeImageSnapshot` → `MakeOffscreen(…, nullptr)`): color
  management is off there, the programs pass through unchanged, so the CI
  parity numbers still measure GPU math, not the P3 screen.
- **RN Skia web tags its WebGL buffer `display-p3`.** Pixel values are
  unaffected, but on wide-gamut monitors the web harness may look more
  saturated than toolbox.
- **Text semantics.** `width` means a wrapped paragraph (L1's renderer). The
  exporter refuses text with a width until the `<Paragraph>` emitter lands
  (Wave 2, text family).
- **RN web throws on runtime image filters and composed path effects.**
  Native supports both; the manifest flags them, and the renderer emulates
  them.
- **Previously untested since 0.5.x:** `insert_recipe` channel-by-name wiring
  (fixed in M0), and exported web apps loading CanvasKit from a sub-path
  (fixed by L5; the vector kernel WASM still 404s in exported apps, a
  pre-existing bug).

Open items carried to Wave 2:
- AI Recipe / Edit with AI don't pass the Skia-layer context to the validator yet.
- Wired-and-keyframed channel rows don't show that the wire wins.
- No UI picks a channel color track's color space.
- `--bundle scene` exists on web only; the native deep link doesn't select a bundle yet.
- The asset cache in the editor never evicts.
- Vector-kernel WASM in exported apps (pre-existing bug).

## 2c. Wave 2 results (2026-10-13/14, branch `skia-wave1`)

All eight families merged. Every port is proven with `compare:skia` against the GL node it mirrors (same drivers, real engine), and exports via `checkExportable` (programs compile in CanvasKit with exact uniforms; the emitted bundle type-checks against react-native-skia 3.4.0 + Reanimated 4.7). Each family has its own gate in `npm run check`.

| family | nodes | compare:skia | not ported / notes |
|---|---|---|---|
| F1 noise & fields | skia-noise (all 11 algorithms, loop, flow, phasor, uv_in), skia-shape-cells, skia-lyapunov, skia-texture-coordinate | 21/24 MATCH (max ≤ 6/255 on noise) | Shape Cells: uint hash → float hash, every cell draws differently (OFF by design, geometry MATCH). Lyapunov: CLOSE in chaotic regions (fp32 amplification). Per-variant functions via `defineSkslVariantNode`. |
| F2 color | solid-color, gradient (all modes), color-correction, rgb-curves, posterize, threshold, color-space-transform, keyer, dither (ordered) + color-ramp: every interpolation × space | 37/37 MATCH | Error-diffusion dither (the native default) refused. Keyer's matte output not mirrored. Color Ramp uses ~96 uniform slots. |
| F3 warps | skia-transform, -mirror, -polar-coords, -pixelate, -array | all MATCH (meanAbs ≤ 0.0013) | Gathers clamp to the outer texel centre to match CLAMP_TO_EDGE textures (`tbx.warp.texel`). |
| F4 gathers | skia-displace, -chromatic-aberration, -sharpen, -edge-detect, -bevel-emboss, -vector-field, -flow-blur, -kuwahara | 15/15 MATCH | Over the phone budget (32 units/px, an estimate): Flow Blur, Kuwahara (and Sharpen / Edge Detect over noise) → filter-stage split later. Bevel outer/inner/pillow and Kuwahara r > 24 px refused. |
| F5 SDF | skia-sdf-rasterize, -to-mask, -to-distance-image, -bevel, -shade; 24 SDF tree nodes allowed in Skia layers | 28/28 MATCH | SkSL generated per tree SHAPE (values are uniforms → tracks). SDF Displace / From Image / Material ramp refused. Splines ≤ 128 segments. |
| F6 merge | skia-merge (all 29 blend formulas, masks, layer_opacity tracks) | 29/29 MATCH | ≤ 8 enabled layers per node. Skia's native blendMode agrees with Merge only over an opaque backdrop (documented); 14 Merge modes have no RN equivalent. |
| F7 vector shapes | skia-circle, -rect, -line (exact tracks via BindRef.scale); all spline generators allowed in Skia layers → Skia Shape | 15/15 MATCH, interiors 0/255 | AA edges differ within ~1 px (Chromium canvas2D vs CanvasKit coverage). |
| F8 paint & text | skia-stroke, -spline-fill, -trim-path, -round-corners, -dash, -gradient-fill, -text (+ Geist OFL font asset) | 21/21 MATCH | Text glyph ink 9–15 % lighter than the Text node (CoreText vs FreeType rasterization). Wrapped paragraphs ignore `leading` and hang from the box top. Corner effect is quadratic, not arc. |

**Integration fixes made while merging Wave 2:**
- Skia Fill no longer writes srcOver, so a Group's blendMode reaches it (F6).
- Producer problems now ride from shader → Fill → Group → Canvas, so an unported option refuses the export instead of shipping transparent (F4/F5/F8).
- A program that only declares iTime is driven by the clock, with no false "not the scene clock" warning (F1).
- `layer_opacity:<id>` refs are typed as scalars (F6).
- Paragraphs fold inherited group opacity, since RN draws them with their own paint (F8).
- Generators are data-only-safe, and an upstream throw refuses the export (F7).
- Mirror/Array translation classes corrected (F3).

**Native toolbox bugs found by the ports (outside this work):**
- Displace `wrap=mirror` flips the whole image (task chip filed).
- Trim Path cuts by segment parameter, not arc length (F8).
- The Text node blurs fractional translates (F8).
- Noise's CPU `value` aux doesn't match the GL image for value/phasor noise at seed ≥ 1 or w ≠ 0 (F1).
- Circle's "equal radii are round only on a square canvas" gotcha is wrong (F7).

**Carried to M3/M4:**
- Font and image assets aren't copied into exported bundles yet.
- RN Paragraphs drop an inherited group blendMode.
- Filter-stage splitting for over-budget gathers.
- Device bands: CI lanes ready, not yet run.
- ~~The P3 decision (§2b).~~ Decided and built 2026-10-14 (§5.5).
- `tbx.warp.texel` and `tbx.gather.edge` should become one shared helper.
- Merge (Skia) has no grow-on-wire / "+" layer button.

**Additive contract proposals collected (none applied):**
- `defineSkslNode`:
  - structural variants (F1);
  - wired-input flags in binds/unsupported (F2/F3/F4);
  - param-aware taps (F3/F4);
  - extra shader outputs and non-shader inputs (F2/F3);
  - a clock-dependency marker on binds (F2);
  - `float3x3` params (F2).
- `BindRef.offset` (affine canvas01 → px, F7); optional producer ids on SDF values (F5).
- Text IR: `lineHeight` and a vertical anchor (F8).
- `trim` inverted mode (F8).

## 3. Design for the full implementation

### 3.1 The Skia layer

A layer gets `target: "default" | "skia"` (Layer shell param, serialized; old
projects read `default`). In a Skia layer:

- **Catalog filter.** The add-node menu, search, recipe validator and MCP
  `get_catalog({ target: "skia" })` show only types whose lowering is
  `native` or `sksl` (§3.2). Others are greyed with the reason.
- **Validator.** `planSkiaLayer(layer)`, the `planTranslation` pattern, assigns
  every interior node a class plus a reason, and computes cost (§3.3). An
  existing graph switched to `skia` shows per-node badges for what will not
  ship. Switching is non-destructive.
- **Preview = export.** The layer's interior compiles to a **Skia scene IR**
  (§3.4). The layer's output image is CanvasKit rendering that IR, the same
  IR the exporter emits as JSX. The SkSL Shader node is one IR node kind; M0
  is the degenerate case (scene = one `Fill` with one `Shader`).
- **Composition.** A Skia layer composites into the rest of the comp like any
  layer (it's an image). Only Skia layers export to RN; the comp-level export
  is "N Skia layers stacked", with blend modes mapped to `Group blendMode`.

Recommendation on the owner's "exclusive library" idea: **yes, separate
Skia-mode node defs** (`skia-*` types), each authored *as* its lowering (an
SkSL function, or a native IR emitter), and **named and parameterized like
the existing node** they mirror. One source of truth per node (the Skia
version renders the preview), no second vocabulary for designers, and a
mechanical "convert layer to Skia" that maps `noise` → `skia-noise` with params
copied. Lowering existing defs in place was rejected: their preview would stay
the GL implementation and parity would depend on a translation again.

### 3.2 Node library and lowering classes

| class | meaning | export as | examples (toolbox type → Skia) |
|---|---|---|---|
| `sksl` | per-pixel function, fused into the layer's shader | one `RuntimeEffect` | noise (11 algos), gradient, solid-color, color-ramp, posterize, threshold, color-correction, rgb-curves, color-space-transform, keyer, dither (ordered), merge (blend formulas), transform/mirror/polar-coords/pixelate (inverse sample), shape-cells, lyapunov, texture-coordinate, SDF chain (`compiled`) |
| `sksl-gather` | re-evaluates upstream at offset coords | fused; cost × taps | displace, chromatic-aberration, sharpen, edge-detect, bevel-emboss, vector-field, flow-blur, kuwahara, array |
| `filter` | needs the rendered result of what's below | native image filter, or `RuntimeShader` over a `Group` layer | blur → `Blur`, bloom → threshold `RuntimeShader` + `Blur` + `Blend(plus)`, grain (classic) → `RuntimeShader`, liquid-glass, lens-flare |
| `native` | vector/text/image drawing | RN Skia components | circle/rectangle/polygon/star/arc/line/wave/spiral/cross/arrow/spline-draw/svg-source → `Path`; spline-stroke/spline-fill → paint style; trim-path → `Path start/end`; spline-boolean → `Path.op`; round-corners → `CornerPathEffect`; dash → `DashPathEffect`; gradient fill → gradient shaders; text → `Paragraph`; image-source → `Image`; points + copy-to-points → `Atlas`; transform → `Group transform` |
| `bake` | not live-exportable, but renderable | image / image sequence / video asset + `Image` | simulations, ML, 3D, video, stateful nodes |
| `none` | not offered in a Skia layer | — | audio, trackers, webcam |

Counts today (`classes.ts`): pure 20, gather 11, multipass 12, compiled 5,
stateful 18, opaque 42 (incl. `sksl-shader`). Spline 52, image 66.

**Port rules for `sksl` nodes** (`docs/skia/porting.md`, M2):
- Float hashes only. Replace `pcg3d`/`uint` hashes (grain, shape-cells,
  voronoi, lyapunov, stipple, ascii) with documented float hashes; note the
  look change.
- Constant loop bounds with `break` (octaves, taps, radius ≤ cap).
- No derivatives: analytic AA from `iResolution` (1 px = `1/iResolution.y` in
  uv).
- `float` everywhere; `half` only for the final return.
- Return premultiplied.
- Color math in gamma sRGB (the engine's convention), OKLab helpers from one
  shared snippet.

### 3.3 Fusion: Skia layer → one shader (deterministic)

Every `sksl` node is authored as **one SkSL function plus a parameter
schema**:

```sksl
// skia-noise
float4 skia_noise(float2 uv, float scale, float octaves, float persistence,
                  float lacunarity, float2 offset, float contrast,
                  float4 colorA, float4 colorB);
```

The fuser walks the layer's DAG from the output, emits each node's function
once (namespaced `n<id>_`), turns params into uniforms
(`n<id>_scale`), and composes calls. Pure nodes nest. Gathers take their
upstream **as a function call at a transformed coordinate** (the SkSL
equivalent of graph-to-glsl's "re-evaluate the producer"). The fan-out
multiplies cost, and the planner's `evaluations` count already models it.
Shared helpers (hashes, OKLab, simplex) are a library deduped by name. ES2
rules are satisfied by construction because every library function passed
the CanvasKit gate.

Cost model: per-pixel evaluations × per-node ALU class, reported against
budgets for 3× density phones (iPhone 12-class at 1170×2532 ≈ 3 M px). The
planner warns when a gather-of-gather exceeds a budget. Then it either
splits the layer at that node into a `RuntimeShader` filter stage (a second
pass over a `Group`), or refuses.

When a layer contains `filter` or `native` nodes the output is a **tree**:
`Group`s of native drawing, a fused `Shader` per contiguous `sksl` region,
filters on `Group layer` props. Same IR, so the same preview path.

### 3.4 Skia scene IR

```ts
type SkiaNode =
  | { k: "group"; transform?: Bind<Mat3>; opacity?: Bind<number>; blend?: BlendMode;
      clip?: PathRef; layer?: ImageFilterIR[]; children: SkiaNode[] }
  | { k: "fill"; shader: ShaderIR }
  | { k: "path"; path: Bind<PathData>; style: "fill" | "stroke"; strokeWidth?: Bind<number>;
      start?: Bind<number>; end?: Bind<number>; paint: PaintIR; effects?: PathEffectIR[] }
  | { k: "image"; asset: AssetRef; rect: Bind<Rect>; fit: Fit }
  | { k: "paragraph"; text: Bind<string>; style: TextStyleIR; layout: Bind<Rect> }
  | { k: "atlas"; image: AssetRef; sprites: Rect[]; transforms: Bind<RSXform[]> };
type ShaderIR = { k: "runtime"; sksl: string; uniforms: Record<string, Bind<UniformValue>>; children: ShaderIR[] }
             | { k: "linear" | "radial" | "sweep"; … } | { k: "image"; asset: AssetRef };
type Bind<T> = { value: T } | { track: TimelineTrack } | { expr: WorkletExpr };
```

- Every bindable value is static, a track (exact replay, §2.3), or (M5) a
  worklet expression compiled from an Expression node's JS, so procedural
  drivers can ship too.
- **Preview:** a CanvasKit renderer for the IR (`src/engine/skia/scene-render.ts`)
  that evaluates `Bind`s at the current tick, using the same
  `toolbox-timeline.ts` the device runs.
- **Export:** an emitter from the IR to RN Skia JSX + `timeline.ts`. Tracks
  become `useDerivedValue(() => evaluateTrack(T, tick(time.value)))`.
  Paths with animated geometry use `usePathValue` / `usePathInterpolation`
  when topology matches, otherwise per-frame `PathData` via the worklet.

### 3.5 Animation export: three shapes from one track IR

a. **Worklet timeline (default, built in M0).** Exact, one clock, app
   controls time. M3 adds **markers and segments** (toolbox timeline markers →
   `SEGMENTS = { intro: [0, 1.2], loop: [1.2, 5] }` + `useToolboxClock`
   helpers: `playSegment`, `loopSegment`, `seek`). Designers then author
   "intro then idle loop" states that app code triggers.
b. **Baked into the shader** (the owner's "single shader with the animation
   baked in"). Tracks compile to SkSL piecewise functions of `iTime`: an
   unrolled `if` chain over keys, presets as closed forms, cubic-bezier via
   8 Newton + 32 bisection steps (constant bounds), OKLab + 8-bit quantise
   reproduced in float. One file, zero JS per frame; but no scrubbing,
   segments or interaction except through `iTime` itself. Parity
   expectation: ≤ 1e-6 per value (fp32 vs JS doubles). The gate compares
   it per frame against the worklet path. Best for ambient loops.
c. **Reanimated-native transitions.** For app state changes (tap → expand),
   export per-property `withTiming(target, { duration, easing })` using
   §1.3's mapping. Exact presets map directly; expo/elastic ship as worklet
   easing functions copied from `toolbox-timeline.ts`; `cubicBezier` →
   `Easing.bezier`.
d. **Springs (new).** Add a `spring` easing to toolbox whose evaluator *is*
   Reanimated 4's spring solver (`springUtils.ts`: duration + dampingRatio
   or mass/stiffness/damping). Preview and device then share the physics,
   and exports emit `withSpring(config)`. The analytic solution is a worklet
   too, so mode (a) replays it exactly.

### 3.6 Device parity harness (iOS/Android)

- Deep link `toolboxharness://capture?t=1.25&id=<run>` freezes the clock,
  calls `makeImageSnapshot().readPixels()`, and POSTs RGBA to the host's
  capture server (the simulator reaches host `localhost`). The parity script
  gains `--target ios` and drives `xcrun simctl openurl`, or the iOS
  Simulator MCP tool.
- Measure first, before any library porting: a **calibration shader**
  (sRGB patches, gradients, a hash-noise field, an fp16-sensitive
  accumulation, a premultiplied alpha ramp) across iOS 17/18 simulators and
  one physical device. The results set the parity bands per platform, the
  way graph-to-glsl's noise-floor measurement does.
- Physical devices: capture via the same deep link on a dev build. The
  simulator renders through Metal on the Mac GPU, not the phone's GPU, and
  the spec must say which numbers came from which.

### 3.7 Editor UX + MCP

- **Export action:** Layer menu → *Export for React Native Skia…* (Skia
  layers and SkSL nodes). It runs the planner, lists problems inline, and
  writes a zip (`jszip`) of the bundle, or copies `ToolboxEffect.tsx` +
  data to the clipboard. The runtime source ships as a generated module
  (`runtime.generated.ts`, the `docs.generated.ts` pattern with `--check`).
- **Skia layer chrome:** target toggle on the Layer shell, badge in the
  Layers panel, per-node lowering badges, the cost readout.
- **Code editing:** the on-node SkSL editor is the GLSL one; add SkSL syntax
  mode and inline CanvasKit errors under the line.
- **MCP:** `plan_skia_export` (read-only plan: classes, uniforms, problems,
  cost), `export_skia` (returns the files as text for the agent to write),
  `get_catalog({ target: "skia" })`. `get_shader_errors`, `get_graph`,
  `screenshot` and `compare_renders` already handle SkSL. A
  **`graph-to-sksl` skill** (the graph-to-glsl loop with SkSL docs) ports an
  arbitrary default-layer graph into an SkSL node; the M0 Aurora port is the
  worked example.

### 3.8 Engine work items

1. **Channel keyframes.** Let SkSL (and GLSL Expression) channels hold
   keyframes directly, so designers needn't wire Animated Value nodes. This
   is graph-to-glsl's deferred M4: the evaluator gets a clone-and-override
   block for `ch:<name>` keys, `set_keyframes` resolves channel names, and
   the panel gets channel diamonds. The planner then reads tracks from the
   node itself.
2. **ramp / curve channels** → `uniform shader <name>` children: in preview,
   a 256×1 image shader from the LUT; on device, a `LinearGradient` child
   (ramp, when the interpolation is linear in sRGB) or an `ImageShader` of the
   baked LUT (exact).
3. **Image inputs.** GPU path instead of `readImagePixels`: try
   `MakeLazyImageFromTextureSource` with an engine-blitted canvas, else share
   a WebGL context (state isolation risk). Export images as bundled assets
   (`useImage` + `ImageShader` child).
4. **Color policy.** Done 2026-10-14 (§5.5): RN Skia's Display P3 canvases
   on iOS are accepted and every runtime program is color-managed — sRGB math
   inside, `toLinearSrgb` / `fromLinearSrgb` at main's result and at each
   child sample, color uniforms plain `float4` (no `layout(color)`). Expose
   `highBitDepth` in the layer when gradients band.
5. **Density.** `iResolution` in points matches RN. Pixel-unit params (blur
   radius px, grain size px) need a declared unit policy:
   `iResolution.z` = pixel ratio on device, 1 in toolbox, unless the layer
   previews a device profile (then ratio = 3).
6. **CanvasKit in exported web apps / live viewer.** Copy
   `public/canvaskit/` into the export template and gate it in
   `build:export-template`. Switch to `bin/full` to match RN web.
7. **Robustness.** WebGL context loss on the CanvasKit canvas, cache eviction
   (64 effects), and a perf note in the profiler: CanvasKit time sits outside
   the engine's GPU timer.

### 3.9 Trust boundary

SkSL is inert (no I/O). Risk is DoS-shaped, a pathological shader hanging the
GPU, same as GLSL Expression. The exporter writes only into the chosen
directory; the bundle contains code the app compiles, so it is a source
artifact to review like any PR. CanvasKit is an npm dependency pinned
exactly; the copy script reads only from `node_modules/canvaskit-wasm`.

---

## 4. Fidelity: expected and measured

| area | toolbox ↔ RN Skia web | toolbox ↔ iOS (expected) | notes |
|---|---|---|---|
| timeline values (worklet) | **bit-identical** (gate) | bit-identical | JS doubles both sides |
| SkSL pixels, sRGB, `float` math | **identical** (8/8 frames) | ≤ 1/255 expected | Metal fp32; Graphite vs Ganesh irrelevant for `drawPaint` |
| `half` math | identical | **differs** (fp16) | lint warns; library bans it |
| color uniforms | identical | identical (plain sRGB numbers; the program converts its result) | §5.5 |
| procedural colors on a Display P3 canvas | identical (sRGB canvas: conversions skipped, byte-identical) | **≤ 1/255** (CanvasKit P3 surfaces, every generated program: `check:skia-color-management`); fp16 intrinsics on Metal add ≤ ~0.5/255, to confirm on device | §5.5; uncorrected the same programs differ by up to 116/255 |
| 8-bit P3 surface vs the sRGB color | — | ≤ 8/255 in saturated darks (the surface's own quantization; native drawing shares it) | an 8-bit P3 step is coarse where sRGB's encoding is steep |
| native gradients / blends / translucent overlaps on P3 | — | **shift** up to ~24/255 (red → blue gradient), ~28/255 (50 % pink over green), Merge-style native blendModes up to ~100/255 | Skia interpolates and blends in the working space; RN exposes no interpolation color space — fused programs (Merge (Skia), Gradient (Skia)) are exact |
| native paths/AA | n/a in M0 | ≤ 1 px edge differences | Graphite AA vs Ganesh |
| text | n/a | layout differences possible | Paragraph + bundled fonts only |
| baked-in-shader timeline | — | ≤ 1e-6 per value | fp32 vs double |
| Reanimated `Easing` transitions | — | exact for most presets; expo/elastic via worklet easings | §1.3 |

---

## 5. Decisions (owner, 2026-10-13)

1. **Destination: the full scene IR** (shader + native vector + filters +
   text). M1 builds the IR's renderer and exporter first; an SkSL-only layer
   is a subset of a scene, not an earlier stage.
2. **Separate `skia-*` defs** mirroring existing names and params (§3.1).
3. **Worklet timeline by default**; baked-into-shader is an option (§3.5).
4. **No Xcode on this machine.** Device truth runs in CI instead: the iOS
   simulator on GitHub's macOS runners, the Android emulator on Linux runners
   (KVM). Same capture contract as the web harness. Physical devices
   (EAS / TestFlight) are out of scope for now.
5. **Display P3 canvases accepted; programs color-managed; colors stay in
   the sRGB gamut** (revised 2026-10-14). React Native Skia 3.4.0 renders iOS
   canvases in Display P3 on P3 screens and offers no option; the library is
   not patched. Instead every runtime program toolbox generates (the fuser,
   the SDF compiler, the SkSL Shader node's wrapper, and so lane A's baked
   programs, which keep the generated main as `tbk_main`) runs its math on
   gamma-encoded sRGB numbers whatever the destination, and converts at the
   boundaries with Skia's intrinsics: main's result sRGB → working space,
   each child sample working space → sRGB. Color uniforms are plain `float4`
   of sRGB numbers (never `layout(color)`). A probe (`fromLinearSrgb(0.5, 0,
   0)`) skips the conversions where sRGB numbers already are working-space
   numbers — sRGB canvases and untagged surfaces — so toolbox, Android and
   the web are byte-identical to before. Native drawing is Skia's to convert.
   Manifests say `colorManaged: true`.
6. **Version policy:** `react-native-skia` and `canvaskit-wasm` are bumped
   together in one PR that re-runs `parity:skia` and the CI device lanes.
7. **Delivery:** a copy-in bundle folder (with `manifest.format`) for now; a
   private npm package once a second app consumes exports.

Frozen contracts (2026-10-13, additive changes only):
`src/engine/skia/scene-ir.ts` (scene IR + `Bind`), `src/engine/skia/shader-expr.ts`
(library function contract + fused-program shape), `src/lib/skia-export/api.ts`
(`exportSkia`), socket types `skia_draw` / `skia_shader`
(`SkiaDrawValue` / `SkiaShaderValue`), and `NodeDefinition.skia`
(`{ class, mirrors }`).

## 6. Milestones (revised for the scene IR)

- **M1 — foundation (Wave 1).** Lanes L1–L6 below: the CanvasKit scene
  renderer and the Skia Canvas terminal, the fuser and library infrastructure,
  the scene exporter, channel keyframes, device parity (headless compare + CI
  device lanes), and the editor surfaces (layer target, catalog filter, export
  action, MCP tools).
- **M2 — library fan-out (Wave 2).** `sksl` families and `native` families in
  parallel, each proven with `compare:skia` against the node it mirrors.
- **M3 — timeline shapes.** Baked-into-shader emitter, segments/markers,
  Reanimated-native transitions, spring easing.
- **M4 — completion.** Filters/`RuntimeShader` stages, text, Atlas, the
  `bake` class, procedural drivers (Expression → worklet).
- **M5 — polish.** Cost readout, docs pages, the `graph-to-sksl` skill.

## 7. Parallelisation plan (subagent lanes)

Conventions for every lane:
- Each lane runs in its own git worktree, branched from `skia-target`, with
  `node_modules` symlinked from the main checkout.
- A lane owns its files and builds against the frozen contracts. A contract
  change is proposed in the lane's report, never made silently.
- Shared registration points are append-only, single-line additions, and the
  integrator resolves conflicts there: `src/nodes/index.ts`,
  `src/lib/glsl-translation/classes.ts`, the `package.json` `check` chain,
  `scripts/toolbox-tool-defs.mjs`.
- Lanes do not drive the user's live editor over MCP (it runs the main
  checkout, not the lane's worktree).
- A lane is done when `npm run typecheck`, `npm run check` and eslint on its
  files are green, and its own gate exists and passes.

### Wave 1 (M1), launched 2026-10-13

| lane | owns | builds on | done when |
|---|---|---|---|
| **L1 Scene renderer + Skia Canvas** | `src/engine/skia/scene-render.ts`, `src/nodes/skia/canvas.ts` (`skia-canvas` terminal: `skia_draw` → image), first native nodes `skia-fill`, `skia-group`, `skia-shape` (circle/rect/path from a toolbox spline) | scene-ir.ts | `check:skia-scene` renders IR fixtures in CanvasKit (Node CPU surface) to golden pixels; `skia-canvas` renders in the editor |
| **L2 Fuser + library** | `src/engine/skia/fuse.ts`, `src/engine/skia/library/` (helper registry, `defineSkslNode()` factory), reference ports `skia-noise` (simplex) + `skia-color-ramp` | shader-expr.ts | `check:skia-library` compiles every library function + fused fixtures in CanvasKit; Aurora rebuilt from the two ports fuses to one program |
| **L3 Scene exporter** | `src/lib/skia-export/scene-plan.ts`, `scene-emit.ts`, `exportSkia`'s `skia-canvas` branch | scene-ir.ts, api.ts, M0 plan/emit | `check:skia-scene-export`: IR fixtures → JSX snapshot; ref → static/track/refusal; derived binds sampled |
| **L4 Channel keyframes** | evaluator channel block, `set_keyframes` channel names, channel diamonds in the param panel | — | `check:channel-keyframes`; GLSL + SkSL channels animate; `planSkiaExport` reads them |
| **L5 Device parity** | `scripts/skia-compare.cjs` (headless compare of any two fixtures), `bin/full` switch, CanvasKit in `build:export-template`, harness native capture mode, `.github/workflows/skia-device-parity.yml` (iOS sim + Android emu), golden frames | M0 harness | `npm run compare:skia` works offline; the workflow passes `actionlint` locally. Pushing / running it waits for the owner. |
| **L6 Editor surfaces** | layer `target` param + toggle, catalog filter by `def.skia`, export action (zip), `runtime.generated.ts` + `--check`, MCP `plan_skia_export` / `export_skia`, `get_catalog({target})` | api.ts | `check:mcp` covers the tools; a Skia layer filters the add-node menu |

Dependencies inside Wave 1 are contract-only: L3 tests against hand-written
IR, L6 against `exportSkia`'s current branches. No lane waits on another
lane's code.

### Wave 2 (M2): one subagent per family

Needs L1 (renderer), L2 (factory + fuser), L5 (`compare:skia`). At most 8
concurrent:

1. **noise & fields:** noise (11 algorithms), shape-cells, lyapunov,
   texture-coordinate. Float-hash rewrites documented here once.
2. **color:** solid-color, gradient, color-ramp variants, color-correction,
   rgb-curves, posterize, threshold, color-space-transform, keyer, dither
   (ordered).
3. **warps:** transform, mirror, polar-coords, pixelate, array.
4. **gathers:** displace, chromatic-aberration, sharpen, edge-detect,
   bevel-emboss, vector-field, flow-blur, kuwahara.
5. **SDF:** a `skia-sdf` compiler from `compileSdf`'s output.
6. **merge & blend:** merge (all formulas), opacity/mask semantics.
7. **vector shapes (native):** circle, rectangle, polygon, star, arc, line,
   wave, spiral, cross, arrow, spline-draw, svg-source → `shape` + path
   generators as derived binds.
8. **vector modifiers (native):** stroke/fill paint, trim-path, round-corners,
   dash, spline-boolean, transform, gradient fill.

### Not parallelisable

- **Contract changes** (scene IR, library contract, export API) go through one
  author and a freeze.
- **Integration** (registration lists, `check` chain, baselines) is serial.
- **Device bands** from L5's first CI run gate Wave 2 sign-off; ports can start
  against the web bands (exact).

## 8. Risks

- **Device divergence we haven't measured** (fp16, P3, Graphite). Mitigation:
  calibration first (M1), bands per platform, `float`-only library.
- **ES2 limits on ports.** Loops with uniform bounds become `break`-capped
  loops (cost at the cap on GPUs that don't early-out), and float hashes
  change the look of hashed nodes. Mitigation: documented once per family;
  the Skia version is the source of truth in Skia layers.
- **Per-pixel cost at 3× density.** A fused gather-of-gather that is free on
  a desktop GPU can drop frames on a phone. Mitigation: cost model + budgets
  + split into filter stages.
- **Two GL contexts in the editor.** CanvasKit's own context means an
  input round trip (M0) and separate context loss. Mitigation: §3.8.3,
  context-loss handler.
- **RN release cadence.** Reanimated/worklets/RN Skia move fast (worklets
  0.13, RN rc). Mitigation: pinned versions, `parity:skia` in the bump PR.

## Appendix A: file map (M0)

| path | role |
|---|---|
| `src/nodes/effect/sksl-shader.ts` | the node (+ `inspectSkslShader` for MCP) |
| `src/engine/skia/canvaskit.ts` | CanvasKit loader (script tag, `setCanvasKit` for harnesses) |
| `src/engine/skia/sksl-program.ts` | prelude, channel decls, lint, error mapping, compile cache, uniform packing |
| `src/engine/skia/sksl-render.ts` | Skia surface → engine image (premul → straight, Y flip), child images |
| `src/lib/skia-export/plan.ts` / `emit.ts` | planner + bundle emitter |
| `src/lib/skia-export/runtime/toolbox-timeline.ts` | keyframe evaluator as worklets (ships verbatim) |
| `scripts/export-skia.mts` | CLI (`npm run export:skia`) |
| `scripts/check-skia-export.mts` | gate (in `npm run check`) |
| `scripts/skia-parity.cjs`, `scripts/skia/parity-page.ts` | device(web) vs toolbox diff (`npm run parity:skia`) |
| `scripts/fixtures/skia/aurora.{sksl,ts}`, `aurora-graph.ts` | the port + its keyframed drivers |
| `scripts/copy-canvaskit.mjs` | postinstall copy into `public/canvaskit/<ver>/` |
| `skia-harness/` | Expo app: `App.tsx`, `index.web.ts`, `src/bundle/` (generated) |
| `src/state/recipe-builder.ts` | fix: channel-by-name wiring for channelSync nodes |
| `src/components/effects/mcp-handlers.ts` | SkSL errors in `get_shader_errors` / `get_graph` / screenshot |
