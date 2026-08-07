// Shared helpers for the `list` socket type — and the one place its ownership
// contract is written down. Engine-side and self-contained (invariant #1): no
// imports outside the engine subtree, no GL, no DOM.
//
// ---------------------------------------------------------------------------
// OWNERSHIP CONTRACT — read this before writing a node that touches lists.
// ---------------------------------------------------------------------------
// A ListValue holds BORROWED references, exactly like ImageGroupValue. The
// evaluator's release paths (`releaseCachedTextures` on eviction, and the
// transient collector for uncacheable outputs) only inspect TOP-LEVEL
// image/mask/uv values — neither recurses into containers. So the *producing*
// node's cache entry owns any texture reachable from a list, and:
//
//   1. A list op node must NEVER allocate per-item textures. Reorder, select,
//      and pass references through — then ownership never enters the picture.
//   2. A node that genuinely builds GPU values per item must own them in
//      `ctx.state["<type>:<nodeId>"]`, return `ownsTextures: false`, and free
//      them in `dispose` (the Text / Simulation Zones precedent).
//   3. Never release a texture reachable from a list you RECEIVED
//      (invariant #3: release what you alloc, never what you receive).
//
// Spec: specdocs/080526_list-socket.md.

import type { ListValue, SocketType, SocketValue } from "./types";

/**
 * The single socket kind every item shares, or null when the list is empty or
 * MIXED. Lists carry no declared item type on purpose — this is how a consumer
 * that needs one (a retyped output socket, a numeric sort) asks.
 */
export function listItemType(list: ListValue | null | undefined): SocketType | null {
  const items = list?.items;
  if (!items || items.length === 0) return null;
  const first = items[0].kind;
  for (let i = 1; i < items.length; i++) {
    if (items[i].kind !== first) return null;
  }
  return first;
}

/**
 * Resolve an index against a list length under the clamp/wrap convention
 * shared with the CSV node's `row`. Fractional indices floor. Returns -1 for
 * an empty list (no item to address).
 */
export function resolveListIndex(
  index: number,
  length: number,
  mode: "clamp" | "wrap"
): number {
  if (length <= 0) return -1;
  let i = Math.floor(Number.isFinite(index) ? index : 0);
  if (mode === "wrap") i = ((i % length) + length) % length;
  else i = Math.max(0, Math.min(length - 1, i));
  return i;
}

/**
 * A one-line display string for any socket value — what a list item shows in
 * the param panel preview and the socket peek. CPU data reads as its value;
 * texture-backed and runtime-only kinds read as their kind, since there's
 * nothing honest to print.
 */
export function describeListItem(v: SocketValue): string {
  switch (v.kind) {
    case "string":
      return v.value;
    case "scalar":
      return formatItemNumber(v.value);
    case "vec2":
    case "vec3":
    case "vec4":
      return `[${v.value.map(formatItemNumber).join(", ")}]`;
    case "image":
    case "mask":
    case "uv":
      return `${v.kind} ${v.width}×${v.height}`;
    case "spline":
      return `spline · ${v.subpaths.length} subpath${v.subpaths.length === 1 ? "" : "s"}`;
    case "points":
      return `points · ${v.count}`;
    case "list":
      return `list · ${v.items.length}`;
    default:
      return v.kind;
  }
}

// Compact number rendering for previews: up to 4 decimals, no trailing zeros.
function formatItemNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(4)));
}
