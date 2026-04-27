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
