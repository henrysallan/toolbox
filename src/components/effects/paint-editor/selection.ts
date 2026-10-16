// The Paint editor's pixel selection (101526_paint-selection-transform.md
// §2). A selection is one 8-bit MASK canvas at edit-canvas resolution:
// alpha = selectedness (soft edges are real partial selection). An EMPTY
// mask means "no selection" — every tool then acts on the whole canvas
// (Photoshop semantics) — so deselect is just clearing it, and undo only
// ever needs to restore mask pixels.
//
// Masks live in a module-level per-node store for the editor session: they
// survive the overlay remounting (selecting another node and coming back)
// and the paint undo lane can restore them, but they're never saved with
// the project (owner decision 2, 2026-10-15).
//
// The pixel-array helpers at the bottom (alphaBBox, alphaEdges) are pure so
// scripts/check-paint-selection.mts can test them without a DOM.

export type SelectionMode = "new" | "add" | "subtract" | "intersect";

// Integer canvas-px rect; w/h > 0.
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Below this alpha a mask pixel counts as unselected for the ants and the
// bbox (anything partially selected still clips partially).
export const SELECTED_ALPHA = 128;

interface StoreEntry {
  mask: HTMLCanvasElement;
  // The mask as it was at the last Deselect — Reselect (Cmd+Shift+D).
  last: HTMLCanvasElement | null;
}
const store = new Map<string, StoreEntry>();

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Plain (GPU-eligible) contexts: masks are read back once per selection
// change but drawn as a clip source every stroke frame, so they must not be
// pinned to the CPU with willReadFrequently.
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("paint: selection canvas has no 2d context");
  return ctx;
}

// The node's selection mask, created empty at `w`×`h` on first use. A size
// change (canvas resolution changed) rescales the existing mask in place so
// the selection keeps covering the same picture area.
export function selectionMask(
  nodeId: string,
  w: number,
  h: number
): HTMLCanvasElement {
  let entry = store.get(nodeId);
  if (!entry) {
    entry = { mask: newCanvas(w, h), last: null };
    store.set(nodeId, entry);
  }
  const m = entry.mask;
  if (m.width !== w || m.height !== h) {
    const tmp = newCanvas(m.width, m.height);
    ctx2d(tmp).drawImage(m, 0, 0);
    m.width = w;
    m.height = h;
    ctx2d(m).drawImage(tmp, 0, 0, w, h);
    entry.last = null;
  }
  return m;
}

// The node's mask if one was ever created — no allocation (a Paint node
// you only look at shouldn't cost a canvas-res mask).
export function peekSelectionMask(nodeId: string): HTMLCanvasElement | null {
  return store.get(nodeId)?.mask ?? null;
}

// Snapshot of the mask before Deselect, so Reselect can bring it back.
export function rememberForReselect(nodeId: string) {
  const entry = store.get(nodeId);
  if (!entry) return;
  const { mask } = entry;
  const last = entry.last ?? newCanvas(mask.width, mask.height);
  last.width = mask.width;
  last.height = mask.height;
  const lctx = ctx2d(last);
  lctx.clearRect(0, 0, last.width, last.height);
  lctx.drawImage(mask, 0, 0);
  entry.last = last;
}

export function reselectSource(nodeId: string): HTMLCanvasElement | null {
  return store.get(nodeId)?.last ?? null;
}

// Bbox of the selected pixels (alpha ≥ SELECTED_ALPHA), or null = empty
// mask = no selection. A full-mask readback — run once per selection change,
// never per frame.
export function maskBBox(mask: HTMLCanvasElement): PxRect | null {
  const { width: w, height: h } = mask;
  if (w === 0 || h === 0) return null;
  const data = ctx2d(mask).getImageData(0, 0, w, h).data;
  return alphaBBox(data, w, h);
}

// Edge segments of the selected region inside `bbox` (canvas px), for the
// marching ants. See alphaEdges.
export function maskEdges(mask: HTMLCanvasElement, bbox: PxRect): Int32Array {
  // One pixel of margin so edges on the bbox boundary are found.
  const x0 = Math.max(0, bbox.x - 1);
  const y0 = Math.max(0, bbox.y - 1);
  const x1 = Math.min(mask.width, bbox.x + bbox.w + 1);
  const y1 = Math.min(mask.height, bbox.y + bbox.h + 1);
  const data = ctx2d(mask).getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const local = alphaEdges(data, x1 - x0, y1 - y0);
  for (let i = 0; i < local.length; i += 4) {
    local[i] += x0;
    local[i + 1] += y0;
    local[i + 2] += x0;
    local[i + 3] += y0;
  }
  return local;
}

