# SDF Node Family — Proposal

A working spec for adding a Signed Distance Function (SDF) node family,
based on a competitor's graph (screenshot in chat).

---

## What the competitor is doing

The competitor screenshot shows a node graph using SDF as a first-class
socket type. The graph builds an animated tile-able orientation field:

- **Shape primitives** (`SDF Circle`, `SDF Rectangle`) — take a `Position`
  in, emit an `SDF` (a scalar distance field).
- **Domain operators** (`SDF Translate`, `SDF Scale`, `SDF Rotate`,
  `SDF Repeat`) — take a `Position` in, emit a transformed `Position`.
  These wrap the input space before the shape evaluates, so e.g.
  `Repeat` tiles the entire downstream graph.
- **Combiners** (`SDF Smooth Union`) — take two `SDF`s, emit one. The
  smoothness parameter blends the two boundaries.
- **Output** (`SDF Rasterize SDF`) — sample the SDF at each output UV
  and produce an image (foreground / background / contour).
- **Modulation** — `Simplex Noise` reads a `Position` (built by Combine
  Vec2) and feeds a `Remap` chain that ultimately drives the angle of
  the orientation lines.

The graph is essentially a small fragment shader expressed as nodes.
Every wire is per-pixel.

---

## Why SDFs

- **Perfect anti-aliasing for free.** Distance is a continuous quantity;
  rasterizing with a smoothstep at the zero-crossing gives sub-pixel-
  accurate edges at any resolution.
- **Resolution-independent.** No texture allocation up front — the
  shape's "pixels" exist only at output time.
- **Boolean composition is trivial.** `min(a, b)` = union,
  `max(a, b)` = intersection, `max(a, -b)` = subtraction. Smooth
  variants are one-liners.
- **Domain ops are cheap and powerful.** `Repeat`, `Mirror`, `Polar`
  fold the entire downstream graph through a coordinate transform.
- **Composes with everything.** An SDF can be turned into a mask,
  a stroke, a glow, a height-field for displacement — the distance
  value itself is useful far beyond just "where is the boundary".

We already have rasterized shapes (Circle, Rectangle, Spline Draw with
fill/stroke) but they're frame-buffer values, not fields. Booleans
between two shape images need a third Merge node + careful blending.
SDFs make this composition the core operation.

---

## Engine prerequisites

### New socket type

```ts
// engine/types.ts
export type SocketType = ... | "sdf" | "position";
```

- **`sdf`** — a 2D signed distance field. Negative inside, positive
  outside, gradient = 1 (or close to it).
- **`position`** — a per-pixel vec2 in [0,1]² Y-DOWN. Distinct from
  `vec2` (which is a single value) and `uv` (which is a half-float
  RGBA texture). Default position = the canvas UV.

### Value representation

Two paths, pick one:

#### Option A — opaque GLSL builder (recommended)

```ts
export type SdfValue = {
  kind: "sdf";
  // Returns a GLSL snippet that evaluates the SDF given an in-scope
  // `vec2 p` variable, and yields a `float` distance. The snippet may
  // declare local helpers prefixed with `id` to avoid collisions when
  // composed.
  emit(id: string): { decls: string; expr: string };
};

export type PositionValue = {
  kind: "position";
  // Same idea — given an in-scope `vec2 p`, return a `vec2` expression
  // for the transformed position.
  emit(id: string): { decls: string; expr: string };
};
```

Each node builds its snippet from upstream snippets by string concat.
`Rasterize SDF` walks the whole tree, assembles a final fragment shader,
and compiles via `ctx.getShader`.

**Pros:** runs at full GPU speed, integrates cleanly with the existing
WebGL2 backend.
**Cons:** the value isn't really evaluable on the CPU — debugging via
console is harder.

#### Option B — CPU function

```ts
export type SdfValue = {
  kind: "sdf";
  sample: (x: number, y: number) => number;
};
```

