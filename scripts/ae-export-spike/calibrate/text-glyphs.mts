// Glyph-by-glyph measurement for the text calibration (text-probe.mts,
// text.mts): a run of separated glyphs is cut into cells from a reference
// render, and each cell of an animated render is summarized — alpha mass,
// centroid, bounding box, orientation, mean color. Pure: works on the
// straight-alpha float images ae.mts and tbx-render produce.

export interface Img {
  width: number;
  height: number;
  data: Float32Array; // straight RGBA 0..1, row 0 = top
}

export interface Cell {
  x0: number;
  x1: number; // exclusive
}

export interface GlyphStats {
  mass: number; // Σ alpha
  cx: number; // alpha-weighted centroid
  cy: number;
  // Bounding box of alpha > 0.5.
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
  // Orientation of the alpha distribution's major axis, degrees (0 = x axis,
  // clockwise positive in Y-down image space).
  angle: number;
  // RMS extent along that axis (px): scales with the glyph.
  spread: number;
  rgb: [number, number, number]; // alpha-weighted mean color
}

// Column runs of alpha in the reference: the cells are split halfway between
// neighbouring runs, so a glyph may move or grow into its gap.
export function glyphCells(ref: Img, expect?: number, thresh = 0.05): Cell[] {
  const { width: w, height: h, data } = ref;
  const col = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[x] += data[(y * w + x) * 4 + 3];
  const runs: [number, number][] = [];
  let s = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && col[x] > thresh;
    if (on && s < 0) s = x;
    if (!on && s >= 0) {
      runs.push([s, x]);
      s = -1;
    }
  }
  if (expect !== undefined && runs.length !== expect) throw new Error(`expected ${expect} glyph runs, found ${runs.length}`);
  return runs.map(([a, b], i) => ({
    x0: i === 0 ? 0 : Math.round((runs[i - 1][1] + a) / 2),
    x1: i === runs.length - 1 ? w : Math.round((b + runs[i + 1][0]) / 2),
  }));
}

export function glyphStats(img: Img, c: Cell, rows?: [number, number]): GlyphStats {
  const { width: w, data } = img;
  const [y0, y1] = rows ?? [0, img.height];
  let m = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let y = y0; y < y1; y++)
    for (let x = c.x0; x < c.x1; x++) {
      const o = (y * w + x) * 4;
      const a = data[o + 3];
      if (a <= 0) continue;
      m += a;
      sx += a * (x + 0.5);
      sy += a * (y + 0.5);
      r += a * data[o];
      g += a * data[o + 1];
      b += a * data[o + 2];
      if (a > 0.5) {
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x + 1 > bx1) bx1 = x + 1;
        if (y + 1 > by1) by1 = y + 1;
      }
    }
  const cx = m ? sx / m : NaN;
  const cy = m ? sy / m : NaN;
  let mxx = 0, myy = 0, mxy = 0;
  if (m)
    for (let y = y0; y < y1; y++)
      for (let x = c.x0; x < c.x1; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a <= 0) continue;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        mxx += a * dx * dx;
        myy += a * dy * dy;
        mxy += a * dx * dy;
      }
  const angle = (0.5 * Math.atan2(2 * mxy, mxx - myy) * 180) / Math.PI;
  return { mass: m, cx, cy, bx0, by0, bx1, by1, angle, spread: majorSpread(mxx, myy, mxy, m), rgb: m ? [r / m, g / m, b / m] : [NaN, NaN, NaN] };
}

// √(larger eigenvalue of the alpha covariance).
function majorSpread(mxx: number, myy: number, mxy: number, m: number): number {
  if (!m) return NaN;
  const a = mxx / m;
  const d = myy / m;
  const b = mxy / m;
  return Math.sqrt((a + d) / 2 + Math.sqrt(((a - d) / 2) ** 2 + b * b));
}

export const allStats = (img: Img, cells: Cell[], rows?: [number, number]) => cells.map((c) => glyphStats(img, c, rows));

export const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

// Recorded results: one line per top-level entry (a case), compact inside.
export function recordJson(v: Record<string, unknown>): string {
  return `{\n${Object.entries(v)
    .map(([k, x]) => ` ${JSON.stringify(k)}: ${JSON.stringify(x)}`)
    .join(",\n")}\n}\n`;
}

// Glyphs as connected blobs of alpha > `thresh` (8-connected), for layouts a
// column split cannot cut (text on a path). Stats per blob as glyphStats;
// blobs smaller than `minMass` (stray anti-aliasing) are dropped.
export function glyphBlobs(img: Img, thresh = 0.1, minMass = 4): GlyphStats[] {
  const { width: w, height: h, data } = img;
  const label = new Int32Array(w * h).fill(-1);
  const out: GlyphStats[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] >= 0 || data[start * 4 + 3] <= thresh) continue;
    const id = out.length;
    const px: number[] = [];
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const q = stack.pop()!;
      px.push(q);
      const x = q % w;
      const y = (q - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (label[n] >= 0 || data[n * 4 + 3] <= thresh) continue;
          label[n] = id;
          stack.push(n);
        }
    }
    // Stats over the blob's pixels plus its faint fringe (alpha ≤ thresh
    // neighbours are not labelled; the mass difference is ≪ 1 %).
    let m = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const q of px) {
      const a = data[q * 4 + 3];
      const x = q % w;
      const y = (q - x) / w;
      m += a;
      sx += a * (x + 0.5);
      sy += a * (y + 0.5);
      r += a * data[q * 4];
      g += a * data[q * 4 + 1];
      b += a * data[q * 4 + 2];
      if (a > 0.5) {
        bx0 = Math.min(bx0, x);
        by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x + 1);
        by1 = Math.max(by1, y + 1);
      }
    }
    const cx = sx / m;
    const cy = sy / m;
    let mxx = 0, myy = 0, mxy = 0;
    for (const q of px) {
      const a = data[q * 4 + 3];
      const x = q % w;
      const y = (q - x) / w;
      mxx += a * (x + 0.5 - cx) ** 2;
      myy += a * (y + 0.5 - cy) ** 2;
      mxy += a * (x + 0.5 - cx) * (y + 0.5 - cy);
    }
    out.push({ mass: m, cx, cy, bx0, by0, bx1, by1, angle: (0.5 * Math.atan2(2 * mxy, mxx - myy) * 180) / Math.PI, spread: majorSpread(mxx, myy, mxy, m), rgb: [r / m, g / m, b / m] });
  }
  return out.filter((s) => s.mass >= minMass);
}
