// Saved window-layout presets (072726_window-tiling.md § Window menu).
// Same storage strategy as brush presets (paint-editor/presets.ts):
// localStorage is the always-on store (works signed-out / offline / before
// the Supabase column migration lands); the cloud copy in
// user_preferences.layout_presets syncs on top when available. Cloud wins
// on load (cross-device source of truth); every save writes both.
//
// The two BUILT-IN presets are code, not data — they're the arrangements
// the tiling system replaced and always head the menu.

import {
  fromSavedLayout,
  makeDefaultTree,
  makeTimelineTree,
  toSavedLayout,
  type LayoutTree,
  type SavedLayout,
} from "./model";
import {
  loadCloudLayoutPresets,
  saveCloudLayoutPresets,
} from "@/lib/supabase/user-preferences";

export interface LayoutPreset {
  id: string;
  name: string;
  /** Id-free split tree — rehydrated with fresh ids by fromSavedLayout. */
  layout: SavedLayout;
}

/** A menu-ready row: built-ins first, then the user's saved presets. */
export interface LayoutPresetEntry {
  id: string;
  name: string;
  builtin: boolean;
}

export const BUILTIN_LAYOUT_PRESETS: readonly {
  id: string;
  name: string;
  make: () => LayoutTree;
}[] = [
  { id: "default", name: "Default", make: makeDefaultTree },
  { id: "timeline", name: "Timeline", make: makeTimelineTree },
];

const LS_KEY = "toolbox:layout-presets";
const MAX_PRESETS = 40;
const MAX_NAME = 40;

export function mintPresetId(): string {
  return `layout-${Math.random().toString(36).slice(2, 10)}`;
}

// Validate untrusted JSON (localStorage or cloud) into well-formed presets.
// A preset whose tree fails fromSavedLayout's structural checks is dropped
// rather than repaired — a half-valid layout is worse than a missing one.
function sanitize(raw: unknown): LayoutPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: LayoutPreset[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PRESETS) break;
    if (!item || typeof item !== "object") continue;
    const p = item as { id?: unknown; name?: unknown; layout?: unknown };
    if (typeof p.name !== "string" || !p.name.trim()) continue;
    const tree = fromSavedLayout(p.layout);
    if (!tree) continue;
    out.push({
      id: typeof p.id === "string" && p.id ? p.id : mintPresetId(),
      name: p.name.trim().slice(0, MAX_NAME),
      // Re-serialize from the parsed tree so stored blobs are normalized.
      layout: toSavedLayout(tree),
    });
  }
  return out;
}

export function loadLocalLayoutPresets(): LayoutPreset[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveLocalLayoutPresets(list: LayoutPreset[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // Quota / privacy-mode failures are non-fatal — cloud may still work.
  }
}

/** Cloud copy if reachable (also refreshed into localStorage), local otherwise. */
export async function loadLayoutPresets(): Promise<LayoutPreset[]> {
  const cloud = await loadCloudLayoutPresets();
  if (cloud !== null) {
    const list = sanitize(cloud);
    saveLocalLayoutPresets(list);
    return list;
  }
  return loadLocalLayoutPresets();
}

export async function saveLayoutPresets(list: LayoutPreset[]): Promise<void> {
  saveLocalLayoutPresets(list);
  // Best-effort — signed-out / offline / missing column all no-op.
  await saveCloudLayoutPresets(list);
}

/**
 * Append (or replace by name — case-insensitive, so "Wide" twice
 * overwrites rather than piling up) a preset capturing `tree`. Returns the
 * new list; the caller owns persisting it.
 */
export function upsertLayoutPreset(
  list: LayoutPreset[],
  name: string,
  tree: LayoutTree
): LayoutPreset[] {
  const trimmed = name.trim().slice(0, MAX_NAME);
  const layout = toSavedLayout(tree);
  const at = list.findIndex(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (at >= 0) {
    const next = list.slice();
    next[at] = { ...next[at], name: trimmed, layout };
    return next;
  }
  return [...list, { id: mintPresetId(), name: trimmed, layout }].slice(
    0,
    MAX_PRESETS
  );
}

/**
 * Resolve a menu row id to a live tree: the two built-ins by id, otherwise
 * a saved preset (null when it's missing or its stored blob is malformed —
 * the caller leaves the current layout alone).
 */
export function resolveLayoutPreset(
  id: string,
  presets: LayoutPreset[]
): LayoutTree | null {
  const builtin = BUILTIN_LAYOUT_PRESETS.find((p) => p.id === id);
  if (builtin) return builtin.make();
  const saved = presets.find((p) => p.id === id);
  return saved ? fromSavedLayout(saved.layout) : null;
}

/** Built-ins + user presets as menu rows, in display order. */
export function layoutPresetEntries(
  presets: LayoutPreset[]
): LayoutPresetEntry[] {
  return [
    ...BUILTIN_LAYOUT_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      builtin: true,
    })),
    ...presets.map((p) => ({ id: p.id, name: p.name, builtin: false })),
  ];
}
