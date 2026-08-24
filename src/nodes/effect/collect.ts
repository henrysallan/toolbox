import * as THREE from "three";
import type {
  ImageGroupValue,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import type { Object3DValue } from "@/engine/three-types";
import { concatPoints } from "@/engine/points";

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
//
//  - Objects (081026 spec §3.1): 3D scene objects group into one
//    retained THREE.Group, re-membered each eval (Scene Merge's exact
//    reconciliation — this mode replaces it in the menu; the group
//    preserves socket order as child order). `geometry` wires land here
//    through the geometry→object3d auto-wrap coercion, so primitives
//    connect directly.

type Mode = "image" | "spline" | "points" | "object";

const INPUT_LABELS = "abcdefghijklmnopqrstuvwxyz";

function socketTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  if (mode === "object") return "object3d";
  return "image";
}

// Output type: image groups stay as `image_group`; spline/points
// "groups" are flattened back to their base type with per-item
// groupIndex metadata carrying the identity; objects group natively
// (a THREE.Group IS the collection type).
function outputTypeFor(mode: Mode): SocketType {
  if (mode === "spline") return "spline";
  if (mode === "points") return "points";
  if (mode === "object") return "object3d";
  return "image_group";
}

// Display name history: "Group" → "Collect" (2026-06, to free "Group" for
// node-group subgraph nesting) → "Combine" (2026-07, to avoid colliding with
// Proximity Merge's "Join" mode; "Collect" read as a near-synonym of Join).
// The internal type string stays "collect" (immutable node identity — saves
// reference it; the "group" load alias in nodes/index.ts also stays). The
// groupIndex metadata keeps its name since it's per-item identity, not nesting.
export const collectNode: NodeDefinition = {
  type: "collect",
  name: "Combine",
  category: "utility",
  description:
    "Bundle N homogeneous inputs. For images, produces an image_group. For splines and points, concatenates into a single value with per-subpath / per-point groupIndex metadata matching the socket order (a=0, b=1, c=2…). Nodes that don't understand groupIndex just treat the output as a normal spline/points value; Select by Index and Count Indices key off the tags. For 3D objects, groups the inputs into one object3d for the 3D Scene node — primitives wire straight in.",
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
      options: ["image", "spline", "points", "object"],
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

  compute({ inputs, params, ctx, nodeId }) {
    const mode = ((params.mode as string) ?? "image") as Mode;
    const count = Math.max(
      1,
      Math.min(26, Math.floor((params.count as number) ?? 2))
    );

    if (mode === "object") {
      // Retained group, clear-and-re-add membership each eval (children
      // are owned by their producing nodes — clear() only detaches).
      const key = `collect:3d:${nodeId}`;
      let group = ctx.state[key] as THREE.Group | undefined;
      if (!group) {
        group = new THREE.Group();
        group.userData.nodeId = nodeId;
        ctx.state[key] = group;
      }
      group.clear();
      for (let i = 0; i < count; i++) {
        const v = inputs[INPUT_LABELS[i]];
        if (v && v.kind === "object3d") group.add((v as Object3DValue).object);
      }
      const out: Object3DValue = { kind: "object3d", object: group, variant: "group" };
      return { primary: out };
    }

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
      // SoA concat with channel-presence union (z/normals/attributes ride
      // along); groupIndex = connected-socket ordinal, compacted, as the
      // legacy Point[] loop always did.
      const sources: PointsValue[] = [];
      for (let i = 0; i < count; i++) {
        const v = inputs[INPUT_LABELS[i]];
        if (v && v.kind === "points") sources.push(v);
      }
      return {
        primary: concatPoints(sources, { groupIndexFromSource: true }),
      };
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

  dispose(ctx: RenderContext, nodeId: string) {
    // Object mode's retained group (absent unless that mode ever ran).
    const key = `collect:3d:${nodeId}`;
    const group = ctx.state[key] as THREE.Group | undefined;
    if (group) group.clear();
    delete ctx.state[key];
  },
};
