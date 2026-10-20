// The effect calibration and the AE-behaviour constants (spec
// 091926_after-effects-handoff.md §14), held offline: no After Effects here
// (CI is Linux). The measurements were made in AE 26.5 by
// scripts/ae-export-spike/calibrate/ and recorded in calibrate/measured/:
//
//   effects.json  app.effects, the property trees of the effects we use
//   blur.json     Gaussian Blur's transfer curve and kernels, toolbox's kernels
//   nodes.json    every effect-class node through toolbox and AE, compared
//   keys.json     keyed properties read back from AE (valueAtTime)
//   shapes.json   Round Corners and Polystar geometry, render-compared
//
// This gate asserts the maps in calibration.ts are well formed, every match
// name is one AE 26.5 reports (the list below), the recorded measurements
// still describe today's maps (the AE props they were made with are what the
// maps produce now), the recorded worst errors are the ones calibration.ts
// states, the blur map and the convert constants re-derive from the raw
// measurements, and the AE samples replay through convert/keys.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, makeChecker } from "./harness.mts";
import { sameUpToFloatNoise } from "../skia/snapshot-diff.ts";
import { fitGaussianSigma, fitPowerGamma, proportionalFit } from "../ae-export-spike/calibrate/fit.mts";
import { replayKeyTest, type KeyTest } from "../ae-export-spike/calibrate/keys-replay.mts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MEASURED = join(dirname(fileURLToPath(import.meta.url)), "../ae-export-spike/calibrate/measured");
const read = (f: string) => JSON.parse(readFileSync(join(MEASURED, f), "utf8"));

// Effect match names After Effects 26.5 (26.5x89) lists in app.effects
// (calibrate/effects.mts, 2026-10-20), with their display names. Every match
// name the export uses must be here. Corrections the listing made:
// "ADBE Linear Color Key" → "ADBE Linear Color Key2"; "ADBE VR Chromatic
// Aberrations" → "Mettle SkyBox Chromatic Aberrat" (a 360° effect, unused);
// "ADBE Levels2" → "ADBE Easy Levels2".
export const AE_26_5_EFFECTS: Record<string, string> = {
  "ADBE Gaussian Blur 2": "Gaussian Blur",
  "ADBE Camera Lens Blur": "Camera Lens Blur",
  "ADBE Mosaic": "Mosaic",
  "ADBE Geometry2": "Transform",
  "ADBE Posterize": "Posterize",
  "ADBE Threshold2": "Threshold",
  "ADBE Mirror": "Mirror",
  "ADBE Polar Coordinates": "Polar Coordinates",
  "ADBE Displacement Map": "Displacement Map",
  "ADBE Glo2": "Glow",
  "VISINF Grain Implant": "Add Grain",
  "ADBE Noise": "Noise",
  "ADBE Find Edges": "Find Edges",
  "ADBE HUE SATURATION": "Hue/Saturation",
  "ADBE Brightness & Contrast 2": "Brightness & Contrast",
  "ADBE Sharpen": "Sharpen",
  "ADBE Unsharp Mask2": "Unsharp Mask",
  "ADBE Tile": "Motion Tile",
  "ADBE Echo": "Echo",
  "Mettle SkyBox Chromatic Aberrat": "VR Chromatic Aberrations",
  "ADBE Apply Color LUT2": "Apply Color LUT",
  "ADBE Linear Color Key2": "Linear Color Key",
  "ADBE Color Key": "Color Key",
  "ADBE Extract": "Extract",
  "Keylight 906": "Keylight (1.2)",
  "ADBE Bevel Alpha": "Bevel Alpha",
  "ADBE Ramp": "Gradient Ramp",
  "ADBE Shift Channels": "Shift Channels",
  "ADBE Offset": "Offset",
  "ADBE Easy Levels2": "Levels",
  "ADBE Emboss": "Emboss",
  "ADBE Color Emboss": "Color Emboss",
  "ADBE Exposure2": "Exposure",
  "ADBE Tint": "Tint",
  "ADBE Fill": "Fill",
  "ADBE Invert": "Invert",
  "ADBE Set Matte3": "Set Matte",
  "ADBE CHANNEL MIXER": "Channel Mixer",
  "ADBE Pro Levels2": "Levels (Individual Controls)",
  "CC Threshold RGB": "CC Threshold RGB",
};
// Adding these from a script opens a modal dialog (aerender's core hangs).
const DIALOG_ON_APPLY = ["ADBE Apply Color LUT2"];

