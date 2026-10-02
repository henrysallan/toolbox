# Figma → toolbox import

Select a frame in Figma → **Convert** → **Copy** → ⌘V over toolbox's node
editor → the frame lands as a fully wired node graph in its own layer.

## Architecture

Two halves with a versioned JSON contract between them:

- **`figma-plugin/`** — the Figma plugin ("Copy to toolbox"). A thin
  EXTRACTOR: it copies what Figma knows (layer tree, node-local geometry,
  paints, text runs + Figma's own text layout, image bytes) with as little
  interpretation as possible.
- **`src/lib/figma-import/`** — toolbox's importer. Every mapping decision
  lives here, so improving an import never needs a plugin update (designers
  don't reinstall anything; the importer ships with toolbox).

| File | Role |
|---|---|
| `scene.ts` | The contract (`FigmaScene`) + `parseFigmaScene`, the trust boundary: clipboard text is untrusted, so it rebuilds a sanitized copy (finite numbers, bounded strings / arrays / depth, path data limited to M/L/C/Q/Z tokens, image payloads that are real base64 of png/jpeg/gif/webp). Dependency-free — the plugin imports its types. |
| `geometry.ts` | Affine plumbing: Figma node-local px → root-frame px → spline space, path parsing through `svg-parse`'s `parsePathDataTransformed`, closing-duplicate folding, bounds tests. |
| `convert.ts` | Pure scene → graph mapping (no DOM, no GL). |
| `import.ts` | Browser half: decode images (`decodeImageFileEnvelope`, so a later save keeps the original bytes), then `convertFigmaScene`. |

Editor wiring: `NodeEditor`'s paste chain checks `looksLikeFigmaSceneText`
FIRST (a scene can contain any text, so it must never reach the fragment or
SVG sniffers); `EffectsApp.importFigmaSceneText` commits the result like a
source drop — at strict root the frame becomes its own named layer and the
root Merge is wired into that layer's Group Output; inside a scope it drops
in at the pointer. A dropped `.json` export (the plugin's **Download JSON**)
takes the same path — the fallback when a frame is too big for the
clipboard. `FigmaImportToast` reports what landed, lists the importer's
notes, and offers **Match W×H** when the comp's aspect differs from the
frame's — or when the comp has over twice the frame's pixels, since every
imported shape rasterizes at comp size (a 4000² comp holds a 64 MB canvas
per Rasterize Spline).

### Why the plugin copies a scene, not the final graph

- The "fully wired" part needs toolbox anyway: a fragment pasted at root is
  wrapped in a new Layer with nothing wired to its output.
- Faithful text placement needs toolbox's own font rendering (below).
- The mapping will iterate constantly; this way each fix ships with toolbox.

### Clipboard

The plugin UI iframe is a null-origin page (not a secure context), so
`navigator.clipboard` is unavailable. The copy is `document.execCommand
("copy")` + a `copy` listener that sets `text/plain`, and browsers only allow
it inside a user gesture — which is why Convert builds the payload first and
Copy writes it synchronously in its own click. Other plugins report
clipboard failures above ~5 MB; the UI warns past 4.5 MB and offers
**Download JSON** (drop the file on the node editor).

## Coordinate mapping

Canvas = the frame (W × H px). Spline space is [0,1]² Y-down, x across the
width, y WIDTH-relative about the centre (the rasterizer scales y about 0.5
by W/H — `engine/aspect.ts`):

```
x = px / W        y = 0.5 + (py − H/2) / W
```

One affine (`frameToSpline · node.transform`) carries a path from node-local
px straight into spline space — exact, béziers survive affine maps. The
plugin sends each node's transform relative to the ROOT frame
(`inv(root.absoluteTransform) · node.absoluteTransform`; Figma's
`relativeTransform` skips groups). Image Source / Text TRS params are uv01
per axis: `translate = centre / (W, H) − 0.5`, `scale = size / (W, H)`.
Pixel metrics (stroke thickness, dash lengths; text size later) use the `%`
unit (percent of canvas width), so the import holds at any comp resolution
with the frame's aspect.

## Mapping

| Figma | toolbox |
|---|---|
| Frame children, bottom → top | Merge layers, same order. Frame background: one flat colour on a plain rect → Solid Color **base**; anything richer → bottom layer(s) over a transparent base. Frame border → above the children. |
| Rectangle / ellipse / polygon / star / vector / boolean | Spline Draw (its `fillGeometry` — corner radii and boolean results baked by Figma; geometry-only, its own raster off) → Rasterize Spline (`stack_subpaths: false` + Figma's winding rule, so holes stay open). |
| Rectangle / frame background, ellipse | The **Rectangle** / **Circle** primitive instead of Spline Draw (own raster off; still → Rasterize Spline) whenever it reproduces the shape exactly: uniform corner radius (round; Figma's full corner smoothing → `squircle`), rotation via Rectangle's `rotate`; full ellipses only, unrotated or quarter-turned (Circle has no rotate — radii swap). Per-corner radii, partial smoothing, arcs / donuts, flips and off-axis ellipses keep Spline Draw. The plugin (≥ 0.1.1) sends `primitive` hints (radii, smoothing, arc); older exports are read from the geometry (square-cornered rects, 4-anchor ellipses). |
| Fill + centred stroke | ONE Rasterize Spline (fill under stroke, like Figma). |
| Several paints | One Rasterize per paint, bottom → top; strokes after fills. |
| Inside / outside stroke | Figma's own trick: 2× weight, matted by the fill shape via the Merge layer's mask socket (`maskInvert` for outside). Open paths always stroke centred. |
| Line / open vector | Strokes its centerline (`strokePaths` — LINE's segment, VECTOR's `vectorPaths`); closed vectors stroke the fill outline. |
| Stroke cap / join / miter / dashes | butt·round·square / miter·bevel·round / `miter_limit` / `style: dashed` with the first dash-gap pair. |
| Blend modes | By name; HUE / SATURATION / COLOR / LUMINOSITY → Normal (noted). |
| Image fill | Image Source (`fit: stretch` + TRS onto the image's rect: FILL = cover, FIT = contain, CROP via `inv(imageTransform)`) → Rasterize Spline `fill` input (`fill_fit: window`), which clips it to any shape. Paint opacity → the layer's opacity. A rotated / flipped placement is BAKED into the bitmap (`FigmaBitmapOp`, applied by `import.ts`) and placed on its axis-aligned bounding box — Image Source's own `rotate` works in per-axis uv and skews on any non-square comp. |
| Video / pattern / shader fill | Plugins can't read their content: the plugin exports the layer as a still (JPG for a plain opaque rectangle, else PNG) → Image Source. |
| Group / frame | FLATTENS into the parent stack unless compositing needs isolation: opacity over several layers, a non-normal blend, a NORMAL (non-pass-through) group with a blend inside, or a clip that actually cuts something. Isolated → a nested Merge on a transparent base, feeding one parent layer that carries the opacity / blend. |
| Clip content | The frame's contents in a nested Merge, matted by the frame outline (skipped when every child's render bounds sit inside a plain rect frame). |
| Mask (`isMask`) | A mask mattes EVERY sibling above it up to the next mask (Figma's rule — "Use as mask" groups them for you). Those siblings → a nested Merge matted by the mask's outline; VECTOR at full strength, ALPHA honours the mask fill's opacity, LUMINANCE imported as alpha (noted). |
| Mattes | A single-subpath or even-odd shape wires its spline straight into the mask socket (spline→mask coercion fills even-odd); multi-subpath non-zero shapes or partial alpha go through a white Rasterize (image→mask). |
| Text | Live Text nodes (`text-layout.ts`), placed on Figma's own layout — see §Text. Rotated / flipped text, or text without layout data, falls back to its glyph outlines (`fillGeometry`). |
| Unsupported node types (transform groups, stickies, embeds…) | The plugin exports them as PNG (2×); an Image Source places them at their render bounds. |

Every mapping loss is a note in the result card (and the console history),
counted per kind — nothing is dropped silently.

## Text

The Plugin API has no layout info, so the plugin ships each text node's
Figma SVG export with live text (`text.svg`): one `<tspan x y>` per
laid-out line run (y = baseline, text case-transformed, U+2028 soft breaks
included), one `<text>` per style. `text-layout.ts` parses it and maps each
run back onto `characters` (a case-insensitive scan) to find its style
segment and its original-case text.

- **One style** → ONE Text node: Figma's lines joined with `\n` (`wrap`
  off), native alignment, original characters + `textCase` for upper /
  lower (so editing keeps "Top 15…" while it renders "TOP 15"). A run of
  evenly stepped lines per node; a whole-step gap becomes a blank line,
  paragraph spacing splits the node.
- **Mixed styles** → left-aligned pieces at each run's x, merged down the
  page when a run below shares its x and style. A highlighted word is 3
  nodes: the paragraph's line starts, the highlight, the rest of its line.
  (The Text node has no per-range colour; the Color animator has no range
  selector.)
- **Size / spacing**: `font_size` and `letter_spacing` in `%` of width,
  `leading` = Figma's measured line step ÷ size.
- **Baseline**: the Text node centres each line on
  `boxTop + step·(i + ½)` with canvas `textBaseline: "middle"` (the em
  box's centre); the alphabetic baseline sits `δ` below that. `import.ts`
  measures `δ` per face in the browser (ink-top from the `alphabetic` and
  `middle` anchors) after loading the fonts, and the converter solves
  `boxTop = firstBaseline − step/2 − δ`. Horizontal: canvas letter-spacing
  follows a line's last glyph (Figma drops it), so centred / right lines
  shift by `ls/2` / `ls`.
- **Fonts**: a family is checked by measuring against two generics; one
  toolbox can't render is named in a note (it renders in a fallback until
  installed). Underline / strikethrough, small caps, justification and
  image-filled text are noted as approximations.

## Milestones

- **M0 — shipped (this change).** Plugin (manifest, esbuild build, Convert →
  Copy UI, Download JSON, stale detection after edits, optional reference
  render), the scene contract + sanitizer, the converter (shapes, strokes,
  image fills, groups / isolation, clip, masks, text as outlines, raster
  fallback), paste + JSON-drop import with layer wiring, the result card,
  and the `check-figma-import` gate.
- **M0.1 — first real exports (2026-09-23).** Live text (single-style →
  one node; mixed styles → merged pieces); mixed-fill text no longer drops
  (its colours live on the segments); rotated images baked axis-aligned;
  video fills exported as a still; unsupported paints no longer leave an
  orphan Spline Draw; the sanitizer keeps an unsupported paint's Figma type;
  layer names flattened (U+2028). Two trimmed real exports are gate
  fixtures.
- **M1 — gradients.** Linear / radial / angular / diamond onto Rasterize
  Spline's gradient fill (or Gradient → Color Ramp as a fill image for
  multi-subpath shapes). Today: average colour, noted.
- **M2 — images, the rest.** TILE, image rotation / flips, filters
  (exposure, contrast…), rotated images on non-square comps (Image Source's
  rotate is per-axis uv, so it skews when W ≠ H).
- **M3 — live text, the rest.** Rotated text as live text (needs the Text
  node's rotate to be aspect-correct first), gradient / image fills on
  text, per-range colour in ONE node if the Text node grows rich-text runs.
- **M4 — effects + polish.** Drop / inner shadow, layer / background blur;
  auto-layout reverse z-order is already honoured.

## Iterating

1. In Figma, keep a fixtures page (shapes, strokes, image modes, masks,
   rotation, text styles…). Tick **Include Figma's render**, Convert, and
   **Download JSON** for each frame.
2. Drop exports into `scripts/fixtures/figma-import/` — the gate converts
   every file there and validates the graph, so each becomes a regression
   test.
3. Paste (or drop) the export into toolbox. With the render included the
   import adds a detached **Figma reference** Image Source next to the root
   Merge; `compare_renders(reference, rootMerge)` over the toolbox MCP gives
   the numeric parity + heatmap.
4. Only extraction changes need the plugin rebuilt and the frames
   re-exported.

## Plugin dev loop

`npm run figma-plugin:build` (or `:watch`), then in the Figma **desktop**
app: Plugins → Development → Import plugin from manifest… →
`figma-plugin/manifest.json`. With `:watch` running, turn on Plugins →
Development → Hot reload plugin. Console: Plugins → Development → Open
console. Type-check with `npm run figma-plugin:typecheck` (the plugin is
excluded from the app's tsconfig and eslint). Sharing beyond the dev
manifest: publish privately to the organization (Figma Org/Enterprise).