Easy to debug, slow to rasterize (every pixel evaluates JS). Could be
upgraded to GPU later. Reasonable for a v1 if implementation effort
matters more than render speed.

**Recommendation: Option A.** SDFs are the kind of thing where
performance matters from day one — the user is going to plug a
1080p Rasterize on the end and expect it to run at 60fps.

### Position threading

Each `SDF Shape` node has an optional `position` input. When wired,
the shape evaluates in the wrapped space; when unwired, it reads the
default `vec2 p` (= canvas UV). Domain operators (`Translate`,
`Repeat`, ...) take a `position` in and emit a `position` out, so a
chain of operators stacks cleanly.

This is the same pattern Math (UV mode) already uses, just with a
dedicated socket type so the graph reads more clearly.

---

## Proposed nodes

### Shape primitives (output: SDF)

| Node | Params | Notes |
|---|---|---|
| **SDF Circle** | radius, center | Most basic. `length(p - center) - r`. |
| **SDF Rectangle** | size (vec2), center, corner radius | Rounded rect via `length(max(0, q)) + min(max(q.x,q.y), 0) - r`. |
| **SDF Line Segment** | a, b, thickness | Capsule through two points. |
| **SDF Polygon (regular)** | sides, radius, center | N-gon, useful for triangle/pentagon/hexagon. |
| **SDF Star** | points, inner radius, outer radius | 5-point star, etc. |
| **SDF Triangle** | a, b, c | Three-point general triangle. |
| **SDF Capsule** | a, b, radius | Like Line Segment but with explicit radius. |
| **SDF Custom Spline** | spline input | Convert a Spline value to an SDF (closed paths only). |

The first four cover ~90% of typical use. Star / Heart / Cross are
nice-to-haves once the system works.

### Domain operators (input: Position, output: Position)

These wrap the coordinate system. Stack them upstream of a shape to
transform without modifying the shape itself.

| Node | Params | Notes |
|---|---|---|
| **SDF Translate** | offset (vec2) | `p - offset`. |
| **SDF Scale** | scale (scalar or vec2) | `p / scale`. The shape's distance must be multiplied back by scale to remain a true SDF; the node handles this. |
| **SDF Rotate** | angle | 2D rotation matrix. |
| **SDF Repeat** | spacing (vec2), bounds (vec2) | Tile the domain. Bounds optional — without them the tiling is infinite. |
| **SDF Mirror** | axis (enum: x / y / both) | Reflect about the chosen axis. `p.x = abs(p.x)` etc. |
| **SDF Polar** | center | Rect → polar mapping (like `polar-coords` image node). Combined with Repeat this gives N-fold symmetry. |
| **SDF Twist** | strength | `p` rotated by an amount proportional to `length(p)`. |
| **SDF Bend** | strength | Shears the coordinate frame as a function of one axis. |

`Repeat`, `Mirror`, `Polar` are the highest-value because they fold
the entire downstream graph and cost ~nothing.

### Combiners (inputs: 2× SDF, output: SDF)

| Node | Params | Notes |
|---|---|---|
| **SDF Union** | – | `min(a, b)`. |
| **SDF Intersection** | – | `max(a, b)`. |
| **SDF Subtraction** | – | `max(a, -b)`. |
| **SDF Smooth Union** | smoothness | Polynomial smin (Quílez). |
| **SDF Smooth Intersection** | smoothness | – |
| **SDF Smooth Subtraction** | smoothness | – |
| **SDF XOR** | – | `max(min(a, b), -max(a, b))`. Symmetric difference. |
| **SDF Blend** | t | Linear lerp between two SDFs by `t`. |

Smooth Union is the headline node — it's the one that gives "blob"
looks and metaball composition.

### Modifiers (input: SDF, output: SDF)

| Node | Params | Notes |
|---|---|---|
| **SDF Round** | radius | `d - radius`. Inflates the boundary outward by radius (turns sharp into rounded). |
| **SDF Onion** | thickness | `abs(d) - thickness`. Hollow shell. |
| **SDF Annular** | radius | Concentric ring at a given distance. |
| **SDF Displace** | scalar field, amount | Adds a scalar field to the distance — useful for noise distortion of edges. |

