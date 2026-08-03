"use client";

import { useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";

// DaVinci-style primaries panel for the Color Correction node: four color
// wheels (Dark / Shadow / Light / Global = Lift / Gamma / Gain / Offset) each
// with a balance disc, a master (luminance) slider, and Exp / Sat; plus a
// bottom bar of Temp / Tint / Hue / Cont / Pivot / MD / B·Ofs. All controls
// write straight to the node's scalar params; the grading happens in the
// node's shader.

interface Props {
  node: Node<NodeDataPayload>;
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
}

const WHEELS: { key: string; label: string }[] = [
  { key: "dark", label: "Dark" },
  { key: "shadow", label: "Shadow" },
  { key: "light", label: "Light" },
  { key: "global", label: "Global" },
];

// Per-wheel field defaults (used by reset + reads).
const WHEEL_DEFAULTS: Record<string, number> = {
  X: 0,
  Y: 0,
  Lum: 0,
  Exp: 0,
  Sat: 1,
};

const HUE_GRAD =
  "linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)";

const BOTTOM_FIELDS: {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  grad?: string;
}[] = [
  { name: "temp", label: "Temp", min: -1, max: 1, step: 0.001, def: 0, grad: "linear-gradient(90deg,var(--tb-a-blue-500),var(--tb-a-amber-500))" },
  { name: "tint", label: "Tint", min: -1, max: 1, step: 0.001, def: 0, grad: "linear-gradient(90deg,var(--tb-a-green-500),#d946ef)" },
  { name: "hue", label: "Hue", min: -180, max: 180, step: 0.5, def: 0, grad: HUE_GRAD },
  { name: "contrast", label: "Cont", min: 0, max: 4, step: 0.001, def: 1, grad: "linear-gradient(90deg,#000,#fff)" },
  { name: "pivot", label: "Pivot", min: 0, max: 1, step: 0.001, def: 0.5 },
  { name: "md", label: "MD", min: -1, max: 1, step: 0.001, def: 0 },
  { name: "boffset", label: "B·Ofs", min: -1, max: 1, step: 0.001, def: 0 },
];

export default function ColorCorrectionPanel({ node, onParamChange }: Props) {
  const params = node.data.params as Record<string, unknown>;
  const get = (name: string, def: number): number =>
    typeof params[name] === "number" ? (params[name] as number) : def;
  const set = (name: string, v: number) => onParamChange(node.id, name, v);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        color: "var(--tb-n-14)",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        {WHEELS.map((w) => (
          <ColorWheel key={w.key} wheelKey={w.key} label={w.label} get={get} set={set} />
        ))}
      </div>

      <div style={{ height: 1, background: "var(--tb-n-5)", margin: "2px 0" }} />

      {/* Bottom bar — gradient-tracked sliders */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          columnGap: 12,
          rowGap: 8,
        }}
      >
        {BOTTOM_FIELDS.map((f) => (
          <GradientSlider
            key={f.name}
            label={f.label}
            value={get(f.name, f.def)}
            min={f.min}
            max={f.max}
            step={f.step}
            grad={f.grad}
            onChange={(v) => set(f.name, v)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ColorWheel({
  wheelKey,
  label,
  get,
  set,
}: {
  wheelKey: string;
  label: string;
  get: (name: string, def: number) => number;
  set: (name: string, v: number) => void;
}) {
  const x = get(`${wheelKey}X`, 0);
  const y = get(`${wheelKey}Y`, 0);
  const lum = get(`${wheelKey}Lum`, 0);
  const exp = get(`${wheelKey}Exp`, 0);
  const sat = get(`${wheelKey}Sat`, 1);

  const discRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const round = (v: number) => Math.round(v * 1000) / 1000;

  const applyFromPointer = (clientX: number, clientY: number) => {
    const el = discRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = (clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    set(`${wheelKey}X`, round(dx));
    set(`${wheelKey}Y`, round(dy));
  };

  const reset = () => {
    set(`${wheelKey}X`, WHEEL_DEFAULTS.X);
    set(`${wheelKey}Y`, WHEEL_DEFAULTS.Y);
    set(`${wheelKey}Lum`, WHEEL_DEFAULTS.Lum);
    set(`${wheelKey}Exp`, WHEEL_DEFAULTS.Exp);
    set(`${wheelKey}Sat`, WHEEL_DEFAULTS.Sat);
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 5,
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-3)",
        borderRadius: 6,
        padding: 6,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span
          style={{
            color: "var(--tb-n-14)",
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textTransform: "capitalize",
          }}
        >
          {label}
        </span>
        <span style={{ color: "var(--tb-n-11)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
          {lum.toFixed(2)}
        </span>
        <button
          type="button"
          onClick={reset}
          title="Reset wheel"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--tb-n-11)",
            cursor: "pointer",
            padding: 0,
            fontSize: 12,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ↺
        </button>
      </div>

      {/* Disc + master slider */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 5 }}>
        <MasterSlider value={lum} onChange={(v) => set(`${wheelKey}Lum`, v)} />
        <div
          ref={discRef}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            applyFromPointer(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (dragging.current) applyFromPointer(e.clientX, e.clientY);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* noop */
            }
          }}
          onDoubleClick={() => {
            set(`${wheelKey}X`, 0);
            set(`${wheelKey}Y`, 0);
          }}
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            aspectRatio: "1 / 1",
            borderRadius: "50%",
            cursor: "crosshair",
            // Resolve look: vivid hue only at the rim, dark desaturated interior.
            background:
              "radial-gradient(circle at center, color-mix(in srgb, var(--tb-n-0) 88%, transparent) 0%, color-mix(in srgb, var(--tb-n-0) 86%, transparent) 40%, rgba(10,10,12,0) 78%)," +
              "conic-gradient(from 0deg,#ff2d2d,#ffd92d,#37d937,var(--tb-t-cyan-l-3),#2d6bff,#c92dff,#ff2d2d)",
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.6)",
          }}
        >
          {/* crosshair */}
          <div style={{ position: "absolute", left: "50%", top: "12%", bottom: "12%", width: 1, background: "color-mix(in srgb, var(--tb-lift) 14%, transparent)", transform: "translateX(-0.5px)" }} />
          <div style={{ position: "absolute", top: "50%", left: "12%", right: "12%", height: 1, background: "color-mix(in srgb, var(--tb-lift) 14%, transparent)", transform: "translateY(-0.5px)" }} />
          {/* balance dot */}
          <div
            style={{
              position: "absolute",
              left: `${50 + x * 50}%`,
              top: `${50 + y * 50}%`,
              width: 9,
              height: 9,
              marginLeft: -4.5,
              marginTop: -4.5,
              borderRadius: "50%",
              background: "var(--tb-n-0)",
              border: "2px solid var(--tb-n-17)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
              pointerEvents: "none",
            }}
          />
        </div>
      </div>

      {/* Exp / Sat */}
      <MiniSlider label="Exp" value={exp} min={-2} max={2} step={0.001} onChange={(v) => set(`${wheelKey}Exp`, v)} />
      <MiniSlider label="Sat" value={sat} min={0} max={2} step={0.001} onChange={(v) => set(`${wheelKey}Sat`, v)} />

      {/* X / Y / L */}
      <div style={{ display: "flex", gap: 3 }}>
        <LabeledNum label="X" value={x} min={-1} max={1} step={0.001} onChange={(v) => set(`${wheelKey}X`, v)} />
        <LabeledNum label="Y" value={y} min={-1} max={1} step={0.001} onChange={(v) => set(`${wheelKey}Y`, v)} />
        <LabeledNum label="L" value={lum} min={-2} max={2} step={0.001} onChange={(v) => set(`${wheelKey}Lum`, v)} />
      </div>
    </div>
  );
}

