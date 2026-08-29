// Guards Transform pivot-space math: Source (local) scale stays about the
// incoming shape's center when that shape moves; Canvas (global) does not.
// Also the Canvas ↔ Source remap that keeps the visual pivot still.
//
//   npx tsx scripts/check-transform-pivot.mts

import type {
  NodeOutput,
  RenderContext,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import {
  localPivot,
  remapPivotForSpaceChange,
  splineAABB,
} from "../src/engine/transform-pivot.ts";
import { transformNode } from "../src/nodes/effect/transform.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function squareAt(cx: number, cy: number, r: number): SplineValue {
  return {
    kind: "spline",
    subpaths: [
      {
        closed: true,
        anchors: [
          { pos: [cx, cy - r] },
          { pos: [cx + r, cy] },
          { pos: [cx, cy + r] },
          { pos: [cx - r, cy] },
        ],
      },
    ],
  };
}

function centerOf(s: SplineValue): { x: number; y: number } {
  const b = splineAABB(s);
  if (!b) return { x: NaN, y: NaN };
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

const dummyCtx = {} as RenderContext;

function runTransform(
  src: SplineValue,
  params: Record<string, unknown>
): SplineValue {
  const sockets = transformNode.resolveInputs!(params, {
    connectedTypes: { image: "spline" },
  });
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const out = transformNode.compute({
    inputs: { image: coerced },
    auxIn: {},
    params,
    ctx: dummyCtx,
    nodeId: "xf",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    throw new Error("expected spline output");
  }
  return out.primary;
}

const DEFAULTS = {
  translateX: 0,
  translateY: 0,
  scaleX: 2,
  scaleY: 2,
  rotate: 0,
  pivotX: 0.5,
  pivotY: 0.5,
};

{
  const b = { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 };
  const p = localPivot(b, 0.5, 0.5);
  check("local 0.5,0.5 is bbox center", close(p.x, 0.2) && close(p.y, 0.3));
  const q = localPivot(null, 0.5, 0.5);
  check("degenerate bbox falls back to stored pivot", close(q.x, 0.5) && close(q.y, 0.5));
}

{
  const space = transformNode.params.find((p) => p.name === "space");
  check(
    "new Transform defaults to source (local) pivot space",
    space?.default === "local"
  );
}

{
  const src = squareAt(0.2, 0.3, 0.1);
  const out = runTransform(src, { ...DEFAULTS, space: "local" });
  const c = centerOf(out);
  check(
    "source-space scale 2x keeps the shape centered",
    close(c.x, 0.2) && close(c.y, 0.3),
    `center ${c.x.toFixed(3)},${c.y.toFixed(3)}`
  );
}

{
  const src = squareAt(0.2, 0.3, 0.1);
  const out = runTransform(src, { ...DEFAULTS, space: "global" });
  const c = centerOf(out);
  check(
    "canvas-space scale 2x about (0.5,0.5) moves the shape",
    !close(c.x, 0.2) || !close(c.y, 0.3),
    `center ${c.x.toFixed(3)},${c.y.toFixed(3)}`
  );
}

{
  const moved = squareAt(0.7, 0.2, 0.1);
  const out = runTransform(moved, { ...DEFAULTS, space: "local" });
  const c = centerOf(out);
  check(
    "after moving the source, local scale still centers on it",
    close(c.x, 0.7) && close(c.y, 0.2),
    `center ${c.x.toFixed(3)},${c.y.toFixed(3)}`
  );
}

{
  const b = { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 };
  const toLocal = remapPivotForSpaceChange("global", "local", 0.2, 0.3, b);
  check(
    "canvas → source remap of bbox center is 0.5,0.5",
    !!toLocal && close(toLocal.pivotX, 0.5) && close(toLocal.pivotY, 0.5)
  );
  const toCanvas = remapPivotForSpaceChange("local", "global", 0.5, 0.5, b);
  check(
    "source → canvas remap of 0.5,0.5 is bbox center",
    !!toCanvas && close(toCanvas.pivotX, 0.2) && close(toCanvas.pivotY, 0.3)
  );
  check(
    "same-space remap is a no-op",
    remapPivotForSpaceChange("local", "local", 0.5, 0.5, b) === null
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall transform-pivot checks passed");
