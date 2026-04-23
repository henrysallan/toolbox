"use client";

import type { Node } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { getNodeDef } from "@/engine/registry";
import { paramSocketType } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";
import type { ParamDef } from "@/engine/types";
import LoadGrid from "./LoadGrid";
import {
  COLOR_RAMP_MAX_STOPS,
  newStopId,
  type ColorRampStop,
} from "@/nodes/effect/color-ramp";
import {
  BLEND_MODE_ORDER,
  blendModeLabel,
} from "@/nodes/effect/merge";
import {
  CURVE_CHANNELS,
  computeMonotoneTangents,
  defaultCurveChannel,
  defaultCurvesValue,
  evalMonotoneCubic,
  newCurvePointId,
  sanitizeCurvesValue,
  type CurveChannel,
  type CurvesValue,
} from "@/nodes/effect/color-correction";

interface Props {
  nodes: Node<NodeDataPayload>[];
  selectedId: string | null;
  // Which view the panel shows. "project" renders project-wide settings
  // (resolution, etc.); "node" renders params for the selected node;
  // "load" renders a grid of saved projects for the signed-in user.
  mode: "project" | "node" | "load";
  canvasRes: [number, number];
  onCanvasResChange: (res: [number, number]) => void;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  onToggleParamExposed: (nodeId: string, paramName: string) => void;
  // Returns true when an exposed param currently has an incoming edge
  // driving it. The row is rendered read-only with a "driven" indicator.
  isParamDriven: (nodeId: string, paramName: string) => boolean;
  signedIn?: boolean;
  // Clicking a project thumbnail triggers load in the parent.
  onLoadProject?: (id: string) => void;
  // Bumped by the parent after save/delete so LoadGrid refetches.
  loadRefreshKey?: number;
}

const RES_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: "512 × 512", w: 512, h: 512 },
  { label: "1024 × 1024", w: 1024, h: 1024 },
  { label: "2048 × 2048", w: 2048, h: 2048 },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "3840 × 2160", w: 3840, h: 2160 },
];

export default function ParamPanel({
  nodes,
  selectedId,
  mode,
  canvasRes,
  onCanvasResChange,
  onParamChange,
  onToggleParamExposed,
  isParamDriven,
  signedIn,
  onLoadProject,
  loadRefreshKey,
}: Props) {
  const selected = selectedId
    ? nodes.find((n) => n.id === selectedId)
    : undefined;
  const def = selected ? getNodeDef(selected.data.defType) : undefined;

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        padding: 12,
        background: "#0a0a0a",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      }}
    >
      {mode === "project" ? (
        <ProjectSettings
          canvasRes={canvasRes}
          onCanvasResChange={onCanvasResChange}
        />
      ) : mode === "load" ? (
        <Section label="load project">
          <LoadGrid
            signedIn={!!signedIn}
            onLoad={(id) => onLoadProject?.(id)}
            refreshKey={loadRefreshKey}
          />
        </Section>
      ) : selected && def ? (
        <Section label={`${def.name} · parameters`}>
          {(() => {
            const exposedSet = new Set(selected.data.exposedParams ?? []);
            const visible = def.params.filter((p) => {
              if (p.hidden) return false;
              // Always show exposed params so the user can reach them to
              // un-expose, even when `visibleIf` would otherwise hide them.
              if (exposedSet.has(p.name)) return true;
              return p.visibleIf?.(selected.data.params) ?? true;
            });
            if (visible.length === 0) {
              return <div style={{ color: "#52525b" }}>(no parameters)</div>;
            }
            return visible.map((p) => {
              const exposable = paramSocketType(p.type) !== null;
              const isExposed = exposedSet.has(p.name);
              const driven = isExposed && isParamDriven(selected.id, p.name);
              return (
                <ParamRow
                  key={p.name}
                  param={p}
                  value={selected.data.params[p.name]}
                  onChange={(v) => onParamChange(selected.id, p.name, v)}
                  exposed={isExposed}
                  exposable={exposable}
                  driven={driven}
                  onToggleExposed={
                    exposable
                      ? () => onToggleParamExposed(selected.id, p.name)
                      : undefined
                  }
                />
              );
            });
          })()}
        </Section>
      ) : (
        <div style={{ color: "#52525b" }}>Select a node to edit parameters.</div>
      )}
    </div>
  );
}

