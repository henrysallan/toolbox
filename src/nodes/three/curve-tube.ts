import * as THREE from "three";
import type { PointsValue } from "@/engine/types";
import type { Curve3DValue, GeometryValue } from "@/engine/three-types";
import { makePoints } from "@/engine/points";

// =====================================================================
// Shared curve → (tube geometry + path points) builder (M10/M10.5)
// =====================================================================
//
// 3D Spline (Catmull-Rom) and 3D Bezier Path (cubic chain) differ only
// in how they construct the THREE.Curve — the tube sweep and the
// tangent-carrying path-points sampling are identical, so they live
// here once.

// Rebuild a THREE.Curve from a Curve3DValue descriptor — THE
// interpretation of the curve3d wire type (every consumer goes through
// this, so bezier-vs-smooth semantics can't drift between nodes). Null
// when the value has fewer than 2 anchors. Bezier requires a matching
// handles array (producers guarantee it — effectiveBezierHandles);
// mismatches fall back to the smooth reading.
export function curveFromValue(
  v: Curve3DValue
): THREE.Curve<THREE.Vector3> | null {
  const pts = v.points;
  if (pts.length < 2) return null;
  const vec = (p: [number, number, number]) =>
    new THREE.Vector3(p[0], p[1], p[2]);
  if (v.mode === "bezier" && v.handles?.length === pts.length * 2) {
    const cp = new THREE.CurvePath<THREE.Vector3>();
    const n = pts.length;
    const segs = v.closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      const a = s;
      const b = (s + 1) % n;
      cp.add(
        new THREE.CubicBezierCurve3(
          vec(pts[a]),
          vec(v.handles[a * 2 + 1]),
          vec(v.handles[b * 2]),
          vec(pts[b])
        )
      );
    }
    return cp;
  }
  return new THREE.CatmullRomCurve3(
    pts.map(vec),
    v.closed,
    "catmullrom",
    v.tension
  );
}

// Segment count for tubularSegments scaling (resolution × segments).
export function curveSegmentCount(v: Curve3DValue): number {
  return Math.max(1, v.closed ? v.points.length : v.points.length - 1);
}

export interface CurveTubeParams {
  closed: boolean;
  radius: number;
  radialSegments: number;
  tubularSegments: number;
  sampleCount: number;
}

export function buildCurveOutputs(
  curve: THREE.Curve<THREE.Vector3>,
  p: CurveTubeParams
): { geometry: THREE.BufferGeometry; path: PointsValue } {
  const geometry = new THREE.TubeGeometry(
    // TubeGeometry's typing wants a Curve<Vector3>; CurvePath satisfies it
    // structurally.
    curve as THREE.CatmullRomCurve3,
    Math.max(2, p.tubularSegments),
    p.radius,
    Math.max(3, p.radialSegments),
    p.closed
  );

  const n = Math.max(2, Math.min(500, p.sampleCount));
  const path: PointsValue = makePoints(n, { withZ: true, withNormals: true });
  for (let i = 0; i < n; i++) {
    // Closed curves skip the duplicate end sample.
    const t = p.closed ? i / n : i / (n - 1);
    const pt = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    path.positions[i * 2] = pt.x;
    path.positions[i * 2 + 1] = pt.y;
    path.z![i] = pt.z;
    path.normals![i * 3] = tan.x;
    path.normals![i * 3 + 1] = tan.y;
    path.normals![i * 3 + 2] = tan.z;
  }
  return { geometry, path };
}

// The identity transform + material slot shape every curve node emits.
export function curveGeometryValue(
  geometry: THREE.BufferGeometry,
  nodeId: string
): GeometryValue {
  return {
    kind: "geometry",
    geometry,
    nodeId,
    transform: {
      position: [0, 0, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    },
    materials: [null],
  };
}
