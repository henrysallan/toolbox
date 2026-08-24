"use client";

// The Live Link Designer (081426_live-link-designer.md M2): a full-screen
// authoring surface (below the menu bar) for the project's LiveDesign
// block — layout, theme, control-style presets, control order/renames,
// and the viewer-export toggles — with an accurate preview of the live
// link UI (DesignerPreview, iframe-isolated).
//
// This is EDITOR chrome: the settings column uses the editor's theme
// tokens. Only the preview subtree is design-token land.
//
// Editing model: a local `working` copy of the design; Save hands it to
// EffectsApp (setLiveDesign + dirty pill), Cancel/Escape discards (with
// a confirm when edited). Preview slider tweaks are EPHEMERAL — a local
// param map seeded from the graph, never written back, no undo entries,
// no autokey. Auditioning a control is for feeling the chrome, not
// editing the patch.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Edge, Node } from "@xyflow/react";
// The editor page never imports the live-viewer stylesheet (only the
// /live route and the export template do) — the designer must, both so a
// same-document render works and so the preview iframe's syncStyles has
// the .live-root rules to copy. Pulls in form-controls.css +
// design-presets.css via its own @imports.
import "@/lib/live-viewer/styles.css";
import type { NodeDataPayload } from "@/state/graph";
import { buildExportManifest } from "@/lib/export-manifest";
import { parseTargetHandleKind } from "@/engine/graph-helpers";
import {
  DEFAULT_LIVE_DESIGN,
  DROPDOWN_PRESETS,
  FONT_PRESETS,
  NUMERIC_PRESETS,
  SLIDER_PRESETS,
  orderControlRefs,
  type LiveCanvasMode,
  type LiveCornerRadius,
  type LiveDesign,
  type LivePanelAlign,
  type LivePanelMode,
  type LivePanelSide,
  type LiveThemeMode,
} from "@/lib/live-viewer/design";
import { setGatewayInputLock } from "@/lib/shortcut-freeze";
import { AspectLock, ResField, useAspectLock } from "../res-controls";
import { DesignerPreview } from "./DesignerPreview";

const ROW_H = 26;

interface ControlRowEntry {
  kind: "file" | "control";
  nodeId: string;
  paramName: string;
  defaultLabel: string;
}

