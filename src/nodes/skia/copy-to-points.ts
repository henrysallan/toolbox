import type { InputSocketDef, NodeDefinition, ParamDef, PointsValue, SkiaDrawValue, SocketType } from "@/engine/types";
import { bindDerived, bindParam, bindStatic, type Bind, type SkiaNode } from "@/engine/skia/scene-ir";
import { sceneBounds } from "@/engine/skia/scene-bounds";
import { ATLAS_TEXTURE_MAX } from "@/engine/skia/scene-render";
import { buildDrawOrder, copyToPointsNode } from "@/nodes/effect/copy-to-points";

// Copy to Points (Skia) — the Skia-layer mirror of Copy to Points
// (specdocs/101326_skia-target.md §3.2 "points + copy-to-points → Atlas",
// §3.4 built and measured). Same params, same math, same instance types:
//
//   image / text  the instance is a Skia DRAWING (skia_draw: shapes, text,
//                 images, a Skia Group…) and the output is a drawing of
//                 one copy per point, by one of two strategies:
//                   groups  N <Group> copies of the drawing — exact vector
//                           anti-aliasing at any scale, cost ∝ N draws;
//                   atlas   the drawing rasterised once into a sprite sheet
//                           (RN useTexture), drawn as ONE <Atlas> with an
//                           RSXform per copy — what the GL node does (its
//                           instance is a raster it resamples per quad);
//                           needs uniform per-point scale (RSXform has one).
//                 `auto` picks atlas from ATLAS_AUTO_MIN copies up (measured,
//                 §3.4), groups below it or when atlas can't express it.
//   spline / point  the GL node's own CPU path (it never touches GL there):
//                 a spline / points out, which Skia Shape / Stroke draw.
//
// Each copy is the GL node's transform, in scene px:
//   x ↦ p + R(rotation + rotate_add) · S(scale · scale_mul) · (x − anchor)
// with p the point mapped like Rasterize Spline (x·W, H/2 + (y − ½)·W). The
// uniform modulation (rotate_add, scale_mul) is a separate factor about p —
// an outer Group per copy, or the atlas's rotate / scale about its pivots —
// so a keyframed modulation over static points exports as two TRACKS; point
// motion exports sampled per frame (deps: [] — upstream provenance).
//
// Not mirrored (no engine images in a Skia layer): the pick / scale_field /
// rotate_field / driver_field image inputs, and in image / text mode the
// variant pick and tint / opacity attributes.

// From this many copies `auto` draws an atlas (spec §3.4: where one atlas
// draw gets cheaper than N vector groups on the web target, measured).
export const ATLAS_AUTO_MIN = 16;
// The anti-aliasing margin around a sprite sheet's content (scene px).
export const ATLAS_SHEET_MARGIN = 2;

export const COPY_STRATEGIES = ["auto", "groups", "atlas"] as const;
export type CopyStrategy = (typeof COPY_STRATEGIES)[number];

const glParam = (name: string): ParamDef => {
  const p = copyToPointsNode.params.find((x) => x.name === name);
  if (!p) throw new Error(`copy-to-points has no param "${name}"`);
  return p;
};

const isDrawingMode = (p: Record<string, unknown>) => p.mode !== "spline" && p.mode !== "point";

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// The GL node's "content center", reproduced from the drawing's analytic
// box: Copy to Points reads the instance back at ≤128 px on the long edge
// (readImagePixels: one bilinear tap per texel, at its centre) and anchors
// on the centre of the alpha bbox padded by one texel (getContentRect). A
// source pixel has ink when the box touches it (anti-aliasing gives it
// coverage); a texel sees the one or two pixels its tap straddles. So the
// anchor lands on that coarse grid exactly as the GL node's does — up to a
// texel (4 px at 512²) from the box's own centre on asymmetric drawings.
export function glContentCenter(box: [number, number, number, number], W: number, H: number): [number, number] {
  const MAX = 128;
  const aspect = W / H;
  let w: number;
  let h: number;
  if (W >= H) {
    w = Math.min(MAX, W);
    h = Math.max(1, Math.round(w / aspect));
  } else {
    h = Math.min(MAX, H);
    w = Math.max(1, Math.round(h * aspect));
  }
  const axis = (lo: number, hi: number, size: number, n: number): [number, number] | null => {
    // Pixels with coverage: [floor(lo), ceil(hi) − 1], clamped to the image.
    const p0 = Math.max(0, Math.floor(lo));
    const p1 = Math.min(size - 1, Math.ceil(hi) - 1);
    if (p1 < p0) return null;
    let t0 = -1;
    let t1 = -1;
    for (let i = 0; i < n; i++) {
      const s = ((i + 0.5) * size) / n - 0.5;
      const a = Math.floor(s);
      const b = s > a ? a + 1 : a;
      if (b >= p0 && a <= p1) {
        if (t0 < 0) t0 = i;
        t1 = i;
      }
    }
    if (t0 < 0) return null;
    const m0 = Math.max(0, t0 - 1);
    const m1 = Math.min(n - 1, t1 + 1);
    return [m0 / n, (m1 - m0 + 1) / n];
  };
  const x = axis(box[0], box[2], W, w);
  const y = axis(box[1], box[3], H, h);
  // Nothing visible: the GL node falls back to the full rect.
  const rx = x ?? [0, 1];
  const ry = y && x ? y : [0, 1];
  return [(rx[0] + rx[1] / 2) * W, (ry[0] + ry[1] / 2) * H];
}

