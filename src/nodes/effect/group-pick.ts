import type {
  ImageGroupValue,
  InputSocketDef,
  NodeDefinition,
  PointsGroupValue,
  SocketType,
  SplineGroupValue,
} from "@/engine/types";

// Pick one element out of a group by index. Mode enum matches Group —
// user picks which inner type to work with, and resolveInputs swaps
// the `group` socket's type accordingly. Output is the inner type.
//
// Out-of-range indices clamp to valid range so scrubbing an index
// scalar doesn't suddenly emit nothing at the edges. If the group is
// empty, emits a transparent placeholder matching the inner type.

type Mode = "image" | "spline" | "points";

function groupTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline_group";
  if (mode === "points") return "points_group";
  return "image_group";
}
function innerTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image";
}

export const groupPickNode: NodeDefinition = {
  type: "group-pick",
  name: "Pick",
  category: "utility",
  description:
    "Pick element `index` from a group. Index clamps to the valid range so scrubbing doesn't fall off the ends.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "group", type: "image_group", required: true },
    { name: "index", type: "scalar", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "image") as Mode;
    return [
      { name: "group", type: groupTypeFor(mode), required: true },
      { name: "index", type: "scalar", required: false },
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
    {
      name: "index",
      label: "Index",
      type: "scalar",
      min: 0,
      max: 100,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params): SocketType {
    return innerTypeFor(((params.mode as string) ?? "image") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const mode = ((params.mode as string) ?? "image") as Mode;
    const rawIdx = Math.floor((params.index as number) ?? 0);

    if (mode === "image") {
      const grp = inputs.group as ImageGroupValue | undefined;
      const items = grp?.kind === "image_group" ? grp.items : [];
      if (items.length === 0) {
        const out = ctx.allocImage();
        ctx.clearTarget(out, [0, 0, 0, 0]);
        return { primary: out };
      }
      const i = Math.max(0, Math.min(items.length - 1, rawIdx));
      return { primary: items[i] };
    }
    if (mode === "spline") {
      const grp = inputs.group as SplineGroupValue | undefined;
      const items = grp?.kind === "spline_group" ? grp.items : [];
      if (items.length === 0) {
        return { primary: { kind: "spline", subpaths: [] } };
      }
      const i = Math.max(0, Math.min(items.length - 1, rawIdx));
      return { primary: items[i] };
    }
    // points
    const grp = inputs.group as PointsGroupValue | undefined;
    const items = grp?.kind === "points_group" ? grp.items : [];
    if (items.length === 0) {
      return { primary: { kind: "points", points: [] } };
    }
    const i = Math.max(0, Math.min(items.length - 1, rawIdx));
    return { primary: items[i] };
  },
};
