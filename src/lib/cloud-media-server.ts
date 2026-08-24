// Server-only half of cloud media (R2): request auth + entitlement
// resolution (modeled on lib/ai/anthropic-key.ts), the service-role
// Supabase client for ledger writes, and the aws4fetch signing
// primitives against the R2 S3 endpoint. Imported ONLY by the
// /api/media/* route handlers.
//
// Secrets read here (R2_*, SUPABASE_SERVICE_ROLE_KEY) exist on Vercel
// only — the Electron-embedded server strips them by design
// (electron/server.js allowlist), so these routes are intentionally dead
// on desktop; desktop uploads will call the hosted deployment (M3).
//
// Spec: specdocs/081626_r2-media-storage.md §6

import { AwsClient } from "aws4fetch";
import {
  createClient as createBareClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { createClient as createServerSupabase } from "@/lib/supabase/server";

export interface MediaEntitlement {
  cloudMedia: boolean;
  quotaBytes: number | null; // null = unlimited
}

export type MediaAuth =
  | { ok: true; user: User; entitlement: MediaEntitlement }
  | { ok: false; status: number; error: string };

// Cookie-session auth + entitlement read. The entitlement row is read
// with the USER's client (select-own RLS covers it); the service role is
// only needed for ledger writes. Any read failure — row absent, table
// missing pre-migration, Supabase unreachable — resolves to "not
// entitled", never to an error page: un-entitled users simply keep the
// default (relink) behavior.
export async function resolveMediaAuth(): Promise<MediaAuth> {
  let user: User | null = null;
  let entitlement: MediaEntitlement | null = null;
  try {
    const supabase = await createServerSupabase();
    ({
      data: { user },
    } = await supabase.auth.getUser());
    if (user) {
      const { data } = await supabase
        .from("user_entitlements")
        .select("cloud_media, storage_quota_bytes")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data?.cloud_media) {
        const quota = data.storage_quota_bytes;
        entitlement = {
          cloudMedia: true,
          quotaBytes: typeof quota === "number" ? quota : null,
        };
      }
    }
  } catch {
    // Treated as unauthenticated / un-entitled below.
  }
  if (!user)
    return { ok: false, status: 401, error: "Sign in to use cloud media." };
  if (!entitlement)
    return {
      ok: false,
      status: 403,
      error: "Cloud media storage isn't enabled for this account.",
    };
  return { ok: true, user, entitlement };
}

// Service-role client for media_assets writes (the table has no client
// write policies — see r2-media-migration.sql header). Null when the env
// isn't configured; routes surface that as a 503, not a crash.
export function createServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- R2 (S3-compatible) ----------------------------------------------------

interface R2Config {
  accountId: string;
  bucket: string;
  client: AwsClient;
}

export function getR2(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    bucket,
    client: new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto",
    }),
  };
}

function objectEndpoint(r2: R2Config, key: string): string {
  return `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key}`;
}

export const PRESIGN_EXPIRES_SECONDS = 3600;

// Presigned PUT with the Content-Type signed in: the uploader must send
// exactly the server-derived mime, so a client can never store a
// browser-renderable type (text/html) on the public media domain.
export async function presignPut(
  r2: R2Config,
  key: string,
  mime: string
): Promise<string> {
  const url = new URL(objectEndpoint(r2, key));
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_EXPIRES_SECONDS));
  const signed = await r2.client.sign(
    new Request(url, { method: "PUT", headers: { "Content-Type": mime } }),
    { aws: { signQuery: true } }
  );
  return signed.url;
}

export async function headObject(
  r2: R2Config,
  key: string
): Promise<{ exists: boolean; size: number }> {
  const res = await r2.client.fetch(objectEndpoint(r2, key), {
    method: "HEAD",
  });
  if (res.status === 404) return { exists: false, size: 0 };
  if (!res.ok) throw new Error(`R2 HEAD failed: ${res.status}`);
  return {
    exists: true,
    size: Number(res.headers.get("content-length") ?? 0),
  };
}

export async function deleteObject(r2: R2Config, key: string): Promise<void> {
  const res = await r2.client.fetch(objectEndpoint(r2, key), {
    method: "DELETE",
  });
  // 404 = already gone; both fine for our callers (best-effort cleanup).
  if (!res.ok && res.status !== 404)
    throw new Error(`R2 DELETE failed: ${res.status}`);
}
