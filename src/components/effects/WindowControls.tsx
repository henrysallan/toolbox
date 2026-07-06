"use client";

import { useEffect, useState } from "react";
import { platform } from "@/lib/platform";

type WC = NonNullable<typeof platform.windowControls>;

// Custom title-bar controls for the frameless desktop build. Rendered both in
// the MenuBar (the nav bar acts as the title bar) and on the landing screen
// (where the menu bar is hidden). Two OS variants:
//   • macOS  → circular traffic lights, sit on the LEFT (MenuBar/Landing place
//     them there); close / minimize / fullscreen, glyphs on group hover.
//   • Windows → square caption buttons, sit flush in the top-RIGHT corner;
//     minimize / maximize-restore / close, Windows hover states.
// Self-gates: returns null on web and during SSR/first render (native + OS
// detected post-mount to avoid a hydration mismatch).
export default function WindowControls() {
  const [ready, setReady] = useState(false);
  const [isWindows, setIsWindows] = useState(false);
  useEffect(() => {
    setReady(platform.isNative && !!platform.windowControls);
    setIsWindows(platform.os === "windows");
  }, []);

  if (!ready) return null;
  const wc = platform.windowControls!;
  return isWindows ? <WindowsControls wc={wc} /> : <MacControls wc={wc} />;
}

// ---------------------------------------------------------------------------
// macOS traffic lights
// ---------------------------------------------------------------------------

function MacControls({ wc }: { wc: WC }) {
  // macOS convention: glyphs appear in all three when the group is hovered.
  const [groupHover, setGroupHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setGroupHover(true)}
      onMouseLeave={() => setGroupHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
        WebkitAppRegion: "no-drag",
      }}
    >
      <TrafficLight
        color="#ff5f57" hover="#ff453a" glyph="✕" showGlyph={groupHover}
        label="Close" onClick={() => wc.close()}
      />
      <TrafficLight
        color="#febc2e" hover="#f5a623" glyph="—" showGlyph={groupHover}
        label="Minimize" onClick={() => wc.minimize()}
      />
      <TrafficLight
        color="#28c840" hover="#1aab29" glyph="⤢" showGlyph={groupHover}
        label="Fullscreen" onClick={() => wc.toggleFullscreen()}
      />
    </div>
  );
}

function TrafficLight({
  color,
  hover,
  glyph,
  showGlyph,
  label,
  onClick,
}: {
  color: string;
  hover: string;
  glyph: string;
  showGlyph: boolean;
  label: string;
  onClick: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: over ? hover : color,
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "default",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        WebkitAppRegion: "no-drag",
      }}
    >
      <span
        style={{
          fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          fontSize: 8,
          fontWeight: 700,
          color: "rgba(0,0,0,0.55)",
          opacity: showGlyph ? 1 : 0,
          transition: "opacity 90ms",
          pointerEvents: "none",
        }}
      >
        {glyph}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Windows caption buttons
// ---------------------------------------------------------------------------

// Segoe Fluent Icons / Segoe MDL2 Assets glyphs (guaranteed on Win10/11).
const WIN_MINIMIZE = String.fromCharCode(0xe921); // ChromeMinimize
const WIN_MAXIMIZE = String.fromCharCode(0xe922); // ChromeMaximize
const WIN_RESTORE = String.fromCharCode(0xe923); // ChromeRestore
const WIN_CLOSE = String.fromCharCode(0xe8bb); // ChromeClose

function WindowsControls({ wc }: { wc: WC }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    wc.isMaximized()
      .then((m) => {
        if (active) setMaximized(m);
      })
      .catch(() => {});
    // Also track native maximize/restore (Win+Up, Snap, drag-region dbl-click).
    const unsub = wc.onMaximizeChange((m) => setMaximized(m));
    return () => {
      active = false;
      unsub();
    };
  }, [wc]);

  return (
    <div
      style={{
        display: "flex",
        alignSelf: "stretch", // fill the title-bar height (overrides parent center)
        height: "100%",
        WebkitAppRegion: "no-drag",
      }}
    >
      <CaptionButton
        label="Minimize"
        glyph={WIN_MINIMIZE}
        onClick={() => wc.minimize()}
      />
      <CaptionButton
        label={maximized ? "Restore" : "Maximize"}
        glyph={maximized ? WIN_RESTORE : WIN_MAXIMIZE}
        onClick={() => wc.toggleMaximize()}
      />
      <CaptionButton
        label="Close"
        glyph={WIN_CLOSE}
        danger
        onClick={() => wc.close()}
      />
    </div>
  );
}

function CaptionButton({
  label,
  glyph,
  onClick,
  danger,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [over, setOver] = useState(false);
  // Windows hover: subtle light overlay on min/maximize; red on close.
  const background = over
    ? danger
      ? "#c42b1c"
      : "rgba(255,255,255,0.09)"
    : "transparent";
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
      style={{
        width: 46, // Win11 caption-button metric
        height: "100%",
        minHeight: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background,
        color: danger && over ? "#fff" : "#e5e7eb",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "default",
        transition: "background 120ms",
        WebkitAppRegion: "no-drag",
      }}
    >
      <span
        style={{
          fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif',
          fontSize: 10,
          lineHeight: 1,
          pointerEvents: "none",
        }}
      >
        {glyph}
      </span>
    </button>
  );
}
