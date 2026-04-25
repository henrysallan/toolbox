import type {
  NodeDefinition,
  OutputSocketDef,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SplineSubpath,
  SplineValue,
  Vec2Value,
} from "@/engine/types";
import type { HandLandmarker } from "@mediapipe/tasks-vision";

// Hand Tracker node. Runs MediaPipe HandLandmarker on the incoming
// image and emits:
//   - primary `spline`: skeleton bones for each detected hand (21
//     landmarks wired into HAND_CONNECTIONS → 21 subpaths per hand)
//   - aux `left` / `right` vec2: wrist position of each side, latched
//     to the last-known value when the hand is not currently in frame
//   - aux per-finger vec2s (behind `show_fingers`): thumb/index/
//     middle/ring/pinky TIPS for each side — ten more sockets
//
// Output positions ride MediaPipe's normalized-image-Y-down convention,
// matching how the codebase already stores spline anchors and points.
//
// Handedness note: MediaPipe labels hands from the person's own
// perspective ("Right" = the person's right hand). A mirrored webcam
// (which most front-facing cameras produce) inverts that, so the
// `flip_handedness` toggle lets the user reconcile "left" and "right"
// with what they see on screen.
//
// Performance: throttled to `detect_fps` per second. Between detect
// calls the node re-emits smoothed copies of the cached landmarks,
// which keeps downstream motion fluid even when detection runs at
// 15 fps while the graph renders at 60.

// ---- progress helper (same pattern as Object Tracker) -----------------

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
  lite: {
    label: "HandLandmarker Lite (fast, ~2MB)",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  },
  full: {
    label: "HandLandmarker Full (accurate, ~6MB)",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  },
} as const;
// MediaPipe only ships one hand_landmarker bundle right now — both
// entries above point at the same URL. Kept as an enum so a future
// model-tier split is a one-line change.
type ModelKey = keyof typeof MODELS;

// ---- hand landmark topology -------------------------------------------

// Standard MediaPipe 21-point hand model. Index constants for the
// finger tips so the output helpers below read cleanly.
const TIP = {
  thumb: 4,
  index: 8,
  middle: 12,
  ring: 16,
  pinky: 20,
} as const;

// Bones drawn as individual 2-anchor open subpaths in the primary
// spline output — a classic skeleton visualization.
const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17], // palm edge
];

// ---- detector state ----------------------------------------------------

type LM = { x: number; y: number };
type HandLM = LM[]; // length 21

interface SideState {
  // Latched landmarks; undefined until we see this side at least once.
  raw: HandLM | undefined;
  // Smoothed copy of raw, updated every eval (not just on detect).
  smooth: HandLM | undefined;
  // True during the current throttle window means this side was
  // detected in the last detect call; used to suppress ghost
  // skeleton lines when a hand exits frame.
  present: boolean;
}

interface HandTrackerState {
  model: ModelKey | null;
  landmarker: HandLandmarker | null;
  loading: boolean;
  error: string | null;
  left: SideState;
  right: SideState;
  lastDetectAt: number;
  // Cache the last-applied setOptions inputs so repeat calls with
  // identical args can short-circuit — setOptions isn't free in
  // MediaPipe and it's called every detect otherwise.
  lastNumHands: number;
  lastConfidence: number;
}

function stateKey(nodeId: string): string {
  return `hand-tracker:${nodeId}`;
}

function makeSide(): SideState {
  return { raw: undefined, smooth: undefined, present: false };
}

function ensureState(ctx: RenderContext, nodeId: string): HandTrackerState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as HandTrackerState | undefined;
  if (existing) return existing;
  const s: HandTrackerState = {
    model: null,
    landmarker: null,
    loading: false,
    error: null,
    left: makeSide(),
    right: makeSide(),
    lastDetectAt: 0,
    lastNumHands: -1,
    lastConfidence: Number.NaN,
  };
  ctx.state[key] = s;
  return s;
}

async function loadLandmarker(
  state: HandTrackerState,
  modelKey: ModelKey,
  numHands: number,
  confidence: number
) {
  state.loading = true;
  state.error = null;
  state.model = modelKey;
  try {
    const modelCfg = MODELS[modelKey];
    reportProgress(`loading hand_landmarker`, 0.05);
    const mod = await import("@mediapipe/tasks-vision");
    reportProgress(`loading hand_landmarker`, 0.2);
    const vision = await mod.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
    );
    reportProgress(`loading hand_landmarker`, 0.5);
    const landmarker = await mod.HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelCfg.url,
        delegate: "GPU",
      },
      // VIDEO mode + detectForVideo() below lets MediaPipe amortize
      // pipeline setup across frames instead of re-initializing on
      // every still image.
      runningMode: "VIDEO",
      numHands,
      minHandDetectionConfidence: confidence,
      minHandPresenceConfidence: confidence,
      minTrackingConfidence: confidence,
    });
    reportProgress(`loading hand_landmarker`, 1);
    state.landmarker = landmarker;
    state.loading = false;
    clearProgress();
    window.dispatchEvent(new Event("pipeline-bump"));
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.loading = false;
    clearProgress();
    console.warn("Hand Tracker model load failed:", state.error);
  }
}

