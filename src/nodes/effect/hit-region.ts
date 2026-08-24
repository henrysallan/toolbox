import type {
  ImageValue,
  NodeDefinition,
  CursorState,
  RenderContext,
} from "@/engine/types";
import { aspectUncorrectY } from "@/engine/aspect";
import {
  createCursorSignalState,
  deriveCursorSignals,
  type CursorSignalState,
} from "@/engine/cursor-signals";

// Hit Region — the "any shape is a button" primitive
// (081726_pointer-interaction.md §3.4). Gates pointer signals on a mask
// input: because spline→mask coercion exists, a Circle, a Text
// silhouette, or an SVG wired into `region` becomes a clickable /
// draggable hit area; image masks (thresholds, gradients) work too.
//
// GRAB semantics, like every real UI button: the hit test runs at PRESS
// time (against the frozen press-position facts), and the gesture stays
// owned until release even if the cursor exits the region mid-drag —
// `held` doesn't flicker at the edge, and `drag_delta` keeps tracking.
// `click` = an owned gesture that released within `slop` px of travel.
//
// The hit test itself is a 1×1 sample-at-UV pass + readback (the
// image→scalar coercion's precedent). One sample per eval for hover,
// plus one at each press edge — no caching, because a pooled mask
// texture's identity says nothing about its content, and a wrong cache
// here reads as "the button ignored me".
//
// The ownership logic is pure and exported (deriveHitRegion) so
// check-cursor-capture can drive it with a synthetic field.

export interface HitRegionState {
  signals: CursorSignalState;
  owned: boolean;
  releasedOwnedSerial: number;
  prevHover: boolean;
  lastCountChangeSerial: number;
  target: ImageValue | null;
}

export interface HitRegionSignals {
  hover: boolean;
  held: boolean;
  press: boolean;
  release: boolean;
  click: boolean;
}

export function createHitRegionState(): HitRegionState {
  return {
    signals: createCursorSignalState(),
    owned: false,
    releasedOwnedSerial: -10,
    prevHover: false,
    lastCountChangeSerial: -10,
    target: null,
  };
}

// `sample` returns the region value at a canvas-UV (y-up) position, or
// null when no region is wired. Mutates st; idempotent within a pass
// (the release edge records its serial so re-derives agree even after
// `owned` clears).
export function deriveHitRegion(
  cursor: CursorState,
  st: HitRegionState,
  slopPx: number,
  threshold: number,
  sample: (xUv: number, yUvUp: number) => number | null
): HitRegionSignals {
  const sig = deriveCursorSignals(cursor, st.signals, slopPx);
  const serial = cursor.serial ?? 0;
  if (sig.press || sig.release) st.lastCountChangeSerial = serial;

  if (sig.press) {
    const v = sample(cursor.pressX ?? cursor.x, cursor.pressY ?? cursor.y);
    st.owned = v !== null && v >= threshold;
  }
  if (sig.release && st.owned) {
    st.owned = false;
    st.releasedOwnedSerial = serial;
  }
  const releasedOwned = st.releasedOwnedSerial === serial;

  const hoverV = cursor.active ? sample(cursor.x, cursor.y) : null;
  const hover = hoverV !== null && hoverV >= threshold;
  st.prevHover = hover;

  return {
    hover,
    held: sig.held && st.owned,
    press: sig.press && st.owned,
    release: releasedOwned,
    click: sig.click && releasedOwned,
  };
}

const SAMPLE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_pos;
out vec4 outColor;
void main() {
  float m = texture(u_src, u_pos).r;
  outColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Point-sample a mask at an exact canvas UV (y-up) via a 1×1
// sample-at-UV pass + readback. Shared with Draggable, which runs the
// same hit test against an offset-compensated position. `holder.target`
// is the caller's persistent 1×1 target (release it in dispose).
export function makeRegionSampler(
  ctx: RenderContext,
  holder: { target: ImageValue | null },
  region: { texture: WebGLTexture }
): (xUv: number, yUvUp: number) => number | null {
  if (!holder.target) holder.target = ctx.allocImage({ width: 1, height: 1 });
  const target = holder.target;
  const prog = ctx.getShader("hit-region/sample", SAMPLE_FS);
  return (x, y) => {
    // cursor UV is y-UP, exactly the texture's v_uv convention — no
    // flip here (flipping was the classic way this reads the wrong
    // half of the canvas).
    ctx.drawFullscreen(prog, target, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, region.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_pos"), x, y);
    });
    const data = ctx.readImagePixels(target, 1, 1);
    return data ? data[0] / 255 : null;
  };
}

