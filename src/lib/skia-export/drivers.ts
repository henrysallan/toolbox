// Driver resolution shared by both React Native Skia planners
// (specdocs/101326_skia-target.md §2.3, §3.4): planSkiaExport (one SkSL
// Shader node's channels, M0) and planSceneExport (every Bind in a Skia
// scene). Both answer the same question — "this value is wired from node X;
// can the runtime replay X's curve exactly?" — so the answer, its
// provenance strings and its refusal messages live here once.
//
// Exportable keyframe SOURCES: Animated Value (scalar, unwired clock),
// Constant (static only — it snaps to its step), Color (8-bit hex round
// trip, OKLab/RGB). Anything else is a refusal with a reason.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { channelKind, readChannelValue } from "@/engine/expr-channels";
import type { Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { channelUniformValues } from "@/engine/skia/sksl-program";
import type { ExprInput } from "@/engine/types";
import type { TimelineKey, TimelineTrack } from "./runtime/toolbox-timeline";

export function hexToTuple(v: unknown): number[] {
  // toRgbaTuple (engine/keyframes.ts) for hex: 6 digits ⇒ alpha 1.
  if (Array.isArray(v)) return [0, 1, 2, 3].map((i) => (typeof v[i] === "number" ? v[i] : i === 3 ? 1 : 0));
  let h = typeof v === "string" ? v.replace("#", "") : "000000";
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6) || "0", 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, Number.isFinite(a) ? a : 1];
}

export function toTimelineKey(k: Keyframe, kind: "scalar" | "color"): TimelineKey {
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

export function liveBlock(node: GraphNode, param: string): KeyframeAnimationBlock | null {
  const b = node.animation?.[param];
  return b && b.animated && b.keyframes.length > 0 ? b : null;
}

// A channel's own `ch:<name>` keyframes as a track, matching what the
// evaluator delivers (lane L4, engine/channel-keyframes.ts; the same
// semantics as plan.ts's channelTrack on skia-wave1):
//   scalar   the keys verbatim;
//   color    interpolated in the block's space, then through the row's hex:
//            8 bits per channel, alpha included (quantizeAlpha);
//   toggle / pick   step keys carrying the int the uniform receives.
// Null + a problem when a key can't be replayed exactly.
export function channelKeyTrack(
  row: ExprInput,
  block: KeyframeAnimationBlock,
  problems: string[]
): TimelineTrack | null {
  const kind = channelKind(row);
  if (kind === "scalar") {
    if (block.keyframes.some((k) => typeof k.value !== "number" || !Number.isFinite(k.value))) {
      problems.push(`Channel "${row.name}" has a keyframe that isn't a finite number.`);
      return null;
    }
    return { kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) };
  }
  if (kind === "color") {
    const ok = (v: unknown) =>
      Array.isArray(v)
        ? v.length >= 3 && v.length <= 4 && v.every((x) => typeof x === "number" && Number.isFinite(x))
        : typeof v === "string" && /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
    if (!block.keyframes.every((k) => ok(k.value))) {
      problems.push(`Channel "${row.name}" has a keyframe that isn't a "#hex" color or an RGBA tuple.`);
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
  if (kind === "toggle" || kind === "enum") {
    const uniformOf = (v: unknown) => {
      const stored = kind === "toggle" ? (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : row.default) : typeof v === "string" ? v : row.default;
      const r = { ...row, default: stored as ExprInput["default"] };
      return channelUniformValues([r], { [row.name]: readChannelValue(r, undefined) })[row.name] as number;
    };
    return { kind: "scalar", keys: block.keyframes.map((k) => ({ tick: k.tick, value: uniformOf(k.value), easing: "hold" })) };
  }
  problems.push(`Channel "${row.name}" (${kind}) can't be keyframed for export.`);
  return null;
}

// One 8-bit channel the way colorValueToHex writes it and hexToTuple reads
// it back.
export function byte01(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x * 255))) / 255;
}

export type DriverBinding =
  | { value: number | number[]; track?: undefined; from: string }
  | { track: TimelineTrack; value?: undefined; from: string };

export interface DriverOptions {
  // How a Color driver's alpha reaches the consumer:
  //   node      verbatim (an expression channel takes the Color node's tuple)
  //   hex       dropped — a color PARAM without ParamDef.alpha stores #rrggbb
  //   hex-alpha byte-quantised, kept only when < 255 (ParamDef.alpha params)
  colorAlpha?: "node" | "hex" | "hex-alpha";
  // Refusal wording for an unsupported driver: `${subject} (kind) is driven
  // by a <type> node — ${tail}`. Defaults are M0's channel message.
  subject?: string;
  tail?: string;
}

