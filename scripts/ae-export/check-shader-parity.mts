// Numerical parity of the translated MSL (src/lib/ae-export/shader), macOS only.
//
// Reference: toolbox's own render path — the GLSL Expression template
// (glslExpressionSource) compiled by WebGL2 in Electron (ANGLE on the
// machine's GPU), uniforms bound the way glsl-expression.ts compute() binds
// them. Candidate: the bundle's source.msl, compiled by Metal at runtime with
// the host's options and run by msl-compile.m's `probe` compute kernel,
// uniforms read from the BUNDLE (so a wrong slot or baked value shows up).
// Both sides evaluate the same float32 uvs: the GL side draws one POINT per
// sample, so v_uv is the vertex's value exactly, not an interpolation. Test
// textures are half-float-exact on both sides (toolbox's pool is RGBA16F).
//
// Cases are pure-math bodies that exercise the ABI.md table rows (mod,
// atan2, rsqrt, matrices both ways, out/inout, swizzles, switch, ints,
// bvecs, arrays, structs, consts, LUT channels, the clock) plus the three
// gold docs. Each runs twice on Metal:
//   host IEEE — MathModeSafe + precise functions, what the AE host compiles:
//               the shipping difference, bounded per case by `tol`;
//   fast math — the mode ANGLE evidently compiles toolbox's WebGL with:
//               isolates the translation, which must agree to FAST_REL_TOL.
// The gap between the two is the math library, not the translator: a 1-ulp
// sin() difference becomes ~1e-2 through fract(sin(x)·43758.5453) hashing.
//
//   npx tsx scripts/check-ae-export.mts shader-parity
//   TBX_PARITY_GL=swiftshader …      reference on SwiftShader instead of the GPU

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mts";
import {
  buildCurveLut,
  buildRampLut,
  channelKind,
  readChannelValue,
  syncChannelInputs,
} from "@/engine/expr-channels";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { CurvePoint } from "@/engine/float-curve";
import type { ExprInput } from "@/engine/types";
import { glslExpressionSource } from "@/nodes/effect/glsl-expression";
import { bundleFromGlslExpression } from "@/lib/ae-export/shader/bundle";
import { buildMslCompile, probeShade, type ProbeTexture } from "@/lib/ae-export/shader/native";
import type { AeShaderBundle } from "@/lib/ae-export/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The translation itself: under the reference's own math mode (ANGLE
// compiles toolbox's WebGL with Metal fast math) the MSL must agree to a few
// float32 ulps, relative to max(1, |value|). ~8 ulps: ANGLE spells a few
// built-ins (sinh, asin, …) with its own formulas; a translation error is O(1).
const FAST_REL_TOL = 1e-6;
const DOCS = path.join(ROOT, "src", "lib", "glsl-translation", "docs", "nodes");

type Rgba = [number, number, number, number];
type Slot = "a" | "b" | "c" | "d";

interface ParityCase {
  name: string;
  body: string;
  // Channel values (by name) over the seeds the comments declare.
  set?: Record<string, unknown>;
  images?: Partial<Record<Slot, (u: number, v: number) => Rgba>>;
  res?: [number, number];
  time?: number;
  frame?: number;
  // Max |Δ| allowed, per output component.
  tol: number;
  why?: string;
}

const f16: (x: number) => number =
  (Math as unknown as { f16round?: (x: number) => number }).f16round ??
  ((x: number) => {
    // RTE to binary16 for engines without Math.f16round.
    const f = Math.fround(x);
    if (!Number.isFinite(f) || f === 0) return f;
    const a = Math.abs(f);
    if (a >= 65520) return Math.sign(f) * Infinity;
    const e = Math.max(-14, Math.floor(Math.log2(a)));
    const ulp = 2 ** (e - 10);
    const q = a / ulp;
    const r = Math.abs(q - Math.floor(q) - 0.5) < 1e-9 ? (Math.floor(q) % 2 === 0 ? Math.floor(q) : Math.ceil(q)) : Math.round(q);
    return Math.sign(f) * r * ulp;
  });

function docBody(file: string): string {
  const text = fs.readFileSync(path.join(DOCS, file), "utf8");
  const m = /```glsl-body\r?\n([\s\S]*?)```/.exec(text);
  if (!m) throw new Error(`${file} has no glsl-body`);
  return m[1];
}

