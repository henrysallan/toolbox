"use client";

import { useEffect, useRef } from "react";
import { useStore, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type {
  ImageValue,
  MaskValue,
  PointsValue,
  SocketType,
  SocketValue,
  SplineValue,
  UvValue,
} from "@/engine/types";
import { colorForSocket, resolveSocketColor } from "./socketColor";
import { ValueSummary } from "./NodeInspectorPopup";

// Hover-peek popover for a single OUTPUT socket: dwell on an output
// handle for ~2s (EffectNode dispatches `socket-peek`) and EffectsApp
// mounts this next to the socket, showing the value the last eval
// produced there — a live thumbnail for texture-backed values, a path /
// dot drawing for splines and points, plain text for CPU values.
// Rendered inside <ViewportPortal> (flow coords; pan/zoom applied by the
// portal's parent transform), same contract as NodeInspectorPopup.
// EffectsApp force-evaluates the peeked node while the popover is open,
// so unwired branches show real data too.

// Thumbnail display bounds (CSS px at zoom 1). Backing store renders at
// 2× for sharpness under zoom-in.
const THUMB_MAX_W = 168;
const THUMB_MAX_H = 132;

interface Props {
  node: Node<NodeDataPayload>;
  handle: string; // "out:primary" | "out:aux:<name>"
  anchorY: number; // socket-row center, node-local px (flow units)
  value: SocketValue | undefined;
  // Whether the last eval produced ANY output for this node — separates
  // "this output is empty" from "the node never evaluated" (group
  // boundaries, Iterate members).
  evaluated: boolean;
  // Project canvas aspect (w/h) so spline/point drawings keep the
  // composition's proportions (normalized coords are anisotropic).
  canvasAspect: number;
  // CPU readback of a texture-backed value at a given size — EffectsApp
  // routes this through the engine's pooled readback FBO.
  readPixels: (
    image: ImageValue | MaskValue | UvValue,
    width: number,
    height: number
  ) => Uint8ClampedArray<ArrayBuffer> | null;
  // Hover grace: entering the popover cancels the pending hide, leaving
  // dismisses it — lets the pointer travel from the socket into the
  // popover (e.g. to scroll a long string).
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export default function SocketPeekPopover({
  node,
  handle,
  anchorY,
  value,
  evaluated,
  canvasAspect,
  readPixels,
  onPointerEnter,
  onPointerLeave,
}: Props) {
  const measured = useStore((s) => {
    const internal = s.nodeLookup.get(node.id);
    return internal?.measured;
  });
  const x = node.position.x + (measured?.width ?? 200) + 12;
  const y = node.position.y + anchorY;
  const label =
    handle === "out:primary" ? "out" : handle.slice("out:aux:".length);

  return (
    <div
      data-socket-peek="1"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translateY(-50%)",
        pointerEvents: "auto",
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 4,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--code-font)",
        fontSize: 10,
        padding: 8,
        minWidth: 120,
        maxWidth: 220,
        zIndex: 60,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: value
              ? colorForSocket(value.kind as SocketType)
              : "var(--tb-n-10)",
            flex: "0 0 auto",
          }}
        />
        <span style={{ color: "var(--tb-n-13)", letterSpacing: 0.3 }}>{label}</span>
      </div>
      {value ? (
        <>
          <div style={{ marginBottom: 4 }}>
            <ValueSummary value={value} />
          </div>
          <PeekVisual
            value={value}
            canvasAspect={canvasAspect}
            readPixels={readPixels}
          />
        </>
      ) : (
        <div style={{ color: "var(--tb-n-10)" }}>
          {evaluated ? "(empty — no value on this output)" : "(not evaluated)"}
        </div>
      )}
    </div>
  );
}

function PeekVisual({
  value,
  canvasAspect,
  readPixels,
}: {
  value: SocketValue;
  canvasAspect: number;
  readPixels: Props["readPixels"];
}) {
  switch (value.kind) {
    case "image":
    case "mask":
    case "uv":
      return <PixelThumb value={value} readPixels={readPixels} />;
    case "image_group":
      return value.items[0] ? (
        <PixelThumb value={value.items[0]} readPixels={readPixels} />
      ) : null;
    case "spline":
      return <SplineThumb value={value} aspect={canvasAspect} />;
    case "points":
      return <PointsThumb value={value} aspect={canvasAspect} />;
    case "string":
      return (
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 96,
            overflowY: "auto",
            color: "var(--tb-n-15)",
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 3,
            padding: "4px 6px",
          }}
        >
          {value.value === "" ? (
            <span style={{ color: "var(--tb-n-10)" }}>(empty string)</span>
          ) : (
            value.value
          )}
        </div>
      );
    case "vec3":
    case "vec4": {
      // Vec3/vec4 frequently carry colors (the Color node's outputs) —
      // show a swatch next to nothing else; the summary line already has
      // the numbers. Non-color vectors just get an odd swatch, harmless.
      const [r, g, b] = value.value;
      const a = value.kind === "vec4" ? value.value[3] : 1;
      const to255 = (v: number) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255);
      return (
        <div
          style={{
            width: 40,
            height: 14,
            borderRadius: 3,
            border: "1px solid var(--tb-n-9)",
            background: CHECKER_BG,
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 2,
              background: `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${Math.min(1, Math.max(0, a))})`,
            }}
          />
        </div>
      );
    }
    default:
      return null;
  }
}

