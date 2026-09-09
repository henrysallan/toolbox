import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { buildPath2D } from "@/engine/spline-raster";
import { pushMediaSettle } from "@/engine/offline-settle";
import {
  EMPTY_SPLINE,
  ensureTraceBackend,
  fitTraceSize,
  traceBackendReady,
  traceRgba,
  type ImageTraceOptions,
  type PotraceTurnpolicy,
  type TraceEngine,
  type VtracerClustering,
  type VtracerHierarchical,
  type VtracerPathMode,
} from "@/engine/image-trace";

// Image Trace — raster → spline via Potrace (B&W silhouette) or VTracer
// (color clustering, WASM). Both backends load lazily; compute returns the
// last finished result (empty on a cold start) and pipeline-bumps when the
// trace lands. Offline export settles the in-flight promise so frames are
// exact. Fill color is stamped on each subpath as attrs.color + driver.

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface PreviewState {
  canvas: HTMLCanvasElement;
  tex: WebGLTexture | null;
}

interface TraceState {
  preview: PreviewState | null;
  result: SplineValue;
  resultKey: string;
  busyKey: string | null;
  gen: number;
}

function stateKey(nodeId: string): string {
  return `image-trace:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): TraceState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as TraceState | undefined;
  if (existing) return existing;
  const s: TraceState = {
    preview: null,
    result: EMPTY_SPLINE,
    resultKey: "",
    busyKey: null,
    gen: 0,
  };
  ctx.state[key] = s;
  return s;
}

function ensurePreview(ctx: RenderContext, state: TraceState): PreviewState {
  if (state.preview) return state.preview;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("image-trace: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const preview: PreviewState = {
    canvas: document.createElement("canvas"),
    tex,
  };
  state.preview = preview;
  return preview;
}

function colorCss(fill: number | number[] | undefined): string {
  if (!Array.isArray(fill) || fill.length < 3) return "rgb(0,0,0)";
  const r = Math.round(Math.min(1, Math.max(0, fill[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, fill[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, fill[2])) * 255);
  return `rgb(${r},${g},${b})`;
}

function renderPreview(
  ctx: RenderContext,
  state: TraceState,
  spline: SplineValue
): ImageValue {
  const W = ctx.width;
  const H = ctx.height;
  const preview = ensurePreview(ctx, state);
  const canvas = preview.canvas;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const c2d = canvas.getContext("2d");
  if (c2d) {
    c2d.clearRect(0, 0, W, H);
    for (const sub of spline.subpaths) {
      const path = buildPath2D([sub], W, H, true);
      if (!path) continue;
      c2d.fillStyle = colorCss(sub.attrs?.color);
      c2d.fill(path, "evenodd");
    }
    const gl = ctx.gl;
    gl.bindTexture(gl.TEXTURE_2D, preview.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      canvas
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  const image = ctx.allocImage();
  const prog = ctx.getShader("image-trace/blit", BLIT_FS);
  ctx.drawFullscreen(prog, image, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, preview.tex);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
  });
  return image;
}

function parseEngine(raw: unknown): TraceEngine {
  return raw === "vtracer" ? "vtracer" : "potrace";
}

function parseTurnpolicy(raw: unknown): PotraceTurnpolicy {
  const v = typeof raw === "string" ? raw : "";
  if (
    v === "black" ||
    v === "white" ||
    v === "left" ||
    v === "right" ||
    v === "majority"
  ) {
    return v;
  }
  return "minority";
}

function readOptions(params: Record<string, unknown>): ImageTraceOptions {
  return {
    engine: parseEngine(params.mode),
    invert: params.invert === true,
    threshold: (params.threshold as number) ?? 0.5,
    turdsize: (params.turdsize as number) ?? 2,
    alphamax: (params.alphamax as number) ?? 1,
    opttolerance: (params.opttolerance as number) ?? 0.2,
    turnpolicy: parseTurnpolicy(params.turnpolicy),
    clustering:
      params.clustering === "bw" ? "bw" : ("color" as VtracerClustering),
    hierarchical:
      params.hierarchical === "cutout"
        ? "cutout"
        : ("stacked" as VtracerHierarchical),
    filterSpeckle: (params.filter_speckle as number) ?? 4,
    colorPrecision: (params.color_precision as number) ?? 6,
    layerDifference: (params.layer_difference as number) ?? 16,
    cornerThreshold: (params.corner_threshold as number) ?? 60,
    pathMode:
      params.path_mode === "polygon" ? "polygon" : ("spline" as VtracerPathMode),
  };
}

function hashPixels(buf: Uint8ClampedArray): string {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i], 16777619);
  return (h >>> 0).toString(16);
}

function bump(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

export const imageTraceNode: NodeDefinition = {
  type: "image-trace",
  name: "Image Trace",
  category: "image",
  subcategory: "utility",
  searchAliases: ["vectorize", "potrace", "vtracer", "autotrace", "bitmap"],
  description:
    "Trace a raster into splines. Potrace fits a binary silhouette; VTracer (WASM) clusters color regions. Fill color is stamped on each subpath as color + driver.",
  facts: {
    space: {
      "param:max_size": "pixels",
      "param:turdsize": "pixels",
      "param:filter_speckle": "pixels",
    },
    writes: ["attr:color", "attr:driver"],
    gotchas: [
      "mode=potrace traces a binary silhouette (darker-than-threshold, after invert); mode=vtracer clusters color (clustering=color) or thresholds (clustering=bw).",
      "max_size, turdsize, and filter_speckle are in the downsampled trace pixel grid, not canvas pixels, so raising output resolution does not add detail unless max_size is raised too.",
      "Until the chosen WASM backend finishes loading, the node emits an empty spline and re-evaluates via a pipeline-bump once ready; offline export waits on the in-flight trace.",
      "attrs.color is 0–1 RGB from the SVG fill; driver is Rec.709 luminance of that fill. Cutout holes become separate subpaths (evenodd is not preserved on the spline wire).",
    ],
  },
  backend: "webgl2",
  noMaskBase: true,
  headerControl: { paramName: "mode" },
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "mode",
      label: "Engine",
      type: "enum",
      options: ["potrace", "vtracer"],
      optionLabels: { potrace: "Potrace", vtracer: "VTracer" },
      default: "potrace",
      control: "segmented",
    },
    {
      name: "max_size",
      label: "Max size (px)",
      type: "scalar",
      min: 32,
      max: 2048,
      softMax: 1024,
      step: 1,
      default: 512,
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) =>
        p.mode !== "vtracer" || p.clustering === "bw",
    },
    {
      name: "turdsize",
      label: "Suppress specks",
      type: "scalar",
      min: 0,
      max: 100,
      softMax: 20,
      step: 1,
      default: 2,
      visibleIf: (p) => p.mode !== "vtracer",
    },
    {
      name: "alphamax",
      label: "Corner (α max)",
      type: "scalar",
      min: 0,
      max: 1.334,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "vtracer",
    },
    {
      name: "opttolerance",
      label: "Curve tolerance",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
      visibleIf: (p) => p.mode !== "vtracer",
    },
    {
      name: "turnpolicy",
      label: "Turn policy",
      type: "enum",
      options: ["minority", "majority", "black", "white", "left", "right"],
      default: "minority",
      visibleIf: (p) => p.mode !== "vtracer",
    },
    {
      name: "clustering",
      label: "Clustering",
      type: "enum",
      options: ["color", "bw"],
      optionLabels: { color: "Color", bw: "B&W" },
      default: "color",
      control: "segmented",
      visibleIf: (p) => p.mode === "vtracer",
    },
    {
      name: "hierarchical",
      label: "Stacking",
      type: "enum",
      options: ["stacked", "cutout"],
      optionLabels: { stacked: "Stacked", cutout: "Cutout" },
      default: "stacked",
      visibleIf: (p) => p.mode === "vtracer",
    },
    {
      name: "path_mode",
      label: "Fit",
      type: "enum",
      options: ["spline", "polygon"],
      optionLabels: { spline: "Spline", polygon: "Polygon" },
      default: "spline",
      control: "segmented",
      visibleIf: (p) => p.mode === "vtracer",
    },
    {
      name: "filter_speckle",
      label: "Filter speckle",
      type: "scalar",
      min: 0,
      max: 128,
      softMax: 16,
      step: 1,
      default: 4,
      visibleIf: (p) => p.mode === "vtracer",
    },
    {
      name: "color_precision",
      label: "Color precision",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 6,
      visibleIf: (p) => p.mode === "vtracer" && p.clustering !== "bw",
    },
    {
      name: "layer_difference",
      label: "Layer difference",
      type: "scalar",
      min: 0,
      max: 128,
      softMax: 32,
      step: 1,
      default: 16,
      visibleIf: (p) => p.mode === "vtracer" && p.clustering !== "bw",
    },
    {
      name: "corner_threshold",
      label: "Corner (°)",
      type: "scalar",
      min: 0,
      max: 90,
      step: 1,
      default: 60,
      visibleIf: (p) => p.mode === "vtracer",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "image", type: "image" }],

  fingerprintExtras: (params, ctx, nodeId) => {
    const ready = traceBackendReady(parseEngine(params.mode)) ? "1" : "0";
    if (!nodeId) return ready;
    const s = ctx.state[stateKey(nodeId)] as TraceState | undefined;
    return `${ready}:${s?.gen ?? 0}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const img = inputs.image;
    const state = ensureState(ctx, nodeId);
    const empty = (): { primary: SplineValue; aux: { image: ImageValue } } => {
      const image = ctx.allocImage();
      ctx.clearTarget(image, [0, 0, 0, 0]);
      return { primary: EMPTY_SPLINE, aux: { image } };
    };
    if (!img || img.kind !== "image") return empty();

    const opts = readOptions(params);
    const maxSize = (params.max_size as number) ?? 512;
    const { w, h } = fitTraceSize(img.width, img.height, maxSize);
    const pixels = ctx.readImagePixels(img, w, h);
    if (!pixels) return empty();
    const copy = new Uint8ClampedArray(pixels);
    const jobKey = `${opts.engine}:${w}x${h}:${hashPixels(copy)}:${JSON.stringify(opts)}`;

    const emit = (spline: SplineValue) => ({
      primary: spline,
      aux: { image: renderPreview(ctx, state, spline) },
    });

    if (state.resultKey === jobKey) {
      return emit(state.result);
    }

    if (!traceBackendReady(opts.engine)) {
      ensureTraceBackend(opts.engine)
        .then(() => bump())
        .catch((err) =>
          console.warn("[image-trace] backend failed to load:", err)
        );
      if (state.result.subpaths.length > 0) return emit(state.result);
      return empty();
    }

    if (state.busyKey === jobKey) {
      if (state.result.subpaths.length > 0) return emit(state.result);
      return empty();
    }

    state.busyKey = jobKey;
    const work = traceRgba(copy, w, h, ctx.width, ctx.height, opts)
      .then((spline) => {
        if (state.busyKey !== jobKey) return;
        state.result = spline;
        state.resultKey = jobKey;
        state.busyKey = null;
        state.gen++;
        bump();
      })
      .catch((err) => {
        if (state.busyKey === jobKey) state.busyKey = null;
        console.warn("[image-trace] trace failed:", err);
        bump();
      });
    if (ctx.offline) pushMediaSettle(ctx, work);

    if (state.result.subpaths.length > 0) return emit(state.result);
    return empty();
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as TraceState | undefined;
    if (state?.preview?.tex) ctx.gl.deleteTexture(state.preview.tex);
    delete ctx.state[key];
  },
};

