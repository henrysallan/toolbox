"use client";

import type { Edge, Node } from "@xyflow/react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ownerWindow } from "@/components/effects/layout/panel-window";
import { getNodeDef } from "@/engine/registry";
import { resolveWedgeBatchInfo } from "@/lib/wedge-batch";
import { paramSocketType } from "@/state/graph";
import { useClock } from "@/state/playback-clock";
import type { NodeDataPayload } from "@/state/graph";
import type { ParamDef, RenderQueueItem } from "@/engine/types";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  LAYER_TYPE,
  isFixedBoundary,
  readBoundarySockets,
  readReservedSockets,
  resolveOutputBoundarySockets,
  type GroupSocketSpec,
} from "@/engine/groups";
import { evalNumExpr } from "@/lib/num-expr";
import { EXPORT_PARAMS } from "@/nodes/output/output";
import { SVG_STYLE_PARAMS } from "@/nodes/output/svg-export";
import { colorForSocket } from "./socketColor";
import LoadGrid from "./LoadGrid";
import ImageGeneratePanel from "./ImageGeneratePanel";
import BgRemovePanel from "./BgRemovePanel";
import SegmentPanel from "./SegmentPanel";
import DepthAnythingPanel from "./DepthAnythingPanel";
import DatamoshPanel from "./DatamoshPanel";
import ColorCorrectionPanel from "./ColorCorrectionPanel";
import RgbCurvesPanel from "./RgbCurvesPanel";
import AutoLayoutPanel from "./AutoLayoutPanel";
import { PaintBrushSection } from "./paint-editor/BrushEditor";
import { StaggerItem } from "./StaggerReveal";
import {
  diamondStateFor,
  evaluateKeyframesAt,
  findKeyframeAt,
  isKeyframable,
  removeKeyframeAt,
  upsertKeyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import KeyframeDiamond from "./KeyframeDiamond";
import TrackVisibilityEye from "./TrackVisibilityEye";
import { Dropdown, ParamControl, menuItemStyle, type LayerAnimApi, type RampIoApi } from "@/lib/param-controls";
import { animatedValueAt, parseRampParamKey } from "@/engine/conventions";

// SVG styling param names, shared by the SVG Export node and the Output
// node's spline tap. The Output panel hides these until a spline is wired.
const SVG_STYLE_PARAM_NAMES = new Set(SVG_STYLE_PARAMS.map((p) => p.name));

// Expose / Control toggle glyphs. Referenced from public/ via CSS mask so the
// silhouette recolors to the button's `currentColor` (active/inactive states)
// AND edits to the source SVGs show up live — no inlined path data to keep in
// sync. ExposeSymbol is ~2.52:1, ControlSymbol is square.
function MaskGlyph({
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

function ExposeIcon({ size = 9 }: { size?: number }) {
  return <MaskGlyph src="/ExposeSymbol.svg" width={size * (1060 / 420)} height={size} />;
}

function ControlIcon({ size = 11 }: { size?: number }) {
  return <MaskGlyph src="/ControlSymbol.svg" width={size} height={size} />;
}

// On/off switch pill — a rounded track with a knob that slides right and turns
// accent-blue when on. Used as a ParamDef group header's enable toggle (in
// place of a checkbox). Purely visual; the parent owns the click.
function SwitchPill({ on }: { on: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        position: "relative",
        width: 26,
        height: 15,
        borderRadius: 999,
        boxSizing: "border-box",
        background: on ? "var(--tb-a-blue-500)" : "var(--tb-n-7)",
        border: `1px solid ${on ? "var(--tb-a-blue-500)" : "var(--tb-n-9)"}`,
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
        }}
      />
    </span>
  );
}

// Collapsible group header bar — a rounded rectangle holding the enable pill,
// the animator label, and (when there are options) a collapse chevron, all
// INSIDE the rectangle. Clicking the bar toggles collapse; the pill toggles
// the underlying boolean (and stops propagation so it doesn't also collapse).
function GroupHeader({
  label,
  enabled,
  onToggleEnabled,
  hasChildren,
  collapsed,
  onToggleCollapsed,
}: {
  label: string;
  enabled: boolean;
  onToggleEnabled: () => void;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div
      onClick={hasChildren ? onToggleCollapsed : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        background: "var(--tb-n-2)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        cursor: hasChildren ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleEnabled();
        }}
        aria-label={`Toggle ${label}`}
        aria-pressed={enabled}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          display: "inline-flex",
          flexShrink: 0,
        }}
      >
        <SwitchPill on={enabled} />
      </button>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          color: enabled ? "var(--tb-n-16)" : "var(--tb-n-13)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
      {hasChildren && (
        <svg
          width="9"
          height="9"
          viewBox="0 0 8 8"
          style={{
            flexShrink: 0,
            color: "var(--tb-n-13)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform 0.12s ease",
          }}
        >
          <path
            d="M1 2.5 L4 5.5 L7 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

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
  // Project frame rate — lives in Project Settings (moved here from the
  // timeline).
  fps: number;
  onFpsChange: (fps: number) => void;
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
  // Convert an SVG Source node's paths into a new editable Spline Draw node
  // (bakes the SVG's transform + style). Surfaced as a button at the end of
  // the SVG Source params.
  onConvertToEditable?: (nodeId: string) => void;
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
  // Move the playhead to an absolute tick. Wired to the keyframe-diamond
  // carets that jump to the prev/next keyframe on the parameter.
  onSeekTick?: (tick: number) => void;
  // Rename a node's display label. Surfaced for group shells (the name
  // feeds breadcrumbs and, later, the Layers editor).
  onRenameNode?: (nodeId: string, name: string) => void;
  // Group boundary socket editing — shown when a Group Input / Group
  // Output node is selected. Edge rewiring happens in graph-ops.
  onRenameGroupSocket?: (
    nodeId: string,
    oldName: string,
    newName: string
  ) => void;
  onRemoveGroupSocket?: (nodeId: string, name: string) => void;
  signedIn?: boolean;
  // Current user id (or null when signed out). Lets the load grid
  // flag public projects authored by the viewer as "you".
  currentUserId?: string | null;
  // Clicking a project thumbnail triggers load in the parent.
  onLoadProject?: (id: string) => void;
  // Opening a recent local .toolbox by path (desktop Local tab).
  onLoadLocal?: (path: string) => void;
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
  // Deterministic offline frame-stepper — renders each requested frame
  // and hands back the named node's pixels. The Segment Anything panel
  // drives its per-frame bake through this.
  captureNodeFrames?: (
    sourceNodeId: string,
    frames: number[],
    onFrame: (frame: number, blob: Blob) => Promise<boolean | void>
  ) => Promise<void>;
  // Scene length in frames — convenience default for bake-range fields.
  sceneFrames?: number;
  // Live batch-render state for the Render Queue panel. Null when idle.
  // `nodeId` is the queue node running the batch (progress is ignored for
  // any other node); `activeItemId` is the row currently rendering (null
  // during the trailing zip step — every row reads as done);
  // `itemProgress` is the active row's 0..1 export progress, or null when
  // no fraction is known (indeterminate).
  queueRender?: {
    nodeId: string;
    activeItemId: string | null;
    itemProgress: number | null;
  } | null;
  // Select a node on the canvas (used by the Render Queue rows' settings
  // button to jump to the wired Output node's params).
  onSelectNode?: (nodeId: string) => void;
}

// Drop-in <input type="range"> wrapper that dampens the per-event delta
// to 10% while the user holds Shift during a drag. Tracks shift via a
// window listener (the slider's `change` event doesn't carry modifier
// keys), and tracks the slider's "native" position via a ref so each
// onChange is interpreted as an incremental delta from the prior event.
// While dampened, the thumb visually lags behind the cursor — the
// cumulative drag still moves, just at a finer rate.
const RES_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: "512 × 512", w: 512, h: 512 },
  { label: "1024 × 1024", w: 1024, h: 1024 },
  { label: "2048 × 2048", w: 2048, h: 2048 },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "3840 × 2160", w: 3840, h: 2160 },
];

// Panel width (px) below which one-line param rows split into two lines.
// A single-line row spends ~300px on fixed furniture (90px label, eye,
// number field, keyframe diamond + carets, expose/control toggles), so
// under this width the slider track is squeezed to a few dozen pixels and
// dropdown labels ellipsis away to nothing. Two lines gives the control
// the full row width back.
const NARROW_PANEL_PX = 380;

// True when the panel is narrower than NARROW_PANEL_PX. Provided by
// ParamPanelShell so each ParamRow can pick its layout without running its
// own ResizeObserver.
const NarrowPanelContext = createContext(false);

