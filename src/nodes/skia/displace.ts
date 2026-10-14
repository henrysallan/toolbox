import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { TEXEL_HELPER } from "@/engine/skia/library/helpers-gather";
import { bindDerived } from "@/engine/skia/scene-ir";
import { displaceNode } from "../effect/displace";
import { flatShader, isShader, withWiring } from "./gather-wiring";

// Displace (Skia) — the Skia-layer port of Displace's IMAGE branch
// (specdocs/101326_skia-target.md §3.2 `sksl-gather`). DISPLACE_FS line for
// line: the map is a pure input read at the pixel's own uv, the source a
// gather read once at the displaced uv. The spline / points branches are
// geometry and have no shader form — the Skia sockets carry shaders only.
//
// Unwired map: Displace passes the source through. The port feeds a
// constant map at `midlevel` instead (offset 0, rotation 0), bound as a
// value derived from `midlevel` so an animated midlevel still exports.

const DISPLACE_SKSL = `float tbx_displace_pick(float4 c, int ch) {
  if (ch == 0) return c.r;
  if (ch == 1) return c.g;
  if (ch == 2) return c.b;
  if (ch == 3) return c.a;
  return dot(c.rgb, float3(0.2126, 0.7152, 0.0722));
}

float2 tbx_displace_wrap(float2 uv, int wrap) {
  if (wrap == 1) return clamp(uv, 0.0, 1.0);
  if (wrap == 2) return abs(fract(uv * 0.5) * 2.0 - 1.0);
  return uv;
}

float4 tbx_displace(float2 uv, float2 res, float amountX, float amountY, int channelX, int channelY,
                    float midlevel, int rotate, float rotateAmount, int wrap, float4 disp) {
  float vx = tbx_displace_pick(disp, channelX);
  float vy = tbx_displace_pick(disp, channelY);
  // Midlevel is the "no displacement" value (0.5 for signed 8-bit maps).
  float2 offset = float2((vx - midlevel) * amountX, (vy - midlevel) * amountY);
  float2 p = uv;
  if (rotate == 1) {
    float luma = dot(disp.rgb, float3(0.2126, 0.7152, 0.0722));
    float angle = (luma - midlevel) * 2.0 * (rotateAmount * 0.017453292519943295);
    float2 q = uv - 0.5;
    float c = cos(angle);
    float s = sin(angle);
    // Positive angle is clockwise on screen; uv is Y-UP (do not negate).
    q = float2(c * q.x - s * q.y, s * q.x + c * q.y);
    p = q + 0.5;
  }
  p += offset;
  if (wrap == 0 && (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0)) return float4(0.0);
  return $src(tbx_texel_clamp(tbx_displace_wrap(p, wrap), res));
}`;

const base = defineSkslNode({
  type: "skia-displace",
  name: "Displace (Skia)",
  mirrors: "displace",
  subcategory: "modifier",
  description:
    "Skia-layer Displace: pushes each pixel of the upstream shader by a vector read from the displacement shader, fused into the layer's one runtime shader. Same params as Displace (per-axis amount in uv fractions, channel X/Y, midlevel, optional rotate from the map's luminance, edge rule). Image branch only — spline and points displacement stay on the default layer.",
  searchAliases: ["displace", "displacement", "warp", "offset", "skia", "sksl"],
  facts: {
    space: { "param:amountX": "uv01", "param:amountY": "uv01" },
    gotchas: [
      "amountX/Y are per-axis uv fractions ((channel − midlevel) × amount), not aspect-corrected, exactly as Displace.",
      "The map is read at the pixel's own uv; the source is re-evaluated once at the displaced uv (a 1-tap gather), not sampled from a texture.",
      "Unwired map: passes the source through, like Displace (the port feeds a constant map at midlevel).",
      "wrap=mirror maps uv to 1 − uv inside the frame (abs(fract(uv/2)·2 − 1)), so the image flips; ported as Displace has it.",
      "Image branch only: the Skia sockets carry shaders, so spline / points displacement has no Skia form.",
    ],
  },
  fn: {
    id: "tbx.displace@1",
    entry: "tbx_displace",
    source: DISPLACE_SKSL,
    params: [
      { name: "amountX", type: "float" },
      { name: "amountY", type: "float" },
      { name: "channelX", type: "int" },
      { name: "channelY", type: "int" },
      { name: "midlevel", type: "float" },
      { name: "rotate", type: "int" },
      { name: "rotateAmount", type: "float" },
      { name: "wrap", type: "int" },
    ],
    inputs: [
      { name: "src", mode: "gather", taps: 1 },
      { name: "disp", mode: "pure" },
    ],
    uses: [TEXEL_HELPER],
    cost: 0.2,
  },
  params: mirrorParams(displaceNode, ["amountX", "amountY", "channelX", "channelY", "midlevel", "rotate", "rotateAmount", "wrap"]),
  inputs: [
    { name: "image", label: "image", fnInput: "src" },
    { name: "displacement", label: "displace", fnInput: "disp" },
  ],
});

export const skiaDisplaceNode = withWiring(base, (inputs, params, nodeId) => {
  if (isShader(inputs.displacement)) return inputs;
  const raw = params.midlevel;
  const m = typeof raw === "number" && Number.isFinite(raw) ? raw : 0.5;
  const flat = flatShader(`${nodeId}:displacement`, bindDerived([m, m, m, m], [{ node: nodeId, param: "midlevel" }]));
  return { ...inputs, displacement: flat };
});
