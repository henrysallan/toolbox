// Background-removal helper. Uses Hugging Face Transformers.js to
// run BRIA's RMBG model entirely in the browser.
//
// Both the runtime AND the model weights are loaded lazily via
// dynamic import so the base bundle isn't burdened with ~1.5 MB of
// runtime + ~177 MB of model weights up front. The runtime is
// loaded the first time `removeBackground` is called; weights are
// cached by the runtime in IndexedDB so subsequent loads on the
// same device are instant.
//
// We deliberately avoid the high-level `pipeline()` API: BRIA's
// RMBG models register as a custom architecture
// (SegformerForSemanticSegmentation / BiRefNet) that the
// `image-segmentation` task doesn't recognise. Instead we use
// AutoModel + AutoProcessor with a hand-supplied config —
// matching the exact snippet BRIA publishes on the HF model card.

export type BgModelId = "rmbg-1.4" | "rmbg-2.0";

export interface BgProgress {
  phase:
    | "loading-runtime"
    | "loading-model"
    | "running"
    | "compositing"
    | "done";
  // [0..1] when known. Some phases don't have a meaningful value
  // (e.g. compositing) — leave undefined and the UI shows an
  // indeterminate state.
  progress?: number;
}

export interface BgRemoveResult {
  // Source bytes re-exposed as an ImageBitmap so the node can
  // store the input alongside the mask. Lets us combine RGB ×
  // mask at render time (per-frame feather / threshold tweaks
  // without re-baking).
  source: ImageBitmap;
  // Single-channel alpha as an ImageBitmap. The mask's 0..255
  // values are packed into all four channels so the runtime's
  // PNG round-trip works without a custom path.
  mask: ImageBitmap;
}

function modelRepo(id: BgModelId): string {
  switch (id) {
    case "rmbg-2.0":
      return "briaai/RMBG-2.0";
    case "rmbg-1.4":
    default:
      return "briaai/RMBG-1.4";
  }
}

// Per-model preprocessing config — BRIA's RMBG repos don't ship a
// preprocessor_config.json so we hand-feed the values from their
// HF snippets. Both models use the same set: 1024×1024 normalised
// to mean=0.5, std=1.0, rescaled to [0, 1].
function processorConfig() {
  return {
    do_normalize: true,
    do_pad: false,
    do_rescale: true,
    do_resize: true,
    image_mean: [0.5, 0.5, 0.5],
    feature_extractor_type: "ImageFeatureExtractor",
    image_std: [1.0, 1.0, 1.0],
    resample: 2,
    rescale_factor: 0.00392156862745098,
    size: { width: 1024, height: 1024 },
  };
}

interface LoadedModel {
  // The pre-trained model handle — has a callable forward pass
  // that takes the processor output and returns a dict of tensors.
  model: {
    (input: { input: unknown } | unknown): Promise<Record<string, unknown>>;
  };
  // The processor — call as a function with a RawImage to get
  // { pixel_values }.
  processor: (
    image: unknown
  ) => Promise<{ pixel_values: unknown }>;
}

// Cache the loaded handles by model id. Subsequent bakes against
// the same model skip the load entirely.
const modelCache = new Map<BgModelId, LoadedModel>();
const inFlight = new Map<BgModelId, Promise<LoadedModel>>();

