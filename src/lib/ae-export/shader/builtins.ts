// GLSL ES 3.00 built-in functions → MSL (ABI.md table). Each entry types the
// call from its argument types (GLSL ES 3.00 has no implicit conversions, so
// the signatures are exact) and returns how to print it. Scalars that GLSL
// broadcasts into a vector parameter (`max(v, 0.0)`, `step(0.5, v)`, …) are
// splatted explicitly so no MSL overload resolution is relied on.

import type { Expr } from "./ast";
import { glslName, isMatrix, isScalar, isVector, mat, mslTypeName, sameTy, T, vec, type Ty } from "./glsl-types";

// Argument i printed for a context of C++ precedence `prec` (emit-msl.ts
// levels: 9 relational, 11 additive, 12 multiplicative, 13 unary).
export type ArgAt = (i: number, prec: number) => string;

export interface BuiltinCall {
  ret: Ty;
  // args: MSL text of each argument in a call-argument position; `at` for
  // operator forms. The result must read as one postfix expression (a call,
  // or parenthesized).
  emit(args: string[], at: ArgAt): string;
  // Program-scope tbx_* helpers this call needs (emitted once, see HELPERS).
  helpers?: string[];
  // Argument indices that are GLSL `out` parameters (must be lvalues).
  outArgs?: number[];
}

export type BuiltinResolution = BuiltinCall | { error: string } | null;

const genF = (t: Ty) => t.a === undefined && t.m === 0 && t.b === "float";
const genI = (t: Ty) => t.a === undefined && t.m === 0 && t.b === "int";
const genU = (t: Ty) => t.a === undefined && t.m === 0 && t.b === "uint";
const genB = (t: Ty) => t.a === undefined && t.m === 0 && t.b === "bool";
const genFIU = (t: Ty) => genF(t) || genI(t) || genU(t);

// Same-name MSL functions over genType (float).
const SAME_F1 = new Set([
  "sin", "cos", "tan", "asin", "acos", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "exp", "log", "exp2", "log2", "sqrt", "floor", "ceil", "fract", "trunc", "round",
]);
// GLSL name → MSL name for genType (float) unary functions that differ.
const RENAMED_F1: Record<string, { msl: string; helper?: string }> = {
  inversesqrt: { msl: "rsqrt" },
  roundEven: { msl: "rint" },
  radians: { msl: "tbx_radians", helper: "tbx_radians" },
  degrees: { msl: "tbx_degrees", helper: "tbx_degrees" },
};

const REFUSED: Record<string, string> = {
  dFdx: "dFdx is not available: the Toolbox Shader host runs a compute pass (no derivatives). Compute the difference explicitly (e.g. evaluate at uv ± 1.0 / u_res)",
  dFdy: "dFdy is not available: the Toolbox Shader host runs a compute pass (no derivatives). Compute the difference explicitly (e.g. evaluate at uv ± 1.0 / u_res)",
  fwidth: "fwidth is not available: the Toolbox Shader host runs a compute pass (no derivatives). Compute the difference explicitly (e.g. evaluate at uv ± 1.0 / u_res)",
  textureProj: "textureProj is not supported — divide the coordinate and call texture()",
  textureProjLod: "textureProjLod is not supported — divide the coordinate and call texture()",
  textureProjGrad: "textureProjGrad is not supported",
  textureProjOffset: "textureProjOffset is not supported",
  textureProjLodOffset: "textureProjLodOffset is not supported",
  textureProjGradOffset: "textureProjGradOffset is not supported",
  textureOffset: "textureOffset is not supported — add offset / vec2(textureSize(…)) to the coordinate",
  textureLodOffset: "textureLodOffset is not supported — add offset / vec2(textureSize(…)) to the coordinate",
  textureGrad: "textureGrad is not supported (no mip levels on either side) — use texture()",
  textureGradOffset: "textureGradOffset is not supported",
  texelFetchOffset: "texelFetchOffset is not supported — add the offset to the texel coordinate",
  packSnorm2x16: "packSnorm2x16 is not supported",
  unpackSnorm2x16: "unpackSnorm2x16 is not supported",
  packUnorm2x16: "packUnorm2x16 is not supported",
  unpackUnorm2x16: "unpackUnorm2x16 is not supported",
  packHalf2x16: "packHalf2x16 is not supported",
  unpackHalf2x16: "unpackHalf2x16 is not supported",
};

