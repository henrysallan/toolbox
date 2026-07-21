// User brush-preset persistence (071926_paint-toolkit.md): localStorage is
// the always-on store (works signed-out/offline and while the Supabase
// column migration is unapplied); the cloud copy in user_preferences.
// brush_presets syncs on top when available. Cloud wins on load (it's the
// cross-device source of truth); every save writes both.

import {
  loadCloudBrushPresets,
  saveCloudBrushPresets,
} from "@/lib/supabase/user-preferences";
import { resolveBrush, type BrushPreset } from "./brushes";

const LS_KEY = "toolbox:brush-presets";

// Validate untrusted JSON (localStorage or cloud) into well-formed presets.
function sanitize(raw: unknown): BrushPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: BrushPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Partial<BrushPreset>;
    if (typeof p.name !== "string" || !p.name.trim()) continue;
    out.push({
      id:
        typeof p.id === "string" && p.id
          ? p.id
          : `preset-${Math.random().toString(36).slice(2, 10)}`,
      name: p.name.slice(0, 40),
      size:
        typeof p.size === "number" && Number.isFinite(p.size)
          ? Math.max(1, Math.min(400, p.size))
          : 12,
      brush: resolveBrush(p.brush),
    });
  }
  return out;
}

export function loadLocalPresets(): BrushPreset[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveLocalPresets(list: BrushPreset[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // Quota/privacy-mode failures are non-fatal — cloud may still work.
  }
}

// Cloud copy if reachable (also refreshed into localStorage as the offline
// cache), local otherwise.
export async function loadUserPresets(): Promise<BrushPreset[]> {
  const cloud = await loadCloudBrushPresets();
  if (cloud !== null) {
    const list = sanitize(cloud);
    saveLocalPresets(list);
    return list;
  }
  return loadLocalPresets();
}

export async function saveUserPresets(list: BrushPreset[]): Promise<void> {
  saveLocalPresets(list);
  // Best-effort — signed-out / offline / missing column all no-op.
  await saveCloudBrushPresets(list);
}
