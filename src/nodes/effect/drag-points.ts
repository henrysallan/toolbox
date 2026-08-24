import type { NodeDefinition, RenderContext } from "@/engine/types";
import { aspectUncorrectY } from "@/engine/aspect";
import { copyPointsWith } from "@/engine/points";
import {
  createCursorSignalState,
  deriveCursorSignals,
  type CursorSignalState,
} from "@/engine/cursor-signals";

// Drag Points — grab individual points with the mouse and move them
// (081726_pointer-interaction.md §3.5). The DAG-cycle escape for direct
// manipulation: the hit region for "the thing you drag" must follow the
// thing, which depends on the drag output — so the per-point offsets
// live INSIDE this node's state, and the hit test runs against
// input-position-PLUS-stored-offset. Wire it between any stable points
// source and its consumers (Copy to Points, Connect Points, String Art)
// and the scene becomes hand-arrangeable — in the editor AND in
// exported apps.
//
// Grab: nearest point within `grab_radius` px of the press, gesture
// owns it until release (leaving the radius mid-drag doesn't drop it).
// Distances compare in PIXEL space with WIDTH scaling on both axes —
// authored y is anisotropic, and dividing y by height is the classic
// elliptical-grab-zone bug.
//
// KNOWN LIMIT: offsets are keyed by point INDEX. A count change resets
// them; a reorder lands them on the wrong points. Best on stable sets
// (Grid, fixed-count Spline to Points, authored points); a stable-id
// attribute is the future fix.

interface DragPointsState {
  signals: CursorSignalState;
  offsets: Float32Array | null;
  count: number;
  grabbed: number; // -1 = none
  grabBaseX: number;
  grabBaseY: number;
  foldSerial: number;
  lastCountChangeSerial: number;
  offsetsVersion: number;
  lastSceneTime: number;
}