// Combine a shape into the mask. `draw` paints the shape (opaque white) on a
// cleared full-size scratch canvas; the scratch then composites onto the
// mask per `mode`. Going through a full-canvas scratch keeps every mode
// well-defined everywhere (intersect clears outside the shape too).
export function combineIntoMask(
  mask: HTMLCanvasElement,
  draw: (ctx: CanvasRenderingContext2D) => void,
  mode: SelectionMode
) {
  const shape = newCanvas(mask.width, mask.height);
  const sctx = ctx2d(shape);
  sctx.fillStyle = "#ffffff";
  sctx.strokeStyle = "#ffffff";
  draw(sctx);
  const mctx = ctx2d(mask);
  mctx.save();
  if (mode === "new") mctx.clearRect(0, 0, mask.width, mask.height);
  mctx.globalCompositeOperation =
    mode === "subtract"
      ? "destination-out"
      : mode === "intersect"
        ? "destination-in"
        : "source-over";
  mctx.drawImage(shape, 0, 0);
  mctx.restore();
}

export function fillMask(mask: HTMLCanvasElement) {
  const mctx = ctx2d(mask);
  mctx.save();
  mctx.globalCompositeOperation = "source-over";
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, mask.width, mask.height);
  mctx.restore();
}

export function clearMask(mask: HTMLCanvasElement) {
  ctx2d(mask).clearRect(0, 0, mask.width, mask.height);
}

// Replace the mask's pixels with `src`'s (Reselect).
export function copyMask(mask: HTMLCanvasElement, src: HTMLCanvasElement) {
  const mctx = ctx2d(mask);
  mctx.clearRect(0, 0, mask.width, mask.height);
  mctx.drawImage(src, 0, 0, mask.width, mask.height);
}

// Select Inverse: alpha → 1 − alpha.
export function invertMask(mask: HTMLCanvasElement) {
  const inv = newCanvas(mask.width, mask.height);
  const ictx = ctx2d(inv);
  ictx.fillStyle = "#ffffff";
  ictx.fillRect(0, 0, inv.width, inv.height);
  ictx.globalCompositeOperation = "destination-out";
  ictx.drawImage(mask, 0, 0);
  const mctx = ctx2d(mask);
  mctx.clearRect(0, 0, mask.width, mask.height);
  mctx.drawImage(inv, 0, 0);
}

// Clip a whole-canvas edit to the selection: keep `target` (already edited)
// only inside the mask and restore `before`'s pixels outside it —
// out = before·(1 − m) + edited·m, blended in premultiplied space via
// "lighter" so soft mask edges cross-fade instead of punching holes.
export function restoreOutsideSelection(
  target: HTMLCanvasElement,
  before: HTMLCanvasElement,
  mask: HTMLCanvasElement
) {
  const edited = newCanvas(target.width, target.height);
  const ectx = ctx2d(edited);
  ectx.drawImage(target, 0, 0);
  ectx.globalCompositeOperation = "destination-in";
  ectx.drawImage(mask, 0, 0);
  const tctx = ctx2d(target);
  tctx.save();
  tctx.globalCompositeOperation = "source-over";
  tctx.clearRect(0, 0, target.width, target.height);
  tctx.drawImage(before, 0, 0);
  tctx.globalCompositeOperation = "destination-out";
  tctx.drawImage(mask, 0, 0);
  tctx.globalCompositeOperation = "lighter";
  tctx.drawImage(edited, 0, 0);
  tctx.restore();
}

// Delete inside the selection: remove the edit layer's pixels there and,
// when given, hide the input there too (knockout += mask).
export function eraseSelection(
  edit: HTMLCanvasElement,
  knockout: HTMLCanvasElement | null,
  mask: HTMLCanvasElement
) {
  const ectx = ctx2d(edit);
  ectx.save();
  ectx.globalCompositeOperation = "destination-out";
  ectx.drawImage(mask, 0, 0);
  ectx.restore();
  if (knockout) {
    const kctx = ctx2d(knockout);
    kctx.save();
    kctx.globalCompositeOperation = "source-over";
    kctx.drawImage(mask, 0, 0);
    kctx.restore();
  }
}

