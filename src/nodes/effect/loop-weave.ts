import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { buildLoopWeave, type WeaveParams } from "@/engine/spline-weave";

// Loop Weave — points → one open spline that visits the points in order,
// loop-de-looping around each in an elliptical orbit and connecting
// consecutive orbits with common-tangent runs. `direction` drives the
// character: alternate handedness = every connector crosses (the weave
// look), same-handed = cursive script loops. All per-point randomness
// hashes on point index + seed so appending a point live extends the
// path without reshuffling what's already drawn.
//
// Aux outputs carry the guide geometry from the reference look: `orbits`
// = each point's full orbit ellipse (style gray downstream), `skipped` =
// the untraveled arc of each orbit (Stroke's dash for the dashed-guide
// look). Both are groupIndex-tagged with the source point index and only
// built when consumed.
//
// Draw-on two ways: `progress` (keyframable, point-tour domain — reveals
// whole orbits, stable under live appends where an arc-length trim would
// re-normalize) and `reveal_mode: auto` — a stateful pen that draws one
// orbit per `reveal_time` seconds, catching up to the tail as points
// land. The pen integrates SCENE time, not wall-clock: it only advances
// while the timeline advances (paused cursor-move evals leave it
// frozen), and a backward jump — the loop wrap, or scrubbing back to
// frame 0 — resets it to redraw from the start. Scene-time integration
// also makes it deterministic, so offline export renders the reveal
// (played from frame 0 it matches the preview exactly).
//
// Spec: specdocs/071926_loop-weave.md.

interface LoopWeaveState {
  // Fractional tour units the auto-reveal pen has drawn so far.
  revealPos: number;
  // Scene time at the last compute — the pen advances by positive
  // deltas and RESETS when time moves backward (loop wrap / rewind).
  lastSceneTime: number;
  // Set by compute when the pen is still catching up — read by
  // fingerprintExtras to keep busting the cache while animating.
  inFlight: boolean;
}

