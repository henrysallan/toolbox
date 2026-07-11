"use client";

import { type MutableRefObject } from "react";
import type { Node } from "@xyflow/react";
import TransformGizmo from "./TransformGizmo";
import PrimitiveGizmo, {
  PRIMITIVE_GIZMO_ADAPTERS,
  type PrimitiveGizmoEnv,
} from "./PrimitiveGizmo";
import MotionPathOverlay from "./MotionPathOverlay";
import SplineEditorOverlay from "./SplineEditorOverlay";
import GradientOverlay from "./GradientOverlay";
import { evaluateKeyframesAt } from "@/engine/keyframes";
import { gpointXKey, gpointYKey } from "@/engine/conventions";
import type { EvalCache } from "@/engine/evaluator";
import type { GradientPoint } from "@/engine/types";
import type { NodeDataPayload } from "@/state/graph";
import type { SplineParamValue } from "@/nodes/source/spline-draw";
import { useClock } from "@/state/playback-clock";

// Playhead-subscribed gizmo overlays (clock-store spec, shell detach).
// Each wrapper owns the keyframe-at-playhead derivation its overlay needs
// and subscribes to the tick itself, so on-canvas handles keep tracking the
// animation during playback and scrubs WITHOUT the EffectsApp shell
// re-rendering per frame. Everything in this file re-renders per tick BY
// DESIGN — that's the overlay's job.

type EffectsNode = Node<NodeDataPayload>;
type ParamChange = (
  nodeId: string,
  paramName: string,
  value: unknown,
  coalesceKey?: string
) => void;
type MotionPathPointChange = (
  nodeId: string,
  xParam: string,
  yParam: string,
  tick: number,
  xVal: number,
  yVal: number,
  coalesceKey: string
) => void;

// Effective param value at the playhead: for animated params the
// keyframe-evaluated value (so handles track the animation as the user
// scrubs), else the stored constant, else the fallback.
function effectiveScalar(
  node: EffectsNode,
  name: string,
  tick: number,
  fallback: number
): number {
  const block = node.data.animation?.[name];
  if (block && block.animated && block.keyframes.length > 0) {
    const v = evaluateKeyframesAt(block, "scalar", tick);
    if (typeof v === "number") return v;
  }
  const raw = node.data.params[name];
  return typeof raw === "number" ? raw : fallback;
}

// Pen-tool overlay host. The spline shown at the current playhead: when
// "Path Animation" is keyframed, that's the interpolated shape (so the
// editor handles sit on the rendered/animated curve and on-canvas edits
// branch from what's displayed — autokey then writes a keyframe here);
// otherwise the stored constant.
export function SplineEditorOverlayAtTick({
  node,
  canvas,
  onParamChange,
}: {
  node: EffectsNode;
  canvas: HTMLCanvasElement | null;
  onParamChange: ParamChange;
}) {
  const currentTick = useClock((s) => s.tick);
  const stored = (node.data.params.spline as SplineParamValue | undefined) ?? {
    subpaths: [{ anchors: [], closed: false }],
  };
  let value = stored;
  const block = node.data.animation?.spline;
  if (block && block.animated && block.keyframes.length > 0) {
    const v = evaluateKeyframesAt(block, "spline_anchors", currentTick);
    if (v) value = v as SplineParamValue;
  }
  return (
    <SplineEditorOverlay
      canvas={canvas}
      value={value}
      onChange={(next) => onParamChange(node.id, "spline", next)}
    />
  );
}

