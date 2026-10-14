// Procedural drivers for the React Native Skia export
// (specdocs/101326_skia-target.md §3.5e): Expression / LFO / Math / Scene
// Time / Random / Constant / Animated Value subgraphs compiled to worklets
// of the tick (emit-js.ts) and to SkSL for baked programs (emit-sksl.ts).
export { parseExpressionSource, variableNameProblem, type ExprAst, type ParseResult } from "./parse";
export { evaluateProgram, fnImpl, programUses, type PExpr, type PStmt, type ProcProgram, type ProcCurve } from "./ir";
export { compileDriver, PROCEDURAL_DRIVER_TYPES, EXPRESSION_ENV_KEYS, type CompileResult, type DriverTarget, type ProceduralTimeline } from "./compile";
export { emitProceduralModule, proceduralFnName, type ProceduralValue } from "./emit-js";
export { bakeProcedural } from "./emit-sksl";

import { programUses, type ProcProgram } from "./ir";

// The manifest's note on a procedural value: the nodes it was compiled
// from, how many keyframe tracks it reads, and whether it draws seeded
// randoms (Random / random() — worklet-only: no baked form).
export function proceduralManifest(p: ProcProgram): { nodes: string[]; tracks: number; random: boolean } {
  const u = programUses(p);
  return {
    nodes: p.nodes.map((n) => `${n.type} ${n.id}`),
    tracks: p.tracks.length,
    random: u.random || u.fns.has("hash01"),
  };
}

// A stable key for "the same value" (bundles share one function per key).
export function programKey(p: ProcProgram): string {
  return JSON.stringify([p.body, p.out, p.tracks, p.curves]);
}
