// Floating selections + the pixel clipboard for the Paint editor
// (101526_paint-selection-transform.md §4, M2).
//
// A FLOATING selection is pixels lifted off the canvas (or pasted in) that
// ride above it until committed: `source` holds them at their native
// resolution, `mask` their selectedness (both the same size, straight
// alpha), and `matrix` places them on the canvas (source px → canvas px).
// M2 only translates (plus a fit-scale for big pastes); M3's free transform
// edits the same matrix, so repeated transforms never resample more than
// once — the source is only drawn through the matrix at display/commit.
//
// While floating, the edit canvas is re-rendered as `base` (the edit layer
// with the lift's hole already cut) + the floating drawn through its matrix,
// so the pipeline shows the move live. Committing is then just keeping that
// render; cancelling restores the pre-lift copies.

import type { PxRect } from "./selection";

// 2D affine, canvas convention: [a, b, c, d, e, f] maps (x, y) →
// (a·x + c·y + e, b·x + d·y + f) — the same order as ctx.setTransform.
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function translation(tx: number, ty: number): Affine {
  return [1, 0, 0, 1, tx, ty];
}

// a ∘ b: apply b first, then a.
export function compose(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Canvas-px bbox of a w×h source drawn through `m`, snapped outward and
// clipped to the canvas (null when entirely off it).
export function affineBounds(
  m: Affine,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number
): PxRect | null {
  const pts = [
    applyAffine(m, 0, 0),
    applyAffine(m, w, 0),
    applyAffine(m, 0, h),
    applyAffine(m, w, h),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(canvasW, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(canvasH, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Placement for pasting a w×h image onto a W×H canvas: centered, scaled
// down (never up) to fit.
export function fitCentered(w: number, h: number, W: number, H: number): Affine {
  const s = Math.min(1, W / w, H / h);
  return [s, 0, 0, s, (W - w * s) / 2, (H - h * s) / 2];
}

export interface Floating {
  source: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  matrix: Affine;
  // The selected bbox inside `source` (source px) — what the transform
  // handles frame; the source carries a small transparent pad around it.
  content: PxRect;
  // The edit layer under the float (the hole already cut, when lifted).
  base: HTMLCanvasElement;
  // Pre-float copies for cancel and the undo entry. `knockout` / `selection`
  // are null when that surface didn't exist yet.
  before: {
    edit: HTMLCanvasElement;
    knockout: HTMLCanvasElement | null;
    selection: HTMLCanvasElement | null;
  };
  // The canvas region the float has touched so far (original selection ∪
  // every placement) — the undo crop.
  touched: PxRect | null;
  // Pixel-edge runs of `mask` in SOURCE px (computed once; the overlay maps
  // them through the matrix for the ants).
  edges: Int32Array;
}

export function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("paint: canvas has no 2d context");
  return ctx;
}

export function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = newCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

// The composite under a selection, cropped to `bbox`: over(edit, input ×
// (1 − knockout)) then × the selection mask — what you SEE there, which is
// what a lift or copy picks up ("sample all layers"). `input` is the wired
// image's straight-alpha pixels for exactly `bbox` (null when unwired).
// Returns bbox-sized { source, mask }.
export function compositeUnderSelection(
  edit: HTMLCanvasElement,
  knockout: HTMLCanvasElement | null,
  input: Uint8ClampedArray<ArrayBuffer> | null,
  selection: HTMLCanvasElement,
  bbox: PxRect
): { source: HTMLCanvasElement; mask: HTMLCanvasElement } {
  const { x, y, w, h } = bbox;
  const source = newCanvas(w, h);
  const sctx = ctx2d(source);
  if (input) {
    sctx.putImageData(new ImageData(input, w, h), 0, 0);
    if (knockout) {
      sctx.globalCompositeOperation = "destination-out";
      sctx.drawImage(knockout, x, y, w, h, 0, 0, w, h);
    }
  }
  sctx.globalCompositeOperation = "source-over";
  sctx.drawImage(edit, x, y, w, h, 0, 0, w, h);
  const mask = newCanvas(w, h);
  ctx2d(mask).drawImage(selection, x, y, w, h, 0, 0, w, h);
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(mask, 0, 0);
  sctx.globalCompositeOperation = "source-over";
  return { source, mask };
}

// Draw `src` (source px) onto `ctx` through `m`, high-quality resampling.
export function drawThrough(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  m: Affine
) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}

// Re-render the edit canvas as base + the floating pixels.
export function renderFloating(edit: HTMLCanvasElement, f: Floating) {
  const ctx = ctx2d(edit);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, edit.width, edit.height);
  ctx.drawImage(f.base, 0, 0);
  ctx.restore();
  drawThrough(ctx, f.source, f.matrix);
}

// Alt-drag while floating: stamp a copy of the float into the base at its
// current placement, so the drag carries on with a duplicate.
export function stampIntoBase(f: Floating) {
  drawThrough(ctx2d(f.base), f.source, f.matrix);
}

// Write the float's mask into the selection canvas at its placement (the
// selection follows the pixels on commit).
export function placeMask(selection: HTMLCanvasElement, f: Floating) {
  const ctx = ctx2d(selection);
  ctx.clearRect(0, 0, selection.width, selection.height);
  drawThrough(ctx, f.mask, f.matrix);
}

// Restore a surface from its pre-float copy.
export function restoreFrom(target: HTMLCanvasElement, copy: HTMLCanvasElement) {
  const ctx = ctx2d(target);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(copy, 0, 0);
  ctx.restore();
}

// ── Pixel clipboard (module-level, shared across Paint nodes) ────────

export interface PixelClip {
  source: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  // Selected bbox inside `source` (see Floating.content).
  content: PxRect;
  // Where it sat when copied (source px → canvas px) — "paste in place"
  // restores exactly that placement, scale included.
  matrix: Affine;
}

let clip: PixelClip | null = null;

export function setPixelClip(c: PixelClip) {
  clip = c;
}

export function getPixelClip(): PixelClip | null {
  return clip;
}

// Best-effort mirror to the OS clipboard as PNG (paste into Figma /
// Photoshop). The blob is passed as a promise so the write starts inside the
// key gesture even though the pixels may still be on their way (a lift's
// input readback). Silently does nothing where the async clipboard isn't
// available or is denied.
export function writeOsClipboard(pixels: Promise<HTMLCanvasElement | null>) {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      return;
    }
    const blob = pixels.then(
      (c) =>
        new Promise<Blob>((resolve, reject) => {
          if (!c) return reject(new Error("nothing to copy"));
          c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png");
        })
    );
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": blob })])
      .catch(() => {});
  } catch {
    // Clipboard API unavailable — the internal clipboard still works.
  }
}
