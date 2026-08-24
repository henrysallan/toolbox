import * as THREE from "three";
import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import type { InstancesValue } from "@/engine/three-types";
import {
  sampleColorRampRgba01,
  type ColorRampInterp,
  type ColorRampStop,
} from "@/engine/color-ramp";

// =====================================================================
// Instance Color — per-copy tint (081026 spec §4.4, first modifier)
// =====================================================================
//
// The instance-domain proof of concept: writes the stream's per-instance
// `colors` array (three's native instanceColor — multiplies the material
// color per copy, zero extra draw calls). Modes:
//   solid    — every copy gets Color A (a flat re-tint).
//   random   — seeded per-INDEX hash lerps A↔B (triple32, the Filter
//              Points hash — stable under param drags, and seed re-rolls).
//   gradient — WORLD-SPACE: each copy's position projects onto a
//              steerable axis (+Y rotated by the X/Y/Z angle params),
//              auto-normalized over the cloud's extent along that axis,
//              and colored through a RAMP param (full stop editor on the
//              node; wire a Color Ramp node's `ramp` output into it to
//              share one palette — the standard color_ramp param
//              contract). Default = vertical, bottom → top.
//   image    — sample the wired image at each copy's world position
//              through a planar mapping (XZ ground / XY billboard over
//              `plane_size` world units, centered — the Copy to Points
//              2D-bridge convention). A gradient paints a scattered
//              field; animated noise paints traveling color waves. The
//              image is read back ONCE per upstream change at ≤256px
//              (the 2D Scatter density pattern — tint needs relative
//              color, not resolution), cached on ImageValue identity.
//
// Value convention (§4.4): copy the value, replace only `colors`, share
// the untouched arrays. Colors are LINEAR RGB — THREE.Color's hex parse
// (and setRGB with SRGBColorSpace for image samples) converts from sRGB
// under three's default color management, matching setColorAt.

const READBACK_MAX = 256;

// Per-eval ramp bake (gradient mode): shared scratch is safe — evals are
// single-threaded and the LUT is consumed within the same compute call.
const RAMP_LUT_N = 256;
const rampLut = new Float32Array(RAMP_LUT_N * 3);

interface ImgCache {
  lastKey: WebGLTexture | null;
  data: Uint8ClampedArray | null;
  w: number;
  h: number;
}

function ensureState(ctx: RenderContext, nodeId: string): ImgCache {
  const key = `instance-color-3d:${nodeId}`;
  const existing = ctx.state[key] as ImgCache | undefined;
  if (existing) return existing;
  const st: ImgCache = { lastKey: null, data: null, w: 0, h: 0 };
  ctx.state[key] = st;
  return st;
}

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

