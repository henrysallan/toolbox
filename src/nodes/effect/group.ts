import type {
  ImageGroupValue,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Bundle N homogeneous inputs. Behavior depends on the inner type:
//
//  - Images are a genuine collection — no way to flatten without a
//    compositing decision. The node outputs an image_group carrying
//    the sockets in order; Select by Index / Merge Group consume it.
//
//  - Splines and points are already multi-item at the base-type level
//    (SplineValue.subpaths, PointsValue.points). The "group" for
//    those types is a single flattened value where each subpath /
//    point has been tagged with a groupIndex matching its source
//    socket (a→0, b→1, c→2…). Downstream per-index operations
//    (Select by Index, Count Indices, Copy-to-Points' pick mode)
//    key off that tag. Nodes that don't know about groupIndex just
//    treat the output as a normal spline/points value and operate
//    on everything at once — which is usually what you want.
//
// Missing inputs (unconnected sockets) are silently dropped rather
// than stubbed with placeholder values — the group's effective size
// equals the number of actually-connected sockets.

type Mode = "image" | "spline" | "points";

const INPUT_LABELS = "abcdefghijklmnopqrstuvwxyz";

function socketTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image";
}

// Output type: image groups stay as `image_group`; spline/points
// "groups" are flattened back to their base type with per-item
// groupIndex metadata carrying the identity.
function outputTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  return "image_group";
}

export const groupNode: NodeDefinition = {
  type: "group",
  name: "Group",
  category: "utility",
  description:
    "Bundle N homogeneous inputs. For images, produces an image_group. For splines and points, concatenates into a single value with per-subpath / per-point groupIndex metadata matching the socket order (a=0, b=1, c=2…). Nodes that don't understand groupIndex just treat the output as a normal spline/points value; Select by Index and Count Indices key off the tags.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [{ name: "a", type: "image", required: false }],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "image") as Mode;
    const count = Math.max(
      1,
      Math.min(26, Math.floor((params.count as number) ?? 2))
    );
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
    return outputTypeFor(((params.mode as string) ?? "image") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = ((params.mode as string) ?? "image") as Mode;
    const count = Math.max(
      1,
      Math.min(26, Math.floor((params.count as number) ?? 2))
    );

    if (mode === "spline") {
      // Flatten into a single SplineValue. Each incoming subpath
      // inherits a groupIndex matching its source socket index
      // (position in the sequence of connected sockets, compacted —
      // a disconnected socket doesn't reserve an index).
      const subpaths: SplineSubpath[] = [];
      let outerIdx = 0;
      for (let i = 0; i < count; i++) {
        const v = inputs[INPUT_LABELS[i]];
        if (!v || v.kind !== "spline") continue;
        for (const sub of v.subpaths) {
          subpaths.push({
            closed: sub.closed,
            anchors: sub.anchors,
            groupIndex: outerIdx,
          });
        }
        outerIdx++;
      }
      return {
        primary: { kind: "spline", subpaths } satisfies SplineValue,
      };
    }

    if (mode === "points") {
      const points: PointsValue["points"] = [];
      let outerIdx = 0;
      for (let i = 0; i < count; i++) {
        const v = inputs[INPUT_LABELS[i]];
        if (!v || v.kind !== "points") continue;
        for (const p of v.points) {
          points.push({ ...p, groupIndex: outerIdx });
        }
        outerIdx++;
      }
      return { primary: { kind: "points", points } satisfies PointsValue };
    }

    const items: ImageValue[] = [];
    for (let i = 0; i < count; i++) {
      const v = inputs[INPUT_LABELS[i]];
      if (v && v.kind === "image") items.push(v);
    }
    return {
      primary: { kind: "image_group", items } satisfies ImageGroupValue,
    };
  },
};
