// check-channel-keyframes: keyframes on expression channels — the `ch:<name>`
// virtual animation keys on channelSync nodes (GLSL Expression, Point
// Expression, SkSL Shader). specdocs/101326_skia-target.md §3.8.1;
// engine/channel-keyframes.ts. Pure logic, no GPU:
//
//   1. key helpers + per-kind track types; the wire-precedence predicate
//      agrees with readChannelValue for every kind × socket kind;
//   2. resolution per kind — scalar lerps, color interpolates in the block's
//      space and lands as the row's hex (alpha byte kept), toggle / pick
//      step; ramp / curve, disabled, empty and junk tracks are ignored; the
//      stored rows are never mutated;
//   3. through evaluateGraph: the node computes with the track's value,
//      wire > keyframe > row (scalar and color sockets), a wired channel's
//      track neither overrides nor busts the cache, an animated channel
//      busts it per tick and cache-hits at a repeated tick, an unanimated
//      node stays cached; all three real defs resolve their `inputs` list;
//      Point Expression end to end (its real compute);
//   4. the channel-list edit path (applyChannelListEdit): rename moves the
//      track, never clobbers another row's, duplicates keep theirs, a swap
//      moves both, removal drops, a wholesale list copy keeps tracks by
//      name, autokey on value edits (including re-setting the stored value)
//      but not on range edits or other rows;
//   5. MCP helpers: resolveChannelKeyframeTarget (names, `ch:` keys, ramp /
//      curve refusals, non-channel nodes) and vetChannelKeyframeValue (the
//      set_param rules + color tuples);
//   6. save → load → save keeps `ch:` tracks verbatim.
//
// The editor surfaces (panel diamond, Track editor lane, set_keyframes over
// the bridge) are live-app questions; the export half is in
// check-skia-export.
//
//   npx tsx scripts/check-channel-keyframes.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef, registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { evaluateKeyframesAt } = await import("@/engine/keyframes");
const { channelKey, parseChannelKey, colorValueToHex, CHANNEL_KEY_PREFIX } = await import("@/engine/conventions");
const EC = await import("@/engine/expr-channels");
const CK = await import("@/engine/channel-keyframes");
const { makePoints } = await import("@/engine/points");
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";
type ExprInput = import("@/engine/types").ExprInput;
type SocketValue = import("@/engine/types").SocketValue;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const block = (keys: Keyframe[], extra: Partial<KeyframeAnimationBlock> = {}): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys,
  ...extra,
});
const kf = (tick: number, value: unknown, easingOut: Keyframe["easingOut"] = "linear"): Keyframe => ({ tick, value, easingOut });

const ROWS: ExprInput[] = [
  { id: "s1", name: "amount", default: 0.25, min: 0, max: 20 },
  { id: "t1", name: "on", kind: "toggle", default: false },
  { id: "e1", name: "mode", kind: "enum", default: "a", options: ["a", "b", "c"] },
  { id: "c1", name: "tint", kind: "color", default: "#ffffff" },
  { id: "r1", name: "ink", kind: "ramp", default: EC.rampStopsFromHexes(["#000000", "#ffffff"]) },
  { id: "f1", name: "fall", kind: "curve", default: EC.curvePointsFromYs([1, 0]) },
];
const row = (name: string) => ROWS.find((r) => r.name === name)!;
const ANIM = {
  [channelKey("amount")]: block([kf(0, 0, "linear"), kf(1000, 10, "linear")]),
  [channelKey("on")]: block([kf(0, false, "hold"), kf(1000, true, "hold")]),
  [channelKey("mode")]: block([kf(0, "a", "hold"), kf(1000, "c", "hold")]),
  [channelKey("tint")]: block([kf(0, "#ff0000", "easeInOutQuad"), kf(1000, "#0000ff80", "linear")]),
  [channelKey("ink")]: block([kf(0, 1, "linear"), kf(1000, 2, "linear")]),
  [channelKey("fall")]: block([kf(0, 1, "linear"), kf(1000, 2, "linear")]),
};

