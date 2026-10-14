import type { GradientPoint } from "@/engine/types";
import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams, parseSkslColor } from "@/engine/skia/library";
import { gradientNode } from "../source/gradient";

// Gradient (Skia) — the Skia-layer port of Gradient
// (specdocs/101326_skia-target.md §3.2). The GL node's fragment shader line
// for line: linear (start → end handles, the angle modulator rotating the
// axis), radial, polar, wave (directional or aspect-corrected rings) with
// the two-pow softness curve, and multipoint's inverse-distance blend of up
// to 16 points. Coordinates are toolbox uv (Y-up 0..1), as the node's
// handles and its gpoint_* virtual keys store them.
//
// Not ported: the `uv_in` socket (a Skia layer remaps coordinates by
// sampling — put a warp after the gradient) and `phase_animate` (the
// internal loop clock; drive `phase` from an Animated Value instead). The
// angle modulator is a pure shader input read at the pixel, like the GL
// node's texture fetch at v_uv.

const MAX_POINTS = 16;
const MODE = (name: string) => ["linear", "radial", "polar", "wave", "multipoint"].indexOf(name);

const GRADIENT_SKSL = `float4 tbx_gradient(float2 uv, float2 res, float opacity, int mode, int wave_mode,
                    float4 color_a, float4 color_b, float start_x, float start_y, float end_x, float end_y,
                    float angle, float angle_mod_amount, float center_x, float center_y, float radius,
                    float angle_offset, float frequency, float phase, float idw_power, float softness,
                    float alpha, float2 points_pos[${MAX_POINTS}], float4 points_color[${MAX_POINTS}],
                    float points_count, float4 angle_mod) {
  const float PI = 3.14159265358979;
  const float DEG = 0.017453292519943295;
  // multipoint: inverse-distance-weighted (Shepard) blend of the point
  // colors; skips the A/B mix and the softness curve.
  if (mode == ${MODE("multipoint")}) {
    float3 acc = float3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < ${MAX_POINTS}; i++) {
      if (float(i) >= points_count) break;
      float d = max(distance(uv, points_pos[i]), 1e-4);
      float w = 1.0 / pow(d, idw_power);
      acc += w * points_color[i].rgb;
      wsum += w;
    }
    float3 c = wsum > 0.0 ? acc / wsum : float3(0.0);
    return float4(c, alpha * opacity);
  }
  // Unwired, the modulator reads transparent: no rotation.
  float angleMod = angle_mod.r * angle_mod_amount * DEG;
  float ang = angle * DEG + angleMod;
  float t = 0.0;
  if (mode == ${MODE("linear")}) {
    float2 se = float2(end_x, end_y) - float2(start_x, start_y);
    float ca = cos(angleMod);
    float sa = sin(angleMod);
    float2 d = float2(ca * se.x - sa * se.y, sa * se.x + ca * se.y);
    t = dot(uv - float2(start_x, start_y), d) / max(dot(d, d), 1e-6);
  } else if (mode == ${MODE("radial")}) {
    t = length(uv - float2(center_x, center_y)) / max(radius, 0.0001);
  } else if (mode == ${MODE("polar")}) {
    float2 p = uv - float2(center_x, center_y);
    float a = atan(p.y, p.x) + angle_offset * DEG;
    t = fract(a / (2.0 * PI) + 1.0);
  } else if (mode == ${MODE("wave")}) {
    float x;
    if (wave_mode == 1) {
      float2 p = uv - float2(center_x, center_y);
      p.y /= res.x / res.y;
      x = length(p);
    } else {
      float2 d = float2(cos(ang), sin(ang));
      x = dot(uv - 0.5, d);
    }
    t = 0.5 + 0.5 * sin(x * frequency * 2.0 * PI + phase * DEG);
  }
  t = clamp(t, 0.0, 1.0);
  float s = max(softness, 0.0001);
  t = pow(t, 1.0 / s);
  t = 1.0 - pow(1.0 - t, 1.0 / s);
  t = clamp(t, 0.0, 1.0);
  return float4(mix(color_a.rgb, color_b.rgb, t), alpha * opacity);
}`;

// The points exactly as the GL node uploads them: the first 16, x / y
// defaulting to 0.5, colors from hex or a keyframe-resolved RGBA tuple
// (alpha ignored).
export function packGradientPoints(raw: unknown): { pos: number[]; color: number[]; count: number } {
  const pts = (Array.isArray(raw) ? (raw as GradientPoint[]) : []).slice(0, MAX_POINTS);
  const pos = new Array<number>(MAX_POINTS * 2).fill(0);
  const color = new Array<number>(MAX_POINTS * 4).fill(0);
  pts.forEach((p, i) => {
    pos[i * 2] = typeof p?.x === "number" ? p.x : 0.5;
    pos[i * 2 + 1] = typeof p?.y === "number" ? p.y : 0.5;
    const [r, g, b] = parseSkslColor(p?.color, [0, 0, 0, 1]);
    color.splice(i * 4, 4, r, g, b, 1);
  });
  return { pos, color, count: pts.length };
}

