// The WebGL2 reference side of the shader parity gates (check-shader-parity,
// check-shader-nodes): Electron draws one POINT per sample uv, so v_uv is the
// vertex's value exactly, into an RGBA32F target, and reads it back. Plain
// helpers, not a gate (check-ae-export runs check-*.mts only).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type Rgba = [number, number, number, number];

export const f16: (x: number) => number =
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

// ---------------------------------------------------------------------------
// Reference: WebGL2 in Electron
// ---------------------------------------------------------------------------

export interface GlCase {
  name: string;
  fs: string;
  uvs: number[];
  uniforms: { name: string; kind: "1f" | "2f" | "3f" | "4f" | "1i" | "2i" | "3i" | "4i"; v: number[] }[];
  // Sampler name → texture. u_a..u_d always get a unit (1×1 transparent
  // when absent); any other name gets the next one.
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
      const samplers = ["u_a", "u_b", "u_c", "u_d"];
      for (const n of Object.keys(c.textures)) if (!samplers.includes(n)) samplers.push(n);
      samplers.forEach((u, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        const t = c.textures[u];
        const tex = t ? texture(t) : blank;
        if (t) made.push(tex);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, u), i);
      });
      c.luts.forEach((l, i) => {
        gl.activeTexture(gl.TEXTURE0 + samplers.length + i);
        const tex = texture(l);
        made.push(tex);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, l.name), samplers.length + i);
      });
      for (const u of c.uniforms) {
        const loc = gl.getUniformLocation(prog, u.name);
        gl["uniform" + u.kind + "v"](loc, u.kind.endsWith("i") ? new Int32Array(u.v) : new Float32Array(u.v));
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

export type GlResult = { renderer?: string; fatal?: string; results?: { name: string; out?: (number | null)[]; error?: string }[] };

export function runGl(cases: GlCase[]): GlResult {
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

export function sampleUvs(): number[] {
  const uvs: number[] = [];
  const G = 24;
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) uvs.push(Math.fround((x + 0.5) / G), Math.fround((y + 0.5) / G));
  uvs.push(0, 0, 1, 1, 0.5, 0.5, Math.fround(0.999), Math.fround(0.001), Math.fround(0.3141), Math.fround(0.2718));
  return uvs;
}

export function image(fn: (u: number, v: number) => Rgba, w = 32, h = 24): { w: number; h: number; data: number[] } {
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.push(...fn((x + 0.5) / w, (y + 0.5) / h).map(f16));
  return { w, h, data };
}


// max / p99 of |GL − MSL| over every component; non-finite mismatches apart.
export function diff(ref: (number | null)[], got: (number | null)[], uvs: number[]) {
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

