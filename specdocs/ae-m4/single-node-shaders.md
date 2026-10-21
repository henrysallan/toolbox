# Single-node shader regions → the node's own shader (results)

2026-10-21, branch `claude/elegant-mestorf-dac7b7`. Spec: `specdocs/091926_after-effects-handoff.md`
§7.2 (option A, the generic host) and §7.3 (host contract); host facts in
`src/lib/ae-export/docs/ae-host.md`. Measured in After Effects 26.5 through `aerender` under the shared
AE lock with the installed Toolbox Shader host 1.0.0; the owner's AE GUI was never contacted.

**Problem.** In the owner's 2026-10-21 hand test an animated Noise baked: every shader region waited
for an agent to fuse it into a GLSL Expression ("Convert with Claude"), even a region that is one node
whose GLSL the engine already runs.

**Now.** A shader region that is ONE node with a host spec exports as a Toolbox Shader effect running
that node's own fragment shader. Its params are the effect's controls, named and labelled after them.
No fused node is needed and nothing has to be converted. Today the spec covers Noise, all 11 types.
Multi-node regions still need `opts.fused`, as before.

## What shipped

- **`src/lib/ae-export/shader/node-shaders.ts`**: the per-node host specs (`NODE_SHADERS`), lib-level
  data like the GLSL / AE class tables. Each spec gives:
  - `fs`: the source `compute()` compiles.
  - `controls`: the params that become host controls. `when` drops one the baked state never reads,
    such as Flow Time unless `type` is flow.
  - `uniforms`: a rule for EVERY uniform the source declares. A rule is a GLSL expression over the
    controls (`$param`) and the host clock (`u_res` / `u_time` / `u_frame` / `u_aspect`). A rule
    that reads neither is a constant, which is how enum params and wiring get baked. A sampler's
    rule is `{ input }`.
  - `helpers`: GLSL ports of the JS that `compute()` runs per frame.
  - `bakes`: params the shader reads only as constants.
  - `ignores`: params that never feed the shader.
- **`shader/node-bundle.ts` `bundleFromNodeShader(type, params, inputs, opts)`**: rewrites the node's
  source into the GLSL Expression template's shape, which is what `glslToMsl` / `validateAeShader`
  read:
  - Channel uniforms are named after the params (`<param>_param` only when the source already uses
    the name globally or calls it).
  - Each node uniform becomes a `const`, or a global set at the top of `main()` exactly as `compute()`
    binds it.
  - A wired sampler is renamed to `u_a`…`u_d`. An unwired one becomes a helper that returns the
    engine's transparent placeholder texel.
  - Nothing else in the node's code changes. `loopFrames` is 0, so `u_frame` stays unwrapped like
    `ctx.tick`.
