// Blender-style modal transforms — G (move), S (scale), R (rotate), plus
// E (extrude) — over the Spline Draw overlay's current target set. Press a
// key with the cursor inside the canvas and the geometry follows the pointer
// with no button held; left click or Enter confirms, Escape or right click
// reverts. X / Y constrain move + scale to one axis; Shift snaps a rotate to
// 45° increments (the same lock the handle drags use).
//
// E extrudes: it appends (or, from the head, prepends) a fresh anchor at the
// open active subpath's endpoint and hands the modal a move of JUST that
// anchor — so points can be added without leaving the sub-path tool, and the
// new anchor stays selected so E chains.
//
// Targets, in the order a user would expect:
//   - Path Select     → every anchor of every subpath (that tool's unit is
//                       the whole path).
//   - anything else   → the selected anchors, or the whole active subpath
//                       when the selection is empty.
//
// All the math runs in NORMALIZED units. That's exact rather than merely
// convenient: the overlay's normalized space is aspect-corrected, so a
// normalized offset maps to pixels by a uniform scale (rect.width) on BOTH
// axes — a uniform normalized scale is a uniform screen scale, and a
// normalized rotation is a true screen rotation, on any canvas aspect.
//
// Every move writes the whole value from the start snapshot (never
// compounding), through the same onChange as the pointer drags — so undo
// coalescing, autokey and keyframing behave identically.

import type { SplineAnchor } from "@/engine/types";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import { mintAnchorId, subpathsOf } from "../geometry";
import type { ModalTransform, SplineEditorEnv } from "../types";

// Which anchors a modal transform acts on. Empty ⇒ nothing to transform.
function modalTargets(env: SplineEditorEnv): Array<[number, number]> {
  const subs = subpathsOf(env.valueRef.current);
  const out: Array<[number, number]> = [];
  if (env.tool === "path") {
    for (let s = 0; s < subs.length; s++) {
      for (let a = 0; a < subs[s].anchors.length; a++) out.push([s, a]);
    }
    return out;
  }
  const ai = env.activeSubpathRef.current;
  const anchors = subs[ai]?.anchors ?? [];
  const sel = env.selectedRef.current;
  if (sel.size > 0) {
    for (const i of sel) if (anchors[i]) out.push([ai, i]);
    if (out.length > 0) return out;
  }
  for (let a = 0; a < anchors.length; a++) out.push([ai, a]);
  return out;
}

// Arm a transform at the current pointer position, or null when there's
// nothing to move (no anchors yet, or no rect).
export function beginModalTransform(
  env: SplineEditorEnv,
  mode: ModalTransform["mode"],
  pointer: { x: number; y: number }
): ModalTransform | null {
  if (!env.rect) return null;
  const targets = modalTargets(env);
  if (targets.length === 0) return null;
  const startValue = env.valueRef.current;
  const subs = subpathsOf(startValue);
  let px = 0;
  let py = 0;
  for (const [s, a] of targets) {
    const p = subs[s].anchors[a].pos;
    px += p[0];
    py += p[1];
  }
  return {
    mode,
    targets,
    startValue,
    cancelValue: startValue,
    cancelSelection: null,
    pivot: [px / targets.length, py / targets.length],
    startNorm: env.clientToNorm(pointer.x, pointer.y),
    axis: null,
  };
}

// E — extrude: grow the open active subpath by one anchor at its end and arm
// a move of just that anchor. The source endpoint is the single selected
// endpoint when there is one, otherwise the tail ("E extends the end of the
// path"); selecting the head extrudes BACKWARD, prepending. Returns null on
// a closed / empty subpath, where there's no end to extrude from.
//
// The new anchor is a plain corner at the endpoint's position — the segment
// into it therefore leaves along whatever out-handle the endpoint already
// had, so extruding a curved path continues its tangent.
export function beginExtrude(
  env: SplineEditorEnv,
  pointer: { x: number; y: number }
): ModalTransform | null {
  if (!env.rect) return null;
  const cur = env.valueRef.current;
  const subs = subpathsOf(cur);
  const si = env.activeSubpathRef.current;
  const sub = subs[si];
  if (!sub || sub.closed || sub.anchors.length === 0) return null;
  const n = sub.anchors.length;
  const sel = env.selectedRef.current;
  let from = n - 1;
  if (sel.size === 1) {
    const s = [...sel][0];
    if (s === 0 || s === n - 1) from = s;
  }
  // A lone anchor is both ends; appending keeps index order intuitive.
  const atStart = from === 0 && n > 1;
  const src = sub.anchors[from];
  const minted: SplineAnchor = {
    id: mintAnchorId(),
    pos: [src.pos[0], src.pos[1]],
  };
  const anchors = atStart
    ? [minted, ...sub.anchors]
    : [...sub.anchors, minted];
  const newIndex = atStart ? 0 : anchors.length - 1;
  const next: SplineParamValue = {
    ...cur,
    subpaths: subs.map((s, i) => (i === si ? { ...s, anchors } : s)),
  };
  env.onChangeRef.current(next);
  // Leave the new anchor selected: after the confirming click it's still an
  // endpoint, so pressing E again extrudes from it and the tool chains.
  env.setSelected(new Set([newIndex]));
  env.lastAnchorRef.current = newIndex;
  return {
    mode: "move",
    targets: [[si, newIndex]],
    startValue: next,
    cancelValue: cur,
    cancelSelection: new Set([from]),
    pivot: [minted.pos[0], minted.pos[1]],
    startNorm: env.clientToNorm(pointer.x, pointer.y),
    axis: null,
  };
}

