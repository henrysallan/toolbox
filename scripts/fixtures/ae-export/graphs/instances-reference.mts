// The toolbox side of the instances lane's checks (M4, specdocs/ae-m4/
// instances.md): every copy a Copy to Points (image mode) draws at a frame,
// bottom → top, straight from the evaluated points and the node's own math —
// COPY_INST_VS (position, scale × modulation × field, rotation + modulation +
// field, tint, opacity) and compute's variant packing (variant-major, then
// the draw order). Independent of the exporter (src/lib/ae-export/scene/
// instances.ts); it shares only the node's own exported helpers
// (chooseVariantGroup, buildDrawOrder).
//
// check-scene-facts holds the scene's props to it (instancesFacts below);
// instances-roundtrip.mts holds After Effects' readback to it.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Checker } from "../../../ae-export/harness.mts";
import type { AeComp, AeLayer, AeScene } from "@/lib/ae-export/types";
import { buildFixture, rRampPixels, SCENE_FIXTURES, type SceneFixture } from "./fixtures.mts";

export interface RefCopy {
  k: number;
  i: number;
  pos: [number, number]; // px
  scale: [number, number]; // %
  rot: number; // degrees
  opacity: number; // 0–100
  tint: [number, number, number] | null;
}

// One Copy to Points to check: its fixture, node, the toolbox layer comp its
// copies land in, the frames, each variant's colour at its centre (pixels),
// and the rotation tolerance (a best-fit easing).
export interface InstanceCase {
  fixture: string;
  copy: string;
  layer: string;
  frames: number[];
  colors: [number, number, number][];
  rotTol?: number;
}

export const INSTANCE_CASES: InstanceCase[] = [
  { fixture: "r-tint-opacity", copy: "copy", layer: "Tinted dots", frames: [0], colors: [[255, 255, 255]] },
  { fixture: "r-tint-opacity", copy: "copy2", layer: "Tinted boxes", frames: [0], colors: [[255, 128, 0]] },
  { fixture: "r-picks", copy: "pick_rand", layer: "Random picks", frames: [0], colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] },
  { fixture: "r-picks", copy: "pick_cycle", layer: "Cycled by y", frames: [0], colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] },
  { fixture: "r-picks", copy: "pick_attr", layer: "Attribute picks", frames: [0], colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] },
  { fixture: "r-picks", copy: "pick_all", layer: "Every variant", frames: [0], colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] },
  // easeInOutCubic on rotate_add → the Editable best fit (≤ 0.27% of 86°).
  { fixture: "r-keyed", copy: "copy", layer: "Keyed modulation", frames: [0, 7, 15, 24, 30, 40, 50], colors: [[255, 204, 0]], rotTol: 0.25 },
  { fixture: "r-stagger", copy: "copy", layer: "Staggered", frames: [0, 4, 9, 13, 20, 31, 45, 59], colors: [[51, 204, 255]] },
  { fixture: "r-stagger", copy: "copy2", layer: "Bobbing", frames: [0, 10, 25, 40, 59], colors: [[255, 102, 170]] },
  { fixture: "r-switch", copy: "copy", layer: "Switching", frames: [0, 8, 9, 17, 25, 33, 59], colors: [[102, 102, 102], [255, 255, 255]] },
  { fixture: "r-field", copy: "copy", layer: "Field copies", frames: [0], colors: [[255, 255, 255]] },
];

