// The fixture contract behind `npm run compare:skia` (scripts/skia-compare.cjs).
//
// A fixture is a module `scripts/fixtures/skia/<name>-graph.ts` that exports
// `fixture: SkiaGraphFixture`. compare:skia bundles it (esbuild, in the
// browser) and renders any of its nodes through toolbox's real evaluator,
// so the module must stay pure: no `node:` imports, no fs. Text assets
// (SkSL, GLSL) come in through `ctx.text(file)` — every `.sksl` / `.glsl`
// file in scripts/fixtures/skia/ is available by its file name — so the same
// builder can also be called from Node (where `.sksl` can't be imported)
// by passing a reader, as aurora.ts does.
//
// The graph is the evaluator's input: a flat GraphNode / GraphEdge list
// (group shells are fine — evaluateGraph flattens them). Wire a driver into
// BOTH the original node and its port so one fixture proves them against
// each other:
//
//   npm run compare:skia -- --a <name>:<nativeId> --b <name>:<portId>
//
// See scripts/fixtures/skia/aurora-graph.ts for a worked example.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";

export interface SkiaFixtureContext {
  /** Contents of a text asset in scripts/fixtures/skia/ (e.g. "aurora.sksl"). */
  text(file: string): string;
}

export interface SkiaGraphFixture {
  /** One-line description, printed in the report. */
  description?: string;
  /** Timeline the frame numbers are read in (ticks per frame, frames per second). */
  timeline: { fps: number; ticksPerFrame: number };
  /** Frames compared when --frames is not given. Default [0]. */
  frames?: readonly number[];
  /** Canvas size when --size is not given: an edge, or [width, height]. Default 512. */
  size?: number | readonly [number, number];
  build(ctx: SkiaFixtureContext): { nodes: GraphNode[]; edges: GraphEdge[] };
}
