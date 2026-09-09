import { aspectUncorrectY } from "./aspect";
import { parsePathData } from "@/lib/svg-parse";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";

// Image → spline tracing. Two backends share one SVG→SplineValue adapter:
//
//   Potrace  — esm-potrace-wasm (inlined emscripten build). Binary
//              silhouette; GPL-2.0, same class of dependency as
//              gifsicle-wasm-browser.
//   VTracer  — @visioncortex/vtracer WASM (MIT/Apache), lazy-fetched from
//              public/wasm/vtracer. Color clustering or binary.
//
// Both emit SVG path data in the source image's pixel space (Y-down). We
// map that onto authored canvas01 (aspectUncorrectY) so Rasterize / Stroke
// overlay the source. Fill color lands on each subpath as attrs.color
// (0–1 RGB) plus driver = Rec.709 luminance.

export const VTRACER_WASM_URL = "/wasm/vtracer/vtracer_wasm_bg.wasm";

export type TraceEngine = "potrace" | "vtracer";
export type VtracerClustering = "color" | "bw";
export type VtracerHierarchical = "stacked" | "cutout";
export type VtracerPathMode = "spline" | "polygon";
export type PotraceTurnpolicy =
  | "black"
  | "white"
  | "left"
  | "right"
  | "minority"
  | "majority";

export interface ImageTraceOptions {
  engine: TraceEngine;
  invert: boolean;
  // Luminance cutoff in [0, 1]. Potrace: binarize before tracing (dark =
  // foreground). VTracer clustering=bw: binaryThreshold 0–255.
  threshold: number;
  // Potrace
  turdsize: number;
  alphamax: number;
  opttolerance: number;
  turnpolicy: PotraceTurnpolicy;
  // VTracer
  clustering: VtracerClustering;
  hierarchical: VtracerHierarchical;
  filterSpeckle: number;
  colorPrecision: number;
  layerDifference: number;
  cornerThreshold: number;
  pathMode: VtracerPathMode;
}

export const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

const TURNPOLICY_CODE: Record<PotraceTurnpolicy, number> = {
  black: 0,
  white: 1,
  left: 2,
  right: 3,
  minority: 4,
  majority: 5,
};

type PotraceFn = (
  image: { data: Uint8ClampedArray; width: number; height: number },
  options?: Record<string, unknown>
) => Promise<string | string[]>;

let potraceFn: PotraceFn | null = null;
let potraceLoading: Promise<void> | null = null;
let vtracerReady = false;
let vtracerLoading: Promise<void> | null = null;
let vectorizeRgba:
  | ((
      data: Uint8Array,
      width: number,
      height: number,
      options?: unknown
    ) => string)
  | null = null;

export function potraceReady(): boolean {
  return potraceFn !== null;
}

export function vtracerReadyFlag(): boolean {
  return vtracerReady;
}

export function traceBackendReady(engine: TraceEngine): boolean {
  return engine === "vtracer" ? vtracerReady : potraceFn !== null;
}

export function ensurePotrace(): Promise<void> {
  if (potraceFn) return Promise.resolve();
  if (!potraceLoading) {
    potraceLoading = import("esm-potrace-wasm")
      .then(async (mod) => {
        await mod.init();
        potraceFn = mod.potrace as unknown as PotraceFn;
      })
      .catch((err) => {
        potraceLoading = null;
        throw err;
      });
  }
  return potraceLoading;
}

export function ensureVtracer(): Promise<void> {
  if (vtracerReady) return Promise.resolve();
  if (!vtracerLoading) {
    vtracerLoading = import("@/wasm/vtracer/vtracer").then(async (mod) => {
      await mod.default({ module_or_path: VTRACER_WASM_URL });
      vectorizeRgba = mod.vectorize_rgba;
      vtracerReady = true;
    })
      .catch((err) => {
        vtracerLoading = null;
        throw err;
      });
  }
  return vtracerLoading;
}

export function ensureTraceBackend(engine: TraceEngine): Promise<void> {
  return engine === "vtracer" ? ensureVtracer() : ensurePotrace();
}

// Node check scripts: init VTracer from the committed public/ wasm bytes.
export async function initVtracerFromBytes(bytes: BufferSource): Promise<void> {
  if (vtracerReady) return;
  const mod = await import("@/wasm/vtracer/vtracer");
  mod.initSync(bytes);
  vectorizeRgba = mod.vectorize_rgba;
  vtracerReady = true;
}

export function fitTraceSize(
  srcW: number,
  srcH: number,
  maxSize: number
): { w: number; h: number } {
  const cap = Math.max(8, Math.floor(maxSize));
  const long = Math.max(srcW, srcH);
  if (long <= cap) return { w: srcW, h: srcH };
  const s = cap / long;
  return {
    w: Math.max(1, Math.round(srcW * s)),
    h: Math.max(1, Math.round(srcH * s)),
  };
}

export function invertRgba(src: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255 - out[i];
    out[i + 1] = 255 - out[i + 1];
    out[i + 2] = 255 - out[i + 2];
  }
  return out;
}

