// convert/transform.ts (spec 091926_after-effects-handoff.md §4.1): a TRS op →
// AE anchor / position / scale / rotation, whose AE matrix must equal
// toolbox's (composeTransform → applyTransformToSpline) in px — rotation,
// non-uniform scale and pivot together, at three aspects; Gizmo chains →
// parented layers; and animated tracks → keyed AE props that land on toolbox's
// placement at every frame (local pivots, moving bounding boxes, separated
// position, the shape-layer split).

import { makeChecker } from "./harness.mts";
import { composeTransform, applyTransformToSpline } from "@/engine/transform-value";
import type { TransformOp, SplineValue } from "@/engine/types";
import type { KeyframeAnimationBlock, Keyframe, EasingPreset } from "@/engine/keyframes";
import type { AABB } from "@/engine/transform-pivot";
import type { AeLayerTransform, AeProp } from "@/lib/ae-export/types";
import {
  aeTransformToAffine,
  canvasToPx,
  chainToAffine,
  evaluateAeProp,
  frameTime,
  opToAeStatic,
  opToPxAffine,
  opsToPxAffine,
  transformChainToAe,
  transformOpAt,
  transformTracksToAe,
  type AeCanvas,
  type AeTransformTracks,
} from "@/lib/ae-export/convert";
import type { Affine2D } from "@/engine/transform-value";

const ASPECTS: AeCanvas[] = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
  { width: 1000, height: 1000 },
];

const apply = (m: Affine2D, p: readonly number[]) => [m.a * p[0] + m.b * p[1] + m.tx, m.c * p[0] + m.d * p[1] + m.ty];

function affineGap(m: Affine2D, n: Affine2D, probes: number[][]): number {
  let g = 0;
  for (const p of probes) {
    const a = apply(m, p);
    const b = apply(n, p);
    g = Math.max(g, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return g;
}

const PROBES = [
  [0, 0],
  [1920, 0],
  [0, 1920],
  [960, 540],
  [123.4, 1700.2],
];

const track = (keys: [number, number, EasingPreset][]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([tick, value, easingOut]): Keyframe => ({ tick, value, easingOut })),
});

// AE props at time t → AE's matrix (separated position included).
function aeAt(t: AeLayerTransform, time: number): Affine2D {
  const anchor = evaluateAeProp(t.anchor, time);
  const position = t.separated ? [evaluateAeProp(t.separated.x, time)[0], evaluateAeProp(t.separated.y, time)[0]] : evaluateAeProp(t.position as AeProp<number[]>, time);
  const scale = evaluateAeProp(t.scale, time);
  const rotation = evaluateAeProp(t.rotation, time)[0];
  return aeTransformToAffine({ anchor: [anchor[0], anchor[1]], position: [position[0], position[1]], scale: [scale[0], scale[1]], rotation });
}

function aeAtSpatial(t: AeLayerTransform, time: number): Affine2D {
  const anchor = evaluateAeProp(t.anchor, time);
  const position = t.separated
    ? [evaluateAeProp(t.separated.x, time)[0], evaluateAeProp(t.separated.y, time)[0]]
    : evaluateAeProp(t.position as AeProp<number[]>, time, "keys" in (t.position as AeProp<number[]>) ? "spatial" : "perDim");
  const scale = evaluateAeProp(t.scale, time);
  const rotation = evaluateAeProp(t.rotation, time)[0];
  return aeTransformToAffine({ anchor: [anchor[0], anchor[1]], position: [position[0], position[1]], scale: [scale[0], scale[1]], rotation });
}

