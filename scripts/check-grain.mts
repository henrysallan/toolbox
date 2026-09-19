// Guards Grain v2 (specdocs/091626_grain-node-v2.md), the pure half:
//   - the temporal moving-average kernel is unit-variance at EVERY fractional
//     grain time (Σw² = 1 — the anti-breathing rule; a plain lerp of two
//     noise frames dips to variance 0.5 at the midpoint),
//   - the kernel is shift-invariant, symmetric about the sample time, and
//     wraps seamlessly in looping mode,
//   - the cache key is one value per grain frame while the kernel is hard
//     and quantised continuous time while it is smooth,
//   - the CPU mirror of the shader's hash → sample draw has the right
//     statistics (mean 0, std 1, decorrelated channels / seeds / frames),
//   - saved nodes migrate to `classic`; the def declares the vocabulary.
//
//   npx tsx scripts/check-grain.mts

import {
  GRAIN_BANDING_AXES,
  GRAIN_BLUR_MAX_TAPS,
  GRAIN_DISTRIBUTIONS,
  GRAIN_FIXED_FRAME,
  GRAIN_FRAME_BIAS,
  GRAIN_KERNELS,
  GRAIN_KEY_QUANTUM,
  GRAIN_MAX_TAPS,
  GRAIN_MODELS,
  GRAIN_MOTIONS,
  GRAIN_PRESETS,
  GRAIN_PRESET_LOOKS,
  GRAIN_QUALITIES,
  GRAIN_RESPONSE_CURVES,
  GRAIN_RESPONSE_PRESETS,
  GRAIN_SIZE_UNITS,
  GRAIN_SPACES,
  buildGrainArTemplate,
  buildGrainResponseLut,
  grainArCoefficients,
  grainBlotchWeights,
  grainBlurWeights,
  grainDriftOffset,
  grainLinToLog,
  grainLogToLin,
  grainResolveLook,
  grainResponseCurve,
  grainResponseKey,
  grainSpaceGain,
  grainCellPx,
  grainFilmMu,
  grainFilmParams,
  grainKernel,
  grainLoopPeriod,
  grainOctaveSeed,
  grainOctaveWeights,
  grainProcessCpu,
  grainRate,
  grainSampleCpu,
  grainSensorWeights,
  grainTime,
  grainTimeKey,
  migrateGrainParams,
  normalizeGrainBandingAxis,
  normalizeGrainDistribution,
  normalizeGrainModel,
  normalizeGrainMotion,
  normalizeGrainSizeUnit,
  type GrainDistribution,
} from "../src/engine/grain.ts";
import { grainNode } from "../src/nodes/effect/grain.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function sumSq(w: number[]): number {
  let s = 0;
  for (const x of w) s += x * x;
  return s;
}

function stats(xs: number[]): { mean: number; std: number } {
  let m = 0;
  for (const x of xs) m += x;
  m /= xs.length;
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return { mean: m, std: Math.sqrt(v / (xs.length - 1)) };
}

function corr(a: number[], b: number[]): number {
  const sa = stats(a);
  const sb = stats(b);
  let c = 0;
  for (let i = 0; i < a.length; i++) c += (a[i] - sa.mean) * (b[i] - sb.mean);
  return c / ((a.length - 1) * sa.std * sb.std);
}

// ---------------------------------------------------------------------
// 1. Def vocabulary + defaults (design Q&A 2026-09-16: bare node = every frame)
// ---------------------------------------------------------------------
const pdef = (n: string) => grainNode.params.find((p) => p.name === n);
check(
  "model enum matches engine vocabulary",
  JSON.stringify(pdef("model")?.options) === JSON.stringify(GRAIN_MODELS)
);
check(
  "motion enum matches engine vocabulary",
  JSON.stringify(pdef("motion")?.options) === JSON.stringify(GRAIN_MOTIONS)
);
check(
  "distribution enum matches engine vocabulary",
  JSON.stringify(pdef("distribution")?.options) ===
    JSON.stringify(GRAIN_DISTRIBUTIONS)
);
check(
  "bare node defaults: fine model, animated, hard kernel (new grain every frame)",
  pdef("model")?.default === "fine" &&
    pdef("motion")?.default === "animated" &&
    pdef("smoothness")?.default === 0 &&
    pdef("rate")?.default === 0
);
check(
  "legacy params survive under their saved names",
  ["luminance", "chromatic", "scale", "seed", "mix_mode", "mix"].every(
    (n) => !!pdef(n)
  )
);
check(
  "grain aux output declared and output-gated",
  grainNode.auxOutputs.some((o) => o.name === "grain" && o.type === "image") &&
    grainNode.gatesOutputs === true
);
check("stays cacheable (no stable:false)", grainNode.stable !== false);
check(
  "facts declare the clock read + pixel units for scale",
  !!grainNode.facts?.reads?.includes("time") &&
    grainNode.facts?.space?.["param:scale"] === "pixels"
);

