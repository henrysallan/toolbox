// Figma import (specdocs/092326_figma-import.md), the pure half: the scene
// contract's trust boundary (parseFigmaScene) and the scene → graph mapping
// (convertFigmaScene) on a hand-built scene that exercises every path —
// then a smoke pass over every real plugin export in
// scripts/fixtures/figma-import/ (drop a "Download JSON" file there and it
// becomes a regression test). Rendering is a live-app question: paste into
// the editor and compare_renders the "Figma reference" node against the
// root Merge.
//
//   npx tsx scripts/check-figma-import.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { parseFigmaScene, looksLikeFigmaSceneText, FigmaSceneError, FIGMA_SCENE_MARKER } =
  await import("@/lib/figma-import/scene");
const { convertFigmaScene } = await import("@/lib/figma-import/convert");
const { validateGraph } = await import("@/engine/graph-validation");

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- fixture ----------------------------------------------------------------

const I = [[1, 0, 0], [0, 1, 0]];
const at = (x: number, y: number) => [[1, 0, x], [0, 1, y]];
const solid = (r: number, g2: number, b: number, opacity = 1) => ({
  type: "SOLID", visible: true, opacity, blendMode: "NORMAL", color: { r, g: g2, b },
});
const rectPath = (w: number, h: number) => `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} L 0 0 Z`;
const stroke = (weight: number, align = "CENTER", extra: Record<string, unknown> = {}) => ({
  paints: [solid(0, 0, 0)], weight, align, cap: "NONE", join: "MITER", miterLimit: 4, dashPattern: [], ...extra,
});
const base = (id: string, name: string, figmaType: string, transform: unknown, w: number, h: number) => ({
  id, name, figmaType, opacity: 1, blendMode: "PASS_THROUGH", transform, width: w, height: h,
  isMask: false, maskType: "ALPHA", effects: [],
});
const shape = (id: string, name: string, transform: unknown, w: number, h: number, extra: Record<string, unknown>) => ({
  ...base(id, name, "RECTANGLE", transform, w, h), kind: "shape",
  fills: [solid(0.2, 0.4, 1)], fillGeometry: [{ windingRule: "NONZERO", data: rectPath(w, h) }], ...extra,
});
const ROUNDED =
  "M 12 0 L 188 0 C 194.627 0 200 5.373 200 12 L 200 88 C 200 94.627 194.627 100 188 100 " +
  "L 12 100 C 5.373 100 0 94.627 0 88 L 0 12 C 0 5.373 5.373 0 12 0 Z";
const CIRCLE =
  "M 60 30 C 60 46.5685 46.5685 60 30 60 C 13.4315 60 0 46.5685 0 30 C 0 13.4315 13.4315 0 30 0 " +
  "C 46.5685 0 60 13.4315 60 30 Z";
