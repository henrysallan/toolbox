// check:skia-bake — Skia Bake, the `bake` lowering class
// (specdocs/101326_skia-target.md §3.2, Wave 3 lane B): an engine image
// inside a Skia layer, shipped as one PNG or a sprite sheet the exported
// clock steps through.
//
//   1. the node + the wiring rule: skia-bake is offered in Skia layers; an
//      engine node inside one is still refused (and the message names Skia
//      Bake); an image wired in from outside through a Layer Input socket
//      (or its backdrop) flattens to source → Skia Bake.
//   2. the preview: the node reads its input back, files a CanvasKit frame
//      under the AssetIR its output carries, and the Skia Canvas resolver
//      draws exactly those bytes; frames are a bounded ring per context.
//   3. the PNG codec: byte-exact round trip, and the preview's premultiply
//      ≡ Skia decoding the shipped PNG (CanvasKit CPU).
//   4. planning: static vs animated from the graph (keyframes, clip windows,
//      time-driven defs, fingerprintExtras that move with the tick), forced
//      modes, the frame map at any bake fps, the sheet layout and its cap.
//   5. sheet composition: cells are the frames, gutters repeat the edges.
//   6. EXACTNESS (CanvasKit CPU): the shipped draw (clipped sheet image at a
//      held offset) vs the preview's frame draw, beside the alternatives
//      (ImageShader + clip, Atlas) and the failure modes (no gutter, scaled
//      cells, device scales) — measured, and the shipped one held to 0.
//   7. the export: the IR rewrite, hold binds stepped by the emitted
//      timeline at every tick (fractional ticks included), the worklet /
//      baked / native bundles (type-checked in skia-harness), native mode's
//      linear clock on Reanimated's stand-in, refusals.
//   8. the asset seam (editor.ts): exportSkiaFromEditor resolves `bake:`
//      through the host's frame renderer (a fake here), ships the PNG, shifts
//      a late layer's ticks, and re-exports an Auto bake whose frames
//      contradict the graph — without rendering twice.
//   9. skia-harness/src/bundle-bake is today's export (code byte for byte;
//      the sheet's pixels come from the real engine — parity:skia --bundle
//      bake checks those against the editor's frames).
//
// The real-engine half: `npm run parity:skia -- --bundle bake` and
// `npm run compare:skia -- --a bake:blur --b bake:skb`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Edge } from "@xyflow/react";
import type { CanvasKit, Image } from "canvaskit-wasm";
import type { AssetIR, SkiaNode, SkiaScene } from "@/engine/skia/scene-ir";
import type { GraphEdge, GraphNode as EngineNode } from "@/engine/evaluator";
import type { GraphNode } from "@/state/graph-ops";
import type { RenderContext, SkiaDrawValue } from "@/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal DOM stubs — importing @/lib/project pulls the engine/registry in.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const lt = await import("@/engine/skia/layer-target");
const { validateGraph } = await import("@/engine/graph-validation");
const { flattenGraph } = await import("@/engine/flatten");
const { setCanvasKit } = await import("@/engine/skia/canvaskit");
const { SKIA_IR_VERSION, bindStatic } = await import("@/engine/skia/scene-ir");
const { renderScene } = await import("@/engine/skia/scene-render");
const bf = await import("@/engine/skia/bake-frames");
const bk = await import("@/lib/skia-export/bake");
const png = await import("@/lib/skia-export/png");
const ab = await import("@/engine/skia/asset-bytes");
const { exportSkia, makeSceneSampler } = await import("@/lib/skia-export");
const ed = await import("@/lib/skia-export/editor");
const { dataOnlyContext } = await import("@/lib/skia-export/scene-sample");
const { buildCatalogDsl } = await import("@/lib/ai/generate-recipe-client");
const { makeInstanceNode, makeLayerNodes, refreshNodeSockets, newEdgeId } = await import("@/state/graph-ops");
const { checkExportable } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/bake-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK: CanvasKit = await require("canvaskit-wasm")();
setCanvasKit(CK);

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const measured = (s: string) => console.log(`     measured: ${s}`);
const RUNTIME = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const TL = fx.BAKE_TIMELINE; // 60 fps, 60 frames
const W = fx.BAKE_SIZE;
const CANVAS = { width: W, height: W };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "check-skia-bake-"));

// ---- deterministic pixels ----------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
// A frame with structure (gradients), noise and a translucent band.
function frame(w: number, h: number, seed: number, translucent = true): Uint8Array {
  const r = rng(seed);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = Math.floor(((x + seed * 7) % w) * (255 / w));
      px[i + 1] = Math.floor((y / h) * 255);
      px[i + 2] = Math.floor(r() * 256);
      px[i + 3] = translucent && y > h * 0.6 ? Math.floor(r() * 256) : 255;
    }
  }
  return px;
}
// Straight → premultiplied RGBA8 with Skia's rounding (SkMulDiv255Round):
// what a 1:1 draw of an unpremul image leaves on a premul surface.
function premultiply(px: Uint8Array): Uint8Array {
  const m = (c: number, a: number) => {
    const p = c * a + 128;
    return (p + (p >> 8)) >> 8;
  };
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    out[i] = m(px[i], a);
    out[i + 1] = m(px[i + 1], a);
    out[i + 2] = m(px[i + 2], a);
    out[i + 3] = a;
  }
  return out;
}
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from({ length: a.length }).every((_, i) => a[i] === b[i]);
function diff(a: ArrayLike<number>, b: ArrayLike<number>): { max: number; mean: number; off: number } {
  let max = 0;
  let sum = 0;
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      sum += d;
      if (d > m) m = d;
    }
    if (m) off++;
    if (m > max) max = m;
  }
  return { max, mean: sum / a.length, off: off / (a.length / 4) };
}

// ---- CanvasKit CPU rendering ---------------------------------------------------------------

function renderIR(root: SkiaNode, w: number, h: number, assets: Record<string, Image>, scale = 1): Uint8Array {
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);
  const surface = CK.MakeSurface(sw, sh)!;
  const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const air: Record<string, AssetIR> = Object.fromEntries(Object.keys(assets).map((id) => [id, { id, kind: "image", mime: "image/png", url: `mem:${id}` } as AssetIR]));
  const scene: SkiaScene = {
    version: SKIA_IR_VERSION,
    width: w,
    height: h,
    root: scale === 1 ? root : { k: "group", transform: { scale: [bindStatic(scale), bindStatic(scale)] }, children: [root] },
    assets: air,
  };
  const r = renderScene(CK, canvas, scene, { assets: (id) => assets[id] ?? null, surfaceSize: [sw, sh] });
  surface.flush();
  const snap = surface.makeImageSnapshot();
  const px = snap.readPixels(0, 0, { width: sw, height: sh, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  r.release();
  snap.delete();
  surface.delete();
  if (r.problems.length) throw new Error(`renderIR: ${r.problems.join("; ")}`);
  return new Uint8Array(px);
}
const imageDraw = (asset: string, w: number, h: number): Extract<SkiaNode, { k: "image" }> => ({
  k: "image",
  asset,
  x: bindStatic(0),
  y: bindStatic(0),
  w: bindStatic(w),
  h: bindStatic(h),
  fit: "fill",
});

// ---- editor graphs ---------------------------------------------------------------------------

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge => ({ id: newEdgeId(), source, sourceHandle, target, targetHandle });
const node = (type: string, id: string, parentId?: string, params?: Record<string, unknown>): GraphNode => {
  const n = makeInstanceNode(type, { x: 0, y: 0 });
  n.id = id;
  n.data.parentId = parentId;
  if (params) n.data.params = { ...n.data.params, ...params };
  return refreshNodeSockets(n);
};
const val = (nodes: GraphNode[]) => nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params, parentId: n.data.parentId, name: n.data.name }));
const valEdges = (edges: Edge[]) => edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? "", target: e.target, targetHandle: e.targetHandle ?? "" }));

