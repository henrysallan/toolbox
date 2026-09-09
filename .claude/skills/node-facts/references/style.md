# Node facts — style guide

`NodeFacts` is the scannable mini-schema that sits next to `description` on
every visible `NodeDefinition` (`src/engine/types.ts`). The MCP catalog prints
it under each node as fixed-order lines (`# space:` `# reads:` `# writes:`
`# flags:` `# ! gotcha`), and the docs reference renders the same lines. It
exists because prose buries the operational facts — Grid's ix/iy stamping was
the last clause of a marketing sentence, and the model relying on it missed
it. Facts are written for the reader who is about to wire the node: units,
spaces, attributes, modes, what breaks.

## Where it lives, how it is applied

- Source of truth: `facts: {...}` on the def, directly above `backend:`
  (factory-built defs — the 3D primitives — pass it in the factory opts).
- Author as JSON `{ "type", "facts", "summary"?, "uncertain"? }`. Apply with
  `npx tsx scripts/apply-node-facts.mts <json | dir>`; it validates first and
  prints a SKIP reason for anything it refuses. Gate:
  `npx tsx scripts/check-node-facts.mts` (part of `npm run check`).
- The gate fails: a visible def without facts; a socket ref that does not
  exist on the def; a space outside the vocabulary; an attribute name that is
  not a string literal or object key in the node's source; a gotcha over 200 chars; more
  than 8 gotchas; a polymorphic-output node without `space.out`.

## Schema

```ts
facts: {
  space?: Record<SocketRef, CoordSpace | CoordSpace[] | SocketRef>;
  reads?: string[];   // "attr:<name>" | "time"
  writes?: string[];  // "attr:<name>"
  gotchas?: string[]; // one operational sentence each
}
```

`SocketRef` = `in:<socket>` | `out` | `aux:<name>` | `param:<name>`
(`in:*` = every input). Socket and param names are the `name:` strings in the
def, never the labels.

## Space vocabulary

| space | meaning |
|---|---|
| `canvas01` | Authored 2D: [0,1]² Y-down in **width units**. At raster time y is scaled about 0.5 by W/H, so every distance/radius is width-relative and on a landscape canvas only y ∈ [0.5−H/2W, 0.5+H/2W] is on screen. Spline and points positions live here. |
| `uv01` | Per-axis [0,1] fraction of a raster's own width/height, **not** aspect-corrected: 0.05 in x is 5% of the width, in y 5% of the height. Shader offsets added to `v_uv` without an aspect term. |
| `raster` | The per-pixel image domain (image / mask / uv wires). |
| `pixels` | Absolute pixels at render resolution; does not scale with output size (`u_texel`, `texelFetch`, integer taps). |
| `world3d` | 3D scene units, Y-up (THREE.js geometry arguments, positions). |
| `time` | Seconds / frames / ticks; audio and notes wires. |
| `unitless` | Factors, ratios, angles, Hz, counts, colors, strings. |

Defaults by socket type are already in the catalog header — **do not repeat
them**: spline/points → canvas01 · image/mask/uv → raster ·
sdf/position/scalar_field → canvas01 · points3d/geometry/render → world3d ·
audio/notes → time · scalar/vecN/color/string → unitless.

List in `space`:

1. every param that is a position, size, radius, distance, offset, or
   thickness, with the unit **as read from the math** (shader uniform use,
   helper calls), never from the label or the slider range;
2. polymorphic inputs: the spaces they accept, one per wire type, e.g.
   `"in:image": ["raster", "canvas01"]`;
3. follow-rules: `"out": "in:image"` when the output takes the space of
   whatever was wired; `"aux:element": "in:geometry"` likewise;
4. any socket whose space deviates from the default table (a `vec2` input
   that is a canvas position, a scalar input that is a pixel radius).

Do not list unitless params (mix amounts, angles, counts, enums, colors) or
sockets that match the default table.

Determining a unit: follow the param to where it reaches the math.
`* u_texel`, `texelFetch`, integer tap loops → `pixels`. `v_uv + offset` with
no aspect term → `uv01`. Multiplied by W only, passed through
`aspectCorrectY`, or written into spline/points positions → `canvas01`.
THREE.js geometry/position arguments → `world3d`. If the source leaves it
genuinely ambiguous, put it under `uncertain` instead of guessing.

## reads / writes

- `attr:<name>` is a point/spline attribute — look for `value.attributes[..]`,
  `readPointAttr`, `gatherAttributes`, `attributes = { ... }`, `attrs`.
  `writes` = stamped or overwritten on the output. `reads` = consumed to compute
  something. Attributes merely passed through untouched are neither.
- `reads: ["time"]` when compute reads the clock (`ctx.time`, `ctx.frame`,
  `params.time`) — beyond what a `clockInput` flag already advertises.
- Spell names exactly as in the source. The gate rejects a name that is not a
  string literal in the node's file, except the engine's well-known names:
  position x y z index rotation scale scale.x scale.y group nx ny nz age ix iy cellW cellH
  t phase phase_active keep weight subpath color driver width.

## gotchas

- Operational only: units, modes and what each changes, ordering, defaults
  that surprise, interactions with other nodes, what silently does nothing,
  what breaks. One sentence each, ≤ 200 chars, ≤ 8 (aim for 2–4).
- Lead with the fact. "radius is in pixels and does not scale with output
  size." — not "Note that the radius parameter…".
- Facts only from the source. No adjectives (true, beautiful, powerful,
  hero), no feature marketing, no restating the description.
