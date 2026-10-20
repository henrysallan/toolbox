// Effect-class parameter maps (spec 091926_after-effects-handoff.md §3 rung
// 2, §11.8, §14): toolbox node params → the AE built-in effect's properties,
// with the unit rule and how well it matches, measured in AE 26.5.
//
// Measured by scripts/ae-export-spike/calibrate/ (blur.mts for blur,
// nodes.mts for the rest): the same test images through toolbox (its real
// node code, headless) and through AE (aerender, 8 and 16 bpc), compared with
// compareRgba. The numbers live in calibrate/measured/*.json and
// scripts/ae-export/check-calibration.mts holds them.
//
// Call `resolveAeEffectMap(type, values, ctx)`: it returns the map (or the
// variant) whose `applies` holds for the node's params, or the `refusal` that
// sends the node to `shader` (for the plan report). `measured: false` means a
// map was not render-checked: the scene walk must report it as "approx,
// uncalibrated". Every map below is measured; `error` is its worst case.
//
// Contract (wave-2 stub, extended compatibly): `match` / `fixed` / `params`
// are what the stub had. `derived` holds AE props computed from several
// params (a point from two scalars, Mosaic blocks from size and the comp);
// those are static — when a param they read is keyed the scene walk samples
// them per frame or routes the node to shader. `then` lists further effects
// on the same layer after the main one, `before` ones ahead of it (a Levels
// that re-bins Posterize's input…). `aeEffectsFor` builds the whole list.

export interface AeEffectContext {
  // Composition size in px (toolbox radii are px at the working resolution).
  width: number;
  height: number;
  bitsPerChannel: 8 | 16 | 32;
  // Composition frame rate (Echo's time is in seconds).
  fps?: number;
}

export interface AeParamMap {
  // AE property match name on the effect, e.g. "ADBE Gaussian Blur 2-0001".
  prop: string;
  kind: "scalar" | "color" | "point" | "enum" | "bool" | "layer";
  // Static value → AE value.
  map(value: unknown, ctx: AeEffectContext): unknown;
  // Set when `map` is affine in a scalar (ae = scale·v + offset), so a keyed
  // track converts by mapping each key's value and scaling its speeds.
  linear?: (ctx: AeEffectContext) => { scale: number; offset: number };
}

// An AE property computed from several toolbox params (static values).
export interface AeDerivedProp {
  prop: string;
  kind: AeParamMap["kind"];
  // Toolbox params it reads.
  from: string[];
  map(values: Record<string, unknown>, ctx: AeEffectContext): unknown;
}

// A layer param: the AE layer that renders the node's input `socket`. The
// scene walk resolves it to an AeLayerRef.
export interface AeInputLayer {
  input: string;
}

export interface AeEffectStep {
  // AE effect match name.
  match: string;
  // Properties set to fixed values whatever the node's params (match name → value).
  fixed?: Record<string, unknown>;
  // Toolbox param name → AE property.
  params?: Record<string, AeParamMap>;
  derived?: AeDerivedProp[];
}

export interface AeEffectMap extends AeEffectStep {
  // Toolbox node type.
  type: string;
  params: Record<string, AeParamMap>;
  // Further effects on the same layer, applied before / after this one.
  before?: AeEffectStep[];
  then?: AeEffectStep[];
  // Only export through this map when the node's params satisfy this; else
  // the node goes to `shader` (e.g. blur in a non-Gaussian mode). `ctx` is
  // optional: without it, comp-dependent conditions are not checked.
  applies?: (values: Record<string, unknown>, ctx?: AeEffectContext) => boolean;
  // Why `applies` refused, for the plan report (undefined when it applies).
  refusal?: (values: Record<string, unknown>, ctx?: AeEffectContext) => string | undefined;
  // Project settings the measured numbers depend on.
  project?: { linearizeWorkingSpace?: boolean };
  // Other AE forms of the same node, tried after this one when it refuses
  // (sharpen's box kernel → Sharpen, its unsharp mode → Unsharp Mask).
  variants?: AeEffectMap[];
  fidelity: "exact" | "approx";
  // Measured worst error and how it was measured.
  note?: string;
  // Worst measured compareRgba numbers where `applies` holds (0–1 units),
  // and what they were measured on.
  error?: { meanAbs: number; p95Abs: number; maxAbs: number; on: string };
  measured: boolean;
}

// ---- helpers -------------------------------------------------------------------

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const hex = (v: unknown): [number, number, number, number] => {
  const s = str(v, "#000000").replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/./g, "$&$&") : s;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), full.length >= 8 ? n(6) : 1];
};
// canvas01 (Y-down, width-relative about the vertical centre) → comp px.
const pxX = (x: number, c: AeEffectContext) => x * c.width;
const pxY = (y: number, c: AeEffectContext) => c.height / 2 + (y - 0.5) * c.width;
const scalar = (prop: string, scale = 1, offset = 0): AeParamMap => ({
  prop,
  kind: "scalar",
  map: (v) => scale * num(v, 0) + offset,
  linear: () => ({ scale, offset }),
});
// A float curve that is the identity: every point on y = x.
const identityCurve = (pts: unknown): boolean =>
  !Array.isArray(pts) ||
  pts.every((p) => {
    const x = Array.isArray(p) ? p[0] : (p as { x?: number })?.x;
    const y = Array.isArray(p) ? p[1] : (p as { y?: number })?.y;
    return typeof x === "number" && typeof y === "number" && Math.abs(x - y) < 1e-6;
  });
