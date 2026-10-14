// planSkiaExport — what a SkSL Shader node needs to run in React Native
// Skia: the compiled program, one binding per uniform, and the timeline
// that drives the animated ones (specdocs/101326_skia-target.md §Export).
//
// M0 scope, enforced here rather than discovered on device: a channel is
// static (its own row value), keyframed ON THE NODE (its own `ch:<name>`
// track — engine/channel-keyframes.ts), or wired from a keyframe SOURCE
// whose curve the runtime can replay exactly — Animated Value (unwired
// clock) for scalars, the Color node for colors, Constant for a fixed
// number. Any other driver, any wired image (iImage1..4), ramp/curve
// channels, clips and retimed clocks are reported as problems: the export
// refuses instead of shipping something that will not match the editor.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ExprInput } from "@/engine/types";
import { channelKind, readChannelValue } from "@/engine/expr-channels";
import { channelKeyframeType, channelStoredValue } from "@/engine/channel-keyframes";
import { channelKey } from "@/engine/conventions";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import { buildSkslProgram, channelUniformValues, lintSksl } from "@/engine/skia/sksl-program";
import { liveBlock, resolveDriver, toTimelineKey } from "./drivers";
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

// What the uniform receives for one keyframe value of a channel's own track:
// the evaluator's path exactly — the value lands in the row's stored form
// (channelStoredValue; a junk value keeps the row's), then the node reads
// the row (readChannelValue) and packs it (channelUniformValues).
function channelUniformOf(ch: ExprInput, v: unknown): number | number[] {
  const row = { ...ch, default: channelStoredValue(ch, v) ?? ch.default };
  return channelUniformValues([row], { [ch.name]: readChannelValue(row, undefined) })[ch.name] as
    | number
    | number[];
}

// A channel's own `ch:<name>` track as a timeline track, matching what the
// evaluator delivers (engine/channel-keyframes.ts):
//   scalar  the keys verbatim — the row takes the interpolated number;
//   color   interpolated in the block's space, then through the row's hex:
//           8 bits per channel, ALPHA INCLUDED (quantizeAlpha) — the row is
//           a straight-alpha color, unlike a Color node, whose alpha is a
//           separate param;
//   toggle / pick   step: hold keys carrying the int the uniform receives.
// Null + a problem when a key can't be replayed exactly.
function channelTrack(
  ch: ExprInput,
  block: KeyframeAnimationBlock,
  problems: string[]
): TimelineTrack | null {
  const type = channelKeyframeType(ch);
  if (type === "scalar") {
    if (block.keyframes.some((k) => typeof k.value !== "number" || !Number.isFinite(k.value))) {
      problems.push(`Channel "${ch.name}" has a keyframe that isn't a finite number.`);
      return null;
    }
    return { kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) };
  }
  if (type === "color") {
    const colorKey = (v: unknown) =>
      Array.isArray(v)
        ? v.length >= 3 && v.length <= 4 && v.every((x) => typeof x === "number" && Number.isFinite(x))
        : channelStoredValue(ch, v) !== undefined;
    if (!block.keyframes.every((k) => colorKey(k.value))) {
      problems.push(`Channel "${ch.name}" has a keyframe that isn't a "#hex" color or an RGBA tuple.`);
      return null;
    }
    return {
      kind: "color",
      colorSpace: block.colorSpace ?? "oklab",
      quantize8: true,
      quantizeAlpha: true,
      keys: block.keyframes.map((k) => toTimelineKey(k, "color")),
    };
  }
  if (type === "boolean" || type === "enum") {
    return {
      kind: "scalar",
      keys: block.keyframes.map((k) => ({
        tick: k.tick,
        value: channelUniformOf(ch, k.value) as number,
        easing: "hold",
      })),
    };
  }
  return null;
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
    const own = liveBlock(target, channelKey(ch.name));
    if (!edge) {
      if (own) {
        const track = channelTrack(ch, own, problems);
        if (track) {
          uniforms.push({
            name: ch.name,
            kind: ukind,
            track,
            from: `channel keyframes (${own.keyframes.length} keys${track.kind === "color" ? `, ${track.colorSpace}` : ""})`,
          });
        }
        continue;
      }
      const v = channelUniformValues([ch], { [ch.name]: readChannelValue(ch, undefined) })[ch.name];
      uniforms.push({ name: ch.name, kind: ukind, value: v as number | number[], from: "static (channel row)" });
      continue;
    }
    if (own) {
      warnings.push(`Channel "${ch.name}" is wired — its own keyframes are ignored (wire > keyframes), in the editor and in this export.`);
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
