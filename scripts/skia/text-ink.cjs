// Text geometry for a compare:skia output directory (specdocs/101326_skia-target.md
// §3.4b, Wave 3 lane T). The Text node (Chromium's canvas 2D: CoreText on
// macOS) and Text (Skia) (CanvasKit: FreeType) rasterize the same outlines
// with different gamma and hinting, so their glyphs differ in INK WEIGHT
// (~10 %) on every edge and a whole-image score can't say whether the lines
// sit in the same place. This measures where the ink is instead:
//
//   ink       per pixel, the largest premultiplied channel difference from
//             the image's background (its most common pixel), 0..1 — works
//             over transparency and over an opaque backdrop (blend pairs);
//   box       the bounding box of ink ≥ 0.5, per side, and B − A per edge;
//   drift     the ink-weighted x centre of each eighth of A's box, B − A —
//             where along the line the glyphs sit (a whole-image centroid
//             mixes position with the weight difference, which varies
//             glyph to glyph); the worst |Δ| is reported;
//   mass      Σ ink B / Σ ink A (the weight difference, not a position);
//   lines     runs of rows holding ink ≥ 0.5 — each line's top / bottom
//             edge, B − A, so leading and vertical anchors are read per line.
//
//   node scripts/skia/text-ink.cjs <compare-out dir> [--json]
//
// Prints one line per frame and writes text-ink.json next to the PNGs.
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { decodePng } = require("./png.cjs");

function background(rgba) {
  const counts = new Map();
  let best = 0;
  let key = 0;
  for (let i = 0; i < rgba.length; i += 4 * 7) {
    const k = ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    if (n > best) {
      best = n;
      key = k;
    }
  }
  return [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255];
}

function inkOf(rgba, bg) {
  const ink = new Float32Array(rgba.length / 4);
  const ba = bg[3] / 255;
  const bp = [bg[0] * ba, bg[1] * ba, bg[2] * ba, bg[3]];
  for (let i = 0; i < ink.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    let d = Math.abs(rgba[i * 4 + 3] - bp[3]);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(rgba[i * 4 + c] * a - bp[c]));
    ink[i] = d / 255;
  }
  return ink;
}

function measure(ink, w, h) {
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  let mass = 0;
  const rows = new Array(h).fill(false);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ink[y * w + x];
      mass += v;
      if (v >= 0.5) {
        rows[y] = true;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const lines = [];
  for (let y = 0; y < h; y++) {
    if (!rows[y]) continue;
    const top = y;
    while (y + 1 < h && rows[y + 1]) y++;
    lines.push([top, y]);
  }
  return { box: [x0, y0, x1, y1], mass, lines };
}

// The ink-weighted x centre of each of `n` vertical slices of `box`.
function sliceCentres(ink, w, box, n) {
  const out = [];
  for (let s = 0; s < n; s++) {
    const lo = Math.floor(box[0] + ((box[2] + 1 - box[0]) * s) / n);
    const hi = Math.floor(box[0] + ((box[2] + 1 - box[0]) * (s + 1)) / n);
    let m = 0;
    let sx = 0;
    for (let y = box[1]; y <= box[3]; y++) {
      for (let x = lo; x < hi; x++) {
        const v = ink[y * w + x];
        m += v;
        sx += v * x;
      }
    }
    out.push(m > 0 ? sx / m : null);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/skia/text-ink.cjs <compare-out dir> [--json]");
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  const out = [];
  for (const f of report.frames) {
    const a = decodePng(fs.readFileSync(path.join(dir, `f${f}-a.png`)));
    const b = decodePng(fs.readFileSync(path.join(dir, `f${f}-b.png`)));
    const bg = background(a.rgba);
    const inkA = inkOf(a.rgba, bg);
    const inkB = inkOf(b.rgba, bg);
    const A = measure(inkA, a.width, a.height);
    const B = measure(inkB, b.width, b.height);
    const boxDelta = B.box.map((v, i) => v - A.box[i]);
    let drift = null;
    if (A.box[2] >= A.box[0]) {
      const ca = sliceCentres(inkA, a.width, A.box, 8);
      const cb = sliceCentres(inkB, b.width, A.box, 8);
      drift = ca.map((v, i) => (v === null || cb[i] === null ? 0 : cb[i] - v));
    }
    const worstDrift = drift ? Math.max(...drift.map(Math.abs)) : null;
    const sameLines = A.lines.length === B.lines.length;
    const lineDelta = sameLines ? A.lines.map((l, i) => [B.lines[i][0] - l[0], B.lines[i][1] - l[1]]) : null;
    const worstLine = lineDelta ? Math.max(0, ...lineDelta.flat().map(Math.abs)) : null;
    const row = {
      frame: f,
      background: bg,
      boxA: A.box,
      boxB: B.box,
      boxDelta,
      drift,
      worstDriftPx: worstDrift,
      massRatio: A.mass ? B.mass / A.mass : null,
      linesA: A.lines,
      linesB: B.lines,
      lineDelta,
      worstLinePx: worstLine,
    };
    out.push(row);
    console.log(
      `f${f}: box Δ [${boxDelta.join(", ")}] px · x drift ≤ ${worstDrift === null ? "n/a" : worstDrift.toFixed(2)} px · ` +
        `mass B/A ${row.massRatio === null ? "n/a" : row.massRatio.toFixed(3)} · lines ${A.lines.length}/${B.lines.length}` +
        (lineDelta ? ` worst edge Δ ${worstLine} px` : " (line counts differ)")
    );
  }
  fs.writeFileSync(path.join(dir, "text-ink.json"), JSON.stringify(out, null, 2) + "\n");
  if (args.includes("--json")) console.log(JSON.stringify(out));
}

main();
