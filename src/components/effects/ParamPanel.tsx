"use client";

import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getNodeDef } from "@/engine/registry";
import { paramSocketType } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";
import type { ParamDef } from "@/engine/types";
import LoadGrid from "./LoadGrid";
import ImageGeneratePanel from "./ImageGeneratePanel";
import BgRemovePanel from "./BgRemovePanel";
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
import {
  diamondStateFor,
  findKeyframeAt,
  isKeyframable,
  removeKeyframeAt,
  upsertKeyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import KeyframeDiamond from "./KeyframeDiamond";
import TrackVisibilityEye from "./TrackVisibilityEye";

// NOTE: Auto-keyframe on parameter edits (spec §2.2 / §2.3) is NOT done
// inside ParamRow. ParamRow keeps emitting raw `onChange(v)` for every
// edit; the auto-keyframe rule lives at the param-change call site
// (EffectsApp), which has the full undo/redo + tick context. EffectsApp
// should: if `animation[paramName]?.animated === true && !driven`, route
// the edit through `upsertKeyframe(block, ctx.tick, value)` instead of
// writing to `params[paramName]`.

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
  // Toggles whether a param shows up as a knob in an exported app's control
  // panel. Independent of expose — both can be on; they answer different
  // questions (engine input socket vs end-user-app control).
  onToggleParamControl: (nodeId: string, paramName: string) => void;
  // Triggers the Export App modal for the given output node. Surfaced here
  // (and on the Output node header) per spec §16. Called only when the
  // selected node has `defType === "output"`.
  onExportApp?: (nodeId: string) => void;
  // Updates the user-defined slider range override for a single
  // scalar param. Pass `null` to clear the override (slider falls
  // back to the param def's defaults).
  onParamRangeChange?: (
    nodeId: string,
    paramName: string,
    override: { min?: number; max?: number; softMax?: number } | null
  ) => void;
  // Toggle the chain-link state for a `linkedPairs` entry. The pair key
  // is `${a}:${b}` matching the order in the node def. When linked,
  // editing either param proportionally updates the other.
  onToggleParamLink?: (nodeId: string, pairKey: string) => void;
  // Returns true when an exposed param currently has an incoming edge
  // driving it. The row is rendered read-only with a "driven" indicator.
  isParamDriven: (nodeId: string, paramName: string) => boolean;
  // Current playhead tick (integer). Used by the keyframe-diamond to
  // decide insert vs remove at the current time. Defaults to 0 for
  // callers that haven't migrated to the tick model yet.
  currentTick?: number;
  // Lookup for the per-parameter animation block on a node. Returns
  // undefined when the parameter has no animation data yet.
  getAnimation?: (
    nodeId: string,
    paramName: string
  ) => KeyframeAnimationBlock | undefined;
  // Writes the animation block back. Pass `undefined` to delete the
  // entry entirely. Used for diamond clicks, right-click "disable", and
  // visibility-eye toggles (visibility folds in via this prop).
  onAnimationChange?: (
    nodeId: string,
    paramName: string,
    next: KeyframeAnimationBlock | undefined
  ) => void;
  signedIn?: boolean;
  // Current user id (or null when signed out). Lets the load grid
  // flag public projects authored by the viewer as "you".
  currentUserId?: string | null;
  // Clicking a project thumbnail triggers load in the parent.
  onLoadProject?: (id: string) => void;
  // Bumped by the parent after save/delete so LoadGrid refetches.
  loadRefreshKey?: number;
  // Active project id — needed by AI nodes (Image Generate) that
  // scope their per-(user,project,node) Supabase session row by it.
  projectId?: string | null;
  // Edge list — the Image Generate panel filters these to find its
  // connected ref_a/b/c inputs. Cheap pass-through; no per-node
  // pre-computation in EffectsApp.
  edges?: Edge[];
  // Read the upstream node's primary IMAGE output as a PNG Blob.
  // The Image Generate panel uses this at send-time to package its
  // ref inputs as input_image attachments for OpenAI.
  getRefImageBlob?: (sourceNodeId: string) => Promise<Blob | null>;
}