check(
  "size_unit enum matches engine vocabulary; soft params declared",
  JSON.stringify(pdef("size_unit")?.options) === JSON.stringify(GRAIN_SIZE_UNITS) &&
    !!pdef("size_um") &&
    !!pdef("aspect") &&
    !!pdef("softness") &&
    !!pdef("irregularity") &&
    (GRAIN_MODELS as readonly string[]).includes("soft")
);

// ---------------------------------------------------------------------
// 1b. Size units, soft-model blur + octaves (M2)
// ---------------------------------------------------------------------
{
  const px = grainCellPx(3, 20, "px", 1, 1920, 1080);
  check("px unit: cell = scale", close(px.basePx, 3) && close(px.cellW, 3) && close(px.cellH, 3));
  const rel = grainCellPx(2, 20, "1080p px", 1, 3840, 2160);
  check("1080p px unit scales with canvas height", close(rel.basePx, 4));
  const um35 = grainCellPx(1, 26, "um 35mm", 1, 1920, 1080);
  check(
    "um 35mm: 26 µm at 1920 px wide ≈ 2.0 px",
    Math.abs(um35.basePx - 2.0055) < 0.01,
    `${um35.basePx}`
  );
  const um8 = grainCellPx(1, 20, "um super 8", 1, 1920, 1080);
  check("um super 8: same grain is ~3.3× coarser than on 35mm", Math.abs(um8.basePx / um35.basePx - 24.89 / 5.79 / (26 / 20)) < 0.01);
  const asp = grainCellPx(4, 20, "px", 4, 1920, 1080);
  check(
    "aspect stretches cells with area preserved",
    close(asp.cellW, 8) && close(asp.cellH, 2)
  );
  const aspClamp = grainCellPx(1, 20, "px", 4, 1920, 1080);
  check("cells never shrink below one pixel", close(aspClamp.cellW, 2) && close(aspClamp.cellH, 1));
  check(
    "unknown size unit → px",
    normalizeGrainSizeUnit("furlongs") === "px" && normalizeGrainSizeUnit("um super 16") === "um super 16"
  );

  check("softness 0 → single unit tap", grainBlurWeights(0).taps === 1 && grainBlurWeights(0).weights[0] === 1);
  let blurOk = true;
  let blurDetail = "";
  for (const s of [0.3, 0.5, 1, 2, 5]) {
    const b = grainBlurWeights(s);
    const ss = sumSq(b.weights);
    const symmetric = b.weights.every((w, i) => close(w, b.weights[b.taps - 1 - i], 1e-12));
    const centrePeak = b.weights.indexOf(Math.max(...b.weights)) === (b.taps - 1) / 2;
    if (Math.abs(ss - 1) > 1e-9 || b.taps % 2 !== 1 || b.taps > GRAIN_BLUR_MAX_TAPS || !symmetric || !centrePeak) {
      blurOk = false;
    }
    blurDetail += `σ${s}: taps ${b.taps} Σw² ${ss.toFixed(6)}; `;
  }
  check("blur weights: Σw² = 1, odd symmetric taps, centre peak, σ clamped", blurOk, blurDetail);

  check("irregularity 0 → one octave", grainOctaveWeights(0).length === 1 && grainOctaveWeights(0)[0] === 1);
  const o1 = grainOctaveWeights(1);
  check(
    "irregularity 1 → three equal octaves with Σw² = 1",
    o1.length === 3 && o1.every((w) => close(w, 1 / Math.sqrt(3), 1e-12))
  );
  const oh = grainOctaveWeights(0.5);
  check(
    "irregularity 0.5 → decreasing weights (1, ρ, ρ²), Σw² = 1",
    oh.length === 3 && oh[0] > oh[1] && oh[1] > oh[2] && close(sumSq(oh), 1, 1e-12) && close(oh[1] / oh[0], 0.5, 1e-12)
  );
  check(
    "octave seeds differ and stay uint32",
    grainOctaveSeed(5, 0) === 5 && grainOctaveSeed(5, 1) !== 5 && grainOctaveSeed(5, 2) !== grainOctaveSeed(5, 1)
  );
}

