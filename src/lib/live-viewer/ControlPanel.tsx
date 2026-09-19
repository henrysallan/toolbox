"use client";

import { useCallback, useMemo } from "react";
import type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
  ExportManifestGizmo,
} from "./manifest-types";
import { gizmoControlRef, orderControlRefs } from "./design";
import { MiniBarSlider, ParamControl, TogglePill } from "@/lib/param-controls";
import { registerAudioFile, disposeAudioFile } from "@/lib/audio";
import { registerCustomFont } from "@/lib/fonts";
import { parseSvg } from "@/lib/svg-parse";
import { registerVideoFile, disposeVideoFile } from "@/lib/video";
import type {
  AudioFileParamValue,
  SvgFileParamValue,
  VideoFileParamValue,
  FontParamValue,
} from "@/engine/types";

interface ParamRef {
  nodeId: string;
  paramName: string;
}

// Patch identity shown at the top of the panel (2026-09-16): the project
// name, then "by <author> · #<code>". It used to be a fixed bottom-left
// badge on /live (LiveClient's ShareCorner), outside the panel; inside it
// takes the panel's font, ink tokens and sticky toolbar. Callers pass raw
// facts — the panel derives the share code from the slug.
export interface PanelTitle {
  name: string;
  authorName?: string | null;
  /** The project's public slug; the row shows its 6-char prefix. */
  slug?: string | null;
  /** Where the row's "Editor" button links — the project's /p/<slug>
   *  editor page. Absent → no button. The caller supplies it rather
   *  than the panel deriving it from the slug: lib/live-viewer is
   *  bundled into exported standalone apps, which don't host the
   *  editor and mustn't learn its routes. */
  editorHref?: string | null;
}

// Share-code length — what the old corner badge showed (`#5umpiy`).
const SHARE_CODE_LEN = 6;

export interface ControlPanelProps {
  manifest: ExportManifest;
  paramValues: Map<string, Record<string, unknown>>;
  drivenParams: Set<string>;
  onParamChange: (ref: ParamRef, value: unknown) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onReset: () => void;
  time: number;
  // Transport extras (2026-08-17): the default scrub slider (rendered
  // when the project loops) and the render-resolution scale. Handlers
  // are optional so the designer preview can render them inert.
  loopSecs?: number | null;
  onSeek?: (timeSec: number) => void;
  renderScale?: number;
  onRenderScale?: (scale: number) => void;
  // Viewer export (081426_live-link-designer.md M3). WHICH buttons render
  // comes from manifest.design.export (so the designer preview shows them
  // too); the handlers are optional per mode — absent handler = an inert
  // button (the preview's case).
  exportHandlers?: {
    image?: () => void;
    video?: () => void;
    gif?: () => void;
  };
  exportStatus?: { label: string; cancel?: () => void } | null;
  // Active-branch filter (engine/active-branch.ts): node ids on the path
  // that is rendering right now. Rows — controls AND file inputs — on a
  // Switch branch the pick isn't showing are hidden entirely; the pick
  // that brings the branch back brings its rows back. Absent ⇒ every row
  // shows (the pre-filter panel).
  activeNodeIds?: ReadonlySet<string>;
  // Patch identity row above the transport. /live passes it (name, author,
  // slug); the designer preview passes what the editor knows so the chrome
  // matches; the exported app has no author or slug and passes nothing,
  // which renders no row — its panel is unchanged.
  title?: PanelTitle;
  // On-canvas handles (091726_live-gizmos.md): which manifest gizmos the
  // visitor has switched ON (absent / empty = all hidden, the load default)
  // and the row toggle. The designer preview passes ephemeral state.
  shownGizmos?: ReadonlySet<string>;
  onToggleGizmo?: (nodeId: string, visible: boolean) => void;
  // Pan / zoom control (091826_live-pan-zoom.md): the title-row button that
  // switches the visitor's canvas pan/zoom on and off. Rendered when
  // manifest.design.layout.panZoom is set; the host owns the state (the
  // viewer and the designer preview each bind the gestures themselves).
  panZoomOn?: boolean;
  onTogglePanZoom?: () => void;
}

function paramKey(nodeId: string, paramName: string) {
  return `${nodeId}::${paramName}`;
}

