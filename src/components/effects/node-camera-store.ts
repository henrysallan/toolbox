// Node-editor camera memory: the last pan/zoom per graph scope, so diving
// into a group/layer, climbing back out, or switching comps returns you to
// where you were looking — and a scope you've never visited frames all its
// nodes instead (NodeEditor owns that fallback).
//
// Keyed by project + composition + scope (group/layer id, or root). Cloud
// projects persist to localStorage so the memory survives reloads; unsaved
// projects (no id) stay in-memory only — their comp/layer ids are fresh per
// project but "root of an unsaved project" isn't, and restoring another
// project's camera there would be worse than a fit.
//
// Per-machine, never synced. SSR-safe: localStorage is only touched inside
// functions.

export interface NodeCamera {
  x: number;
  y: number;
  zoom: number;
}

const LS_KEY = "toolbox.nodeCameras";
// Scope ids retire as groups are deleted and projects age out; cap the list
// so it can't grow without bound. Oldest-written entries drop first.
const MAX_STORED = 300;

const memory = new Map<string, NodeCamera>();
let loaded = false;

function isCamera(v: unknown): v is NodeCamera {
  if (!v || typeof v !== "object") return false;
  const c = v as NodeCamera;
  return (
    Number.isFinite(c.x) &&
    Number.isFinite(c.y) &&
    Number.isFinite(c.zoom) &&
    c.zoom > 0
  );
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return;
    for (const e of v) {
      if (Array.isArray(e) && typeof e[0] === "string" && isCamera(e[1])) {
        memory.set(e[0], e[1]);
      }
    }
  } catch {
    // Private mode / disabled storage / corrupt JSON — behave as empty.
  }
}

function persist() {
  try {
    // Map iteration is insertion order and set() re-inserts on write, so the
    // tail is the most recently written.
    const entries = [...memory].filter(([k]) => k.startsWith("p:"));
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify(entries.slice(-MAX_STORED))
    );
  } catch {
    /* best-effort */
  }
}

export function nodeCameraKey(
  projectId: string | null | undefined,
  compositionId: string,
  scopeId: string | null | undefined
): string {
  const scope = scopeId ?? "root";
  return projectId
    ? `p:${projectId}|${compositionId}|${scope}`
    : `u:${compositionId}|${scope}`;
}

export function getNodeCamera(key: string): NodeCamera | undefined {
  load();
  return memory.get(key);
}

export function setNodeCamera(key: string, cam: NodeCamera) {
  if (!isCamera(cam)) return;
  load();
  const prev = memory.get(key);
  if (
    prev &&
    prev.x === cam.x &&
    prev.y === cam.y &&
    prev.zoom === cam.zoom
  ) {
    return;
  }
  memory.delete(key);
  memory.set(key, { x: cam.x, y: cam.y, zoom: cam.zoom });
  if (key.startsWith("p:")) persist();
}
