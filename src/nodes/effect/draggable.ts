import type { CursorState, NodeDefinition, RenderContext } from "@/engine/types";
import { aspectUncorrectY } from "@/engine/aspect";
import {
  createHitRegionState,
  deriveHitRegion,
  makeRegionSampler,
  type HitRegionState,
  type HitRegionSignals,
} from "./hit-region";

// Draggable — grab a shape and drag it (081726_pointer-interaction.md
// §3.6). Input `handle` is the UN-translated shape's mask (wire the
// shape itself — spline→mask coercion applies); the accumulated drag
// offset is the primary output. The canonical recipe:
//
//   Shape → Draggable.handle
//   Shape → Transform ← Draggable.offset   (added to translate)
//
// — a DAG, yet the handle follows its own drag. The trick: sampling the
// un-translated mask at (cursor − offset) equals sampling the translated
// mask at the cursor, so the hit test tracks the moved shape with no
// mask re-render and no feedback cycle. Grab semantics ride Hit Region's
// derive (press-time ownership, leaving mid-drag keeps the grab).
//
// Offsets are authored units — exactly what Transform's translate adds.
// Pure logic exported (deriveDraggable) for check-cursor-capture.

export interface DraggableState {
  hit: HitRegionState;
  baseX: number;
  baseY: number;
  foldSerial: number;
  // Total offset as of the previous eval — hover compensation uses it so
  // a LIVE drag's hover tracks the moving shape (one-eval lag, cosmetic).
  lastTotalX: number;
  lastTotalY: number;
  lastSceneTime: number;
}

export function createDraggableState(): DraggableState {
  return {
    hit: createHitRegionState(),
    baseX: 0,
    baseY: 0,
    foldSerial: -10,
    lastTotalX: 0,
    lastTotalY: 0,
    lastSceneTime: 0,
  };
}

export interface DraggableOpts {
  slopPx: number;
  threshold: number;
  sensitivity: number;
  axisX: number; // 1 | 0 masks
  axisY: number;
  aspect: number;
}

// `sample` reads the UN-translated handle mask at a canvas-UV (y-up)
// position; offset compensation happens here. Mutates st; idempotent
// within a pass.
export function deriveDraggable(
  cursor: CursorState,
  st: DraggableState,
  o: DraggableOpts,
  sample: (xUv: number, yUvUp: number) => number | null
): { sig: HitRegionSignals; offX: number; offY: number } {
  // Authored offset → screen (y-up UV) compensation: x is shared,
  // authored Δy scales by aspect into canvas UV and flips sign for y-up.
  const wrapped = (x: number, y: number) =>
    sample(x - st.lastTotalX, y + st.lastTotalY * o.aspect);
  const sig = deriveHitRegion(cursor, st.hit, o.slopPx, o.threshold, wrapped);

  const toAuthoredY = (yUp: number) => aspectUncorrectY(1 - yUp, o.aspect);
  const serial = cursor.serial ?? 0;

  if (sig.release && st.foldSerial !== serial) {
    st.foldSerial = serial;
    const px = cursor.pressX ?? cursor.x;
    const py = toAuthoredY(cursor.pressY ?? cursor.y);
    const rx = cursor.releaseX ?? cursor.x;
    const ry = toAuthoredY(cursor.releaseY ?? cursor.y);
    st.baseX += (rx - px) * o.sensitivity * o.axisX;
    st.baseY += (ry - py) * o.sensitivity * o.axisY;
  }

  let dX = 0;
  let dY = 0;
  if (sig.held) {
    const px = cursor.pressX ?? cursor.x;
    const py = toAuthoredY(cursor.pressY ?? cursor.y);
    dX = (cursor.x - px) * o.axisX;
    dY = (toAuthoredY(cursor.y) - py) * o.axisY;
  }
  const offX = st.baseX + dX * o.sensitivity;
  const offY = st.baseY + dY * o.sensitivity;
  st.lastTotalX = offX;
  st.lastTotalY = offY;
  return { sig, offX, offY };
}

