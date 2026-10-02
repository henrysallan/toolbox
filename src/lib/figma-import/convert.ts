// Figma scene → toolbox node graph (specdocs/092326_figma-import.md).
//
// Pure: no DOM, no GL. Decoded images come in through `opts.images` as
// opaque runtime values (ImageBitmaps in the editor, stand-ins in the check
// gate) and land verbatim in Image Source `file` params.
//
// The graph mirrors Figma's compositing tree:
//   - A frame's children, bottom → top, become the layer stack of a Merge.
//     The frame's own background is the Merge base when it is one flat
//     colour on a plain rectangle; otherwise it is the bottom layer(s).
//   - A shape is Spline Draw (its fillGeometry, corner radii and booleans
//     already baked by Figma) → Rasterize Spline. Fill + a centred stroke
//     share one Rasterize; extra paints get their own. Inside / outside
//     strokes are Figma's own trick: twice the weight, masked by the fill
//     shape (inverted for outside) through the Merge layer's mask socket.
//   - An image fill is Image Source (placed with its TRS) → Rasterize
//     Spline's `fill` input (window fit), which clips it to the shape. A
//     rotated / flipped placement is baked into the bitmap (FigmaBitmapOp)
//     so the Image Source itself stays axis-aligned.
//   - Text is live Text nodes placed on Figma's own layout (text-layout.ts):
//     its line breaks, and each first baseline solved against the Text
//     node's em-box line anchor (FigmaTextMeasure). Rotated text, or text
//     without layout data, falls back to its glyph outlines.
//   - Containers FLATTEN into the parent's stack unless compositing needs
//     them isolated — opacity over several layers, a non-normal blend, a
//     clip that actually cuts something, or masks. An isolated container is
//     its own Merge, feeding one layer of the parent.
//   - isMask layers mask the siblings above them: those siblings become a
//     nested Merge whose parent layer takes the mask shape as its matte.

import type { Edge } from "@xyflow/react";
import type { SplineSubpath } from "@/engine/types";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  type GraphNode,
} from "@/state/graph-ops";
import { newLayerId, type BlendMode, type MergeLayer } from "@/nodes/effect/merge";
import { tidyLayout } from "@/state/node-layout";
import { applyPositions, toLayoutGraph } from "@/state/node-layout-graph";
import type {
  FigmaContainerNode,
  FigmaImagePaint,
  FigmaPaint,
  FigmaRGB,
  FigmaRasterNode,
  FigmaScene,
  FigmaSceneNode,
  FigmaStroke,
  FigmaTextNode,
  FigmaVectorPath,
} from "./scene";
import { buildTextPieces, parseFigmaTextSvg, type TextPiece } from "./text-layout";
import {
  applyAffine,
  boundsInside,
  boxBounds,
  frameToSpline,
  hullBounds,
  invertAffine,
  isPlainRect,
  IDENTITY_AFFINE,
  mulAffine,
  pathsToSubpaths,
  type Affine,
  type Bounds,
} from "./geometry";

// Font facts only a browser can answer, for placing live text. Absent (the
// check gate) → an Inter-like estimate and no availability notes.
export interface FigmaTextMeasure {
  // How far below the Text node's per-line anchor — canvas
  // textBaseline "middle", the em box's centre — the alphabetic baseline
  // sits for this font at `size` px.
  baselineBelowMiddle(font: { family: string; weight: number; italic: boolean; size: number }): number;
  // Whether the family actually renders here (false = a fallback font).
  fontAvailable?(family: string, weight: number, italic: boolean): boolean;
}

export interface FigmaImportOptions {
  // Decoded images keyed like FigmaScene.images (imageHash / imageRef).
  images?: Map<string, unknown>;
  // Decoded FigmaScene.reference — becomes a detached "Figma reference"
  // Image Source for A/B and compare_renders parity checks.
  reference?: unknown;
  text?: FigmaTextMeasure;
}

// A rotated / flipped / sheared image placement, baked into the bitmap by
// the caller: draw the source through `matrix` into a width × height
// canvas and put the result in node `nodeId`'s `file` param. Image Source's
// own rotate works in per-axis uv, which skews on any non-square comp —
// baking keeps every placement axis-aligned and exact.
export interface FigmaBitmapOp {
  nodeId: string;
  imageKey: string;
  width: number;
  height: number;
  // Canvas setTransform(a, b, c, d, e, f) taking the image's UNIT square
  // (0..1 on both axes) to output px — divide a, b by the bitmap's width
  // and c, d by its height before drawing it at (0, 0).
  matrix: [number, number, number, number, number, number];
}

export interface FigmaImportStats {
  shapes: number;
  texts: number;
  images: number;
  containers: number;
  merges: number;
}

export interface FigmaImportResult {
  nodes: GraphNode[];
  edges: Edge[];
  // The composited frame — wire it into the enclosing Layer's Group Output.
  output: { nodeId: string; handle: string };
  referenceNodeId: string | null;
  frame: { name: string; width: number; height: number };
  warnings: string[];
  stats: FigmaImportStats;
  bitmapOps: FigmaBitmapOp[];
}

interface Port {
  nodeId: string;
  handle: string;
}

// One layer of a Merge stack, before the Merge exists.
interface LayerEntry {
  source: Port;
  name: string;
  mode: BlendMode;
  opacity: number;
  mask?: Port;
  maskInvert?: boolean;
}

interface Ctx {
  scene: FigmaScene;
  W: number;
  H: number;
  toSpline: Affine;
  opts: FigmaImportOptions;
  nodes: GraphNode[];
  edges: Edge[];
  warnings: Map<string, number>;
  stats: FigmaImportStats;
  transparent: Port | null;
  bitmapOps: FigmaBitmapOp[];
  fontsChecked: Set<string>;
}

// ---- small helpers ----------------------------------------------------------

function warn(ctx: Ctx, message: string): void {
  ctx.warnings.set(message, (ctx.warnings.get(message) ?? 0) + 1);
}

// Figma layer names can hold line breaks (a text layer is named after its
// content, soft breaks and all) — flatten them for node headers and Merge
// layer cards. Built from char codes: U+2028 / U+2029 can't sit in a
// regex literal.
const NAME_BREAKS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029, 0x0a, 0x0d, 0x09) + "]+", "g");
function cleanName(name: string): string {
  return name.replace(NAME_BREAKS, " ").replace(/ {2,}/g, " ").trim();
}

