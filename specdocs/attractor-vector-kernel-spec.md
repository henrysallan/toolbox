# Toolbox Vector Kernel — kurbo/WASM Implementation Spec

**Status:** v1 SHIPPED 2026-07-30 (M1+M2, plus the polyline route via input shaping —
see below). Doc lineage: v2 reconciled against the codebase; v2.1 refocused on the
path-optimizer node (offset / stroke expansion / dashing / booleans deprioritized).

**Implementation status:**
- `rust/toolbox-vector-kernel` — kurbo 0.13.1 pinned; `simplify`/`bbox`/`area` ops,
  wire codec, native `cargo test` suite. Artifact committed: `src/wasm/pkg` (bindgen
  glue) + `public/wasm/v1/kernel_bg.wasm` (77 KB raw). Rebuild: `npm run build:wasm`.
- `src/engine/vector-kernel.ts` — facade + SplineValue↔PathData adapter (px-space,
  tags preserved). Lazy main-thread init; **no worker pool yet** (fits are sub-ms in
  adaptive mode; pool waits for real profiling need).
- `src/nodes/effect/optimize-path.ts` — the Optimize Path node (tolerance px,
  adaptive/optimal, corner angle). Passthrough + pipeline-bump until the kernel
  loads; `fingerprintExtras` busts the cache when it flips ready.
- `scripts/check-kernel.mts` in the `npm run check` CI chain (independent §10.2-style
  deviation verification). Headline: 512-point noisy circle → 7 anchors (optimal) /
  53 (adaptive); corners exact; a pure cubic reproduces at 0.000 px.
- **2026-07-31 ("P0" from the kernel audit): `optimal` is now OUR shortest-path/DP
  subdivision optimizer** (`rust/toolbox-vector-kernel/src/opt.rs`, implementing
  Levien's May-2025 Zulip sketch — still unimplemented upstream as of kurbo 0.13.1)
  instead of `fit_to_bezpath_opt`. Properties: never worse than adaptive by
  construction (adaptive boundaries are DP candidates; every failure path falls back
  to adaptive output), retires the `fit_to_bezpath_opt` unwrap trap (kurbo#268 — no
  panic path remains in our optimal mode), and measures both better and faster than
  `_opt`: 2048-seg noisy blob 75 → 32 verbs at 14× native speed (194 ms → 14 ms;
  ~36 ms in WASM), cornered wobble within 1 verb. Tuning: REFINE=4 candidates per
  adaptive span, BACKTRACK_SLACK=8 — slack is measured in candidates, so denser grids
  need proportionally wider slack, and non-monotonic fittability on noisy input
  rewards a generous one. Kernel v0.2.0; binary ~92 KB.
- **§6.2's sampled-table source did not need building** — see "Kernel input shaping".
  Deferred: worker pool, `fitSampled`, offset/stroke/dash/transform/flatten (M4).

**Kernel input shaping (empirical, load-bearing — the adapter owns this):**
Two input classes make kurbo's fitter fragment catastrophically (~1.5 output curves
per INPUT segment) instead of simplifying; both were found during implementation:
1. **Coincident-endpoint runs.** A smooth closed loop traversed in full gives the fit
   a zero-length chord frame: a full-circle polyline explodes 257→385 verbs while the
   same shape as a 350° arc fits to 29. The adapter therefore splits closed subpaths
   into TWO open half-arcs (tangents computed on the full ring first, so the stitched
   seams stay G1); cost is one extra pinned anchor.
2. **Vertex-aligned subdivision on raw polylines.** Subdivide mode halves at t=0.5;
   when a LineTo run's segment count is 2^k-aligned, every subdivision boundary lands
   exactly on a vertex, whose one-sided tangent poisons the fit's endpoint conditions
   (128-segment semicircle → 245 verbs; 129 segments → 22). Fix: handle-less anchors
   get TS-side Catmull-Rom tangents — one-sided where the join exceeds the corner
   angle, so corners still flush — and every segment is emitted as a G1 cubic. This
   is kurbo's own documented recommendation for point-sequence input, and it made the
   dedicated sampled-table source (§6.2) unnecessary: the smooth-source encoding does
   that job through the ordinary wire format.
3. **The |tan| corner-test fold (2026-08-02).** kurbo's corner flush compares
   `|cross| > |dot|·tan(θ)`, and |tan| folds past 90° — near-reversal joins (thin
   spike tips, turn → 180°, cross → 0) classify as SMOOTH, so the sharpest tips were
   approximated within tolerance (visible curl/overshoot) while moderate corners
   pinned exactly: "identical spikes handled inconsistently". Both modes now split
   runs in `opt.rs::split_runs` with a normalized-dot-vs-cosine test, monotone over
   the full 0–180° range; the smoothing pass pins raw-position corners for the same
   reason. Thin tips now interpolate exactly (spike-star regression in check-kernel).
4. **Exactly-straight ranges explode the fitter (2026-08-02).** With both endpoint
   tangent angles ~0 a straight source has zero area and moment against its chord,
   the quartic has no solution, `fit_to_cubic` returns None, and `fit_to_bezpath`
   bisects forever — straight halves stay straight, so recursion grows EXPONENTIALLY
   (a multi-minute hang from one straight flank). Latent upstream: the fold bug (3)
   bent runs around spike tips and accidentally shielded it; fixing (3) exposed it.
   Fix: `chord_or_fit` — every range is sampled against its chord first (2× max
   deviation within accuracy + forward-monotone) and returns the chord cubic with
   measured error before the quartic is consulted; both DP and our own depth-capped
   adaptive recursion (`adaptive_rec`, kurbo's rec shape + this guard + chord
   fallback at max depth) route through it, so termination is unconditional and no
   path reaches kurbo's raw recursion. Worth reporting upstream with (3).