// ---------------------------------------------------------------------
// 1b'. Film model parameters (M4)
// ---------------------------------------------------------------------
{
  check(
    "film model + quality declared",
    (GRAIN_MODELS as readonly string[]).includes("film") &&
      JSON.stringify(pdef("quality")?.options) === JSON.stringify(GRAIN_QUALITIES) &&
      !!pdef("density")
  );
  const fp = grainFilmParams(4, 0, 0.5, 1, 1);
  check(
    "film: radius is half the cell, search cell twice the max radius, edge = softness·radius",
    close(fp.radius, 2) && close(fp.sigmaLn, 0) && close(fp.cellSide, 4) && close(fp.edge, 1)
  );
  // At u = 0.5, σ = 0, density 1: μ = ln 2 · S² / (π r²) = 0.693 · 16 / (π · 4).
  check(
    "film: expected grains per cell at mid grey ≈ 0.88",
    Math.abs(grainFilmMu(0.5, fp) - (Math.LN2 * 16) / (Math.PI * 4)) < 1e-9 &&
      grainFilmMu(0.9, fp) > grainFilmMu(0.5, fp) &&
      grainFilmMu(0.1, fp) < grainFilmMu(0.5, fp)
  );
  const half = grainFilmParams(4, 0, 0.5, 1, 2);
  check("film: quality divisor halves the plate-space radius", close(half.radius, 1));
  const spread = grainFilmParams(4, 1, 0, 2, 1);
  check(
    "film: irregularity widens the cell for the largest radii, density scales μ, edge has an AA floor",
    spread.sigmaLn > 0 && spread.cellSide > fp.cellSide && close(spread.edge, 0.35) &&
      Math.abs(grainFilmMu(0.5, spread) / grainFilmMu(0.5, grainFilmParams(4, 1, 0, 1, 1)) - 2) < 1e-9
  );
  check("film: μ clamps its intensity so white never diverges", Number.isFinite(grainFilmMu(1, fp)) && Number.isFinite(grainFilmMu(0, fp)));
}

// ---------------------------------------------------------------------
// 1b''. Sensor / video / plate models (M5, M6)
// ---------------------------------------------------------------------
{
  check(
    "sensor, video and plate models declared with their params and the plate input",
    ["sensor", "video", "plate"].every((m) => (GRAIN_MODELS as readonly string[]).includes(m)) &&
      JSON.stringify(pdef("banding_axis")?.options) === JSON.stringify(GRAIN_BANDING_AXES) &&
      ["shot", "fixed_pattern", "banding", "blotch", "blotch_size", "streak", "line_jitter", "dropout", "plate_scale", "plate_center", "plate_gain", "plate_flips"].every((n) => !!pdef(n)) &&
      grainNode.inputs.some((i) => i.name === "plate" && i.type === "image")
  );
  const sw = grainSensorWeights(1, 0.5, 0.25);
  check(
    "sensor component weights renormalise to Σw² = 1 and keep their ratios",
    close(sumSq(sw), 1, 1e-12) && close(sw[1] / sw[0], 0.5, 1e-12) && close(sw[2] / sw[0], 0.25, 1e-12)
  );
  check("sensor with everything off falls back to pure shot noise", JSON.stringify(grainSensorWeights(0, 0, 0)) === JSON.stringify([1, 0, 0]));
  check(
    "blotch weights: 0 → base only, otherwise Σw² = 1",
    grainBlotchWeights(0).length === 1 && grainBlotchWeights(0.5).length === 2 && close(sumSq(grainBlotchWeights(0.5)), 1, 1e-12)
  );
  check(
    "fixed-pattern frame key sits outside every real frame key",
    GRAIN_FIXED_FRAME > GRAIN_FRAME_BIAS + 10_000_000 && GRAIN_FIXED_FRAME < 2 ** 31
  );
  check("banding axis normalises", normalizeGrainBandingAxis("columns") === "columns" && normalizeGrainBandingAxis("x") === "rows");
  check("video snow preset resolves to the video model", GRAIN_PRESET_LOOKS["video snow"].model === "video");
}

