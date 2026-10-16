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
| `(x).eval(p)`, comments / line breaks between `x`, `.`, `eval`, `(` | OK — so a source rewrite must work on tokens, not a regex (2026-10-14) |
| shader-typed function parameter (`float4 f(shader s, float2 p)`) | **rejected** ("parameters of type 'shader' not allowed"); shader locals ("must be global"), shader arrays and ternaries of shaders too — a program's only shader values are its `uniform shader` globals |
| `RuntimeEffect.MakeForBlender` (runtime blender) | OK in CanvasKit; **not exposed by React Native Skia 3.4** (`RuntimeEffect.Make` is MakeForShader only, paint `blendMode` takes the enum; its web build uses MakeForBlender internally for plusDarker / plusLighter only) |
| CanvasKit's JS `MakeSweepGradient(…, startAngle, endAngle)` | the wrapper reads `endAngle` 0 as 360 (`M=M\|\|360`); Skia itself (a device) treats start = end as a collapsed sweep |

Semantics: `main` receives **local** coordinates, Y-down, pixel centres at
+0.5. The return value is **premultiplied**: an unpremultiplied return with
a < 1 composites too bright (probe: `(1, .5, 0, .5)` over blue → `(1, .5,
.5, 1)`). Int uniforms are passed as floats and cast per `isInteger`.
Unused uniforms are kept in the layout. CanvasKit exposes no child-shader
names (we parse them from source).

### 1.3 Reanimated 4.7 easing vs toolbox presets

Read from `react-native-reanimated/src/Easing.ts`. Only relevant for
`animation: "native"` exports (§3.5c, built in M3 with measured numbers).
The master-clock export uses toolbox's math and is exact regardless.

| toolbox | Reanimated | parity |
|---|---|---|
| linear, easeInQuad, easeInCubic, easeInSine, easeInBack | `linear`, `quad`, `cubic`, `sin`, `back()` | same formula |
| easeOut*/easeInOut* (quad, cubic, sine, back) | `out(f)` = `1 − f(1−t)`, `inOut(f)` | algebraically equal; last-ulp float differences |
| easeOutBounce | `bounce` | same formula (Penner constants) |
| easeInExpo / easeOutExpo | `exp` = `2^(10(t−1))` | **not special-cased at 0/1**: starts at 0.00098 / ends 0.1% short |
| easeOutElastic | — (`elastic(b)` is a different curve) | **none**: ship toolbox's formula as a worklet easing |
| cubicBezier | `Easing.bezier(x1,y1,x2,y2)` | same curve; different solver (4 Newton + 10 subdivision steps): ~1e-6 |
| hold | — | `withSequence` + `withDelay` + 0-ms set |
| spring (M3) | `withSpring` | toolbox's `spring` easing is Reanimated's solution from rest (≤ 1e-9; §2d, §3.5d) |

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
| F3 warps | skia-transform, -mirror, -polar-coords, -pixelate, -array | all MATCH (meanAbs ≤ 0.0013) | Gathers clamp to the outer texel centre to match CLAMP_TO_EDGE textures (`tbx.warp.texel`; since §3.3a the shared `tbx.texel`). |
| F4 gathers | skia-displace, -chromatic-aberration, -sharpen, -edge-detect, -bevel-emboss, -vector-field, -flow-blur, -kuwahara | 15/15 MATCH | Over the phone budget (32 units/px, an estimate): Flow Blur, Kuwahara (and Sharpen / Edge Detect over noise) → filter-stage split (built: §3.3a). Bevel outer/inner/pillow and Kuwahara r > 24 px refused. |
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
- ~~Displace `wrap=mirror` flips the whole image.~~ Fixed 2026-10-16: Displace and Displace (Skia) (`tbx.displace@2`) reflect only the out-of-range samples; check-skia-gather runs both wrap functions on CanvasKit. Polar Coords (GL + Skia) and Advect Image still use the old flipping formula.
- Trim Path cuts by segment parameter, not arc length (F8).
- The Text node blurs fractional translates (F8).
- Noise's CPU `value` aux doesn't match the GL image for value/phasor noise at seed ≥ 1 or w ≠ 0 (F1).
- Circle's "equal radii are round only on a square canvas" gotcha is wrong (F7).

**Carried to M3/M4:**
- Font and image assets aren't copied into exported bundles yet.
- ~~RN Paragraphs drop an inherited group blendMode.~~ Fixed in M4 lane T (§3.4b): the mode rides the paragraph's paint.
- ~~Filter-stage splitting for over-budget gathers.~~ Built 2026-10-14 (§3.3a, Wave 3 lane S).
- Device bands: CI lanes ready, not yet run.
- ~~The P3 decision (§2b).~~ Decided and built 2026-10-14 (§5.5).
- ~~`tbx.warp.texel` and `tbx.gather.edge` should become one shared helper.~~ Done: `tbx.texel` (§3.3a).
- ~~Merge (Skia) has no grow-on-wire / "+" layer button.~~ Done 2026-10-14 (Wave 3 lane C, §2e).

**Additive contract proposals collected (none applied):**
- `defineSkslNode`:
  - structural variants (F1);
  - wired-input flags in binds/unsupported (F2/F3/F4);
  - param-aware taps (F3/F4);
  - extra shader outputs and non-shader inputs (F2/F3);
  - a clock-dependency marker on binds (F2);
  - `float3x3` params (F2).
- `BindRef.offset` (affine canvas01 → px, F7); optional producer ids on SDF values (F5).
- ~~Text IR: `lineHeight` and a vertical anchor (F8).~~ Applied in M4 lane T (§3.4b), with `baselineOffset` and `letterSpacing`.
- `trim` inverted mode (F8).

## 2d. M3 results: timeline shapes + P3 (2026-10-14, on `main`)

The owner asked to "switch to p3 and then do the m3 work" and chose "identical everywhere" for P3. Five lanes ran in parallel worktrees and each merged to `main` after a full `npm run check` + `check:mcp` and `parity:skia` on every harness bundle. All harness slots (`bundle`, `bundle-scene`, `bundle-baked`, `bundle-native`, `bundle-native-easings`, `bundle-native-scene`) match toolbox on every frame, and each is byte-identical to a fresh `export-skia.mts` run.

| lane | what shipped | measured | gate |
|---|---|---|---|
| C: spring easing | `spring` keyframe easing whose curve *is* Reanimated 4.7's `withSpring` from rest, normalised to the segment (`engine/spring-easing.ts`, `Keyframe.spring {dampingRatio, settle?}`); `springToReanimated` / `springSksl*` for exporters (`lib/skia-export/spring.ts`); Spring tile + damping / settle fields in the editors; MCP `set_keyframes` easing `"spring"` | vs real Reanimated `withSpring` ≤ 1e-9 (measured 6.8e-13); energy snap at settle / 1.01, so the value is exactly B before the next key | `check:spring-easing` |
| A: baked | `animation: "baked"`: every program uniform planned as a track or sampled series becomes SkSL from `iTime` (`emit-baked.ts`): if-tree over keys, presets as closed forms, bezier via 8 Newton + 32 bisection, OKLab / RGB lerp + quantize, springs via `tbk_spring`; transcendentals as polynomials (CanvasKit CPU builtins are ~1e-4 off) | baked vs worklet: every frame of Aurora, Aurora scene and an every-easing fixture ≤ 1/255; `tbk_spring` 2.4e-7 vs reference (builtin version 2.2e-4) | `check:skia-baked`, `parity:skia -- --bundle baked` |
| B: markers + segments | per-composition timeline markers (`lib/timeline-markers.ts`, `SavedComposition.markers`, MarkerRuler on the Tracks / Layers rulers, MCP `set_markers`, transport seek by name); every bundle ships `toolbox-clock.ts`: `SEGMENTS`, `MARKERS`, `useToolboxClock()` → `{ time, play, pause, seek, playSegment, loopSegment, playAll, … }` (manifest format 3) | clock wraps frame-exact on fake frames, as TS and as the worklets plugin's output on an emulated UI runtime | `check-skia-segments` |
| D: Reanimated native | `animation: "native"`: one shared value per animated value on `withSequence` / `withTiming` / `withSpring`, `useToolboxAnimations()` → `{ values, play, playSegment, stop }` (`emit-native.ts`, `reanimated-easing.ts`) | §3.5c: exact on a steady 60 Hz clock (≤ 7.5e-6 of range, 0 frames late); jittered vsync pushes a step a frame late | `check:skia-native`, `parity:skia -- --bundle native*` |
| CM: P3 colour management | every generated program does sRGB math and converts at its boundaries (`tbx.color.cm`, `engine/skia/library/color-management.ts`); colour uniforms plain `float4`; manifests `colorManaged: true` | sRGB vs Display P3 ≤ 1/255 on every generated program (uncorrected: up to 116/255); sRGB output byte-identical to before | `check:skia-color-management` (§5.5, §4) |

**Integration (while merging):**
- **Worklet capture order.** Lane C's runtime had `easeOf` calling `springEase`, declared below it. The worklets Babel plugin turns worklet functions into consts that capture their callees when created, so every exported bundle threw "Cannot access 'springEase' before initialization" on RN web and device. Node hoists functions, so no gate saw it until the harness ran. The spring block now sits above `easeOf`; `check-skia-export` checks that each runtime function calls only functions declared above it, and `check-skia-native` does the same for every emitted native module.
- **Mode choice everywhere** (`lib/skia-export/animation-modes.ts`): the param panel's export action has an *Animation* dropdown (worklet / baked / native, remembered per browser; the zip and toast name the mode). MCP `plan_skia_export` / `export_skia` take `animation`; the plan runs the chosen mode's emitter so its refusals show, and the export's `note` says how to mount that mode. Covered in `check-skia-layer`.
- The baked P3 warning from lane A is gone: baked programs keep the colour-managed main as `tbk_main`.

**Open after M3:**
- **Device runs (CI dispatch, owner's OK).** Each needs an on-device run to confirm:
  - P3 on-screen colours: CI snapshots are untagged and can't see them; Metal's fp16 intrinsics may add ~0.5/255.
  - Native mode under real iOS / Android vsync, and at 120 Hz.
- **Native drawing on P3.** ~~Native gradients (up to ~24/255)~~ lowered to color-managed programs, ≤ 1/255 (§2e). Translucent overlaps (~28–38/255) and native group / draw blend modes (srcOver-family exact for an opaque source; the color blends 55–255/255, per mode in §4) still shift: React Native Skia 3.4 exposes no runtime blender, so they can't be lowered on device. Fused Merge (Skia) is exact.
- **Native mode:**
  - ~~`playSegment(…, { from: "current" })` starts colours at the segment start~~ — colours now continue from the colour on screen (§2e, §3.5c);
  - ~~segment playback is verified offline, not by harness pixels~~ — `parity:skia -- --bundle native* --segment <name>` captures it (§2e);
  - each window edge inside a key segment adds a cut easing (89 in the easings fixture).
- **Baked mode:** a scene's binds outside programs stay on the worklet timeline (warned in the manifest).
- ~~**SkSL Shader:** an `iImageN` passed into a user helper function is sampled without conversion~~ — SkSL can't pass a shader into a function at all (§1.2); the holes were parenthesized and comment-split samples, now converted (§2e).
- **Still carried from §2c:** font / image assets in bundles (filter-stage splitting and the shared texel helper: built, §3.3a).

## 2e. Wave 3 (M4) results (2026-10-14, on `main` at ebf3489)

Eight lanes worked in parallel worktrees. The integrator merged them in the order A, I, C, P, T, then F + S + B. Every merge was verified on the merged tree before `main` moved:
- every harness bundle regenerates byte-identically;
- `npm run check`, `check:mcp`, the lint ratchet, and the harness tsc + `export:web` pass.

At ebf3489 there are **14 parity slots**, and all match toolbox on every frame:
- effect, scene, baked;
- native, native-easings, native-scene;
- atlas, image, procedural, procedural-baked, text, filters, split, bake.

| lane | what shipped | headline numbers | details |
|---|---|---|---|
| A, Copy to Points (Skia) | `skia-copy-to-points`: vector copy groups below 16 copies, one sprite-sheet `<Atlas>` (useTexture + useRSXformBuffer) from 16; Point / Grid / Space Fill / Voronoi allowed in Skia layers | atlas vs GL Copy to Points MATCH max 1/255 (opaque instance); web cost 0.3 ms/frame at 4,096 copies vs 213 ms for groups | §3.4a |
| I, images + assets | the one URL → bytes seam (`engine/skia/asset-bytes.ts`, `registerSkiaAssetScheme`), async editor / MCP export with bytes under `assets/`, Image (Skia), image leaves, SkSL Shader `iImage1..4` export, ramp / curve channels as 256×1 LUT children | `--bundle image` pixel-identical; LUTs 0/255 at texel centres (≤ 1/255 on P3) | §3.8.2–3.8.3 |
| C, carried polish | gradients lowered to colour-managed programs; token-based SkSL sample rewrite; Merge (Skia) grow-on-wire; native `from: "current"` colours; segment parity | gradients P3 vs sRGB 24/255 → ≤ 1/255 at 2.1–3.2× the GPU cost; 11 native segments MATCH | below |
| P, procedural drivers | Expression (a real parser, no eval) / LFO / Math / Scene Time / Random / Constant / Animated Value chains compile into `procedural.ts` worklets, SkSL for baked mode, and the native linear clock; an `expr` bind plan | 162,540 values bit-identical to `evaluateGraph` (V8); baked: 97.1% within 1e-6, all within 4× an fp32 error bound | §3.5e |
| T, text | lineHeight / anchor / letterSpacing / baselineOffset; fonts that ship (Inter, Geist + OFL, uploads); paragraph blend modes; **the editor's Text node no longer applies automatic optical sizing** (owner's decision: Inter above 14 px is ~9% wider in the editor, matching devices) | 24/24 text pairs MATCH; `--bundle text` 0/255 | §3.4b |
| F, filters | Blur, Bloom, Grain, Lens Flare, Drop Shadow, Morphology, Color Matrix, SkSL Filter (`filter` class); additive `layer.blendMode`; emulated-layer margin; Liquid Glass refused (owner: skip the Frost subset for now) | the mirrors MATCH their GL nodes (Bloom at intensity 4.5 CLOSE: 8-bit layers); `--bundle filters` 0/255 at 512 and 256 | §3.2a |
| S, stage splitting | over-budget fused Fills split into `<RuntimeShader>` layers (`engine/skia/split.ts`); one texel helper (`tbx.texel`); a cost readout | Edge(Kuwahara(N)) 1648 → 195 units/px; split vs GL MATCH except the high-gain chain (CLOSE); `--bundle split` 0/255 through a web shim | §3.3a |
| B, bake | `skia-bake`: an engine image wired in through the Layer Input, shipped as one PNG or a frame sprite sheet; `bake:` resolves through lane I's seam | `--bundle bake` 10/10 frames 0/255, and it holds between ticks | §3.2b |

