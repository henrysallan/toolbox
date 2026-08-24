// Blender-style window tiling — the layout tree model.
// Spec: specdocs/archive/072726_window-tiling.md.
//
// The tree is pure data; structural changes go through ops.ts (the
// graph-ops pattern). Rendering never nests panels in the DOM — leaves
// become flat absolutely-positioned siblings whose rects come from
// computeRects() as 0..1 fractions, so SSR renders deterministically
// (no window measurement during render).

export type PanelKind =
  | "viewport"
  | "nodes"
  | "params"
  | "timeline"
  | "perf"
  | "spreadsheet"
  | "assistant";

/**
 * Every assignable panel kind, in menu order. The single source of
 * truth — the kind menu renders from it and both validators below check
 * against it, so adding a kind is a one-line change here plus its menu
 * entry. Note an OLDER build reading a tree that contains a kind it
 * doesn't know rejects the whole tree and falls back to the default
 * preset (layout only; project content is untouched).
 */
export const PANEL_KINDS: readonly PanelKind[] = [
  "viewport",
  "nodes",
  "params",
  "timeline",
  "perf",
  "spreadsheet",
  "assistant",
];

/**
 * Human labels for each kind. Used by the kind menu and by pop-out
 * window titles (080226_panel-popout-windows.md), so they stay in one
 * place rather than drifting between the two surfaces.
 */
export const PANEL_LABELS: Record<PanelKind, string> = {
  viewport: "Viewport",
  nodes: "Node Editor",
  params: "Parameters",
  timeline: "Timeline",
  perf: "Performance",
  spreadsheet: "Spreadsheet",
  assistant: "Assistant",
};

export interface LayoutLeaf {
  kind: "leaf";
  id: string;
  panel: PanelKind;
}

