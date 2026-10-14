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
- Text IR: `lineHeight` and a vertical anchor (F8).
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
- **Still carried from §2c:** font / image assets in bundles, filter-stage splitting, the shared texel helper.

## 2e. Wave 3 (M4) results

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
  `assets/Geist-OFL.txt`. Inter has no licence file in `public/fonts`, so
  none ships.
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
| text | n/a | layout differences possible | Paragraph + bundled fonts only |
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
  F, S, I, T, A, P, B, C (§7), launched 2026-10-14.
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