const smooth = (u: number, v: number): Rgba => [
  0.5 + 0.5 * Math.sin(u * 6.1 + 0.3),
  0.5 + 0.5 * Math.cos(v * 4.7 - 0.2),
  u * v,
  0.25 + 0.75 * (0.5 + 0.5 * Math.sin((u + v) * 3.3)),
];
const ramps = (u: number, v: number): Rgba => [u, v, 1 - u, 0.6 + 0.4 * v];

const CASES: ParityCase[] = [
  {
    name: "mod / atan2 / inversesqrt",
    body: `// ch("k", 3.1, 0.0, 10.0)
vec2 p = (v_uv - 0.5) * 7.3 + vec2(0.013, -0.007); // off (0, 0): atan(0, 0) is undefined in GLSL
float a = atan(p.y, p.x);
float m = mod(p.x * k, 1.7) + mod(vec2(-p.y), vec2(0.9)).x;
vec3 mv = mod(vec3(p, -p.x - p.y), 1.3);
float r = inversesqrt(dot(p, p) + 0.25);
fragColor = vec4(a, m + mv.z, r, mv.x + mv.y);`,
    tol: 2e-6,
  },
  {
    name: "matrices (column-major, v*M, constructors, inverse)",
    body: `// ch("t", 0.7, 0.0, 6.3)
mat2 R = mat2(cos(t), sin(t), -sin(t), cos(t));
mat3 M = mat3(1.0, 2.0, 0.5, 0.0, 1.0, 3.0, 2.0, 0.0, 1.0);
mat3 Mc = mat3(vec3(1.0, 2.0, 0.5), vec3(0.0, 1.0, 3.0), vec3(2.0, 0.0, 1.0));
vec3 v = M * vec3(v_uv, 1.0);
vec3 w = vec3(v_uv, 1.0) * Mc;
vec2 q = R * v_uv + v_uv * R;
mat3 Mi = inverse(M);
vec3 back = Mi * v;
mat2x3 nm = mat2x3(M[0], M[1]);
mat4 big = mat4(M);
mat2 small = mat2(big);
mat4 inv4 = inverse(mat4(2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 0.0, 4.0, 0.0, 1.0, 2.0, 3.0, 1.0));
vec4 h = inv4 * vec4(v, 1.0);
mat3 D = mat3(2.0);
mat3x2 tp = transpose(nm);
mat2 sm = mat2(v_uv, v.xy);
fragColor = vec4(q.x + w.y * 0.1 + sm[1].x,
                 back.x - v_uv.x + back.y + determinant(M) * 0.01 + (D * v).z * 0.01,
                 (tp * vec3(1.0, 2.0, 3.0)).y + small[1][1] + big[3][3] + matrixCompMult(M, Mc)[2][0],
                 h.x + h.w * 0.25 + outerProduct(v_uv, vec3(1.0, 0.5, 0.25))[2].y + inverse(R)[0][1]);`,
    tol: 1e-5,
  },
  {
    name: "control flow, ints, out/inout, swizzles, arrays, structs",
    body: `// ch("n", 5.0, 0.0, 10.0)
// pick("mode", "one", "two", "three")
// functions
struct Acc { vec3 sum; int count; };
const float W[4] = float[4](0.1, 0.2, 0.3, 0.4);
const int N = 4;
void addTo(inout Acc acc, vec3 v) { acc.sum += v; acc.count++; }
void split(float x, out float ip, out float fp) { fp = fract(x); ip = x - fp; }
// body
Acc acc = Acc(vec3(0.0), 0);
for (int i = 0; i < N; i++) addTo(acc, vec3(W[i] * v_uv.x, W[N - 1 - i] * v_uv.y, float(i)));
int k = int(v_uv.x * 17.0) - 8;
int q = k / 3 + k % 3 * 2;
uint u = uint(k + 9) * 3u;
int bits = (k << 2) ^ (k >> 1) | 5 & 0xF;
float ip, fp;
split(v_uv.y * 9.3, ip, fp);
vec4 c = vec4(0.0);
c.zx = vec2(fp, ip * 0.1);
c.y = float(acc.count) * 0.1;
c.w += acc.sum.x + acc.sum.y;
switch (mode) {
  case 0: c.x += 1.0;
  case 1: c.y += 2.0; break;
  default: c.z -= 1.0;
}
switch (k) {
  case -1: float t1 = 3.0; c.x += t1; break;
  case 2: { c.y -= 0.5; } break;
  default: break;
}
bvec2 lt = lessThan(v_uv, vec2(0.5, 0.25));
bool same = floor(v_uv * 2.0) == vec2(1.0);
float tern = any(lt) ? (all(lt) ? 1.0 : 0.5) : -0.5;
int j = 0; float wsum = 0.0;
while (j < int(n)) { wsum += float(j); j++; }
do { wsum -= 0.5; } while (wsum > 6.0);
bool x1 = v_uv.x > 0.5, x2 = v_uv.y > 0.5;
c.stp += vec3(float(q) * 0.01, float(u) * 0.001, float(bits) * 0.001);
c += vec4(tern) + (same ? 1.0 : 0.0) + ((x1 ^^ x2) ? 0.25 : 0.0) + wsum * 0.01 + float(W.length()) * 0.001;
fragColor = c;`,
    set: { mode: "two" },
    tol: 1e-6,
  },
  {
    name: "built-ins (splats, rounding, geometry, exp/log/trig)",
    body: `vec3 p = vec3(v_uv * 2.0 - 1.0, 0.5);
vec3 s1 = step(0.2, p) + smoothstep(-0.5, 0.5, p) + mix(p, p.zxy, 0.3) + mix(p, vec3(1.0), bvec3(true, false, true));
vec3 s2 = clamp(p, -0.25, 0.75) + max(p, 0.1) + min(p, vec3(0.2)) + pow(abs(p) + 0.1, vec3(1.5));
vec3 s3 = exp(p) * 0.1 + log(abs(p) + 1.0) + sign(p) + fract(p * 3.3) + floor(p * 2.5) + ceil(p * 1.5) + round(p * 4.0) + trunc(p * 3.0) + roundEven(p * 2.0 + 0.5);
float an = radians(degrees(p.x) * 2.0) + sin(p.y) * cos(p.x) + tan(p.x * 0.5) + asin(p.x * 0.9) + acos(p.y * 0.9) + atan(p.y);
vec3 nn = normalize(p + 0.01);
vec3 r = reflect(nn, normalize(vec3(0.3, 0.4, 0.5)));
vec3 rf = refract(nn, vec3(0.0, 0.0, 1.0), 0.66);
vec3 cr = cross(p, vec3(0.1, 0.2, 0.3));
vec3 ff = faceforward(nn, p, vec3(0.0, 1.0, 0.0));
float l = length(p) + distance(p, vec3(0.5)) + length(p.x) + dot(p.y, p.x) + normalize(p.x - 0.01);
int ia = abs(int(p.x * 10.0)) + floatBitsToInt(1.0) / 1000000000 + sign(-3);
float hb = sqrt(abs(p.x)) + exp2(p.y) + log2(abs(p.y) + 1.0) + sinh(p.x) + cosh(p.y) * 0.1 + tanh(p.x) + intBitsToFloat(0x3f800000);
fragColor = vec4(s1.x + s2.y + s3.z, an + l, dot(r + rf + cr + ff, vec3(1.0)) + hb, float(ia) * 0.01 + (isnan(p.x) ? 1.0 : 0.0));`,
    tol: 1e-5,
  },
  {
    name: "LUT channels (ramp, curve), baked pick, color, toggle",
    body: `// ramp("ink", "#102030", "#ff8000", "#ffffff")
// curve("fall", 0.0, 0.8, 0.2, 1.0)
// pick("shape", "radial", "linear")
// color("tint", "#80c0ff")
// toggle("flip", true)
float t = shape == shape_radial ? length(v_uv - 0.5) * 1.4 : v_uv.x;
if (flip) t = 1.0 - t;
vec4 c = ink(fall(t));
fragColor = vec4(c.rgb * tint.rgb, c.a * tint.a);`,
    set: { shape: "linear", tint: "#80c0ffcc" },
    tol: 1e-6,
  },
  {
    name: "clock and canvas (u_time, u_frame, u_res, u_aspect)",
    body: `vec2 px = v_uv * u_res;
float wave = sin(px.x / 37.0 + u_time * 2.0) * cos(px.y / 23.0 - u_frame * 0.1);
fragColor = vec4(wave, fract(px / 64.0), u_aspect * 0.5);`,
    res: [1920, 1080],
    time: 1.25,
    frame: 37.5,
    tol: 1e-5,
    why: "sin of ~50-radian arguments: one ulp of the argument (3.8e-6) moves the result as much",
  },
  {
    name: "helpers that read v_uv / write fragColor, member consts, early return",
    body: `// functions
const float SQ2 = sqrt(2.0);
const vec2 OFF = vec2(0.25, -0.5) * 2.0;
float g_acc = 0.25;
vec2 uvScaled() { return v_uv * SQ2 + OFF; }
void writeOut(float v) { fragColor = vec4(v, g_acc, uvScaled()); g_acc += 1.0; }
// body
writeOut(length(v_uv));
fragColor.y += g_acc;
if (v_uv.x > 0.7) return;
fragColor.x *= 2.0;`,
    tol: 1e-6,
  },
  {
    name: "MSL keywords and shadowing as GLSL names",
    body: `// ch("kernel", 0.5, 0.0, 1.0)
// functions
const float FLT_MAX = 3.0e38;
const float M_PI = 3.14159265;
float device(float thread) { return thread * 2.0; }
// body
float constant = device(kernel) + M_PI * v_uv.x;
float select = constant > FLT_MAX ? 0.0 : constant;
float scale = select;
{ float scale = scale * 2.0; select += scale; }
fragColor = vec4(select, scale, kernel, 1.0);`,
    tol: 1e-6,
  },
  {
    name: "gold: noise (stand-in value noise, animated)",
    body: docBody("noise.md"),
    set: { animated: true, octaves: 6, w: 0.35, seed: 3, color_a: "#203040", color_b: "#f0e0a0" },
    res: [1280, 720],
    frame: 17,
    time: 17 / 30,
    tol: 2e-2,
    why: "hash noise: fract(sin(x)·43758) turns IEEE-vs-fast sin ulps into ~1e-2",
  },
  {
    name: "gold: displace (two texture inputs, picks, rotate)",
    body: docBody("displace.md"),
    set: { channelX: "g", channelY: "luminance", wrap: "mirror", rotate: true, amountX: 0.08, amountY: -0.06 },
    images: { a: smooth, b: ramps },
    tol: 1e-5,
  },
  {
    name: "gold: blur (premultiplied, linearized, 25-tap gather)",
    body: docBody("blur.md"),
    set: { radius: 3 },
    images: { a: smooth },
    res: [96, 64],
    tol: 1e-5,
  },
];