const c30 = Math.cos(Math.PI / 6);
const s30 = Math.sin(Math.PI / 6);
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const scene = {
  [FIGMA_SCENE_MARKER]: 1,
  generator: { name: "check-figma-import", version: "0" },
  source: { fileName: "Fixtures", pageName: "Page 1", nodeId: "1:1", nodeName: "Card" },
  colorProfile: "SRGB",
  frame: {
    ...base("1:1", "Card", "FRAME", I, 400, 300), kind: "container", clipsContent: true,
    fills: [solid(1, 1, 1)], fillGeometry: [{ windingRule: "NONZERO", data: rectPath(400, 300) }],
    children: [
      // 0: rounded rect, flat fill + centred stroke → ONE Rasterize.
      shape("2:1", "Rounded", at(20, 20), 200, 100, {
        fillGeometry: [{ windingRule: "NONZERO", data: ROUNDED }], stroke: stroke(2),
      }),
      // 1: circle with an INSIDE stroke → fill layer + masked 2× stroke layer.
      { ...shape("2:2", "Dot", at(300, 40), 60, 60, {
        fills: [solid(1, 0, 0)], fillGeometry: [{ windingRule: "NONZERO", data: CIRCLE }], stroke: stroke(4, "INSIDE"),
      }), figmaType: "ELLIPSE" },
      // 2: open dashed line (centerline stroke, no fill geometry).
      { ...shape("2:3", "Line", at(40, 200), 100, 50, {
        fills: [], fillGeometry: [], strokePaths: [{ windingRule: "NONE", data: "M 0 0 L 100 50" }],
        stroke: stroke(3, "INSIDE", { cap: "ROUND", join: "ROUND", dashPattern: [6, 4] }),
      }), figmaType: "VECTOR" },
      // 3: half-opacity group of two overlapping rects → isolated Merge.
      { ...base("2:4", "Pair", "GROUP", I, 400, 300), kind: "container", clipsContent: false, opacity: 0.5,
        fills: [], fillGeometry: [], children: [
          shape("3:1", "A", at(100, 150), 50, 50, {}),
          shape("3:2", "B", at(120, 170), 50, 50, { fills: [solid(0, 1, 0)] }),
        ] },
      // 4: clipping frame whose child pokes out → clipped Merge + clip matte.
      { ...base("2:5", "Inner", "FRAME", at(200, 150), 150, 100), kind: "container", clipsContent: true,
        fills: [], fillGeometry: [{ windingRule: "NONZERO", data: rectPath(150, 100) }], children: [
          { ...shape("4:1", "Overflow", at(300, 200), 100, 100, {}),
            renderBounds: { x: 300, y: 200, width: 100, height: 100 } },
        ] },
      // 5: a mask and the layer it masks. A mask mattes EVERY sibling above
      //    it up to the next mask, so Figma's "Use as mask" groups them —
      //    the pass-through group flattens away around the masked stack.
      { ...base("2:11", "Masked group", "GROUP", I, 400, 300), kind: "container", clipsContent: false,
        fills: [], fillGeometry: [], children: [
          { ...shape("2:6", "Mask", at(0, 0), 50, 50, {}), isMask: true, maskType: "VECTOR" },
          { ...shape("2:7", "Masked", at(10, 10), 80, 80, { fills: [solid(1, 1, 0)] }), figmaType: "ELLIPSE" },
        ] },
      // 7: text as glyph outlines.
      { ...base("2:8", "Title", "TEXT", at(20, 250), 40, 20), kind: "text",
        text: { characters: "Hi", segments: [], alignHorizontal: "LEFT", alignVertical: "TOP",
          autoResize: "WIDTH_AND_HEIGHT", truncation: "DISABLED", maxLines: null, leadingTrim: "NONE",
          hasMissingFont: false },
        fills: [solid(0, 0, 0)], fillGeometry: [{ windingRule: "NONZERO", data: rectPath(10, 20) }] },
      // 8: rotated rect (30°, clockwise on screen) — geometry must rotate.
      shape("2:9", "Tilted", [[c30, -s30, 250], [s30, c30, 200]], 40, 20, { fills: [solid(0, 0, 1)] }),
      // 9: image fill, FILL mode: 100×100 image in a 200×100 box → covers
      //    200×200, centred (overflows 50 px top and bottom).
      shape("2:10", "Photo", at(100, 0), 200, 100, {
        fills: [{ type: "IMAGE", visible: true, opacity: 0.8, blendMode: "NORMAL", imageHash: "h1", scaleMode: "FILL" }],
      }),
    ],
  },
  images: { h1: { mime: "image/png", width: 100, height: 100, base64: PNG_1PX } },
  warnings: [],
};

// ---- 1. parse / sanitize ------------------------------------------------------

const text = JSON.stringify(scene);
check("marker sits at the front of the payload", looksLikeFigmaSceneText(text));
check("an ordinary fragment is not a scene", !looksLikeFigmaSceneText(JSON.stringify({ __toolbox_fragment__: 1 })));
const parsed = parseFigmaScene(text);
check("round-trips the frame", parsed.frame.width === 400 && parsed.frame.children.length === 9);
check("image payload accepted", !!parsed.images.h1 && parsed.images.h1.mime === "image/png");

