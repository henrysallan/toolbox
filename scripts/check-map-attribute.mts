// check-map-attribute: Map Attribute remaps any point column — named
// channels and built-ins (index, x/y, scale.x, rotation, group, dotted
// named components) — onto scale / rotation / position.
//
//   npx tsx scripts/check-map-attribute.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, getRotation, getScaleX, makePoints } from "../src/engine/points.ts";
import { mapAttributeNode } from "../src/nodes/effect/map-attribute.ts";
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
  return { time: 0, playing: true, state: {}, width: 1920, height: 1080 } as unknown as RenderContext;
}

function samplePoints(): PointsValue {
  const pts = makePoints(4, { withScales: true, withRotations: true });
  pts.positions.set([0.0, 0.1, 0.25, 0.4, 0.5, 0.6, 1.0, 0.8]);
  pts.scales!.fill(1);
  pts.rotations!.fill(0);
  return copyPointsWith(pts, {
    attributes: {
      weight: { arity: 1, data: new Float32Array([0, 0.5, 1, 1]) },
      color: { arity: 2, data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) },
    },
  });
}

function evalMap(
  input: SocketValue | undefined,
  params: Record<string, unknown>
): PointsValue | undefined {
  const ctx = makeCtx();
  const coerced = coerceValue(input, "points", ctx);
  const out = mapAttributeNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "map",
  } as Parameters<typeof mapAttributeNode.compute>[0]) as NodeOutput;
  return out.primary?.kind === "points" ? out.primary : undefined;
}

const BASE = {
  attr_name: "weight",
  map_target: "scale",
  in_lo: 0,
  in_hi: 1,
  out_lo: 1,
  out_hi: 2,
};

const pts = samplePoints();

{
  const out = evalMap(pts, BASE);
  check(
    "named channel → scale (regression)",
    !!out &&
      close(getScaleX(out, 0), 1) &&
      close(getScaleX(out, 1), 1.5) &&
      close(getScaleX(out, 2), 2) &&
      close(getScaleX(out, 3), 2),
    out ? `${getScaleX(out, 0)},${getScaleX(out, 1)},${getScaleX(out, 2)}` : "no output"
  );
}

{
  const out = evalMap(pts, {
    ...BASE,
    attr_name: "index",
    in_hi: 3,
    out_lo: 0.5,
    out_hi: 1.5,
  });
  check(
    "index → scale",
    !!out &&
      close(getScaleX(out, 0), 0.5) &&
      close(getScaleX(out, 3), 1.5),
    out ? `${getScaleX(out, 0)}..${getScaleX(out, 3)}` : "no output"
  );
}

{
  const out = evalMap(pts, {
    ...BASE,
    attr_name: "x",
    map_target: "rotation",
    out_lo: 0,
    out_hi: Math.PI,
  });
  check(
    "x → rotation",
    !!out &&
      close(getRotation(out, 0), 0) &&
      close(getRotation(out, 2), Math.PI / 2) &&
      close(getRotation(out, 3), Math.PI),
    out ? `${getRotation(out, 0)},${getRotation(out, 2)},${getRotation(out, 3)}` : "no output"
  );
}

{
  const out = evalMap(pts, {
    ...BASE,
    attr_name: "y",
    map_target: "position x",
    out_lo: 0,
    out_hi: 0.1,
  });
  // point 0: y=0.1 → +0.01 → x=0.01; point 2: y=0.6 → +0.06 → x=0.56
  check(
    "y → position x offset",
    !!out &&
      close(out.positions[0], 0.01) &&
      close(out.positions[4], 0.56),
    out ? `${out.positions[0]},${out.positions[4]}` : "no output"
  );
}

{
  const src = makePoints(2, { withScales: true });
  src.positions.set([0, 0, 1, 0]);
  src.scales!.set([1, 2, 3, 4]);
  const out = evalMap(src, {
    ...BASE,
    attr_name: "scale.x",
    map_target: "scale",
    in_lo: 1,
    in_hi: 3,
    out_lo: 1,
    out_hi: 2,
  });
  // point 0 scale.x=1 → t=0 → 1; point 1 scale.x=3 → t=1 → 2, times existing
  check(
    "scale.x → scale",
    !!out && close(getScaleX(out, 0), 1) && close(getScaleX(out, 1), 6),
    out ? `${getScaleX(out, 0)},${getScaleX(out, 1)}` : "no output"
  );
}

{
  const out = evalMap(pts, {
    ...BASE,
    attr_name: "color.y",
    map_target: "scale",
    out_lo: 0,
    out_hi: 1,
  });
  // color.y values 0.2, 0.4, 0.6, 0.8 → scale
  check(
    "named vec component color.y → scale",
    !!out && close(getScaleX(out, 0), 0.2) && close(getScaleX(out, 3), 0.8),
    out ? `${getScaleX(out, 0)},${getScaleX(out, 3)}` : "no output"
  );
}

{
  const out = evalMap(pts, { ...BASE, attr_name: "missing" });
  check(
    "missing named channel passes through",
    !!out &&
      close(getScaleX(out, 2), 1) &&
      close(out.positions[4], pts.positions[4]),
    out ? `${getScaleX(out, 2)} ${out.positions[4]}` : "no output"
  );
}

{
  const out = evalMap(pts, { ...BASE, attr_name: "" });
  check("empty name passes through", !!out && close(getScaleX(out, 2), 1));
}

{
  const known: AttrNameInfo = {
    known: true,
    names: ["weight"],
    builtins: ["index", "x", "y", "scale.x", "scale.y", "rotation", "group"],
  };
  check(
    "index is invalid on writers",
    isAttrNameInvalid("index", known, false) === true
  );
  check(
    "index is valid on Map Attribute",
    isAttrNameInvalid("index", known, true, true) === false
  );
  check(
    "index is invalid on other consumers",
    isAttrNameInvalid("index", known, true) === true
  );
  check(
    "missing named is invalid on Map Attribute",
    isAttrNameInvalid("nope", known, true, true) === true
  );
  check(
    "present named is valid on Map Attribute",
    isAttrNameInvalid("weight", known, true, true) === false
  );
  check(
    "color.y valid when color is present",
    isAttrNameInvalid("color.y", { ...known, names: ["color"] }, true, true) ===
      false
  );
  const suggestions = attrNameSuggestions(known, true);
  check(
    "suggestions lead with builtins then named",
    suggestions[0] === "index" && suggestions.includes("weight")
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
