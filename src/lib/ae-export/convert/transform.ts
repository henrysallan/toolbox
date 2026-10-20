// After Effects export — transforms (spec 091926_after-effects-handoff.md §4.1).
//
// Toolbox's TRS is translate · pivot · rotate · scale · pivot⁻¹ in canvas01
// (trsToAffine); AE's layer (and shape-group) transform is
// T(position) · R · S · T(−anchor) in layer px. The canvas01 → px map is a
// similarity, so the two agree term for term:
//
//   anchor   = px(pivot)
//   position = px(pivot) + W·translate
//   scale    = 100·[sx, sy]          rotation = rotateDeg (clockwise, both)
//
// Composition order is the same too — toolbox applies parent ∘ local (local
// first, composeTransform), AE renders parent · child — so a Gizmo chain is
// a chain of parented null layers, each converted on its own.
//
// `space=local` (Transform's default) makes the pivot a fraction of the
// incoming geometry's bounding box (transform-pivot.ts localPivot); the
// exporter passes that box (or a per-tick function) and learns whether it
// animates, in which case the anchor is keyed every frame.

import type { TransformOp, TransformValue } from "@/engine/types";
import { composeOpsToAffine, isIdentityOp, multiplyAffine, trsToAffine, type Affine2D } from "@/engine/transform-value";
import { localPivot, type AABB } from "@/engine/transform-pivot";
import { evaluateKeyframesAt } from "@/engine/keyframes";
import type { AeLayerTransform, AeProp, AeShapeTransform } from "../types";
import { canvasAxisAffine, canvasDeltaToPx, canvasToPx, type AeCanvas } from "./coords";
import {
  combinedTracksToAe,
  isKeyed,
  keyFrameSpan,
  numericTrackToAe,
  sampledTrackToAe,
  spatialTrackToAe,
  tracksShareTiming,
  type AeKeyContext,
  type AeTrackReport,
  type AeTrackSource,
} from "./keys";

// ---- static ----------------------------------------------------------------

export interface AeStaticTransform {
  anchor: [number, number];
  position: [number, number];
  scale: [number, number]; // percent
  rotation: number; // degrees
}

export function opToAeStatic(op: TransformOp, c: AeCanvas): AeStaticTransform {
  const pivot = canvasToPx([op.pivotX, op.pivotY], c);
  const t = canvasDeltaToPx([op.translateX, op.translateY], c);
  return {
    anchor: pivot,
    position: [pivot[0] + t[0], pivot[1] + t[1]],
    scale: [op.scaleX * 100, op.scaleY * 100],
    rotation: op.rotateDeg,
  };
}

export function opToAeLayerTransform(op: TransformOp, c: AeCanvas, opacity = 1): AeLayerTransform {
  const s = opToAeStatic(op, c);
  return {
    anchor: { v: s.anchor },
    position: { v: s.position },
    scale: { v: s.scale },
    rotation: { v: s.rotation },
    opacity: { v: opacity * 100 },
  };
}

export function opToAeShapeTransform(op: TransformOp, c: AeCanvas): AeShapeTransform {
  const s = opToAeStatic(op, c);
  return { anchor: { v: s.anchor }, position: { v: s.position }, scale: { v: s.scale }, rotation: { v: s.rotation } };
}

// AE's matrix for static values: T(position) · R(rotation) · S(scale/100) ·
// T(−anchor), in layer px (Y-down, clockwise-positive degrees).
export function aeTransformToAffine(t: AeStaticTransform): Affine2D {
  const r = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = t.scale[0] / 100;
  const sy = t.scale[1] / 100;
  const a = cos * sx;
  const b = -sin * sy;
  const c = sin * sx;
  const d = cos * sy;
  return {
    a,
    b,
    c,
    d,
    tx: t.position[0] - a * t.anchor[0] - b * t.anchor[1],
    ty: t.position[1] - c * t.anchor[0] - d * t.anchor[1],
  };
}

// A canvas01 affine (composeOpsToAffine, trsToAffine) re-expressed in layer px:
// K · M · K⁻¹ with K(x, y) = (W·x, W·y + (H − W)/2).
export function canvasAffineToPx(m: Affine2D, c: AeCanvas): Affine2D {
  const W = c.width;
  const oy = 0.5 * (c.height - c.width);
  const K: Affine2D = { a: W, b: 0, tx: 0, c: 0, d: W, ty: oy };
  const Kinv: Affine2D = { a: 1 / W, b: 0, tx: 0, c: 0, d: 1 / W, ty: -oy / W };
  return multiplyAffine(K, multiplyAffine(m, Kinv));
}