export const fixtureNamed = (name: string): SceneFixture => {
  const f = SCENE_FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

const ep = (e: { source: string; sourceHandle?: string | null }) => (e.sourceHandle?.startsWith("out:aux:") ? `${e.source}:aux:${e.sourceHandle.slice(8)}` : `${e.source}:out`);

// The node's copies at each frame (bottom → top).
export async function toolboxCopies(f: SceneFixture, copyId: string, frames: number[]): Promise<RefCopy[][]> {
  const { nodes, edges } = await buildFixture(f);
  const { makeAeGraph } = await import("@/lib/ae-export/scene/graph");
  const { evaluateKeyframesAt } = await import("@/engine/keyframes");
  const { chooseVariantGroup, buildDrawOrder } = await import("@/nodes/effect/copy-to-points");
  const { readCollectSlots } = await import("@/nodes/effect/collect");
  const W = f.comp.width;
  const H = f.comp.height;
  const graph = makeAeGraph(nodes, edges, undefined, { width: W, height: H }, f.comp.fps);
  const node = nodes.find((n) => n.id === copyId)!;
  const p = node.data.params as Record<string, any>;
  const anim = (node.data.animation ?? {}) as Record<string, any>;
  const into = (h: string) => edges.find((e) => e.target === copyId && e.targetHandle === h);
  const pointsEp = ep(into("in:points")!);
  const instWire = into("in:instance")!;
  const instNode = nodes.find((n) => n.id === instWire.source)!;
  const M = instNode.data.defType === "collect" ? readCollectSlots(instNode.data.params).filter((s) => edges.some((e) => e.target === instNode.id && e.targetHandle === `in:${s}`)).length : 1;
  const tick = (fr: number) => fr * 1000;
  const param = (name: string, d: number, fr: number) => {
    const b = anim[name];
    if (b?.animated && b.keyframes?.length > 1) return evaluateKeyframesAt(b, "scalar", tick(fr)) as number;
    return typeof p[name] === "number" ? p[name] : d;
  };
  // COPY_INST_VS's field read: R, bilinear, clamp to edge, at the copy's
  // aspect-corrected canvas position (texture Y-up ⇔ readback row 0 = top).
  const field = (h: string) => {
    if (!into(h)) return null;
    const px = (f.opts?.fieldPixels ?? rRampPixels)(ep(into(h)!), W, H)!;
    return (u: number, v: number) => {
      const cx = u * W - 0.5;
      const cyy = (0.5 + (v - 0.5) * (W / H)) * H - 0.5;
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cyy);
      const R = (x: number, y: number) => px[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4] / 255;
      const a = R(x0, y0) * (1 - (cx - x0)) + R(x0 + 1, y0) * (cx - x0);
      const b = R(x0, y0 + 1) * (1 - (cx - x0)) + R(x0 + 1, y0 + 1) * (cx - x0);
      return a * (1 - (cyy - y0)) + b * (cyy - y0);
    };
  };
  const sField = field("in:scale_field");
  const rField = field("in:rotate_field");
  const pickMode = String(p.pick_mode ?? "image");
  const seed = Math.floor(Number(p.pick_seed ?? 0));
  return frames.map((fr) => {
    const pts = graph.valueAt(pointsEp, tick(fr)) as any;
    const N = pts.count as number;
    const mul = param("scale_mul_default", 1, fr);
    const radd = param("rotate_add_default", 0, fr);
    const tintA = p.tint_attr ? pts.attributes?.[p.tint_attr] : undefined;
    const opA = p.opacity_attr ? pts.attributes?.[p.opacity_attr] : undefined;
    const pickA = pickMode === "attribute" && p.pick_attr ? pts.attributes?.[p.pick_attr] : undefined;
    const copy = (k: number, i: number): RefCopy => {
      const x = pts.positions[i * 2];
      const y = pts.positions[i * 2 + 1];
      const fm = sField ? Number(p.scale_field_lo ?? 0.5) + (Number(p.scale_field_hi ?? 1.5) - Number(p.scale_field_lo ?? 0.5)) * sField(x, y) : 1;
      const fr2 = rField ? (rField(x, y) - 0.5) * 2 * Number(p.rotate_field_amount ?? Math.PI) : 0;
      return {
        k,
        i,
        pos: [x * W, H / 2 + (y - 0.5) * W],
        scale: [(pts.scales ? pts.scales[i * 2] : 1) * mul * fm * 100, (pts.scales ? pts.scales[i * 2 + 1] : 1) * mul * fm * 100],
        rot: (((pts.rotations ? pts.rotations[i] : 0) + radd + fr2) * 180) / Math.PI,
        opacity: opA ? Math.min(1, Math.max(0, opA.data[i * opA.arity])) * 100 : 100,
        tint: tintA && tintA.arity >= 3 ? [tintA.data[i * tintA.arity], tintA.data[i * tintA.arity + 1], tintA.data[i * tintA.arity + 2]] : null,
      };
    };
    const order = buildDrawOrder(pts, String(p.draw_order ?? "points order"), seed);
    const at = (t: number) => (order ? order[t] : t);
    const out: RefCopy[] = [];
    // compute's packing: item-major segments, the draw order within each.
    if (M === 1) for (let t = 0; t < N; t++) out.push(copy(0, at(t)));
    else if (pickMode === "all" || pickMode === "image") for (let k = 0; k < M; k++) for (let t = 0; t < N; t++) out.push(copy(k, at(t)));
    else {
      const distinct = Array.from({ length: M }, (_, k) => k);
      const assign = Array.from({ length: N }, (_, i) =>
        chooseVariantGroup({ pickMode, distinct, index: i, sampler: null, u: pts.positions[i * 2], v: pts.positions[i * 2 + 1], targetGroup: pts.groupIndices ? pts.groupIndices[i] : 0, seed, attrValue: pickA ? Math.min(1, Math.max(0, pickA.data[i * pickA.arity])) : null }) ?? 0
      );
      for (let k = 0; k < M; k++) for (let t = 0; t < N; t++) if (assign[at(t)] === k) out.push(copy(k, at(t)));
    }
    return out.filter((c) => c.opacity > 0);
  });
}

