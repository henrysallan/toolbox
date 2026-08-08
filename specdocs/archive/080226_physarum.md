# Physarum (spec + shipped, 2026-08-02)

Status: **implemented** — `src/nodes/effect/physarum.ts`, registered as
`physarum`.

A GPU slime-mold (Physarum polycephalum) transport-network simulation.
Millions of agents sense a decaying trail field at three points, turn
toward the strongest, step, and deposit; the field diffuses and decays.
The result is the self-optimising vein network that is the signature
image of contemporary generative art.

## Provenance

- Base algorithm: Jeff Jones (2010), *Characteristics of pattern
  formation and evolution in approximations of Physarum transport
  networks.*
- Parameterisation: Sage Jenson (mxsage), **36 Points** —
  https://www.sagejenson.com/36points/ — where the four classic
  parameters are not constants but functions of the value the agent
  senses at its own position:

  ```
  param = base + scale * pow(sensedValue, power)
  ```

  applied to sensor distance, sensor angle, rotation angle and move
  distance (12 numbers), plus two sensing-position biases and one
  sensing scale factor = **15 numbers per "Point"**.
- Implementation reference: Etienne Jacob (Bleuje),
  **interactive-physarum** — https://github.com/Bleuje/interactive-physarum
  (CC BY-NC-SA 3.0). We port its deposit curve (`sqrt(count)`-weighted
  per-pixel deposit), its diffusion/decay kernel with the delayed second
  channel, its 24-entry Point matrix, its colour modes, and its
  two-Point spatial interpolation idea.

Attribution lives in the node file header and in the node
`description`. **Non-commercial share-alike applies to the ported
material** — noted here so it is not lost.

Supersedes the "Deferred: GPU physarum" item in
[080226_behavioral-growth.md](080226_behavioral-growth.md) §8. That
node's `physarum` *mode* (CPU, points-typed, ≤50k agents, points output)
remains worth building for the cases where agent positions must leave
the node as a `points` value; this one is the image-domain, millions-of-
agents version.

## 1. Why a dedicated node, not a mode

Behavioral Growth is a **points** node: CPU agents, a `points` primary,
neighbour queries. Physarum at this scale has no CPU story — the agents
never leave the GPU, the population is 10²–10³× larger than any
`points` value should be, and the interesting output is the *field*, not
the positions. Different socket types, different state, different
resolution knob. Separate node.

## 2. Architecture

WebGL2 has no compute shaders and no atomics, so the reference's
`atomicAdd` per-pixel counter becomes an **additive point draw**:

```
type:        "physarum"
name:        "Physarum"
file:        src/nodes/effect/physarum.ts
category:    "image"       subcategory: "generator"
backend:     "webgl2"      stable: false
headerControl: { paramName: "view" }
```

### Textures (all in `ctx.state["physarum:<nodeId>"]`)

| buffer | format | size | contents |
|---|---|---|---|
| `agents[2]` | RGBA32F, NEAREST, CLAMP | `agentW²` | `(x, y, heading, phase)`; x/y in sim pixels |
| `trail[2]` | RGBA16F, LINEAR, **REPEAT** | `simW×simH` | `(trail, delayedTrail, –, –)` |
| `count` | RGBA16F, LINEAR, CLAMP | `simW×simH` | agents landing on this texel, this step |

RGBA32F for agents is **required**: positions are stored in sim pixels
and 16F has ~1px resolution at 1000, which shows up as visible
quantisation lattices. The trail is 16F on purpose — half-float is
core-blendable and core-linear-filterable in WebGL2, where 32F blending
needs `EXT_float_blend` and 32F linear filtering needs
`OES_texture_float_linear`; the trail needs both and its dynamic range
(0…~3, deposits of ~10⁻²) fits 16F comfortably.

The trail wraps (`REPEAT`) because the reference's world is a torus —
`mod(pos + size, size)` in the move shader, `LoopedPosition` in the
diffusion shader. Sampling is therefore just `pos / simSize` with no
manual wrap.

### Per-simulation-step passes

1. **clear** `count` → 0.
2. **move** — fullscreen over the agent texture. Reads `agents[i]` +
   `trail[t]` (+ optional `blend` mask), writes `agents[i^1]`.
3. **deposit-count** — `gl.drawArrays(POINTS, 0, agentCount)` with
   `gl_VertexID`→`texelFetch` into `agents[i^1]`, `gl_PointSize = 1`,
   `blendFunc(ONE, ONE)` into `count`. This is the atomic counter.
