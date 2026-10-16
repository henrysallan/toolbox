import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  SocketType,
} from "@/engine/types";
import { LAYER_XFORM_INPUT, readGroupInterface } from "@/engine/groups";
import {
  asTransform,
  composeOpsToCanvasAffine,
  invertAffine,
  isIdentityAffine,
  TRANSFORM_TRS_PARAMS,
} from "@/engine/transform-value";
import { LAYER_TARGETS } from "@/engine/skia/layer-target";
import {
  svgExportStashKey,
  type SvgExportStash,
} from "@/nodes/output/svg-export";
import {
  BLEND_FS,
  BLEND_MODE_GLSL,
  BLEND_MODE_ORDER,
  modeToInt,
  type BlendMode,
} from "@/nodes/effect/merge";

// Layer — a root-only group subtype with a fixed interface (see
// specdocs/archive/layers-groups-attributes.md §2 and engine/groups.ts).
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

// Parent input + the hidden compositor input flatten feeds from this
// layer's synthesized layer-xform node (its world transform). Both are
// reserved: a minted interface socket can't shadow them.
const TRANSFORM_INPUTS: InputSocketDef[] = [
  { name: "transform", type: "transform", required: false, label: "Parent" },
  { name: LAYER_XFORM_INPUT, type: "transform", required: false, hidden: true },
];

