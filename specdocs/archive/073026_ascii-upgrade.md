# ASCII node upgrade — per-cell color sources + atlas 2.0 (spec, 2026-07-30)

> **Status: implemented** (same day) — all four milestones landed in
> `src/nodes/effect/ascii.ts`. Shaders compile-checked headlessly
> (Electron ANGLE webgl2); typecheck + lint ratchet green; browser
> feel-pass pending. FS sources are exported from the node file for the
> compile check.

The ASCII node (`ascii`) predates most of the shared systems that now exist
(per-subpath color sourcing, `color_ramp` params with per-stop alpha,
driver-reduce-style box reduction, universal opacity, the font picker). This
upgrade brings it current. Owner ask (Q&A 2026-07-30): per-cell background
fills with color controls like Rasterize Spline's, plus glyph color sourcing —
and all the reviewed performance/quality items approved: "lets do all the
suggestions".

Decisions locked with the owner:

- **Per-cell background fill**: flat | source | ramp, with cell-flavored
  ramp drivers (index / random / position / brightness / input).
- **Glyph (fg) color source**: same treatment — flat | source | ramp, where
  `source` tints glyphs by the cell's average source color (classic colored
  ASCII). Text mode only; image_set glyphs keep their own colors.
- **Cell-average sampling** replaces center-texel sampling (box reduce
  pre-pass). Fixes single-pixel flicker on video/webcam input.
- **Atlas 2.0**: multi-row layout (kills the 16,384px single-row ceiling),
  8px gutters + mipmaps (kills minification shimmer; `TEXTURE_MAX_LOD`
  clamped to 3 so deep mips never bleed across slots).
- **GPU image_set atlas**: slot-by-slot FBO blits replace the per-item
  `readImagePixels` CPU readbacks — animated image groups become viable.
- **Transparent backgrounds**: `alpha: true` on the flat colors + per-stop
  ramp alpha; the shader composites straight-alpha source-over. Defaults
  are opaque, so existing projects render identically.
- **Font param** for the text atlas (curated + local picker, same
  `control: "font"` enum as the Text node), default "Menlo" — the head of
  the old hardcoded stack, so unset projects render as before.
- **Universal opacity** (`OPACITY_PARAM`) and a new **brightness aux
  output** (the per-cell remapped luminance driver as grayscale).

## Node surface (after)

```
ASCII  (image / modifier, webgl2)
inputs:
  image      image, required
  image_set  image_group, required        [mode=image_set]
  mod_scale  image, optional              — per-cell glyph scale driver
  mod_rot    image, optional              — per-cell glyph rotation driver
  mod_fg     image, optional              [text mode & fg_source=ramp & fg_ramp_by=input]
  mod_bg     image, optional              [bg_source=ramp & bg_ramp_by=input]
params:
  mode          enum text|image_set (headerControl)
  text          string palette                            [text]
  font_family   enum control:font, default "Menlo"        [text]
  cols, rows, glyph_scale, in_min/in_max/out_min/out_max,
  mod_scale_amount, mod_rot_degrees                       (unchanged)
  threshold     scalar 0..1, default 0 — "Blank below": cells whose
                remapped brightness sits below this render FULLY
                transparent (background included), so blank-glyph cells
                are true blanks instead of filled cells (owner follow-up
                2026-07-30). 0 disables (strict <).
  fg_source     enum flat|source|ramp, default flat       [text]
  fg_color      color alpha:true, default #ffffff         [text & flat]
  fg_ramp       color_ramp                                [text & ramp]
  fg_ramp_by    enum index|random|position|brightness|image, default brightness
  fg_ramp_seed / fg_ramp_angle / fg_ramp_interp           [gated like rasterize-spline]
  bg_transform  bool, default false — the background tile follows the
                glyph's effective transform (glyph_scale × mod_scale,
                mod_rot) instead of filling the whole cell rect; outside
                the transformed box the cell is transparent. Cells become
                scaled/rotated cards; glyph_scale < 1 opens gutters
                (owner follow-up 2026-07-30).
  bg_source     enum flat|source|ramp, default flat
  bg_color      color alpha:true, default #000000         [flat]
  bg_ramp       color_ramp                                [ramp]
  bg_ramp_by    enum index|random|position|brightness|image, default index
  bg_ramp_seed / bg_ramp_angle / bg_ramp_interp           [gated]
  opacity       (OPACITY_PARAM)
outputs:
  primary     image — the glyph grid
  aux index      image — normalized per-cell ordinal (unchanged, column-first)
  aux brightness image — per-cell remapped luminance (the glyph-selection driver)
```

