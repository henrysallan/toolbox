# 3D primitives wave — filling out the shape vocabulary

Owner ask (2026-08-17 brainstorm → this spec): expand the 3D primitive
set beyond the six starters (Cube, Sphere, Plane, Cylinder, Cone, Torus)
and the three curve primitives (Rect, Circle, Polygon). Everything here
emits `geometry` (curve nodes: tube + `curve3d` aux, the M11 family
triple) and slots into the existing chains — Material/Bump/lineart,
Bevel, Scatter/Copy, Points on Path. **No new socket types anywhere in
this spec**, so no invariant-#7 ripple; the work is almost entirely rows
in the two existing factories plus a handful of small custom builders.

Base facts (verified 2026-08-19): mesh primitives ride
`makePrimitiveNode` (src/nodes/three/primitives.ts, 206 lines) — a new
one costs `sizeParams` + `buildGeometry` + `geomSig` + a registry line.
Curve primitives ride the factory in curve-primitives.ts. Retained
BufferGeometry in ctx.state, rebuild-on-sig-change, never mutate (081026
§1.2). Toon ramp + lineart (081026 M13) make flat-shaded/low-poly
looks first-class — several picks here are chosen to feed that.

---

## Decisions (proposed defaults — flag before M1 if any feel wrong)

1. **Platonic solids are ONE node** (`polyhedron-3d`, shape enum:
   icosahedron / octahedron / tetrahedron / dodecahedron + `detail`).
   Four nodes would be four search results that differ by one constructor
   call. Detail ≥ 2 on icosahedron doubles as the **icosphere** (evenly
   distributed vertices — the right sphere for scatter and displacement).
2. **Rounded Cube is a separate node**, not a radius param on Cube:
   RoundedBoxGeometry has different topology/segments, and Cube's
   geometry staying byte-identical protects saved projects.
3. **Spring/helix lives in the CURVE factory** as Spiral (a `height`
   param turns the flat spiral into a helix) — tube styling comes free
   from the family's Curve Tube path, and Points on Path gets helical
   streams for nothing. No separate mesh-spring node.
4. **Prism is a param, not a node**: Cylinder gains `sides` (default 48;
   6 = hex prism, 3 = triangle) — with the new flat-shade toggle that IS
   the prism. Same trick gives Cone → pyramid.
5. **Flat shade is a shared factory param** (`flat_shade`, default off):
   applied in the factory's build path (`toNonIndexed()` + recomputed
   normals, folded into geomSig) so every mesh primitive gets the
   low-poly look in one change.
6. **Sweep/slice params are additive with full-sweep defaults** (sphere
   phi/theta, cylinder/cone arc, torus arc — all native three
   constructor args). Saved projects see identical geometry.
7. **Heightfield samples its image on the CPU** via the identity-cached
   readback pattern (Instance Color/Instance Transform precedent),
   capped at 256px — geometry vertices are the resolution ceiling
   anyway. Texture-projection already set the precedent of a geometry
   node with an image input.

---

## Node list

### M1 — free wins (three ships the geometry; factory rows)

| Node | Params | Notes |
| --- | --- | --- |
| **Capsule** (`capsule-3d`) | radius, length | CapsuleGeometry. The motion-design pill. |
| **Rounded Cube** (`rounded-cube-3d`) | width/height/depth, corner radius, smoothness | RoundedBoxGeometry (examples/jsm). |
| **Torus Knot** (`torus-knot-3d`) | radius, tube, p, q | p/q integer winding — the abstract hero object. |
| **Polyhedron** (`polyhedron-3d`) | shape enum, radius, detail 0–4 | Detail 0 = low-poly gems; icosahedron detail 2+ = icosphere. |
| **Ring** (`ring-3d`) | outer radius, inner radius (0 = disc), thetaLength | RingGeometry; DoubleSide via existing material path? → see open Q3. |

Plus the shared upgrades in the same pass (they touch the same file):

- `flat_shade` toggle on ALL mesh primitives (factory-level, decision 5).
- Sweep params: Sphere `sweep_h`/`sweep_v` (pac-man, domes), Cylinder +
  Cone `arc` (cheese wedge) + `sides` + `open_ended`, Torus `arc`
  (macaroni). Defaults = today's full shapes.

### M2 — scene builders (small custom geometry, outsized payoff)

- **Backdrop** (`backdrop-3d`) — the studio cyc: floor running into a
  filleted back wall. Params: width, floor depth, wall height, fillet
  radius, segments. Build: 2D profile polyline (line → quarter arc →
  line) swept across width as a grid strip; analytic normals. ~40 lines.
  Every product-render scene wants this on day one.
- **Heightfield** (`heightfield-3d`) — subdivided plane displaced by a
  wired image's luminance. Inputs: `image`. Params: width, depth,
  subdivisions (8–256, default 96), amplitude, offset (re-zero),
  `smooth_normals`. Rebuild keyed on (params sig + image texture
  identity — WeakMap id counter, the `chanSig` trick); bilinear luminance
  sample per vertex; `computeVertexNormals` after. THE 2D→3D bridge:
  perlin → terrain, animated noise → ocean, Cursor → touch-reactive
  relief, ramps → contoured hills. Bench note: 96² ≈ 18k verts per
  rebuild — fine per image change; per-frame animated sources should get
  a bench row before shipping.
