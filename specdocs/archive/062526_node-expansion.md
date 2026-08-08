# June 25 Node Expansion (spec)

Snapshot 2026-06-25. A batch of owner-requested nodes/features filling
graphic- and motion-design blind spots. Five independent workstreams, each
leaving a working app:

1. **Stylize trio** — Posterize, Pixelate/Mosaic, Chromatic Aberration (three
   individual image nodes).
2. **Trim Paths** — a reusable `start`/`end` chunk added to every spline
   primitive + Spline Draw, **plus** a standalone Trim Path node.
3. **Round Corners** node (spline → spline modifier).
4. **Text on Path** — a `path` spline input + params on the existing Text node.
5. **Per-layer matting** — make the universal `mask` input a real matte
   primitive (luma **and** alpha), and give every Merge layer its own optional
   mask input via a toggle.

All five are **additive**: new node `type` strings (immutable once shipped,
invariant #2), new optional params/fields, no handle/param renames, no schema
bump. Engine code stays under `src/engine`, node defs under `src/nodes`
(invariant #1).

---

## 1. Stylize trio (Posterize · Pixelate · Chromatic Aberration)

Three small `category: "image"`, `subcategory: "modifier"` nodes, one
`image` input each, a single fullscreen shader, no persistent state. Template:
[dither.ts](../../src/nodes/effect/dither.ts) minus the readback/state machinery —
just `ctx.getShader(key, FS)` + `ctx.drawFullscreen`. **Each declares
`OPACITY_PARAM`** (free opacity post-pass) and gets the **universal `mask`
input for free** (appended by the evaluator → masks/blends the effect, see §5).
Pure functions of input+params ⇒ default `stable` (cached). Register in
[index.ts](../../src/nodes/index.ts).

### 1a. Posterize — `src/nodes/effect/posterize.ts`
Quantize each channel to N levels (the screen-print / cel-shaded look; distinct
from Dither's error-diffusion and Threshold's 1-bit cut).

- Params: `levels` (scalar int, min 2, max 32, step 1, default 6),
  `channels` (enum `rgb` | `luma`, default `rgb`), `gamma` (scalar 0.2–4,
  default 1 — pre/de-gamma so steps land where the eye wants them).
- Shader core: `q(x) = floor(pow(x,1/g) * L) / max(L-1.0,1.0)` then `pow(.,g)`;
  `rgb` quantizes per channel, `luma` quantizes brightness and rescales rgb by
  the ratio (preserves hue).

### 1b. Pixelate / Mosaic — `src/nodes/effect/pixelate.ts`
- Params: `size` (scalar px block size, min 1, max 256, softMax 64, default 16),
  `shape` (enum `square` | `circle`, default `square` — `circle` masks each
  block to a dot for a Lite-Brite look), `aspect` (scalar 0.25–4, default 1 —
  non-square cells).
- Shader: `grid = vec2(u_w, u_h) / (size * vec2(aspect,1));`
  `cell = (floor(v_uv*grid)+0.5)/grid;` sample at `cell` (block-center
  point-sample — cheap, crisp). `circle` discards fragments beyond radius 0.5
  within the cell. Pass canvas size as `u_w/u_h` uniforms.

### 1c. Chromatic Aberration — `src/nodes/effect/chromatic-aberration.ts`
CA exists today only as a sub-param buried inside Bloom/Grain/Lens Flare; this
is the standalone, controllable node.

- Params: `amount` (scalar, normalized UV offset, min 0, max 0.1, softMax 0.02,
  step 0.0005, default 0.004), `mode` (enum `radial` | `directional`,
  default `radial`), `center` (vec2, default `[0.5,0.5]`,
  `visibleIf mode==radial`), `angle` (scalar deg, default 0,
  `visibleIf mode==directional`), `falloff` (scalar 0–2, default 1 — radial
  only; 0 = uniform, >1 = stronger toward edges).
- Shader: `dir = radial ? (v_uv-center) : vec2(cos,sin)(angle)`;
  `k = radial ? pow(length(v_uv-center)*2.0, falloff) : 1.0`;
  sample `R` at `uv + dir*amount*k`, `G` at `uv`, `B` at `uv - dir*amount*k`;
  alpha = G's alpha (or max of the three to avoid edge fringing on
  transparency). Clamp/zero out-of-range samples (straight-alpha convention).

---

## 2. Trim Paths

The single biggest motion-graphics omission: reveal a stroke along its length
(draw-on). Two deliverables sharing one engine helper.

### 2a. Engine helper — `src/engine/spline-trim.ts` (new, pure)
```
trimSubpaths(subpaths: SplineSubpath[], start: number, end: number): SplineSubpath[]
```
- `start`/`end` are fractions of **total arc length across all subpaths**
  (matches AE "Trim Paths → Trim Multiple Shapes: Simultaneously"). Reuses
  [spline-math.ts](../../src/engine/spline-math.ts): `measureSpline` for the
  per-subpath/segment cumulative lengths, then walks segments, keeping whole
  cubics inside `[s,e]·total` and **splitting the two boundary cubics** with
  bezier-js `Bezier.split(t0,t1)` (convert anchor↔control-point handles via the
  same offset math `subpathToBeziers` uses). Boundary local-`t` comes from
  `(targetLen − prevCum)/segLen`, exactly like `resampleSubpath`/`sampleSplineAt`.
- **Identity fast-path:** `start <= 0 && end >= 1` → return `subpaths` unchanged
  (zero cost when not trimming). Clamp to `0 ≤ start ≤ end ≤ 1`; `start === end`
  → empty (`[]`).
- A trimmed **closed** subpath becomes **open** (a partial arc) — expected; fill
  still closes implicitly via `buildPath2D`'s `fillOn` even-odd path. Note in
  the node description.
- Out of scope v1: per-subpath/"individually" mode, and a wrap-around `offset`
  (the owner asked for exactly two sliders). Both are clean follow-ups (`offset`
  = a third scalar; "individually" = run `trimSubpaths` per subpath).

### 2b. Reusable param chunk — `spline-raster-aux.ts`
Add next to `SPLINE_RASTER_PARAMS` (the existing home for shared primitive param
chunks, [spline-raster-aux.ts](../../src/nodes/source/spline-raster-aux.ts)):
```
export const SPLINE_TRIM_PARAMS: ParamDef[] = [
  { name: "trim_start", label: "Trim start", type: "scalar", min: 0, max: 1, step: 0.001, default: 0 },
  { name: "trim_end",   label: "Trim end",   type: "scalar", min: 0, max: 1, step: 0.001, default: 1 },
];
export function applyTrimParams(subpaths, params) {
  return trimSubpaths(subpaths, Number(params.trim_start ?? 0), Number(params.trim_end ?? 1));
}
```
Both scalars ⇒ **keyframable for free** (animate `trim_end` 0→1 = draw-on).

### 2c. Add to every primitive (one-line change each)
Spread `SPLINE_TRIM_PARAMS` into `params` and, in `compute`, trim the geometry
**before** it's used for the `spline` output, the raster aux, and the element:
```
const geo = applyTrimParams(rawSubpaths, params);
// geo feeds: { primary: spline(geo) }, rasterizeSplineAux(geo), buildSplineElement(geo)
```
Targets: Circle, Rectangle, Spiral, Cross, Polygon, Star, Arc, Wave, Arrow
([src/nodes/source/](../../src/nodes/source/)) **and** Spline Draw
([spline-draw.ts](../../src/nodes/source/spline-draw.ts)) — apply after it
resolves `spline_anchors` into subpaths. Defaults (0,1) ⇒ existing saves render
identically.

### 2d. Standalone node — `src/nodes/effect/trim-path.ts`
`type: "trim-path"`, `category: "spline"`, `subcategory: "modifier"`. Input
`{ name: "path", type: "spline" }` → primary `spline`. Params = the two trim
scalars (reuse `SPLINE_TRIM_PARAMS`). Pure spline→spline, no raster aux — model
on [offset-path.ts](../../src/nodes/effect/offset-path.ts) / [resample.ts](../../src/nodes/effect/resample.ts)
(view via Stroke / Rasterize Spline). This is the node you reach for to trim a
spline you imported or built downstream, vs. the inline chunk for primitives.

---

## 3. Round Corners — `src/nodes/effect/round-corners.ts`
Spline → spline modifier (Illustrator "Round Corners"). `type: "round-corners"`,
`category: "spline"`, `subcategory: "modifier"`. Input `path: spline` → primary
`spline`.

- Params: `radius` (scalar, **normalized** distance — spline space is `[0,1]²`,
  min 0, max 0.5, softMax 0.15, step 0.001, default 0.04).
- Engine helper `roundCorners(subpaths, radius)` in
  [spline-math.ts](../../src/engine/spline-math.ts): for each **corner** anchor
  (treat by neighbor positions, ignoring existing handles — Illustrator
  semantics), replace it with two anchors inset along the incoming/outgoing
  edges by `r' = min(radius, halfLen(prevEdge), halfLen(nextEdge))`, with bézier
  handles forming a circular fillet — handle length `= r' · (4/3)·tan(θ/4)`
  along each edge tangent, where `θ` is the turn angle. (Same exact arc-to-bézier
  formula the **Arc** primitive already uses per
  [062526_spline-primitives.md](062526_spline-primitives.md).)
- Closed subpaths round every anchor (wrap neighbors); open subpaths skip the
  two endpoints. Anchors that already carry handles (curved) are passed through
  unchanged in v1 (rounding a curve is ill-defined). `radius === 0` → identity.
- Works immediately on Polygon / Star / Rectangle / Cross / Arrow corners —
  which is why corner-rounding was left out of the primitives themselves
  (spline-primitives "out of scope"): this node covers all of them.

---

## 4. Text on Path — path input + params on the Text node
Owner decision: **not** a separate node — add it directly to the existing
**Text** node ([text.ts](../../src/nodes/source/text.ts)) as an optional `path`
spline input plus a "Path" param group. Wiring a spline switches layout from box
→ path; with nothing wired the node behaves exactly as today. This reuses the
Text raster stack end-to-end (no duplicate font/measure/draw code) and
**composes with the Text Animators**
([062526_text-animators.md](062526_text-animators.md)) — both ride the same
per-character ("modulated") draw path.

- **Input:** add `{ name: "path", type: "spline", required: false }` to Text's
  `resolveInputs` (alongside the existing `mask`/`fill` + animator field inputs).
  spline→spline is directly valid — no coercion or NodeEditor change.
- **Params (new, in a collapsible `group: "path"`** — reusing the `ParamDef.group`
  + `groupHeader` collapse hint the Text Animators spec adds to ParamPanel):
  `path_align` (enum `start`|`center`|`end`), `path_offset` (scalar 0–1, slide
  along the path), `path_side` (enum `on`|`above`|`below` — perpendicular
  baseline shift), `path_flip` (boolean, reverse direction). Existing
  `letterSpacing`, `fontSize`, `color`, font, and transform params still apply;
  box-only params (boxWidth/boxHeight, wrap) are ignored in path mode.
- **Engine** ([text-raster.ts](../../src/engine/text-raster.ts)): thread a `path`
  argument into `drawTextBlock`. When present, force the modulated path (same
  gate as maskDriven/animators), run the existing **advance pass** for per-glyph
  advances, then map each glyph's cumulative advance → arc-length position with
  `measureSpline` + `sampleSplineAt`
  ([spline-math.ts](../../src/engine/spline-math.ts), which already returns `pos`
  **and** unit `tangent`). Per glyph: draw at `pos`, rotated by `atan2(tangent)`,
  shifted perpendicular by `path_side`. Animator `GlyphAnim` offsets/rotation/
  scale then stack **on top** of the path transform.
  `path_align`/`path_offset`/`path_flip` shift/reverse the arc-length mapping;
  glyphs past the path end clamp-and-stop (matches AE).
- **Scope/limits:** primary raster only — the Auto-Layout `element` output stays
  box layout (matches the animators' primary-only v1); single continuous
  arc-length domain (multiple subpaths concatenate); no word-wrap in path mode.
- **Back-compat:** new optional input + params with inert defaults ⇒ existing
  Text saves load and render unchanged. **No new `type`, no schema bump.** Fold
  the path params into Text's existing raster signature cache so edits/keyframes
  re-raster (Text is already `stable: false`; a keyframed `spline_anchors` path
  animates the layout for free).

---

## 5. Per-layer matting (universal mask + Merge layer masks)

Two parts. Today the universal `mask` input already mattes: the evaluator does
`mix(base, effect, m)` when the node has an image input, else `effect·m`
([evaluator.ts:930-952](../../src/engine/evaluator.ts)), and `image→mask` coercion
is **luma** (Rec.709, [coerce.ts:171-180](../../src/engine/coerce.ts)). So
**luma matting through the mask input works now** — what's missing is **alpha**
matting and shaping, and per-Merge-layer masks.

### 5a. Matte node — `src/nodes/effect/matte.ts`
Coercion is params-less and hardwired to luma, so alpha/channel control needs an
explicit node. `type: "matte"`, `category: "image"`, `subcategory: "modifier"`,
input `image` → **primary `mask`**. This is the reusable "make a matte from this
image, then wire it into any node's `mask` input (or a Merge layer mask)"
primitive — the track-matte mechanism, made explicit.

- Params: `source` (enum `luma`|`alpha`|`red`|`green`|`blue`, default `luma`),
  `invert` (boolean), `low`/`high` (scalars 0–1, default 0/1 — black/white
  point remap, `smoothstep(low,high,v)`), `feather` (scalar, optional blur).
- Shader writes the selected channel into `.r` (mask convention). Output type
  `mask` so it drops into any `mask` socket; `mask→image` coercion already lets
  it feed image consumers too. **No coercion changes** (keeps the global
  luma default intact — invariant #7), no NodeEditor edits (image→mask wiring is
  already valid).

### 5b. Merge layer masks — edit [merge.ts](../../src/nodes/effect/merge.ts) + [ParamPanel.tsx](../../src/components/effects/ParamPanel.tsx)
Give each Merge layer an optional mask that multiplies its alpha before the
blend — the real per-layer track matte.

- **`MergeLayer` interface** gains optional fields:
  `maskEnabled?: boolean`, `maskSource?: "luma" | "alpha"`, `maskInvert?: boolean`.
- **`resolveInputs`**: when `l.maskEnabled`, push an extra input socket
  `{ name: \`layerMask:${l.id}\`, label: \`mask ${i+1}\`, type: "image" }`.
  Declared **`image`** (not `mask`) so the user can feed image data directly and
  pick luma vs alpha in-shader; image→image is trivially valid and mask/element
  coerce in.
- **`BLEND_FS`**: add `uniform sampler2D u_mask; uniform int u_hasMask, u_maskSrc,
  u_maskInvert;` and gate the layer's effective alpha:
  `float mv = u_maskSrc==1 ? texture(u_mask,v_uv).a : luma(texture(u_mask,v_uv).rgb);
   if (u_maskInvert==1) mv = 1.0 - mv;
   float srcA = clamp(b.a * u_opacity * (u_hasMask==1 ? mv : 1.0), 0.0, 1.0);`
  (bind a 1×1 placeholder when no mask is wired — WebGL needs the sampler bound).
- **`compute`**: read `inputs[\`layerMask:${l.id}\`]`, bind it, set the mask
  uniforms per layer.
- **ParamPanel** merge-layers renderer (the `merge_layers` block near
  [ParamPanel.tsx:825](../../src/components/effects/ParamPanel.tsx) /
  [:2026](../../src/components/effects/ParamPanel.tsx)): per layer, a small **mask
  toggle** button; when on, a `luma`/`alpha` source pill + an invert toggle. The
  socket appears/disappears on the node via `resolveInputs`. Purely additive to
  the existing blend-dropdown + opacity-slider row.
- **Back-compat:** new optional `MergeLayer` fields default falsy on old saves
  ⇒ no socket, identical render. No schema bump. Per-layer opacity virtual-key
  keyframing ([conventions.ts](../../src/engine/conventions.ts) `LAYER_OPACITY_PREFIX`)
  is untouched; mask toggle/source aren't keyframed (structural, like blend mode).

---

## Milestones (each ships independently)

1. **Stylize trio** (§1) — three self-contained shaders; lowest risk, immediate
   value. Verify mask + opacity post-passes apply.
2. **Trim Paths** (§2) — `spline-trim.ts` helper + unit-sanity on a closed
   circle / multi-subpath; the chunk into all primitives + Spline Draw; the
   standalone node. The big motion unlock.
3. **Round Corners** (§3) — `roundCorners` helper + node; test on Polygon/Star.
4. **Per-layer matting** (§5) — Matte node first (proves the matte primitive),
   then Merge layer masks (engine + ParamPanel UI).
5. **Text on Path** (§4) — most code; do last. Add the `path` input + Path param
   group to the Text node and the `drawTextBlock` path branch, reusing the
   now-familiar text-raster + spline-sampling stacks. Coordinate with the Text
   Animators work (shared modulated-path gate).

## Registration / back-compat checklist
- New `type` strings: `posterize`, `pixelate`, `chromatic-aberration`,
  `trim-path`, `round-corners`, `matte` — immutable once shipped
  (invariant #2). Register in [index.ts](../../src/nodes/index.ts).
- **Item 4 adds no new node** — it's an additive `path` input + Path param group
  on the existing Text node.
- No new socket types, **no coercion changes**, no NodeEditor validity edits
  (all wires use existing types/coercions).
- No schema bump anywhere — every change is additive params / optional fields.
