# SDF materials + unified shading (2026-08-02)

Status: **M0–M4 landed** (+ transform handles). Per-shape colour is
authorable, blends through the existing combiners, can be driven by a
ramp × scalar field for per-tile variation, and `SDF Shade` composites
fill / bleed / lighting / glow / contours in one pass with five aux
outputs. M5 (docs page, preset recipes, devguide pass) remains.

Give the SDF compiler a color channel, so per-shape color survives the
combine operators, and add one terminal (`SDF Shade`) that reads the
resulting field as a continuum — fill, relief lighting, glow, color bleed,
contours — in a single analytic pass. Target look: Zach Lieberman's
multicolor blended fields, fake-3D relief, and per-shape color wash.

Net new nodes: **two** (`SDF Material`, `SDF Shade`). Everything else is
compiler work plus one `color` param on the eight existing primitives.

## Motivation

The SDF graph is the most expressive corner of the app — a chain of N ops
costs one shader compile and one draw call, position folds give infinite
tiling for free, and `morph` interpolates topology. It is also entirely
**monochrome**, and structurally so.

[sdf-compile.ts](../src/engine/sdf-compile.ts)'s `emitSdf` collapses the
whole tree to a single `float` expression. `mainBody` then paints that one
number with global `u_fg` / `u_bg` uniforms. There is no point in the
pipeline where two shapes are distinguishable from each other — by the time
anything is rendered, "which shape am I near" has been thrown away.

So: every color effect on the wishlist (multicolor SDFs, per-shape mixing,
colored glow, color bleed) is blocked by the same thing, and all of them
unblock together the moment the compiler's currency stops being a scalar.
Emboss is the exception that proves it — [sdf-bevel.ts](../src/nodes/sdf/sdf-bevel.ts)
already works precisely because normals only need `d`.

The second problem is compositional. `SDF Rasterize` and `SDF Bevel` are
both *terminal* — each consumes an `sdf` and emits a finished image, so
"emboss **and** glow" means rasterizing the tree twice and merging, and
every combination costs another full branch. The looks being chased are
combinations by nature.

## Load-bearing constraints

**1. The shader cache is keyed on tree *structure*, not values.**
`structuralHash` deliberately hashes kinds and topology only — `morph`'s `t`,
every jitter value, and all shape params are uniforms, so animating them
rebinds rather than recompiles. **Color must follow this rule.** A keyframed
material color that recompiled the shader every frame would be a visible
regression on a system that currently animates for free.