export interface CopyPlacement {
  // Scene px of each copy's point, in DRAW order.
  px: number[];
  py: number[];
  rot: number[];
  sx: number[];
  sy: number[];
}

// The points in draw order, mapped to scene px (Rasterize Spline's canvas01
// mapping — the GL vertex shader's aspect-corrected center).
export function copyPlacement(pts: PointsValue, W: number, H: number, drawOrder: string, seed: number): CopyPlacement {
  const n = pts.count;
  const order = buildDrawOrder(pts, drawOrder, seed);
  const out: CopyPlacement = { px: [], py: [], rot: [], sx: [], sy: [] };
  for (let oi = 0; oi < n; oi++) {
    const i = order ? order[oi] : oi;
    out.px.push(pts.positions[i * 2] * W);
    out.py.push(H / 2 + (pts.positions[i * 2 + 1] - 0.5) * W);
    out.rot.push(pts.rotations ? pts.rotations[i] : 0);
    out.sx.push(pts.scales ? pts.scales[i * 2] : 1);
    out.sy.push(pts.scales ? pts.scales[i * 2 + 1] : 1);
  }
  return out;
}

export const skiaCopyToPointsNode: NodeDefinition = {
  type: "skia-copy-to-points",
  name: "Copy to Points (Skia)",
  category: "point",
  subcategory: "modifier",
  description:
    "Copy to Points for Skia layers: a Skia drawing (or a spline / points) at every target point, with the per-point rotation and scale, the anchor, draw order and uniform Scale × / Rotate + of Copy to Points. Drawings copy as N React Native Skia Groups (exact vector edges, cost grows with N) or as one Atlas of a rasterised sprite sheet (one draw for thousands of copies; uniform scale only) — Strategy auto picks by count. Spline / point instances run Copy to Points' own math and feed Skia Shape.",
  searchAliases: ["skia", "copy to points", "instance", "atlas", "scatter", "react native"],
  facts: {
    space: {
      "in:points": "canvas01",
      out: ["pixels", "canvas01"],
      "param:anchor_x": ["uv01", "canvas01"],
      "param:anchor_y": ["uv01", "canvas01"],
    },
    writes: ["attr:driver"],
    gotchas: [
      "Strategy atlas draws a rasterised sprite sheet: copies scaled up soften like the GL node's; groups stay crisp. Atlas needs scale.x = scale.y on every point, else it draws groups.",
      "An atlas sheet renders once: if the instance drawing animates, its export is refused — set Strategy to groups.",
      "anchor=content center measures the drawing's geometry; text and fills have no measurable extent, so they anchor at the canvas center.",
      "Copies of a drawing are not cropped to the canvas (the GL node's instance is a canvas-sized raster and is); a Fill in the instance is.",
      "rotate_add_default is radians; a keyframed Scale × / Rotate + over static points exports as tracks, moving points as per-frame samples.",
      "Spline / point modes are Copy to Points' own CPU path (pick, draw order, tags, driver attribute); the pick / field image inputs do not exist here.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "copy-to-points" },
  noMaskInput: true,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "instance", type: "skia_draw", required: true },
    { name: "scale_mul", type: "scalar", required: false, label: "Scale × (uniform)" },
    { name: "rotate_add", type: "scalar", required: false, label: "Rotate + (uniform)" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const instType: SocketType = params.mode === "spline" ? "spline" : params.mode === "point" ? "points" : "skia_draw";
    return [
      { name: "points", type: "points", required: true },
      { name: "instance", type: instType, required: true },
      { name: "scale_mul", type: "scalar", required: false, label: "Scale × (uniform)" },
      { name: "rotate_add", type: "scalar", required: false, label: "Rotate + (uniform)" },
    ];
  },
  params: [
    glParam("mode"),
    {
      name: "strategy",
      label: "Strategy",
      type: "enum",
      options: [...COPY_STRATEGIES],
      optionLabels: { auto: "Auto", groups: "Groups (vector)", atlas: "Atlas (sprites)" },
      default: "auto",
      visibleIf: isDrawingMode,
    },
    { ...glParam("pick_mode"), visibleIf: (p) => !isDrawingMode(p) },
    glParam("pick_attr"),
    glParam("pick_seed"),
    glParam("anchor"),
    glParam("anchor_x"),
    glParam("anchor_y"),
    glParam("draw_order"),
    glParam("output_tag"),
    glParam("driver_attr"),
    glParam("scale_mul_default"),
    glParam("rotate_add_default"),
  ],
  primaryOutput: "skia_draw",
  resolvePrimaryOutput(params): SocketType {
    return params.mode === "spline" ? "spline" : params.mode === "point" ? "points" : "skia_draw";
  },
  auxOutputs: [],

  compute(args) {
    const { inputs, params, ctx, nodeId } = args;
    if (!isDrawingMode(params)) {
      // The GL node's spline / point modes are pure CPU — run them as-is
      // (no pick image exists in a Skia layer, so the sampler stays off).
      return copyToPointsNode.compute({ ...args, inputs: { points: inputs.points, instance: inputs.instance, scale_mul: inputs.scale_mul, rotate_add: inputs.rotate_add } });
    }
    const W = ctx.width;
    const H = ctx.height;
    const instIn = inputs.instance;
    const inst = instIn?.kind === "skia_draw" ? (instIn as SkiaDrawValue) : null;
    const pts = inputs.points?.kind === "points" ? (inputs.points as PointsValue) : null;
    const pass = (node: SkiaNode, problems: string[] = []): { primary: SkiaDrawValue } => {
      const all = [...(inst?.problems ?? []), ...problems];
      return {
        primary: {
          kind: "skia_draw",
          node,
          ...(inst?.assets ? { assets: inst.assets } : {}),
          ...(all.length ? { problems: all } : {}),
        },
      };
    };
    if (!inst || !pts || pts.count === 0) return pass({ k: "group", id: nodeId, children: [] });

    // Derived from this node's inputs and params: the exporter walks the
    // graph from `nodeId` and samples when anything upstream moves.
    const D = (v: number): Bind<number> => bindDerived(v, []);
    const DA = (v: number[]): Bind<number[]> => bindDerived(v, []);

    // Uniform modulation: a wired scalar wins over the default param (the
    // GL node's rule); a param binds directly, so keyframes are a track.
    const mulIn = inputs.scale_mul;
    const rotIn = inputs.rotate_add;
    const mulB = (): Bind<number> =>
      mulIn?.kind === "scalar" ? D(mulIn.value) : bindParam(num(params.scale_mul_default, 1), nodeId, "scale_mul_default");
    const rotB = (): Bind<number> =>
      rotIn?.kind === "scalar" ? D(rotIn.value) : bindParam(num(params.rotate_add_default, 0), nodeId, "rotate_add_default");

    // The anchor in scene px (the copies' pivot, landing on the point).
    const bounds = sceneBounds(inst.node);
    const anchorMode = (params.anchor as string | undefined) ?? "canvas center";
    let ax: Bind<number>;
    let ay: Bind<number>;
    let negAx: Bind<number>;
    let negAy: Bind<number>;
    let axV: number;
    let ayV: number;
    if (anchorMode === "custom") {
      // A fraction of the instance's own bounds — the canvas, for a drawing
      // (the GL node's instance image is canvas-sized).
      const fx = num(params.anchor_x, 0.5);
      const fy = num(params.anchor_y, 0.5);
      axV = fx * W;
      ayV = fy * H;
      ax = { v: axV, ref: { node: nodeId, param: "anchor_x", scale: W } };
      ay = { v: ayV, ref: { node: nodeId, param: "anchor_y", scale: H } };
      negAx = { v: -axV, ref: { node: nodeId, param: "anchor_x", scale: -W } };
      negAy = { v: -ayV, ref: { node: nodeId, param: "anchor_y", scale: -H } };
    } else if (anchorMode === "content center" && bounds.box && !bounds.unbounded) {
      [axV, ayV] = glContentCenter(bounds.box, W, H);
      ax = D(axV);
      ay = D(ayV);
      negAx = D(-axV);
      negAy = D(-ayV);
    } else {
      axV = W / 2;
      ayV = H / 2;
      ax = bindStatic(axV);
      ay = bindStatic(ayV);
      negAx = bindStatic(-axV);
      negAy = bindStatic(-ayV);
    }

    const place = copyPlacement(pts, W, H, (params.draw_order as string) ?? "points order", Math.floor(num(params.pick_seed, 0)));
    const n = place.px.length;

    // The sprite sheet: the drawing's box plus an AA margin, whole px; the
    // canvas when the drawing has no finite extent (a Fill fills it).
    const sheet: [number, number, number, number] | null = (() => {
      const b = bounds.unbounded || !bounds.box ? [0, 0, W, H] : bounds.box;
      const m = bounds.unbounded || !bounds.box ? 0 : ATLAS_SHEET_MARGIN;
      const x0 = Math.floor(b[0] - m);
      const y0 = Math.floor(b[1] - m);
      const x1 = Math.ceil(b[2] + m);
      const y1 = Math.ceil(b[3] + m);
      const w = x1 - x0;
      const h = y1 - y0;
      return w > 0 && h > 0 && w <= ATLAS_TEXTURE_MAX && h <= ATLAS_TEXTURE_MAX ? [x0, y0, w, h] : null;
    })();
    const uniform = place.sx.every((s, i) => s === place.sy[i]);
    const strategy = (params.strategy as CopyStrategy | undefined) ?? "auto";
    const atlasOk = uniform && !!sheet;
    const useAtlas = atlasOk && (strategy === "atlas" || (strategy === "auto" && n >= ATLAS_AUTO_MIN));

    if (useAtlas) {
      const [x0, y0, w, h] = sheet!;
      // Anchor in the sheet's local px.
      const lx = axV - x0;
      const ly = ayV - y0;
      const xf: number[] = [];
      const pv: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = place.sx[i] * Math.cos(place.rot[i]);
        const b = place.sx[i] * Math.sin(place.rot[i]);
        xf.push(a, b, place.px[i] - (a * lx - b * ly), place.py[i] - (b * lx + a * ly));
        pv.push(place.px[i], place.py[i]);
      }
      return pass({
        k: "atlas",
        id: nodeId,
        asset: `${nodeId}:sheet`,
        sprites: Array.from({ length: n }, () => [0, 0, w, h] as [number, number, number, number]),
        xforms: DA(xf),
        texture: { node: inst.node, rect: [x0, y0, w, h] },
        pivots: DA(pv),
        rotate: rotB(),
        scale: mulB(),
      });
    }

    // Groups: per copy, T(p)·R(rotate_add)·S(scale_mul) outside (direct
    // binds → tracks) and the point's own R(rotation)·S(scale)·T(−anchor)
    // inside. Rotations and uniform scales commute, so the product is the
    // GL node's T(p)·R(rot + add)·S(scale·mul)·T(−anchor) exactly.
    const hasRot = !!pts.rotations;
    const hasScale = !!pts.scales;
    // A Fill in the instance fills everything: crop it to the canvas, as the
    // GL node's canvas-sized instance image is.
    const clip = bounds.why.some((w) => w.startsWith("a fill"))
      ? { geom: { k: "rect" as const, x: bindStatic(0), y: bindStatic(0), w: bindStatic(W), h: bindStatic(H) } }
      : undefined;
    const copies: SkiaNode[] = [];
    for (let i = 0; i < n; i++) {
      const inner: SkiaNode = {
        k: "group",
        id: nodeId,
        transform: {
          translate: [i === 0 ? negAx : { ...negAx }, i === 0 ? negAy : { ...negAy }],
          origin: [i === 0 ? ax : { ...ax }, i === 0 ? ay : { ...ay }],
          ...(hasRot ? { rotate: D(place.rot[i]) } : {}),
          ...(hasScale ? { scale: [D(place.sx[i]), D(place.sy[i])] as [Bind<number>, Bind<number>] } : {}),
        },
        ...(clip ? { clip } : {}),
        children: [inst.node],
      };
      copies.push({
        k: "group",
        id: nodeId,
        transform: { translate: [D(place.px[i]), D(place.py[i])], rotate: rotB(), scale: [mulB(), mulB()] },
        children: [inner],
      });
    }
    return pass({ k: "group", id: nodeId, children: copies });
  },

  dispose(ctx, nodeId) {
    // The spline / point path keeps the GL node's CPU state under its key.
    delete ctx.state[`copy-to-points:${nodeId}`];
  },
};
