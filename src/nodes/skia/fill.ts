import type { NodeDefinition, RenderContext, SkiaDrawValue, SkiaShaderValue } from "@/engine/types";
import { bindParam, type PaintIR, type RGBA, type ShaderIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { fuseShader } from "@/engine/skia/fuse";
import {
  buildStagedDraw,
  planShaderStages,
  reportShaderStages,
  stageProgramsOf,
  type StagePlanReport,
} from "@/engine/skia/split";
import { stripComments } from "@/engine/skia/sksl-program";
import { hexToRgba01 } from "@/engine/spline-fill";
import { SKIA_BLEND_PARAM, skiaBlendMode } from "./blend-modes";

// Skia Fill — paints the whole canvas (React Native Skia <Fill>), with a
// flat color or the wired shader. The shader input is a call tree from the
// skia-* shader nodes; this is where it is fused into one runtime effect
// (engine/skia/fuse.ts), at the canvas size and the current time.
//
// Over the phone budget, the fused program is SPLIT at a gather
// (engine/skia/split.ts): the gather's upstream renders once into a layer
// and the gather runs as a runtime image filter over it, so the fill draws
// a Group with a layer instead of one Fill. Automatic and structural (the
// same graph always splits the same way); preview and export read the
// same IR.

interface FillState {
  lastWarned?: string | null;
  // The fused program reads iTime: fold the clock into the fingerprint so
  // the bound iTime value advances while the upstream tree holds still.
  readsTime?: boolean;
  // The last evaluation's stage plan (cost readout), for inspection.
  stages?: StagePlanReport | null;
}

// The last stage plan of a Skia Fill (units per pixel before / after, the
// stages), or null when its shader is not fused here. For MCP / the gates.
export function inspectSkiaFillStages(ctx: RenderContext, nodeId: string): StagePlanReport | null {
  return (ctx.state[`skia-fill:${nodeId}`] as FillState | undefined)?.stages ?? null;
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
      "Over the phone budget (32 units/px) the shader splits: a gather's upstream renders once into an 8-bit layer, the gather runs as a runtime image filter on it (RN <RuntimeShader>; RN web can't).",
      "A split is structural (declared taps, never values), rounds the intermediate to 8 bits, reads off-grid taps bilinearly, and never layers Sharpen / Edge Detect output (it would clip).",
      "Split, an enclosing Skia Group's opacity and blendMode reach the layer's content, not the filtered result; with its own blendMode other than srcOver the fill stays fused.",
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
    // srcOver is left unset so an enclosing Skia Group's blendMode reaches
    // this fill (an explicit paint mode overrides the group's, in the
    // renderer and in React Native alike) — as Skia Group itself does.
    const mode = skiaBlendMode(params.blendMode);
    const colorBind = bindParam<RGBA>(color, nodeId, "color");
    const opacityBind = bindParam(typeof params.opacity === "number" ? params.opacity : 1, nodeId, "opacity");
    const paint: PaintIR = {
      style: "fill",
      color: colorBind,
      opacity: opacityBind,
      ...(mode !== "srcOver" ? { blendMode: mode } : {}),
    };
    const sv = inputs.shader as SkiaShaderValue | undefined;
    state.readsTime = false;
    state.stages = null;
    // Why the drawing isn't what its params ask for: the shader's own
    // refusals (an unported mode renders transparent) plus a failed fuse.
    // Carried on the value so the Skia Canvas lists them and the exporter
    // refuses instead of shipping the fallback silently.
    const problems: string[] = sv?.kind === "skia_shader" ? [...(sv.problems ?? [])] : [];
    let staged: SkiaNode | null = null;
    if (sv?.kind === "skia_shader") {
      const opts = { resolution: [ctx.width, ctx.height] as [number, number], time: ctx.time };
      const fused = fuseShader(sv.expr, opts);
      if (fused.shader) {
        paint.shader = fused.shader;
        state.readsTime = shaderReadsTime(fused.shader);
        state.lastWarned = null;
        // Over budget: render the gather's upstream into a layer (split.ts).
        // A Fill with its own blend mode stays fused (the IR's layer has no
        // blend mode to composite the filtered result with).
        const { plan, notes } = planShaderStages(sv.expr, { id: nodeId });
        const fusedOnly = { ...plan, content: null, marker: null, bilinear: false };
        if (plan.content && mode !== "srcOver") {
          notes.push(`not split: blendMode ${mode} (a split composites its layer srcOver)`);
        }
        const split = !!plan.content && mode === "srcOver";
        state.stages = reportShaderStages(sv.expr, split ? plan : fusedOnly, notes);
        if (split) {
          const built = buildStagedDraw(plan, nodeId, { color: colorBind, opacity: opacityBind }, opts);
          if (built.draw) {
            staged = built.draw.node;
            state.readsTime = stageProgramsOf(staged).some((s) => shaderReadsTime(s));
          } else {
            // Never expected (the planner checked the shape): draw it fused.
            state.stages = reportShaderStages(sv.expr, fusedOnly, [...notes, ...built.problems]);
            console.warn(`[Skia Fill ${nodeId}] stage split failed, drawing fused: ${built.problems.join(" ")}`);
          }
        }
      } else {
        problems.push(...fused.problems);
        const msg = fused.problems.join(" ");
        if (state.lastWarned !== msg) {
          console.warn(`[Skia Fill ${nodeId}] ${msg}`);
          state.lastWarned = msg;
        }
      }
    }
    // The images the fused program's leaves sample ride to the scene
    // (SkiaShaderValue.assets → SkiaDrawValue.assets).
    const assets = sv?.kind === "skia_shader" && paint.shader ? sv.assets : undefined;
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node: staged ?? { k: "fill", id: nodeId, paint },
      ...(assets ? { assets } : {}),
      ...(problems.length ? { problems } : {}),
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`skia-fill:${nodeId}`];
  },
};
