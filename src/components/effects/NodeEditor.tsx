"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  useReactFlow,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EffectNode from "./EffectNode";
import JunctionEdge from "./JunctionEdge";
import WireActionOverlay from "./WireActionOverlay";
import NodeSearchPopup from "./NodeSearchPopup";
import SimulationZoneUnderlay from "./SimulationZoneUnderlay";
import { WaypointContext } from "./waypoint-context";
import { getNodeDef } from "@/engine/registry";
import {
  defaultBezierCps,
  handleCenter,
  sampleCubic,
  type Pt,
} from "@/engine/wire-geometry";
import { paramSocketType, parseTargetHandleKind } from "@/state/graph";
import type { NodeDataPayload } from "@/state/graph";

interface Props {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<NodeDataPayload>>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onSelectNode: (id: string | null) => void;
  onAddNode: (
    type: string,
    pendingWire?: {
      sourceNodeId: string;
      sourceHandle: string;
      sourceType: string;
    }
  ) => void;
  // Fires while the cursor is over the flow pane (not over nodes or menus).
  // The parent uses the latest value to seed `onAddNode`'s drop position.
  onPanePointer?: (pos: { x: number; y: number }) => void;
  // Modifier-drag + clipboard actions. All optional; NodeEditor hides the
  // features it can't perform.
  onDuplicateOnDrag?: (nodeId: string) => void;
  onDetachNode?: (nodeId: string) => void;
  onDuplicateNode?: (nodeId: string) => void;
  onDuplicateSelection?: () => void;
  onCopyNodes?: () => void;
  onPasteNodes?: () => void;
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
  // Wire-gesture actions. `onCombineWires` is called when a shift-drag
  // crosses ≥2 edges sharing a source; the caller is expected to stamp a
  // junction waypoint on each of the listed edges. `onCutWires` is called
  // with every edge id that an alt-drag crossed.
  onCombineWires?: (
    edgeIds: string[],
    midpointFlow: [number, number]
  ) => void;
  onCutWires?: (edgeIds: string[]) => void;
  // Waypoint drag on an existing junction dot. `start` pushes undo once
  // per gesture; `move` fires on every pointermove and the parent is
  // expected to move every edge whose waypoint sits near the dragged one
  // (cluster lookup by proximity).
  onWaypointDragStart?: (edgeId: string) => void;
  onWaypointDrag?: (edgeId: string, newFlowPos: [number, number]) => void;
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
}

