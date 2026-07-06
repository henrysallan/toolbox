"use client";

// Shared parameter-control UI. Extracted verbatim from ParamPanel so the
// editor AND the live viewer / exported standalone apps render parameters
// with identical UI. Lives under @/lib so the Vite export bundle (which has
// no @/components alias) can import it. Keep it free of editor-only deps
// (graph state, heavy Supabase/MediaPipe panels) — KeyframeDiamond is the
// only @/components import and is itself a bundle-safe leaf.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AutoLayoutItem,
  CsvFileParamValue,
  ExprInput,
  GradientPoint,
  LutFileParamValue,
  ParamDef,
  SizeMode,
} from "@/engine/types";
import { parseCsv, type CsvDelimiter } from "@/engine/csv-parse";
import { newExprInput } from "@/nodes/effect/expression";
import {
  gpointCKey,
  gpointXKey,
  gpointYKey,
  layerOpacityKey,
} from "@/engine/conventions";
import {
  COLOR_RAMP_MAX_STOPS,
  newStopId,
  type ColorRampStop,
} from "@/nodes/effect/color-ramp";
import { BLEND_MODE_ORDER, blendModeLabel } from "@/nodes/effect/merge";
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
import {
  diamondStateFor,
  findKeyframeAt,
  removeKeyframeAt,
  upsertKeyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import KeyframeDiamond from "@/components/effects/KeyframeDiamond";

export function DampenedRangeInput(
  props: Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "onChange"
  > & {
    value: number;
    onChange: (next: number) => void;
    shiftFactor?: number;
  }
) {
  const { value, onChange, shiftFactor = 0.1, ...rest } = props;
  const dragRef = useRef<{ lastNative: number } | null>(null);
  const shiftRef = useRef(false);

  // RAF-coalescing for the parent onChange. iPad / Apple Pencil
  // input events fire faster than 60Hz (Pencil Pro: ~120Hz), and
  // each parent update cascades into a React re-render + pipeline
  // re-eval — enough to drop frame rate noticeably during a slider
  // drag. Coalescing means we still see every native event for
  // dampening math (no precision loss), but the parent only sees
  // one update per animation frame with the latest value.
  //
  // Stable refs so the effect cleanup can flush + cancel reliably
  // even after re-renders swap the closure.
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const flush = useCallback(() => {
    rafRef.current = null;
    if (pendingRef.current !== null) {
      const v = pendingRef.current;
      pendingRef.current = null;
      onChangeRef.current(v);
    }
  }, []);
  const queueChange = useCallback(
    (v: number) => {
      pendingRef.current = v;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    },
    [flush]
  );
  const flushNow = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current !== null) {
      const v = pendingRef.current;
      pendingRef.current = null;
      onChangeRef.current(v);
    }
  }, []);
  useEffect(() => {
    return () => {
      // On unmount, drop any pending RAF — re-render of the param
      // panel (e.g. selection switch) shouldn't leak a callback into
      // a stale onChange closure. Last value would have been written
      // by the most recent rAF anyway; if the user was mid-drag,
      // pointerup already flushed.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);
  return (
    <input
      type="range"
      {...rest}
      value={value}
      onPointerDown={(e) => {
        const native = parseFloat((e.target as HTMLInputElement).value);
        dragRef.current = { lastNative: native };
      }}
      onPointerUp={() => {
        dragRef.current = null;
        // Flush any in-flight pending change immediately so the
        // pointerup commit sees the user's final value, not the
        // value from the last RAF tick (which can lag by ~16ms).
        flushNow();
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        flushNow();
      }}
      onChange={(e) => {
        const native = parseFloat(e.target.value);
        if (Number.isNaN(native)) return;
        if (dragRef.current) {
          const delta = native - dragRef.current.lastNative;
          dragRef.current.lastNative = native;
          const factor = shiftRef.current ? shiftFactor : 1;
          queueChange(value + delta * factor);
        } else {
          // Click-to-set or keyboard arrow — no anchor, apply
          // directly without coalescing (single discrete event).
          onChange(native);
        }
      }}
    />
  );
}

export function LoadFileButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 14px",
        borderRadius: 999,
        background: hover ? "#1e376b" : "#172a52",
        border: "1px solid #2563eb",
        color: "#bfdbfe",
        fontFamily: "inherit",
        fontSize: 11,
        cursor: "pointer",
        whiteSpace: "nowrap",
        transition: "background 90ms",
      }}
    >
      {label}
    </button>
  );
}

// Shared chip showing a circular thumbnail + file name for a loaded asset.
export function LoadedFilePill({
  thumb,
  name,
}: {
  thumb: React.ReactNode;
  name: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 12px 3px 3px",
        borderRadius: 999,
        background: "#18181b",
        border: "1px solid #27272a",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      {thumb}
      <span
        style={{
          color: "#d4d4d8",
          fontSize: 10,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {name}
      </span>
    </div>
  );
}

// Custom panel for the Render Queue node. Lists the wired Output nodes as a
// reorderable queue with inline filename / frame editing (edits backfill the
// Output node), a per-row image/video type, a delivery-mode gear popover, and
// the one-button batch Render trigger. Reordering writes the `items` param,
// which re-derives the node's input-socket order via resolveInputs.
export function MatchAspectButton({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  if (!(width > 0 && height > 0)) return null;
  return (
    <button
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("project-match-aspect", {
            detail: { width, height },
          })
        )
      }
      title="Set the project's aspect ratio to match this source (keeps the current longest side)"
      style={{
        background: "#27272a",
        border: "1px solid #3f3f46",
        color: "#d4d4d8",
        fontFamily: "inherit",
        fontSize: 10,
        padding: "4px 8px",
        borderRadius: 4,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      Match Aspect
    </button>
  );
}

// Caret that flanks the keyframe diamond to jump the playhead to the
// previous / next keyframe on the parameter. Disabled (and dimmed) when
// there's no keyframe in that direction.
export function ImageFileControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const bitmap =
    typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap
      ? value
      : null;
  const fileName = bitmap
    ? (bitmap as unknown as { fileName?: string }).fileName ?? "image"
    : null;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const bmp = await createImageBitmap(file);
          try {
            (bmp as unknown as { fileName?: string }).fileName = file.name;
          } catch {
            // Some engines freeze ImageBitmap; the name is cosmetic, so
            // a failure here just falls back to the generic label.
          }
          onChange(bmp);
        }}
      />
      <LoadFileButton
        label="Load Image"
        onClick={() => inputRef.current?.click()}
      />
      {bitmap && fileName && (
        <LoadedFilePill thumb={<BitmapThumb bitmap={bitmap} />} name={fileName} />
      )}
      {bitmap && (
        <MatchAspectButton width={bitmap.width} height={bitmap.height} />
      )}
    </div>
  );
}

// Video `video_file` param control. Mirrors the image control; the
// thumbnail is drawn from the live <video> element's current frame.
export function VideoFileControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const current =
    (value as import("@/engine/types").VideoFileParamValue | null | undefined) ??
    null;
  const applyFile = async (file: File) => {
    const { registerVideoFile, disposeVideoFile } = await import(
      "@/lib/video"
    );
    const v = await registerVideoFile(file);
    // Release the previous clip's <video>/ObjectURL — replacing via
    // the button is the only path now that the clear button is gone.
    if (current) {
      try {
        disposeVideoFile(current);
      } catch {
        // Already disposed / not registered — nothing to free.
      }
    }
    onChange(v);
  };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await applyFile(file);
        }}
      />
      <LoadFileButton
        label="Load Video"
        onClick={async () => {
          // Prefer the File System Access picker — it yields a persistable
          // handle so reopening the project can auto-relink this clip.
          // Browsers without it fall back to the plain file input.
          const { pickMediaFiles } = await import("@/lib/media-relink");
          const picked = await pickMediaFiles({ kind: "video" });
          if (picked === "unsupported") {
            inputRef.current?.click();
            return;
          }
          if (picked?.[0]) await applyFile(picked[0]);
        }}
      />
      {current && (
        <LoadedFilePill
          thumb={<VideoThumb video={current.video} />}
          name={current.filename ?? "video"}
        />
      )}
      {current && (
        <MatchAspectButton width={current.width} height={current.height} />
      )}
    </div>
  );
}

// Thumbnail for an image sequence — decodes frame 0 once and reuses
// BitmapThumb. Falls back to a neutral chip while decoding / on failure.
export function SequenceThumb({
  seq,
}: {
  seq: import("@/engine/types").ImageSequenceParamValue;
}) {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    let alive = true;
    let local: ImageBitmap | null = null;
    createImageBitmap(seq.frames[0].blob)
      .then((b) => {
        if (alive) {
          local = b;
          setBmp(b);
        } else {
          b.close();
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (local) local.close();
    };
  }, [seq]);
  return bmp ? (
    <BitmapThumb bitmap={bmp} />
  ) : (
    <div style={{ width: 24, height: 24, borderRadius: 4, background: "#27272a" }} />
  );
}

// Image-sequence `image_sequence` param control. Multi-select numbered
// stills; registerImageSequence parses the trailing frame numbers, sorts,
// and keeps the encoded bytes (the Video Source node decodes lazily). Not
// auto-relinkable (multi-file picks yield no persistable handle).
export function ImageSequenceControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const current =
    (value as import("@/engine/types").ImageSequenceParamValue | null | undefined) ??
    null;
  const applyFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { registerImageSequence } = await import("@/lib/image-sequence");
    try {
      const { value: v, skipped } = await registerImageSequence(files);
      onChange(v);
      if (skipped.length) {
        console.warn(
          "Image sequence: skipped files without a trailing number:",
          skipped
        );
      }
    } catch (e) {
      console.error("Image sequence load failed:", e);
    }
  };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) await applyFiles(files);
        }}
      />
      <LoadFileButton
        label="Load Sequence"
        onClick={() => inputRef.current?.click()}
      />
      {current && current.frames.length > 0 && (
        <LoadedFilePill
          thumb={<SequenceThumb seq={current} />}
          name={`${current.frames.length} frames · ${current.min}–${current.max}`}
        />
      )}
      {current && current.width > 0 && (
        <MatchAspectButton width={current.width} height={current.height} />
      )}
    </div>
  );
}

