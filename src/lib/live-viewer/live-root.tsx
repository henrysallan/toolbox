"use client";

// The one `.live-root` wrapper, shared by /live (LiveClient) and the
// exported app (export-template App). It exists so the design block is
// applied in exactly one place: the inline token sheet (every custom
// property the viewer consumes — including the `--tb-*` names
// form-controls.css reads — so no surface can inherit values from its
// host document), the layout data-attributes styles.css branches on,
// and the font preset. Design absent → DEFAULT_LIVE_DESIGN, which is
// pixel-identical to the pre-design viewer.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { LiveRootElContext } from "./live-root-context";
import {
  CORNER_RADIUS_PX,
  DEFAULT_LIVE_DESIGN,
  FONT_PRESETS,
  designTokens,
  fromSavedLiveDesign,
  resolvePreset,
  type LiveDesign,
} from "./design";

export function LiveRoot({
  design,
  children,
}: {
  design?: LiveDesign;
  children: ReactNode;
}) {
  // Re-validate rather than trust the caller: the exported app's manifest
  // is an embedded JSON blob anyone can hand-edit, and a tampered enum
  // would otherwise leak "undefined" into CSS. Idempotent for the
  // already-validated /live path.
  const d = useMemo(
    () => (design ? fromSavedLiveDesign(design) : DEFAULT_LIVE_DESIGN),
    [design]
  );
  const style: Record<string, string> = {
    ...designTokens(d),
    "--lv-radius": `${CORNER_RADIUS_PX[d.layout.cornerRadius]}px`,
    fontFamily: resolvePreset(FONT_PRESETS, d.presets.font).stack,
  };
  // The element itself, published through context so the shared
  // controls' popups (Dropdown / FontPicker) portal INTO the live root and
  // inherit the token sheet + preset attributes — see live-root-context.
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <LiveRootElContext.Provider value={el}>
      <main
        ref={setEl}
        className="live-root"
        style={style as CSSProperties}
        data-canvas={d.layout.canvas}
        data-panel-side={d.layout.panelSide}
        data-panel-mode={d.layout.panelMode}
        data-panel-align={d.layout.panelAlign}
        data-mode={d.theme.mode}
        data-slider={d.presets.slider}
        data-dropdown={d.presets.dropdown}
        data-numeric={d.presets.numeric}
        data-transport={d.presets.transport}
      >
        {children}
      </main>
    </LiveRootElContext.Provider>
  );
}