const firstOff = (values: Record<string, unknown>, want: Record<string, number>): string | undefined => {
  for (const [k, v] of Object.entries(want)) if (Math.abs(num(values[k], v) - v) > 1e-9) return k;
  return undefined;
};
// The first reason whose condition holds.
const firstReason = (checks: [boolean, string][]): string | undefined => checks.find(([bad]) => bad)?.[1];

// ---- the maps --------------------------------------------------------------------

// Gaussian Blur 2 blurs in LINEAR light (pure power γ 2.404, measured), so it
// stands in for toolbox's default `linearize: on`; σ_AE = B/3.50, σ_toolbox =
// radius/2 → Blurriness = 1.7464·radius. Toolbox caps its kernel at 64 taps
// (radius 128/3 ≈ 42.67); AE does not.
export const BLUR_BLURRINESS_PER_RADIUS = 1.746349;
export const BLUR_MAX_RADIUS = 128 / 3;
const blurRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [str(values.mode, "gaussian") !== "gaussian", `mode ${str(values.mode, "gaussian")} has no AE twin (Gaussian only)`],
    [values.linearize === false, "linearize off: Gaussian Blur 2 always blurs in linear light (γ 2.4); the obsolete Gaussian Blur has no Repeat Edge Pixels"],
    [num(values.radius, 0) > BLUR_MAX_RADIUS, `radius ${num(values.radius, 0)} px is past toolbox's 64-tap cap (${BLUR_MAX_RADIUS.toFixed(2)} px); AE's kernel keeps growing`],
  ]);
const blurMap = (type: string): AeEffectMap => ({
  type,
  match: "ADBE Gaussian Blur 2",
  fixed: {
    "ADBE Gaussian Blur 2-0002": 1, // Blur Dimensions: horizontal and vertical
    "ADBE Gaussian Blur 2-0003": 1, // Repeat Edge Pixels: on (toolbox clamps to edge)
  },
  params: { radius: scalar("ADBE Gaussian Blur 2-0001", BLUR_BLURRINESS_PER_RADIUS) },
  applies: (values) => blurRefusal(values) === undefined,
  refusal: blurRefusal,
  project: { linearizeWorkingSpace: false },
  fidelity: "approx",
  note:
    "Blurriness = 1.7464·radius (σ_AE = B/3.50 in linear light, σ_toolbox = r/2; R² 0.999999996 over r 2–42). Matches linearize on: toolbox decodes piecewise sRGB, AE a pure 2.404 power, so fine mixed detail (a 1-px grid) sits up to 0.033 brighter in AE; noise and soft content ≤ 0.002 mean. Never in a linearized working space: Gaussian Blur 2 then linearizes twice (γ ≈ 5.4).",
  error: { meanAbs: 0.0333, p95Abs: 0.051, maxAbs: 0.111, on: "disc / 1-px grid / noise / transparent disc, r 1–42, 8 and 16 bpc" },
  measured: true,
});

// Toolbox's cell in px: size·aspect wide, size tall.
const pixelCell = (v: Record<string, unknown>): [number, number] => {
  const size = Math.max(1, num(v.size, 16));
  return [size * Math.max(0.01, num(v.aspect, 1)), size];
};
// Toolbox's grid starts at the bottom-left with partial cells at the right
// and top; Mosaic spreads whole blocks over the layer from the top-left. They
// line up only when the cells divide the comp.
const divides = (n: number, d: number) => Math.abs(n / d - Math.round(n / d)) < 1e-6;
const pixelateRefusal = (values: Record<string, unknown>, ctx?: AeEffectContext) => {
  if (str(values.shape, "square") !== "square") return "circle cells have no Mosaic form";
  const [cw, ch] = pixelCell(values);
  if (ctx && !(divides(ctx.width, cw) && divides(ctx.height, ch))) return `${cw}×${ch} px cells do not divide the ${ctx.width}×${ctx.height} comp (toolbox's grid starts bottom-left with partial cells, Mosaic's spreads whole blocks)`;
  return undefined;
};
const transformRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [values.tile === true, "tiling (repeat / unfold) has no Transform-effect form"],
    [values.legacySkew === true, "legacySkew rotates in height-relative space (shears on non-square comps)"],
  ]);
const mirrorRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [str(values.mode, "x") !== "bisect", `mode ${str(values.mode, "x")}: AE's Mirror reflects one side onto the other (toolbox's bisect); x / y / both / radial composite copies over the source`],
    [values.includeSource === false, "Keep source off draws only the reflected half"],
  ]);
// Mirror's Reflection Angle per toolbox bisect side (measured: the kept side).
const MIRROR_ANGLE: Record<string, number> = { "-x": 0, x: 180, y: 270, "-y": 90 };
const DISPLACE_CHANNEL: Record<string, number> = { r: 1, g: 2, b: 3, a: 4, luminance: 5 };
const displaceRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [Math.abs(num(values.midlevel, 0.5) - 0.5) > 1e-9, "midlevel ≠ 0.5: Displacement Map's neutral grey is fixed at 0.5"],
    [values.rotate === true, "rotate has no Displacement Map form"],
    [str(values.wrap, "clamp") === "mirror", "mirror edges have no Displacement Map form"],
  ]);
