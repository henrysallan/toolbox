import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "./graph";
import type { SaveState } from "@/components/effects/FileNameMenu";

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
    ownerId: string;
    authorName: string | null;
  } | null;
  selectedId: string | null;
  paramView: "project" | "node" | "load";
  saveState: SaveState;
  canvasRes: [number, number];
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