// ---------------------------------------------------------------------------
// Reference: WebGL2 in Electron
// ---------------------------------------------------------------------------

interface GlCase {
  name: string;
  fs: string;
  uvs: number[];
  uniforms: { name: string; kind: "1f" | "1i" | "4f" | "2f"; v: number[] }[];
  textures: Partial<Record<string, { w: number; h: number; data: number[] }>>;
  luts: { name: string; w: number; h: number; data: number[] }[];
}

// Runs in the page. Plain JS on purpose: a TS function's toString() could
// carry bundler helpers into the page.
const PAGE = String.raw`function run(job) {
  const canvas = document.createElement("canvas");
  canvas.width = 8; canvas.height = 8;
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
  if (!gl) return { fatal: "no webgl2 context" };
  if (!gl.getExtension("EXT_color_buffer_float")) return { fatal: "no EXT_color_buffer_float" };
  gl.getExtension("OES_texture_float_linear");
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const VS = "#version 300 es\nin vec2 a_uv;\nin vec2 a_pos;\nout vec2 v_uv;\nvoid main() {\n  v_uv = a_uv;\n  gl_Position = vec4(a_pos, 0.0, 1.0);\n  gl_PointSize = 1.0;\n}\n";
  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile failed");
    return s;
  }
  function texture(t) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, t.w, t.h, 0, gl.RGBA, gl.FLOAT, new Float32Array(t.data));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  const blank = texture({ w: 1, h: 1, data: [0, 0, 0, 0] });
  const results = [];
  for (const c of job.cases) {
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, c.fs));
      gl.bindAttribLocation(prog, 0, "a_uv");
      gl.bindAttribLocation(prog, 1, "a_pos");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
      const n = c.uvs.length / 2;
      const W = Math.min(n, 256), H = Math.ceil(n / W);
      const target = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("RGBA32F target incomplete");
      const pos = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        pos[2 * i] = ((i % W) + 0.5) / W * 2 - 1;
        pos[2 * i + 1] = (Math.floor(i / W) + 0.5) / H * 2 - 1;
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const b0 = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b0);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(c.uvs), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const b1 = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b1);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.useProgram(prog);
      const made = [];
      ["u_a", "u_b", "u_c", "u_d"].forEach((u, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        const t = c.textures[u];
        const tex = t ? texture(t) : blank;
        if (t) made.push(tex);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, u), i);
      });
      c.luts.forEach((l, i) => {
        gl.activeTexture(gl.TEXTURE0 + 4 + i);
        const tex = texture(l);
        made.push(tex);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, l.name), 4 + i);
      });
      for (const u of c.uniforms) {
        const loc = gl.getUniformLocation(prog, u.name);
        if (u.kind === "1f") gl.uniform1f(loc, u.v[0]);
        else if (u.kind === "1i") gl.uniform1i(loc, u.v[0]);
        else if (u.kind === "2f") gl.uniform2f(loc, u.v[0], u.v[1]);
        else gl.uniform4f(loc, u.v[0], u.v[1], u.v[2], u.v[3]);
      }
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, n);
      const px = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
      const out = [];
      for (let i = 0; i < n * 4; i++) out.push(Number.isFinite(px[i]) ? px[i] : null);
      results.push({ name: c.name, out });
      for (const t of made) gl.deleteTexture(t);
      gl.deleteTexture(target);
      gl.deleteFramebuffer(fbo);
      gl.deleteBuffer(b0);
      gl.deleteBuffer(b1);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
    } catch (e) {
      results.push({ name: c.name, error: String((e && e.message) || e) });
    }
  }
  return { renderer, results };
}`;

