// planSkiaExport — what a SkSL Shader node needs to run in React Native
// Skia: the compiled program, one binding per uniform, and the timeline
// that drives the animated ones (specdocs/101326_skia-target.md §Export).
//
// M0 scope, enforced here rather than discovered on device: a channel is
// static (its own row value), keyframed ON THE NODE (its own `ch:<name>`
// track — engine/channel-keyframes.ts), or wired from a keyframe SOURCE
// whose curve the runtime can replay exactly — Animated Value (unwired
// clock) for scalars, the Color node for colors, Constant for a fixed
// number — or, for a scalar channel, a procedural driver (Expression, LFO,
// Math, Scene Time, Random, a keyframed / wired Constant, an Animated Value
// on a wired clock) that procedural/ compiles to a program of the tick
// (spec §3.5e, Wave 3 lane P). Any other driver, clips and retimed clocks
// are reported as problems: the export refuses instead of shipping
// something that will not match the editor.
//
// Children (Wave 3 lane I, §3.8 items 2–3), in the program's `uniform
// shader` order:
//   iImage1..4   a STATIC image — an Image Source, or Image (Skia)'s
//                preview, with nothing keyframed or wired — ships as a
//                bundled asset (useImage) mapped by an ImageShader exactly
//                as Image Source fits it on the canvas; anything else wired
//                (an animated image, a video, any other node) refuses with
//                the reason, an unwired one is a transparent child;
//   ramp / curve the channel's 256×1 LUT (skslLutBytes), the bytes the
//                preview samples, as an ImageShader child.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ExprInput, SkiaImageSource } from "@/engine/types";
import { channelKind, readChannelValue } from "@/engine/expr-channels";
import { channelKeyframeType, channelStoredValue } from "@/engine/channel-keyframes";
import { channelKey } from "@/engine/conventions";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import type { AssetIR } from "@/engine/skia/scene-ir";
import { buildSkslProgram, channelUniformValues, lintSksl, skslLutBytes } from "@/engine/skia/sksl-program";
import type { SkiaExportAssets } from "./api";
import { assetWarnings, type AssetUse } from "./asset-bundle";
import { liveBlock, resolveDriver, toTimelineKey } from "./drivers";
import { IMAGE_SOURCE_PARAMS, imageFitParam, skiaImageSourceOf } from "./image-asset";
import { compileDriver, PROCEDURAL_DRIVER_TYPES } from "./procedural/compile";
import type { ProcProgram } from "./procedural/ir";
import type { TimelineTrack } from "./runtime/toolbox-timeline";

// One child shader of the exported program.
export type SkiaEffectChild =
  | {
      name: string;
      kind: "image";
      asset: AssetIR;
      // The file and Image Source's mapping onto the canvas (fit, then its
      // TRS; tile = what lies outside the image) — what the preview samples.
      source: SkiaImageSource;
      from: string;
    }
  | { name: string; kind: "lut"; lut: { channel: string; kind: "ramp" | "curve"; rgba: number[] }; from: string }
  // Sampled but unwired / no file: transparent, as the preview reads it.
  | { name: string; kind: "empty"; from: string };

export interface SkiaUniformBinding {
  name: string;
  kind: "float" | "int" | "color";
  // Exactly one of the three.
  value?: number | number[];
  track?: TimelineTrack;
  // A procedural driver compiled to a program of the tick (procedural/,
  // spec §3.5e): a worklet in worklet / native bundles, SkSL when baked.
  // Additive (2026-10-14, Wave 3 lane P).
  expr?: ProcProgram;
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
  // Child shaders in declaration order (additive, Wave 3 lane I; absent on
  // a program that samples nothing).
  children?: SkiaEffectChild[];
  // The image children's assets with the nodes they come from, and the
  // resolved bytes the emitter bundles (SkiaExportRequest.assets).
  assetUses?: AssetUse[];
  assetBytes?: SkiaExportAssets;
  warnings: string[];
}

export interface SkiaExportOptions {
  name: string;
  canvas: { width: number; height: number };
  timeline: { fps: number; ticksPerFrame: number; sceneDurationTicks: number };
  // SkiaExportRequest.assets (additive, Wave 3 lane I).
  assets?: SkiaExportAssets;
}