// --- the AE side ----------------------------------------------------------------------

// A copy layer as AE shows it: variant, point, and props at a frame.
export interface AeCopy {
  layer: string;
  k: number;
  i: number;
  pos: number[];
  scale: number[];
  rot: number;
  opacity: number;
  fill?: number[];
  mixer?: number[];
}

// Variant k of a scene comp: the instance node its layers came from.
export function variantOfComp(scene: AeScene, compId: string, items: string[]): number {
  const c = scene.comps.find((x) => x.id === compId);
  const origins = new Set((c?.layers ?? []).flatMap((l) => l.origin ?? []));
  return items.findIndex((it) => origins.has(it));
}

// The instance node ids per variant (a Combine's connected slots, in order).
export async function variantItems(f: SceneFixture, copyId: string): Promise<string[]> {
  const { nodes, edges } = await buildFixture(f);
  const { readCollectSlots } = await import("@/nodes/effect/collect");
  const w = edges.find((e) => e.target === copyId && e.targetHandle === "in:instance")!;
  const n = nodes.find((x) => x.id === w.source)!;
  if (n.data.defType !== "collect") return [w.source];
  return readCollectSlots(n.data.params)
    .map((s) => edges.find((e) => e.target === n.id && e.targetHandle === `in:${s}`)?.source)
    .filter((x): x is string => !!x);
}

// "<name> 3" → point 2; "<name> 3.2" → point 2, variant 1.
export function slotOfName(name: string): { i: number; k?: number } | null {
  const m = /(\d+)(?:\.(\d+))?$/.exec(name);
  return m ? { i: Number(m[1]) - 1, ...(m[2] ? { k: Number(m[2]) - 1 } : {}) } : null;
}

export function layerComp(scene: AeScene, layerName: string): AeComp | undefined {
  return scene.comps.find((c) => c.name.endsWith(` · ${layerName}`));
}

