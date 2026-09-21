// Progress budgets for the cloud save / load pills. Pure: maps the
// stage events emitted by lib/supabase/projects (and the serialize /
// deserialize fractions from lib/project) to a { label, progress } the
// menu-bar chip renders. Leaf module so the gate script can import it
// without pulling the editor in.
//
// Why a budget at all: supabase-js uploads and PostgREST writes are
// fetch-based with no byte-level progress, so the finest signal is stage
// starts plus per-asset completion. The shares below are rough wall-time
// proportions for a typical media-bearing save — serialize is in-memory
// and fast, the asset uploads dominate a first save, and the row write
// is one indivisible request. A media-free re-save skips the hash /
// upload ranges (they collapse to their end points) and spends its
// visible time at "writing project", which is the honest picture.

import type {
  ProjectLoadProgress,
  ProjectSaveProgress,
} from "@/lib/supabase/projects";

export interface ProgressReading {
  label: string;
  progress: number;
}

// --- Save --------------------------------------------------------------
// serialize     0.00 → 0.20
// auth          0.20
// hash          0.22 → 0.32   (per node carrying inline media)
// list          0.32
// upload        0.35 → 0.85   (per asset not already in Storage)
// thumbnail     0.86
// row           0.90
// done          1.00
export const SAVE_SERIALIZE_END = 0.2;
const SAVE_HASH_START = 0.22;
const SAVE_HASH_END = 0.32;
const SAVE_LIST = 0.32;
const SAVE_UPLOAD_START = 0.35;
const SAVE_UPLOAD_END = 0.85;
const SAVE_THUMBNAIL = 0.86;
const SAVE_ROW = 0.9;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function counted(done: number, total: number): number {
  return total > 0 ? done / total : 1;
}

export function saveSerializeReading(fraction: number): ProgressReading {
  return { label: "saving", progress: lerp(0, SAVE_SERIALIZE_END, fraction) };
}

export function saveStageReading(e: ProjectSaveProgress): ProgressReading {
  switch (e.stage) {
    case "auth":
      return { label: "saving", progress: SAVE_SERIALIZE_END };
    case "hash":
      return {
        label:
          e.total > 0 ? `hashing media ${Math.min(e.done + 1, e.total)}/${e.total}` : "saving",
        progress: lerp(SAVE_HASH_START, SAVE_HASH_END, counted(e.done, e.total)),
      };
    case "list":
      return { label: "checking storage", progress: SAVE_LIST };
    case "upload":
      return {
        label:
          e.total > 0
            ? e.done < e.total
              ? `uploading media ${e.done + 1}/${e.total}`
              : `uploaded ${e.total} ${e.total === 1 ? "asset" : "assets"}`
            : "saving",
        progress: lerp(SAVE_UPLOAD_START, SAVE_UPLOAD_END, counted(e.done, e.total)),
      };
    case "thumbnail":
      return { label: "uploading thumbnail", progress: SAVE_THUMBNAIL };
    case "row":
      return { label: "writing project", progress: SAVE_ROW };
  }
}

// --- Load --------------------------------------------------------------
// start         0.05
// row           0.08          (graph row fetch — the bulk of the wait)
// meta          0.45          (row landed; author / collaborator lookups)
// deserialize   0.55 → 1.00
// A cached row emits no stage events, so the bar goes start → deserialize.
export const LOAD_START = 0.05;
const LOAD_ROW = 0.08;
const LOAD_META = 0.45;
export const LOAD_DESERIALIZE_START = 0.55;

export function loadStageReading(e: ProjectLoadProgress): ProgressReading {
  switch (e.stage) {
    case "row":
      return { label: "fetching project", progress: LOAD_ROW };
    case "meta":
      return { label: "fetching details", progress: LOAD_META };
  }
}

export function loadDeserializeReading(fraction: number): ProgressReading {
  return {
    label: "loading",
    progress: lerp(LOAD_DESERIALIZE_START, 1, fraction),
  };
}
