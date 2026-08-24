import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { Curve3DValue } from "@/engine/three-types";
import {
  buildCurveOutputs,
  curveFromValue,
  curveGeometryValue,
  curveSegmentCount,
} from "./curve-tube";
import type * as THREE from "three";

// =====================================================================
// 3D Spline — viewport-authored 3D curve (M10, unified modes M10.6)
// =====================================================================
//
// ONE node, two modes (header dropdown):
//   smooth — Catmull-Rom through the anchors (`points`), tension knob.
//   bezier — cubic chain with per-anchor in/out handles (`handles`, a
//            second hidden vec3_list: [in0, out0, in1, out1, …] flat,
//            world-space absolute).
//
// The split-array storage is what makes the mode switch LOSSLESS and
// back-compatible: `points` is always just the anchor list (M10 saves
// load unchanged), and when bezier mode finds missing or mismatched handles it
// synthesizes them from the Catmull-Rom tangents (the classic CR→bezier
// conversion, (next − prev)/6) — flipping smooth→bezier preserves the
// curve's shape exactly, then you refine. Handles ride along when the
// rig drags an anchor; `handle_mode` (mirrored/free) is enforced by the
// RIG on handle drags — compute never reads it.
//
// All points authored in the 3D viewport: selectable dots with transform
// controls (Scene3DViewport's rig writes the vec3_list params).
//
// Outputs (both modes):
//   primary `geometry` — a tube swept along the curve.
//   aux `path_points` — `points3d` sampled evenly, curve TANGENTS in the
//     normals channel (Copy to Points aligns copies along the path).

export const SPLINE3D_DEFAULT_POINTS: [number, number, number][] = [
  [-1.2, 0, 0],
  [-0.4, 0.8, 0],
  [0.4, -0.8, 0],
  [1.2, 0, 0],
];

interface Spline3DState {
  geometry: THREE.BufferGeometry | null;
}

function readVec3List(raw: unknown): [number, number, number][] {
  if (!Array.isArray(raw)) return [];
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
  return out;
}

function readPoints(raw: unknown): [number, number, number][] {
  const out = readVec3List(raw);
  return out.length >= 2 ? out : SPLINE3D_DEFAULT_POINTS;
}

// CR→bezier handle synthesis: in_i/out_i = a_i ∓ (next − prev)/6 — the
// exact tension-0.5 Catmull-Rom conversion on closed curves, endpoint-
// clamped on open ones. Shared with EffectsApp (which materializes the
// effective handles for the editing rig) so curve and dots always agree.
export function synthesizeBezierHandles(
  pts: [number, number, number][],
  closed: boolean
): [number, number, number][] {
  const n = pts.length;
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const dx = (next[0] - prev[0]) / 6;
    const dy = (next[1] - prev[1]) / 6;
    const dz = (next[2] - prev[2]) / 6;
    const a = pts[i];
    out.push([a[0] - dx, a[1] - dy, a[2] - dz]); // in
    out.push([a[0] + dx, a[1] + dy, a[2] + dz]); // out
  }
  return out;
}

// Effective handles: the stored array when it matches the anchor count,
// else synthesized (mode just flipped, or anchors were added in smooth
// mode). Exported for EffectsApp's rig prop.
export function effectiveBezierHandles(
  pts: [number, number, number][],
  raw: unknown,
  closed: boolean
): [number, number, number][] {
  const stored = readVec3List(raw);
  return stored.length === pts.length * 2
    ? stored
    : synthesizeBezierHandles(pts, closed);
}

export const spline3DNode: NodeDefinition = {
  type: "spline-3d",
  name: "3D Spline",
  category: "3d",
  description:
    "A 3D curve drawn through control points, edited in the viewport with per-point transform controls (+/− in the viewport toolbar add and remove points). Smooth mode curves through the anchors; Bezier mode adds per-anchor handles (mirrored or free) — switching modes keeps the shape. Outputs a tube along the curve, plus path points whose normals follow the curve's direction.",
  backend: "webgl2",
  noMaskInput: true,
  headerControl: { paramName: "mode" },
  inputs: [],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["smooth", "bezier"],
      default: "smooth",
      control: "segmented",
    },
    {
      name: "handle_mode",
      label: "Handles",
      type: "enum",
      options: ["mirrored", "free"],
      default: "mirrored",
      control: "segmented",
      // Rig-enforced editing behavior (dragging one handle mirrors its
      // partner across the anchor); compute never reads it.
      visibleIf: (p) => p.mode === "bezier",
    },
    {
      name: "points",
      label: "Points",
      type: "vec3_list",
      default: SPLINE3D_DEFAULT_POINTS,
      hidden: true,
    },
    {
      // Bezier handles, [in0, out0, in1, out1, …] world-absolute. Empty/
      // mismatched ⇒ synthesized from the smooth tangents at eval + edit
      // time; the rig materializes it on first handle edit.
      name: "handles",
      label: "Handles data",
      type: "vec3_list",
      default: [],
      hidden: true,
    },
    { name: "closed", label: "Closed", type: "boolean", default: false },
    {
      name: "tension",
      label: "Tension",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => (p.mode ?? "smooth") === "smooth",
    },
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
      default: 12,
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
    {
      name: "curve",
      type: "curve3d",
      label: "curve",
      description:
        "The curve itself as a value — wire into Points on Path (and future curve consumers) to sample it with their own controls.",
    },
  ],

  compute({ params, ctx, nodeId }) {
    const key = `spline-3d:${nodeId}`;
    let st = ctx.state[key] as Spline3DState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const pts = readPoints(params.points);
    const closed = (params.closed as boolean) ?? false;
    const tension = (params.tension as number) ?? 0.5;
    const radius = (params.radius as number) ?? 0.05;
    const radialSegments = Math.max(
      3,
      Math.round((params.radial_segments as number) ?? 8)
    );
    const resolution = Math.max(
      2,
      Math.round((params.resolution as number) ?? 12)
    );
    const sampleCount = Math.max(
      2,
      Math.min(500, Math.round((params.sample_count as number) ?? 20))
    );

    const mode = ((params.mode as string) ?? "smooth") as "smooth" | "bezier";
    // The curve as a VALUE (also the `curve` aux) — one descriptor, one
    // interpreter (curveFromValue), so the tube and every downstream
    // consumer read the identical curve.
    const curveValue: Curve3DValue = {
      kind: "curve3d",
      mode,
      points: pts,
      handles:
        mode === "bezier"
          ? effectiveBezierHandles(pts, params.handles, closed)
          : undefined,
      closed,
      tension,
    };
    const curve = curveFromValue(curveValue) as THREE.Curve<THREE.Vector3>;

    const { geometry, path } = buildCurveOutputs(curve, {
      closed,
      radius,
      radialSegments,
      tubularSegments: resolution * curveSegmentCount(curveValue),
      sampleCount,
    });
    if (st.geometry) st.geometry.dispose();
    st.geometry = geometry;

    return {
      primary: curveGeometryValue(geometry, nodeId),
      aux: { path_points: path, curve: curveValue },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `spline-3d:${nodeId}`;
    const st = ctx.state[key] as Spline3DState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