**Integration decisions:**
- Lane I's asset seam is canonical. Lane B dropped its duplicate and registers `bake:`.
- `AssetIR.license` uses US spelling (lane T's `licence` was folded into it).
- Lane F's `SceneRenderOptions.layerFormat { colorSpace, f32 }` absorbed lane S's `layerColorSpace`.

**Facts the lanes established:**
- RN Skia web has no `<RuntimeShader>` image filter. Grain, Bloom, Lens Flare and SkSL Filter are native only; the split slot plays through `skia-harness/runtime-filter-web.ts`, which mirrors the renderer's emulation and is not a measurement of native Skia.
- RN Skia 3.4 has no runtime blender API, so native blend modes can't be made exact on P3.
- RN Skia native ignores variable-font axes (`fontVariations`).
- SkSL rejects shader-typed function parameters.

**Open after M4 (needs devices or owner decisions):**
- **Device runs** (CI dispatch, once `main` is pushed). They should cover:
  - native `<RuntimeShader>` filters and split layers;
  - P3 on-screen colour and Metal fp16;
  - Hermes `Math` vs V8 for procedural drivers;
  - native vsync jitter in native mode;
  - Graphite PNG decoding for bakes;
  - CoreText ink.
- **Not lowerable:** native blend modes and translucent overlaps on P3.
- **Liquid Glass:** refused; a Frost-only subset is possible.
- **Kuwahara r > 24 and Bevel outer / inner / pillow** stay refused. They need dedicated ports, not splitting.
- **Bloom draws its content levels + 1 times.** An image-filter Blend graph would draw it once.
- **GL bugs found** (outside this work): Copy to Points image mode darkens AA edges; Lens Flare's "transparent background" description is wrong (it writes alpha 1).

### Lane C: carried polish (2026-10-14)

| item | what shipped | measured | gate |
|---|---|---|---|
| P3: native gradients | Every gradient ShaderIR (linear / radial / sweep / conical, as leaves too) draws and exports as a color-managed runtime program (`engine/skia/library/gradient-program.ts`): Skia's gradient semantics on sRGB numbers — unpremultiplied piecewise-linear stops, positions pinned monotonic, the four tiles, Skia's degenerate rules — then `tbx_cm_out`. The renderer (`scene-render.ts`) and the exporter (`planSceneExport` → `lowerSceneGradients`) lower the same way, always (one export for iOS and Android) — inside Copy to Points (Skia) sprite sheets (`atlas.texture`) too, beside lane I's image leaves, assets untouched; the IR is unchanged. Stop colors stay their own Binds (tracks stay tracks); positions pack four to a float4. | P3 vs sRGB: native up to 48/255 (red → blue 24/255) → **≤ 1/255** on 48 gradients; vs Skia's native gradient on sRGB ≤ 1/255; GPU preview (`compare:skia` Gradient Fill pairs vs Rasterize Spline) interior 0/255. Cost below. | `check:skia-color-management` §6a, `check:skia-scene`, `check:skia-scene-export` |
| P3: blend modes | Researched, not lowerable on device: React Native Skia 3.4 has no runtime blender API (§1.2); the gate re-checks its sources on every bump. Each of the 29 modes measured on P3 (§4). | exact on P3: src, dst, dstOver, srcIn, dstIn, srcOut, dstOut, dstATop, xor, clear; srcOver / srcATop for an opaque source only (38/255 at 50 %); the rest 55–255/255 | `check:skia-color-management` §6b |
| SkSL Shader samples | The `main` / `iImageN.eval(` rewrite works on tokens: a sample in a helper, `(iImage1).eval`, comments or line breaks between its tokens, and `main /* … */ (` are all converted (the regex left the last three raw). Ordinary sources rewrite to the same text (no bundle changed). | helper / paren / comment samples P3 ≡ sRGB ≤ 1/255; the same samples unconverted 31/255 | `check:skia-color-management` §3 |
| Merge (Skia) grow-on-wire | The layer-stack UX keys on the `merge_layers` param, not `defType === "merge"`: the header "+", the per-row eyes and grow-on-wire work on Merge (Skia); grow-on-wire stops at the param's `max` (8 enabled layers on Merge (Skia)). | — (UI: live-app question) | `check:skia-merge` §1 |
| Native `from: "current"` colours | A colour's offset from the segment's start colour (in its OKLab / RGB mixing space) fades by a weight running 1 → 0 over the segment's first move with that move's timing and easing; colorAt exactly at weight 0. §3.5c. | colours start within 0/255 of the colour on screen (they jumped up to 236/255); join toolbox's frames by the end of the first move; the fade equals 1 − the move's eased fraction to 1e-9 — transcription and Reanimated's real sources | `check:skia-native` §3c |
| Harness segment capture | `native-harness.tsx ?segment=<name>` plays `playSegment(name)`; `parity:skia -- --bundle native* --segment <name>` scores those frames against toolbox's at the segment's offset. | all 11 segments of the 3 native slots (Aurora intro / loop / flash, easings intro / rise / mid / settle / tail, scene intro / loop / flash): **MATCH**, max 1/255, ≥ 99.95 % identical, drift ≤ 8.7e-6 of range, 0 frames late | `parity:skia -- --segment` |

**Gradient program cost.** GPU, Chromium WebGL2 (ANGLE Metal, Apple M5 Pro; CanvasKit 0.41.0 Ganesh), ms per full 1024² fill (40 fills × 40 frames, flush + 1-px readback; a solid fill 0.010): linear 2 stops native 0.026 / program 0.056 (2.2×); radial 6 stops 0.030 / 0.063 (2.1×); sweep 6 stops 0.037 / 0.078 (2.1×); conical 6 stops 0.039 / 0.094 (2.4×); linear 17 stops 0.038 / 0.088 (2.3×); linear 49 stops (an OKLab Gradient Fill) 0.047 / 0.152 (3.2×; 7.0× with a first, linear-chain ramp — the shipped ramp is a binary if-tree to the stop interval). Uniforms: n stops take n + ⌈n/4⌉ + 2 vec4 slots (49 stops: 66 uniforms, 252 floats). CanvasKit's CPU raster runs the program ~100× slower than a native gradient (the gates render small). Device GPUs: not measured (no Xcode here, §5.4).

**Not done / for the integrator:**
- Blend modes stay native (no device API); a scene with a non-srcOver draw blend shifts on P3 by the §4 per-mode numbers. A future RN Skia with `MakeForBlender` would make the lowering a renderer + emitter change (the gate fails then, on purpose).
- `scene-emit.ts`'s LinearGradient / RadialGradient / SweepGradient / TwoPointConicalGradient emitters are now unreachable from `exportSkia` (plans are lowered) and kept for hand-built plans. `checkExportable` (scripts/skia/export-check.ts) compiles the lowered programs, so every family gate checks them.
- Baked mode gains gradients: their animated stops / geometry are program uniforms now, so the baker bakes them (adding an iTime) instead of leaving them on the worklet as native gradient props were — the scene fixture's keyframed stop color, baked vs worklet at every frame: 0/255 (`check:skia-baked`).
- A one-off Electron WebGL page measured the cost above (not committed); `check:skia-color-management` prints CPU-relative times only.

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
| `bake` | not live-exportable, but renderable | image asset (one PNG, or a sprite sheet stepped by the clock) + `Image` — built as Skia Bake (§3.2b) | simulations, ML, 3D, video, stateful nodes, any engine effect (blur / bloom over noise) |
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

#### 3.2a built and measured: the `filter` class (M4 lane F, 2026-10-14)

Eight nodes in `src/nodes/skia/` (shared code `filter-shared.ts`), each
`skia: { class: "filter" }` with a `content` skia_draw in and out. A filter
returns a Skia Group whose `layer` filters the content (RN `<Group
layer={<Paint>…</Paint>}>`); runtime programs are hand-assembled around
`tbx.color.cm` (`filterProgramSksl`). The mirrors carry the GL node's own
ParamDefs (`mirrorParams`).

| node | mirrors | lowers to | notes |
|---|---|---|---|
| Blur (Skia) | blur (gaussian) | `Blur` σ = r/2, tile clamp; linear light = `srgbToLinear` layer inside a `[Blur] + linearToSrgb` layer | σ binds as `radius × 0.5` (scaled track). Past the GL cap (64 taps, r ≈ 43) the GL kernel is truncated: σ is the truncated kernel's variance-matched one (`glBlurSigma`, derived bind). Bokeh / convolve refuse. |
| Bloom (Skia) | bloom | isolate{ content, levels × group{ layer [threshold RuntimeShader, `Blur` σ_j], blendMode srcATop }{content} } | One Gaussian per mip level with that level's variance through Bloom's chain (`bloomLevelSigmas`: σ ≈ 1, 3.8, 7.9, 15.9, 32, 64 px at quality high, Karis on); per-level tint products × intensity (`bloomLevelWeights`). The bright pass returns **alpha-0 additive light**; srcATop then gives `D + glow·Da, alpha Da` — Bloom's straight-alpha composite exactly, any source alpha. |
| Grain (Skia) | grain (classic) | RuntimeShader | Classic already hashes with a float hash (hash13): ported line for line, cell = floor((x, H − y)/scale) — **no look change**. The v2 models (uint pcg3d, multipass) refuse. |
| Lens Flare (Skia) | lens-flare | isolate{ group{[bright, ghosts+halo, Blur 1.29]}, group{[bright, streak, Blur 1.29], plus} } | GL passes ported in the GL uv frame, every sample clamped like CLAMP_TO_EDGE; ≤ 27 + 21 taps in two stages (budget 32 each). A σ 1.29 blur stands in for the GL half-res passes. `output: over` adds it over the content. |
| Drop Shadow (Skia) | — | `Shadow` (drop / inner, shadowOnly) | blur is a CSS-style radius: σ = blur/2. |
| Morphology (Skia) | — | `Morphology` | Skia's square (2r+1)² window, radius rounded (measured: 1.4 → 1, 1.5 → 2). |
| Color Matrix (Skia) | — | `ColorMatrix` on the layer | 4×5 on unpremultiplied colour, offsets in 0..1 (measured). `adjust` = CSS Filter Effects matrices in a fixed order; `custom` = 20 numbers. Derived bind (sampled when animated). |
| SkSL Filter (Skia) | — | RuntimeShader | The SkSL Shader node's contract (prelude, lints, `// ch()` channels, error lines) with one child, `content` (`engine/skia/sksl-filter.ts`). Channels bind as `ch:<name>`: keyframes / wires export as tracks. Ramp / curve channels refuse (their LUT children cannot ride a one-child RuntimeShader filter); a parenthesised receiver, `(content).eval(…)`, is not rewritten to the colour-managed sampler (lane C made the SkSL Shader rewrite token-based; this one is still pattern-based). |

**Additive contract change:** `SkiaNode` group `layer.blendMode?:
BlendMode` — the layer paint's blend mode, how the filtered layer
composites (RN `layer={<Paint blendMode>}`; renderer and emitter both
implement it). A group's own `blendMode` reaches the draws *inside* the
layer, never the layer — so Bloom's srcATop and Lens Flare's plus need it.

**compare:skia** (GL node over the CanvasKit-rendered content vs the Skia
mirror, same drawing; 512², frames 0 / 60 / 120, ANGLE Metal, CanvasKit
bin/full; `scripts/fixtures/skia/filters-graph.ts`):

| pair | verdict | mean meanAbs | worst p95 | worst max |
|---|---|---|---|---|
| blur r 12, linear light | MATCH | 0.0021 | 3/255 | 18/255 |
| blur r 12, sRGB | MATCH | 0.0012 | 1/255 | 17/255 |
| blur r 3, linear | MATCH | 0.0024 | 3/255 | 7/255 |
| blur r 70 (past the GL cap) | MATCH (σ r/2: CLOSE 0.0157) | 0.0078 | 9/255 | 46/255 |
| blur keyframed 2 → 24 | MATCH | 0.0025 | 3/255 | 23/255 |
| bloom defaults / Karis off | MATCH | 0.0044 / 0.0043 | 6/255 | 33/255 |
| bloom balanced / performance | MATCH | 0.0050 / 0.0052 | 6–7/255 | 37/255 |
| bloom tinted + anamorphic 0.6, 5 levels | MATCH | 0.0029 | 3/255 | 24/255 |
| bloom intensity 4.5 | **CLOSE** | 0.0142 | 28/255 | 70/255 |
| grain classic (overlay / add + chroma / soft-light / grain view / keyed seed) | MATCH | 0.0002 | 1/255 | **1/255** |
| lens flare defaults / 8 ghosts + diagonal / output over (vs Lens Flare → Merge add) | MATCH | 0.0011 / 0.0017 / 0.0009 | 1–3/255 | 16–40/255 |

The max errors sit at the canvas edges (GL clamps the edge texel; Skia
blurs the drawing beyond it) and, for linear light, in dark gradients (the
8-bit linear layer). Bloom intensity 4.5 is the documented limit: a level's
bright pass × weight above 1 clips before its blur (8-bit layers, and
`tbx_cm_premul_out` clips like an 8-bit canvas), where Bloom keeps float16.

**parity:skia `--bundle filters`** (`skia-harness/src/bundle-filters`: keyframed
Morphology → Blur → Drop Shadow → Color Matrix, web-playable): 512², 8 frames
— **pixel-identical (0/255, 100 %)**. At `--size 256` (the 512 px
composition scaled 0.5 by the exported root group) — **pixel-identical** to
the scene IR drawn under the same scale, and against the editor's 512² frames
box-downsampled MATCH (meanAbs 0.0016–0.0019) where the keyed Morphology
radius scales to a whole pixel, CLOSE (0.011–0.014) where Skia rounds the
scaled radius differently (r 1 → 0.5 → 1 px at 256). Filters scale with the
canvas.

**`check:skia-filters`** (CPU, ~60 s): the variance derivation behind
`bloomLevelSigmas` equals a phase-averaged 1-D simulation of Bloom's GL
chain to < 0.1 % (2.4 % for anamorphic, whose tent offsets leave the
quarter-texel grid); Morphology exact; Color Matrix ≤ 1/255; Drop Shadow ≤
2/255 over Skia's own blur; SkSL Filter 0/255; every runtime filter
program P3 ≡ sRGB ≤ 0.46/255 (management forced off: 38.6/255); every
fixture canvas exports; worklet / baked / native exports compile and
type-check.

**Renderer / emitter fixes:**
- The emulated runtime-filter layer (CanvasKit has no RuntimeShader filter)
  now runs on a margin sized to the chain's native filters, as native Skia
  sizes a filtered layer: content just off the canvas blurs in, and a blur
  after a runtime stage no longer fades at the canvas edge (0/255 vs native).
- `SceneRenderOptions.layerFormat` (additive): emulated layers in the
  target's colour space / F32 — alpha-0 light does not survive a colour
  conversion.
- `emit-baked`: a program reached by two paths (Bloom draws its content
  levels + 1 times) is baked once; its added iTime is found by bind, not path.
- Atlas sprite sheets (lane A): a filter inside a Copy to Points (Skia)
  instance renders into the sheet with the emulated layers sized to the
  SHEET, not the canvas. Measured (gate, 128², 3×3 copies): atlas vs
  groups of a Blur instance mean 0.56/255, of a Grain (runtime) instance
  0.63/255; both export with the filter inside the `useTexture` element.
- Assets (lane I) ride through every filter on `SkiaDrawValue.assets`
  (Bloom's repeated content draws included): an Image (Skia) behind Blur →
  Bloom ships its bytes (gate).

**Not ported / limits:**
- **Runtime filters are native-only.** RN web throws on `<RuntimeShader>`
  filters, so Grain, Bloom, Lens Flare and SkSL Filter export
  `webPlayable: false` (manifest + warning) and their RN pixels are not
  measured here — the renderer's emulation and compare:skia are.
- **Liquid Glass: refused.** Its default mode (Frost off) mixes the sharp
  and the blurred backdrop per pixel by edge distance, at refracted
  coordinates, and then runs the non-linear LCH fresnel / glare on the mix:
  one program needs both images. RN Skia's `<RuntimeShader>` filter binds
  exactly one child (`MakeRuntimeShader(builder, null, null)`); the
  multi-input factory is not a JSX element and throws on web; blurring
  inside the program instead costs (6σ + 1)² taps — 625 at the default
  blur 8, 20× the 32-unit budget. Its `shape` SDF input is spliced GLSL
  (needs the F5 SkSL SDF compiler). A Frost-only / blur-0 subset fits one
  input (`[Blur, glass program]` over the content inside an isolated
  layer) — the path when it is wanted.
- Bloom: lens dirt, `bloom_only`, Karis's per-pixel firefly weighting
  (approximated by its effect on the kernel width), intensity above ~3 on
  white. Cost on device: content drawn levels + 1 times (an image-filter
  Blend DAG would draw it once, but RN's `<Blend>` filter splices the whole
  filter stack and the IR has no filter DAG).
- On a Display P3 iPhone the glow's srcATop add and the Color Matrix run on
  the working space's numbers like every native blend (Bloom whole scene,
  P3 vs sRGB: max 24/255, mean 1.3/255) — lane C's P3 residual class.

**To verify on device:** RN's RuntimeShader filter under the scaled root
group (the emulation evaluates per device pixel in parent-local coords; if
Skia's runtime filter handles only translation it evaluates at canvas
resolution and resamples); alpha-0 light through Graphite's layers.

**Native toolbox bug found:** Lens Flare's description says it outputs the
flare "(transparent background)"; its composite writes alpha 1 (opaque
black). The Skia mirror follows the pixels.

#### 3.2b The `bake` class: built and measured (Wave 3 lane B, 2026-10-14)

**Skia Bake** (`skia-bake`, `src/nodes/skia/bake.ts`, `skia: { class:
"bake" }`) puts an ENGINE image inside a Skia layer and ships it as pixels:
one PNG at canvas size when it doesn't change over the timeline, otherwise a
**sprite sheet** of frames that the exported clock steps through. Params:
*Bake* (Auto / Static PNG / Sprite sheet), *Bake FPS* (0 = the timeline's),
*Max sheet* (2048 / 4096 / 8192 px per side).

**Wiring rule.** A Skia layer still holds only Skia nodes. The engine
graph that makes the picture stays OUTSIDE the layer, and its image comes in
through a Layer Input socket (minted by dragging onto the Layer Input's empty
port) or the Layer Input's `backdrop`, wired into the bake's `image`.
Flatten splices the Layer Input wire, so the evaluator and the exporter see
source → Skia Bake. No engine node is sanctioned inside the layer:
- the add-node menu would have to offer the whole catalog there;
- the layer would stop reading as "what ships".

The validator's refusal for an engine node inside a Skia layer now names
this route.

**Preview.** The node reads its input back at canvas size and makes an
UNPREMULTIPLIED CanvasKit image (`engine/skia/bake-frames.ts`). It files
the image in the context's node state under the AssetIR object its output
carries: a ring of 4 per node, deleted by dispose. It returns one `image`
draw of the asset `bake:<nodeId>` over the canvas. The Skia Canvas resolves
`bake:` URLs from those frames (`withBakeFrames`). The image stays unpremul
because CanvasKit decodes the shipped PNG unpremul and filters it that way.
A premultiplied copy of the same bytes draws identically 1:1 but differs
when scaled.

**Export** (`lib/skia-export/bake.ts`).
- **Sampler.** The GL-less scene sampler stops at the bake's input
  (`scene-sample.ts`).
- **Planning.** `planSceneBakes` plans every `bake:` asset in the scene.
  *Auto* reads the graph upstream of the image:
  - keyframes;
  - clip windows;
  - `stable: false` / `tickDriven` defs;
  - `fingerprintExtras` that differ between probe ticks. Noise's
    `animated` and an SkSL Shader reading `iTime` are caught only by this.
- **Animated bakes.** The draw is rewritten into
  `<Group clip={rect}><Image image={sheet} x={X(f)} y={Y(f)} width={SW} height={SH} fit="fill"/>`.
  - X / Y are **hold binds**: additive `Bind.hold`, sampled per frame,
    emitted as `seriesStep`.
  - Every tick therefore shows `floor(frame)`'s cell, fractional ticks
    included.
  - All three animation modes carry them on `sampleBinds`:
    - worklet: the master clock;
    - baked: non-program binds stay on the worklet timeline;
    - native: the native linear clock.
- **Sheet layout** (`AssetIR.sheet`, additive). Cells are row-major with
  1-px edge-repeat gutters. Frames are full size when they fit under the
  cap; otherwise the largest aspect-kept size that does, with a warning. The
  manifest carries the layout and the tick of each cell.
- **Bytes.** The bytes come through lane I's asset seam: the async
  pre-pass `withSkiaAssets` (editor.ts) collects the tick-0 scene's assets
  (`collectSkiaExportAssets`, which applies the bake rewrite so it sees the
  sheet), resolves them, and hands them to the synchronous `exportSkia` on
  `SkiaExportRequest.assets`. `bake:` is a registered scheme on
  `engine/skia/asset-bytes.ts`; with no frame renderer it fails with the
  reason, which the export's warning quotes. `exportSkiaWithBakes`
  (editor.ts; the editor, MCP and the CLI) hands the pre-pass a resolver
  that answers `bake:` first and passes every other URL to
  `env.resolveAsset`. The preview never fetches bake bytes: it draws the
  live frames.
  - Bake URLs render through `env.renderBakeFrames`, the host's real-engine
    renderer:
    - the editor: `renderSkiaBakeFrames`, with the source forced as the
      terminal inside the export-resolution bracket;
    - MCP `export_skia`: the same function, passed through deps;
    - the CLI: headless Electron, `scripts/skia-bake-frames.cjs`.
  - Renders happen at composition ticks, so a late layer's in-point is
    added.
  - The renders are checked against Auto's verdict. A "static" bake whose
    5 probe frames move, or an "animated" one whose frames are all
    identical, is re-exported in the other mode once. Nothing is rendered
    twice.
  - PNGs are encoded byte-exact by `lib/skia-export/png.ts`
    (`CompressionStream`).

| what | result |
|---|---|
| `parity:skia -- --bundle bake` (128², animated Noise → Blur baked under a keyframed native ring, RN Skia 3.4 web) | **pixel-identical**, 10/10 frames 0/255, 100.00 % identical; motion 0.136 |
| …the same frames captured at f + 0.5 and f + 0.999 vs toolbox frame f (outside the ring's swept band) | 20/20 at 0/255: the baked frame holds between ticks |
| `compare:skia -- --a bake:blur --b bake:skb` (the engine image vs the Skia Canvas drawing the bake) | MATCH, 8/8 frames 0/255 |
| CanvasKit CPU, shipped clipped-sheet `<Image>` vs the preview's frame, 7 cells with translucent pixels | scale 1, 2, 0.5: **0/255**. Scale 1.37: 30/255 on ≤ 4.8 % px (AA'd clip edge vs image-rect edge, plus 6 interior px of float precision at large offsets) |
| …the alternatives | ImageShader + clip: same as `<Image>` at every scale. Atlas: 0 at 1, 2, 0.5, but 60/255 at 1.37, and RSXform is uniform-scale only. **A zero RSXform makes CanvasKit's drawAtlas draw nothing at all**: other sprites must be parked off-canvas. No gutter: 70/255 at 2× (neighbour-cell bleed) |
| premultiplied preview copy vs the decoded PNG | 0 at 1:1; 41/255 at 2×, 27 at 0.5, 40 at 1.37, which is why the preview stays unpremul (unpremul ≡ decoded PNG at every scale) |
| emitted `sampleBinds`, 61 frames × {+0, +0.25, +0.5, +0.999} | 241/241 exactly `floor(frame)`'s cell. An interpolated series would sit between two cells |
| Bake FPS 20 on 60 fps | 21 cells, each held 3 timeline frames (warned) |
| native mode on Reanimated's stand-in, steady 60 Hz | every frame its own cell |
| native mode, jittered vsync | ±0.05 ms and ±1 ms: 29/61 frames show the previous cell, **0 differ from the worklet master clock** (both read time; an early frame shows its clock time's cell; nothing accumulates) |
| fixture sheet | 61 cells (frames 0…60) of 128² → 4030 × 260, 806,686 B PNG (19.2 % of raw RGBA) |
| caps | 301 frames × 512² @ 4096 → 225² cells (43.9 %), 18 × 17, 4086 × 3859. 121 × 1080 × 1920 @ 4096 → 255 × 453; @ 8192 → 511 × 908 |

Not measured: the editor's bake render time on hardware, the device
(Graphite) decode and filtering of the sheet, and on-device vsync. The
type-checks pass for all three modes.

Open:
- **Clock jitter.** Under a jittery clock a held cell follows its clock
  time, in both modes. If devices jitter, snapping the clock to the frame
  grid within a tolerance would fix it.
- **Preview cost.** The preview readback is a sync GPU stall per changed
  frame (the §3.8.3 GPU path would remove it).
- **MCP.** `export_skia`'s 10 s MCP timeout is short for long bakes.
- **Scaled sheets.** A scaled-down sheet loses resolution: measured 167/255
  max, 19/255 mean at 92 %.

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
pass over a `Group`), or refuses. *Built (§3.3a): Skia Fill splits
automatically; when nothing saves, it stays fused and says why — it never
refuses.*

When a layer contains `filter` or `native` nodes the output is a **tree**:
`Group`s of native drawing, a fused `Shader` per contiguous `sksl` region,
filters on `Group layer` props. Same IR, so the same preview path.

#### 3.3a Stage splitting: built and measured (Wave 3 lane S, 2026-10-14)

`src/engine/skia/split.ts`, called by Skia Fill. A gather re-evaluates its
upstream once per tap, so cost multiplies (Sharpen 9 × a 4-unit noise = 36
units/px). Over the phone budget (32 units/px, `PHONE_PIXEL_BUDGET`), the
Fill renders the gather's upstream U **once** into a layer, and the gather
runs as a runtime image filter over it:

```
fill(K(U))  →  group { layer: { imageFilters: [{ k: "runtime", program: K(content), content: "s0" }] } }
                 └─ fill(U)  (blendMode src, default paint)
```

React Native gets `<Group layer={<Paint><RuntimeShader source uniforms/></Paint>}>`. The scene IR, `scene-render.ts`'s emulated layers and `scene-emit.ts` were already there; no new IR kind and no special path. The editor preview is the split.

- **Plan.** The split is greedy and structural. While a stage is over the budget, the planner tries every distinct upstream that feeds a gather input:
  - each read of it is replaced by the layer;
  - it keeps the split that saves the most (old cost − filter − U − `SPLIT_LAYER_COST` 2);
  - it then re-plans both halves.

  The re-plan is what makes chains work: U may be over budget itself, and a later upstream that *contains* the layer becomes the next, outer layer. Fan-out comes free, because every read of U goes to the one layer: several gathers, and plain reads too.

  Costs are **declared** (taps `"param"` → 9). An animated radius therefore never flips a split, which the scene planner would refuse as a structure change.

  Splits are skipped when:
  - the filter would need a second layer;
  - the filter would keep any other child shader. RN's `<RuntimeShader>` binds the content as the only child.
  - the Fill has its own non-srcOver blendMode. The IR's `layer` has no blend mode.
- **Reading the layer.** Taps on the texel grid (`gridTaps`: Sharpen, Edge Detect, Kuwahara, Dither) fetch a texel centre directly: exactly the texel the fused program re-evaluated there.

  Off-grid taps (Flow Blur, Displace, Bevel's scaled stencil, anything inside an off-grid gather) go through `tbx.split.bilinear@1`. It mixes the four centres, which is the GL texture's own LINEAR + CLAMP_TO_EDGE rule. The program therefore never depends on the sampler: the preview's emulation samples nearest, native Skia linear.

  The shared texel helper `tbx.texel` (`tbx_texel_clamp`) replaced `tbx.gather.edge` and `tbx.warp.texel`. The gathers, the warps and the splitter all use it.
- **What a layer can't hold.**
  - A layer is a colour image, so it clips straight values outside [0, 1]. Functions flagged `unbounded` are never layered: Sharpen's overshoot, Edge Detect's magnitude × strength. A range audit in the gate keeps the flag honest at node defaults.
  - Measured on Edge(Sharpen(noise)): layering the sharpen put 1 % of pixels ≥ 42/255 off (max 144). The planner stages the noise instead.
  - A layer rounds to 8 bits, and every high-gain kernel after it amplifies the rounding.
- **Paint.**
  - The Fill's colour alpha × opacity fade the filtered result (`tbx.split.paint@1`), not the content.
  - An enclosing Group's opacity / blendMode reach the content draw, per RN's per-draw rule. A layer composites srcOver.
- **With the other Wave 3 lanes.**
  - An image leaf (lane I) or a gradient leaf (lane C) inside the split upstream becomes a child of the layer's own fill program.
  - The image's asset still rides the staged draw value. The gradient is lowered to its colour-managed program wherever it is drawn or exported.
  - The split draws what the fused Fill draws, within the kernel's rounding (≤ 2/255 measured). It exports with the asset, and with the lowered program compiling.
  - A leaf *outside* the upstream would stay in the filter, so that split is skipped.

**Cost readout** (units/px, declared → after; "at params" is the frame-0 values via `tapsAt` / `costAt`; `check:skia-split` prints all):

| canvas | split | declared | at params (f0) | notes |
|---|---|---|---|---|
| gather `shp`, `shp_x` (Sharpen over noise) | 1 layer | 36.2 → 15.2 | 36.2 → 15.2 | under budget |
| gather `edge` (Edge Detect over noise) | 1 layer | 32.3 → 14.3 | 32.3 → 14.3 | under budget |
| gather `fb` (Flow Blur, field = Vector Field(noise)) | 1 layer, bilinear | 185.7 → 95.1 | 999.2 → 424.6 | the field is staged; the image (4-unit noise) is cheaper than a 4.2-unit bilinear read and stays fused |
| gather `fb_t` | 1 layer, bilinear | 221.7 → 99.1 | 609.8 → 229.6 | the same |
| gather `fb_n` (Flow Blur over two noises) | — | 75.0 | 267.0 | nothing saves |
| gather `kuw` (Kuwahara r 3 → 7 animated) | 1 layer | 206.0 → 185.0 | 159.5 → 78.5 | Kuwahara's own ALU (170) stays |
| gather `kuw_a` (anisotropic) | 1 layer | 222.3 → 201.3 | 461.8 → 224.8 | |
| gather `bev`, `bev_h` (Bevel over noise) | — | 40.6 | 20.6 | the stencil is off-grid, so the bilinear reads cost more than the noise |
| split `chain` Edge(Kuwahara(N)) | 2 nested | 1648.3 → 195.3 | 1276.3 → 88.8 | |
| split `fan` Merge(Sharpen(N), Edge(N)) | 1 shared | 69.5 → 24.5 | 69.5 → 24.5 | under budget |
| split `combo` Merge(Edge(Kuwahara(N)), Kuwahara(N)) | 2 nested + plain read | 1855.3 → 197.3 | 1436.8 → 90.8 | the parity slot |
| gate: Edge(Sharpen(N)) | 1 (the noise) | 289.9 → 79.9 | | the sharpen isn't layered (it overshoots) |

**Measured.**

Exactness, `check:skia-split`, CanvasKit CPU at 64×48 with edges included:
- Over an 8-bit-exact upstream, every on-grid gather draws the fused program's bytes **exactly**. That covers sharpen ×4 kernels, edge ×2 and Kuwahara.
- Off-grid reads equal a CPU bilinear of the layer's bytes, ≤ 0.5/255.
- Over real noise the error stays within ceil(½ Σ|w|) + 1 steps: unsharp 1.5 max 2/255, box 2 × N max 6, fan max 4. Chains are held by mean and p99: Edge(Kuwahara) mean 0.7/255, p99 5.
- On Display P3 surfaces with P3 layers vs sRGB: Sharpen max 4/255, Flow Blur max 1, chain p99 7.

`compare:skia`, 512², ANGLE Metal, split canvas vs the GL node. The "before" column is the fused Skia preview vs GL:

| pair | before (fused) | split | split vs fused |
|---|---|---|---|
| gather `shp` | MATCH 0.00033, max 1 | MATCH 0.00155, max 3 | 0.00148 |
| gather `shp_x` (cross 1.5) | MATCH 0.00063, max 1 | MATCH 0.00728, max 7 | 0.00725 |
| gather `edge` (prewitt, strength 2–6) | MATCH 0.00062, max 11 | MATCH 0.00618, max 18 | 0.00614 |
| gather `fb` | MATCH 0.00035, max 48 | MATCH 0.00035, max 24 | 0.00005 |
| gather `fb_t` | MATCH 0.00218, max 69 | MATCH 0.00204, max 63 | 0.00288 |
| gather `kuw` | MATCH 0.00033, max 1 | MATCH 0.00146, max 2 | 0.00134 |
| gather `kuw_a` | MATCH 0.00034, max 24 | MATCH 0.00049, max 24 | 0.00036 |
| split `chain` (edge strength 1.5–4) | MATCH 0.00093, max 6 | **CLOSE** 0.00904, p95 9/255 | 0.00901 |
| split `fan` | MATCH 0.00058, max 4 | MATCH 0.00316, max 11 | 0.00311 |
| split `combo` | MATCH 0.00073, max 5 | MATCH 0.00607, max 17 | 0.00604 |

All other gather pairs are unchanged (fused, MATCH). The price of a split is the 8-bit intermediate × the gain of the kernels after it. Kuwahara and Flow Blur average it away; Sharpen cross 1.5 multiplies it by about 13, and Edge Detect at strength 4 by about 23 (`chain` CLOSE). The GL node's fp16 texture is about 4× finer. A `highBitDepth` RN canvas (F16 layers on iOS) would close this, but Android's 10-bit has 2-bit alpha, so it isn't emitted.

Web parity, `parity:skia -- --bundle split`, `combo` with two nested layers and four tracks: **pixel-identical**, 8/8 frames, 0/255.

RN web has no runtime image filter: RN Skia 3.4's `RuntimeShaderBuilder` and `MakeRuntimeShader` throw. The harness therefore plays the emitted JSX through `skia-harness/runtime-filter-web.ts`, which records the layer, binds it as a 1:1 picture shader and runs the program as scene-render's emulation does. This parity measures the emitted structure, uniforms and timeline, not native Skia's filter. The device lanes have to measure that, along with whether native samples the content at 1:1 texel centres under a scaled RN canvas.

**Refusals: does splitting lift them? No.**
- **Kuwahara r > 24.** The cap is the constant loop bound, not where the taps come from. Kuwahara's own ALU (≈ 1.5 units/tap) dominates: over an already-rendered layer it costs 283 units/px at r 6 and 4,483 at r 24, which is 140× the budget at the cap. At r 48 it would be ≈ 18,000.
- **Bevel outer / inner / pillow.** These read a JFA distance field: log2(size) ping-pong passes of a coordinate field, then a shade that needs both the field and the image. A split stages one gather's upstream into one layer, and a `<RuntimeShader>` reads one child. A JFA chain of ~10 nested runtime filters, with coordinates packed into 8-bit RGBA, is a dedicated port, not an automatic split.

**Contract changes (additive):**
- `fuse.ts`: `estimateShaderCost(expr, { at?: "declared" | "params" })` and `shaderExprKey`. The fuse signature is unchanged.
- `scene-render.ts`: emulated layers take `SceneRenderOptions.layerFormat.colorSpace` (lane F's option, which absorbed lane S's `layerColorSpace` at merge). The default is sRGB, as before.
- `registry.ts` (not frozen): `SkslLibFunctionDef.gridTaps / tapsAt / costAt / unbounded`.
- The scene IR, `shader-expr.ts`, `exportSkia`, the socket types and `NodeDefinition.skia` are untouched.

**Open:**
- **Device runs.** Native `<RuntimeShader>` sampling and layer bounds; P3 8-bit layers, measured here only as CanvasKit P3 surfaces.
- **A precision-aware policy.** Skip a split right before a high-gain kernel when the program is near the budget. Sharpen cross over noise trades 2.4× fewer units for meanAbs 0.007.
- **`layer.blendMode` in the IR**, so a Fill with its own blend mode can split.
- **Flow Blur.** Its image and field can't both be layers (one content per filter).

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

- Every bindable value is static, a track (exact replay, §2.3), or a
  worklet expression compiled from a procedural driver subgraph
  (Expression's JS, LFO, Math, Scene Time, Random…), so procedural drivers
  ship too. *Built in M4 (Wave 3 lane P, §3.5e): the planner's `expr` bind
  kind, not an IR change.*
- **Preview:** a CanvasKit renderer for the IR (`src/engine/skia/scene-render.ts`)
  that evaluates `Bind`s at the current tick, using the same
  `toolbox-timeline.ts` the device runs.
- **Export:** an emitter from the IR to RN Skia JSX + `timeline.ts`. Tracks
  become `useDerivedValue(() => evaluateTrack(T, tick(time.value)))`.
  Paths with animated geometry use `usePathValue` / `usePathInterpolation`
  when topology matches, otherwise per-frame `PathData` via the worklet.

#### 3.4a built and measured: Copy to Points → Atlas (Wave 3 lane A, 2026-10-14)

`skia-copy-to-points` (`src/nodes/skia/copy-to-points.ts`) mirrors Copy to
Points with its own ParamDefs plus `strategy` (auto / groups / atlas). Image
and text modes take a Skia drawing (`skia_draw`) and draw one copy per point;
spline and point modes run the GL node's own CPU path and output a spline /
points for Skia Shape. Point / Grid / Space Fill / Voronoi are now offered in
Skia layers; Voronoi skips its GL image when the context has no GL (the
exporter's data-only sampler), so its centers / vertices / cells still come
out. Each copy is the GL vertex shader's transform in scene px,
`p + R(rotation + rotate_add)·S(scale·scale_mul)·(x − anchor)`. The uniform
modulation is a separate factor about `p`, so keyframed Scale × / Rotate + over
static points ship as two tracks.

- **groups:** two Groups per copy. The outer one is `T(p)·R(add)·S(mul)`
  (direct binds → tracks); the inner one is `R(rot)·S(scale)·T(−anchor)`
  (derived → static or sampled). Rotations and uniform scales commute, so the
  product is the GL transform exactly. The emitter writes the shared
  instance once, as `const E0 = (…)`, and every copy references `{E0}`. A
  Fill inside the instance is clipped to the canvas, matching the GL node's
  canvas-sized instance. Other content is not clipped.
- **atlas:** the instance is rasterised once into a sprite sheet: its
  analytic box (`engine/skia/scene-bounds.ts`) plus 2 px, or the canvas for
  unbounded drawings. One `<Atlas>` then draws it with an RSXform per copy.
  RSXform has a single scale, so non-uniform per-point scale falls back to
  groups.
- **Additive IR** (`scene-ir.ts` atlas):
  - `texture?: { node, rect }` — the sheet as a sub-scene. Preview: an
    offscreen surface at the surface's density, cached across frames.
    Export: `useTexture(<Group scale AK translate −rect>…)`, with
    `AK = PixelRatio × root scale`, so the sheet is crisp at 3×. Sprite rects
    are multiplied by AK and xform scales divided by AK. Two atlases of one
    drawing share one texture.
  - `pivots? / rotate? / scale?` — a uniform spin / zoom about each sprite's
    pivot, `T(p)·R·S·T(−p)·xform`. In the export it is one
    `useRSXformBuffer` whose worklet repeats `composeAtlasXforms`, with the
    spin / zoom as one derived value.
- **Planner refusals:** a sheet renders once, so any non-static bind inside a
  `texture` refuses the export and tells the user to switch the strategy to
  groups.
- **Content centre:** the GL node anchors on an alpha bbox read back at
  128 px. `glContentCenter` reproduces that grid from the analytic box. It is
  exact for circles, rects and blobs, but up to one readback texel off
  (4 px at 512²) where a narrow tip falls between the readback's taps.

**Exactness** — compare:skia, real engine, 512², frames 0/20/40/60
(Rotate + / Scale × keyframed), Apple M5 Pro (ANGLE Metal), CanvasKit 0.41.0:

| case | atlas vs GL Copy to Points | groups vs GL Copy to Points |
|---|---|---|
| opaque instance (`gl_opq`: star over a full-canvas fill, 3×3 grid) | **MATCH**, max 1/255, 99.96–99.97 % identical; edge band max 1/255 | MATCH by meanAbs (0.0007), but edge band p95 88/255, max 177/255 (vector edges vs a resampled raster) |
| star on transparency, canvas-centre anchor (`gridc`, `--premul-a`) | alpha meanAbs 0.0000, interior identical, band p95 25/255, max 64/255 | alpha 0.0029, interior identical, band p95 49/255, max 122/255 |
| content-centre anchor (grid / Voronoi / Point) | band p95 ≈ 214–226/255: the star's tips put the GL anchor one readback texel away (above) | same |

Pixel equality against the GL node needs an opaque instance. The GL image
mode's anti-aliased edges are wrong on transparency: it writes premultiplied
colour into its straight output, and it bilinear-samples a straight texture.
Coverage (alpha) still matches; colour on edges doesn't. This is a native bug,
filed as a task, and is what `compare:skia --premul-a` partly undoes.

Atlas vs groups within Skia (`gridc`): CLOSE (meanAbs 0.011), interior
identical, band p95 44/255. CPU (check:skia-atlas): ≤ 2/255 at integer
placement, and the same at a 2× surface. Rotated / scaled copies agree in ink
mass to ≤ 1 % and centroid to ≤ 0.05 px.

**Cost** — `npm run bench:skia-atlas`: CanvasKit WebGL (RN web's Ganesh), the
same M5 Pro, 512², star instance (two AA paths), mean ms per frame including
the GPU wait, over 120 frames:

| copies | 1 | 4 | 16 | 64 | 256 | 1,024 | 4,096 |
|---|---|---|---|---|---|---|---|
| groups (Rotate + animated) | 0.54 | 0.59 | 1.35 | 4.34 | 14.8 | 54.3 | 213 |
| atlas (Rotate + animated) | 0.29 | 0.24 | 0.32 | 0.27 | 0.31 | 0.34 | 0.62 |
| groups / atlas (static) | 0.49 / 0.29 | 0.60 / 0.26 | 1.33 / 0.27 | 4.35 / 0.29 | 14.6 / 0.31 | 52.4 / 0.52 | 216 / 0.62 |

- Groups cost about 0.45 ms plus 0.05 ms per copy. The atlas is flat; its
  one-time sheet raster costs about 1 ms on the first frame.
- **There is no cost crossover on the web target:** the atlas is cheaper at
  every N (0.54× at 1, 0.24× at 16, 0.06× at 64).
- **`auto` picks groups below `ATLAS_AUTO_MIN` = 16 copies.** There they stay
  ≤ 1.35 ms (about 8 % of a 60 Hz frame here), and they buy vector edges:
  crisp under scale-up and at device density, a drawing that may animate, no
  texture memory.
- **From 16 copies, `auto` picks the atlas.** Groups there cost ≥ 4× the atlas
  and grow linearly.

Device Graphite and the RN reconciler / Reanimated mapper cost are not
measured. Animated group transforms are one derived value per copy; the atlas
is one RSXform buffer.

Export size for 1,600 copies (a 40×40 grid):

| | atlas | groups |
|---|---|---|
| static: export time | 57 ms | 2.0 s |
| static: ToolboxScene.tsx | 79 KB | 474 KB |
| static: binds | 17 | 35,200 |
| moving points (keyframed grid width): timeline.ts | 7.3 MB of sampled xforms + pivots (the planner warns) | 63 KB |
| moving points: per-frame JS | one RSXform buffer | 1,601 `useDerivedValue`s (one per copy) |

In the groups bundle, columns share one series.

**Web parity** (`parity:skia -- --bundle atlas`, `skia-harness/src/bundle-atlas`):

| measure | result |
|---|---|
| verdict | **MATCH** on 7/7 frames (0–60) |
| scene | two atlases (static; tracks) + a groups copy (sampled) |
| meanAbs | 3e-5 |
| identical pixels | 99.18–99.57 % |
| differing pixels | about 1,200, all on sprite edges, ±1 premultiplied step (max 23/255 straight rgb at alpha 11) |
| motion check | f0 vs f60 meanAbs 0.116 |

RN web rasterises the sheet in its own OffscreenCanvas WebGL context; the
exact source of the step is not isolated.

Open:
- In image mode, `tint_attr` / `opacity_attr` (atlas `colors`) and variant
  picks are not mirrored.
- Image-asset instances still go through a texture; lane I's `skia-image`
  could feed its asset straight into the atlas.
- Moving points under an atlas ship N×4 floats per frame. Pivot-relative
  xforms would halve that, and lane P's procedural drivers could remove it.
- `auto` can't see whether the instance animates, so that case is refused
  with the fix named.

#### 3.4b built and measured: Text (Wave 3 lane T, 2026-10-14)

Text (Skia) now mirrors the Text node's layout options one for one, and
its fonts are the ones an export can ship. Gate: `check:skia-text`. Pixel
proof vs the Text node: `compare:skia` on `scripts/fixtures/skia/text-graph.ts`
(24 pairs). RN web proof: `parity:skia -- --bundle text`
(`skia-harness/src/bundle-text`, `?bundle=text`).

**Text IR, additive** (`scene-ir.ts` `text`):
- `lineHeight` — px between baselines. SkParagraph still breaks the lines
  and places each one horizontally (`getLineMetrics`: UTF-16 ranges,
  `left`), but every line is drawn as its own run exactly `lineHeight`
  below the last. SkParagraph's own pitch can't do it: `InternalLineMetrics::height()`
  rounds to whole px with any strut / height multiplier (probed: 48 px ×
  1.4 → 67, not 67.2).
- `anchor` — `baseline` (the first line's baseline) / `top` / `middle` /
  `bottom` of the block (N × lineHeight, or the laid-out height). Absent:
  v1's meanings (baseline without a width, top with one).
- `baselineOffset` — line-box top → baseline. The producer supplies its
  own rule (Chromium's `middle` + em-box offset), so renderers need no
  font metrics; absent, CSS half-leading from the font's ascent/descent.
- `letterSpacing` — SkParagraph's: half the spacing before each glyph,
  half after (Chromium puts it all after; same line widths), so Text
  (Skia) shifts x by −ls/2. Paragraphs only: one-line `<Text>` refuses it.
- Fonts carry lane I's `AssetIR.license` (the OFL text's URL); lane I's
  asset seam ships it beside the bytes. Inter's licence file is new
  (`public/fonts/Inter-OFL.txt`).

**Renderer and emitter.** `scene-render.ts` `drawText` and the emitted
`makeTextPicture` worklet (`scene-emit.ts`, recorded into an `SkPicture`
for `<Picture>`) run the same algorithm. The first baseline is computed
once, and a `baseline` anchor is `y` itself: glyphs snap to a position
grid, so a round trip through the block top flipped glyphs a pixel on
1-ulp differences. v1 text (no new field, no blend) still emits one
`<Paragraph>` and `makeParagraph`, byte for byte.

**Blend.** React Native Skia 3.4's paragraph builder takes a foreground
paint (`pushStyle(style, paint)`; web: `pushPaintStyle`), and RN never
applies the group paint to it. So the emitter folds the innermost group's
`blendMode` (a paint's own mode wins) into that paint, beside the group
opacities it already folded. A layer `Group` with the blend was rejected,
measured on CanvasKit:
- multiply is the same either way (≤ 1/255);
- srcIn / dstIn as a layer wipe the backdrop around the glyphs (249,948 of 262,144 px differ).

What the Wave 2 export shipped instead (the blend dropped):
- 3,749 px up to 122/255 for a multiply group at 0.6;
- 4,380 px up to 73/255 for a paint's own difference.

**Fonts** (`src/nodes/skia/fonts.ts`). A Skia layer draws only what ships:
- Inter and Geist from `public/fonts`, both OFL 1.1. Their licences sit beside them; `Inter-OFL.txt` is new.
- An uploaded Custom font, as a `data:` asset of its bytes.
  - It is parsed for metrics and axes.
  - WOFF / WOFF2 / collections refuse.
  - The uploader is responsible for its licence.

The Text node's "Inter" is the same file: globals.css registers it under
that name, weight 100 900 (gated). Every curated Text-node family has an
answer. Only Inter ships. The 17 Google families refuse as not bundled,
the 5 system families as OS-licensed. Installed fonts refuse with the
upload hint. The preview draws Inter meanwhile and the export refuses.

**Variable fonts draw their default instance everywhere** (Inter: opsz 14,
wght 400). React Native Skia 3.4's native `JsiSkTextStyle` never reads
`fontVariations`; only its web build passes them to CanvasKit (pinned in
the gate). An axis the preview applied would therefore not reach a phone.
So `font_weight` ≠ the default, `font_variations`, synthetic bold (a
static face at ≥ 600) and italic all refuse.

**The editor draws the default optical size too** (owner's call,
2026-10-14: "fix opsz in editor"). Chromium applies `opsz` automatically
(optical size = font px, clamped to Inter's 14–32), so the Text node used
to draw Inter "Hello Skia" at 64 px 275.219 px wide (opsz 32) where a
Skia layer, like a phone, draws 299.875 px (opsz 14): 8.2 % / 23 px.

Mechanism, measured in Electron (Inter registered as globals.css does):

| route | 20 / 32 / 64 / 96 px | |
|---|---|---|
| none (before) | 91.143 / 137.609 / 275.219 / 412.828 | auto opsz |
| `font-optical-sizing: none` on the DOM-attached canvas | 93.711 / 149.938 / 299.875 / 449.813 | = the default instance; ≤ 14 px unchanged (46.855 at 10, 65.598 at 14) |
| the same on a DETACHED canvas | unchanged | the style isn't resolved |
| `font-variation-settings: "opsz" 14` (canvas style or @font-face descriptor) | = the default instance | but it pins opsz over a user's own value |

So `text-raster.ts` `applyAxisStyling` sets `font-optical-sizing: none`
on the raster canvas before every font assignment. That covers the Text
node and every other caller of the engine's text rasterizer (Copy to
Points' text mode, Point Labels), for every variable font with an
`opsz` axis; static fonts are unaffected. An `opsz` (or `wght`) a user
sets in `font_variations` on a Custom font still applies in the editor
(measured: `'opsz' 32` with sizing off → 275.219 px; `'wght' 700` →
308.582 px). React Native Skia's native text ignores those axes, so Text
(Skia) keeps refusing non-default instances.

**A visible change to existing projects:** Inter in a Text node above
14 px now draws its opsz-14 (Text) design instead of the display cut. It
gets WIDER and looser, not tighter: 9.0 % wider at ≥ 32 px, 2.8 % at
20 px, unchanged at ≤ 14 px. Line breaks in wrapped Inter text can move.
The face proof below now measures the node through `applyAxisStyling`
itself, and `check:skia-text` pins the styling call.

**Face proof** (the 2026-09 fallback trap). `text-graph.ts`'s
`ready()` (a new optional `SkiaGraphFixture.ready`, awaited by
compare:skia) measures every Text node's lines through the engine's own
styling (`applyAxisStyling` on a DOM-attached canvas). Each must equal
SkParagraph shaping the intended file at the axes the node draws (default
opsz, wght = weight) within 0.05 px, and differ from `sans-serif`. Results:
- 33 lines;
- |Δ| ≤ 0.0055 px at whole-px sizes;
- sans-serif 4–35 px off.

At a fractional size (40.96 px) the file shapes 0.095 px short. FreeType
(CanvasKit) sets sizes in 26.6 fixed point; that proof allows 1/128 px per
px. The Skia side proves its asset bytes are the file.

**Measured vs the Text node** (`compare:skia`, 512², ANGLE Metal, CanvasKit
bin/full; geometry from `scripts/skia/text-ink.cjs`):

| pairs | verdict | identical px | geometry |
|---|---|---|---|
| f_geist / f_custom (Geist 64 px; uploaded) | MATCH | 99.16 / 99.02 % | ink box Δ 0 px, x drift ≤ 0.30 px |
| f_inter14 (Inter by name) | MATCH | 99.05 % | box ±1 px (FreeType hinting at 14 px), drift ≤ 0.99 px |
| f_inter64 | MATCH | 99.07 % | box ±1 px, drift ≤ 0.42 px (was CLOSE, 97.39 %, box −12 / +11 px, before the editor's opsz fix) |
| a_left / a_center / a_right (3 lines) | MATCH | 98.70 / 98.68 / 98.71 % | 3/3 lines, edges ≤ 1 px, drift ≤ 0.27 px |
| v_top / v_middle / v_bottom (leading 1.5, translated box) | MATCH | 99.02 % each | 2/2 lines ≤ 1 px (block at rows 67 / 174 / 281 both sides) |
| l_090 / l_120 / l_160 (wrapped) | MATCH | 96.80 % each | 4/4 lines ≤ 1 px (at 0.9 Chromium's heavier ink bridges the lines) |
| w_208 / w_320 / w_464 (wrap widths, mixed align / vAlign) | MATCH | 97.56 / 97.12 / 96.38 % | 6/6, 4/4, 4/4 lines ≤ 1 px |
| ls_px / ls_pct (6 px; 0.5 %, wrapped) | MATCH | 99.27 / 98.54 % | drift ≤ 0.31 px (3 px before the −ls/2 shift) |
| c_upper / c_title | MATCH | 98.99 / 98.83 % | box ≤ 1 px |
| b_multiply / b_difference / b_screen / multiply at 0.6 (Merge over a color vs Skia Group blend) | MATCH | 93.73 / 98.78 / 98.78 / 98.80 % | interior max 1/0/0/0 /255 |

Every MATCH pair's interior (`edge-band.cjs`) is 0/255 apart from b_multiply
(1/255). The rest is the anti-aliased edge band, where Chromium (CoreText)
lays 8–15 % more ink than CanvasKit (FreeType). Wave 2's paint pairs t1–t4
still MATCH.

**Gate numbers:**
- The IR's baselines equal the Text node's `drawTextBlock` over 324 combos (≤ 1e-9 px).
- Per-line drawing puts every glyph where the whole paragraph does (≤ 2.7e-4 px).
  - SkParagraph's own float32 run positions drift that much by line 10.
  - The pixels flip in 211 of 180,069 ink px.
- The emitted `makeTextPicture` / `textBaselineY`, run through an RN-Skia shim on CanvasKit, are pixel-identical to the renderer (32 + 6 cases).

**RN web** (`parity:skia -- --bundle text`):
- the bundle holds a sampled-size wrapped paragraph, Inter with letter spacing and a moving anchor, a 0.85 difference group, and a `<Text>` run — all on the bundled Geist / Inter, whose bytes and OFL texts ship in `assets/` through lane I's seam;
- 8/8 frames identical, max 0/255; motion 0.044.

**Open:**
- **Devices are unmeasured.** iOS (CoreText) should draw ink closer to
  the Text node's than the web does; Android is FreeType like the web.
- **Edge cases left as SkParagraph does them:**
  - the Text node collapses runs of spaces when wrapping; SkParagraph keeps them;
  - a word wider than the box overflows in the Text node, but SkParagraph breaks it;
  - SkParagraph floors a fractional box width, so wraps can differ by a word there (the fixture uses whole-px widths);
  - fractional sizes shape ≤ 1/128 px per px off Chromium (FreeType 26.6).

### 3.5 Animation export: three shapes from one track IR

a. **Worklet timeline (default, built in M0).** Exact, one clock, app
   controls time. M3 adds **markers and segments** (toolbox timeline markers →
   `SEGMENTS = { intro: [0, 1.2], loop: [1.2, 5] }` + `useToolboxClock`
   helpers: `playSegment`, `loopSegment`, `seek`). Designers then author
   "intro then idle loop" states that app code triggers. *Built in M3
   (§2d lane B): `toolbox-clock.ts` in every bundle.*
b. **Baked into the shader** (the owner's "single shader with the animation
   baked in"). Tracks compile to SkSL piecewise functions of `iTime`: an
   unrolled `if` chain over keys, presets as closed forms, cubic-bezier via
   8 Newton + 32 bisection steps (constant bounds), OKLab + 8-bit quantise
   reproduced in float. One file, zero JS per frame; but no scrubbing,
   segments or interaction except through `iTime` itself. Parity
   expectation: ≤ 1e-6 per value (fp32 vs JS doubles). The gate compares
   it per frame against the worklet path. Best for ambient loops. *Built in
   M3 (§2d lane A): `animation: "baked"`, ≤ 1/255 vs worklet every frame.*
c. **Reanimated-native transitions.** For app state changes (tap → expand),
   export per-property `withTiming(target, { duration, easing })` using
   §1.3's mapping. Exact presets map directly; expo/elastic ship as worklet
   easing functions copied from `toolbox-timeline.ts`; `cubicBezier` →
   `Easing.bezier`.
d. **Springs (new).** Add a `spring` easing to toolbox whose evaluator *is*
   Reanimated 4's spring solver (`springUtils.ts`: duration + dampingRatio
   or mass/stiffness/damping). Preview and device then share the physics,
   and exports emit `withSpring(config)`. The analytic solution is a worklet
   too, so mode (a) replays it exactly. *Built in M3 (§2d lane C).*

#### 3.5c built and measured (M3 lane D, 2026-10-14)

`exportSkia({ …, animation: "native" })` (CLI `--animation native`) for both
targets, SkSL Shader and Skia Canvas: `src/lib/skia-export/emit-native.ts`.
The bundle gains `animations.ts` (one exported `<value>Animation()` per
value, `TRACKS`, `SEGMENT_STARTS`, `useToolboxAnimations({ autoplay, loop })`
→ `{ values, play, playSegment, stop }`) and `toolbox-native.ts` (`colorAt`,
`looped`, `segmentEase`); it ships lane B's `toolbox-clock.ts` (SEGMENTS,
MARKERS) and manifest segments like every bundle. The component takes
`animations` instead of `time`. A scene keeps its sampled binds and `iTime`
in `sampleBinds`, read from a native linear-clock shared value.
`playSegment(name, { loop, from })` plays every value over one SEGMENTS
window from its value at the segment start (`from: "current"`: every value
animates on from where it is — an interruption; colours since Wave 3 lane C,
below). A window edge inside a
key segment — a marker mid-curve, keys before frame 0 or past the end — is
a `tbxCut*` worklet easing that replays toolbox's curve over the cut as the
fraction of its move, so cuts stay exact (the easings fixture has 89).

`from: "current"`, measured (lane C, 2026-10-14). A scalar's first step is
a withTiming / withSpring from wherever the value is, so it runs from there
to its target along the step's own curve. A colour is a mix of per-segment
progresses, which can't start anywhere else, so it gets the same motion
explicitly: `colorOffset` takes the colour on screen minus the segment's
start colour in the track's mixing space (OKLab or gamma RGB, lerpColor's),
and `colorFrom` adds it back weighted by `<key>FromWeight`, which
`<key>FromSegmentAnimation(segment)` runs 1 → 0 over the window's first
move with that move's timing and easing — a linear glide over a lead before
the first key (a scalar's lead wait), a stepped wait for a hold, withSpring
for a spring, the move's own withTiming otherwise. At weight 0 `colorFrom`
is `colorAt`, so `from: "start"` and `play()` are bit-identical to before.
`check-skia-native` §3c, every segment of the three slots, interrupted from
the values 37 % of the timeline away: scalars start exactly where they are,
colours within 0/255 of the colour on screen (they used to jump up to
236/255), the fade equals 1 − the move's eased fraction to 1e-9 (a lead:
linear to 1e-5, the 1 µs frame margin), and every value joins from
"start"'s frames by the end of that move — the transcription and
Reanimated 4.7's real sources play the same doubles.

| toolbox | emitted | class | measured vs `easeOf` |
|---|---|---|---|
| linear, easeInSine, easeIn/Out/InOut Quad (+ aliases), easeIn/OutCubic, easeOutBounce | `Easing.linear / sin / quad / out(quad) / inOut(quad) / cubic / out(cubic) / bounce` | exact | 0 (bit for bit) |
| easeOutSine, easeInOutSine, easeInOutCubic, easeIn/OutBack | `out(sin)`, `inOut(sin)`, `inOut(cubic)`, `back(1.70158)`, `out(back(…))` | last ulp | 1.1e-16 – 6.7e-16 |
| cubicBezier, customBezier (scalar; normalised handles) | `Easing.bezier(x1, y1, x2, y2)` | solver | ≤ 2e-6, checked per segment (ordinary shapes 1.7e-7 – 9.9e-7) |
| …a shape Reanimated's solver misses (vertical tangent: (1,0,0,1) by 5.5e-2) | toolbox's `cubicBezierEase` as a worklet easing | custom | 0 |
| easeInExpo, easeOutExpo, easeOutElastic | toolbox's `easeOf` as a worklet easing (`Easing.exp` is 9.8e-4 off at the ends, `Easing.elastic` is another curve) | custom | 0 |
| hold | `withDelay(d, withTiming(next, { duration: 0 }))`; first step: `withTiming(next, { duration, easing: Easing.steps(1, false) })` | hold | 0 |
| spring (lane C) | `withSpring(next, springToReanimated(key, ms))` from rest + a wait to the next key when it settles early | physics | lane C: ≤ 1e-11 × \|B − A\| |
| a segment cut by a window edge (marker, timeline end) | `tbxCut*`: toolbox's curve over the cut | custom | 0 (≤ 7.5e-6 of range played, the 1 µs margin) |
| a preset this exporter doesn't know; a customBezier between equal keys with moving handles; a cut whose ends are equal while the curve between moves | refused with the reason | — | — |

Colors animate one 0..1 progress shared value per segment (eased by
Reanimated, `withSpring(1, …)` for springs) and `colorAt` mixes the keys with
toolbox's own OKLab / RGB lerp (copied verbatim from the runtime at export)
plus the 8-bit snap — bit-identical to `evaluateTrack` at the same
progress (gate: 4,677 samples incl. overshoot, holds, springs).

**Drift, measured.** Reanimated (4.7, web) driven by the harness's fake 60 Hz
clock (`parity:skia -- --bundle native*`), and offline by a Reanimated
stand-in that plays Reanimated's real animation sources bit-identically
(`check-skia-native`; the stand-in also matches the harness to ≤ 1 ulp on
the samples where they differ: 11 of 9,000 steady, 6 of 9,000 jittered):

| clock | Aurora (SkSL, 4 values) | every-easing fixture (30 values, 5–7 steps each) | Aurora scene (3 tracks + clock) |
|---|---|---|---|
| steady 60 Hz | ≤ 6e-7 (5e-7 of range), 0 frames late; pixels 8/8 MATCH, max 1/255 on ≤ 0.04 % | ≤ 7.5e-6 of range (e_in_expo), 0 frames late; pixels 13/13 MATCH, max 1/255 on ≤ 0.04 % | ≤ 1e-6, 0 late; pixels 8/8 MATCH |
| ±0.05 ms vsync jitter | worst 1.5 % of range, 1 value-frame one late | 97 value-frames one late; worst = a whole hold step for one frame (40 % of range), colors ≤ 62/255 at a hold switch | worst 1.5 % |
| ±1 ms | 1.4 % | 75 value-frames late, same worst cases | 1.4 % |

What makes the steady-clock column exact, each found while measuring:
- **Float noise at step boundaries.** Reanimated ends a step on the first
  frame with `now − start ≥ duration`; 47 frames is 783.33… ms, and frame
  timestamps minus start land a hair under it about half the time, so the
  step ends a frame late and every later step of that value follows
  (measured before the fix: up to 6 % of range by f154). Every emitted
  duration now ends 1 µs early (`frames(n)`), which costs ≤ 1e-5 of range.
- **A leading `withDelay` shows the wrong value on RN web.** A fresh web
  shared value's `_animation` is `undefined` (native: `null`), and
  `withSequence` then hands its first step the sequence's own last step as
  "previous animation"; a first-step `withDelay` displays that step's target
  for the whole wait (measured: the value read 1 instead of 0 for 10
  frames). The same substitution happens at every `withRepeat` restart on
  all platforms. The lead is therefore a timed wait and a leading hold a
  stepped `withTiming`; `looped()` pads with a reset to the frame-0 value.
- **Start off the frame grid.** `play()` runs from `scheduleOnUI`, outside a
  frame, where the start time is `_getAnimationTimestamp()` (between two
  frames; integer ms on Android). It now assigns inside a UI-runtime
  `requestAnimationFrame`, where the start is the frame's `__frameTimestamp`.
- **The shipped runtime threw on device.** Lane C's `easeOf` calls
  `springEase`, declared below it; the worklets Babel plugin makes worklet
  functions non-hoisted consts that capture callees at creation → "Cannot
  access … before initialization" for every bundle exported from `main`
  (worklet mode too; the committed slots predated it, and Node hoists, so no
  gate saw it). Found here while measuring and fixed on `main` by moving the
  spring block up (lane B made the same move); check-skia-export and
  check-skia-native now check declaration order — check-skia-native in
  every emitted native module too.

The jittered rows are the limit: once a frame timestamp arrives early by
more than the 1 µs margin, that step ends a frame late and the rest of the
value's sequence trails by a frame (by k frames after k such boundaries).
The value error is one frame of that step's motion — large for holds, steep
curves and fast steps. `loop: true` (offline, 3 cycles, steady clock): exact
except one frame per cycle for a value whose last key sits on the timeline
end and differs from its first (Aurora's drift and contrast): `withRepeat`
restarts on the frame a cycle ends, which then shows the last key where the
worklet clock shows frame 0. Device vsync regularity is **not measured** (no
Xcode here; iOS hands Reanimated `displayLink.targetTimestamp`, Android
Choreographer `frameTimeNanos`), nor 120 Hz.

Segments (lane B markers), offline on a steady clock with Reanimated's real
sources: every `playSegment` of all three bundles (Aurora `intro` / `loop` /
the `flash` range; the easings fixture's five, cut mid-curve) within 7.5e-6
of range of the worklet clock's `playSegment`, no frame of lag. On the
harness (lane C: `parity:skia -- --bundle native* --segment <name>`, React
Native web, Reanimated's real frame loop on the fake 60 Hz clock): all 11
segments MATCH toolbox's frames at the segment's offset, 8 frames each,
max 1/255, ≥ 99.95 % identical pixels, drift ≤ 8.7e-6 of range, 0 frames
late.

**When to use which.** Worklet (default): playback that must match the
editor frame for frame whatever the display does — scrubbing (`seek`), long
chains of keys, holds that must switch on their frame, anything compared
against a golden. Native: app-driven motion — a state you start with
`play()` / `playSegment(name)`, a value you interrupt, chain from or hand to
a gesture (`cancelAnimation`, `withSpring` to a new target, `playSegment(…,
{ from: "current" })`), springs that should feel physical; it is exact on a
steady clock and within a frame per step otherwise.

#### 3.5e Procedural drivers — built and measured (Wave 3 lane P, 2026-10-14)

Before: a scene bind or an SkSL Shader channel wired from anything but
Animated Value / Color / Constant refused (a *derived* bind upstream of one
sampled per frame). Now the driver subgraph compiles to a **program of the
tick** (`src/lib/skia-export/procedural/`): `parse.ts` (a real tokenizer +
precedence parser for the Expression node's JS), `ir.ts` (the program IR and
an interpreter), `compile.ts` (driver nodes → IR, each compute transcribed
operation for operation), `emit-js.ts` (→ `procedural.ts`, one worklet
`P_<key>(tick)` per value), `emit-sksl.ts` (→ `float tbk_p<k>(float tk)` for
baked programs). No user string is evaluated: code is generated from the
AST (the gate also asserts the sources contain no `eval` / `new Function`).

Where it plugs in:
- SkSL Shader: `SkiaUniformBinding.expr` (scalar channels); worklet bundles
  call `P_<name>(tick)` in `sampleUniforms`; baked ones bake it next to the
  tracks; native ones evaluate it from the linear clock's tick
  (`ticksAt(A.clock.value, …)`, the clock now exists whenever a value is
  procedural).
- Scenes: `BindPlan { kind: "expr", program, scale? }` beside
  static / track / clock / sampled. The planner verifies it against the
  sampled producer at every frame (bit for bit; within float rounding when a
  `BindRef.scale` multiplies) and falls back to sampling with a warning when
  it doesn't. Baked: an expr *program uniform* becomes SkSL; other expr binds
  stay in `sampleBinds` (listed in `manifest.baked.worklet`). Native: expr
  binds stay in `sampleBinds` on the linear clock, like sampled ones.
- Manifests: SkSL Shader `uniforms[].procedural { nodes, tracks, random }`
  and a top-level `procedural.values`; scene `binds[]` entries of kind
  `expr` with `procedural`. MCP `plan_skia_export` rows gain
  `procedural: true`.
- LFO, Expression, Math, Scene Time and Random declare `skia: { class:
  "driver" }`, so a Skia layer offers them.

| node | compiled | refused (with the reason) |
|---|---|---|
| Expression | numbers (dec / 0x / 0o / 0b), `true` / `false`, input variables (wire → coerced scalar, else the row default), the globals (`t` `time` `frame` `fps` `u` `PI` `TAU` `E`), `Math.<const>`, calls of the env functions and `Math.*` (fixed arity), unary `- + !`, `+ - * / % **`, `< <= > >= == != === !==`, `&& \|\|`, `?:`, `return <expr>`, an array literal as the whole result (vec2..4 outputs, padding, broadcast, scalar `raw[0]`); `random()` (mulberry32 seeded `hash(nodeId) ^ ((frame >>> 0) + φ)`, the state threaded through the expression in JS order so an untaken `?:` branch draws nothing); `toNum`'s non-finite → 0 | bitwise ops, assignment, `++`, strings / templates, member access other than `Math.x`, calls of call results, comma, `??`, `?.`, arrows, blocks / statements beyond one `return`, BigInt / separators / legacy octal, unknown names or functions, `===` between a boolean and a number; the editor's own failures (a bare `x;`, a trailing `//` comment, `-x ** 2`, `return` + line break, variable names that shadow a global / `Math` / are reserved — all output 0 in the editor); `Math.random()` (not sampleable); `out_type: curve` |
| LFO | every shape; playhead or wired `clock` (seconds / frames); wired inputs and wired / keyframed params | clips, bypass, keyframed `shape` |
| Math | scalar mode, all 41 ops + clamp, the op's own socket set | uv mode, scalar_field inputs |
| Scene Time | linear / ping-pong / sawtooth / stepped, seconds / frames, every named easing (unknown → linear), `custom` with a drawn curve (monotone cubic, tangents in double at export), keyframed params | a wired `easing_curve` |
| Random | seeded, uniform / gauss, scalar / vec2; params read at the frame's tick (the node caches per frame) | frame mode (`Math.random()`) |
| Constant | keyframed / wired value through `parseFloat((round(v / step) · step).toFixed(6))`, integer mode | keyframed `mode` / `step` |
| Animated Value | keyframes on a wired clock: `round(clock · ticks)` while finite, else the playhead | — |

Clocks: every node reads the scoped clock the evaluator gives it (`tick`,
`time = tick / (ticksPerFrame · fps)`, `frame = floor(tick / ticksPerFrame)`).
The export plays the target's layer-local clock from 0 and a driver rides
the same clock — as a track does (a driver *outside* a late layer shifts with
it, exactly like an Animated Value; editor.ts already warns about the late
layer). An Animated Value's wired clock and an LFO's wired clock are
honoured; a clip window on any driver refuses (a gate, not a clock).
Integer hashing (Random, `random()`) and non-finite constants have no fp32
SkSL form: they refuse to bake (worklet / native export them).

Measured (`npm run check:skia-procedural`, 34 s; `parity:skia`):

| what | result |
|---|---|
| 135 driver cases × 301 frames × 4 ticks per frame (every frame + 3 sub-frame ticks) vs `evaluateGraph` | **bit-identical**, 162,540 values — the IR interpreter, the emitted `procedural.ts`, and the worklets Babel plugin's output rebuilt on an emulated UI runtime alike |
| emitted easing helpers (35 names + an unknown one) and the custom-curve helper vs engine/easing.ts, 1,201-point grid | bit-identical |
| Aurora on procedural drivers (`?bundle=procedural`: LFO → drift_x, Expression ← LFO → scale, Expression ← Scene Time → contrast, a Color track) vs toolbox, RN Skia web, 512², 8 frames | **pixel-identical**, 0/255, 100.00 % identical on every frame |
| …baked (`?bundle=procedural-baked`) | MATCH on 8/8, max 1/255, ≥ 99.97 % identical |
| …the three drivers baked vs the worklet, 1,204 ticks each (CanvasKit F32) | scale 1.8e-7, drift_x 5.3e-7, contrast 3.0e-7 (≤ 1e-6) |
| …baked bundle vs worklet bundle, CanvasKit CPU 32², every frame (301) | max 1/255 |
| baked, all 126 bakeable cases × 1,204 ticks (148,221 finite samples) | every sample within 4× the first-order fp32 error bound (worst 3.05×), 69 samples on a jump's other side (proven per sample); **97.1 % within 1e-6 × max(1, \|v\|)**; one LFO node ≤ 8.6e-7 |
| …where it isn't 1e-6 | fp32 conditioning, not lowering: √ at the end of ease-in-circ (1.0e-3), asin / acos near ±1 (1.1e-4), a To Degrees ×57 gain on an LFO's rounding (3.9e-5), 1 / √a near 0 (2.1e-5), mid-curve quint / back (5e-6) |
| scene binds (Noise (Skia) scale / offset_x / contrast, a Skia Circle centre × width) | plan as `expr`; `sampleBinds` == the producer at every frame (bit for bit; the scaled one within float rounding); all six bundles (effect / scene × worklet / baked / native) type-check in skia-harness |

What makes the exact column exact, found while building it:
- **The editor's wrapper decides what compiles.** `return (<source>);` turns
  a bare `x;` or a trailing `// note` into a SyntaxError and the node
  outputs 0; the parser refuses those with that reason instead of shipping
  `x`.
- **Random's per-frame cache** (`lastFrame` / `lastSeed`) means its value
  comes from the frame's first evaluation; the program reads its params at
  `frame · ticksPerFrame`, which is that evaluation during export or
  stepping (a sub-frame first evaluation during live playback with
  keyframed lo / hi is history-dependent in the editor itself).
- **Booleans** are numberized to 1 / 0 where JS converts them anyway
  (arithmetic, truthiness, toNum), so the printed TypeScript is plain
  `number` code; the one place they differ, `===` between a boolean and a
  number, refuses.
- **Constant folding only, no algebra** (`x + 0` is not `x` for `x = −0`);
  a folded literal is the interpreter's double, i.e. the worklet's.

What makes the baked column what it is:
- fp32 has no uniform 1e-6 for chains: an LFO's phase rounding times a
  product's gain, asin near ±1, √ at the end of ease-in-circ. The gate
  therefore holds baked SkSL to a first-order fp32 error bound (running
  error analysis on the double evaluation) and reports where 1e-6 holds;
  any wrong lowering misses by orders of magnitude more.
- **LFO phase reduction:** on the playhead with a constant frequency, the
  tick is split by the period rounded to whole ticks M (`tick = q·M + r`,
  exact below 2^24) and the phase is `fract(r·K + q·ε + phase)` with
  `M·K = 1 + ε` in double — `raw = t · f` in fp32 would round at ulp(t·f)
  (2.4e-7 of a cycle after two cycles, 1.5e-6 on a sine). The 0.7 Hz
  fixture LFO went from 1.03e-6 to under 1e-6.
- Penner's expo / elastic in-shapes jump at 0 (`inExpo(0⁺) = 2⁻¹⁰`), so a
  ramp a hair off its end in fp32 reads the other side — a jump sample.
- `% 1` at an exact multiple can come out as the divisor when Skia divides
  by a reciprocal; the phase's second wrap absorbs it.

Open:
- On device the worklet runs Hermes's `Math` (libm), not V8's: the
  bit-for-bit claim is V8 (the gate); transcendentals may differ by an ulp
  on device (not measured — no Xcode here).
- NaN / Infinity: a domain error inside a driver (asin(1.2), √−1) that the
  engine's toNum maps to 0 is not reproduced by baked SkSL (the GPU makes no
  NaN promise); 3,483 fixture samples pass through one and are not held.
- Native mode evaluates procedural values from the linear clock, so they
  are as exact as the worklet at the clock's tick but don't animate
  independently (no withTiming per value).
- An Expression's statement form beyond a single `return`, `out_type:
  curve`, and wired `easing_curve`s still refuse.
- `scripts/toolbox-tool-defs.mjs` (`plan_skia_export` / `export_skia`
  descriptions) doesn't mention `procedural` / `procedural.ts` yet (a shared
  registration point — left to the integrator).

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
  An *Animation* dropdown above the button picks worklet / baked / native
  (§3.5; `animation-modes.ts`, M3).
- **Skia layer chrome:** target toggle on the Layer shell, badge in the
  Layers panel, per-node lowering badges, the cost readout.
- **Code editing:** the on-node SkSL editor is the GLSL one; add SkSL syntax
  mode and inline CanvasKit errors under the line.
- **MCP:** `plan_skia_export` (read-only plan: classes, uniforms, problems,
  cost), `export_skia` (returns the files as text for the agent to write;
  both take `animation`), `set_markers` (the segments, M3),
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

#### 3.8.2–3.8.3 built and measured (Wave 3 lane I, 2026-10-14)

Images and assets, preview and export. Gate `check:skia-assets` (in `npm run
check`); pixels against the GL nodes with `compare:skia` (fixture
`scripts/fixtures/skia/image-graph.ts`); web parity with `parity:skia --
--bundle image` (slot `skia-harness/src/bundle-image`, `export-skia.mts
--fixture image`).

What shipped:

- **The asset seam.** One function turns an `AssetIR` URL into bytes:
  `resolveSkiaAssetBytes` in `engine/skia/asset-bytes.ts`. It tries
  registered schemes first (`registerSkiaAssetScheme("bake", fn)` is lane
  B's hook for `bake:<nodeId>`), then decodes `data:` in place, then
  fetches (project media `https:`, `/fonts/…`, `blob:`). The preview's
  loader (`scene-assets.ts`) and every export use it. `exportSkia` stays
  synchronous and pure. An async pre-pass runs in front of it
  (`lib/skia-export/assets.ts`): `collectSkiaExportAssets` (the SkSL
  planner's image children, or the Skia Canvas scene at tick 0), then
  `resolveSkiaExportAssets`, then `exportSkia({ …request, assets: { bytes,
  failed } })` — an additive request field.
  - `exportSkiaFromEditor` and `planSkiaExportForEditor` are async. They take
    `SkiaExportEnv.resolveAsset?: (asset: AssetIR) => Promise<Uint8Array |
    null>` (default: the seam).
  - The CLI resolves through `scripts/skia/node-assets.ts`: `public/` for
    root-relative paths, and offline unless `--fetch`.
  - Bytes land at `assets/<id>.<ext>`: base64 `.b64` text in `files`, which
    MCP returns as it is and `skiaZipEntries` / the CLI decode to binary.
    `asset-bundle.ts` holds the one rule the planners' warnings and the
    emitters share.
  - `manifest.json` lists every asset with `file`, `bytes`, `bundled` and
    `license`.
  - An asset without bytes is a warning naming the nodes that draw it and
    quoting the reason (`HTTP 404 …`). Its `ASSET_SOURCES` entry is `null`,
    which useImage / useFont / useTypeface accept, and the bundle still
    type-checks. Before this, an unbundled asset was a `require()` of a file
    that wasn't there, so Metro failed to bundle.
- **Fonts.** `AssetIR.license` is additive. Geist's OFL text
  (`public/fonts/Geist-OFL.txt`) ships beside `assets/geist.ttf` as
  `assets/Geist-OFL.txt`. Inter had no licence file in `public/fonts`;
  lane T added `public/fonts/Inter-OFL.txt`, which now ships as
  `assets/Inter-OFL.txt` (§3.4b).
- **Image (Skia)** (`skia-image`, `nodes/skia/image.ts`). It has Image
  Source's `file`, `fit` and TRS params, and three outputs:
  - **primary**: an `<Image>` over the canvas rect. Image Source applies its
    TRS in per-axis uv space, so a rotation shears on a non-square canvas. In
    canvas px that is `T(P)·T(t)·diag(a,1)·R(θ)·diag(sx/a,sy)·T(−P)` (a =
    W/H), built as two Groups. Every bind is one param × a constant, so a
    keyframed TRS exports as exact tracks.
  - **aux `shader`**: `tbx.image.fit@1`, FIT_FS line for line, fused over an
    image leaf (a clamp-tiled ImageShader of the file). It keeps Image
    Source's hard edges.
  - **aux `preview`**: the drawing rendered by CanvasKit.

  Not mirrored: EXR stills (no RN float image format; reported as a problem)
  and `uv_in`.
- **Image leaves in fused programs.** The fuser already emitted `leaf`
  children as `c<k>` wrappers (colour-managed with `tbx_cm_child`), and the
  scene renderer and emitter already drew image shaders. The gaps were these:
  - assets didn't travel with shader values. `SkiaShaderValue.assets` is
    additive; every `defineSkslNode` output merges its inputs' assets and
    the Skia Fill hands them to the scene;
  - a skia-* node's own preview showed image (and gradient) children as
    transparent with a problem. `renderShaderPreview` now renders such trees
    whole through the scene renderer;
  - nothing re-rendered when the file landed. Fingerprints fold the asset
    loader's generation.
- **SkSL Shader `iImage1..4`.** A static Image Source, or Image (Skia)'s
  preview, exports as a bundled asset: `useImage` and an `<ImageShader
  matrix>` child, with `images.ts`'s `imageMatrix` (fit, then TRS forward)
  and decal tiling outside a letterboxed or transformed image. A
  transparent `<ColorShader>` holds the slot while the image loads, so the
  child count never changes. **The preview now samples the same file**:
  Image Source and Image (Skia)'s preview tag their output
  (`ImageValue.skiaSource`, additive). Once the loader has decoded the
  file, the SkSL Shader binds an ImageShader of it with
  `imageLocalMatrix` — the same arithmetic `images.ts` ships, held bit-equal
  — instead of the 8-bit readback.

  Refused, each with its reason:
  - a keyframed, wired, faded (opacity < 1), clipped or bypassed source;
  - a source on `cover` with a transform. An ImageShader can't clip the
    cover crop to the moved rect, though the drawing can.
  - EXR;
  - any computed or animated image (left for lane B's bake).

  An unwired but sampled child ships a transparent child, with a warning.
  A wired but unsampled one only warns.
- **Ramp / curve channels.** A channel becomes `uniform shader
  tbx_lut_<name>;` plus its accessor: `float4 ink(float t)` (straight sRGB)
  or `float lift(float x)`. The accessor samples a 256×1 RGBA8 LUT
  (`skslLutBytes`: GLSL Expression's LUT quantized) at texel centres with
  linear filtering, through `tbx_cm_child`. The preview binds it as a
  CanvasKit image. The export builds the same bytes with
  `Skia.Image.MakeImage` (`luts.ts`) and passes them as an `<ImageShader>`
  child. Wired or keyframed ramps refuse: the table would change per frame.

Measured:

| what | result |
|---|---|
| Image Source vs Image (Skia), real engine, 320×180 (16:9: shear), `compare:skia --a image:<pair>n --b image:<pair>d\|s`, all 9 pairs (cover, contain, trs, cvtrs × drawing / shader, and Color Correction ← image) | **MATCH** on every pair, meanAbs 0.00034–0.00046. Premultiplied (edge-band): interior 0/255; band p95 1/255, max 1–2/255 for the shader path and every untransformed drawing. Transformed drawings max 127/255, but only on their outline: Skia anti-aliases where Image Source cuts hard (alpha meanAbs 0.003). compare's unpremultiplied max (~214/255) is the RGB of near-transparent pixels: the engine filters straight alpha, Skia premultiplied. |
| SkSL Shader with iImage1 (Image Source, stretch, rotated 9°) + ramp + curve + a keyframed mix, toolbox vs React Native Skia web (`parity:skia -- --bundle image`, 512², 8 frames) | **pixel-identical: 8/8 frames, 0/255, 100.00 %** (motion f0→f150 meanAbs 0.147). Before the preview sampled the file itself it read MATCH with meanAbs 0.0042 and max 198/255 at the rotated edges, where GL cuts hard and the ImageShader fades. |
| `imageMatrix` (shipped) vs `imageLocalMatrix` (preview) | bit-identical, 20 sizes × mappings |
| Image Source's mapping three ways in CanvasKit (Group nest / FIT_FS port / ImageShader matrix) | ≤ 2/255 inside the image; the Group algebra ≤ 2e-15 relative vs an independent fitRects |
| LUT accessors | exact at t = k/255 on sRGB (opaque ramp, translucent ramp, curve: 0/255); Display P3 F32 read as sRGB ≤ 1/255 |
| Bundles with assets type-check against react-native-skia 3.4.0 | scene and effect bundles, worklet / baked / native |

Open:
- **Device.** Untagged `MakeImage` LUTs on a P3 iPhone rely on Skia treating
  a null colour space as sRGB. The web tags them sRGB. Unmeasured on device.
- **The drawing's edges.** RN `<Image>` uses `drawImageRect` with a strict
  source rect, as the preview does. Its anti-aliased edges differ from Image
  Source's hard cut by design.
- **Lane B.** Animated, video and computed images into `iImage` (bake).
  Wired or keyframed ramps.
- **The SkSL Shader's other image inputs** still cross as an 8-bit readback.
  The ImageShader path covers static files only.

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
| gradients (any ShaderIR gradient) on P3 | identical to Skia's native gradient on sRGB (≤ 1/255) | **≤ 1/255** (lowered to color-managed programs, Wave 3 lane C; native: up to 48/255, red → blue 24/255) | `gradient-program.ts`; ~2× a native gradient's GPU time (3.2× at 49 stops, §2e) |
| native blend modes / translucent overlaps on P3 | — | **shift**: translucent srcOver ~28–38/255; per mode below | Skia blends in the working space; RN Skia 3.4 has no runtime blender — Merge (Skia) is exact |
| native paths/AA | n/a in M0 | ≤ 1 px edge differences | Graphite AA vs Ganesh |
| text | **pixel-identical** (`parity:skia -- --bundle text`, 8/8 frames); vs the Text node: same lines at the same rows (±1 px ink edge), ink 8–15 % lighter (FreeType vs CoreText) | glyph ink: iOS CoreText closer to Chromium's, Android FreeType like the web; variable fonts draw their default instance (RN native ignores `fontVariations`) | §3.4b; shipped fonts only (Inter, Geist, uploads) |
| baked-in-shader timeline | — | ≤ 1e-6 per value | fp32 vs double |
| Reanimated `Easing` transitions | — | exact for most presets; expo/elastic via worklet easings | §1.3 |

Native blend modes on a Display P3 canvas vs sRGB (CanvasKit CPU, P3 F32 read back as sRGB; an sRGB source image blended over an opaque sRGB image; max /255, opaque source / 50 % source — `check:skia-color-management` §6b): src, dst, dstOver, srcIn, dstIn, srcOut, dstOut, dstATop, xor, clear ≤ 1 / ≤ 1; srcOver 1 / 38; srcATop 1 / 38; plus 208 / 132; modulate 68 / 34; screen 141 / 95; overlay 113 / 73; darken 88 / 77; lighten 64 / 25; colorDodge 255 / 158; colorBurn 255 / 128; hardLight 147 / 78; softLight 110 / 70; difference 120 / 65; exclusion 130 / 109; multiply 68 / 65; hue 66 / 51; saturation 75 / 60; color 60 / 44; luminosity 55 / 39.

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
   the web are byte-identical to before. Native drawing is Skia's to convert
   — except gradients, which Skia interpolates in the working space: since
   Wave 3 lane C every gradient is lowered to a color-managed program
   (`library/gradient-program.ts`) by the renderer and the exporter alike.
   Blend modes stay native (no runtime blender in RN Skia 3.4; §4 per mode).
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
  Reanimated-native transitions, spring easing. **Done 2026-10-14 (§2d)**,
  with P3 colour management (§5.5).
- **M4 — completion.** Filters/`RuntimeShader` stages, text, Atlas, the
  `bake` class, procedural drivers (Expression → worklet). Wave 3 lanes
  F, S, I, T, A, P, B, C (§7), launched 2026-10-14. **Done 2026-10-14
  (§2e)**; device confirmation pending.
- **M5 — polish.** Cost readout, docs pages, the `graph-to-sksl` skill, plus the
  SkSL editor and robustness / density items. Wave 4 lanes K, D, G, E, R (§7).

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

### Wave 3 (M4), launched 2026-10-14

Starting point (inventory, `main` at 89b6cfd):
- The scene IR, `scene-render.ts` and `scene-emit.ts` already handle these, but no node produces them:
  - image filters: blur, shadow, offset, morphology, displacement, runtime;
  - colour filters: matrix, blend, lerp;
  - mask filters, `image` draws, `atlas`.
- Assets are bundled only when their URL is a `data:` URL. Project media and the Geist font ship as editor URLs listed in the manifest.
- The SkSL Shader planner refuses wired `iImage1..4`, ramp / curve channels, and any driver other than Animated Value / Color / Constant.
- Scene binds driven by LFO / Expression / Math fall back to a per-frame sampled table.

Lane conventions are as in Waves 1–2, with these additions:
- Each lane branches from **`main`**: run `git reset --hard main` in the fresh worktree first.
- Each lane rebases onto `main` before reporting.
- Every new runtime program goes through `tbx.color.cm` (§5.5).
- Every emitted worklet calls only functions declared above it (§2d).

| lane | owns | done when |
|---|---|---|
| **F Filters** (`filter` class) | `skia-blur` (Gaussian → Group `layer` blur; other modes refused), `skia-bloom` (threshold RuntimeShader + Blur + Blend plus), `skia-grain` (RuntimeShader over `content`), `skia-drop-shadow`, `skia-morphology`, `skia-color-matrix`, `skia-sksl-filter` (author SkSL over `content` — the RuntimeShader stage as a node); liquid-glass / lens-flare assessed, ported or refused with reasons | each mirror MATCHes its GL node in `compare:skia`; `check:skia-filters`; exports via `checkExportable` |
| **S Stage splitting** | the cost model's over-budget path: split a fused program at the gather into a RuntimeShader stage over a `Group` (§3.3); Flow Blur / Kuwahara / Sharpen-over-noise export; `tbx.warp.texel` + `tbx.gather.edge` → one helper | split exports draw the same pixels as the unsplit preview (`compare:skia`, parity); `check:skia-split` |
| **I Images + assets** | `skia-image` (image-source → `image` draw, fit modes); image leaves in fused programs (`ImageShader` child); SkSL Shader `iImage1..4` export (static images: bundled asset + `useImage`); ramp / curve channels → exact 256×1 LUT `ImageShader` children (§3.8.2); the **async asset pipeline**: the editor / MCP export resolves every `AssetIR.url` to bytes through `SkiaExportEnv.resolveAsset?(asset) → Promise<Uint8Array \| null>` (default: fetch) and ships them under `assets/` (fonts included) | an exported bundle has every asset's bytes; `check:skia-assets`; parity slot with an image |
| **T Text** | additive Text IR: `lineHeight`, vertical anchor; the Text node's font choice → a font asset (beware the curated-font fallback trap: confirm the real face loaded); paragraphs inherit group blendMode; `leading` | `compare:skia` vs the Text node per option; `check:skia-text` |
| **A Atlas** | `skia-copy-to-points`: points + an instance → `atlas` (sprite from an image asset or a rasterised Skia sub-scene; research RN Skia 3.4's texture APIs) or N `Group` copies when N is small (lane measures which is exact); xforms static / track / sampled | MATCH vs Copy to Points; `check:skia-atlas`; parity slot |
| **P Procedural drivers** | compile Expression (its JS math subset, deterministic `random`), LFO, Math, Wave, Scene Time, Random into worklets (worklet / native modes) and SkSL (baked mode); SkSL Shader channels accept them; scene binds get an `expr` plan kind instead of a sampled table; unsupported syntax refuses (scenes keep sampling) | worklet == engine evaluation bit-for-bit on fixtures; baked ≤ 1e-6; `check:skia-procedural` |
| **B Bake class** | `skia-bake`: an engine image wired into a Skia layer, rendered by the editor at export and shipped as an asset — static → one PNG, animated → a frame sprite sheet played by time (cap and fps reported); the preview draws the live image; assets come through lane I's `resolveAsset` hook (`bake:<nodeId>` URLs) | an exported bake replays the editor's frames (parity); `check:skia-bake` |
| **C Carried polish** | P3 residuals: native gradients → colour-managed programs where they shift; native group blend modes on P3 measured and lowered or documented; SkSL Shader `iImageN` passed to helper functions converted; Merge (Skia) grow-on-wire / "+" layer; native mode `from: "current"` colours + harness segment capture | `check:skia-color-management` covers gradients and blends; each item's own check |

Shared seams are integrated serially by the integrator:
- `editor.ts` export flow: lane I makes it async; lanes B and T plug in.
- The scene-emit asset section: lanes I, T, A, B.
- `plan.ts` refusals: lanes I and P.
- `scene-render.ts` / `scene-emit.ts`: additive per-kind sections.

### Wave 4 (M5), planned 2026-10-16

Starting point:
- `inspectSkiaFillStages` (`nodes/skia/fill.ts`), `estimateShaderCost` (`fuse.ts`) and `PHONE_PIXEL_BUDGET` (32 units/px) exist, but nothing in the editor shows them.
- The SkSL compile cache already evicts (64 programs, oldest first).
- No CanvasKit context-loss handling exists.
- The in-app docs (`src/app/docs/[...slug]`, `src/lib/docs/manifest.ts`, `src/components/docs/pages/`) have no Skia pages.
- The delivery target is iOS only.

Lane conventions are as in Wave 3. In addition: other sessions keep uncommitted work in the main checkout, so lanes never modify a file that `git -C <main checkout> status` shows as dirty; they stop and report the change instead.

| lane | owns | done when |
|---|---|---|
| **K Cost readout** | units/px against the budget at 3× density, split stages, and per-node contributions, for Skia Fill / Skia Canvas / Skia layers: a param-panel section, `plan_skia_export` `cost`, manifest `cost` | numbers equal `estimateShaderCost` / `inspectSkiaFillStages` on fixtures; `check:skia-cost` |
| **D Docs** | in-app pages: Skia layers, Authoring SkSL (the node contract, ES2 rules, channels, colour management, images, ramps), Exporting for iOS (bundle anatomy, animation modes, segments, assets, P3, procedural, bake, native-only filters), and a Skia node reference generated from defs + NodeFacts; a `README.md` in every exported bundle for the iOS developer | pages render (verified in the browser if `/docs` is public); the bundle README is snapshot-gated |
| **G graph → SkSL** | `.claude/skills/graph-to-sksl/`; MCP `plan_skia_conversion` (read-only: each default-layer node → its `skia.mirrors` counterpart, unmapped nodes → the Skia Bake route or an SkSL port); `get_skia_docs`; Aurora as the worked example | the plan round-trips the fixtures; the skill's steps run headlessly on a fixture; `check:mcp` |
| **E SkSL editor** | SkSL syntax highlighting and inline CanvasKit errors under the user's line, in the code editor used by SkSL Shader / SkSL Filter | errors map to user lines (gate); the highlighter tokenizes the library sources |
| **R Robustness + density** | CanvasKit WebGL context loss / restore (surfaces and caches rebuilt, re-render); CanvasKit time in the profiler; the §3.8.5 density policy (`iResolution.z` = pixel ratio; a layer device-profile preview at ratio 3) | a forced context loss recovers (gate); perf capture shows CanvasKit time; density fixtures |

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
