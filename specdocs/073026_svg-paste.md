# Paste SVG → Spline Draw (shipped 07/30/26)

Cmd+V over the node editor with SVG text on the clipboard (Figma
"Copy as SVG", an inline `<svg>` snippet, or a bare path `d` string)
spawns a **Spline Draw** node pre-loaded with the parsed paths. The
result is immediately pen-tool-editable — unlike SVG Source, whose
geometry lives in a read-only file param.

## Clipboard detection

NodeEditor's window `paste` listener already runs a priority chain:
focused text field → Toolbox fragment JSON → OS files → internal node
clipboard. SVG text slots in after the fragment check and before the
file check (cursor must be over the flow pane, same rule as files):

1. focused text field → native paste
2. `looksLikeFragmentText` → fragment paste (JSON envelope, no overlap)
3. **`looksLikeSvgPasteText` → `onPasteSvgText(text, flowPos)`** ← new
4. clipboard files → `onAddFileNode` (an .svg FILE still → SVG Source)
5. internal node clipboard

Only `text/plain` is inspected (that's where Figma/Illustrator put
"Copy as SVG" markup). `text/html` is deliberately ignored — rich-text
copies from web pages can embed decorative inline `<svg>` icons and
would paste surprising splines.

`looksLikeSvgPasteText` (lib/svg-parse) is the cheap sync gate:
- contains `<svg` (case-insensitive), or
- reads as bare path data: starts with `M`/`m` + coordinate, and
  contains only path-command letters / numbers / separators.

## Parsing + fit

`parseSvgPasteText(text, canvasAspect)` in [lib/svg-parse.ts]:

- Full markup → the existing `parseSvg` (all geometry → cubics,
  transforms flattened, arcs/quadratics converted).
- Bare `d` string → the same path parser wrapped in identity transform.
- Then a **bounds-based uniform contain-fit into the VISIBLE canvas**,
  centered. Authored [0,1]² space is isotropic (buildPath2D
  aspect-corrects Y; both axes render at W px per authored unit), and
  the visible canvas in authored units is the 1 × 1/aspect rect
  centered on (0.5, 0.5). Fitting into THAT rect — not [0,1]², which
  is SVG Source's convention — means the pasted shape always lands
  fully on-screen (a [0,1]² fit fills the width and overflows
  vertically on any landscape canvas). Bounds come from sampling each
  cubic (16 steps/segment — fit-precision only), so stray viewBox
  padding or out-of-viewBox geometry can't push the shape off-canvas.

Shape is preserved exactly (uniform scale in an isotropic space);
Y-DOWN both sides, no flip. Degenerate bounds (a single point) just
center without scaling.

## Node spawn (EffectsApp `handlePasteSvgText`)

- Parse (dynamic-import of svg-parse, same as the file-drop path).
  No subpaths → toast "No paths found in the pasted SVG", no spawn.
  Parser throw (malformed XML) → toast the error, no spawn.
- `pushGraph` undo snapshot, `spawnNode("spline-draw", flowPos)` at
  the cursor's flow position, set `params.spline = { subpaths }`
  (the `spline_anchors` param — same envelope the pen tool writes).
- `placeSourceNode(node, "Pasted SVG")` — at strict root that creates
  a named layer, same as every file-drop/paste source spawn.
- Node params stay at Spline Draw defaults (stroke on, fill off):
  source styling is not imported, the outline view is the neutral
  starting point and shows every subpath.

## Scope / non-goals

- One paste → ONE Spline Draw node; all `<path>`/shape elements land
  as subpaths of it (matches parseSvg's flattening). Split later with
  spline tooling if needed.
- Fill/stroke colors, gradients, text, `<use>`/`<defs>`, images in the
  SVG are ignored — geometry only (exactly parseSvg's contract).
- SVG **files** (Finder copy/paste, drag-drop) keep spawning SVG
  Source — unchanged. This feature is text-on-clipboard only.
- The Spline Draw "Path Animation" keyframe row works on the pasted
  spline like any authored one.

Files: `src/lib/svg-parse.ts` (`looksLikeSvgPasteText`,
`parseSvgPasteText`), `src/components/effects/NodeEditor.tsx` (paste
chain + `onPasteSvgText` prop), `src/components/effects/EffectsApp.tsx`
(`handlePasteSvgText`).