### Output

| Node | Inputs / Params | Notes |
|---|---|---|
| **SDF Rasterize** | sdf, foreground (color), background (color), contour (color, width), softness | Image. The headline output. Softness controls the edge anti-aliasing window — set to ~1 pixel by default. |
| **SDF to Distance Image** | sdf, range | Grayscale image of the raw distance, normalized to [0,1] over a configurable range. Useful for displacement-driving and debugging. |
| **SDF to Mask** | sdf, threshold | Binary mask at the chosen iso-line. Feeds anything that wants a mask (Filter Points mask mode, Reaction-Diffusion seed, etc.). |
| **SDF to Spline** | sdf, iso-level, resolution | Marching squares to extract an iso-line as a spline. The expensive but extremely powerful "extract the boundary as geometry" node — turns the field back into a vector path. v2 stretch goal. |

---

## Phasing

### Phase 1 — minimal viable SDF (the smallest set that's actually fun)

Eight nodes, end-to-end:

1. SDF Circle
2. SDF Rectangle
3. SDF Translate
4. SDF Scale
5. SDF Rotate
6. SDF Union
7. SDF Smooth Union
8. SDF Rasterize

This is enough to recreate the kind of graph in the screenshot. The
first ship validates the value-type and shader-compile path.

### Phase 2 — fill out shapes & combiners ✅

Line Segment (covers Capsule), Polygon, Triangle, Star, Smooth
Intersection, Smooth Subtraction. (Intersection / Subtraction / Round
shipped in Phase 1.)

### Phase 3 — domain ops & distortion ✅

Repeat (bounded + unbounded), Mirror, Polar, Twist, Onion, Displace
(samples an image's red channel via a `sampler2D` uniform allocated
into the compiled shader). These are where the "infinite" feeling of
the SDF graph kicks in.

### Phase 4 — outputs & geometry bridges ✅

SDF to Mask, SDF to Distance Image, SDF to Spline. These let SDFs
feed the rest of the engine (point scatter, splines, displacement
maps, etc.).

`compileSdf` now takes an output mode (`rasterize` / `distance` /
`mask` / `raw`) — same emit/uniform machinery, different `main()`
body. Cache key is prefixed with the mode so the four use cases get
separate compiled programs even for the same SDF tree.

`SDF to Spline` runs marching squares ([engine/marching-squares.ts](../src/engine/marching-squares.ts))
on a CPU readback of the raw distance render. Default 256×256 grid;
saddle ambiguity resolves via the disconnected interpretation.

### Phase 5 — Position-as-socket migration ✅

The wrapper-style architecture (Repeat / Mirror / Polar / Twist /
Transform-SDF wrapping the SDF tree) was swapped for an explicit
**position pipeline**. New socket type `position` carries a
`PositionNode` AST that compiles to a `vec2` GLSL expression. Each
shape primitive grew a `position` input (default canvas UV when
unwired); domain operators are now position-pipeline nodes.

Two parallel emitters in the compiler:

- `emitPosition(node) → vec2 expression` — Translate, Scale, Rotate,
  Repeat, Mirror, Polar, Twist
- `emitSdf(node) → float expression` — primitives call `emitPosition`
  on their own `position` field; combiners and modifiers compose
  float sub-expressions only

What this unlocks:

- **Reusable position chains.** Build `Translate → Repeat → Rotate`
  once, branch the resulting Position into 5 different shapes — the
  folded position is computed once per pixel and reused.
- **Tile-local rotation.** `Position Repeat → Position Rotate →
  Shape` rotates each tile around its own center by the same angle.
  In the wrapper architecture this required no node order existed
  that could express it.
