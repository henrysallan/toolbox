import type { InputSocketDef, NodeDefinition, SocketValue } from "@/engine/types";
import { layerOpacityKey } from "@/engine/conventions";
import { bindDerived, bindStatic, type Bind, type BindRef, type BlendMode as SkiaBlendMode } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import {
  MASK_COVERAGE_HELPER_ID,
  MERGE_BLEND_HELPER_ID,
  registerMergeBlendHelper,
} from "@/engine/skia/library/helpers-merge";
import { BLEND_FS, mergeNode, modeToInt, type BlendMode, type MergeLayer } from "../effect/merge";

// Merge (Skia) — the Skia-layer port of Merge (specdocs/101326_skia-target.md
// §3.2, Wave 2 family 6). One SkSL function composites a base and up to
// SKIA_MERGE_MAX_LAYERS layers inside the layer's fused runtime shader, with
// Merge's own math: the twenty-nine blend formulas and the straight-alpha
// source-over are DERIVED from Merge's BLEND_FS at load
// (engine/skia/library/helpers-merge.ts), never copied, so they cannot drift.
//
// Same param (`layers`: mode, opacity, enabled, maskInvert, name per layer)
// and the same sockets as Merge — base, mask:base, layer:<id>, mask:<id> —
// typed `skia_shader`, so a converted graph keeps its wires and recipes
// address layers ordinally (layer1, mask2…) exactly as for Merge. A mask is
// any Skia shader, read as Rec.709 luma × alpha (the engine's image → mask
// rule), so the same upstream mattes identically on both sides.
//
// Fixed slots. defineSkslNode needs a fixed input list, so the function
// takes SKIA_MERGE_MAX_LAYERS (8) layer + mask slots; the def maps the
// ENABLED layers, in stack order, onto them (Merge skips disabled layers the
// same way). More than 8 enabled layers is reported unsupported: chain a
// second Skia Merge, whose base is this one's output.
//
// Per-slot uniforms: on (enabled, wired, base wired), mode (Merge's
// modeToInt numbering), opacity, masked, invert. A layer's opacity binds to
// its virtual keyframe key (`layer_opacity:<id>`, engine/conventions.ts),
// so keyframed layer opacity exports as its own track.

export const SKIA_MERGE_MAX_LAYERS = 8;

const BLEND_PROBLEMS = registerMergeBlendHelper(BLEND_FS);

const N = SKIA_MERGE_MAX_LAYERS;
const SLOTS = Array.from({ length: N }, (_, k) => k);

// Toolbox blend mode → the React Native Skia blendMode that names the same
// formula (Skia Group / Skia Fill `blendMode`). Absent = Skia has no such
// mode. Same NAME is not same pixels: see the gotchas below and
// check:skia-merge / compare:skia (merge fixture) for where they disagree.
export const MERGE_TO_SKIA_BLEND: Partial<Record<BlendMode, SkiaBlendMode>> = {
  mix: "srcOver",
  normal: "srcOver",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "colorDodge",
  "color-burn": "colorBurn",
  "hard-light": "hardLight",
  "soft-light": "softLight",
  difference: "difference",
  exclusion: "exclusion",
  add: "plus",
  "linear-dodge": "plus",
};

const slotSource = (k: number) =>
  `  acc = tbx_merge_layer(acc, layer${k}, mask${k}, on${k}, mode${k}, opacity${k}, masked${k}, invert${k});`;

const MERGE_SKSL = `float4 tbx_merge_layer(float4 acc, float4 layer, float4 mask, int on, int mode, float opacity,
                       int masked, int invert) {
  if (on != 1) return acc;
  // Merge's fused pass: invert lives INSIDE the masked branch, so an
  // unwired mask stays full coverage instead of blanking the layer.
  float matte = 1.0;
  if (masked == 1) {
    matte = tbx_mask_coverage(mask);
    if (invert == 1) matte = 1.0 - matte;
  }
  return tbx_blend_over(acc, layer, opacity, matte, mode);
}

float4 tbx_merge(float2 uv, float2 res, int base_on, int base_masked,
${SLOTS.map((k) => `                 int on${k}, int mode${k}, float opacity${k}, int masked${k}, int invert${k},`).join("\n")}
                 float4 base, float4 base_mask,
${SLOTS.map((k) => `                 float4 layer${k}, float4 mask${k}`).join(",\n")}) {
  // Merge clears to opaque black when nothing is wired into base.
  if (base_on != 1) return float4(0.0, 0.0, 0.0, 1.0);
  float4 acc = base;
  if (base_masked == 1) acc.a *= tbx_mask_coverage(base_mask);
${SLOTS.map(slotSource).join("\n")}
  return acc;
}`;

