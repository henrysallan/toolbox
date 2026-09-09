// Guards Proximity Join/Merge's join mode: endpoint stitching, reversal,
// self-close, and the Kruskal/spatial-hash path that replaced the O(N³)
// rescan. Offline — spline in, spline out, through coerceValue.
//
//   npx tsx scripts/check-proximity-merge.mts

import type {
  NodeOutput,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { proximityMergeNode } from "../src/nodes/effect/proximity-merge.ts";

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

function posClose(a: [number, number], b: [number, number], eps = 1e-6): boolean {
  return close(a[0], b[0], eps) && close(a[1], b[1], eps);
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function seg(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extra?: Partial<SplineSubpath>
): SplineSubpath {
  return {
    closed: false,
    anchors: [{ pos: [x0, y0] }, { pos: [x1, y1] }],
    ...extra,
  };
}

function splineOf(...subpaths: SplineSubpath[]): SplineValue {
  return { kind: "spline", subpaths };
}

function join(
  src: SplineValue,
  params: Record<string, unknown> = {}
): SplineValue {
  const ctx = makeCtx();
  const coerced = coerceValue(src, "spline", ctx);
  const out = proximityMergeNode.compute({
    inputs: { in: coerced },
    auxIn: {},
    params: {
      mode: "spline",
      op: "join",
      distance: 0.05,
      animate: false,
      ...params,
    },
    ctx,
    nodeId: "pm",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    return { kind: "spline", subpaths: [] };
  }
  return out.primary;
}

function openCount(s: SplineValue): number {
  return s.subpaths.filter((p) => !p.closed).length;
}

function closedCount(s: SplineValue): number {
  return s.subpaths.filter((p) => p.closed).length;
}

{
  const out = join(
    splineOf(seg(0, 0, 0.1, 0), seg(0.12, 0, 0.22, 0), seg(0.24, 0, 0.34, 0))
  );
  check("three collinear segments stitch into one open path", out.subpaths.length === 1 && !out.subpaths[0].closed);
  const a = out.subpaths[0]?.anchors ?? [];
  check("stitched path has start + two joints + end", a.length === 4);
  check(
    "weld joints sit at midpoints",
    a.length === 4 &&
      posClose(a[0].pos, [0, 0]) &&
      posClose(a[1].pos, [0.11, 0]) &&
      posClose(a[2].pos, [0.23, 0]) &&
      posClose(a[3].pos, [0.34, 0])
  );
}

{
  // Heads face each other — one subpath must reverse.
  const out = join(splineOf(seg(0.1, 0, 0, 0), seg(0.12, 0, 0.3, 0)));
  const a = out.subpaths[0]?.anchors ?? [];
  check("head-to-head join reverses one chain", out.subpaths.length === 1 && a.length === 3);
  check(
    "reversed join starts at the far tail",
    a.length === 3 && posClose(a[0].pos, [0, 0]) && posClose(a[1].pos, [0.11, 0]) && posClose(a[2].pos, [0.3, 0])
  );
}

{
  const a: SplineSubpath = {
    closed: false,
    anchors: [
      { pos: [0.1, 0], outHandle: [0.02, 0.01] },
      { pos: [0, 0], inHandle: [-0.01, 0] },
    ],
  };
  const b: SplineSubpath = {
    closed: false,
    anchors: [
      { pos: [0.12, 0], outHandle: [0.03, 0] },
      { pos: [0.3, 0] },
    ],
  };
  const out = join(splineOf(a, b));
  const joint = out.subpaths[0]?.anchors[1];
  check(
    "weld keeps incoming in-handle and outgoing out-handle",
    !!joint &&
      !!joint.inHandle &&
      !!joint.outHandle &&
      posClose(joint.inHandle, [0.02, 0.01]) &&
      posClose(joint.outHandle, [0.03, 0]) &&
      joint.broken === true
  );
}

{
  // Three sides of a triangle with small gaps — should close.
  const out = join(
    splineOf(
      seg(0, 0, 0.5, 0),
      seg(0.51, 0, 0.26, 0.43),
      seg(0.25, 0.43, 0.01, 0)
    )
  );
  check("loop whose free ends meet becomes one closed path", out.subpaths.length === 1 && out.subpaths[0].closed);
}

{
  const out = join(splineOf(seg(0, 0, 0.1, 0), seg(0.8, 0.8, 0.9, 0.9)));
  check("far-apart subpaths stay separate", openCount(out) === 2 && closedCount(out) === 0);
}

{
  const closed: SplineSubpath = {
    closed: true,
    anchors: [{ pos: [0.4, 0.4] }, { pos: [0.6, 0.4] }, { pos: [0.5, 0.6] }],
  };
  const out = join(splineOf(seg(0, 0, 0.1, 0), closed));
  check(
    "already-closed subpaths pass through",
    openCount(out) === 1 && closedCount(out) === 1
  );
}

{
  const src = splineOf(seg(0, 0, 0.1, 0), seg(0.12, 0, 0.22, 0));
  const preview = join(src, { animate: true, t: 0.5 });
  check("animate t<1 keeps original subpath count", preview.subpaths.length === 2);
  check(
    "animate t<1 slides the matched ends toward the weld",
    posClose(preview.subpaths[0].anchors[1].pos, [0.105, 0]) &&
      posClose(preview.subpaths[1].anchors[0].pos, [0.115, 0])
  );
}

{
  const n = 40;
  const parts: SplineSubpath[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * 0.02;
    parts.push(seg(x, 0.5, x + 0.015, 0.5));
  }
  const out = join(splineOf(...parts), { distance: 0.01 });
  check(
    "long neighbor chain collapses to one path",
    out.subpaths.length === 1 && !out.subpaths[0].closed && out.subpaths[0].anchors.length === n + 1
  );
}

{
  const n = 4000;
  const parts: SplineSubpath[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / n;
    parts[i] = seg(x, 0.5, x + 0.5 / n, 0.5);
  }
  const t0 = performance.now();
  const out = join(splineOf(...parts), { distance: 0.002 });
  const ms = performance.now() - t0;
  check(
    `join of ${n} neighbor segments stays under 500ms (was O(N³); took ${ms.toFixed(1)}ms)`,
    ms < 500,
    `${ms.toFixed(1)}ms`
  );
  check(
    `join of ${n} neighbor segments produces one path`,
    out.subpaths.length === 1 && out.subpaths[0].anchors.length === n + 1
  );
}

{
  const n = 3000;
  const parts: SplineSubpath[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i % 50) / 50;
    const y = Math.floor(i / 50) / 60;
    parts[i] = seg(x, y, x + 0.001, y + 0.001);
  }
  const t0 = performance.now();
  const out = join(splineOf(...parts), { distance: 0.0004 });
  const ms = performance.now() - t0;
  check(
    `join of ${n} scattered segments stays under 500ms (took ${ms.toFixed(1)}ms)`,
    ms < 500,
    `${ms.toFixed(1)}ms`
  );
  check(
    "scattered segments below threshold stay unjoined",
    out.subpaths.length === n
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall checks passed");
