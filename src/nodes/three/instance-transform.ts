import * as THREE from "three";
import type {
  ImageValue,
  NodeDefinition,
  NoiseFieldValue,
  RenderContext,
} from "@/engine/types";
import type { InstancesValue } from "@/engine/three-types";
import { sampleNoiseField } from "@/engine/noise";

// =====================================================================
// Instance Transform — per-copy motion (M6, 081026 spec)
// =====================================================================
//
// Applies a delta to every copy in the stream, scaled per copy by a
// FACTOR: all (1 everywhere), index gradient (0→1 in stream order), or
// seeded random. Offset is world-space; rotation is in each copy's OWN
// frame (so aligned copies spin about their surface normal); scale is a
// per-axis multiplicative lerp toward the target (uniform `scale` from
// older saves still fills all three axes). Spatial `Centered` is bipolar
// for offset/rotation (push both ways around rest) but UNIPOLAR for
// scale: the 0–1 field mixes 1 → target, so a large Scale Y never
// crosses zero and inverts the copy. Index/random weights were already
// 0–1, so they are unchanged.
//
// Wiring a Noise node's 3D field into `noise` replaces the index-based
// weight with a SPATIAL one — the field sampled at each copy's world
// position (pre-delta), so displacement rolls coherently across the
// cloud, and animating the Noise node's evolution (W / looping) makes
// waves travel through the copies. `Centered` maps the [0,1] sample to
// [−0.5, 0.5] for offset and rotation so those deltas push both ways
// around rest; scale always uses the 0–1 sample.
//
// Wiring an IMAGE into `image` weights spatially too: each copy samples
// the image's luminance at its world position through the same planar
// mapping as Instance Color's image mode (XZ ground / XY billboard over
// `plane_size` world units, centered). A Cursor node wired here makes
// copies react where the pointer paints; readback is identity-cached at
// ≤256px (weights need relative brightness, not resolution). Noise and
// image both wired ⇒ the weights MULTIPLY (image masks the noise wave).
//
// Keyframe the deltas with a gradient factor and you get index-staggered
// motion — the classic cascading loop — with zero per-copy keyframes.
// Value convention (§4.4): copy the value, replace only the transformed
// arrays.

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

const DEG = Math.PI / 180;

// Weight-image readback cache (the Instance Color image-mode pattern):
// re-read only when the wired ImageValue's texture identity moves.
const READBACK_MAX = 256;

interface ImgCache {
  lastKey: WebGLTexture | null;
  data: Uint8ClampedArray | null;
  w: number;
  h: number;
}

function ensureState(ctx: RenderContext, nodeId: string): ImgCache {
  const key = `instance-transform-3d:${nodeId}`;
  const existing = ctx.state[key] as ImgCache | undefined;
  if (existing) return existing;
  const st: ImgCache = { lastKey: null, data: null, w: 0, h: 0 };
  ctx.state[key] = st;
  return st;
}

