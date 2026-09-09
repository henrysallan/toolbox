// Guards Spline Pack: greedy collision-cutting is deterministic, non-
// overlapping in px, length-filtered, count-sliced from cache, and
// aspect-correct. Offline — spline in, spline out, through coerceValue.
//
//   npx tsx scripts/check-spline-pack.mts

import type {
  NodeOutput,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { aspectCorrectY } from "../src/engine/aspect.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { splinePackNode } from "../src/nodes/effect/spline-pack.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeCtx(width = 1000, height = 1000): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width,
    height,
  } as unknown as RenderContext;
}

function sineLine(y: number, phase: number, amp = 0.025, samples = 48): SplineSubpath {
  const anchors: SplineSubpath["anchors"] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = 0.08 + 0.84 * t;
    anchors.push({
      pos: [x, y + amp * Math.sin((t + phase) * Math.PI * 4)],
    });
  }
  return { anchors, closed: false };
}

function bundle(n: number, y0 = 0.38, dy = 0.008): SplineValue {
  const subpaths: SplineSubpath[] = [];
  for (let i = 0; i < n; i++) {
    subpaths.push(sineLine(y0 + i * dy, (i * 0.17) % 1));
  }
  return { kind: "spline", subpaths };
}

const DEFAULTS = {
  min_width: 6,
  max_width: 24,
  randomize_width: true,
  gap: 2,
  min_length: 40,
  spacing: 2,
  units: "px",
  seed: 7,
  count: -1,
};

function evalPack(
  src: SplineValue,
  params: Record<string, unknown>,
  ctx: RenderContext,
  nodeId = "pack"
): SplineValue {
  const coerced = coerceValue(src, "spline", ctx);
  const out = splinePackNode.compute({
    inputs: { path: coerced },
    auxIn: {},
    params: { ...DEFAULTS, ...params },
    ctx,
    nodeId,
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    return { kind: "spline", subpaths: [] };
  }
  return out.primary;
}

function distPointSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointToPoly(
  px: number,
  py: number,
  xy: Float32Array,
  n: number,
  closed: boolean
): number {
  if (n <= 1) {
    return n === 1 ? Math.hypot(px - xy[0], py - xy[1]) : Infinity;
  }
  let min = Infinity;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const d = distPointSeg(
      px,
      py,
      xy[i * 2],
      xy[i * 2 + 1],
      xy[j * 2],
      xy[j * 2 + 1]
    );
    if (d < min) min = d;
  }
  return min;
}

function symmetricDist(
  a: Float32Array,
  an: number,
  aClosed: boolean,
  b: Float32Array,
  bn: number,
  bClosed: boolean
): number {
  let min = Infinity;
  for (let i = 0; i < an; i++) {
    const d = pointToPoly(a[i * 2], a[i * 2 + 1], b, bn, bClosed);
    if (d < min) min = d;
  }
  for (let i = 0; i < bn; i++) {
    const d = pointToPoly(b[i * 2], b[i * 2 + 1], a, an, aClosed);
    if (d < min) min = d;
  }
  return min;
}

function polyLen(xy: Float32Array, n: number, closed: boolean): number {
  if (n < 2) return 0;
  let L = 0;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    L += Math.hypot(xy[j * 2] - xy[i * 2], xy[j * 2 + 1] - xy[i * 2 + 1]);
  }
  return L;
}

function toPx(
  sub: SplineSubpath,
  W: number,
  H: number
): { xy: Float32Array; n: number; closed: boolean; r: number } {
  const aspect = W / Math.max(1, H);
  const n = sub.anchors.length;
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = sub.anchors[i].pos;
    xy[i * 2] = p[0] * W;
    xy[i * 2 + 1] = aspectCorrectY(p[1], aspect) * H;
  }
  const width = Number(sub.attrs?.width ?? 0);
  return { xy, n, closed: sub.closed, r: width / 2 };
}

function clearancesHold(
  spline: SplineValue,
  W: number,
  H: number,
  gap: number,
  eps: number
): { ok: boolean; worst: number } {
  const pieces = spline.subpaths.map((s) => toPx(s, W, H));
  let worst = Infinity;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i];
      const b = pieces[j];
      const d = symmetricDist(a.xy, a.n, a.closed, b.xy, b.n, b.closed);
      const need = a.r + b.r + gap;
      const slack = d - need;
      if (slack < worst) worst = slack;
      if (slack < -eps) return { ok: false, worst: slack };
    }
  }
  return { ok: true, worst };
}

