import type { NodeDefinition, RenderContext, SkiaDrawValue, SkiaShaderValue } from "@/engine/types";
import { bindParam, type PaintIR, type ShaderIR } from "@/engine/skia/scene-ir";
import { fuseShader } from "@/engine/skia/fuse";
import { stripComments } from "@/engine/skia/sksl-program";
import { hexToRgba01 } from "@/engine/spline-fill";
import { SKIA_BLEND_PARAM, skiaBlendMode } from "./blend-modes";

// Skia Fill — paints the whole canvas (React Native Skia <Fill>), with a
// flat color or the wired shader. The shader input is a call tree from the
// skia-* shader nodes; this is where it is fused into one runtime effect
// (engine/skia/fuse.ts), at the canvas size and the current time.

interface FillState {
  lastWarned?: string | null;
  // The fused program reads iTime: fold the clock into the fingerprint so
  // the bound iTime value advances while the upstream tree holds still.
  readsTime?: boolean;
}

function getState(ctx: RenderContext, nodeId: string): FillState {
  const key = `skia-fill:${nodeId}`;
  let s = ctx.state[key] as FillState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

// Does any runtime program in the tree read iTime beyond declaring it?
export function shaderReadsTime(ir: ShaderIR | null | undefined): boolean {
  if (!ir || ir.k !== "runtime" || typeof ir.program?.sksl !== "string") return false;
  const code = stripComments(ir.program.sksl).replace(/\buniform\s+float\s+iTime\s*;/g, "");
  if (/\biTime\b/.test(code)) return true;
  return (ir.program.children ?? []).some((c) => shaderReadsTime(c?.shader));
}

export const skiaFillNode: NodeDefinition = {
  type: "skia-fill",
  name: "Skia Fill",
  category: "utility",
  description:
    "Fills the whole Skia canvas with a color, or with the wired Skia shader (fused into one runtime effect here). Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "fill", "paint", "background", "react native"],
  facts: {
    space: { out: "pixels" },
    gotchas: [
      "color is the paint color: a wired shader replaces its RGB, but its alpha (and opacity) still scale the shader, as in React Native Skia.",
      "When the shader cannot be fused the fill falls back to color and the reason is warned once in the console.",
      "blendMode composites the fill over what is already drawn in the Skia scene, not over other engine layers.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "solid-color" },
  noMaskInput: true,
  inputs: [{ name: "shader", label: "Shader", type: "skia_shader", required: false }],
  params: [
    { name: "color", label: "Color", type: "color", alpha: true, default: "#808080" },
    { name: "opacity", label: "Opacity", type: "scalar", min: 0, max: 1, step: 0.001, default: 1 },
    SKIA_BLEND_PARAM,
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],
  tickDriven: true,
  fingerprintExtras(_params, ctx, nodeId) {
    const s = nodeId ? (ctx.state[`skia-fill:${nodeId}`] as FillState | undefined) : undefined;
    return s?.readsTime ? `t:${ctx.time}` : "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const color = hexToRgba01((params.color as string) ?? "#808080");
    const paint: PaintIR = {
      style: "fill",
      color: bindParam(color, nodeId, "color"),
      opacity: bindParam(typeof params.opacity === "number" ? params.opacity : 1, nodeId, "opacity"),
      blendMode: skiaBlendMode(params.blendMode),
    };
    const sv = inputs.shader as SkiaShaderValue | undefined;
    state.readsTime = false;
    if (sv?.kind === "skia_shader") {
      const fused = fuseShader(sv.expr, { resolution: [ctx.width, ctx.height], time: ctx.time });
      if (fused.shader) {
        paint.shader = fused.shader;
        state.readsTime = shaderReadsTime(fused.shader);
        state.lastWarned = null;
      } else {
        const msg = fused.problems.join(" ");
        if (state.lastWarned !== msg) {
          console.warn(`[Skia Fill ${nodeId}] ${msg}`);
          state.lastWarned = msg;
        }
      }
    }
    const out: SkiaDrawValue = { kind: "skia_draw", node: { k: "fill", id: nodeId, paint } };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`skia-fill:${nodeId}`];
  },
};
