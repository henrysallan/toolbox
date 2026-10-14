// planSkiaExport — what a SkSL Shader node needs to run in React Native
// Skia: the compiled program, one binding per uniform, and the timeline
// that drives the animated ones (specdocs/101326_skia-target.md §Export).
//
// M0 scope, enforced here rather than discovered on device: a channel is
// either static (its own row value) or wired from a keyframe SOURCE whose
// curve the runtime can replay exactly — Animated Value (unwired clock) for
// scalars, the Color node for colors, Constant for a fixed number. Any other
// driver, any wired image (iImage1..4), ramp/curve channels, clips and
// retimed clocks are reported as problems: the export refuses instead of
// shipping something that will not match the editor.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ExprInput } from "@/engine/types";
import { channelKind, readChannelValue } from "@/engine/expr-channels";
import { buildSkslProgram, channelUniformValues, lintSksl } from "@/engine/skia/sksl-program";
import { resolveDriver } from "./drivers";
import type { TimelineTrack } from "./runtime/toolbox-timeline";

export interface SkiaUniformBinding {
  name: string;
  kind: "float" | "int" | "color";
  // Exactly one of the two.
  value?: number | number[];
  track?: TimelineTrack;
  // Human-readable provenance for the manifest / README.
  from: string;
}

export interface SkiaExportPlan {
  name: string;
  sksl: string;
  preludeLines: number;
  usesTime: boolean;
  canvas: { width: number; height: number };
  timeline: { fps: number; ticksPerFrame: number; durationTicks: number };
  uniforms: SkiaUniformBinding[];
  warnings: string[];
}

export interface SkiaExportOptions {
  name: string;
  canvas: { width: number; height: number };
  timeline: { fps: number; ticksPerFrame: number; sceneDurationTicks: number };
}

export function planSkiaExport(
  nodes: GraphNode[],
  edges: GraphEdge[],
  targetId: string,
  opts: SkiaExportOptions
): { plan: SkiaExportPlan | null; problems: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const target = byId.get(targetId);
  if (!target) return { plan: null, problems: [`No node "${targetId}" in the graph.`] };
  if (target.type !== "sksl-shader") {
    return { plan: null, problems: [`"${targetId}" is a ${target.type} — only SkSL Shader nodes export to React Native Skia.`] };
  }

  const prog = buildSkslProgram(target.params);
  const source = typeof target.params.expression === "string" ? target.params.expression : "";
  const lint = lintSksl(source);
  problems.push(...lint.problems);
  warnings.push(...lint.warnings);
  for (const n of prog.unsupported) {
    problems.push(`Channel "${n}" is a ramp/curve — no SkSL lowering yet (spec M2).`);
  }
  if (target.clips?.length) problems.push("The SkSL node sits on a clip window / time remap — retimed exports are not supported yet.");

  const incoming = edges.filter((e) => e.target === targetId);
  for (const e of incoming) {
    if (/^in:image[1-4]$/.test(e.targetHandle)) {
      problems.push(`${e.targetHandle.slice(3)} is wired — image inputs (iImage1..4) don't export yet (spec M2).`);
    }
  }

  const edgeFor = (ch: ExprInput) =>
    incoming.find((e) => e.targetHandle === `in:in:${ch.id}` || e.targetHandle === `in:${ch.id}`);

  const uniforms: SkiaUniformBinding[] = [];
  for (const ch of prog.channels) {
    const kind = channelKind(ch);
    const ukind: SkiaUniformBinding["kind"] = kind === "color" ? "color" : kind === "scalar" ? "float" : "int";
    const edge = edgeFor(ch);
    if (!edge) {
      const v = channelUniformValues([ch], { [ch.name]: readChannelValue(ch, undefined) })[ch.name];
      uniforms.push({ name: ch.name, kind: ukind, value: v as number | number[], from: "static (channel row)" });
      continue;
    }
    const src = byId.get(edge.source);
    if (!src) {
      problems.push(`Channel "${ch.name}" is wired from a missing node "${edge.source}".`);
      continue;
    }
    const r = resolveDriver(src, edge, edges, kind, ch.name);
    problems.push(...r.problems);
    if (r.binding) uniforms.push({ name: ch.name, kind: ukind, ...r.binding });
  }

  if (problems.length) return { plan: null, problems };
  return {
    plan: {
      name: opts.name,
      sksl: prog.sksl,
      preludeLines: prog.preludeLines,
      usesTime: /\biTime\b/.test(source),
      canvas: { ...opts.canvas },
      timeline: {
        fps: opts.timeline.fps,
        ticksPerFrame: opts.timeline.ticksPerFrame,
        durationTicks: opts.timeline.sceneDurationTicks,
      },
      uniforms,
      warnings,
    },
    problems: [],
  };
}
