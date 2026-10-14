import type { NodeDefinition } from "@/engine/types";
import { bindDerived, type BindRef } from "@/engine/skia/scene-ir";
import { filterGroup, num } from "./filter-shared";

// Color Matrix (Skia) — React Native Skia <ColorMatrix> on a Group layer: a
// 4×5 matrix on every pixel's UNPREMULTIPLIED colour (Skia's convention,
// measured in CanvasKit: the translate column is in 0..1 units and the
// matrix sees straight colour), row-major, the last column added:
//   r' = m0·r + m1·g + m2·b + m3·a + m4   … and g', b', a' likewise.
// `adjust` builds it from CSS-filter-style controls, applied in this
// order: brightness (adds), contrast (about 0.5), saturation and hue
// rotation (the CSS Filter Effects matrices, Rec. 709 luma), sepia,
// invert, opacity. `custom` takes the 20 numbers verbatim.
//
// It runs on the canvas's working-space numbers: identical on an sRGB
// canvas (toolbox, Android, the web); on a Display P3 iPhone a hue or
// saturation matrix acts on P3 numbers, like every native Skia colour
// filter (spec §5.5 — native drawing is Skia's to convert).
//
// The matrix is derived from several params, so an animated control
// exports as a per-frame sampled matrix (one bind).

export type Matrix45 = number[];

export const IDENTITY_45: Matrix45 = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

// b ∘ a: apply `a`, then `b`.
export function composeMatrix45(b: Matrix45, a: Matrix45): Matrix45 {
  const out = new Array<number>(20).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let s = c === 4 ? b[r * 5 + 4] : 0;
      for (let k = 0; k < 4; k++) s += b[r * 5 + k] * a[k * 5 + c];
      out[r * 5 + c] = s;
    }
  }
  return out;
}

const rgb3 = (m: number[], t = [0, 0, 0]): Matrix45 => [
  m[0], m[1], m[2], 0, t[0],
  m[3], m[4], m[5], 0, t[1],
  m[6], m[7], m[8], 0, t[2],
  0, 0, 0, 1, 0,
];

const LUM = [0.2126, 0.7152, 0.0722];

export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number; // degrees
  sepia: number;
  invert: number;
  opacity: number;
}

