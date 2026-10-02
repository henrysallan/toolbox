// check-bounding-box: Bounding Box's per-socket output toggles (2026-09-23).
// Every aux socket is opt-in behind its own show_<socket> boolean, all off:
// a fresh node shows only the Box spline, each toggle adds exactly its
// socket (display order kept), and compute emits a value only for shown
// sockets. Saves from before the toggles load with the sockets they always
// had — the 14 measurement sockets on, the guide pair per the old `guides`
// flag, whose expose / control / keyframe entries and param wire follow onto
// both guide toggles — so no saved wire loses its socket (the editor drops
// wires out of a missing socket). The validator names the toggle when a
// recipe wires a hidden socket.
//
//   npx tsx scripts/check-bounding-box.mts
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SavedProject } from "@/lib/project";
import type { PointsValue, RenderContext, SocketValue, SplineValue } from "@/engine/types";

// Minimal DOM stubs — importing @/lib/project pulls the engine/registry in.
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
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

// Register first, then reach everything through dynamic imports so they
// share the registry instance registerAllNodes filled.
const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef, allNodeDefs } = await import("@/engine/registry");
const { makeInstanceNode } = await import("@/state/graph-ops");
const { coerceValue } = await import("@/engine/coerce");
const { pointsFromArray } = await import("@/engine/points");
const { aspectUncorrectY } = await import("@/engine/aspect");
const { validateGraph } = await import("@/engine/graph-validation");
const { buildNodeCatalog } = await import("@/engine/node-catalog");
const { buildRecipe } = await import("@/state/recipe-builder");
const { deserializeGraph, serializeGraph, CURRENT_SCHEMA } = await import("@/lib/project");
const { migrateBoundingBoxParams, showParamName } = await import(
  "@/nodes/effect/bounding-box"
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Spline flattening runs in Float32, so a 0.6 edge can come back 0.60000002.
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const near = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((x, i) => near(x, b[i]))
    : typeof a === "number" && typeof b === "number" && close(a, b);

const ALL = [
  "left",
  "right",
  "top",
  "bottom",
  "mid_left",
  "mid_right",
  "mid_top",
  "mid_bottom",
  "corner_tl",
  "corner_tr",
  "corner_bl",
  "corner_br",
  "center",
  "size",
  "guides_v",
  "guides_h",
];
const GUIDES = new Set(["guides_v", "guides_h"]);
const allOn = Object.fromEntries(ALL.map((n) => [showParamName(n), true]));

const def = getNodeDef("bounding-box")!;
const fresh = makeInstanceNode("bounding-box", { x: 0, y: 0 });

// --- 1. a fresh node: the Box spline and sixteen off toggles ---
{
  check(
    "fresh node shows only the Box spline",
    fresh.data.primaryOutput === "spline" && fresh.data.auxOutputs.length === 0,
    JSON.stringify(fresh.data.auxOutputs)
  );
  check(
    "one toggle per aux socket, all off, nothing else",
    same(Object.keys(fresh.data.params), ALL.map(showParamName)) &&
      ALL.every((n) => fresh.data.params[showParamName(n)] === false),
    JSON.stringify(fresh.data.params)
  );
  check(
    "each toggle is labeled like the socket it adds",
    def.params.every(
      (p, i) => p.type === "boolean" && p.label === def.auxOutputs[i].label
    ) && def.params.length === def.auxOutputs.length
  );
  check("the static list is the full set of sixteen", same(def.auxOutputs.map((a) => a.name), ALL));
}

// --- 2. resolveAuxOutputs: each toggle adds exactly its socket ---
{
  const bad = ALL.filter((n) => {
    const aux = def.resolveAuxOutputs!({ ...fresh.data.params, [showParamName(n)]: true });
    return aux.length !== 1 || aux[0].name !== n;
  });
  check("each toggle adds exactly its own socket", bad.length === 0, bad.join(", "));
  const picked = def.resolveAuxOutputs!({
    ...fresh.data.params,
    show_guides_h: true,
    show_center: true,
    show_left: true,
  }).map((a) => a.name);
  check("shown sockets keep display order", same(picked, ["left", "center", "guides_h"]), picked.join(","));
  check(
    "every toggle on = the full list",
    same(def.resolveAuxOutputs!(allOn).map((a) => a.name), ALL)
  );
}

// --- 3. compute emits values for shown sockets only ---
{
  const W = 1920;
  const H = 1080;
  const aspect = W / H;
  const ctx = { time: 0, playing: false, state: {}, width: W, height: H } as unknown as RenderContext;
  const run = (src: SocketValue, type: "spline" | "points", params: Record<string, unknown>) =>
    def.compute({
      inputs: { source: coerceValue(src, type, ctx) },
      auxIn: {},
      params,
      ctx,
      nodeId: "bb",
    }) as { primary?: SocketValue; aux?: Record<string, SocketValue> };
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        anchors: [{ pos: [0.2, 0.3] }, { pos: [0.6, 0.3] }, { pos: [0.6, 0.7] }],
      },
    ],
  };
  const pt = (v: SocketValue | undefined) => {
    const p = v as PointsValue | undefined;
    return p?.kind === "points" && p.count === 1 ? [p.positions[0], p.positions[1]] : null;
  };

  const off = run(spline, "spline", fresh.data.params);
  const box = off.primary as SplineValue | undefined;
  check(
    "all toggles off: no aux values, the box spline still comes out",
    Object.keys(off.aux ?? {}).length === 0 &&
      box?.kind === "spline" &&
      near(
        box.subpaths[0]?.anchors.map((a) => a.pos),
        [
          [0.2, 0.3],
          [0.6, 0.3],
          [0.6, 0.7],
          [0.2, 0.7],
        ]
      ),
    JSON.stringify(off)
  );

  const two = run(spline, "spline", { ...fresh.data.params, show_center: true, show_size: true });
  const c = pt(two.aux?.center);
  const size = two.aux?.size;
  check(
    "center + size on: exactly those two, measured",
    same(Object.keys(two.aux ?? {}), ["center", "size"]) &&
      !!c &&
      close(c[0], 0.4) &&
      close(c[1], 0.5) &&
      size?.kind === "vec2" &&
      close(size.value[0], 0.4) &&
      close(size.value[1], 0.4),
    JSON.stringify(two.aux)
  );

  const every = run(spline, "spline", allOn);
  const a = every.aux ?? {};
  const scalarOf = (v: SocketValue | undefined) => (v?.kind === "scalar" ? v.value : NaN);
  const br = pt(a.corner_br);
  const gv = a.guides_v as SplineValue | undefined;
  const gh = a.guides_h as SplineValue | undefined;
  const top = aspectUncorrectY(0, aspect);
  const bottom = aspectUncorrectY(1, aspect);
  check(
    "all on: every socket gets its value",
    same(Object.keys(a), ALL) &&
      close(scalarOf(a.left), 0.2) &&
      close(scalarOf(a.right), 0.6) &&
      close(scalarOf(a.top), 0.3) &&
      close(scalarOf(a.bottom), 0.7) &&
      !!br &&
      close(br[0], 0.6) &&
      close(br[1], 0.7),
    JSON.stringify(Object.keys(a))
  );
  check(
    "guides span the canvas through the edges (aspect-uncorrected height)",
    near(
      gv?.subpaths.map((s) => s.anchors.map((p) => p.pos)),
      [
        [
          [0.2, top],
          [0.2, bottom],
        ],
        [
          [0.6, top],
          [0.6, bottom],
        ],
      ]
    ) &&
      near(
        gh?.subpaths.map((s) => s.anchors.map((p) => p.pos)),
        [
          [
            [0, 0.3],
            [1, 0.3],
          ],
          [
            [0, 0.7],
            [1, 0.7],
          ],
        ]
      ),
    JSON.stringify({ gv, gh })
  );

  const empty = run({ kind: "spline", subpaths: [] }, "spline", {
    ...fresh.data.params,
    show_left: true,
    show_center: true,
    show_guides_v: true,
  });
  const e = empty.aux ?? {};
  check(
    "no content: shown sockets get empty values, hidden ones none",
    same(Object.keys(e), ["left", "center", "guides_v"]) &&
      scalarOf(e.left) === 0 &&
      (e.center as PointsValue | undefined)?.count === 0 &&
      (e.guides_v as SplineValue | undefined)?.subpaths.length === 0 &&
      (empty.primary as SplineValue | undefined)?.subpaths.length === 0,
    JSON.stringify(e)
  );

  const pts = pointsFromArray([{ pos: [0.25, 0.75] }, { pos: [0.45, 0.35] }]);
  const fromPoints = run(pts, "points", { ...fresh.data.params, show_center: true });
  const pc = pt(fromPoints.aux?.center);
  check(
    "points source measures too",
    !!pc && close(pc[0], 0.35) && close(pc[1], 0.55),
    JSON.stringify(fromPoints.aux)
  );
}

