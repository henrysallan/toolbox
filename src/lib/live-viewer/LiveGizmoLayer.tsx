"use client";

// On-canvas handles in the live link (specdocs/091726_live-gizmos.md).
//
// Hosts the editor's own overlay components — TransformGizmo,
// PrimitiveGizmo / PrimitivePointHandles, GradientOverlay — over the live
// canvas for every manifest gizmo the visitor has visible, the way
// components/effects/GizmoTickOverlays.tsx hosts them in the editor, minus
// the motion paths (keyframe editing is not a live-link affordance).
//
// Reads are keyframe-effective at the viewer's tick (owner decision 4: a
// handle on an animated param shows the animated value, as the editor's
// does, and a drag writes the constant the keyframes then override —
// exactly the sliders' treatment). Writes go through the viewer's
// onParamChange, the same per-session path the sliders use, so a slider on
// the same param follows the drag and the eval bump repaints.
//
// Lives in lib/live-viewer/ because the export template bundles this
// directory; the three overlay components are aliased into that build
// (src/export-template/vite.config.ts) and pull only lib/engine leaves.

import { useMemo, type MutableRefObject } from "react";
import TransformGizmo from "@/components/effects/TransformGizmo";
import PrimitiveGizmo, {
  PRIMITIVE_GIZMO_ADAPTERS,
  PrimitivePointHandles,
  type PrimitiveGizmoEnv,
} from "@/components/effects/PrimitiveGizmo";
import GradientOverlay, {
  type GradientOverlayMode,
} from "@/components/effects/GradientOverlay";
import { evaluateKeyframesAt, type AnimationMap } from "@/engine/keyframes";
import { geometryAABBFromOutput, isLocalPivotSpace } from "@/engine/transform-pivot";
import { GIZMO_REST_AABB } from "@/engine/transform-value";
import { gpointXKey, gpointYKey } from "@/engine/conventions";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { GradientPoint } from "@/engine/types";
import type { ExportManifestGizmo } from "./manifest-types";

interface ParamRef {
  nodeId: string;
  paramName: string;
}

export interface LiveGizmoLayerProps {
  /** The gizmos to draw — already filtered by the visitor's visibility
   *  toggles and the active-branch set (LiveViewer). */
  gizmos: readonly ExportManifestGizmo[];
  canvas: HTMLCanvasElement | null;
  canvasRes: [number, number];
  graphNodes: readonly GraphNode[];
  graphEdges: readonly GraphEdge[];
  evalCacheRef: MutableRefObject<EvalCache>;
  /** The viewer's per-session param values (node id → params). */
  paramValues: ReadonlyMap<string, Record<string, unknown>>;
  /** The tick the evaluator sampled keyframes at for this frame. */
  tick: number;
  onParamChange: (ref: ParamRef, value: unknown) => void;
}

type Params = Record<string, unknown>;
type Effective = (name: string, fallback: number) => number;
type Write = (name: string, value: unknown) => void;

// Effective scalar at the tick: keyframe-evaluated for an animated param,
// else the session value, else the fallback — GizmoTickOverlays'
// effectiveScalar over the viewer's data shapes.
function effectiveScalar(
  params: Params,
  animation: AnimationMap | undefined,
  name: string,
  tick: number,
  fallback: number
): number {
  const block = animation?.[name];
  if (block && block.animated && block.keyframes.length > 0) {
    const v = evaluateKeyframesAt(block, "scalar", tick);
    if (typeof v === "number") return v;
  }
  const raw = params[name];
  return typeof raw === "number" ? raw : fallback;
}

