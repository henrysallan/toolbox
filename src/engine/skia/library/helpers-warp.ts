// SkSL helpers shared by the warp family (Wave 2 F3: Transform, Mirror,
// Polar Coords, Pixelate, Array — src/nodes/skia/{transform,mirror,
// polar-coords,pixelate,array}.ts). Same rules as helpers.ts: every name
// starts with `tbx_warp_` (never with a library entry name, or a gather
// copy's rename would rewrite the call), float-only, emitted once per
// fused program by id. Each warp node imports this module for its side
// effect before defining itself, so the helpers are registered whenever a
// warp function is.
//
// A warp is an inverse sampler: it maps the output uv to the uv its
// upstream is read at (a `$input(uv2)` gather, fuse.ts), then applies the
// original GL node's edge rule there. Engine textures are CLAMP_TO_EDGE +
// LINEAR, so "inside" below is the closed [lo, hi] box the GL shaders test.

import type { Bind } from "../scene-ir";
import { registerSkslHelper } from "./registry";
import { TEXEL_HELPER } from "./texel";

export { TEXEL_HELPER };

// Degrees → radians, applied as `value * scale` exactly like an exported
// scaled track (toolbox-timeline.ts), so preview and device bind the same
// float the GL node computes in JS (`deg * Math.PI / 180`).
export const WARP_DEG = Math.PI / 180;

// A degrees param bound in radians: the lib param keeps the toolbox name,
// its ref carries `scale: π/180` (scene-ir.ts BindRef.scale), as Skia
// Group's rotate does.
export function bindDegrees(params: Record<string, unknown>, nodeId: string, name: string, fallback = 0): Bind<number> {
  const raw = params[name];
  const deg = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return { v: deg * WARP_DEG, ref: { node: nodeId, param: name, scale: WARP_DEG } };
}

// The GL warps' bounds test: `uv.x < lo.x || uv.x > hi.x || …` (closed box,
// edges inside).
registerSkslHelper({
  id: "tbx.warp.outside",
  source: `bool tbx_warp_outside(float2 q, float2 lo, float2 hi) {
  return q.x < lo.x || q.x > hi.x || q.y < lo.y || q.y > hi.y;
}`,
});

// CLAMP_TO_EDGE, the engine's wrap mode: a GL warp that samples its input
// texture past the outermost texel CENTERS reads the edge texel, so a port
// must not evaluate its upstream out there (that would extrapolate it — a
// pixelate cell centered beyond the top edge, say). It clamps the gather
// point with tbx_texel_clamp (TEXEL_HELPER, library/texel.ts: the one texel
// helper the gathers, the warps and the stage splitter share — it replaced
// `tbx.warp.texel` on 2026-10-14).

// p rotated by the angle whose cosine / sine are (c, s): the
// `vec2(c * p.x - s * p.y, s * p.x + c * p.y)` every GL warp inlines.
registerSkslHelper({
  id: "tbx.warp.rotate",
  source: `float2 tbx_warp_rotate(float2 p, float c, float s) {
  return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}`,
});

// Straight-alpha source-over (MIRROR_FS `over`): s over d, color divided
// back out of the composite alpha, black below 1e-4.
registerSkslHelper({
  id: "tbx.warp.over",
  source: `float4 tbx_warp_over(float4 s, float4 d) {
  float oa = s.a + d.a * (1.0 - s.a);
  float3 oc = oa < 1e-4 ? float3(0.0) : (s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / oa;
  return float4(oc, oa);
}`,
});
