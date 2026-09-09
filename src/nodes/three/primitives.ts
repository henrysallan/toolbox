import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { NodeDefinition, NodeFacts, ParamDef, RenderContext } from "@/engine/types";
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
//
// 081926 M1: factory-level `flat_shade` (toNonIndexed + face normals) plus
// additive sweep/sides/arc on the original six. New params at their
// defaults keep geomSig (and the BufferGeometry) byte-identical to the
// pre-wave constructors so saved projects do not rebuild.

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

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

const FLAT_SHADE_PARAM: ParamDef = {
  name: "flat_shade",
  label: "Flat shade",
  type: "boolean",
  default: false,
};

interface PrimState {
  geometry: THREE.BufferGeometry;
  geomSig: string;
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function int(v: unknown, fb: number, min: number, max?: number): number {
  let x = Math.round(num(v, fb));
  if (x < min) x = min;
  if (max !== undefined && x > max) x = max;
  return x;
}

function degToRad(v: unknown, fbDeg: number, maxRad = TAU): number {
  return Math.min(maxRad, Math.max(0.001 * DEG, num(v, fbDeg) * DEG));
}

function extraSig(base: string, extra: string): string {
  return extra ? `${base}|${extra}` : base;
}

function applyFlatShade(
  geom: THREE.BufferGeometry,
  flat: boolean
): THREE.BufferGeometry {
  if (!flat) return geom;
  const out = geom.index ? geom.toNonIndexed() : geom.clone();
  if (out !== geom) geom.dispose();
  out.computeVertexNormals();
  return out;
}

function makePrimitiveNode(opts: {
  type: string;
  name: string;
  description: string;
  facts?: NodeFacts;
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
    facts: opts.facts,
    backend: "webgl2",
    noMaskInput: true,
    inputs: [],
    params: [
      ...opts.sizeParams,
      FLAT_SHADE_PARAM,
      ...TRANSFORM_PARAMS,
      ...MATERIAL_PARAMS,
    ],
    primaryOutput: "geometry",
    auxOutputs: [],

    compute({ params, ctx, nodeId }: { params: Record<string, unknown>; ctx: RenderContext; nodeId: string }) {
      const key = stateKey(nodeId);
      let st = ctx.state[key] as PrimState | undefined;
      const flat = !!params.flat_shade;
      const sig = extraSig(opts.geomSig(params), flat ? "flat" : "");
      if (!st) {
        st = {
          geometry: applyFlatShade(opts.buildGeometry(params), flat),
          geomSig: sig,
        };
        ctx.state[key] = st;
      } else if (st.geomSig !== sig) {
        // New object on rebuild (never mutate in place): downstream wrap/
        // modeling-op caches key on BufferGeometry identity.
        st.geometry.dispose();
        st.geometry = applyFlatShade(opts.buildGeometry(params), flat);
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

const SIDES: ParamDef = {
  name: "sides",
  label: "Sides",
  type: "scalar",
  min: 3,
  max: 128,
  softMax: 64,
  step: 1,
  default: 48,
};

const OPEN_ENDED: ParamDef = {
  name: "open_ended",
  label: "Open ended",
  type: "boolean",
  default: false,
};

const ARC: ParamDef = {
  name: "arc",
  label: "Arc (°)",
  type: "scalar",
  min: 0.1,
  max: 360,
  step: 0.1,
  default: 360,
};

function cylinderishSig(p: Record<string, unknown>): string {
  const sides = int(p.sides, 48, 3);
  const open = !!p.open_ended;
  const arc = num(p.arc, 360);
  const extra =
    sides === 48 && !open && arc === 360 ? "" : `${sides},${open ? 1 : 0},${arc}`;
  return extraSig(`${p.radius},${p.height}`, extra);
}

function cylinderishArgs(p: Record<string, unknown>): {
  sides: number;
  open: boolean;
  theta: number;
} {
  return {
    sides: int(p.sides, 48, 3),
    open: !!p.open_ended,
    theta: degToRad(p.arc, 360),
  };
}

export const cube3DNode = makePrimitiveNode({
  type: "cube-3d",
  name: "Cube",
  facts: {
    space: {
      "param:size": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "rot_x/y/z are degrees; size is one scalar, so a non-uniform box needs scale_x/y/z.",
    ],
  },
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
  facts: {
    space: {
      "param:radius": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "Width/height segments are fixed at 48×32 regardless of radius or sweep values.",
      "sweep_v < 180 truncates from the north pole (thetaStart fixed at 0) into a dome, not a centered wedge; sweep_h < 360 cuts from phi 0 into a pac-man slice.",
    ],
  },
  description:
    "A 3D UV sphere primitive. Sweep H/V cut a pac-man or a dome; Flat shade is the low-poly look.",
  sizeParams: [
    sz("radius", "Radius", 0.6),
    {
      name: "sweep_h",
      label: "Sweep H (°)",
      type: "scalar",
      min: 0.1,
      max: 360,
      step: 0.1,
      default: 360,
    },
    {
      name: "sweep_v",
      label: "Sweep V (°)",
      type: "scalar",
      min: 0.1,
      max: 180,
      step: 0.1,
      default: 180,
    },
  ],
  buildGeometry: (p) => {
    const r = (p.radius as number) ?? 0.6;
    const h = num(p.sweep_h, 360);
    const v = num(p.sweep_v, 180);
    if (h === 360 && v === 180) return new THREE.SphereGeometry(r, 48, 32);
    return new THREE.SphereGeometry(r, 48, 32, 0, degToRad(h, 360), 0, degToRad(v, 180, Math.PI));
  },
  geomSig: (p) => {
    const h = num(p.sweep_h, 360);
    const v = num(p.sweep_v, 180);
    return extraSig(`${p.radius}`, h === 360 && v === 180 ? "" : `${h},${v}`);
  },
});

export const plane3DNode = makePrimitiveNode({
  type: "plane-3d",
  name: "Plane",
  facts: {
    space: {
      "param:width": "world3d",
      "param:height": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "Single-sided with no way to flip via material: MaterialDesc has no side field, so the back face is always culled regardless of downstream Material params.",
    ],
  },
  description: "A flat 3D plane (faces +Z by default; rotate -90° X for a floor).",
  sizeParams: [sz("width", "Width", 2, 10), sz("height", "Height", 2, 10)],
  buildGeometry: (p) =>
    new THREE.PlaneGeometry((p.width as number) ?? 2, (p.height as number) ?? 2),
  geomSig: (p) => `${p.width},${p.height}`,
});

export const cylinder3DNode = makePrimitiveNode({
  type: "cylinder-3d",
  name: "Cylinder",
  facts: {
    space: {
      "param:radius": "world3d",
      "param:height": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "radius applies to both top and bottom equally; there is no separate taper param for a frustum.",
      "open_ended removes both end caps, leaving a hollow tube; arc < 360 sweeps from angle 0 into a wedge, and height segments are fixed at 1.",
    ],
  },
  description:
    "A 3D cylinder primitive. Sides 6 is a hex prism; Arc < 360 is a cheese wedge.",
  sizeParams: [sz("radius", "Radius", 0.5), sz("height", "Height", 1.2), SIDES, OPEN_ENDED, ARC],
  buildGeometry: (p) => {
    const r = (p.radius as number) ?? 0.5;
    const h = (p.height as number) ?? 1.2;
    const { sides, open, theta } = cylinderishArgs(p);
    if (sides === 48 && !open && num(p.arc, 360) === 360) {
      return new THREE.CylinderGeometry(r, r, h, 48);
    }
    return new THREE.CylinderGeometry(r, r, h, sides, 1, open, 0, theta);
  },
  geomSig: cylinderishSig,
});

export const cone3DNode = makePrimitiveNode({
  type: "cone-3d",
  name: "Cone",
  facts: {
    space: {
      "param:radius": "world3d",
      "param:height": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "open_ended removes the base cap only, leaving a hollow shell; the apex is a single point and has no cap to remove.",
      "arc < 360 sweeps from angle 0, so it is a wedge starting at one side, not a centered slice; height segments are fixed at 1.",
    ],
  },
  description:
    "A 3D cone primitive. Sides 4 is a pyramid; Arc < 360 is a cheese wedge.",
  sizeParams: [sz("radius", "Radius", 0.6), sz("height", "Height", 1.2), SIDES, OPEN_ENDED, ARC],
  buildGeometry: (p) => {
    const r = (p.radius as number) ?? 0.6;
    const h = (p.height as number) ?? 1.2;
    const { sides, open, theta } = cylinderishArgs(p);
    if (sides === 48 && !open && num(p.arc, 360) === 360) {
      return new THREE.ConeGeometry(r, h, 48);
    }
    return new THREE.ConeGeometry(r, h, sides, 1, open, 0, theta);
  },
  geomSig: cylinderishSig,
});

export const torus3DNode = makePrimitiveNode({
  type: "torus-3d",
  name: "Torus",
  facts: {
    space: {
      "param:radius": "world3d",
      "param:tube": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "radius is measured to the tube's center line, not the outer edge; the torus's total outer extent is radius + tube.",
      "Radial/tubular segments are fixed at 24×64; arc < 360 sweeps from angle 0 into a macaroni wedge.",
    ],
  },
  description: "A 3D torus (donut) primitive. Arc < 360 is a macaroni.",
  sizeParams: [sz("radius", "Radius", 0.6), sz("tube", "Tube", 0.22, 2), ARC],
  buildGeometry: (p) => {
    const r = (p.radius as number) ?? 0.6;
    const tube = (p.tube as number) ?? 0.22;
    if (num(p.arc, 360) === 360) return new THREE.TorusGeometry(r, tube, 24, 64);
    return new THREE.TorusGeometry(r, tube, 24, 64, degToRad(p.arc, 360));
  },
  geomSig: (p) => {
    const arc = num(p.arc, 360);
    return extraSig(`${p.radius},${p.tube}`, arc === 360 ? "" : `${arc}`);
  },
});

export const capsule3DNode = makePrimitiveNode({
  type: "capsule-3d",
  name: "Capsule",
  facts: {
    space: {
      "param:radius": "world3d",
      "param:length": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "length is the straight cylindrical section only; total capsule height is length + 2×radius.",
      "Cap segments (8) and radial segments (32) are fixed and not exposed as params.",
    ],
  },
  description: "A 3D capsule (pill) — two hemispheres joined by a cylinder.",
  sizeParams: [sz("radius", "Radius", 0.3), sz("length", "Length", 1)],
  buildGeometry: (p) =>
    new THREE.CapsuleGeometry(
      (p.radius as number) ?? 0.3,
      (p.length as number) ?? 1,
      8,
      32
    ),
  geomSig: (p) => `${p.radius},${p.length}`,
});

export const roundedCube3DNode = makePrimitiveNode({
  type: "rounded-cube-3d",
  name: "Rounded Cube",
  facts: {
    space: {
      "param:width": "world3d",
      "param:height": "world3d",
      "param:depth": "world3d",
      "param:corner_radius": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "corner_radius is clamped internally to at most half of the smallest of width/height/depth, so shrinking a dimension can un-round a corner set near its max.",
      "smoothness sets the segment count on every face (2×smoothness+1 per axis), not just the rounded corners, so raising it also densifies the flat faces.",
    ],
  },
  description: "A box with filleted edges — different topology from Cube, so a separate node.",
  sizeParams: [
    sz("width", "Width", 1),
    sz("height", "Height", 1),
    sz("depth", "Depth", 1),
    {
      name: "corner_radius",
      label: "Corner radius",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 0.5,
      step: 0.01,
      default: 0.15,
    },
    {
      name: "smoothness",
      label: "Smoothness",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 2,
    },
  ],
  buildGeometry: (p) =>
    new RoundedBoxGeometry(
      (p.width as number) ?? 1,
      (p.height as number) ?? 1,
      (p.depth as number) ?? 1,
      int(p.smoothness, 2, 1, 8),
      num(p.corner_radius, 0.15)
    ),
  geomSig: (p) =>
    `${p.width},${p.height},${p.depth},${p.corner_radius},${int(p.smoothness, 2, 1, 8)}`,
});

export const torusKnot3DNode = makePrimitiveNode({
  type: "torus-knot-3d",
  name: "Torus Knot",
  facts: {
    space: {
      "param:radius": "world3d",
      "param:tube": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "Tubular/radial segments are fixed at 64×16 regardless of p/q, so higher-winding knots (larger p, q) can look faceted.",
    ],
  },
  description: "A (p, q) torus knot — the abstract hero object. p and q are the winding integers.",
  sizeParams: [
    sz("radius", "Radius", 0.6),
    sz("tube", "Tube", 0.18, 2),
    {
      name: "p",
      label: "P",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 2,
    },
    {
      name: "q",
      label: "Q",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 3,
    },
  ],
  buildGeometry: (p) =>
    new THREE.TorusKnotGeometry(
      (p.radius as number) ?? 0.6,
      (p.tube as number) ?? 0.18,
      64,
      16,
      int(p.p, 2, 1, 16),
      int(p.q, 3, 1, 16)
    ),
  geomSig: (p) =>
    `${p.radius},${p.tube},${int(p.p, 2, 1, 16)},${int(p.q, 3, 1, 16)}`,
});

const POLYHEDRON_SHAPES = [
  "icosahedron",
  "octahedron",
  "tetrahedron",
  "dodecahedron",
] as const;

type PolyhedronShape = (typeof POLYHEDRON_SHAPES)[number];

function polyhedronShape(v: unknown): PolyhedronShape {
  return POLYHEDRON_SHAPES.includes(v as PolyhedronShape)
    ? (v as PolyhedronShape)
    : "icosahedron";
}

export const polyhedron3DNode = makePrimitiveNode({
  type: "polyhedron-3d",
  name: "Polyhedron",
  facts: {
    space: {
      "param:radius": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "detail subdivides all four shapes toward a sphere, not just icosahedron; an unrecognized shape value silently falls back to icosahedron.",
    ],
  },
  description:
    "Platonic solids in one node — icosahedron (detail 2+ is an icosphere), octahedron, tetrahedron, dodecahedron. Detail 0 is the low-poly gem.",
  sizeParams: [
    {
      name: "shape",
      label: "Shape",
      type: "enum",
      options: [...POLYHEDRON_SHAPES],
      optionLabels: {
        icosahedron: "Icosahedron",
        octahedron: "Octahedron",
        tetrahedron: "Tetrahedron",
        dodecahedron: "Dodecahedron",
      },
      default: "icosahedron",
    },
    sz("radius", "Radius", 0.6),
    {
      name: "detail",
      label: "Detail",
      type: "scalar",
      min: 0,
      max: 4,
      step: 1,
      default: 0,
    },
  ],
  buildGeometry: (p) => {
    const r = (p.radius as number) ?? 0.6;
    const d = int(p.detail, 0, 0, 4);
    switch (polyhedronShape(p.shape)) {
      case "octahedron":
        return new THREE.OctahedronGeometry(r, d);
      case "tetrahedron":
        return new THREE.TetrahedronGeometry(r, d);
      case "dodecahedron":
        return new THREE.DodecahedronGeometry(r, d);
      default:
        return new THREE.IcosahedronGeometry(r, d);
    }
  },
  geomSig: (p) =>
    `${polyhedronShape(p.shape)},${p.radius},${int(p.detail, 0, 0, 4)}`,
});

export const ring3DNode = makePrimitiveNode({
  type: "ring-3d",
  name: "Ring",
  facts: {
    space: {
      "param:outer_radius": "world3d",
      "param:inner_radius": "world3d",
      "param:pos_x": "world3d",
      "param:pos_y": "world3d",
      "param:pos_z": "world3d",
    },
    gotchas: [
      "Outputs geometry only; nothing is visible until it reaches Scene Render through a scene that has a Camera.",
      "Carries its own TRS (pos_/rot_/scale_) and material (color/metalness/roughness); fold a following Transform 3D into these params instead.",
      "inner_radius is clamped to at most 99.9% of outer_radius, so it can approach but never reach or exceed the outer edge.",
      "Single-sided like Plane: MaterialDesc has no side field, so the back face is always culled.",
    ],
  },
  description:
    "A flat annular disc. Inner radius 0 is a solid disc; Theta length < 360 is a pizza slice. Single-sided like Plane.",
  sizeParams: [
    sz("outer_radius", "Outer radius", 0.8),
    {
      name: "inner_radius",
      label: "Inner radius",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 0.35,
    },
    {
      name: "theta_length",
      label: "Theta length (°)",
      type: "scalar",
      min: 0.1,
      max: 360,
      step: 0.1,
      default: 360,
    },
  ],
  buildGeometry: (p) => {
    const outer = (p.outer_radius as number) ?? 0.8;
    const inner = Math.max(0, Math.min(num(p.inner_radius, 0.35), outer * 0.999));
    return new THREE.RingGeometry(inner, outer, 48, 1, 0, degToRad(p.theta_length, 360));
  },
  geomSig: (p) => `${p.outer_radius},${p.inner_radius},${num(p.theta_length, 360)}`,
});
