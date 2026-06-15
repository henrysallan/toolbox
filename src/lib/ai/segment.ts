// Segment Anything helper. Runs SlimSAM (a distilled SAM) entirely in
// the browser via Hugging Face Transformers.js.
//
// SAM's architecture splits cleanly in two:
//   encoder — heavy ViT pass over the image, produces image embeddings.
//             Runs ONCE per image (~hundreds of ms).
//   decoder — tiny mask head prompted with points. Runs per click
//             (~tens of ms) against cached embeddings.
//
// We exploit that split everywhere: interactive dot placement reuses the
// cached embedding (only the decoder re-runs per click), and the per-frame
// bake pays one encoder pass per frame.
//
// Multi-dot semantics: SAM treats multiple positive points in ONE prompt
// as refinement of a single object — clicking two separate objects in one
// prompt produces a single (usually garbage) spanning mask. We want "each
// dot adds to the selection", so each dot is decoded as its own prompt and
// the resulting masks are unioned.
//
// Runtime + weights load lazily (same pattern as bg-remove.ts); weights are
// cached by the runtime in IndexedDB so repeat loads are instant.

export interface SegmentDot {
  // Normalized [0,1]² Y-DOWN image space (top-left origin) — matches both
  // DOM pointer math and the decoded PNG's pixel space directly.
  x: number;
  y: number;
}

export interface SegmentProgress {
  phase:
    | "loading-runtime"
    | "loading-model"
    | "embedding"
    | "segmenting"
    | "done";
  // [0..1] when known (model-weight download). Undefined = indeterminate.
  progress?: number;
}

// Union mask at the source image's resolution. 0 = background, 255 = in
// the selection.
export interface SegmentMask {
  data: Uint8Array;
  width: number;
  height: number;
}

// Opaque embedding bundle — pass back into decodeDots. Holds the processor
// outputs (original/reshaped sizes for coordinate mapping + mask upscale)
// and the encoder's output tensors.
export interface SamEmbedding {
  imageInputs: {
    original_sizes: number[][];
    reshaped_input_sizes: number[][];
  } & Record<string, unknown>;
  embeddings: Record<string, unknown>;
  width: number;
  height: number;
}

const MODEL_REPO = "Xenova/slimsam-77-uniform";

interface SamHandles {
  tx: typeof import("@huggingface/transformers");
  // Callable model handle (decoder forward + get_image_embeddings). Typed
  // loosely — same approach as bg-remove.ts; the runtime's own types don't
  // describe the callable/spread patterns the SAM flow uses.
  model: {
    (inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
    get_image_embeddings(
      inputs: Record<string, unknown>
    ): Promise<Record<string, unknown>>;
  };
  processor: {
    (image: unknown): Promise<SamEmbedding["imageInputs"]>;
    post_process_masks(
      masks: unknown,
      originalSizes: number[][],
      reshapedSizes: number[][]
    ): Promise<Array<{ data: Uint8Array; dims: number[] }>>;
  };
}

let cached: SamHandles | null = null;
let inFlight: Promise<SamHandles> | null = null;

async function loadSam(
  onProgress?: (p: SegmentProgress) => void
): Promise<SamHandles> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    onProgress?.({ phase: "loading-runtime" });
    const tx = (await import(
      "@huggingface/transformers"
    )) as typeof import("@huggingface/transformers");
    tx.env.allowLocalModels = false;

    onProgress?.({ phase: "loading-model" });
    // The runtime's ProgressInfo is a union whose variants don't all carry
    // `progress` — accept unknown and narrow.
    const progressCb = (p: unknown) => {
      const prog = (p as { progress?: unknown }).progress;
      if (typeof prog === "number") {
        onProgress?.({
          phase: "loading-model",
          progress: Math.min(1, Math.max(0, prog / 100)),
        });
      }
    };

    const [model, processor] = await Promise.all([
      tx.SamModel.from_pretrained(MODEL_REPO, {
        progress_callback: progressCb,
      }),
      tx.AutoProcessor.from_pretrained(MODEL_REPO, {
        progress_callback: progressCb,
      }),
    ]);

