# Per-glyph Text outputs — `aux:glyphs` + per-glyph `instances`

Status: draft, revised 2026-09-23 after a review of the 09/22 draft against the code; not started · Touches: `src/nodes/source/text.ts`, `src/engine/text-raster.ts`, `src/nodes/effect/copy-to-points.ts`, `src/lib/fonts.ts`, `src/engine/types.ts`, `src/state/presets.ts`; Track B: `src/state/recipe-builder.ts`, `src/state/recipe-edit.ts`, `scripts/toolbox-tool-defs.mjs`, `src/components/effects/mcp-handlers.ts`, `src/engine/evaluator.ts`.

This replaces the 09/22 draft, which was never committed. §12 lists what changed and why.

## 0. Read this first

This spec is written for an agent with no prior context.

1. **Read code from the working tree.** The MCP source tools (`get_node_source`, `read_source`, `search_source`) read the paired editor's release tag, not local edits (TESTING.md §1, the `check-mcp` bullet). For the running editor's node docs, `get_catalog types=["text","copy-to-points","stagger","map-attribute","float-curve","point-expression"]` is still the right tool.
2. **Read the conventions.** TESTING.md: the gates, the §3 perf traps, and §5 on `gatesOutputs`. The devguide's invariants (`specdocs/061226_devguide.md:2015-2045`; 1, 2 and 7 apply here) and its identity paragraph (`:1030-1034`).
3. **Read these in full:**
   - Text's `compute` (`text.ts:1160-1460`).
   - `drawTextBlock` and `renderStyledTextToImage` (`text-raster.ts:582-845`).
   - Copy to Points' text mode and its content-rect cache (`copy-to-points.ts:1344-1476`, `:557-611`).
   - Point Labels' raster cache (`point-labels.ts:67-107`, `:296-353`).
   - `fonts.ts:60-189`.

Line numbers were checked on 2026-09-23 against `b4156fe` plus the uncommitted tree. Re-verify them before editing. `bounding-box.ts` has uncommitted work in flight; this plan no longer touches it.

## 1. Problem

Users can't animate text per character without leaving the node graph. The motivating build was an "L-path type-on": each glyph enters from the right at an above or below offset, moves horizontally, pauses, then drops vertically into place, with one shared easing curve and an adjustable stagger.

| Need | What exists | Gap |
|---|---|---|
| One thing per character | Copy to Points' text mode renders `text_instance.strings[i]` at point i (`copy-to-points.ts:1352-1362`; the `by index` pairing is at `:533-537`) | Text always emits `strings: [style.text]` (`text.ts:1447-1451`). Points to Text has no per-character token (`point-labels.ts:66-75`). |
| Where each glyph is | The per-char raster path measures every advance (`text-raster.ts:714`) and centre (`:738`) | Never exposed. The common fast path (`:633`) doesn't measure glyphs at all. |
| Multi-stage per-glyph motion | Text animators: one `lerp(min, max, t)` per property, a single Position animator (`text-animators.ts:212-216`), and a cascade that sweeps Amount from 0 to 1 | No waypoints, no holds, no per-glyph clock. |
| Stagger and easing primitives | Stagger writes `<attr_name>` (plus `<name>_t0` and `<name>_active` when `extras: true`, `stagger.ts:482-486`). Map Attribute has a `float_curve`. Float Curve's `aux:curve` drives `:param:curve` wires. | These all operate on points, and nothing turns text into points. |

The workaround that shipped was a GLSL Expression that sliced the Text raster into monospace cells (advance = `size × 0.6`), with the character count inferred from a Bounding Box. It only works for monospace fonts, it's opaque, and it took 14 tool round trips to build.

## 2. Audit against the code (2026-09-23)

The 09/22 draft was checked line by line. These findings change the plan.

1. **Spacing comes from the points, not the copies.**
   - The draft forced the unkerned per-char raster whenever `glyphs` was consumed, on the grounds that isolated copies can't reproduce kerning. But each copy is placed at its point, so kerned point positions reproduce a kerned layout. The fast path's own context state yields them: `x_i = x_{i-1} + width(g_{i-1} g_i) − width(g_i)`.
   - Forcing the per-char path would also make Text the first node whose *primary* output depends on `consumedOutputs`; other nodes gate only their aux outputs.
   - And the consumers differ by runtime. In the editor, Spreadsheet panels and socket peek feed `extraConsumed` (`EffectsApp.tsx:3161-3202`); offline export skips them, and the live viewer passes only the output node (`LiveViewer.tsx:370-376`). The editor and the export would render different text.
   - Conclusion: **this spec never changes the primary raster.**