// The bake fixture as the editor holds it: noise → blur at the composition
// root, a Skia layer whose Layer Input carries a minted `fx` image socket
// into Skia Bake → Skia Group (+ ring) → Skia Canvas → Layer Output.
function bakeInLayer(opts: { animated?: boolean; bake?: Record<string, unknown> } = {}) {
  const flat = fx.bakeGraph(opts);
  const { layer, groupInput, groupOutput } = makeLayerNodes("Baked", { x: 0, y: 0 });
  layer.data.params = { ...layer.data.params, target: "skia", interface: { inputs: [{ name: "fx", type: "image" }], outputs: [] } };
  groupInput.data.params = { ...groupInput.data.params, sockets: [...((groupInput.data.params.sockets as unknown[]) ?? []), { name: "fx", type: "image" }] };
  const nodes: GraphNode[] = [layer, groupInput, groupOutput];
  const inside = new Set(["bk", "ring", "grp", "skc"]);
  for (const en of flat.nodes) {
    if (en.id === "skb") continue;
    const n = node(en.type, en.id, inside.has(en.id) ? layer.id : undefined);
    n.data.params = en.params;
    n.data.animation = en.animation;
    nodes.push(n);
  }
  const edges: Edge[] = [
    edge("noise", "out:primary", "blur", "in:image"),
    edge("blur", "out:primary", layer.id, "in:fx"),
    edge(groupInput.id, "out:aux:fx", "bk", "in:image"),
    edge("bk", "out:primary", "grp", "in:child1"),
    edge("ring", "out:primary", "grp", "in:child2"),
    edge("grp", "out:primary", "skc", "in:scene"),
    edge("skc", "out:primary", groupOutput.id, "in:image"),
  ];
  return { layer, groupInput, groupOutput, nodes, edges };
}
const toEngine = (nodes: GraphNode[], edges: Edge[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.defType, parentId: n.data.parentId, params: n.data.params, animation: n.data.animation, clips: n.data.clips, bypassed: false })) as EngineNode[],
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? "out:primary", target: e.target, targetHandle: e.targetHandle ?? "in:image" })) as GraphEdge[],
});

// ---- 1. the node + the wiring rule ----------------------------------------------------------
console.log("— the node and the wiring rule");
{
  const def = getNodeDef("skia-bake");
  check(
    "skia-bake: registered, skia { class: \"bake\" }, engine image in, skia_draw out",
    !!def && def.skia?.class === "bake" && def.primaryOutput === "skia_draw" && def.inputs[0]?.name === "image" && def.inputs[0]?.type === "image" && def.noMaskInput === true
  );
  check("…offered inside a Skia layer (add-node menu, validator)", lt.isOfferedInSkiaLayer(def) && lt.isSkiaLayerType("skia-bake"));
  check("…and listed by get_catalog({ target: \"skia\" })", /^skia-bake \(Skia Bake\)/m.test(buildCatalogDsl({ target: "skia" })));
  check("engine nodes stay out of Skia layers", !lt.isSkiaLayerType("blur") && !lt.isSkiaLayerType("noise"));

  const L = bakeInLayer();
  const v = validateGraph(val(L.nodes), valEdges(L.edges));
  const skiaIssues = v.issues.filter((i) => i.code === "SKIA_LAYER_UNSUPPORTED");
  check("the rule's wiring validates: engine graph at the root → Layer Input socket → Skia Bake", !skiaIssues.length, JSON.stringify(skiaIssues));
  const moved = L.nodes.map((n) => (n.id === "blur" ? { ...n, data: { ...n.data, parentId: L.layer.id } } : n));
  const bad = validateGraph(val(moved), valEdges(L.edges)).issues.filter((i) => i.code === "SKIA_LAYER_UNSUPPORTED");
  check(
    "an engine node moved inside the Skia layer is refused, and the message points at Skia Bake",
    bad.length === 1 && bad[0].message.includes("(blur)") && bad[0].message.includes("Skia Bake (skia-bake)") && bad[0].message.includes("Layer Input"),
    JSON.stringify(bad.map((i) => i.message))
  );
  const E = toEngine(L.nodes, L.edges);
  const flat = flattenGraph(E.nodes, E.edges);
  const into = flat.edges.filter((e) => e.target === "bk" && e.targetHandle === "in:image");
  check("flatten splices the Layer Input wire: blur → Skia Bake directly", into.length === 1 && into[0].source === "blur" && into[0].sourceHandle === "out:primary", JSON.stringify(into));
  check("…and the bake sits in the layer (local clock), the blur at the root", flat.layerOf.get("bk") === L.layer.id && !flat.layerOf.has("blur"));
  // The backdrop: what is below the layer, through the Layer Input's reserved socket.
  const B = bakeInLayer();
  const bEdges = B.edges.filter((e) => !(e.target === "bk" && e.targetHandle === "in:image")).filter((e) => e.target !== B.layer.id);
  bEdges.push(edge("blur", "out:primary", B.layer.id, "in:stack"), edge(B.groupInput.id, "out:aux:backdrop", "bk", "in:image"));
  const bf2 = flattenGraph(toEngine(B.nodes, bEdges).nodes, toEngine(B.nodes, bEdges).edges);
  check("the Layer Input's backdrop bakes the stack below the layer", bf2.edges.some((e) => e.source === "blur" && e.target === "bk" && e.targetHandle === "in:image"));
}

