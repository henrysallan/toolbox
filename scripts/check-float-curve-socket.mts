// Guards the `float_curve` socket type (specdocs/091926_float-curve-socket.md):
//   - plumbing: paramSocketType maps float_curve (so every float_curve param
//     is exposable), coercible is identity-only, the off-clip and group-shell
//     defaults are the identity ramp, Switch and Time Offset carry it, the
//     wire has a colour,
//   - the Float Curve node's `curve` aux is the sanitized authored curve,
//   - the Expression node's out_type=curve sweeps `u` over CURVE_SAMPLES+1
//     points, clamps y to [0,1], binds input variables, and emits the
//     identity ramp on a broken source; `u` is 0 in the value modes,
//   - validateGraph accepts a curve wire on an exposed float_curve param and
//     rejects a scalar there,
//   - a real evaluateGraph run drives Scene Time's custom easing from both
//     producers through the exposed-param path (coerceValue identity →
//     socketToParamRaw → the def's compute).
//
//   npx tsx scripts/check-float-curve-socket.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

// Minimal DOM stubs — registering the node set pulls the whole engine in.
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};
g.WebGL2RenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
import type { EvalCache } from "@/engine/evaluator";
import type { ValEdge, ValNode } from "@/engine/graph-validation";
import type { CurvePoint } from "@/engine/float-curve";
const { coercible, paramSocketType } = await import("@/engine/graph-helpers");
const { validateGraph } = await import("@/engine/graph-validation");
const { emptyClipOutput } = await import("@/engine/clips");
const { socketValueFromGroupDefault } = await import("@/engine/groups");
const { TIME_OFFSET_CARRIED_TYPES } = await import("@/engine/time-offset");
const { SOCKET_PALETTE } = await import("@/components/effects/socketColor");
const { defaultFloatCurve, sampleFloatCurve } = await import("@/engine/float-curve");
const { CUSTOM_EASING } = await import("@/nodes/source/scene-time");
const { CURVE_SAMPLES } = await import("@/nodes/effect/expression");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const smoothstep = (x: number) => x * x * (3 - 2 * x);

const FPS = 60;
const TPF = 1000;
const ctx = {
  gl: {},
  width: 8,
  height: 8,
  time: 0,
  frame: 0,
  tick: 0,
  ticksPerFrame: TPF,
  fps: FPS,
  playing: false,
  offline: false,
  cursor: { x: 0, y: 0, active: false },
  state: {},
  allocImage: () => ({ kind: "image", texture: {}, width: 8, height: 8 }),
  allocMask: () => ({ kind: "mask", texture: {}, width: 8, height: 8 }),
  allocUv: () => ({ kind: "uv", texture: {}, width: 8, height: 8 }),
  releaseTexture: () => {},
  drawFullscreen: () => {},
  clearTarget: () => {},
  getShader: () => ({}),
} as any;
function setTime(seconds: number) {
  ctx.time = seconds;
  ctx.frame = Math.floor(seconds * FPS);
  ctx.tick = seconds * FPS * TPF;
}

// Every def default, then overrides — what a fresh node's params record holds.
function paramsOf(type: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = getNodeDef(type);
  if (!def) throw new Error(`unknown node type ${type}`);
  const p: Record<string, unknown> = {};
  for (const d of def.params) p[d.name] = d.default;
  return { ...p, ...over };
}
function computeOf(
  type: string,
  nodeId: string,
  params: Record<string, unknown>,
  inputs: Record<string, unknown> = {}
) {
  const def = getNodeDef(type)!;
  const out = def.compute({
    inputs,
    auxIn: {},
    params,
    ctx,
    nodeId,
    consumedOutputs: new Set(["primary", ...def.auxOutputs.map((a) => `aux:${a.name}`)]),
  } as any);
  if (!out) throw new Error(`${type} returned nothing`);
  return out;
}

// A dip: identity ramp with the midpoint pulled down to 0.2 (authored
// unsorted, so sanitize's sort is observable).
const DIP_RAW: CurvePoint[] = [
  { id: "hi", x: 1, y: 1 },
  { id: "lo", x: 0, y: 0 },
  { id: "mid", x: 0.5, y: 0.2 },
];