export interface LayoutSplit {
  kind: "split";
  id: string;
  /** row = children side-by-side (vertical seam); col = stacked. */
  dir: "row" | "col";
  /** 0..1 — the first child's share of this split's extent. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutTree {
  root: LayoutNode;
}

// Smallest usable panel edge in px. Enforced by ops (ratio clamps
// measure the container at drag time) — never encoded in CSS, so a
// loaded tree re-clamps on its first drag rather than rendering
// unusable.
export const MIN_PANEL_PX = 200;

let mintCounter = 0;
/** Leaf/split ids — unique per session; not persisted across loads. */
export function mintLayoutId(): string {
  // Date.now-free (deterministic enough per session; ids only need
  // uniqueness within one tree's lifetime).
  mintCounter += 1;
  return `lay_${mintCounter.toString(36)}`;
}

export function leaf(panel: PanelKind): LayoutLeaf {
  return { kind: "leaf", id: mintLayoutId(), panel };
}

export function split(
  dir: "row" | "col",
  ratio: number,
  a: LayoutNode,
  b: LayoutNode
): LayoutSplit {
  return { kind: "split", id: mintLayoutId(), dir, ratio, a, b };
}

// --- presets --------------------------------------------------------------

/** Today's default layout: canvas left, nodes over params on the right. */
export function makeDefaultTree(): LayoutTree {
  return {
    root: split(
      "row",
      0.5,
      leaf("viewport"),
      split("col", 0.62, leaf("nodes"), leaf("params"))
    ),
  };
}

/** The AE-style arrangement: params on the left, canvas right. */
export function makeTimelineTree(): LayoutTree {
  return {
    root: split("row", 0.42, leaf("params"), leaf("viewport")),
  };
}

// --- queries --------------------------------------------------------------

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DividerDesc {
  splitId: string;
  dir: "row" | "col";
  /** The split's own rect (fractions) — the seam lives inside it. */
  rect: LayoutRect;
  /** Seam position as a fraction of the whole region (x for row, y for col). */
  at: number;
}

export interface ComputedLayout {
  leaves: Map<string, { rect: LayoutRect; panel: PanelKind }>;
  dividers: DividerDesc[];
  /** Leaf ids in depth-first (a-before-b) order — "tree order". */
  order: string[];
}

export function computeRects(tree: LayoutTree): ComputedLayout {
  const leaves = new Map<string, { rect: LayoutRect; panel: PanelKind }>();
  const dividers: DividerDesc[] = [];
  const order: string[] = [];
  const walk = (node: LayoutNode, rect: LayoutRect) => {
    if (node.kind === "leaf") {
      leaves.set(node.id, { rect, panel: node.panel });
      order.push(node.id);
      return;
    }
    const r = Math.min(0.95, Math.max(0.05, node.ratio));
    if (node.dir === "row") {
      const aw = rect.w * r;
      walk(node.a, { x: rect.x, y: rect.y, w: aw, h: rect.h });
      dividers.push({
        splitId: node.id,
        dir: "row",
        rect,
        at: rect.x + aw,
      });
      walk(node.b, {
        x: rect.x + aw,
        y: rect.y,
        w: rect.w - aw,
        h: rect.h,
      });
    } else {
      const ah = rect.h * r;
      walk(node.a, { x: rect.x, y: rect.y, w: rect.w, h: ah });
      dividers.push({
        splitId: node.id,
        dir: "col",
        rect,
        at: rect.y + ah,
      });
      walk(node.b, {
        x: rect.x,
        y: rect.y + ah,
        w: rect.w,
        h: rect.h - ah,
      });
    }
  };
  walk(tree.root, { x: 0, y: 0, w: 1, h: 1 });
  return { leaves, dividers, order };
}

export function findNode(tree: LayoutTree, id: string): LayoutNode | null {
  let found: LayoutNode | null = null;
  const walk = (n: LayoutNode) => {
    if (found) return;
    if (n.id === id) {
      found = n;
      return;
    }
    if (n.kind === "split") {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(tree.root);
  return found;
}

export function countLeavesOfKind(tree: LayoutTree, panel: PanelKind): number {
  let count = 0;
  const walk = (n: LayoutNode) => {
    if (n.kind === "leaf") {
      if (n.panel === panel) count += 1;
      return;
    }
    walk(n.a);
    walk(n.b);
  };
  walk(tree.root);
  return count;
}

/** First leaf of the given kind in tree order, or null. */
export function firstLeafOfKind(
  tree: LayoutTree,
  panel: PanelKind
): LayoutLeaf | null {
  let found: LayoutLeaf | null = null;
  const walk = (n: LayoutNode) => {
    if (found) return;
    if (n.kind === "leaf") {
      if (n.panel === panel) found = n;
      return;
    }
    walk(n.a);
    walk(n.b);
  };
  walk(tree.root);
  return found;
}

/**
 * The biggest leaf by area, plus the direction that splits it across
 * its LONGER edge — the re-home target when a popped-out panel comes
 * home (080226_panel-popout-windows.md §5). Deterministic, and it never
 * references a parent that may have been joined away while the panel
 * was detached.
 *
 * Rects are fractions of the container, so `containerAspect` (w/h in
 * px) is needed to compare edges physically; pass 1 to compare raw
 * fractions. Null only for an empty tree, which can't occur (removeLeaf
 * refuses the last leaf).
 */
export function largestLeaf(
  tree: LayoutTree,
  containerAspect = 1
): { id: string; panel: PanelKind; dir: "row" | "col" } | null {
  const { leaves, order } = computeRects(tree);
  let best: { id: string; panel: PanelKind; dir: "row" | "col" } | null = null;
  let bestArea = -1;
  // Tree order, so ties resolve to the first leaf rather than by Map
  // iteration accident.
  for (const id of order) {
    const entry = leaves.get(id);
    if (!entry) continue;
    const { rect, panel } = entry;
    const area = rect.w * rect.h;
    if (area <= bestArea) continue;
    bestArea = area;
    best = {
      id,
      panel,
      dir: rect.w * containerAspect >= rect.h ? "row" : "col",
    };
  }
  return best;
}

/**
 * The leaf ids that would CLOSE if `keepLeafId` joined over
 * `removeLeafId` — i.e. every leaf on the other side of the lowest
 * split separating the two (exactly what ops.joinAt removes). The
 * join/swap gesture unions their rects for the doomed-region preview,
 * and the last-viewport guard checks the survivors. Empty when either
 * id is missing or they're the same leaf.
 */
export function joinRemovedLeaves(
  tree: LayoutTree,
  keepLeafId: string,
  removeLeafId: string
): string[] {
  if (keepLeafId === removeLeafId) return [];
  const contains = (n: LayoutNode, id: string): boolean => {
    if (n.id === id) return true;
    if (n.kind === "leaf") return false;
    return contains(n.a, id) || contains(n.b, id);
  };
  let doomedRoot: LayoutNode | null = null;
  const findLca = (n: LayoutNode) => {
    if (doomedRoot || n.kind !== "split") return;
    if (contains(n.a, keepLeafId) && contains(n.b, removeLeafId)) {
      doomedRoot = n.b;
      return;
    }
    if (contains(n.b, keepLeafId) && contains(n.a, removeLeafId)) {
      doomedRoot = n.a;
      return;
    }
    findLca(n.a);
    findLca(n.b);
  };
  findLca(tree.root);
  if (!doomedRoot) return [];
  const ids: string[] = [];
  const collect = (n: LayoutNode) => {
    if (n.kind === "leaf") {
      ids.push(n.id);
      return;
    }
    collect(n.a);
    collect(n.b);
  };
  collect(doomedRoot);
  return ids;
}

// --- persistence (M4 — spec §6) -------------------------------------------
//
// Leaf/split ids are session-only, so the tree serializes WITHOUT them
// and load re-mints. The saved shape lives as an opaque additive blob
// on SavedProject.layout (schema stays 9 — older builds ignore it and
// drop it on resave, losing only the layout, never content).

export type SavedLayoutNode =
  | { panel: PanelKind }
  | {
      dir: "row" | "col";
      ratio: number;
      a: SavedLayoutNode;
      b: SavedLayoutNode;
    };

export interface SavedLayout {
  root: SavedLayoutNode;
}

export function toSavedLayout(tree: LayoutTree): SavedLayout {
  const conv = (n: LayoutNode): SavedLayoutNode =>
    n.kind === "leaf"
      ? { panel: n.panel }
      : { dir: n.dir, ratio: n.ratio, a: conv(n.a), b: conv(n.b) };
  return { root: conv(tree.root) };
}

/**
 * Parse + validate an UNTRUSTED saved blob into a live tree with fresh
 * ids, or null when malformed (caller falls back to the default
 * preset). Also requires ≥1 viewport leaf — the runtime guarantees one
 * exists (kind-menu / merge guards), and a hand-edited file without one
 * would leave the engine with no blit target.
 */
export function fromSavedLayout(saved: unknown): LayoutTree | null {
  const convert = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== "object" || depth > 32) return null;
    const o = n as Record<string, unknown>;
    if (typeof o.panel === "string") {
      return (PANEL_KINDS as readonly string[]).includes(o.panel)
        ? leaf(o.panel as PanelKind)
        : null;
    }
    if (
      (o.dir === "row" || o.dir === "col") &&
      typeof o.ratio === "number" &&
      o.ratio > 0 &&
      o.ratio < 1
    ) {
      const a = convert(o.a, depth + 1);
      const b = convert(o.b, depth + 1);
      return a && b ? split(o.dir, o.ratio, a, b) : null;
    }
    return null;
  };
  const rootRaw =
    saved && typeof saved === "object"
      ? (saved as Record<string, unknown>).root
      : null;
  const root = rootRaw ? convert(rootRaw, 0) : null;
  if (!root) return null;
  const tree: LayoutTree = { root };
  if (!validateTree(tree)) return null;
  if (countLeavesOfKind(tree, "viewport") < 1) return null;
  return tree;
}

/**
 * Structural sanity check — run on any tree from persistence before
 * applying it (a malformed tree falls back to the default preset).
 * Checks: unique ids, ratios in (0,1), known panel kinds, ≥1 leaf.
 */
export function validateTree(tree: LayoutTree): boolean {
  const ids = new Set<string>();
  let leafCount = 0;
  let ok = true;
  const walk = (n: LayoutNode) => {
    if (!ok) return;
    if (!n.id || ids.has(n.id)) {
      ok = false;
      return;
    }
    ids.add(n.id);
    if (n.kind === "leaf") {
      leafCount += 1;
      if (!(PANEL_KINDS as readonly string[]).includes(n.panel)) ok = false;
      return;
    }
    if (n.kind !== "split") {
      ok = false;
      return;
    }
    if (n.dir !== "row" && n.dir !== "col") ok = false;
    if (!(n.ratio > 0 && n.ratio < 1)) ok = false;
    walk(n.a);
    walk(n.b);
  };
  walk(tree.root);
  return ok && leafCount >= 1;
}