function addNode(
  ctx: Ctx,
  type: string,
  name: string,
  params: Record<string, unknown> = {}
): GraphNode {
  let n = makeInstanceNode(type, { x: 0, y: 0 });
  n.data.name = cleanName(name);
  n.data.params = { ...n.data.params, ...params };
  // Param-dependent sockets (Merge's per-layer inputs, Spline Draw's image
  // aux) resolve from the params we just set.
  n = refreshNodeSockets(n);
  ctx.nodes.push(n);
  return n;
}

function out(n: GraphNode): Port {
  return { nodeId: n.id, handle: "out:primary" };
}

function wire(ctx: Ctx, from: Port, to: GraphNode, socket: string): void {
  ctx.edges.push({
    id: newEdgeId(),
    source: from.nodeId,
    sourceHandle: from.handle,
    target: to.id,
    targetHandle: `in:${socket}`,
  });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function hex2(v: number): string {
  return Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");
}

// "#rrggbb", or "#rrggbbaa" below full alpha (the color params are
// 8-digit-safe).
function hexColor(c: FigmaRGB, alpha = 1): string {
  const rgb = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return alpha >= 1 - 1e-4 ? rgb : `${rgb}${hex2(alpha)}`;
}

const BLEND_MAP: Record<string, BlendMode> = {
  PASS_THROUGH: "normal",
  NORMAL: "normal",
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "linear-burn",
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "linear-dodge",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
};

function blendOf(ctx: Ctx, figmaMode: string): BlendMode {
  const m = BLEND_MAP[figmaMode];
  if (m) return m;
  warn(ctx, `Blend mode ${figmaMode} has no toolbox equivalent — used Normal`);
  return "normal";
}

const visiblePaint = (p: FigmaPaint) => p.visible && p.opacity > 1e-4;

// A paint kind as people know it ("Video", "Image"), for notes.
function paintLabel(p: FigmaPaint): string {
  const t = p.type === "UNSUPPORTED" ? p.figmaType : p.type;
  return t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, " ");
}

// A paint Rasterize Spline can draw as ONE flat colour. Gradients fall back
// to their average stop colour until they map natively (`approx`).
function flatColorOf(p: FigmaPaint): { hex: string; approx: boolean } | null {
  if (p.type === "SOLID") return { hex: hexColor(p.color, p.opacity), approx: false };
  if (
    p.type === "GRADIENT_LINEAR" ||
    p.type === "GRADIENT_RADIAL" ||
    p.type === "GRADIENT_ANGULAR" ||
    p.type === "GRADIENT_DIAMOND"
  ) {
    const stops = p.gradientStops;
    if (stops.length === 0) return null;
    const avg = (k: "r" | "g" | "b" | "a") =>
      stops.reduce((s, st) => s + st.color[k], 0) / stops.length;
    return {
      hex: hexColor({ r: avg("r"), g: avg("g"), b: avg("b") }, avg("a") * p.opacity),
      approx: true,
    };
  }
  return null;
}

// flatColorOf at the point a paint is actually drawn — so an approximation
// is reported once per paint, not once per check.
function paintColor(ctx: Ctx, p: FigmaPaint): string | null {
  const c = flatColorOf(p);
  if (c?.approx) warn(ctx, "Gradients are imported as their average colour for now");
  return c?.hex ?? null;
}

function windingOf(paths: FigmaVectorPath[]): "nonzero" | "evenodd" {
  const rules = new Set(paths.map((p) => p.windingRule).filter((r) => r !== "NONE"));
  return rules.has("EVENODD") && !rules.has("NONZERO") ? "evenodd" : "nonzero";
}

// ---- shared building blocks -------------------------------------------------

function transparentBase(ctx: Ctx): Port {
  if (!ctx.transparent) {
    ctx.transparent = out(
      addNode(ctx, "solid-color", "Transparent", { color: "#000000", alpha: 0 })
    );
  }
  return ctx.transparent;
}

function splineNode(ctx: Ctx, name: string, subpaths: SplineSubpath[]): Port {
  return out(
    addNode(ctx, "spline-draw", name, {
      spline: { subpaths },
      // Geometry only — Rasterize Spline does the drawing.
      stroke_enabled: false,
      fill_enabled: false,
    })
  );
}

// A node's fill outline as a source: the Rectangle / Circle primitive when
// it reproduces Figma's shape exactly (editable as a rectangle, not a bag of
// anchors), otherwise Spline Draw with the baked geometry.
function outlineNode(ctx: Ctx, node: FigmaSceneNode, name: string, subs: SplineSubpath[]): Port {
  const prim = primitiveFor(ctx, node);
  if (!prim) return splineNode(ctx, name, subs);
  return out(
    addNode(ctx, prim.type, name, {
      ...prim.params,
      // Geometry only — Rasterize Spline does the drawing.
      stroke_enabled: false,
      fill_enabled: false,
    })
  );
}

const RECT_TYPES = new Set(["RECTANGLE", "FRAME", "COMPONENT", "INSTANCE"]);