// ---- 2. the preview --------------------------------------------------------------------------
console.log("— the preview");
{
  const def = getNodeDef("skia-bake")!;
  const w = 24;
  const h = 16;
  const base = dataOnlyContext({ width: w, height: h }, TL);
  let next = frame(w, h, 1);
  const reads: [number, number][] = [];
  const ctx = {
    ...base,
    state: {},
    readImagePixels: (_img: unknown, rw: number, rh: number) => {
      reads.push([rw, rh]);
      return new Uint8ClampedArray(next);
    },
  } as unknown as RenderContext;
  const img = { kind: "image", texture: {}, width: 64, height: 64 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (inputs: Record<string, unknown>, c: RenderContext = ctx) => (def.compute as any)({ inputs, params: { mode: "auto", fps: 0, max_sheet: "4096" }, ctx: c, nodeId: "bk" }).primary as SkiaDrawValue;
  const out = run({ image: img });
  const n = out.node as Extract<SkiaNode, { k: "image" }>;
  const asset = out.assets?.["bake_bk"];
  check(
    "the output is one image draw over the canvas (fit fill) of the asset bake:<nodeId>",
    n.k === "image" && n.asset === "bake_bk" && n.x.v === 0 && n.y.v === 0 && n.w.v === w && n.h.v === h && n.fit === "fill" && asset?.url === "bake:bk" && asset.kind === "image" && !out.problems
  );
  check("…the input is read back at the canvas size (whatever its own size)", reads.length === 1 && reads[0][0] === w && reads[0][1] === h, JSON.stringify(reads));
  const frameImg = bf.bakeFrameImage(ctx, asset);
  check("…and filed under the AssetIR object the output carries", !!frameImg && bf.bakeFrameImage(ctx, { ...asset! }) === null && frameImg.width() === w);
  const resolver = bf.withBakeFrames(ctx, undefined);
  const scene: SkiaScene = { version: SKIA_IR_VERSION, width: w, height: h, root: out.node, assets: out.assets! };
  const surface = CK.MakeSurface(w, h)!;
  surface.getCanvas().clear(CK.TRANSPARENT);
  const r = renderScene(CK, surface.getCanvas(), scene, { assets: resolver });
  surface.flush();
  const drawn = surface.makeImageSnapshot().readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  r.release();
  surface.delete();
  check(
    "the Skia Canvas resolver draws exactly the engine bytes",
    !r.problems.length && sameBytes(drawn, premultiply(next)),
    `${r.problems.join("; ")} ${JSON.stringify(diff(drawn, premultiply(next)))}`
  );
  const kept: Image[] = [frameImg!];
  for (let i = 0; i < 5; i++) {
    next = frame(w, h, 10 + i);
    const o = run({ image: img });
    kept.push(bf.bakeFrameImage(ctx, o.assets!["bake_bk"])!);
  }
  check("frames are a ring of 4 per node and context: older CanvasKit images are deleted", kept.slice(0, 2).every((i) => i.isDeleted()) && kept.slice(2).every((i) => !i.isDeleted()));
  def.dispose!(ctx, "bk");
  check("dispose deletes the rest", kept.every((i) => i.isDeleted()) && !(ctx.state as Record<string, unknown>)["skia-bake:bk"]);
  const unwired = run({});
  check("unwired in the editor: the draw still ships, with a problem naming the Layer Input route", !!unwired.problems?.[0]?.includes("Layer Input"), JSON.stringify(unwired.problems));
  const sampler = run({}, dataOnlyContext({ width: w, height: h }, TL));
  check("…but the export's GL-less sampler sees no problem (it cuts the input and renders it separately)", !sampler.problems && sampler.node.k === "image");
}

// ---- 3. the PNG codec ---------------------------------------------------------------------------
console.log("— the PNG codec");
{
  const w = 37;
  const h = 23;
  const px = frame(w, h, 3);
  const bytes = await png.encodePng(px, w, h);
  const back = await png.decodePng(bytes);
  check("encodePng → decodePng is byte-exact, translucent pixels included", back.width === w && back.height === h && sameBytes(back.rgba, px));
  const decoded = CK.MakeImageFromEncoded(bytes)!;
  check("CanvasKit decodes the shipped PNG unpremultiplied (React Native Skia web's useImage)", decoded.getImageInfo().alphaType.value === CK.AlphaType.Unpremul.value);
  const surfacePx = (img: Image, scale = 1) => renderIR(imageDraw("f", w, h), w, h, { f: img }, scale);
  const preview = bf.makeBakeImage(CK, px, w, h)!;
  const premulCopy = CK.MakeImage({ width: w, height: h, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, premultiply(px), w * 4)!;
  for (const sc of [1, 2, 0.5, 1.37]) {
    const fromPng = surfacePx(decoded, sc);
    const d = diff(surfacePx(preview, sc), fromPng);
    check(`the preview's frame image draws exactly what Skia draws from the shipped PNG, at device scale ${sc}`, d.max === 0, JSON.stringify(d));
    if (sc !== 1) {
      const p = diff(surfacePx(premulCopy, sc), fromPng);
      measured(`a PREMULTIPLIED copy of the same bytes (Skia's own rounding) vs the decoded PNG at scale ${sc}: max ${p.max}/255 on ${(p.off * 100).toFixed(1)} % px — why the preview stays unpremul`);
    }
  }
  check("…an opaque frame is identical either way", sameBytes(surfacePx(CK.MakeImage({ width: w, height: h, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, frame(w, h, 4, false), w * 4)!, 2), surfacePx(CK.MakeImageFromEncoded(await png.encodePng(frame(w, h, 4, false), w, h))!, 2)));
}

// ---- 4. planning ---------------------------------------------------------------------------------
console.log("— planning");
{
  const dep = (opts: Parameters<typeof fx.bakeGraph>[0], tweak?: (nodes: EngineNode[], edges: GraphEdge[]) => void) => {
    const f = fx.bakeGraph(opts);
    tweak?.(f.nodes, f.edges);
    return bk.bakeTimeDependence(f.nodes, f.edges, "bk", CANVAS, TL);
  };
  const still = { animated: false };
  check("animated Noise (fingerprintExtras with the tick) → animated", dep({})?.includes("noise (noise) changes with the playhead") === true, String(dep({})));
  check("a still graph → static", dep(still) === null, String(dep(still)));
  check(
    "a keyframed param upstream → animated",
    dep(still, (n) => {
      n.find((x) => x.id === "blur")!.animation = { radius: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 2, easingOut: "linear" }, { tick: 30_000, value: 9, easingOut: "linear" }] } };
    })?.includes("keyframed (radius)") === true
  );
  check(
    "a clip window upstream → animated",
    dep(still, (n) => {
      n.find((x) => x.id === "noise")!.clips = [{ inTick: 0, outTick: 30_000, sourceInTick: 0, enabled: true }];
    })?.includes("clip window") === true
  );
  check(
    "a time-driven driver wired upstream (LFO → blur radius) → animated",
    dep(still, (n, e) => {
      n.push({ id: "lfo", type: "lfo", params: {} });
      n.find((x) => x.id === "blur")!.exposedParams = ["radius"];
      e.push({ id: "lfo-r", source: "lfo", sourceHandle: "out:primary", target: "blur", targetHandle: "in:param:radius" });
    })?.includes("lfo (lfo)") === true
  );
  check("the ring (downstream of the bake) doesn't count", dep(still) === null);

  const plan = (opts: Parameters<typeof fx.bakeGraph>[0], timeline = TL, canvas = CANVAS) => {
    const f = fx.bakeGraph(opts);
    const node = f.nodes.find((x) => x.id === "bk")!;
    return bk.planBake(node, { node: "blur", handle: "out:primary" }, f.nodes, f.edges, canvas, timeline, "bake_bk");
  };
  const a = plan({});
  check(
    "auto + animated: a 61-cell sheet (frames 0…60) at full size, 31 × 2, 4030 × 260 px",
    a.plan?.mode === "animated" && a.plan.layout?.cols === 31 && a.plan.layout.rows === 2 && a.plan.layout.sheetWidth === 4030 && a.plan.layout.sheetHeight === 260 && !a.plan.layout.scaled && a.plan.ticks?.length === 61 && !a.warnings.length,
    JSON.stringify(a.plan?.layout)
  );
  check("auto + still: one PNG", plan({ animated: false }).plan?.mode === "static");
  check("Bake = Static PNG wins over an animated graph", plan({ bake: { mode: "static" } }).plan?.mode === "static");
  check("Bake = Sprite sheet wins over a still graph", plan({ animated: false, bake: { mode: "animated" } }).plan?.mode === "animated");
  const slow = plan({ bake: { fps: 20 } });
  check(
    "Bake FPS 20 on a 60 fps timeline: 21 cells, each held 3 frames, with a warning",
    slow.plan?.ticks?.length === 21 && slow.plan.cellOfFrame?.[0] === 0 && slow.plan.cellOfFrame[2] === 0 && slow.plan.cellOfFrame[3] === 1 && slow.plan.cellOfFrame[60] === 20 && slow.warnings.some((w) => w.includes("20 fps")),
    JSON.stringify(slow.plan?.cellOfFrame?.slice(0, 8))
  );
  check("Bake FPS above the timeline's clamps to it", plan({ bake: { fps: 240 } }).plan?.ticks?.length === 61);
  // The frame map at any rate: frame f shows the newest cell at or before it.
  let mapOk = true;
  for (const [fps, b] of [[60, 60], [60, 20], [60, 25], [60, 7], [30, 24], [24, 23.976]] as const) {
    const m = bk.bakeFrameMap(301, fps, b, 1000);
    for (let f = 0; f < 301; f++) {
      const k = m.cellOfFrame[f];
      if (!(m.ticks[k] <= f * 1000 && (k + 1 >= m.ticks.length || m.ticks[k + 1] > f * 1000))) mapOk = false;
    }
    if (m.ticks[0] !== 0 || m.ticks.some((t, i) => i > 0 && t <= m.ticks[i - 1]) || !m.ticks.every((t) => t % 1000 === 0)) mapOk = false;
  }
  check("bakeFrameMap: every frame shows the newest cell at or before it, cells on whole frames, at 60/60 … 24/23.976", mapOk);

  const L1 = bk.layoutSheet(512, 512, 301, 4096)!;
  check(
    "301 frames at 512² under a 4096 cap: scaled to fit, inside the cap, room for every frame",
    L1.scaled && L1.sheetWidth <= 4096 && L1.sheetHeight <= 4096 && L1.cols * L1.rows >= 301 && L1.frameWidth === L1.frameHeight,
    JSON.stringify(L1)
  );
  measured(`301 × 512² @4096 → ${L1.frameWidth}² cells (${((L1.frameWidth / 512) * 100).toFixed(1)} %), ${L1.cols}×${L1.rows}, ${L1.sheetWidth}×${L1.sheetHeight}`);
  const L2 = bk.layoutSheet(1080, 1920, 121, 4096)!;
  check("a 1080×1920 portrait canvas keeps its aspect when scaled", L2.scaled && Math.abs(L2.frameHeight / L2.frameWidth - 1920 / 1080) < 0.02 && L2.sheetWidth <= 4096 && L2.sheetHeight <= 4096 && L2.cols * L2.rows >= 121);
  measured(`121 × 1080×1920 @4096 → ${L2.frameWidth}×${L2.frameHeight} cells, ${L2.cols}×${L2.rows}; @8192 → ${(() => {
    const l = bk.layoutSheet(1080, 1920, 121, 8192)!;
    return `${l.frameWidth}×${l.frameHeight}`;
  })()}`);
  const full = bk.layoutSheet(4094, 100, 1, 4096)!;
  check("one 4094-wide frame fits a 4096 cap exactly (2 px of gutter)", !full.scaled && full.sheetWidth === 4096);
  check("a frame count no 1-px grid holds is refused (null)", bk.layoutSheet(8, 8, 2_000_000, 2048) === null);
  const scaledWarn = plan({}, { ...TL, sceneDurationTicks: 600_000 }, { width: 512, height: 512 });
  check("planBake warns when it has to scale frames down", scaledWarn.plan?.layout?.scaled === true && scaledWarn.warnings.some((w) => w.includes("scaled up on device")));
  check("Max sheet 8192 is honoured", plan({ bake: { max_sheet: "8192" } }, { ...TL, sceneDurationTicks: 600_000 }, { width: 512, height: 512 }).plan?.layout?.cap === 8192);
}

