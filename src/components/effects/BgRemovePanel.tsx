"use client";

import { useMemo, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { BgModelId, BgProgress } from "@/lib/ai/bg-remove";

export interface BgRemovePanelProps {
  node: Node<NodeDataPayload>;
  edges: Edge[];
  // Bridge into the engine that returns the upstream node's
  // primary IMAGE output as a PNG Blob. Same helper Image Generate
  // uses for ref images.
  getRefImageBlob?: (sourceNodeId: string) => Promise<Blob | null>;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
}

// Custom param panel for the Background Remove node. Replaces the
// standard property iteration with a Bake button + status row +
// the live params (feather / threshold).

export default function BgRemovePanel({
  node,
  edges,
  getRefImageBlob,
  onParamChange,
}: BgRemovePanelProps) {
  const model = (node.data.params.model as BgModelId) ?? "rmbg-1.4";
  const feather = (node.data.params.feather as number) ?? 0;
  const threshold = (node.data.params.threshold as number) ?? 0.5;
  const baked = !!node.data.params.bakedSource && !!node.data.params.bakedMask;

  const [progress, setProgress] = useState<BgProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Find the upstream image source from the live edge list. We
  // use this both to gate the Bake button (no input → can't bake)
  // and to capture the bytes for inference.
  const upstreamId = useMemo(() => {
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle === "in:image") {
        return e.source;
      }
    }
    return null;
  }, [edges, node.id]);

  const bake = async () => {
    if (!upstreamId || !getRefImageBlob) return;
    setError(null);
    try {
      setProgress({ phase: "loading-runtime" });
      const blob = await getRefImageBlob(upstreamId);
      if (!blob) {
        setError("Couldn't read the upstream image — make sure it's evaluated.");
        setProgress(null);
        return;
      }
      const { removeBackground } = await import("@/lib/ai/bg-remove");
      const out = await removeBackground(blob, {
        model,
        onProgress: (p) => setProgress(p),
      });
      // Two ImageBitmaps land on the params; the file-typed
      // params auto-serialize via project.ts on save.
      onParamChange(node.id, "bakedSource", out.source);
      onParamChange(node.id, "bakedMask", out.mask);
      setProgress(null);
      // Trigger a pipeline re-eval so the cutout shows up
      // immediately even on a paused timeline.
      window.dispatchEvent(new Event("pipeline-bump"));
    } catch (e) {
      setError((e as Error).message ?? "Bake failed.");
      setProgress(null);
    }
  };

  const clearBake = () => {
    onParamChange(node.id, "bakedSource", null);
    onParamChange(node.id, "bakedMask", null);
    setError(null);
    window.dispatchEvent(new Event("pipeline-bump"));
  };

  const busy = progress !== null;
  const canBake = !!upstreamId && !busy;

  const statusText = busy
    ? phaseLabel(progress)
    : baked
    ? "Baked"
    : upstreamId
    ? "Not baked"
    : "Wire an Image input";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "#111114",
          border: "1px solid #27272a",
          borderRadius: 4,
        }}
      >
        <div
          style={{
            color: "#fafafa",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          Background Remove
        </div>
        <div style={{ color: "#52525b", fontSize: 10 }}>{model}</div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            color: baked ? "#4ade80" : busy ? "#fbbf24" : "#71717a",
            fontSize: 10,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {busy && <InlineSpinner />}
          {statusText}
        </div>
      </div>

      {/* Inference progress bar */}
      {busy && progress?.phase === "loading-model" && (
        <div
          style={{
            background: "#0a0a0a",
            border: "1px solid #27272a",
            borderRadius: 3,
            height: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "#1e3a8a",
              height: "100%",
              width: `${(progress.progress ?? 0) * 100}%`,
              transition: "width 200ms linear",
            }}
          />
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "6px 10px",
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid #b91c1c",
            color: "#fecaca",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}

      {/* Live params */}
      <Field label="Model">
        <Select
          value={model}
          options={["rmbg-1.4", "rmbg-2.0"]}
          onChange={(v) => onParamChange(node.id, "model", v)}
        />
      </Field>
      <Field label="Feather">
        <Slider
          value={feather}
          min={0}
          max={1}
          step={0.001}
          onChange={(v) => onParamChange(node.id, "feather", v)}
        />
      </Field>
      <Field label="Threshold">
        <Slider
          value={threshold}
          min={0.1}
          max={0.9}
          step={0.01}
          onChange={(v) => onParamChange(node.id, "threshold", v)}
        />
      </Field>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={bake}
          disabled={!canBake}
          style={{
            flex: 1,
            padding: "6px 10px",
            background: canBake ? "#1e3a8a" : "transparent",
            border: `1px solid ${canBake ? "#1d4ed8" : "#3f3f46"}`,
            color: canBake ? "#bfdbfe" : "#52525b",
            fontFamily: "inherit",
            fontSize: 11,
            borderRadius: 3,
            cursor: canBake ? "pointer" : "not-allowed",
            opacity: canBake ? 1 : 0.6,
          }}
        >
          {baked ? "Re-bake" : "Bake"}
        </button>
        {baked && (
          <button
            type="button"
            onClick={clearBake}
            disabled={busy}
            style={{
              padding: "6px 10px",
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div style={{ color: "#52525b", fontSize: 10, lineHeight: 1.5 }}>
        Bake runs the model in your browser via Transformers.js. The
        first run downloads ~177 MB ({model}) which is cached for
        future runs. Tweaking <i>feather</i> / <i>threshold</i>{" "}
        afterwards is free — no re-bake needed. Upstream changes are
        ignored until you re-bake.
      </div>
    </div>
  );
}

function phaseLabel(p: BgProgress | null): string {
  if (!p) return "";
  switch (p.phase) {
    case "loading-runtime":
      return "Loading runtime…";
    case "loading-model":
      return p.progress != null
        ? `Loading model… ${Math.round(p.progress * 100)}%`
        : "Loading model…";
    case "running":
      return "Running…";
    case "compositing":
      return "Compositing…";
    case "done":
      return "Done";
  }
}

function InlineSpinner() {
  return (
    <svg
      className="toolbox-spinner"
      width="9"
      height="9"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="#fbbf24"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="40"
        strokeDashoffset="20"
      />
    </svg>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          width: 90,
          color: "#a1a1aa",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "3px 6px",
        background: "#0f0f12",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "inherit",
        fontSize: 11,
        borderRadius: 3,
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

function Slider({
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
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span
        style={{
          color: "#a1a1aa",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
          width: 40,
          textAlign: "right",
        }}
      >
        {value.toFixed(3)}
      </span>
    </div>
  );
}
