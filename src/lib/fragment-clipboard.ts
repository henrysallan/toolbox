// Portable node-group fragment over the OS clipboard. Lets a group / recipe be
// copied in one tab or instance of Toolbox and pasted into another (or shared
// as a text snippet — paste it anywhere, paste it back). The payload is the
// same JSON envelope the project saver produces (so params, inlined media, and
// schema migration all come for free); only the transport differs.
//
// Same-tab paste still falls back to the in-memory clipboard, so this degrades
// gracefully when the Clipboard API is unavailable (insecure context, denied
// permission).

import type { Edge, Node } from "@xyflow/react";
import { serializeGraph, type SavedProject } from "@/lib/project";
import type { NodeDataPayload } from "@/state/graph";

// Marker key identifying a Toolbox fragment envelope on the clipboard.
export const FRAGMENT_MARKER = "__toolbox_fragment__";

type FragmentEnvelope = SavedProject & { [FRAGMENT_MARKER]: number };

// Serialize a selection (a group + its interior, typically) to a portable text
// envelope — a SavedProject with a marker field. `deserializeGraph` ignores the
// marker, so the envelope round-trips through the normal load path.
export async function serializeFragmentToText(
  nodes: Node<NodeDataPayload>[],
  edges: Edge[]
): Promise<string> {
  const saved = await serializeGraph(nodes, edges);
  const env: FragmentEnvelope = { [FRAGMENT_MARKER]: 1, ...saved };
  return JSON.stringify(env);
}

// Cheap synchronous gate used inside a `paste` event to decide whether the OS
// clipboard text is one of ours before doing the async deserialize.
export function looksLikeFragmentText(text: string): boolean {
  return text.includes(FRAGMENT_MARKER);
}

// Parse the envelope back to a SavedProject. Returns null if the text isn't a
// well-formed fragment (so the caller can fall through to other paste paths).
export function parseFragmentText(text: string): SavedProject | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    if (obj[FRAGMENT_MARKER] == null) return null;
    if (!Array.isArray(obj.nodes)) return null;
    return obj as unknown as SavedProject;
  } catch {
    return null;
  }
}

// Best-effort publish to the OS clipboard. Resolves false (never throws) when
// the Clipboard API is unavailable or denied.
export async function writeFragmentToClipboard(
  nodes: Node<NodeDataPayload>[],
  edges: Edge[]
): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
      return false;
    const text = await serializeFragmentToText(nodes, edges);
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