    const handles: SamHandles = {
      tx,
      model: model as unknown as SamHandles["model"],
      processor: processor as unknown as SamHandles["processor"],
    };
    cached = handles;
    return handles;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

// Run the encoder once over an image. The returned bundle feeds any number
// of decodeDots calls.
export async function embedImage(
  blob: Blob,
  onProgress?: (p: SegmentProgress) => void
): Promise<SamEmbedding> {
  const { tx, model, processor } = await loadSam(onProgress);
  onProgress?.({ phase: "embedding" });
  const raw = await tx.RawImage.fromBlob(blob);
  const imageInputs = await processor(raw);
  const embeddings = await model.get_image_embeddings(
    imageInputs as Record<string, unknown>
  );
  return {
    imageInputs,
    embeddings,
    width: raw.width,
    height: raw.height,
  };
}

// Decode ONE positive-point prompt against the cached embedding. Returns
// the best of SAM's 3 candidate masks (by IoU score) plus that score —
// the building block for both the dots union and the auto-grid mode.
export async function decodeSingle(
  emb: SamEmbedding,
  dot: SegmentDot
): Promise<{ mask: SegmentMask; score: number }> {
  const { tx, model, processor } = await loadSam();

  // Point prompts are expressed in the RESHAPED input's pixel space (the
  // 1024-long-side resize the processor applied), not original pixels.
  const reshaped = emb.imageInputs.reshaped_input_sizes[0]; // [h, w]

  const input_points = new tx.Tensor(
    "float32",
    Float32Array.from([dot.x * reshaped[1], dot.y * reshaped[0]]),
    [1, 1, 1, 2]
  );
  const input_labels = new tx.Tensor(
    "int64",
    BigInt64Array.from([BigInt(1)]), // 1 = positive (foreground) point
    [1, 1, 1]
  );
  const outputs = await model({
    ...emb.embeddings,
    input_points,
    input_labels,
  });

  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    emb.imageInputs.original_sizes,
    emb.imageInputs.reshaped_input_sizes
  );
  const t = masks[0]; // dims like [1, 3, H, W], binarized 0/1 data
  const dims = t.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  const plane = w * h;
  const numMasks = Math.max(1, Math.floor(t.data.length / plane));

  // Best candidate by IoU score (dims [1, 1, 3]).
  const scoreT = outputs.iou_scores as { data: Float32Array };
  const scores = scoreT?.data ?? new Float32Array([1]);
  let best = 0;
  for (let i = 1; i < Math.min(numMasks, scores.length); i++) {
    if (scores[i] > scores[best]) best = i;
  }

  const out = new Uint8Array(plane);
  const off = Math.min(best, numMasks - 1) * plane;
  const md = t.data;
  for (let i = 0; i < plane; i++) {
    if (md[off + i]) out[i] = 255;
  }
  return {
    mask: { data: out, width: w, height: h },
    score: scores[best] ?? 0,
  };
}

// Decode each dot as its own single-point prompt against the cached
// embedding and union the results — "each dot adds an object".
export async function decodeDots(
  emb: SamEmbedding,
  dots: SegmentDot[],
  onProgress?: (p: SegmentProgress) => void
): Promise<SegmentMask> {
  await loadSam(onProgress);
  onProgress?.({ phase: "segmenting" });

  let union: Uint8Array | null = null;
  let outW = 0;
  let outH = 0;

  for (const dot of dots) {
    const { mask } = await decodeSingle(emb, dot);
    if (!union) {
      union = new Uint8Array(mask.width * mask.height);
      outW = mask.width;
      outH = mask.height;
    }
    const md = mask.data;
    for (let i = 0; i < union.length; i++) {
      if (md[i]) union[i] = 255;
    }
  }

  onProgress?.({ phase: "done", progress: 1 });
  return {
    data: union ?? new Uint8Array(0),
    width: outW,
    height: outH,
  };
}

// Stage the single-channel mask into a grayscale RGBA canvas (R=G=B=mask,
// A=255) — the shape both PNG encode and texture upload want.
export function maskToCanvas(mask: SegmentMask): HTMLCanvasElement {
  const { data, width, height } = mask;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = data[i];
    rgba[i * 4 + 0] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("segment: 2d canvas unavailable");
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

export async function maskToBitmap(mask: SegmentMask): Promise<ImageBitmap> {
  // Index masks carry slot IDs in pixel values — disable color management
  // so values round-trip exactly (harmless for binary alpha masks).
  return createImageBitmap(maskToCanvas(mask), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
}

// PNG-compress the mask for the bake cache. A binary 1080p mask lands in
// the tens of KB — vs ~8 MB raw RGBA — which is what keeps a multi-hundred
// frame bake inside the memory budget.
export async function maskToPngBlob(mask: SegmentMask): Promise<Blob> {
  const canvas = maskToCanvas(mask);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("segment: PNG encode failed"))),
      "image/png"
    );
  });
}

// Content hash for embedding-cache keys — same pixels in, same key out, so
// a static upstream only ever pays the encoder once no matter how many dots
// the user places.
export async function blobHash(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