// --- 4. the load migration (pure) ---
{
  const legacy: Record<string, unknown> = {};
  migrateBoundingBoxParams(legacy);
  check(
    "pre-toggle save: the 14 measurement sockets on, guides off",
    ALL.every((n) => legacy[showParamName(n)] === !GUIDES.has(n)),
    JSON.stringify(legacy)
  );
  const withGuides: Record<string, unknown> = { guides: true };
  migrateBoundingBoxParams(withGuides);
  check(
    "pre-toggle save with guides on: every socket on, `guides` dropped",
    ALL.every((n) => withGuides[showParamName(n)] === true) && !("guides" in withGuides),
    JSON.stringify(withGuides)
  );
  const withGuidesOff: Record<string, unknown> = { guides: false };
  migrateBoundingBoxParams(withGuidesOff);
  check(
    "pre-toggle save with guides off: guides stay off, `guides` dropped",
    same(withGuidesOff, legacy),
    JSON.stringify(withGuidesOff)
  );
  const again = { ...withGuides };
  migrateBoundingBoxParams(again);
  check("migration is idempotent", same(again, withGuides));
  const current = { ...fresh.data.params, show_center: true };
  const before = JSON.stringify(current);
  migrateBoundingBoxParams(current);
  check("a current node (all-off toggles saved) is not mistaken for legacy", JSON.stringify(current) === before);

  // An editor that hot-reloads onto this def keeps its in-memory nodes and
  // never re-runs the load migration: an un-migrated node must still resolve
  // (and compute) exactly the set the migration would pin, or the editor's
  // prune effect drops its wires.
  const shownBy = (p: Record<string, unknown>) => def.resolveAuxOutputs!(p).map((a) => a.name);
  const pinnedOn = (p: Record<string, unknown>) => ALL.filter((n) => p[showParamName(n)] === true);
  check(
    "un-migrated node resolves the pre-toggle set (guides off)",
    same(shownBy({}), pinnedOn(legacy)) && shownBy({}).length === 14,
    shownBy({}).join(",")
  );
  check(
    "un-migrated node with guides on resolves all sixteen",
    same(shownBy({ guides: true }), pinnedOn(withGuides)) && shownBy({ guides: true }).length === 16
  );
  const ctx = { time: 0, playing: false, state: {}, width: 1920, height: 1080 } as unknown as RenderContext;
  const raw = def.compute({
    inputs: { source: pointsFromArray([{ pos: [0.1, 0.2] }, { pos: [0.3, 0.4] }]) },
    auxIn: {},
    params: { guides: true },
    ctx,
    nodeId: "bb",
  }) as { aux?: Record<string, SocketValue> };
  check(
    "un-migrated node computes every socket it shows",
    same(Object.keys(raw.aux ?? {}), shownBy({ guides: true })),
    JSON.stringify(Object.keys(raw.aux ?? {}))
  );
}

