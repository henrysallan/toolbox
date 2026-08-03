"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Edge, Node } from "@xyflow/react";
import { evalNumExpr } from "@/lib/num-expr";
import type { NodeDataPayload } from "@/state/graph";
import type {
  DepthDtype,
  DepthModelId,
  RawDepthFrame,
} from "@/lib/ai/depth-anything";
import {
  addBakeFrame,
  beginBake,
  commitBake,
  freeBake,
  getDepthStatus,
  getDepthStoreRev,
  getScopedFrame,
  isDepthBaked,
  isDepthLocked,
  runLivePreview,
  setDepthStatusBusy,
  subscribeDepthStore,
} from "@/lib/ai/depth-session";

// Custom param panel for the Depth Anything node.
//
// Preview runs depth estimation on the current frame (live single-frame
// bitmap); Bake runs the model over an in/out range and caches a depth map
// per frame so animated/video inputs play back and export smoothly. Depth
// state lives in the session store — this panel renders whatever it reports.
// No prompts/overlay (unlike Segment): depth needs no points.

const MODEL_LABELS: Record<DepthModelId, string> = {
  "v2-small": "V2 Small (fast)",
  "v2-base": "V2 Base",
  "v2-large": "V2 Large (slow)",
};

const DTYPE_LABELS: Record<DepthDtype, string> = {
  fp32: "Best (fp32)",
  fp16: "Balanced (fp16)",
  q8: "Fast (q8)",
};

// Transient working-memory ceiling for the raw float frames held while a bake
// computes its global range. ~1.25 GB → a few hundred frames at the
// DEPTH_BAKE_MAX_EDGE cap; longer ranges abort with a clear message.
const FLOAT_BUDGET = 1280 * 1024 * 1024;

type OutputMode = "depth" | "normal";

export interface DepthAnythingPanelProps {
  node: Node<NodeDataPayload>;
  edges: Edge[];
  getRefImageBlob?: (sourceNodeId: string) => Promise<Blob | null>;
  // Offline frame-stepper from EffectsApp: renders each requested frame
  // deterministically and hands back the upstream node's pixels.
  captureNodeFrames?: (
    sourceNodeId: string,
    frames: number[],
    onFrame: (frame: number, blob: Blob) => Promise<boolean | void>
  ) => Promise<void>;
  // Scene length in frames — the "to end" convenience for the out frame.
  sceneFrames?: number;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
}

