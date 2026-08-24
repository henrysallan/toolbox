// check-tracker: classical motion-tracking kernel + track_data helpers
// (specdocs/082226_motion-tracking.md M0). Synthetic sequences, no GL.
//
//   npx tsx scripts/check-tracker.mts
import { isKeyframable } from "../src/engine/keyframes.ts";
import { paramSocketType } from "../src/engine/graph-helpers.ts";
import {
  addTrack,
  emptyPointTrackerData,
  trackDataFingerprintToken,
  upsertSample,
} from "../src/engine/tracking/track-data.ts";
import { makeGray, sampleBilinear, type GrayImage } from "../src/engine/tracking/gray.ts";
import { classicalBackend, forwardBackwardError } from "../src/engine/tracking/classical.ts";
import {
  applyH,
  dlt,
  identityH,
  invertH,
  ransacHomography,
  type Homography,
} from "../src/engine/tracking/homography.ts";
import { seedPlanar, stepPlanar } from "../src/engine/tracking/planar.ts";
import {
  detectSpikes,
  fillGaps,
  predictPosition,
  repairSpikes,
  smoothGaussian,
  smoothSavgol,
  type SampleArrays,
} from "../src/engine/tracking/filters.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function texturedValue(x: number, y: number): number {
  const n =
    0.28 * Math.sin(x * 0.37 + y * 0.11) +
    0.22 * Math.sin(x * 0.13 - y * 0.29) +
    0.18 * Math.sin(x * 0.71 + y * 0.53) +
    0.12 * Math.sin(x * 1.07 + y * 0.83) +
    0.08 * (hash2(Math.floor(x), Math.floor(y)) - 0.5);
  return 0.5 + n;
}

function renderTexture(w: number, h: number): GrayImage {
  const img = makeGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      img.data[y * w + x] = texturedValue(x, y);
    }
  }
  return img;
}

function warpTranslate(
  src: GrayImage,
  dx: number,
  dy: number,
  brightness = 1,
  noise = 0,
  rng?: () => number
): GrayImage {
  const out = makeGray(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let v = sampleBilinear(src, x - dx, y - dy) * brightness;
      if (noise && rng) v += (rng() * 2 - 1) * noise;
      out.data[y * src.width + x] = v;
    }
  }
  return out;
}

function warpH(src: GrayImage, Hinv: Homography, w: number, h: number): GrayImage {
  const out = makeGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyH(Hinv, x, y);
      out.data[y * w + x] = sampleBilinear(src, sx, sy);
    }
  }
  return out;
}

// --- 0. ParamType / fingerprint / helpers --------------------------------
{
  console.log("track_data param");
  check("isKeyframable(track_data) is false", isKeyframable("track_data") === false);
  check("paramSocketType(track_data) is null", paramSocketType("track_data") === null);

  let data = emptyPointTrackerData();
  const rev0 = data.rev;
  data = addTrack(data, { frame: 0, x: 0.4, y: 0.5 });
  check("addTrack bumps rev", data.rev !== rev0 && data.tracks.length === 1);
  const id = data.tracks[0]!.id;
  const before = data;
  data = upsertSample(data, id, 0, { x: 0.41, y: 0.52, conf: 0.91, status: 0 });
  check("upsertSample does not mutate", before.tracks[0]!.frames.length === 0);
  check("sample compact conf (3 decimals)", data.tracks[0]!.conf[0] === 0.91);
  const json = JSON.parse(JSON.stringify(data));
  check("JSON round-trip keeps kind", json.kind === "track_data" && json.tracks[0].frames[0] === 0);

  const tok = trackDataFingerprintToken(data);
  const sameRev = { ...data, tracks: data.tracks.map((t) => ({ ...t, x: t.x.map((v) => v + 1) })) };
  check(
    "fingerprint is trk:<rev> (identity token)",
    tok === "trk:" + data.rev && trackDataFingerprintToken(sameRev) === tok
  );
  const bumped = upsertSample(data, id, 1, { x: 0.4, y: 0.5, conf: 0.8, status: 0 });
  check("edit changes fingerprint", trackDataFingerprintToken(bumped) !== tok);
}

