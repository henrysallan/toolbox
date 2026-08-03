# Matter Simulator — MLS-MPM deformable matter on WebGPU (M3)

Shipped 2026-07-27 (code; needs the in-browser pass below — this one
NEEDS calibration eyes more than M1/M2 did). M3 of the fluid arc
(M1: 072526_flow-fields.md, M2: 072626_fluid-simulator.md). One node,
`matter-simulator` ([matter-simulator.ts](../src/nodes/effect/matter-simulator.ts)),
category effect, backend **webgpu** — the first real WebGPU compute
node beyond the particle Phase-1 test.

## What it is

MLS-MPM (Hu et al. 2018), the browser-proven hybrid particle–grid
method — no neighbor search, which is why it reaches ~100k particles on
integrated GPUs where SPH stalls at ~30k. Material models follow the
classic taichi **mpm99**: liquid / jelly / snow are ONE solver with
different constitutive numbers — the art pitch is that the dials are
*material* words (stiffness, hardening), not solver words.

Per substep (fixed dt = speed/fps/substeps), four WGSL compute passes:

1. **clear** — zero the grid accumulators.
2. **P2G** — each particle computes its stress (fixed corotated via the
   closed-form 2×2 polar rotation — no SVD needed for jelly; μ=0 for
   liquid; snow hardens as exp(hardening·(1−Jp)) clamped [0.1,10]) and
   scatters mass/momentum + the fused MLS-MPM stress term
   Q = −4·dt·vol·σ + m·C over its 3×3 quadratic-B-spline stencil.
   **Fixed-point atomics**: WGSL atomicAdd is i32-only, so accumulation
   is `atomicAdd(round(v·2¹⁶))` — the scale cancels in momentum/mass.
   Overflow headroom checked: worst-case dense cell ≈ 1.8e9 < 2³¹.
3. **grid** — momentum/mass → velocity; gravity; force descriptors
   (applyForce mirrors the particle-simulator contract in the Y-DOWN
   canvas-UV seam — FOURTH copy of that contract: webgl GLSL, wgsl
   integrate.ts, fluid-sim GLSL, here); damping; analytic circle/line
   colliders as free-slip (remove the into-solid component); closed-box
   free-slip walls; **CFL safety clamp** (|v| ≤ 0.45·dx/dt) so stiff
   settings degrade instead of exploding. Collider surfaces are
   inflated by `collider_radius`.
