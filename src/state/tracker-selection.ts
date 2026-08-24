// Per-node track-row selection. Editor state, not a param — so the panel
// and the playhead-driven overlay agree without lifting into EffectsApp,
// and selecting a row neither re-fingerprints the node nor lands in undo.
// Playback-clock pattern: get / set / subscribe + a hook.
// Spec: 082226_motion-tracking.md §5.1.

import { useSyncExternalStore } from "react";

export interface TrackerSelection {
  nodeId: string | null;
  ids: number[];
}

let state: TrackerSelection = { nodeId: null, ids: [] };
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

export const trackerSelection = {
  get(): TrackerSelection {
    return state;
  },
  set(next: TrackerSelection): void {
    const sameNode = next.nodeId === state.nodeId;
    const sameIds =
      sameNode &&
      next.ids.length === state.ids.length &&
      next.ids.every((id, i) => id === state.ids[i]);
    if (sameIds) return;
    state = { nodeId: next.nodeId, ids: next.ids.slice() };
    notify();
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

export function useTrackerSelection(nodeId: string): number[] {
  return useSyncExternalStore(
    trackerSelection.subscribe,
    () => {
      const s = trackerSelection.get();
      return s.nodeId === nodeId ? s.ids : EMPTY;
    },
    () => EMPTY
  );
}

const EMPTY: number[] = [];

export function setTrackerSelection(nodeId: string, ids: number[]): void {
  trackerSelection.set({ nodeId, ids });
}

export function toggleTrackerSelection(
  nodeId: string,
  id: number,
  additive: boolean
): void {
  const s = trackerSelection.get();
  const cur = s.nodeId === nodeId ? s.ids : [];
  if (!additive) {
    trackerSelection.set({ nodeId, ids: [id] });
    return;
  }
  if (cur.includes(id)) {
    trackerSelection.set({ nodeId, ids: cur.filter((x) => x !== id) });
  } else {
    trackerSelection.set({ nodeId, ids: [...cur, id] });
  }
}
