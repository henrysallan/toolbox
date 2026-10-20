// The node suites calibrate/nodes.mts runs: test images and param cases per
// effect-class node. A case without `ae` uses calibration.ts's map.

import type { AeEffectContext, AeEffectInstance } from "@/lib/ae-export/calibration";
import { blank, colorsImage, discImage, fill, gridImage, noiseImage, rampImage, type FloatImage } from "./lib.mts";

export interface Case {
  id: string;
  image: string;
  values: Record<string, unknown>;
  // Other node inputs: socket → image slot (an AE layer below, hidden).
  inputs?: Record<string, string>;
  // Explicit AE effects instead of the map's.
  ae?: (values: Record<string, unknown>, ctx: AeEffectContext) => AeEffectInstance[];
  // Pixels excluded at the frame edge.
  crop?: number;
}

export interface Suite {
  node: string;
  id?: string;
  size: { width: number; height: number };
  // slot → image (or a frame sequence).
  images: Record<string, FloatImage | FloatImage[]>;
  input?: string;
  frames?: number[];
  fps?: number;
  note?: string;
  // "grain": compare per-band noise statistics (recorded) as well.
  stats?: "grain";
  cases: Case[];
}

const W = 384;
const H = 256;
const size = { width: W, height: H };
const noise = noiseImage(W, H, 11);
const colors = colorsImage(W, H);
const ramp = rampImage(W, H);
const disc = discImage(W, H, 70);
const grid = gridImage(W, H, 16);
const px = (x: number, c: AeEffectContext) => x * c.width;
const py = (y: number, c: AeEffectContext) => c.height / 2 + (y - 0.5) * c.width;
const fx = (match: string, props: Record<string, unknown>): AeEffectInstance => ({ match, props });

