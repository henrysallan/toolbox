import type {
  ImageGroupValue,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  PointsGroupValue,
  PointsValue,
  SocketType,
  SplineGroupValue,
  SplineValue,
} from "@/engine/types";

// Bundle N homogeneous inputs into a single group value. The mode enum
// picks the inner type (image / spline / points); the count scalar
// picks how many input sockets the node exposes.
//
// Mode is rendered as a quick dropdown on the node header too
// (headerControl hook) since flipping it is the primary thing you do
// to this node — no sense burying it in the params panel.
//
// Missing inputs (unconnected sockets) are silently dropped rather
// than stubbed with placeholder values — the group's length equals
// the number of actually-connected sockets. That matches the
// intuition that "3 connected out of 5 sockets" is a group of 3.

type Mode = "image" | "spline" | "points";

const INPUT_LABELS = "abcdefghijklmnopqrstuvwxyz";

function socketTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image";
}
function groupTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline_group";
  if (mode === "points") return "points_group";
  return "image_group";
}

export const groupNode: NodeDefinition = {
  type: "group",
  name: "Group",
  category: "effect",
  description:
    "Bundle N homogeneous inputs into a single group. Pick inner type via the header dropdown; count slider picks how many input sockets appear.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [{ name: "a", type: "image", required: false }],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "image") as Mode;
    const count = Math.max(1, Math.min(26, Math.floor(
      (params.count as number) ?? 2
    )));
    const t = socketTypeFor(mode);
    const out: InputSocketDef[] = [];
    for (let i = 0; i < count; i++) {
      out.push({ name: INPUT_LABELS[i], type: t, required: false });
    }
    return out;
  },
  params: [
    {
      name: "mode",
      label: "Type",
      type: "enum",
      options: ["image", "spline", "points"],
      default: "image",
    },
    {
      name: "count",
      label: "Inputs",
      type: "scalar",
      min: 1,
      max: 26,
      step: 1,
      default: 2,
    },
  ],
  primaryOutput: "image_group",
  resolvePrimaryOutput(params): SocketType {
    return groupTypeFor(((params.mode as string) ?? "image") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = ((params.mode as string) ?? "image") as Mode;
    const count = Math.max(1, Math.min(26, Math.floor(
      (params.count as number) ?? 2
    )));

    if (mode === "spline") {
      const items: SplineValue[] = [];
      for (let i = 0; i < count; i++) {
        const v = inputs[INPUT_LABELS[i]];
        if (v && v.kind === "spline") items.push(v);
      }
      return { primary: { kind: "spline_group", items } satisfies SplineGroupValue };
    }
    if (mode === "points") {
      const items: PointsValue[] = [];
      for (let i = 0; i < count; i++) {
        const v = inputs[INPUT_LABELS[i]];
        if (v && v.kind === "points") items.push(v);
      }
      return { primary: { kind: "points_group", items } satisfies PointsGroupValue };
    }
    const items: ImageValue[] = [];
    for (let i = 0; i < count; i++) {
      const v = inputs[INPUT_LABELS[i]];
      if (v && v.kind === "image") items.push(v);
    }
    return { primary: { kind: "image_group", items } satisfies ImageGroupValue };
  },
};
