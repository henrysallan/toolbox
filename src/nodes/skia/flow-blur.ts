import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { GATHER_EDGE, GATHER_ORIENTATION } from "@/engine/skia/library/helpers-gather";
import { flowBlurNode } from "../effect/flow-blur";
import { wiredInputs, withWiring } from "./gather-wiring";

// Flow Blur (Skia) — the Skia-layer port of Flow Blur
// (specdocs/101326_skia-target.md §3.2 `sksl-gather`): FLOW_BLUR_FS line for
// line — a line-integral convolution that walks ± `samples` steps along the
// field (sign-coherent tangent, or a directed velocity) and averages the
// upstream in premultiplied color. BOTH inputs are gathers: the field is
// re-read at every step of the walk.
//
// Loop cap: 64 steps per side — Flow Blur's own clamp of `samples`, so the
// cap refuses nothing. Skia needs a constant bound; the loop breaks at the
// rounded `samples`.
//
// The field must be wired: unwired, Flow Blur derives a structure-tensor
// field from the image (pre-blur → Sobel → tensor blur → eigen decode,
// several passes) — multipass, no gather form. The port reports that and
// emits transparent; `smooth` (that internal field's knob) is mirrored but
// unused.

export const FLOW_BLUR_MAX_STEPS = 64;

const FLOW_BLUR_SKSL = `float4 tbx_flow_blur_pm(float2 uv, float2 res) {
  float4 c = $src(tbx_gather_edge_uv(uv, res));
  return float4(c.rgb * c.a, c.a);
}

float2 tbx_flow_blur_dir(float2 uv, float2 res, int mode) {
  float4 f = $field(tbx_gather_edge_uv(uv, res));
  return mode == 1 ? 2.0 * (f.rg - float2(0.5)) : tbx_gather_tangent_decode(f);
}

float tbx_flow_blur_weight(int i, float n, int falloff) {
  if (falloff == 1) return 1.0;
  float x = float(i) / n;
  return exp(-4.5 * x * x);
}

float4 tbx_flow_blur(float2 uv, float2 res, float length, float samples, int mode, int falloff, float opacity) {
  // Flow Blur rounds samples to an int in 1..64 (Math.round = floor(x + 0.5)).
  float n = clamp(floor(samples + 0.5), 1.0, ${FLOW_BLUR_MAX_STEPS}.0);
  float stepLen = length / n;
  float aspect = res.x / res.y;
  float4 acc = tbx_flow_blur_pm(uv, res);
  float wsum = 1.0;
  float2 t0 = tbx_flow_blur_dir(uv, res, mode);
  for (int side = 0; side < 2; side++) {
    float2 p = uv;
    float2 prev = side == 0 ? t0 : -t0;
    for (int i = 1; i <= ${FLOW_BLUR_MAX_STEPS}; i++) {
      if (float(i) > n) break;
      float2 t = tbx_flow_blur_dir(p, res, mode);
      if (mode == 0) t = tbx_gather_coherent_step(t, prev);
      else if (side == 1) t = -t;
      p += float2(t.x, -t.y * aspect) * stepLen;
      prev = t;
      float w = tbx_flow_blur_weight(i, n, falloff);
      acc += w * tbx_flow_blur_pm(p, res);
      wsum += w;
    }
  }
  float4 c = acc / wsum;
  return float4(c.a > 1e-5 ? c.rgb / c.a : float3(0.0), c.a * clamp(opacity, 0.0, 1.0));
}`;

// Evaluations of each input per pixel: the centre plus `samples` per side.
export function skiaFlowBlurTaps(params: Record<string, unknown>): { src: number; field: number } {
  const raw = typeof params.samples === "number" ? params.samples : 16;
  const n = Math.max(1, Math.min(FLOW_BLUR_MAX_STEPS, Math.round(raw)));
  return { src: 1 + 2 * n, field: 1 + 2 * n };
}

const base = defineSkslNode({
  type: "skia-flow-blur",
  name: "Flow Blur (Skia)",
  mirrors: "flow-blur",
  subcategory: "modifier",
  description:
    "Skia-layer Flow Blur: smears the upstream shader along a wired flow field's streamlines (line integral convolution), fused into the layer's one runtime shader. Same params as Flow Blur — Length is the total ± smear (canvas-width fraction), Samples the steps per side (≤ 64), Tangent or Velocity mode. The field must be wired: the internal structure-tensor field is a multipass and is not offered.",
  searchAliases: ["flow blur", "lic", "line integral convolution", "smear", "streamline", "skia", "sksl"],
  facts: {
    space: { "param:length": "canvas01" },
    gotchas: [
      "The field must be wired: Flow Blur's internal structure-tensor field is multipass, so unwired the node emits transparent and says why; smooth is unused.",
      "Both inputs are gathers re-read at every step: 1 + 2 × samples evaluations of the image AND of the field per pixel.",
      "samples rounds to 1..64 (the loop cap, Flow Blur's own clamp); step = length / samples, y scaled by aspect.",
      "Averages in premultiplied color and un-premultiplies on write; opacity scales the output alpha.",
    ],
  },
  fn: {
    id: "tbx.flow_blur@1",
    entry: "tbx_flow_blur",
    source: FLOW_BLUR_SKSL,
    params: [
      { name: "length", type: "float" },
      { name: "samples", type: "float" },
      { name: "mode", type: "int" },
      { name: "falloff", type: "int" },
      { name: "opacity", type: "float" },
    ],
    inputs: [
      { name: "src", mode: "gather", taps: "param" },
      { name: "field", mode: "gather", taps: "param" },
    ],
    uses: [GATHER_EDGE, GATHER_ORIENTATION],
    // Per evaluation at the default 16 samples: 33 steps of decode + weight.
    cost: 3,
  },
  params: mirrorParams(flowBlurNode, ["length", "samples", "mode", "falloff", "smooth", "opacity"]),
  inputs: [
    { name: "image", fnInput: "src" },
    { name: "field", label: "Field" },
  ],
  unsupported(params) {
    const wired = wiredInputs(params);
    if (!wired || wired.has("field") || !wired.has("image")) return [];
    return [
      "Flow Blur (Skia) needs its field wired: unwired, Flow Blur derives a structure-tensor field from the image in several passes, which has no single-shader form. Wire a flow field (e.g. Vector Field (Skia), or a Noise (Skia) RG).",
    ];
  },
});

export const skiaFlowBlurNode = withWiring(base);
