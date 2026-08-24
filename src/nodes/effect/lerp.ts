import type {
  InputSocketDef,
  NodeDefinition,
  PointAttribute,
  PointsValue,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";

// Linear interpolation between two values by `t`. Polymorphic across
// the basic shapes you'd want to mix:
//
//   scalar  : (1-t) * a + t * b
//   vec2    : per-component lerp
//   points  : per-point position lerp; per-point scale/rotation lerp
//             too if both sides carry them. Counts must match — when
//             they don't we fall through to A so the graph stays
//             producing something usable.
//   spline  : per-subpath, per-anchor lerp. Counts (subpaths and
//             anchors-per-subpath) must match; otherwise pass A.
//
// `t` is taken from the `t` input when wired, otherwise from the param.
// `clamp` clips t to [0, 1] before mixing — handy when t comes from
// an LFO that might overshoot.

const TYPES = ["scalar", "vec2", "points", "spline"] as const;
type Type = (typeof TYPES)[number];

function activeType(params: Record<string, unknown>): Type {
  const t = (params.type as Type) ?? "scalar";
  return (TYPES as readonly string[]).includes(t) ? t : "scalar";
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPoints(
  a: PointsValue,
  b: PointsValue,
  t: number
): PointsValue {
  if (a.count !== b.count) return a;
  const n = a.count;
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) {
    positions[i] = lerp(a.positions[i], b.positions[i], t);
  }
  let scales: Float32Array | undefined;
  if (a.scales || b.scales) {
    scales = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const ax = a.scales ? a.scales[i * 2] : 1;
      const ay = a.scales ? a.scales[i * 2 + 1] : 1;
      const bx = b.scales ? b.scales[i * 2] : 1;
      const by = b.scales ? b.scales[i * 2 + 1] : 1;
      scales[i * 2] = lerp(ax, bx, t);
      scales[i * 2 + 1] = lerp(ay, by, t);
    }
  }
  let rotations: Float32Array | undefined;
  if (a.rotations || b.rotations) {
    rotations = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ar = a.rotations ? a.rotations[i] : 0;
      const br = b.rotations ? b.rotations[i] : 0;
      rotations[i] = lerp(ar, br, t);
    }
  }
  // 3D data: lerp z when both sides carry it; a lone A-side z passes
  // through the copy below so the value never silently flattens to 2D.
  // Normals lerp + renormalize (a straight lerp shortens them).
  let z: Float32Array | undefined;
  if (a.z && b.z) {
    z = new Float32Array(n);
    for (let i = 0; i < n; i++) z[i] = lerp(a.z[i], b.z[i], t);
  }
  let normals: Float32Array | undefined;
  if (a.normals && b.normals) {
    normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const nx = lerp(a.normals[i * 3], b.normals[i * 3], t);
      const ny = lerp(a.normals[i * 3 + 1], b.normals[i * 3 + 1], t);
      const nz = lerp(a.normals[i * 3 + 2], b.normals[i * 3 + 2], t);
      const len = Math.hypot(nx, ny, nz);
      const inv = len > 1e-8 ? 1 / len : 0;
      normals[i * 3] = nx * inv;
      normals[i * 3 + 1] = ny * inv;
      normals[i * 3 + 2] = nz * inv;
    }
  }
  // Named channels: lerp where both sides carry the channel at the same
  // arity; A-only channels ride the copy below untouched; B-only channels
  // drop (A is the identity side, same reasoning as groupIndices).
  let attributes: Record<string, PointAttribute> | undefined;
  if (a.attributes && b.attributes) {
    attributes = {};
    for (const name of Object.keys(a.attributes)) {
      const aa = a.attributes[name];
      const ba = b.attributes[name];
      if (ba && ba.arity === aa.arity) {
        const data = new Float32Array(n * aa.arity);
        for (let i = 0; i < data.length; i++) {
          data[i] = lerp(aa.data[i], ba.data[i], t);
        }
        attributes[name] = { arity: aa.arity, color: aa.color, data };
      } else {
        attributes[name] = aa;
      }
    }
  }
  // copyPointsWith carries groupIndices from A untouched — they're
  // identity tags, not numeric attributes, so interpolating them would
  // be meaningless.
  return copyPointsWith(a, {
    positions,
    scales,
    rotations,
    ...(z ? { z } : {}),
    ...(normals ? { normals } : {}),
    ...(attributes ? { attributes } : {}),
  });
}