**2. `alloc()` supports three uniform types.** `float`, `vec2`, `sampler2D`
([sdf-compile.ts:303](../src/engine/sdf-compile.ts#L303)). Ramp materials
therefore ride the **sampler** path as a 1×256 LUT, not a `u_positions[16]` /
`u_colors[16]` uniform-array pair like [color-ramp.ts](../src/nodes/effect/color-ramp.ts).
This is the better choice regardless: the emitted GLSL is identical for any
stop count (so adding a stop keeps the shader cache hot), and there is no
uniform-budget cliff when a graph has several ramp materials.

**3. Saved-project back-compat** (invariant #2). `sdf-rasterize`, `sdf-bevel`,
and every primitive type string keep their params and their current output.
The `material` AST kind is **runtime-only** — built in `compute` from params,
never serialized, exactly like `splineSdf`'s `segmentTexture` and
`displace`'s `image`. No schema bump.

**4. Engine self-containment** (invariant #1). The struct emitter and the LUT
builder live in `engine/`; the LUT reuses `engine/color-ramp.ts`'s stop model,
which is already engine-side for this reason.

**5. Texture discipline** (invariant #3). Ramp LUTs live in
`ctx.state["sdf-material:<nodeId>"]` and are torn down in `dispose` — they are
node-owned state, not pool leases, so `ownsTextures` semantics don't apply to
them.

## The core move: `Surf`

Add `emitSurf` beside `emitSdf`. Both walk the same AST; the float emitter
stays, because the lighting section wants cheap distance-only taps at the
four neighbors.

```glsl
struct Surf {
  float d;     // signed distance — same as today
  vec3  c;     // winner-takes-all color
  vec3  acc;   // Σ colorᵢ · wᵢ   (bleed accumulator)
  float accW;  // Σ wᵢ
};

Surf sLeaf(float d, vec3 col, float matW, float bleedInv) {
  float w = matW * exp(-max(d, 0.0) * bleedInv);
  return Surf(d, col, col * w, w);
}

Surf sSmoothUnion(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(a.d, b.d)
                       : clamp(0.5 + 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  Surf r;
  r.d    = (k <= 0.0) ? min(a.d, b.d) : mix(b.d, a.d, h) - k * h * (1.0 - h);
  r.c    = mix(b.c, a.c, h);      // ← the smin's own factor mixes the color
  r.acc  = a.acc + b.acc;
  r.accW = a.accW + b.accW;
  return r;
}
```

`r.c = mix(b.c, a.c, h)` is the whole idea. `h` is already the metaball blend
factor the distance uses; reusing it means **color blends exactly where the
geometry does**, across the same bridge, with the same `Smoothness` knob. No
new node, no new wire — the existing `SDF Smooth Union` starts mixing color
the day materials exist.

The emitter stays expression-based. GLSL ES 3.00 has struct constructors and
struct-returning functions, so combiners emit `sSmoothUnion(<a>, <b>, u_pN)`
and nothing about the recursive-string architecture changes.

### Per-operator semantics

| AST kind | `d` | `c` | `acc` / `accW` |
| --- | --- | --- | --- |
| `union` | `min` | nearer wins | sum |
| `smoothUnion` | `smin` | `mix(b,a,h)` | sum |
| `intersection` | `max` | farther wins | sum |
| `smoothIntersection` | `smax` | `mix` by `h` | sum |
| `subtraction` | `max(a,-b)` | `a.c` | **`a` only** |
| `smoothSubtraction` | `smax(a,-b,k)` | `a.c` | **`a` only** |
| `morph` | `mix(a,b,t)` | `mix(a.c,b.c,t)` | `mix` by `t` |
| `round` / `onion` / `displace` | as today | passthrough | passthrough |

The subtraction rule is the one judgment call: `b` is a **cutter**, not a
painted surface, so it is removed from the geometry and from the wash. A
subtracted shape tinting the field it carved out would be surprising.

Two documented approximations, both falling out of "the wash is emitted by
leaves":

- **Modifiers don't repaint.** A `Displace` or `Onion` above a leaf reshapes
  the composite silhouette but the leaf's bleed weight was computed from its
  own undisplaced distance. This is the desired reading of "color bleed *per
  SDF*", but it means a heavily displaced shape's wash won't follow the
  displacement.
- **Booleans don't reweight.** `acc` is a flat sum over painted leaves; an
  intersection that erases most of a shape still lets that shape's color
  contribute to the surrounding wash.

### Material inheritance

`emitSurf(node, state, mat)` carries the current material down the descent.
`material` rebinds it for its child; **only leaves consume it**. Nested
materials override for their own subtree — CSS `fill` semantics, which is what
anyone will guess.

The root default is the terminal's fill color (`u_fillColor`). A tree with
no materials therefore emits `s.c == u_fillColor` at every leaf, and the
existing rasterize/bevel main bodies produce **pixel-identical output** to
today. That is the M0 acceptance gate, not a hope.

### Uniform memoization

Running both emitters over one tree walks every node twice, and `alloc` mints
a fresh `u_pN` per call — so the naive version doubles the uniform count and
binds each value twice. Fix: memoize in `EmitState` on `(AST node object,
slot)`. The two walks see the same object identities, so the second pass
reuses the first pass's uniform names. Worth doing in M0; retrofitting it
after the uniform list is load-bearing is worse.

## Where color enters

Three authoring routes, **one AST kind**. `SDF Material` and the on-node
swatch build the same node, so the compiler has exactly one case to handle.

```ts
| {
    kind: "material";
    child: SdfNode;
    // Constant route. Straight alpha, consistent with invariant #4.
    color: [number, number, number, number];
    // Ramp route: `t` is a per-pixel field, sampled through a 1×256 LUT.
    // Presence (not stop count) is structural.
    ramp?: { lut: WebGLTexture; t: ScalarFieldNode };
    // Per-material wash weight. 0 = paints itself but contributes
    // nothing to the bleed — the "this one stays crisp" escape hatch.
    bleed: number;
    emission: number;   // glow multiplier
  }
```

```ts
case "material":
  // Color / bleed / emission are uniforms — keyframing them never
  // recompiles. Only the ramp's *presence* and its driving field's
  // topology change the emitted GLSL.
  return `Mt${node.ramp ? `{${scalarFieldHash(node.ramp.t)}}` : ""}(${structuralHash(node.child)})`;
```

**1. On-node swatch (the common case).** A `color` param on each of the eight
primitives, rendered as a swatch on the node body — the mechanism
[EffectNode.tsx](../src/components/effects/EffectNode.tsx) already hosts for
the Color node's per-output swatches, routing through `onParamChange` so undo
/ autokey / socket-resolve all work. When the param is non-default, the
primitive's `compute` wraps its own AST node in a `material`. Cost to the
user: **zero extra nodes**.

**2. `SDF Material` node** (`sdf` → `sdf`). Overrides a whole subtree, and
accepts a wired `vec3`/`vec4` so a Color node or an animated value can drive
it. This is the recolor-six-shapes-at-once control, and the only way to get
color from a wire.

**3. Ramp × scalar field** (on the Material node). `stops: color_ramp` plus a
`scalar_field` input for `t`. This is the one that matters for repeated
geometry: `posCellId` already returns the integer tile index, so

```
SDF Repeat ─ SDF Circle ─ SDF Material [ramp, t ← cellId noise] ─ SDF Shade
```

gives every tile its own color from **one** primitive and **one** material.
Without it, per-tile color is impossible at any node count, because the
position fold means one leaf covers all tiles.

The LUT is built from the sorted stops with the same bracket/interp rules as
`sampleColorRamp`, minted with `LINEAR` + `CLAMP_TO_EDGE` (follow
[spline.ts](../src/nodes/sdf/spline.ts)'s data-texture precedent), cached in
`ctx.state` on a stop signature, and rebuilt only when the stops change.

## `SDF Shade`

One terminal, sections gated by booleans via `visibleIf`, one shader pass for
the composed look. Sections are additive over a common base, so combinations
are the default rather than a merge tree.

```
sdf ─ SDF Shade ─┬─ primary : image
                 ├─ aux:normal   encoded n*0.5+0.5
                 ├─ aux:height   the relief height field
                 ├─ aux:glow     glow only, transparent elsewhere
                 ├─ aux:bleed    the pure color wash
                 └─ aux:mask     coverage
```

| Section | Gate | Params |
| --- | --- | --- |
| **Fill** | always | `fill_color` (root material), `fill_alpha`, `background`, `bg_alpha`, `softness`, `aspect_correct` |
| **Bleed** | `bleed` | `bleed_radius` (canvas-UV), `bleed_mix`, `bleed_falloff` (exp / inverse-sq), `bleed_inside` |
| **Light** | `light` | `height_mode` (outer / inner / emboss / pillow / **curve**), `height_curve` (`float_curve`), `depth`, `soften`, ×2 lights (angle / elevation / highlight / shadow), `hi_color`, `sh_color`, `hi_blend`, `sh_blend` |
| **Glow** | `glow` | `glow_radius`, `glow_intensity`, `glow_color_mode` (material / fixed), `glow_color`, `glow_blend` (add / screen) |
| **Contour** | `contour` | `contour_color`, `contour_alpha`, `contour_width`, `contour_repeat` (concentric bands) |

**Aux outputs are consumption-gated.** Each is one extra `drawFullscreen` with
a mode uniform, and `ComputeArgs.consumedOutputs` means an unwired one costs
nothing — the same discipline Text uses for its JFA and marching-squares
outputs. The honest cost when they *are* wired is one tree evaluation each;
MRT would fold them into one pass but `drawFullscreen` targets a single
attachment today, so that's a later optimization, not a blocker.

`aux:normal` is the sleeper. It hands the analytic SDF normal to anything
downstream — Liquid Glass already consumes `compileSdfSnippet`, and a real
normal buffer opens refraction and relighting without a JFA round-trip.

### Bleed

```glsl
vec3 bleedCol = s.acc / max(s.accW, 1e-4);
vec3 base     = mix(s.c, bleedCol, u_bleedMix);
```

`bleedInv = 1.0 / max(radius, 1e-4)` is a uniform, so radius and mix both
animate without recompiling. The knob reads continuously:

- `bleed_mix = 0` → winner-takes-all. Hard per-shape color, flat-graphic.
- `bleed_mix = 1`, small radius → colors stay local but feather into each
  other at the joins.
- `bleed_mix = 1`, large radius → the whole field is a weighted wash of every
  shape's color. **This is the reference image 2 look**: interiors clamp at
  `w = 1` and read as their own color, the surround is a smooth blend of
  everything nearby.

`bleed_inside` controls whether interiors saturate (`max(d, 0.0)`, a firm
core) or keep growing (`d` unclamped, so the nearest shape dominates hard).

### Height and lighting

Parity with `SDF Bevel`'s four styles, plus `curve` — a `float_curve` mapping
normalized distance → height. The four fixed styles are each a fixed profile;
a curve is all of them and everything between, with a widget users already
know from Color Correction. Reference image 1 — thin strokes reading as sharp
bright ridges with wide soft falloff — is a curve shape, not a style enum
entry.

Normals come from the existing central-difference trick: four `emitSdf`
(float) taps with `p` reassigned, one `emitSurf` tap at the center. Same cost
as today's bevel, which is why the float emitter stays.

## Existing nodes

Both keep their type strings, params, and menu visibility.

- **`SDF Rasterize`** switches its internal emit to `emitSurf` with the root
  material defaulting to `foreground`. Unmaterialed trees are unchanged;
  materialed trees pick up per-shape color in the fill for free.
- **`SDF Bevel`** does the same for its base fill. It stays visible: it is a
  smaller, more legible node than Shade when a bevel is all you want, and
  hiding it would strand it out of the palette for saved projects.
- `SDF to Mask` / `SDF to Distance Image` are unaffected — they never wanted
  color.

## Milestones

**M0 — compiler. DONE (2026-08-02).** `material` AST kind, `Surf` struct +
helpers, `emitSurf`, memoization, `structuralHash` case. `rasterize` and
`bevel` main bodies repointed onto `Surf` with the root material defaulting
to their existing foreground. No user-visible change — nothing builds a
`material` node yet.

Three memos, not one, and they earn their keep separately:
`sdfMemo`/`posMemo` cache emitted expression STRINGS (safe because the
string is re-inlined at each use site, so `p`-reading operators still see
the right coordinate), and `uniformMemo` keys on `(node, slot)` for
combiners and modifiers, whose two pipelines emit different expressions —
`smin(a,b,k)` vs `sSmoothUnion(a,b,k)` — around the same uniform. Without
the last one, bevel minted a **second texture unit for every Displace**,
which would have hit the 16-unit floor on a displace-heavy tree.

Also single-sourced the per-leaf uniform binding as `bindSdfUniforms` —
five nodes each carried their own copy of that loop, and adding `vec3`
to four of five would have left the fifth silently binding a colour as a
texture.

*Verified* against a pre-change build of the compiler, both compiled in a
real WebGL2/ANGLE context and rendered to an RGBA32F FBO at 97×64
(non-square, aspect-correct on):

- 18 trees × 5 output modes = **90/90 pixel-identical within 1e-5**, 85 of
  them bit-exact; the 5 that differ are smooth combiners, where `smin`'s
  `if` became a ternary. Trees covered every primitive, both boolean
  families, morph (including the empty-side degradation), the modifier
  stack, repeat-with-jitter, a scalar-field-driven polygon, twist, and the
  sampler paths.
- **`structuralHash` unchanged on every unmaterialed tree** — saved
  projects don't silently recompile on first open.
- Uniform counts unchanged everywhere except `branchedPosition`, which
  **dropped 12 → 9**: `posMemo` deduping a position chain shared by two
  shapes, the exact pattern the primitives' docs recommend.
- Material path checked functionally: two painted circles under a smooth
  union hold their own colour at each centre and read `[0.467, 0, 0.533]`
  on the bridge; an unmaterialed tree still takes the terminal fill; and a
  nested material overrides only its own subtree.

Harness lives in the session scratchpad (`gen-sdf-shaders.mts` +
`check-sdf-shaders.js`, `gen-material-case.mts` + `check-material.js`),
run via the Electron headless-GL trick. Worth promoting to a
`npm run check:sdf` before M3, since every later milestone changes this
shader.

**M1 — color entry. DONE (2026-08-03).** All eight primitives declare
`SDF_PAINT_PARAMS` and wrap their leaf via `paintSdf`
([engine/sdf-material.ts](../src/engine/sdf-material.ts)); `SDF Material`
node ([nodes/sdf/material.ts](../src/nodes/sdf/material.ts)); on-node
swatch in EffectNode via the `COLOR_SWATCH_PARAMS` table, following the
existing `SCALAR_INPUT_PARAMS` opt-in pattern.

**Colour is two params, not one.** A swatch has no natural "unset" state,
and the compiler's inheritance rule needs one — so `paint` (boolean,
default off) gates `color` through `visibleIf`. Old saves have no `paint`
key, so they inherit and render unchanged. The on-node swatch renders all
three states: a **slashed outline** while inheriting (never a colour —
"no colour of its own" must not read as "black"), a filled swatch + hex
when painted, dimmed when a wire drives it. Clicking an inheriting swatch
turns `paint` on AND opens the picker in one gesture; the ✕ returns to
inheriting without disturbing the stored colour, so the toggle is
lossless.

The Material node's `color` input is **vec4**, not vec3: that's what the
Color node outputs and what `paramSocketType` mints for an exposed
`color` param, and the editor has no vec4→vec3 coercion — a vec3 socket
would have silently refused the one wire the node exists to accept.
Alpha is dropped (the AST carries colour; coverage stays the terminal's).

*Verified* through the real node `compute` functions, then rendered in
WebGL2 — **7/7**: each painted circle holds its own colour; the smooth
union's bridge reads `[0.467, 0, 0.533]` (blended, and not either
endpoint); unpainted shapes still take the terminal foreground; a
Material paints a whole unpainted subtree; and inheritance resolves both
ways — an unpainted branch takes the enclosing Material while a shape's
own Paint overrides it.

Cache-key gates, the ones that matter for animation: painting red/blue
and green/yellow both hash to `Su(Mt(c[u]),Mt(c[u]))`, so **keyframing a
colour rebinds a uniform and never recompiles**; an unpainted tree
allocates **zero** `vec3` uniforms and hashes exactly as it did before
materials existed. `npm run check` green; new node passes the recipe
validator + catalog checks.

**M2 — ramp materials. DONE (2026-08-03).** `ramp?: { lut, t }` on the
material AST; `color_mode` enum + `stops` + `interpolation` params and a
`scalar_field` `t` input on SDF Material; LUT baked in `compute`, cached on
a stop signature in `ctx.state`, deleted in `dispose`.

**The LUT is RGBA8, not RGBA32F.** Float textures are not linearly
filterable in WebGL2 without `OES_texture_float_linear`, so a `LINEAR`
float LUT is an *incomplete texture and samples as solid black* — the
first render check caught exactly that, whole-image black. 8 bits is
precisely the precision hex stops carry anyway.

*Verified* — **5/5** rendered: `t=0` and `t=1` land on the ramp's ends,
`t=0.25` reads `[0.751, 0, 0.249]` (25% along), a constant `t` is flat
across the interior, and a `cellId`→noise-driven ramp produces 115
distinct colours across the tiles versus 26 for the constant (that 26 is
the anti-aliased rim, which is why the flatness check samples interior
points — counting whole-image colours mistakes the rim for ramp
variation).

Cache-key semantics, all confirmed: different **stops** → same hash
(`Mt{k}(c[u])`), different `t` **value** → same hash, ramp-vs-constant →
different, and a different field **topology** → `Mt{n[ci(u)]}(c[u])`.
So editing a ramp rebakes a 1KB texture and never recompiles.

**M2.5 — transform handles on SDF primitives. DONE (2026-08-03).**
Adapters in `PRIMITIVE_GIZMO_ADAPTERS` for `sdf-circle` / `sdf-rectangle`
/ `sdf-polygon` / `sdf-star`. Line Segment and Triangle are deliberately
out: they are point-pair / point-triple shapes wanting endpoint handles,
not a centre+extent box, and PrimitiveGizmo only does boxes. SDF Spline
and SDF from Image carry no position params at all.

Two conversions, both load-bearing (see the devguide's coordinate
section, which this milestone corrected):

- **Y flip.** SDF params are Y-UP, the gizmo's `cy` is Y-DOWN. Without
  it, handles drag the wrong way vertically.
- **Aspect.** `hy = sy · aspect`, which is what keeps an SDF circle round
  on a non-square canvas. Aspect Correct lives on the *terminal*, not the
  primitive, so the adapter assumes its default (on); on a square canvas
  the assumption is free.

New adapter field `hideWhenWired` hides the gizmo when `position` (or
`center`/`size`) is wired — a Position chain retargets the sample space,
so the shape stops sitting at its raw x/y and the handles would point at
nothing. Better no gizmo than a lying one. `motionPath` is omitted
because its `toCenter`/`fromCenter` hooks take no env and so cannot apply
the aspect factor.

*Verified* numerically across 512², 160×80, and 80×160: centre maps to
centre at every aspect, `y=0.7` lands in the upper half, a circle is
round **in pixels** (`hx·W == hy·H`), read→write round-trips are lossless,
and the adapter reproduces the measured GL probe exactly (160×80,
`y=0.2` → `cy=1.1`, off-canvas below — matching the clipped render).

**M2.6 — point handles + N-ary Smooth Union. DONE (2026-08-03).**

*Point handles.* A centre+extent box cannot express "move one endpoint",
so the adapter gained a `points` mode: `read` returns handle positions in
screen space, `write` maps one dragged handle back to params, and
`connect: "open" | "closed"` draws the tie lines. `PrimitivePointHandles`
in PrimitiveGizmo.tsx renders them; the host branches on `adapter.points`
and skips the box entirely (so `read`/`write` became optional on the
interface). **SDF Line Segment** (2 handles, open) and **SDF Triangle**
(3, closed) opt in — Triangle came along because it is the identical gap
and the same six lines of adapter.

*N-ary Smooth Union.* `slots` + `resolveInputs`, reusing the auto-grow
reconciler EffectsApp already runs for Proximity Merge / Spline
Interpolate (derived from edges, so it stays undo-safe). Seeds from the
original `a`/`b` names, so **saved projects keep their wires**;
`smoothness` is excluded from slot minting. Compute left-folds the wired
slots and DROPS unwired ones — `smin(d, 1e10, k)` collapses to exactly
`d`, so no pixel changes, but the emitted tree and its hash stay free of
dead branches. A `+` button turned out to be unnecessary: the reconciler
always leaves exactly one empty spare, so wiring it spawns the next.

*Verified* — 20 checks: fold shapes (`Su(Su(Su(a,b),c),d)` for four
inputs), gaps skipped, single input passes through, no inputs → `E`,
wired smoothness beating the param, legacy `a`/`b` defaulting, endpoint
round-trips lossless at both aspects, dragging A writing only `ax`/`ay`,
and Y-up orientation (`ay=0.8` renders above `by=0.2`).

Note: `PrimitivePointHandles` deliberately does NOT clamp handles to
[0,1] — a segment endpoint legitimately lives off-canvas, unlike a box
centre.

**M3 + M4 — `SDF Shade`. DONE (2026-08-03).** Shipped as one milestone:
all five sections share a single `shade` output mode, so building them
separately would have meant writing the composite twice.
[nodes/sdf/shade.ts](../src/nodes/sdf/shade.ts) + the mode in the
compiler. Layer order is background ← bleed ← glow ← fill (lit) ←
contour.

**Compositing is real source-over, not `mix()`.** The older rasterize /
bevel bodies use `mix(bg, fg, mask)`, which only equals source-over when
both sides are opaque — and glow over a transparent background is exactly
where that breaks. `shade` uses a straight-alpha `srcOver` helper
throughout, per invariant #4.

**The bleed wash is a LAYER, not a tint.** First implementation only
folded the accumulator into the fill colour, so the wash never reached
the gaps *between* shapes — the render check caught it immediately (the
`bleed` aux channel showed the wash correctly while the composite showed
background). Reference image 2 is colour arriving where no shape is, so
the wash composites over the background with `clamp(accW)` as its
coverage: ~1 near the shapes, falling off over the bleed radius.

`sLeaf`'s exponent is clamped to ±60 — with *saturate interiors* off,
`dd` goes negative and a small radius overflowed `exp()` to `inf`,
poisoning `accW`.

Aux outputs (`normal` / `height` / `glow` / `bleed` / `mask`) reuse the
**same compiled program** via a `u_channel` uniform rather than five more
shader variants — one extra draw each, consumption-gated so an unwired
one costs nothing. The height curve's LUT takes the next free texture
unit after `bindSdfUniforms` returns, so it can't collide with a
Displace or Spline sampler inside the tree.

*Verified* — **14/14** rendered: shapes fill with their own colour; the
gap is background with bleed off and picks up a red/blue wash with it on;
a shape's interior stays dominated by its own colour; glow raises alpha
over a transparent background and is coloured by the material; lighting
changes the fill; every section composites together; and all five aux
channels read correctly (normal encoded to 0..1, height inside≠outside,
glow transparent far / opaque near, bleed is the pure wash, mask 1/0).

Gotcha for future edits: **backticks inside GLSL comments terminate the
TS template literal.** Cost three separate syntax errors this milestone.

**M5 — polish.** Docs page, preset recipes reproducing the three reference
looks, devguide update.

## Risks

- **Shader size.** Every leaf now emits a struct constructor and every
  combiner a function call. Trees that compile today will compile, but deep
  trees grow faster. Mitigate with the uniform memo and by watching compile
  time on the biggest existing SDF project.
- **Struct expression nesting.** Expression-based emission means one very long
  nested call. Already true today for `float`; the struct version is the same
  shape, larger constant.
- **`exp()` per leaf per pixel** for the bleed weight — negligible next to the
  distance functions, but it is unconditional. If it shows up, gate it on
  `u_bleedMix > 0` at the cost of a second compiled variant.
- **Param count on Shade.** Five sections is a big panel even fully gated.
  If it reads as unwieldy in M3, the fallback is splitting Glow/Bleed back out
  as separate `sdf` → `image` nodes composed through Merge — the aux outputs
  make that a non-destructive retreat.
