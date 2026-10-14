import type { NodeDefinition, RenderContext, SkiaDrawValue, SkiaShaderValue } from "@/engine/types";
import { canvasKit, canvasKitError, canvasKitReady, ensureCanvasKit } from "@/engine/skia/canvaskit";
import { constExpr, mirrorParams } from "@/engine/skia/library";
import { bindDegrees, WARP_DEG } from "@/engine/skia/library/helpers-warp";
import { registerSkslFunction } from "@/engine/skia/library/registry";
import { makeSceneAssetResolver, sceneAssetGeneration } from "@/engine/skia/scene-assets";
import {
  bindDerived,
  bindParam,
  bindStatic,
  SKIA_IR_VERSION,
  type AssetIR,
  type Bind,
  type BindRef,
  type SkiaNode,
  type SkiaScene,
} from "@/engine/skia/scene-ir";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import { renderScene } from "@/engine/skia/scene-render";
import { renderSkiaToImage, skiaGpuError } from "@/engine/skia/sksl-render";
import {
  imageFileAsset,
  imageFitParam,
  imageFitScale,
  imageTrsOf,
  rnImageFit,
  skiaImageSourceOf,
} from "@/lib/skia-export/image-asset";
import { imageSourceNode } from "../source/image-source";

// Image (Skia) — Image Source in a Skia layer (specdocs/101326_skia-target.md
// §3.2 `native`, Wave 3 lane I). Same `file`, `fit` and TRS params; three
// views of one picture:
//
//   primary  skia_draw   the React Native Skia <Image>: the file fitted to
//                        the canvas rect (cover / contain / stretch → RN's
//                        cover / contain / fill), inside two Groups that
//                        apply Image Source's TRS. Image Source inverts its
//                        TRS in per-axis uv space, so a rotation on a
//                        non-square canvas SHEARS; in canvas px that is
//                          T(P) · T(t) · diag(a, 1) · R(θ) · diag(sx / a, sy) · T(−P)
//                        (a = W / H), split as an outer Group (origin P,
//                        translate t, scale (a, 1)) and an inner Group
//                        (origin P, rotate θ, scale (sx / a, sy)). Every bind
//                        is one param × a constant, so keyframed TRS exports
//                        as exact tracks (BindRef.scale).
//   shader   skia_shader  the same picture as a fused-program input: FIT_FS
//                        line for line (tbx.image.fit@1 below) over an image
//                        LEAF — Skia's ImageShader of the file stretched over
//                        the canvas, clamp-tiled like the engine texture — so
//                        a wired Skia node samples exactly Image Source's
//                        pixels (bilinear in the file, hard edges where FIT_FS
//                        cuts), and exports as an <ImageShader> child.
//   preview  image       the drawing rendered by CanvasKit (for viewing, and
//                        for an SkSL Shader's iImage socket, which exports it
//                        as a bundled image).
//
// The file ships as an AssetIR (lib/skia-export/image-asset.ts): a blob: URL
// of the bitmap's original bytes, resolved through the asset seam
// (engine/skia/asset-bytes.ts) by the preview and by every export. EXR stills
// and a uv_in field have no React Native Skia form and are not mirrored.

const IMAGE_FIT_SKSL = `float4 tbx_image_fit(float2 uv, float2 res, float2 inv_scale, int letterbox,
                     float translateX, float translateY, float scaleX, float scaleY,
                     float rotate, float pivotX, float pivotY, float opacity) {
  // Image Source's FIT_FS: inverse TRS in output uv (screen → uv y-flip for
  // pivot and translate), the unit-square test, then the aspect fit.
  float2 pivot = float2(pivotX, 1.0 - pivotY);
  float2 translate = float2(translateX, -translateY);
  float2 p = (uv - translate) - pivot;
  p = tbx_warp_rotate(p, cos(rotate), sin(rotate));
  float2 sc = float2(abs(scaleX) < 0.0001 ? 0.0001 : scaleX, abs(scaleY) < 0.0001 ? 0.0001 : scaleY);
  float2 q = p / sc + pivot;
  if (tbx_warp_outside(q, float2(0.0), float2(1.0))) return float4(0.0);
  float2 samp = 0.5 + (q - 0.5) * inv_scale;
  if (letterbox != 0 && tbx_warp_outside(samp, float2(0.0), float2(1.0))) return float4(0.0);
  float4 c = $image(samp);
  // The evaluator's opacity convention: straight alpha × opacity (≤ 1).
  return float4(c.rgb, c.a * clamp(opacity, 0.0, 1.0));
}`;