// A TransformValue's ops (local first, composeTransform's order) → AE
// transforms ROOT FIRST: result[0] is the outermost parent (the last op),
// result[i + 1] is parented to result[i] (or nested inside it as a shape
// group). The product of their matrices is composeOpsToAffine(ops) in px.
// Identity ops are skipped, as composeOpsToAffine skips them.
export function transformChainToAe(t: TransformValue, c: AeCanvas): AeStaticTransform[] {
  return t.ops.filter((op) => !isIdentityOp(op)).reverse().map((op) => opToAeStatic(op, c));
}

export function chainToAffine(chain: readonly AeStaticTransform[]): Affine2D {
  let m: Affine2D = { a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0 };
  for (const t of chain) m = multiplyAffine(m, aeTransformToAffine(t));
  return m;
}

// The toolbox side of the same thing, for gates and reports.
export function opsToPxAffine(ops: TransformOp[], c: AeCanvas): Affine2D {
  return canvasAffineToPx(composeOpsToAffine(ops), c);
}

export function opToPxAffine(op: TransformOp, c: AeCanvas): Affine2D {
  return canvasAffineToPx(trsToAffine(op), c);
}

// ---- animated --------------------------------------------------------------

// A Transform / Gizmo node's TRS as tracks (a block) or constants (the stored
// param). Missing = the param default. Opacity is 0–1 (layer / universal
// opacity), emitted as percent.
export interface AeTransformTracks {
  translateX?: AeTrackSource;
  translateY?: AeTrackSource;
  scaleX?: AeTrackSource;
  scaleY?: AeTrackSource;
  rotate?: AeTrackSource;
  pivotX?: AeTrackSource;
  pivotY?: AeTrackSource;
  opacity?: AeTrackSource;
}

export interface AeTransformOptions extends AeKeyContext {
  canvas: AeCanvas;
  // Transform's `space` param: "local" (Source — the pivot is a bbox
  // fraction; Transform's default) or "global" (Canvas; Gizmo always).
  space?: "local" | "global";
  // Local space: the incoming geometry's AABB (canvas01), static…
  aabb?: AABB | null;
  // …or per tick of the track's clock (sampled at every frame of `frames`).
  aabbAt?: (tick: number) => AABB | null;
  // Comp frames to cover when something must be sampled. Default: the span
  // of every keyed track.
  frames?: [number, number];
}

export interface AeTransformResult {
  transform: AeLayerTransform;
  // Present when the position had to be sampled per frame (the pivot moves
  // under an independently eased translate): the exact, still-keyed split for
  // a SHAPE layer — the layer carries the translation (anchor 0), a shape
  // group carries pivot / rotation / scale. world = layer · group.
  split?: { layer: AeLayerTransform; group: AeShapeTransform };
  // Local space only: the bounding box moves, so the anchor is keyed per frame.
  aabbAnimates: boolean;
  // Per AE property.
  reports: Record<string, AeTrackReport>;
  notes: string[];
}

const DEFAULTS = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotate: 0, pivotX: 0.5, pivotY: 0.5, opacity: 1 };

function valueAt(src: AeTrackSource, tick: number, fallback: number): number {
  if (src === undefined) return fallback;
  if (typeof src === "number") return src;
  if (Array.isArray(src)) return typeof src[0] === "number" ? src[0] : fallback;
  if (!src.animated || src.keyframes.length === 0) return fallback;
  const v = evaluateKeyframesAt(src, "scalar", tick);
  return typeof v === "number" ? v : fallback;
}

function sameAabb(a: AABB | null, b: AABB | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.minX - b.minX) < 1e-12 && Math.abs(a.minY - b.minY) < 1e-12 && Math.abs(a.maxX - b.maxX) < 1e-12 && Math.abs(a.maxY - b.maxY) < 1e-12;
}

// Toolbox's op at a tick, as Transform's compute builds it (opFromParams's
// clamp, localPivot's bbox fraction) — the oracle for gates and the sampled
// paths below.
export function transformOpAt(tracks: AeTransformTracks, tick: number, opts: Pick<AeTransformOptions, "space" | "aabb" | "aabbAt">): TransformOp {
  const v = (k: keyof typeof DEFAULTS) => valueAt(tracks[k], tick, DEFAULTS[k]);
  const op: TransformOp = {
    translateX: v("translateX"),
    translateY: v("translateY"),
    scaleX: Math.max(0.0001, v("scaleX")),
    scaleY: Math.max(0.0001, v("scaleY")),
    rotateDeg: v("rotate"),
    pivotX: v("pivotX"),
    pivotY: v("pivotY"),
  };
  if (opts.space === "local") {
    const box = opts.aabbAt ? opts.aabbAt(tick) : (opts.aabb ?? null);
    const p = localPivot(box, op.pivotX, op.pivotY);
    op.pivotX = p.x;
    op.pivotY = p.y;
  }
  return op;
}