// ---- 5. sheet composition ---------------------------------------------------------------------
console.log("— sheet composition");
{
  const w = 9;
  const h = 5;
  const frames = [0, 1, 2, 3, 4].map((i) => frame(w, h, 20 + i));
  const L = bk.layoutSheet(w, h, 5, 30)!; // 2 per row, 3 rows
  const sheet = bk.composeSheet(frames, w, h, L);
  let cells = true;
  let gutters = true;
  frames.forEach((f, k) => {
    const [cx, cy] = bk.cellOrigin(L, k);
    for (let y = -1; y <= h; y++) {
      for (let x = -1; x <= w; x++) {
        const s = ((cy + y) * L.sheetWidth + cx + x) * 4;
        const o = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
        const eq = sheet[s] === f[o] && sheet[s + 1] === f[o + 1] && sheet[s + 2] === f[o + 2] && sheet[s + 3] === f[o + 3];
        if (eq) continue;
        if (x < 0 || y < 0 || x === w || y === h) gutters = false;
        else cells = false;
      }
    }
  });
  check("each cell is its frame, byte for byte", cells && L.cols === 2 && L.rows === 3);
  check("each gutter repeats its cell's edge pixels (corners too)", gutters);
  const [tx, ty] = bk.cellOrigin(L, 5);
  check("cells past the last frame stay transparent", sheet[(ty * L.sheetWidth + tx) * 4 + 3] === 0);
  // 2× box downscale of a 2×2 pattern, premultiplied.
  const src = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 0, 0, 0, 0, 0]);
  const half = bk.resampleRgba(src, 2, 2, 1, 1);
  check("resample averages in premultiplied space (a transparent pixel adds no colour)", half[3] === 128 && half[0] === 128 && half[1] === 0 && half[2] === 128, JSON.stringify(Array.from(half)));
  const flat = new Uint8Array(6 * 4 * 4).map((_, i) => [10, 200, 30, 255][i % 4]);
  check("…and a flat colour stays exact at any ratio", sameBytes(bk.resampleRgba(flat, 6, 4, 4, 3), new Uint8Array(4 * 3 * 4).map((_, i) => [10, 200, 30, 255][i % 4])));
}

