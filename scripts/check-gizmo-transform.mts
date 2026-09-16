// Guards the Gizmo node + `transform` socket: identity, compose order,
// apply-to-spline/points, Gizmo emit, Transform replace when wired, Transform
// aux emit (own TRS / wired passthrough / local-pivot bake / drive a second
// Transform), Circle compose-after-generate. Spec: specdocs/082826_gizmo-node.md.
//
//   npx tsx scripts/check-gizmo-transform.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineValue,
  TransformOp,
  TransformValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { pointsFromArray, getRotation, getScaleX } from "../src/engine/points.ts";
import {
  applyTransformInputToSpline,
  applyTransformToPoints,
  applyTransformToSpline,
  asTransform,
  composeOpsToAffine,
  composeTransform,
  IDENTITY_TRANSFORM_VALUE,
  invertAffine,
  opFromParams,
  trsToAffine,
} from "../src/engine/transform-value.ts";
import { gizmoNode } from "../src/nodes/effect/gizmo.ts";
import { transformNode } from "../src/nodes/effect/transform.ts";
import { circleNode } from "../src/nodes/source/circle.ts";
import { lineNode } from "../src/nodes/source/line.ts";
import { pointNode } from "../src/nodes/source/point.ts";

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
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const sub of s.subpaths) {
    for (const a of sub.anchors) {
      sx += a.pos[0];
      sy += a.pos[1];
      n++;
    }
  }
  return n === 0 ? { x: NaN, y: NaN } : { x: sx / n, y: sy / n };
}

const dummyCtx = {} as RenderContext;

const translateOp = (tx: number, ty = 0): TransformOp => ({
  translateX: tx,
  translateY: ty,
  scaleX: 1,
  scaleY: 1,
  rotateDeg: 0,
  pivotX: 0.5,
  pivotY: 0.5,
});

const identityOp: TransformOp = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotateDeg: 0,
  pivotX: 0.5,
  pivotY: 0.5,
};

// ── value math ─────────────────────────────────────────────────────────
check(
  "empty ops is identity",
  IDENTITY_TRANSFORM_VALUE.ops.length === 0
);

{
  const src = squareAt(0.5, 0.5, 0.1);
  const out = applyTransformToSpline(src, IDENTITY_TRANSFORM_VALUE);
  const c = centerOf(out);
  check("identity spline is unchanged", close(c.x, 0.5) && close(c.y, 0.5));
}

{
  const src = squareAt(0.5, 0.5, 0.1);
  const t: TransformValue = { kind: "transform", ops: [translateOp(0.1)] };
  const out = applyTransformToSpline(src, t);
  const c = centerOf(out);
  check(
    "translate 0.1 moves spline center",
    close(c.x, 0.6) && close(c.y, 0.5),
    `got (${c.x}, ${c.y})`
  );
}

{
  const local = translateOp(0.1);
  const parent: TransformValue = { kind: "transform", ops: [translateOp(0.2)] };
  const composed = composeTransform(parent, local);
  check("compose appends local after parent ops", composed.ops.length === 2);
  const src = squareAt(0.5, 0.5, 0.1);
  const out = applyTransformToSpline(src, composed);
  const c = centerOf(out);
  // local first (+0.1) then parent (+0.2) → +0.3
  check(
    "parent ∘ local applies local first",
    close(c.x, 0.8) && close(c.y, 0.5),
    `got (${c.x}, ${c.y})`
  );
}

{
  const composed = composeTransform(
    { kind: "transform", ops: [translateOp(0.2)] },
    identityOp
  );
  check(
    "identity local is dropped on compose",
    composed.ops.length === 1 && close(composed.ops[0].translateX, 0.2)
  );
}

{
  const pts: PointsValue = pointsFromArray([
    { pos: [0.5, 0.5], rotation: 0, scale: [1, 1] },
  ]);
  const t: TransformValue = {
    kind: "transform",
    ops: [
      {
        ...identityOp,
        rotateDeg: 90,
        scaleX: 2,
        scaleY: 2,
      },
    ],
  };
  const out = applyTransformToPoints(pts, t);
  check(
    "points rotation adds",
    close(getRotation(out, 0), Math.PI / 2),
    `got ${getRotation(out, 0)}`
  );
  check(
    "points scale multiplies",
    close(getScaleX(out, 0), 2),
    `got ${getScaleX(out, 0)}`
  );
}

