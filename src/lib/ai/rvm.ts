// Robust Video Matting (RVM) — PeterLin's ONNX models running in the
// browser via onnxruntime-web.
//
// RVM is recurrent: each frame's ConvGRU states (r1..r4) must be fed back
// as the next frame's inputs. Independent per-frame inference works but
// throws away the temporal consistency the model is for. The bake path
// therefore walks the range sequentially and recycles those states.
//
// Weights load lazily (GitHub release ONNX, cached in Cache API). The
// runtime is a dynamic import so the base bundle doesn't pay for it.
// Spec: https://github.com/PeterL1n/RobustVideoMatting

export type RvmModelId = "rvm-mobilenetv3" | "rvm-resnet50";

export function isRvmModel(id: string): id is RvmModelId {
  return id === "rvm-mobilenetv3" || id === "rvm-resnet50";
}

export type RvmDownsample = "auto" | "0.125" | "0.25" | "0.375" | "0.5" | "1";

export interface RvmProgress {
  phase: "loading-runtime" | "loading-model" | "running" | "done";
  progress?: number;
}

// Opaque recurrent state — pass the object returned by one frame into the
// next. `null` means "start of sequence" (zero tensors of shape [1,1,1,1]).
export type RvmRecState = {
  r1: OrtTensor;
  r2: OrtTensor;
  r3: OrtTensor;
  r4: OrtTensor;
};

export interface RvmFrameOut {
  // Alpha packed as an ImageBitmap (R=G=B=pha*255) at the source's native
  // size, ready to upload / store as the live preview.
  bitmap: ImageBitmap;
  // PNG of the same mask — the bake cache stores these, not bitmaps.
  png: Blob;
  rec: RvmRecState;
  width: number;
  height: number;
}

// Official v1.0.0 ONNX (opset 12, fp32). GitHub release assets redirect to
// objects.githubusercontent.com which serves CORS. Cache API keeps a copy
// so the second bake on a device doesn't re-download ~14 MB.
const MODEL_URLS: Record<RvmModelId, string> = {
  "rvm-mobilenetv3":
    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx",
  "rvm-resnet50":
    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx",
};

// HF mirror used if the GitHub asset is blocked (CORS / 403). Same fp32
// graph; transformers.js-style Hub URL so Cache-Control is friendly.
const MODEL_MIRRORS: Partial<Record<RvmModelId, string>> = {
  "rvm-mobilenetv3":
    "https://huggingface.co/inverseaibd/rvm_mobilenetv3_fp16/resolve/main/rvm_mobilenetv3_fp16.onnx",
};

const CACHE_NAME = "toolbox-rvm-onnx-v1";

// Cap the tensor we feed the net. 4K NCHW fp32 is ~100 MB/frame before the
// recurrent states; 1080p is the model's documented sweet spot.
const MAX_INFER_EDGE = 1920;

type OrtTensor = {
  data: Float32Array | Uint16Array;
  dims: number[];
  type: string;
  dispose?: () => void;
};

type OrtSession = {
  inputNames: string[];
  outputNames: string[];
  run: (
    feeds: Record<string, OrtTensor>
  ) => Promise<Record<string, OrtTensor>>;
};

type OrtMod = {
  InferenceSession: {
    create: (
      buf: ArrayBuffer | Uint8Array,
      opts?: Record<string, unknown>
    ) => Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: Float32Array | Uint16Array,
    dims: number[]
  ) => OrtTensor;
  env: {
    wasm?: {
      wasmPaths?: string | Record<string, string>;
      proxy?: boolean;
      numThreads?: number;
    };
    webgpu?: { powerPreference?: string };
    versions?: { web?: string };
  };
};

interface LoadedRvm {
  ort: OrtMod;
  session: OrtSession;
  // fp16 graphs need matching tensor types; the GitHub releases are fp32.
  float16: boolean;
}

const modelCache = new Map<RvmModelId, LoadedRvm>();
const inFlight = new Map<RvmModelId, Promise<LoadedRvm>>();

function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|CriOS|Android/i.test(ua);
}

