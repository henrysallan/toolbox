// Skia layers (specdocs/101326_skia-target.md §3.1). A layer shell whose
// `target` param is "skia" only holds nodes with a React Native Skia
// lowering — defs that declare `NodeDefinition.skia` — so exporting it is
// deterministic codegen, not a translation loop. One predicate drives every
// surface that offers or accepts a node: the add-node menu and search, MCP
// get_catalog({ target: "skia" }), and the recipe / edit validator.
//
// Switching a layer's target is non-destructive: nodes already inside stay
// (they just won't export, and nonSkiaLayerMembers names them).
//
// Engine content (the `bake` class, Wave 3): a Skia layer still holds only
// Skia nodes. A picture only the engine can make — a blur or bloom over
// noise, a simulation, video — is built OUTSIDE the layer and enters it as
// an image through a Layer Input socket (one minted on the interior Layer
// Input, or its `backdrop`) wired into Skia Bake (`skia-bake`, class
// "bake"), which the export renders with the real engine and ships as a
// PNG / sprite sheet. Flatten splices the Layer Input wire, so the
// evaluator sees source → Skia Bake. No engine node is ever sanctioned
// inside the layer: the add-node menu would have to offer the whole
// catalog there, and the layer would stop reading as "what ships".
//
// Engine-side and pure (no React, no editor state) so graph-validation can
// call it and the export bundle stays self-contained.

import { getNodeDef } from "../registry";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  LAYER_TYPE,
} from "../groups";
import { FRAME_TYPE, REROUTE_TYPE } from "../graph-helpers";
import type { NodeDefinition } from "../types";

export const LAYER_TARGETS = ["default", "skia"] as const;
export type LayerTarget = (typeof LAYER_TARGETS)[number];

// A layer shell's target. Anything but "skia" — a save from before the
// param existed included — reads "default".
export function readLayerTarget(
  params: Record<string, unknown> | undefined | null
): LayerTarget {
  return params?.target === "skia" ? "skia" : "default";
}

// Structural utilities that stay available inside any layer, Skia or not.
// Each one is dissolved by flatten or never evaluated, so none of them
// reaches the exported scene:
//   node-group, group-input, group-output — group structure. A Skia layer's
//     own boundary nodes are group-input / group-output, insert_recipe wraps
//     every recipe in a node-group, and Cmd+G must keep working inside one.
//   reroute — a wire waypoint flatten splices straight through.
//   frame-zone — a cosmetic backdrop with no sockets.
// Deliberately absent: the zones (iterate / repeat / foreach and simulation
// start / end) and Time Offset. They read as structure but COMPUTE (a nested
// evaluation per pass) and have no Skia lowering; a Skia version would be
// its own `skia-*` def.
export const SKIA_LAYER_UTILITY_TYPES: ReadonlySet<string> = new Set([
  GROUP_TYPE,
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  REROUTE_TYPE,
  FRAME_TYPE,
]);

// True when a def may live inside a Skia layer.
export function isOfferedInSkiaLayer(
  def: Pick<NodeDefinition, "type" | "skia"> | undefined
): boolean {
  if (!def) return false;
  return !!def.skia || SKIA_LAYER_UTILITY_TYPES.has(def.type);
}

// Same test by type string (registry lookup).
export function isSkiaLayerType(type: string): boolean {
  return SKIA_LAYER_UTILITY_TYPES.has(type) || isOfferedInSkiaLayer(getNodeDef(type));
}

// The add-node menus' filter inside a Skia layer. Entries mix real defs
// with the menus' pseudo entries (compound zones, presets, the AI rows):
// `typesOf` names the node types an entry would insert (a preset's
// fragment, [] for one that inserts nothing itself), or null to judge the
// entry by its own `type`.
export function filterForSkiaLayer<T extends { type: string }>(
  entries: readonly T[],
  typesOf?: (entry: T) => readonly string[] | null | undefined
): T[] {
  return entries.filter((e) => {
    const types = typesOf?.(e);
    return types ? types.every(isSkiaLayerType) : isSkiaLayerType(e.type);
  });
}