- **Future hooks for derived data.** A future Repeat can expose
  `cell_id` (vec2) on an aux output, enabling per-tile noise lookups
  and instanced color/rotation jitter.

Migration was breaking — old saved graphs that reference
`sdf-repeat` / `sdf-mirror` / `sdf-polar` / `sdf-twist` or
Transform's `sdf` mode no longer load those nodes. The deleted
files: [sdf/repeat.ts, sdf/mirror.ts, sdf/polar.ts, sdf/twist.ts].
Transform's `sdf` mode removed from
[transform.ts](../src/nodes/effect/transform.ts).

### Phase 6 — Scalar fields & per-tile noise ✅

**The headline pattern this unlocks:** per-tile / per-instance / per-
pixel modulation. Wire `SDF Repeat.cell_id` → `SDF Noise.position` →
`SDF Rotate.angle_field`, and every tile spins to its own beat
(noise is sampled at the integer cell ID, which is constant within a
tile and varies between tiles).

The reason this didn't work before: a CPU scalar uniform can only
carry one value per draw. Wiring `Noise.value` (CPU-sampled at one
position) into `SDF Rotate.angle` gave every tile the same uniform.
For per-pixel variation, the variation source has to be inlined into
the compiled shader — that's exactly what `scalar_field` is.

New socket type **`scalar_field`** — carries a `ScalarFieldNode` AST
that compiles to a `float` GLSL expression evaluated per pixel. Two
node kinds for v1: `constant` (wraps a CPU scalar) and `noise`
(simplex+fbm with a position input).

New PositionNode kind **`cellId`** — emits `floor((p - center) /
spacing)`, the integer cell index. Constant within a tile, varies
between tiles. Exposed as `cell_id` aux output on `SDF Repeat`.

Polymorphic scalar inputs on position ops:
- `SDF Rotate.angle_field` — per-pixel/per-tile rotation
- `SDF Twist.strength_field` — per-pixel/per-tile twist amount
- (Translate / Scale could follow the same pattern; deferred until
  needed.)

No new noise node — the existing [Noise](../src/nodes/source/perlin-noise.ts)
node grows a third output. The field output uses simplex regardless
of the `type` param (image / value paths still respect type); porting
the rest of the noise family into the SDF compiler is a follow-up.

Augmented Noise outputs:
- `image` (primary) — rasterized canvas-wide, all noise types
- `value` (aux, scalar) — CPU sample at `position` (vec2)
- `field` (aux, scalar_field) — per-pixel shader expression sampled
  at `field_position` (PositionValue, defaults to canvas UV)

New params on Noise: `field_lo`, `field_hi` — linear remap on the
field output so users can express "rotate by ±π" in one node.

Compiler additions ([sdf-compile.ts](../src/engine/sdf-compile.ts)):
- `emitScalarField(node) → float expression`
- Simplex + fbm GLSL helpers (ported byte-for-byte from
  [perlin-noise.ts](../src/nodes/source/perlin-noise.ts) so noise
  matches between SDF Noise and the Noise image source)
- `cellId` PositionNode emit
- `rotate` and `twist` emit are now polymorphic — number → uniform,
  ScalarFieldNode → inlined field expression
- `structuralHash` recurses through the field's position chain so
  `Rotate(Repeat) {field=Noise(Repeat.cellId)}` and
  `Rotate(Repeat) {field=Noise(canvasUv)}` get distinct compiled
  shaders

---

7 position-pipeline nodes (named under the SDF family brand even
though they output `position`, not `sdf` — keeps muscle-memory
parity with competitor naming):
- [SDF Translate](../src/nodes/sdf/sdf-translate.ts)
- [SDF Scale](../src/nodes/sdf/sdf-scale.ts)
- [SDF Rotate](../src/nodes/sdf/sdf-rotate.ts)
- [SDF Repeat](../src/nodes/sdf/sdf-repeat.ts) — also exposes
  per-cell jitter (rotation / position / scale) as the
  shader-only path to per-tile variation. Wiring an upstream Noise
  scalar into a downstream `SDF Rotate.angle` cannot give per-tile
  variation: `Noise.value` is one CPU-evaluated scalar per frame, so
  every tile receives the same uniform. Repeat's jitter hashes the
  cell ID inside the GLSL fold instead, giving real per-tile pseudo-
  random variation. (For arbitrary signals to drive per-tile values,
  Noise would need to become a position-aware shader value — Phase 6
  conversation.)
