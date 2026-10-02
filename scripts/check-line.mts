// Guards Line's start/end vec2 sockets and its bezier mode, compute and
// viewport gizmo together:
//
//   - a wired socket (through coerceValue, as the evaluator delivers it)
//     replaces that endpoint's params; a scalar lands on both axes; an
//     unusable value falls back to the params
//   - mode=straight ignores the handle params; mode=bezier emits them as
//     offsets RELATIVE to their (possibly wired) endpoint, a 0,0 handle is
//     left off, and a pre-bezier save gets the def defaults
//   - the gizmo's dots sit exactly where the rasterizer draws the anchors
//     and control points (buildPath2D's aspectCorrectY), drags write the
//     params back (handles as relative offsets), and a wired endpoint is
//     pinned + locked with its handles still live — or left out, handles and
//     all, when there is nothing cached to read
//   - readWiredInputs reads the right producer output per edge, and wiring
//     start / end never hides the gizmo (only transform does)
//
// The overlay component itself (PrimitivePointHandles: the cubic connector,
// stems, locked ring) is a live-app question.
//
//   npx tsx scripts/check-line.mts

import type {
  NodeOutput,
  RenderContext,
  SocketValue,
  SplineAnchor,
  SplineValue,
} from "../src/engine/types.ts";
import type { EvalCache } from "../src/engine/evaluator.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { aspectCorrectY } from "../src/engine/aspect.ts";
import { lineNode } from "../src/nodes/source/line.ts";
import {
  PRIMITIVE_GIZMO_ADAPTERS,
  readWiredInputs,
  type PrimitiveGizmoEnv,
  type PrimitiveHandlePoint,
} from "../src/components/effects/PrimitiveGizmo.tsx";
import { liveGizmoWiringBlocker } from "../src/lib/live-gizmo.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const xyClose = (
  a: readonly number[] | undefined,
  b: readonly number[],
  eps = 1e-9
) => !!a && close(a[0], b[0], eps) && close(a[1], b[1], eps);
const fmt = (a: readonly number[] | undefined) =>
  a ? `(${a[0]}, ${a[1]})` : "missing";

const W = 1920;
const H = 1080;
const ASPECT = W / H;

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: W,
    height: H,
  } as unknown as RenderContext;
}

// Nothing rasterizes, so compute stays pure. Applied over every param set
// (the def defaults turn the stroke on).
const OFF = { stroke_enabled: false, fill_enabled: false };

const vec2 = (x: number, y: number): SocketValue => ({ kind: "vec2", value: [x, y] });
const scalar = (v: number): SocketValue => ({ kind: "scalar", value: v });

function evalLine(
  inputs: Record<string, SocketValue | undefined>,
  params: Record<string, unknown> = {}
): SplineAnchor[] {
  const ctx = makeCtx();
  // The evaluator coerces every wired value to its socket's type first.
  const coerced: Record<string, SocketValue | undefined> = {};
  for (const [name, value] of Object.entries(inputs)) {
    const sock = lineNode.inputs.find((s) => s.name === name);
    if (!sock) throw new Error(`Line has no "${name}" socket`);
    coerced[name] = coerceValue(value, sock.type, ctx);
  }
  const out = lineNode.compute({
    inputs: coerced,
    auxIn: {},
    params: { ...params, ...OFF },
    ctx,
    nodeId: "line",
  }) as NodeOutput;
  const spline = out.primary as SplineValue | undefined;
  if (spline?.kind !== "spline") throw new Error("Line did not emit a spline");
  return spline.subpaths[0]?.anchors ?? [];
}

// A freshly created node: every param at its def default.
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  lineNode.params.map((p) => [p.name, p.default])
);
const HANDLE_PARAMS = [
  "startInX",
  "startInY",
  "startOutX",
  "startOutY",
  "endInX",
  "endInY",
  "endOutX",
  "endOutY",
];
const paramDef = (name: string) => lineNode.params.find((p) => p.name === name);

// ── Sockets ──────────────────────────────────────────────────────

check(
  "declares optional start/end vec2 sockets",
  ["start", "end"].every((name) =>
    lineNode.inputs.some(
      (s) => s.name === name && s.type === "vec2" && !s.required
    )
  )
);

{
  const a = evalLine({}, DEFAULTS);
  check(
    "unwired default: (0.25, 0.5) → (0.75, 0.5), no handles",
    a.length === 2 &&
      xyClose(a[0].pos, [0.25, 0.5]) &&
      xyClose(a[1].pos, [0.75, 0.5]) &&
      a.every((x) => !x.inHandle && !x.outHandle),
    `${fmt(a[0]?.pos)} → ${fmt(a[1]?.pos)}`
  );
}

