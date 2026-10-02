import type {
  NodeDefinition,
  ParamDef,
  SocketValue,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  SPLINE_FILL_INPUT,
  TRANSFORM_INPUT,
  SPLINE_RASTER_PARAMS,
  SPLINE_TRIM_PARAMS,
  applyTrimParams,
  emitSplinePrimitive,
  disposeSplineRasterAux,
  resolveSplineRasterAux,
} from "./spline-raster-aux";

// Open segment between two endpoints. Normalized [0,1]² Y-DOWN, matching
// every other spline source. Meant to be stroked (fill is degenerate on a
// straight 2-point path).
//
// `mode`: straight = two sharp anchors, no handles. bezier = each anchor
// also carries an in and an out handle, stored as offsets RELATIVE to the
// anchor, so the handles ride along when the endpoint moves — including
// when a wire drives it. Start's out and End's in shape the segment itself;
// Start's in and End's out shape the edge the rasterizer closes the path
// with for fill, and whatever closes or joins the path downstream.
//
// Optional `start` / `end` vec2 sockets override startX/Y and endX/Y, so
// either endpoint can be driven from any vec2 source (Vec2, Combine Vec2,
// Pointer, Draggable, Sample Along Path, …). Unwired sockets fall back to
// the params.

// Handle offsets default to a third of the default chord (0.25 → 0.75), so
// flipping to bezier keeps the default line straight, with its handles
// already pulled out where they can be grabbed.
const HANDLE_DEFAULT = 0.1667;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function readVec2(v: SocketValue | undefined): [number, number] | null {
  if (v?.kind !== "vec2") return null;
  const x = v.value[0];
  const y = v.value[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

// A zero offset emits no handle at all — the rasterizer draws the two the
// same, but downstream nodes read "has a handle" as a smooth anchor.
function readHandle(
  params: Record<string, unknown>,
  xName: string,
  yName: string,
  fbx: number
): [number, number] | undefined {
  const x = num(params[xName], fbx);
  const y = num(params[yName], 0);
  return x === 0 && y === 0 ? undefined : [x, y];
}

function makeAnchor(
  pos: [number, number],
  inHandle: [number, number] | undefined,
  outHandle: [number, number] | undefined
): SplineAnchor {
  const a: SplineAnchor = { pos };
  if (inHandle) a.inHandle = inHandle;
  if (outHandle) a.outHandle = outHandle;
  return a;
}

const isBezier = (p: Record<string, unknown>) => p.mode === "bezier";

function handleParam(name: string, label: string, dflt: number): ParamDef {
  return {
    name,
    label,
    type: "scalar",
    min: -1,
    max: 1,
    step: 0.001,
    default: dflt,
    visibleIf: isBezier,
  };
}

export const lineNode: NodeDefinition = {
  type: "line",
  name: "Line",
  category: "spline",
  pickable: true,
  subcategory: "generator",
  description:
    "Generate a line as an open spline — set the two endpoints, or wire Start / End to drive them from a vec2 (unwired sockets keep the params). Bezier mode gives each endpoint in/out handles, set as offsets relative to it. Authored in [0,1]² Y-down; the rasterizer scales y about 0.5 by W/H so lengths stay width-relative.",
  searchAliases: ["segment", "line segment", "bezier", "curve"],
  facts: {
    space: {
      "in:start": "canvas01",
      "in:end": "canvas01",
      "param:startX": "canvas01",
      "param:startY": "canvas01",
      "param:endX": "canvas01",
      "param:endY": "canvas01",
      "param:startInX": "canvas01",
      "param:startInY": "canvas01",
      "param:startOutX": "canvas01",
      "param:startOutY": "canvas01",
      "param:endInX": "canvas01",
      "param:endInY": "canvas01",
      "param:endOutX": "canvas01",
      "param:endOutY": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "A wired start/end socket replaces startX/startY or endX/endY; a scalar wired there sets x and y to the same value.",
      "Handle params (startInX…endOutY) are offsets from their endpoint, so they move with it, wired or not; mode=straight ignores them, and a 0,0 handle is left off (a corner downstream).",
      "Only startOut and endIn bend the open line itself; startIn and endOut shape the edge fill_enabled closes it with, and anything downstream that closes the path.",
      "fill_enabled closes the path End→Start through endOut/startIn, and a flat-color fill strokes that edge too; in mode=straight the fill encloses no area and shows nothing.",
      "stroke_thickness is absolute pixels by default; set stroke_units=% to make it a percentage of canvas width instead, so it scales with output size.",
      "The image aux exists only while stroke_enabled or fill_enabled is on; with both off there is nothing to rasterize and only the spline output carries data.",
      "Wire a transform input (a Gizmo, say) to move/rotate/scale the whole line without touching startX/startY/endX/endY.",
    ],
  },
  backend: "webgl2",
  inputs: [
    SPLINE_FILL_INPUT,
    TRANSFORM_INPUT,
    { name: "start", type: "vec2", required: false, label: "Start" },
    { name: "end", type: "vec2", required: false, label: "End" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["straight", "bezier"],
      optionLabels: { straight: "Straight", bezier: "Bezier" },
      control: "segmented",
      default: "straight",
    },
    // A wired socket replaces its endpoint's X/Y, so those rows step aside.
    { name: "startX", label: "Start X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.25, visibleIf: (_p, meta) => !meta?.wired?.start },
    { name: "startY", label: "Start Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5, visibleIf: (_p, meta) => !meta?.wired?.start },
    handleParam("startInX", "Start in X", -HANDLE_DEFAULT),
    handleParam("startInY", "Start in Y", 0),
    handleParam("startOutX", "Start out X", HANDLE_DEFAULT),
    handleParam("startOutY", "Start out Y", 0),
    { name: "endX", label: "End X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.75, visibleIf: (_p, meta) => !meta?.wired?.end },
    { name: "endY", label: "End Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5, visibleIf: (_p, meta) => !meta?.wired?.end },
    handleParam("endInX", "End in X", -HANDLE_DEFAULT),
    handleParam("endInY", "End in Y", 0),
    handleParam("endOutX", "End out X", HANDLE_DEFAULT),
    handleParam("endOutY", "End out Y", 0),
    ...SPLINE_TRIM_PARAMS,
    ...SPLINE_RASTER_PARAMS,
  ],
  primaryOutput: "spline",
  auxOutputs: [
    { name: "image", type: "image" },
    { name: "element", type: "element" },
  ],
  resolveAuxOutputs: resolveSplineRasterAux,

  compute({ inputs, params, ctx, nodeId }) {
    const start = readVec2(inputs.start) ?? [
      num(params.startX, 0.25),
      num(params.startY, 0.5),
    ];
    const end = readVec2(inputs.end) ?? [
      num(params.endX, 0.75),
      num(params.endY, 0.5),
    ];
    const bezier = isBezier(params);
    const subpath: SplineSubpath = {
      anchors: [
        makeAnchor(
          start,
          bezier ? readHandle(params, "startInX", "startInY", -HANDLE_DEFAULT) : undefined,
          bezier ? readHandle(params, "startOutX", "startOutY", HANDLE_DEFAULT) : undefined
        ),
        makeAnchor(
          end,
          bezier ? readHandle(params, "endInX", "endInY", -HANDLE_DEFAULT) : undefined,
          bezier ? readHandle(params, "endOutX", "endOutY", HANDLE_DEFAULT) : undefined
        ),
      ],
      closed: false,
    };
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([subpath], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
