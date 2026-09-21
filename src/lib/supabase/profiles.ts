import { createClient } from "@/lib/supabase/client";
import { normalizeHandle, type HandleProblem } from "@/lib/vanity-slug";

// Profile handles (specdocs/092126_vanity-live-links.md). A handle is the
// "@hallan" half of a named live link, /@<handle>/<slug>. The migration
// seeds one per profile from the email local part; this module reads the
// signed-in user's handle, lets them change it, and looks up other
// users' handles for the copy-link buttons.
//
// The own-handle value is cached module-wide with a tiny subscription so
// the account menu (where it's edited) and Project Settings (where it's
// previewed) stay in sync without prop-drilling through EffectsApp.
//
// Pre-migration DBs answer 42703 (column missing) — every reader here
// degrades to null so the rest of the editor keeps working; the writer
// surfaces it as a "migration" failure.

const COLUMN_MISSING = "42703";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

interface OwnHandleState {
  userId: string;
  handle: string | null;
  // False until the first fetch resolves; lets the UI show "…" instead of
  // "no handle" while loading.
  loaded: boolean;
}

let own: OwnHandleState | null = null;
let inflight: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeOwnHandle(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// The cache object itself — a stable reference that is REPLACED (never
// mutated) on every change, so useSyncExternalStore can compare by
// identity. Callers check `userId` themselves (see useOwnHandle).
export function getOwnHandleSnapshot(): OwnHandleState | null {
  return own;
}

// Synchronous read of the cache for the given user. `loaded: false` when
// nothing has been fetched for that user yet (or the user changed).
export function peekOwnHandle(userId: string | null): {
  handle: string | null;
  loaded: boolean;
} {
  if (!userId || !own || own.userId !== userId) {
    return { handle: null, loaded: false };
  }
  return { handle: own.handle, loaded: own.loaded };
}

// Fetch (or serve from cache) the signed-in user's handle. Coalesces
// concurrent callers; a sign-out / user switch resets the cache.
export async function getOwnHandle(userId: string): Promise<string | null> {
  if (own && own.userId === userId && own.loaded) return own.handle;
  if (inflight && own && own.userId === userId) return inflight;
  own = { userId, handle: null, loaded: false };
  inflight = (async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("handle")
      .eq("id", userId)
      .maybeSingle();
    if (error && error.code !== COLUMN_MISSING) {
      console.error("getOwnHandle failed:", error);
    }
    const handle = (data?.handle as string | null | undefined) ?? null;
    if (own && own.userId === userId) {
      own = { userId, handle, loaded: true };
      notify();
    }
    return handle;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function clearOwnHandleCache(): void {
  own = null;
  inflight = null;
  notify();
}

export type ClaimHandleResult =
  | { ok: true; handle: string }
  | {
      ok: false;
      reason: "invalid" | "taken" | "migration" | "signed-out" | "error";
      problem?: HandleProblem;
    };

// Change the signed-in user's handle. Validates client-side first (instant
// feedback), then lets the unique index decide "taken". RLS restricts the
// update to the caller's own profile row.
export async function claimHandle(input: string): Promise<ClaimHandleResult> {
  const norm = normalizeHandle(input);
  if (!norm.ok) return { ok: false, reason: "invalid", problem: norm.problem };
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  const uid = userResp.user?.id;
  if (!uid) return { ok: false, reason: "signed-out" };
  const { data, error } = await supabase
    .from("profiles")
    .update({ handle: norm.handle, updated_at: new Date().toISOString() })
    .eq("id", uid)
    .select("handle")
    .maybeSingle();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, reason: "taken" };
    if (error.code === COLUMN_MISSING) return { ok: false, reason: "migration" };
    if (error.code === CHECK_VIOLATION) {
      return { ok: false, reason: "invalid", problem: "invalid-chars" };
    }
    console.error("claimHandle failed:", error);
    return { ok: false, reason: "error" };
  }
  if (!data) {
    // No profile row yet (an account that predates the profiles table
    // and never triggered the backfill). Insert one.
    const { error: insErr } = await supabase
      .from("profiles")
      .insert({ id: uid, handle: norm.handle });
    if (insErr) {
      if (insErr.code === UNIQUE_VIOLATION) return { ok: false, reason: "taken" };
      if (insErr.code === COLUMN_MISSING) return { ok: false, reason: "migration" };
      console.error("claimHandle insert failed:", insErr);
      return { ok: false, reason: "error" };
    }
  }
  own = { userId: uid, handle: norm.handle, loaded: true };
  notify();
  return { ok: true, handle: norm.handle };
}

// Another user's handle (the owner of a project shared with / viewed by
// the current user), for building their named live link. Null when they
// have none or the column doesn't exist yet.
export async function getHandleForUser(
  client: ReturnType<typeof createClient>,
  userId: string
): Promise<string | null> {
  const { data, error } = await client
    .from("profiles")
    .select("handle")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    if (error.code !== COLUMN_MISSING) {
      console.error("getHandleForUser failed:", error);
    }
    return null;
  }
  return (data?.handle as string | null | undefined) ?? null;
}

// handle → profile id, for the /@handle/slug route. Anon-readable via the
// "profiles readable by all" policy.
export async function getProfileIdByHandle(
  client: ReturnType<typeof createClient>,
  handle: string
): Promise<string | null> {
  const { data, error } = await client
    .from("profiles")
    .select("id")
    .eq("handle", handle)
    .maybeSingle();
  if (error) {
    if (error.code !== COLUMN_MISSING) {
      console.error("getProfileIdByHandle failed:", error);
    }
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}