{
  const a = evalLine({ start: vec2(0.1, 0.9) }, { ...DEFAULTS, startX: 0.3, startY: 0.3 });
  check(
    "start socket overrides startX/startY; end keeps its params",
    xyClose(a[0]?.pos, [0.1, 0.9]) && xyClose(a[1]?.pos, [0.75, 0.5]),
    `${fmt(a[0]?.pos)} → ${fmt(a[1]?.pos)}`
  );
}

{
  const a = evalLine({ end: vec2(0.6, 0.2) }, DEFAULTS);
  check(
    "end socket overrides endX/endY; start keeps its params",
    xyClose(a[0]?.pos, [0.25, 0.5]) && xyClose(a[1]?.pos, [0.6, 0.2]),
    `${fmt(a[0]?.pos)} → ${fmt(a[1]?.pos)}`
  );
}

{
  const a = evalLine({ start: scalar(0.4) }, DEFAULTS);
  check(
    "a scalar wired into start lands on both axes",
    xyClose(a[0]?.pos, [0.4, 0.4]),
    fmt(a[0]?.pos)
  );
}

{
  const a = evalLine({ start: vec2(Number.NaN, 0.5) }, { ...DEFAULTS, startX: 0.3, startY: 0.35 });
  check(
    "a non-finite wired vec2 falls back to the params",
    xyClose(a[0]?.pos, [0.3, 0.35]),
    fmt(a[0]?.pos)
  );
}

// ── Modes ────────────────────────────────────────────────────────

{
  const a = evalLine({}, { ...DEFAULTS, startOutX: 0.2, startOutY: -0.3 });
  check(
    "mode=straight ignores the handle params",
    a.every((x) => !x.inHandle && !x.outHandle)
  );
}

{
  const a = evalLine({}, { ...DEFAULTS, mode: "bezier" });
  const h = 0.1667;
  check(
    "mode=bezier defaults: in/out handles ±0.1667 along x on both ends",
    xyClose(a[0]?.inHandle, [-h, 0]) &&
      xyClose(a[0]?.outHandle, [h, 0]) &&
      xyClose(a[1]?.inHandle, [-h, 0]) &&
      xyClose(a[1]?.outHandle, [h, 0]),
    `start in ${fmt(a[0]?.inHandle)} out ${fmt(a[0]?.outHandle)}`
  );
  check(
    "the default line stays straight in bezier mode (control points on y = 0.5)",
    [a[0].pos[1] + (a[0].outHandle?.[1] ?? 0), a[1].pos[1] + (a[1].inHandle?.[1] ?? 0)].every(
      (y) => close(y, 0.5)
    )
  );
  // A save from before bezier mode has no handle params at all.
  const old = evalLine({}, { startX: 0.25, startY: 0.5, endX: 0.75, endY: 0.5, mode: "bezier" });
  check(
    "a save without handle params gets the def defaults",
    JSON.stringify(old) === JSON.stringify(a),
    JSON.stringify(old)
  );
}

{
  const p = {
    ...DEFAULTS,
    mode: "bezier",
    startInX: -0.05,
    startInY: 0.1,
    startOutX: 0.1,
    startOutY: -0.2,
    endInX: -0.15,
    endInY: -0.25,
    endOutX: 0.02,
    endOutY: 0.03,
  };
  const a = evalLine({}, p);
  check(
    "mode=bezier emits each handle as its offset, relative to the anchor",
    xyClose(a[0]?.inHandle, [-0.05, 0.1]) &&
      xyClose(a[0]?.outHandle, [0.1, -0.2]) &&
      xyClose(a[1]?.inHandle, [-0.15, -0.25]) &&
      xyClose(a[1]?.outHandle, [0.02, 0.03])
  );
  const w = evalLine({ start: vec2(0.1, 0.8) }, p);
  check(
    "handles ride a wired endpoint unchanged (still relative)",
    xyClose(w[0]?.pos, [0.1, 0.8]) &&
      xyClose(w[0]?.inHandle, [-0.05, 0.1]) &&
      xyClose(w[0]?.outHandle, [0.1, -0.2])
  );
}