function primitiveFor(
  ctx: Ctx,
  node: FigmaSceneNode
): { type: "rectangle" | "circle"; params: Record<string, unknown> } | null {
  if (node.kind !== "shape" && node.kind !== "container") return null;
  const T = node.transform;
  // A flip would reverse the outline's winding (and the Rectangle can't
  // express it) — keep the baked geometry.
  if (T[0][0] * T[1][1] - T[0][1] * T[1][0] <= 0) return null;
  const w = node.width;
  const h = node.height;
  if (w <= 0 || h <= 0) return null;
  const [fx, fy] = applyAffine(T, w / 2, h / 2);
  const [cx, cy] = applyAffine(ctx.toSpline, fx, fy);
  // Screen angle of the node's x axis — clockwise-positive, like `rotate`.
  const angle = (Math.atan2(T[1][0], T[0][0]) * 180) / Math.PI;
  const local = () => pathsToSubpaths(node.fillGeometry, IDENTITY_AFFINE);
  const localBox: Bounds = { minX: 0, minY: 0, maxX: w, maxY: h };
  // Spline space is width-relative on both axes.
  const u = (px: number) => px / ctx.W;

  if (RECT_TYPES.has(node.figmaType)) {
    let radius = 0;
    let style: "round" | "squircle" = "round";
    const hint = node.primitive;
    if (hint?.kind === "rect") {
      const [a, b, c, d] = hint.radii;
      if (!(a === b && b === c && c === d)) return null; // per-corner radii
      radius = a;
      if (radius > 0 && hint.smoothing > 1e-3) {
        // Toolbox's squircle is Figma's full smoothing; anything between
        // would only be approximated.
        if (hint.smoothing < 0.99) return null;
        style = "squircle";
      }
    } else if (!isPlainRect(local(), localBox, 1e-3)) {
      return null; // an older export with rounded corners: keep the geometry
    }
    return {
      type: "rectangle",
      params: {
        originX: cx,
        originY: cy,
        width: u(w),
        height: u(h),
        corner_radius: u(Math.min(radius, w / 2, h / 2)),
        corner_style: style,
        rotate: Math.abs(angle) < 1e-6 ? 0 : angle,
      },
    };
  }

  if (node.figmaType === "ELLIPSE") {
    const hint = node.primitive;
    const full =
      hint?.kind === "ellipse"
        ? hint.full
        : (() => {
            const s = local();
            return s.length === 1 && s[0].closed && s[0].anchors.length === 4;
          })();
    if (!full) return null;
    // Circle has no rotate: fine for a circle, or a quarter turn (swap radii).
    const quarter = Math.round(angle / 90);
    const onAxis = Math.abs(angle - quarter * 90) < 1e-6;
    if (!onAxis && Math.abs(w - h) > 1e-6) return null;
    const swap = onAxis && Math.abs(quarter) % 2 === 1;
    return {
      type: "circle",
      params: {
        centerX: cx,
        centerY: cy,
        radiusX: u((swap ? h : w) / 2),
        radiusY: u((swap ? w : h) / 2),
      },
    };
  }
  return null;
}

function buildMerge(
  ctx: Ctx,
  entries: LayerEntry[],
  base: Port | null,
  name: string
): Port {
  ctx.stats.merges++;
  const layers: MergeLayer[] = entries.map((e) => ({
    id: newLayerId(),
    mode: e.mode,
    opacity: clamp01(e.opacity),
    ...(e.name ? { name: cleanName(e.name).slice(0, 80) } : {}),
    ...(e.maskInvert ? { maskInvert: true } : {}),
  }));
  const merge = addNode(ctx, "merge", name, { layers });
  wire(ctx, base ?? transparentBase(ctx), merge, "base");
  entries.forEach((e, i) => {
    wire(ctx, e.source, merge, `layer:${layers[i].id}`);
    if (e.mask) wire(ctx, e.mask, merge, `mask:${layers[i].id}`);
  });
  return out(merge);
}

// Matte for a Merge layer from spline geometry. The spline→mask coercion
// fills even-odd, which only differs from non-zero when subpaths overlap —
// so multi-subpath non-zero shapes (and any partial alpha) go through a
// white Rasterize Spline and the image→mask coercion instead.
function maskFromSubpaths(
  ctx: Ctx,
  name: string,
  spline: Port,
  subpaths: SplineSubpath[],
  rule: "nonzero" | "evenodd",
  alpha = 1
): Port {
  if (alpha >= 1 - 1e-4 && (subpaths.length <= 1 || rule === "evenodd")) {
    return spline;
  }
  const r = addNode(ctx, "rasterize-spline", `${name} matte`, {
    ...rasterBase(rule),
    enable_fill: true,
    fill_color: hexColor({ r: 1, g: 1, b: 1 }, alpha),
    enable_stroke: false,
  });
  wire(ctx, spline, r, "path");
  return out(r);
}

// Rasterize Spline params every import starts from.
function rasterBase(rule: "nonzero" | "evenodd"): Record<string, unknown> {
  return {
    overlap: "flatten",
    fill_source: "flat",
    // One path with Figma's winding rule, not per-subpath stacking — so a
    // letter's counter or a donut's hole stays open.
    stack_subpaths: false,
    fill_rule: rule,
    stroke_source: "flat",
    units: "%",
    close_open_paths: false,
  };
}

const CAP_MAP: Record<string, string> = {
  NONE: "butt",
  ROUND: "round",
  SQUARE: "square",
};

const JOIN_MAP: Record<string, string> = {
  MITER: "miter",
  BEVEL: "bevel",
  ROUND: "round",
};

// Stroke params (Rasterize Spline), metrics as % of canvas width so the
// look holds at any comp resolution with the frame's aspect.
function strokeParams(
  ctx: Ctx,
  stroke: FigmaStroke,
  color: string,
  weightScale: number
): Record<string, unknown> {
  const pct = (px: number) => (px / ctx.W) * 100;
  let weight = stroke.weight;
  if (stroke.sideWeights) {
    const [t, r, b, l] = stroke.sideWeights;
    if (!(t === r && r === b && b === l)) {
      warn(ctx, "Per-side stroke weights — used the thickest side");
    }
    weight = Math.max(t, r, b, l, weight);
  }
  const cap = CAP_MAP[stroke.cap];
  if (!cap) warn(ctx, `Stroke cap ${stroke.cap} — used a flat (butt) cap`);
  const join = JOIN_MAP[stroke.join] ?? "miter";
  if (!JOIN_MAP[stroke.join]) warn(ctx, `Stroke join ${stroke.join} — used miter`);
  const p: Record<string, unknown> = {
    enable_stroke: true,
    stroke_color: color,
    thickness: pct(weight * weightScale),
    cap: cap ?? "butt",
    join,
    miter_limit: Math.min(20, Math.max(1, stroke.miterLimit || 4)),
    style: "solid",
  };
  const dash = stroke.dashPattern.filter((d) => d >= 0);
  if (dash.length > 0 && dash.some((d) => d > 0)) {
    // SVG semantics: an odd-length list repeats to even length.
    const pair = dash.length === 1 ? [dash[0], dash[0]] : [dash[0], dash[1]];
    if (dash.length > 2) warn(ctx, "Dash patterns with more than one dash/gap pair — used the first pair");
    p.style = "dashed";
    p.dash_length = pct(Math.max(0.01, pair[0]));
    p.dash_gap = pct(Math.max(0.01, pair[1]));
  }
  return p;
}

// ---- image placement --------------------------------------------------------

