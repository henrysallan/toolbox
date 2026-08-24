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
  WedgeValueItem,
} from "@/engine/types";
import { parseCsv, type CsvDelimiter } from "@/engine/csv-parse";
import {
  MODEL_CACHE_EVENT,
  modelObjectToken,
  peekModelObjects,
} from "@/engine/model-cache";
import { listParseOptions, parseList } from "@/engine/list-parse";
import { registerImageOriginal } from "@/lib/image-bytes";
import {
  getCloudMediaRef,
  maybeUploadCloudMedia,
  useCloudUploadState,
  type CloudUploadState,
} from "@/lib/cloud-media-upload";
import { evalNumExpr } from "@/lib/num-expr";
import { newExprInput } from "@/nodes/effect/expression";
import { newWedgeValueId, WEDGE_TYPE_DEFAULTS } from "@/nodes/source/wedge";
import { syncChannelInputs } from "@/nodes/effect/point-expression";
import {
  animatedValueAt,
  gpointCKey,
  gpointXKey,
  gpointYKey,
  layerOpacityKey,
  rampAlphaKey,
  rampColorKey,
  rampPositionKey,
} from "@/engine/conventions";
import {
  COLOR_RAMP_MAX_STOPS,
  newStopId,
  type ColorRampStop,
} from "@/nodes/effect/color-ramp";
import {
  BLEND_MODE_ORDER,
  blendModeLabel,
  type MergeLayer,
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
import {
  sanitizeFloatCurve,
  type CurvePoint,
} from "@/engine/float-curve";
import {
  diamondStateFor,
  findKeyframeAt,
  removeKeyframeAt,
  upsertKeyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import KeyframeDiamond from "@/components/effects/KeyframeDiamond";
import {
  ownerDocument,
  ownerWindow,
  usePanelWindow,
} from "@/components/effects/layout/panel-window";
import { ColorSwatchPicker } from "@/lib/color-picker-popover";
import {
  formatNum,
  StepButton,
  SCRUB_THRESHOLD,
  NumberField,
  HslField,
} from "@/lib/number-field";

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
  const panelWin = usePanelWindow();
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
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKey);
    win.addEventListener("keyup", onKey);
    return () => {
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("keyup", onKey);
    };
  }, [panelWin]);
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
        background: hover ? "var(--tb-t-navy-d-6)" : "var(--tb-t-navy-d-7)",
        border: "1px solid var(--tb-a-blue-600)",
        color: "var(--tb-a-blue-200)",
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
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      {thumb}
      <span
        style={{
          color: "var(--tb-n-15)",
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
        background: "var(--tb-n-7)",
        border: "1px solid var(--tb-n-9)",
        color: "var(--tb-n-15)",
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
  const exr =
    value && typeof value === "object" && !(value instanceof ImageBitmap) &&
    (value as { kind?: string }).kind === "exr"
      ? (value as import("@/engine/types").ExrImageParamValue)
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
        accept="image/*,.exr"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          // EXR stills (magic-byte sniff, filename fallback): keep the
          // original bytes as the canonical source, header-parse for the
          // layer dropdown — the node decodes lazily via engine/exr.
          const head = new Uint8Array(
            await file.slice(0, 4).arrayBuffer().catch(() => new ArrayBuffer(0))
          );
          const { isExrBytes, isExrFilename } = await import("@/engine/exr");
          if (head.length ? isExrBytes(head) : isExrFilename(file.name)) {
            try {
              const { parseExrHeader, groupExrLayers } = await import(
                "@/engine/exr"
              );
              const header = parseExrHeader(await file.arrayBuffer());
              onChange({
                kind: "exr",
                blob: file,
                filename: file.name,
                layers: groupExrLayers(header),
                width: header.parts[0]?.width ?? 0,
                height: header.parts[0]?.height ?? 0,
              } satisfies import("@/engine/types").ExrImageParamValue);
            } catch (err) {
              console.error("EXR load failed:", err);
            }
            return;
          }
          const bmp = await createImageBitmap(file);
          // Keep the encoded source bytes so save inlines the original
          // file instead of a ~10× PNG re-encode of the decoded bitmap.
          registerImageOriginal(bmp, file);
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
      {exr && (
        <LoadedFilePill thumb={<ExrSwatch />} name={exr.filename ?? "exr"} />
      )}
      {bitmap && (
        <MatchAspectButton width={bitmap.width} height={bitmap.height} />
      )}
      {exr && <MatchAspectButton width={exr.width} height={exr.height} />}
    </div>
  );
}

// Tiny HDR-ish gradient swatch for the loaded-EXR pill (no decoded bitmap to
// thumbnail without paying a full decode).
function ExrSwatch() {
  return (
    <div
      style={{
        width: 24,
        height: 24,
        borderRadius: 4,
        background:
          "linear-gradient(135deg, var(--tb-n-3) 0%, var(--tb-n-9) 45%, var(--tb-n-17) 100%)",
      }}
    />
  );
}

