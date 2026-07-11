import { OPACITY_PARAM } from "@/engine/conventions";
import type { ImageValue, NodeDefinition } from "@/engine/types";

// Color Space transform — the analytic half of the EXR/ACES pipeline (spec:
// specdocs/070926_exr-color-pipeline.md). Decode the source transfer →
// convert gamut to scene-linear Rec.709/sRGB (the working hub) → optional
// view transform (tone map) → convert to the destination gamut → encode the
// destination transfer. All matrix math is baked CPU-side into two mat3
// uniforms; no LUTs, no clamping beyond what the encode step demands, so
// scene-linear HDR passes through intact when both ends are linear.
//
// The canonical EXR graph: EXR (ACEScg) → [effects in linear] →
// Color Space (from ACEScg, to sRGB, view ACES) → Output.

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform mat3 u_toLin;    // source gamut → linear sRGB (after transfer decode)
uniform mat3 u_fromLin;  // linear sRGB → dest gamut (before transfer encode)
uniform int u_fromTransfer; // 0 linear, 1 sRGB, 2 gamma 2.2, 3 BT.1886 (2.4)
uniform int u_toTransfer;
uniform int u_view;      // 0 none, 1 ACES, 2 AgX, 3 Filmic (Hable)
out vec4 outColor;

vec3 decodeTransfer(vec3 c, int t) {
  if (t == 1) {
    vec3 lo = c / 12.92;
    vec3 hi = pow(max((c + 0.055) / 1.055, 0.0), vec3(2.4));
    return mix(hi, lo, step(c, vec3(0.04045)));
  }
  if (t == 2) return pow(max(c, 0.0), vec3(2.2));
  if (t == 3) return pow(max(c, 0.0), vec3(2.4));
  return c;
}

vec3 encodeTransfer(vec3 c, int t) {
  if (t == 1) {
    c = max(c, 0.0);
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, step(c, vec3(0.0031308)));
  }
  if (t == 2) return pow(max(c, 0.0), vec3(1.0 / 2.2));
  if (t == 3) return pow(max(c, 0.0), vec3(1.0 / 2.4));
  return c;
}

// ── View transforms (input & output: linear sRGB) ────────────────────────

// ACES SDR — Stephen Hill's fitted RRT + ODT.
const mat3 ACESInputMat = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACESOutputMat = mat3(
  1.60475, -0.10208, -0.00327,
  -0.53108, 1.10813, -0.07276,
  -0.07367, -0.00605, 1.07602
);
vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 viewAces(vec3 c) {
  c = ACESInputMat * c;
  c = rrtAndOdtFit(c);
  return clamp(ACESOutputMat * c, 0.0, 1.0);
}

// AgX (base look) — Blender 4.x's default view, via the three.js port. The
// inset/outset matrices operate in Rec.2020.
const mat3 LinSrgbToRec2020 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0114, 0.8956
);
const mat3 Rec2020ToLinSrgb = mat3(
  1.6605, -0.1246, -0.0182,
  -0.5876, 1.1329, -0.1006,
  -0.0728, -0.0083, 1.1187
);
const mat3 AgXInsetMatrix = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859
);
const mat3 AgXOutsetMatrix = mat3(
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
);
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
    - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 viewAgx(vec3 c) {
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  c = AgXInsetMatrix * (LinSrgbToRec2020 * c);
  c = clamp((log2(max(c, vec3(1e-10))) - minEv) / (maxEv - minEv), 0.0, 1.0);
  c = agxContrast(c);
  c = Rec2020ToLinSrgb * (AgXOutsetMatrix * c);
  // The sigmoid's output is 2.2-gamma-encoded — return to linear.
  return pow(max(c, 0.0), vec3(2.2));
}

