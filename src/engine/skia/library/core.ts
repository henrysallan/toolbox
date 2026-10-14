// Library functions the factory and the fuser need themselves (not tied to
// one node): a constant color, which stands in for an unwired input and for
// a node whose current params have no Skia lowering yet.

import { registerSkslFunction, type SkslLibFunctionDef } from "./registry";

export const TBX_CONST: SkslLibFunctionDef = {
  id: "tbx.const@1",
  entry: "tbx_const",
  source: `float4 tbx_const(float2 uv, float2 res, float4 color) {
  return color;
}`,
  params: [{ name: "color", type: "color" }],
  inputs: [],
  cost: 0,
};

registerSkslFunction(TBX_CONST);
