// The Paint editor's stamp engine (071926_paint-toolkit.md). A stroke is a
// smoothed polyline of pressure-tagged samples; tip bitmaps (brushes.ts) are
// laid along it at `spacing` fractions of the (pressure-scaled) diameter.
//
// Compositing model (Photoshop semantics): paint/erase strokes accumulate
// stamps in a stroke-local SCRATCH canvas at `flow` alpha, and the target is
// re-rendered each live frame as base + scratch at `opacity` (destination-out
// for erase) — so a stroke never exceeds its opacity cap no matter how much
// it self-overlaps, and mid-stroke feedback shows exactly what commit will
// produce. Blur mutates the target directly per stamp (progressive, like the
// Photoshop blur tool). All coordinates are canvas pixels.
//
// Erase strokes on a Paint node with an image wired also MIRROR into the
// input knockout mask (101526_paint-selection-transform.md §1): the same
// scratch stamps composite source-over onto the knockout canvas, so erasing
// removes strokes and hides the input under them in one stroke. Every
// session tracks the bbox it touched, so undo records only that region.
//
// With a selection active (101526 §2), the stroke is CLIPPED to its mask:
// paint/erase composite scratch ∩ mask (so the knockout mirror is clipped
// too), and blur masks each stamp by the selection as well as the tip.

import type { BrushSettingsValue } from "@/engine/types";
import type { PaintSurfaceSnapshot } from "@/state/history";
import { getStamp } from "./brushes";
import { floodRegion } from "./selection";

export type StrokeMode = "paint" | "erase" | "blur";

export interface StrokeConfig {
  mode: StrokeMode;
  color: string; // tip color; ignored for erase/blur (alpha-only tips)
  size: number; // brush diameter, canvas px
  brush: BrushSettingsValue;
  // True for pen pointers — mouse/touch report a constant pressure, so the
  // pressure modulations only engage when real pressure exists.
  pressureCapable: boolean;
  // Erase mode only: the input knockout canvas to mirror the stroke into
  // (alpha added where the stroke erases). Ignored for paint/blur.
  knockout?: HTMLCanvasElement | null;
  // Selection mask to clip the stroke to (alpha = how much paint lands);
  // null/undefined = no selection, the whole canvas is paintable.
  clip?: HTMLCanvasElement | null;
}

export class StrokeSession {
  private readonly target: HTMLCanvasElement;
  private readonly targetCtx: CanvasRenderingContext2D;
  private readonly cfg: StrokeConfig;
  // Pixels as they were at stroke start — the live composite's base layer.
  private readonly base: HTMLCanvasElement;
  // Stamp accumulator for paint/erase.
  private readonly scratch: HTMLCanvasElement | null;
  private readonly scratchCtx: CanvasRenderingContext2D | null;
  // Scratch region for the blur tool's sample→blur→mask cycle.
  private blurTmp: HTMLCanvasElement | null = null;
  // scratch ∩ clip, rebuilt per live frame when a selection is active.
  private clipped: HTMLCanvasElement | null = null;
  // Erase-mirror target + its pixels at stroke start (null when unused).
  private readonly ko: HTMLCanvasElement | null;
  private readonly koCtx: CanvasRenderingContext2D | null;
  private readonly koBase: HTMLCanvasElement | null;
  // Bbox of every pixel this stroke touched (canvas px, unclamped).
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  // Smoothed pointer state + arc-length stamping cursor.
  private sx = 0;
  private sy = 0;
  private sp = 0.5;
  private travelled = 0;
  private nextStampAt = 0;
  private started = false;

  constructor(target: HTMLCanvasElement, cfg: StrokeConfig) {
    this.target = target;
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error("paint: target canvas has no 2d context");
    this.targetCtx = ctx;
    this.cfg = cfg;
    this.base = cloneCanvas(target);
    if (cfg.mode === "blur") {
      this.scratch = null;
      this.scratchCtx = null;
    } else {
      this.scratch = document.createElement("canvas");
      this.scratch.width = target.width;
      this.scratch.height = target.height;
      this.scratchCtx = this.scratch.getContext("2d");
    }
    const ko = cfg.mode === "erase" ? (cfg.knockout ?? null) : null;
    this.ko = ko;
    this.koCtx = ko?.getContext("2d") ?? null;
    this.koBase = ko && this.koCtx ? cloneCanvas(ko) : null;
  }

