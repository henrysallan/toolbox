// The texel rule every Skia sampler of an upstream shares
// (specdocs/101326_skia-target.md §2c, §3.3): one helper for the gather
// family (displace, chromatic aberration, sharpen, edge detect, bevel &
// emboss, vector field, flow blur, kuwahara), the warp family (transform,
// mirror, polar coords, pixelate, array) and the stage splitter
// (engine/skia/split.ts). Until 2026-10-14 the first two carried identical
// copies (`tbx.gather.edge` / `tbx_gather_edge_uv` and `tbx.warp.texel` /
// `tbx_warp_texel`); this is the one that replaced both.
//
// The engine's GL nodes sample a TEXTURE of their upstream: canvas-sized,
// LINEAR, CLAMP_TO_EDGE (engine/gl.ts allocImage). A sample point past the
// outermost texel CENTRES reads the edge texel. A Skia port re-evaluates its
// upstream as a FUNCTION instead, which is defined everywhere, so it must
// not evaluate it out there (that would extrapolate the upstream — a
// pixelate cell centred beyond the top edge, a sharpen tap one pixel past
// the frame). tbx_texel_clamp clamps the sample point to
// [0.5, res − 0.5] px first; inside that box only the GL node's bilinear
// filter remains as a difference: taps ON the pixel grid (sharpen, edge
// detect, kuwahara) land on texel centres, where re-evaluating equals
// sampling the texture; off-grid taps see the exact function where the GL
// node sees a bilinear blend of texels.
//
// When the splitter renders an upstream into a layer (split.ts), the same
// clamped point is where the layer is read: a texel centre for an on-grid
// tap (exactly the texel the fused program would have re-evaluated), or the
// four texel centres around an off-grid one (tbx.split.bilinear@1) — the GL
// texture's own rule. `res` is the canvas (iResolution.xy) in a Skia layer,
// which is the upstream's size.
//
// Naming: no library entry may be `tbx_texel` (a gather copy renames every
// identifier that starts with its function's entry, fuse.ts).

import { registerSkslHelper } from "./registry";

export const TEXEL_HELPER = "tbx.texel";

registerSkslHelper({
  id: TEXEL_HELPER,
  source: `float2 tbx_texel_clamp(float2 uv, float2 res) {
  float2 h = 0.5 / res;
  return clamp(uv, h, 1.0 - h);
}`,
});