export const instanceColor3DNode: NodeDefinition = {
  type: "instance-color-3d",
  name: "Instance Color",
  category: "3d",
  description:
    "Tints each copy in an instance stream — solid, seeded random between two colors, a world-space gradient through a color ramp along a steerable axis, or an image sampled at each copy's position. Free on the GPU (three's instanceColor); chain between 3D Copy to Points and the scene.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "instances", type: "instances", required: true },
    { name: "image", type: "image", required: false, label: "Image" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["solid", "random", "gradient", "image"],
      default: "random",
      control: "segmented",
    },
    {
      name: "color_a",
      label: "Color A",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.mode === "solid" || p.mode === "random",
    },
    {
      name: "color_b",
      label: "Color B",
      type: "color",
      default: "#3366ff",
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "ramp",
      label: "Ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#3366ff" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.mode === "gradient",
    },
    {
      name: "ramp_interp",
      label: "Interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) => p.mode === "gradient",
    },
    // Gradient axis: +Y (bottom → top) rotated by these angles — e.g.
    // Z = 90° tips it onto −X for a horizontal sweep.
    { name: "rot_x", label: "Rotate X (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0, visibleIf: (p) => p.mode === "gradient" },
    { name: "rot_y", label: "Rotate Y (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0, visibleIf: (p) => p.mode === "gradient" },
    { name: "rot_z", label: "Rotate Z (°)", type: "scalar", min: -180, max: 180, step: 0.1, default: 0, visibleIf: (p) => p.mode === "gradient" },
    {
      name: "plane",
      label: "Plane",
      type: "enum",
      options: ["xz", "xy"],
      default: "xz",
      control: "segmented",
      visibleIf: (p) => p.mode === "image",
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
      visibleIf: (p) => p.mode === "image",
    },
  ],
  primaryOutput: "instances",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.instances as InstancesValue | undefined;
    if (!src || src.kind !== "instances") return {};

    const mode = ((params.mode as string) ?? "random") as
      | "solid"
      | "random"
      | "gradient"
      | "image";
    const a = new THREE.Color((params.color_a as string) ?? "#ffffff");
    const b = new THREE.Color((params.color_b as string) ?? "#3366ff");
    const seedMix = Math.imul(
      Math.round((params.seed as number) ?? 0),
      0x9e3779b1
    );

    // Image mode: readback (identity-cached) + planar mapping.
    let buf: ImgCache | null = null;
    let plane: "xz" | "xy" = "xz";
    let planeSize = 2;
    if (mode === "image") {
      const img = inputs.image;
      if (!img || img.kind !== "image") {
        // Nothing wired yet — pass through untinted so the user can wire.
        return { primary: src };
      }
      const iv = img as ImageValue;
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
        if (!data) return { primary: src };
        st.lastKey = iv.texture;
        st.data = data;
        st.w = w;
        st.h = h;
      }
      buf = st;
    }

    const n = src.count;
    const colors = new Float32Array(n * 3);
    const c = new THREE.Color();

    // Gradient mode: steerable world-space axis (+Y rotated by the angle
    // params), auto-normalized over the cloud's extent along it. The
    // min/max prepass keeps t in [0,1] whatever the cloud's size — the
    // ramp always spans the copies.
    const DEG = Math.PI / 180;
    let axisX = 0;
    let axisY = 1;
    let axisZ = 0;
    let dMin = 0;
    let dInvRange = 0;
    let stops: ColorRampStop[] = [];
    let interp: ColorRampInterp = "linear";
    if (mode === "gradient") {
      const axis = new THREE.Vector3(0, 1, 0).applyEuler(
        new THREE.Euler(
          ((params.rot_x as number) ?? 0) * DEG,
          ((params.rot_y as number) ?? 0) * DEG,
          ((params.rot_z as number) ?? 0) * DEG
        )
      );
      axisX = axis.x;
      axisY = axis.y;
      axisZ = axis.z;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const d =
          src.positions[i * 3] * axisX +
          src.positions[i * 3 + 1] * axisY +
          src.positions[i * 3 + 2] * axisZ;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      dMin = lo;
      dInvRange = hi - lo > 1e-9 ? 1 / (hi - lo) : 0;
      stops = Array.isArray(params.ramp)
        ? (params.ramp as ColorRampStop[])
        : [];
      interp = ((params.ramp_interp as string) ?? "linear") as ColorRampInterp;
      // Bake the ramp once per eval (the sampler re-sorts stops per call —
      // fine 256×, not fine per-instance).
      for (let k = 0; k < RAMP_LUT_N; k++) {
        const [r, g, b2] = sampleColorRampRgba01(
          stops,
          k / (RAMP_LUT_N - 1),
          interp
        );
        rampLut[k * 3] = r;
        rampLut[k * 3 + 1] = g;
        rampLut[k * 3 + 2] = b2;
      }
    }

    for (let i = 0; i < n; i++) {
      if (mode === "image") {
        // World position → plane UV (the Copy to Points bridge mapping,
        // inverted): XZ ground has authored-v along +z; XY billboard
        // flips world y-up back to v-down. Readback rows are top-down.
        const x = src.positions[i * 3];
        const y = src.positions[i * 3 + 1];
        const z = src.positions[i * 3 + 2];
        const u = x / planeSize + 0.5;
        const v = plane === "xz" ? z / planeSize + 0.5 : 0.5 - y / planeSize;
        const px = Math.max(
          0,
          Math.min(buf!.w - 1, Math.floor(u * buf!.w))
        );
        const py = Math.max(
          0,
          Math.min(buf!.h - 1, Math.floor(v * buf!.h))
        );
        const o = (py * buf!.w + px) * 4;
        c.setRGB(
          buf!.data![o] / 255,
          buf!.data![o + 1] / 255,
          buf!.data![o + 2] / 255,
          THREE.SRGBColorSpace
        );
      } else if (mode === "solid") {
        c.copy(a);
      } else if (mode === "gradient") {
        const d =
          src.positions[i * 3] * axisX +
          src.positions[i * 3 + 1] * axisY +
          src.positions[i * 3 + 2] * axisZ;
        const t = dInvRange > 0 ? (d - dMin) * dInvRange : 0.5;
        const k =
          Math.max(0, Math.min(RAMP_LUT_N - 1, Math.round(t * (RAMP_LUT_N - 1)))) * 3;
        // Ramp colors are sRGB — convert like the image path.
        c.setRGB(rampLut[k], rampLut[k + 1], rampLut[k + 2], THREE.SRGBColorSpace);
      } else {
        c.copy(a).lerp(b, hash01(i ^ seedMix));
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const out: InstancesValue = { ...src, colors };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[`instance-color-3d:${nodeId}`];
  },
};
