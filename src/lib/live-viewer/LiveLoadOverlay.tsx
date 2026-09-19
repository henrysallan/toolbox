"use client";

// The live viewer's project-load veil: the /live page's and the exported
// app's analogue of the editor's ProjectLoadOverlay (components/effects) —
// the same 280px label-over-2px-bar geometry and the same cadence (shared
// timing module): the bar fills through the load's phases, holds a beat,
// then fades. Until 2026-09-16 the wait was `next/dynamic`'s loading
// fallback rendered in the `.fatal` error style ("Loading live viewer…" in
// red), and it lifted the moment the chunk arrived — before the graph had
// deserialized or a frame had drawn.
//
// Themed by the design block, not the editor: rendered as a .live-root
// child it reads the inline token sheet (--bg / --text / --border — so a
// light-mode link gets a light veil and text brightness applies) and
// inherits the font preset. Layout lives in styles.css (`.load-veil`);
// only the two durations ride inline so CSS and the hold logic can't
// drift apart. Leaf module: the export template bundles it, so nothing
// here may import editor-only code.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROJECT_LOAD_BAR_MS,
  PROJECT_LOAD_FADE_MS,
  PROJECT_LOAD_MIN_MS,
  waitAnimationFrames,
} from "@/lib/load-overlay-timing";

/** Where the viewer is in its load, reported by LiveViewer.onLoadPhase. */
export type LiveLoadPhase =
  /** The viewer chunk arrived and the component mounted. */
  | "mounted"
  /** The saved graph deserialized (media, fonts); the engine is up next. */
  | "graph"
  /** The first frame has been evaluated and blitted. */
  | "ready"
  /** Deserialize or engine init failed; the viewer shows its `.fatal`. */
  | "failed";

// Bar position per phase. Applied as a max, so a late report can't pull
// the fill back.
const PHASE_PROGRESS: Record<Exclude<LiveLoadPhase, "failed">, number> = {
  mounted: 0.35,
  graph: 0.7,
  ready: 1,
};

// Once the graph is up, a first frame is at most a rAF away in a
// foreground tab. A hidden tab pauses rAF, and a throw inside the frame
// loop would never report — reveal on this deadline rather than hold the
// veil forever (the editor's revealProjectLoad keeps the same 4s guard).
const READY_DEADLINE_MS = 4000;

const INITIAL_PROGRESS = 0.08;

export interface LiveLoadState {
  progress: number;
  fading: boolean;
}

/** The veil's copy. The editor says "Loading <name> project"; a visitor to
 *  a live link or an exported app just gets the patch's name. */
export function liveLoadLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Loading ${trimmed}` : "Loading";
}

/**
 * Owns one load: `load` is the overlay's state (null once the veil has
 * faded out or the viewer failed), `onLoadPhase` goes to LiveViewer, and
 * `onFaded` to the overlay. The state starts non-null so a server render
 * already shows the veil.
 */
export function useLiveLoad(): {
  load: LiveLoadState | null;
  onLoadPhase: (phase: LiveLoadPhase) => void;
  onFaded: () => void;
} {
  const [load, setLoad] = useState<LiveLoadState | null>({
    progress: INITIAL_PROGRESS,
    fading: false,
  });
  // The clock starts at hydration, not at the server render.
  const startedAtRef = useRef<number | null>(null);
  const revealingRef = useRef(false);
  // Unmounted or failed: the async reveal below must not touch state.
  const doneRef = useRef(false);
  const deadlineRef = useRef(0);

  useEffect(() => {
    doneRef.current = false;
    startedAtRef.current ??= performance.now();
    return () => {
      doneRef.current = true;
      window.clearTimeout(deadlineRef.current);
    };
  }, []);

  // Fill to 100%, let the bar's ease start, hold to the editor's minimum,
  // then hand the overlay its fade.
  const reveal = useCallback(async () => {
    if (revealingRef.current) return;
    revealingRef.current = true;
    window.clearTimeout(deadlineRef.current);
    setLoad((prev) => (prev ? { ...prev, progress: 1 } : prev));
    await waitAnimationFrames(2);
    if (doneRef.current) return;
    const startedAt = startedAtRef.current ?? performance.now();
    const elapsed = performance.now() - startedAt;
    if (elapsed < PROJECT_LOAD_MIN_MS) {
      await new Promise((r) =>
        window.setTimeout(r, PROJECT_LOAD_MIN_MS - elapsed)
      );
      if (doneRef.current) return;
    }
    setLoad((prev) => (prev ? { ...prev, fading: true } : prev));
  }, []);

  const onLoadPhase = useCallback(
    (phase: LiveLoadPhase) => {
      if (phase === "failed") {
        // The viewer renders its own error; the veil would only hide it.
        doneRef.current = true;
        window.clearTimeout(deadlineRef.current);
        setLoad(null);
        return;
      }
      if (phase === "ready") {
        void reveal();
        return;
      }
      const progress = PHASE_PROGRESS[phase];
      setLoad((prev) =>
        prev && !prev.fading
          ? { ...prev, progress: Math.max(prev.progress, progress) }
          : prev
      );
      if (phase === "graph") {
        window.clearTimeout(deadlineRef.current);
        deadlineRef.current = window.setTimeout(
          () => void reveal(),
          READY_DEADLINE_MS
        );
      }
    },
    [reveal]
  );

  const onFaded = useCallback(() => setLoad(null), []);

  return { load, onLoadPhase, onFaded };
}

export function LiveLoadOverlay({
  label,
  progress,
  fading,
  onFaded,
}: {
  label: string;
  progress: number;
  fading: boolean;
  onFaded: () => void;
}) {
  const onFadedRef = useRef(onFaded);
  useEffect(() => {
    onFadedRef.current = onFaded;
  });

  // transitionend can be swallowed (hidden tab, a display toggle mid-fade);
  // a timer a hair past the fade guarantees the veil still unmounts.
  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(
      () => onFadedRef.current(),
      PROJECT_LOAD_FADE_MS + 80
    );
    return () => window.clearTimeout(t);
  }, [fading]);

  const pct = Math.max(0, Math.min(1, progress));

  return (
    <div
      className="load-veil"
      role="status"
      aria-live="polite"
      aria-label={label}
      data-fading={fading || undefined}
      style={{ transition: `opacity ${PROJECT_LOAD_FADE_MS}ms ease` }}
      onTransitionEnd={(e) => {
        if (e.propertyName === "opacity" && fading) onFadedRef.current();
      }}
    >
      <div className="body">
        <div className="label">{label}</div>
        <div className="track">
          <div
            className="fill"
            style={{
              width: `${pct * 100}%`,
              transition: `width ${PROJECT_LOAD_BAR_MS}ms ease-out`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
