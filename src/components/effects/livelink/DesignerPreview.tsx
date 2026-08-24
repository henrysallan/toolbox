"use client";

// The Live Link Designer's preview pane (081426_live-link-designer.md M2):
// the REAL `.live-root` DOM — LiveRoot + ControlPanel + a poster canvas —
// portalled into a same-origin iframe.
//
// The iframe is what guarantees styling accuracy (the spec's "accuracy
// trap"): the editor's `:root` theme tokens and inline documentElement
// vars cannot cascade into a child document. Host stylesheets are COPIED
// in via PanelPopout's syncStyles — the hosted /live page loads the app's
// global CSS too, so the copy reproduces its cascade exactly, and
// LiveRoot pins every token the viewer consumes either way.
//
// No engine here. The canvas slot renders a one-shot poster image at the
// project's real resolution (owner decision: content pixels are not the
// thing being authored — the chrome is), drawn into a real <canvas> so
// the `.canvas-area canvas` CSS (contain/cover, radius, shadow) applies
// exactly as it does live.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { syncStyles } from "../layout/PanelPopout";
import { PanelWindowProvider } from "../layout/panel-window";
import { ControlPanel } from "@/lib/live-viewer/ControlPanel";
import { LiveRoot } from "@/lib/live-viewer/live-root";
import type { LiveDesign } from "@/lib/live-viewer/design";
import type { ExportManifest } from "@/lib/live-viewer/manifest-types";

const noop = () => {};

// The preview renders at a FIXED virtual viewport — a 13-inch Mac
// (1440×900 logical, 16:10) — and scales down to fit the available area.
// Scaling a fixed-size iframe with a CSS transform keeps every layout
// computation inside at true 13-inch metrics (breakpoints, the 280px
// sidebar, font sizes), so what you author is what a laptop visitor
// gets; the transform only changes how it's displayed.
const VIEWPORT_W = 1440;
const VIEWPORT_H = 900;

export function DesignerPreview({
  manifest,
  design,
  posterUrl,
  loopSecs,
  paramValues,
  drivenParams,
  onParamChange,
}: {
  manifest: ExportManifest;
  design: LiveDesign;
  posterUrl: string | null;
  /** The project's loop length — the preview shows the same scrub bar
   *  the real link gets (inert, like the rest of the transport). */
  loopSecs: number | null;
  paramValues: Map<string, Record<string, unknown>>;
  drivenParams: Set<string>;
  onParamChange: (
    ref: { nodeId: string; paramName: string },
    value: unknown
  ) => void;
}) {
  const [mount, setMount] = useState<{
    body: HTMLElement;
    win: Window;
  } | null>(null);

  // Fit the fixed 1440×900 frame to the area (never upscale past 1:1).
  const [scale, setScale] = useState(0.5);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width <= 0 || r.height <= 0) return;
      setScale(Math.min(r.width / VIEWPORT_W, r.height / VIEWPORT_H, 1));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ref callback with cleanup (React 19) rather than state + effect: the
  // iframe's document exists synchronously for a src-less same-origin
  // frame, and doing the setup here keeps portal-target state writes out
  // of render and out of effects.
  const frameRef = useCallback((frame: HTMLIFrameElement | null) => {
    if (!frame) return;
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return;
    const stop = syncStyles(document, doc);
    // The child body is the .live-root's viewport — fill and clip like
    // the real page's <body>.
    doc.documentElement.style.height = "100%";
    doc.body.style.cssText = "margin:0;height:100%;overflow:hidden;";
    setMount({ body: doc.body, win });
    return () => {
      stop();
      setMount(null);
    };
  }, []);

  // The working design rides the manifest, exactly like the real viewer —
  // ControlPanel reads ordering/renames from manifest.design, and the
  // author's canvas-size override retargets canvasRes (which is what
  // makes the Size fields live-update the preview canvas).
  const previewManifest = useMemo(
    () => ({
      ...manifest,
      design,
      canvasRes: design.export.resolution ?? manifest.canvasRes,
    }),
    [manifest, design]
  );

  return (
    <>
      <div
        ref={boxRef}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          boxSizing: "border-box",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Reserves the scaled footprint; the iframe inside stays at true
            1440×900 and is visually scaled down. */}
        <div
          style={{
            width: VIEWPORT_W * scale,
            height: VIEWPORT_H * scale,
            flexShrink: 0,
            position: "relative",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 6,
            overflow: "hidden",
            boxShadow: "0 12px 40px rgba(0, 0, 0, 0.4)",
          }}
        >
          <iframe
            ref={frameRef}
            title="Live link preview"
            style={{
              width: VIEWPORT_W,
              height: VIEWPORT_H,
              border: "none",
              display: "block",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            right: 14,
            bottom: 8,
            fontSize: 9,
            color: "var(--tb-n-9)",
            fontFamily: "ui-monospace, monospace",
            pointerEvents: "none",
          }}
        >
          1440 × 900 · {Math.round(scale * 100)}%
        </div>
      </div>
      {mount &&
        createPortal(
          // The provider points param-control popovers (color picker,
          // dropdown portals) at the iframe's window so they render and
          // hit-test in the right document.
          <PanelWindowProvider win={mount.win}>
            <LiveRoot design={design}>
              <div className="app">
                <div className="canvas-area">
                  <PosterCanvas
                    posterUrl={posterUrl}
                    canvasRes={previewManifest.canvasRes}
                  />
                </div>
                <ControlPanel
                  manifest={previewManifest}
                  paramValues={paramValues}
                  drivenParams={drivenParams}
                  onParamChange={onParamChange}
                  playing={false}
                  onTogglePlay={noop}
                  onReset={noop}
                  time={0}
                  loopSecs={loopSecs}
                  renderScale={1}
                />
              </div>
            </LiveRoot>
          </PanelWindowProvider>,
          mount.body
        )}
    </>
  );
}

function PosterCanvas({
  posterUrl,
  canvasRes,
}: {
  posterUrl: string | null;
  canvasRes: [number, number];
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !posterUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      canvas
        .getContext("2d")
        ?.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = posterUrl;
    return () => {
      cancelled = true;
    };
    // Resizing a canvas clears its bitmap — redraw when the author's
    // size override changes the dims, not just when the poster does.
  }, [posterUrl, canvasRes[0], canvasRes[1]]);
  // No poster (fresh project, blank preview canvas) → the canvas stays
  // its --canvas-bg fill, which is still the right aspect and chrome.
  return <canvas ref={ref} width={canvasRes[0]} height={canvasRes[1]} />;
}