export function adjustMatrix45(a: ColorAdjust): Matrix45 {
  let m = IDENTITY_45;
  const then = (x: Matrix45) => (m = composeMatrix45(x, m));
  if (a.brightness !== 0) then(rgb3([1, 0, 0, 0, 1, 0, 0, 0, 1], [a.brightness, a.brightness, a.brightness]));
  if (a.contrast !== 1) {
    const c = a.contrast;
    const t = 0.5 * (1 - c);
    then(rgb3([c, 0, 0, 0, c, 0, 0, 0, c], [t, t, t]));
  }
  if (a.saturation !== 1) {
    const s = a.saturation;
    const row = (i: number) => LUM.map((l, k) => l * (1 - s) + (k === i ? s : 0));
    then(rgb3([...row(0), ...row(1), ...row(2)]));
  }
  if (a.hue !== 0) {
    // CSS Filter Effects hue-rotate.
    const th = (a.hue * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    then(
      rgb3([
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
      ])
    );
  }
  if (a.sepia !== 0) {
    // CSS Filter Effects sepia(amount).
    const k = 1 - Math.max(0, Math.min(1, a.sepia));
    then(
      rgb3([
        0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k,
        0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k,
        0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k,
      ])
    );
  }
  if (a.invert !== 0) {
    const v = Math.max(0, Math.min(1, a.invert));
    const d = 1 - 2 * v;
    then(rgb3([d, 0, 0, 0, d, 0, 0, 0, d], [v, v, v]));
  }
  if (a.opacity !== 1) then([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, Math.max(0, Math.min(1, a.opacity)), 0]);
  return m;
}

// "1 0 0 0 0, …": 20 finite numbers, separated by commas and/or spaces.
export function parseMatrix45(text: unknown): Matrix45 | null {
  if (typeof text !== "string") return null;
  const parts = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  return parts.length === 20 && parts.every(Number.isFinite) ? parts : null;
}

const ADJUST_PARAMS = ["brightness", "contrast", "saturation", "hue", "sepia", "invert", "opacity"] as const;
const isAdjust = (p: Record<string, unknown>) => p.mode !== "custom";

export const skiaColorMatrixNode: NodeDefinition = {
  type: "skia-color-matrix",
  name: "Color Matrix (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "Recolours the Skia drawing wired into it with a 4×5 colour matrix (React Native Skia <ColorMatrix> on a Group layer) on unpremultiplied colour: built from brightness, contrast, saturation, hue rotation, sepia, invert and opacity (CSS-filter style, in that order), or 20 numbers verbatim in custom mode.",
  searchAliases: ["skia", "color matrix", "colour matrix", "saturation", "hue", "sepia", "invert", "grayscale", "react native"],
  facts: {
    gotchas: [
      "The matrix acts on unpremultiplied colour in 0..1; the 5th column is an offset in 0..1 units (not 0..255).",
      "Adjustments apply in a fixed order: brightness, contrast, saturation, hue, sepia, invert, opacity.",
      "Native colour filters run on the canvas's working-space numbers: on a Display P3 iPhone hue/saturation act on P3 values (sRGB canvases are exact).",
      "An animated control exports as a per-frame sampled matrix, not a track.",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  params: [
    { name: "mode", label: "Mode", type: "enum", options: ["adjust", "custom"], default: "adjust" },
    { name: "brightness", label: "Brightness", type: "scalar", min: -1, max: 1, step: 0.01, default: 0, visibleIf: isAdjust },
    { name: "contrast", label: "Contrast", type: "scalar", min: 0, max: 4, softMax: 2, step: 0.01, default: 1, visibleIf: isAdjust },
    { name: "saturation", label: "Saturation", type: "scalar", min: 0, max: 4, softMax: 2, step: 0.01, default: 1, visibleIf: isAdjust },
    { name: "hue", label: "Hue (°)", type: "scalar", min: -180, max: 180, step: 1, default: 0, visibleIf: isAdjust },
    { name: "sepia", label: "Sepia", type: "scalar", min: 0, max: 1, step: 0.01, default: 0, visibleIf: isAdjust },
    { name: "invert", label: "Invert", type: "scalar", min: 0, max: 1, step: 0.01, default: 0, visibleIf: isAdjust },
    { name: "opacity", label: "Opacity", type: "scalar", min: 0, max: 1, step: 0.001, default: 1, visibleIf: isAdjust },
    {
      name: "matrix",
      label: "Matrix (4×5)",
      type: "string",
      default: "1 0 0 0 0, 0 1 0 0 0, 0 0 1 0 0, 0 0 0 1 0",
      visibleIf: (p) => p.mode === "custom",
    },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const problems: string[] = [];
    let m: Matrix45;
    let deps: BindRef[];
    if (params.mode === "custom") {
      const parsed = parseMatrix45(params.matrix);
      if (!parsed) problems.push(`Color Matrix (Skia) "${nodeId}": the custom matrix must be 20 numbers (4 rows of 5) — using the identity.`);
      m = parsed ?? IDENTITY_45;
      deps = [{ node: nodeId, param: "mode" }, { node: nodeId, param: "matrix" }];
    } else {
      m = adjustMatrix45({
        brightness: num(params.brightness, 0),
        contrast: num(params.contrast, 1),
        saturation: num(params.saturation, 1),
        hue: num(params.hue, 0),
        sepia: num(params.sepia, 0),
        invert: num(params.invert, 0),
        opacity: num(params.opacity, 1),
      });
      deps = ["mode", ...ADJUST_PARAMS].map((param) => ({ node: nodeId, param }));
    }
    return { primary: filterGroup(inputs.content, nodeId, { colorFilters: [{ k: "matrix", m: bindDerived(m, deps) }] }, problems) };
  },
};