  // Pre-stroke pixels of every surface this stroke changed, cropped to the
  // touched bbox — the undo entry. Empty when nothing was stamped.
  undoSurfaces(): PaintSurfaceSnapshot[] {
    const w = this.target.width;
    const h = this.target.height;
    const x0 = Math.max(0, Math.floor(this.minX));
    const y0 = Math.max(0, Math.floor(this.minY));
    const x1 = Math.min(w, Math.ceil(this.maxX));
    const y1 = Math.min(h, Math.ceil(this.maxY));
    if (x1 <= x0 || y1 <= y0) return [];
    const crop = (src: HTMLCanvasElement, canvas: HTMLCanvasElement) => {
      const imageData = src
        .getContext("2d")
        ?.getImageData(x0, y0, x1 - x0, y1 - y0);
      return imageData ? [{ canvas, x: x0, y: y0, imageData }] : [];
    };
    return [
      ...crop(this.base, this.target),
      ...(this.ko && this.koBase ? crop(this.koBase, this.ko) : []),
    ];
  }

  private touch(x: number, y: number, w: number, h: number) {
    // 1px pad covers the stamp's antialiased edge.
    this.minX = Math.min(this.minX, x - 1);
    this.minY = Math.min(this.minY, y - 1);
    this.maxX = Math.max(this.maxX, x + w + 1);
    this.maxY = Math.max(this.maxY, y + h + 1);
  }

  down(x: number, y: number, pressure: number) {
    this.sx = x;
    this.sy = y;
    this.sp = pressure;
    this.travelled = 0;
    this.nextStampAt = 0;
    this.started = true;
    // Stamp immediately so a click leaves a dot.
    this.emit(x, y, pressure);
    this.nextStampAt =
      this.travelled + Math.max(1, this.cfg.brush.spacing * this.diameter(pressure));
  }

  move(x: number, y: number, pressure: number) {
    if (!this.started) return;
    // Exponential stabilizer: smoothing 0 follows raw input, 1 lags hard.
    const k = 1 - 0.85 * this.cfg.brush.smoothing;
    this.advance(
      this.sx + (x - this.sx) * k,
      this.sy + (y - this.sy) * k,
      this.sp + (pressure - this.sp) * 0.5
    );
  }

  // Straight segment to an exact point, bypassing the stabilizer — the
  // Shift-click "connect a line from the last stroke" helper. The spacing
  // walk in advance() lays evenly spaced stamps along the whole segment.
  lineTo(x: number, y: number, pressure: number) {
    if (!this.started) return;
    this.advance(x, y, pressure);
  }

  // Where the stroke currently ends (smoothed), canvas px — recorded by the
  // overlay at stroke end as the anchor for the next Shift-click line.
  get position(): [number, number] {
    return [this.sx, this.sy];
  }