function stateKey(nodeId: string): string {
  return `drag-points:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): DragPointsState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as DragPointsState | undefined;
  if (existing) return existing;
  const s: DragPointsState = {
    signals: createCursorSignalState(),
    offsets: null,
    count: -1,
    grabbed: -1,
    grabBaseX: 0,
    grabBaseY: 0,
    foldSerial: -10,
    lastCountChangeSerial: -10,
    offsetsVersion: 0,
    lastSceneTime: ctx.time,
  };
  ctx.state[key] = s;
  return s;
}

function toAuthored(
  x: number,
  yUp: number,
  ctx: RenderContext
): [number, number] {
  const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
  return [x, aspectUncorrectY(1 - yUp, aspect)];
}

export const dragPointsNode: NodeDefinition = {
  type: "drag-points",
  name: "Drag Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Grab individual points with the mouse (or touch) and drag them — offsets persist inside the node, so any points-driven scene becomes hand-arrangeable, in the editor and in exported apps. Grabs the nearest point within the grab radius at press; the gesture owns it until release. Offsets are index-keyed: best on stable point sets (a count change resets them). Reset input clears all offsets.",
  backend: "webgl2",
  // Live pointer + accumulated offsets — recompute every eval.
  stable: false,
  retimeable: false,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "reset", type: "scalar", required: false },
  ],
  params: [
    {
      name: "grab_radius",
      label: "Grab radius (px)",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 60,
      step: 1,
      default: 16,
    },
    {
      name: "clear_on_loop",
      label: "Clear on loop",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [
    { name: "active_index", type: "scalar" },
    { name: "grabbed", type: "scalar" },
  ],

  fingerprintExtras(_params, ctx, nodeId) {
    const c = ctx.cursor;
    const s = nodeId
      ? (ctx.state[stateKey(nodeId)] as DragPointsState | undefined)
      : undefined;
    const serial = c.serial ?? 0;
    const pulseTail =
      s && serial - s.lastCountChangeSerial <= 1 ? serial : 0;
    return `dragp:${c.x.toFixed(5)},${c.y.toFixed(5)},${c.active ? 1 : 0},${c.pressCount ?? 0},${c.releaseCount ?? 0},${c.pressed ? 1 : 0},${pulseTail},${s?.grabbed ?? -1},${s?.offsetsVersion ?? 0}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const s = ensureState(ctx, nodeId);
    const c = ctx.cursor;
    const src = inputs.points?.kind === "points" ? inputs.points : null;

    const inert = (points: unknown) => ({
      primary: points as never,
      aux: {
        active_index: { kind: "scalar", value: -1 } as const,
        grabbed: { kind: "scalar", value: 0 } as const,
      },
    });
    if (!src) return inert(inputs.points);

    if (s.count !== src.count) {
      s.offsets = new Float32Array(src.count * 2);
      s.count = src.count;
      s.grabbed = -1;
      s.offsetsVersion++;
    }
    const offsets = s.offsets!;

    if (
      params.clear_on_loop === true &&
      ctx.time < s.lastSceneTime - 1e-6
    ) {
      offsets.fill(0);
      s.grabbed = -1;
      s.offsetsVersion++;
    }
    s.lastSceneTime = ctx.time;

    const resetSignal =
      inputs.reset?.kind === "scalar" ? inputs.reset.value : 0;
    if (resetSignal > 0.5) {
      offsets.fill(0);
      s.grabbed = -1;
      s.offsetsVersion++;
    }

    const sig = deriveCursorSignals(c, s.signals, 4);
    const serial = c.serial ?? 0;
    if (sig.press || sig.release) s.lastCountChangeSerial = serial;

    const radiusPx = Math.max(1, (params.grab_radius as number) ?? 16);

    // Press edge: grab the nearest displaced point within radius.
    // Recomputing on a re-derived press pulse is deterministic — same
    // facts, same nearest point.
    if (sig.press) {
      const [ax, ay] = toAuthored(c.pressX ?? c.x, c.pressY ?? c.y, ctx);
      let best = -1;
      let bestD2 = radiusPx * radiusPx;
      for (let i = 0; i < src.count; i++) {
        const px = src.positions[i * 2] + offsets[i * 2];
        const py = src.positions[i * 2 + 1] + offsets[i * 2 + 1];
        // Width on BOTH axes — see header.
        const dx = (ax - px) * ctx.width;
        const dy = (ay - py) * ctx.width;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      s.grabbed = best;
      if (best >= 0) {
        s.grabBaseX = offsets[best * 2];
        s.grabBaseY = offsets[best * 2 + 1];
      }
    }

    // Live drag: absolute re-derive from the grab base — idempotent
    // under repeated evals of one pass.
    if (sig.held && s.grabbed >= 0) {
      const [px, py] = toAuthored(c.pressX ?? c.x, c.pressY ?? c.y, ctx);
      const [cx, cy] = toAuthored(c.x, c.y, ctx);
      offsets[s.grabbed * 2] = s.grabBaseX + (cx - px);
      offsets[s.grabbed * 2 + 1] = s.grabBaseY + (cy - py);
    }

    // Release: settle from the frozen facts, once per pass.
    if (sig.release && s.grabbed >= 0 && s.foldSerial !== serial) {
      s.foldSerial = serial;
      const [px, py] = toAuthored(c.pressX ?? c.x, c.pressY ?? c.y, ctx);
      const [rx, ry] = toAuthored(c.releaseX ?? c.x, c.releaseY ?? c.y, ctx);
      offsets[s.grabbed * 2] = s.grabBaseX + (rx - px);
      offsets[s.grabbed * 2 + 1] = s.grabBaseY + (ry - py);
      s.grabbed = -1;
      s.offsetsVersion++;
    }

    // Identity matters downstream: only mint new positions when any
    // offset is live (copyPointsWith keeps attributes/z/groups riding).
    let out = src;
    if (s.offsetsVersion > 0 || s.grabbed >= 0) {
      const positions = new Float32Array(src.positions);
      for (let i = 0; i < src.count; i++) {
        positions[i * 2] += offsets[i * 2];
        positions[i * 2 + 1] += offsets[i * 2 + 1];
      }
      out = copyPointsWith(src, { positions });
    }

    return {
      primary: out,
      aux: {
        active_index: { kind: "scalar", value: s.grabbed },
        grabbed: { kind: "scalar", value: s.grabbed >= 0 ? 1 : 0 },
      },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
