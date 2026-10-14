import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";
import type { AssetIR, SkiaNode } from "@/engine/skia/scene-ir";
import { bindParam } from "@/engine/skia/scene-ir";
import { SKIA_BLEND_PARAM, skiaBlendMode } from "./blend-modes";

// Skia Group — React Native Skia <Group>: up to four child drawings under
// one transform, opacity and blend mode. Children draw in socket order
// (child1 at the bottom). The transform is RN's: scale, then rotate, about
// the origin, then translate (engine/skia/scene-render.ts transformMatrix).
//
// Units are the Skia scene's: canvas pixels, Y-down. `rotate` is degrees in
// the panel and radians in the IR, so its ref carries `scale: π/180` — a
// keyframed rotate exports as a scaled track, never as a degrees track
// mislabeled radians.

const CHILDREN = ["child1", "child2", "child3", "child4"] as const;
// Degrees → radians, as `value * scale` exactly like the exported track
// (toolbox-timeline.ts), so the device reproduces the bound value bit for bit.
const DEG = Math.PI / 180;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export const skiaGroupNode: NodeDefinition = {
  type: "skia-group",
  name: "Skia Group",
  category: "utility",
  description:
    "Groups up to four Skia drawings under one transform, opacity and blend mode (React Native Skia <Group>). child1 draws first, at the bottom. Scale and rotate happen about the origin, then translate moves the result; all in canvas pixels.",
  searchAliases: ["skia", "group", "transform", "layer", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:translateX": "pixels",
      "param:translateY": "pixels",
      "param:originX": "pixels",
      "param:originY": "pixels",
    },
    gotchas: [
      "Order is React Native Skia's: scale, then rotate (degrees, clockwise on screen), both about originX/Y, then translate.",
      "opacity multiplies into every child draw rather than fading the group as one layer, so overlapping children at 0.5 show their overlap.",
      "blendMode is inherited by every child draw that does not set its own (it is not a group composite); srcOver, the default, inherits the enclosing group's mode.",
      "Pixel params do not scale with render resolution; origin 0,0 is the canvas top-left, not its center.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "transform" },
  noMaskInput: true,
  inputs: CHILDREN.map((name, i) => ({ name, label: `Child ${i + 1}`, type: "skia_draw", required: false })),
  params: [
    { name: "translateX", label: "Translate X", type: "scalar", min: -4096, max: 4096, softMax: 1024, step: 0.5, default: 0 },
    { name: "translateY", label: "Translate Y", type: "scalar", min: -4096, max: 4096, softMax: 1024, step: 0.5, default: 0 },
    { name: "rotate", label: "Rotate (°)", type: "scalar", min: -360, max: 360, step: 0.5, default: 0 },
    { name: "scaleX", label: "Scale X", type: "scalar", min: -10, max: 10, softMax: 4, step: 0.01, default: 1 },
    { name: "scaleY", label: "Scale Y", type: "scalar", min: -10, max: 10, softMax: 4, step: 0.01, default: 1 },
    { name: "originX", label: "Origin X", type: "scalar", min: -4096, max: 8192, softMax: 2048, step: 0.5, default: 0 },
    { name: "originY", label: "Origin Y", type: "scalar", min: -4096, max: 8192, softMax: 2048, step: 0.5, default: 0 },
    { name: "opacity", label: "Opacity", type: "scalar", min: 0, max: 1, step: 0.001, default: 1 },
    SKIA_BLEND_PARAM,
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const children: SkiaNode[] = [];
    let assets: Record<string, AssetIR> | undefined;
    const problems: string[] = [];
    for (const name of CHILDREN) {
      const v = inputs[name];
      if (v?.kind !== "skia_draw") continue;
      const d = v as SkiaDrawValue;
      children.push(d.node);
      if (d.assets) assets = { ...(assets ?? {}), ...d.assets };
      if (d.problems) problems.push(...d.problems);
    }
    const deg = num(params.rotate, 0);
    const blendMode = skiaBlendMode(params.blendMode);
    const node: SkiaNode = {
      k: "group",
      id: nodeId,
      transform: {
        translate: [
          bindParam(num(params.translateX, 0), nodeId, "translateX"),
          bindParam(num(params.translateY, 0), nodeId, "translateY"),
        ],
        rotate: { v: deg * DEG, ref: { node: nodeId, param: "rotate", scale: DEG } },
        scale: [
          bindParam(num(params.scaleX, 1), nodeId, "scaleX"),
          bindParam(num(params.scaleY, 1), nodeId, "scaleY"),
        ],
        origin: [
          bindParam(num(params.originX, 0), nodeId, "originX"),
          bindParam(num(params.originY, 0), nodeId, "originY"),
        ],
      },
      opacity: bindParam(num(params.opacity, 1), nodeId, "opacity"),
      ...(blendMode !== "srcOver" ? { blendMode } : {}),
      children,
    };
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node,
      ...(assets ? { assets } : {}),
      ...(problems.length ? { problems } : {}),
    };
    return { primary: out };
  },
};