// 3D model `model_file` param control. Picks a GLB/glTF/OBJ file, makes an
// ObjectURL, and stores a lightweight value the Import 3D node loads from.
export function ModelFileControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const current =
    (value as import("@/engine/types").ModelFileParamValue | null | undefined) ??
    null;
  const applyFile = (file: File) => {
    const lower = file.name.toLowerCase();
    const format: "glb" | "gltf" | "obj" = lower.endsWith(".obj")
      ? "obj"
      : lower.endsWith(".gltf")
        ? "gltf"
        : "glb";
    // Release the previous ObjectURL before replacing it.
    if (current?.url) {
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
      format,
    } satisfies import("@/engine/types").ModelFileParamValue);
  };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".glb,.gltf,.obj,model/gltf-binary,model/gltf+json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) applyFile(file);
        }}
      />
      <LoadFileButton label="Load Model" onClick={() => inputRef.current?.click()} />
      {current && (
        <LoadedFilePill
          thumb={
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                background: "#27272a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#a1a1aa",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1.6l5.6 3.2v6.4L8 14.4 2.4 11.2V4.8L8 1.6z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <path d="M8 1.6v12.8M2.4 4.8L8 8l5.6-3.2" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </div>
          }
          name={current.url ? current.filename : `${current.filename} — re-pick`}
        />
      )}
    </div>
  );
}

// Audio `audio_file` param control. Mirrors VideoFileControl: the File
// System Access picker (where available) persists a relink handle so the
// clip auto-relinks on the next project load; plain input fallback elsewhere.
export function AudioFileControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const current =
    (value as import("@/engine/types").AudioFileParamValue | null | undefined) ??
    null;
  const applyFile = async (file: File) => {
    const { registerAudioFile, disposeAudioFile } = await import(
      "@/lib/audio"
    );
    const v = await registerAudioFile(file);
    if (current) {
      try {
        disposeAudioFile(current);
      } catch {
        // Already disposed — nothing to free.
      }
    }
    onChange(v);
  };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await applyFile(file);
        }}
      />
      <LoadFileButton
        label="Load Audio"
        onClick={async () => {
          const { pickMediaFiles } = await import("@/lib/media-relink");
          const picked = await pickMediaFiles({ kind: "audio" });
          if (picked === "unsupported") {
            inputRef.current?.click();
            return;
          }
          if (picked?.[0]) await applyFile(picked[0]);
        }}
      />
      {current && (
        <LoadedFilePill
          thumb={<span style={{ color: "#71717a", fontSize: 11 }}>♪</span>}
          name={`${current.filename ?? "audio"} · ${
            Number.isFinite(current.duration)
              ? `${current.duration.toFixed(1)}s`
              : "stream"
          }`}
        />
      )}
      {current && (
        <button
          onClick={async () => {
            const { disposeAudioFile } = await import("@/lib/audio");
            disposeAudioFile(current);
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
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

// `.cube` LUT param control. Stores the raw file text (round-trips through
// save/load); the node parses it into a GPU 3D texture.
export function LutFileControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const current = (value as LutFileParamValue | null) ?? null;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".cube"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          onChange({ filename: file.name, text } satisfies LutFileParamValue);
        }}
      />
      <LoadFileButton
        label="Load .cube"
        onClick={() => inputRef.current?.click()}
      />
      {current && (
        <LoadedFilePill thumb={<LutSwatch />} name={current.filename} />
      )}
    </div>
  );
}