// ---------------------------------------------------------------------
// 1b'''. Parametric model, B-spline kernel, drift (M5, M6)
// ---------------------------------------------------------------------
{
  check(
    "parametric model, kernel enum and drift declared",
    (GRAIN_MODELS as readonly string[]).includes("parametric") &&
      !!pdef("correlation") &&
      JSON.stringify(pdef("kernel")?.options) === JSON.stringify(GRAIN_KERNELS) &&
      !!pdef("drift")
  );

  // B-spline kernel: four taps, Σw² = 1, shift-invariant, hard at σ = 0.
  const b0 = grainKernel(5.0, 1, 0, "bspline");
  const bh = grainKernel(5.5, 1, 0, "bspline");
  const b1 = grainKernel(6.5, 1, 0, "bspline");
  check(
    "bspline kernel: 4 taps, Σw² = 1, (1,4,1,0)/6 shape at integer time, shift-invariant",
    b0.taps === 4 &&
      close(sumSq(b0.weights), 1, 1e-12) &&
      close(b0.weights[1] / b0.weights[0], 4, 1e-9) &&
      close(b0.weights[3], 0, 1e-12) &&
      close(sumSq(bh.weights), 1, 1e-12) &&
      b1.frame0 === bh.frame0 + 1 &&
      bh.weights.every((w, i) => close(w, b1.weights[i], 1e-12)) &&
      grainKernel(5.5, 0, 0, "bspline").taps === 1
  );

  // AR coefficients.
  const iso = grainArCoefficients(0.6, 1);
  const ani = grainArCoefficients(0.6, 4);
  check(
    "AR coefficients: isotropic at aspect 1, stretched along x at aspect 4, off at 0",
    close(iso.rhoX, 0.6, 1e-9) && close(iso.rhoY, 0.6, 1e-9) &&
      ani.rhoX > 0.6 && ani.rhoY < 0.6 &&
      grainArCoefficients(0, 1).rhoX === 0
  );

  // AR template statistics (64² crop, hard kernel): unit variance, lag-1
  // autocorrelation ≈ ρ along both axes, channels independent.
  const size = 64;
  const rho = 0.5;
  const tpl = buildGrainArTemplate(grainKernel(3, 0, 0), 21, "gaussian", rho, rho, size, 16);
  check("AR template has the requested size", tpl.length === size * size * 4);
  let statsOk = true;
  let acOk = true;
  let indepOk = true;
  let detail = "";
  const ch: number[][] = [[], [], [], []];
  for (let i = 0; i < size * size; i++) for (let c = 0; c < 4; c++) ch[c].push(tpl[i * 4 + c]);
  for (let c = 0; c < 4; c++) {
    const s = stats(ch[c]);
    if (Math.abs(s.mean) > 0.15 || Math.abs(s.std - 1) > 0.25) statsOk = false;
    // lag-1 along x (skip the last column) and along y (skip the last row)
    const ax: number[] = [];
    const bx: number[] = [];
    const ay: number[] = [];
    const by: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = ch[c][y * size + x];
        if (x < size - 1) { ax.push(v); bx.push(ch[c][y * size + x + 1]); }
        if (y < size - 1) { ay.push(v); by.push(ch[c][(y + 1) * size + x]); }
      }
    }
    const rx = corr(ax, bx);
    const ry = corr(ay, by);
    if (Math.abs(rx - rho) > 0.08 || Math.abs(ry - rho) > 0.08) acOk = false;
    detail += `ch${c} std ${s.std.toFixed(3)} rx ${rx.toFixed(3)} ry ${ry.toFixed(3)}; `;
  }
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) if (Math.abs(corr(ch[a], ch[b])) > 0.1) indepOk = false;
  check("AR template: unit variance per channel", statsOk, detail);
  check("AR template: lag-1 autocorrelation ≈ ρ along x and y", acOk, detail);
  check("AR template: channels independent", indepOk);
  const white = buildGrainArTemplate(grainKernel(3, 0, 0), 21, "gaussian", 0, 0, 32, 4);
  check("AR template with ρ = 0 is plain white noise (std ≈ 1)", Math.abs(stats(Array.from(white.filter((_, i) => i % 4 === 0))).std - 1) < 0.1);

  // Drift.
  check("drift 0 is exactly no offset", JSON.stringify(grainDriftOffset(12.3, 0, 5)) === "[0,0]");
  const d0 = grainDriftOffset(12.3, 10, 5);
  const d1 = grainDriftOffset(12.31, 10, 5);
  const dStep = Math.hypot(d1[0] - d0[0], d1[1] - d0[1]);
  let bounded = true;
  for (let i = 0; i < 400; i++) {
    const d = grainDriftOffset(i * 0.25, 10, 5);
    if (Math.abs(d[0]) > 20 || Math.abs(d[1]) > 20) bounded = false;
  }
  check(
    "drift is smooth, bounded by ~2× its amplitude and deterministic",
    dStep < 0.5 && bounded && JSON.stringify(grainDriftOffset(7.7, 10, 5)) === JSON.stringify(grainDriftOffset(7.7, 10, 5))
  );
}