async function loadModel(
  id: BgModelId,
  onProgress?: (p: BgProgress) => void
): Promise<LoadedModel> {
  const cached = modelCache.get(id);
  if (cached) return cached;
  const pending = inFlight.get(id);
  if (pending) return pending;

  const promise = (async () => {
    onProgress?.({ phase: "loading-runtime" });
    const tx = (await import(
      "@huggingface/transformers"
    )) as typeof import("@huggingface/transformers");
    tx.env.allowLocalModels = false;

    // Gated repos (RMBG-2.0) require an HF token; non-gated
    // (RMBG-1.4) work without one. We pull the token off the
    // user's preferences row at load time and set it on the
    // global env — the runtime forwards it as the Authorization
    // header for every Hub fetch.
    try {
      const { loadUserPreferences } = await import(
        "@/lib/supabase/user-preferences"
      );
      const prefs = await loadUserPreferences();
      if (prefs.huggingfaceToken) {
        // The runtime exposes this under env.token — older builds
        // also accept env.HF_TOKEN. Set both for safety.
        (tx.env as unknown as { token?: string }).token =
          prefs.huggingfaceToken;
        (tx.env as unknown as { HF_TOKEN?: string }).HF_TOKEN =
          prefs.huggingfaceToken;
      }
    } catch {
      // Loading preferences shouldn't be fatal — non-gated models
      // still work, and the gated case will surface its own 401
      // below.
    }

    const repo = modelRepo(id);
    onProgress?.({ phase: "loading-model" });
    // Forward the runtime's progress events for the model-weight
    // download — the long-tail wait on first use.
    const progressCb = (p: { progress?: number; status?: string }) => {
      if (typeof p.progress === "number") {
        onProgress?.({
          phase: "loading-model",
          progress: Math.min(1, Math.max(0, p.progress / 100)),
        });
      }
    };

    // `model_type: "custom"` tells the runtime to skip the built-in
    // task → architecture lookup table and treat the model as a
    // raw ONNX graph, which is what BRIA's RMBG repos ship.
    const [model, processor] = await Promise.all([
      tx.AutoModel.from_pretrained(repo, {
        // @ts-expect-error — runtime accepts model_type override
        config: { model_type: "custom" },
        progress_callback: progressCb,
      }),
      tx.AutoProcessor.from_pretrained(repo, {
        config: processorConfig(),
        progress_callback: progressCb,
      }),
    ]);

    const handles: LoadedModel = {
      model: model as unknown as LoadedModel["model"],
      processor: processor as unknown as LoadedModel["processor"],
    };
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

// Pull a 2D tensor (H × W or 1 × H × W) of mask values out of
// whatever the model returned. RMBG-1.4 returns it under `output`,
// RMBG-2.0 sometimes under `logits`, and forward-compat we just
// take the first tensor-shaped value if neither key is present.
function pickMaskTensor(
  result: Record<string, unknown>
): { data: Float32Array | Uint8Array; dims: number[] } | null {
  const candidates = [
    "output",
    "output_image",
    "logits",
    "alpha",
    "mask",
  ];
  for (const k of candidates) {
    const v = result[k];
    if (v && typeof v === "object" && "data" in v && "dims" in v) {
      const t = v as { data: Float32Array | Uint8Array; dims: number[] };
      return { data: t.data, dims: t.dims };
    }
  }
  // Fall back to the first tensor-shaped value.
  for (const v of Object.values(result)) {
    if (v && typeof v === "object" && "data" in v && "dims" in v) {
      const t = v as { data: Float32Array | Uint8Array; dims: number[] };
      return { data: t.data, dims: t.dims };
    }
  }
  return null;
}

// Resize a single-channel float32 mask (values in [0, 1]) to
// (targetW, targetH) using a 2D canvas — quick + battle-tested.
// Output is 4-channel RGBA where R=G=B=A=mask*255.
function resizeMaskToCanvas(
  mask: Float32Array | Uint8Array,
  maskW: number,
  maskH: number,
  targetW: number,
  targetH: number
): HTMLCanvasElement {
  // Stage the float mask into an ImageData buffer.
  const stage = new Uint8ClampedArray(maskW * maskH * 4);
  const isFloat = mask instanceof Float32Array;
  for (let i = 0; i < maskW * maskH; i++) {
    let v = mask[i];
    if (isFloat) v = Math.max(0, Math.min(1, v as number)) * 255;
    stage[i * 4 + 0] = v as number;
    stage[i * 4 + 1] = v as number;
    stage[i * 4 + 2] = v as number;
    stage[i * 4 + 3] = 255;
  }
  const small = document.createElement("canvas");
  small.width = maskW;
  small.height = maskH;
  const sctx = small.getContext("2d");
  if (!sctx) throw new Error("bg-remove: 2d canvas unavailable");
  sctx.putImageData(new ImageData(stage, maskW, maskH), 0, 0);

  if (targetW === maskW && targetH === maskH) return small;
  const big = document.createElement("canvas");
  big.width = targetW;
  big.height = targetH;
  const bctx = big.getContext("2d");
  if (!bctx) throw new Error("bg-remove: 2d canvas unavailable");
  bctx.drawImage(small, 0, 0, maskW, maskH, 0, 0, targetW, targetH);
  return big;
}

export async function removeBackground(
  blob: Blob,
  options: {
    model: BgModelId;
    onProgress?: (p: BgProgress) => void;
  }
): Promise<BgRemoveResult> {
  const { model, processor } = await loadModel(
    options.model,
    options.onProgress
  );

  options.onProgress?.({ phase: "running" });

  const tx = (await import(
    "@huggingface/transformers"
  )) as typeof import("@huggingface/transformers");
  const rawIn = await tx.RawImage.fromBlob(blob);
  const { pixel_values } = await processor(rawIn);

  // Some models accept the raw tensor as the only argument;
  // others want a named input dict. Try both shapes.
  let result: Record<string, unknown>;
  try {
    result = await model({ input: pixel_values });
  } catch {
    result = await model({ pixel_values });
  }

  const mask = pickMaskTensor(result);
  if (!mask) {
    throw new Error(
      "Background removal model returned no recognisable mask tensor"
    );
  }

  options.onProgress?.({ phase: "compositing" });

  // dims are typically [1, H, W] for RMBG-1.4 or [1, 1, H, W] for
  // BiRefNet-style. Take the trailing two dims as height × width.
  const dims = mask.dims;
  const maskH = dims[dims.length - 2];
  const maskW = dims[dims.length - 1];

  // Resize the mask to the source's natural dimensions so the
  // baked source + mask line up pixel-for-pixel.
  const sourceBitmap = await createImageBitmap(blob);
  const targetW = sourceBitmap.width;
  const targetH = sourceBitmap.height;
  const maskCanvas = resizeMaskToCanvas(
    mask.data,
    maskW,
    maskH,
    targetW,
    targetH
  );
  const maskBitmap = await createImageBitmap(maskCanvas);

  options.onProgress?.({ phase: "done", progress: 1 });
  return { source: sourceBitmap, mask: maskBitmap };
}
