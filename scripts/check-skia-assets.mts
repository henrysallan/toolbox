/* eslint-disable @typescript-eslint/no-explicit-any */
// check-skia-assets — images + assets for React Native Skia exports
// (specdocs/101326_skia-target.md §3.8 items 2–3, Wave 3 lane I).
//
//   1. the URL → bytes seam (engine/skia/asset-bytes.ts): data:, blob:, a
//      registered scheme (what lane B's `bake:` does), failures with reasons
//   2. Image (Skia): its IR (drawing, shader leaf, asset), and THREE
//      formulations of Image Source's mapping agreeing in CanvasKit — the
//      drawing's Group nest, the shader's FIT_FS port (tbx.image.fit@1) and
//      the SkSL Shader export's ImageShader matrix (imageLocalMatrix) — plus
//      the Group algebra against an independent fitRects
//   3. a Skia Canvas export with an image draw, an image leaf fused into a
//      program and Geist text: bytes present, licence text, manifest
//      (size + bundled), assets.ts, the zip's binary entries, missing-asset
//      warnings naming the node, every animation mode, harness type-check
//   4. the SkSL Shader: iImage1 from a static Image Source + ramp / curve
//      LUT children — plan, bytes, images.ts's imageMatrix ≡ the preview's
//      bit for bit, luts.ts ≡ the preview's LUT bytes, refusals, harness
//      type-check in every mode
//   5. the LUT accessors in CanvasKit: texel-centre exact on sRGB, ≤ 1/255
//      on Display P3 (colour-managed)
//   6. the editor + MCP paths (async exportSkiaFromEditor with a custom
//      resolveAsset, planSkiaExportForEditor, export_skia's base64 entries)
//   7. the CLI writes the same bundle, and skia-harness/src/bundle-image is
//      today's export
//
// Pixel parity with the GL Image Source is compare:skia's job
// (`--a image:<pair>n --b image:<pair>d|s`); the device-side web parity is
// `npm run parity:skia -- --bundle image`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Edge } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { AssetIR, ShaderIR, SkiaNode, SkiaScene } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The editor modules (mcp-handlers, graph-ops) touch a few DOM globals on load.
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
const ab = await import("@/engine/skia/asset-bytes");
const { renderScene, transformMatrix } = await import("@/engine/skia/scene-render");
const { buildSkslProgram, compileSksl, skslLutBytes, packUniforms } = await import("@/engine/skia/sksl-program");
const { syncChannelInputs, readChannelValue } = await import("@/engine/expr-channels");
const { makeSceneSampler } = await import("@/lib/skia-export/scene-sample");
const { exportSkia, planSkiaExport, exportSkiaWithAssets, collectSkiaExportAssets, resolveSkiaExportAssets } = await import("@/lib/skia-export");
const ia = await import("@/lib/skia-export/image-asset");
const ed = await import("@/lib/skia-export/editor");
const { makeInstanceNode, refreshNodeSockets, newEdgeId } = await import("@/state/graph-ops");
const { buildMcpHandlers } = await import("@/components/effects/mcp-handlers");
const { nodeResolveAsset } = await import("./skia/node-assets.ts");
const { typecheckBundle } = await import("./skia/export-check.ts");
const fxi = await import("./fixtures/skia/image-graph.ts");
const { AURORA_MARKERS } = await import("./fixtures/skia/aurora-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();
const RUNTIME = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}
const eqBytes = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const b64bytes = (s: string | undefined) => (s === undefined ? null : new Uint8Array(Buffer.from(s, "base64")));

const PNG = fxi.imageFixturePng();
const PIXELS = fxi.imageFixturePixels();
const BMP = fxi.imageFixtureStandIn(PNG);
const GEIST = new Uint8Array(fs.readFileSync(path.join(ROOT, "public/fonts/Geist-Regular.ttf")));
const GEIST_OFL = fs.readFileSync(path.join(ROOT, "public/fonts/Geist-OFL.txt"), "utf8");
const TL = { ...fxi.IMAGE_TIMELINE, markers: AURORA_MARKERS };
const W = fxi.IMAGE_CANVAS[0];
const H = fxi.IMAGE_CANVAS[1];

// ---- 1. the seam ------------------------------------------------------------------------------
{
  check("data: base64 decodes in place", eqBytes(ab.dataUrlBytes("data:image/png;base64,AQID"), new Uint8Array([1, 2, 3])));
  check("data: percent-encoded decodes", new TextDecoder().decode(ab.dataUrlBytes("data:text/plain,a%20b%C3%A9")!) === "a bé");
  const big = new Uint8Array(70_001).map((_, i) => (i * 131 + 7) & 0xff);
  check("base64 round trip across the 32 KiB chunks", eqBytes(ab.base64ToBytes(ab.bytesToBase64(big)), big));
  const realFetch = g.fetch;
  g.fetch = () => {
    throw new Error("no network in this check");
  };
  const viaData = await ab.resolveSkiaAssetBytes({ id: "d", kind: "image", mime: "image/png", url: `data:image/png;base64,${ab.bytesToBase64(PNG)}` });
  g.fetch = realFetch;
  check("resolveSkiaAssetBytes: a data: URL never fetches", eqBytes(viaData, PNG));
  const blobUrl = URL.createObjectURL(new Blob([PNG as BlobPart], { type: "image/png" }));
  check("resolveSkiaAssetBytes: a blob: URL fetches the file", eqBytes(await ab.resolveSkiaAssetBytes({ id: "b", kind: "image", mime: "image/png", url: blobUrl }), PNG));
  let seen: AssetIR | null = null;
  const off = ab.registerSkiaAssetScheme("bake", async (a) => {
    seen = a;
    return new Uint8Array([9, 8, 7]);
  });
  const baked = await ab.resolveSkiaAssetBytes({ id: "bk", kind: "image", mime: "image/png", url: "bake:node-7" });
  check("a registered scheme resolves its URLs (lane B's bake:<nodeId>)", eqBytes(baked, new Uint8Array([9, 8, 7])) && (seen as AssetIR | null)?.url === "bake:node-7");
  off();
  let err = "";
  try {
    await ab.resolveSkiaAssetBytes({ id: "bk", kind: "image", mime: "image/png", url: "bake:node-7" });
  } catch (e) {
    err = (e as Error).message;
  }
  check("…and unregistering it hands the URL back to fetch (which throws, with a reason)", err.length > 0, err);
  const failing = await resolveSkiaExportAssets(
    [{ asset: { id: "x", kind: "image", mime: "image/png", url: "https://media.example.com/x.png" }, owners: [`skia-image "x"`] }],
    async () => {
      throw new Error("HTTP 404 Not Found");
    }
  );
  check("resolveSkiaExportAssets never throws: a failure lands in `failed` with its reason", failing.failed?.["https://media.example.com/x.png"] === "HTTP 404 Not Found" && !Object.keys(failing.bytes).length);
}

