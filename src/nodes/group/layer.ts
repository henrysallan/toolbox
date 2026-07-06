import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  SocketType,
} from "@/engine/types";
import { readGroupInterface } from "@/engine/groups";
import {
  BLEND_FS,
  BLEND_MODE_ORDER,
  BLIT_FS,
  modeToInt,
  type BlendMode,
} from "@/nodes/effect/merge";

// Layer — a root-only group subtype with a fixed interface (see
// specdocs/layers-groups-attributes.md §2 and engine/groups.ts).
//
// Unlike a plain group, the layer node computes: it composites its
// interior result over the `stack` (everything below it in the root
// chain) with a blend mode + opacity, reusing the Merge node's shader.
// The `content` input is hidden — no handle renders for it; the flatten
// pass wires it from the layer's interior Group Output. Audio never
// passes through compute: the flatten pass splices audio chains
// (interior Group Output audio, or the exterior `audio` input) straight
// through to the consumer, so audio-source detection keeps working on
// direct edges.
//
// Outside its clip window a layer is a pure passthrough — the evaluator
// special-cases gating for this type (stack out, interior dropped from
// the needed set) instead of emitting the generic empty output.
//
// Created only through layer-specific actions (root add menu, Layers
// editor) — never via Cmd+G, and never offered inside groups. `hidden`
// keeps it out of the generic menus; the root menu adds it as a
// compound entry.

export const layerNode: NodeDefinition = {
  type: "layer",
  name: "Layer",
  hidden: true,
  category: "utility",
  description:
    "One layer in the root compositing stack: blends its interior content over the layers below with a blend mode and opacity. Double-click (or Tab) to edit its contents.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "stack", type: "image", required: false },
    { name: "content", type: "image", required: false, hidden: true },
    { name: "audio", type: "audio", required: false },
  ],
  // Fixed interface (stack / hidden content / audio) PLUS any extra input
  // sockets the user minted on the interior Layer Input node. graph-ops'
  // syncGroupInterface writes those onto the layer node's `interface` param
  // (same as a plain group), and — like node-group.resolveInputs — we surface
  // them here so the composition can wire into the layer's interior. The
  // reserved `backdrop` socket is already represented by `stack`, so it's
  // excluded; the flatten pass (resolveBoundarySource) splices each minted
  // input straight through to its interior consumers at eval time.
  resolveInputs(params): InputSocketDef[] {
    const fixed: InputSocketDef[] = [
      { name: "stack", type: "image", required: false },
      { name: "content", type: "image", required: false, hidden: true },
      { name: "audio", type: "audio", required: false },
    ];
    // Names already owned by the fixed interface — `backdrop` maps to `stack`,
    // so skip it too. Collisions are dropped rather than duplicated.
    const used = new Set([...fixed.map((i) => i.name), "backdrop"]);
    for (const s of readGroupInterface(params).inputs) {
      if (used.has(s.name)) continue;
      used.add(s.name);
      fixed.push({ name: s.name, type: s.type as SocketType, required: false });
    }
    return fixed;
  },
  params: [
    {
      name: "blendMode",
      label: "Blend",
      type: "enum",
      options: [...BLEND_MODE_ORDER],
      default: "normal",
    },
    {
      name: "opacity",
      label: "Opacity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [{ name: "audio", type: "audio" }],

  compute({ inputs, params, ctx }) {
    const stack = inputs.stack;
    const content = inputs.content;
    const hasStack = !!stack && stack.kind === "image";
    const hasContent = !!content && content.kind === "image";

    // Nothing inside and nothing below — emit transparent black so the
    // chain above keeps compositing sanely.
    const output = ctx.allocImage();
    if (!hasContent && !hasStack) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    if (!hasContent) {
      // Empty layer: the stack passes through untouched.
      const blit = ctx.getShader("merge/blit", BLIT_FS);
      ctx.drawFullscreen(blit, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, (stack as ImageValue).texture);
        gl.uniform1i(gl.getUniformLocation(blit, "u_src"), 0);
      });
      return { primary: output };
    }

    // Composite content over the stack (or over transparency for the
    // bottom layer) — same shader and semantics as one Merge layer.
    const mode = ((params.blendMode as string) ?? "normal") as BlendMode;
    const opacity = Math.max(0, Math.min(1, (params.opacity as number) ?? 1));
    let base: ImageValue | null = hasStack ? (stack as ImageValue) : null;
    let baseOwned = false;
    if (!base) {
      base = ctx.allocImage();
      ctx.clearTarget(base, [0, 0, 0, 0]);
      baseOwned = true;
    }
    const blend = ctx.getShader("merge/blend", BLEND_FS);
    ctx.drawFullscreen(blend, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, base!.texture);
      gl.uniform1i(gl.getUniformLocation(blend, "u_base"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, (content as ImageValue).texture);
      gl.uniform1i(gl.getUniformLocation(blend, "u_layer"), 1);
      gl.uniform1f(gl.getUniformLocation(blend, "u_opacity"), opacity);
      gl.uniform1i(gl.getUniformLocation(blend, "u_mode"), modeToInt(mode));
    });
    if (baseOwned) ctx.releaseTexture(base.texture);
    return { primary: output };
  },
};