// Fill the selection (or, with no mask, the whole canvas) with a color,
// source-over the existing pixels — Photoshop's Alt+Backspace.
export function fillSelection(
  edit: HTMLCanvasElement,
  mask: HTMLCanvasElement | null,
  color: string
) {
  const tint = newCanvas(edit.width, edit.height);
  const tctx = ctx2d(tint);
  if (mask) {
    tctx.drawImage(mask, 0, 0);
    tctx.globalCompositeOperation = "source-in";
  }
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, tint.width, tint.height);
  const ectx = ctx2d(edit);
  ectx.save();
  ectx.globalCompositeOperation = "source-over";
  ectx.drawImage(tint, 0, 0);
  ectx.restore();
}

// ── Lasso / wand / modify (M4), canvas side ──────────────────────────

// Combine a closed polygon (canvas px) into the mask — the lassos.
export function combinePolygon(
  mask: HTMLCanvasElement,
  pts: [number, number][],
  mode: SelectionMode
) {
  combineIntoMask(
    mask,
    (ctx) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fill();
    },
    mode
  );
}

// Combine a pixel region (1 = in, w×h = the mask size) into the mask — the
// magic wand. `antiAlias` softens the staircase edge (regionAlpha).
export function combineRegion(
  mask: HTMLCanvasElement,
  region: Uint8Array,
  antiAlias: boolean,
  mode: SelectionMode
) {
  const { width: w, height: h } = mask;
  const alpha = regionAlpha(region, w, h, antiAlias);
  const img = new ImageData(w, h);
  for (let i = 0; i < alpha.length; i++) {
    if (!alpha[i]) continue;
    const o = i * 4;
    img.data[o] = 255;
    img.data[o + 1] = 255;
    img.data[o + 2] = 255;
    img.data[o + 3] = alpha[i];
  }
  const tmp = newCanvas(w, h);
  ctx2d(tmp).putImageData(img, 0, 0);
  combineIntoMask(mask, (ctx) => ctx.drawImage(tmp, 0, 0), mode);
}

// Feather: Gaussian-soften the mask's edge. `radius` px ≈ 2σ, so the
// visible falloff spans about the radius on each side.
export function featherMask(mask: HTMLCanvasElement, radius: number) {
  if (!(radius > 0)) return;
  const tmp = newCanvas(mask.width, mask.height);
  ctx2d(tmp).drawImage(mask, 0, 0);
  const mctx = ctx2d(mask);
  mctx.save();
  mctx.clearRect(0, 0, mask.width, mask.height);
  mctx.filter = `blur(${radius / 2}px)`;
  mctx.drawImage(tmp, 0, 0);
  mctx.restore();
}

// Expand (r > 0) / Contract (r < 0) by |r| px — exact Euclidean (growAlpha)
// over `bbox` padded by |r| + 2, the only pixels that can change.
export function growMask(mask: HTMLCanvasElement, r: number, bbox: PxRect) {
  if (r === 0) return;
  const pad = Math.ceil(Math.abs(r)) + 2;
  const x = Math.max(0, bbox.x - pad);
  const y = Math.max(0, bbox.y - pad);
  const w = Math.min(mask.width, bbox.x + bbox.w + pad) - x;
  const h = Math.min(mask.height, bbox.y + bbox.h + pad) - y;
  if (w <= 0 || h <= 0) return;
  const mctx = ctx2d(mask);
  const img = mctx.getImageData(x, y, w, h);
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
  const out = growAlpha(alpha, w, h, r);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    img.data[o] = 255;
    img.data[o + 1] = 255;
    img.data[o + 2] = 255;
    img.data[o + 3] = out[i];
  }
  mctx.putImageData(img, x, y);
}

// Select the painted pixels: the mask becomes the edit layer's alpha.
export function selectPainted(mask: HTMLCanvasElement, edit: HTMLCanvasElement) {
  const mctx = ctx2d(mask);
  mctx.save();
  mctx.globalCompositeOperation = "source-over";
  mctx.clearRect(0, 0, mask.width, mask.height);
  mctx.drawImage(edit, 0, 0, mask.width, mask.height);
  mctx.globalCompositeOperation = "source-in";
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, mask.width, mask.height);
  mctx.restore();
}

// ── Marquee geometry ─────────────────────────────────────────────────

