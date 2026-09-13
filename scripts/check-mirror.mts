// Guards Mirror: existing axis copies, plus mode=bisect which clips to a
// keep half-plane (X / −X / Y / −Y) then mirrors the remainder.
//
//   npx tsx scripts/check-mirror.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { editorCanCoerce } from "../src/engine/graph-validation.ts";
import { makePoints } from "../src/engine/points.ts";
import {
  clipSplineByHalfPlane,
  onKeepSide,
} from "../src/engine/spline-halfplane.ts";
import { mirrorNode } from "../src/nodes/effect/mirror.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
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

function evalMirror(
  source: SplineValue | PointsValue,
  params: Record<string, unknown>
): SplineValue | PointsValue | undefined {
  const ctx = makeCtx();
  const socket = source.kind === "points" ? "points" : "spline";
  const coerced = coerceValue(source, socket, ctx);
  const out = mirrorNode.compute({
    inputs: { source: coerced },
    auxIn: {},
    params: {
      mode: "x",
      keep: "x",
      centerX: 0.5,
      centerY: 0.5,
      count: 6,
      kaleidoscope: false,
      includeSource: true,
      tagGroups: false,
      ...params,
    },
    ctx,
    nodeId: "mirror",
  }) as NodeOutput;
  return out.primary as SplineValue | PointsValue | undefined;
}

function lineX(y: number, extra?: Partial<SplineSubpath>): SplineSubpath {
  return {
    anchors: [
      { pos: [0, y], outHandle: [1 / 3, 0] },
      { pos: [1, y], inHandle: [-1 / 3, 0] },
    ],
    closed: false,
    ...extra,
  };
}

function square(): SplineSubpath {
  // Axis-aligned unit-ish square straddling 0.5. Null handles = linear.
  return {
    anchors: [
      { pos: [0.2, 0.2] },
      { pos: [0.8, 0.2] },
      { pos: [0.8, 0.8] },
      { pos: [0.2, 0.8] },
    ],
    closed: true,
  };
}

function pts(xy: Array<[number, number]>): PointsValue {
  const p = makePoints(xy.length);
  for (let i = 0; i < xy.length; i++) {
    p.positions[i * 2] = xy[i][0];
    p.positions[i * 2 + 1] = xy[i][1];
  }
  return p;
}

function xs(p: PointsValue): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.count; i++) out.push(p.positions[i * 2]);
  return out;
}

function ys(p: PointsValue): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.count; i++) out.push(p.positions[i * 2 + 1]);
  return out;
}

function closeAll(a: number[], b: number[], eps = 1e-5): boolean {
  return a.length === b.length && a.every((v, i) => close(v, b[i], eps));
}

// ---- existing axis copy still duplicates without cutting ----
{
  const out = evalMirror({ kind: "spline", subpaths: [lineX(0.4)] }, { mode: "x" });
  check(
    "mode=x keeps two full-width subpaths",
    out?.kind === "spline" && out.subpaths.length === 2,
    `got ${out?.kind === "spline" ? out.subpaths.length : out?.kind}`
  );
  if (out?.kind === "spline") {
    const a = out.subpaths[0].anchors;
    const b = out.subpaths[1].anchors;
    check("mode=x source starts at x=0", close(a[0].pos[0], 0));
    check("mode=x source ends at x=1", close(a[1].pos[0], 1));
    check("mode=x flip starts at x=1", close(b[0].pos[0], 1));
    check("mode=x flip ends at x=0", close(b[1].pos[0], 0));
  }
}

// ---- points bisect ----
{
  const src = pts([
    [0.2, 0.5],
    [0.5, 0.5],
    [0.8, 0.5],
  ]);
  const out = evalMirror(src, { mode: "bisect", keep: "-x" });
  check("bisect -x points kind", out?.kind === "points", out?.kind);
  if (out?.kind === "points") {
    // Keep 0.2 and 0.5; mirror 0.2 → 0.8; on-plane 0.5 is not doubled.
    const got = xs(out).slice().sort((a, b) => a - b);
    check(
      "bisect -x keeps left + plane and mirrors interior",
      closeAll(got, [0.2, 0.5, 0.8]),
      `got ${got.join(",")}`
    );
  }
}

{
  const src = pts([
    [0.2, 0.5],
    [0.8, 0.5],
  ]);
  const out = evalMirror(src, {
    mode: "bisect",
    keep: "x",
    includeSource: false,
  });
  check("bisect x includeSource=false kind", out?.kind === "points");
  if (out?.kind === "points") {
    // Keep 0.8, don't emit it, only its mirror at 0.2.
    check("bisect x drop-source count", out.count === 1, `count=${out.count}`);
    check("bisect x drop-source at 0.2", close(out.positions[0], 0.2));
  }
}

{
  const src = pts([
    [0.5, 0.2],
    [0.5, 0.5],
    [0.5, 0.8],
  ]);
  const out = evalMirror(src, { mode: "bisect", keep: "-y" });
  check("bisect -y points kind", out?.kind === "points");
  if (out?.kind === "points") {
    const got = ys(out).slice().sort((a, b) => a - b);
    check(
      "bisect -y keeps up + plane and mirrors interior",
      closeAll(got, [0.2, 0.5, 0.8]),
      `got ${got.join(",")}`
    );
  }
}

