// Effect-class parameter maps (spec §3 rung 2, §11.8): toolbox node params →
// the AE built-in effect's properties, with the unit rule and how well it
// matches. The scene walk reads these; the calibration lane measures them in
// AE 26.5 and replaces the placeholders.
//
// CONTRACT STUB — committed before wave 2. Every map with `measured: false`
// is a placeholder the scene walk may use but must report as "approx,
// uncalibrated".

export interface AeEffectContext {
  // Composition size in px (toolbox radii are px at the working resolution).
  width: number;
  height: number;
  bitsPerChannel: 8 | 16 | 32;
}

export interface AeParamMap {
  // AE property match name on the effect, e.g. "ADBE Gaussian Blur 2-0001".
  prop: string;
  kind: "scalar" | "color" | "point" | "enum" | "bool";
  // Static value → AE value.
  map(value: unknown, ctx: AeEffectContext): unknown;
  // Set when `map` is affine in a scalar (ae = scale·v + offset), so a keyed
  // track converts by mapping each key's value and scaling its speeds.
  linear?: (ctx: AeEffectContext) => { scale: number; offset: number };
}

export interface AeEffectMap {
  // Toolbox node type.
  type: string;
  // AE effect match name.
  match: string;
  // Properties set to fixed values whatever the node's params (match name → value).
  fixed?: Record<string, unknown>;
  // Toolbox param name → AE property.
  params: Record<string, AeParamMap>;
  // Only export through this map when the node's params satisfy this; else
  // the node goes to `shader` (e.g. blur in a non-Gaussian mode).
  applies?: (values: Record<string, unknown>) => boolean;
  fidelity: "exact" | "approx";
  // Measured worst error and how it was measured.
  note?: string;
  measured: boolean;
}

export const AE_EFFECT_MAPS: Record<string, AeEffectMap> = {
  blur: {
    type: "blur",
    match: "ADBE Gaussian Blur 2",
    fixed: { "ADBE Gaussian Blur 2-0003": 1 }, // Repeat Edge Pixels: on (toolbox clamps to edge)
    params: {
      radius: {
        prop: "ADBE Gaussian Blur 2-0001", // Blurriness
        kind: "scalar",
        map: (v) => Number(v) || 0,
        linear: () => ({ scale: 1, offset: 0 }),
      },
    },
    applies: (values) => (values.mode ?? "gaussian") === "gaussian",
    fidelity: "approx",
    note: "PLACEHOLDER Blurriness = radius px — not yet calibrated against AE 26.5",
    measured: false,
  },
};

export function aeEffectMap(type: string): AeEffectMap | undefined {
  return AE_EFFECT_MAPS[type];
}
