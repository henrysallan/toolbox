import * as THREE from "three";
import type {
  NodeDefinition,
  ParamDef,
  RenderContext,
} from "@/engine/types";
import type { Curve3DValue } from "@/engine/three-types";
import {
  buildCurveOutputs,
  curveFromValue,
  curveGeometryValue,
  curveSegmentCount,
} from "./curve-tube";

// =====================================================================
// 3D curve primitives — Rectangle / Circle / Polygon (M11)
// =====================================================================
//
// Parametric closed curves emitted as `curve3d` values (plus the family's
// standard tube geometry + path points), placed by the standard TRS
// params so the viewport gizmo drives them. Shapes are authored in the
// local XY plane and the TRS bakes into the curve's WORLD-space points at
// compute (curve3d carries plain coordinates — consumers never see a
// transform).
//
// Straight-edged shapes (rect, polygon) are bezier curves with
// zero-length handles (handle == anchor ⇒ a cubic that runs straight);
// the circle is the classic 4-anchor kappa-handle bezier (max radial
// error ~0.03% — indistinguishable at render scale). More primitives
// (spiral, star, arc…) extend this factory.

const DEG = Math.PI / 180;
const KAPPA = 0.5522847498307936;

const TRS_PARAMS: ParamDef[] = [
  { name: "pos_x", label: "Position X", type: "scalar", min: -10, max: 10, softMax: 5, step: 0.01, default: 0 },
  { name: "pos_y", label: "Position Y", type: "scalar", min: -10, max: 10, softMax: 5, step: 0.01, default: 0 },
  { name: "pos_z", label: "Position Z", type: "scalar", min: -10, max: 10, softMax: 5, step: 0.01, default: 0 },
  { name: "rot_x", label: "Rotation X (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
  { name: "rot_y", label: "Rotation Y (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
  { name: "rot_z", label: "Rotation Z (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0 },
  { name: "scale_x", label: "Scale X", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
  { name: "scale_y", label: "Scale Y", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
  { name: "scale_z", label: "Scale Z", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
];

const TUBE_PARAMS: ParamDef[] = [
  { name: "radius", label: "Tube radius", type: "scalar", min: 0.001, max: 1, softMax: 0.3, step: 0.001, default: 0.05 },
  { name: "radial_segments", label: "Radial segments", type: "scalar", min: 3, max: 24, step: 1, default: 8 },
  { name: "resolution", label: "Resolution", type: "scalar", min: 2, max: 64, softMax: 32, step: 1, default: 12 },
  { name: "sample_count", label: "Path points", type: "scalar", min: 2, max: 500, softMax: 100, step: 1, default: 20 },
];

const CURVE_AUX = [
  {
    name: "path_points",
    type: "points3d" as const,
    label: "path points",
    description:
      "Points sampled evenly along the curve (world space); normals carry the tangent.",
  },
  {
    name: "curve",
    type: "curve3d" as const,
    label: "curve",
    description:
      "The curve itself as a value — wire into Points on Path (and future curve consumers).",
  },
];

// Local-XY shape → anchors + handles ([in, out] flat, absolute).
interface Shape2D {
  anchors: [number, number][];
  handles: [number, number][]; // 2× anchors
}

interface CurvePrimState {
  geometry: THREE.BufferGeometry | null;
}

function makeCurvePrimitive(opts: {
  type: string;
  name: string;
  description: string;
  shapeParams: ParamDef[];
  buildShape: (p: Record<string, unknown>) => Shape2D;
}): NodeDefinition {
  const stateKey = (id: string) => `${opts.type}:${id}`;
  return {
    type: opts.type,
    name: opts.name,
    category: "3d",
    description: opts.description,
    backend: "webgl2",
    noMaskInput: true,
    inputs: [],
    params: [...opts.shapeParams, ...TRS_PARAMS, ...TUBE_PARAMS],
    primaryOutput: "geometry",
    auxOutputs: CURVE_AUX,

    compute({ params, ctx, nodeId }) {
      const key = stateKey(nodeId);
      let st = ctx.state[key] as CurvePrimState | undefined;
      if (!st) {
        st = { geometry: null };
        ctx.state[key] = st;
      }

      const shape = opts.buildShape(params);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(
          (params.pos_x as number) ?? 0,
          (params.pos_y as number) ?? 0,
          (params.pos_z as number) ?? 0
        ),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            ((params.rot_x as number) ?? 0) * DEG,
            ((params.rot_y as number) ?? 0) * DEG,
            ((params.rot_z as number) ?? 0) * DEG
          )
        ),
        new THREE.Vector3(
          (params.scale_x as number) ?? 1,
          (params.scale_y as number) ?? 1,
          (params.scale_z as number) ?? 1
        )
      );
      const v = new THREE.Vector3();
      const bake = (p: [number, number]): [number, number, number] => {
        v.set(p[0], p[1], 0).applyMatrix4(m);
        return [v.x, v.y, v.z];
      };

      const curveValue: Curve3DValue = {
        kind: "curve3d",
        mode: "bezier",
        points: shape.anchors.map(bake),
        handles: shape.handles.map(bake),
        closed: true,
        tension: 0.5,
      };
      const curve = curveFromValue(curveValue);
      if (!curve) return {};

      const { geometry, path } = buildCurveOutputs(curve, {
        closed: true,
        radius: (params.radius as number) ?? 0.05,
        radialSegments: Math.round((params.radial_segments as number) ?? 8),
        tubularSegments:
          Math.max(2, Math.round((params.resolution as number) ?? 12)) *
          curveSegmentCount(curveValue),
        sampleCount: Math.round((params.sample_count as number) ?? 20),
      });
      if (st.geometry) st.geometry.dispose();
      st.geometry = geometry;

      return {
        primary: curveGeometryValue(geometry, nodeId),
        aux: { path_points: path, curve: curveValue },
      };
    },

    dispose(ctx: RenderContext, nodeId: string) {
      const st = ctx.state[stateKey(nodeId)] as CurvePrimState | undefined;
      if (st?.geometry) st.geometry.dispose();
      delete ctx.state[stateKey(nodeId)];
    },
  };
}

// Straight edges: handle == anchor (zero-length) ⇒ the cubic is a line.
function straightShape(anchors: [number, number][]): Shape2D {
  const handles: [number, number][] = [];
  for (const a of anchors) handles.push([a[0], a[1]], [a[0], a[1]]);
  return { anchors, handles };
}

export const rectCurve3DNode = makeCurvePrimitive({
  type: "rect-3d",
  name: "3D Rectangle",
  description:
    "A rectangle as a 3D curve — tube render plus the curve value for Points on Path. Place it with the transform params or the viewport gizmo.",
  shapeParams: [
    { name: "width", label: "Width", type: "scalar", min: 0.01, max: 20, softMax: 5, step: 0.01, default: 2 },
    { name: "height", label: "Height", type: "scalar", min: 0.01, max: 20, softMax: 5, step: 0.01, default: 1.2 },
  ],
  buildShape(p) {
    const w = ((p.width as number) ?? 2) / 2;
    const h = ((p.height as number) ?? 1.2) / 2;
    return straightShape([
      [w, h],
      [-w, h],
      [-w, -h],
      [w, -h],
    ]);
  },
});

export const circleCurve3DNode = makeCurvePrimitive({
  type: "circle-3d",
  name: "3D Circle",
  description:
    "A circle as a 3D curve — tube render plus the curve value for Points on Path. Place it with the transform params or the viewport gizmo.",
  shapeParams: [
    { name: "shape_radius", label: "Radius", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
  ],
  buildShape(p) {
    const r = (p.shape_radius as number) ?? 1;
    const k = KAPPA * r;
    const anchors: [number, number][] = [
      [r, 0],
      [0, r],
      [-r, 0],
      [0, -r],
    ];
    // CCW; in-handle trails, out-handle leads.
    const handles: [number, number][] = [
      [r, -k], [r, k],
      [k, r], [-k, r],
      [-r, k], [-r, -k],
      [-k, -r], [k, -r],
    ];
    return { anchors, handles };
  },
});

export const polygonCurve3DNode = makeCurvePrimitive({
  type: "polygon-3d",
  name: "3D Polygon",
  description:
    "A regular polygon as a 3D curve — tube render plus the curve value for Points on Path. Place it with the transform params or the viewport gizmo.",
  shapeParams: [
    { name: "shape_radius", label: "Radius", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
    { name: "sides", label: "Sides", type: "scalar", min: 3, max: 24, step: 1, default: 6 },
  ],
  buildShape(p) {
    const r = (p.shape_radius as number) ?? 1;
    const n = Math.max(3, Math.round((p.sides as number) ?? 6));
    const anchors: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      // Start at the top, wind CCW.
      const a = Math.PI / 2 + (i / n) * Math.PI * 2;
      anchors.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return straightShape(anchors);
  },
});
