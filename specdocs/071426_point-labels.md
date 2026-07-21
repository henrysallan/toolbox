# Point Labels — data-to-string + per-point text

Snapshot 2026-07-14. Turn a `points` value into text: format each point's own
data (position, index, rotation, …) into a string and render it **at that
point's location**. N points → N labels, positioned on the originals.

Not yet in devlist.md — add an entry when this lands.

## Goal

"Take points and get their position as a string, then display it as text with
the text position mapped to the input points." The canonical output is a
coordinate readout — 10 points → 10 `x, y` labels sitting on the dots — but the
same machinery labels index, rotation, scale, or group, or any custom template.

The original framing ("a String-from-Data node that auto-populates a dropdown
with whatever data we can pull off a socket") lands as a **`field` dropdown**:
a `points` value has a fixed, knowable schema, so the dropdown is a stable enum
(Position / X / Y / Index / Rotation / Scale / Group / Custom), not a
per-connection scrape.

## What already exists (reuse map — don't rebuild)

- **`text_instance` socket** ([types.ts](../src/engine/types.ts#L227)):
  `{ base: TextStyle, strings: string[] }` — a resolved style plus a pool of
  still-editable strings. The Text node emits it from its `instances` aux
  ([text.ts](../src/nodes/source/text.ts#L1352-L1356)).
- **Copy to Points `text` mode**
  ([copy-to-points.ts](../src/nodes/effect/copy-to-points.ts#L1099-L1114)):
  consumes a `text_instance`, rasterizes one image per string via
  [`renderStyledTextToImage`](../src/engine/text-raster.ts#L810), and stamps
  them onto the target points with the same instanced-quad GPU draw the image
  mode uses. **Placement is already solved.**
- **`renderStyledTextToImage(ctx, canvas, style, maxWidth?)`** returns a
  tight-cropped raster at the text's pixel size — exactly what a per-point label
  needs.

**The only real gaps:**

1. Nothing formats point data into per-point strings.
2. Copy to Points treats `strings` as a **variant pool** — its
   [pick modes](../src/nodes/effect/copy-to-points.ts#L731-L737)
   (`all/image/random/cycle/target group`) distribute strings across points;
   none guarantees `string[i] → point[i]`. (`cycle` does it only by coincidence
   when counts happen to match.)

## Decision (design Q&A)

- **Build both** a composable primitive and a self-contained convenience node.
- **Styling** comes from an optional `text_instance` input (wire a Text node to
  borrow its full resolved style); a few local fallback params cover the
  no-wire case. No duplicated typography UI.
- **Units** toggle: normalized `[0,1]` (default) or pixels, with a precision
  control.

## The two nodes

### 1. Points to Text — the primitive (`points-to-text`)

`points` → `text_instance`. Category `point` / subcategory `modifier`.

- **Inputs:** `points` (required); `style` (optional `text_instance` — its
  `base` TextStyle is the label style).
- **Output:** `text_instance` whose `strings[i]` is point `i`'s formatted label,
  **in point order**, and whose `base` is the resolved style. `stable: false`
  is not required (points are CPU + fingerprinted), but the formatter references
  only params + the input value, so caching is automatic.
- Placement is deferred to **Copy to Points** (see the by-index mode below).
  This is the power-user route: full access to Copy to Points' anchor,
  draw-order, and scale/rotate-field modulation on the labels.

### 2. Point Labels — the convenience (`point-labels`)

`points` → `image`. Category `point` / subcategory `modifier`. Self-contained:
format + rasterize + place, all internally, so there's **no second points wire
and no desync risk** (it owns both the data and the strings).

- **Inputs:** `points` (required); `style` (optional `text_instance`).
- **Params:** the full formatter block (below) **plus** placement:
  `anchor` (which corner of the label sits on the point — reuse the
  content-center default), `offset_x` / `offset_y` (nudge labels off the dot,
  in normalized or px per the units toggle), `label_scale` (uniform size
  multiplier on top of the style's font size).
- **Output:** a canvas-sized `image` of all labels composited.

Both nodes share one formatter and one placement path (see Files → shared
helpers), so behavior is identical; Point Labels is Points-to-Text piped into an
inlined Copy-to-Points-text with `by index` pairing.

## Formatter spec (shared)

`formatPointLabel(pts, i, opts) → string`, engine-side
(`src/engine/point-labels.ts`). Reads the typed-array point schema
([points.ts](../src/engine/points.ts#L154-L176)): `getPos`, `getRotation`,
`getScaleX/Y`, `getGroupIndex`, plus implicit `index` / `count`.

- **`field` enum** (the dropdown): `Position (x, y)` (default) / `X` / `Y` /
  `Index` / `Rotation` / `Scale (sx, sy)` / `Group` / `Custom`. Each preset maps
  to a built-in template; picking `Custom` reveals the `template` field.
- **`template` string** (`visibleIf: field === "custom"`), token substitution:
  `{x} {y}` position, `{i}` index, `{n}` count, `{rot}` rotation (degrees),
  `{rad}` rotation (radians), `{sx} {sy}` scale, `{g}` group. Unknown tokens
  pass through literally. Default `"{x}, {y}"`.
- **`units` enum:** `normalized` (default) or `pixels`. Pixels multiplies x by
  `ctx.width`, y by `ctx.height` (anisotropic on purpose — matches the engine's
  coordinate convention; a point at canvas center reads `960, 540` at 1080p, not
  a single aspect-scaled value).
- **`precision` scalar** (0–6, default 2): decimal places for x/y/rot/scale.
  Index / group always render as integers.

Rotation defaults to **degrees** in `{rot}` (friendlier for a readout); `{rad}`
is the escape hatch. Scale tokens read 1.00 when the points carry no scale array.

## Styling resolution (shared)

- If `style` (text_instance) is wired → use its `base` TextStyle, overriding
  `.text` per point.
- Else build a minimal [`TextStyle`](../src/engine/text-raster.ts#L91) from local
  fallback params — the **required** fields only: `family`, `size`, `color`,
  `alignment`, `leading` (default 1.2), `letterSpacing` (0), `axesDict` ({}).
  Everything optional (weight/italic/fill/stroke/fontAxes) stays undefined.
- Local fallback params: `family` (font picker, `control:"font"`), `size` (px),
  `color`, `alignment`. Kept deliberately small — the Text-node input is the
  real styling path.

## Copy to Points — new `by index` pick mode

Add `"by index"` to `pick_mode`
([copy-to-points.ts](../src/nodes/effect/copy-to-points.ts#L731-L737)). In text
mode it pairs `strings[i] → point[i]` (one raster per point, placed at that
point). Behavior when counts differ: clamp — point `i` uses
`strings[min(i, strings.length-1)]`; extra strings past the point count are
dropped. Additive enum value — old saves are unaffected (invariant #2).

**Coupling caveat (documented):** the composable route requires the *same*
points feeding both Points-to-Text and Copy to Points, in the same order — any
filter/reorder/resample between them desyncs labels from dots. The self-contained
Point Labels node exists precisely to avoid this; it's the recommended default.

## Perf note

Coordinate strings are ~all unique, so it's **N rasters per eval** (no
dedup benefit from the variant-pool sharing image groups get). Points are
usually static + fingerprint-cached, so this only bites during playback of
animated points or moving labels. Guard with a per-string raster LRU keyed on
`string + styleSignature` in the node's `ctx.state`, evicting on style change —
mirrors Copy to Points owning + releasing its text rasters each eval, but caches
across evals. Cap the map (e.g. 512 entries) and note the drop.

## Files

Engine (self-contained — invariant #1):
- `src/engine/point-labels.ts` — `formatPointLabel` + the `field`/`units`/
  precision logic. Pure, shared by both nodes.
- Extract Copy to Points' text-mode placement (the `items = strings.map(render…)`
  → instanced draw block, [copy-to-points.ts](../src/nodes/effect/copy-to-points.ts#L1099-L1389))
  into a shared `drawTextInstancesAtPoints(ctx, state, points, strings, base,
  {anchor, order, pairing})` so Point Labels calls the identical GPU path. This
  is the one nontrivial refactor — the draw is entangled with the variant-segment
  packing; lift it carefully and re-verify Copy to Points text mode unchanged.
- `src/nodes/effect/points-to-text.ts` — the primitive.
- `src/nodes/effect/point-labels.ts` — the convenience node (delegates to the
  shared formatter + placement helper).
- `src/nodes/effect/copy-to-points.ts` — add `by index` to `pick_mode`; wire it
  through `chooseVariantGroup` / the text-mode segment assignment.
- `src/nodes/index.ts` — register both new defs.

No new SocketType (reuse `text_instance`, `image`, `points`). No schema bump
(new nodes serialize via the normal node path; the new enum value is additive).
Keep both type strings forever (invariant #2).

Docs:
- In-app docs render from the defs' descriptions — write good ones.
- Devguide: note the two nodes + the shared `point-labels.ts` formatter and the
  Copy-to-Points `by index` mode under "Known sharp edges" / node inventory.
- Add a devlist.md entry.

## Milestones

- **M1 — Formatter + primitive.** DONE. `point-labels.ts` formatter (all fields,
  units, precision, token template, unknown-token passthrough) +
  `points-to-text` node ([points-to-text.ts](../src/nodes/effect/points-to-text.ts))
  emitting `text_instance` — wired Text style wins, else local font/size/color/
  align; pixel units folded into `fingerprintExtras`. Registered in index.ts.
  Verified: formatter against a hand-built points value (position normalized +
  pixels, index, rotation→degrees, scale, group, free-form + unknown-token
  templates, missing-array defaults); typecheck + `npm run check` + lint ratchet
  all green. NOT yet visible in the editor — placement lands in M2.
- **M2 — By-index placement.** DONE. `by index` added to Copy to Points'
  `pick_mode` ([copy-to-points.ts](../src/nodes/effect/copy-to-points.ts#L480-L485))
  — it dropped cleanly onto the EXISTING one-item-per-point assignment path
  (`chooseVariantGroup` returns `distinct[min(n-1, index)]`), so **no placement
  refactor was needed** and the variant-pool modes are byte-unchanged. The
  helper extraction moves to M3, where the self-contained node actually needs
  it. Verified: typecheck + `npm run check` + lint ratchet green; by-index
  routing traced through the text-mode M>1 branch. NOT yet eyeballed in the
  running editor (`Point → Points-to-Text → Copy to Points [text, by index] →
  Output`) — needs a manual browser pass.
- **M3 — Self-contained node.** DONE — with a better approach than the spec
  planned. Instead of extracting Copy to Points' entangled instanced draw,
  `point-labels` ([point-labels.ts](../src/nodes/effect/point-labels.ts)) reuses
  **engine/element.ts's `compositeOverAt`** (proven source-over of a raster at a
  Y-down px rect) — one pass per label. So **Copy to Points is untouched** and no
  risky refactor happened. Point→pixel mapping matches Copy to Points via
  `aspectCorrectY` ([aspect.ts](../src/engine/aspect.ts)) so labels land on dots.
  `stable:false` + a per-string raster LRU (capped 1024, released on evict/style-
  change/dispose) + a Text-style font-readiness gate. Params: placement
  (on/above/below/left/right) + offset X/Y + label_scale (baked into font size
  for crispness) + `OPACITY_PARAM` + the shared formatter block. Verified:
  typecheck + `npm run check` + lint ratchet green; dev-server client compile +
  runtime node registration confirmed (editor serves 200, both nodes register).
  NOT yet eyeballed: a bare `Scatter Points → Point Labels → Output` showing
  labels on dots — needs a manual browser pass.
  - Perf note: N full-canvas composite passes per eval (stable:false). Negligible
    for realistic label counts (tens–hundreds); the raster LRU means text is only
    re-rasterized when a string or the style changes. A future optimization could
    batch via one instanced draw, but correctness/simplicity won here.
- **M4 — Styling + docs.** MOSTLY DONE. Optional `text_instance` style input +
  local fallback params shipped on both nodes in M1/M3; devlist entry #182 added;
  in-app docs render from the def descriptions. Remaining: a short devguide note
  (two nodes + the Copy-to-Points `by index` mode) if wanted, and the in-editor
  visual pass. lint ratchet + typecheck + `npm run check` all green.

## Open questions / risks

- **The placement-helper extraction (M2)** is the only real risk — Copy to
  Points' text draw shares the variant-segment packing with image mode. Lift the
  minimum (string list → rasters → instanced draw with a pairing arg); leave the
  variant machinery in place. Re-verify text mode's existing pick modes.
- **Rotation units default.** Degrees in `{rot}` is the friendly default; if you
  expect radians (matching Point Expression's convention) say so and I'll flip
  it (or expose a `rot_units` enum).
- **Pixel units + non-square canvas.** Deliberately anisotropic (raw
  `ctx.width`/`ctx.height`). If you'd rather show aspect-corrected values, that's
  a formatter flag — flag it now, it's cheap.
- **Multi-line labels / templates with `\n`.** `renderStyledTextToImage` already
  wraps on `\n`, so `"{i}\n{x}, {y}"` just works — no extra handling.