// Transform gizmo + its motion path, reading effective (keyframe-aware)
// params at the subscribed tick.
export function TransformGizmoAtTick({
  node,
  canvas,
  boundsSourceId,
  evalCacheRef,
  multiGizmo,
  ticksPerFrame,
  onParamChange,
  onMotionPathPointChange,
}: {
  node: EffectsNode;
  canvas: HTMLCanvasElement | null;
  // Upstream node feeding in:image when the transform is in spline mode —
  // its latest eval output provides the geometry the bounds polygon hugs.
  boundsSourceId?: string;
  evalCacheRef: MutableRefObject<EvalCache>;
  multiGizmo: boolean;
  ticksPerFrame: number;
  onParamChange: ParamChange;
  onMotionPathPointChange: MotionPathPointChange;
}) {
  const currentTick = useClock((s) => s.tick);
  const animMap = node.data.animation;
  const effective = (name: string, fallback: number): number =>
    effectiveScalar(node, name, currentTick, fallback);
  // Spline-mode bounds: hug the actual spline geometry instead of the unit
  // canvas box. We pull the spline value off the upstream node's most
  // recent eval result; if the upstream hasn't evaluated yet (or isn't a
  // spline), fall back to canvas bounds. Anchors-only AABB — close enough
  // at typical spline densities and avoids per-frame Bézier eval.
  let boundsMin: [number, number] | undefined;
  let boundsMax: [number, number] | undefined;
  if (boundsSourceId) {
    // eslint-disable-next-line react-hooks/refs -- engine-owned eval cache, mutated outside React with no change notifications; sampled at render exactly like the pre-detach shell did (the tick subscription that caused this render also caused the eval)
    const srcOut = evalCacheRef.current.get(boundsSourceId);
    const splineVal = srcOut?.output?.primary;
    if (splineVal && splineVal.kind === "spline") {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const sub of splineVal.subpaths) {
        for (const a of sub.anchors) {
          if (a.pos[0] < minX) minX = a.pos[0];
          if (a.pos[0] > maxX) maxX = a.pos[0];
          if (a.pos[1] < minY) minY = a.pos[1];
          if (a.pos[1] > maxY) maxY = a.pos[1];
        }
      }
      if (Number.isFinite(minX) && maxX - minX > 1e-4 && maxY - minY > 1e-4) {
        boundsMin = [minX, minY];
        boundsMax = [maxX, maxY];
      }
    }
  }
  // Motion-path anchor = the transform's position (translate + pivot), so
  // the current-frame diamond coincides with the gizmo's pivot marker.
  // Pivot is read at the playhead (rarely animated).
  const mpPivotX = effective("pivotX", 0.5);
  const mpPivotY = effective("pivotY", 0.5);
  const txConst =
    typeof node.data.params.translateX === "number"
      ? node.data.params.translateX
      : 0;
  const tyConst =
    typeof node.data.params.translateY === "number"
      ? node.data.params.translateY
      : 0;
  return (
    <>
      <TransformGizmo
        canvas={canvas}
        pivotX={mpPivotX}
        pivotY={mpPivotY}
        translateX={effective("translateX", 0)}
        translateY={effective("translateY", 0)}
        scaleX={effective("scaleX", 1)}
        scaleY={effective("scaleY", 1)}
        rotate={effective("rotate", 0)}
        boundsMin={boundsMin}
        boundsMax={boundsMax}
        boxTranslate={multiGizmo}
        onChange={(patch) => {
          const id = node.id;
          // Single coalescing key for the whole drag so a 60-frame gizmo
          // manipulation yields one undo entry, not one-per-(param × frame).
          const key = `gizmo:${id}`;
          for (const [k, v] of Object.entries(patch)) {
            if (typeof v === "number") onParamChange(id, k, v, key);
          }
        }}
      />
      <MotionPathOverlay
        canvas={canvas}
        xBlock={animMap?.["translateX"]}
        yBlock={animMap?.["translateY"]}
        xConst={txConst}
        yConst={tyConst}
        toCenter={(x, y) => ({ cx: x + mpPivotX, cy: y + mpPivotY })}
        fromCenter={(cx, cy) => ({
          xVal: cx - mpPivotX,
          yVal: cy - mpPivotY,
        })}
        aspectCorrect
        ticksPerFrame={ticksPerFrame}
        onPointDrag={(tick, xVal, yVal) =>
          onMotionPathPointChange(
            node.id,
            "translateX",
            "translateY",
            tick,
            xVal,
            yVal,
            `motionpath:${node.id}`
          )
        }
      />
    </>
  );
}

