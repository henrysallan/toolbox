// Fuser — compiles a ShaderExpr call tree into ONE runtime effect
// (specdocs/101326_skia-target.md §3.3; the emitted program's shape is
// documented at the top of shader-expr.ts).
//
// CONTRACT STUB, 2026-10-13: the signature below is frozen and lane L2
// replaces the body. Until then `leaf` and `program` expressions pass
// through and `call` expressions report a problem, so consumers (Skia Fill,
// shader previews, the scene renderer) can integrate now.

import type { Bind, ShaderIR } from "./scene-ir";
import type { ShaderExpr } from "./shader-expr";

export interface FuseOptions {
  // Canvas px — becomes iResolution's value.
  resolution: [number, number];
  // Seconds — iTime's value. Its bind carries no ref: the exporter drives
  // iTime from the master clock.
  time: number;
}

export type FuseResult =
  | { shader: ShaderIR; problems: [] }
  | { shader: null; problems: string[] };

export function fuseShader(expr: ShaderExpr, opts: FuseOptions): FuseResult {
  void opts;
  switch (expr.k) {
    case "leaf":
      return { shader: expr.shader, problems: [] };
    case "program":
      return { shader: { k: "runtime", program: expr.program }, problems: [] };
    case "call":
      return {
        shader: null,
        problems: [`Fusing library calls (${expr.fn}) lands with lane L2 — fuse.ts is still the contract stub.`],
      };
  }
}

// The builtin binds every fused program declares.
export function builtinUniforms(opts: FuseOptions): Record<string, Bind<number | number[]>> {
  return {
    iResolution: { v: [opts.resolution[0], opts.resolution[1], 1] },
    iTime: { v: opts.time },
  };
}