4. **deposit** — fullscreen over the trail:
   `trail += sqrt(min(count·densityScale, 100)) · depositAmount`
   (+ the `inject` mask, if wired). `trail[t]` → `trail[t^1]`.
5. **diffuse** ×`blur passes` — 3×3 box + decay on the first pass only,
   pure box after. `trail[t]` → `trail[t^1]` each pass.

Then one **render** pass at canvas resolution samples `trail` + `count`
(LINEAR upsample) into the output image.

### Density normalisation (two terms, and the second one matters)

The reference runs 5.77M agents on 1280×736 ⇒ **6.12 agents/pixel**, and
its deposit and colour curves are tuned for exactly that. Toolbox users
change both agent count and sim resolution freely, so every consumer of
`count` first multiplies by

```
densityScale = 6.12 / (agentCount / (simW·simH))     (clamped 0.02…50)
```

which keeps the `DEPOSIT_LIMIT` cap and the colour curve meaning the same
thing at any population.

That alone is **not enough**, and the reason is the whole reason this
node is fiddly. The deposit is `sqrt(count)`-weighted and `count` is
Poisson, so scaling the count does not scale its sqrt-expectation by the
same factor — Jensen's inequality opens a gap that grows as density
falls (28% short at ~1 agent/px, 110% short at 0.25). A 28% error in the
equilibrium trail would be cosmetic in most simulations. Here it is not:
every parameter is `base + scale·pow(sensed, power)` with powers up to
33, so **28% low on the trail came out as 7× low on sensor distance**,
and the sensors collapsed onto the same texel — the agents chased shot
noise and no network formed at all. Measured, not theorised: this was
the difference between a flat grey field and the images in §6.

So the deposit additionally carries

```
depositCorrection = E[√Poisson(6.12)] / (√densityScale · E[√Poisson(λ)])
```

with `E[√Poisson]` summed directly on the CPU (~50 terms, once per
eval). It is 1.0 at reference density by construction. With
`normalize density` on (default) **agent count is a quality knob, not a
look knob** — more agents is a smoother, less noisy version of the same
image. Off, brightness tracks population.

### Resolution normalisation

