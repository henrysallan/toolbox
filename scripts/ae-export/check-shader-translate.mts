// The GLSL → MSL translator (src/lib/ae-export/shader/translate.ts) against
// the ABI.md "GLSL → MSL semantics" table, one case per row, plus the
// preprocessor rules, renames, shadowing and the refusals. Every case that
// translates is also compiled by Metal (msl-compile.m on prelude.ts's
// prelude / epilogue) on macOS; elsewhere only the text is checked.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mts";
import { syncChannelInputs } from "@/engine/expr-channels";
import { glslExpressionPreludeLines, glslExpressionSource } from "@/nodes/effect/glsl-expression";
import { glslToMsl, listGlslUniforms, type GlslToMslResult, type MslBinding } from "@/lib/ae-export/shader/translate";
import { buildMslCompile, compileWithMslCompile } from "@/lib/ae-export/shader/native";
import { fullMslSource } from "@/lib/ae-export/shader/prelude";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Case {
  name: string;
  // A GLSL Expression body (wrapped in the node's template), or a whole
  // shader when `raw`.
  body: string;
  raw?: boolean;
  bindings?: Record<string, MslBinding>;
  // Substrings (or patterns) the MSL must contain / must not contain.
  has?: (string | RegExp)[];
  lacks?: (string | RegExp)[];
  inputs?: string;
  readsTime?: boolean;
  // A refusal: the error must match, on this line of the BODY (1-based;
  // raw sources: of the source).
  error?: RegExp;
  line?: number;
}

const TEMPLATE_ENUMS = (src: string): Record<string, MslBinding> => {
  const out: Record<string, MslBinding> = {};
  const u = listGlslUniforms(src);
  if (u.ok) for (const x of u.uniforms) if (x.type === "int") out[x.name] = { kind: "enum", value: 0 };
  return out;
};

const RAW_HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_c;
uniform sampler2D u_d;
uniform vec2 u_res;
uniform float u_time;
uniform float u_frame;
uniform float u_aspect;
`;

const CASES: Case[] = [
  // ---- ABI.md table, row by row ----------------------------------------
  {
    name: "row: vecN / ivecN / uvecN / bvecN / matN / matCxR → floatN / intN / uintN / boolN / floatCxR",
    body: `vec3 a = vec3(1.0); ivec2 b = ivec2(1, 2); uvec4 c = uvec4(1u); bvec3 d = bvec3(true);