// Straight-alpha luminance vs threshold. Transparent pixels are background
// (not traced). Darker-than-threshold is Potrace's foreground.
export function binarizeRgba(
  src: Uint8ClampedArray,
  threshold: number
): Uint8ClampedArray {
  const t = Math.min(1, Math.max(0, threshold));
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    const lum =
      (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
    // Composite over white so transparent pixels are background.
    const lumOnWhite = lum * a + (1 - a);
    const v = lumOnWhite < t ? 0 : 255;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

export function parseFillColor(raw: string | undefined): [number, number, number] {
  if (!raw || raw === "none") return [0, 0, 0];
  const s = raw.trim().toLowerCase();
  if (s === "black") return [0, 0, 0];
  if (s === "white") return [1, 1, 1];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16) / 255,
        parseInt(h[1] + h[1], 16) / 255,
        parseInt(h[2] + h[2], 16) / 255,
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (rgb) {
    return [
      Math.min(1, Number(rgb[1]) / 255),
      Math.min(1, Number(rgb[2]) / 255),
      Math.min(1, Number(rgb[3]) / 255),
    ];
  }
  return [0, 0, 0];
}

export function extractSvgPaths(
  svg: string
): { d: string; fill: [number, number, number] }[] {
  const out: { d: string; fill: [number, number, number] }[] = [];
  const re = /<path\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const d =
      /(?:^|\s)d="([^"]*)"/i.exec(attrs)?.[1] ??
      /(?:^|\s)d='([^']*)'/i.exec(attrs)?.[1];
    if (!d) continue;
    const fillAttr =
      /(?:^|\s)fill="([^"]*)"/i.exec(attrs)?.[1] ??
      /(?:^|\s)fill='([^']*)'/i.exec(attrs)?.[1] ??
      /fill:\s*([^;"'\s]+)/i.exec(attrs)?.[1];
    out.push({ d, fill: parseFillColor(fillAttr) });
  }
  return out;
}

function mapAnchor(
  a: SplineAnchor,
  imgW: number,
  imgH: number,
  aspect: number
): SplineAnchor {
  const toAuthored = (x: number, y: number): [number, number] => [
    x / imgW,
    aspectUncorrectY(y / imgH, aspect),
  ];
  const pos = toAuthored(a.pos[0], a.pos[1]);
  const rel = (h?: [number, number]): [number, number] | undefined => {
    if (!h) return undefined;
    const abs = toAuthored(a.pos[0] + h[0], a.pos[1] + h[1]);
    return [abs[0] - pos[0], abs[1] - pos[1]];
  };
  return {
    pos,
    ...(a.inHandle ? { inHandle: rel(a.inHandle) } : {}),
    ...(a.outHandle ? { outHandle: rel(a.outHandle) } : {}),
  };
}

export function svgToSpline(
  svg: string,
  imgW: number,
  imgH: number,
  canvasW: number,
  canvasH: number
): SplineValue {
  if (!svg || imgW < 1 || imgH < 1) return EMPTY_SPLINE;
  const aspect = canvasW / Math.max(1e-6, canvasH);
  const subpaths: SplineSubpath[] = [];
  for (const { d, fill } of extractSvgPaths(svg)) {
    const parsed = parsePathData(d);
    const driver = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2];
    for (const sub of parsed) {
      if (sub.anchors.length < 2) continue;
      subpaths.push({
        anchors: sub.anchors.map((a) => mapAnchor(a, imgW, imgH, aspect)),
        closed: sub.closed,
        attrs: { color: fill },
        driver,
      });
    }
  }
  return { kind: "spline", subpaths };
}

export async function traceRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  canvasW: number,
  canvasH: number,
  opts: ImageTraceOptions
): Promise<SplineValue> {
  const pixels = opts.invert ? invertRgba(rgba) : rgba;
  if (opts.engine === "potrace") {
    await ensurePotrace();
    if (!potraceFn) return EMPTY_SPLINE;
    const binary = binarizeRgba(pixels, opts.threshold);
    const svg = await potraceFn(
      { data: binary, width, height },
      {
        turdsize: opts.turdsize,
        turnpolicy: TURNPOLICY_CODE[opts.turnpolicy] ?? 4,
        alphamax: opts.alphamax,
        opticurve: 1,
        opttolerance: opts.opttolerance,
        pathonly: false,
        extractcolors: false,
      }
    );
    const text = Array.isArray(svg) ? svg.join("") : svg;
    return svgToSpline(text, width, height, canvasW, canvasH);
  }

  await ensureVtracer();
  if (!vectorizeRgba) return EMPTY_SPLINE;
  const clustering = opts.clustering === "bw" ? "bw" : "color-cluster";
  const svg = vectorizeRgba(
    new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width,
    height,
    {
      clustering,
      hierarchical: opts.hierarchical,
      mode: opts.pathMode,
      filterSpeckle: opts.filterSpeckle,
      colorPrecision: opts.colorPrecision,
      layerDifference: opts.layerDifference,
      cornerThreshold: opts.cornerThreshold,
      binaryThreshold: Math.round(
        Math.min(1, Math.max(0, opts.threshold)) * 255
      ),
    }
  );
  return svgToSpline(svg, width, height, canvasW, canvasH);
}