// ---- CanvasKit helpers -------------------------------------------------------------------------
const PNG_IMAGE = CK.MakeImageFromEncoded(PNG);
{
  const px = new Uint8Array(PNG_IMAGE.readPixels(0, 0, { width: fxi.IMAGE_W, height: fxi.IMAGE_H, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array);
  check("the fixture PNG (pure-JS encoder) decodes to its pixels exactly", eqBytes(px, PIXELS));
}
const sceneAssets = (_id: string, kind: "image" | "font") => (kind === "font" ? GEIST : PNG_IMAGE);
const BASE = CK.MakeSurface(1, 1);
function surface(w: number, h: number, cs: any = CK.ColorSpace.SRGB, f32 = false) {
  const s = BASE.makeSurface({ width: w, height: h, colorType: f32 ? CK.ColorType.RGBA_F32 : CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: cs });
  if (!s) throw new Error("no surface");
  return s;
}
function read8(img: any, cs: any = CK.ColorSpace.SRGB): Uint8Array {
  return new Uint8Array(img.readPixels(0, 0, { width: img.width(), height: img.height(), colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: cs }) as Uint8Array);
}
function drawScene(scene: SkiaScene): { px: Uint8Array; problems: string[] } {
  const s = surface(scene.width, scene.height);
  const c = s.getCanvas();
  c.clear(CK.TRANSPARENT);
  const r = renderScene(CK, c, scene, { assets: sceneAssets });
  s.flush();
  const img = s.makeImageSnapshot();
  const px = read8(img);
  r.release();
  img.delete();
  s.delete();
  return { px, problems: [...r.problems, ...r.pending.map((p) => `pending ${p}`)] };
}
// The SkSL Shader export's mapping: an ImageShader of the file with
// imageLocalMatrix, filling the canvas.
function drawExportMapping(src: any, w: number, h: number): Uint8Array {
  const s = surface(w, h);
  const c = s.getCanvas();
  c.clear(CK.TRANSPARENT);
  const tile = src.tile === "decal" ? CK.TileMode.Decal : CK.TileMode.Clamp;
  const sh = PNG_IMAGE.makeShaderOptions(tile, tile, CK.FilterMode.Linear, CK.MipmapMode.None, ia.imageLocalMatrix(ia.mappingOf(src), w, h));
  const p = new CK.Paint();
  p.setShader(sh);
  c.drawPaint(p);
  s.flush();
  const img = s.makeImageSnapshot();
  const px = read8(img);
  p.delete();
  sh.delete();
  img.delete();
  s.delete();
  return px;
}
// Max premultiplied channel difference over pixels opaque in both images
// with an opaque 5×5 neighbourhood (the interior; edges anti-alias / fade
// differently by design), plus the share of pixels compared.
function interiorDiff(a: Uint8Array, b: Uint8Array, w: number, h: number): { max: number; share: number; edgeMax: number } {
  let max = 0;
  let edgeMax = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let interior = true;
      for (let dy = -2; dy <= 2 && interior; dy++) {
        for (let dx = -2; dx <= 2 && interior; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const k = (yy * w + xx) * 4 + 3;
          if (a[k] !== 255 || b[k] !== 255) interior = false;
        }
      }
      const i = (y * w + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
      if (interior) {
        n++;
        max = Math.max(max, d);
      } else edgeMax = Math.max(edgeMax, d);
    }
  }
  return { max, share: n / (w * h), edgeMax };
}

// ---- 2. Image (Skia) ----------------------------------------------------------------------------
const cmp = fxi.imageCompareGraph(BMP);
const sceneAt = (canvasId: string, nodes: GraphNode[] = cmp.nodes, edges: GraphEdge[] = cmp.edges, size: [number, number] = [W, H]): SkiaScene | null => {
  const s = makeSceneSampler(nodes, edges, canvasId, { width: size[0], height: size[1] }, TL);
  return "problem" in s ? null : s.sampleAt(0);
};

// An independent fit (React Native's fitRects + rect2rect: crop the source
// to the destination's aspect, or letterbox it) as a 3×3 matrix.
function rnFitMatrix(fit: string, iw: number, ih: number, w: number, h: number): number[] {
  let src = { x: 0, y: 0, w: iw, h: ih };
  let dst = { x: 0, y: 0, w, h };
  if (fit === "cover") {
    const sa = w / h;
    if (iw / ih > sa) src = { x: (iw - ih * sa) / 2, y: 0, w: ih * sa, h: ih };
    else src = { x: 0, y: (ih - iw / sa) / 2, w: iw, h: iw / sa };
  } else if (fit === "contain") {
    const s = Math.min(w / iw, h / ih);
    dst = { x: (w - iw * s) / 2, y: (h - ih * s) / 2, w: iw * s, h: ih * s };
  }
  const sx = dst.w / src.w;
  const sy = dst.h / src.h;
  return [sx, 0, dst.x - src.x * sx, 0, sy, dst.y - src.y * sy, 0, 0, 1];
}
const mul = (a: number[], b: number[]) => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// The groups from a drawing's root down to its Image, and the Image.
function groupChain(root: SkiaNode | undefined): { groups: Extract<SkiaNode, { k: "group" }>[]; image?: Extract<SkiaNode, { k: "image" }> } {
  const groups: Extract<SkiaNode, { k: "group" }>[] = [];
  let n: SkiaNode | undefined = root;
  while (n?.k === "group") {
    groups.push(n);
    n = n.children[0];
  }
  return { groups, image: n?.k === "image" ? n : undefined };
}

{
  // Aspect-rigid (101526_aspect-rigid-rotation.md): the default nest.
  const scene = sceneAt("trsd");
  const { groups, image } = groupChain(scene?.root);
  const [outer, mid, shift] = groups;
  const asset = scene?.assets["image-trsi"];
  const o = (H - W) / 2;
  check(
    "drawing: Group (opacity, translate (0, (H − W) / 2)) → Group (translate, rotate, scale, origin) → Group (translate (0, −(H − W) / 2)) → Image over the canvas rect",
    groups.length === 3 && !!outer.opacity && outer.transform?.translate?.[1].v === o && !outer.transform?.translate?.[1].ref && !!mid.transform?.rotate && shift.transform?.translate?.[1].v === -o && image?.k === "image" && image.fit === "fill" && image.w.v === W && image.h.v === H
  );
  check(
    "every TRS bind is one param × a constant (exact tracks): translate × W, pivot × W, rotate × π/180, scale × 1",
    mid?.transform?.translate?.[0].ref?.scale === W &&
      mid?.transform?.translate?.[1].ref?.scale === W &&
      mid?.transform?.origin?.[0].ref?.param === "pivotX" &&
      mid?.transform?.origin?.[1].ref?.scale === W &&
      mid?.transform?.rotate?.ref?.scale === Math.PI / 180 &&
      mid?.transform?.scale?.[0].ref?.param === "scaleX" &&
      mid?.transform?.scale?.[0].ref?.scale === undefined
  );
  // legacySkew keeps the per-axis (shearing) split.
  const legacyNodes: GraphNode[] = [
    { id: "li", type: "skia-image", params: { opacity: 1, file: BMP, ...fxi.IMAGE_PAIRS.trs, legacySkew: true } },
    { id: "ld", type: "skia-canvas", params: {} },
  ];
  const legacyEdges: GraphEdge[] = [{ id: "e", source: "li", sourceHandle: "out:primary", target: "ld", targetHandle: "in:scene" }];
  const legacy = groupChain(sceneAt("ld", legacyNodes, legacyEdges)?.root);
  const [lo, li] = legacy.groups;
  check(
    "legacySkew drawing: Group (opacity, translate, scale (a, 1), origin) → Group (rotate, scale (sx / a, sy), origin) → Image; translate × W/H, scaleX × 1/a",
    legacy.groups.length === 2 &&
      !!lo.opacity &&
      lo.transform?.translate?.[0].ref?.scale === W &&
      lo.transform?.translate?.[1].ref?.scale === H &&
      li.transform?.origin?.[0].ref?.param === "pivotX" &&
      li.transform?.rotate?.ref?.scale === Math.PI / 180 &&
      li.transform?.scale?.[0].ref?.scale === 1 / (W / H) &&
      legacy.image?.k === "image"
  );
  check(
    "the asset: the bitmap's original PNG as a blob: URL, 96×64, one per node",
    asset?.kind === "image" && asset.mime === "image/png" && asset.url.startsWith("blob:") && asset.width === 96 && asset.height === 64 && image?.asset === "image-trsi"
  );
  check("the blob: URL resolves to the original file", eqBytes(await ab.resolveSkiaAssetBytes(asset!), PNG));
  const sh = sceneAt("trss");
  const fill = sh?.root as Extract<SkiaNode, { k: "fill" }> | undefined;
  const prog = fill?.paint.shader?.k === "runtime" ? fill.paint.shader.program : null;
  const leaf = prog?.children[0]?.shader as Extract<ShaderIR, { k: "image" }> | undefined;
  check(
    "shader output: tbx.image.fit@1 fused over an image LEAF (clamp-tiled ImageShader child), its asset carried to the Fill's drawing",
    !!prog && prog.fused?.includes("tbx.image.fit@1") === true && leaf?.k === "image" && leaf.tile === "clamp" && leaf.fit === "fill" && !!sh?.assets["image-trsi"]
  );

  // Group algebra: outer · inner · fit ≡ imageLocalMatrix, on several canvases.
  let worst = 0;
  let cases = 0;
  const extra = { fit: "contain", translateX: -0.2, translateY: 0.11, scaleX: 1.6, scaleY: 0.4, rotate: 137, pivotX: 0.1, pivotY: 0.9 };
  const rigidCases = [fxi.IMAGE_PAIRS.trs, fxi.IMAGE_PAIRS.contain, fxi.IMAGE_PAIRS.cvtrs, extra];
  const trsCases: Record<string, unknown>[] = [...rigidCases, ...rigidCases.map((c) => ({ ...c, legacySkew: true }))];
  for (const size of [[320, 180], [180, 320], [256, 256]] as [number, number][]) {
    for (const p of trsCases) {
      const nodes: GraphNode[] = [
        { id: "ai", type: "skia-image", params: { opacity: 1, file: BMP, ...p } },
        { id: "ad", type: "skia-canvas", params: {} },
      ];
      const edges: GraphEdge[] = [{ id: "e", source: "ai", sourceHandle: "out:primary", target: "ad", targetHandle: "in:scene" }];
      const s = sceneAt("ad", nodes, edges, size);
      const chain = groupChain(s?.root);
      const m = mul(chain.groups.reduce((acc, g) => mul(acc, transformMatrix(g.transform) ?? I3), I3), rnFitMatrix(chain.image!.fit, 96, 64, size[0], size[1]));
      const fit = ia.rnImageFit(ia.imageFitParam(p.fit));
      const want = ia.imageLocalMatrix({ width: 96, height: 64, fit, ...ia.imageTrsOf(p as any), ...(p.legacySkew ? { legacySkew: true } : {}) }, size[0], size[1]);
      for (let i = 0; i < 9; i++) worst = Math.max(worst, Math.abs(m[i] - want[i]) / Math.max(1, Math.abs(want[i])));
      cases++;
    }
  }
  check(`the drawing's Group nest composes to imageLocalMatrix (${cases} cases, 3 canvas shapes): worst rel ${worst.toExponential(1)}`, worst < 1e-12);

  // Pixels: the three formulations agree inside the image.
  const rows: string[] = [];
  let worstInterior = 0;
  for (const pair of Object.keys(fxi.IMAGE_PAIRS)) {
    const d = drawScene(sceneAt(`${pair}d`)!);
    const s = drawScene(sceneAt(`${pair}s`)!);
    const ds = interiorDiff(d.px, s.px, W, H);
    worstInterior = Math.max(worstInterior, ds.max);
    let row = `${pair}: drawing vs shader interior max ${ds.max}/255 over ${(ds.share * 100).toFixed(0)}% (edges ${ds.edgeMax}/255)`;
    const src = ia.skiaImageSourceOf("x", { file: BMP, ...fxi.IMAGE_PAIRS[pair] });
    if ("source" in src) {
      const e = drawExportMapping(src.source, W, H);
      const de = interiorDiff(d.px, e, W, H);
      const se = interiorDiff(s.px, e, W, H);
      worstInterior = Math.max(worstInterior, de.max, se.max);
      row += `; drawing vs the export's ImageShader ${de.max}/255 (edges ${de.edgeMax}/255); shader vs ImageShader ${se.max}/255 (edges ${se.edgeMax}/255)`;
    } else row += "; ImageShader export refused (cover + transform)";
    rows.push(row);
    if (d.problems.length || s.problems.length) rows.push(`  problems: ${[...d.problems, ...s.problems].join(" | ")}`);
  }
  for (const r of rows) info(r);
  // (The cover drawing goes through drawImageRect's strict source subset —
  // the crop — which Skia samples through its own subset matrix: 2/255.)
  check("Image Source's mapping three ways (Group nest, FIT_FS port, ImageShader matrix) agree inside the image ≤ 2/255 in CanvasKit", worstInterior <= 2, rows.join("; "));
  check("…and the cover + transform case refuses the ImageShader export with the reason", "problem" in ia.skiaImageSourceOf("x", { file: BMP, ...fxi.IMAGE_PAIRS.cvtrs }));

  // Problems.
  const one = (file: unknown) => {
    const nodes: GraphNode[] = [
      { id: "pi", type: "skia-image", params: { opacity: 1, file } },
      { id: "pc", type: "skia-canvas", params: {} },
    ];
    const s = makeSceneSampler(nodes, [{ id: "e", source: "pi", sourceHandle: "out:primary", target: "pc", targetHandle: "in:scene" }], "pc", { width: 64, height: 64 }, TL);
    if ("problem" in s) return { scene: null, problems: [s.problem] };
    return { scene: s.sampleAt(0), problems: s.producerProblems() };
  };
  const empty = one(null);
  check("no file: an empty group, no asset, no problem", (empty.scene?.root as any)?.children?.length === 0 && !Object.keys(empty.scene?.assets ?? {}).length && !empty.problems.length);
  const exr = one({ kind: "exr", blob: new Blob([]), filename: "a.exr", layers: [] });
  check("an EXR still is a problem naming why", exr.problems.some((p) => p.includes("EXR")), exr.problems.join(" | "));
  const junk = one({ width: 4, height: 4 });
  check("a file with no decodable bytes is a problem", junk.problems.some((p) => p.includes("not a decoded image")), junk.problems.join(" | "));
}

// ---- 3. a Skia Canvas export with assets ------------------------------------------------------------
const sceneGraph = (): { nodes: GraphNode[]; edges: GraphEdge[] } => ({
  nodes: [
    { id: "img", type: "skia-image", params: { opacity: 1, file: BMP, ...fxi.IMAGE_PAIRS.trs } },
    { id: "cc", type: "skia-color-correction", params: { hue: 25, saturation: 1.35 } },
    { id: "fill", type: "skia-fill", params: { color: "#000000", opacity: 1 } },
    { id: "txt", type: "skia-text", params: { text: "assets", font_family: "Geist", font_size: 32 } },
    { id: "grp", type: "skia-group", params: {} },
    { id: "cv", type: "skia-canvas", params: { background_on: false } },
  ],
  edges: [
    { id: "e1", source: "img", sourceHandle: "out:aux:shader", target: "cc", targetHandle: "in:image" },
    { id: "e2", source: "cc", sourceHandle: "out:primary", target: "fill", targetHandle: "in:shader" },
    { id: "e3", source: "fill", sourceHandle: "out:primary", target: "grp", targetHandle: "in:child1" },
    { id: "e4", source: "img", sourceHandle: "out:primary", target: "grp", targetHandle: "in:child2" },
    { id: "e5", source: "txt", sourceHandle: "out:primary", target: "grp", targetHandle: "in:child3" },
    { id: "e6", source: "grp", sourceHandle: "out:primary", target: "cv", targetHandle: "in:scene" },
  ],
});
const sceneReq = (animation?: "worklet" | "baked" | "native") => ({
  ...sceneGraph(),
  targetId: "cv",
  name: "Assets scene",
  canvas: { width: W, height: H },
  timeline: TL,
  runtimeSource: RUNTIME,
  ...(animation ? { animation } : {}),
});
{
  const uses = collectSkiaExportAssets(sceneReq());
  check(
    "collectSkiaExportAssets finds the image (drawn and fused) and the font, with their nodes",
    uses.length === 2 &&
      uses.some((u) => u.asset.id === "image-img" && u.owners.includes(`skia-image "img"`) && u.owners.includes(`skia-fill "fill"`)) &&
      uses.some((u) => u.asset.id === "geist" && u.owners.includes(`skia-text "txt"`)),
    JSON.stringify(uses.map((u) => [u.asset.id, u.owners]))
  );
  const r = await exportSkiaWithAssets(sceneReq(), nodeResolveAsset());
  const files = r.files ?? {};
  const manifest = files["manifest.json"] ? JSON.parse(files["manifest.json"]) : {};
  const ma = (id: string) => manifest.assets?.find((a: any) => a.id === id);
  check("exports with no problems and no asset warnings", !!r.files && !r.problems.length && !r.warnings.some((w) => w.startsWith("Asset ")), [...r.problems, ...r.warnings].join(" | "));
  check("the image's bytes are in the bundle (assets/image-img.png, base64 in `files`)", eqBytes(b64bytes(files["assets/image-img.png.b64"]), PNG));
  check("the Geist font's bytes are in the bundle", eqBytes(b64bytes(files["assets/geist.ttf.b64"]), GEIST));
  check("…with its OFL licence text beside it", files["assets/Geist-OFL.txt"] === GEIST_OFL);
  check(
    "manifest: every asset with its file, size and bundled flag (and the licence file)",
    ma("image-img")?.bundled === true &&
      ma("image-img")?.bytes === PNG.length &&
      ma("image-img")?.file === "assets/image-img.png" &&
      ma("image-img")?.width === 96 &&
      ma("geist")?.bundled === true &&
      ma("geist")?.bytes === GEIST.length &&
      ma("geist")?.license === "assets/Geist-OFL.txt",
    JSON.stringify(manifest.assets)
  );
  check(
    "assets.ts requires each bundled file",
    files["assets.ts"]?.includes(`"image-img": require("./assets/image-img.png"),`) && files["assets.ts"]?.includes(`"geist": require("./assets/geist.ttf"),`)
  );
  const tsx = files["ToolboxScene.tsx"] ?? "";
  check(
    "the component draws the image (useImage → <Image>) and feeds the fused program an <ImageShader> child",
    tsx.includes(`useImage(ASSET_SOURCES["image-img"])`) && /<Image\b/.test(tsx) && /<Shader[^>]*>\s*<ImageShader/.test(tsx)
  );
  // The zip: binary entries, decoded.
  const entries = ed.skiaZipEntries(files, "assets-scene");
  const pngEntry = entries.find((e) => e.path === "assets-scene/assets/image-img.png");
  const ttfEntry = entries.find((e) => e.path === "assets-scene/assets/geist.ttf");
  const licEntry = entries.find((e) => e.path === "assets-scene/assets/Geist-OFL.txt");
  check("zip entries: assets as binary (no .b64), the licence as text", eqBytes(pngEntry?.bytes, PNG) && eqBytes(ttfEntry?.bytes, GEIST) && licEntry?.text === GEIST_OFL && !entries.some((e) => e.path.endsWith(".b64")));
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await ed.buildSkiaZip(entries, "uint8array"));
  check("…and a real zip holds the same bytes", eqBytes(await zip.file("assets-scene/assets/image-img.png")?.async("uint8array"), PNG) && eqBytes(await zip.file("assets-scene/assets/geist.ttf")?.async("uint8array"), GEIST));
  const tc = typecheckBundle(files, "skia-assets-scene");
  check(`the bundle type-checks in skia-harness${tc.ran ? "" : " (skipped)"}`, tc.ok, tc.output);

  // No bytes: the synchronous exportSkia alone.
  const bare = exportSkia(sceneReq());
  const bm = bare.files ? JSON.parse(bare.files["manifest.json"]) : {};
  check(
    "without resolved bytes: one warning per asset naming the nodes that draw it",
    !!bare.files &&
      bare.warnings.some((w) => w.startsWith(`Asset "image-img"`) && w.includes(`skia-image "img"`) && w.includes("not bundled")) &&
      bare.warnings.some((w) => w.startsWith(`Asset "geist"`) && w.includes(`skia-text "txt"`)) &&
      bare.warnings.some((w) => w.startsWith("The licence of asset \"geist\"")),
    bare.warnings.join(" | ")
  );
  check(
    "…the manifest lists them unbundled with their editor URLs, assets.ts maps them to null (useImage / useFont accept it)",
    bm.assets?.every((a: any) => a.bundled === false && typeof a.url === "string") && bare.files?.["assets.ts"]?.includes(`"image-img": null,`) && !Object.keys(bare.files ?? {}).some((f) => f.endsWith(".b64"))
  );
  const tcBare = typecheckBundle(bare.files ?? {}, "skia-assets-bare");
  check(`…and still type-checks${tcBare.ran ? "" : " (skipped)"}`, tcBare.ok, tcBare.output);
  // A resolver that fails: the reason is in the warning.
  const half = await exportSkiaWithAssets(sceneReq(), async (a) => {
    if (a.kind === "image") throw new Error("HTTP 404 Not Found");
    return nodeResolveAsset()(a);
  });
  check(
    "a failing asset is a warning quoting the reason; the others still bundle",
    !!half.files && half.warnings.some((w) => w.includes(`"image-img"`) && w.includes("HTTP 404 Not Found") && w.includes(`skia-image "img"`)) && eqBytes(b64bytes(half.files["assets/geist.ttf.b64"]), GEIST),
    half.warnings.join(" | ")
  );
  // Every animation mode carries the assets.
  for (const mode of ["baked", "native"] as const) {
    const m = await exportSkiaWithAssets(sceneReq(mode), nodeResolveAsset());
    const t = m.files ? typecheckBundle(m.files, `skia-assets-scene-${mode}`) : { ran: false, ok: false, output: m.problems.join(" | ") };
    check(`animation "${mode}": the scene bundle ships the asset bytes and type-checks${t.ran ? "" : " (type-check skipped)"}`, !!m.files && eqBytes(b64bytes(m.files["assets/image-img.png.b64"]), PNG) && t.ok, t.output || m.problems.join(" | "));
  }
}

