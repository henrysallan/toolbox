// Which nodes are actually rendering right now — the live link's answer to
// "should this control row show?" (2026-09-16).
//
// The export-manifest builder decides which controls EXIST with the
// evaluator's needed-set walk: plain upstream reachability from the output,
// every edge followed. That is the right list to author against (a control
// on either branch of a Switch is real), but the wrong list to SHOW at any
// one moment: with two Color Ramps behind a Switch, the ramp the Switch
// isn't picking still gets its rows, and flipping the Switch's pill changes
// the picture but not the panel. This module re-runs the same walk with one
// change — at a Switch, only the edge into the PICKED slot is followed — so
// the viewer shows the controls for what is on screen and hides the other
// branch's rows until the pick changes. Slider or toggle mode alike: a
// control on a branch that isn't rendering is dead weight either way.
//
// Conservative where the pick isn't a hand-set value: an Index that is
// wired (`in:index`, or the param exposed as `in:param:index`), keyframed
// with animation on, or on a bypassed Switch follows every slot. A wire- or
// key-driven pick changes every frame and rows flickering in and out would
// be worse than showing both; bypass passes the first socket through
// regardless of Index.
//
// Structure mirrors buildExportManifest: remap a structural terminal (a
// Layer's Group Output, a reroute) to its real producer, flatten so group
// boundaries splice through, then walk. Interior node ids survive flatten,
// so the returned set is keyed the way manifest controls are. Zone
// interiors (Iterate / Repeat / For Each) leave the flat graph in both
// walks, so they never had controls to hide.

import {
  computeNeededSet,
  type GraphEdge,
  type GraphNode,
} from "./evaluator";
import { flattenGraph, resolvePreviewProducer } from "./flatten";
import {
  SWITCH_TYPE,
  isSwitchSlot,
  parseTargetHandleKind,
  readSwitchSlots,
} from "./graph-helpers";

export interface ActiveBranchOptions {
  /**
   * Live Index per Switch node id, for callers holding fresher values than
   * `node.params` (the live viewer's control state, the designer preview's
   * ephemeral values). `undefined` for a node ⇒ its own `params.index`.
   */
  indexOf?: (switchNodeId: string) => unknown;
}

/**
 * The slot a Switch is picking, or null when the pick can't be known from
 * the graph alone (wired / keyframed Index, bypassed node) — callers then
 * follow every slot.
 */
export function switchPickedSlot(
  node: GraphNode,
  edges: GraphEdge[],
  indexValue: unknown
): string | null {
  if (node.bypassed) return null;
  const anim = node.animation?.index;
  if (anim?.animated && anim.keyframes.length > 0) return null;
  for (const e of edges) {
    if (e.target !== node.id) continue;
    const parsed = parseTargetHandleKind(e.targetHandle);
    // Either the `index` socket or the exposed `param:index` — both mean
    // the value arrives on a wire.
    if (parsed?.name === "index") return null;
  }
  const slots = readSwitchSlots(node.params);
  const raw = typeof indexValue === "number" ? indexValue : 0;
  let i = Math.round(raw);
  if (!Number.isFinite(i)) i = 0;
  i = Math.max(0, Math.min(slots.length - 1, i));
  return slots[i] ?? null;
}

/**
 * Node ids on the rendering path from `outputNodeId`: the needed set, except
 * that each Switch with a hand-set Index contributes only its picked slot's
 * upstream. Pass the UNflattened graph (as the viewer and the manifest
 * builder hold it); remap + flatten happen here.
 */
export function computeActiveNodeSet(
  nodes: GraphNode[],
  edges: GraphEdge[],
  outputNodeId: string,
  opts: ActiveBranchOptions = {}
): Set<string> {
  const remapped = resolvePreviewProducer(nodes, edges, outputNodeId);
  const reachFrom = remapped ? remapped.nodeId : outputNodeId;
  const flat = flattenGraph(nodes, edges);

  // Each Switch's pick (null = unknown, follow everything).
  const pickedBySwitch = new Map<string, string | null>();
  for (const n of flat.nodes) {
    if (n.type !== SWITCH_TYPE) continue;
    const live = opts.indexOf?.(n.id);
    pickedBySwitch.set(
      n.id,
      switchPickedSlot(n, flat.edges, live ?? n.params.index)
    );
  }

  // Drop the edges into every slot a Switch is NOT picking. The index
  // socket, mask, param edges and the picked slot all stay.
  const pruned: GraphEdge[] = [];
  for (const e of flat.edges) {
    const picked = pickedBySwitch.get(e.target);
    if (picked != null) {
      const parsed = parseTargetHandleKind(e.targetHandle);
      if (
        parsed?.kind === "input" &&
        isSwitchSlot(parsed.name) &&
        parsed.name !== picked
      ) {
        continue;
      }
    }
    pruned.push(e);
  }
  return computeNeededSet(flat.nodes, pruned, reachFrom);
}