// Merge's pairwise blend with the content sampled through the layer's
// inverse world transform (canvas01, y-down — composeOpsToCanvasAffine, so
// it's rigid in pixels on any aspect). Outside the content's frame the
// sample is transparent; `cov` antialiases that edge over ~1 source pixel
// and enters compositeOver as the matte term. At identity every pixel
// center sits ≥ 0.5 px inside the frame, so cov = 1 and the result equals
// BLEND_FS exactly (check-shaders asserts it). Used only when the
// transform isn't identity; Merge's shader key stays untouched.
export const LAYER_BLEND_XFORM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_layer;
uniform float u_opacity;
uniform int u_mode;
uniform vec4 u_invA; // inverse linear part: a, b, c, d
uniform vec2 u_invT; // inverse translation
uniform vec2 u_res;  // content size in pixels
out vec4 outColor;
${BLEND_MODE_GLSL}
void main() {
  vec4 a = texture(u_base, v_uv);
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 s = vec2(
    u_invA.x * p.x + u_invA.y * p.y + u_invT.x,
    u_invA.z * p.x + u_invA.w * p.y + u_invT.y
  );
  vec2 d = min(s, 1.0 - s) * u_res + 0.5;
  float cov = clamp(min(d.x, d.y), 0.0, 1.0);
  vec4 b = texture(u_layer, vec2(s.x, 1.0 - s.y));
  outColor = compositeOver(a, b, u_opacity, cov, u_mode);
}`;

export const layerNode: NodeDefinition = {
  type: "layer",
  name: "Layer",
  hidden: true,
  category: "utility",
  description:
    "One layer in the root compositing stack: blends its interior content over the layers below with a blend mode and opacity. Double-click (or Tab) to edit its contents.",
  backend: "webgl2",
  noMaskInput: true,
  // On-canvas TRS + pivot handles when the layer is selected (§4). The
  // gizmo's default box is the frame, which is what a layer's content
  // spans. EffectsApp hides the Flip H/V actions for layers: they write a
  // negative scale, and layer scale is clamped positive.
  supportsTransformGizmo: true,
  inputs: [
    { name: "stack", type: "image", required: false },
    { name: "content", type: "image", required: false, hidden: true },
    { name: "audio", type: "audio", required: false },
    { name: "spline", type: "spline", required: false, hidden: true },
    ...TRANSFORM_INPUTS,
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
      { name: "spline", type: "spline", required: false, hidden: true },
      ...TRANSFORM_INPUTS,
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
    // Layer transform (101526_layer-transforms-parenting.md §2): moves the
    // finished content before the blend. Authored space, like Gizmo —
    // translateY is width-relative and pivot (0.5, 0.5) is the canvas
    // center. Identity by default, so saves from before it render as-is.
    ...TRANSFORM_TRS_PARAMS,
    // Skia target (specdocs/101326_skia-target.md §3.1): "skia" limits the
    // interior to nodes with a React Native Skia lowering and makes the
    // layer exportable. Read through readLayerTarget, so saves from before
    // this param read "default". Hidden from the generic param list — the
    // panel's layer section renders it as a toggle; it is not keyframable
    // or wireable — but set_param reaches it by name.
    {
      name: "target",
      label: "Target",
      type: "enum",
      options: [...LAYER_TARGETS],
      optionLabels: { default: "Default", skia: "Skia" },
      control: "segmented",
      default: "default",
      hidden: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    { name: "audio", type: "audio" },
    // World transform (parent ∘ own TRS) — wire into another layer's
    // Parent input to parent it. In the flat graph this edge sources from
    // the layer's synthesized layer-xform node instead (flatten.ts).
    { name: "transform", type: "transform" },
  ],
  linkedPairs: [{ a: "scaleX", b: "scaleY" }],

  compute({ inputs, params, ctx, nodeId }) {
    // Vector export tap. The interior Layer Output has no compute of its
    // own (flatten dissolves every group boundary), so the layer stashes
    // on its behalf — under the LAYER's id, which EffectsApp's
    // exportSvgNode resolves to from the Layer Output's parentId. Purely
    // a side-channel: it never touches the blend below.
    const splineIn = inputs.spline;
    if (
      splineIn &&
      splineIn.kind === "spline" &&
      splineIn.subpaths.length > 0
    ) {
      const stash: SvgExportStash = {
        subpaths: splineIn.subpaths,
        width: ctx.width,
        height: ctx.height,
      };
      ctx.state[svgExportStashKey(nodeId)] = stash;
    } else {
      delete ctx.state[svgExportStashKey(nodeId)];
    }

    const stack = inputs.stack;
    const content = inputs.content;
    const hasStack = !!stack && stack.kind === "image";
    const hasContent = !!content && content.kind === "image";

    // Nothing inside and nothing below — emit transparent black so the
    // chain above keeps compositing sanely.
    if (!hasContent && !hasStack) {
      const output = ctx.allocImage();
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    // Layer transform (§3): the world transform flatten feeds in from
    // this layer's layer-xform node. Identity — or nothing wired, which is
    // every layer without a transform — leaves the paths below exactly as
    // they were. A collapsed transform (zero-area) shows no content.
    const xform = asTransform(inputs[LAYER_XFORM_INPUT]);
    let inv: ReturnType<typeof invertAffine> = null;
    let moved = false;
    if (xform && xform.ops.length > 0) {
      const m = composeOpsToCanvasAffine(xform.ops, ctx.width / ctx.height);
      if (!isIdentityAffine(m)) {
        moved = true;
        inv = invertAffine(m);
      }
    }
    const contentVisible = hasContent && (!moved || inv !== null);

    if (!contentVisible) {
      if (!hasStack) {
        const output = ctx.allocImage();
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }
      // Empty layer: the stack passes through untouched — returned
      // directly (the bypass/gated-layer pattern) instead of paying a
      // full-canvas blit + a canvas-sized alloc for a verbatim copy.
      // ownsTextures: false — the upstream cache entry owns the texture.
      return { primary: stack, ownsTextures: false };
    }

    // Composite content over the stack (or over transparency for the
    // bottom layer) — same shader and semantics as one Merge layer.
    const mode = ((params.blendMode as string) ?? "normal") as BlendMode;
    const opacity = Math.max(0, Math.min(1, (params.opacity as number) ?? 1));

    // Bottom layer, normal blend at full opacity: compositing over a
    // transparent base is the identity (compositeOver with a.a = 0 gives
    // outA = b.a, outRgb = b.rgb for mode "normal"), so return the
    // content untouched. NOT valid for other modes — blendRgb reads the
    // base RGB unweighted by base alpha, so e.g. multiply over
    // transparent black darkens. At 4K the skipped pass + the two
    // canvas-sized allocs (output + cleared scratch base) were ~4.4 ms
    // of GPU per frame.
    if (!hasStack && mode === "normal" && opacity >= 1 && !moved) {
      return { primary: content, ownsTextures: false };
    }

    const output = ctx.allocImage();
    let base: ImageValue | null = hasStack ? (stack as ImageValue) : null;
    let baseOwned = false;
    if (!base) {
      base = ctx.allocImage();
      ctx.clearTarget(base, [0, 0, 0, 0]);
      baseOwned = true;
    }
    // Key kept in sync with merge.ts (bumped when the matte uniforms landed
    // — getShader caches by key alone). The layer node never sets u_hasMatte,
    // which defaults to 0 = no matte.
    // v3: BLEND_FS was refactored to share its blend math with Merge's fused
    // shader (same formulas, same uniforms) — key bumped because getShader
    // caches by key alone and would otherwise serve the old source.
    const blend = moved
      ? ctx.getShader("layer/blend-xform-v1", LAYER_BLEND_XFORM_FS)
      : ctx.getShader("merge/blend-v3", BLEND_FS);
    ctx.drawFullscreen(blend, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, base!.texture);
      gl.uniform1i(gl.getUniformLocation(blend, "u_base"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, (content as ImageValue).texture);
      gl.uniform1i(gl.getUniformLocation(blend, "u_layer"), 1);
      gl.uniform1f(gl.getUniformLocation(blend, "u_opacity"), opacity);
      gl.uniform1i(gl.getUniformLocation(blend, "u_mode"), modeToInt(mode));
      if (moved && inv) {
        gl.uniform4f(
          gl.getUniformLocation(blend, "u_invA"),
          inv.a,
          inv.b,
          inv.c,
          inv.d
        );
        gl.uniform2f(gl.getUniformLocation(blend, "u_invT"), inv.tx, inv.ty);
        gl.uniform2f(
          gl.getUniformLocation(blend, "u_res"),
          (content as ImageValue).width,
          (content as ImageValue).height
        );
      }
    });
    if (baseOwned) ctx.releaseTexture(base.texture);
    return { primary: output };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[svgExportStashKey(nodeId)];
  },
};
