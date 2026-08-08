# WebGPU Particle Pipeline — Path A Migration Spec

A spec for moving the particle simulation system off WebGL2 fragment-
GPGPU and onto a WebGPU-native compute pipeline that **never round-
trips through WebGL** for particle state. This is the "Path A" option
from the earlier tradeoff discussion: full migration, no fallback,
particle data lives entirely in WebGPU buffers from spawn through
render.

The goal is to unlock the architectural ceiling — 500k+ particles,
multi-pass compute kernels (sort, neighbor binning, density
estimation), zero readback latency — and to lay down WebGPU
infrastructure that other compute-heavy nodes can reuse.

This spec assumes we've already accepted the tradeoffs:

- **WebGPU-only.** Browsers without WebGPU lose the simulator. No
  WebGL fallback shipped.
- **Compositing redesign.** Particles render through a WebGPU pipeline,
  not the existing WebGL2 framebuffer pipeline.
- **Two-renderer engine.** Until we migrate every other node to
  WebGPU (out of scope for this doc), the engine carries both a
  WebGL2 context (for everything else) and a WebGPU context (for
  particles).

---

## Current state — what we're replacing

### Nodes in scope

The particle subsystem today is:

- **Particle Simulator** ([src/nodes/effect/particle-simulator.ts](../../src/nodes/effect/particle-simulator.ts))
  — 1083 lines. Single fragment-shader pass per frame, ping-pong
  RGBA16F textures for `position` and `velocity`, multi-render-target
  output via `gl.drawBuffers`. Hard caps: `MAX_FORCES = 8`,
  `MAX_EMITTERS = 4`, `MAX_COLLIDERS = 6`. Practical particle ceiling
  ~65k.
- **Particles to Image** ([particles-to-image.ts](../../src/nodes/effect/particles-to-image.ts))
  — point-sprite render via `gl_VertexID` + `texelFetch` on the WebGL
  position texture. No vertex buffer.
- **Force sources** (gravity, drag, point, vortex, wind, turbulence) —
  CPU descriptor structs only, no GPU work.
- **Emitter sources** (point, image_mask) — same.
- **Collider sources** (circle, line, image_mask) — same.

Force / emitter / collider source nodes are **already backend-
agnostic** — they emit pure data structs (`ForceDescriptor`,
`EmitterDescriptor`, `ColliderDescriptor`) defined in
[engine/types.ts](../../src/engine/types.ts). They don't need to change.

### Engine prep that already exists