export const SUITES: Suite[] = [
  {
    node: "pixelate",
    id: "pixelate-explore",
    size,
    images: { noise, colors },
    cases: [
      { id: "size16", image: "noise", values: { size: 16 } },
      { id: "size32", image: "noise", values: { size: 32 } },
      { id: "size20", image: "noise", values: { size: 20 } },
      { id: "size25_colors", image: "colors", values: { size: 25 } },
      { id: "size16_aspect2", image: "noise", values: { size: 16, aspect: 2 } },
      { id: "size16_soft", image: "noise", values: { size: 16 }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [fx("ADBE Mosaic", { "ADBE Mosaic-0001": c.width / 16, "ADBE Mosaic-0002": c.height / 16, "ADBE Mosaic-0003": 0 })] },
      { id: "size16_sharp", image: "noise", values: { size: 16 }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [fx("ADBE Mosaic", { "ADBE Mosaic-0001": c.width / 16, "ADBE Mosaic-0002": c.height / 16, "ADBE Mosaic-0003": 1 })] },
      {
        id: "size16_sharp_negshift",
        image: "noise",
        values: { size: 16 },
        ae: (v: Record<string, unknown>, c: AeEffectContext) => [
          fx("ADBE Geometry2", { "ADBE Geometry2-0001": [0, 0], "ADBE Geometry2-0002": [-7.5, -7.5], "ADBE Geometry2-0011": 1, "ADBE Geometry2-0009": 0 }),
          fx("ADBE Mosaic", { "ADBE Mosaic-0001": c.width / 16, "ADBE Mosaic-0002": c.height / 16, "ADBE Mosaic-0003": 1 }),
        ],
      },
      { id: "size20_soft", image: "noise", values: { size: 20 }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [fx("ADBE Mosaic", { "ADBE Mosaic-0001": c.width / 20, "ADBE Mosaic-0002": c.height / 20, "ADBE Mosaic-0003": 0 })] },
      { id: "size25_colors_soft", image: "colors", values: { size: 25 }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [fx("ADBE Mosaic", { "ADBE Mosaic-0001": c.width / 25, "ADBE Mosaic-0002": c.height / 25, "ADBE Mosaic-0003": 0 })] },
    ],
  },
  {
    node: "transform",
    id: "transform-explore",
    size,
    images: { noise },
    cases: [
      {
        id: "trs_bicubic",
        image: "noise",
        values: { translateX: 0.1, translateY: -0.05, scaleX: 0.8, scaleY: 1.2, rotate: 30, pivotX: 0.4, pivotY: 0.6 },
        ae: (v: Record<string, unknown>, c: AeEffectContext) => [
          fx("ADBE Geometry2", {
            "ADBE Geometry2-0011": 0,
            "ADBE Geometry2-0001": [px(0.4, c), py(0.6, c)],
            "ADBE Geometry2-0002": [px(0.4, c) + 0.1 * c.width, py(0.6, c) - 0.05 * c.width],
            "ADBE Geometry2-0004": 80,
            "ADBE Geometry2-0003": 120,
            "ADBE Geometry2-0007": 30,
            "ADBE Geometry2-0009": 0,
            "ADBE Geometry2-0012": 2,
          }),
        ],
      },
    ],
  },
  {
    node: "posterize",
    size,
    images: { ramp, noise },
    cases: [2, 3, 4, 6, 12, 32].flatMap((levels) => [
      { id: `ramp_l${levels}`, image: "ramp", values: { levels } },
      { id: `noise_l${levels}`, image: "noise", values: { levels } },
    ]),
  },
  {
    node: "threshold",
    size,
    images: { colors, ramp },
    cases: [0.2, 0.5, 0.75].flatMap((t) => [
      { id: `colors_t${t}`, image: "colors", values: { threshold: t } },
      { id: `ramp_t${t}`, image: "ramp", values: { threshold: t } },
    ]),
  },
  {
    // AE Mirror's side convention, tried against every toolbox bisect side.
    node: "mirror",
    id: "mirror-explore",
    input: "source",
    size,
    images: { noise },
    cases: (["x", "-x", "y", "-y"] as const).flatMap((keep) =>
      [0, 90, 180, 270].map((angle) => ({
        id: `keep${keep}_a${angle}`,
        image: "noise",
        values: { mode: "bisect", keep, centerX: 0.45, centerY: 0.55 },
        ae: (v: Record<string, unknown>, c: AeEffectContext) => [fx("ADBE Mirror", { "ADBE Mirror-0001": [px(0.45, c), py(0.55, c)], "ADBE Mirror-0002": angle })],
      }))
    ),
  },
  {
    // AE Polar Coordinates' conventions: toolbox radius scale / rotation /
    // edge swept against AE's two conversion types on the asymmetric colours.
    node: "polar-coords",
    id: "polar-explore",
    size: { width: 256, height: 256 },
    images: { colors: colorsImage(256, 256) },
    cases: (["rect-to-polar", "polar-to-rect"] as const).flatMap((mode) =>
      (mode === "rect-to-polar" ? [1, 2] : [0.5, 1]).flatMap((scale_radius) =>
        [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((rotation) => ({
          id: `${mode}_s${scale_radius}_r${Math.round((rotation * 180) / Math.PI)}`,
          image: "colors",
          values: { mode, scale_radius, rotation, wrap: "transparent" },
          ae: () => [fx("ADBE Polar Coordinates", { "ADBE Polar Coordinates-0001": 1, "ADBE Polar Coordinates-0002": mode === "rect-to-polar" ? 1 : 2 })],
        }))
      )
    ),
  },
];


// ---- displace / bloom / grain / edge-detect / color-correction / sharpen -------

const dmap = noiseImage(W, H, 23);
const grey = fill(blank(W, H), () => [0.5, 0.5, 0.5, 1]);
// Dim noise with a bright disc and a few hot dots: something to bloom.
const hot = (() => {
  const n = noiseImage(W, H, 5);
  return fill(blank(W, H), (x, y) => {
    const i = (y * W + x) * 4;
    const inDisc = Math.hypot(x + 0.5 - 140, y + 0.5 - 128) < 40;
    const dot = [[280, 70], [300, 190], [330, 120]].some(([cx, cy]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < 6);
    if (inDisc || dot) return [1, 0.95, 0.85, 1];
    return [n.data[i] * 0.35, n.data[i + 1] * 0.35, n.data[i + 2] * 0.35, 1];
  });
})();
const DM = "ADBE Displacement Map";
const disp = (h: number, mh: number, v: number, mv: number, wrap = 0) =>
  fx(DM, { [`${DM}-0001`]: { input: "displacement" }, [`${DM}-0002`]: h, [`${DM}-0003`]: mh, [`${DM}-0004`]: v, [`${DM}-0005`]: mv, [`${DM}-0006`]: 2, [`${DM}-0007`]: wrap, [`${DM}-0008`]: 0 });
const GLOW = "ADBE Glo2";
const glow = (t255: number, radius: number, intensity: number) =>
  fx(GLOW, { [`${GLOW}-0001`]: 2, [`${GLOW}-0002`]: t255, [`${GLOW}-0003`]: radius, [`${GLOW}-0004`]: intensity });
const GR = "VISINF Grain Implant";
const grain = (intensity: number, sz: number, soft: number, blend = 1) =>
  fx(GR, { [`${GR}-0021`]: 3, [`${GR}-0008`]: intensity, [`${GR}-0007`]: sz, [`${GR}-0130`]: soft, [`${GR}-0005`]: 1, [`${GR}-0039`]: 0, [`${GR}-0014`]: blend });

SUITES.push(
  {
    node: "displace",
    id: "displace-explore",
    size,
    images: { noise, dmap },
    cases: [
      ...[1, -1].flatMap((sgn) => [
        { id: `x_s${sgn}`, image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.05, amountY: 0 }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [disp(1, (sgn * 0.05 * c.width) / 2, 11, 0)] },
        { id: `y_s${sgn}`, image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0, amountY: 0.05 }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [disp(11, 0, 2, (sgn * 0.05 * c.height) / 2)] },
      ]),
      { id: "x_s1_wrap", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.2, amountY: 0, wrap: "transparent" }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [disp(1, (0.2 * c.width) / 2, 11, 0)] },
      { id: "x_s-1_wrap", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.2, amountY: 0, wrap: "transparent" }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [disp(1, (-0.2 * c.width) / 2, 11, 0)] },
      { id: "x_s1_clamp", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.2, amountY: 0, wrap: "clamp" }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [disp(1, (0.2 * c.width) / 2, 11, 0)] },
      { id: "x_s-1_clamp", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.2, amountY: 0, wrap: "clamp" }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [disp(1, (-0.2 * c.width) / 2, 11, 0)] },
    ],
  },
  {
    node: "bloom",
    id: "bloom-explore",
    size,
    images: { hot },
    cases: [64, 96, 128, 192].flatMap((radius) =>
      [1.5, 2, 3, 4].flatMap((intensity) => [0.6, 0.7].map((t) => ({ id: `r${radius}_i${intensity}_t${t}`, image: "hot", values: {}, ae: () => [glow(t * 255, radius, intensity)] })))
    ),
  },
  {
    node: "grain",
    id: "grain-explore",
    size,
    images: { grey, ramp },
    note: "statistics only: grain is noise — std and correlation length are compared (calibrate/grain-stats), not pixels",
    cases: [
      { id: "tb_default", image: "grey", values: {}, ae: () => [grain(1, 1, 0)] },
      ...[1, 2, 3, 4, 5].map((b) => ({ id: `ramp_blend${b}`, image: "ramp", values: {}, ae: () => [grain(17.36 * 0.06, 1, 0, b)] })),
      ...[0.25, 0.5, 1, 2].flatMap((i) => [0.5, 1, 2].map((sz) => ({ id: `i${i}_s${sz}`, image: "grey", values: {}, ae: () => [grain(i, sz, 0)] }))),
    ],
  },
  {
    node: "edge-detect",
    id: "edge-explore",
    size,
    images: { disc, noise },
    cases: [0, 1].flatMap((inv) =>
      [
        ["disc", 0.25],
        ["noise", 1],
      ].map(([image, strength]) => ({ id: `${image}_inv${inv}`, image: String(image), values: { strength }, ae: () => [fx("ADBE Find Edges", { "ADBE Find Edges-0001": inv, "ADBE Find Edges-0002": 0 })] }))
    ),
  },
  {
    node: "color-correction",
    id: "cc-explore",
    size,
    images: { colors },
    cases: [
      { id: "hue60", image: "colors", values: { hue: 60 }, ae: () => [fx("ADBE HUE SATURATION", { "ADBE HUE SATURATION-0004": 60 })] },
      { id: "hue-60", image: "colors", values: { hue: -60 }, ae: () => [fx("ADBE HUE SATURATION", { "ADBE HUE SATURATION-0004": -60 })] },
      { id: "sat0.5", image: "colors", values: { saturation: 0.5 }, ae: () => [fx("ADBE HUE SATURATION", { "ADBE HUE SATURATION-0005": -50 })] },
      { id: "sat1.5", image: "colors", values: { saturation: 1.5 }, ae: () => [fx("ADBE HUE SATURATION", { "ADBE HUE SATURATION-0005": 50 })] },
      { id: "sat0", image: "colors", values: { saturation: 0 }, ae: () => [fx("ADBE HUE SATURATION", { "ADBE HUE SATURATION-0005": -100 })] },
      ...[0, 1].flatMap((legacy) => [
        { id: `bright0.1_leg${legacy}`, image: "colors", values: { brightness: 0.1 }, ae: () => [fx("ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0001": 25.5, "ADBE Brightness & Contrast 2-0003": legacy })] },
        { id: `contrast1.5_leg${legacy}`, image: "colors", values: { contrast: 1.5 }, ae: () => [fx("ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0002": 50, "ADBE Brightness & Contrast 2-0003": legacy })] },
        { id: `contrast1.5_c33_leg${legacy}`, image: "colors", values: { contrast: 1.5 }, ae: () => [fx("ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0002": 100 / 3, "ADBE Brightness & Contrast 2-0003": legacy })] },
        { id: `contrast2_c50_leg${legacy}`, image: "colors", values: { contrast: 2 }, ae: () => [fx("ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0002": 50, "ADBE Brightness & Contrast 2-0003": legacy })] },
        { id: `contrast0.5_leg${legacy}`, image: "colors", values: { contrast: 0.5 }, ae: () => [fx("ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0002": -50, "ADBE Brightness & Contrast 2-0003": legacy })] },
      ]),
    ],
  },
  {
    node: "sharpen",
    id: "sharpen-explore",
    size,
    images: { noise },
    cases: [
      ...[0.5, 1].flatMap((amount) => [10, 25, 50, 100].map((a) => ({ id: `box${amount}_sh${a}`, image: "noise", values: { algorithm: "box", amount }, ae: () => [fx("ADBE Sharpen", { "ADBE Sharpen-0001": a })] }))),
      ...[0.5, 1].map((amount) => ({ id: `box${amount}_sh${50 * amount}_crop`, image: "noise", crop: 2, values: { algorithm: "box", amount }, ae: () => [fx("ADBE Sharpen", { "ADBE Sharpen-0001": 50 * amount })] })),
      ...(["diamond", "cross"] as const).flatMap((algorithm) => [25, 50, 100].map((a) => ({ id: `${algorithm}1_sh${a}`, image: "noise", crop: 2, values: { algorithm, amount: 1 }, ae: () => [fx("ADBE Sharpen", { "ADBE Sharpen-0001": a })] }))),
      ...[0.5, 0.7, 1, 1.5].map((r) => ({ id: `unsharp1_r${r}`, image: "noise", values: { algorithm: "unsharp", amount: 1 }, ae: () => [fx("ADBE Unsharp Mask2", { "ADBE Unsharp Mask2-0001": 100, "ADBE Unsharp Mask2-0002": r, "ADBE Unsharp Mask2-0003": 0 })] })),
    ],
  },
);

