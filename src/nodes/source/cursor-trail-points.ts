import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
} from "@/engine/types";
import { makePoints, EMPTY_POINTS } from "@/engine/points";
import { hash01 } from "@/engine/spline-color-source";

// Cursor Trail Points — drop points along the pointer's path while
// drawing on the preview. The live companion to Loop Weave (spec
// specdocs/071926_loop-weave.md): Cursor Trail Points → Loop Weave →
// Stroke is the whole demo graph, but any points consumer works.
//
// Drops are evenly spaced along the stroke (fast swipes interpolate so
// spacing holds), jittered radially by a hash on the drop's monotonic id
// — deterministic per drop, so re-evals never make the trail shimmer,
// and appends never move existing points. Positions are emitted y-DOWN
// normalized (CPU point space); note ctx.cursor is y-UP canvas UV, the
// flip happens here.
//
// `emit: press` needs CursorState.pressed (tracked by the editor and
// live viewer); contexts without it never read as pressed — switch to
// `hover` there.

interface TrailDrop {
  x: number; // y-down normalized
  y: number;
  id: number; // monotonic — hash + groupIndex identity
  t: number; // wall-clock landing time (lifetime expiry)
}

interface TrailState {
  drops: TrailDrop[];
  nextId: number;
  // Last drop's RAW (unjittered) position — spacing measures the pen
  // path, not the scattered output.
  lastX: number | null;
  lastY: number | null;
  lastSceneTime: number;
}

function stateKey(nodeId: string): string {
  return `cursor-trail:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): TrailState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as TrailState | undefined;
  if (existing) return existing;
  const s: TrailState = {
    drops: [],
    nextId: 0,
    lastX: null,
    lastY: null,
    lastSceneTime: ctx.time,
  };
  ctx.state[key] = s;
  return s;
}

const SALT_ANG = 53;
const SALT_RAD = 157;

export const cursorTrailPointsNode: NodeDefinition = {
  type: "cursor-trail-points",
  name: "Cursor Trail Points",
  category: "point",
  subcategory: "generator",
  description:
    "Drop points along the pointer's path while drawing on the preview — evenly spaced with seeded radial scatter. Feed Loop Weave for the live loop-de-loop demo, or any points consumer. Press mode draws while the mouse button is held; hover drops wherever the pointer moves.",
  backend: "webgl2",
  // External cursor + wall-clock state — recompute every eval.
  stable: false,
  inputs: [],
  params: [
    {
      name: "emit",
      label: "Emit",
      type: "enum",
      options: ["press", "hover"],
      default: "press",
    },
    {
      name: "spacing",
      label: "Spacing",
      type: "scalar",
      min: 0.005,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0.04,
    },
    {
      name: "scatter",
      label: "Scatter",
      type: "scalar",
      min: 0,
      max: 0.25,
      step: 0.001,
      default: 0.02,
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
      name: "max_points",
      label: "Max points",
      type: "scalar",
      min: 2,
      max: 2000,
      softMax: 500,
      step: 1,
      default: 200,
    },
    {
      name: "overflow",
      label: "Overflow",
      type: "enum",
      options: ["stop", "ring"],
      default: "stop",
    },
    {
      name: "lifetime",
      label: "Lifetime (s)",
      type: "scalar",
      min: 0,
      max: 60,
      softMax: 10,
      step: 0.1,
      default: 0,
    },
    {
      name: "clear_on_loop",
      label: "Clear on loop",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  // stable:false already recomputes THIS node every eval; the extras key
  // is for DOWNSTREAM caches — they only need busting when the drop set
  // actually changes (adds, ring shifts, lifetime expiry).
  fingerprintExtras(_params, ctx, nodeId) {
    const state = nodeId
      ? (ctx.state[stateKey(nodeId)] as TrailState | undefined)
      : undefined;
    if (!state || state.drops.length === 0) return "trail:0";
    const first = state.drops[0].id;
    return `trail:${state.nextId}:${state.drops.length}:${first}`;
  },

  compute({ params, ctx, nodeId }) {
    const state = ensureState(ctx, nodeId);
    const now = performance.now() / 1000;

    if (params.clear_on_loop !== false && ctx.time < state.lastSceneTime - 1e-6) {
      state.drops = [];
      state.lastX = null;
      state.lastY = null;
    }
    state.lastSceneTime = ctx.time;

    const lifetime = (params.lifetime as number) ?? 0;
    if (lifetime > 0 && state.drops.length > 0) {
      state.drops = state.drops.filter((d) => now - d.t < lifetime);
      if (state.drops.length === 0) {
        state.lastX = null;
        state.lastY = null;
      }
    }

    const maxPoints = Math.max(2, Math.round((params.max_points as number) ?? 200));
    const ring = params.overflow === "ring";
    const spacingPx = Math.max(1, ((params.spacing as number) ?? 0.04) * ctx.width);

    const c = ctx.cursor;
    const drawing =
      c.active && ((params.emit ?? "press") === "hover" || c.pressed === true);
    if (drawing) {
      // ctx.cursor is y-UP canvas UV; point space is y-DOWN.
      const cx = c.x;
      const cy = 1 - c.y;
      const drop = (x: number, y: number) => {
        if (state.drops.length >= maxPoints) {
          if (!ring) return false;
          state.drops.shift();
        }
        state.drops.push({ x, y, id: state.nextId++, t: now });
        state.lastX = x;
        state.lastY = y;
        return true;
      };
      if (state.lastX === null || state.lastY === null) {
        drop(cx, cy);
      } else {
        // Walk the pen segment in spacing-sized steps so fast swipes
        // stay evenly spaced instead of leaving one drop per frame.
        let guard = 256;
        for (;;) {
          const dx = (cx - state.lastX!) * ctx.width;
          const dy = (cy - state.lastY!) * ctx.height;
          const dist = Math.hypot(dx, dy);
          if (dist < spacingPx || guard-- <= 0) break;
          const t = spacingPx / dist;
          if (!drop(state.lastX! + (cx - state.lastX!) * t, state.lastY! + (cy - state.lastY!) * t))
            break;
        }
      }
    }

    // A decaying trail should keep animating (and re-evaluating) even
    // when playback is paused and the pointer is still.
    if (lifetime > 0 && state.drops.length > 0 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("pipeline-bump"));
    }

    const n = state.drops.length;
    if (n === 0) return { primary: EMPTY_POINTS };

    const seed = Math.floor((params.seed as number) ?? 0);
    const scatter = (params.scatter as number) ?? 0.02;
    const out: PointsValue = makePoints(n, { withGroupIndices: true });
    for (let i = 0; i < n; i++) {
      const d = state.drops[i];
      // Uniform disk jitter in px space (aspect-round), hashed on the
      // drop id so a given point never moves once placed.
      const ang = hash01(d.id, seed + SALT_ANG) * Math.PI * 2;
      const rad = scatter * ctx.width * Math.sqrt(hash01(d.id, seed + SALT_RAD));
      out.positions[i * 2] = d.x + (rad * Math.cos(ang)) / ctx.width;
      out.positions[i * 2 + 1] = d.y + (rad * Math.sin(ang)) / ctx.height;
      out.groupIndices![i] = d.id;
    }
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