// Filmic — Hable's Uncharted 2 operator, white point 11.2.
vec3 hable(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 viewFilmic(vec3 c) {
  vec3 mapped = hable(c * 2.0) / hable(vec3(11.2));
  return clamp(mapped, 0.0, 1.0);
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c = decodeTransfer(src.rgb, u_fromTransfer);
  c = u_toLin * c;
  if (u_view == 1) c = viewAces(c);
  else if (u_view == 2) c = viewAgx(c);
  else if (u_view == 3) c = viewFilmic(c);
  c = u_fromLin * c;
  c = encodeTransfer(c, u_toTransfer);
  outColor = vec4(c, src.a);
}`;

// ── CPU-side space table ──────────────────────────────────────────────────
// Row-major 3×3s; identity = the space already uses Rec.709/sRGB primaries.
// ACES matrices carry the Bradford D60↔D65 adaptation (standard published
// ACEScg↔linear-sRGB values).

type Mat3 = number[]; // row-major, 9 entries

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

function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

// uniformMatrix3fv wants column-major.
function colMajor(m: Mat3): Float32Array {
  return new Float32Array([
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ]);
}

// Transfer codes match the shader's decode/encodeTransfer.
const TRANSFER = { linear: 0, srgb: 1, gamma22: 2, bt1886: 3 } as const;

interface SpaceDef {
  toLin: Mat3; // this gamut → linear sRGB
  fromLin: Mat3; // linear sRGB → this gamut
  transfer: number;
}

// Option strings are the stored param values — immutable once shipped.
const SPACES: Record<string, SpaceDef> = {
  "sRGB": { toLin: IDENTITY, fromLin: IDENTITY, transfer: TRANSFER.srgb },
  "Linear sRGB": {
    toLin: IDENTITY,
    fromLin: IDENTITY,
    transfer: TRANSFER.linear,
  },
  "ACEScg": {
    toLin: ACESCG_TO_SRGB,
    fromLin: SRGB_TO_ACESCG,
    transfer: TRANSFER.linear,
  },
  "ACES2065-1": {
    toLin: mulMat3(ACESCG_TO_SRGB, AP0_TO_AP1),
    fromLin: mulMat3(AP1_TO_AP0, SRGB_TO_ACESCG),
    transfer: TRANSFER.linear,
  },
  "Rec.709": { toLin: IDENTITY, fromLin: IDENTITY, transfer: TRANSFER.bt1886 },
  "Gamma 2.2": {
    toLin: IDENTITY,
    fromLin: IDENTITY,
    transfer: TRANSFER.gamma22,
  },
  "Display P3": {
    toLin: P3_TO_SRGB,
    fromLin: SRGB_TO_P3,
    transfer: TRANSFER.srgb,
  },
};

const SPACE_OPTIONS = Object.keys(SPACES);
const VIEW_OPTIONS = ["None", "ACES", "AgX", "Filmic"];

export const colorSpaceTransformNode: NodeDefinition = {
  type: "color-space-transform",
  name: "Color Space",
  category: "image",
  subcategory: "modifier",
  description:
    "Convert between color spaces (sRGB, linear, ACEScg, ACES2065-1, Rec.709, Display P3) with an optional view transform (ACES / AgX / Filmic tone mapping) — the display step for scene-linear EXR renders.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    OPACITY_PARAM,
    {
      name: "from",
      label: "From",
      type: "enum",
      options: SPACE_OPTIONS,
      default: "Linear sRGB",
    },
    {
      name: "to",
      label: "To",
      type: "enum",
      options: SPACE_OPTIONS,
      default: "sRGB",
    },
    // Tone map, applied in scene-linear between the two gamut conversions.
    // "None" = a pure technical conversion (HDR passes through unclamped).
    {
      name: "view",
      label: "View transform",
      type: "enum",
      options: VIEW_OPTIONS,
      default: "None",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.image as ImageValue | undefined;
    const output = ctx.allocImage();
    if (!src) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const from = SPACES[(params.from as string) ?? "Linear sRGB"] ??
      SPACES["Linear sRGB"];
    const to = SPACES[(params.to as string) ?? "sRGB"] ?? SPACES["sRGB"];
    const view = Math.max(0, VIEW_OPTIONS.indexOf((params.view as string) ?? "None"));

    const prog = ctx.getShader("color-space-transform/main", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniformMatrix3fv(
        gl.getUniformLocation(prog, "u_toLin"),
        false,
        colMajor(from.toLin)
      );
      gl.uniformMatrix3fv(
        gl.getUniformLocation(prog, "u_fromLin"),
        false,
        colMajor(to.fromLin)
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_fromTransfer"), from.transfer);
      gl.uniform1i(gl.getUniformLocation(prog, "u_toTransfer"), to.transfer);
      gl.uniform1i(gl.getUniformLocation(prog, "u_view"), view);
    });

    return { primary: output };
  },
};
