// bundleFromGlslExpression — a GLSL Expression node's params → the `.tbxfx`
// bundle the Toolbox Shader host loads (AeShaderBundle, ABI.md).
//
// The channel list comes from the node's own template: glslExpressionSource
// declares one uniform per channel glslChannels keeps, so matching
// params.inputs against the uniforms the generated source declares is the
// node's filter exactly, with no copy of it here. Then, in channel order:
//   scalar → slider slot, toggle → checkbox slot, color → color slot,
//   pick   → `constant int <name> = <index>` baked into the MSL,
//   ramp / curve → a CHANNEL_LUT_SIZE × 1 LUT from the node's own bakers
//                  (buildRampLut / buildCurveLut), bound to l0…l7 in order.

import {
  buildCurveLut,
  buildRampLut,
  CHANNEL_LUT_SIZE,
  channelKind,
  channelParamDef,
  channelRangeOverride,
  readChannelValue,
  type ExprChannelValue,
} from "@/engine/expr-channels";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { CurvePoint } from "@/engine/float-curve";
import type { ExprInput } from "@/engine/types";
import { glslExpressionPreludeLines, glslExpressionSource } from "@/nodes/effect/glsl-expression";
import {
  TBX_SHADER_BUNDLE_VERSION,
  TBX_SHADER_POOL,
  type AeShaderBundle,
  type AeShaderParam,
} from "../types";
import { bundleId, f32 } from "./tbxfx";
import { glslToMsl, listGlslUniforms, type GlslError, type MslBinding } from "./translate";

// The host version that first speaks MSL ABI v1. A bundle never needs less.
export const TBX_SHADER_HOST_MIN = "1.0.0";

export interface BundleOptions {
  name: string;
  fps: number;
  loopFrames: number;
  canvas: { width: number; height: number };
  hostMin?: string;
  // Channel values that win over the rows (a wired channel's current value,
  // by channel name) — the node's own rule, readChannelValues.
  values?: Record<string, ExprChannelValue>;
}

export type BundleResult =
  | { ok: true; bundle: AeShaderBundle; warnings: string[] }
  | {
      ok: false;
      errors: GlslError[];
      // Template lines before main()'s body (the node's get_shader_errors
      // convention): body line = line − preludeLines.
      preludeLines: number;
    };

type LutKind = "ramp" | "curve";

