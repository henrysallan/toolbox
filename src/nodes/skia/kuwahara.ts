import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { TEXEL_HELPER, GATHER_ORIENTATION } from "@/engine/skia/library/helpers-gather";
import { kuwaharaNode } from "../effect/kuwahara";
import { wiredInputs, withWiring } from "./gather-wiring";

// Kuwahara (Skia) — the Skia-layer port of Kuwahara
// (specdocs/101326_skia-target.md §3.2 `sksl-gather`): KUWAHARA_FS line for
// line — 8 overlapping polynomial sectors (Kyprianidis et al.) over an
// ellipse aligned to the field's tangent (anisotropic) or a disc
// (generalized), premultiplied sector means / variances, the
// low-variance sectors winning.
//
// Kernel cap: KUWAHARA_SKIA_MAX_EXTENT = 24 px half-extent (Kuwahara's own
// is 48). Skia needs constant loop bounds, so the loops run to 2 × 24 + 1
// and break at the actual extent: a pixel pays for its radius, the cap only
// bounds the worst case (49² = 2,401 positions, ≈ 1,800 taps inside the
// disc). radius > 24 is refused (the disc itself would be clipped); in
// anisotropic mode a stroke whose major half-axis radius × (1 + A) passes
// 24 px is clipped there, where Kuwahara clips at 48.
//
// Anisotropic mode needs the field wired: unwired, Kuwahara derives a
// structure-tensor field in several passes (multipass, no gather form).
// Generalized mode ignores the field, as Kuwahara does. `smooth` (the
// internal field's knob) is mirrored but unused.

export const KUWAHARA_SKIA_MAX_EXTENT = 24;
const E = KUWAHARA_SKIA_MAX_EXTENT;

const KUWAHARA_SKSL = `float4 tbx_kuwahara(float2 uv, float2 res, float radius, int mode, float sharpness, float hardness,
                    float anisotropy, float min_coherence, float opacity, float4 field) {
  float2 invRes = 1.0 / res;
  float2 t = tbx_gather_tangent_decode(field);
  float A = max(tbx_gather_coherence_decode(field), min_coherence) * anisotropy;
  if (mode == 1 || dot(t, t) < 0.5) {
    t = float2(1.0, 0.0);
    A = 0.0;
  }
  A = clamp(A, 0.0, 2.0);
  // Ellipse frame in pixel space. The tangent is Y-DOWN; uv steps are Y-UP.
  float2 major = float2(t.x, -t.y);
  float2 minor = float2(-major.y, major.x);
  float a = radius * (1.0 + A);
  float b = radius / (1.0 + A);
  int ext = int(min(ceil(a), ${E}.0));
  // Sector-weight constants: lobes cross at equal weight 22.5 degrees apart (N = 8).
  float zeta = 0.33;
  float zeroCross = 0.58;
  float eta = (zeta + cos(zeroCross)) / (sin(zeroCross) * sin(zeroCross));
  float4 m[8];
  float wsum[8];
  float3 s[8];
  for (int k = 0; k < 8; k++) {
    m[k] = float4(0.0);
    wsum[k] = 0.0;
    s[k] = float3(0.0);
  }
  for (int j = 0; j <= ${2 * E}; j++) {
    if (j > 2 * ext) break;
    for (int i = 0; i <= ${2 * E}; i++) {
      if (i > 2 * ext) break;
      float2 off = float2(float(i - ext), float(j - ext));
      // Into the unit disc of the ellipse frame.
      float2 v = float2(dot(off, major) / a, dot(off, minor) / b);
      float r2 = dot(v, v);
      if (r2 > 1.0) continue;
      float4 c = $src(tbx_texel_clamp(uv + off * invRes, res));
      float4 pm = float4(c.rgb * c.a, c.a);
      float w[8];
      float zsum = 0.0;
      float vxx = zeta - eta * v.x * v.x;
      float vyy = zeta - eta * v.y * v.y;
      float z;
      z = max(0.0, v.y + vxx); w[0] = z * z; zsum += w[0];
      z = max(0.0, -v.x + vyy); w[2] = z * z; zsum += w[2];
      z = max(0.0, -v.y + vxx); w[4] = z * z; zsum += w[4];
      z = max(0.0, v.x + vyy); w[6] = z * z; zsum += w[6];
      float2 vr = 0.7071068 * float2(v.x - v.y, v.x + v.y);
      vxx = zeta - eta * vr.x * vr.x;
      vyy = zeta - eta * vr.y * vr.y;
      z = max(0.0, vr.y + vxx); w[1] = z * z; zsum += w[1];
      z = max(0.0, -vr.x + vyy); w[3] = z * z; zsum += w[3];
      z = max(0.0, -vr.y + vxx); w[5] = z * z; zsum += w[5];
      z = max(0.0, vr.x + vyy); w[7] = z * z; zsum += w[7];
      float g = exp(-3.125 * r2) / max(zsum, 1e-5);
      for (int k = 0; k < 8; k++) {
        float wk = w[k] * g;
        m[k] += pm * wk;
        wsum[k] += wk;
        s[k] += pm.rgb * pm.rgb * wk;
      }
    }
  }
  float4 acc = float4(0.0);
  float accW = 0.0;
  for (int k = 0; k < 8; k++) {
    if (wsum[k] < 1e-6) continue;
    float4 mean = m[k] / wsum[k];
    float3 varc = max(s[k] / wsum[k] - mean.rgb * mean.rgb, 0.0);
    float sigma2 = varc.r + varc.g + varc.b;
    float wk = 1.0 / (1.0 + pow(hardness * 1000.0 * sigma2, 0.5 * sharpness));
    acc += mean * wk;
    accW += wk;
  }
  float4 c;
  if (accW > 1e-6) c = acc / accW;
  else c = $src(tbx_texel_clamp(uv, res));
  return float4(c.a > 1e-5 ? c.rgb / c.a : float3(0.0), c.a * clamp(opacity, 0.0, 1.0));
}`;

