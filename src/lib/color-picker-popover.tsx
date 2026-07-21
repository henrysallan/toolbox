"use client";

// The app's universal custom color picker (spec
// 071026_color-node-multi-output.md, generalized): an HSV saturation/value
// square, a hue strip, a hex field, and (when the Chromium EyeDropper API
// exists) an eyedropper. Two exports:
//
// - `ColorPickerPopover` — the picker panel itself, absolutely positioned
//   by its host. EffectNode anchors it INSIDE the node div so it tracks
//   graph pan/zoom (the Color node's on-node swatches).
// - `ColorSwatchPicker` — a swatch button that opens the popover in a
//   `position:fixed` portal, viewport-clamped and flipped above when there
//   is no room below (the Dropdown pattern: closes on outside press,
//   panel scroll, resize, Escape). This is what ColorControl — and with it
//   every color param row, gradient point, and ramp stop — renders, in the
//   editor and in live-viewer / exported apps alike.
//
// Lives under @/lib (not @/components) so the Vite export bundle resolves
// it without an alias. Keep it free of editor-only deps.
//
// xyflow guards: the popover root carries nodrag/nowheel/nopan and stops
// pointer propagation so dragging inside it never drags/selects a node.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Local twin of param-controls' normalizeHex/hexAlpha01/withHexAlpha —
// param-controls imports ColorSwatchPicker from here, so importing back
// would cycle. Same contract: alpha-enabled hosts keep an 8-digit
// `#rrggbbaa` (opaque `ff` collapses to 6-digit); everyone else strips.
function normalizeHex(s: string, opts?: { alpha?: boolean }): string | null {
  let h = s.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  else if (opts?.alpha && /^[0-9a-fA-F]{4}$/.test(h))
    h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return "#" + h.toLowerCase();
  if (/^[0-9a-fA-F]{8}$/.test(h)) {
    if (opts?.alpha && !/ff$/i.test(h)) return "#" + h.toLowerCase();
    return "#" + h.slice(0, 6).toLowerCase();
  }
  return null;
}

function hexAlpha01(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length < 8) return 1;
  const a = parseInt(h.slice(6, 8), 16);
  return Number.isFinite(a) ? a / 255 : 1;
}

function withHexAlpha(hex6: string, a01: number): string {
  const byte = Math.max(0, Math.min(255, Math.round(a01 * 255)));
  if (byte >= 255) return hex6;
  return hex6 + byte.toString(16).padStart(2, "0");
}

// Checkerboard underlay that makes translucency visible on swatches and
// the alpha strip (layered UNDER a color gradient via multi-background).
const CHECKER = "repeating-conic-gradient(#52525b 0% 25%, #27272a 0% 50%)";