// ---------------------------------------------------------------------
// 1. Plumbing
// ---------------------------------------------------------------------
{
  check("paramSocketType maps float_curve → float_curve", paramSocketType("float_curve") === "float_curve");
  check(
    "Scene Time's easing_curve is therefore exposable",
    paramSocketType(getNodeDef("scene-time")!.params.find((p) => p.name === "easing_curve")!.type) === "float_curve"
  );
  check(
    "coercible: identity only",
    coercible("float_curve", "float_curve") &&
      !coercible("scalar", "float_curve") &&
      !coercible("float_curve", "scalar") &&
      !coercible("color_ramp", "float_curve")
  );
  const off = emptyClipOutput(ctx, "float_curve").primary;
  check(
    "off-clip value is the identity ramp",
    !!off &&
      off.kind === "float_curve" &&
      off.points.length === 2 &&
      off.points[0].x === 0 &&
      off.points[0].y === 0 &&
      off.points[1].x === 1 &&
      off.points[1].y === 1
  );
  const shell = socketValueFromGroupDefault(DIP_RAW, "float_curve");
  check(
    "group-shell default wraps a stored array",
    !!shell && shell.kind === "float_curve" && shell.points === DIP_RAW
  );
  check("group-shell default rejects a non-array", socketValueFromGroupDefault(3, "float_curve") === undefined);
  check(
    "wire colour exists (dark + light)",
    /^#[0-9a-f]{6}$/i.test(SOCKET_PALETTE.float_curve?.dark ?? "") &&
      /^#[0-9a-f]{6}$/i.test(SOCKET_PALETTE.float_curve?.light ?? "")
  );
  const switchTypes = (getNodeDef("switch")!.params.find((p) => p.name === "type")!.options ?? []) as string[];
  check(
    "Switch can carry float_curve (and color_ramp)",
    switchTypes.includes("float_curve") && switchTypes.includes("color_ramp")
  );
  check("Time Offset carries float_curve", TIME_OFFSET_CARRIED_TYPES.includes("float_curve"));
}

// ---------------------------------------------------------------------
// 2. Float Curve node: `curve` aux
// ---------------------------------------------------------------------
{
  const def = getNodeDef("float-curve")!;
  check(
    "def declares aux curve:float_curve",
    def.auxOutputs.some((a) => a.name === "curve" && a.type === "float_curve")
  );
  const out = computeOf("float-curve", "fc", paramsOf("float-curve", { curve: DIP_RAW, value: 0.5 }));
  const aux = out.aux?.curve;
  check("primary is the sampled scalar", out.primary?.kind === "scalar" && close(out.primary.value, 0.2));
  check(
    "aux curve is a sanitized (sorted) float_curve",
    !!aux &&
      aux.kind === "float_curve" &&
      aux.points.map((p) => p.id).join(",") === "lo,mid,hi" &&
      close(sampleFloatCurve(aux.points, 0.5), 0.2)
  );
}

// ---------------------------------------------------------------------
// 3. Expression node: out_type=curve
// ---------------------------------------------------------------------
{
  const def = getNodeDef("expression")!;
  check(
    "resolvePrimaryOutput: curve → float_curve, others unchanged",
    def.resolvePrimaryOutput!({ out_type: "curve" }) === "float_curve" &&
      def.resolvePrimaryOutput!({ out_type: "vec2" }) === "vec2" &&
      def.resolvePrimaryOutput!({}) === "scalar"
  );
  check("out_type offers curve", ((def.params.find((p) => p.name === "out_type")!.options ?? []) as string[]).includes("curve"));

  const curveOf = (
    nodeId: string,
    expression: string,
    over: Record<string, unknown> = {},
    inputs: Record<string, unknown> = {}
  ): CurvePoint[] => {
    const out = computeOf("expression", nodeId, paramsOf("expression", { expression, out_type: "curve", ...over }), inputs);
    if (out.primary?.kind !== "float_curve") throw new Error(`expected float_curve, got ${out.primary?.kind}`);
    return out.primary.points;
  };

  const ss = curveOf("ex-ss", "u * u * (3 - 2 * u)");
  check("curve has CURVE_SAMPLES+1 points", ss.length === CURVE_SAMPLES + 1);
  check(
    "x is the sample grid i/CURVE_SAMPLES with stable ids",
    ss.every((p, i) => p.x === i / CURVE_SAMPLES && p.id === `cu-${i}`)
  );
  check("midpoint of smoothstep is 0.5", close(ss[CURVE_SAMPLES / 2].y, 0.5));
  let maxErr = 0;
  for (let s = 0; s <= 1; s += 0.01) maxErr = Math.max(maxErr, Math.abs(sampleFloatCurve(ss, s) - smoothstep(s)));
  check("sampled smoothstep tracks the analytic curve (max err < 1e-3)", maxErr < 1e-3, `max err ${maxErr}`);
  console.log(`     (smoothstep max reconstruction error: ${maxErr.toExponential(2)})`);

  const hard = curveOf("ex-hard", "u < 0.5 ? 0 : 1");
  check(
    "a hard step lands inside one interval",
    hard[CURVE_SAMPLES / 2 - 1].y === 0 &&
      hard[CURVE_SAMPLES / 2].y === 1 &&
      sampleFloatCurve(hard, 0.4) === 0 &&
      sampleFloatCurve(hard, 0.6) === 1
  );

  const clamped = curveOf("ex-clamp", "2 * u");
  check(
    "y is clamped to the unit square",
    close(clamped[CURVE_SAMPLES / 4].y, 0.5) && clamped[(CURVE_SAMPLES * 3) / 4].y === 1
  );

  const inputs = [{ id: "ein-k", name: "k", default: 2 }];
  const powDefault = curveOf("ex-pow", "pow(u, k)", { inputs });
  check("input variables bind at their default", close(powDefault[CURVE_SAMPLES / 2].y, 0.25));
  const powWired = curveOf("ex-pow", "pow(u, k)", { inputs }, { "in:ein-k": { kind: "scalar", value: 3 } });
  check("input variables bind to a wired scalar", close(powWired[CURVE_SAMPLES / 2].y, 0.125));

  const isIdentity = (pts: CurvePoint[]) =>
    pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1;
  const origWarn = console.warn;
  console.warn = () => {}; // the node warns once per compile error
  try {
    check("a compile error emits the identity ramp", isIdentity(curveOf("ex-bad", "foo(")));
    check("a runtime error emits the identity ramp", isIdentity(curveOf("ex-throw", "nope(u)")));
    check("an empty source emits the identity ramp", isIdentity(curveOf("ex-empty", "")));
  } finally {
    console.warn = origWarn;
  }

  const scalar = computeOf("expression", "ex-scalar", paramsOf("expression", { expression: "u + x" }));
  check("u is 0 in the value modes", scalar.primary?.kind === "scalar" && scalar.primary.value === 1);
  const legacy = computeOf("expression", "ex-legacy", paramsOf("expression", { expression: "x * 2" }));
  check("scalar mode unchanged", legacy.primary?.kind === "scalar" && legacy.primary.value === 2);
}

