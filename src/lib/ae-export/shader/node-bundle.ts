// bundleFromNodeShader — a node's OWN fragment shader (node-shaders.ts) → the
// `.tbxfx` bundle the Toolbox Shader host loads, the single-node twin of
// bundleFromGlslExpression.
//
// The node's source is rewritten into the GLSL Expression template's shape,
// which is what glslToMsl and validateAeShader read (ABI.md):
//   - the host clock (u_res, u_time, u_frame, u_aspect) and one channel
//     uniform per control, named after its param (`<param>_param` when the
//     name is taken in the source), after the node's precision line;
//   - each node uniform → by its rule: a constant (`const T u_x = …;`), a
//     plain global set at the top of main(), or a sampler renamed to its
//     image slot u_a–u_d (unwired: a helper returning the engine's
//     transparent placeholder texel);
//   - the spec's helpers, before main().
// Nothing else in the source changes, so the shader the host compiles is the
// node's, statement for statement.

import type { ParamDef } from "@/engine/types";
import { colorToRgba } from "../convert";
import { TBX_SHADER_BUNDLE_VERSION, TBX_SHADER_POOL, type AeShaderBundle, type AeShaderParam } from "../types";
import { TBX_SHADER_HOST_MIN } from "./bundle";
import { glslFloat, nodeShaderSpec, type NodeShaderEnv, type NodeShaderRule, type NodeShaderSpec } from "./node-shaders";
import { parseGlsl } from "./parse";
import { bundleId, f32 } from "./tbxfx";
import { glslToMsl, listGlslUniforms, type GlslError, type MslBinding } from "./translate";
import { preprocessAndTokenize } from "./tokenize";

const TEMPLATE = ["u_res", "u_time", "u_frame", "u_aspect"];
const SLOTS = ["a", "b", "c", "d"] as const;

// GLSL ES 3.00 keywords, reserved words and type names a param could be
// called (a channel uniform can't take those).
const GLSL_WORDS = new Set(
  "attribute const uniform varying layout centroid flat smooth break continue do for while switch case default if else in out inout float int void bool true false invariant discard return struct precision highp mediump lowp sample filter input output active common partition patch subroutine coherent volatile restrict readonly writeonly resource atomic_uint noperspective asm class union enum typedef template this goto inline noinline public static extern external interface long short double half fixed unsigned superp sizeof cast namespace using".split(" ")
);
const GLSL_TYPE = /^(?:[biud]?vec[234]|mat[234](?:x[234])?|[iu]?sampler\w*|image\w*|uint)$/;

// Names a control uniform can't take: the source's own globals and
// functions, anything it calls (a built-in it would hide), GLSL words.
function takenNames(fs: string): Set<string> {
  const pre = preprocessAndTokenize(fs);
  const taken = new Set<string>();
  pre.tokens.forEach((t, i) => {
    if (t.k === "id" && pre.tokens[i + 1]?.v === "(") taken.add(t.v);
  });
  for (const d of parseGlsl(pre.tokens).program.decls) {
    if (d.k === "global") for (const v of d.vars) taken.add(v.name);
    else taken.add(d.name);
  }
  return taken;
}

export interface NodeBundleOptions {
  name: string;
  fps: number;
  canvas: { width: number; height: number };
  hostMin?: string;
}

export interface NodeShaderControlInfo {
  param: string;
  // The uniform / bundle param name (the param's own unless the source uses it).
  name: string;
  kind: "slider" | "checkbox" | "color";
  slot: number;
}

export type NodeBundleResult =
  | {
      ok: true;
      bundle: AeShaderBundle;
      controls: NodeShaderControlInfo[];
      // Node input socket → the image slot it feeds.
      inputs: Record<string, (typeof SLOTS)[number]>;
      // Params the shader holds as constants at their current value (spec.bakes).
      baked: string[];
      // The rewritten GLSL (also bundle.source.glsl).
      glsl: string;
    }
  | { ok: false; refused: string }
  | { ok: false; errors: GlslError[]; glsl: string };

// The node's params with its definition's defaults under them.
export function nodeShaderParams(spec: NodeShaderSpec, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of spec.node.params) out[d.name] = d.default;
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v;
  return out;
}

// Control kind of a param def, or null when it can't be one.
function controlKind(def: ParamDef): NodeShaderControlInfo["kind"] | null {
  return def.type === "scalar" ? "slider" : def.type === "boolean" ? "checkbox" : def.type === "color" ? "color" : null;
}

// AE param names are 31 bytes of plain text: keep the label ASCII.
export function controlLabel(def: ParamDef): string {
  return (def.label ?? def.name).replace(/°/g, "deg").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim() || def.name;
}