export const TBX_IMAGE_FIT = registerImageFit();

function registerImageFit() {
  const fn = {
    id: "tbx.image.fit@1",
    entry: "tbx_image_fit",
    source: IMAGE_FIT_SKSL,
    params: [
      { name: "inv_scale", type: "float2" as const },
      { name: "letterbox", type: "int" as const },
      { name: "translateX", type: "float" as const },
      { name: "translateY", type: "float" as const },
      { name: "scaleX", type: "float" as const },
      { name: "scaleY", type: "float" as const },
      { name: "rotate", type: "float" as const },
      { name: "pivotX", type: "float" as const },
      { name: "pivotY", type: "float" as const },
      { name: "opacity", type: "float" as const },
    ],
    inputs: [{ name: "image", mode: "gather" as const, taps: 1 }],
    uses: ["tbx.warp.rotate", "tbx.warp.outside"],
    cost: 0.1,
  };
  registerSkslFunction(fn);
  return fn;
}

const PREVIEW = "preview";
const SHADER = "shader";
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// value = param × scale exactly as an exported scaled track evaluates it.
function scaled(params: Record<string, unknown>, nodeId: string, param: string, fallback: number, scale: number): Bind<number> {
  const ref: BindRef = scale === 1 ? { node: nodeId, param } : { node: nodeId, param, scale };
  return { v: num(params[param], fallback) * scale, ref };
}

// The asset id an Image (Skia) node ships its file under.
export function skiaImageAssetId(nodeId: string): string {
  return `image-${nodeId}`;
}

interface Built {
  draw: SkiaNode;
  expr: ShaderExpr;
  assets?: Record<string, AssetIR>;
  problems: string[];
}

