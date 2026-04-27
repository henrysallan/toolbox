// `paramSocketType` and `parseTargetHandleKind` now live in
// `@/engine/graph-helpers` (the engine subtree must be self-contained for
// the Export App bundle). Re-exported here for back-compat with existing
// editor imports — prefer importing from the engine path in new code.
export {
  paramSocketType,
  parseTargetHandleKind,
} from "@/engine/graph-helpers";

export type NodeDataPayload = {
  defType: string;
  params: Record<string, unknown>;
  // Names of params that have been "exposed" — rendered as extra typed input
  // sockets on the node. When an exposed param has an incoming edge, the
  // edge's value overrides the stored param value at evaluation time.
  exposedParams?: string[];
  // Names of params marked as user-controllable in an exported app. Parallel
  // to `exposedParams`: expose is an engine concept (input socket); control
  // is an export concept (panel knob in the exported app). Both can be on
  // for the same param. Persisted with the project; default empty.
  controlParams?: string[];
  // User-defined slider range overrides keyed by param name. Each entry
  // can override `min`, `max`, and/or `softMax` from the param def.
  // Set via the right-click "Edit range" popover on a scalar slider;
  // saved with the project so the customization survives reload. The
  // engine doesn't read these — they're purely for the param-panel UI.
  paramOverrides?: Record<
    string,
    { min?: number; max?: number; softMax?: number }
  >;
  // Active chain-locks between pairs of scalar params declared by the
  // node's `linkedPairs`. Key is `${a}:${b}` matching the def order;
  // `ratio` is `b / a` captured at the moment the user clicked the
  // chain icon. While present, editing `a` writes `a * ratio` into `b`
  // (and vice-versa with `b / ratio`).
  linkedParams?: Record<string, { ratio: number }>;
  error?: string;
  auxOutputs: { name: string; type: string; disabled?: boolean }[];
  inputs: { name: string; label?: string; type: string }[];
  primaryOutput: string | null;
  name: string;
  terminal?: boolean;
  active?: boolean;
  // Second-viewport active flag. Only consulted when split-viewport mode
  // is on; the second canvas reads `active2` the same way the primary
  // canvas reads `active`. Persisted with the graph so a saved project
  // restores both terminals correctly.
  active2?: boolean;
  bypassed?: boolean;
  [key: string]: unknown;
};

export function makeSourceHandleId(kind: "primary" | "aux", name?: string) {
  return kind === "primary" ? "out:primary" : `out:aux:${name}`;
}

export function makeTargetHandleId(name: string) {
  return `in:${name}`;
}

export function makeParamTargetHandleId(paramName: string) {
  return `in:param:${paramName}`;
}

export function newNodeId(type: string) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}`;
}
