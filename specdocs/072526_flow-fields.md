# Flow fields — divergence-free field authoring + image advection (M1)

Shipped 2026-07-25. First milestone of the fluid-simulation arc (survey →
design Q&A 2026-07-24). Roadmap: M2 = Fluid Simulator (2D Eulerian
ink/smoke, spec 072626_fluid-simulator.md), M3 = MLS-MPM (WebGPU),
deferred = flow maps, wavelet-turbulence detail injection, guiding;
watching Mixwell (SIGGRAPH 2026) for a closed-form stateless brush node.

## Design decisions (owner-approved 2026-07-25)

1. **Velocity fields travel as plain images** — signed-RG, midlevel 0.5,
   the encoding Perlin Noise's `curl` type already emits and Displace /
   Advect Points (`vector` mode) already read. No new socket type, no
   invariant-#7 ripple. The convention is formalized in ONE place,
   [engine/velocity-field.ts](../src/engine/velocity-field.ts):
   - decode `v = 2·(c − 0.5)`, v ∈ [−1,1] per axis
   - **Y-DOWN** (positive vy = screen-down, CPU geometry space). GPU
     consumers tracing in Y-UP `v_uv` space step
     `uv -= vec2(v.x, -v.y·aspect)·k` — the y sign flips at the GL
     boundary exactly like Displace's offset.
   - **isotropic canvas-width units**: |v| covers equal PIXELS on both
     axes; steps scale the y component by aspect (w/h) in uv space
     (Advect Points' stepOnce convention). Producers generate in the
     aspect-corrected space (X = x, Y = y/aspect) so swirls stay round.
   - magnitude is normalized "full speed", not physical px/s; consumers
     own their distance/step dials. Encode clamps to [−1,1].
   - CAVEAT: matting an encoded field via the universal mask decodes as
     v = (−1,−1) — matte the CONSUMER's output, not the field.
2. **No new curl-noise node** — Perlin Noise `type: curl` is already the
   Bridson generator (stream-function fBm, aspect-corrected, animated
   evolution, exact encoding above). Obstacle handling deliberately did
   NOT grow on it (or on any producer) — it lives in a composable
   modifier (Flow Obstacle) that works on ANY field.
3. **Stateful sims keep the house contract** (session-only `ctx.state`,
   advance-on-clock-move, reset on time-wrap, offline export exact via
   sequential frame-stepping). No bake system as a prerequisite; M1 is
   entirely STATELESS anyway (scrub-safe, cache-friendly).
4. **Separate focused nodes over a monolithic fluid node** — the
   rope/rigid-body precedent. M2's solver consumes the existing
   force/collider descriptor vocabulary.

## The nodes

### Spline Flow Field (`spline-flow-field`, spline/modifier)

Draw a curve → divergence-free velocity field that follows it (the
control-curve authoring primitive; splines are first-class here, so this
is the killer field-authoring node — spec inspiration: Galerkin
regularized-Stokeslets control-curve authoring, SIGGRAPH 2024).

Method: **regularized vortex dipoles** along the curve, not Stokeslets —
same art-directable outcome, no 2D Stokes-paradox log growth, exactly
divergence-free (a sum of point vortices is the curl of a scalar
potential). Per arc-length sample `i` (arc-uniform via
`measureSpline`/`sampleSplineAt` over the concatenated subpaths, ≤96
samples into a uniform vec4 array — `xy` = position, `zw` = unit tangent
× ds, both in isotropic Y-DOWN space):

- **along** mode: a counter-rotating pair straddles the curve at
  `±width·n̂` (n̂ = rot90(t̂)). Between the pair flow runs along +t̂; far
  away the dipole decays ~1/r². Derivation: with rot90(r) = (−ry, rx),
  vortex A at C+h·n̂ with +Γ and B at C−h·n̂ with −Γ each contribute
  Γ·rot90(r)/(|r|²+ε²); at the center both point along +t̂. Packing zw =
  t̂·ds keeps the shader sign-safe: perp() is linear, so n̂·Γ =
  perp(t̂·Γ), and a negated strength flips flow through the (linear)
  gain uniform.
- **orbit** mode: single same-sign vortices — circulation around the
  whole stroke (vortex-filament look).

Normalization: continuous-limit speed at the curve is 2πγ (along; dipole
sheet) / πγ (orbit; vortex sheet), so gain = strength/2π (resp. /π) makes
a long straight run advect at ≈ `strength` regardless of sample count.
ε = softness·width (regularization, floor 1e-3). `field` input =
composition seam: upstream field decoded, summed, re-encoded — chain
Perlin curl + several Spline Flow Fields into one flow.

### Flow Obstacle (`flow-obstacle`, image/modifier)

Field in, obstacle mask in (splines/shapes coerce straight into the mask
socket), field out. `deflect` removes the velocity component aimed INTO
the obstacle within a soft shell (slip redirect — flow parts around the
shape) and damps the solid core; `block` damps by coverage (dead-water).
The shell comes from wide 5-tap finite differences at `radius`
(isotropic: y taps ×aspect; gradient flipped to Y-DOWN). Not exactly
divergence-free (Bridson potential-modulation only works at generation
time) — accepted, reads right. Chain several for multiple shapes.

### Advect Image (`advect-image`, image/modifier)

Advect Points' sibling for pixels: per-pixel backward semi-Lagrangian
trace, `steps` × (distance/steps), re-sampling the field each step so
content follows curves; steps=1 ≈ Displace. STATELESS — keyframe
`distance` 0→N to animate flow. Field modes mirror Advect Points exactly
(vector / angle / gradient / contour: luminance FD taps are
aspect-corrected, gradient flipped to Y-DOWN) so one field drives points
and pixels identically. Optional speed image (luminance multiplier,
sampled along the trace). Edge rule on the SOURCE sample: transparent /
clamp / wrap / mirror.

Two passes: (1) integrate the trace → write final source coordinates
into a `uv` texture; (2) sample source through it. The uv map is
therefore a free first-class **`uv` aux output** (reuse the warp in any
uv consumer). Built UNCONDITIONALLY — cacheable node, so
consumption-gating would serve a stale empty forever once wired (the
loop-weave rule). Missing field ⇒ 0 steps ⇒ identity map ⇒ pass-through
(Displace's missing-input convention).

## Recipes

- Perlin Noise (curl) → Advect Image: classic flowing-smoke warp.
- Spline Draw → Spline Flow Field → Advect Image (keyframe distance):
  content streams along a drawn path.
- Same field → Advect Points (vector) + Advect Image: points and pixels
  ride one flow.
- Any field → Flow Obstacle (obstacle = Circle/Text spline) → consumer:
  flow parts around a shape.
- Spline Flow Field (orbit) around a logo spline → Advect Points trails:
  orbiting streamlines.

## Verification (manual, in-browser)

- [ ] Curl field → Advect Image on a photo: swirls round on 16:9 canvas.
- [ ] Spline Flow Field along: flow hugs an S-curve both directions
      (negative strength reverses); orbit circulates; `field` chain sums.
- [ ] Flow Obstacle deflect: streamlines (Advect Points trails) part
      around a circle instead of entering it.
- [ ] Advect Image uv aux drives another sampler; edge modes behave;
      distance keyframe scrubs deterministically.
- [ ] Gates: typecheck ✅ / check ✅ / lint:ratchet ✅ (2026-07-25).