const throws = (label: string, t: string, needle: string) => {
  try {
    parseFigmaScene(t);
    check(label, false, "did not throw");
  } catch (e) {
    check(label, e instanceof FigmaSceneError && String((e as Error).message).includes(needle), String(e));
  }
};
throws("truncated JSON is refused", text.slice(0, text.length - 10), "valid JSON");
throws("a newer format is refused", JSON.stringify({ ...scene, [FIGMA_SCENE_MARKER]: 99 }), "v99");
throws("no frame is refused", JSON.stringify({ [FIGMA_SCENE_MARKER]: 1 }), "no frame");
{
  const evil = JSON.parse(text);
  evil.images.h1.base64 = "not base64 <script>";
  evil.images.h2 = { mime: "text/html", width: 1, height: 1, base64: "AAAA" };
  evil.frame.children[0].fillGeometry[0].data = "M 0 0 L 1 1 <svg onload=x>";
  evil.frame.children[1].opacity = "0.5";
  evil.frame.transform = [[2, 0, 50], [0, 2, 50]];
  const p = parseFigmaScene(JSON.stringify(evil));
  check("non-base64 image payload dropped", !p.images.h1);
  check("non-image MIME dropped", !p.images.h2);
  check("path data with foreign characters dropped", p.frame.children[0].kind === "shape" && (p.frame.children[0] as any).fillGeometry.length === 0);
  check("non-numeric opacity falls back to 1", p.frame.children[1].opacity === 1);
  check("root frame transform pinned to identity", JSON.stringify(p.frame.transform) === JSON.stringify(I));
}

// ---- 2. convert -----------------------------------------------------------------

const fakeBitmap = { width: 1, height: 1, fake: true };
const res = convertFigmaScene(parsed, { images: new Map([["h1", fakeBitmap]]), reference: { fake: "ref" } });
const byId = new Map(res.nodes.map((n) => [n.id, n]));
const into = (id: string) => res.edges.filter((e) => e.target === id);
const from = (id: string) => res.edges.filter((e) => e.source === id);
const src = (id: string, handle: string) => {
  const e = res.edges.find((x) => x.target === id && x.targetHandle === handle);
  return e ? byId.get(e.source) : undefined;
};
const root = byId.get(res.output.nodeId)!;
const rootLayers = root.data.params.layers as any[];

check("output is the root Merge, named after the frame", root.data.defType === "merge" && root.data.name === "Card");
check("frame size reported", res.frame.width === 400 && res.frame.height === 300);
{
  const bg = src(root.id, "in:base");
  check("flat white background becomes the Solid Color base", bg?.data.defType === "solid-color" && bg.data.params.color === "#ffffff" && bg.data.params.alpha === 1);
}

// Every wire lands on a socket its target actually has (param-dependent
// sockets resolved) and leaves from a real output.
{
  const bad = res.edges.filter((e) => {
    const t = byId.get(e.target);
    const s = byId.get(e.source);
    if (!t || !s) return true;
    const sock = (e.targetHandle ?? "").replace(/^in:/, "");
    if (!t.data.inputs.some((i: any) => i.name === sock)) return true;
    if (e.sourceHandle !== "out:primary") return !s.data.auxOutputs?.some((a: any) => `out:aux:${a.name}` === e.sourceHandle);
    return !s.data.primaryOutput;
  });
  check("every edge connects real sockets", bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  const v = validateGraph(
    res.nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
    res.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle!, target: e.target, targetHandle: e.targetHandle! }))
  );
  const errs = v.issues.filter((i) => i.severity === "error");
  check("validateGraph finds no errors", errs.length === 0, JSON.stringify(errs.slice(0, 3)));
}

// Layer order: Figma children bottom → top, the mask not drawn itself.
{
  const names = rootLayers.map((l) => l.name);
  const expect = ["Rounded", "Dot", "Dot stroke", "Line", "Pair", "Inner", "Mask", "Title", "Tilted", "Photo"];
  check("root stack follows Figma order (mask drawn as a matte, not a layer)", JSON.stringify(names) === JSON.stringify(expect), JSON.stringify(names));
}
const layerSrc = (i: number) => src(root.id, `in:layer:${rootLayers[i].id}`)!;
const layerMask = (i: number) => src(root.id, `in:mask:${rootLayers[i].id}`);