{
  const m = trsToAffine(translateOp(0.1, 0.2));
  check(
    "translate affine is offset",
    close(m.a, 1) && close(m.d, 1) && close(m.tx, 0.1) && close(m.ty, 0.2)
  );
  const inv = invertAffine(m);
  check(
    "inverse translate",
    !!inv && close(inv.tx, -0.1) && close(inv.ty, -0.2)
  );
}

{
  const rot: TransformOp = { ...identityOp, rotateDeg: 90 };
  const m = composeOpsToAffine([rot]);
  // 90° CW in Y-down: (1,0) → (0,1). a=cos=0, b=-sin=-1, c=sin=1, d=cos=0
  // plus pivot 0.5 terms.
  const x = m.a * 0.5 + m.b * 0.5 + m.tx;
  const y = m.c * 0.5 + m.d * 0.5 + m.ty;
  check(
    "90° about canvas center leaves center still",
    close(x, 0.5) && close(y, 0.5),
    `got (${x}, ${y})`
  );
}

check(
  "coerce transform→transform",
  coerceValue(IDENTITY_TRANSFORM_VALUE, "transform", dummyCtx)?.kind ===
    "transform"
);
check(
  "coerce transform→spline refuses",
  coerceValue(IDENTITY_TRANSFORM_VALUE, "spline", dummyCtx) === undefined
);
check(
  "asTransform rejects other kinds",
  asTransform({ kind: "scalar", value: 1 }) === undefined
);

// ── Gizmo node ─────────────────────────────────────────────────────────
{
  const out = gizmoNode.compute({
    inputs: {},
    auxIn: {},
    params: {},
    ctx: dummyCtx,
    nodeId: "g",
  }) as NodeOutput;
  check(
    "default Gizmo emits identity",
    out.primary?.kind === "transform" &&
      (out.primary as TransformValue).ops.length === 0
  );
}

{
  const out = gizmoNode.compute({
    inputs: {},
    auxIn: {},
    params: { translateX: 0.1, translateY: 0 },
    ctx: dummyCtx,
    nodeId: "g",
  }) as NodeOutput;
  const t = out.primary as TransformValue;
  check(
    "Gizmo with translate emits one op",
    t.kind === "transform" &&
      t.ops.length === 1 &&
      close(t.ops[0].translateX, 0.1)
  );
}

{
  const parent: TransformValue = { kind: "transform", ops: [translateOp(0.2)] };
  const out = gizmoNode.compute({
    inputs: { transform: parent },
    auxIn: {},
    params: { translateX: 0.1 },
    ctx: dummyCtx,
    nodeId: "g",
  }) as NodeOutput;
  const t = out.primary as TransformValue;
  check(
    "Gizmo composes parent then local",
    t.ops.length === 2 &&
      close(t.ops[0].translateX, 0.2) &&
      close(t.ops[1].translateX, 0.1)
  );
}

{
  const fromParams = opFromParams({ translateX: 0.3, scaleX: 2 });
  check(
    "opFromParams fills defaults",
    close(fromParams.translateX, 0.3) &&
      close(fromParams.scaleX, 2) &&
      close(fromParams.scaleY, 1) &&
      close(fromParams.pivotX, 0.5)
  );
}

// ── Transform node replace ─────────────────────────────────────────────
{
  const src = squareAt(0.5, 0.5, 0.1);
  const sockets = transformNode.resolveInputs!({}, {
    connectedTypes: { image: "spline", transform: "transform" },
  });
  check(
    "Transform resolveInputs keeps transform socket",
    sockets.some((s) => s.name === "transform" && s.type === "transform")
  );
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const wired: TransformValue = { kind: "transform", ops: [translateOp(0.15)] };
  const out = transformNode.compute({
    inputs: { image: coerced, transform: wired },
    auxIn: {},
    params: { translateX: 0.9 }, // ignored when wired
    ctx: dummyCtx,
    nodeId: "xf",
  }) as NodeOutput;
  check(
    "Transform wired path still emits spline",
    out.primary?.kind === "spline"
  );
  const c = centerOf(out.primary as SplineValue);
  check(
    "Transform wired transform replaces own translate",
    close(c.x, 0.65) && close(c.y, 0.5),
    `got (${c.x}, ${c.y}) — own translateX 0.9 must not apply`
  );
}

// ── Transform aux emit ─────────────────────────────────────────────────
{
  check(
    "Transform declares transform aux",
    transformNode.auxOutputs.some(
      (s) => s.name === "transform" && s.type === "transform"
    )
  );
}