**Owner:** Henry
**Target:** Toolbox (Next.js 16 web app + Electron desktop shell, TypeScript)

> Naming note: v1 was drafted under the codename "Attractor"; the shipping product is
> **Toolbox** (`package.json`, `com.isthishenry.toolbox`). This doc now says Toolbox
> throughout and names the crate `toolbox-vector-kernel`.

---

## 1. Purpose

**The product goal is one node: take messy spline/curve data and emit the cleanest,
most economical cubic-Bézier path that stays within tolerance.** Messy input is
whatever the graph produces — pencil drawings, marching-squares traces (Text,
image-to-spline), pasted/traced SVG art, simulation output (rope / rigid body),
noise-displaced or resampled paths — dense, jittery, over-anchored. The output is the
minimal-segment path a person would have drawn deliberately: few anchors, smooth where
the data is smooth, sharp where it has corners.

That is a curve-fitting problem, and it is exactly what kurbo's `simplify`/`fit`
machinery is best at. Rather than hand-porting those numerics to TypeScript, we compile
[kurbo](https://github.com/linebender/kurbo) to WebAssembly and expose a narrow, typed
TS API over it. The same binary incidentally makes offset curves, stroke expansion,
dashing, and better measurement primitives cheap to add later — those are **explicitly
secondary**: they ship only after the optimizer node is solid (§12), if at all.

**Non-goals for v1:** boolean path operations (kurbo doesn't provide these, and Toolbox
already ships a TS implementation — see §14); stroke expansion, dashing, and offset
(present in kurbo, deferred to a late milestone).

### 1.1 What exists in TS today — what the kernel replaces vs. adds

The codebase already has a substantial pure-TS geometry layer, centered on
`src/engine/spline-math.ts` (bezier-js + hand-rolled code) with siblings
(`spline-boolean.ts`, `spline-offset-resolve.ts`, `spline-flatten.ts`, `spline-fill.ts`,
`spline-trim.ts`, …). Per capability, the kernel is one of two different things:

| Capability | Today | Kernel status |
|---|---|---|
| Bezier fitting | `fitSplineToPolyline` (Schneider '90) — Pencil tool, weave, blend-intersections | **Upgrade** — kurbo's fitter is curvature-aware with real cusp handling |
| Simplification | `simplifyPolyline` (RDP, polyline-only) | **Upgrade** — true curve-space simplify |
| Offset | `offsetSubpath` (bezier-js per-cubic + manual arc corner stitching) + `resolveSubpathOverlaps` | **Upgrade** — `CubicOffset` is principled where bezier-js is heuristic |
| Arc length / sampling | `measureSpline` / `sampleSplineAt` | Upgrade (determinism), low priority |
| Flatten | `flattenSpline` (fixed 16 subdivisions → Float32Array) | **Upgrade** — adaptive, tolerance-driven |
| bbox / area / winding / contains | `splineBbox` (sampled), `subpathSignedArea`, `pointInGeom` | Upgrade, low priority |
| Booleans | `splineBoolean` (flatten → polygon-clipping → refit) | Out of scope v1; kernel improves the refit leg (§14) |
| **Stroke expansion** | **does not exist** — stroke width never becomes a path | **Net new** |
| **Dashing as geometry** | **does not exist** — Canvas2D `setLineDash` only (rasterize-spline) | **Net new** |

Priority follows the product goal: the **fitting and simplification rows are the
point** — `fitSplineToPolyline` (Schneider over polylines: no curvature awareness, no
cusp handling) and RDP are what cap output quality today, and kurbo replaces both. The
net-new rows (stroke expansion, geometric dashing) and the remaining upgrade rows are
things the same binary happens to unlock later; none of them justify the kernel on
their own and none block v1. Migration must be per-callsite and reversible — the TS
implementations stay until the kernel path is verified against them, and they double
as independent cross-checks (§10.2).

### 1.2 The v1 deliverable — an "Optimize Path" node

One spline→spline node (working name: **Optimize Path**; spline modifier):

- **Input:** any `spline` — per-subpath, arbitrary anchor density, open or closed.
- **Params:** `tolerance` (canvas px — the §7.1 convention; slider with `softMax`),
  `mode` (`adaptive` default / `optimal` — §7's FitMode), `corner_angle` (tangent
  discontinuity threshold in degrees above which a point is preserved as a hard corner
  rather than smoothed over; default ~30°), `smoothing` 0–1 (pre-fit Laplacian denoise
  of handle-less anchors, default 0 — on jittery traces this lets adaptive mode beat
  raw-input optimal: 512-pt noisy circle → 4 anchors at 0.22 px worst deviation),
  `cull_length` (drop subpaths under N px arc length — trace dust; default 0 = off),
  `show_debug` (skeleton overlay aux image: source in grey under the result's
  anchors + handles + count readout; shows on node select via the preview fallback).
- **Output:** the fitted spline. Subpath count, order, `closed`, and
  `groupIndex`/`driver` tags preserved 1:1 (§5.4). Culled subpaths are removed.

Messy input arrives in two shapes, dispatched per subpath to two kernel routes:

1. **Already-bezier input** (pencil autofit output, imported SVG, generator nodes):
   encode to PathData, run `simplify_bezpath`.
2. **Effectively-polyline input** (marching-squares traces, simulation output,
   resampled/displaced paths — long runs of anchors with missing or degenerate
   handles): fit via the sampled-table source (§6.2), tangents estimated by central
   differences. **Corner detection is the quality-critical step here:** split the run
   at tangent-angle breaks ≥ `corner_angle` (and at pinch/duplicate points), fit each
   run independently, rejoin — corners survive exactly, smooth spans get smoothed.
   The split-at-corners preprocessing lives in TS (it's cheap and wants tuning); the
   fitter inside each run is the kernel.

Caching: the node is a pure function of (input spline identity, params), so the
standard fingerprint cache makes it free while upstream is static — which matters,
because fitting is the most expensive op in the kernel (§11).

---

## 2. Why WASM rather than a TS port

Recorded for posterity; the decision is made.

1. **Numerical correctness.** The core fitting routine reduces to a quartic solve and must
   find *all* real roots reliably, including near double roots where solution parameters
   jump discontinuously. kurbo's solvers, arc-length/inverse-arc-length routines, and ITP
   root finder are years-hardened. A fresh implementation fails subtly, not loudly.
2. **Determinism.** This is the underrated argument and it matters specifically for a
   render tool. `Math.sin`/`cos`/`atan2`/`pow` are **not** specified to bit-level precision
   in JS and differ across engines and platforms. A WASM module ships its own libm compiled
   in, so transcendentals are bit-identical everywhere. Combined with WASM's strictly
   IEEE-754 f64 arithmetic, the same project produces the same geometry on every machine —
   which is a prerequisite for frame caching, distributed rendering, and reproducible exports.
3. **Maintenance.** We track kurbo upstream instead of owning a fork of its numerics.
4. **Architectural coherence.** kurbo is the geometry layer beneath Vello. If Toolbox's
   WebGPU path ever adopts Vello, the CPU and GPU sides already agree on
   representation and tolerance semantics.

**Accepted cost:** a Rust toolchain in CI, a thin FFI layer we own, and one binary artifact.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Toolbox node graph (TS, main thread)                   │
│    - VectorKernel facade (async, worker-backed)         │
│    - SplineValue ↔ PathData adapter (§5.4)              │
└───────────────┬─────────────────────────────────────────┘
                │  structured clone / transferable ArrayBuffers
┌───────────────▼─────────────────────────────────────────┐
│  Worker pool (N = min(4, max(1, hwConcurrency-2)))      │
│    - one WASM instance per worker                       │
│    - stateless request/response, path-level parallelism │
└───────────────┬─────────────────────────────────────────┘
                │  wasm-bindgen
┌───────────────▼─────────────────────────────────────────┐
│  toolbox-vector-kernel (Rust cdylib)                    │
│    - wire format encode/decode                          │
│    - source-curve adapters (ParamCurveFit impls)        │
│    - panic containment                                  │
├─────────────────────────────────────────────────────────┤
│  kurbo (pinned)                                         │
└─────────────────────────────────────────────────────────┘
```

**Key decision: no threading inside WASM.** Rayon-in-WASM requires `SharedArrayBuffer`,
which requires COOP/COEP headers — controllable in Electron, painful in a browser build.
Instead we parallelize at the *path* level in JS across a worker pool, each holding its own
single-threaded WASM instance. The workload (many independent paths) suits this perfectly
and the implementation is dramatically simpler. (The same SharedArrayBuffer constraint
already forced ffmpeg.wasm onto its single-threaded core in this codebase — see
`src/lib/export-ffmpeg.ts`.)

**Precedent in-tree:** the EXR decode pool (`src/engine/exr/decode-pool.ts` +
`exr/worker.ts`) is exactly this shape — module workers via
`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` (the form
webpack statically analyzes), sizing `min(4, max(1, hardwareConcurrency - 2))` (adopted
above), a job queue with transferable ArrayBuffers, and per-worker crash recovery. Copy
its structure rather than inventing a second pool idiom.

---

## 4. Rust crate

### 4.1 Cargo.toml

```toml
[package]
name = "toolbox-vector-kernel"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
kurbo = "=0.13.1"            # PIN EXACTLY — latest as of 2026-07-30. See §4.2.
wasm-bindgen = "0.2"

[dev-dependencies]
wasm-bindgen-test = "0.3"

[features]
default = []
debug-panics = ["console_error_panic_hook"]

[dependencies.console_error_panic_hook]
version = "0.1"
optional = true

[profile.release]
opt-level = 3        # NOT "z" — this is hot numeric code, size is secondary
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
```

Do **not** use `wee_alloc` — it is unmaintained and has known fragmentation bugs. The
default dlmalloc is fine; allocation is not on the hot path here.

### 4.2 Version pinning — important

kurbo's `fit` module is comparatively young and its API has changed across minor versions.
Cautionary tale: v1 of this spec pinned `=0.11.1`, which was already two minor series
stale by the time it was checked (0.12.0 shipped 2025-09, 0.13.0 2025-11; 0.13.1 is
current as of 2026-07-30). **Pin the latest at implementation time, commit `Cargo.lock`,
and verify every signature against `docs.rs/kurbo/<pinned-version>` before writing
code.** Do not trust signatures reproduced
in this spec or recalled from training data — check the docs. Specifically confirm:

- `kurbo::fit::ParamCurveFit` — method names and arities
- `kurbo::fit::fit_to_bezpath` and `fit_to_bezpath_opt`
- `kurbo::simplify::simplify_bezpath` and its options struct
- `kurbo::offset::CubicOffset` construction
- `kurbo::stroke::{stroke, Stroke, StrokeOpts}` and `dash`

If a signature differs from this document, the docs win; update this document.

### 4.3 Module layout

```
src/
  lib.rs          — wasm_bindgen entry points only, no logic
  wire.rs         — PathData encode/decode, validation
  ops/
    simplify.rs
    offset.rs
    stroke.rs
    fit.rs        — sampled-table + callback source curves
    measure.rs    — area, perimeter, bbox, winding, contains
    flatten.rs
  sources/
    sampled.rs    — SampledCurve -> impl ParamCurveFit
  err.rs          — KernelError, result encoding
```

Rule: `lib.rs` contains *only* `#[wasm_bindgen]` shims that decode, delegate, encode, and
convert errors. All logic lives in plain Rust modules so it is testable with `cargo test`
natively (fast) as well as under `wasm-bindgen-test`.

---

## 5. Wire format

The single most important interface decision. Paths cross the boundary as **two flat typed
arrays**, never as objects.

### 5.1 Encoding

```
verbs:  Uint8Array    — one byte per path command
coords: Float64Array  — packed x,y pairs, tightly consumed by verb order
```

| Verb | Byte | Coords consumed |
|------|------|-----------------|
| MoveTo | 0 | 2 |
| LineTo | 1 | 2 |
| QuadTo | 2 | 4 |
| CurveTo | 3 | 6 |
| ClosePath | 4 | 0 |

This mirrors SVG/Skia/Lottie conventions, is trivially validatable, and requires zero
per-segment allocation on either side.

### 5.2 Validation

Validate on **both** sides. JS-side validation gives good error messages; Rust-side
validation prevents traps.

- `verbs.length > 0`
- first verb is `MoveTo`
- `coords.length` exactly equals the sum implied by `verbs`
- every coord is finite (reject `NaN`/`±Inf` explicitly — a single NaN will silently
  poison a fit into producing garbage rather than erroring)
- verb bytes are in `0..=4`

### 5.3 Returning data — the detachment footgun

**WASM linear memory detaches every time it grows.** Any `Float64Array` view created over
`wasm.memory.buffer` becomes a zero-length detached view after *any* allocation inside WASM.
This is the #1 source of heisenbugs in this kind of binding.

Two safe patterns, in order of preference:

**A. Copy-out immediately (default).** Return `ptr`/`len`, create the view, `.slice()` it to
copy into a fresh JS-owned buffer, then free the WASM allocation — all with no intervening
WASM calls.

```ts
const handle = wasm.simplify(verbsPtr, verbsLen, coordsPtr, coordsLen, tolerance);
// no WASM calls between here...
const verbs = new Uint8Array(wasm.memory.buffer, handle.verbsPtr, handle.verbsLen).slice();
const coords = new Float64Array(wasm.memory.buffer, handle.coordsPtr, handle.coordsLen).slice();
// ...and here
wasm.free_result(handle.id);
```

**B. Let wasm-bindgen do it.** Returning `Vec<f64>` from a `#[wasm_bindgen]` fn produces a
copied `Float64Array` automatically. Slightly more allocation churn, much harder to get
wrong. **Start here.** Only move to pattern A if profiling shows the copy is material —
it almost certainly will not be, since fitting cost dwarfs memcpy by orders of magnitude.

Codify the rule as a comment in every binding function: *never hold a memory view across a
WASM call.*

### 5.4 Toolbox adapter — SplineValue ↔ PathData

The wire format is *not* Toolbox's native representation. The engine's `SplineValue`
(`src/engine/types.ts`) is `{ subpaths: SplineSubpath[] }` where each anchor stores
`pos` plus **relative** `inHandle`/`outHandle` offsets, in **normalized [0,1]², Y-DOWN**
space; a missing handle collapses to the anchor (straight segment); `closed` is a
per-subpath flag; subpaths may carry `groupIndex`/`driver` metadata and anchors may
carry `cornerRadius`. A TS adapter (`splineToPathData` / `pathDataToSpline`) owns the
conversion:

- Handles become **absolute** control points: segment A→B encodes as CurveTo with
  `c1 = A.pos + A.outHandle`, `c2 = B.pos + B.inHandle`. Emit LineTo when both handles
  are absent. Live corners (`cornerRadius`) must be resolved to real geometry
  (`roundCornersPerAnchor`) *before* encoding — the kernel never sees the flag.
- Keep subpath identity: one kernel call per subpath, or one MoveTo-run per subpath
  within a single PathData, so `groupIndex`/`driver`/`closed` survive JS-side keyed by
  subpath order. Ops that split or merge subpaths (stroke, dash, offset) must define
  metadata inheritance explicitly (default: children inherit the source subpath's tags).
- QuadTo stays in the wire format for generality (SVG import), but Toolbox itself emits
  cubics only.
- Do the conversion in the worker, next to the boundary — it is O(n) and
  allocation-light; don't burn main-thread time on it.
- Coordinate space at the boundary is **canvas pixels**, not normalized — see §7.1.

---

## 6. Source curves — the three strategies

kurbo's `ParamCurveFit` is a *pull* interface: the fitter repeatedly asks the source curve
for position and derivative at parameter `t`, requests moment integrals over ranges, and
queries for cusps. Subdivision points are adaptive and data-dependent, so you cannot
pre-compute a fixed sample set and fit in two decoupled phases.

Toolbox's node graph will want to fit curves defined by arbitrary JS. Three strategies,
to be implemented in this order:

### 6.1 Native sources (implement first — covers ~90% of use)

Source curves that live entirely in Rust. Zero boundary crossings during fitting.

- **Path simplification** — `SimplifyBezPath` over a decoded `BezPath`
- **Offset curves** — `CubicOffset`
- **Affine-transformed paths** — apply `Affine` then simplify
- **Stroke outlines / dashing** — `kurbo::stroke`

### 6.2 Sampled-table source (implement second — the important one)

For arbitrary JS-defined curves (procedural nodes, deformers, custom parametrizations),
JS pre-samples the curve densely and passes a **table**; Rust implements `ParamCurveFit` by
cubic Hermite interpolation over that table.

```ts
interface SampledCurve {
  t:     Float64Array;  // ascending parameters, t[0]=0, t[n-1]=1
  pos:   Float64Array;  // x0,y0,x1,y1,... length 2n
  deriv: Float64Array;  // dx0,dy0,... length 2n (w.r.t. t)
  cusps?: Float64Array;  // known cusp parameters, ascending
  closed: boolean;
}
```

Because we have both position and derivative at each sample, cubic Hermite interpolation
gives `O(h⁴)` error. `moment_integrals` uses the trait's default numerical implementation
(Green's theorem over derivative samples), which the table supports directly.

**Sampling density rule.** Interpolation error must be well below fitting tolerance —
budget it at **≤10% of the fit tolerance**. Rather than a fixed `n`, sample adaptively:

> Subdivide until the tangent-angle change between successive samples is < 0.05 rad,
> with `n` clamped to `[64, 8192]`.

This mirrors kurbo's own "spicy curve" heuristic and concentrates samples in high-curvature
regions where they are actually needed. Emit a warning when the clamp is hit.

**Cusps must be supplied explicitly.** Interpolation smooths over cusps, so the fitter will
not find them on its own. Any node that can produce a cusp (offsets, deformers with sign
flips) must report the parameter values.

### 6.3 Callback source (implement last, or never)

A `js_sys::Function` invoked per sample. Simple, correct, and slow — each crossing costs
roughly 100 ns–1 µs and the fitter takes thousands of samples per segment. Ship this only
as a documented escape hatch for curves that genuinely cannot be tabulated, and mark it as
slow in the API. In practice §6.2 should make it unnecessary; **do not build it in v1**
unless a concrete node demands it.

---

## 7. TypeScript API

The facade is **async** because it dispatches to workers. Keep it stateless — no handles,
no retained WASM-side objects, no lifetime management across the boundary.

```ts
export interface PathData {
  verbs: Uint8Array;
  coords: Float64Array;
}

export type FitMode = 'adaptive' | 'optimal';
// 'adaptive' — kurbo subdivide-in-half. Fast; per-frame safe.
// 'optimal'  — our shortest-path/DP subdivision optimizer (see the status
//              header): fewest segments over a candidate grid, never worse
//              than adaptive, ~10-40x adaptive's cost — far faster than the
//              fit_to_bezpath_opt it replaced, with no panic path.

export interface SimplifyOptions {
  tolerance: number;
  mode?: FitMode;                 // default 'adaptive'
}

export interface StrokeStyle {
  width: number;
  join: 'bevel' | 'miter' | 'round';
  miterLimit?: number;            // default 4
  startCap: 'butt' | 'square' | 'round';
  endCap: 'butt' | 'square' | 'round';
  dashPattern?: number[];
  dashOffset?: number;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number; }

export interface VectorKernel {
  // Fitting / simplification
  simplify(path: PathData, opts: SimplifyOptions): Promise<PathData>;
  fitSampled(curve: SampledCurve, opts: SimplifyOptions): Promise<PathData>;

  // Construction
  offset(path: PathData, distance: number, tolerance: number): Promise<PathData>;
  stroke(path: PathData, style: StrokeStyle, tolerance: number): Promise<PathData>;
  transform(path: PathData, matrix: [number,number,number,number,number,number]): Promise<PathData>;

  // Measurement / query  (sync-capable; see note)
  area(path: PathData): Promise<number>;
  perimeter(path: PathData, accuracy: number): Promise<number>;
  bbox(path: PathData): Promise<Rect>;
  contains(path: PathData, x: number, y: number, rule: 'nonzero' | 'evenodd'): Promise<boolean>;

  // Output
  flatten(path: PathData, tolerance: number): Promise<Float64Array>;  // polyline
}
```

**v1 ships only the fitting surface:** `simplify`, `fitSampled`, plus `bbox`/`area` as
the M1 smoke tests. `offset`, `stroke`, `transform`, `flatten`, and `contains` stay
specified here so the wire format and API shape anticipate them, but they are deferred
(§12) — do not build them ahead of the optimizer node.

**Note on sync access.** Measurement ops are cheap and hit-testing wants to be synchronous.
Ship a second, main-thread WASM instance exposing a sync subset (`area`, `bbox`, `contains`,
`perimeter`) alongside the worker pool. Same module, two instantiation sites. Do not attempt
to make the expensive fitting ops sync.

### 7.1 Tolerance semantics & coordinate space — document this prominently

`tolerance` is in whatever units the coordinates handed to the kernel are in. That makes
the coordinate-space decision load-bearing, because Toolbox's native spline space is
**normalized [0,1]², Y-DOWN, and anisotropic on non-square canvases** (see the devguide's
coordinate conventions) — a normalized tolerance means different physical distances in x
and y, and offsetting a circle in normalized space yields an ellipse.

**Rule: the adapter converts to canvas pixel space before every metric kernel op, and
back after.** `x_px = x * canvasWidth`, `y_px = y * canvasHeight`. This is already the
house convention: the repeat/offset path scales to px before offsetting
(`spline-repeat.ts`), Text's RDP simplify tolerance is in px, and stroke widths resolve
through px / %-of-canvas-width units (`stroke-units.ts`). Tolerances and offset/stroke
distances are then **canvas pixels** end to end. Pure-topology and affine ops
(transform, winding, contains) may skip the round trip.

Callers working in a zoomed viewport must additionally scale tolerance by the inverse
view scale, or they will get absurdly dense paths when zoomed in and mush when zoomed
out. Provide a helper:

```ts
export const toleranceForViewport = (devicePixelTolerance: number, viewScale: number) =>
  devicePixelTolerance / viewScale;
```

Sane defaults (canvas px): `0.25` for editing/display, `0.05` for export, `1.0` for fast
preview. (For calibration: the Text node's existing RDP simplify runs at 0.4 px.)

---

## 8. Build & bundling

### 8.1 Build command

Crate lives at `rust/toolbox-vector-kernel/`:

```bash
wasm-pack build --release --target web --out-dir ../../src/wasm/pkg
cp ../../src/wasm/pkg/kernel_bg.wasm ../../public/wasm/   # binary served from public/ (§8.2)
```

Optional SIMD (Chromium and Safari 16.4+ both support it; Electron is Chromium so it is
always available there):

```bash
RUSTFLAGS="-C target-feature=+simd128" wasm-pack build --release --target web ...
```

Expect modest gains — this code is mostly scalar polynomial solving. Benchmark before
committing to it, and if you ship it for browser builds, feature-detect and keep a
non-SIMD fallback binary.

Expected artifact size: **~150–350 KB raw, ~60–130 KB gzipped.** If it comes out
dramatically larger, something is pulling in `std::fmt` machinery — check for stray
`format!`/`panic!` with formatting in the hot path.

### 8.2 Loading in Toolbox — Next.js (webpack) + Electron over HTTP

v1 of this spec assumed Vite and a `file://`-served Electron renderer. **Neither is true
of this codebase.** Toolbox is Next.js 16 on webpack (`next dev --webpack`), and the
Electron shell never loads `file://` — `electron/server.js` forks the embedded Next
standalone server via `utilityProcess.fork` and the window loads
`http://127.0.0.1:<port>` (`electron/main.js`). So the fetch-on-`file://` problem,
custom `app://` schemes, `registerSchemesAsPrivileged`, and base64 inlining are all
irrelevant here. `fetch()` of a `.wasm` asset works identically in web dev, web
production, and the packaged desktop app.

**Recommended: serve the binary from `public/`.** Put the artifact at
`public/wasm/kernel_bg.wasm` and call `init(fetch("/wasm/kernel_bg.wasm"))` — same URL
inside workers. Rationale:

- Next serves `public/` over HTTP in every environment.
- The desktop pipeline already handles it: `scripts/prepare-standalone.mjs` copies
  `public/` into `.next/standalone/`, and electron-builder's existing `asarUnpack`
  ships the standalone tree. Zero packaging changes.
- It sidesteps webpack's WASM story entirely — no `asyncWebAssembly` experiments, and
  no `?url` (a Vite idiom that does not exist under webpack).

Alternative (fine, more magic): `new URL("./pkg/kernel_bg.wasm", import.meta.url)` as a
webpack asset. Prefer `public/` for explicitness. Since `public/` assets are not
content-fingerprinted by Next, version the path (`/wasm/v1/kernel_bg.wasm`) so a
deployed update can't serve a stale cached binary against new JS glue.

The wasm-bindgen JS glue (`kernel.js`) imports and bundles normally; only the binary
goes through `public/`.

### 8.3 Workers under webpack

Instantiate workers with the statically-analyzable pattern the EXR decode pool already
uses:

```ts
const worker = new Worker(new URL("./kernel-worker.ts", import.meta.url), { type: "module" });
```

Each worker fetches and instantiates its own WASM instance lazily on first request — do
not pay N × instantiation at app boot; many projects contain no vector-kernel nodes.

### 8.4 CI

CI is GitHub Actions (`.github/workflows/ci.yml` — typecheck/lint-ratchet/checks;
`release.yml` builds the desktop app).

- Add a dedicated Rust job: `rustup target add wasm32-unknown-unknown` + `wasm-pack`;
  cache `~/.cargo` and `target/` — cold Rust builds are slow.
- **Commit the built `.wasm` artifact** (`public/wasm/`) so contributors without a Rust
  toolchain can still build and run the app. The CI job's role is to *verify* the
  committed artifact is reproducible from the committed Rust source, not to rebuild it
  on every app build.

---

## 9. Error handling & instance recovery

`panic = "abort"` means a Rust panic becomes an unrecoverable WASM trap that **permanently
poisons the instance** — every subsequent call fails. This must be designed for, not
patched later.

1. **Never panic on user input.** Every entry point validates and returns
   `Result<_, KernelError>`. Guard: array length mismatches, non-finite coords, tolerance
   `<= 0` or non-finite, empty paths, degenerate stroke widths.
2. **Represent errors as values.** Return a discriminated result; map to a typed TS
   `KernelError` with a machine-readable code.
3. **Assume traps happen anyway.** Each worker detects an unrecoverable instance (any trap,
   or `RuntimeError` from wasm-bindgen), tears it down, re-instantiates the module, and
   retries the request **once**. A second failure surfaces to the caller as
   `KernelError.code = 'INSTANCE_FAILURE'` with the input attached for repro.
4. **Dev builds** enable the `debug-panics` feature so `console_error_panic_hook` gives a
   real stack trace instead of `unreachable executed`.
5. **Log the offending input.** On any trap, serialize the input path to the log directory.
   A geometry bug you cannot reproduce is worthless.

---

## 10. Testing & validation

The entire justification for this approach is trustworthy numerics. Test accordingly.

**Harness reality:** Toolbox has no test runner wired up — verification is manual
in-browser plus the `tsx scripts/check-*.mts` scripts CI runs. TS-side kernel tests
ship as `scripts/check-kernel.mts` in that pattern (Node can load the WASM binary
directly from `public/wasm/`). Rust-side tests run in the crate under `cargo test`
(native) and `wasm-bindgen-test`.

### 10.1 Native/WASM equivalence
Run a fixed corpus through `cargo test` (native x86/ARM) and `wasm-bindgen-test`, assert
**bit-identical** output. WASM f64 is fully deterministic, so any divergence indicates a
real bug (usually an `f32` sneaking in, or platform-dependent libm usage). This is a
sharp, high-value test — treat any mismatch as a release blocker.

### 10.2 Independent verification (do not test kurbo against itself)
Implement a **discrete Fréchet distance** check in TypeScript, independent of kurbo. Densely
sample both source and result, assert `frechet(source, result) <= tolerance * 1.05`. This
catches "it ran and produced a plausible-looking path that is actually wrong" — the failure
mode that golden files miss.

The existing TS implementations (`fitSplineToPolyline`, `offsetSubpath`,
`simplifyPolyline`) also double as independent cross-checks during migration:
disagreement beyond tolerance between old and new paths is a red flag pointing in
*either* direction, and worth understanding before the TS path is retired.

### 10.3 Property tests
- **Idempotence:** simplifying an already-simple path at the same tolerance should be a
  near no-op (segment count must not grow).
- **Exact reproduction:** a path that is already a cubic Bézier, fitted at tight tolerance,
  should reproduce within ~1e-9 in few segments. Levien notes the fitter is designed so any
  exact Bézier input remains fittable — verify that guarantee holds.
- **Convergence:** segment count must scale gently with tolerance. Error scales as `O(n⁶)`,
  so tightening tolerance 15× should cost well under 2× the segments. A steep curve here
  means the "spicy" detection or the δ penalty is misconfigured.
- **Monotonicity:** tighter tolerance never yields fewer segments.

### 10.4 Regression corpus
Track segments-per-tolerance and wall time across a corpus of ~50 real paths (fonts, traced
bitmaps, offsets, exported Illustrator art). Fail CI on >10% segment-count regression. This
is what catches a kurbo upgrade silently degrading output quality.

### 10.5 Degenerate input fuzzing
Zero-length segments; coincident control points; cusps; self-intersecting loops; single
`MoveTo`; unclosed subpaths; `ClosePath` with no preceding `MoveTo`; coordinates at ±1e300;
NaN/Inf (must be rejected, not processed); tolerance of 0, negative, `Infinity`, `NaN`.

### 10.6 Known quality trap — bumps
Levien documents that aggressively minimizing Fréchet distance can produce visible "bumps":
one very long and one very short control arm, yielding high curvature variation, because
Fréchet captures distance error but not angle/curvature error. kurbo mitigates this by
penalizing large δ values (the control-arm-to-chord ratio; a threshold around 0.85 works
well). **Add a visual regression test specifically for this** — render simplified paths at
high zoom and diff against approved images. Distance metrics alone will not catch it, and
in a motion tool a bump becomes a visible pop when the path animates.

---

## 11. Performance targets

Establish baselines early; these are starting expectations, not guarantees.

| Operation | Target |
|-----------|--------|
| `simplify` adaptive, 500-segment path, tol 0.1 | < 2 ms |
| `simplify` optimal, same | < 100 ms (≈50× adaptive) |
| `stroke`, 500-segment path | < 5 ms |
| `offset`, 100-segment path | < 3 ms |
| `bbox` / `area`, 1000 segments | < 0.1 ms |
| Cold WASM instantiation | < 30 ms |

Guidance:
- The `simplify` rows are the v1-critical ones (they bound the Optimize Path node's
  interactivity); the stroke/offset rows apply at M4.
- Default to `'adaptive'`. Reserve `'optimal'` for export and explicit user-invoked
  simplification, never for interactive preview or per-frame evaluation.
- Cache aggressively on `(pathHash, tolerance, mode)`. Node graphs re-evaluate constantly
  and geometry rarely changes between frames.
- Transfer `ArrayBuffer`s to/from workers rather than cloning.
- Batch: one worker message carrying 100 paths beats 100 messages, decisively.

---

## 12. Milestones

**M1 — Skeleton (target: ~1 day)** — **DONE 2026-07-30.**
Crate builds to WASM. Wire format round-trips a path in and back out unchanged,
including the SplineValue ↔ PathData adapter (§5.4) with px-space conversion (§7.1).
`bbox`/`area` work end to end. *(In-browser + packaged-Electron load still needs a
manual pass — headless verification loads the committed artifact from bytes.)*

**M2 — Simplification (already-bezier route)** — **DONE 2026-07-30**, with two
deviations from plan: no worker pool yet (main-thread instance; adaptive fits are
sub-ms and the node's fingerprint cache absorbs re-evals), and §10.1 native/WASM
bit-equivalence is not yet automated (native `cargo test` + the TS-side §10.2
deviation checks in `scripts/check-kernel.mts` are). Optimize Path node shipped.

**M3 — Sampled-curve fitting (polyline route — completes the node)** — **OBSOLETE /
absorbed into M2.** The smooth-source input shaping (see status header) routes dense
polylines through `simplify_bezpath` with TS-estimated tangents; `fitSampled` and the
sampled-table source are not needed unless a future node demands true procedural-curve
fitting (moment-exact, cusp-reporting).

**M4 — Construction ops (deferred — only after the node is proven in real use)**
`offset`, `stroke`, dashing, `transform`, `flatten`.
*Exit: stroke outlines match a reference renderer within tolerance.*

**M5 — Hardening**
Full measurement API, sync main-thread instance, instance recovery, regression corpus,
bump visual tests, performance baselines recorded. (M5 hardening of the fitting surface
need not wait for M4.)

---

## 13. kurbo surface inventory

Available and worth exposing eventually:

| Capability | kurbo API |
|-----------|-----------|
| Path simplification | `simplify::simplify_bezpath` |
| Generic curve fitting | `fit::fit_to_bezpath`, `fit_to_bezpath_opt` |
| Offset curves | `offset::CubicOffset` |
| Stroke expansion | `stroke::stroke` |
| Dashing | `stroke::dash` |
| Flattening | `flatten` |
| Area / perimeter / winding | `Shape` trait |
| Bounding box | `Shape::bounding_box` |
| Hit testing | `Shape::contains` |
| Affine transforms | `Affine` |
| Primitives → path | `Circle`, `Ellipse`, `RoundedRect`, `Arc` |
| Line/curve intersection | `CubicBez::intersect_line` |
| Curve subdivision | `ParamCurve::subsegment`, `subdivide` |

---

## 14. Gaps and risks

**Boolean operations — a gap in kurbo, but not a gap in the product.** kurbo does not
implement union / intersection / difference — but Toolbox already ships
flatten→boolean→refit in TS: `src/engine/spline-boolean.ts` flattens subpaths to
integer rings (SCALE 8192), runs [polygon-clipping], and refits the rings back to
anchors. It powers the Spline Boolean node, clip-by-region, and the Shape Builder
tool's planar faces (`spline-planar.ts`). So the question is not "how do we get
booleans" but "when and how do we upgrade them". Options, in rough order of preference:

1. **Keep polygon-clipping, route its refit leg through the kernel.** The fitter is the
   weak link today (ring refit over dense polylines); this upgrade is nearly free once
   `fitSampled` exists (M4), and flatten-at-tight-tolerance → boolean → refit is
   exactly the round trip the kernel makes viable.
2. Wrap a Rust boolean crate in the same WASM module. Evaluate current options before
   committing; this space moves and none of the candidates are as mature as kurbo.
3. Bind Clipper2 (C++) via a separate WASM module — battle-tested, but polygon-based
   like what we have; the win over option 1 is robustness at degenerate inputs, not
   curve-exactness.

Exact curve-curve booleans remain out of reach on every option, and nothing currently
in the product promises them. Given §1's priorities there is no decision deadline —
booleans are explicitly not why we're building this. Revisit at M4, and note that
option 1 (kernel-refit of polygon-clipping output) falls out of M3's `fitSampled`
almost for free if the appetite is there.

**Other risks:**

- *kurbo API churn.* Mitigated by exact pinning; budget time on upgrades and rely on the
  §10.4 regression corpus.
- *Bumps in production output.* Highest-likelihood quality complaint. §10.6 must ship in M2,
  not be deferred.
- *Tolerance confusion.* Will generate bug reports that are actually caller errors. Mitigate
  with the viewport helper and prominent docs.
- *Rust toolchain friction.* Mitigated by committing the built artifact (§8.4).

---

## 15. Licensing

kurbo is dual-licensed **Apache-2.0 OR MIT** — unencumbered for commercial use. Include the
license text in Toolbox's third-party attributions. `cargo-about` can generate the
attribution file as a CI step; wire it up in M5. bezier-js and polygon-clipping (both
MIT) stay in the attribution list for as long as any callsite still uses them.

---

## Appendix A — References

- Levien, *Simplifying Bézier paths* (2023) — the general path-simplification method,
  `ParamCurveFit`, error metrics, the bump problem
- Levien, *Fitting cubic Bézier curves* (2021) — the quartic-based core solver
- Levien, *Parallel curves of cubic Béziers* (2022) — offset curves
- Levien, *From Spiral to Spline* (PhD thesis, UC Berkeley 2009) — §9.2 on the limits of
  distance-only error metrics; §9.6.4 on optimal subdivision point search
- Levien et al., *GPU-friendly Stroke Expansion* (HPG 2024) — basis for `kurbo::stroke`
- Penner, *Fitting a Cubic Bézier to a Parametric Function* — prior art the solver builds on
- Linebender Zulip — active discussion; the maintainers explicitly invite collaboration on
  curve fitting

## Appendix B — Open questions for Henry

1. Do any node types need **exact** curve-curve booleans, or is flatten→boolean→refit
   acceptable? Determines §14. *Partially answered by the codebase:* every shipping
   boolean is already flatten→boolean→refit (spline-boolean.ts) and nothing promises
   exactness — the open part is only whether a future node will need better.
2. Is bit-identical output across machines a hard requirement (distributed rendering, shared
   frame cache) or merely desirable? If hard, add a cross-platform determinism test to CI.
   *Still open.*
3. What is the largest realistic path size — 1k segments, or 100k (traced bitmaps)? Changes
   whether §11 targets are comfortable or tight. *Still open — the likely worst cases
   in-tree are Text's marching-squares spline output and pasted traced SVG art.*
4. ~~Should the kernel own SVG path string parsing/serialization?~~ **Answered: no.**
   Toolbox already owns SVG I/O in TS — `src/lib/svg-parse.ts` (file import + Figma
   paste) and `src/engine/svg-serialize.ts` (export). The kernel stays PathData-only.
