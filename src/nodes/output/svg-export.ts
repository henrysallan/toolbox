import type {
  NodeDefinition,
  ParamDef,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// SVG Export — snapshot a wired spline at the current playhead as a
// standalone .svg (spec 072726_spline-animation-program.md M2, devlist
// #176). The node is a spline PASSTHROUGH (it can sit inline in a chain)
// whose compute stashes the evaluated input + canvas size in ctx.state;
// the panel's "Export SVG →" button dispatches an effect-node-export event
// and EffectsApp serializes the stash (engine/svg-serialize.ts) through
// platform.saveFile — native Save dialog on desktop, download on web.
//
// `terminal: true` keeps the node (and its upstream branch) in the
// evaluator's needed set even when nothing consumes its output, so the
// stash always reflects the current playhead. Eval caching makes that free
// for static upstreams. The terminal preview fallback is image-only, so a
// spline-input terminal never hijacks the viewport.

export interface SvgExportStash {
  subpaths: SplineSubpath[];
  width: number;
  height: number;
}

export const svgExportStashKey = (nodeId: string) => `svg-export:${nodeId}`;

// The stroke/fill styling the serializer writes onto the exported <path>.
// Shared verbatim with the composition **Output** node, which carries the
// same optional spline tap + stash (see output.ts) — EffectsApp's one
// exporter reads these param names off whichever node fired the button, so
// both surfaces must declare them identically.
export const SVG_STYLE_PARAMS: ParamDef[] = [
  {
    name: "stroke_enabled",
    label: "Stroke",
    type: "boolean",
    default: true,
  },
  {
    name: "stroke_width",
    label: "Stroke width (px)",
    type: "scalar",
    min: 0,
    max: 200,
    softMax: 40,
    step: 0.5,
    default: 4,
    visibleIf: (p) => !!p.stroke_enabled,
  },
  {
    name: "stroke_color",
    label: "Stroke color",
    type: "color",
    default: "#ffffff",
    alpha: true,
    visibleIf: (p) => !!p.stroke_enabled,
  },
  {
    name: "fill_enabled",
    label: "Fill",
    type: "boolean",
    default: false,
  },
  {
    name: "fill_color",
    label: "Fill color",
    type: "color",
    default: "#ffffff",
    alpha: true,
    visibleIf: (p) => !!p.fill_enabled,
  },
  {
    name: "fill_rule",
    label: "Fill rule",
    type: "enum",
    options: ["evenodd", "nonzero"],
    default: "evenodd",
    visibleIf: (p) => !!p.fill_enabled,
  },
];

const EMPTY: SplineValue = { kind: "spline", subpaths: [] };

export const svgExportNode: NodeDefinition = {
  type: "svg-export",
  name: "SVG Export",
  category: "spline",
  subcategory: "utility",
  description:
    "Save the wired spline as a standalone .svg file, snapshotted at the current playhead. Styling (stroke width/color, fill color and rule) is set here — the exported path carries it. The spline passes through unchanged, so the node can sit inline in a chain.",
  backend: "webgl2",
  terminal: true,
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "filename",
      label: "Filename",
      type: "string",
      default: "spline",
    },
    ...SVG_STYLE_PARAMS,
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, ctx, nodeId }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      delete ctx.state[svgExportStashKey(nodeId)];
      return { primary: EMPTY };
    }
    const stash: SvgExportStash = {
      subpaths: src.subpaths,
      width: ctx.width,
      height: ctx.height,
    };
    ctx.state[svgExportStashKey(nodeId)] = stash;
    return { primary: src };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[svgExportStashKey(nodeId)];
  },
};
