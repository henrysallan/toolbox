import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { compositeOverAt } from "@/engine/element";
import {
  DEFAULT_TEXT_STYLE,
  renderStyledTextToImage,
  type TextStyle,
} from "@/engine/text-raster";
import {
  formatPointLabels,
  POINT_LABEL_FIELDS,
  POINT_LABEL_UNITS,
  type PointLabelField,
  type PointLabelUnits,
} from "@/engine/point-labels";
import { aspectCorrectY } from "@/engine/aspect";
import { OPACITY_PARAM } from "@/engine/conventions";
import { CURATED_FONTS, ensureFontLoaded, isFontReady } from "@/lib/fonts";

// Point Labels — the self-contained convenience node: `points` → `image`. It
// formats each point's own data into a string (shared formatter with Points to
// Text), rasterizes it, and composites it at that point's location. Because it
// owns BOTH the points and the strings there's no second wire and no desync —
// the trade the composable Points-to-Text + Copy-to-Points route can't make.
//
// Placement reuses engine/element.ts's proven `compositeOverAt` (source-over a
// raster at a Y-down pixel rect) — one pass per label. No new GL, and Copy to
// Points is untouched. Point→pixel mapping matches Copy to Points exactly
// (aspect-corrected y via engine/aspect.ts) so labels land on rendered dots.
//
// `stable: false` like the Text node: it re-checks font readiness and canvas
// size every eval, and re-composites cheaply from a per-string raster LRU
// (text is only re-rasterized when a label's string or the style changes).

// Which point of the label box coincides with the (offset) target position.
// Named for where the text ends up relative to the point.
function anchorFrac(placement: string): [number, number] {
  switch (placement) {
    case "above":
      return [0.5, 1]; // box bottom at the point → text sits above
    case "below":
      return [0.5, 0];
    case "left":
      return [1, 0.5];
    case "right":
      return [0, 0.5];
    default:
      return [0.5, 0.5]; // "on" — centered on the point
  }
}

interface PointLabelsState {
  // Off-screen DOM-attached scratch canvas for rasterizing (variable-font axes
  // need the canvas attached — same requirement as Text / Copy to Points).
  textCanvas: HTMLCanvasElement | null;
  // Per-string raster LRU, valid for the current `styleSig`. Insertion order is
  // LRU order; front = oldest. Textures are node-owned — released on evict,
  // style change, and dispose (NOT by the evaluator).
  cache: Map<string, ImageValue>;
  styleSig: string;
}

// Cap the raster LRU so animated position labels (a fresh string per frame)
// stay bounded. High enough that a normal static label set never evicts
// mid-eval.
const MAX_CACHE = 1024;

function ensureState(ctx: RenderContext, nodeId: string): PointLabelsState {
  const key = `point-labels:${nodeId}`;
  const existing = ctx.state[key] as PointLabelsState | undefined;
  if (existing) return existing;
  const s: PointLabelsState = {
    textCanvas: null,
    cache: new Map(),
    styleSig: "",
  };
  ctx.state[key] = s;
  return s;
}

function ensureTextCanvas(state: PointLabelsState): HTMLCanvasElement {
  if (state.textCanvas) return state.textCanvas;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-toolbox-text-raster", "1");
  canvas.style.position = "fixed";
  canvas.style.left = "-99999px";
  canvas.style.top = "-99999px";
  canvas.style.pointerEvents = "none";
  canvas.style.visibility = "hidden";
  if (typeof document !== "undefined" && document.body) {
    document.body.appendChild(canvas);
  }
  state.textCanvas = canvas;
  return canvas;
}

function clearCache(ctx: RenderContext, state: PointLabelsState): void {
  for (const img of state.cache.values()) ctx.releaseTexture(img.texture);
  state.cache.clear();
}