// "☁ …" pill suffix for a media file: live progress while the clip
// uploads to cloud storage, a plain ☁ once a ref exists (the clip follows
// the project — no relink), empty for local-only files. Upload state
// changes re-render via useCloudUploadState, so the ☁ appears the moment
// a commit lands.
function cloudPillSuffix(
  state: CloudUploadState | null,
  filename?: string,
  size?: number
): string {
  if (state?.phase === "hashing") return " · ☁ preparing…";
  if (state?.phase === "uploading") return ` · ☁ ${state.pct}%`;
  if (state?.phase === "error") return " · ☁ upload failed";
  return getCloudMediaRef(filename, size) ? " · ☁" : "";
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
  const upload = useCloudUploadState(current?.filename, current?.size);
  const applyFile = async (file: File) => {
    const { registerVideoFile, disposeVideoFile } = await import(
      "@/lib/video"
    );
    const v = await registerVideoFile(file);
    // No-op unless this account has the cloud-media entitlement.
    void maybeUploadCloudMedia(file, "video");
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
          name={
            (current.filename ?? "video") +
            cloudPillSuffix(upload, current.filename, current.size)
          }
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
    <div style={{ width: 24, height: 24, borderRadius: 4, background: "var(--tb-n-7)" }} />
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
        accept="image/*,.exr"
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

// Object picker for Import 3D (`model_object` control,
// 081626_glb-scene-import.md §1). Options come from the shared model
// cache — the loaded file's top-level object list lives there, not on the
// param value (the EXR-layer-picker pattern, one step removed) — and the
// cache's MODEL_CACHE_EVENT re-renders this when the async parse lands.
// Stored value is "" (whole file merged) or "top:<i>".
export function ModelObjectControl({
  url,
  value,
  onChange,
}: {
  url: string | undefined;
  value: string;
  onChange: (v: unknown) => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = () => setTick((t) => t + 1);
    window.addEventListener(MODEL_CACHE_EVENT, h);
    return () => window.removeEventListener(MODEL_CACHE_EVENT, h);
  }, []);
  if (!url) {
    return <div style={{ color: "var(--tb-n-10)" }}>(no model loaded)</div>;
  }
  const objects = peekModelObjects(url);
  if (!objects) {
    return <div style={{ color: "var(--tb-n-10)" }}>(loading…)</div>;
  }
  const options = [
    { value: "", label: "All (merged)" },
    ...objects.map((o) => ({
      value: modelObjectToken(o.index),
      label: o.label,
    })),
  ];
  const effective = options.some((o) => o.value === value) ? value : "";
  return (
    <Dropdown
      value={effective}
      options={options}
      onChange={(v) => onChange(v)}
    />
  );
}

// 3D model `model_file` param control. Picks a GLB/glTF/OBJ/STL file, makes
// an ObjectURL, and stores a lightweight value the Import 3D node loads from.
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
  const upload = useCloudUploadState(current?.filename, current?.size);
  const applyFile = (file: File) => {
    const lower = file.name.toLowerCase();
    const format: "glb" | "gltf" | "obj" | "stl" = lower.endsWith(".obj")
      ? "obj"
      : lower.endsWith(".stl")
        ? "stl"
        : lower.endsWith(".gltf")
          ? "gltf"
          : "glb";
    // No-op unless this account has the cloud-media entitlement.
    void maybeUploadCloudMedia(file, "model");
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
        accept=".glb,.gltf,.obj,.stl,model/gltf-binary,model/gltf+json,model/stl"
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
                background: "var(--tb-n-7)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--tb-n-13)",
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
          name={
            (current.url ? current.filename : `${current.filename} — re-pick`) +
            cloudPillSuffix(upload, current.filename, current.size)
          }
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
  const upload = useCloudUploadState(current?.filename, current?.size);
  const applyFile = async (file: File) => {
    const { registerAudioFile, disposeAudioFile } = await import(
      "@/lib/audio"
    );
    const v = await registerAudioFile(file);
    // No-op unless this account has the cloud-media entitlement.
    void maybeUploadCloudMedia(file, "audio");
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
          thumb={<span style={{ color: "var(--tb-n-11)", fontSize: 11 }}>♪</span>}
          name={`${current.filename ?? "audio"} · ${
            Number.isFinite(current.duration)
              ? `${current.duration.toFixed(1)}s`
              : "stream"
          }${cloudPillSuffix(upload, current.filename, current.size)}`}
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
            border: "1px solid var(--tb-n-9)",
            color: "var(--tb-n-13)",
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

// `control: "file_text"` on a multiline STRING param (the List node's `text`).
// A textarea plus a "Load list…" button that reads a text file into the same
// param, and a live parse summary. The param stays a plain string on purpose —
// that's what keeps it exposable, so a String node or a CSV cell can drive the
// list at runtime, which no file-typed param can do (080526_list-socket.md).
export function FileTextControl({
  value,
  onChange,
  param,
  allParams,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  param: ParamDef;
  allParams?: Record<string, unknown>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const text = typeof value === "string" ? value : ((param.default as string) ?? "");
  const parsed = parseList(text, listParseOptions(allParams ?? {}));
  const n = parsed.items.length;
  const summary =
    text.trim() === ""
      ? "no items"
      : `${n} item${n === 1 ? "" : "s"} · ${parsed.format}${
          parsed.allNumeric ? " · numeric" : ""
        }`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.csv,.tsv,.json,.md,text/plain"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          onChange(await file.text());
          // Allow re-picking the same file (onChange won't fire otherwise).
          e.target.value = "";
        }}
      />
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        <LoadFileButton
          label="Load list…"
          onClick={() => inputRef.current?.click()}
        />
        <span style={{ color: "var(--tb-n-11)", fontSize: 10 }}>{summary}</span>
      </div>
      <textarea
        value={text}
        placeholder={param.placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={{
          width: "100%",
          minHeight: 64,
          resize: "vertical",
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
          color: "var(--tb-n-16)",
          fontFamily: "var(--code-font)",
          fontSize: 10,
          padding: "4px 6px",
          boxSizing: "border-box",
          lineHeight: 1.4,
        }}
      />
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
        <span style={{ color: "var(--tb-n-11)", fontSize: 10 }}>{summary}</span>
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
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
          color: "var(--tb-n-16)",
          fontFamily: "var(--code-font)",
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
      <rect x="2.5" y="3.5" width="17" height="15" rx="2" fill="var(--tb-t-navy-d-8)" stroke="var(--tb-a-slate-700)" />
      <line x1="2.5" y1="8.5" x2="19.5" y2="8.5" stroke="var(--tb-a-slate-700)" />
      <line x1="8" y1="3.5" x2="8" y2="18.5" stroke="var(--tb-a-slate-700)" />
      <line x1="13.5" y1="3.5" x2="13.5" y2="18.5" stroke="var(--tb-a-slate-700)" />
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
        border: "1px solid var(--tb-n-9)",
        background:
          "conic-gradient(from 0deg, var(--tb-a-red-500), var(--tb-a-yellow-400), var(--tb-a-green-500), var(--tb-a-blue-500), #a855f7, var(--tb-a-red-500))",
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
        border: "1px solid var(--tb-n-9)",
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
        border: "1px solid var(--tb-n-9)",
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

// Animated readouts for virtual-key sub-values (layer opacity, gradient
// points, ramp stops): the keyframe-evaluated value at the playhead, falling
// back to the stored constant. Display-only — edits still diff/patch against
// the stored arrays, so autokey and the constant round-trip are untouched.
export function animScalarAt(
  layerAnim: LayerAnimApi | undefined,
  key: string,
  stored: number
): number {
  if (!layerAnim) return stored;
  const v = animatedValueAt(
    layerAnim.get(key),
    "scalar",
    layerAnim.currentTick,
    stored
  );
  return typeof v === "number" && Number.isFinite(v) ? v : stored;
}

export function animColorHexAt(
  layerAnim: LayerAnimApi | undefined,
  key: string,
  storedHex: string
): string {
  if (!layerAnim) return storedHex;
  const v = animatedValueAt(
    layerAnim.get(key),
    "color",
    layerAnim.currentTick,
    storedHex
  );
  return typeof v === "string" ? v : storedHex;
}

// Per-stop expose / control access for ColorRampControl. Keys are the
// virtual ramp names (`ramp_c/a/p:<param>:<stopId>` — engine/conventions):
// exposing adds an input socket on the node, controlling adds a knob to the
// exported app's panel. Editor-only — the live viewer / exported apps pass
// nothing and the buttons don't render.
export interface RampIoApi {
  isExposed: (key: string) => boolean;
  // True when the exposed socket currently has an incoming wire — the
  // field's inline control renders read-only.
  isDriven: (key: string) => boolean;
  toggleExposed: (key: string) => void;
  isControlled: (key: string) => boolean;
  toggleControl: (key: string) => void;
}

export function normalizeHex(
  s: string,
  opts?: { alpha?: boolean }
): string | null {
  let h = s.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  else if (opts?.alpha && /^[0-9a-fA-F]{4}$/.test(h))
    h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return "#" + h.toLowerCase();
  if (/^[0-9a-fA-F]{8}$/.test(h)) {
    // 8-digit (with alpha): alpha-enabled params keep the byte (a fully
    // opaque `ff` collapses to 6-digit — the canonical form for a=1, so
    // stored values never churn format). Everywhere else keeps the
    // historical strip-to-rgb so un-audited nodes never see 8 digits.
    if (opts?.alpha && !/ff$/i.test(h)) return "#" + h.toLowerCase();
    return "#" + h.slice(0, 6).toLowerCase();
  }
  return null;
}

// Trailing alpha byte of an 8-digit hex as 0..1 (6-digit ⇒ 1).
export function hexAlpha01(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length < 8) return 1;
  const a = parseInt(h.slice(6, 8), 16);
  return Number.isFinite(a) ? a / 255 : 1;
}

// Compose a 6-digit hex with a 0..1 alpha — 8-digit only when a < 1 (the
// storage contract: opaque stays 6-digit).
export function withHexAlpha(hex6: string, a01: number): string {
  const byte = Math.max(0, Math.min(255, Math.round(a01 * 255)));
  if (byte >= 255) return hex6;
  return hex6 + byte.toString(16).padStart(2, "0");
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

// Compact color control: a small swatch + hex field + H/S/L inputs (+ an
// A input for alpha-enabled params — `ParamDef.alpha`, which stores
// 8-digit `#rrggbbaa` while translucent). Local drafts keep partial hex
// typing and HSL round-trip rounding from fighting the controlled value;
// an external change (keyframe playback, undo, the swatch) resyncs them.
export function ColorControl({
  value,
  onChange,
  alpha = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  alpha?: boolean;
}) {
  const hex =
    normalizeHex(typeof value === "string" ? value : "", { alpha }) ??
    "#000000";
  const rgbHex = hex.slice(0, 7);
  const a01 = hexAlpha01(hex);
  const [hexDraft, setHexDraft] = useState(hex);
  const [hsl, setHsl] = useState<[number, number, number]>(() =>
    hexToHsl(rgbHex)
  );
  const lastHexRef = useRef(hex);

  useEffect(() => {
    if (hex !== lastHexRef.current) {
      lastHexRef.current = hex;
      setHexDraft(hex);
      setHsl(hexToHsl(hex));
    }
  }, [hex]);

  const commitHex = (next: string) => {
    const norm = normalizeHex(next, { alpha });
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
    const rgb = hslToHex(next[0], next[1], next[2]);
    const nextHex = alpha ? withHexAlpha(rgb, a01) : rgb;
    lastHexRef.current = nextHex;
    setHexDraft(nextHex);
    onChange(nextHex);
  };

  const setAlpha = (pct: number) => {
    const nextA = Math.max(0, Math.min(100, pct)) / 100;
    const nextHex = withHexAlpha(rgbHex, nextA);
    lastHexRef.current = nextHex;
    setHexDraft(nextHex);
    onChange(nextHex);
  };

  const textStyle: React.CSSProperties = {
    background: "var(--tb-n-0)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 10,
    padding: "1px 3px",
    boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
      {/* Swatch opens the app's custom picker (SV square + hue + hex +
          eyedropper) instead of the native browser dialog. */}
      <ColorSwatchPicker
        value={hex}
        onChange={(h) => commitHex(h)}
        title="Pick a color"
        alpha={alpha}
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
      {alpha && (
        <HslField
          label="A"
          value={Math.round(a01 * 100)}
          max={100}
          onChange={setAlpha}
        />
      )}
    </div>
  );
}

// NumberField / HslField / formatNum / StepButton now live in
// @/lib/number-field so the color picker popover can share them without
// cycling back through this module. Re-exported here because the editor
// tree imports several of them from param-controls.
export { formatNum, StepButton, SCRUB_THRESHOLD, NumberField, HslField };

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
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-9)",
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
              background: on ? "var(--tb-n-9)" : "transparent",
              color: on ? "var(--tb-n-17)" : "var(--tb-n-13)",
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
  const panelWin = usePanelWindow();
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
    const win = ownerWindow(btnRef.current);
    win.addEventListener("mousedown", onDown);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", onMove);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown);
      win.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", onMove);
      win.removeEventListener("keydown", onKey);
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
          background: "var(--tb-n-0)",
          border: `1px solid ${open ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
          borderRadius: 4,
          color: "var(--tb-n-12)",
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
          style={{ flexShrink: 0, color: "var(--tb-n-11)" }}
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
            // Marks the portaled list so host popovers with their own
            // outside-click-to-close can tell "clicked an option" from
            // "clicked away" — the portal renders under <body>, outside
            // the host's DOM subtree, so contains() alone says away.
            data-tb-dropdown
            style={{
              position: "fixed",
              left: rect.left,
              top: rect.top,
              width: rect.width,
              maxHeight: 260,
              overflowY: "auto",
              background: "var(--tb-n-1)",
              border: "1px solid var(--tb-n-7)",
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
                    if (!sel) e.currentTarget.style.background = "var(--tb-n-3)";
                  }}
                  onMouseLeave={(e) => {
                    if (!sel) e.currentTarget.style.background = "transparent";
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: sel ? "var(--tb-n-5)" : "transparent",
                    border: "none",
                    color: sel ? "var(--tb-a-yellow-400)" : "var(--tb-n-12)",
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
          // The panel's OWN document — a popped-out panel portalling to
          // the main <body> would open its list in the wrong window.
          // Read from context, not the ref: portal targets are computed
          // during render, where refs are off-limits.
          (panelWin ?? window).document.body
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
  const panelWin = usePanelWindow();
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
    const win = ownerWindow(btnRef.current);
    win.addEventListener("mousedown", onDown);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", onResize);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown);
      win.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("keydown", onKey);
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
          background: "var(--tb-n-0)",
          border: `1px solid ${open ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
          borderRadius: 4,
          color: "var(--tb-n-14)",
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
          style={{ flexShrink: 0, color: "var(--tb-n-11)" }}
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
              background: "var(--tb-n-1)",
              border: "1px solid var(--tb-n-7)",
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
                background: "var(--tb-n-0)",
                border: "1px solid var(--tb-n-7)",
                borderRadius: 3,
                color: "var(--tb-n-16)",
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
                      if (!sel) e.currentTarget.style.background = "var(--tb-n-3)";
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
                      background: sel ? "var(--tb-n-5)" : "transparent",
                      border: "none",
                      color: sel ? "var(--tb-a-yellow-400)" : "var(--tb-n-14)",
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
                          color: "var(--tb-n-10)",
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
                <div style={{ color: "var(--tb-n-10)", fontSize: 10, padding: "6px 7px" }}>
                  no match
                </div>
              )}
              {overflow > 0 && (
                <div style={{ color: "var(--tb-n-10)", fontSize: 9, padding: "4px 7px" }}>
                  +{overflow} more — refine search
                </div>
              )}
            </div>
          </div>,
          // The panel's OWN document — a popped-out panel portalling to
          // the main <body> would open its list in the wrong window.
          // Read from context, not the ref: portal targets are computed
          // during render, where refs are off-limits.
          (panelWin ?? window).document.body
        )}
    </>
  );
}