// HSV (h 0..360, s/v 0..1) <-> hex. Pickers conventionally work in HSV —
// the SV square maps x → saturation, y → value.
function hexToHsv(hex: string): [number, number, number] {
  const h6 = (normalizeHex(hex) ?? "#000000").slice(1);
  const n = parseInt(h6, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [hue, s, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  const to2 = (ch: number) =>
    Math.max(0, Math.min(255, Math.round((ch + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperCtor {
  new (): { open: () => Promise<EyeDropperResult> };
}

// Popover footprint — the portal wrapper uses these to clamp/flip against
// the viewport. Keep in sync with the layout below (the alpha variant
// adds the alpha strip row + its gap).
export const PICKER_WIDTH = 184;
export const PICKER_HEIGHT = 172;
export const PICKER_HEIGHT_ALPHA = PICKER_HEIGHT + 18;

export function ColorPickerPopover({
  value,
  onChange,
  onClose,
  style,
  ignoreRefs,
  alpha = false,
}: {
  value: string;
  onChange: (hex: string) => void;
  onClose: () => void;
  // Positioning (absolute/fixed offsets) supplied by the host.
  style?: React.CSSProperties;
  // Elements exempt from the outside-press dismiss — pass the opener
  // button so its click can TOGGLE the popover instead of close+reopen.
  ignoreRefs?: Array<React.RefObject<HTMLElement | null>>;
  // Alpha-enabled hosts (ParamDef.alpha colors): adds an alpha strip and
  // emits 8-digit `#rrggbbaa` while translucent.
  alpha?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hex = normalizeHex(value, { alpha }) ?? "#ffffff";

  // Local HSV + hex-draft state so drags and partial typing don't fight
  // the controlled value (same resync pattern as ColorControl): an
  // external change (undo, keyframe playback) resyncs; our own emits
  // don't, tracked through lastHexRef.
  const [hsv, setHsv] = useState<[number, number, number]>(() =>
    hexToHsv(hex)
  );
  const [a01, setA01] = useState(() => hexAlpha01(hex));
  const [hexDraft, setHexDraft] = useState(hex);
  const lastHexRef = useRef(hex);
  useEffect(() => {
    if (hex !== lastHexRef.current) {
      lastHexRef.current = hex;
      setHsv(hexToHsv(hex));
      setA01(hexAlpha01(hex));
      setHexDraft(hex);
    }
  }, [hex]);

  const emit = useCallback(
    (next: [number, number, number], nextA: number) => {
      setHsv(next);
      setA01(nextA);
      const rgb = hsvToHex(next[0], next[1], next[2]);
      const nextHex = alpha ? withHexAlpha(rgb, nextA) : rgb;
      lastHexRef.current = nextHex;
      setHexDraft(nextHex);
      onChange(nextHex);
    },
    [onChange, alpha]
  );

  const commitHex = (raw: string) => {
    const norm = normalizeHex(raw, { alpha });
    if (!norm) {
      setHexDraft(lastHexRef.current);
      return;
    }
    lastHexRef.current = norm;
    setHexDraft(norm);
    setHsv(hexToHsv(norm));
    setA01(hexAlpha01(norm));
    onChange(norm);
  };

  // Dismiss on outside pointerdown (capture — before xyflow handlers) and
  // on Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (e.target instanceof Node) {
        if (root.contains(e.target)) return;
        for (const r of ignoreRefs ?? []) {
          if (r.current?.contains(e.target)) return;
        }
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, ignoreRefs]);

  // Shared drag scaffold for the SV square and the hue strip: capture the
  // pointer and report a normalized [0..1]² position within the element to
  // `apply` for the whole drag. Called from the surfaces' onPointerDown.
  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    apply: (nx: number, ny: number) => void
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const applyFromEvent = (ev: { clientX: number; clientY: number }) => {
      const rect = el.getBoundingClientRect();
      apply(
        clamp01((ev.clientX - rect.left) / rect.width),
        clamp01((ev.clientY - rect.top) / rect.height)
      );
    };
    applyFromEvent(e);
    const onMove = (ev: PointerEvent) => applyFromEvent(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const [h, s, v] = hsv;
  const hueColor = hsvToHex(h, 1, 1);
  // Current color sans/with alpha, from committed state (not the hex
  // draft, which may be mid-typing garbage) — drives the alpha strip
  // gradient and the preview swatch.
  const rgbCur = hsvToHex(h, s, v);
  const previewHex = alpha ? withHexAlpha(rgbCur, a01) : rgbCur;
  const eyeDropperCtor = (
    globalThis as { EyeDropper?: EyeDropperCtor }
  ).EyeDropper;

  const textStyle: React.CSSProperties = {
    background: "#0a0a0a",
    border: "1px solid #27272a",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 10,
    padding: "2px 4px",
    boxSizing: "border-box",
    minWidth: 0,
  };

  return (
    <div
      ref={rootRef}
      className="nodrag nowheel nopan"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        zIndex: 30,
        width: PICKER_WIDTH,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: "#111113",
        border: "1px solid #3f3f46",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.55)",
        cursor: "default",
        boxSizing: "border-box",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11,
        ...style,
      }}
    >
      {/* Saturation (x) / value (y) square over the current hue. */}
      <div
        onPointerDown={(e) =>
          startDrag(e, (nx, ny) => emit([h, nx, 1 - ny], a01))
        }
        style={{
          position: "relative",
          height: 110,
          borderRadius: 4,
          backgroundColor: hueColor,
          backgroundImage:
            "linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))",
          cursor: "crosshair",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${s * 100}%`,
            top: `${(1 - v) * 100}%`,
            width: 10,
            height: 10,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            background: "transparent",
            pointerEvents: "none",
          }}
        />
      </div>
      {/* Hue strip. */}
      <div
        onPointerDown={(e) => startDrag(e, (nx) => emit([nx * 360, s, v], a01))}
        style={{
          position: "relative",
          height: 12,
          borderRadius: 3,
          background:
            "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
          cursor: "ew-resize",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${(h / 360) * 100}%`,
            top: -2,
            width: 4,
            height: 16,
            transform: "translateX(-50%)",
            borderRadius: 2,
            background: "#fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        />
      </div>
      {/* Alpha strip — transparent→current color over a checkerboard. */}
      {alpha && (
        <div
          onPointerDown={(e) => startDrag(e, (nx) => emit(hsv, nx))}
          style={{
            position: "relative",
            height: 12,
            borderRadius: 3,
            background: `linear-gradient(to right, ${rgbCur}00, ${rgbCur}), ${CHECKER}`,
            backgroundSize: "auto, 8px 8px",
            cursor: "ew-resize",
            touchAction: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: `${a01 * 100}%`,
              top: -2,
              width: 4,
              height: 16,
              transform: "translateX(-50%)",
              borderRadius: 2,
              background: "#fff",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
              pointerEvents: "none",
            }}
          />
        </div>
      )}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <span
          aria-hidden
          style={
            alpha
              ? {
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                  borderRadius: 3,
                  // Composed from committed state (hexDraft may be
                  // mid-typing garbage); layered over the checkerboard
                  // so translucency reads at a glance.
                  background: `linear-gradient(${previewHex}, ${previewHex}), ${CHECKER}`,
                  backgroundSize: "auto, 6px 6px",
                  border: "1px solid #3f3f46",
                }
              : {
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                  borderRadius: 3,
                  background: hexDraft,
                  border: "1px solid #3f3f46",
                }
          }
        />
        <input
          type="text"
          value={hexDraft}
          spellCheck={false}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={() => commitHex(hexDraft)}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing must not hit graph shortcuts
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") onClose();
          }}
          title="Hex"
          style={{ ...textStyle, flex: 1 }}
        />
        {eyeDropperCtor && (
          <button
            title="Pick a color from the screen"
            onClick={() => {
              new eyeDropperCtor()
                .open()
                // EyeDropper only reports opaque sRGB — keep the current
                // alpha rather than resetting it to 1.
                .then((res) =>
                  commitHex(
                    alpha ? withHexAlpha(res.sRGBHex, a01) : res.sRGBHex
                  )
                )
                .catch(() => {
                  /* user canceled — no-op */
                });
            }}
            style={{
              width: 20,
              height: 20,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "1px solid #3f3f46",
              borderRadius: 3,
              color: "#a1a1aa",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18.4 2.6a2 2 0 0 1 2.8 2.8l-2.1 2.1-2.8-2.8 2.1-2.1zM14 6.8L4.5 16.3 3 21l4.7-1.5L17.2 10 14 6.8z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// Swatch button + portal'd popover — the universal color control swatch.
// Fixed-position portal so it escapes scrolling/overflow panels; clamped
// to the viewport and flipped above the swatch when there's no room below.
// Mirrors the Dropdown pattern: closes on outside press, any outer scroll,
// resize, and Escape (outside press handled by the popover itself with the
// swatch exempted so clicking it toggles).
export function ColorSwatchPicker({
  value,
  onChange,
  title = "Pick a color",
  swatchStyle,
  alpha = false,
  disabled = false,
}: {
  value: string;
  onChange: (hex: string) => void;
  title?: string;
  swatchStyle?: React.CSSProperties;
  // Alpha-enabled hosts: checkerboard swatch + the popover's alpha strip.
  alpha?: boolean;
  // Renders the swatch inert (driven params in the live viewer).
  disabled?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const hex = normalizeHex(value, { alpha }) ?? "#ffffff";
  const pickerHeight = alpha ? PICKER_HEIGHT_ALPHA : PICKER_HEIGHT;

  const openAtSwatch = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const M = 8;
    const left = Math.max(
      M,
      Math.min(r.left, window.innerWidth - PICKER_WIDTH - M)
    );
    const below = r.bottom + 4;
    const top =
      below + pickerHeight > window.innerHeight - M
        ? Math.max(M, r.top - pickerHeight - 4)
        : below;
    setPos({ left, top });
  };

  useEffect(() => {
    if (!pos) return;
    // Scrolling any outer container invalidates the fixed position — close
    // (same rule as Dropdown). Nothing inside the picker scrolls.
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as globalThis.Node)) return;
      setPos(null);
    };
    const onResize = () => setPos(null);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          if (pos) setPos(null);
          else openAtSwatch();
        }}
        style={{
          width: 22,
          height: 18,
          padding: 0,
          border: "1px solid #27272a",
          borderRadius: 3,
          // Alpha-enabled swatches layer the (possibly translucent) color
          // over a checkerboard; 8-digit hex is valid CSS.
          background: alpha
            ? `linear-gradient(${hex}, ${hex}), ${CHECKER}`
            : hex,
          backgroundSize: alpha ? "auto, 6px 6px" : undefined,
          flexShrink: 0,
          cursor: "pointer",
          ...swatchStyle,
        }}
      />
      {pos &&
        createPortal(
          <div ref={popRef}>
            <ColorPickerPopover
              value={hex}
              onChange={onChange}
              onClose={() => setPos(null)}
              ignoreRefs={[btnRef]}
              alpha={alpha}
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                zIndex: 10000,
              }}
            />
          </div>,
          document.body
        )}
    </>
  );
}

export default ColorPickerPopover;