export function bundleFromGlslExpression(params: Record<string, unknown>, opts: BundleOptions): BundleResult {
  const glsl = glslExpressionSource(params);
  const preludeLines = glslExpressionPreludeLines(params);
  const refuse = (errors: GlslError[]): BundleResult => ({ ok: false, errors, preludeLines });

  const declared = listGlslUniforms(glsl);
  if (!declared.ok) return refuse(declared.errors);
  const uniformNames = new Set(declared.uniforms.map((u) => u.name));

  const rows = ((params.inputs as ExprInput[] | undefined) ?? []).filter((e) => {
    const k = channelKind(e);
    const u = k === "ramp" ? `u_ramp_${e.name}` : k === "curve" ? `u_curve_${e.name}` : e.name;
    return uniformNames.has(u);
  });

  const warnings: string[] = [];
  const bindings: Record<string, MslBinding> = {};
  const bundleParams: AeShaderParam[] = [];
  const luts: { name: string; width: number; data: number[] }[] = [];
  const count = { slider: 0, checkbox: 0, color: 0 };
  const over: Record<string, string[]> = { slider: [], checkbox: [], color: [], lut: [] };

  for (const e of rows) {
    const kind = channelKind(e);
    const value = opts.values && e.name in opts.values ? opts.values[e.name] : readChannelValue(e, undefined);
    switch (kind) {
      case "scalar": {
        const slot = ++count.slider;
        if (slot > TBX_SHADER_POOL.sliders) over.slider.push(e.name);
        bindings[e.name] = { kind: "slider", slot };
        const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
        const def = channelParamDef(e);
        const r = channelRangeOverride(e);
        let min = r?.min ?? def.min ?? 0;
        let max = r?.max ?? r?.softMax ?? def.max ?? 1;
        // AE clamps a slider's value to its range: never ship a default outside it.
        min = Math.min(min, v);
        max = Math.max(max, v);
        bundleParams.push({ name: e.name, label: e.name, kind: "slider", slot, default: v, min, max });
        break;
      }
      case "toggle": {
        const slot = ++count.checkbox;
        if (slot > TBX_SHADER_POOL.checkboxes) over.checkbox.push(e.name);
        bindings[e.name] = { kind: "checkbox", slot };
        bundleParams.push({ name: e.name, label: e.name, kind: "checkbox", slot, default: value === true });
        break;
      }
      case "color": {
        const slot = ++count.color;
        if (slot > TBX_SHADER_POOL.colors) over.color.push(e.name);
        bindings[e.name] = { kind: "color", slot };
        const c = Array.isArray(value) && value.length === 4 && value.every((x) => typeof x === "number") ? (value as number[]) : [1, 1, 1, 1];
        bundleParams.push({ name: e.name, label: e.name, kind: "color", slot, default: c.map(f32) });
        break;
      }
      case "enum": {
        const options = e.options ?? [];
        const index = options.indexOf(String(value));
        // The node's own fallback (compute(): Math.max(0, indexOf)).
        if (index < 0) warnings.push(`pick "${e.name}": value ${JSON.stringify(value)} is not an option — baked as option 0 like the node`);
        bindings[e.name] = { kind: "enum", value: Math.max(0, index) };
        break;
      }
      case "ramp":
      case "curve": {
        const name = `u_${kind}_${e.name}`;
        const index = luts.length;
        if (index >= 8) over.lut.push(e.name);
        bindings[name] = { kind: "lut", index };
        luts.push({ name, width: CHANNEL_LUT_SIZE, data: Array.from(bakeLut(kind, value), f32) });
        break;
      }
    }
  }

  const overBudget: GlslError[] = [];
  const pool = { slider: TBX_SHADER_POOL.sliders, checkbox: TBX_SHADER_POOL.checkboxes, color: TBX_SHADER_POOL.colors, lut: 8 };
  const what = { slider: "scalar (ch) channels → sliders", checkbox: "toggle channels → checkboxes", color: "color channels", lut: "ramp/curve channels → LUTs" };
  for (const k of ["slider", "checkbox", "color", "lut"] as const) {
    if (!over[k].length) continue;
    const total = pool[k] + over[k].length;
    overBudget.push({
      line: 0,
      message: `${total} ${what[k]} exceed the Toolbox Shader pool of ${pool[k]} (over budget: ${over[k].join(", ")}) — fold some into constants or split the shader`,
    });
  }
  if (overBudget.length) return refuse(overBudget);

  const translated = glslToMsl(glsl, { bindings });
  if (translated.errors.length) return refuse(translated.errors);
  if (luts.length) warnings.push("ramp/curve LUTs ship as float; toolbox samples them from RGBA16F, so expect ≤ 5e-4 differences on those channels");

  const body: Omit<AeShaderBundle, "id"> = {
    format: "tbxfx",
    version: TBX_SHADER_BUNDLE_VERSION,
    hostMin: opts.hostMin ?? TBX_SHADER_HOST_MIN,
    name: opts.name,
    source: { glsl, msl: translated.msl },
    inputs: translated.inputs,
    params: bundleParams,
    ...(luts.length ? { luts } : {}),
    readsTime: translated.readsTime,
    fps: opts.fps,
    loopFrames: opts.loopFrames,
    canvas: { width: opts.canvas.width, height: opts.canvas.height },
  };
  const { format, version, ...rest } = body;
  const bundle: AeShaderBundle = { format, version, id: bundleId(body), ...rest };
  return { ok: true, bundle, warnings };
}

function bakeLut(kind: LutKind, value: ExprChannelValue): Float32Array {
  return kind === "ramp"
    ? buildRampLut((Array.isArray(value) ? value : []) as ColorRampStop[])
    : buildCurveLut((Array.isArray(value) ? value : []) as CurvePoint[]);
}