{
  const a = evalLine({}, { ...DEFAULTS, mode: "bezier", startOutX: 0, startOutY: 0 });
  check(
    "a 0,0 handle is left off the anchor",
    !!a[0] && !("outHandle" in a[0]) && !!a[0].inHandle
  );
  const zeros = Object.fromEntries(HANDLE_PARAMS.map((n) => [n, 0]));
  check(
    "bezier with every handle at 0,0 emits exactly the straight line",
    JSON.stringify(evalLine({}, { ...DEFAULTS, mode: "bezier", ...zeros })) ===
      JSON.stringify(evalLine({}, DEFAULTS))
  );
}

{
  // A symmetric arch: its half-length point is the apex at x = 0.5.
  const a = evalLine({}, {
    ...DEFAULTS,
    mode: "bezier",
    startOutX: 0,
    startOutY: -0.3,
    endInX: 0,
    endInY: -0.3,
    trim_end: 0.5,
  });
  const tip = a[a.length - 1]?.pos;
  check(
    "trim follows the bezier curve, not the chord",
    !!tip && close(tip[0], 0.5, 5e-3) && tip[1] < 0.4,
    fmt(tip)
  );
}

// ── Param panel rows ─────────────────────────────────────────────

{
  const startX = paramDef("startX");
  const endY = paramDef("endY");
  check(
    "startX hides while start is wired, shows otherwise (and without meta)",
    startX?.visibleIf?.(DEFAULTS, { wired: { start: true } }) === false &&
      startX?.visibleIf?.(DEFAULTS, { wired: { end: true } }) === true &&
      startX?.visibleIf?.(DEFAULTS) === true
  );
  check(
    "endY hides while end is wired",
    endY?.visibleIf?.(DEFAULTS, { wired: { end: true } }) === false &&
      endY?.visibleIf?.(DEFAULTS, { wired: { start: true } }) === true
  );
  check(
    "handle rows show only in bezier mode",
    HANDLE_PARAMS.every((n) => {
      const d = paramDef(n);
      return (
        d?.visibleIf?.({ ...DEFAULTS, mode: "bezier" }) === true &&
        d?.visibleIf?.(DEFAULTS) === false
      );
    })
  );
}

// ── Gizmo adapter ────────────────────────────────────────────────

const adapter = PRIMITIVE_GIZMO_ADAPTERS.line;
const pointsApi = adapter?.points;
if (!pointsApi) throw new Error("Line has no points gizmo adapter");

function gizmo(
  params: Record<string, unknown>,
  wired?: Record<string, SocketValue | undefined>
): { pts: PrimitiveHandlePoint[]; env: PrimitiveGizmoEnv } {
  const env: PrimitiveGizmoEnv = {
    canvasWidth: W,
    canvasHeight: H,
    getRaw: (name) => params[name],
    wired,
  };
  const get = (name: string, fallback: number) => {
    const v = params[name];
    return typeof v === "number" ? v : fallback;
  };
  return { pts: pointsApi!.read(get, env), env };
}

// Where the rasterizer draws a spline point (buildPath2D), in the gizmo's
// normalized screen space.
const onScreen = (p: readonly number[]): [number, number] => [
  p[0],
  aspectCorrectY(p[1], ASPECT),
];

// Every gizmo dot must sit on the control point compute emitted for it.
function gizmoMatchesCompute(
  label: string,
  params: Record<string, unknown>,
  wired: Record<string, SocketValue | undefined> = {}
) {
  const { pts } = gizmo(params, Object.keys(wired).length ? wired : undefined);
  const anchors = evalLine(wired, params);
  const expected = new Map<string, [number, number]>();
  ["start", "end"].forEach((key, i) => {
    const a = anchors[i];
    if (!a) return;
    expected.set(key, onScreen(a.pos));
    if (a.inHandle) {
      expected.set(`${key}In`, onScreen([a.pos[0] + a.inHandle[0], a.pos[1] + a.inHandle[1]]));
    }
    if (a.outHandle) {
      expected.set(`${key}Out`, onScreen([a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]]));
    }
  });
  const got = new Map(pts.map((p) => [p.key ?? "?", [p.x, p.y] as [number, number]]));
  const same =
    got.size === expected.size &&
    [...expected].every(([k, v]) => xyClose(got.get(k), v, 1e-9));
  check(
    `gizmo dots sit on compute's points — ${label}`,
    same,
    `gizmo ${JSON.stringify([...got])} vs compute ${JSON.stringify([...expected])}`
  );
}

