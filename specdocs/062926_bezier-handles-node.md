# Bezier Handles node — spec (2026-06-29)

Devlist #154: "abstract preset node for visualizing bezier handles — pipe in a
spline, get new splines out."

## What it is

A **spline → image + spline** utility node that renders an editor-style
visualization of a spline's bezier control structure: the curve itself
(optional), the tangent **handle lines** from each anchor to its control
points, an **anchor dot** at every anchor, and a **handle dot** at every
control-point endpoint. Each layer has independent stroke / fill styling
(including dashed & dotted).

It is a pure visualizer over the input geometry — no time/state, no async. It
is essentially "assembly" over machinery that already exists (Canvas-2D spline
rasterization, `setLineDash` dashed/dotted, `arc()` dots), so it should be a
small, self-contained node.

## Output contract

- **primary: `image`** — the rendered visualization (canvas-sized RGBA, straight
  alpha, transparent where nothing is drawn). Drop it on Merge/Output to see it.
  Universal `opacity` param + universal `mask` input apply for free (declare
  `OPACITY_PARAM`, do not `noMaskInput`).
- **aux: `spline`** (output name `spline`, label "Spline") — the vector form of
  the visualization: handle lines as straight-line subpaths **plus** anchor and
  handle dots as small closed bezier-circle subpaths. Does **not** include the
  source path (the caller already has it upstream). Lets you re-rasterize /
  restyle / feed the viz into SDF or boolean nodes.

```ts
return { primary: image, aux: { spline: handleSpline } };
```

## Node identity

| field | value |
|---|---|
| `type` | `"bezier-handles"` (immutable once shipped) |
| `name` | `"Bezier Handles"` |
| `category` / `subcategory` | `"spline"` / `"utility"` |
| `backend` | `"webgl2"` |
| file | `src/nodes/effect/bezier-handles.ts` (spline modifiers live in `effect/`, e.g. `round-corners.ts`) |
| register | add to `src/nodes/index.ts` |

## Inputs

- `path` — `spline`, `required: true`.
- universal `mask` input (auto-appended by the evaluator).

## Geometry: extracting the handles

Handles are stored as **offsets** from the anchor (`SplineAnchor.inHandle` /
`outHandle`), normalized [0,1]² **Y-DOWN**. No math helper needed — iterate
directly:

```ts
for (const sub of spline.subpaths) {
  for (const a of sub.anchors) {
    const anchor = a.pos;
    const inEnd  = a.inHandle  && nonZero(a.inHandle)  ? add(a.pos, a.inHandle)  : null;
    const outEnd = a.outHandle && nonZero(a.outHandle) ? add(a.pos, a.outHandle) : null;
    // handle lines: anchor→inEnd, anchor→outEnd
    // anchor dot: at `anchor`
    // handle dots: at inEnd, outEnd
  }
}
```

Iterating **all** anchors covers closed subpaths correctly — the first anchor's
`inHandle` and last anchor's `outHandle` (used by the closing segment) are
drawn like any other.

## Coordinate / aspect handling (the one real gotcha)

The dots, handle lines, and the path overlay **must align**, and dots must stay
**round** on non-square canvases. Rule:

- **Image output:** map every point — path control points, handle-line
  endpoints, **and** dot centers — through the *same* normalized→px mapping. Use
  `buildPath2DWith(...)` from [spline-raster.ts](../src/engine/spline-raster.ts)
  with the standard aspect-correct map (the one `buildPath2D` uses) so the path
  overlay matches how the same spline rasterizes elsewhere (Rasterize Spline).
  Draw dots with Canvas-2D `arc(cx, cy, rPx, …)` at the mapped center — radius
  in **pixels**, so dots are always round regardless of aspect.
- **Spline output:** raw normalized coords (this is authoring space, no aspect
  correction). Dot circles use `rx = rPx / W`, `ry = rPx / H` so they
  rasterize round downstream.

## Param groups

~30 params, grouped and `visibleIf`-gated so the panel stays manageable. Naming
is grouped by prefix. Dash/dot sub-params follow Rasterize Spline's pattern
(`dashed → [len, gap]`, `dotted → [0, spacing]`).

### Source path (overlay)
| param | type | default | notes |
|---|---|---|---|
| `show_path` | boolean | `true` | "Show path" |
| `path_color` | color | `#8a8a8a` | visibleIf `show_path` |
| `path_width` | scalar px | `1.5` | min 0, softMax 8; visibleIf `show_path` |

(Path overlay is always solid — keeps it readable as the "ground truth" curve.)

### Handle lines (tangents)
| param | type | default | notes |
|---|---|---|---|
| `show_handles` | boolean | `true` | "Show handle lines" |
| `handle_color` | color | `#4a90ff` | |
| `handle_width` | scalar px | `1` | |
| `handle_style` | enum | `solid` | solid / dashed / dotted |
| `handle_dash` | scalar | `6` | visibleIf style=dashed |
| `handle_gap` | scalar | `4` | visibleIf style=dashed |
| `handle_dot_gap` | scalar | `6` | visibleIf style=dotted |

