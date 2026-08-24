"use client";

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  useReactFlow,
  useNodesInitialized,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import EffectNode from "./EffectNode";
import {
  ownerDocument,
  usePanelWindow,
} from "./layout/panel-window";
import RerouteNode from "./RerouteNode";
import FrameNode, { computeFrameRects, collectFrameMemberIds } from "./FrameNode";
import { NODE_TINTS } from "./node-tints";
import JunctionEdge from "./JunctionEdge";
// (waypoint-context retired with the junction waypoint — reroute is a node now)
import WireActionOverlay from "./WireActionOverlay";
import NodeSearchPopup from "./NodeSearchPopup";
import SimulationZoneUnderlay from "./SimulationZoneUnderlay";
import IterateZoneUnderlay, {
  computeIterateZoneRects,
} from "./IterateZoneUnderlay";
import { useEffectiveDevice } from "./input-device";
import { getNodeDef } from "@/engine/registry";
import {
  defaultBezierCps,
  handleCenter,
  sampleCubic,
  type Pt,
} from "@/engine/wire-geometry";
import { paramSocketType, parseTargetHandleKind } from "@/state/graph";
import {
  parseRampParamKey,
  rampFieldSocketType,
} from "@/engine/conventions";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  ITERATE_INPUT_TYPE,
  ITERATE_TYPE,
  LAYER_TYPE,
  VIRTUAL_SOCKET,
} from "@/engine/groups";
import { editorCanCoerce } from "@/engine/graph-validation";
import type { SocketType } from "@/engine/types";
import { FRAME_TYPE, REROUTE_TYPE } from "@/engine/graph-helpers";

// Node types you can dive into with Tab / double-click. Iterate is
// deliberately absent — its body always renders inline as a zone
// (071926_iterate-zone-view.md), there is no interior scope to enter.
function isEnterableScope(defType: string): boolean {
  return defType === GROUP_TYPE || defType === LAYER_TYPE;
}
import { getShortcutScope } from "./shortcut-scope";
import {
  claimNodesPane,
  ownsGlobalNodesPaneScope,
  ownsNodesPaneScope,
  registerNodesPane,
  unregisterNodesPane,
} from "./nodes-pane-scope";
import { looksLikeFragmentText } from "@/lib/fragment-clipboard";
import { looksLikeSvgPasteText } from "@/lib/svg-parse";
import type { NodeDataPayload } from "@/state/graph";
import { useTheme } from "./theme/theme";

// Context stashed when a wire drag is released on empty pane and the node
// search popup opens — the picked node gets auto-wired to the drag's origin.
// A drag out of an OUTPUT socket wires source → the new node's first
// accepting input; a drag out of an INPUT socket wires the new node's first
// accepting output → that input.
export type PendingWire =
  | {
      kind: "from-source";
      sourceNodeId: string;
      sourceHandle: string;
      sourceType: string;
    }
  | {
      kind: "into-target";
      targetNodeId: string;
      targetHandle: string;
      targetType: string;
    };

interface Props {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<NodeDataPayload>>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onSelectNode: (id: string | null) => void;
  // Returns the new node's id when a single plain node was spawned, so
  // the add menu can hand it straight to G-move. Compound adds (layer,
  // iterate, presets, …) return nothing.
  onAddNode: (
    type: string,
    pendingWire?: PendingWire
  ) => string | undefined | void;
  // Fires while the cursor is over the flow pane (not over nodes or menus).
  // The parent uses the latest value to seed `onAddNode`'s drop position.
  onPanePointer?: (pos: { x: number; y: number }) => void;
  // Modifier-drag + clipboard actions. All optional; NodeEditor hides the
  // features it can't perform.
  onDuplicateOnDrag?: (nodeId: string) => void;
  // Strip every edge from the node. `bridge` (resolved by findDetachBridge)
  // is present when the node was cleanly inline — the parent should then
  // reconnect its neighbors (A→C) so the chain heals as the node leaves.
  onDetachNode?: (
    nodeId: string,
    bridge?: {
      source: string;
      sourceHandle: string;
      target: string;
      targetHandle: string;
    } | null
  ) => void;
  // Right-click a node-group → "Edit with AI" (opens the AI panel in edit mode).
  onEditWithAINode?: (nodeId: string) => void;
  // Right-click a node with a spline-typed output → "Make Editable": the
  // parent bakes the evaluated spline into a fresh Spline Draw node,
  // bypasses this node, and moves its spline out-wires over
  // (makeSplineEditable in graph-ops). NodeEditor owns only the menu
  // gating — hidden for Spline Draw itself (already editable), structural
  // shells (no eval-cache entry to bake from), and reroutes.
  onMakeEditableNode?: (nodeId: string) => void;
  onDuplicateNode?: (nodeId: string) => void;
  // Right-click → "Save as Preset…": the parent captures the node (+
  // descendants) as a fragment and saves it to the user's preset list
  // (081226_user-node-presets.md). NodeEditor owns only the menu gating —
  // hidden for structural chrome (reroutes, frames, layer shells,
  // group/iterate boundary nodes).
  onSaveNodeAsPreset?: (nodeId: string) => void;
  onDuplicateSelection?: () => void;
  // Shift+M: wrap the currently selected image/mask-output nodes in a
  // new Merge node, wiring them in as base + layers. Parent owns the
  // eligibility filter and edge surgery; NodeEditor just owns the key.
  onMergeSelection?: () => void;
  onCopyNodes?: () => void;
  onPasteNodes?: () => void;
  // OS-clipboard text looked like a Toolbox fragment (copied from another tab /
  // instance, or a shared snippet). Handles the cross-instance paste.
  onPasteFragmentText?: (text: string) => void;
  // OS-clipboard text looked like SVG markup or bare path data (Figma
  // "Copy as SVG" → Spline Draw node at the cursor). Spec: 073026_svg-paste.md.
  onPasteSvgText?: (text: string, flowPos: { x: number; y: number }) => void;
  // Desktop file drop + clipboard paste — when the user drops an image/
  // video/audio/svg file onto the flow pane, or pastes one from the OS
  // clipboard, we spawn the matching source node with that file already
  // loaded. EffectsApp owns the type-detect + registration path.
  onAddFileNode?: (
    file: File,
    flowPos: { x: number; y: number }
  ) => void;
  // Drop a generated image (from the Image Generate panel's
  // thumbnail strip) onto the canvas → spawn an Image Source node.
  // Drag mime is `application/x-toolbox-image-gen`; payload is JSON
  // `{ privatePath, format }`. Parent owns the download + bitmap
  // creation so the new node ends up with a freshly-decoded
  // ImageBitmap in its `file` param.
  onAddImageNodeFromImageGen?: (
    payload: { privatePath: string; format: string },
    flowPos: { x: number; y: number }
  ) => void;
  // Drag an asset (font / folder media) from the Assets panel onto the canvas.
  onAddAssetNode?: (
    payload: { source: string; kind: string; ref: string; name: string },
    flowPos: { x: number; y: number }
  ) => void;
  // Wire-gesture actions. `onCombineWires` is called when a shift-drag
  // crosses one or more edges; the caller drops a reroute node on the crossed
  // wire(s) at `midpointFlow` (specdocs/archive/071326_reroute-node.md). `onCutWires`
  // is called with every edge id that an alt-drag crossed.
  onCombineWires?: (
    edgeIds: string[],
    midpointFlow: [number, number]
  ) => void;
  onCutWires?: (edgeIds: string[]) => void;
  // Fires on drag-stop when a single dragged node has been positioned
  // over a compatible edge — NodeEditor has already checked that the
  // node's sockets can splice in. Parent is expected to remove the
  // given edge and add two new ones connecting the original source to
  // `inputName` and `outputHandle` to the original target.
  onSpliceNode?: (args: {
    nodeId: string;
    edgeId: string;
    inputName: string;
    outputHandle: string;
  }) => void;
  // Optional content rendered inside React Flow's viewport — receives
  // the same pan/zoom transform as nodes, so anchored overlays (data
  // inspector popups, etc.) follow the graph.
  viewportOverlay?: React.ReactNode;
  // Node groups. Cmd+G / Cmd+Shift+G — parent owns the edge surgery and
  // scope rules; NodeEditor owns the keys. Tab dives into the selected
  // group, Shift+Tab goes up one scope, double-click on a group node
  // also dives.
  onGroupSelection?: () => void;
  onUngroupSelection?: () => void;
  onDiveIntoGroup?: (groupId: string) => void;
  onScopeUp?: () => void;
  // Double-click on a MIDI Editor node opens the viewport piano roll
  // (080926_midi-editor.md engagement — the second path is the node
  // header's Edit button).
  onOpenMidiEditor?: (nodeId: string) => void;
  // Zone view (071926_iterate-zone-view.md): a node dragged into / out
  // of an expanded Iterate's zone rect requests a scope move. Parent
  // owns the legality check (reparentNode) + undo + toast.
  onReparentNode?: (nodeId: string, newParentId: string | undefined) => void;
  // Cosmetic styling from the right-click menu (073026): apply a tint
  // preset (null clears) and/or toggle the bold outline on the given
  // nodes. Parent owns undo (one pushGraph + one setNodes per call).
  onStyleNodes?: (
    nodeIds: string[],
    patch: { tint?: string | null; bold?: boolean }
  ) => void;
  // Shift+F — frame the current selection (or spawn an empty frame at
  // the cursor when nothing is selected). Parent owns the node creation
  // + membership writes.
  onFrameSelection?: () => void;
  // Frame membership from drag gestures (073026): a single dragged node
  // whose center lands in a same-scope frame joins it; a Cmd-drag ending
  // outside every frame leaves. undefined = clear membership.
  onSetNodeFrame?: (nodeId: string, frameId: string | undefined) => void;
  // Scope trail for the breadcrumb row: the Project crumb
  // (PROJECT_CRUMB_ID) first, then the composition (id null), then the
  // group chain to the current scope. The row hides at the comp root.
  breadcrumbs?: { id: string | null; name: string }[];
  onNavigateScope?: (groupId: string | null) => void;
  // Clicking the Project crumb opens the Project view (file browser).
  onOpenProject?: () => void;
  // True when the editor shows root scope (the strict layer chain) —
  // the add-node popup then offers only the Layer entry.
  atRoot?: boolean;
  // Bump to re-frame the whole graph. The `fitView` prop only fires at
  // mount; opening a project swaps the node set in place, so the parent
  // increments this to ask the editor to fit the freshly-loaded graph
  // once React Flow has measured it. Initial value (0) is a no-op.
  frameSignal?: number;
  // Tiled layout (072726_window-tiling.md): several NodeEditor panes can
  // mount at once. Window-level shortcut/paste handlers gate on this
  // pane owning the instance scope (nodes-pane-scope.ts) so two panes
  // never both act on one keystroke. Single-pane setups can omit it.
  paneId?: string;
}

// Sentinel id for the leading breadcrumb crumb that opens the Project view
// (v5). A real scope id is a node id / null; this never collides.
export const PROJECT_CRUMB_ID = "__project__";

// Per-pane camera stash (tiled layout, 072726 M4 polish): a pane that
// unmounts (its leaf's kind switched away, or the docs round-trip)
// parks its viewport here keyed by pane id; remounting the SAME pane
// restores it instead of re-running the initial fitView. Module-level
// so it survives React unmounts within a page load — the same
// rationale as state/editor-session.ts. Leaf ids retire over a
// session, so stale entries just sit unused (tiny).
const paneCameraStash = new Map<
  string,
  { x: number; y: number; zoom: number }
>();

