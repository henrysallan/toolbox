// User node presets — "Save as Preset" (081226_user-node-presets.md).
// A preset's payload is a serialized clipboard-fragment envelope (the
// SavedProject that serializeGraph produces), NOT a {defType, params}
// snapshot: that buys inlined media, keyframes/cosmetics, schema
// migration on load, and group-with-interior support for free. Storage
// strategy is the brush/layout-preset precedent: localStorage is the
// always-on store, the Supabase user_preferences.node_presets column
// syncs on top when available, cloud wins on load, every save writes
// both.
//
// Unlike layout presets (React state in EffectsApp + prop threading),
// the list lives in a module store read through useSyncExternalStore
// (audio-audibility.ts pattern): both add menus render module-level
// preset lists far from EffectsApp's state, and a store lets them
// subscribe directly — a save from the context menu refreshes the menus
// with zero prop plumbing.

import { useSyncExternalStore } from "react";
import type { SavedProject } from "@/lib/project";
import {
  loadCloudNodePresets,
  saveCloudNodePresets,
} from "@/lib/supabase/user-preferences";

export interface UserNodePreset {
  id: string;
  name: string;
  /** Fragment envelope (serializeGraph output) — schema-migrated on load. */
  fragment: SavedProject;
}

const LS_KEY = "toolbox:node-presets";
export const MAX_NODE_PRESETS = 60;
const MAX_NAME = 40;
// Media params inline as data-URLs, so a preset of an Image Source
// carries its bitmap. Cap the serialized size per preset: one oversized
// save would bloat the user_preferences row for every future load.
export const MAX_NODE_PRESET_JSON = 4 * 1024 * 1024;

// --- Module store ----------------------------------------------------------

const EMPTY: UserNodePreset[] = [];
let presets: UserNodePreset[] = EMPTY;
const listeners = new Set<() => void>();

function publish(next: UserNodePreset[]) {
  presets = next;
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getUserNodePresets(): UserNodePreset[] {
  return presets;
}

export function getUserNodePreset(id: string): UserNodePreset | undefined {
  return presets.find((p) => p.id === id);
}

/** Live preset list — re-renders subscribers on save/delete/load. */
export function useUserNodePresets(): UserNodePreset[] {
  return useSyncExternalStore(
    subscribe,
    () => presets,
    () => EMPTY
  );
}

// --- Persistence -----------------------------------------------------------

export function mintNodePresetId(): string {
  return `nodepreset-${Math.random().toString(36).slice(2, 10)}`;
}

// Validate untrusted JSON (localStorage or cloud) into well-formed rows.
// Structural only — the fragment's contents are validated by
// deserializeGraph at insert time (a failure there toasts and inserts
// nothing), so a stale-schema fragment isn't dropped here where the
// migration path could still have loaded it.
function sanitize(raw: unknown): UserNodePreset[] {
  if (!Array.isArray(raw)) return [];
  const out: UserNodePreset[] = [];
  for (const item of raw) {
    if (out.length >= MAX_NODE_PRESETS) break;
    if (!item || typeof item !== "object") continue;
    const p = item as { id?: unknown; name?: unknown; fragment?: unknown };
    if (typeof p.name !== "string" || !p.name.trim()) continue;
    const frag = p.fragment;
    if (!frag || typeof frag !== "object") continue;
    if (!Array.isArray((frag as { nodes?: unknown }).nodes)) continue;
    out.push({
      id: typeof p.id === "string" && p.id ? p.id : mintNodePresetId(),
      name: p.name.trim().slice(0, MAX_NAME),
      fragment: frag as SavedProject,
    });
  }
  return out;
}

export function loadLocalNodePresets(): UserNodePreset[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveLocalNodePresets(list: UserNodePreset[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // Quota / privacy-mode failures are non-fatal — cloud may still work.
  }
}

/**
 * Cloud copy if reachable (also refreshed into localStorage), local
 * otherwise. Publishes into the store — call on mount and whenever the
 * signed-in identity changes.
 */
export async function loadUserNodePresets(): Promise<UserNodePreset[]> {
  const cloud = await loadCloudNodePresets();
  const list = cloud !== null ? sanitize(cloud) : loadLocalNodePresets();
  if (cloud !== null) saveLocalNodePresets(list);
  publish(list);
  return list;
}

function persist(list: UserNodePreset[]) {
  publish(list);
  saveLocalNodePresets(list);
  // Best-effort — signed-out / offline / missing column all no-op.
  void saveCloudNodePresets(list);
}

/**
 * Append (or replace by name — case-insensitive, so saving "Glow" twice
 * overwrites rather than piling up) a preset holding `fragment`.
 * Publishes and persists.
 */
export function upsertUserNodePreset(name: string, fragment: SavedProject) {
  const trimmed = name.trim().slice(0, MAX_NAME);
  const at = presets.findIndex(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (at >= 0) {
    const next = presets.slice();
    next[at] = { ...next[at], name: trimmed, fragment };
    persist(next);
    return;
  }
  persist(
    [...presets, { id: mintNodePresetId(), name: trimmed, fragment }].slice(
      0,
      MAX_NODE_PRESETS
    )
  );
}

/** Delete by id. Publishes and persists. */
export function removeUserNodePreset(id: string) {
  const next = presets.filter((p) => p.id !== id);
  if (next.length !== presets.length) persist(next);
}

// Test seam (check-node-presets.mts): run sanitize without touching the
// store or any storage backend.
export function sanitizeNodePresets(raw: unknown): UserNodePreset[] {
  return sanitize(raw);
}
