import * as THREE from "three";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import { buildCurveOutputs, curveGeometryValue } from "./curve-tube";

// =====================================================================
// 3D Bezier Path — cubic bezier chain with editable handles (M10.5)
// =====================================================================
//
// The full pen-tool curve in 3D: cubic bezier segments through anchors
// with per-anchor in/out handles, ALL editable in the viewport (anchors
// as large dots, handles as smaller dots tethered to their anchor by
// lines; dragging an anchor carries its handles — Scene3DViewport's
// bezier mode).
//
// Data model: the SAME `vec3_list` param as 3D Spline, with a STRIDE-3
// convention — [anchor, inHandle, outHandle] per point, all WORLD-space
// absolute (the rig owns the carry-on-anchor-drag rule; storing
// absolute keeps every entry a plain draggable vec3, which is what lets
// one editing rig serve both curve nodes). Segment i runs
// anchor_i → out_i → in_{i+1} → anchor_{i+1}; closed adds the wrap
// segment. The first anchor's in-handle and last's out-handle are inert
// on open paths (they engage when Closed is on).
//
// Outputs match 3D Spline: tube geometry + tangent-carrying path points
// (curve-tube.ts).

export const BEZIER3D_DEFAULT_POINTS: [number, number, number][] = [
  // anchor 0, in 0, out 0
  [-1, 0, 0],
  [-1.4, -0.5, 0],
  [-0.5, 0.5, 0],
  // anchor 1, in 1, out 1
  [1, 0, 0],
  [0.5, 0.5, 0],
  [1.4, -0.5, 0],
];

interface BezierState {
  geometry: THREE.BufferGeometry | null;
}

function readTriples(raw: unknown): [number, number, number][] {
  if (!Array.isArray(raw)) return BEZIER3D_DEFAULT_POINTS;
  const out: [number, number, number][] = [];
  for (const p of raw) {
    if (
      Array.isArray(p) &&
      p.length >= 3 &&
      p.every((v) => typeof v === "number" && isFinite(v))
    ) {
      out.push([p[0], p[1], p[2]]);
    }
  }
  // Whole triples only, ≥ 2 anchors.
  const triples = Math.floor(out.length / 3);
  if (triples < 2) return BEZIER3D_DEFAULT_POINTS;
  return out.slice(0, triples * 3);
}

const v = (p: [number, number, number]) => new THREE.Vector3(p[0], p[1], p[2]);

export const bezierPath3DNode: NodeDefinition = {
  type: "bezier-path-3d",
  name: "3D Bezier Path",
  category: "3d",
  // Retired from the menu one day after shipping (M10.6): 3D Spline is now
  // ONE node with smooth/bezier modes (split points+handles storage).
  // Registration stays so any saved graph from the interim keeps computing;
  // viewport editing for this legacy def is no longer offered.
  hidden: true,
  description:
    "A cubic bezier curve in 3D — anchors with in/out handles, all editable in the viewport (the pen tool's 3D cousin). Dragging an anchor carries its handles. Outputs a tube along the curve plus path points whose normals follow the curve.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "points",
      label: "Points",
      type: "vec3_list",
      default: BEZIER3D_DEFAULT_POINTS,
      hidden: true,
    },
    { name: "closed", label: "Closed", type: "boolean", default: false },
    {
      name: "radius",
      label: "Tube radius",
      type: "scalar",
      min: 0.001,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "radial_segments",
      label: "Radial segments",
      type: "scalar",
      min: 3,
      max: 24,
      step: 1,
      default: 8,
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 2,
      max: 64,
      softMax: 32,
      step: 1,
      default: 16,
    },
    {
      name: "sample_count",
      label: "Path points",
      type: "scalar",
      min: 2,
      max: 500,
      softMax: 100,
      step: 1,
      default: 20,
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [
    {
      name: "path_points",
      type: "points3d",
      label: "path points",
      description:
        "Points sampled evenly along the curve (world space). Normals carry the curve tangent — Copy to Points' align-to-normal orients copies along the path.",
    },
  ],

  compute({ params, ctx, nodeId }) {
    const key = `bezier-path-3d:${nodeId}`;
    let st = ctx.state[key] as BezierState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const pts = readTriples(params.points);
    const anchors = pts.length / 3;
    const closed = (params.closed as boolean) ?? false;

    const path3 = new THREE.CurvePath<THREE.Vector3>();
    const segCount = closed ? anchors : anchors - 1;
    for (let s = 0; s < segCount; s++) {
      const a = s;
      const b = (s + 1) % anchors;
      path3.add(
        new THREE.CubicBezierCurve3(
          v(pts[a * 3]),
          v(pts[a * 3 + 2]), // out handle of a
          v(pts[b * 3 + 1]), // in handle of b
          v(pts[b * 3])
        )
      );
    }

    const { geometry, path } = buildCurveOutputs(path3, {
      closed,
      radius: (params.radius as number) ?? 0.05,
      radialSegments: Math.round((params.radial_segments as number) ?? 8),
      tubularSegments:
        Math.max(2, Math.round((params.resolution as number) ?? 16)) * segCount,
      sampleCount: Math.round((params.sample_count as number) ?? 20),
    });
    if (st.geometry) st.geometry.dispose();
    st.geometry = geometry;

    return {
      primary: curveGeometryValue(geometry, nodeId),
      aux: { path_points: path },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `bezier-path-3d:${nodeId}`;
    const st = ctx.state[key] as BezierState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
