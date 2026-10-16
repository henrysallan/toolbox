// Layers editor property model (specdocs/101526_layer-transforms-parenting.md
// §5): a layer's own AE-style properties as grouped lanes, the P / S / R / T
// / A / U reveal state machine, and the grouped-lane keyframe helpers.
// Pure — no React, no editor state — so check-layer-properties.mts can
// drive it directly.
//
// A grouped property (Position = translateX + translateY) is ONE lane whose
// diamonds are the union of its params' keys. Selecting a diamond selects
// every member key at that tick as ordinary per-param SelectionKeys, so the
// shared keyframe ops (move / scale / stagger / easing / delete) need no
// grouped variant.

import { evaluateKeyframesAt, type KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SelectionKey } from "./keyframe-ops";

export type LayerPropKey = "anchor" | "position" | "scale" | "rotation" | "opacity";

export interface LayerProperty {
  key: LayerPropKey;
  label: string;
  params: readonly string[];
  // Bare key that reveals it (AE: A / P / S / R / T).
  shortcut: string;
}

// AE's order under Transform: Anchor Point, Position, Scale, Rotation,
// Opacity.
export const LAYER_PROPERTIES: readonly LayerProperty[] = [
  { key: "anchor", label: "Anchor Point", params: ["pivotX", "pivotY"], shortcut: "a" },
  { key: "position", label: "Position", params: ["translateX", "translateY"], shortcut: "p" },
  { key: "scale", label: "Scale", params: ["scaleX", "scaleY"], shortcut: "s" },
  { key: "rotation", label: "Rotation", params: ["rotate"], shortcut: "r" },
  { key: "opacity", label: "Opacity", params: ["opacity"], shortcut: "t" },
];

const PROP_BY_KEY = new Map(LAYER_PROPERTIES.map((p) => [p.key, p]));

export function layerProperty(key: LayerPropKey): LayerProperty {
  return PROP_BY_KEY.get(key)!;
}

// What a reveal key asks for: one property, or U = "every animated one".
export type RevealKey = LayerPropKey | "animated";

const REVEAL_BY_LETTER: Record<string, RevealKey> = {
  a: "anchor",
  p: "position",
  s: "scale",
  r: "rotation",
  t: "opacity",
  u: "animated",
};

// The reveal key for a KeyboardEvent.key, or null. Case-insensitive, since
// Shift+P arrives as "P".
export function revealKeyFor(key: string): RevealKey | null {
  return REVEAL_BY_LETTER[key.toLowerCase()] ?? null;
}

// Per-row reveal: "all" (the chevron: every property plus promoted params)
// or an ordered subset of the built-in properties. A row absent from the
// map is collapsed.
export type Reveal = "all" | readonly LayerPropKey[];
export type RevealState = ReadonlyMap<string, Reveal>;

const ALL_KEYS: readonly LayerPropKey[] = LAYER_PROPERTIES.map((p) => p.key);

function canonical(keys: Iterable<LayerPropKey>): LayerPropKey[] {
  const set = new Set(keys);
  return ALL_KEYS.filter((k) => set.has(k));
}

function keysOf(r: Reveal | undefined): LayerPropKey[] {
  if (r === undefined) return [];
  return r === "all" ? [...ALL_KEYS] : [...r];
}