// Scroll container for the whole panel — owns the single width measurement
// that drives the one-line / two-line row layout below.
function ParamPanelShell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // clientWidth, not the observed border box: the panel's own 10px
    // padding is already excluded from what a row actually gets. No eager
    // first call — observe() delivers an initial observation itself.
    const ro = new ResizeObserver(() =>
      setNarrow(el.clientWidth < NARROW_PANEL_PX)
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <NarrowPanelContext.Provider value={narrow}>
      <div
        ref={ref}
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
          background: "var(--tb-n-0)",
          color: "var(--tb-n-16)",
          fontFamily: "var(--ui-font)",
          fontSize: 11,
        }}
      >
        {children}
      </div>
    </NarrowPanelContext.Provider>
  );
}

// Memoized (export at the bottom). The clock-store subscription inside
// still re-renders it per frame while PLAYING (keyframe diamonds track the
// playhead — the leaf-subscription follow-up fixes that); the memo removes
// the paused-interaction storms (canvas pointermove bumps, shell state).
function ParamPanel({
  nodes,
  selectedId,
  mode,
  canvasRes,
  onCanvasResChange,
  fps,
  onFpsChange,
  onParamChange,
  onConvertToEditable,
  onToggleParamExposed,
  onToggleParamControl,
  onExportApp,
  onParamRangeChange,
  onToggleParamLink,
  isParamDriven,
  getAnimation,
  onAnimationChange,
  onSeekTick,
  onRenameNode,
  onRenameGroupSocket,
  onRemoveGroupSocket,
  signedIn,
  currentUserId,
  onLoadProject,
  onLoadLocal,
  loadRefreshKey,
  projectId,
  edges,
  getRefImageBlob,
  captureNodeFrames,
  sceneFrames,
  queueRender,
  onSelectNode,
}: Props) {
  // Clock read from the playback store (clock-store spec, step 3): drives
  // keyframe diamonds + animated readouts. Still a whole-panel re-render
  // per frame while playing — pushing this into the diamond/readout
  // leaves is the follow-up optimization.
  const currentTick = useClock((s) => s.tick);
  const selected = selectedId
    ? nodes.find((n) => n.id === selectedId)
    : undefined;
  const def = selected ? getNodeDef(selected.data.defType) : undefined;

  // Is anything wired into the Output node's optional `spline` tap? Wired ⇒
  // the panel reveals the SVG styling rows and the "Export SVG →" action;
  // both are dead weight without a spline to write, and the export panel is
  // long enough already. Same gate as the on-node SVG button in
  // EffectNode.tsx.
  const outputSplineWired =
    !!selected &&
    def?.type === "output" &&
    (edges ?? []).some(
      (e) => e.target === selected.id && e.targetHandle === "in:spline"
    );

  // Collapsed state for ParamDef groups (e.g. the Text node's per-character
  // animators), keyed `${nodeId}:${groupId}`. Default expanded; the header
  // caret toggles it. Purely UI — never touches stored params.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ParamPanelShell>
      {mode === "project" ? (
        <ProjectSettings
          canvasRes={canvasRes}
          onCanvasResChange={onCanvasResChange}
          fps={fps}
          onFpsChange={onFpsChange}
        />
      ) : mode === "load" ? (
        <LoadGrid
          signedIn={!!signedIn}
          currentUserId={currentUserId ?? null}
          onLoad={(id) => onLoadProject?.(id)}
          onLoadLocal={onLoadLocal}
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
      ) : selected && selected.data.defType === "segment-anything" ? (
        // Segment Anything: dots status + bake range + Bake / Free Bake.
        // Dots themselves are placed on the canvas (SegmentDotsOverlay).
        <SegmentPanel
          key={selected.id}
          node={selected}
          edges={edges ?? []}
          getRefImageBlob={getRefImageBlob}
          captureNodeFrames={captureNodeFrames}
          fps={fps}
          sceneFrames={sceneFrames}
          onParamChange={onParamChange}
        />
      ) : selected && selected.data.defType === "depth-anything" ? (
        // Depth Anything: model picker + output toggle + Preview / bake
        // range + Bake / Free Bake. Same offline frame-stepper as Segment.
        <DepthAnythingPanel
          key={selected.id}
          node={selected}
          edges={edges ?? []}
          getRefImageBlob={getRefImageBlob}
          captureNodeFrames={captureNodeFrames}
          sceneFrames={sceneFrames}
          onParamChange={onParamChange}
        />
      ) : selected && selected.data.defType === "datamosh" ? (
        // Datamosh: bake two input clips into the node, drag them to overlap on
        // a mini-timeline, tune the flow params, then Mosh-bake the result.
        // Same offline frame-stepper as Depth/Segment, driven on both the input
        // upstreams (clip bakes) and the node itself (the mosh build).
        <DatamoshPanel
          key={selected.id}
          node={selected}
          edges={edges ?? []}
          captureNodeFrames={captureNodeFrames}
          sceneFrames={sceneFrames}
          onParamChange={onParamChange}
        />
      ) : selected && selected.data.defType === "color-correction" ? (
        // DaVinci-style primaries panel (4 color wheels + bottom bar).
        <Section label="color correction · primaries">
          <ColorCorrectionPanel node={selected} onParamChange={onParamChange} />
        </Section>
      ) : selected && selected.data.defType === "rgb-curves" ? (
        // Full-panel resize-aware tone-curve editor. `key` resets the
        // editor's local UI state (active channel, selection) per node.
        <RgbCurvesPanel
          key={selected.id}
          node={selected}
          onParamChange={onParamChange}
        />
      ) : selected && selected.data.defType === "autolayout" ? (
        // Figma-style auto-layout panel: direction icons, 3×3 alignment
        // grid, inline W/H sizing, gap/padding, fill, the per-item list,
        // and a collapsible canvas-placement block. Keyframable scalars
        // keep their diamonds.
        <AutoLayoutPanel
          key={selected.id}
          node={selected}
          onParamChange={onParamChange}
          currentTick={currentTick}
          getAnimation={getAnimation}
          onAnimationChange={onAnimationChange}
          onSeekTick={onSeekTick}
        />
      ) : selected && selected.data.defType === "render-queue" ? (
        // Batch-render organizer: a reorderable list of the wired Output
        // nodes with inline filename / frame editing and a delivery picker.
        <RenderQueuePanel
          key={selected.id}
          node={selected}
          nodes={nodes}
          edges={edges ?? []}
          onParamChange={onParamChange}
          queueRender={queueRender ?? null}
          onSelectNode={onSelectNode}
        />
      ) : selected &&
        (selected.data.defType === GROUP_INPUT_TYPE ||
          selected.data.defType === GROUP_OUTPUT_TYPE) ? (
        // Boundary-node socket editor: rename / remove the group's
        // interface sockets. New sockets are added by wiring into the
        // dashed virtual port on the node itself.
        // Fixed boundaries (layer interiors) render read-only — their
        // interface is part of the layer contract. A Layer Output (a fixed
        // group-output) additionally gets its own export settings below.
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <GroupSocketsPanel
            key={selected.id}
            node={selected}
            isInput={selected.data.defType === GROUP_INPUT_TYPE}
            onRename={
              onRenameGroupSocket && !isFixedBoundary(selected.data.params)
                ? (o, n) => onRenameGroupSocket(selected.id, o, n)
                : undefined
            }
            onRemove={
              onRemoveGroupSocket && !isFixedBoundary(selected.data.params)
                ? (n) => onRemoveGroupSocket(selected.id, n)
                : undefined
            }
          />
          {selected.data.defType === GROUP_OUTPUT_TYPE &&
            isFixedBoundary(selected.data.params) && (
              <LayerOutputExportSettings
                node={selected}
                edges={edges ?? []}
                onParamChange={onParamChange}
              />
            )}
        </div>
      ) : selected && def ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {(def.type === GROUP_TYPE || def.type === LAYER_TYPE) &&
            onRenameNode && (
              <Section label={def.type === LAYER_TYPE ? "layer" : "group"}>
                <NodeNameField
                  key={selected.id}
                  name={selected.data.name}
                  onCommit={(v) => onRenameNode(selected.id, v)}
                  title={def.type === LAYER_TYPE ? "Layer name" : "Group name"}
                />
              </Section>
            )}
          {(def.type === GROUP_TYPE || def.type === LAYER_TYPE) &&
            (() => {
              // The group/layer's interface, viewed from the shell — a
              // clean parameters list. Editing the interface (rename /
              // remove / add) happens on the interior Group/Layer Input /
              // Output nodes; here a socket renders as its param's
              // real widget (slider / dropdown / color …) when it feeds
              // an interior node's exposed param, or as a minimal
              // dot + name row otherwise. Widget edits write through to
              // the interior node — a remote control, not a second copy
              // of the value. When the shell socket is wired from
              // outside, the wire wins and the widget reads as driven —
              // same rule as exposed params. For layers, the reserved
              // fixed-interface sockets (stack / content / backdrop /
              // audio) are filtered out so only user-minted inputs show,
              // and the output-socket editor is hidden (the layer's
              // output interface is a fixed contract, not user-editable).
              const groupInput = nodes.find(
                (n) =>
                  n.data.parentId === selected.id &&
                  n.data.defType === GROUP_INPUT_TYPE
              );
              const groupOutput = nodes.find(
                (n) =>
                  n.data.parentId === selected.id &&
                  n.data.defType === GROUP_OUTPUT_TYPE
              );
              const allEdges = edges ?? [];
              // Reserved fixed-interface sockets are empty for a plain
              // group and backdrop/etc. for a layer — filtering them keeps
              // the layer contract out of the editable-param list while
              // leaving group behavior unchanged. Same filter as
              // resolvePromotedParams.
              const reserved = new Set(
                groupInput ? readReservedSockets(groupInput.data.params) : []
              );
              const inputSockets = groupInput
                ? readBoundarySockets(groupInput.data.params).filter(
                    (s) => !reserved.has(s.name)
                  )
                : [];
              return (
                <>
                  {groupInput && (
                    <Section
                      label={def.type === LAYER_TYPE ? "layer inputs" : "group inputs"}
                    >
                      {inputSockets.length === 0 ? (
                        <div style={{ color: "var(--tb-n-10)" }}>(no sockets yet)</div>
                      ) : (
                        inputSockets.map((s) => {
                          // Interior exposed-param consumers of this
                          // socket. The first one supplies the widget
                          // (ParamDef + current value); edits write to
                          // all of them.
                          const consumers = allEdges.filter(
                            (e) =>
                              e.source === groupInput.id &&
                              e.sourceHandle === `out:aux:${s.name}` &&
                              e.targetHandle?.startsWith("in:param:")
                          );
                          const first = consumers[0];
                          const consumerNode = first
                            ? nodes.find((n) => n.id === first.target)
                            : undefined;
                          const consumerParam = first
                            ? first.targetHandle!.slice("in:param:".length)
                            : null;
                          const pdef =
                            consumerNode && consumerParam
                              ? getNodeDef(
                                  consumerNode.data.defType
                                )?.params.find((p) => p.name === consumerParam)
                              : undefined;
                          const wired = allEdges.some(
                            (e) =>
                              e.target === selected.id &&
                              e.targetHandle === `in:${s.name}`
                          );
                          // Widget-backed sockets show only the widget
                          // (its label is the socket name); the rest
                          // show a minimal dot + name row.
                          if (pdef && consumerNode && consumerParam) {
                            return (
                              <ParamRow
                                key={s.name}
                                param={{ ...pdef, label: s.name }}
                                value={consumerNode.data.params[consumerParam]}
                                allParams={consumerNode.data.params}
                                onChange={(v) => {
                                  for (const c of consumers) {
                                    onParamChange(
                                      c.target,
                                      c.targetHandle!.slice(
                                        "in:param:".length
                                      ),
                                      v
                                    );
                                  }
                                }}
                                driven={wired}
                                keyframable={isKeyframable(pdef.type)}
                                animation={getAnimation?.(
                                  consumerNode.id,
                                  consumerParam
                                )}
                                currentTick={currentTick}
                                onSeekTick={onSeekTick}
                                onAnimationChange={
                                  onAnimationChange
                                    ? (next) =>
                                        onAnimationChange(
                                          consumerNode.id,
                                          consumerParam,
                                          next
                                        )
                                    : undefined
                                }
                              />
                            );
                          }
                          return <GroupSocketRow key={s.name} spec={s} />;
                        })
                      )}
                      <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
                        Wire into the dashed “new socket” port on{" "}
                        {def.type === LAYER_TYPE ? "Layer Input" : "Group Input"}{" "}
                        to add one.
                      </div>
                    </Section>
                  )}
                  {def.type === GROUP_TYPE && groupOutput && (
                    <GroupSocketsPanel
                      key={groupOutput.id}
                      node={groupOutput}
                      isInput={false}
                    />
                  )}
                </>
              );
            })()}
          {def.type === "output" && onExportApp && (
            <button
              onClick={() => onExportApp(selected.id)}
              style={{
                background: "var(--tb-a-blue-900)",
                border: "1px solid var(--tb-a-blue-700)",
                color: "var(--tb-a-blue-200)",
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
          {/* Output's vector product: the same action as the node's on-canvas
              "SVG" button, surfaced next to the styling rows it uses. Only
              once the `spline` tap is wired — see outputSplineWired. */}
          {outputSplineWired && (
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-export", {
                    detail: { id: selected.id, kind: "svg" },
                  })
                )
              }
              style={{
                background: "var(--tb-a-blue-900)",
                border: "1px solid var(--tb-a-blue-700)",
                color: "var(--tb-a-blue-200)",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "center",
                letterSpacing: 0.3,
              }}
              title="Save the spline wired into this Output at the current playhead as a standalone .svg"
            >
              Export SVG →
            </button>
          )}
          {def.type === "scene-render" && (
            <button
              onClick={() => {
                import("./scene-glb-export").then((m) =>
                  m.exportSceneGLB(selected.id)
                );
              }}
              style={{
                background: "var(--tb-a-blue-900)",
                border: "1px solid var(--tb-a-blue-700)",
                color: "var(--tb-a-blue-200)",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "center",
                letterSpacing: 0.3,
              }}
              title="Export the 3D scene contents (meshes, materials, lights) as a GLB file"
            >
              Export GLB →
            </button>
          )}
          {def.type === "svg-export" && (
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("effect-node-export", {
                    detail: { id: selected.id, kind: "svg" },
                  })
                )
              }
              style={{
                background: "var(--tb-a-blue-900)",
                border: "1px solid var(--tb-a-blue-700)",
                color: "var(--tb-a-blue-200)",
                fontFamily: "inherit",
                fontSize: 11,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "center",
                letterSpacing: 0.3,
              }}
              title="Save the wired spline at the current playhead as a standalone .svg"
            >
              Export SVG →
            </button>
          )}
          {/* Wedge batch readout: this Output has Wedge nodes upstream, so
              its Export/Render runs the whole range once per variation. */}
          {selected.data.defType === "output" && (
            <OutputWedgeReadout
              nodes={nodes}
              edges={edges ?? []}
              outputId={selected.id}
            />
          )}
          {/* Group shells have no def params — their name + interface
              sections above are the whole panel. */}
          {def.type !== GROUP_TYPE && (
          <Section
            // The section header IS the node's title, in an editable box:
            // committing renames this instance only (data.name), which the
            // node header / breadcrumbs / Layers editor all read back.
            // Group + layer shells already carry their own name field
            // above, so they keep a plain text header here.
            label={selected.data.name}
            header={
              onRenameNode && def.type !== LAYER_TYPE ? (
                <NodeNameField
                  key={selected.id}
                  name={selected.data.name}
                  onCommit={(v) => onRenameNode(selected.id, v)}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    padding: "5px 9px",
                    // Rounder than a plain field — echoes the node header
                    // chip this title mirrors.
                    borderRadius: 8,
                  }}
                />
              ) : undefined
            }
          >
          {(() => {
            const exposedSet = new Set(selected.data.exposedParams ?? []);
            const controlSet = new Set(selected.data.controlParams ?? []);
            const visible = def.params.filter((p) => {
              if (p.hidden) return false;
              // Always show exposed/controlled params so the user can reach
              // them to un-toggle, even when `visibleIf` would otherwise hide.
              if (exposedSet.has(p.name)) return true;
              if (controlSet.has(p.name)) return true;
              // Same rule for per-stop ramp exposures/controls — their
              // virtual names embed the owning param's name.
              if (p.type === "color_ramp") {
                for (const s of exposedSet) {
                  if (parseRampParamKey(s)?.paramName === p.name) return true;
                }
                for (const s of controlSet) {
                  if (parseRampParamKey(s)?.paramName === p.name) return true;
                }
              }
              // Output-only: the SVG styling rows stay out of sight until
              // the `spline` tap is wired. Deliberately AFTER the
              // exposed/controlled escape hatches above, so unwiring the
              // spline can't strand an exposure the user has to un-toggle.
              if (
                def.type === "output" &&
                !outputSplineWired &&
                SVG_STYLE_PARAM_NAMES.has(p.name)
              ) {
                return false;
              }
              return p.visibleIf?.(selected.data.params) ?? true;
            });
            if (visible.length === 0) {
              return <div style={{ color: "var(--tb-n-10)" }}>(no parameters)</div>;
            }
            // One param's row element — shared by standalone rows, group
            // headers, and grouped children.
            const renderRow = (p: ParamDef) => {
              const exposable = paramSocketType(p.type) !== null;
              const isExposed = exposedSet.has(p.name);
              const isControlled = controlSet.has(p.name);
              const driven = isExposed && isParamDriven(selected.id, p.name);
              // Param types the live viewer / exported app can't render as a
              // control. The shared ParamControl renders every type except
              // paint and spline_anchors (both edited on-canvas), so only
              // those two dim the toggle. Mirrors UNSUPPORTED_CONTROL_TYPES
              // in export-manifest.ts.
              const controlSupported =
                p.type !== "paint" &&
                p.type !== "spline_anchors" &&
                p.type !== "brush_settings";
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
                  onSeekTick={onSeekTick}
                  keyframable={isKeyframable(p.type)}
                  onAnimationChange={
                    onAnimationChange
                      ? (next) =>
                          onAnimationChange(selected.id, p.name, next)
                      : undefined
                  }
                  layerAnim={
                    (p.type === "merge_layers" ||
                      p.type === "gradient_points" ||
                      p.type === "color_ramp") &&
                    getAnimation &&
                    onAnimationChange
                      ? {
                          currentTick: currentTick ?? 0,
                          get: (key) => getAnimation(selected.id, key),
                          set: (key, next) =>
                            onAnimationChange(selected.id, key, next),
                        }
                      : undefined
                  }
                  rampIo={
                    p.type === "color_ramp"
                      ? {
                          isExposed: (key) => exposedSet.has(key),
                          isDriven: (key) => isParamDriven(selected.id, key),
                          toggleExposed: (key) =>
                            onToggleParamExposed(selected.id, key),
                          isControlled: (key) => controlSet.has(key),
                          toggleControl: (key) =>
                            onToggleParamControl(selected.id, key),
                        }
                      : undefined
                  }
                />
              );
            };

            // Fold params sharing a `group` id into a collapsible unit headed
            // by the `groupHeader` param (the rest indent under it). Ungrouped
            // params render inline, preserving declaration order.
            type Unit =
              | { kind: "row"; p: ParamDef }
              | { kind: "group"; id: string; header: ParamDef | null; children: ParamDef[] };
            const units: Unit[] = [];
            const gIndex = new Map<string, number>();
            for (const p of visible) {
              if (p.group) {
                let idx = gIndex.get(p.group);
                if (idx == null) {
                  units.push({ kind: "group", id: p.group, header: null, children: [] });
                  idx = units.length - 1;
                  gIndex.set(p.group, idx);
                }
                const g = units[idx] as Extract<Unit, { kind: "group" }>;
                if (p.groupHeader) g.header = p;
                else g.children.push(p);
              } else {
                units.push({ kind: "row", p });
              }
            }

            return units.map((u, ui) => {
              if (u.kind === "row") {
                return (
                  <StaggerItem key={`${selected.id}:${u.p.name}`} index={ui}>
                    {renderRow(u.p)}
                  </StaggerItem>
                );
              }
              const gkey = `${selected.id}:${u.id}`;
              const collapsed = collapsedGroups.has(gkey);
              const hasChildren = u.children.length > 0;
              const header = u.header;
              const enabled = header
                ? selected.data.params[header.name] === true
                : false;
              const headerLabel = header ? header.label ?? header.name : u.id;
              return (
                <StaggerItem key={`g:${selected.id}:${u.id}`} index={ui}>
                  <div>
                    {header && (
                      <GroupHeader
                        label={headerLabel}
                        enabled={enabled}
                        onToggleEnabled={() =>
                          onParamChange(selected.id, header.name, !enabled)
                        }
                        hasChildren={hasChildren}
                        collapsed={collapsed}
                        onToggleCollapsed={() => toggleGroup(gkey)}
                      />
                    )}
                    {hasChildren && !collapsed && (
                      <div
                        style={{
                          marginLeft: 6,
                          paddingLeft: 9,
                          borderLeft: "1px solid var(--tb-n-7)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 7,
                          marginTop: 6,
                        }}
                      >
                        {u.children.map((c) => (
                          <div key={`${selected.id}:${c.name}`}>{renderRow(c)}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </StaggerItem>
              );
            });
          })()}
          {/* Spline Draw: keyframe the whole path shape. The spline param is
              hidden (authored on-canvas), so this row is rendered explicitly
              rather than via the visible-params loop above. */}
          {def.type === "spline-draw" && (
            <PathAnimationRow
              animation={getAnimation?.(selected.id, "spline")}
              storedValue={selected.data.params.spline}
              currentTick={currentTick ?? 0}
              onAnimationChange={
                onAnimationChange
                  ? (next) => onAnimationChange(selected.id, "spline", next)
                  : undefined
              }
              onSeekTick={onSeekTick}
            />
          )}
          {/* Paint: brush preset chips + the Brush Editor window. The brush
              blob param is hidden (edited via the editor window / on-canvas
              tools), so this block is the panel surface for it. `key` resets
              the open/preset state per node instance. */}
          {def.type === "paint" && (
            <PaintBrushSection
              key={selected.id}
              node={selected}
              onParamChange={onParamChange}
            />
          )}
          {/* SVG Source: convert the imported paths into an editable Spline
              Draw node (bakes the current transform + copies stroke/fill). */}
          {def.type === "svg-source" && onConvertToEditable && (
            <button
              type="button"
              onClick={() => onConvertToEditable(selected.id)}
              disabled={
                !(
                  (selected.data.params.file as { subpaths?: unknown[] } | null)
                    ?.subpaths?.length
                )
              }
              style={{
                marginTop: 8,
                width: "100%",
                padding: "7px 10px",
                background: "color-mix(in srgb, var(--tb-a-blue-500) 12%, transparent)",
                border: "1px solid var(--tb-a-blue-500)",
                color: "var(--tb-a-blue-200)",
                borderRadius: 5,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
              title="Create an editable Spline Draw node from this SVG"
            >
              Convert Editable
            </button>
          )}
          {/* Keyer sample mode: the drawn color selection. Colors are
              sampled on-canvas (KeyerSampleOverlay); this row shows the
              set as swatches — click one to remove it, Clear resets. */}
          {def.type === "keyer" &&
            selected.data.params.mode === "sample" && (
              <KeyerSamplesRow
                value={selected.data.params.sample_colors}
                onChange={(next) =>
                  onParamChange(selected.id, "sample_colors", next)
                }
              />
            )}
          </Section>
          )}
        </div>
      ) : (
        <div style={{ color: "var(--tb-n-10)" }}>Select a node to edit parameters.</div>
      )}
    </ParamPanelShell>
  );
}