// A bottom-bar field: label · slider (gradient track via --track) · value.
function GradientSlider({
  label,
  value,
  min,
  max,
  step,
  grad,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  grad?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ color: "var(--tb-n-12)", flex: "0 0 34px" }}>{label}</span>
      <input
        type="range"
        className="ccbar-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          flex: 1,
          minWidth: 0,
          ["--track" as string]: grad ?? "var(--tb-n-9)",
        } as React.CSSProperties}
      />
      <div style={{ flex: "0 0 42px" }}>
        <NumField
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

// Vertical master (luminance) slider on the left of the disc.
function MasterSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const MIN = -2;
  const MAX = 2;
  const fromY = (clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = 1 - Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    onChange(Math.round((MIN + t * (MAX - MIN)) * 1000) / 1000);
  };
  const pct = (1 - (value - MIN) / (MAX - MIN)) * 100;
  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromY(e.clientY);
      }}
      onPointerMove={(e) => dragging.current && fromY(e.clientY)}
      onPointerUp={(e) => {
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
      }}
      onDoubleClick={() => onChange(0)}
      title="Master"
      style={{
        position: "relative",
        width: 8,
        flexShrink: 0,
        cursor: "ns-resize",
        background: "var(--tb-n-2)",
        border: "1px solid var(--tb-n-6)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: `${pct}%`,
          width: 12,
          height: 12,
          marginLeft: -6,
          marginTop: -6,
          borderRadius: "50%",
          background: "var(--tb-n-15)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.6)",
        }}
      />
    </div>
  );
}

function MiniSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
        <span style={{ color: "var(--tb-n-12)" }}>{label}</span>
        <span style={{ color: "var(--tb-n-13)", fontVariantNumeric: "tabular-nums" }}>
          {value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 12 }}
      />
    </div>
  );
}

function LabeledNum({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, flex: 1, minWidth: 0 }}>
      <span style={{ color: "var(--tb-n-10)", flex: "0 0 auto" }}>{label}</span>
      <NumField value={value} min={min} max={max} step={step} onChange={onChange} />
    </div>
  );
}

// Commit-on-blur numeric input. Shows the live value while idle and lets the
// field be cleared while editing (blank confirms to the current value).
function NumField({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const v = parseFloat(draft);
    if (Number.isNaN(v)) return;
    onChange(Math.max(min, Math.min(max, v)));
  };
  const fmt = (v: number) => {
    let s = v.toFixed(step < 0.01 ? 3 : 2);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={editing ? draft : fmt(value)}
      onFocus={() => {
        setDraft(String(value));
        setEditing(true);
      }}
      onChange={(e) => editing && setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        width: "100%",
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-6)",
        borderRadius: 3,
        color: "var(--tb-n-14)",
        fontFamily: "inherit",
        fontSize: 10,
        padding: "2px 4px",
        textAlign: "center",
        boxSizing: "border-box",
      }}
    />
  );
}