function build(params: Record<string, unknown>, nodeId: string, W: number, H: number): Built {
  const id = skiaImageAssetId(nodeId);
  const a = imageFileAsset(id, params.file);
  if (a.kind !== "asset") {
    return {
      draw: { k: "group", id: nodeId, children: [] },
      expr: constExpr(nodeId, [0, 0, 0, 0]),
      problems: a.kind === "problem" ? [`Image (Skia) ${nodeId}: ${a.problem}.`] : [],
    };
  }
  const asset = a.asset;
  const fit = imageFitParam(params.fit);
  const aspect = W / H;
  const origin = (): [Bind<number>, Bind<number>] => [scaled(params, nodeId, "pivotX", 0.5, W), scaled(params, nodeId, "pivotY", 0.5, H)];
  const image: SkiaNode = {
    k: "image",
    id: nodeId,
    asset: id,
    x: bindStatic(0),
    y: bindStatic(0),
    w: bindStatic(W),
    h: bindStatic(H),
    fit: rnImageFit(fit),
  };
  const inner: SkiaNode = {
    k: "group",
    id: nodeId,
    transform: {
      rotate: bindDegrees(params, nodeId, "rotate"),
      scale: [scaled(params, nodeId, "scaleX", 1, 1 / aspect), bindParam(num(params.scaleY, 1), nodeId, "scaleY")],
      origin: origin(),
    },
    children: [image],
  };
  const draw: SkiaNode = {
    k: "group",
    id: nodeId,
    transform: {
      translate: [scaled(params, nodeId, "translateX", 0, W), scaled(params, nodeId, "translateY", 0, H)],
      scale: [bindStatic(aspect), bindStatic(1)],
      origin: origin(),
    },
    opacity: bindParam(num(params.opacity, 1), nodeId, "opacity"),
    children: [inner],
  };
  const fs = imageFitScale(fit, asset.width ?? 1, asset.height ?? 1, W, H);
  const fitDeps: BindRef[] = [{ node: nodeId, param: "fit" }];
  const p = imageTrsOf(params);
  const expr: ShaderExpr = {
    k: "call",
    fn: TBX_IMAGE_FIT.id,
    node: nodeId,
    params: {
      inv_scale: bindDerived(fs.invScale, fitDeps),
      letterbox: bindDerived(fs.letterbox, fitDeps),
      translateX: bindParam(p.translateX, nodeId, "translateX"),
      translateY: bindParam(p.translateY, nodeId, "translateY"),
      scaleX: bindParam(p.scaleX, nodeId, "scaleX"),
      scaleY: bindParam(p.scaleY, nodeId, "scaleY"),
      rotate: { v: p.rotate * WARP_DEG, ref: { node: nodeId, param: "rotate", scale: WARP_DEG } },
      pivotX: bindParam(p.pivotX, nodeId, "pivotX"),
      pivotY: bindParam(p.pivotY, nodeId, "pivotY"),
      opacity: bindParam(num(params.opacity, 1), nodeId, "opacity"),
    },
    inputs: {
      image: {
        k: "leaf",
        shader: { k: "image", asset: id, fit: "fill", rect: [bindStatic(0), bindStatic(0), bindStatic(W), bindStatic(H)], tile: "clamp" },
      },
    },
  };
  return { draw, expr, assets: { [id]: asset }, problems: [] };
}

// The drawing at opacity 1 (the evaluator fades image outputs by `opacity`).
function previewDraw(draw: SkiaNode): SkiaNode {
  return draw.k === "group" && draw.opacity ? { ...draw, opacity: { ...draw.opacity, v: 1 } } : draw;
}

function renderPreview(ctx: RenderContext, built: Built, problems: string[]) {
  const transparent = () => {
    const out = ctx.allocImage();
    ctx.clearTarget(out, [0, 0, 0, 0]);
    return out;
  };
  const kit = canvasKit();
  if (!kit) {
    const err = canvasKitError();
    if (err) problems.push(err);
    else void ensureCanvasKit().catch(() => {});
    return transparent();
  }
  const scene: SkiaScene = { version: SKIA_IR_VERSION, width: ctx.width, height: ctx.height, root: previewDraw(built.draw), assets: built.assets ?? {} };
  const out = renderSkiaToImage(ctx, kit, ctx.width, ctx.height, (canvas) => {
    const r = renderScene(kit, canvas, scene, { assets: makeSceneAssetResolver(kit) });
    problems.push(...r.problems);
    return r.release;
  });
  if (!out) problems.push(skiaGpuError() ?? "CanvasKit render failed");
  return out ?? transparent();
}

interface ImageState {
  warned?: string | null;
}