## Ramp drivers (cell analog of ColorRampBy)

Mirrors `makeSubpathDriverFn` semantics (engine/spline-color-source.ts) so
index/random/position mean the same thing everywhere:

- `index` — column-first cell ordinal 0→N-1 (matches the aux index output).
- `random` — GLSL mirror of `hash01(index, seed)` (bit-exact uint arithmetic).
- `position` — cell center projected on a steerable axis, **Y-DOWN** like the
  subpath convention (angle 0 = left→right, 90 = top→bottom).
- `brightness` — the cell's input-remapped luminance (`tNorm`, after
  in_min/in_max, before out_min/out_max) — the cell analog of `driver`.
- `image` — a wired `mod_fg`/`mod_bg` image's `.r` at the cell center,
  consistent with the mod_scale/mod_rot pattern. Socket appears only when
  selected (resolveInputs gate). Unwired → 0.5. (Renamed from `input`
  same-day — owner follow-up; the old value still deserializes.)

The subpath `group` mode has no cell analog and is omitted.

## Technical plan

1. **Reduce pre-pass** — two-pass box reduce (H then V, driver-reduce
   pattern minus the readback/y-flip; pure uv-space) to a cols×rows texture
   holding **premultiplied** average RGBA. Main shader reads one texel per
   cell: unpremultiplied RGB feeds brightness (Rec.601, as before) and the
   `source` color modes; alpha rides along so `source` glyphs fade out over
   transparent regions.
2. **Main shader** — dual ramp sampling via two JS-generated copies of the
   Color Ramp node's `sampleRamp` (uniform arrays, COLOR_RAMP_MAX_STOPS=16;
   generated per-prefix rather than GLSL array params to avoid driver
   variance). Straight-alpha `over()` compositing: glyph layer over bg.
   With opaque flat defaults this reduces exactly to the old
   `mix(bg, fg, coverage)`.
3. **Atlas 2.0** — 64px slots + 8px gutters (80px pitch), row-major
   multi-row, width capped at min(MAX_TEXTURE_SIZE, 4096).
   `generateMipmap` after every (re)build; MIN_FILTER
   LINEAR_MIPMAP_LINEAR with TEXTURE_MAX_LOD=3 (8px — the gutter width, so
   no cross-slot bleed at any usable LOD).
4. **GPU image_set atlas** — persistent atlas texture wrapped in an
   ImageValue and rendered via `ctx.drawFullscreen` (bindTarget attaches
   any texture; drawFullscreen doesn't clear, so slot-by-slot blit draws
   compose). Per slot: fragment discard outside the slot rect, item
   sampled y-flipped (engine images are Y-up; atlas v grows downward).
   Rebuild policy unchanged (texture-ref signature) but now cheap enough
   for per-frame animated groups.
5. **Font** — `ensureFontLoaded`/`isFontReady` (lib/fonts), readiness baked
   into the atlas signature so the atlas re-bakes when a webfont lands
   (same pattern as the Text node).

## Back-compat

- All new params default to the old behavior (flat opaque colors, Menlo-first
  mono stack). Old projects deserialize with defaults → identical output,
  except cell brightness is now a box average instead of a center texel —
  an approved quality change (stable on video, no single-texel flicker).
- Param names `fg_color` / `bg_color` / all existing params unchanged.
- `index` aux unchanged (column-first ordinal grayscale).

## Milestones

1. Reduce pre-pass + brightness aux. — DONE
2. fg/bg color sources (ramps, drivers, mod inputs, alpha compositing) +
   opacity + font param. — DONE
3. Atlas 2.0 (multi-row, gutters, mips). — DONE
4. GPU image_set atlas blit. — DONE
