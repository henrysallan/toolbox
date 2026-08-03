// Measurement tool (spec 080226_font-precision-toolkit.md M4) — the type
// designer's stem-width ruler. Drag a line; every crossing with the node's
// EFFECTIVE outlines gets a tick, with distances labeled between
// consecutive crossings and the total at the end. Purely an editor readout
// — nothing writes to the graph. The line persists past pointerup (study
// the numbers, scrub the timeline under it); Escape or a new drag clears.

import type { SplineSubpath } from "@/engine/types";
import { bezierAt } from "../geometry";
import type { MeasureLine, PointerLike, SplineEditorEnv } from "../types";

export function beginMeasureDrag(env: SplineEditorEnv, e: PointerLike) {
  env.setMeasure({
    x1: e.clientX,
    y1: e.clientY,
    x2: e.clientX,
    y2: e.clientY,
  });
  env.setDrag({
    kind: "measure",
    startClient: { x: e.clientX, y: e.clientY },
  });
}

// All crossings of the measure line with the subpaths' curves, as sorted
// parameters t ∈ [0,1] along the line (deduped within ~1.5px). Curves are
// sampled to px polylines at ~5px steps; each sub-segment is intersected
// with the line segment (Cramer). Pure — callers supply the same normToPx
// the overlay renders with, so crossings land exactly on the drawn curve.
export function measureCrossings(
  line: MeasureLine,
  subpaths: SplineSubpath[],
  normToPx: (p: [number, number]) => { x: number; y: number }
): number[] {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1) return [];
  const ts: number[] = [];
  for (const sub of subpaths) {
    const anchors = sub.anchors;
    const n = anchors.length;
    if (n < 2) continue;
    const segCount = sub.closed ? n : n - 1;
    for (let s = 0; s < segCount; s++) {
      const a = anchors[s];
      const b = anchors[(s + 1) % n];
      const P0 = normToPx(a.pos);
      const P1 = a.outHandle
        ? normToPx([a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]])
        : P0;
      const P3 = normToPx(b.pos);
      const P2 = b.inHandle
        ? normToPx([b.pos[0] + b.inHandle[0], b.pos[1] + b.inHandle[1]])
        : P3;
      const hullLen =
        Math.hypot(P1.x - P0.x, P1.y - P0.y) +
        Math.hypot(P2.x - P1.x, P2.y - P1.y) +
        Math.hypot(P3.x - P2.x, P3.y - P2.y);
      const K = Math.max(4, Math.min(64, Math.ceil(hullLen / 5)));
      let px = P0.x;
      let py = P0.y;
      for (let k = 1; k <= K; k++) {
        const q = bezierAt(
          [P0.x, P0.y],
          [P1.x, P1.y],
          [P2.x, P2.y],
          [P3.x, P3.y],
          k / K
        );
        const ex = q[0] - px;
        const ey = q[1] - py;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) > 1e-9) {
          const rx = px - line.x1;
          const ry = py - line.y1;
          const tl = (rx * ey - ry * ex) / den;
          const u = (rx * dy - ry * dx) / den;
          if (tl >= 0 && tl <= 1 && u >= 0 && u <= 1) ts.push(tl);
        }
        px = q[0];
        py = q[1];
      }
    }
  }
  ts.sort((a, b) => a - b);
  const L = Math.sqrt(L2);
  const out: number[] = [];
  for (const t of ts) {
    if (out.length === 0 || (t - out[out.length - 1]) * L > 1.5) out.push(t);
  }
  return out;
}
