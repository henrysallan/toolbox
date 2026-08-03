"use client";

// Brush presets + the floating Brush Editor window (071926_paint-toolkit.md).
// PaintBrushSection is the block ParamPanel renders for the Paint node:
// preset chips (built-ins + the user's saved presets, cloud-synced via
// Supabase user prefs with a localStorage fallback) and the "Edit Brush…"
// button that opens the draggable editor window. All edits write the node's
// `brush` blob / `size` param through onParamChange, so undo/redo and
// serialization behave like any other param edit.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Node } from "@xyflow/react";
import type { BrushSettingsValue } from "@/engine/types";
import type { NodeDataPayload } from "@/state/graph";
import { Dropdown } from "@/lib/param-controls";
import {
  BUILTIN_PRESETS,
  resolveBrush,
  type BrushPreset,
} from "./brushes";
import { StrokeSession } from "./engine";
import { loadUserPresets, saveUserPresets } from "./presets";

interface SectionProps {
  node: Node<NodeDataPayload>;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
}

export function PaintBrushSection({ node, onParamChange }: SectionProps) {
  const [open, setOpen] = useState(false);
  const [userPresets, setUserPresets] = useState<BrushPreset[]>([]);
  // The paint overlay's top-right shelf has an Edit Brush button; it can't
  // reach this component's state directly, so it toggles via a window event
  // (same pattern as effect-node-param).
  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent).detail as { nodeId?: string } | undefined;
      if (d?.nodeId === node.id) setOpen((v) => !v);
    };
    window.addEventListener("paint-brush-editor-toggle", onToggle);
    return () =>
      window.removeEventListener("paint-brush-editor-toggle", onToggle);
  }, [node.id]);
  useEffect(() => {
    let alive = true;
    loadUserPresets().then((list) => {
      if (alive) setUserPresets(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const brush = useMemo(
    () => resolveBrush(node.data.params.brush),
    [node.data.params.brush]
  );
  const size =
    typeof node.data.params.size === "number"
      ? (node.data.params.size as number)
      : 12;
  const color = (node.data.params.color as string) ?? "#ffffff";

  const applyPreset = (p: BrushPreset) => {
    onParamChange(node.id, "brush", { ...p.brush });
    onParamChange(node.id, "size", p.size);
  };

  const savePreset = (name: string) => {
    const next: BrushPreset[] = [
      ...userPresets,
      {
        id: `preset-${Math.random().toString(36).slice(2, 10)}`,
        name,
        size,
        brush: { ...brush },
      },
    ];
    setUserPresets(next);
    void saveUserPresets(next);
  };

  const deletePreset = (id: string) => {
    const next = userPresets.filter((p) => p.id !== id);
    setUserPresets(next);
    void saveUserPresets(next);
  };

  // The dropdown reflects which preset the node's current settings match;
  // any slider edit diverges the blob and the control reads "Custom" (an
  // option that only appears while unmatched — picking it does nothing).
  const allPresets = [...BUILTIN_PRESETS, ...userPresets];
  const matched = allPresets.find(
    (p) =>
      p.size === size &&
      (Object.keys(p.brush) as (keyof BrushSettingsValue)[]).every(
        (k) => p.brush[k] === brush[k]
      )
  );

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ marginBottom: 6 }}>
        <Dropdown
          value={matched?.id ?? "__custom__"}
          options={[
            ...(matched ? [] : [{ value: "__custom__", label: "Custom" }]),
            ...allPresets.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(id) => {
            const p = allPresets.find((x) => x.id === id);
            if (p) applyPreset(p);
          }}
          title="Brush preset"
        />
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "6px 0",
          fontSize: 11,
          fontFamily: "var(--ui-font)",
          background: open ? "color-mix(in srgb, var(--tb-a-blue-500) 18%, transparent)" : "var(--tb-n-4)",
          color: open ? "var(--tb-a-blue-300)" : "var(--tb-n-16)",
          border: `1px solid ${open ? "var(--tb-a-blue-500)" : "var(--tb-n-9)"}`,
          borderRadius: 5,
          cursor: "pointer",
        }}
      >
        {open ? "Close Brush Editor" : "Edit Brush…"}
      </button>
      {open && (
        <BrushEditorWindow
          nodeId={node.id}
          brush={brush}
          size={size}
          color={color}
          userPresets={userPresets}
          onParamChange={onParamChange}
          onSavePreset={savePreset}
          onDeletePreset={deletePreset}
          onApplyPreset={applyPreset}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BrushEditorWindow({
  nodeId,
  brush,
  size,
  color,
  userPresets,
  onParamChange,
  onSavePreset,
  onDeletePreset,
  onApplyPreset,
  onClose,
}: {
  nodeId: string;
  brush: BrushSettingsValue;
  size: number;
  color: string;
  userPresets: BrushPreset[];
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  onApplyPreset: (p: BrushPreset) => void;
  onClose: () => void;
}) {
  // Draggable window position (client px), started near the param panel.
  const [pos, setPos] = useState(() =>
    typeof window === "undefined"
      ? { x: 120, y: 140 }
      : { x: Math.max(16, window.innerWidth - 640), y: 140 }
  );
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [saveName, setSaveName] = useState("");

  const patch = (field: keyof BrushSettingsValue, value: number | boolean) => {
    onParamChange(nodeId, "brush", { ...brush, [field]: value });
  };

  const onHeaderDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // A press on the close button must stay a click — capturing the
    // pointer here retargets the click to the header, so the button's
    // onClick would never fire and the × couldn't close the window.
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.max(0, e.clientX - d.dx),
      y: Math.max(0, e.clientY - d.dy),
    });
  };
  const onHeaderUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: 300,
        zIndex: 60,
        background: "color-mix(in srgb, var(--tb-n-0) 97%, transparent)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 8,
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        userSelect: "none",
      }}
    >
      <div
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 10px",
          borderBottom: "1px solid var(--tb-n-7)",
          cursor: "grab",
        }}
      >
        <span style={{ color: "var(--tb-n-13)", letterSpacing: 0.5 }}>
          brush editor
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--tb-n-13)",
            cursor: "pointer",
            fontSize: 13,
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
        <StrokePreview brush={brush} size={size} color={color} />

        <SliderRow
          label="Size"
          value={size}
          min={1}
          max={200}
          step={1}
          format={(v) => `${Math.round(v)}px`}
          onChange={(v) => onParamChange(nodeId, "size", Math.round(v))}
        />
        <SliderRow
          label="Hardness"
          value={brush.hardness}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patch("hardness", v)}
        />
        <SliderRow
          label="Opacity"
          value={brush.opacity}
          min={0.05}
          max={1}
          step={0.01}
          onChange={(v) => patch("opacity", v)}
        />
        <SliderRow
          label="Flow"
          value={brush.flow}
          min={0.02}
          max={1}
          step={0.01}
          onChange={(v) => patch("flow", v)}
        />
        <SliderRow
          label="Spacing"
          value={brush.spacing}
          min={0.02}
          max={1}
          step={0.01}
          onChange={(v) => patch("spacing", v)}
        />
        <SliderRow
          label="Smoothing"
          value={brush.smoothing}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patch("smoothing", v)}
        />
        <CheckRow
          label="Pressure → size"
          checked={brush.pressureSize}
          onChange={(v) => patch("pressureSize", v)}
        />
        <CheckRow
          label="Pressure → opacity"
          checked={brush.pressureOpacity}
          onChange={(v) => patch("pressureOpacity", v)}
        />

        {/* Save the current settings as a named preset. */}
        <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
          <input
            type="text"
            placeholder="preset name"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--tb-n-1)",
              color: "var(--tb-n-16)",
              border: "1px solid var(--tb-n-9)",
              borderRadius: 4,
              padding: "4px 7px",
              fontFamily: "inherit",
              fontSize: 11,
            }}
          />
          <button
            type="button"
            disabled={!saveName.trim()}
            onClick={() => {
              onSavePreset(saveName.trim());
              setSaveName("");
            }}
            style={{
              padding: "4px 10px",
              background: saveName.trim() ? "var(--tb-a-blue-700)" : "var(--tb-n-4)",
              color: saveName.trim() ? "#fff" : "var(--tb-n-10)",
              border: "1px solid var(--tb-n-9)",
              borderRadius: 4,
              cursor: saveName.trim() ? "pointer" : "default",
              fontFamily: "inherit",
              fontSize: 11,
            }}
          >
            Save
          </button>
        </div>

        {userPresets.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {userPresets.map((p) => (
              <span
                key={p.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 4px 2px 8px",
                  fontSize: 10,
                  background: "var(--tb-n-4)",
                  border: "1px solid var(--tb-n-9)",
                  borderRadius: 10,
                }}
              >
                <button
                  type="button"
                  onClick={() => onApplyPreset(p)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--tb-n-15)",
                    cursor: "pointer",
                    padding: 0,
                    fontFamily: "inherit",
                    fontSize: "inherit",
                  }}
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete preset ${p.name}`}
                  onClick={() => onDeletePreset(p.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--tb-n-11)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 11,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// Live preview: the real stamp engine drawing a pressure-ramped wiggle with
// the current settings (size clamped so big brushes still fit the strip).
function StrokePreview({
  brush,
  size,
  color,
}: {
  brush: BrushSettingsValue;
  size: number;
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#101013";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const session = new StrokeSession(canvas, {
      mode: "paint",
      color,
      size: Math.min(size, 40),
      brush,
      pressureCapable: true,
    });
    const w = canvas.width;
    const h = canvas.height;
    session.down(14, h / 2, 0.15);
    const steps = 70;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      session.move(
        14 + t * (w - 28),
        h / 2 + Math.sin(t * Math.PI * 2) * h * 0.22,
        0.15 + 0.85 * Math.sin(t * Math.PI)
      );
    }
    session.end();
  }, [brush, size, color]);
  return (
    <canvas
      ref={ref}
      width={278}
      height={64}
      style={{
        width: "100%",
        height: 64,
        borderRadius: 5,
        border: "1px solid var(--tb-n-7)",
        display: "block",
      }}
    />
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "84px 1fr 44px",
        alignItems: "center",
        gap: 7,
      }}
    >
      <span style={{ color: "var(--tb-n-13)" }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "var(--tb-a-blue-500)" }}
      />
      <span style={{ textAlign: "right", color: "var(--tb-n-15)" }}>
        {format ? format(value) : value.toFixed(2)}
      </span>
    </label>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        cursor: "pointer",
        color: "var(--tb-n-13)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--tb-a-blue-500)" }}
      />
      {label}
    </label>
  );
}