const rowRef = (r: ControlRowEntry) => `${r.nodeId}::${r.paramName}`;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// "1920×1080" reads as "16:9"; awkward dims fall back to "1.85:1".
function ratioLabel([w, h]: [number, number]): string {
  if (w <= 0 || h <= 0) return "";
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

// Same heuristic as LiveClient's pickOutputNodeId — the live link renders
// the viewport-active terminal, else the first Output node.
function pickOutputNodeId(nodes: Node<NodeDataPayload>[]): string | null {
  for (const n of nodes) if (n.data.active) return n.id;
  for (const n of nodes) if (n.data.defType === "output") return n.id;
  return null;
}

export interface LiveLinkDesignerProps {
  design: LiveDesign | null;
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  canvasRes: [number, number];
  /** One-shot editor-canvas snapshot captured at open; null = blank. */
  posterUrl: string | null;
  /** Project loop length in seconds; null = no loop (no scrub bar). */
  loopSecs: number | null;
  /** Exact menu-bar height (22 web / 32 frameless desktop) — the modal's
   *  top edge sits flush against its bottom. */
  topInset: number;
  projectName: string;
  onSave: (design: LiveDesign) => void;
  onClose: () => void;
  /**
   * Fired on EVERY edit with the working design. EffectsApp mirrors it
   * into a ref the save path prefers, so a plain ⌘S taken while the
   * designer is open captures what's on screen — persistence must never
   * depend on which Save the user reaches for.
   */
  onDraftChange?: (design: LiveDesign) => void;
}

export default function LiveLinkDesigner({
  design,
  nodes,
  edges,
  canvasRes,
  posterUrl,
  loopSecs,
  topInset,
  projectName,
  onSave,
  onClose,
  onDraftChange,
}: LiveLinkDesignerProps) {
  const [working, setWorking] = useState<LiveDesign>(
    () => design ?? DEFAULT_LIVE_DESIGN
  );
  const [dirty, setDirty] = useState(false);
  // Not memoized: computing `next` from the render-scope `working` keeps
  // the draft mirror exact, and every caller is an event handler.
  const update = (fn: (d: LiveDesign) => LiveDesign) => {
    const next = fn(working);
    setWorking(next);
    setDirty(true);
    onDraftChange?.(next);
  };

  const outputNodeId = useMemo(() => pickOutputNodeId(nodes), [nodes]);
  const manifest = useMemo(() => {
    if (!outputNodeId) return null;
    return buildExportManifest({
      nodes,
      edges,
      appName: projectName,
      outputNodeId,
      canvasRes,
    }).manifest;
  }, [nodes, edges, projectName, outputNodeId, canvasRes]);

  // Ephemeral preview values — seeded from the graph, never written back.
  const [previewParams, setPreviewParams] = useState(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const n of nodes) m.set(n.id, { ...n.data.params });
    return m;
  });
  const onPreviewParamChange = useCallback(
    (ref: { nodeId: string; paramName: string }, value: unknown) => {
      setPreviewParams((prev) => {
        const next = new Map(prev);
        next.set(ref.nodeId, {
          ...(next.get(ref.nodeId) ?? {}),
          [ref.paramName]: value,
        });
        return next;
      });
    },
    []
  );

  const drivenParams = useMemo(() => {
    const set = new Set<string>();
    for (const e of edges) {
      if (!e.targetHandle) continue;
      const parsed = parseTargetHandleKind(e.targetHandle);
      if (parsed?.kind === "param") set.add(`${e.target}::${parsed.name}`);
    }
    return set;
  }, [edges]);

  // The reorder/rename list: one order spans both panel sections
  // (File Inputs + Controls), matching how the viewer sorts them.
  const rows = useMemo<ControlRowEntry[]>(() => {
    if (!manifest) return [];
    const entries: ControlRowEntry[] = [
      ...manifest.fileInputs.map((fi) => ({
        kind: "file" as const,
        nodeId: fi.nodeId,
        paramName: fi.paramName,
        defaultLabel: `${fi.nodeName} — ${fi.label}`,
      })),
      ...manifest.controls.map((c) => ({
        kind: "control" as const,
        nodeId: c.nodeId,
        paramName: c.paramName,
        defaultLabel: `${c.nodeName} — ${c.label}`,
      })),
    ];
    return orderControlRefs(entries, rowRef, working);
  }, [manifest, working]);

  // --- drag-to-reorder (pointer-based, fixed row height) -----------------
  // Not memoized on purpose: the handler closes over the CURRENT `rows`
  // at pointerdown time, and rows can't change mid-drag (the graph is
  // frozen while the designer is up; order commits only on release).
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const onHandleDown = (e: React.PointerEvent, index: number) => {
    e.preventDefault();
    const list = listRef.current;
    if (!list) return;
    const dragRows = rows;
    const start = { from: index, to: index };
    dragRef.current = start;
    setDrag(start);
    const move = (ev: PointerEvent) => {
      const rect = list.getBoundingClientRect();
      const y = ev.clientY - rect.top + list.scrollTop;
      // `to` is an INSERTION index: 0..count, row boundaries.
      const to = Math.max(
        0,
        Math.min(dragRows.length, Math.round(y / ROW_H))
      );
      const next = { from: index, to };
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      // to === from / from+1 both mean "dropped where it was".
      if (!d || d.to === d.from || d.to === d.from + 1) return;
      const refs = dragRows.map(rowRef);
      const [moved] = refs.splice(d.from, 1);
      refs.splice(d.to > d.from ? d.to - 1 : d.to, 0, moved);
      update((w) => ({ ...w, controls: { ...w.controls, order: refs } }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // --- export size override (Export section) ----------------------------
  // Effective = the override when set, else the project's resolution;
  // the aspect-lock mechanics are the shared res-controls ones, so the
  // fields behave exactly like Project Settings'.
  const effectiveExportRes: [number, number] =
    working.export.resolution ?? canvasRes;
  const setExportRes = useCallback(
    (res: [number, number]) => {
      update((d) => ({ ...d, export: { ...d.export, resolution: res } }));
    },
    [update]
  );
  const exportAspect = useAspectLock(effectiveExportRes, setExportRes);

  const setLabel = useCallback(
    (ref: string, value: string) => {
      update((w) => {
        const labels = { ...w.controls.labels };
        if (value.trim().length === 0) delete labels[ref];
        else labels[ref] = value.slice(0, 120);
        return { ...w, controls: { ...w.controls, labels } };
      });
    },
    [update]
  );

  // --- lifecycle: block editor shortcuts while up; Esc closes -----------
  const requestClose = useCallback(() => {
    if (
      dirty &&
      !window.confirm("Discard live link design changes?")
    ) {
      return;
    }
    onClose();
  }, [dirty, onClose]);

  // Same lock the Landing gateway uses: kills editor keyboard/clipboard/
  // wheel-pan reachability while the overlay is up. Escape stays live
  // and editable targets (rename inputs, selects, sliders) pass through.
  useEffect(() => {
    setGatewayInputLock(true);
    return () => setGatewayInputLock(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target;
      // Esc in a text field blurs it rather than closing the designer.
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA")
      ) {
        t.blur();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  // Portalled to <body>: the app shell carries a transform (menu-settle
  // animation), which makes it the containing block for position:fixed —
  // mounted in place, the overlay would size against the shell and spill
  // past the viewport bottom. The portal keeps fixed truly viewport-fixed.
  return createPortal(
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: topInset,
        bottom: 0,
        zIndex: 90,
        background: "var(--tb-n-0)",
        // Hairline stroke delineating the modal from the editor chrome.
        border: "1px solid var(--tb-n-8)",
        boxSizing: "border-box",
        display: "flex",
        gap: 12,
        padding: 12,
        color: "var(--tb-n-14)",
        fontSize: 11,
      }}
    >
      {/* --- settings column: scrollable sections, PINNED footer --- */}
      <div
        style={{
          width: 300,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          minHeight: 0,
        }}
      >
        {/* Header: title left, Cancel/Save right — always visible at the
            top regardless of how tall the sections below run. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "2px 0 0 2px",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--tb-n-16)",
              whiteSpace: "nowrap",
            }}
          >
            Live Link
          </span>
          <span
            style={{
              fontWeight: 400,
              fontSize: 12,
              color: "var(--tb-n-10)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: 1,
            }}
          >
            {projectName}
          </span>
          <FooterButton onClick={requestClose}>Cancel</FooterButton>
          <FooterButton primary onClick={() => onSave(working)}>
            Save
          </FooterButton>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            paddingRight: 2,
          }}
        >
        <Section title="Layout">
          <Field label="Canvas">
            <PillRow<LiveCanvasMode>
              value={working.layout.canvas}
              options={[
                ["inset", "Inset"],
                ["full-bleed", "Full bleed"],
              ]}
              onChange={(v) =>
                update((d) => ({ ...d, layout: { ...d.layout, canvas: v } }))
              }
            />
          </Field>
          <Field label="Panel side">
            <PillRow<LivePanelSide>
              value={working.layout.panelSide}
              options={[
                ["left", "Left"],
                ["right", "Right"],
              ]}
              onChange={(v) =>
                update((d) => ({
                  ...d,
                  layout: { ...d.layout, panelSide: v },
                }))
              }
            />
          </Field>
          <Field label="Panel">
            <PillRow<LivePanelMode>
              value={working.layout.panelMode}
              options={[
                ["full-height", "Full height"],
                ["floating", "Floating"],
              ]}
              onChange={(v) =>
                update((d) => ({
                  ...d,
                  layout: { ...d.layout, panelMode: v },
                }))
              }
            />
          </Field>
          {working.layout.panelMode === "floating" && (
            <Field label="Panel align">
              <PillRow<LivePanelAlign>
                value={working.layout.panelAlign}
                options={[
                  ["top", "Top"],
                  ["middle", "Middle"],
                  ["bottom", "Bottom"],
                ]}
                onChange={(v) =>
                  update((d) => ({
                    ...d,
                    layout: { ...d.layout, panelAlign: v },
                  }))
                }
              />
            </Field>
          )}
          <Field label="Corners">
            <PillRow<LiveCornerRadius>
              value={working.layout.cornerRadius}
              options={[
                ["none", "None"],
                ["small", "Small"],
                ["large", "Large"],
              ]}
              onChange={(v) =>
                update((d) => ({
                  ...d,
                  layout: { ...d.layout, cornerRadius: v },
                }))
              }
            />
          </Field>
        </Section>

        <Section title="Theme">
          <Field label="Mode">
            <PillRow<LiveThemeMode>
              value={working.theme.mode}
              options={[
                ["dark", "Dark"],
                ["light", "Light"],
              ]}
              onChange={(v) =>
                update((d) => ({ ...d, theme: { ...d.theme, mode: v } }))
              }
            />
          </Field>
          <Field
            label={`Panel opacity · ${Math.round(
              working.theme.panelOpacity * 100
            )}%`}
          >
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.01}
              value={working.theme.panelOpacity}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  theme: {
                    ...d.theme,
                    panelOpacity: Number(e.target.value),
                  },
                }))
              }
              style={{ width: "100%" }}
            />
          </Field>
          <Field
            label={`Panel blur · ${Math.round(working.theme.panelBlur)}px`}
          >
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={working.theme.panelBlur}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  theme: { ...d.theme, panelBlur: Number(e.target.value) },
                }))
              }
              style={{ width: "100%" }}
            />
          </Field>
          <Field label="Tint">
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={working.theme.tintHue !== null}
                onChange={(e) =>
                  update((d) => ({
                    ...d,
                    theme: {
                      ...d.theme,
                      tintHue: e.target.checked
                        ? d.theme.tintHue ?? 210
                        : null,
                    },
                  }))
                }
              />
              <span style={{ color: "var(--tb-n-12)" }}>
                Tint the greys
              </span>
            </label>
          </Field>
          {working.theme.tintHue !== null && (
            <>
              <Field label={`Hue · ${Math.round(working.theme.tintHue)}°`}>
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={working.theme.tintHue}
                  onChange={(e) =>
                    update((d) => ({
                      ...d,
                      theme: { ...d.theme, tintHue: Number(e.target.value) },
                    }))
                  }
                  style={{ width: "100%" }}
                />
              </Field>
              <Field
                label={`Strength · ${working.theme.tintStrength.toFixed(2)}`}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={working.theme.tintStrength}
                  onChange={(e) =>
                    update((d) => ({
                      ...d,
                      theme: {
                        ...d.theme,
                        tintStrength: Number(e.target.value),
                      },
                    }))
                  }
                  style={{ width: "100%" }}
                />
              </Field>
            </>
          )}
        </Section>

        <Section title="Styles">
          <PresetPicker
            label="Sliders"
            registry={SLIDER_PRESETS}
            value={working.presets.slider}
            onChange={(v) =>
              update((d) => ({ ...d, presets: { ...d.presets, slider: v } }))
            }
          />
          <PresetPicker
            label="Dropdowns"
            registry={DROPDOWN_PRESETS}
            value={working.presets.dropdown}
            onChange={(v) =>
              update((d) => ({
                ...d,
                presets: { ...d.presets, dropdown: v },
              }))
            }
          />
          <PresetPicker
            label="Number inputs"
            registry={NUMERIC_PRESETS}
            value={working.presets.numeric}
            onChange={(v) =>
              update((d) => ({
                ...d,
                presets: { ...d.presets, numeric: v },
              }))
            }
          />
          <PresetPicker
            label="Font"
            registry={FONT_PRESETS}
            value={working.presets.font}
            onChange={(v) =>
              update((d) => ({ ...d, presets: { ...d.presets, font: v } }))
            }
          />
          <div style={{ color: "var(--tb-n-9)", fontSize: 10 }}>
            More preset packs coming — the pickers grow as packs land.
          </div>
        </Section>

        <Section title="Controls">
          <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
            Drag ⠿ to reorder · type to rename (blank = default)
          </div>
          <div
            ref={listRef}
            style={{
              display: "flex",
              flexDirection: "column",
              position: "relative",
              maxHeight: 260,
              overflowY: "auto",
            }}
          >
            {rows.length === 0 && (
              <div style={{ color: "var(--tb-n-9)", padding: "6px 2px" }}>
                No controls exposed yet — mark params as controls in the
                editor’s parameter panel.
              </div>
            )}
            {rows.map((row, i) => {
              const ref = rowRef(row);
              const isDragging = drag?.from === i;
              return (
                <div
                  key={ref}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: ROW_H,
                    flexShrink: 0,
                    opacity: isDragging ? 0.45 : 1,
                    borderTop:
                      drag && drag.to === i
                        ? "2px solid var(--tb-n-12)"
                        : "2px solid transparent",
                  }}
                >
                  <span
                    onPointerDown={(e) => onHandleDown(e, i)}
                    style={{
                      cursor: "grab",
                      color: "var(--tb-n-9)",
                      userSelect: "none",
                      touchAction: "none",
                      padding: "0 2px",
                    }}
                  >
                    ⠿
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--tb-n-9)",
                      width: 22,
                      flexShrink: 0,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {row.kind === "file" ? "file" : "ctl"}
                  </span>
                  <input
                    value={working.controls.labels[ref] ?? ""}
                    placeholder={row.defaultLabel}
                    onChange={(e) => setLabel(ref, e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: "var(--tb-n-2)",
                      border: "1px solid var(--tb-n-6)",
                      borderRadius: 3,
                      color: "var(--tb-n-15)",
                      fontSize: 11,
                      padding: "2px 6px",
                    }}
                  />
                </div>
              );
            })}
            {drag && drag.to === rows.length && (
              <div
                style={{
                  height: 0,
                  borderTop: "2px solid var(--tb-n-12)",
                }}
              />
            )}
          </div>
        </Section>

        <Section title="Export">
          <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
            Which export buttons viewers get on the live link.
          </div>
          {(
            [
              ["image", "Image (PNG)"],
              ["video", "Video (one loop)"],
              ["gif", "GIF (one loop)"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={working.export[key]}
                onChange={(e) =>
                  update((d) => ({
                    ...d,
                    export: { ...d.export, [key]: e.target.checked },
                  }))
                }
              />
              <span style={{ color: "var(--tb-n-12)" }}>{label}</span>
            </label>
          ))}
          {(working.export.image ||
            working.export.video ||
            working.export.gif) && (
            <Field label={`Size · ${ratioLabel(effectiveExportRes)}`}>
              <div
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <ResField
                  label="Width"
                  value={effectiveExportRes[0]}
                  onGestureStart={exportAspect.snapRatio}
                  onCommit={exportAspect.applyWidth}
                />
                <AspectLock
                  locked={exportAspect.locked}
                  onToggle={exportAspect.toggle}
                />
                <ResField
                  label="Height"
                  value={effectiveExportRes[1]}
                  onGestureStart={exportAspect.snapRatio}
                  onCommit={exportAspect.applyHeight}
                />
                {working.export.resolution && (
                  <button
                    onClick={() =>
                      update((d) => ({
                        ...d,
                        export: { ...d.export, resolution: null },
                      }))
                    }
                    title="Back to the project's resolution"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--tb-n-10)",
                      fontSize: 10,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      padding: "0 2px",
                    }}
                  >
                    reset
                  </button>
                )}
              </div>
              <div style={{ color: "var(--tb-n-9)", fontSize: 10 }}>
                {working.export.resolution
                  ? "Overrides the live link’s canvas resolution."
                  : `Project resolution (${canvasRes[0]} × ${canvasRes[1]}).`}
              </div>
            </Field>
          )}
        </Section>

        </div>
      </div>

      {/* --- preview: a fixed 13" viewport centered in a recessed area
          (the frame chrome lives in DesignerPreview) --- */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          borderRadius: 4,
          overflow: "hidden",
          background: "var(--tb-n-1)",
        }}
      >
        {manifest ? (
          <DesignerPreview
            manifest={manifest}
            design={working}
            posterUrl={posterUrl}
            loopSecs={loopSecs}
            paramValues={previewParams}
            drivenParams={drivenParams}
            onParamChange={onPreviewParamChange}
          />
        ) : (
          <div
            style={{
              padding: 24,
              color: "var(--tb-n-10)",
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
            }}
          >
            This project has no terminal Output node — the live link has
            nothing to render.
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// --- designer-chrome atoms (editor-themed) --------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--tb-n-6)",
        borderRadius: 4,
        background: "var(--tb-n-1)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--tb-n-10)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ color: "var(--tb-n-11)", fontSize: 10 }}>{label}</div>
      {children}
    </div>
  );
}

function PillRow<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        border: "1px solid var(--tb-n-6)",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      {options.map(([v, label]) => {
        const active = v === value;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            style={{
              flex: 1,
              padding: "4px 0",
              fontSize: 10,
              border: "none",
              cursor: "pointer",
              background: active ? "var(--tb-n-5)" : "var(--tb-n-2)",
              color: active ? "var(--tb-n-16)" : "var(--tb-n-11)",
              fontFamily: "inherit",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function PresetPicker({
  label,
  registry,
  value,
  onChange,
}: {
  label: string;
  registry: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "var(--tb-n-2)",
          border: "1px solid var(--tb-n-6)",
          borderRadius: 3,
          color: "var(--tb-n-15)",
          fontSize: 11,
          padding: "3px 4px",
          fontFamily: "inherit",
        }}
      >
        {registry.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function FooterButton({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "3px 12px",
        fontSize: 10,
        borderRadius: 999,
        cursor: disabled ? "default" : "pointer",
        border: `1px solid ${
          primary ? "var(--tb-a-green-500)" : "var(--tb-n-6)"
        }`,
        background: primary ? "var(--tb-a-green-600)" : "var(--tb-n-2)",
        color: disabled
          ? "var(--tb-n-8)"
          : primary
            ? "#ffffff"
            : "var(--tb-n-12)",
        fontFamily: "inherit",
        fontWeight: primary ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}