export const skiaImageNode: NodeDefinition = {
  type: "skia-image",
  name: "Image (Skia)",
  category: "image",
  subcategory: "generator",
  pickable: true,
  description:
    "Skia-layer Image Source: the same file, fit (cover / contain / stretch) and translate / scale / rotate / pivot, drawn as a React Native Skia <Image> and shipped in the export as a bundled asset. Wire the primary drawing into Skia Group / Skia Canvas; the `shader` output feeds the image into Skia shader nodes (fused as an ImageShader child, sampled exactly like Image Source); `preview` is the drawing as an image (an SkSL Shader's iImage input exports it as a bundled image too).",
  searchAliases: ["image", "picture", "photo", "bitmap", "png", "jpeg", "skia", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:translateX": "uv01",
      "param:translateY": "uv01",
      "param:pivotX": "uv01",
      "param:pivotY": "uv01",
    },
    gotchas: [
      "TRS is Image Source's: per-axis canvas fractions (Y-down) applied about the pivot after the fit, so a rotation on a non-square canvas shears exactly as Image Source does.",
      "The drawing's edges are anti-aliased by Skia where Image Source cuts hard (a rotated image differs in its 1-px edge band); the `shader` output keeps Image Source's hard edges.",
      "opacity fades the drawing (React Native Skia group opacity) and the shader's alpha; the preview image is faded by the evaluator like any image output.",
      "No EXR stills and no uv_in field: React Native Skia has no float image format or per-pixel warp for an <Image>.",
      "The export ships the bitmap's original file (PNG / JPEG / WebP / GIF) under assets/; a synthetic bitmap ships as its PNG re-encode.",
    ],
  },
  backend: "webgl2",
  supportsTransformGizmo: true,
  skia: { class: "native", mirrors: "image-source" },
  noMaskInput: true,
  gatesOutputs: true,
  inputs: [],
  params: mirrorParams(imageSourceNode, ["opacity", "file", "fit", "translateX", "translateY", "scaleX", "scaleY", "rotate", "pivotX", "pivotY"]),
  linkedPairs: [{ a: "scaleX", b: "scaleY" }],
  primaryOutput: "skia_draw",
  auxOutputs: [
    {
      name: SHADER,
      label: "Shader",
      type: "skia_shader",
      description:
        "The image as a Skia shader (Image Source's fit + TRS, fused into the consumer's runtime program over an ImageShader child) — wire it into Skia shader nodes.",
    },
    {
      name: PREVIEW,
      label: "Preview",
      type: "image",
      description: "The drawing rendered by CanvasKit at the canvas size, for viewing (an SkSL Shader's iImage input exports it as a bundled image).",
    },
  ],
  // CanvasKit readiness and the asset loader's generation: a preview
  // rendered before the WASM or the file landed is not served from cache.
  fingerprintExtras() {
    return `${canvasKitReady() ? "ck1" : "ck0"}|a:${sceneAssetGeneration()}`;
  },

  compute({ params, ctx, nodeId, consumedOutputs }) {
    const built = build(params, nodeId, ctx.width, ctx.height);
    const problems = [...built.problems];
    const primary: SkiaDrawValue = {
      kind: "skia_draw",
      node: built.draw,
      ...(built.assets ? { assets: built.assets } : {}),
      ...(problems.length ? { problems: [...problems] } : {}),
    };
    const aux: Record<string, SkiaShaderValue | ReturnType<RenderContext["allocImage"]>> = {};
    const wants = (name: string) => !consumedOutputs || consumedOutputs.has(`aux:${name}`);
    if (wants(SHADER)) {
      aux[SHADER] = {
        kind: "skia_shader",
        expr: built.expr,
        ...(built.assets ? { assets: built.assets } : {}),
        ...(problems.length ? { problems: [...problems] } : {}),
      };
    }
    // Data-only evaluations (the exporter, Node gates: no readback, no GL)
    // never render.
    if (wants(PREVIEW) && typeof ctx.readImagePixels === "function") {
      const img = renderPreview(ctx, built, problems);
      // An SkSL Shader sampling this preview reads the file through Skia, as
      // its export does (ImageValue.skiaSource).
      const tag = built.assets && !(num(params.opacity, 1) < 1) ? skiaImageSourceOf(skiaImageAssetId(nodeId), params, false) : null;
      if (tag && "source" in tag) img.skiaSource = tag.source;
      aux[PREVIEW] = img;
    }
    const state = (ctx.state[`skia-image:${nodeId}`] ??= {}) as ImageState;
    const msg = problems.length ? problems.join(" ") : null;
    if (msg && state.warned !== msg) console.warn(`[Image (Skia) ${nodeId}] ${msg}`);
    state.warned = msg;
    return { primary, aux };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`skia-image:${nodeId}`];
  },
};
