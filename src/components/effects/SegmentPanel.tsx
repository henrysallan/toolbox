"use client";

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { SegmentDot } from "@/lib/ai/segment";
import type { AutoMethod } from "@/lib/ai/segment-auto";
import {
  addBakeMask,
  beginBake,
  clearLiveSegment,
  commitBake,
  freeBake,
  getScopedFrame,
  getSegmentStatus,
  getSegmentStoreRev,
  isSegmentBaked,
  isSegmentLocked,
  runLiveSegment,
  setLiveMask,
  setSegmentStatusBusy,
  setSegmentStatusError,
  subscribeSegmentStore,
} from "@/lib/ai/segment-session";

// Custom param panel for the Segment Anything node.
//
// Modes: "dots" prompts SlimSAM with canvas clicks (SegmentDotsOverlay);
// the auto modes (semantic / panoptic / grid) need no points and produce a
// multicolor segment map driven by the Levels count. All modes share the
// in/out bake range and the Bake ↔ Free Bake lifecycle. Mask state lives
// in the session store — this panel renders whatever the store reports.

type SegMode = "dots" | AutoMethod;

const MODE_LABELS: Record<SegMode, string> = {
  dots: "Dots (SAM)",
  semantic: "Semantic (SegFormer)",
  panoptic: "Panoptic (DETR)",
  grid: "Auto Grid (SAM)",
};

export interface SegmentPanelProps {
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
  fps: number;
  // Scene length in frames — used as the "to end" convenience for the out
  // frame field.
  sceneFrames?: number;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
}

