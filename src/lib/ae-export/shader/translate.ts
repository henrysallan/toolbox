// glslToMsl — the fused GLSL ES 3.00 fragment shader (the GLSL Expression
// template, glsl-expression.ts buildSource) → the `struct TbxProgram` MSL the
// Toolbox Shader host compiles (ABI.md). Tokenizer → parser → checker →
// printer; no text rewriting. Errors carry the GLSL line.

import { checkProgram, type ImageSlot, type MslBinding } from "./check";
import { emitMsl } from "./emit-msl";
import { glslName } from "./glsl-types";
import { parseGlsl } from "./parse";
import { preprocessAndTokenize, type GlslError } from "./tokenize";

export type { GlslError } from "./tokenize";
export type { MslBinding, ImageSlot } from "./check";

export interface GlslToMslOptions {
  // Channel uniform → pool slot / baked value / LUT index. Unlisted float,
  // bool and vec4 uniforms get the next slider / checkbox / color slot in
  // declaration order, and u_ramp_* / u_curve_* samplers the next LUT
  // index; an int (pick) uniform must be listed.
  bindings?: Record<string, MslBinding>;
}

export interface MslUniform {
  name: string;
  // The member / constant name in the MSL (keyword-renamed, ABI.md "Names").
  msl: string;
  glslType: string;
  role: "image" | "template" | "channel" | "lut";
  binding: MslBinding | null;
}

export interface GlslToMslResult {
  // Empty when there are errors.
  msl: string;
  errors: GlslError[];
  // Image inputs main() can reach, a..d.
  inputs: ImageSlot[];
  // main() can reach u_time or u_frame.
  readsTime: boolean;
  uniforms: MslUniform[];
  // lineMap[i] = GLSL line behind MSL line i + 1 (0 = generated).
  lineMap: number[];
}

export function glslToMsl(source: string, opts: GlslToMslOptions = {}): GlslToMslResult {
  const empty = (errors: GlslError[]): GlslToMslResult => ({
    msl: "",
    errors: sortErrors(errors),
    inputs: [],
    readsTime: false,
    uniforms: [],
    lineMap: [],
  });
  const pre = preprocessAndTokenize(source);
  if (pre.errors.length) return empty(pre.errors);
  const { program, errors: parseErrors } = parseGlsl(pre.tokens);
  if (parseErrors.length) return empty(parseErrors);
  const identifiers = pre.tokens.filter((t) => t.k === "id").map((t) => t.v);
  const checked = checkProgram(program, identifiers, opts.bindings);
  const errors = [...checked.errors, ...bindingConflicts(checked.uniforms)];
  const uniforms: MslUniform[] = checked.uniforms.map((u) => ({
    name: u.name,
    msl: u.msl,
    glslType: glslName(u.ty),
    role: u.role,
    binding: u.binding ?? null,
  }));
  if (errors.length) return { ...empty(errors), uniforms };
  const emitted = emitMsl(checked);
  if (emitted.errors.length) return { ...empty(emitted.errors), uniforms };
  return {
    msl: emitted.msl,
    errors: [],
    inputs: (["a", "b", "c", "d"] as const).filter((s) => checked.inputs.has(s)),
    readsTime: checked.readsTime,
    uniforms,
    lineMap: emitted.lineMap,
  };
}

// The uniforms a GLSL source declares (name + GLSL type spelling), from the
// same tokenizer and parser — no type checking, no bindings needed.
export function listGlslUniforms(
  source: string
): { ok: true; uniforms: { name: string; type: string; line: number }[] } | { ok: false; errors: GlslError[] } {
  const pre = preprocessAndTokenize(source);
  if (pre.errors.length) return { ok: false, errors: sortErrors(pre.errors) };
  const { program, errors } = parseGlsl(pre.tokens);
  if (errors.length) return { ok: false, errors: sortErrors(errors) };
  const uniforms = [];
  for (const d of program.decls) if (d.k === "uniform") uniforms.push({ name: d.name, type: d.type.name, line: d.line });
  return { ok: true, uniforms };
}

// Two uniforms in one pool slot (or one LUT index) would alias in the host.
function bindingConflicts(uniforms: { name: string; line: number; binding?: MslBinding }[]): GlslError[] {
  const errors: GlslError[] = [];
  const seen = new Map<string, string>();
  for (const u of uniforms) {
    const b = u.binding;
    if (!b || b.kind === "enum") continue;
    const key = b.kind === "lut" ? `lut:${b.index}` : `${b.kind}:${b.slot}`;
    const idx = b.kind === "lut" ? b.index : b.slot;
    const max = b.kind === "lut" ? 7 : b.kind === "slider" ? 32 : 8;
    const min = b.kind === "lut" ? 0 : 1;
    if (!Number.isInteger(idx) || idx < min || idx > max) errors.push({ line: u.line, message: `${u.name}: ${b.kind} ${b.kind === "lut" ? "index" : "slot"} ${idx} is outside the host pool (${min}–${max})` });
    const other = seen.get(key);
    if (other) errors.push({ line: u.line, message: `${u.name} and ${other} share ${key}` });
    seen.set(key, u.name);
  }
  return errors;
}

function sortErrors(errors: GlslError[]): GlslError[] {
  return [...errors].sort((a, b) => a.line - b.line);
}
