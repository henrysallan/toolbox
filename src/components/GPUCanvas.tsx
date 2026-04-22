"use client";

import { useEffect, useRef, useState } from "react";
import { detectRenderer, type RendererBackend } from "@/lib/gpu/detect";
import { startWebGPU } from "@/lib/gpu/webgpu-renderer";
import { startWebGL } from "@/lib/gpu/webgl-renderer";

interface Props {
  className?: string;
  preferred?: "webgpu" | "webgl2" | "auto";
}

export default function GPUCanvas({ className, preferred = "auto" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [backend, setBackend] = useState<RendererBackend>("none");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let stop: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const caps = await detectRenderer();
        const useGPU =
          preferred === "webgpu" ? caps.webgpu :
          preferred === "webgl2" ? false :
          caps.webgpu;

        if (cancelled) return;

        if (useGPU) {
          const h = await startWebGPU(canvas);
          stop = h.stop;
          setBackend("webgpu");
        } else if (caps.webgl2) {
          const h = startWebGL(canvas);
          stop = h.stop;
          setBackend("webgl2");
        } else {
          setBackend("none");
          setError("No WebGPU or WebGL2 available.");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [preferred]);

  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          padding: "4px 8px",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          background: "rgba(0,0,0,0.5)",
          color: "white",
          borderRadius: 4,
          pointerEvents: "none",
        }}
      >
        backend: {backend}
        {error ? ` · ${error}` : ""}
      </div>
    </div>
  );
}