export function LiveGizmoLayer({
  gizmos,
  canvas,
  canvasRes,
  graphNodes,
  graphEdges,
  evalCacheRef,
  paramValues,
  tick,
  onParamChange,
}: LiveGizmoLayerProps) {
  const nodeById = useMemo(
    () => new Map(graphNodes.map((n) => [n.id, n] as const)),
    [graphNodes]
  );
  // With 2+ gizmos up, the transform gizmo trades its canvas-wide translate
  // surface for its bounds polygon so stacked gizmos don't fight over
  // empty-canvas drags — the editor's multi-select rule.
  const multi = gizmos.length > 1;
  return (
    <>
      {gizmos.map((g) => {
        const node = nodeById.get(g.nodeId);
        if (!node) return null;
        const params = paramValues.get(g.nodeId) ?? node.params;
        const effective: Effective = (name, fallback) =>
          effectiveScalar(params, node.animation, name, tick, fallback);
        const write: Write = (name, value) =>
          onParamChange({ nodeId: g.nodeId, paramName: name }, value);
        switch (g.kind) {
          case "transform":
            return (
              <TransformLiveGizmo
                key={g.nodeId}
                node={node}
                params={params}
                canvas={canvas}
                graphEdges={graphEdges}
                evalCacheRef={evalCacheRef}
                boxTranslate={multi}
                effective={effective}
                write={write}
              />
            );
          case "primitive":
            return (
              <PrimitiveLiveGizmo
                key={g.nodeId}
                node={node}
                params={params}
                canvas={canvas}
                canvasRes={canvasRes}
                evalCacheRef={evalCacheRef}
                effective={effective}
                write={write}
              />
            );
          case "gradient":
            return (
              <GradientLiveGizmo
                key={g.nodeId}
                params={params}
                canvas={canvas}
                effective={effective}
                write={write}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}

// TRS + pivot handles. Bounds: the Gizmo node is a null with a fixed rest
// box; a Transform in spline / points mode hugs the geometry feeding its
// `in:image` (latest eval output), else the unit canvas. Pivot space
// follows `params.space` as the editor does.
function TransformLiveGizmo({
  node,
  params,
  canvas,
  graphEdges,
  evalCacheRef,
  boxTranslate,
  effective,
  write,
}: {
  node: GraphNode;
  params: Params;
  canvas: HTMLCanvasElement | null;
  graphEdges: readonly GraphEdge[];
  evalCacheRef: MutableRefObject<EvalCache>;
  boxTranslate: boolean;
  effective: Effective;
  write: Write;
}) {
  const isGizmo = node.type === "gizmo";
  let boundsMin: [number, number] | undefined;
  let boundsMax: [number, number] | undefined;
  if (isGizmo) {
    boundsMin = [GIZMO_REST_AABB.minX, GIZMO_REST_AABB.minY];
    boundsMax = [GIZMO_REST_AABB.maxX, GIZMO_REST_AABB.maxY];
  } else {
    const inEdge = graphEdges.find(
      (e) => e.target === node.id && e.targetHandle === "in:image"
    );
    if (inEdge) {
      const bbox = geometryAABBFromOutput(
        // eslint-disable-next-line react-hooks/refs -- engine-owned eval cache, mutated outside React with no change notifications; sampled at render exactly as the editor's GizmoTickOverlays does (the param / time change that caused this render also caused the eval)
        evalCacheRef.current.get(inEdge.source)?.output,
        inEdge.sourceHandle
      );
      if (
        bbox &&
        bbox.maxX - bbox.minX > 1e-4 &&
        bbox.maxY - bbox.minY > 1e-4
      ) {
        boundsMin = [bbox.minX, bbox.minY];
        boundsMax = [bbox.maxX, bbox.maxY];
      }
    }
  }
  const localSpace = isLocalPivotSpace(params.space);
  return (
    <TransformGizmo
      canvas={canvas}
      pivotX={effective("pivotX", 0.5)}
      pivotY={effective("pivotY", 0.5)}
      translateX={effective("translateX", 0)}
      translateY={effective("translateY", 0)}
      scaleX={effective("scaleX", 1)}
      scaleY={effective("scaleY", 1)}
      rotate={effective("rotate", 0)}
      boundsMin={boundsMin}
      boundsMax={boundsMax}
      pivotSpace={isGizmo || !localSpace ? "global" : "local"}
      boxTranslate={boxTranslate}
      onChange={(patch) => {
        for (const [k, v] of Object.entries(patch)) {
          if (typeof v === "number") write(k, v);
        }
      }}
    />
  );
}

// Shape-primitive handles — the adapter map owns every param mapping, so
// the same primitives that have handles in the editor have them here.
function PrimitiveLiveGizmo({
  node,
  params,
  canvas,
  canvasRes,
  evalCacheRef,
  effective,
  write,
}: {
  node: GraphNode;
  params: Params;
  canvas: HTMLCanvasElement | null;
  canvasRes: [number, number];
  evalCacheRef: MutableRefObject<EvalCache>;
  effective: Effective;
  write: Write;
}) {
  const adapter = PRIMITIVE_GIZMO_ADAPTERS[node.type];
  if (!adapter) return null;
  // Solved container px size — lets Auto Layout's hug axes display their
  // actual bounds. Pure CPU measure on the latest eval's aux element.
  let solvedSize: { width: number; height: number } | null = null;
  if (node.type === "autolayout") {
    // eslint-disable-next-line react-hooks/refs -- engine-owned eval cache, mutated outside React with no change notifications; sampled at render exactly as the editor's GizmoTickOverlays does
    const out = evalCacheRef.current.get(node.id)?.output;
    const el = out?.aux?.element;
    if (el && el.kind === "element") {
      try {
        solvedSize = el.measure({});
      } catch {
        solvedSize = null;
      }
    }
  }
  const env: PrimitiveGizmoEnv = {
    canvasWidth: canvasRes[0],
    canvasHeight: canvasRes[1],
    getRaw: (name) => params[name],
    solvedSize,
  };
  // Point-handle primitives (SDF Line Segment / Triangle) render dots
  // instead of a box — a centre+extent gizmo can't express "move one
  // endpoint".
  if (adapter.points) {
    const pts = adapter.points.read(effective, env);
    const writePoints = adapter.points.write;
    return (
      <PrimitivePointHandles
        canvas={canvas}
        points={pts}
        connect={adapter.points.connect}
        onChange={(index, x, y) => {
          for (const [name, value] of writePoints(index, x, y, env)) {
            write(name, value);
          }
        }}
      />
    );
  }
  if (!adapter.read || !adapter.write) return null;
  const { cx, cy, hx, hy } = adapter.read(effective, env);
  const adapterWrite = adapter.write;
  return (
    <PrimitiveGizmo
      canvas={canvas}
      cx={cx}
      cy={cy}
      hx={hx}
      hy={hy}
      anchorResize={adapter.anchorResize}
      onChange={(patch) => {
        for (const [name, value] of adapterWrite(patch, env)) {
          write(name, value);
        }
      }}
    />
  );
}

// Gradient handles — linear endpoints, the radial centre + radius, the
// ring wave's centre, or one dot per multipoint stop. Polar and the
// linear wave have no positional handles, so those modes draw nothing —
// the same rule that keeps the editor's overlay off for them. Gradient
// param space is Y-up UV; the overlay flips Y.
function GradientLiveGizmo({
  params,
  canvas,
  effective,
  write,
}: {
  params: Params;
  canvas: HTMLCanvasElement | null;
  effective: Effective;
  write: Write;
}) {
  const rawMode = typeof params.mode === "string" ? params.mode : "linear";
  const rawWave =
    typeof params.wave_mode === "string" ? params.wave_mode : "linear";
  let mode: GradientOverlayMode | null = null;
  if (rawMode === "linear") mode = "linear";
  else if (rawMode === "radial") mode = "radial";
  else if (rawMode === "multipoint") mode = "multipoint";
  else if (rawMode === "wave" && rawWave === "ring") mode = "ring";
  if (!mode) return null;
  // Multipoint dots: positions are keyframe-effective (per-point virtual
  // gpoint_x/y tracks), colors are the stored hex.
  const storedPoints = Array.isArray(params.points)
    ? (params.points as GradientPoint[])
    : [];
  const effPoints = storedPoints.map((pt) => ({
    id: pt.id,
    x: effective(gpointXKey(pt.id), pt.x),
    y: effective(gpointYKey(pt.id), pt.y),
    color: typeof pt.color === "string" ? pt.color : "#ffffff",
  }));
  return (
    <GradientOverlay
      canvas={canvas}
      mode={mode}
      startX={effective("start_x", 0)}
      startY={effective("start_y", 0.5)}
      endX={effective("end_x", 1)}
      endY={effective("end_y", 0.5)}
      centerX={effective("center_x", 0.5)}
      centerY={effective("center_y", 0.5)}
      radius={effective("radius", 0.5)}
      points={effPoints}
      onChange={(updates) => {
        for (const [name, value] of updates) write(name, value);
      }}
      onPointChange={(pointId, x, y) => {
        // Only the dragged point's x/y in the STORED array (not the
        // effective positions), so other keyframed points aren't baked.
        write(
          "points",
          storedPoints.map((p) => (p.id === pointId ? { ...p, x, y } : p))
        );
      }}
    />
  );
}
