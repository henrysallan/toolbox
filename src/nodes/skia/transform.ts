import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { bindDegrees } from "@/engine/skia/library/helpers-warp";
import { transformNode } from "../effect/transform";

// Transform (Skia) — the Skia-layer port of Transform's IMAGE path
// (specdocs/101326_skia-target.md §3.2, Wave 2 warps). TRANSFORM_FS line for
// line as a gather: the output uv is inverse-mapped (translate, pivot,
// rotate, scale; the pivot and translate are per-axis canvas fractions,
// Y-down, as the gizmo places them) and the upstream is re-evaluated there.
// Images have no bounds, so the pivot is always Canvas space
// (engine/transform-pivot.ts: `space` only moves spline / points pivots).
// Outside [0,1]² the result is transparent; Tile widens that box by the
// per-side extents and wraps (repeat) or mirrors odd cells (Unfold).
//
// rotate stays degrees in the panel and is bound in radians (ref scale
// π/180, like Skia Group), the value TRANSFORM_FS's u_angle receives.
//
// Not ported: the `transform` input (a wired Gizmo's op list replaces own
// TRS through TRANSFORM_MATRIX_FS) and the `transform` aux; spline / points
// inputs, whose Skia lowering is Skia Group's native transform.

const TRANSFORM_SKSL = `float4 tbx_transform(float2 uv, float2 res, float translateX, float translateY,
                    float scaleX, float scaleY, float rotate, float pivotX, float pivotY,
                    int tile, float tileLeft, float tileRight, float tileUp, float tileDown,
                    int tileUnfold) {
  // Screen → UV y-flip for pivot and translate.
  float2 pivot = float2(pivotX, 1.0 - pivotY);
  float2 translate = float2(translateX, -translateY);
  // Inverse of translate · pivot-back · rotate · scale · -pivot. A positive
  // angle reads clockwise on screen; v_uv is Y-up, so it is not negated.
  float2 p = (uv - translate) - pivot;
  p = tbx_warp_rotate(p, cos(rotate), sin(rotate));
  p /= max(float2(scaleX, scaleY), float2(0.0001));
  float2 q = p + pivot;
  float2 lo = float2(0.0);
  float2 hi = float2(1.0);
  if (tile != 0) {
    // u_tileExpand = (left, right, down, up), clamped >= 0 like the JS.
    lo = float2(-max(tileLeft, 0.0), -max(tileDown, 0.0));
    hi = float2(1.0 + max(tileRight, 0.0), 1.0 + max(tileUp, 0.0));
  }
  if (tbx_warp_outside(q, lo, hi)) return float4(0.0);
  if (tile != 0) {
    if (tileUnfold != 0) {
      // Mirror odd cells; cell 0 (the original) stays unflipped.
      float2 t = mod(q, 2.0);
      q = mix(t, 2.0 - t, step(1.0, t));
    } else {
      q = fract(q);
    }
  }
  return $image(tbx_warp_texel(q, res));
}`;

export const skiaTransformNode = defineSkslNode({
  type: "skia-transform",
  name: "Transform (Skia)",
  mirrors: "transform",
  category: "utility",
  description:
    "Skia-layer Transform: scales, rotates and translates the upstream shader around a pivot by inverse sampling, fused into the layer's one runtime shader. Same params as Transform's image path, including Tile (repeat or Unfold) past each edge. The `preview` output renders it through CanvasKit.",
  searchAliases: ["transform", "move", "rotate", "scale", "tile", "repetile", "skia", "sksl"],
  facts: {
    space: {
      "in:image": "raster",
      "param:translateX": "uv01",
      "param:translateY": "uv01",
      "param:pivotX": "uv01",
      "param:pivotY": "uv01",
    },
    gotchas: [
      "Image path only: no `transform` socket (a wired Gizmo) and no transform aux; spline / points belong on Skia Group / Skia Shape.",
      "translate and pivot are per-axis canvas fractions, Y-down (pivot 0,0 = top-left); the pivot is always Canvas space for shaders.",
      "rotate is degrees (clockwise on screen) bound to the shader in radians; like Transform's image path it rotates in per-axis uv space, so it shears on non-square canvases.",
      "Outside the [0,1] box the result is transparent; tile widens it by tileLeft/Right/Up/Down source-widths and wraps, tileUnfold mirrors odd copies.",
      "Re-evaluates the upstream once per pixel at the mapped point, clamped to the outer pixel centers like a texture edge, with no bilinear filter.",
    ],
  },
  fn: {
    id: "tbx.transform@1",
    entry: "tbx_transform",
    source: TRANSFORM_SKSL,
    params: [
      { name: "translateX", type: "float" },
      { name: "translateY", type: "float" },
      { name: "scaleX", type: "float" },
      { name: "scaleY", type: "float" },
      { name: "rotate", type: "float" },
      { name: "pivotX", type: "float" },
      { name: "pivotY", type: "float" },
      { name: "tile", type: "int" },
      { name: "tileLeft", type: "float" },
      { name: "tileRight", type: "float" },
      { name: "tileUp", type: "float" },
      { name: "tileDown", type: "float" },
      { name: "tileUnfold", type: "int" },
    ],
    inputs: [{ name: "image", mode: "gather", taps: 1 }],
    uses: ["tbx.warp.rotate", "tbx.warp.outside", "tbx.warp.texel"],
    cost: 0.1,
  },
  params: mirrorParams(transformNode, [
    "translateX",
    "translateY",
    "scaleX",
    "scaleY",
    "rotate",
    "pivotX",
    "pivotY",
    "tile",
    "tileLeft",
    "tileRight",
    "tileUp",
    "tileDown",
    "tileUnfold",
  ]),
  inputs: [{ name: "image", label: "Image" }],
  binds: ({ params, nodeId }) => ({ rotate: bindDegrees(params, nodeId, "rotate") }),
});
