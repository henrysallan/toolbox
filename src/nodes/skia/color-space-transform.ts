import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { colorSpaceTransformNode } from "../effect/color-space-transform";

// Color Space (Skia) — the Skia-layer port of Color Space
// (specdocs/101326_skia-target.md §3.2): decode the source transfer, source
// gamut → linear sRGB, the optional view transform (ACES fit, AgX base,
// Hable filmic — the GL node's constants verbatim), linear sRGB →
// destination gamut, encode the destination transfer. The two gamut
// matrices are solved here per `from` / `to` (derived binds) exactly as the
// GL node bakes them CPU-side.
//
// The space table is the GL node's (nodes/effect/color-space-transform.ts
// keeps it module-private); check:skia-color asserts every constant below
// still appears in that file, so the copies cannot drift silently.

type Mat3 = number[]; // row-major

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ACESCG_TO_SRGB: Mat3 = [
  1.7048586763, -0.6217160219, -0.0832993717,
  -0.1300768242, 1.1407357748, -0.0105598017,
  -0.0239640729, -0.1289755083, 1.153014019,
];
const SRGB_TO_ACESCG: Mat3 = [
  0.6130974024, 0.3395231462, 0.0474502215,
  0.0701937225, 0.9163538791, 0.0134523985,
  0.0206155929, 0.1095697729, 0.8698146341,
];
const AP0_TO_AP1: Mat3 = [
  1.4514393161, -0.2365107469, -0.2149285693,
  -0.0765537734, 1.1762296998, -0.0996759264,
  0.0083161484, -0.0060324498, 0.9977163014,
];
const AP1_TO_AP0: Mat3 = [
  0.6954522414, 0.1406786965, 0.1638690622,
  0.0447945634, 0.8596711185, 0.0955343182,
  -0.0055258826, 0.0040252103, 1.0015006723,
];
const SRGB_TO_P3: Mat3 = [
  0.8224621, 0.177538, 0.0,
  0.0331941, 0.9668058, 0.0,
  0.0170827, 0.0723974, 0.9105199,
];
const P3_TO_SRGB: Mat3 = [
  1.2249401, -0.2249404, 0.0,
  -0.0420569, 1.0420571, 0.0,
  -0.0196376, -0.0786361, 1.0982735,
];

// The GL node's constants, for the gate's drift check.
export const COLOR_SPACE_TABLE_CONSTANTS: Record<string, Mat3> = {
  ACESCG_TO_SRGB,
  SRGB_TO_ACESCG,
  AP0_TO_AP1,
  AP1_TO_AP0,
  SRGB_TO_P3,
  P3_TO_SRGB,
};

function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

// Transfer codes, as the shader's decode / encode switch reads them.
const TRANSFER = { linear: 0, srgb: 1, gamma22: 2, bt1886: 3 } as const;

interface SpaceDef {
  toLin: Mat3;
  fromLin: Mat3;
  transfer: number;
}

export const COLOR_SPACES: Record<string, SpaceDef> = {
  "sRGB": { toLin: IDENTITY, fromLin: IDENTITY, transfer: TRANSFER.srgb },
  "Linear sRGB": { toLin: IDENTITY, fromLin: IDENTITY, transfer: TRANSFER.linear },
  "ACEScg": { toLin: ACESCG_TO_SRGB, fromLin: SRGB_TO_ACESCG, transfer: TRANSFER.linear },
  "ACES2065-1": {
    toLin: mulMat3(ACESCG_TO_SRGB, AP0_TO_AP1),
    fromLin: mulMat3(AP1_TO_AP0, SRGB_TO_ACESCG),
    transfer: TRANSFER.linear,
  },
  "Rec.709": { toLin: IDENTITY, fromLin: IDENTITY, transfer: TRANSFER.bt1886 },
  "Gamma 2.2": { toLin: IDENTITY, fromLin: IDENTITY, transfer: TRANSFER.gamma22 },
  "Display P3": { toLin: P3_TO_SRGB, fromLin: SRGB_TO_P3, transfer: TRANSFER.srgb },
};

// A row-major 3×3 as three float3 COLUMNS (float3x3(c0, c1, c2) in SkSL).
function columns(m: Mat3): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