export default async function run(): Promise<number> {
  const c = makeChecker("convert-transform");
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const randOp = (): TransformOp => ({
    translateX: -0.4 + 0.8 * rnd(),
    translateY: -0.4 + 0.8 * rnd(),
    scaleX: 0.2 + 2.5 * rnd(),
    scaleY: 0.2 + 2.5 * rnd(),
    rotateDeg: -400 + 800 * rnd(),
    pivotX: rnd(),
    pivotY: -0.2 + 1.4 * rnd(),
  });

  for (const cv of ASPECTS) {
    const tag = `${cv.width}×${cv.height}`;
    // Fixture: rotation + non-uniform scale + off-center pivot.
    const fx: TransformOp = { translateX: 0.12, translateY: -0.07, scaleX: 1.8, scaleY: 0.45, rotateDeg: 33, pivotX: 0.3, pivotY: 0.72 };
    const s = opToAeStatic(fx, cv);
    c.check(`${tag}: anchor = px(pivot), position = anchor + W·translate, scale ×100, degrees`, s.anchor[0] === 0.3 * cv.width && Math.abs(s.position[1] - (s.anchor[1] - 0.07 * cv.width)) < 1e-9 && s.scale[0] === 180 && s.rotation === 33);
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const op = i === 0 ? fx : randOp();
      worst = Math.max(worst, affineGap(aeTransformToAffine(opToAeStatic(op, cv)), opToPxAffine(op, cv), PROBES));
    }
    c.check(`${tag}: AE's T·R·S·T(−anchor) ≡ toolbox's TRS in px, 200 ops (${worst.toExponential(1)} px)`, worst < 1e-8);

    // The engine applying it: a spline through composeTransform's chain lands
    // where AE's parented chain puts the same vertices.
    const ops = [randOp(), randOp(), randOp()];
    // Gizmo C (root) → B → A: A's value = composeTransform(B's value, A's op).
    const root = composeTransform(undefined, ops[2]);
    const mid = composeTransform(root, ops[1]);
    const leaf = composeTransform(mid, ops[0]);
    const chain = transformChainToAe(leaf, cv);
    c.check(`${tag}: a 3-gizmo chain → 3 AE transforms, root first`, chain.length === 3 && chain[0].rotation === ops[2].rotateDeg && chain[2].rotation === ops[0].rotateDeg);
    const spline: SplineValue = {
      kind: "spline",
      subpaths: [
        {
          closed: true,
          anchors: [
            { pos: [0.2, 0.2], outHandle: [0.1, 0.05] },
            { pos: [0.8, 0.3], inHandle: [-0.05, -0.1] },
            { pos: [0.5, 0.9] },
          ],
        },
      ],
    };
    const moved = applyTransformToSpline(spline, leaf);
    const M = chainToAffine(chain);
    let gap = 0;
    spline.subpaths[0].anchors.forEach((a, i) => {
      const want = canvasToPx(moved.subpaths[0].anchors[i].pos, cv);
      const have = apply(M, canvasToPx(a.pos, cv));
      gap = Math.max(gap, Math.hypot(have[0] - want[0], have[1] - want[1]));
    });
    c.check(`${tag}: parent · mid · child (AE) ≡ composeTransform + applyTransformToSpline (${gap.toExponential(1)} px)`, gap < 1e-8);
    c.check(`${tag}: …and ≡ composeOpsToAffine in px`, affineGap(M, opsToPxAffine(leaf.ops, cv), PROBES) < 1e-8);
    const identity = composeTransform(composeTransform(undefined, ops[1]), { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotateDeg: 0, pivotX: 0.5, pivotY: 0.5 });
    c.check(`${tag}: an identity gizmo drops out of the chain, as composeTransform drops it`, transformChainToAe(identity, cv).length === 1);
  }

  // --- animated -------------------------------------------------------------
  const cv = { width: 1920, height: 1080 };
  const fps = 30;
  const frames: [number, number] = [0, 60];
  const measure = (tracks: AeTransformTracks, res: ReturnType<typeof transformTracksToAe>, opts: Parameters<typeof transformOpAt>[2], spatial = true) => {
    let g = 0;
    for (let f = frames[0]; f <= frames[1]; f++) {
      const t = frameTime(f, { fps });
      const have = spatial ? aeAtSpatial(res.transform, t) : aeAt(res.transform, t);
      const want = opToPxAffine(transformOpAt(tracks, f * 1000, opts), cv);
      g = Math.max(g, affineGap(have, want, PROBES));
    }
    return g;
  };

  // 1. Exact easings everywhere; translate X / Y share timing → one spatial
  //    Position; scaleX / scaleY key at different ticks → one Scale, cubics
  //    split at each other's keys.
  const t1: AeTransformTracks = {
    translateX: track([[0, 0, "easeOutCubic"], [30000, 0.3, "easeInQuad"], [60000, -0.1, "linear"]]),
    translateY: track([[0, 0.1, "easeOutCubic"], [30000, -0.2, "easeInQuad"], [60000, 0, "linear"]]),
    rotate: track([[0, 0, "easeInBack"], [60000, 270, "linear"]]),
    scaleX: track([[0, 1, "easeOutQuad"], [20000, 1.6, "linear"], [60000, 0.8, "linear"]]),
    scaleY: track([[10000, 1, "easeInCubic"], [45000, 0.5, "linear"]]),
    pivotX: 0.4,
    pivotY: 0.6,
  };
  const r1 = transformTracksToAe(t1, { canvas: cv, fps, fidelity: "exact", space: "global" });
  const g1 = measure(t1, r1, { space: "global" });
  c.check(`exact easings: AE lands on toolbox every frame (${g1.toExponential(1)} px)`, g1 < 1e-6);
  c.check("…translate shares timing → one spatial Position (not separated)", !!r1.transform.position && !r1.transform.separated && "keys" in r1.transform.position);
  c.check(
    "…Scale keys = the union of scaleX / scaleY keys (0, 1/3, 1/2… s), no dense",
    "keys" in r1.transform.scale && r1.transform.scale.keys.length === 5 && Object.values(r1.reports).every((r) => r.dense.length === 0)
  );

  // 2. Independent translate tracks → separated X / Y.
  const t2: AeTransformTracks = {
    translateX: track([[0, 0, "easeInOutSine"], [40000, 0.5, "linear"]]),
    translateY: track([[15000, 0, "easeOutExpo"], [60000, 0.3, "linear"]]),
  };
  const r2 = transformTracksToAe(t2, { canvas: cv, fps, fidelity: "editable", space: "global" });
  const g2 = measure(t2, r2, { space: "global" });
  c.check(`independent translate tracks → separated X / Y Position`, !!r2.transform.separated && !r2.transform.position);
  c.check(`…within the fits' error (${g2.toFixed(3)} px ≤ 0.1% of the move)`, g2 <= 0.001 * 0.5 * cv.width);

  // 3. Overshoot on a shared-timing translate: AE's spatial speed is a
  //    magnitude, so back easing needs separated dimensions.
  const t3: AeTransformTracks = {
    translateX: track([[0, 0, "easeOutBack"], [30000, 0.2, "linear"]]),
    translateY: track([[0, 0, "easeOutBack"], [30000, 0.1, "linear"]]),
  };
  const r3 = transformTracksToAe(t3, { canvas: cv, fps, fidelity: "editable", space: "global" });
  c.check(`back easing on shared timing → separated, said so (${r3.notes[0] ?? ""})`, !!r3.transform.separated && r3.notes.length > 0);
  c.check(`…and still exact (${measure(t3, r3, { space: "global" }).toExponential(1)} px)`, measure(t3, r3, { space: "global" }) < 1e-6);

  // 4. Local pivot on a static bounding box, pivot keyed, translate static.
  const box: AABB = { minX: 0.2, minY: 0.3, maxX: 0.6, maxY: 0.5 };
  const t4: AeTransformTracks = {
    pivotX: track([[0, 0, "easeInOutCubic"], [60000, 1, "linear"]]),
    pivotY: track([[0, 0.5, "easeInOutCubic"], [60000, 0, "linear"]]),
    translateX: 0.05,
    rotate: 20,
    scaleX: 1.5,
  };
  const r4 = transformTracksToAe(t4, { canvas: cv, fps, fidelity: "exact", space: "local", aabb: box });
  const g4 = measure(t4, r4, { space: "local", aabb: box });
  c.check(`local pivot, static box, Exact: anchor + position keyed from the pivot (${g4.toExponential(1)} px)`, g4 < 1e-6 && !r4.aabbAnimates);

  // 5. Local pivot over a moving bounding box: anchor keyed per frame.
  const moving = (tick: number): AABB => {
    const s = tick / 60000;
    return { minX: 0.1 + 0.3 * s, minY: 0.2, maxX: 0.4 + 0.3 * s, maxY: 0.5 + 0.2 * s * s };
  };
  const t5: AeTransformTracks = { rotate: track([[0, 0, "easeOutQuad"], [60000, 90, "linear"]]), pivotX: 0.5, pivotY: 0.5 };
  const r5 = transformTracksToAe(t5, { canvas: cv, fps, fidelity: "editable", space: "local", aabbAt: moving, frames });
  const g5 = measure(t5, r5, { space: "local", aabbAt: moving }, false);
  c.check(`moving bounding box → aabbAnimates, anchor keyed every frame (${g5.toExponential(1)} px at frames)`, r5.aabbAnimates && "keys" in r5.transform.anchor && r5.transform.anchor.keys.length === 61 && g5 < 1e-6);

  // 6. Pivot and translate both animate: Position sampled, `split` exact.
  const t6: AeTransformTracks = {
    pivotX: track([[0, 0.3, "easeInQuad"], [60000, 0.7, "linear"]]),
    pivotY: 0.5,
    translateX: track([[0, 0, "easeOutCubic"], [40000, 0.2, "linear"]]),
    translateY: track([[0, 0, "easeOutCubic"], [40000, 0.1, "linear"]]),
    rotate: 45,
    scaleX: 2,
  };
  const r6 = transformTracksToAe(t6, { canvas: cv, fps, fidelity: "editable", space: "global" });
  const g6 = measure(t6, r6, { space: "global" }, false);
  c.check(`pivot + translate both animate → Position sampled per frame (${g6.toExponential(1)} px at frames)`, g6 < 1e-6 && !!r6.split);
  let gs = 0;
  for (let f = frames[0]; f <= frames[1]; f++) {
    const t = frameTime(f, { fps });
    const L = aeAtSpatial(r6.split!.layer, t);
    const g = r6.split!.group;
    const anchor = evaluateAeProp(g.anchor!, t);
    const G = aeTransformToAffine({
      anchor: [anchor[0], anchor[1]],
      position: [anchor[0], anchor[1]],
      scale: evaluateAeProp(g.scale!, t) as [number, number],
      rotation: evaluateAeProp(g.rotation!, t)[0],
    });
    const M: Affine2D = {
      a: L.a * G.a + L.b * G.c,
      b: L.a * G.b + L.b * G.d,
      tx: L.a * G.tx + L.b * G.ty + L.tx,
      c: L.c * G.a + L.d * G.c,
      d: L.c * G.b + L.d * G.d,
      ty: L.c * G.tx + L.d * G.ty + L.ty,
    };
    gs = Math.max(gs, affineGap(M, opToPxAffine(transformOpAt(t6, f * 1000, { space: "global" }), cv), PROBES));
  }
  c.check(`…the split (layer = translate, group = pivot·R·S) is exact and keyed (${gs.toExponential(1)} px)`, gs < 1e-6 && "keys" in (r6.split!.layer.position as AeProp<number[]>));

  // 7. Layer clock offset: keys land in comp time.
  const r7 = transformTracksToAe({ rotate: track([[0, 0, "linear"], [30000, 90, "linear"]]) }, { canvas: cv, fps, fidelity: "editable", space: "global", offsetTicks: 15000 });
  c.check("offsetTicks shifts key times into comp time (+0.5 s at 30 fps)", "keys" in r7.transform.rotation && r7.transform.rotation.keys[0].t === 0.5 && r7.transform.rotation.keys[1].t === 1.5);
  c.check("opacity defaults to 100%", "v" in r7.transform.opacity && r7.transform.opacity.v === 100);
  return c.failures;
}
