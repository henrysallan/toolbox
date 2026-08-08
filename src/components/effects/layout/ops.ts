// Pure structural operations on the layout tree (the graph-ops
// pattern): every op is LayoutTree → LayoutTree, returning a new tree
// with untouched subtrees shared by reference. EffectsApp holds one
// layoutTree state and applies results; nothing here touches React or
// the DOM. Spec: specdocs/archive/072726_window-tiling.md.

import type {
  LayoutNode,
  LayoutTree,
  PanelKind,
} from "./model";
import { leaf, mintLayoutId } from "./model";

function mapNode(
  node: LayoutNode,
  fn: (n: LayoutNode) => LayoutNode | null
): LayoutNode {
  const mapped = fn(node);
  if (mapped) return mapped;
  if (node.kind === "leaf") return node;
  const a = mapNode(node.a, fn);
  const b = mapNode(node.b, fn);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** Set a split's ratio (caller pre-clamps against measured min sizes). */
export function setRatio(
  tree: LayoutTree,
  splitId: string,
  ratio: number
): LayoutTree {
  const clamped = Math.min(0.95, Math.max(0.05, ratio));
  return {
    root: mapNode(tree.root, (n) =>
      n.kind === "split" && n.id === splitId ? { ...n, ratio: clamped } : null
    ),
  };
}

/** Change which editor a leaf shows. Leaf id (and rect) survive. */
export function assignKind(
  tree: LayoutTree,
  leafId: string,
  panel: PanelKind
): LayoutTree {
  return {
    root: mapNode(tree.root, (n) =>
      n.kind === "leaf" && n.id === leafId && n.panel !== panel
        ? { ...n, panel }
        : null
    ),
  };
}

/**
 * Split a leaf in two. The original leaf keeps its id and becomes the
 * `first` child (or second when firstIsNew) so its panel content never
 * remounts; the new sibling clones the source's kind (Blender
 * semantics — reassign via the dropdown afterwards).
 */
export function splitLeaf(
  tree: LayoutTree,
  leafId: string,
  dir: "row" | "col",
  ratio: number,
  firstIsNew = false
): LayoutTree {
  return {
    root: mapNode(tree.root, (n) => {
      if (n.kind !== "leaf" || n.id !== leafId) return null;
      const fresh = leaf(n.panel);
      return {
        kind: "split",
        id: mintLayoutId(),
        dir,
        ratio: Math.min(0.95, Math.max(0.05, ratio)),
        a: firstIsNew ? fresh : n,
        b: firstIsNew ? n : fresh,
      };
    }),
  };
}

/** Swap the panel kinds of two leaves. Geometry untouched. */
export function swapLeaves(
  tree: LayoutTree,
  idA: string,
  idB: string
): LayoutTree {
  if (idA === idB) return tree;
  let panelA: PanelKind | null = null;
  let panelB: PanelKind | null = null;
  const scan = (n: LayoutNode) => {
    if (n.kind === "leaf") {
      if (n.id === idA) panelA = n.panel;
      if (n.id === idB) panelB = n.panel;
      return;
    }
    scan(n.a);
    scan(n.b);
  };
  scan(tree.root);
  if (panelA == null || panelB == null) return tree;
  const a = panelA;
  const b = panelB;
  return {
    root: mapNode(tree.root, (n) => {
      if (n.kind !== "leaf") return null;
      if (n.id === idA) return { ...n, panel: b };
      if (n.id === idB) return { ...n, panel: a };
      return null;
    }),
  };
}

/**
 * Remove ONE leaf, collapsing its parent split into the surviving
 * sibling (which keeps its own id, so its panel content never
 * remounts). Returns null when `leafId` is the root leaf — the tree
 * must always hold at least one panel, and the caller (detach) refuses
 * the gesture rather than emptying the window.
 *
 * This is the detach half of pop-out (080226_panel-popout-windows.md
 * §5): a detached leaf leaves the tree entirely rather than staying in
 * it flagged, so no split ratio ever describes a hole.
 */
export function removeLeaf(
  tree: LayoutTree,
  leafId: string
): LayoutTree | null {
  if (tree.root.kind === "leaf") {
    return tree.root.id === leafId ? null : tree;
  }
  let removed = false;
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf" || removed) return n;
    if (n.a.kind === "leaf" && n.a.id === leafId) {
      removed = true;
      return n.b;
    }
    if (n.b.kind === "leaf" && n.b.id === leafId) {
      removed = true;
      return n.a;
    }
    const a = walk(n.a);
    const b = walk(n.b);
    if (a === n.a && b === n.b) return n;
    return { ...n, a, b };
  };
  const root = walk(tree.root);
  return removed ? { root } : tree;
}

/**
 * Add a leaf of `panel` beside `targetLeafId`, splitting it along
 * `dir`. The target keeps its id and becomes the first child (content
 * doesn't remount); the newcomer is second. Returns the new tree and
 * the minted leaf id.
 *
 * The re-home half of pop-out: closing a detached window puts its
 * panel back this way. Unlike `splitLeaf` the new leaf's kind is given
 * rather than cloned, because the panel coming home already has one.
 * A missing target leaves the tree untouched (leafId still minted, and
 * the caller drops it).
 */
export function attachLeaf(
  tree: LayoutTree,
  targetLeafId: string,
  panel: PanelKind,
  dir: "row" | "col",
  ratio = 0.5
): { tree: LayoutTree; leafId: string } {
  const fresh = leaf(panel);
  const root = mapNode(tree.root, (n) => {
    if (n.kind !== "leaf" || n.id !== targetLeafId) return null;
    return {
      kind: "split",
      id: mintLayoutId(),
      dir,
      ratio: Math.min(0.95, Math.max(0.05, ratio)),
      a: n,
      b: fresh,
    };
  });
  return { tree: { root }, leafId: fresh.id };
}

/**
 * Join: the subtree containing `keepLeafId` swallows the other side of
 * the lowest split separating it from `removeLeafId`. Everything on the
 * removed side closes (the gesture preview covers exactly that region
 * before commit — §4b of the spec).
 */
export function joinAt(
  tree: LayoutTree,
  keepLeafId: string,
  removeLeafId: string
): LayoutTree {
  if (keepLeafId === removeLeafId) return tree;
  const contains = (n: LayoutNode, id: string): boolean => {
    if (n.id === id) return true;
    if (n.kind === "leaf") return false;
    return contains(n.a, id) || contains(n.b, id);
  };
  return {
    root: mapNode(tree.root, (n) => {
      if (n.kind !== "split") return null;
      const keepInA = contains(n.a, keepLeafId);
      const keepInB = contains(n.b, keepLeafId);
      const removeInA = contains(n.a, removeLeafId);
      const removeInB = contains(n.b, removeLeafId);
      // The lowest separating split is the one whose two children
      // hold the two leaves apart.
      if (keepInA && removeInB) return n.a;
      if (keepInB && removeInA) return n.b;
      return null;
    }),
  };
}
