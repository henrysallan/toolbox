"use client";

import { useEffect, useRef, useState } from "react";
import { ViewportPortal, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { fuzzyScoreFields } from "@/lib/fuzzy-search";
import { getNodeDef } from "@/engine/registry";
import { REROUTE_TYPE } from "@/engine/graph-helpers";

// Find-in-graph (right-click → Find…). A small text field pinned to the
// top of the node editor fuzzy-matches the visible nodes as you type;
// every hit gets a yellow ring (FindHighlightOverlay, in the viewport
// transform so it tracks pan/zoom), and ↑ / ↓ (or Enter / Shift+Enter)
// cycle the "current" hit — the editor pans to each one as you go.
// Escape or × closes and drops the highlights.

export interface FindHit {
  id: string;
  score: number;
}

// Score every visible node against the query. Fields: the user-facing
// title (the node's own name, or the scope-relabelled displayName) ranks
// highest, then the definition's catalog name (so "blur" finds a node the
// user renamed "soften"), then the raw type id. Reroutes are wiring
// cosmetics with nothing to find. Sorted best-first, ties broken by
// position so cycling through equal matches reads left-to-right.
export function findNodeMatches(
  nodes: readonly Node<NodeDataPayload>[],
  query: string
): FindHit[] {
  const q = query.trim();
  if (!q) return [];
  const scored: Array<FindHit & { x: number; y: number }> = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    const d = n.data;
    if (d.defType === REROUTE_TYPE) continue;
    const title = d.displayName ?? d.name;
    const defName = getNodeDef(d.defType)?.name;
    const fields = [{ text: title, weight: 1 }];
    if (defName && defName !== title) fields.push({ text: defName, weight: 0.8 });
    fields.push({ text: d.defType, weight: 0.5 });
    const score = fuzzyScoreFields(q, fields);
    if (score === null) continue;
    scored.push({ id: n.id, score, x: n.position.x, y: n.position.y });
  }
  scored.sort((a, b) => b.score - a.score || a.x - b.x || a.y - b.y);
  return scored.map(({ id, score }) => ({ id, score }));
}

// ---------------------------------------------------------------------------

export function NodeFindBar({
  query,
  onQueryChange,
  hitCount,
  hitIndex,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  hitCount: number;
  hitIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Autofocus with the text selected so a reopened bar can be retyped
    // over immediately.
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const noHits = query.trim().length > 0 && hitCount === 0;

  return (
    <div
      data-node-find-bar
      // React Flow's pane listens for mousedown to start a marquee /
      // deselect; keep presses on the bar from reaching it.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 6,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 4px 3px 8px",
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-8)",
        borderRadius: 6,
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
        zIndex: 40,
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        userSelect: "none",
      }}
    >
      <span style={{ color: "var(--tb-n-11)", fontSize: 10 }}>Find</span>
      <input
        ref={inputRef}
        type="text"
        value={query}
        spellCheck={false}
        autoComplete="off"
        placeholder="node name…"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // Everything the bar owns stops here so the editor's window-level
          // shortcut listeners (G, L, Delete, Shift+A…) never see it.
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey && e.key === "Enter") onPrev();
            else onNext();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            onPrev();
          } else {
            e.stopPropagation();
          }
        }}
        style={{
          width: 170,
          height: 20,
          padding: "0 6px",
          background: "var(--tb-n-1)",
          border: `1px solid ${noHits ? "var(--tb-a-red-500)" : "var(--tb-n-7)"}`,
          borderRadius: 4,
          color: "var(--tb-n-16)",
          fontFamily: "var(--ui-font)",
          fontSize: 11,
          outline: "none",
        }}
      />
      <span
        style={{
          minWidth: 44,
          textAlign: "center",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
          color: noHits ? "var(--tb-a-red-500)" : "var(--tb-n-12)",
        }}
      >
        {query.trim().length === 0
          ? ""
          : hitCount === 0
            ? "0 / 0"
            : `${hitIndex + 1} / ${hitCount}`}
      </span>
      <FindBarButton title="Previous match (↑)" onTap={onPrev} disabled={hitCount === 0}>
        ↑
      </FindBarButton>
      <FindBarButton title="Next match (↓ / Enter)" onTap={onNext} disabled={hitCount === 0}>
        ↓
      </FindBarButton>
      <FindBarButton title="Close (Esc)" onTap={onClose}>
        ×
      </FindBarButton>
    </div>
  );
}

function FindBarButton({
  title,
  onTap,
  disabled,
  children,
}: {
  title: string;
  onTap: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const lit = hover && !disabled;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      // Keep focus in the text field so typing continues after a click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onTap();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        padding: 0,
        background: lit ? "var(--tb-n-7)" : "var(--tb-n-4)",
        border: `1px solid ${lit ? "var(--tb-n-10)" : "var(--tb-n-8)"}`,
        color: disabled ? "var(--tb-n-9)" : lit ? "var(--tb-n-16)" : "var(--tb-n-13)",
        fontFamily: "var(--ui-font)",
        fontSize: 12,
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 90ms, border-color 90ms, color 90ms",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

const FALLBACK_W = 220;
const FALLBACK_H = 100;
const RING_PAD = 5;

// Yellow ring around every hit, with the current one brighter and
// thicker. Lives in the viewport transform (ViewportPortal) so it stays
// glued to the nodes through pan/zoom; the portal div follows the node
// layer in DOM order, so a z-index above React Flow's node range puts the
// ring on top without a stacking-context fight. pointer-events off — it
// must never eat a click meant for the node beneath.
export function FindHighlightOverlay({
  nodes,
  hitIds,
  currentId,
}: {
  nodes: readonly Node<NodeDataPayload>[];
  hitIds: ReadonlySet<string>;
  currentId: string | null;
}) {
  if (hitIds.size === 0) return null;
  return (
    <ViewportPortal>
      {nodes.map((n) => {
        if (!hitIds.has(n.id) || n.hidden) return null;
        const w = n.measured?.width ?? n.width ?? FALLBACK_W;
        const h = n.measured?.height ?? n.height ?? FALLBACK_H;
        const current = n.id === currentId;
        return (
          <div
            key={n.id}
            style={{
              position: "absolute",
              left: n.position.x - RING_PAD,
              top: n.position.y - RING_PAD,
              width: w + RING_PAD * 2,
              height: h + RING_PAD * 2,
              borderRadius: 10 + RING_PAD,
              border: `${current ? 2.5 : 1.5}px solid var(--tb-a-yellow-400)`,
              boxShadow: current
                ? "0 0 0 4px color-mix(in srgb, var(--tb-a-yellow-400) 28%, transparent), 0 0 18px color-mix(in srgb, var(--tb-a-yellow-400) 55%, transparent)"
                : "0 0 0 2px color-mix(in srgb, var(--tb-a-yellow-400) 18%, transparent)",
              background: current
                ? "color-mix(in srgb, var(--tb-a-yellow-400) 7%, transparent)"
                : "transparent",
              pointerEvents: "none",
              zIndex: 5000,
              boxSizing: "border-box",
              transition: "border-width 120ms ease, box-shadow 120ms ease, background 120ms ease",
            }}
          />
        );
      })}
    </ViewportPortal>
  );
}
