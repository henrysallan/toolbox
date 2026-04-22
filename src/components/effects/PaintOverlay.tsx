"use client";

import { useEffect, useRef } from "react";
import Atrament, { type AtramentMode } from "atrament";
import FillWorker from "atrament/fill";
import type { PaintParamValue } from "@/engine/types";

interface Props {
  nodeId: string;
  params: Record<string, unknown>;
  canvasRes: [number, number];
  onParamChange: (nodeId: string, paramName: string, value: unknown) => void;
  // Fires after each completed stroke or fill with the pre-action pixels so
  // the caller can push them onto the undo stack.
  onStrokeCommit?: (
    nodeId: string,
    canvas: HTMLCanvasElement,
    before: ImageData
  ) => void;
}

export default function PaintOverlay({
  nodeId,
  params,
  canvasRes,
  onParamChange,
  onStrokeCommit,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const atramentRef = useRef<Atrament | null>(null);
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;
  const onChangeRef = useRef(onParamChange);
  onChangeRef.current = onParamChange;
  const onStrokeCommitRef = useRef(onStrokeCommit);
  onStrokeCommitRef.current = onStrokeCommit;

  const paint = (params.paint as PaintParamValue | null) ?? null;
  const color = (params.color as string) ?? "#ffffff";
  const size = (params.size as number) ?? 12;
  const softness = (params.softness as number) ?? 0.85;
  const erase = !!params.erase;
  const mode: AtramentMode = erase ? "erase" : "draw";

  // Bootstrap the persistent drawing canvas on first mount. The canvas stays
  // transparent — strokes carry alpha, and the paint node's compute composites
  // them over a background color when rendering to the pipeline.
  useEffect(() => {
    if (paint != null) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvasRes[0];
    canvas.height = canvasRes[1];
    onChangeRef.current(nodeIdRef.current, "paint", { canvas, snapshot: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach atrament and mount the canvas. Re-runs if the canvas or engine res changes.
  useEffect(() => {
    if (!paint) return;
    const container = containerRef.current;
    if (!container) return;
    const canvas = paint.canvas;

    // Resize (with pixel preservation) when engine resolution changes.
    if (canvas.width !== canvasRes[0] || canvas.height !== canvasRes[1]) {
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      tmp.getContext("2d")?.drawImage(canvas, 0, 0);
      canvas.width = canvasRes[0];
      canvas.height = canvasRes[1];
      const c2d = canvas.getContext("2d");
      if (c2d) c2d.drawImage(tmp, 0, 0, canvas.width, canvas.height);
      createImageBitmap(canvas).then((bmp) => {
        onChangeRef.current(nodeIdRef.current, "paint", {
          canvas,
          snapshot: bmp,
        });
      });
    }

    canvas.style.maxWidth = "100%";
    canvas.style.maxHeight = "100%";
    canvas.style.display = "block";
    canvas.style.cursor = "crosshair";
    canvas.style.background = "transparent";
    // Visually hide the atrament canvas — the active node's output (which
    // includes this paint node's contribution via the pipeline) is what the
    // user sees on the main canvas behind this overlay.
    canvas.style.opacity = "0";
    container.appendChild(canvas);

    // Atrament's constructor sets canvas.width/height (via the options), which
    // clears the 2D context. Save pixels and restore them after construction so
    // prior strokes persist across node selection.
    const preCtx = canvas.getContext("2d");
    const preserved = preCtx?.getImageData(0, 0, canvas.width, canvas.height);
    const at = new Atrament(canvas, {
      width: canvas.width,
      height: canvas.height,
      color,
      fill: FillWorker,
    });
    if (preCtx && preserved) preCtx.putImageData(preserved, 0, 0);
    at.weight = size;
    at.smoothing = softness;
    at.mode = mode;
    at.adaptiveStroke = true;
    atramentRef.current = at;

    let snapshotPending = false;
    const snapshot = async () => {
      if (snapshotPending) return;
      snapshotPending = true;
      try {
        const bmp = await createImageBitmap(canvas);
        onChangeRef.current(nodeIdRef.current, "paint", {
          canvas,
          snapshot: bmp,
        });
      } finally {
        snapshotPending = false;
      }
    };

    // Mid-stroke rAF loop so the pipeline re-evaluates as the user drags,
    // giving real-time feedback through the active node (not the paint node
    // directly, which is hidden).
    let drawing = false;
    let rafId = 0;
    // Pixels captured at stroke/fill start, committed to the undo stack when
    // the action ends. Cleared on unmount mid-stroke to avoid half-actions.
    let beforeAction: ImageData | null = null;
    const tick = () => {
      if (!drawing) return;
      snapshot();
      rafId = requestAnimationFrame(tick);
    };
    const captureBefore = () => {
      const c2d = canvas.getContext("2d");
      if (!c2d) return;
      beforeAction = c2d.getImageData(0, 0, canvas.width, canvas.height);
    };
    const commitBefore = () => {
      if (!beforeAction) return;
      onStrokeCommitRef.current?.(nodeIdRef.current, canvas, beforeAction);
      beforeAction = null;
    };
    const onStrokeStart = () => {
      captureBefore();
      drawing = true;
      rafId = requestAnimationFrame(tick);
    };
    const onStrokeEnd = () => {
      drawing = false;
      cancelAnimationFrame(rafId);
      // Final snapshot to capture the last pixels after the loop exits.
      snapshot();
      commitBefore();
    };
    const onFillStart = () => {
      captureBefore();
    };
    const onFillEnd = () => {
      drawing = false;
      cancelAnimationFrame(rafId);
      snapshot();
      commitBefore();
    };
    at.addEventListener("strokestart", onStrokeStart);
    at.addEventListener("strokeend", onStrokeEnd);
    at.addEventListener("fillstart", onFillStart);
    at.addEventListener("fillend", onFillEnd);

    return () => {
      drawing = false;
      beforeAction = null;
      cancelAnimationFrame(rafId);
      at.removeEventListener("strokestart", onStrokeStart);
      at.removeEventListener("strokeend", onStrokeEnd);
      at.removeEventListener("fillstart", onFillStart);
      at.removeEventListener("fillend", onFillEnd);
      // atrament.destroy() clears the canvas — save and restore to preserve the drawing.
      const c2d = canvas.getContext("2d");
      const saved = c2d?.getImageData(0, 0, canvas.width, canvas.height);
      at.destroy();
      if (c2d && saved) c2d.putImageData(saved, 0, 0);
      if (canvas.parentElement === container) container.removeChild(canvas);
      atramentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint?.canvas, canvasRes[0], canvasRes[1]]);

  // Live tool-state updates without reconstructing atrament.
  useEffect(() => {
    if (atramentRef.current) atramentRef.current.color = color;
  }, [color]);
  useEffect(() => {
    if (atramentRef.current) atramentRef.current.weight = size;
  }, [size]);
  useEffect(() => {
    if (atramentRef.current) atramentRef.current.smoothing = softness;
  }, [softness]);
  useEffect(() => {
    if (atramentRef.current) atramentRef.current.mode = mode;
  }, [mode]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        padding: 12,
        boxSizing: "border-box",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "transparent",
      }}
    />
  );
}