mat3 m = mat3(1.0); mat2x3 n = mat2x3(1.0); mat4x2 o = mat4x2(2.0);
fragColor = vec4(a.x + float(b.y) + float(c.w) + (d.z ? 1.0 : 0.0) + m[0][0] + n[1][2] + o[3][1]);`,
    has: ["float3 a = float3(1.0f);", "int2 b = int2(1, 2);", "uint4 c = uint4(1u);", "bool3 d = bool3(true);", "float3x3 m = float3x3(1.0f);", "float2x3 n = float2x3(1.0f);", "float4x2 o = float4x2(2.0f);"],
  },
  {
    name: "row: texture(u_x, uv) → u_x.sample(uv)",
    body: `fragColor = texture(u_a, v_uv) + texture(u_c, v_uv * 0.5);`,
    has: ["u_a.sample(v_uv)", "u_c.sample(v_uv * 0.5f)"],
    inputs: "a,c",
  },
  {
    name: "row: texelFetch(u_x, p, 0) → u_x.fetch(p)",
    body: `fragColor = texelFetch(u_b, ivec2(v_uv * 8.0), 0);`,
    has: ["u_b.fetch(int2(v_uv * 8.0f))"],
    inputs: "b",
  },
  {
    name: "row: textureSize(u_x, 0) → u_x.size()",
    body: `ivec2 s = textureSize(u_a, 0); fragColor = vec4(vec2(s), 0.0, 1.0);`,
    has: ["int2 s = u_a.size();", "float4(float2(s), 0.0f, 1.0f)"],
    inputs: "a",
  },
  {
    name: "row: mod (floor semantics) → tbx_mod, never fmod",
    body: `fragColor = vec4(mod(v_uv.x - 0.5, 0.3), mod(v_uv, vec2(0.2)), mod(-1.0, 0.7));`,
    has: ["tbx_mod(v_uv.x - 0.5f, 0.3f)", "tbx_mod(v_uv, float2(0.2f))", "x - y * floor(x / y)"],
    lacks: ["fmod"],
  },
  {
    name: "row: atan(y, x) → atan2(y, x); atan(x) stays",
    body: `fragColor = vec4(atan(v_uv.y, v_uv.x), atan(v_uv.x), 0.0, 1.0);`,
    has: ["atan2(v_uv.y, v_uv.x)", "atan(v_uv.x)"],
  },
  {
    name: "row: inversesqrt → rsqrt",
    body: `fragColor = vec4(inversesqrt(v_uv + 0.1), inversesqrt(2.0), 1.0);`,
    has: ["rsqrt(v_uv + 0.1f)", "rsqrt(2.0f)"],
  },
  {
    name: "row: dFdx refused (compute epilogue)",
    body: `float d = 1.0;\nfragColor = vec4(dFdx(v_uv.x));`,
    error: /dFdx is not available: the Toolbox Shader host runs a compute pass/,
    line: 2,
  },
  {
    name: "row: dFdy refused",
    body: `fragColor = vec4(dFdy(v_uv.y));`,
    error: /dFdy is not available/,
    line: 1,
  },
  {
    name: "row: fwidth refused",
    body: `\n\nfragColor = vec4(fwidth(v_uv.y));`,
    error: /fwidth is not available/,
    line: 3,
  },
  {
    name: "row: out / inout params → thread T&",
    body: `// functions
void swap2(inout vec2 a, inout vec2 b) { vec2 t = a; a = b; b = t; }
void unit(vec2 p, out float len, out vec2 dir) { len = length(p); dir = p / max(len, 1e-6); }
// body
vec2 a = v_uv; vec2 b = 1.0 - v_uv; float l; vec2 d;
swap2(a, b); unit(a - 0.5, l, d);
fragColor = vec4(a, l, d.x);`,
    has: ["void swap2(thread float2& a, thread float2& b) {", "void unit(float2 p, thread float& len, thread float2& dir) {", "swap2(a, b);"],
  },
  {
    name: "row: const globals → constant",
    body: `// functions
const float PI = 3.14159265;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const int TAPS = 3 * 2;
// body
fragColor = vec4(vec3(dot(texture(u_a, v_uv).rgb, LUMA) * PI), float(TAPS));`,
    has: ["constant float PI = 3.14159265f;", "constant float3 LUMA = float3(0.2126f, 0.7152f, 0.0722f);", "constant int TAPS = 3 * 2;"],
  },
  {
    name: "row: array constructors → brace init (const and local, sized and unsized)",
    body: `// functions
const float W[3] = float[3](0.25, 0.5, 0.25);
// body
float k[] = float[](1.0, 2.0, 3.0, 4.0);
vec2 o[2] = vec2[2](vec2(-1.0, 0.0), vec2(1.0, 0.0));
k = float[4](4.0, 3.0, 2.0, 1.0);
fragColor = vec4(W[1] + k[3] + o[1].x + float(k.length()));`,
    has: [
      "constant array<float, 3> W = {0.25f, 0.5f, 0.25f};",
      "array<float, 4> k = {1.0f, 2.0f, 3.0f, 4.0f};",
      "array<float2, 2> o = {float2(-1.0f, 0.0f), float2(1.0f, 0.0f)};",
      "k = array<float, 4>{4.0f, 3.0f, 2.0f, 1.0f};",
      "float(4)",
    ],
  },
  {
    name: "row: precision qualifiers dropped",
    body: `// functions