function stateKey(nodeId: string): string {
  return `loop-weave:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): LoopWeaveState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as LoopWeaveState | undefined;
  if (existing) return existing;
  const s: LoopWeaveState = {
    revealPos: 0,
    lastSceneTime: ctx.time,
    inFlight: false,
  };
  ctx.state[key] = s;
  return s;
}

// Fresh per return — downstream consumers treat SplineValues as theirs
// to tag/iterate, so a shared module-level object would be a footgun.
const emptySpline = (): SplineValue => ({ kind: "spline", subpaths: [] });

export const loopWeaveNode: NodeDefinition = {
  type: "loop-weave",
  name: "Loop Weave",
  category: "spline",
  subcategory: "generator",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "order",
      label: "Order",
      type: "enum",
      options: ["index", "nearest"],
      default: "index",
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.005,
      max: 1,
      softMax: 0.25,
      step: 0.001,
      default: 0.06,
    },
    {
      name: "radius_jitter",
      label: "Radius jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
    },
    // Blend orbit size toward the local point spacing — isolated points
    // get big lassos, dense clusters tight curls.
    {
      name: "adaptive_radius",
      label: "Adaptive radius",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "use_point_scale",
      label: "Use point scale",
      type: "boolean",
      default: true,
    },
    {
      name: "squash",
      label: "Squash",
      type: "scalar",
      min: 0,
      max: 0.9,
      step: 0.01,
      default: 0.25,
    },
    {
      name: "orient",
      label: "Orient",
      type: "enum",
      options: ["travel", "fixed", "random", "point"],
      default: "travel",
    },
    {
      name: "orient_angle",
      label: "Angle (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: (p) => p.orient === "fixed",
    },
    // Shape modulation. Spiral: +1 = each winding halves the radius
    // (telephone-doodle, exits from inside its coils), −1 doubles it.
    {
      name: "spiral",
      label: "Spiral",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "lobes",
      label: "Lobes",
      type: "scalar",
      min: 0,
      max: 8,
      step: 1,
      default: 0,
    },
    {
      name: "lobe_depth",
      label: "Lobe depth",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.25,
      visibleIf: (p) => ((p.lobes as number) ?? 0) > 0,
    },
    {
      name: "wobble",
      label: "Wobble",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "loops",
      label: "Loops",
      type: "scalar",
      min: 0,
      max: 8,
      softMax: 3,
      step: 0.05,
      default: 1,
    },
    {
      name: "loops_jitter",
      label: "Loops jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "direction",
      label: "Direction",
      type: "enum",
      options: ["alternate", "cw", "ccw", "random"],
      default: "alternate",
    },
    // Connector character: tension = taut string → swooping flourish;
    // swing biases exit vs entry handle; sag bows runs down (+) or up (−).
    {
      name: "tension",
      label: "Tension",
      type: "scalar",
      min: 0.2,
      max: 3,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "swing",
      label: "Swing",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "sag",
      label: "Sag",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
    },
    {
      name: "ends",
      label: "Ends",
      type: "enum",
      options: ["center", "orbit"],
      default: "center",
    },
    {
      name: "smoothness",
      label: "Smoothness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "progress",
      label: "Progress",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "reveal_mode",
      label: "Reveal",
      type: "enum",
      options: ["off", "auto"],
      default: "off",
    },
    {
      name: "reveal_time",
      label: "Reveal time",
      type: "scalar",
      min: 0.05,
      max: 5,
      softMax: 2,
      step: 0.05,
      default: 0.6,
      visibleIf: (p) => p.reveal_mode === "auto",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [
    { name: "orbits", type: "spline" },
    { name: "skipped", type: "spline" },
  ],

  // The node is `stable`, so scene time is NOT in its base fingerprint —
  // while the auto-reveal pen is mid-stroke the extras key on the tick so
  // each new frame recomputes (playback and offline export both step the
  // tick; a paused editor doesn't, so cursor-move evals stay cache hits
  // and the pen stays frozen — exactly the wanted gating). A backward
  // time jump must bust the cache even when the pen is idle, or the
  // rewind's reset would never reach compute.
  fingerprintExtras(params, ctx, nodeId) {
    if (params.reveal_mode !== "auto") return "";
    const state = nodeId
      ? (ctx.state[stateKey(nodeId)] as LoopWeaveState | undefined)
      : undefined;
    if (!state) return `rv:${ctx.tick}`;
    if (ctx.time < state.lastSceneTime - 1e-6) return `rvreset:${ctx.tick}`;
    return state.inFlight ? `rv:${ctx.tick}` : "";
  },

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const pts = inputs.points as PointsValue | undefined;
    const smoothness = (params.smoothness as number) ?? 0.5;
    const weaveParams: WeaveParams = {
      order: params.order === "nearest" ? "nearest" : "index",
      radius: (params.radius as number) ?? 0.06,
      radiusJitter: (params.radius_jitter as number) ?? 0.35,
      usePointScale: params.use_point_scale !== false,
      squash: (params.squash as number) ?? 0.25,
      orient: (params.orient as WeaveParams["orient"]) ?? "travel",
      orientAngle: (((params.orient_angle as number) ?? 0) * Math.PI) / 180,
      loops: (params.loops as number) ?? 1,
      loopsJitter: (params.loops_jitter as number) ?? 0,
      direction: (params.direction as WeaveParams["direction"]) ?? "alternate",
      seed: (params.seed as number) ?? 0,
      ends: params.ends === "orbit" ? "orbit" : "center",
      // spiral slider is symmetric −1..1; the engine wants a per-turn
      // radius factor, so ±1 maps to halving/doubling per winding.
      spiralPerTurn: Math.pow(2, -((params.spiral as number) ?? 0)),
      lobes: (params.lobes as number) ?? 0,
      lobeDepth: (params.lobe_depth as number) ?? 0.25,
      wobble: (params.wobble as number) ?? 0,
      radiusFromSpacing: (params.adaptive_radius as number) ?? 0,
      tension: (params.tension as number) ?? 1,
      swing: (params.swing as number) ?? 0,
      sag: (params.sag as number) ?? 0,
      fitError: 0.25 + 3.75 * smoothness * smoothness,
      progress: (params.progress as number) ?? 1,
    };

    const count = pts && pts.kind === "points" ? pts.count : 0;

    // Auto-reveal pen: advance revealPos at one tour unit per
    // reveal_time seconds of SCENE time, clamped to the current count.
    // Deterministic (time-driven), so offline export renders it too.
    const autoReveal = params.reveal_mode === "auto";
    if (autoReveal && nodeId) {
      const state = ensureState(ctx, nodeId);
      // Rewind (loop wrap, scrub back, jump to frame 0) → redraw from
      // the start. Advance by positive scene-time deltas only: a paused
      // timeline freezes the pen no matter how many evals fire, and a
      // same-time re-eval (offline settle pass) never double-advances.
      if (ctx.time < state.lastSceneTime - 1e-6) state.revealPos = 0;
      const dt = Math.max(0, ctx.time - state.lastSceneTime);
      const revealTime = Math.max(0.05, (params.reveal_time as number) ?? 0.6);
      state.lastSceneTime = ctx.time;
      state.revealPos = Math.min(count, state.revealPos + dt / revealTime);
      state.inFlight = state.revealPos < count;
      const pos = state.revealPos;
      weaveParams.orbitLimit = (_src, tourIndex) =>
        Math.max(0, Math.min(1, pos - tourIndex));
    }

    if (!pts || pts.kind !== "points" || count < 2) {
      return {
        primary: emptySpline(),
        aux: { orbits: emptySpline(), skipped: emptySpline() },
      };
    }

    const wantOrbits = !consumedOutputs || consumedOutputs.has("aux:orbits");
    const wantSkipped = !consumedOutputs || consumedOutputs.has("aux:skipped");
    const res = buildLoopWeave(
      pts,
      ctx.width,
      ctx.height,
      weaveParams,
      wantOrbits,
      wantSkipped
    );

    return {
      primary: res.weave,
      aux: { orbits: res.orbits, skipped: res.skipped },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