// ---- array / trails / keyer / bevel-emboss / chromatic-aberration ------------

const alphaDisc = discImage(W, H, 70, { transparent: true, color: [1, 0.6, 0.2] });
// A disc moving left → right on transparent, 16 frames.
const moving = Array.from({ length: 16 }, (_, f) =>
  fill(blank(W, H), (x, y) => (Math.hypot(x + 0.5 - (60 + f * 18), y + 0.5 - 128) < 22 ? [0.2, 0.8, 1, 1] : [0, 0, 0, 0]))
);
const TILE = "ADBE Tile";
const tile = (cx: number, cy: number, c: AeEffectContext) =>
  fx(TILE, { [`${TILE}-0001`]: [c.width / (2 * cx), c.height - c.height / (2 * cy)], [`${TILE}-0002`]: 100 / cx, [`${TILE}-0003`]: 100 / cy, [`${TILE}-0004`]: 100, [`${TILE}-0005`]: 100, [`${TILE}-0006`]: 0, [`${TILE}-0007`]: 0 });
const ECHO = "ADBE Echo";
const echo = (decay: number, n: number, op: number, fps: number) =>
  fx(ECHO, { [`${ECHO}-0001`]: -1 / fps, [`${ECHO}-0002`]: n, [`${ECHO}-0003`]: 1, [`${ECHO}-0004`]: decay, [`${ECHO}-0005`]: op });