export const pointLabelsNode: NodeDefinition = {
  type: "point-labels",
  name: "Point Labels",
  category: "point",
  subcategory: "modifier",
  description:
    "Draw a text label on every point, formatted from the point's own data — position (x, y), index, rotation, scale, or group. Pick a field or write a custom token template ({x} {y} {i} {n} {rot} {rad} {sx} {sy} {g}); coordinates read normalized [0,1] or in pixels, with adjustable precision. Self-contained (points → image): each label lands on its point, placed on / above / below / left / right of it with an offset and scale. Style comes from a wired Text node, or the local font/size/color params.",
  backend: "webgl2",
  // stable:false so font-readiness and canvas size are re-checked every eval,
  // like the Text node. Per-string raster caching keeps steady-state cheap.
  stable: false,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "style", type: "text_instance", required: false, label: "Style" },
  ],
  params: [
    {
      name: "field",
      label: "Data",
      type: "enum",
      options: POINT_LABEL_FIELDS as unknown as string[],
      default: "position",
    },
    {
      name: "template",
      label: "Template",
      type: "string",
      default: "{x}, {y}",
      placeholder: "{x}, {y}",
      visibleIf: (p) => p.field === "custom",
    },
    {
      name: "units",
      label: "Units",
      type: "enum",
      options: POINT_LABEL_UNITS as unknown as string[],
      default: "normalized",
      visibleIf: (p) =>
        p.field === "position" ||
        p.field === "x" ||
        p.field === "y" ||
        p.field === "custom",
    },
    {
      name: "precision",
      label: "Decimals",
      type: "scalar",
      min: 0,
      max: 6,
      step: 1,
      default: 2,
    },
    // Placement relative to the point.
    {
      name: "placement",
      label: "Placement",
      type: "enum",
      options: ["on", "above", "below", "left", "right"],
      default: "on",
    },
    {
      name: "offset_x",
      label: "Offset X",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      step: 0.001,
      default: 0,
    },
    {
      name: "offset_y",
      label: "Offset Y",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      step: 0.001,
      default: 0,
    },
    {
      name: "label_scale",
      label: "Label scale",
      type: "scalar",
      min: 0.1,
      max: 8,
      softMax: 3,
      step: 0.01,
      default: 1,
    },
    // Local fallback style — used only when no `style` input is wired (a wired
    // Text style overrides these at compute).
    {
      name: "font_family",
      label: "Font",
      type: "enum",
      control: "font",
      options: CURATED_FONTS,
      default: "Inter",
    },
    {
      name: "size",
      label: "Size (px)",
      type: "scalar",
      min: 1,
      max: 512,
      softMax: 128,
      step: 1,
      default: 32,
    },
    // alpha: lands verbatim in the shared text-raster Canvas fillStyle
    // (8-digit hex is valid CSS); the label raster cache keys on it.
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
      alpha: true,
    },
    {
      name: "alignment",
      label: "Align",
      type: "enum",
      options: ["left", "center", "right"],
      default: "center",
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.points;
    const output = ctx.allocImage();
    if (!src || src.kind !== "points" || src.count === 0) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const state = ensureState(ctx, nodeId);

    // Base style: a wired Text node's style wins; else local params.
    const styleIn = inputs.style;
    const labelScale = Math.max(0.01, (params.label_scale as number) ?? 1);
    const baseStyle: TextStyle =
      styleIn?.kind === "text_instance"
        ? styleIn.base
        : {
            ...DEFAULT_TEXT_STYLE,
            family: (params.font_family as string) ?? DEFAULT_TEXT_STYLE.family,
            size: (params.size as number) ?? DEFAULT_TEXT_STYLE.size,
            color: (params.color as string) ?? DEFAULT_TEXT_STYLE.color,
            alignment:
              (params.alignment as TextStyle["alignment"]) ?? "center",
          };

    // Font gate — mirror the Text node: if the family isn't ready, kick the
    // async load (it fires `pipeline-bump` on completion, re-driving eval) and
    // paint nothing this frame. Avoids caching a fallback-face raster.
    const family = baseStyle.family;
    if (!isFontReady(family)) {
      ensureFontLoaded(family);
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    // Bake the label scale into the font size so text stays crisp (vs.
    // stretching the raster in the rect). Style signature keys the raster
    // cache; a change (color/size/font/scale) invalidates every cached raster.
    const rasterStyle: TextStyle = {
      ...baseStyle,
      size: Math.max(1, baseStyle.size * labelScale),
    };
    const styleSig = JSON.stringify({ ...rasterStyle, text: "" });
    if (state.styleSig !== styleSig) {
      clearCache(ctx, state);
      state.styleSig = styleSig;
    }

    const strings = formatPointLabels(src, {
      field: (params.field as PointLabelField) ?? "position",
      template: (params.template as string) ?? "{x}, {y}",
      units: (params.units as PointLabelUnits) ?? "normalized",
      precision: (params.precision as number) ?? 2,
      width: ctx.width,
      height: ctx.height,
    });

    const [ax, ay] = anchorFrac((params.placement as string) ?? "on");
    const offX = (params.offset_x as number) ?? 0;
    const offY = (params.offset_y as number) ?? 0;
    const aspect = ctx.width / ctx.height;
    const canvas = ensureTextCanvas(state);

    // Composite each label over an accumulating target. `output` starts cleared
    // and is consumed by the first composite; each pass allocates the next
    // target and releases the previous. Cached rasters are NOT released here.
    ctx.clearTarget(output, [0, 0, 0, 0]);
    let acc = output;
    for (let i = 0; i < src.count; i++) {
      const s = strings[i];
      if (s.length === 0) continue;
      let raster = state.cache.get(s);
      if (raster) {
        // Touch → move to LRU tail.
        state.cache.delete(s);
        state.cache.set(s, raster);
      } else {
        raster = renderStyledTextToImage(ctx, canvas, {
          ...rasterStyle,
          text: s,
        });
        while (state.cache.size >= MAX_CACHE) {
          const oldestKey = state.cache.keys().next().value as
            | string
            | undefined;
          if (oldestKey === undefined) break;
          const old = state.cache.get(oldestKey)!;
          ctx.releaseTexture(old.texture);
          state.cache.delete(oldestKey);
        }
        state.cache.set(s, raster);
      }

      // Point → on-canvas pixel center (aspect-corrected y, matching Copy to
      // Points), plus the normalized offset; anchor the raster's box on it.
      const px = src.positions[i * 2] + offX;
      const py = aspectCorrectY(src.positions[i * 2 + 1], aspect) + offY;
      const tx = px * ctx.width;
      const ty = py * ctx.height;
      const rw = raster.width;
      const rh = raster.height;
      const next = compositeOverAt(ctx, acc, raster, {
        x: tx - ax * rw,
        y: ty - ay * rh,
        width: rw,
        height: rh,
      });
      ctx.releaseTexture(acc.texture);
      acc = next;
    }

    return { primary: acc };
  },

  dispose(ctx, nodeId) {
    const key = `point-labels:${nodeId}`;
    const state = ctx.state[key] as PointLabelsState | undefined;
    if (state) {
      clearCache(ctx, state);
      if (state.textCanvas?.parentNode) {
        state.textCanvas.parentNode.removeChild(state.textCanvas);
      }
    }
    delete ctx.state[key];
  },
};