// ---- smoothing + output helpers ---------------------------------------

// Exponential smoothing, pulled toward `raw` by (1 - smoothing) each
// tick. smoothing=0 → no lag (pass-through); smoothing=1 → frozen.
// Runs every eval even on throttled frames, so with detection at 15
// fps and render at 60 fps the output still converges smoothly each
// frame.
function smoothHand(
  prev: HandLM | undefined,
  raw: HandLM | undefined,
  smoothing: number
): HandLM | undefined {
  if (!raw) return prev; // nothing new to merge; keep the latch
  if (!prev) return raw.map((p) => ({ x: p.x, y: p.y }));
  const k = Math.max(0, Math.min(1, 1 - smoothing));
  const out: HandLM = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const p = prev[i] ?? r;
    out.push({ x: p.x + (r.x - p.x) * k, y: p.y + (r.y - p.y) * k });
  }
  return out;
}

function handToSubpaths(hand: HandLM | undefined): SplineSubpath[] {
  if (!hand) return [];
  return HAND_CONNECTIONS.map<SplineSubpath>(([a, b]) => ({
    closed: false,
    anchors: [
      { pos: [hand[a].x, hand[a].y] },
      { pos: [hand[b].x, hand[b].y] },
    ],
  }));
}

function landmarkAsVec2(
  hand: HandLM | undefined,
  idx: number
): Vec2Value {
  if (!hand) return { kind: "vec2", value: [0.5, 0.5] };
  const lm = hand[idx];
  return { kind: "vec2", value: [lm.x, lm.y] };
}

// Emits a PointsValue with a single Point at the given landmark.
// An absent hand yields an empty collection so downstream iterators
// (Copy-to-Points, Connect Points, etc.) correctly see "no data"
// rather than rendering at a (0.5, 0.5) placeholder.
function landmarkAsSinglePoints(
  hand: HandLM | undefined,
  idx: number
): PointsValue {
  if (!hand) return { kind: "points", points: [] };
  const lm = hand[idx];
  return { kind: "points", points: [{ pos: [lm.x, lm.y] }] };
}

// ---- node definition ---------------------------------------------------

