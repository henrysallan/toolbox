// check-convert-text: text animators → After Effects selectors
// (src/lib/ae-export/convert/text.ts; M4 text lane, specdocs/ae-m4/text.md).
//
//   1. the AE Range Selector model (aeRangeSelection) against the recorded
//      AE renders (calibrate/measured/text-probe-1.json): ramps, square
//      coverage, out-of-range Start, index units, Ease High / Low, Min / Max,
//      triangle, words;
//   2. toolboxDrive ≡ the engine's own per-glyph drive (resolveGlyphAnim);
//   3. planTextSelector: a linear cascade's Range Selectors reproduce
//      toolbox exactly (every direction but random, N, softness, either
//      sense), a fitted ease within its reported error, an Expression
//      Selector (evaluated like AE) exactly;
//   4. whole scenes: the walk's text animators, evaluated with AE's measured
//      stacking (aeTextModel), give toolbox's per-glyph alpha / offset /
//      scale / rotation / tracking / colour at every sampled frame.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, makeChecker } from "./harness.mts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HERE = dirname(fileURLToPath(import.meta.url));

export default async function run(): Promise<number> {
  const c = makeChecker("convert-text");
  await loadRegistry();
  const T = await import("@/lib/ae-export/convert/text");
  const E = await import("@/engine/text-animators");

  // --- 1. the AE model against AE's renders --------------------------------------------------
  const probe = JSON.parse(readFileSync(join(HERE, "../ae-export-spike/calibrate/measured/text-probe-1.json"), "utf8"));
  const R = (s: Record<string, unknown>): any => ({ units: "percentage", start: 0, end: 100, offset: 0, shape: "square", easeHigh: 0, easeLow: 0, amount: 100, ...s });
  const PROBES: [string, any[], number[]?][] = [
    ["ramp_up", [R({ shape: "ramp-up" })]],
    ["ramp_down", [R({ shape: "ramp-down" })]],
    ["ramp_up_20_60_o10", [R({ shape: "ramp-up", start: 20, end: 60, offset: 10 })]],
    ["square_15_52", [R({ start: 15, end: 52 })]],
    ["ramp_start_neg50", [R({ shape: "ramp-up", start: -50, end: 50 })]],
    ["ramp_off_neg30", [R({ shape: "ramp-up", offset: -30 })]],
    ["ramp_inverted", [R({ shape: "ramp-up", start: 80, end: 20 })]],
    ["index_2_5", [R({ units: "index", start: 2, end: 5 })]],
    ["index_ramp_neg", [R({ units: "index", shape: "ramp-up", start: -3, end: 4 })]],
    ["ease_h50_l50", [R({ shape: "ramp-up", easeHigh: 50, easeLow: 50 })]],
    ["ease_h100_l0", [R({ shape: "ramp-up", easeHigh: 100, easeLow: 0 })]],
    ["ease_hn50_ln50", [R({ shape: "ramp-up", easeHigh: -50, easeLow: -50 })]],
    ["min_mode", [R({ shape: "ramp-up", start: 0, end: 50 }), R({ shape: "ramp-down", start: 50, end: 100, mode: "min" })]],
    ["max_mode", [R({ shape: "ramp-down", start: 0, end: 50 }), R({ shape: "ramp-up", start: 50, end: 100, mode: "max" })]],
    ["triangle", [R({ shape: "triangle" })]],
    // Five two-glyph words: glyph g is word ⌊g/2⌋.
    ["words", [R({ shape: "ramp-up" })], [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]],
  ];
  for (const [name, sels, wordOf] of PROBES) {
    const got: number[] = probe[name]?.mass;
    if (!got) {
      c.check(`(AE model) ${name}: recorded`, false, "missing from text-probe-1.json");
      continue;
    }
    const N = wordOf ? 5 : 10;
    let worst = 0;
    got.forEach((m, g) => {
      const i = wordOf ? wordOf[g] : g;
      const sel = T.aeSelection(sels, i, N);
      worst = Math.max(worst, Math.abs(1 - m - sel));
    });
    c.check(`(AE model) ${name}: every glyph's alpha within 0.006 of AE's render (worst ${worst.toFixed(4)})`, worst <= 0.006);
  }
  c.check("(AE model) Randomize Order permutes the units (seed 0): toolbox's hashed positions cannot be a Range Selector", [...probe.random_s0.mass].sort().join() === [...probe.ramp_up.mass].sort().join());

  // --- 2. toolboxDrive ≡ the engine ------------------------------------------------------------
  const DIRS = ["forward", "backward", "center", "edges", "random"] as const;
  const EASES = ["linear", "smoothstep", "ease-in-out-sine", "ease-out-back", "ease-in-cubic", "ease-out-bounce", "ease-in-out-elastic", "custom"];
  const CURVE = [{ id: "a", x: 0, y: 0 }, { id: "b", x: 0.3, y: 0.6 }, { id: "c", x: 0.7, y: 0.75 }, { id: "d", x: 1, y: 1 }];
  const engineAlpha = (cfg: Record<string, unknown>, i: number, N: number) => {
    const a = E.parseAnimators({ anim_opacity_enabled: true, anim_opacity_min: 0, anim_opacity_max: 1, anim_opacity_driver: "cascade", ...cfg });
    return E.resolveGlyphAnim(a, { char: i, charTotal: N, word: 0, wordTotal: 1 }, {}).alpha;
  };
  const driveOf = (cfg: Record<string, any>) => ({
    driver: (cfg.anim_opacity_driver ?? "cascade") as "cascade" | "uniform",
    direction: cfg.anim_opacity_direction ?? "forward",
    softness: cfg.anim_opacity_softness ?? 0.3,
    seed: cfg.anim_opacity_seed ?? 0,
    easing: cfg.anim_opacity_easing ?? "linear",
    easeIntensity: cfg.anim_opacity_ease_intensity ?? 1,
    curve: cfg.anim_opacity_easing_curve,
  });
  {
    let worst = 0;
    let n = 0;
    for (const dir of DIRS)
      for (const easing of EASES)
        for (const N of [1, 2, 7])
          for (const softness of [0.05, 0.3, 0.9])
            for (const amount of [0, 0.2, 0.55, 1]) {
              const cfg = { anim_opacity_direction: dir, anim_opacity_easing: easing, anim_opacity_easing_curve: CURVE, anim_opacity_softness: softness, anim_opacity_seed: 13, anim_opacity_amount: amount, anim_opacity_ease_intensity: easing === "smoothstep" ? 0.7 : 1 };
              for (let i = 0; i < N; i++) {
                const e = engineAlpha(cfg, i, N);
                const mine = T.toolboxDrive(driveOf(cfg), amount, i, N);
                worst = Math.max(worst, Math.abs(mine - e));
                n++;
              }
            }
    c.check(`toolboxDrive ≡ resolveGlyphAnim's alpha (${n} glyphs; worst ${worst.toExponential(2)})`, worst <= 1e-12);
  }

  // --- 3. the planner ----------------------------------------------------------------------------
  const amounts = Array.from({ length: 21 }, (_, k) => -0.1 + (k / 20) * 1.2);
  const req = (o: Record<string, any>): any => ({ driver: "cascade", direction: "forward", softness: 0.3, seed: 0, easing: "linear", easeIntensity: 1, curve: undefined, total: 10, complement: false, headroom: 1, fidelity: "editable", tolerance: T.TEXT_EASE_FIT_TOLERANCE, ...o });
  const planError = (r: any) => {
    const plan = T.planTextSelector(r);
    let worst = 0;
    for (const a of amounts)
      for (let i = 0; i < r.total; i++) {
        const want = T.wantedSelection(r, a, i);
        let got: number;
        if (plan.route === "range") got = T.aeSelection(T.rangeModelsAt(plan, a), i, r.total);
        else if (plan.route === "expression") got = T.evalSelectorExpression(plan.expression, 100 * a, i, r.total);
        else {
          const t = T.toolboxEase(r, Math.max(0, Math.min(1, a)));
          got = (r.complement ? 1 - t : t) / r.headroom;
        }
        worst = Math.max(worst, Math.abs(got - Math.max(-1, Math.min(1, want))));
      }
    return { plan, worst };
  };
  {
    let worst = 0;
    let n = 0;
    const routes = new Set<string>();
    for (const dir of ["forward", "backward", "center", "edges"])
      for (const N of [1, 2, 3, 10, 17])
        for (const softness of [0.0001, 0.05, 0.3, 0.7, 0.99])
          for (const complement of [false, true]) {
            const r = planError(req({ direction: dir, total: N, softness, complement }));
            routes.add(r.plan.route);
            worst = Math.max(worst, r.worst);
            n++;
          }
    c.check(`linear cascades → Range Selectors only (${n} plans: ${[...routes].join(", ")})`, routes.size === 1 && routes.has("range"));
    c.check(`…reproducing toolbox's per-unit drive exactly, amounts −0.1 … 1.1 (worst ${worst.toExponential(2)})`, worst <= 1e-9);
    const two = T.planTextSelector(req({ direction: "center" })) as any;
    c.check("center → Ramp Up then Ramp Down combined by Min; edges → by Max", two.selectors.length === 2 && two.selectors[1].mode === "min" && (T.planTextSelector(req({ direction: "edges" })) as any).selectors[1].mode === "max");
    const flip = T.planTextSelector(req({ direction: "center", complement: true })) as any;
    c.check("the complement (1 − t') swaps the ramps and Min ↔ Max", flip.selectors[0].shape === "ramp-down" && flip.selectors[1].mode === "max");
    c.check("softness 1 or a uniform driver → the uniform route", T.planTextSelector(req({ softness: 1 })).route === "uniform" && T.planTextSelector(req({ driver: "uniform" })).route === "uniform");
    c.check("random → an Expression Selector", T.planTextSelector(req({ direction: "random" })).route === "expression");
  }
  {
    const fit = T.fitSelectorEase((u) => u * u * (3 - 2 * u));
    c.check(`smoothstep ≡ Ease High = Low = 33.3 (fit ${fit.low} / ${fit.high}, error ${fit.error.toExponential(2)})`, fit.error <= 1e-4 && Math.abs(fit.low - 100 / 3) < 0.05 && Math.abs(fit.high - 100 / 3) < 0.05);
    for (const [easing, route, tol] of [
      ["smoothstep", "range", 1e-4],
      ["ease-in-out-sine", "range", T.TEXT_EASE_FIT_TOLERANCE],
      ["ease-in-circ", "range", T.TEXT_EASE_FIT_TOLERANCE],
      ["ease-in-cubic", "expression", 1e-9],
      ["ease-out-bounce", "expression", 1e-9],
      ["ease-in-out-elastic", "expression", 1e-9],
    ] as const)
      for (const dir of ["forward", "center"])
        for (const complement of [false, true]) {
          const r = planError(req({ direction: dir, easing, complement }));
          const fitErr = r.plan.route === "range" ? r.plan.error : 0;
          c.check(`${easing} ${dir}${complement ? " (complement)" : ""} → ${route}, within ${(Math.max(tol, fitErr) * 100).toPrecision(2)}% (worst ${(r.worst * 100).toFixed(4)}%)`, r.plan.route === route && r.worst <= Math.max(tol, fitErr) + 1e-9, r.plan.route);
        }
    const exact = planError(req({ easing: "ease-in-out-sine", fidelity: "exact" }));
    c.check("policy exact: a fitted (not exact) ease → an Expression Selector", exact.plan.route === "expression" && exact.worst <= 1e-9);
    const custom = planError(req({ easing: "custom", curve: CURVE, direction: "backward" }));
    c.check(`custom curve → an Expression Selector with a 257-sample table (worst ${custom.worst.toExponential(2)})`, custom.plan.route === "expression" && custom.worst <= 2e-4);
    const back = req({ easing: "ease-out-back" });
    back.headroom = T.easeHeadroom(back);
    const b = planError(back);
    c.check(`ease-out-back overshoots to ${back.headroom.toFixed(4)}: the expression divides by it, never past ±100 % (worst ${b.worst.toExponential(2)})`, back.headroom > 1.09 && back.headroom < 1.11 && b.plan.route === "expression" && b.worst <= 1e-9);
    const rnd = planError(req({ direction: "random", seed: 42, total: 23 }));
    c.check(`random (seed 42, 23 units) → the expression replays toolbox's hash (worst ${rnd.worst.toExponential(2)})`, rnd.worst <= 1e-9);
  }

  // --- 4. whole scenes ---------------------------------------------------------------------------
  const { sceneOf, track } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  const SWEEP = track([[0, 0], [20, 1]]);
  const SCENES: { name: string; params: Record<string, unknown>; anim: Record<string, unknown>; text?: string }[] = [
    { name: "typeon + opacity (product)", params: { anim_typeon_enabled: true, anim_opacity_enabled: true, anim_opacity_driver: "cascade", anim_opacity_direction: "edges", anim_opacity_min: 0.3, anim_opacity_max: 0.8 }, anim: { anim_typeon_amount: SWEEP, anim_opacity_amount: track([[0, 0.2], [20, 0.9]]) } },
    { name: "position base + vary, by word, random", text: "ab cd ef gh", params: { anim_position_enabled: true, anim_position_driver: "cascade", anim_position_direction: "random", anim_position_seed: 3, anim_position_by: "word", anim_position_minX: 5, anim_position_maxX: -12, anim_position_minY: 0, anim_position_maxY: -30 }, anim: { anim_position_amount: SWEEP } },
    { name: "scale 0.4 → 1.6 center + rotation smoothstep", params: { anim_scale_enabled: true, anim_scale_driver: "cascade", anim_scale_direction: "center", anim_scale_min: 0.4, anim_scale_max: 1.6, anim_rotation_enabled: true, anim_rotation_driver: "cascade", anim_rotation_easing: "smoothstep", anim_rotation_min: -10, anim_rotation_max: 50 }, anim: { anim_scale_amount: SWEEP, anim_rotation_amount: SWEEP } },
    { name: "scale 0 → 1 ease-out-back (headroom)", params: { anim_scale_enabled: true, anim_scale_driver: "cascade", anim_scale_easing: "ease-out-back", anim_scale_min: 0, anim_scale_max: 1 }, anim: { anim_scale_amount: SWEEP } },
    { name: "tracking by word, edges (spaces follow toolbox's words)", text: "ab  cd\nef gh", params: { anim_tracking_enabled: true, anim_tracking_driver: "cascade", anim_tracking_direction: "edges", anim_tracking_by: "word", anim_tracking_min: 4, anim_tracking_max: 30 }, anim: { anim_tracking_amount: SWEEP } },
    { name: "tracking backward + colour uniform eased", params: { anim_tracking_enabled: true, anim_tracking_driver: "cascade", anim_tracking_direction: "backward", anim_tracking_max: 24, anim_color_enabled: true, anim_color_driver: "uniform", anim_color_easing: "ease-in-quad", anim_color_min: "#ff0000", anim_color_max: "#0000ff" }, anim: { anim_tracking_amount: SWEEP, anim_color_amount: SWEEP } },
  ];
  for (const s of SCENES) {
    const text = s.text ?? "Hello AE";
    const b = await sceneOf({
      name: "text-model",
      title: "text model",
      comp: { width: 1280, height: 720, fps: 30, frames: 30 },
      build(g: any) {
        const L = g.layer("LT", "Text");
        g.node(L, "t", "text", { text, font_family: "Arial", ...s.params }, s.anim);
        g.out(L, "t:out");
      },
    } as any);
    const L = b.scene.comps.flatMap((x: any) => x.layers).find((l: any) => l.kind === "text");
    if (!L || b.bakes.length) {
      c.check(`(scene) ${s.name}: a text layer, no bake`, false, b.bakes.map((k: any) => k.reason));
      continue;
    }
    // AE's characters: every line's, the line breaks not counted.
    const lineChars = text.split("\n").map((l) => Array.from(l));
    const words = E.wordIndices(lineChars);
    const flat = lineChars.flatMap((cs, li) => cs.map((_, j) => words.ids[li][j]));
    const units = flat.map((w, i) => ({ char: i, charTotal: flat.length, word: w, wordTotal: words.total }));
    const doc = L.text.document.v;
    let worst = 0;
    let where = "";
    for (const f of [0, 4, 9, 13, 17, 20, 25]) {
      const tick = f * 1000;
      const params: Record<string, unknown> = { ...s.params };
      for (const [k, blk] of Object.entries(s.anim)) {
        const ks = (blk as any).keyframes;
        const u = Math.max(0, Math.min(1, (tick - ks[0].tick) / (ks[1].tick - ks[0].tick)));
        params[k] = ks[0].value + (ks[1].value - ks[0].value) * u;
      }
      const A = E.parseAnimators(params);
      const ae = T.aeTextModel(L.text.animators, units, f / 30, { fill: doc.fillColor, text: doc.text });
      units.forEach((u, i) => {
        const g = E.resolveGlyphAnim(A, u, {});
        const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(g.color ?? "");
        const want = [g.alpha, g.offsetX + g.word.offsetX, g.offsetY + g.word.offsetY, g.scale * g.word.scale, ((g.rotation + g.word.rotation) * 180) / Math.PI, E.resolveTrackingExtra(A, u), ...(rgb ? [1, 2, 3].map((k) => Number(rgb[k]) / 255) : [])];
        const a = ae[i];
        const got = [(a.opacity / 100) * (a.fillOpacity / 100), a.position[0] - a.anchor[0], a.position[1] - a.anchor[1], a.scale[0], a.rotation, a.tracking, ...(rgb ? a.fill! : [])];
        // Toolbox rounds an animated colour to 8 bits.
        // A fitted Ease High / Low (smoothstep: exact to 1e-6) leaves that
        // much of the range.
        const tol = [1e-6, 1e-4, 1e-4, 1e-6, 1e-4, 1e-4, 0.5 / 255, 0.5 / 255, 0.5 / 255];
        want.forEach((w, k) => {
          const d = Math.abs(got[k] - w) - tol[k];
          if (d > worst) {
            worst = d;
            where = `f${f} char ${i} quantity ${k}: AE ${got[k]} vs toolbox ${w}`;
          }
        });
      });
    }
    c.check(`(scene) ${s.name}: AE's stacking of the exported animators ≡ toolbox per glyph at 7 frames`, worst <= 0, where);
  }
  return c.failures;
}
