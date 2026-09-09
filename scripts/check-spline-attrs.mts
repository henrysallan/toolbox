// Guards spline named-channel carry through rebuilds, Attribute
// Math/Blur/Transfer on spline anchors, and Stroke/Rasterize along-path
// `attribute` ramps.
//
//   npx tsx scripts/check-spline-attrs.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, makePoints } from "../src/engine/points.ts";
import {
  autoSmoothHandles,
  resampleSubpath,
  roundCorners,
} from "../src/engine/spline-math.ts";
import {
  readSplineAnchorChannel,
  sampleSubpathAttrScalar,
} from "../src/engine/spline-attrs.ts";
import { trimSubpaths } from "../src/engine/spline-trim.ts";
import { attributeMathNode } from "../src/nodes/effect/attribute-math.ts";
import { attributeBlurNode } from "../src/nodes/effect/attribute-blur.ts";
import { attributeTransferNode } from "../src/nodes/effect/attribute-transfer.ts";
import { setSplineTypeNode } from "../src/nodes/effect/set-spline-type.ts";
import { rasterizeSplineNode } from "../src/nodes/effect/rasterize-spline.ts";
import { strokeNode } from "../src/nodes/effect/stroke.ts";

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

function heatLine(): SplineSubpath {
  return {
    closed: false,
    anchors: [
      {
        pos: [0, 0.5],
        outHandle: [1 / 3, 0],
        attrs: { heat: 0 },
      },
      {
        pos: [1, 0.5],
        inHandle: [-1 / 3, 0],
        attrs: { heat: 1 },
      },
    ],
  };
}

function scalarAt(sub: SplineSubpath, i: number, name: string): number {
  const v = sub.anchors[i]?.attrs?.[name];
  const n = Array.isArray(v) ? v[0] : v;
  return typeof n === "number" ? n : NaN;
}

{
  const src = heatLine();
  const mid = resampleSubpath(src, 5);
  check(
    "resample interpolates endpoints",
    close(scalarAt(mid, 0, "heat"), 0) && close(scalarAt(mid, 4, "heat"), 1)
  );
  check(
    "resample interpolates midpoint",
    close(scalarAt(mid, 2, "heat"), 0.5, 0.08),
    `mid=${scalarAt(mid, 2, "heat")}`
  );
  check(
    "sampleSubpathAttrScalar matches arc t",
    close(sampleSubpathAttrScalar(src, 0, "heat"), 0) &&
      close(sampleSubpathAttrScalar(src, 1, "heat"), 1) &&
      close(sampleSubpathAttrScalar(src, 0.5, "heat"), 0.5, 0.08)
  );
  check(
    "missing attr samples as 0",
    sampleSubpathAttrScalar(src, 0.5, "nope") === 0
  );
}

{
  const src = heatLine();
  const smoothed = autoSmoothHandles(src.anchors, false, 1);
  check(
    "autoSmoothHandles copies attrs 1:1",
    close(scalarAt({ ...src, anchors: smoothed }, 0, "heat"), 0) &&
      close(scalarAt({ ...src, anchors: smoothed }, 1, "heat"), 1)
  );

  const ctx = makeCtx();
  const spline: SplineValue = { kind: "spline", subpaths: [src] };
  const out = setSplineTypeNode.compute({
    inputs: { path: coerceValue(spline, "spline", ctx) },
    auxIn: {},
    params: { spline_type: "linear" },
    ctx,
    nodeId: "sst",
  }) as NodeOutput;
  const a =
    out.primary?.kind === "spline" ? out.primary.subpaths[0] : undefined;
  check(
    "set-spline-type linear keeps attrs",
    !!a && close(scalarAt(a, 0, "heat"), 0) && close(scalarAt(a, 1, "heat"), 1)
  );
}

{
  const square: SplineSubpath = {
    closed: true,
    anchors: [
      { pos: [0.2, 0.2], attrs: { heat: 0.7 } },
      { pos: [0.8, 0.2] },
      { pos: [0.8, 0.8] },
      { pos: [0.2, 0.8] },
    ],
  };
  const rounded = roundCorners([square], 0.05)[0];
  const heats = (rounded?.anchors ?? [])
    .map((a) => a.attrs?.heat)
    .filter((v) => typeof v === "number") as number[];
  check(
    "round-corners fillets copy source corner attrs",
    heats.length >= 2 && heats.every((h) => close(h, 0.7)),
    `heats=${JSON.stringify(heats)} count=${rounded?.anchors.length}`
  );
}

{
  const trimmed = trimSubpaths([heatLine()], 0.25, 0.75);
  const sub = trimmed[0];
  check("trim emits one open piece", !!sub && sub.closed === false);
  check(
    "trim window maps attr t",
    !!sub &&
      close(scalarAt(sub, 0, "heat"), 0.25, 0.08) &&
      close(scalarAt(sub, sub.anchors.length - 1, "heat"), 0.75, 0.08),
    sub
      ? `lo=${scalarAt(sub, 0, "heat")} hi=${scalarAt(sub, sub.anchors.length - 1, "heat")}`
      : "no sub"
  );
}

