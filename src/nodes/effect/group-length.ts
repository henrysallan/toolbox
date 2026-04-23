import type {
  InputSocketDef,
  NodeDefinition,
  ScalarValue,
  SocketType,
} from "@/engine/types";

// Emit the item count of a group as a scalar. Wires neatly into
// Remap, Math, or an Accumulator for group-size-driven behaviors
// (e.g., scale the number of copies an Array node makes to match
// the number of items in a source group).

type Mode = "image" | "spline" | "points";

function groupTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline_group";
  if (mode === "points") return "points_group";
  return "image_group";
}

export const groupLengthNode: NodeDefinition = {
  type: "group-length",
  name: "Length",
  category: "effect",
  description:
    "Count the items in a group as a scalar.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [{ name: "group", type: "image_group", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "image") as Mode;
    return [{ name: "group", type: groupTypeFor(mode), required: true }];
  },
  params: [
    {
      name: "mode",
      label: "Type",
      type: "enum",
      options: ["image", "spline", "points"],
      default: "image",
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ inputs }) {
    const g = inputs.group;
    let n = 0;
    if (
      g &&
      (g.kind === "image_group" ||
        g.kind === "spline_group" ||
        g.kind === "points_group")
    ) {
      n = g.items.length;
    }
    return { primary: { kind: "scalar", value: n } satisfies ScalarValue };
  },
};