interface Slot {
  layer: MergeLayer;
  on: boolean;
  masked: boolean;
}

interface SlotPlan {
  baseOn: boolean;
  baseMasked: boolean;
  slots: Slot[];
}

// Wiring per evaluation, keyed by the params object the factory hands to
// `binds` (the def's compute builds it fresh each call).
const wiringOf = new WeakMap<object, SlotPlan>();

function enabledLayers(params: Record<string, unknown>): MergeLayer[] {
  const layers = Array.isArray(params.layers) ? (params.layers as MergeLayer[]) : [];
  return layers.filter((l) => l && typeof l.id === "string" && l.enabled !== false);
}

const isShader = (v: SocketValue | undefined) => v?.kind === "skia_shader";

function planSlots(params: Record<string, unknown>, inputs: Record<string, SocketValue | undefined>): SlotPlan {
  const baseOn = isShader(inputs.base);
  return {
    baseOn,
    baseMasked: isShader(inputs["mask:base"]),
    slots: enabledLayers(params)
      .slice(0, N)
      .map((layer) => ({
        layer,
        on: baseOn && isShader(inputs[`layer:${layer.id}`]),
        masked: isShader(inputs[`mask:${layer.id}`]),
      })),
  };
}

const flag = (b: boolean) => (b ? 1 : 0);

