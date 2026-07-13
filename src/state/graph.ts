// `paramSocketType` and `parseTargetHandleKind` now live in
// `@/engine/graph-helpers` (the engine subtree must be self-contained for
// the Export App bundle). Re-exported here for back-compat with existing
// editor imports — prefer importing from the engine path in new code.
export {
  paramSocketType,
  parseTargetHandleKind,
} from "@/engine/graph-helpers";

import type { AnimationMap } from "@/engine/keyframes";
import type { ClipBlock } from "@/engine/clips";

export type NodeDataPayload = {
  defType: string;
  // Group nesting: id of the node-group this node lives inside, or
  // undefined for root scope. The nodes array stays flat — nesting is
  // arbitrary depth via parentId chains, and the NodeEditor filters
  // its view to one scope at a time. See
  // specdocs/layers-groups-attributes.md.
  parentId?: string;
  // Composition scoping (v5+): id of the composition this node belongs to.
  // A project holds multiple compositions and the editor shows one at a
  // time; orthogonal to `parentId` (which scopes within a composition).
  // May be undefined on freshly-created runtime nodes until persisted —
  // serializeGraph tags every node with the active composition on save.
  // See specdocs/062926_compositions-and-project-view.md.
  compositionId?: string;
  params: Record<string, unknown>;
  // Per-parameter keyframe animation, keyed by param name. A param is
  // either constant (no entry / `animated:false`), keyframe-animated
  // (`animated:true`), or wired (entry preserved but ignored at eval).
  // Wire > keyframes > constant. See src/engine/keyframes.ts.
  animation?: AnimationMap;
  // Timeline clip windows: one or more disjoint in/out ranges (and, for
  // time-driven sources like Video, a local-time remap per window). Splitting
  // a clip inserts a cut into this array. Only present on clippable source
  // nodes; see src/engine/clips.ts. Absent/empty ⇒ the node is always active
  // on the global clock.
  clips?: ClipBlock[];
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
  auxOutputs: {
    name: string;
    label?: string;
    type: string;
    disabled?: boolean;
  }[];
  // `hidden` inputs exist for the evaluator only (edges synthesized by
  // the flatten pass, e.g. a layer's `content`) — no handle renders.
  inputs: { name: string; label?: string; type: string; hidden?: boolean }[];
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
  // Set when a group was generated or edited by AI — drives the purple-star
  // "Edit with AI" button on the node (EffectNode). Persisted with the project.
  aiAuthored?: boolean;
  // Display-only overrides computed for the editor view (in scopedNodes) —
  // NOT serialized. `displayName` relabels a layer's boundary nodes (Layer
  // Input / Layer Output) and the comp-root Output (Composition Output);
  // `layerAccent` tints layer nodes + their boundaries blue. See #159 /
  // specdocs/062926_compositions-and-project-view.md.
  displayName?: string;
  layerAccent?: boolean;
  // User-resized node box, in flow (canvas) px, set by dragging the
  // bottom-left resize grip on the node. Absent ⇒ auto: width falls back to
  // the per-type content `minWidth`, height to the content-driven body. Both
  // persist with the project (serialize passes them through — additive, no
  // schema bump). Editor-only; the engine never reads them.
  uiWidth?: number;
  uiHeight?: number;
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

// Composition ids (v5+). A project holds an ordered list of compositions;
// every node carries the id of the composition it lives in. See
// specdocs/062926_compositions-and-project-view.md.
export function newCompositionId() {
  return `comp-${Math.random().toString(36).slice(2, 8)}`;
}