export default async function (): Promise<number> {
  const c = makeChecker("calibration");
  await loadRegistry();
  const { getNodeDef } = await import("@/engine/registry");
  const cal = await import("@/lib/ae-export/calibration");
  const { AE_EXPORT_CLASSES } = await import("@/lib/ae-export/classes");
  const { AE_COLOR_EASE_SCALE, AE_SHAPE_EASE_MAGNITUDE } = await import("@/lib/ae-export/convert/keys");
  const { AE_ROUND_CORNER_KAPPA } = await import("@/lib/ae-export/convert/coords");
  const { AE_EFFECT_MAPS, aeEffectsFor, resolveAeEffectMap } = cal;

  // ---- 1. match names ------------------------------------------------------------
  const effects = read("effects.json");
  c.check(`effects.json is AE 26.5 (${effects.ae}, ${effects.installed} effects installed)`, /^26\.5/.test(effects.ae) && effects.installed >= 400);
  const recordedNames = Object.keys(effects.verified).sort();
  c.check("the verified list here is the one effects.json recorded", JSON.stringify(recordedNames) === JSON.stringify(Object.keys(AE_26_5_EFFECTS).sort()));
  const displayOff = Object.entries(AE_26_5_EFFECTS).filter(([m, d]) => effects.verified[m]?.displayName !== d);
  c.check("…with the same display names", displayOff.length === 0, displayOff.map(([m]) => m).join(", "));
  const steps = (m: any): any[] => [...(m.before ?? []), m, ...(m.then ?? [])];
  const allMaps = Object.values(AE_EFFECT_MAPS).flatMap((m: any) => [m, ...(m.variants ?? [])]);
  const usedMatches = new Set(allMaps.flatMap((m) => steps(m).map((s) => s.match)));
  const unknown = [...usedMatches].filter((m) => !(m in AE_26_5_EFFECTS));
  c.check(`every effect the maps add is in AE 26.5's list (${usedMatches.size}: ${[...usedMatches].join(", ")})`, unknown.length === 0, unknown.join(", "));
  c.check("no map adds an effect that opens a dialog on apply (Apply Color LUT)", ![...usedMatches].some((m) => DIALOG_ON_APPLY.includes(m)));
  const classAe = Object.entries(AE_EXPORT_CLASSES as Record<string, { ae?: string; class: string }>).filter(([, e]) => e.ae && !/^(shape:|layer:|mask:|expression|TBX )/.test(e.ae));
  const classUnknown = classAe.filter(([, e]) => !(e.ae! in AE_26_5_EFFECTS)).map(([t, e]) => `${t}: ${e.ae}`);
  c.check(`every effect match name in classes.ts is in AE 26.5's list (${classAe.length} entries)`, classUnknown.length === 0, classUnknown.join(", "));

  // ---- 2. the maps are well formed -------------------------------------------------
  const malformed: string[] = [];
  for (const [type, m] of Object.entries(AE_EFFECT_MAPS) as [string, any][]) {
    if (m.type !== type) malformed.push(`${type}: type ${m.type}`);
    for (const v of [m, ...(m.variants ?? [])]) {
      if (v.type !== type) malformed.push(`${type} variant ${v.match}: type ${v.type}`);
      if (!["exact", "approx"].includes(v.fidelity)) malformed.push(`${type} ${v.match}: fidelity ${v.fidelity}`);
      if (v.measured && (!v.note || !v.error)) malformed.push(`${type} ${v.match}: measured without a note and error`);
      if (!v.measured && !/uncalibrated|not measured/.test(v.note ?? "")) malformed.push(`${type} ${v.match}: unmeasured without saying so`);
      if (v.applies && !v.refusal) malformed.push(`${type} ${v.match}: applies without a refusal reason`);
      for (const s of steps(v)) {
        const props = [...Object.keys(s.fixed ?? {}), ...Object.values(s.params ?? {}).map((p: any) => p.prop), ...(s.derived ?? []).map((d: any) => d.prop)];
        for (const p of props) if (!new RegExp(`^${s.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}$`).test(p)) malformed.push(`${type}: ${p} is not "${s.match}-NNNN"`);
        for (const [param, pm] of Object.entries(s.params ?? {}) as [string, any][]) {
          if (getNodeDef(type) && !getNodeDef(type)!.params.some((d) => d.name === param)) malformed.push(`${type}: no param ${param}`);
          if (pm.linear) {
            const ctx = { width: 1920, height: 1080, bitsPerChannel: 16 as const, fps: 30 };
            const { scale, offset } = pm.linear(ctx);
            // Inside every map's unclamped range.
            for (const x of [0.25, 0.37, 0.9]) if (Math.abs(pm.map(x, ctx) - (scale * x + offset)) > 1e-9 * Math.max(1, Math.abs(pm.map(x, ctx)))) malformed.push(`${type}.${param}: linear() disagrees with map() at ${x}`);
          }
        }
      }
    }
  }
  c.check(`${Object.keys(AE_EFFECT_MAPS).length} maps are well formed (props "<match>-NNNN", params exist, linear() ≡ map(), measured ⇒ note + error)`, malformed.length === 0, malformed.join("; "));
  const effectClass = Object.entries(AE_EXPORT_CLASSES as Record<string, { class: string; ae?: string }>).filter(([, e]) => e.class === "effect" && e.ae && !e.ae.startsWith("layer:") && e.ae !== "ADBE Ramp");
  const unmapped = effectClass.filter(([t]) => !AE_EFFECT_MAPS[t]).map(([t]) => t);
  c.check(`every effect-class node naming an AE effect has a map (${effectClass.length})`, unmapped.length === 0, unmapped.join(", "));
  const mismatch = effectClass.filter(([t, e]) => AE_EFFECT_MAPS[t] && AE_EFFECT_MAPS[t].match !== e.ae).map(([t, e]) => `${t}: ${e.ae} vs ${AE_EFFECT_MAPS[t].match}`);
  c.check("…and classes.ts names the map's own effect", mismatch.length === 0, mismatch.join(", "));

  // ---- 3. nodes.json still describes the maps ---------------------------------------
  const nodes = read("nodes.json");
  const defaults = (type: string) => Object.fromEntries(getNodeDef(type)!.params.map((p) => [p.name, p.default]));
  const drift: string[] = [];
  const refusals: string[] = [];
  // Worst error per map actually used (a variant has its own).
  const worst = new Map<any, { type: string; meanAbs: number; p95Abs: number; maxAbs: number; n: number }>();
  for (const [tag, suite] of Object.entries(nodes) as [string, any][]) {
    const ctx = { width: suite.size[0], height: suite.size[1], bitsPerChannel: 16 as const, fps: suite.fps ?? 30 };
    for (const r of suite.results) {
      const values = { ...defaults(suite.node), ...r.values };
      const res = resolveAeEffectMap(suite.node, values, ctx);
      const applies = !!res && "map" in res;
      // Suites that try their own AE settings record applies: false.
      if (r.applies) {
        if (!applies) {
          drift.push(`${tag}/${r.id}: the map no longer applies (${res && "refusal" in res ? res.refusal : "no map"})`);
          continue;
        }
        const map = (res as { map: any }).map;
        const now = aeEffectsFor(map, values, ctx);
        if (!sameUpToFloatNoise(JSON.stringify(now), JSON.stringify(r.ae), 1e-9)) drift.push(`${tag}/${r.id}: AE props changed since the measurement`);
        if (!worst.has(map)) worst.set(map, { type: suite.node, meanAbs: 0, p95Abs: 0, maxAbs: 0, n: 0 });
        const w = worst.get(map)!;
        // (Grain's pixels are a different random field; its statistics are
        // held below.)
        w.meanAbs = Math.max(w.meanAbs, r.meanAbs);
        w.p95Abs = Math.max(w.p95Abs, r.p95Abs);
        w.maxAbs = Math.max(w.maxAbs, r.max01);
        w.n++;
      } else if (r.refusal && applies) refusals.push(`${tag}/${r.id}: was refused (${r.refusal}), now applies`);
    }
  }
  c.check("every recorded case still maps to the AE props it was measured with", drift.length === 0, drift.join("; "));
  c.check("cases recorded as refused are still refused", refusals.length === 0, refusals.join("; "));
  const errorOff: string[] = [];
  for (const [m, w] of worst) {
    const type = `${w.type} (${m.match})`;
    const want = { meanAbs: Math.round(w.meanAbs * 1e4) / 1e4, p95Abs: Math.round(w.p95Abs * 1e4) / 1e4, maxAbs: Math.round(w.maxAbs * 1e4) / 1e4 };
    const have = m.error ? { meanAbs: m.error.meanAbs, p95Abs: m.error.p95Abs, maxAbs: m.error.maxAbs } : null;
    if (!have || !sameUpToFloatNoise(JSON.stringify(have), JSON.stringify(want), 1e-9)) errorOff.push(`${type}: calibration.ts says ${JSON.stringify(have)}, nodes.json's worst is ${JSON.stringify(want)}`);
    if (!m.measured) errorOff.push(`${type}: measured in nodes.json but measured: false`);
  }
  c.check(`each map's stated error is the worst recorded where it applies (${[...worst.values()].map((w) => w.type).join(", ")})`, errorOff.length === 0, errorOff.join("; "));
  const grainRuns = Object.values(nodes as Record<string, any>).filter((s) => s.node === "grain").flatMap((s) => s.results.filter((r: any) => r.applies && r.stats));
  const grainRel = Math.max(...grainRuns.map((r: any) => r.stats.maxRelStd));
  c.check(`grain: per-luminance-band std within 4% of toolbox's in every recorded case (worst ${(grainRel * 100).toFixed(1)}%)`, grainRuns.length > 0 && grainRel <= 0.04);
  c.check("…and both are white at 1 px (lag-1 autocorrelation of the residual |r| < 0.02 on flat grey)", grainRuns.filter((r: any) => r.id.includes("grey")).every((r: any) => Math.abs(r.stats.acf1[0]) < 0.02 && Math.abs(r.stats.acf1[1]) < 0.02));

  // ---- 4. the blur map re-derives from the recorded kernels ----------------------------
  const blur = read("blur.json");
  const g16 = blur.transfer.none16.filter((t: any) => t.pair[1] >= 0.2).map((t: any) => fitPowerGamma(Math.round(t.pair[0] * 255) / 255, Math.round(t.pair[1] * 255) / 255, t.gb2)).sort((a: number, b: number) => a - b);
  const gamma = g16[Math.floor(g16.length / 2)];
  c.near(`Gaussian Blur 2 blurs in a pure-power linear light: γ re-derived ${gamma.toFixed(4)} (recorded ${blur.gammaGb2})`, gamma, blur.gammaGb2, 2e-4);
  c.check("…the obsolete Gaussian Blur in gamma space (γ ≈ 1), and a linearized project double-linearizes Gaussian Blur 2 (γ > 4)", blur.transfer.none16.every((t: any) => Math.abs(t.gammaGb1 - 1) < 0.01) && blur.transfer.linear16.filter((t: any) => t.pair[1] >= 0.4).every((t: any) => t.gammaGb2 > 4));
  const sig = (k: any, gam: number) => {
    const p = k.profile.map((v: number) => v ** gam);
    const s = p.reduce((a: number, b: number) => a + b, 0);
    return fitGaussianSigma(p.map((v: number) => v / s), blur.lineX - k.window[0]).sigma;
  };
  const ks = blur.gb2Kernels.filter((k: any) => k.blurriness >= 4);
  const aeFit = proportionalFit(ks.map((k: any) => k.blurriness), ks.map((k: any) => sig(k, blur.gammaGb2)));
  const tbs = blur.tbKernels.filter((k: any) => k.radius >= 2 && k.radius <= 42);
  const tbFit = proportionalFit(tbs.map((k: any) => k.radius), tbs.map((k: any) => sig(k, 1)));
  // The recorded rows are windowed to ±4.5σ (the fit used the whole row), so
  // the re-derived σ agrees to ~1e-4, not to the last digit.
  c.near(`σ_AE = ${aeFit.a.toFixed(5)}·Blurriness re-derived from the recorded rows (recorded ${blur.fit.gb2SigmaPerBlurriness})`, aeFit.a, blur.fit.gb2SigmaPerBlurriness, 1e-4);
  c.near(`σ_toolbox = ${tbFit.a.toFixed(5)}·radius (≈ r/2; recorded ${blur.fit.tbSigmaPerRadius})`, tbFit.a, blur.fit.tbSigmaPerRadius, 1e-4);
  c.check(`…linear: max relative residual ${(blur.fit.gb2MaxRelResidual * 100).toFixed(2)}% (B ≥ 4), affine R² ${blur.fit.gb2MapAffine.r2.toFixed(9)}`, blur.fit.gb2MaxRelResidual < 0.025 && blur.fit.gb2MapAffine.r2 > 0.999999);
  c.near(`BLUR_BLURRINESS_PER_RADIUS ${cal.BLUR_BLURRINESS_PER_RADIUS} is blur.json's fit`, cal.BLUR_BLURRINESS_PER_RADIUS, blur.fit.gb2BlurrinessPerRadius, 1e-6);
  c.near(`…and σ_toolbox / σ_AE from the recorded rows (${(tbFit.a / aeFit.a).toFixed(5)}) to 0.1%`, cal.BLUR_BLURRINESS_PER_RADIUS, tbFit.a / aeFit.a, 1e-3 * cal.BLUR_BLURRINESS_PER_RADIUS);
  const blurMap = AE_EFFECT_MAPS.blur.params.radius;
  c.near("blur map: radius 10 → Blurriness 17.46349", blurMap.map(10, { width: 1920, height: 1080, bitsPerChannel: 16 }) as number, 17.46349, 1e-9);
  const blurV = blur.validation.filter((v: any) => v.effect === "gb2" && v.radius <= cal.BLUR_MAX_RADIUS);
  const bw = { meanAbs: Math.max(...blurV.map((v: any) => v.meanAbs)), p95Abs: Math.max(...blurV.map((v: any) => v.p95Abs)), maxAbs: Math.max(...blurV.map((v: any) => v.floatMax)) };
  const be = AE_EFFECT_MAPS.blur.error!;
  c.check(
    `blur's stated error is blur.json's worst validation (radius ≤ ${cal.BLUR_MAX_RADIUS.toFixed(2)}, 8 + 16 bpc): mean ${bw.meanAbs}, p95 ${bw.p95Abs}, max ${bw.maxAbs}`,
    Math.abs(be.meanAbs - bw.meanAbs) < 1e-3 && Math.abs(be.p95Abs - bw.p95Abs) < 1e-3 && Math.abs(be.maxAbs - bw.maxAbs) < 1e-3
  );
  c.check("blur refuses linearize off, bokeh, and radius past the 64-tap cap", ["linearize", "mode", "radius"].every((k) => {
    const v = { ...defaults("blur"), radius: 8, ...(k === "linearize" ? { linearize: false } : k === "mode" ? { mode: "bokeh" } : { radius: 60 }) };
    const r = resolveAeEffectMap("blur", v);
    return !!r && "refusal" in r;
  }));

  // ---- 5. the convert constants replay AE's samples -------------------------------------
  const keys = read("keys.json");
  c.check(`keys.json is AE 26.5 (${keys.ae}, ${keys.tests.length} keyed properties)`, /^26\.5/.test(keys.ae) && keys.tests.every((t: any) => Array.isArray(t.ae)));
  const tol: Record<string, number> = { scalar: 1e-6, color: 1e-6, path: 1e-4, position: 0.02 };
  const replayBad: string[] = [];
  let worstReplay: Record<string, number> = {};
  for (const t of keys.tests as (KeyTest & { ae: unknown[] })[]) {
    const r = replayKeyTest(t);
    worstReplay = { ...worstReplay, [t.kind]: Math.max(worstReplay[t.kind] ?? 0, r.maxError) };
    if (!(r.maxError <= tol[t.kind])) replayBad.push(`${t.id}: ${r.maxError}`);
  }
  c.check(`every AE sample replays through evaluateAeKeys / evaluateAePathProp (worst: ${Object.entries(worstReplay).map(([k, v]) => `${k} ${v}`).join(", ")})`, replayBad.length === 0, replayBad.join("; "));
  const colorMag = keys.tests.filter((t: any) => t.kind === "color" && t.keys[0].outInterp === "bezier" && !t.id.includes("neg") && !t.id.includes("cap")).map((t: any) => {
    const r = replayKeyTest(t);
    return r.aeMagnitude! / r.modelMagnitude!;
  });
  c.check(`one-ease color speeds are in 0–255 units: AE divides by ${colorMag.map((x: number) => x.toFixed(3)).join(" / ")} × |ΔRGB| (AE_COLOR_EASE_SCALE ${AE_COLOR_EASE_SCALE})`, AE_COLOR_EASE_SCALE === 255 && colorMag.every((x: number) => Math.abs(x - 255) < 0.01));
  const pathMag = keys.tests.filter((t: any) => t.kind === "path" && /grow-s(0\.5|1\.5)|move|tiny/.test(t.id)).map((t: any) => replayKeyTest(t).aeMagnitude!);
  c.check(`shape ease speeds are morph progress per second: AE magnitude ${pathMag.map((x: number) => x.toFixed(4)).join(" / ")} (AE_SHAPE_EASE_MAGNITUDE ${AE_SHAPE_EASE_MAGNITUDE})`, AE_SHAPE_EASE_MAGNITUDE === 1 && pathMag.every((x: number) => Math.abs(x - 1) < 1e-3));
  const infl = keys.tests.filter((t: any) => t.id.startsWith("infl-")).map((t: any) => ({ id: t.id, ...replayKeyTest(t) }));
  c.check(`influences summing past 100% play the plain cubic (125 / 150 / 190 %: |AE − cubic| ${infl.map((r: any) => r.plainCubic).join(" / ")}; rescaled would be ${infl.map((r: any) => r.rescaled).join(" / ")})`, infl.every((r: any) => r.plainCubic <= 1e-6) && infl.filter((r: any) => !r.id.includes("-100-")).every((r: any) => r.rescaled > 1));
  const neg = keys.tests.filter((t: any) => t.id.endsWith("-neg")).map((t: any) => t.aeEases[0].outEase[0][0]);
  c.check(`one-ease properties store negative speeds as 0 (color, path, Position read back ${neg.join(" / ")})`, neg.length === 3 && neg.every((s: number) => s === 0));

  // ---- 6. Round Corners and Polystar geometry --------------------------------------------
  const shapes = read("shapes.json");
  c.check(`Round Corners κ = ${AE_ROUND_CORNER_KAPPA}, as measured (shapes.json κ ${shapes.kappa})`, shapes.kappa === AE_ROUND_CORNER_KAPPA);
  const rcWorst = Math.max(...shapes.roundCorners.map((r: any) => r.aeVsLottie.areaPx2));
  c.check(`AE's Round Corners ≡ the lottie model at κ ${AE_ROUND_CORNER_KAPPA} on ${shapes.roundCorners.map((r: any) => r.shape).join(", ")} (worst ${rcWorst} px² of coverage)`, rcWorst <= 0.05);
  const scan = (shapes.kappaScan ?? []) as { shape: string; kappa: number; signedAreaPx2: number }[];
  const crossing = ["square", "triangle"].map((s) => {
    const rows = scan.filter((r) => r.shape === s).sort((a, b) => a.kappa - b.kappa);
    const i = rows.findIndex((r, k) => k > 0 && rows[k - 1].signedAreaPx2 > 0 && r.signedAreaPx2 <= 0);
    if (i < 1) return NaN;
    const a = rows[i - 1];
    const b = rows[i];
    return a.kappa + ((b.kappa - a.kappa) * a.signedAreaPx2) / (a.signedAreaPx2 - b.signedAreaPx2);
  });
  c.check(`…the κ scan's zero crossings sit at ${crossing.map((x) => x.toFixed(4)).join(" / ")}`, crossing.every((x) => Math.abs(x - AE_ROUND_CORNER_KAPPA) < 0.0015));
  c.check("planCorners bakes every shape where AE's Round Corners is not toolbox's fillet", shapes.roundCorners.every((r: any) => (r.plan === "uniform") === r.aeVsToolbox.areaPx2 < 100));
  c.check(
    `Polystar ≡ toolbox polygon / star: point 0 at 12 o'clock + rotation, clockwise (${shapes.polystar.map((p: any) => p.shape).join(", ")}: fill ≤ ${Math.max(...shapes.polystar.map((p: any) => p.fill.areaPx2))} px², trimmed stroke identical)`,
    shapes.polystar.every((p: any) => p.fill.areaPx2 <= 0.1 && p.trimmed.areaPx2 <= 0.1 && p.aeTrimCentroid.join() === p.toolboxTrimCentroid.join())
  );

  return c.failures;
}