// The marquee rect from the press point to the cursor (canvas px).
// `square` locks 1:1 on the dominant axis; `fromCenter` grows it
// symmetrically about the press point. Snapped outward to whole pixels and
// clipped to the canvas — null when nothing of it is on the canvas.
export function marqueeRect(
  start: [number, number],
  cur: [number, number],
  opts: { square: boolean; fromCenter: boolean; width: number; height: number }
): PxRect | null {
  let dx = cur[0] - start[0];
  let dy = cur[1] - start[1];
  if (opts.square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  let ax = start[0];
  let ay = start[1];
  const bx = start[0] + dx;
  const by = start[1] + dy;
  if (opts.fromCenter) {
    ax = start[0] - dx;
    ay = start[1] - dy;
  }
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)));
  const x1 = Math.min(opts.width, Math.ceil(Math.max(ax, bx)));
  const y1 = Math.min(opts.height, Math.ceil(Math.max(ay, by)));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: PxRect | null, b: PxRect | null): PxRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

// ── Pure pixel-array helpers (DOM-free; check-paint-selection.mts) ───

// Bbox of pixels with alpha ≥ SELECTED_ALPHA in RGBA `data` (w×h), or null.
export function alphaBBox(
  data: ArrayLike<number>,
  w: number,
  h: number
): PxRect | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4 + 3;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4] >= SELECTED_ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Pixel-boundary edges of the selected region (alpha ≥ SELECTED_ALPHA) in
// RGBA `data` (w×h): every unit edge between a selected and an unselected
// pixel (or the data border), merged into maximal horizontal / vertical
// runs. Returned flat as [x1, y1, x2, y2, …] in pixel-corner coordinates —
// the staircase outline Photoshop's ants follow. Runs aren't chained into
// loops: the ants draw each run as its own dashed segment.
export function alphaEdges(
  data: ArrayLike<number>,
  w: number,
  h: number
): Int32Array {
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= SELECTED_ALPHA;
  const out: number[] = [];
  // Horizontal edges on row boundary y (between rows y−1 and y).
  for (let y = 0; y <= h; y++) {
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && inside(x, y - 1) !== inside(x, y);
      if (edge && runStart < 0) runStart = x;
      else if (!edge && runStart >= 0) {
        out.push(runStart, y, x, y);
        runStart = -1;
      }
    }
  }
  // Vertical edges on column boundary x (between columns x−1 and x).
  for (let x = 0; x <= w; x++) {
    let runStart = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && inside(x - 1, y) !== inside(x, y);
      if (edge && runStart < 0) runStart = y;
      else if (!edge && runStart >= 0) {
        out.push(x, runStart, x, y);
        runStart = -1;
      }
    }
  }
  return Int32Array.from(out);
}

// The region a seed pixel's color reaches, matched within `tolerance`
// (0..1, max RGBA channel distance; alpha participates) against `data`
// (RGBA, w×h): with `contiguous`, the 4-connected run around the seed
// (scanline fill); without, every matching pixel anywhere. 1 = in region.
// Null when the seed is off the data. Shared by Fill and the magic wand.
export function floodRegion(
  data: ArrayLike<number>,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  tolerance: number,
  contiguous: boolean
): Uint8Array | null {
  const x0 = Math.floor(seedX);
  const y0 = Math.floor(seedY);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return null;
  const s = (y0 * w + x0) * 4;
  const sr = data[s];
  const sg = data[s + 1];
  const sb = data[s + 2];
  const sa = data[s + 3];
  const tol = Math.max(0, Math.min(1, tolerance)) * 255;
  const matches = (o: number) => {
    const i = o * 4;
    return (
      Math.abs(data[i] - sr) <= tol &&
      Math.abs(data[i + 1] - sg) <= tol &&
      Math.abs(data[i + 2] - sb) <= tol &&
      Math.abs(data[i + 3] - sa) <= tol
    );
  };
  const region = new Uint8Array(w * h);
  if (!contiguous) {
    for (let o = 0; o < region.length; o++) if (matches(o)) region[o] = 1;
    return region;
  }
  const stack: number[] = [y0 * w + x0];
  while (stack.length) {
    const at = stack.pop()!;
    const y = Math.floor(at / w);
    // Walk to the left edge of this run.
    let x = at % w;
    while (x > 0 && !region[y * w + x - 1] && matches(y * w + x - 1)) x--;
    let spanUp = false;
    let spanDown = false;
    // Take the run rightward, seeding the rows above/below at match edges.
    while (x < w) {
      const o = y * w + x;
      if (region[o] || !matches(o)) break;
      region[o] = 1;
      if (y > 0) {
        const up = o - w;
        const m = !region[up] && matches(up);
        if (m && !spanUp) {
          stack.push(up);
          spanUp = true;
        } else if (!m) spanUp = false;
      }
      if (y < h - 1) {
        const down = o + w;
        const m = !region[down] && matches(down);
        if (m && !spanDown) {
          stack.push(down);
          spanDown = true;
        } else if (!m) spanDown = false;
      }
      x++;
    }
  }
  return region;
}