// A row of the Controls section: a param knob, or the visibility toggle of
// one shipped on-canvas GUI (091726_live-gizmos.md). `ref` is the design
// ref both `controls.order` and `controls.labels` key on.
type ControlsEntry =
  | { kind: "gizmo"; ref: string; gizmo: ExportManifestGizmo }
  | { kind: "control"; ref: string; control: ExportManifestControl };

export function ControlPanel(props: ControlPanelProps) {
  const {
    manifest,
    paramValues,
    drivenParams,
    onParamChange,
    playing,
    onTogglePlay,
    onReset,
    time,
    loopSecs,
    onSeek,
    renderScale,
    onRenderScale,
    exportHandlers,
    exportStatus,
    activeNodeIds,
    title,
    shownGizmos,
    onToggleGizmo,
    panZoomOn,
    onTogglePanZoom,
  } = props;

  const getValue = useCallback(
    (nodeId: string, paramName: string): unknown => {
      return paramValues.get(nodeId)?.[paramName];
    },
    [paramValues]
  );

  // Design-block ordering + renames (081426_live-link-designer.md M1).
  // One order list spans both sections; each section sorts its own
  // members by index in it. Absent design → manifest order, no renames.
  const design = manifest.design;
  // The author's per-link switch for the pan/zoom button (design block).
  const panZoomAvailable = design?.layout.panZoom === true;
  const fileInputs = useMemo(
    () =>
      orderControlRefs(
        manifest.fileInputs.filter(
          (fi) => !activeNodeIds || activeNodeIds.has(fi.nodeId)
        ),
        (fi) => paramKey(fi.nodeId, fi.paramName),
        design
      ),
    [manifest.fileInputs, design, activeNodeIds]
  );
  // The Controls section holds the param knobs AND the gizmo visibility
  // rows (091726_live-gizmos.md) under ONE order, so the author can park a
  // node's "Handles" toggle beside its sliders. No order → gizmo rows
  // first, then knobs, each in manifest order.
  const controls = useMemo(() => {
    const onBranch = (nodeId: string) =>
      !activeNodeIds || activeNodeIds.has(nodeId);
    const entries: ControlsEntry[] = [
      ...(manifest.gizmos ?? [])
        .filter((g) => onBranch(g.nodeId))
        .map((g) => ({
          kind: "gizmo" as const,
          ref: gizmoControlRef(g.nodeId),
          gizmo: g,
        })),
      ...manifest.controls
        .filter((c) => onBranch(c.nodeId))
        .map((c) => ({
          kind: "control" as const,
          ref: paramKey(c.nodeId, c.paramName),
          control: c,
        })),
    ];
    return orderControlRefs(entries, (e) => e.ref, design);
  }, [manifest.gizmos, manifest.controls, design, activeNodeIds]);

  const exportFlags = design?.export;
  const anyExport =
    !!exportFlags &&
    (exportFlags.image || exportFlags.video || exportFlags.gif);
  const exportBusy = !!exportStatus?.cancel;

  return (
    <aside className="sidebar">
      {/* `toolbar` pins this section to the top of the scrolling panel
          (styles.css) so the transport / resolution / export controls stay
          reachable while a long control list scrolls underneath. */}
      <div className="section toolbar">
        {/* The identity row also hosts the pan/zoom button, so it renders
            for a title OR for the button alone (the exported app passes no
            title but can still carry the button). */}
        {(title || panZoomAvailable) && (
          <PanelTitleRow
            title={title}
            panZoom={
              panZoomAvailable
                ? { on: !!panZoomOn, onToggle: onTogglePanZoom }
                : undefined
            }
          />
        )}
        {/* Same order, icons and geometry as the editor's PlaybackBar
            TransportButtons (reset, then play); `tr-btn` / `is-on` are
            what styles.css and the transport packs (design-presets.css,
            data-transport) style. */}
        <div className="transport">
          <button
            className="tr-btn"
            onClick={onReset}
            aria-label="Reset"
            title="Reset to start"
          >
            <ResetIcon />
          </button>
          <button
            className={playing ? "tr-btn is-on" : "tr-btn"}
            onClick={onTogglePlay}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="time">{time.toFixed(2)}s</span>
        </div>
        {/* Scrub + resolution ride the SAME bar slider the param rows use,
            so the slider pack (data-slider) styles them too — a native
            range here kept the stock dot-on-line chrome whatever the pack. */}
        {loopSecs != null && loopSecs > 0 && (
          <div className="scrub">
            <MiniBarSlider
              value={Math.min(time, loopSecs)}
              min={0}
              max={loopSecs}
              step={0.01}
              onChange={(v) => onSeek?.(v)}
              title="Seek"
            />
          </div>
        )}
        <div className="res-row">
          <span className="res-label">Resolution</span>
          <MiniBarSlider
            value={renderScale ?? 1}
            min={0.25}
            max={1}
            step={0.05}
            onChange={(v) => onRenderScale?.(v)}
            title="Render resolution"
          />
          <span className="res-value">
            {Math.round((renderScale ?? 1) * 100)}%
          </span>
        </div>
        {anyExport && (
          <div className="export-row">
            {exportFlags.image && (
              <button onClick={exportHandlers?.image} disabled={exportBusy}>
                Image
              </button>
            )}
            {exportFlags.video && (
              <button onClick={exportHandlers?.video} disabled={exportBusy}>
                Video
              </button>
            )}
            {exportFlags.gif && (
              <button onClick={exportHandlers?.gif} disabled={exportBusy}>
                GIF
              </button>
            )}
          </div>
        )}
        {exportStatus && (
          <div className="export-status">
            <span>{exportStatus.label}</span>
            {exportStatus.cancel && (
              <button onClick={exportStatus.cancel} aria-label="Cancel export">
                ✕
              </button>
            )}
          </div>
        )}
        {exportBusy && (
          <div className="export-hint">
            Keep this tab visible while exporting.
          </div>
        )}
      </div>

      {fileInputs.length > 0 && (
        <div className="section">
          <div className="section-header">File Inputs</div>
          {fileInputs.map((fi) => (
            <FileInputRow
              key={paramKey(fi.nodeId, fi.paramName)}
              entry={fi}
              labelOverride={
                design?.controls.labels[paramKey(fi.nodeId, fi.paramName)]
              }
              value={getValue(fi.nodeId, fi.paramName)}
              onChange={(v) =>
                onParamChange({ nodeId: fi.nodeId, paramName: fi.paramName }, v)
              }
            />
          ))}
        </div>
      )}

      {controls.length > 0 && (
        <div className="section">
          <div className="section-header">Controls</div>
          {controls.map((e) =>
            e.kind === "gizmo" ? (
              <GizmoRow
                key={e.ref}
                entry={e.gizmo}
                labelOverride={design?.controls.labels[e.ref]}
                visible={!!shownGizmos?.has(e.gizmo.nodeId)}
                onToggle={(v) => onToggleGizmo?.(e.gizmo.nodeId, v)}
              />
            ) : (
              <ControlRow
                key={e.ref}
                entry={e.control}
                labelOverride={design?.controls.labels[e.ref]}
                value={getValue(e.control.nodeId, e.control.paramName)}
                driven={drivenParams.has(e.ref)}
                onChange={(v) =>
                  onParamChange(
                    {
                      nodeId: e.control.nodeId,
                      paramName: e.control.paramName,
                    },
                    v
                  )
                }
              />
            )
          )}
        </div>
      )}
    </aside>
  );
}

