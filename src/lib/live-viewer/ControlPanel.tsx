"use client";

import { useCallback, useMemo } from "react";
import type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
} from "./manifest-types";
import { orderControlRefs } from "./design";
import { ParamControl } from "@/lib/param-controls";
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
}

function paramKey(nodeId: string, paramName: string) {
  return `${nodeId}::${paramName}`;
}

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
  const fileInputs = useMemo(
    () =>
      orderControlRefs(
        manifest.fileInputs,
        (fi) => paramKey(fi.nodeId, fi.paramName),
        design
      ),
    [manifest.fileInputs, design]
  );
  const controls = useMemo(
    () =>
      orderControlRefs(
        manifest.controls,
        (c) => paramKey(c.nodeId, c.paramName),
        design
      ),
    [manifest.controls, design]
  );

  const exportFlags = design?.export;
  const anyExport =
    !!exportFlags &&
    (exportFlags.image || exportFlags.video || exportFlags.gif);
  const exportBusy = !!exportStatus?.cancel;

  return (
    <aside className="sidebar">
      <div className="section">
        <div className="transport">
          <button
            onClick={onTogglePlay}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <button onClick={onReset} aria-label="Reset">
            ⏮
          </button>
          <span className="time">{time.toFixed(2)}s</span>
        </div>
        {loopSecs != null && loopSecs > 0 && (
          <input
            className="scrub"
            type="range"
            min={0}
            max={loopSecs}
            step={0.01}
            value={Math.min(time, loopSecs)}
            onChange={(e) => onSeek?.(Number(e.target.value))}
            aria-label="Seek"
          />
        )}
        <div className="res-row">
          <span className="res-label">Resolution</span>
          <input
            type="range"
            min={0.25}
            max={1}
            step={0.05}
            value={renderScale ?? 1}
            onChange={(e) => onRenderScale?.(Number(e.target.value))}
            aria-label="Render resolution"
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
                onParamChange(
                  { nodeId: fi.nodeId, paramName: fi.paramName },
                  v
                )
              }
            />
          ))}
        </div>
      )}

      {controls.length > 0 && (
        <div className="section">
          <div className="section-header">Controls</div>
          {controls.map((c) => (
            <ControlRow
              key={paramKey(c.nodeId, c.paramName)}
              entry={c}
              labelOverride={
                design?.controls.labels[paramKey(c.nodeId, c.paramName)]
              }
              value={getValue(c.nodeId, c.paramName)}
              driven={drivenParams.has(paramKey(c.nodeId, c.paramName))}
              onChange={(v) =>
                onParamChange({ nodeId: c.nodeId, paramName: c.paramName }, v)
              }
            />
          ))}
        </div>
      )}
    </aside>
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
    <div className="row">
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
    | import("@/engine/types").ModelFileParamValue
    | null
    | undefined;
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
  return (
    <div className={`row${driven ? " driven" : ""}`}>
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
        style={
          driven ? { opacity: 0.5, pointerEvents: "none" } : undefined
        }
      >
        <ParamControl param={entry.def} value={value} onChange={onChange} />
      </div>
    </div>
  );
}
