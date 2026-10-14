// Editor preview of a fused shader: a ShaderIR → engine image, through the
// SkSL Shader node's render path (sksl-render.ts renderSkslToImage), so a
// `skia-*` node's preview is CanvasKit running the program that ships.
//
// Children: a `runtime` child is rendered first (recursively) into an engine
// image of the same size and handed to the parent as an image child, which
// the parent samples 1:1 in pixels; a `color` child is a cleared image. Both
// cross into Skia through renderSkslToImage's 8-bit readback, as M0's wired
// images do. A tree with an image or gradient child anywhere (Wave 3 lane I:
// Image (Skia)'s shader leaf) renders whole through the scene renderer
// instead — one <Fill> of the shader, the children real Skia shaders, the
// images loaded through the asset loader (scene-assets.ts) — which is what
// the Skia Canvas and the export draw.

import type { CanvasKit } from "canvaskit-wasm";
import type { ImageValue, RenderContext } from "../../types";
import { SKIA_IR_VERSION, type AssetIR, type ShaderIR, type SkiaScene, type SkslProgramIR } from "../scene-ir";
import { makeSceneAssetResolver } from "../scene-assets";
import { renderScene } from "../scene-render";
import { compileSksl, packUniforms, type SkslUniformValues } from "../sksl-program";
import { renderSkiaToImage, renderSkslToImage, skiaGpuError } from "../sksl-render";

export interface ShaderPreview {
  image: ImageValue | null;
  problems: string[];
}

export function uniformValuesOf(program: SkslProgramIR): SkslUniformValues {
  const out: SkslUniformValues = {};
  for (const [name, bind] of Object.entries(program.uniforms)) out[name] = bind.v;
  return out;
}

// Does the tree hold a child only the scene renderer draws (image, gradient)?
function needsSceneRenderer(shader: ShaderIR | undefined, depth = 0): boolean {
  if (!shader || depth > 16) return false;
  if (shader.k === "color") return false;
  if (shader.k !== "runtime") return true;
  return (shader.program?.children ?? []).some((c) => needsSceneRenderer(c?.shader, depth + 1));
}

// The shader as one Skia <Fill> (default paint: opaque black, whose RGB the
// shader replaces) through the scene renderer.
function renderViaScene(
  ctx: RenderContext,
  kit: CanvasKit,
  shader: ShaderIR,
  width: number,
  height: number,
  assets: Record<string, AssetIR>
): ShaderPreview {
  const scene: SkiaScene = { version: SKIA_IR_VERSION, width, height, root: { k: "fill", paint: { style: "fill", shader } }, assets };
  let problems: string[] = [];
  const image = renderSkiaToImage(ctx, kit, width, height, (canvas) => {
    const r = renderScene(kit, canvas, scene, { assets: makeSceneAssetResolver(kit) });
    problems = r.problems;
    return r.release;
  });
  if (!image) problems.push(skiaGpuError() ?? "CanvasKit render failed");
  return { image, problems };
}

// `assets` (additive, Wave 3 lane I): the images the tree's leaves sample.
export function renderShaderPreview(
  ctx: RenderContext,
  kit: CanvasKit,
  shader: ShaderIR,
  width: number,
  height: number,
  depth = 0,
  assets?: Record<string, AssetIR>
): ShaderPreview {
  if (depth > 8) return { image: null, problems: ["shader preview nests deeper than 8 programs"] };
  if (depth === 0 && needsSceneRenderer(shader)) return renderViaScene(ctx, kit, shader, width, height, assets ?? {});
  switch (shader.k) {
    case "color": {
      const out = ctx.allocImage({ width, height });
      const [r, g, b, a] = shader.color.v;
      ctx.clearTarget(out, [r, g, b, a]);
      return { image: out, problems: [] };
    }
    case "runtime":
      return renderProgram(ctx, kit, shader.program, width, height, depth);
    default:
      return {
        image: null,
        problems: [`previewing a "${shader.k}" child shader needs the Skia scene renderer; it previews as transparent`],
      };
  }
}

function renderProgram(
  ctx: RenderContext,
  kit: CanvasKit,
  program: SkslProgramIR,
  width: number,
  height: number,
  depth: number
): ShaderPreview {
  const compiled = compileSksl(kit, program.sksl);
  if (!compiled.effect) return { image: null, problems: [`SkSL compile failed: ${compiled.error}`] };
  const problems: string[] = [];
  const kids: (ImageValue | undefined)[] = [];
  for (const c of program.children) {
    const r = renderShaderPreview(ctx, kit, c.shader, width, height, depth + 1);
    problems.push(...r.problems);
    kids.push(r.image ?? undefined);
  }
  const uniforms = packUniforms(compiled.effect, uniformValuesOf(program));
  const image = renderSkslToImage(ctx, kit, compiled.effect, uniforms, kids, width, height);
  for (const k of kids) if (k) ctx.releaseTexture(k.texture);
  if (!image) problems.push(skiaGpuError() ?? "CanvasKit render failed");
  return { image, problems };
}