// ── Selection modify (M4), pure ──────────────────────────────────────

const FAR = 1e20;

// 1D squared distance transform of the sampled function f (Felzenszwalb &
// Huttenlocher), written into d. v / z are scratch of length n / n + 1.
function dt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array
) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s =
      (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Exact Euclidean distance (px) from every pixel to the nearest pixel with
// set[i] = 1 (0 on set pixels; huge where the set is empty).
export function distanceToSet(set: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = set[i] ? 0 : FAR;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

// Grow (r > 0) or shrink (r < 0) the selected region (alpha ≥ 50%) by |r|
// px, exactly (Euclidean), with a 1 px antialiased edge. `alpha` is one
// byte per pixel; returns a new array.
export function growAlpha(
  alpha: Uint8Array,
  w: number,
  h: number,
  r: number
): Uint8Array {
  const out = new Uint8Array(w * h);
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < inside.length; i++) {
    inside[i] = alpha[i] >= SELECTED_ALPHA ? 1 : 0;
  }
  if (r >= 0) {
    const d = distanceToSet(inside, w, h);
    for (let i = 0; i < out.length; i++) {
      out[i] = inside[i]
        ? 255
        : Math.round(Math.max(0, Math.min(1, r + 1 - d[i])) * 255);
    }
  } else {
    const outside = new Uint8Array(w * h);
    for (let i = 0; i < outside.length; i++) outside[i] = inside[i] ? 0 : 1;
    const d = distanceToSet(outside, w, h);
    const k = -r;
    for (let i = 0; i < out.length; i++) {
      out[i] = inside[i]
        ? Math.round(Math.max(0, Math.min(1, d[i] - k)) * 255)
        : 0;
    }
  }
  return out;
}

// Polygonal lasso Shift: the segment from `from` toward `to`, snapped to
// the nearest 45° direction, its length the cursor's projection onto it.
export function snap45(
  from: [number, number],
  to: [number, number]
): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = dx * Math.cos(a) + dy * Math.sin(a);
  return [from[0] + len * Math.cos(a), from[1] + len * Math.sin(a)];
}

// Canvas-px bbox of a polygon, snapped outward and clamped (null off-canvas
// or degenerate).
export function pointsBBox(
  pts: [number, number][],
  w: number,
  h: number
): PxRect | null {
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(w, Math.ceil(maxX));
  const y1 = Math.min(h, Math.ceil(maxY));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// A wand region (1 = in) as mask alpha. With `antiAlias`, each pixel takes
// its 3×3 neighbourhood's coverage, but only where that neighbourhood is
// mixed — so the interior stays solid, the edge goes soft on both sides,
// and the 50% boundary (the ants, the bbox) stays exactly where the hard
// edge was: in-region pixels are clamped to ≥ 56%, out-of-region ones to
// ≤ 44%.
export function regionAlpha(
  region: Uint8Array,
  w: number,
  h: number,
  antiAlias: boolean
): Uint8Array {
  const out = new Uint8Array(w * h);
  if (!antiAlias) {
    for (let i = 0; i < out.length; i++) out[i] = region[i] ? 255 : 0;
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          // Off the data counts as the pixel's own state (no fake edge).
          n +=
            xx < 0 || yy < 0 || xx >= w || yy >= h
              ? region[y * w + x]
              : region[yy * w + xx];
        }
      }
      const i = y * w + x;
      out[i] =
        n === 0 ? 0 : n === 9 ? 255 : region[i]
          ? Math.max(Math.round((n / 9) * 255), 143)
          : Math.min(Math.round((n / 9) * 255), 113);
    }
  }
  return out;
}
