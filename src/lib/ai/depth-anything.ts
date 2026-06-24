// Monocular depth-estimation helper. Runs Depth Anything V2 entirely in the
// browser via Hugging Face Transformers.js (the `depth-estimation` pipeline).
//
// Mirrors lib/ai/bg-remove.ts: the runtime AND the model weights load lazily
// via dynamic import so the base bundle isn't burdened up front; loaded
// handles are cached by (model, dtype) (in-flight dedupe) so repeat runs skip
// the download (the runtime caches weights in IndexedDB). Inference prefers
// WebGPU and falls back to WASM if WebGPU is unavailable or the model fails
// to build on it.
//
// QUALITY (`dtype`): the runtime otherwise picks a quantized default (q8) that
// looks blocky. We expose the precision explicitly — fp32 (best) / fp16
// (WebGPU, near-best + faster) / q8 (fast, lower quality). On the WASM
// fallback fp16 isn't supported, so it degrades to fp32 there.
//
// FLICKER: Depth Anything outputs RELATIVE depth and the pipeline normalizes
// each frame to its own min/max, so absolute brightness drifts frame-to-frame
// on video. The live path (single frame) uses that per-frame `depth` image —
// fine in isolation. The BAKE path instead reads the raw `predicted_depth`
// tensor per frame (estimateDepthRaw) and the panel normalizes every frame to
// ONE global min/max (depthRawToPng) so a clip stays temporally stable.

export type DepthModelId = "v2-small" | "v2-base" | "v2-large";
export type DepthDtype = "fp32" | "fp16" | "q8";

// Raw depth, downsampled to bound the transient memory the panel holds while
// computing a global range across a bake (depth is low-frequency, so the cap
// costs negligible detail). Long edge ≈ this many px.
export const DEPTH_BAKE_MAX_EDGE = 1536;

export interface DepthProgress {
  // [0..1] when known (model-weight download); some phases are indeterminate
  // (running) — leave progress undefined there.
  phase: "loading-runtime" | "loading-model" | "running" | "done";
  progress?: number;
}

export interface DepthOptions {
  model: DepthModelId;
  dtype: DepthDtype;
  onProgress?: (p: DepthProgress) => void;
}

// Raw (un-normalized) depth for one frame, plus its own min/max — the panel
// aggregates these into a single global range across the whole bake.
export interface RawDepthFrame {
  data: Float32Array;
  width: number;
  height: number;
  min: number;
  max: number;
}

function modelRepo(id: DepthModelId): string {
  switch (id) {
    case "v2-base":
      return "onnx-community/depth-anything-v2-base";
    case "v2-large":
      return "onnx-community/depth-anything-v2-large";
    case "v2-small":
    default:
      return "onnx-community/depth-anything-v2-small";
  }
}

// The single-channel depth image the pipeline hands back (per-frame norm).
interface DepthRawImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}

// The raw float depth tensor (interpolated to input size by the pipeline).
interface DepthTensor {
  data: Float32Array;
  dims: number[];
}

// Minimal shape of the depth-estimation pipeline callable we rely on.
type DepthPipeline = (image: unknown) => Promise<{
  depth: DepthRawImage;
  predicted_depth: DepthTensor;
}>;

// Cache the loaded pipeline by `${model}:${dtype}`; subsequent runs against
// the same combo skip the load entirely.
const modelCache = new Map<string, DepthPipeline>();
const inFlight = new Map<string, Promise<DepthPipeline>>();

function webgpuAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!(navigator as unknown as { gpu?: unknown }).gpu
  );
}