// A wired iImageN as a static image child, or why it can't ship.
function staticImageChild(
  name: string,
  src: GraphNode,
  edge: GraphEdge,
  edges: GraphEdge[]
): { child: SkiaEffectChild; warning?: string } | { problem: string } {
  const at = `${name} is wired from ${src.type} "${src.id}"`;
  const okSource =
    (src.type === "image-source" && edge.sourceHandle === "out:primary") ||
    (src.type === "skia-image" && edge.sourceHandle === "out:aux:preview");
  if (!okSource) {
    return {
      problem: `${at}${edge.sourceHandle !== "out:primary" ? ` (${edge.sourceHandle.replace(/^out:/, "")})` : ""} — only a static image exports (an Image Source, or Image (Skia)'s preview); an animated, video or computed input needs baking, which this exporter doesn't do yet.`,
    };
  }
  if (src.bypassed) return { problem: `${at}, which is bypassed — un-bypass it or unwire ${name}.` };
  if (src.clips?.length) return { problem: `${at}, which sits on a clip window — only an always-on image exports.` };
  const keyed = IMAGE_SOURCE_PARAMS.filter((p) => liveBlock(src, p));
  if (keyed.length) return { problem: `${at}, whose ${keyed.join(", ")} ${keyed.length > 1 ? "are" : "is"} keyframed — the image animates; only a static image exports.` };
  const wired = edges.filter((e) => e.target === src.id).map((e) => e.targetHandle.replace(/^in:(param:)?/, ""));
  if (wired.length) return { problem: `${at}, whose ${wired.join(", ")} ${wired.length > 1 ? "are" : "is"} wired — only a static image exports.` };
  const opacity = typeof src.params.opacity === "number" ? src.params.opacity : 1;
  if (opacity < 1) return { problem: `${at}, which fades it to opacity ${opacity} — set its Opacity to 1 and fade in the shader instead (an ImageShader has no opacity).` };
  const r = skiaImageSourceOf(name, src.params);
  if ("problem" in r) return { problem: `${at}: ${r.problem}.` };
  if ("empty" in r) {
    return {
      child: { name, kind: "empty", from: `${src.type} "${src.id}" (no file loaded)` },
      warning: `${at}, which has no file loaded — the export passes a transparent child, as the preview reads it.`,
    };
  }
  const s = r.source;
  const moved = s.translateX !== 0 || s.translateY !== 0 || s.scaleX !== 1 || s.scaleY !== 1 || s.rotate !== 0;
  return {
    child: {
      name,
      kind: "image",
      asset: s.asset,
      source: s,
      from: `${src.type} "${src.id}" (${s.asset.width}×${s.asset.height}, fit ${imageFitParam(src.params.fit)}${moved ? ", transformed" : ""})`,
    },
  };
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
    problems.push(`Channel "${n}" has no SkSL lowering.`);
  }
  if (target.clips?.length) problems.push("The SkSL node sits on a clip window / time remap — retimed exports are not supported yet.");

  const incoming = edges.filter((e) => e.target === targetId);
  const edgeFor = (ch: ExprInput) =>
    incoming.find((e) => e.targetHandle === `in:in:${ch.id}` || e.targetHandle === `in:${ch.id}`);

  // ---- children: iImage1..4 the source samples, then the LUT channels
  const children: SkiaEffectChild[] = [];
  const assetUses: AssetUse[] = [];
  for (const name of prog.children) {
    const edge = incoming.find((e) => e.targetHandle === `in:image${name.slice("iImage".length)}`);
    if (!edge) {
      children.push({ name, kind: "empty", from: "unwired" });
      warnings.push(`The source samples ${name} but nothing is wired into it — the export passes a transparent child, as the preview reads it.`);
      continue;
    }
    const src = byId.get(edge.source);
    if (!src) {
      problems.push(`${name} is wired from a missing node "${edge.source}".`);
      continue;
    }
    const r = staticImageChild(name, src, edge, edges);
    if ("problem" in r) {
      problems.push(r.problem);
      continue;
    }
    children.push(r.child);
    if (r.warning) warnings.push(r.warning);
    if (r.child.kind === "image") assetUses.push({ asset: r.child.asset, owners: [`${src.type} "${src.id}"`] });
  }
  for (const e of incoming) {
    const m = /^in:image([1-4])$/.exec(e.targetHandle);
    if (m && !prog.children.includes(`iImage${m[1]}`)) {
      warnings.push(`image${m[1]} is wired but the source never samples iImage${m[1]} — nothing ships for it.`);
    }
  }
  for (const l of prog.luts) {
    const ch = prog.channels.find((c) => c.name === l.name);
    if (!ch) continue;
    if (edgeFor(ch)) {
      problems.push(`The ${l.kind} channel "${l.name}" is wired — a wired ${l.kind} doesn't export yet (its lookup table would change per frame); set it on the node.`);
      continue;
    }
    if (liveBlock(target, channelKey(l.name))) {
      problems.push(`The ${l.kind} channel "${l.name}" is keyframed — an animated lookup table doesn't export yet.`);
      continue;
    }
    const rgba = Array.from(skslLutBytes(l.kind, readChannelValue(ch, undefined)));
    children.push({ name: l.child, kind: "lut", lut: { channel: l.name, kind: l.kind, rgba }, from: `${l.kind} channel "${l.name}" (256×1 lookup table)` });
  }
  warnings.push(...assetWarnings(assetUses, opts.assets));

  const uniforms: SkiaUniformBinding[] = [];
  for (const ch of prog.channels) {
    const kind = channelKind(ch);
    // Ramp / curve channels are child shaders (above), not uniforms.
    if (kind === "ramp" || kind === "curve") continue;
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
    if (!r.binding && kind === "scalar" && PROCEDURAL_DRIVER_TYPES.has(src.type)) {
      // Expression / LFO / Math / Scene Time / Random, a keyframed or wired
      // Constant, an Animated Value on a wired clock: compiled to a program
      // of the tick (procedural/, spec §3.5e) instead of refused.
      const c = compileDriver(edge, byId, edges, opts.timeline);
      if (c.ok) {
        warnings.push(...c.warnings);
        uniforms.push({ name: ch.name, kind: ukind, expr: c.program, from: c.from });
      } else problems.push(`Channel "${ch.name}" is driven by ${src.type} "${src.id}", which doesn't compile for export: ${c.reason}.`);
      continue;
    }
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
      ...(children.length ? { children } : {}),
      ...(assetUses.length ? { assetUses } : {}),
      ...(opts.assets ? { assetBytes: opts.assets } : {}),
      warnings,
    },
    problems: [],
  };
}
