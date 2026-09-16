"use client";

import { createContext, useContext } from "react";

// Wire labels (091526): a free-text bubble parked on a wire. The bubble is
// rendered by JunctionEdge (inside React Flow's edge tree) but the edit
// commits, undo, and the right-click menu live in NodeEditor / EffectsApp —
// this context is the bridge. Runtime shape on the edge:
//   edge.data.label   — the text (absent = no label)
//   edge.data.labelT  — 0..1 along the wire's length (0.5 = midpoint)
// Persisted as SavedEdge.label / labelT (project.ts).

export type WireLabelPatch = {
  // undefined = leave alone; null = remove the label (and its labelT).
  label?: string | null;
  labelT?: number;
};

export interface WireLabelApi {
  // Commit a label edit. The parent owns undo (one entry per call).
  setLabel: (edgeId: string, patch: WireLabelPatch) => void;
  // Edge whose bubble should take keyboard focus — set by the context
  // menu's "Label Wire" / "Edit Label"; the bubble clears it once taken.
  focusEdgeId: string | null;
  consumeFocus: (edgeId: string) => void;
  // Right-click on the bubble opens the same wire menu as on the path.
  openMenu: (edgeId: string, clientX: number, clientY: number) => void;
}

export const WireLabelContext = createContext<WireLabelApi | null>(null);

export function useWireLabelApi(): WireLabelApi | null {
  return useContext(WireLabelContext);
}