export const instanceTransform3DNode: NodeDefinition = {
  type: "instance-transform-3d",
  name: "Instance Transform",
  category: "3d",
  description:
    "Offsets, rotates, and scales every copy in an instance stream, weighted per copy — uniformly, by index gradient, by seeded random, by a wired 3D noise field, or by a wired image's brightness sampled at each copy's position (wire a Cursor for pointer-reactive copies). Centered noise/image pushes offset and rotation both ways around rest; scale always mixes 1 → the target so it cannot invert. Keyframe the deltas with a gradient weight for cascading staggered motion.",
  facts: {
    space: {
      "param:offset_x": "world3d",
      "param:offset_y": "world3d",
      "param:offset_z": "world3d",
      "param:plane_size": "world3d",
    },
    gotchas: [
      "offset is world-space added to each copy's pre-delta position; rotation postmultiplies in each copy's OWN local frame, so aligned copies spin about their own surface normal, not a world axis.",
      "Scale always mixes 1 -> target using the raw 0..1 weight even when Centered is on, so it can never invert; only offset and rotation use the centered (weight-0.5) remap.",
      "factor (all/gradient/random) and seed only apply when neither noise nor image is wired; wiring either replaces the weight entirely and those params disappear.",
      "Noise and image weights sample at each copy's PRE-delta world position; with both wired the weights multiply, so the image masks the noise wave.",
      "Image weight uses Rec.709 luminance from a readback cached per texture identity at up to 256px, via the same XZ/XY planar mapping (plane_size world units) as Instance Color's image mode.",
      "A legacy single scale param from pre-split saves fills scale_x/y/z equally until migrated.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "instances", type: "instances", required: true },
    { name: "noise", type: "noise_field", required: false, label: "Noise" },
    { name: "image", type: "image", required: false, label: "Weight image" },
  ],
  params: [
    {
      name: "factor",
      label: "Weight by",
      type: "enum",
      options: ["all", "gradient", "random"],
      default: "all",
      control: "segmented",
      // A wired noise field / weight image IS the weight — the index
      // modes retire.
      visibleIf: (p, meta) => !meta?.wired?.noise && !meta?.wired?.image,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
      visibleIf: (p, meta) =>
        p.factor === "random" && !meta?.wired?.noise && !meta?.wired?.image,
    },
    {
      // Spatial weighting only: map [0,1] → [−0.5, 0.5] so offset and
      // rotation push both ways around rest. Scale ignores this (always
      // the 0–1 sample) so it cannot invert.
      name: "centered",
      label: "Centered",
      type: "boolean",
      default: true,
      visibleIf: (p, meta) => !!meta?.wired?.noise || !!meta?.wired?.image,
    },
    {
      name: "plane",
      label: "Image plane",
      type: "enum",
      options: ["xz", "xy"],
      default: "xz",
      control: "segmented",
      visibleIf: (p, meta) => !!meta?.wired?.image,
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
      visibleIf: (p, meta) => !!meta?.wired?.image,
    },
    { name: "offset_x", label: "Offset X", type: "scalar", min: -5, max: 5, step: 0.01, default: 0 },
    { name: "offset_y", label: "Offset Y", type: "scalar", min: -5, max: 5, step: 0.01, default: 0 },
    { name: "offset_z", label: "Offset Z", type: "scalar", min: -5, max: 5, step: 0.01, default: 0 },
    { name: "rot_x", label: "Rotate X (°)", type: "scalar", min: -360, max: 360, step: 0.1, default: 0 },
    { name: "rot_y", label: "Rotate Y (°)", type: "scalar", min: -360, max: 360, step: 0.1, default: 0 },
    { name: "rot_z", label: "Rotate Z (°)", type: "scalar", min: -360, max: 360, step: 0.1, default: 0 },
    { name: "scale_x", label: "Scale X", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
    { name: "scale_y", label: "Scale Y", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
    { name: "scale_z", label: "Scale Z", type: "scalar", min: 0.01, max: 10, softMax: 4, step: 0.01, default: 1 },
  ],
  linkedPairs: [
    { a: "scale_x", b: "scale_y" },
    { a: "scale_x", b: "scale_z" },
  ],
  primaryOutput: "instances",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.instances as InstancesValue | undefined;
    if (!src || src.kind !== "instances") return {};
    const noiseIn = inputs.noise;
    const field =
      noiseIn && noiseIn.kind === "noise_field"
        ? (noiseIn as NoiseFieldValue)
        : null;
    const centered = (params.centered as boolean) ?? true;

    // Weight image: identity-cached readback + planar mapping.
    let buf: ImgCache | null = null;
    let plane: "xz" | "xy" = "xz";
    let planeSize = 2;
    const imgIn = inputs.image;
    if (imgIn && imgIn.kind === "image") {
      const iv = imgIn as ImageValue;
      plane = ((params.plane as string) ?? "xz") as "xz" | "xy";
      planeSize = (params.plane_size as number) ?? 2;
      const st = ensureState(ctx, nodeId);
      if (st.lastKey !== iv.texture || !st.data) {
        const scale = Math.min(
          1,
          READBACK_MAX / Math.max(1, iv.width, iv.height)
        );
        const w = Math.max(1, Math.round(iv.width * scale));
        const h = Math.max(1, Math.round(iv.height * scale));
        const data = ctx.readImagePixels(iv, w, h);
        if (data) {
          st.lastKey = iv.texture;
          st.data = data;
          st.w = w;
          st.h = h;
        }
      }
      if (st.data) buf = st;
    }

    const mode = ((params.factor as string) ?? "all") as
      | "all"
      | "gradient"
      | "random";
    const seedMix = Math.imul(
      Math.round((params.seed as number) ?? 0),
      0x9e3779b1
    );
    const ox = (params.offset_x as number) ?? 0;
    const oy = (params.offset_y as number) ?? 0;
    const oz = (params.offset_z as number) ?? 0;
    const rx = ((params.rot_x as number) ?? 0) * DEG;
    const ry = ((params.rot_y as number) ?? 0) * DEG;
    const rz = ((params.rot_z as number) ?? 0) * DEG;
    // Uniform `scale` from pre-split saves fills every axis until the
    // loader migrates it to scale_x/y/z.
    const legacyScale =
      typeof params.scale === "number" ? (params.scale as number) : 1;
    const sxT = (params.scale_x as number) ?? legacyScale;
    const syT = (params.scale_y as number) ?? legacyScale;
    const szT = (params.scale_z as number) ?? legacyScale;

    const n = src.count;
    const positions = new Float32Array(n * 3);
    const quaternions = new Float32Array(n * 4);
    const scales = new Float32Array(n * 3);
    const q = new THREE.Quaternion();
    const qDelta = new THREE.Quaternion();
    const e = new THREE.Euler();

    for (let i = 0; i < n; i++) {
      let f01: number;
      const px0 = src.positions[i * 3];
      const py0 = src.positions[i * 3 + 1];
      const pz0 = src.positions[i * 3 + 2];
      if (field || buf) {
        // Spatial weight at this copy's pre-delta position: the 3D noise
        // field and/or the weight image's luminance (both [0,1]; both
        // wired ⇒ multiply — the image masks the noise wave).
        f01 = 1;
        if (field) f01 *= sampleNoiseField(field, px0, py0, pz0);
        if (buf) {
          // World position → plane UV (the Instance Color image-mode
          // mapping): XZ ground has authored-v along +z; XY billboard
          // flips world y-up back to v-down. Readback rows are top-down.
          const u = px0 / planeSize + 0.5;
          const v = plane === "xz" ? pz0 / planeSize + 0.5 : 0.5 - py0 / planeSize;
          const ix = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
          const iy = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
          const o = (iy * buf.w + ix) * 4;
          const d = buf.data!;
          f01 *= (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
        }
      } else {
        f01 =
          mode === "all"
            ? 1
            : mode === "gradient"
              ? n <= 1
                ? 0
                : i / (n - 1)
              : hash01(i ^ seedMix);
      }
      // Offset/rotation: Centered is bipolar so waves push both ways.
      // Scale always uses f01 so `1+(target-1)*f` cannot cross zero.
      const f = field || buf ? (centered ? f01 - 0.5 : f01) : f01;
      positions[i * 3] = px0 + ox * f;
      positions[i * 3 + 1] = py0 + oy * f;
      positions[i * 3 + 2] = pz0 + oz * f;

      q.set(
        src.quaternions[i * 4],
        src.quaternions[i * 4 + 1],
        src.quaternions[i * 4 + 2],
        src.quaternions[i * 4 + 3]
      );
      if (rx !== 0 || ry !== 0 || rz !== 0) {
        // Local-frame rotation: postmultiply the delta.
        qDelta.setFromEuler(e.set(rx * f, ry * f, rz * f));
        q.multiply(qDelta);
      }
      quaternions[i * 4] = q.x;
      quaternions[i * 4 + 1] = q.y;
      quaternions[i * 4 + 2] = q.z;
      quaternions[i * 4 + 3] = q.w;

      scales[i * 3] = src.scales[i * 3] * (1 + (sxT - 1) * f01);
      scales[i * 3 + 1] = src.scales[i * 3 + 1] * (1 + (syT - 1) * f01);
      scales[i * 3 + 2] = src.scales[i * 3 + 2] * (1 + (szT - 1) * f01);
    }

    const out: InstancesValue = { ...src, positions, quaternions, scales };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[`instance-transform-3d:${nodeId}`];
  },
};
