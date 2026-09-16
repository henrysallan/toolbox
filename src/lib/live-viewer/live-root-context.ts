"use client";

// The `.live-root` ELEMENT, for shared controls that portal a popup
// (Dropdown, FontPicker in lib/param-controls). Outside a live surface the
// context is null and popups keep portalling to the panel's <body>; inside
// one they portal into .live-root itself, so the list inherits the inline
// design token sheet and the data-slider / data-dropdown / data-numeric
// preset attributes (design-presets.css) exactly like the trigger does. A
// body-portalled list had NO tokens in the exported app (unstyled) and the
// editor's :root tokens on /live (a dark list over a light panel).
//
// Leaf module on purpose: param-controls imports it, and the export
// template bundles both — nothing here may import editor-only code.

import { createContext, useContext } from "react";

export const LiveRootElContext = createContext<HTMLElement | null>(null);

/** The enclosing .live-root element, or null outside a live surface. */
export function useLiveRootEl(): HTMLElement | null {
  return useContext(LiveRootElContext);
}
