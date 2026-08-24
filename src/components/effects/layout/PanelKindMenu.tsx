import React, { useEffect, useRef, useState } from "react";
import { isAgentAvailable } from "@/lib/agent-bridge";
import { PANEL_KINDS, PANEL_LABELS, type PanelKind } from "./model";

// The per-panel editor-kind switcher (Blender's editor-type dropdown):
// a small icon chip in every panel's top-left corner opening a 3-entry
// menu. Dismiss rules follow lib/param-controls' Dropdown (outside
// mousedown, Esc, scroll). Spec: specdocs/archive/072726_window-tiling.md §3.

function KindIcon({ kind }: { kind: PanelKind }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.2,
  } as const;
  if (kind === "viewport") {
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <rect x={1.5} y={2} width={9} height={8} rx={1} {...common} />
        <circle cx={4.4} cy={5} r={1} {...common} />
        <path d="M2.5 9l2.6-2.6 1.8 1.8L9 6l1.4 1.6" {...common} />
      </svg>
    );
  }
  if (kind === "nodes") {
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <rect x={1} y={1.5} width={4} height={3} rx={0.8} {...common} />
        <rect x={7} y={7.5} width={4} height={3} rx={0.8} {...common} />
        <path d="M5 3h2.5v6H7" {...common} />
      </svg>
    );
  }
  if (kind === "timeline") {
    // A ruler tick row over a track with one keyframe diamond on it.
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <path d="M1 3.2h10M2.6 3.2v-1.4M5.6 3.2v-1.4M8.6 3.2v-1.4" {...common} />
        <path d="M1.5 7.6h9" {...common} />
        <path d="M6 6.1l1.5 1.5L6 9.1 4.5 7.6z" {...common} fill="var(--tb-n-0)" />
      </svg>
    );
  }
  if (kind === "perf") {
    // A frame-time trace with a spike, over a baseline.
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <path d="M1 10.2h10" {...common} />
        <path d="M1.4 8.4l1.8-.2 1.4-3.2L6.2 2l1.5 5.2 1.3-1.4 1.6-.2" {...common} />
      </svg>
    );
  }
  if (kind === "spreadsheet") {
    // A header row over a 2×3 cell grid.
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <rect x={1} y={1.5} width={10} height={9} rx={1} {...common} />
        <path d="M1 4.2h10M1 7.2h10M5.2 4.2v6.3" {...common} />
      </svg>
    );
  }
  if (kind === "assistant") {
    // The four-point sparkle used everywhere else the assistant appears.
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <path d="M6 1l.9 3.1L10 5l-3.1.9L6 9l-.9-3.1L2 5l3.1-.9z" {...common} />
      </svg>
    );
  }
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
      <path d="M1.5 3.5h9M1.5 6h9M1.5 8.5h9" {...common} />
      <circle cx={7.5} cy={3.5} r={1.2} {...common} fill="var(--tb-n-0)" />
      <circle cx={4} cy={6} r={1.2} {...common} fill="var(--tb-n-0)" />
      <circle cx={8.5} cy={8.5} r={1.2} {...common} fill="var(--tb-n-0)" />
    </svg>
  );
}

function PopOutIcon() {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.2,
  } as const;
  // A pane lifting out of its frame: dashed origin, solid arrival.
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
      <path d="M5.5 1.5h-4v9h9v-4" {...common} strokeDasharray="2 1.6" />
      <rect x={6} y={1.5} width={4.5} height={4} rx={0.8} {...common} />
      <path d="M4 8L8.2 3.8" {...common} />
    </svg>
  );
}

