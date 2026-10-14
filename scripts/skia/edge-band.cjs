// Interior vs anti-aliased edge band for a compare:skia output directory
// (specdocs/101326_skia-target.md §7 Wave 2, family 7). Vector ports differ
// from the node they mirror only where the two rasterizers anti-alias an
// edge differently (Chromium's canvas 2D vs CanvasKit), so one whole-image
// number hides whether the GEOMETRY matches. This splits every frame in two:
//
//   band      pixels within --band px (Chebyshev) of a place where either
//             image is not flat — every outline, stroke edge and fill/stroke
//             seam, from both sides, so an offset outline lands in it too
//             as long as it is off by less than the band;
//   interior  everything else: flat fill, flat stroke, flat background.
//
// Compared premultiplied (a transparent pixel's RGB means nothing), per
// channel in 0..255 steps. Interior should be identical; the band reports
// how far the two anti-aliasing filters disagree.
//
//   node scripts/skia/edge-band.cjs <compare-out dir> [--band 2] [--json]
//
// Reads report.json and f<N>-a.png / f<N>-b.png, prints one line per frame
// and writes edge-band.json next to them.
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { decodePng } = require("./png.cjs");

function premul(rgba) {
  const out = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = rgba[i] * a;
    out[i + 1] = rgba[i + 1] * a;
    out[i + 2] = rgba[i + 2] * a;
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

// 1 where the (2k+1)² neighbourhood holds a pixel that differs from the
// centre by more than half a step in any premultiplied channel.
function edgeMask(p, w, h, k) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let edge = 0;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        for (let dx = -1; dx <= 1 && !edge; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = (yy * w + xx) * 4;
          for (let c = 0; c < 4; c++) if (Math.abs(p[o + c] - p[q + c]) > 0.5) edge = 1;
        }
      }
      m[y * w + x] = edge;
    }
  }
  if (k <= 1) return m;
  // Dilate the 1-px transition mask to the band width.
  const out = new Uint8Array(w * h);
  const r = k - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

function stats(pa, pb, mask, want, w) {
  let n = 0;
  let sum = 0;
  let max = 0;
  let worst = -1;
  let identical = 0;
  let alphaSigned = 0;
  const per = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== want) continue;
    n++;
    let px = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(pa[i * 4 + c] - pb[i * 4 + c]);
      sum += d;
      if (d > px) px = d;
    }
    alphaSigned += pb[i * 4 + 3] - pa[i * 4 + 3];
    if (px < 0.5) identical++;
    if (px > max) {
      max = px;
      worst = i;
    }
    per.push(px);
  }
  per.sort((x, y) => x - y);
  const rgba = (p, i) => [0, 1, 2, 3].map((c) => Math.round(p[i * 4 + c]));
  return {
    pixels: n,
    meanAbs: n ? sum / (n * 4 * 255) : 0,
    p95Steps: n ? Math.round(per[Math.min(n - 1, Math.floor(n * 0.95))]) : 0,
    maxSteps: Math.round(max),
    identical: n ? identical / n : 1,
    // Σ(alpha B − alpha A) in px² of full coverage: > 0 = B covers more.
    netCoveragePx: alphaSigned / 255,
    // Premultiplied RGBA at the worst pixel.
    worst: worst < 0 ? null : { x: worst % w, y: Math.floor(worst / w), a: rgba(pa, worst), b: rgba(pb, worst) },
  };
}

// Fraction of pixels whose premultiplied value changes between two frames
// (compare:skia's `motion` reads RGB on mutually opaque pixels only, so a
// moving stroke over transparency reads ~0 there).
function changed(p0, p1) {
  let n = 0;
  for (let i = 0; i < p0.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(p0[i + c] - p1[i + c]) > 0.5) {
        n++;
        break;
      }
    }
  }
  return n / (p0.length / 4);
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const bi = args.indexOf("--band");
  const band = bi >= 0 ? Number(args[bi + 1]) : 2;
  if (!dir || !(band >= 1)) {
    console.error("usage: node scripts/skia/edge-band.cjs <compare-out dir> [--band 2]");
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  const rows = [];
  const firstA = [];
  for (const f of report.frames) {
    const a = decodePng(fs.readFileSync(path.join(dir, `f${f}-a.png`)));
    const b = decodePng(fs.readFileSync(path.join(dir, `f${f}-b.png`)));
    const pa = premul(a.rgba);
    const pb = premul(b.rgba);
    const ma = edgeMask(pa, a.width, a.height, band);
    const mb = edgeMask(pb, b.width, b.height, band);
    const mask = new Uint8Array(ma.length);
    for (let i = 0; i < mask.length; i++) mask[i] = ma[i] | mb[i];
    const interior = stats(pa, pb, mask, 0, a.width);
    const edge = stats(pa, pb, mask, 1, a.width);
    const motion = firstA.length ? changed(firstA[0], pa) : 0;
    if (!firstA.length) firstA.push(pa);
    rows.push({ frame: f, band, interior, edge, bandFraction: edge.pixels / mask.length, motionA: motion });
    console.log(
      `f${f}: interior ${interior.pixels}px max ${interior.maxSteps}/255 identical ${(interior.identical * 100).toFixed(2)}% · ` +
        `band(${band}px) ${(edge.pixels / mask.length * 100).toFixed(1)}% of px meanAbs ${edge.meanAbs.toFixed(4)} p95 ${edge.p95Steps}/255 max ${edge.maxSteps}/255` +
        (edge.worst ? ` at (${edge.worst.x},${edge.worst.y}) A=[${edge.worst.a}] B=[${edge.worst.b}]` : "") +
        ` · net coverage ${edge.netCoveragePx.toFixed(1)}px² · A changed vs f${report.frames[0]} ${(motion * 100).toFixed(1)}%`
    );
  }
  const worst = (k, g) => Math.max(...rows.map((r) => g(r[k])));
  const summary = {
    a: report.a,
    b: report.b,
    canvas: report.canvas,
    band,
    interiorMaxSteps: worst("interior", (s) => s.maxSteps),
    interiorMinIdentical: Math.min(...rows.map((r) => r.interior.identical)),
    edgeMeanAbs: rows.reduce((s, r) => s + r.edge.meanAbs, 0) / rows.length,
    edgeP95Steps: worst("edge", (s) => s.p95Steps),
    edgeMaxSteps: worst("edge", (s) => s.maxSteps),
    rows,
  };
  fs.writeFileSync(path.join(dir, "edge-band.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `summary: interior max ${summary.interiorMaxSteps}/255 (min identical ${(summary.interiorMinIdentical * 100).toFixed(2)}%) · ` +
      `band mean meanAbs ${summary.edgeMeanAbs.toFixed(4)}, worst p95 ${summary.edgeP95Steps}/255, worst max ${summary.edgeMaxSteps}/255`
  );
}

main();