// ---- spline clip helper: open line ----
{
  const clipped = clipSplineByHalfPlane(
    { kind: "spline", subpaths: [lineX(0.4)] },
    "-x",
    0.5,
    0.5
  );
  check("clip line -x one piece", clipped.subpaths.length === 1, `${clipped.subpaths.length}`);
  if (clipped.subpaths[0]) {
    const a = clipped.subpaths[0].anchors;
    check("clip line starts at 0", close(a[0].pos[0], 0));
    check("clip line ends on plane", close(a[a.length - 1].pos[0], 0.5));
    check(
      "clip line all on keep side",
      a.every((p) => onKeepSide(p.pos[0], p.pos[1], "-x", 0.5, 0.5))
    );
  }
}

// ---- spline bisect + mirror: line ----
{
  const out = evalMirror(
    { kind: "spline", subpaths: [lineX(0.4)] },
    { mode: "bisect", keep: "-x" }
  );
  check(
    "bisect line emits kept + mirror",
    out?.kind === "spline" && out.subpaths.length === 2,
    `got ${out?.kind === "spline" ? out.subpaths.length : out?.kind}`
  );
  if (out?.kind === "spline") {
    const left = out.subpaths[0].anchors;
    const right = out.subpaths[1].anchors;
    check("bisect line kept ends on plane", close(left[left.length - 1].pos[0], 0.5));
    check("bisect line mirror starts at 1", close(right[0].pos[0], 1));
    check("bisect line mirror ends on plane", close(right[right.length - 1].pos[0], 0.5));
  }
}

// ---- closed square: cut then mirror ----
{
  const out = evalMirror(
    { kind: "spline", subpaths: [square()] },
    { mode: "bisect", keep: "-x" }
  );
  check(
    "bisect square emits two subpaths",
    out?.kind === "spline" && out.subpaths.length === 2,
    `got ${out?.kind === "spline" ? out.subpaths.length : out?.kind}`
  );
  if (out?.kind === "spline") {
    check("bisect square kept is open", out.subpaths[0].closed === false);
    const leftXs = out.subpaths[0].anchors.map((a) => a.pos[0]);
    check(
      "bisect square kept is on/left of plane",
      leftXs.every((x) => x <= 0.5 + 1e-5),
      `xs=${leftXs.join(",")}`
    );
    const rightXs = out.subpaths[1].anchors.map((a) => a.pos[0]);
    check(
      "bisect square mirror is on/right of plane",
      rightXs.every((x) => x >= 0.5 - 1e-5),
      `xs=${rightXs.join(",")}`
    );
  }
}

{
  const out = evalMirror(
    { kind: "spline", subpaths: [square()] },
    { mode: "x" }
  );
  check(
    "mode=x square still two closed copies",
    out?.kind === "spline" &&
      out.subpaths.length === 2 &&
      out.subpaths.every((s) => s.closed),
    `got ${out?.kind === "spline" ? out.subpaths.map((s) => s.closed).join(",") : out?.kind}`
  );
}

{
  const ins = mirrorNode.resolveInputs!({}, {
    connectedTypes: { source: "image" },
  });
  check(
    "image wire retypes source socket",
    ins[0]?.type === "image" && ins[0]?.label === "Image",
    JSON.stringify(ins[0])
  );
  check(
    "image wire retypes primary output",
    mirrorNode.resolvePrimaryOutput!({}, { connectedTypes: { source: "image" } }) === "image"
  );
  check(
    "mask wire retypes as image",
    mirrorNode.resolveInputs!({}, { connectedTypes: { source: "mask" } })[0]?.type === "image"
  );
  check(
    "points wire still retypes to points",
    mirrorNode.resolveInputs!({}, { connectedTypes: { source: "points" } })[0]?.type === "points"
  );
  check(
    "spline wire retypes source socket",
    mirrorNode.resolveInputs!({}, { connectedTypes: { source: "spline" } })[0]?.type === "spline"
  );
  check(
    "spline wire retypes primary output",
    mirrorNode.resolvePrimaryOutput!({}, { connectedTypes: { source: "spline" } }) === "spline"
  );
  check(
    "unwired rests as image",
    mirrorNode.resolveInputs!({}, { connectedTypes: {} })[0]?.type === "image"
  );
  check(
    "editorCanCoerce spline onto image-resting source",
    editorCanCoerce("spline", "image", "mirror", "in:source")
  );
  check(
    "editorCanCoerce points onto image-resting source",
    editorCanCoerce("points", "image", "mirror", "in:source")
  );
  check(
    "editorCanCoerce image onto a spline-typed stored socket",
    editorCanCoerce("image", "spline", "mirror", "in:source")
  );
  check(
    "editorCanCoerce mask onto a spline-typed stored socket",
    editorCanCoerce("mask", "spline", "mirror", "in:source")
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