function stateKey(nodeId: string): string {
  return `draggable:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): DraggableState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as DraggableState | undefined;
  if (existing) return existing;
  const s = createDraggableState();
  s.lastSceneTime = ctx.time;
  ctx.state[key] = s;
  return s;
}

export const draggableNode: NodeDefinition = {
  type: "draggable",
  name: "Draggable",
  category: "utility",
  subcategory: "modifier",
  description:
    "Make a shape grabbable: wire the shape's mask into handle, its offset output into a Transform translate on the same shape, and the shape drags by hand — editor and exported apps alike. The hit test follows the moved shape with no feedback cycle (it samples the un-translated mask at cursor − offset). Aux: held / hover / press / click. Reset input snaps back to rest.",
  backend: "webgl2",
  // Live pointer + accumulated offset + readback — recompute every eval.
  stable: false,
  retimeable: false,
  inputs: [
    { name: "handle", type: "mask", required: false },
    { name: "reset", type: "scalar", required: false },
  ],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "slop",
      label: "Click slop (px)",
      type: "scalar",
      min: 0,
      max: 40,
      step: 1,
      default: 4,
    },
    {
      name: "axis",
      label: "Drag axis",
      type: "enum",
      options: ["both", "x", "y"],
      default: "both",
    },
    {
      name: "sensitivity",
      label: "Drag sensitivity",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "clear_on_loop",
      label: "Clear on loop",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "vec2",
  auxOutputs: [
    { name: "held", type: "scalar" },
    { name: "hover", type: "scalar" },
    { name: "press", type: "scalar" },
    { name: "click", type: "scalar" },
  ],

  fingerprintExtras(_params, ctx, nodeId) {
    const c = ctx.cursor;
    const s = nodeId
      ? (ctx.state[stateKey(nodeId)] as DraggableState | undefined)
      : undefined;
    const serial = c.serial ?? 0;
    const pulseTail =
      s && serial - s.hit.lastCountChangeSerial <= 1 ? serial : 0;
    const acc = s
      ? `${s.baseX.toFixed(4)},${s.baseY.toFixed(4)},${s.hit.owned ? 1 : 0},${s.hit.prevHover ? 1 : 0}`
      : "0";
    return `drgbl:${c.x.toFixed(5)},${c.y.toFixed(5)},${c.active ? 1 : 0},${c.pressCount ?? 0},${c.releaseCount ?? 0},${c.pressed ? 1 : 0},${pulseTail},${acc}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const s = ensureState(ctx, nodeId);

    if (
      params.clear_on_loop === true &&
      ctx.time < s.lastSceneTime - 1e-6
    ) {
      s.baseX = 0;
      s.baseY = 0;
    }
    s.lastSceneTime = ctx.time;

    const resetSignal =
      inputs.reset?.kind === "scalar" ? inputs.reset.value : 0;
    if (resetSignal > 0.5) {
      s.baseX = 0;
      s.baseY = 0;
    }

    const axis = params.axis;
    const region = inputs.handle?.kind === "mask" ? inputs.handle : null;
    const sample = region
      ? makeRegionSampler(ctx, s.hit, region)
      : () => null;

    const { sig, offX, offY } = deriveDraggable(
      ctx.cursor,
      s,
      {
        slopPx: Math.max(0, (params.slop as number) ?? 4),
        threshold: (params.threshold as number) ?? 0.5,
        sensitivity: (params.sensitivity as number) ?? 1,
        axisX: axis === "y" ? 0 : 1,
        axisY: axis === "x" ? 0 : 1,
        aspect: ctx.height > 0 ? ctx.width / ctx.height : 1,
      },
      sample
    );

    const bool = (v: boolean) =>
      ({ kind: "scalar", value: v ? 1 : 0 }) as const;
    return {
      primary: { kind: "vec2", value: [offX, offY] },
      aux: {
        held: bool(sig.held),
        hover: bool(sig.hover),
        press: bool(sig.press),
        click: bool(sig.click),
      },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const s = ctx.state[stateKey(nodeId)] as DraggableState | undefined;
    if (s?.hit.target) ctx.releaseTexture(s.hit.target.texture);
    delete ctx.state[stateKey(nodeId)];
  },
};