const LCK = "ADBE Linear Color Key2";
const lck = (key: number[], match: number, tol: number, soft: number) =>
  fx(LCK, { [`${LCK}-0002`]: 1, [`${LCK}-0003`]: key, [`${LCK}-0004`]: match, [`${LCK}-0005`]: tol, [`${LCK}-0006`]: soft, [`${LCK}-0007`]: 1 });
const EX = "ADBE Extract";
const extract = (black: number, blackSoft: number) => fx(EX, { [`${EX}-0002`]: 1, [`${EX}-0003`]: black, [`${EX}-0004`]: 255, [`${EX}-0005`]: blackSoft, [`${EX}-0006`]: 0, [`${EX}-0007`]: 0 });
const BEV = "ADBE Bevel Alpha";

SUITES.push(
  {
    node: "array",
    id: "array-explore",
    input: "instance",
    size,
    images: { noise, alphaDisc },
    cases: [
      [3, 3],
      [2, 2],
      [4, 3],
    ].flatMap(([cx, cy]) =>
      ["noise", "alphaDisc"].map((image) => ({ id: `${image}_${cx}x${cy}`, image, values: { mode: "image", countX: cx, countY: cy }, ae: (v: Record<string, unknown>, c: AeEffectContext) => [tile(cx, cy, c)] }))
    ),
  },
  {
    node: "trails",
    id: "trails-explore",
    size,
    fps: 30,
    frames: [5, 10, 15],
    images: { moving },
    cases: [5, 6, 7].flatMap((op) => [0.8, 0.5].map((decay) => ({ id: `feedback_d${decay}_op${op}`, image: "moving", values: { mode: "feedback", decay }, ae: () => [echo(decay, 20, op, 30)] }))),
  },
  {
    node: "keyer",
    id: "keyer-explore",
    size,
    images: { colors },
    cases: [
      ...[10, 20, 30].flatMap((tol) => [5, 10, 20].map((soft) => ({ id: `color_t${tol}_s${soft}`, image: "colors", values: { mode: "color", key_color: "#00ff00", tolerance: 0.2, softness: 0.1 }, ae: () => [lck([0, 1, 0, 1], 1, tol, soft)] }))),
      ...[10, 20, 30].map((tol) => ({ id: `chroma_t${tol}`, image: "colors", values: { mode: "chroma", key_color: "#00ff00", tolerance: 0.2, softness: 0.1 }, ae: () => [lck([0, 1, 0, 1], 3, tol, 10)] })),
      { id: "luma_extract", image: "colors", values: { mode: "luma", threshold: 0.5, softness: 0.1 }, ae: () => [extract(0.55 * 255, 0.1 * 255)] },
      { id: "luma_extract_mid", image: "colors", values: { mode: "luma", threshold: 0.5, softness: 0.1 }, ae: () => [extract(0.5 * 255, 0.1 * 255)] },
    ],
  },
  {
    node: "bevel-emboss",
    id: "bevel-explore",
    size,
    images: { alphaDisc },
    cases: [-60, 45, 135, 225].map((angle) => ({
      id: `outer_a${angle}`,
      image: "alphaDisc",
      values: { style: "outer-bevel", depth: 8 },
      ae: () => [fx(BEV, { [`${BEV}-0001`]: 8, [`${BEV}-0002`]: angle, [`${BEV}-0003`]: [1, 1, 1, 1], [`${BEV}-0004`]: 0.4 })],
    })),
  },
  {
    node: "chromatic-aberration",
    id: "ca-explore",
    size,
    images: { noise },
    cases: [{ id: "vr_defaults", image: "noise", values: { amount: 0.01 }, ae: () => [fx("Mettle SkyBox Chromatic Aberrat", {})] }],
  },
);