// Rounded rect from an export WITHOUT primitive hints: one Rasterize doing
// fill + stroke, on a Spline Draw carrying the exact baked corners.
{
  const r = layerSrc(0);
  const p = r.data.params;
  check("fill + centred stroke share one Rasterize Spline", r.data.defType === "rasterize-spline" && p.enable_fill === true && p.enable_stroke === true);
  check("fill colour", p.fill_color === "#3366ff", String(p.fill_color));
  check("stroke in % of canvas width (2 px / 400)", p.units === "%" && near(p.thickness as number, 0.5), String(p.thickness));
  check("NONE cap → butt, MITER join → miter", p.cap === "butt" && p.join === "miter");
  check("one path with the winding rule (holes stay open)", p.stack_subpaths === false && p.fill_rule === "nonzero");
  const sd = src(r.id, "in:path")!;
  const sub = (sd.data.params.spline as any).subpaths;
  check("Spline Draw is geometry-only", sd.data.defType === "spline-draw" && sd.data.params.stroke_enabled === false && sd.data.params.fill_enabled === false);
  check("rounded rect: one closed subpath, closing duplicate folded (8 anchors)", sub.length === 1 && sub[0].closed && sub[0].anchors.length === 8, `${sub[0]?.anchors.length}`);
  // Frame px (20 + 12, 20) → x = 32/400, y = 0.5 + (20 − 150)/400.
  const a0 = sub[0].anchors[0].pos;
  check("frame px → width-relative spline space", near(a0[0], 32 / 400) && near(a0[1], 0.5 + (20 - 150) / 400), JSON.stringify(a0));
  const first = sub[0].anchors[0];
  check("the folded anchor keeps the closing curve's in-handle", !!first.inHandle && near(first.inHandle[0], -6.627 / 400, 1e-9), JSON.stringify(first.inHandle));
}

// Inside stroke: fill layer, then a 2× stroke layer matted by the circle.
{
  const fill = layerSrc(1);
  const strokeR = layerSrc(2);
  check("inside stroke: separate fill + stroke layers", fill.data.params.enable_stroke === false && strokeR.data.params.enable_fill === false);
  check("inside stroke is twice the weight (4 px → 2 %)", near(strokeR.data.params.thickness as number, 2), String(strokeR.data.params.thickness));
  const m = layerMask(2);
  const circle = src(fill.id, "in:path");
  check("full ellipse (no hint, 4-anchor geometry) → Circle primitive", circle?.data.defType === "circle" && circle.data.params.stroke_enabled === false && circle.data.params.fill_enabled === false);
  // 60 px circle at (300, 40) in a 400 × 300 frame.
  check("…centre + radii in width-relative spline space", near(circle!.data.params.centerX as number, 330 / 400) && near(circle!.data.params.centerY as number, 0.5 + (70 - 150) / 400) && near(circle!.data.params.radiusX as number, 30 / 400) && near(circle!.data.params.radiusY as number, 30 / 400));
  check("…matted by the shape's own outline (single subpath → direct)", m?.id === circle?.id);
  check("inside matte is not inverted", !rootLayers[2].maskInvert);
}

// Open dashed line: stroke on its centerline, centred despite INSIDE.
{
  const r = layerSrc(3);
  const p = r.data.params;
  check("open path strokes its centerline", p.enable_fill === false && p.enable_stroke === true && src(r.id, "in:path")?.data.name === "Line path");
  check("open path ignores inside alignment (3 px, not 6)", near(p.thickness as number, 0.75), String(p.thickness));
  check("dash pattern → dashed, % metrics", p.style === "dashed" && near(p.dash_length as number, 1.5) && near(p.dash_gap as number, 1));
  check("ROUND cap / ROUND join", p.cap === "round" && p.join === "round");
  const sub = (src(r.id, "in:path")!.data.params.spline as any).subpaths[0];
  check("open path stays open", sub.closed === false && sub.anchors.length === 2);
}

// Half-opacity group of two: isolated Merge carrying the opacity.
{
  const m = layerSrc(4);
  check("group with opacity over 2 layers → nested Merge", m.data.defType === "merge" && (m.data.params.layers as any[]).length === 2);
  check("…the group's opacity sits on its parent layer", near(rootLayers[4].opacity, 0.5));
  check("…its children keep full opacity", (m.data.params.layers as any[]).every((l) => l.opacity === 1));
  check("…on a transparent base", src(m.id, "in:base")?.data.params.alpha === 0);
}

// Clipping frame: nested Merge, matte = the frame's rect.
{
  const m = layerSrc(5);
  check("clipping frame with overflow → nested Merge", m.data.defType === "merge");
  const matte = layerMask(5);
  check("…matted by the frame outline", matte?.data.defType === "spline-draw" && matte.data.name === "Inner (clip)");
}

// Mask group: the siblings above the mask in a Merge matted by the mask.
{
  const m = layerSrc(6);
  check("mask layer's siblings → nested Merge", m.data.defType === "merge" && (m.data.params.layers as any[])[0].name === "Masked");
  check("…matted by the mask's outline", layerMask(6)?.data.name === "Mask (mask)");
}