// CSV param control. Loads a .csv file OR takes pasted text; stores the raw
// text inline (round-trips through save/load, no relink). Shows a live
// "rows × cols" summary using the sibling hasHeader/delimiter params so the
// user gets immediate feedback that the file parsed. The spreadsheet preview
// is milestone 2.
export function CsvFileControl({
  value,
  onChange,
  allParams,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  allParams?: Record<string, unknown>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const current = (value as CsvFileParamValue | null) ?? null;
  const text = current?.text ?? "";
  const parsed = parseCsv(current, {
    hasHeader: allParams?.hasHeader !== false,
    delimiter: (allParams?.delimiter as CsvDelimiter) ?? "auto",
  });
  const summary =
    text.trim() === ""
      ? "no data"
      : `${parsed.rowCount} row${parsed.rowCount === 1 ? "" : "s"} × ${parsed.columns.length} col${parsed.columns.length === 1 ? "" : "s"}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const t = await file.text();
          onChange({ filename: file.name, text: t } satisfies CsvFileParamValue);
          // Allow re-picking the same file (onChange won't fire otherwise).
          e.target.value = "";
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <LoadFileButton
          label="Load .csv"
          onClick={() => inputRef.current?.click()}
        />
        {current?.filename && (
          <LoadedFilePill thumb={<CsvSwatch />} name={current.filename} />
        )}
        <span style={{ color: "#71717a", fontSize: 10 }}>{summary}</span>
      </div>
      <textarea
        value={text}
        placeholder="or paste CSV here…"
        spellCheck={false}
        onChange={(e) =>
          onChange({
            filename: current?.filename,
            text: e.target.value,
          } satisfies CsvFileParamValue)
        }
        rows={4}
        style={{
          width: "100%",
          minHeight: 64,
          resize: "vertical",
          background: "#0a0a0a",
          border: "1px solid #27272a",
          color: "#e5e7eb",
          fontFamily: "ui-monospace, monospace",
          fontSize: 10,
          padding: "4px 6px",
          boxSizing: "border-box",
          lineHeight: 1.4,
          whiteSpace: "pre",
          overflowWrap: "normal",
        }}
      />
    </div>
  );
}

// Tiny grid glyph standing in for a loaded CSV.
export function CsvSwatch({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" style={{ flex: "0 0 auto" }}>
      <rect x="2.5" y="3.5" width="17" height="15" rx="2" fill="#0f172a" stroke="#334155" />
      <line x1="2.5" y1="8.5" x2="19.5" y2="8.5" stroke="#334155" />
      <line x1="8" y1="3.5" x2="8" y2="18.5" stroke="#334155" />
      <line x1="13.5" y1="3.5" x2="13.5" y2="18.5" stroke="#334155" />
    </svg>
  );
}

// Tiny round gradient swatch standing in for a loaded LUT (it has no single
// thumbnail image the way an image/video clip does).
export function LutSwatch({ size = 22 }: { size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "50%",
        border: "1px solid #3f3f46",
        background:
          "conic-gradient(from 0deg, #ef4444, #facc15, #22c55e, #3b82f6, #a855f7, #ef4444)",
      }}
    />
  );
}

// Small circular preview of an ImageBitmap, cover-fit into a round canvas.
export function BitmapThumb({
  bitmap,
  size = 22,
}: {
  bitmap: ImageBitmap;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    // Cover-fit: scale up to the larger axis ratio, centre the overflow.
    const s = Math.max(size / bitmap.width, size / bitmap.height);
    const w = bitmap.width * s;
    const h = bitmap.height * s;
    ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  }, [bitmap, size]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "block",
        flexShrink: 0,
        border: "1px solid #3f3f46",
      }}
    />
  );
}

// Small circular preview of a video's current frame. Draws once on mount
// and again on first decode if the element wasn't ready yet.
export function VideoThumb({
  video,
  size = 22,
}: {
  video: HTMLVideoElement;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const draw = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      ctx.clearRect(0, 0, size, size);
      const s = Math.max(size / vw, size / vh);
      const w = vw * s;
      const h = vh * s;
      ctx.drawImage(video, (size - w) / 2, (size - h) / 2, w, h);
    };
    draw();
    // HAVE_CURRENT_DATA (2) means a frame is decodable; below that, wait.
    if (video.readyState < 2) {
      video.addEventListener("loadeddata", draw, { once: true });
      return () => video.removeEventListener("loadeddata", draw);
    }
  }, [video, size]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "block",
        flexShrink: 0,
        border: "1px solid #3f3f46",
      }}
    />
  );
}

// Per-key animation access for controls that keyframe values INSIDE a
// composite param (merge layers' per-layer opacity). Keys are virtual
// animation-map entries (`layer_opacity:<id>` — see engine/conventions).
export interface LayerAnimApi {
  currentTick: number;
  get: (key: string) => KeyframeAnimationBlock | undefined;
  set: (key: string, next: KeyframeAnimationBlock | undefined) => void;
}

export function normalizeHex(s: string): string | null {
  let h = s.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return "#" + h.toLowerCase();
  // 8-digit (with alpha) — keep the rgb, drop alpha (param colors are rgb).
  if (/^[0-9a-fA-F]{8}$/.test(h)) return "#" + h.slice(0, 6).toLowerCase();
  return null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = (normalizeHex(hex) ?? "#000000").slice(1);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360 / 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

export function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

// Compact color control: a small swatch + hex field + H/S/L inputs. Local
// drafts keep partial hex typing and HSL round-trip rounding from fighting
// the controlled value; an external change (keyframe playback, undo, the
// swatch) resyncs them.
export function ColorControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const hex = normalizeHex(typeof value === "string" ? value : "") ?? "#000000";
  const [hexDraft, setHexDraft] = useState(hex);
  const [hsl, setHsl] = useState<[number, number, number]>(() => hexToHsl(hex));
  const lastHexRef = useRef(hex);

  useEffect(() => {
    if (hex !== lastHexRef.current) {
      lastHexRef.current = hex;
      setHexDraft(hex);
      setHsl(hexToHsl(hex));
    }
  }, [hex]);

  const commitHex = (next: string) => {
    const norm = normalizeHex(next);
    if (!norm) {
      setHexDraft(hex); // invalid — revert the draft
      return;
    }
    lastHexRef.current = norm;
    setHexDraft(norm);
    setHsl(hexToHsl(norm));
    onChange(norm);
  };

  const setChannel = (idx: 0 | 1 | 2, v: number) => {
    const max = idx === 0 ? 360 : 100;
    const next: [number, number, number] = [...hsl];
    next[idx] = Math.max(0, Math.min(max, v));
    setHsl(next);
    const nextHex = hslToHex(next[0], next[1], next[2]);
    lastHexRef.current = nextHex;
    setHexDraft(nextHex);
    onChange(nextHex);
  };

  const textStyle: React.CSSProperties = {
    background: "#0a0a0a",
    border: "1px solid #27272a",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 10,
    padding: "1px 3px",
    boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
      <input
        type="color"
        value={hex}
        onChange={(e) => commitHex(e.target.value)}
        title="Pick a color"
        style={{
          width: 22,
          height: 18,
          padding: 0,
          border: "1px solid #27272a",
          borderRadius: 3,
          background: "transparent",
          flexShrink: 0,
          cursor: "pointer",
        }}
      />
      <input
        type="text"
        value={hexDraft}
        spellCheck={false}
        onChange={(e) => setHexDraft(e.target.value)}
        onBlur={() => commitHex(hexDraft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        title="Hex"
        style={{ ...textStyle, width: 60, minWidth: 46, flexShrink: 1 }}
      />
      {(["H", "S", "L"] as const).map((lbl, i) => (
        <HslField
          key={lbl}
          label={lbl}
          value={hsl[i]}
          max={i === 0 ? 360 : 100}
          onChange={(v) => setChannel(i as 0 | 1 | 2, v)}
        />
      ))}
    </div>
  );
}

// Format a number for display, trimming float noise to the precision the
// step implies (step 0.01 → 2 decimals) and dropping trailing zeros.
export function formatNum(v: number, step: number): string {
  if (!Number.isFinite(v)) return "0";
  const decimals =
    step > 0 && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0;
  let s = v.toFixed(decimals);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// One arrow button in NumberField's stepper. Holds-to-repeat like a native
// spin button: an initial step, then a delayed accelerating repeat. Reads
// the step action through a ref so the repeat always uses the latest value.
export function StepButton({
  dir,
  onStep,
  title,
}: {
  dir: "up" | "down";
  onStep: () => void;
  title: string;
}) {
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  const timers = useRef<{ to: number | null; iv: number | null }>({
    to: null,
    iv: null,
  });
  const stop = () => {
    if (timers.current.to != null) window.clearTimeout(timers.current.to);
    if (timers.current.iv != null) window.clearInterval(timers.current.iv);
    timers.current = { to: null, iv: null };
  };
  useEffect(() => stop, []);
  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // don't steal focus from / blur the input
    e.stopPropagation();
    onStepRef.current();
    timers.current.to = window.setTimeout(() => {
      timers.current.iv = window.setInterval(() => onStepRef.current(), 55);
    }, 300);
  };
  return (
    <button
      type="button"
      title={title}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      tabIndex={-1}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        color: "#a1a1aa",
        lineHeight: 0,
      }}
    >
      <svg width={7} height={4} viewBox="0 0 8 5" aria-hidden>
        <polyline
          points={dir === "up" ? "1.5,3.5 4,1.5 6.5,3.5" : "1.5,1.5 4,3.5 6.5,1.5"}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export const SCRUB_THRESHOLD = 3; // px of movement before a press becomes a scrub

// Numeric field with three input modes: type (free-form — can be emptied,
// commits to 0 on blank), drag-to-scrub (press + move horizontally), and a
// custom up/down stepper. A clean click (press + release without moving)
// enters text-edit mode; a press that moves scrubs instead. The underlying
// element is a text input so partial entries ("", "-", "1.") don't fight a
// controlled numeric value.
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 56,
  borderColor = "#27272a",
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number | string;
  borderColor?: string;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const scrub = useRef<{ startX: number; startVal: number; moved: boolean } | null>(
    null
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // rAF-coalesce scrub emits so a fast drag doesn't re-eval the graph per
  // pointer event (same idea as the slider's dampening).
  const raf = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    []
  );

  const clamp = (v: number) => {
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    return v;
  };
  const snap = (v: number) => {
    if (!step || step <= 0) return v;
    return parseFloat((Math.round(v / step) * step).toFixed(6));
  };
  const emit = (v: number) => {
    if (v !== valueRef.current) onChangeRef.current(v);
  };
  const stepBy = (sign: number) => emit(clamp(snap(valueRef.current + sign * step)));

  const flush = () => {
    raf.current = null;
    if (pending.current != null) {
      emit(pending.current);
      pending.current = null;
    }
  };
  const queue = (v: number) => {
    pending.current = v;
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  };

  const beginEdit = () => {
    setDraft(formatNum(valueRef.current, step));
    setEditing(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  };
  const commit = () => {
    const t = draft.trim();
    let next: number;
    if (t === "") {
      next = 0; // blank confirms to 0
    } else {
      const p = parseFloat(t);
      if (Number.isNaN(p)) {
        setEditing(false); // garbage — revert to the live value
        return;
      }
      next = p;
    }
    setEditing(false);
    emit(clamp(next));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (editing) return; // already typing — let the caret behave normally
    if (e.button !== 0) return;
    e.preventDefault(); // suppress auto-focus; decide click-vs-scrub on release
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not all environments support capture; scrub still works via events
    }
    scrub.current = { startX: e.clientX, startVal: value, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) < SCRUB_THRESHOLD) return;
    s.moved = true;
    const span =
      typeof min === "number" && typeof max === "number" && max > min
        ? max - min
        : null;
    // Cross the whole range in ~250px; no range → 1 step/px. Shift = fine.
    const perPx = (span != null ? span / 250 : step || 1) * (e.shiftKey ? 0.2 : 1);
    queue(clamp(snap(s.startVal + dx * perPx)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    scrub.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (s && !s.moved) beginEdit(); // clean click → edit
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        width,
        height: 18,
        background: "#0a0a0a",
        border: `1px solid ${borderColor}`,
        borderRadius: 3,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={editing ? draft : formatNum(value, step)}
        title={title ?? "Drag to scrub · click to type"}
        onChange={(e) => editing && setDraft(e.target.value)}
        onFocus={() => {
          if (!editing) beginEdit();
        }}
        onBlur={commit}
        // Belt-and-suspenders focus suppression: keep a press from focusing
        // the field until we've decided it's a click (not a scrub). Once
        // editing, let clicks position the caret normally.
        onMouseDown={(e) => {
          if (!editing) e.preventDefault();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            stepBy(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            stepBy(-1);
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "#8a8a90",
          fontFamily: "inherit",
          fontSize: 10,
          padding: "1px 3px",
          cursor: editing ? "text" : "ew-resize",
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 11,
          flexShrink: 0,
          borderLeft: "1px solid rgba(255,255,255,0.18)",
        }}
      >
        <StepButton dir="up" title="Increase" onStep={() => stepBy(1)} />
        <StepButton dir="down" title="Decrease" onStep={() => stepBy(-1)} />
      </div>
    </div>
  );
}

export function HslField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
      <span style={{ color: "#52525b", fontSize: 9, flexShrink: 0 }}>
        {label}
      </span>
      <NumberField
        value={value}
        onChange={(v) => onChange(v)}
        min={0}
        max={max}
        step={1}
        width={42}
        title={`${label} (0–${max})`}
      />
    </div>
  );
}

// Custom dropdown replacing the native <select> — the native option popup is
// OS-chrome (a light list on macOS) that clashes with the dark panel. This
// renders a dark, rounded control + a portal popup styled like the rest of
// the panel. Portal-to-body with fixed positioning avoids the param panel's
// overflow:auto clipping the list.
// Segmented pill toggle for enum params declared with `control: "segmented"`.
// Best for 2–3 mutually-exclusive modes shown inline (e.g. the Output node's
// Video / Sequence export mode).
export function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  const norm = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o
  );
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        padding: 2,
        background: "#18181b",
        border: "1px solid #3f3f46",
        borderRadius: 999,
      }}
    >
      {norm.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              background: on ? "#3f3f46" : "transparent",
              color: on ? "#fafafa" : "#a1a1aa",
              border: "none",
              borderRadius: 999,
              padding: "3px 8px",
              fontFamily: "inherit",
              fontSize: 11,
              textTransform: "capitalize",
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Dropdown({
  value,
  options,
  onChange,
  style,
  title,
}: {
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (v: string) => void;
  style?: React.CSSProperties;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(
    null
  );

  const norm = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o
  );
  const currentLabel = norm.find((o) => o.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.bottom + 2, width: r.width });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node | null;
      if (btnRef.current?.contains(t as globalThis.Node)) return;
      if (popRef.current?.contains(t as globalThis.Node)) return;
      setOpen(false);
    };
    // A scroll of the panel or a parent invalidates the fixed position, so
    // close — but NOT when the scroll happens inside the popup's own option
    // list (that capture-phase event bubbles through `true`), or the list
    // could never be scrolled.
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as globalThis.Node)) return;
      setOpen(false);
    };
    const onMove = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
          width: "100%",
          height: 20,
          background: "#0a0a0a",
          border: `1px solid ${open ? "#3f3f46" : "#27272a"}`,
          borderRadius: 4,
          color: "#8a8a90",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "0 6px",
          cursor: "pointer",
          boxSizing: "border-box",
          textAlign: "left",
          ...style,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {currentLabel}
        </span>
        <svg
          width={8}
          height={5}
          viewBox="0 0 8 5"
          style={{ flexShrink: 0, color: "#71717a" }}
          aria-hidden
        >
          <polyline
            points="1,1 4,4 7,1"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="thin-scrollbar"
            style={{
              position: "fixed",
              left: rect.left,
              top: rect.top,
              width: rect.width,
              maxHeight: 260,
              overflowY: "auto",
              background: "#111113",
              border: "1px solid #27272a",
              borderRadius: 4,
              boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
              zIndex: 10000,
              padding: 3,
            }}
          >
            {norm.map((o) => {
              const sel = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  onMouseEnter={(e) => {
                    if (!sel) e.currentTarget.style.background = "#18181b";
                  }}
                  onMouseLeave={(e) => {
                    if (!sel) e.currentTarget.style.background = "transparent";
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: sel ? "#1f1f23" : "transparent",
                    border: "none",
                    color: sel ? "#facc15" : "#8a8a90",
                    fontFamily: "inherit",
                    fontSize: 11,
                    padding: "4px 7px",
                    borderRadius: 3,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

// Searchable font picker for enum params declared with `control: "font"`.
// Merges the user's installed (local) fonts — enumerated lazily on first open,
// degrading to nothing on non-Chromium browsers — with the curated baseline
// passed in `options`. The committed value is just the family-name string, so
// it stays back-compatible with the plain `font_family` enum.
export function FontPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // null = not yet enumerated; [] = unsupported / denied.
  const [local, setLocal] = useState<{ family: string }[] | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(
    null
  );

  // Load the current family's bytes (curated → Google CDN; local/system →
  // no-op) so the trigger button previews in the right face.
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    void import("@/lib/fonts").then((m) => {
      if (!cancelled) m.ensureFontLoaded(value);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  // Enumerate installed fonts on first open (queryLocalFonts needs a user
  // gesture the first time — the click that opens us satisfies it).
  useEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.bottom + 2, width: r.width });
    }
    if (local === null) {
      void import("@/lib/local-fonts").then(async (m) => {
        const cached = m.cachedLocalFonts();
        setLocal(cached ?? (await m.enumerateLocalFonts()));
      });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node | null;
      if (btnRef.current?.contains(t as globalThis.Node)) return;
      if (popRef.current?.contains(t as globalThis.Node)) return;
      setOpen(false);
    };
    // Scrolling/resizing invalidates the fixed popup position — close. (Don't
    // close on the search input's own scroll; that bubbles through `true`
    // capture, so we only listen on window.)
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as globalThis.Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, local]);

  // Merge installed + curated (installed first), dedup by family name.
  const merged = (() => {
    const out: { family: string; installed: boolean }[] = [];
    const seen = new Set<string>();
    for (const f of local ?? []) {
      if (seen.has(f.family)) continue;
      seen.add(f.family);
      out.push({ family: f.family, installed: true });
    }
    for (const f of options) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ family: f, installed: false });
    }
    return out;
  })();

  const q = search.trim().toLowerCase();
  const filtered = q
    ? merged.filter((m) => m.family.toLowerCase().includes(q))
    : merged;
  // Cap the rendered rows so a machine with thousands of fonts stays snappy;
  // the search box is the escape hatch for anything past the cap.
  const CAP = 300;
  const shown = filtered.slice(0, CAP);
  const overflow = filtered.length - shown.length;

  const pick = (family: string) => {
    onChange(family);
    void import("@/lib/fonts").then((m) => m.ensureFontLoaded(family));
    setOpen(false);
    setSearch("");
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
          width: "100%",
          height: 20,
          background: "#0a0a0a",
          border: `1px solid ${open ? "#3f3f46" : "#27272a"}`,
          borderRadius: 4,
          color: "#c4c4c8",
          fontFamily: value ? `"${value}", inherit` : "inherit",
          fontSize: 11,
          padding: "0 6px",
          cursor: "pointer",
          boxSizing: "border-box",
          textAlign: "left",
        }}
      >
        <span
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {value || "Inter"}
        </span>
        <svg
          width={8}
          height={5}
          viewBox="0 0 8 5"
          style={{ flexShrink: 0, color: "#71717a" }}
          aria-hidden
        >
          <polyline
            points="1,1 4,4 7,1"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              left: rect.left,
              top: rect.top,
              width: Math.max(rect.width, 200),
              background: "#111113",
              border: "1px solid #27272a",
              borderRadius: 4,
              boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
              zIndex: 10000,
              padding: 3,
            }}
          >
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                local === null
                  ? "loading fonts…"
                  : `search ${merged.length} fonts…`
              }
              style={{
                width: "100%",
                height: 22,
                background: "#0a0a0a",
                border: "1px solid #27272a",
                borderRadius: 3,
                color: "#e5e7eb",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "0 6px",
                marginBottom: 3,
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            <div
              className="thin-scrollbar"
              style={{ maxHeight: 240, overflowY: "auto" }}
            >
              {shown.map((o) => {
                const sel = o.family === value;
                return (
                  <button
                    key={o.family}
                    type="button"
                    onClick={() => pick(o.family)}
                    onMouseEnter={(e) => {
                      if (!sel) e.currentTarget.style.background = "#18181b";
                    }}
                    onMouseLeave={(e) => {
                      if (!sel) e.currentTarget.style.background = "transparent";
                    }}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      background: sel ? "#1f1f23" : "transparent",
                      border: "none",
                      color: sel ? "#facc15" : "#c4c4c8",
                      // Preview each row in its own family. Installed/system
                      // render immediately; curated render once loaded.
                      fontFamily: `"${o.family}", sans-serif`,
                      fontSize: 12,
                      padding: "4px 7px",
                      borderRadius: 3,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {o.family}
                    </span>
                    {!o.installed && (
                      <span
                        style={{
                          flexShrink: 0,
                          color: "#52525b",
                          fontFamily: "inherit",
                          fontSize: 9,
                        }}
                      >
                        web
                      </span>
                    )}
                  </button>
                );
              })}
              {shown.length === 0 && (
                <div style={{ color: "#52525b", fontSize: 10, padding: "6px 7px" }}>
                  no match
                </div>
              )}
              {overflow > 0 && (
                <div style={{ color: "#52525b", fontSize: 9, padding: "4px 7px" }}>
                  +{overflow} more — refine search
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export function menuItemStyle(active?: boolean): React.CSSProperties {
  return {
    background: active ? "#1f1f23" : "transparent",
    border: "none",
    color: active ? "#facc15" : "#d4d4d8",
    fontFamily: "inherit",
    fontSize: 11,
    padding: "5px 8px",
    textAlign: "left",
    cursor: "pointer",
    borderRadius: 3,
  };
}

// Clickable toggle pill — the interactive control for `boolean` params. Matches
// the display-only SwitchPill used by the collapsible group-enable headers
// (ParamPanel) so the two read as the same control across the app.
export function TogglePill({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        display: "inline-block",
        position: "relative",
        width: 26,
        height: 15,
        borderRadius: 999,
        boxSizing: "border-box",
        padding: 0,
        flexShrink: 0,
        background: on ? "#3b82f6" : "#27272a",
        border: `1px solid ${on ? "#3b82f6" : "#3f3f46"}`,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.14s ease, border-color 0.14s ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: on ? 12 : 1,
          width: 11,
          height: 11,
          borderRadius: 999,
          background: on ? "#fff" : "#a1a1aa",
          transition: "left 0.14s ease, background 0.14s ease",
          pointerEvents: "none",
        }}
      />
    </button>
  );
}

export function ParamControl({
  param,
  value,
  allParams,
  onChange,
  rangeOverride,
  onRangeChange,
  layerAnim,
}: {
  param: ParamDef;
  value: unknown;
  // Sibling params on the same node — only consumed by renderers
  // that need cross-param context (font_variations).
  allParams?: Record<string, unknown>;
  onChange: (v: unknown) => void;
  rangeOverride?: { min?: number; max?: number; softMax?: number };
  onRangeChange?: (
    next: { min?: number; max?: number; softMax?: number } | null
  ) => void;
  // Composite-param keyframing (merge layers) — see LayerAnimApi.
  layerAnim?: LayerAnimApi;
}) {
  if (param.type === "scalar") {
    const num = typeof value === "number" ? value : (param.default as number);
    // Effective range: per-instance override wins over the param def.
    // Each field overrides independently — set just `max` and the
    // others stay at their def defaults.
    const effMin = rangeOverride?.min ?? param.min ?? 0;
    const effMax = rangeOverride?.max ?? param.max ?? 1;
    const effSoftMax = rangeOverride?.softMax ?? param.softMax;
    // Slider uses softMax when provided so the user can type past it
    // via the number input without the slider pinning the stored value.
    const sliderMax = effSoftMax ?? effMax;
    const sliderMin = effMin;
    const sliderValue = Math.max(sliderMin, Math.min(sliderMax, num));
    return (
      <ScalarSliderRow
        param={param}
        num={num}
        effMin={effMin}
        effMax={effMax}
        effSoftMax={effSoftMax}
        sliderMin={sliderMin}
        sliderMax={sliderMax}
        sliderValue={sliderValue}
        rangeOverride={rangeOverride}
        onChange={onChange}
        onRangeChange={onRangeChange}
      />
    );
  }

  if (param.type === "boolean") {
    return <TogglePill on={!!value} onChange={onChange} />;
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
    return <AudioFileControl value={value} onChange={onChange} />;
  }

  if (param.type === "video_file") {
    return <VideoFileControl value={value} onChange={onChange} />;
  }

  if (param.type === "model_file") {
    return <ModelFileControl value={value} onChange={onChange} />;
  }

  if (param.type === "image_sequence") {
    return <ImageSequenceControl value={value} onChange={onChange} />;
  }

  if (param.type === "lut_file") {
    return <LutFileControl value={value} onChange={onChange} />;
  }

  if (param.type === "csv_file") {
    return (
      <CsvFileControl value={value} onChange={onChange} allParams={allParams} />
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

  if (param.type === "font_variations") {
    const customFont = (allParams?.custom_font ?? null) as
      | {
          axes?: Array<{
            tag: string;
            name: string;
            min: number;
            max: number;
            default: number;
          }>;
        }
      | null;
    const axes = customFont?.axes ?? [];
    const variations =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    if (axes.length === 0) {
      return (
        <div style={{ color: "#71717a", fontSize: 10, fontStyle: "italic" }}>
          Upload a variable font to expose its axes.
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {axes.map((axis) => (
          <FontAxisControl
            key={axis.tag}
            axis={axis}
            value={variations[axis.tag]}
            textValue={(allParams?.text as string) ?? ""}
            onChange={(next) => {
              const nextDict = { ...variations };
              if (next === null) delete nextDict[axis.tag];
              else nextDict[axis.tag] = next;
              onChange(nextDict);
            }}
          />
        ))}
      </div>
    );
  }

  if (param.type === "enum") {
    const options = param.options ?? [];
    const current = typeof value === "string" ? value : (param.default as string);
    if (param.control === "segmented") {
      return (
        <SegmentedControl
          value={current}
          options={options}
          onChange={(v) => onChange(v)}
        />
      );
    }
    if (param.control === "font") {
      return (
        <FontPicker value={current} options={options} onChange={(v) => onChange(v)} />
      );
    }
    return (
      <Dropdown
        value={current}
        options={options}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (param.type === "color") {
    const hex = typeof value === "string" ? value : (param.default as string);
    return <ColorControl value={hex} onChange={onChange} />;
  }

  if (param.type === "file") {
    return <ImageFileControl value={value} onChange={onChange} />;
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
                  // Drop the layer's opacity keyframes with it.
                  layerAnim?.set(layerOpacityKey(l.id), undefined);
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
            {/* Blend mode + opacity share one line: dropdown first, then
                a bar slider + number field styled like the main scalar
                sliders. */}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Dropdown
                value={l.mode}
                options={modes.map((m) => ({ value: m, label: blendModeLabel(m) }))}
                onChange={(v) => {
                  const next = layers.map((x) =>
                    x.id === l.id ? { ...x, mode: v } : x
                  );
                  onChange(next);
                }}
                style={{ width: 96, flexShrink: 0 }}
              />
              <MiniBarSlider
                min={0}
                max={1}
                step={0.01}
                value={l.opacity}
                onChange={(v) => {
                  const next = layers.map((x) =>
                    x.id === l.id ? { ...x, opacity: v } : x
                  );
                  onChange(next);
                }}
                title="Opacity — hold Shift to fine-tune"
              />
              <NumberField
                value={l.opacity}
                onChange={(v) => {
                  const next = layers.map((x) =>
                    x.id === l.id ? { ...x, opacity: v } : x
                  );
                  onChange(next);
                }}
                min={0}
                max={1}
                step={0.01}
                width={44}
              />
              {layerAnim &&
                (() => {
                  // Same diamond contract as scalar rows, against the
                  // layer's virtual animation key. Once animated, slider
                  // edits auto-keyframe via EffectsApp's onParamChange.
                  const key = layerOpacityKey(l.id);
                  const block = layerAnim.get(key);
                  const tick = layerAnim.currentTick;
                  return (
                    <KeyframeDiamond
                      state={diamondStateFor(block, tick)}
                      title="Keyframe this layer's opacity"
                      onClick={() => {
                        if (!block || !block.animated) {
                          layerAnim.set(key, {
                            animated: true,
                            trackVisible: true,
                            keyframes: [
                              {
                                tick,
                                value: l.opacity,
                                easingOut: "easeInOut",
                              },
                            ],
                          });
                        } else if (findKeyframeAt(block, tick)) {
                          layerAnim.set(key, removeKeyframeAt(block, tick));
                        } else {
                          layerAnim.set(
                            key,
                            upsertKeyframe(block, tick, l.opacity, "easeInOut")
                          );
                        }
                      }}
                    />
                  );
                })()}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (param.type === "expr_inputs") {
    const list = Array.isArray(value)
      ? (value as ExprInput[])
      : ((param.default as ExprInput[]) ?? []);
    const update = (next: ExprInput[]) => onChange(next);
    // Keep names identifier-safe so they can be used verbatim as the
    // expression's variable names (the node also validates at compile time).
    const sanitizeName = (raw: string) => {
      let s = raw.replace(/[^A-Za-z0-9_$]/g, "");
      if (/^[0-9]/.test(s)) s = "_" + s;
      return s;
    };
    const removeBtn: React.CSSProperties = {
      background: "transparent",
      border: "1px solid #3f3f46",
      color: "#a1a1aa",
      fontSize: 12,
      lineHeight: 1,
      padding: "2px 7px",
      borderRadius: 3,
      cursor: "pointer",
      fontFamily: "inherit",
      flexShrink: 0,
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.length === 0 && (
          <div style={{ color: "#52525b" }}>(no inputs)</div>
        )}
        {list.map((e) => (
          <div
            key={e.id}
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            <input
              value={e.name}
              spellCheck={false}
              placeholder="name"
              onChange={(ev) =>
                update(
                  list.map((x) =>
                    x.id === e.id
                      ? { ...x, name: sanitizeName(ev.target.value) }
                      : x
                  )
                )
              }
              style={{
                flex: 1,
                minWidth: 0,
                background: "#0c0c0e",
                border: "1px solid #27272a",
                color: "#e4e4e7",
                borderRadius: 3,
                padding: "3px 6px",
                fontFamily: "inherit",
                fontSize: 11,
              }}
              title="Variable name used in the expression"
            />
            <span
              style={{ color: "#52525b", fontSize: 10, flexShrink: 0 }}
              title="Value used when this input is not wired"
            >
              def
            </span>
            <NumberField
              value={e.default ?? 1}
              onChange={(v) =>
                update(
                  list.map((x) => (x.id === e.id ? { ...x, default: v } : x))
                )
              }
              step={0.01}
              width={52}
            />
            <button
              onClick={() => update(list.filter((x) => x.id !== e.id))}
              title="Remove input"
              style={removeBtn}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => update([...list, newExprInput(list)])}
          style={{
            background: "transparent",
            border: "1px dashed #3f3f46",
            color: "#a1a1aa",
            fontSize: 11,
            padding: "4px 8px",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "inherit",
            alignSelf: "flex-start",
          }}
        >
          + Add input
        </button>
      </div>
    );
  }

  if (param.type === "autolayout_items") {
    const items = Array.isArray(value)
      ? (value as AutoLayoutItem[])
      : ((param.default as AutoLayoutItem[]) ?? []);
    const sizeModes = ["hug", "fixed", "fill"];
    const fits = ["cover", "contain", "stretch"];
    // One labeled axis row: mode dropdown + units field (fixed mode only).
    const axisRow = (
      item: AutoLayoutItem,
      axis: "width" | "height"
    ) => {
      const modeKey = axis === "width" ? "widthMode" : "heightMode";
      const mode = item[modeKey];
      return (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: "#71717a", width: 12, flexShrink: 0 }}>
            {axis === "width" ? "W" : "H"}
          </span>
          <Dropdown
            value={mode}
            options={sizeModes}
            onChange={(v) => {
              const next = items.map((x) =>
                x.id === item.id ? { ...x, [modeKey]: v as SizeMode } : x
              );
              onChange(next);
            }}
            style={{ width: 72, flexShrink: 0 }}
          />
          {mode === "fixed" && (
            <NumberField
              value={item[axis]}
              onChange={(v) => {
                const next = items.map((x) =>
                  x.id === item.id ? { ...x, [axis]: Math.max(0, v) } : x
                );
                onChange(next);
              }}
              min={0}
              step={1}
              width={56}
            />
          )}
        </div>
      );
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.length === 0 && (
          <div style={{ color: "#52525b" }}>(no items — use + on node)</div>
        )}
        {items.map((item, i) => (
          <div
            key={item.id}
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
              <span style={{ color: "#a1a1aa" }}>item {i + 1}</span>
              <button
                onClick={() => onChange(items.filter((x) => x.id !== item.id))}
                title="Remove item"
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
            {axisRow(item, "width")}
            {axisRow(item, "height")}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: "#71717a", width: 12, flexShrink: 0 }} />
              <Dropdown
                value={item.fit}
                options={fits}
                onChange={(v) => {
                  const next = items.map((x) =>
                    x.id === item.id
                      ? { ...x, fit: v as AutoLayoutItem["fit"] }
                      : x
                  );
                  onChange(next);
                }}
                style={{ width: 72, flexShrink: 0 }}
              />
              <label
                title="Trim the child to its alpha bounding box before layout (image-backed elements only)"
                style={{
                  display: "flex",
                  gap: 4,
                  alignItems: "center",
                  color: "#a1a1aa",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={item.trim}
                  onChange={(e) => {
                    const next = items.map((x) =>
                      x.id === item.id ? { ...x, trim: e.target.checked } : x
                    );
                    onChange(next);
                  }}
                />
                trim
              </label>
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

  if (param.type === "gradient_points") {
    const points = Array.isArray(value)
      ? (value as GradientPoint[])
      : ((param.default as GradientPoint[]) ?? []);
    return (
      <GradientPointsControl
        points={points}
        onChange={(next) => onChange(next)}
        layerAnim={layerAnim}
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
          <div key={i} style={{ flex: 1, minWidth: 0 }}>
            <NumberField
              value={v}
              step={param.step ?? 0.01}
              min={param.min}
              max={param.max}
              width="100%"
              onChange={(nv) => {
                const next = [...arr];
                next[i] = nv;
                onChange(next);
              }}
            />
          </div>
        ))}
      </div>
    );
  }

  return <div style={{ color: "#71717a" }}>(unsupported)</div>;
}

export const GRADIENT_MAX_POINTS = 16;

export function newGradientPointId(): string {
  return "gp-" + Math.random().toString(36).slice(2, 9);
}

// Hex → straight-alpha RGBA floats [r,g,b,a] in 0..1 — the representation the
// keyframe engine interpolates colors in (oklab). Used to seed a point's
// color keyframe from its stored hex value.
export function hexToRgba01Tuple(
  hex: string
): [number, number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255;
  return [
    (Number.isFinite(r) ? r : 255) / 255,
    (Number.isFinite(g) ? g : 255) / 255,
    (Number.isFinite(b) ? b : 255) / 255,
    (Number.isFinite(a) ? a : 255) / 255,
  ];
}

// Editor for the multipoint gradient's `gradient_points` param. One card per
// point (color + X/Y), with per-point keyframe diamonds against the virtual
// gpoint_x/y/c:<id> tracks — same contract as the merge-layer opacity diamond.
export function GradientPointsControl({
  points,
  onChange,
  layerAnim,
}: {
  points: GradientPoint[];
  onChange: (next: GradientPoint[]) => void;
  layerAnim?: LayerAnimApi;
}) {
  const update = (id: string, patch: Partial<GradientPoint>) =>
    onChange(points.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  // Toggle/insert/remove a keyframe on a point's virtual track at the
  // playhead. `seed` is the value stored when a keyframe is created (a scalar
  // for x/y, an RGBA tuple for color).
  const diamond = (key: string, seed: unknown, title: string) => {
    if (!layerAnim) return null;
    const block = layerAnim.get(key);
    const tick = layerAnim.currentTick;
    return (
      <KeyframeDiamond
        state={diamondStateFor(block, tick)}
        title={title}
        onClick={() => {
          if (!block || !block.animated) {
            layerAnim.set(key, {
              animated: true,
              trackVisible: true,
              keyframes: [{ tick, value: seed, easingOut: "easeInOut" }],
            });
          } else if (findKeyframeAt(block, tick)) {
            layerAnim.set(key, removeKeyframeAt(block, tick));
          } else {
            layerAnim.set(key, upsertKeyframe(block, tick, seed, "easeInOut"));
          }
        }}
      />
    );
  };

  function addPoint() {
    if (points.length >= GRADIENT_MAX_POINTS) return;
    onChange([
      ...points,
      { id: newGradientPointId(), x: 0.5, y: 0.5, color: "#ffffff" },
    ]);
  }

  function removePoint(id: string) {
    if (points.length <= 1) return;
    onChange(points.filter((p) => p.id !== id));
    // Drop the point's keyframe tracks with it.
    layerAnim?.set(gpointXKey(id), undefined);
    layerAnim?.set(gpointYKey(id), undefined);
    layerAnim?.set(gpointCKey(id), undefined);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {points.length === 0 && (
        <div style={{ color: "#52525b" }}>(no points — add one)</div>
      )}
      {points.map((p, i) => (
        <div
          key={p.id}
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
            <span style={{ color: "#a1a1aa" }}>point {i + 1}</span>
            <button
              onClick={() => removePoint(p.id)}
              disabled={points.length <= 1}
              title="Remove point"
              style={{
                background: "transparent",
                border: "1px solid #3f3f46",
                color: points.length <= 1 ? "#3f3f46" : "#a1a1aa",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 3,
                cursor: points.length <= 1 ? "default" : "pointer",
                fontFamily: "inherit",
              }}
            >
              remove
            </button>
          </div>
          {/* Color row */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ColorControl
                value={typeof p.color === "string" ? p.color : "#ffffff"}
                onChange={(hex) => update(p.id, { color: hex as string })}
              />
            </div>
            {diamond(
              gpointCKey(p.id),
              hexToRgba01Tuple(typeof p.color === "string" ? p.color : "#ffffff"),
              "Keyframe this point's color"
            )}
          </div>
          {/* X / Y row */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "#71717a", width: 10, flexShrink: 0 }}>X</span>
            <NumberField
              value={p.x}
              onChange={(v) => update(p.id, { x: v })}
              min={-0.5}
              max={1.5}
              step={0.001}
              width={56}
            />
            {diamond(gpointXKey(p.id), p.x, "Keyframe this point's X")}
            <span style={{ color: "#71717a", width: 10, flexShrink: 0 }}>Y</span>
            <NumberField
              value={p.y}
              onChange={(v) => update(p.id, { y: v })}
              min={-0.5}
              max={1.5}
              step={0.001}
              width={56}
            />
            {diamond(gpointYKey(p.id), p.y, "Keyframe this point's Y")}
          </div>
        </div>
      ))}
      <button
        onClick={addPoint}
        disabled={points.length >= GRADIENT_MAX_POINTS}
        style={{
          background: "transparent",
          border: "1px solid #3f3f46",
          color: points.length >= GRADIENT_MAX_POINTS ? "#3f3f46" : "#a1a1aa",
          fontSize: 11,
          padding: "3px 8px",
          borderRadius: 3,
          cursor:
            points.length >= GRADIENT_MAX_POINTS ? "default" : "pointer",
          fontFamily: "inherit",
        }}
      >
        + add point
      </button>
    </div>
  );
}

export function ColorRampControl({
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
              <DampenedRangeInput
                min={0}
                max={1}
                step={0.01}
                value={selected.alpha ?? 1}
                onChange={(v) => updateStop(selected.id, { alpha: v })}
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
              <DampenedRangeInput
                min={0}
                max={1}
                step={0.001}
                value={selected.position}
                onChange={(v) => updateStop(selected.id, { position: v })}
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

export function hexAlphaCss(hex: string, alpha: number): string {
  const [r, g, b] = hexParts(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function sampleRampAlpha(sorted: ColorRampStop[], p: number): number {
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
export function sampleRampColor(sorted: ColorRampStop[], p: number): string {
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

export function mixHex(a: string, b: string, t: number): string {
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

export function hexParts(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── RGB Curves editor ─────────────────────────────────────────────────────
export const CURVE_SIZE = 200;
export const CURVE_PAD = 8;
export const CURVE_CHANNEL_COLORS: Record<CurveChannel, string> = {
  rgb: "#e5e7eb",
  r: "#ef4444",
  g: "#22c55e",
  b: "#3b82f6",
};
export const CURVE_CHANNEL_LABELS: Record<CurveChannel, string> = {
  rgb: "RGB",
  r: "R",
  g: "G",
  b: "B",
};
// Distance (in svg pixels) a dragged point can move below/above the chart
// before it's removed. Matches the Blender/Photoshop drag-off-chart gesture.
export const CURVE_DRAG_OFF_THRESHOLD = 40;

export function CurvesControl({
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

// Per-axis control for a font's variation axis. Supports a few
// modulation modes (constant / gradient / sine / random / cycle)
// — the rasterizer reads the mode and renders each character with
// its own resolved axis value.
export function FontAxisControl({
  axis,
  value,
  textValue,
  onChange,
}: {
  axis: { tag: string; name: string; min: number; max: number; default: number };
  value: unknown;
  // Sibling text param — used by the perGlyph mode to size its
  // per-character list to match the current string. Empty string
  // is fine; the list just shrinks to length 0.
  textValue?: string;
  onChange: (next: unknown) => void;
}) {
  // Normalise to the AxisValue object form so the UI doesn't have
  // to special-case legacy plain numbers. Legacy stays on-disk in
  // the original shape until the user touches it.
  const av = (() => {
    if (typeof value === "number") return { mode: "constant" as const, value };
    if (value && typeof value === "object" && "mode" in value)
      return value as {
        mode: string;
        [k: string]: unknown;
      };
    return null;
  })();
  const mode = (av?.mode as string) ?? "default";
  const step = Math.max((axis.max - axis.min) / 1000, 0.001);

  const setMode = (next: string) => {
    if (next === "default") {
      onChange(null);
      return;
    }
    if (next === "constant") {
      onChange({ mode: "constant", value: axis.default });
      return;
    }
    if (next === "gradient") {
      onChange({
        mode: "gradient",
        from: axis.min,
        to: axis.max,
        curve: 1,
      });
      return;
    }
    if (next === "sine") {
      onChange({
        mode: "sine",
        center: axis.default,
        amplitude: (axis.max - axis.min) * 0.25,
        frequency: 1,
        phase: 0,
      });
      return;
    }
    if (next === "random") {
      onChange({
        mode: "random",
        min: axis.min,
        max: axis.max,
        seed: 1,
      });
      return;
    }
    if (next === "cycle") {
      onChange({
        mode: "cycle",
        values: [axis.min, axis.max],
      });
      return;
    }
    if (next === "perGlyph") {
      // Seed with the current text length, all set to the axis
      // default. User then dials each glyph in independently.
      const chars = Array.from(textValue ?? "");
      const len = Math.max(1, chars.length);
      onChange({
        mode: "perGlyph",
        values: new Array(len).fill(axis.default),
      });
      return;
    }
    if (next === "maskDriven") {
      onChange({ mode: "maskDriven", a: axis.min, b: axis.max });
      return;
    }
  };

  const labelHeader = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <div
        style={{
          flex: 1,
          color: "#a1a1aa",
          fontSize: 10,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={`${axis.name} (${axis.tag}) — ${axis.min}…${axis.max}, default ${axis.default}`}
      >
        {axis.name}
        <span style={{ color: "#52525b", marginLeft: 4 }}>
          {axis.tag}
        </span>
      </div>
      <Dropdown
        value={mode}
        onChange={(v) => setMode(v)}
        style={{ fontSize: 10 }}
        options={[
          { value: "default", label: "default" },
          { value: "constant", label: "constant" },
          { value: "gradient", label: "gradient" },
          { value: "sine", label: "sine" },
          { value: "random", label: "random" },
          { value: "cycle", label: "cycle" },
          { value: "perGlyph", label: "per glyph" },
          { value: "maskDriven", label: "mask (per glyph)" },
        ]}
      />
    </div>
  );

  // Mode-specific body.
  let body: React.ReactNode = null;
  if (mode === "constant") {
    body = (
      <FontAxisSlider
        label="value"
        value={(av as unknown as { value: number }).value}
        min={axis.min}
        max={axis.max}
        step={step}
        onChange={(v) => onChange({ mode: "constant", value: v })}
      />
    );
  } else if (mode === "gradient") {
    const a = av as unknown as { from: number; to: number; curve?: number };
    body = (
      <>
        <FontAxisSlider
          label="from"
          value={a.from}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) =>
            onChange({ ...a, mode: "gradient", from: v })
          }
        />
        <FontAxisSlider
          label="to"
          value={a.to}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) => onChange({ ...a, mode: "gradient", to: v })}
        />
        <FontAxisSlider
          label="curve"
          value={a.curve ?? 1}
          min={0.25}
          max={4}
          step={0.05}
          onChange={(v) =>
            onChange({ ...a, mode: "gradient", curve: v })
          }
        />
      </>
    );
  } else if (mode === "sine") {
    const a = av as unknown as {
      center: number;
      amplitude: number;
      frequency: number;
      phase: number;
    };
    body = (
      <>
        <FontAxisSlider
          label="center"
          value={a.center}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) => onChange({ ...a, mode: "sine", center: v })}
        />
        <FontAxisSlider
          label="amplitude"
          value={a.amplitude}
          min={0}
          max={axis.max - axis.min}
          step={step}
          onChange={(v) =>
            onChange({ ...a, mode: "sine", amplitude: v })
          }
        />
        <FontAxisSlider
          label="freq"
          value={a.frequency}
          min={0.1}
          max={10}
          step={0.05}
          onChange={(v) =>
            onChange({ ...a, mode: "sine", frequency: v })
          }
        />
        <FontAxisSlider
          label="phase"
          value={a.phase}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onChange({ ...a, mode: "sine", phase: v })}
        />
      </>
    );
  } else if (mode === "random") {
    const a = av as unknown as { min: number; max: number; seed: number };
    body = (
      <>
        <FontAxisSlider
          label="min"
          value={a.min}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) => onChange({ ...a, mode: "random", min: v })}
        />
        <FontAxisSlider
          label="max"
          value={a.max}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) => onChange({ ...a, mode: "random", max: v })}
        />
        <FontAxisSlider
          label="seed"
          value={a.seed}
          min={0}
          max={1000}
          step={1}
          onChange={(v) =>
            onChange({ ...a, mode: "random", seed: v })
          }
        />
      </>
    );
  } else if (mode === "cycle") {
    const a = av as unknown as { values: number[] };
    const cv = Array.isArray(a.values) ? a.values : [axis.min, axis.max];
    body = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {cv.map((v, i) => (
          <div
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 30,
                fontSize: 10,
                color: "#71717a",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              #{i}
            </span>
            <input
              type="range"
              min={axis.min}
              max={axis.max}
              step={step}
              value={v}
              onChange={(e) => {
                const next = [...cv];
                next[i] = parseFloat(e.target.value);
                onChange({ mode: "cycle", values: next });
              }}
              style={{ flex: 1 }}
            />
            <span
              style={{
                width: 36,
                fontSize: 10,
                color: "#a1a1aa",
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}
            </span>
            <button
              type="button"
              onClick={() => {
                if (cv.length <= 1) return;
                const next = cv.filter((_, j) => j !== i);
                onChange({ mode: "cycle", values: next });
              }}
              style={{
                padding: "1px 4px",
                background: "transparent",
                border: "1px solid #3f3f46",
                color: "#a1a1aa",
                fontFamily: "inherit",
                fontSize: 10,
                borderRadius: 3,
                cursor: "pointer",
              }}
              title="Remove"
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const next = [...cv, axis.default];
            onChange({ mode: "cycle", values: next });
          }}
          style={{
            alignSelf: "flex-start",
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid #3f3f46",
            color: "#a1a1aa",
            fontFamily: "inherit",
            fontSize: 10,
            borderRadius: 3,
            cursor: "pointer",
          }}
        >
          + add step
        </button>
      </div>
    );
  } else if (mode === "maskDriven") {
    const a = av as unknown as { a: number; b: number };
    body = (
      <>
        <div
          style={{
            color: "#71717a",
            fontSize: 10,
            marginBottom: 2,
            lineHeight: 1.5,
          }}
        >
          Wire an image into the Text node&apos;s <b>mask</b> socket
          — the rasterizer samples it at each character&apos;s
          centre and interpolates between <b>a</b> (mask = 0) and{" "}
          <b>b</b> (mask = 1). One value per glyph (not sub-pixel).
        </div>
        <FontAxisSlider
          label="a (mask 0)"
          value={a.a}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) =>
            onChange({ ...a, mode: "maskDriven", a: v })
          }
        />
        <FontAxisSlider
          label="b (mask 1)"
          value={a.b}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(v) =>
            onChange({ ...a, mode: "maskDriven", b: v })
          }
        />
      </>
    );
  } else if (mode === "perGlyph") {
    const a = av as unknown as { values: number[] };
    // Codepoint-safe split so emoji / combining marks count as one
    // glyph. Matches the rasterizer's `Array.from(line)` exactly.
    const chars = Array.from(textValue ?? "");
    const stored = Array.isArray(a.values) ? a.values : [];
    // Source of truth = the user's text. Pad missing entries with
    // the axis default; ignore extra trailing entries (they're
    // harmless and the resolver returns null for out-of-range, but
    // we don't display them).
    const rows = chars.map((ch, i) => ({
      ch,
      value:
        typeof stored[i] === "number" && Number.isFinite(stored[i])
          ? (stored[i] as number)
          : axis.default,
    }));
    const updateRow = (i: number, v: number) => {
      // Make sure the stored array covers all current chars when
      // the user edits — pad with defaults for any earlier indices
      // they hadn't touched yet.
      const next = chars.map((_, j) =>
        j === i
          ? v
          : typeof stored[j] === "number" && Number.isFinite(stored[j])
          ? (stored[j] as number)
          : axis.default
      );
      onChange({ mode: "perGlyph", values: next });
    };
    const fillAll = () => {
      if (rows.length === 0) return;
      const v = rows[0].value;
      onChange({
        mode: "perGlyph",
        values: new Array(chars.length).fill(v),
      });
    };
    const resetAll = () => {
      onChange({
        mode: "perGlyph",
        values: new Array(chars.length).fill(axis.default),
      });
    };
    body = (
      <div
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <div
          style={{
            display: "flex",
            gap: 6,
            color: "#52525b",
            fontSize: 10,
            alignItems: "center",
          }}
        >
          <span style={{ flex: 1 }}>
            {chars.length} glyph{chars.length === 1 ? "" : "s"}
            {chars.length === 0 && " — type something in Text"}
          </span>
          {chars.length > 0 && (
            <>
              <button
                type="button"
                onClick={fillAll}
                title="Set every glyph to row 0's value"
                style={btnStyleSmall()}
              >
                fill
              </button>
              <button
                type="button"
                onClick={resetAll}
                title="Reset every glyph to the axis default"
                style={btnStyleSmall()}
              >
                reset all
              </button>
            </>
          )}
        </div>
        {rows.map((row, i) => (
          <div
            key={`${i}-${row.ch}`}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 28,
                fontSize: 11,
                color: "#e5e7eb",
                textAlign: "center",
                background: "#0a0a0a",
                border: "1px solid #27272a",
                borderRadius: 2,
                padding: "1px 0",
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "pre",
              }}
              title={`Char ${i}: ${row.ch === " " ? "space" : row.ch === "\n" ? "newline" : row.ch}`}
            >
              {row.ch === " "
                ? "·"
                : row.ch === "\n"
                ? "⏎"
                : row.ch}
            </span>
            <input
              type="range"
              min={axis.min}
              max={axis.max}
              step={step}
              value={row.value}
              onChange={(e) =>
                updateRow(i, parseFloat(e.target.value))
              }
              style={{ flex: 1 }}
            />
            <span
              style={{
                width: 42,
                fontSize: 10,
                color: "#a1a1aa",
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {Number.isInteger(row.value)
                ? row.value.toFixed(0)
                : row.value.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    );
  } else {
    // default — falls back to the font's declared default at
    // rasterize time. No body needed.
    body = (
      <div style={{ color: "#52525b", fontSize: 10, fontStyle: "italic" }}>
        font default ({axis.default})
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 6,
        background: "#0d0d10",
        border: "1px solid #27272a",
        borderRadius: 3,
      }}
    >
      {labelHeader}
      {body}
    </div>
  );
}

export function btnStyleSmall(): React.CSSProperties {
  return {
    padding: "1px 6px",
    background: "transparent",
    border: "1px solid #3f3f46",
    color: "#a1a1aa",
    fontFamily: "inherit",
    fontSize: 10,
    borderRadius: 3,
    cursor: "pointer",
  };
}

export function FontAxisSlider({
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
  const display = Number.isInteger(value)
    ? value.toFixed(0)
    : value.toFixed(2);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 60,
          fontSize: 10,
          color: "#71717a",
        }}
      >
        {label}
      </span>
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
          width: 42,
          textAlign: "right",
          fontSize: 10,
          color: "#a1a1aa",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {display}
      </span>
    </div>
  );
}

export function inputStyle(): React.CSSProperties {
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

export function buttonStyle(): React.CSSProperties {
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

// Scalar slider row with right-click → "Edit range" popover. Slider /
// number-input behavior is unchanged from the inline version it
// replaced; the only addition is the contextmenu handler that opens
// SliderRangeEditor and the highlight when an override is active.
// Compact bar-style slider matching ScalarSliderRow's visuals (track +
// fill + leading-edge line + transparent native range on top) for
// embedded controls — merge layers, etc. — that have no ParamDef or
// range-override machinery behind them.
export function MiniBarSlider({
  value,
  min,
  max,
  step,
  onChange,
  title,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  title?: string;
}) {
  const clamped = Math.max(min, Math.min(max, value));
  const fillPct =
    max > min ? ((clamped - min) / (max - min)) * 100 : 0;
  return (
    <div style={{ position: "relative", flex: 1, height: 20, minWidth: 40 }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 6,
          boxShadow: "inset 0 0 0 1px #232327",
          background: "#0f0f11",
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fillPct}%`,
            background: "#202023",
            borderRadius: 6,
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: `${fillPct}%`,
          top: "21%",
          bottom: "21%",
          width: 1,
          marginLeft: -0.5,
          background: "#8a8a90",
          pointerEvents: "none",
        }}
      />
      <DampenedRangeInput
        className="param-slider-bare"
        min={min}
        max={max}
        step={step}
        value={clamped}
        onChange={onChange}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          margin: 0,
        }}
        title={title}
      />
    </div>
  );
}