function stateKey(nodeId: string): string {
  return `hit-region:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): HitRegionState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as HitRegionState | undefined;
  if (existing) return existing;
  const s = createHitRegionState();
  ctx.state[key] = s;
  return s;
}

export const hitRegionNode: NodeDefinition = {
  type: "hit-region",
  name: "Hit Region",
  category: "utility",
  subcategory: "modifier",
  description:
    "Turn any shape into a button: gates pointer signals on a mask region (wire a Circle, Text, SVG, or any spline — the silhouette becomes the hit area). Outputs hover, and press / click / release / held for gestures that STARTED inside, with real button grab semantics (leaving mid-drag doesn't drop the gesture). drag_delta tracks the owned gesture — Hit Region → Trigger Envelope is an interactive button; drag_delta → Transform is a crude handle.",
  backend: "webgl2",
  // Live pointer + readback state — recompute every eval.
  stable: false,
  retimeable: false,
  inputs: [{ name: "region", type: "mask", required: false }],
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
  ],
  primaryOutput: "scalar",
  auxOutputs: [
    { name: "hover", type: "scalar" },
    { name: "press", type: "scalar" },
    { name: "release", type: "scalar" },
    { name: "click", type: "scalar" },
    { name: "drag_delta", type: "vec2" },
  ],

  // Downstream cache token: cursor facts + pulse tail (Pointer's idiom)
  // + ownership/hover levels. Region CONTENT changes ride the input's
  // own fingerprint, which composes into this node's automatically.
  fingerprintExtras(_params, ctx, nodeId) {
    const c = ctx.cursor;
    const s = nodeId
      ? (ctx.state[stateKey(nodeId)] as HitRegionState | undefined)
      : undefined;
    const serial = c.serial ?? 0;
    const pulseTail =
      s && serial - s.lastCountChangeSerial <= 1 ? serial : 0;
    return `hit:${c.x.toFixed(5)},${c.y.toFixed(5)},${c.active ? 1 : 0},${c.pressCount ?? 0},${c.releaseCount ?? 0},${c.pressed ? 1 : 0},${pulseTail},${s?.owned ? 1 : 0},${s?.prevHover ? 1 : 0}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const s = ensureState(ctx, nodeId);
    const c = ctx.cursor;
    const threshold = (params.threshold as number) ?? 0.5;
    const slopPx = Math.max(0, (params.slop as number) ?? 4);

    const region = inputs.region?.kind === "mask" ? inputs.region : null;
    const sample = region
      ? makeRegionSampler(ctx, s, region)
      : () => null;

    const sig = deriveHitRegion(c, s, slopPx, threshold, sample);

    // Owned-gesture drag delta, authored units (Pointer's convention).
    let deltaX = 0;
    let deltaY = 0;
    if (sig.held) {
      const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
      const px = c.pressX ?? c.x;
      const py = aspectUncorrectY(1 - (c.pressY ?? c.y), aspect);
      deltaX = c.x - px;
      deltaY = aspectUncorrectY(1 - c.y, aspect) - py;
    }

    const bool = (v: boolean) =>
      ({ kind: "scalar", value: v ? 1 : 0 }) as const;
    return {
      primary: bool(sig.held),
      aux: {
        hover: bool(sig.hover),
        press: bool(sig.press),
        release: bool(sig.release),
        click: bool(sig.click),
        drag_delta: { kind: "vec2", value: [deltaX, deltaY] },
      },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const s = ctx.state[stateKey(nodeId)] as HitRegionState | undefined;
    if (s?.target) ctx.releaseTexture(s.target.texture);
    delete ctx.state[stateKey(nodeId)];
  },
};