async function loadModel(
  id: DepthModelId,
  dtype: DepthDtype,
  onProgress?: (p: DepthProgress) => void
): Promise<DepthPipeline> {
  const key = `${id}:${dtype}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    onProgress?.({ phase: "loading-runtime" });
    const tx = (await import(
      "@huggingface/transformers"
    )) as typeof import("@huggingface/transformers");
    tx.env.allowLocalModels = false;

    const repo = modelRepo(id);
    onProgress?.({ phase: "loading-model" });
    // Forward the runtime's weight-download progress (the long-tail wait on
    // first use; cached afterwards). Param typed `unknown` so it's assignable
    // to the pipeline's strict ProgressCallback (the union includes events
    // without a `progress` field) — read defensively.
    const progressCb = (p: unknown) => {
      const prog = (p as { progress?: number }).progress;
      if (typeof prog === "number") {
        onProgress?.({
          phase: "loading-model",
          progress: Math.min(1, Math.max(0, prog / 100)),
        });
      }
    };

    // Prefer WebGPU for inference speed; the weights are cached in IndexedDB
    // after the first attempt, so the WASM fallback re-build is cheap.
    let pipe: DepthPipeline | null = null;
    if (webgpuAvailable()) {
      try {
        pipe = (await tx.pipeline("depth-estimation", repo, {
          device: "webgpu",
          dtype,
          progress_callback: progressCb,
        })) as unknown as DepthPipeline;
      } catch {
        pipe = null;
      }
    }
    if (!pipe) {
      // WASM execution provider has no fp16 — fall back to fp32 there.
      const wasmDtype: DepthDtype = dtype === "fp16" ? "fp32" : dtype;
      pipe = (await tx.pipeline("depth-estimation", repo, {
        dtype: wasmDtype,
        progress_callback: progressCb,
      })) as unknown as DepthPipeline;
    }

    modelCache.set(key, pipe);
    return pipe;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

// Expand the pipeline's single-channel per-frame depth image to an RGBA
// grayscale canvas at the input's natural size.
function depthImageToCanvas(depth: DepthRawImage): HTMLCanvasElement {
  const { data, width, height } = depth;
  const channels = Math.max(1, depth.channels);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = data[i * channels];
    rgba[i * 4 + 0] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return putCanvas(rgba, width, height);
}

function putCanvas(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("depth-anything: 2d canvas unavailable");
  c.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

// Area-average downsample of a single-channel float buffer to fit within
// DEPTH_BAKE_MAX_EDGE, computing min/max over the result.
function downsampleRaw(
  src: Float32Array,
  w: number,
  h: number
): RawDepthFrame {
  const scale = Math.min(1, DEPTH_BAKE_MAX_EDGE / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  let out: Float32Array;
  if (nw === w && nh === h) {
    out = src instanceof Float32Array ? src.slice() : new Float32Array(src);
  } else {
    out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor((y * h) / nh);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor((x * w) / nw);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
        let sum = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx < x1; xx++) {
            sum += src[row + xx];
            n++;
          }
        }
        out[y * nw + x] = sum / Math.max(1, n);
      }
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  return { data: out, width: nw, height: nh, min, max };
}

// Single-frame depth as an ImageBitmap — the live-preview path (per-frame
// normalization; fine for one frame in isolation).
export async function estimateDepth(
  blob: Blob,
  options: DepthOptions
): Promise<ImageBitmap> {
  const pipe = await loadModel(options.model, options.dtype, options.onProgress);
  options.onProgress?.({ phase: "running" });
  const tx = (await import(
    "@huggingface/transformers"
  )) as typeof import("@huggingface/transformers");
  const rawIn = await tx.RawImage.fromBlob(blob);
  const out = await pipe(rawIn);
  const bitmap = await createImageBitmap(depthImageToCanvas(out.depth));
  options.onProgress?.({ phase: "done", progress: 1 });
  return bitmap;
}

// Single-frame RAW depth (downsampled) + its min/max — the bake path. The
// panel aggregates min/max across the whole range, then encodes each frame
// against that one global range via depthRawToPng.
export async function estimateDepthRaw(
  blob: Blob,
  options: DepthOptions
): Promise<RawDepthFrame> {
  const pipe = await loadModel(options.model, options.dtype, options.onProgress);
  options.onProgress?.({ phase: "running" });
  const tx = (await import(
    "@huggingface/transformers"
  )) as typeof import("@huggingface/transformers");
  const rawIn = await tx.RawImage.fromBlob(blob);
  const out = await pipe(rawIn);
  const t = out.predicted_depth;
  const dims = t.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  const frame = downsampleRaw(t.data, w, h);
  options.onProgress?.({ phase: "done", progress: 1 });
  return frame;
}

// Normalize one raw frame against a GLOBAL [gmin, gmax] range (higher depth =
// brighter, matching the live path's polarity) and encode an 8-bit grayscale
// PNG. Constant range across the bake = no temporal flicker.
export async function depthRawToPng(
  frame: RawDepthFrame,
  gmin: number,
  gmax: number
): Promise<Blob> {
  const range = Math.max(1e-6, gmax - gmin);
  const { data, width, height } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const n = Math.min(1, Math.max(0, (data[i] - gmin) / range));
    const v = Math.round(n * 255);
    rgba[i * 4 + 0] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const canvas = putCanvas(rgba, width, height);
  const png = await new Promise<Blob | null>((res) =>
    canvas.toBlob((b) => res(b), "image/png")
  );
  if (!png) throw new Error("depth-anything: failed to encode PNG");
  return png;
}