function ProjectSettings({
  canvasRes,
  onCanvasResChange,
}: {
  canvasRes: [number, number];
  onCanvasResChange: (res: [number, number]) => void;
}) {
  const resKey = `${canvasRes[0]}×${canvasRes[1]}`;
  const isPreset = RES_PRESETS.some((r) => `${r.w}×${r.h}` === resKey);

  return (
    <Section label="project settings">
      <div
        style={{
          padding: 8,
          background: "#111113",
          border: "1px solid #1f1f23",
          borderRadius: 4,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <span style={{ color: "#d4d4d8" }}>resolution</span>
        <select
          value={isPreset ? resKey : "__custom__"}
          onChange={(e) => {
            if (e.target.value === "__custom__") return;
            const [w, h] = e.target.value.split("×").map(Number);
            onCanvasResChange([w, h]);
          }}
          style={{
            background: "#0a0a0a",
            border: "1px solid #27272a",
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "2px 4px",
          }}
        >
          {RES_PRESETS.map((r) => (
            <option key={r.label} value={`${r.w}×${r.h}`}>
              {r.label}
            </option>
          ))}
          {!isPreset && (
            <option value="__custom__">
              {canvasRes[0]} × {canvasRes[1]} (custom)
            </option>
          )}
        </select>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ResInput
            value={canvasRes[0]}
            onCommit={(w) => onCanvasResChange([w, canvasRes[1]])}
          />
          <span style={{ color: "#52525b" }}>×</span>
          <ResInput
            value={canvasRes[1]}
            onCommit={(h) => onCanvasResChange([canvasRes[0], h])}
          />
        </div>
      </div>
    </Section>
  );
}

function ResInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.round(parseFloat(draft));
    if (!Number.isFinite(n) || n < 16 || n > 8192) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      value={draft}
      min={16}
      max={8192}
      step={1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        width: 72,
        background: "#0a0a0a",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "2px 4px",
      }}
    />
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          color: "#71717a",
          textTransform: "uppercase",
          letterSpacing: 1,
          fontSize: 10,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ParamRow({
  param,
  value,
  onChange,
  exposed,
  exposable,
  driven,
  onToggleExposed,
}: {
  param: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
  exposed?: boolean;
  exposable?: boolean;
  driven?: boolean;
  onToggleExposed?: () => void;
}) {
  const label = param.label ?? param.name;

  return (
    <div
      style={{
        marginBottom: 10,
        padding: 8,
        background: "#111113",
        border: `1px solid ${driven ? "#334155" : "#1f1f23"}`,
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            color: "#d4d4d8",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {label}
          {driven && (
            <span
              title="Driven by a connected input — stored value is ignored while connected"
              style={{
                color: "#93c5fd",
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              driven
            </span>
          )}
        </span>
        {exposable && onToggleExposed && (
          <button
            onClick={onToggleExposed}
            title={
              exposed
                ? "Remove the input socket for this parameter"
                : "Add an input socket for this parameter on the node"
            }
            style={{
              background: exposed ? "#1e3a8a" : "transparent",
              border: "1px solid #27272a",
              color: exposed ? "#bfdbfe" : "#71717a",
              fontSize: 9,
              padding: "1px 6px",
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {exposed ? "exposed" : "expose"}
          </button>
        )}
      </div>
      <div style={{ opacity: driven ? 0.5 : 1, pointerEvents: driven ? "none" : "auto" }}>
        <ParamControl param={param} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function ParamControl({
  param,
  value,
  onChange,
}: {
  param: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (param.type === "scalar") {
    const num = typeof value === "number" ? value : (param.default as number);
    // Slider uses softMax when provided so the user can type past it via the
    // number input without the slider pinning the stored value.
    const sliderMax = param.softMax ?? param.max ?? 1;
    const sliderMin = param.min ?? 0;
    const sliderValue = Math.max(sliderMin, Math.min(sliderMax, num));
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={param.step ?? 0.01}
          value={sliderValue}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          min={param.min}
          max={param.max}
          step={param.step ?? 0.01}
          value={num}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
          style={{
            width: 60,
            background: "#0a0a0a",
            border: "1px solid #27272a",
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "2px 4px",
          }}
        />
      </div>
    );
  }

  if (param.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  if (param.type === "string") {
    const current = typeof value === "string" ? value : (param.default as string);
    if (param.multiline) {
      return (
        <textarea
          value={current}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={3}
          style={{
            width: "100%",
            minHeight: 54,
            resize: "vertical",
            background: "#0a0a0a",
            border: "1px solid #27272a",
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "4px 6px",
            boxSizing: "border-box",
            lineHeight: 1.4,
          }}
        />
      );
    }
    return (
      <input
        type="text"
        value={current}
        placeholder={param.placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          width: "100%",
          background: "#0a0a0a",
          border: "1px solid #27272a",
          color: "#e5e7eb",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "2px 4px",
          boxSizing: "border-box",
        }}
      />
    );
  }

  if (param.type === "audio_file") {
    const current = value as
      | { filename?: string; duration?: number }
      | null
      | undefined;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="file"
          accept="audio/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const mod = await import("@/lib/audio");
            const v = await mod.registerAudioFile(file);
            onChange(v);
          }}
          style={{ color: "#e5e7eb", fontSize: 10 }}
        />
        {current?.filename && (
          <div style={{ color: "#71717a", fontSize: 10 }}>
            {current.filename} · {current.duration?.toFixed(1)}s
          </div>
        )}
        {current && (
          <button
            onClick={async () => {
              const { disposeAudioFile } = await import("@/lib/audio");
              disposeAudioFile(
                value as import("@/engine/types").AudioFileParamValue
              );
              onChange(null);
            }}
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 10,
              borderRadius: 3,
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            clear
          </button>
        )}
      </div>
    );
  }

  if (param.type === "video_file") {
    const current = value as
      | { filename?: string; duration?: number; width?: number; height?: number }
      | null
      | undefined;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="file"
          accept="video/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const mod = await import("@/lib/video");
            const { registerVideoFile } = mod;
            const v = await registerVideoFile(file);
            onChange(v);
          }}
          style={{ color: "#e5e7eb", fontSize: 10 }}
        />
        {current?.filename && (
          <div style={{ color: "#71717a", fontSize: 10 }}>
            {current.filename} · {current.width}×{current.height} ·{" "}
            {current.duration?.toFixed(1)}s
          </div>
        )}
        {current && (
          <button
            onClick={async () => {
              const { disposeVideoFile } = await import("@/lib/video");
              disposeVideoFile(
                value as import("@/engine/types").VideoFileParamValue
              );
              onChange(null);
            }}
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 10,
              borderRadius: 3,
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            clear
          </button>
        )}
      </div>
    );
  }

  if (param.type === "svg_file") {
    const current = value as
      | { filename?: string; subpaths?: unknown[]; aspect?: number }
      | null
      | undefined;
    const subpathCount = current?.subpaths?.length ?? 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="file"
          accept=".svg,image/svg+xml"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const { parseSvg } = await import("@/lib/svg-parse");
              const parsed = parseSvg(text, file.name);
              onChange(parsed);
            } catch (err) {
              // Surface the error but don't throw — invalid SVGs are a
              // common user mistake, not a crash condition.
              // eslint-disable-next-line no-console
              console.warn("SVG parse failed:", err);
              alert(
                "Failed to parse SVG: " +
                  (err instanceof Error ? err.message : String(err))
              );
            }
          }}
          style={{ color: "#e5e7eb", fontSize: 10 }}
        />
        {current?.filename && (
          <div style={{ color: "#71717a", fontSize: 10 }}>
            {current.filename} · {subpathCount} subpath
            {subpathCount === 1 ? "" : "s"}
            {current.aspect && ` · aspect ${current.aspect.toFixed(2)}`}
          </div>
        )}
        {current && (
          <button
            onClick={() => onChange(null)}
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 10,
              borderRadius: 3,
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            clear
          </button>
        )}
      </div>
    );
  }

  if (param.type === "font") {
    const current = value as
      | { family: string; filename?: string }
      | null
      | undefined;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const mod = await import("@/lib/fonts");
            const registered = await mod.registerCustomFont(file);
            onChange(registered);
          }}
          style={{ color: "#e5e7eb", fontSize: 10 }}
        />
        {current?.family && (
          <div style={{ color: "#71717a", fontSize: 10 }}>
            loaded: {current.filename ?? current.family}
          </div>
        )}
        {current && (
          <button
            onClick={() => onChange(null)}
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 10,
              borderRadius: 3,
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            clear
          </button>
        )}
      </div>
    );
  }

  if (param.type === "enum") {
    const options = param.options ?? [];
    const current = typeof value === "string" ? value : (param.default as string);
    return (
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "#0a0a0a",
          border: "1px solid #27272a",
          color: "#e5e7eb",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "2px 4px",
          width: "100%",
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (param.type === "color") {
    const hex = typeof value === "string" ? value : (param.default as string);
    return (
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", height: 24 }}
      />
    );
  }

  if (param.type === "file") {
    const hasValue = !!value;
    return (
      <div>
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const bmp = await createImageBitmap(file);
            onChange(bmp);
          }}
          style={{ color: "#e5e7eb", fontSize: 10 }}
        />
        {hasValue && (
          <div style={{ marginTop: 4, color: "#71717a", fontSize: 10 }}>
            image loaded
          </div>
        )}
      </div>
    );
  }

  if (param.type === "merge_layers") {
    const layers = Array.isArray(value)
      ? (value as Array<{ id: string; mode: string; opacity: number }>)
      : ((param.default as Array<{ id: string; mode: string; opacity: number }>) ?? []);
    const modes = BLEND_MODE_ORDER;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {layers.length === 0 && (
          <div style={{ color: "#52525b" }}>(no layers — use + on node)</div>
        )}
        {layers.map((l, i) => (
          <div
            key={l.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 6,
              border: "1px solid #27272a",
              borderRadius: 3,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ color: "#a1a1aa" }}>layer {i + 1}</span>
              <button
                onClick={() => {
                  const next = layers.filter((x) => x.id !== l.id);
                  onChange(next);
                }}
                title="Remove layer"
                style={{
                  background: "transparent",
                  border: "1px solid #3f3f46",
                  color: "#a1a1aa",
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                remove
              </button>
            </div>
            <select
              value={l.mode}
              onChange={(e) => {
                const next = layers.map((x) =>
                  x.id === l.id ? { ...x, mode: e.target.value } : x
                );
                onChange(next);
              }}
              style={{
                background: "#0a0a0a",
                border: "1px solid #27272a",
                color: "#e5e7eb",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "2px 4px",
                width: "100%",
              }}
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {blendModeLabel(m)}
                </option>
              ))}
            </select>
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span style={{ color: "#71717a", minWidth: 50 }}>opacity</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={l.opacity}
                onChange={(e) => {
                  const next = layers.map((x) =>
                    x.id === l.id
                      ? { ...x, opacity: parseFloat(e.target.value) }
                      : x
                  );
                  onChange(next);
                }}
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={l.opacity}
                onChange={(e) => {
                  const next = layers.map((x) =>
                    x.id === l.id
                      ? { ...x, opacity: parseFloat(e.target.value) }
                      : x
                  );
                  onChange(next);
                }}
                style={{
                  width: 56,
                  background: "#0a0a0a",
                  border: "1px solid #27272a",
                  color: "#e5e7eb",
                  fontFamily: "inherit",
                  fontSize: 11,
                  padding: "2px 4px",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (param.type === "color_ramp") {
    const stops = Array.isArray(value)
      ? (value as ColorRampStop[])
      : (param.default as ColorRampStop[]) ?? [];
    return (
      <ColorRampControl
        stops={stops}
        onChange={(next) => onChange(next)}
      />
    );
  }

  if (param.type === "curves") {
    const curves = sanitizeCurvesValue(value ?? param.default);
    return (
      <CurvesControl
        curves={curves}
        onChange={(next) => onChange(next)}
      />
    );
  }

  if (
    param.type === "vec2" ||
    param.type === "vec3" ||
    param.type === "vec4"
  ) {
    const dim =
      param.type === "vec2" ? 2 : param.type === "vec3" ? 3 : 4;
    const arr =
      Array.isArray(value) && value.length === dim
        ? (value as number[])
        : (param.default as number[]);
    return (
      <div style={{ display: "flex", gap: 4 }}>
        {arr.map((v, i) => (
          <input
            key={i}
            type="number"
            value={v}
            step={param.step ?? 0.01}
            onChange={(e) => {
              const next = [...arr];
              next[i] = parseFloat(e.target.value);
              onChange(next);
            }}
            style={{
              width: "100%",
              background: "#0a0a0a",
              border: "1px solid #27272a",
              color: "#e5e7eb",
              fontFamily: "inherit",
              fontSize: 11,
              padding: "2px 4px",
            }}
          />
        ))}
      </div>
    );
  }

  return <div style={{ color: "#71717a" }}>(unsupported)</div>;
}

function ColorRampControl({
  stops,
  onChange,
}: {
  stops: ColorRampStop[];
  onChange: (next: ColorRampStop[]) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    stops[0]?.id ?? null
  );
  // Latest stops for the pointermove handler — avoids re-subscribing per drag.
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      if (!barRef.current) return;
      const rect = barRef.current.getBoundingClientRect();
      const pos = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width)
      );
      const next = stopsRef.current.map((s) =>
        s.id === dragId ? { ...s, position: pos } : s
      );
      onChangeRef.current(next);
    };
    const onUp = () => setDragId(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragId]);

  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const selected = stops.find((s) => s.id === selectedId) ?? null;

  // Build a CSS gradient preview using rgba() so transparency is visible
  // against a checker background layered behind the bar.
  const gradientCss =
    sorted.length === 0
      ? "transparent"
      : sorted.length === 1
        ? hexAlphaCss(sorted[0].color, sorted[0].alpha ?? 1)
        : `linear-gradient(to right, ${sorted
            .map(
              (s) =>
                `${hexAlphaCss(s.color, s.alpha ?? 1)} ${(s.position * 100).toFixed(2)}%`
            )
            .join(", ")})`;
  const CHECKER =
    "repeating-conic-gradient(#1a1a1a 0% 25%, #0f0f0f 0% 50%) 0 0 / 8px 8px";

  function addStopAt(pos: number) {
    if (stops.length >= COLOR_RAMP_MAX_STOPS) return;
    const p = Math.max(0, Math.min(1, pos));
    const color = sampleRampColor(sorted, p);
    const alpha = sampleRampAlpha(sorted, p);
    const id = newStopId();
    onChange([...stops, { id, position: p, color, alpha }]);
    setSelectedId(id);
  }

  function removeStop(id: string) {
    if (stops.length <= 1) return;
    const next = stops.filter((s) => s.id !== id);
    onChange(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
  }

  function updateStop(id: string, patch: Partial<ColorRampStop>) {
    onChange(stops.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        ref={barRef}
        onPointerDown={(e) => {
          // Only treat clicks on the bar itself (not the handles) as add-stop.
          if (e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          addStopAt((e.clientX - rect.left) / rect.width);
        }}
        style={{
          position: "relative",
          height: 24,
          // Gradient on top of a checker so partial alpha is visible through
          // each stop.
          background: `${gradientCss}, ${CHECKER}`,
          border: "1px solid #27272a",
          borderRadius: 3,
          cursor: "copy",
        }}
      >
        {sorted.map((s) => {
          const isSelected = s.id === selectedId;
          return (
            <div
              key={s.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setSelectedId(s.id);
                setDragId(s.id);
              }}
              style={{
                position: "absolute",
                left: `${s.position * 100}%`,
                top: "100%",
                transform: "translate(-50%, 0)",
                width: 10,
                height: 10,
                background: `${hexAlphaCss(s.color, s.alpha ?? 1)}, ${CHECKER}`,
                border: isSelected
                  ? "1px solid #e5e7eb"
                  : "1px solid #52525b",
                borderRadius: 2,
                cursor: "ew-resize",
                marginTop: 3,
                boxSizing: "border-box",
              }}
              title={`${s.color} α${(s.alpha ?? 1).toFixed(2)} @ ${s.position.toFixed(3)}`}
            />
          );
        })}
      </div>

      <div style={{ marginTop: 14 }}>
        {selected ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 6,
              border: "1px solid #27272a",
              borderRadius: 3,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ color: "#a1a1aa" }}>
                stop · {sorted.findIndex((s) => s.id === selected.id) + 1}/
                {sorted.length}
              </span>
              <button
                onClick={() => removeStop(selected.id)}
                disabled={stops.length <= 1}
                style={{
                  background: "transparent",
                  border: "1px solid #3f3f46",
                  color: stops.length <= 1 ? "#3f3f46" : "#a1a1aa",
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  cursor: stops.length <= 1 ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                remove
              </button>
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span style={{ color: "#71717a", minWidth: 50 }}>color</span>
              <input
                type="color"
                value={selected.color}
                onChange={(e) =>
                  updateStop(selected.id, { color: e.target.value })
                }
                style={{ width: "100%", height: 22 }}
              />
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span style={{ color: "#71717a", minWidth: 50 }}>alpha</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={selected.alpha ?? 1}
                onChange={(e) =>
                  updateStop(selected.id, {
                    alpha: parseFloat(e.target.value),
                  })
                }
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={selected.alpha ?? 1}
                onChange={(e) =>
                  updateStop(selected.id, {
                    alpha: parseFloat(e.target.value),
                  })
                }
                style={{
                  width: 56,
                  background: "#0a0a0a",
                  border: "1px solid #27272a",
                  color: "#e5e7eb",
                  fontFamily: "inherit",
                  fontSize: 11,
                  padding: "2px 4px",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span style={{ color: "#71717a", minWidth: 50 }}>position</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={selected.position}
                onChange={(e) =>
                  updateStop(selected.id, {
                    position: parseFloat(e.target.value),
                  })
                }
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.001}
                value={selected.position}
                onChange={(e) =>
                  updateStop(selected.id, {
                    position: parseFloat(e.target.value),
                  })
                }
                style={{
                  width: 56,
                  background: "#0a0a0a",
                  border: "1px solid #27272a",
                  color: "#e5e7eb",
                  fontFamily: "inherit",
                  fontSize: 11,
                  padding: "2px 4px",
                }}
              />
            </div>
          </div>
        ) : (
          <div style={{ color: "#52525b" }}>(click the bar to add a stop)</div>
        )}
      </div>
      <div style={{ color: "#52525b", fontSize: 10 }}>
        {stops.length}/{COLOR_RAMP_MAX_STOPS} stops — click bar to add, drag
        handles to move
      </div>
    </div>
  );
}

function hexAlphaCss(hex: string, alpha: number): string {
  const [r, g, b] = hexParts(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sampleRampAlpha(sorted: ColorRampStop[], p: number): number {
  if (sorted.length === 0) return 1;
  if (sorted.length === 1) return sorted[0].alpha ?? 1;
  if (p <= sorted[0].position) return sorted[0].alpha ?? 1;
  if (p >= sorted[sorted.length - 1].position)
    return sorted[sorted.length - 1].alpha ?? 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (p >= a.position && p <= b.position) {
      const f = (p - a.position) / Math.max(b.position - a.position, 0.0001);
      const av = a.alpha ?? 1;
      const bv = b.alpha ?? 1;
      return av + (bv - av) * f;
    }
  }
  return sorted[sorted.length - 1].alpha ?? 1;
}

// Sample the ramp at position p using linear interpolation in hex space.
// Used to pick a "sensible" color for newly-inserted stops.
function sampleRampColor(sorted: ColorRampStop[], p: number): string {
  if (sorted.length === 0) return "#808080";
  if (sorted.length === 1) return sorted[0].color;
  if (p <= sorted[0].position) return sorted[0].color;
  if (p >= sorted[sorted.length - 1].position)
    return sorted[sorted.length - 1].color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (p >= a.position && p <= b.position) {
      const f = (p - a.position) / Math.max(b.position - a.position, 0.0001);
      return mixHex(a.color, b.color, f);
    }
  }
  return sorted[sorted.length - 1].color;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = hexParts(a);
  const pb = hexParts(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return (
    "#" +
    [r, g, bl]
      .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexParts(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── RGB Curves editor ─────────────────────────────────────────────────────
const CURVE_SIZE = 200;
const CURVE_PAD = 8;
const CURVE_CHANNEL_COLORS: Record<CurveChannel, string> = {
  rgb: "#e5e7eb",
  r: "#ef4444",
  g: "#22c55e",
  b: "#3b82f6",
};
const CURVE_CHANNEL_LABELS: Record<CurveChannel, string> = {
  rgb: "RGB",
  r: "R",
  g: "G",
  b: "B",
};
// Distance (in svg pixels) a dragged point can move below/above the chart
// before it's removed. Matches the Blender/Photoshop drag-off-chart gesture.
const CURVE_DRAG_OFF_THRESHOLD = 40;

function CurvesControl({
  curves,
  onChange,
}: {
  curves: CurvesValue;
  onChange: (next: CurvesValue) => void;
}) {
  const [activeCh, setActiveCh] = useState<CurveChannel>("rgb");
  const [dragId, setDragId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const curvesRef = useRef(curves);
  curvesRef.current = curves;
  const activeChRef = useRef(activeCh);
  activeChRef.current = activeCh;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Map svg pixel coords <-> curve (0..1) coords. The chart is inset by
  // CURVE_PAD so points on the 0/1 edges are still easy to grab.
  function svgToCurve(x: number, y: number): { x: number; y: number } {
    const span = CURVE_SIZE - 2 * CURVE_PAD;
    return {
      x: (x - CURVE_PAD) / span,
      y: 1 - (y - CURVE_PAD) / span,
    };
  }
  function curveToSvg(cx: number, cy: number): { x: number; y: number } {
    const span = CURVE_SIZE - 2 * CURVE_PAD;
    return {
      x: CURVE_PAD + cx * span,
      y: CURVE_PAD + (1 - cy) * span,
    };
  }

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const offChart =
        py < -CURVE_DRAG_OFF_THRESHOLD ||
        py > CURVE_SIZE + CURVE_DRAG_OFF_THRESHOLD;
      const curr = curvesRef.current;
      const ch = activeChRef.current;
      const chPts = curr[ch];
      if (offChart && chPts.length > 2) {
        // Mark the dragged point for imminent removal on pointer up.
        return;
      }
      const cc = svgToCurve(
        Math.max(0, Math.min(CURVE_SIZE, px)),
        Math.max(0, Math.min(CURVE_SIZE, py))
      );
      const nx = Math.max(0, Math.min(1, cc.x));
      const ny = Math.max(0, Math.min(1, cc.y));
      const next = chPts.map((p) =>
        p.id === dragId ? { ...p, x: nx, y: ny } : p
      );
      // Keep points sorted by x after moves so rendering/eval stays consistent.
      next.sort((a, b) => a.x - b.x);
      onChangeRef.current({ ...curr, [ch]: next });
    };
    const onUp = (e: PointerEvent) => {
      // If released off-chart (and we have more than 2 points), remove the
      // dragged point — classic curve editor gesture.
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const py = e.clientY - rect.top;
        const offChart =
          py < -CURVE_DRAG_OFF_THRESHOLD ||
          py > CURVE_SIZE + CURVE_DRAG_OFF_THRESHOLD;
        const curr = curvesRef.current;
        const ch = activeChRef.current;
        if (offChart && curr[ch].length > 2) {
          const next = curr[ch].filter((p) => p.id !== dragId);
          onChangeRef.current({ ...curr, [ch]: next });
          setSelectedId(null);
        }
      }
      setDragId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragId]);

  const points = curves[activeCh];
  const tangents = computeMonotoneTangents(points);

  // Build the curve path by sampling the monotone cubic densely.
  const SAMPLES = 96;
  const pathSegments: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const y = evalMonotoneCubic(points, tangents, t);
    const sp = curveToSvg(t, Math.max(0, Math.min(1, y)));
    pathSegments.push(`${i === 0 ? "M" : "L"} ${sp.x.toFixed(2)} ${sp.y.toFixed(2)}`);
  }
  const pathD = pathSegments.join(" ");

  function addPointAtSvg(sx: number, sy: number) {
    if (points.length >= 24) return; // soft cap for sanity
    const cc = svgToCurve(sx, sy);
    const nx = Math.max(0, Math.min(1, cc.x));
    const ny = Math.max(0, Math.min(1, cc.y));
    const id = newCurvePointId();
    const next = [...points, { id, x: nx, y: ny }].sort(
      (a, b) => a.x - b.x
    );
    onChange({ ...curves, [activeCh]: next });
    setSelectedId(id);
    setDragId(id);
  }

  function resetChannel(ch: CurveChannel) {
    onChange({ ...curves, [ch]: defaultCurveChannel() });
    setSelectedId(null);
  }

  function resetAll() {
    onChange(defaultCurvesValue());
    setSelectedId(null);
  }

  const color = CURVE_CHANNEL_COLORS[activeCh];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {CURVE_CHANNELS.map((ch) => {
          const active = ch === activeCh;
          return (
            <button
              key={ch}
              onClick={() => {
                setActiveCh(ch);
                setSelectedId(null);
              }}
              style={{
                flex: 1,
                padding: "3px 0",
                background: active ? CURVE_CHANNEL_COLORS[ch] : "#18181b",
                color: active ? "#0a0a0a" : CURVE_CHANNEL_COLORS[ch],
                border: `1px solid ${CURVE_CHANNEL_COLORS[ch]}`,
                borderRadius: 3,
                fontFamily: "inherit",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {CURVE_CHANNEL_LABELS[ch]}
            </button>
          );
        })}
      </div>

      <svg
        ref={svgRef}
        width={CURVE_SIZE}
        height={CURVE_SIZE}
        viewBox={`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          addPointAtSvg(e.clientX - rect.left, e.clientY - rect.top);
        }}
        style={{
          display: "block",
          width: "100%",
          maxWidth: CURVE_SIZE,
          height: "auto",
          background: "#0a0a0a",
          border: "1px solid #27272a",
          borderRadius: 3,
          cursor: "crosshair",
          touchAction: "none",
        }}
      >
        {/* 4x4 grid */}
        {[0, 1, 2, 3, 4].map((i) => {
          const t = i / 4;
          const p = curveToSvg(t, 0);
          const q = curveToSvg(t, 1);
          const p2 = curveToSvg(0, t);
          const q2 = curveToSvg(1, t);
          return (
            <g key={i}>
              <line
                x1={p.x}
                y1={p.y}
                x2={q.x}
                y2={q.y}
                stroke="#1f1f23"
                strokeWidth={1}
              />
              <line
                x1={p2.x}
                y1={p2.y}
                x2={q2.x}
                y2={q2.y}
                stroke="#1f1f23"
                strokeWidth={1}
              />
            </g>
          );
        })}
        {/* Diagonal reference */}
        {(() => {
          const a = curveToSvg(0, 0);
          const b = curveToSvg(1, 1);
          return (
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="#27272a"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          );
        })()}
        {/* Curve */}
        <path d={pathD} stroke={color} strokeWidth={1.5} fill="none" />
        {/* Control points */}
        {points.map((p) => {
          const sp = curveToSvg(p.x, p.y);
          const selected = p.id === selectedId;
          return (
            <circle
              key={p.id}
              cx={sp.x}
              cy={sp.y}
              r={selected ? 5 : 4}
              fill={selected ? color : "#0a0a0a"}
              stroke={color}
              strokeWidth={selected ? 2 : 1.5}
              style={{ cursor: "grab", touchAction: "none" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setSelectedId(p.id);
                setDragId(p.id);
              }}
            />
          );
        })}
      </svg>

      {selectedId && (() => {
        const pt = points.find((p) => p.id === selectedId);
        if (!pt) return null;
        const idx = points.findIndex((p) => p.id === selectedId);
        return (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 6,
              border: "1px solid #27272a",
              borderRadius: 3,
            }}
          >
            <div style={{ color: "#a1a1aa" }}>
              point {idx + 1}/{points.length}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: "#71717a", minWidth: 14 }}>x</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.001}
                value={pt.x}
                onChange={(e) => {
                  const v = Math.max(
                    0,
                    Math.min(1, parseFloat(e.target.value))
                  );
                  if (Number.isNaN(v)) return;
                  const next = points
                    .map((q) => (q.id === pt.id ? { ...q, x: v } : q))
                    .sort((a, b) => a.x - b.x);
                  onChange({ ...curves, [activeCh]: next });
                }}
                style={inputStyle()}
              />
              <span style={{ color: "#71717a", minWidth: 14 }}>y</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.001}
                value={pt.y}
                onChange={(e) => {
                  const v = Math.max(
                    0,
                    Math.min(1, parseFloat(e.target.value))
                  );
                  if (Number.isNaN(v)) return;
                  const next = points.map((q) =>
                    q.id === pt.id ? { ...q, y: v } : q
                  );
                  onChange({ ...curves, [activeCh]: next });
                }}
                style={inputStyle()}
              />
            </div>
            <button
              onClick={() => {
                if (points.length <= 2) return;
                const next = points.filter((q) => q.id !== pt.id);
                onChange({ ...curves, [activeCh]: next });
                setSelectedId(null);
              }}
              disabled={points.length <= 2}
              style={{
                marginTop: 2,
                background: "transparent",
                border: "1px solid #3f3f46",
                color: points.length <= 2 ? "#3f3f46" : "#a1a1aa",
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 3,
                cursor: points.length <= 2 ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              remove
            </button>
          </div>
        );
      })()}

      <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={() => resetChannel(activeCh)}
          style={buttonStyle()}
        >
          reset {CURVE_CHANNEL_LABELS[activeCh]}
        </button>
        <button onClick={resetAll} style={buttonStyle()}>
          reset all
        </button>
      </div>
      <div style={{ color: "#52525b", fontSize: 10 }}>
        click to add · drag to move · drag far off-chart to remove
      </div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    width: 56,
    background: "#0a0a0a",
    border: "1px solid #27272a",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 11,
    padding: "2px 4px",
  };
}

function buttonStyle(): React.CSSProperties {
  return {
    flex: 1,
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#a1a1aa",
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 3,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