// ---- 6. exactness: the shipped draw vs the preview ------------------------------------------------
console.log("— exactness (CanvasKit CPU)");
{
  const w = 40;
  const h = 24;
  const K = 7;
  const frames = Array.from({ length: K }, (_, k) => frame(w, h, 100 + k));
  const L = bk.layoutSheet(w, h, K, 4096)!;
  const sheetPng = await png.encodePng(bk.composeSheet(frames, w, h, L), L.sheetWidth, L.sheetHeight);
  const sheet = CK.MakeImageFromEncoded(sheetPng)!;
  const L0 = bk.layoutSheet(w, h, K, 4096, 0)!;
  const sheet0 = CK.MakeImageFromEncoded(await png.encodePng(bk.composeSheet(frames, w, h, L0), L0.sheetWidth, L0.sheetHeight))!;
  const draw = imageDraw("s", w, h);
  const ref = (k: number, scale = 1) => renderIR(imageDraw("f", w, h), w, h, { f: bf.makeBakeImage(CK, frames[k], w, h)! }, scale);
  const shipped = (k: number, scale = 1, layout = L, img = sheet) => renderIR(bk.bakeSheetDraw(draw, layout, k), w, h, { s: img }, scale);
  const shader = (k: number, scale = 1) => {
    const g0 = bk.bakeSheetDraw(draw, L, k) as Extract<SkiaNode, { k: "group" }>;
    const im = g0.children[0] as Extract<SkiaNode, { k: "image" }>;
    const root: SkiaNode = {
      k: "group",
      clip: g0.clip,
      children: [{ k: "fill", paint: { style: "fill", color: bindStatic([0, 0, 0, 1]), shader: { k: "image", asset: "s", fit: "fill", rect: [bindStatic(im.x.v), bindStatic(im.y.v), im.w, im.h], tile: "decal" } } }],
    };
    return renderIR(root, w, h, { s: sheet }, scale);
  };
  // Atlas: every cell a sprite, the live one at the rect, the rest parked
  // off-canvas (a zero RSXform — scale 0 — makes CanvasKit's drawAtlas
  // draw NOTHING at all, the live sprite included: measured below).
  const atlas = (k: number, scale = 1, park = [1, 0, -10000, -10000]) => {
    const sprites = Array.from({ length: K }, (_, i) => [...bk.cellOrigin(L, i), w, h] as [number, number, number, number]);
    const xf = sprites.flatMap((_, i) => (i === k ? [1, 0, 0, 0] : park));
    return renderIR({ k: "atlas", asset: "s", sprites, xforms: bindStatic(xf) }, w, h, { s: sheet }, scale);
  };
  const worst = (f: (k: number) => Uint8Array, scale = 1) => {
    let max = 0;
    let off = 0;
    for (let k = 0; k < K; k++) {
      const d = diff(f(k), ref(k, scale));
      max = Math.max(max, d.max);
      off = Math.max(off, d.off);
    }
    return { max, off };
  };
  const s1 = worst((k) => shipped(k));
  check("SHIPPED (clipped sheet <Image>, whole-pixel held offset) ≡ the preview's frame, every cell, 0/255 (premultiplied surface bytes)", s1.max === 0, JSON.stringify(s1));
  const b1 = worst((k) => shader(k));
  const c1 = worst((k) => atlas(k));
  const c0 = worst((k) => atlas(k, 1, [0, 0, 0, 0]));
  measured(
    `at scale 1 — clipped <Image>: max ${s1.max}/255; ImageShader + clip: max ${b1.max}/255; Atlas (others parked off-canvas): max ${c1.max}/255; Atlas with zero RSXforms for the others: max ${c0.max}/255 (draws nothing)`
  );
  for (const sc of [2, 0.5, 1.37]) {
    const a = worst((k) => shipped(k, sc), sc);
    const b = worst((k) => shader(k, sc), sc);
    const c = worst((k) => atlas(k, sc), sc);
    const nog = worst((k) => shipped(k, sc, L0, sheet0), sc);
    measured(
      `device scale ${sc} (RN's root group) — clipped <Image>: max ${a.max}/255 on ≤ ${(a.off * 100).toFixed(1)} % px; ImageShader: max ${b.max}/255; Atlas: max ${c.max}/255; WITHOUT the 1-px gutter: max ${nog.max}/255 on ≤ ${(nog.off * 100).toFixed(1)} % px`
    );
    if (sc !== 1.37) check(`at device scale ${sc} the gutter keeps the shipped draw ≡ the preview (bilinear never reaches a neighbour cell)`, a.max === 0, JSON.stringify(a));
  }
  // Cells shrunk to fit a small cap, scaled back up on device.
  const Ls = bk.layoutSheet(w, h, K, 96)!;
  const sheetS = CK.MakeImageFromEncoded(await png.encodePng(bk.composeSheet(frames, w, h, Ls), Ls.sheetWidth, Ls.sheetHeight))!;
  let maxS = 0;
  let meanS = 0;
  for (let k = 0; k < K; k++) {
    const d = diff(shipped(k, 1, Ls, sheetS), ref(k));
    maxS = Math.max(maxS, d.max);
    meanS += d.mean / K;
  }
  check("a sheet scaled to fit draws its cells at the full rect (no neighbour bleed past the clip)", Ls.scaled);
  measured(`cells scaled to ${Ls.frameWidth}×${Ls.frameHeight} of ${w}×${h} (cap 96): max ${maxS}/255, mean ${meanS.toFixed(2)}/255 vs the full-size frame — resolution lost, as the export warns`);
}

