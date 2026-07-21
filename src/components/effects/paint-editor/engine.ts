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

import type { BrushSettingsValue } from "@/engine/types";
import { getStamp } from "./brushes";

export type StrokeMode = "paint" | "erase" | "blur";

export interface StrokeConfig {
  mode: StrokeMode;
  color: string; // tip color; ignored for erase/blur (alpha-only tips)
  size: number; // brush diameter, canvas px
  brush: BrushSettingsValue;
  // True for pen pointers — mouse/touch report a constant pressure, so the
  // pressure modulations only engage when real pressure exists.
  pressureCapable: boolean;
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
    const nx = this.sx + (x - this.sx) * k;
    const ny = this.sy + (y - this.sy) * k;
    const np = this.sp + (pressure - this.sp) * 0.5;
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
    ctx.drawImage(this.scratch, 0, 0);
    ctx.restore();
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

// Contiguous scanline flood fill with tolerance (0..1, on max RGBA channel
// distance). Returns false when the seed is out of bounds. Alpha
// participates in matching — filling "empty" transparent regions of the
// paint canvas is the common case.
export function floodFill(
  canvas: HTMLCanvasElement,
  seedX: number,
  seedY: number,
  fillHex: string,
  tolerance: number
): boolean {
  const w = canvas.width;
  const h = canvas.height;
  const x0 = Math.floor(seedX);
  const y0 = Math.floor(seedY);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  const [fr, fg, fb] = hexToRgb255(fillHex);
  const seedIdx = (y0 * w + x0) * 4;
  const sr = px[seedIdx];
  const sg = px[seedIdx + 1];
  const sb = px[seedIdx + 2];
  const sa = px[seedIdx + 3];
  // Seed already the fill color → nothing to do (also prevents the visited
  // test below from looping forever, since filled pixels would still match).
  if (sr === fr && sg === fg && sb === fb && sa === 255) return true;

  const tol = Math.max(0, Math.min(1, tolerance)) * 255;
  const matches = (i: number) =>
    Math.abs(px[i] - sr) <= tol &&
    Math.abs(px[i + 1] - sg) <= tol &&
    Math.abs(px[i + 2] - sb) <= tol &&
    Math.abs(px[i + 3] - sa) <= tol;
  const visited = new Uint8Array(w * h);
  const stack: number[] = [y0 * w + x0];

  while (stack.length) {
    const at = stack.pop()!;
    const y = Math.floor(at / w);
    // Walk to the left edge of this run.
    let x = at % w;
    while (x > 0 && !visited[y * w + x - 1] && matches((y * w + x - 1) * 4)) {
      x--;
    }
    let spanUp = false;
    let spanDown = false;
    // Fill the run rightward, seeding the rows above/below at match edges.
    while (x < w) {
      const o = y * w + x;
      if (visited[o] || !matches(o * 4)) break;
      visited[o] = 1;
      const i = o * 4;
      px[i] = fr;
      px[i + 1] = fg;
      px[i + 2] = fb;
      px[i + 3] = 255;
      if (y > 0) {
        const up = o - w;
        const m = !visited[up] && matches(up * 4);
        if (m && !spanUp) {
          stack.push(up);
          spanUp = true;
        } else if (!m) {
          spanUp = false;
        }
      }
      if (y < h - 1) {
        const down = o + w;
        const m = !visited[down] && matches(down * 4);
        if (m && !spanDown) {
          stack.push(down);
          spanDown = true;
        } else if (!m) {
          spanDown = false;
        }
      }
      x++;
    }
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