// Readouts for the moment a transform is armed but the pointer hasn't moved
// yet. Kept here beside the live formats so the two never drift — and so
// arming a transform costs no identity write (which would otherwise leave a
// no-op entry in the undo stack for a G-then-Escape).
export const MODAL_HUD_SEED: Record<ModalTransform["mode"], string> = {
  move: "Δ 0.000, 0.000",
  scale: "× 1.000",
  rotate: "∠ 0.0°",
};

// Rebuild the value with `f` applied to every targeted anchor. Untouched
// subpaths and anchors pass through by reference.
function mapTargets(
  start: SplineParamValue,
  targets: Array<[number, number]>,
  f: (a: SplineAnchor) => SplineAnchor
): SplineParamValue {
  const bySubpath = new Map<number, Set<number>>();
  for (const [s, a] of targets) {
    let set = bySubpath.get(s);
    if (!set) {
      set = new Set<number>();
      bySubpath.set(s, set);
    }
    set.add(a);
  }
  return {
    ...start,
    subpaths: subpathsOf(start).map((sub, si) => {
      const idxs = bySubpath.get(si);
      if (!idxs) return sub;
      return {
        ...sub,
        anchors: sub.anchors.map((an, ai) => (idxs.has(ai) ? f(an) : an)),
      };
    }),
  };
}

const scaleVec = (
  v: [number, number] | undefined,
  sx: number,
  sy: number
): [number, number] | undefined => (v ? [v[0] * sx, v[1] * sy] : v);

const rotVec = (
  v: [number, number] | undefined,
  c: number,
  s: number
): [number, number] | undefined =>
  v ? [v[0] * c - v[1] * s, v[0] * s + v[1] * c] : v;

// Apply the transform for the live pointer position and write the result.
// `shift` snaps a rotate to 45° increments of the TOTAL angle (matching the
// handle-drag angle lock); move and scale ignore it. Returns the HUD text.
export function applyModalTransform(
  env: SplineEditorEnv,
  m: ModalTransform,
  clientX: number,
  clientY: number,
  shift = false
): string {
  const [cx, cy] = env.clientToNorm(clientX, clientY);
  const suffix = m.axis ? `  ${m.axis.toUpperCase()}` : "";
  let next: SplineParamValue;
  let text: string;
  if (m.mode === "move") {
    const dx = m.axis === "y" ? 0 : cx - m.startNorm[0];
    const dy = m.axis === "x" ? 0 : cy - m.startNorm[1];
    next = mapTargets(m.startValue, m.targets, (a) => ({
      ...a,
      pos: [a.pos[0] + dx, a.pos[1] + dy],
    }));
    text = `Δ ${dx.toFixed(3)}, ${dy.toFixed(3)}${suffix}`;
  } else if (m.mode === "scale") {
    const d0 = Math.hypot(
      m.startNorm[0] - m.pivot[0],
      m.startNorm[1] - m.pivot[1]
    );
    const d1 = Math.hypot(cx - m.pivot[0], cy - m.pivot[1]);
    // Starting the gesture on top of the pivot has no reference distance —
    // hold at 1:1 rather than blowing the shape up by a huge ratio.
    const f = d0 > 1e-4 ? d1 / d0 : 1;
    const sx = m.axis === "y" ? 1 : f;
    const sy = m.axis === "x" ? 1 : f;
    next = mapTargets(m.startValue, m.targets, (a) => ({
      ...a,
      pos: [
        m.pivot[0] + (a.pos[0] - m.pivot[0]) * sx,
        m.pivot[1] + (a.pos[1] - m.pivot[1]) * sy,
      ],
      inHandle: scaleVec(a.inHandle, sx, sy),
      outHandle: scaleVec(a.outHandle, sx, sy),
    }));
    text = `× ${f.toFixed(3)}${suffix}`;
  } else {
    const a0 = Math.atan2(
      m.startNorm[1] - m.pivot[1],
      m.startNorm[0] - m.pivot[0]
    );
    const a1 = Math.atan2(cy - m.pivot[1], cx - m.pivot[0]);
    const STEP = Math.PI / 4;
    const raw = a1 - a0;
    const th = shift ? Math.round(raw / STEP) * STEP : raw;
    const c = Math.cos(th);
    const s = Math.sin(th);
    next = mapTargets(m.startValue, m.targets, (a) => {
      const dx = a.pos[0] - m.pivot[0];
      const dy = a.pos[1] - m.pivot[1];
      return {
        ...a,
        pos: [
          m.pivot[0] + dx * c - dy * s,
          m.pivot[1] + dx * s + dy * c,
        ],
        inHandle: rotVec(a.inHandle, c, s),
        outHandle: rotVec(a.outHandle, c, s),
      };
    });
    // Screen-space degrees, normalized to (-180, 180]. Y is down, so a
    // positive angle reads clockwise — the direction the pointer travelled.
    let deg = (th * 180) / Math.PI;
    deg = ((((deg + 180) % 360) + 360) % 360) - 180;
    text = `∠ ${deg.toFixed(1)}°`;
  }
  env.onChangeRef.current(next);
  return text;
}

// Escape / right click: put the snapshot back in one write (for an extrude
// that's the PRE-extrude value, so the new anchor goes away with it, and the
// selection returns to the anchor it grew from).
export function cancelModalTransform(
  env: SplineEditorEnv,
  m: ModalTransform
) {
  env.onChangeRef.current(m.cancelValue);
  if (m.cancelSelection) env.setSelected(new Set(m.cancelSelection));
}
