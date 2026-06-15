// Auto Layout solver — pure CPU, no GL. Functions of (config, child
// measures) → pixel rects, kept side-effect-free so the module stays
// testable when a runner lands (and so nested layouts can re-solve from
// inside an element's measure/render closures without touching state).
//
// Coordinates: all outputs are CANVAS PIXELS, Y-DOWN, relative to the
// container's top-left corner. Pixel-snapped (rounded) for crisp text.

import type { ElementSize, LayoutConstraints, SizeMode } from "./types";

// 1 unit = 1/1000 of min(canvasW, canvasH). Same px count on both axes
// (unlike normalized [0,1] coords), so padding/gap are isotropic on
// non-square canvases, and everything scales when the project resolution
// changes. ≈1 px at 1080p so values read like pixels.
export function unitToPx(
  units: number,
  ctx: { width: number; height: number }
): number {
  return (units * Math.min(ctx.width, ctx.height)) / 1000;
}

export type LayoutDirection = "horizontal" | "vertical";
export type LayoutSpacing = "packed" | "space-between";

// 9-position alignment grid. The main-axis component sets packing
// (start/center/end); the cross-axis component sets per-child alignment.
export const LAYOUT_ALIGN_OPTIONS = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type LayoutAlign = (typeof LAYOUT_ALIGN_OPTIONS)[number];

type AxisAlign = "start" | "center" | "end";

// Split a 9-grid value into horizontal and vertical axis alignments.
export function splitAlign(align: LayoutAlign): {
  x: AxisAlign;
  y: AxisAlign;
} {
  const x: AxisAlign = align.endsWith("left")
    ? "start"
    : align.endsWith("right")
      ? "end"
      : "center";
  const y: AxisAlign = align.startsWith("top")
    ? "start"
    : align.startsWith("bottom")
      ? "end"
      : "center";
  return { x, y };
}

export interface LayoutChildSpec {
  widthMode: SizeMode;
  heightMode: SizeMode;
  // Fixed sizes in px (caller converts units→px before solving).
  width: number;
  height: number;
  measure(constraints: LayoutConstraints): ElementSize;
}

export interface LayoutContainerSpec {
  direction: LayoutDirection;
  align: LayoutAlign;
  spacing: LayoutSpacing;
  // All px (units→px conversion happens at the node boundary).
  gap: number;
  paddingX: number;
  paddingY: number;
  // The container itself sizes fixed-or-hug per axis ("fill" is meaningless
  // at the root of a solve; a nested layout filling its parent arrives here
  // as fixed, forced by the parent's render(w, h) call).
  widthMode: "fixed" | "hug";
  heightMode: "fixed" | "hug";
  width: number; // px, when widthMode is fixed
  height: number; // px, when heightMode is fixed
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  width: number; // container outer size, px
  height: number;
  rects: LayoutRect[]; // one per child, container-relative, Y-DOWN
}