// Memoized (export at the bottom): EffectsApp re-renders on every rAF tick
// during playback; with stable prop identities (EffectsApp memoizes /
// useCallbacks them) the memo keeps the whole xyflow tree out of those
// frames entirely.
function NodeEditor({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectNode,
  onAddNode,
  onPanePointer,
  onDuplicateOnDrag,
  onDetachNode,
  onEditWithAINode,
  onMakeEditableNode,
  onDuplicateNode,
  onSaveNodeAsPreset,
  onDuplicateSelection,
  onMergeSelection,
  onCopyNodes,
  onPasteNodes,
  onPasteFragmentText,
  onPasteSvgText,
  onAddFileNode,
  onAddImageNodeFromImageGen,
  onAddAssetNode,
  onCombineWires,
  onCutWires,
  onSpliceNode,
  viewportOverlay,
  onGroupSelection,
  onUngroupSelection,
  onDiveIntoGroup,
  onScopeUp,
  onOpenMidiEditor,
  onReparentNode,
  onStyleNodes,
  onFrameSelection,
  onSetNodeFrame,
  breadcrumbs,
  onNavigateScope,
  onOpenProject,
  atRoot,
  frameSignal,
  paneId = "main",
}: Props) {
  // Null in the main window; the child Window when this pane is popped
  // out (080226_panel-popout-windows.md §3). EVERY window-level
  // listener below resolves through it — module-scope `window` is
  // always the main one, so a detached pane would neither hear its own
  // keystrokes nor hit-test in the right coordinate space.
  const panelWin = usePanelWindow();
  // Drives React Flow's colorMode so its built-in palette (pane, handles,
  // controls, selection) tracks the editor theme.
  const { mode: themeMode } = useTheme();
  const nodeTypes = useMemo(
    () => ({ effect: EffectNode, reroute: RerouteNode, frame: FrameNode }),
    []
  );
  // Register JunctionEdge under the default edge type so every edge —
  // including ones that predate waypoints — flows through it. The
  // component renders identically to React Flow's default bezier when no
  // waypoint is set, so there's no visual change for unjoined edges.
  const edgeTypes = useMemo(() => ({ default: JunctionEdge }), []);
  const {
    screenToFlowPosition,
    flowToScreenPosition,
    setNodes: rfSetNodes,
    setEdges: rfSetEdges,
    getNodes: rfGetNodes,
    getEdges: rfGetEdges,
    deleteElements,
    getViewport,
    setViewport,
    fitView,
  } = useReactFlow();
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);

  // Pane-instance scope (tiled layout): register this pane, and claim
  // the shortcut scope when the pointer enters or presses inside it —
  // sticky, so the sole pane (the common case) always owns it and
  // shortcuts work with the cursor anywhere, exactly as before tiling.
  // The window matters: scope is resolved per window, since a keystroke
  // only reaches panes in the one holding OS focus (pop-out spec §M3).
  useEffect(() => {
    registerNodesPane(paneId, panelWin ?? window);
    return () => unregisterNodesPane(paneId);
  }, [paneId, panelWin]);
  // Camera restore: read once at mount (lazy useState — not a ref, so
  // render never touches ref.current); park the live camera on unmount.
  const [stashedCamera] = useState(() => paneCameraStash.get(paneId));
  useEffect(() => {
    return () => {
      paneCameraStash.set(paneId, getViewport());
    };
  }, [paneId, getViewport]);
  useEffect(() => {
    const el = flowWrapperRef.current;
    if (!el) return;
    const claim = () => claimNodesPane(paneId);
    el.addEventListener("pointerenter", claim);
    el.addEventListener("pointerdown", claim, true);
    return () => {
      el.removeEventListener("pointerenter", claim);
      el.removeEventListener("pointerdown", claim, true);
    };
  }, [paneId]);

  // Re-frame the whole graph when the parent bumps `frameSignal` (a project
  // was opened / a new one seeded → the node set was swapped in place, which
  // the mount-only `fitView` prop can't catch). `setNodes` is async and React
  // Flow measures the new nodes a frame or two later, so we can't fit
  // synchronously: a signal bump *arms* a pending fit, which fires once
  // `useNodesInitialized` reports every node has real dimensions. This one
  // effect re-runs on either signal — so it works whether or not
  // `nodesInitialized` toggles (an already-measured / empty scope stays
  // constant). Same envelope as the initial fit (maxZoom 1 so a tiny graph
  // doesn't blow up; padding for breathing room). frameSignal 0 is the initial
  // value — the `fitView` prop already frames the first mount, so it's a no-op.
  const nodesInitialized = useNodesInitialized();
  const pendingFrameRef = useRef(false);
  const lastFrameSignalRef = useRef(frameSignal);
  useEffect(() => {
    if (frameSignal !== undefined && frameSignal !== lastFrameSignalRef.current) {
      lastFrameSignalRef.current = frameSignal;
      if (frameSignal !== 0) pendingFrameRef.current = true;
    }
    if (pendingFrameRef.current && nodesInitialized) {
      pendingFrameRef.current = false;
      void fitView({ maxZoom: 1, padding: 0.25 });
    }
  }, [frameSignal, nodesInitialized, fitView]);

  // Cmd/Ctrl + middle-drag = zoom about the press point. React Flow's pan is
  // driven by d3-zoom on the pane (a `mousedown` listener), so we intercept
  // the gesture in the capture phase on the wrapper and stop it before d3-zoom
  // sees it, then drive the viewport ourselves. Scoped to button 1 + a zoom
  // modifier, so ordinary middle-drag panning (panOnDrag) is untouched.
  // (Drag right zooms in.) See specdocs/archive/061726_mouse-input-ux.md.
  useEffect(() => {
    const el = flowWrapperRef.current;
    if (!el) return;
    const win = panelWin ?? window;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 1 || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const start = getViewport();
      const startY = e.clientY;
      // Flow-space point under the cursor, held fixed while zooming.
      const flowX = (px - start.x) / start.zoom;
      const flowY = (py - start.y) / start.zoom;
      const onMove = (ev: MouseEvent) => {
        // Drag up zooms in.
        const factor = Math.exp(-(ev.clientY - startY) * 0.005);
        const nextZoom = Math.max(0.05, Math.min(4, start.zoom * factor));
        setViewport({
          x: px - flowX * nextZoom,
          y: py - flowY * nextZoom,
          zoom: nextZoom,
        });
      };
      const onUp = () => {
        win.removeEventListener("mousemove", onMove, true);
        win.removeEventListener("mouseup", onUp, true);
      };
      win.addEventListener("mousemove", onMove, true);
      win.addEventListener("mouseup", onUp, true);
    };
    el.addEventListener("mousedown", onDown, true);
    return () => el.removeEventListener("mousedown", onDown, true);
  }, [getViewport, setViewport, panelWin]);

  // Touch / pen detection for the React Flow gesture model. On
  // mouse, the marquee box-select is on by default and a single-
  // finger drag would be ambiguous — so we only flip it off when
  // we've actually seen a touch / pen pointer interact with the
  // editor. Once flipped, single-finger drag pans the canvas the
  // way users expect on iPad.
  //
  // We don't reset on a subsequent mouse pointer because hybrid
  // devices (iPad with mouse / trackpad) tend to keep using touch
  // intermittently — flipping back-and-forth would feel unstable.
  // A page reload (or new session) starts fresh in mouse mode.
  const [touchActive, setTouchActive] = useState(false);
  // Mouse vs trackpad governs the scroll behavior: a mouse wheel zooms,
  // a trackpad two-finger scroll pans (pinch still zooms). See input-device.ts.
  const inputDevice = useEffectiveDevice();
  const mouseScroll = inputDevice === "mouse" && !touchActive;
  useEffect(() => {
    if (touchActive) return;
    const el = flowWrapperRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        setTouchActive(true);
      }
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [touchActive]);

  // Window-level Delete / Backspace handler. React Flow's built-in
  // deleteKeyCode requires the pane to have keyboard focus, which it
  // loses the moment the user clicks anything outside the canvas
  // (param panel input, menu bar, etc.) — that's why "Delete" used
  // to need two presses: the first re-focused something, the second
  // actually deleted. Owning the key at the window level fixes that
  // without any focus-tracking magic. We skip when the user is
  // typing into a real input so backspace still edits text normally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (t?.isContentEditable) return;
      // Only act when this editor was the last one clicked, so Delete /
      // Shift+D don't fire while the user is working in the graph editor.
      if (getShortcutScope() !== "node") return;
      // …and only in the pane instance that owns the tiled-layout scope,
      // so two mounted panes never both delete/duplicate on one press.
      if (!ownsNodesPaneScope(paneId)) return;

      // Shift+D = duplicate selection, then immediately enter
      // G-move so the new clones follow the cursor until the user
      // left-clicks to place them (or right-clicks / Escape to
      // cancel). The actual G-move start is deferred to a useEffect
      // that fires once the parent's nodes state has propagated
      // back down with the new selection.
      if (
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "D" || e.key === "d")
      ) {
        if (!onDuplicateSelection) return;
        const selectedNodes = rfGetNodes().filter((n) => n.selected);
        if (selectedNodes.length === 0) return;
        e.preventDefault();
        pendingGAfterDupRef.current = true;
        onDuplicateSelection();
        return;
      }

      // Shift+F = frame the selection (073026_node-cosmetics-and-frames.md).
      // No selection gate — the parent spawns an empty frame at the cursor
      // when nothing is selected. (EffectsApp's full-canvas F handler bails
      // on shiftKey so this chord is exclusively ours.)
      if (
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "F" || e.key === "f")
      ) {
        if (!onFrameSelection) return;
        e.preventDefault();
        onFrameSelection();
        return;
      }

      // Cmd+G = group selection, Cmd+Shift+G = ungroup. The parent owns
      // socket creation / edge surgery / cycle refusal; we just gate on
      // having a selection so an empty Cmd+G doesn't eat the browser
      // shortcut for nothing.
      if ((e.metaKey || e.ctrlKey) && (e.key === "G" || e.key === "g")) {
        if (e.shiftKey) {
          if (!onUngroupSelection) return;
          e.preventDefault();
          onUngroupSelection();
          return;
        }
        if (!onGroupSelection) return;
        const selectedNodes = rfGetNodes().filter((n) => n.selected);
        if (selectedNodes.length === 0) return;
        e.preventDefault();
        onGroupSelection();
        return;
      }

      // Shift+M = wrap the selected nodes in a Merge node. The parent
      // filters the selection down to image/mask-output nodes and no-ops
      // if none qualify, so we just gate on "something is selected".
      if (
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "M" || e.key === "m")
      ) {
        if (!onMergeSelection) return;
        const selectedNodes = rfGetNodes().filter((n) => n.selected);
        if (selectedNodes.length === 0) return;
        e.preventDefault();
        onMergeSelection();
        return;
      }

      // m (no modifiers) = toggle Bypass on the selected node(s). Reuses the
      // exact `effect-node-toggle` bus the header "B" button dispatches, so
      // the shortcut's behavior (and any eval/history side effects) matches
      // the button. Guarded on !shiftKey so it never collides with Shift+M
      // (wrap-in-Merge) above. Render Queue has no bypass — it produces
      // nothing to pass through — matching the button's !isQueue gate.
      // !e.repeat so holding the key doesn't flicker the toggle on/off.
      if (
        !e.repeat &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "m" || e.key === "M")
      ) {
        const bypassable = rfGetNodes().filter(
          (n) => n.selected && n.data?.defType !== "render-queue"
        );
        if (bypassable.length === 0) return;
        e.preventDefault();
        for (const n of bypassable) {
          window.dispatchEvent(
            new CustomEvent("effect-node-toggle", {
              detail: { id: n.id, kind: "toggleBypass" },
            })
          );
        }
        return;
      }

      // Skip when modifier keys repurpose the key (Cmd+X = cut,
      // Cmd+Backspace = delete-line in some browsers).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const isDelete =
        e.key === "Backspace" ||
        e.key === "Delete" ||
        e.key === "x" ||
        e.key === "X";
      if (!isDelete) return;
      // Don't steal Delete from the Track Editor — when the cursor
      // is over its lane area, keyframe deletion is the right action.
      // We use the latest mouse position (tracked below for G-move)
      // because window keydowns don't carry pointer coords.
      const mp = lastMouseRef.current;
      if (mp) {
        const under = ownerDocument(flowWrapperRef.current).elementFromPoint(
          mp.x,
          mp.y
        ) as HTMLElement | null;
        if (under?.closest("[data-track-editor]")) return;
      }
      const selectedNodes = rfGetNodes().filter((n) => n.selected);
      const selectedEdges = rfGetEdges().filter((ed) => ed.selected);
      if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
      e.preventDefault();
      deleteElements({
        nodes: selectedNodes.map((n) => ({ id: n.id })),
        edges: selectedEdges.map((ed) => ({ id: ed.id })),
      });
    };
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [
    rfGetNodes,
    rfGetEdges,
    deleteElements,
    onDuplicateSelection,
    onMergeSelection,
    onGroupSelection,
    onUngroupSelection,
    onFrameSelection,
    paneId,
  ]);

  // Tab = dive into the selected group/layer; Shift+Tab = up one scope.
  // Owned in CAPTURE phase because React Flow's keyboard a11y makes
  // nodes focusable and steals Tab (to cycle focus between nodes) at the
  // pane level — a bubble-phase window listener never sees it. Capturing
  // at the window runs us first, so we preventDefault + stopPropagation
  // and React Flow's handler never fires.
  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) {
        return;
      }
      if (getShortcutScope() !== "node") return;
      if (!ownsNodesPaneScope(paneId)) return;
      if (e.shiftKey) {
        if (!onScopeUp) return;
        e.preventDefault();
        e.stopPropagation();
        onScopeUp();
        return;
      }
      const selectedNodes = rfGetNodes().filter((n) => n.selected);
      const group =
        selectedNodes.length === 1 &&
        isEnterableScope((selectedNodes[0].data as NodeDataPayload).defType)
          ? selectedNodes[0]
          : null;
      if (group) {
        if (!onDiveIntoGroup) return;
        e.preventDefault();
        e.stopPropagation();
        onDiveIntoGroup(group.id);
        return;
      }
      // No enterable group selected: Tab pops up one level (same as
      // Shift+Tab) when we're inside a group/layer. At root it's a no-op.
      if (!atRoot && onScopeUp) {
        e.preventDefault();
        e.stopPropagation();
        onScopeUp();
      }
    };
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKeyCapture, true);
    return () => win.removeEventListener("keydown", onKeyCapture, true);
  }, [rfGetNodes, onDiveIntoGroup, onScopeUp, atRoot, paneId]);

  // Apple Pencil hover indicator. iPad / Apple Pencil fires
  // pointermove with pointerType === "pen" while hovering, *before*
  // the user touches down. We track the latest hover position to
  // render a small floating cursor + an offset "+" affordance the
  // user can tap to open the node search at that flow position
  // (same code path as Shift+A).
  //
  // Auto-hides shortly after the pen leaves to avoid a stale ghost.
  // Only mouse / pen pointers count — finger touches on iPad don't
  // expose hover, and treating the most recent finger touch as a
  // "hover" would leave the indicator stuck wherever the user last
  // tapped.
  const [penHover, setPenHover] = useState<{
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    const el = flowWrapperRef.current;
    if (!el) return;
    let hideTimer: number | null = null;
    const clearHide = () => {
      if (hideTimer != null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const scheduleHide = () => {
      clearHide();
      hideTimer = window.setTimeout(() => setPenHover(null), 600);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "pen") return;
      clearHide();
      setPenHover({ x: e.clientX, y: e.clientY });
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "pen") return;
      scheduleHide();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointercancel", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointercancel", onLeave);
      clearHide();
    };
  }, []);
  // Static no-op handlers so WireActionOverlay always has something to
  // call, even when the parent didn't wire these props.
  const handleCombine = useCallback(
    (ids: string[], mid: [number, number]) => {
      onCombineWires?.(ids, mid);
    },
    [onCombineWires]
  );
  const handleCut = useCallback(
    (ids: string[]) => {
      onCutWires?.(ids);
    },
    [onCutWires]
  );

  const reportPane = (clientX: number, clientY: number) => {
    if (!onPanePointer) return;
    const pos = screenToFlowPosition({ x: clientX, y: clientY });
    onPanePointer(pos);
  };

  // Right-click context menu state. Menu lives on top of the flow at
  // client pixel coords; items call the action callbacks above.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);
  const closeContextMenu = () => setContextMenu(null);

  // Splice candidate — the edge id a compatible dragged node is
  // currently hovering over. Set during drag, cleared on drop. Ref
  // version so the drag-stop handler sees the latest value
  // synchronously without waiting for state to flush.
  const [spliceCandidate, setSpliceCandidate] = useState<{
    edgeId: string;
    inputName: string;
    outputHandle: string;
  } | null>(null);
  const spliceRef = useRef<typeof spliceCandidate>(null);
  spliceRef.current = spliceCandidate;

  // Render-refreshed bodies + stable shells for the ReactFlow per-node
  // handlers (assigned just before the JSX return; see the comment there).
  type RfNode = Node<NodeDataPayload>;
  // Active shell-drag snapshot: the Iterate shell being dragged plus
  // every member's start position (071926_iterate-zone-view.md).
  const zoneDragRef = useRef<{
    shellId: string;
    start: { x: number; y: number };
    members: Map<string, { x: number; y: number }>;
  } | null>(null);
  // Cmd/Ctrl held at drag start — the "take it out of the zone"
  // modifier (it already means detach-with-heal, which strips the wires
  // that would otherwise block the reparent). Plain drags never remove
  // membership; the zone just stretches.
  const cmdDragRef = useRef(false);
  const nodeDragStartRef = useRef<(e: React.MouseEvent, node: RfNode) => void>(
    () => {}
  );
  const nodeDragRef = useRef<
    (e: React.MouseEvent, node: RfNode, dragged: RfNode[]) => void
  >(() => {});
  const nodeDragStopRef = useRef<
    (e: React.MouseEvent, node: RfNode, dragged: RfNode[]) => void
  >(() => {});
  const nodeContextMenuRef = useRef<
    (e: React.MouseEvent, node: RfNode) => void
  >(() => {});
  const nodeDoubleClickRef = useRef<
    (e: React.MouseEvent, node: RfNode) => void
  >(() => {});
  const stableNodeDragStart = useCallback(
    (e: React.MouseEvent, node: RfNode) => nodeDragStartRef.current(e, node),
    []
  );
  const stableNodeDrag = useCallback(
    (e: React.MouseEvent, node: RfNode, dragged: RfNode[]) =>
      nodeDragRef.current(e, node, dragged),
    []
  );
  const stableNodeDragStop = useCallback(
    (e: React.MouseEvent, node: RfNode, dragged: RfNode[]) =>
      nodeDragStopRef.current(e, node, dragged),
    []
  );
  const stableNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: RfNode) => nodeContextMenuRef.current(e, node),
    []
  );
  const stableNodeDoubleClick = useCallback(
    (e: React.MouseEvent, node: RfNode) => nodeDoubleClickRef.current(e, node),
    []
  );

  // Set by onReconnect when a drag-detach actually lands on a new
  // handle. onReconnectEnd consults this to decide whether to drop
  // the edge (drop on pane = detach) or leave the rewire alone.
  const reconnectSucceededRef = useRef(false);
  // React Flow fires onConnectStart for edge reconnects too (synchronously,
  // right after onReconnectStart), passing the wire's ANCHORED end — for our
  // target-side reconnects that's the source output, so a reconnect drag is
  // effectively "pull a wire out of that output." Fuzzy-connect applies to
  // both. `reconnectOneShotRef` distinguishes a reconnect's onConnectStart
  // from a fresh one (so a fresh drag can drop a stale reconnect edge);
  // `reconnectingEdgeRef` holds the wire being re-routed so onConnectEnd can
  // remove it when a Shift-drop lands the new edge on a different node.
  const reconnectOneShotRef = useRef(false);
  const reconnectingEdgeRef = useRef<Edge | null>(null);

  // -------- Shift-drag "fuzzy connect" -----------------------------------
  // Pull a wire off a socket with Shift held and you don't have to aim at
  // the exact target handle: a blue ring fades in at the cursor, brightens
  // while it's over a droppable node, and on release the wire lands on the
  // first socket of that node which accepts the type (match or coercion).
  //
  // `connectDragRef` holds the source handle for the in-flight connection
  // (set in onConnectStart, cleared in onConnectEnd); `shiftDownRef` tracks
  // the live Shift state so the ring only shows while Shift is held; the
  // ring itself is `connectRing` (client coords + whether it's over a node).
  const connectDragRef = useRef<{
    fromNodeId: string;
    fromHandle: string;
    handleType: "source" | "target";
  } | null>(null);
  const shiftDownRef = useRef(false);
  const [connectRing, setConnectRing] = useState<{
    x: number;
    y: number;
    overNode: boolean;
  } | null>(null);
  // Mirror of "is the ring currently shown" so the imperative handlers can
  // skip redundant setState calls without reading React state.
  const connectRingShownRef = useRef(false);
  const hideConnectRing = useCallback(() => {
    if (connectRingShownRef.current) {
      connectRingShownRef.current = false;
      setConnectRing(null);
    }
  }, []);

  // -------- Shift-drag from a NODE BODY ----------------------------------
  // Same fuzzy-connect idea, but the wire is pulled from the node itself
  // rather than a socket: hold Shift and drag off a node's body and we draw a
  // straight line from its first output to the cursor (plus the same ring),
  // then on release over another node wire that output into the first socket
  // that accepts it. Driven by a capture-phase pointerdown interceptor (below)
  // — React Flow would otherwise move/multiselect the node. `nodeConnect`
  // holds the live line + ring; `processNodeDropRef` is refreshed each render
  // so the mount-once interceptor always resolves against the current graph.
  const [nodeConnect, setNodeConnect] = useState<{
    originX: number;
    originY: number;
    x: number;
    y: number;
    overNode: boolean;
  } | null>(null);
  const processNodeDropRef = useRef<
    (originId: string, clientX: number, clientY: number) => void
  >(() => {});

  // Decorate edges with `data.spliceHighlight` on the fly — purely UI
  // state, no need to round-trip through the parent's edges state.
  // JunctionEdge picks up the flag and boosts its stroke. We also
  // mark every edge reconnectable on the TARGET (input) side only —
  // the user can grab a wire from a connected input port and drag
  // it to re-route, but pulling from the output side is locked so
  // we don't conflict with the "drag from an unconnected output to
  // start a new wire" gesture.
  const displayEdges = useMemo(() => {
    return edges.map((e) => {
      const next: Edge = { ...e, reconnectable: "target" };
      if (spliceCandidate && e.id === spliceCandidate.edgeId) {
        return {
          ...next,
          data: { ...(e.data ?? {}), spliceHighlight: true },
        };
      }
      return next;
    });
  }, [edges, spliceCandidate]);

  // -------- G-move state -------------------------------------------------
  // Blender-style "press G to move." Picks up the currently-selected
  // nodes and follows the cursor live until the user clicks (commit)
  // or hits Escape / right-clicks (cancel). Emits position changes
  // through onNodesChange with dragging flags so the parent's history
  // hook treats it like a normal drag — undoable, single history entry.
  const [gMove, setGMove] = useState<null | {
    startMouse: { x: number; y: number };
    origPositions: Map<string, { x: number; y: number }>;
  }>(null);
  const gMoveRef = useRef(gMove);
  gMoveRef.current = gMove;
  // Set by Shift+D so the next render (once duplicates land in `nodes`)
  // can immediately enter G-move on the new selection.
  const pendingGAfterDupRef = useRef(false);
  // Same handoff for the add menu, but keyed to the specific node id the
  // parent just spawned — an add can land while nothing is selected yet,
  // and an id keeps a stale flag from grabbing some unrelated selection
  // on a later, unrelated `nodes` update.
  const pendingGAfterAddRef = useRef<string | null>(null);
  // Tracked globally so we can use the cursor position at the moment
  // of G keypress (which itself doesn't carry mouse coords).
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    // pointermove also covers Pencil hover, so G-move starts from where the
    // stylus actually is rather than the last place a mouse was seen.
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    return () => win.removeEventListener("pointermove", onMove);
  }, []);

  const exitGCommit = useCallback(() => {
    const g = gMoveRef.current;
    if (!g) return;
    // dragging=false flushes the parent's history snapshot, which
    // it captured on the first dragging=true we sent. Net history
    // entry: original positions → final positions. Properly undoable.
    const finalChanges: NodeChange<Node<NodeDataPayload>>[] = [];
    for (const id of g.origPositions.keys()) {
      finalChanges.push({ type: "position", id, dragging: false });
    }
    if (finalChanges.length) onNodesChange(finalChanges);
    setGMove(null);
  }, [onNodesChange]);

  const exitGCancel = useCallback(() => {
    const g = gMoveRef.current;
    if (!g) return;
    // Snap positions back to the originals. We bypass onNodesChange
    // for the revert itself so the parent's history hook doesn't
    // capture a fresh snapshot mid-drag — just splat the originals
    // directly. Then send dragging=false to flush whatever snapshot
    // is already pending; that yields a no-op "original → original"
    // history entry, which is harmless.
    rfSetNodes((curr) =>
      curr.map((n) => {
        const orig = g.origPositions.get(n.id);
        return orig ? { ...n, position: orig } : n;
      })
    );
    const flushChanges: NodeChange<Node<NodeDataPayload>>[] = [];
    for (const id of g.origPositions.keys()) {
      flushChanges.push({ type: "position", id, dragging: false });
    }
    if (flushChanges.length) onNodesChange(flushChanges);
    setGMove(null);
  }, [onNodesChange, rfSetNodes]);

  // Keyboard listener: G toggles in (or commits if already in).
  // Skips when typing in editable elements so the letter isn't stolen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "g" && e.key !== "G") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      // Gate to the last-clicked editor so G doesn't fire here while the
      // graph editor (which owns G-grab) is the one in use.
      if (getShortcutScope() !== "node" && !gMoveRef.current) return;
      if (!ownsNodesPaneScope(paneId) && !gMoveRef.current) return;
      if (gMoveRef.current) {
        // G a second time = commit, mirroring Blender's behavior.
        e.preventDefault();
        exitGCommit();
        return;
      }
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;
      e.preventDefault();
      const origPositions = new Map<string, { x: number; y: number }>();
      for (const n of selected)
        origPositions.set(n.id, { x: n.position.x, y: n.position.y });
      setGMove({
        startMouse: lastMouseRef.current,
        origPositions,
      });
    };
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [nodes, exitGCommit, paneId]);

  // Add-menu handoff to G-move (Blender's Shift+A behavior): the node
  // the user just picked arrives under the cursor already grabbed, so
  // they place it with a move + click instead of a separate drag.
  useEffect(() => {
    const addedId = pendingGAfterAddRef.current;
    if (!addedId) return;
    const added = nodes.find((n) => n.id === addedId);
    if (!added) return; // hasn't reached this pane's scope yet
    pendingGAfterAddRef.current = null;
    // Unlike the G hotkey — which grabs with whatever offset the cursor
    // already has — anchor startMouse at the node itself so the node
    // snaps under the cursor on the first move. Otherwise it would trail
    // by however far down the menu the picked entry happened to be,
    // which is an artifact of menu navigation, not intent.
    setGMove({
      startMouse: flowToScreenPosition(added.position),
      origPositions: new Map([
        [added.id, { x: added.position.x, y: added.position.y }],
      ]),
    });
  }, [nodes, flowToScreenPosition]);

  // Shift+D handoff to G-move. After the parent has applied the
  // duplicate, the new clones land in `nodes` already selected — at
  // which point we pick them up the same way the G hotkey does.
  useEffect(() => {
    if (!pendingGAfterDupRef.current) return;
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;
    pendingGAfterDupRef.current = false;
    const origPositions = new Map<string, { x: number; y: number }>();
    for (const n of selected)
      origPositions.set(n.id, { x: n.position.x, y: n.position.y });
    setGMove({
      startMouse: lastMouseRef.current,
      origPositions,
    });
  }, [nodes]);

  // While in G-mode, drive position updates from cursor delta and
  // intercept clicks / Escape / right-click for commit / cancel.
  useEffect(() => {
    if (!gMove) return;
    // pointermove so G-move follows a Pencil hover too; the commit/cancel
    // presses stay on mousedown, which a tap still synthesizes.
    const onMove = (e: PointerEvent) => {
      const start = screenToFlowPosition({
        x: gMove.startMouse.x,
        y: gMove.startMouse.y,
      });
      const cur = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      const changes: NodeChange<Node<NodeDataPayload>>[] = [];
      for (const [id, orig] of gMove.origPositions) {
        changes.push({
          type: "position",
          id,
          position: { x: orig.x + dx, y: orig.y + dy },
          dragging: true,
        });
      }
      onNodesChange(changes);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) {
        // LMB commits — and we swallow the event so React Flow
        // doesn't also interpret it as a node selection / pane click.
        e.preventDefault();
        e.stopPropagation();
        exitGCommit();
      } else if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        exitGCancel();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitGCancel();
      }
    };
    const onContext = (e: MouseEvent) => {
      // Suppress the right-click context menu while G-mode is active —
      // the right-click gesture itself was the cancel signal.
      e.preventDefault();
    };
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    win.addEventListener("mousedown", onDown, true);
    win.addEventListener("keydown", onKey);
    win.addEventListener("contextmenu", onContext);
    return () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("mousedown", onDown, true);
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("contextmenu", onContext);
    };
  }, [gMove, screenToFlowPosition, onNodesChange, exitGCommit, exitGCancel]);

  // Coercion rules for splice compatibility — the shared table
  // (engine/graph-validation.ts editorCanCoerce), same as
  // isValidConnection uses for manually drawn wires.
  const canCoerce = editorCanCoerce;

  // The primary output type a node would expose if `srcType` were wired
  // into `inputName`. The polymorphic nodes (Transform / Displace /
  // Mirror / Reroute) retype their output from `connectedTypes` the
  // moment something lands on their input — EffectsApp's edges-keyed
  // resync writes that back a tick after the edge appears. Until then
  // the stored socket reads the RESTING type ("image" on a fresh
  // Transform), so a splice check against `data.primaryOutput` rejects
  // dropping a Transform on a spline/points wire even though drawing
  // that same pair of wires by hand is allowed. Resolving with the
  // prospective connectedTypes closes that gap. Non-polymorphic nodes
  // (no resolver, or one that ignores ctx) fall through to the stored
  // type unchanged.
  const projectPrimaryOutput = (
    node: Node<NodeDataPayload>,
    inputName: string,
    srcType: string
  ): string | null => {
    const stored = node.data.primaryOutput ?? null;
    const def = getNodeDef(node.data.defType);
    if (!def?.resolvePrimaryOutput) return stored;
    try {
      return (
        def.resolvePrimaryOutput(node.data.params, {
          connectedTypes: { [inputName]: srcType as SocketType },
        }) ?? stored
      );
    } catch {
      // A resolver must never break the drag — fall back to the socket
      // the node is currently showing.
      return stored;
    }
  };

  // Look for the nearest edge the given node could splice into.
  // Returns null if no edge is close enough or none are type-compatible.
  // Distance is measured in screen pixels between the node's visual
  // center and the nearest sample along the edge bezier.
  const findSpliceCandidate = (
    draggedNodeId: string
  ): {
    edgeId: string;
    inputName: string;
    outputHandle: string;
  } | null => {
    const draggedNode = nodes.find((n) => n.id === draggedNodeId);
    if (!draggedNode) return null;
    // If the dragged node already participates in any edge, skip the
    // splice. Auto-splice is meant for "drop a fresh node onto a
    // wire" — once a node has connections, dragging it past wires
    // shouldn't aggressively rewire it, that's surprising.
    if (
      edges.some(
        (e) => e.source === draggedNodeId || e.target === draggedNodeId
      )
    ) {
      return null;
    }
    const nodeEl = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(draggedNodeId)}"]`
    ) as HTMLElement | null;
    if (!nodeEl) return null;
    const nodeRect = nodeEl.getBoundingClientRect();
    const nodeCenter: Pt = [
      nodeRect.left + nodeRect.width / 2,
      nodeRect.top + nodeRect.height / 2,
    ];
    const THRESHOLD = 70;
    let best: {
      edgeId: string;
      dist: number;
      inputName: string;
      outputHandle: string;
    } | null = null;

    for (const edge of edges) {
      // Never splice into an edge that touches the dragged node — that
      // would loop the node to itself.
      if (edge.source === draggedNodeId || edge.target === draggedNodeId) {
        continue;
      }
      if (!edge.sourceHandle || !edge.targetHandle) continue;

      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);
      if (!sourceNode || !targetNode) continue;

      // Source/target socket types of the edge we'd splice into.
      let srcType: string | null = null;
      if (edge.sourceHandle === "out:primary") {
        srcType = sourceNode.data.primaryOutput ?? null;
      } else if (edge.sourceHandle.startsWith("out:aux:")) {
        const auxName = edge.sourceHandle.slice("out:aux:".length);
        srcType =
          sourceNode.data.auxOutputs.find((a) => a.name === auxName)?.type ??
          null;
      }
      let tgtType: string | null = null;
      if (edge.targetHandle.startsWith("in:")) {
        const inputName = edge.targetHandle.startsWith("in:param:")
          ? edge.targetHandle.slice("in:param:".length)
          : edge.targetHandle.slice("in:".length);
        const matched = targetNode.data.inputs.find(
          (i) => i.name === inputName
        );
        if (matched) tgtType = matched.type;
      }
      if (!srcType || !tgtType) continue;

      // Does the dragged node have an input we can route srcType into?
      // Virtual boundary sockets are excluded — splice wires straight
      // into handles, bypassing the connect path that mints real
      // sockets, so a virtual port must never be a splice target.
      const inputMatch = draggedNode.data.inputs.find(
        (i) =>
          i.name !== VIRTUAL_SOCKET &&
          canCoerce(
            srcType!,
            i.type,
            draggedNode.data.defType,
            `in:${i.name}`,
            draggedNode.data.params
          )
      );
      if (!inputMatch) continue;

      // And an output that can reach tgtType? Test the output the node
      // WILL have once the splice lands, not the resting one it shows
      // while unwired — see projectPrimaryOutput.
      const projectedPrimary = projectPrimaryOutput(
        draggedNode,
        inputMatch.name,
        srcType
      );
      let outputHandleId: string | null = null;
      if (
        projectedPrimary &&
        canCoerce(
          projectedPrimary,
          tgtType,
          targetNode.data.defType,
          edge.targetHandle,
          targetNode.data.params
        )
      ) {
        outputHandleId = "out:primary";
      }
      if (!outputHandleId) {
        for (const aux of draggedNode.data.auxOutputs) {
          if (aux.disabled || aux.name === VIRTUAL_SOCKET) continue;
          if (
            canCoerce(
              aux.type,
              tgtType,
              targetNode.data.defType,
              edge.targetHandle,
              targetNode.data.params
            )
          ) {
            outputHandleId = `out:aux:${aux.name}`;
            break;
          }
        }
      }
      if (!outputHandleId) continue;

      // Geometry: sample edge bezier in screen coords, find minimum
      // distance from the node's screen center.
      const srcCenter = handleCenter(edge.source, edge.sourceHandle);
      const tgtCenter = handleCenter(edge.target, edge.targetHandle);
      if (!srcCenter || !tgtCenter) continue;
      const { c1, c2 } = defaultBezierCps(srcCenter, tgtCenter);
      const samples = sampleCubic(srcCenter, c1, c2, tgtCenter, 20);
      let minDist = Infinity;
      for (const s of samples) {
        const d = Math.hypot(s[0] - nodeCenter[0], s[1] - nodeCenter[1]);
        if (d < minDist) minDist = d;
      }
      if (minDist < THRESHOLD && (!best || minDist < best.dist)) {
        best = {
          edgeId: edge.id,
          dist: minDist,
          inputName: inputMatch.name,
          outputHandle: outputHandleId,
        };
      }
    }
    if (!best) return null;
    return {
      edgeId: best.edgeId,
      inputName: best.inputName,
      outputHandle: best.outputHandle,
    };
  };

  // Inverse of the splice: when a node about to be detached sits cleanly
  // inline — exactly one incoming edge (from A) and exactly one outgoing
  // edge (to C), and A's output type can coerce straight into C's input
  // socket — return the bridge that heals A→C so pulling the node out
  // doesn't break the chain. Anything ambiguous (a branch, a node with
  // two inputs, an incompatible A→C pair) returns null and the node just
  // detaches with dangling neighbors. Mirrors findSpliceCandidate's split
  // of responsibility: NodeEditor resolves the handles + type-compat, the
  // parent (onDetachNode) applies the edge surgery.
  const findDetachBridge = (
    nodeId: string
  ): {
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  } | null => {
    const incoming = edges.filter((e) => e.target === nodeId);
    const outgoing = edges.filter((e) => e.source === nodeId);
    if (incoming.length !== 1 || outgoing.length !== 1) return null;
    const inE = incoming[0];
    const outE = outgoing[0];
    if (!inE.sourceHandle || !outE.targetHandle) return null;
    // Never bridge a node back to itself.
    if (inE.source === outE.target) return null;

    const sourceNode = nodes.find((n) => n.id === inE.source);
    const targetNode = nodes.find((n) => n.id === outE.target);
    if (!sourceNode || !targetNode) return null;

    // Upstream (A) source socket type.
    let srcType: string | null = null;
    if (inE.sourceHandle === "out:primary") {
      srcType = sourceNode.data.primaryOutput ?? null;
    } else if (inE.sourceHandle.startsWith("out:aux:")) {
      const auxName = inE.sourceHandle.slice("out:aux:".length);
      srcType =
        sourceNode.data.auxOutputs.find((a) => a.name === auxName)?.type ??
        null;
    }
    // Downstream (C) target socket type.
    let tgtType: string | null = null;
    if (outE.targetHandle.startsWith("in:")) {
      const inputName = outE.targetHandle.startsWith("in:param:")
        ? outE.targetHandle.slice("in:param:".length)
        : outE.targetHandle.slice("in:".length);
      tgtType =
        targetNode.data.inputs.find((i) => i.name === inputName)?.type ?? null;
    }
    if (!srcType || !tgtType) return null;
    if (
      !canCoerce(
        srcType,
        tgtType,
        targetNode.data.defType,
        outE.targetHandle,
        targetNode.data.params
      )
    ) {
      return null;
    }

    return {
      source: inE.source,
      sourceHandle: inE.sourceHandle,
      target: outE.target,
      targetHandle: outE.targetHandle,
    };
  };

  // Node search popup. Opens at cursor on Shift+A (with cursor over
  // the flow) or when a wire drag is released on empty space. Closes
  // on Esc, outside click, or after picking a node.
  //
  // `pendingWire` is set when the popup opened from a wire drop on
  // empty pane — carries the drag's origin handle (either side) so the
  // next created node gets auto-wired to it. Cleared when the popup
  // closes or when opened via Shift+A.
  const [nodePopup, setNodePopup] = useState<{
    x: number;
    y: number;
    pendingWire?: PendingWire;
  } | null>(null);
  const closeNodePopup = () => setNodePopup(null);
  // Last global cursor position — needed for Shift+A, which arrives as
  // a keyboard event without any pointer coordinates.
  const lastCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastCursorRef.current = { x: e.clientX, y: e.clientY };
    };
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onMove);
    return () => win.removeEventListener("pointermove", onMove);
  }, []);

  // Drive the Shift-drag fuzzy-connect ring. Only does work while a
  // connection is in progress (connectDragRef set); tracks the live Shift
  // state off the pointer events (authoritative during pointer capture) and
  // keydown/keyup (so pressing/releasing Shift without moving toggles the
  // ring too). Whether the cursor is over a droppable node is resolved with
  // elementFromPoint — the same DOM probe the splice detector uses — so we
  // don't need the `nodes` array here and the listeners never churn.
  useEffect(() => {
    const apply = (clientX: number, clientY: number, shift: boolean) => {
      shiftDownRef.current = shift;
      const drag = connectDragRef.current;
      if (!drag || !shift) {
        hideConnectRing();
        return;
      }
      const el = ownerDocument(flowWrapperRef.current).elementFromPoint(
        clientX,
        clientY
      ) as HTMLElement | null;
      const nodeEl = el?.closest(".react-flow__node") as HTMLElement | null;
      const id = nodeEl?.getAttribute("data-id");
      const overNode = !!id && id !== drag.fromNodeId;
      connectRingShownRef.current = true;
      setConnectRing({ x: clientX, y: clientY, overNode });
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!connectDragRef.current) return;
      apply(e.clientX, e.clientY, e.shiftKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || !connectDragRef.current) return;
      const c = lastCursorRef.current;
      apply(c.x, c.y, e.type === "keydown");
    };
    const win = panelWin ?? window;
    win.addEventListener("pointermove", onPointerMove);
    win.addEventListener("keydown", onKey);
    win.addEventListener("keyup", onKey);
    return () => {
      win.removeEventListener("pointermove", onPointerMove);
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("keyup", onKey);
    };
  }, [hideConnectRing]);

  // Shift-drag from a node BODY starts a connection. Intercepted in the
  // capture phase on the wrapper — the same technique the Cmd+middle-drag
  // zoom uses — so React Flow never sees the pointerdown and can't move or
  // multiselect the node. We defer the decision on a small threshold: a plain
  // Shift-click still toggles the node's selection (the multiselect we
  // swallowed), while a drag draws a line from the node's first output to the
  // cursor and, on release over another node, wires it up. Drags from a socket
  // handle (the existing gesture) and node controls (`.nodrag`) are left alone.
  useEffect(() => {
    const el = flowWrapperRef.current;
    if (!el) return;
    const win = panelWin ?? window;
    // Cancelling a pointerdown suppresses the compatibility mouse events but
    // NOT the `click` that follows it, so React Flow's node onClick still
    // runs after a gesture we swallowed. With Shift held that lands in its
    // multiselect branch and un-toggles whatever we just toggled below — the
    // two cancelled out and Shift+click appeared to do nothing at all. Arm
    // this on pointerup and eat that one click in the capture phase (before
    // it reaches the node, so React never sees it). Disarmed at the start of
    // every gesture so a release that produces no click (drag ended outside
    // the wrapper) can't leave it primed to eat an unrelated one.
    let swallowNextClick = false;
    const onClickCapture = (e: MouseEvent) => {
      if (!swallowNextClick) return;
      swallowNextClick = false;
      e.stopPropagation();
    };
    const onDown = (e: PointerEvent) => {
      swallowNextClick = false;
      if (e.button !== 0 || !e.shiftKey) return;
      const targetEl = e.target as HTMLElement | null;
      if (!targetEl) return;
      if (targetEl.closest(".react-flow__handle")) return;
      if (targetEl.closest(".nodrag")) return;
      const nodeEl = targetEl.closest(".react-flow__node") as HTMLElement | null;
      const originId = nodeEl?.getAttribute("data-id");
      if (!nodeEl || !originId) return;
      // Frames have no sockets to pull a wire from — leave the gesture to
      // React Flow so a Shift-drag on an edge band just moves the frame.
      const originData = rfGetNodes().find((n) => n.id === originId)?.data as
        | NodeDataPayload
        | undefined;
      if (originData?.defType === FRAME_TYPE) return;

      // Take over from React Flow for this gesture.
      e.preventDefault();
      e.stopPropagation();

      const origin = rfGetNodes().find((n) => n.id === originId) as
        | Node<NodeDataPayload>
        | undefined;
      // First output handle (primary, else first live aux) — the line anchor.
      let outHandle: string | null = null;
      if (origin) {
        if (origin.data.primaryOutput) outHandle = "out:primary";
        else {
          const aux = origin.data.auxOutputs.find((a) => !a.disabled);
          if (aux) outHandle = `out:aux:${aux.name}`;
        }
      }
      // Anchor the line at the first output socket; fall back to the node's
      // right-center if it has no rendered output handle.
      const anchor: Pt =
        (outHandle ? handleCenter(originId, outHandle) : null) ??
        (() => {
          const r = nodeEl.getBoundingClientRect();
          return [r.right, r.top + r.height / 2] as Pt;
        })();

      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const THRESHOLD = 4;

      const onMove = (ev: PointerEvent) => {
        if (
          !dragging &&
          Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD
        ) {
          return;
        }
        dragging = true;
        const under = ownerDocument(flowWrapperRef.current).elementFromPoint(
          ev.clientX,
          ev.clientY
        ) as HTMLElement | null;
        const overId = under
          ?.closest(".react-flow__node")
          ?.getAttribute("data-id");
        setNodeConnect({
          originX: anchor[0],
          originY: anchor[1],
          x: ev.clientX,
          y: ev.clientY,
          overNode: !!overId && overId !== originId,
        });
      };
      const onUp = (ev: PointerEvent) => {
        const win = panelWin ?? window;
        win.removeEventListener("pointermove", onMove, true);
        win.removeEventListener("pointerup", onUp, true);
        setNodeConnect(null);
        // We owned this gesture end to end — don't let its trailing click
        // reach React Flow (node multiselect on a click, pane-click on a
        // drag that released over empty canvas).
        swallowNextClick = true;
        if (dragging) {
          processNodeDropRef.current(originId, ev.clientX, ev.clientY);
        } else {
          // Plain Shift-click → additive toggle-select (React Flow's
          // multiselect, which we intercepted). onSelectionChange fans this
          // back out to onSelectNode.
          rfSetNodes((nodes) =>
            nodes.map((n) =>
              n.id === originId ? { ...n, selected: !n.selected } : n
            )
          );
        }
      };
      win.addEventListener("pointermove", onMove, true);
      win.addEventListener("pointerup", onUp, true);
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, [rfGetNodes, rfSetNodes, panelWin]);

  // Select on press, not on release. React Flow only selects a node on a
  // completed click or once a drag passes nodeDragThreshold; selecting here
  // makes the node (and the param panel, via onSelectionChange) respond the
  // moment the pointer goes down. Only an UNSELECTED node changes anything —
  // a press on a member of a multi-selection must leave the selection intact
  // so a group drag can follow, and the plain-click collapse to a single
  // node still happens at mouseup via React Flow's own click handling. The
  // event is left untouched, so React Flow runs its normal gesture and its
  // own click/drag-start selection lands as a no-op on top of ours.
  useEffect(() => {
    const el = flowWrapperRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      // The G-move commit press swallows its MOUSEdown (capture, above),
      // but this fires on POINTERdown, before that swallow can protect us
      // — an explicit gate keeps a commit over some background node from
      // collapsing the G selection.
      if (gMoveRef.current) return;
      // Plain left press only — Shift belongs to the connect gesture
      // above, Meta/Ctrl to additive multiselect (both resolve at
      // release), other buttons to pan / context menu, which don't select.
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
      const targetEl = e.target as HTMLElement | null;
      if (!targetEl) return;
      // Same exclusions as the connect gesture — and like it, this runs in
      // the capture phase, BEFORE node controls can stopPropagation, so
      // the target check is the only thing keeping a slider grab or a
      // socket drag from selecting the node.
      if (targetEl.closest(".react-flow__handle")) return;
      if (targetEl.closest(".nodrag")) return;
      const nodeId = targetEl
        .closest(".react-flow__node")
        ?.getAttribute("data-id");
      if (!nodeId) return;
      if (rfGetNodes().find((n) => n.id === nodeId)?.selected) return;
      rfSetNodes((nodes) =>
        nodes.map((n) =>
          n.id === nodeId
            ? { ...n, selected: true }
            : n.selected
              ? { ...n, selected: false }
              : n
        )
      );
      // Node selection displaces edge selection, mirroring React Flow's
      // click-select and the explicit onEdgeClick handler.
      rfSetEdges((edges) =>
        edges.map((ed) => (ed.selected ? { ...ed, selected: false } : ed))
      );
    };
    el.addEventListener("pointerdown", onDown, true);
    return () => el.removeEventListener("pointerdown", onDown, true);
  }, [rfGetNodes, rfSetNodes, rfSetEdges]);

  // Open the node-search popup at a screen point, clamped into the
  // editor so a request from outside it (e.g. the pie menu opened over
  // the canvas) still lands somewhere sensible. Shared by Shift+A and
  // the pie menu's "Add Node" item.
  const openNodeSearchAt = useCallback(
    (sx: number, sy: number) => {
      const wrapper = flowWrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const x = Math.min(Math.max(sx, rect.left + 8), rect.right - 8);
      const y = Math.min(Math.max(sy, rect.top + 8), rect.bottom - 8);
      // Seed the flow-coord pointer so the added node drops where the
      // popup opens (not where the mouse drifts while the popup is up).
      onPanePointer?.(screenToFlowPosition({ x, y }));
      setNodePopup({ x: x + 4, y: y + 4 });
    },
    [screenToFlowPosition, onPanePointer],
  );

  // Shift+A opens the popup when the cursor is inside the node editor
  // and no text field is focused. Skipped when any modifier other than
  // Shift is held, so combos like Cmd+Shift+A pass through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "A" && e.key !== "a") return;
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const wrapper = flowWrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const { x, y } = lastCursorRef.current;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        // Cursor isn't over the node editor — pass the event through.
        return;
      }
      e.preventDefault();
      openNodeSearchAt(x, y);
    };
    const win = panelWin ?? window;
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [openNodeSearchAt]);

  // The pie menu's "Add Node" item opens this same popup via a window
  // event carrying the pie's screen origin. Spec: 071326_pie-menu.md.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { x?: number; y?: number }
        | undefined;
      if (!d || typeof d.x !== "number" || typeof d.y !== "number") return;
      // One popup only when several panes are mounted (tiled layout).
      // GLOBAL scope, not per-window: this event is broadcast to every
      // window, so a per-window check would open one popup per window.
      if (!ownsGlobalNodesPaneScope(paneId)) return;
      openNodeSearchAt(d.x, d.y);
    };
    const win = panelWin ?? window;
    win.addEventListener("toolbox:open-node-search", onOpen);
    return () => win.removeEventListener("toolbox:open-node-search", onOpen);
  }, [openNodeSearchAt, paneId]);

  // Window-level `paste` listener. Replaces the old Cmd+V keydown path
  // so we can inspect the clipboard for files before deciding what to
  // do. Priority:
  //   - focused text field → let native paste happen, don't interfere
  //   - cursor not over flow → ignore
  //   - OS-clipboard text is SVG markup / path data → Spline Draw node
  //   - OS-clipboard has files → spawn source nodes with them
  //   - otherwise → internal node clipboard (onPasteNodes)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      // Exactly one pane handles a paste when several are mounted.
      if (!ownsNodesPaneScope(paneId)) return;
      // Cross-instance fragment paste: the OS clipboard holds a serialized
      // Toolbox group/recipe (copied from another tab/instance or a shared
      // snippet). Read it synchronously and route it before the file /
      // in-memory-clipboard paths.
      const txt = e.clipboardData?.getData("text/plain") ?? "";
      if (txt && looksLikeFragmentText(txt) && onPasteFragmentText) {
        e.preventDefault();
        onPasteFragmentText(txt);
        return;
      }
      const wrapper = flowWrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const { x, y } = lastCursorRef.current;
      // If cursor has never been inside the flow (fresh page + Cmd+V),
      // clientX/Y is 0,0 which wouldn't be over the flow. Fall back to
      // always handling paste when there's internal clipboard content
      // to paste — but only treat the "cursor over flow" case as the
      // trigger for the file-paste path.
      const overFlow =
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      // Clipboard SVG text (Figma "Copy as SVG", a bare path `d` string) →
      // Spline Draw node at the cursor. Gated on cursor-over-flow like the
      // file path below. An .svg FILE on the clipboard still takes the file
      // path (→ SVG Source). Spec: 073026_svg-paste.md.
      if (txt && overFlow && onPasteSvgText && looksLikeSvgPasteText(txt)) {
        e.preventDefault();
        onPasteSvgText(txt, screenToFlowPosition({ x, y }));
        return;
      }

      const files = e.clipboardData?.files;
      if (files && files.length > 0 && overFlow && onAddFileNode) {
        e.preventDefault();
        const flowPos = screenToFlowPosition({ x, y });
        for (let i = 0; i < files.length; i++) {
          onAddFileNode(files[i], {
            x: flowPos.x + i * 28,
            y: flowPos.y + i * 28,
          });
        }
        return;
      }
      if (onPasteNodes) {
        e.preventDefault();
        onPasteNodes();
      }
    };
    const win = panelWin ?? window;
    win.addEventListener("paste", onPaste);
    return () => win.removeEventListener("paste", onPaste);
  }, [
    onAddFileNode,
    onPasteNodes,
    onPasteFragmentText,
    onPasteSvgText,
    screenToFlowPosition,
    paneId,
  ]);

  const isValidConnection = (c: Connection | Edge) => {
    if (!c.sourceHandle || !c.targetHandle) return false;
    const sourceNode = nodes.find((n) => n.id === c.source);
    const targetNode = nodes.find((n) => n.id === c.target);
    if (!sourceNode || !targetNode) return false;

    // A member can never wire INTO its own zone's Iteration Input —
    // loop params and passthroughs take exterior values only (driving
    // the loop's configuration from inside the loop is circular).
    if (
      targetNode.data.defType === ITERATE_INPUT_TYPE &&
      sourceNode.data.parentId === targetNode.data.parentId
    ) {
      return false;
    }

    // Iterate zones render multiple scopes at once
    // (071926_iterate-zone-view.md rev 3), so scope legality is no
    // longer guaranteed by visibility. A cross-scope wire is valid only
    // for the zone's legal crossings:
    //   (1) member → its OWN shell (the collect tap / virtual mint);
    //   (2) exterior → the zone's Iteration Input exterior face;
    //   (3) exterior → member — the wire stays exactly as drawn; flatten
    //       mirrors it per-edge onto the shell and the compute feeds the
    //       value into each iteration ("stay as wired");
    //   (4) member → exterior — onConnect auto-mints the collect socket
    //       on the shell; only while the shell has none, and only when
    //       the exterior target accepts the GROUPED type (an image
    //       comes out as image_group).
    // Programmatic cross-scope edges (promoted params) don't pass
    // through here.
    if (sourceNode.data.parentId !== targetNode.data.parentId) {
      const parentOf = (n: RfNode) =>
        n.data.parentId
          ? nodes.find((x) => x.id === n.data.parentId)
          : undefined;
      const isGroupBoundary = (t: string) =>
        t === GROUP_INPUT_TYPE || t === GROUP_OUTPUT_TYPE;
      const sShell = parentOf(sourceNode);
      const sourceIsMember =
        sShell?.data.defType === ITERATE_TYPE &&
        !isGroupBoundary(sourceNode.data.defType);
      // (1) collect tap.
      const memberToOwnShell =
        sourceIsMember &&
        targetNode.id === sShell!.id &&
        sourceNode.data.defType !== ITERATE_INPUT_TYPE;
      // (2) exterior → Iteration Input's exterior face.
      const inputShell =
        targetNode.data.defType === ITERATE_INPUT_TYPE
          ? parentOf(targetNode)
          : undefined;
      const exteriorToInput =
        inputShell?.data.defType === ITERATE_TYPE &&
        sourceNode.data.parentId === inputShell.data.parentId &&
        !isGroupBoundary(sourceNode.data.defType);
      // (3) exterior → member (auto-mint passthrough).
      const tShell = parentOf(targetNode);
      const intoZone =
        tShell?.data.defType === ITERATE_TYPE &&
        sourceNode.data.parentId === tShell.data.parentId &&
        targetNode.data.defType !== ITERATE_INPUT_TYPE &&
        !isGroupBoundary(targetNode.data.defType) &&
        !isGroupBoundary(sourceNode.data.defType);
      // (5) iteration values → exterior: the Iteration Input's aux
      // outputs (index / t / random / passthroughs) may wire to any
      // same-scope-as-the-shell consumer. The wire stays PENDING (the
      // consumer sees nothing) until the chain is piped into the
      // Iteration Output, which absorbs it into the zone
      // (absorbIntoIterateZone). The virtual port is excluded — minting
      // a passthrough toward the outside is meaningless.
      const sInputShell =
        sourceNode.data.defType === ITERATE_INPUT_TYPE
          ? parentOf(sourceNode)
          : undefined;
      const iterValuesOut =
        sInputShell?.data.defType === ITERATE_TYPE &&
        targetNode.data.parentId === sInputShell.data.parentId &&
        c.sourceHandle !== `out:aux:${VIRTUAL_SOCKET}` &&
        targetNode.data.defType !== ITERATE_INPUT_TYPE &&
        !isGroupBoundary(targetNode.data.defType);
      // (4) member → exterior (auto-mint a collect socket on the shell —
      // every collect socket gets its own grouped output, so this is
      // always mintable; the only gate is the honest type one: the
      // exterior target must accept the GROUPED result).
      let outOfZone = false;
      if (
        sourceIsMember &&
        sourceNode.data.defType !== ITERATE_INPUT_TYPE &&
        targetNode.id !== sShell!.id &&
        targetNode.data.parentId === sShell!.data.parentId &&
        !isGroupBoundary(targetNode.data.defType)
      ) {
        const raw = resolveSourceSocketType(sourceNode, c.sourceHandle);
        const tgt = resolveTargetSocketType(targetNode, c.targetHandle);
        const grouped = raw === "image" ? "image_group" : raw;
        outOfZone =
          !!grouped &&
          !!tgt &&
          editorCanCoerce(
            grouped,
            tgt,
            targetNode.data.defType,
            c.targetHandle ?? undefined,
            targetNode.data.params
          );
      }
      if (
        !memberToOwnShell &&
        !exteriorToInput &&
        !intoZone &&
        !outOfZone &&
        !iterValuesOut
      ) {
        return false;
      }
    }

    // Virtual boundary sockets accept any type — the connect path mints
    // a real socket typed after the far end. Virtual-to-virtual is
    // refused: there'd be no type to infer on either side.
    const srcVirtual =
      c.sourceHandle === `out:aux:${VIRTUAL_SOCKET}` &&
      (sourceNode.data.defType === GROUP_INPUT_TYPE ||
        sourceNode.data.defType === ITERATE_INPUT_TYPE);
    const tgtVirtual =
      c.targetHandle === `in:${VIRTUAL_SOCKET}` &&
      (targetNode.data.defType === GROUP_OUTPUT_TYPE ||
        targetNode.data.defType === ITERATE_TYPE ||
        targetNode.data.defType === ITERATE_INPUT_TYPE);
    if (srcVirtual || tgtVirtual) return !(srcVirtual && tgtVirtual);

    if (c.sourceHandle.startsWith("out:aux:")) {
      const auxName = c.sourceHandle.slice("out:aux:".length);
      const aux = sourceNode.data.auxOutputs.find((a) => a.name === auxName);
      if (aux?.disabled) return false;
    }

    const srcType = resolveSourceSocketType(sourceNode, c.sourceHandle);
    const tgtType = resolveTargetSocketType(targetNode, c.targetHandle);
    if (!srcType || !tgtType) return false;

    // Shared coercion table + polymorphic defType exceptions — the single
    // source in engine/graph-validation.ts (rationale for each row lives
    // there).
    return editorCanCoerce(
      srcType,
      tgtType,
      targetNode.data.defType,
      c.targetHandle,
      targetNode.data.params
    );
  };

  // The graph node under a client point (excluding `excludeId`), via
  // elementFromPoint. Used by the Shift-drag fuzzy connect to resolve which
  // node a wire was released over even when the drop point isn't on a socket.
  const nodeAtClientPoint = (
    x: number,
    y: number,
    excludeId: string
  ): Node<NodeDataPayload> | null => {
    const el = ownerDocument(flowWrapperRef.current).elementFromPoint(
      x,
      y
    ) as HTMLElement | null;
    const nodeEl = el?.closest(".react-flow__node") as HTMLElement | null;
    const id = nodeEl?.getAttribute("data-id");
    if (!id || id === excludeId) return null;
    return nodes.find((n) => n.id === id) ?? null;
  };

  // Given the handle a Shift-drag started from and the node it was released
  // over, pick the first socket on that node that will accept the wire —
  // reusing `isValidConnection` so the exact same type-match + coercion rules
  // (and polymorphic/virtual-socket special cases) apply as a manual wire.
  // Sockets are tried top-to-bottom; unconnected ones win over occupied ones
  // (onConnect replaces an occupied target, same as dropping on the handle).
  // Returns a ready-to-apply Connection, or null if nothing accepts it.
  const buildShiftDropConnection = (
    drag: {
      fromNodeId: string;
      fromHandle: string;
      handleType: "source" | "target";
    },
    targetNode: Node<NodeDataPayload>
  ): Connection | null => {
    if (targetNode.id === drag.fromNodeId) return null;

    if (drag.handleType === "source") {
      // Dragged off an OUTPUT → land on one of the target's inputs. Declared
      // inputs first (in socket order, including the trailing virtual socket
      // on group boundaries — onConnect mints a real one), then any exposed
      // param sockets.
      const occupied = new Set(
        edges
          .filter((e) => e.target === targetNode.id)
          .map((e) => e.targetHandle)
      );
      const handles: string[] = [
        ...targetNode.data.inputs
          .filter((i) => !i.hidden)
          .map((i) => `in:${i.name}`),
        ...(targetNode.data.exposedParams ?? []).map((p) => `in:param:${p}`),
      ];
      const pick = (skipOccupied: boolean): Connection | null => {
        for (const h of handles) {
          if (skipOccupied && occupied.has(h)) continue;
          const conn: Connection = {
            source: drag.fromNodeId,
            sourceHandle: drag.fromHandle,
            target: targetNode.id,
            targetHandle: h,
          };
          if (isValidConnection(conn)) return conn;
        }
        return null;
      };
      return pick(true) ?? pick(false);
    }

    // Dragged off an INPUT → land on one of the target's outputs.
    const handles: string[] = [
      ...(targetNode.data.primaryOutput ? ["out:primary"] : []),
      ...targetNode.data.auxOutputs
        .filter((a) => !a.disabled)
        .map((a) => `out:aux:${a.name}`),
    ];
    for (const h of handles) {
      const conn: Connection = {
        source: targetNode.id,
        sourceHandle: h,
        target: drag.fromNodeId,
        targetHandle: drag.fromHandle,
      };
      if (isValidConnection(conn)) return conn;
    }
    return null;
  };

  // Node-body drag: wire the origin's first output that connects into the
  // target's first accepting socket. Tries the origin's outputs in order
  // (primary first) and reuses buildShiftDropConnection for the target side.
  const buildNodeConnection = (
    originNode: Node<NodeDataPayload>,
    targetNode: Node<NodeDataPayload>
  ): Connection | null => {
    const outHandles = [
      ...(originNode.data.primaryOutput ? ["out:primary"] : []),
      ...originNode.data.auxOutputs
        .filter((a) => !a.disabled)
        .map((a) => `out:aux:${a.name}`),
    ];
    for (const h of outHandles) {
      const conn = buildShiftDropConnection(
        { fromNodeId: originNode.id, fromHandle: h, handleType: "source" },
        targetNode
      );
      if (conn) return conn;
    }
    return null;
  };

  // Refreshed every render so the mount-once pointerdown interceptor resolves
  // the drop against the live graph (nodes/edges) without re-subscribing.
  processNodeDropRef.current = (originId, clientX, clientY) => {
    const origin = nodes.find((n) => n.id === originId);
    if (!origin) return;
    const targetNode = nodeAtClientPoint(clientX, clientY, originId);
    if (!targetNode) return;
    const conn = buildNodeConnection(origin, targetNode);
    if (conn) onConnect(conn);
  };

  // ReactFlow forwards the node drag/mouse handlers into EVERY NodeWrapper,
  // so an identity change re-renders all nodes on the canvas. Their bodies
  // capture per-render helpers (findSpliceCandidate reads nodes/edges), so
  // they can't be useCallback'd directly — instead the bodies live in refs
  // refreshed after every commit and ReactFlow gets never-changing shells.
  // (Effect-refreshed, not render-assigned: pointer events always arrive
  // after the commit's effects have run, so the bodies are never stale.
  // No dep array — refreshes every commit by design.)
  useEffect(() => {
  nodeDragStartRef.current = (e, node) => {
    // Alt = duplicate-on-drag (the clone takes the node's edges; React Flow
    // keeps dragging the original as a fresh disconnected copy).
    // Cmd/Ctrl = detach — strip every edge from this node. Combinable.
    if (e.altKey && onDuplicateOnDrag) {
      onDuplicateOnDrag(node.id);
    }
    if ((e.metaKey || e.ctrlKey) && onDetachNode) {
      onDetachNode(node.id, findDetachBridge(node.id));
    }
    cmdDragRef.current = e.metaKey || e.ctrlKey;
    // Dragging an Iterate shell drags its whole zone
    // (071926_iterate-zone-view.md): snapshot the shell's start plus
    // every member's start; the drag handler re-derives each member as
    // start + delta (absolute, no per-tick drift).
    if ((node.data as NodeDataPayload).defType === ITERATE_TYPE) {
      const members = new Map<string, { x: number; y: number }>();
      const memberOf = (id: string | undefined): boolean => {
        for (let cur = id, hops = 0; cur && hops < nodes.length; hops++) {
          if (cur === node.id) return true;
          cur = (
            nodes.find((n) => n.id === cur)?.data as
              | NodeDataPayload
              | undefined
          )?.parentId;
        }
        return false;
      };
      for (const n of nodes) {
        if (n.id !== node.id && memberOf((n.data as NodeDataPayload).parentId)) {
          members.set(n.id, { x: n.position.x, y: n.position.y });
        }
      }
      zoneDragRef.current = {
        shellId: node.id,
        start: { x: node.position.x, y: node.position.y },
        members,
      };
    } else if ((node.data as NodeDataPayload).defType === FRAME_TYPE) {
      // Dragging a frame (edge bands / label — its only drag handles)
      // moves everything inside: same snapshot-and-replay as the Iterate
      // shell above, with membership from data.frameId instead of
      // parentId (073026_node-cosmetics-and-frames.md).
      const members = new Map<string, { x: number; y: number }>();
      for (const mid of collectFrameMemberIds(
        nodes as Node<NodeDataPayload>[],
        node.id
      )) {
        const m = nodes.find((n) => n.id === mid);
        if (m) members.set(mid, { x: m.position.x, y: m.position.y });
      }
      zoneDragRef.current = {
        shellId: node.id,
        start: { x: node.position.x, y: node.position.y },
        members,
      };
    } else {
      zoneDragRef.current = null;
    }
    setSpliceCandidate(null);
  };
  nodeDragRef.current = (_e, node, dragged) => {
    // Shell drag → move the members with it. Members that are part of
    // the drag selection already move under React Flow — skip those.
    const zone = zoneDragRef.current;
    if (zone && node.id === zone.shellId) {
      const dx = node.position.x - zone.start.x;
      const dy = node.position.y - zone.start.y;
      const draggedIds = new Set(dragged.map((d) => d.id));
      const changes: NodeChange<RfNode>[] = [];
      for (const [id, start] of zone.members) {
        if (draggedIds.has(id)) continue;
        changes.push({
          id,
          type: "position",
          position: { x: start.x + dx, y: start.y + dy },
        });
      }
      if (changes.length > 0) onNodesChange(changes);
      // A shell drag is a zone move, never a splice.
      if (spliceRef.current) setSpliceCandidate(null);
      return;
    }
    // Only splice-highlight on a single-node drag. Marquee drags that move
    // many nodes at once shouldn't suddenly splice one into a random edge.
    if (dragged.length !== 1) {
      if (spliceRef.current) setSpliceCandidate(null);
      return;
    }
    const found = findSpliceCandidate(node.id);
    const prev = spliceRef.current;
    if (!found) {
      if (prev) setSpliceCandidate(null);
      return;
    }
    if (
      !prev ||
      prev.edgeId !== found.edgeId ||
      prev.inputName !== found.inputName ||
      prev.outputHandle !== found.outputHandle
    ) {
      setSpliceCandidate(found);
    }
  };
  nodeDragStopRef.current = (_e, node, dragged) => {
    zoneDragRef.current = null;
    // A shell never reparents by dragging (a zone inside a zone would be
    // a nested Iterate, which doesn't evaluate) — the zone just moves.
    // Frames likewise: dragging one moves it and its members, nothing else.
    if (
      (node.data as NodeDataPayload).defType === ITERATE_TYPE ||
      (node.data as NodeDataPayload).defType === FRAME_TYPE
    ) {
      setSpliceCandidate(null);
      return;
    }
    const candidate = spliceRef.current;
    setSpliceCandidate(null);
    if (candidate && dragged.length === 1) {
      onSpliceNode?.({
        nodeId: node.id,
        edgeId: candidate.edgeId,
        inputName: candidate.inputName,
        outputHandle: candidate.outputHandle,
      });
      return;
    }
    // Zone drop-to-reparent (071926_iterate-zone-view.md): landing a
    // single node's center inside an Iterate zone absorbs it into that
    // scope. Leaving is DELIBERATE: only a Cmd/Ctrl-drag that ends
    // outside the zone (rect computed WITHOUT the dragged node — the
    // union bbox would otherwise follow it, making exit impossible)
    // moves the node up to the shell's scope; a plain drag just
    // stretches the zone. Boundary nodes never move; multi-select drags
    // don't reparent.
    if (dragged.length !== 1) return;
    const data = node.data as NodeDataPayload;
    const isBoundary =
      data.defType === GROUP_INPUT_TYPE ||
      data.defType === GROUP_OUTPUT_TYPE ||
      data.defType === ITERATE_INPUT_TYPE;
    const cx = node.position.x + (node.measured?.width ?? 220) / 2;
    const cy = node.position.y + (node.measured?.height ?? 100) / 2;
    let reparented = false;
    if (!isBoundary && onReparentNode) {
      const zones = computeIterateZoneRects(
        nodes as Node<NodeDataPayload>[],
        node.id
      ).filter((z) => z.shellId !== node.id);
      // Innermost (smallest) zone containing the node's center.
      const hit = zones
        .filter(
          (z) =>
            cx >= z.bbox.x &&
            cx <= z.bbox.x + z.bbox.width &&
            cy >= z.bbox.y &&
            cy <= z.bbox.y + z.bbox.height
        )
        .sort(
          (a, b) => a.bbox.width * a.bbox.height - b.bbox.width * b.bbox.height
        )[0];
      if (hit && data.parentId !== hit.shellId) {
        onReparentNode(node.id, hit.shellId);
        reparented = true;
      } else if (!hit && data.parentId && cmdDragRef.current) {
        // Cmd-dragged clear of every zone: if it lives in one, take it
        // out (detach at drag start already stripped the wires that would
        // block this).
        const shell = nodes.find((n) => n.id === data.parentId);
        if (
          (shell?.data as NodeDataPayload | undefined)?.defType ===
          ITERATE_TYPE
        ) {
          onReparentNode(
            node.id,
            (shell!.data as NodeDataPayload).parentId
          );
          reparented = true;
        }
      }
    }
    // Frame membership (073026_node-cosmetics-and-frames.md): the same
    // drop-in / Cmd-drag-out grammar as Iterate zones, but it writes
    // data.frameId instead of reparenting, and boundary nodes may join
    // (framing a group's interior naturally includes its pillars).
    // Skipped when this drop just crossed an Iterate boundary —
    // membership is same-scope-siblings only and `data.parentId` in this
    // closure is stale after a reparent.
    if (reparented || !onSetNodeFrame) return;
    const frames = computeFrameRects(
      nodes as Node<NodeDataPayload>[],
      node.id
    ).filter((f) => f.parentId === data.parentId);
    const fHit = frames
      .filter(
        (f) =>
          cx >= f.bbox.x &&
          cx <= f.bbox.x + f.bbox.width &&
          cy >= f.bbox.y &&
          cy <= f.bbox.y + f.bbox.height
      )
      .sort(
        (a, b) => a.bbox.width * a.bbox.height - b.bbox.width * b.bbox.height
      )[0];
    if (fHit && data.frameId !== fHit.frameId) {
      onSetNodeFrame(node.id, fHit.frameId);
    } else if (!fHit && data.frameId && cmdDragRef.current) {
      onSetNodeFrame(node.id, undefined);
    }
  };
  nodeContextMenuRef.current = (e, node) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  };
  nodeDoubleClickRef.current = (_e, node) => {
    // Double-click a MIDI Editor node = open the viewport piano roll.
    if (
      onOpenMidiEditor &&
      (node.data as NodeDataPayload).defType === "midi-editor"
    ) {
      onOpenMidiEditor(node.id);
      return;
    }
    // Double-click a group or layer node = dive in (same as Tab).
    if (
      onDiveIntoGroup &&
      isEnterableScope((node.data as NodeDataPayload).defType)
    ) {
      onDiveIntoGroup(node.id);
    }
  };
  });

  return (
    <div
      ref={flowWrapperRef}
      data-shortcut-scope="node"
      style={{ width: "100%", height: "100%", position: "relative" }}
      onDragOver={(e) => {
        // Opt in for both OS file drags AND our custom thumbnail
        // drag from the Image Generate panel. Anything else (like
        // React Flow's internal node drags) keeps its default
        // behaviour.
        const types = e.dataTransfer.types;
        if (
          types.includes("Files") ||
          types.includes("application/x-toolbox-image-gen")
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const flowPos = screenToFlowPosition({
          x: e.clientX,
          y: e.clientY,
        });
        // Image-Generate thumbnail drop → spawn Image Source.
        const imgGen = e.dataTransfer.getData(
          "application/x-toolbox-image-gen"
        );
        if (imgGen && onAddImageNodeFromImageGen) {
          try {
            const payload = JSON.parse(imgGen) as {
              privatePath: string;
              format: string;
            };
            if (payload.privatePath) {
              e.preventDefault();
              onAddImageNodeFromImageGen(payload, flowPos);
              return;
            }
          } catch {
            // Malformed payload — fall through to file handling.
          }
        }
        // Asset drag from the Assets panel (font / folder media).
        const assetData = e.dataTransfer.getData("application/x-toolbox-asset");
        if (assetData && onAddAssetNode) {
          try {
            const payload = JSON.parse(assetData) as {
              source: string;
              kind: string;
              ref: string;
              name: string;
            };
            if (payload.ref) {
              e.preventDefault();
              onAddAssetNode(payload, flowPos);
              return;
            }
          } catch {
            // Malformed payload — fall through to file handling.
          }
        }
        // OS file drop.
        if (!onAddFileNode) return;
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;
        e.preventDefault();
        for (let i = 0; i < files.length; i++) {
          onAddFileNode(files[i], {
            x: flowPos.x + i * 28,
            y: flowPos.y + i * 28,
          });
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // Owned by the window-level keydown listener above so delete
        // works regardless of which DOM element has focus. Setting
        // null here disables React Flow's internal handler — the
        // window listener calls deleteElements (the same path React
        // Flow's handler uses), so no double-delete and no behavior
        // change beyond the focus fix.
        deleteKeyCode={null}
        onNodesChange={onNodesChange as (c: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (c: EdgeChange[]) => void}
        onConnect={onConnect}
        onEdgeDoubleClick={(event, edge) => {
          // Double-click a wire → drop a reroute node on it at the click
          // point (source → reroute → target). Reuses the same insertion
          // path as the Shift-drag gesture.
          if (!onCombineWires) return;
          event.stopPropagation();
          const pos = screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });
          onCombineWires([edge.id], [pos.x, pos.y]);
        }}
        onReconnect={(oldEdge, newConnection) => {
          // User dragged the edge end onto a different handle. Drop
          // the original edge and let onConnect produce the new one
          // — that path runs the same isValidConnection / type-
          // promotion logic we'd want for a fresh connection.
          reconnectSucceededRef.current = true;
          onEdgesChange([{ type: "remove", id: oldEdge.id }]);
          onConnect(newConnection);
        }}
        onConnectStart={(event, { nodeId, handleId, handleType }) => {
          // Record the source handle so onConnectEnd knows what to wire and
          // the ring effect knows a connection is live. Arm the ring right
          // away if Shift is already held ("hold Shift before you drag").
          // This fires for reconnects too — those carry the wire's anchored
          // end, which is exactly what we want to pull from. A fresh drag
          // (not a reconnect) drops any stale reconnect-edge reference.
          const isReconnect = reconnectOneShotRef.current;
          reconnectOneShotRef.current = false;
          if (!isReconnect) reconnectingEdgeRef.current = null;
          if (!nodeId || !handleId || !handleType) {
            connectDragRef.current = null;
            return;
          }
          connectDragRef.current = {
            fromNodeId: nodeId,
            fromHandle: handleId,
            handleType: handleType as "source" | "target",
          };
          const me = event as MouseEvent;
          const shift = !!me.shiftKey;
          shiftDownRef.current = shift;
          if (shift) {
            const x = typeof me.clientX === "number" ? me.clientX : lastCursorRef.current.x;
            const y = typeof me.clientY === "number" ? me.clientY : lastCursorRef.current.y;
            connectRingShownRef.current = true;
            setConnectRing({ x, y, overNode: false });
          }
        }}
        onReconnectStart={(_event, edge) => {
          reconnectSucceededRef.current = false;
          // Marks the onConnectStart that fires next as a reconnect and
          // remembers which wire is being re-routed (so a Shift-drop onto a
          // different node can remove it — see onConnectEnd).
          reconnectOneShotRef.current = true;
          reconnectingEdgeRef.current = edge;
        }}
        onReconnectEnd={(_event, oldEdge) => {
          // Drop on empty pane = detach. onReconnect didn't fire (precise
          // handle) and onConnectEnd's Shift-drop didn't claim it either, so
          // the success flag is still false — remove the edge.
          if (!reconnectSucceededRef.current) {
            onEdgesChange([{ type: "remove", id: oldEdge.id }]);
          }
          reconnectSucceededRef.current = false;
          reconnectingEdgeRef.current = null;
        }}
        onConnectEnd={(event, conn) => {
          // The gesture is over — tear down the ring and grab the source
          // handle we stashed at connect-start (whether this was a Shift-drag
          // is decided by the live Shift state at release).
          const drag = connectDragRef.current;
          connectDragRef.current = null;
          const shiftDrag = !!drag && shiftDownRef.current;
          hideConnectRing();

          // A precise handle drop already produced the edge via onConnect.
          if (conn?.toHandle) return;

          const ce = event as MouseEvent;
          const x = typeof ce.clientX === "number" ? ce.clientX : 0;
          const y = typeof ce.clientY === "number" ? ce.clientY : 0;

          // Shift-drop over a node body → land on its first accepting socket
          // (no need to hit the exact handle). Works both for a fresh wire
          // and for re-routing an existing one (reconnect drag). Only falls
          // through to the node-search popup when released on empty pane.
          if (shiftDrag && drag) {
            const targetNode = nodeAtClientPoint(x, y, drag.fromNodeId);
            if (targetNode) {
              const built = buildShiftDropConnection(drag, targetNode);
              if (built) {
                // Re-routing an existing wire: drop its old edge as we add
                // the new one, and flag the reconnect as handled so
                // onReconnectEnd doesn't also detach it. Mirrors the
                // precise-reconnect path (onReconnect above).
                const reEdge = reconnectingEdgeRef.current;
                if (reEdge) {
                  reconnectSucceededRef.current = true;
                  onEdgesChange([{ type: "remove", id: reEdge.id }]);
                }
                onConnect(built);
              }
              // Over a node (compatible or not) — the gesture is consumed;
              // don't open the search popup. If nothing accepted a reconnect
              // drag, onReconnectEnd still detaches the old wire.
              return;
            }
          }

          // If the wire was dropped on empty pane (toHandle is null on
          // the FinalConnectionState), pop the search so the user can
          // immediately browse a node to land the wire on. We also
          // stash the origin handle details so the picked node gets
          // auto-wired to it — from an output socket the new node
          // becomes the consumer; from an input socket it becomes the
          // producer.
          const flowPos = screenToFlowPosition({ x, y });
          onPanePointer?.(flowPos);
          let pendingWire: PendingWire | undefined;
          const fromHandle = conn?.fromHandle;
          const fromNode = conn?.fromNode as
            | { id: string }
            | null
            | undefined;
          if (fromHandle?.id && fromNode?.id) {
            const originNode = nodes.find((n) => n.id === fromNode.id);
            if (originNode && fromHandle.type === "target") {
              const tgtType = resolveTargetSocketType(originNode, fromHandle.id);
              if (tgtType) {
                pendingWire = {
                  kind: "into-target",
                  targetNodeId: fromNode.id,
                  targetHandle: fromHandle.id,
                  targetType: tgtType,
                };
              }
            } else if (originNode) {
              const srcType = resolveSourceSocketType(originNode, fromHandle.id);
              if (srcType) {
                pendingWire = {
                  kind: "from-source",
                  sourceNodeId: fromNode.id,
                  sourceHandle: fromHandle.id,
                  sourceType: srcType,
                };
              }
            }
          }
          setNodePopup({ x: x + 4, y: y + 4, pendingWire });
        }}
        isValidConnection={isValidConnection}
        // On touch, React Flow's default click-to-select on edges
        // sometimes loses to its own pan-on-drag handling — the
        // pointer-down is consumed before a select fires. Explicit
        // edge-click handler clears any other selection and selects
        // the tapped edge so the corner Delete button has something
        // to act on.
        onEdgeClick={(_e, edge) => {
          rfSetEdges((edges) =>
            edges.map((ed) =>
              ed.id === edge.id
                ? ed.selected
                  ? ed
                  : { ...ed, selected: true }
                : ed.selected
                  ? { ...ed, selected: false }
                  : ed
            )
          );
          rfSetNodes((nodes) =>
            nodes.map((n) => (n.selected ? { ...n, selected: false } : n))
          );
          onSelectNode(null);
        }}
        // Generous reconnect grab radius on touch so the user can
        // grab the end of a wire with a finger or pen tip and drag
        // it off the socket. Default is 10px which is too small for
        // a fingertip; 28 is comfortable without preempting clicks
        // on adjacent handles.
        reconnectRadius={touchActive ? 28 : 10}
        onSelectionChange={(sel) => {
          const first = sel.nodes[0];
          onSelectNode(first?.id ?? null);
        }}
        onNodeDragStart={stableNodeDragStart}
        onNodeDrag={stableNodeDrag}
        onNodeDragStop={stableNodeDragStop}
        onNodeContextMenu={stableNodeContextMenu}
        onNodeDoubleClick={stableNodeDoubleClick}
        onPaneContextMenu={(e) => {
          // Right-click on empty pane — close any open node menu so it
          // doesn't linger past its node.
          if (contextMenu) {
            (e as unknown as Event).preventDefault?.();
            closeContextMenu();
          }
        }}
        onPaneMouseMove={(e) => reportPane(e.clientX, e.clientY)}
        onPaneClick={(e) => {
          reportPane(e.clientX, e.clientY);
          closeContextMenu();
        }}
        // Figma-style viewport: two-finger trackpad scroll pans, pinch zooms,
        // drag on empty canvas draws a marquee selection. Cmd-scroll still
        // zooms via the default zoomActivationKeyCode. With a mouse, the wheel
        // zooms instead (panOnScroll off, zoomOnScroll on).
        panOnScroll={!mouseScroll}
        zoomOnScroll={mouseScroll}
        // Mouse: middle button pans, left button draws marquee
        //        (selectionOnDrag).
        // Touch / pen: single-finger drag pans the canvas — marquee
        //        is unreachable without a hover modifier and would
        //        otherwise hijack the most natural touch gesture.
        panOnDrag={touchActive ? [0, 1] : [1]}
        selectionOnDrag={!touchActive}
        selectionMode={SelectionMode.Partial}
        // Shift adds to selection alongside the platform default
        // (Meta on Mac, Control on Windows). React Flow accepts an
        // array — listing all three covers every keyboard combo
        // users reach for. We also null out `selectionKeyCode`
        // (default "Shift", used to start a marquee drag) so Shift
        // is unambiguously the multi-select modifier — marquee
        // already works on plain drag via `selectionOnDrag`.
        multiSelectionKeyCode={["Shift", "Meta", "Control"]}
        selectionKeyCode={null}
        // A pane remounting with a parked camera (kind round-trip /
        // docs nav — paneCameraStash) restores it and skips the fit.
        fitView={!stashedCamera}
        defaultViewport={stashedCamera}
        // Cap the initial fit so a project with a single small node (a fresh
        // "Layer 1", or an opened project whose graph is tiny) doesn't get
        // blown up toward maxZoom to fill the viewport — that reads as "opened
        // way too zoomed in". maxZoom 1 keeps nodes at natural size or smaller;
        // fitView still zooms *out* freely to frame large graphs. Padding
        // leaves a little breathing room around the framed content.
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        // Open up the zoom + pan envelope. Defaults are minZoom 0.5
        // and a tight translateExtent that walls off the empty area
        // around the graph; both feel cramped for the kind of large
        // multi-stage graphs this editor encourages. minZoom 0.05
        // lets the user zoom out far enough to see a sprawling graph
        // at a glance, and a ±100k translate extent is effectively
        // "infinite" canvas without disabling bounds entirely (which
        // would let fitView misbehave on empty graphs).
        minZoom={0.05}
        maxZoom={4}
        translateExtent={[
          [-100000, -100000],
          [100000, 100000],
        ]}
        proOptions={{ hideAttribution: true }}
        // Follows the editor theme rather than being pinned to "dark".
        // React Flow keys its own palette off this (.react-flow.dark), and
        // leaving it hardcoded left the whole pane on xyflow's #141414 while
        // every panel around it went light. The pane fill and dot colour are
        // pinned to our ramp in globals.css regardless.
        colorMode={themeMode}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <SimulationZoneUnderlay nodes={nodes} />
        <IterateZoneUnderlay nodes={nodes} />
        {viewportOverlay && <ViewportPortal>{viewportOverlay}</ViewportPortal>}
      </ReactFlow>

      {/* Apple Pencil hover ring. Tracks the pen tip so the user
          gets a familiar Procreate-style hover affordance. Purely
          visual — the actual add-node trigger is the corner button
          below. Render-suppressed when the search popup is open so
          a stray ring doesn't sit on top of the menu. */}
      {penHover && !nodePopup && (
        <PenHoverCursor
          x={penHover.x}
          y={penHover.y}
          wrapper={flowWrapperRef.current}
        />
      )}

      {/* Shift-drag fuzzy-connect ring. Fades in at the cursor while a wire
          is being pulled with Shift held, and brightens over a droppable
          node. Purely visual (pointer-events: none) — the actual landing is
          done in onConnectEnd. */}
      {connectRing && (
        <ConnectDropRing
          x={connectRing.x}
          y={connectRing.y}
          over={connectRing.overNode}
          wrapper={flowWrapperRef.current}
        />
      )}

      {/* Shift-drag-from-node line + ring. The straight line runs from the
          origin node's first output to the cursor (React Flow draws no
          connection line here since this gesture bypasses its connection
          system), and the same ring brightens over a droppable node. */}
      {nodeConnect && (
        <>
          <NodeConnectLine
            x1={nodeConnect.originX}
            y1={nodeConnect.originY}
            x2={nodeConnect.x}
            y2={nodeConnect.y}
            over={nodeConnect.overNode}
            wrapper={flowWrapperRef.current}
          />
          <ConnectDropRing
            x={nodeConnect.x}
            y={nodeConnect.y}
            over={nodeConnect.overNode}
            wrapper={flowWrapperRef.current}
          />
        </>
      )}

      {/* Fixed corner action row — pinned upper-right of the editor.
          Designed for touch / pencil where the equivalent gestures
          (Shift+A, Backspace) aren't reachable without a hardware
          keyboard. The "+" opens the node search at the pen's last
          hover position (or near the button on mouse). The trash
          deletes whatever's selected (nodes or edges); falls back
          to no-op when nothing is selected. */}
      <div
        style={{
          position: "absolute",
          top: 5,
          right: 5,
          display: "flex",
          flexDirection: "row",
          gap: 4,
          zIndex: 30,
        }}
      >
        <CornerActionButton
          title="Add node"
          onTap={() => {
            // Prefer the most recent pen-hover position (pen users
            // expect the popup at their tip); fall back to the upper
            // left of the pane on mouse / touch — the popup isn't
            // edge-clamped, so anchoring it under the (right-pinned)
            // button would push it off-screen.
            const wrapper = flowWrapperRef.current;
            const wrapperRect = wrapper?.getBoundingClientRect();
            let x: number;
            let y: number;
            if (penHover) {
              x = penHover.x;
              y = penHover.y;
            } else if (wrapperRect) {
              x = wrapperRect.left + 36;
              y = wrapperRect.top + 36;
            } else {
              const w = panelWin ?? window;
              x = w.innerWidth / 2;
              y = w.innerHeight / 2;
            }
            const flowPos = screenToFlowPosition({ x, y });
            onPanePointer?.(flowPos);
            setNodePopup({ x: x + 4, y: y + 4 });
          }}
        >
          +
        </CornerActionButton>
        <CornerActionButton
          title="Delete selected"
          onTap={() => {
            // Mirror the keyboard Delete: remove every selected
            // node and edge in one go. deleteElements handles
            // dependent-edge cleanup and fires the same
            // onNodesChange / onEdgesChange callbacks the keyboard
            // path uses, so undo history snapshots the same way.
            const selectedNodes = rfGetNodes().filter((n) => n.selected);
            const selectedEdges = rfGetEdges().filter((e) => e.selected);
            if (selectedNodes.length === 0 && selectedEdges.length === 0) {
              return;
            }
            deleteElements({
              nodes: selectedNodes.map((n) => ({ id: n.id })),
              edges: selectedEdges.map((e) => ({ id: e.id })),
            });
          }}
        >
          {/* Trash icon — single-stroke SVG sized to match the "+"
              optical weight. Inline so we don't pull a new icon dep
              for one glyph. */}
          <svg
            width={11}
            height={11}
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 4 L11.5 4" />
            <path d="M5 4 L5 2.5 L9 2.5 L9 4" />
            <path d="M3.5 4 L4 12 L10 12 L10.5 4" />
            <path d="M6 6.5 L6 9.5" />
            <path d="M8 6.5 L8 9.5" />
          </svg>
        </CornerActionButton>
      </div>

      {/* Scope breadcrumbs — root crumb is the project name, then one
          crumb per group in the current path. Click any crumb to jump
          to that scope. Row height matches the corner action buttons
          so both sit on the same optical baseline from top: 5. */}
      {breadcrumbs && breadcrumbs.length > 0 && onNavigateScope && (
        <div
          style={{
            position: "absolute",
            top: 5,
            left: 10,
            display: "flex",
            alignItems: "center",
            gap: 4,
            zIndex: 30,
            height: 22,
          }}
        >
          {breadcrumbs.map((crumb, i) => {
            const isCurrent = i === breadcrumbs.length - 1;
            return (
              <Fragment key={crumb.id ?? "root"}>
                {i > 0 && (
                  // Chevron separator between crumbs.
                  <svg
                    width={8}
                    height={8}
                    viewBox="0 0 9 9"
                    fill="none"
                    stroke="var(--tb-n-10)"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <path d="M3 1.5 L6 4.5 L3 7.5" />
                  </svg>
                )}
                <BreadcrumbChip
                  label={crumb.name}
                  current={isCurrent}
                  onTap={() => {
                    if (isCurrent) return;
                    if (crumb.id === PROJECT_CRUMB_ID) onOpenProject?.();
                    else onNavigateScope(crumb.id);
                  }}
                />
              </Fragment>
            );
          })}
        </div>
      )}

      {nodePopup && (
        <NodeSearchPopup
          x={nodePopup.x}
          y={nodePopup.y}
          atRoot={atRoot}
          // Thread the pending-wire context through the popup so the
          // parent's onAddNode can auto-connect the new node back to
          // the source handle the user dragged from.
          onAdd={(type) => {
            const addedId = onAddNode(type, nodePopup.pendingWire);
            // Single plain nodes come back grabbed, ready to place.
            if (addedId) pendingGAfterAddRef.current = addedId;
          }}
          onClose={closeNodePopup}
        />
      )}
      <WireActionOverlay
        edges={edges}
        onCombine={handleCombine}
        onCut={handleCut}
        flowEl={flowWrapperRef.current}
      />

      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          {...(() => {
            // Tint / bold (073026): Blender's rule — right-clicking a node
            // that's part of the selection styles the whole selection,
            // otherwise just the clicked node. Reroutes have no chrome to
            // style, so the rows hide for them.
            if (!onStyleNodes) return {};
            const clicked = nodes.find((n) => n.id === contextMenu.nodeId);
            if (!clicked || clicked.data.defType === REROUTE_TYPE) return {};
            const targets = clicked.selected
              ? nodes.filter((n) => n.selected && !n.hidden).map((n) => n.id)
              : [clicked.id];
            return {
              tint: clicked.data.tint ?? null,
              bold: !!clicked.data.bold,
              onSetTint: (hex: string | null) =>
                onStyleNodes(targets, { tint: hex }),
              onToggleBold: () =>
                onStyleNodes(targets, { bold: !clicked.data.bold }),
            };
          })()}
          onCopy={
            onCopyNodes
              ? () => {
                  onCopyNodes();
                }
              : undefined
          }
          onPaste={
            onPasteNodes
              ? () => {
                  onPasteNodes();
                }
              : undefined
          }
          onDuplicate={
            onDuplicateNode
              ? () => {
                  onDuplicateNode(contextMenu.nodeId);
                }
              : undefined
          }
          onSaveAsPreset={(() => {
            if (!onSaveNodeAsPreset) return undefined;
            const d = nodes.find((n) => n.id === contextMenu.nodeId)?.data;
            if (!d) return undefined;
            // Structural chrome isn't a meaningful standalone preset:
            // reroutes/frames are wiring cosmetics, layer shells only live
            // in the root chain, boundary nodes only inside their shells.
            // Group / Iterate shells ARE offered — the parent expands the
            // capture with their descendants so the interior travels.
            if (
              d.defType === REROUTE_TYPE ||
              d.defType === FRAME_TYPE ||
              d.defType === LAYER_TYPE ||
              d.defType === GROUP_INPUT_TYPE ||
              d.defType === GROUP_OUTPUT_TYPE ||
              d.defType === ITERATE_INPUT_TYPE
            )
              return undefined;
            return () => onSaveNodeAsPreset(contextMenu.nodeId);
          })()}
          onDetach={
            onDetachNode
              ? () => {
                  onDetachNode(
                    contextMenu.nodeId,
                    findDetachBridge(contextMenu.nodeId)
                  );
                }
              : undefined
          }
          onEditWithAI={
            onEditWithAINode &&
            nodes.find((n) => n.id === contextMenu.nodeId)?.data.defType ===
              GROUP_TYPE
              ? () => onEditWithAINode(contextMenu.nodeId)
              : undefined
          }
          onMakeEditable={(() => {
            if (!onMakeEditableNode) return undefined;
            const d = nodes.find((n) => n.id === contextMenu.nodeId)?.data;
            if (!d) return undefined;
            // Spline Draw is already editable; group/layer shells dissolve
            // at flatten (no eval-cache entry to bake), reroutes likewise.
            if (
              d.defType === "spline-draw" ||
              d.defType === GROUP_TYPE ||
              d.defType === LAYER_TYPE ||
              d.defType === REROUTE_TYPE
            )
              return undefined;
            const hasSpline =
              d.primaryOutput === "spline" ||
              d.auxOutputs.some((a) => a.type === "spline" && !a.disabled);
            return hasSpline
              ? () => onMakeEditableNode(contextMenu.nodeId)
              : undefined;
          })()}
        />
      )}
    </div>
  );
}

