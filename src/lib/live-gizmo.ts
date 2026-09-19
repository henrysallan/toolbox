// Which nodes can ship their on-canvas GUI to the live link, and when the
// wiring would make those handles lie (specdocs/091726_live-gizmos.md).
//
// ONE source of truth for the parameter panel's node-level Control toggle,
// the manifest builder (lib/export-manifest.ts) and the gate
// (scripts/check-export-manifest.mts). The rules are the ones EffectsApp
// applies to the editor's own overlays (transformGizmoNodes /
// primitiveGizmoNodes), so the live link never shows a gizmo the editor
// would hide.
//
// Allow-list by construction: the spline editor, segment dots, the keyer
// sample picker, the tracker, the MIDI editor and the 3D scene are
// authoring tools, not controls, and never come through here.

import { getNodeDef } from "@/engine/registry";
import { PRIMITIVE_GIZMO_ADAPTERS } from "@/components/effects/PrimitiveGizmo";
import type { LiveGizmoKind } from "@/lib/live-viewer/manifest-types";

export type { LiveGizmoKind };

/**
 * The overlay that would draw this node's handles, or null when the node
 * has no live-eligible GUI. Def-level only — a Gradient is eligible in
 * every mode and the overlay simply draws nothing in the modes without
 * positional handles (polar, linear wave), exactly as the editor does.
 */
export function liveGizmoKind(defType: string): LiveGizmoKind | null {
  if (getNodeDef(defType)?.supportsTransformGizmo) return "transform";
  if (PRIMITIVE_GIZMO_ADAPTERS[defType]) return "primitive";
  if (defType === "gradient") return "gradient";
  return null;
}

/** Minimal edge shape — xyflow's Edge, the engine's GraphEdge and the
 *  saved edge all satisfy it. */
export interface WiringEdge {
  target: string;
  targetHandle?: string | null;
}

/**
 * Why the handles must stay hidden, as a sentence fragment for a warning,
 * or null when the gizmo is valid. Mirrors EffectsApp: Transform's own TRS
 * params are ignored while a `transform` value is wired (the Gizmo node
 * that authored it owns the widget — 082826_gizmo-node.md), and a
 * primitive adapter's `hideWhenWired` sockets retarget the shape's sample
 * space, so its handles would float off it.
 */
export function liveGizmoWiringBlocker(
  nodeId: string,
  defType: string,
  kind: LiveGizmoKind,
  edges: ReadonlyArray<WiringEdge>
): string | null {
  if (kind === "transform" && defType === "transform") {
    const wired = edges.some(
      (e) => e.target === nodeId && e.targetHandle === "in:transform"
    );
    return wired
      ? "its Transform input is wired (the wired value replaces its own handles)"
      : null;
  }
  if (kind === "primitive") {
    const hide = PRIMITIVE_GIZMO_ADAPTERS[defType]?.hideWhenWired;
    if (!hide || hide.length === 0) return null;
    const wired = hide.filter((h) =>
      edges.some((e) => e.target === nodeId && e.targetHandle === `in:${h}`)
    );
    return wired.length > 0
      ? `its ${wired.join(" / ")} input is wired (the handles would sit at the rest pose)`
      : null;
  }
  return null;
}