{
  const src = squareAt(0.5, 0.5, 0.1);
  const sockets = transformNode.resolveInputs!({}, {
    connectedTypes: { image: "spline" },
  });
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const out = transformNode.compute({
    inputs: { image: coerced },
    auxIn: {},
    params: { translateX: 0.12, scaleX: 2, scaleY: 2 },
    ctx: dummyCtx,
    nodeId: "xf",
  }) as NodeOutput;
  const t = out.aux?.transform as TransformValue | undefined;
  check(
    "Transform aux emits own TRS as one op",
    t?.kind === "transform" &&
      t.ops.length === 1 &&
      close(t.ops[0].translateX, 0.12) &&
      close(t.ops[0].scaleX, 2) &&
      close(t.ops[0].scaleY, 2),
    t ? `ops=${t.ops.length} tx=${t.ops[0]?.translateX}` : "missing aux"
  );
}

{
  const src = squareAt(0.5, 0.5, 0.1);
  const sockets = transformNode.resolveInputs!({}, {
    connectedTypes: { image: "spline" },
  });
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const out = transformNode.compute({
    inputs: { image: coerced },
    auxIn: {},
    params: {},
    ctx: dummyCtx,
    nodeId: "xf",
  }) as NodeOutput;
  const t = out.aux?.transform as TransformValue | undefined;
  check(
    "identity Transform aux drops the op",
    t?.kind === "transform" && t.ops.length === 0,
    t ? `ops=${t.ops.length}` : "missing aux"
  );
}

{
  const src = squareAt(0.5, 0.5, 0.1);
  const sockets = transformNode.resolveInputs!({}, {
    connectedTypes: { image: "spline", transform: "transform" },
  });
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const wired: TransformValue = { kind: "transform", ops: [translateOp(0.15)] };
  const out = transformNode.compute({
    inputs: { image: coerced, transform: wired },
    auxIn: {},
    params: { translateX: 0.9 },
    ctx: dummyCtx,
    nodeId: "xf",
  }) as NodeOutput;
  const t = out.aux?.transform as TransformValue | undefined;
  check(
    "wired Transform aux passes the incoming value through",
    t?.kind === "transform" &&
      t.ops.length === 1 &&
      close(t.ops[0].translateX, 0.15),
    t ? `ops=${t.ops.length} tx=${t.ops[0]?.translateX}` : "missing aux"
  );
}

{
  // Square at (0.3,0.4) r=0.1 → bbox (0.2,0.3)–(0.4,0.5). Source pivot
  // (0.5,0.5) bakes to the shape center (0.3,0.4).
  const src = squareAt(0.3, 0.4, 0.1);
  const sockets = transformNode.resolveInputs!(
    { space: "local" },
    { connectedTypes: { image: "spline" } }
  );
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const out = transformNode.compute({
    inputs: { image: coerced },
    auxIn: {},
    params: { space: "local", scaleX: 2, scaleY: 2, pivotX: 0.5, pivotY: 0.5 },
    ctx: dummyCtx,
    nodeId: "xf",
  }) as NodeOutput;
  const t = out.aux?.transform as TransformValue | undefined;
  check(
    "local-space Transform aux bakes pivot to canvas coords",
    t?.kind === "transform" &&
      t.ops.length === 1 &&
      close(t.ops[0].pivotX, 0.3) &&
      close(t.ops[0].pivotY, 0.4) &&
      close(t.ops[0].scaleX, 2),
    t
      ? `pivot=(${t.ops[0]?.pivotX}, ${t.ops[0]?.pivotY})`
      : "missing aux"
  );
}

{
  const src = squareAt(0.5, 0.5, 0.1);
  const sockets = transformNode.resolveInputs!({}, {
    connectedTypes: { image: "spline" },
  });
  const sock = sockets.find((s) => s.name === "image");
  const coerced = coerceValue(src, sock?.type ?? "spline", dummyCtx);
  const driver = transformNode.compute({
    inputs: { image: coerced },
    auxIn: {},
    params: { translateX: 0.2 },
    ctx: dummyCtx,
    nodeId: "a",
  }) as NodeOutput;
  const driven = transformNode.compute({
    inputs: { image: coerced, transform: driver.aux?.transform },
    auxIn: {},
    params: { translateX: 0.9 },
    ctx: dummyCtx,
    nodeId: "b",
  }) as NodeOutput;
  const c = centerOf(driven.primary as SplineValue);
  check(
    "Transform aux can drive a second Transform (replace own TRS)",
    close(c.x, 0.7) && close(c.y, 0.5),
    `got (${c.x}, ${c.y}) — driven node must ignore its own translateX 0.9`
  );
}