function NodeContextMenu({
  x,
  y,
  onClose,
  onCopy,
  onPaste,
  onDuplicate,
  onSaveAsPreset,
  onDetach,
  onEditWithAI,
  onMakeEditable,
  tint,
  bold,
  onSetTint,
  onToggleBold,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onDuplicate?: () => void;
  onSaveAsPreset?: () => void;
  onDetach?: () => void;
  onEditWithAI?: () => void;
  onMakeEditable?: () => void;
  // Cosmetic styling (073026): current values of the clicked node, shown
  // as the checked swatch / Bold check. Absent handlers hide the rows.
  tint?: string | null;
  bold?: boolean;
  onSetTint?: (hex: string | null) => void;
  onToggleBold?: () => void;
}) {
  const panelWin = usePanelWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // Presses INSIDE the menu must not close it: this capture listener
      // fires before the item's own events, and closing here unmounts the
      // button between mousedown and mouseup — its onClick never fires
      // (every menu action was silently dead before this check). Same
      // containment rule as VersionMenu / the param-control popovers;
      // the item's onClick calls onClose itself after running.
      if (menuRef.current?.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Any click outside closes. Use capture so it fires before other
    // handlers potentially consume the event.
    const win = panelWin ?? window;
    win.addEventListener("mousedown", onDown, true);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown, true);
      win.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items: Array<{
    label: string;
    shortcut?: string;
    onClick?: () => void;
  }> = [
    ...(onEditWithAI ? [{ label: "✦ Edit with AI", onClick: onEditWithAI }] : []),
    // Only offered on nodes with a spline-typed output (gating at the call
    // site) — bakes the evaluated spline into an editable Spline Draw node.
    ...(onMakeEditable
      ? [{ label: "Make Editable", onClick: onMakeEditable }]
      : []),
    { label: "Copy", shortcut: "⌘C", onClick: onCopy },
    { label: "Paste", shortcut: "⌘V", onClick: onPaste },
    { label: "Duplicate", onClick: onDuplicate },
    // Only offered on nodes that make sense standalone (gating at the
    // call site) — saves the node as-is into the user's preset list.
    ...(onSaveAsPreset
      ? [{ label: "Save as Preset…", onClick: onSaveAsPreset }]
      : []),
    { label: "Detach", shortcut: "⌘-drag", onClick: onDetach },
    // Bold outline toggle — check shows the clicked node's current state.
    ...(onToggleBold
      ? [{ label: "Bold", shortcut: bold ? "✓" : undefined, onClick: onToggleBold }]
      : []),
  ];

  return (
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: 180,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 4,
        zIndex: 2000,
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        userSelect: "none",
      }}
    >
      {onSetTint && (
        <div
          style={{
            display: "flex",
            gap: 5,
            alignItems: "center",
            padding: "6px 10px",
            borderBottom: "1px solid var(--tb-n-7)",
            marginBottom: 4,
          }}
        >
          {NODE_TINTS.map((hex) => (
            <button
              key={hex}
              title="Tint node"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSetTint(hex);
                onClose();
              }}
              style={{
                width: 15,
                height: 15,
                borderRadius: 8,
                padding: 0,
                cursor: "pointer",
                background: hex,
                border:
                  tint === hex
                    ? "2px solid var(--tb-n-16)"
                    : "1px solid color-mix(in srgb, var(--tb-lift) 18%, transparent)",
              }}
            />
          ))}
          <button
            title="Clear tint"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSetTint(null);
              onClose();
            }}
            style={{
              width: 15,
              height: 15,
              borderRadius: 8,
              padding: 0,
              cursor: "pointer",
              background: "transparent",
              border: "1px solid var(--tb-n-10)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* diagonal "none" slash */}
            <span
              style={{
                position: "absolute",
                left: -2,
                right: -2,
                top: "50%",
                height: 1,
                background: "var(--tb-n-11)",
                transform: "rotate(-45deg)",
              }}
            />
          </button>
        </div>
      )}
      {items.map((it, i) => {
        const disabled = !it.onClick;
        return (
          <button
            key={i}
            disabled={disabled}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (disabled) return;
              it.onClick?.();
              onClose();
            }}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              width: "100%",
              padding: "4px 10px",
              background: "transparent",
              border: "none",
              color: disabled ? "var(--tb-n-10)" : "var(--tb-n-16)",
              textAlign: "left",
              fontFamily: "inherit",
              fontSize: "inherit",
              cursor: disabled ? "not-allowed" : "default",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => {
              if (!disabled)
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--tb-a-blue-900)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "transparent";
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && (
              <span
                style={{
                  color: disabled ? "var(--tb-n-9)" : "var(--tb-n-11)",
                  fontSize: 10,
                }}
              >
                {it.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function resolveSourceSocketType(
  node: Node<NodeDataPayload>,
  handle: string | null | undefined
): string | null {
  if (!handle) return null;
  if (handle === "out:primary") return node.data.primaryOutput ?? null;
  if (handle.startsWith("out:aux:")) {
    const name = handle.slice("out:aux:".length);
    return node.data.auxOutputs.find((a) => a.name === name)?.type ?? null;
  }
  return null;
}

function resolveTargetSocketType(
  node: Node<NodeDataPayload>,
  handle: string | null | undefined
): string | null {
  if (!handle) return null;
  const parsed = parseTargetHandleKind(handle);
  if (!parsed) return null;
  if (parsed.kind === "input") {
    return node.data.inputs.find((i) => i.name === parsed.name)?.type ?? null;
  }
  // Exposed-param sockets — look up the def to find the underlying param's
  // ParamType and map it to its driving SocketType. Virtual ramp-stop
  // names (ramp_c/a/p:<param>:<stopId>) type by field: vec4 for color,
  // scalar for alpha/position.
  const def = getNodeDef(node.data.defType);
  if (!def) return null;
  const rk = parseRampParamKey(parsed.name);
  if (rk) {
    const rampParam = def.params.find(
      (x) => x.name === rk.paramName && x.type === "color_ramp"
    );
    return rampParam ? rampFieldSocketType(rk.field) : null;
  }
  const p = def.params.find((x) => x.name === parsed.name);
  if (!p) return null;
  return paramSocketType(p.type);
}

// Square chrome button used by the corner action stack. Same
// background / border treatment as the rest of the editor's chrome
// so the buttons disappear into the surface but are tappable on
// touch. Stops pointer events from reaching React Flow's gesture
// system (which would otherwise interpret the tap as the start of
// a marquee or pan).
// One rounded-rect crumb in the scope trail. The current scope is the
// last crumb — rendered brighter and inert; ancestors are clickable.
function BreadcrumbChip({
  label,
  current,
  onTap,
}: {
  label: string;
  current: boolean;
  onTap: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={current ? undefined : `Go to ${label}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onTap();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 18,
        maxWidth: 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        borderRadius: 999,
        padding: "0 8px",
        background: current ? "var(--tb-n-7)" : hover ? "var(--tb-n-7)" : "var(--tb-n-4)",
        border: `1px solid ${
          current ? "var(--tb-n-10)" : hover ? "var(--tb-n-10)" : "var(--tb-n-9)"
        }`,
        color: current ? "var(--tb-n-16)" : hover ? "var(--tb-n-16)" : "var(--tb-n-12)",
        fontFamily: "var(--ui-font)",
        fontSize: 10,
        lineHeight: "16px",
        cursor: current ? "default" : "pointer",
        touchAction: "manipulation",
        userSelect: "none",
        transition: "background 90ms, border-color 90ms, color 90ms",
      }}
    >
      {label}
    </button>
  );
}

function CornerActionButton({
  title,
  onTap,
  children,
}: {
  title: string;
  onTap: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onTap();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        background: hover ? "var(--tb-n-7)" : "var(--tb-n-4)",
        border: `1px solid ${hover ? "var(--tb-n-10)" : "var(--tb-n-9)"}`,
        color: hover ? "var(--tb-n-16)" : "var(--tb-n-12)",
        fontFamily: "var(--ui-font)",
        fontSize: 15,
        lineHeight: 1,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "manipulation",
        userSelect: "none",
        padding: 0,
        transition: "background 90ms, border-color 90ms, color 90ms",
      }}
    >
      {children}
    </button>
  );
}

// Floating Apple Pencil hover cursor — a small ring at the pen tip.
// Purely visual (pointer-events: none) — the actual add-node trigger
// is the fixed "+" button in the upper-right of the editor pane,
// which competes less with React Flow's gesture handling.
//
// Mounts inside the node-editor wrapper (which is position: relative)
// and translates client coords into wrapper-relative coords so the
// indicator stays glued to the pen even when the wrapper isn't at
// (0, 0) of the page (split view, right panel widths, etc.).
function PenHoverCursor({
  x,
  y,
  wrapper,
}: {
  x: number;
  y: number;
  wrapper: HTMLDivElement | null;
}) {
  if (!wrapper) return null;
  const rect = wrapper.getBoundingClientRect();
  const localX = x - rect.left;
  const localY = y - rect.top;
  return (
    <div
      style={{
        position: "absolute",
        left: localX,
        top: localY,
        width: 18,
        height: 18,
        marginLeft: -9,
        marginTop: -9,
        borderRadius: "50%",
        border: "1.5px solid color-mix(in srgb, var(--tb-lift) 85%, transparent)",
        background: "color-mix(in srgb, var(--tb-lift) 8%, transparent)",
        pointerEvents: "none",
        zIndex: 60,
      }}
    />
  );
}

// Shift-drag fuzzy-connect ring. A blue circle glued to the cursor while a
// wire is being pulled with Shift held: dim by default, brighter + glowing
// while it's over a droppable node (so the user can see the drop will land).
// Fades in on mount (rAF flip so the opacity transition runs) and grows /
// brightens on the `over` state. Purely visual — pointer-events: none so it
// never intercepts the elementFromPoint node probe underneath it.
function ConnectDropRing({
  x,
  y,
  over,
  wrapper,
}: {
  x: number;
  y: number;
  over: boolean;
  wrapper: HTMLDivElement | null;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (!wrapper) return null;
  const rect = wrapper.getBoundingClientRect();
  const localX = x - rect.left;
  const localY = y - rect.top;
  const size = over ? 48 : 40;
  return (
    <div
      style={{
        position: "absolute",
        left: localX,
        top: localY,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: "50%",
        border: `2px solid ${over ? "var(--tb-a-blue-300)" : "color-mix(in srgb, var(--tb-a-blue-400) 75%, transparent)"}`,
        background: over ? "color-mix(in srgb, var(--tb-a-blue-400) 18%, transparent)" : "color-mix(in srgb, var(--tb-a-blue-400) 7%, transparent)",
        boxShadow: over ? "0 0 14px 2px rgba(96, 165, 250, 0.7)" : "none",
        opacity: shown ? 1 : 0,
        transition:
          "opacity 120ms ease, width 90ms ease, height 90ms ease, margin 90ms ease, background 90ms ease, border-color 90ms ease, box-shadow 90ms ease",
        pointerEvents: "none",
        zIndex: 55,
      }}
    />
  );
}

// Straight wire preview for the Shift-drag-from-node gesture: origin output →
// cursor. A full-wrapper SVG overlay (pointer-events: none so it never blocks
// the elementFromPoint node probe); coordinates are wrapper-local. Brightens
// to match the ring while the cursor is over a droppable node.
function NodeConnectLine({
  x1,
  y1,
  x2,
  y2,
  over,
  wrapper,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  over: boolean;
  wrapper: HTMLDivElement | null;
}) {
  if (!wrapper) return null;
  const rect = wrapper.getBoundingClientRect();
  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 54,
        overflow: "visible",
      }}
    >
      <line
        x1={x1 - rect.left}
        y1={y1 - rect.top}
        x2={x2 - rect.left}
        y2={y2 - rect.top}
        stroke={over ? "var(--tb-a-blue-300)" : "color-mix(in srgb, var(--tb-a-blue-400) 85%, transparent)"}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}


export default memo(NodeEditor);
