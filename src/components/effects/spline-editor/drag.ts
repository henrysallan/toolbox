// The live pointer stream for ALL drag kinds — the bodies of the old
// monolith's single drag useEffect, dispatched per DragState kind. The
// component binds window pointermove/pointerup while a drag is active and
// forwards events here. Delta tracking is in client-px so movement thresholds
// compare cleanly regardless of zoom. Split out in M0 of
// specdocs/071926_spline-draw-authoring-upgrade.md.

import type { SplineAnchor } from "@/engine/types";
import { DRAG_THRESHOLD, PENCIL_MIN_SAMPLE } from "./constants";
import { bezierAt } from "./geometry";
import type { DragState, SplineEditorEnv } from "./types";
import type { SplineOps } from "./ops";
import { angleLockPx, snapPoint } from "./snapping";
import { cornerRadiusDragMove } from "./tools/corner";
import { penAnchorClick } from "./tools/pen";
import { commitPencilStroke } from "./tools/pencil";
import { shapeDragMove, shapeDragUp } from "./tools/shape";
import { resolveMarquee } from "./tools/subpath";

export function dragMove(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: DragState,
  e: PointerEvent
) {
  const [nx, ny] = env.clientToNorm(e.clientX, e.clientY);
  const anchors = ops.readAnchors(env.valueRef.current);
  switch (drag.kind) {
    case "new": {
      const dx = e.clientX - drag.startClient.x;
      const dy = e.clientY - drag.startClient.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        // Clear any pen-click placement guides once the handle pull starts.
        env.setSnapGuides([]);
      }
      // Pointer direction → symmetric handles. outHandle is pointer-ward,
      // inHandle mirrors it. Shift locks the pull to 45° increments.
      const a = anchors[drag.index];
      if (!a) return;
      let px = e.clientX;
      let py = e.clientY;
      if (e.shiftKey) {
        const o = env.normToPx(a.pos);
        const locked = angleLockPx(o.x, o.y, px, py);
        px = locked.x;
        py = locked.y;
      }
      const [hnx, hny] = env.clientToNorm(px, py);
      const hx = hnx - a.pos[0];
      const hy = hny - a.pos[1];
      ops.updateAnchor(drag.index, {
        inHandle: [-hx, -hy],
        outHandle: [hx, hy],
      });
      break;
    }
    case "anchor": {
      const dx = e.clientX - drag.startClient.x;
      const dy = e.clientY - drag.startClient.y;
      if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        drag.moved = true;
      }
      if (drag.moved) {
        // Intended target from gesture start (grabOffset keeps the grab
        // point under the cursor), then snap it against other anchors +
        // canvas guides unless Cmd/Ctrl suppresses (snapping.ts).
        let tx = nx + drag.grabOffset.x;
        let ty = ny + drag.grabOffset.y;
        const suppress = e.metaKey || e.ctrlKey;
        if (!suppress && env.rect) {
          const exclude =
            drag.groupStarts && drag.groupStarts.size > 1
              ? new Set(drag.groupStarts.keys())
              : new Set([drag.index]);
          const p = env.normToPx([tx, ty]);
          const res = snapPoint(
            env.rect,
            ops.anchorSnapTargets(exclude),
            p.x,
            p.y
          );
          env.setSnapGuides(res.guides);
          if (res.guides.length > 0) {
            const sn = env.clientToNorm(res.x, res.y);
            tx = sn[0];
            ty = sn[1];
          }
        } else {
          env.setSnapGuides([]);
        }
        // Group drags use the snapshot to keep relative offsets exact;
        // single drags fall back to the original grab-offset path.
        if (drag.groupStarts && drag.groupStarts.size > 1) {
          const start = drag.groupStarts.get(drag.index);
          if (!start) break;
          ops.moveAnchors(drag.groupStarts, tx - start[0], ty - start[1]);
        } else {
          ops.updateAnchor(drag.index, {
            pos: [tx, ty],
          });
        }
      }
      break;
    }
    case "handle": {
      const a = anchors[drag.index];
      if (!a) break;
      // Shift locks the handle to 45° increments about its anchor
      // (snapping.ts) — Shift is free during handle drags.
      let px = e.clientX;
      let py = e.clientY;
      if (e.shiftKey) {
        const o = env.normToPx(a.pos);
        const locked = angleLockPx(o.x, o.y, px, py);
        px = locked.x;
        py = locked.y;
      }
      const [hnx, hny] = env.clientToNorm(px, py);
      const hx = hnx - a.pos[0];
      const hy = hny - a.pos[1];
      const patch: Partial<SplineAnchor> = {};
      if (drag.side === "out") {
        patch.outHandle = [hx, hy];
        if (drag.symmetric) patch.inHandle = [-hx, -hy];
      } else {
        patch.inHandle = [hx, hy];
        if (drag.symmetric) patch.outHandle = [-hx, -hy];
      }
      ops.updateAnchor(drag.index, patch);
      break;
    }
    case "segment": {
      // Bend the cubic so it passes under the cursor while the anchors
      // (P0, P3) stay pinned. The grabbed point depends on the two
      // interior controls through the Bernstein weights b1, b2; the
      // constraint b1·ΔP1 + b2·ΔP2 = D is underdetermined, so we take
      // the minimum-norm least-squares solution — each handle shifts in
      // proportion to its influence at t. t is cached from drag-start so
      // the curve doesn't slide under the cursor.
      const A = anchors[drag.i];
      const B = anchors[drag.j];
      if (!A || !B) break;
      const P0 = A.pos;
      const P3 = B.pos;
      const outH = A.outHandle ?? ([0, 0] as [number, number]);
      const inH = B.inHandle ?? ([0, 0] as [number, number]);
      const P1: [number, number] = [P0[0] + outH[0], P0[1] + outH[1]];
      const P2: [number, number] = [P3[0] + inH[0], P3[1] + inH[1]];
      const bt = bezierAt(P0, P1, P2, P3, drag.t);
      const Dx = nx - bt[0];
      const Dy = ny - bt[1];
      const u = 1 - drag.t;
      const b1 = 3 * u * u * drag.t;
      const b2 = 3 * u * drag.t * drag.t;
      const denom = b1 * b1 + b2 * b2;
      if (denom < 1e-6) break; // grabbed right at an anchor; nothing to do
      const k1 = b1 / denom;
      const k2 = b2 / denom;
      ops.patchAnchors(
        new Map<number, Partial<SplineAnchor>>([
          [
            drag.i,
            {
              outHandle: [outH[0] + Dx * k1, outH[1] + Dy * k1],
              broken: true,
            },
          ],
          [
            drag.j,
            {
              inHandle: [inH[0] + Dx * k2, inH[1] + Dy * k2],
              broken: true,
            },
          ],
        ])
      );
      break;
    }
    case "marquee": {
      env.setDrag({ ...drag, currentClient: { x: e.clientX, y: e.clientY } });
      break;
    }
    case "path-move": {
      // Translate the whole path from the start snapshot by the
      // normalized pointer delta.
      ops.translateWholePath(
        drag.startValue,
        nx - drag.startNorm[0],
        ny - drag.startNorm[1]
      );
      break;
    }
    case "bbox": {
      // Scale the whole path about the anchored edge/corner. Computed
      // from the start box + snapshot so the drag doesn't compound.
      ops.applyBBoxDrag(drag, nx, ny, e.shiftKey);
      break;
    }
    case "corner-radius": {
      cornerRadiusDragMove(ops, env, drag, e);
      break;
    }
    case "shape": {
      shapeDragMove(env, drag, e);
      break;
    }
    case "pencil": {
      // Accumulate a freehand sample, skipping ones too close to the last
      // (jitter / duplicate filter — also keeps the fit's chord-length
      // parameterization away from zero-length segments).
      const pts = env.pencilPtsRef.current;
      const last = pts[pts.length - 1];
      if (
        !last ||
        Math.hypot(e.clientX - last[0], e.clientY - last[1]) >=
          PENCIL_MIN_SAMPLE
      ) {
        pts.push([e.clientX, e.clientY]);
        env.setPencilVersion((v) => v + 1);
      }
      break;
    }
  }
}

