// check-node-layout: guards the pure wire-aware layout (src/state/node-layout.ts,
// specdocs/090626_tidy-layout.md) — the module behind right-click Tidy /
// Align / Distribute, the `tidy` MCP tool, and agent insertion placement.
//
// What it pins down: columns follow the wires left→right (never a wire that
// runs backwards), a single wire between two nodes comes out horizontal,
// fan-in producers keep socket order and the consumer sits in their middle,
// sources hug their consumer's column, boundary pillars pin the first / last
// column, zones and frames stay contiguous compound units, reroutes land in
// the gap on their source row, nothing overlaps, unselected nodes are left
// alone, the result is anchored on the selection's old centre, and — the
// one the agent workflow depends on — tidy is IDEMPOTENT (a tidy graph
// tidies to itself). Plus align / distribute basics and placeNewNodes.
//
//   npx tsx scripts/check-node-layout.mts

import {
  tidyLayout,
  alignLayout,
  distributeLayout,
  placeNewNodes,
  estimateNodeGeometry,
  COLUMN_GAP,
  ROW_GAP,
  CLUSTER_PADDING,
  REROUTE_SIZE,
  type LayoutNode,
  type LayoutEdge,
  type LayoutKind,
  type XY,
} from "../src/state/node-layout";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++;
    return;
  }
  failures++;
  console.error(`✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// --- fixtures ----------------------------------------------------------------

interface Spec {
  x?: number;
  y?: number;
  ins?: string[];
  outs?: string[];
  kind?: LayoutKind;
  parentId?: string;
  frameId?: string;
  width?: number;
  height?: number;
}

function mk(id: string, spec: Spec = {}): LayoutNode {
  const ins = spec.ins ?? ["in:image"];
  const outs = spec.outs ?? ["out:primary"];
  if (spec.kind === "reroute") {
    return {
      id,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      width: REROUTE_SIZE,
      height: REROUTE_SIZE,
      kind: "reroute",
      parentId: spec.parentId,
      frameId: spec.frameId,
      inputs: [{ id: "in:value", y: REROUTE_SIZE / 2 }],
      outputs: [{ id: "out:primary", y: REROUTE_SIZE / 2 }],
    };
  }
  const g = estimateNodeGeometry({
    inputHandles: ins.map((h) => (h.startsWith("in:") ? h : `in:${h}`)),
    outputHandles: outs,
    uiWidth: spec.width,
    uiHeight: spec.height,
  });
  return {
    id,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    width: g.width,
    height: g.height,
    kind: spec.kind ?? "node",
    parentId: spec.parentId,
    frameId: spec.frameId,
    inputs: g.inputs,
    outputs: g.outputs,
  };
}

function wire(
  source: string,
  target: string,
  targetHandle = "in:image",
  sourceHandle = "out:primary"
): LayoutEdge {
  const th = targetHandle.startsWith("in:") ? targetHandle : `in:${targetHandle}`;
  return { source, sourceHandle, target, targetHandle: th };
}

function apply(nodes: LayoutNode[], moves: Map<string, XY>): LayoutNode[] {
  return nodes.map((n) => {
    const m = moves.get(n.id);
    return m ? { ...n, x: m.x, y: m.y } : n;
  });
}

function box(n: LayoutNode) {
  return { l: n.x, t: n.y, r: n.x + n.width, b: n.y + n.height };
}

function overlaps(a: LayoutNode, b: LayoutNode): boolean {
  const A = box(a);
  const B = box(b);
  return A.l < B.r && B.l < A.r && A.t < B.b && B.t < A.b;
}

function noOverlaps(name: string, nodes: LayoutNode[], ids?: Set<string>) {
  const list = nodes.filter((n) => n.kind !== "frame" && (!ids || ids.has(n.id)));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      // Zone shells / inputs vs their members are inside one compound; the
      // compound layout keeps those apart too, so every pair must be clear.
      if (overlaps(list[i], list[j])) {
        check(`${name}: no overlap ${list[i].id}/${list[j].id}`, false, {
          a: box(list[i]),
          b: box(list[j]),
        });
        return;
      }
    }
  }
  check(`${name}: no overlaps`, true);
}

function portAbs(n: LayoutNode, dir: "in" | "out", handle: string): number {
  const list = dir === "in" ? n.inputs : n.outputs;
  return n.y + (list.find((p) => p.id === handle)?.y ?? n.height / 2);
}

function wiresForward(name: string, nodes: LayoutNode[], edges: LayoutEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = byId.get(e.source)!;
    const t = byId.get(e.target)!;
    // A member wiring into its own zone shell (collect) lands on the shell's
    // left edge which sits at the zone's right — still forward.
    if (s.x + s.width > t.x) {
      check(`${name}: wire ${e.source}→${e.target} runs forward`, false, {
        sRight: s.x + s.width,
        tLeft: t.x,
      });
      return;
    }
  }
  check(`${name}: all wires run forward`, true);
}

function byId(nodes: LayoutNode[]) {
  return new Map(nodes.map((n) => [n.id, n]));
}

// --- 1. a chain -----------------------------------------------------------------

{
  const nodes = [
    mk("a", { x: 500, y: 500, ins: [] }),
    mk("b", { x: 100, y: 900 }),
    mk("c", { x: 900, y: 100 }),
  ];
  const edges = [wire("a", "b"), wire("b", "c")];
  const out = apply(nodes, tidyLayout(nodes, edges, ["a", "b", "c"]));
  const m = byId(out);
  wiresForward("chain", out, edges);
  noOverlaps("chain", out);
  check(
    "chain: exactly one column gap between consecutive nodes",
    m.get("b")!.x - (m.get("a")!.x + m.get("a")!.width) === COLUMN_GAP &&
      m.get("c")!.x - (m.get("b")!.x + m.get("b")!.width) === COLUMN_GAP,
    out.map((n) => [n.id, n.x])
  );
  check(
    "chain: wires are horizontal",
    Math.abs(portAbs(m.get("a")!, "out", "out:primary") - portAbs(m.get("b")!, "in", "in:image")) <= 1 &&
      Math.abs(portAbs(m.get("b")!, "out", "out:primary") - portAbs(m.get("c")!, "in", "in:image")) <= 1,
    out.map((n) => [n.id, n.y])
  );
  // Anchor: the bbox centre stays put.
  const c0 = bboxCenter(nodes);
  const c1 = bboxCenter(out);
  check("chain: anchored on the old bbox centre", Math.abs(c0.x - c1.x) <= 1 && Math.abs(c0.y - c1.y) <= 1, { c0, c1 });
  // Idempotent.
  const again = apply(out, tidyLayout(out, edges, ["a", "b", "c"]));
  check("chain: idempotent", maxMove(out, again) <= 1, maxMove(out, again));
}

function bboxCenter(nodes: LayoutNode[]) {
  let l = Infinity,
    t = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const n of nodes) {
    if (n.kind === "frame") continue;
    l = Math.min(l, n.x);
    t = Math.min(t, n.y);
    r = Math.max(r, n.x + n.width);
    b = Math.max(b, n.y + n.height);
  }
  return { x: (l + r) / 2, y: (t + b) / 2 };
}

function maxMove(a: LayoutNode[], b: LayoutNode[]): number {
  const mb = byId(b);
  let d = 0;
  for (const n of a) {
    const o = mb.get(n.id)!;
    d = Math.max(d, Math.abs(n.x - o.x), Math.abs(n.y - o.y));
  }
  return d;
}

// --- 2. fan-in: socket order + consumer in the middle ------------------------------

{
  const nodes = [
    mk("s1", { x: 0, y: 600, ins: [] }),
    mk("s2", { x: 0, y: 0, ins: [] }),
    mk("s3", { x: 0, y: 300, ins: [] }),
    mk("merge", { x: 400, y: 200, ins: ["layer1", "layer2", "layer3"] }),
    mk("out", { x: 800, y: 200, ins: ["image"], outs: [], kind: "groupOutput" }),
  ];
  const edges = [
    wire("s1", "merge", "layer1"),
    wire("s2", "merge", "layer2"),
    wire("s3", "merge", "layer3"),
    wire("merge", "out"),
  ];
  const ids = nodes.map((n) => n.id);
  const out = apply(nodes, tidyLayout(nodes, edges, ids));
  const m = byId(out);
  wiresForward("fan-in", out, edges);
  noOverlaps("fan-in", out);
  check(
    "fan-in: producers follow socket order top→bottom",
    m.get("s1")!.y < m.get("s2")!.y && m.get("s2")!.y < m.get("s3")!.y,
    out.map((n) => [n.id, n.y])
  );
  const merge = m.get("merge")!;
  const srcTop = Math.min(m.get("s1")!.y, m.get("s2")!.y, m.get("s3")!.y);
  const srcBot = Math.max(...["s1", "s2", "s3"].map((id) => m.get(id)!.y + m.get(id)!.height));
  const mergeMid = merge.y + merge.height / 2;
  check(
    "fan-in: consumer sits in the vertical middle of its producers",
    Math.abs(mergeMid - (srcTop + srcBot) / 2) <= 30,
    { mergeMid, srcMid: (srcTop + srcBot) / 2 }
  );
  check(
    "fan-in: the middle wire is horizontal",
    Math.abs(portAbs(m.get("s2")!, "out", "out:primary") - portAbs(merge, "in", "in:layer2")) <= 1
  );
  check("fan-in: Group Output pins the last column", m.get("out")!.x > merge.x + merge.width);
  const again = apply(out, tidyLayout(out, edges, ids));
  check("fan-in: idempotent", maxMove(out, again) <= 1, maxMove(out, again));
}

// --- 3. satellite pulls right against its consumer --------------------------------

{
  const nodes = [
    mk("src", { x: 0, y: 0, ins: [] }),
    mk("blur", { x: 300, y: 0 }),
    mk("noise", { x: 0, y: 400, ins: [] }),
    mk("displace", { x: 600, y: 0, ins: ["image", "map"] }),
    mk("out", { x: 900, y: 0, outs: [], kind: "groupOutput" }),
  ];
  const edges = [
    wire("src", "blur"),
    wire("blur", "displace", "image"),
    wire("noise", "displace", "map"),
    wire("displace", "out"),
  ];
  const ids = nodes.map((n) => n.id);
  const out = apply(nodes, tidyLayout(nodes, edges, ids));
  const m = byId(out);
  wiresForward("satellite", out, edges);
  noOverlaps("satellite", out);
  check(
    "satellite: noise shares blur's column (pulled right), not src's",
    Math.abs(m.get("noise")!.x + m.get("noise")!.width - (m.get("blur")!.x + m.get("blur")!.width)) <= 1,
    out.map((n) => [n.id, n.x])
  );
  check(
    "satellite: noise hangs below the chain, chain above it",
    m.get("noise")!.y > m.get("blur")!.y,
    out.map((n) => [n.id, n.y])
  );
  const again = apply(out, tidyLayout(out, edges, ids));
  check("satellite: idempotent", maxMove(out, again) <= 1, maxMove(out, again));
}

// --- 4. unselected nodes are ignored and untouched ---------------------------------

{
  const nodes = [
    mk("a", { x: 0, y: 0, ins: [] }),
    mk("b", { x: 50, y: 50 }),
    mk("far", { x: 2000, y: 2000 }),
  ];
  const edges = [wire("a", "b"), wire("b", "far")];
  const moves = tidyLayout(nodes, edges, ["a", "b"]);
  check("ignore: unselected node never appears in the result", !moves.has("far"));
  const out = apply(nodes, moves);
  const m = byId(out);
  check(
    "ignore: selected pair lays out as if alone (b just right of a)",
    m.get("b")!.x - (m.get("a")!.x + m.get("a")!.width) === COLUMN_GAP,
    out.map((n) => [n.id, n.x])
  );
}

// --- 5. group pillars pin first / last ------------------------------------------------

{
  const nodes = [
    mk("gi", { x: 900, y: 0, ins: [], outs: ["out:aux:image", "out:aux:amount"], kind: "groupInput" }),
    mk("value", { x: 0, y: 300, ins: [] }),
    mk("fx", { x: 100, y: 0, ins: ["image", "amount"] }),
    mk("go", { x: 0, y: 0, ins: ["image"], outs: [], kind: "groupOutput" }),
  ];
  const edges = [
    wire("gi", "fx", "image", "out:aux:image"),
    wire("value", "fx", "amount"),
    wire("fx", "go"),
  ];
  const ids = nodes.map((n) => n.id);
  const out = apply(nodes, tidyLayout(nodes, edges, ids));
  const m = byId(out);
  wiresForward("pillars", out, edges);
  noOverlaps("pillars", out);
  const xs = out.map((n) => n.x);
  check("pillars: Group Input is leftmost", m.get("gi")!.x === Math.min(...xs), out.map((n) => [n.id, n.x]));
  check("pillars: Group Output is rightmost", m.get("go")!.x === Math.max(...xs), out.map((n) => [n.id, n.x]));
}

// --- 6. zone: compound unit, input first, shell last, members inside ---------------

{
  const nodes = [
    mk("src", { x: 0, y: 0, ins: [] }),
    mk("shell", { x: 50, y: 50, ins: ["collect"], outs: ["out:aux:result"], kind: "zoneShell" }),
    mk("zin", { x: 900, y: 900, ins: [], outs: ["out:aux:element"], kind: "zoneInput", parentId: "shell" }),
    mk("body", { x: 400, y: -300, parentId: "shell" }),
    mk("post", { x: 20, y: 20 }),
    mk("out", { x: 0, y: 0, outs: [], kind: "groupOutput" }),
  ];
  const edges = [
    wire("src", "zin", "in:image"),
    wire("zin", "body", "image", "out:aux:element"),
    wire("body", "shell", "collect"),
    wire("shell", "post", "image", "out:aux:result"),
    wire("post", "out"),
  ];
  // Select the shell only — its zone comes along.
  const moves = tidyLayout(nodes, edges, ["src", "shell", "post", "out"]);
  check("zone: selecting the shell brings Input and members", moves.has("zin") && moves.has("body"));
  const out = apply(nodes, moves);
  const m = byId(out);
  wiresForward("zone", out, edges);
  noOverlaps("zone", out);
  const zin = m.get("zin")!;
  const body = m.get("body")!;
  const shell = m.get("shell")!;
  check("zone: Input → body → shell run left to right inside the zone", zin.x < body.x && body.x + body.width < shell.x, [zin.x, body.x, shell.x]);
  // The zone rect (union + padding) must not be entered by outside nodes.
  const zl = Math.min(zin.x, body.x, shell.x) - CLUSTER_PADDING;
  const zr = Math.max(zin.x + zin.width, body.x + body.width, shell.x + shell.width) + CLUSTER_PADDING;
  for (const id of ["src", "post", "out"]) {
    const n = m.get(id)!;
    check(`zone: ${id} stays outside the zone rect`, n.x + n.width <= zl + 1 || n.x >= zr - 1, { id, l: n.x, r: n.x + n.width, zl, zr });
  }
  const ids = ["src", "shell", "post", "out"];
  const again = apply(out, tidyLayout(out, edges, ids));
  check("zone: idempotent", maxMove(out, again) <= 1, maxMove(out, again));
}

// --- 7. frame: members contiguous, frame node untouched --------------------------------

{
  const nodes = [
    mk("frame", { x: 0, y: 0, kind: "frame" }),
    mk("a", { x: 0, y: 0, ins: [], frameId: "frame" }),
    mk("b", { x: 0, y: 0, frameId: "frame" }),
    mk("side", { x: 0, y: 0, ins: [] }),
    mk("c", { x: 0, y: 0, ins: ["image", "mask"] }),
  ];
  const edges = [wire("a", "b"), wire("b", "c", "image"), wire("side", "c", "mask")];
  const ids = nodes.map((n) => n.id);
  const moves = tidyLayout(nodes, edges, ids);
  check("frame: the frame node itself is not moved", !moves.has("frame"));
  const out = apply(nodes, moves);
  const m = byId(out);
  wiresForward("frame", out, edges);
  noOverlaps("frame", out);
  const fl = Math.min(m.get("a")!.x, m.get("b")!.x) - CLUSTER_PADDING;
  const fr = Math.max(m.get("a")!.x + m.get("a")!.width, m.get("b")!.x + m.get("b")!.width) + CLUSTER_PADDING;
  const ft = Math.min(m.get("a")!.y, m.get("b")!.y) - CLUSTER_PADDING;
  const fb = Math.max(m.get("a")!.y + m.get("a")!.height, m.get("b")!.y + m.get("b")!.height) + CLUSTER_PADDING;
  for (const id of ["side", "c"]) {
    const n = m.get(id)!;
    const inside = n.x < fr && n.x + n.width > fl && n.y < fb && n.y + n.height > ft;
    check(`frame: ${id} stays outside the frame rect`, !inside, { id, n: box(n), fl, fr, ft, fb });
  }
}

// --- 8. reroute lands in the gap on its source row -----------------------------------

{
  const nodes = [
    mk("a", { x: 0, y: 0, ins: [] }),
    mk("r", { x: 500, y: 500, kind: "reroute" }),
    mk("b", { x: 0, y: 0 }),
    mk("c", { x: 0, y: 0 }),
  ];
  const edges = [
    { source: "a", sourceHandle: "out:primary", target: "r", targetHandle: "in:value" },
    wire("r", "b"),
    wire("r", "c"),
  ];
  const ids = nodes.map((n) => n.id);
  const out = apply(nodes, tidyLayout(nodes, edges, ids));
  const m = byId(out);
  noOverlaps("reroute", out);
  const a = m.get("a")!;
  const r = m.get("r")!;
  check(
    "reroute: b and c share the column right after a (reroute is pass-through)",
    m.get("b")!.x === m.get("c")!.x && m.get("b")!.x - (a.x + a.width) === COLUMN_GAP,
    out.map((n) => [n.id, n.x])
  );
  check("reroute: dot sits in the gap", r.x > a.x + a.width && r.x + r.width < m.get("b")!.x, [a.x + a.width, r.x, m.get("b")!.x]);
  check(
    "reroute: dot is on a's output row",
    Math.abs(portAbs(a, "out", "out:primary") - portAbs(r, "in", "in:value")) <= 1
  );
}

// --- 9. a cycle never hangs -------------------------------------------------------------

{
  const nodes = [mk("a", { x: 0, y: 0 }), mk("b", { x: 0, y: 0 }), mk("c", { x: 0, y: 0 })];
  const edges = [wire("a", "b"), wire("b", "c"), wire("c", "a")];
  const moves = tidyLayout(nodes, edges, ["a", "b", "c"]);
  check("cycle: every node placed", moves.size === 3);
  noOverlaps("cycle", apply(nodes, moves));
}

// --- 10. stability: adding a node keeps the rest's column order --------------------------

{
  const base = [
    mk("a", { x: 0, y: 0, ins: [] }),
    mk("b", { x: 0, y: 0 }),
    mk("c", { x: 0, y: 0, ins: ["image", "mask"] }),
    mk("m", { x: 0, y: 0, ins: [] }),
  ];
  const edges = [wire("a", "b"), wire("b", "c", "image"), wire("m", "c", "mask")];
  const tidy1 = apply(base, tidyLayout(base, edges, base.map((n) => n.id)));
  const grown = [...tidy1, mk("n", { x: 0, y: 0, ins: [] })];
  const edges2 = [...edges, wire("n", "b")];
  // b now has two inputs; give it the socket.
  const grown2 = grown.map((n) => (n.id === "b" ? mk("b", { x: n.x, y: n.y, ins: ["image", "extra"] }) : n));
  const edges3 = edges2.map((e) => (e.source === "n" ? wire("n", "b", "extra") : e));
  const tidy2 = apply(grown2, tidyLayout(grown2, edges3, grown2.map((n) => n.id)));
  const m1 = byId(tidy1);
  const m2 = byId(tidy2);
  check(
    "stability: a→b→c keep their left-to-right order after adding a node",
    m2.get("a")!.x < m2.get("b")!.x && m2.get("b")!.x < m2.get("c")!.x
  );
  check(
    "stability: m stays below the chain as it was",
    Math.sign(m1.get("m")!.y - m1.get("c")!.y) === Math.sign(m2.get("m")!.y - m2.get("c")!.y)
  );
}

// --- 11. align --------------------------------------------------------------------------

{
  const nodes = [
    mk("a", { x: 10, y: 10 }),
    mk("b", { x: 200, y: 400, width: 300 }),
    mk("c", { x: 50, y: 800 }),
  ];
  const ids = ["a", "b", "c"];
  const left = apply(nodes, alignLayout(nodes, ids, "left"));
  check("align left", left.every((n) => n.x === 10), left.map((n) => n.x));
  const right = apply(nodes, alignLayout(nodes, ids, "right"));
  check("align right", right.every((n) => n.x + n.width === 500), right.map((n) => n.x + n.width));
  const top = apply(nodes, alignLayout(nodes, ids, "top"));
  check("align top", top.every((n) => n.y === 10), top.map((n) => n.y));
  const cy = apply(nodes, alignLayout(nodes, ids, "centerY"));
  const mids = cy.map((n) => n.y + n.height / 2);
  check("align centerY", mids.every((v) => Math.abs(v - mids[0]) <= 1), mids);
  check("align: single node is a no-op", alignLayout(nodes, ["a"], "left").size === 0);
  // A zone moves as one thing.
  const zoned = [
    mk("shell", { x: 500, y: 500, kind: "zoneShell" }),
    mk("zin", { x: 300, y: 500, kind: "zoneInput", parentId: "shell" }),
    mk("lone", { x: 0, y: 0 }),
  ];
  const zm = alignLayout(zoned, ["shell", "lone"], "top");
  const za = apply(zoned, zm);
  const zmap = byId(za);
  check(
    "align: zone shell + input move together",
    zmap.get("shell")!.y - zmap.get("zin")!.y === 0 && zmap.get("shell")!.y === 0,
    za.map((n) => [n.id, n.y])
  );
}

// --- 12. distribute ---------------------------------------------------------------------

{
  const nodes = [
    mk("a", { x: 0, y: 0 }),
    mk("b", { x: 100, y: 0 }),
    mk("c", { x: 1000, y: 0 }),
  ];
  const out = apply(nodes, distributeLayout(nodes, ["a", "b", "c"], "x"));
  const m = byId(out);
  const g1 = m.get("b")!.x - (m.get("a")!.x + m.get("a")!.width);
  const g2 = m.get("c")!.x - (m.get("b")!.x + m.get("b")!.width);
  check("distribute x: equal gaps, ends fixed", Math.abs(g1 - g2) <= 1 && m.get("a")!.x === 0 && m.get("c")!.x === 1000, { g1, g2 });
  const stacked = [mk("a", { x: 0, y: 0 }), mk("b", { x: 0, y: 10 }), mk("c", { x: 0, y: 20 })];
  const sy = apply(stacked, distributeLayout(stacked, ["a", "b", "c"], "y"));
  noOverlaps("distribute y (overlapping input separates)", sy);
  const sm = byId(sy);
  check("distribute y: falls back to the row gap when boxes overlap", sm.get("b")!.y - (sm.get("a")!.y + sm.get("a")!.height) === ROW_GAP);
}

// --- 13. placeNewNodes ------------------------------------------------------------------

{
  // src sits far enough left that the slot before fx is free; the
  // occupied-slot case (drop down the column) is covered by the chain below.
  const existing = [
    mk("src", { x: -400, y: 0, ins: [] }),
    mk("fx", { x: 400, y: 0, ins: ["image", "amount"] }),
    mk("out", { x: 800, y: 0, outs: [], kind: "groupOutput" }),
  ];
  const fresh = [
    mk("val", { x: 0, y: 0, ins: [] }),
    mk("noise", { x: 0, y: 0, ins: [] }),
  ];
  const nodes = [...existing, ...fresh];
  const edges = [
    wire("src", "fx", "image"),
    wire("fx", "out"),
    wire("val", "fx", "amount"),
  ];
  const moves = placeNewNodes(nodes, edges, ["val", "noise"]);
  check("place: only new nodes move", moves.size === 2 && !moves.has("src") && !moves.has("fx"));
  const out = apply(nodes, moves);
  const m = byId(out);
  const fx = m.get("fx")!;
  const val = m.get("val")!;
  check("place: wired node lands one gap left of its consumer", fx.x - (val.x + val.width) === COLUMN_GAP, { fx: fx.x, val: val.x });
  check(
    "place: wired node is aligned to the row it feeds",
    Math.abs(portAbs(val, "out", "out:primary") - portAbs(fx, "in", "in:amount")) <= 1
  );
  noOverlaps("place", out);
  const busy = [...existing, mk("v1", { x: 0, y: 0, ins: [] }), mk("v2", { x: 0, y: 0, ins: [] })];
  const busyEdges = [wire("src", "fx", "image"), wire("fx", "out"), wire("v1", "fx", "amount"), wire("v2", "fx", "amount")];
  const busyOut = apply(busy, placeNewNodes(busy, busyEdges, ["v1", "v2"]));
  noOverlaps("place: second node into an occupied slot drops down", busyOut);
  const bm = byId(busyOut);
  check("place: both new nodes stay left of the consumer", bm.get("v1")!.x + bm.get("v1")!.width < bm.get("fx")!.x && bm.get("v2")!.x + bm.get("v2")!.width < bm.get("fx")!.x);
  const noise = m.get("noise")!;
  check("place: unwired node goes below everything", noise.y >= Math.max(...existing.map((n) => n.y + n.height)) + ROW_GAP - 1, noise.y);
  // Chain of new nodes: consumer places first, producer builds back.
  const chainNew = [mk("p", { x: 0, y: 0, ins: [] }), mk("q", { x: 0, y: 0 })];
  const nodes2 = [...existing, ...chainNew];
  const edges2 = [wire("src", "fx", "image"), wire("fx", "out"), wire("p", "q"), wire("q", "fx", "amount")];
  const mv2 = placeNewNodes(nodes2, edges2, ["p", "q"]);
  const o2 = byId(apply(nodes2, mv2));
  check("place: chain builds back from the consumer", o2.get("p")!.x + o2.get("p")!.width < o2.get("q")!.x && o2.get("q")!.x + o2.get("q")!.width < o2.get("fx")!.x, [o2.get("p")!.x, o2.get("q")!.x, o2.get("fx")!.x]);
  noOverlaps("place chain", apply(nodes2, mv2));
}

// --- 14. estimate geometry ----------------------------------------------------------------

{
  const g = estimateNodeGeometry({ inputHandles: ["in:a", "in:b"], outputHandles: ["out:primary"] });
  check("estimate: rows stack by ROW_H", g.inputs[1].y - g.inputs[0].y === 22 && g.height > g.inputs[1].y);
  const w = estimateNodeGeometry({ inputHandles: [], outputHandles: [], uiWidth: 333, uiHeight: 444 });
  check("estimate: uiWidth/uiHeight win", w.width === 333 && w.height === 444);
}

// --- 15. an origin-anchored fragment (recipe interior) starts at (0,0) --------------------

{
  const nodes = [mk("a", { x: 0, y: 0, ins: [] }), mk("b", { x: 260, y: 0 }), mk("c", { x: 520, y: 0, ins: ["image", "mask"] }), mk("m", { x: 780, y: 0, ins: [] })];
  const edges = [wire("a", "b"), wire("b", "c", "image"), wire("m", "c", "mask")];
  const out = apply(nodes, tidyLayout(nodes, edges, nodes.map((n) => n.id), { anchor: "origin" }));
  check("origin anchor: min x/y are 0", Math.min(...out.map((n) => n.x)) === 0 && Math.min(...out.map((n) => n.y)) === 0, out.map((n) => [n.id, n.x, n.y]));
  const m = byId(out);
  check("origin anchor: the strip became wire-aware (m beside c, not at the far right)", m.get("m")!.x < m.get("c")!.x, out.map((n) => [n.id, n.x]));
}

console.log(`check-node-layout: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
