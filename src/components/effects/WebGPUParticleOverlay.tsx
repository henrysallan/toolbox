"use client";

import { useEffect, useRef, useState } from "react";
import {
  WebGPUTestScene,
  type TestSceneOptions,
} from "@/engine/webgpu/test-scene";

// Overlay for the Phase 0 WebGPU Particle Test spike. Mirrors the
// PointsOverlay pattern: tracks the preview canvas's screen rect via
// ResizeObserver and renders a position:fixed canvas on top. The
// WebGPU work is driven by this overlay's own rAF rather than the
// engine eval loop — Phase 0 only needs to validate the dual-canvas
// compositing question, not the eval-loop integration. Phase 1 will
// move the dispatch into a proper WebGPU bucket inside the evaluator.

interface Props {
  // The main WebGL preview canvas. We mirror its on-screen rect so the
  // particle overlay aligns pixel-for-pixel.
  canvas: HTMLCanvasElement | null;
  // Particle count. Treated as the buffer-allocation cap (the spike
  // doesn't reap dead particles). Changes trigger a full scene rebuild.
  count: number;
  gravity: number;
  damping: number;
  pointSizePx: number;
  // Bump this to re-seed the buffers without rebuilding. Wired to the
  // node's "seed" param so the user can re-roll the initial state.
  seedNonce: number;
}

interface SceneState {
  scene: WebGPUTestScene;
  device: GPUDevice;
}

type Status = "booting" | "running" | "unsupported" | "error";

function detectInitialStatus(): Status {
  if (typeof navigator === "undefined") return "booting";
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  return gpu ? "booting" : "unsupported";
}

export default function WebGPUParticleOverlay({
  canvas,
  count,
  gravity,
  damping,
  pointSizePx,
  seedNonce,
}: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);
  // Initialize unsupported synchronously so we never call setState in
  // the boot effect just to flag a missing browser API.
  const [status, setStatus] = useState<Status>(detectInitialStatus);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Live params handed to the boot effect via ref so the effect's dep
  // list stays as { count } only — we don't want a gravity tweak to
  // tear down and rebuild every GPUBuffer.
  const livePropsRef = useRef({ gravity, damping, pointSizePx });

  // ---- Track the preview canvas rect -----------------------------
  // Same pattern as PointsOverlay. The `setRect(null)` early-return on
  // canvas-cleared is functionally correct here and matches the
  // existing overlay; the set-state-in-effect lint complaint is shared
  // with that file. Phase 1 cleanup may consolidate both behind a
  // shared hook.
  useEffect(() => {
    if (!canvas) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRect(null);
      return;
    }
    const update = () => setRect(canvas.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  // ---- Boot the WebGPU scene -------------------------------------
  // Recreated whenever `count` changes (buffer size changes). Other
  // params flow through via the live-options effect below.
  useEffect(() => {
    if (status === "unsupported") return;
    let cancelled = false;
    const overlayCanvas = overlayRef.current;
    if (!overlayCanvas) return;
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return;

    (async () => {
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          if (!cancelled) {
            setStatus("unsupported");
            setErrMsg("No WebGPU adapter available.");
          }
          return;
        }
        const device = await adapter.requestDevice();
        if (cancelled) {
          device.destroy?.();
          return;
        }
        const opts: TestSceneOptions = {
          count,
          gravity: livePropsRef.current.gravity,
          damping: livePropsRef.current.damping,
          pointSizePx: livePropsRef.current.pointSizePx,
        };
        const scene = new WebGPUTestScene(device, overlayCanvas, opts);
        sceneRef.current = { scene, device };
        setStatus("running");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrMsg(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      const s = sceneRef.current;
      sceneRef.current = null;
      if (s) {
        s.scene.dispose();
        s.device.destroy?.();
      }
    };
    // status is read inside the effect to suppress booting when the
    // initial detection already saw no GPU; we intentionally don't
    // rerun when status flips away from "unsupported" because that
    // never happens within a single mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  // ---- Live param sync (no rebuild) ------------------------------
  useEffect(() => {
    livePropsRef.current = { gravity, damping, pointSizePx };
    sceneRef.current?.scene.setOptions({ gravity, damping, pointSizePx });
  }, [gravity, damping, pointSizePx]);

  // ---- Re-seed on nonce bump -------------------------------------
  useEffect(() => {
    sceneRef.current?.scene.seedParticles();
  }, [seedNonce]);

  // ---- Match overlay size to preview canvas ----------------------
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !rect) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = rect.width;
    const cssH = rect.height;
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== pxW) c.width = pxW;
    if (c.height !== pxH) c.height = pxH;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    c.style.left = `${rect.left}px`;
    c.style.top = `${rect.top}px`;
    sceneRef.current?.scene.resize(pxW, pxH);
  }, [rect]);

  // ---- rAF loop --------------------------------------------------
  useEffect(() => {
    if (status !== "running") return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const s = sceneRef.current;
      if (s) {
        // Cap dt so a paused tab returning doesn't launch every
        // particle into the bouncefloor at once.
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        s.scene.step(dt);
        s.scene.render();
      } else {
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  if (!rect) return null;

  return (
    <>
      <canvas
        ref={overlayRef}
        style={{
          position: "fixed",
          pointerEvents: "none",
          // Above PointsOverlay (z=2) but below ParamPanel / menus.
          zIndex: 3,
        }}
      />
      {status !== "running" && (
        <div
          style={{
            position: "fixed",
            left: rect.left + 12,
            top: rect.top + 12,
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            font: "12px ui-monospace, monospace",
            padding: "6px 10px",
            borderRadius: 4,
            pointerEvents: "none",
            zIndex: 4,
            maxWidth: rect.width - 24,
          }}
        >
          {status === "booting" && "WebGPU particle test booting…"}
          {status === "unsupported" &&
            (errMsg ?? "WebGPU not supported in this browser.")}
          {status === "error" && `WebGPU error: ${errMsg ?? "unknown"}`}
        </div>
      )}
    </>
  );
}
