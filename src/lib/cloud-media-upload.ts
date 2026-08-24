// Cloud media upload manager + ref registry (spec 081626 §7.3).
//
// The registry is the ONLY session store of cloud refs: serializeParams
// looks refs up here at save time, deserializeParams seeds them here at
// load time. Keyed `${filename}|${size}` — the media-relink handle-key
// convention (same clip in three nodes/projects = one entry; name+size
// collisions are the same vanishingly-rare risk already accepted there).
// Deliberately out-of-band from param values so engine/types stays
// untouched (the engine is self-contained and can't import lib/) and
// undo/redo never interacts with upload state.
//
// Upload lifecycle: callers register the file for local playback FIRST
// (unchanged, instant), then fire-and-forget maybeUploadCloudMedia().
// hash (streaming, hash-wasm) → POST /api/media/presign → PUT (XHR, for
// progress) → POST /api/media/commit → seed the registry. Any failure
// leaves the file local-only (relinkable) and marks the state "error" —
// the rollout rule: cloud trouble must never break the pick or the save.
//
// Upload is gated by a module-level flag EffectsApp sets from
// useEntitlements() — NOT read here via Supabase, because this module is
// (transitively) part of the export bundle through param-controls, which
// must stay free of heavy editor deps. In the live viewer / exported apps
// the flag is simply never set, so uploads are structurally impossible
// there. Also a no-op on desktop: the Electron-embedded server has no R2
// secrets by design (bearer-auth against the hosted deployment is M3).

import { useSyncExternalStore } from "react";
import {
  cloudMediaType,
  MAX_CLOUD_UPLOAD_BYTES,
  type CloudMediaKind,
  type CloudMediaRef,
} from "@/lib/cloud-media";
import { platform } from "@/lib/platform";

function mediaKey(filename: string, size?: number): string {
  return `${filename}|${size ?? "?"}`;
}

// --- gate -------------------------------------------------------------------

let cloudMediaEnabled = false;

// Called by EffectsApp when the entitlement loads (and on change). Editor
// only — nothing in the live viewer / exported apps ever sets it.
export function setCloudMediaEnabled(enabled: boolean): void {
  cloudMediaEnabled = enabled;
}

// --- ref registry -----------------------------------------------------------

const refs = new Map<string, CloudMediaRef>();

export function getCloudMediaRef(
  filename: string | undefined,
  size?: number
): CloudMediaRef | null {
  if (!filename) return null;
  return refs.get(mediaKey(filename, size)) ?? null;
}

export function seedCloudMediaRef(
  filename: string,
  size: number | undefined,
  ref: CloudMediaRef
): void {
  refs.set(mediaKey(filename, size), ref);
}

// --- upload state (for the param-panel pills) -------------------------------

export interface CloudUploadState {
  phase: "hashing" | "uploading" | "error";
  // 0..100, meaningful in "uploading".
  pct: number;
}

const states = new Map<string, CloudUploadState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function setState(key: string, state: CloudUploadState | null) {
  if (state) states.set(key, state);
  else states.delete(key);
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCloudUploadState(
  filename: string | undefined,
  size?: number
): CloudUploadState | null {
  if (!filename) return null;
  return states.get(mediaKey(filename, size)) ?? null;
}

// Live upload state for a pill; re-renders on any store change (uploads
// are rare enough that per-key granularity isn't worth it).
export function useCloudUploadState(
  filename: string | undefined,
  size?: number
): CloudUploadState | null {
  return useSyncExternalStore(
    subscribe,
    () => getCloudUploadState(filename, size),
    () => null
  );
}

// --- hashing ----------------------------------------------------------------

// Streaming sha256: crypto.subtle.digest needs the whole buffer resident,
// a non-starter at 2 GB. hash-wasm streams chunks at WASM speed with flat
// memory. Dynamic import keeps it out of the main bundle.
async function sha256File(file: File): Promise<string> {
  const { createSHA256 } = await import("hash-wasm");
  const hasher = await createSHA256();
  hasher.init();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

// --- upload -----------------------------------------------------------------

function putWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onPct: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("upload failed (network)"));
    xhr.send(file);
  });
}

async function postJson(
  path: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// Fire-and-forget cloud upload for a just-picked/just-relinked file.
// Gated on setCloudMediaEnabled (never blocks on an entitlement fetch).
// Errors surface as pill state + console.warn; the returned promise
// never rejects.
export function maybeUploadCloudMedia(
  file: File,
  kind: CloudMediaKind
): Promise<void> {
  if (!cloudMediaEnabled) return Promise.resolve();
  if (platform.isNative) return Promise.resolve(); // desktop upload = M3
  if (file.size > MAX_CLOUD_UPLOAD_BYTES) return Promise.resolve();
  if (!cloudMediaType(file.name, kind)) return Promise.resolve();
  const key = mediaKey(file.name, file.size);
  if (refs.has(key)) return Promise.resolve();
  const existing = inflight.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      setState(key, { phase: "hashing", pct: 0 });
      const hash = await sha256File(file);

      const presign = await postJson("/api/media/presign", {
        hash,
        size: file.size,
        filename: file.name,
        kind,
      });
      // The object key is `<owner>/<hash>.<ext>` — the ref's owner (the
      // uploader, spec §5.3) parses straight out of it, so no Supabase
      // client is needed here (see the export-bundle note up top).
      const seedFromKey = (objectKey: unknown) => {
        if (typeof objectKey !== "string") return;
        const owner = objectKey.split("/")[0];
        const ext = objectKey.slice(objectKey.lastIndexOf(".") + 1);
        if (owner && ext)
          seedCloudMediaRef(file.name, file.size, { hash, ext, owner });
      };
      if (presign.json.already === true) {
        seedFromKey(presign.json.key);
        setState(key, null);
        return;
      }
      if (presign.status !== 200 || typeof presign.json.uploadUrl !== "string")
        throw new Error(
          typeof presign.json.error === "string"
            ? presign.json.error
            : `presign failed (${presign.status})`
        );

      setState(key, { phase: "uploading", pct: 0 });
      await putWithProgress(
        presign.json.uploadUrl,
        (presign.json.headers as Record<string, string>) ?? {},
        file,
        (pct) => setState(key, { phase: "uploading", pct })
      );

      const commit = await postJson("/api/media/commit", { hash });
      if (commit.status !== 200)
        throw new Error(
          typeof commit.json.error === "string"
            ? commit.json.error
            : `commit failed (${commit.status})`
        );
      seedFromKey(presign.json.key);
      setState(key, null);
    } catch (err) {
      console.warn(`[cloud-media] upload failed for ${file.name}:`, err);
      setState(key, { phase: "error", pct: 0 });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}
