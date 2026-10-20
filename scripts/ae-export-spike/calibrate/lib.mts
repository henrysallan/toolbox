// Shared plumbing for the effect calibration (spec 091926_after-effects-handoff.md §14):
// the test images, both renderers, and the metrics.
//
// Test images hold 8-bit values (k/255) written as 16-bit PNGs (k·257), so an
// 8 bpc and a 16 bpc After Effects project and toolbox's float upload all see
// exactly the same input.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { compareRgba, type CompareMetrics } from "@/lib/glsl-translation/compare";
import { REPO, readAeFrame, renderQueue, renderedFile, runAeJob, toRgba8, type FloatImage } from "./ae.mts";
import type { TbxRender } from "./tbx-page";

export type { FloatImage };
export { toRgba8 };

// ---- images ----------------------------------------------------------------

export function blank(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height * 4), bits: 16 };
}

const q8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;

export function fill(img: FloatImage, f: (x: number, y: number) => [number, number, number, number]): FloatImage {
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const p = f(x, y);
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 4; c++) img.data[o + c] = q8(p[c]);
    }
  return img;
}

// Deterministic PRNG (mulberry32).
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth multi-octave value noise in color: "photo-like" texture.
export function noiseImage(w: number, h: number, seed = 7): FloatImage {
  const R = rng(seed);
  const octaves = [64, 24, 9, 3].map((cell) => {
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const g = Array.from({ length: gw * gh * 3 }, () => R());
    return { cell, gw, g };
  });
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return fill(blank(w, h), (x, y) => {
    const rgb = [0, 0, 0];
    let wsum = 0;
    octaves.forEach((o, k) => {
      const wt = [0.5, 0.25, 0.15, 0.1][k];
      wsum += wt;
      const fx = x / o.cell;
      const fy = y / o.cell;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = smooth(fx - ix);
      const ty = smooth(fy - iy);
      for (let c = 0; c < 3; c++) {
        const v = (i: number, j: number) => o.g[((j * o.gw + i) * 3 + c) % o.g.length];
        const a = v(ix, iy) * (1 - tx) + v(ix + 1, iy) * tx;
        const b = v(ix, iy + 1) * (1 - tx) + v(ix + 1, iy + 1) * tx;
        rgb[c] += wt * (a * (1 - ty) + b * ty);
      }
    });
    return [rgb[0] / wsum, rgb[1] / wsum, rgb[2] / wsum, 1];
  });
}

export function discImage(w: number, h: number, r: number, opts: { transparent?: boolean; color?: [number, number, number] } = {}): FloatImage {
  const col = opts.color ?? [1, 1, 1];
  return fill(blank(w, h), (x, y) => {
    const inside = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) < r;
    if (opts.transparent) return inside ? [col[0], col[1], col[2], 1] : [0, 0, 0, 0];
    return inside ? [col[0], col[1], col[2], 1] : [0, 0, 0, 1];
  });
}

export function gridImage(w: number, h: number, step = 16): FloatImage {
  return fill(blank(w, h), (x, y) => (x % step === step / 2 || y % step === step / 2 ? [1, 1, 1, 1] : [0, 0, 0, 1]));
}

// A horizontal grey ramp 0 → 1 (every 8-bit level across 256+ px).
export function rampImage(w: number, h: number): FloatImage {
  return fill(blank(w, h), (x) => {
    const v = x / (w - 1);
    return [v, v, v, 1];
  });
}

// Hue across x, value top (1) → bottom (0.1) on full saturation in the top
// half, saturation falling to 0 in the bottom half: every hue, many lightnesses.
export function colorsImage(w: number, h: number): FloatImage {
  return fill(blank(w, h), (x, y) => {
    const hue = (x / w) * 6;
    const t = y / (h - 1);
    const sat = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
    const val = t < 0.5 ? 1 - t * 1.6 + 0.0 : 0.2 + (t - 0.5) * 1.6;
    const k = (n: number) => {
      const m = (n + hue) % 6;
      return val * (1 - sat * Math.max(0, Math.min(m, 4 - m, 1)));
    };
    return [k(5), k(3), k(1), 1];
  });
}

// One white 1-px vertical line on black: the horizontal impulse response.
export function lineImage(w: number, h: number, x0 = Math.floor(w / 2)): FloatImage {
  return fill(blank(w, h), (x) => (x === x0 ? [1, 1, 1, 1] : [0, 0, 0, 1]));
}

// 16-bit RGBA PNG, unfiltered (sharp narrows 16-bit raw input to 8 bits).
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  let c = 0xffffffff;
  for (const b of Buffer.concat([head.subarray(4), data])) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}