export const BLOOM_INTENSITY = 3;
const bloomRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [num(values.tint_amount, 0) > 0, "tinted bloom has no Glow form here"],
    [Math.abs(num(values.anamorphic, 0)) > 1e-9, "anamorphic bloom has no Glow form"],
  ]);
export const GRAIN_INTENSITY_PER_LUMINANCE = 8.67;
const grainRefusal = (values: Record<string, unknown>) => {
  const off: [boolean, string][] = [
    [str(values.preset, "custom") !== "custom", `preset ${str(values.preset, "custom")}: only the custom fine model has an Add Grain form`],
    [str(values.model, "fine") !== "fine", `model ${str(values.model, "fine")} has no Add Grain form (fine only)`],
    [num(values.scale, 1) !== 1 || str(values.size_unit, "px") !== "px", "grain cells other than 1 px (Add Grain's Size does not scale toolbox's cells)"],
    [num(values.chromatic, 0) > 0, "chromatic grain"],
    [str(values.mix_mode, "overlay") !== "overlay" || num(values.mix, 1) !== 1, "only overlay at full mix is Add Grain's Overlay blend"],
    [num(values.tint_amount, 0) > 0 || values.soft_clip === true || values.per_channel === true, "tint / soft clip / per-channel grain"],
    [str(values.response_preset, "flat") !== "flat" || str(values.space, "display") !== "display", "a response curve or a linear / log grain space"],
    [num(values.smoothness, 0) > 0 || num(values.drift, 0) > 0 || num(values.aspect, 1) !== 1, "smoothed, drifting or stretched grain"],
    [str(values.motion, "animated") === "looping" || (str(values.motion, "animated") === "animated" && num(values.rate, 0) !== 0), "grain on its own rate or looping"],
    [str(values.view, "result") !== "result", "the grain-only view"],
  ];
  return off.find(([bad]) => bad)?.[1];
};
const contrastToLegacy = (k: number) => (k >= 1 ? 100 * (1 - 1 / k) : 100 * (k - 1));
const colorCorrectionRefusal = (values: Record<string, unknown>) => {
  if (Math.abs(num(values.saturation, 1) - 1) > 1e-9) return "saturation: toolbox scales HSV saturation, Hue/Saturation's is HSL-based (measured off)";
  const wheels: Record<string, number> = { temp: 0, tint: 0, md: 0, boffset: 0, pivot: 0.5 };
  for (const w of ["dark", "shadow", "light", "global"]) Object.assign(wheels, { [`${w}X`]: 0, [`${w}Y`]: 0, [`${w}Lum`]: 0, [`${w}Exp`]: 0, [`${w}Sat`]: 1 });
  const off = firstOff(values, wheels);
  if (off) return `${off}: the wheels / white balance / pivot have no Hue/Saturation or Brightness & Contrast form`;
  const curves = values.curves as Record<string, unknown> | undefined;
  if (curves && !["rgb", "r", "g", "b"].every((ch) => identityCurve(curves[ch]))) return "RGB curves (Curves is not scriptable)";
  if (Math.abs(num(values.brightness, 0)) > 150 / 255) return "brightness past Brightness & Contrast's ±150";
  return undefined;
};
export const SHARPEN_AMOUNT_PER_BOX = 50;
const arrayRefusal = (values: Record<string, unknown>) => {
  if (str(values.mode, "image") !== "image") return "spline / point mode is a Repeater (vector), not an effect";
  const fit = str(values.sizeMode, "fit") === "fit";
  const cx = Math.max(1, Math.floor(num(values.countX, 3)));
  const cy = Math.max(1, Math.floor(num(values.countY, 3)));
  if (!fit && (cx * num(values.sizeW, 0.333) < 1 - 1e-9 || cy * num(values.sizeH, 0.333) < 1 - 1e-9)) return "a step grid smaller than the frame leaves toolbox's outside transparent; Motion Tile tiles on";
  const off = firstOff(values, { patternOffsetX: 0, patternOffsetY: 0, localX: 0, localY: 0, localRotate: 0, localScaleX: 1, localScaleY: 1 });
  if (off) return `${off}: per-copy offsets / rotation / scale have no Motion Tile form`;
  return undefined;
};
// Tile (0, 0) of toolbox's grid (bottom-left, Y-up) in comp px; Motion Tile
// repeats from any tile centre.
const arrayTile = (v: Record<string, unknown>, c: AeEffectContext): { w: number; h: number } => {
  const fit = str(v.sizeMode, "fit") === "fit";
  return {
    w: fit ? 1 / Math.max(1, Math.floor(num(v.countX, 3))) : num(v.sizeW, 0.333),
    h: fit ? 1 / Math.max(1, Math.floor(num(v.countY, 3))) : num(v.sizeH, 0.333),
  };
  void c;
};
// Echoes until the oldest is under half an 8-bit step.
export const TRAILS_MAX_ECHOES = 255;
const trailsEchoes = (decay: number) => (decay <= 0 ? 0 : Math.min(TRAILS_MAX_ECHOES, Math.ceil(Math.log(0.5 / 255) / Math.log(decay))));
const trailsRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [str(values.mode, "feedback") === "ring", "ring mode holds frames (stop motion) — no Echo form"],
    [str(values.mode, "feedback") === "velocity", "velocity mode smears along a vector — no Echo form"],
    [num(values.decay, 0.92) >= 1, "decay 1 never fades: Echo needs a finite echo count"],
  ]);
