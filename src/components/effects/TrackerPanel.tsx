"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { PointTrack, PointTrackerData } from "@/engine/types";
import { useClock } from "@/state/playback-clock";
import {
  asPointTrackerData,
  clearRange,
  removeTrack,
  reorderTracks,
  replaceTrackSamples,
  updateTrack,
  type ClearMode,
} from "@/engine/tracking/track-data";
import { detectSpikes, fillGaps, repairSpikes } from "@/engine/tracking/filters";
import { trackColor, trackToArrays } from "@/engine/tracking/sample";
import {
  setTrackerSelection,
  toggleTrackerSelection,
  useTrackerSelection,
} from "@/state/tracker-selection";

export type TrackingRunSpec = number | "toEnd" | "toStart" | "regrab";

interface Props {
  node: Node<NodeDataPayload>;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
  runTrackingSession?: (
    nodeId: string,
    dir: 1 | -1,
    n: TrackingRunSpec
  ) => Promise<void>;
  cancelTrackingSession?: () => void;
  trackingBusy?: boolean;
  sceneFrames?: number;
  canvasRes?: [number, number];
}

function targetIds(data: PointTrackerData, selected: number[]): number[] {
  if (selected.length > 0) return selected;
  return data.tracks.filter((t) => t.enabled).map((t) => t.id);
}