function sameKeys(a: readonly LayerPropKey[], b: readonly LayerPropKey[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

// The chevron: collapsed ↔ "all".
export function toggleRevealAll(state: RevealState, id: string): Map<string, Reveal> {
  const next = new Map(state);
  if (next.has(id)) next.delete(id);
  else next.set(id, "all");
  return next;
}

// Apply a reveal key to `targets` (the selected rows, or every row when
// none are selected), AE-style:
//   - bare key: show ONLY that property. If every target already shows
//     exactly that, collapse them instead (press again to close).
//   - Shift (additive): toggle that property on top of what's shown. If
//     every target already shows it, remove it (collapsing a row left
//     with nothing).
//   - U resolves per row to the properties with keyframes
//     (`animatedOf(id)`); a row with none collapses (bare U) or is left
//     as it was (Shift+U).
export function applyRevealKey(
  state: RevealState,
  targets: readonly string[],
  key: RevealKey,
  additive: boolean,
  animatedOf: (id: string) => readonly LayerPropKey[]
): Map<string, Reveal> {
  const next = new Map(state);
  if (targets.length === 0) return next;
  const wanted = (id: string): LayerPropKey[] =>
    key === "animated" ? canonical(animatedOf(id)) : [key];

  if (!additive) {
    const allSolo = targets.every((id) => {
      const w = wanted(id);
      const cur = state.get(id);
      return w.length > 0 && cur !== undefined && cur !== "all" && sameKeys(cur, w);
    });
    for (const id of targets) {
      const w = wanted(id);
      if (allSolo || w.length === 0) next.delete(id);
      else next.set(id, w);
    }
    return next;
  }

  const allHave = targets.every((id) => {
    const w = wanted(id);
    const cur = keysOf(state.get(id));
    return w.length > 0 && w.every((k) => cur.includes(k));
  });
  for (const id of targets) {
    const w = wanted(id);
    if (w.length === 0) continue;
    const cur = keysOf(state.get(id));
    const merged = allHave
      ? cur.filter((k) => !w.includes(k))
      : canonical([...cur, ...w]);
    if (merged.length === 0) next.delete(id);
    // A row that was "all" and gains nothing stays "all" (promoted params
    // included); any removal turns it into an explicit subset.
    else if (state.get(id) === "all" && !allHave) next.set(id, "all");
    else next.set(id, merged);
  }
  return next;
}

// The properties a row shows, and whether its promoted params come too
// (only under "all").
export function revealedProperties(r: Reveal | undefined): {
  properties: LayerProperty[];
  promoted: boolean;
} {
  if (r === undefined) return { properties: [], promoted: false };
  return {
    properties: keysOf(r).map(layerProperty),
    promoted: r === "all",
  };
}

type GetAnimation = (
  nodeId: string,
  paramName: string
) => KeyframeAnimationBlock | undefined;

// Properties of `nodeId` with at least one key on an animated block.
export function animatedProperties(
  nodeId: string,
  getAnimation: GetAnimation
): LayerPropKey[] {
  return LAYER_PROPERTIES.filter((p) =>
    p.params.some((name) => {
      const b = getAnimation(nodeId, name);
      return !!b && b.animated && b.keyframes.length > 0;
    })
  ).map((p) => p.key);
}

// The display block for a grouped lane: one keyframe per distinct tick
// across the members. `value` is every member's EVALUATED value at that
// tick (null for a member with no keys at all), so "does the value change
// across this segment" (dashed vs solid) compares what actually plays —
// a member keyed only at one end of a segment doesn't make it read as
// changing. Easing comes from the first member keyed there. A
// single-member lane returns its block unchanged. All layer properties
// are scalars.
export function mergeLaneBlocks(
  blocks: readonly (KeyframeAnimationBlock | undefined)[]
): KeyframeAnimationBlock | undefined {
  const present = blocks.filter(
    (b): b is KeyframeAnimationBlock => !!b && b.keyframes.length > 0
  );
  if (blocks.length === 1) return blocks[0];
  if (present.length === 0) return blocks.find((b) => !!b);
  const ticks = [...new Set(present.flatMap((b) => b.keyframes.map((k) => k.tick)))].sort(
    (a, b) => a - b
  );
  return {
    animated: present.some((b) => b.animated),
    trackVisible: present.some((b) => b.trackVisible),
    keyframes: ticks.map((tick) => {
      const first = present
        .map((b) => b.keyframes.find((k) => k.tick === tick))
        .find((k) => !!k)!;
      return {
        ...first,
        value: blocks.map((b) =>
          b && b.keyframes.length > 0
            ? (evaluateKeyframesAt(b, "scalar", tick) ?? null)
            : null
        ),
      };
    }),
  };
}

// Every member key of a grouped lane at `tick`, as per-param selection
// keys. Members without a key there are skipped.
export function memberKeysAt(
  nodeId: string,
  params: readonly string[],
  tick: number,
  getAnimation: GetAnimation
): SelectionKey[] {
  return params
    .filter((p) => getAnimation(nodeId, p)?.keyframes.some((k) => k.tick === tick))
    .map((paramName) => ({ nodeId, paramName, tick }));
}

// One per-param block write. `next` undefined clears the block.
export interface BlockUpdate {
  nodeId: string;
  paramName: string;
  next: KeyframeAnimationBlock | undefined;
}

// Shift every key on `params` of `nodeId` by `deltaTicks`, from
// `snapshot` (the blocks at drag start, so a live drag never compounds).
// D5: a layer's own keys travel with its bar.
export function shiftBlocks(
  nodeId: string,
  snapshot: ReadonlyMap<string, KeyframeAnimationBlock>,
  deltaTicks: number
): BlockUpdate[] {
  const out: BlockUpdate[] = [];
  for (const [paramName, block] of snapshot) {
    if (block.keyframes.length === 0) continue;
    out.push({
      nodeId,
      paramName,
      next: {
        ...block,
        keyframes: block.keyframes.map((k) => ({ ...k, tick: k.tick + deltaTicks })),
      },
    });
  }
  return out;
}
