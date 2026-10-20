// Gaussian Blur calibration: toolbox `blur` (gaussian) radius → AE Gaussian
// Blur Blurriness (spec 091926_after-effects-handoff.md §14).
//
//   npx tsx scripts/ae-export-spike/calibrate/blur.mts [--work DIR]
//
// What AE 26.5 does, measured here:
// - Gaussian Blur ("ADBE Gaussian Blur 2") blurs in LINEAR light: it decodes
//   with a pure power γ ≈ 2.404 (not the piecewise sRGB curve), convolves,
//   and re-encodes — at 8 and 16 bpc, in a project with no working space. In
//   a linearized sRGB working space it linearizes AGAIN (effective γ ≈ 5.4).
// - The obsolete Gaussian Blur ("ADBE Gaussian Blur") blurs the encoded
//   values (gamma space) and has no Repeat Edge Pixels.
// So toolbox's default `linearize: on` (piecewise-sRGB linear light) is the
// one Gaussian Blur 2 can stand in for.
//
// 1. Transfer. Fine 2-level stripes blurred flat: the γ that explains each
//    output, for both effects, three project modes.
// 2. Kernels. A 1-px white line through each effect at many Blurriness values
//    (16 bpc, 16-bit straight PNG out); rows linearized with γ for Gaussian
//    Blur 2; σ per value by least squares → σ = k·B. Toolbox's kernel from
//    `blur` with linearize off (its kernel in its own convolution space).
// 3. The map. Blurriness = σ_toolbox(radius) / k: proven linear by R² and
//    residuals; toolbox's 64-tap cap bends it above radius ≈ 42.7.
// 4. Validation. A hard-edged disc, a 1-px line grid, a photo-like noise
//    texture and a transparent disc through both at the mapped Blurriness,
//    8 and 16 bpc; compareRgba metrics.
//
// Writes calibrate/measured/blur.json, from which check-calibration
// re-derives γ, k and the map.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE } from "./ae.mts";
import { fitGaussianSigma, fitPowerGamma, linearFit, proportionalFit } from "./fit.mts";
import { blank, discImage, fill, gridImage, lineImage, metrics, noiseImage, oneNode, renderAe, renderTbx, round, row, savePng, summary, writePng16, type AeItem, type FloatImage } from "./lib.mts";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-blur-${Date.now()}`);
mkdirSync(WORK, { recursive: true });
console.log(`work: ${WORK}`);

const GB2 = "ADBE Gaussian Blur 2";
const GB1 = "ADBE Gaussian Blur";
// Blur Dimensions 1 = horizontal and vertical, 2 = horizontal.
const gb2 = (b: number, dims = 1) => ({ match: GB2, props: { [`${GB2}-0001`]: b, [`${GB2}-0002`]: dims, [`${GB2}-0003`]: 1 } });
const gb1 = (b: number, dims = 1) => ({ match: GB1, props: { [`${GB1}-0001`]: b, [`${GB1}-0002`]: dims } });
const key = (v: number) => String(v).replace(".", "p");

// ---- 1. transfer -----------------------------------------------------------------

const PAIRS: [number, number][] = [[0, 1], [0, 0.8], [0, 0.6], [0, 0.4], [0, 0.2], [0, 0.1], [0, 0.05], [0.5, 1], [0.25, 0.75], [0.2, 0.4]];
const pairName = ([a, b]: [number, number]) => `p${Math.round(a * 1000)}_${Math.round(b * 1000)}`;
const stripeItems: AeItem[] = [];
for (const p of PAIRS) {
  const file = join(WORK, `${pairName(p)}.png`);
  await writePng16(fill(blank(128, 8), (x) => (x % 2 ? [p[1], p[1], p[1], 1] : [p[0], p[0], p[0], 1])), file);
  stripeItems.push({ name: `${pairName(p)}_gb2`, w: 128, h: 8, frames: [0], layers: [{ name: "img", image: file, effects: [gb2(30, 2)] }] });
  stripeItems.push({ name: `${pairName(p)}_gb1`, w: 128, h: 8, frames: [0], layers: [{ name: "img", image: file, effects: [gb1(30, 2)] }] });
}
const MODES = [
  { key: "none16", bpc: 16 as const },
  { key: "none8", bpc: 8 as const },
  { key: "linear16", bpc: 16 as const, workingSpace: "sRGB IEC61966-2.1", linearize: true },
];
const q8 = (v: number) => Math.round(v * 255) / 255;
const transfer: Record<string, { pair: [number, number]; gb2: number; gb1: number; gammaGb2: number; gammaGb1: number }[]> = {};
for (const m of MODES) {
  const r = await renderAe("tf", stripeItems, { work: WORK, ...m });
  transfer[m.key] = PAIRS.map((p) => {
    const v2 = r.images.get(`${pairName(p)}_gb2_f0`)!.data[(4 * 128 + 64) * 4];
    const v1 = r.images.get(`${pairName(p)}_gb1_f0`)!.data[(4 * 128 + 64) * 4];
    return { pair: p, gb2: round(v2, 6), gb1: round(v1, 6), gammaGb2: round(fitPowerGamma(q8(p[0]), q8(p[1]), v2), 5), gammaGb1: round(fitPowerGamma(q8(p[0]), q8(p[1]), v1), 5) };
  });
  console.log(`transfer ${m.key}: γ(GB2) ${transfer[m.key].map((t) => t.gammaGb2).join(" ")} | γ(GB1) ${transfer[m.key].map((t) => t.gammaGb1).join(" ")}`);
}
// γ of Gaussian Blur 2: the median over the 16 bpc pairs away from black.
const g16 = transfer.none16.filter((t) => t.pair[1] >= 0.2).map((t) => t.gammaGb2).sort((a, b) => a - b);
const GAMMA = g16[Math.floor(g16.length / 2)];
console.log(`Gaussian Blur 2 γ = ${GAMMA}`);

// ---- 2. kernels -------------------------------------------------------------------

const LW = 1024;
const LH = 4;
const X0 = LW / 2;
const line = lineImage(LW, LH, X0);
const linePng = join(WORK, "line.png");
await writePng16(line, linePng);
const BS = [1, 1.5, 2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120];
const RADII = [1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 42, 48, 60, 80];

const kernelItems: AeItem[] = [];
for (const b of BS) {
  kernelItems.push({ name: `k2_${key(b)}`, w: LW, h: LH, frames: [0], layers: [{ name: "img", image: linePng, effects: [gb2(b, 2)] }] });
  kernelItems.push({ name: `k1_${key(b)}`, w: LW, h: LH, frames: [0], layers: [{ name: "img", image: linePng, effects: [gb1(b, 2)] }] });
}
const aeK = await renderAe("blurk", kernelItems, { work: WORK, bpc: 16 });

function kernelOf(img: FloatImage, gamma: number) {
  const p = row(img, Math.floor(LH / 2), 0).map((v) => v ** gamma);
  const sum = p.reduce((a, b) => a + b, 0);
  const l = fitGaussianSigma(p.map((v) => v / sum), X0);
  const half = Math.min(X0, Math.ceil(4.5 * Math.max(1, l.sigma)) + 2);
  return { sigma: l.sigma, sum, gaussRms: l.rms, window: [X0 - half, X0 + half] as [number, number], profile: row(img, Math.floor(LH / 2), 0).slice(X0 - half, X0 + half + 1) };
}
const gb2Kernels = BS.map((b) => ({ blurriness: b, ...kernelOf(aeK.images.get(`k2_${key(b)}_f0`)!, GAMMA) }));
const gb1Kernels = BS.map((b) => ({ blurriness: b, ...kernelOf(aeK.images.get(`k1_${key(b)}_f0`)!, 1) }));
for (const [name, ks] of [["Gaussian Blur 2 (linearized γ)", gb2Kernels], ["Gaussian Blur (obsolete)", gb1Kernels]] as const) {
  console.log(`${name}: B → σ`);
  for (const k of ks) console.log(`  B ${String(k.blurriness).padStart(5)}  σ ${k.sigma.toFixed(4)}  σ/B ${(k.sigma / k.blurriness).toFixed(5)}  sum ${k.sum.toFixed(4)}  rms ${k.gaussRms.toExponential(2)}`);
}

const tbk = await renderTbx("blurk", { width: LW, height: LH }, [{ slot: "line", image: line }], RADII.map((r) => oneNode(`r${key(r)}`, "blur", { mode: "gaussian", radius: r, linearize: false }, "line")), WORK);
const tbKernels = RADII.map((r) => ({ radius: r, ...kernelOf(tbk.get(`r${key(r)}_f0`)!, 1) }));
console.log("toolbox blur: r → σ");
for (const k of tbKernels) console.log(`  r ${String(k.radius).padStart(5)}  σ ${k.sigma.toFixed(4)}  σ/r ${(k.sigma / k.radius).toFixed(5)}`);

// ---- 3. the maps --------------------------------------------------------------------

const fitAe = (ks: { blurriness: number; sigma: number }[]) => {
  const set = ks.filter((k) => k.blurriness >= 4);
  return { prop: proportionalFit(set.map((k) => k.blurriness), set.map((k) => k.sigma)), affine: linearFit(set.map((k) => k.blurriness), set.map((k) => k.sigma)) };
};
const f2 = fitAe(gb2Kernels);
const f1 = fitAe(gb1Kernels);
const tbSet = tbKernels.filter((k) => k.radius >= 2 && k.radius <= 42);
const ftb = proportionalFit(tbSet.map((k) => k.radius), tbSet.map((k) => k.sigma));
const scale2 = ftb.a / f2.prop.a;
const scale1 = ftb.a / f1.prop.a;
const perRadius = tbKernels.map((k) => ({ radius: k.radius, gb2: round(k.sigma / f2.prop.a, 5), gb1: round(k.sigma / f1.prop.a, 5) }));
const map2 = linearFit(tbSet.map((k) => k.radius), tbSet.map((k) => k.sigma / f2.prop.a));
console.log(`GB2: σ = ${f2.prop.a.toFixed(6)}·B (affine ${f2.affine.a.toFixed(6)}·B + ${f2.affine.b.toFixed(5)}, R² ${f2.affine.r2}, max rel residual ${(f2.prop.maxRelResidual * 100).toFixed(3)}%)`);
console.log(`GB1: σ = ${f1.prop.a.toFixed(6)}·B (affine ${f1.affine.a.toFixed(6)}·B + ${f1.affine.b.toFixed(5)}, R² ${f1.affine.r2}, max rel residual ${(f1.prop.maxRelResidual * 100).toFixed(3)}%)`);
console.log(`toolbox: σ = ${ftb.a.toFixed(6)}·r for 2 ≤ r ≤ 42 (max rel residual ${(ftb.maxRelResidual * 100).toFixed(3)}%)`);
console.log(`map: Blurriness(GB2) = ${scale2.toFixed(5)}·radius (affine ${map2.a.toFixed(5)}·r + ${map2.b.toFixed(5)}, R² ${map2.r2}); Blurriness(GB1) = ${scale1.toFixed(5)}·radius`);

// ---- 4. validation -----------------------------------------------------------------

const VW = 384;
const VH = 256;
const images: Record<string, FloatImage> = {
  disc: discImage(VW, VH, 70),
  grid: gridImage(VW, VH, 16),
  noise: noiseImage(VW, VH, 11),
  alphaDisc: discImage(VW, VH, 70, { transparent: true, color: [1, 0.6, 0.2] }),
};
const pngs: Record<string, string> = {};
for (const [k, img] of Object.entries(images)) {
  pngs[k] = join(WORK, `${k}.png`);
  await writePng16(img, pngs[k]);
}
const VR = [1, 2, 4, 8, 16, 32, 42, 60];
const vid = (img: string, r: number, fx: string) => `${img}_r${key(r)}_${fx}`;
const validItems: AeItem[] = [];
for (const img of Object.keys(images))
  for (const r of VR) {
    validItems.push({ name: vid(img, r, "gb2"), w: VW, h: VH, frames: [0], layers: [{ name: "img", image: pngs[img], effects: [gb2(scale2 * r)] }] });
    validItems.push({ name: vid(img, r, "gb1"), w: VW, h: VH, frames: [0], layers: [{ name: "img", image: pngs[img], effects: [gb1(scale1 * r)] }] });
  }
const ae = { 16: await renderAe("blurv", validItems, { work: WORK, bpc: 16 }), 8: await renderAe("blurv", validItems, { work: WORK, bpc: 8 }) };
const tbRenders = [];
for (const img of Object.keys(images))
  for (const r of VR) for (const lin of [true, false]) tbRenders.push(oneNode(`${img}_r${key(r)}_${lin ? "lin" : "gam"}`, "blur", { mode: "gaussian", radius: r, linearize: lin }, img));
const tbv = await renderTbx("blurv", { width: VW, height: VH }, Object.entries(images).map(([slot, image]) => ({ slot, image })), tbRenders, WORK);

const validation: Record<string, unknown>[] = [];
mkdirSync(join(WORK, "png"), { recursive: true });
for (const img of Object.keys(images))
  for (const r of VR)
    for (const bpc of [16, 8] as const)
      for (const [fx, lin] of [["gb2", true], ["gb1", false]] as const) {
        const a = ae[bpc].images.get(`${vid(img, r, fx)}_f0`);
        const t = tbv.get(`${img}_r${key(r)}_${lin ? "lin" : "gam"}_f0`);
        if (!a || !t) continue;
        const full = metrics(t, a);
        // Interior: away from the frame edge, where the obsolete effect's
        // missing Repeat Edge Pixels shows.
        const border = Math.min(Math.floor(VH / 2) - 8, Math.ceil(1.5 * r) + 2);
        const inner = metrics(t, a, border);
        validation.push({ image: img, radius: r, effect: fx, blurriness: round((fx === "gb2" ? scale2 : scale1) * r, 4), bpc, ...summary(full), interior: { border, ...summary(inner) } });
        if (bpc === 16 && (r === 8 || r === 42) && img !== "alphaDisc") {
          await savePng(a, join(WORK, "png", `${img}_r${r}-${fx}.png`));
          await savePng(t, join(WORK, "png", `${img}_r${r}-tbx-${lin ? "lin" : "gam"}.png`));
        }
      }
console.log("validation: toolbox linearize on ↔ GB2, linearize off ↔ GB1 (obsolete), at the mapped Blurriness");
for (const v of validation) {
  const i = v.interior as Record<string, unknown>;
  console.log(`  ${String(v.image).padEnd(9)} r ${String(v.radius).padStart(3)} ${v.effect} ${v.bpc}  mean ${v.meanAbs}  p95 ${v.p95Abs}  α ${v.alphaMeanAbs}  max ${v.floatMax}  ${v.verdict}  | interior mean ${i.meanAbs} p95 ${i.p95Abs} max ${i.floatMax} ${i.verdict}`);
}

mkdirSync(join(HERE, "measured"), { recursive: true });
writeFileSync(
  join(HERE, "measured", "blur.json"),
  JSON.stringify(
    {
      ae: "26.5x89",
      measured: new Date().toISOString().slice(0, 10),
      method:
        "AE: project working space None, linearBlending off; 1-px line on black 1024×4, Blur Dimensions horizontal, Repeat Edge Pixels on (GB2), 16 bpc rendered with _HIDDEN X-Factor 16 (16-bit straight PNG). GB2 rows linearized with the measured γ before the σ fit; GB1 rows used as is. Toolbox: blur gaussian, linearize off (its kernel in its own convolution space). σ = least-squares unit-sum sampled Gaussian centred on the line.",
      lineX: X0,
      transfer,
      gammaGb2: GAMMA,
      gb2Kernels: gb2Kernels.map((k) => ({ blurriness: k.blurriness, sigma: round(k.sigma, 6), gaussRms: k.gaussRms, window: k.window, profile: k.profile.map((v) => round(v, 7)) })),
      gb1Kernels: gb1Kernels.map((k) => ({ blurriness: k.blurriness, sigma: round(k.sigma, 6), gaussRms: k.gaussRms, window: k.window, profile: k.profile.map((v) => round(v, 7)) })),
      tbKernels: tbKernels.map((k) => ({ radius: k.radius, sigma: round(k.sigma, 6), window: k.window, profile: k.profile.map((v) => round(v, 7)) })),
      fit: {
        gb2SigmaPerBlurriness: round(f2.prop.a, 7),
        gb2MaxRelResidual: round(f2.prop.maxRelResidual, 6),
        gb2Affine: { a: round(f2.affine.a, 7), b: round(f2.affine.b, 6), r2: f2.affine.r2 },
        gb1SigmaPerBlurriness: round(f1.prop.a, 7),
        gb1MaxRelResidual: round(f1.prop.maxRelResidual, 6),
        tbSigmaPerRadius: round(ftb.a, 7),
        tbMaxRelResidual: round(ftb.maxRelResidual, 6),
        gb2BlurrinessPerRadius: round(scale2, 6),
        gb1BlurrinessPerRadius: round(scale1, 6),
        gb2MapAffine: { a: round(map2.a, 6), b: round(map2.b, 6), r2: map2.r2 },
        perRadius,
      },
      validation,
    },
    null,
    1
  ) + "\n"
);
console.log(`wrote ${join(HERE, "measured", "blur.json")}`);