Pixel-domain quantities (`base` distances, the two sensor offsets, and
the `scale` terms' 250px factor) are multiplied by `distScale` — and
**so is the diffusion kernel radius**, which the reference's fixed 3×3
kernel is not.

That coupling is load-bearing. Structure size is set by the *ratio* of
agent stride to diffusion width, so with a fixed 1-texel kernel
`resolution` stops being a fidelity knob and becomes a regime knob:
halving it turned the vein network into a labyrinth, which would mean a
4K export not resembling its 1080p preview. The kernel is therefore a
separable box of radius `round(distScale)`, clamped to 1…8 — separable
so the cost is 2(2R+1) taps rather than (2R+1)².

`distScale` is also **clamped at 1 from below**:

```
distScale = max(1, simH / 736) · scale
```

because diffusion cannot be narrower than one texel, so scaling
distances *down* at low resolution pushes them under that floor and the
network collapses. Net behaviour: above ~740px of sim height the picture
is frame-relative (export matches preview); at or below it the sim runs
at reference pixel scale and lower resolutions simply read as zoomed in.
No setting is degenerate; the transition is monotone.

The same coupling is why `scale` is not a free zoom — raising it alone
makes agents outrun the field. It widens the blur radius with it, and
past ~2× wants `blur passes` raised too. This is stated in the node
`description` because it is the one non-obvious interaction.

## 3. Parameters

Presets cannot write back into sliders (there is no such mechanism in
`ParamDef`), so the design is **preset + multipliers**, with `custom`
as the escape hatch:

- `preset` — the 24 Points from the reference matrix (mxsage names where
  they exist, `point R…X` for the rest), or `custom`. Default
  `pure multiscale`: mxsage's Point A and the one that most reads as
  "physarum" — thick trunks down to hair-fine capillaries.
- Four always-visible multipliers that ride on top of *any* preset:
  `scale` (all distances), `turn` (rotation angle), `sensor angle`,
  `sense scale` (the sensed-value gain — the single most expressive
  knob, it moves the whole system between regimes).
- `custom` reveals all 15 raw numbers, laid out exactly like the
  reference UI: Sensor Distance / Sensor Angle / Rotation Angle / Move
  Distance × Base / Power / Scale, plus Sensor X/Y Offset and Sense
  Scale.

Field knobs: `deposit`, `decay`, `blur passes`, `respawn rate`,
`inject amount`.
System knobs: `agents`, `resolution`, `steps / frame`, `seed`.
Look: `view` (colour / trail / count — header control), `colour mode`
(11 palettes ported from the reference + `mono`), `transparent
background`, universal `opacity`.

`agents` is a scalar; the agent texture is `ceil(sqrt(agents))²` and the
whole texture is live, so the effective count rounds **up** to the next
perfect square. Changing it reseeds the agents but **keeps the trail** —
you can raise the population mid-run without losing the network.

### Two Points (the reference's signature interaction)

Enabling `two points` reveals a second full Point (`preset B` + its own
15 raw numbers) and makes the `blend` **mask input** interpolate between
Point A and Point B *per agent, at the agent's position*. The reference
hard-codes this as a Gaussian around the gamepad cursor; a mask input is
strictly more general — wire a Circle driven by the Cursor node to
reproduce it, or a gradient, a video luma, an audio-driven shape, text.
Unwired ⇒ pure Point A.

## 4. Sockets

| socket | type | required | meaning |
|---|---|---|---|
| `blend` | mask | no | per-pixel Point A ↔ Point B interpolation |
| `inject` | mask | no | added into the trail every step — draw structure the agents will follow |
| `time` | scalar | no | only when `drive by time input` is on |
| `mask` | mask | no | the universal mask (mattes the output) |

Primary output: `image`. Aux: `trail` (mask) and `count` (mask), both
gated on `consumedOutputs` so nothing is paid for unless wired.

## 5. Timeline

Standard self-iterating-sim contract, lifted from `watercolor-ink.ts`:

- Steps while `ctx.playing`, or offline when time advanced (frame-exact
  export), or — with `drive by time input` — whenever the wired scalar
  increases.
- Resets (agents reseeded, trail cleared) on first eval and on scene-time
  wrap to 0.
- `stable: false` + `fingerprintExtras` mixing `ctx.time`.
- `dispose` deletes both agent textures, both trail textures, the count
  texture, the point-draw FBO/VAO and the deposit program.

## 6. Verification

### Already done — headless, in a real ANGLE WebGL2 context

The repo has no test runner, but this node is almost entirely GPU, so it
was verified by running it for real rather than by reading it. Two
Electron harnesses (see `glsl-compile-check-electron` in the session
memory for the `ELECTRON_RUN_AS_NODE` gotcha):

1. **Shader compile + link** — every `#version 300 es` literal in the
   file extracted, `${}` chunks resolved, compiled and linked against the
   engine's fullscreen VS. 9 shaders, 7 links, all clean.
2. **Real `compute()` execution** — the node bundled with esbuild
   (`--alias:@=./src`) against the actual `createEngineBackend`, run for
   up to 600 steps, with per-frame readback of the output image AND the
   raw agent / trail textures.

What that caught, none of which typecheck or lint can see:

- The **double-applied `distScale`** on the amplitude terms (once on the
  param, once via `u_pixelScale`) — a silent 0.73× error at defaults.
- The **Jensen gap** in density normalisation (§2) — the difference
  between a flat grey field and a network.
- The **resolution regime shift** (§2) — found by rendering the same
  config at two resolutions and looking at the two images.

Confirmed clean across an edge-case sweep (`blur passes` 0 and 6,
`normalize density` off, 1024 agents, `decay` 1.0 with `respawn` 0,
`scale` 20, `custom`, `resolution` 0.1): no NaN in agents or trail, no
GL errors, no unbounded trail growth.

Renders confirming the algorithm rather than merely its absence of
crashes: `pure multiscale` produces a true multiscale vein network;
`vertebrata` an open cellular one; a left-to-right ramp into `blend`
with `two points` morphs continuously between those two across the
frame; the colour modes reproduce the reference's look (icy network,
warm where it is actively reorganising).

### Still manual, in the browser

1. Interactivity: Cursor → Circle → `blend` behaves as a pen.
2. Wire Text into `inject`: agents colonise the letterforms.
3. Scrub to 0 and play: the sim restarts clean.
4. Export a video: one step per frame, deterministic, matches preview.
5. Delete the node while running: no GL warnings, no leak (state key is
   `physarum:<id>`, so the evaluator's dispose sweep resolves it).
6. Perf at the 4M-agent ceiling on real hardware.

## 7. Deliberately not doing

- **Waves / gamepad / spawn bursts** from the reference — they are
  installation-interaction features whose toolbox equivalent is
  keyframing `blend` and `inject`.
- **The inertia (`L2`) move style** — a second position integrator
  blended in by a gamepad trigger. Deferred; it would be one more
  `move style` scalar if wanted.
- **Points output.** Agent positions stay on the GPU. If you need them
  as a `points` value, that is Behavioral Growth's `physarum` mode.