// --- 5. end to end through deserializeGraph ---
{
  const block = {
    animated: true,
    trackVisible: true,
    keyframes: [
      { tick: 0, value: true },
      { tick: 30, value: false },
    ],
  };
  const saved = {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [
      { id: "shape", defType: "circle", position: { x: 0, y: 0 }, params: {} },
      { id: "clock", defType: "scene-time", position: { x: 0, y: 200 }, params: {} },
      {
        id: "bb",
        defType: "bounding-box",
        position: { x: 300, y: 0 },
        params: { guides: true },
        exposedParams: ["guides"],
        controlParams: ["guides"],
        animation: { guides: block },
      },
      { id: "use1", defType: "transform", position: { x: 600, y: 0 }, params: {} },
      { id: "use2", defType: "transform", position: { x: 600, y: 200 }, params: {} },
    ],
    edges: [
      { id: "e1", source: "shape", sourceHandle: "out:primary", target: "bb", targetHandle: "in:source" },
      { id: "e2", source: "bb", sourceHandle: "out:aux:center", target: "use1", targetHandle: "in:image" },
      { id: "e3", source: "bb", sourceHandle: "out:aux:guides_v", target: "use2", targetHandle: "in:image" },
      { id: "e4", source: "clock", sourceHandle: "out:primary", target: "bb", targetHandle: "in:param:guides" },
    ],
  } as unknown as SavedProject;
  const res = await deserializeGraph(saved);
  const bb = res.nodes.find((n) => n.id === "bb")!.data;
  check(
    "loading pins the old set as explicit toggles and drops `guides`",
    same(bb.params, allOn),
    JSON.stringify(bb.params)
  );
  check(
    "a legacy node loads every socket it had",
    same(bb.auxOutputs.map((a) => a.name), ALL),
    JSON.stringify(bb.auxOutputs.map((a) => a.name))
  );
  // EffectsApp's prune rule: a wire out of a missing aux socket, or into an
  // un-exposed param socket, is dropped on the next render.
  const byId = new Map(res.nodes.map((n) => [n.id, n]));
  const pruned = res.edges.filter((e) => {
    const src = byId.get(e.source);
    if (src && e.sourceHandle?.startsWith("out:aux:")) {
      const name = e.sourceHandle.slice("out:aux:".length);
      if (!src.data.auxOutputs.some((x) => x.name === name)) return true;
    }
    const tgt = byId.get(e.target);
    if (e.targetHandle?.startsWith("in:param:")) {
      return !(tgt?.data.exposedParams ?? []).includes(e.targetHandle.slice("in:param:".length));
    }
    return false;
  });
  check("no saved wire would be pruned", pruned.length === 0, pruned.map((e) => e.id).join(", "));
  check(
    "exposed / controlled `guides` → both guide toggles",
    same(bb.exposedParams, ["show_guides_v", "show_guides_h"]) &&
      same(bb.controlParams, ["show_guides_v", "show_guides_h"]),
    JSON.stringify({ exposed: bb.exposedParams, control: bb.controlParams })
  );
  check(
    "keyframed `guides` → the same track on both guide toggles",
    (bb.animation as any)?.show_guides_v === block &&
      (bb.animation as any)?.show_guides_h === block &&
      (bb.animation as any)?.guides === undefined,
    JSON.stringify(bb.animation)
  );
  const paramWires = res.edges.filter((e) => e.target === "bb" && e.targetHandle?.startsWith("in:param:"));
  check(
    "the wire into exposed `guides` fans out to both toggles",
    same(paramWires.map((e) => e.targetHandle).sort(), ["in:param:show_guides_h", "in:param:show_guides_v"]) &&
      paramWires.every((e) => e.source === "clock") &&
      new Set(res.edges.map((e) => e.id)).size === res.edges.length,
    JSON.stringify(paramWires)
  );

  const reloaded = await deserializeGraph(await serializeGraph(res.nodes, res.edges));
  const bb2 = reloaded.nodes.find((n) => n.id === "bb")!.data;
  check(
    "re-save → re-load is stable",
    same(bb2.params, bb.params) &&
      same(bb2.exposedParams, bb.exposedParams) &&
      same(bb2.controlParams, bb.controlParams) &&
      same(bb2.auxOutputs, bb.auxOutputs) &&
      same(
        reloaded.edges.map((e) => e.id).sort(),
        res.edges.map((e) => e.id).sort()
      )
  );

  const current = await deserializeGraph({
    schemaVersion: CURRENT_SCHEMA,
    nodes: [
      {
        id: "bb",
        defType: "bounding-box",
        position: { x: 0, y: 0 },
        params: { ...fresh.data.params, show_center: true },
      },
    ],
    edges: [],
  } as unknown as SavedProject);
  check(
    "a current save loads exactly its toggles",
    same(current.nodes[0].data.auxOutputs.map((a) => a.name), ["center"]),
    JSON.stringify(current.nodes[0].data.auxOutputs)
  );
}