mediump float half_of(lowp float x) { highp float y = x * 0.5; return y; }
// body
precision mediump float;
fragColor = vec4(half_of(v_uv.x));`,
    has: ["float half_of(float x) {", "float y = x * 0.5f;"],
    lacks: ["mediump", "lowp", "highp", "precision"],
  },
  {
    name: "row: v_uv → shade() parameter, fragColor → returned local (every return)",
    body: `fragColor = vec4(v_uv, 0.0, 1.0);
if (v_uv.x > 0.5) return;
fragColor.rg *= 0.5;`,
    has: ["float4 shade(float2 v_uv) {", "float4 fragColor = float4(0.0f);", "return fragColor;\n    }", /fragColor\.rg \*= 0\.5f;\n    return fragColor;\n  }/],
    lacks: ["return;"],
  },
  {
    name: "row: lessThan / greaterThanEqual / equal / not → component-wise operators",
    body: `bvec2 a = lessThan(v_uv, vec2(0.5));
bvec2 b = greaterThanEqual(v_uv, vec2(0.25));
bvec2 c = equal(ivec2(v_uv * 4.0), ivec2(1));
bvec2 d = not(notEqual(a, b));
fragColor = vec4(any(a) ? 1.0 : 0.0, all(b) ? 1.0 : 0.0, any(c) ? 1.0 : 0.0, all(d) ? 1.0 : 0.0);`,
    has: ["bool2 a = (v_uv < float2(0.5f));", "bool2 b = (v_uv >= float2(0.25f));", "bool2 c = (int2(v_uv * 4.0f) == int2(1));", "bool2 d = (!(a != b));"],
  },
  // ---- beyond the table --------------------------------------------------
  {
    name: "vector == is all(), != is any() (GLSL: one bool)",
    body: `bool e = v_uv == vec2(0.5);\nbool n = v_uv.xy != v_uv.yx;\nfragColor = vec4(e ? 1.0 : 0.0, n ? 1.0 : 0.0, 0.0, 1.0);`,
    has: ["bool e = all(v_uv == float2(0.5f));", "bool n = any(v_uv.xy != v_uv.yx);"],
  },
  {
    name: "scalars broadcast explicitly (min/max/clamp/mix/step/smoothstep)",
    body: `vec3 c = texture(u_a, v_uv).rgb;
c = clamp(c, 0.0, 1.0) + max(c, 0.5) + min(c, 0.1) + mix(c, vec3(1.0), 0.25) + step(0.5, c) + smoothstep(0.1, 0.9, c);
fragColor = vec4(c, 1.0);`,
    has: ["clamp(c, float3(0.0f), float3(1.0f))", "max(c, float3(0.5f))", "min(c, float3(0.1f))", "mix(c, float3(1.0f), float3(0.25f))", "step(float3(0.5f), c)", "smoothstep(float3(0.1f), float3(0.9f), c)"],
  },
  {
    name: "mix(x, y, bvec) → select(x, y, b)",
    body: `fragColor = vec4(mix(v_uv, vec2(1.0), bvec2(true, false)), 0.0, 1.0);`,
    has: ["select(v_uv, float2(1.0f), bool2(true, false))"],
  },
  {
    name: "swizzles: assignment, stpq → xyzw, rgba kept, scalar x of a vector",
    body: `vec4 c = vec4(0.0);
c.zx = v_uv;
c.stp += vec3(1.0);
c.a = c.r;
fragColor = c.wzyx + vec4(c.q);`,
    has: ["c.zx = v_uv;", "c.xyz += float3(1.0f);", "c.a = c.r;", "c.wzyx + float4(c.w)"],
  },
  {
    name: "vector constructors: truncation, conversion, splat, last-argument overflow",
    body: `vec4 v = vec4(1.0, 2.0, 3.0, 4.0);
