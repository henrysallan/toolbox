// check-attribute-read: Attribute Read samples one point's column — a
// named channel, a dotted component, or a built-in — as a scalar or vec2.
//
//   npx tsx scripts/check-attribute-read.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, makePoints } from "../src/engine/points.ts";
import { attributeReadNode } from "../src/nodes/effect/attribute-read.ts";
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

function samplePoints(): PointsValue {
  const pts = makePoints(4, { withScales: true, withRotations: true });
  pts.positions.set([0.0, 0.1, 0.25, 0.4, 0.5, 0.6, 1.0, 0.8]);
  pts.scales!.set([1, 2, 3, 4, 5, 6, 7, 8]);
  pts.rotations!.set([0, 0.1, 0.2, 0.3]);
  return copyPointsWith(pts, {
    attributes: {
      weight: { arity: 1, data: new Float32Array([0, 0.5, 1, 1.5]) },
      color: {
        arity: 2,
        data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
      },
    },
  });
}

function evalRead(
  input: SocketValue | undefined,
  params: Record<string, unknown>
): NodeOutput {
  const ctx = makeCtx();
  const socket = attributeReadNode.inputs[0];
  const coerced = coerceValue(input, socket.type, ctx);
  return attributeReadNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "read",
  } as Parameters<typeof attributeReadNode.compute>[0]) as NodeOutput;
}

const pts = samplePoints();

{
  const out = evalRead(pts, {
    attr_name: "weight",
    shape: "scalar",
    index: 2,
  }).primary;
  check(
    "named float → scalar at index",
    out?.kind === "scalar" && close(out.value, 1),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "color",
    shape: "vec2",
    index: 1,
  }).primary;
  check(
    "named vec2 → vec2 at index",
    out?.kind === "vec2" && close(out.value[0], 0.3) && close(out.value[1], 0.4),
    out?.kind === "vec2" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "color",
    shape: "scalar",
    index: 1,
  }).primary;
  check(
    "named vec2 as scalar → component 0",
    out?.kind === "scalar" && close(out.value, 0.3),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "weight",
    shape: "vec2",
    index: 2,
  }).primary;
  check(
    "named float as vec2 → [v, 0]",
    out?.kind === "vec2" && close(out.value[0], 1) && close(out.value[1], 0),
    out?.kind === "vec2" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "color.y",
    shape: "scalar",
    index: 3,
  }).primary;
  check(
    "dotted component color.y",
    out?.kind === "scalar" && close(out.value, 0.8),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "index",
    shape: "scalar",
    index: 3,
  }).primary;
  check(
    "builtin index",
    out?.kind === "scalar" && close(out.value, 3),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "x",
    shape: "scalar",
    index: 2,
  }).primary;
  check(
    "builtin x",
    out?.kind === "scalar" && close(out.value, 0.5),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "position",
    shape: "vec2",
    index: 2,
  }).primary;
  check(
    "builtin position → vec2",
    out?.kind === "vec2" && close(out.value[0], 0.5) && close(out.value[1], 0.6),
    out?.kind === "vec2" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "scale",
    shape: "vec2",
    index: 1,
  }).primary;
  check(
    "builtin scale → vec2",
    out?.kind === "vec2" && close(out.value[0], 3) && close(out.value[1], 4),
    out?.kind === "vec2" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "rotation",
    shape: "scalar",
    index: 2,
  }).primary;
  check(
    "builtin rotation",
    out?.kind === "scalar" && close(out.value, 0.2),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "missing",
    shape: "scalar",
    index: 0,
  }).primary;
  check(
    "missing named channel reads 0",
    out?.kind === "scalar" && close(out.value, 0),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "",
    shape: "vec2",
    index: 0,
  }).primary;
  check(
    "empty name reads [0, 0]",
    out?.kind === "vec2" && close(out.value[0], 0) && close(out.value[1], 0),
    out?.kind === "vec2" ? `${out.value}` : String(out?.kind)
  );
}

