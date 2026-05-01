# Essentials — Missing Primitive Nodes

A working todo list of primitive node types that fill gaps in the current
graph. Ordered roughly by payoff: constants/control come first because
they unblock everything else; image and geometry primitives follow.

Check items off as they ship.

## Top 8 (do these first)

- [x] Constant (scalar)
- [x] LFO / Oscillator
- [x] Smooth / Damp
- [x] Switch / Select
- [x] Sample Texture at Points
- [x] Filter Points
- [x] Lerp / Mix
- [x] Polar Coords (rect ↔ polar)

---

## Constants & control values

- [x] **Constant / Number** — bare scalar literal source (slider exposes one scalar). Avoids routing single numbers through Math nodes.
- [x] **Vec2 literal** — vector constant without combine-vec2.
- [x] **Vec3 literal**
- [x] **Color literal** — outputs a color/`vec4` value (not an `image`). Solid-color rasterizes, downstream color-math nodes want the value.
- [x] **Random** — per-frame or seeded scalar/vec2 generator (uniform, gauss).
- [x] **Switch / Select** — N-input mux picking by index. Essential for branching / preset behavior.
- [x] **Compare** — `>`, `<`, `==`, `!=`, `>=`, `<=` → bool/scalar.
- [x] **Logic** — `and`, `or`, `not`, `xor` over bool/scalar gates.
- [x] **Clamp** — standalone primitive. (Min / Max are already covered by `math.ts`.)

## Time / animation primitives

- [ ] **LFO / Oscillator** — sin / saw / square / triangle, with frequency, phase, amplitude, offset.
- [ ] **Pulse / Trigger** — emit `1` for one frame at interval, or on threshold-crossing of an input.
- [ ] **Smooth / Damp** — exponential smoothing filter. Turns jittery input (hand/object trackers, audio) into nice motion.
- [ ] **Hold / Sample-and-Hold** — latch a value when triggered.
- [ ] **Counter** — per-frame increment with reset trigger.
- [ ] **Envelope** — attack / decay (or ADSR) driven by a trigger input.

## Image primitives

- [ ] **Invert**
- [ ] **Pixelate / Mosaic**
- [ ] **Posterize**
- [ ] **Vignette**
- [ ] **Chromatic Aberration / RGB Split**
- [ ] **Polar Coords** (rect ↔ polar) — unlocks kaleidoscope / tunnel looks.
- [ ] **Tile / Mirror**
- [ ] **Kaleidoscope**
- [ ] **Warp** — twirl / pinch / bulge.
- [ ] **Levels / Curves** — finer than color-correction.
- [ ] **Channel Swap / Mix**
- [ ] **LUT / Lookup**
- [ ] **Crop / Pad**
- [ ] **Resize**
- [ ] **Flip H/V**
- [ ] **Directional / Motion Blur** — Gaussian blur is symmetric only.

## Geometry — points / splines

- [ ] **Sample Texture at Points** — read color or scalar from an image at each point's position. Huge unlock: drives anything visual from anything image-based.
- [ ] **Filter Points** — keep/discard by predicate, mask, or bounding box.
- [ ] **Sort Points** — by attribute (distance, angle, scalar attr).
- [ ] **Bounding Box** — output min/max/center/size of a points or splines set.
- [ ] **Centroid**
- [ ] **Distribute on Shape** — grid, ring/circle, spiral, line. Currently Scatter is random-only.
- [ ] **Points → Spline** — chain through ordered points (named primitive, even if Connect-Points covers parts).
- [ ] **Spline → Points** — uniform sample (named primitive, even if Resample covers parts).
- [ ] **Convex Hull**
- [ ] **Delaunay** — graph-output, not texture.
- [ ] **Voronoi Cells (geometric)** — graph-output, not texture.
- [ ] **Smooth Path** — Chaikin.
- [ ] **Simplify Path** — Douglas-Peucker.
- [ ] **Subdivide Spline**
- [ ] **Spline Boolean** — union / diff / intersect.
- [ ] **Lerp / Mix** — interpolate between two points sets, splines, scalars, or vectors by `t`.

## Live inputs

- [ ] **MIDI** — knob / note → scalar / trigger.
- [ ] **Keyboard / Key Trigger**
- [ ] **OSC** — for external control surfaces.

---

## Notes

- Some of these may already be partially covered by existing nodes; the goal is named, discoverable primitives so users don't have to know to compose them.
- The **value-vs-texture color** distinction (Color literal vs Solid Color) matters as more nodes start consuming `vec4` color values directly without a rasterization step.
- Polar Coords + Tile/Mirror together open up an entire family of looks that currently require external compositing.