vec2 a = vec2(v);
ivec3 b = ivec3(v);
vec3 c = vec3(1, 2, 3);
vec3 d = vec3(0.5, v);
float e = float(v);
fragColor = vec4(a, float(b.z) + c.x + d.z + e, 1.0);`,
    has: ["float2 a = float2(v.xy);", "int3 b = int3(v.xyz);", "float3 c = float3(float(1), float(2), float(3));", "float3 d = float3(0.5f, v.xy);", "float e = float(v.x);"],
  },
  {
    name: "matrix constructors: scalars → columns, mat3(mat4), mat4(mat2), mat2(vec4)",
    body: `mat2 m = mat2(1.0, 2.0, 3.0, 4.0);
mat4 big = mat4(1.0);
mat3 s = mat3(big);
mat4 g = mat4(m);
vec4 q = vec4(1.0, 0.0, 0.0, 1.0);
mat2 h = mat2(q);
mat2 k = mat2(v_uv, 0.0, 1.0);
fragColor = vec4(m[1][0], s[2][2], g[3][3], h[1][1] + k[1][1]);`,
    has: [
      "float2x2 m = float2x2(float2(1.0f, 2.0f), float2(3.0f, 4.0f));",
      "float3x3 s = float3x3(big[0].xyz, big[1].xyz, big[2].xyz);",
      "float4x4 g = float4x4(float4(m[0], 0.0f, 0.0f), float4(m[1], 0.0f, 0.0f), float4(0.0f, 0.0f, 1.0f, 0.0f), float4(0.0f, 0.0f, 0.0f, 1.0f));",
      "float2x2 h = float2x2(q.xy, q.zw);",
      "float2x2 k = float2x2(v_uv, float2(0.0f, 1.0f));",
    ],
  },
  {
    name: "matrix built-ins: inverse / matrixCompMult / outerProduct helpers, transpose / determinant",
    body: `mat3 m = mat3(2.0);
mat3 i = inverse(m) + matrixCompMult(m, m);
mat3x2 o = outerProduct(v_uv, vec3(1.0));
fragColor = vec4(i[0][0], determinant(transpose(m)), o[2][1], 1.0);`,
    has: ["tbx_inverse(m)", "tbx_matrixCompMult(m, m)", "tbx_outerProduct(v_uv, float3(1.0f))", "determinant(transpose(m))", "inline float3x3 tbx_inverse(float3x3 m)"],
  },
  {
    name: "structs: constructor → brace, fields, struct params, arrays of structs",
    body: `// functions
struct Light { vec3 dir; float power; };
float shadeL(Light l, vec3 n) { return max(dot(n, l.dir), 0.0) * l.power; }
// body
Light ls[2] = Light[2](Light(vec3(0.0, 0.0, 1.0), 1.0), Light(normalize(vec3(1.0)), 0.5));
Light one = ls[1];
one.power *= 2.0;
fragColor = vec4(vec3(shadeL(ls[0], vec3(v_uv, 1.0)) + shadeL(one, vec3(0.0, 0.0, 1.0))), 1.0);`,
    has: ["struct Light {", "float3 dir;", "array<Light, 2> ls = {Light{float3(0.0f, 0.0f, 1.0f), 1.0f}, Light{normalize(float3(1.0f)), 0.5f}};", "float shadeL(Light l, float3 n) {", "one.power *= 2.0f;"],
  },
  {
    name: "switch: fallthrough kept; a declaration under a case is split (C++ can't jump past it)",
    body: `int k = int(v_uv.x * 4.0);
float r = 0.0;
switch (k) {
  case 0: r += 1.0;
  case 1: float t = 2.0; r += t; break;
  default: r = -1.0;
}
fragColor = vec4(r);`,
    has: ["switch (k) {", "case 0:", "r += 1.0f;", "float t;\n        t = 2.0f;", "default:"],
  },
  {
    name: "loops: for with two declarators, while, do-while, break / continue",
    body: `float s = 0.0;
