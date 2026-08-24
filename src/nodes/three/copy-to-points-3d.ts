import * as THREE from "three";
import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SocketType,
} from "@/engine/types";
import type { GeometryValue, InstancesValue } from "@/engine/three-types";
import { disposeInstancesFor } from "@/engine/three-geometry";

// =====================================================================
// 3D Copy to Points — instancing (081026 spec §4.2 + §4.4)
// =====================================================================
//
// Emits an `instances` STREAM (M4.5): the source geometry + per-copy TRS
// SoA in the "copy at point i" frame — kept liquid so instance modifiers
// (Instance Color, …) can act before the scene boundary resolves it into
// one retained InstancedMesh (instances→object3d coercion in
// three-geometry.ts, keyed on this node's retainKey; a single draw call
// at any count). Realize Instances is the explicit bake to `geometry`.
//
// Points are `points3d` (world-space, normals drive align-to-normal) —
// OR 2D `points`, the explicit authored→world bridge: [0,1]² maps onto a
// ground (XZ) or billboard (XY) plane of `plane_size` world units
// centered on the origin.
//
// Per-copy orientation: align the copy's +Y to the surface normal, then
// jitter AROUND that axis (copies stay seated). Jitter is hashed on the
// point INDEX (triple32, seed-mixed — the Filter Points/Point Expression
// hash) so copies don't reshuffle when params drag. Per-point 2D
// attributes and groupIndex variant picking are backlog.

function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

interface CopyState {
  // Stable across recomputes — the instances resolver hangs its retained
  // InstancedMesh off this (disposed via disposeInstancesFor below).
  retainKey: object;
}

function ensureState(ctx: RenderContext, nodeId: string): CopyState {
  const key = `copy-to-points-3d:${nodeId}`;
  const existing = ctx.state[key] as CopyState | undefined;
  if (existing) return existing;
  const st: CopyState = { retainKey: {} };
  ctx.state[key] = st;
  return st;
}

const UP = new THREE.Vector3(0, 1, 0);