// Linear Color Key (RGB) keys on toolbox's own distance |ΔRGB|/√3, but its
// matte is linear in d² from tolerance (d² − tol²)/(softness%/150) where
// toolbox smoothsteps in d (measured): softness is set so both reach 1 at
// tol + soft.
export const KEYER_SOFTNESS_PER_D2 = 150;
const keyerRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [str(values.mode, "luma") !== "color", `mode ${str(values.mode, "luma")}: only the RGB-distance key is Linear Color Key's (chroma: its CbCr differs; luma: Extract measured off)`],
    [num(values.spill, 0) > 0, "despill has no Linear Color Key form"],
  ]);
const posterizeRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [str(values.channels, "rgb") !== "rgb", "luma mode has no Posterize form"],
    [Math.abs(num(values.gamma, 1) - 1) > 1e-9, "gamma ≠ 1 has no Posterize knob"],
  ]);
const thresholdRefusal = (values: Record<string, unknown>) =>
  firstReason([
    [num(values.softness, 0) > 0, "softness has no Threshold knob"],
    [values.invert === true, "invert needs a second effect"],
  ]);

export const AE_EFFECT_MAPS: Record<string, AeEffectMap> = {
  blur: blurMap("blur"),
  // The legacy node is the same def; its saves migrate to linearize off, so
  // most of them refuse and go to shader.
  "gaussian-blur": blurMap("gaussian-blur"),
  pixelate: {
    type: "pixelate",
    match: "ADBE Mosaic",
    // Sharp Colors off: AE averages each block; toolbox samples the cell
    // centre (bilinear). Sharp Colors on takes the block's bottom-right pixel
    // (measured) — further from toolbox's centre sample than the average.
    fixed: { "ADBE Mosaic-0003": 0 },
    params: {},
    derived: [
      { prop: "ADBE Mosaic-0001", kind: "scalar", from: ["size", "aspect"], map: (v, c) => c.width / pixelCell(v)[0] },
      { prop: "ADBE Mosaic-0002", kind: "scalar", from: ["size"], map: (v, c) => c.height / pixelCell(v)[1] },
    ],
    applies: (values, ctx) => pixelateRefusal(values, ctx) === undefined,
    refusal: pixelateRefusal,
    fidelity: "approx",
    note:
      "Mosaic (Sharp Colors off) averages each block where toolbox samples the cell centre: a look match whose error grows with cell size against the detail (noise: mean 0.022 at 16 px, 0.035 at 32). Sharp Colors on takes the block's bottom-right pixel (measured) — further off. Refuses cells that don't divide the comp (the grids start at opposite corners) and circle cells.",
    error: { meanAbs: 0.0351, p95Abs: 0.1059, maxAbs: 0.1322, on: "noise / colour sweep, cells 8–32 px, aspect 1–1.5, 8 and 16 bpc" },
    measured: true,
  },
  transform: {
    type: "transform",
    match: "ADBE Geometry2",
    fixed: {
      "ADBE Geometry2-0011": 0, // Uniform Scale off
      "ADBE Geometry2-0005": 0, // Skew
      "ADBE Geometry2-0008": 100, // Opacity
      "ADBE Geometry2-0009": 0, // Use Composition's Shutter Angle off
      "ADBE Geometry2-0010": 0, // Shutter Angle
    },
    params: {
      scaleX: { prop: "ADBE Geometry2-0004", kind: "scalar", map: (v) => 100 * Math.max(1e-4, num(v, 1)), linear: () => ({ scale: 100, offset: 0 }) },
      scaleY: { prop: "ADBE Geometry2-0003", kind: "scalar", map: (v) => 100 * Math.max(1e-4, num(v, 1)), linear: () => ({ scale: 100, offset: 0 }) },
      rotate: scalar("ADBE Geometry2-0007"),
    },
    derived: [
      { prop: "ADBE Geometry2-0001", kind: "point", from: ["pivotX", "pivotY"], map: (v, c) => [pxX(num(v.pivotX, 0.5), c), pxY(num(v.pivotY, 0.5), c)] },
      {
        prop: "ADBE Geometry2-0002",
        kind: "point",
        from: ["pivotX", "pivotY", "translateX", "translateY"],
        map: (v, c) => [pxX(num(v.pivotX, 0.5), c) + num(v.translateX, 0) * c.width, pxY(num(v.pivotY, 0.5), c) + num(v.translateY, 0) * c.width],
      },
    ],
    applies: (values) => transformRefusal(values) === undefined,
    refusal: transformRefusal,
    fidelity: "exact",
    note:
      "Transform effect, exact geometry: anchor = pivot px, position = pivot + translate px (canvas01 → px), Scale Width/Height ·100 %, Rotation ° (same order as toolbox: scale, rotate about the pivot, translate). The only differences are resampling and the edge: AE antialiases the layer's edge, toolbox cuts hard (the max is on those edge pixels; α mean ≤ 0.002). Refuses tiling and legacySkew; a wired transform input is the scene walk's to decompose.",
    error: { meanAbs: 0.0013, p95Abs: 0.0039, maxAbs: 0.3295, on: "noise / disc: translate, non-uniform scale, rotation, pivots, 8 and 16 bpc" },
    measured: true,
  },
  mirror: {
    type: "mirror",
    match: "ADBE Mirror",
    params: {},
    derived: [
      { prop: "ADBE Mirror-0001", kind: "point", from: ["centerX", "centerY"], map: (v, c) => [pxX(num(v.centerX, 0.5), c), pxY(num(v.centerY, 0.5), c)] },
      { prop: "ADBE Mirror-0002", kind: "scalar", from: ["keep"], map: (v) => MIRROR_ANGLE[str(v.keep, "x")] ?? 180 },
    ],
    applies: (values) => mirrorRefusal(values) === undefined,
    refusal: mirrorRefusal,
    fidelity: "approx",
    note:
      "Toolbox's bisect is AE's Mirror: Reflection Center = the line's point, Reflection Angle by the kept side (−x 0°, −y 90°, x 180°, y 270°, measured against all 16 pairings). Residual is resampling at the line. Refuses x / y / both / radial (copies composited over the source) and Keep source off.",
    error: { meanAbs: 0.0054, p95Abs: 0.0314, maxAbs: 0.0633, on: "noise / colour sweep, every bisect side, off-centre lines, 8 and 16 bpc" },
    measured: true,
  },
  displace: {
    type: "displace",
    match: "ADBE Displacement Map",
    fixed: {
      "ADBE Displacement Map-0006": 2, // Displacement Map Behavior: Stretch Map to Fit (toolbox samples the map at v_uv)
      "ADBE Displacement Map-0007": 0, // Edge Behavior: Wrap Pixels Around off → transparent past the edge
      "ADBE Displacement Map-0008": 0, // Expand Output off
    },
    params: {
      channelX: { prop: "ADBE Displacement Map-0002", kind: "enum", map: (v) => DISPLACE_CHANNEL[str(v, "r")] ?? 1 },
      channelY: { prop: "ADBE Displacement Map-0004", kind: "enum", map: (v) => DISPLACE_CHANNEL[str(v, "g")] ?? 2 },
      // Max displacement = the offset at map value 1 (AE: (v − 0.5)·2·max);
      // toolbox's Y is up.
      amountX: { prop: "ADBE Displacement Map-0003", kind: "scalar", map: (v, c) => (num(v, 0.05) * c.width) / 2, linear: (c) => ({ scale: c.width / 2, offset: 0 }) },
      amountY: { prop: "ADBE Displacement Map-0005", kind: "scalar", map: (v, c) => (-num(v, 0.05) * c.height) / 2, linear: (c) => ({ scale: -c.height / 2, offset: 0 }) },
    },
    derived: [{ prop: "ADBE Displacement Map-0001", kind: "layer", from: [], map: (): AeInputLayer => ({ input: "displacement" }) }],
    applies: (values) => displaceRefusal(values) === undefined,
    refusal: displaceRefusal,
    fidelity: "approx",
    note:
      "Displacement Map with the `displacement` input as a hidden layer, Stretch Map to Fit: Max Horizontal = amountX·W/2, Max Vertical = −amountY·H/2 (toolbox's Y is up; AE offsets by (v − 0.5)·2·max). Wrap off = transparent past the edge, so toolbox's default clamp shows an alpha band there (α mean 0.016 at amount 0.05, 0.058 at 0.2); the luminance channel's weights differ slightly. AE reads the map layer's source: precompose a map with effects. Refuses midlevel ≠ 0.5, rotate and mirror edges.",
    error: { meanAbs: 0.0078, p95Abs: 0.0353, maxAbs: 0.1079, on: "noise / colour sweep by a noise map, every channel, amounts 0.04–0.2, 8 and 16 bpc" },
    measured: true,
  },
  bloom: {
    type: "bloom",
    match: "ADBE Glo2",
    fixed: { "ADBE Glo2-0001": 2 }, // Glow Based On: Color Channels
    params: {
      threshold: { prop: "ADBE Glo2-0002", kind: "scalar", map: (v) => Math.min(255, Math.max(0, 255 * num(v, 0.7))), linear: () => ({ scale: 255, offset: 0 }) },
      intensity: scalar("ADBE Glo2-0004", BLOOM_INTENSITY),
    },
    // Toolbox's pyramid reaches ~2^(levels+1) px whatever the quality (the
    // base mip shrinks as the level count is cut).
    derived: [{ prop: "ADBE Glo2-0003", kind: "scalar", from: ["levels"], map: (v) => 2 ** (Math.max(1, Math.min(8, Math.round(num(v.levels, 6)))) + 1) }],
    applies: (values) => bloomRefusal(values) === undefined,
    refusal: bloomRefusal,
    fidelity: "approx",
    note:
      "Glow on color channels — a look match: Glow Radius = 2^(levels + 1) px (toolbox's mip pyramid reaches about that at any quality), Intensity = 3·intensity, Threshold = 255·threshold. Toolbox's soft knee, max-channel threshold and unclamped add differ (toolbox can exceed 1; the max is clamped to 0–1). Refuses tint and anamorphic.",
    error: { meanAbs: 0.0284, p95Abs: 0.1686, maxAbs: 0.6706, on: "bright disc + dots over dim noise, levels 4–6, intensity 0.5–2, threshold 0.5–0.7, 8 and 16 bpc" },
    measured: true,
  },
  grain: {
    type: "grain",
    match: "VISINF Grain Implant",
    fixed: {
      "VISINF Grain Implant-0021": 3, // Viewing Mode: Final Output (the default previews a box)
      "VISINF Grain Implant-0014": 5, // Blending Mode 5: toolbox's overlay response (measured per luminance band)
      "VISINF Grain Implant-0005": 1, // Monochromatic (chromatic 0)
      "VISINF Grain Implant-0007": 1, // Size
      "VISINF Grain Implant-0130": 0, // Softness
      "VISINF Grain Implant-0030": 1, // Aspect Ratio
    },
    params: {
      luminance: scalar("VISINF Grain Implant-0008", GRAIN_INTENSITY_PER_LUMINANCE),
      seed: { prop: "VISINF Grain Implant-0013", kind: "scalar", map: (v) => Math.max(0, Math.round(num(v, 0))) },
    },
    derived: [{ prop: "VISINF Grain Implant-0039", kind: "scalar", from: ["motion"], map: (v) => (str(v.motion, "animated") === "static" ? 0 : 1) }],
    applies: (values) => grainRefusal(values) === undefined,
    refusal: grainRefusal,
    fidelity: "approx",
    note:
      "Add Grain, Blending Mode 5 (toolbox's overlay response, measured per luminance band; mode 1 grains shadows ten times harder), monochromatic, Viewing Mode Final Output, Intensity = 8.67·luminance: the per-band std of (out − in) is within 4% of toolbox's and both are white at 1 px, but the random field differs — the pixel numbers below are noise against noise. Only the custom fine model at 1 px, overlay at full mix, no chroma / tint / response / smoothing / drift, project-rate or static motion.",
    error: { meanAbs: 0.0423, p95Abs: 0.1333, maxAbs: 0.4198, on: "grey ramp / flat grey — pixels (a different random field; per-band std within 4%, both white)" },
    measured: true,
  },
  "color-correction": {
    type: "color-correction",
    match: "ADBE HUE SATURATION",
    // Toolbox grades brightness and pivoted contrast before its HSV hue, so
    // Brightness & Contrast (legacy: the linear forms, measured) goes first.
    before: [
      {
        match: "ADBE Brightness & Contrast 2",
        fixed: { "ADBE Brightness & Contrast 2-0003": 1 }, // Use Legacy
        params: {
          brightness: scalar("ADBE Brightness & Contrast 2-0001", 255),
          // Legacy contrast c scales about 0.5 by 1/(1 − c/100) for c ≥ 0 and
          // by 1 + c/100 below (measured).
          contrast: { prop: "ADBE Brightness & Contrast 2-0002", kind: "scalar", map: (v) => contrastToLegacy(num(v, 1)) },
        },
      },
    ],
    fixed: { "ADBE HUE SATURATION-0002": 1, "ADBE HUE SATURATION-0007": 0 }, // Channel Control: Master; Colorize off
    params: { hue: scalar("ADBE HUE SATURATION-0004") },
    applies: (values) => colorCorrectionRefusal(values) === undefined,
    refusal: colorCorrectionRefusal,
    fidelity: "approx",
    note:
      "Brightness & Contrast (Use Legacy) then Hue/Saturation, in toolbox's order: Brightness = 255·b; legacy contrast scales about 0.5 by 1/(1 − c/100) for c ≥ 0 and 1 + c/100 below (measured), so c = 100(1 − 1/k) or 100(k − 1); Master Hue = hue ° (both rotate HSV hue). Refuses saturation ≠ 1 (toolbox scales HSV saturation, Master Saturation is HSL-based: measured off), the wheels, temp / tint, pivot ≠ 0.5, midtone detail, black offset and the curves.",
    error: { meanAbs: 0.0093, p95Abs: 0.0118, maxAbs: 0.0133, on: "colour sweep / noise: hue, brightness, contrast 0.8–2 and all three, 8 and 16 bpc" },
    measured: true,
  },
  sharpen: {
    type: "sharpen",
    match: "ADBE Sharpen",
    params: { amount: scalar("ADBE Sharpen-0001", SHARPEN_AMOUNT_PER_BOX) },
    applies: (values) => str(values.algorithm, "box") === "box",
    refusal: (values) => (str(values.algorithm, "box") === "box" ? undefined : `${str(values.algorithm, "box")} kernel is not Sharpen's (Sharpen is toolbox's box Laplacian)`),
    fidelity: "approx",
    note:
      "Toolbox's box kernel (c + amount·(4c − n − s − e − w)) is Sharpen at Amount = 50·amount: mean 0.003, max 0.023 with a 2-px border left out; the outermost pixels differ (the max below, 0.62), AE pads the frame differently. diamond and cross have no Sharpen form (measured off); unsharp is the Unsharp Mask variant.",
    error: { meanAbs: 0.0076, p95Abs: 0.0118, maxAbs: 0.6196, on: "noise / disc, box amount 1–2, frame edge included, 8 and 16 bpc" },
    measured: true,
    variants: [
      {
        type: "sharpen",
        match: "ADBE Unsharp Mask2",
        // toolbox's unsharp = original + amount·(original − binomial 3×3);
        // Unsharp Mask at radius 0.5 is that kernel (measured).
        fixed: { "ADBE Unsharp Mask2-0002": 0.5, "ADBE Unsharp Mask2-0003": 0 },
        params: { amount: scalar("ADBE Unsharp Mask2-0001", 100) },
        applies: (values) => str(values.algorithm, "box") === "unsharp",
        refusal: (values) => (str(values.algorithm, "box") === "unsharp" ? undefined : "only the unsharp kernel is Unsharp Mask's"),
        fidelity: "exact",
        note: "Exact: toolbox's unsharp is original + amount·(original − binomial 3×3), which is Unsharp Mask at Radius 0.5, Threshold 0, Amount = 100·amount.",
        error: { meanAbs: 0.0014, p95Abs: 0.0039, maxAbs: 0.0067, on: "noise / disc, unsharp amount 1–3, 8 and 16 bpc" },
        measured: true,
      },
    ],
  },
  array: {
    type: "array",
    match: "ADBE Tile",
    fixed: { "ADBE Tile-0004": 100, "ADBE Tile-0005": 100, "ADBE Tile-0006": 0, "ADBE Tile-0007": 0, "ADBE Tile-0008": 0 },
    params: {},
    derived: [
      {
        prop: "ADBE Tile-0001",
        kind: "point",
        from: ["sizeMode", "countX", "countY", "sizeW", "sizeH"],
        map: (v, c) => {
          const t = arrayTile(v, c);
          return [(t.w * c.width) / 2, c.height - (t.h * c.height) / 2];
        },
      },
      { prop: "ADBE Tile-0002", kind: "scalar", from: ["sizeMode", "countX", "sizeW"], map: (v, c) => 100 * arrayTile(v, c).w },
      { prop: "ADBE Tile-0003", kind: "scalar", from: ["sizeMode", "countY", "sizeH"], map: (v, c) => 100 * arrayTile(v, c).h },
    ],
    applies: (values) => arrayRefusal(values) === undefined,
    refusal: arrayRefusal,
    fidelity: "approx",
    note:
      "Image mode is Motion Tile: Tile Width/Height = 100/count % (100·sizeW / sizeH in step mode), Tile Center = the centre of toolbox's bottom-left tile (Motion Tile repeats from any tile), output 100 %. Residual is resampling (toolbox samples without mipmaps); 2×2 is exact. Refuses a step grid that doesn't cover the frame, offsets and per-copy TRS; the scene walk must also check the modulator inputs are unwired.",
    error: { meanAbs: 0.0134, p95Abs: 0.0353, maxAbs: 0.75, on: "noise / transparent disc, fit 2×4 … 5×2 and a covering step grid, 8 and 16 bpc" },
    measured: true,
  },
  trails: {
    type: "trails",
    match: "ADBE Echo",
    fixed: {
      "ADBE Echo-0003": 1, // Starting Intensity
      "ADBE Echo-0005": 5, // Echo Operator: Composite In Back (the current frame over its echoes)
    },
    params: { decay: { prop: "ADBE Echo-0004", kind: "scalar", map: (v) => Math.min(1, Math.max(0, num(v, 0.92))) } },
    derived: [
      { prop: "ADBE Echo-0001", kind: "scalar", from: [], map: (v, c) => -1 / (c.fps ?? 30) },
      { prop: "ADBE Echo-0002", kind: "scalar", from: ["decay"], map: (v) => trailsEchoes(Math.min(1, Math.max(0, num(v.decay, 0.92)))) },
    ],
    applies: (values) => trailsRefusal(values) === undefined,
    refusal: trailsRefusal,
    fidelity: "approx",
    note:
      "Feedback mode is Echo, Composite In Back: Echo Time −1/fps, Decay = decay, Starting Intensity 1, echoes until decay^n < 0.5/255 (n = ⌈ln(0.5/255)/ln decay⌉, 75 at 0.92). Colours exact at 16 bpc; alpha differs by the truncated tail and Echo's own compounding (≤ 0.019 mean). Echo reads the layer's source frames, ignoring effects before it: the trails input must be a precomp. Refuses ring (stop-motion hold), velocity and decay 1.",
    error: { meanAbs: 0.0079, p95Abs: 0.051, maxAbs: 0.0501, on: "a disc moving over 16 frames, decay 0.5 / 0.8 / 0.92, frames 5 / 10 / 15, 8 and 16 bpc" },
    measured: true,
  },
  keyer: {
    type: "keyer",
    match: "ADBE Linear Color Key2",
    fixed: { "ADBE Linear Color Key2-0002": 1, "ADBE Linear Color Key2-0004": 1, "ADBE Linear Color Key2-0007": 1 }, // View Final Output, Using RGB, Key Colors
    params: {
      key_color: { prop: "ADBE Linear Color Key2-0003", kind: "color", map: (v) => hex(v) },
      tolerance: scalar("ADBE Linear Color Key2-0005", 100),
    },
    derived: [
      {
        prop: "ADBE Linear Color Key2-0006",
        kind: "scalar",
        from: ["tolerance", "softness"],
        map: (v) => {
          const t = Math.max(0, num(v.tolerance, 0.2));
          const s = Math.max(0, num(v.softness, 0.1));
          return Math.min(100, KEYER_SOFTNESS_PER_D2 * ((t + s) ** 2 - t * t));
        },
      },
    ],
    applies: (values) => keyerRefusal(values) === undefined,
    refusal: keyerRefusal,
    fidelity: "approx",
    note:
      "Color mode is Linear Color Key, Using RGB, Key Colors: AE keys on toolbox's own distance |ΔRGB|/√3, but its matte is linear in d² from tolerance — (d² − tol²)/(softness%/150), measured — where toolbox smoothsteps in d; Softness = 150·((tol + soft)² − tol²) makes both reach 1 at tol + soft (exact for a hard key; larger softness is worse). Refuses chroma (AE's chroma metric ≠ toolbox's CbCr), luma (Extract measured off), sample mode and despill.",
    error: { meanAbs: 0.0006, p95Abs: 0.0039, maxAbs: 0.0316, on: "colour sweep, green / blue / orange keys, tolerance 0.1–0.3, softness 0–0.2, 8 and 16 bpc" },
    measured: true,
  },
  posterize: {
    type: "posterize",
    match: "ADBE Posterize",
    // AE bins at floor(v·L)/(L − 1), toolbox at round(v·(L − 1))/(L − 1)
    // (measured): a Levels output range of [0.5/L, (L − 0.5)/L] first makes
    // AE's floor land on toolbox's rounding.
    before: [
      {
        match: "ADBE Easy Levels2",
        fixed: { "ADBE Easy Levels2-0001": 1, "ADBE Easy Levels2-0003": 0, "ADBE Easy Levels2-0004": 1, "ADBE Easy Levels2-0005": 1 },
        derived: [
          { prop: "ADBE Easy Levels2-0006", kind: "scalar", from: ["levels"], map: (v) => 0.5 / Math.max(2, Math.round(num(v.levels, 6))) },
          { prop: "ADBE Easy Levels2-0007", kind: "scalar", from: ["levels"], map: (v) => 1 - 0.5 / Math.max(2, Math.round(num(v.levels, 6))) },
        ],
      },
    ],
    params: { levels: { prop: "ADBE Posterize-0001", kind: "scalar", map: (v) => Math.max(2, Math.round(num(v, 6))) } },
    applies: (values) => posterizeRefusal(values) === undefined,
    refusal: posterizeRefusal,
    fidelity: "approx",
    note:
      "Exact: AE's Posterize bins at floor(v·L)/(L − 1), toolbox rounds; a Levels whose output is [0.5/L, (L − 0.5)/L] first makes the floor land on the rounding. Refuses gamma ≠ 1 and luma mode.",
    error: { meanAbs: 0.0003, p95Abs: 0.0039, maxAbs: 0.0022, on: "ramp / noise, L 2–32, 8 and 16 bpc" },
    measured: true,
  },
  threshold: {
    type: "threshold",
    match: "ADBE Threshold2",
    // AE's Threshold reads Rec.601 luma, toolbox's Rec.709 (measured): a
    // monochrome Channel Mixer with the 709 weights first hands it 709 grey.
    before: [
      {
        match: "ADBE CHANNEL MIXER",
        fixed: {
          "ADBE CHANNEL MIXER-0001": 21.26,
          "ADBE CHANNEL MIXER-0002": 71.52,
          "ADBE CHANNEL MIXER-0003": 7.22,
          "ADBE CHANNEL MIXER-0004": 0,
          "ADBE CHANNEL MIXER-0013": 1, // Monochrome
        },
      },
    ],
    params: { threshold: scalar("ADBE Threshold2-0001") },
    applies: (values) => thresholdRefusal(values) === undefined,
    refusal: thresholdRefusal,
    fidelity: "approx",
    note:
      "AE's Threshold reads Rec.601 luma (0 wrong pixels in 98k with 601 weights, 7% with 709); a monochrome Channel Mixer with the 709 weights first hands it toolbox's luma. Level is 0–1. Only pixels lying on the threshold differ (the max; ≤ 0.5% of pixels). Refuses softness and invert.",
    error: { meanAbs: 0.0052, p95Abs: 0, maxAbs: 1, on: "colour sweep / ramp, threshold 0.2–0.75, 8 and 16 bpc" },
    measured: true,
  },
};

