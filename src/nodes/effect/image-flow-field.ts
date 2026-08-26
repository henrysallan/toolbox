import type { NodeDefinition } from "@/engine/types";
import {
  computeOrientationField,
  ORIENTATION_NEUTRAL,
} from "@/engine/orientation-field";

// Image Flow Field — the structure-tensor orientation-field producer
// (spec 082426_orientation-field.md). Estimates per-pixel edge
// orientation + anisotropy from an image and emits it as an encoded
// orientation field (velocity-field RG tangent + coherence in B), the
// shared steering input for the painterly program (Flow Blur, Kuwahara,
// shock, FDoG, stroke placement) — and, via the RG channels, a valid
// velocity field for Advect Image/Points and Displace.
//
// All real work lives in engine/orientation-field.ts's
// computeOrientationField (shared with consumers whose optional `field`
// input is unwired); this node is the explicit, cache-once,
// fan-out-to-many-consumers form of it.
//
// M2 (deliberately absent here): a `method` enum adding Kang's ETF —
// additive param, default `tensor`, no migration needed.
//
// `noMaskInput`: the universal mask post-pass on this node would BLEND
// source pixels into the encoded field (there's a base image input),
// which corrupts the encoding even harder than the documented
// "never matte a field" caveat. Mask the consumer's output instead.

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const COHERENCE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = vec4(vec3(texture(u_src, v_uv).b), 1.0);
}`;

export const imageFlowFieldNode: NodeDefinition = {
  type: "image-flow-field",
  name: "Image Flow Field",
  category: "image",
  subcategory: "modifier",
  description:
    "Estimate the flow of an image: per-pixel edge orientation (smoothed structure tensor) encoded as a field image — tangent direction in RG (velocity-field convention, so Advect Image/Points and Displace consume it directly) and anisotropy/coherence in B (0 = flat region, 1 = strong directed edge). The steering input for painterly nodes (Flow Blur, and the rest of the program as it lands): compute the field once, drive many consumers. `Pre-blur` gates pixel noise out of the gradient; `Smooth` sets the tensor-blur scale — larger values give longer, more coherent stroke directions. The `coherence` aux exposes B as a mask for driving anything (scatter density, thresholds…). Visualize the field by wiring it plus a noise image into Flow Blur. Don't matte or mask a field image — matte the consumer's output.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "source", type: "image", required: true }],
  params: [
    {
      name: "pre_blur",
      label: "Pre-blur",
      type: "scalar",
      min: 0,
      max: 8,
      softMax: 4,
      step: 0.1,
      default: 1,
    },
    {
      name: "smooth",
      label: "Smooth",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 16,
      step: 0.5,
      default: 4,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [{ name: "coherence", type: "mask" }],

  compute({ inputs, params, ctx }) {
    const source = inputs.source;
    const coherence = ctx.allocMask();

    if (!source || source.kind !== "image") {
      const field = ctx.allocImage();
      ctx.clearTarget(field, ORIENTATION_NEUTRAL);
      ctx.clearTarget(coherence, [0, 0, 0, 1]);
      return { primary: field, aux: { coherence } };
    }

    const field = computeOrientationField(ctx, source, {
      preBlur: (params.pre_blur as number) ?? 1,
      smooth: (params.smooth as number) ?? 4,
    });

    // Coherence aux — built unconditionally (loop-weave rule: this node
    // caches, so consumption-gating would serve a stale empty forever
    // once wired).
    const prog = ctx.getShader("image-flow-field/coherence", COHERENCE_FS);
    ctx.drawFullscreen(prog, coherence, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, field.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: field, aux: { coherence } };
  },
};