// Compare the AE copies (bottom → top, opacity > 0) with toolbox's at one frame.
export function compareCopies(label: string, ae: AeCopy[], ref: RefCopy[], c: Checker, opts: { rotTol?: number; flat?: [number, number, number] } = {}): { pos: number; scale: number; rot: number; opacity: number; tint: number } {
  const worst = { pos: 0, scale: 0, rot: 0, opacity: 0, tint: 0 };
  const seq = (xs: { k: number; i: number }[]) => xs.map((x) => `${x.i}:${x.k}`).join(" ");
  const same = seq(ae) === seq(ref);
  c.check(`${label}: the copies stack in toolbox's order (variant-major, then the draw order)`, same, { ae: seq(ae), toolbox: seq(ref) });
  if (!same) return worst;
  ae.forEach((a, n) => {
    const r = ref[n];
    worst.pos = Math.max(worst.pos, Math.hypot(a.pos[0] - r.pos[0], a.pos[1] - r.pos[1]));
    worst.scale = Math.max(worst.scale, Math.abs(a.scale[0] - r.scale[0]), Math.abs(a.scale[1] - r.scale[1]));
    worst.rot = Math.max(worst.rot, Math.abs(a.rot - r.rot));
    worst.opacity = Math.max(worst.opacity, Math.abs(a.opacity - r.opacity));
    if (r.tint) {
      const got = a.fill ? a.fill.slice(0, 3) : (a.mixer ?? [NaN, NaN, NaN]).map((x) => x / 100);
      const want = a.fill && opts.flat ? r.tint.map((x, ch) => Math.min(1, Math.max(0, x * opts.flat![ch] / 255))) : r.tint;
      worst.tint = Math.max(worst.tint, ...got.map((x, ch) => Math.abs(x - want[ch])));
    }
  });
  c.check(`${label}: position within 0.001 px (worst ${worst.pos.toExponential(2)})`, worst.pos <= 1e-3, worst);
  c.check(`${label}: scale within 1e-4 % (worst ${worst.scale.toExponential(2)})`, worst.scale <= 1e-4, worst);
  c.check(`${label}: rotation within ${opts.rotTol ?? 1e-4}° (worst ${worst.rot.toExponential(2)})`, worst.rot <= (opts.rotTol ?? 1e-4), worst);
  c.check(`${label}: opacity within 1e-4 (worst ${worst.opacity.toExponential(2)})`, worst.opacity <= 1e-4, worst);
  if (ref.some((r) => r.tint)) c.check(`${label}: tint within 1e-6 (worst ${worst.tint.toExponential(2)})`, worst.tint <= 1e-6, worst);
  return worst;
}

// The scene's copies of a case at a frame (its props evaluated at f / fps).
export async function sceneCopies(scene: AeScene, kase: InstanceCase, frame: number): Promise<AeCopy[]> {
  const { evaluateAeProp } = await import("@/lib/ae-export/convert");
  const f = fixtureNamed(kase.fixture);
  const items = await variantItems(f, kase.copy);
  const comp = layerComp(scene, kase.layer);
  if (!comp) return [];
  const t = frame / f.comp.fps;
  const out: AeCopy[] = [];
  for (const L of [...comp.layers].reverse() as AeLayer[]) {
    if (L.kind !== "precomp" || !L.origin?.includes(kase.copy)) continue;
    const s = slotOfName(L.name);
    if (!s) continue;
    const opacity = evaluateAeProp(L.transform.opacity, t)[0];
    if (!(opacity > 0)) continue;
    const fx = L.effects?.[0];
    out.push({
      layer: L.name,
      k: variantOfComp(scene, L.source!, items),
      i: s.i,
      pos: evaluateAeProp(L.transform.position!, t),
      scale: evaluateAeProp(L.transform.scale, t),
      rot: evaluateAeProp(L.transform.rotation, t)[0],
      opacity,
      ...(fx?.match === "ADBE Fill" ? { fill: evaluateAeProp(fx.props["ADBE Fill-0002"], t) } : {}),
      ...(fx?.match === "ADBE CHANNEL MIXER" ? { mixer: ["0001", "0006", "0011"].map((id) => evaluateAeProp(fx.props[`ADBE CHANNEL MIXER-${id}`], t)[0]) } : {}),
    });
  }
  return out;
}