gizmoMatchesCompute("straight, off-center", { ...DEFAULTS, startY: 0.2, endY: 0.7 });
gizmoMatchesCompute("bezier defaults", { ...DEFAULTS, mode: "bezier", startY: 0.2 });
gizmoMatchesCompute("bezier, save without handle params", {
  startX: 0.3,
  startY: 0.65,
  endX: 0.7,
  endY: 0.4,
  mode: "bezier",
});
gizmoMatchesCompute(
  "bezier, custom handles, one 0,0",
  { ...DEFAULTS, mode: "bezier", startOutX: 0.1, startOutY: -0.2, endInX: 0, endInY: 0 }
);
gizmoMatchesCompute(
  "bezier, start wired",
  { ...DEFAULTS, mode: "bezier", startOutY: -0.1 },
  { start: vec2(0.15, 0.3) }
);

{
  const { pts } = gizmo({ ...DEFAULTS, mode: "bezier" });
  check(
    "bezier: Start, Start in/out, End, End in/out, handles tethered to their endpoint",
    JSON.stringify(pts.map((p) => [p.key, p.handle?.of ?? null, p.handle?.side ?? null])) ===
      JSON.stringify([
        ["start", null, null],
        ["startIn", 0, "in"],
        ["startOut", 0, "out"],
        ["end", null, null],
        ["endIn", 3, "in"],
        ["endOut", 3, "out"],
      ]),
    JSON.stringify(pts.map((p) => p.key))
  );
  const { pts: straight } = gizmo(DEFAULTS);
  check(
    "straight: just the two endpoints",
    JSON.stringify(straight.map((p) => [p.key, !!p.handle])) ===
      JSON.stringify([
        ["start", false],
        ["end", false],
      ])
  );
}

// Apply a drag's writes and read the gizmo back.
function drag(
  params: Record<string, unknown>,
  key: string,
  to: [number, number],
  wired?: Record<string, SocketValue | undefined>
): { writes: Array<[string, number]>; after: PrimitiveHandlePoint | undefined } {
  const { pts, env } = gizmo(params, wired);
  const i = pts.findIndex((p) => p.key === key);
  if (i < 0) throw new Error(`no gizmo point "${key}"`);
  const writes = pointsApi!.write(i, to[0], to[1], env, pts);
  const next = { ...params, ...Object.fromEntries(writes) };
  return { writes, after: gizmo(next, wired).pts.find((p) => p.key === key) };
}

{
  const base = { ...DEFAULTS, mode: "bezier", startY: 0.2 };
  const r = drag(base, "start", [0.4, 0.1]);
  check(
    "dragging an endpoint writes startX/startY (aspect undone) and lands under the pointer",
    r.writes.length === 2 &&
      r.writes.every(([n]) => n === "startX" || n === "startY") &&
      xyClose([r.after?.x ?? NaN, r.after?.y ?? NaN], [0.4, 0.1]),
    JSON.stringify(r.writes)
  );
  const h = drag(base, "startOut", [0.55, 0.3]);
  const { pts } = gizmo(base);
  const anchor = pts.find((p) => p.key === "start")!;
  check(
    "dragging a handle writes its offset relative to the endpoint (y ÷ aspect)",
    JSON.stringify(h.writes.map(([n]) => n)) === JSON.stringify(["startOutX", "startOutY"]) &&
      close(h.writes[0][1], 0.55 - anchor.x) &&
      close(h.writes[1][1], (0.3 - anchor.y) / ASPECT) &&
      xyClose([h.after?.x ?? NaN, h.after?.y ?? NaN], [0.55, 0.3]),
    JSON.stringify(h.writes)
  );
  // An endpoint drag writes no handle params, so its handles follow it
  // and the other end's stay put.
  const moved = { ...base, ...Object.fromEntries(r.writes) };
  const at = (params: Record<string, unknown>, key: string) => {
    const p = gizmo(params).pts.find((q) => q.key === key);
    return p ? [p.x, p.y] : [NaN, NaN];
  };
  const was = at(base, "startOut");
  const now = at(moved, "startOut");
  check(
    "an endpoint drag carries its own handles and leaves the other end's alone",
    xyClose([now[0] - was[0], now[1] - was[1]], [0.4 - anchor.x, 0.1 - anchor.y]) &&
      xyClose(at(moved, "endIn"), at(base, "endIn")),
    `startOut ${fmt(was)} → ${fmt(now)}`
  );
}

