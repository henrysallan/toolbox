// check-attribute-transfer: Attribute Transfer copies a column from one set
// onto another by proximity. Named channels land as a channel (regression);
// the built-in columns — rotation, scale / scale.x / scale.y, position /
// x / y, group — land in the target's own typed fields, never as a named
// channel (2026-09-17). group is nearest-only and rounds; index and spline
// sides pass through; the name picker offers exactly the writable set.
//
//   npx tsx scripts/check-attribute-transfer.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import {
  copyPointsWith,
  getGroupIndex,
  getRotation,
  getScaleX,
  getScaleY,
  makePoints,
} from "../src/engine/points.ts";
import { attributeTransferNode } from "../src/nodes/effect/attribute-transfer.ts";
import {
  attrNameSuggestions,
  isAttrNameInvalid,
  type AttrNameInfo,
} from "../src/components/effects/attr-name-source.ts";

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

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

// Two sources on the x axis with every built-in populated, plus a named
// channel for the regression case.
function sourcePoints(): PointsValue {
  const pts = makePoints(2, {
    withScales: true,
    withRotations: true,
    withGroupIndices: true,
  });
  pts.positions.set([0, 0, 1, 0]);
  pts.rotations!.set([1, 2]);
  pts.scales!.set([2, 3, 4, 5]);
  pts.groupIndices!.set([3, 7]);
  return copyPointsWith(pts, {
    attributes: { weight: { arity: 1, data: new Float32Array([1, 0]) } },
  });
}

// Three bare targets (no scales / rotations / groups): the first two hug
// a source each, the third sits nearer the first.
function targetPoints(): PointsValue {
  const pts = makePoints(3);
  pts.positions.set([0.1, 0.2, 0.9, 0.3, 0.4, 0.6]);
  return pts;
}

// Inputs go through coerceValue with the socket's resolved type, the way
// the evaluator hands them to compute (TESTING.md §1).
function run(
  target: SocketValue,
  source: SocketValue,
  params: Record<string, unknown>
): SocketValue | undefined {
  const ctx = makeCtx();
  const tType = params.target === "spline anchors" ? "spline" : "points";
  const sType =
    params.source_target === "spline anchors" ? "spline" : "points";
  const out = attributeTransferNode.compute({
    inputs: {
      points: coerceValue(target, tType, ctx),
      source: coerceValue(source, sType, ctx),
    },
    auxIn: {},
    params,
    ctx,
    nodeId: "at",
  } as Parameters<typeof attributeTransferNode.compute>[0]) as NodeOutput;
  return out.primary;
}

function runPoints(
  target: PointsValue,
  source: PointsValue,
  params: Record<string, unknown>
): PointsValue | undefined {
  const out = run(target, source, params);
  return out?.kind === "points" ? out : undefined;
}

const fmt = (a: ArrayLike<number> | undefined) =>
  a ? Array.from(a).join(",") : "none";

const src = sourcePoints();
const tgt = targetPoints();

// Named channel — still lands as a channel, built-ins untouched.
{
  const out = runPoints(tgt, src, { attr_name: "weight", mode: "nearest" });
  const w = out?.attributes?.weight?.data;
  check(
    "named channel lands as a channel (regression)",
    !!w && close(w[0], 1) && close(w[1], 0) && close(w[2], 1),
    fmt(w)
  );
  check(
    "named transfer leaves the built-in fields alone",
    !!out && out.rotations === undefined && out.scales === undefined
  );
}

// rotation → the target's rotations array, not a channel.
{
  const out = runPoints(tgt, src, { attr_name: "rotation", mode: "nearest" });
  check(
    "rotation lands in rotations (nearest)",
    !!out &&
      !!out.rotations &&
      close(getRotation(out, 0), 1) &&
      close(getRotation(out, 1), 2) &&
      close(getRotation(out, 2), 1),
    out ? fmt(out.rotations) : "no output"
  );
  check(
    "rotation is not written as a named channel",
    !!out && !out.attributes?.rotation
  );
  check(
    "rotation transfer keeps the target's positions and count",
    !!out &&
      out.count === 3 &&
      close(out.positions[0], 0.1) &&
      close(out.positions[5], 0.6)
  );
}

// weighted rotation: linear falloff average within radius.
{
  const s = sourcePoints();
  s.rotations!.set([0, 1]);
  const t = makePoints(1);
  t.positions.set([0.25, 0]);
  const out = runPoints(t, s, {
    attr_name: "rotation",
    mode: "weighted",
    fallback: "nearest",
    radius: 1,
  });
  // w0 = 1 − 0.25 = 0.75, w1 = 1 − 0.75 = 0.25 → (0·0.75 + 1·0.25) / 1
  check(
    "weighted rotation averages with linear falloff",
    !!out && close(getRotation(out, 0), 0.25),
    out ? fmt(out.rotations) : "no output"
  );
}

// fallback=zero on a built-in writes a literal 0 outside radius.
{
  const out = runPoints(tgt, src, {
    attr_name: "rotation",
    mode: "nearest",
    fallback: "zero",
    // Targets sit 0.22 / 0.32 from their source; the third is 0.72 away.
    radius: 0.35,
  });
  check(
    "rotation fallback=zero writes 0 outside radius",
    !!out &&
      close(getRotation(out, 0), 1) &&
      close(getRotation(out, 1), 2) &&
      close(getRotation(out, 2), 0),
    out ? fmt(out.rotations) : "no output"
  );
}