// ---------------------------------------------------------------------
// 1c. Application axis: space, response, presets (M3)
// ---------------------------------------------------------------------
{
  check(
    "space / response / preset enums match engine vocabulary",
    JSON.stringify(pdef("space")?.options) === JSON.stringify(GRAIN_SPACES) &&
      JSON.stringify(pdef("response_preset")?.options) === JSON.stringify(GRAIN_RESPONSE_PRESETS) &&
      JSON.stringify(pdef("preset")?.options) === JSON.stringify(GRAIN_PRESETS) &&
      pdef("preset")?.default === "custom" &&
      pdef("response")?.type === "float_curve"
  );

  // Log encode: 0 → 0, 4 → 1, round trip.
  check(
    "log encode maps linear 0..4 onto 0..1 and inverts",
    close(grainLinToLog(0), 0, 1e-9) &&
      close(grainLinToLog(4), 1, 1e-9) &&
      close(grainLogToLin(grainLinToLog(0.18)), 0.18, 1e-9)
  );
  // Space gains: display slope at mid grey ≈ 1.194, log slope ≈ 0.664.
  const gLin = grainSpaceGain("linear");
  const gLog = grainSpaceGain("log");
  check(
    "space gains keep display strength at mid grey (linear ≈ 0.84, log ≈ 0.56)",
    grainSpaceGain("display") === 1 && Math.abs(gLin - 0.837) < 0.01 && Math.abs(gLog - 0.556) < 0.01,
    `linear ${gLin.toFixed(4)} log ${gLog.toFixed(4)}`
  );

  // Response LUTs.
  const flat = buildGrainResponseLut(GRAIN_RESPONSE_CURVES.flat);
  check("flat response LUT is all ones", flat.every((v) => v === 255));
  const neg = buildGrainResponseLut(GRAIN_RESPONSE_CURVES.negative);
  check(
    "negative response falls monotonically from shadows to highlights",
    neg[0] === 255 && neg[255] < 60 && neg.every((v, i) => i === 0 || v <= neg[i - 1] + 1)
  );
  const print = buildGrainResponseLut(GRAIN_RESPONSE_CURVES.print);
  check("print response peaks in the midtones", print[128] === 255 && print[0] < 80 && print[255] < 80);
  const custom = grainResponseCurve("custom", [
    { id: "a", x: 0, y: 0.5 },
    { id: "b", x: 1, y: 0.5 },
  ]);
  check(
    "custom response sanitises and bakes",
    buildGrainResponseLut(custom).every((v) => Math.abs(v - 128) <= 1)
  );
  check(
    "custom response with garbage falls back to a flat multiplier",
    buildGrainResponseLut(grainResponseCurve("custom", "nonsense")).every((v) => v === 255)
  );
  check(
    "response cache key distinguishes presets and custom points",
    grainResponseKey("print", null) === "print" &&
      grainResponseKey("custom", custom) !== grainResponseKey("custom", GRAIN_RESPONSE_CURVES.flat)
  );

  // Presets resolve to valid looks; custom reads the params.
  let presetsOk = true;
  for (const name of GRAIN_PRESETS) {
    if (name === "custom") continue;
    const look = GRAIN_PRESET_LOOKS[name];
    const resolved = grainResolveLook({ preset: name, model: "classic", scale: 99 });
    if (
      !(GRAIN_MODELS as readonly string[]).includes(look.model) ||
      look.model === "classic" ||
      !(GRAIN_SIZE_UNITS as readonly string[]).includes(look.size_unit) ||
      !(GRAIN_SPACES as readonly string[]).includes(look.space) ||
      !(GRAIN_RESPONSE_PRESETS as readonly string[]).includes(look.response_preset) ||
      resolved.model !== look.model ||
      resolved.scale !== look.scale
    ) {
      presetsOk = false;
    }
  }
  check("every preset row is a valid v2 look and overrides the params", presetsOk);
  const custom2 = grainResolveLook({ preset: "custom", model: "soft", scale: 3, size_unit: "um super 8", size_um: 12, space: "log" });
  check(
    "custom look reads the params with defaults for the rest",
    custom2.model === "soft" && custom2.scale === 3 && custom2.size_unit === "um super 8" && custom2.size_um === 12 && custom2.space === "log" && custom2.softness === 0.5
  );
  check("a saved classic node resolves to classic under custom", grainResolveLook({ model: "classic" }).model === "classic");
}