2. **Copies can't match every style today.**
   - Gradients span the whole text box (`text-raster.ts:597`, `resolveFillStyle` at `:353-401`). In a copy, the box is that glyph's own canvas, so every glyph gets the entire ramp.
   - Image fill never reaches `instances`: `fillFromParams` maps `image` to solid (`text.ts:406`), and the composite happens only inside Text (`:593-660`).
   - Each copy's canvas is sized to advance width × `size·leading` (`text-raster.ts:828-833`). That clips italic overhang, stroke outside the advance box, negative letter spacing, and leading below about 1.
   - Animators, modulated axes and `morph_mask` affect only the primary; this is an existing gotcha (`text.ts:732`).
3. **Copy to Points' text mode is expensive on every frame** (from reading the code; not measured).
   - It re-rasterizes every string on every eval (`copy-to-points.ts:1360-1362`).
   - It then reads each one back to find the content-centre anchor (`getContentRect`, `:557-611`). That result is cached by `ImageValue` identity, which freshly rendered copies never hit.
   - Text is `stable: false`, so its fingerprint carries `t:<time>` (`evaluator.ts:763-767`) and Copy to Points recomputes on every played frame.
   - With N glyphs, that's N canvas draws, N texture uploads and N synchronous GPU readbacks per frame.
   - Point Labels already solves this with a per-string LRU cache (`point-labels.ts:74`, `:296-353`).
4. **The drawn layout drops characters.** Wrapping collapses runs of whitespace and trims wrapped lines (`text-raster.ts:251-258`); `\n` is consumed; path mode joins lines with a space (`:488`). A split of `style.text` would drift out of step with the glyphs actually drawn.
5. **The per-char split happens in four places, and saved data depends on them.** `Array.from` is used at `text-raster.ts:291, 488, 671, 685`. The per-glyph variable-axis mode stores its values indexed by that split (`param-controls.tsx:5093`, `:5413`). Switching the raster to grapheme clusters would shift saved values for any text containing emoji or combining marks.
6. **Text breaks the identity contract.**
   - Engine caches treat a new value object as "upstream recomputed" (`element.ts:14-17`, `:440-441`; devguide `:1030-1034`).
   - Text redraws `state.primary` in place and returns the same object (`text.ts:335`, `:1453-1459`). So `alphaBoundingBox` never sees a text edit, and by code reading neither do Auto Layout trim, Copy to Points' anchors and samplers, or Modulate Points' field cache.
   - The convention is a fresh wrapper object per redraw. Precedents: Cursor (`cursor.ts:414-423`: "redrawn-in-place ⇒ re-wrap"), Rasterize Spline, Simulation, and Text's own SDF output (`text.ts:1377`).
   - Adding a `version` field instead would create a second invalidation protocol that every cache would have to learn.
7. **Most curated Google fonts never load.**
   - `isFontReady` is just `document.fonts.check` (`fonts.ts:185`), which returns true when no font face for the family has been registered at all.
   - `ensureFontLoaded` stops on the same check (`:90`), so the Google stylesheet is never requested.
   - Even when it is requested, `wght@100..900` returns HTTP 400 for families with a narrower weight range. On 2026-09-23 that was true for Playfair Display, Bebas Neue, JetBrains Mono and Space Mono (Inter returned 200). A wider sweep found 12 of the 18 curated Google families affected. The comment claiming "Google clamps the range" (`:67-72`) is wrong.
   - Text's raster signature has no readiness token, so a fallback raster stays cached after the real font arrives.
   - As a result, a font-matrix test today compares sans-serif with itself.
8. **The 09/22 recipe didn't run.**
   - Point Expression reads channels only through inline calls (`point-expression.ts:914-915`); the `// ch(...)` comment form belongs to GLSL Expression.
   - Copy to Points needs `mode: "text"` and `pick_mode: "by index"` set explicitly; `pick_mode` defaults to `"all"` (`:835`).
   - `compare_renders` verdict bands, as meanAbs / p95 / alpha: match ≤ 0.01 / 0.06 / 0.01, close ≤ 0.03 / 0.15 / 0.03 (`compare.ts:29-46`). They're measured on a 256-pixel proxy.

The Track B audit is in §9.

## 3. Goals and non-goals

- **G1** Per-glyph animation using existing point nodes only (Stagger → Map Attribute → Point Expression → Copy to Points). No GLSL, and no fan-out of Constant nodes.
- **G2** Works with any font the Text node can render. For curated Google families, that becomes true only after M0.
- **G3** The per-glyph reconstruction matches the primary for every style copies carry (the table in §4.6), pixel-close across the A1 matrix.
- **G4** Backward compatible. The primary raster never depends on the new param or on what's consumed, and old saves render identically. The one intentional visible change is M0's font fix (§5).
- **G5** Scrub-exact and exportable: no per-frame state, and value identity follows content.
- **G6** The used path is cheap: once warm, frames do no text rasterization and no readbacks.