export const handTrackerNode: NodeDefinition = {
  type: "hand-tracker",
  name: "Hand Tracker",
  category: "image",
  subcategory: "modifier",
  description:
    "Detect up to two hands in an incoming image using MediaPipe HandLandmarker. Primary output is the hand skeleton as a spline (21 landmarks wired into 21 bones per hand). Aux outputs expose left/right wrist positions as vec2; toggling Show fingers adds per-finger tip vec2s (thumb / index / middle / ring / pinky on each side). Detection is throttled via `detect_fps` and the output is exponentially smoothed so downstream motion stays fluid between detect calls.",
  backend: "webgl2",
  // Output depends on upstream frame contents, not just params.
  stable: false,
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      // Pause detection without removing the node. Downstream
      // consumers still read the last-known (smoothed) values, so
      // the scene stays composed — detection just stops burning
      // CPU until you flip this back on.
      name: "enabled",
      label: "Enabled",
      type: "boolean",
      default: true,
    },
    {
      name: "model",
      label: "Model",
      type: "enum",
      options: ["lite", "full"],
      default: "lite",
    },
    {
      name: "max_hands",
      label: "Max hands",
      type: "enum",
      options: ["1", "2"],
      // One hand is substantially cheaper than two. Two is only
      // needed for symmetric / both-hands-on-screen setups, so
      // default to the lighter option.
      default: "1",
    },
    {
      name: "confidence",
      label: "Confidence",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "input_size",
      label: "Input size",
      type: "scalar",
      min: 128,
      max: 1024,
      softMax: 512,
      step: 32,
      // 192 is the smallest MediaPipe-recommended size and still
      // accurate for hand landmarking. Lower is faster; turn up
      // when fingers need more precision for fine gestures.
      default: 192,
    },
    {
      name: "detect_fps",
      label: "Detect rate (fps)",
      type: "scalar",
      min: 1,
      max: 60,
      softMax: 30,
      step: 1,
      // Detection runs on the main thread (MediaPipe Tasks Vision
      // doesn't ship a worker variant yet), so every detect stalls
      // rendering for ~20-40ms. Smoothing at render fps hides the
      // coarser cadence — 8 fps feels fluid and leaves the main
      // thread mostly free.
      default: 8,
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 0.99,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "flip_handedness",
      label: "Flip handedness",
      type: "boolean",
      // Default on because the common webcam case produces a
      // mirrored image — MediaPipe's "Right" label then corresponds
      // to the user's on-screen LEFT, which is rarely what you want.
      default: true,
    },
    {
      // Finger output shape — picks the socket topology for the per-
      // finger data.
      //   off    : no finger sockets, just wrists.
      //   vec2   : ten separate vec2 sockets (left_thumb..right_pinky).
      //            Best for wiring one fingertip into a specific
      //            scalar/vec2 consumer.
      //   point  : same ten sockets but each carries a `points`
      //            value of length 1. Best for consumers that expect
      //            a points type (e.g. Copy-to-Points with a single
      //            fingertip as the target).
      //   points : one combined `fingers` socket carrying every
      //            detected fingertip as a single points value. Best
      //            for bulk operations — scatter something at all
      //            fingertips, connect them as a spline, etc.
      name: "finger_output_mode",
      label: "Finger output",
      type: "enum",
      options: ["off", "vec2", "point", "points"],
      default: "off",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [
    { name: "left", type: "vec2" },
    { name: "right", type: "vec2" },
  ],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const out: OutputSocketDef[] = [
      { name: "left", type: "vec2" },
      { name: "right", type: "vec2" },
    ];
    const mode = (params.finger_output_mode as string) ?? "off";
    if (mode === "vec2" || mode === "point") {
      const t: SocketType = mode === "vec2" ? "vec2" : "points";
      for (const side of ["left", "right"] as const) {
        for (const finger of [
          "thumb",
          "index",
          "middle",
          "ring",
          "pinky",
        ] as const) {
          out.push({ name: `${side}_${finger}`, type: t });
        }
      }
    } else if (mode === "points") {
      out.push({ name: "fingers", type: "points" });
    }
    return out;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.image;
    const state = ensureState(ctx, nodeId);
    const modelKey = ((params.model as string) ?? "lite") as ModelKey;
    const numHands = Math.max(
      1,
      Math.min(2, parseInt((params.max_hands as string) ?? "2", 10))
    );
    const confidence = (params.confidence as number) ?? 0.5;
    const inputSize = Math.max(
      128,
      Math.floor((params.input_size as number) ?? 320)
    );
    const detectFps = Math.max(
      1,
      Math.min(60, Math.floor((params.detect_fps as number) ?? 15))
    );
    const minIntervalMs = 1000 / detectFps;
    const smoothing = Math.max(
      0,
      Math.min(0.99, (params.smoothing as number) ?? 0.5)
    );
    const flip = !!params.flip_handedness;
    const fingerMode = ((params.finger_output_mode as string) ?? "off") as
      | "off"
      | "vec2"
      | "point"
      | "points";
    const enabled = params.enabled !== false;

    // Only kick off model load when detection is actually enabled —
    // no point downloading ~2MB of weights and WASM if the user
    // dropped the node in but left it paused.
    if (enabled && !state.landmarker && !state.loading) {
      loadLandmarker(state, modelKey, numHands, confidence);
    } else if (
      enabled &&
      state.landmarker &&
      !state.loading &&
      state.model !== modelKey
    ) {
      try {
        state.landmarker.close();
      } catch {
        // ignore
      }
      state.landmarker = null;
      loadLandmarker(state, modelKey, numHands, confidence);
    }

    // Throttle detection. Smoothing still runs below so output
    // interpolates each render even when raw detection is stale,
    // AND when `enabled` flips off the last-known values stay
    // latched — scene stays composed, CPU stays idle.
    const nowMs = performance.now();
    const shouldDetect =
      enabled &&
      state.landmarker != null &&
      src != null &&
      src.kind === "image" &&
      nowMs - state.lastDetectAt >= minIntervalMs;

    if (shouldDetect) {
      // setOptions isn't free — cache the last-applied values so we
      // only call through when the user actually changed something.
      if (
        state.lastNumHands !== numHands ||
        state.lastConfidence !== confidence
      ) {
        try {
          state.landmarker!.setOptions({
            numHands,
            minHandDetectionConfidence: confidence,
            minHandPresenceConfidence: confidence,
            minTrackingConfidence: confidence,
          });
          state.lastNumHands = numHands;
          state.lastConfidence = confidence;
        } catch {
          // older runtime — ignore
        }
      }
      // Downsample for speed. HandLandmarker is internally quite
      // sensitive to input size; 320px on the long side is the
      // MediaPipe-recommended sweet spot.
      //
      // blitToGLCanvas renders the source texture to the backend's
      // internal WebGL canvas and hands it back — no CPU readback,
      // so MediaPipe's GPU delegate can pull frames over WebGL→
      // WebGL channels. This was the biggest perf cliff: the old
      // path went GPU → 2D canvas (readback) → MediaPipe upload,
      // which stalled the pipeline for several ms per detect.
      const srcAspect = src!.width / src!.height;
      let cw: number;
      let ch: number;
      if (srcAspect >= 1) {
        cw = inputSize;
        ch = Math.max(1, Math.round(inputSize / srcAspect));
      } else {
        ch = inputSize;
        cw = Math.max(1, Math.round(inputSize * srcAspect));
      }
      let didDetect = false;
      try {
        const detectCanvas = ctx.blitToGLCanvas(src!, cw, ch);
        const result = state.landmarker!.detectForVideo(
          detectCanvas,
          nowMs
        );
        state.left.present = false;
        state.right.present = false;
        const allLandmarks = result.landmarks ?? [];
        const allHandedness = result.handedness ?? [];
        for (let i = 0; i < allLandmarks.length; i++) {
          const lms = allLandmarks[i];
          if (!lms || lms.length !== 21) continue;
          const labelCat = allHandedness[i]?.[0]?.categoryName ?? "Right";
          // MediaPipe labels from person's own perspective. Flip the
          // label for the mirrored-webcam case so the output
          // "left" socket corresponds to the hand on the screen
          // left (the user's left hand once mirrored).
          let side: "left" | "right" =
            labelCat === "Left" ? "left" : "right";
          if (flip) side = side === "left" ? "right" : "left";
          const raw: HandLM = lms.map((p: { x: number; y: number }) => ({
            x: p.x,
            y: p.y,
          }));
          if (side === "left") {
            state.left.raw = raw;
            state.left.present = true;
          } else {
            state.right.raw = raw;
            state.right.present = true;
          }
        }
        didDetect = true;
      } catch (err) {
        console.warn("Hand Tracker detect failed:", err);
      }
      if (didDetect) state.lastDetectAt = nowMs;
    }

    // Smooth every frame toward whatever `raw` latch currently holds.
    // When a hand drops out of frame, `raw` stays at the last-known
    // position, so the smoothed output settles there instead of
    // snapping to zero.
    state.left.smooth = smoothHand(
      state.left.smooth,
      state.left.raw,
      smoothing
    );
    state.right.smooth = smoothHand(
      state.right.smooth,
      state.right.raw,
      smoothing
    );

    // Primary spline: skeleton for both hands. Skip absent hands so
    // a disappeared hand doesn't draw ghost bones to stale positions.
    const subpaths: SplineSubpath[] = [
      ...(state.left.present ? handToSubpaths(state.left.smooth) : []),
      ...(state.right.present ? handToSubpaths(state.right.smooth) : []),
    ];
    const primary: SplineValue = { kind: "spline", subpaths };

    // Aux: wrist positions. Latched to last-known, so they're stable
    // output when the hand exits frame. Un-detected hands default
    // to (0.5, 0.5) — see landmarkAsVec2.
    const aux: Record<string, Vec2Value | PointsValue> = {
      left: landmarkAsVec2(state.left.smooth, 0),
      right: landmarkAsVec2(state.right.smooth, 0),
    };

    const tipsByName: Record<string, number> = TIP;
    const fingerNames = ["thumb", "index", "middle", "ring", "pinky"] as const;

    if (fingerMode === "vec2") {
      for (const side of ["left", "right"] as const) {
        const hand = side === "left" ? state.left.smooth : state.right.smooth;
        for (const finger of fingerNames) {
          aux[`${side}_${finger}`] = landmarkAsVec2(hand, tipsByName[finger]);
        }
      }
    } else if (fingerMode === "point") {
      for (const side of ["left", "right"] as const) {
        const hand = side === "left" ? state.left.smooth : state.right.smooth;
        for (const finger of fingerNames) {
          aux[`${side}_${finger}`] = landmarkAsSinglePoints(
            hand,
            tipsByName[finger]
          );
        }
      }
    } else if (fingerMode === "points") {
      // Aggregate every detected fingertip into one points value.
      // Skip sides that have never been seen so downstream nodes
      // don't instance at (0.5, 0.5) placeholders.
      const pts: Point[] = [];
      for (const side of ["left", "right"] as const) {
        const hand = side === "left" ? state.left.smooth : state.right.smooth;
        if (!hand) continue;
        for (const finger of fingerNames) {
          const lm = hand[tipsByName[finger]];
          pts.push({ pos: [lm.x, lm.y] });
        }
      }
      aux.fingers = { kind: "points", points: pts } satisfies PointsValue;
    }

    return { primary, aux };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as HandTrackerState | undefined;
    if (state?.landmarker) {
      try {
        state.landmarker.close();
      } catch {
        // ignore
      }
    }
    delete ctx.state[key];
  },
};