// --- 1. Sub-pixel translate + noise + brightness ramp --------------------
{
  console.log("1. sub-pixel translate");
  const src = renderTexture(160, 160);
  const cx = 80.25;
  const cy = 72.4;
  const dx = 0.37;
  const dy = -0.61;
  const rng = mulberry32(7);
  const frames = 16;
  const handle = classicalBackend.seed(src, cx, cy, {
    patternW: 31,
    patternH: 31,
    searchW: 61,
    searchH: 61,
  });
  const errs: number[] = [];
  let lost = 0;
  let x = cx;
  let y = cy;
  for (let f = 1; f <= frames; f++) {
    const img = warpTranslate(src, dx * f, dy * f, 1 + 0.02 * f, 0.02, rng);
    const pred = { x: x + dx, y: y + dy };
    const r = classicalBackend.step(handle, img, pred);
    const gtX = cx + dx * f;
    const gtY = cy + dy * f;
    errs.push(Math.hypot(r.x - gtX, r.y - gtY));
    if (r.conf < 0.6) lost++;
    x = r.x;
    y = r.y;
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  check(
    "mean error < 0.1 px",
    mean < 0.1,
    `mean=${mean.toFixed(3)} max=${Math.max(...errs).toFixed(3)}`
  );
  check("no lost frames", lost === 0, `lost=${lost}`);
}

// --- 2. Occlusion → predicted, re-acquire; FB catches a decoy ------------
{
  console.log("2. occlusion + forward-backward");
  const src = renderTexture(160, 160);
  const cx = 80;
  const cy = 80;
  const dx = 0.8;
  const handle = classicalBackend.seed(src, cx, cy, {
    patternW: 31,
    patternH: 31,
    searchW: 61,
    searchH: 61,
  });
  const rng = mulberry32(11);
  const statuses: number[] = [0];
  let x = cx;
  let y = cy;
  let predictedStreak = 0;
  let searchW = 61;
  const frames: number[] = [0];
  const xs: number[] = [cx];
  const ys: number[] = [cy];
  const st: number[] = [0];
  let reacquired = false;

  for (let f = 1; f <= 20; f++) {
    let img = warpTranslate(src, dx * f, 0, 1, 0.01, rng);
    if (f >= 8 && f <= 13) {
      img = makeGray(img.width, img.height, 0.2);
    }
    const pred =
      predictedStreak > 0
        ? predictPosition(frames, xs, ys, st, f - 1, f, predictedStreak)
        : { x: x + dx, y };
    handle.searchW = searchW;
    handle.searchH = searchW;
    const r = classicalBackend.step(handle, img, pred);
    const lost = r.conf < 0.6 || r.sharpness < 1.15;
    if (lost) {
      predictedStreak++;
      searchW = Math.min(61 * 3, Math.round(searchW * 1.5));
      const p = predictPosition(frames, xs, ys, st, f - 1, f, predictedStreak);
      x = p.x;
      y = p.y;
      statuses.push(3);
      st.push(3);
    } else {
      if (predictedStreak > 0 && f > 13) reacquired = true;
      predictedStreak = 0;
      searchW = 61;
      x = r.x;
      y = r.y;
      statuses.push(0);
      st.push(0);
    }
    frames.push(f);
    xs.push(x);
    ys.push(y);
  }
  const occ = statuses.slice(8, 14);
  check(
    "occluded frames are predicted",
    occ.every((s) => s === 3),
    `status=${occ.join(",")}`
  );
  check("re-acquired after occlusion", reacquired && statuses[16] === 0);

  // Decoy: two similar patches. Land the forward result on the decoy and
  // confirm appearance-based FB round-trip exceeds 1 px.
  const a = renderTexture(160, 160);
  const b = makeGray(160, 160);
  const decoyX = 120;
  const decoyY = 50;
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 160; x++) {
      // Copy the neighbourhood of (cx,cy) onto (decoyX, decoyY) in B only.
      b.data[y * 160 + x] = sampleBilinear(a, x - (decoyX - cx), y - (decoyY - cy));
    }
  }
  const h2 = classicalBackend.seed(a, cx, cy, {
    patternW: 31,
    patternH: 31,
    searchW: 61,
    searchH: 61,
  });
  const fb = forwardBackwardError(classicalBackend, h2, a, b, cx, cy, decoyX, decoyY);
  check("forward-backward catches a decoy (> 1 px)", fb > 1, `err=${fb.toFixed(2)}`);
}

// --- 3. Spike repair + smoothing ----------------------------------------
{
  console.log("3. repair + smoothing");
  const n = 21;
  const samples: SampleArrays = {
    frames: [],
    x: [],
    y: [],
    conf: [],
    status: [],
  };
  for (let i = 0; i < n; i++) {
    samples.frames.push(i);
    samples.x.push(10 + 0.5 * i);
    samples.y.push(20 + 0.2 * i);
    samples.conf.push(0.9);
    samples.status.push(0);
  }
  samples.x[10] += 8; // spike
  const hits = detectSpikes(samples, 3.5);
  check(
    "spike detector flags exactly the injected frame",
    hits.length === 1 && hits[0]!.frame === 10,
    `hits=${hits.map((h) => h.frame).join(",")}`
  );
  const fixed = repairSpikes(samples, hits);
  check("repaired status on the spike", fixed.status[10] === 2);
  check(
    "repair pulls the spike back",
    Math.abs(fixed.x[10]! - (10 + 0.5 * 10)) < 0.6,
    `x=${fixed.x[10]!.toFixed(3)}`
  );

  const cleanX = samples.frames.map((i) => 3 + 0.4 * i);
  const g = smoothGaussian(samples.frames, cleanX, samples.status, 4);
  check("gaussian preserves endpoints", close(g[0]!, cleanX[0]!, 1e-6) && close(g[n - 1]!, cleanX[n - 1]!, 1e-6));
  const midSlope = (g[12]! - g[8]!) / 4;
  check("gaussian keeps constant-velocity slope", close(midSlope, 0.4, 0.05), `slope=${midSlope.toFixed(3)}`);

  const quad = samples.frames.map((i) => 0.05 * i * i);
  const sg = smoothSavgol(samples.frames, quad, samples.status, 4);
  let sgErr = 0;
  for (let i = 0; i < n; i++) sgErr += Math.abs(sg[i]! - quad[i]!);
  check("savgol reproduces a quadratic exactly", sgErr < 1e-6, `err=${sgErr}`);

  const gappy: SampleArrays = {
    frames: samples.frames.slice(),
    x: samples.x.slice(),
    y: samples.y.slice(),
    conf: samples.conf.slice(),
    status: samples.status.map((s, i) => (i >= 5 && i <= 8 ? 4 : s)),
  };
  const filled = fillGaps(gappy, 12);
  check(
    "fillGaps repairs a short lost run",
    filled.status[5] === 2 && filled.status[8] === 2
  );
}