// ---- 4. the SkSL Shader: iImage1 + LUT children ------------------------------------------------------
const effectReq = (g = fxi.imageEffectGraph(BMP), animation?: "worklet" | "baked" | "native") => ({
  ...g,
  name: "Image tint",
  canvas: { width: 512, height: 512 },
  timeline: TL,
  runtimeSource: RUNTIME,
  ...(animation ? { animation } : {}),
});
{
  const g = fxi.imageEffectGraph(BMP);
  const { plan, problems } = planSkiaExport(g.nodes, g.edges, g.targetId, { name: "x", canvas: { width: 512, height: 512 }, timeline: TL });
  const declared = [...(plan?.sksl ?? "").matchAll(/\buniform\s+shader\s+(\w+)\s*;/g)].map((m) => m[1]);
  check("plans with no problems", !!plan, problems.join(" | "));
  check(
    "children in the program's `uniform shader` order: iImage1 (image), then the ramp and curve LUTs",
    JSON.stringify(plan?.children?.map((c) => [c.name, c.kind])) === JSON.stringify([["iImage1", "image"], ["tbx_lut_ink", "lut"], ["tbx_lut_lift", "lut"]]) &&
      JSON.stringify(declared) === JSON.stringify(["iImage1", "tbx_lut_ink", "tbx_lut_lift"]),
    `${JSON.stringify(plan?.children?.map((c) => c.name))} vs ${JSON.stringify(declared)}`
  );
  const tint = g.nodes.find((n) => n.id === "tint")!;
  const ch = (name: string) => (tint.params.inputs as any[]).find((e) => e.name === name);
  const lut = (name: string) => plan?.children?.find((c) => c.kind === "lut" && c.lut.channel === name) as any;
  check(
    "LUT children hold exactly the preview's bytes (skslLutBytes of the channel row)",
    eqBytes(Uint8Array.from(lut("ink")?.lut.rgba ?? []), skslLutBytes("ramp", readChannelValue(ch("ink"), undefined))) &&
      eqBytes(Uint8Array.from(lut("lift")?.lut.rgba ?? []), skslLutBytes("curve", readChannelValue(ch("lift"), undefined)))
  );
  check("the ramp / curve channels are not uniforms; the keyframed scalar is a track", !!plan && !plan.uniforms.some((u) => u.name === "ink" || u.name === "lift") && !!plan.uniforms.find((u) => u.name === "mixk")?.track);

  const r = await exportSkiaWithAssets(effectReq(), nodeResolveAsset());
  const files = r.files ?? {};
  const manifest = files["manifest.json"] ? JSON.parse(files["manifest.json"]) : {};
  check("exports clean", !!r.files && !r.problems.length && !r.warnings.length, [...r.problems, ...r.warnings].join(" | "));
  check("the image file ships at assets/iImage1.png", eqBytes(b64bytes(files["assets/iImage1.png.b64"]), PNG) && files["assets.ts"]?.includes(`"iImage1": require("./assets/iImage1.png"),`));
  check(
    "manifest: the children (image / lut / lut) and the asset with its size",
    JSON.stringify(manifest.children?.map((c: any) => c.kind)) === JSON.stringify(["image", "lut", "lut"]) && manifest.assets?.[0]?.bundled === true && manifest.assets?.[0]?.bytes === PNG.length,
    JSON.stringify(manifest.children)
  );
  const comp = files["ToolboxEffect.tsx"] ?? "";
  check(
    "the component: useImage of the asset, an <ImageShader matrix> child (a transparent <ColorShader> while it loads), then the LUT <ImageShader>s",
    comp.includes("useImage(ASSET_SOURCES.iImage1)") &&
      comp.includes(`<ImageShader image={IMG_iImage1} tx="decal" ty="decal" matrix={M_iImage1} /> : <ColorShader color="transparent" />`) &&
      comp.indexOf("LUT_ink") < comp.indexOf("LUT_lift") &&
      comp.indexOf("IMG_iImage1 ?") < comp.indexOf("image={LUT_ink}")
  );
  // images.ts runs in Node: its imageMatrix is the preview's, bit for bit.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skia-assets-"));
  let bitExact = true;
  let compared = 0;
  try {
    fs.writeFileSync(path.join(tmp, "images.ts"), files["images.ts"]);
    const emitted = await import(pathToFileURL(path.join(tmp, "images.ts")).href);
    const child = plan!.children!.find((c) => c.kind === "image") as any;
    for (const [w, h] of [[512, 512], [390, 844], [1170 / 3, 2532 / 3], [320, 180], [1, 1]]) {
      for (const tweak of [{}, { rotate: -71.3, pivotX: 0.13 }, { rotate: -71.3, pivotY: 0.2, translateY: 0.1, legacySkew: true }, { fit: "contain" as const, scaleX: 2.5 }, { fit: "cover" as const, rotate: 0, translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 }]) {
        const m = { ...ia.mappingOf(child.source), ...tweak };
        const a = emitted.imageMatrix(m, w, h) as number[];
        const b = ia.imageLocalMatrix(m, w, h);
        compared++;
        if (a.some((x, i) => !Object.is(x, b[i]))) bitExact = false;
      }
    }
    check(`images.ts's imageMatrix ≡ the preview's imageLocalMatrix bit for bit (${compared} sizes × mappings)`, bitExact);
    check("images.ts ships IMAGE_MATRIX_SOURCE verbatim", files["images.ts"].includes(ia.IMAGE_MATRIX_SOURCE));
    const m = /LUT_ink = makeLut\("([^"]+)"\)/.exec(files["luts.ts"] ?? "");
    const m2 = /LUT_lift = makeLut\("([^"]+)"\)/.exec(files["luts.ts"] ?? "");
    check("luts.ts builds each LUT image from the preview's exact bytes", !!m && !!m2 && eqBytes(b64bytes(m[1]), Uint8Array.from(lut("ink").lut.rgba)) && eqBytes(b64bytes(m2[1]), Uint8Array.from(lut("lift").lut.rgba)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const mode of ["worklet", "baked", "native"] as const) {
    const m = await exportSkiaWithAssets(effectReq(undefined, mode), nodeResolveAsset());
    const t = m.files ? typecheckBundle(m.files, `skia-assets-effect-${mode}`) : { ran: false, ok: false, output: m.problems.join(" | ") };
    const kids = m.files?.["ToolboxEffect.tsx"]?.includes("<ImageShader image={LUT_lift}") && m.files?.["assets/iImage1.png.b64"];
    check(`animation "${mode}": the SkSL Shader bundle ships its children and type-checks${t.ran ? "" : " (type-check skipped)"}`, !!m.files && !!kids && t.ok, t.output || m.problems.join(" | "));
  }

  // Image (Skia)'s preview is a static image too.
  const viaSkia = fxi.imageEffectGraph(BMP);
  viaSkia.nodes[0] = { ...viaSkia.nodes[0], type: "skia-image" };
  viaSkia.edges[0] = { ...viaSkia.edges[0], sourceHandle: "out:aux:preview" };
  const ps = planSkiaExport(viaSkia.nodes, viaSkia.edges, "tint", { name: "x", canvas: { width: 512, height: 512 }, timeline: TL });
  check("Image (Skia)'s preview into iImage1 exports as the same image child", ps.plan?.children?.[0]?.kind === "image", ps.problems.join(" | "));

  // Refusals, each with its reason.
  const refuse = (what: string, mut: (n: GraphNode[], e: GraphEdge[]) => void, needle: string) => {
    const gg = fxi.imageEffectGraph(BMP);
    mut(gg.nodes, gg.edges);
    const p = planSkiaExport(gg.nodes, gg.edges, "tint", { name: "x", canvas: { width: 512, height: 512 }, timeline: TL });
    check(`refuses ${what}`, !p.plan && p.problems.some((x) => x.includes(needle)), p.problems.join(" | "));
  };
  const photo = (n: GraphNode[]) => n.find((x) => x.id === "photo")!;
  refuse("a keyframed image (it animates)", (n) => {
    photo(n).animation = { translateX: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 0, easingOut: "linear" }, { tick: 9000, value: 0.2, easingOut: "linear" }] } } as any;
  }, "translateX is keyframed");
  refuse("a faded image (an ImageShader has no opacity)", (n) => {
    photo(n).params = { ...photo(n).params, opacity: 0.5 };
  }, "opacity 0.5");
  refuse("a transformed cover image (the crop can't be clipped)", (n) => {
    photo(n).params = { ...photo(n).params, fit: "cover" };
  }, "covers the canvas and is transformed");
  refuse("an EXR still", (n) => {
    photo(n).params = { ...photo(n).params, file: { kind: "exr", blob: new Blob([]), filename: "a.exr", layers: [] } };
  }, "EXR");
  refuse("an image computed by another node (Noise)", (n, e) => {
    n.push({ id: "nz", type: "noise", params: {} });
    e[0] = { ...e[0], source: "nz" };
  }, "only a static image exports");
  refuse("an image with a wired param", (n, e) => {
    n.push({ id: "k", type: "constant", params: { value: 0.1 } });
    e.push({ id: "w", source: "k", sourceHandle: "out:primary", target: "photo", targetHandle: "in:param:translateX" });
  }, "translateX is wired");
  refuse("a wired ramp channel", (n, e) => {
    const t = n.find((x) => x.id === "tint")!;
    const row = (t.params.inputs as any[]).find((x) => x.name === "ink");
    n.push({ id: "cr", type: "color-ramp", params: {} });
    e.push({ id: "w", source: "cr", sourceHandle: "out:primary", target: "tint", targetHandle: `in:in:${row.id}` });
  }, `ramp channel "ink" is wired`);
  {
    const gg = fxi.imageEffectGraph(BMP);
    const p = planSkiaExport(gg.nodes, [], "tint", { name: "x", canvas: { width: 512, height: 512 }, timeline: TL });
    const r2 = p.plan ? exportSkia({ ...effectReq({ ...gg, edges: [] }) }) : null;
    check(
      "a sampled but unwired iImage1 ships a transparent <ColorShader> child, with a warning",
      p.plan?.children?.[0]?.kind === "empty" && p.plan.warnings.some((w) => w.includes("samples iImage1 but nothing is wired")) && !!r2?.files?.["ToolboxEffect.tsx"]?.includes(`<ColorShader color="transparent" />{/* iImage1: unwired */}`),
      p.problems.join(" | ")
    );
  }
  {
    const bare = exportSkia(effectReq());
    check(
      "without resolved bytes the image child warns, naming the Image Source, and the component passes a transparent child",
      !!bare.files && bare.warnings.some((w) => w.startsWith(`Asset "iImage1"`) && w.includes(`image-source "photo"`)) && bare.files["ToolboxEffect.tsx"].includes("its image was not bundled"),
      bare.warnings.join(" | ")
    );
  }
}