// Evaluations of the image per pixel: the lattice points of the disc of
// `radius` (an ellipse of the same area in anisotropic mode, ≈ π r²).
export function skiaKuwaharaTaps(params: Record<string, unknown>): { src: number; field: number } {
  const r = typeof params.radius === "number" ? params.radius : 6;
  const ext = Math.min(Math.ceil(r), E);
  let n = 0;
  for (let dy = -ext; dy <= ext; dy++) for (let dx = -ext; dx <= ext; dx++) if ((dx * dx + dy * dy) / (r * r) <= 1) n++;
  return { src: n, field: 1 };
}

const base = defineSkslNode({
  type: "skia-kuwahara",
  name: "Kuwahara (Skia)",
  mirrors: "kuwahara",
  subcategory: "modifier",
  description:
    "Skia-layer Kuwahara: painterly smoothing that pools the least-varying of 8 sectors around each pixel, fused into the layer's one runtime shader by re-evaluating the upstream at every pixel of the kernel. Same params as Kuwahara. Generalized (round facets) works alone; Anisotropic needs a wired field to stretch strokes along. Radius up to 24 px.",
  searchAliases: ["kuwahara", "painterly", "oil paint", "facets", "skia", "sksl"],
  facts: {
    space: { "param:radius": "pixels" },
    gotchas: [
      "Re-evaluates the upstream ≈ π·radius² times per pixel (113 at radius 6): over a procedural chain this is the most expensive node in the library.",
      "radius caps at 24 px (refused above); anisotropic strokes clip at a 24 px major half-axis, where Kuwahara clips at 48.",
      "mode=anisotropic needs the field wired (Kuwahara's internal structure-tensor field is multipass); generalized ignores the field.",
      "radius is in canvas pixels (1 / iResolution); on a device it is points. smooth is unused.",
    ],
  },
  fn: {
    id: "tbx.kuwahara@1",
    entry: "tbx_kuwahara",
    source: KUWAHARA_SKSL,
    params: [
      { name: "radius", type: "float" },
      { name: "mode", type: "int" },
      { name: "sharpness", type: "float" },
      { name: "hardness", type: "float" },
      { name: "anisotropy", type: "float" },
      { name: "min_coherence", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: [
      { name: "src", mode: "gather", taps: "param" },
      { name: "field", mode: "pure" },
    ],
    uses: [TEXEL_HELPER, GATHER_ORIENTATION],
    // Integer pixel offsets from the pixel, clamped: on texel centres.
    gridTaps: ["src"],
    // Its own ALU at the default radius 6: 113 taps × ≈ 1.5 (8 sector
    // weights and accumulators per tap).
    cost: 170,
    // The cost readout at the current radius (estimateShaderCost
    // `at: "params"`); the split decision stays on the declared numbers.
    tapsAt: (p) => skiaKuwaharaTaps(p),
    costAt: (p) => 1.5 * skiaKuwaharaTaps(p).src,
  },
  params: mirrorParams(kuwaharaNode, ["radius", "mode", "sharpness", "hardness", "anisotropy", "min_coherence", "smooth", "opacity"]),
  inputs: [
    { name: "image", fnInput: "src" },
    { name: "field", label: "Field" },
  ],
  unsupported(params) {
    const out: string[] = [];
    const radius = typeof params.radius === "number" ? params.radius : 6;
    if (radius > E) {
      out.push(`Kuwahara (Skia) caps radius at ${E} px (constant loop bounds; Kuwahara's own cap is 48); radius=${radius} would clip the kernel.`);
    }
    const wired = wiredInputs(params);
    const mode = (params.mode as string) ?? "anisotropic";
    if (wired && mode === "anisotropic" && wired.has("image") && !wired.has("field")) {
      out.push(
        "Kuwahara (Skia) anisotropic needs its field wired: unwired, Kuwahara derives a structure-tensor field in several passes, which has no single-shader form. Wire a field, or use mode=generalized."
      );
    }
    return out;
  },
});

export const skiaKuwaharaNode = withWiring(base);