// scale (both axes), scale.x (one axis, other kept), sy alias (default 1).
{
  const out = runPoints(tgt, src, { attr_name: "scale", mode: "nearest" });
  check(
    "scale lands both axes in scales",
    !!out &&
      close(getScaleX(out, 0), 2) &&
      close(getScaleY(out, 0), 3) &&
      close(getScaleX(out, 1), 4) &&
      close(getScaleY(out, 1), 5) &&
      close(getScaleX(out, 2), 2) &&
      close(getScaleY(out, 2), 3),
    out ? fmt(out.scales) : "no output"
  );
  const t = makePoints(3, { withScales: true });
  t.positions.set(tgt.positions);
  t.scales!.set([1, 9, 1, 9, 1, 9]);
  const outX = runPoints(t, src, { attr_name: "scale.x", mode: "nearest" });
  check(
    "scale.x replaces x and keeps the target's y",
    !!outX &&
      close(getScaleX(outX, 0), 2) &&
      close(getScaleX(outX, 1), 4) &&
      close(getScaleX(outX, 2), 2) &&
      close(getScaleY(outX, 0), 9) &&
      close(getScaleY(outX, 2), 9),
    outX ? fmt(outX.scales) : "no output"
  );
  const outY = runPoints(tgt, src, { attr_name: "sy", mode: "nearest" });
  check(
    "sy alias writes y and defaults the untouched x to 1",
    !!outY &&
      close(getScaleY(outY, 0), 3) &&
      close(getScaleY(outY, 1), 5) &&
      close(getScaleX(outY, 0), 1),
    outY ? fmt(outY.scales) : "no output"
  );
}

// position snaps onto the nearest source; x alone keeps y; input untouched.
{
  const out = runPoints(tgt, src, { attr_name: "position", mode: "nearest" });
  check(
    "position snaps targets onto their nearest source",
    !!out &&
      close(out.positions[0], 0) &&
      close(out.positions[1], 0) &&
      close(out.positions[2], 1) &&
      close(out.positions[3], 0) &&
      close(out.positions[4], 0) &&
      close(out.positions[5], 0),
    out ? fmt(out.positions) : "no output"
  );
  const outX = runPoints(tgt, src, { attr_name: "x", mode: "nearest" });
  check(
    "x replaces x and keeps the target's y",
    !!outX &&
      close(outX.positions[0], 0) &&
      close(outX.positions[1], 0.2) &&
      close(outX.positions[2], 1) &&
      close(outX.positions[3], 0.3) &&
      close(outX.positions[4], 0) &&
      close(outX.positions[5], 0.6),
    outX ? fmt(outX.positions) : "no output"
  );
  check(
    "position transfer does not mutate the input",
    close(tgt.positions[0], 0.1) && close(tgt.positions[2], 0.9)
  );
}

// group: an identity tag — nearest even in weighted mode, integer on write.
{
  const out = runPoints(tgt, src, {
    attr_name: "group",
    mode: "weighted",
    fallback: "nearest",
    radius: 1,
  });
  check(
    "group ignores weighted and takes the nearest tag",
    !!out &&
      out.groupIndices instanceof Int32Array &&
      getGroupIndex(out, 0) === 3 &&
      getGroupIndex(out, 1) === 7 &&
      getGroupIndex(out, 2) === 3,
    out ? fmt(out.groupIndices) : "no output"
  );
}

// Read-only built-ins and spline sides pass through unchanged.
{
  const out = runPoints(tgt, src, { attr_name: "index", mode: "nearest" });
  check(
    "index passes the target through",
    !!out &&
      out.rotations === undefined &&
      out.attributes === undefined &&
      close(out.positions[0], 0.1)
  );
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      { closed: false, anchors: [{ pos: [0.1, 0] }, { pos: [0.9, 0] }] },
    ],
  };
  const outSpline = run(spline, src, {
    attr_name: "rotation",
    target: "spline anchors",
    source_target: "points",
    mode: "nearest",
  });
  check(
    "built-in name with a spline target passes through",
    outSpline?.kind === "spline" &&
      outSpline.subpaths.length === 1 &&
      outSpline.subpaths[0].anchors.every((a) => a.attrs === undefined)
  );
  const outFromSpline = run(tgt, spline, {
    attr_name: "rotation",
    target: "points",
    source_target: "spline anchors",
    mode: "nearest",
  });
  check(
    "built-in name with a spline source passes through",
    outFromSpline?.kind === "points" && outFromSpline.rotations === undefined
  );
}

// The name picker offers exactly the writable built-ins; index tints red.
{
  const p = attributeTransferNode.params.find((q) => q.name === "attr_name");
  const filter = p?.suggestAttrsBuiltinFilter;
  const info: AttrNameInfo = {
    known: true,
    names: ["weight"],
    builtins: ["index", "x", "y", "scale.x", "scale.y", "rotation", "group"],
  };
  check(
    "attr_name opts into built-ins with a writable-column filter",
    p?.suggestAttrsIncludeBuiltins === true && typeof filter === "function"
  );
  const offered = attrNameSuggestions(info, true, filter);
  check(
    "picker offers rotation / scale.x / scale.y / x / y / group + channels",
    ["rotation", "scale.x", "scale.y", "x", "y", "group", "weight"].every(
      (n) => offered.includes(n)
    ),
    offered.join(",")
  );
  check(
    "picker drops index (read-only)",
    !offered.includes("index"),
    offered.join(",")
  );
  check(
    "rotation is a valid name",
    !isAttrNameInvalid("rotation", info, true, true, filter)
  );
  check(
    "scale alias is valid even when the picker lists per-axis names",
    !isAttrNameInvalid("scale", info, true, true, filter)
  );
  check(
    "index tints red on Transfer",
    isAttrNameInvalid("index", info, true, true, filter)
  );
  check(
    "a missing channel still tints red",
    isAttrNameInvalid("nope", info, true, true, filter)
  );
  check(
    "without a filter every built-in stays valid (Map Attribute path)",
    !isAttrNameInvalid("index", info, true, true)
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall attribute-transfer checks passed");
