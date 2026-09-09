// Wire-aware node layout — PURE (specdocs/090626_tidy-layout.md).
//
// `tidyLayout` lays a set of nodes out as a left→right layered graph with
// the rules that make a node graph read as hand-drawn: columns from the
// wires (longest-path rank, then pulled right against the first consumer),
// vertical placement that aligns each wire's two handles so it runs
// straight, fan-in ordered by socket row, sources right-aligned in their
// column, inline zones / frames laid out recursively as compound units,
// boundary pillars pinned to the first / last column, reroutes re-placed
// on their source's output row. Column order is seeded from the current
// `y`, so a tidy graph tidies to itself (idempotent) and small edits give
// small changes. Unselected nodes are ignored entirely (owner decision) —
// the result is re-anchored on the selection's old bounding-box centre.
//
// `alignLayout` / `distributeLayout` are the plain box tools, and
// `placeNewNodes` is the insertion-time rule for agent-added nodes (beside
// the first consumer, on the row it feeds, never moving existing nodes).
//
// No DOM, no React Flow — the editor adapts xyflow nodes into `LayoutNode`
// (src/components/effects/node-layout-adapter.ts). Guarded by
// scripts/check-node-layout.mts.

export type LayoutKind =
  // Ordinary node — anything not listed below.
  | "node"
  // Reroute dot: pass-through for ranking, re-placed in the column gap.
  | "reroute"
  // Frame-zone node: never laid out itself (it hugs its members).
  | "frame"
  // Inline zone shell (Iterate / Repeat / For Each Output): with its
  // descendants it forms one compound unit; pins the zone's last column.
  | "zoneShell"
  // Zone Input: pins the zone's first column.
  | "zoneInput"
  // Group Input / Layer Input: pins the first column of its scope.
  | "groupInput"
  // Group Output / Layer Output / composition Output: pins the last column.
  | "groupOutput";

export interface LayoutPort {
  // Handle id as used on the edge (`in:<name>`, `out:primary`, …).
  id: string;
  // Handle centre, in flow px, measured DOWN from the node's top edge.
  y: number;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: LayoutKind;
  // Zone membership: the zone shell this node lives inside (its
  // `data.parentId`) when that shell is visible in the same scope.
  parentId?: string;
  // Frame membership (`data.frameId`).
  frameId?: string;
  // Visible handles, top→bottom. Missing handle ⇒ vertical centre.
  inputs: LayoutPort[];
  outputs: LayoutPort[];
}

export interface LayoutEdge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface XY {
  x: number;
  y: number;
}

export interface TidyOptions {
  // Horizontal gap between columns (flow px).
  columnGap?: number;
  // Minimum vertical gap between two boxes in one column.
  rowGap?: number;
  // Padding a compound unit (zone / frame) keeps around its members —
  // matches the zone / frame rect padding so the outer layout leaves room
  // for the drawn box.
  clusterPadding?: number;
  // Where the result lands. "center" (default) keeps the selection's
  // bounding-box centre where it was; a point puts the result's top-left
  // there; "origin" leaves it at (0,0) — for fragments that have no
  // meaningful old position (a freshly built recipe interior).
  anchor?: "center" | "origin" | XY;
}

export const COLUMN_GAP = 72;
export const ROW_GAP = 24;
export const CLUSTER_PADDING = 28;

// ---------------------------------------------------------------------------
// Box estimate for nodes React Flow has never measured (a scope that isn't
// open, a recipe interior at build time). Mirrors EffectNode's geometry:
// ROW_H / PAD_Y are its row constants; the header chip is margin 4 +
// padding 4×2 + one 11px line + 1px borders ≈ 34px including the gap to the
// body. Only a fallback — the editor passes measured boxes and React Flow's
// real handle bounds whenever it has them.
export const NODE_ROW_H = 22;
export const NODE_PAD_Y = 8;
export const NODE_HEADER_H = 34;
export const NODE_FALLBACK_W = 220;
export const REROUTE_SIZE = 22;

export interface NodeGeometrySource {
  // Visible (non-hidden) input socket handle ids, in row order.
  inputHandles: string[];
  // Output handle ids in row order (primary first, then aux).
  outputHandles: string[];
  uiWidth?: number;
  uiHeight?: number;
}

