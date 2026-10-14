// The SkSL library contract — how `skia-*` shader nodes describe themselves
// so the fuser can compile a whole Skia-layer region into ONE runtime
// effect, deterministically (specdocs/101326_skia-target.md §3.3).
//
// FROZEN 2026-10-13 for the Wave 1/2 lanes (family ports build against it).
// Additive changes only without the owner's sign-off.
//
// A shader node's compute returns a SkiaShaderValue whose `expr` is a call
// tree; nothing is compiled until a consumer needs pixels (Skia Fill, a
// paint, the node's own preview), which hands the tree to the fuser.
//
// Fused program shape (what fuse.ts emits — library authors rely on it):
//
//   uniform float3 iResolution;            // xy = canvas size
//   uniform float iTime;
//   uniform shader s0; …                   // one per distinct `leaf` / `program` expr
//   uniform <type> n<node>_<param>; …      // one per call param
//   <shared helpers, deduped by id, dependencies first>
//   float4 c<k>(float2 uv) { … }           // child wrapper: uv → px, un-premultiply,
//                                          // working space → sRGB
//   float4 g<k>(float2 uv);                // prototypes, one per GATHER input edge
//   <each library function once, by entry name; a function whose gather
//    edges differ between uses is copied with every <entry>-prefixed
//    identifier renamed <entry>_G<j>>
//   float4 g<k>(float2 uv) { … }           // gather bodies
//   half4 main(float2 fc) {
//     float2 uv = float2(fc.x / iResolution.x, 1.0 - fc.y / iResolution.y);
//     float4 c = <root call>;
//     return tbx_cm_out(c);                // sRGB → working space, premultiply ONCE
//   }
//
// Color management (2026-10-14, library/color-management.ts): everything
// between main's result and the child samples is gamma-encoded sRGB on any
// destination (sRGB, Display P3, unmanaged); `color` params are plain
// float4 uniforms holding sRGB numbers, never layout(color).
//
// Conventions inside library functions (so ports stay line-for-line with the
// engine's GL nodes and comparable with compare:skia):
//   - `uv` is toolbox v_uv: 0..1, Y-UP. `res` is iResolution.xy (px).
//   - Return STRAIGHT alpha, like every engine shader.
//   - Pure inputs arrive as float4 arguments (already evaluated at uv).
//   - Gather inputs are read with `$<input>(uv2)` — the fuser rewrites the
//     token to the generated g<k> function for that edge.
//   - Children (leaves) are sampled via the generated wrappers, which
//     convert uv → Skia px, un-premultiply and convert to sRGB.
//   - Never call toLinearSrgb / fromLinearSrgb: the boundaries convert.
//   - Skia's strict-ES2 rules hold (no uint / bitwise / while / dynamic
//     index / derivatives); `float` everywhere. check:skia-library compiles
//     every function through CanvasKit.

import type { Bind, ShaderIR, SkslProgramIR } from "./scene-ir";

export type SkslParamType = "float" | "float2" | "float3" | "float4" | "int" | "color";

export interface SkslLibFunction {
  // Stable id, versioned by suffix when behavior changes: "tbx.noise.simplex@1".
  id: string;
  // SkSL entry name, unique across the library: tbx_noise_simplex.
  entry: string;
  // The entry plus private helpers (prefixed with the entry name).
  // Signature: float4 <entry>(float2 uv, float2 res, <params…>, <pure inputs…>)
  source: string;
  // `count` makes the param a uniform ARRAY (read only by a loop index);
  // added 2026-10-13 by lane L2, additive.
  params: { name: string; type: SkslParamType; count?: number }[];
  inputs: { name: string; mode: "pure" | "gather"; taps?: number | "param" }[];
  // Shared helper ids (see SkslHelper) the source calls.
  uses?: string[];
  // Relative ALU cost of one evaluation (one simplex octave ≈ 1). The planner
  // multiplies by gather fan-out for the per-pixel budget.
  cost?: number;
  // Reads iTime directly (fingerprints / export).
  usesTime?: boolean;
}

// Shared helpers (hashes, OKLab, simplex2d, unpremul…): emitted once per
// program, in dependency order.
export interface SkslHelper {
  id: string;
  source: string;
  uses?: string[];
}

export type ShaderExpr =
  // A library call. `node` namespaces its uniforms (n<node>_<param>).
  | {
      k: "call";
      fn: string;
      node: string;
      params: Record<string, Bind<number | number[]>>;
      inputs: Record<string, ShaderExpr>;
    }
  // A non-SkSL shader (gradient, image, solid color) sampled as a child.
  | { k: "leaf"; shader: ShaderIR }
  // A hand-written SkSL Shader node's complete program, sampled as a child.
  | { k: "program"; program: SkslProgramIR; node: string };