const MAIN = String.raw`const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const [pagePath, jobPath, outPath] = process.argv.slice(-3);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
if (process.env.TBX_PARITY_GL === "swiftshader") {
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}
const done = (obj, code) => { fs.writeFileSync(outPath, JSON.stringify(obj)); app.exit(code); };
setTimeout(() => done({ fatal: "timed out after 90 s" }, 1), 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false } });
  await win.loadURL("data:text/html,<!doctype html><title>shader parity</title>");
  const page = fs.readFileSync(pagePath, "utf8");
  const job = fs.readFileSync(jobPath, "utf8");
  done(await win.webContents.executeJavaScript("(" + page + ")(" + job + ")"), 0);
}).catch((e) => done({ fatal: String((e && e.stack) || e) }, 1));
`;

type GlResult = { renderer?: string; fatal?: string; results?: { name: string; out?: (number | null)[]; error?: string }[] };

function runGl(cases: GlCase[]): GlResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbx-parity-gl-"));
  try {
    const main = path.join(dir, "main.cjs");
    const page = path.join(dir, "page.js");
    const job = path.join(dir, "job.json");
    const out = path.join(dir, "out.json");
    fs.writeFileSync(main, MAIN);
    fs.writeFileSync(page, PAGE);
    fs.writeFileSync(job, JSON.stringify({ cases }));
    let electron: string;
    try {
      electron = createRequire(import.meta.url)("electron") as unknown as string;
    } catch {
      return { fatal: "electron is not installed" };
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [main, page, job, out], { env, encoding: "utf8", timeout: 120_000 });
    if (!fs.existsSync(out)) return { fatal: `electron exited ${r.status} without a result: ${(r.stderr ?? "").slice(-800)}` };
    return JSON.parse(fs.readFileSync(out, "utf8")) as GlResult;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

function sampleUvs(): number[] {
  const uvs: number[] = [];
  const G = 24;
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) uvs.push(Math.fround((x + 0.5) / G), Math.fround((y + 0.5) / G));
  uvs.push(0, 0, 1, 1, 0.5, 0.5, Math.fround(0.999), Math.fround(0.001), Math.fround(0.3141), Math.fround(0.2718));
  return uvs;
}