// ---- validation of the maps (no `ae`: calibration.ts drives AE) ---------------

SUITES.push(
  {
    node: "transform",
    id: "transform",
    size,
    images: { noise, disc },
    cases: [
      { id: "identity", image: "noise", values: {} },
      { id: "trs", image: "noise", values: { translateX: 0.1, translateY: -0.05, scaleX: 0.8, scaleY: 1.2, rotate: 30, pivotX: 0.4, pivotY: 0.6 } },
      { id: "shrink_rot45", image: "disc", values: { scaleX: 0.5, scaleY: 0.5, rotate: 45 } },
      { id: "nonuniform_rot", image: "noise", values: { scaleX: 1.5, scaleY: 0.6, rotate: -20, pivotX: 0.7, pivotY: 0.3 } },
      { id: "translate_only", image: "disc", values: { translateX: 0.123, translateY: 0.077 } },
      { id: "tile_refused", image: "noise", values: { tile: true, scaleX: 0.5, scaleY: 0.5 } },
    ],
  },
  {
    node: "pixelate",
    id: "pixelate",
    size,
    images: { noise, colors },
    cases: [
      { id: "size16", image: "noise", values: { size: 16 } },
      { id: "size32", image: "noise", values: { size: 32 } },
      { id: "size8_colors", image: "colors", values: { size: 8 } },
      { id: "size16_aspect1.5", image: "noise", values: { size: 16, aspect: 1.5 } },
      { id: "size20_refused", image: "noise", values: { size: 20 } },
      { id: "circle_refused", image: "noise", values: { size: 16, shape: "circle" } },
    ],
  },
  {
    node: "displace",
    id: "displace",
    size,
    images: { noise, dmap, colors },
    cases: [
      { id: "default_clamp", image: "noise", inputs: { displacement: "dmap" }, values: {} },
      { id: "xy_transparent", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.08, amountY: -0.04, wrap: "transparent" } },
      { id: "blue_alpha", image: "colors", inputs: { displacement: "dmap" }, values: { amountX: 0.05, amountY: 0.05, channelX: "b", channelY: "r", wrap: "transparent" } },
      { id: "luminance", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.1, amountY: 0.1, channelX: "luminance", channelY: "luminance", wrap: "transparent" } },
      { id: "large_clamp", image: "noise", inputs: { displacement: "dmap" }, values: { amountX: 0.2, amountY: 0.2 } },
      { id: "midlevel_refused", image: "noise", inputs: { displacement: "dmap" }, values: { midlevel: 0.3 } },
    ],
  },
  {
    node: "bloom",
    id: "bloom",
    size,
    images: { hot },
    cases: [
      { id: "default", image: "hot", values: {} },
      { id: "levels4", image: "hot", values: { levels: 4 } },
      { id: "levels5_i2", image: "hot", values: { levels: 5, intensity: 2 } },
      { id: "intensity0.5", image: "hot", values: { intensity: 0.5 } },
      { id: "threshold0.5", image: "hot", values: { threshold: 0.5 } },
      { id: "balanced", image: "hot", values: { quality: "balanced" } },
    ],
  },
  {
    node: "grain",
    id: "grain",
    size,
    stats: "grain",
    images: { ramp, grey },
    note: "statistics only: per-band std of (out − in) and lag-1 autocorrelation; the random field differs",
    cases: [
      { id: "default_ramp", image: "ramp", values: {} },
      { id: "lum0.15_ramp", image: "ramp", values: { luminance: 0.15 } },
      { id: "default_grey", image: "grey", values: {} },
      { id: "chromatic_refused", image: "ramp", values: { chromatic: 0.1 } },
    ],
  },
  {
    node: "color-correction",
    id: "color-correction",
    size,
    images: { colors, noise },
    cases: [
      { id: "hue45", image: "colors", values: { hue: 45 } },
      { id: "bright_contrast", image: "colors", values: { brightness: 0.08, contrast: 1.3 } },
      { id: "all_three", image: "noise", values: { brightness: -0.05, contrast: 0.8, hue: -120 } },
      { id: "contrast2", image: "noise", values: { contrast: 2 } },
      { id: "saturation_refused", image: "colors", values: { saturation: 1.4 } },
    ],
  },
  {
    node: "sharpen",
    id: "sharpen",
    size,
    images: { noise, disc },
    cases: [
      { id: "box1", image: "noise", values: { algorithm: "box", amount: 1 } },
      { id: "box1_interior", image: "noise", crop: 2, values: { algorithm: "box", amount: 1 } },
      { id: "box2_disc", image: "disc", values: { algorithm: "box", amount: 2 } },
      { id: "unsharp1", image: "noise", values: { algorithm: "unsharp", amount: 1 } },
      { id: "unsharp3_disc", image: "disc", values: { algorithm: "unsharp", amount: 3 } },
      { id: "diamond_refused", image: "noise", values: { algorithm: "diamond", amount: 1 } },
    ],
  },
  {
    node: "array",
    id: "array",
    input: "instance",
    size,
    images: { noise, alphaDisc },
    cases: [
      { id: "fit3x3", image: "noise", values: { mode: "image", countX: 3, countY: 3 } },
      { id: "fit2x4", image: "alphaDisc", values: { mode: "image", countX: 2, countY: 4 } },
      { id: "fit5x2", image: "noise", values: { mode: "image", countX: 5, countY: 2 } },
      { id: "step_cover", image: "noise", values: { mode: "image", sizeMode: "step", sizeW: 0.25, sizeH: 0.5, countX: 4, countY: 2 } },
      { id: "local_refused", image: "noise", values: { mode: "image", localRotate: 30 } },
    ],
  },
  {
    node: "trails",
    id: "trails",
    size,
    fps: 30,
    frames: [5, 10, 15],
    images: { moving },
    cases: [
      { id: "feedback_d0.8", image: "moving", values: { mode: "feedback", decay: 0.8 } },
      { id: "feedback_d0.92", image: "moving", values: { mode: "feedback" } },
      { id: "feedback_d0.5", image: "moving", values: { mode: "feedback", decay: 0.5 } },
      { id: "ring_refused", image: "moving", values: { mode: "ring", step_frames: 3 } },
    ],
  },
  {
    node: "keyer",
    id: "keyer",
    size,
    images: { colors },
    cases: [
      { id: "green_t0.2_s0.1", image: "colors", values: { mode: "color", key_color: "#00ff00", tolerance: 0.2, softness: 0.1 } },
      { id: "blue_t0.3_s0.2", image: "colors", values: { mode: "color", key_color: "#0000ff", tolerance: 0.3, softness: 0.2 } },
      { id: "orange_t0.1_s0.05", image: "colors", values: { mode: "color", key_color: "#ff8000", tolerance: 0.1, softness: 0.05 } },
      { id: "hard_t0.25", image: "colors", values: { mode: "color", key_color: "#00ff00", tolerance: 0.25, softness: 0 } },
      { id: "luma_refused", image: "colors", values: { mode: "luma" } },
    ],
  },
  {
    node: "mirror",
    id: "mirror",
    input: "source",
    size,
    images: { noise, colors },
    cases: [
      { id: "bisect_x", image: "noise", values: { mode: "bisect", keep: "x", centerX: 0.45 } },
      { id: "bisect_-x", image: "colors", values: { mode: "bisect", keep: "-x", centerX: 0.6 } },
      { id: "bisect_y", image: "noise", values: { mode: "bisect", keep: "y", centerY: 0.55 } },
      { id: "bisect_-y", image: "colors", values: { mode: "bisect", keep: "-y", centerY: 0.5 } },
      { id: "x_refused", image: "noise", values: { mode: "x" } },
    ],
  },
);

export { colors, disc, grid, noise, ramp };
