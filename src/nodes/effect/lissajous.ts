import type {
  NodeDefinition,
  PointsValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Lissajous curve generators — 2D and 3D.
//
// Lissajous figures are parametric curves of the form
//     x(t) = Ax · sin(fx·t + φx)
//     y(t) = Ay · sin(fy·t + φy)
//     z(t) = Az · sin(fz·t + φz)   (3D only)
// over t ∈ [0, 2π]. Integer frequency ratios produce closed curves;
// non-integer ratios trace ergodically through the bounding box.
//
// Phases are exposed in units of π so common values (π/2, π, 3π/2)
// read as 0.5, 1, 1.5 on the slider — much more useful than raw
// radians. Rotations stay in radians since 3D rotations have no
// natural "× π" convention.
//
// 3D curves are rotated around X / Y / Z (extrinsic order) then
// orthographically projected by dropping z. Center offsets translate
// the projected curve into UV space.

// -------- helpers ------------------------------------------------------

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

// Extrinsic XYZ rotation (rotate around X, then Y, then Z in world frame).
function rotate3D(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number
): [number, number, number] {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // X
  const y1 = cx * y - sx * z;
  const z1 = sx * y + cx * z;
  // Y (uses rotated z1)
  const x2 = cy * x + sy * z1;
  const z2 = -sy * x + cy * z1;
  // Z (uses rotated x2 / y1)
  const x3 = cz * x2 - sz * y1;
  const y3 = sz * x2 + cz * y1;
  return [x3, y3, z2];
}

// Build a single-subpath SplineValue + a parallel PointsValue that
// references the same positions. Both outputs share the same anchor
// list so downstream consumers can pick whichever shape they need.
function buildOutputs(positions: Array<[number, number]>): {
  spline: SplineValue;
  points: PointsValue;
} {
  const sub: SplineSubpath = {
    anchors: positions.map((p) => ({ pos: p })),
    closed: false,
  };
  const spline: SplineValue = { kind: "spline", subpaths: [sub] };
  const points: PointsValue = {
    kind: "points",
    points: positions.map((p) => ({ pos: p })),
  };
  return { spline, points };
}

// -------- 2D node ------------------------------------------------------

export const lissajous2DNode: NodeDefinition = {
  type: "lissajous-2d",
  name: "Lissajous 2D",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a 2D Lissajous curve as a spline. x(t) = Ax·sin(fx·t + φx), y(t) = Ay·sin(fy·t + φy) over t ∈ [0, 2π]. Integer frequency ratios produce closed curves. Aux `points` output carries the same samples as a points value.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "samples",
      label: "Samples",
      type: "scalar",
      min: 16,
      max: 4096,
      softMax: 1024,
      step: 1,
      default: 256,
    },
    // Amplitudes
    {
      name: "ax",
      label: "Amplitude X",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.4,
    },
    {
      name: "ay",
      label: "Amplitude Y",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.4,
    },
    // Frequencies
    {
      name: "fx",
      label: "Frequency X",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.01,
      default: 3,
    },
    {
      name: "fy",
      label: "Frequency Y",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.01,
      default: 2,
    },
    // Phases (in units of π so 0.5 = π/2, 1 = π, etc.)
    {
      name: "phase_x",
      label: "Phase X (× π)",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "phase_y",
      label: "Phase Y (× π)",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    // Rotation around the curve's local center.
    {
      name: "rotation",
      label: "Rotation (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    // Center in UV space.
    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ params }) {
    const samples = clampInt(num(params.samples, 256), 2, 8192);
    const ax = num(params.ax, 0.4);
    const ay = num(params.ay, 0.4);
    const fx = num(params.fx, 3);
    const fy = num(params.fy, 2);
    const phaseX = num(params.phase_x, 0.5) * Math.PI;
    const phaseY = num(params.phase_y, 0) * Math.PI;
    const rot = num(params.rotation, 0);
    const cx = num(params.center_x, 0.5);
    const cy = num(params.center_y, 0.5);

    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const positions: Array<[number, number]> = new Array(samples);
    for (let i = 0; i < samples; i++) {
      const t = (i / samples) * 2 * Math.PI;
      const xRaw = ax * Math.sin(fx * t + phaseX);
      const yRaw = ay * Math.sin(fy * t + phaseY);
      // Rotate around the local origin, then translate to center.
      const x = cosR * xRaw - sinR * yRaw + cx;
      const y = sinR * xRaw + cosR * yRaw + cy;
      positions[i] = [x, y];
    }
    const { spline, points } = buildOutputs(positions);
    return { primary: spline, aux: { points } };
  },
};

// -------- 3D node ------------------------------------------------------

export const lissajous3DNode: NodeDefinition = {
  type: "lissajous-3d",
  name: "Lissajous 3D",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a 3D Lissajous curve, rotate it (extrinsic XYZ), and orthographically project to UV space. Three frequencies, three phases (× π), three rotations (rad), and per-axis amplitudes give classic 3D Lissajous knots and harmonograph-style figures. Aux `points` output carries the projected samples as a points value.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "samples",
      label: "Samples",
      type: "scalar",
      min: 16,
      max: 4096,
      softMax: 1024,
      step: 1,
      default: 512,
    },
    // Amplitudes
    {
      name: "ax",
      label: "Amplitude X",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.3,
    },
    {
      name: "ay",
      label: "Amplitude Y",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.3,
    },
    {
      name: "az",
      label: "Amplitude Z",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.3,
    },
    // Frequencies
    {
      name: "fx",
      label: "Frequency X",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.01,
      default: 1,
    },
    {
      name: "fy",
      label: "Frequency Y",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.01,
      default: 3,
    },
    {
      name: "fz",
      label: "Frequency Z",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.01,
      default: 2,
    },
    // Phases (× π)
    {
      name: "phase_x",
      label: "Phase X (× π)",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "phase_y",
      label: "Phase Y (× π)",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "phase_z",
      label: "Phase Z (× π)",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    // Rotations (rad). Extrinsic XYZ order — applied X then Y then Z.
    {
      name: "rx",
      label: "Rotation X (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    {
      name: "ry",
      label: "Rotation Y (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    {
      name: "rz",
      label: "Rotation Z (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    // Center in UV (post-projection).
    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ params }) {
    const samples = clampInt(num(params.samples, 512), 2, 8192);
    const ax = num(params.ax, 0.3);
    const ay = num(params.ay, 0.3);
    const az = num(params.az, 0.3);
    const fx = num(params.fx, 1);
    const fy = num(params.fy, 3);
    const fz = num(params.fz, 2);
    const phaseX = num(params.phase_x, 0.5) * Math.PI;
    const phaseY = num(params.phase_y, 0) * Math.PI;
    const phaseZ = num(params.phase_z, 0) * Math.PI;
    const rx = num(params.rx, 0);
    const ry = num(params.ry, 0);
    const rz = num(params.rz, 0);
    const cx = num(params.center_x, 0.5);
    const cy = num(params.center_y, 0.5);

    const positions: Array<[number, number]> = new Array(samples);
    for (let i = 0; i < samples; i++) {
      const t = (i / samples) * 2 * Math.PI;
      const x0 = ax * Math.sin(fx * t + phaseX);
      const y0 = ay * Math.sin(fy * t + phaseY);
      const z0 = az * Math.sin(fz * t + phaseZ);
      const [x, y] = rotate3D(x0, y0, z0, rx, ry, rz);
      // Drop Z (orthographic projection), translate into UV.
      positions[i] = [x + cx, y + cy];
    }
    const { spline, points } = buildOutputs(positions);
    return { primary: spline, aux: { points } };
  },
};