### Anchor dots
| param | type | default | notes |
|---|---|---|---|
| `show_anchor_dots` | boolean | `true` | |
| `anchor_radius` | scalar px | `4` | min 0, softMax 10 |
| `anchor_fill` | boolean | `true` | "Fill" |
| `anchor_fill_color` | color | `#ffffff` | visibleIf `anchor_fill` |
| `anchor_stroke` | boolean | `true` | "Stroke" |
| `anchor_stroke_color` | color | `#4a90ff` | visibleIf `anchor_stroke` |
| `anchor_stroke_width` | scalar px | `1.5` | visibleIf `anchor_stroke` |
| `anchor_stroke_style` | enum | `solid` | + dash/dot sub-params, visibleIf as above |

### Handle dots (control-point endpoints)
| param | type | default | notes |
|---|---|---|---|
| `show_handle_dots` | boolean | `true` | |
| `cp_radius` | scalar px | `3` | |
| `cp_fill` | boolean | `true` | |
| `cp_fill_color` | color | `#4a90ff` | visibleIf `cp_fill` |
| `cp_stroke` | boolean | `false` | |
| `cp_stroke_color` | color | `#ffffff` | visibleIf `cp_stroke` |
| `cp_stroke_width` | scalar px | `1` | visibleIf `cp_stroke` |
| `cp_stroke_style` | enum | `solid` | + dash/dot sub-params |

Plus universal `opacity` (declare `OPACITY_PARAM`).

Defaults are chosen to read like a familiar pen-tool editor: grey path, blue
handle lines, white anchors with a blue ring, solid blue handle dots.

## Rasterization (image output)

Follows the [spline-raster-aux.ts](../src/nodes/source/spline-raster-aux.ts)
shape: a per-node persisted Canvas-2D + GL texture in
`ctx.state["bezier-handles:<nodeId>"]`, re-rastered on compute (compute only
runs on a fingerprint cache miss anyway), uploaded and blitted to a pooled
`ctx.allocImage()` with the standard Y-flip. `dispose` frees the texture.

Painter's order (bottom → top), so anchors stay on top:
1. Source path (if `show_path`) — `buildPath2DWith` + `stroke`.
2. Handle lines (if `show_handles`) — one Path2D of all tangent segments,
   `setLineDash` per `handle_style`, `stroke`.
3. Handle dots (if `show_handle_dots`) — `arc` + `fill` (if `cp_fill`) +
   dashed/dotted `stroke` (if `cp_stroke`).
4. Anchor dots (if `show_anchor_dots`) — same, on top.

Texture discipline: alloc the output image, upload, blit; release nothing we
received; `ownsTextures` default. No intermediate textures to release.

## Spline output construction

Respect the `show_*` toggles (the spline output mirrors what's drawn). Build
one `SplineValue` whose subpaths are:

- **Handle lines** → 2-anchor open subpaths `{ anchors: [{pos: anchor}, {pos: end}], closed: false }`, no handles (straight).
- **Anchor dots** → closed 4-anchor bezier-circle subpaths at each anchor, radius `anchor_radius` (rx/ry normalized as above).
- **Handle dots** → closed bezier-circle subpaths at each control-point end, radius `cp_radius`.

A small `circleSubpath(cx, cy, rx, ry)` helper (kappa = 0.5523) builds the
bezier circle. Worth adding to [spline-math.ts](../src/engine/spline-math.ts)
next to `catmullRomSubpath` since it's generally reusable (the Circle source
node could share it later) — engine-side, so no invariant-#1 violation.

**Optional (M2):** tag subpaths with distinct `groupIndex` (lines = 0, anchor
dots = 1, handle dots = 2) so a downstream Select-by-Index can restyle each set
separately.

## Caching

Pure function of `inputs.path` + params → the input spline's fingerprint and
the params are already in the node fingerprint, so the evaluator caches the
whole output. `stable` stays default (true). No `fingerprintExtras` needed.

## Milestones

- **M1 — Image output.** Node skeleton, inputs/params, all four layers
  rasterized with full styling (path overlay, handle lines incl. dashed/dotted,
  anchor dots, handle dots with fill+stroke). Register in `index.ts`; confirm
  the docs page renders the params sanely. This is the bulk and gives an
  immediately visible, demoable result.
- **M2 — Spline aux output.** Emit handle lines + dot circles as a vector
  `SplineValue`; add the `circleSubpath` helper; `groupIndex` tagging.
- **M3 — Polish.** `visibleIf` audit, default tuning against real splines,
  in-app docs copy. Optional: anchor-dot `shape` enum (circle / square) for a
  more classic editor look; optional dashed path overlay.

## Edge cases

- Empty / missing input spline → empty image + empty spline (`{ kind, subpaths: [] }`).
- Anchors with no handles (corner points / straight segments) → no handle line,
  no handle dot; anchor dot still drawn.
- Zero-length handles (`[0,0]`) treated as absent (`nonZero` guard).
- `radius = 0` → dot not drawn (skip the `arc`).