// Where an image paint's pixels land, as the image's unit square mapped into
// node-local px (a parallelogram: origin + two edge vectors).
function imageQuadLocal(
  paint: FigmaImagePaint,
  w: number,
  h: number,
  iw: number,
  ih: number
): { o: [number, number]; u: [number, number]; v: [number, number] } | null {
  if (paint.scaleMode === "CROP" && paint.imageTransform) {
    // imageTransform maps node-normalized space into image-normalized space;
    // its inverse carries the image's unit square back onto the node.
    const inv = invertAffine(paint.imageTransform);
    if (!inv) return null;
    const p = (x: number, y: number): [number, number] => {
      const [nx, ny] = applyAffine(inv, x, y);
      return [nx * w, ny * h];
    };
    const o = p(0, 0);
    const pu = p(1, 0);
    const pv = p(0, 1);
    return { o, u: [pu[0] - o[0], pu[1] - o[1]], v: [pv[0] - o[0], pv[1] - o[1]] };
  }
  if (iw <= 0 || ih <= 0) return null;
  const s =
    paint.scaleMode === "FIT" ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  return { o: [(w - dw) / 2, (h - dh) / 2], u: [dw, 0], v: [0, dh] };
}

function imageSourceFor(
  ctx: Ctx,
  node: FigmaSceneNode,
  paint: FigmaImagePaint,
  name: string
): Port | null {
  const key = paint.imageHash;
  const info = key ? ctx.scene.images[key] : undefined;
  const bitmap = key ? ctx.opts.images?.get(key) : undefined;
  if (!info || !bitmap) {
    warn(ctx, "An image fill had no image data — skipped");
    return null;
  }
  if (paint.scaleMode === "TILE") warn(ctx, "Tiled image fills are placed once (no tiling yet)");
  if (paint.rotation && Math.abs(paint.rotation % 360) > 1e-3) {
    warn(ctx, "Image fills rotated inside their frame (the fill's own rotation) are placed unrotated for now");
  }
  if (paint.filters && Object.values(paint.filters).some((v) => Math.abs(v) > 1e-3)) {
    warn(ctx, "Image adjustments (exposure, contrast, …) aren't imported yet");
  }
  const quad = imageQuadLocal(paint, node.width, node.height, info.width, info.height);
  if (!quad) {
    warn(ctx, "An image fill couldn't be placed — skipped");
    return null;
  }
  // Into root-frame px. The linear part carries the edge vectors; the
  // translation only moves the origin.
  const T = node.transform;
  const lin = (x: number, y: number): [number, number] => [
    T[0][0] * x + T[0][1] * y,
    T[1][0] * x + T[1][1] * y,
  ];
  const o = applyAffine(T, quad.o[0], quad.o[1]);
  const u = lin(quad.u[0], quad.u[1]);
  const v = lin(quad.v[0], quad.v[1]);
  ctx.stats.images++;
  // Axis-aligned and unflipped: the bitmap goes on as-is.
  const eps = 1e-6 * Math.max(1, Math.hypot(u[0], u[1]), Math.hypot(v[0], v[1]));
  if (Math.abs(u[1]) <= eps && Math.abs(v[0]) <= eps && u[0] > 0 && v[1] > 0) {
    return out(placeImage(ctx, name, bitmap, { x: o[0], y: o[1], w: u[0], h: v[1] }));
  }
  // Rotated / flipped / sheared: place the quad's bounding box and have the
  // caller bake the bitmap through the affine into it (FigmaBitmapOp).
  const xs = [o[0], o[0] + u[0], o[0] + u[0] + v[0], o[0] + v[0]];
  const ys = [o[1], o[1] + u[1], o[1] + u[1] + v[1], o[1] + v[1]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const bw = Math.max(1e-6, Math.max(...xs) - minX);
  const bh = Math.max(1e-6, Math.max(...ys) - minY);
  // Keep the source's detail: as many output px per frame px as the image
  // has px per frame px, within sane bounds.
  const density = Math.min(
    4,
    Math.max(0.25, Math.sqrt((info.width * info.height) / Math.max(1, Math.hypot(...u) * Math.hypot(...v))))
  );
  const width = Math.max(1, Math.min(4096, Math.round(bw * density)));
  const height = Math.max(1, Math.min(4096, Math.round(bh * density)));
  const kx = width / bw;
  const ky = height / bh;
  const src = placeImage(ctx, name, bitmap, { x: minX, y: minY, w: bw, h: bh });
  ctx.bitmapOps.push({
    nodeId: src.id,
    imageKey: key!,
    width,
    height,
    matrix: [kx * u[0], ky * u[1], kx * v[0], ky * v[1], kx * (o[0] - minX), ky * (o[1] - minY)],
  });
  return out(src);
}

// An Image Source whose bitmap fills the axis-aligned rect `r` (root-frame
// px): stretch maps the bitmap onto the canvas's unit square, the TRS
// shrinks and moves that square onto the rect.
function placeImage(
  ctx: Ctx,
  name: string,
  bitmap: unknown,
  r: { x: number; y: number; w: number; h: number }
): GraphNode {
  return addNode(ctx, "image-source", name, {
    file: bitmap,
    fit: "stretch",
    translateX: (r.x + r.w / 2) / ctx.W - 0.5,
    translateY: (r.y + r.h / 2) / ctx.H - 0.5,
    scaleX: r.w / ctx.W,
    scaleY: r.h / ctx.H,
    rotate: 0,
    pivotX: 0.5,
    pivotY: 0.5,
  });
}

// ---- shapes -----------------------------------------------------------------

interface ShapeGeometry {
  fills: FigmaPaint[];
  fillGeometry: FigmaVectorPath[];
  stroke?: FigmaStroke;
  strokePaths?: FigmaVectorPath[];
}

// The paint layers of one node (fills bottom → top, then strokes), before
// the node's own opacity / blend are applied.
function paintEntries(
  ctx: Ctx,
  node: FigmaSceneNode,
  g: ShapeGeometry,
  name: string,
  which: "all" | "fills" | "strokes" = "all"
): LayerEntry[] {
  const m = mulAffine(ctx.toSpline, node.transform);
  const fills = which === "strokes" ? [] : g.fills.filter(visiblePaint);
  const strokePaints =
    which === "fills" || !g.stroke || g.stroke.weight <= 0
      ? []
      : g.stroke.paints.filter(visiblePaint);
  if (fills.length === 0 && strokePaints.length === 0) return [];

  const rule = windingOf(g.fillGeometry);
  const fillSubs = pathsToSubpaths(g.fillGeometry, m);
  let fillSpline: Port | null = null;
  const fillSplinePort = () =>
    (fillSpline ??= fillSubs.length ? outlineNode(ctx, node, name, fillSubs) : null);

  // Open paths (lines, open vectors) stroke their own centerline; closed
  // shapes — closed vectors included — stroke the fill outline, which keeps
  // inside / outside alignment meaningful.
  const centerline = g.strokePaths?.length ? pathsToSubpaths(g.strokePaths, m) : null;
  const openSubs = centerline && centerline.some((s) => !s.closed) ? centerline : null;
  let strokeSpline: Port | null = null;
  const strokeSplinePort = () =>
    (strokeSpline ??= openSubs
      ? openSubs.length
        ? splineNode(ctx, `${name} path`, openSubs)
        : null
      : fillSplinePort());
  const align = openSubs ? "CENTER" : g.stroke?.align ?? "CENTER";

  const entries: LayerEntry[] = [];
  const paintMode = (p: FigmaPaint) => blendOf(ctx, p.blendMode || "NORMAL");

  // Common case — ≤1 flat fill + ≤1 centred flat stroke on the same outline:
  // one Rasterize Spline draws both (fill under stroke, like Figma).
  const simpleFill = fills.length === 0 || (fills.length === 1 && flatColorOf(fills[0]) !== null);
  const simpleStroke =
    strokePaints.length === 0 ||
    (strokePaints.length === 1 && align === "CENTER" && flatColorOf(strokePaints[0]) !== null);
  const sameOutline = !openSubs || fills.length === 0;
  const onePaintMode =
    fills.length === 0 ||
    strokePaints.length === 0 ||
    (fills[0].blendMode || "NORMAL") === (strokePaints[0].blendMode || "NORMAL");
  if (simpleFill && simpleStroke && sameOutline && onePaintMode) {
    const path = fills.length ? fillSplinePort() : strokeSplinePort();
    if (!path) return [];
    const params: Record<string, unknown> = {
      ...rasterBase(rule),
      enable_fill: fills.length > 0,
      enable_stroke: false,
    };
    if (fills.length) params.fill_color = paintColor(ctx, fills[0]);
    if (strokePaints.length) {
      Object.assign(params, strokeParams(ctx, g.stroke!, paintColor(ctx, strokePaints[0])!, 1));
    }
    const label =
      fills.length && strokePaints.length ? `${name} fill + stroke` : fills.length ? `${name} fill` : `${name} stroke`;
    const r = addNode(ctx, "rasterize-spline", label, params);
    wire(ctx, path, r, "path");
    const lead = fills[0] ?? strokePaints[0];
    return [{ source: out(r), name, mode: paintMode(lead), opacity: 1 }];
  }

  // General case — one Rasterize per paint. Each paint is vetted BEFORE
  // its outline is minted, so an unsupported paint leaves no stray Spline
  // Draw behind.
  for (const p of fills) {
    if (p.type === "IMAGE") {
      if (fillSubs.length === 0) break;
      const img = imageSourceFor(ctx, node, p, `${name} image`);
      if (!img) continue;
      const path = fillSplinePort()!;
      const r = addNode(ctx, "rasterize-spline", `${name} image`, {
        ...rasterBase(rule),
        enable_fill: true,
        image_fill: true,
        fill_fit: "window",
        enable_stroke: false,
      });
      wire(ctx, path, r, "path");
      wire(ctx, img, r, "fill");
      entries.push({ source: out(r), name, mode: paintMode(p), opacity: p.opacity });
      continue;
    }
    const color = paintColor(ctx, p);
    if (!color) {
      warn(ctx, `${paintLabel(p)} fills aren't supported — skipped`);
      continue;
    }
    const path = fillSplinePort();
    if (!path) break;
    const r = addNode(ctx, "rasterize-spline", `${name} fill`, {
      ...rasterBase(rule),
      enable_fill: true,
      fill_color: color,
      enable_stroke: false,
    });
    wire(ctx, path, r, "path");
    entries.push({ source: out(r), name, mode: paintMode(p), opacity: 1 });
  }

  for (const p of strokePaints) {
    const color = paintColor(ctx, p);
    if (!color) {
      warn(ctx, `${paintLabel(p)} strokes aren't supported — skipped`);
      continue;
    }
    const path = strokeSplinePort();
    if (!path) break;
    const inside = align === "INSIDE";
    const outside = align === "OUTSIDE";
    const r = addNode(ctx, "rasterize-spline", `${name} stroke`, {
      ...rasterBase(rule),
      enable_fill: false,
      ...strokeParams(ctx, g.stroke!, color, inside || outside ? 2 : 1),
    });
    wire(ctx, path, r, "path");
    const entry: LayerEntry = { source: out(r), name: `${name} stroke`, mode: paintMode(p), opacity: 1 };
    if (inside || outside) {
      const outline = fillSplinePort();
      if (outline) {
        entry.mask = maskFromSubpaths(ctx, name, outline, fillSubs, rule);
        if (outside) entry.maskInvert = true;
      }
    }
    entries.push(entry);
  }
  return entries;
}

// Apply a node's own opacity + blend to its paint layers. One layer takes
// them directly; several overlap, so opacity / blend must apply to their
// composite — isolate them in a Merge.
function finishNode(
  ctx: Ctx,
  node: FigmaSceneNode,
  entries: LayerEntry[],
  name: string
): LayerEntry[] {
  if (entries.length === 0) return [];
  const mode = blendOf(ctx, node.blendMode);
  if (node.effects.some((e) => e.visible)) {
    warn(ctx, "Effects (shadows, blurs) aren't imported yet");
  }
  if (entries.length === 1) {
    const e = entries[0];
    return [
      {
        ...e,
        name,
        mode: mode !== "normal" ? mode : e.mode,
        opacity: e.opacity * node.opacity,
      },
    ];
  }
  if (node.opacity >= 1 - 1e-4 && mode === "normal") return entries;
  return [
    {
      source: buildMerge(ctx, entries, null, name),
      name,
      mode,
      opacity: node.opacity,
    },
  ];
}

// ---- nodes ------------------------------------------------------------------

function rasterEntries(ctx: Ctx, node: FigmaRasterNode): LayerEntry[] {
  const bitmap = ctx.opts.images?.get(node.imageRef);
  if (!bitmap) {
    warn(ctx, "A pre-rendered layer had no image data — skipped");
    return [];
  }
  const b = node.bounds;
  if (b.width <= 0 || b.height <= 0) return [];
  warn(ctx, `Imported as a flat image: ${node.reason || "an unsupported layer type"}`);
  ctx.stats.images++;
  const src = placeImage(ctx, node.name, bitmap, { x: b.x, y: b.y, w: b.width, h: b.height });
  return [
    {
      source: out(src),
      name: node.name,
      mode: blendOf(ctx, node.blendMode),
      // Figma's export already carries the layer's opacity.
      opacity: 1,
    },
  ];
}

// ---- text ---------------------------------------------------------------------

// Where the alphabetic baseline sits below the em-box centre, as a fraction
// of the font size, when no browser can measure it (Inter's normalized
// typo metrics give ≈ 0.30).
const FALLBACK_BASELINE_BELOW_MIDDLE = 0.3;

function textEntries(ctx: Ctx, node: FigmaTextNode): LayerEntry[] {
  ctx.stats.texts++;
  const T = node.transform;
  // Figma transforms carry no scale (it lives in width / height and font
  // size), so "upright" is just no rotation and no flip.
  const upright = Math.abs(T[0][1]) < 1e-6 && Math.abs(T[1][0]) < 1e-6 && T[0][0] > 0 && T[1][1] > 0;
  if (!upright) {
    // The Text node rotates in per-axis uv (it skews on a non-square comp).
    return textOutlines(ctx, node, "Rotated or flipped text is imported as vector outlines for now");
  }
  const runs = parseFigmaTextSvg(node.text.svg);
  const pieces = runs ? buildTextPieces(node, runs) : [];
  if (pieces.length === 0) {
    return textOutlines(ctx, node, "Text without Figma's layout data is imported as vector outlines");
  }
  const entries = pieces.flatMap((p) => textPieceEntries(ctx, node, p));
  return finishNode(ctx, node, entries, node.name);
}

// The exact look as a filled shape — the fallback when live text can't be
// placed faithfully.
function textOutlines(ctx: Ctx, node: FigmaTextNode, why: string): LayerEntry[] {
  if (node.fillGeometry.length === 0) {
    warn(ctx, node.text.hasMissingFont ? "Text with a font missing in Figma — skipped" : "Text without glyph outlines — skipped");
    return [];
  }
  warn(ctx, why);
  // Mixed per-run colours live on the segments; outlines take the longest run's.
  let fills = node.fills;
  if (fills.length === 0 && node.text.segments.length) {
    const longest = [...node.text.segments].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    fills = longest.fills;
    if (node.text.segments.length > 1) warn(ctx, "Multi-colour text imported as outlines takes one colour");
  }
  return finishNode(ctx, node, paintEntries(ctx, node, { ...node, fills }, node.name), node.name);
}

const JOIN_TEXT: Record<string, string> = { MITER: "miter", BEVEL: "bevel", ROUND: "round" };

function textPieceEntries(ctx: Ctx, node: FigmaTextNode, piece: TextPiece): LayerEntry[] {
  const seg = piece.segment;
  const fill = [...seg.fills].reverse().find(visiblePaint); // top-most
  if (!fill) return [];
  const size = seg.fontSize;
  const family = seg.fontFamily || "Inter";
  const weight = seg.fontWeight;
  const italic = seg.italic;
  noteFont(ctx, family, weight, italic);

  const lsPx =
    seg.letterSpacing.unit === "PERCENT" ? (seg.letterSpacing.value / 100) * size : seg.letterSpacing.value;
  const lh = seg.lineHeight;
  const lineHeightPx =
    lh.unit === "PIXELS" ? lh.value : lh.unit === "PERCENT" ? (lh.value / 100) * size : 1.2 * size;
  // Multi-line pieces use Figma's measured step; a single line's step only
  // sizes the box, since the placement below solves for it either way.
  const step = piece.step ?? (lineHeightPx > 0 ? lineHeightPx : 1.2 * size);
  const delta = ctx.opts.text
    ? ctx.opts.text.baselineBelowMiddle({ family, weight, italic, size })
    : FALLBACK_BASELINE_BELOW_MIDDLE * size;

  // The Text node lays line i out centred on boxTop + step·(i + ½) with
  // textBaseline "middle" — the baseline lands `delta` below that. Solve
  // boxTop so line 0's baseline is exactly Figma's.
  const T = node.transform;
  const firstBaseline = T[1][2] + piece.firstBaseline;
  const boxH = piece.lines.length * step;
  const boxTop = firstBaseline - step / 2 - delta;
  // Canvas letter-spacing also follows a line's LAST glyph; Figma drops that
  // trailing space, so centred / right-aligned lines shift by it.
  const anchor = T[0][2] + piece.anchorX;
  const boxW = piece.boxWidth;
  const centerX =
    piece.align === "left"
      ? anchor + boxW / 2
      : piece.align === "center"
        ? anchor + lsPx / 2
        : anchor - boxW / 2 + lsPx;

  let color = "#ffffff";
  if (fill.type === "SOLID") color = hexColor(fill.color, fill.opacity);
  else if (fill.type === "IMAGE") warn(ctx, "Image-filled text is imported in white for now");
  else color = paintColor(ctx, fill) ?? "#ffffff";
  if (seg.textDecoration !== "NONE") warn(ctx, "Underline / strikethrough isn't available on the Text node — dropped");
  if (node.text.alignHorizontal === "JUSTIFIED") warn(ctx, "Justified text is imported left-aligned");
  if (seg.textCase.startsWith("SMALL_CAPS")) warn(ctx, "Small caps are imported as typed");
  if (piece.unmatched) warn(ctx, "Some text runs couldn't be matched to their style — used the closest");

  const pct = (px: number) => (px / ctx.W) * 100;
  const params: Record<string, unknown> = {
    text: piece.lines.join("\n"),
    font_family: family,
    font_size: pct(size),
    units: "%",
    font_weight: weight,
    italic,
    color,
    fillMode: "solid",
    alignment: piece.align,
    vAlign: "top",
    textCase: piece.textCase,
    leading: step / size,
    letter_spacing: pct(lsPx),
    // Figma's real line breaks are in the text already.
    wrap: false,
    boxWidth: boxW / ctx.W,
    boxHeight: boxH / ctx.H,
    translateX: centerX / ctx.W - 0.5,
    translateY: (boxTop + boxH / 2) / ctx.H - 0.5,
    scaleX: 1,
    scaleY: 1,
    rotate: 0,
    pivotX: 0.5,
    pivotY: 0.5,
  };
  const st = node.stroke;
  const strokePaint = st && st.weight > 0 ? [...st.paints].reverse().find(visiblePaint) : undefined;
  if (st && strokePaint) {
    const strokeColor = paintColor(ctx, strokePaint);
    if (strokeColor) {
      // The Text node strokes UNDER the fill, so only the outer half shows:
      // twice the weight reads as Figma's outside stroke.
      warn(ctx, "Text strokes are drawn outside the glyphs");
      Object.assign(params, {
        strokeEnabled: true,
        strokeWidth: pct(st.weight * (st.align === "INSIDE" ? 1 : 2)),
        strokeColor,
        strokeJoin: JOIN_TEXT[st.join] ?? "round",
      });
    }
  }
  const t = addNode(ctx, "text", piece.label, params);
  return [{ source: out(t), name: piece.label, mode: blendOf(ctx, fill.blendMode || "NORMAL"), opacity: 1 }];
}

function noteFont(ctx: Ctx, family: string, weight: number, italic: boolean): void {
  const check = ctx.opts.text?.fontAvailable;
  const key = `${family}|${weight}|${italic}`;
  if (!check || ctx.fontsChecked.has(key)) return;
  ctx.fontsChecked.add(key);
  if (!check(family, weight, italic)) {
    warn(ctx, `Font “${family}” isn't available to toolbox — its text shows in a fallback font until it's installed`);
  }
}

function subtreeHasBlend(n: FigmaSceneNode): boolean {
  if (n.kind !== "container") {
    const paintBlend = (ps: FigmaPaint[]) =>
      ps.some((p) => p.visible && (p.blendMode || "NORMAL") !== "NORMAL");
    return (
      (n.blendMode !== "NORMAL" && n.blendMode !== "PASS_THROUGH") ||
      ("fills" in n && paintBlend(n.fills))
    );
  }
  return n.children.some(
    (c) =>
      (c.kind === "container" && c.blendMode !== "PASS_THROUGH" && c.blendMode !== "NORMAL") ||
      subtreeHasBlend(c)
  );
}

// Does clipping this frame cut anything? Conservative: a non-rectangular or
// rotated frame always clips; otherwise a child clips when its rendered
// bounds (or, without them, its transformed box) leave the frame's box.
function clipCutsSomething(ctx: Ctx, c: FigmaContainerNode): boolean {
  if (c.children.length === 0) return false;
  const T = c.transform;
  const axisAligned = Math.abs(T[0][1]) < 1e-9 && Math.abs(T[1][0]) < 1e-9;
  if (!axisAligned) return true;
  const frameBox = boxBounds(T, c.width, c.height);
  // The frame's own outline in root-frame px: rounded corners clip.
  const subs = pathsToSubpaths(c.fillGeometry, T);
  if (subs.length > 0) {
    const hb = hullBounds(subs);
    if (hb && !isPlainRect(subs, hb, 1e-3)) return true;
  }
  const exceeds = (n: FigmaSceneNode): boolean => {
    const b: Bounds = n.renderBounds
      ? {
          minX: n.renderBounds.x,
          minY: n.renderBounds.y,
          maxX: n.renderBounds.x + n.renderBounds.width,
          maxY: n.renderBounds.y + n.renderBounds.height,
        }
      : boxBounds(n.transform, n.width, n.height);
    if (!boundsInside(b, frameBox, 0.5)) return true;
    return n.kind === "container" && !n.clipsContent && n.children.some(exceeds);
  };
  return c.children.some(exceeds);
}

// Spline geometry of any node, for masks: shapes / text use their fill
// outline; a container uses the union of its descendants'.
function maskGeometry(ctx: Ctx, n: FigmaSceneNode): { subs: SplineSubpath[]; paths: FigmaVectorPath[] } {
  const m = mulAffine(ctx.toSpline, n.transform);
  if (n.kind === "shape" || n.kind === "text") {
    const paths = n.fillGeometry.length ? n.fillGeometry : n.kind === "shape" ? n.strokePaths ?? [] : [];
    return { subs: pathsToSubpaths(paths, m), paths };
  }
  if (n.kind === "container") {
    const subs: SplineSubpath[] = [];
    const paths: FigmaVectorPath[] = [];
    if (n.fillGeometry.length) {
      subs.push(...pathsToSubpaths(n.fillGeometry, m));
      paths.push(...n.fillGeometry);
    }
    for (const c of n.children) {
      const g = maskGeometry(ctx, c);
      subs.push(...g.subs);
      paths.push(...g.paths);
    }
    return { subs, paths };
  }
  return { subs: [], paths: [] };
}

function maskFromNode(ctx: Ctx, maskNode: FigmaSceneNode): Port | null {
  const g = maskGeometry(ctx, maskNode);
  if (g.subs.length === 0) return null;
  if (maskNode.maskType === "LUMINANCE") {
    warn(ctx, "Luminance masks are imported as shape (alpha) masks");
  }
  // ALPHA masks honour the mask's fill opacity; VECTOR masks are the bare
  // outline at full strength.
  let alpha = 1;
  if (maskNode.maskType !== "VECTOR" && (maskNode.kind === "shape" || maskNode.kind === "text")) {
    const fill = maskNode.fills.find(visiblePaint);
    alpha = (fill ? fill.opacity : 1) * maskNode.opacity;
  }
  const rule = windingOf(g.paths);
  const spline = splineNode(ctx, `${maskNode.name} (mask)`, g.subs);
  return maskFromSubpaths(ctx, maskNode.name, spline, g.subs, rule, alpha);
}

// A container's children → layer entries, honouring isMask groups: a mask
// layer is not drawn; it mattes the siblings above it up to the next mask.
function childEntries(ctx: Ctx, children: FigmaSceneNode[]): LayerEntry[] {
  const entries: LayerEntry[] = [];
  let i = 0;
  while (i < children.length) {
    const ch = children[i];
    if (!ch.isMask) {
      entries.push(...nodeEntries(ctx, ch));
      i++;
      continue;
    }
    let j = i + 1;
    while (j < children.length && !children[j].isMask) j++;
    const members = children.slice(i + 1, j).flatMap((c) => nodeEntries(ctx, c));
    if (members.length) {
      const mask = maskFromNode(ctx, ch);
      if (!mask) {
        warn(ctx, "A mask layer had no shape — its layers are imported unmasked");
        entries.push(...members);
      } else {
        entries.push({
          source: buildMerge(ctx, members, null, `${ch.name} (masked)`),
          name: ch.name,
          mode: "normal",
          opacity: 1,
          mask,
        });
      }
    }
    i = j;
  }
  return entries;
}

function containerEntries(ctx: Ctx, c: FigmaContainerNode): LayerEntry[] {
  ctx.stats.containers++;
  const geo = { fills: c.fills, fillGeometry: c.fillGeometry, stroke: c.stroke };
  // Frame background under the children, frame border over them.
  const background = paintEntries(ctx, c, geo, c.name, "fills");
  const kids = childEntries(ctx, c.children);
  const border = paintEntries(ctx, c, geo, c.name, "strokes");

  let content = [...background, ...kids];
  if (c.clipsContent && kids.length > 0 && clipCutsSomething(ctx, c)) {
    const subs = pathsToSubpaths(c.fillGeometry, mulAffine(ctx.toSpline, c.transform));
    const frameSubs = subs.length
      ? subs
      : pathsToSubpaths(
          [{ windingRule: "NONZERO", data: `M 0 0 L ${c.width} 0 L ${c.width} ${c.height} L 0 ${c.height} Z` }],
          mulAffine(ctx.toSpline, c.transform)
        );
    const spline = splineNode(ctx, `${c.name} (clip)`, frameSubs);
    content = [
      {
        source: buildMerge(ctx, content, null, `${c.name} (clipped)`),
        name: c.name,
        mode: "normal",
        opacity: 1,
        mask: maskFromSubpaths(ctx, c.name, spline, frameSubs, windingOf(c.fillGeometry)),
      },
    ];
  }

  const all = [...content, ...border];
  if (all.length === 0) return [];
  if (c.effects.some((e) => e.visible)) warn(ctx, "Effects (shadows, blurs) aren't imported yet");
  // PASS_THROUGH lets children blend with what's below; any other mode
  // (NORMAL included) isolates them — which only shows when something
  // inside blends.
  const mode = blendOf(ctx, c.blendMode);
  const isolate =
    mode !== "normal" ||
    (c.blendMode === "NORMAL" && subtreeHasBlend(c)) ||
    (c.opacity < 1 - 1e-4 && all.length > 1);
  if (!isolate) {
    return all.map((e) => ({ ...e, opacity: e.opacity * c.opacity }));
  }
  return [
    {
      source: buildMerge(ctx, all, null, c.name),
      name: c.name,
      mode,
      opacity: c.opacity,
    },
  ];
}

function nodeEntries(ctx: Ctx, n: FigmaSceneNode): LayerEntry[] {
  try {
    switch (n.kind) {
      case "container":
        return containerEntries(ctx, n);
      case "shape":
        ctx.stats.shapes++;
        return finishNode(ctx, n, paintEntries(ctx, n, n, n.name), n.name);
      case "text":
        return textEntries(ctx, n);
      case "raster":
        return rasterEntries(ctx, n);
    }
  } catch (err) {
    warn(ctx, `A layer failed to import and was skipped (${err instanceof Error ? err.message : "error"})`);
  }
  return [];
}

// ---- entry point ------------------------------------------------------------

export function convertFigmaScene(
  scene: FigmaScene,
  opts: FigmaImportOptions = {}
): FigmaImportResult {
  const frame = scene.frame;
  const W = frame.width;
  const H = frame.height;
  const ctx: Ctx = {
    scene,
    W,
    H,
    toSpline: frameToSpline(W, H),
    opts,
    nodes: [],
    edges: [],
    warnings: new Map(),
    stats: { shapes: 0, texts: 0, images: 0, containers: 0, merges: 0 },
    transparent: null,
    bitmapOps: [],
    fontsChecked: new Set(),
  };
  if (scene.colorProfile === "DISPLAY_P3") {
    warn(ctx, "The Figma file is in Display P3 — colours were imported as sRGB values");
  }

  const frameName = scene.source.nodeName || frame.name || "Figma frame";
  const geo = { fills: frame.fills, fillGeometry: frame.fillGeometry, stroke: frame.stroke };

  // Background: one flat colour on a plain rectangle becomes the Merge base
  // (a Solid Color); anything richer is drawn as the bottom layer(s).
  const bg = frame.fills.filter(visiblePaint);
  const frameSubs = pathsToSubpaths(frame.fillGeometry, ctx.toSpline);
  const canvasBounds: Bounds = { minX: 0, minY: 0.5 - H / (2 * W), maxX: 1, maxY: 0.5 + H / (2 * W) };
  const plain = frameSubs.length === 0 || isPlainRect(frameSubs, canvasBounds, 1e-5);
  let base: Port | null = null;
  let bottom: LayerEntry[] = [];
  if (bg.length === 1 && bg[0].type === "SOLID" && plain) {
    const p = bg[0];
    base = out(
      addNode(ctx, "solid-color", "Background", {
        color: hexColor(p.color),
        alpha: p.opacity,
      })
    );
  } else if (bg.length > 0) {
    bottom = paintEntries(ctx, frame, geo, `${frameName} background`, "fills");
  }
  const kids = childEntries(ctx, frame.children);
  const border = paintEntries(ctx, frame, geo, `${frameName} border`, "strokes");
  const output = buildMerge(ctx, [...bottom, ...kids, ...border], base, frameName);

  // Tidy along the wires (spec 090626_tidy-layout.md) — boxes are estimates
  // here; the editor's Tidy refines with measured sizes.
  const lg = toLayoutGraph(ctx.nodes, ctx.edges);
  const moves = tidyLayout(lg.nodes, lg.edges, ctx.nodes.map((n) => n.id), { anchor: "origin" });
  let nodes = applyPositions(ctx.nodes, moves);

  let referenceNodeId: string | null = null;
  if (opts.reference) {
    // Detached, beside the output — select it (or compare_renders it
    // against the root Merge) to A/B the import against Figma's own render.
    const outNode = nodes.find((n) => n.id === output.nodeId);
    const ref = makeInstanceNode("image-source", {
      x: (outNode?.position.x ?? 0),
      y: (outNode?.position.y ?? 0) + 220,
    });
    ref.data.name = "Figma reference";
    ref.data.params = { ...ref.data.params, file: opts.reference, fit: "stretch" };
    nodes = [...nodes, ref];
    referenceNodeId = ref.id;
  }

  const warnings = [
    ...scene.warnings,
    ...[...ctx.warnings].map(([msg, n]) => (n > 1 ? `${msg} (×${n})` : msg)),
  ];
  return {
    nodes,
    edges: ctx.edges,
    output,
    referenceNodeId,
    frame: { name: frameName, width: W, height: H },
    warnings,
    stats: ctx.stats,
    bitmapOps: ctx.bitmapOps,
  };
}
