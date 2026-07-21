# SPEC: Watercolor / Sumi Ink node (cellular-automaton ink simulation)

Implementation of Zhang, Sato, Takahashi, Muraoka & Chiba, *"Simple Cellular
Automaton-based Simulation of Ink Behaviour and Its Application to
Suibokuga-like 3D Rendering of Trees"* (J. Vis. Comput. Animat. 10, 1999) —
the 2D ink/water/paper/brush portion only. The 3D tree rendering section is
**out of scope**.

> **Status / re-homing note.** The original draft of this spec targeted a
> *standalone Vite single-page app* with its own canvas, `lil-gui` panel, and
> WebGPU-compute pipeline. Toolbox is a Next.js node-graph tool where effects
> are `NodeDefinition`s evaluated by a **WebGL2** engine (see
> [061226_devguide.md](061226_devguide.md)). This spec has been rewritten to
> build the effect as a **single self-iterating node** — the `watercolor-ink`
> node — following the exact pattern of the existing **Reaction Diffusion**
> node ([reaction-diffusion.ts](../src/nodes/effect/reaction-diffusion.ts)),
> which is already a self-iterating GPU cellular automaton with ping-pong
> state textures. The authoritative simulation math (§2) is unchanged from the
> paper. The WebGPU-compute design the original spec mandated is preserved as
> a **deferred future path** in Appendix A — it can't integrate today because
> WebGL↔WebGPU interop is a CPU Float32 hop (~16 MB/frame at 1024²; the
> engine caps it at ~1 MB), so it waits on a real WebGPU eval bucket. Decisions
> settled with the owner: WebGL2 now, WebGPU deferred; single node; deposition
> is **both** input-driven (graph-native) and live-paint (overlay).
>
> **Implementation status (2026-07-15):** M1+M2 shipped —
> [watercolor-ink.ts](../src/nodes/effect/watercolor-ink.ts) (registered in
> nodes/index.ts) implements the full CA (§2–§4), input-driven deposition
> (§5.1) including **colored ink** (per-channel absorption state + the
> `color` image input; owner request post-M2), Beer–Lambert render + debug
> views (§6), and the §7 params. The CA formulas and deposition model have
> been **verified against the primary source** (owner supplied the paper
> text): Step 1–4 match, the Step-3 typo correction is confirmed from the
> paper's unexpanded form, and deposition was reworked from a rate-stamp to
> the paper's self-limiting pipe-model contact (§5.1). The live-paint
> overlay (§5.2), brush CA (§5.3 — the paper's brush formulas are recorded
> there), and the §8 conservation readout are not built yet.

---

## 0. How this maps to Toolbox

| Original (standalone app)                    | Toolbox equivalent |
|----------------------------------------------|--------------------|
| Vanilla-TS Vite app, own canvas              | One `watercolor-ink` `NodeDefinition`, emits an `image` |
| WebGPU compute + storage buffers             | WebGL2 fragment passes + RGBA16F ping-pong textures (RD precedent). WebGPU deferred → Appendix A |
| `lil-gui` slider panel                       | Declared `ParamDef[]` → ParamPanel (keyframing / expose / export controls for free) |
| Live pointer brush (the whole app *is* one)  | (a) `deposit` input socket — any mask/spline/points/Paint node; (b) an optional **live-paint overlay** component |
| `d` key cycles debug views                   | A `view` enum (`headerControl`) on the node header |
| Corner mass-conservation readout             | Dev-time verification (console under a debug flag) — see §8 |
| Beer–Lambert composite to screen             | Beer–Lambert rendered internally to the node's full-canvas image output |
| 60 fps @ 1024² fixed                         | Reduced-res internal sim via a `resolution` param (RD does this), upsampled to canvas |

Everything else — the CA formulas, paper fibers (nijimi), brush dipping,
thin/thick contrast, kasure — carries over intact.

---

## 1. Deliverable

A single node, `src/nodes/effect/watercolor-ink.ts`, registered in
[src/nodes/index.ts](../src/nodes/index.ts), that:

1. Simulates water + ink transport on a 2D grid (the "paper") using WebGL2
   fragment-shader passes over RGBA16F ping-pong textures, per §2.
2. Models paper fiber structure affecting diffusion (nijimi), from a static
   paper texture generated CPU-side at init.
3. Accepts ink **deposition** from either a wired `deposit` input (mask /
   image / spline / points — anything that coerces to `mask`) or a live-paint
   overlay, running the brush→paper coupling of §5.
4. Renders the wet+dried result with a Beer–Lambert composite (§6) and emits
   it as the node's primary `image` output (colorize further downstream with
   Color Ramp / Color Correction if desired).