export default function TrackerPanel({
  node,
  onParamChange,
  runTrackingSession,
  cancelTrackingSession,
  trackingBusy,
  sceneFrames,
  canvasRes,
}: Props) {
  const frame = useClock((s) => s.frame);
  const data = asPointTrackerData(node.data.params.tracks);
  const selected = useTrackerSelection(node.id);
  const [spikeThresh, setSpikeThresh] = useState(3.5);
  const [clearOpen, setClearOpen] = useState(false);
  const dragId = useRef<number | null>(null);

  const targets = targetIds(data, selected);
  const targetLabel =
    selected.length > 0
      ? `${selected.length} selected`
      : `${targets.length} enabled`;

  const stats = useMemo(() => summarize(data, selected), [data, selected]);
  const spikeCount = useMemo(() => {
    let n = 0;
    let tracksHit = 0;
    for (const id of targets) {
      const t = data.tracks.find((tr) => tr.id === id);
      if (!t) continue;
      const hits = detectSpikes(trackToArrays(t), spikeThresh);
      if (hits.length) {
        n += hits.length;
        tracksHit++;
      }
    }
    return { n, tracksHit };
  }, [data, targets, spikeThresh]);

  const write = (next: PointTrackerData, key?: string) =>
    onParamChange(node.id, "tracks", next, key);

  const run = (dir: 1 | -1, n: TrackingRunSpec) => {
    void runTrackingSession?.(node.id, dir, n);
  };

  const sceneEnd = Math.max(1, Math.round(sceneFrames ?? 61)) - 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          color: "var(--tb-n-12)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        {stats.tracks} track{stats.tracks === 1 ? "" : "s"}
        {selected.length > 0 ? ` (${selected.length} selected)` : ""}
        {" · "}
        {stats.sampled}/{sceneEnd + 1} frames
        {" · "}
        {stats.lost} lost
        {" · "}
        conf {stats.conf.toFixed(2)}
        {canvasRes ? ` · ${canvasRes[0]}×${canvasRes[1]}` : ""}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <SmallButton
          label="All"
          disabled={data.tracks.length === 0}
          onClick={() =>
            setTrackerSelection(
              node.id,
              data.tracks.map((t) => t.id)
            )
          }
        />
        <SmallButton
          label="None"
          disabled={selected.length === 0}
          onClick={() => setTrackerSelection(node.id, [])}
        />
        <div style={{ flex: 1 }} />
        <SmallButton
          label="Add track"
          disabled={!!trackingBusy}
          onClick={() => onParamChange(node.id, "place_mode", true)}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {data.tracks.length === 0 && (
          <div style={{ color: "var(--tb-n-10)", fontSize: 11, padding: "6px 0" }}>
            No tracks — Add track, then click the preview.
          </div>
        )}
        {data.tracks.map((t, i) => (
          <TrackRow
            key={t.id}
            track={t}
            color={trackColor(i)}
            selected={selected.includes(t.id)}
            onSelect={(additive) => toggleTrackerSelection(node.id, t.id, additive)}
            onRename={(name) => write(updateTrack(data, t.id, { name }))}
            onEnable={(enabled) => write(updateTrack(data, t.id, { enabled }))}
            onOffset={(offset) =>
              write(updateTrack(data, t.id, { offset }), `tracks:${node.id}:offset:${t.id}`)
            }
            onRemove={() => {
              write(removeTrack(data, t.id));
              setTrackerSelection(
                node.id,
                selected.filter((id) => id !== t.id)
              );
            }}
            onDragStart={() => {
              dragId.current = t.id;
            }}
            onDrop={() => {
              const from = dragId.current;
              dragId.current = null;
              if (from == null || from === t.id) return;
              const order = data.tracks.map((tr) => tr.id);
              const fi = order.indexOf(from);
              const ti = order.indexOf(t.id);
              if (fi < 0 || ti < 0) return;
              order.splice(fi, 1);
              order.splice(ti, 0, from);
              write(reorderTracks(data, order));
            }}
          />
        ))}
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        <SmallButton
          label="⏮"
          title={`Track to start (${targetLabel})`}
          disabled={!runTrackingSession || trackingBusy || targets.length === 0 || frame <= 0}
          onClick={() => run(-1, "toStart")}
        />
        <SmallButton
          label="◀"
          title={`Back one frame (${targetLabel})`}
          disabled={!runTrackingSession || trackingBusy || targets.length === 0 || frame <= 0}
          onClick={() => run(-1, 1)}
        />
        <SmallButton
          label="▶"
          title={`Forward one frame (${targetLabel})`}
          disabled={!runTrackingSession || trackingBusy || targets.length === 0 || frame >= sceneEnd}
          onClick={() => run(1, 1)}
        />
        <SmallButton
          label="⏭"
          title={`Track to end (${targetLabel})`}
          disabled={!runTrackingSession || trackingBusy || targets.length === 0 || frame >= sceneEnd}
          onClick={() => run(1, "toEnd")}
        />
        {trackingBusy && (
          <SmallButton
            label="⏸"
            title="Stop tracking"
            disabled={false}
            onClick={() => cancelTrackingSession?.()}
          />
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <SmallButton
          label="Regrab here"
          disabled={trackingBusy || targets.length === 0}
          title="Re-grab the pattern from the current frame"
          onClick={() => run(1, "regrab")}
        />
        <div style={{ position: "relative" }}>
          <SmallButton
            label="Clear ▾"
            disabled={trackingBusy || targets.length === 0}
            onClick={() => setClearOpen((v) => !v)}
          />
          {clearOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                zIndex: 5,
                background: "var(--tb-n-2)",
                border: "1px solid var(--tb-n-7)",
                borderRadius: 4,
                padding: 4,
                minWidth: 140,
              }}
            >
              {(
                [
                  ["all", "All samples"],
                  ["after", "After playhead"],
                  ["before", "Before playhead"],
                  ["lost", "Lost frames only"],
                ] as [ClearMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    write(clearRange(data, targets, mode, frame));
                    setClearOpen(false);
                  }}
                  style={menuBtn}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <SmallButton
          label={`Fix spikes${spikeCount.n ? ` (${spikeCount.n})` : ""}`}
          disabled={trackingBusy || spikeCount.n === 0}
          title={
            spikeCount.n
              ? `Would fix ${spikeCount.n} frames in ${spikeCount.tracksHit} tracks`
              : "No spikes above threshold"
          }
          onClick={() => {
            let next = data;
            for (const id of targets) {
              const t = next.tracks.find((tr) => tr.id === id);
              if (!t) continue;
              const arrays = trackToArrays(t);
              const hits = detectSpikes(arrays, spikeThresh);
              if (!hits.length) continue;
              const repaired = repairSpikes(arrays, hits);
              next = replaceTrackSamples(next, id, {
                ...t,
                ...repaired,
                status: repaired.status as PointTrack["status"],
              });
            }
            write(next);
          }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--tb-n-11)" }}>
          thr
          <input
            type="range"
            min={2}
            max={8}
            step={0.1}
            value={spikeThresh}
            onChange={(e) => setSpikeThresh(Number(e.target.value))}
            style={{ width: 64 }}
          />
        </label>
        <SmallButton
          label="Fill gaps"
          disabled={trackingBusy || targets.length === 0}
          onClick={() => {
            let next = data;
            for (const id of targets) {
              const t = next.tracks.find((tr) => tr.id === id);
              if (!t) continue;
              const filled = fillGaps(trackToArrays(t), 12);
              next = replaceTrackSamples(next, id, {
                ...t,
                ...filled,
                status: filled.status as PointTrack["status"],
              });
            }
            write(next);
          }}
        />
      </div>
    </div>
  );
}

function summarize(data: PointTrackerData, selected: number[]) {
  const rows = selected.length
    ? data.tracks.filter((t) => selected.includes(t.id))
    : data.tracks;
  let sampled = 0;
  let lost = 0;
  let confSum = 0;
  let confN = 0;
  const frames = new Set<number>();
  for (const t of rows) {
    for (let i = 0; i < t.frames.length; i++) {
      frames.add(t.frames[i]!);
      if (t.status[i] === 3 || t.status[i] === 4) lost++;
      confSum += t.conf[i] ?? 0;
      confN++;
    }
  }
  sampled = frames.size;
  return {
    tracks: rows.length,
    sampled,
    lost,
    conf: confN ? confSum / confN : 0,
  };
}

function TrackRow({
  track,
  color,
  selected,
  onSelect,
  onRename,
  onEnable,
  onOffset,
  onRemove,
  onDragStart,
  onDrop,
}: {
  track: PointTrack;
  color: string;
  selected: boolean;
  onSelect: (additive: boolean) => void;
  onRename: (name: string) => void;
  onEnable: (enabled: boolean) => void;
  onOffset: (offset: [number, number]) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const lost = track.status.filter((s) => s === 3 || s === 4).length;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={(e) => onSelect(e.shiftKey || e.metaKey)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 6px",
        borderRadius: 3,
        background: selected ? "var(--tb-n-4)" : "transparent",
        border: `1px solid ${selected ? "var(--tb-n-7)" : "transparent"}`,
        cursor: "default",
        fontSize: 11,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 8,
          background: color,
          flexShrink: 0,
        }}
      />
      <input
        type="checkbox"
        checked={track.enabled}
        onChange={(e) => {
          e.stopPropagation();
          onEnable(e.target.checked);
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {editing ? (
        <input
          autoFocus
          defaultValue={track.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            onRename(e.target.value.trim() || track.name);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--tb-n-1)",
            border: "1px solid var(--tb-n-7)",
            color: "var(--tb-n-16)",
            fontSize: 11,
            padding: "1px 4px",
          }}
        />
      ) : (
        <span
          style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {track.name}
        </span>
      )}
      <span style={{ color: "var(--tb-n-11)", fontSize: 10, flexShrink: 0 }}>
        {track.frames.length}
        {lost ? ` / ${lost} lost` : ""}
      </span>
      <Sparkline conf={track.conf} status={track.status} color={color} />
      <Num
        value={track.offset[0]}
        onChange={(v) => onOffset([v, track.offset[1]])}
        label="ox"
      />
      <Num
        value={track.offset[1]}
        onChange={(v) => onOffset([track.offset[0], v])}
        label="oy"
      />
      <button
        type="button"
        title="Remove track"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        style={{
          background: "none",
          border: "none",
          color: "var(--tb-n-10)",
          cursor: "pointer",
          padding: "0 2px",
          fontSize: 12,
        }}
      >
        ×
      </button>
    </div>
  );
}