export function PanelKindMenu({
  value,
  onChange,
  disabledReason,
  floating,
  size,
  onPopOut,
  popOutDisabledReason,
}: {
  value: PanelKind;
  onChange: (kind: PanelKind) => void;
  /**
   * Detach this panel into its own OS window
   * (080226_panel-popout-windows.md). Omitted entirely for panels that
   * are already detached — their menu has nowhere to go.
   */
  onPopOut?: () => void;
  /** Why pop-out is unavailable right now; dimmed with this as tooltip. */
  popOutDisabledReason?: string;
  /**
   * Square edge in px, overriding the default 19×17 chip. The timeline
   * dock passes its shared control height so the chip lines up with the
   * tab toggle and buttons beside it.
   */
  size?: number;
  /**
   * kind → why it can't be picked right now (e.g. re-assigning the
   * last viewport away). Rendered dimmed with the reason as tooltip.
   */
  disabledReason?: Partial<Record<PanelKind, string>>;
  /** Overlay the chip in the panel's top-left corner (nodes/params). */
  floating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 3 });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node | null;
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as globalThis.Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The chip's OWN window, not module scope — this menu is the only
    // interactive chrome a popped-out panel has, and in another
    // document module-scope `window` would never see its clicks
    // (080226_panel-popout-windows.md §3).
    const win = el?.ownerDocument.defaultView ?? window;
    win.addEventListener("mousedown", onDown);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown);
      win.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={`${PANEL_LABELS[value]} — click to change editor`}
        // Open on press (not full click) — pairs with the items
        // selecting on mouseUP, so press → drag → release picks an
        // editor in one gesture.
        onMouseDown={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: size ?? 19,
          height: size ?? 17,
          boxSizing: "border-box",
          flexShrink: 0,
          background: open ? "var(--tb-n-3)" : "color-mix(in srgb, var(--tb-n-0) 85%, transparent)",
          border: `1px solid ${open ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
          borderRadius: 4,
          color: "var(--tb-n-13)",
          cursor: "pointer",
          padding: 0,
          ...(floating
            ? {
                position: "absolute",
                top: 6,
                left: 6,
                zIndex: 30,
              }
            : // Inline chips still claim a z above the corner split
              // hotspots (z 20) so clicking the chip never starts a
              // gesture where the two overlap.
              { position: "relative", zIndex: 30 }),
        }}
      >
        <KindIcon kind={value} />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            zIndex: 1000,
            background: "var(--tb-n-1)",
            border: "1px solid var(--tb-n-9)",
            borderRadius: 5,
            padding: 3,
            display: "flex",
            flexDirection: "column",
            gap: 1,
            boxShadow: "var(--tb-shadow-pop)",
            minWidth: 130,
          }}
        >
          {/* Filtered here, NOT in PANEL_KINDS: that list is also what the
              layout validators check against, so dropping "assistant" from it
              would make a browser reject an entire layout tree saved on the
              desktop app (model.ts documents that fallback). Hide the choice;
              keep the kind legal. */}
          {PANEL_KINDS.filter(
            (kind) => kind !== "assistant" || isAgentAvailable() || kind === value
          ).map((kind) => {
            const active = kind === value;
            const disabled = !active && !!disabledReason?.[kind];
            return (
              <button
                key={kind}
                type="button"
                title={disabled ? disabledReason?.[kind] : undefined}
                // mouseUp (not click) so both flows work: a plain click
                // AND press-on-chip → drag → release-on-item.
                onMouseUp={() => {
                  if (disabled) return;
                  setOpen(false);
                  if (!active) onChange(kind);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "4px 8px",
                  background: active ? "var(--tb-n-4)" : "transparent",
                  border: "none",
                  borderRadius: 3,
                  color: disabled
                    ? "var(--tb-n-10)"
                    : active
                      ? "var(--tb-n-17)"
                      : "var(--tb-n-13)",
                  fontFamily: "var(--ui-font)",
                  fontSize: 11,
                  cursor: disabled ? "default" : "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (!disabled && !active)
                    e.currentTarget.style.background = "var(--tb-n-3)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                <KindIcon kind={kind} />
                {PANEL_LABELS[kind]}
              </button>
            );
          })}
          {onPopOut && (
            <>
              <div
                style={{
                  height: 1,
                  background: "var(--tb-n-6)",
                  margin: "3px 2px",
                }}
              />
              <button
                type="button"
                title={
                  popOutDisabledReason ??
                  "Open this panel in its own window (drag it to another monitor)"
                }
                onMouseUp={() => {
                  if (popOutDisabledReason) return;
                  setOpen(false);
                  onPopOut();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "4px 8px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 3,
                  color: popOutDisabledReason
                    ? "var(--tb-n-10)"
                    : "var(--tb-n-13)",
                  fontFamily: "var(--ui-font)",
                  fontSize: 11,
                  cursor: popOutDisabledReason ? "default" : "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (!popOutDisabledReason)
                    e.currentTarget.style.background = "var(--tb-n-3)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <PopOutIcon />
                Pop Out
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
