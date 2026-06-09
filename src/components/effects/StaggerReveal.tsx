"use client";

import { useEffect, useState } from "react";

// General-purpose snappy staggered fade-in for list-style UI such as the
// parameter rows / sliders. Tuned tight on purpose: a short fade with a
// tiny per-item offset so a full panel of controls reads as one quick
// ripple rather than a slow sequential reveal.
//
// To replay the cascade (e.g. when the selected node changes), give each
// StaggerItem a `key` that includes the node id so the items remount and
// start from hidden again.
const STEP_MS = 16;
const DURATION_MS = 150;

// Flips to true one frame after mount so an element that renders at
// opacity 0 transitions to visible.
function useReveal(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return shown;
}

export function StaggerItem({
  index,
  children,
}: {
  // Position in the list — scales the fade delay for the cascade.
  index: number;
  children: React.ReactNode;
}) {
  const shown = useReveal();
  return (
    <div
      style={{
        // Opacity-only: ParamRow hosts a lot of popovers/portals, and a
        // lingering transform would create a containing block that could
        // mis-anchor them. A clean fade sidesteps that entirely.
        opacity: shown ? 1 : 0,
        transition: `opacity ${DURATION_MS}ms ease`,
        transitionDelay: `${index * STEP_MS}ms`,
        // Keep the column layout intact — the wrapper is now the flex item.
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}
