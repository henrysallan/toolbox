"use client";

import { useEffect, useRef, useState } from "react";
import { platform, type UpdateState } from "@/lib/platform";

// Desktop auto-update UI state (spec 070826_desktop-auto-update.md). Mirrors
// the main process's pushed `toolbox:update:state` events into one UI-facing
// phase, and fires the single quiet launch check (~10s post-mount, native
// only). Single consumer: MenuBar (which also renders the progress toast).
//
// Distinction the raw events don't carry: a "none" result only surfaces as a
// transient "Up to Date ✓" when the *user* asked (manual check); launch checks
// stay silent. Errors (offline etc.) silently revert to idle — details are
// logged main-side.
export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" } // transient (manual check found nothing)
  | { phase: "available"; version?: string }
  | { phase: "downloading"; percent: number; bytesPerSecond: number }
  | { phase: "ready"; version?: string };

export function useDesktopUpdates() {
  const [status, setStatus] = useState<UpdatePhase>({ phase: "idle" });
  const manualRef = useRef(false);
  const revertTimer = useRef<number | null>(null);

  useEffect(() => {
    const u = platform.isNative ? platform.updates : undefined;
    if (!u) return;
    const unsub = u.onState((s: UpdateState) => {
      switch (s.state) {
        case "checking":
          setStatus({ phase: "checking" });
          break;
        case "available":
          setStatus({ phase: "available", version: s.version });
          break;
        case "none":
          if (manualRef.current) {
            setStatus({ phase: "upToDate" });
            if (revertTimer.current !== null) window.clearTimeout(revertTimer.current);
            revertTimer.current = window.setTimeout(() => setStatus({ phase: "idle" }), 4000);
          } else {
            setStatus({ phase: "idle" });
          }
          manualRef.current = false;
          break;
        case "downloading":
          setStatus({
            phase: "downloading",
            percent: s.percent ?? 0,
            bytesPerSecond: s.bytesPerSecond ?? 0,
          });
          break;
        case "ready":
          setStatus({ phase: "ready", version: s.version });
          break;
        case "error":
          setStatus({ phase: "idle" });
          manualRef.current = false;
          break;
      }
    });
    // Quiet launch check, delayed so it never competes with startup work.
    const t = window.setTimeout(() => void u.check(), 10_000);
    return () => {
      unsub();
      window.clearTimeout(t);
      if (revertTimer.current !== null) window.clearTimeout(revertTimer.current);
    };
  }, []);

  return {
    status,
    check: () => {
      manualRef.current = true;
      void platform.updates?.check();
    },
    download: () => void platform.updates?.download(),
    install: () => platform.updates?.install(),
  };
}