- Do not duplicate what the schema already prints: sockets, param
  ranges/defaults/options, and the flags (simulation, unstable, terminal,
  no-mask, gates-outputs, clock) are derived automatically.
- Name modes, params, and sockets exactly: `mode=convolve`,
  `spacingMode=step`, `cutoff_mod`.

## summary (proposal only)

One sentence, ≤ 140 chars, what the node does, no adjectives. Collected for a
later description trim; the codemod ignores it.

## uncertain

Anything you could not settle from the source, one line each
(`"radius unit: bokehPlan stride not checked"`). An honest gap beats a
confident wrong unit — the whole point of this schema is that the model can
rely on it.

## Gold examples

```json
{
  "type": "grid",
  "facts": {
    "space": {
      "param:x": "canvas01",
      "param:y": "canvas01",
      "param:width": "canvas01",
      "param:height": "canvas01",
      "param:spacingX": "canvas01",
      "param:spacingY": "canvas01"
    },
    "writes": [
      "attr:ix",
      "attr:iy",
      "attr:cellW",
      "attr:cellH"
    ],
    "gotchas": [
      "spacingMode=fit derives the gap from width/height and the counts; spacingMode=step fixes the gap (spacingX/Y) and the footprint grows with the counts.",
      "Both modes center the grid on (x, y), so switching modes does not move it; a 1-count axis collapses onto the center line.",
      "ix/iy are integer lattice indices (0..countX-1, 0..countY-1) in row-major point order; Points to Spline layout=grid walks them even after a warp.",
      "cellW/cellH are the actual per-axis gap used to place the points (fit: span/(count-1), step: spacingX/Y, 0 on a 1-count axis) and are constant across the cloud."
    ]
  },
  "summary": "Rectangular X×Y lattice of points centered on (x, y), stamped with ix/iy lattice indices and cellW/cellH spacing."
}
```

```json
{
  "type": "blur",
  "facts": {
    "space": {
      "param:radius": "pixels"
    },
    "gotchas": [
      "radius is in pixels at render resolution and does not scale with output size; Gaussian sigma = radius/2, capped at 64 taps per side (radius ≈43).",
      "The kernel input only exists when mode=convolve; in gaussian/bokeh modes there is nothing to wire it to.",
      "Filters in premultiplied linear light, so transparent edges do not darken but results differ from an sRGB-space blur."
    ]
  },
  "summary": "Blur an image with a Gaussian, a bokeh aperture, or an arbitrary kernel image."
}
```

```json
{
  "type": "displace",
  "facts": {
    "space": {
      "in:image": [
        "raster",
        "canvas01"
      ],
      "in:displacement": "raster",
      "out": "in:image",
      "param:amountX": "uv01",
      "param:amountY": "uv01"
    },
    "gotchas": [
      "amountX/Y are per-axis UV fractions ((channel − midlevel) × amount), not aspect-corrected: 0.05 pushes 5% of width in X and 5% of height in Y.",
      "Polymorphic on the image socket: an image is pushed per pixel; a spline or points value is pushed per anchor/point, each sampling the map at its own UV.",
      "midlevel is the neutral map value (0.5 for signed 8-bit maps, 0 for unsigned); channelX/Y pick which map channels drive each axis.",
      "rotate spins from the map's luminance: images about the frame center, points via per-point rotation, splines via anchor handles."
    ]
  },
  "summary": "Push pixels, points, or spline anchors by a vector read from a displacement image."
}
```

```json
{
  "type": "sdf-circle",
  "facts": {
    "space": {
      "in:position": "canvas01",
      "in:center": "canvas01",
      "in:radius": "canvas01",
      "param:x": "canvas01",
      "param:y": "canvas01",
      "param:radius": "canvas01"
    },
    "gotchas": [
      "Builds an SDF tree only; nothing is drawn until SDF Rasterize (or To Mask / To Distance Image) evaluates it per pixel.",
      "Unwired position = canvas UV; wire a Translate/Repeat/Mirror position chain to change the space the disc is evaluated in.",
      "radius is width-relative only while SDF Rasterize aspect_correct is on; off, it becomes a per-axis UV fraction and the disc squashes on non-square canvases."
    ]
  },
  "summary": "SDF disc of radius r at (x, y), optionally evaluated in a wired position space."
}
```

```json
{
  "type": "cube-3d",
  "facts": {
    "space": {
      "param:size": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d"
    },
    "gotchas": [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "rot_x/y/z are degrees; size is one scalar, so a non-uniform box needs scale_x/y/z."
    ]
  },
  "summary": "Axis-aligned 3D box primitive with built-in transform and PBR material."
}
```

```json
{
  "type": "audio-filter",
  "facts": {
    "gotchas": [
      "Descriptor in, descriptor out: compute() does no audio work; the audio engine builds the Tone.Filter once the chain reaches an audio output.",
      "cutoff is Hz (20..20000) and keyframed or driven changes ramp click-free; wire an audio signal to cutoff_mod to modulate it at audio rate.",
      "rolloff is a string enum (\"-12\" / \"-24\" / \"-48\" dB per octave), not a number."
    ]
  },
  "summary": "Subtractive filter (low/high/band/notch) over an audio chain."
}
```

## Anti-patterns

- `"space": { "out": "raster" }` on an image effect — that is the default; noise.
- `"writes": ["attr:index"]` because the node outputs points — index is
  implicit. Only attributes the code explicitly stamps.
- `"gotchas": ["Great for organic looks."]` — marketing.
- A gotcha that restates the description or the param table.
- A unit guessed from the slider range (0..1 does not mean canvas01).
- Listing `flags` or sockets in gotchas — they are printed already.
