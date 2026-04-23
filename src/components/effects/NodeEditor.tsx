"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
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
  onCopyNodes,
  onPasteNodes,
  onAddFileNode,
  onCombineWires,
  onCutWires,
  onWaypointDragStart,
  onWaypointDrag,
  onSpliceNode,
}: Props) {
  const nodeTypes = useMemo(() => ({ effect: EffectNode }), []);
  // Register JunctionEdge under the default edge type so every edge —
  // including ones that predate waypoints — flows through it. The
  // component renders identically to React Flow's default bezier when no
  // waypoint is set, so there's no visual change for unjoined edges.
  const edgeTypes = useMemo(() => ({ default: JunctionEdge }), []);
  const { screenToFlowPosition } = useReactFlow();
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
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

  // Decorate edges with `data.spliceHighlight` on the fly — purely UI
  // state, no need to round-trip through the parent's edges state.
  // JunctionEdge picks up the flag and boosts its stroke.
  const displayEdges = useMemo(() => {
    if (!spliceCandidate) return edges;
    return edges.map((e) =>
      e.id === spliceCandidate.edgeId
        ? { ...e, data: { ...(e.data ?? {}), spliceHighlight: true } }
        : e
    );
  }, [edges, spliceCandidate]);

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
        // Only opt in when the OS is actually dragging a file — lets
        // React Flow keep its own drag behaviors (like internal node
        // drags) untouched. preventDefault is required on DragOver
        // for the Drop event to fire.
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (!onAddFileNode) return;
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;
        e.preventDefault();
        const firstPos = screenToFlowPosition({
          x: e.clientX,
          y: e.clientY,
        });
        // Offset subsequent files slightly so a multi-file drop doesn't
        // land every node on top of the same coords.
        for (let i = 0; i < files.length; i++) {
          onAddFileNode(files[i], {
            x: firstPos.x + i * 28,
            y: firstPos.y + i * 28,
          });
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange as (c: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (c: EdgeChange[]) => void}
        onConnect={onConnect}
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
        // Array form of panOnDrag selects which mouse buttons pan. [1]
        // = middle button only — left-button drag still hits the
        // marquee path via `selectionOnDrag`.
        panOnDrag={[1]}
        selectionOnDrag
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <SimulationZoneUnderlay nodes={nodes} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>

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

