// Shim for `@/state/graph`. The editor's `src/lib/project.ts` imports
// `NodeDataPayload` from this path. We only need a structurally compatible
// type at compile time — runtime references are erased.

import type { ParamType } from "@engine/types";
export type { ParamType };

export type NodeDataPayload = {
  defType: string;
  params: Record<string, unknown>;
  exposedParams?: string[];
  controlParams?: string[];
  paramOverrides?: Record<
    string,
    { min?: number; max?: number; softMax?: number }
  >;
  linkedParams?: Record<string, { ratio: number }>;
  error?: string;
  auxOutputs: { name: string; type: string; disabled?: boolean }[];
  inputs: { name: string; label?: string; type: string }[];
  primaryOutput: string | null;
  name: string;
  terminal?: boolean;
  active?: boolean;
  active2?: boolean;
  bypassed?: boolean;
  [key: string]: unknown;
};

// Re-export the engine helpers so any code that imports them from
// `@/state/graph` keeps working through the shim.
export { paramSocketType, parseTargetHandleKind } from "@engine/graph-helpers";

// `@/state/graph-ops` (aliased to the real module in vite.config) imports
// this id generator from `@/state/graph`. It's a trivial pure helper, so the
// shim carries a verbatim copy rather than pulling in the full editor module.
export function newNodeId(type: string) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}`;
}

// graph-ops also mints composition ids (v5+). Verbatim copy of the real
// helper so the export-template bundle doesn't pull in the editor module.
export function newCompositionId() {
  return `comp-${Math.random().toString(36).slice(2, 8)}`;
}

// graph-ops imports the frame-zone xyflow props (editor-only chrome for
// frame nodes). Verbatim copy of the real constant — inert in the export
// runtime (no xyflow), but the import must resolve.
export const FRAME_XY_PROPS = {
  dragHandle: ".frame-drag-handle",
  zIndex: -1,
  style: { pointerEvents: "none" as const },
};