  private advance(nx: number, ny: number, np: number) {
    const dx = nx - this.sx;
    const dy = ny - this.sy;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      // Emit stamps at every spacing interval crossed by this segment.
      while (this.nextStampAt <= this.travelled + dist) {
        const t = (this.nextStampAt - this.travelled) / dist;
        const px = this.sx + dx * t;
        const py = this.sy + dy * t;
        const pp = this.sp + (np - this.sp) * t;
        this.emit(px, py, pp);
        this.nextStampAt += Math.max(
          1,
          this.cfg.brush.spacing * this.diameter(pp)
        );
      }
      this.travelled += dist;
    }
    this.sx = nx;
    this.sy = ny;
    this.sp = np;
  }

  // Re-render the target as base + scratch. Called from the overlay's live
  // rAF loop (before it snapshots for the pipeline) and once at end().
  renderLive() {
    if (!this.scratch) return; // blur mutates the target directly
    const stamps = this.clippedScratch(this.scratch);
    const ctx = this.targetCtx;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.target.width, this.target.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.globalAlpha = this.cfg.brush.opacity;
    if (this.cfg.mode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
    }
    ctx.drawImage(stamps, 0, 0);
    ctx.restore();
    const ko = this.ko;
    const kctx = this.koCtx;
    if (ko && kctx && this.koBase) {
      // Knockout = base + the erase stamps ADDED (white tips), at the same
      // opacity, so the input fades exactly as far as the strokes do.
      kctx.save();
      kctx.globalCompositeOperation = "source-over";
      kctx.globalAlpha = 1;
      kctx.clearRect(0, 0, ko.width, ko.height);
      kctx.drawImage(this.koBase, 0, 0);
      kctx.globalAlpha = this.cfg.brush.opacity;
      kctx.drawImage(stamps, 0, 0);
      kctx.restore();
    }
  }

  // The stamp layer as it should land: the scratch itself, or scratch ∩ the
  // selection mask.
  private clippedScratch(scratch: HTMLCanvasElement): HTMLCanvasElement {
    const clip = this.cfg.clip;
    if (!clip) return scratch;
    if (!this.clipped) {
      this.clipped = document.createElement("canvas");
      this.clipped.width = scratch.width;
      this.clipped.height = scratch.height;
    }
    const c = this.clipped;
    const cctx = c.getContext("2d");
    if (!cctx) return scratch;
    cctx.globalCompositeOperation = "source-over";
    cctx.clearRect(0, 0, c.width, c.height);
    cctx.drawImage(scratch, 0, 0);
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(clip, 0, 0, c.width, c.height);
    cctx.globalCompositeOperation = "source-over";
    return c;
  }

  end() {
    this.renderLive();
    this.started = false;
  }

  private diameter(pressure: number): number {
    const { size, brush, pressureCapable } = this.cfg;
    if (!pressureCapable || !brush.pressureSize) return size;
    return size * (0.15 + 0.85 * Math.max(0.05, pressure));
  }

  private alpha(pressure: number): number {
    const { brush, pressureCapable } = this.cfg;
    const p =
      pressureCapable && brush.pressureOpacity
        ? 0.1 + 0.9 * Math.max(0.05, pressure)
        : 1;
    return brush.flow * p;
  }

  private emit(x: number, y: number, pressure: number) {
    const d = this.diameter(pressure);
    if (this.cfg.mode === "blur") {
      this.emitBlur(x, y, d, this.alpha(pressure));
      return;
    }
    const ctx = this.scratchCtx;
    if (!ctx) return;
    // Erase tips are alpha-only; color is irrelevant under destination-out.
    const tint = this.cfg.mode === "erase" ? "#ffffff" : this.cfg.color;
    const stamp = getStamp(d, this.cfg.brush.hardness, tint);
    this.touch(x - d / 2, y - d / 2, d, d);
    ctx.globalAlpha = this.alpha(pressure);
    ctx.drawImage(stamp, x - d / 2, y - d / 2, d, d);
    ctx.globalAlpha = 1;
  }

  // Blur tool: sample the region under the stamp, blur it, mask it by the
  // tip's alpha, and draw it back — a soft local blur that strengthens with
  // repeated passes (per-stamp alpha = flow).
  private emitBlur(x: number, y: number, d: number, alpha: number) {
    const radius = Math.max(1, d * 0.15);
    const pad = Math.ceil(radius * 2);
    const s = Math.ceil(d) + pad * 2;
    if (!this.blurTmp) this.blurTmp = document.createElement("canvas");
    const tmp = this.blurTmp;
    if (tmp.width !== s) tmp.width = s;
    if (tmp.height !== s) tmp.height = s;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    const rx = Math.round(x - s / 2);
    const ry = Math.round(y - s / 2);
    this.touch(rx, ry, s, s);
    tctx.clearRect(0, 0, s, s);
    tctx.filter = `blur(${radius}px)`;
    tctx.drawImage(this.target, rx, ry, s, s, 0, 0, s, s);
    tctx.filter = "none";
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(
      getStamp(d, this.cfg.brush.hardness, "#ffffff"),
      pad,
      pad,
      Math.ceil(d),
      Math.ceil(d)
    );
    const clip = this.cfg.clip;
    if (clip) {
      // Same region of the selection mask, so the blur only lands inside it.
      tctx.drawImage(clip, rx, ry, s, s, 0, 0, s, s);
    }
    tctx.globalCompositeOperation = "source-over";
    this.targetCtx.globalAlpha = alpha;
    this.targetCtx.drawImage(tmp, rx, ry);
    this.targetCtx.globalAlpha = 1;
  }
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")?.drawImage(src, 0, 0);
  return c;
}

// Flood fill with tolerance (0..1, on max RGBA channel distance) — the
// region comes from floodRegion (selection.ts). `sample` is the RGBA the
// region is matched against: by default the canvas itself; the overlay
// passes the COMPOSITE (input + strokes) so a fill follows what you see
// (101526 M4). Matched pixels become the fill color, opaque. Returns false
// when the seed is out of bounds. Alpha participates in matching — filling
// "empty" transparent regions of the paint canvas is the common case.
export function floodFill(
  canvas: HTMLCanvasElement,
  seedX: number,
  seedY: number,
  fillHex: string,
  tolerance: number,
  sample?: ArrayLike<number>
): boolean {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const region = floodRegion(sample ?? px, w, h, seedX, seedY, tolerance, true);
  if (!region) return false;
  const [fr, fg, fb] = hexToRgb255(fillHex);
  for (let o = 0; o < region.length; o++) {
    if (!region[o]) continue;
    const i = o * 4;
    px[i] = fr;
    px[i + 1] = fg;
    px[i + 2] = fb;
    px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

export function hexToRgb255(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const s =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
