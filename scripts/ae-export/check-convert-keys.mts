// convert/keys.ts: toolbox tracks → AeProp, verified per frame against
// evaluateKeyframesAt with AE's own semantics (evaluateAeKeys), and the dense
// fallback — it must trigger exactly where AE has no form (springs, a hold in
// one dimension while another moves, a fit past tolerance) and nowhere else.

import { makeChecker } from "./harness.mts";
import {
  evaluateKeyframesAt,
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import type { SplineSubpath } from "@/engine/types";
import type { AeKey, AePath } from "@/lib/ae-export/types";
import {
  animationKeyParamType,
  aeRoundCornersPath,
  combinedTracksToAe,
  component,
  evaluateAeKeys,
  evaluateAePathProp,
  evaluateAeProp,
  frameTime,
  numericTrackToAe,
  parseAnimationKey,
  pathDeviationPx,
  spatialTrackToAe,
  splineToAePaths,
  splineTrackToAe,
  stepTrackToAe,
  verifyAeProp,
  partsOracle,
} from "@/lib/ae-export/convert";

const block = (keys: Keyframe[]): KeyframeAnimationBlock => ({ animated: true, trackVisible: true, keyframes: keys });
const k = (tick: number, value: unknown, easingOut: EasingPreset = "linear", extra: Partial<Keyframe> = {}): Keyframe => ({ tick, value, easingOut, ...extra });

function rect(x0: number, y0: number, x1: number, y1: number, r?: number): { subpaths: SplineSubpath[] } {
  const a = (x: number, y: number) => ({ pos: [x, y] as [number, number], ...(r !== undefined ? { cornerRadius: r } : {}) });
  return { subpaths: [{ closed: true, anchors: [a(x0, y0), a(x1, y0), a(x1, y1), a(x0, y1)] }] };
}

function pathGap(a: AePath, b: AePath): number {
  let m = 0;
  for (let i = 0; i < a.vertices.length; i++) {
    m = Math.max(m, Math.hypot(a.vertices[i][0] - b.vertices[i][0], a.vertices[i][1] - b.vertices[i][1]));
    m = Math.max(m, Math.hypot(a.inTangents[i][0] - b.inTangents[i][0], a.inTangents[i][1] - b.inTangents[i][1]));
    m = Math.max(m, Math.hypot(a.outTangents[i][0] - b.outTangents[i][0], a.outTangents[i][1] - b.outTangents[i][1]));
  }
  return m;
}

export default async function run(): Promise<number> {
  const c = makeChecker("convert-keys");
  const fps = 30;

  // --- virtual keys ----------------------------------------------------------
  const cases: [string, unknown, string | undefined][] = [
    ["layer_opacity:L1", { kind: "layerOpacity", layerId: "L1" }, "scalar"],
    ["gpoint_x:p2", { kind: "gpoint", field: "x", pointId: "p2" }, "scalar"],
    ["gpoint_y:p2", { kind: "gpoint", field: "y", pointId: "p2" }, "scalar"],
    ["gpoint_c:p2", { kind: "gpoint", field: "c", pointId: "p2" }, "color"],
    ["ramp_c:ramp:s1", { kind: "ramp", field: "color", param: "ramp", stopId: "s1" }, "color"],
    ["ramp_a:ramp:s1", { kind: "ramp", field: "alpha", param: "ramp", stopId: "s1" }, "scalar"],
    ["ramp_p:fill_ramp:s:2", { kind: "ramp", field: "position", param: "fill_ramp", stopId: "s:2" }, "scalar"],
    ["ch:speed", { kind: "channel", name: "speed" }, undefined],
    ["anchor_p:a7", { kind: "anchor", field: "p", anchorId: "a7" }, "vec2"],
    ["anchor_in:a7", { kind: "anchor", field: "in", anchorId: "a7" }, "vec2"],
    ["anchor_out:a7", { kind: "anchor", field: "out", anchorId: "a7" }, "vec2"],
    ["radius", { kind: "param", param: "radius" }, undefined],
  ];
  for (const [key, want, type] of cases) {
    const got = parseAnimationKey(key);
    c.check(`parse ${key}`, JSON.stringify(got) === JSON.stringify(want), got);
    c.check(`${key} interpolates as ${type ?? "the def's type"}`, animationKeyParamType(got) === type);
  }
  c.check("a channel / literal key takes the def's type", animationKeyParamType(parseAnimationKey("ch:tint"), "color") === "color");
  c.check("hex components: #ff8000 → (1, 0.502, 0, 1), #11223380 alpha 0.502", component("#ff8000", 0) === 1 && Math.abs(component("#ff8000", 1) - 128 / 255) < 1e-12 && component("#ff8000", 3) === 1 && Math.abs(component("#11223380", 3) - 128 / 255) < 1e-12);

  // --- AE semantics ------------------------------------------------------------
  const ks: AeKey<number[]>[] = [
    { t: 0, v: [0, 10], inInterp: "linear", outInterp: "hold" },
    { t: 1, v: [5, 20], inInterp: "hold", outInterp: "linear" },
    { t: 2, v: [9, 0], inInterp: "linear", outInterp: "bezier", easeOut: [{ speed: 0, influence: 50 }] },
    { t: 3, v: [1, 1], inInterp: "bezier", outInterp: "linear", easeIn: [{ speed: 0, influence: 50 }] },
  ];
  c.check("before the first key: its value", evaluateAeKeys(ks, -1).join() === "0,10");
  c.check("HOLD keeps key i's value up to key i+1", evaluateAeKeys(ks, 0.999).join() === "0,10" && evaluateAeKeys(ks, 1).join() === "5,20");
  c.check("LINEAR both sides lerps", evaluateAeKeys(ks, 1.5).join() === "7,10");
  const mid = evaluateAeKeys(ks, 2.5);
  c.check("one ease padded to both dims (Easy Ease 50%: symmetric → midpoint)", Math.abs(mid[0] - 5) < 1e-9 && Math.abs(mid[1] - 0.5) < 1e-9, mid);
  c.check("after the last key: its value", evaluateAeKeys(ks, 9).join() === "1,1");

  // --- numeric tracks ------------------------------------------------------------
  const exactTrack = block([k(0, 0, "easeOutCubic"), k(20000, 50, "easeInBack"), k(45000, 20, "easeOutBounce"), k(60000, 80)]);
  const r1 = numericTrackToAe(exactTrack, "scalar", { fps, fidelity: "editable" });
  c.check(`exact presets: no dense, AE ≡ toolbox at frames (${r1.report.maxError.toExponential(1)})`, r1.report.dense.length === 0 && r1.report.maxError < 1e-9 && r1.report.fidelity === "exact");
  c.check("…bounce adds its 3 inner contact keys", "keys" in r1.prop && r1.prop.keys.length === 4 + 3);

  // Fallback trigger 1: a spring has no AE form.
  const spring = block([k(0, 0, "spring", { spring: { dampingRatio: 0.3 } }), k(30000, 100, "easeOutQuad"), k(60000, 0)]);
  const r2 = numericTrackToAe(spring, "scalar", { fps, fidelity: "editable" });
  c.check(`spring → dense (${r2.report.dense[0]?.reason}), exact at frames (${r2.report.maxError.toExponential(1)})`, r2.report.dense.length === 1 && r2.report.maxError < 1e-9);
  c.check("…only the spring segment is dense: the quad segment keeps its two eased keys", "keys" in r2.prop && r2.prop.keys.length === 31 + 1 && r2.prop.keys[30].outInterp === "bezier");

  // Fallback trigger 2: one dimension holds while another moves.
  const r3 = combinedTracksToAe(
    [
      { src: block([k(0, 1, "hold"), k(30000, 2)]), paramType: "scalar" },
      { src: block([k(0, 1, "easeOutQuad"), k(15000, 3, "easeInQuad"), k(30000, 1)]), paramType: "scalar" },
    ],
    { fps, fidelity: "editable", map: { scale: 100, offset: 0 } }
  );
  c.check(`hold vs a moving dim → dense (${r3.report.dense[0]?.reason?.slice(0, 40)}…), exact at frames`, r3.report.dense.length >= 1 && r3.report.maxError < 1e-9);

  // Fallback trigger 3: a fit past tolerance — only when the tolerance says so.
  const inOut = block([k(0, 0, "easeInOutQuad"), k(30000, 1000)]);
  const loose = numericTrackToAe(inOut, "scalar", { fps, fidelity: "editable" });
  const tight = numericTrackToAe(inOut, "scalar", { fps, fidelity: "editable", tolerance: { abs: 0, rel: 1e-4 } });
  const exact = numericTrackToAe(inOut, "scalar", { fps, fidelity: "exact" });
  c.check(`easeInOutQuad Editable keeps its one fitted segment (${loose.report.maxError.toFixed(3)} on a 1000 move)`, loose.report.dense.length === 0 && "keys" in loose.prop && loose.prop.keys.length === 2);
  c.check(`…a 0.01% tolerance forces dense keys (${tight.report.dense[0]?.reason})`, tight.report.dense.length === 1 && tight.report.maxError < 1e-9);
  c.check(`…Exact adds the midpoint key instead and is exact (${exact.report.maxError.toExponential(1)})`, exact.report.dense.length === 0 && "keys" in exact.prop && exact.prop.keys.length === 3 && exact.report.maxError < 1e-9);

  // Merge: per-dimension cubics split exactly at the other dimension's keys.
  const r4 = combinedTracksToAe(
    [
      { src: block([k(0, 1, "easeOutCubic"), k(12000, 1.5, "easeInOutCubic"), k(36000, 0.4, "easeOutBack"), k(60000, 1)]), paramType: "scalar" },
      { src: block([k(6000, 2, "easeInOutSine"), k(48000, 0.2, "linear")]), paramType: "scalar" },
    ],
    { fps, fidelity: "exact", map: { scale: 100, offset: 0 } }
  );
  c.check(
    `merged dims, union key times, de Casteljau splits (${r4.report.maxError.toExponential(1)} %, ${"keys" in r4.prop ? r4.prop.keys.length : 0} keys)`,
    r4.report.dense.length === 0 && r4.report.maxError < 0.0011 * 130 && "keys" in r4.prop && r4.prop.keys.length === 7
  );
  // A vec2 track is one property with per-dimension eases.
  const vec = block([k(0, [0, 0], "easeOutQuad"), k(30000, [10, -40], "easeInCubic"), k(60000, [20, 0])]);
  const r5 = numericTrackToAe(vec, "vec2", { fps, fidelity: "editable" });
  c.check(`vec2: per-dimension eases, exact (${r5.report.maxError.toExponential(1)})`, "keys" in r5.prop && (r5.prop.keys[0].easeOut?.length ?? 0) === 2 && r5.report.maxError < 1e-9);

  // Spatial: one ease on the distance; the sine fit's −0.004 end slope is
  // flattened (speed is a magnitude) and verified.
  const pos = block([k(0, [0.1, 0.2], "easeInOutSine"), k(30000, [0.6, 0.7], "hold"), k(45000, [0.3, 0.3], "linear"), k(60000, [0.9, 0.1])]);
  const W = 1920;
  const r6 = spatialTrackToAe([0, 1].map((d) => ({ src: pos, paramType: "vec2" as const, dim: d })), { fps, fidelity: "editable", map: [{ scale: W, offset: 0 }, { scale: W, offset: -420 }] });
  c.check(`spatial vec2 position: one ease per key, no dense, ${r6 ? r6.report.maxError.toFixed(3) : "?"} px`, !!r6 && r6.report.dense.length === 0 && "keys" in r6.prop && r6.prop.keys.every((kk) => (kk.easeOut?.length ?? 1) === 1) && r6.report.maxError < 0.001 * W);
  const sp = spatialTrackToAe([0, 1].map((d) => ({ src: block([k(0, [0, 0], "easeOutElastic"), k(30000, [1, 1])]), paramType: "vec2" as const, dim: d })), { fps, fidelity: "editable" });
  c.check("spatial with elastic (reverses) → null: the caller separates dimensions", sp === null);
  const oracle = partsOracle([{ src: exactTrack, paramType: "scalar" }], { fps, fidelity: "editable" });
  c.check("verifyAeProp re-measures a built prop", verifyAeProp(r1.prop, oracle, [0, 60], { fps }) < 1e-9);

  // Clock offset: keys land in comp time, the verifier reads the local clock.
  const r7 = numericTrackToAe(block([k(0, 0, "easeOutQuad"), k(30000, 10)]), "scalar", { fps, fidelity: "editable", offsetTicks: 9000 });
  c.check("offsetTicks: keys at +0.3 s, still exact", "keys" in r7.prop && Math.abs(r7.prop.keys[0].t - 0.3) < 1e-12 && r7.report.maxError < 1e-9);

  // Step-only types.
  const bools = stepTrackToAe(block([k(0, false), k(10000, true, "easeOutCubic"), k(20000, false)]), (v) => (v ? 1 : 0), { fps, fidelity: "editable" });
  c.check("boolean → HOLD keys (easing ignored, as toolbox snaps)", "keys" in bools && bools.keys.every((kk) => kk.inInterp === "hold" && kk.outInterp === "hold") && bools.keys[1].v === 1);
  const enums = stepTrackToAe(block([k(0, "a"), k(9000, "c")]), (v) => ["a", "b", "c"].indexOf(v as string) + 1, { fps, fidelity: "editable" });
  c.check("enum → HOLD keys with the exporter's value map", "keys" in enums && enums.keys[1].v === 3);
  const single = numericTrackToAe(block([k(0, 7)]), "scalar", { fps, fidelity: "editable" });
  c.check("one key → a static value", "v" in single.prop && single.prop.v === 7);

  // --- path keys -------------------------------------------------------------
  const cv = { width: 1920, height: 1080 };
  const morph = block([k(0, rect(0.2, 0.2, 0.4, 0.4), "easeOutCubic"), k(30000, rect(0.3, 0.1, 0.8, 0.6), "easeOutBounce"), k(60000, rect(0.1, 0.4, 0.5, 0.5))]);
  const p1 = splineTrackToAe(morph, cv, { fps, fidelity: "editable" });
  if ("error" in p1) c.check("path keys build", false, p1.error);
  else {
    let gap = 0;
    for (let f = 0; f <= 60; f++) {
      const want = splineToAePaths(evaluateKeyframesAt(morph, "spline_anchors", f * 1000) as { subpaths: SplineSubpath[] }, cv)[0];
      gap = Math.max(gap, pathGap(evaluateAePathProp(p1.paths[0], frameTime(f, { fps })), want));
    }
    c.check(`path keys: one Path per subpath, constant vertex count, ≤ 1e-6 px at frames (${gap.toExponential(1)})`, p1.paths.length === 1 && gap < 1e-6);
    c.check("…easeOutCubic morphs on one eased segment; bounce's contact-to-contact pieces go dense (a one-ease morph cannot leave a shape and return)", p1.report.dense.length === 3 && p1.report.dense.every((d) => d.reason.includes("one-ease")));
  }
  const bad = splineTrackToAe(block([k(0, rect(0.2, 0.2, 0.4, 0.4)), k(30000, { subpaths: [{ closed: true, anchors: [{ pos: [0, 0] }, { pos: [1, 0] }, { pos: [1, 1] }] }] })]), cv, { fps, fidelity: "editable" });
  c.check(`a vertex-count change is reported (${"error" in bad ? bad.error : "built"})`, "error" in bad);

  // Live corners, uniform: raw paths + Round Corners with the radius riding the morph.
  const rounded = block([k(0, rect(0.2, 0.2, 0.5, 0.5, 0.02), "easeInOutCubic"), k(30000, rect(0.3, 0.2, 0.7, 0.6, 0.05))]);
  const p2 = splineTrackToAe(rounded, cv, { fps, fidelity: "exact" });
  if ("error" in p2) c.check("rounded path keys build", false, p2.error);
  else {
    c.check(`uniform live corners → Round Corners keyed with the path (${p2.report.maxError.toFixed(3)} px)`, !!p2.roundCorners && "keys" in p2.roundCorners && "keys" in p2.paths[0] && p2.report.maxError < 0.25);
    let dev = 0;
    for (let f = 0; f <= 30; f++) {
      const t = frameTime(f, { fps });
      const tb = evaluateKeyframesAt(rounded, "spline_anchors", f * 1000) as { subpaths: SplineSubpath[] };
      const want = splineToAePaths({ subpaths: roundCornersPerAnchor(tb.subpaths) }, cv)[0];
      dev = Math.max(dev, pathDeviationPx(aeRoundCornersPath(evaluateAePathProp(p2.paths[0], t), evaluateAeProp(p2.roundCorners!, t)[0]), want));
    }
    c.check(`…AE's Round Corners of the morph ≡ toolbox's fillet of the morph to ${dev.toFixed(3)} px every frame`, dev < 0.25);
  }
  // Live corners that AE's Round Corners cannot carry: baked per key.
  const tri = (s: number) => ({ subpaths: [{ closed: true, anchors: [{ pos: [0.5, 0.5 - s] as [number, number], cornerRadius: 0.03 }, { pos: [0.5 + s, 0.5 + s] as [number, number], cornerRadius: 0.03 }, { pos: [0.5 - s, 0.5 + s] as [number, number], cornerRadius: 0.03 }] }] });
  const baked = splineTrackToAe(block([k(0, tri(0.1), "easeOutQuad"), k(30000, tri(0.2))]), cv, { fps, fidelity: "editable" });
  c.check(`non-right corners → fillets baked per key, verified (${"error" in baked ? baked.error : baked.report.notes[0]})`, !("error" in baked) && !baked.roundCorners && baked.paths[0] !== undefined && baked.report.maxError < 0.25);
  return c.failures;
}
