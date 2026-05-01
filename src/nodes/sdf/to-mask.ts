import type { NodeDefinition, SdfValue } from "@/engine/types";
import { compileSdf, structuralHash } from "@/engine/sdf-compile";

// Render an SDF as a binary (or feathered) mask at the chosen iso-
// level. Default threshold = 0 produces the canonical "inside vs
// outside" mask. Positive thresholds shrink the mask inward; negative
// thresholds inflate it outward (same idea as Round, but at output
// time only — doesn't change the SDF tree).
//
// Output is an image (RGB + alpha all carry the same mask value), so
// any image- or mask-consuming node downstream can take it as input —
// Filter Points (mask mode), Reaction-Diffusion seed, Merge layer,
// etc.

export const sdfToMaskNode: NodeDefinition = {
  type: "sdf-to-mask",
  name: "SDF to Mask",
  category: "utility",
  description:
    "Render an SDF as a binary mask at the chosen iso-level (default 0 = the boundary). Softness feathers the edge in pixels. Invert flips inside ↔ outside. Output is an image suitable for any mask/image consumer.",
  backend: "webgl2",
  inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0,
    },
    {
      name: "softness",
      label: "Softness (px)",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 4,
      step: 0.1,
      default: 1,
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
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

    const compiled = compileSdf(sdfVal.root, "mask");
    const cacheKey = `sdf-mask/${structuralHash(sdfVal.root)}`;
    const prog = ctx.getShader(cacheKey, compiled.source);

    const threshold = (params.threshold as number) ?? 0;
    const softness = Math.max(0, (params.softness as number) ?? 1);
    const invert = (params.invert as boolean) ?? false;
    const aspectCorrect = (params.aspect_correct as boolean) ?? true;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
      gl.uniform1f(gl.getUniformLocation(prog, "u_softness"), softness);
      gl.uniform1f(gl.getUniformLocation(prog, "u_invert"), invert ? 1 : 0);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_canvasSize"),
        output.width,
        output.height
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_aspectCorrect"),
        aspectCorrect ? 1 : 0
      );

      let samplerUnit = 0;
      for (const u of compiled.uniforms) {
        const loc = gl.getUniformLocation(prog, u.name);
        if (!loc) continue;
        if (u.type === "float") {
          gl.uniform1f(loc, u.value as number);
        } else if (u.type === "vec2") {
          const v = u.value as [number, number];
          gl.uniform2f(loc, v[0], v[1]);
        } else {
          gl.activeTexture(gl.TEXTURE0 + samplerUnit);
          gl.bindTexture(gl.TEXTURE_2D, u.value as WebGLTexture);
          gl.uniform1i(loc, samplerUnit);
          samplerUnit++;
        }
      }
    });

    return { primary: output };
  },
};
