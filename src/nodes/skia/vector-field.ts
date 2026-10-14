import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { TEXEL_HELPER, GATHER_VELOCITY } from "@/engine/skia/library/helpers-gather";
import { bindStatic } from "@/engine/skia/scene-ir";
import { vectorFieldNode } from "../effect/vector-field";
import { flatShader, isShader, wiredInputs, withWiring } from "./gather-wiring";

// Vector Field (Skia) — the Skia-layer port of Vector Field's IMAGE-source
// branch (specdocs/101326_skia-target.md §3.2 `sksl-gather`):
// VECTOR_FIELD_IMAGE_FS line for line — the luminance gradient from four
// taps `radius` apart (y scaled by aspect), attract / repel / orbit /
// isoline, the optional `field` summed, the signed-RG velocity encoding.
// The SDF-source branch is the compiled class (buildVectorFieldSdfFS) and
// belongs to the SDF family; the Skia socket carries shaders only.
//
// Wiring, as Vector Field: no source → the field passes through untouched
// (or the neutral field when that is unwired too); the field unwired reads
// the neutral (0.5, 0.5, 0, 1), which decodes to exactly zero.

const VECTOR_FIELD_SKSL = `float tbx_vector_field_luma(float2 uv, float2 res) {
  return dot($source(tbx_texel_clamp(uv, res)).rgb, float3(0.2126, 0.7152, 0.0722));
}

float2 tbx_vector_field_from_normal(float2 n, float metric, int mode, float strength, float radius,
                                    float polarity, float invert) {
  float w;
  if (mode == 3) {
    w = metric < radius ? 1.0 : 0.0;
  } else {
    w = 1.0 - smoothstep(0.0, max(radius, 1e-5), metric);
  }
  float2 dir;
  if (mode == 0) dir = n * polarity;
  else if (mode == 1) dir = n * (-polarity);
  else dir = float2(-n.y, n.x) * polarity;
  return dir * strength * w * invert;
}

float4 tbx_vector_field(float2 uv, float2 res, int mode, float strength, float radius, int invert,
                        float source_wired, float4 field) {
  if (source_wired < 0.5) return field;
  float r = max(0.001, radius);
  float inv = invert == 1 ? -1.0 : 1.0;
  float dx = max(r, 0.002);
  float dy = dx * (res.x / res.y);
  float gx = tbx_vector_field_luma(uv + float2(dx, 0.0), res) - tbx_vector_field_luma(uv - float2(dx, 0.0), res);
  float gyUp = tbx_vector_field_luma(uv + float2(0.0, dy), res) - tbx_vector_field_luma(uv - float2(0.0, dy), res);
  float2 g = float2(gx, -gyUp);
  float len = length(g);
  float2 v = float2(0.0);
  if (len > 1e-6) v = tbx_vector_field_from_normal(g / len, 0.0, mode, strength, r, 1.0, inv);
  v += tbx_gather_velocity_decode(field);
  return tbx_gather_velocity_encode(v);
}`;

const base = defineSkslNode({
  type: "skia-vector-field",
  name: "Vector Field (Skia)",
  mirrors: "vector-field",
  subcategory: "modifier",
  description:
    "Skia-layer Vector Field (image source): turns the upstream shader's luminance gradient into a signed-RG velocity field — attract (toward bright), repel, orbit or isoline — fused into the layer's one runtime shader. Same params as Vector Field; chain another field into `field` to sum flows. The SDF-source branch is not part of this node.",
  searchAliases: ["vector field", "velocity", "flow", "attract", "orbit", "skia", "sksl"],
  facts: {
    space: { "param:radius": "canvas01" },
    gotchas: [
      "Image source only: radius is the finite-difference tap (x in width fractions, y × aspect), so a hard mask only has gradient at its rim.",
      "Four evaluations of the source per pixel, `radius` apart; the field input is read once at the pixel.",
      "Unwired source: the field passes through unchanged (or the neutral 0.5, 0.5, 0, 1); aspect_correct belongs to the SDF branch and is ignored.",
      "Output is the velocity encoding (R/G = 0.5 + v/2, Y-down, B 0, A 1): don't matte it — matte the consumer.",
    ],
  },
  fn: {
    id: "tbx.vector_field.image@1",
    entry: "tbx_vector_field",
    source: VECTOR_FIELD_SKSL,
    params: [
      { name: "mode", type: "int" },
      { name: "strength", type: "float" },
      { name: "radius", type: "float" },
      { name: "invert", type: "int" },
      { name: "source_wired", type: "float" },
    ],
    inputs: [
      { name: "source", mode: "gather", taps: 4 },
      { name: "field", mode: "pure" },
    ],
    uses: [TEXEL_HELPER, GATHER_VELOCITY],
    cost: 0.3,
  },
  params: mirrorParams(vectorFieldNode, ["mode", "strength", "radius", "invert", "aspect_correct"]),
  inputs: [
    { name: "source", label: "Source" },
    { name: "field", label: "Field (add)" },
  ],
  // Wiring is structure, not a param: a static bind (1 while the wiring is
  // unknown — data-only callers see the wired branch).
  binds({ params }) {
    const wired = wiredInputs(params);
    return { source_wired: bindStatic(!wired || wired.has("source") ? 1 : 0) };
  },
});

// The neutral field as data (tbx.gather.flat@1): a layout(color) constant
// would be color-converted on a P3 canvas and stop decoding to zero.
const NEUTRAL = bindStatic([0.5, 0.5, 0, 1]);

export const skiaVectorFieldNode = withWiring(base, (inputs, _params, nodeId) =>
  isShader(inputs.field) ? inputs : { ...inputs, field: flatShader(`${nodeId}:field`, NEUTRAL) }
);