// ---------------------------------------------------------------------
// 2. Migration + normalisers
// ---------------------------------------------------------------------
{
  const legacy: Record<string, unknown> = { luminance: 0.15, scale: 2, seed: 3 };
  migrateGrainParams(legacy);
  check("saved node without model → classic", legacy.model === "classic");
  const fresh: Record<string, unknown> = { model: "fine" };
  migrateGrainParams(fresh);
  check("explicit model untouched by migration", fresh.model === "fine");
  check(
    "unknown values normalise to the defaults",
    normalizeGrainModel("x") === "fine" &&
      normalizeGrainMotion(undefined) === "animated" &&
      normalizeGrainDistribution(3) === "gaussian" &&
      normalizeGrainModel("classic") === "classic" &&
      normalizeGrainMotion("looping") === "looping"
  );
}

// ---------------------------------------------------------------------
// 3. Clock
// ---------------------------------------------------------------------
check(
  "rate 0 / invalid → project fps",
  grainRate(0, 24) === 24 && grainRate(12, 24) === 12 && grainRate(undefined, 30) === 30
);
check("static grain time is evolution alone", grainTime("static", 500, 24, 24, 2.5) === 2.5);
check(
  "animated grain time = frame · rate / fps + evolution",
  close(grainTime("animated", 48, 24, 12, 1), 25) &&
    close(grainTime("looping", 10.5, 24, 24, 0), 10.5)
);
check(
  "loop period converts project frames → whole grain frames, ≥ 1",
  grainLoopPeriod(120, 24, 24) === 120 &&
    grainLoopPeriod(120, 12, 24) === 60 &&
    grainLoopPeriod(0, 24, 24) === 1
);

// ---------------------------------------------------------------------
// 4. Kernel
// ---------------------------------------------------------------------
{
  // Hard kernel: one tap, keyed on the integer grain frame.
  const hardA = grainKernel(3.9, 0, 0);
  const hardB = grainKernel(3.1, 0, 0);
  const hardC = grainKernel(4.0, 0, 0);
  check(
    "σ=0 is a single unit tap on floor(t)",
    hardA.taps === 1 &&
      hardA.weights.length === 1 &&
      close(hardA.weights[0], 1) &&
      hardA.frame0 === hardB.frame0 &&
      hardA.frame0 !== hardC.frame0 &&
      hardC.frame0 === hardA.frame0 + 1
  );
  const negA = grainKernel(-0.5, 0, 0);
  const negB = grainKernel(-0.9, 0, 0);
  const negC = grainKernel(0.1, 0, 0);
  check(
    "negative grain time keys distinct non-negative frames",
    negA.frame0 === negB.frame0 &&
      negA.frame0 !== negC.frame0 &&
      negA.frame0 >= 0 &&
      grainKernel(-123456, 0, 0).frame0 >= 0
  );

  // Smooth kernel: unit variance at every fractional time, for every σ.
  let worst = 0;
  let allEven = true;
  let allPositive = true;
  let tapsOk = true;
  let peakOk = true;
  for (const sigma of [0.2, 0.5, 1, 2, 3]) {
    const times: number[] = [];
    for (let i = 0; i <= 64; i++) times.push(i / 64);
    times.push(10.3, -3.7, 1234.5, -0.001);
    for (const t of times) {
      const k = grainKernel(t, sigma, 0);
      worst = Math.max(worst, Math.abs(sumSq(k.weights) - 1));
      if (k.taps !== k.weights.length || k.taps % 2 !== 0) allEven = false;
      if (k.taps > GRAIN_MAX_TAPS) tapsOk = false;
      if (k.weights.some((w) => !(w > 0))) allPositive = false;
      // The heaviest tap is one of the frames bracketing t — index K
      // (= floor(t)) or K+1 — and, away from an integer t (where the two
      // neighbours of the peak tie), the second heaviest is the other one.
      const K = k.taps / 2 - 1;
      const order = k.weights
        .map((w, i) => [w, i] as const)
        .sort((a, b) => b[0] - a[0])
        .map((x) => x[1]);
      if (order[0] !== K && order[0] !== K + 1) peakOk = false;
      const frac = t - Math.floor(t);
      if (frac > 1e-9 && frac < 1 - 1e-9) {
        const top = new Set([order[0], order[1]]);
        if (!top.has(K) || !top.has(K + 1)) peakOk = false;
      }
    }
  }
  check("Σw² = 1 at every fractional time and σ (anti-breathing)", worst < 1e-9, `worst |Σw²−1| = ${worst}`);
  check("smooth kernel has an even tap count 2K+2, all positive", allEven && allPositive);
  check(`taps never exceed GRAIN_MAX_TAPS (${GRAIN_MAX_TAPS}), σ clamped`, tapsOk && grainKernel(0.3, 10, 0).taps <= GRAIN_MAX_TAPS);
  check("the two heaviest taps are the frames bracketing t", peakOk);

  // Shift invariance: the same fractional position one frame later reuses
  // the weights with the window advanced by one hashed frame.
  const s0 = grainKernel(7.3, 1, 0);
  const s1 = grainKernel(8.3, 1, 0);
  check(
    "kernel is shift-invariant (t+1 ⇒ same weights, frame0+1)",
    s1.frame0 === s0.frame0 + 1 &&
      s0.weights.every((w, i) => close(w, s1.weights[i], 1e-12))
  );

  // Looping: frame0 lives in [0, L) and t + L reproduces t exactly.
  const L = 60;
  let loopOk = true;
  for (const sigma of [0, 0.7, 2]) {
    for (const t of [0, 0.4, 12.9, 59.99, 61.2, -5.5]) {
      const a = grainKernel(t, sigma, L);
      const b = grainKernel(t + L, sigma, L);
      if (a.loop !== L || a.frame0 < 0 || a.frame0 >= L) loopOk = false;
      if (a.frame0 !== b.frame0 || a.taps !== b.taps) loopOk = false;
      if (!a.weights.every((w, i) => close(w, b.weights[i], 1e-12))) loopOk = false;
    }
  }
  check("looping wraps frame0 into [0, L) and repeats exactly every L", loopOk);
}