function image(fn: (u: number, v: number) => Rgba, w = 32, h = 24): { w: number; h: number; data: number[] } {
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.push(...fn((x + 0.5) / w, (y + 0.5) / h).map(f16));
  return { w, h, data };
}

function withValues(inputs: ExprInput[], set: Record<string, unknown> | undefined): ExprInput[] {
  if (!set) return inputs;
  return inputs.map((e) => (e.name in set ? { ...e, default: set[e.name] as ExprInput["default"] } : e));
}

// The uniforms glsl-expression.ts compute() binds, from the node's channel rows.
function glUniforms(inputs: ExprInput[], c: ParityCase): { uniforms: GlCase["uniforms"]; luts: GlCase["luts"] } {
  const res = c.res ?? [64, 64];
  const uniforms: GlCase["uniforms"] = [
    { name: "u_res", kind: "2f", v: res },
    { name: "u_time", kind: "1f", v: [c.time ?? 0] },
    { name: "u_frame", kind: "1f", v: [c.frame ?? 0] },
    { name: "u_aspect", kind: "1f", v: [res[0] / res[1]] },
  ];
  const luts: GlCase["luts"] = [];
  for (const e of inputs) {
    const v = readChannelValue(e, undefined);
    switch (channelKind(e)) {
      case "scalar":
        uniforms.push({ name: e.name, kind: "1f", v: [typeof v === "number" ? v : 0] });
        break;
      case "toggle":
        uniforms.push({ name: e.name, kind: "1i", v: [v === true ? 1 : 0] });
        break;
      case "enum":
        uniforms.push({ name: e.name, kind: "1i", v: [Math.max(0, (e.options ?? []).indexOf(String(v)))] });
        break;
      case "color":
        uniforms.push({ name: e.name, kind: "4f", v: v as number[] });
        break;
      case "ramp":
        luts.push({ name: `u_ramp_${e.name}`, w: 256, h: 1, data: Array.from(buildRampLut(v as ColorRampStop[]), f16) });
        break;
      case "curve":
        luts.push({ name: `u_curve_${e.name}`, w: 256, h: 1, data: Array.from(buildCurveLut(v as CurvePoint[]), f16) });
        break;
    }
  }
  return { uniforms, luts };
}