{
  const ctx = makeCtx();
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        anchors: [
          { pos: [0, 0], attrs: { weight: 2 } },
          { pos: [1, 0], attrs: { weight: 4 } },
        ],
      },
    ],
  };
  const out = attributeMathNode.compute({
    inputs: { points: coerceValue(spline, "spline", ctx) },
    auxIn: {},
    params: {
      target: "spline anchors",
      attr_name: "weight",
      op: "multiply",
      operand: "constant",
      value: 0.5,
    },
    ctx,
    nodeId: "am",
  }) as NodeOutput;
  const ch =
    out.primary?.kind === "spline"
      ? readSplineAnchorChannel(out.primary, "weight")
      : undefined;
  check(
    "attribute-math multiply on spline anchors",
    !!ch && close(ch.data[0], 1) && close(ch.data[1], 2)
  );
}

{
  const ctx = makeCtx();
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        attrs: { heat: 3 },
        anchors: [{ pos: [0, 0] }, { pos: [1, 0] }],
      },
    ],
  };
  const out = attributeMathNode.compute({
    inputs: { points: coerceValue(spline, "spline", ctx) },
    auxIn: {},
    params: {
      target: "spline anchors",
      attr_name: "heat",
      op: "multiply",
      operand: "constant",
      value: 2,
    },
    ctx,
    nodeId: "am2",
  }) as NodeOutput;
  const ch =
    out.primary?.kind === "spline"
      ? readSplineAnchorChannel(out.primary, "heat")
      : undefined;
  check(
    "attribute-math subpath-only channel is a constant on every anchor",
    !!ch && close(ch.data[0], 6) && close(ch.data[1], 6)
  );
}

{
  const ctx = makeCtx();
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: true,
        anchors: [
          { pos: [0, 0], attrs: { w: 0 } },
          { pos: [1, 0], attrs: { w: 1 } },
        ],
      },
      {
        closed: false,
        anchors: [
          { pos: [0, 1], attrs: { w: 0 } },
          { pos: [1, 1], attrs: { w: 0 } },
        ],
      },
    ],
  };
  const out = attributeBlurNode.compute({
    inputs: { points: coerceValue(spline, "spline", ctx) },
    auxIn: {},
    params: {
      target: "spline anchors",
      attr_name: "w",
      domain: "index",
      iterations: 1,
      strength: 1,
    },
    ctx,
    nodeId: "ab",
  }) as NodeOutput;
  const ch =
    out.primary?.kind === "spline"
      ? readSplineAnchorChannel(out.primary, "w")
      : undefined;
  // Closed 2-anchor wrap: each mixes with the other → 0.5.
  // Open second subpath stays 0 (no cross-subpath bleed).
  check(
    "attribute-blur index wraps closed subpaths and does not cross them",
    !!ch &&
      close(ch.data[0], 0.5) &&
      close(ch.data[1], 0.5) &&
      close(ch.data[2], 0) &&
      close(ch.data[3], 0),
    ch ? `data=${Array.from(ch.data).join(",")}` : "no ch"
  );
}

{
  const ctx = makeCtx();
  const pts: PointsValue = copyPointsWith(makePoints(2), {
    attributes: {
      weight: { arity: 1, data: new Float32Array([1, 0]) },
    },
  });
  pts.positions.set([0, 0, 1, 0]);
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        anchors: [{ pos: [0, 0] }, { pos: [1, 0] }],
      },
    ],
  };
  const out = attributeTransferNode.compute({
    inputs: {
      points: coerceValue(spline, "spline", ctx),
      source: coerceValue(pts, "points", ctx),
    },
    auxIn: {},
    params: {
      target: "spline anchors",
      source_target: "points",
      attr_name: "weight",
      mode: "nearest",
    },
    ctx,
    nodeId: "at",
  }) as NodeOutput;
  const ch =
    out.primary?.kind === "spline"
      ? readSplineAnchorChannel(out.primary, "weight")
      : undefined;
  check(
    "attribute-transfer points → spline anchors (nearest)",
    !!ch && close(ch.data[0], 1) && close(ch.data[1], 0),
    ch ? `data=${Array.from(ch.data).join(",")}` : "no ch"
  );
}

{
  const rBy = rasterizeSplineNode.params.find((p) => p.name === "stroke_ramp_by");
  const sBy = strokeNode.params.find((p) => p.name === "ramp_by");
  check(
    "Rasterize stroke_ramp_by includes progress + attribute",
    !!rBy &&
      Array.isArray(rBy.options) &&
      rBy.options.includes("progress") &&
      rBy.options.includes("attribute")
  );
  check(
    "Stroke ramp_by includes progress + attribute",
    !!sBy &&
      Array.isArray(sBy.options) &&
      sBy.options.includes("progress") &&
      sBy.options.includes("attribute")
  );
  const rAttr = rasterizeSplineNode.params.find(
    (p) => p.name === "stroke_driver_attr"
  );
  const sAttr = strokeNode.params.find((p) => p.name === "driver_attr");
  check(
    "Rasterize driver attr visible for driver and attribute",
    !!rAttr?.visibleIf &&
      rAttr.visibleIf({
        enable_stroke: true,
        stroke_source: "ramp",
        stroke_ramp_by: "attribute",
      }) &&
      rAttr.visibleIf({
        enable_stroke: true,
        stroke_source: "ramp",
        stroke_ramp_by: "driver",
      })
  );
  check(
    "Stroke driver attr visible for driver and attribute",
    !!sAttr?.visibleIf &&
      sAttr.visibleIf({ color_source: "ramp", ramp_by: "attribute" }) &&
      sAttr.visibleIf({ color_source: "ramp", ramp_by: "driver" })
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll spline-attrs checks passed.");