export function estimateNodeGeometry(src: NodeGeometrySource): {
  width: number;
  height: number;
  inputs: LayoutPort[];
  outputs: LayoutPort[];
} {
  const rows = Math.max(src.inputHandles.length, src.outputHandles.length, 1);
  const bodyH = rows * NODE_ROW_H + NODE_PAD_Y * 2;
  const width = src.uiWidth ?? NODE_FALLBACK_W;
  const height = src.uiHeight ?? NODE_HEADER_H + bodyH;
  const rowY = (i: number) => NODE_HEADER_H + NODE_PAD_Y + i * NODE_ROW_H + NODE_ROW_H / 2;
  return {
    width,
    height,
    inputs: src.inputHandles.map((id, i) => ({ id, y: rowY(i) })),
    outputs: src.outputHandles.map((id, i) => ({ id, y: rowY(i) })),
  };
}

// ---------------------------------------------------------------------------
// Selection expansion. A selected zone shell (or zone Input) brings its
// whole zone; a selected frame brings its members and drops out itself
// (frames hug their members — EffectsApp reconciles the box).

function expandSelection(
  nodes: LayoutNode[],
  ids: Set<string>
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const shells = new Set<string>();
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    if (n.kind === "frame") {
      for (const m of nodes) if (m.frameId === id && m.kind !== "frame") out.add(m.id);
      continue;
    }
    out.add(id);
    if (n.kind === "zoneShell") shells.add(id);
    if (n.kind === "zoneInput" && n.parentId && byId.get(n.parentId)?.kind === "zoneShell") {
      shells.add(n.parentId);
      out.add(n.parentId);
    }
  }
  // Descendants of every selected shell (nested zones included).
  if (shells.size) {
    for (const n of nodes) {
      if (n.kind === "frame") continue;
      let cur = n.parentId;
      for (let hops = 0; cur && hops < nodes.length; hops++) {
        if (shells.has(cur)) {
          out.add(n.id);
          break;
        }
        cur = byId.get(cur)?.parentId;
      }
    }
  }
  // Zone shells that were pulled in as descendants also bring their zone.
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...out]) {
      const n = byId.get(id);
      if (!n || n.kind !== "zoneShell") continue;
      for (const m of nodes) {
        if (m.kind !== "frame" && m.parentId === id && !out.has(m.id)) {
          out.add(m.id);
          grew = true;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Units: the things one layout level arranges — a leaf node, or a compound
// (zone / frame) already laid out recursively, carrying its members as
// offsets from its own top-left plus the handle ys of every member so
// edges crossing the compound boundary still align.

interface Unit {
  id: string;
  kind: "leaf" | "cluster" | "reroute";
  width: number;
  height: number;
  // Member node id → offset from the unit's top-left.
  leaves: Map<string, XY>;
  // `in|node|handle` / `out|node|handle` → y offset within the unit.
  ports: Map<string, number>;
  pin: "first" | "last" | null;
  // Original bbox top-left — seeds column order / anchoring.
  seedX: number;
  seedY: number;
  // Assigned during layout.
  rank: number;
  x: number;
  y: number;
}

interface LevelEdge {
  from: Unit;
  to: Unit;
  fromY: number;
  toY: number;
  // Reroutes contracted out of this edge, in wire order (source→target).
  via: Unit[];
}

interface Ctx {
  byId: Map<string, LayoutNode>;
  // The expanded selection — every node that takes part in this tidy.
  set: Set<string>;
  edges: LayoutEdge[];
  columnGap: number;
  rowGap: number;
  clusterPadding: number;
}

function pinFor(kind: LayoutKind): "first" | "last" | null {
  if (kind === "groupInput" || kind === "zoneInput") return "first";
  if (kind === "groupOutput" || kind === "zoneShell") return "last";
  return null;
}

function leafUnit(n: LayoutNode): Unit {
  const ports = new Map<string, number>();
  for (const p of n.inputs) ports.set(`in|${n.id}|${p.id}`, p.y);
  for (const p of n.outputs) ports.set(`out|${n.id}|${p.id}`, p.y);
  return {
    id: n.id,
    kind: n.kind === "reroute" ? "reroute" : "leaf",
    width: n.width,
    height: n.height,
    leaves: new Map([[n.id, { x: 0, y: 0 }]]),
    ports,
    pin: pinFor(n.kind),
    seedX: n.x,
    seedY: n.y,
    rank: 0,
    x: 0,
    y: 0,
  };
}

function portY(
  u: Unit,
  dir: "in" | "out",
  nodeId: string,
  handle: string,
  ctx: Ctx
): number {
  const hit = u.ports.get(`${dir}|${nodeId}|${handle}`);
  if (hit !== undefined) return hit;
  const off = u.leaves.get(nodeId);
  const n = ctx.byId.get(nodeId);
  if (off && n) return off.y + n.height / 2;
  return u.height / 2;
}

// Lay out one level (a scope, a zone interior, or a frame's members).
// Returns each member node's position relative to the level's origin, and
// the level's extent. `selfShell` names the zone whose interior this level
// IS — that shell is then a pinned-last leaf here rather than a compound;
// `selfFrame` names the frame whose members this level lays out, so they
// are not re-clustered into the same frame again.
function layoutLevel(
  ids: string[],
  ctx: Ctx,
  selfShell?: string,
  selfFrame?: string
): { positions: Map<string, XY>; width: number; height: number } {
  const units: Unit[] = [];
  const unitOf = new Map<string, Unit>(); // node id → unit at this level

  const seedOf = (members: string[]): XY => {
    let x = Infinity;
    let y = Infinity;
    for (const id of members) {
      const n = ctx.byId.get(id)!;
      x = Math.min(x, n.x);
      y = Math.min(y, n.y);
    }
    return { x, y };
  };
  const clusterFrom = (
    clusterId: string,
    innerIds: string[],
    innerShell: string | undefined,
    innerFrame: string | undefined,
    pin: Unit["pin"]
  ): Unit => {
    const inner = layoutLevel(innerIds, ctx, innerShell, innerFrame);
    const pad = ctx.clusterPadding;
    const leaves = new Map<string, XY>();
    const ports = new Map<string, number>();
    for (const [nid, p] of inner.positions) {
      const off = { x: p.x + pad, y: p.y + pad };
      leaves.set(nid, off);
      const n = ctx.byId.get(nid)!;
      for (const ip of n.inputs) ports.set(`in|${nid}|${ip.id}`, off.y + ip.y);
      for (const op of n.outputs) ports.set(`out|${nid}|${op.id}`, off.y + op.y);
    }
    const seed = seedOf(innerIds);
    return {
      id: clusterId,
      kind: "cluster",
      width: inner.width + pad * 2,
      height: inner.height + pad * 2,
      leaves,
      ports,
      pin,
      seedX: seed.x,
      seedY: seed.y,
      rank: 0,
      x: 0,
      y: 0,
    };
  };
  const registerUnit = (u: Unit) => {
    units.push(u);
    for (const lid of u.leaves.keys()) unitOf.set(lid, u);
  };
  // A zone's interior at this depth: the shell plus its DIRECT members.
  // Deeper members belong to nested shells, which recurse in turn.
  const zoneInner = (shellId: string): string[] => {
    const inner = [shellId];
    for (const n of ctx.byId.values()) {
      if (n.parentId === shellId && ctx.set.has(n.id) && n.kind !== "frame") inner.push(n.id);
    }
    return inner;
  };

  // --- compound units -----------------------------------------------------
  // Frames first: a frame's members at this level (zone shells included —
  // their zones nest inside the frame unit) form one unit. The level's own
  // shell never joins a frame here: its frame membership belongs to the
  // scope outside.
  const byFrame = new Map<string, string[]>();
  for (const id of ids) {
    const n = ctx.byId.get(id)!;
    if (n.frameId && n.frameId !== selfFrame && id !== selfShell && n.kind !== "frame") {
      const arr = byFrame.get(n.frameId) ?? [];
      arr.push(id);
      byFrame.set(n.frameId, arr);
    }
  }
  const consumed = new Set<string>();
  for (const [frameId, members] of byFrame) {
    if (members.length < 2) continue; // a lone framed node lays out like any other
    let pin: Unit["pin"] = null;
    for (const m of members) {
      const k = ctx.byId.get(m)!.kind;
      if (k === "groupInput") pin = "first";
      else if (k === "groupOutput") pin = "last";
    }
    registerUnit(clusterFrom(`frame:${frameId}`, members, undefined, frameId, pin));
    for (const m of members) consumed.add(m);
  }
  for (const id of ids) {
    if (consumed.has(id)) continue;
    const n = ctx.byId.get(id)!;
    if (n.kind === "frame") continue;
    if (n.kind === "zoneShell" && id !== selfShell) {
      // The whole zone is one unpinned unit at this level; inside it the
      // shell is a leaf pinned last.
      registerUnit(clusterFrom(`zone:${id}`, zoneInner(id), id, undefined, null));
      continue;
    }
    registerUnit(leafUnit(n));
  }

  // --- edges at this level -------------------------------------------------
  // Contract reroutes: A → R → B becomes A → B with R remembered on the
  // edge so it can be re-placed in the gap afterwards.
  const outOf = new Map<string, LayoutEdge[]>();
  for (const e of ctx.edges) {
    if (!unitOf.has(e.source) || !unitOf.has(e.target)) continue;
    (outOf.get(e.source) ?? outOf.set(e.source, []).get(e.source)!).push(e);
  }
  const isReroute = (id: string) => unitOf.get(id)?.kind === "reroute";
  const levelEdges: LevelEdge[] = [];
  const addEdge = (src: LayoutEdge, dst: LayoutEdge, via: Unit[]) => {
    const from = unitOf.get(src.source)!;
    const to = unitOf.get(dst.target)!;
    if (from === to) return; // internal to a compound — laid out inside it
    levelEdges.push({
      from,
      to,
      fromY: portY(from, "out", src.source, src.sourceHandle, ctx),
      toY: portY(to, "in", dst.target, dst.targetHandle, ctx),
      via,
    });
  };
  for (const e of ctx.edges) {
    if (!unitOf.has(e.source) || !unitOf.has(e.target)) continue;
    if (isReroute(e.source)) continue; // reached from the head of its chain
    if (!isReroute(e.target)) {
      addEdge(e, e, []);
      continue;
    }
    const walk = (edge: LayoutEdge, via: Unit[], depth: number) => {
      if (depth > 64) return;
      const nextVia = [...via, unitOf.get(edge.target)!];
      for (const o of outOf.get(edge.target) ?? []) {
        if (isReroute(o.target)) walk(o, nextVia, depth + 1);
        else addEdge(e, o, nextVia);
      }
    };
    walk(e, [], 0);
  }
  // Reroutes that sit on some edge leave the unit list; a dangling reroute
  // (no in or no out) stays as a tiny leaf.
  const contracted = new Set<Unit>();
  for (const le of levelEdges) for (const r of le.via) contracted.add(r);
  const active = units.filter((u) => !contracted.has(u));

  // --- ranks ---------------------------------------------------------------
  // Drop back edges (a valid graph is acyclic, but never hang on one).
  const rawSucc = new Map<Unit, LevelEdge[]>();
  for (const u of active) rawSucc.set(u, []);
  for (const le of levelEdges) rawSucc.get(le.from)!.push(le);
  const state = new Map<Unit, 0 | 1 | 2>();
  const keep = new Set<LevelEdge>();
  const visit = (u: Unit) => {
    state.set(u, 1);
    for (const le of rawSucc.get(u)!) {
      const s = state.get(le.to) ?? 0;
      if (s === 1) continue; // back edge
      keep.add(le);
      if (s === 0) visit(le.to);
    }
    state.set(u, 2);
  };
  for (const u of active) if (!state.get(u)) visit(u);
  const succ = new Map<Unit, LevelEdge[]>();
  const pred = new Map<Unit, LevelEdge[]>();
  for (const u of active) {
    succ.set(u, []);
    pred.set(u, []);
  }
  for (const le of levelEdges) {
    if (!keep.has(le)) continue;
    succ.get(le.from)!.push(le);
    pred.get(le.to)!.push(le);
  }
  // Topological order (Kahn).
  const indeg = new Map<Unit, number>();
  for (const u of active) indeg.set(u, pred.get(u)!.length);
  const queue = active.filter((u) => indeg.get(u) === 0);
  const topo: Unit[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    topo.push(u);
    for (const le of succ.get(u)!) {
      const d = indeg.get(le.to)! - 1;
      indeg.set(le.to, d);
      if (d === 0) queue.push(le.to);
    }
  }
  // Longest path from the sources.
  for (const u of topo) {
    let r = 0;
    for (const le of pred.get(u)!) r = Math.max(r, le.from.rank + 1);
    u.rank = r;
  }
  // Pull right: everything but a first-pinned unit sits just before its
  // earliest consumer. Reverse topo order so consumers are final first.
  for (let i = topo.length - 1; i >= 0; i--) {
    const u = topo[i];
    if (u.pin === "first") continue;
    const outs = succ.get(u)!;
    if (outs.length === 0) continue;
    let minSucc = Infinity;
    for (const le of outs) minSucc = Math.min(minSucc, le.to.rank);
    u.rank = Math.max(u.rank, minSucc - 1);
  }
  // Pins: first → column 0 (it is a source, so it already is); last → one
  // past every other column.
  const hasUnpinned = active.some((u) => u.pin !== "last");
  let maxRank = 0;
  for (const u of active) if (u.pin !== "last") maxRank = Math.max(maxRank, u.rank);
  for (const u of active) if (u.pin === "last") u.rank = hasUnpinned ? maxRank + 1 : 0;

  // --- columns -------------------------------------------------------------
  const ranks = [...new Set(active.map((u) => u.rank))].sort((a, b) => a - b);
  const colOf = new Map<number, Unit[]>();
  for (const u of active) (colOf.get(u.rank) ?? colOf.set(u.rank, []).get(u.rank)!).push(u);
  const colX = new Map<number, number>();
  const colW = new Map<number, number>();
  let x = 0;
  for (const r of ranks) {
    const w = Math.max(...colOf.get(r)!.map((u) => u.width));
    colX.set(r, x);
    colW.set(r, w);
    x += w + ctx.columnGap;
  }
  for (const u of active) {
    const cx = colX.get(u.rank)!;
    const cw = colW.get(u.rank)!;
    // Sources hug the right edge of their column so their outputs line up
    // and satellites sit against their consumer; everything else
    // left-aligns so wire arrivals line up.
    u.x = pred.get(u)!.length === 0 ? cx + cw - u.width : cx;
  }

  // --- rows: alternating sweeps, block-merge placement ---------------------
  // Every unit wants the y that makes its wires horizontal: aligned to its
  // producers on the left→right sweep, to its consumers on the right→left
  // sweep, the plain mean when there are several (so a fan-in node sits
  // in the MIDDLE of its inputs — the owner's "spine at the vertical
  // middle"). A column is then placed by block merging: units that would
  // overlap fuse into a block whose top is the mean of its members'
  // wishes, so a collision is shared symmetrically instead of pushing one
  // side. The two sweeps use the same means, so a connected component
  // converges instead of creeping; any residual creep is cancelled by
  // pinning each wire-connected component's centroid back to where the
  // user had it (which also keeps detached side-graphs roughly in place).
  for (const u of active) u.y = u.seedY;
  const desired = new Map<Unit, number>();
  const placeColumn = (col: Unit[]) => {
    const order = [...col].sort(
      (a, b) =>
        desired.get(a)! - desired.get(b)! ||
        a.seedY - b.seedY ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    type Block = { members: Unit[]; offsets: number[]; height: number; top: number };
    const blocks: Block[] = [];
    for (const u of order) {
      let b: Block = { members: [u], offsets: [0], height: u.height, top: desired.get(u)! };
      while (blocks.length) {
        const prev = blocks[blocks.length - 1];
        if (b.top >= prev.top + prev.height + ctx.rowGap) break;
        const base = prev.height + ctx.rowGap;
        for (let i = 0; i < b.members.length; i++) {
          prev.members.push(b.members[i]);
          prev.offsets.push(base + b.offsets[i]);
        }
        prev.height = base + b.height;
        let s = 0;
        for (let i = 0; i < prev.members.length; i++) {
          s += desired.get(prev.members[i])! - prev.offsets[i];
        }
        prev.top = s / prev.members.length;
        b = blocks.pop()!;
      }
      blocks.push(b);
    }
    for (const b of blocks) {
      for (let i = 0; i < b.members.length; i++) b.members[i].y = b.top + b.offsets[i];
    }
  };
  const alignedFromPred = (u: Unit): number | null => {
    const ins = pred.get(u)!;
    if (ins.length === 0) return null;
    let s = 0;
    for (const le of ins) s += le.from.y + le.fromY - le.toY;
    return s / ins.length;
  };
  const alignedFromSucc = (u: Unit): number | null => {
    const outs = succ.get(u)!;
    if (outs.length === 0) return null;
    let s = 0;
    for (const le of outs) s += le.to.y + le.toY - le.fromY;
    return s / outs.length;
  };
  const sweepRight = () => {
    for (const r of ranks) {
      const col = colOf.get(r)!;
      for (const u of col) desired.set(u, alignedFromPred(u) ?? u.y);
      placeColumn(col);
    }
  };
  const sweepLeft = () => {
    for (let i = ranks.length - 1; i >= 0; i--) {
      const col = colOf.get(ranks[i])!;
      for (const u of col) desired.set(u, alignedFromSucc(u) ?? u.y);
      placeColumn(col);
    }
  };
  // Wire-connected components (over kept edges) and their seed centroids.
  const compOf = new Map<Unit, number>();
  const comps: Unit[][] = [];
  for (const u of active) {
    if (compOf.has(u)) continue;
    const members: Unit[] = [];
    const stack = [u];
    compOf.set(u, comps.length);
    while (stack.length) {
      const v = stack.pop()!;
      members.push(v);
      for (const le of succ.get(v)!) {
        if (!compOf.has(le.to)) {
          compOf.set(le.to, comps.length);
          stack.push(le.to);
        }
      }
      for (const le of pred.get(v)!) {
        if (!compOf.has(le.from)) {
          compOf.set(le.from, comps.length);
          stack.push(le.from);
        }
      }
    }
    comps.push(members);
  }
  const centroid = (members: Unit[], key: (u: Unit) => number) =>
    members.reduce((s, u) => s + key(u) + u.height / 2, 0) / members.length;
  const seedCentroids = comps.map((m) => centroid(m, (u) => u.seedY));
  const recenter = () => {
    comps.forEach((members, i) => {
      const shift = seedCentroids[i] - centroid(members, (u) => u.y);
      for (const u of members) u.y += shift;
    });
  };
  for (let it = 0; it < 4; it++) {
    sweepRight();
    sweepLeft();
    recenter();
  }
  // Finish left → right so wire ARRIVALS are straight where both can't be,
  // then resolve any overlap the recentring introduced between components
  // sharing a column (desired = where each unit is now, so nothing moves
  // unless it must).
  sweepRight();
  recenter();
  for (const r of ranks) {
    const col = colOf.get(r)!;
    for (const u of col) desired.set(u, u.y);
    placeColumn(col);
  }

  // --- reroutes back into the gaps ----------------------------------------
  // Each contracted reroute sits in the gap right of its source, on the
  // source's output row; a chain spreads across the run to its target;
  // several on one port stack downward. A reroute fanning out to many
  // targets is placed once, from the first edge that carries it.
  const rerouteDone = new Set<Unit>();
  const stackOn = new Map<string, number>();
  for (const le of levelEdges) {
    if (le.via.length === 0) continue;
    const from = le.from;
    const runStart = from.x + from.width;
    const span = Math.max(0, le.to.x - runStart);
    for (let i = 0; i < le.via.length; i++) {
      const r = le.via[i];
      if (rerouteDone.has(r)) continue;
      rerouteDone.add(r);
      const key = `${from.id}|${le.fromY}`;
      const k = stackOn.get(key) ?? 0;
      stackOn.set(key, k + 1);
      const rin = ctx.byId.get(r.id)?.inputs[0]?.y ?? r.height / 2;
      r.x =
        le.via.length === 1
          ? runStart + ctx.columnGap / 2 - r.width / 2
          : runStart + ((i + 1) * span) / (le.via.length + 1) - r.width / 2;
      r.y = from.y + le.fromY - rin + k * (r.height + 4);
    }
  }

  // --- normalise to the level origin ---------------------------------------
  const all = [...active, ...contracted];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const u of all) {
    minX = Math.min(minX, u.x);
    minY = Math.min(minY, u.y);
    maxX = Math.max(maxX, u.x + u.width);
    maxY = Math.max(maxY, u.y + u.height);
  }
  if (!Number.isFinite(minX)) return { positions: new Map(), width: 0, height: 0 };
  const positions = new Map<string, XY>();
  for (const u of all) {
    for (const [nid, off] of u.leaves) {
      positions.set(nid, { x: u.x - minX + off.x, y: u.y - minY + off.y });
    }
  }
  return { positions, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------

export function tidyLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  ids: Iterable<string>,
  opts: TidyOptions = {}
): Map<string, XY> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const set = expandSelection(nodes, new Set(ids));
  if (set.size === 0) return new Map();
  const ctx: Ctx = {
    byId,
    set,
    edges: edges.filter((e) => set.has(e.source) && set.has(e.target)),
    columnGap: opts.columnGap ?? COLUMN_GAP,
    rowGap: opts.rowGap ?? ROW_GAP,
    clusterPadding: opts.clusterPadding ?? CLUSTER_PADDING,
  };
  // Root level: members whose zone shell is NOT in the set (a selected
  // shell's members lay out inside the shell's cluster instead).
  const rootIds = [...set].filter((id) => {
    const n = byId.get(id)!;
    const p = n.parentId ? byId.get(n.parentId) : undefined;
    return !(p && p.kind === "zoneShell" && set.has(p.id));
  });
  const { positions } = layoutLevel(rootIds, ctx);
  if (positions.size === 0) return positions;

  // Anchor. Both bboxes are taken over the NODE boxes (not the padded
  // compound extents) so the centre maps onto itself and a re-run of a
  // tidy layout lands exactly where it was.
  const anchor = opts.anchor ?? "center";
  let dx = 0;
  let dy = 0;
  const bbox = (at: (id: string) => XY) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of positions.keys()) {
      const n = byId.get(id)!;
      const p = at(id);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + n.width);
      maxY = Math.max(maxY, p.y + n.height);
    }
    return { minX, minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };
  const fresh = bbox((id) => positions.get(id)!);
  if (anchor === "center") {
    const old = bbox((id) => byId.get(id)!);
    dx = old.cx - fresh.cx;
    dy = old.cy - fresh.cy;
  } else if (anchor === "origin") {
    dx = -fresh.minX;
    dy = -fresh.minY;
  } else {
    dx = anchor.x - fresh.minX;
    dy = anchor.y - fresh.minY;
  }
  const out = new Map<string, XY>();
  for (const [id, p] of positions) {
    out.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Align / distribute — plain box tools over the same compound units (a
// zone moves as one thing; a frame's selected members move together).

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

interface BoxUnit {
  members: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxUnits(nodes: LayoutNode[], ids: Iterable<string>): BoxUnit[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const set = expandSelection(nodes, new Set(ids));
  const groups = new Map<string, string[]>();
  const shellOf = (n: LayoutNode): string | null => {
    // Outermost selected zone shell above (or at) this node.
    let top: string | null = n.kind === "zoneShell" ? n.id : null;
    let cur = n.parentId;
    for (let hops = 0; cur && hops < nodes.length; hops++) {
      const p = byId.get(cur);
      if (!p) break;
      if (p.kind === "zoneShell" && set.has(p.id)) top = p.id;
      cur = p.parentId;
    }
    return top;
  };
  for (const id of set) {
    const n = byId.get(id)!;
    const shell = shellOf(n);
    const key = shell ? `zone:${shell}` : n.frameId ? `frame:${n.frameId}` : `node:${id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(id);
  }
  const units: BoxUnit[] = [];
  for (const members of groups.values()) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of members) {
      const n = byId.get(id)!;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    units.push({ members, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }
  return units;
}

function applyUnitMoves(
  nodes: LayoutNode[],
  units: BoxUnit[],
  target: (u: BoxUnit) => XY
): Map<string, XY> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, XY>();
  for (const u of units) {
    const t = target(u);
    const dx = Math.round(t.x - u.x);
    const dy = Math.round(t.y - u.y);
    if (dx === 0 && dy === 0) continue;
    for (const id of u.members) {
      const n = byId.get(id)!;
      out.set(id, { x: n.x + dx, y: n.y + dy });
    }
  }
  return out;
}

export function alignLayout(
  nodes: LayoutNode[],
  ids: Iterable<string>,
  mode: AlignMode
): Map<string, XY> {
  const units = boxUnits(nodes, ids);
  if (units.length < 2) return new Map();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const u of units) {
    minX = Math.min(minX, u.x);
    minY = Math.min(minY, u.y);
    maxX = Math.max(maxX, u.x + u.width);
    maxY = Math.max(maxY, u.y + u.height);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return applyUnitMoves(nodes, units, (u) => {
    switch (mode) {
      case "left":
        return { x: minX, y: u.y };
      case "right":
        return { x: maxX - u.width, y: u.y };
      case "centerX":
        return { x: cx - u.width / 2, y: u.y };
      case "top":
        return { x: u.x, y: minY };
      case "bottom":
        return { x: u.x, y: maxY - u.height };
      case "centerY":
        return { x: u.x, y: cy - u.height / 2 };
    }
  });
}

export function distributeLayout(
  nodes: LayoutNode[],
  ids: Iterable<string>,
  axis: "x" | "y",
  opts: { gap?: number } = {}
): Map<string, XY> {
  const units = boxUnits(nodes, ids);
  if (units.length < 2) return new Map();
  const size = (u: BoxUnit) => (axis === "x" ? u.width : u.height);
  const pos = (u: BoxUnit) => (axis === "x" ? u.x : u.y);
  const order = [...units].sort((a, b) => pos(a) - pos(b) || (axis === "x" ? a.y - b.y : a.x - b.x));
  const first = order[0];
  const last = order[order.length - 1];
  let gap: number;
  if (opts.gap !== undefined) {
    gap = opts.gap;
  } else {
    const span = pos(last) + size(last) - pos(first);
    const total = order.reduce((s, u) => s + size(u), 0);
    gap = (span - total) / (order.length - 1);
    // Overlapping boxes have a negative even gap — fall back to a real gap
    // so distribute always separates.
    if (gap < ROW_GAP) gap = ROW_GAP;
  }
  const targets = new Map<BoxUnit, number>();
  let cursor = pos(first);
  for (const u of order) {
    targets.set(u, cursor);
    cursor += size(u) + gap;
  }
  return applyUnitMoves(nodes, units, (u) =>
    axis === "x" ? { x: targets.get(u)!, y: u.y } : { x: u.x, y: targets.get(u)! }
  );
}

// ---------------------------------------------------------------------------
// Insertion placement for nodes that arrive without a position (agent
// edits). Each new node lands beside its first consumer on the row it
// feeds (or after its producer, or below everything when unwired), then
// slides down its column past occupied slots. Existing nodes never move.

export function placeNewNodes(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  newIds: Iterable<string>,
  opts: { columnGap?: number; rowGap?: number } = {}
): Map<string, XY> {
  const columnGap = opts.columnGap ?? COLUMN_GAP;
  const rowGap = opts.rowGap ?? ROW_GAP;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pending = new Set([...newIds].filter((id) => byId.has(id)));
  const out = new Map<string, XY>();
  const placed = new Map<string, XY>(); // includes existing nodes
  for (const n of nodes) if (!pending.has(n.id)) placed.set(n.id, { x: n.x, y: n.y });
  const boxAt = (id: string): { x: number; y: number; width: number; height: number } | null => {
    const p = placed.get(id);
    const n = byId.get(id);
    return p && n ? { x: p.x, y: p.y, width: n.width, height: n.height } : null;
  };
  const port = (n: LayoutNode, dir: "in" | "out", handle: string): number => {
    const list = dir === "in" ? n.inputs : n.outputs;
    return list.find((p) => p.id === handle)?.y ?? n.height / 2;
  };
  // Consumers first so a chain of new nodes builds back from the sink.
  let guard = 0;
  while (pending.size && guard++ < 1000) {
    let progressed = false;
    for (const id of [...pending]) {
      const n = byId.get(id)!;
      const consumers = edges.filter((e) => e.source === id && placed.has(e.target));
      const producers = edges.filter((e) => e.target === id && placed.has(e.source));
      const waits = edges.some(
        (e) => e.source === id && pending.has(e.target) && e.target !== id
      );
      if (waits && consumers.length === 0) continue; // its consumer places first
      let x: number;
      let y: number;
      if (consumers.length) {
        const c = consumers[0];
        const cn = byId.get(c.target)!;
        const cb = boxAt(c.target)!;
        x = cb.x - columnGap - n.width;
        y = cb.y + port(cn, "in", c.targetHandle) - port(n, "out", c.sourceHandle);
      } else if (producers.length) {
        const p = producers[0];
        const pn = byId.get(p.source)!;
        const pb = boxAt(p.source)!;
        x = pb.x + pb.width + columnGap;
        y = pb.y + port(pn, "out", p.sourceHandle) - port(n, "in", p.targetHandle);
      } else {
        let minX = Infinity;
        let maxY = -Infinity;
        for (const [pid, p] of placed) {
          minX = Math.min(minX, p.x);
          maxY = Math.max(maxY, p.y + byId.get(pid)!.height);
        }
        x = Number.isFinite(minX) ? minX : 0;
        y = Number.isFinite(maxY) ? maxY + rowGap : 0;
      }
      // Slide down past anything occupying the slot.
      for (let k = 0; k < 200; k++) {
        let bump: number | null = null;
        for (const [pid, p] of placed) {
          const o = byId.get(pid)!;
          const overlaps =
            x < p.x + o.width + rowGap &&
            x + n.width + rowGap > p.x &&
            y < p.y + o.height + rowGap &&
            y + n.height + rowGap > p.y;
          if (overlaps) bump = Math.max(bump ?? -Infinity, p.y + o.height + rowGap);
        }
        if (bump === null) break;
        y = bump;
      }
      const pos = { x: Math.round(x), y: Math.round(y) };
      placed.set(id, pos);
      out.set(id, pos);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) {
      // Only cycles among new nodes remain — place the first one anyway.
      const id = [...pending][0];
      let maxY = -Infinity;
      let minX = Infinity;
      for (const [pid, p] of placed) {
        minX = Math.min(minX, p.x);
        maxY = Math.max(maxY, p.y + byId.get(pid)!.height);
      }
      const pos = {
        x: Number.isFinite(minX) ? minX : 0,
        y: Number.isFinite(maxY) ? maxY + rowGap : 0,
      };
      placed.set(id, pos);
      out.set(id, pos);
      pending.delete(id);
    }
  }
  return out;
}