Non-goals:
- A timeline UI inside Text.
- Replacing the `anim_*` animators.
- Word and line split modes (§4.3).
- Parity for image fill, animators, modulated axes and ligatures.
- Switching the primary's per-char and path splits to grapheme clusters; that needs a migration of per-glyph axis values (§11 Q1).
- Right-to-left and vertical text (but don't preclude them).
- Enum and curve group knobs (§9 B3, B4).

## 4. Design

### 4.1 One glyph layout, built from the base style

A new `layoutGlyphs` in `text-raster.ts` returns one entry per grapheme cluster, in draw order. It lives on the engine side (invariant 1). It lays out the **base style**, the style `instances` carries, regardless of which path drew the primary.

**Sequence.**
- Box mode: `lines = wrapStyledLines(canvas, c2d, style, wrap ? boxW : undefined)`, which is the exact call the primary makes (`text.ts:497-498`). The entries are the clusters of each line, in order. There's no entry for `\n` or for whitespace the wrap dropped.
- Path mode: the run is `lines.join(" ")`, as at `text-raster.ts:488`, and the joining space is an entry.
- Segmentation: one helper, `segmentGraphemes(s)`, using `Intl.Segmenter(undefined, { granularity: "grapheme" })` with an `Array.from` fallback (live links run in arbitrary browsers).
- Only the new outputs use the helper. The raster's four `Array.from` sites stay as they are (§2.5).

**Box-mode geometry** mirrors the fast path exactly (`text-raster.ts:621-661`). Factor its block geometry (`lineHeight`, `blockTop` by `vAlign`, the per-line start by `alignment`) into a helper that both call, so the two can't drift apart.
- Context state is the fast path's: `applyAxisStyling(t = 0, charIndex = 0, …)` plus `letterSpacing = <px>`.
- Each line starts from `measureText(line).width` and `alignment`, which is what `textAlign` uses.
- Kerned left edges: `x_0 = lineStart`, then `x_i = x_{i-1} + width(g_{i-1} + g_i) − width(g_i)`.
  - This captures pair kerning and letter spacing whether or not Chromium counts trailing letter spacing, because the trailing term cancels.
  - Gate: `x_last + width(g_last)` must land within 0.5 px of `lineStart + width(line)`.
- Baseline: `y = blockTop + lineHeight·(line + ½)`, with `textBaseline = "middle"`.
- Ink box: `measureText(g_i).actualBoundingBox{Left,Right,Ascent,Descent}` around `(x_i, y)`, grown by `stroke.width / 2` when stroke is on. Whitespace has no ink.

**Path-mode geometry.**
- Extract the placement half of `drawGlyphsAlongPath` (`text-raster.ts:471-573`: the sampler, the align/offset start, `sideShift` and flip) into `placeAlongPath(...)`.
- Both the draw loop (code-point units, output unchanged) and `layoutGlyphs` (cluster units) call it.
- Advances are measured per cluster in isolation, because the path primary doesn't kern.
- Ink centre = the sample point + `R(angle)·(local ink centre)`.
- For text with multi-code-point clusters, the entries diverge from the primary's code-point run. This is documented in §4.6.

**Testability.** Split `layoutGlyphs` into a pure core and a canvas-bound wrapper. The core takes an injected `measure(s) → { width, left, right, ascent, descent }`, so the offline gate can drive it with a fake kerning measurer.

### 4.2 Text: `aux: glyphs` (points)

One point per layout entry, in the same order.

**Transform.** Positions include Text's built-in transform. The forward map below comes from inverting the math in `TEXT_TRANSFORM_FS` (`text.ts:87-113`). It takes a raster point `(u, v) = (px/W, py/H)`, with Y pointing down:

```
a  = rotate · π/180                  Text's rotate is counter-clockwise on screen
dx = u − pivotX,   dy = v − pivotY
u' = pivotX + translateX + cos a · scaleX · dx + sin a · scaleY · dy
v' = pivotY + translateY − sin a · scaleX · dx + cos a · scaleY · dy
position = (u', aspectUncorrectY(v', W/H))          canvas01, as at text.ts:1542
```

- Clamp scale the way `applyTransform` does (`text.ts:674-675`).
- Text's shader still negates the angle. Transform's comment calls that orientation "the historical bug" (`transform.ts:76-80`). Don't flip it here: that would rotate every saved Text the other way.
- The gate asserts the sign against a real raster, because a sign error is invisible at `rotate = 0`.

**Built-in attributes.**
- Position: the ink centre (the advance-box centre for whitespace).
- `rotation = angle_path − a`, where `angle_path` is 0 in box mode. Point rotation is clockwise-positive radians (`transform.ts:76-77`).
- `scale = (scaleX, scaleY)`.
- `group` = the line index.
- `index` is implicit (array position), so glyph points must not be filtered or reordered before they reach Copy to Points.

With these, copies exactly match a transformed primary on square canvases. On non-square canvases positions are still exact, but the primary's rotation happens in UV space and skews (`text.ts:728`), while copies rotate rigidly. That's a documented gotcha.

**Channels.** All are float with arity 1. Their names must appear as string literals in `text.ts`, because check-node-facts requires that (`node-facts-lib.mts:204-217`).

| channel | meaning | space |
|---|---|---|
| `adv_x`, `adv_y` | Centre of the advance box, transformed. Pairs with Copy to Points `anchor: "canvas center"`. | canvas01 |
| `advance` | Distance to the next glyph's left edge (includes kerning and letter spacing). The last glyph in a line gets `width(g)`. | canvas01 width units, text frame |
| `ink_w`, `ink_h` | Ink box size, including stroke | canvas01 width units, text frame |
| `col` | Index within the line | — |
| `word` | Word index. It increments at each non-space cluster that follows a space or starts a line; spaces keep the previous word's index. | — |
| `codepoint` | First code point of the cluster | — |
| `is_space` | 1 for whitespace clusters (`/^\s+$/u`) | — |

For per-word motion at glyph granularity, set Stagger's `order: "attribute"` to `word`. Glyphs in the same word start together, because Stagger ranks ties densely.

**Laziness and identity.**
- Build the layout when `!consumedOutputs || consumedOutputs.has("aux:glyphs")` (the same pattern as `sdf`/`spline`, `text.ts:1374-1375`), or when `instances_split` is `"chars"`.
- Cache it behind a `glyphsValid` flag, cleared wherever `sdfValid` and `splineValid` are cleared (i.e. when the raster or the transform changes).
- A rebuild emits a new `PointsValue`; otherwise return the same object.
- While the font is loading, emit empty points (in the `!isFontReady` branch, `text.ts:1169-1190`).
- Text is `stable: false`, so it doesn't need `gatesOutputs` (TESTING.md §5).

### 4.3 Text: the `instances_split` param

```
instances_split : enum ["block", "chars"]   default "block"
```

- `block` — today's behaviour: `strings: [style.text]`.
- `chars` — `strings` holds the clusters of the layout, in the same order and count as `glyphs`, taken from the same cached result.

Old saves don't store this key, and loaded params aren't merged with defaults (`project.ts:1349`), so compute must read `params.instances_split ?? "block"`.

The case transform is already applied to `style.text` (`text.ts:442`), and `TextStyle` has no case field, so nothing gets applied twice.

`words` and `lines` are deferred:
- They had no matching points, and "lines" was ambiguous (source lines or wrapped lines).
- Per-word and per-line motion come from the `word` and `group` attributes.
- The one remaining reason to want them is that word-sized copies keep kerning and ligatures inside each word. That needs its own points output (§11 Q5).
- Adding options later is additive; invariant 2 forbids repurposing a param, not extending it.

### 4.4 The primary raster stays unchanged

No path forcing, no split change, and no raster-signature change beyond M0's readiness token.

What's left is a small mismatch between the native run and per-glyph copies: ligatures, contextual alternates and complex-script shaping. That's documented as a gotcha.

### 4.5 Copy to Points' text mode

1. **Raster cache.** A per-(style, string) LRU, modelled on Point Labels.
   - The key is `JSON.stringify({ ...base, text: "" })` plus the string (plus the variant key in M4).
   - Clear it when the style changes; cap it at `MAX_CACHE` (1024, `point-labels.ts:74`).
   - The cache owns its images: release them on eviction, on clear and in `dispose`, never per eval. Today `releaseOwned` (`copy-to-points.ts:1378-1380`) frees them every eval.
   - Cached `ImageValue`s stay the same objects, so `contentRects` hits across frames and the per-string readback disappears.
2. **Dedupe variants.** Build one item per unique string, plus a `variantOf[k]` table. `by index` assigns point i to variant i and then to item `variantOf[i]`, so the number of draws scales with unique strings, not with glyphs.
3. **Whitespace.** Keep index alignment, but skip the raster, the readback and the draw for whitespace-only variants.
4. **Ink padding.** Give `renderStyledTextToImage` an opt-in `{ padToInk: true }` option.
   - It grows the canvas to cover both the advance box and the ink box (plus stroke/2 and 1 px), **symmetrically around the advance-box centre**.
   - It returns `{ image, frame }`, where `frame` is the unpadded advance rect in the padded image's UV.
   - `canvas center` anchors don't move, because the padding is symmetric.
   - `custom` anchors are a UV fraction of the instance bounds (gotcha at `:739`). They're mapped through `frame`, so they land where they did before.
   - `content center` uses the alpha bounding box, as it does today.
   - Point Labels keeps calling the function without the option.
5. **Show `tint_attr` and `opacity_attr` in text mode.** Their `visibleIf` is `mode === "image"` (`:995`, `:1005`), but text mode draws through the image path and already applies them.

### 4.6 What the copies carry

| style | in copies |
|---|---|
| solid colour, alpha, stroke | yes (padding stops the stroke being clipped) |
| kerning, letter spacing (±), leading, alignment, vAlign, box, wrap, case | yes, through point positions |
| weight, italic, constant variable axes, uploaded fonts | yes (real italics need M0) |
| the node's transform | yes: exact on square canvases, unskewed on non-square ones |
| linear and radial gradients | from M4 (§4.7) |
| image fill | no. Gotcha: mask the fill image with `copy:out` instead. |
| animators, maskDriven/perGlyph/cycle axes, `morph_mask` | no; they affect the primary only (existing gotcha) |
| ligatures, contextual shaping | no |
| multi-code-point clusters in path mode | positions follow clusters, but the primary still splits by code point |

### 4.7 Gradient frames (M4)

- `TextStyle` gains an optional `fillFrame { x, y, w, h }`, in pixels, relative to the block's area origin. When it's set, `drawTextBlock` builds the gradient over that rect instead of over its own area.
- `TextInstanceValue` gains an optional `variants?: Partial<TextStyle>[]`, parallel to `strings`. This is the widening its type comment already anticipates (`types.ts:572-575`).
- In `chars` mode with a linear or radial fill, Text emits each glyph's text-box rect relative to that glyph's advance-box origin.
- Copy to Points merges `{ ...base, ...variants[k], text }`. Framed variants can't be deduplicated.
- Switch, Time Offset and `clips.ts` pass `text_instance` through unchanged. Points to Text and Point Labels ignore `variants`.

### 4.8 Text's primary identity (M1)

Whenever the primary is redrawn, set `state.primary = { ...state.primary }` before returning. That covers:
- the flat path when `rasterChanged || postChanged`;
- every image-fill recomposite;
- the clear while a font is loading.

Otherwise, return the same object. Pixels don't change. Bounding Box, Auto Layout trim, Copy to Points and Modulate Points start seeing edits without any change to their own files. This fix doesn't depend on anything else here and can land first.

### 4.9 Fonts (M0, a prerequisite)

A separate task for this was spun off on 2026-09-23, and M0 can land from there.

- **Track state per family** (`loading` → `ready` or `failed`) instead of trusting `fonts.check` for families nothing has registered. If `document.fonts.load()` resolves to zero faces, the load failed.
- **Request each curated family's real range**, from a small table next to `CURATED_FONTS` (weight min..max, and whether an italic exists). Request `ital` where it exists so italics aren't synthesized. For other family names, request without an axis spec, and treat a 400 as failed.
- **Wait for the stylesheet's `load` event** before calling `document.fonts.load`.
- **In Text, add a readiness token** to the raster signature and to `fingerprintExtras`. Then a fallback raster isn't kept, and cacheable downstream nodes re-evaluate when the font arrives. Precedents: `ascii.ts:1006-1011`, `optimize-path.ts:265`, `point-labels.ts:288-296`.
- **A `failed` font renders the fallback** (never a blank) and raises a warning once B7 exists.

## 5. Compatibility

| change | effect on saved projects |
|---|---|
| `instances_split` | Absent means `block`, via the compute fallback. No migration. |
| `aux:glyphs` | Appended. Handles are name-based, so existing wires are unaffected. |
| primary raster | Unchanged. |
| M0 fonts | **Visible change**: a curated Google family other than Inter renders in its real face instead of sans-serif. Call this out in the release notes. |
| primary identity | No pixel change. Downstream caches stop going stale (a fix). |
| Copy to Points' text mode | Identical output, except previously clipped ink now shows (a fix). Anchors are preserved through `frame`. |
| `tint_attr` / `opacity_attr` | Now visible in text mode (they were already applied). |
| `TextInstanceValue.variants`, `TextStyle.fillFrame` | Optional; existing producers are unaffected. |
| grapheme segmentation | Used by the new outputs only; saved per-glyph axis values are untouched. |

There's no new `SocketType`, so invariant 7's list of sites to update doesn't apply; §10 lists the sites this change touches. `text-raster.ts` ships in the export bundle, so run `npm run build:export-template` before release.

## 6. Reference recipe

Written with local ids for `insert_recipe`. `<move>`, `<pause>` and `<stagger>` are in frames (Stagger's default unit).

```
text   type=text              text="Per glyph", instances_split="chars"
stag1  type=stagger           attr_name="phase1", spacing=<stagger>, duration=<move>, start=0, loop="off"
stag2  type=stagger           attr_name="phase2", spacing=<stagger>, duration=<move>, start=<move + pause>, loop="off"
ease1  type=map-attribute     attr_name="phase1", output_name="phase1", mode="set"
ease2  type=map-attribute     attr_name="phase2", output_name="phase2", mode="set"
curve  type=float-curve       curve=[{x:0,y:0},{x:0.45,y:0.9},{x:1,y:1}]      the single easing curve
lpath  type=point-expression  expression=<below>
copy   type=copy-to-points    mode="text", pick_mode="by index", opacity_attr="phase1"

text:aux:glyphs     → stag1:in:points
stag1:out           → stag2:in:points
stag2:out           → ease1:in:points
ease1:out           → ease2:in:points
ease2:out           → lpath:in:points
lpath:out           → copy:in:points
text:aux:instances  → copy:in:instance
curve:aux:curve     → ease1:param:curve
curve:aux:curve     → ease2:param:curve
```

```js
const from = pick("from", "alternate", "random", "above");
const dist_x = ch("dist_x", 0.3);
const dist_y = ch("dist_y", 0.2);          // width units: point y is width-relative
const dir = from === "alternate" ? (index % 2 ? 1 : -1)
          : from === "random" ? (rand(index) < 0.5 ? -1 : 1)
          : -1;                            // "above": Y points down, so negative is up
x = px + dist_x * (1 - attr("phase1"));
y = py + dir * dist_y * (1 - attr("phase2"));
```

Notes:
- Map Attribute's ranges default to 0–1 (`map-attribute.ts:117-156`), so `set` writes `curve(phase)`.
- Stagger's params can be group knobs. The `ch()` scalar channels can be exposed through `edit_group`'s `expose_param` (§9 B2). `pick` channels can't be knobs at all.
- The recipe ships as a built-in preset in `PRESETS` (`src/state/presets.ts:364`). The repo has no `examples/` directory.

## 7. Acceptance

"Gate" means the Electron check (§8). "Live" means the running editor, driven over MCP.

- **A1 — Style parity** (gate; `compare_renders` live as a smoke test).
  - Setup: every phase at 1 (`start = -10000` on both Staggers, `loop: "off"`); compare `text:out` with `copy:out`.
  - Fonts:
    - Courier New 700.
    - The local fixture `public/fonts/Inter-VariableFont_opsz,wght.ttf`, uploaded with `wght = 650`.
    - Playfair Display 400 italic and Bebas Neue. These need M0 and network access, so they run locally, not in CI.
  - Variations of each: stroke on at width 6; `letter_spacing` of 12 and of −4; `leading` 0.8. After M4, also linear and radial fills.
  - Test string: kerning pairs (`AV To Wa`), a descender, an accented capital and digits, with no `fi` or `fl`.
  - Pass: every row within the `match` bands, with `close` allowed for the stroke and italic rows. The gate computes the metrics at native resolution, because the tool's 256-pixel proxy hides small misregistration.
- **A2 — Motion** (live). `screenshot_strip frames=[10,25,40,55,70,100]` shows every glyph whole, alternating above and below, moving horizontally and then vertically, and landing on A1's positions.
- **A3 — Text change** (live).
  - Edit `text` and touch nothing else. On the next eval, all of these update:
    - the `glyphs` count;
    - `instances.strings.length`;
    - the `aux:right` of a Bounding Box on `text:out`.
  - Until B8 lands, read the aux values through a Spreadsheet panel.
- **A4 — Independence** (gate).
  - The primary is byte-identical whether `consumedOutputs` is `{primary}` or `{primary, aux:glyphs}`, and under either split.
  - `layoutGlyphs` doesn't run when neither `glyphs` nor `chars` is requested.
- **A5 — Sequence** (offline).
  - `"a\u{1F468}‍\u{1F469}‍\u{1F467}b é"` yields 5 points and 5 strings, with `is_space = [0,0,0,1,0]` and `word = [0,0,0,0,1]`. Write the fixture with escapes, because a literal NFD é can get normalized away.
  - `"a\nb"` yields 2 entries in box mode and 3 in path mode.
  - A wrapped `"a    b"` yields no entries for the collapsed spaces.
- **A6 — Cost** (live, following TESTING.md §3 and §6).
  - Run the §6 recipe with 120 glyphs over two lines, at 1920×1080, capture level 2–3, window in the foreground, over a full loop.
  - Warm frames must show no text rasterization and no readbacks in Copy to Points' texture churn.
  - Report timings in ms, along with the machine and canvas size.
- **A7 — Transform** (gate).
  - On a square canvas with `rotate 30`, `scale (1.5, 0.8)` and `translate (0.1, −0.05)`: A1-level parity.
  - At 16:9: alpha above 0.5 at every non-space point.
  - In path mode (M3): the same, and `rotation` equals the path tangent.

## 8. Milestones and gates

Milestones can land together in one "Land …" commit, or each as it finishes. The `release:` commit owns `changelog.ts` and the version number.

- **M0 — Fonts load what they say.** See §4.9.
  - Gate (offline, in the `check` chain): the URL builder emits each table entry's range and italic spec; the per-family state machine behaves correctly against a stubbed `FontFaceSet` (zero faces ⇒ failed).
  - Live: every curated URL returns 200, and Playfair Display and Bebas Neue measure differently from `sans-serif`.
- **M1 — Layout, `aux:glyphs` (box mode, with transform) and primary identity.** See §4.1, §4.2 and §4.8.
- **M2 — `instances_split: "chars"` and the Copy to Points changes.** See §4.3 and §4.5.
- **M3 — Path mode for glyphs.** See §4.1. The path-mode primary must be byte-identical before and after the `placeAlongPath` extraction.
- **M4 — Gradient frames.** See §4.7.
- **M5 — Docs.**
  - Update Text's `facts` (the `writes` list plus gotchas) and add a cross-reference in Copy to Points, using the `node-facts` skill and `scripts/apply-node-facts.mts`.
  - Gotchas to add:
    - `glyphs` and `chars` describe the base style.
    - `index` is array position, so never filter glyph points.
    - Rotation skews on non-square canvases.
    - Copies don't form ligatures.
    - Image fill isn't carried.
  - Add the §6 preset and the TESTING.md bullets.
- **M6 (optional) — a Glyph Path node.**
  - Points in, points out.
  - Params:
    - `waypoints` (up to 4 vec2 offsets from the target);
    - `segment_frames` and `hold_frames`;
    - `easing` (float_curve);
    - Stagger's `spacing`, `order`, `jitter`, `seed`, `start` and `loop`.
  - Reads an upstream `<n>_t0` when Stagger ran with `extras: true`.
  - Build it on the same primitives, and only after A1–A7 pass.

**Gates.**
- `scripts/check-text-glyphs.mts`: offline. Add it to the `package.json` `check` chain with a `check:text-glyphs` alias. It covers:
  - segmentation and the sequence rules (A5);
  - the pure layout core with a fake kerning measurer: closure, alignment, vAlign, and positive and negative spacing;
  - the transform's forward map against a JS port of the shader's inverse, including the rotation sign;
  - channel packing;
  - the `instances_split` fallback;
  - Copy to Points' pure helpers (`variantOf` and the frame-mapped anchors).
- `scripts/check-text-glyphs-gpu.cjs`: Electron, with a `check:text-glyphs-gpu` alias. It stays out of the chain, like `check:blend-gpu`.
  - It must stay `.cjs`, because it's an Electron main entry (TESTING.md §2).
  - It bundles a TypeScript harness with esbuild and `--alias:@=src`, as `scripts/bench-nodes.cjs` does.
  - It uses real canvas and GL to cover:
    - A1, A4 and A7;
    - the identity rule (unchanged ⇒ same object; edited ⇒ new object, and `alphaBoundingBox` follows);
    - the raster cache (a second eval renders nothing).
  - Push every input through `coerceValue` first (TESTING.md §1).
- For every milestone: `npm run typecheck && npm run check && npm run lint:ratchet`.

## 9. Track B — MCP tooling (independent of the above)

These are corrected against the code.

- **B1 — Restore channel-name wiring in `insert_recipe`.**
  - Channels *are* pre-minted (`recipe-builder.ts:412`). The rejection is a regression from 25607c6: `growExprVarHandle` returns before calling `resolveChannelHandle` for channel-sync nodes (`:212-219`).
  - `edit_group`'s `add_edge` still resolves channel names (`recipe-edit.ts:1068`).
  - Gate: in `check-builder`, wire `<glsl>:in:<name>` and `<pex>:in:<name>` through `buildRecipe`.
- **B2 — Channel shell values: probably already work; fix the docs.**
  - Since 25607c6, `expose_param` seeds a shell value for scalar, toggle, colour and ramp channels (`recipe-edit.ts:1398-1399`, `graph-ops.ts:165-236`).
  - Three places still say channels are wire-only:
    - the tool description (`toolbox-tool-defs.mjs:436-438`);
    - the `CHANNEL_EXPOSE` warning (`recipe-edit.ts:1210-1215`);
    - the assertion in `check-edit.mts:576-582`.
  - Verify live, then update all three.
  - Also let `insert_recipe`'s `exposed[]` accept channel names; today they fail with `BAD_EXPOSED` (`recipe-builder.ts:640-647`).
- **B3 — Enum params as group knobs.**
  - Today this is a hard `BAD_EXPOSED` error, but its message says "dropped" (`recipe-builder.ts:648-655`). Fix the wording now.
  - A shell dropdown is new UI: `paramSocketType` has no enum case (`graph-helpers.ts:315-349`), and `GROUP_INPUT_WIDGET_TYPES` has no widget for it (`groups.ts:269-276`). It needs its own decision.
- **B4 — Curve channels: out of scope.**
  - `curve()` rows are panel-only by a recorded decision (`091926_float-curve-socket.md:57-60`; decision 3 in `090426_expression-channel-kinds.md`), and `float_curve` has no shell editor either.
  - Reopening this needs its own decision record. §6 already shares one easing curve between two nodes.
- **B5 — Add a read-only validation tool.**
  - Toolbox has no approval step of its own. The client's permission prompt runs before a call reaches the server, and `dry_run` is an argument on the mutating tool, so no client can treat it differently.
  - Add a separate tool (for example `validate_recipe`, taking `insert_recipe` or `edit_group` payloads) that users can allowlist.
  - Drop the `{pending: true}` idea: it can't be done server-side. The repo's timeouts are 10, 30 and 60 s (`toolbox-tool-defs.mjs:22-24`), with none at 4 minutes.
- **B6 — A `background` option for `screenshot`.**
  - Values: `none`, `checker`, `black` or `white`.
  - The defaults keep today's behaviour: PNG keeps alpha, JPEG goes over black (`mcp-handlers.ts:489-492`).
  - Consider the same option for `compare_renders`, which is always JPEG over black.
- **B7 — A node warnings channel.**
  - Add `warnings?: string[]` to `NodeOutput` (`types.ts:1220-1231`).
  - The evaluator collects warnings per node, the same way it collects `errors` (`evaluator.ts:2101-2108`), and the editor shows a badge.
  - `get_graph` prints them where GLSL's `shaderError` goes today; that slot is currently hard-coded to GLSL (`glsl-expression.ts:466-489`).
  - The first producer is M0's font-fallback warning.
- **B8 — Make `get_node_data` mark its socket as consumed.**
  - It only sets the forced terminal (`mcp-handlers.ts:432-437`). So a lazy aux output (Text's `sdf`, `spline` or `glyphs`) read over MCP comes back unbuilt or stale. Pass the socket through `extraConsumed`.
  - Also check zone taps, which mark only `primary` and `aux:image` as consumed (`zone-eval.ts:232-287`).

## 10. Sites touched

| site | change | milestone |
|---|---|---|
| `src/lib/fonts.ts` | per-family state, the range table, waiting for the stylesheet to load | 0 |
| `src/nodes/source/text.ts` | readiness token; `glyphs`; `instances_split`; re-wrapping the primary; the transform map; facts | 0–2, 5 |
| `src/engine/text-raster.ts` | `segmentGraphemes`, `layoutGlyphs` and its pure core, shared block geometry, `placeAlongPath`, `padToInk`, `fillFrame` | 1–4 |
| `src/nodes/effect/copy-to-points.ts` | raster cache, dedupe, whitespace skip, frame-mapped anchors, attribute visibility, variants | 2, 4 |
| `src/engine/types.ts` | `TextStyle.fillFrame?`, `TextInstanceValue.variants?`; `NodeOutput.warnings?` (B7) | 4, B7 |
| `src/state/presets.ts` | the §6 preset | 5 |
| `scripts/check-text-glyphs.mts`, `scripts/check-text-glyphs-gpu.cjs`, `package.json`, `TESTING.md` | the gates | 1+ |

## 11. Open questions

1. Should the primary's per-char and path splits switch to grapheme clusters? (Emoji and ZWJ sequences currently render as separate glyphs there.) It would need a migration of saved per-glyph axis values (`param-controls.tsx:5093`, `:5413`). Recommendation: a separate change.
2. Ligatures: leave them as a gotcha, or add an explicit Text param (for example `ligatures: off`) for users who want an exact per-glyph match? An explicit param is fine; behaviour that depends on wiring is not.
3. Should gradient frames (M4) ship in v1, or be deferred? They're the only route to gradient parity, and framed variants can't be deduplicated.
4. Per-glyph axis values could ride in `variants` as constant axes, the same way `fillFrame` does. Is that worth it?
5. Word-sized copies (to keep kerning and ligatures inside words) need word-level points. Should that be a later `aux:words`, or a `glyph_unit` param on this output?

## 12. Changes from the 09/22 draft

| 09/22 draft | now | why |
|---|---|---|
| Forced the unkerned raster whenever `glyphs` was consumed (§4.3) | The primary is untouched; points carry kerned positions | §2.1 |
| Full style parity; "Copy to Points: nothing required" | Parity for the subset copies carry (§4.6); M2 adds the cache and padding; M4 adds gradients | §2.2, §2.3 |
| `rotation` 0 and `scale` 1 on every point | The node's transform is carried | Copies must match a transformed primary |
| Graphemes in the raster's draw loop | Graphemes in the new outputs only | §2.5 |
| `words` and `lines` split modes | Deferred; use the `word` channel with Stagger's order-by-attribute | They had no matching points |
| `x0`, `line` and `space` channels | `adv_x`/`adv_y`, `word`, `is_space`; `group` is the line | `x0` is undefined under rotation; `space` collides with the catalog's `space:` lines; the new channels also answer the old Q1 |
| A `version` field as the preferred fix (§4.5.1) | A fresh wrapper object on every redraw | §2.6 |
| Font fallback as a diagnostics side-fix | M0: a loader fix that has to land first | §2.7 |
| Comment-declared channels in the recipe | Inline `ch()` and `pick()`; `mode` and `pick_mode` set explicitly | §2.8 |
| Thresholds of 0.02 and 0.1; A4 measured through `get_perf` | The tool's own bands at native resolution; byte-identity for A4 | `get_perf` has no sub-spans |
| PR 1–5, unit tests, an `examples/` directory | Milestones M0–M6, check scripts plus an Electron gate, a built-in preset | Repo conventions |
| Track B diagnoses | Corrected | §9 |