// Text outlines + rotated geometry + image placement.
{
  const t = layerSrc(7);
  check("text without Figma's layout export falls back to glyph outlines", t.data.defType === "rasterize-spline" && t.data.params.fill_color === "#000000");
  check("…and the fallback is reported", res.warnings.some((w) => w.includes("vector outlines")));

  const r = layerSrc(8);
  // Plain 40 × 20 rect rotated 30° CW about its top-left at (250, 200): a
  // Rectangle primitive centred on the rotated box centre, rotate = 30.
  const rp = src(r.id, "in:path")!;
  const [ccx, ccy] = [250 + 20 * c30 - 10 * s30, 200 + 20 * s30 + 10 * c30];
  check("plain rect → Rectangle primitive", rp.data.defType === "rectangle" && rp.data.params.corner_radius === 0);
  check("…rotation + centre carried exactly", near(rp.data.params.rotate as number, 30, 1e-9) && near(rp.data.params.originX as number, ccx / 400) && near(rp.data.params.originY as number, 0.5 + (ccy - 150) / 400) && near(rp.data.params.width as number, 40 / 400) && near(rp.data.params.height as number, 20 / 400), JSON.stringify(rp.data.params));

  const clip = layerSrc(9);
  const img = src(clip.id, "in:fill")!;
  const ip = img.data.params;
  check("image fill: Image Source → Rasterize fill input (window)", img.data.defType === "image-source" && clip.data.params.image_fill === true && clip.data.params.fill_fit === "window");
  check("…decoded bitmap passed through", ip.file === fakeBitmap && ip.fit === "stretch");
  // FILL: 100² image in a 200×100 box at (100, 0) → 200×200 centred on
  // (200, 50) in frame px.
  check("…FILL placement", near(ip.scaleX as number, 200 / 400) && near(ip.scaleY as number, 200 / 300) && near(ip.translateX as number, 200 / 400 - 0.5) && near(ip.translateY as number, (50 - 150) / 400), JSON.stringify({ sx: ip.scaleX, sy: ip.scaleY, tx: ip.translateX, ty: ip.translateY }));
  check("…paint opacity on the layer", near(rootLayers[9].opacity, 0.8));
}

// Primitive hints (plugin ≥ 0.1.1): Rectangle / Circle only when they
// reproduce Figma's shape exactly; anything else keeps the baked geometry.
{
  const rectHint = (radii: number[], smoothing = 0) => ({ kind: "rect", radii, smoothing });
  const kids = [
    shape("p:1", "R12", at(10, 10), 200, 100, { fillGeometry: [{ windingRule: "NONZERO", data: ROUNDED }], primitive: rectHint([12, 12, 12, 12]) }),
    shape("p:2", "Corners", at(10, 10), 200, 100, { fillGeometry: [{ windingRule: "NONZERO", data: ROUNDED }], primitive: rectHint([12, 0, 12, 0]) }),
    shape("p:3", "Smooth60", at(10, 10), 200, 100, { primitive: rectHint([12, 12, 12, 12], 0.6) }),
    shape("p:4", "Smooth100", at(10, 10), 200, 100, { primitive: rectHint([12, 12, 12, 12], 1) }),
    { ...shape("p:5", "Arc", at(10, 10), 60, 60, { fillGeometry: [{ windingRule: "NONZERO", data: CIRCLE }], primitive: { kind: "ellipse", full: false } }), figmaType: "ELLIPSE" },
    { ...shape("p:6", "Oval30", [[c30, -s30, 50], [s30, c30, 50]], 80, 40, { fillGeometry: [{ windingRule: "NONZERO", data: CIRCLE }], primitive: { kind: "ellipse", full: true } }), figmaType: "ELLIPSE" },
    { ...shape("p:7", "OvalQuarter", [[0, -1, 50], [1, 0, 50]], 80, 40, { fillGeometry: [{ windingRule: "NONZERO", data: CIRCLE }], primitive: { kind: "ellipse", full: true } }), figmaType: "ELLIPSE" },
    shape("p:8", "Flipped", [[-1, 0, 100], [0, 1, 10]], 40, 20, {}),
  ];
  const s = parseFigmaScene(JSON.stringify({ ...scene, frame: { ...scene.frame, children: kids } }));
  const r = convertFigmaScene(s);
  const srcOf = (name: string) => {
    const raster = r.nodes.find((n) => n.data.defType === "rasterize-spline" && String(n.data.name).startsWith(`${name} `));
    const e = r.edges.find((x) => x.target === raster?.id && x.targetHandle === "in:path");
    return r.nodes.find((n) => n.id === e?.source);
  };
  const r12 = srcOf("R12");
  check("hinted uniform radius → Rectangle with that radius", r12?.data.defType === "rectangle" && near(r12.data.params.corner_radius as number, 12 / 400) && r12.data.params.corner_style === "round");
  check("per-corner radii → Spline Draw (exact geometry)", srcOf("Corners")?.data.defType === "spline-draw");
  check("partial corner smoothing → Spline Draw", srcOf("Smooth60")?.data.defType === "spline-draw");
  check("full corner smoothing → Rectangle squircle", srcOf("Smooth100")?.data.params.corner_style === "squircle");
  check("arc / donut ellipse → Spline Draw", srcOf("Arc")?.data.defType === "spline-draw");
  check("ellipse rotated off-axis → Spline Draw (Circle can't rotate)", srcOf("Oval30")?.data.defType === "spline-draw");
  const q = srcOf("OvalQuarter");
  check("quarter-turned ellipse → Circle with radii swapped", q?.data.defType === "circle" && near(q.data.params.radiusX as number, 20 / 400) && near(q.data.params.radiusY as number, 40 / 400));
  check("flipped rect → Spline Draw", srcOf("Flipped")?.data.defType === "spline-draw");
}

