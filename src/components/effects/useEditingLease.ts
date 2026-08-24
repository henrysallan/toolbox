"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireProjectLease,
  cacheLeaseAuthToken,
  LEASE_HEARTBEAT_MS,
  releaseProjectLease,
  releaseProjectLeaseKeepalive,
  renewProjectLease,
} from "@/lib/supabase/project-editing";

// Lifecycle for the M3 advisory editing lease
// (specdocs/081426_shared-projects.md). Owns acquisition on open, the
// interaction-gated heartbeat, best-effort release, and the two UI
// states (held-by-other dialog, watching/lost banner). EffectsApp calls
// `acquireFor` after loading a collaborative project and renders the
// returned dialog/banner state via EditingLeaseUi.
//
// Design constraints, in order:
//   * Advisory only — nothing here blocks an open or a save; the save
//     CAS is the correctness layer. Every network failure fails soft.
//   * The heartbeat renews ONLY if the user actually interacted since
//     the last beat — an idle tab stops renewing, the lease lapses
//     (LEASE_EXPIRY_MS server-side), and the project reads as free.
//     This is the "who's actually using it vs. who left a tab open"
//     signal, at the cost of a tiny row update, not a graph snapshot.
//   * Self-healing ownership: whenever `currentProjectId` no longer
//     matches the held lease (project switch, New Project, file load,
//     copy-fork after a conflict), the stale lease is released — no
//     per-path plumbing.

export interface LeaseBannerState {
  kind: "watching" | "lost";
  name: string | null;
}

export interface LeaseHeldState {
  projectId: string;
  holderName: string | null;
  renewedAt: string | null;
}

export function useEditingLease({
  enabled,
  currentProjectId,
}: {
  // Signed-in state — flipping false releases any held lease.
  enabled: boolean;
  currentProjectId: string | null;
}) {
  const [banner, setBanner] = useState<LeaseBannerState | null>(null);
  const [heldDialog, setHeldDialog] = useState<LeaseHeldState | null>(null);
  const [busy, setBusy] = useState(false);
  // Project id we currently hold the lease on (null = none).
  const heldRef = useRef<string | null>(null);
  const lastInteractionRef = useRef(0);
  const lastBeatRef = useRef(0);

  const releaseIfHeld = useCallback(() => {
    const pid = heldRef.current;
    if (!pid) return;
    heldRef.current = null;
    void releaseProjectLease(pid);
  }, []);

  // Interaction signal: any pointer/key/wheel activity counts. Capture
  // phase so stopPropagation deep in the editor can't hide activity.
  useEffect(() => {
    const bump = () => {
      lastInteractionRef.current = Date.now();
    };
    window.addEventListener("pointerdown", bump, { capture: true, passive: true });
    window.addEventListener("keydown", bump, { capture: true, passive: true });
    window.addEventListener("wheel", bump, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", bump, { capture: true });
      window.removeEventListener("keydown", bump, { capture: true });
      window.removeEventListener("wheel", bump, { capture: true });
    };
  }, []);

  // Heartbeat. The interval ticks faster than the beat period so a beat
  // lands within ~30s of falling due; the gate does the real pacing.
  useEffect(() => {
    const tick = async () => {
      const pid = heldRef.current;
      if (!pid) return;
      const now = Date.now();
      if (now - lastBeatRef.current < LEASE_HEARTBEAT_MS) return;
      if (lastInteractionRef.current <= lastBeatRef.current) return; // idle
      lastBeatRef.current = now;
      const alive = await renewProjectLease(pid);
      // null = offline/degraded — keep believing rather than false-alarm.
      if (alive === false && heldRef.current === pid) {
        heldRef.current = null;
        // Learn who took it: a non-steal acquire returns the holder —
        // and if it ACQUIRES (they already left), we hold again and
        // there's nothing to announce.
        const res = await acquireProjectLease(pid);
        if (res?.acquired) {
          heldRef.current = pid;
          lastBeatRef.current = Date.now();
        } else {
          setBanner({ kind: "lost", name: res?.holderName ?? null });
        }
      }
    };
    const id = window.setInterval(() => void tick(), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Best-effort release when the page goes away. `keepalive` outlives
  // the tab; the 8-minute expiry is the crash backstop.
  useEffect(() => {
    const onPageHide = () => {
      if (heldRef.current) {
        releaseProjectLeaseKeepalive(heldRef.current);
        heldRef.current = null;
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Self-heal: the held lease must always be for the current project.
  // Covers project switches, New Project, file loads, sign-out, and
  // copy-forks without any per-path calls.
  useEffect(() => {
    if (!enabled || heldRef.current !== currentProjectId) {
      if (heldRef.current && heldRef.current !== currentProjectId) {
        releaseIfHeld();
      } else if (!enabled) {
        releaseIfHeld();
      }
      setBanner(null);
      setHeldDialog(null);
    }
  }, [enabled, currentProjectId, releaseIfHeld]);

  // Acquire after loading a collaborative project. Held → silent.
  // Held by someone else → dialog (Open anyway / Take over). Degraded
  // (pre-migration, offline) → silent, exactly the pre-M3 behavior.
  const acquireFor = useCallback(async (projectId: string) => {
    const res = await acquireProjectLease(projectId);
    if (!res) return;
    if (res.acquired) {
      heldRef.current = projectId;
      lastBeatRef.current = Date.now();
      setBanner(null);
      // Warm the token cache so the pagehide release can authenticate
      // without an async getSession it can't await.
      void cacheLeaseAuthToken();
    } else {
      setHeldDialog({
        projectId,
        holderName: res.holderName,
        renewedAt: res.holderRenewedAt,
      });
    }
  }, []);

  const openAnyway = useCallback(() => {
    if (!heldDialog) return;
    setBanner({ kind: "watching", name: heldDialog.holderName });
    setHeldDialog(null);
  }, [heldDialog]);

  const takeOver = useCallback(async () => {
    if (!heldDialog || busy) return;
    setBusy(true);
    try {
      const res = await acquireProjectLease(heldDialog.projectId, true);
      if (res?.acquired) {
        heldRef.current = heldDialog.projectId;
        lastBeatRef.current = Date.now();
        setBanner(null);
        void cacheLeaseAuthToken();
      } else {
        // Steal failed (network) — degrade to watching, never block.
        setBanner({ kind: "watching", name: heldDialog.holderName });
      }
      setHeldDialog(null);
    } finally {
      setBusy(false);
    }
  }, [heldDialog, busy]);

  const dismissBanner = useCallback(() => setBanner(null), []);

  return {
    banner,
    heldDialog,
    busy,
    acquireFor,
    openAnyway,
    takeOver,
    dismissBanner,
  };
}