// ---------------------------------------------------------------------
// 5. Cache key
// ---------------------------------------------------------------------
check(
  "hard kernel keys once per grain frame (60 Hz preview of 24 fps = 24 recomputes/s)",
  grainTimeKey(5.0, 0) === grainTimeKey(5.99, 0) &&
    grainTimeKey(6.0, 0) !== grainTimeKey(5.99, 0) &&
    grainTimeKey(-0.2, 0) === grainTimeKey(-0.9, 0)
);
check(
  "smooth kernel keys on quantised continuous time",
  grainTimeKey(5, 1) !== grainTimeKey(5 + GRAIN_KEY_QUANTUM, 1) &&
    grainTimeKey(5, 1) === grainTimeKey(5 + GRAIN_KEY_QUANTUM / 8, 1)
);

// ---------------------------------------------------------------------
// 6. CPU mirror statistics
// ---------------------------------------------------------------------
{
  const N = 20000;
  const cols = 200;
  const draw = (frame: number, seed: number, dist: GrainDistribution) => {
    const ch: number[][] = [[], [], [], []];
    for (let i = 0; i < N; i++) {
      const s = grainSampleCpu(i % cols, Math.floor(i / cols), frame, seed, dist);
      for (let c = 0; c < 4; c++) ch[c].push(s[c]);
    }
    return ch;
  };
  for (const dist of GRAIN_DISTRIBUTIONS) {
    const ch = draw(3, 7, dist);
    let meanOk = true;
    let stdOk = true;
    let detail = "";
    for (let c = 0; c < 4; c++) {
      const s = stats(ch[c]);
      if (Math.abs(s.mean) > 0.03) meanOk = false;
      if (Math.abs(s.std - 1) > 0.03) stdOk = false;
      detail += `ch${c} mean ${s.mean.toFixed(4)} std ${s.std.toFixed(4)}; `;
    }
    check(`${dist}: every channel has mean ≈ 0 and std ≈ 1`, meanOk && stdOk, detail);
    let corrOk = true;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        if (Math.abs(corr(ch[a], ch[b])) > 0.04) corrOk = false;
      }
    }
    check(`${dist}: channels are decorrelated`, corrOk);
    if (dist === "uniform") {
      check("uniform stays within ±√3", ch.every((c) => c.every((x) => Math.abs(x) <= Math.sqrt(3) + 1e-9)));
    }
    if (dist === "triangular") {
      check("triangular stays within ±√6", ch.every((c) => c.every((x) => Math.abs(x) <= Math.sqrt(6) + 1e-9)));
    }
  }
  const g7 = draw(3, 7, "gaussian");
  const g8 = draw(3, 8, "gaussian");
  const g7f4 = draw(4, 7, "gaussian");
  check("different seeds decorrelate", Math.abs(corr(g7[0], g8[0])) < 0.04);
  check("consecutive hashed frames decorrelate", Math.abs(corr(g7[0], g7f4[0])) < 0.04);
  check(
    "draw is deterministic",
    JSON.stringify(grainSampleCpu(17, 5, 9, 2, "gaussian")) ===
      JSON.stringify(grainSampleCpu(17, 5, 9, 2, "gaussian"))
  );
}

