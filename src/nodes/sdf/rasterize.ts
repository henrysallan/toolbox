import type { NodeDefinition, SdfValue } from "@/engine/types";
import {
  bindSdfUniforms,
  compileSdf,
  structuralHash,
} from "@/engine/sdf-compile";

// Sample an SDF at every pixel and produce an image. Walks the SDF
// tree once, builds a single fragment shader, and does one fullscreen
// pass — so a chain of N SDF ops upstream costs one shader compile +
// one draw call total. The shader is cached by the tree's structural
// hash, so animating params (radius, position, smoothness) re-uses
// the compiled program; only re-topologies trigger a recompile.
//
// `softness` is the anti-aliasing window in pixels (smoothstep across
// the zero-crossing). `contour_width` adds a contour line on the
// boundary. `aspect_correct` rescales the SDF coordinate space so a
// circle stays circular on a non-square canvas.

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

export const sdfRasterizeNode: NodeDefinition = {
  type: "sdf-rasterize",
  name: "SDF Rasterize",
  category: "utility",
  description:
    "Sample an SDF at every pixel and produce an image. Foreground / Background colors fill inside / outside; Contour adds an outline at the zero-crossing. One shader compile + one draw call total per topology.",
  backend: "webgl2",
  inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
  params: [
    {
      name: "foreground",
      label: "Foreground",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "fg_alpha",
      label: "FG Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "background",
      label: "Background",
      type: "color",
      default: "#000000",
    },
    {
      name: "bg_alpha",
      label: "BG Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "contour",
      label: "Contour",
      type: "color",
      default: "#000000",
    },
    {
      name: "contour_alpha",
      label: "Contour Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "contour_width",
      label: "Contour Width (px)",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 8,
      step: 0.1,
      default: 0,
    },
    {
      name: "softness",
      label: "Softness (px)",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 4,
      step: 0.1,
      default: 1,
    },
    {
      name: "aspect_correct",
      label: "Aspect Correct",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const sdf = inputs.sdf;
    if (!sdf || sdf.kind !== "sdf") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const sdfVal = sdf as SdfValue;

    const compiled = compileSdf(sdfVal.root, "rasterize");
    const cacheKey = `sdf-rasterize/${structuralHash(sdfVal.root)}`;
    const prog = ctx.getShader(cacheKey, compiled.source);

    const [fr, fg, fb] = hexToRgb((params.foreground as string) ?? "#ffffff");
    const [br, bg, bb] = hexToRgb((params.background as string) ?? "#000000");
    const [cr, cg, cb] = hexToRgb((params.contour as string) ?? "#000000");
    const fgAlpha = (params.fg_alpha as number) ?? 1;
    const bgAlpha = (params.bg_alpha as number) ?? 1;
    const contourAlpha = (params.contour_alpha as number) ?? 0;
    const contourWidth = Math.max(0, (params.contour_width as number) ?? 0);
    const softness = Math.max(0, (params.softness as number) ?? 1);
    const aspectCorrect = (params.aspect_correct as boolean) ?? true;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform3f(gl.getUniformLocation(prog, "u_fg"), fr, fg, fb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_bg"), br, bg, bb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_contour"), cr, cg, cb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_fgAlpha"), fgAlpha);
      gl.uniform1f(gl.getUniformLocation(prog, "u_bgAlpha"), bgAlpha);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_contourAlpha"),
        contourAlpha
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_contourWidth"),
        contourWidth
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_softness"), softness);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_canvasSize"),
        output.width,
        output.height
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_aspectCorrect"),
        aspectCorrect ? 1 : 0
      );

      // Colour-bleed radius. Nothing authors one yet, and 0 means every
      // material weight is 1 — the accumulator is inert until the
      // shading terminal reads it.
      const bleedLoc = gl.getUniformLocation(prog, "u_bleedInv");
      if (bleedLoc) gl.uniform1f(bleedLoc, 0);

      bindSdfUniforms(gl, prog, compiled.uniforms);
    });

    return { primary: output };
  },
};
