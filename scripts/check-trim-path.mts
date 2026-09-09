// Guards Trim Path combined vs per-subpath domains, attribute/driver
// sources, metadata carry, and save-compat (missing mode = combined).
//
//   npx tsx scripts/check-trim-path.mts

import type {
  NodeOutput,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import {
  makeTrimSourceFn,
  readSubpathAttrScalar,
  trimSubpaths,
  trimSubpathsEach,
} from "../src/engine/spline-trim.ts";
import { trimPathNode } from "../src/nodes/effect/trim-path.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

function line(y: number, extra?: Partial<SplineSubpath>): SplineSubpath {
  // Handles make this a linear cubic (B(t) = t), so an arc-length
  // trim at fraction f lands at x = f — a collapsed-handle line does not.
  return {
    anchors: [
      { pos: [0, y], outHandle: [1 / 3, 0] },
      { pos: [1, y], inHandle: [-1 / 3, 0] },
    ],
    closed: false,
    ...extra,
  };
}

function endX(sub: SplineSubpath | undefined): number | undefined {
  return sub?.anchors[sub.anchors.length - 1]?.pos[0];
}

function startX(sub: SplineSubpath | undefined): number | undefined {
  return sub?.anchors[0]?.pos[0];
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

function evalTrim(
  subpaths: SplineSubpath[],
  params: Record<string, unknown>
): SplineValue {
  const ctx = makeCtx();
  const path: SplineValue = { kind: "spline", subpaths };
  const coerced = coerceValue(path, "spline", ctx);
  const out = trimPathNode.compute({
    inputs: { path: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "trim",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    throw new Error("trim-path did not emit a spline");
  }
  return out.primary;
}

const A = line(0);
const B = line(0.5);
const PAIR = [A, B];

{
  const out = trimSubpaths(PAIR, 0, 0.5, 0);
  check(
    "combined: end 0.5 keeps only the first of two equal-length subpaths",
    out.length === 1 &&
      close(startX(out[0]) ?? -1, 0) &&
      close(endX(out[0]) ?? -1, 1)
  );
}

{
  const startAt = makeTrimSourceFn(PAIR, "value", 0);
  const endAt = makeTrimSourceFn(PAIR, "value", 0.5);
  const offsetAt = makeTrimSourceFn(PAIR, "value", 0);
  const out = trimSubpathsEach(PAIR, startAt, endAt, offsetAt);
  check(
    "per-subpath: end 0.5 keeps both, each half",
    out.length === 2 &&
      close(startX(out[0]) ?? -1, 0) &&
      close(endX(out[0]) ?? -1, 0.5) &&
      close(startX(out[1]) ?? -1, 0) &&
      close(endX(out[1]) ?? -1, 0.5)
  );
}

{
  const full = trimSubpaths(PAIR, 0, 1, 0);
  check(
    "combined identity: full window returns the same array",
    full === PAIR
  );
}

{
  const empty = trimSubpaths(PAIR, 0.5, 0.5, 0);
  check("combined empty window is []", empty.length === 0);
}

{
  const tagged: SplineSubpath[] = [
    line(0, { groupIndex: 7, driver: 0.25, attrs: { end: 0.5 } }),
  ];
  const out = trimSubpaths(tagged, 0, 0.5, 0);
  check(
    "partial trim carries groupIndex / driver / attrs",
    out.length === 1 &&
      out[0].groupIndex === 7 &&
      out[0].driver === 0.25 &&
      out[0].attrs?.end === 0.5
  );
}

{
  check(
    "readSubpathAttrScalar: float",
    readSubpathAttrScalar(line(0, { attrs: { w: 0.3 } }), "w") === 0.3
  );
  check(
    "readSubpathAttrScalar: vec component 0",
    readSubpathAttrScalar(line(0, { attrs: { w: [0.8, 0.1] } }), "w") === 0.8
  );
  check(
    "readSubpathAttrScalar: missing is undefined",
    readSubpathAttrScalar(line(0), "w") === undefined
  );
}

{
  const subs: SplineSubpath[] = [
    line(0, { attrs: { end: 1 } }),
    line(0.5, { attrs: { end: 0 } }),
  ];
  const startAt = makeTrimSourceFn(subs, "value", 0);
  const endAt = makeTrimSourceFn(subs, "attribute", 1, { attrName: "end" });
  const offsetAt = makeTrimSourceFn(subs, "value", 0);
  const out = trimSubpathsEach(subs, startAt, endAt, offsetAt);
  check(
    "attribute end: first kept, second dropped",
    out.length === 1 && close(endX(out[0]) ?? -1, 1)
  );
}

{
  const subs: SplineSubpath[] = [line(0), line(0.5, { attrs: { end: 0.25 } })];
  const endAt = makeTrimSourceFn(subs, "attribute", 1, { attrName: "end" });
  const out = trimSubpathsEach(
    subs,
    makeTrimSourceFn(subs, "value", 0),
    endAt,
    makeTrimSourceFn(subs, "value", 0)
  );
  check(
    "attribute end: missing falls back to slider (full)",
    out.length === 2 &&
      close(endX(out[0]) ?? -1, 1) &&
      close(endX(out[1]) ?? -1, 0.25)
  );
}

{
  const startAt = makeTrimSourceFn(PAIR, "index", 0);
  const out = trimSubpathsEach(
    PAIR,
    startAt,
    makeTrimSourceFn(PAIR, "value", 1),
    makeTrimSourceFn(PAIR, "value", 0)
  );
  check(
    "index start: first full (t=0), second empty (t=1)",
    out.length === 1 && close(endX(out[0]) ?? -1, 1)
  );
}

{
  const out = evalTrim(PAIR, { trim_start: 0, trim_end: 0.5, trim_offset: 0 });
  check(
    "node: missing mode is combined (save-compat)",
    out.subpaths.length === 1 && close(endX(out.subpaths[0]) ?? -1, 1)
  );
}

{
  const out = evalTrim(PAIR, {
    mode: "combined",
    trim_start: 0,
    trim_end: 0.5,
    trim_offset: 0,
    end_source: "attribute",
    end_attr: "end",
  });
  check(
    "node: combined ignores attribute sources",
    out.subpaths.length === 1 && close(endX(out.subpaths[0]) ?? -1, 1)
  );
}

{
  const out = evalTrim(PAIR, {
    mode: "per subpath",
    trim_start: 0,
    trim_end: 0.5,
    trim_offset: 0,
  });
  check(
    "node: per subpath, uniform end 0.5 halves both",
    out.subpaths.length === 2 &&
      close(endX(out.subpaths[0]) ?? -1, 0.5) &&
      close(endX(out.subpaths[1]) ?? -1, 0.5)
  );
}

{
  const subs: SplineSubpath[] = [
    line(0, { attrs: { end: 0.25 }, groupIndex: 3 }),
    line(0.5, { attrs: { end: 0.75 }, groupIndex: 4 }),
  ];
  const out = evalTrim(subs, {
    mode: "per subpath",
    trim_start: 0,
    trim_end: 1,
    trim_offset: 0,
    end_source: "attribute",
    end_attr: "end",
  });
  check(
    "node: per-subpath attribute end + groupIndex carried",
    out.subpaths.length === 2 &&
      close(endX(out.subpaths[0]) ?? -1, 0.25) &&
      close(endX(out.subpaths[1]) ?? -1, 0.75) &&
      out.subpaths[0].groupIndex === 3 &&
      out.subpaths[1].groupIndex === 4
  );
}

{
  const out = evalTrim(PAIR, {
    mode: "per subpath",
    trim_start: 0,
    trim_end: 1,
    trim_offset: 0,
    start_source: "index",
  });
  check(
    "node: index start drops the last subpath",
    out.subpaths.length === 1
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