// --- 6. recipes / MCP: a hidden socket fails with the toggle named ---
{
  const xf = makeInstanceNode("transform", { x: 0, y: 0 });
  const wire = [
    { id: "w", source: "bb", sourceHandle: "out:aux:center", target: "t", targetHandle: "in:image" },
  ];
  const hidden = validateGraph(
    [
      { id: "bb", defType: "bounding-box", params: fresh.data.params },
      { id: "t", defType: "transform", params: xf.data.params },
    ],
    wire
  );
  const msg = hidden.issues.find((i) => i.code === "EDGE_UNKNOWN_OUTPUT")?.message ?? "";
  check("wiring a hidden socket names its toggle", msg.includes("set show_center: true"), msg);
  const shown = validateGraph(
    [
      { id: "bb", defType: "bounding-box", params: { ...fresh.data.params, show_center: true } },
      { id: "t", defType: "transform", params: xf.data.params },
    ],
    wire
  );
  check(
    "with the toggle on the same wire resolves",
    !shown.issues.some((i) => i.code === "EDGE_UNKNOWN_OUTPUT"),
    JSON.stringify(shown.issues)
  );

  const built = buildRecipe({
    name: "bbox center",
    nodes: [
      { id: "shape", type: "circle" },
      { id: "bb", type: "bounding-box", params: { show_center: true } },
      { id: "t", type: "transform" },
    ],
    edges: [
      { from: "shape:out", to: "bb:in:source" },
      { from: "bb:aux:center", to: "t:in:image" },
    ],
    outputs: [{ name: "box", from: "bb:out", type: "spline" }],
  });
  const val = validateGraph(
    built.nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
    built.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: (e.sourceHandle ?? "") as string,
      target: e.target,
      targetHandle: (e.targetHandle ?? "") as string,
    }))
  );
  check(
    "a recipe that sets show_center can wire aux:center",
    built.edges.some((e) => e.sourceHandle === "out:aux:center") &&
      !val.issues.some((i) => i.code === "EDGE_UNKNOWN_OUTPUT"),
    JSON.stringify(val.issues.filter((i) => i.severity === "error"))
  );

  const cat = buildNodeCatalog(allNodeDefs()).find((n) => n.type === "bounding-box");
  check(
    "catalog: all sixteen sockets, sixteen settable toggles, no `guides`",
    !!cat &&
      cat.dynamic === true &&
      same(cat.aux.map((x) => x.name), ALL) &&
      same(cat.params.map((p) => p.name), ALL.map(showParamName)) &&
      cat.params.every((p) => p.settable && p.default === false),
    JSON.stringify(cat?.params.map((p) => p.name))
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall bounding-box checks passed");
