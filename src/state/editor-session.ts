import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "./graph";
import type { SavedComposition } from "@/lib/project";
import type { SavedEasing } from "@/engine/keyframes";
import type { SaveState } from "@/components/effects/FileNameMenu";
import type { LayoutTree } from "@/components/effects/layout/model";
import type { LiveDesign } from "@/lib/live-viewer/design";

// Module-level survival capsule for editor state across a client-side
// route change (e.g. clicking the docs "i" button).
//
// Why module-level instead of sessionStorage: the graph contains
// Canvas elements (paint nodes) and ImageBitmaps (image sources) that
// don't structure-clone. Serializing through the save path works but
// is slow enough to stutter a nav. Module state survives a React
// unmount/remount within a single page load, which is exactly the
// docs round-trip scenario. A hard refresh resets everything — that's
// acceptable; the docs route isn't a refresh trigger.
//
// EffectsShell reads this via lazy useState initializers on mount, so
// no effect-driven rehydration flash. On unmount the cleanup writes
// the latest refs back in. If the user visits `/docs` and comes back,
// the editor looks exactly as they left it.

export interface EditorSessionSnapshot {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  currentProject: {
    id: string;
    name: string;
    isPublic: boolean;
    // Mirror of projects.public_slug. Carried so the file-name menu's
    // "Copy editor link" button has the slug without a separate fetch.
    publicSlug: string | null;
    ownerId: string;
    authorName: string | null;
  } | null;
  selectedId: string | null;
  paramView: "project" | "node" | "load";
  saveState: SaveState;
  canvasRes: [number, number];
  // Composition registry (v5) — carried so a docs round-trip restores the
  // exact compositions and active selection, not just the tagged nodes.
  compositions: SavedComposition[];
  activeCompositionId: string;
  // Per-project user-saved easing curves (Graph Editor "Save" button) —
  // carried so a docs round-trip doesn't drop unsaved additions.
  savedEasings: SavedEasing[];
  // Live-link look-and-feel (081426_live-link-designer.md). Null = the
  // project never authored one (absent stays absent on save).
  liveDesign: LiveDesign | null;
  // Tiled window layout (072726_window-tiling.md M4). Carried by
  // reference — leaf ids survive, so the sticky primary election (and
  // NodeEditor's per-pane camera stash, keyed on leaf ids) restore
  // exactly.
  layoutTree: LayoutTree;
  primaryViewportLeafId: string | null;
}

let stash: EditorSessionSnapshot | null = null;

export function readEditorSession(): EditorSessionSnapshot | null {
  return stash;
}

export function writeEditorSession(snap: EditorSessionSnapshot): void {
  stash = snap;
}

// Called by File → New so returning from docs doesn't resurrect
// the pre-reset graph. Any other "start fresh" path that wants to
// opt out of the session survival can call this too.
export function clearEditorSession(): void {
  stash = null;
}