// ---- 5. LUT accessors in CanvasKit ----------------------------------------------------------------------
{
  const src = `// ramp("ink", "#000000", "#ff8000", "#ffffff")
// ramp("glass", "#ff0000", "#0040ff")
// curve("lift", 0, 0.2, 1)
half4 main(float2 p) {
  float t = floor(p.x) / 255.0;
  if (p.y < 1.0) { float4 c = ink(t); return half4(float4(c.rgb * c.a, c.a)); }
  if (p.y < 2.0) { float4 c = glass(t); return half4(float4(c.rgb * c.a, c.a)); }
  float v = lift(t);
  return half4(float4(v, v, v, 1.0));
}`;
  const inputs = syncChannelInputs([], src);
  // A translucent ramp: alpha 1 → 0.25 across.
  const glassRow = inputs.find((e) => e.name === "glass")!;
  glassRow.default = (glassRow.default as any[]).map((s: any, i: number) => ({ ...s, alpha: i ? 0.25 : 1 }));
  const prog = buildSkslProgram({ expression: src, inputs });
  const c = compileSksl(CK, prog.sksl);
  check("a program with ramp + curve channels compiles (LUT children + accessors)", !!c.effect && prog.luts.length === 3, c.error ?? "");
  if (c.effect) {
    const luts = prog.luts.map((l) => skslLutBytes(l.kind, readChannelValue(inputs.find((e) => e.name === l.name)!, undefined)));
    const render = (cs: any, f32: boolean) => {
      const s = surface(256, 3, cs, f32);
      const imgs = luts.map((b) => CK.MakeImage({ width: 256, height: 1, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, b, 1024));
      const kids = imgs.map((im: any) => im.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Linear, CK.MipmapMode.None));
      const sh = c.effect!.makeShaderWithChildren(packUniforms(c.effect!, { iResolution: [256, 3, 1], iTime: 0 }), kids);
      const paint = new CK.Paint();
      paint.setShader(sh);
      paint.setBlendMode(CK.BlendMode.Src);
      s.getCanvas().drawPaint(paint);
      s.flush();
      const img = s.makeImageSnapshot();
      const px = read8(img, CK.ColorSpace.SRGB);
      for (const k of kids) k.delete();
      for (const im of imgs) im.delete();
      sh.delete();
      paint.delete();
      img.delete();
      s.delete();
      return px;
    };
    const sr = render(CK.ColorSpace.SRGB, false);
    let rampErr = 0;
    let glassErr = 0;
    let curveErr = 0;
    for (let k = 0; k < 256; k++) {
      for (let ch = 0; ch < 3; ch++) {
        rampErr = Math.max(rampErr, Math.abs(sr[k * 4 + ch] - luts[0][k * 4 + ch]));
        const a = luts[1][k * 4 + 3] / 255;
        glassErr = Math.max(glassErr, Math.abs(sr[(256 + k) * 4 + ch] - Math.round(luts[1][k * 4 + ch] * a)));
        curveErr = Math.max(curveErr, Math.abs(sr[(512 + k) * 4 + ch] - luts[2][k * 4]));
      }
      glassErr = Math.max(glassErr, Math.abs(sr[(256 + k) * 4 + 3] - luts[1][k * 4 + 3]));
    }
    check(`ramp(t) at t = k/255 reads LUT entry k exactly on sRGB (texel centres): opaque ${rampErr}/255, translucent ${glassErr}/255 (premultiplied rounding), curve ${curveErr}/255`, rampErr === 0 && glassErr <= 1 && curveErr === 0);
    const p3 = render(CK.ColorSpace.DISPLAY_P3, true);
    let p3Err = 0;
    for (let i = 0; i < sr.length; i++) p3Err = Math.max(p3Err, Math.abs(p3[i] - sr[i]));
    check(`…and the same on a Display P3 F32 surface read back as sRGB, ≤ 1/255 (LUT samples colour-managed): ${p3Err}/255`, p3Err <= 1);
  }
}

