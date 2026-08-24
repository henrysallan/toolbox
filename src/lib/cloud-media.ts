// Cloud media (R2) shared vocabulary — client-safe: constants, the
// envelope ref shape, URL building, and the ext/mime tables both the
// upload client (M1) and the API routes agree on. Server-only pieces
// (signing, service-role access) live in cloud-media-server.ts.
//
// Objects live at <user_id>/<sha256>.<ext> in one flat per-user,
// content-addressed namespace, served public-read from MEDIA_PUBLIC_BASE
// (unguessable-path privacy — the same recorded trade-off as the
// project-assets bucket). Media envelopes carry the ref NESTED under a
// `cloud` key, never as top-level `asset`/`ext` — isAssetRef() matches any
// object with a string `asset`, and the Supabase images tier walks every
// param; a top-level field would get keep-set-polluted and have a bogus
// Storage dataUrl grafted on (spec §7.1).
//
// Spec: specdocs/081626_r2-media-storage.md

export const MEDIA_PUBLIC_BASE = "https://media.isthishenry.com";

// Single presigned PUT in v1; multipart upload is milestone M3.
export const MAX_CLOUD_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export type CloudMediaKind = "video" | "audio" | "model";

export const CLOUD_MEDIA_KINDS: readonly CloudMediaKind[] = [
  "video",
  "audio",
  "model",
];

// The ref a media envelope carries under its `cloud` key. `owner` is the
// UPLOADER's user id (uploads land under the uploader's prefix and count
// against the uploader's quota — unlike Supabase collaborator writes,
// which land under the project owner's prefix), so a URL resolves without
// knowing the project owner.
export interface CloudMediaRef {
  hash: string;
  ext: string;
  owner: string;
}

export function isCloudMediaRef(v: unknown): v is CloudMediaRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.hash === "string" &&
    typeof r.ext === "string" &&
    typeof r.owner === "string"
  );
}

export function cloudMediaKey(owner: string, hash: string, ext: string): string {
  return `${owner}/${hash}.${ext}`;
}

export function cloudMediaUrl(ref: CloudMediaRef): string {
  return `${MEDIA_PUBLIC_BASE}/${cloudMediaKey(ref.owner, ref.hash, ref.ext)}`;
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

// Extension allowlist per kind — mirrors the picker accepts
// (media-relink.ts PICKER_TYPES; ModelFileControl). The server derives
// BOTH ext and mime from the filename against these tables and signs the
// Content-Type into the presigned PUT: the client never chooses a mime,
// so an entitled account can't store text/html on the public media
// domain (a hosted-phishing-page hazard, since the bucket is public-read).
export const CLOUD_MEDIA_EXTS: Record<CloudMediaKind, readonly string[]> = {
  video: ["mp4", "webm", "mov", "m4v", "mkv", "avi"],
  audio: ["mp3", "wav", "ogg", "flac", "m4a", "aac"],
  model: ["glb", "gltf", "obj", "stl"],
};

const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  stl: "application/octet-stream",
};

// Resolve a filename to its { ext, mime } for a kind, or null when the
// extension isn't in the kind's allowlist (caller returns 415).
export function cloudMediaType(
  filename: string,
  kind: CloudMediaKind
): { ext: string; mime: string } | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  if (!CLOUD_MEDIA_EXTS[kind].includes(ext)) return null;
  const mime = EXT_TO_MIME[ext];
  return mime ? { ext, mime } : null;
}