// Mask scope: a mask mattes every sibling above it until the next mask.
{
  const s = parseFigmaScene(JSON.stringify({
    ...scene,
    frame: { ...scene.frame, children: [
      shape("9:0", "Under", at(0, 0), 10, 10, {}),
      { ...shape("9:1", "M1", at(0, 0), 50, 50, {}), isMask: true },
      shape("9:2", "A", at(5, 5), 10, 10, {}),
      shape("9:3", "B", at(8, 8), 10, 10, {}),
      { ...shape("9:4", "M2", at(20, 20), 50, 50, {}), isMask: true },
      shape("9:5", "C", at(25, 25), 10, 10, {}),
    ] },
  }));
  const r = convertFigmaScene(s);
  const top = r.nodes.find((n) => n.id === r.output.nodeId)!;
  const ls = top.data.params.layers as any[];
  const inner = (i: number) => {
    const e = r.edges.find((x) => x.target === top.id && x.targetHandle === `in:layer:${ls[i].id}`);
    const n = r.nodes.find((x) => x.id === e?.source);
    return (n?.data.params.layers as any[] | undefined)?.map((l) => l.name);
  };
  check("mask scope: unmasked layer below, one matted stack per mask", JSON.stringify(ls.map((l) => l.name)) === JSON.stringify(["Under", "M1", "M2"]), JSON.stringify(ls.map((l) => l.name)));
  check("…M1 mattes A and B, M2 mattes C", JSON.stringify(inner(1)) === JSON.stringify(["A", "B"]) && JSON.stringify(inner(2)) === JSON.stringify(["C"]));
}

check("reference node added, detached",!!res.referenceNodeId && into(res.referenceNodeId!).length === 0 && from(res.referenceNodeId!).length === 0);
check("nodes laid out (not all at the origin)", new Set(res.nodes.map((n) => `${n.position.x},${n.position.y}`)).size > res.nodes.length / 2);

// ---- 3. real-export regressions ----------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures", "figma-import");

// Exact-placement checks on particular exports (live text baselines, stack
// order, rotated images) live beside them in real-exports.mts. Both are
// local-only, so this runs them when present and otherwise just smoke-tests
// whatever exports are in the folder.
const local = join(dir, "real-exports.mts");
if (existsSync(local)) {
  const { default: runRealExports } = await import(pathToFileURL(local).href);
  runRealExports({ dir, check, near });
}
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
for (const f of files) {
  try {
    const s = parseFigmaScene(readFileSync(join(dir, f), "utf8"));
    const imgs = new Map(Object.keys(s.images).map((k) => [k, { fake: k }]));
    const r = convertFigmaScene(s, { images: imgs });
    const v = validateGraph(
      r.nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
      r.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle!, target: e.target, targetHandle: e.targetHandle! }))
    );
    const errs = v.issues.filter((i) => i.severity === "error");
    check(`fixture ${f}: converts to a valid graph (${r.nodes.length} nodes)`, errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  } catch (e) {
    check(`fixture ${f}: converts`, false, String(e));
  }
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