// ---- 1. keys, types, wire predicate ---------------------------------------------
{
  check("channelKey / parseChannelKey round-trip", channelKey("amount") === "ch:amount" && parseChannelKey("ch:amount") === "amount" && CHANNEL_KEY_PREFIX === "ch:");
  check("parseChannelKey ignores params and other virtual keys", parseChannelKey("amount") === null && parseChannelKey("ramp_c:ramp:s1") === null && parseChannelKey("layer_opacity:x") === null);
  check(
    "track types: ch → scalar, toggle → boolean, pick → enum, color → color, ramp / curve → none",
    ["amount", "on", "mode", "tint", "ink", "fall"].map((n) => CK.channelKeyframeType(row(n))).join() === "scalar,boolean,enum,color,,"
  );
  const sockets: (SocketValue | undefined)[] = [
    undefined,
    { kind: "scalar", value: 7 },
    { kind: "vec4", value: [0.1, 0.2, 0.3, 0.4] },
    { kind: "color_ramp", stops: EC.rampStopsFromHexes(["#123456", "#abcdef"]), interp: "linear" } as SocketValue,
    { kind: "vec2", value: [3, 4] } as SocketValue,
  ];
  let bad = "";
  for (const r of ROWS) {
    for (const s of sockets) {
      const changed = !same(EC.readChannelValue(r, s), EC.readChannelValue(r, undefined));
      if (CK.channelSocketWins(r, s) !== changed) bad += ` ${r.name}×${s?.kind ?? "none"}`;
    }
  }
  check("channelSocketWins == readChannelValue's precedence for every kind × socket", bad === "", bad);
}

// ---- 2. resolution per kind --------------------------------------------------------
{
  const frozen = JSON.stringify(ROWS);
  const at = (tick: number) => CK.resolveChannelKeyframes(ROWS, ANIM, tick)!;
  const val = (rows: ExprInput[], n: string) => rows.find((r) => r.name === n)!.default;
  const mid = at(500);
  check("scalar interpolates (0 → 10 linear, tick 500 → 5)", val(mid, "amount") === 5);
  check("scalar clamps before / after the keys", val(at(-50), "amount") === 0 && val(at(5000), "amount") === 10);
  check("scalar keyframes are not clamped to the row range (overshoot plays, like params)", val(CK.resolveChannelKeyframes(ROWS, { "ch:amount": block([kf(0, 0), kf(10, 50)]) }, 10)!, "amount") === 50);
  check("toggle steps (false until the next key, true on it)", val(mid, "on") === false && val(at(1000), "on") === true && val(at(999), "on") === false);
  check(
    "toggle ignores easing: a linear key still steps",
    val(CK.resolveChannelKeyframes(ROWS, { "ch:on": block([kf(0, false, "linear"), kf(1000, true)]) }, 900)!, "on") === false
  );
  check("toggle takes numeric keys as ≠ 0", val(CK.resolveChannelKeyframes(ROWS, { "ch:on": block([kf(0, 2)]) }, 0)!, "on") === true);
  check("pick steps", val(mid, "mode") === "a" && val(at(1000), "mode") === "c");
  {
    const want = EC.normalizeChannelHex(colorValueToHex(evaluateKeyframesAt(ANIM["ch:tint"], "color", 500), "", true));
    const got = val(mid, "tint");
    check("color interpolates in OKLab and lands as the row's hex (alpha byte kept)", typeof got === "string" && got === want && got.length === 9, `${got} vs ${want}`);
    const rgb = CK.resolveChannelKeyframes(ROWS, { "ch:tint": { ...ANIM["ch:tint"], colorSpace: "rgb" } }, 500)!;
    const wantRgb = EC.normalizeChannelHex(colorValueToHex(evaluateKeyframesAt({ ...ANIM["ch:tint"], colorSpace: "rgb" }, "color", 500), "", true));
    check("color honours the block's colorSpace (rgb ≠ oklab mid-segment)", val(rgb, "tint") === wantRgb && wantRgb !== want);
    check("color at a key is the key's hex, normalized", val(at(0), "tint") === "#ff0000" && val(at(1000), "tint") === "#0000ff80");
    const tup = CK.resolveChannelKeyframes(ROWS, { "ch:tint": block([kf(0, [1, 0.5, 0, 1])]) }, 0)!;
    check("color tuple keys land as hex (opaque → 6 digits)", val(tup, "tint") === "#ff8000");
    const read = EC.readChannelValue(mid.find((r) => r.name === "tint")!, undefined) as number[];
    check("the node reads the resolved color as 8-bit RGBA", read.every((x) => Number.isInteger(Math.round(x * 255)) && Math.abs(x * 255 - Math.round(x * 255)) < 1e-9) && read[3] < 1);
  }
  check("ramp / curve rows ignore a ch: track", same(val(mid, "ink"), row("ink").default) && same(val(mid, "fall"), row("fall").default));
  check("stored rows are not mutated; untouched rows are shared", JSON.stringify(ROWS) === frozen && mid[4] === ROWS[4] && mid !== ROWS);
  check("nothing animated → null (params left alone)", CK.resolveChannelKeyframes(ROWS, {}, 0) === null && CK.resolveChannelKeyframes(ROWS, undefined, 0) === null);
  check(
    "disabled / empty tracks are ignored",
    CK.resolveChannelKeyframes(ROWS, { "ch:amount": { ...ANIM["ch:amount"], animated: false }, "ch:on": block([]) }, 500) === null
  );
  check(
    "junk keys keep the row value (a scalar track of strings, a color track of numbers)",
    CK.resolveChannelKeyframes(ROWS, { "ch:amount": block([kf(0, "x")]), "ch:tint": block([kf(0, 3)]) }, 0) === null
  );
  check("tracks for missing channels are ignored", CK.resolveChannelKeyframes(ROWS, { "ch:gone": block([kf(0, 1)]) }, 0) === null);
  const dup: ExprInput[] = [...ROWS, { id: "s2", name: "amount", default: 9 }];
  const dupOut = CK.resolveChannelKeyframes(dup, ANIM, 500)!;
  check("duplicate names share one track", dupOut.filter((r) => r.name === "amount").every((r) => r.default === 5));
  const wired = CK.resolveChannelKeyframes(ROWS, ANIM, 500, { "in:s1": { kind: "scalar", value: 3 }, "in:c1": { kind: "vec4", value: [0, 0, 0, 1] } })!;
  check("a winning wire skips that channel's track (others still resolve)", val(wired, "amount") === 0.25 && val(wired, "tint") === "#ffffff" && val(wired, "on") === false);
  const wrongKind = CK.resolveChannelKeyframes(ROWS, { "ch:amount": ANIM["ch:amount"] }, 500, { "in:s1": { kind: "vec4", value: [1, 1, 1, 1] } })!;
  check("a socket of the wrong kind doesn't win (readChannelValue ignores it too)", val(wrongKind, "amount") === 5);
  check(
    "channelDisplayValue: the track at the playhead, else the row",
    CK.channelDisplayValue(row("amount"), ANIM["ch:amount"], 250) === 2.5 &&
      CK.channelDisplayValue(row("amount"), undefined, 250) === 0.25 &&
      CK.channelDisplayValue(row("ink"), ANIM["ch:ink"], 250) === row("ink").default
  );
}