for (int i = 0, j = 10; i < j; i++, j--) { if (i == 2) continue; s += float(i * j); }
int n = 0;
while (true) { if (++n > 3) break; }
do { s -= 1.0; } while (s > 100.0);
fragColor = vec4(s + float(n));`,
    has: ["for (int i = 0, j = 10; i < j; i++, j--) {", "while (true) {", "if (++n > 3) {", "do {", "} while (s > 100.0f);", "continue;"],
  },
  {
    name: "operators: ^^ → !=, bit ops, shifts, uint / hex / octal literals, ++ --, comma, ternary",
    body: `int a = 0x1F & (7 << 2) | 010 ^ ~3;
uint u = (4u >> 1u) ^ (7u << 2);
bool x = (v_uv.x > 0.5) ^^ (v_uv.y > 0.5);
int b = a--, c = (a++, a + 1);
fragColor = vec4(float(a + b + c) + float(u), x ? 1.0 : 0.0, - -v_uv.x, 1.0);`,
    has: ["int a = 0x1F & 7 << 2 | 010 ^ ~3;", "uint u = 4u >> 1u ^ 7u << 2;", "bool x = (v_uv.x > 0.5f != v_uv.y > 0.5f);", "int b = a--;", "int c = (a++, a + 1);", "-(-v_uv.x)"],
  },
  {
    name: "precedence: parentheses only where the tree needs them",
    body: `float a = 1.0, b = 2.0, c = 3.0;
float r = (a + b) * c - (a - (b - c)) + a / (b * c) + (a - b) - c;
fragColor = vec4(r);`,
    has: ["float r = (a + b) * c - (a - (b - c)) + a / (b * c) + (a - b) - c;"],
  },
  {
    name: "radians / degrees → tbx_ helpers; roundEven → rint",
    body: `fragColor = vec4(radians(90.0), degrees(v_uv), roundEven(2.5));`,
    has: ["tbx_radians(90.0f)", "tbx_degrees(v_uv)", "rint(2.5f)", "template <typename T> inline T tbx_radians(T x)"],
  },
  {
    name: "textureLod → sample (no mips either side); scalar geometry forms",
    body: `vec4 t = textureLod(u_a, v_uv, 2.0);
fragColor = vec4(length(t.x), distance(t.y, 1.0), dot(t.z, 2.0), normalize(t.w - 0.5));`,
    has: ["float4 t = u_a.sample(v_uv);", "abs(t.x)", "abs(t.y - 1.0f)", "(t.z * 2.0f)", "sign(t.w - 0.5f)"],
  },
  {
    name: "constant #define inlined (incl. a define of defines and a built-in call)",
    body: `#define TAU 6.28318530718
#define HALF_TAU (TAU * 0.5)
#define DIAG sqrt(2.0)
fragColor = vec4(sin(v_uv.x * HALF_TAU), DIAG, TAU, 1.0);`,
    has: ["sin(v_uv.x * (6.28318530718f * 0.5f))", "sqrt(2.0f)", "6.28318530718f, 1.0f)"],
    lacks: ["#define", "TAU"],
  },
  {
    name: "uniforms: channels bind to pool slots in the constructor; picks bake to constants",
    body: `// ch("gain", 1.5, 0.0, 4.0)
// toggle("inv", false)
// color("tint", "#ff8800")
// pick("mode", "soft", "hard")
vec3 c = texture(u_a, v_uv).rgb * gain * tint.rgb;
if (inv) c = 1.0 - c;
if (mode == mode_hard) c = step(0.5, c);
fragColor = vec4(c, 1.0);`,
    bindings: { mode: { kind: "enum", value: 1 } },
    has: ["constant int mode = 1;", "constant int mode_soft = 0;", "constant int mode_hard = 1;", "this->gain = U.sliders[0];", "this->inv = U.checkboxes[0] != 0;", "this->tint = U.colors[0];", "float gain;", "bool inv;", "float4 tint;"],
  },
  {
    name: "ramp / curve channels → LUT members bound to l0, l1 in order",
    body: `// ramp("ink", "#000000", "#ffffff")
