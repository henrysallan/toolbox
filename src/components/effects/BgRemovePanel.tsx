"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Edge, Node } from "@xyflow/react";
import { evalNumExpr } from "@/lib/num-expr";
import type { NodeDataPayload } from "@/state/graph";
import type { BgModelId, BgProgress } from "@/lib/ai/bg-remove";
import {
  isRvmModel,
  type RvmDownsample,
  type RvmModelId,
  type RvmRecState,
} from "@/lib/ai/rvm";
import {
  addBakeFrame,
  beginBake,
  commitBake,
  freeBake,
  getRvmStatus,
  getRvmStoreRev,
  getScopedFrame,
  isRvmBaked,
  isRvmLocked,
  runLivePreview,
  setRvmStatusBusy,
  subscribeRvmStore,
} from "@/lib/ai/rvm-session";

export interface BgRemovePanelProps {
  node: Node<NodeDataPayload>;
  edges: Edge[];
  getRefImageBlob?: (sourceNodeId: string) => Promise<Blob | null>;
  captureNodeFrames?: (
    sourceNodeId: string,
    frames: number[],
    onFrame: (frame: number, blob: Blob) => Promise<boolean | void>
  ) => Promise<void>;
  sceneFrames?: number;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
}

const MODEL_LABELS: Record<BgModelId, string> = {
  "rmbg-1.4": "RMBG 1.4 (still)",
  "rmbg-2.0": "RMBG 2.0 (still)",
  "rvm-mobilenetv3": "RVM MobileNetV3 (video)",
  "rvm-resnet50": "RVM ResNet50 (video)",
};

const DOWNSAMPLE_LABELS: Record<RvmDownsample, string> = {
  auto: "Auto (max 512)",
  "0.125": "0.125 (4K portrait)",
  "0.25": "0.25 (1080p portrait)",
  "0.375": "0.375 (720p)",
  "0.5": "0.5",
  "1": "1 (native)",
};