// ---- 3. through the evaluator --------------------------------------------------------
const ctx: any = {
  gl: {}, width: 8, height: 8, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
  allocImage: () => ({ kind: "image", texture: {}, width: 8, height: 8 }),
  allocMask: () => ({ kind: "mask", texture: {}, width: 8, height: 8 }),
  allocUv: () => ({ kind: "uv", texture: {}, width: 8, height: 8 }),
  releaseTexture: () => {}, drawFullscreen: () => {}, clearTarget: () => {}, getShader: () => ({}),
};
const setFrame = (f: number) => {
  ctx.frame = f;
  ctx.tick = f * 1000;
  ctx.time = f / 60;
};
const edge = (source: string, target: string, targetHandle: string): GraphEdge =>
  ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle: "out:primary", target, targetHandle }) as GraphEdge;

let probeComputes = 0;
let probeSeen: Record<string, unknown> = {};
registerNode({
  type: "test-chan-probe",
  name: "Channel probe",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  resolveInputs(params: Record<string, unknown>) {
    return ((params.inputs as ExprInput[]) ?? [])
      .filter((e) => EC.channelSocketType(e) !== null)
      .map((e) => ({ name: `in:${e.id}`, label: e.name, type: EC.channelSocketType(e)!, required: false }));
  },
  params: [{ name: "inputs", type: "expr_inputs", default: [], channelSync: true }],
  primaryOutput: "scalar",
  auxOutputs: [],
  compute({ inputs, params }: any) {
    probeComputes++;
    probeSeen = EC.readChannelValues(params.inputs as ExprInput[], inputs);
    return { primary: { kind: "scalar", value: 0 } };
  },
} as any);
registerNode({
  type: "test-chan-scalar",
  name: "Scalar",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [{ name: "value", type: "scalar", default: 0 }],
  primaryOutput: "scalar",
  auxOutputs: [],
  compute({ params }: any) {
    return { primary: { kind: "scalar", value: params.value as number } };
  },
} as any);
registerNode({
  type: "test-chan-vec4",
  name: "Vec4",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "vec4",
  auxOutputs: [],
  compute() {
    return { primary: { kind: "vec4", value: [0.5, 0.25, 0.125, 1] } };
  },
} as any);
registerNode({
  type: "test-chan-points",
  name: "Points",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "points",
  auxOutputs: [],
  compute() {
    const pts = makePoints(3, { withScales: true, withRotations: true });
    for (let i = 0; i < 3; i++) {
      pts.positions[i * 2] = i / 2;
      pts.positions[i * 2 + 1] = 0.5;
      pts.scales![i * 2] = 1;
      pts.scales![i * 2 + 1] = 1;
    }
    return { primary: pts };
  },
} as any);