// curve("fall", 1.0, 0.0)
fragColor = ink(fall(v_uv.x));`,
    has: ["TbxImage u_ramp_ink;", "TbxImage u_curve_fall;", "u_ramp_ink(l0), u_curve_fall(l1)", "float4 ink(float t) {", "return u_ramp_ink.sample(float2((clamp(t, 0.0f, 1.0f) * 255.0f + 0.5f) / 256.0f, 0.5f));"],
  },
  {
    name: "MSL/C++ keywords and stdlib macros as GLSL names are renamed <name>_",
    body: `// ch("kernel", 0.5, 0.0, 1.0)
// functions
const float FLT_MAX = 3.0e38;
float device(float thread) { return thread * 2.0; }
struct Box { float constant; };
// body
float select = device(kernel);
Box b = Box(select);
float not = b.constant;
fragColor = vec4(not, FLT_MAX > 1.0 ? 1.0 : 0.0, 0.0, 1.0);`,
    has: ["constant float FLT_MAX_ = 3.0e38f;", "float device_(float thread_) {", "return thread_ * 2.0f;", "float constant_;", "float select_ = device_(kernel_);", "this->kernel_ = U.sliders[0];", "float not_ = b.constant_;"],
  },
  {
    name: "a local that shadows an outer name gets a fresh MSL name (GLSL scope starts after the initializer)",
    body: `// ch("scale", 2.0, 0.0, 4.0)
float scale = scale * 2.0;
{ float scale = scale + 1.0; fragColor = vec4(scale); }
fragColor += vec4(scale);`,
    has: ["float scale_1 = scale * 2.0f;", "float scale_2 = scale_1 + 1.0f;", "fragColor = float4(scale_2);", "fragColor += float4(scale_1);"],
  },
  {
    name: "helpers reading v_uv / writing fragColor → members; gl_FragCoord → v_uv × u_res",
    body: `// functions
vec2 px() { return gl_FragCoord.xy; }
void paint(float v) { fragColor = vec4(v_uv, v, 1.0); }
// body
paint(px().x / u_res.x);`,
    has: ["float2 v_uv{};", "float4 fragColor{};", "this->v_uv = v_uv;", "fragColor = float4(0.0f);", "float4(v_uv * u_res, 0.5f, 1.0f).xy"],
  },
  {
    name: "const globals MSL can't fold (built-in calls) become TbxProgram members; mutable globals too",
    body: `// functions
const float S2 = sqrt(2.0);
const float S4 = S2 * S2;
const float ONE = 1.0;
float counter = 0.5;
float bump() { counter += ONE; return counter; }
// body
fragColor = vec4(S4, bump(), bump(), 1.0);`,
    has: ["const float S2 = sqrt(2.0f);", "const float S4 = S2 * S2;", "constant float ONE = 1.0f;", "float counter = 0.5f;"],
  },
  {
    name: "uninitialized locals are value-initialized (ANGLE zero-fills them)",
    body: `float a; vec3 b; mat2 m;
fragColor = vec4(a, b.x, m[0][0], 1.0);`,
    has: ["float a{};", "float3 b{};", "float2x2 m{};"],
  },
  {
    name: "discard in main() → return transparent",
    body: `if (v_uv.x < 0.1) discard;
fragColor = vec4(1.0);`,
    has: ["return float4(0.0f);"],
  },
  {
    name: "readsTime / inputs come from what main() reaches",
    body: `// functions
