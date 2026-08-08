# Text Instances — per-copy text via the `text_instance` socket (spec, 2026-07-07)

Origin: "when you copy text to points there's no way to change the duplicates. I
want to use their index / position (sample a noise) to alter size, weight,
leading, font, tracking, and the string shown."

Design direction (decided): **don't add a pile of nodes — make the two existing
nodes richer.** Text carries its config + string variants out on a new
`text_instance` socket; Copy to Points consumes it and does the per-copy pick +
typographic modulation + re-raster. Net new: **one socket type, zero new node
files.** This matches how the codebase already grows (Text-on-Path is built into
Text; Copy to Points already carries image/spline/point/image_group as modes).

## Why we carry data, not the `element` output

The instinct to pipe Text's `element` output through Copy to Points and modify it
downstream dies on three facts:

1. **The Text `element` output is box-layout only** — `render` passes `null` for
   the animator block and path layout
   ([text.ts:1336-1352](../../src/nodes/source/text.ts#L1336-L1352)); animators,
   text-on-path, and mask-driven axes are dropped.
2. **There is no element-group type** — `image_group` is a list of flat textures;
   `element` never travels as a set and would coerce to one flat canvas
   ([coerce.ts:159-161](../../src/engine/coerce.ts#L159-L161)).
3. **An element's text config is frozen in closures** with no override hook
   ([types.ts:402-433](../../src/engine/types.ts#L402-L433)).

So to vary weight / leading / font / string per copy, the text must stay **live
data** until it's placed. `text_instance` carries that data; the raster happens at
the copy, where each copy's index and position finally exist.

## The hard constraint that shapes everything

Per-copy typographic variation **cannot live on the Text node** — Text is
pre-placement, so it has no notion of a copy's index or screen position. That only
exists on **Copy to Points**. Therefore:

- **Text's job**: resolve its base style + gather the string variant set, emit it.
  Nothing per-copy.
- **Copy to Points' job**: pick the per-copy string, resolve per-copy typographic
  overrides (driven by index / group / random / a field sampled at the copy's
  position), re-rasterize, and composite.

## Free simplification: the pick modes already exist

The per-copy pick you want — index / random / field — is **already on Copy to
Points** as `pick_mode` (image / random / cycle / target-group, plus
luminance-field indexing via `pick`;
[copy-to-points.ts:450-484,648-657](../../src/nodes/effect/copy-to-points.ts#L450-L484)).
It currently selects which image-group / spline-group / point-group lands on each
point. We just point it at `strings[]`. So Text needs **no** pick UI — only a
"carry all variants" switch.

## Related work to reuse (little is net-new math)

- Field sampler `getLumaSampler` (≤256px blit + `getImageData`, cached by image
  identity) — [copy-to-points.ts:378-434](../../src/nodes/effect/copy-to-points.ts#L378-L434).
- `hash01(i, seed)` (:439), `buildDrawOrder` (:607-633), `chooseVariantGroup`
  pick (:450-484), positioned source-over compositing
  ([element.ts](../../src/engine/element.ts)).
- `ramp_by` index/random/group → normalized-t template
  ([rasterize-spline.ts:165-199](../../src/nodes/effect/rasterize-spline.ts#L165-L199));
  `sampleColorRamp` for the color/font-bucket channels.
- CPU noise ([noise.ts](../../src/engine/noise.ts): `noiseFnFor`) so a copy can be
  driven by noise sampled at its position without routing through a texture.
- `TextStyle` + `wrapStyledLines` + `drawTextBlock`
  ([text-raster.ts](../../src/engine/text-raster.ts)) — the per-copy raster. It's
  engine-side, so Copy to Points importing it respects invariant #1.
- **Separately**: driving the per-glyph *animators* with an image field already
  exists (the animator `field` driver,
  [text-animators.ts:133-151](../../src/engine/text-animators.ts#L133-L151)) — that's
  a per-glyph feature, orthogonal to this per-copy pipeline. Not re-done here.

## The new socket type: `text_instance`

CPU **data-only** (like `string`), and **no coercions** — which is what keeps the
invariant-#7 ripple tiny.

```ts
export type TextInstanceValue = {
  kind: "text_instance";
  base: TextStyle;     // resolved once by the Text node (family, size, weight,
                       // italic, color, leading, letterSpacing, alignment,
                       // fill, stroke, axesDict)
  strings: string[];   // the variant set; length ≥ 1 (single string ⇒ [text])
};
```

v1: variants differ only by **string**; the base style is shared. (Distinct full
style per variant — bold variant, light variant — is a natural v2: widen
`strings` to a `variants: { text, styleOverride? }[]`.) Empty value =
`{ base: <default>, strings: [] }` for `clips.ts`.

## Node changes

### Text node

- **Variant strings** (behind a `variants_enabled` collapsible header, off by
  default, exactly like `path_enabled`): additional string inputs beyond the base
  `text`. **Two UI options — pick one:**
  - *(recommended v1)* a multiline **`string_list` param** (one variant per line).
    Trivial — no socket plumbing, no EffectsApp change; covers "word cloud / pick
    from a set." The base `text` (which can be a wired socket) is variant 0; list
    lines are variants 1..n.
  - *(richer)* **scoped auto-grow `string` sockets** (`str1..strN`), so each
    variant can be a wired dynamic source. Uses the Proximity/Spline-Interpolate
    `slots` pattern, but **scoped** to the `strN` sockets only (Text has other
    fixed inputs — fill/path/mask — so it can't manage "all inputs" as slots like
    those nodes do). Needs a guarded branch in the EffectsApp slots
    normalization `useEffect`.
- **`text_instance` aux output** (`out:aux:instances`), available **always**
  (even single-string): `{ base: styleFromParams(...), strings: [text, ...list] }`.
  A single-string instance is still useful — it lets Copy to Points vary
  *typography* per copy without any variants.
- Primary `image` output unchanged (renders `text` = variant 0). No pick UI on
  Text.

### Copy to Points

- **Accept `text_instance`.** Add `"text"` to the `mode` enum; `onConnect` flips
  `mode` to `text` when a `text_instance` lands (the stored-`mode` retype anchor
  the node already uses); `resolveInputs` retypes the `instance` socket to
  `text_instance` in that mode — this is the "new sockets only when connected"
  behavior, same mechanism as the image_group retype today.
- **String pick** (mode==text): reuse `pick_mode` + optional `pick` field to
  choose `strings[i_copy]`. No-op when `strings.length === 1`.
- **Typographic modulation** (mode==text, `visibleIf`): per channel — **size,
  weight, leading, tracking, font, color** — a collapsible group with a shared
  block:
  - `<ch>_enabled`
  - `<ch>_drive_by`: `uniform | index | group | random | field`
  - `<ch>_amount` (keyframable — `uniform` makes this the **keyframed-time** driver)
  - range: `<ch>_min` / `<ch>_max` (numeric channels); **font** → a family **list**
    the driver-t buckets into; **color** → a `color_ramp` sampled by t
  - `<ch>_field` image input + `field_source: image | noise` (drive_by==field);
    `<ch>_seed` (random)
  - Shared resolver `resolveDriverT(params, ch, iCopy, ctx, sampler)` — the
    field path samples at the copy's `positions[i]` via the existing
    `getLumaSampler` (or `noiseFnFor` at that position).
- **Text raster branch** (mode==text compute): for each target point (in
  `buildDrawOrder` order) → pick string → resolve `TextStyle` = `base` + the
  active per-channel overrides at that copy → `wrapStyledLines` +
  `drawTextBlock` into a scratch canvas → composite at the point honoring the
  point's scale/rotation. **Bucket-cache** rasters keyed by a hash of
  `(resolved style + string)` in an `ctx.state` LRU — many copies share buckets
  (coarse size steps, repeated words), which is what keeps hundreds of copies
  affordable. **Offline**: prewarm every referenced family before the frame loop
  and settle font loads (same requirement as Text's offline prewarm).

**Cost, named honestly:** Copy to Points is **GPU-instanced** today (one
`drawArraysInstanced`); the text branch is a *different* CPU per-copy
raster+composite path plus the modulation param block. It's all `mode==text`
gated (won't touch the other modes), but that branch is the bulk of the work and
it lands on an already-heavy node. Thousands of *unique* strings stays genuinely
expensive (bucket cache can't help) — document it in the node description.

## Wiring changes (new-SocketType checklist, invariant #7)

1. `types.ts`: `"text_instance"` in `SocketType`, `TextInstanceValue`, add to
   `SocketValue`.
2. `socketColor.ts`: a colour (type-ish hue, distinct from `string`/`points`) +
   docs legend.
3. `NodeEditor.tsx` `canCoerce`/`isValidConnection` (×2): exact-type match, no
   coercions — just recognise the type so wiring validates.
4. `clips.ts` `emptyClipOutput`: empty `text_instance`.
5. **No `coerce.ts` entries.**
6. Text: `variants_enabled` + `string_list` (or scoped auto-grow sockets) +
   `resolveAuxOutputs` adding `instances`.
7. Copy to Points: `mode` enum `+= "text"`, `onConnect` flip, `resolveInputs`
   retype, modulation params (`visibleIf mode==text`), the text compute branch,
   import `text-raster`.
8. `src/nodes/index.ts`: **unchanged** (no new nodes). EffectsApp: only if Text
   uses auto-grow sockets (scoped slots normalization).

## Edge cases / notes

- **Non-square canvas**: placement is normalized [0,1]² (anisotropic, like every
  CPU point op); glyph rasters are px-measured then composited at the point — no
  new aspect handling.
- **groupIndex passthrough**: the `group` driver and downstream Select-by-Index
  read the target points' own `groupIndices` (Copy to Points already keeps
  variant assignment index-stable across draw-order shuffles).
- **Rotation-to-tangent** (devlist #165): out of scope, but tangents baked into
  the incoming points' `rotations` flow through the composite for free.
- **Single-string is a first-class case**: emit `text_instance` even with one
  string so you can modulate typography per copy with no variants at all.

## Milestones

1. **Type + raster path.** `text_instance` plumbing (types/socketColor/validation/
   empty). Text emits the aux (single string, base style). Copy to Points `mode:
   "text"` re-rasters **one** string per copy, **no modulation** — proves the
   per-copy `drawTextBlock` + composite + bucket cache. Verify: text at each
   point, per-point scale/rotation honored.
2. **String variants + pick.** Text `variants_enabled` + `string_list` (or
   sockets); Copy to Points `pick_mode` applied to `strings`. Verify different
   strings per copy via index/random/group/field.
3. **Typographic modulation.** Shared `resolveDriverT` + numeric channel groups
   (size/weight/leading/tracking) on Copy to Points; field sampled at copy
   position (image + CPU noise). Verify each driver visibly varies its channel.
4. **Font + color + polish.** Font (family-list pick) + color (ramp) channels;
   bucket-cache tuning, offline font prewarm/settle, perf pass. Consider the v2
   per-variant style widening.