const run = (nodes: GraphNode[], edges: GraphEdge[], cache: EvalCache, target: string) =>
  evaluateGraph(nodes, edges, ctx, cache, null, undefined, null, { extraTargets: [target] });

{
  const probe: GraphNode = { id: "p", type: "test-chan-probe", params: { inputs: ROWS }, animation: ANIM };
  const cache: EvalCache = new Map();
  probeComputes = 0;
  ctx.tick = 500;
  run([probe], [], cache, "p");
  const tint = probeSeen.tint as number[];
  check(
    "evaluator: the node computes with every kind's track value",
    probeSeen.amount === 5 && probeSeen.on === false && probeSeen.mode === "a" &&
      same(tint, EC.hexToRgba01Channel(CK.resolveChannelKeyframes(ROWS, ANIM, 500)!.find((r) => r.name === "tint")!.default as string)),
    JSON.stringify(probeSeen)
  );
  check("evaluator: node.params is untouched", probe.params.inputs === ROWS && JSON.stringify(ROWS[0]) === JSON.stringify({ id: "s1", name: "amount", default: 0.25, min: 0, max: 20 }));
  ctx.tick = 1000;
  run([probe], [], cache, "p");
  check("evaluator: an animated channel busts the cache per tick", probeComputes === 2 && probeSeen.amount === 10 && probeSeen.on === true && probeSeen.mode === "c");
  run([probe], [], cache, "p");
  check("evaluator: same tick again is a cache hit", probeComputes === 2);

  const still: GraphNode = { id: "q", type: "test-chan-probe", params: { inputs: ROWS }, animation: { "ch:amount": { ...ANIM["ch:amount"], animated: false } } };
  const c2: EvalCache = new Map();
  probeComputes = 0;
  for (const t of [0, 500, 1000]) {
    ctx.tick = t;
    run([still], [], c2, "q");
  }
  check("evaluator: a node whose channel tracks are off stays cached across ticks", probeComputes === 1 && probeSeen.amount === 0.25);

  // Wire > keyframe > row. Only the scalar + color channels are animated
  // here, and both are wired — so nothing on the node is tick-dependent.
  const wiredAnim = { "ch:amount": ANIM["ch:amount"], "ch:tint": ANIM["ch:tint"] };
  const wnode: GraphNode = { id: "w", type: "test-chan-probe", params: { inputs: ROWS }, animation: wiredAnim };
  const nodes: GraphNode[] = [{ id: "k", type: "test-chan-scalar", params: { value: 3 } }, { id: "v", type: "test-chan-vec4", params: {} }, wnode];
  const edges = [edge("k", "w", "in:in:s1"), edge("v", "w", "in:in:c1")];
  const c3: EvalCache = new Map();
  probeComputes = 0;
  for (const t of [0, 250, 500, 1000]) {
    ctx.tick = t;
    run(nodes, edges, c3, "w");
  }
  check("evaluator: a wired scalar beats its keyframes", probeSeen.amount === 3);
  check("evaluator: a wired vec4 beats a color track", same(probeSeen.tint, [0.5, 0.25, 0.125, 1]));
  check("evaluator: wired-over tracks don't bust the cache per tick", probeComputes === 1, `${probeComputes} computes`);
  const mixed: GraphNode = { ...wnode, id: "m", animation: { ...wiredAnim, "ch:on": ANIM["ch:on"] } };
  const c4: EvalCache = new Map();
  probeComputes = 0;
  for (const t of [0, 1000]) {
    ctx.tick = t;
    run([nodes[0], nodes[1], mixed], [edge("k", "m", "in:in:s1"), edge("v", "m", "in:in:c1")], c4, "m");
  }
  check("evaluator: one wired + one animated channel — the animated one resolves and busts", probeComputes === 2 && probeSeen.on === true && probeSeen.amount === 3);

  // The three real channelSync defs resolve their own list (`inputs`) — the
  // compute is wrapped to capture what it receives (GLSL / SkSL need a GPU).
  for (const type of ["glsl-expression", "point-expression", "sksl-shader"]) {
    const def = getNodeDef(type)!;
    const real = def.compute;
    let seen: Record<string, unknown> = {};
    def.compute = ((args: any) => {
      seen = EC.readChannelValues(args.params.inputs as ExprInput[], args.inputs);
      return {};
    }) as any;
    try {
      ctx.tick = 500;
      const n: GraphNode = { id: `n-${type}`, type, params: { ...Object.fromEntries(def.params.map((p) => [p.name, p.default])), inputs: ROWS }, animation: ANIM };
      run([n], [], new Map(), n.id);
      check(`${type}: channel tracks reach compute (scalar 5, pick "a", color hex)`, seen.amount === 5 && seen.mode === "a" && Array.isArray(seen.tint) && (seen.tint as number[])[3] < 1, JSON.stringify(seen));
    } finally {
      def.compute = real;
    }
  }

  // Point Expression end to end: its real compute reads the resolved rows.
  const pexRows: ExprInput[] = [
    { id: "pk", name: "k", default: 0 },
    { id: "pc", name: "c", kind: "color", default: "#ffffff" },
    { id: "pt", name: "on", kind: "toggle", default: true },
  ];
  const pex: GraphNode = {
    id: "pex",
    type: "point-expression",
    params: {
      target: "points",
      on_error: "passthrough",
      inputs: pexRows,
      expression: `x = ch("k", 0);\nconst c = color("c", "#ffffff");\ny = c[3];\nkeep = toggle("on", true);`,
    },
    animation: {
      "ch:k": block([kf(0, 0.2, "linear"), kf(60_000, 0.8, "linear")]),
      "ch:c": block([kf(0, "#ffffffff"), kf(60_000, "#ffffff00")], { colorSpace: "rgb" }),
      "ch:on": block([kf(0, true, "hold"), kf(30_000, false, "hold")]),
    },
  };
  const pnodes: GraphNode[] = [{ id: "src", type: "test-chan-points", params: {} }, pex];
  const pedges = [edge("src", "pex", "in:points")];
  const pcache: EvalCache = new Map();
  setFrame(15);
  const r15 = run(pnodes, pedges, pcache, "pex").outputs.get("pex")?.primary as any;
  const wantX = Math.fround(0.2 + (0.8 - 0.2) * 0.25);
  const wantY = Math.fround(Math.round((1 - 0.25) * 255) / 255);
  check(
    "Point Expression (real compute): scalar + color tracks drive the points at frame 15",
    r15?.kind === "points" && r15.count === 3 && r15.positions[0] === wantX && r15.positions[1] === wantY,
    `x ${r15?.positions?.[0]} want ${wantX}, y ${r15?.positions?.[1]} want ${wantY}`
  );
  setFrame(30);
  const r30 = run(pnodes, pedges, pcache, "pex").outputs.get("pex")?.primary as any;
  check("Point Expression (real compute): the toggle track steps off at its key (every point culled)", r30?.kind === "points" && r30.count === 0, `count ${r30?.count}`);
}