// The host's uniforms, from the BUNDLE (slots, defaults, LUT data).
function probeUniforms(b: AeShaderBundle, c: ParityCase) {
  const res = c.res ?? [64, 64];
  const sliders = new Array(32).fill(0);
  const colors = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
  const checkboxes = new Array(8).fill(0);
  for (const p of b.params) {
    if (p.kind === "slider") sliders[p.slot - 1] = p.default as number;
    else if (p.kind === "color") colors[p.slot - 1] = p.default as number[];
    else if (p.kind === "checkbox") checkboxes[p.slot - 1] = p.default ? 1 : 0;
  }
  return { res: res as [number, number], time: c.time ?? 0, frame: c.frame ?? 0, aspect: res[0] / res[1], sliders, colors, checkboxes };
}

// max / p99 of |GL − MSL| over every component; non-finite mismatches apart.
function diff(ref: (number | null)[], got: (number | null)[], uvs: number[]) {
  const ds: number[] = [];
  let max = 0;
  let maxRel = 0;
  let at = -1;
  let nan = 0;
  for (let i = 0; i < ref.length; i++) {
    const a = ref[i];
    const b = got[i];
    if (a === null || b === null) {
      if (a !== b) {
        nan++;
        if (process.env.TBX_PARITY_DEBUG) console.log(`    non-finite at uv ${uvs[2 * (i >> 2)]},${uvs[2 * (i >> 2) + 1]} ch ${"rgba"[i & 3]}: GL ${a} MSL ${b}`);
      }
      continue;
    }
    const d = Math.abs(a - b);
    ds.push(d);
    maxRel = Math.max(maxRel, d / Math.max(1, Math.abs(a)));
    if (d > max) {
      max = d;
      at = i;
    }
  }
  ds.sort((x, y) => x - y);
  const p99 = ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.99))] : 0;
  const where = at >= 0 ? `uv ${uvs[2 * (at >> 2)].toFixed(4)},${uvs[2 * (at >> 2) + 1].toFixed(4)} ch ${"rgba"[at & 3]}: GL ${ref[at]} vs MSL ${got[at]}` : "—";
  return { max, maxRel, p99, nan, where };
}