// Shape-primitive handles (Circle, Rectangle, …) — move the center, drag
// edges/corners to resize. Reads effective (keyframe-aware) params; writes
// coalesce into one undo entry.
export function PrimitiveGizmoAtTick({
  node,
  canvas,
  canvasWidth,
  canvasHeight,
  evalCacheRef,
  ticksPerFrame,
  onParamChange,
  onMotionPathPointChange,
}: {
  node: EffectsNode;
  canvas: HTMLCanvasElement | null;
  canvasWidth: number;
  canvasHeight: number;
  evalCacheRef: MutableRefObject<EvalCache>;
  ticksPerFrame: number;
  onParamChange: ParamChange;
  onMotionPathPointChange: MotionPathPointChange;
}) {
  const currentTick = useClock((s) => s.tick);
  const adapter = PRIMITIVE_GIZMO_ADAPTERS[node.data.defType];
  if (!adapter) return null;
  const animMap = node.data.animation;
  const get = (name: string, fallback: number): number =>
    effectiveScalar(node, name, currentTick, fallback);
  // Solved container px size — lets Auto Layout's hug axes display their
  // actual bounds. The aux element's measure is pure CPU; the cache entry
  // is from the latest eval.
  let solvedSize: { width: number; height: number } | null = null;
  if (node.data.defType === "autolayout") {
    // eslint-disable-next-line react-hooks/refs -- engine-owned eval cache, mutated outside React with no change notifications; sampled at render exactly like the pre-detach shell did
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
    canvasWidth,
    canvasHeight,
    getRaw: (name) => node.data.params[name],
    solvedSize,
  };
  const { cx, cy, hx, hy } = adapter.read(get, env);
  const mp = adapter.motionPath;
  const mpToCenter =
    mp?.toCenter ?? ((x: number, y: number) => ({ cx: x, cy: y }));
  const mpFromCenter =
    mp?.fromCenter ??
    ((cx2: number, cy2: number) => ({ xVal: cx2, yVal: cy2 }));
  return (
    <>
      <PrimitiveGizmo
        canvas={canvas}
        cx={cx}
        cy={cy}
        hx={hx}
        hy={hy}
        anchorResize={adapter.anchorResize}
        onChange={(patch) => {
          const id = node.id;
          const key = `gizmo:${id}`;
          for (const [name, value] of adapter.write(patch, env)) {
            onParamChange(id, name, value, key);
          }
        }}
      />
      {mp && (
        <MotionPathOverlay
          canvas={canvas}
          xBlock={animMap?.[mp.x]}
          yBlock={animMap?.[mp.y]}
          xConst={
            typeof node.data.params[mp.x] === "number"
              ? (node.data.params[mp.x] as number)
              : 0.5
          }
          yConst={
            typeof node.data.params[mp.y] === "number"
              ? (node.data.params[mp.y] as number)
              : 0.5
          }
          toCenter={mpToCenter}
          fromCenter={mpFromCenter}
          aspectCorrect={false}
          ticksPerFrame={ticksPerFrame}
          onPointDrag={(tick, xVal, yVal) =>
            onMotionPathPointChange(
              node.id,
              mp.x,
              mp.y,
              tick,
              xVal,
              yVal,
              `motionpath:${node.id}`
            )
          }
        />
      )}
    </>
  );
}

// Gradient handles — linear endpoints (line + 2 dots) or the radial
// center/radius. Reads keyframe-aware params; writes coalesce into one undo
// entry per drag. Gradient param space is Y-up UV; the overlay flips Y.
export function GradientOverlayAtTick({
  node,
  canvas,
  onParamChange,
}: {
  node: EffectsNode;
  canvas: HTMLCanvasElement | null;
  onParamChange: ParamChange;
}) {
  const currentTick = useClock((s) => s.tick);
  const get = (name: string, fallback: number): number =>
    effectiveScalar(node, name, currentTick, fallback);
  const rawMode = (node.data.params.mode as string) ?? "linear";
  const rawWave = (node.data.params.wave_mode as string) ?? "linear";
  const mode =
    rawMode === "radial"
      ? "radial"
      : rawMode === "multipoint"
        ? "multipoint"
        : rawMode === "wave" && rawWave === "ring"
          ? "ring"
          : "linear";
  // Multipoint dots: positions are keyframe-effective (per-point virtual
  // gpoint_x/y tracks), colors are the stored hex.
  const storedPoints =
    (node.data.params.points as GradientPoint[] | undefined) ?? [];
  const effPoints = storedPoints.map((pt) => ({
    id: pt.id,
    x: get(gpointXKey(pt.id), pt.x),
    y: get(gpointYKey(pt.id), pt.y),
    color: typeof pt.color === "string" ? pt.color : "#ffffff",
  }));
  return (
    <GradientOverlay
      canvas={canvas}
      mode={mode}
      startX={get("start_x", 0)}
      startY={get("start_y", 0.5)}
      endX={get("end_x", 1)}
      endY={get("end_y", 0.5)}
      centerX={get("center_x", 0.5)}
      centerY={get("center_y", 0.5)}
      radius={get("radius", 0.5)}
      points={effPoints}
      onChange={(updates) => {
        const id = node.id;
        const key = `gizmo:${id}`;
        for (const [name, value] of updates) {
          onParamChange(id, name, value, key);
        }
      }}
      onPointChange={(pointId, x, y) => {
        // Update only the dragged point's x/y in the STORED array (not the
        // effective positions), so other keyframed points aren't baked.
        // Autokey mirrors x/y when their tracks are on.
        const stored =
          (node.data.params.points as GradientPoint[] | undefined) ?? [];
        const next = stored.map((p) =>
          p.id === pointId ? { ...p, x, y } : p
        );
        onParamChange(node.id, "points", next, `gizmo:${node.id}`);
      }}
    />
  );
}