// ---- 6. the editor + MCP paths ----------------------------------------------------------------------------
{
  const g = fxi.imageEffectGraph(BMP);
  const mk = (n: GraphNode) => {
    const e = makeInstanceNode(n.type, { x: 0, y: 0 });
    e.id = n.id;
    e.data.params = { ...e.data.params, ...n.params };
    if (n.animation) e.data.animation = n.animation as any;
    return refreshNodeSockets(e);
  };
  const nodes = g.nodes.map(mk);
  const edges: Edge[] = g.edges.map((e) => ({ id: newEdgeId(), source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle }));
  const asked: string[] = [];
  const env = {
    canvas: { width: 512, height: 512 },
    fps: 60,
    frames: 300,
    markers: AURORA_MARKERS,
    resolveAsset: async (a: AssetIR) => {
      asked.push(`${a.id}|${a.url.slice(0, 5)}`);
      return ab.resolveSkiaAssetBytes(a);
    },
  };
  const { result } = await ed.exportSkiaFromEditor(nodes, edges, "tint", env);
  check(
    "exportSkiaFromEditor (async) resolves every asset through env.resolveAsset and bundles the bytes",
    asked.length === 1 && asked[0] === "iImage1|blob:" && eqBytes(b64bytes(result.files?.["assets/iImage1.png.b64"]), PNG),
    `${asked.join(",")} ${result.problems.join(" | ")}`
  );
  const plan = await ed.planSkiaExportForEditor(nodes, edges, "tint", env);
  check(
    "planSkiaExportForEditor lists the children, the image marked bundled",
    plan.ok && JSON.stringify(plan.children?.map((c) => c.kind)) === JSON.stringify(["image", "lut", "lut"]) && plan.children?.[0].bundled === true,
    JSON.stringify(plan.children)
  );
  const h = buildMcpHandlers({
    status: { projectName: "gate", canvasWidth: 512, canvasHeight: 512, fps: 60, frame: 0, playing: false, loopFrames: 300, selectedNodeId: "tint", scope: "root", scopeType: "root", parentScope: null },
    nodesRef: { current: nodes },
    edgesRef: { current: edges },
    flashToast: () => {},
  } as any);
  const exp = await (h as any).export_skia({ target: "tint" }).catch((e: Error) => ({ error: e.message }));
  check(
    "MCP export_skia returns the image as a base64 `.b64` entry (default resolver: blob: fetch)",
    exp?.ok === true && typeof exp.files?.["assets/iImage1.png.b64"] === "string" && eqBytes(b64bytes(exp.files["assets/iImage1.png.b64"]), PNG) && String(exp.note).includes(".b64"),
    exp?.error ?? Object.keys(exp?.files ?? {}).join(",")
  );
  const mplan = await (h as any).plan_skia_export({ target: "tint" }).catch((e: Error) => ({ error: e.message }));
  check("MCP plan_skia_export lists the children", mplan?.ok === true && mplan.children?.length === 3, mplan?.error ?? "");
}