export const BUILTIN_NAMES = new Set<string>([
  ...SAME_F1,
  ...Object.keys(RENAMED_F1),
  ...Object.keys(REFUSED),
  "abs", "sign", "atan", "pow", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "isnan", "isinf",
  "floatBitsToInt", "floatBitsToUint", "intBitsToFloat", "uintBitsToFloat", "modf",
  "length", "distance", "dot", "cross", "normalize", "faceforward", "reflect", "refract",
  "matrixCompMult", "outerProduct", "transpose", "determinant", "inverse",
  "lessThan", "lessThanEqual", "greaterThan", "greaterThanEqual", "equal", "notEqual", "any", "all", "not",
  "texture", "textureLod", "texelFetch", "textureSize",
]);

// Program-scope helpers, by name. Emitted before TbxProgram in this order
// when a call needs them. All prefixed tbx_ (ABI.md, "Bundle source").
export const HELPERS: Record<string, string> = {
  // GLSL mod is floor-based (x - y·floor(x/y)); MSL fmod truncates.
  tbx_mod: "template <typename T, typename U> inline T tbx_mod(T x, U y) { return x - y * floor(x / y); }",
  tbx_isign: "template <typename T> inline T tbx_isign(T x) { return T(x > T(0)) - T(x < T(0)); }",
  tbx_radians: "template <typename T> inline T tbx_radians(T x) { return x * 0.017453292519943295f; }",
  tbx_degrees: "template <typename T> inline T tbx_degrees(T x) { return x * 57.29577951308232f; }",
  tbx_matrixCompMult:
    "template <int C, int R> inline matrix<float, C, R> tbx_matrixCompMult(matrix<float, C, R> a, matrix<float, C, R> b) {\n" +
    "  matrix<float, C, R> r;\n  for (int i = 0; i < C; i++) r[i] = a[i] * b[i];\n  return r;\n}",
  tbx_outerProduct:
    "template <int C, int R> inline matrix<float, C, R> tbx_outerProduct(vec<float, R> c, vec<float, C> r) {\n" +
    "  matrix<float, C, R> m;\n  for (int i = 0; i < C; i++) m[i] = c * r[i];\n  return m;\n}",
  tbx_inverse: [
    "inline float2x2 tbx_inverse(float2x2 m) {",
    "  float d = m[0][0] * m[1][1] - m[1][0] * m[0][1];",
    "  return float2x2(float2(m[1][1], -m[0][1]), float2(-m[1][0], m[0][0])) * (1.0f / d);",
    "}",
    "inline float3x3 tbx_inverse(float3x3 m) {",
    "  float3 a = m[0], b = m[1], c = m[2];",
    "  float3 r0 = cross(b, c), r1 = cross(c, a), r2 = cross(a, b);",
    "  float d = dot(a, r0);",
    "  return transpose(float3x3(r0, r1, r2)) * (1.0f / d);",
    "}",
    "inline float4x4 tbx_inverse(float4x4 m) {",
    "  float a00 = m[0][0], a01 = m[0][1], a02 = m[0][2], a03 = m[0][3];",
    "  float a10 = m[1][0], a11 = m[1][1], a12 = m[1][2], a13 = m[1][3];",
    "  float a20 = m[2][0], a21 = m[2][1], a22 = m[2][2], a23 = m[2][3];",
    "  float a30 = m[3][0], a31 = m[3][1], a32 = m[3][2], a33 = m[3][3];",
    "  float b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;",
    "  float b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;",
    "  float b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;",
    "  float b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;",
    "  float d = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;",
    "  return float4x4(",
    "    float4(a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09, a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03),",
    "    float4(a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07, a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01),",
    "    float4(a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06, a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00),",
    "    float4(a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06, a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00)) * (1.0f / d);",
    "}",
  ].join("\n"),
};