// ---- 7. the export -----------------------------------------------------------------------------
console.log("— the export");
const exportFixture = (opts: Parameters<typeof fx.bakeGraph>[0] = {}, animation?: "worklet" | "baked" | "native", timeline = TL) => {
  const f = fx.bakeGraph(opts);
  return { f, r: exportSkia({ nodes: f.nodes, edges: f.edges, targetId: "skc", name: "Bake", canvas: CANVAS, timeline, runtimeSource: RUNTIME, ...(animation ? { animation } : {}) }) };
};
{
  const { f, r } = exportFixture();
  check(
    "the fixture exports (worklet) with no problems; its only warning, given no bytes, is the bake's asset",
    !!r.files && !r.problems.length && r.warnings.length === 1 && r.warnings[0].includes('"bake_bk"') && r.warnings[0].includes('skia-bake "bk"'),
    JSON.stringify([r.problems, r.warnings])
  );
  const m = JSON.parse(r.files!["manifest.json"]);
  const a = m.assets[0];
  check(
    "manifest: one bake asset, the sheet's size and layout, bytes to come (url bake:bk)",
    m.assets.length === 1 && a.id === "bake_bk" && a.file === "assets/bake_bk.png" && a.bundled === false && a.url === "bake:bk" && a.width === 4030 && a.height === 260 && a.sheet?.cols === 31 && a.sheet.rows === 2 && a.sheet.pad === 1 && a.sheet.fps === 60 && a.sheet.ticks.length === 61 && a.sheet.frameWidth === W
  );
  const held = m.binds.filter((b: { hold?: boolean }) => b.hold);
  check("the sheet offsets are the only sampled binds, both held; the ring's radius ships as tracks", held.length === 2 && m.bindCounts.sampled === 2 && m.bindCounts.track === 4 && held.every((b: { path: string }) => b.path.startsWith("root.children.0.children.0.")), JSON.stringify(m.bindCounts));
  check("ToolboxScene: a clipped <Group> holding the sheet <Image> at select(B, …) offsets, full sheet size", /<Group clip=\{K0\}>\s*<Image\s+image=\{IMG\d\}\s+x=\{select\(B, "b\d+"\)\}\s+y=\{select\(B, "b\d+"\)\}\s+width=\{4030\}\s+height=\{260\}/.test(r.files!["ToolboxScene.tsx"]));
  const withBytes = exportSkia({ nodes: f.nodes, edges: f.edges, targetId: "skc", name: "Bake", canvas: CANVAS, timeline: TL, runtimeSource: RUNTIME, assets: { bytes: { "bake:bk": new Uint8Array([137, 80, 78, 71]) } } });
  const wm = JSON.parse(withBytes.files!["manifest.json"]).assets[0];
  check(
    "with the bytes in SkiaExportRequest.assets: assets.ts requires the PNG, the manifest row carries file / bytes / bundled beside the sheet, no warning",
    withBytes.files!["assets.ts"].includes(`"bake_bk": require("./assets/bake_bk.png")`) && wm.bundled === true && wm.bytes === 4 && !wm.url && wm.sheet?.cols === 31 && !withBytes.warnings.length,
    JSON.stringify([wm, withBytes.warnings])
  );
  const sampler = makeSceneSampler(f.nodes, f.edges, "skc", CANVAS, TL);
  const s0 = "problem" in sampler ? null : sampler.sampleAt(0);
  check("the GL-less scene sampler never runs the engine graph behind the bake (no producer failures)", !!s0 && !("problem" in sampler) && !sampler.producerProblems().length);

  // Run the emitted timeline: every tick shows its frame's cell.
  const dir = path.join(TMP, "timeline");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "timeline.ts"), r.files!["timeline.ts"]);
  fs.writeFileSync(path.join(dir, "toolbox-timeline.ts"), r.files!["toolbox-timeline.ts"]);
  const tl = await import(pathToFileURL(path.join(dir, "timeline.ts")).href);
  const [bx, by] = held.map((b: { sample: string }) => b.sample);
  const sheet = a.sheet;
  const L = { ...sheet, sheetWidth: a.width, sheetHeight: a.height, cap: 4096, scaled: false };
  const expect = (fr: number) => bk.cellOrigin(L, Math.floor(fr)).map((v) => -v);
  let bad = 0;
  let checked = 0;
  for (let fr = 0; fr <= 60; fr++) {
    for (const d of [0, 0.25, 0.5, 0.999]) {
      if (fr === 60 && d > 0) continue;
      const s = tl.sampleBinds((fr + d) / TL.fps);
      const [ex, ey] = expect(fr);
      checked++;
      if (s[bx] !== ex || s[by] !== ey) bad++;
    }
  }
  check(`the emitted sampleBinds steps the offsets: every frame and in between (${checked} times) shows exactly floor(frame)'s cell`, bad === 0, `${bad} wrong`);
  // Negative control: the same series interpolated (what a plain sampled number does).
  const sx = new Function(`return ${/const S_b\d+: Series<number> = (\{.*\});/.exec(r.files!["timeline.ts"])![1]}`)() as { f: number[]; v: number[] };
  const lerped = sx.v[29] + (sx.v[30] - sx.v[29]) * 0.5;
  check("…an interpolated series would sit between two cells at f + 0.5 (why the bind holds)", ![...Array(61).keys()].some((k) => -bk.cellOrigin(L, k)[0] === lerped));
  const tl20 = exportFixture({ bake: { fps: 20 } }).r;
  const dir20 = path.join(TMP, "timeline20");
  fs.mkdirSync(dir20, { recursive: true });
  fs.writeFileSync(path.join(dir20, "timeline.ts"), tl20.files!["timeline.ts"]);
  fs.writeFileSync(path.join(dir20, "toolbox-timeline.ts"), tl20.files!["toolbox-timeline.ts"]);
  const t20 = await import(pathToFileURL(path.join(dir20, "timeline.ts")).href);
  const m20 = JSON.parse(tl20.files!["manifest.json"]);
  const key20 = m20.binds.find((b: { hold?: boolean }) => b.hold).sample;
  const L20 = { ...m20.assets[0].sheet, sheetWidth: m20.assets[0].width, sheetHeight: m20.assets[0].height, cap: 4096, scaled: false };
  const holds = [0, 1, 2, 2.9, 3, 4.5, 59, 59.9, 60].every((fr) => t20.sampleBinds(fr / 60)[key20] === -bk.cellOrigin(L20, Math.floor(Math.floor(fr) / 3))[0]);
  check("at Bake FPS 20 each cell holds three timeline frames", holds && m20.assets[0].sheet.ticks.length === 21);

  const st = exportFixture({ animated: false }).r;
  const sm = JSON.parse(st.files!["manifest.json"]);
  check(
    "a still bake exports one PNG at canvas size: a plain <Image> 0,0,128,128, no sheet, no animated binds",
    !!st.files && sm.assets[0].width === W && sm.assets[0].height === W && !sm.assets[0].sheet && !sm.binds.some((b: { hold?: boolean }) => b.hold) && st.files["ToolboxScene.tsx"].includes(`x={0} y={0} width={128} height={128} fit="fill"`)
  );

  // Every animation mode: the held offsets stay on sampleBinds.
  const baked = exportFixture({}, "baked").r;
  check("animation baked: exports; the offsets stay on the worklet timeline (sampleBinds, stepped)", !!baked.files && /b\d+: seriesStep\(S_b\d+, frame\)/.test(baked.files["timeline.ts"]) && !baked.problems.length);
  const native = exportFixture({}, "native").r;
  check(
    "animation native: exports; the offsets read sampleBinds off the native linear clock",
    !!native.files && native.files["ToolboxScene.tsx"].includes("sampleBinds(time.value)") && native.files["animations.ts"].includes("export function clockAnimation") && /b\d+: seriesStep/.test(native.files["timeline.ts"])
  );
  for (const mode of ["worklet", "baked", "native"] as const) {
    const ce = await checkExportable({ nodes: f.nodes, edges: f.edges, canvasId: "skc", canvas: CANVAS, timeline: TL, typecheck: true, slot: `bake-${mode}`, animation: mode });
    check(
      `checkExportable (${mode}): no problems, type-checks against react-native-skia 3.4 + Reanimated 4.7${ce.typecheck.ran ? "" : " (skipped: no skia-harness)"}`,
      !ce.problems.length && ce.typecheck.ok,
      `${ce.problems.join("; ")} ${ce.typecheck.output}`
    );
  }

  // Native mode on Reanimated's stand-in: does the linear clock pick each frame's cell?
  const ndir = path.join(TMP, "native");
  fs.mkdirSync(ndir, { recursive: true });
  for (const fl of ["animations.ts", "toolbox-native.ts", "toolbox-timeline.ts", "timeline.ts", "toolbox-clock.ts"]) fs.writeFileSync(path.join(ndir, fl), native.files![fl]);
  fs.writeFileSync(path.join(ndir, "entry.ts"), `export { clockAnimation } from "./animations";\nexport { sampleBinds } from "./timeline";\n`);
  fs.writeFileSync(path.join(ndir, "react-stub.ts"), `export const useCallback = () => { throw new Error("hook"); };\nexport const useEffect = useCallback;\nexport const useMemo = useCallback;\n`);
  fs.writeFileSync(path.join(ndir, "worklets-stub.ts"), `export const scheduleOnUI = () => { throw new Error("scheduleOnUI"); };\nexport const scheduleOnRN = scheduleOnUI;\nexport const isWorkletFunction = () => false;\n`);
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(ndir, "entry.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(ndir, "bundle.mjs"),
    logLevel: "error",
    alias: {
      "react-native-reanimated": path.join(ROOT, "scripts", "skia", "reanimated-sim.ts"),
      react: path.join(ndir, "react-stub.ts"),
      "react-native-worklets": path.join(ndir, "worklets-stub.ts"),
      "@": path.join(ROOT, "src"),
    },
  });
  const nm = await import(pathToFileURL(path.join(ndir, "bundle.mjs")).href);
  const sim = await import("./skia/reanimated-sim.ts");
  const nkey = JSON.parse(native.files!["manifest.json"]).binds.find((b: { hold?: boolean }) => b.hold)?.sample ?? bx;
  // `late`: display frames whose cell is not their own (the ideal grid);
  // `vsWorklet`: frames where native picks another cell than the worklet
  // master clock would at that frame (useToolboxClock sums the same frame
  // deltas: time = (t_f − t_0) / 1000).
  const lateFrames = (clock: { fps: number; jitterMs?: number; seed?: number }) => {
    const series = sim.simulate(() => nm.clockAnimation(false), 0, 61, clock);
    let late = 0;
    let vsWorklet = 0;
    series.forEach((sec: number, fr: number) => {
      const cell = nm.sampleBinds(sec)[nkey];
      if (cell !== expect(fr)[0]) late++;
      if (cell !== tl.sampleBinds((sim.frameTime(clock, fr) - sim.frameTime(clock, 0)) / 1000)[bx]) vsWorklet++;
    });
    return { late, vsWorklet };
  };
  const steady = lateFrames({ fps: 60 });
  check("native mode, steady 60 Hz (Reanimated stand-in): every frame shows its own cell", steady.late === 0 && steady.vsWorklet === 0, JSON.stringify(steady));
  const j05 = lateFrames({ fps: 60, jitterMs: 0.05, seed: 1 });
  const j1 = lateFrames({ fps: 60, jitterMs: 1, seed: 1 });
  measured(
    `jittered vsync — ±0.05 ms: ${j05.late}/61 frames show the previous cell (native), ${j05.vsWorklet} differ from the worklet clock; ±1 ms: ${j1.late}/61, ${j1.vsWorklet} differ. Both clocks read time, so an early frame shows the cell for its clock time in either mode; nothing accumulates`
  );

  // Refusals.
  const un = fx.bakeGraph();
  const unwired = exportSkia({ nodes: un.nodes, edges: un.edges.filter((e) => !(e.target === "bk" && e.targetHandle === "in:image")), targetId: "skc", name: "Bake", canvas: CANVAS, timeline: TL, runtimeSource: RUNTIME });
  check("an unwired Skia Bake refuses the export, naming the Layer Input route", !unwired.files && unwired.problems.some((p) => p.includes('Skia Bake "bk"') && p.includes("Layer Input")), JSON.stringify(unwired.problems));
  const sceneAsShader: SkiaScene = {
    version: SKIA_IR_VERSION,
    width: W,
    height: W,
    root: { k: "fill", paint: { style: "fill", shader: { k: "image", asset: "bake_bk", fit: "fill", rect: [bindStatic(0), bindStatic(0), bindStatic(W), bindStatic(W)] } } },
    assets: { bake_bk: { id: "bake_bk", kind: "image", mime: "image/png", url: "bake:bk" } },
  };
  const asShader = bk.planSceneBakes(sceneAsShader, un.nodes, un.edges, CANVAS, TL);
  check("an animated bake used as a shader is refused (a sheet only steps as an image draw)", asShader.problems.some((p) => p.includes("only an image draw")), JSON.stringify(asShader.problems));
  const inTexture = bk.planSceneBakes(
    {
      ...sceneAsShader,
      root: { k: "atlas", asset: "tex", sprites: [[0, 0, W, W]], xforms: bindStatic([1, 0, 0, 0]), texture: { node: imageDraw("bake_bk", W, W), rect: [0, 0, W, W] } },
    },
    un.nodes,
    un.edges,
    CANVAS,
    TL
  );
  check("…and so is one inside a Copy to Points (Skia) sprite texture (rendered once)", inTexture.problems.some((p) => p.includes("sprite texture")), JSON.stringify(inTexture.problems));
  const notBake = bk.planSceneBakes({ ...sceneAsShader, assets: { bake_bk: { id: "bake_bk", kind: "image", mime: "image/png", url: "bake:ring" } } }, un.nodes, un.edges, CANVAS, TL);
  check("a bake: URL naming a non-bake node is refused", notBake.problems.some((p) => p.includes("not a Skia Bake")));

  // Worklet declaration order in the emitted modules (the TDZ trap, §2d).
  const order = (src: string): string[] => {
    const decl = /^(?:export )?(?:function (\w+)\(|const (\w+) = (?:\([^)]*\)(?:: [\w[\]<>]+)? =>|function))/gm;
    const found: { name: string; at: number }[] = [];
    for (let mm = decl.exec(src); mm; mm = decl.exec(src)) found.push({ name: mm[1] ?? mm[2], at: mm.index });
    const errs: string[] = [];
    found.forEach((d, i) => {
      const body = src.slice(d.at, found[i + 1]?.at ?? src.length);
      if (!/^\s*"worklet";/m.test(body.split("\n").slice(1, 3).join("\n"))) return;
      for (const later of found.slice(i + 1)) if (new RegExp(`\\b${later.name}\\(`).test(body)) errs.push(`${d.name} calls ${later.name}`);
    });
    return errs;
  };
  const tdz = [r, baked, native].flatMap((x) => ["timeline.ts", "ToolboxScene.tsx", "animations.ts"].flatMap((fl) => (x.files?.[fl] ? order(x.files[fl]) : [])));
  check("every worklet in the emitted modules calls only worklets declared above it", !tdz.length, tdz.join("; "));
}