{
  const empty = evalPack(
    { kind: "spline", subpaths: [] },
    {},
    makeCtx()
  );
  check("empty input emits empty spline", empty.subpaths.length === 0);
}

{
  const src = bundle(12);
  const a = evalPack(src, { seed: 7 }, makeCtx());
  const b = evalPack(src, { seed: 7 }, makeCtx());
  check(
    "determinism: two fresh computes stringify-identical",
    JSON.stringify(a) === JSON.stringify(b) && a.subpaths.length > 0,
    `n=${a.subpaths.length}`
  );
}

{
  const src = bundle(12);
  const ctx = makeCtx();
  const all = evalPack(src, { seed: 3, count: -1 }, ctx);
  const k = evalPack(src, { seed: 3, count: 4 }, ctx);
  const allAgain = evalPack(src, { seed: 3, count: -1 }, ctx);
  check(
    "count scrub: pack once, full output identical after a slice",
    JSON.stringify(all) === JSON.stringify(allAgain) && all.subpaths.length > 4,
    `n=${all.subpaths.length} n2=${allAgain.subpaths.length}`
  );
  check(
    "count = k is exactly the first k of count = -1",
    JSON.stringify(k.subpaths) === JSON.stringify(all.subpaths.slice(0, 4))
  );
  check(
    "count = 0 emits nothing",
    evalPack(src, { seed: 3, count: 0 }, ctx).subpaths.length === 0
  );
}

{
  const src = bundle(10);
  const maxW = 24;
  const minLen = 40;
  const gap = 2;
  const out = evalPack(
    src,
    { seed: 11, max_width: maxW, min_width: 6, gap, min_length: minLen },
    makeCtx(1000, 1000)
  );
  check("pack emits pieces", out.subpaths.length >= 2, `n=${out.subpaths.length}`);

  let attrsOk = out.subpaths.length > 0;
  for (let i = 0; i < out.subpaths.length; i++) {
    const s = out.subpaths[i];
    const width = Number(s.attrs?.width);
    const packIndex = Number(s.attrs?.packIndex);
    const sourceIndex = Number(s.attrs?.sourceIndex);
    if (packIndex !== i) attrsOk = false;
    if (s.groupIndex !== sourceIndex) attrsOk = false;
    if (!(s.driver !== undefined && Math.abs(s.driver - width / maxW) < 1e-6)) {
      attrsOk = false;
    }
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= 10) {
      attrsOk = false;
    }
  }
  check(
    "attributes: driver = width/max_width, groupIndex = sourceIndex, packIndex contiguous",
    attrsOk
  );

  const W = 1000;
  const H = 1000;
  let lengthsOk = true;
  for (const s of out.subpaths) {
    const px = toPx(s, W, H);
    if (polyLen(px.xy, px.n, px.closed) < minLen - 1e-3) lengthsOk = false;
  }
  check("every piece px arc length ≥ min_length", lengthsOk);

  const clr = clearancesHold(out, W, H, gap, 1.5);
  check(
    "non-overlap: symmetric px distance ≥ ra+rb+gap",
    clr.ok,
    `worst slack=${clr.worst.toFixed(3)}`
  );
}

{
  const src = bundle(8, 0.4, 0.01);
  const gap = 2;
  const square = evalPack(src, { seed: 5, gap }, makeCtx(1000, 1000));
  const wide = evalPack(src, { seed: 5, gap }, makeCtx(2000, 1000));
  const a = clearancesHold(square, 1000, 1000, gap, 1.5);
  const b = clearancesHold(wide, 2000, 1000, gap, 1.5);
  check(
    "aspect: clearances hold on 1000×1000",
    a.ok && square.subpaths.length > 0,
    `n=${square.subpaths.length} slack=${a.worst.toFixed(3)}`
  );
  check(
    "aspect: clearances hold on 2000×1000",
    b.ok && wide.subpaths.length > 0,
    `n=${wide.subpaths.length} slack=${b.worst.toFixed(3)}`
  );
}

{
  const closed: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        anchors: [
          { pos: [0.3, 0.3] },
          { pos: [0.7, 0.3] },
          { pos: [0.7, 0.7] },
          { pos: [0.3, 0.7] },
        ],
        closed: true,
      },
    ],
  };
  const out = evalPack(
    closed,
    { min_width: 4, max_width: 8, gap: 0, min_length: 20, seed: 1 },
    makeCtx()
  );
  check(
    "uncut closed subpath stays closed",
    out.subpaths.length === 1 && out.subpaths[0].closed === true
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