// ---- 4. the channel-list edit path ------------------------------------------------------
{
  const anim = { "ch:amount": ANIM["ch:amount"], "ch:on": ANIM["ch:on"], "ch:tint": ANIM["ch:tint"], speed: block([kf(0, 1)]) };
  const rename = (rows: ExprInput[], id: string, name: string) => rows.map((r) => (r.id === id ? { ...r, name } : r));

  const r1 = CK.applyChannelListEdit(ROWS, rename(ROWS, "s1", "gain"), anim, 0)!;
  check("rename moves the track with the row (same block)", !("ch:amount" in r1) && r1["ch:gain"] === anim["ch:amount"] && r1.speed === anim.speed);
  const evald = CK.resolveChannelKeyframes(rename(ROWS, "s1", "gain"), r1, 500)!;
  check("…and the renamed row evaluates its track", evald.find((r) => r.id === "s1")!.default === 5);
  check("the input map is not mutated", "ch:amount" in anim && !("ch:gain" in anim));

  const r2 = CK.applyChannelListEdit(ROWS, rename(ROWS, "s1", "on"), anim, 0)!;
  check("rename onto another row's name never clobbers its track (ours stays parked)", r2["ch:on"] === anim["ch:on"] && r2["ch:amount"] === anim["ch:amount"]);

  const dupRows: ExprInput[] = [...ROWS, { id: "s2", name: "amount", default: 1 }];
  const r3 = CK.applyChannelListEdit(dupRows, rename(dupRows, "s2", "other"), anim, 0)!;
  check("renaming one of two duplicates leaves the track with the other", r3["ch:amount"] === anim["ch:amount"] && !("ch:other" in r3));

  const swapped = ROWS.map((r) => (r.id === "s1" ? { ...r, name: "on" } : r.id === "t1" ? { ...r, name: "amount" } : r));
  const r4 = CK.applyChannelListEdit(ROWS, swapped, anim, 0)!;
  check("a swap (a ↔ b in one edit) moves both tracks", r4["ch:on"] === anim["ch:amount"] && r4["ch:amount"] === anim["ch:on"]);

  const r5 = CK.applyChannelListEdit(ROWS, ROWS.filter((r) => r.id !== "t1"), anim, 0)!;
  check("removing a row drops its track (others kept)", !("ch:on" in r5) && r5["ch:amount"] === anim["ch:amount"] && r5.speed === anim.speed);
  const r6 = CK.applyChannelListEdit(dupRows, dupRows.filter((r) => r.id !== "s1"), anim, 0)!;
  check("removing one of two duplicates keeps the shared track", r6["ch:amount"] === anim["ch:amount"]);
  const copied = ROWS.map((r) => ({ ...r, id: `x-${r.id}` }));
  const r7 = CK.applyChannelListEdit(ROWS, copied, anim, 0)!;
  check("a wholesale list copy (new ids, same names) keeps every track", r7["ch:amount"] === anim["ch:amount"] && r7["ch:on"] === anim["ch:on"] && r7["ch:tint"] === anim["ch:tint"]);

  const setVal = (rows: ExprInput[], id: string, v: ExprInput["default"]) => rows.map((r) => (r.id === id ? { ...r, default: v } : r));
  const k1 = CK.applyChannelListEdit(ROWS, setVal(ROWS, "s1", 7), anim, 500)!;
  const added = k1["ch:amount"].keyframes.find((k) => k.tick === 500);
  check("autokey: a value edit on an animated track keys it at the playhead (easeInOut)", added?.value === 7 && added.easingOut === "easeInOut" && k1["ch:amount"].keyframes.length === 3);
  check("autokey: the other tracks are untouched", k1["ch:on"] === anim["ch:on"] && k1["ch:tint"] === anim["ch:tint"]);
  const k2 = CK.applyChannelListEdit(ROWS, setVal(ROWS, "c1", "#FF8800FF"), anim, 1000)!;
  check("autokey: color keys land in the row's normalized hex", k2["ch:tint"].keyframes.find((k) => k.tick === 1000)?.value === "#ff8800");
  const k3 = CK.applyChannelListEdit(ROWS, setVal(ROWS, "t1", false), anim, 1000)!;
  check("autokey: re-setting the stored value still keys (a toggle clicked back while the track shows true)", k3["ch:on"].keyframes.find((k) => k.tick === 1000)?.value === false);
  const ranged = ROWS.map((r) => (r.id === "s1" ? { ...r, max: 50 } : r));
  check("no autokey on a range edit (same map back)", CK.applyChannelListEdit(ROWS, ranged, anim, 500) === anim);
  const offAnim = { ...anim, "ch:amount": { ...anim["ch:amount"], animated: false } };
  check("no autokey while the track is off", CK.applyChannelListEdit(ROWS, setVal(ROWS, "s1", 7), offAnim, 500) === offAnim);
  check("no autokey for a channel without a track", CK.applyChannelListEdit(ROWS, setVal(ROWS, "e1", "b"), anim, 500) === anim);
  check("an unchanged list returns the same map", CK.applyChannelListEdit(ROWS, ROWS, anim, 0) === anim && CK.applyChannelListEdit(ROWS, ROWS, undefined, 0) === undefined);
}

