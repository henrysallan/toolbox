// Replays a measured key test (calibrate/keys.mts) through the convert lane's
// AE evaluator and reports how far it lands from what AE played. Shared by
// the calibration run and scripts/ae-export/check-calibration.mts.

import { evaluateAeKeys, evaluateAePathProp } from "@/lib/ae-export/convert/keys";
import type { AeKey, AePath } from "@/lib/ae-export/types";

export interface KeyTest {
  id: string;
  kind: "scalar" | "color" | "path" | "position";
  keys: AeKey[];
  times: number[];
  ae?: unknown[];
}

// AE's temporal cubic, independent of keys.ts: one segment, speeds in
// value units / s, the segment's value delta treated as `L` units.
function oneEaseProgress(k0: AeKey, k1: AeKey, L: number, t: number): number {
  const D = k1.t - k0.t;
  if (t <= k0.t) return 0;
  if (t >= k1.t) return 1;
  const o = k0.easeOut?.[0] ?? { speed: L / D, influence: 100 / 3 };
  const i = k1.easeIn?.[0] ?? { speed: L / D, influence: 100 / 3 };
  const x1 = o.influence / 100;
  const x2 = 1 - i.influence / 100;
  const y1 = (o.speed * x1 * D) / L;
  const y2 = 1 - (i.speed * (i.influence / 100) * D) / L;
  const u = (t - k0.t) / D;
  let lo = 0;
  let hi = 1;
  for (let n = 0; n < 60; n++) {
    const m = (lo + hi) / 2;
    const x = 3 * (1 - m) ** 2 * m * x1 + 3 * (1 - m) * m * m * x2 + m ** 3;
    if (x < u) lo = m;
    else hi = m;
  }
  const s = (lo + hi) / 2;
  return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
}

const flat = (p: { vertices: number[][]; inTangents: number[][]; outTangents: number[][] }) => {
  const r: number[] = [];
  for (let i = 0; i < p.vertices.length; i++) r.push(p.vertices[i][0], p.vertices[i][1], p.inTangents[i][0], p.inTangents[i][1], p.outTangents[i][0], p.outTangents[i][1]);
  return r;
};

// The `L` (value units AE divides the speeds by) that best explains AE's
// samples, by golden-section search on log L.
function fitMagnitude(t: KeyTest, progressOf: (i: number) => number): number {
  const [k0, k1] = t.keys;
  const err = (lnL: number) => {
    const L = Math.exp(lnL);
    let m = 0;
    t.times.forEach((tt, i) => (m = Math.max(m, Math.abs(oneEaseProgress(k0, k1, L, tt) - progressOf(i)))));
    return m;
  };
  let a = Math.log(1e-3);
  let b = Math.log(1e4);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let n = 0; n < 200; n++) {
    if (err(c) < err(d)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  return Math.exp((a + b) / 2);
}

export interface KeyReplay {
  // Max |evaluateAe* − AE| over the samples, in the property's units
  // (degrees, 0–1 color, layer px).
  maxError: number;
  // One-ease tests: the magnitude AE behaves as if it divided speeds by,
  // and the one keys.ts uses.
  aeMagnitude?: number;
  modelMagnitude?: number;
  // Color: max distance of AE's samples from the straight RGB line.
  offLine?: number;
  // Progress range AE played (color overshoot test).
  progressRange?: [number, number];
  // Influence tests: max |AE − the plain cubic| and |AE − influences
  // rescaled to sum 100 %|.
  plainCubic?: number;
  rescaled?: number;
}

export function replayKeyTest(t: KeyTest & { ae: unknown[] }): KeyReplay {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  if (t.kind === "scalar") {
    const ae = t.ae as number[];
    let mx = 0;
    t.times.forEach((tt, i) => (mx = Math.max(mx, Math.abs(evaluateAeKeys(t.keys, tt, "perDim")[0] - ae[i]))));
    const [k0, k1] = t.keys;
    const dv = (k1.v as number) - (k0.v as number);
    const o = k0.easeOut![0];
    const i0 = k1.easeIn![0];
    const sum = o.influence + i0.influence;
    const f = sum > 100 ? 100 / sum : 1;
    const resc: [AeKey, AeKey] = [
      { ...k0, easeOut: [{ speed: o.speed, influence: o.influence * f }] },
      { ...k1, easeIn: [{ speed: i0.speed, influence: i0.influence * f }] },
    ];
    let plain = 0;
    let rescaled = 0;
    t.times.forEach((tt, i) => {
      plain = Math.max(plain, Math.abs((k0.v as number) + dv * oneEaseProgress(k0, k1, dv, tt) - ae[i]));
      rescaled = Math.max(rescaled, Math.abs((k0.v as number) + dv * oneEaseProgress(resc[0], resc[1], dv, tt) - ae[i]));
    });
    return { maxError: r6(mx), plainCubic: r6(plain), rescaled: r6(rescaled) };
  }
  if (t.kind === "color" || t.kind === "position") {
    const mode = t.kind === "color" ? "color" : "spatial";
    const dims = t.kind === "color" ? 4 : 2;
    const ae = (t.ae as number[][]).map((v) => v.slice(0, dims));
    const v0 = t.keys[0].v as number[];
    const v1 = t.keys[t.keys.length - 1].v as number[];
    const d = v0.map((x, i) => v1[i] - x);
    const d2 = d.reduce((s, x) => s + x * x, 0);
    const prog = ae.map((v) => v.reduce((s, x, i) => s + (x - v0[i]) * d[i], 0) / d2);
    let off = 0;
    ae.forEach((v, i) => v.forEach((x, c) => (off = Math.max(off, Math.abs(x - (v0[c] + d[c] * prog[i]))))));
    let mx = 0;
    t.times.forEach((tt, i) => {
      const m = evaluateAeKeys(t.keys, tt, mode);
      for (let c = 0; c < dims; c++) mx = Math.max(mx, Math.abs(m[c] - ae[i][c]));
    });
    const linear = t.keys[0].outInterp === "linear";
    return {
      maxError: r6(mx),
      offLine: r6(off),
      progressRange: [r6(Math.min(...prog)), r6(Math.max(...prog))],
      ...(linear ? {} : { aeMagnitude: r6(fitMagnitude(t, (i) => prog[i])), modelMagnitude: r6(Math.sqrt(d2)) }),
    };
  }
  // path
  const ae = (t.ae as { vertices: number[][]; inTangents: number[][]; outTangents: number[][] }[]).map(flat);
  const p0 = flat(t.keys[0].v as AePath);
  const p1 = flat(t.keys[t.keys.length - 1].v as AePath);
  const d = p0.map((x, i) => p1[i] - x);
  const d2 = d.reduce((s, x) => s + x * x, 0);
  const prog = ae.map((v) => v.reduce((s, x, i) => s + (x - p0[i]) * d[i], 0) / d2);
  let mx = 0;
  t.times.forEach((tt, i) => {
    const m = flat(evaluateAePathProp({ keys: t.keys as AeKey<AePath>[], dims: 1 }, tt) as unknown as { vertices: number[][]; inTangents: number[][]; outTangents: number[][] });
    for (let c = 0; c < m.length; c++) mx = Math.max(mx, Math.abs(m[c] - ae[i][c]));
  });
  return { maxError: r6(mx), aeMagnitude: r6(fitMagnitude(t, (i) => prog[i])), modelMagnitude: 1 };
}