- [SDF Mirror](../src/nodes/sdf/sdf-mirror.ts)
- [SDF Polar](../src/nodes/sdf/sdf-polar.ts)
- [SDF Twist](../src/nodes/sdf/sdf-twist.ts)

---

## On randomization — what they're doing differently

The competitor's screenshot has no `Random` node. Where we'd reach for
one, they reach for **Simplex Noise sampled at a position**, animated
by feeding `time` into the position itself (`Combine Vec2(x, time)` or
`pos + vec2(0, time)`). The "randomness" in the orientation field
isn't `Math.random()` — it's smooth procedural noise sampled at each
point in space.

This is more useful for visual work because:

1. **Spatial coherence.** Adjacent pixels get adjacent noise values, so
   the result is smooth instead of TV-static. Adjacent points in a
   scatter get similar offsets, so jitter looks organic instead of
   chaotic.
2. **Animatable through composition.** Animate the noise by animating
   its position input. `pos.y += time * 0.1` flows the noise field
   downward; no new "speed" param needed.
3. **Reproducible without seeds.** Same position → same value, always.
   Seed is just an offset.
4. **Composable with the rest of the math chain.** The position can be
   warped by other nodes before feeding the noise — domain operators
   on noise input give "warped noise" for free.

**What we have today:**

- `Random` (just added) — per-frame scalar/vec2, no spatial component.
  Right tool for "pick a value once per frame" but wrong tool for
  field generation.
- `Perlin Noise` (source) — outputs a full *image*. Spatial, but
  rasterized; you have to sample the image at a position rather than
  evaluate the noise as a value.

**Recommended additions** (worth a separate spec, but flagging here):

- **Noise Value** — sample 2D Simplex/Perlin/Voronoi at a `vec2`
  position, output a scalar. The position-aware sibling of the existing
  Perlin Noise image source. Plays the same role as the competitor's
  `Simplex Noise` node.
- **Curl Noise Value** — like above but outputs vec2 (a divergence-free
  flow field). Makes orientation fields, particle advection, and "smoke
  drift" looks trivial.

The current `Random` node stays — it's the right primitive for
event-driven randomness (one number per frame). The new noise-value
nodes cover the "field of randomness" use case that `Random` was never
meant to fill.

This unlock is bigger than the SDF family: noise-as-value composes
with `points`, `splines`, the existing UV-mode Math chain, and the
proposed SDF graph. **Recommend prioritizing Noise Value before
or alongside Phase 1 of the SDF work.**

---

## Open questions

- **`position` socket vs reusing `uv`?** The existing `uv` socket is a
  RGBA16F texture — too heavy for what the SDF graph needs (a per-pixel
  vec2 expression that lives only inside the compiled shader). A
  separate `position` socket type that is *purely a shader-graph
  abstraction* (never materialized to a texture) keeps the cost zero.
  Downside: another socket type to maintain.
- **Cross-evaluator:** can SDF nodes feed the existing `image` graph
  directly via an implicit Rasterize, or do users always have to drop a
  Rasterize? Implicit conversion is friendlier; explicit is clearer.
  Lean implicit (auto-rasterize on connect to `image`) once the family
  is stable.
- **CPU evaluation path** for `SDF to Spline` (marching squares needs
  CPU samples). Either readback from the rasterized distance image or
  a parallel CPU-evaluable AST. Defer to Phase 4.
- **Caching:** SDF values are pure functions of params; the engine's
  param-fingerprint cache should already cover them. No new
  invalidation work needed.
