"use client";

import { useEffect, useState } from "react";
import { platform } from "@/lib/platform";

// macOS-style traffic lights for the frameless desktop build. Rendered both in
// the MenuBar (the nav bar acts as the title bar) and on the landing screen
// (where the menu bar is hidden, but the user still needs to close / minimize /
// fullscreen). Self-gates: returns null on web and during SSR/first render
// (detected post-mount to avoid a hydration mismatch).
export default function WindowControls() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(platform.isNative && !!platform.windowControls);
  }, []);
  // macOS convention: glyphs appear in all three when the group is hovered.
  const [groupHover, setGroupHover] = useState(false);

  if (!ready) return null;
  const wc = platform.windowControls!;
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