const skiaMergeBase = defineSkslNode({
  type: "skia-merge",
  name: "Merge (Skia)",
  mirrors: "merge",
  subcategory: "modifier",
  description:
    "Skia-layer Merge: blends a base shader with up to 8 layer shaders inside the layer's one runtime shader, with Merge's own formulas (all 29 modes, straight-alpha source-over), per-layer opacity (keyframable, exports as tracks) and per-layer masks. Same `layers` param and sockets as Merge (base, mask:base, layer:<id>, mask:<id>); every socket takes a Skia shader, and a mask reads it as luma × alpha. To blend separate draws (shapes, text, images) use the draw's own Skia blendMode instead.",
  searchAliases: ["merge", "blend", "composite", "layers", "mask", "skia", "sksl"],
  facts: {
    gotchas: [
      "Formulas are Merge's, derived from its BLEND_FS at load (straight-alpha source-over; mix = normal). An unwired base renders opaque black, like Merge.",
      "At most 8 enabled layers (fixed shader slots): more is reported, so chain a second Merge (Skia). Wiring the last open layer adds one, as on Merge, up to 8; disabled / unwired layers are skipped.",
      "A mask socket takes any Skia shader and mattes by Rec.709 luma × alpha (the engine's image → mask rule); maskInvert only applies while that mask is wired.",
      "Layer opacity keyframes (layer_opacity:<id>) export as timeline tracks; the evaluator clamps them to 0..1, so an overshooting curve exports sampled per frame instead.",
      "Pick Merge (Skia) for parity with a default-layer Merge and for the 14 modes Skia lacks: subtract, divide, average, vivid/pin/linear light, hard mix, lighter/darker color, linear burn, etc.",
      "Pick a draw's own Skia blendMode to blend separate draws (shapes, text, images) natively: W3C math, hue/saturation/color/luminosity, no shader. Skia Fill ignores an enclosing Group's mode.",
      "Over an opaque base Skia's native modes equal Merge's except softLight (base ≤ 0.25 under a layer > 0.5, off by ≤ 0.06) and plus (premultiplied clamp; Merge's add clamps straight color).",
      "Over a translucent base every native mode but srcOver disagrees broadly: Skia shows the layer unblended where the backdrop is transparent; Merge blends it with the base color regardless.",
    ],
  },
  fn: {
    id: "tbx.merge@1",
    entry: "tbx_merge",
    source: MERGE_SKSL,
    params: [
      { name: "base_on", type: "int" },
      { name: "base_masked", type: "int" },
      ...SLOTS.flatMap((k) => [
        { name: `on${k}`, type: "int" as const },
        { name: `mode${k}`, type: "int" as const },
        { name: `opacity${k}`, type: "float" as const },
        { name: `masked${k}`, type: "int" as const },
        { name: `invert${k}`, type: "int" as const },
      ]),
    ],
    inputs: [
      { name: "base", mode: "pure" },
      { name: "base_mask", mode: "pure" },
      ...SLOTS.flatMap((k) => [
        { name: `layer${k}`, mode: "pure" as const },
        { name: `mask${k}`, mode: "pure" as const },
      ]),
    ],
    uses: [MERGE_BLEND_HELPER_ID, MASK_COVERAGE_HELPER_ID],
    // One blend dispatch + source-over per wired layer.
    cost: 1,
  },
  // Merge's `layers` param, capped: `max` is the most enabled layers the
  // fixed slots take, so the editor's grow-on-wire stops at 8 (the node
  // header's "+" and the per-row eyes work as on Merge — nodes/effect/
  // merge.ts growMergeLayersOnWire).
  params: mirrorParams(mergeNode, ["layers"]).map((p) => ({ ...p, max: N })),
  // The factory's fixed inputs are the function's slots; the def below
  // replaces the sockets with Merge's and routes them onto these.
  inputs: [
    { name: "base", unwired: [0, 0, 0, 1] },
    { name: "base_mask", unwired: [1, 1, 1, 1] },
    ...SLOTS.flatMap((k) => [{ name: `layer${k}` }, { name: `mask${k}`, unwired: [1, 1, 1, 1] as [number, number, number, number] }]),
  ],
  binds({ params, nodeId }) {
    const plan = wiringOf.get(params) ?? planSlots(params, {});
    const layersRef: BindRef[] = [{ node: nodeId, param: "layers" }];
    const binds: Record<string, Bind<number | number[]>> = {
      base_on: bindStatic(flag(plan.baseOn)),
      base_masked: bindStatic(flag(plan.baseMasked)),
    };
    for (const k of SLOTS) {
      const s = plan.slots[k];
      if (!s) {
        binds[`on${k}`] = bindStatic(0);
        binds[`mode${k}`] = bindStatic(0);
        binds[`opacity${k}`] = bindStatic(0);
        binds[`masked${k}`] = bindStatic(0);
        binds[`invert${k}`] = bindStatic(0);
        continue;
      }
      const { layer } = s;
      binds[`on${k}`] = bindDerived(flag(s.on), layersRef);
      // Merge feeds modeToInt straight into its int uniform: an unknown
      // mode string reads 0 (= mix = normal) there too.
      binds[`mode${k}`] = bindDerived(modeToInt(layer.mode) ?? 0, layersRef);
      binds[`opacity${k}`] = {
        v: typeof layer.opacity === "number" && Number.isFinite(layer.opacity) ? layer.opacity : 1,
        ref: { node: nodeId, param: layerOpacityKey(layer.id) },
      };
      binds[`masked${k}`] = bindStatic(flag(s.masked));
      binds[`invert${k}`] = bindDerived(flag(s.masked && layer.maskInvert === true), layersRef);
    }
    return binds;
  },
  unsupported(params) {
    const out = BLEND_PROBLEMS.map((p) => `Merge (Skia) cannot load Merge's blend formulas: ${p}.`);
    const n = enabledLayers(params).length;
    if (n > N) {
      out.push(
        `Merge (Skia) composites at most ${N} enabled layers in one shader; this stack has ${n}. Chain a second Merge (Skia) — wire this one into its base — or disable layers.`
      );
    }
    return out;
  },
});

const asShaderSocket = (s: InputSocketDef): InputSocketDef => ({ ...s, type: "skia_shader" });

export const skiaMergeNode: NodeDefinition = {
  ...skiaMergeBase,
  // Merge's sockets, labels and order (resolveInputs reads the layer ids),
  // carrying Skia shaders.
  inputs: mergeNode.inputs.map(asShaderSocket),
  resolveInputs(params, ctx) {
    return (mergeNode.resolveInputs?.(params, ctx) ?? mergeNode.inputs).map(asShaderSocket);
  },
  compute(args) {
    const { inputs, params } = args;
    const plan = planSlots(params, inputs);
    const slotted: Record<string, SocketValue | undefined> = {
      base: inputs.base,
      base_mask: inputs["mask:base"],
    };
    plan.slots.forEach((s, k) => {
      slotted[`layer${k}`] = inputs[`layer:${s.layer.id}`];
      slotted[`mask${k}`] = inputs[`mask:${s.layer.id}`];
    });
    const own = { ...params };
    wiringOf.set(own, plan);
    return skiaMergeBase.compute({ ...args, inputs: slotted as typeof inputs, params: own });
  },
};