export const copyToPoints3DNode: NodeDefinition = {
  type: "copy-to-points-3d",
  name: "3D Copy to Points",
  category: "3d",
  description:
    "Places a copy of the instance geometry at every 3D point, emitting an instance stream (one InstancedMesh draw call at the scene). Points from 3D Scatter carry normals for align-to-normal; wiring 2D points instead maps them onto a ground or billboard plane. Chain Instance Color to tint copies, or Realize Instances to bake real geometry.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "instance", type: "geometry", required: true },
    { name: "points", type: "points3d", required: true },
  ],
  // The points socket adopts 2D `points` when that's what's wired — the
  // plane-mapping bridge (editorCanCoerce exception lets it land).
  resolveInputs(params, ctx): InputSocketDef[] {
    const t: SocketType =
      ctx?.connectedTypes?.points === "points" ? "points" : "points3d";
    return [
      { name: "instance", type: "geometry", required: true },
      { name: "points", type: t, required: true },
    ];
  },
  params: [
    {
      name: "plane",
      label: "Plane",
      type: "enum",
      options: ["xz", "xy"],
      default: "xz",
      control: "segmented",
      // Only meaningful for the 2D-points bridge.
      visibleIf: (p, meta) => meta?.inputTypes?.points === "points",
    },
    {
      name: "plane_size",
      label: "Plane size",
      type: "scalar",
      min: 0.1,
      max: 20,
      softMax: 10,
      step: 0.01,
      default: 2,
      visibleIf: (p, meta) => meta?.inputTypes?.points === "points",
    },
    {
      name: "align_to_normal",
      label: "Align to normal",
      type: "boolean",
      default: true,
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "scale_jitter",
      label: "Scale jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "rotation_jitter",
      label: "Rotation jitter (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 0.1,
      default: 0,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "instances",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const st = ensureState(ctx, nodeId);
    const instance = inputs.instance as GeometryValue | undefined;
    const pts = inputs.points as PointsValue | undefined;

    if (
      !instance ||
      instance.kind !== "geometry" ||
      !pts ||
      pts.kind !== "points"
    ) {
      return {};
    }

    const n = pts.count;
    const is3d = pts.z !== undefined;
    const plane = ((params.plane as string) ?? "xz") as "xz" | "xy";
    const planeSize = (params.plane_size as number) ?? 2;
    const align = (params.align_to_normal as boolean) ?? true;
    const baseScale = (params.scale as number) ?? 1;
    const scaleJitter = Math.max(
      0,
      Math.min(1, (params.scale_jitter as number) ?? 0)
    );
    const rotJitter =
      ((((params.rotation_jitter as number) ?? 0) * Math.PI) / 180) as number;
    const seedMix = Math.imul(
      Math.round((params.seed as number) ?? 0),
      0x9e3779b1
    );

    // Fresh arrays per recompute — previous values may still be cached
    // downstream; the value convention is immutable-after-emit.
    const positions = new Float32Array(n * 3);
    const quaternions = new Float32Array(n * 4);
    const scales = new Float32Array(n * 3);

    const q = new THREE.Quaternion();
    const qJit = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      // Position (+ the 2D→plane bridge).
      let px: number;
      let py: number;
      let pz: number;
      if (is3d) {
        px = pts.positions[i * 2];
        py = pts.positions[i * 2 + 1];
        pz = pts.z![i];
      } else {
        const u = pts.positions[i * 2] - 0.5;
        const v = pts.positions[i * 2 + 1] - 0.5;
        if (plane === "xz") {
          // Ground: authored y-down → +z (toward the default camera).
          px = u * planeSize;
          py = 0;
          pz = v * planeSize;
        } else {
          // Billboard: authored y-down → world y-up flip.
          px = u * planeSize;
          py = -v * planeSize;
          pz = 0;
        }
      }
      positions[i * 3] = px;
      positions[i * 3 + 1] = py;
      positions[i * 3 + 2] = pz;

      // Orientation: align copy's +Y to the surface normal, then jitter
      // AROUND that axis (so jittered copies still sit on the surface).
      if (is3d && pts.normals) {
        normal.set(
          pts.normals[i * 3],
          pts.normals[i * 3 + 1],
          pts.normals[i * 3 + 2]
        );
      } else if (!is3d && plane === "xy") {
        normal.set(0, 0, 1);
      } else {
        normal.copy(UP);
      }
      if (align && normal.lengthSq() > 1e-12) {
        axis.copy(normal).normalize();
        q.setFromUnitVectors(UP, axis);
      } else {
        axis.copy(UP);
        q.identity();
      }
      if (rotJitter > 0) {
        const a = (hash01((i * 2 + 1) ^ seedMix) - 0.5) * 2 * rotJitter;
        qJit.setFromAxisAngle(axis, a);
        q.premultiply(qJit);
      }
      quaternions[i * 4] = q.x;
      quaternions[i * 4 + 1] = q.y;
      quaternions[i * 4 + 2] = q.z;
      quaternions[i * 4 + 3] = q.w;

      // Uniform scale with multiplicative jitter in [1−j, 1+j].
      let sc = baseScale;
      if (scaleJitter > 0) {
        sc *= 1 + (hash01((i * 2) ^ seedMix) - 0.5) * 2 * scaleJitter;
      }
      scales[i * 3] = sc;
      scales[i * 3 + 1] = sc;
      scales[i * 3 + 2] = sc;
    }

    const out: InstancesValue = {
      kind: "instances",
      source: instance,
      count: n,
      positions,
      quaternions,
      scales,
      retainKey: st.retainKey,
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `copy-to-points-3d:${nodeId}`;
    const st = ctx.state[key] as CopyState | undefined;
    if (st) disposeInstancesFor(st.retainKey);
    delete ctx.state[key];
  },
};
