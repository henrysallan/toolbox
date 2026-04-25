import type {
  InputSocketDef,
  NodeDefinition,
  ScalarValue,
  SocketType,
} from "@/engine/types";

// Count distinct group members as a scalar. Wires neatly into Remap,
// Math, or an Accumulator for group-size-driven behaviors (e.g.,
// scale the number of copies an Array node makes to match the number
// of items in a source group).
//
//  - Image mode: returns image_group.items.length.
//  - Spline / points: counts distinct `groupIndex` values across the
//    flat input. Subpaths / points without a tag count as index 0,
//    so an un-grouped input reports 1.

type Mode = "image" | "spline" | "points";

function inputTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image_group";
}

export const groupLengthNode: NodeDefinition = {
  // Retained type string for back-compat with serialized projects.
  type: "group-length",
  name: "Count Indices",
  category: "utility",
  description:
    "Count distinct group members as a scalar. Image mode counts image_group items; spline and points modes count distinct groupIndex values carried on subpaths / points (un-grouped input reports 1).",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [{ name: "group", type: "image_group", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "image") as Mode;
    return [
      {
        name: "group",
        type: inputTypeFor(mode),
        required: true,
        label: mode === "image" ? "Group" : "In",
      },
    ];
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
    if (g) {
      if (g.kind === "image_group") {
        n = g.items.length;
      } else if (g.kind === "spline") {
        const seen = new Set<number>();
        for (const s of g.subpaths) seen.add(s.groupIndex ?? 0);
        n = seen.size;
      } else if (g.kind === "points") {
        const seen = new Set<number>();
        for (const p of g.points) seen.add(p.groupIndex ?? 0);
        n = seen.size;
      }
    }
    return { primary: { kind: "scalar", value: n } satisfies ScalarValue };
  },
};