// Figma semantics, resolved in the order the spec locks down:
// widths first then heights (sufficient for horizontal text reflow);
// fill = equal share of leftover on the main axis / inner size on the
// cross axis; fill-in-hug degrades to hug; hug heights re-measure under
// the resolved width (the text-wrap moment).
export function solveLayout(
  container: LayoutContainerSpec,
  children: LayoutChildSpec[]
): LayoutResult {
  const horizontal = container.direction === "horizontal";
  const n = children.length;
  // Space-between ignores the gap param; with n ≤ 1 it falls back to
  // packed (alignment decides placement). Gap only spaces packed runs.
  const spaceBetween = container.spacing === "space-between" && n > 1;
  const gap = spaceBetween ? 0 : Math.max(0, container.gap);
  const padX = Math.max(0, container.paddingX);
  const padY = Math.max(0, container.paddingY);

  // ---- Pass 1: widths --------------------------------------------------
  // A fill child on a hug axis is measured as hug (Figma's degenerate
  // case: the container then hugs the fill total, so they coincide).
  const widths = new Array<number>(n).fill(0);
  const widthIsFill = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const c = children[i];
    const mode: SizeMode =
      c.widthMode === "fill" && container.widthMode === "hug"
        ? "hug"
        : c.widthMode;
    if (mode === "fixed") widths[i] = Math.max(0, c.width);
    else if (mode === "hug") {
      // When this child's height is already fixed, hand it down so an
      // aspect-aware element can return a width proportional to that
      // height ("fixed height + hug width" = ratio-locked). Otherwise an
      // unconstrained measure reports natural width. Heights are resolved
      // in pass 2, so a hug width can't see a hug/fill height here.
      const cons =
        c.heightMode === "fixed" ? { maxHeight: Math.max(0, c.height) } : {};
      widths[i] = Math.max(0, c.measure(cons).width);
    } else widthIsFill[i] = true;
  }

  let innerW: number;
  if (container.widthMode === "fixed") {
    innerW = Math.max(0, container.width - padX * 2);
    if (horizontal) {
      // Distribute the main-axis leftover equally among fill children.
      const fillCount = widthIsFill.filter(Boolean).length;
      if (fillCount > 0) {
        const used =
          widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, n - 1);
        const share = Math.max(0, (innerW - used) / fillCount);
        for (let i = 0; i < n; i++) if (widthIsFill[i]) widths[i] = share;
      }
    } else {
      // Cross axis: fill = the container's inner width.
      for (let i = 0; i < n; i++) if (widthIsFill[i]) widths[i] = innerW;
    }
  } else {
    // Hug: content decides. (Fill children were already demoted to hug.)
    innerW = horizontal
      ? widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, n - 1)
      : widths.reduce((s, w) => Math.max(s, w), 0);
  }

  // ---- Pass 2: heights -------------------------------------------------
  // Hug heights re-measure under the resolved width — this is where a
  // text element wraps.
  const heights = new Array<number>(n).fill(0);
  const heightIsFill = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const c = children[i];
    const mode: SizeMode =
      c.heightMode === "fill" && container.heightMode === "hug"
        ? "hug"
        : c.heightMode;
    if (mode === "fixed") heights[i] = Math.max(0, c.height);
    else if (mode === "hug") {
      heights[i] = Math.max(0, c.measure({ maxWidth: widths[i] }).height);
    } else heightIsFill[i] = true;
  }

  let innerH: number;
  if (container.heightMode === "fixed") {
    innerH = Math.max(0, container.height - padY * 2);
    if (!horizontal) {
      const fillCount = heightIsFill.filter(Boolean).length;
      if (fillCount > 0) {
        const used =
          heights.reduce((s, h) => s + h, 0) + gap * Math.max(0, n - 1);
        const share = Math.max(0, (innerH - used) / fillCount);
        for (let i = 0; i < n; i++) if (heightIsFill[i]) heights[i] = share;
      }
    } else {
      for (let i = 0; i < n; i++) if (heightIsFill[i]) heights[i] = innerH;
    }
  } else {
    innerH = horizontal
      ? heights.reduce((s, h) => Math.max(s, h), 0)
      : heights.reduce((s, h) => s + h, 0) + gap * Math.max(0, n - 1);
  }

  // ---- Pass 3: placement -----------------------------------------------
  const { x: alignX, y: alignY } = splitAlign(container.align);
  const mainSizes = horizontal ? widths : heights;
  const innerMain = horizontal ? innerW : innerH;
  const mainAlign = horizontal ? alignX : alignY;
  const crossAlign = horizontal ? alignY : alignX;

  const contentMain =
    mainSizes.reduce((s, v) => s + v, 0) + gap * Math.max(0, n - 1);
  const leftoverMain = Math.max(0, innerMain - contentMain);

  // Space-between distributes the leftover into n−1 equal slots; packed
  // runs lean on the main-axis alignment for where the run sits.
  const betweenGap = spaceBetween ? leftoverMain / (n - 1) : 0;
  let cursor = spaceBetween
    ? 0
    : mainAlign === "start"
      ? 0
      : mainAlign === "end"
        ? leftoverMain
        : leftoverMain / 2;

  const rects: LayoutRect[] = [];
  for (let i = 0; i < n; i++) {
    const main = cursor;
    const crossSize = horizontal ? heights[i] : widths[i];
    const innerCross = horizontal ? innerH : innerW;
    const cross =
      crossAlign === "start"
        ? 0
        : crossAlign === "end"
          ? innerCross - crossSize
          : (innerCross - crossSize) / 2;
    const x = padX + (horizontal ? main : cross);
    const y = padY + (horizontal ? cross : main);
    // Pixel-snap every rect for crisp text. Snap edges (not size) so
    // adjacent children stay gap-consistent after rounding.
    rects.push({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(widths[i]),
      height: Math.round(heights[i]),
    });
    cursor += mainSizes[i] + gap + betweenGap;
  }

  return {
    width: Math.max(1, Math.round(innerW + padX * 2)),
    height: Math.max(1, Math.round(innerH + padY * 2)),
    rects,
  };
}