// Drop-in <input type="range"> wrapper that dampens the per-event delta
// to 10% while the user holds Shift during a drag. Tracks shift via a
// window listener (the slider's `change` event doesn't carry modifier
// keys), and tracks the slider's "native" position via a ref so each
// onChange is interpreted as an incremental delta from the prior event.
// While dampened, the thumb visually lags behind the cursor — the
// cumulative drag still moves, just at a finer rate.
function DampenedRangeInput(
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
  onToggleParamControl,
  onExportApp,
  onParamRangeChange,
  onToggleParamLink,
  isParamDriven,
  currentTick = 0,
  getAnimation,
  onAnimationChange,
  signedIn,
  currentUserId,
  onLoadProject,
  loadRefreshKey,
  projectId,
  edges,
  getRefImageBlob,
}: Props) {
  const selected = selectedId
    ? nodes.find((n) => n.id === selectedId)
    : undefined;
  const def = selected ? getNodeDef(selected.data.defType) : undefined;

  return (
    <div
      className="no-scrollbar"
      style={{
        height: "100%",
        width: "100%",
        overflowY: "auto",
        // Clip any sub-pixel horizontal overflow so a stray child can't
        // push the visible right edge inward and break the symmetry.
        overflowX: "hidden",
        padding: 10,
        boxSizing: "border-box",
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
        <LoadGrid
          signedIn={!!signedIn}
          currentUserId={currentUserId ?? null}
          onLoad={(id) => onLoadProject?.(id)}
          refreshKey={loadRefreshKey}
        />
      ) : selected && selected.data.defType === "image-generate" ? (
        // Custom split-view UI for the AI Image Generate node. This
        // node owns the entire param panel — the standard property
        // list is bypassed in favour of the chat / thumbnails layout.
        //
        // `key={selected.id}` forces a fresh component instance each
        // time the user switches between Image Generate nodes. Two
        // problems it solves:
        //   1. Stale session state: without a remount, the in-flight
        //      loadSession() for the previous node can race with the
        //      new node's load and clobber the displayed chat.
        //   2. Stray local state (the prompt textarea, the signed-
        //      URL cache, expanded settings popover) bleeds across
        //      nodes. With the key, each node gets its own.
        <ImageGeneratePanel
          key={selected.id}
          node={selected}
          projectId={projectId ?? null}
          signedIn={!!signedIn}
          edges={edges ?? []}
          onParamChange={onParamChange}
          getRefImageBlob={getRefImageBlob}
        />
      ) : selected && selected.data.defType === "bg-remove" ? (
        // Custom BG-remove panel: Bake button + status + live edge
        // params (feather, threshold). Same key trick as Image
        // Generate keeps state isolated per node instance.
        <BgRemovePanel
          key={selected.id}
          node={selected}
          edges={edges ?? []}
          getRefImageBlob={getRefImageBlob}
          onParamChange={onParamChange}
        />
      ) : selected && def ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {def.type === "output" && onExportApp && (
            <button
              onClick={() => onExportApp(selected.id)}
              style={{
                background: "#1e3a8a",
                border: "1px solid #1d4ed8",
                color: "#bfdbfe",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "center",
                letterSpacing: 0.3,
              }}
              title="Bundle this graph into a self-contained, runnable web app"
            >
              Export App →
            </button>
          )}
          <Section label={`${def.name} · parameters`}>
          {(() => {
            const exposedSet = new Set(selected.data.exposedParams ?? []);
            const controlSet = new Set(selected.data.controlParams ?? []);
            const visible = def.params.filter((p) => {
              if (p.hidden) return false;
              // Always show exposed/controlled params so the user can reach
              // them to un-toggle, even when `visibleIf` would otherwise hide.
              if (exposedSet.has(p.name)) return true;
              if (controlSet.has(p.name)) return true;
              return p.visibleIf?.(selected.data.params) ?? true;
            });
            if (visible.length === 0) {
              return <div style={{ color: "#52525b" }}>(no parameters)</div>;
            }
            return visible.map((p) => {
              const exposable = paramSocketType(p.type) !== null;
              const isExposed = exposedSet.has(p.name);
              const isControlled = controlSet.has(p.name);
              const driven = isExposed && isParamDriven(selected.id, p.name);
              // Param types the export panel can't render. Toggling control
              // on these is allowed but the export-modal warns the user.
              const controlSupported =
                p.type !== "paint" &&
                p.type !== "merge_layers" &&
                p.type !== "curves" &&
                p.type !== "color_ramp" &&
                p.type !== "spline_anchors" &&
                p.type !== "file" &&
                p.type !== "video_file" &&
                p.type !== "audio_file" &&
                p.type !== "svg_file" &&
                p.type !== "font";
              const override = selected.data.paramOverrides?.[p.name];
              // Resolve chain-link UI state for this param. A param can
              // appear in at most one pair (linked pairs are exclusive
              // by construction at the def level).
              const pair = def.linkedPairs?.find(
                (lp) => lp.a === p.name || lp.b === p.name
              );
              const pairKey = pair ? `${pair.a}:${pair.b}` : null;
              const linkInfo = pair && pairKey
                ? {
                    pairKey,
                    isLinked: !!selected.data.linkedParams?.[pairKey],
                    partnerName: pair.a === p.name ? pair.b : pair.a,
                  }
                : undefined;
              return (
                <ParamRow
                  key={p.name}
                  param={p}
                  value={selected.data.params[p.name]}
                  allParams={selected.data.params}
                  onChange={(v) => onParamChange(selected.id, p.name, v)}
                  exposed={isExposed}
                  exposable={exposable}
                  driven={driven}
                  controlled={isControlled}
                  controlSupported={controlSupported}
                  onToggleExposed={
                    exposable
                      ? () => onToggleParamExposed(selected.id, p.name)
                      : undefined
                  }
                  onToggleControl={() =>
                    onToggleParamControl(selected.id, p.name)
                  }
                  rangeOverride={override}
                  onRangeChange={
                    onParamRangeChange
                      ? (next) =>
                          onParamRangeChange(selected.id, p.name, next)
                      : undefined
                  }
                  linkInfo={linkInfo}
                  onToggleLink={
                    linkInfo && onToggleParamLink
                      ? () => onToggleParamLink(selected.id, linkInfo.pairKey)
                      : undefined
                  }
                  animation={getAnimation?.(selected.id, p.name)}
                  currentTick={currentTick}
                  keyframable={isKeyframable(p.type)}
                  onAnimationChange={
                    onAnimationChange
                      ? (next) =>
                          onAnimationChange(selected.id, p.name, next)
                      : undefined
                  }
                />
              );
            });
          })()}
          </Section>
        </div>
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          color: "#71717a",
          textTransform: "uppercase",
          letterSpacing: 1,
          fontSize: 10,
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
  allParams,
  onChange,
  exposed,
  exposable,
  driven,
  controlled,
  controlSupported,
  onToggleExposed,
  onToggleControl,
  rangeOverride,
  onRangeChange,
  linkInfo,
  onToggleLink,
  animation,
  currentTick = 0,
  keyframable = false,
  onAnimationChange,
}: {
  param: ParamDef;
  value: unknown;
  // Full param object for the selected node — passed alongside the
  // single-param value so renderers that need cross-param context
  // (font_variations reading `custom_font.axes` from the same node)
  // can opt in without restructuring the whole row.
  allParams?: Record<string, unknown>;
  onChange: (v: unknown) => void;
  exposed?: boolean;
  exposable?: boolean;
  driven?: boolean;
  controlled?: boolean;
  controlSupported?: boolean;
  onToggleExposed?: () => void;
  onToggleControl?: () => void;
  // Per-instance slider range override (right-click → Edit range).
  // Each field falls back to the param def when undefined.
  rangeOverride?: { min?: number; max?: number; softMax?: number };
  onRangeChange?: (
    next: { min?: number; max?: number; softMax?: number } | null
  ) => void;
  // Chain-link UI state for this param (only set when the param is
  // half of a `linkedPairs` entry on the node def).
  linkInfo?: { pairKey: string; isLinked: boolean; partnerName: string };
  onToggleLink?: () => void;
  // Per-parameter keyframe animation block (spec §6.1). Undefined when
  // the parameter has never been keyframed.
  animation?: KeyframeAnimationBlock;
  // Current playhead tick — drives diamond state and insert/remove.
  currentTick?: number;
  // Whether this param's type can be keyframed at all (caller passes
  // isKeyframable(param.type)). When false, the eye and diamond are not
  // rendered, preserving the existing layout for unsupported types.
  keyframable?: boolean;
  // Emit a new animation block (or undefined to remove) for this param.
  // Auto-keyframe on edit must be implemented at the param-change call
  // site (EffectsApp), since ParamRow doesn't know `currentTick`
  // semantics deeply enough to insert without coordinating with undo
  // history. EffectsApp should: if `animation[paramName]?.animated ===
  // true && !driven`, route the edit through `upsertKeyframe(block,
  // ctx.tick, value)` instead of writing to `params[paramName]`.
  onAnimationChange?: (next: KeyframeAnimationBlock | undefined) => void;
}) {
  const label = param.label ?? param.name;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      const target = e.target as globalThis.Node | null;
      if (target && menuRef.current.contains(target)) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [menuOpen]);

  const animated = !!animation?.animated;
  const diamondState = keyframable
    ? diamondStateFor(animation, currentTick)
    : "empty";

  const handleDiamondClick = () => {
    if (!onAnimationChange) return;
    if (driven) return;
    if (!animation || !animation.animated) {
      // Enable: turn animation on and seed first keyframe at the
      // playhead with the parameter's current value.
      onAnimationChange({
        animated: true,
        trackVisible: true,
        keyframes: [
          { tick: currentTick, value, easingOut: "easeInOut" },
        ],
      });
      return;
    }
    if (findKeyframeAt(animation, currentTick)) {
      onAnimationChange(removeKeyframeAt(animation, currentTick));
    } else {
      onAnimationChange(
        upsertKeyframe(animation, currentTick, value, "easeInOut")
      );
    }
  };

  const handleDisableEnable = () => {
    if (!onAnimationChange) return;
    if (!animation) {
      onAnimationChange({
        animated: true,
        trackVisible: true,
        keyframes: [],
      });
    } else {
      onAnimationChange({ ...animation, animated: !animation.animated });
    }
    setMenuOpen(false);
  };

  const handleColorSpace = (space: "oklab" | "rgb") => {
    if (!onAnimationChange) return;
    const base: KeyframeAnimationBlock = animation ?? {
      animated: false,
      trackVisible: true,
      keyframes: [],
    };
    onAnimationChange({ ...base, colorSpace: space });
    setMenuOpen(false);
  };

  const handleVisibilityClick = () => {
    if (!onAnimationChange || !animation) return;
    onAnimationChange({ ...animation, trackVisible: !animation.trackVisible });
  };

  return (
    <div
      style={{
        padding: 10,
        boxSizing: "border-box",
        width: "100%",
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
          marginBottom: 8,
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
          {linkInfo && onToggleLink && (
            <button
              onClick={onToggleLink}
              title={
                linkInfo.isLinked
                  ? `Unlink from ${linkInfo.partnerName}`
                  : `Link with ${linkInfo.partnerName} (preserve ratio)`
              }
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                color: linkInfo.isLinked ? "#facc15" : "#52525b",
                display: "inline-flex",
                alignItems: "center",
                lineHeight: 1,
              }}
            >
              <ChainIcon linked={linkInfo.isLinked} />
            </button>
          )}
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
        <div style={{ display: "flex", gap: 4 }}>
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
          {onToggleControl && (
            <button
              onClick={onToggleControl}
              title={
                !controlSupported
                  ? "This param type can't be rendered in an exported app — toggling has no effect"
                  : controlled
                  ? "Remove this knob from the exported app's control panel"
                  : "Show this param as a knob in the exported app's control panel"
              }
              style={{
                background: controlled ? "#065f46" : "transparent",
                border: "1px solid #27272a",
                color: controlled
                  ? "#a7f3d0"
                  : controlSupported
                  ? "#71717a"
                  : "#3f3f46",
                fontSize: 9,
                padding: "1px 6px",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: "inherit",
                opacity: controlSupported ? 1 : 0.6,
              }}
            >
              {controlled ? "controlled" : "control"}
            </button>
          )}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          position: "relative",
        }}
      >
        {keyframable && (
          <TrackVisibilityEye
            visible={animation?.trackVisible ?? false}
            enabled={animated}
            onClick={handleVisibilityClick}
            title={
              !animated
                ? "Track visibility — enable animation to use"
                : animation?.trackVisible
                ? "Hide track in Track Editor"
                : "Show track in Track Editor"
            }
          />
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            opacity: driven ? 0.5 : 1,
            pointerEvents: driven ? "none" : "auto",
          }}
        >
          <ParamControl
            param={param}
            value={value}
            allParams={allParams}
            onChange={onChange}
            rangeOverride={rangeOverride}
            onRangeChange={onRangeChange}
          />
        </div>
        {keyframable && (
          <div style={{ position: "relative" }}>
            <KeyframeDiamond
              state={diamondState}
              disabled={driven}
              onClick={handleDiamondClick}
              onContextMenu={() => setMenuOpen((v) => !v)}
              title={
                driven
                  ? "wired — disconnect to use keyframes"
                  : diamondState === "empty"
                  ? "Animate this parameter"
                  : diamondState === "red"
                  ? "Remove keyframe at playhead"
                  : "Insert keyframe at playhead"
              }
            />
            {menuOpen && (
              <div
                ref={menuRef}
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  background: "#111113",
                  border: "1px solid #1f1f23",
                  borderRadius: 4,
                  padding: 4,
                  zIndex: 1000,
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 160,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                }}
              >
                <button
                  onClick={handleDisableEnable}
                  style={menuItemStyle()}
                >
                  {animated ? "Disable animation" : "Enable animation"}
                </button>
                {param.type === "color" && (
                  <>
                    <div
                      style={{
                        color: "#52525b",
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        padding: "6px 8px 2px",
                      }}
                    >
                      color space
                    </div>
                    <button
                      onClick={() => handleColorSpace("oklab")}
                      style={menuItemStyle(
                        (animation?.colorSpace ?? "oklab") === "oklab"
                      )}
                    >
                      OKLab
                    </button>
                    <button
                      onClick={() => handleColorSpace("rgb")}
                      style={menuItemStyle(animation?.colorSpace === "rgb")}
                    >
                      RGB-linear
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function menuItemStyle(active?: boolean): React.CSSProperties {
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

function ParamControl({
  param,
  value,
  allParams,
  onChange,
  rangeOverride,
  onRangeChange,
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
              <DampenedRangeInput
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

// Per-axis control for a font's variation axis. Supports a few
// modulation modes (constant / gradient / sine / random / cycle)
// — the rasterizer reads the mode and renders each character with
// its own resolved axis value.
function FontAxisControl({
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
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        style={{
          background: "#0a0a0a",
          border: "1px solid #27272a",
          color: "#e5e7eb",
          fontFamily: "inherit",
          fontSize: 10,
          padding: "1px 4px",
        }}
      >
        <option value="default">default</option>
        <option value="constant">constant</option>
        <option value="gradient">gradient</option>
        <option value="sine">sine</option>
        <option value="random">random</option>
        <option value="cycle">cycle</option>
        <option value="perGlyph">per glyph</option>
        <option value="maskDriven">mask (per glyph)</option>
      </select>
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

function btnStyleSmall(): React.CSSProperties {
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

function FontAxisSlider({
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

function ChainIcon({ linked }: { linked: boolean }) {
  // Two-link chain. When `linked`, the gap between halves closes; when
  // unlinked, a small break separates them. 11px so it sits beside the
  // 11px label text without overpowering it.
  if (linked) {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path
          d="M5 3.5h-1a2 2 0 0 0 0 4h1M7 8.5h1a2 2 0 0 0 0-4h-1"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <path
          d="M4.25 6h3.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path
        d="M5 3h-1.5a2.2 2.2 0 0 0 0 4.4h.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M7 9h1.5a2.2 2.2 0 0 0 0-4.4h-.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
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

// Scalar slider row with right-click → "Edit range" popover. Slider /
// number-input behavior is unchanged from the inline version it
// replaced; the only addition is the contextmenu handler that opens
// SliderRangeEditor and the highlight when an override is active.
function ScalarSliderRow({
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
  return (
    <div
      style={{ display: "flex", gap: 6, alignItems: "center", position: "relative" }}
      onContextMenu={(e) => {
        if (!onRangeChange) return;
        e.preventDefault();
        e.stopPropagation();
        setEditorOpen(true);
      }}
    >
      <DampenedRangeInput
        min={sliderMin}
        max={sliderMax}
        step={param.step ?? 0.01}
        value={sliderValue}
        onChange={(v) => onChange(v)}
        style={{
          flex: 1,
          // Subtle hint that this slider has a custom range — accent-color
          // bumps the thumb tint on browsers that support it.
          accentColor: hasOverride ? "#60a5fa" : undefined,
        }}
        title={
          hasOverride
            ? `Custom range — right-click to edit (defaults: ${param.min ?? "—"} to ${param.max ?? "—"}). Hold Shift to fine-tune.`
            : "Right-click to set a custom range. Hold Shift to fine-tune."
        }
      />
      <input
        type="number"
        min={effMin}
        max={effMax}
        step={param.step ?? 0.01}
        value={num}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        style={{
          width: 60,
          background: "#0a0a0a",
          border: `1px solid ${hasOverride ? "#1e3a8a" : "#27272a"}`,
          color: "#e5e7eb",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "2px 4px",
        }}
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
function SliderRangeEditor({
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

function RangeField({
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