vec4 unused() { return texture(u_d, v_uv) * u_time; }
vec4 used() { return texture(u_b, v_uv) * u_frame; }
// body
fragColor = used();`,
    inputs: "b",
    readsTime: true,
  },
  {
    name: "a static shader reads no time",
    body: `fragColor = texture(u_a, v_uv);`,
    inputs: "a",
    readsTime: false,
  },
  // ---- refusals ------------------------------------------------------------
  {
    name: "refuse: non-constant #define, with its line",
    body: `float k = 2.0;\n#define K2 (k * 2.0)\nfragColor = vec4(K2);`,
    error: /#define K2 is not a constant \(it references "k"\)/,
    line: 2,
  },
  {
    name: "a backslash-continued #define is one line; later errors keep their own line",
    body: `#define K (1.0 + \\\n  2.0)\nfloat a = K;\nfragColor = vec4(dFdx(a));`,
    error: /dFdx is not available/,
    line: 4,
  },
  {
    name: "refuse: function-like #define",
    body: `#define SQ(x) ((x) * (x))\nfragColor = vec4(SQ(v_uv.x));`,
    error: /function-like #define SQ/,
    line: 1,
  },
  {
    name: "refuse: #ifdef and other directives",
    body: `#ifdef GL_ES\nfragColor = vec4(1.0);\n#endif`,
    error: /preprocessor directive "#ifdef GL_ES" is not supported/,
    line: 1,
  },
  {
    name: "refuse: #extension",
    body: `fragColor = vec4(1.0);`,
    raw: true,
    error: /preprocessor directive "#extension GL_OES_standard_derivatives : enable" is not supported/,
    line: 2,
  },
  {
    name: "refuse: a swizzle as an out argument (MSL can't bind a reference to it)",
    body: `// functions
void two(out float a) { a = 2.0; }
// body
vec4 c = vec4(0.0);
two(c.x);
fragColor = c;`,
    error: /argument 1 of two is an out\/inout parameter: MSL can't pass a vector component or swizzle by reference/,
    line: 5,
  },
  {
    name: "refuse: discard inside a helper",
    body: `// functions
float f(float x) { if (x < 0.0) discard; return x; }
// body
fragColor = vec4(f(v_uv.x));`,
    error: /discard is only supported in main\(\)/,
    line: 2,
  },
  {
    name: "refuse: an int uniform without a baked value",
    body: `// pick("mode", "a", "b")
fragColor = vec4(float(mode));`,
    bindings: {},
    error: /int uniform "mode" needs a baked value/,
  },
  {
    name: "refuse: gl_ built-ins other than gl_FragCoord",
    body: `fragColor = vec4(gl_FrontFacing ? 1.0 : 0.0);`,
    error: /gl_FrontFacing is not available in the Toolbox Shader host/,
    line: 1,
  },
  {
    name: "refuse: samplers other than 2D",
    body: `fragColor = vec4(1.0);`,
    raw: true,
    error: /type "samplerCube" is not supported/,
  },
  {
    name: "refuse: texture() with a bias",
    body: `fragColor = texture(u_a, v_uv, 1.0);`,
    error: /texture\(\) with a LOD bias is not supported/,
    line: 1,
  },
  {
    name: "a syntax error reports its line",
    body: `float a = 1.0;\nfloat b = (a + ;\nfragColor = vec4(b);`,
    error: /syntax error/,
    line: 2,
  },
];

// Raw sources for the cases that need file-scope text the template can't hold.
const RAW: Record<string, string> = {
  "refuse: #extension": `#version 300 es\n#extension GL_OES_standard_derivatives : enable\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nvoid main() { fragColor = vec4(1.0); }\n`,
  "refuse: samplers other than 2D": `${RAW_HEAD}uniform samplerCube u_env;\nvoid main() { fragColor = vec4(1.0); }\n`,
};

function matches(text: string, p: string | RegExp): boolean {
  return typeof p === "string" ? text.includes(p) : p.test(text);
}