// What the React Native Skia export accepts as a target: exportSkia's
// branches (src/lib/skia-export/api.ts), plus a Skia layer, which resolves
// to whichever of the two feeds its Layer Output.
export const SKIA_EXPORT_TARGET_TYPES: ReadonlySet<string> = new Set([
  "sksl-shader",
  "skia-canvas",
]);

export function isSkiaExportTarget(
  type: string,
  params: Record<string, unknown> | undefined | null
): boolean {
  return (
    SKIA_EXPORT_TARGET_TYPES.has(type) ||
    (type === LAYER_TYPE && readLayerTarget(params) === "skia")
  );
}

export interface SkiaLayerRef {
  id: string;
  name: string;
}

// Minimal view of a node for the scope walk — the editor's
// Node<NodeDataPayload> and the engine GraphNode both map to it trivially.
export interface ScopeNodeInfo {
  type: string;
  parentId?: string;
  params?: Record<string, unknown>;
  name?: string;
}

// The Skia layer a scope sits in: walk parentId from `scopeId` (inclusive)
// to the nearest layer shell and return it when its target is "skia".
// Node-groups and zone shells on the way are transparent; layers are
// root-only, so the first one found is the only one.
export function enclosingSkiaLayer(
  scopeId: string | null | undefined,
  lookup: (id: string) => ScopeNodeInfo | undefined
): SkiaLayerRef | null {
  let cur = scopeId ?? undefined;
  for (let guard = 0; cur && guard < 256; guard++) {
    const n = lookup(cur);
    if (!n) return null;
    if (n.type === LAYER_TYPE) {
      return readLayerTarget(n.params) === "skia"
        ? { id: cur, name: n.name || "Layer" }
        : null;
    }
    cur = n.parentId;
  }
  return null;
}

export interface SkiaMemberNode {
  id: string;
  defType: string;
  parentId?: string;
  params?: Record<string, unknown>;
  name?: string;
}

// Nodes that sit inside a Skia layer but have no Skia lowering. A node's
// layer is found by walking parentId through `nodes`; when the chain leaves
// the set (a recipe fragment about to be committed into a scope, or a group
// edited in place), `outer` — the Skia layer holding the whole set — applies.
// Unknown types are skipped: the validator already reports those.
export function nonSkiaLayerMembers(
  nodes: SkiaMemberNode[],
  outer?: SkiaLayerRef | null
): { node: SkiaMemberNode; layer: SkiaLayerRef }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: { node: SkiaMemberNode; layer: SkiaLayerRef }[] = [];
  for (const n of nodes) {
    if (n.defType === LAYER_TYPE) continue;
    if (!getNodeDef(n.defType) && !SKIA_LAYER_UTILITY_TYPES.has(n.defType)) continue;
    let layer: SkiaLayerRef | null = null;
    let cur = n.parentId;
    for (let guard = 0; guard < 256; guard++) {
      const p = cur ? byId.get(cur) : undefined;
      if (!p) {
        layer = outer ?? null;
        break;
      }
      if (p.defType === LAYER_TYPE) {
        layer =
          readLayerTarget(p.params) === "skia"
            ? { id: p.id, name: p.name || "Layer" }
            : null;
        break;
      }
      cur = p.parentId;
    }
    if (layer && !isSkiaLayerType(n.defType)) out.push({ node: n, layer });
  }
  return out;
}

export function skiaLayerIssueMessage(
  node: SkiaMemberNode,
  layer: SkiaLayerRef
): string {
  return (
    `Node ${node.id} (${node.defType}) can't go inside Skia layer "${layer.name}" — ` +
    `a Skia layer only holds nodes with a React Native Skia lowering ` +
    `(get_catalog with target: "skia" lists them). To ship what it draws, build it outside ` +
    `the layer and wire its image in through a Layer Input socket into a Skia Bake (skia-bake).`
  );
}