export function ScalarSliderRow({
  param,
  num,
  effMin,
  effMax,
  effSoftMax,
  sliderMin,
  sliderMax,
  sliderValue,
  rangeOverride,
  onChange,
  onRangeChange,
}: {
  param: ParamDef;
  num: number;
  effMin: number;
  effMax: number;
  effSoftMax: number | undefined;
  sliderMin: number;
  sliderMax: number;
  sliderValue: number;
  rangeOverride?: { min?: number; max?: number; softMax?: number };
  onChange: (v: unknown) => void;
  onRangeChange?: (
    next: { min?: number; max?: number; softMax?: number } | null
  ) => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const hasOverride = !!rangeOverride;
  // Fill percentage for the new bar-style slider (driven via the --fill CSS
  // var the .param-slider rules read).
  const fillPct =
    sliderMax > sliderMin
      ? Math.max(
          0,
          Math.min(100, ((sliderValue - sliderMin) / (sliderMax - sliderMin)) * 100)
        )
      : 0;
  const barColor = hasOverride ? "#172a52" : "#202023";
  const lineColor = hasOverride ? "#6b8fc7" : "#8a8a90";
  return (
    <div
      style={{ display: "flex", gap: 4, alignItems: "center", position: "relative" }}
      onContextMenu={(e) => {
        if (!onRangeChange) return;
        e.preventDefault();
        e.stopPropagation();
        setEditorOpen(true);
      }}
    >
      <div style={{ position: "relative", flex: 1, height: 20 }}>
        {/* Track — clips the fill so its rounded left corners follow the
            track radius; the fill's rounded RIGHT corner is the leading-edge
            cap a native gradient track can't produce. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 6,
            boxShadow: "inset 0 0 0 1px #232327",
            background: "#0f0f11",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${fillPct}%`,
              background: barColor,
              borderRadius: 6,
            }}
          />
        </div>
        {/* Thin leading-edge stroke at the value, inset vertically. */}
        <div
          style={{
            position: "absolute",
            left: `${fillPct}%`,
            top: "21%",
            bottom: "21%",
            width: 1,
            marginLeft: -0.5,
            background: lineColor,
            pointerEvents: "none",
          }}
        />
        {/* Transparent native range on top — interaction + grab target. */}
        <DampenedRangeInput
          className="param-slider-bare"
          min={sliderMin}
          max={sliderMax}
          step={param.step ?? 0.01}
          value={sliderValue}
          onChange={(v) => onChange(v)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            margin: 0,
          }}
          title={
            hasOverride
              ? `Custom range — right-click to edit (defaults: ${param.min ?? "—"} to ${param.max ?? "—"}). Hold Shift to fine-tune.`
              : "Right-click to set a custom range. Hold Shift to fine-tune."
          }
        />
      </div>
      <NumberField
        value={num}
        onChange={(v) => onChange(v)}
        min={effMin}
        max={effMax}
        step={param.step ?? 0.01}
        width={44}
        borderColor={hasOverride ? "#1e3a8a" : "#27272a"}
      />
      {editorOpen && onRangeChange && (
        <SliderRangeEditor
          param={param}
          override={rangeOverride}
          effMin={effMin}
          effMax={effMax}
          effSoftMax={effSoftMax}
          onCommit={(next) => {
            onRangeChange(next);
            setEditorOpen(false);
          }}
          onCancel={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

// Compact popover anchored to the slider's row. Three numeric inputs
// (min / max / soft max) plus a Reset that clears the override and
// falls back to whatever the param def declares. Click-outside or
// Escape dismisses without committing.
export function SliderRangeEditor({
  param,
  override,
  effMin,
  effMax,
  effSoftMax,
  onCommit,
  onCancel,
}: {
  param: ParamDef;
  override: { min?: number; max?: number; softMax?: number } | undefined;
  effMin: number;
  effMax: number;
  effSoftMax: number | undefined;
  onCommit: (
    next: { min?: number; max?: number; softMax?: number } | null
  ) => void;
  onCancel: () => void;
}) {
  const [minStr, setMinStr] = useState(String(effMin));
  const [maxStr, setMaxStr] = useState(String(effMax));
  const [softStr, setSoftStr] = useState(
    effSoftMax === undefined ? "" : String(effSoftMax)
  );
  const rootRef = useRef<HTMLDivElement>(null);

  const parseOrUndef = (s: string): number | undefined => {
    const t = s.trim();
    if (t === "") return undefined;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : undefined;
  };

  const submit = () => {
    const m = parseOrUndef(minStr);
    const x = parseOrUndef(maxStr);
    const s = parseOrUndef(softStr);
    // Only persist values that actually differ from the param def
    // defaults — keeps saved data minimal and lets the engine update
    // defaults without stale overrides clinging on.
    const next: { min?: number; max?: number; softMax?: number } = {};
    if (m !== undefined && m !== (param.min ?? 0)) next.min = m;
    if (x !== undefined && x !== (param.max ?? 1)) next.max = x;
    if (s !== undefined && s !== param.softMax) next.softMax = s;
    onCommit(Object.keys(next).length === 0 ? null : next);
  };

  const reset = () => onCommit(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      // Disambiguate: `Node` in this file refers to React Flow's
      // graph node (imported at the top); we want the DOM Node here.
      if (rootRef.current.contains(e.target as globalThis.Node)) return;
      onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") submit();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minStr, maxStr, softStr]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        minWidth: 220,
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        padding: 8,
        zIndex: 50,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // Right-clicking inside the editor shouldn't re-open it via
        // the slider's contextmenu handler.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        style={{
          color: "#a1a1aa",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        Slider range — {param.label ?? param.name}
      </div>
      <RangeField label="Min" value={minStr} onChange={setMinStr} />
      <RangeField label="Max" value={maxStr} onChange={setMaxStr} />
      <RangeField
        label="Soft max"
        value={softStr}
        onChange={setSoftStr}
        placeholder={
          param.softMax !== undefined ? `def: ${param.softMax}` : "(none)"
        }
      />
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 8,
          justifyContent: "space-between",
        }}
      >
        <button
          onClick={reset}
          disabled={!override}
          style={{
            padding: "3px 8px",
            background: "transparent",
            border: "1px solid #3f3f46",
            color: override ? "#e5e7eb" : "#52525b",
            fontFamily: "inherit",
            fontSize: 10,
            borderRadius: 3,
            cursor: override ? "pointer" : "not-allowed",
          }}
        >
          Reset
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "3px 8px",
              background: "transparent",
              border: "1px solid #3f3f46",
              color: "#e5e7eb",
              fontFamily: "inherit",
              fontSize: 10,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            style={{
              padding: "3px 8px",
              background: "#1e3a8a",
              border: "1px solid #1e3a8a",
              color: "#dbeafe",
              fontFamily: "inherit",
              fontSize: 10,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

export function RangeField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 4,
      }}
    >
      <span style={{ color: "#a1a1aa", minWidth: 60 }}>{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
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