export default async function run(): Promise<number> {
  const c = makeChecker("shader-translate");
  const compiled: { name: string; msl: string }[] = [];

  for (const k of CASES) {
    let src: string;
    let prelude = 0;
    if (k.raw) src = RAW[k.name];
    else {
      const params = { inputs: syncChannelInputs([], k.body), expression: k.body };
      src = glslExpressionSource(params);
      prelude = glslExpressionPreludeLines(params);
    }
    const bindings = k.bindings ?? TEMPLATE_ENUMS(src);
    const r: GlslToMslResult = glslToMsl(src, { bindings });
    if (k.error) {
      const hit = r.errors.find((e) => k.error!.test(e.message));
      let ok = !!hit && !r.msl;
      let detail: unknown = r.errors.length ? r.errors.map((e) => `L${e.line}: ${e.message}`).join(" | ") : "translated without errors";
      if (ok && k.line !== undefined) {
        // Template cases: body lines follow the prelude unless the body
        // was split into // functions … // body (then it is the source line).
        const want = k.raw ? k.line : undefined;
        const got = hit!.line;
        const bodyLine = got - prelude;
        if (want !== undefined) ok = got === want;
        else ok = bodyLine === k.line || lineOfFunctions(src, k.body, got) === k.line;
        if (!ok) detail = `error on GLSL line ${got} (body line ${bodyLine}), want body line ${k.line}`;
      }
      c.check(k.name, ok, detail);
      continue;
    }
    if (r.errors.length) {
      c.check(k.name, false, r.errors.map((e) => `L${e.line}: ${e.message}`).join(" | "));
      continue;
    }
    const missing = (k.has ?? []).filter((p) => !matches(r.msl, p));
    const extra = (k.lacks ?? []).filter((p) => matches(r.msl, p));
    let ok = !missing.length && !extra.length;
    const notes: string[] = [];
    if (missing.length) notes.push(`missing ${missing.map(String).join(" ‖ ")}`);
    if (extra.length) notes.push(`unexpected ${extra.map(String).join(" ‖ ")}`);
    if (k.inputs !== undefined && r.inputs.join(",") !== k.inputs) {
      ok = false;
      notes.push(`inputs [${r.inputs}] want [${k.inputs}]`);
    }
    if (k.readsTime !== undefined && r.readsTime !== k.readsTime) {
      ok = false;
      notes.push(`readsTime ${r.readsTime} want ${k.readsTime}`);
    }
    c.check(k.name, ok, notes.length ? `${notes.join("; ")}\n${r.msl}` : undefined);
    compiled.push({ name: k.name, msl: r.msl });
  }

  // Determinism: the same source gives the same MSL.
  const again = CASES.filter((k) => !k.error && !k.raw).slice(0, 5);
  c.check(
    "translation is deterministic",
    again.every((k) => {
      const src = glslExpressionSource({ inputs: syncChannelInputs([], k.body), expression: k.body });
      const b = k.bindings ?? TEMPLATE_ENUMS(src);
      return glslToMsl(src, { bindings: b }).msl === glslToMsl(src, { bindings: b }).msl;
    })
  );

  const built = buildMslCompile({ repoRoot: ROOT });
  if (!built.ok) {
    if ("skipped" in built) console.log(`  note Metal compile of the ${compiled.length} cases skipped: ${built.skipped}`);
    else c.check("msl-compile builds", false, built.error);
    return c.failures;
  }
  let ok = 0;
  for (const x of compiled) {
    const res = compileWithMslCompile(built.bin, fullMslSource(x.msl).source);
    if (res.ok) ok++;
    else c.check(`Metal compiles: ${x.name}`, false, res.log.slice(0, 1500));
  }
  c.check(`Metal (${built.device}) compiles all ${compiled.length} translated cases`, ok === compiled.length, `${ok}/${compiled.length}`);
  return c.failures;
}

// For cases split with // functions … // body, the source line of an error
// maps back to the case text's own line.
function lineOfFunctions(src: string, body: string, line: number): number | undefined {
  const srcLine = src.split("\n")[line - 1];
  if (srcLine === undefined) return undefined;
  const idx = body.split("\n").findIndex((l) => l === srcLine);
  return idx >= 0 ? idx + 1 : undefined;
}