5. Exposes tuning via declared `ParamDef`s (§7); inherits the universal
   `opacity` param and universal `mask` input for free (do **not** hand-roll
   either — the evaluator applies them, per devguide invariant #6).

Category `image` / subcategory `modifier`; `backend: "webgl2"`;
`stable: false` (self-iterating, like RD). Target: real-time at a reduced
internal resolution (default 0.5×) with `substeps_per_frame` = 6 on an
M-series Mac.

---

## 2. Simulation model (authoritative formulas — unchanged from the paper)

All quantities are f32 (stored in RGBA16F texture channels). Grid is W×H
cells, Von Neumann (4-)neighborhood.

### Per-cell state

| Symbol | Meaning                              | Mutability | Storage |
|--------|--------------------------------------|------------|---------|
| W      | water particle quantity              | dynamic    | state.r |
| I      | suspended ink particle quantity      | dynamic    | state.g |
| D      | dried (fixed) ink                    | accumulates, never decreases | state.b |
| B      | bottom height (fiber structure)      | static after paper-gen | paperBC.r |
| C      | capture capacity (capillary trap)    | static after paper-gen | paperBC.g |

> Packing `(W, I, D)` into one RGBA16F ping-pong texture (a channel free for
> scratch) means the whole dynamic state is one texture pair — no separate
> `dried` buffer as the original spec had. `D` rides through the apply pass
> unchanged and is only mutated by the evap/fix pass.

### Derived

For an edge between cell `o` and neighbor `k`:

```
PipeHeight_ko = max(B_o, B_k + C_k)    // controls flow k -> o
PipeHeight_ok = max(B_k, B_o + C_o)    // controls flow o -> k
```

### Step 1 — Water transfer

```
dW_ko = max(0, 0.25 * alpha * min( (B_k + W_k) - (B_o + W_o),
                                   (B_k + W_k) - PipeHeight_ko ))
dW_ok = max(0, 0.25 * alpha * min( (B_o + W_o) - (B_k + W_k),
                                   (B_o + W_o) - PipeHeight_ok ))
netWaterFlux into o from k = dW_ko - dW_ok
```

After summing over neighbors, clamp `W_o = max(W_o, 0)`.

### Step 2 — Ink advection (ink rides the water)

Ink moves with each water flux at the **source cell's concentration at time
t** (pre-update values):

```
dI_ko = dW_ko * I_k / max(W_k, EPS)
dI_ok = dW_ok * I_o / max(W_o, EPS)
```

`EPS = 1e-6`. If a source cell's W < EPS, the corresponding dI is 0.

### Step 3 — Ink diffusion (concentration balancing)

> NOTE: the paper's printed expansion of this formula contains a typo
> (`I_o * W_o` should be `I_o * W_k`). Use the corrected form below.
> **Verified against the primary source (2026-07-15):** the paper's
> unexpanded form, `β[Ik − Wk(Io+Ik)/(Wo+Wk)]` (cell k's excess over its
> water-proportional equilibrium share), expands algebraically to
> `β(IkWo − IoWk)/(Wo+Wk)` — confirming the printed `IoWo` is the typo and
> the form below is the author-intended one.

```
dI_diff into o from k = beta * (I_k * W_o - I_o * W_k) / max(W_o + W_k, EPS)
```

This term is symmetric (what o gains, k loses). Only applies where both
cells have water (W_o + W_k > EPS); otherwise zero.

### Step 4 — Evaporation and fixing

```
W_o -= evapRate
if (W_o <= 0):
    W_o = 0
    D_o += I_o      // ink dries in place, permanently
    I_o = 0
```

Evaporation applies uniformly to every cell with W > 0, every substep.

**Re-wetting (extension beyond the paper, default off).** In the paper,
fixing is permanent — right for sumi, but it makes D accumulate
monotonically: a long-running comp drifts toward an opaque filter of
whatever channel its inks absorb most (warm inks → a yellow veil, then
black). The optional `rewet` rate lifts a fraction of D back into
suspension on cells that stay wet each substep (`I += rewet·D`,
`D −= rewet·D` — exactly conservative; both sides derive the wet test from
the same post-diffusion input). 0 = paper-faithful.

**Fade & lifetime (extensions, default off).** Two non-conservative exits
for ink (like evaporation for water), both authored in seconds and
converted to per-substep factors through the same fps × simScale²-scaled
substep count, so they're framerate- and resolution-independent:

- `fade` — fraction of ink (suspended **and** dried) lost per second,
  exponential, per-channel-multiplicative in absorption space so a fading
  mark passes through lighter tints of its own hue. Keyframing it to 1
  for a beat is a soft "clear the sheet".
- `lifetime` / `dissolve` — the dried buffer's spare alpha channel is an
  **age clock** (seconds since fresh pigment was banked). Past `lifetime`,
  the mark dissolves to ~1% over `dissolve` seconds. Gotcha: the fix
  pass's dry test is a *state* that recurs every substep, so the age
  resets **only when actual ink is banked** (`lum(fresh) > ε`) — an
  unconditional reset would pin every dry cell at age 0 and lifetime
  would never fire.

### Stability constraints (enforce as UI clamps in §7)

- `0 < alpha <= 1.0` (the 0.25 factor in Step 1 then guarantees total
  outflow per substep <= available water)
- `0 < beta <= 0.25`
- Clamp W and I to >= 0 after every apply pass.

---

## 3. Engine architecture (WebGL2 fragment-pass CA)

This section replaces the original WebGPU/storage-buffer design. It follows
the Reaction Diffusion node's proven structure verbatim in spirit; read
[reaction-diffusion.ts](../src/nodes/effect/reaction-diffusion.ts) alongside
it. **No WebGPU, no compute shaders, no storage buffers, no atomics.**

### 3.1 Textures, not buffers

Dynamic sim state lives in **node-owned RGBA32F textures** (created with raw
`ctx.gl` calls, wrapped in `ImageValue`-shaped objects so
`ctx.drawFullscreen`/`clearTarget` accept them as targets; deleted via
`gl.deleteTexture` in `dispose`, never `ctx.releaseTexture` — the pool
doesn't own them). **Why not pool RGBA16F:** half floats carry ~2⁻¹¹
relative precision, and the sim accumulates tiny deltas into large values —
`evapRate` 0.004 against a wet cell's W ≈ 60 is far below half-ulp at that
magnitude, so in 16F ink would never dry. RGBA32F render targets are covered
by the same `EXT_color_buffer_float` the engine already requires for 16F;
if it's absent the node emits blank paper with a one-time console warning.
State textures are NEAREST-filtered (float32 linear filtering needs
`OES_texture_float_linear`; sim passes use `texelFetch` and the render pass
bilinears by hand). The static paper texture and the full-canvas output stay
on engine conventions (`ctx.uploadFloat32ToImage` / `ctx.allocImage`).

The sim runs at a reduced internal resolution (`resolution` param, default
0.5) and is upsampled to full canvas for output, exactly as RD does.

**Ink is colored** — suspended and dried ink are per-RGB-channel Beer–Lambert
absorption densities, so a wired `color` image's hues survive advection,
diffusion, and drying (each channel obeys the same CA equations
independently; the paper's monochrome sumi is the special case of equal
channels). That widens the state to 7 fields across two ping-pong pairs, and
the four flux lanes (water + 3 ink channels) across two flux textures.

Persistent textures, held in `ctx.state[\`watercolor-ink:<nodeId>\`]` and torn
down in `dispose`:

| Texture         | Channels             | Format | Notes |
|-----------------|----------------------|--------|-------|
| `bufs[0..1]`    | (W, Ir, Ig, Ib)      | RGBA32F own | wet-state ping-pong pair |
| `dbufs[0..1]`   | (Dr, Dg, Db, —)      | RGBA32F own | dried-ink ping-pong pair (written only by the fix pass) |
| `fluxA`         | (rW, dW, rIr, dIr)   | RGBA32F own | RIGHT + DOWN edge net flux, water + red ink; rewritten each substep |
| `fluxB`         | (rIg, dIg, rIb, dIb) | RGBA32F own | green + blue ink lanes (one RGBA target can't hold 8 lanes — the flux shader is a template run twice with different output swizzles) |
| `paper`         | (B, C, —, —)         | RGBA16F pool (`uploadFloat32ToImage`) | written **once** per (seed, coarseness, dims) (§4); static; 16F is plenty for B/C magnitudes |

`(rW, dW, rI, dI)` = net water flux across this cell's right and down edges,
plus the advected ink for those same two edges. Packing all four into one
RGBA16F is the WebGL2 analog of the original spec's `fluxW`+`fluxI` buffers.

Uniforms per pass: `u_invRes` (1/simW, 1/simH), `alpha`, `beta`, `evapRate`,
`EPS`, deposition params. Plain `gl.uniform*` in the `ctx.drawFullscreen`
setup callback (see RD's step loop).

### 3.2 Conservation via canonical edge ownership (two-phase flux)

Mass conservation is exact by construction, same scheme as the original:

- **Flux pass** (`waterInkFluxPass`): each cell computes the *net signed
  flux* across its RIGHT edge and its DOWN edge only, writing
  `(rW, dW, rI, dI)` to `flux`. Advected ink uses the **pre-update** state
  (per Step 2). Positive convention: flow out of the cell (right / down) is
  positive. Reads `stateSrc`, `paperBC`.
- **Apply pass** (`applyFluxPass`): each cell gathers four values —
  its own right/down out-flux (negated) plus the right-flux of its **left**
  neighbor and the down-flux of its **up** neighbor (in-flux), for both W and
  I. Adds to (W, I), carries D unchanged, clamps W,I >= 0, writes `stateDst`.

Every edge is computed exactly once → no double counting, no atomics.

Boundary: on the right/bottom grid edge, write 0 flux for the missing edge;
on the left/top edge, read 0 for the missing neighbor's flux. No-flow
boundary — ink must never accumulate at or vanish through borders. In GLSL,
guard with `v_uv`/texel coordinate checks (or `texelFetch` with explicit
bounds); do not rely on `CLAMP_TO_EDGE` sampling to zero the flux for you.

### 3.3 Pass sequence per substep

With `src = bufs[readIdx]` and `other = bufs[readIdx ^ 1]`:

1. `fluxPass` ×2       — reads `src`, `paper`; writes `fluxA`, then `fluxB`
   (same template, different output swizzle)
2. `applyFluxPass`     — reads `src`, `fluxA`, `fluxB`; writes `other`
3. `inkDiffusionPass`  — reads `other` (gather Step 3 per channel: each cell
   evaluates the corrected antisymmetric formula against all 4 neighbors and
   applies its own half; antisymmetry makes gather conservative without edge
   ownership); W rides through; writes back into `src` — whose content is
   dead after pass 2
4. Step 4 splits in two, because it mutates both the wet state and the dried
   accumulator and a fragment pass has one render target. Both read the
   **same** post-diffusion `src`, so the "did this cell dry" test can't
   disagree between them:
   - `evapPass` — W −= evapRate; dried cells zero W and I; writes `other`
   - `fixPass`  — dried cells bank I into D; reads `dbufs[driedIdx]`, writes
     `dbufs[driedIdx ^ 1]`
5. `readIdx ^= 1`, `driedIdx ^= 1` — both pairs flip once per substep.

When depositing, a **pass 0** runs at the top of every substep: the
brush/paper contact exchange (§5.1), `src` → `other`, which also flips
`readIdx` — per the paper, brush contact iterates inside the same n-step
procedure as transfer/diffusion.

Deposition (§5) runs **before** the substep loop each active frame, injecting
W/I into `stateSrc`. Run `substeps_per_frame` (default 6) substeps per eval,
and only when the sim is "active" (see §3.4). After all substeps, a final
`renderPass` (§6) upsamples + Beer–Lambert composites `stateSrc` + `paperBC`
into a full-canvas `ctx.allocImage()` returned as `primary`.

### 3.4 Iteration gating & reset (copy RD exactly)

- `stable: false`; `fingerprintExtras` mixes `ctx.time` so every eval
  recomputes (RD returns `` `t:${ctx.time.toFixed(4)}` ``).
- **Active** substeps run while `ctx.playing` (default) — pausing freezes the
  wet field, scrubbing does nothing — **or during offline export when
  `ctx.time` advanced** (`ctx.offline && time > lastTime`): exports
  frame-step with `playing` false, and without this clause an exported video
  would freeze the wash (a gap RD still has). A
  `drive_by_scene_time` boolean + scalar `time` input (RD-style) swaps the
  gate for a wired monotonic scalar, so an Accumulator / Scene Time / Math
  source can pump the sim at a user's pace.
- **Reset** (re-init state to dry paper, `W=I=D=0`) when: first eval, or scene
  time wrapped back to ~0 (`wasNonZero && isNearZero`), or `simW/simH`
  changed (canvas resize / `resolution` edit — `ensureState` reallocates).
  Reset does **not** regenerate paper unless `regenerate` was bumped (§4).
- Node id is part of the state key so two watercolor nodes never fight over
  state (RD precedent).

Workgroup/tiling: N/A (fragment shaders). Plain `texture()`/`texelFetch`
reads; no shared-memory tiling.

### 3.5 Resolution independence

The CA's laws are per-CELL, so without correction a bigger grid shrinks
every visual length scale relative to the canvas — blooms spread fewer
canvas-fractions per frame, washes dry after less relative distance, fibers
shorten ("2048 never looks as good as 1024" at any slider setting). All
cell-scale quantities normalize to a reference grid via
`simScale = sqrt(simW·simH) / REF_CELLS` (`REF_CELLS = 512` — the default
0.5-resolution sweet spot at a 1024 canvas, so tuned setups keep their exact
look and other sizes now match it).

**The key insight (got this wrong once):** the Step-1 water update is a
degenerate **Laplacian relaxation** — for smooth fields
`ΣΔW ≈ 0.25·α·∇²W` — so the water surface spreads *diffusively*, radius ∝
`cell · √substeps`, NOT ballistically. Holding relative spread therefore
needs substeps × **simScale²**; linear scaling leaves a 2× grid ~30% slow
(1/√2), which is visible by eye.

| Quantity | Scaling | Why |
|----------|---------|-----|
| substeps/frame | × simScale² (cap `MAX_SUBSTEPS` = 48) | diffusive spread: relative radius ∝ √substeps / gridSize |
| evap, rewet | ÷ simScale² | same scene-time drying with more substeps |
| beta | **unchanged** | β·substeps·cell² is constant under quadratic substep scaling — cancels exactly, no stability-cap caveat |
| continuous contact strength | ÷ simScale² (cap 1) | same per-frame reservoir equilibration |
| fiber length | × simScale | canvas-relative fiber length holds |
| fiber count | area term ÷ simScale | conserved fiber material per cell: more, longer, (1-cell-)thinner fibers |

Cost note: substeps × simScale² on top of quadratic pixel growth — a 2048
canvas at 0.5 resolution costs ~16× a 1024 one, and past simScale ≈ 2.8 the
substep cap kicks in and spread degrades gracefully. That's the honest price
of the bigger grid; the cheap alternative is lowering `resolution` (the sim
then literally IS the smaller reference grid, upsampled).

---

## 4. Paper generation (CPU init → static texture)

CPU-side generation uploaded once as `paperBC` is preferred for simplicity
(exactly how the original spec allowed). Generate a `Float32Array` of
`(B, C)` per cell and upload via the engine's float-upload path (the same
`uploadFloat32ToImage` machinery gl.ts already exposes for the WebGPU
bridge), or draw fibers in a fragment pass into `paperBC`. CPU is fine — it's
one-time.

```
for every cell: B = B0, C = C0
repeat fiberCount times:
    pick random point p, random angle theta
    rasterize a segment of length fiberLen cells from p at angle theta
    for each cell under the segment:
        B -= fiberDB   (floor at 0.05)
        C += fiberDC
```

Defaults (for a 1024² grid — scale `fiberCount` by cell count at other
resolutions): `B0 = 8.0`, `C0 = 1.0`, `fiberCount = 50_000`,
`fiberLen = 14` cells, `fiberDB = 0.35`, `fiberDC = 0.12`.

Params: `fiberCount` exposed as **"paper coarseness"** (fewer fibers = coarser
= blobbier nijimi); a `paper_seed` scalar for deterministic regeneration; a
`regenerate` bump (a boolean or counter param the compute watches — bumping it
rebuilds `paperBC` **and** resets sim state). Non-square canvases: generate at
`simW × simH`; fibers are isotropic per-cell so aspect just stretches the
paper grain — acceptable, note it in comments.

---

## 5. Deposition & brush

Two deposition paths feed the same injection step. Both write W and I into
`stateSrc` before the substep loop.

### 5.1 Input-driven deposition (graph-native, core)

Two optional input sockets feed the inject pass:

- **`deposit`** (type `mask`) — coverage: where and how much water+ink lands.
  Kept as `mask` deliberately so spline / shape / Paint / image all coerce in
  (`spline→mask` and `image→mask` exist; there is **no** `spline→image`
  coercion, and `mask→image` yields alpha=1 everywhere — retyping this socket
  to `image` would have broken spline wires and flooded the sheet on mask
  wires).
- **`color`** (type `image`) — per-pixel ink color, **conserved** through
  advection/diffusion/drying via the per-channel state (§3.1). Absorption is
  the color's **normalized optical density**,
  `σ = ln(clamp(rgb, 0.004, 1)) / ln(0.004)` (i.e. `−ln(rgb)` scaled so pure
  black = 1): white pixels deposit clear water, saturated pixels stain their
  own hue, black is classic sumi. **Not** the linear form `1 − rgb`: the
  render is `exp(−k·σ)`, so optical density makes an accumulated wash render
  as `rgb^s` — thin deposits are a pale tint of the *same* hue and dwell
  deepens it like real glazing — whereas `1 − rgb` diverges channel ratios
  exponentially with dwell (the most-absorbed channel collapses first; a
  warm photo drifts olive-brown as blue dies). Unwired, ink color falls back
  to the `ink_color` param through the same formula (default black ⇒
  byte-identical to the monochrome behavior either way).

Two further optional **delivery-field** sockets (both `mask`-typed, so
noise/gradients/splines/images coerce in) turn the reservoir's scalars into
spatial fields, composing multiplicatively with everything else:

- **`water_map`** — scales the reservoir *head* per cell:
  `head(cell) = deposit_water · cov · waterMap`. Wired **alone** it
  deposits at cov = 1, i.e. first-class **pre-wetting** (brush clean water
  onto regions; ink later blooms wet-on-wet there).
- **`ink_map`** — scales pigment *concentration* per cell:
  `dI = dW · dip_concentration · inkMap · σ`. Ink rides water (Step 2), so
  an ink map over undelivered/dry cells contributes nothing — the
  dry-brush limit, by design (an ink map alone does not activate
  deposition).

Coverage resolution: `deposit` wired → its mask; else `color` wired → the
color image's own **alpha** doubles as coverage, so a single wire carries
both shape and hue (a shape-on-transparency deposits its silhouette; an
opaque photo wets the whole sheet uniformly and "watercolorizes"); else
`water_map` wired → coverage 1 (the map itself shapes delivery). None of
the above wired → no deposition.

**Straight-alpha discipline (bug class, learned the hard way):** in this
engine RGB under zero alpha is arbitrary — a Merge's transparent background
still carries its base layer's RGB (the same reason `image→mask` weights by
alpha, per the devguide). Pigment must therefore be computed from the
alpha-unweighted hue (`rgb / max(a, ε)`, recovers true ink color at
linear-filtered soft edges) and **scaled by alpha** (`σ × a`), so regions
the color image doesn't cover deposit clear water — never the ghost hue
squatting in the cleared surround. Without this, a deposit mask that
doesn't exactly coincide with the color image's opaque regions lays down
whatever stale color sits under the transparency (e.g. a Solid-Color merge
base), which then dries into a uniform tinted veil regardless of the actual
ink hues.

**Deposition is brush/paper contact, not a stamp** (paper-verified). The
paper has no "inject" — its brush exchanges with the paper through the same
Step-1 pipe model, iterated inside the same n-step loop as
transfer/diffusion. The node idealizes the wired deposit as an **infinite
reservoir riding the paper surface** at water level
`coverage × deposit_water`; substituting that brush cell (`Bb = Bo`,
`Cb = 0`) into the Step-1 formula collapses both min-arguments to the plain
level difference, so per substep:

```
dW   = max(0, 0.25 · alpha · (coverage · deposit_water − W))
dI_c = dW · dip_concentration · sigma_c        // Step-2: reservoir concentration
```

— an exponential approach to `W = coverage · deposit_water`. Deposition is
**self-limiting**: dwell tops the pool up against evaporation and outflow
but never floods past the head, and ink stops accumulating once the cell
equilibrates — which also bounds optical density, so a conserved `color`
settles at its own hue instead of deepening forever. Backflow (paper wetter
than the reservoir) is clamped off — two-way exchange (the brush
re-absorbing dilute ink) belongs to the M4 brush CA. `deposit_water` is
therefore a **level**, the paper/original spec's `dipWater` (default 60),
not a rate.

**Two pacing modes** share the contact shader (only the equilibration
strength differs), selected by `sample_rate`:

- `sample_rate = 0` (default, **continuous**): contact runs once per
  substep at strength `0.25·α` (top of the loop), so the reservoir competes
  with outflow and evaporation on equal terms, exactly as the paper's
  iterated procedure does.
- `sample_rate > 0` Hz (**sampled**): contact fires once every `1/rate`
  seconds of scene time at strength `1.0` — a full stamp of the input at
  that instant (the video-frame use case: each sampled frame lands as a
  complete wash, then blooms/dries untouched until the next tick). The
  first active frame stamps immediately; a cell still at its head from the
  previous stamp receives no *new* ink (`dW = 0`), so raise `evap_rate`
  until washes dry between ticks for a full frame-replace stop-motion look.

`dip_concentration` (0..1) is the thick/thin ink control from the paper's
dipping model (§5.2 of the original): high = thick ink (dark, wicks little),
low = thin ink (wicks far along fibers — the Figure-7 contrast). Deposition
**adds** to existing W/I (a wet area keeps accumulating), matching "slow
pointer movement naturally deposits more."

Because these are plain inputs, deposition is fully **keyframable,
animatable, and export-safe** — animate a spline, wire an LFO into
`deposit_water`, drive concentration off audio, feed video into `color` for
time-varying pigment, etc. This is the primary, always-available path.

### 5.2 Live-paint overlay (interactive)

An optional overlay component (`WatercolorOverlay.tsx`, modeled on
`SplineEditorOverlay` / `GradientOverlay` / the Paint node's pointer capture)
lets the user brush directly on the preview when the node is selected. It
captures pointer strokes (using `ctx.cursor`, which is stored Y-UP canvas UV —
see §10), resamples them to ~1 cell arc-length spacing, and writes pending
deposits into `ctx.state[\`watercolor-ink:<id>\`].pendingStrokes`, which
`compute` drains into `stateSrc` before stepping. Follow the session-store
pattern the browser-ML nodes use (state parked for `compute` to consume), so
the engine stays self-contained (invariant #1) and the overlay is pure UI.

`PointerEvent.pressure` (when present) modulates deposition amount /
footprint radius. Slow strokes deposit more (more frames over the same cells)
— the real-time dwell model, **not** the paper's per-stroke n(x) profile
(note this in comments, as the original did).

### 5.3 Brush model (optional enhancement — deferred)

The paper's second, smaller cellular automaton (the brush itself: bristles,
semicylinder load profile, contact offset, kasure via bristle depletion) is
**deferred to a later milestone**. The core node ships without it; kasure and
Figure-8 wet/dry-overlap fidelity are M3/M4 polish. When built, the brush CA
runs the same fragment passes (1–3, no evaporation) on its own small
(`96×96`) texture set, coupled to the paper in the deposition step per the
original §5.4 (treat each `(brushCell, paperCell)` pair as one CA edge,
brush bottom raised by `contactOffset = contactBase / pressure`, symmetric
exchange so the brush can re-absorb dilute ink from wet paper). Until then,
§5.1/§5.2 deposition is a coverage+concentration stamp, which already gives
nijimi and thin/thick contrast.

Brush orientation, dipping UI, and stroke-input resampling details from the
original §5 are preserved as reference for that milestone. From the primary
source, for M4 fidelity:

- Brush width from pressure: `Bw = γ(1 − exp(−P))` (the paper prints
  `1 − exp P`, a typesetting casualty — the saturating form is the sensible
  reading and matches the original spec).
- Brush tip gradient: `B += θx` with `x` = distance **from the tip** — the
  tip has the lowest bottom, so ink flows downhill toward it (Step 2 of the
  paper's brush modelling), plus 2D 1/f noise (`B += F`, Step 3) and
  bristle segments (`B −= ΔB, C += ΔC`, Step 4, parallel to the bristle
  axis).
- The paper's per-stroke iteration profile
  `n(x) = nmax − εL·(1 − [(x − L/2)/(L/2)]²)²` (slow at stroke start/end,
  fast in the middle → denser marks at the ends). Our real-time dwell
  through the per-substep contact pass replaces it; if a graph-driven
  "stroke" mode ever wants deterministic speed shaping, this is the curve.
- Brush posture: contact side axis-aligned; parallel to the paper's
  vertical axis for stroke angles ≤ π/4 from horizontal, horizontal
  otherwise.

---

## 6. Rendering & outputs

A final `renderPass` fragment shader upsamples the reduced-res sim (linear
filtering) and composites, writing a full-canvas `ctx.allocImage()`:

```
density_rgb = kDried * D_rgb + kWet * I_rgb   // per-channel absorption
trans       = exp(-density_rgb)
paperTint = paper_color * mix(0.97, 1.0, normalizedB)
            // user-set tint (default neutral #f7f7f6); fiber grain
            // modulates brightness only — hue-free
color   = paperTint * trans
// cool shift so wet suspended ink visibly "sets" (luminance-weighted):
color   = mix(color, color * vec3(0.96, 0.97, 1.0),
              clamp(kWet * lum(I) / max(lum(density), EPS), 0.0, 1.0) * 0.3)
outColor = vec4(color, 1.0);            // straight alpha (§10)
```

Defaults: `kDried = 0.9`, `kWet = 0.55`. Because ink is stored as
per-channel absorption (§3.1/§5.1), color needs no render-time tint — a
red-ink wash passes red and absorbs G/B by construction.

**Transparent output** (`paper_bg` off): solve straight-alpha `(rgb, a)` so
that source-over on a **white** backdrop reproduces the multiplicative stain
exactly (`rgb·a + (1−a) == trans`): `a = 1 − min(trans.rgb)`,
`rgb = (trans − (1−a)) / a` (both provably in [0,1]). Other backdrops are
approximate but plausible.

**Debug views.** A `view` enum param surfaced as `headerControl` (the enum
dropdown on the node header) replaces the original's `d`-key cycle:
`composite` / `water` (W heatmap) / `ink` (I heatmap) / `dried` (D) / `paper`
(B structure). Each just selects which channel the render pass visualizes.

The node's `mask` input (universal matte) and `opacity` param come for free
from the evaluator conventions — do not implement them.

---

## 7. Parameters (ParamDef table)

Declared `ParamDef[]` (keyframing / expose / export controls for free).
Scalars get sliders; use `softMax` for escape-hatch ranges (RD precedent).

| Param               | Label              | Default | Range        | Notes |
|---------------------|--------------------|---------|--------------|-------|
| `alpha`             | Flow rate          | 0.8     | 0.05 – 1.0   | Step 1 |
| `beta`              | Diffusion          | 0.12    | 0.0 – 0.25   | Step 3 |
| `evap_rate`         | Evaporation        | 0.004   | 0 – 0.05     | Step 4 |
| `rewet`             | Re-wetting         | 0       | 0 – 0.05     | dried→suspended lift on wet cells (§2 extension); 0 = paper-faithful |
| `fade`              | Fade / sec         | 0       | 0 – 1        | fraction of all ink lost per second (§2 extension); 0 = off |
| `lifetime`          | Dried lifetime (s) | 0       | 0 – 60       | age-based dissolve of dried marks (§2 extension); 0 = infinite |
| `dissolve`          | Dissolve (s)       | 1       | 0.05 – 10    | dissolve duration past lifetime; visible when lifetime > 0 |
| `wet_strength`      | Wet ink strength   | 0.55    | 0 – 2        | render `kWet` |
| `dried_strength`    | Dried ink strength | 0.9     | 0 – 2        | render `kDried` |
| `substeps_per_frame`| Substeps / frame   | 6       | 1 – 16       | |
| `resolution`        | Resolution         | 0.5     | 0.1 – 1.0    | internal sim scale (RD-style) |
| `deposit_water`     | Deposit water      | 60      | 0 – 200      | reservoir **level** (the paper's dip quantity), §5.1 (0 = keyframable off) |
| `dip_concentration` | Ink concentration  | 0.5     | 0.02 – 1.0   | thick↔thin |
| `fiber_count`       | Paper coarseness   | 50000   | 0 – 200000   | §4 (0 = uniform paper) |
| `paper_seed`        | Paper seed         | 0       | 0 – 1e6      | |
| `view`              | View               | composite | enum       | `headerControl` (§6) |
| `drive_by_scene_time`| Drive by scene time | false  | boolean      | optional (RD-style) |

`ink_color` (color, default `#000000`) is the fallback pigment when no
`color` input is wired (§5.1); `paper_bg` (boolean, default on) toggles the
opaque-paper vs transparent-ink composite (§6). `sample_rate` (scalar Hz,
0–30, default 0) selects continuous vs sampled deposition (§5.1).
`paper_color` (color, default `#f7f7f6` neutral) is the §6 paper tint — the
first build hardcoded warm-cream constants, which read as a strong yellow
cast over a full canvas; fiber grain now modulates brightness only, and the
tint is user-set. There is no button ParamType,
so "Regenerate paper" = bump `paper_seed` (regeneration keys off
seed/coarseness/dims) and "Clear" = restart the timeline (the scene-time-wrap
reset).

Enforce the §2 stability clamps via `min`/`max` above.

---

## 8. Mass-conservation verification (dev-time)

There's no "corner readout" surface on a node, so this is a **development-time
check**, not shipped UI. Behind a debug flag (e.g. a `__watercolorDebug`
global, or the `view` = a `conservation` mode), every ~30 frames do a
`ctx.readImagePixels`-style reduction (or `copyBufferToBuffer`-equivalent
readback of the small reduced-res state) and sum total W and total (I + D).
Between deposits, and after accounting for cumulative evaporated W
(`evapRate * wetCellCount` estimate is fine), total ink (I + D) must be
conserved to within 0.1% relative error over a 60-second session. If it
drifts, the flux scheme is broken (double-counted or dropped edge) — fix
before proceeding. Run the check with `fade = 0` and `lifetime = 0` (both
are deliberate ink sinks); `rewet` may stay on (it's conservative). Keep this as a Milestone-1 gate; it can compile out of the
shipped node.

---

## 9. Milestones (build order — verify each in the real app)

**M1 — Droplet on uniform paper.** No fibers (`fiber_count = 0`), no brush.
Wire a Circle (or a small mask) into `deposit` to drop a disc of W/I onto the
paper. Verify: smooth circular bloom, darker center, **no grid-axis cross
artifacts** (a `+`-shaped bloom = Von Neumann fluxes miswired or `alpha` too
high), ink dries to a soft-edged disc, mass conserved (§8). This proves §3's
flux/apply/diffuse/evap passes and the ping-pong discipline.

**M2 — Fibrous paper.** Enable §4 fiber generation. Verify: the same droplet
now feathers irregularly; a **thin** deposit (`dip_concentration` low, high
water) wicks visibly further along fibers than a **thick** one (Figure-7
contrast); coarse paper (`fiber_count = 8000`) blotchier than fine (50000).

**M3 — Deposition + live paint.** Input-driven deposition polished (animate a
spline into `deposit`; keyframe `deposit_water`), plus the `WatercolorOverlay`
live-paint path (§5.2). Verify: a slow wet thin-ink stroke blooms (nijimi)
around the trajectory; overlapping onto a **dry** previous stroke leaves both
marks distinct, onto a **wet** one bleeds them together (Figure-8).

**M4 — Polish.** `view` debug modes, conservation readout, brush CA / kasure
(§5.3), paper regen button, `ink_color`, docs page. Kasure (scratchy striated
breakup from a half-depleted brush) lands here with the brush automaton.

---

## 10. Pitfalls (engine-specific — read before writing code)

1. **Coordinate/alpha conventions** (devguide §Core mental model). GL textures
   sample `v_uv` **Y-UP** (v=0 at bottom); CPU geometry (splines/points
   feeding `deposit`, the paper fiber raster) is normalized **Y-DOWN**;
   `ctx.cursor` is **Y-UP** canvas UV. Flip Y at every boundary — if the
   deposition lands mirrored vertically vs. the wire you drew, you missed one.
   Alpha is **straight** (non-premultiplied) throughout.
2. **Texture discipline** (invariant #3). Persistent state textures live in
   `ctx.state`, released in `dispose`. Release the per-frame output/flux you
   `allocImage`, never release your **inputs'** textures. Reallocate state in
   an `ensureState` guarded on `simW/simH` (RD precedent).
3. **The Step 3 typo** (§2). Use the corrected antisymmetric form.
4. **Advected ink must use pre-update concentrations** — that's why the flux
   pass computes `(rI, dI)`, not the apply pass.
5. **`dW` clamps to >= 0 before multiplying by concentration** — a negative
   flux with positive concentration moves ink the wrong way.
6. **Never divide by W without the `EPS` guard** — dry cells with leftover I
   are common and NaNs propagate instantly through diffusion. RGBA16F stores
   fine, but a single NaN poisons the whole field within a substep.
7. **Buffer rotation discipline.** Per substep: flux×2 read `src`; apply
   reads `src` writes `other`; diffuse reads `other` writes `src` (dead
   after apply); evap reads post-diffuse `src` writes `other`; fix reads the
   SAME post-diffuse `src` + `dbufs[d]` writes `dbufs[1−d]`; then both
   `readIdx` and `driedIdx` flip. The contact pass (top of each substep,
   when depositing) also flips `readIdx`.
   Track roles as named locals per pass, don't rebind ad hoc. `ownsTextures`
   doesn't apply here (state isn't a pass-through), but do not leak: four
   persistent state textures + two flux + one paper, that's it. And mind the
   **ownership split**: `bufs`/`dbufs`/`fluxA/B` are node-created RGBA32F —
   `gl.deleteTexture` them; `paper` is an engine `uploadFloat32ToImage` —
   `ctx.releaseTexture` it. Crossing those up corrupts the pool.
8. **`stable: false` + `fingerprintExtras(ctx.time)`** or the evaluator caches
   the node and the sim freezes. Reset detection keys off `ctx.time` wrap
   (RD's `wasNonZero && isNearZero`).
9. **Reduced-res sim, 4-cell floor.** `simW = max(4, round(ctx.width *
   resolution))` so the Von Neumann stencil doesn't collapse. Upsample with
   linear filtering in the render pass.
10. **Non-square canvas.** Cells are per-texel; the CA is isotropic in cell
    space, so a non-square canvas stretches paper grain and bloom slightly —
    acceptable (note it), or run the sim square and letterbox. Decide
    explicitly per the devguide's anisotropy note.
11. **Engine self-containment** (invariant #1). The node file lives under
    `src/nodes/` and may not import from `components/`/`state/`/`lib/`. The
    overlay lives under `components/effects/` and talks to the node only via
    `ctx.state` / events — never the reverse.
12. **Back-compat** (invariant #2). Once shipped, the `watercolor-ink` type
    string and param names are frozen; renames need a load alias.
13. **Packed-state clears (shipped this bug).** When a texture's channels
    are packed state — `(W, Ir, Ig, Ib)` — the clear color is channel
    DATA, not a color. A reflexive `[0,0,0,1]` "opaque black" clear plants
    a full unit of blue-absorbing (yellow) pigment in every cell's `Ib`;
    the first substep's fix pass banks it into `D` as a permanent uniform
    yellow veil across the whole sheet (scaling with `dried_strength`).
    Clear packed state to all-zero, and audit every `outColor`'s fourth
    component the same way.

---

## 11. Out of scope

- The paper's 3D tree skeleton splitting, hidden-stroke elimination, and
  Z-buffer substroke division (Sections 4+ of the paper).
- Brush rotation along the stroke direction.
- Colloidal effects (viscosity, particle/water separation), kappitu
  dry-brush splitting — leave TODO hooks only.
- The full brush cellular automaton (§5.3) — deferred to M4, not v1.
- Multi-pointer / touch beyond basic single-pointer overlay drawing.
- A WebGPU-compute implementation (Appendix A) — deferred until the engine
  has a real WebGPU eval bucket and zero-copy interop.

---

## Appendix A — Deferred WebGPU-compute design

Preserved from the original spec's §3. **Do not build this yet.** It becomes
viable only when (a) the engine grows a real WebGPU compute eval bucket
(tracked in [webgpu-particles.md](webgpu-particles.md); the
[WebGPU Particle Test](../src/nodes/effect/webgpu-particle-test.ts) node is
the Phase-0 spike) and (b) WebGL↔WebGPU interop is zero-copy. Today the bridge
is a CPU Float32 hop ([gl.ts](../src/engine/gl.ts) `readImageToFloat32` /
`uploadFloat32ToImage`); at 1024² the (W,I,D,—) + flux state is ~16 MB/frame
each way — the devguide caps CPU-mediated interop at ~1 MB, so a per-frame
readback to produce an `image` output is not real-time. The WebGL2 design in
§3 is functionally identical (same edge-ownership conservation) and ships now.

When it *is* time, the compute version uses these mandatory choices:

- **Storage buffers, not textures.** `array<vec2f>` / `array<f32>` for all
  state (read_write is only guaranteed for r32float storage textures, and
  ping-pong is clearer with buffers). Index `i = y * gridW + x`.
  Paper buffers: `stateA/B` = vec2f (W, I); `paperBC` = vec2f (B, C), written
  once; `dried` = f32 read_write; `fluxW`/`fluxI` = vec2f (rightFlux,
  downFlux). Brush buffers mirror the schema at brush resolution
  (`brushStateA/B`, `brushBC`; no `dried` — brush ink never fixes).
- **Two-phase flux with canonical edge ownership** (identical math to §3.2):
  flux pass writes each cell's right/down net flux; apply pass gathers
  `-fluxW[self].x - fluxW[self].y + fluxW[left].x + fluxW[up].y`. Every edge
  once, no atomics anywhere.
- **Pass sequence** per substep: `waterInkFluxPass` → `applyFluxPass` →
  `inkDiffusionPass` (fused `evapFixPass`) → swap. `@workgroup_size(16, 16)`,
  plain global reads, no shared-memory tiling. Brush automaton runs passes
  1–3 (no evaporation) on its own buffers with the same modules and different
  bind groups; brush grid default 96×96.
- Boundary, dipping, footprint (`Bw = gamma * (1 - exp(-P))`), and the
  brush–paper coupling pass (`contactOffset = contactBase / P`, symmetric
  exchange) all as the original §5 described. Request the device with default
  limits; 1024² vec2f buffers are ~8 MB each, well under limits. Check
  `navigator.gpu` and show a clear unsupported message.
- Original pitfall set for the buffer path: read_write only for r32float; no
  `textureLoad` on storage buffers; footprint rect clipped to grid bounds
  before dispatch; EPS guard on every `/W`; `dW` clamps before concentration;
  advected ink from pre-update state.

The single-node packaging, reset/iteration gating (§3.4), deposition model
(§5), rendering (§6), params (§7), and milestones (§9) are unchanged whether
the core runs on WebGL2 or WebGPU — only §3's inner loop swaps.