export default async function run(): Promise<number> {
  const c = makeChecker("shader-parity");
  if (process.platform !== "darwin") {
    console.log(`  note shader parity needs Metal (macOS); skipped on ${process.platform}`);
    return 0;
  }
  const built = buildMslCompile({ repoRoot: ROOT });
  if (!built.ok) {
    if ("skipped" in built) {
      console.log(`  note shader parity skipped: ${built.skipped}`);
      return 0;
    }
    c.check("msl-compile builds", false, built.error);
    return c.failures;
  }

  const uvs = sampleUvs();
  const prepared = CASES.map((pc) => {
    const inputs = withValues(syncChannelInputs([], pc.body), pc.set);
    const params = { inputs, expression: pc.body };
    const bundle = bundleFromGlslExpression(params, {
      name: pc.name,
      fps: 30,
      loopFrames: 0,
      canvas: { width: pc.res?.[0] ?? 64, height: pc.res?.[1] ?? 64 },
    });
    const textures: GlCase["textures"] = {};
    for (const [slot, fn] of Object.entries(pc.images ?? {})) textures[`u_${slot}`] = image(fn!);
    const gl: GlCase = { name: pc.name, fs: glslExpressionSource(params), uvs, ...glUniforms(inputs, pc), textures };
    return { pc, bundle, gl };
  });

  const glOut = runGl(prepared.map((p) => p.gl));
  if (glOut.fatal || !glOut.results) {
    // No GL in this session (headless runner, no Electron) is an
    // environment gap, not a translation failure.
    console.log(`  note shader parity skipped: WebGL2 reference unavailable (${glOut.fatal})`);
    return 0;
  }
  console.log(`  reference: WebGL2 · ${glOut.renderer}`);
  console.log(`  candidate: Metal probe · ${built.device} (MathModeSafe, precise functions, MSL 3.0)`);
  console.log(`  ${uvs.length / 2} uvs per case (24×24 pixel-centre grid + 5 extra points)`);

  const results: { name: string; host: number; p99: number; fast: number; fastRel: number }[] = [];
  for (const { pc, bundle, gl } of prepared) {
    if (!bundle.ok) {
      c.check(`${pc.name}: bundle builds`, false, bundle.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
      continue;
    }
    const ref = glOut.results.find((r) => r.name === pc.name);
    if (!ref?.out) {
      c.check(`${pc.name}: WebGL2 renders the GLSL`, false, ref?.error ?? "no result");
      continue;
    }
    const textures: (ProbeTexture | null)[] = new Array(12).fill(null);
    (["a", "b", "c", "d"] as const).forEach((s, i) => {
      const t = gl.textures[`u_${s}`];
      if (t) textures[i] = { ...t, format: "rgba16f" };
    });
    (bundle.bundle.luts ?? []).forEach((l, i) => (textures[4 + i] = { w: l.width, h: 1, data: l.data.map(f16), format: "rgba16f" }));
    const job = { uniforms: probeUniforms(bundle.bundle, pc), textures, uvs };
    const host = probeShade(built.bin, bundle.bundle.source.msl!, job);
    const fast = probeShade(built.bin, bundle.bundle.source.msl!, { ...job, fastMath: true });
    if (!host.ok || !fast.ok) {
      c.check(`${pc.name}: Metal runs the translated MSL`, false, (!host.ok ? host.log : !fast.ok ? fast.log : "").slice(0, 1500));
      continue;
    }
    const h = diff(ref.out, host.out, uvs);
    const f = diff(ref.out, fast.out, uvs);
    const label =
      `${pc.name}: host IEEE max |Δ| ${h.max.toExponential(2)} (p99 ${h.p99.toExponential(1)}) ≤ ${pc.tol.toExponential(0)}` +
      ` · fast-math max rel ${f.maxRel.toExponential(2)} ≤ ${FAST_REL_TOL.toExponential(0)}${pc.why ? ` — ${pc.why}` : ""}`;
    c.check(
      label,
      h.max <= pc.tol && h.nan === 0 && f.maxRel <= FAST_REL_TOL && f.nan === 0,
      `host: ${h.nan} non-finite mismatches, worst ${h.where}; fast-math: ${f.nan} non-finite, worst ${f.where}`
    );
    results.push({ name: pc.name, host: h.max, p99: h.p99, fast: f.max, fastRel: f.maxRel });
  }
  if (process.env.TBX_PARITY_JSON) fs.writeFileSync(process.env.TBX_PARITY_JSON, JSON.stringify(results, null, 2));
  return c.failures;
}
