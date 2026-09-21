"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useUser } from "@/lib/auth-context";
import {
  getOwnHandle,
  getOwnHandleSnapshot,
  subscribeOwnHandle,
} from "@/lib/supabase/profiles";

const NONE = { handle: null, loaded: false } as const;

// The signed-in user's profile handle, kept live across the account menu
// (where it's edited) and Project Settings (where the named live link is
// previewed). `loaded` is false while the first fetch is in flight, and
// both are null / false when signed out.
export function useOwnHandle(): { handle: string | null; loaded: boolean } {
  const { user } = useUser();
  const uid = user?.id ?? null;
  // The profiles module replaces its cache object on every change, so the
  // snapshot is identity-stable between changes (what useSyncExternalStore
  // needs) and the derived view below is a cheap read.
  const snap = useSyncExternalStore(
    subscribeOwnHandle,
    getOwnHandleSnapshot,
    () => null
  );
  // Kick the fetch for the current user; the store notifies on arrival.
  useEffect(() => {
    if (uid) void getOwnHandle(uid);
  }, [uid]);

  if (!uid || !snap || snap.userId !== uid) return NONE;
  return { handle: snap.handle, loaded: snap.loaded };
}
