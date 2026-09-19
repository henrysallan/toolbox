// Viewport rulers + guides (specdocs/091726_viewport-rulers.md) — the pure
// half. No DOM, no React: the ruler overlay, the gizmo snap paths and the
// persistence gate all ride these helpers, and scripts/check-viewport-
// guides.mts exercises them offline.
//
// A guide is one full-viewport line over the preview canvas, dragged out of
// the top or side ruler the way Photoshop / After Effects do it. `axis: "x"`
// is a VERTICAL line at x = pos·W; `axis: "y"` a HORIZONTAL line at
// y = pos·H. `pos` is a fraction of the canvas in SCREEN space — Y-down,
// no aspect correction — so a guide at 0.5 is the canvas centre on any
// resolution and guides ride a Project Settings resolution change the way
// every normalized coordinate in the engine does. The rulers READ OUT in
// project pixels (pos·W / pos·H); the fraction is the stored truth. Guides
// may sit outside [0,1] (off-canvas alignment is legitimate); dropping one
// back onto a ruler is what deletes it.
//
// Consumers whose drag space is authored [0,1]² with aspect-corrected Y
// (TransformGizmo) convert a `y` guide through aspectUncorrectY before
// comparing; consumers in plain screen-normalized UV (PrimitiveGizmo, the
// spline editor's px-space snap service) use `pos` directly.

export interface ViewportGuide {
  axis: "x" | "y";
  pos: number;
}

// Persistence gate for SavedProject.viewportGuides — the blob is untrusted
// (a hand-edited .toolbox, a newer/older build, a truncated cloud row).
// Anything not shaped like a guide is dropped; non-finite positions too.
// Exact duplicates collapse (two guides on one line are one guide).
export function fromSavedViewportGuides(v: unknown): ViewportGuide[] {
  if (!Array.isArray(v)) return [];
  const out: ViewportGuide[] = [];
  const seen = new Set<string>();
  for (const g of v) {
    if (g == null || typeof g !== "object") continue;
    const { axis, pos } = g as Record<string, unknown>;
    if (axis !== "x" && axis !== "y") continue;
    if (typeof pos !== "number" || !Number.isFinite(pos)) continue;
    const key = `${axis}:${pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ axis, pos });
  }
  return out;
}

// Positions of the guides on one axis — the snap-line candidates a consumer
// feeds to snapValueToLines / snapSpanToLines (after any space conversion).
export function guideLinesOn(
  guides: readonly ViewportGuide[],
  axis: "x" | "y"
): number[] {
  const out: number[] = [];
  for (const g of guides) if (g.axis === axis) out.push(g.pos);
  return out;
}

export interface LineSnap {
  // Add to the dragged value / span so the winning edge lands on the line.
  delta: number;
  // The line's coordinate (where an indicator should be drawn).
  at: number;
}

// Nearest line within `threshold` of a single coordinate (a point, an
// anchor, a handle). Null = nothing close enough; the value passes through.
export function snapValueToLines(
  v: number,
  lines: readonly number[],
  threshold: number
): LineSnap | null {
  let best: LineSnap | null = null;
  for (const at of lines) {
    const delta = at - v;
    if (Math.abs(delta) > threshold) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at };
  }
  return best;
}

// Nearest line to ANY of a span's min / centre / max — a box's two edges and
// its middle compete and the smallest correction wins, so a box near a line
// snaps whichever of its features is closest (Photoshop's rule) rather than
// always its leading edge. `min > max` is tolerated (a flipped box).
export function snapSpanToLines(
  min: number,
  max: number,
  lines: readonly number[],
  threshold: number
): LineSnap | null {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const mid = (lo + hi) / 2;
  let best: LineSnap | null = null;
  for (const feature of [lo, mid, hi]) {
    const s = snapValueToLines(feature, lines, threshold);
    if (s && (!best || Math.abs(s.delta) < Math.abs(best.delta))) best = s;
  }
  return best;
}

// Ruler tick ladder. `pxPerUnit` is on-screen CSS px per project pixel (the
// canvas's displayed width / its resolution — the zoom, effectively).
// `major` is the labelled step in project px, `minor` the unlabelled
// subdivision. Labels never land closer than `minLabelPx` apart, and the
// step is always a 1 / 2 / 5 × 10ⁿ number so the readouts stay round.
export function rulerTickPlan(
  pxPerUnit: number,
  minLabelPx = 64
): { major: number; minor: number } {
  const ppu = Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? pxPerUnit : 1;
  // Smallest 1/2/5 step whose on-screen spacing clears minLabelPx.
  const target = minLabelPx / ppu;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1e-9))));
  let major = mag;
  for (const m of [1, 2, 5, 10]) {
    if (mag * m >= target) {
      major = mag * m;
      break;
    }
  }
  // 5 subdivisions when they'd sit ≥ 6px apart, else 2, else none.
  const minor =
    (major / 5) * ppu >= 6 ? major / 5 : (major / 2) * ppu >= 6 ? major / 2 : major;
  return { major, minor };
}

// Guide readout in project pixels: whole numbers when the guide sits on the
// pixel grid (the ruler drag rounds there), one decimal otherwise.
export function formatGuidePx(pos: number, res: number): string {
  const px = pos * res;
  const rounded = Math.round(px);
  return Math.abs(px - rounded) < 1e-6 ? String(rounded) : px.toFixed(1);
}

// Where a ruler drag lands: the pointer's canvas fraction snapped to the
// nearest whole project pixel (guides live on the pixel grid, as in
// Photoshop). `res` = the axis's resolution.
export function guidePosFromClient(
  client: number,
  canvasStart: number,
  canvasSize: number,
  res: number
): number {
  if (!(canvasSize > 0) || !(res > 0)) return 0;
  const frac = (client - canvasStart) / canvasSize;
  return Math.round(frac * res) / res;
}
