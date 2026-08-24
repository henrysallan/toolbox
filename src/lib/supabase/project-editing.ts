import { createClient } from "@/lib/supabase/client";

// Shared projects M3 — the advisory editing lease
// (specdocs/081426_shared-projects.md). The lease is a COURTESY signal:
// it prevents most save conflicts before an hour of work is invested,
// but correctness always lives in the save path's updated_at CAS, so
// every call here is allowed to fail soft. Pre-migration DBs (42883:
// function doesn't exist) degrade to "no lease system" — callers treat
// null as silently-acquired and the app behaves exactly as before M3.

// Keep in sync with the `interval '8 minutes'` inlined in
// acquire_project_lease (specdocs/shared-lease-migration.sql).
export const LEASE_EXPIRY_MS = 8 * 60_000;
// Must stay comfortably under LEASE_EXPIRY_MS: a healthy active editor
// renews ~4× per expiry window, so one dropped beat never lapses it.
export const LEASE_HEARTBEAT_MS = 2 * 60_000;

export interface LeaseAcquireResult {
  acquired: boolean;
  holderId: string | null;
  holderName: string | null;
  holderRenewedAt: string | null;
}

// Null = the lease system is unavailable (pre-migration, offline, RPC
// error) — the caller proceeds as if acquired, because advisory
// machinery must never block an open.
export async function acquireProjectLease(
  projectId: string,
  steal = false
): Promise<LeaseAcquireResult | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("acquire_project_lease", {
    pid: projectId,
    steal,
  });
  if (error) {
    if (error.code !== "42883") {
      console.warn("acquireProjectLease failed:", error);
    }
    return null;
  }
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (!row) return null;
  return {
    acquired: !!row.acquired,
    holderId: (row.holder_id as string | null) ?? null,
    holderName: (row.holder_name as string | null) ?? null,
    holderRenewedAt: (row.holder_renewed_at as string | null) ?? null,
  };
}

// Heartbeat. true = still holding; false = lapsed or taken over; null =
// degraded (offline / pre-migration) — callers keep believing they hold
// it rather than false-alarming on a flaky network.
export async function renewProjectLease(
  projectId: string
): Promise<boolean | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("renew_project_lease", {
    pid: projectId,
  });
  if (error) {
    if (error.code !== "42883") {
      console.warn("renewProjectLease failed:", error);
    }
    return null;
  }
  return !!data;
}

export async function releaseProjectLease(projectId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("release_project_lease", {
    pid: projectId,
  });
  if (error && error.code !== "42883") {
    console.warn("releaseProjectLease failed:", error);
  }
}

// The supabase-js client can't be trusted inside `pagehide` — the tab
// is being torn down and a normal fetch gets cancelled. `keepalive`
// lets the browser finish the request after the page is gone. Auth
// rides an access token cached by the calls above (getSession is async,
// which is exactly what a pagehide handler can't wait for). Expiry is
// the backstop when this never lands.
let cachedAccessToken: string | null = null;

export async function cacheLeaseAuthToken(): Promise<void> {
  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    cachedAccessToken = data.session?.access_token ?? null;
  } catch {
    // Keep whatever we had — a stale token beats none at pagehide.
  }
}

export function releaseProjectLeaseKeepalive(projectId: string): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon || !cachedAccessToken) return;
  try {
    void fetch(`${url}/rest/v1/rpc/release_project_lease`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${cachedAccessToken}`,
      },
      body: JSON.stringify({ pid: projectId }),
    });
  } catch {
    // Best-effort by definition.
  }
}

export interface ActiveLease {
  projectId: string;
  userId: string;
  displayName: string | null;
}

// Live leases for the load grid's "● editing" badges. One select over
// the listed ids (RLS: members only see leases on their projects) plus
// a profiles batch for names. Fetched alongside the listing — refresh
// rides the existing refresh button, never a poll. Degrades to empty
// pre-migration (42P01).
export async function listActiveLeases(
  projectIds: string[]
): Promise<Map<string, ActiveLease>> {
  const out = new Map<string, ActiveLease>();
  if (projectIds.length === 0) return out;
  const supabase = createClient();
  const cutoff = new Date(Date.now() - LEASE_EXPIRY_MS).toISOString();
  const { data, error } = await supabase
    .from("project_editing")
    .select("project_id, user_id, renewed_at")
    .in("project_id", projectIds)
    .gt("renewed_at", cutoff);
  if (error) {
    if (error.code !== "42P01") {
      console.warn("listActiveLeases failed:", error);
    }
    return out;
  }
  const rows = data ?? [];
  if (rows.length === 0) return out;
  const uids = Array.from(new Set(rows.map((r) => r.user_id as string)));
  const { data: profs } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", uids);
  const nameById = new Map<string, string | null>();
  for (const p of profs ?? []) {
    nameById.set(p.id as string, (p.display_name as string | null) ?? null);
  }
  for (const r of rows) {
    out.set(r.project_id as string, {
      projectId: r.project_id as string,
      userId: r.user_id as string,
      displayName: nameById.get(r.user_id as string) ?? null,
    });
  }
  return out;
}