// The Transform / Gizmo tracks → an AE layer transform, keyed where toolbox is
// keyed, eases preserved through the affine maps above, verified per frame
// (keys.ts) and densified only where AE has no form.
export function transformTracksToAe(tracks: AeTransformTracks, opts: AeTransformOptions): AeTransformResult {
  const c = opts.canvas;
  const notes: string[] = [];
  const reports: Record<string, AeTrackReport> = {};
  const tpf = opts.ticksPerFrame ?? 1000;
  const span = (): [number, number] => {
    if (opts.frames) return opts.frames;
    const spans = Object.values(tracks)
      .map((s) => keyFrameSpan(s, opts))
      .filter((x): x is [number, number] => !!x);
    if (spans.length === 0) return [0, 0];
    return [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))];
  };

  // --- the pivot in px: an affine map of the pivot tracks, or sampled.
  let aabbAnimates = false;
  let box: AABB | null = null;
  if (opts.space === "local") {
    if (opts.aabbAt) {
      const [f0, f1] = span();
      const off = opts.offsetTicks ?? 0;
      box = opts.aabbAt(f0 * tpf - off);
      for (let f = f0 + 1; f <= f1 && !aabbAnimates; f++) aabbAnimates = !sameAabb(box, opts.aabbAt(f * tpf - off));
    } else box = opts.aabb ?? null;
  }
  const degenerate = !box || box.maxX <= box.minX || box.maxY <= box.minY;
  const ax = canvasAxisAffine("x", c);
  const ay = canvasAxisAffine("y", c);
  // pivot_px = W·(minX + p·w) for a static box (localPivot), W·p for canvas.
  const pivotMapX = opts.space === "local" && !degenerate ? { scale: ax.scale * (box!.maxX - box!.minX), offset: ax.scale * box!.minX + ax.offset } : ax;
  const pivotMapY = opts.space === "local" && !degenerate ? { scale: ay.scale * (box!.maxY - box!.minY), offset: ay.scale * box!.minY + ay.offset } : ay;
  const pivotParts = [
    { src: tracks.pivotX ?? DEFAULTS.pivotX, paramType: "scalar" as const },
    { src: tracks.pivotY ?? DEFAULTS.pivotY, paramType: "scalar" as const },
  ];
  const pivotKeyed = isKeyed(tracks.pivotX) || isKeyed(tracks.pivotY);
  const pivotOracle = (tick: number): number[] => {
    const op = transformOpAt(tracks, tick, opts);
    return canvasToPx([op.pivotX, op.pivotY], c);
  };
  let anchor: AeProp<number[]>;
  if (aabbAnimates) {
    const r = sampledTrackToAe(span(), pivotOracle, opts, "local pivot on an animated bounding box");
    anchor = r.prop;
    reports.anchor = r.report;
    notes.push("space=local over a moving bounding box: the anchor is keyed every frame");
  } else {
    const r = combinedTracksToAe(pivotParts, { ...opts, map: [pivotMapX, pivotMapY] });
    anchor = r.prop as AeProp<number[]>;
    reports.anchor = r.report;
  }

  // --- position = pivot + W·translate.
  const translateKeyed = isKeyed(tracks.translateX) || isKeyed(tracks.translateY);
  const pivotStatic = !pivotKeyed && !aabbAnimates;
  const transform: AeLayerTransform = {
    anchor,
    scale: { v: [100, 100] },
    rotation: { v: 0 },
    opacity: { v: 100 },
  };
  // Position from two scalar sources with per-axis affine maps: one spatial
  // property when they share timing and the progress is monotone, separated
  // dimensions otherwise.
  const positionFrom = (
    target: AeLayerTransform,
    xs: AeTrackSource,
    ys: AeTrackSource,
    mx: { scale: number; offset: number },
    my: { scale: number; offset: number },
    label: string
  ) => {
    const parts = [
      { src: xs, paramType: "scalar" as const },
      { src: ys, paramType: "scalar" as const },
    ];
    const keyed = isKeyed(xs) || isKeyed(ys);
    if (keyed && tracksShareTiming([xs, ys])) {
      const sp = spatialTrackToAe(parts, { ...opts, map: [mx, my] });
      if (sp) {
        target.position = sp.prop;
        reports.position = sp.report;
        return;
      }
      notes.push(`${label}: the easing overshoots or reverses — AE's spatial speed cannot, so X / Y position are separated`);
    }
    if (!keyed) {
      const r = combinedTracksToAe(parts, { ...opts, map: [mx, my] });
      target.position = r.prop as AeProp<number[]>;
      reports.position = r.report;
      return;
    }
    const x = numericTrackToAe(xs, "scalar", { ...opts, map: mx });
    const y = numericTrackToAe(ys, "scalar", { ...opts, map: my });
    target.separated = { x: x.prop as AeProp<number>, y: y.prop as AeProp<number> };
    reports.xPosition = x.report;
    reports.yPosition = y.report;
  };

  let split: AeTransformResult["split"];
  const W = c.width;
  if (pivotStatic) {
    // pivot_px is a constant: offset the translate tracks by it.
    const p = pivotOracle(0);
    positionFrom(transform, tracks.translateX ?? 0, tracks.translateY ?? 0, { scale: W, offset: p[0] }, { scale: W, offset: p[1] }, "translate");
  } else if (!translateKeyed && !aabbAnimates) {
    // translate is a constant: offset the pivot tracks by it.
    const tx = valueAt(tracks.translateX, 0, 0) * W;
    const ty = valueAt(tracks.translateY, 0, 0) * W;
    positionFrom(
      transform,
      tracks.pivotX ?? DEFAULTS.pivotX,
      tracks.pivotY ?? DEFAULTS.pivotY,
      { scale: pivotMapX.scale, offset: pivotMapX.offset + tx },
      { scale: pivotMapY.scale, offset: pivotMapY.offset + ty },
      "pivot"
    );
  } else {
    // Two independently moving terms: no single keyed track carries their
    // sum. Sample it, and offer the exact split.
    const r = sampledTrackToAe(
      span(),
      (tick) => {
        const op = transformOpAt(tracks, tick, opts);
        const p = canvasToPx([op.pivotX, op.pivotY], c);
        return [p[0] + op.translateX * W, p[1] + op.translateY * W];
      },
      opts,
      "pivot and translate both animate"
    );
    transform.position = r.prop;
    reports.position = r.report;
    notes.push("pivot and translate both animate: Position is sampled per frame; `split` keeps both keyed for a shape layer");
    const layer: AeLayerTransform = { anchor: { v: [0, 0] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } };
    positionFrom(layer, tracks.translateX ?? 0, tracks.translateY ?? 0, { scale: W, offset: 0 }, { scale: W, offset: 0 }, "translate");
    split = { layer, group: { anchor: anchor as AeProp<[number, number]>, position: anchor as AeProp<[number, number]> } };
  }

  // --- scale (percent, per-dimension eases on one property), rotation, opacity.
  const scale = combinedTracksToAe(
    [
      { src: tracks.scaleX ?? DEFAULTS.scaleX, paramType: "scalar" },
      { src: tracks.scaleY ?? DEFAULTS.scaleY, paramType: "scalar" },
    ],
    { ...opts, map: { scale: 100, offset: 0 } }
  );
  transform.scale = scale.prop as AeProp<number[]>;
  reports.scale = scale.report;
  for (const k of ["scaleX", "scaleY"] as const) {
    const s = tracks[k];
    if (isKeyed(s) && s.keyframes.some((kf) => typeof kf.value === "number" && kf.value < 0.0001)) {
      notes.push(`${k} keys below 0.0001: toolbox clamps them (opFromParams), AE would mirror`);
    }
  }
  const rot = numericTrackToAe(tracks.rotate ?? DEFAULTS.rotate, "scalar", opts);
  transform.rotation = rot.prop as AeProp<number>;
  reports.rotation = rot.report;
  const op = numericTrackToAe(tracks.opacity ?? DEFAULTS.opacity, "scalar", { ...opts, map: { scale: 100, offset: 0 } });
  transform.opacity = op.prop as AeProp<number>;
  reports.opacity = op.report;
  if (split) {
    split.group.scale = transform.scale as AeProp<[number, number]>;
    split.group.rotation = transform.rotation;
    split.layer.opacity = transform.opacity;
  }
  return { transform, split, aabbAnimates, reports, notes };
}
