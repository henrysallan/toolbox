import type {
  InputSocketDef,
  NodeDefinition,
  SocketType,
} from "@/engine/types";

// N-input multiplexer. Picks `inputs[i]` where `i` is the value coming
// in on the `index` socket (or, if unconnected, the index param). The
// active socket type is selected by the `type` enum so the same node
// can switch between scalars, images, vec2, points, or splines.
//
// Index is rounded and clamped into [0, count-1]; missing inputs at
// the chosen slot fall through to the next configured slot's default
// for that type, or to undefined when nothing is wired.

const TYPES: SocketType[] = ["scalar", "image", "vec2", "points", "spline"];
const MIN_COUNT = 2;
const MAX_COUNT = 8;

function activeType(params: Record<string, unknown>): SocketType {
  const t = (params.type as SocketType) ?? "scalar";
  return TYPES.includes(t) ? t : "scalar";
}

function activeCount(params: Record<string, unknown>): number {
  const raw = (params.count as number) ?? 2;
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(raw)));
}

export const switchNode: NodeDefinition = {
  type: "switch",
  name: "Switch",
  category: "utility",
  description:
    "Picks one of N inputs by index. Type chooses what kind of value to switch (scalar / image / vec2 / points / spline); Count sets how many input slots render. Wire a scalar to Index for live switching.",
  backend: "webgl2",
  headerControl: { paramName: "type" },
  inputs: [
    { name: "index", type: "scalar", required: false, label: "Index" },
    { name: "in0", type: "scalar", required: false, label: "Input 0" },
    { name: "in1", type: "scalar", required: false, label: "Input 1" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const t = activeType(params);
    const n = activeCount(params);
    const sockets: InputSocketDef[] = [
      { name: "index", type: "scalar", required: false, label: "Index" },
    ];
    for (let i = 0; i < n; i++) {
      sockets.push({
        name: `in${i}`,
        type: t,
        required: false,
        label: `Input ${i}`,
      });
    }
    return sockets;
  },
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: TYPES as unknown as string[],
      default: "scalar",
    },
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: MIN_COUNT,
      max: MAX_COUNT,
      step: 1,
      default: 2,
    },
    {
      name: "index",
      label: "Index",
      type: "scalar",
      min: 0,
      max: MAX_COUNT - 1,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params): SocketType {
    return activeType(params);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const n = activeCount(params);
    const idxRaw =
      inputs.index?.kind === "scalar"
        ? inputs.index.value
        : ((params.index as number) ?? 0);
    let i = Math.round(idxRaw);
    if (!Number.isFinite(i)) i = 0;
    if (i < 0) i = 0;
    if (i > n - 1) i = n - 1;
    const picked = inputs[`in${i}`];
    if (!picked) return {};
    return { primary: picked };
  },
};