// ---------------------------------------------------------------------
// 4. validateGraph: the wire is legal where it should be
// ---------------------------------------------------------------------
{
  const N = (id: string, defType: string, params: Record<string, unknown> = {}): ValNode => ({ id, defType, params });
  const E = (source: string, sourceHandle: string, target: string, targetHandle: string): ValEdge => ({
    id: `${source}->${target}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  });
  const st = () => N("st", "scene-time", paramsOf("scene-time", { mode: "stepped", easing: CUSTOM_EASING }));
  const errs = (nodes: ValNode[], edges: ValEdge[]) =>
    validateGraph(nodes, edges)
      .issues.filter((i) => i.severity === "error")
      .map((i) => i.code);

  check(
    "Float Curve aux:curve → Scene Time in:param:easing_curve is valid",
    errs([N("fc", "float-curve", paramsOf("float-curve")), st()], [E("fc", "out:aux:curve", "st", "in:param:easing_curve")]).length === 0
  );
  check(
    "Expression (curve) → Scene Time in:param:easing_curve is valid",
    errs(
      [N("ex", "expression", paramsOf("expression", { out_type: "curve" })), st()],
      [E("ex", "out:primary", "st", "in:param:easing_curve")]
    ).length === 0
  );
  check(
    "Expression (scalar) → in:param:easing_curve is a type mismatch",
    errs(
      [N("ex", "expression", paramsOf("expression", { out_type: "scalar" })), st()],
      [E("ex", "out:primary", "st", "in:param:easing_curve")]
    ).includes("EDGE_TYPE_MISMATCH")
  );
  check(
    "a scalar → Float Curve in:param:curve is a type mismatch",
    errs(
      [N("t", "scene-time", paramsOf("scene-time")), N("fc", "float-curve", paramsOf("float-curve"))],
      [E("t", "out:primary", "fc", "in:param:curve")]
    ).includes("EDGE_TYPE_MISMATCH")
  );
}

// ---------------------------------------------------------------------
// 5. evaluateGraph: the exposed-param path end to end
// ---------------------------------------------------------------------
{
  const node = (id: string, type: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ id, type, params, ...extra }) as any;
  const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
    ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }) as any;
  const sceneTime = () =>
    node(
      "st",
      "scene-time",
      paramsOf("scene-time", {
        mode: "stepped",
        unit: "seconds",
        step_size: 1,
        step_seconds: 1,
        easing: CUSTOM_EASING,
        offset: 0,
        ease_intensity: 1,
      }),
      { exposedParams: ["easing_curve"] }
    );
  const valueAt = (nodes: any[], edges: any[], seconds: number): number | undefined => {
    setTime(seconds);
    const r = evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, "st");
    const v = r.outputs.get("st")?.primary;
    return v?.kind === "scalar" ? v.value : undefined;
  };

  const fc = node("fc", "float-curve", paramsOf("float-curve", { curve: DIP_RAW }));
  check(
    "exposed but unwired: the stored identity ramp reads as linear",
    close(valueAt([fc, sceneTime()], [], 0.5) ?? NaN, 0.5)
  );
  check(
    "Float Curve aux:curve drives Scene Time's custom easing",
    close(valueAt([fc, sceneTime()], [edge("fc", "out:aux:curve", "st", "in:param:easing_curve")], 0.5) ?? NaN, 0.2)
  );
  check(
    "…and the wired curve shapes every step",
    close(valueAt([fc, sceneTime()], [edge("fc", "out:aux:curve", "st", "in:param:easing_curve")], 2.5) ?? NaN, 2.2)
  );

  const ex = node("ex", "expression", paramsOf("expression", { expression: "u * u", out_type: "curve" }));
  check(
    "Expression (curve) drives Scene Time's custom easing",
    close(valueAt([ex, sceneTime()], [edge("ex", "out:primary", "st", "in:param:easing_curve")], 0.5) ?? NaN, 0.25)
  );
}

if (failures > 0) {
  console.error(`\n${failures} float-curve-socket check(s) failed`);
  process.exit(1);
}
console.log("\nfloat-curve-socket checks passed");