export function menuItemStyle(active?: boolean): React.CSSProperties {
  return {
    background: active ? "var(--tb-n-5)" : "transparent",
    border: "none",
    color: active ? "var(--tb-a-yellow-400)" : "var(--tb-n-15)",
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
        background: on ? "var(--tb-a-blue-500)" : "var(--tb-n-7)",
        border: `1px solid ${on ? "var(--tb-a-blue-500)" : "var(--tb-n-9)"}`,
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
          background: on ? "#fff" : "var(--tb-n-13)",
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
  attrSuggestions,
  attrInvalid,
  onChange,
  rangeOverride,
  onRangeChange,
  layerAnim,
  rampIo,
}: {
  param: ParamDef;
  value: unknown;
  // Sibling params on the same node — only consumed by renderers
  // that need cross-param context (font_variations).
  allParams?: Record<string, unknown>;
  // Upstream channel names for `suggestAttrsFrom` string params —
  // rendered as a datalist picker over the free-text input
  // (081326_point-attributes.md M3).
  attrSuggestions?: string[];
  // The typed attribute name is verified wrong — error tint.
  attrInvalid?: boolean;
  onChange: (v: unknown) => void;
  rangeOverride?: { min?: number; max?: number; softMax?: number };
  onRangeChange?: (
    next: { min?: number; max?: number; softMax?: number } | null
  ) => void;
  // Composite-param keyframing (merge layers) — see LayerAnimApi.
  layerAnim?: LayerAnimApi;
  // Per-stop expose/control toggles for color ramps — see RampIoApi.
  rampIo?: RampIoApi;
}) {
  if (param.type === "track_data") return null;
  if (param.type === "scalar") {
    const num = typeof value === "number" ? value : (param.default as number);
    // Effective range: per-instance override wins over the param def.
    // Each field overrides independently — set just `max` and the
    // others stay at their def defaults.
    const effMin = rangeOverride?.min ?? param.min ?? 0;
    // Param-driven upper bound (maxFrom — e.g. Switch's `index` follows its
    // `count`). An explicit per-node range override still wins over it.
    const dynMax = allParams ? param.maxFrom?.(allParams) : undefined;
    const effMax = rangeOverride?.max ?? dynMax ?? param.max ?? 1;
    const effSoftMax = rangeOverride?.softMax ?? param.softMax;
    // Slider uses softMax when provided so the user can type past it
    // via the number input without the slider pinning the stored value.
    const sliderMax = effSoftMax ?? effMax;
    const sliderMin = effMin;
    const sliderValue = Math.max(sliderMin, Math.min(sliderMax, num));
    // Param-driven increment (stepFrom). When active, every edit — slider,
    // scrub, stepper, typed — snaps to zero-based multiples of it so the
    // stored value lands ON the increments (1.2, 2.4, …), not the native
    // range's min-offset grid. Range bounds still win at the extremes.
    const dynStep = allParams ? param.stepFrom?.(allParams) : undefined;
    const handleChange =
      dynStep !== undefined && dynStep > 0
        ? (v: unknown) => {
            if (typeof v !== "number" || !Number.isFinite(v)) return onChange(v);
            const snapped = parseFloat(
              (Math.round(v / dynStep) * dynStep).toFixed(6)
            );
            onChange(Math.max(effMin, Math.min(effMax, snapped)));
          }
        : onChange;
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
        stepOverride={dynStep}
        rangeOverride={rangeOverride}
        onChange={handleChange}
        onRangeChange={onRangeChange}
      />
    );
  }

  if (param.type === "boolean") {
    return <TogglePill on={!!value} onChange={onChange} />;
  }

  if (param.type === "string") {
    const current = typeof value === "string" ? value : (param.default as string);
    if (param.control === "file_text") {
      return (
        <FileTextControl
          value={value}
          onChange={onChange}
          param={param}
          allParams={allParams}
        />
      );
    }
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
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
            color: "var(--tb-n-16)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "4px 6px",
            boxSizing: "border-box",
            lineHeight: 1.4,
          }}
        />
      );
    }
    // Attribute-name params get a native datalist over the free-text
    // field: focus/typing shows the wired upstream's channel names, but
    // any name still types freely (a channel that doesn't exist YET is
    // legal — Set Named Attribute creates it).
    const suggestId =
      attrSuggestions && attrSuggestions.length > 0
        ? `attr-suggest-${param.name}`
        : undefined;
    return (
      <>
        <input
          type="text"
          value={current}
          placeholder={param.placeholder}
          list={suggestId}
          title={
            attrInvalid
              ? "No attribute with this name on the wired input (reserved names can't be attributes)"
              : undefined
          }
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            width: "100%",
            background: attrInvalid
              ? "color-mix(in srgb, var(--tb-a-red-400) 12%, var(--tb-n-0))"
              : "var(--tb-n-0)",
            border: `1px solid ${attrInvalid ? "var(--tb-a-red-400)" : "var(--tb-n-7)"}`,
            color: "var(--tb-n-16)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "2px 4px",
            boxSizing: "border-box",
          }}
        />
        {suggestId && (
          <datalist id={suggestId}>
            {attrSuggestions!.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </>
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
          style={{ color: "var(--tb-n-16)", fontSize: 10 }}
        />
        {current?.filename && (
          <div style={{ color: "var(--tb-n-11)", fontSize: 10 }}>
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
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-13)",
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
          style={{ color: "var(--tb-n-16)", fontSize: 10 }}
        />
        {current?.family && (
          <div style={{ color: "var(--tb-n-11)", fontSize: 10 }}>
            loaded: {current.filename ?? current.family}
          </div>
        )}
        {current && (
          <button
            onClick={() => onChange(null)}
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-13)",
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
        <div style={{ color: "var(--tb-n-11)", fontSize: 10, fontStyle: "italic" }}>
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
    if (param.control === "exr_layer") {
      // Options come from the sibling media param's EXR layer list (the
      // sequence value on Video Source, the file value on Image Source) —
      // never from `options`. The stored value is the layer's stable id; an
      // id missing from the current file falls back to the default layer.
      const seq = allParams?.sequence as
        | import("@/engine/types").ImageSequenceParamValue
        | null
        | undefined;
      const file = allParams?.file as
        | import("@/engine/types").ExrImageParamValue
        | ImageBitmap
        | null
        | undefined;
      const layers =
        seq?.exr?.layers ??
        (file &&
        typeof file === "object" &&
        !(file instanceof ImageBitmap) &&
        file.kind === "exr"
          ? file.layers
          : []);
      if (!layers.length) {
        return <div style={{ color: "var(--tb-n-10)" }}>(no EXR loaded)</div>;
      }
      const effective = layers.some((l) => l.id === current)
        ? current
        : layers[0].id;
      return (
        <Dropdown
          value={effective}
          options={layers.map((l) => ({ value: l.id, label: l.label }))}
          onChange={(v) => onChange(v)}
        />
      );
    }
    if (param.control === "model_object") {
      // Sibling `model` param carries the file; the object list comes from
      // the shared model cache (see ModelObjectControl).
      const model = allParams?.model as
        | import("@/engine/types").ModelFileParamValue
        | null
        | undefined;
      return (
        <ModelObjectControl
          url={model?.url}
          value={current}
          onChange={onChange}
        />
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
    return <ColorControl value={hex} onChange={onChange} alpha={param.alpha} />;
  }

  if (param.type === "file") {
    return <ImageFileControl value={value} onChange={onChange} />;
  }

  if (param.type === "merge_layers") {
    const layers = Array.isArray(value)
      ? (value as MergeLayer[])
      : ((param.default as MergeLayer[]) ?? []);
    return (
      <MergeLayersControl
        layers={layers}
        onChange={(next) => onChange(next)}
        layerAnim={layerAnim}
      />
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
      border: "1px solid var(--tb-n-9)",
      color: "var(--tb-n-13)",
      fontSize: 12,
      lineHeight: 1,
      padding: "2px 7px",
      borderRadius: 3,
      cursor: "pointer",
      fontFamily: "inherit",
      flexShrink: 0,
    };
    // Point Expression channels render as the standard scalar slider / enum
    // dropdown. `channelDef` is the INFERRED base range (the "reset" fallback,
    // derived from the default); an explicit range from ch(…, min, max) or the
    // right-click editor rides on top as a `rangeOverride` (see channelRange),
    // so the standard SliderRangeEditor's diff-vs-default logic works unchanged.
    const channelDef = (e: ExprInput): ParamDef => {
      if (e.options && e.options.length) {
        return {
          name: e.name,
          type: "enum",
          options: e.options,
          default: e.options[0] ?? "",
        };
      }
      const d = typeof e.default === "number" ? e.default : 0;
      const inferMin = d < 0 ? d * 2 : 0;
      const inferMax = d === 0 ? 1 : Math.abs(d) * 2;
      const step =
        e.step ??
        (inferMax >= 100 ? 1 : inferMax >= 10 ? 0.1 : inferMax >= 1 ? 0.01 : 0.001);
      return {
        name: e.name,
        type: "scalar",
        default: d,
        min: inferMin,
        max: inferMax,
        step,
      };
    };
    // The channel's explicit range (from ch args or the right-click editor),
    // as a rangeOverride. Undefined when nothing's set ⇒ slider uses the
    // inferred base. Right-clicking the slider edits these via onRangeChange.
    const channelRange = (
      e: ExprInput
    ): { min?: number; max?: number; softMax?: number } | undefined => {
      const r: { min?: number; max?: number; softMax?: number } = {};
      if (e.min !== undefined) r.min = e.min;
      if (e.max !== undefined) r.max = e.max;
      if (e.softMax !== undefined) r.softMax = e.softMax;
      return Object.keys(r).length ? r : undefined;
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.length === 0 && (
          <div style={{ color: "var(--tb-n-10)" }}>(no inputs)</div>
        )}
        {list.map((e) => {
          const isChannel = !!param.channelSync;
          const nameField = (
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
                ...(isChannel
                  ? { width: 76, flexShrink: 0 }
                  : { flex: 1, minWidth: 0 }),
                background: "var(--tb-n-1)",
                border: "1px solid var(--tb-n-7)",
                color: "var(--tb-n-16)",
                borderRadius: 3,
                padding: "3px 6px",
                fontFamily: "inherit",
                fontSize: 11,
              }}
              title={
                isChannel
                  ? 'Channel name — matches ch("…") / pick("…") in the expression'
                  : "Variable name used in the expression"
              }
            />
          );
          const removeButton = (
            <button
              onClick={() => update(list.filter((x) => x.id !== e.id))}
              title="Remove"
              style={removeBtn}
            >
              ×
            </button>
          );
          if (isChannel) {
            return (
              <div
                key={e.id}
                style={{ display: "flex", gap: 6, alignItems: "center" }}
              >
                {nameField}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ParamControl
                    param={channelDef(e)}
                    value={e.default}
                    rangeOverride={channelRange(e)}
                    onChange={(v) =>
                      update(
                        list.map((x) =>
                          x.id === e.id
                            ? { ...x, default: v as number | string }
                            : x
                        )
                      )
                    }
                    onRangeChange={(next) =>
                      update(
                        list.map((x) =>
                          x.id === e.id
                            ? {
                                ...x,
                                min: next?.min,
                                max: next?.max,
                                softMax: next?.softMax,
                              }
                            : x
                        )
                      )
                    }
                  />
                </div>
                {removeButton}
              </div>
            );
          }
          return (
            <div
              key={e.id}
              style={{ display: "flex", gap: 6, alignItems: "center" }}
            >
              {nameField}
              <span
                style={{ color: "var(--tb-n-10)", fontSize: 10, flexShrink: 0 }}
                title="Value used when this input is not wired"
              >
                def
              </span>
              <NumberField
                value={typeof e.default === "number" ? e.default : 1}
                onChange={(v) =>
                  update(
                    list.map((x) => (x.id === e.id ? { ...x, default: v } : x))
                  )
                }
                step={0.01}
                width={52}
              />
              {removeButton}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 6, alignSelf: "flex-start" }}>
          <button
            onClick={() => update([...list, newExprInput(list)])}
            style={{
              background: "transparent",
              border: "1px dashed var(--tb-n-9)",
              color: "var(--tb-n-13)",
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            + Add input
          </button>
          {param.channelSync && (
            <button
              // Scan the sibling `expression` param for ch("name", default)
              // calls and add a matching slider for each new one (add-only).
              onClick={() => {
                const next = syncChannelInputs(
                  list,
                  (allParams?.expression as string) ?? ""
                );
                if (next !== list) update(next);
              }}
              title='Add controls for ch(…) sliders and pick(…) dropdowns in the expression'
              style={{
                background: "transparent",
                border: "1px solid var(--tb-n-9)",
                color: "var(--tb-n-13)",
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ⟳ Sync
            </button>
          )}
        </div>
      </div>
    );
  }

  if (param.type === "wedge_values") {
    // The Wedge node's explicit value list — one row per batch-render
    // variation, with the row editor keyed by the node's sibling `type`
    // param (scalar / color / vec2 / string). Index labels double as the
    // mapping to `{i}` filename tokens / the Preview index.
    const wtype = ((allParams?.type as string) ?? "scalar") as
      | "scalar"
      | "color"
      | "vec2"
      | "string";
    const list = Array.isArray(value)
      ? (value as WedgeValueItem[])
      : ((param.default as WedgeValueItem[]) ?? []);
    const update = (next: WedgeValueItem[]) => onChange(next);
    const setRow = (id: string, v: WedgeValueItem["value"]) =>
      update(list.map((x) => (x.id === id ? { ...x, value: v } : x)));
    const removeBtn: React.CSSProperties = {
      background: "transparent",
      border: "1px solid var(--tb-n-9)",
      color: "var(--tb-n-13)",
      fontSize: 12,
      lineHeight: 1,
      padding: "2px 7px",
      borderRadius: 3,
      cursor: "pointer",
      fontFamily: "inherit",
      flexShrink: 0,
    };
    const textStyle: React.CSSProperties = {
      flex: 1,
      minWidth: 0,
      background: "var(--tb-n-1)",
      border: "1px solid var(--tb-n-7)",
      color: "var(--tb-n-16)",
      borderRadius: 3,
      padding: "3px 6px",
      fontFamily: "inherit",
      fontSize: 11,
    };
    const rowEditor = (item: WedgeValueItem) => {
      if (wtype === "color") {
        return (
          <ColorControl
            value={typeof item.value === "string" ? item.value : "#ffffff"}
            onChange={(v) => setRow(item.id, v as string)}
          />
        );
      }
      if (wtype === "vec2") {
        const v = Array.isArray(item.value) ? item.value : [0, 0];
        return (
          <>
            <NumberField
              value={typeof v[0] === "number" ? v[0] : 0}
              onChange={(x) => setRow(item.id, [x, v[1] ?? 0])}
              step={0.01}
              width={56}
            />
            <NumberField
              value={typeof v[1] === "number" ? v[1] : 0}
              onChange={(y) => setRow(item.id, [v[0] ?? 0, y])}
              step={0.01}
              width={56}
            />
          </>
        );
      }
      if (wtype === "string") {
        return (
          <input
            value={typeof item.value === "string" ? item.value : ""}
            spellCheck={false}
            placeholder="value"
            onChange={(e) => setRow(item.id, e.target.value)}
            style={textStyle}
          />
        );
      }
      return (
        <NumberField
          value={typeof item.value === "number" ? item.value : 0}
          onChange={(v) => setRow(item.id, v)}
          step={0.01}
          width={64}
        />
      );
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.length === 0 && (
          <div style={{ color: "var(--tb-n-10)" }}>(no values — batch renders once)</div>
        )}
        {list.map((item, i) => (
          <div
            key={item.id}
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            <span
              style={{ color: "var(--tb-n-10)", fontSize: 10, width: 22, flexShrink: 0 }}
              title={`Variation ${i} — emitted when the batch index is ${i}`}
            >
              {i}
            </span>
            {rowEditor(item)}
            <button
              onClick={() => update(list.filter((x) => x.id !== item.id))}
              title="Remove"
              style={removeBtn}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => {
            if (wtype !== "scalar") {
              update([
                ...list,
                { id: newWedgeValueId(), value: WEDGE_TYPE_DEFAULTS[wtype] },
              ]);
              return;
            }
            // Scalar: seed the new row one step past the last two values'
            // delta (1 when there's no trend) — matches the common
            // "0, 1, 2, …" seed-list case without a range-mode round-trip.
            const nums = list.map((x) =>
              typeof x.value === "number" ? x.value : 0
            );
            const last = nums[nums.length - 1] ?? -1;
            const delta =
              nums.length >= 2 ? last - nums[nums.length - 2] : 1;
            update([
              ...list,
              { id: newWedgeValueId(), value: last + (delta || 1) },
            ]);
          }}
          style={{
            background: "transparent",
            border: "1px dashed var(--tb-n-9)",
            color: "var(--tb-n-13)",
            fontSize: 11,
            padding: "4px 8px",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "inherit",
            alignSelf: "flex-start",
          }}
        >
          + Add value
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
          <span style={{ color: "var(--tb-n-11)", width: 12, flexShrink: 0 }}>
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
          <div style={{ color: "var(--tb-n-10)" }}>(no items — use + on node)</div>
        )}
        {items.map((item, i) => (
          <div
            key={item.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 6,
              border: "1px solid var(--tb-n-7)",
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
              <span style={{ color: "var(--tb-n-13)" }}>item {i + 1}</span>
              <button
                onClick={() => onChange(items.filter((x) => x.id !== item.id))}
                title="Remove item"
                style={{
                  background: "transparent",
                  border: "1px solid var(--tb-n-9)",
                  color: "var(--tb-n-13)",
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
              <span style={{ color: "var(--tb-n-11)", width: 12, flexShrink: 0 }} />
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
                  color: "var(--tb-n-13)",
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
        paramName={param.name}
        layerAnim={layerAnim}
        rampIo={rampIo}
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

  if (param.type === "float_curve") {
    const defaultPoints = Array.isArray(param.default)
      ? (param.default as CurvePoint[])
      : [];
    const points = sanitizeFloatCurve(
      value ?? param.default,
      defaultPoints[0]?.y ?? 0,
      defaultPoints[defaultPoints.length - 1]?.y ?? 1
    );
    return (
      <FloatCurveControl
        points={points}
        defaultPoints={defaultPoints}
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

  return <div style={{ color: "var(--tb-n-11)" }}>(unsupported)</div>;
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

// Grip glyph for the merge-layer drag handle.
function GripIcon() {
  return (
    <svg width={10} height={14} viewBox="0 0 10 14" fill="currentColor">
      {[3, 7, 11].map((cy) =>
        [3, 7].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1} />
        ))
      )}
    </svg>
  );
}

// Eye glyph for the per-layer bypass toggle (open = compositing, slashed =
// bypassed). Mirrors the LayersEditor eye so the metaphor reads the same.
function MergeEyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 7 C2.5 4 4.5 3 7 3 C9.5 3 11.5 4 13 7 C11.5 10 9.5 11 7 11 C4.5 11 2.5 10 1 7 Z" />
      <circle cx="7" cy="7" r="1.8" />
      {!open && <path d="M2 12 L12 2" />}
    </svg>
  );
}

// Invert badge for the per-layer mask-invert toggle: a split circle whose
// left half fills when active (the classic invert glyph). Off = outline only.
function MaskInvertIcon({ active }: { active: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
    >
      <circle cx="7" cy="7" r="5.25" />
      {active ? (
        <path d="M7 1.75 A5.25 5.25 0 0 0 7 12.25 Z" fill="currentColor" stroke="none" />
      ) : (
        <line x1="7" y1="1.75" x2="7" y2="12.25" />
      )}
    </svg>
  );
}

// Editor for the Merge node's `merge_layers` param. One card per layer (blend
// mode + opacity + keyframe diamond), plus a grip handle to drag-reorder the
// stack, an eye toggle to bypass a layer, and a mask-invert badge next to
// remove (flips the layer's wired matte; inert until a mask is connected).
// Reordering rewrites the array,
// which re-derives the node's `layer:<id>`/`mask:<id>` socket order via
// resolveInputs (wires reference ids, so they follow their layer); bypass sets
// `enabled:false`, skipped in merge.ts's blend chain but keeping the socket.
export function MergeLayersControl({
  layers,
  onChange,
  layerAnim,
}: {
  layers: MergeLayer[];
  onChange: (next: MergeLayer[]) => void;
  layerAnim?: LayerAnimApi;
}) {
  const modes = BLEND_MODE_ORDER;
  const panelWin = usePanelWindow();
  const [dragId, setDragId] = useState<string | null>(null);
  // Row elements keyed by layer id, for hit-testing the reorder drag.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Latest layers for the pointermove handler — avoids re-subscribing per move.
  const layersRef = useRef(layers);
  layersRef.current = layers;

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const cur = layersRef.current;
      const from = cur.findIndex((l) => l.id === dragId);
      if (from < 0) return;
      // Insertion index = number of OTHER rows whose vertical midpoint sits
      // above the pointer. That count is exactly where the dragged row lands
      // in the array once it's been spliced out.
      let to = 0;
      for (const l of cur) {
        if (l.id === dragId) continue;
        const el = rowRefs.current.get(l.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (e.clientY > r.top + r.height / 2) to++;
      }
      to = Math.max(0, Math.min(cur.length - 1, to));
      if (to === from) return;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onChange(next);
    };
    const onUp = () => setDragId(null);
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
    };
  }, [dragId, onChange, panelWin]);

  const patch = (id: string, p: Partial<MergeLayer>) =>
    onChange(layers.map((x) => (x.id === id ? { ...x, ...p } : x)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {layers.length === 0 && (
        <div style={{ color: "var(--tb-n-10)" }}>(no layers — use + on node)</div>
      )}
      {layers.map((l, i) => {
        const enabled = l.enabled !== false;
        const dragging = dragId === l.id;
        // Animated readout: a keyframed opacity displays its evaluated value
        // at the playhead (slider follows scrub/playback). Edits patch the
        // stored array; autokey mirrors them into the virtual block.
        const dispOpacity = animScalarAt(
          layerAnim,
          layerOpacityKey(l.id),
          l.opacity
        );
        return (
          <div
            key={l.id}
            ref={(el) => {
              if (el) rowRefs.current.set(l.id, el);
              else rowRefs.current.delete(l.id);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 6,
              border: "1px solid var(--tb-n-7)",
              borderRadius: 3,
              background: dragging ? "var(--tb-n-4)" : undefined,
              opacity: dragging ? 0.6 : 1,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 6,
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
              >
                <span
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDragId(l.id);
                  }}
                  title="Drag to reorder"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    color: "var(--tb-n-10)",
                    cursor: "grab",
                    touchAction: "none",
                    flexShrink: 0,
                  }}
                >
                  <GripIcon />
                </span>
                <button
                  onClick={() => patch(l.id, { enabled: !enabled })}
                  title={enabled ? "Bypass this layer" : "Enable this layer"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: enabled ? "var(--tb-n-13)" : "var(--tb-n-10)",
                    flexShrink: 0,
                  }}
                >
                  <MergeEyeIcon open={enabled} />
                </button>
                <span
                  style={{
                    color: enabled ? "var(--tb-n-13)" : "var(--tb-n-10)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  layer {i + 1}
                  {!enabled && (
                    <span style={{ color: "var(--tb-n-10)" }}> (bypassed)</span>
                  )}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => patch(l.id, { maskInvert: !l.maskInvert })}
                  title={
                    l.maskInvert
                      ? "Mask inverted (1 − coverage) — click to restore"
                      : "Invert this layer's mask (applies once a mask is wired)"
                  }
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: l.maskInvert ? "var(--tb-n-16)" : "var(--tb-n-10)",
                  }}
                >
                  <MaskInvertIcon active={!!l.maskInvert} />
                </button>
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
                    border: "1px solid var(--tb-n-9)",
                    color: "var(--tb-n-13)",
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
            </div>
            {/* Blend mode + opacity share one line: dropdown first, then a bar
                slider + number field styled like the main scalar sliders. Dimmed
                while bypassed (still editable — set up before enabling). */}
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                opacity: enabled ? 1 : 0.5,
              }}
            >
              <Dropdown
                value={l.mode}
                options={modes.map((m) => ({ value: m, label: blendModeLabel(m) }))}
                onChange={(v) => patch(l.id, { mode: v as MergeLayer["mode"] })}
                style={{ width: 96, flexShrink: 0 }}
              />
              <MiniBarSlider
                min={0}
                max={1}
                step={0.01}
                value={dispOpacity}
                onChange={(v) => patch(l.id, { opacity: v })}
                title="Opacity — hold Shift to fine-tune"
              />
              <NumberField
                value={dispOpacity}
                onChange={(v) => patch(l.id, { opacity: v })}
                min={0}
                max={1}
                step={0.01}
                width={44}
              />
              {layerAnim &&
                (() => {
                  // Same diamond contract as scalar rows, against the layer's
                  // virtual animation key. Once animated, slider edits
                  // auto-keyframe via EffectsApp's onParamChange.
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
                              { tick, value: l.opacity, easingOut: "easeInOut" },
                            ],
                          });
                        } else if (findKeyframeAt(block, tick)) {
                          layerAnim.set(key, removeKeyframeAt(block, tick));
                        } else {
                          // Pin the evaluated value — inserting mid-segment
                          // must not snap the curve to the stored constant.
                          layerAnim.set(
                            key,
                            upsertKeyframe(block, tick, dispOpacity, "easeInOut")
                          );
                        }
                      }}
                    />
                  );
                })()}
            </div>
          </div>
        );
      })}
    </div>
  );
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
        <div style={{ color: "var(--tb-n-10)" }}>(no points — add one)</div>
      )}
      {points.map((p, i) => {
        // Animated readouts — keyframed sub-values display their evaluated
        // value at the playhead; edits still patch the stored point.
        const dispX = animScalarAt(layerAnim, gpointXKey(p.id), p.x);
        const dispY = animScalarAt(layerAnim, gpointYKey(p.id), p.y);
        const dispColor = animColorHexAt(
          layerAnim,
          gpointCKey(p.id),
          typeof p.color === "string" ? p.color : "#ffffff"
        );
        return (
        <div
          key={p.id}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: 6,
            border: "1px solid var(--tb-n-7)",
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
            <span style={{ color: "var(--tb-n-13)" }}>point {i + 1}</span>
            <button
              onClick={() => removePoint(p.id)}
              disabled={points.length <= 1}
              title="Remove point"
              style={{
                background: "transparent",
                border: "1px solid var(--tb-n-9)",
                color: points.length <= 1 ? "var(--tb-n-9)" : "var(--tb-n-13)",
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
                value={dispColor}
                onChange={(hex) => update(p.id, { color: hex as string })}
              />
            </div>
            {diamond(
              gpointCKey(p.id),
              hexToRgba01Tuple(dispColor),
              "Keyframe this point's color"
            )}
          </div>
          {/* X / Y row */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "var(--tb-n-11)", width: 10, flexShrink: 0 }}>X</span>
            <NumberField
              value={dispX}
              onChange={(v) => update(p.id, { x: v })}
              min={-0.5}
              max={1.5}
              step={0.001}
              width={56}
            />
            {diamond(gpointXKey(p.id), dispX, "Keyframe this point's X")}
            <span style={{ color: "var(--tb-n-11)", width: 10, flexShrink: 0 }}>Y</span>
            <NumberField
              value={dispY}
              onChange={(v) => update(p.id, { y: v })}
              min={-0.5}
              max={1.5}
              step={0.001}
              width={56}
            />
            {diamond(gpointYKey(p.id), dispY, "Keyframe this point's Y")}
          </div>
        </div>
        );
      })}
      <button
        onClick={addPoint}
        disabled={points.length >= GRADIENT_MAX_POINTS}
        style={{
          background: "transparent",
          border: "1px solid var(--tb-n-9)",
          color: points.length >= GRADIENT_MAX_POINTS ? "var(--tb-n-9)" : "var(--tb-n-13)",
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

// Expose / Control glyphs for the per-stop ramp buttons — same public/ SVG
// mask technique as ParamPanel's row buttons (silhouette recolors via
// currentColor). Editor-only: these render only when a RampIoApi is passed.
function RampMaskGlyph({
  src,
  width,
  height,
}: {
  src: string;
  width: number;
  height: number;
}) {
  const mask = `url(${src}) no-repeat center / contain`;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width,
        height,
        backgroundColor: "currentColor",
        WebkitMask: mask,
        mask,
      }}
    />
  );
}

