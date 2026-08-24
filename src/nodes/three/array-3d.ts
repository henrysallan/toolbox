import * as THREE from "three";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { GeometryValue, InstancesValue } from "@/engine/three-types";
import { disposeInstancesFor } from "@/engine/three-geometry";

// =====================================================================
// 3D Array — instancing without points (M6, 081026 spec)
// =====================================================================
//
// The motion-graphics staple: N copies in a line, a circle, or a grid,
// emitted as an `instances` stream (chain Instance Color / Instance
// Transform, resolve at the scene — one draw call).
//
//   linear — per-step world offset + per-step Y rotation + per-step
//            scale multiplier (stacked/spiraling towers).
//   radial — count around an axis at radius; sweep < 360 for arcs;
//            "align" faces copies outward along the circle.
//   grid   — X×Y×Z lattice with per-axis spacing, centered on origin.

type Mode = "linear" | "radial" | "grid";

interface ArrayState {
  retainKey: object;
}

export const array3DNode: NodeDefinition = {
  type: "array-3d",
  name: "3D Array",
  category: "3d",
  description:
    "Repeats geometry as an instance stream — a line with per-step offset/rotation/scale, a circle with optional outward alignment, or a centered grid. One draw call at any count.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "geometry", type: "geometry", required: true }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["linear", "radial", "grid"],
      default: "linear",
      control: "segmented",
    },
    // linear + radial
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 1000,
      softMax: 64,
      step: 1,
      default: 6,
      visibleIf: (p) => p.mode !== "grid",
    },
    // linear
    { name: "offset_x", label: "Offset X", type: "scalar", min: -5, max: 5, step: 0.01, default: 0.8, visibleIf: (p) => p.mode === "linear" },
    { name: "offset_y", label: "Offset Y", type: "scalar", min: -5, max: 5, step: 0.01, default: 0, visibleIf: (p) => p.mode === "linear" },
    { name: "offset_z", label: "Offset Z", type: "scalar", min: -5, max: 5, step: 0.01, default: 0, visibleIf: (p) => p.mode === "linear" },
    { name: "rot_step", label: "Rotate/step (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0, visibleIf: (p) => p.mode === "linear" },
    { name: "scale_step", label: "Scale/step", type: "scalar", min: 0.5, max: 1.5, step: 0.001, default: 1, visibleIf: (p) => p.mode === "linear" },
    // radial
    { name: "radius", label: "Radius", type: "scalar", min: 0, max: 10, softMax: 5, step: 0.01, default: 1.5, visibleIf: (p) => p.mode === "radial" },
    { name: "sweep", label: "Sweep (°)", type: "scalar", min: 1, max: 360, step: 0.1, default: 360, visibleIf: (p) => p.mode === "radial" },
    {
      name: "axis",
      label: "Axis",
      type: "enum",
      options: ["y", "x", "z"],
      default: "y",
      control: "segmented",
      visibleIf: (p) => p.mode === "radial",
    },
    { name: "align", label: "Align outward", type: "boolean", default: true, visibleIf: (p) => p.mode === "radial" },
    // grid
    { name: "count_x", label: "Count X", type: "scalar", min: 1, max: 32, step: 1, default: 3, visibleIf: (p) => p.mode === "grid" },
    { name: "count_y", label: "Count Y", type: "scalar", min: 1, max: 32, step: 1, default: 3, visibleIf: (p) => p.mode === "grid" },
    { name: "count_z", label: "Count Z", type: "scalar", min: 1, max: 32, step: 1, default: 1, visibleIf: (p) => p.mode === "grid" },
    { name: "spacing_x", label: "Spacing X", type: "scalar", min: 0.01, max: 5, step: 0.01, default: 1, visibleIf: (p) => p.mode === "grid" },
    { name: "spacing_y", label: "Spacing Y", type: "scalar", min: 0.01, max: 5, step: 0.01, default: 1, visibleIf: (p) => p.mode === "grid" },
    { name: "spacing_z", label: "Spacing Z", type: "scalar", min: 0.01, max: 5, step: 0.01, default: 1, visibleIf: (p) => p.mode === "grid" },
  ],
  primaryOutput: "instances",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};
    const key = `array-3d:${nodeId}`;
    let st = ctx.state[key] as ArrayState | undefined;
    if (!st) {
      st = { retainKey: {} };
      ctx.state[key] = st;
    }

    const mode = ((params.mode as string) ?? "linear") as Mode;
    let n: number;
    if (mode === "grid") {
      const cx = Math.max(1, Math.round((params.count_x as number) ?? 3));
      const cy = Math.max(1, Math.round((params.count_y as number) ?? 3));
      const cz = Math.max(1, Math.round((params.count_z as number) ?? 1));
      n = Math.min(10000, cx * cy * cz);
    } else {
      n = Math.max(1, Math.min(1000, Math.round((params.count as number) ?? 6)));
    }

    const positions = new Float32Array(n * 3);
    const quaternions = new Float32Array(n * 4);
    const scales = new Float32Array(n * 3);
    const q = new THREE.Quaternion();
    const setInst = (i: number, x: number, y: number, z: number, sc = 1) => {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      quaternions[i * 4] = q.x;
      quaternions[i * 4 + 1] = q.y;
      quaternions[i * 4 + 2] = q.z;
      quaternions[i * 4 + 3] = q.w;
      scales[i * 3] = sc;
      scales[i * 3 + 1] = sc;
      scales[i * 3 + 2] = sc;
    };

    if (mode === "linear") {
      const ox = (params.offset_x as number) ?? 0.8;
      const oy = (params.offset_y as number) ?? 0;
      const oz = (params.offset_z as number) ?? 0;
      const rotStep = (((params.rot_step as number) ?? 0) * Math.PI) / 180;
      const scaleStep = (params.scale_step as number) ?? 1;
      const yAxis = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < n; i++) {
        q.setFromAxisAngle(yAxis, rotStep * i);
        setInst(i, ox * i, oy * i, oz * i, Math.pow(scaleStep, i));
      }
    } else if (mode === "radial") {
      const radius = (params.radius as number) ?? 1.5;
      const sweep = (((params.sweep as number) ?? 360) * Math.PI) / 180;
      const axisName = ((params.axis as string) ?? "y") as "x" | "y" | "z";
      const align = (params.align as boolean) ?? true;
      const full = Math.abs(sweep - Math.PI * 2) < 1e-6;
      // Full circles distribute n evenly (no overlap at the seam); arcs
      // include both endpoints.
      const step = full ? sweep / n : n > 1 ? sweep / (n - 1) : 0;
      const axis =
        axisName === "x"
          ? new THREE.Vector3(1, 0, 0)
          : axisName === "z"
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);
      const base = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const a = step * i;
        // Radial direction: rotate a reference vector perpendicular to
        // the axis. Y axis → circle in XZ starting at +X; X → YZ; Z → XY.
        if (axisName === "y") base.set(Math.cos(a), 0, -Math.sin(a));
        else if (axisName === "x") base.set(0, Math.cos(a), Math.sin(a));
        else base.set(Math.cos(a), Math.sin(a), 0);
        if (align) q.setFromAxisAngle(axis, a);
        else q.identity();
        setInst(i, base.x * radius, base.y * radius, base.z * radius);
      }
    } else {
      const cx = Math.max(1, Math.round((params.count_x as number) ?? 3));
      const cy = Math.max(1, Math.round((params.count_y as number) ?? 3));
      const cz = Math.max(1, Math.round((params.count_z as number) ?? 1));
      const sx = (params.spacing_x as number) ?? 1;
      const sy = (params.spacing_y as number) ?? 1;
      const sz = (params.spacing_z as number) ?? 1;
      q.identity();
      let i = 0;
      for (let z = 0; z < cz && i < n; z++)
        for (let y = 0; y < cy && i < n; y++)
          for (let x = 0; x < cx && i < n; x++) {
            setInst(
              i++,
              (x - (cx - 1) / 2) * sx,
              (y - (cy - 1) / 2) * sy,
              (z - (cz - 1) / 2) * sz
            );
          }
    }

    const out: InstancesValue = {
      kind: "instances",
      source: src,
      count: n,
      positions,
      quaternions,
      scales,
      retainKey: st.retainKey,
    };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `array-3d:${nodeId}`;
    const st = ctx.state[key] as ArrayState | undefined;
    if (st) disposeInstancesFor(st.retainKey);
    delete ctx.state[key];
  },
};