// ---- 5. MCP helpers --------------------------------------------------------------------
{
  for (const type of ["glsl-expression", "point-expression", "sksl-shader"]) {
    const def = getNodeDef(type)!;
    const t = CK.resolveChannelKeyframeTarget(def, { inputs: ROWS }, "amount");
    check(`${type}: a channel name resolves to its ch: track`, !!t && t.ok && t.key === "ch:amount" && t.type === "scalar" && t.listParam === "inputs");
  }
  const def = getNodeDef("sksl-shader")!;
  const t2 = CK.resolveChannelKeyframeTarget(def, { inputs: ROWS }, "ch:tint");
  check("the explicit ch:<name> form resolves too", !!t2 && t2.ok && t2.name === "tint" && t2.type === "color");
  check("an unknown bare name is not a channel (the caller reports its own error)", CK.resolveChannelKeyframeTarget(def, { inputs: ROWS }, "nope") === null);
  const t3 = CK.resolveChannelKeyframeTarget(def, { inputs: ROWS }, "ch:nope");
  check("an unknown ch: key fails with the channel list", !!t3 && !t3.ok && t3.reason.includes("amount"));
  const t4 = CK.resolveChannelKeyframeTarget(def, { inputs: ROWS }, "ink");
  check("ramp channels are refused with a reason", !!t4 && !t4.ok && t4.reason.includes("ramp") && t4.reason.includes("color_ramp"));
  const t5 = CK.resolveChannelKeyframeTarget(def, { inputs: ROWS }, "fall");
  check("curve channels are refused with a reason", !!t5 && !t5.ok && t5.reason.includes("curve"));
  check("non-channel nodes never resolve channels", CK.resolveChannelKeyframeTarget(getNodeDef("constant")!, { inputs: ROWS }, "amount") === null);
  check("keyframableChannelNames lists ch / toggle / pick / color only", CK.keyframableChannelNames(def, { inputs: ROWS }).join() === "amount,on,mode,tint");

  const v = (name: string, value: unknown) => CK.vetChannelKeyframeValue(row(name), value);
  const okv = (r: ReturnType<typeof v>) => (r.ok ? r.value : `ERR ${r.reason}`);
  check("vet scalar: numbers, clamped to the row's explicit range", okv(v("amount", 5)) === 5 && okv(v("amount", 99)) === 20 && okv(v("amount", -1)) === 0 && !v("amount", "5").ok);
  check("vet toggle: booleans, numbers as ≠ 0", okv(v("on", true)) === true && okv(v("on", 0)) === false && okv(v("on", 3)) === true && !v("on", "yes").ok);
  check("vet pick: an option string", okv(v("mode", "b")) === "b" && !v("mode", "z").ok && !v("mode", 1).ok);
  check(
    "vet color: hex normalized (3 / 6 / 8 digits), tuples → hex, junk refused",
    okv(v("tint", "#F80")) === "#ff8800" && okv(v("tint", "#ff8800ff")) === "#ff8800" && okv(v("tint", "#ff880080")) === "#ff880080" &&
      okv(v("tint", [1, 0.5, 0, 0.5])) === "#ff800080" && okv(v("tint", [0, 0, 1])) === "#0000ff" &&
      !v("tint", "red").ok && !v("tint", [1, 2]).ok && !v("tint", [1, "x", 0]).ok
  );
  check("vet ramp / curve: refused", !v("ink", "#fff").ok && !v("fall", 1).ok);
}

// ---- 6. save / load ----------------------------------------------------------------------
{
  const { deserializeGraph, serializeGraph, CURRENT_SCHEMA } = await import("@/lib/project");
  const saved = {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [
      {
        id: "sk",
        defType: "sksl-shader",
        position: { x: 0, y: 0 },
        params: { inputs: ROWS, expression: "half4 main(float2 p) { return half4(amount); }", on_error: "transparent" },
        animation: ANIM,
      },
    ],
    edges: [],
  } as any;
  const res = await deserializeGraph(saved);
  check("load keeps every ch: track verbatim", same(res.nodes[0]?.data.animation, ANIM), JSON.stringify(res.nodes[0]?.data.animation));
  const ser = await serializeGraph(res.nodes as any, res.edges as any);
  check("save keeps every ch: track verbatim", same((ser.nodes[0] as any)?.animation, ANIM));
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