- **`scene/shader.ts` `emitNodeShader`**: the region has no fused node, it is one node, and the node
  has a spec. The effect is built like the fused path's:
  - Bundle ID first, then image inputs as Layer A–D.
  - Each control goes through the walk's ordinary param helpers (`scalarProp` / `colorProp`): keyed
    → keys, wired → an AE expression or per-frame keys, knob → its Essential Property. A keyed
    boolean becomes hold keys.
  - A keyed or wired `bakes` param (Noise's `type`) bakes the region and says why.
  - The node's universal mask and opacity apply outside the shader, as for any source.
  - `effects.ts` `shaderOrBake` takes the same route, for a node whose AE effect map refuses.
- **Plan**: `AeShaderRegion.kernel: "node"` marks such a region. It comes from the AE class flag
  `ownShader` (classes.ts). plan.ts stays registry-free, and the gate holds the flag equal to
  `NODE_SHADERS`. The region summary reads "noise's own shader → Toolbox Shader (no conversion …)".
  A spline on an own-shader node's universal mask no longer stops the region: the AE plan replans
  without the mask wire and keeps the result only when the region is still that one node.
- **UI and agent surface**:
  - The export modal marks these regions ◇ "its own shader" and shows "Convert with Claude" only
    when some region needs fusing (`aeRegionsToFuse`).
  - `aeConvertPrompt` tells the agent to export them as is.
  - `validate_ae_shader` takes such a node (Noise) as well as a GLSL Expression.
  - The plan / export / validate tool descriptions, the agent-host system prompt and the
    graph-to-after-effects skill say a `kernel: "node"` region needs no fusing.
- **Docs**: an "own shader" section in `ae-host.md`; new `ae-nodes/noise` (the control list, what is
  baked, mask / opacity, the larger-region rule). `noiseTypeToInt` is now exported from the Noise node,
  so the bake uses the node's own mapping.
- **Fixtures**: `v-noise` is an animated Noise (looping evolution, rate 0.8 over frames 0–60) with
  `contrast` keyed 1 → 2.5 easeInOutCubic. `v-noise-masked` is a phasor Noise, a spline mask and
  opacity 0.5. Snapshots for both, with probes from `engine/noise.ts`'s CPU port of NOISE_FS. No
  existing snapshot changed.
- **Gate `scripts/ae-export/check-shader-nodes.mts`** (`npx tsx scripts/check-ae-export.mts
  shader-nodes`, in TESTING.md). The WebGL2 harness moved from `check-shader-parity.mts` to
  `scripts/ae-export/parity-gl.mts`, so both parity gates share it. It also gained vec3 / ivec
  uniforms and any sampler name.

## Exported controls (Noise)

Scale, Octaves, Persistence, Lacunarity, Offset X, Offset Y, Seed, W (Evolution), Animated (checkbox),
Start (frame), End (frame), Rate, Contrast, Color A (low), Color B (high), Alpha. Flow adds Flow Time.
Phasor adds Frequency, Orientation (deg) and Isotropy. Curl drops the colours. That makes 14–19
controls, inside the 32-slider / 8-colour / 8-checkbox pool.

The shader converts each control the way `compute()` does:

| Control | Uniform | Conversion in the shader |
|---|---|---|
| Octaves | `u_octaves` | `int(clamp(floor(x + 0.5), 1, 8))` (`Math.round` + clamp) |
| Orientation (deg) | — | degrees → radians |
| Colors | `u_colorA` / `u_colorB` | `.rgb` |
| Animated | `u_w` | forces `u_w = 0` |
| Animated | `u_animOffset` | `loopEvolutionOffset(u_frame, start, end, rate)`, flow type: `loopEvolutionPhase · 2π` into `u_flowTime` (engine/noise.ts, ported) |
| (none) | `u_canvasSize` | `u_res` |

`type` is baked as `const int u_type`, and `u_hasUvIn` follows the wiring. Opacity becomes the AE
layer's Opacity. `field_lo` / `field_hi` feed only the `field` aux, so they are ignored.

## Measured

**Gate (offline half, any platform).** `compute()` on a recording GL:
- It compiles `spec.fs`, draws once and binds all 23 uniforms.
- Every one of the 20 controls changes a binding when moved. Branch-only controls are read under the
  type that uses them, and `anim_*` under Animated.
- The 3 ignored params change none.
- Every param is classified.

**Bundles.** All 17 cases build. `validateAeShader` accepts each one, and the host's own
`tbxshader-check` compiles each one with Metal.

**Parity (macOS, Apple M5 Pro).**
- Reference: toolbox's render. That is the node's own NOISE_FS with the uniforms `compute()` bound,
  in WebGL2 (ANGLE Metal).
- Candidate: the bundle's MSL on Metal, with the bundle's control values and the host clock, fast
  math as the host compiles.
- 581 uvs per case on a 1280×720 canvas. Max |Δ| per component:

| Case | host (fast) | rules only (rewritten GLSL, WebGL2) | IEEE (reference) |
|---|---|---|---|
| simplex, defaults | 6.0e-8 | 6.0e-8 | 6.0e-8 |
| simplex, looping evolution, frame 17 | 6.0e-7 | 4.2e-7 | 6.0e-7 |
| simplex, looping evolution, frame 89 (wrap) | 4.3e-6 | 4.3e-6 | 7.2e-7 |
| perlin, W slice blend + seed + offsets | 6.0e-8 | 6.0e-8 | 6.0e-8 |
| value, contrast, octaves 2.6 → 3, alpha | 5.0e-10 | 0 | 1.2e-7 |
| opensimplex / opensimplex2 / opensimplex2s / super-simplex | ≤ 1.2e-7 | ≤ 1.2e-7 | ≤ 5.1e-7 |
| perlin-deriv | 5.0e-10 | 0 | 9.0e-8 |
| flow, animated (frame 31) / static | ≤ 1.2e-7 | ≤ 1.2e-7 | ≤ 1.2e-7 |
| curl, W 0.5 | 5.0e-10 | 0 | 2.5e-4 |
| phasor | 5.4e-7 | 0 | 4.5e-7 |
| animated, degenerate window / rate 0 | 6.0e-8 | 6.0e-8 | 6.0e-8 |
| UV input wired → Layer A | 1.2e-7 | 1.2e-7 | 6.0e-8 |

Gate tolerance is 1e-5 (1e-4 for the UV input). The largest gap (4.3e-6 at the loop's wrap) is the
loop offset computed in float32 in the shader versus double in JS. The UV case's probe samples with
hardware bilinear, like WebGL, so the host's own float bilinear is not measured there (known from the
translator lane: sub-texel weights, about 1e-3 on gradients).

**After Effects 26.5, headless** (`scripts/fixtures/ae-export/graphs/roundtrip.mts v-noise
c-shader`):
- `v-noise` builds clean. All 8 probe pixels, at frames 0 and 30, match the CPU port of NOISE_FS
  within 3/255. That covers the evolution moving and the keyed contrast at 1.7875.
- Whole frames, the AE 8-bit render against the CPU port at every pixel (it is exact for simplex at
  seed 1 everywhere in this frame):

  | Frame | mean | max | components over 1/255 |
  |---|---|---|---|
  | 0 | 0.33/255 | 1.00/255 | 11 of 2,764,800 |
  | 30 | 0.32/255 | 1.14/255 | 3,562 of 2,764,800 |

  That is 8-bit quantisation, plus at frame 30 the keyed contrast's easeInOutCubic → AE cubic fit
  (≤ 0.27 %, editable policy).
- `v-noise-masked`, first run: the inside pixel read α 128 (opacity 0.5), but the outside read
  `[76, 76, 76, 127]` instead of transparent. AE applies a layer's masks BEFORE its effects, and the
  shader (any generator effect) writes every pixel, so a spline mask on the shader's own solid does
  not clip it. Fix: a spline mask on an own-shader output goes on a precomp of the shader layer.
  After the fix both probes pass: inside α 128, outside transparent.
- `c-shader` (the fused path, control) still passes all 3 probes.

## Not done / follow-ups

- **Other single-pass nodes.** Each needs a spec: `lyapunov`, `shape-cells`, `polar-coords`,
  `chromatic-aberration`, `edge-detect`, `color-ramp` (LUT controls), and the effect nodes whose AE
  map refuses (gradient polar / wave, blur modes …). `shaderOrBake` already routes them once a spec
  exists. Multipass nodes can't use this path; they still need fusing.
- **Enum popups.** `type` is baked; keying it bakes the region. A popup needs a host change (ABI) or
  per-node identity plug-ins (spec §7.2 B). Those would start from these same specs: the control list
  and the rules are what an identity plug-in's params and pre-shader binding need.
- **Possibly the same mask bug in `effects.ts` `emitSource`.** A spline mask on an effect-class
  generator (Gradient Ramp and the others on a solid) takes the same layer-mask route, and AE masks
  before effects. Not measured; no fixture covers a masked generator.
- `check-agent-host` (real inference, not in `npm run check`) timed out at its first agent turn in
  this sandbox, after the host booted and both windows authorized; `node --check` passes on the
  edited prompt.