function lerpSpline(a: SplineValue, b: SplineValue, t: number): SplineValue {
  if (a.subpaths.length !== b.subpaths.length) return a;
  const subpaths: SplineSubpath[] = [];
  for (let s = 0; s < a.subpaths.length; s++) {
    const subA = a.subpaths[s];
    const subB = b.subpaths[s];
    if (subA.anchors.length !== subB.anchors.length) return a;
    const anchors = subA.anchors.map((anchor, i) => {
      const other = subB.anchors[i];
      return {
        pos: [
          lerp(anchor.pos[0], other.pos[0], t),
          lerp(anchor.pos[1], other.pos[1], t),
        ] as [number, number],
        inHandle:
          anchor.inHandle || other.inHandle
            ? ([
                lerp(
                  anchor.inHandle?.[0] ?? 0,
                  other.inHandle?.[0] ?? 0,
                  t
                ),
                lerp(
                  anchor.inHandle?.[1] ?? 0,
                  other.inHandle?.[1] ?? 0,
                  t
                ),
              ] as [number, number])
            : undefined,
        outHandle:
          anchor.outHandle || other.outHandle
            ? ([
                lerp(
                  anchor.outHandle?.[0] ?? 0,
                  other.outHandle?.[0] ?? 0,
                  t
                ),
                lerp(
                  anchor.outHandle?.[1] ?? 0,
                  other.outHandle?.[1] ?? 0,
                  t
                ),
              ] as [number, number])
            : undefined,
      };
    });
    subpaths.push({
      anchors,
      // Topology (closed flag, group-identity tag) is preserved from A.
      closed: subA.closed,
      groupIndex: subA.groupIndex,
    });
  }
  return { kind: "spline", subpaths };
}

export const lerpNode: NodeDefinition = {
  type: "lerp",
  name: "Lerp",
  category: "utility",
  description:
    "Linear interpolation (mix) between A and B by t. Works on scalars, vec2, points sets, or splines (matching counts required for points/splines). t can be wired or set in the panel; Clamp restricts it to [0..1].",
  // This is the Mix node of other packages (Blender's Mix, GLSL mix()
  // with its fac) — alias so searching those names lands here.
  searchAliases: ["mix", "fac", "interpolate"],
  backend: "webgl2",
  headerControl: { paramName: "type" },
  inputs: [
    { name: "a", type: "scalar", required: false, label: "A" },
    { name: "b", type: "scalar", required: false, label: "B" },
    { name: "t", type: "scalar", required: false, label: "t" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const t = activeType(params);
    const inner: SocketType = t;
    return [
      { name: "a", type: inner, required: false, label: "A" },
      { name: "b", type: inner, required: false, label: "B" },
      { name: "t", type: "scalar", required: false, label: "t" },
    ];
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
      name: "t",
      label: "t",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "clamp",
      label: "Clamp t to [0..1]",
      type: "boolean",
      default: false,
    },
    {
      name: "a_value",
      label: "A",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.type === "scalar",
    },
    {
      name: "b_value",
      label: "B",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.type === "scalar",
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params): SocketType {
    return activeType(params);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const type = activeType(params);
    let t =
      inputs.t?.kind === "scalar"
        ? inputs.t.value
        : ((params.t as number) ?? 0.5);
    if (params.clamp) t = Math.max(0, Math.min(1, t));

    if (type === "scalar") {
      const a =
        inputs.a?.kind === "scalar"
          ? inputs.a.value
          : ((params.a_value as number) ?? 0);
      const b =
        inputs.b?.kind === "scalar"
          ? inputs.b.value
          : ((params.b_value as number) ?? 1);
      return { primary: { kind: "scalar", value: lerp(a, b, t) } };
    }

    if (type === "vec2") {
      const a = inputs.a?.kind === "vec2" ? inputs.a.value : ([0, 0] as [number, number]);
      const b = inputs.b?.kind === "vec2" ? inputs.b.value : ([0, 0] as [number, number]);
      return {
        primary: {
          kind: "vec2",
          value: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)],
        },
      };
    }

    if (type === "points") {
      const a = inputs.a?.kind === "points" ? inputs.a : null;
      const b = inputs.b?.kind === "points" ? inputs.b : null;
      if (a && b) return { primary: lerpPoints(a, b, t) };
      if (a) return { primary: a };
      if (b) return { primary: b };
      return { primary: EMPTY_POINTS };
    }

    // spline
    const a = inputs.a?.kind === "spline" ? inputs.a : null;
    const b = inputs.b?.kind === "spline" ? inputs.b : null;
    if (a && b) return { primary: lerpSpline(a, b, t) };
    if (a) return { primary: a };
    if (b) return { primary: b };
    return { primary: { kind: "spline", subpaths: [] } };
  },
};