export const skiaGradientNode = defineSkslNode({
  type: "skia-gradient",
  name: "Gradient (Skia)",
  mirrors: "gradient",
  subcategory: "generator",
  description:
    "Skia-layer Gradient: linear (start/end handles), radial, polar, wave (bands or rings) and multipoint (inverse-distance blend of up to 16 points) as one SkSL function fused into the layer's shader. Same params as Gradient; positions are uv (Y-up 0..1). The angle mod input rotates the linear axis / wave direction by its red channel × angle mod (°).",
  searchAliases: ["gradient", "linear gradient", "radial gradient", "multipoint", "skia", "sksl"],
  facts: {
    space: {
      "param:start_x": "uv01",
      "param:start_y": "uv01",
      "param:end_x": "uv01",
      "param:end_y": "uv01",
      "param:center_x": "uv01",
      "param:center_y": "uv01",
      "param:radius": "uv01",
      "param:points": "uv01",
    },
    gotchas: [
      "uv_in is not ported (remap coordinates with a Skia warp downstream) and phase_animate=true emits transparent: drive phase from an Animated Value.",
      "radial distance is not aspect-corrected (an ellipse on non-square canvases); only the wave ring sub-mode keeps its rings round, as in Gradient.",
      "angle_mod is read at the pixel; unwired it reads 0 (no rotation). It is ignored in radial, polar and ring-wave modes.",
      "multipoint blends at most 16 points by 1/distance^falloff and ignores softness; gpoint_x/y/c keys animate single points.",
      "Output alpha is alpha × opacity, folded into the shader.",
    ],
  },
  fn: {
    id: "tbx.gradient@1",
    entry: "tbx_gradient",
    source: GRADIENT_SKSL,
    params: [
      { name: "opacity", type: "float" },
      { name: "mode", type: "int" },
      { name: "wave_mode", type: "int" },
      { name: "color_a", type: "color" },
      { name: "color_b", type: "color" },
      { name: "start_x", type: "float" },
      { name: "start_y", type: "float" },
      { name: "end_x", type: "float" },
      { name: "end_y", type: "float" },
      { name: "angle", type: "float" },
      { name: "angle_mod_amount", type: "float" },
      { name: "center_x", type: "float" },
      { name: "center_y", type: "float" },
      { name: "radius", type: "float" },
      { name: "angle_offset", type: "float" },
      { name: "frequency", type: "float" },
      { name: "phase", type: "float" },
      { name: "idw_power", type: "float" },
      { name: "softness", type: "float" },
      { name: "alpha", type: "float" },
      { name: "points_pos", type: "float2", count: MAX_POINTS },
      { name: "points_color", type: "color", count: MAX_POINTS },
      { name: "points_count", type: "float" },
    ],
    inputs: [{ name: "angle_mod", mode: "pure" }],
    // Multipoint walks up to 16 points; the other modes are a handful of ops.
    cost: 1,
  },
  params: mirrorParams(gradientNode, [
    "opacity",
    "mode",
    "wave_mode",
    "color_a",
    "color_b",
    "start_x",
    "start_y",
    "end_x",
    "end_y",
    "angle",
    "angle_mod_amount",
    "center_x",
    "center_y",
    "radius",
    "angle_offset",
    "frequency",
    "phase",
    "phase_animate",
    "phase_start",
    "phase_end",
    "phase_rate",
    "points",
    "idw_power",
    "softness",
    "alpha",
  ]),
  inputs: [{ name: "angle_mod", label: "angle mod" }],
  // The points array is one param split into uniform arrays: derived binds,
  // so per-point (gpoint_*) keyframes export as a sampled bind.
  binds({ params, nodeId }) {
    const { pos, color, count } = packGradientPoints(params.points);
    const deps = [{ node: nodeId, param: "points" }];
    return {
      points_pos: bindDerived(pos, deps),
      points_color: bindDerived(color, deps),
      points_count: bindDerived(count, deps),
    };
  },
  unsupported(params) {
    const out: string[] = [];
    if (params.mode === "wave" && params.phase_animate === true) {
      out.push("Gradient (Skia) does not port phase_animate (the internal loop clock) — drive `phase` from an Animated Value instead.");
    }
    return out;
  },
});