// --- 4. Planar: synthetic homography + RANSAC outliers -------------------
{
  console.log("4. planar");
  const src = renderTexture(192, 192);
  const refCorners: Array<[number, number]> = [
    [50, 50],
    [140, 48],
    [142, 138],
    [48, 140],
  ];
  // Modest perspective + translation.
  const dstCorners: Array<[number, number]> = [
    [54, 47],
    [146, 52],
    [139, 144],
    [45, 137],
  ];
  const H = dlt(refCorners, dstCorners)!;
  const Hi = invertH(H)!;
  const warped = warpH(src, Hi, 192, 192);

  const handle = seedPlanar(src, refCorners, { featureCount: 64, pattern: 15 });
  check("seeded enough features", handle.features.length >= 16, `n=${handle.features.length}`);
  const step = stepPlanar(handle, warped, { refine: "esm" });
  const cornerErrs = step.corners.map((c, i) =>
    Math.hypot(c[0] - dstCorners[i]![0], c[1] - dstCorners[i]![1])
  );
  const meanC = cornerErrs.reduce((a, b) => a + b, 0) / cornerErrs.length;
  check(
    "planar corner error < 0.25 px",
    meanC < 0.25 && !step.lost,
    `mean=${meanC.toFixed(3)} conf=${step.conf.toFixed(2)} lost=${step.lost}`
  );

  const Htrue = dlt(
    [
      [0, 0],
      [100, 0],
      [100, 80],
      [0, 80],
    ],
    [
      [4, -2],
      [108, 3],
      [101, 86],
      [-3, 77],
    ]
  )!;
  const srcPts: Array<[number, number]> = [];
  const dstPts: Array<[number, number]> = [];
  const rng = mulberry32(99);
  for (let i = 0; i < 40; i++) {
    const p: [number, number] = [10 + rng() * 80, 10 + rng() * 60];
    srcPts.push(p);
    if (i < 28) dstPts.push(applyH(Htrue, p[0], p[1]));
    else dstPts.push([rng() * 120, rng() * 100]);
  }
  const ran = ransacHomography(srcPts, dstPts, { threshold: 1.5, seed: 3 });
  check("RANSAC survives 30% outliers", !!ran && ran.inlierRatio >= 0.6, `ratio=${ran?.inlierRatio}`);
  if (ran) {
    const e = [0, 40, 70].map((x) => {
      const [u, v] = applyH(ran.H, x, 20);
      const [gu, gv] = applyH(Htrue, x, 20);
      return Math.hypot(u - gu, v - gv);
    });
    check("RANSAC H matches truth", e.every((v) => v < 1), `err=${e.map((v) => v.toFixed(2)).join(",")}`);
  }
}

// --- 5. Corner-pin H derivation ------------------------------------------
{
  console.log("5. homography apply/invert");
  const src: Array<[number, number]> = [
    [0, 0],
    [1920, 0],
    [1920, 1080],
    [0, 1080],
  ];
  const dst: Array<[number, number]> = [
    [120, 80],
    [1700, 40],
    [1800, 1000],
    [80, 980],
  ];
  const H = dlt(src, dst)!;
  let max = 0;
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyH(H, src[i]![0], src[i]![1]);
    max = Math.max(max, Math.hypot(x - dst[i]![0], y - dst[i]![1]));
  }
  check("applyH(H, src_i) ≈ dst_i", max < 1e-2, `max=${max}`);
  const Hi = invertH(H)!;
  let back = 0;
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyH(Hi, dst[i]![0], dst[i]![1]);
    back = Math.max(back, Math.hypot(x - src[i]![0], y - src[i]![1]));
  }
  check("invertH round-trips", back < 1e-2, `max=${back}`);
  const I = identityH();
  const [ix, iy] = applyH(I, 12.5, 8);
  check("identityH is a no-op", ix === 12.5 && iy === 8);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall tracker checks passed");