// ---- 8. the asset seam ---------------------------------------------------------------------------
console.log("— the asset seam (editor.ts)");
{
  const ENV = { canvas: CANVAS, fps: 60, frames: 60 };
  // A fake engine: frame content is a function of the tick it renders at.
  const fakeFrame = (tick: number) => frame(W, W, 1 + Math.round(tick / 1000), false);
  const calls: number[][] = [];
  const renderer = (constant = false): import("@/lib/skia-export/bake").BakeFrameRenderer => async (b, ticks, size) => {
    calls.push(ticks);
    if (b.nodeId !== "bk" || b.source.node !== "blur" || size.width !== W) throw new Error(`unexpected render ${JSON.stringify([b, size])}`);
    return ticks.map((t) => (constant ? fakeFrame(0) : fakeFrame(t)));
  };
  const L = bakeInLayer();
  const r = await ed.exportSkiaFromEditor(L.nodes, L.edges, L.layer.id, { ...ENV, renderBakeFrames: renderer() });
  const files = r.result.files;
  const m = files ? JSON.parse(files["manifest.json"]) : null;
  check("a Skia layer with a bake exports from the editor, the sheet bundled", !!files && !!files["assets/bake_bk.png.b64"] && m.assets[0].bundled === true && m.assets[0].url === undefined && m.assets[0].bytes > 0, JSON.stringify(r.result.problems));
  const decoded = files ? await png.decodePng(new Uint8Array(Buffer.from(files["assets/bake_bk.png.b64"], "base64"))) : null;
  let cellsOk = !!decoded && decoded.width === 4030 && decoded.height === 260;
  const Ls = m ? { ...m.assets[0].sheet, sheetWidth: 4030, sheetHeight: 260, cap: 4096, scaled: false } : null;
  for (let k = 0; cellsOk && k < 61; k++) {
    const [cx, cy] = bk.cellOrigin(Ls, k);
    const want = fakeFrame(k * 1000);
    for (let y = 0; y < W && cellsOk; y += 17) for (let x = 0; x < W; x += 13) {
      const s = ((cy + y) * 4030 + cx + x) * 4;
      const o = (y * W + x) * 4;
      if (decoded!.rgba[s] !== want[o] || decoded!.rgba[s + 2] !== want[o + 2]) cellsOk = false;
    }
  }
  check("…every cell is the renderer's frame at the cell's tick", cellsOk);
  check("…rendered once, all 61 ticks ascending", calls.length === 1 && calls[0].length === 61 && calls[0].every((t, i) => t === i * 1000));
  check("…reported (sheet, 61 frames, 61 distinct)", r.bakes?.[0]?.shipped === "animated" && r.bakes[0].frames === 61 && r.bakes[0].distinct === 61);
  const zip = ed.skiaZipEntries(files!, "bake");
  check("the zip carries the PNG as binary", zip.some((e) => e.path === "bake/assets/bake_bk.png" && e.bytes && e.bytes[1] === 0x50));

  calls.length = 0;
  const late = bakeInLayer();
  late.layer.data.clips = [{ inTick: 30_000, outTick: 200_000, sourceInTick: 0, enabled: true }];
  await ed.exportSkiaFromEditor(late.nodes, late.edges, late.layer.id, { ...ENV, renderBakeFrames: renderer() });
  check("a layer that starts at frame 30 renders its bake at composition ticks 30 000 + local", calls[0]?.[0] === 30_000 && calls[0][60] === 90_000, JSON.stringify(calls[0]?.slice(0, 3)));

  calls.length = 0;
  const flat = await ed.exportSkiaFromEditor(L.nodes, L.edges, L.layer.id, { ...ENV, renderBakeFrames: renderer(true) });
  const fm = flat.result.files ? JSON.parse(flat.result.files["manifest.json"]) : null;
  check(
    "Auto: animated by the graph, but every rendered frame identical → re-exported as one PNG, said in a warning",
    !!fm && !fm.assets[0].sheet && fm.assets[0].width === W && flat.bakes?.[0]?.shipped === "static" && flat.bakes[0].requested === "auto" && flat.result.warnings.some((w) => w.includes("are all identical")),
    JSON.stringify([fm?.assets, flat.result.warnings])
  );
  check("…without rendering anything twice", calls.length === 1);
  calls.length = 0;
  const S = bakeInLayer({ animated: false });
  const moved = await ed.exportSkiaFromEditor(S.nodes, S.edges, S.layer.id, { ...ENV, renderBakeFrames: renderer() });
  const mm = moved.result.files ? JSON.parse(moved.result.files["manifest.json"]) : null;
  check(
    "Auto: still by the graph, but the sample frames move → re-exported as a sprite sheet",
    !!mm?.assets[0].sheet && moved.bakes?.[0]?.shipped === "animated" && moved.result.warnings.some((w) => w.includes("change over the timeline")),
    JSON.stringify(moved.result.warnings)
  );
  check("…the probe frames (5) are reused by the sheet (61 renders in all)", calls.flat().length === 61, JSON.stringify(calls.map((c) => c.length)));
  // The one URL → bytes seam (engine/skia/asset-bytes.ts, lane I).
  const viaSeam = await ab.resolveSkiaAssetBytes({ id: "bake_bk", kind: "image", mime: "image/png", url: "bake:bk" }).then(
    () => "resolved",
    (e: Error) => e.message
  );
  check("`bake:` is a registered scheme on the asset seam; without a frame renderer it fails with the reason", viaSeam.includes('Skia Bake "bk" renders with the engine at export'), viaSeam);
  const none = await ed.exportSkiaFromEditor(L.nodes, L.edges, L.layer.id, ENV);
  check(
    "no frame renderer: the bundle still exports, the missing PNG is a warning quoting that reason",
    !!none.result.files && !none.result.files["assets/bake_bk.png.b64"] && none.result.warnings.some((w) => w.includes('"bake_bk"') && w.includes("renders with the engine at export")),
    JSON.stringify(none.result.warnings)
  );
  const seen: string[] = [];
  const stand = await png.encodePng(new Uint8Array(4030 * 260 * 4).fill(200), 4030, 260);
  const viaResolve = await ed.exportSkiaFromEditor(L.nodes, L.edges, L.layer.id, {
    ...ENV,
    resolveAsset: async (asset) => {
      seen.push(asset.url);
      return asset.url === "bake:bk" ? stand : null;
    },
  });
  check(
    "…and a host's resolveAsset alone can answer `bake:` (the same seam): its bytes ship",
    seen.join() === "bake:bk" && viaResolve.result.files?.["assets/bake_bk.png.b64"] === Buffer.from(stand).toString("base64")
  );
  seen.length = 0;
  await ed.exportSkiaFromEditor(L.nodes, L.edges, L.layer.id, { ...ENV, renderBakeFrames: renderer(), resolveAsset: async (asset) => (seen.push(asset.url), null) });
  check("with a frame renderer, `bake:` never reaches resolveAsset (the bake resolver answers it first)", !seen.length, JSON.stringify(seen));
  const plan = await ed.planSkiaExportForEditor(L.nodes, L.edges, L.layer.id, ENV);
  check(
    "plan_skia_export (nothing rendered) lists the sheet layout in its manifest",
    plan.ok && (plan.manifest as { assets: { sheet?: { cols: number } }[] }).assets[0].sheet?.cols === 31,
    JSON.stringify(plan.problems)
  );
}