// Keyer sample-mode selection row: the sampled color set as removable
// swatches. Sampling itself happens on the canvas (KeyerSampleOverlay) —
// this row is the manager (inspect / prune / clear). Takes the raw param
// value and narrows here: inlining the Array.isArray ternary at the call
// site made the React Compiler skip ParamPanel ("existing memoization
// could not be preserved").
function KeyerSamplesRow({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const colors = Array.isArray(value)
    ? value.filter((c): c is string => typeof c === "string")
    : [];
  return (
    <div
      style={{
        padding: 8,
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-5)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ color: "var(--tb-n-15)" }}>
          sampled colors ({colors.length})
        </span>
        {colors.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            style={{
              background: "none",
              border: "1px solid var(--tb-n-9)",
              color: "var(--tb-n-13)",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
            }}
            title="Remove all sampled colors"
          >
            clear
          </button>
        )}
      </div>
      {colors.length === 0 ? (
        <div style={{ color: "var(--tb-n-10)" }}>
          Drag across the canvas to sample the colors to key out.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {colors.map((c, i) => (
            <button
              key={`${c}:${i}`}
              type="button"
              onClick={() => onChange(colors.filter((_, j) => j !== i))}
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                border: "1px solid color-mix(in srgb, var(--tb-lift) 25%, transparent)",
                background: c,
                cursor: "pointer",
                padding: 0,
              }}
              title={`${c} — click to remove`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectSettings({
  canvasRes,
  onCanvasResChange,
  fps,
  onFpsChange,
}: {
  canvasRes: [number, number];
  onCanvasResChange: (res: [number, number]) => void;
  fps: number;
  onFpsChange: (fps: number) => void;
}) {
  const resKey = `${canvasRes[0]}×${canvasRes[1]}`;
  const isPreset = RES_PRESETS.some((r) => `${r.w}×${r.h}` === resKey);

  return (
    <Section label="project settings">
      <div
        style={{
          padding: 8,
          background: "var(--tb-n-1)",
          border: "1px solid var(--tb-n-5)",
          borderRadius: 4,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <span style={{ color: "var(--tb-n-15)" }}>resolution</span>
        <Dropdown
          value={isPreset ? resKey : "__custom__"}
          options={[
            ...RES_PRESETS.map((r) => ({
              value: `${r.w}×${r.h}`,
              label: r.label,
            })),
            ...(!isPreset
              ? [
                  {
                    value: "__custom__",
                    label: `${canvasRes[0]} × ${canvasRes[1]} (custom)`,
                  },
                ]
              : []),
          ]}
          onChange={(v) => {
            if (v === "__custom__") return;
            const [w, h] = v.split("×").map(Number);
            onCanvasResChange([w, h]);
          }}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ResInput
            value={canvasRes[0]}
            onCommit={(w) => onCanvasResChange([w, canvasRes[1]])}
          />
          <span style={{ color: "var(--tb-n-10)" }}>×</span>
          <ResInput
            value={canvasRes[1]}
            onCommit={(h) => onCanvasResChange([canvasRes[0], h])}
          />
        </div>
        <span style={{ color: "var(--tb-n-15)", marginTop: 4 }}>frame rate</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ResInput
            value={fps}
            onCommit={onFpsChange}
            min={1}
            max={240}
            width={56}
          />
          <span style={{ color: "var(--tb-n-10)" }}>fps</span>
        </div>
      </div>
    </Section>
  );
}

function ResInput({
  value,
  onCommit,
  min = 16,
  max = 8192,
  width = 72,
  title,
  style,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  width?: number;
  title?: string;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const p = evalNumExpr(draft); // plain numbers or math: "1920/2", "24*8"
    const n = p === null ? NaN : Math.round(p);
    if (!Number.isFinite(n) || n < min || n > max) {
      setDraft(String(value));
      return;
    }
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      title={title}
      style={{
        width,
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        color: "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "2px 4px",
        ...style,
      }}
    />
  );
}

// Editable node display name — commit on blur / Enter, Escape reverts.
// Used for group shells and as the params section's title box; the name
// feeds the node header, breadcrumbs, and the Layers editor. Renaming is
// per-instance — it writes `data.name` on this node only.
function NodeNameField({
  name,
  onCommit,
  title = "Node name — renames this node only",
  style,
}: {
  name: string;
  onCommit: (name: string) => void;
  title?: string;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(name);
  // An external rename (undo, Layers editor, frame-label chip) has to win
  // over a stale draft from a previous mount of the same node.
  const [lastName, setLastName] = useState(name);
  if (name !== lastName) {
    setLastName(name);
    setDraft(name);
  }
  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const v = draft.trim();
        if (v && v !== name) onCommit(v);
        else setDraft(name);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
      title={title}
      style={{
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        color: "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "4px 6px",
        borderRadius: 4,
        boxSizing: "border-box",
        width: "100%",
        ...style,
      }}
    />
  );
}

// One row of the boundary-socket editor: colored type dot, editable
// name (commit on blur / Enter), and a remove button that also drops
// the edges wired into the socket on both faces of the boundary.
function GroupSocketRow({
  spec,
  onRename,
  onRemove,
}: {
  spec: GroupSocketSpec;
  onRename?: (oldName: string, newName: string) => void;
  onRemove?: (name: string) => void;
}) {
  const [draft, setDraft] = useState(spec.name);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        title={spec.type}
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: colorForSocket(spec.type),
          flexShrink: 0,
        }}
      />
      {onRename ? (
        <input
          type="text"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft.trim();
            if (v && v !== spec.name) onRename(spec.name, v);
            else setDraft(spec.name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(spec.name);
              (e.target as HTMLInputElement).blur();
            }
          }}
          title="Socket name"
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
            color: "var(--tb-n-16)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "3px 6px",
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
      ) : (
        // No rename here (the group shell's view) — names are edited on
        // the Group Input / Group Output nodes inside the group.
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--tb-n-13)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {spec.name}
        </span>
      )}
      {/* Type label only in the boundary-node editor view; the shell's
          read-only list keeps just dot + name (the dot still carries
          the type via color + tooltip). */}
      {onRename && (
        <span style={{ color: "var(--tb-n-10)", fontSize: 9, flexShrink: 0 }}>
          {spec.type}
        </span>
      )}
      {onRemove && (
        <button
          onClick={() => onRemove(spec.name)}
          title="Remove socket (disconnects its wires)"
          style={{
            background: "transparent",
            border: "1px solid var(--tb-n-9)",
            color: "var(--tb-n-12)",
            borderRadius: 4,
            width: 18,
            height: 18,
            lineHeight: "16px",
            fontSize: 11,
            padding: 0,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

// Param-panel body for a selected Group Input / Group Output node.
// Lists the group's interface sockets on that side for rename / remove;
// adding happens on the canvas by wiring into the node's dashed
// virtual port.
function GroupSocketsPanel({
  node,
  isInput,
  onRename,
  onRemove,
}: {
  node: Node<NodeDataPayload>;
  isInput: boolean;
  onRename?: (oldName: string, newName: string) => void;
  onRemove?: (name: string) => void;
}) {
  // Outputs go through the resolver so a fixed (layer) boundary's
  // back-filled sockets are listed too — this panel must agree with the
  // handles the node actually renders.
  const sockets = isInput
    ? readBoundarySockets(node.data.params)
    : resolveOutputBoundarySockets(node.data.params);
  // Reserved sockets (a layer's `backdrop`) are part of the fixed
  // interface — shown read-only, no rename/remove.
  const reserved = new Set(readReservedSockets(node.data.params));
  return (
    <Section label={isInput ? "group inputs" : "group outputs"}>
      {sockets.length === 0 ? (
        <div style={{ color: "var(--tb-n-10)" }}>(no sockets yet)</div>
      ) : (
        sockets.map((s) => (
          <GroupSocketRow
            // Keyed by name: a rename commits upstream and the row
            // remounts with the (possibly deduped) final name.
            key={s.name}
            spec={s}
            onRename={reserved.has(s.name) ? undefined : onRename}
            onRemove={reserved.has(s.name) ? undefined : onRemove}
          />
        ))
      )}
      <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
        Wire into the dashed “new socket” port on the node to add one.
      </div>
    </Section>
  );
}

// Export settings for a Layer Output (the fixed `group-output` inside a
// layer). It carries its own independent copy of the composition Output's
// export config on the node instance, so a layer can be rendered in a
// different form than the comp. We render the canonical EXPORT_PARAMS list
// as plain rows — export config isn't scene animation, so no keyframe /
// expose affordances. (EXPORT_PARAMS rather than the whole Output def:
// the SVG styling rows are appended there, and here they're gated on the
// layer's own spline tap instead — see below.) Values + visibleIf
// evaluate against defaults-merged params so a layer saved before this
// feature (missing keys) still renders a complete, correct panel; the
// first edit materializes the real key. See
// specdocs/071526_layer-output-export-settings.md.
function LayerOutputExportSettings({
  node,
  edges,
  onParamChange,
}: {
  node: Node<NodeDataPayload>;
  edges: Edge[];
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
}) {
  // The layer's vector tap — the third fixed boundary socket. Wired ⇒ this
  // panel grows the SVG styling rows and an "Export SVG →" action, exactly
  // like the composition Output's. Same gate as the on-node SVG button.
  const splineWired = edges.some(
    (e) => e.target === node.id && e.targetHandle === "in:spline"
  );
  const params = splineWired
    ? [...EXPORT_PARAMS, ...SVG_STYLE_PARAMS]
    : EXPORT_PARAMS;
  // Defaults always cover the SVG rows: a layer created before the tap
  // existed has none of those keys stored, and an unset row must still
  // render its default rather than `undefined`.
  const defaults: Record<string, unknown> = {};
  for (const p of EXPORT_PARAMS) defaults[p.name] = p.default;
  for (const p of SVG_STYLE_PARAMS) defaults[p.name] = p.default;
  const merged = { ...defaults, ...node.data.params };
  const visible = params.filter(
    (p) => !p.hidden && (p.visibleIf?.(merged) ?? true)
  );
  return (
    <Section label="export · settings">
      {visible.map((p) => (
        <ParamRow
          key={p.name}
          param={p}
          value={merged[p.name]}
          allParams={merged}
          onChange={(v) => onParamChange(node.id, p.name, v)}
        />
      ))}
      {splineWired && (
        <button
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("effect-node-export", {
                detail: { id: node.id, kind: "svg" },
              })
            )
          }
          style={{
            background: "var(--tb-a-blue-900)",
            border: "1px solid var(--tb-a-blue-700)",
            color: "var(--tb-a-blue-200)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "6px 10px",
            borderRadius: 4,
            cursor: "pointer",
            textAlign: "center",
            letterSpacing: 0.3,
          }}
          title="Save the spline wired into this Layer Output at the current playhead as a standalone .svg"
        >
          Export SVG →
        </button>
      )}
    </Section>
  );
}

function Section({
  label,
  header,
  children,
}: {
  label?: string;
  // Replaces the uppercase text header entirely — used by the params
  // section, whose header is an editable node-name field.
  header?: React.ReactNode;
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
      {header ?? (
        <div
          style={{
            color: "var(--tb-n-11)",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontSize: 10,
          }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

// "Export renders N variations" pill for Output nodes with Wedge nodes
// upstream. Its own memo()'d component (not a useMemo in the panel body) so
// the flatten+BFS walk only re-runs when the graph arrays actually change —
// per-tick panel re-renders during playback skip it entirely. Renders
// nothing when there's no batch (resolveWedgeBatchInfo fast-paths to 1 for
// wedge-free graphs).
const OutputWedgeReadout = memo(function OutputWedgeReadout({
  nodes,
  edges,
  outputId,
}: {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  outputId: string;
}) {
  const count = resolveWedgeBatchInfo(nodes, edges, outputId).count;
  if (count <= 1) return null;
  return (
    <div
      style={{
        color: "var(--tb-t-navy-l-1)",
        background: "var(--tb-t-violet-d-2)",
        border: "1px solid var(--tb-t-violet-d-3)",
        borderRadius: 4,
        padding: "5px 8px",
        fontSize: 10,
        letterSpacing: 0.3,
      }}
      title="Wedge nodes upstream — Export renders every variation with iterated filenames ({i} / {wedge:Name} tokens in Filename; auto _{i:3} suffix otherwise)"
    >
      Export renders {count} wedge variations
    </div>
  );
});

// Shared rounded "Load X" button — blue stroke, dark-blue fill, hover lift.
function RenderQueuePanel({
  node,
  nodes,
  edges,
  onParamChange,
  queueRender,
  onSelectNode,
}: {
  node: Node<NodeDataPayload>;
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  queueRender: {
    nodeId: string;
    activeItemId: string | null;
    itemProgress: number | null;
  } | null;
  onSelectNode?: (nodeId: string) => void;
}) {
  const items = (node.data.params.items as RenderQueueItem[]) ?? [];
  const delivery = (node.data.params.delivery as string) ?? "sequential";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const outputFor = (item: RenderQueueItem): Node<NodeDataPayload> | null => {
    const edge = edges.find(
      (e) => e.target === node.id && e.targetHandle === `in:item:${item.id}`
    );
    return edge ? nodes.find((n) => n.id === edge.source) ?? null : null;
  };

  // ×N wedge-variation badge per row: an Output with Wedge nodes upstream
  // renders once per variation, so its row delivers N files. Cheap when the
  // graph has no wedges (resolveWedgeBatchInfo fast-paths to 1).
  const wedgeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of (node.data.params.items as RenderQueueItem[]) ?? []) {
      const edge = edges.find(
        (e) => e.target === node.id && e.targetHandle === `in:item:${item.id}`
      );
      const outId = edge?.source;
      if (outId && !m.has(outId)) {
        m.set(outId, resolveWedgeBatchInfo(nodes, edges, outId).count);
      }
    }
    return m;
  }, [node.data.params.items, node.id, nodes, edges]);

  const setItems = (next: RenderQueueItem[]) =>
    onParamChange(node.id, "items", next);
  const patchItem = (id: string, patch: Partial<RenderQueueItem>) =>
    setItems(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = items.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setItems(next);
  };

  const run = () =>
    window.dispatchEvent(
      new CustomEvent("effect-node-export", {
        detail: { id: node.id, kind: "queue" },
      })
    );
  const addSlot = () =>
    window.dispatchEvent(
      new CustomEvent("effect-node-toggle", {
        detail: { id: node.id, kind: "queueAddItem" },
      })
    );

  const deliveryLabels: Record<string, string> = {
    sequential: "Sequential downloads",
    zip: "Single .zip",
    folder: "Save to folder…",
  };
  // Batch progress scoped to THIS queue node — another Render Queue
  // node's run must not light up our rows.
  const qr = queueRender && queueRender.nodeId === node.id ? queueRender : null;

  // Where each row sits in the running batch: rows before the active one
  // are done (full bar), the active row shows its own export progress (or
  // an indeterminate dim fill), rows after are pending. `activeItemId ===
  // null` while rendering means the trailing zip step — everything's done.
  const activeIdx = qr?.activeItemId
    ? items.findIndex((it) => it.id === qr.activeItemId)
    : -1;
  const rowFill = (i: number): number | "indeterminate" => {
    if (!qr) return 0;
    if (qr.activeItemId === null) return 1;
    if (activeIdx === -1) return 0;
    if (i < activeIdx) return 1;
    if (i > activeIdx) return 0;
    return qr.itemProgress ?? "indeterminate";
  };

  const textInput: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: "var(--tb-n-0)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    padding: "3px 6px",
  };
  const numInput: React.CSSProperties = {
    width: 56,
    flexShrink: 0,
    background: "var(--tb-n-0)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    padding: "3px 6px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          position: "relative",
        }}
      >
        <button
          onClick={run}
          style={{
            flex: 1,
            background: "var(--tb-a-blue-900)",
            border: "1px solid var(--tb-a-blue-700)",
            color: "var(--tb-a-blue-200)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "6px 10px",
            borderRadius: 999,
            cursor: "pointer",
            letterSpacing: 0.3,
          }}
          title="Render every queued Output in order"
        >
          Render Queue ▶
        </button>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          title={`Delivery: ${deliveryLabels[delivery] ?? delivery}`}
          style={{
            width: 28,
            height: 28,
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-9)",
            color: "var(--tb-n-13)",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          ⚙
        </button>
        {settingsOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 4,
              background: "var(--tb-n-1)",
              border: "1px solid var(--tb-n-5)",
              borderRadius: 4,
              padding: 4,
              zIndex: 1000,
              display: "flex",
              flexDirection: "column",
              minWidth: 180,
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <div
              style={{
                color: "var(--tb-n-10)",
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: 1,
                padding: "6px 8px 2px",
              }}
            >
              delivery
            </div>
            {(["sequential", "zip", "folder"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  onParamChange(node.id, "delivery", mode);
                  setSettingsOpen(false);
                }}
                style={menuItemStyle(delivery === mode)}
              >
                {deliveryLabels[mode]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.length === 0 && (
          <div style={{ color: "var(--tb-n-10)" }}>(no slots — use + on node)</div>
        )}
        {items.map((item, i) => {
          const out = outputFor(item);
          const p = out?.data.params ?? {};
          const filename = (p.filename as string) ?? "";
          const frames = (p.videoFrames as number) ?? 240;
          const fill = rowFill(i);
          return (
            <div
              key={item.id}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={() => {
                if (dragIndex !== null) move(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: 8,
                border: `1px solid ${
                  overIndex === i && dragIndex !== null && dragIndex !== i
                    ? "var(--tb-n-10)"
                    : "var(--tb-n-7)"
                }`,
                borderRadius: 4,
                background: dragIndex === i ? "var(--tb-n-7)" : "var(--tb-n-5)",
              }}
            >
              {/* Line 1: drag · index · progress bar · jump-to-node · remove */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  title="Drag to reorder"
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  style={{ cursor: "grab", color: "var(--tb-n-10)", fontSize: 13 }}
                >
                  ⠿
                </span>
                <span
                  style={{ color: "var(--tb-n-11)", fontSize: 10, minWidth: 14 }}
                >
                  {i + 1}
                </span>
                {out ? (
                  <div
                    title={
                      qr
                        ? fill === "indeterminate"
                          ? "Rendering…"
                          : `${Math.round(fill * 100)}%`
                        : "Idle"
                    }
                    style={{
                      flex: 1,
                      height: 10,
                      borderRadius: 999,
                      background: "var(--tb-n-0)",
                      border: "1px solid var(--tb-n-7)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width:
                          fill === "indeterminate"
                            ? "100%"
                            : `${fill * 100}%`,
                        height: "100%",
                        background: "var(--tb-a-blue-600)",
                        opacity: fill === "indeterminate" ? 0.45 : 1,
                        transition: "width 200ms",
                      }}
                    />
                  </div>
                ) : (
                  <span
                    style={{
                      flex: 1,
                      color: "var(--tb-n-11)",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    (wire an Output node)
                  </span>
                )}
                {out && (wedgeCounts.get(out.id) ?? 1) > 1 && (
                  <span
                    title={`${wedgeCounts.get(out.id)} wedge variations — this row renders ${wedgeCounts.get(out.id)} files`}
                    style={{
                      color: "var(--tb-t-navy-l-1)",
                      background: "var(--tb-t-violet-d-2)",
                      border: "1px solid var(--tb-t-violet-d-3)",
                      borderRadius: 999,
                      fontSize: 9,
                      padding: "1px 6px",
                      flexShrink: 0,
                    }}
                  >
                    ×{wedgeCounts.get(out.id)}
                  </span>
                )}
                {out && (
                  <button
                    onClick={() => onSelectNode?.(out.id)}
                    title="Open this Output node's settings"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--tb-n-9)",
                      color: "var(--tb-n-13)",
                      fontSize: 11,
                      lineHeight: 1,
                      padding: "1px 5px",
                      borderRadius: 3,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ⚙
                  </button>
                )}
                <button
                  onClick={() =>
                    setItems(items.filter((x) => x.id !== item.id))
                  }
                  title="Remove slot"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--tb-n-9)",
                    color: "var(--tb-n-13)",
                    fontSize: 12,
                    lineHeight: 1,
                    padding: "1px 6px",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  ×
                </button>
              </div>
              {/* Line 2: every setting on one row — filename · type · frame(s) */}
              {out && (
                <div
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    value={filename}
                    placeholder="filename (auto)"
                    title="Output filename"
                    onChange={(e) =>
                      onParamChange(out.id, "filename", e.target.value)
                    }
                    style={textInput}
                  />
                  <Dropdown
                    value={item.kind}
                    options={[
                      { value: "video", label: "Video" },
                      { value: "image", label: "Image" },
                    ]}
                    onChange={(v) =>
                      patchItem(item.id, {
                        kind: v as "image" | "video",
                      })
                    }
                    title="Render as a video or a single image"
                    style={{ width: 76, flexShrink: 0 }}
                  />
                  {item.kind === "video" ? (
                    <ResInput
                      value={frames}
                      min={1}
                      max={1e9}
                      title="Frame count"
                      onCommit={(n) => onParamChange(out.id, "videoFrames", n)}
                      style={numInput}
                    />
                  ) : (
                    <ResInput
                      value={item.frame}
                      min={0}
                      max={1e9}
                      title="Frame to render"
                      onCommit={(n) => patchItem(item.id, { frame: n })}
                      style={numInput}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        <button
          onClick={addSlot}
          style={{
            background: "var(--tb-n-3)",
            border: "1px dashed var(--tb-n-9)",
            color: "var(--tb-n-13)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "5px 10px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          + Add slot
        </button>
      </div>
    </div>
  );
}

// Compact "match the project aspect ratio to this source" action, nested
// inside the image/video load controls. Carries the source's pixel dims on
// a window event; EffectsApp owns the canvasRes change (keeps the current
// longest side, swings only the aspect). Hidden until a clip is loaded.
function KeyframeCaret({
  dir,
  disabled,
  onClick,
  title,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        width: 11,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.25 : 0.7,
        lineHeight: 0,
        color: "var(--tb-n-13)",
      }}
    >
      <svg width="7" height="10" viewBox="0 0 7 10" fill="none">
        <path
          d={dir === "prev" ? "M5 1 L1 5 L5 9" : "M2 1 L6 5 L2 9"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

// Dedicated "Path Animation" row for the Spline Draw node: keyframes the
// whole spline shape (anchors lerp between keyframed states). It's just a
// label + the standard keyframe diamond / carets — the path itself is
// authored on-canvas, so there's no inline control. The diamond captures the
// spline *as shown at the playhead* (the interpolated value when between
// keyframes) so inserting a keyframe never introduces a jump.
function PathAnimationRow({
  animation,
  storedValue,
  currentTick,
  onAnimationChange,
  onSeekTick,
}: {
  animation?: KeyframeAnimationBlock;
  storedValue: unknown;
  currentTick: number;
  onAnimationChange?: (next: KeyframeAnimationBlock | undefined) => void;
  onSeekTick?: (tick: number) => void;
}) {
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
    // Whichever window this panel is in — module `window` is always
    // the main one (080226_panel-popout-windows.md §3).
    const win = ownerWindow(menuRef.current);
    win.addEventListener("mousedown", onDocDown);
    return () => win.removeEventListener("mousedown", onDocDown);
  }, [menuOpen]);

  const animated = !!animation?.animated;
  const diamondState = diamondStateFor(animation, currentTick);
  const captureValue =
    animation && animation.animated && animation.keyframes.length > 0
      ? evaluateKeyframesAt(animation, "spline_anchors", currentTick) ??
        storedValue
      : storedValue;
  const kfTicks = animation?.keyframes?.map((k) => k.tick) ?? [];
  const prevKfTick = kfTicks
    .filter((t) => t < currentTick)
    .reduce<number | null>((m, t) => (m === null || t > m ? t : m), null);
  const nextKfTick = kfTicks
    .filter((t) => t > currentTick)
    .reduce<number | null>((m, t) => (m === null || t < m ? t : m), null);
  const showCarets = !!onSeekTick;

  const handleDiamondClick = () => {
    if (!onAnimationChange) return;
    if (!animation || !animation.animated) {
      onAnimationChange({
        animated: true,
        trackVisible: true,
        keyframes: [
          { tick: currentTick, value: captureValue, easingOut: "easeInOut" },
        ],
      });
      return;
    }
    if (findKeyframeAt(animation, currentTick)) {
      onAnimationChange(removeKeyframeAt(animation, currentTick));
    } else {
      onAnimationChange(
        upsertKeyframe(animation, currentTick, captureValue, "easeInOut")
      );
    }
  };

  const handleDisableEnable = () => {
    if (!onAnimationChange) return;
    if (!animation) {
      onAnimationChange({ animated: true, trackVisible: true, keyframes: [] });
    } else {
      onAnimationChange({ ...animation, animated: !animation.animated });
    }
    setMenuOpen(false);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 0",
      }}
    >
      <span style={{ color: "var(--tb-n-12)", flex: 1, minWidth: 0 }}>
        Path Animation
      </span>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
        {showCarets && (
          <KeyframeCaret
            dir="prev"
            disabled={prevKfTick === null}
            onClick={() => prevKfTick !== null && onSeekTick?.(prevKfTick)}
            title={
              prevKfTick === null
                ? "No earlier keyframe"
                : "Jump to previous keyframe"
            }
          />
        )}
        <div style={{ position: "relative", display: "inline-flex" }}>
          <KeyframeDiamond
            state={diamondState}
            onClick={handleDiamondClick}
            onContextMenu={() => setMenuOpen((v) => !v)}
            title={
              diamondState === "empty"
                ? "Animate the path"
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
                background: "var(--tb-n-1)",
                border: "1px solid var(--tb-n-5)",
                borderRadius: 4,
                padding: 4,
                zIndex: 1000,
                display: "flex",
                flexDirection: "column",
                minWidth: 160,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}
            >
              <button onClick={handleDisableEnable} style={menuItemStyle()}>
                {animated ? "Disable animation" : "Enable animation"}
              </button>
            </div>
          )}
        </div>
        {showCarets && (
          <KeyframeCaret
            dir="next"
            disabled={nextKfTick === null}
            onClick={() => nextKfTick !== null && onSeekTick?.(nextKfTick)}
            title={
              nextKfTick === null
                ? "No later keyframe"
                : "Jump to next keyframe"
            }
          />
        )}
      </div>
    </div>
  );
}

// Image `file` param control. The engine consumes the raw ImageBitmap, so
// the file name is stashed on the bitmap object (ignored by the GL upload)
// rather than changing the value shape.
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
  onSeekTick,
  keyframable = false,
  onAnimationChange,
  layerAnim,
  rampIo,
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
  // Jump the playhead to an absolute tick (prev/next keyframe carets).
  onSeekTick?: (tick: number) => void;
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
  // Composite-param keyframing (merge layers) — see LayerAnimApi.
  layerAnim?: LayerAnimApi;
  // Per-stop expose/control toggles for color ramps — see RampIoApi.
  rampIo?: RampIoApi;
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
    // Whichever window this panel is in — module `window` is always
    // the main one (080226_panel-popout-windows.md §3).
    const win = ownerWindow(menuRef.current);
    win.addEventListener("mousedown", onDocDown);
    return () => win.removeEventListener("mousedown", onDocDown);
  }, [menuOpen]);

  const animated = !!animation?.animated;
  const diamondState = keyframable
    ? diamondStateFor(animation, currentTick)
    : "empty";

  // Animated readout: a keyframed param displays its evaluated value at the
  // playhead, so the control follows scrubbing/playback instead of freezing
  // at the stored constant. Driven params keep the stored value (the wire
  // wins over keyframes and the row is dimmed anyway). Edits round-trip:
  // autokey writes the edit as a keyframe at this same tick, so the evaluated
  // display equals what the user just set.
  const displayValue =
    keyframable && !driven
      ? animatedValueAt(animation, param.type, currentTick, value, param.alpha)
      : value;

  // Nearest keyframe ticks on either side of the playhead, for the carets.
  const kfTicks = animation?.keyframes?.map((k) => k.tick) ?? [];
  const prevKfTick = kfTicks
    .filter((t) => t < currentTick)
    .reduce<number | null>((m, t) => (m === null || t > m ? t : m), null);
  const nextKfTick = kfTicks
    .filter((t) => t > currentTick)
    .reduce<number | null>((m, t) => (m === null || t < m ? t : m), null);
  // Always present alongside the diamond (even before any keyframe exists);
  // each side just disables when there's nothing to jump to in that
  // direction.
  const showCarets = keyframable && !driven && !!onSeekTick;

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
          { tick: currentTick, value: displayValue, easingOut: "easeInOut" },
        ],
      });
      return;
    }
    if (findKeyframeAt(animation, currentTick)) {
      onAnimationChange(removeKeyframeAt(animation, currentTick));
    } else {
      // Capture the evaluated value, not the stored constant — inserting a
      // key mid-segment must pin the curve's current value (same contract
      // as TrackEditor's toggleKeyAtPlayhead).
      onAnimationChange(
        upsertKeyframe(animation, currentTick, displayValue, "easeInOut")
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

  // Single-line param types collapse label + control + keyframe diamond +
  // expose/control onto ONE row (half the height). Multi-line controls
  // (text areas, paint, font/file pickers, ramps, curves) keep the stacked
  // header so they aren't crushed against the label.
  //
  // Below NARROW_PANEL_PX that single row leaves the control only a few
  // dozen pixels, so inline params fall back to the stacked two-line form
  // (label on top, control + diamond underneath) with tighter spacing than
  // the natively-stacked rows.
  const narrowPanel = useContext(NarrowPanelContext);
  const inlineCapable = isInlineParam(param);
  const inline = inlineCapable && !narrowPanel;
  const wrapped = inlineCapable && narrowPanel;
  // File controls suppress their header label (the "Load …" button is
  // self-describing), so they collapse onto a single snug row with the
  // expose/control toggle on the right — no empty header eating height.
  const labelSuppressed =
    param.type === "file" ||
    param.type === "video_file" ||
    param.type === "image_sequence" ||
    param.type === "model_file" ||
    param.type === "lut_file" ||
    param.type === "csv_file";

  // Inline rows cap the label at a fixed column; wrapped rows give it the
  // whole first line. Both ellipsis rather than wrap, so a long name never
  // pushes the row past the two lines it's budgeted.
  const labelTruncates = inline || wrapped;
  const labelEl = (
    <span
      title={labelTruncates ? label : undefined}
      style={{
        color: "var(--tb-n-12)",
        display: labelTruncates ? "flex" : "inline-flex",
        alignItems: "center",
        gap: 6,
        ...(inline
          ? { flex: "0 0 90px", minWidth: 0 }
          : wrapped
          ? { flex: "1 1 auto", minWidth: 0 }
          : {}),
      }}
    >
      <span
        style={
          labelTruncates
            ? {
                flex: "1 1 auto",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }
            : undefined
        }
      >
        {label}
      </span>
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
            color: linkInfo.isLinked ? "var(--tb-a-yellow-400)" : "var(--tb-n-10)",
            display: "inline-flex",
            alignItems: "center",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          <ChainIcon linked={linkInfo.isLinked} />
        </button>
      )}
      {driven && (
        <span
          title="Driven by a connected input — stored value is ignored while connected"
          style={{
            color: "var(--tb-a-blue-300)",
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            flexShrink: 0,
          }}
        >
          driven
        </span>
      )}
    </span>
  );

  const exposeControlEl = (
    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
      {exposable && onToggleExposed && (
        <button
          onClick={onToggleExposed}
          title={
            exposed
              ? "Remove the input socket for this parameter"
              : "Add an input socket for this parameter on the node"
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: exposed ? "var(--tb-a-blue-900)" : "transparent",
            border: "1px solid var(--tb-n-7)",
            color: exposed ? "var(--tb-a-blue-200)" : "var(--tb-n-11)",
            width: 18,
            height: 18,
            padding: 0,
            boxSizing: "border-box",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <ExposeIcon size={5} />
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
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: controlled ? "var(--tb-a-emerald-800)" : "transparent",
            border: "1px solid var(--tb-n-7)",
            color: controlled
              ? "var(--tb-a-emerald-200)"
              : controlSupported
              ? "var(--tb-n-11)"
              : "var(--tb-n-9)",
            width: 18,
            height: 18,
            padding: 0,
            boxSizing: "border-box",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "inherit",
            opacity: controlSupported ? 1 : 0.6,
          }}
        >
          <ControlIcon size={11} />
        </button>
      )}
    </div>
  );

  const eyeEl = keyframable ? (
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
  ) : null;

  const controlEl = (
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
        value={displayValue}
        allParams={allParams}
        onChange={onChange}
        rangeOverride={rangeOverride}
        onRangeChange={onRangeChange}
        layerAnim={layerAnim}
        rampIo={rampIo}
      />
    </div>
  );

  const diamondEl = keyframable ? (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
      {showCarets && (
        <KeyframeCaret
          dir="prev"
          disabled={prevKfTick === null}
          onClick={() => prevKfTick !== null && onSeekTick?.(prevKfTick)}
          title={
            prevKfTick === null
              ? "No earlier keyframe"
              : "Jump to previous keyframe"
          }
        />
      )}
      <div style={{ position: "relative", display: "inline-flex" }}>
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
            background: "var(--tb-n-1)",
            border: "1px solid var(--tb-n-5)",
            borderRadius: 4,
            padding: 4,
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            minWidth: 160,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <button onClick={handleDisableEnable} style={menuItemStyle()}>
            {animated ? "Disable animation" : "Enable animation"}
          </button>
          {param.type === "color" && (
            <>
              <div
                style={{
                  color: "var(--tb-n-10)",
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
      {showCarets && (
        <KeyframeCaret
          dir="next"
          disabled={nextKfTick === null}
          onClick={() => nextKfTick !== null && onSeekTick?.(nextKfTick)}
          title={
            nextKfTick === null ? "No later keyframe" : "Jump to next keyframe"
          }
        />
      )}
    </div>
  ) : null;

  return (
    <div
      style={{
        // Inline rows are a single line — trim the vertical padding so the
        // whole row is shorter. Wrapped rows are the same compact control,
        // just on two lines, so they keep the tight padding too. Natively
        // stacked (multi-line) rows keep the roomier padding their taller
        // controls need.
        padding: inline || labelSuppressed || wrapped ? "5px 10px" : 10,
        boxSizing: "border-box",
        width: "100%",
        background: "var(--tb-n-1)",
        border: `1px solid ${driven ? "var(--tb-a-slate-700)" : "var(--tb-n-3)"}`,
        // Softer than the 4px it used to carry, so the card doesn't read
        // squarer than the bar sliders sitting inside it.
        borderRadius: 7,
      }}
    >
      {inline || labelSuppressed ? (
        // Single snug row. Label-suppressed file controls reuse this so
        // the module hugs the button instead of stacking under an empty
        // header; controlEl's flex:1 pushes the expose toggle to the right.
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            position: "relative",
          }}
        >
          {!labelSuppressed && labelEl}
          {eyeEl}
          {controlEl}
          {diamondEl}
          {exposeControlEl}
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 6,
              marginBottom: wrapped ? 4 : 8,
            }}
          >
            {labelEl}
            {exposeControlEl}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              position: "relative",
            }}
          >
            {eyeEl}
            {controlEl}
            {diamondEl}
          </div>
        </>
      )}
    </div>
  );
}

// Param types whose control is a single line — these collapse onto one
// row with the label, keyframe diamond, and expose/control buttons. Wide /
// multi-line controls (file & font pickers, paint canvas, multiline text,
// ramps, curves, merge layers) keep the stacked header so they have room.
function isInlineParam(param: ParamDef): boolean {
  switch (param.type) {
    case "scalar":
    case "vec2":
    case "vec3":
    case "vec4":
    case "color":
    case "boolean":
    case "enum":
      return true;
    case "string":
      // Single-line text inputs collapse; multiline text areas don't.
      return !param.multiline;
    default:
      return false;
  }
}

// --- color conversions (hex <-> rgb <-> hsl) -----------------------------
// HSL here is the conventional UI scale: H 0–360, S/L 0–100.

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

export default memo(ParamPanel);
