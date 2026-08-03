// Spline → standalone SVG serialization for the SVG Export node (spec
// 072726_spline-animation-program.md M2, devlist #176). Engine-side and
// pure — the node stashes what to export; EffectsApp calls this and saves
// through the platform seam.
//
// Mapping matches the rasterizer exactly (buildPath2D in spline-raster.ts):
// normalized [0,1]² Y-DOWN × canvas resolution, with the aspect-correct y
// so a circle authored on a non-square canvas exports round. All subpaths
// join ONE <path> element so even-odd holes work across subpaths, same as
// the app's fill semantics.

import { aspectCorrectY } from "./aspect";
import type { SplineSubpath } from "./types";

export interface SvgStyle {
  stroke?: { color: string; width: number };
  fill?: { color: string; rule: "evenodd" | "nonzero" };
}

// Split a picker hex (#rgb / #rrggbb / #rrggbbaa) into a 6-digit hex + an
// alpha — SVG interop tools (Illustrator, Figma) read fill/stroke-opacity
// attributes far more reliably than 8-digit hex.
function splitHexAlpha(raw: string): { hex: string; alpha: number } {
  const h = (raw ?? "").replace("#", "");
  if (h.length === 3) {
    return {
      hex: `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`,
      alpha: 1,
    };
  }
  if (h.length === 8) {
    return { hex: `#${h.slice(0, 6)}`, alpha: parseInt(h.slice(6, 8), 16) / 255 };
  }
  if (h.length === 6) return { hex: `#${h}`, alpha: 1 };
  return { hex: "#ffffff", alpha: 1 };
}

const fmt = (v: number) => {
  const s = v.toFixed(3);
  // Trim trailing zeros (and a bare trailing dot) — keeps files compact.
  return s.replace(/\.?0+$/, "") || "0";
};

// The `d` attribute for a whole spline (all subpaths, cubic C commands, Z on
// closed subpaths). Exported separately for reuse/tests.
export function splineToSvgPathD(
  subpaths: SplineSubpath[],
  W: number,
  H: number
): string {
  const aspect = W / H;
  const px = (p: [number, number]): [number, number] => [
    p[0] * W,
    aspectCorrectY(p[1], aspect) * H,
  ];
  let d = "";
  for (const sub of subpaths) {
    const anchors = sub.anchors;
    if (anchors.length < 2) continue;
    const first = px(anchors[0].pos);
    d += `${d ? " " : ""}M ${fmt(first[0])} ${fmt(first[1])}`;
    const seg = (
      a: (typeof anchors)[number],
      b: (typeof anchors)[number]
    ) => {
      const cp1 = px(
        a.outHandle
          ? [a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]]
          : a.pos
      );
      const cp2 = px(
        b.inHandle ? [b.pos[0] + b.inHandle[0], b.pos[1] + b.inHandle[1]] : b.pos
      );
      const end = px(b.pos);
      d += ` C ${fmt(cp1[0])} ${fmt(cp1[1])}, ${fmt(cp2[0])} ${fmt(cp2[1])}, ${fmt(end[0])} ${fmt(end[1])}`;
    };
    for (let i = 1; i < anchors.length; i++) seg(anchors[i - 1], anchors[i]);
    if (sub.closed) {
      seg(anchors[anchors.length - 1], anchors[0]);
      d += " Z";
    }
  }
  return d;
}

// A complete standalone SVG document.
export function splineToSvg(
  subpaths: SplineSubpath[],
  W: number,
  H: number,
  style: SvgStyle
): string {
  const d = splineToSvgPathD(subpaths, W, H);
  const attrs: string[] = [];
  if (style.fill) {
    const { hex, alpha } = splitHexAlpha(style.fill.color);
    attrs.push(`fill="${hex}"`);
    if (alpha < 1) attrs.push(`fill-opacity="${fmt(alpha)}"`);
    attrs.push(`fill-rule="${style.fill.rule}"`);
  } else {
    attrs.push(`fill="none"`);
  }
  if (style.stroke) {
    const { hex, alpha } = splitHexAlpha(style.stroke.color);
    attrs.push(`stroke="${hex}"`);
    if (alpha < 1) attrs.push(`stroke-opacity="${fmt(alpha)}"`);
    attrs.push(`stroke-width="${fmt(style.stroke.width)}"`);
    attrs.push(`stroke-linecap="round"`, `stroke-linejoin="round"`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}">\n  <path d="${d}" ${attrs.join(" ")}/>\n</svg>\n`
  );
}
