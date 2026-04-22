"use client";

import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeDataPayload } from "@/state/graph";

export type GraphSnapshot = {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
};

export type PaintSnapshot = {
  nodeId: string;
  canvas: HTMLCanvasElement;
  imageData: ImageData;
};

type GraphEntry = { kind: "graph"; snap: GraphSnapshot; coalesceKey?: string };
type PaintEntry = { kind: "paint"; snap: PaintSnapshot };
type HistoryEntry = GraphEntry | PaintEntry;

const MAX_HISTORY = 50;
// Consecutive graph pushes with the same coalesceKey within this window are
// collapsed into a single undo entry — e.g. slider drag firing many changes.
const COALESCE_WINDOW_MS = 700;

export interface UseHistoryArgs {
  getGraphSnapshot: () => GraphSnapshot;
  applyGraphSnapshot: (snap: GraphSnapshot) => void;
  // Called after paint pixels are restored so the caller can refresh the
  // ImageBitmap snapshot that feeds the pipeline.
  onPaintRestore: (nodeId: string, canvas: HTMLCanvasElement) => void;
}

export interface History {
  pushGraph: (before: GraphSnapshot, coalesceKey?: string) => void;
  pushPaint: (snap: PaintSnapshot) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory(args: UseHistoryArgs): History {
  const getRef = useRef(args.getGraphSnapshot);
  getRef.current = args.getGraphSnapshot;
  const applyRef = useRef(args.applyGraphSnapshot);
  applyRef.current = args.applyGraphSnapshot;
  const paintRef = useRef(args.onPaintRestore);
  paintRef.current = args.onPaintRestore;

  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const lastPushRef = useRef<{ time: number; key: string } | null>(null);

  // Drives re-renders so consumers can react to canUndo/canRedo changes.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const pushGraph = useCallback(
    (before: GraphSnapshot, coalesceKey?: string) => {
      const now = performance.now();
      const last = lastPushRef.current;
      const topIsGraph =
        pastRef.current.length > 0 &&
        pastRef.current[pastRef.current.length - 1].kind === "graph";

      if (
        coalesceKey &&
        last &&
        last.key === coalesceKey &&
        now - last.time < COALESCE_WINDOW_MS &&
        topIsGraph
      ) {
        // Same-action rapid fire — keep the original before-state, just refresh
        // the timestamp so subsequent changes keep coalescing.
        lastPushRef.current = { time: now, key: coalesceKey };
        return;
      }

      pastRef.current.push({ kind: "graph", snap: before, coalesceKey });
      if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
      futureRef.current = [];
      lastPushRef.current = coalesceKey ? { time: now, key: coalesceKey } : null;
      bump();
    },
    [bump]
  );

  const pushPaint = useCallback(
    (snap: PaintSnapshot) => {
      pastRef.current.push({ kind: "paint", snap });
      if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
      futureRef.current = [];
      lastPushRef.current = null;
      bump();
    },
    [bump]
  );

  const swap = useCallback(
    (from: HistoryEntry[], to: HistoryEntry[]) => {
      const entry = from.pop();
      if (!entry) return false;
      if (entry.kind === "graph") {
        const current = getRef.current();
        applyRef.current(entry.snap);
        to.push({ kind: "graph", snap: current });
      } else {
        const { canvas, nodeId, imageData } = entry.snap;
        const c2d = canvas.getContext("2d");
        if (!c2d) {
          // Can't restore — drop the entry.
          return true;
        }
        const current = c2d.getImageData(0, 0, canvas.width, canvas.height);
        c2d.putImageData(imageData, 0, 0);
        to.push({
          kind: "paint",
          snap: { canvas, nodeId, imageData: current },
        });
        paintRef.current(nodeId, canvas);
      }
      lastPushRef.current = null;
      return true;
    },
    []
  );

  const undo = useCallback(() => {
    if (swap(pastRef.current, futureRef.current)) bump();
  }, [swap, bump]);

  const redo = useCallback(() => {
    if (swap(futureRef.current, pastRef.current)) bump();
  }, [swap, bump]);

  return {
    pushGraph,
    pushPaint,
    undo,
    redo,
    // Touch `version` so this object updates on every history mutation.
    canUndo: pastRef.current.length > 0 && version >= 0,
    canRedo: futureRef.current.length > 0 && version >= 0,
  };
}

// Wire Cmd/Ctrl-Z and Cmd/Ctrl-Shift-Z to undo/redo. Skips when focus is on
// editable elements so typing in inputs still gets native undo.
export function useUndoShortcuts(undo: () => void, redo: () => void) {
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key !== "z" && e.key !== "Z" && e.key !== "y" && e.key !== "Y")
        return;
      const target = e.target as HTMLElement | null;
      if (target && isEditable(target)) return;
      e.preventDefault();
      const isRedo = (e.shiftKey && (e.key === "z" || e.key === "Z")) || e.key === "y" || e.key === "Y";
      if (isRedo) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === "INPUT") {
    const t = (el as HTMLInputElement).type;
    // Range/color/checkbox sliders don't consume native undo — treat as non-editable.
    return t !== "range" && t !== "color" && t !== "checkbox" && t !== "radio";
  }
  if (tag === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return false;
}