// ---------------------------------------------------------------------
// 7. The process itself: variance rule, smoothness, loop seam
// ---------------------------------------------------------------------
{
  const N = 4000;
  const cols = 80;
  const cell = (i: number): [number, number] => [i % cols, Math.floor(i / cols)];
  const processVar = (t: number, sigma: number, loop: number) => {
    const xs: number[] = [];
    const k = grainKernel(t, sigma, loop);
    for (let i = 0; i < N; i++) {
      const [x, y] = cell(i);
      xs.push(grainProcessCpu(x, y, k, 11, "gaussian")[0]);
    }
    const s = stats(xs);
    return s.std * s.std;
  };
  let varOk = true;
  let detail = "";
  for (const sigma of [0.5, 1, 2]) {
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const v = processVar(t, sigma, 0);
      detail += `σ${sigma} t${t}: ${v.toFixed(3)}; `;
      if (Math.abs(v - 1) > 0.08) varOk = false;
    }
  }
  check("smoothed process keeps unit variance at every fractional time", varOk, detail);

  // The failure mode the rule prevents: a plain half/half lerp of two frames.
  const lerp: number[] = [];
  for (let i = 0; i < N; i++) {
    const [x, y] = cell(i);
    const a = grainSampleCpu(x, y, 100, 11, "gaussian")[0];
    const b = grainSampleCpu(x, y, 101, 11, "gaussian")[0];
    lerp.push(0.5 * a + 0.5 * b);
  }
  const lv = stats(lerp).std ** 2;
  check("(control) unnormalised lerp dips to variance ≈ 0.5 at the midpoint", Math.abs(lv - 0.5) < 0.06, `var ${lv.toFixed(3)}`);

  // Smoothness: a 1/8-frame step barely moves a σ=1 process, and jumps a
  // hard one.
  let dSmooth = 0;
  let dHard = 0;
  const kA = grainKernel(20.0, 1, 0);
  const kB = grainKernel(20.125, 1, 0);
  const hA = grainKernel(20.9, 0, 0);
  const hB = grainKernel(21.0, 0, 0);
  for (let i = 0; i < N; i++) {
    const [x, y] = cell(i);
    dSmooth += Math.abs(grainProcessCpu(x, y, kA, 11, "gaussian")[0] - grainProcessCpu(x, y, kB, 11, "gaussian")[0]);
    dHard += Math.abs(grainProcessCpu(x, y, hA, 11, "gaussian")[0] - grainProcessCpu(x, y, hB, 11, "gaussian")[0]);
  }
  dSmooth /= N;
  dHard /= N;
  check(
    "σ=1 moves ~0.07 per eighth frame; σ=0 re-rolls (~1.13 mean |Δ|)",
    dSmooth < 0.2 && dHard > 0.9,
    `smooth ${dSmooth.toFixed(3)} hard ${dHard.toFixed(3)}`
  );

  // Loop seam: t = L reproduces t = 0 exactly, and the approach is smooth.
  const L = 48;
  const k0 = grainKernel(0, 1, L);
  const kL = grainKernel(L, 1, L);
  const kPre = grainKernel(L - 0.125, 1, L);
  let seamExact = true;
  let seamStep = 0;
  for (let i = 0; i < N; i++) {
    const [x, y] = cell(i);
    const v0 = grainProcessCpu(x, y, k0, 11, "gaussian")[0];
    const vL = grainProcessCpu(x, y, kL, 11, "gaussian")[0];
    if (v0 !== vL) seamExact = false;
    seamStep += Math.abs(vL - grainProcessCpu(x, y, kPre, 11, "gaussian")[0]);
  }
  seamStep /= N;
  check("loop seam is exact (frame L ≡ frame 0) and continuous", seamExact && seamStep < 0.2, `step ${seamStep.toFixed(3)}`);
}

if (failures > 0) {
  console.error(`\ncheck-grain: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-grain: all passed");
