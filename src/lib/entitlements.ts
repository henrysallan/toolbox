// Client-side entitlements read (spec 081626 §7.2). Advisory UI state
// ONLY — it decides whether upload affordances render; the server
// re-checks entitlement + quota on every presign. Any failure (row
// absent, table missing pre-migration, offline) resolves to NONE, i.e.
// today's default behavior — the rollout-safe shape the images tier
// established.
//
// Module-level cache keyed by user id: several param controls will call
// useEntitlements() (M1), and the row changes rarely (subscription
// events), so one fetch per session per user is right. Sign-out clears it
// via the user-id key change.

"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/auth-context";

export interface Entitlements {
  cloudMedia: boolean;
  storageQuotaBytes: number | null; // null = unlimited (or not entitled)
  plan: string;
}

const NONE: Entitlements = {
  cloudMedia: false,
  storageQuotaBytes: null,
  plan: "free",
};

let cachedUserId: string | null = null;
let cached: Promise<Entitlements> | null = null;

async function fetchEntitlements(userId: string): Promise<Entitlements> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("user_entitlements")
      .select("cloud_media, storage_quota_bytes, plan")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return NONE;
    return {
      cloudMedia: !!data.cloud_media,
      storageQuotaBytes:
        typeof data.storage_quota_bytes === "number"
          ? data.storage_quota_bytes
          : null,
      plan: typeof data.plan === "string" ? data.plan : "free",
    };
  } catch {
    return NONE;
  }
}

function entitlementsFor(userId: string): Promise<Entitlements> {
  if (cachedUserId !== userId || !cached) {
    cachedUserId = userId;
    cached = fetchEntitlements(userId);
  }
  return cached;
}

export function useEntitlements(): {
  entitlements: Entitlements;
  loading: boolean;
} {
  const { user, loading: authLoading } = useUser();
  // Only the async fetch result lives in state; the signed-out and
  // still-loading cases derive at render time (no sync setState in the
  // effect — the lint ratchet rightly rejects that).
  const [fetched, setFetched] = useState<{
    userId: string;
    entitlements: Entitlements;
  } | null>(null);

  useEffect(() => {
    if (!user) return;
    let mounted = true;
    entitlementsFor(user.id).then((entitlements) => {
      if (mounted) setFetched({ userId: user.id, entitlements });
    });
    return () => {
      mounted = false;
    };
  }, [user]);

  if (!user) return { entitlements: NONE, loading: authLoading };
  if (fetched?.userId === user.id)
    return { entitlements: fetched.entitlements, loading: false };
  return { entitlements: NONE, loading: true };
}
