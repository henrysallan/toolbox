import type {
  NodeDefinition,
  Point,
  PointsValue,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import type { ObjectDetector, Detection } from "@mediapipe/tasks-vision";

// Object Tracker node. Runs MediaPipe's EfficientDet object detection
// on the incoming image each frame and emits:
//   - primary `spline`: one closed 4-anchor rectangle per detection
//   - aux     `points`: center of each detection, with per-point scale
//                       equal to the box's size (useful for Copy-to-
//                       Points scattering)
//
// Simple identity tracking across frames: after each detection round,
// we match new detections to the previous frame's by IoU and carry
// each match's ID forward. Unmatched previous detections are dropped;
// new detections get fresh IDs. Output subpaths / points are sorted
// by ID so downstream nodes see a stable ordering as long as the same
// objects remain in view.
//
// First compute after creation triggers a one-time model download from
// the MediaPipe CDN. Progress is surfaced through the same banner as
// save/load via a `node-progress` window event.

// ---- progress helper ---------------------------------------------------

function reportProgress(label: string, progress: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("node-progress", {
      detail: { label, progress, tone: "load" },
    })
  );
}

function clearProgress() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("node-progress", { detail: null }));
}

// ---- model registry ----------------------------------------------------

const MODELS = {
  "lite0": {
    label: "EfficientDet Lite0 (fast, ~3MB)",
    url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite",
  },
  "lite2": {
    label: "EfficientDet Lite2 (accurate, ~6MB)",
    url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/latest/efficientdet_lite2.tflite",
  },
} as const;
type ModelKey = keyof typeof MODELS;

// ---- detector state ----------------------------------------------------

interface TrackedBox {
  id: number;
  // Normalized [0,1]² Y-down
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  category: string;
}

interface TrackerState {
  // Lazy-load status.
  model: ModelKey | null;
  detector: ObjectDetector | null;
  loading: boolean;
  error: string | null;
  // Offscreen 2D canvas that we blit the source image into before
  // handing it to MediaPipe. Detection input size is bounded so we
  // don't round-trip large textures each frame.
  detectCanvas: HTMLCanvasElement;
  // Previous frame's tracked boxes (for identity matching).
  prev: TrackedBox[];
  // Monotonically-increasing ID counter.
  nextId: number;
}

