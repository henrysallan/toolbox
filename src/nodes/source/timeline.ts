import type {
  InputSocketDef,
  NodeDefinition,
  ScalarValue,
} from "@/engine/types";
import {
  defaultTimelineCurve,
  evalTimelineCurveNormalized,
  sanitizeTimelineCurve,
} from "./timeline/eval";

// Authored animation curve. Evaluates a user-drawn cubic bezier curve at a
// normalized t in 0..1 (wraps via fract) and scales the result into
// [outputMin, outputMax].
//
// Time source is selectable via the `source` param:
//   - "internal" (default): t = ctx.time * time_scale. The node behaves
//     standalone — wire it into anything and it animates against scene
//     time. The fingerprintExtras hook adds ctx.time so caches bust per
//     frame without marking the whole node `stable: false`.
//   - "external": exposes a `t` scalar input socket. Use this when you
//     need a SceneTime → Remap chain in front of the timeline, or when
//     driving t from another scalar (a math node, audio amplitude, etc).
//
// outputMin / outputMax are exposable as sockets via the generic
// exposed-param plumbing.
//
// Stashes its last evaluated wrapped-t into ctx.state under
// `timeline:<nodeId>:t` so the editor's playhead can read it without
// extending the evaluator's contract.

function sourceOf(params: Record<string, unknown>): "internal" | "external" {
  return params.source === "external" ? "external" : "internal";
}

export const timelineNode: NodeDefinition = {
  type: "timeline",
  name: "Timeline",
  category: "utility",
  description:
    "Evaluates an authored bezier curve. Internal source uses scene time × time_scale; switch to external to drive t from a wired scalar (e.g. SceneTime → Remap).",
  backend: "webgl2",
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    if (sourceOf(params) === "external") {
      return [{ name: "t", label: "t", type: "scalar", required: false }];
    }
    return [];
  },
  params: [
    {
      name: "source",
      label: "Time source",
      type: "enum",
      options: ["internal", "external"],
      default: "internal",
    },
    {
      name: "time_scale",
      label: "Time scale",
      type: "scalar",
      min: -10,
      max: 10,
      softMax: 4,
      step: 0.001,
      default: 1,
      visibleIf: (p) => sourceOf(p) === "internal",
    },
    {
      name: "outputMin",
      label: "Output min",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "outputMax",
      label: "Output max",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "curve",
      label: "Curve",
      type: "timeline_curve",
      default: defaultTimelineCurve(),
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  fingerprintExtras(params, ctx) {
    // Internal mode reads ctx.time directly, so caches must bust per
    // frame. External mode inherits time-variance through srcFp from
    // whatever scalar drives the t input — no extras needed.
    if (sourceOf(params) === "internal") return `t:${ctx.time}`;
    return "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const source = sourceOf(params);
    let tIn: number;
    if (source === "internal") {
      const scale = (params.time_scale as number) ?? 1;
      tIn = ctx.time * scale;
    } else {
      tIn = inputs.t?.kind === "scalar" ? inputs.t.value : 0;
    }
    const wrapped = tIn - Math.floor(tIn);
    ctx.state[`timeline:${nodeId}:t`] = wrapped;

    const curve = sanitizeTimelineCurve(params.curve);
    const y = evalTimelineCurveNormalized(curve, wrapped);
    const outMin = (params.outputMin as number) ?? 0;
    const outMax = (params.outputMax as number) ?? 1;
    const scaled = outMin + y * (outMax - outMin);

    return {
      primary: { kind: "scalar", value: scaled } satisfies ScalarValue,
    };
  },
};