// Expose + Control toggle pair for one ramp-stop field. Mirrors the colors
// and semantics of a param row's toggles, sized down to sit inline next to
// the field's control.
function RampIoButtons({ keyName, io }: { keyName: string; io: RampIoApi }) {
  const exposed = io.isExposed(keyName);
  const controlled = io.isControlled(keyName);
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--tb-n-7)",
    width: 16,
    height: 16,
    padding: 0,
    boxSizing: "border-box",
    borderRadius: 3,
    cursor: "pointer",
    fontFamily: "inherit",
    flexShrink: 0,
  };
  return (
    <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
      <button
        onClick={() => io.toggleExposed(keyName)}
        title={
          exposed
            ? "Remove the input socket for this stop value"
            : "Add an input socket for this stop value on the node"
        }
        style={{
          ...base,
          background: exposed ? "var(--tb-a-blue-900)" : "transparent",
          color: exposed ? "var(--tb-a-blue-200)" : "var(--tb-n-11)",
        }}
      >
        <RampMaskGlyph
          src="/ExposeSymbol.svg"
          width={5 * (1060 / 420)}
          height={5}
        />
      </button>
      <button
        onClick={() => io.toggleControl(keyName)}
        title={
          controlled
            ? "Remove this stop value from the exported app's control panel"
            : "Show this stop value as a knob in the exported app's control panel"
        }
        style={{
          ...base,
          background: controlled ? "var(--tb-a-emerald-800)" : "transparent",
          color: controlled ? "var(--tb-a-emerald-200)" : "var(--tb-n-11)",
        }}
      >
        <RampMaskGlyph src="/ControlSymbol.svg" width={10} height={10} />
      </button>
    </div>
  );
}

