import * as THREE from "three";
import type { NodeDefinition, RenderContext, SplineValue } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { splineToShapes } from "@/engine/three-spline";

// =====================================================================
// Extrude Spline — the 2D→3D bridge (M6, 081026 spec)
// =====================================================================
//
// Any spline — drawn, boolean'd, offset, trimmed, morphing, SVG-pasted,
// or Text's spline aux (extruded type = wire it in, no dedicated node) —
// becomes solid 3D geometry via three's ExtrudeGeometry, with its
// built-in bevel. Multi-subpath splines get winding-based hole detection
// (engine/three-spline.ts): a subpath wound opposite its container reads
// as a hole.
//
// Deliberately LEAN: no TRS params (Transform 3D), no material params
// (Material) — this node is the modeling chain's entry, not a kitchen
// sink. Output is z-centered at the origin, identity transform.

interface ExtrudeSplineState {
  geometry: THREE.BufferGeometry | null;
}

export const extrudeSpline3DNode: NodeDefinition = {
  type: "extrude-spline-3d",
  name: "Extrude Spline",
  category: "3d",
  description:
    "Turns any spline into solid 3D geometry — draw a shape (or wire Text's spline output) and give it depth, with optional rounded bevel. Chain Transform 3D to place it and Material to style it.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "spline", type: "spline", required: true }],
  params: [
    {
      name: "size",
      label: "Size",
      type: "scalar",
      min: 0.1,
      max: 20,
      softMax: 10,
      step: 0.01,
      default: 2,
    },
    {
      name: "depth",
      label: "Depth",
      type: "scalar",
      min: 0.01,
      max: 5,
      softMax: 2,
      step: 0.001,
      default: 0.4,
    },
    {
      name: "resolution",
      label: "Curve resolution",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 24,
      step: 1,
      default: 12,
    },
    {
      name: "bevel",
      label: "Bevel",
      type: "boolean",
      default: false,
    },
    {
      name: "bevel_size",
      label: "Bevel size",
      type: "scalar",
      min: 0,
      max: 0.5,
      step: 0.001,
      default: 0.03,
      visibleIf: (p) => !!p.bevel,
    },
    {
      name: "bevel_segments",
      label: "Bevel segments",
      type: "scalar",
      min: 1,
      max: 12,
      step: 1,
      default: 3,
      visibleIf: (p) => !!p.bevel,
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const spline = inputs.spline as SplineValue | undefined;
    if (!spline || spline.kind !== "spline") return {};
    const key = `extrude-spline-3d:${nodeId}`;
    let st = ctx.state[key] as ExtrudeSplineState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const size = (params.size as number) ?? 2;
    const depth = (params.depth as number) ?? 0.4;
    const curveSegments = Math.max(
      1,
      Math.round((params.resolution as number) ?? 12)
    );
    const bevel = !!params.bevel;
    const bevelSize = (params.bevel_size as number) ?? 0.03;
    const bevelSegments = Math.max(
      1,
      Math.round((params.bevel_segments as number) ?? 3)
    );

    const shapes = splineToShapes(spline, size);
    if (shapes.length === 0) return {};

    const geom = new THREE.ExtrudeGeometry(shapes, {
      depth,
      curveSegments,
      bevelEnabled: bevel,
      bevelSize,
      bevelThickness: bevelSize,
      bevelSegments,
      // Keep the silhouette at the authored size: bevel eats inward.
      bevelOffset: bevel ? -bevelSize : 0,
    });
    // Extrude runs 0..depth along +Z — center it on the origin.
    geom.translate(0, 0, -depth / 2);

    if (st.geometry) st.geometry.dispose();
    st.geometry = geom;

    const out: GeometryValue = {
      kind: "geometry",
      geometry: geom,
      nodeId,
      transform: {
        position: [0, 0, 0],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
      materials: [null],
    };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `extrude-spline-3d:${nodeId}`;
    const st = ctx.state[key] as ExtrudeSplineState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