function Sparkline({
  conf,
  status,
  color,
}: {
  conf: number[];
  status: number[];
  color: string;
}) {
  const w = 48;
  const h = 14;
  if (conf.length < 2) {
    return <span style={{ width: w, height: h, display: "inline-block" }} />;
  }
  const pts = conf
    .map((c, i) => {
      const x = (i / (conf.length - 1)) * (w - 2) + 1;
      const y = h - 1 - Math.max(0, Math.min(1, c)) * (h - 2);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} style={{ flexShrink: 0 }}>
      <polyline fill="none" stroke={color} strokeWidth={1} points={pts} />
      {status.map((s, i) =>
        s === 3 || s === 4 ? (
          <circle
            key={i}
            cx={(i / (conf.length - 1)) * (w - 2) + 1}
            cy={h - 1 - Math.max(0, Math.min(1, conf[i] ?? 0)) * (h - 2)}
            r={1.2}
            fill="#f87171"
          />
        ) : null
      )}
    </svg>
  );
}

function Num({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <input
      type="number"
      step={0.001}
      value={Number.isFinite(value) ? value : 0}
      title={label}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      style={{
        width: 42,
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-7)",
        color: "var(--tb-n-14)",
        fontSize: 10,
        padding: "1px 2px",
      }}
    />
  );
}

function SmallButton({
  label,
  disabled,
  onClick,
  title,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "3px 8px",
        background: "transparent",
        border: "1px solid var(--tb-n-9)",
        color: disabled ? "var(--tb-n-10)" : "var(--tb-n-13)",
        fontFamily: "inherit",
        fontSize: 10,
        borderRadius: 3,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

const menuBtn: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  color: "var(--tb-n-13)",
  fontSize: 11,
  padding: "4px 8px",
  cursor: "pointer",
};