- **Rock** (`rock-3d`) — icosphere + seeded FBM3 displacement along
  normals (engine/noise.ts `fbm3At`, already there). Params: radius,
  detail 1–4, seed, amount, scale, octaves. Covers organic scatter until
  a general Displace modifier exists (081026 §8 backlog — Rock does not
  replace it, it just makes rocks cheap).

### M3 — graphic objects (custom builders, explainer/diorama vocabulary)

- **Arrow 3D** (`arrow-3d`) — cylinder shaft + cone head merged
  (mergeGeometries, the import-3d util). Params: length, shaft radius,
  head length, head radius. Natural Copy-to-Points payload.
- **Star 3D** (`star-3d`) — ExtrudeGeometry from a star Shape. Params:
  points, outer/inner radius, depth, bevel on/size/segments (three's
  extrude bevel — NOT our Bevel node, which still works downstream).
- **Gem** (`gem-3d`) — brilliant-cut lathe: sides (8), table width,
  crown height, girdle, pavilion depth. Flat normals baked (facets are
  the point). Transmission material = jewel; toon = game pickup.
- **Wedge** (`wedge-3d`) — triangular ramp prism: width, height, depth.
- **Stairs** (`stairs-3d`) — steps, total width/height/depth. Loops.
- **Lattice Cube** (`lattice-cube-3d`) — the cube's 12 edges as
  square-section beams: size, thickness. Real geometry (catches light,
  bevels, outlines) — instancing can't fake shared corners.

### M4 — curve factory wave (each ~20–40 lines in curve-primitives.ts)

- **Spiral** — turns, start/end radius, `height` (0 = flat Archimedean,
  >0 = helix/spring; decision 3).
- **Star** / **Arc** / **Line** — the 081026 §8 seeds.
- **Lissajous** — freq a/b/c, phase, size. Keyframe the phase.
- **Scribble** — seeded 3D random walk, smoothed: points, jitter, seed,
  extent. Tube = hand-drawn squiggle; Points on Path = organic trails.
- Rect curve gains `corner_radius` (rounded-rect, param upgrade).

### M5 — surfaces + text (each needs its own mini-Q&A before build)

- **Surface Expression** (`surface-expression-3d`) — z = f(x, y) on a
  subdivided grid, reusing the Point Expression parser. Open: variable
  set (x, y, t? wired scalars?), safety/perf of per-vertex eval at 96².
- **Math Surface** (`math-surface-3d`) — ParametricGeometry presets
  (möbius, klein, wave sheet). Cheap, but decide the preset list once.
- **Text 3D** — extruded glyphs + bevel. The big open question is the
  font pipeline: three's FontLoader wants typeface JSON; the app's font
  infrastructure is TTF/OTF-oriented. Options: (a) bundle a small
  typeface set, (b) opentype→THREE.Shape conversion reusing the app's
  font files (right answer long-term, more work). Own Q&A; not costed
  here.

---

## Testing

Per TESTING.md gates each milestone, plus an offline smoke per wave
(`npx tsx` from repo root, three via absolute node_modules path):

- M1: vertex/index sanity per new node; signed-volume watertightness for
  Capsule/Rounded Cube/Torus Knot/Polyhedra; sweep params change volume
  monotonically; flat_shade ⇒ non-indexed + per-face normals; `sides: 6`
  cylinder ⇒ 6 side quads; defaults byte-identical for existing nodes
  (geomSig unchanged when new params sit at defaults).
- M2: Backdrop profile continuity (fillet tangency); Heightfield —
  fake-readback gradient image ⇒ monotonic height ramp, identity-cached
  readback (one read per image identity), rebuild on image change;
  Rock — same seed ⇒ same geometry, volume within sane bounds of the
  base icosphere.
- M3: Arrow/Star/Gem/Wedge/Stairs watertight (signed volume > 0);
  Lattice beam count = 12, no degenerate tris.
- M4: curve nodes emit the family triple; helix Spiral's curve length
  grows with height; Scribble same-seed determinism.

In-browser passes: flat-shade + toon + lineart combo look; Heightfield
with animated noise (fps eyeball → bench row if suspect); Backdrop with
transmission materials (fillet reflections).

---

## Backlog (not committed)

Superellipsoid/squircle ball (custom parametric, the soft-blob look),
lathe preset primitives (egg, teardrop, vase), skydome (inverted
sphere + BackSide material — wants a material `side` concept first),
bolt/screw thread, voxelizer (modifier, not primitive), general Displace
+ Subdivide (already on 081026 §8 — Heightfield/Rock are the stopgaps).

---

## Open questions for the owner (defaults chosen; correct before M1)

1. Platonics as one node with a shape enum (decision 1) — or split?
2. Ring at inner radius 0 currently double-sided? Flat shapes (Ring,
   Plane) render single-sided today; a shared `double_sided` param on
   flat primitives could ride M1 but touches MaterialDesc (side field).
   Default: defer, Ring ships single-sided like Plane.
3. Heightfield default subdivisions (96) and cap (256) — right budget?
4. M2 vs M3 order — scene builders before graphic objects is the
   proposed order (Backdrop/Heightfield unlock whole scene types;
   arrows/stars decorate existing ones). Flip if the diorama set is
   more urgent.
