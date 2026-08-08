# Fluid Simulator — 2D Eulerian ink/smoke (M2)

Shipped 2026-07-26 (code; needs the in-browser pass below). M2 of the
fluid arc — M1 field toolkit: 072526_flow-fields.md. One node,
`fluid-simulator` ([fluid-simulator.ts](../../src/nodes/effect/fluid-simulator.ts)),
image/generator, structured on Watercolor Ink's chassis but simulating
open water instead of paper: Stam stable fluids upgraded with
**advection-reflection** and **vorticity confinement**.

## What it is

Velocity + dye on a uniform grid (canvas × `resolution`, default 0.5).
Per substep (fixed dt = speed/fps/substeps — deterministic offline):

1. **Forces** — one pass: particle-descriptor forces, buoyancy
   (dye density rises; negative sinks), external guide field, velocity
   dissipation.
2. **Vorticity confinement** — curl pass + push toward vorticity maxima
   (the "swirl" dial; physically indefensible, artistically excellent).
3. **Advection-reflection** (Zehnder et al. 2018) — ṽ½ = A(v,v,dt/2);
   v½ = P(ṽ½); ṽ = 2v½ − ṽ½; ṽ1 = A(ṽ,v½,dt/2); v1 = P(ṽ1). Two
   projections per step instead of one, ~2 orders of magnitude less
   energy loss than plain advect-project — swirls persist. P = divergence
   → Jacobi ×`pressure_iterations` (warm-started from the previous
   solve) → subtract gradient.
4. **Walls + colliders** — closed edges zero the wall-normal component
   (free-slip); collider solids damp velocity inside a ~1.5-texel
   feather, and the NEXT projection routes flow around them. `open`
   edges use Dirichlet p=0 out-of-bounds so flow exits the frame.
5. **Dye** — advect + fade + inject in one pass (premultiplied
   accumulator, density capped at 8; present pass converts to straight
   alpha).

## Decisions & conventions

- **Internal frame is GL texel space** (y-up, texels/s) — the textbook
  frame, isotropic because grid cells are pixel-square. Conversions
  happen ONLY at seams:
  - particle-land forces run in Y-DOWN anisotropic canvas-UV — velocity
    round-trips (÷size, y-negate) so a Gravity/Vortex/Turbulence node
    feels identical on both simulators. `applyForce` + the noise/curl2
    GLSL are copied verbatim from particle-simulator-webgl.ts — KEEP IN
    SYNC (third copy of the contract after sim-kernel.ts's CPU port).
  - the `field` input and `velocity` aux speak the M1 encoding
    (engine/velocity-field.ts): ÷gridW, y-negate.
- **Descriptor slots, not chains**: `forceCount`/`colliderCount` params
  mint `force1..6` / `collider1..4` sockets (the particle sim's
  param-backed dynamic-socket pattern, same gatherDescriptors shape).
  Emitter descriptors are NOT consumed — deposit/color covers dye
  sourcing (Watercolor's vocabulary: deposit mask = coverage, color
  image = hue, color-alpha doubles as coverage when deposit unwired,
  `ink_color` param fallback).
- **House sim contract** (Watercolor/RD pattern verbatim): stable:false
  + time in fingerprintExtras; node-owned RGBA16F grid textures in
  ctx.state, deleted in dispose; advance while `ctx.playing` (or offline
  frame-stepping, or a wired monotonic scalar via
  `drive_by_scene_time`); reset on first eval / scene-time wrap.
  EXT_color_buffer_float required (blank + one console.warn without);
  OES_texture_half_float_linear preferred (NEAREST fallback = blockier
  advection but functional).
- **Texture footprint**: 8 grid-res state textures (vel×2, dye×2, pr×2,
  div, curl) + 1 pool lease per active eval for the reflection's v½
  (needed across the whole second half-step). Pressure ping-pong is
  warm-started, never cleared between projections/substeps.
- **The velocity aux is built unconditionally** (single cheap pass) —
  paused cache hits must return a valid aux (loop-weave rule).
- Known simplifications, accepted: collider handling is velocity
  damping + projection rerouting, not solid-boundary pressure
  conditions (flow can weakly graze concavities); dye injection isn't
  masked by collider solids (dye deposited inside an obstacle sits
  still); open-edge mode is Dirichlet-pressure outflow, not a true
  absorbing boundary.

## Cost

Per substep ≈ 12 + 2×iterations passes at grid res (default: 60 passes,
2 substeps, 512² on a 1024² canvas ≈ 31M fragment writes/frame — real-
time on integrated GPUs; drop `resolution` or iterations first).

## Recipes

- Deposit = Text spline → smoke-off-type; buoyancy 0.6, vorticity 12.
- Vortex Force pair + colored deposits → marbling-ish mixing.
- Spline Flow Field → `field` input, strength 1+ → art-directed plume
  path; the same spline's Stroke renders over it.
- `velocity` aux → Advect Points (vector) → points ride the smoke.
- Image-Mask Collider from a Text spline→mask → smoke parts around type.

## In-browser verification (owner pass)

- [ ] Deposit blob + buoyancy: rises, mushrooms, swirls persist (not
      dissipating in seconds — the reflection working).
- [ ] vorticity 0 vs 20: visibly more small-scale swirl, no explosion.
- [ ] Vortex/Wind/Turbulence force nodes behave like they do on the
      Particle Simulator; slots mint sockets.
- [ ] Circle collider: plume splits around it. Edges open: dye exits.
- [ ] `field` guide from Spline Flow Field steers the plume; `velocity`
      aux drives Advect Points sensibly.
- [ ] Scene loop restart clears the tank; offline video export matches
      realtime playback; non-square canvas has round swirls.
- [ ] Resolution 0.25 ↔ 1.0: comparable motion character (advection is
      resolution-normalized by construction; confinement strength does
      scale with grid — acceptable, it's a look dial).
- [x] Gates: typecheck / check / lint:ratchet green (2026-07-26).

## Roadmap position

M3 next: MLS-MPM (WebGPU) riding the same descriptor vocabulary —
particles socket out, matsuoka-601-style fixed-point atomicAdd scatter.
Deferred: flow maps (Leapfrog), wavelet-turbulence detail injection,
guiding, MoXi upgrade path for Watercolor Ink; watching Mixwell
(SIGGRAPH 2026) for a stateless mixing brush.
