import { createClient } from "@/lib/supabase/client";

// Storage + DB helpers for the Image Generate node. Schema +
// bucket layout matches specdocs/image-gen-migration.sql.

const PRIVATE_BUCKET = "image-gen-private";
const PUBLIC_BUCKET = "image-gen-public";

export type ImageGenStatus = "pending" | "done" | "error";

export interface ImageGenImage {
  // Storage path inside PRIVATE_BUCKET. Reconstructable URL via
  // privateImageUrl(path) for in-browser display.
  path: string;
  width?: number;
  height?: number;
  format: string;
  revisedPrompt?: string;
}

export interface ImageGenMessage {
  id: string;
  prompt: string;
  status: ImageGenStatus;
  createdAt: number;
  // Storage paths (within PRIVATE_BUCKET) of every image generated
  // for this prompt. Length 0 while pending or on error.
  images: ImageGenImage[];
  error?: string;
  refImageHashes?: string[];
}

export interface ImageGenSession {
  id: string;
  userId: string;
  projectId: string;
  nodeId: string;
  lastResponseId: string | null;
  messages: ImageGenMessage[];
}

// ------------------------------------------------------------
// session row CRUD
// ------------------------------------------------------------

// Discriminated load result so callers can tell apart "no row yet"
// from "couldn't query the row". Critical for the panel's send
// path: a failed read followed by an upsert with empty messages
// would silently destroy the user's chat history. The panel reads
// `kind === "ok"` and uses `session ?? null` for "row missing";
// `kind === "error"` blocks send.
export type LoadSessionResult =
  | { kind: "ok"; session: ImageGenSession | null }
  | { kind: "error"; error: string };

export async function loadSession(
  projectId: string,
  nodeId: string
): Promise<LoadSessionResult> {
  const supa = createClient();
  const { data: u, error: authError } = await supa.auth.getUser();
  if (authError) return { kind: "error", error: authError.message };
  const uid = u.user?.id;
  if (!uid) return { kind: "ok", session: null };
  const { data, error } = await supa
    .from("image_gen_sessions")
    .select("id, user_id, project_id, node_id, last_response_id, messages")
    .eq("user_id", uid)
    .eq("project_id", projectId)
    .eq("node_id", nodeId)
    .maybeSingle();
  if (error) {
    console.warn("loadSession:", error.message);
    return { kind: "error", error: error.message };
  }
  if (!data) return { kind: "ok", session: null };
  return {
    kind: "ok",
    session: {
      id: data.id as string,
      userId: data.user_id as string,
      projectId: data.project_id as string,
      nodeId: data.node_id as string,
      lastResponseId: (data.last_response_id as string | null) ?? null,
      messages: (data.messages as ImageGenMessage[]) ?? [],
    },
  };
}

// Upsert the session. Creates it if missing (first message in a
// new node), otherwise replaces messages + last_response_id.
export async function upsertSession(args: {
  projectId: string;
  nodeId: string;
  messages: ImageGenMessage[];
  lastResponseId: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const supa = createClient();
  const { data: u } = await supa.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return { ok: false, error: "Not signed in." };
  const { error } = await supa.from("image_gen_sessions").upsert(
    {
      user_id: uid,
      project_id: args.projectId,
      node_id: args.nodeId,
      messages: args.messages,
      last_response_id: args.lastResponseId,
    },
    { onConflict: "user_id,project_id,node_id" }
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ------------------------------------------------------------
// storage helpers
// ------------------------------------------------------------

export async function uploadPrivateImage(args: {
  projectId: string;
  nodeId: string;
  imageId: string;
  ext: string;
  mime: string;
  blob: Blob;
}): Promise<{ path: string } | { error: string }> {
  const supa = createClient();
  const { data: u } = await supa.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return { error: "Not signed in." };
  const path = `${uid}/${args.projectId}/${args.nodeId}/${args.imageId}.${args.ext}`;
  const { error } = await supa.storage
    .from(PRIVATE_BUCKET)
    .upload(path, args.blob, {
      contentType: args.mime,
      upsert: true,
    });
  if (error) return { error: error.message };
  return { path };
}

// A signed URL for a private object — used to display thumbnails in
// the panel. Cheap (no DB write) and short-lived; we re-fetch as
// the panel re-renders if needed.
export async function privateImageUrl(
  path: string,
  ttlSeconds = 3600
): Promise<string | null> {
  const supa = createClient();
  const { data, error } = await supa.storage
    .from(PRIVATE_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error || !data) {
    console.warn("privateImageUrl:", error?.message);
    return null;
  }
  return data.signedUrl;
}

// Copy a private image into the public bucket so anyone can read
// the saved project's selected output. Returns the public URL on
// success.
export async function publishSelected(args: {
  projectId: string;
  nodeId: string;
  imageId: string;
  ext: string;
  mime: string;
  blob: Blob;
}): Promise<{ url: string; path: string } | { error: string }> {
  const supa = createClient();
  const path = `${args.projectId}/${args.nodeId}/${args.imageId}.${args.ext}`;
  const { error } = await supa.storage
    .from(PUBLIC_BUCKET)
    .upload(path, args.blob, {
      contentType: args.mime,
      upsert: true,
    });
  if (error) return { error: error.message };
  const { data } = supa.storage.from(PUBLIC_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path };
}

// Read a private object back as a blob (e.g. on selection change so
// we can re-publish it). Uses a signed URL under the hood — same
// path as the panel's thumbnail rendering, but synchronously
// awaited and re-fetched as binary.
export async function downloadPrivate(
  path: string
): Promise<Blob | null> {
  const supa = createClient();
  const { data, error } = await supa.storage
    .from(PRIVATE_BUCKET)
    .download(path);
  if (error || !data) {
    console.warn("downloadPrivate:", error?.message);
    return null;
  }
  return data;
}

// Generate a stable id for a new generation. Using crypto.randomUUID
// is plenty unique and avoids a server roundtrip; we don't need
// monotonic ordering since `createdAt` covers that.
export function newGenerationId(): string {
  return crypto.randomUUID();
}