export function dragUp(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: DragState,
  e: PointerEvent
) {
  if (drag.kind === "anchor" && !drag.moved) {
    const dx = e.clientX - drag.startClient.x;
    const dy = e.clientY - drag.startClient.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
      if (env.tool === "pen") {
        // Pen-mode quick click on an existing anchor: close the spline /
        // toggle corner ↔ smooth (tools/pen.ts).
        penAnchorClick(ops, env, drag.index);
      }
      // Select-mode click was already handled at pointerdown
      // (the anchor was added to the selection there). No further
      // action on the up — just drop the drag state.
    }
  }
  if (drag.kind === "marquee") {
    resolveMarquee(ops, env, drag);
  }
  if (drag.kind === "shape") {
    shapeDragUp(ops, env, drag);
  }
  if (drag.kind === "pencil") {
    // Pin the exact release point (it may not have cleared the sample
    // gate), then fit + commit the stroke and reset the buffer.
    const pts = env.pencilPtsRef.current;
    const last = pts[pts.length - 1];
    if (!last || last[0] !== e.clientX || last[1] !== e.clientY) {
      pts.push([e.clientX, e.clientY]);
    }
    commitPencilStroke(env);
    env.pencilPtsRef.current = [];
    env.setPencilVersion((v) => v + 1);
  }
  env.setSnapGuides([]);
  env.setDrag(null);
}