// Transparent-pixel backdrop, matches the editor's dark chrome.
const CHECKER_BG =
  "repeating-conic-gradient(var(--tb-n-7) 0% 25%, var(--tb-n-3) 0% 50%) 0 0 / 12px 12px";

function PixelThumb({
  value,
  readPixels,
}: {
  value: ImageValue | MaskValue | UvValue;
  readPixels: Props["readPixels"];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scale = Math.min(
    THUMB_MAX_W / value.width,
    THUMB_MAX_H / value.height,
    1
  );
  const dispW = Math.max(1, Math.round(value.width * scale));
  const dispH = Math.max(1, Math.round(value.height * scale));
  // Read at 2× the display size (capped at source res) so the thumb
  // stays sharp when the editor is zoomed in.
  const readW = Math.max(1, Math.min(value.width, dispW * 2));
  const readH = Math.max(1, Math.min(value.height, dispH * 2));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const data = readPixels(value, readW, readH);
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    if (!data) {
      c2d.clearRect(0, 0, readW, readH);
      return;
    }
    if (value.kind === "mask") {
      // Masks are R-channel textures — the readback lands as (v,0,0,255).
      // Expand to grayscale so the thumb reads as coverage, not red.
      for (let i = 0; i < data.length; i += 4) {
        data[i + 1] = data[i];
        data[i + 2] = data[i];
      }
    }
    c2d.putImageData(new ImageData(data, readW, readH), 0, 0);
  }, [value, readPixels, readW, readH]);

  return (
    <canvas
      ref={canvasRef}
      width={readW}
      height={readH}
      style={{
        width: dispW,
        height: dispH,
        display: "block",
        borderRadius: 3,
        border: "1px solid var(--tb-n-7)",
        background: CHECKER_BG,
      }}
    />
  );
}

// Fit the composition's aspect box into the thumb bounds.
function thumbBox(aspect: number): { w: number; h: number } {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let w = THUMB_MAX_W;
  let h = w / safe;
  if (h > THUMB_MAX_H) {
    h = THUMB_MAX_H;
    w = h * safe;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function SplineThumb({
  value,
  aspect,
}: {
  value: SplineValue;
  aspect: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { w, h } = thumbBox(aspect);

  useEffect(() => {
    const canvas = canvasRef.current;
    const c2d = canvas?.getContext("2d");
    if (!canvas || !c2d) return;
    c2d.setTransform(2, 0, 0, 2, 0, 0); // 2× backing store
    c2d.clearRect(0, 0, w, h);
    // Normalized [0,1]² Y-down maps straight onto the 2D canvas — no flip.
    const path = new Path2D();
    for (const sp of value.subpaths) {
      const a = sp.anchors;
      if (a.length === 0) continue;
      path.moveTo(a[0].pos[0] * w, a[0].pos[1] * h);
      const segs = sp.closed ? a.length : a.length - 1;
      for (let i = 1; i <= segs; i++) {
        const A = a[i - 1];
        const B = a[i % a.length];
        const c1x = (A.pos[0] + (A.outHandle?.[0] ?? 0)) * w;
        const c1y = (A.pos[1] + (A.outHandle?.[1] ?? 0)) * h;
        const c2x = (B.pos[0] + (B.inHandle?.[0] ?? 0)) * w;
        const c2y = (B.pos[1] + (B.inHandle?.[1] ?? 0)) * h;
        path.bezierCurveTo(c1x, c1y, c2x, c2y, B.pos[0] * w, B.pos[1] * h);
      }
      if (sp.closed) path.closePath();
    }
    c2d.strokeStyle = resolveSocketColor("spline");
    c2d.lineWidth = 1.25;
    c2d.stroke(path);
  }, [value, w, h]);

  return (
    <canvas
      ref={canvasRef}
      width={w * 2}
      height={h * 2}
      style={{
        width: w,
        height: h,
        display: "block",
        borderRadius: 3,
        border: "1px solid var(--tb-n-7)",
        background: "var(--tb-n-3)",
      }}
    />
  );
}

// Dot-count cap for the points drawing — beyond this we stride-sample.
// The summary line above the thumb always shows the true count.
const MAX_PEEK_DOTS = 4000;

function PointsThumb({
  value,
  aspect,
}: {
  value: PointsValue;
  aspect: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { w, h } = thumbBox(aspect);

  useEffect(() => {
    const canvas = canvasRef.current;
    const c2d = canvas?.getContext("2d");
    if (!canvas || !c2d) return;
    c2d.setTransform(2, 0, 0, 2, 0, 0);
    c2d.clearRect(0, 0, w, h);
    c2d.fillStyle = resolveSocketColor("points");
    const stride = Math.max(1, Math.ceil(value.count / MAX_PEEK_DOTS));
    const pos = value.positions;
    for (let i = 0; i < value.count; i += stride) {
      const px = pos[i * 2] * w;
      const py = pos[i * 2 + 1] * h;
      c2d.fillRect(px - 1, py - 1, 2, 2);
    }
  }, [value, w, h]);

  return (
    <canvas
      ref={canvasRef}
      width={w * 2}
      height={h * 2}
      style={{
        width: w,
        height: h,
        display: "block",
        borderRadius: 3,
        border: "1px solid var(--tb-n-7)",
        background: "var(--tb-n-3)",
      }}
    />
  );
}