// ---- 7. the CLI and the harness slot ---------------------------------------------------------------------
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "skia-assets-cli-"));
  try {
    const tsxBin = path.join(ROOT, "node_modules/.bin/tsx");
    execFileSync(tsxBin, ["scripts/export-skia.mts", "--fixture", "image", "--out", out], { cwd: ROOT, stdio: "pipe" });
    const want = (await exportSkiaWithAssets(effectReq(), nodeResolveAsset())).files ?? {};
    const bad = Object.entries(want).find(([f, text]) =>
      f.endsWith(".b64") ? !fs.readFileSync(path.join(out, f.slice(0, -4))).equals(Buffer.from(text, "base64")) : fs.readFileSync(path.join(out, f), "utf8") !== text
    );
    check("export-skia --fixture image writes exportSkiaWithAssets's bundle (assets decoded to binary)", !bad, bad?.[0]);
    const slot = path.join(ROOT, "skia-harness/src/bundle-image");
    const list = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? list(path.join(dir, d.name)).map((f) => `${d.name}/${f}`) : [d.name]));
    const mine = list(out).sort();
    const committed = fs.existsSync(slot) ? list(slot).sort() : [];
    const stale = mine.length !== committed.length || mine.some((f, i) => f !== committed[i] || !fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(slot, f))));
    check("skia-harness/src/bundle-image is today's export (re-run export-skia.mts --fixture image)", !stale, `${committed.length} committed vs ${mine.length} fresh files`);
  } catch (e) {
    check("export-skia CLI runs", false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 400));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-skia-assets: all checks passed.");