async function loadOrt(): Promise<OrtMod> {
  // WASM-only build. The default `onnxruntime-web` bundle prefers the
  // JSEP/WebGPU EP, whose AveragePool kernel still rejects ceil_mode
  // ("using ceil() in shape computation is not yet supported"). RVM's
  // backbone uses AveragePool with ceil_mode=1, so WebGPU fails at
  // session.run even when create() succeeded. CPU WASM handles it.
  // https://github.com/microsoft/onnxruntime/issues/21206
  const ort = (await import("onnxruntime-web/wasm")) as unknown as OrtMod;
  const wasm = ort.env.wasm;
  if (wasm) {
    const ver = ort.env.versions?.web ?? "1.21.0";
    const prefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/`;
    // Non-JSEP artifacts (transformers.js does the same). JSEP is the
    // WebGPU glue and is what throws on AveragePool ceil_mode.
    wasm.wasmPaths = isSafari()
      ? {
          mjs: `${prefix}ort-wasm-simd-threaded.mjs`,
          wasm: `${prefix}ort-wasm-simd-threaded.wasm`,
        }
      : {
          mjs: `${prefix}ort-wasm-simd-threaded.asyncify.mjs`,
          wasm: `${prefix}ort-wasm-simd-threaded.asyncify.wasm`,
        };
    wasm.proxy = false;
    if (
      typeof crossOriginIsolated !== "undefined" &&
      !crossOriginIsolated
    ) {
      wasm.numThreads = 1;
    }
  }
  return ort;
}

async function fetchOnnx(
  url: string,
  onProgress?: (p: RvmProgress) => void
): Promise<ArrayBuffer> {
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit && hit.ok) return await hit.arrayBuffer();
    } catch {
      // Cache API can throw in private mode — fall through to network.
    }
  }

  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) {
    throw new Error(`RVM model download failed (${res.status}) from ${url}`);
  }

  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    await putCache(url, buf);
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      onProgress?.({
        phase: "loading-model",
        progress: Math.min(1, received / total),
      });
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  const buf = out.buffer;
  await putCache(url, buf);
  return buf;
}

async function putCache(url: string, buf: ArrayBuffer): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      url,
      new Response(buf, {
        headers: { "Content-Type": "application/octet-stream" },
      })
    );
  } catch {
    // Quota / private mode — inference still works without a cache.
  }
}

async function createSession(
  ort: OrtMod,
  buf: ArrayBuffer
): Promise<OrtSession> {
  return ort.InferenceSession.create(new Uint8Array(buf), {
    executionProviders: ["wasm"],
  });
}

async function loadModel(
  id: RvmModelId,
  onProgress?: (p: RvmProgress) => void
): Promise<LoadedRvm> {
  const cached = modelCache.get(id);
  if (cached) return cached;
  const pending = inFlight.get(id);
  if (pending) return pending;

  const promise = (async () => {
    onProgress?.({ phase: "loading-runtime" });
    const ort = await loadOrt();
    onProgress?.({ phase: "loading-model" });

    const urls = [MODEL_URLS[id], MODEL_MIRRORS[id]].filter(
      (u): u is string => !!u
    );
    let lastErr: unknown;
    let buf: ArrayBuffer | null = null;
    let urlUsed = urls[0];
    for (const url of urls) {
      try {
        buf = await fetchOnnx(url, onProgress);
        urlUsed = url;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!buf) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error("RVM model download failed.");
    }

    const session = await createSession(ort, buf);
    const float16 = /fp16/i.test(urlUsed);
    const handles: LoadedRvm = { ort, session, float16 };
    modelCache.set(id, handles);
    return handles;
  })();

  inFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(id);
  }
}

function makeTensor(
  ort: OrtMod,
  float16: boolean,
  data: Float32Array,
  dims: number[]
): OrtTensor {
  if (!float16) return new ort.Tensor("float32", data, dims);
  const u16 = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) u16[i] = float32ToFloat16(data[i]);
  return new ort.Tensor("float16", u16, dims);
}

function tensorToFloat32(t: OrtTensor): Float32Array {
  const d = t.data;
  if (d instanceof Float32Array) return d;
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = float16ToFloat32(d[i] as number);
  return out;
}

function initialRec(ort: OrtMod, float16: boolean): RvmRecState {
  const z = () => makeTensor(ort, float16, new Float32Array(1), [1, 1, 1, 1]);
  return { r1: z(), r2: z(), r3: z(), r4: z() };
}

function disposeRec(rec: RvmRecState | null): void {
  if (!rec) return;
  rec.r1.dispose?.();
  rec.r2.dispose?.();
  rec.r3.dispose?.();
  rec.r4.dispose?.();
}

export function autoDownsampleRatio(width: number, height: number): number {
  const maxEdge = Math.max(width, height);
  if (maxEdge <= 512) return 1;
  // Official converter default: downsampled max edge = 512.
  return Math.min(1, Math.max(0.125, 512 / maxEdge));
}

export function resolveDownsample(
  spec: RvmDownsample | number | string | undefined,
  width: number,
  height: number
): number {
  if (spec == null || spec === "auto" || spec === 0 || spec === "0") {
    return autoDownsampleRatio(width, height);
  }
  const n = typeof spec === "number" ? spec : parseFloat(String(spec));
  if (!Number.isFinite(n) || n <= 0) return autoDownsampleRatio(width, height);
  return Math.min(1, Math.max(0.125, n));
}

async function blobToNchw(
  blob: Blob
): Promise<{ nchw: Float32Array; w: number; h: number; srcW: number; srcH: number }> {
  const bmp = await createImageBitmap(blob);
  const srcW = bmp.width;
  const srcH = bmp.height;
  let w = srcW;
  let h = srcH;
  const long = Math.max(w, h);
  if (long > MAX_INFER_EDGE) {
    const s = MAX_INFER_EDGE / long;
    w = Math.max(2, Math.round(w * s));
    h = Math.max(2, Math.round(h * s));
  }
  // Backbone stride is 32. Keep H/W on that grid so the exported
  // AveragePool (ceil_mode=1 from PyTorch AdaptiveAvgPool) has an
  // exact output size and never asks the runtime for ceil().
  w = Math.max(32, Math.floor(w / 32) * 32);
  h = Math.max(32, Math.floor(h / 32) * 32);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    throw new Error("rvm: 2d canvas unavailable");
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const n = w * h;
  const nchw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    nchw[i] = img.data[i * 4] / 255;
    nchw[n + i] = img.data[i * 4 + 1] / 255;
    nchw[2 * n + i] = img.data[i * 4 + 2] / 255;
  }
  return { nchw, w, h, srcW, srcH };
}

function pickName(names: string[], candidates: string[]): string | null {
  const lower = names.map((n) => n.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i >= 0) return names[i];
  }
  return null;
}

function resizeMaskToCanvas(
  mask: Float32Array,
  maskW: number,
  maskH: number,
  targetW: number,
  targetH: number
): HTMLCanvasElement {
  const stage = new Uint8ClampedArray(maskW * maskH * 4);
  for (let i = 0; i < maskW * maskH; i++) {
    const v = Math.max(0, Math.min(1, mask[i])) * 255;
    stage[i * 4 + 0] = v;
    stage[i * 4 + 1] = v;
    stage[i * 4 + 2] = v;
    stage[i * 4 + 3] = 255;
  }
  const small = document.createElement("canvas");
  small.width = maskW;
  small.height = maskH;
  const sctx = small.getContext("2d");
  if (!sctx) throw new Error("rvm: 2d canvas unavailable");
  sctx.putImageData(new ImageData(stage, maskW, maskH), 0, 0);
  if (targetW === maskW && targetH === maskH) return small;
  const big = document.createElement("canvas");
  big.width = targetW;
  big.height = targetH;
  const bctx = big.getContext("2d");
  if (!bctx) throw new Error("rvm: 2d canvas unavailable");
  bctx.drawImage(small, 0, 0, maskW, maskH, 0, 0, targetW, targetH);
  return big;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("rvm: PNG encode failed"))),
      "image/png"
    );
  });
}

export async function mattingFrame(
  blob: Blob,
  rec: RvmRecState | null,
  options: {
    model: RvmModelId;
    downsample?: RvmDownsample | number | string;
    onProgress?: (p: RvmProgress) => void;
  }
): Promise<RvmFrameOut> {
  const loaded = await loadModel(options.model, options.onProgress);
  options.onProgress?.({ phase: "running" });

  const { ort, session, float16 } = loaded;
  const { nchw, w, h, srcW, srcH } = await blobToNchw(blob);
  const ratio = resolveDownsample(options.downsample, w, h);

  const src = makeTensor(ort, float16, nchw, [1, 3, h, w]);
  const ds = new ort.Tensor(
    "float32",
    Float32Array.from([ratio]),
    [1]
  );
  const recIn = rec ?? initialRec(ort, float16);

  const inNames = session.inputNames;
  const srcName = pickName(inNames, ["src", "input", "image"]) ?? inNames[0];
  const r1Name = pickName(inNames, ["r1i", "r1x", "r1"]) ?? inNames[1];
  const r2Name = pickName(inNames, ["r2i", "r2x", "r2"]) ?? inNames[2];
  const r3Name = pickName(inNames, ["r3i", "r3x", "r3"]) ?? inNames[3];
  const r4Name = pickName(inNames, ["r4i", "r4x", "r4"]) ?? inNames[4];
  const dsName =
    pickName(inNames, ["downsample_ratio", "downsample", "ratio"]) ??
    inNames[inNames.length - 1];

  const feeds: Record<string, OrtTensor> = {
    [srcName]: src,
    [r1Name]: recIn.r1,
    [r2Name]: recIn.r2,
    [r3Name]: recIn.r3,
    [r4Name]: recIn.r4,
    [dsName]: ds,
  };

  let out: Record<string, OrtTensor>;
  try {
    out = await session.run(feeds);
  } catch (e) {
    src.dispose?.();
    ds.dispose?.();
    if (!rec) disposeRec(recIn);
    throw e;
  }
  src.dispose?.();
  ds.dispose?.();
  // Recycle: drop the inputs we just consumed (the outputs become next rec).
  if (rec) disposeRec(rec);
  else disposeRec(recIn);

  const outNames = session.outputNames;
  const phaName =
    pickName(outNames, ["pha", "alpha", "ph"]) ??
    outNames.find((n) => /pha|alpha/i.test(n)) ??
    outNames[1];
  const r1o = pickName(outNames, ["r1o", "r1y", "r1"]) ?? outNames[2];
  const r2o = pickName(outNames, ["r2o", "r2y", "r2"]) ?? outNames[3];
  const r3o = pickName(outNames, ["r3o", "r3y", "r3"]) ?? outNames[4];
  const r4o = pickName(outNames, ["r4o", "r4y", "r4"]) ?? outNames[5];

  const pha = out[phaName];
  if (!pha) {
    throw new Error("RVM model returned no alpha tensor.");
  }
  const dims = pha.dims;
  const maskH = dims[dims.length - 2];
  const maskW = dims[dims.length - 1];
  const maskData = tensorToFloat32(pha);
  pha.dispose?.();
  out[pickName(outNames, ["fgr", "foreground"]) ?? ""]?.dispose?.();

  const canvas = resizeMaskToCanvas(maskData, maskW, maskH, srcW, srcH);
  const [bitmap, png] = await Promise.all([
    createImageBitmap(canvas),
    canvasToPng(canvas),
  ]);

  options.onProgress?.({ phase: "done", progress: 1 });
  return {
    bitmap,
    png,
    rec: {
      r1: out[r1o],
      r2: out[r2o],
      r3: out[r3o],
      r4: out[r4o],
    },
    width: srcW,
    height: srcH,
  };
}

export async function blobHash(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function freeRvmRec(rec: RvmRecState | null): void {
  disposeRec(rec);
}

// IEEE-754 binary16 helpers for the fp16 fallback graph.
function float32ToFloat16(val: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let frac = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    frac = (frac | 0x800000) >> (1 - exp);
    return sign | (frac >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (frac >> 13);
}

function float16ToFloat32(h: number): number {
  const sign = (h & 0x8000) << 16;
  let exp = (h >> 10) & 0x1f;
  let frac = h & 0x3ff;
  if (exp === 0) {
    if (frac === 0) {
      const u = new Uint32Array([sign]);
      return new Float32Array(u.buffer)[0];
    }
    exp = 1;
    while ((frac & 0x400) === 0) {
      frac <<= 1;
      exp--;
    }
    frac &= 0x3ff;
    exp = exp - 15 + 127;
  } else if (exp === 31) {
    const u = new Uint32Array([sign | 0x7f800000 | (frac << 13)]);
    return new Float32Array(u.buffer)[0];
  } else {
    exp = exp - 15 + 127;
  }
  const u = new Uint32Array([sign | (exp << 23) | (frac << 13)]);
  return new Float32Array(u.buffer)[0];
}
