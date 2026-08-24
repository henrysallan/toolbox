import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  SocketType,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";

// Translate a spline or point cluster so its geometric center lands at
// (X, Y). Absolute "place this thing here" semantics — unlike
// Transform.translate which is an offset, this figures out the input's
// own center and shifts accordingly so the result is predictable no
// matter where the source happens to live.
//
// Center = centroid of anchor positions (spline) or points' positions.
// Handles aren't touched: they're stored relative to anchors, so
// shifting the anchors carries them along for free.
//
// Works on spline and points only — image "position" isn't a
// well-defined concept (images fill the frame), so we don't fake one
// here. Use Transform in image mode for pixel translation.

type Mode = "spline" | "points";

function innerTypeFor(mode: Mode): SocketType {
  return mode === "spline" ? "spline" : "points";
}

function centroidOfSpline(
  spline: SplineValue
): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const sub of spline.subpaths) {
    for (const a of sub.anchors) {
      sx += a.pos[0];
      sy += a.pos[1];
      n++;
    }
  }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

function shiftSubpath(
  sub: SplineSubpath,
  dx: number,
  dy: number
): SplineSubpath {
  return {
    closed: sub.closed,
    anchors: sub.anchors.map<SplineAnchor>((a) => ({
      ...a,
      pos: [a.pos[0] + dx, a.pos[1] + dy],
    })),
  };
}

export const setPositionNode: NodeDefinition = {
  type: "set-position",
  name: "Set Position",
  category: "point",
  subcategory: "modifier",
  description:
    "Translate so the input's geometric center lands at (X, Y). Absolute placement — unlike Transform's offset translate, the result is always centered at the target regardless of where the input started.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "in", type: "spline", required: true },
    { name: "position", type: "vec2", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    return [
      {
        name: "in",
        type: innerTypeFor(mode),
        required: true,
        label: mode === "spline" ? "Spline" : "Points",
      },
      { name: "position", type: "vec2", required: false },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Type",
      type: "enum",
      options: ["spline", "points"],
      default: "spline",
    },
    {
      name: "x",
      label: "X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "y",
      label: "Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "spline",
  resolvePrimaryOutput(params): SocketType {
    return innerTypeFor(((params.mode as string) ?? "spline") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const mode = ((params.mode as string) ?? "spline") as Mode;

    // Target position — vec2 input wins when connected, otherwise
    // fall back to the x/y params. Matches the Point-node pattern.
    const posIn = inputs.position;
    const target: [number, number] =
      posIn?.kind === "vec2"
        ? [posIn.value[0], posIn.value[1]]
        : [
            (params.x as number) ?? 0.5,
            (params.y as number) ?? 0.5,
          ];

    const src = inputs.in;

    if (mode === "points") {
      if (!src || src.kind !== "points") {
        return { primary: EMPTY_POINTS };
      }
      const n = src.count;
      if (n === 0) return { primary: src };
      // Centroid + shift in SoA — positions replaced, all else carries.
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += src.positions[i * 2];
        cy += src.positions[i * 2 + 1];
      }
      const dx = target[0] - cx / n;
      const dy = target[1] - cy / n;
      const positions = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        positions[i * 2] = src.positions[i * 2] + dx;
        positions[i * 2 + 1] = src.positions[i * 2 + 1] + dy;
      }
      return { primary: copyPointsWith(src, { positions }) };
    }

    // spline mode
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const c = centroidOfSpline(src);
    if (!c) {
      return { primary: src };
    }
    const dx = target[0] - c[0];
    const dy = target[1] - c[1];
    const out: SplineValue = {
      kind: "spline",
      subpaths: src.subpaths.map((sub) => shiftSubpath(sub, dx, dy)),
    };
    return { primary: out };
  },
};