export function bundleFromNodeShader(type: string, params: Record<string, unknown>, inputs: NodeShaderEnv["inputs"], opts: NodeBundleOptions): NodeBundleResult {
  const spec = nodeShaderSpec(type);
  if (!spec) return { ok: false, refused: `${type} has no host spec (node-shaders.ts)` };
  const env: NodeShaderEnv = { params: nodeShaderParams(spec, params), inputs };
  const why = spec.refuse?.(env);
  if (why) return { ok: false, refused: why };

  const fs = spec.fs(env);
  const declared = listGlslUniforms(fs);
  if (!declared.ok) return { ok: false, errors: declared.errors, glsl: fs };
  const taken = takenNames(`${fs}\n${spec.helpers ?? ""}`);
  const defs = new Map(spec.node.params.map((d) => [d.name, d]));

  // --- controls → channel uniforms -------------------------------------------------
  const controls: NodeShaderControlInfo[] = [];
  const count = { slider: 0, checkbox: 0, color: 0 };
  const bundleParams: AeShaderParam[] = [];
  const decls: string[] = [];
  const bindings: Record<string, MslBinding> = {};
  for (const c of spec.controls) {
    const { param, when } = typeof c === "string" ? { param: c, when: undefined } : c;
    if (when && !when(env)) continue;
    const def = defs.get(param);
    const kind = def && controlKind(def);
    if (!def || !kind) return { ok: false, refused: `node-shaders.ts: control "${param}" is not a scalar / boolean / color param of ${type}` };
    const slot = ++count[kind];
    const pool = kind === "slider" ? TBX_SHADER_POOL.sliders : kind === "checkbox" ? TBX_SHADER_POOL.checkboxes : TBX_SHADER_POOL.colors;
    if (slot > pool) return { ok: false, refused: `${type}: more ${kind} controls than the host's ${pool}` };
    const name = taken.has(param) || GLSL_WORDS.has(param) || GLSL_TYPE.test(param) || param.startsWith("u_") || param.startsWith("gl_") ? `${param}_param` : param;
    taken.add(name);
    controls.push({ param, name, kind, slot });
    bindings[name] = { kind, slot };
    const value = env.params[param];
    const label = controlLabel(def);
    if (kind === "slider") {
      const v = f32(typeof value === "number" && Number.isFinite(value) ? value : Number(def.default) || 0);
      // The UI range (the host's valid range is ±1e6): soft max when the
      // param has one, never excluding the value itself.
      const min = Math.min(def.min ?? 0, v);
      const max = Math.max(def.softMax ?? def.max ?? 1, v);
      bundleParams.push({ name, label, kind, slot, default: v, min, max });
      decls.push(`uniform float ${name}; // ${label}`);
    } else if (kind === "checkbox") {
      bundleParams.push({ name, label, kind, slot, default: value === true });
      decls.push(`uniform bool ${name}; // ${label}`);
    } else {
      bundleParams.push({ name, label, kind, slot, default: colorToRgba(value ?? def.default).map(f32) });
      decls.push(`uniform vec4 ${name}; // ${label}`);
    }
  }
  const byParam = new Map(controls.map((c) => [c.param, c]));

  // `$param` → the control's uniform, else the param's value as a literal.
  const subst = (expr: string): string =>
    expr.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, p: string) => {
      const c = byParam.get(p);
      if (c) return c.name;
      const def = defs.get(p);
      if (!def) throw new Error(`node-shaders.ts ${type}: $${p} is not a param`);
      return literal(def, env.params[p]);
    });
  const reads = (expr: string) => controls.some((c) => new RegExp(`\\b${c.name}\\b`).test(expr)) || TEMPLATE.some((u) => new RegExp(`\\b${u}\\b`).test(expr));

  // --- node uniforms → constants / globals / image slots ------------------------------
  let src = fs;
  const assigns: string[] = [];
  const inputSlots: Record<string, (typeof SLOTS)[number]> = {};
  const errors: GlslError[] = [];
  for (const u of declared.uniforms) {
    const rule: NodeShaderRule | undefined = spec.uniforms[u.name];
    if (rule === undefined) {
      errors.push({ line: u.line, message: `uniform ${u.type} ${u.name} has no rule in node-shaders.ts (${type}) — compute() binds it, the host can't` });
      continue;
    }
    if (TEMPLATE.includes(u.name)) {
      errors.push({ line: u.line, message: `${u.name} is a host clock uniform; the node's own meaning for it needs a rename first` });
      continue;
    }
    const declLine = new RegExp(`^[ \\t]*uniform\\s+(?:(?:highp|mediump|lowp)\\s+)?${u.type}\\s+${u.name}\\s*;[^\\n]*$`, "m");
    if (!declLine.test(src)) {
      errors.push({ line: u.line, message: `uniform ${u.name}: only one plain \`uniform T name;\` per line is rewritten` });
      continue;
    }
    if (typeof rule === "object") {
      if (u.type !== "sampler2D") {
        errors.push({ line: u.line, message: `uniform ${u.name}: an input rule needs a sampler2D` });
        continue;
      }
      if (inputs[rule.input] === "image") {
        const slot = SLOTS[Object.keys(inputSlots).length];
        if (!slot) {
          errors.push({ line: u.line, message: `${type}: more than 4 image inputs` });
          continue;
        }
        inputSlots[rule.input] = slot;
        src = src.replace(declLine, `uniform sampler2D u_${slot}; // ${rule.input}`).replace(new RegExp(`\\b${u.name}\\b`, "g"), `u_${slot}`);
      } else {
        // The engine binds a 1×1 transparent placeholder to an unwired input.
        const zero = `unwired_${rule.input}`;
        src = src
          .replace(declLine, `vec4 ${zero}(vec2 uv) { return vec4(0.0); } // ${rule.input}, unwired\nvec4 ${zero}_fetch(ivec2 p, int lod) { return vec4(0.0); }`)
          .replace(new RegExp(`\\btexture\\s*\\(\\s*${u.name}\\s*,`, "g"), `${zero}(`)
          .replace(new RegExp(`\\btexelFetch\\s*\\(\\s*${u.name}\\s*,`, "g"), `${zero}_fetch(`)
          .replace(new RegExp(`\\btextureSize\\s*\\(\\s*${u.name}\\s*,\\s*0\\s*\\)`, "g"), "ivec2(1)");
        if (new RegExp(`\\b${u.name}\\b`).test(src)) errors.push({ line: u.line, message: `sampler ${u.name} is used other than through texture / texelFetch / textureSize` });
      }
      continue;
    }
    const expr = subst(typeof rule === "function" ? rule(env) : rule);
    if (reads(expr)) {
      src = src.replace(declLine, `${u.type} ${u.name};`);
      assigns.push(`  ${u.name} = ${expr};`);
    } else src = src.replace(declLine, `const ${u.type} ${u.name} = ${expr};`);
  }
  if (errors.length) return { ok: false, errors, glsl: fs };

  // --- assemble -----------------------------------------------------------------------
  const head = [
    `// ${spec.node.name} (${type}): the node's own fragment shader for the Toolbox Shader host`,
    "// (src/lib/ae-export/shader/node-shaders.ts). Its params are the channel uniforms;",
    "// main() sets the node's uniforms from them first, as compute() binds them.",
    ...TEMPLATE.map((n) => `uniform ${n === "u_res" ? "vec2" : "float"} ${n};`),
    ...decls,
  ].join("\n");
  const precision = /^[ \t]*precision\s+\w+\s+float\s*;[^\n]*$/m.exec(src);
  const version = /^[ \t]*#version[^\n]*$/m.exec(src);
  const at = precision ? precision.index + precision[0].length : version ? version.index + version[0].length : 0;
  src = `${src.slice(0, at)}\n${head}${src.slice(at)}`;
  const main = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)\s*\{/.exec(src);
  if (!main) return { ok: false, errors: [{ line: 0, message: "no `void main() {`" }], glsl: src };
  const helpers = spec.helpers ? `${spec.helpers}\n\n` : "";
  const body = assigns.length ? `\n  // host controls → the node's uniforms, as compute() binds them\n${assigns.join("\n")}\n` : "";
  src = `${src.slice(0, main.index)}${helpers}${main[0]}${body}${src.slice(main.index + main[0].length)}`;

  const translated = glslToMsl(src, { bindings });
  if (translated.errors.length) return { ok: false, errors: translated.errors, glsl: src };

  const content: Omit<AeShaderBundle, "id"> = {
    format: "tbxfx",
    version: TBX_SHADER_BUNDLE_VERSION,
    hostMin: opts.hostMin ?? TBX_SHADER_HOST_MIN,
    name: opts.name,
    source: { glsl: src, msl: translated.msl },
    inputs: translated.inputs,
    params: bundleParams,
    readsTime: translated.readsTime,
    fps: opts.fps,
    // The node keeps its own clock (u_frame unwrapped, like ctx.tick).
    loopFrames: 0,
    canvas: { width: opts.canvas.width, height: opts.canvas.height },
  };
  const { format, version: v, ...rest } = content;
  const bundle: AeShaderBundle = { format, version: v, id: bundleId(content), ...rest };
  return { ok: true, bundle, controls, inputs: inputSlots, baked: [...(spec.bakes ?? [])], glsl: src };
}

function literal(def: ParamDef, value: unknown): string {
  const v = value ?? def.default;
  switch (def.type) {
    case "boolean":
      return v === true ? "true" : "false";
    case "color": {
      const c = colorToRgba(v);
      return `vec4(${c.map((x) => glslFloat(f32(x))).join(", ")})`;
    }
    default:
      return glslFloat(f32(typeof v === "number" ? v : Number(v) || 0));
  }
}
