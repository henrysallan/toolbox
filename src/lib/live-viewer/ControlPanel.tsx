"use client";

import { useCallback } from "react";
import type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
} from "./manifest-types";
import { ExportParamControl } from "./ExportParamControl";
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
  } = props;

  const getValue = useCallback(
    (nodeId: string, paramName: string): unknown => {
      return paramValues.get(nodeId)?.[paramName];
    },
    [paramValues]
  );

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
      </div>

      {manifest.fileInputs.length > 0 && (
        <div className="section">
          <div className="section-header">File Inputs</div>
          {manifest.fileInputs.map((fi) => (
            <FileInputRow
              key={paramKey(fi.nodeId, fi.paramName)}
              entry={fi}
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

      {manifest.controls.length > 0 && (
        <div className="section">
          <div className="section-header">Controls</div>
          {manifest.controls.map((c) => (
            <ControlRow
              key={paramKey(c.nodeId, c.paramName)}
              entry={c}
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
  value,
  onChange,
}: {
  entry: ExportManifestFileInput;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = `${entry.nodeName} — ${entry.label}`;
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
  value,
  driven,
  onChange,
}: {
  entry: ExportManifestControl;
  value: unknown;
  driven: boolean;
  onChange: (v: unknown) => void;
}) {
  const label = `${entry.nodeName} — ${entry.label}`;
  return (
    <div className={`row${driven ? " driven" : ""}`}>
      <div className="label">
        <span>{label}</span>
        {driven && <span className="driven-badge">DRIVEN</span>}
      </div>
      <div className="control-host">
        <ExportParamControl
          param={entry.def}
          value={value}
          onChange={onChange}
          disabled={driven}
        />
      </div>
    </div>
  );
}