export async function writePng16(img: FloatImage, path: string) {
  const { width: w, height: h } = img;
  const raw = Buffer.alloc(h * (1 + w * 8));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 8);
    raw[o] = 0;
    for (let i = 0; i < w * 4; i++) raw.writeUInt16BE(Math.round(img.data[y * w * 4 + i] * 65535), o + 1 + i * 2);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 6; // RGBA
  writeFileSync(
    path,
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
  );
}

export function writeF32(img: FloatImage, path: string) {
  writeFileSync(path, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
}

export function readF32(path: string, width: number, height: number): FloatImage {
  const b = readFileSync(path);
  const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  if (data.length !== width * height * 4) throw new Error(`${path}: ${data.length} floats, want ${width * height * 4}`);
  return { width, height, data, bits: 16 };
}

// ---- After Effects ------------------------------------------------------------

export interface AeLayer {
  name: string;
  image?: string;
  sequence?: string;
  solid?: [number, number, number];
  hidden?: boolean;
  quality?: "best" | "draft";
  effects?: { match: string; props: Record<string, unknown> }[];
}
export interface AeItem {
  name: string;
  w: number;
  h: number;
  fps?: number;
  dur?: number;
  frames: number[];
  layers: AeLayer[];
  readBack?: boolean;
}

// Builds and renders `items` in one project; returns "<name>_f<frame>" → image.
export async function renderAe(
  tag: string,
  items: AeItem[],
  opts: { work: string; bpc: 8 | 16; linearize?: boolean; workingSpace?: string; fps?: number; gpu?: "SOFTWARE" | "METAL" }
): Promise<{ images: Map<string, FloatImage>; facts: unknown }> {
  const dir = join(opts.work, `${tag}-ae${opts.bpc}${opts.linearize ? "-lin" : ""}${opts.gpu ? `-${opts.gpu.toLowerCase()}` : ""}`);
  const renders = join(dir, "renders");
  mkdirSync(renders, { recursive: true });
  const project = join(dir, `${tag}.aep`);
  const r = await runAeJob(tag, "fx.jsx", { project, renders, bpc: opts.bpc, linearize: opts.linearize, workingSpace: opts.workingSpace, items, fps: opts.fps, gpu: opts.gpu }, dir);
  if (r.out.errors?.length) console.log(`  AE ${tag}: ${r.out.errors.length} error(s): ${r.out.errors.slice(0, 4).join(" | ")}`);
  if (!existsSync(project)) throw new Error(`AE ${tag}: no project saved (${JSON.stringify(r.out.errors)})`);
  const rq = await renderQueue(project, dir);
  console.log(`  AE ${tag} ${opts.bpc} bpc${opts.linearize ? " linear" : ""}: build ${r.seconds.toFixed(1)} s, render ${rq.seconds.toFixed(1)} s (exit ${rq.code})`);
  const images = new Map<string, FloatImage>();
  for (const it of items)
    for (const f of it.frames) {
      const file = renderedFile(renders, `${it.name}_f${f}`);
      if (file) images.set(`${it.name}_f${f}`, await readAeFrame(file));
      else console.log(`  AE ${tag}: no render for ${it.name} f${f}`);
    }
  return { images, facts: { project: r.out.project, om: r.out.om, readBack: r.out.readBack, gpu: r.out.gpu, gpuBefore: r.out.gpuBefore, gpuTypes: r.out.gpuTypes } };
}

// ---- toolbox --------------------------------------------------------------------

export interface TbxInput {
  slot: string;
  frame?: number;
  image: FloatImage;
}

// Renders toolbox graphs on the given inputs; returns "<id>_f<frame>" → image.
export async function renderTbx(tag: string, size: { width: number; height: number }, inputs: TbxInput[], renders: TbxRender[], work: string, fps = 30): Promise<Map<string, FloatImage>> {
  const dir = join(work, `${tag}-tbx`);
  mkdirSync(dir, { recursive: true });
  const files = inputs.map((inp, i) => {
    const file = `in-${i}.f32`;
    writeF32(inp.image, join(dir, file));
    return { slot: inp.slot, frame: inp.frame ?? -1, file };
  });
  const jobPath = join(dir, "job.json");
  writeFileSync(jobPath, JSON.stringify({ size, fps, inputs: files, renders }));
  const out = join(dir, "out");
  const t0 = Date.now();
  const code = await new Promise<number>((res) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(join(REPO, "node_modules/.bin/electron"), [join(REPO, "scripts/ae-export-spike/calibrate/tbx-render.cjs"), "--job", jobPath, "--out", out], { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("close", (c) => {
      const log = Buffer.concat(chunks).toString();
      writeFileSync(join(dir, "electron.log"), log);
      if (c !== 0) console.log(log.split("\n").slice(-30).join("\n"));
      res(c ?? -1);
    });
  });
  if (code !== 0) throw new Error(`tbx-render ${tag} exited ${code} (log ${join(dir, "electron.log")})`);
  console.log(`  toolbox ${tag}: ${renders.length} render(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const done: { id: string; frame: number; file?: string; error?: string }[] = JSON.parse(readFileSync(join(out, "done.json"), "utf8"));
  const images = new Map<string, FloatImage>();
  for (const d of done) {
    if (d.file) images.set(`${d.id}_f${d.frame}`, readF32(d.file, size.width, size.height));
    else console.log(`  toolbox ${tag}: ${d.id} f${d.frame}: ${d.error}`);
  }
  return images;
}

// A one-node graph: calib-input → `type` with `params`.
export function oneNode(id: string, type: string, params: Record<string, unknown>, slot: string, extra?: { inputs?: Record<string, string> }): TbxRender {
  const nodes = [
    { id: "src", type: "calib-input", params: { slot } },
    { id: "fx", type, params },
  ];
  const edges = [{ id: "e0", source: "src", sourceHandle: "out:primary", target: "fx", targetHandle: "in:image" }];
  for (const [socket, s] of Object.entries(extra?.inputs ?? {})) {
    nodes.push({ id: `src-${socket}`, type: "calib-input", params: { slot: s } });
    edges.push({ id: `e-${socket}`, source: `src-${socket}`, sourceHandle: "out:primary", target: "fx", targetHandle: `in:${socket}` });
  }
  return { id, nodes, edges, target: "fx" } as TbxRender;
}

// ---- metrics --------------------------------------------------------------------

export interface Metrics {
  // compareRgba on the 8-bit straight readbacks.
  rgba: CompareMetrics;
  // Max |Δ| per RGB channel after clamping both to 0–1 (what an 8 / 16 bpc
  // render shows; toolbox's float targets can exceed 1).
  max01: number;
  // Float RGB over pixels where both alphas > 0.02: max / mean / rms |Δ|.
  maxAbs: number;
  meanAbs: number;
  rms: number;
}

export function metrics(a: FloatImage, b: FloatImage, crop = 0): Metrics {
  const w = a.width;
  const h = a.height;
  const sub = (img: FloatImage) => {
    if (!crop) return img;
    const W = w - 2 * crop;
    const H = h - 2 * crop;
    const d = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) d.set(img.data.subarray(((y + crop) * w + crop) * 4, ((y + crop) * w + crop + W) * 4), y * W * 4);
    return { width: W, height: H, data: d, bits: img.bits };
  };
  const A = sub(a);
  const B = sub(b);
  let mx = 0;
  let mx01 = 0;
  let sum = 0;
  let sq = 0;
  let n = 0;
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  for (let i = 0; i < A.width * A.height; i++) {
    if (A.data[i * 4 + 3] <= 0.02 || B.data[i * 4 + 3] <= 0.02) continue;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.data[i * 4 + c] - B.data[i * 4 + c]);
      if (d > mx) mx = d;
      const d01 = Math.abs(c01(A.data[i * 4 + c]) - c01(B.data[i * 4 + c]));
      if (d01 > mx01) mx01 = d01;
      sum += d;
      sq += d * d;
      n++;
    }
  }
  return { rgba: compareRgba(toRgba8(A), toRgba8(B), A.width, A.height), max01: mx01, maxAbs: mx, meanAbs: n ? sum / n : 0, rms: n ? Math.sqrt(sq / n) : 0 };
}

export const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d;

export function summary(m: Metrics) {
  return {
    meanAbs: round(m.rgba.meanAbs),
    p95Abs: round(m.rgba.p95Abs),
    alphaMeanAbs: round(m.rgba.alphaMeanAbs),
    verdict: m.rgba.verdict,
    max01: round(m.max01),
    floatMax: round(m.maxAbs),
    floatRms: round(m.rms),
  };
}

// One row of a float image (RGB averaged) — a 1-D profile.
export function row(img: FloatImage, y: number, channel = 0): number[] {
  const out: number[] = [];
  for (let x = 0; x < img.width; x++) out.push(img.data[(y * img.width + x) * 4 + channel]);
  return out;
}

export async function savePng(img: FloatImage, path: string) {
  await sharp(Buffer.from(toRgba8(img).buffer), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toFile(path);
}