{
  const p = { ...DEFAULTS, mode: "bezier" };
  const wired = { start: vec2(0.1, 0.9) };
  const { pts, env } = gizmo(p, wired);
  const s = pts.find((q) => q.key === "start");
  check(
    "a wired start is pinned to the wired value and locked",
    !!s &&
      s.locked === true &&
      xyClose([s.x, s.y], onScreen([0.1, 0.9])) &&
      s.label === "Start (wired)",
    JSON.stringify(s)
  );
  check(
    "a locked endpoint writes nothing",
    pointsApi.write(pts.indexOf(s!), 0.5, 0.5, env, pts).length === 0
  );
  const h = drag(p, "startOut", [0.3, 0.5], wired);
  check(
    "a wired endpoint's handle stays draggable, relative to the wired position",
    close(h.writes[0]?.[1] ?? NaN, 0.3 - 0.1) &&
      close(h.writes[1]?.[1] ?? NaN, (0.5 - aspectCorrectY(0.9, ASPECT)) / ASPECT),
    JSON.stringify(h.writes)
  );
  const e = pts.find((q) => q.key === "end");
  check("the unwired end stays draggable", !!e && !e.locked);
}

{
  const p = { ...DEFAULTS, mode: "bezier" };
  const { pts, env } = gizmo(p, { start: undefined });
  check(
    "a wired start with nothing cached is left out, handles and all",
    JSON.stringify(pts.map((q) => [q.key, q.handle?.of ?? null])) ===
      JSON.stringify([
        ["end", null],
        ["endIn", 0],
        ["endOut", 0],
      ]),
    JSON.stringify(pts.map((q) => q.key))
  );
  const i = pts.findIndex((q) => q.key === "end");
  const writes = pointsApi.write(i, 0.6, 0.5, env, pts);
  check(
    "writes still resolve by key once a point is left out",
    JSON.stringify(writes.map(([n]) => n)) === JSON.stringify(["endX", "endY"])
  );
}

{
  const img = { kind: "image" } as unknown as SocketValue;
  const { pts } = gizmo({ ...DEFAULTS, startX: 0.3, startY: 0.4 }, { start: img });
  const s = pts.find((q) => q.key === "start");
  check(
    "a wired value that never reaches compute leaves the endpoint on its params",
    !!s && !s.locked && xyClose([s.x, s.y], onScreen([0.3, 0.4])),
    JSON.stringify(s)
  );
  const sc = gizmo(DEFAULTS, { start: scalar(0.4) }).pts.find((q) => q.key === "start");
  check(
    "a wired scalar pins the endpoint at (v, v)",
    !!sc && sc.locked === true && xyClose([sc.x, sc.y], onScreen([0.4, 0.4]))
  );
}

// ── Wiring plumbing ──────────────────────────────────────────────

{
  const out = (primary?: SocketValue, aux?: Record<string, SocketValue>) => ({
    fingerprint: "",
    output: { primary, aux } as NodeOutput,
    ownsTextures: false,
  });
  const cache: EvalCache = new Map([
    ["pt", out(vec2(0.1, 0.2))],
    ["cur", out(scalar(1), { position: vec2(0.3, 0.4) })],
  ]);
  const edges = [
    { source: "pt", sourceHandle: "out:primary", target: "L", targetHandle: "in:start" },
    { source: "cur", sourceHandle: "out:aux:position", target: "L", targetHandle: "in:end" },
    { source: "cur", sourceHandle: "out:primary", target: "L", targetHandle: "in:transform" },
    { source: "pt", sourceHandle: "out:primary", target: "other", targetHandle: "in:start" },
  ];
  const w = readWiredInputs("L", ["start", "end"], edges, cache);
  check(
    "readWiredInputs: primary and aux producers, listed sockets only",
    JSON.stringify(w) ===
      JSON.stringify({ start: vec2(0.1, 0.2), end: vec2(0.3, 0.4) }),
    JSON.stringify(w)
  );
  const ghost = readWiredInputs(
    "L",
    ["start"],
    [{ source: "gone", sourceHandle: "out:primary", target: "L", targetHandle: "in:start" }],
    cache
  );
  check(
    "readWiredInputs: a producer with no cached output reads as wired-but-undefined",
    "start" in ghost && ghost.start === undefined
  );
  const none = readWiredInputs("L", ["start", "end"], [], cache);
  check("readWiredInputs: unwired sockets are absent", Object.keys(none).length === 0);
}

{
  const wire = (h: string) => [{ target: "L", targetHandle: `in:${h}` }];
  check(
    "wiring start / end keeps the gizmo (live link too); wiring transform hides it",
    liveGizmoWiringBlocker("L", "line", "primitive", [...wire("start"), ...wire("end")]) === null &&
      liveGizmoWiringBlocker("L", "line", "primitive", wire("transform")) !== null &&
      JSON.stringify(adapter.hideWhenWired) === JSON.stringify(["transform"])
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
