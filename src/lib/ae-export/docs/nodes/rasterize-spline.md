---
title: Rasterize Spline → Fill + Stroke
type: rasterize-spline
class: style
---

A flat fill and stroke are a **Fill** under a **Stroke** on the path. How
the subpaths stack follows toolbox's own draw order:

- `overlap = flatten`: one group, every fill, the strokes on top.
- `overlap = layered`: one group per subpath (path, stroke, fill under it),
  later subpaths on top. AE draws the first group on top, so the groups run
  in reverse.
- `holes` / `fill_holes`: the subpaths group into toolbox's hole islands (an
  outer contour and the contours directly inside it). Each island is a group
  with an even-odd Fill; `fill_holes` fills only the holes. When no contour
  nests in another, hole punching changes nothing and the plain group
  exports. On animated geometry it bakes, because the nesting is read once.
- Both need one path per subpath; geometry composed of Repeaters or nested
  groups bakes instead.

It **bakes** for (the plan and the walk share these rules,
`rasterize-rules.ts`):

- a wired fill image (Image → fill / Image → stroke);
- `thickness_source = vary`, arrow heads, a stroke ramp, a fill ramp by
  subpath;
- a conic gradient fill, `gradient_vary`, or a gradient fill on animated
  geometry.