export default function DepthAnythingPanel({
  node,
  edges,
  getRefImageBlob,
  captureNodeFrames,
  sceneFrames,
  onParamChange,
}: DepthAnythingPanelProps) {
  // Re-render on any session-store change (status, bake lifecycle).
  useSyncExternalStore(
    subscribeDepthStore,
    getDepthStoreRev,
    getDepthStoreRev
  );

  const outputMode = ((node.data.params.outputMode as OutputMode) ??
    "depth") as OutputMode;
  const model = ((node.data.params.model as DepthModelId) ??
    "v2-small") as DepthModelId;
  const precision = ((node.data.params.precision as DepthDtype) ??
    "fp32") as DepthDtype;
  const invert = !!node.data.params.invert;
  const near = (node.data.params.near as number) ?? 0;
  const far = (node.data.params.far as number) ?? 1;
  const normalStrength = (node.data.params.normalStrength as number) ?? 1;
  const inFrame = Math.max(
    0,
    Math.round((node.data.params.inFrame as number) ?? 0)
  );
  const outFrame = Math.max(
    inFrame,
    Math.round((node.data.params.outFrame as number) ?? 120)
  );

  const status = getDepthStatus(node.id);
  const baked = isDepthBaked(node.id);
  const locked = isDepthLocked(node.id);
  const busy =
    status.phase === "loading-model" ||
    status.phase === "running" ||
    status.phase === "baking";

  // Cooperative cancel for an in-flight bake.
  const cancelRef = useRef(false);

  const upstreamId = useMemo(() => {
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle === "in:image") {
        return e.source;
      }
    }
    return null;
  }, [edges, node.id]);

  const preview = () => {
    if (!upstreamId || !getRefImageBlob) return;
    void runLivePreview(
      node.id,
      () => getRefImageBlob(upstreamId),
      model,
      precision
    );
  };

  const bake = async () => {
    if (!upstreamId || !captureNodeFrames) return;
    const frames: number[] = [];
    for (let f = inFrame; f <= outFrame; f++) frames.push(f);
    cancelRef.current = false;
    beginBake(node.id, frames.length);
    try {
      const { estimateDepthRaw, depthRawToPng } = await import(
        "@/lib/ai/depth-anything"
      );
      // Frames are keyed by the NODE'S OWN clock (layer-local frame, recorded
      // by its compute during the renders we drive) — global frame numbers
      // don't match the node's lookups when it sits inside an offset layer.
      // The scoped clock is trustworthy only if it ADVANCED across the
      // capture, so the keying decision happens after the loop.
      const captured: Array<{
        globalFrame: number;
        scoped: number | null;
        raw: RawDepthFrame;
      }> = [];
      // FLICKER FIX — phase 1: run inference per frame, keep the RAW float
      // depth, and accumulate ONE global min/max across the whole range.
      let gmin = Infinity;
      let gmax = -Infinity;
      let floatBytes = 0;
      const sizes = new Set<number>();
      await captureNodeFrames(upstreamId, frames, async (frame, blob) => {
        if (cancelRef.current) return false;
        // Detect a bake that captured the same pixels every frame (upstream
        // not animating over the range / not time-synced).
        sizes.add(blob.size);
        const raw = await estimateDepthRaw(blob, { model, dtype: precision });
        floatBytes += raw.data.length * 4;
        if (floatBytes > FLOAT_BUDGET) {
          throw new Error(
            `Bake exceeded ${Math.round(
              FLOAT_BUDGET / (1024 * 1024)
            )} MB of working memory — try a shorter frame range.`
          );
        }
        if (raw.min < gmin) gmin = raw.min;
        if (raw.max > gmax) gmax = raw.max;
        captured.push({
          globalFrame: frame,
          scoped: getScopedFrame(node.id),
          raw,
        });
        setDepthStatusBusy(node.id, {
          phase: "baking",
          frameDone: captured.length,
          frameTotal: frames.length,
        });
        return !cancelRef.current;
      });
      if (cancelRef.current) {
        freeBake(node.id);
        return;
      }
      // Trust the scoped clock only if it advanced strictly with the capture;
      // otherwise fall back to global frames.
      const scopedOk =
        captured.length > 0 &&
        captured.every(
          (c, i) =>
            c.scoped != null && (i === 0 || c.scoped > captured[i - 1].scoped!)
        );
      // Phase 2: normalize every frame to the ONE global range → 8-bit PNG, so
      // brightness is temporally stable. Fast (no inference).
      for (const c of captured) {
        if (cancelRef.current) {
          freeBake(node.id);
          return;
        }
        const png = await depthRawToPng(c.raw, gmin, gmax);
        addBakeFrame(
          node.id,
          scopedOk ? (c.scoped as number) : c.globalFrame,
          png
        );
      }
      commitBake(
        node.id,
        captured.length > 1 && sizes.size === 1
          ? "Every captured frame had identical pixels — the input may not be animating over this range."
          : undefined
      );
    } catch (e) {
      freeBake(node.id, (e as Error)?.message ?? "Bake failed.");
    }
  };

  const canPreview = !!upstreamId && !!getRefImageBlob && !busy && !locked;
  const canBake = !!upstreamId && !!captureNodeFrames && !busy && !baked;

  const statusText = (() => {
    switch (status.phase) {
      case "loading-model":
        return status.progress != null
          ? `Loading model… ${Math.round(status.progress * 100)}%`
          : "Loading model…";
      case "running":
        return "Estimating…";
      case "baking":
        return `Baking ${status.frameDone ?? 0}/${status.frameTotal ?? 0}`;
      case "error":
        return "Error";
      default:
        return baked
          ? `Baked ${inFrame}–${outFrame}`
          : !upstreamId
          ? "Wire an Image input"
          : "Preview to estimate";
    }
  })();

  const barProgress =
    status.phase === "baking" && status.frameTotal
      ? (status.frameDone ?? 0) / status.frameTotal
      : status.phase === "loading-model"
      ? status.progress ?? null
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header / status row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "var(--tb-n-1)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 4,
        }}
      >
        <div
          style={{
            color: "var(--tb-n-17)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          Depth Anything
        </div>
        <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
          {MODEL_LABELS[model] ?? model}
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            color:
              status.phase === "error"
                ? "var(--tb-a-red-400)"
                : baked
                ? "var(--tb-a-green-400)"
                : busy
                ? "var(--tb-a-amber-400)"
                : "var(--tb-n-11)",
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

      {/* Progress bar (model download / bake) */}
      {busy && barProgress != null && (
        <div
          style={{
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 3,
            height: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "var(--tb-a-blue-900)",
              height: "100%",
              width: `${barProgress * 100}%`,
              transition: "width 200ms linear",
            }}
          />
        </div>
      )}

      {status.phase === "error" && status.error && (
        <div
          style={{
            padding: "6px 10px",
            background: "color-mix(in srgb, var(--tb-a-red-500) 10%, transparent)",
            border: "1px solid var(--tb-a-red-700)",
            color: "var(--tb-a-red-200)",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {status.error}
        </div>
      )}

      {status.warning && status.phase !== "error" && (
        <div
          style={{
            padding: "6px 10px",
            background: "color-mix(in srgb, var(--tb-a-amber-400) 8%, transparent)",
            border: "1px solid var(--tb-a-amber-800)",
            color: "var(--tb-a-amber-200)",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {status.warning}
        </div>
      )}

      {/* Output toggle (mirrors the node header control) */}
      <Field label="Output">
        <div style={{ display: "flex", gap: 4 }}>
          {(["depth", "normal"] as OutputMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onParamChange(node.id, "outputMode", m)}
              style={{
                flex: 1,
                padding: "4px 8px",
                background: outputMode === m ? "var(--tb-a-blue-900)" : "transparent",
                border: `1px solid ${
                  outputMode === m ? "var(--tb-a-blue-700)" : "var(--tb-n-9)"
                }`,
                color: outputMode === m ? "var(--tb-a-blue-200)" : "var(--tb-n-13)",
                fontFamily: "inherit",
                fontSize: 11,
                borderRadius: 3,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>

      {/* Model + Preview */}
      <Field label="Model">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={model}
            disabled={locked}
            onChange={(e) => onParamChange(node.id, "model", e.target.value)}
            style={{
              flex: 1,
              padding: "3px 6px",
              background: "var(--tb-n-1)",
              border: "1px solid var(--tb-n-7)",
              color: locked ? "var(--tb-n-10)" : "var(--tb-n-16)",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
            }}
          >
            {(Object.keys(MODEL_LABELS) as DepthModelId[]).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
          <SmallButton
            label="Preview"
            disabled={!canPreview}
            onClick={preview}
          />
        </div>
      </Field>

      {/* Quality (inference precision / dtype) */}
      <Field label="Quality">
        <select
          value={precision}
          disabled={locked}
          onChange={(e) => onParamChange(node.id, "precision", e.target.value)}
          style={{
            width: "100%",
            padding: "3px 6px",
            background: "var(--tb-n-1)",
            border: "1px solid var(--tb-n-7)",
            color: locked ? "var(--tb-n-10)" : "var(--tb-n-16)",
            fontFamily: "inherit",
            fontSize: 11,
            borderRadius: 3,
          }}
        >
          {(Object.keys(DTYPE_LABELS) as DepthDtype[]).map((d) => (
            <option key={d} value={d}>
              {DTYPE_LABELS[d]}
            </option>
          ))}
        </select>
      </Field>

      {/* Invert */}
      <Field label="Invert">
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--tb-n-13)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={invert}
            onChange={(e) => onParamChange(node.id, "invert", e.target.checked)}
          />
          Flip near / far
        </label>
      </Field>

      {/* Near / Far (depth display range) */}
      <Field label="Near">
        <Slider
          value={near}
          min={0}
          max={1}
          step={0.001}
          decimals={3}
          onChange={(v) => onParamChange(node.id, "near", v)}
        />
      </Field>
      <Field label="Far">
        <Slider
          value={far}
          min={0}
          max={1}
          step={0.001}
          decimals={3}
          onChange={(v) => onParamChange(node.id, "far", v)}
        />
      </Field>

      {/* Normal strength (normal mode only) */}
      {outputMode === "normal" && (
        <Field label="Strength">
          <Slider
            value={normalStrength}
            min={0}
            max={8}
            step={0.01}
            decimals={2}
            onChange={(v) => onParamChange(node.id, "normalStrength", v)}
          />
        </Field>
      )}

      {/* Bake range */}
      <Field label="In Frame">
        <FrameInput
          value={inFrame}
          disabled={locked}
          onChange={(v) => onParamChange(node.id, "inFrame", v)}
        />
      </Field>
      <Field label="Out Frame">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FrameInput
            value={outFrame}
            disabled={locked}
            onChange={(v) => onParamChange(node.id, "outFrame", v)}
          />
          {sceneFrames != null && !locked && (
            <SmallButton
              label="End"
              disabled={false}
              onClick={() =>
                onParamChange(
                  node.id,
                  "outFrame",
                  Math.max(inFrame, Math.round(sceneFrames) - 1)
                )
              }
            />
          )}
        </div>
      </Field>

      {/* Bake / Free Bake */}
      <div style={{ display: "flex", gap: 6 }}>
        {baked ? (
          <ActionButton
            label="Free Bake"
            enabled={!busy}
            onClick={() => freeBake(node.id)}
          />
        ) : status.phase === "baking" ? (
          <ActionButton
            label="Cancel Bake"
            enabled
            onClick={() => {
              cancelRef.current = true;
            }}
          />
        ) : (
          <ActionButton label="Bake" enabled={canBake} onClick={() => void bake()} />
        )}
      </div>

      <div style={{ color: "var(--tb-n-10)", fontSize: 10, lineHeight: 1.5 }}>
        <i>Preview</i> estimates depth on the current frame (first run downloads
        the model, cached afterwards). For moving footage, <i>Bake</i> plays
        through the in/out range and caches a depth map per frame, normalized to
        one range across the whole clip so brightness stays stable (no
        flicker). The bake is held in memory for this session — it isn&apos;t
        saved with the project, so reopen → re-bake. <i>Quality</i> sets the
        model precision (fp32 is sharpest; q8 is fastest but blocky). The header
        toggle (and Output above) switch between the depth map and a normal map.
      </div>
    </div>
  );
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
        stroke="var(--tb-a-amber-400)"
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
          color: "var(--tb-n-13)",
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

function Slider({
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
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
          color: "var(--tb-n-13)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
          width: 40,
          textAlign: "right",
        }}
      >
        {value.toFixed(decimals)}
      </span>
    </div>
  );
}

function FrameInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  // Draft only exists while focused — idle, the live value shows through,
  // so no draft-sync effect is needed when the value changes externally.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const p = evalNumExpr(draft); // plain numbers or math: "24*8", "300/2"
    const n = p === null ? NaN : Math.max(0, Math.round(p));
    if (Number.isFinite(n) && n !== value) onChange(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={editing ? draft : String(value)}
      disabled={disabled}
      onFocus={() => {
        setDraft(String(value));
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 72,
        padding: "3px 6px",
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-7)",
        color: disabled ? "var(--tb-n-10)" : "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        borderRadius: 3,
      }}
    />
  );
}

function SmallButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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

function ActionButton({
  label,
  enabled,
  onClick,
}: {
  label: string;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      style={{
        flex: 1,
        padding: "6px 10px",
        background: enabled ? "var(--tb-a-blue-900)" : "transparent",
        border: `1px solid ${enabled ? "var(--tb-a-blue-700)" : "var(--tb-n-9)"}`,
        color: enabled ? "var(--tb-a-blue-200)" : "var(--tb-n-10)",
        fontFamily: "inherit",
        fontSize: 11,
        borderRadius: 3,
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? 1 : 0.6,
      }}
    >
      {label}
    </button>
  );
}