export function ColorRampControl({
  stops,
  onChange,
  paramName,
  layerAnim,
  rampIo,
}: {
  stops: ColorRampStop[];
  onChange: (next: ColorRampStop[]) => void;
  // Param the ramp lives in — needed to build the virtual per-stop keys
  // (ramp_c/a/p:<param>:<stopId>). Optional: without it (or without the
  // APIs below) the per-stop keyframe/expose/control affordances hide and
  // the control degrades to the plain ramp editor (live viewer).
  paramName?: string;
  layerAnim?: LayerAnimApi;
  rampIo?: RampIoApi;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const panelWin = usePanelWindow();
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
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
    };
  }, [dragId, panelWin]);

  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const selected = stops.find((s) => s.id === selectedId) ?? null;

  // Animated readouts: resolve each stop's keyframed sub-values at the
  // playhead for DISPLAY (bar gradient, handles, selected-stop fields), so
  // the ramp follows scrubbing/playback. Wire-driven fields keep the stored
  // value (wire wins over keyframes; the field renders read-only). Edits
  // always patch the stored stops — autokey mirrors them into the blocks.
  const displayStop = (s: ColorRampStop): ColorRampStop => {
    if (!layerAnim || !paramName) return s;
    const kc = rampColorKey(paramName, s.id);
    const ka = rampAlphaKey(paramName, s.id);
    const kp = rampPositionKey(paramName, s.id);
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    return {
      ...s,
      color: rampIo?.isDriven(kc)
        ? s.color
        : animColorHexAt(
            layerAnim,
            kc,
            typeof s.color === "string" ? s.color : "#000000"
          ),
      alpha: rampIo?.isDriven(ka)
        ? (s.alpha ?? 1)
        : clamp01(animScalarAt(layerAnim, ka, s.alpha ?? 1)),
      position: rampIo?.isDriven(kp)
        ? s.position
        : clamp01(animScalarAt(layerAnim, kp, s.position)),
    };
  };
  // Re-sort by display position — animated positions can cross stored order.
  const displaySorted = stops
    .map(displayStop)
    .sort((a, b) => a.position - b.position);
  const selectedDisplay = selected ? displayStop(selected) : null;

  // Build a CSS gradient preview using rgba() so transparency is visible
  // against a checker background layered behind the bar.
  const gradientCss =
    displaySorted.length === 0
      ? "transparent"
      : displaySorted.length === 1
        ? hexAlphaCss(displaySorted[0].color, displaySorted[0].alpha ?? 1)
        : `linear-gradient(to right, ${displaySorted
            .map(
              (s) =>
                `${hexAlphaCss(s.color, s.alpha ?? 1)} ${(s.position * 100).toFixed(2)}%`
            )
            .join(", ")})`;
  const CHECKER =
    "repeating-conic-gradient(var(--tb-n-3) 0% 25%, var(--tb-n-1) 0% 50%) 0 0 / 8px 8px";

  function addStopAt(pos: number) {
    if (stops.length >= COLOR_RAMP_MAX_STOPS) return;
    const p = Math.max(0, Math.min(1, pos));
    // Sample the DISPLAYED ramp so the new stop matches what was clicked
    // (the sampled value becomes the stop's stored constant).
    const color = sampleRampColor(displaySorted, p);
    const alpha = sampleRampAlpha(displaySorted, p);
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

  // Toggle/insert/remove a keyframe on a stop field's virtual track at the
  // playhead — gpoint pattern (see GradientPointsControl). Color keyframes
  // store RGBA tuples for the keyframe engine's color interpolation.
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

  // A wired (driven) field renders read-only, mirroring a driven param row.
  const drivenStyle = (key: string): React.CSSProperties =>
    rampIo?.isDriven(key) ? { opacity: 0.5, pointerEvents: "none" } : {};

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
          border: "1px solid var(--tb-n-7)",
          borderRadius: 3,
          cursor: "copy",
        }}
      >
        {displaySorted.map((s) => {
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
                  ? "1px solid var(--tb-n-16)"
                  : "1px solid var(--tb-n-10)",
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
              border: "1px solid var(--tb-n-7)",
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
              <span style={{ color: "var(--tb-n-13)" }}>
                stop · {displaySorted.findIndex((s) => s.id === selected.id) + 1}/
                {displaySorted.length}
              </span>
              <button
                onClick={() => removeStop(selected.id)}
                disabled={stops.length <= 1}
                style={{
                  background: "transparent",
                  border: "1px solid var(--tb-n-9)",
                  color: stops.length <= 1 ? "var(--tb-n-9)" : "var(--tb-n-13)",
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
            {(() => {
              // Virtual per-stop keys — only buildable when the host passed
              // the param name (editor); the live viewer renders plain rows.
              const keys = paramName
                ? {
                    color: rampColorKey(paramName, selected.id),
                    alpha: rampAlphaKey(paramName, selected.id),
                    position: rampPositionKey(paramName, selected.id),
                  }
                : null;
              // Field readouts + diamond seeds use the display-resolved stop;
              // edits patch the stored `selected` via updateStop.
              const disp = selectedDisplay ?? selected;
              return (
                <>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ color: "var(--tb-n-11)", minWidth: 50 }}>
                      color
                    </span>
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        ...(keys ? drivenStyle(keys.color) : {}),
                      }}
                    >
                      <ColorControl
                        value={disp.color}
                        onChange={(hex) =>
                          updateStop(selected.id, { color: hex as string })
                        }
                      />
                    </div>
                    {keys &&
                      diamond(
                        keys.color,
                        hexToRgba01Tuple(
                          typeof disp.color === "string"
                            ? disp.color
                            : "#ffffff"
                        ),
                        "Keyframe this stop's color"
                      )}
                    {keys && rampIo && (
                      <RampIoButtons keyName={keys.color} io={rampIo} />
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ color: "var(--tb-n-11)", minWidth: 50 }}>
                      alpha
                    </span>
                    <DampenedRangeInput
                      min={0}
                      max={1}
                      step={0.01}
                      value={disp.alpha ?? 1}
                      onChange={(v) => updateStop(selected.id, { alpha: v })}
                      style={{
                        flex: 1,
                        ...(keys ? drivenStyle(keys.alpha) : {}),
                      }}
                    />
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={disp.alpha ?? 1}
                      onChange={(e) =>
                        updateStop(selected.id, {
                          alpha: parseFloat(e.target.value),
                        })
                      }
                      style={{
                        width: 48,
                        background: "var(--tb-n-0)",
                        border: "1px solid var(--tb-n-7)",
                        color: "var(--tb-n-16)",
                        fontFamily: "inherit",
                        fontSize: 11,
                        padding: "2px 4px",
                        ...(keys ? drivenStyle(keys.alpha) : {}),
                      }}
                    />
                    {keys &&
                      diamond(
                        keys.alpha,
                        disp.alpha ?? 1,
                        "Keyframe this stop's alpha"
                      )}
                    {keys && rampIo && (
                      <RampIoButtons keyName={keys.alpha} io={rampIo} />
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ color: "var(--tb-n-11)", minWidth: 50 }}>
                      position
                    </span>
                    <DampenedRangeInput
                      min={0}
                      max={1}
                      step={0.001}
                      value={disp.position}
                      onChange={(v) =>
                        updateStop(selected.id, { position: v })
                      }
                      style={{
                        flex: 1,
                        ...(keys ? drivenStyle(keys.position) : {}),
                      }}
                    />
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.001}
                      value={disp.position}
                      onChange={(e) =>
                        updateStop(selected.id, {
                          position: parseFloat(e.target.value),
                        })
                      }
                      style={{
                        width: 48,
                        background: "var(--tb-n-0)",
                        border: "1px solid var(--tb-n-7)",
                        color: "var(--tb-n-16)",
                        fontFamily: "inherit",
                        fontSize: 11,
                        padding: "2px 4px",
                        ...(keys ? drivenStyle(keys.position) : {}),
                      }}
                    />
                    {keys &&
                      diamond(
                        keys.position,
                        disp.position,
                        "Keyframe this stop's position"
                      )}
                    {keys && rampIo && (
                      <RampIoButtons keyName={keys.position} io={rampIo} />
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div style={{ color: "var(--tb-n-10)" }}>(click the bar to add a stop)</div>
        )}
      </div>
      <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
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
  if (sorted.length === 0) return "var(--tb-n-12)";
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
  rgb: "var(--tb-n-16)",
  r: "var(--tb-a-red-500)",
  g: "var(--tb-a-green-500)",
  b: "var(--tb-a-blue-500)",
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

// Generic single-channel curve editor: an SVG chart editing one CurvePoint[]
// (monotone cubic, x/y clamped 0..1). The RGB Curves control wraps this per
// channel; the `float_curve` param type renders it directly. Interactions:
// click empty chart to add, drag to move, drag far off-chart (or the remove
// button) to delete. Selection state is internal — remount (`key`) to clear.
export function FloatCurveEditor({
  points,
  onChange,
  color = "var(--tb-n-16)",
}: {
  points: CurvePoint[];
  onChange: (next: CurvePoint[]) => void;
  color?: string;
}) {
  const panelWin = usePanelWindow();
  const [dragId, setDragId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Map svg viewBox coords <-> curve (0..1) coords. The chart is inset by
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

  // Client px → svg viewBox units (the svg renders at panel width, which
  // may differ from the 200-unit viewBox).
  function clientToSvg(e: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scale = rect.width > 0 ? CURVE_SIZE / rect.width : 1;
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
    };
  }

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const sp = clientToSvg(e);
      const offChart =
        sp.y < -CURVE_DRAG_OFF_THRESHOLD ||
        sp.y > CURVE_SIZE + CURVE_DRAG_OFF_THRESHOLD;
      const pts = pointsRef.current;
      if (offChart && pts.length > 2) {
        // Mark the dragged point for imminent removal on pointer up.
        return;
      }
      const cc = svgToCurve(
        Math.max(0, Math.min(CURVE_SIZE, sp.x)),
        Math.max(0, Math.min(CURVE_SIZE, sp.y))
      );
      const nx = Math.max(0, Math.min(1, cc.x));
      const ny = Math.max(0, Math.min(1, cc.y));
      const next = pts.map((p) =>
        p.id === dragId ? { ...p, x: nx, y: ny } : p
      );
      // Keep points sorted by x after moves so rendering/eval stays consistent.
      next.sort((a, b) => a.x - b.x);
      onChangeRef.current(next);
    };
    const onUp = (e: PointerEvent) => {
      // If released off-chart (and we have more than 2 points), remove the
      // dragged point — classic curve editor gesture.
      const sp = clientToSvg(e);
      const offChart =
        sp.y < -CURVE_DRAG_OFF_THRESHOLD ||
        sp.y > CURVE_SIZE + CURVE_DRAG_OFF_THRESHOLD;
      const pts = pointsRef.current;
      if (offChart && pts.length > 2) {
        onChangeRef.current(pts.filter((p) => p.id !== dragId));
        setSelectedId(null);
      }
      setDragId(null);
    };
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, panelWin]);

  const tangents = computeMonotoneTangents(points);

  // Build the curve path by sampling the monotone cubic densely.
  const SAMPLES = 96;
  const pathSegments: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const y = evalMonotoneCubic(points, tangents, t);
    const sp = curveToSvg(t, Math.max(0, Math.min(1, y)));
    pathSegments.push(
      `${i === 0 ? "M" : "L"} ${sp.x.toFixed(2)} ${sp.y.toFixed(2)}`
    );
  }
  const pathD = pathSegments.join(" ");

  function addPointAtSvg(sx: number, sy: number) {
    if (points.length >= 24) return; // soft cap for sanity
    const cc = svgToCurve(sx, sy);
    const nx = Math.max(0, Math.min(1, cc.x));
    const ny = Math.max(0, Math.min(1, cc.y));
    const id = newCurvePointId();
    const next = [...points, { id, x: nx, y: ny }].sort((a, b) => a.x - b.x);
    onChange(next);
    setSelectedId(id);
    setDragId(id);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <svg
        ref={svgRef}
        width={CURVE_SIZE}
        height={CURVE_SIZE}
        viewBox={`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const sp = clientToSvg(e);
          addPointAtSvg(sp.x, sp.y);
        }}
        style={{
          display: "block",
          width: "100%",
          maxWidth: CURVE_SIZE,
          height: "auto",
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
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
                stroke="var(--tb-n-5)"
                strokeWidth={1}
              />
              <line
                x1={p2.x}
                y1={p2.y}
                x2={q2.x}
                y2={q2.y}
                stroke="var(--tb-n-5)"
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
              stroke="var(--tb-n-7)"
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
              fill={selected ? color : "var(--tb-n-0)"}
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

      {selectedId &&
        (() => {
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
                border: "1px solid var(--tb-n-7)",
                borderRadius: 3,
              }}
            >
              <div style={{ color: "var(--tb-n-13)" }}>
                point {idx + 1}/{points.length}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ color: "var(--tb-n-11)", minWidth: 14 }}>x</span>
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
                    onChange(next);
                  }}
                  style={inputStyle()}
                />
                <span style={{ color: "var(--tb-n-11)", minWidth: 14 }}>y</span>
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
                    onChange(next);
                  }}
                  style={inputStyle()}
                />
              </div>
              <button
                onClick={() => {
                  if (points.length <= 2) return;
                  const next = points.filter((q) => q.id !== pt.id);
                  onChange(next);
                  setSelectedId(null);
                }}
                disabled={points.length <= 2}
                style={{
                  marginTop: 2,
                  background: "transparent",
                  border: "1px solid var(--tb-n-9)",
                  color: points.length <= 2 ? "var(--tb-n-9)" : "var(--tb-n-13)",
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

      <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
        click to add · drag to move · drag far off-chart to remove
      </div>
    </div>
  );
}

// The `float_curve` param type's row control: the generic editor plus a
// reset-to-default button (fresh point ids so reset never aliases the
// ParamDef's default array).
export function FloatCurveControl({
  points,
  defaultPoints,
  onChange,
}: {
  points: CurvePoint[];
  defaultPoints: CurvePoint[];
  onChange: (next: CurvePoint[]) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <FloatCurveEditor points={points} onChange={onChange} />
      <button
        onClick={() =>
          onChange(defaultPoints.map((p) => ({ ...p, id: newCurvePointId() })))
        }
        style={buttonStyle()}
      >
        reset
      </button>
    </div>
  );
}

export function CurvesControl({
  curves,
  onChange,
}: {
  curves: CurvesValue;
  onChange: (next: CurvesValue) => void;
}) {
  const [activeCh, setActiveCh] = useState<CurveChannel>("rgb");

  function resetChannel(ch: CurveChannel) {
    onChange({ ...curves, [ch]: defaultCurveChannel() });
  }

  function resetAll() {
    onChange(defaultCurvesValue());
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {CURVE_CHANNELS.map((ch) => {
          const active = ch === activeCh;
          return (
            <button
              key={ch}
              onClick={() => setActiveCh(ch)}
              style={{
                flex: 1,
                padding: "3px 0",
                background: active ? CURVE_CHANNEL_COLORS[ch] : "var(--tb-n-3)",
                color: active ? "var(--tb-n-0)" : CURVE_CHANNEL_COLORS[ch],
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

      <FloatCurveEditor
        key={activeCh}
        points={curves[activeCh]}
        color={CURVE_CHANNEL_COLORS[activeCh]}
        onChange={(next) => onChange({ ...curves, [activeCh]: next })}
      />

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
          color: "var(--tb-n-13)",
          fontSize: 10,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={`${axis.name} (${axis.tag}) — ${axis.min}…${axis.max}, default ${axis.default}`}
      >
        {axis.name}
        <span style={{ color: "var(--tb-n-10)", marginLeft: 4 }}>
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
                color: "var(--tb-n-11)",
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
                color: "var(--tb-n-13)",
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
                border: "1px solid var(--tb-n-9)",
                color: "var(--tb-n-13)",
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
            border: "1px solid var(--tb-n-9)",
            color: "var(--tb-n-13)",
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
            color: "var(--tb-n-11)",
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
            color: "var(--tb-n-10)",
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
                color: "var(--tb-n-16)",
                textAlign: "center",
                background: "var(--tb-n-0)",
                border: "1px solid var(--tb-n-7)",
                borderRadius: 2,
                padding: "1px 0",
                fontFamily: "var(--code-font)",
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
                color: "var(--tb-n-13)",
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
      <div style={{ color: "var(--tb-n-10)", fontSize: 10, fontStyle: "italic" }}>
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
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-7)",
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
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-13)",
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
          color: "var(--tb-n-11)",
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
          color: "var(--tb-n-13)",
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
    background: "var(--tb-n-0)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    padding: "2px 4px",
  };
}

export function buttonStyle(): React.CSSProperties {
  return {
    flex: 1,
    background: "var(--tb-n-3)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-13)",
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 3,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

// Corner radius shared by both bar-style sliders (MiniBarSlider and
// ScalarSliderRow) — track and fill alike, so the fill's leading cap
// keeps following the track's curve. Half of the 20px track height
// would be a full pill; this sits just inside that.
// Exported so the stand-ins that occupy a slider's slot (EffectNode's
// "driven by a wired input" pill) keep the same silhouette.
export const BAR_SLIDER_RADIUS = 8;

// Leading-edge handle on both bar sliders: a pill-capped bar rather than a
// hairline. It rides just *inside* the fill — BAR_HANDLE_GAP of fill still
// showing past its leading edge — instead of straddling the boundary.
const BAR_HANDLE_W = 3;
const BAR_HANDLE_GAP = 2;
// Floor/ceiling on that travel, for fills too short (or too full) to hold the
// handle clear of the outline.
const BAR_HANDLE_INSET = 3;

// Left edge of the handle for a given fill percentage. Anchored to the fill's
// leading edge and clamped to the track, so the offset is inward at every
// value rather than flipping sign across the middle.
function barHandleLeft(fillPct: number): string {
  const p = Math.max(0, Math.min(100, fillPct));
  return (
    `clamp(${BAR_HANDLE_INSET}px,` +
    ` calc(${p}% - ${BAR_HANDLE_W + BAR_HANDLE_GAP}px),` +
    ` calc(100% - ${BAR_HANDLE_INSET + BAR_HANDLE_W}px))`
  );
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
  overlay,
  height,
  minWidth,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  title?: string;
  /**
   * Optional labels drawn inside the track (above the fill, below the
   * interaction layer). Click-through, so the whole bar stays draggable.
   */
  overlay?: React.ReactNode;
  /** Track height; defaults to the 20px param-panel row. */
  height?: number;
  /**
   * Narrowest the track may shrink to. The 40px default is the floor that
   * still reads as a draggable bar in a param row; on-node hosts that
   * declare a tighter node width pass their own so the row fits the node
   * instead of pushing it wider (the node auto-sizes to its content, so an
   * unshrinkable bar silently overrides the node's minWidth).
   */
  minWidth?: number;
}) {
  const clamped = Math.max(min, Math.min(max, value));
  const fillPct =
    max > min ? ((clamped - min) / (max - min)) * 100 : 0;
  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        height: height ?? 20,
        minWidth: minWidth ?? 40,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: BAR_SLIDER_RADIUS,
          background: "var(--tb-n-1)",
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
            background: "var(--tb-n-5)",
            borderRadius: BAR_SLIDER_RADIUS,
          }}
        />
      </div>
      {/* Outline, above the fill. An inset shadow on the track itself paints
          under its children, so the fill swallowed the left corners of the
          ring and the rounding read as broken. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: BAR_SLIDER_RADIUS,
          boxShadow: "inset 0 0 0 1px var(--tb-n-6)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: barHandleLeft(fillPct),
          top: "21%",
          bottom: "21%",
          width: BAR_HANDLE_W,
          borderRadius: 999,
          background: "var(--tb-n-12)",
          pointerEvents: "none",
        }}
      />
      {overlay !== undefined && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          {overlay}
        </div>
      )}
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
  stepOverride,
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
  // Param-driven increment (ParamDef.stepFrom, resolved by the caller
  // against the node's current params). Wins over the static `step`.
  stepOverride?: number;
  rangeOverride?: { min?: number; max?: number; softMax?: number };
  onChange: (v: unknown) => void;
  onRangeChange?: (
    next: { min?: number; max?: number; softMax?: number } | null
  ) => void;
}) {
  const step = stepOverride ?? param.step ?? 0.01;
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
  const barColor = hasOverride ? "var(--tb-t-navy-d-7)" : "var(--tb-n-5)";
  const lineColor = hasOverride ? "#6b8fc7" : "var(--tb-n-12)";
  // Axis-meaning gradient (ParamDef.trackGradient — Temp's blue↔amber, Hue's
  // rainbow). Painted dim across the whole track as a preview of both
  // directions, and vivid under the fill so the leading edge shows the
  // current value's color. The fill div is only fillPct% wide, so its
  // background is stretched back out to the full track width to keep the
  // colors anchored in place. When a gradient is present it wins over the
  // range-override fill tint; the override still shows via the handle and
  // number-field border.
  const grad = param.trackGradient;
  const fillStyle: React.CSSProperties = grad
    ? {
        backgroundImage: grad,
        backgroundSize: `${fillPct > 0 ? 10000 / fillPct : 100}% 100%`,
      }
    : { background: barColor };
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
            borderRadius: BAR_SLIDER_RADIUS,
            background: "var(--tb-n-1)",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          {grad && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: grad,
                opacity: 0.25,
              }}
            />
          )}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${fillPct}%`,
              ...fillStyle,
              borderRadius: BAR_SLIDER_RADIUS,
            }}
          />
        </div>
        {/* Outline, above the fill so the ring wraps the rounded corners
            unbroken (an inset shadow on the track paints under its fill). */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: BAR_SLIDER_RADIUS,
            boxShadow: "inset 0 0 0 1px var(--tb-n-6)",
            pointerEvents: "none",
          }}
        />
        {/* Leading-edge handle at the value, inset vertically. */}
        <div
          style={{
            position: "absolute",
            left: barHandleLeft(fillPct),
            top: "21%",
            bottom: "21%",
            width: BAR_HANDLE_W,
            borderRadius: 999,
            background: lineColor,
            pointerEvents: "none",
          }}
        />
        {/* Transparent native range on top — interaction + grab target. */}
        <DampenedRangeInput
          className="param-slider-bare"
          min={sliderMin}
          max={sliderMax}
          step={step}
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
        step={step}
        width={44}
        borderColor={hasOverride ? "var(--tb-a-blue-900)" : "var(--tb-n-7)"}
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
    return evalNumExpr(t) ?? undefined;
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
    const win = ownerWindow(rootRef.current);
    win.addEventListener("mousedown", onDown);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown);
      win.removeEventListener("keydown", onKey);
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
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        padding: 8,
        zIndex: 50,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        fontFamily: "var(--ui-font)",
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
          color: "var(--tb-n-13)",
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
            border: "1px solid var(--tb-n-9)",
            color: override ? "var(--tb-n-16)" : "var(--tb-n-10)",
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
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-16)",
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
              background: "var(--tb-a-blue-900)",
              border: "1px solid var(--tb-a-blue-900)",
              color: "var(--tb-a-blue-100)",
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
      <span style={{ color: "var(--tb-n-13)", minWidth: 60 }}>{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
          color: "var(--tb-n-16)",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "2px 4px",
        }}
      />
    </div>
  );
}
