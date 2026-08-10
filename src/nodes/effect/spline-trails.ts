import type {
  NodeDefinition,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { catmullRomSubpath } from "@/engine/spline-math";

// Spline Trails — watch a points input over time and emit one open spline
// subpath per point tracing where that point has been (a motion trail).
// The temporal sibling of Points to Spline: that node chains the CURRENT
// set in index order; this one chains each point's HISTORY.
//
// Accumulation is SCENE-time driven (ctx.time, never wall clock), which is
// what makes it exportable: `simulation: true` + scene-time samples means
// the export drivers' pre-roll (lib/sim-preroll.ts) reproduces the preview
// exactly. Paused evals move the trail head in place but never grow it;
// scene time jumping backwards (timeline loop, rewind) clears everything
// when `clear_on_loop` is on — same convention as Cursor Trail Points and
// Loop Weave's auto-reveal pen.
//
// Trail identity must survive membership churn (Cursor Trail Points' ring
// overflow shifts indices; particles die). Key = groupIndex + ordinal
// within that group when the input is tagged, else the array index — this
// handles both groupIndex regimes (unique-id-per-point tags and Collect's
// collection-id tags). An identity that disappears keeps its trail, which
// decays by age — a dead particle's trail fades out instead of vanishing.
//
// Coordinates pass through untouched (authored in → authored out): no
// aspect math belongs here.
//
// Spec: specdocs/080926_spline-trails.md.

interface TrailSample {
  x: number;
  y: number;
  t: number; // scene time when sampled (age expiry)
}

interface Trail {
  samples: TrailSample[]; // oldest → newest
  // Emission tag + stable sort keys, refreshed each eval the identity is
  // present (a Collect upstream can retag without breaking the trail).
  groupIndex?: number;
  ord: number;
}

interface TrailsState {
  trails: Map<string, Trail>;
  lastSceneTime: number;
}

// Sanity ceilings, not creative controls: identities beyond MAX_TRAILS are
// ignored; a trail past MAX_SAMPLES drops its oldest. 30s at 30fps fits.
const MAX_TRAILS = 2048;
const MAX_SAMPLES = 1024;
// Below this squared distance the point "hasn't moved": refresh the head
// sample's timestamp instead of pushing a coincident duplicate, so a
// stationary point's trail contracts by expiry instead of clumping.
const EPS_SQ = 1e-6 * 1e-6;

function stateKey(nodeId: string): string {
  return `spline-trails:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): TrailsState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as TrailsState | undefined;
  if (existing) return existing;
  const s: TrailsState = { trails: new Map(), lastSceneTime: ctx.time };
  ctx.state[key] = s;
  return s;
}

export const splineTrailsNode: NodeDefinition = {
  type: "spline-trails",
  name: "Spline Trails",
  category: "spline",
  subcategory: "generator",
  description:
    "Trace each input point's motion over time as its own spline — the classic motion trail. Feed it anything animated (Points on Path with Animate, a particle sim's points, Modulate Points wiggle) and wire the output into Stroke or Rasterize Spline. Length sets how many seconds of history each trail keeps; Tail width tapers the stroke toward the oldest end (0 = fades to nothing, 1 = uniform). Trails follow point identity through membership changes, so a vanished point's trail fades out naturally. Scene-time driven: paused edits reposition trail heads without growing them, and exports reproduce the preview.",
  backend: "webgl2",
  // State advances with the eval clock — recompute every eval; the
  // evaluator's stable:false time stamp busts downstream while playing.
  stable: false,
  // Frame-accumulated ctx.state driven by ctx.time — export must pre-roll.
  simulation: true,
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "length",
      label: "Length (s)",
      type: "scalar",
      min: 0.05,
      max: 30,
      softMax: 3,
      step: 0.01,
      default: 0.75,
    },
    {
      name: "curve",
      label: "Curve",
      type: "enum",
      options: ["linear", "smooth"],
      default: "smooth",
    },
    {
      // Width-profile multiplier (SplineAnchor.width) at the OLDEST
      // sample, lerped to 1 at the head — the consuming stroke's
      // variable-width envelope renders the taper. Only written when < 1.
      name: "tail_width",
      label: "Tail width",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "clear_on_loop",
      label: "Clear on loop",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const state = ensureState(ctx, nodeId);
    const now = ctx.time;
    const prevTime = state.lastSceneTime;
    state.lastSceneTime = now;

    if (params.clear_on_loop !== false && now < prevTime - 1e-6) {
      state.trails.clear();
    }

    // Age out old samples on EVERY trail (including ones whose identity is
    // gone this eval — that's how a dead point's trail fades), then drop
    // empty trails.
    const length = Math.max(0.05, (params.length as number) ?? 0.75);
    for (const [key, trail] of state.trails) {
      const samples = trail.samples;
      let drop = 0;
      while (drop < samples.length && now - samples[drop].t > length) drop++;
      if (drop > 0) samples.splice(0, drop);
      if (samples.length === 0) state.trails.delete(key);
    }

    const src = inputs.points;
    const advanced = now > prevTime + 1e-9;
    if (src && src.kind === "points" && src.count > 0) {
      const pos = src.positions;
      const groups = src.groupIndices;
      // Ordinal within each groupIndex this eval (see identity note above).
      const ordinals = groups ? new Map<number, number>() : null;
      for (let i = 0; i < src.count; i++) {
        let key: string;
        let gi: number | undefined;
        let ord: number;
        if (groups && ordinals) {
          gi = groups[i];
          ord = ordinals.get(gi) ?? 0;
          ordinals.set(gi, ord + 1);
          key = `${gi}:${ord}`;
        } else {
          gi = undefined;
          ord = i;
          key = `i:${i}`;
        }
        let trail = state.trails.get(key);
        if (!trail) {
          if (state.trails.size >= MAX_TRAILS) continue;
          trail = { samples: [], ord };
          state.trails.set(key, trail);
        }
        trail.groupIndex = gi;
        trail.ord = ord;

        const x = pos[i * 2];
        const y = pos[i * 2 + 1];
        const samples = trail.samples;
        const head = samples[samples.length - 1];
        if (!head) {
          samples.push({ x, y, t: now });
        } else if (advanced) {
          const dx = x - head.x;
          const dy = y - head.y;
          if (dx * dx + dy * dy < EPS_SQ) {
            // Stationary: refresh instead of clumping (see EPS_SQ).
            head.t = now;
          } else {
            samples.push({ x, y, t: now });
            if (samples.length > MAX_SAMPLES) samples.shift();
          }
        } else {
          // Paused (or same-tick re-eval): a param tweak upstream moved
          // the point — the trail head follows, the history doesn't grow.
          head.x = x;
          head.y = y;
        }
      }
    }

    // Emit trails with ≥2 samples, oldest → newest so the head is the path
    // end (trim/draw-on reveals tail-first). Sort by (groupIndex, ordinal)
    // for output order that's stable regardless of input interleaving.
    const emit = Array.from(state.trails.values())
      .filter((t) => t.samples.length >= 2)
      .sort(
        (a, b) =>
          (a.groupIndex ?? -Infinity) - (b.groupIndex ?? -Infinity) ||
          a.ord - b.ord
      );
    const smooth = ((params.curve as string) ?? "smooth") === "smooth";
    const tailWidth = Math.min(1, Math.max(0, (params.tail_width as number) ?? 0));
    const subpaths: SplineSubpath[] = [];
    for (const trail of emit) {
      const run = trail.samples.map((s) => [s.x, s.y] as [number, number]);
      const sub: SplineSubpath = smooth
        ? catmullRomSubpath(run, false)
        : { anchors: run.map((p) => ({ pos: p })), closed: false };
      if (tailWidth < 1) {
        const n = sub.anchors.length;
        for (let k = 0; k < n; k++) {
          sub.anchors[k].width = tailWidth + ((1 - tailWidth) * k) / (n - 1);
        }
      }
      if (trail.groupIndex !== undefined) sub.groupIndex = trail.groupIndex;
      subpaths.push(sub);
    }

    const out: SplineValue = { kind: "spline", subpaths };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
