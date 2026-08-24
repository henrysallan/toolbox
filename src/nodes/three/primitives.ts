import * as THREE from "three";
import type {
  NodeDefinition,
  ParamDef,
  RenderContext,
} from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { makeMaterialDesc } from "@/engine/three-geometry";

// =====================================================================
// 3D primitives — shared factory
// =====================================================================
//
// Each primitive owns a RETAINED BufferGeometry in ctx.state. Transform +
// default-material params are shared; size/shape params are per-primitive
// and rebuild the BufferGeometry when they change (tracked by a signature;
// the geometries are tiny so a rebuild on a size drag is cheap).
//
// All primitives emit `geometry` (081026 spec §3.2) — LOCAL-space mesh
// data with the TRS params carried on the value and the color/metalness/
// roughness params folded into a default MaterialDesc (slot 0; the M4
// Material node overrides it downstream). Wiring into an `object3d`
// socket (Scene Render, Combine) auto-wraps via the coerce.ts →
// three-geometry.ts retained wrap, which is what keeps pre-retype saved
// projects rendering identically.

const DEG = Math.PI / 180;

const TRANSFORM_PARAMS: ParamDef[] = [
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

const MATERIAL_PARAMS: ParamDef[] = [
  { name: "color", label: "Color", type: "color", default: "#ff6633" },
  { name: "metalness", label: "Metalness", type: "scalar", min: 0, max: 1, step: 0.01, default: 0.1 },
  { name: "roughness", label: "Roughness", type: "scalar", min: 0, max: 1, step: 0.01, default: 0.45 },
];

interface PrimState {
  geometry: THREE.BufferGeometry;
  geomSig: string;
}

function makePrimitiveNode(opts: {
  type: string;
  name: string;
  description: string;
  sizeParams: ParamDef[];
  buildGeometry: (p: Record<string, unknown>) => THREE.BufferGeometry;
  geomSig: (p: Record<string, unknown>) => string;
}): NodeDefinition {
  const stateKey = (id: string) => `${opts.type}:${id}`;
  return {
    type: opts.type,
    name: opts.name,
    category: "3d",
    description: opts.description,
    backend: "webgl2",
    inputs: [],
    params: [...opts.sizeParams, ...TRANSFORM_PARAMS, ...MATERIAL_PARAMS],
    primaryOutput: "geometry",
    auxOutputs: [],

    compute({ params, ctx, nodeId }: { params: Record<string, unknown>; ctx: RenderContext; nodeId: string }) {
      const key = stateKey(nodeId);
      let st = ctx.state[key] as PrimState | undefined;
      const sig = opts.geomSig(params);
      if (!st) {
        st = { geometry: opts.buildGeometry(params), geomSig: sig };
        ctx.state[key] = st;
      } else if (st.geomSig !== sig) {
        // New object on rebuild (never mutate in place): downstream wrap/
        // modeling-op caches key on BufferGeometry identity.
        st.geometry.dispose();
        st.geometry = opts.buildGeometry(params);
        st.geomSig = sig;
      }

      const out: GeometryValue = {
        kind: "geometry",
        geometry: st.geometry,
        nodeId,
        transform: {
          position: [
            (params.pos_x as number) ?? 0,
            (params.pos_y as number) ?? 0,
            (params.pos_z as number) ?? 0,
          ],
          rotationEuler: [
            ((params.rot_x as number) ?? 0) * DEG,
            ((params.rot_y as number) ?? 0) * DEG,
            ((params.rot_z as number) ?? 0) * DEG,
          ],
          scale: [
            (params.scale_x as number) ?? 1,
            (params.scale_y as number) ?? 1,
            (params.scale_z as number) ?? 1,
          ],
        },
        materials: [
          makeMaterialDesc({
            baseColor: (params.color as string) ?? "#ff6633",
            roughness: (params.roughness as number) ?? 0.45,
            metalness: (params.metalness as number) ?? 0.1,
            transmission: 0,
            ior: 1.5,
            alpha: 1,
          }),
        ],
      };
      return { primary: out };
    },

    dispose(ctx: RenderContext, nodeId: string) {
      const st = ctx.state[stateKey(nodeId)] as PrimState | undefined;
      if (st) st.geometry.dispose();
      delete ctx.state[stateKey(nodeId)];
    },
  };
}

const sz = (name: string, label: string, def: number, max = 5): ParamDef => ({
  name,
  label,
  type: "scalar",
  min: 0.01,
  max: max * 2,
  softMax: max,
  step: 0.01,
  default: def,
});

export const cube3DNode = makePrimitiveNode({
  type: "cube-3d",
  name: "Cube",
  description: "A 3D box primitive. Wire into the 3D Scene node (with a Camera) to see it.",
  sizeParams: [sz("size", "Size", 1)],
  buildGeometry: (p) => {
    const s = (p.size as number) ?? 1;
    return new THREE.BoxGeometry(s, s, s);
  },
  geomSig: (p) => `${p.size}`,
});

export const sphere3DNode = makePrimitiveNode({
  type: "sphere-3d",
  name: "Sphere",
  description: "A 3D UV sphere primitive.",
  sizeParams: [sz("radius", "Radius", 0.6)],
  buildGeometry: (p) =>
    new THREE.SphereGeometry((p.radius as number) ?? 0.6, 48, 32),
  geomSig: (p) => `${p.radius}`,
});

export const plane3DNode = makePrimitiveNode({
  type: "plane-3d",
  name: "Plane",
  description: "A flat 3D plane (faces +Z by default; rotate -90° X for a floor).",
  sizeParams: [sz("width", "Width", 2, 10), sz("height", "Height", 2, 10)],
  buildGeometry: (p) =>
    new THREE.PlaneGeometry((p.width as number) ?? 2, (p.height as number) ?? 2),
  geomSig: (p) => `${p.width},${p.height}`,
});

export const cylinder3DNode = makePrimitiveNode({
  type: "cylinder-3d",
  name: "Cylinder",
  description: "A 3D cylinder primitive.",
  sizeParams: [sz("radius", "Radius", 0.5), sz("height", "Height", 1.2)],
  buildGeometry: (p) =>
    new THREE.CylinderGeometry(
      (p.radius as number) ?? 0.5,
      (p.radius as number) ?? 0.5,
      (p.height as number) ?? 1.2,
      48
    ),
  geomSig: (p) => `${p.radius},${p.height}`,
});

export const cone3DNode = makePrimitiveNode({
  type: "cone-3d",
  name: "Cone",
  description: "A 3D cone primitive.",
  sizeParams: [sz("radius", "Radius", 0.6), sz("height", "Height", 1.2)],
  buildGeometry: (p) =>
    new THREE.ConeGeometry((p.radius as number) ?? 0.6, (p.height as number) ?? 1.2, 48),
  geomSig: (p) => `${p.radius},${p.height}`,
});

export const torus3DNode = makePrimitiveNode({
  type: "torus-3d",
  name: "Torus",
  description: "A 3D torus (donut) primitive.",
  sizeParams: [sz("radius", "Radius", 0.6), sz("tube", "Tube", 0.22, 2)],
  buildGeometry: (p) =>
    new THREE.TorusGeometry((p.radius as number) ?? 0.6, (p.tube as number) ?? 0.22, 24, 64),
  geomSig: (p) => `${p.radius},${p.tube}`,
});
