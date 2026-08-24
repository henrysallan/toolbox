import * as THREE from "three";
import type { NodeDefinition, RenderContext, SplineValue } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { sampleSubpathWorld } from "@/engine/three-spline";

// =====================================================================
// Lathe — profile revolve (M6, 081026 spec)
// =====================================================================
//
// Revolves the spline's FIRST subpath around the Y axis: the profile's
// horizontal distance from the authored center (x = 0.5) becomes the
// radius, its authored y becomes height (flipped to Y-up). Draw a
// half-outline to the right of canvas center → vase/column/pawn. Sweep
// < 1 leaves the revolve open (cutaway).

interface LatheState {
  geometry: THREE.BufferGeometry | null;
}

export const lathe3DNode: NodeDefinition = {
  type: "lathe-3d",
  name: "Lathe",
  category: "3d",
  description:
    "Revolves a drawn profile around the vertical axis — the spline's distance from canvas center is the radius. Draw half an outline, get a vase. Chain Transform 3D to place it and Material to style it.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "profile", type: "spline", required: true }],
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
      name: "segments",
      label: "Segments",
      type: "scalar",
      min: 3,
      max: 128,
      softMax: 64,
      step: 1,
      default: 48,
    },
    {
      name: "sweep",
      label: "Sweep",
      type: "scalar",
      min: 0.01,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "resolution",
      label: "Profile resolution",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 24,
      step: 1,
      default: 12,
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const spline = inputs.profile as SplineValue | undefined;
    if (!spline || spline.kind !== "spline" || spline.subpaths.length === 0)
      return {};
    const key = `lathe-3d:${nodeId}`;
    let st = ctx.state[key] as LatheState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const size = (params.size as number) ?? 2;
    const segments = Math.max(3, Math.round((params.segments as number) ?? 48));
    const sweep = Math.max(0.01, Math.min(1, (params.sweep as number) ?? 1));
    const perSeg = Math.max(1, Math.round((params.resolution as number) ?? 12));

    const pts = sampleSubpathWorld(spline.subpaths[0], size, perSeg);
    if (pts.length < 2) return {};
    // Radius = |distance from the authored center|; y is already world.
    const profile = pts.map(
      ([wx, wy]) => new THREE.Vector2(Math.abs(wx), wy)
    );

    const geom = new THREE.LatheGeometry(
      profile,
      segments,
      0,
      Math.PI * 2 * sweep
    );

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
    const key = `lathe-3d:${nodeId}`;
    const st = ctx.state[key] as LatheState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