export function aeEffectMap(type: string): AeEffectMap | undefined {
  return AE_EFFECT_MAPS[type];
}

// The map that applies to a node's values (its own, else the first variant
// that does), or why none does. Prefer this to aeEffectMap + applies.
export function resolveAeEffectMap(
  type: string,
  values: Record<string, unknown>,
  ctx?: AeEffectContext
): { map: AeEffectMap } | { refusal: string } | undefined {
  const top = AE_EFFECT_MAPS[type];
  if (!top) return undefined;
  const reasons: string[] = [];
  for (const m of [top, ...(top.variants ?? [])]) {
    if (!m.applies || m.applies(values, ctx)) return { map: m };
    reasons.push(m.refusal?.(values, ctx) ?? `${m.match} does not apply`);
  }
  return { refusal: reasons.join("; ") };
}

export interface AeEffectInstance {
  match: string;
  // Match name → AE value; layer params come back as AeInputLayer.
  props: Record<string, unknown>;
}

// The AE effects (in order) for a node's static param values. Callers check
// `applies` first.
export function aeEffectsFor(map: AeEffectMap, values: Record<string, unknown>, ctx: AeEffectContext): AeEffectInstance[] {
  const step = (s: AeEffectStep): AeEffectInstance => {
    const props: Record<string, unknown> = { ...(s.fixed ?? {}) };
    for (const [param, pm] of Object.entries(s.params ?? {})) props[pm.prop] = pm.map(values[param], ctx);
    for (const d of s.derived ?? []) props[d.prop] = d.map(values, ctx);
    return { match: s.match, props };
  };
  return [...(map.before ?? []).map(step), step(map), ...(map.then ?? []).map(step)];
}

export { hex as aeHexColor, pxX as canvasXToPx, pxY as canvasYToPx };
