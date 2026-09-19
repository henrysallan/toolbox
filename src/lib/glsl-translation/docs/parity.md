---
title: Reaching parity — reading the comparison and fixing what it shows
---

Parity is judged against the frames the plan proposed (`time.frames`).
Keep those frames fixed for the whole loop; changing them between
iterations makes the numbers incomparable.

## The loop

1. `get_shader_errors({nodeId})` — a broken shader renders transparent
   (the plan set `on_error: "transparent"`); no pixel comparison is
   meaningful until this is clean.
2. `compare_renders({a: <target>, b: <glslId>, frames})` when available;
   otherwise `screenshot_strip({nodeId, frames})` on both and compare cell
   by cell. Read the numbers first, the diff image second, the renders
   last.
3. Fix the highest-ranked cause below for the diff SHAPE you see. Tune with
   `set_param(glslId, <channelName>, value)`; change code with
   `set_param(glslId, "expression", …)` (Sync is add-only, tuned channels
   survive).
4. Re-compare. Stop when every frame reads `match`, after 6 comparisons, or
   when two consecutive comparisons fail to move any frame's mean error.
   Then report — what matched, what settled at `close`, what was
   approximated and how.

## Diff shapes and their usual cause, in order

| what the diff looks like | first suspect | fix |
|---|---|---|
| a vertical mirror image of the render | Y flip — canvas01 (Y-down) vs `v_uv` (Y-up) | `1.0 - y` on authored positions, never on `v_uv` itself |
| features stretched or squashed vertically; circles are ellipses | aspect — geometry math done in `v_uv` instead of `p` | `p = vec2(v_uv.x, (v_uv.y-0.5)/u_aspect+0.5)` |
| everything offset by a constant | uv01 vs canvas01 units on an offset (Displace amount, Transform position) | Displace: uv01 on `v_uv`; positions: canvas01 → `p` |
| dark fringes at edges of transparent shapes | premultiplied alpha somewhere | straight in, straight out; over = weighted by source alpha, divided by out alpha |
| flat regions match, gradients band or drift | ramp interpolation space (`interp`/`space` params), sRGB-vs-linear transfer, or a `curve()` seeded with the wrong points | copy the stops via `set_param` on the ramp channel; match the node's space |
| a border strip is wrong | wrap / edge mode on a gather (transparent vs clamp vs mirror) | port `wrapUv` for the node's `wrap` |
| uniform fine speckle everywhere, low mean, high p95 | noise/dither/grain seeds — expected for hashed nodes | not a bug; report `close` |
| soft halo or missing sharpness | tap count of a gather approximation | more taps, or keep that node un-fused |
| one channel off (R, G or B only) | channel selector int (`u_channelX` 0..4) or luma weights | copy the constant; luma is `0.2126, 0.7152, 0.0722` |
| matches at frame 0, diverges later | time: `u_time` seconds vs frames, or a loop idiom (circle offset) | see conventions.md §Time |
| whole image slightly darker/lighter with alpha intact | interior opacity or a `mix(base, effect, mask)` rule missed | conventions.md §Mask |
| identical except in the transparent surround | RGB garbage under alpha 0 — invisible when composited | ignore for parity; the metric already weights by alpha |

## What the numbers mean

`compare_renders` reads both renders back at a small analysis size (256
px long edge, RGBA8) and reports, per frame:

- `meanAbs` — mean |A−B| over RGB (0..1) on pixels where BOTH alphas
  exceed a floor (0.02). This is the convergence signal.
- `alphaMeanAbs` — mean |A.a−B.a| over all pixels, separately. A shape
  that is the right colour in the wrong place shows here first.
- `p95Abs` — 95th percentile of the per-pixel max-channel error; high p95
  with low mean is speckle or a thin edge, not a systematic error.
- `overThreshold` — fraction of compared pixels past `threshold` (default
  0.02 ≈ 5/255).
- `compared` — fraction of pixels that were compared at all. Low means
  most of the frame is transparent on one side; check alpha before colour.
- `worstBox` — `{x0,y0,x1,y1}` in Y-up uv of the worst region, so you can
  name it ("top-left quadrant") without measuring.
- `verdict` — `match` / `close` / `off`. Bands are PROVISIONAL until
  measured on identical nodes: match ⇐ meanAbs ≤ 0.01 ∧ p95 ≤ 0.06 ∧
  alpha ≤ 0.01; close ⇐ meanAbs ≤ 0.03 ∧ p95 ≤ 0.15 ∧ alpha ≤ 0.03. The
  readback floor is 1/255 per channel plus float16 rounding, so `match`
  is not "identical"; a correct translation of a hashed-noise or dithered
  node is expected to settle at `close`, and that is a pass — say so.

The heat column is |A−B| with ×4 gain (black → red → yellow → white);
blue marks alpha mismatch. RGB garbage under alpha 0 is invisible when
composited and is excluded from every metric.