{
  const empty = makePoints(0);
  const out = evalRead(empty, {
    attr_name: "weight",
    shape: "scalar",
    index: 0,
  }).primary;
  check(
    "empty points reads 0",
    out?.kind === "scalar" && close(out.value, 0),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "weight",
    shape: "scalar",
    index: 99,
  }).primary;
  check(
    "index past end clamps to last",
    out?.kind === "scalar" && close(out.value, 1.5),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(pts, {
    attr_name: "weight",
    shape: "scalar",
    index: -4,
  }).primary;
  check(
    "negative index clamps to 0",
    out?.kind === "scalar" && close(out.value, 0),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  const out = evalRead(undefined, {
    attr_name: "weight",
    shape: "scalar",
    index: 0,
  }).primary;
  check(
    "unwired points (via coerceValue) reads 0",
    out?.kind === "scalar" && close(out.value, 0),
    out?.kind === "scalar" ? `${out.value}` : String(out?.kind)
  );
}

{
  check(
    "resolvePrimaryOutput follows shape",
    attributeReadNode.resolvePrimaryOutput!({ shape: "vec2" }) === "vec2" &&
      attributeReadNode.resolvePrimaryOutput!({ shape: "scalar" }) ===
        "scalar"
  );
}

{
  const known: AttrNameInfo = {
    known: true,
    names: ["weight"],
    builtins: ["index", "x", "y", "scale.x", "scale.y", "rotation", "group"],
  };
  check(
    "index is valid on Attribute Read",
    isAttrNameInvalid("index", known, true, true) === false
  );
  check(
    "missing named is invalid on Attribute Read",
    isAttrNameInvalid("nope", known, true, true) === true
  );
  check(
    "present named is valid on Attribute Read",
    isAttrNameInvalid("weight", known, true, true) === false
  );
  const suggestions = attrNameSuggestions(known, true);
  check(
    "suggestions lead with builtins then named",
    suggestions[0] === "index" && suggestions.includes("weight")
  );
}

{
  const { gridNode } = await import("../src/nodes/source/grid.ts");
  const { sampleTextureAtPointsNode } = await import(
    "../src/nodes/effect/sample-texture-at-points.ts"
  );
  const { readPointAttr } = await import("../src/engine/points.ts");
  const gridOut = gridNode.compute({
    inputs: {},
    auxIn: {},
    params: {
      countX: 5,
      countY: 3,
      spacingMode: "fit",
      width: 0.8,
      height: 0.4,
      x: 0.5,
      y: 0.5,
    },
    ctx: makeCtx(),
    nodeId: "grid",
  } as Parameters<typeof gridNode.compute>[0]) as NodeOutput;
  const gp = gridOut.primary?.kind === "points" ? gridOut.primary : undefined;
  const cellW = gp ? readPointAttr(gp, "cellW", 0) : undefined;
  const cellH = gp ? readPointAttr(gp, "cellH", 0) : undefined;
  check(
    "Grid stamps cellW/cellH as span/(count-1)",
    !!gp &&
      close(cellW ?? -1, 0.8 / 4) &&
      close(cellH ?? -1, 0.4 / 2) &&
      close(readPointAttr(gp, "cellW", gp.count - 1) ?? -1, 0.8 / 4),
    `cellW=${cellW} cellH=${cellH}`
  );

  const white = {
    kind: "image" as const,
    texture: {} as WebGLTexture,
    width: 2,
    height: 2,
  };
  const ctx = {
    ...makeCtx(),
    readImagePixels: () => new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
  } as unknown as RenderContext;
  const sampled = sampleTextureAtPointsNode.compute({
    inputs: { points: gp, image: white },
    auxIn: {},
    params: {
      channel: "luminance",
      target: "named attribute",
      attr_name: "lum",
      blend: "replace",
      lo: 0,
      hi: 2,
    },
    ctx,
    nodeId: "stp",
  } as Parameters<typeof sampleTextureAtPointsNode.compute>[0]) as NodeOutput;
  const sp = sampled.primary?.kind === "points" ? sampled.primary : undefined;
  check(
    "Sample Texture named attribute writes lum, leaves scale alone",
    !!sp &&
      close(readPointAttr(sp, "lum", 0) ?? -1, 2) &&
      sp.attributes?.lum?.arity === 1 &&
      (sp.scales === gp?.scales || !sp.scales === !gp?.scales),
    sp ? `lum=${readPointAttr(sp, "lum", 0)}` : "no points"
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