const COLOR_SPACE_SKSL = `float3 tbx_color_space_decode(float3 c, int t) {
  if (t == 1) {
    float3 lo = c / 12.92;
    float3 hi = pow(max((c + 0.055) / 1.055, 0.0), float3(2.4));
    return mix(hi, lo, step(c, float3(0.04045)));
  }
  if (t == 2) return pow(max(c, 0.0), float3(2.2));
  if (t == 3) return pow(max(c, 0.0), float3(2.4));
  return c;
}

float3 tbx_color_space_encode(float3 c, int t) {
  if (t == 1) {
    c = max(c, 0.0);
    float3 lo = c * 12.92;
    float3 hi = 1.055 * pow(c, float3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, step(c, float3(0.0031308)));
  }
  if (t == 2) return pow(max(c, 0.0), float3(1.0 / 2.2));
  if (t == 3) return pow(max(c, 0.0), float3(1.0 / 2.4));
  return c;
}

// ACES SDR — Stephen Hill's fitted RRT + ODT.
float3 tbx_color_space_aces(float3 c) {
  const float3x3 inMat = float3x3(0.59719, 0.07600, 0.02840,
                                  0.35458, 0.90834, 0.13383,
                                  0.04823, 0.01566, 0.83777);
  const float3x3 outMat = float3x3(1.60475, -0.10208, -0.00327,
                                   -0.53108, 1.10813, -0.07276,
                                   -0.07367, -0.00605, 1.07602);
  c = inMat * c;
  float3 a = c * (c + 0.0245786) - 0.000090537;
  float3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(outMat * (a / b), 0.0, 1.0);
}

// AgX base look (the three.js port; inset / outset in Rec.2020).
float3 tbx_color_space_agx(float3 c) {
  const float3x3 toRec2020 = float3x3(0.6274, 0.0691, 0.0164,
                                      0.3293, 0.9195, 0.0880,
                                      0.0433, 0.0114, 0.8956);
  const float3x3 fromRec2020 = float3x3(1.6605, -0.1246, -0.0182,
                                        -0.5876, 1.1329, -0.1006,
                                        -0.0728, -0.0083, 1.1187);
  const float3x3 inset = float3x3(0.856627153315983, 0.137318972929847, 0.11189821299995,
                                  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
                                  0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const float3x3 outset = float3x3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
                                   -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
                                   -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  c = inset * (toRec2020 * c);
  c = clamp((log2(max(c, float3(1e-10))) - minEv) / (maxEv - minEv), 0.0, 1.0);
  float3 x2 = c * c;
  float3 x4 = x2 * x2;
  c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
  c = fromRec2020 * (outset * c);
  return pow(max(c, 0.0), float3(2.2));
}

// Filmic — Hable's Uncharted 2 operator, white point 11.2.
float3 tbx_color_space_hable(float3 x) {
  const float A = 0.15;
  const float B = 0.50;
  const float C = 0.10;
  const float D = 0.20;
  const float E = 0.02;
  const float F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

float4 tbx_color_space(float2 uv, float2 res, float opacity, int view, float3 from_to_lin[3], int from_transfer,
                       float3 to_from_lin[3], int to_transfer, float4 src) {
  float3 c = tbx_color_space_decode(src.rgb, from_transfer);
  c = float3x3(from_to_lin[0], from_to_lin[1], from_to_lin[2]) * c;
  if (view == 1) c = tbx_color_space_aces(c);
  else if (view == 2) c = tbx_color_space_agx(c);
  else if (view == 3) c = clamp(tbx_color_space_hable(c * 2.0) / tbx_color_space_hable(float3(11.2)), 0.0, 1.0);
  c = float3x3(to_from_lin[0], to_from_lin[1], to_from_lin[2]) * c;
  c = tbx_color_space_encode(c, to_transfer);
  return float4(c, src.a * opacity);
}`;

const space = (v: unknown, fallback: string): SpaceDef => COLOR_SPACES[typeof v === "string" ? v : fallback] ?? COLOR_SPACES[fallback];

export const skiaColorSpaceTransformNode = defineSkslNode({
  type: "skia-color-space-transform",
  name: "Color Space (Skia)",
  mirrors: "color-space-transform",
  subcategory: "modifier",
  description:
    "Skia-layer Color Space: converts between sRGB, Linear sRGB, ACEScg, ACES2065-1, Rec.709, Gamma 2.2 and Display P3 with an optional ACES / AgX / Filmic view transform, fused into the layer's one runtime shader. Same params as Color Space.",
  searchAliases: ["color space", "aces", "agx", "tone map", "linear", "skia", "sksl"],
  facts: {
    gotchas: [
      "view=None is a pure gamut + transfer conversion with no clamp (values past 0..1 survive into the next Skia node); ACES/AgX/Filmic clamp to 0..1.",
      "The view transform runs in linear sRGB between the two gamut conversions, as in Color Space; Rec.709 only swaps the transfer to BT.1886 (gamma 2.4).",
      "The fused shader ends on an 8-bit sRGB canvas: a scene-linear result is clipped there, not carried as HDR.",
      "Alpha passes through × opacity (folded into the shader). Unwired, the output is transparent.",
    ],
  },
  fn: {
    id: "tbx.color_space@1",
    entry: "tbx_color_space",
    source: COLOR_SPACE_SKSL,
    params: [
      { name: "opacity", type: "float" },
      { name: "view", type: "int" },
      { name: "from_to_lin", type: "float3", count: 3 },
      { name: "from_transfer", type: "int" },
      { name: "to_from_lin", type: "float3", count: 3 },
      { name: "to_transfer", type: "int" },
    ],
    inputs: [{ name: "src", mode: "pure" }],
    cost: 1,
  },
  params: mirrorParams(colorSpaceTransformNode, ["opacity", "from", "to", "view"]),
  inputs: [{ name: "image", fnInput: "src" }],
  // `from` / `to` pick a gamut matrix and a transfer each: derived binds.
  binds({ params, nodeId }) {
    const from = space(params.from, "Linear sRGB");
    const to = space(params.to, "sRGB");
    const fromDeps = [{ node: nodeId, param: "from" }];
    const toDeps = [{ node: nodeId, param: "to" }];
    return {
      from_to_lin: bindDerived(columns(from.toLin), fromDeps),
      from_transfer: bindDerived(from.transfer, fromDeps),
      to_from_lin: bindDerived(columns(to.fromLin), toDeps),
      to_transfer: bindDerived(to.transfer, toDeps),
    };
  },
  whenUnwired: () => [0, 0, 0, 0],
});