// ── Circle compose-after-generate ──────────────────────────────────────
{
  check(
    "Circle declares transform input",
    circleNode.inputs.some((s) => s.name === "transform" && s.type === "transform")
  );
  const generated: SplineValue = squareAt(0.3, 0.4, 0.1);
  const applied = applyTransformInputToSpline(
    generated,
    IDENTITY_TRANSFORM_VALUE
  );
  const c = centerOf(applied);
  check(
    "identity transform keeps authored center",
    close(c.x, 0.3) && close(c.y, 0.4),
    `got (${c.x}, ${c.y})`
  );
  const moved = applyTransformInputToSpline(generated, {
    kind: "transform",
    ops: [translateOp(0.1)],
  });
  const c2 = centerOf(moved);
  check(
    "Circle-style compose applies after generate",
    close(c2.x, 0.4) && close(c2.y, 0.4),
    `got (${c2.x}, ${c2.y})`
  );
}

// ── Line primitive ─────────────────────────────────────────────────────
{
  check(
    "Line declares transform input",
    lineNode.inputs.some((s) => s.name === "transform" && s.type === "transform")
  );
  const lineCtx = { width: 1920, height: 1080, state: {} } as RenderContext;
  const out = lineNode.compute({
    inputs: {},
    auxIn: {},
    params: {
      startX: 0.1,
      startY: 0.2,
      endX: 0.8,
      endY: 0.9,
      stroke_enabled: false,
      fill_enabled: false,
    },
    ctx: lineCtx,
    nodeId: "ln",
  }) as NodeOutput;
  check("Line unwired emits spline", out.primary?.kind === "spline");
  const sub = (out.primary as SplineValue).subpaths[0];
  check(
    "Line is one open 2-anchor subpath",
    !!sub && sub.closed === false && sub.anchors.length === 2
  );
  const a = sub?.anchors[0]?.pos;
  const b = sub?.anchors[1]?.pos;
  check(
    "Line endpoints match params",
    !!a &&
      !!b &&
      close(a[0], 0.1) &&
      close(a[1], 0.2) &&
      close(b[0], 0.8) &&
      close(b[1], 0.9),
    a && b ? `got (${a[0]}, ${a[1]}) → (${b[0]}, ${b[1]})` : "missing anchors"
  );
  const moved = lineNode.compute({
    inputs: {
      transform: { kind: "transform", ops: [translateOp(0.05)] },
    },
    auxIn: {},
    params: {
      startX: 0.1,
      startY: 0.2,
      endX: 0.8,
      endY: 0.9,
      stroke_enabled: false,
      fill_enabled: false,
    },
    ctx: lineCtx,
    nodeId: "ln2",
  }) as NodeOutput;
  const msub = (moved.primary as SplineValue).subpaths[0];
  const ma = msub?.anchors[0]?.pos;
  const mb = msub?.anchors[1]?.pos;
  check(
    "Line composes transform after generate",
    !!ma &&
      !!mb &&
      close(ma[0], 0.15) &&
      close(ma[1], 0.2) &&
      close(mb[0], 0.85) &&
      close(mb[1], 0.9),
    ma && mb
      ? `got (${ma[0]}, ${ma[1]}) → (${mb[0]}, ${mb[1]})`
      : "missing anchors"
  );
}

// ── Point ──────────────────────────────────────────────────────────────
{
  const out = pointNode.compute({
    inputs: {},
    auxIn: {},
    params: { x: 0.4, y: 0.4 },
    ctx: dummyCtx,
    nodeId: "p",
  }) as NodeOutput;
  check("Point unwired emits points", out.primary?.kind === "points");
  const pts = out.primary as PointsValue;
  check(
    "Point unwired uses x/y",
    close(pts.positions[0], 0.4) && close(pts.positions[1], 0.4)
  );
}

{
  const wired: TransformValue = { kind: "transform", ops: [translateOp(0.1)] };
  const out = pointNode.compute({
    inputs: { transform: wired },
    auxIn: {},
    params: { x: 0.4, y: 0.4 },
    ctx: dummyCtx,
    nodeId: "p",
  }) as NodeOutput;
  const pts = out.primary as PointsValue;
  check(
    "Point composes transform after x/y",
    close(pts.positions[0], 0.5) && close(pts.positions[1], 0.4),
    `got (${pts.positions[0]}, ${pts.positions[1]})`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