// Name on its own line (ellipsized — a 280px panel can't fit a long name
// beside the author), meta underneath, and on the right the pan/zoom
// button (091826_live-pan-zoom.md, when the design enables it) then a
// quiet "Editor" link when the caller has somewhere for it to go. Only the
// parts that exist render, so a not-yet-published project in the designer
// shows just its name, and the exported app (no title) shows just the
// button. The link is a plain same-tab anchor — the designer preview keeps
// anchors inert on its side (DesignerPreview).
function PanelTitleRow({
  title,
  panZoom,
}: {
  title?: PanelTitle;
  panZoom?: { on: boolean; onToggle?: () => void };
}) {
  const author = title?.authorName || null;
  const code = title?.slug ? title.slug.slice(0, SHARE_CODE_LEN) : null;
  return (
    <div className="panel-title">
      {title && (
        <div className="ident">
          <div className="name" title={title.name}>
            {title.name}
          </div>
          {(author || code) && (
            <div className="meta">
              {author && <span>by {author}</span>}
              {author && code && <span className="sep">·</span>}
              {code && <span className="code">#{code}</span>}
            </div>
          )}
        </div>
      )}
      {(panZoom || title?.editorHref) && (
        <div className="actions">
          {panZoom && (
            <button
              type="button"
              className="panzoom"
              aria-pressed={panZoom.on}
              aria-label="Pan and zoom the canvas"
              onClick={panZoom.onToggle}
              title={
                panZoom.on
                  ? "Pan & zoom is on — click to reset the view and switch it off"
                  : "Pan & zoom the canvas: scroll or two-finger drag to pan, pinch or ⌘/Ctrl-scroll to zoom (a mouse wheel zooms, middle-drag pans)"
              }
            >
              <PanZoomIcon />
            </button>
          )}
          {title?.editorHref && (
            <a
              className="editor-link"
              href={title.editorHref}
              title="Open this project in the editor"
            >
              Editor
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// Magnifier with a plus — "zoom" is the recognisable half of pan/zoom.
// currentColor so the button's idle / hover / pressed ink flows through.
function PanZoomIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.4" />
      <line
        x1="7.7"
        y1="7.7"
        x2="11"
        y2="11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="5"
        y1="3.3"
        x2="5"
        y2="6.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="3.3"
        y1="5"
        x2="6.7"
        y2="5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FileInputRow({
  entry,
  labelOverride,
  value,
  onChange,
}: {
  entry: ExportManifestFileInput;
  labelOverride?: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = labelOverride ?? `${entry.nodeName} — ${entry.label}`;
  return (
    <div className="row" data-type={entry.paramType}>
      <div className="label">{label}</div>
      {entry.paramType === "file" && (
        <ImageFileRow value={value} onChange={onChange} />
      )}
      {entry.paramType === "video_file" && (
        <VideoFileRow value={value} onChange={onChange} />
      )}
      {entry.paramType === "audio_file" && (
        <AudioFileRow value={value} onChange={onChange} />
      )}
      {entry.paramType === "svg_file" && (
        <SvgFileRow value={value} onChange={onChange} />
      )}
      {entry.paramType === "font" && (
        <FontFileRow value={value} onChange={onChange} />
      )}
      {entry.paramType === "model_file" && (
        <ModelFileRow value={value} onChange={onChange} />
      )}
    </div>
  );
}

function ImageFileRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="file-row">
      <input
        type="file"
        accept="image/*"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const bmp = await createImageBitmap(file);
          onChange(bmp);
        }}
      />
      {value ? <div className="meta">image loaded</div> : null}
    </div>
  );
}

function VideoFileRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const current = value as VideoFileParamValue | null | undefined;
  return (
    <div className="file-row">
      <input
        type="file"
        accept="video/*"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const v = await registerVideoFile(file);
          onChange(v);
        }}
      />
      {current?.filename && (
        <div className="meta">
          {current.filename} · {current.width}×{current.height} ·{" "}
          {current.duration?.toFixed(1)}s
        </div>
      )}
      {current && (
        <button
          className="clear"
          onClick={() => {
            disposeVideoFile(current);
            onChange(null);
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

function AudioFileRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const current = value as AudioFileParamValue | null | undefined;
  return (
    <div className="file-row">
      <input
        type="file"
        accept="audio/*"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const v = await registerAudioFile(file);
          onChange(v);
        }}
      />
      {current?.filename && (
        <div className="meta">
          {current.filename} · {current.duration?.toFixed(1)}s
        </div>
      )}
      {current && (
        <button
          className="clear"
          onClick={() => {
            disposeAudioFile(current);
            onChange(null);
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

// 3D model input (v11): with a cloud ref the value arrives pre-loaded
// from deserialize (the meta line shows it); the picker is the override,
// building the same lightweight value the editor's ModelFileControl does.
function ModelFileRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const current = value as
    import("@/engine/types").ModelFileParamValue | null | undefined;
  return (
    <div className="file-row">
      <input
        type="file"
        accept=".glb,.gltf,.obj,.stl,model/gltf-binary,model/gltf+json,model/stl"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const lower = file.name.toLowerCase();
          if (current?.url?.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(current.url);
            } catch {
              // already revoked
            }
          }
          onChange({
            url: URL.createObjectURL(file),
            filename: file.name,
            size: file.size,
            format: lower.endsWith(".obj")
              ? "obj"
              : lower.endsWith(".stl")
                ? "stl"
                : lower.endsWith(".gltf")
                  ? "gltf"
                  : "glb",
          } satisfies import("@/engine/types").ModelFileParamValue);
        }}
      />
      {current?.filename && <div className="meta">{current.filename}</div>}
    </div>
  );
}

function SvgFileRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const current = value as SvgFileParamValue | null | undefined;
  const subpathCount = current?.subpaths?.length ?? 0;
  return (
    <div className="file-row">
      <input
        type="file"
        accept=".svg,image/svg+xml"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const text = await file.text();
            const parsed = parseSvg(text, file.name);
            onChange(parsed);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("SVG parse failed:", err);
            alert(
              "Failed to parse SVG: " +
                (err instanceof Error ? err.message : String(err))
            );
          }
        }}
      />
      {current?.filename && (
        <div className="meta">
          {current.filename} · {subpathCount} subpath
          {subpathCount === 1 ? "" : "s"}
        </div>
      )}
      {current && (
        <button className="clear" onClick={() => onChange(null)}>
          clear
        </button>
      )}
    </div>
  );
}

function FontFileRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const current = value as FontParamValue | null | undefined;
  return (
    <div className="file-row">
      <input
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const registered = await registerCustomFont(file);
          onChange(registered);
        }}
      />
      {current?.family && (
        <div className="meta">loaded: {current.filename ?? current.family}</div>
      )}
      {current && (
        <button className="clear" onClick={() => onChange(null)}>
          clear
        </button>
      )}
    </div>
  );
}

function ControlRow({
  entry,
  labelOverride,
  value,
  driven,
  onChange,
}: {
  entry: ExportManifestControl;
  labelOverride?: string;
  value: unknown;
  driven: boolean;
  onChange: (v: unknown) => void;
}) {
  const label = labelOverride ?? `${entry.nodeName} — ${entry.label}`;
  // data-type lets a style preset re-lay-out ONE kind of row (the
  // "inline" dropdown pack turns enum rows into label-left / value-right
  // cards) without touching the others — see design-presets.css.
  return (
    <div
      className={`row${driven ? " driven" : ""}`}
      data-type={entry.paramType}
    >
      <div className="label">
        <span>{label}</span>
        {driven && <span className="driven-badge">DRIVEN</span>}
      </div>
      {/* Reuse the editor's exact param UI. We deliberately pass none of the
          editor-only affordances (no keyframe diamond/eye, expose icon,
          control toggle, or `layerAnim` for per-item keyframing) — those only
          render when their props are supplied, so omitting them strips them.
          A wire-driven param can't be hand-set, so we disable interaction. */}
      <div
        className="control-host"
        style={driven ? { opacity: 0.5, pointerEvents: "none" } : undefined}
      >
        <ParamControl param={entry.def} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

// Visibility toggle for one shipped on-canvas GUI (091726_live-gizmos.md).
// Inline — label left, pill right (styles.css `[data-type="gizmo"]`) — so
// it reads as a switch, not a knob; the pill is the shared boolean control,
// so the packs' tokens apply. "Handles" is the default noun; the designer
// renames it like any row.
function GizmoRow({
  entry,
  labelOverride,
  visible,
  onToggle,
}: {
  entry: ExportManifestGizmo;
  labelOverride?: string;
  visible: boolean;
  onToggle: (visible: boolean) => void;
}) {
  const label = labelOverride ?? `${entry.nodeName} — Handles`;
  return (
    <div className="row" data-type="gizmo">
      <div className="label">
        <span>{label}</span>
      </div>
      <div
        className="control-host"
        title={
          visible
            ? "Hide these handles on the canvas"
            : "Show these handles on the canvas"
        }
      >
        <TogglePill on={visible} onChange={onToggle} />
      </div>
    </div>
  );
}

// Transport glyphs — verbatim copies of the editor's PlaybackBar icons
// (components/effects/PlaybackBar.tsx PlayIcon / PauseIcon / ResetIcon;
// keep in sync). Copied rather than imported: the export template has no
// alias for the editor component tree. currentColor so the button's
// hover / playing color flows through.
function PlayIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden>
      <path
        d="M1.5 1 L8.5 6 L1.5 11 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden>
      <line
        x1="3"
        y1="1.5"
        x2="3"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <line
        x1="7"
        y1="1.5"
        x2="7"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <line
        x1="2"
        y1="1.5"
        x2="2"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M10 1.5 L4 6 L10 10.5 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
