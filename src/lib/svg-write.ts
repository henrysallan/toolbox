// SVG writer for spline subpaths (specdocs/090326_asset-library.md §2).
//
// SVG Source keeps only the PARSED geometry (SvgFileParamValue: subpaths
// normalized into [0,1]², plus the source aspect) — never the file text.
// So an SVG asset is synthesized from the subpaths, which also gives every
// SVG asset one format regardless of where it came from (a fresh pick, a
// project loaded from a save, a pasted path).
//
// The document is built to round-trip through parseSvg exactly:
//   viewBox = 0 0 W H with max(W, H) = USER_SPAN, W/H = aspect.
//   parseSvg contain-fits that box into [0,1]²: scale = 1/USER_SPAN,
//   tx = (1 - W·scale)/2, ty = (1 - H·scale)/2, then p' = p·scale + t.
//   This writer applies the inverse (p = (p' - t)/scale) so anchors land
//   back where they were. Segments emit as parsePathD reads them: `L`
//   when neither side has a handle, else `C` with control points at
//   pos + handle (handles are pos-relative offsets); closed subpaths end
//   in `Z`, with an explicit closing segment only when the closing edge
//   carries handles (a bare `Z` is a straight edge — matches how the
//   parser and buildPath2D treat it).

import type { SplineSubpath } from "@/engine/types";

export const SVG_USER_SPAN = 1000;

// Enough for sub-pixel fidelity at 1000 user units; keeps files small.
const DECIMALS = 3;

function fmt(n: number): string {
  const s = n.toFixed(DECIMALS);
  // "-0.000" → "0", "1.500" → "1.5"
  const t = s.replace(/\.?0+$/, "");
  return t === "-0" || t === "" ? "0" : t;
}

export function svgViewBoxFor(aspect: number): { w: number; h: number } {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return safe >= 1
    ? { w: SVG_USER_SPAN, h: SVG_USER_SPAN / safe }
    : { w: SVG_USER_SPAN * safe, h: SVG_USER_SPAN };
}

// The inverse of parseSvg's contain-fit for a `0 0 w h` viewBox.
export function normalizedToUser(
  aspect: number
): (p: readonly [number, number]) => [number, number] {
  const { w, h } = svgViewBoxFor(aspect);
  const scale = 1 / Math.max(w, h); // = 1 / SVG_USER_SPAN
  const tx = (1 - w * scale) / 2;
  const ty = (1 - h * scale) / 2;
  return (p) => [(p[0] - tx) / scale, (p[1] - ty) / scale];
}

/** One subpath → path data. Empty string for a degenerate (<2 anchors). */
export function pathDataFromSubpath(
  sub: SplineSubpath,
  toUser: (p: readonly [number, number]) => [number, number]
): string {
  const a = sub.anchors;
  if (a.length < 2) return "";
  const parts: string[] = [];
  const [sx, sy] = toUser(a[0].pos);
  parts.push(`M${fmt(sx)} ${fmt(sy)}`);
  const seg = (from: SplineSubpath["anchors"][number], to: SplineSubpath["anchors"][number]) => {
    const [ex, ey] = toUser(to.pos);
    if (!from.outHandle && !to.inHandle) {
      parts.push(`L${fmt(ex)} ${fmt(ey)}`);
      return;
    }
    const [c1x, c1y] = toUser([
      from.pos[0] + (from.outHandle?.[0] ?? 0),
      from.pos[1] + (from.outHandle?.[1] ?? 0),
    ]);
    const [c2x, c2y] = toUser([
      to.pos[0] + (to.inHandle?.[0] ?? 0),
      to.pos[1] + (to.inHandle?.[1] ?? 0),
    ]);
    parts.push(
      `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(ex)} ${fmt(ey)}`
    );
  };
  for (let i = 1; i < a.length; i++) seg(a[i - 1], a[i]);
  if (sub.closed) {
    const last = a[a.length - 1];
    const first = a[0];
    // A curved closing edge needs its own segment; a straight one is what
    // `Z` already draws.
    if (last.outHandle || first.inHandle) seg(last, first);
    parts.push("Z");
  }
  return parts.join(" ");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a standalone SVG document from normalized subpaths. Strokes only
 * (fill none) — the geometry is what's being stored; SVG Source ignores
 * styling anyway.
 */
export function svgFromSubpaths(
  subpaths: SplineSubpath[],
  aspect: number,
  title?: string
): string {
  const { w, h } = svgViewBoxFor(aspect);
  const toUser = normalizedToUser(aspect);
  const paths: string[] = [];
  for (const sub of subpaths) {
    const d = pathDataFromSubpath(sub, toUser);
    if (d) paths.push(`  <path d="${d}"/>`);
  }
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" ` +
    `width="${fmt(w)}" height="${fmt(h)}" fill="none" stroke="#000" stroke-width="2">`;
  const titleEl = title ? `\n  <title>${escapeAttr(title)}</title>` : "";
  return `${head}${titleEl}\n${paths.join("\n")}\n</svg>\n`;
}