function stateKey(nodeId: string): string {
  return `object-tracker:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): TrackerState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as TrackerState | undefined;
  if (existing) return existing;
  const s: TrackerState = {
    model: null,
    detector: null,
    loading: false,
    error: null,
    detectCanvas: document.createElement("canvas"),
    prev: [],
    nextId: 1,
  };
  ctx.state[key] = s;
  return s;
}

async function loadDetector(
  state: TrackerState,
  modelKey: ModelKey,
  confidence: number,
  maxResults: number
) {
  state.loading = true;
  state.error = null;
  state.model = modelKey;
  try {
    const modelCfg = MODELS[modelKey];
    reportProgress(`loading ${modelKey}`, 0.05);
    const mod = await import("@mediapipe/tasks-vision");
    reportProgress(`loading ${modelKey}`, 0.2);
    // FilesetResolver fetches the WASM runtime from the matching CDN
    // path. Version-pinned to match the installed npm package so the
    // loader and runtime stay in sync.
    const vision = await mod.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
    );
    reportProgress(`loading ${modelKey}`, 0.5);
    const detector = await mod.ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelCfg.url,
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      scoreThreshold: confidence,
      maxResults,
    });
    reportProgress(`loading ${modelKey}`, 1);
    state.detector = detector;
    state.loading = false;
    clearProgress();
    // Bump the pipeline so nodes that were waiting on the detector
    // re-evaluate and produce output.
    window.dispatchEvent(new Event("pipeline-bump"));
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.loading = false;
    clearProgress();
    // eslint-disable-next-line no-console
    console.warn("Object Tracker model load failed:", state.error);
  }
}

// ---- IoU-based identity tracking --------------------------------------

function iou(a: TrackedBox, b: TrackedBox): number {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const iw = Math.max(0, x1 - x0);
  const ih = Math.max(0, y1 - y0);
  const inter = iw * ih;
  const aA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const aB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = aA + aB - inter;
  return union > 0 ? inter / union : 0;
}

// Greedy match: for each new detection, pick the previous-frame box
// with the highest IoU that's above threshold and hasn't been claimed
// yet. Unclaimed new detections get fresh IDs. Good enough when motion
// is gradual; no Hungarian/tracking-by-detection bookkeeping for v1.
function assignIds(
  newBoxes: Omit<TrackedBox, "id">[],
  prev: TrackedBox[],
  state: TrackerState,
  threshold = 0.3
): TrackedBox[] {
  const claimed = new Set<number>();
  const result: TrackedBox[] = [];
  for (const nb of newBoxes) {
    let bestIdx = -1;
    let bestScore = threshold;
    for (let i = 0; i < prev.length; i++) {
      if (claimed.has(i)) continue;
      const p = prev[i];
      // Only match within the same category — a "person" shouldn't
      // inherit a "dog"'s ID just because their bboxes overlap.
      if (p.category !== nb.category) continue;
      const s = iou({ ...nb, id: 0 }, p);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    let id: number;
    if (bestIdx >= 0) {
      id = prev[bestIdx].id;
      claimed.add(bestIdx);
    } else {
      id = state.nextId++;
    }
    result.push({ ...nb, id });
  }
  result.sort((a, b) => a.id - b.id);
  return result;
}

// ---- node definition ---------------------------------------------------

export const objectTrackerNode: NodeDefinition = {
  type: "object-tracker",
  name: "Object Tracker",
  category: "image",
  subcategory: "modifier",
  description:
    "Detect objects in an incoming image using MediaPipe. Emits bounding-box rectangles (spline) and per-detection centers (points). IDs persist across frames via IoU matching.",
  backend: "webgl2",
  // The detector runs each eval; output depends on upstream frame
  // contents, not just params. Also needs a time-bump so downstream
  // nodes see fresh results on every eval.
  stable: false,
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "model",
      label: "Model",
      type: "enum",
      options: ["lite0", "lite2"],
      default: "lite0",
    },
    {
      name: "confidence",
      label: "Confidence",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "max_results",
      label: "Max results",
      type: "scalar",
      min: 1,
      max: 25,
      step: 1,
      default: 5,
    },
    {
      name: "input_size",
      label: "Input size",
      type: "scalar",
      min: 128,
      max: 1024,
      softMax: 512,
      step: 32,
      default: 320,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "positions", type: "points" }],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.image;
    const state = ensureState(ctx, nodeId);
    const modelKey = ((params.model as string) ?? "lite0") as ModelKey;
    const confidence = (params.confidence as number) ?? 0.4;
    const maxResults = Math.max(
      1,
      Math.floor((params.max_results as number) ?? 5)
    );
    const inputSize = Math.max(
      128,
      Math.floor((params.input_size as number) ?? 320)
    );

    // Trigger model load. If the user switches model param mid-use,
    // reload. Detector is stale (running an old model) for the
    // duration of the reload; not worth fighting that edge case.
    if (!state.detector && !state.loading) {
      loadDetector(state, modelKey, confidence, maxResults);
    } else if (
      state.detector &&
      !state.loading &&
      state.model !== modelKey
    ) {
      // Different model requested — dispose the old and reload.
      try {
        state.detector.close();
      } catch {
        // ignore
      }
      state.detector = null;
      loadDetector(state, modelKey, confidence, maxResults);
    }

    const emptySpline: SplineValue = { kind: "spline", subpaths: [] };
    const emptyPoints: PointsValue = { kind: "points", points: [] };

    if (!src || src.kind !== "image" || !state.detector) {
      return { primary: emptySpline, aux: { positions: emptyPoints } };
    }

    // Keep thresholds in sync with params — MediaPipe requires a
    // recreate to change them post-init, so we set on the detector
    // via setOptions when possible.
    try {
      state.detector.setOptions({
        scoreThreshold: confidence,
        maxResults,
      });
    } catch {
      // setOptions is supported on recent versions; older ones error.
      // The detector was created with the initial values so this is
      // non-fatal — params won't update live until reload, which is
      // acceptable in that edge case.
    }

    // Blit the source image to the detection canvas. We downsample
    // to `input_size` (keeping aspect by using the max dim) to keep
    // per-frame readback cheap. The model resizes internally anyway.
    const srcAspect = src.width / src.height;
    let cw: number;
    let ch: number;
    if (srcAspect >= 1) {
      cw = inputSize;
      ch = Math.max(1, Math.round(inputSize / srcAspect));
    } else {
      ch = inputSize;
      cw = Math.max(1, Math.round(inputSize * srcAspect));
    }
    if (state.detectCanvas.width !== cw || state.detectCanvas.height !== ch) {
      state.detectCanvas.width = cw;
      state.detectCanvas.height = ch;
    }
    try {
      ctx.blitToCanvas(src, state.detectCanvas);
    } catch {
      return { primary: emptySpline, aux: { positions: emptyPoints } };
    }

    let detections: Detection[] = [];
    try {
      const result = state.detector.detect(state.detectCanvas);
      detections = result.detections ?? [];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("Object Tracker detect failed:", err);
      return { primary: emptySpline, aux: { positions: emptyPoints } };
    }

    // Convert MediaPipe detections (pixel coords relative to the
    // detect canvas) into normalized bboxes and hand to the ID
    // matcher for cross-frame identity persistence.
    const freshBoxes: Omit<TrackedBox, "id">[] = [];
    for (const det of detections) {
      const bb = det.boundingBox;
      if (!bb) continue;
      const x0 = bb.originX / cw;
      const y0 = bb.originY / ch;
      const x1 = (bb.originX + bb.width) / cw;
      const y1 = (bb.originY + bb.height) / ch;
      const cat = det.categories?.[0];
      freshBoxes.push({
        x0: Math.max(0, Math.min(1, x0)),
        y0: Math.max(0, Math.min(1, y0)),
        x1: Math.max(0, Math.min(1, x1)),
        y1: Math.max(0, Math.min(1, y1)),
        score: cat?.score ?? 0,
        category: cat?.categoryName ?? "object",
      });
    }
    const tracked = assignIds(freshBoxes, state.prev, state);
    state.prev = tracked;

    // Build the two outputs: closed rectangular subpaths for the
    // spline primary, and center points (with scale = box size) for
    // the aux points output.
    const subpaths: SplineSubpath[] = tracked.map((b) => ({
      closed: true,
      anchors: [
        { pos: [b.x0, b.y0] },
        { pos: [b.x1, b.y0] },
        { pos: [b.x1, b.y1] },
        { pos: [b.x0, b.y1] },
      ],
    }));
    const points: Point[] = tracked.map((b) => ({
      pos: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2],
      rotation: 0,
      scale: [b.x1 - b.x0, b.y1 - b.y0],
    }));

    return {
      primary: { kind: "spline", subpaths },
      aux: { positions: { kind: "points", points } },
    };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as TrackerState | undefined;
    if (state?.detector) {
      try {
        state.detector.close();
      } catch {
        // ignore
      }
    }
    delete ctx.state[key];
  },
};