export default function NodeEditor({
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
  onDuplicateNode,
  onDuplicateSelection,
  onCopyNodes,
  onPasteNodes,
  onAddFileNode,
  onAddImageNodeFromImageGen,
  onCombineWires,
  onCutWires,
  onWaypointDragStart,
  onWaypointDrag,
  onSpliceNode,
  viewportOverlay,
}: Props) {
  const nodeTypes = useMemo(() => ({ effect: EffectNode }), []);
  // Register JunctionEdge under the default edge type so every edge —
  // including ones that predate waypoints — flows through it. The
  // component renders identically to React Flow's default bezier when no
  // waypoint is set, so there's no visual change for unjoined edges.
  const edgeTypes = useMemo(() => ({ default: JunctionEdge }), []);
  const {
    screenToFlowPosition,
    setNodes: rfSetNodes,
    setEdges: rfSetEdges,
    getNodes: rfGetNodes,
    getEdges: rfGetEdges,
    deleteElements,
  } = useReactFlow();
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);

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
        const under = document.elementFromPoint(mp.x, mp.y) as HTMLElement | null;
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rfGetNodes, rfGetEdges, deleteElements, onDuplicateSelection]);

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

  // Stable context value so JunctionEdge doesn't re-render on every
  // parent update. The inner handlers themselves are stable useCallbacks
  // from the parent, so memoizing here just avoids fresh object identity.
  const waypointActions = useMemo(
    () => ({
      onDragStart: (edgeId: string) => onWaypointDragStart?.(edgeId),
      onDrag: (edgeId: string, pos: [number, number]) =>
        onWaypointDrag?.(edgeId, pos),
    }),
    [onWaypointDragStart, onWaypointDrag]
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

  // Set by onReconnect when a drag-detach actually lands on a new
  // handle. onReconnectEnd consults this to decide whether to drop
  // the edge (drop on pane = detach) or leave the rewire alone.
  const reconnectSucceededRef = useRef(false);

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
  // Tracked globally so we can use the cursor position at the moment
  // of G keypress (which itself doesn't carry mouse coords).
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, exitGCommit]);

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
    const onMove = (e: MouseEvent) => {
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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, [gMove, screenToFlowPosition, onNodesChange, exitGCommit, exitGCancel]);

  // Coercion rules for splice compatibility. Same set `isValidConnection`
  // uses when the user draws a wire manually. Duplicated here because
  // isValidConnection is scoped to a single connection's Connection
  // object; the splice check needs to probe arbitrary (src, tgt) pairs
  // against hypothetical target nodes.
  const canCoerce = (
    src: string,
    tgt: string,
    targetDefType?: string,
    targetHandle?: string
  ): boolean => {
    if (src === tgt) return true;
    if (src === "mask" && tgt === "image") return true;
    if (src === "image" && tgt === "mask") return true;
    if (
      src === "scalar" &&
      (tgt === "vec2" || tgt === "vec3" || tgt === "vec4" || tgt === "uv")
    )
      return true;
    if (src === "uv" && tgt === "scalar" && targetDefType === "math")
      return true;
    if ((src === "image" || src === "mask") && tgt === "scalar") return true;
    if (src === "audio" && tgt === "scalar") return true;
    if (
      targetDefType === "copy-to-points" &&
      targetHandle === "in:instance" &&
      (src === "image" || src === "spline" || src === "points")
    ) {
      return true;
    }
    return false;
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
      const inputMatch = draggedNode.data.inputs.find((i) =>
        canCoerce(srcType!, i.type, draggedNode.data.defType, `in:${i.name}`)
      );
      if (!inputMatch) continue;

      // And an output that can reach tgtType?
      let outputHandleId: string | null = null;
      if (
        draggedNode.data.primaryOutput &&
        canCoerce(
          draggedNode.data.primaryOutput,
          tgtType,
          targetNode.data.defType,
          edge.targetHandle
        )
      ) {
        outputHandleId = "out:primary";
      }
      if (!outputHandleId) {
        for (const aux of draggedNode.data.auxOutputs) {
          if (aux.disabled) continue;
          if (
            canCoerce(
              aux.type,
              tgtType,
              targetNode.data.defType,
              edge.targetHandle
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

  // Node search popup. Opens at cursor on Shift+A (with cursor over
  // the flow) or when a wire drag is released on empty space. Closes
  // on Esc, outside click, or after picking a node.
  //
  // `pendingWire` is set when the popup opened from a wire drop on
  // empty pane — carries the source handle so the next created node
  // gets auto-wired from it. Cleared when the popup closes or when
  // opened via Shift+A.
  const [nodePopup, setNodePopup] = useState<{
    x: number;
    y: number;
    pendingWire?: {
      sourceNodeId: string;
      sourceHandle: string;
      sourceType: string;
    };
  } | null>(null);
  const closeNodePopup = () => setNodePopup(null);
  // Last global cursor position — needed for Shift+A, which arrives as
  // a keyboard event without any pointer coordinates.
  const lastCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastCursorRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

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
      // Seed the flow-coord pointer so the added node drops where the
      // popup opens (not where the mouse drifts while the popup is up).
      const flowPos = screenToFlowPosition({ x, y });
      onPanePointer?.(flowPos);
      setNodePopup({ x: x + 4, y: y + 4 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screenToFlowPosition, onPanePointer]);

  // Window-level `paste` listener. Replaces the old Cmd+V keydown path
  // so we can inspect the clipboard for files before deciding what to
  // do. Priority:
  //   - focused text field → let native paste happen, don't interfere
  //   - cursor not over flow → ignore
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
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onAddFileNode, onPasteNodes, screenToFlowPosition]);

  const isValidConnection = (c: Connection | Edge) => {
    if (!c.sourceHandle || !c.targetHandle) return false;
    const sourceNode = nodes.find((n) => n.id === c.source);
    const targetNode = nodes.find((n) => n.id === c.target);
    if (!sourceNode || !targetNode) return false;

    if (c.sourceHandle.startsWith("out:aux:")) {
      const auxName = c.sourceHandle.slice("out:aux:".length);
      const aux = sourceNode.data.auxOutputs.find((a) => a.name === auxName);
      if (aux?.disabled) return false;
    }

    const srcType = resolveSourceSocketType(sourceNode, c.sourceHandle);
    const tgtType = resolveTargetSocketType(targetNode, c.targetHandle);
    if (!srcType || !tgtType) return false;

    if (srcType === tgtType) return true;
    if (srcType === "mask" && tgtType === "image") return true;
    if (srcType === "image" && tgtType === "mask") return true;
    if (srcType === "scalar" && (tgtType === "vec2" || tgtType === "vec3" || tgtType === "vec4")) return true;
    // Scalar broadcasts into a UV socket as (s, s) — the compute function on
    // the target node is expected to handle both kinds.
    if (srcType === "scalar" && tgtType === "uv") return true;
    // Image / mask → scalar. The evaluator's coercion layer samples the
    // source's center pixel (R channel) at eval time. Lets users drive
    // any scalar input or exposed scalar param with noise, gradient, or
    // any other image source without an explicit sampling node.
    if ((srcType === "image" || srcType === "mask") && tgtType === "scalar") {
      return true;
    }
    // Audio → scalar. The coercion layer taps the element through a
    // WebAudio AnalyserNode and emits the RMS amplitude. Lets users
    // drive any scalar with audio level — Transform scale, Math op, etc.
    if (srcType === "audio" && tgtType === "scalar") {
      return true;
    }
    // Math nodes accept UV even while in scalar mode — onConnect flips the
    // mode param to uv so the socket becomes properly typed on next render.
    if (
      srcType === "uv" &&
      tgtType === "scalar" &&
      targetNode.data.defType === "math"
    ) {
      return true;
    }
    // Copy to Points accepts any of {image, spline, points} on its
    // `instance` socket regardless of current mode. onConnect flips
    // `mode` to match the incoming type so the socket retypes correctly.
    if (
      targetNode.data.defType === "copy-to-points" &&
      c.targetHandle === "in:instance" &&
      (srcType === "image" || srcType === "spline" || srcType === "points")
    ) {
      return true;
    }
    return false;
  };

  return (
    <WaypointContext.Provider value={waypointActions}>
    <div
      ref={flowWrapperRef}
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
        onReconnect={(oldEdge, newConnection) => {
          // User dragged the edge end onto a different handle. Drop
          // the original edge and let onConnect produce the new one
          // — that path runs the same isValidConnection / type-
          // promotion logic we'd want for a fresh connection.
          reconnectSucceededRef.current = true;
          onEdgesChange([{ type: "remove", id: oldEdge.id }]);
          onConnect(newConnection);
        }}
        onReconnectStart={() => {
          reconnectSucceededRef.current = false;
        }}
        onReconnectEnd={(_event, oldEdge) => {
          // Drop on empty pane = detach. onReconnect didn't fire,
          // so the success flag is still false — interpret as
          // "user wanted to disconnect" and remove the edge.
          if (!reconnectSucceededRef.current) {
            onEdgesChange([{ type: "remove", id: oldEdge.id }]);
          }
          reconnectSucceededRef.current = false;
        }}
        onConnectEnd={(event, conn) => {
          // If the wire was dropped on empty pane (toHandle is null on
          // the FinalConnectionState), pop the search so the user can
          // immediately browse a node to land the wire on. We also
          // stash the source handle details so the picked node gets
          // auto-wired from this same source.
          if (conn?.toHandle) return;
          const ce = event as MouseEvent;
          const x = typeof ce.clientX === "number" ? ce.clientX : 0;
          const y = typeof ce.clientY === "number" ? ce.clientY : 0;
          const flowPos = screenToFlowPosition({ x, y });
          onPanePointer?.(flowPos);
          let pendingWire:
            | { sourceNodeId: string; sourceHandle: string; sourceType: string }
            | undefined;
          const fromHandle = conn?.fromHandle;
          const fromNode = conn?.fromNode as
            | { id: string }
            | null
            | undefined;
          if (fromHandle?.id && fromNode?.id) {
            const srcNode = nodes.find((n) => n.id === fromNode.id);
            const srcType = srcNode
              ? resolveSourceSocketType(srcNode, fromHandle.id)
              : null;
            if (srcType) {
              pendingWire = {
                sourceNodeId: fromNode.id,
                sourceHandle: fromHandle.id,
                sourceType: srcType,
              };
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
        onNodeDragStart={(e, node) => {
          // Alt = duplicate-on-drag (the clone takes the node's edges;
          // React Flow keeps dragging the original as a fresh disconnected
          // copy). Cmd/Ctrl = detach — strip every edge from this node.
          // Both can be combined.
          if (e.altKey && onDuplicateOnDrag) {
            onDuplicateOnDrag(node.id);
          }
          if ((e.metaKey || e.ctrlKey) && onDetachNode) {
            onDetachNode(node.id);
          }
          setSpliceCandidate(null);
        }}
        onNodeDrag={(_e, node, dragged) => {
          // Only splice-highlight on a single-node drag. Marquee drags
          // that move many nodes at once shouldn't suddenly splice one
          // of them into a random edge.
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
        }}
        onNodeDragStop={(_e, node, dragged) => {
          const candidate = spliceRef.current;
          setSpliceCandidate(null);
          if (!candidate) return;
          if (dragged.length !== 1) return;
          onSpliceNode?.({
            nodeId: node.id,
            edgeId: candidate.edgeId,
            inputName: candidate.inputName,
            outputHandle: candidate.outputHandle,
          });
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
        }}
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
        // Figma-style viewport: two-finger scroll pans, pinch zooms,
        // drag on empty canvas draws a marquee selection. Cmd-scroll still
        // zooms via the default zoomActivationKeyCode.
        panOnScroll
        zoomOnScroll={false}
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
        fitView
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
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <SimulationZoneUnderlay nodes={nodes} />
        <Controls />
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

      {/* Fixed corner action stack — pinned upper-left of the editor.
          Designed for touch / pencil where the equivalent gestures
          (Shift+A, Backspace) aren't reachable without a hardware
          keyboard. The "+" opens the node search at the pen's last
          hover position (or near the button on mouse). The "−"
          deletes whatever's selected (nodes or edges); falls back
          to no-op when nothing is selected. */}
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          zIndex: 30,
        }}
      >
        <CornerActionButton
          title="Add node"
          onTap={() => {
            // Prefer the most recent pen-hover position (pen users
            // expect the popup at their tip); fall back to a spot
            // just below the button so the popup is reachable on
            // mouse / touch.
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
              x = window.innerWidth / 2;
              y = window.innerHeight / 2;
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
            width={14}
            height={14}
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
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

      {nodePopup && (
        <NodeSearchPopup
          x={nodePopup.x}
          y={nodePopup.y}
          // Thread the pending-wire context through the popup so the
          // parent's onAddNode can auto-connect the new node back to
          // the source handle the user dragged from.
          onAdd={(type) => onAddNode(type, nodePopup.pendingWire)}
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
          onDetach={
            onDetachNode
              ? () => {
                  onDetachNode(contextMenu.nodeId);
                }
              : undefined
          }
        />
      )}
    </div>
    </WaypointContext.Provider>
  );
}

function NodeContextMenu({
  x,
  y,
  onClose,
  onCopy,
  onPaste,
  onDuplicate,
  onDetach,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onDuplicate?: () => void;
  onDetach?: () => void;
}) {
  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Any click anywhere closes. Use capture so it fires before other
    // handlers potentially consume the event.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items: Array<{
    label: string;
    shortcut?: string;
    onClick?: () => void;
  }> = [
    { label: "Copy", shortcut: "⌘C", onClick: onCopy },
    { label: "Paste", shortcut: "⌘V", onClick: onPaste },
    { label: "Duplicate", onClick: onDuplicate },
    { label: "Detach", shortcut: "⌘-drag", onClick: onDetach },
  ];

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: 180,
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 4,
        zIndex: 2000,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        userSelect: "none",
      }}
    >
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
              color: disabled ? "#52525b" : "#e5e7eb",
              textAlign: "left",
              fontFamily: "inherit",
              fontSize: "inherit",
              cursor: disabled ? "not-allowed" : "default",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => {
              if (!disabled)
                (e.currentTarget as HTMLButtonElement).style.background =
                  "#1e3a8a";
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
                  color: disabled ? "#3f3f46" : "#71717a",
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
  // ParamType and map it to its driving SocketType.
  const def = getNodeDef(node.data.defType);
  if (!def) return null;
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
function CornerActionButton({
  title,
  onTap,
  children,
}: {
  title: string;
  onTap: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onTap();
      }}
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: "#1c1c1f",
        border: "1px solid #3f3f46",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, monospace",
        fontSize: 18,
        lineHeight: 1,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "manipulation",
        userSelect: "none",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

// Floating Apple Pencil hover cursor — a small ring at the pen tip.
// Purely visual (pointer-events: none) — the actual add-node trigger
// is the fixed "+" button in the upper-left of the editor pane,
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
        border: "1.5px solid rgba(255, 255, 255, 0.85)",
        background: "rgba(255, 255, 255, 0.08)",
        pointerEvents: "none",
        zIndex: 60,
      }}
    />
  );
}

