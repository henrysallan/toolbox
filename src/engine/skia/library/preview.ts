// Editor preview of a fused shader: a ShaderIR → engine image, through the
// SkSL Shader node's render path (sksl-render.ts renderSkslToImage), so a
// `skia-*` node's preview is CanvasKit running the program that ships.
//
// Children: a `runtime` child is rendered first (recursively) into an engine
// image of the same size and handed to the parent as an image child, which
// the parent samples 1:1 in pixels; a `color` child is a cleared image. Both
// cross into Skia through renderSkslToImage's 8-bit readback, as M0's wired
// images do. Gradient and asset children need the scene renderer
// (scene-render.ts, lane L1) and preview as transparent with a problem.

import type { CanvasKit } from "canvaskit-wasm";
import type { ImageValue, RenderContext } from "../../types";
import type { ShaderIR, SkslProgramIR } from "../scene-ir";
import { compileSksl, packUniforms, type SkslUniformValues } from "../sksl-program";
import { renderSkslToImage, skiaGpuError } from "../sksl-render";

export interface ShaderPreview {
  image: ImageValue | null;
  problems: string[];
}

export function uniformValuesOf(program: SkslProgramIR): SkslUniformValues {
  const out: SkslUniformValues = {};
  for (const [name, bind] of Object.entries(program.uniforms)) out[name] = bind.v;
  return out;
}

export function renderShaderPreview(
  ctx: RenderContext,
  kit: CanvasKit,
  shader: ShaderIR,
  width: number,
  height: number,
  depth = 0
): ShaderPreview {
  if (depth > 8) return { image: null, problems: ["shader preview nests deeper than 8 programs"] };
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