// Broadcast a scalar argument to `to` when GLSL's genType rule widened it.
function splat(text: string, from: Ty, to: Ty): string {
  if (isScalar(from) && isVector(to)) return `${mslTypeName(to)}(${text})`;
  return text;
}

// Second-and-later args: the same type as x, or (when allowed) the scalar of x's base.
const sameOrScalar = (x: Ty, y: Ty) => sameTy(x, y) || (isScalar(y) && y.b === x.b);

export function resolveBuiltin(name: string, a: Ty[], argNodes: Expr[]): BuiltinResolution {
  if (REFUSED[name]) return { error: REFUSED[name] };
  const n = a.length;
  const bad = (): { error: string } => ({
    error: `no matching overload for ${name}(${a.map(glslName).join(", ")})`,
  });

  if (SAME_F1.has(name)) {
    if (n !== 1 || !genF(a[0])) return bad();
    return { ret: a[0], emit: (s) => `${name}(${s[0]})` };
  }
  const ren = RENAMED_F1[name];
  if (ren) {
    if (n !== 1 || !genF(a[0])) return bad();
    return { ret: a[0], emit: (s) => `${ren.msl}(${s[0]})`, helpers: ren.helper ? [ren.helper] : undefined };
  }

  switch (name) {
    case "abs":
    case "sign":
      if (n !== 1 || !(genF(a[0]) || genI(a[0]))) return bad();
      // MSL's sign() is float-only; abs() has int overloads.
      if (name === "sign" && genI(a[0])) return { ret: a[0], emit: (s) => `tbx_isign(${s[0]})`, helpers: ["tbx_isign"] };
      return { ret: a[0], emit: (s) => `${name}(${s[0]})` };
    case "atan":
      if (n === 1 && genF(a[0])) return { ret: a[0], emit: (s) => `atan(${s[0]})` };
      if (n === 2 && genF(a[0]) && sameTy(a[0], a[1])) return { ret: a[0], emit: (s) => `atan2(${s[0]}, ${s[1]})` };
      return bad();
    case "pow":
      if (n !== 2 || !genF(a[0]) || !sameTy(a[0], a[1])) return bad();
      return { ret: a[0], emit: (s) => `pow(${s[0]}, ${s[1]})` };
    case "mod":
      if (n !== 2 || !genF(a[0]) || !sameOrScalar(a[0], a[1])) return bad();
      return { ret: a[0], emit: (s) => `tbx_mod(${s[0]}, ${s[1]})`, helpers: ["tbx_mod"] };
    case "min":
    case "max":
      if (n !== 2 || !genFIU(a[0]) || !sameOrScalar(a[0], a[1])) return bad();
      return { ret: a[0], emit: (s) => `${name}(${s[0]}, ${splat(s[1], a[1], a[0])})` };
    case "clamp":
      if (n !== 3 || !genFIU(a[0]) || !sameOrScalar(a[0], a[1]) || !sameTy(a[1], a[2])) return bad();
      return { ret: a[0], emit: (s) => `clamp(${s[0]}, ${splat(s[1], a[1], a[0])}, ${splat(s[2], a[2], a[0])})` };
    case "mix":
      if (n !== 3 || !genF(a[0]) || !sameTy(a[0], a[1])) return bad();
      if (genB(a[2]) && a[2].n === a[0].n)
        // GLSL mix(x, y, bvec a) picks y where a is true; MSL select(x, y, c) likewise.
        return { ret: a[0], emit: (s) => `select(${s[0]}, ${s[1]}, ${s[2]})` };
      if (!sameOrScalar(a[0], a[2])) return bad();
      return { ret: a[0], emit: (s) => `mix(${s[0]}, ${s[1]}, ${splat(s[2], a[2], a[0])})` };
    case "step":
      if (n !== 2 || !genF(a[1]) || !sameOrScalar(a[1], a[0])) return bad();
      return { ret: a[1], emit: (s) => `step(${splat(s[0], a[0], a[1])}, ${s[1]})` };
    case "smoothstep":
      if (n !== 3 || !genF(a[2]) || !sameOrScalar(a[2], a[0]) || !sameTy(a[0], a[1])) return bad();
      return { ret: a[2], emit: (s) => `smoothstep(${splat(s[0], a[0], a[2])}, ${splat(s[1], a[1], a[2])}, ${s[2]})` };
    case "isnan":
    case "isinf":
      if (n !== 1 || !genF(a[0])) return bad();
      return { ret: vec("bool", a[0].n), emit: (s) => `${name}(${s[0]})` };
    case "floatBitsToInt":
    case "floatBitsToUint": {
      if (n !== 1 || !genF(a[0])) return bad();
      const ret = vec(name === "floatBitsToInt" ? "int" : "uint", a[0].n);
      return { ret, emit: (s) => `as_type<${mslTypeName(ret)}>(${s[0]})` };
    }
    case "intBitsToFloat":
    case "uintBitsToFloat": {
      if (n !== 1 || !(name === "intBitsToFloat" ? genI(a[0]) : genU(a[0]))) return bad();
      const ret = vec("float", a[0].n);
      return { ret, emit: (s) => `as_type<${mslTypeName(ret)}>(${s[0]})` };
    }
    case "modf":
      if (n !== 2 || !genF(a[0]) || !sameTy(a[0], a[1])) return bad();
      return { ret: a[0], emit: (s) => `modf(${s[0]}, ${s[1]})`, outArgs: [1] };
    case "length":
      if (n !== 1 || !genF(a[0])) return bad();
      return { ret: T.float, emit: (s) => (isScalar(a[0]) ? `abs(${s[0]})` : `length(${s[0]})`) };
    case "distance":
      if (n !== 2 || !genF(a[0]) || !sameTy(a[0], a[1])) return bad();
      return { ret: T.float, emit: (s, at) => (isScalar(a[0]) ? `abs(${at(0, 11)} - ${at(1, 12)})` : `distance(${s[0]}, ${s[1]})`) };
    case "dot":
      if (n !== 2 || !genF(a[0]) || !sameTy(a[0], a[1])) return bad();
      return { ret: T.float, emit: (s, at) => (isScalar(a[0]) ? `(${at(0, 12)} * ${at(1, 13)})` : `dot(${s[0]}, ${s[1]})`) };
    case "cross":
      if (n !== 2 || !sameTy(a[0], vec("float", 3)) || !sameTy(a[1], vec("float", 3))) return bad();
      return { ret: a[0], emit: (s) => `cross(${s[0]}, ${s[1]})` };
    case "normalize":
      if (n !== 1 || !genF(a[0])) return bad();
      return { ret: a[0], emit: (s) => (isScalar(a[0]) ? `sign(${s[0]})` : `normalize(${s[0]})`) };
    case "faceforward":
      if (n !== 3 || !genF(a[0]) || !sameTy(a[0], a[1]) || !sameTy(a[0], a[2])) return bad();
      return {
        ret: a[0],
        emit: (s, at) => (isScalar(a[0]) ? `(${at(2, 12)} * ${at(1, 13)} < 0.0f ? ${at(0, 3)} : -${at(0, 13)})` : `faceforward(${s[0]}, ${s[1]}, ${s[2]})`),
      };
    case "reflect":
      if (n !== 2 || !genF(a[0]) || !sameTy(a[0], a[1])) return bad();
      return {
        ret: a[0],
        emit: (s, at) => (isScalar(a[0]) ? `(${at(0, 11)} - 2.0f * ${at(1, 13)} * ${at(0, 13)} * ${at(1, 13)})` : `reflect(${s[0]}, ${s[1]})`),
      };
    case "refract":
      if (n !== 3 || !genF(a[0]) || !isVector(a[0]) || !sameTy(a[0], a[1]) || !sameTy(a[2], T.float)) {
        if (n === 3 && isScalar(a[0])) return { error: "refract() on scalars is not supported — use vectors" };
        return bad();
      }
      return { ret: a[0], emit: (s) => `refract(${s[0]}, ${s[1]}, ${s[2]})` };
    case "matrixCompMult":
      if (n !== 2 || !isMatrix(a[0]) || !sameTy(a[0], a[1])) return bad();
      return { ret: a[0], emit: (s) => `tbx_matrixCompMult(${s[0]}, ${s[1]})`, helpers: ["tbx_matrixCompMult"] };
    case "outerProduct":
      if (n !== 2 || !genF(a[0]) || !genF(a[1]) || !isVector(a[0]) || !isVector(a[1])) return bad();
      return { ret: mat(a[1].n, a[0].n), emit: (s) => `tbx_outerProduct(${s[0]}, ${s[1]})`, helpers: ["tbx_outerProduct"] };
    case "transpose":
      if (n !== 1 || !isMatrix(a[0])) return bad();
      return { ret: mat(a[0].n, a[0].m), emit: (s) => `transpose(${s[0]})` };
    case "determinant":
      if (n !== 1 || !isMatrix(a[0]) || a[0].m !== a[0].n) return bad();
      return { ret: T.float, emit: (s) => `determinant(${s[0]})` };
    case "inverse":
      if (n !== 1 || !isMatrix(a[0]) || a[0].m !== a[0].n) return bad();
      return { ret: a[0], emit: (s) => `tbx_inverse(${s[0]})`, helpers: ["tbx_inverse"] };
    case "lessThan":
    case "lessThanEqual":
    case "greaterThan":
    case "greaterThanEqual": {
      if (n !== 2 || !isVector(a[0]) || !genFIU(a[0]) || !sameTy(a[0], a[1])) return bad();
      const op = { lessThan: "<", lessThanEqual: "<=", greaterThan: ">", greaterThanEqual: ">=" }[name];
      return { ret: vec("bool", a[0].n), emit: (_s, at) => `(${at(0, 10)} ${op} ${at(1, 10)})` };
    }
    case "equal":
    case "notEqual": {
      if (n !== 2 || !isVector(a[0]) || !sameTy(a[0], a[1])) return bad();
      const op = name === "equal" ? "==" : "!=";
      return { ret: vec("bool", a[0].n), emit: (_s, at) => `(${at(0, 9)} ${op} ${at(1, 9)})` };
    }
    case "any":
    case "all":
      if (n !== 1 || !genB(a[0]) || !isVector(a[0])) return bad();
      return { ret: T.bool, emit: (s) => `${name}(${s[0]})` };
    case "not":
      if (n !== 1 || !genB(a[0]) || !isVector(a[0])) return bad();
      return { ret: a[0], emit: (_s, at) => `(!${at(0, 13)})` };
    case "texture":
      if (n === 3 && a[0].b === "sampler") return { error: "texture() with a LOD bias is not supported (no mip levels on either side) — drop the bias" };
      if (n !== 2 || a[0].b !== "sampler" || !sameTy(a[1], vec("float", 2))) return bad();
      return { ret: vec("float", 4), emit: (s) => `${s[0]}.sample(${s[1]})` };
    case "textureLod":
      // Neither toolbox's pool textures nor the host's have mip levels, so
      // every LOD reads level 0 — the same as sample().
      if (n !== 3 || a[0].b !== "sampler" || !sameTy(a[1], vec("float", 2)) || !sameTy(a[2], T.float)) return bad();
      return { ret: vec("float", 4), emit: (s) => `${s[0]}.sample(${s[1]})` };
    case "texelFetch":
      if (n !== 3 || a[0].b !== "sampler" || !sameTy(a[1], vec("int", 2)) || !sameTy(a[2], T.int)) return bad();
      if (!isLiteralZero(argNodes[2])) return { error: "texelFetch() LOD must be the literal 0 (the host has no mip levels)" };
      return { ret: vec("float", 4), emit: (s) => `${s[0]}.fetch(${s[1]})` };
    case "textureSize":
      if (n !== 2 || a[0].b !== "sampler" || !sameTy(a[1], T.int)) return bad();
      if (!isLiteralZero(argNodes[1])) return { error: "textureSize() LOD must be the literal 0 (the host has no mip levels)" };
      return { ret: vec("int", 2), emit: (s) => `${s[0]}.size()` };
  }
  return null;
}

function isLiteralZero(e: Expr | undefined): boolean {
  return !!e && e.k === "lit" && (e.lit === "int" || e.lit === "uint") && /^0+[uU]?$|^0[xX]0+[uU]?$/.test(e.text);
}

