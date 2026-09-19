// Pixel metrics behind the `compare_renders` tool (spec 091626_graph-to-glsl.md
// §4). Pure functions over RGBA8 readbacks so the gate can test them on
// synthetic buffers; the handler owns rendering and readback.
//
// The comparison answers "is the fused shader converging on the original?"
// — not "are they identical". Readbacks are RGBA8 (readImagePixels), so the
// floor is 1/255 per channel plus float16 rounding in the source textures.
// Thresholds are PROVISIONAL until measured on identical nodes in the live
// editor (spec §M0 — noise floor); they are exported so the parity doc and
// the handler quote the same numbers.

export interface CompareMetrics {
  // Mean |A−B| over RGB, 0..1, on pixels where both alphas exceed alphaFloor.
  meanAbs: number;
  // 95th percentile of the per-pixel max-channel |A−B|.
  p95Abs: number;
  // Mean |A.a − B.a| over ALL pixels.
  alphaMeanAbs: number;
  // Fraction of compared pixels whose max-channel error exceeds `threshold`.
  overThreshold: number;
  // Fraction of pixels that were compared (both alphas above the floor).
  compared: number;
  // uv bounding box (Y-up, like v_uv) of the worst 5% of compared pixels,
  // or null when nothing exceeded the threshold.
  worstBox: { x0: number; y0: number; x1: number; y1: number } | null;
  verdict: "match" | "close" | "off";
}

export const COMPARE_DEFAULTS = {
  // Per-channel error a pixel must exceed to count as "over" (≈ 5/255).
  threshold: 0.02,
  // Alpha below which a pixel's RGB is undefined and skipped.
  alphaFloor: 0.02,
  // Verdict bands (provisional — see file header).
  match: { meanAbs: 0.01, p95Abs: 0.06, alphaMeanAbs: 0.01 },
  close: { meanAbs: 0.03, p95Abs: 0.15, alphaMeanAbs: 0.03 },
} as const;

export function verdictOf(m: Omit<CompareMetrics, "verdict">): CompareMetrics["verdict"] {
  const d = COMPARE_DEFAULTS;
  if (m.meanAbs <= d.match.meanAbs && m.p95Abs <= d.match.p95Abs && m.alphaMeanAbs <= d.match.alphaMeanAbs)
    return "match";
  if (m.meanAbs <= d.close.meanAbs && m.p95Abs <= d.close.p95Abs && m.alphaMeanAbs <= d.close.alphaMeanAbs)
    return "close";
  return "off";
}

export function compareRgba(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { threshold?: number; alphaFloor?: number } = {}
): CompareMetrics {
  const n = width * height;
  if (a.length < n * 4 || b.length < n * 4)
    throw new Error(`compareRgba: buffers are smaller than ${width}×${height}×4.`);
  const threshold = opts.threshold ?? COMPARE_DEFAULTS.threshold;
  const floor = Math.round((opts.alphaFloor ?? COMPARE_DEFAULTS.alphaFloor) * 255);
  const perPixel = new Float32Array(n); // max-channel RGB error, -1 = skipped
  let sumRgb = 0;
  let sumAlpha = 0;
  let compared = 0;
  let over = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const da = Math.abs(a[o + 3] - b[o + 3]);
    sumAlpha += da;
    if (a[o + 3] <= floor || b[o + 3] <= floor) {
      perPixel[i] = -1;
      continue;
    }
    const dr = Math.abs(a[o] - b[o]);
    const dg = Math.abs(a[o + 1] - b[o + 1]);
    const db = Math.abs(a[o + 2] - b[o + 2]);
    const mx = Math.max(dr, dg, db) / 255;
    perPixel[i] = mx;
    sumRgb += (dr + dg + db) / (3 * 255);
    compared++;
    if (mx > threshold) over++;
  }
  const meanAbs = compared ? sumRgb / compared : 0;
  const alphaMeanAbs = n ? sumAlpha / (n * 255) : 0;
  // p95 of compared pixels.
  let p95Abs = 0;
  if (compared) {
    const vals = new Float32Array(compared);
    let k = 0;
    for (let i = 0; i < n; i++) if (perPixel[i] >= 0) vals[k++] = perPixel[i];
    vals.sort();
    p95Abs = vals[Math.min(compared - 1, Math.floor(compared * 0.95))];
  }
  // Worst region: the top 5% of compared pixels by error, if any exceed the
  // threshold. Bounding box in Y-up uv.
  let worstBox: CompareMetrics["worstBox"] = null;
  if (over > 0 && compared > 0) {
    const cut = Math.max(threshold, p95Abs);
    let x0 = width,
      y0 = height,
      x1 = -1,
      y1 = -1;
    for (let i = 0; i < n; i++) {
      if (perPixel[i] < cut || perPixel[i] <= threshold) continue;
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 >= 0) {
      // Readbacks are row 0 = visual top; flip to v_uv's Y-up.
      worstBox = {
        x0: x0 / width,
        y0: 1 - (y1 + 1) / height,
        x1: (x1 + 1) / width,
        y1: 1 - y0 / height,
      };
    }
  }
  const partial = {
    meanAbs,
    p95Abs,
    alphaMeanAbs,
    overThreshold: compared ? over / compared : 0,
    compared: n ? compared / n : 0,
    worstBox,
  };
  return { ...partial, verdict: verdictOf(partial) };
}

// |A−B| as a heat image (RGBA8): black → red → yellow → white with error,
// alpha mismatch tinted blue. Gain stretches small errors so a `close`
// diff is still visible.
export function diffHeatRgba(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  gain = 4
): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const e =
      Math.min(
        1,
        (gain * Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]))) /
          255
      );
    const ea = Math.min(1, (gain * Math.abs(a[o + 3] - b[o + 3])) / 255);
    // heat ramp
    const r = Math.min(1, e * 2);
    const g = Math.max(0, Math.min(1, e * 2 - 1));
    const bl = Math.max(0, Math.min(1, e * 3 - 2));
    out[o] = Math.round(255 * r);
    out[o + 1] = Math.round(255 * g);
    out[o + 2] = Math.round(255 * Math.max(bl, ea));
    out[o + 3] = 255;
  }
  return out;
}

export function describeMetrics(frame: number, m: CompareMetrics): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const box = m.worstBox
    ? ` worst uv [${m.worstBox.x0.toFixed(2)},${m.worstBox.y0.toFixed(2)}]–[${m.worstBox.x1.toFixed(2)},${m.worstBox.y1.toFixed(2)}]`
    : "";
  return (
    `f${frame}: ${m.verdict.toUpperCase()} — meanAbs ${m.meanAbs.toFixed(4)}, p95 ${m.p95Abs.toFixed(3)}, ` +
    `alpha ${m.alphaMeanAbs.toFixed(4)}, over ${pct(m.overThreshold)} of ${pct(m.compared)} compared${box}`
  );
}
