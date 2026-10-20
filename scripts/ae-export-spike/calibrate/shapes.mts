// Geometry AE scripting cannot read back, measured by rendering
// (spec 091926_after-effects-handoff.md §14):
//
//   1. Round Corners: AE's modifier on a raw path vs the lottie-web model
//      convert/coords.ts assumes (aeRoundCornersPath) vs toolbox's own fillet
//      (roundCornersPerAnchor) — all three as filled shapes through AE's
//      rasterizer, so any difference is geometry.
//   2. Polystar: AE's polygon / star vs toolbox's `polygon` / `star` vertices
//      as a plain path, with and without a short Trim Paths stroke (which
//      shows where point 0 sits and which way the path runs).
//
//   npx tsx scripts/ae-export-spike/calibrate/shapes.mts [--work DIR]
//
// Writes calibrate/measured/shapes.json (the metrics per case).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, readAeFrame, renderQueue, renderedFile, runAeJob } from "./ae.mts";
import { AE_ROUND_CORNER_KAPPA, aeRoundCornersPath, planCorners, splineToAePaths } from "@/lib/ae-export/convert/coords";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import type { SplineSubpath } from "@/engine/types";
import type { AePath } from "@/lib/ae-export/types";
import { round, savePng, type FloatImage } from "./lib.mts";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-shapes-${Date.now()}`);
mkdirSync(join(WORK, "renders"), { recursive: true });
const W = 1000;
const canvas = { width: W, height: W };
const WHITE = [1, 1, 1, 1];

// ---- Round Corners -----------------------------------------------------------

// Shapes in px; toolbox anchors in canvas01 (px / W on a square comp).
const poly = (pts: [number, number][], closed = true): SplineSubpath => ({ anchors: pts.map((p) => ({ pos: [p[0] / W, p[1] / W] as [number, number] })), closed });
const regular = (n: number, r: number, rot = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + rot + (i / n) * 2 * Math.PI;
    return [500 + r * Math.cos(a), 500 + r * Math.sin(a)];
  });
const RC: { name: string; sub: SplineSubpath; radius: number }[] = [
  { name: "square", sub: poly([[200, 200], [800, 200], [800, 800], [200, 800]]), radius: 100 },
  { name: "triangle", sub: poly(regular(3, 380)), radius: 100 },
  { name: "pentagon", sub: poly(regular(5, 350)), radius: 80 },
  { name: "thinRect", sub: poly([[200, 440], [800, 440], [800, 560], [200, 560]]), radius: 100 },
  { name: "lShape", sub: poly([[200, 200], [500, 200], [500, 500], [800, 500], [800, 800], [200, 800]]), radius: 90 },
  { name: "openZigzag", sub: poly([[150, 700], [350, 300], [550, 700], [750, 300], [850, 500]], false), radius: 60 },
];
const withRadius = (s: SplineSubpath, r: number): SplineSubpath => ({ ...s, anchors: s.anchors.map((a) => ({ ...a, cornerRadius: r / W })) });
const paint = (closed: boolean) => (closed ? [{ kind: "fill", color: WHITE }] : [{ kind: "stroke", color: WHITE, width: 6 }]);
const items: { name: string; layers: unknown[][] }[] = [];
for (const c of RC) {
  const raw = splineToAePaths({ subpaths: [c.sub] }, canvas)[0];
  const lottie = aeRoundCornersPath(raw, c.radius);
  const toolbox = splineToAePaths({ subpaths: roundCornersPerAnchor([withRadius(c.sub, c.radius)]) }, canvas)[0];
  items.push({ name: `rc_${c.name}_ae`, layers: [[{ kind: "path", path: raw }, { kind: "rc", radius: c.radius }, ...paint(c.sub.closed)]] });
  items.push({ name: `rc_${c.name}_lottie`, layers: [[{ kind: "path", path: lottie }, ...paint(c.sub.closed)]] });
  items.push({ name: `rc_${c.name}_toolbox`, layers: [[{ kind: "path", path: toolbox }, ...paint(c.sub.closed)]] });
}

// The handle constant: lottie's model with κ swept, against AE's modifier
// (the signed area difference crosses zero at AE's κ).
const KAPPAS = [0.53, 0.545, 0.55, 0.5519, 0.5523, 0.56];
const withKappa = (path: AePath, r: number, k: number): AePath => {
  const base = aeRoundCornersPath(path, r);
  // aeRoundCornersPath uses AE_ROUND_CORNER_KAPPA; rescale its handles.
  const f = k / AE_ROUND_CORNER_KAPPA;
  return { ...base, inTangents: base.inTangents.map(([x, y]) => [x * f, y * f]), outTangents: base.outTangents.map(([x, y]) => [x * f, y * f]) };
};
for (const c of RC.filter((x) => x.name === "square" || x.name === "triangle")) {
  const raw = splineToAePaths({ subpaths: [c.sub] }, canvas)[0];
  for (const k of KAPPAS) items.push({ name: `rck_${c.name}_${k}`, layers: [[{ kind: "path", path: withKappa(raw, c.radius, k) }, { kind: "fill", color: WHITE }]] });
}

// ---- Polystar ------------------------------------------------------------------

const PS: { name: string; type: "polygon" | "star"; points: number; outer: number; inner?: number; rotationDeg: number }[] = [
  { name: "pent0", type: "polygon", points: 5, outer: 320, rotationDeg: 0 },
  { name: "hex17", type: "polygon", points: 6, outer: 320, rotationDeg: 17 },
  { name: "star5", type: "star", points: 5, outer: 340, inner: 140, rotationDeg: 0 },
  { name: "star7m40", type: "star", points: 7, outer: 340, inner: 180, rotationDeg: -40 },
];
// Toolbox's vertices (polygon.ts / star.ts): first at 12 o'clock (−90°) plus
// rotation, increasing angle = clockwise on a Y-down screen.
function toolboxPolystar(p: (typeof PS)[number]): AePath {
  const rot = (p.rotationDeg * Math.PI) / 180;
  const pts: [number, number][] = [];
  if (p.type === "polygon") pts.push(...regular(p.points, p.outer, rot));
  else
    for (let i = 0; i < 2 * p.points; i++) {
      const r = i % 2 === 0 ? p.outer : p.inner!;
      const a = -Math.PI / 2 + rot + (i * Math.PI) / p.points;
      pts.push([500 + r * Math.cos(a), 500 + r * Math.sin(a)]);
    }
  return splineToAePaths({ subpaths: [poly(pts)] }, canvas)[0];
}
const trim = { kind: "trim", start: 0, end: 7, offset: 0 };
for (const p of PS) {
  const star = { kind: "polystar", type: p.type, points: p.points, position: [500, 500], rotation: p.rotationDeg, outer: p.outer, inner: p.inner };
  const path = { kind: "path", path: toolboxPolystar(p) };
  items.push({ name: `ps_${p.name}_ae`, layers: [[star, { kind: "fill", color: WHITE }]] });
  items.push({ name: `ps_${p.name}_toolbox`, layers: [[path, { kind: "fill", color: WHITE }]] });
  items.push({ name: `ps_${p.name}_ae_trim`, layers: [[star, trim, { kind: "stroke", color: WHITE, width: 10 }]] });
  items.push({ name: `ps_${p.name}_toolbox_trim`, layers: [[path, trim, { kind: "stroke", color: WHITE, width: 10 }]] });
}

const project = join(WORK, "shapes.aep");
const r = await runAeJob("shapes", "shapes.jsx", { project, renders: join(WORK, "renders"), w: W, h: W, items }, WORK);
if (r.out.errors.length) console.log("AE errors:", r.out.errors);
const rq = await renderQueue(project, WORK);
console.log(`AE: build ${r.seconds.toFixed(1)} s, render ${rq.seconds.toFixed(1)} s`);
const img = async (name: string) => {
  const f = renderedFile(join(WORK, "renders"), `${name}_f0`);
  if (!f) throw new Error(`no render for ${name}`);
  return readAeFrame(f);
};

// Coverage difference: the symmetric-difference area (px², alpha) and the
// worst pixel. Area / boundary length ≈ the mean normal offset.
function coverage(a: FloatImage, b: FloatImage) {
  let area = 0;
  let max = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const d = Math.abs(a.data[i * 4 + 3] - b.data[i * 4 + 3]);
    area += d;
    if (d > max) max = d;
  }
  return { areaPx2: round(area, 2), maxPx: round(max, 4) };
}
// Centroid of the coverage (where a trimmed stroke sits).
function centroid(a: FloatImage): [number, number] {
  let s = 0;
  let x = 0;
  let y = 0;
  for (let j = 0; j < a.height; j++)
    for (let i = 0; i < a.width; i++) {
      const v = a.data[(j * a.width + i) * 4 + 3];
      s += v;
      x += v * (i + 0.5);
      y += v * (j + 0.5);
    }
  return [round(x / s, 2), round(y / s, 2)];
}

mkdirSync(join(WORK, "png"), { recursive: true });
const roundCorners: Record<string, unknown>[] = [];
for (const c of RC) {
  const ae = await img(`rc_${c.name}_ae`);
  const lottie = await img(`rc_${c.name}_lottie`);
  const tb = await img(`rc_${c.name}_toolbox`);
  const plan = planCorners({ subpaths: [withRadius(c.sub, c.radius)] }, canvas);
  const row = {
    shape: c.name,
    radiusPx: c.radius,
    aeVsLottie: coverage(ae, lottie),
    aeVsToolbox: coverage(ae, tb),
    plan: plan.kind,
    planDeviationPx: plan.kind === "uniform" ? round(plan.maxDeviationPx, 4) : undefined,
  };
  roundCorners.push(row);
  console.log(`RC ${c.name.padEnd(10)} AE vs lottie ${JSON.stringify(row.aeVsLottie)}  AE vs toolbox ${JSON.stringify(row.aeVsToolbox)}  planCorners → ${plan.kind}`);
  await savePng(ae, join(WORK, "png", `rc_${c.name}_ae.png`));
}
// Signed coverage difference AE − model (px²) per κ.
const kappaScan: Record<string, unknown>[] = [];
for (const c of RC.filter((x) => x.name === "square" || x.name === "triangle")) {
  const ae = await img(`rc_${c.name}_ae`);
  for (const k of KAPPAS) {
    const m = await img(`rck_${c.name}_${k}`);
    let signed = 0;
    for (let i = 0; i < ae.width * ae.height; i++) signed += ae.data[i * 4 + 3] - m.data[i * 4 + 3];
    kappaScan.push({ shape: c.name, kappa: k, signedAreaPx2: round(signed, 2) });
  }
}
console.log("κ scan (AE − model, px²):", kappaScan.map((r) => `${r.shape} ${r.kappa}: ${r.signedAreaPx2}`).join("  "));
const polystar: Record<string, unknown>[] = [];
for (const p of PS) {
  const ae = await img(`ps_${p.name}_ae`);
  const tb = await img(`ps_${p.name}_toolbox`);
  const aeT = await img(`ps_${p.name}_ae_trim`);
  const tbT = await img(`ps_${p.name}_toolbox_trim`);
  const row = { shape: p.name, type: p.type, points: p.points, rotationDeg: p.rotationDeg, fill: coverage(ae, tb), trimmed: coverage(aeT, tbT), aeTrimCentroid: centroid(aeT), toolboxTrimCentroid: centroid(tbT) };
  polystar.push(row);
  console.log(`PS ${p.name.padEnd(9)} fill ${JSON.stringify(row.fill)}  trim ${JSON.stringify(row.trimmed)}  trim centroid AE ${row.aeTrimCentroid} toolbox ${row.toolboxTrimCentroid}`);
  await savePng(aeT, join(WORK, "png", `ps_${p.name}_ae_trim.png`));
  await savePng(tbT, join(WORK, "png", `ps_${p.name}_toolbox_trim.png`));
}
mkdirSync(join(HERE, "measured"), { recursive: true });
writeFileSync(join(HERE, "measured", "shapes.json"), JSON.stringify({ ae: r.out.ae, measured: new Date().toISOString().slice(0, 10), comp: [W, W], kappa: AE_ROUND_CORNER_KAPPA, roundCorners, kappaScan, polystar }, null, 1) + "\n");
console.log(`work ${WORK}`);