// ---- 9. the harness slot ----------------------------------------------------------------------------
console.log("— skia-harness/src/bundle-bake");
{
  const slot = path.join(ROOT, "skia-harness", "src", "bundle-bake");
  const pngFile = path.join(slot, "assets", "bake_bk.png");
  if (!fs.existsSync(pngFile)) {
    check("skia-harness/src/bundle-bake exists", false, "npx tsx scripts/export-skia.mts --fixture bake --out skia-harness/src/bundle-bake");
  } else {
    const f = fx.bakeGraph();
    const req = { nodes: f.nodes, edges: f.edges, targetId: "skc", name: "Bake", canvas: CANVAS, timeline: TL, runtimeSource: RUNTIME };
    const slotPng = new Uint8Array(fs.readFileSync(pngFile));
    // The code is deterministic without GL; the bytes are the slot's own
    // (handed to exportSkia as the pre-pass would, SkiaExportRequest.assets).
    const fresh = await ed.exportSkiaWithBakes(req, { renderBakeFrames: async () => [] });
    const bundled = exportSkia({ ...req, assets: { bytes: { "bake:bk": slotPng } } });
    const files = bundled.files ?? {};
    const stale = Object.keys(files)
      .filter((k) => !k.endsWith(".b64"))
      .filter((k) => !fs.existsSync(path.join(slot, k)) || fs.readFileSync(path.join(slot, k), "utf8") !== files[k]);
    check("every code file in the slot is today's export", !stale.length, `${stale.join(", ")} differ — npx tsx scripts/export-skia.mts --fixture bake --out skia-harness/src/bundle-bake`);
    const dec = await png.decodePng(slotPng);
    const sm = JSON.parse(files["manifest.json"]);
    check("the slot's sheet decodes to the manifest's size (opaque, 61 cells)", dec.width === sm.assets[0].width && dec.height === sm.assets[0].height && sm.assets[0].sheet.ticks.length === 61);
    measured(`slot sheet ${dec.width}×${dec.height}, ${slotPng.length} B PNG (${((slotPng.length / (dec.width * dec.height * 4)) * 100).toFixed(1)} % of raw)`);
    check("(a renderer that returns nothing fails the bake instead of shipping a hole)", !fresh.result.files && fresh.result.problems.some((x: string) => x.includes("could not render")), JSON.stringify(fresh.result.problems));
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);