export default function BgRemovePanel({
  node,
  edges,
  getRefImageBlob,
  captureNodeFrames,
  sceneFrames,
  onParamChange,
}: BgRemovePanelProps) {
  useSyncExternalStore(subscribeRvmStore, getRvmStoreRev, getRvmStoreRev);

  const model = (node.data.params.model as BgModelId) ?? "rmbg-1.4";
  const rvm = isRvmModel(model);
  const feather = (node.data.params.feather as number) ?? 0;
  const threshold = (node.data.params.threshold as number) ?? 0.5;
  const downsample = ((node.data.params.downsample as RvmDownsample) ??
    "auto") as RvmDownsample;
  const inFrame = Math.max(
    0,
    Math.round((node.data.params.inFrame as number) ?? 0)
  );
  const outFrame = Math.max(
    inFrame,
    Math.round((node.data.params.outFrame as number) ?? 120)
  );

  const rmbgBaked =
    !!node.data.params.bakedSource && !!node.data.params.bakedMask;
  const rvmBaked = isRvmBaked(node.id);
  const rvmLocked = isRvmLocked(node.id);
  const rvmStatus = getRvmStatus(node.id);

  const [progress, setProgress] = useState<BgProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const upstreamId = useMemo(() => {
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle === "in:image") {
        return e.source;
      }
    }
    return null;
  }, [edges, node.id]);

  const rvmBusy =
    rvmStatus.phase === "loading-model" ||
    rvmStatus.phase === "running" ||
    rvmStatus.phase === "baking";
  const rmbgBusy = progress !== null;
  const busy = rvm ? rvmBusy : rmbgBusy;

  const changeModel = (next: string) => {
    if (isRvmModel(model) && !isRvmModel(next)) {
      freeBake(node.id);
    }
    if (!isRvmModel(model) && isRvmModel(next)) {
      onParamChange(node.id, "bakedSource", null);
      onParamChange(node.id, "bakedMask", null);
    }
    onParamChange(node.id, "model", next);
    setError(null);
  };

  const bakeRmbg = async () => {
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
        model: model === "rmbg-2.0" ? "rmbg-2.0" : "rmbg-1.4",
        onProgress: (p) => setProgress(p),
      });
      onParamChange(node.id, "bakedSource", out.source);
      onParamChange(node.id, "bakedMask", out.mask);
      setProgress(null);
      window.dispatchEvent(new Event("pipeline-bump"));
    } catch (e) {
      setError((e as Error).message ?? "Bake failed.");
      setProgress(null);
    }
  };

  const clearRmbgBake = () => {
    onParamChange(node.id, "bakedSource", null);
    onParamChange(node.id, "bakedMask", null);
    setError(null);
    window.dispatchEvent(new Event("pipeline-bump"));
  };

  const previewRvm = () => {
    if (!upstreamId || !getRefImageBlob) return;
    void runLivePreview(
      node.id,
      () => getRefImageBlob(upstreamId),
      model as RvmModelId,
      downsample
    );
  };

  const bakeRvm = async () => {
    if (!upstreamId || !captureNodeFrames) return;
    const frames: number[] = [];
    for (let f = inFrame; f <= outFrame; f++) frames.push(f);
    cancelRef.current = false;
    beginBake(node.id, frames.length);
    let rec: RvmRecState | null = null;
    try {
      const { mattingFrame, blobHash, freeRvmRec } = await import("@/lib/ai/rvm");
      const captured: Array<{
        globalFrame: number;
        scoped: number | null;
        png: Blob;
      }> = [];
      const hashes = new Set<string>();
      await captureNodeFrames(upstreamId, frames, async (frame, blob) => {
        if (cancelRef.current) return false;
        hashes.add(await blobHash(blob));
        const out = await mattingFrame(blob, rec, {
          model: model as RvmModelId,
          downsample,
        });
        rec = out.rec;
        captured.push({
          globalFrame: frame,
          scoped: getScopedFrame(node.id),
          png: out.png,
        });
        setRvmStatusBusy(node.id, {
          phase: "baking",
          frameDone: captured.length,
          frameTotal: frames.length,
        });
        return !cancelRef.current;
      });
      if (cancelRef.current) {
        freeRvmRec(rec);
        freeBake(node.id);
        return;
      }
      const scopedOk =
        captured.length > 0 &&
        captured.every(
          (c, i) =>
            c.scoped != null && (i === 0 || c.scoped > captured[i - 1].scoped!)
        );
      for (const c of captured) {
        addBakeFrame(
          node.id,
          scopedOk ? (c.scoped as number) : c.globalFrame,
          c.png
        );
      }
      freeRvmRec(rec);
      commitBake(
        node.id,
        captured.length > 1 && hashes.size === 1
          ? "Every captured frame had identical pixels — the input may not be animating over this range."
          : undefined
      );
    } catch (e) {
      const { freeRvmRec } = await import("@/lib/ai/rvm");
      freeRvmRec(rec);
      freeBake(node.id, (e as Error)?.message ?? "Bake failed.");
    }
  };

  const baked = rvm ? rvmBaked : rmbgBaked;
  const canRmbgBake = !!upstreamId && !busy;
  const canRvmPreview =
    !!upstreamId && !!getRefImageBlob && !busy && !rvmLocked;
  const canRvmBake = !!upstreamId && !!captureNodeFrames && !busy && !rvmBaked;

  const statusText = (() => {
    if (rvm) {
      switch (rvmStatus.phase) {
        case "loading-model":
          return rvmStatus.progress != null
            ? `Loading model… ${Math.round(rvmStatus.progress * 100)}%`
            : "Loading model…";
        case "running":
          return "Running…";
        case "baking":
          return `Baking ${rvmStatus.frameDone ?? 0}/${rvmStatus.frameTotal ?? 0}`;
        case "error":
          return "Error";
        default:
          return rvmBaked
            ? `Baked ${inFrame}–${outFrame}`
            : !upstreamId
            ? "Wire an Image input"
            : "Preview or bake a range";
      }
    }
    if (rmbgBusy) return phaseLabel(progress);
    if (rmbgBaked) return "Baked";
    if (upstreamId) return "Not baked";
    return "Wire an Image input";
  })();

  const barProgress = rvm
    ? rvmStatus.phase === "baking" && rvmStatus.frameTotal
      ? (rvmStatus.frameDone ?? 0) / rvmStatus.frameTotal
      : rvmStatus.phase === "loading-model"
      ? rvmStatus.progress ?? null
      : null
    : progress?.phase === "loading-model"
    ? progress.progress ?? null
    : null;

  const displayError = rvm
    ? rvmStatus.phase === "error"
      ? rvmStatus.error
      : null
    : error;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
          Background Remove
        </div>
        <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
          {MODEL_LABELS[model] ?? model}
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            color:
              displayError
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

      {displayError && (
        <div
          style={{
            padding: "6px 10px",
            background:
              "color-mix(in srgb, var(--tb-a-red-500) 10%, transparent)",
            border: "1px solid var(--tb-a-red-700)",
            color: "var(--tb-a-red-200)",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {displayError}
        </div>
      )}

      {rvm && rvmStatus.warning && rvmStatus.phase !== "error" && (
        <div
          style={{
            padding: "6px 10px",
            background:
              "color-mix(in srgb, var(--tb-a-amber-400) 8%, transparent)",
            border: "1px solid var(--tb-a-amber-800)",
            color: "var(--tb-a-amber-200)",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {rvmStatus.warning}
        </div>
      )}

      <Field label="Model">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={model}
            disabled={rvm ? rvmLocked : rmbgBusy}
            onChange={(e) => changeModel(e.target.value)}
            style={{
              flex: 1,
              padding: "3px 6px",
              background: "var(--tb-n-1)",
              border: "1px solid var(--tb-n-7)",
              color: rvm && rvmLocked ? "var(--tb-n-10)" : "var(--tb-n-16)",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
            }}
          >
            {(Object.keys(MODEL_LABELS) as BgModelId[]).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
          {rvm && (
            <SmallButton
              label="Preview"
              disabled={!canRvmPreview}
              onClick={previewRvm}
            />
          )}
        </div>
      </Field>

      {rvm && (
        <Field label="Downsample">
          <select
            value={downsample}
            disabled={rvmLocked}
            onChange={(e) =>
              onParamChange(node.id, "downsample", e.target.value)
            }
            style={{
              width: "100%",
              padding: "3px 6px",
              background: "var(--tb-n-1)",
              border: "1px solid var(--tb-n-7)",
              color: rvmLocked ? "var(--tb-n-10)" : "var(--tb-n-16)",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
            }}
          >
            {(Object.keys(DOWNSAMPLE_LABELS) as RvmDownsample[]).map((d) => (
              <option key={d} value={d}>
                {DOWNSAMPLE_LABELS[d]}
              </option>
            ))}
          </select>
        </Field>
      )}

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

      {rvm && (
        <>
          <Field label="In Frame">
            <FrameInput
              value={inFrame}
              disabled={rvmLocked}
              onChange={(v) => onParamChange(node.id, "inFrame", v)}
            />
          </Field>
          <Field label="Out Frame">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <FrameInput
                value={outFrame}
                disabled={rvmLocked}
                onChange={(v) => onParamChange(node.id, "outFrame", v)}
              />
              {sceneFrames != null && !rvmLocked && (
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
        </>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        {rvm ? (
          rvmBaked ? (
            <ActionButton
              label="Free Bake"
              enabled={!busy}
              onClick={() => freeBake(node.id)}
            />
          ) : rvmStatus.phase === "baking" ? (
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
              enabled={canRvmBake}
              onClick={() => void bakeRvm()}
            />
          )
        ) : (
          <>
            <ActionButton
              label={rmbgBaked ? "Re-bake" : "Bake"}
              enabled={canRmbgBake}
              onClick={() => void bakeRmbg()}
            />
            {rmbgBaked && (
              <button
                type="button"
                onClick={clearRmbgBake}
                disabled={busy}
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  border: "1px solid var(--tb-n-9)",
                  color: "var(--tb-n-13)",
                  fontFamily: "inherit",
                  fontSize: 11,
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ color: "var(--tb-n-10)", fontSize: 10, lineHeight: 1.5 }}>
        {rvm ? (
          <>
            <i>Preview</i> mattes the current frame. <i>Bake</i> walks the
            in/out range sequentially, recycling RVM&apos;s recurrent states so
            the alpha stays temporally consistent. RGB comes from the live
            input — the bake stores masks only (session-only: reopen → re-bake).
            First run downloads ~14 MB, cached afterwards. Tweaking{" "}
            <i>feather</i> / <i>threshold</i> is free.
          </>
        ) : (
          <>
            Bake runs RMBG in your browser via Transformers.js. The first run
            downloads ~177 MB ({model}) which is cached for future runs.
            Tweaking <i>feather</i> / <i>threshold</i> afterwards is free — no
            re-bake needed. Upstream changes are ignored until you re-bake.
          </>
        )}
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
          color: "var(--tb-n-13)",
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

function FrameInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const p = evalNumExpr(draft);
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