4. **G2P** — APIC gather (C = 4B, quadratic, dx=1), advect, deformation
   update F ← (I + dt·C)F. Liquid: F ← √J·I (volume only — deviatoric
   part dies, mpm99's trick). Snow: singular-value clamp
   [1−2.5e-2, 1+4.5e-3] via F = R·S then symmetric eigendecomposition
   of S (U = R·V — no general SVD needed), Jp tracks the clamped
   volume for hardening. Writes the render layout (uv, age=1, ∞ life).

Internal frame: **grid index space, Y-DOWN, dx = 1** — storage buffers
only, no GL orientation anywhere, cells pixel-square (ny = nx/aspect).

## Calibration (owner-found bug, fixed 2026-07-27)

First in-browser pass: "particles don't collide with each other" —
they squashed straight through into a degenerate puddle. Root cause was
stress scale, twice over:

1. **Particle mass wasn't density-normalized.** mass=1 with ~17
   particles/cell made the grid material ~17× denser than the stress
   model assumed. Fix: `seedParticles` measures actual particles per
   touched cell and sets pMass = pVol = 1/perCell (clamped [1/64, 1]),
   so grid density ≈ 1 for ANY seeding density.
2. **The stiffness dial was ~2 orders too soft.** Hydrostatic balance
   needs λ ≈ ρ·g·h/δ ≈ thousands in index units; the old map capped
   E at 12.6k. New map: **E = 300·10^(3·s)** (300..300k, default
   s=0.5 ≈ 9.5k). CFL: c = √(λ/ρ) tops out ≈ 290 idx/s vs the grid
   clamp 0.45/dt = 270 — the clamp engages only at max stiffness
   (raise substeps there).

Reminder for future sims: in free fall MPM particles legitimately don't
interact (uniform velocity field) — ALL apparent "collision" is
compression response, so a stress-scale error reads as "no collisions."

## Collider radius + particle projection (owner request, 2026-07-27)

`collider_radius` (canvas-width fraction, default 0.004) inflates every
collider surface, sized to roughly match the Particles-to-Image sprite
size. With it came **particle-level projection in G2P**: grid BCs alone
let fast particles tunnel between grid nodes and let sprites visually
sink centers-deep into surfaces; G2P now projects positions out of the
padded circle/line surfaces and removes the into-surface velocity
component (containers project inward to radius − pad). Defaults also
changed: forceCount 2 and colliderCount 1 (was 0/0 — a fresh node had
nothing wired to play with).

## Seeding & I/O

- `seed` (points) — initial particle placement: THE toolbox move
  (Scatter Points in a Text spline → text made of water). Cycled with
  jitter if count exceeds the points.
- `region` (mask) — rejection-sampled fill (≤128² CPU readback at
  reset only).
- Neither → centered block that falls and splashes.
- Reseed on: fresh state, scene-wrap, or a seed-signature change
  (seed param, material — F/Jp semantics differ —, input shape).
  No continuous emitters in v1 — deliberate; MPM emission needs
  dead-slot recycling and is a follow-up.
- **Outputs**: primary `particles` (for Particles to Image), aux
  `points` (the entire points ecosystem: Copy to Points on goo, Points
  to Spline / metaball surfaces later). Both are ONE FRAME BEHIND.

## The WebGPU bridge (Phase-1 pattern, inherited)

Same shape as particle-simulator-webgpu.ts: async device boot cached in
ctx.state (`matter-simulator:<id>:status`); compute submits this
frame's substeps then kicks copyBufferToBuffer → mapAsync; the NEXT
compute drains the Float32Array via uploadFloat32ToImage into the
ParticlesValue bridge texture AND keeps it CPU-side (`lastPositions`)
so the points aux stays populated on paused evals (stable:false runs
compute every eval — consuming the readback once and going empty was
the bug to avoid). **Offline export**: the mapAsync promise is pushed
via pushMediaSettle; the export driver's settle→re-render drains it,
and the re-render can't double-step because time hasn't advanced (the
offline active-gate requires time > lastTime). Readback cost: count ×
16B (8k default = 128KB; 128k cap = 2MB/frame — above the 1MB comfort
note, same accepted Phase-1 tradeoff as the particle path; the fix is
the future direct-render phase).

Bind groups + pipelines are built once per state (stable buffers), one
encoder per substep (params buffer rewrite must queue-order between
submits — only `time` differs).

## Owner-feedback round 2 (2026-07-27, same day)

- **Per-material dials** (params visibleIf material; each mode
  remembers its own tuning; the retired shared `stiffness` reads as
  fallback): liquid = Stiffness + **Viscosity** (real viscous stress
  σ += μv·(C+Cᵀ) in P2G, μv = dial²·300 — water→honey); jelly =
  Stiffness; snow = Stiffness + **Crumble** (`snow_yield` → the
  singular-value clamp range, θc = 0.005+0.05·y, θs = 0.18·θc) +
  Hardening.
- **`particle_radius`** (what "collision radius" honestly means in MPM
  — separation doesn't come from pairwise contacts, it comes from
  pressure preserving seed density): seeds on a jittered grid at 2r
  spacing instead of random stacking; the material relaxes back to ~2r
  apart at rest. May seed fewer than the budget (`liveCount` — kernels,
  readback points, and dead-slot handling all iterate it; renderOut is
  re-zeroed on reseed so a shrink leaves no ghosts). Ignored when
  explicit seed points are wired.
- **Spline obstacles + working image-mask colliders** via ONE baked
  SDF: the new `obstacle` spline input (Path2D fill, spline→mask
  coercion rules: subpaths closed, even-odd) unions with any Image Mask
  Colliders' alphas (readImagePixels at grid res) → two-pass chamfer →
  signed distance in index units (negative inside) → storage buffer.
  Rebaked ONLY when a source's value identity changes, so animated
  spline obstacles work at ~ms cost. Grid pass: free-slip on ∇sdf +
  full stop deep inside; G2P: bilinear sdf sample, project out by
  (pad − sd), kill into-velocity. Row 0 = top everywhere — no flips.
- Why colliders looked broken: nodes created before this round stored
  colliderCount 0 (no sockets minted — raise "Collider slots" or
  re-add), and image-mask colliders were silently ignored until the
  SDF path landed.

## Known limits (documented, accepted)

- One frame of latency on both outputs.
- No per-particle material mixing (seed groupIndex → material is an
  obvious follow-up).
- Grid ≤ 256 across; particle cap 131072 (readback-bound).
- No WebGL fallback — non-WebGPU browsers get the node-level error.
- Obstacle SDF is grid-res: features thinner than ~2 cells blur; raise
  `grid_res` for skinny spline obstacles.

## In-browser verification (owner pass — calibration matters here)

- [ ] Default block, liquid: falls, splashes, pools flat, settles calm
      (no jitter carpet, no explosion). Stiffness low = soupy, high =
      choppy water.
- [ ] Jelly: block bounces and wobbles, holds shape; stiffness sweep
      soft→rubbery without instability.
- [ ] Snow: clumps, fractures, packs; hardening 0 vs 15 visibly
      different.
- [ ] Seed from Scatter Points in a Text spline: text-shaped water
      collapses. Region mask fill works.
- [ ] Vortex/Wind force nodes stir the material like they stir
      particles; circle collider parts the flow (free-slip slide).
- [ ] Points aux drives Copy to Points / Points to Spline; stays
      populated when paused.
- [ ] Scene-loop restart reseeds deterministically; offline export
      matches realtime (one-frame latency consistent, no stale frames);
      non-square canvas doesn't stretch the material.
- [ ] Calibrate defaults during this pass: stiffness mapping constants,
      gravity 0.6, substeps 10, grid 96 — all chosen analytically, all
      negotiable by eye.
- [x] Gates: typecheck / check / lint:ratchet green (2026-07-27).

## Roadmap position

The five-mode survey is now: Field ✅(M1) · Ink ✅(M2) · Matter ✅(M3) ·
Paper ✅(Watercolor Ink, pre-existing) · Hero (Leapfrog flow maps) —
deferred, revisit if/when the real-time flow-map papers ship code.
Cross-cutting follow-ups, roughly in value order: screen-space fluid
rendering for Matter (the render IS half the look), MPM emitters +
per-particle materials, image-mask colliders via cached mask upload,
wavelet-turbulence detail layer for the Fluid Simulator, MoXi upgrades
for Watercolor Ink, Mixwell watch (SIGGRAPH 2026).
