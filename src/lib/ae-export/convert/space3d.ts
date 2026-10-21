// Toolbox 3-D (three.js: Y-up, world units, degrees, Euler 'XYZ') → After
// Effects 3-D (Y-down px, Z into the screen). M4 lane 5, specdocs/ae-m4/3d.md;
// every constant here was measured in AE 26.5 headless
// (scripts/ae-export-spike/calibrate/three-d.mts, measured/three-d-*.json):
//
//   units      a model layer draws 512 px per glTF / toolbox world unit, glTF
//              (x, y, z) → layer (x, −y, −z), the file's origin at the
//              layer's anchor (no re-centring; sourceRectAtTime agrees).
//   rotation   AE's layer rotation is Rx·Ry·Rz (column vectors) like three's
//              'XYZ' Euler; Orientation ≡ X/Y/Z Rotation. The flip
//              F = diag(1, −1, −1) is a rotation, so F·R(a, b, c)·F =
//              R(a, −b, −c): X = a, Y = −b, Z = −c, per axis — exact.
//   camera     a Point-of-Interest camera's basis is three's lookAt under F
//              (AE: right = down × forward; three: x = up × z); Zoom is the
//              distance at which 1 px = 1 px, so zoom = (H/2)/tan(fov/2).
//              Silhouettes vs toolbox: IoU 0.9989, centroid ≤ 0.06 px.
//   ortho      AE has no orthographic camera: one D = 2·10⁵ px from the target
//              with zoom = D·H / (512·ortho_height) stands in (silhouette IoU
//              0.9968, centroid ≤ 0.055 px; a point ±1.65 units deep moves
//              ≤ 0.9 px). Farther is flatter but loses depth precision: at
//              10⁶ px directional light shows fringes on every edge, at 10⁷ px
//              the render breaks.
//   lights     Advanced 3D lights in the (unlinearized) working space:
//              out = encoded albedo × intensity% / 100 × N·L. three lights
//              linearly and encodes: encode(albedo · I/π · N·L). No intensity
//              matches every N·L: AE is linear in N·L, toolbox ≈ (N·L)^(1/2.4).
//              The least-squares intensity over a lit sphere (N·L weighted by
//              projected area, 2x dx) is AE_LIGHT_GAIN × the N·L = 1 match.
//              Ambient has no N·L: matched exactly. Inverse Square Clamped
//              with Radius 512 px is three's decay-2 falloff in AE px.

import type { AeAffine } from "./keys";

export type Vec3 = [number, number, number];

export const AE_PX_PER_UNIT = 512;

// Per-axis sign of the flip, and of a rotation angle.
export const AE_AXIS_SIGN: Vec3 = [1, -1, -1];
export const AE_ROTATION_SIGN: Vec3 = [1, -1, -1];

// A camera this far from its target stands in for an orthographic one.
export const AE_ORTHO_DISTANCE_PX = 2e5;

// Radius of the Inverse Square Clamped falloff: 1 world unit.
export const AE_LIGHT_RADIUS_PX = AE_PX_PER_UNIT;

// 4∫₀¹ x²·encode(x) dx (1.145–1.163 for I/π from 0.1 to 1.5): the least-
// squares scale of AE's linear N·L against toolbox's encoded one. The round
// trip's best scale was 1.09–1.21 per frame (specdocs/ae-m4/3d.md).
export const AE_LIGHT_GAIN = 1.16;

// three's Scene Render adds this ambient light when no light reaches it.
export const TOOLBOX_FALLBACK_AMBIENT = 0.4;

// Toolbox world → AE comp px, per axis, around `origin` (the comp px the
// world origin sits at). An offset of 0 gives a vector in a parent's space.
export function aeAxisMaps(origin: Vec3 = [0, 0, 0]): [AeAffine, AeAffine, AeAffine] {
  return [0, 1, 2].map((k) => ({ scale: AE_PX_PER_UNIT * AE_AXIS_SIGN[k], offset: origin[k] })) as [AeAffine, AeAffine, AeAffine];
}

export function toAePoint(p: readonly number[], origin: Vec3 = [0, 0, 0]): Vec3 {
  return [0, 1, 2].map((k) => origin[k] + AE_PX_PER_UNIT * AE_AXIS_SIGN[k] * (p[k] ?? 0)) as Vec3;
}

// Euler degrees (three 'XYZ') → AE X / Y / Z Rotation.
export function toAeRotation(deg: readonly number[]): { x: number; y: number; z: number } {
  return { x: AE_ROTATION_SIGN[0] * (deg[0] ?? 0), y: AE_ROTATION_SIGN[1] * (deg[1] ?? 0), z: AE_ROTATION_SIGN[2] * (deg[2] ?? 0) };
}

export function aeZoomOf(fovDeg: number, compHeight: number): number {
  const f = Math.min(179, Math.max(0.01, fovDeg));
  return compHeight / 2 / Math.tan((f * Math.PI) / 360);
}

// The stand-in for an orthographic camera: same view direction, far away,
// zoomed so the target plane shows `orthoHeight` world units.
export function aeOrthoCamera(pos: readonly number[], target: readonly number[], orthoHeight: number, compHeight: number, origin: Vec3): { position: Vec3; poi: Vec3; zoom: number } {
  const d = [0, 1, 2].map((k) => (pos[k] ?? 0) - (target[k] ?? 0));
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const away = AE_ORTHO_DISTANCE_PX / AE_PX_PER_UNIT;
  const far = [0, 1, 2].map((k) => (target[k] ?? 0) + (d[k] / len) * away);
  return {
    position: toAePoint(far, origin),
    poi: toAePoint(target, origin),
    zoom: (AE_ORTHO_DISTANCE_PX * compHeight) / (AE_PX_PER_UNIT * Math.max(1e-6, orthoHeight)),
  };
}

// sRGB encode, extended past 1 (AE intensities may exceed 100 %).
export function srgbEncode(v: number): number {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

export type ToolboxLightType = "directional" | "point" | "ambient" | "spot";

// three light intensity → AE Intensity %. Point / spot lights are matched at
// `distance` (world units: the light to the scene's subject), where AE's
// Inverse Square Clamped falloff gives (radius / d)² with radius = 1 unit.
export function aeLightIntensity(type: ToolboxLightType, intensity: number, distance = 1): number {
  const i = Math.max(0, intensity);
  if (type === "ambient") return 100 * srgbEncode(i / Math.PI);
  if (type === "directional") return 100 * AE_LIGHT_GAIN * srgbEncode(i / Math.PI);
  const d = Math.max(1e-3, distance);
  const atD = srgbEncode(i / (Math.PI * d * d));
  return (100 * AE_LIGHT_GAIN * atD) / Math.min(1, 1 / (d * d));
}

export function aeLightTypeOf(type: string): "parallel" | "point" | "ambient" | "spot" {
  if (type === "point") return "point";
  if (type === "ambient") return "ambient";
  if (type === "spot") return "spot";
  return "parallel";
}
