import type { SplineSubpath } from "./types";

// Convert a color-picker hex (`#rgb`, `#rrggbb`, or `#rrggbbaa`) into a
// Canvas-2D-compatible `rgba()` string. The `alpha` override applies when
// the hex doesn't already carry one — useful for params that pair a color
// with a separate opacity slider.
export function hexToRgba(hex: string, alpha = 1): string {
  const h = hex.replace("#", "");
  let r = 0, g = 0, b = 0, a = alpha;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else if (h.length === 8) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    a = parseInt(h.slice(6, 8), 16) / 255;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Shared Path2D builder used by any node that rasterizes a spline to a 2D
// canvas (Spline Draw, SVG Source). Each subpath gets its own moveTo; when
// `closeForFill` is true, open subpaths are also closed with a final cubic
// back to their first anchor so the fill region is well-defined. The fill
// rule is the caller's responsibility — "evenodd" is the right default for
// multi-subpath (holes in letters like "O").
export function buildPath2D(
  subpaths: SplineSubpath[],
  W: number,
  H: number,
  closeForFill: boolean
): Path2D | null {
  if (subpaths.length === 0) return null;
  const path = new Path2D();
  const toPx = (p: [number, number]) => [p[0] * W, p[1] * H] as const;
  let any = false;
  for (const sub of subpaths) {
    const anchors = sub.anchors;
    if (anchors.length < 2) continue;
    any = true;
    const first = anchors[0];
    const [fx, fy] = toPx(first.pos);
    path.moveTo(fx, fy);
    for (let i = 1; i < anchors.length; i++) {
      const prev = anchors[i - 1];
      const cur = anchors[i];
      const cp1 = prev.outHandle
        ? toPx([
            prev.pos[0] + prev.outHandle[0],
            prev.pos[1] + prev.outHandle[1],
          ])
        : toPx(prev.pos);
      const cp2 = cur.inHandle
        ? toPx([cur.pos[0] + cur.inHandle[0], cur.pos[1] + cur.inHandle[1]])
        : toPx(cur.pos);
      const [ex, ey] = toPx(cur.pos);
      path.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], ex, ey);
    }
    // Close the subpath when either the data says so or rendering needs it
    // for fill. We draw an explicit cubic rather than relying on closePath's
    // straight-line closure so the configured handles drive the final curve.
    if (sub.closed || closeForFill) {
      const last = anchors[anchors.length - 1];
      const cp1 = last.outHandle
        ? toPx([
            last.pos[0] + last.outHandle[0],
            last.pos[1] + last.outHandle[1],
          ])
        : toPx(last.pos);
      const cp2 = first.inHandle
        ? toPx([
            first.pos[0] + first.inHandle[0],
            first.pos[1] + first.inHandle[1],
          ])
        : toPx(first.pos);
      path.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], fx, fy);
      path.closePath();
    }
  }
  return any ? path : null;
}