export default function SegmentPanel({
  node,
  edges,
  getRefImageBlob,
  captureNodeFrames,
  sceneFrames,
  onParamChange,
}: SegmentPanelProps) {
  // Re-render on any session-store change (status, bake lifecycle).
  useSyncExternalStore(
    subscribeSegmentStore,
    getSegmentStoreRev,
    getSegmentStoreRev
  );

  const mode = ((node.data.params.mode as SegMode) ?? "dots") as SegMode;
  const dots = (node.data.params.dots as SegmentDot[]) ?? [];
  const levels = Math.max(
    2,
    Math.round((node.data.params.levels as number) ?? 6)
  );
  const feather = (node.data.params.feather as number) ?? 0;
  const threshold = (node.data.params.threshold as number) ?? 0.5;
  const inFrame = Math.max(
    0,
    Math.round((node.data.params.inFrame as number) ?? 0)
  );
  const outFrame = Math.max(
    inFrame,
    Math.round((node.data.params.outFrame as number) ?? 120)
  );

  const status = getSegmentStatus(node.id);
  const baked = isSegmentBaked(node.id);
  const locked = isSegmentLocked(node.id);
  const busy =
    status.phase === "loading-model" ||
    status.phase === "embedding" ||
    status.phase === "segmenting" ||
    status.phase === "baking";

  // Cooperative cancel for an in-flight bake — flips the onFrame callback
  // into returning false, which stops the frame-stepper.
  const cancelRef = useRef(false);

  const upstreamId = useMemo(() => {
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle === "in:image") {
        return e.source;
      }
    }
    return null;
  }, [edges, node.id]);

  const promptReady = mode === "dots" ? dots.length > 0 : true;

  const segmentNow = async () => {
    if (!upstreamId || !getRefImageBlob || !promptReady) return;
    if (mode === "dots") {
      void runLiveSegment(node.id, dots, () => getRefImageBlob(upstreamId));
      return;
    }
    // Auto-mode live preview on the current frame.
    setSegmentStatusBusy(node.id, { phase: "segmenting" });
    try {
      const blob = await getRefImageBlob(upstreamId);
      if (!blob) {
        setSegmentStatusError(
          node.id,
          "Couldn't read the upstream image — make the Segment node's chain visible on the canvas, then retry."
        );
        return;
      }
      const auto = await import("@/lib/ai/segment-auto");
      const seg = await import("@/lib/ai/segment");
      const matcher = new auto.SegmentSlotMatcher();
      const index = await auto.autoSegmentFrame(
        mode,
        blob,
        levels,
        matcher,
        (p) => {
          if (p.phase === "loading-runtime" || p.phase === "loading-model") {
            setSegmentStatusBusy(node.id, {
              phase: "loading-model",
              progress: p.progress,
            });
          }
        }
      );
      const bitmap = await seg.maskToBitmap(index);
      setLiveMask(node.id, bitmap, "index");
    } catch (e) {
      setSegmentStatusError(
        node.id,
        (e as Error)?.message ?? "Segmentation failed."
      );
    }
  };

  const clearDots = () => {
    onParamChange(node.id, "dots", []);
    clearLiveSegment(node.id);
  };

  const changeMode = (next: string) => {
    onParamChange(node.id, "mode", next);
    // The live mask belongs to the previous mode's prompt — drop it so the
    // canvas doesn't show a stale kind.
    clearLiveSegment(node.id);
  };

  const bake = async () => {
    if (!upstreamId || !captureNodeFrames || !promptReady) return;
    const frames: number[] = [];
    for (let f = inFrame; f <= outFrame; f++) frames.push(f);
    cancelRef.current = false;
    beginBake(node.id, mode === "dots" ? "alpha" : "index", frames.length);
    try {
      const seg = await import("@/lib/ai/segment");
      const auto =
        mode === "dots" ? null : await import("@/lib/ai/segment-auto");
      // One matcher across the whole bake = stable segment identities
      // (colors) from frame to frame.
      const matcher = auto ? new auto.SegmentSlotMatcher() : null;
      const captureHashes = new Set<string>();
      // Buffered until capture finishes: the masks are keyed by the NODE'S
      // OWN clock (layer-local frame, recorded by its compute during the
      // renders we drive) — global frame numbers don't match the node's
      // lookups when it sits inside an offset layer. The scoped clock is
      // only trustworthy if it actually ADVANCED across the capture (a
      // node outside the rendered chain reports a frozen value), so the
      // keying decision happens after the loop.
      const captured: Array<{
        globalFrame: number;
        scoped: number | null;
        png: Blob;
      }> = [];
      let bytes = 0;
      await captureNodeFrames(upstreamId, frames, async (frame, blob) => {
        if (cancelRef.current) return false;
        // Detect a bake that captured the same pixels every frame — the
        // classic symptom of the upstream not actually animating over the
        // range (or not being time-synced).
        captureHashes.add(await seg.blobHash(blob));
        let png: Blob;
        if (mode === "dots") {
          // One encoder pass per frame (the bake's real cost), then the
          // cheap per-dot decoder + union.
          const emb = await seg.embedImage(blob);
          const mask = await seg.decodeDots(emb, dots);
          png = await seg.maskToPngBlob(mask);
        } else {
          const index = await auto!.autoSegmentFrame(
            mode,
            blob,
            levels,
            matcher!
          );
          png = await seg.maskToPngBlob(index);
        }
        // Early per-node budget check so a runaway bake aborts mid-flight
        // (the store re-checks the cross-node total on insert below).
        bytes += png.size;
        const { MAX_BAKE_BYTES } = await import("@/lib/ai/segment-session");
        if (bytes > MAX_BAKE_BYTES) {
          throw new Error(
            `Bake cache exceeded ${Math.round(
              MAX_BAKE_BYTES / (1024 * 1024)
            )} MB — try a shorter frame range or a lower input resolution.`
          );
        }
        captured.push({
          globalFrame: frame,
          scoped: getScopedFrame(node.id),
          png,
        });
        setSegmentStatusBusy(node.id, {
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
      // Trust the scoped clock only if it advanced strictly with the
      // capture; otherwise fall back to global frames.
      const scopedOk =
        captured.length > 0 &&
        captured.every(
          (c, i) =>
            c.scoped != null && (i === 0 || c.scoped > captured[i - 1].scoped!)
        );
      for (const c of captured) {
        addBakeMask(
          node.id,
          scopedOk ? (c.scoped as number) : c.globalFrame,
          c.png
        );
      }
      commitBake(
        node.id,
        captured.length > 1 && captureHashes.size === 1
          ? "Every captured frame was identical — the input may not be animating over this range."
          : undefined
      );
    } catch (e) {
      freeBake(node.id, (e as Error)?.message ?? "Bake failed.");
    }
  };

  const canSegment = !!upstreamId && promptReady && !busy && !locked;
  const canBake =
    !!upstreamId && !!captureNodeFrames && promptReady && !busy && !baked;

  const statusText = (() => {
    switch (status.phase) {
      case "loading-model":
        return status.progress != null
          ? `Loading model… ${Math.round(status.progress * 100)}%`
          : "Loading model…";
      case "embedding":
        return "Encoding image…";
      case "segmenting":
        return "Segmenting…";
      case "baking":
        return `Baking ${status.frameDone ?? 0}/${status.frameTotal ?? 0}`;
      case "error":
        return "Error";
      default:
        return baked
          ? `Baked ${inFrame}–${outFrame}`
          : !upstreamId
          ? "Wire an Image input"
          : mode === "dots" && dots.length === 0
          ? "Click the canvas to place dots"
          : "Live";
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
          Segment Anything
        </div>
        <div style={{ color: "#52525b", fontSize: 10 }}>
          {MODE_LABELS[mode] ?? mode}
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            color:
              status.phase === "error"
                ? "#f87171"
                : baked
                ? "#4ade80"
                : busy
                ? "#fbbf24"
                : "#71717a",
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
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid #b91c1c",
            color: "#fecaca",
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
            background: "rgba(251, 191, 36, 0.08)",
            border: "1px solid #92400e",
            color: "#fde68a",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {status.warning}
        </div>
      )}

      {/* Mode */}
      <Field label="Mode">
        <select
          value={mode}
          disabled={locked}
          onChange={(e) => changeMode(e.target.value)}
          style={{
            width: "100%",
            padding: "3px 6px",
            background: "#0f0f12",
            border: "1px solid #27272a",
            color: locked ? "#52525b" : "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 11,
            borderRadius: 3,
          }}
        >
          {(Object.keys(MODE_LABELS) as SegMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </Field>

      {/* Dots row (dots mode) */}
      {mode === "dots" && (
        <Field label="Dots">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#a1a1aa", fontSize: 11, flex: 1 }}>
              {dots.length === 0
                ? "none — click the canvas"
                : `${dots.length} dot${dots.length === 1 ? "" : "s"}`}
              {locked && " (locked by bake)"}
            </span>
            <SmallButton
              label="Segment"
              disabled={!canSegment}
              onClick={() => void segmentNow()}
            />
            <SmallButton
              label="Clear"
              disabled={dots.length === 0 || busy || locked}
              onClick={clearDots}
            />
          </div>
        </Field>
      )}

      {/* Levels + preview (auto modes) */}
      {mode !== "dots" && (
        <Field label="Levels">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Slider
                value={levels}
                min={2}
                max={32}
                step={1}
                decimals={0}
                onChange={(v) =>
                  onParamChange(node.id, "levels", Math.round(v))
                }
              />
            </div>
            <SmallButton
              label="Segment"
              disabled={!canSegment}
              onClick={() => void segmentNow()}
            />
          </div>
        </Field>
      )}

      {/* Live edge params (alpha masks only) */}
      {mode === "dots" && (
        <>
          <Field label="Feather">
            <Slider
              value={feather}
              min={0}
              max={1}
              step={0.001}
              decimals={3}
              onChange={(v) => onParamChange(node.id, "feather", v)}
            />
          </Field>
          <Field label="Threshold">
            <Slider
              value={threshold}
              min={0.1}
              max={0.9}
              step={0.01}
              decimals={3}
              onChange={(v) => onParamChange(node.id, "threshold", v)}
            />
          </Field>
        </>
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
          <ActionButton
            label="Bake"
            enabled={canBake}
            onClick={() => void bake()}
          />
        )}
      </div>

      <div style={{ color: "#52525b", fontSize: 10, lineHeight: 1.5 }}>
        {mode === "dots" ? (
          <>
            Click the canvas to drop dots on what you want to keep — each dot
            adds another object; click a dot to remove it. The mask previews
            on the current frame.
          </>
        ) : mode === "semantic" ? (
          <>
            Labels every pixel by class (person, sky, building, …) — colors
            are stable across video by construction. <i>Levels</i> keeps the
            N largest classes.
          </>
        ) : mode === "panoptic" ? (
          <>
            Separates object instances (two people = two colors), matched
            across frames by overlap. <i>Levels</i> keeps the N largest
            segments.
          </>
        ) : (
          <>
            Prompts SAM with a point grid each frame and keeps the
            <i> Levels</i> best segments — class-agnostic but the slowest
            per frame.
          </>
        )}{" "}
        For moving footage, <i>Bake</i> plays through the in/out range and
        caches a mask per frame (first run downloads the model, cached
        afterwards). The bake is held in memory for this session — it
        isn&apos;t saved with the project, so reopen → re-bake. The grayscale
        id-map aux pipes into a Color Ramp for custom palettes.
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
          color: "#a1a1aa",
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
  return (
    <input
      type="number"
      min={0}
      step={1}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const v = Math.max(0, Math.round(parseFloat(e.target.value)));
        if (Number.isFinite(v)) onChange(v);
      }}
      style={{
        width: 72,
        padding: "3px 6px",
        background: "#0f0f12",
        border: "1px solid #27272a",
        color: disabled ? "#52525b" : "#e5e7eb",
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
        border: "1px solid #3f3f46",
        color: disabled ? "#52525b" : "#a1a1aa",
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
        background: enabled ? "#1e3a8a" : "transparent",
        border: `1px solid ${enabled ? "#1d4ed8" : "#3f3f46"}`,
        color: enabled ? "#bfdbfe" : "#52525b",
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
