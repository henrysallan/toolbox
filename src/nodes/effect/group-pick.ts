import type {
  ImageGroupValue,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  SocketType,
  SplineValue,
} from "@/engine/types";

// Select one group member by index.
//
// For image mode, indexes into an image_group's array — unchanged
// from the old Group Pick.
//
// For spline / points, we filter the flat input down to only
// subpaths / points whose `groupIndex` matches the chosen index.
// Subpaths and points without a groupIndex (i.e. never passed
// through a Group node) are treated as belonging to a default
// "index 0" bucket so an un-grouped input still works sensibly —
// picking index 0 returns everything.
//
// Out-of-range indices clamp to the valid range so a scrubbed
// scalar doesn't fall off the ends. Empty outputs emit empty
// placeholders of the appropriate inner type.

type Mode = "image" | "spline" | "points";

function innerTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image";
}

// For spline/points, the Group node now flattens to the base type
// with groupIndex tags. So the input socket type is just the base
// type in those modes, same as the output.
function inputTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image_group";
}

export const groupPickNode: NodeDefinition = {
  // Retaining the `group-pick` type string for back-compat with any
  // serialized projects. Display name updated to the new semantics.
  type: "group-pick",
  name: "Select by Index",
  category: "utility",
  description:
    "Filter to one index of a group. For images, indexes into an image_group's array. For splines and points, keeps only subpaths / points whose groupIndex matches the chosen index — Group's output uses socket-order tags (a=0, b=1, c=2…). Index clamps to valid range.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "group", type: "image_group", required: true },
    { name: "index", type: "scalar", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "image") as Mode;
    return [
      {
        name: "group",
        type: inputTypeFor(mode),
        required: true,
        label: mode === "image" ? "Group" : "In",
      },
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
    const rawIdx = Math.floor(
      inputs.index?.kind === "scalar"
        ? inputs.index.value
        : (params.index as number) ?? 0
    );

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
      const src = inputs.group;
      if (!src || src.kind !== "spline") {
        return { primary: { kind: "spline", subpaths: [] } };
      }
      const { clampedIdx, matches } = pickByGroupIndex(
        src.subpaths.map((s) => s.groupIndex ?? 0),
        rawIdx
      );
      const subpaths = matches.map((i) => src.subpaths[i]);
      return {
        primary: {
          kind: "spline",
          // Strip the groupIndex on the way out — consumers see a
          // plain single-group spline.
          subpaths: subpaths.map((s) => ({
            closed: s.closed,
            anchors: s.anchors,
          })),
        } satisfies SplineValue,
      };
      // clampedIdx isn't used downstream but the helper returns it
      // for consistency with the points branch below.
      void clampedIdx;
    }

    // points
    const src = inputs.group;
    if (!src || src.kind !== "points") {
      return { primary: { kind: "points", points: [] } };
    }
    const { matches } = pickByGroupIndex(
      src.points.map((p) => p.groupIndex ?? 0),
      rawIdx
    );
    return {
      primary: {
        kind: "points",
        points: matches.map((i) => {
          // Drop the groupIndex on the way out for the same reason
          // as splines — the selected subset is its own group now.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { groupIndex, ...rest } = src.points[i];
          return rest;
        }),
      } satisfies PointsValue,
    };
  },
};

// Given an array of per-item groupIndex values and a requested
// index, returns the matches (item indices whose groupIndex equals
// the clamped requested index). Distinct groupIndex values are
// sorted so the Nth highest or lowest is predictable.
function pickByGroupIndex(
  indices: number[],
  requested: number
): { clampedIdx: number; matches: number[] } {
  if (indices.length === 0) return { clampedIdx: 0, matches: [] };
  const distinct = Array.from(new Set(indices)).sort((a, b) => a - b);
  const clampedIdx = Math.max(
    0,
    Math.min(distinct.length - 1, requested)
  );
  const target = distinct[clampedIdx];
  const matches: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] === target) matches.push(i);
  }
  return { clampedIdx, matches };
}
