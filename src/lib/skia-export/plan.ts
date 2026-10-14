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
import type { Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";
import { buildSkslProgram, channelUniformValues, lintSksl } from "@/engine/skia/sksl-program";
import { getNodeDef } from "@/engine/registry";
import type { TimelineKey, TimelineTrack } from "./runtime/toolbox-timeline";

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

function hexToTuple(v: unknown): number[] {
  // toRgbaTuple (engine/keyframes.ts) for hex: 6 digits ⇒ alpha 1.
  if (Array.isArray(v)) return [0, 1, 2, 3].map((i) => (typeof v[i] === "number" ? v[i] : i === 3 ? 1 : 0));
  let h = typeof v === "string" ? v.replace("#", "") : "000000";
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6) || "0", 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, Number.isFinite(a) ? a : 1];
}

function toTimelineKey(k: Keyframe, kind: "scalar" | "color"): TimelineKey {
  const key: TimelineKey = {
    tick: k.tick,
    value: kind === "color" ? hexToTuple(k.value) : (k.value as number),
    easing: k.easingOut,
  };
  if (k.easingOut === "cubicBezier" && k.bezier) key.bezier = { ...k.bezier };
  if (k.bezierHandles) {
    key.right = { ...k.bezierHandles.rightHandle };
    key.left = { ...k.bezierHandles.leftHandle };
  }
  return key;
}

function liveBlock(node: GraphNode, param: string): KeyframeAnimationBlock | null {
  const b = node.animation?.[param];
  return b && b.animated && b.keyframes.length > 0 ? b : null;
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
    const drivenInto = edges.filter((x) => x.target === src.id);
    if (src.clips?.length) problems.push(`"${src.id}" (driving ${ch.name}) has a clip window — retimed drivers are not supported yet.`);

    if (src.type === "animated-value" && kind === "scalar") {
      if (drivenInto.length) {
        problems.push(`Animated Value "${src.id}" (driving ${ch.name}) has wired inputs (${drivenInto.map((x) => x.targetHandle).join(", ")}) — only an unwired clock exports.`);
        continue;
      }
      const block = liveBlock(src, "value");
      if (block) {
        uniforms.push({
          name: ch.name,
          kind: "float",
          track: { kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) },
          from: `Animated Value ${src.id} (${block.keyframes.length} keys)`,
        });
      } else {
        const v = typeof src.params.value === "number" ? src.params.value : 0;
        uniforms.push({ name: ch.name, kind: "float", value: v, from: `Animated Value ${src.id} (static)` });
      }
      continue;
    }

    if (src.type === "constant" && kind === "scalar") {
      if (drivenInto.length || liveBlock(src, "value")) {
        problems.push(`Constant "${src.id}" (driving ${ch.name}) is keyframed or wired — Constant snaps to its step every frame; use Animated Value for an exported curve.`);
        continue;
      }
      const out = getNodeDef("constant")?.compute({
        inputs: {},
        auxIn: {},
        params: src.params,
        ctx: undefined as never,
        nodeId: src.id,
      }) as { primary?: { kind: string; value: number } } | undefined;
      const v = out?.primary?.kind === "scalar" ? out.primary.value : 0;
      uniforms.push({ name: ch.name, kind: "float", value: v, from: `Constant ${src.id}` });
      continue;
    }

    if (src.type === "color-literal" && kind === "color") {
      if (drivenInto.some((x) => x.targetHandle === "in:image")) {
        problems.push(`Color "${src.id}" (driving ${ch.name}) extracts a palette from an image — not exportable.`);
        continue;
      }
      if (liveBlock(src, "alpha")) {
        problems.push(`Color "${src.id}" has keyframed alpha — animate the color's own alpha in the shader instead (M0).`);
        continue;
      }
      // Color 1 is the `color` param on the primary output; colors 2..8 are
      // `color<n>` params on matching aux outputs (color-literal.ts).
      const slot = edge.sourceHandle === "out:primary" ? "color" : edge.sourceHandle.replace(/^out:aux:/, "");
      const alpha = typeof src.params.alpha === "number" ? src.params.alpha : 1;
      const block = liveBlock(src, slot);
      if (block) {
        uniforms.push({
          name: ch.name,
          kind: "color",
          track: {
            kind: "color",
            colorSpace: block.colorSpace ?? "oklab",
            quantize8: true,
            alpha,
            keys: block.keyframes.map((k) => toTimelineKey(k, "color")),
          },
          from: `Color ${src.id}.${slot} (${block.keyframes.length} keys, ${block.colorSpace ?? "oklab"})`,
        });
      } else {
        const rgb = hexToTuple(src.params[slot]);
        uniforms.push({ name: ch.name, kind: "color", value: [rgb[0], rgb[1], rgb[2], alpha], from: `Color ${src.id}.${slot} (static)` });
      }
      continue;
    }

    problems.push(
      `Channel "${ch.name}" (${kind}) is driven by a ${src.type} node — only Animated Value (scalar), Constant (scalar) and Color (color) drive an exported Skia uniform in M0.`
    );
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