// `src` drives `name` (a channel or param of kind `kind`) through `edge`.
// Returns the binding when the runtime can replay it, plus every problem
// found on the way (a clip window on the driver is reported but still
// resolved, as M0 always did — the caller refuses on any problem).
export function resolveDriver(
  src: GraphNode,
  edge: GraphEdge,
  edges: GraphEdge[],
  kind: string,
  name: string,
  opts: DriverOptions = {}
): { binding: DriverBinding | null; problems: string[] } {
  const problems: string[] = [];
  const drivenInto = edges.filter((x) => x.target === src.id);
  if (src.clips?.length) problems.push(`"${src.id}" (driving ${name}) has a clip window — retimed drivers are not supported yet.`);

  if (src.type === "animated-value" && kind === "scalar") {
    if (drivenInto.length) {
      problems.push(`Animated Value "${src.id}" (driving ${name}) has wired inputs (${drivenInto.map((x) => x.targetHandle).join(", ")}) — only an unwired clock exports.`);
      return { binding: null, problems };
    }
    const block = liveBlock(src, "value");
    if (block) {
      return {
        binding: {
          track: { kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) },
          from: `Animated Value ${src.id} (${block.keyframes.length} keys)`,
        },
        problems,
      };
    }
    const v = typeof src.params.value === "number" ? src.params.value : 0;
    return { binding: { value: v, from: `Animated Value ${src.id} (static)` }, problems };
  }

  if (src.type === "constant" && kind === "scalar") {
    if (drivenInto.length || liveBlock(src, "value")) {
      problems.push(`Constant "${src.id}" (driving ${name}) is keyframed or wired — Constant snaps to its step every frame; use Animated Value for an exported curve.`);
      return { binding: null, problems };
    }
    const out = getNodeDef("constant")?.compute({
      inputs: {},
      auxIn: {},
      params: src.params,
      ctx: undefined as never,
      nodeId: src.id,
    }) as { primary?: { kind: string; value: number } } | undefined;
    const v = out?.primary?.kind === "scalar" ? out.primary.value : 0;
    return { binding: { value: v, from: `Constant ${src.id}` }, problems };
  }

  if (src.type === "color-literal" && kind === "color") {
    if (drivenInto.some((x) => x.targetHandle === "in:image")) {
      problems.push(`Color "${src.id}" (driving ${name}) extracts a palette from an image — not exportable.`);
      return { binding: null, problems };
    }
    if (liveBlock(src, "alpha")) {
      problems.push(`Color "${src.id}" has keyframed alpha — animate the color's own alpha in the shader instead (M0).`);
      return { binding: null, problems };
    }
    // Color 1 is the `color` param on the primary output; colors 2..8 are
    // `color<n>` params on matching aux outputs (color-literal.ts).
    const slot = edge.sourceHandle === "out:primary" ? "color" : edge.sourceHandle.replace(/^out:aux:/, "");
    const nodeAlpha = typeof src.params.alpha === "number" ? src.params.alpha : 1;
    const mode = opts.colorAlpha ?? "node";
    const alpha = mode === "node" ? nodeAlpha : mode === "hex" ? 1 : byte01(nodeAlpha) < 1 ? byte01(nodeAlpha) : 1;
    const block = liveBlock(src, slot);
    if (block) {
      return {
        binding: {
          track: {
            kind: "color",
            colorSpace: block.colorSpace ?? "oklab",
            quantize8: true,
            alpha,
            keys: block.keyframes.map((k) => toTimelineKey(k, "color")),
          },
          from: `Color ${src.id}.${slot} (${block.keyframes.length} keys, ${block.colorSpace ?? "oklab"})`,
        },
        problems,
      };
    }
    const rgb = hexToTuple(src.params[slot]);
    return { binding: { value: [rgb[0], rgb[1], rgb[2], alpha], from: `Color ${src.id}.${slot} (static)` }, problems };
  }

  const subject = opts.subject ?? `Channel "${name}"`;
  const tail = opts.tail ?? "only Animated Value (scalar), Constant (scalar) and Color (color) drive an exported Skia uniform in M0.";
  problems.push(`${subject} (${kind}) is driven by a ${src.type} node — ${tail}`);
  return { binding: null, problems };
}