- **WebGPU device bootstrap** in [engine/gl.ts:113-136](../../src/engine/gl.ts#L113-L136)
  — `getWebGPUDevice()` returns a cached `Promise<GPUDevice | null>`.
  Already on `RenderContext`. No work needed here.
- **CPU-mediated bridges** — `readImageToFloat32` /
  `uploadFloat32ToImage`. **Path A doesn't use these for the per-
  frame loop.** They remain useful for the (cached) one-shot upload
  of mask images into WebGPU.
- **Standalone WebGPU prototype** at [src/lib/gpu/](../../src/lib/gpu/) +
  [GPUCanvas.tsx](../../src/components/GPUCanvas.tsx) — full-canvas
  WebGPU renderer with WebGL2 fallback. **Different concern** (full-
  canvas backend selection, not compute kernels). Don't conflate; do
  not rip it out, but it's not part of this work.

### What the existing code teaches us

The existing GLSL fragment kernel maps almost 1:1 to a WGSL compute
kernel. The biggest engineering questions aren't the kernel itself —
they're at the system boundaries:

- How does WebGPU output end up on the user's `<canvas>` alongside
  WebGL2 output from other nodes?
- How do `image_mask` emitters/colliders consume WebGL `ImageValue`s?
- How does `particles` flow through the engine evaluator (which today
  knows only about WebGL textures)?
- How does the engine save/load state when sim buffers are GPUBuffer
  objects with no JSON shape?

Answers below.

---

## Target architecture

### New socket type semantics

The existing `particles` socket type stays. Its **value shape changes**:

```ts
// Before (engine/types.ts)
export type ParticlesValue = {
  kind: "particles";
  positionTex: WebGLTexture;
  velocityTex: WebGLTexture;
  width: number;
  height: number;
  count: number;
};

// After
export type ParticlesValue = {
  kind: "particles";
  // Live WebGPU buffers — opaque to non-particle consumers.
  // Layout: positionBuffer holds vec4<f32>(x, y, age, lifetime) per
  // particle; velocityBuffer holds vec4<f32>(vx, vy, _, _).
  positionBuffer: GPUBuffer;
  velocityBuffer: GPUBuffer;
  count: number;
  // Backing texture dimensions retained for layout convenience —
  // count = width * height. Many algorithms (e.g. sort, scan) expect
  // a 2D layout for tile sizing.
  width: number;
  height: number;
  // The device the buffers were allocated on. Consumers must match.
  device: GPUDevice;
};
```

Consumers (Particles to Image, future Particle Sort, etc.) must be
WebGPU-aware. `particles` becomes a WebGPU-only socket type — wiring
it into a WebGL-only consumer will be a runtime error (we'll add a
type guard at evaluation time).

### Render integration — the compositing question

The hard one. Three options, ranked by simplicity:

#### Option 1 — Per-frame readback (the easy way out)

Particles to Image runs WebGPU compute that rasterizes particles into
a WebGPU texture, then **reads that texture back** into a WebGL2
texture each frame. Downstream effects (Bloom, Merge, Color
Correction) consume the resulting WebGL texture as today.

- **Pros:** zero compositing changes. The rest of the node graph
  doesn't even know WebGPU exists. Particles compose with everything.
- **Cons:** kills the "no readback" Path A win. Bridge cost is now
  one image-sized round-trip per frame (e.g. 2048×2048×16 bytes =
  16MB per frame, ouch). At full project resolution this is too
  expensive.

#### Option 2 — Dual canvas, WebGPU on top

The existing main `<canvas>` stays WebGL2. A second `<canvas>` is
overlaid with `position: absolute` and runs WebGPU. Particles to
Image renders into the WebGPU canvas. Browser z-orders the two.

- **Pros:** zero readback. Full Path A perf. Easy to ship.
- **Cons:** particles can't be composited *inside* the node graph.
  Anything downstream of Particles to Image that expects an image
  input (Merge, Bloom, Color Correction) gets a transparent input
  — particles only show "above" the rest. The export pipeline
  would need to handle this layering too (likely via two `<canvas>`
  elements in the export template, composited via CSS).

#### Option 3 — Tile-by-tile interop

WebGPU writes into a small WebGPU texture, downscaled or tiled, then
that gets read back as just enough data to composite. This is the
research-y middle ground and not worth pursuing in v1.

#### Recommendation

**Ship Option 2.** It's the only option that delivers Path A's
performance promise. The compositing limitation is real but bounded:

- Particles can still composite *with* a background image — Particles
  to Image takes a `background` input today. We rasterize that
  background to the WebGPU canvas first as a quad-blit (one quick
  WebGL→WebGPU upload, cached on `ImageValue` identity), then draw
  particles over it.
- For "particles passing through a Bloom" — users do the bloom on the
  background image *before* feeding it to Particles to Image, then
  blend the resulting glow into the particle render via the WebGPU
  canvas's blend state. Effects-on-particle-output still possible
  via output-end re-readback, but it's an opt-in escape hatch, not
  the default.
- For projects where particles need to be deeply integrated with
  downstream image effects (rare), Option 1 stays available as a
  per-node toggle: "Read back to WebGL (slow)".

The export template will need a small change to include both canvases
in the right z-order. Bounded scope.

### Engine evaluator changes

The evaluator currently assumes one GPU context. With WebGPU added:

- `RenderContext` grows a `gpuDevice: GPUDevice | null` field —
  resolved before the first eval frame (block until
  `getWebGPUDevice()` resolves on first run; subsequent runs are
  sync). If null, particle nodes return empty output and surface a
  one-time error.
- Synchronization order per frame:
  1. All WebGL2 nodes evaluate (existing behavior).
  2. All WebGPU nodes evaluate (new bucket — currently just particle
     nodes, future-extensible).
  3. Cross-context blits (e.g. background image → WebGPU sampler).
  4. Final canvas presentation.
- Topo order across both buckets is preserved. The bucket boundary
  doesn't reorder dependencies; it just batches kernels to minimize
  context switching overhead.

### Mask image flow into WebGPU

`image_mask` emitters and `image_mask` colliders take a WebGL
`ImageValue` (the mask). Inside a WGSL kernel we need a sampleable
WebGPU texture.

Bridge once, cache forever. Per emitter / collider mask:

- Cache key = the `ImageValue` object identity (already used by
  `Modulate Points` for the same problem).
- On miss: read back the WebGL texture via existing
  `readImageToFloat32`, upload to a WebGPU texture via
  `device.queue.writeTexture`, store in node state.
- On hit: reuse the cached WebGPU texture.
- Disposal: when the node disposes, release the WebGPU texture.

Animated masks (e.g. webcam-driven collider) refresh every frame —
acceptable cost since masks are typically small (≤ 1024²).

### Persistent state shape

`ctx.state[`particle-sim:${nodeId}`]` becomes:

```ts
interface SimState {
  device: GPUDevice;
  count: number;
  width: number;
  height: number;
  // Ping-pong buffers
  posA: GPUBuffer;
  posB: GPUBuffer;
  velA: GPUBuffer;
  velB: GPUBuffer;
  readIdx: 0 | 1;
  // Reusable bind-group layouts and pipelines, cached on first
  // compile. Pipeline keyed by (force kinds, emitter kinds, collider
  // kinds) tuple — same idea as the structural-hash trick we use
  // for the SDF compiler.
  pipelineCache: Map<string, GPUComputePipeline>;
  // Cached WebGPU mask textures, keyed on source ImageValue.
  maskCache: WeakMap<ImageValue, GPUTexture>;
  lastTime: number;
}
```

Save/load: GPUBuffers are runtime-only — the saved project re-creates
them on first run. Same as how WebGL textures are reborn per session
today.

---

## Phased plan

Each phase ends with a working, shippable system. We don't break the
existing simulator until the WebGPU one is at parity.

### Phase 0 — Spike (the proof point)

**Scope:** A new node `WebGPU Particle Test` that does only:

- Allocate WebGPU buffers for 100k particles.
- Run one compute kernel per frame: `pos += vel * dt`, gravity, simple
  bounds-bounce.
- Render via a tiny WebGPU vertex pipeline drawing `count` points to
  a dedicated `<canvas>` (overlay).

**Goal:** Validate the system boundaries, not the simulator features.
Specifically:

- The WebGPU device boots, kernels compile, pipelines bind correctly.
- The dual-canvas overlay composes acceptably with the existing
  WebGL canvas (z-order, alpha blending, resize handling).
- The eval loop can call into the WebGPU bucket without races.
- 100k particles run at 60fps comfortably.

**Decision gate:** if Phase 0 doesn't comfortably hit 100k @ 60fps —
or the dual-canvas compositing has visible artifacts (depth
discontinuities, blend-mode mismatches) — we stop and reconsider
Path B with Option-1 readback.

**Time:** 1-2 days.

### Phase 1 — Core simulator + integration kernel

**Scope:** Replace `particle-simulator.ts`'s WebGL pass with a WGSL
compute kernel that handles the integration loop. Force kinds in
this phase:

- gravity
- drag
- bounds (off / bounce / wrap / clamp / kill)
- age + lifetime + dead-slot reaping

Other force kinds and all emitter / collider kinds **still fall back
to a stub** (zero-out their effect). Spawning is hardcoded — every
slot starts with a uniform random position and zero velocity, just
to have something to integrate.

**New files:**

- `src/engine/webgpu/device.ts` — boot wrapper, error taxonomy.
- `src/engine/webgpu/buffers.ts` — particle buffer allocation,
  ping-pong helpers, layout helpers.
- `src/engine/webgpu/pipelines.ts` — pipeline-cache infrastructure
  keyed on a structural shape (which forces / emitters / colliders
  are wired). Same trick as the SDF compiler.
- `src/engine/webgpu/wgsl/integrate.wgsl` (or inline) — the kernel.
- `src/nodes/effect/particle-simulator.ts` — rewritten to be a thin
  shell that builds a structural key, looks up / compiles the right
  pipeline, dispatches the kernel, returns a `ParticlesValue`
  pointing at the output buffer.

**Goal:** end-to-end working sim with a subset of features. Existing
test scenes that use only gravity + drag should look identical.

**Time:** 2-3 days.

### Phase 2 — Force kinds

Port the remaining force kinds to WGSL:

- point (radial attractor / repeller)
- vortex (tangential swirl)
- wind (constant directional)
- turbulence (curl-noise — needs a simplex-WGSL helper, port from the
  existing GLSL `snoise2` in [particle-simulator.ts:157-179](../../src/nodes/effect/particle-simulator.ts#L157-L179))

Each force kind = one WGSL function. The kernel's force loop calls
them in order. Pipeline cache keys grow by the set of force kinds
present, so wiring a new force kind triggers a one-time pipeline
recompile.

**Time:** 1-2 days.

### Phase 3 — Emitters

Port the spawn logic to WGSL — same hash-based ticket pattern as
today. Two emitter kinds:

- `point` — straightforward random-around-a-point spawn.
- `image_mask` — needs the cached WebGPU mask texture from the
  bridging plan above. Rejection sampling in WGSL: try N candidate
  UVs, accept first one above threshold, fall through to "no spawn"
  if all rejected.

**Risk:** the texture-cache invalidation needs to handle the
animated-mask case (webcam, video, etc.). Cache key = `ImageValue`
identity is correct: when the upstream re-renders, it allocates a
new `ImageValue`, cache misses, refresh fires. Static mask images
(loaded files, generated noise) keep the same `ImageValue` across
frames, cache stays warm.

**Time:** 1-2 days.

### Phase 4 — Colliders

Port collision response. Three collider kinds:

- `circle` — closed-form distance test, reflect velocity.
- `line` — half-plane test, reflect.
- `image_mask` — sample mask alpha at pos, central-difference
  gradient for normal, reflect or kill. Same cached-mask
  infrastructure as Phase 3.

The existing GLSL collision response code in
[particle-simulator.ts:213-274](../../src/nodes/effect/particle-simulator.ts#L213-L274)
is the reference — port one-to-one.

**Time:** 1-2 days.

### Phase 5 — Particles to Image (WebGPU render)

Replace the existing fragment-shader render with a WebGPU vertex
pipeline:

- Bind the simulator's positionBuffer as a vertex buffer (or as a
  storage buffer read in the vertex shader via `vertexIndex`, mirror
  of the existing `gl_VertexID` + `texelFetch` pattern).
- Render to the dedicated WebGPU canvas overlay. Background image
  blits in first (cached upload from WebGL).
- Point-sprite render with the existing param model (color, size,
  opacity, blend mode, fade-with-life).

**Compositing:** the WebGPU canvas alpha-composites over the WebGL
canvas via CSS positioning. Z-order is fixed (WebGPU on top). Future
work could add a "render order" param if needed.

**Time:** 2 days.

### Phase 6 — Simulation Zone integration

Verify the existing Simulation Zone end-node still produces correct
behavior when its `state` is now a WebGPU `ParticlesValue`. Likely
no changes — Simulation Zone's image/points/spline state envelope
already handles arbitrary kinds; particles flow through it
opaquely.

**Time:** 0-1 day.

### Phase 7 — Export template + project save/load

Update [src/export-template/](../../src/export-template/) to:

- Include both `<canvas>` elements (WebGL2 main + WebGPU particles).
- Refuse to run cleanly if the host browser lacks WebGPU (clear
  error message, link to browser support docs).
- Include the WebGPU pipeline JS and WGSL kernels in the bundle.

Project save/load needs no changes — runtime state (buffers) is
re-created on load, same as WebGL textures today.

**Time:** 1-2 days.

### Phase 8 — Telemetry, error UX, polish

- One-time fallback message when WebGPU is unavailable: "Particle
  Simulator requires WebGPU — your browser doesn't support it. See
  [docs link]."
- A no-op `ParticlesValue` (zero count) so downstream graphs evaluate
  without throwing.
- Performance overlay extension — surface compute-pass duration
  separately from WebGL render time so users can see where their
  frame budget goes.
- Per-node "Force readback" toggle for users who want particles
  inside the WebGL effect chain (Option-1 escape hatch — slow but
  available).

**Time:** 1-2 days.

**Total estimated:** 11-17 working days. Realistic with testing,
unknowns, browser-specific bug hunts: **3-4 weeks calendar.**

---

## Risk register

### Browser availability risk

WebGPU is GA in Chrome / Edge (since 2023), Safari 18.2+ (Dec 2024),
Firefox stable behind a flag (as of early 2026). Roughly 70-75% of
users have it on by default; the rest see an error.

**Mitigation:** clear error UX, document the requirement, link to
browser updates. Eventually this becomes 95%+; we're paying short-
term distribution cost for long-term architectural win.

### Compositing correctness risk

Dual-canvas overlay has subtle issues:
- DPR (device pixel ratio) mismatches between the two canvases.
- Resize must keep both in sync.
- Blend-mode interactions at the canvas boundary (alpha channels
  must agree).
- Z-fighting in PNG export — the recorder needs to composite both
  canvases into a single output.

**Mitigation:** Phase 0 spike specifically validates this. If it
looks bad, fall back to Option 1 (readback) selectively.

### Mask refresh cost risk

Live-changing mask sources (webcam → image_mask collider) refresh
every frame. Webcam frames are typically 640×480×4 bytes = 1.2MB,
~70 MB/s bridge cost at 60fps. Tractable but eats into the perf
budget.

**Mitigation:** profile in Phase 3. If it's a problem, consider
running a downscale shader on the WebGL side first and transferring
the smaller texture.

### Two-renderer maintenance risk

Until the rest of the engine moves to WebGPU (out of scope), we
maintain WebGL2 + WebGPU forever. Bug fixes affect one or the other
depending on which subsystem broke. Onboarding new contributors
gets harder.

**Mitigation:** keep the WebGPU surface area surgically small — only
the particle subsystem in v1. Don't let WebGPU creep into nodes that
don't need it. The boundary is enforced by the `gpuDevice` field on
`RenderContext` — only nodes that explicitly reference it touch
WebGPU.

### Rollback risk

Once Phase 1 ships, the old WebGL simulator is gone. If a serious
WebGPU bug surfaces in production, rollback means reverting the
release.

**Mitigation:** keep the old GLSL simulator code in a parallel file
(`particle-simulator-webgl.ts`) for one release cycle, behind a
feature flag (`useWebGPUParticles: boolean` in user settings,
default true). After one stable release, delete the legacy code.

### Async device init race

`getWebGPUDevice()` is async; the eval loop is sync. First-frame
particle nodes might fire before the device resolves.

**Mitigation:** at engine boot, await the device promise once before
the first eval. Subsequent calls are sync. Cost: ~50-100ms boot
delay on first eval, only on browsers where WebGPU is available
(WebGPU-less browsers see the error immediately).

---

## What this unlocks (post-migration)

The reason to do all of the above:

- **Particle counts in the 500k–2M range** on capable hardware.
- **Future compute nodes** can land trivially:
  - SPH fluid solver (needs neighbor binning + density estimation —
    requires compute + atomics).
  - Particle-particle attraction / repulsion (O(n²) → O(n log n)
    with a sort-based broadphase).
  - GPU-side spatial sort for depth-correct rendering of translucent
    particles.
  - Density-driven color / size modulation.
- **Other slow nodes can adopt the same infra:**
  - Modulate Points (currently a CPU bottleneck — the user has
    flagged it on devlist) — convert to a compute kernel.
  - Reaction-diffusion — currently fragment GPGPU, would step in
    fewer passes via compute.
  - Proximity merge — currently O(n²) on CPU, becomes O(n log n)
    with WebGPU spatial hashing.
  - Audio FFT — compute kernel rather than CPU loop.

The infrastructure work in Phases 0-1 (device, buffers, pipelines,
canvas integration) is shared across all of these. Pay it once on
particles, reuse it indefinitely.

---

## Out of scope for v1

- Migrating non-particle nodes to WebGPU. The engine stays bi-
  backend; only the particle subsystem moves.
- Native zero-copy `WebGLTexture ↔ GPUTexture` interop. Not exposed
  by browsers yet; if it lands, it dramatically reduces the mask-
  refresh cost but doesn't change this architecture.
- Particles consumed by Copy-to-Points (the CPU-readback path that
  the existing `outputPoints` toggle enables). For Path A this would
  require a sync `GPUBuffer` readback every frame — same constraint
  as today's WebGL `gl.readPixels` pattern. Keep it as an opt-in
  toggle with the same warning.

---

## Decision summary

Adopting Path A means:

- A real performance ceiling change (~10× particles).
- Foundational WebGPU infrastructure for the engine's compute future.
- Permanent loss of the WebGL fallback for the particle subsystem.
- 3-4 weeks of focused engineering.
- Compositing model changes (dual canvas, particles on top).
- An ongoing two-renderer maintenance burden until the rest of the
  engine follows.

The right call iff the visual goal is "make ambitious particle
sims first-class" — i.e. you'd rather ship 500k-particle scenes for
Chrome users than ship 65k-particle scenes for everyone. If "every
viewer can see every project" is the goal, ship Path B / Path C
instead and revisit Path A when WebGPU hits ~95% browser share.
