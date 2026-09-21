// check-unified-attrs: one schema for built-in and named point attributes
// (specdocs/092026_unified-attributes.md). `withPointAttr` routes any name
// — "scale", "scale.y", "x", "group", or a channel — with the schema's
// coercion; every writer node (Set Named Attribute, Attribute Math, Map
// Attribute, Point Expression's setattr) goes through it; the subpath
// `driver` is an attribute Rasterize / Stroke read by default; Collect and
// Copy to Points carry every attribute.
//
//   npx tsx scripts/check-unified-attrs.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import {
  BUILTIN_POINT_ATTR_NAMES,
  copyPointsWith,
  getGroupIndex,
  getRotation,
  getScaleX,
  getScaleY,
  isBuiltinPointAttrName,
  isWritablePointAttr,
  makePoints,
  pointAttrArity,
  readPointAttr,
  readPointAttrColumn,
  withPointAttr,
  withPointAttrs,
} from "../src/engine/points.ts";
import {
  readSubpathAttr,
  readSubpathDriver,
  withSubpathAttr,
} from "../src/engine/spline-attrs.ts";
import { makeSubpathDriverFn } from "../src/engine/spline-color-source.ts";
import { inspectSocketValue } from "../src/engine/socket-inspect.ts";
import {
  geometricRamp,
  setNamedAttributeNode,
} from "../src/nodes/effect/set-named-attribute.ts";
import { attributeMathNode } from "../src/nodes/effect/attribute-math.ts";
import {
  mapAttributeNode,
  migrateMapAttributeParams,
} from "../src/nodes/effect/map-attribute.ts";
import { pointExpressionNode } from "../src/nodes/effect/point-expression.ts";
import { collectNode } from "../src/nodes/effect/collect.ts";
import { copyToPointsNode } from "../src/nodes/effect/copy-to-points.ts";
import {
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

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    frame: 0,
    fps: 60,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

// n points on the x axis, no optional arrays (defaults everywhere).
function bare(n: number): PointsValue {
  const pts = makePoints(n);
  for (let i = 0; i < n; i++) {
    pts.positions[i * 2] = n > 1 ? i / (n - 1) : 0;
    pts.positions[i * 2 + 1] = 0.5;
  }
  return pts;
}

function run(
  node: typeof setNamedAttributeNode,
  inputs: Record<string, SocketValue | undefined>,
  params: Record<string, unknown>,
  nodeId = "n"
): NodeOutput {
  const ctx = makeCtx();
  const coerced: Record<string, SocketValue | undefined> = {};
  for (const [k, v] of Object.entries(inputs)) {
    coerced[k] = v
      ? coerceValue(v, v.kind === "spline" ? "spline" : "points", ctx)
      : undefined;
  }
  return node.compute({
    inputs: coerced,
    auxIn: {},
    params,
    ctx,
    nodeId,
  } as Parameters<typeof node.compute>[0]) as NodeOutput;
}

const pointsOf = (o: NodeOutput): PointsValue | undefined =>
  o.primary?.kind === "points" ? o.primary : undefined;
const splineOf = (o: NodeOutput): SplineValue | undefined =>
  o.primary?.kind === "spline" ? o.primary : undefined;

// ---------------------------------------------------------------------------
// §4.1 / §4.2 — schema + withPointAttr coercion
// ---------------------------------------------------------------------------

{
  check(
    "built-in spellings resolve (canonical, lane, dotted, spaced, sx)",
    ["position", "x", "y", "scale", "scale.x", "scale y", "sx", "rotation", "group", "index", "z", "nx", "position.x"].every(isBuiltinPointAttrName) &&
      !isBuiltinPointAttrName("weight") &&
      !isBuiltinPointAttrName("color.y")
  );
  check(
    "writable set: built-ins minus index / z / normals; every channel",
    ["scale", "scale.y", "x", "rotation", "group", "weight", "color.y"].every(isWritablePointAttr) &&
      !["index", "z", "nx", "ny", "nz", ""].some(isWritablePointAttr)
  );
  check(
    "BUILTIN_POINT_ATTR_NAMES lists the legacy reserved spellings",
    ["position", "x", "y", "index", "rotation", "scale", "group", "z", "nx", "ny", "nz", "scale.x", "sx"].every((n) => BUILTIN_POINT_ATTR_NAMES.has(n))
  );
}

{
  const src = bare(3);
  const out = withPointAttr(src, "scale", new Float32Array([0.5, 2, 3]));
  check(
    "scalar → scale broadcasts to both lanes",
    close(getScaleX(out, 0), 0.5) && close(getScaleY(out, 0), 0.5) &&
      close(getScaleX(out, 2), 3) && close(getScaleY(out, 2), 3)
  );
  check("withPointAttr never mutates its input", src.scales === undefined && out !== src);
  const lane = withPointAttr(out, "scale.y", new Float32Array([9, 9, 9]));
  check(
    "lane write keeps the other lane",
    close(getScaleX(lane, 1), 2) && close(getScaleY(lane, 1), 9)
  );
  const x = withPointAttr(src, "x", new Float32Array([0.1, 0.2, 0.3]));
  check(
    "x lane write keeps y",
    close(x.positions[2], 0.2) && close(x.positions[3], 0.5) &&
      close(src.positions[2], 0.5)
  );
  const pos = withPointAttr(src, "position", new Float32Array([1, 2, 3, 4, 5, 6]));
  check("vec2 → position sets both lanes", close(pos.positions[2], 3) && close(pos.positions[5], 6));
}

{
  const src = bare(3);
  const g = withPointAttr(src, "group", new Float32Array([0.4, 2.6, -1.2]));
  check(
    "group rounds to an integer tag",
    getGroupIndex(g, 0) === 0 && getGroupIndex(g, 1) === 3 && getGroupIndex(g, 2) === -1
  );
  const nan = withPointAttr(src, "scale", new Float32Array([NaN, Infinity, 2]));
  check(
    "non-finite built-in write falls back to the lane default (scale 1)",
    close(getScaleX(nan, 0), 1) && close(getScaleY(nan, 1), 1) && close(getScaleX(nan, 2), 2)
  );
  const nanCh = withPointAttr(src, "w", new Float32Array([NaN, 1, 2]));
  check("non-finite channel write reads 0", nanCh.attributes?.w.data[0] === 0);
  const mul = withPointAttr(src, "scale", new Float32Array([2, 3, 4]), { mode: "multiply" });
  check(
    "multiply against an absent scales array uses the default 1",
    close(getScaleX(mul, 1), 3) && close(getScaleY(mul, 1), 3)
  );
  const add = withPointAttr(mul, "rotation", new Float32Array([0.5, 0.5, 0.5]), { mode: "add" });
  check("add on rotation", close(getRotation(add, 0), 0.5));
  check(
    "non-writable names return the input object unchanged",
    withPointAttr(src, "index", new Float32Array(3)) === src &&
      withPointAttr(src, "z", new Float32Array(3)) === src &&
      withPointAttr(src, "nx", new Float32Array(3)) === src &&
      withPointAttr(src, "", new Float32Array(3)) === src
  );
}

{
  const src = bare(2);
  const a = withPointAttr(src, "color", new Float32Array([1, 2, 3, 4]), { arity: 2, color: true });
  check(
    "named channel set with explicit arity + color tag",
    a.attributes?.color.arity === 2 && a.attributes.color.color === true &&
      a.attributes.color.data[3] === 4
  );
  const b = withPointAttr(a, "color", new Float32Array([10, 10, 10, 10]), { mode: "multiply" });
  check(
    "named channel multiply keeps arity and color tag",
    b.attributes?.color.arity === 2 && b.attributes.color.color === true &&
      b.attributes.color.data[2] === 30
  );
  const c = withPointAttr(a, "color.y", new Float32Array([7, 8]));
  check(
    "dotted lane write into an existing channel",
    c.attributes?.color.data[1] === 7 && c.attributes.color.data[3] === 8 &&
      c.attributes.color.data[0] === 1
  );
  const d = withPointAttr(a, "w", new Float32Array([5, 6]), { mode: "add" });
  check("add onto a missing channel uses identity 0", d.attributes?.w.data[1] === 6);
  const batch = withPointAttrs(src, {
    scale: { data: new Float32Array([2, 3]) },
    w: { data: new Float32Array([1, 1]) },
  });
  check(
    "withPointAttrs batches built-in + channel",
    close(getScaleY(batch, 1), 3) && batch.attributes?.w.data[0] === 1
  );
}

{
  const src = withPointAttr(
    withPointAttr(bare(3), "scale", new Float32Array([1, 2, 3])),
    "color",
    new Float32Array([1, 2, 3, 4, 5, 6]),
    { arity: 2 }
  );
  const idx = readPointAttrColumn(src, "index");
  check("readPointAttrColumn index", idx?.arity === 1 && idx.data[2] === 2);
  const sc = readPointAttrColumn(src, "scale");
  check("readPointAttrColumn scale is interleaved vec2", sc?.arity === 2 && sc.data[3] === 2);
  const sy = readPointAttrColumn(src, "scale.y");
  check("readPointAttrColumn scale.y is arity 1", sy?.arity === 1 && sy.data[2] === 3);
  const cy = readPointAttrColumn(src, "color.y");
  check("readPointAttrColumn channel lane", cy?.arity === 1 && cy.data[1] === 4);
  check(
    "pointAttrArity",
    pointAttrArity(src, "position") === 2 && pointAttrArity(src, "x") === 1 &&
      pointAttrArity(src, "color") === 2 && pointAttrArity(src, "color.x") === 1 &&
      pointAttrArity(src, "nope") === undefined
  );
  check(
    "readPointAttr aliases agree",
    readPointAttr(src, "sx", 1) === 2 && readPointAttr(src, "scale y", 2) === 3 &&
      readPointAttr(src, "position x", 2) === 1 && readPointAttr(src, "rotation", 0) === 0
  );
}

// ---------------------------------------------------------------------------
// §4.3 — Set Named Attribute (acceptance 1)
// ---------------------------------------------------------------------------

{
  const out = pointsOf(
    run(setNamedAttributeNode, { points: bare(4) }, {
      attr_name: "scale",
      target: "points",
      kind: "float",
      source: "index",
      lo: 0.5,
      hi: 2,
    })
  );
  check(
    "Set Named Attribute name=scale source=index writes 0.5…2 to both lanes",
    !!out && close(getScaleX(out, 0), 0.5) && close(getScaleY(out, 0), 0.5) &&
      close(getScaleX(out, 1), 1) && close(getScaleX(out, 3), 2) &&
      out.attributes?.scale === undefined
  );
}

{
  check(
    "geometricRamp is lo·(hi/lo)^t and degrades to linear across zero",
    close(geometricRamp(1, 8, 1 / 3), 2) && close(geometricRamp(1, 8, 1), 8) &&
      close(geometricRamp(0, 8, 0.5), 4) && close(geometricRamp(-1, 8, 0.5), 3.5)
  );
  const out = pointsOf(
    run(setNamedAttributeNode, { points: bare(4) }, {
      attr_name: "scale",
      target: "points",
      kind: "float",
      source: "exponential",
      lo: 1,
      hi: 8,
    })
  );
  check(
    "source=exponential gives the geometric ladder 1, 2, 4, 8",
    !!out && [1, 2, 4, 8].every((v, i) => close(getScaleX(out, i), v)),
    out ? Array.from({ length: 4 }, (_, i) => getScaleX(out, i)).join(",") : "no output"
  );
}

{
  const src = withPointAttr(bare(3), "scale", new Float32Array([2, 2, 2]));
  const out = pointsOf(
    run(setNamedAttributeNode, { points: src }, {
      attr_name: "scale",
      target: "points",
      kind: "float",
      source: "constant",
      value: 3,
      mode: "multiply",
    })
  );
  check("mode=multiply combines with the current scale", !!out && close(getScaleX(out, 1), 6));
  const passthrough = run(setNamedAttributeNode, { points: src }, {
    attr_name: "index",
    target: "points",
    kind: "float",
    source: "constant",
    value: 3,
  });
  check(
    "read-only built-in passes the input through (same object, aux name kept)",
    passthrough.primary === coerceValue(src, "points", makeCtx()) ||
      (pointsOf(passthrough)?.scales === src.scales &&
        passthrough.aux?.name?.kind === "string" && passthrough.aux.name.value === "index")
  );
  const ch = pointsOf(
    run(setNamedAttributeNode, { points: src }, {
      attr_name: "weight",
      target: "points",
      kind: "float",
      source: "index",
    })
  );
  check(
    "named channel still lands in attributes (regression)",
    !!ch && ch.attributes?.weight.arity === 1 && close(ch.attributes.weight.data[2], 1)
  );
}

function square(extra?: Partial<SplineSubpath>): SplineSubpath {
  return {
    closed: true,
    anchors: [
      { pos: [0.4, 0.4] },
      { pos: [0.6, 0.4] },
      { pos: [0.6, 0.6] },
      { pos: [0.4, 0.6] },
    ],
    ...extra,
  };
}

{
  const spline: SplineValue = { kind: "spline", subpaths: [square(), square(), square()] };
  const out = splineOf(
    run(setNamedAttributeNode, { points: spline }, {
      attr_name: "driver",
      target: "spline subpaths",
      kind: "float",
      source: "index",
      lo: 0,
      hi: 1,
    })
  );
  check(
    "target=subpaths name=driver writes attrs.driver (and the shim field)",
    !!out && out.subpaths[1].attrs?.driver === 0.5 && out.subpaths[1].driver === 0.5 &&
      out.subpaths[2].attrs?.driver === 1
  );
  const grp = splineOf(
    run(setNamedAttributeNode, { points: spline }, {
      attr_name: "group",
      target: "spline subpaths",
      kind: "float",
      source: "index",
      lo: 0,
      hi: 2,
    })
  );
  check(
    "target=subpaths name=group writes groupIndex (rounded), not attrs",
    !!grp && grp.subpaths[1].groupIndex === 1 && grp.subpaths[2].groupIndex === 2 &&
      grp.subpaths[1].attrs?.group === undefined
  );
  const s = withSubpathAttr(square(), "w", [1, 2]);
  check(
    "readSubpathAttr / withSubpathAttr round-trip; driver defaults to 0.5, group to 0",
    Array.isArray(readSubpathAttr(s, "w")) && readSubpathAttr(s, "driver") === 0.5 &&
      readSubpathAttr(s, "group") === 0 && readSubpathAttr(s, "nope") === undefined
  );
}

// ---------------------------------------------------------------------------
// Attribute Math (acceptance 2, 3)
// ---------------------------------------------------------------------------

{
  const out = pointsOf(
    run(attributeMathNode, { points: bare(4) }, {
      attr_name: "index",
      target: "points",
      op: "power",
      operand: "constant",
      value: 1.35,
      output_name: "scale",
    })
  );
  check(
    "Attribute Math index ^ 1.35 → scale (geometric ladder)",
    !!out && [0, 1, 2, 3].every((i) => close(getScaleX(out, i), Math.pow(i, 1.35)) && close(getScaleY(out, i), Math.pow(i, 1.35))),
    out ? Array.from({ length: 4 }, (_, i) => getScaleX(out, i).toFixed(3)).join(",") : "no output"
  );
}

{
  const src = withPointAttr(bare(5), "u", new Float32Array([0, 1, 2, 3, 4]));
  const out = pointsOf(
    run(attributeMathNode, { points: src }, {
      attr_name: "u",
      target: "points",
      op: "wrap",
      in_lo: 0,
      in_hi: 3,
    })
  );
  check(
    "Attribute Math wrap folds u into [0, 3)",
    !!out && Array.from(out.attributes!.u.data).every((v, i) => close(v, i % 3))
  );
  const rot = pointsOf(
    run(attributeMathNode, { points: src }, {
      attr_name: "x",
      target: "points",
      op: "multiply",
      operand: "attribute",
      operand_attr: "u",
      output_name: "rotation",
    })
  );
  check(
    "built-in source × channel operand → built-in output",
    !!rot && close(getRotation(rot, 4), 1 * 4) && close(getRotation(rot, 2), 0.5 * 2)
  );
  const ro = run(attributeMathNode, { points: src }, {
    attr_name: "u",
    target: "points",
    op: "add",
    operand: "constant",
    value: 1,
    output_name: "index",
  });
  check(
    "read-only output passes through, aux still names it",
    pointsOf(ro)?.attributes === src.attributes && ro.aux?.name?.kind === "string" &&
      ro.aux.name.value === "index"
  );
}

// ---------------------------------------------------------------------------
// Map Attribute — output_name + mode, legacy map_target (acceptance 8)
// ---------------------------------------------------------------------------

{
  const src = withPointAttr(bare(3), "scale", new Float32Array([2, 2, 2]));
  const legacyParams: Record<string, unknown> = { attr_name: "index", map_target: "scale", in_lo: 0, in_hi: 2, out_lo: 1, out_hi: 3 };
  const legacy = pointsOf(run(mapAttributeNode, { points: src }, { ...legacyParams }));
  const migrated: Record<string, unknown> = { ...legacyParams };
  migrateMapAttributeParams(migrated);
  check(
    "migrateMapAttributeParams: scale → output_name scale / mode multiply, map_target dropped",
    migrated.output_name === "scale" && migrated.mode === "multiply" && !("map_target" in migrated)
  );
  const again: Record<string, unknown> = { ...migrated };
  migrateMapAttributeParams(again);
  check("migration is idempotent", again.output_name === "scale" && again.mode === "multiply");
  const fresh = pointsOf(run(mapAttributeNode, { points: src }, migrated));
  check(
    "legacy map_target and migrated params render identically (2×1, 2×2, 2×3)",
    !!legacy && !!fresh && [2, 4, 6].every((v, i) => close(getScaleX(legacy, i), v) && close(getScaleX(fresh, i), v) && close(getScaleY(fresh, i), v))
  );
  for (const [target, name, mode] of [
    ["rotation", "rotation", "add"],
    ["position x", "x", "add"],
    ["position y", "y", "add"],
  ] as const) {
    const p: Record<string, unknown> = { map_target: target };
    migrateMapAttributeParams(p);
    check(`migrate ${target}`, p.output_name === name && p.mode === mode);
  }
  const rot = pointsOf(
    run(mapAttributeNode, { points: src }, {
      attr_name: "index",
      output_name: "rotation",
      mode: "add",
      in_lo: 0,
      in_hi: 2,
      out_lo: 0,
      out_hi: Math.PI,
    })
  );
  check("output rotation / add", !!rot && close(getRotation(rot, 1), Math.PI / 2));
  const setX = pointsOf(
    run(mapAttributeNode, { points: src }, {
      attr_name: "index",
      output_name: "x",
      mode: "set",
      in_lo: 0,
      in_hi: 2,
      out_lo: 0.1,
      out_hi: 0.3,
    })
  );
  check("output x / set replaces the coordinate, keeps y", !!setX && close(setX.positions[2], 0.2) && close(setX.positions[3], 0.5));
  const ch = pointsOf(
    run(mapAttributeNode, { points: src }, {
      attr_name: "index",
      output_name: "w",
      mode: "set",
      in_lo: 0,
      in_hi: 2,
    })
  );
  check("output to a named channel", !!ch && close(ch.attributes!.w.data[2], 1));
}

// ---------------------------------------------------------------------------
// Point Expression setattr on built-ins (acceptance 7)
// ---------------------------------------------------------------------------

function evalExpr(pts: PointsValue, expression: string): PointsValue | undefined {
  return pointsOf(
    run(pointExpressionNode, { points: pts }, {
      target: "points",
      inputs: [],
      expression,
      on_error: "passthrough",
    }, "pex")
  );
}

{
  const out = evalExpr(bare(3), 'setattr("scale", index + 1)');
  check(
    'setattr("scale", v) writes scale (both lanes)',
    !!out && close(getScaleX(out, 2), 3) && close(getScaleY(out, 2), 3) && out.attributes?.scale === undefined
  );
  const partial = evalExpr(bare(3), 'if (index === 1) setattr("scale", 5)');
  check(
    "rows the expression did not setattr keep the kernel's value",
    !!partial && close(getScaleX(partial, 0), 1) && close(getScaleX(partial, 1), 5) && close(getScaleX(partial, 2), 1)
  );
  const culled = evalExpr(bare(4), 'keep = index !== 0; setattr("rotation", index)');
  check(
    "setattr on a built-in survives culling (compacted by keptMap)",
    !!culled && culled.count === 3 && close(getRotation(culled, 0), 1) && close(getRotation(culled, 2), 3)
  );
  const ch = evalExpr(bare(2), 'setattr("w", index * 2)');
  check("setattr on a channel still lands in attributes", !!ch && ch.attributes?.w.data[1] === 2);
  const ro = evalExpr(bare(2), 'setattr("index", 9); setattr("z", 1)');
  check("setattr on read-only names is ignored (no z minted)", !!ro && ro.z === undefined && ro.count === 2);
  const lane = evalExpr(bare(2), 'setattr("scale.y", 4)');
  check('setattr("scale.y") writes one lane', !!lane && close(getScaleX(lane, 0), 1) && close(getScaleY(lane, 0), 4));
}

// ---------------------------------------------------------------------------
// Propagation — Collect, Copy to Points (acceptance 4)
// ---------------------------------------------------------------------------

{
  const a = withPointAttr(bare(2), "marker", new Float32Array([7, 7]));
  const b = withPointAttr(bare(3), "scale", new Float32Array([2, 2, 2]));
  const out = pointsOf(
    run(collectNode, { a, b }, { mode: "points", slots: ["a", "b"] }, "collect")
  );
  check(
    "Collect points: marker survives, zero-fills the input without it, scale unions",
    !!out && out.count === 5 && out.attributes?.marker.data[1] === 7 && out.attributes.marker.data[3] === 0 &&
      close(getScaleX(out, 0), 1) && close(getScaleX(out, 4), 2) && getGroupIndex(out, 4) === 1
  );
  const s1: SplineValue = { kind: "spline", subpaths: [square({ attrs: { marker: 3, driver: 0.2 }, driver: 0.2 })] };
  const s2: SplineValue = { kind: "spline", subpaths: [square({ groupIndex: 9 })] };
  const sp = splineOf(
    run(collectNode, { a: s1, b: s2 }, { mode: "spline", slots: ["a", "b"] }, "collect2")
  );
  check(
    "Collect splines: attrs + driver survive, groupIndex rewritten",
    !!sp && sp.subpaths[0].attrs?.marker === 3 && sp.subpaths[0].attrs?.driver === 0.2 &&
      sp.subpaths[0].groupIndex === 0 && sp.subpaths[1].groupIndex === 1
  );
}

{
  const targets = withPointAttrs(bare(2), {
    marker: { data: new Float32Array([5, 6]) },
    w: { data: new Float32Array([0.2, 0.9]) },
  });
  const inst: SplineValue = { kind: "spline", subpaths: [square({ attrs: { own: 1 } })] };
  const out = splineOf(
    run(copyToPointsNode, { points: targets, instance: inst }, { mode: "spline", driver_attr: "w" }, "ctp")
  );
  check(
    "Copy to Points spline: driver_attr → attrs.driver + shim field, marker gathered, instance attrs kept",
    !!out && out.subpaths.length === 2 &&
      close(out.subpaths[1].attrs?.driver as number, 0.9) && close(out.subpaths[1].driver ?? -1, 0.9) &&
      out.subpaths[0].attrs?.marker === 5 && out.subpaths[0].attrs?.own === 1
  );
  const noDriver = splineOf(
    run(copyToPointsNode, { points: targets, instance: inst }, { mode: "spline" }, "ctp2")
  );
  check(
    "Copy to Points without driver_attr writes no driver (default 0.5 at read)",
    !!noDriver && noDriver.subpaths[0].attrs?.driver === undefined &&
      close(readSubpathDriver(noDriver.subpaths[0]), 0.5)
  );
}

// ---------------------------------------------------------------------------
// §4.4 — driver read chain (acceptance 5)
// ---------------------------------------------------------------------------

{
  const subs: SplineSubpath[] = [
    square({ attrs: { driver: 0.9 } }),
    square({ driver: 0.3 }),
    square(),
    square({ attrs: { driver: 0.1 }, driver: 0.7 }),
    square({ attrs: { heat: 0.25 }, driver: 0.6 }),
  ];
  const by = makeSubpathDriverFn(subs, { by: "driver", seed: 0, angleDeg: 0 });
  check("by=driver with no attr reads attrs.driver", close(by(0, subs[0]), 0.9));
  check("… falls back to the legacy sub.driver field", close(by(1, subs[1]), 0.3));
  check("… then to 0.5", close(by(2, subs[2]), 0.5));
  check("attrs.driver wins over the legacy field", close(by(3, subs[3]), 0.1));
  const byHeat = makeSubpathDriverFn(subs, { by: "driver", seed: 0, angleDeg: 0, attr: "heat" });
  check("a named attr is read when set", close(byHeat(4, subs[4]), 0.25));
  check("a missing named attr falls back to the legacy field", close(byHeat(1, subs[1]), 0.3));
  // The limit counts ANCHORS (4 per square), so 100 shows every subpath.
  const insp = inspectSocketValue({ kind: "spline", subpaths: subs }, 100) as {
    drivenSubpaths?: number;
    subpaths?: Array<{ driver?: number }>;
  };
  check(
    "get_node_data reports driver from attrs.driver too",
    insp.drivenSubpaths === 4 && close(insp.subpaths?.[0].driver ?? -1, 0.9) &&
      close(insp.subpaths?.[3].driver ?? -1, 0.1) && insp.subpaths?.[2].driver === undefined
  );
}

// ---------------------------------------------------------------------------
// Name-field rule
// ---------------------------------------------------------------------------

{
  const known: AttrNameInfo = {
    known: true,
    names: ["weight"],
    builtins: ["index", "x", "y", "scale.x", "scale.y", "rotation", "group"],
  };
  check("writer: read-only built-in is invalid", isAttrNameInvalid("index", known, false) === true);
  check("writer: writable built-in is valid", isAttrNameInvalid("scale", known, false) === false);
  check(
    "writer with builtins + writable filter: scale ok, index flagged",
    isAttrNameInvalid("scale", known, false, true, isWritablePointAttr) === false &&
      isAttrNameInvalid("index", known, false, true, isWritablePointAttr) === true
  );
  check("plain consumer: any built-in is invalid", isAttrNameInvalid("scale", known, true) === true);
  check("consumer with builtins: built-in valid, missing channel invalid", isAttrNameInvalid("scale", known, true, true) === false && isAttrNameInvalid("nope", known, true, true) === true);
}

// copyPointsWith is what every route ends in — sanity that the lazy view resets.
{
  const src = bare(2);
  const out = copyPointsWith(src, { rotations: new Float32Array([1, 2]) });
  check("copyPointsWith resets the lazy points view", out.points.length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
