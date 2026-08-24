// Viewer-facing export drivers for the live link / exported app
// (081426_live-link-designer.md M3). Deliberately NOT the editor's
// drivers: no Output-node params, no resolution brackets, no sim
// pre-roll, no tiers — a capture of exactly what the visitor sees, at
// canvas resolution. The author gates which of these exist per link via
// LiveDesign.export.
//
// Self-contained on purpose: lib/export.ts's downloadBlob/pickVideoMime
// route through the platform seam (native save dialogs on desktop),
// which is editor machinery the export-template bundle shouldn't carry.
// The small local equivalents here are anchor-download and a compact
// silent-capture mime probe. The GIF path is the exception — it imports
// the real encoder (lib/export-gif.ts ffmpeg+gifsicle pipeline), which
// is why the template's package.json carries @ffmpeg/ffmpeg,
// @ffmpeg/util and gifsicle-wasm-browser.

export function viewerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Grace period: revoking immediately can race the download start.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Filesystem-safe base name (viewer-local sanitizeFilename equivalent). */
export function viewerFileBase(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : "live-link";
}

// --- image ---------------------------------------------------------------

export async function exportViewerImage(
  canvas: HTMLCanvasElement,
  baseName: string
): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("Canvas capture failed");
  viewerDownload(blob, `${viewerFileBase(baseName)}.png`);
}

// --- video (MediaRecorder live capture, silent) --------------------------

/** Compact video-only mime probe — mp4 where supported, else webm. */
function pickCaptureMime(): { mime: string; ext: "mp4" | "webm" } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates: [string, "mp4" | "webm"][] = [
    ["video/mp4;codecs=avc1.42E01E", "mp4"],
    ["video/mp4;codecs=avc1", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm;codecs=vp8", "webm"],
    ["video/webm", "webm"],
  ];
  for (const [mime, ext] of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return null;
}

export interface ViewerVideoHandle {
  /** Stops recording and discards the capture. */
  cancel: () => void;
  /** Resolves when the file has been handed to the browser (or cancelled). */
  done: Promise<void>;
}

/**
 * Records the canvas for `durationSecs` and downloads the result. The
 * caller owns playback — the RAF loop must keep rendering for the whole
 * duration (a backgrounded tab suspends RAF and records nothing; the UI
 * surfaces a "keep this tab visible" note while recording).
 */
export function recordViewerVideo(opts: {
  canvas: HTMLCanvasElement;
  fps: number;
  durationSecs: number;
  baseName: string;
}): ViewerVideoHandle {
  const picked = pickCaptureMime();
  if (!picked) {
    return {
      cancel: () => {},
      done: Promise.reject(
        new Error("This browser can't record video (no MediaRecorder)")
      ),
    };
  }
  const stream = opts.canvas.captureStream(opts.fps);
  const recorder = new MediaRecorder(stream, { mimeType: picked.mime });
  const chunks: Blob[] = [];
  let cancelled = false;
  let timer = 0;

  const done = new Promise<void>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => {
      window.clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      reject(new Error("Video recording failed"));
    };
    recorder.onstop = () => {
      window.clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (cancelled) {
        resolve();
        return;
      }
      const blob = new Blob(chunks, { type: picked.mime.split(";")[0] });
      if (blob.size === 0) {
        reject(
          new Error(
            "Recording came out empty — keep this tab visible while recording."
          )
        );
        return;
      }
      viewerDownload(blob, `${viewerFileBase(opts.baseName)}.${picked.ext}`);
      resolve();
    };
  });

  recorder.start();
  timer = window.setTimeout(
    () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
    Math.max(250, opts.durationSecs * 1000)
  );

  return {
    cancel: () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
    },
    done,
  };
}

// --- gif (frame-stepped through the shared ffmpeg+gifsicle pipeline) -----

/** Viewer GIF policy: fixed sensible defaults, no knobs. */
export const VIEWER_GIF_FPS = 15;
export const VIEWER_GIF_COLORS = 128;

export async function exportViewerGif(opts: {
  canvas: HTMLCanvasElement;
  durationSecs: number;
  baseName: string;
  /** Deterministic render of the frame at `timeSec` (LiveViewer.runFrame). */
  renderFrame: (timeSec: number) => void;
  onProgress: (label: string, fraction: number) => void;
  signal: AbortSignal;
}): Promise<void> {
  // Lazy import: the ffmpeg core is fetched from unpkg on first use (same
  // behavior as the editor's GIF/max-video tiers), so an exported app
  // used offline fails here with a clear error rather than at load time.
  const { exportGif } = await import("@/lib/export-gif");
  const durationFrames = Math.max(
    1,
    Math.round(opts.durationSecs * VIEWER_GIF_FPS)
  );
  const { blob } = await exportGif({
    canvas: opts.canvas,
    fps: VIEWER_GIF_FPS,
    durationFrames,
    colors: VIEWER_GIF_COLORS,
    dither: "floyd",
    lossy: 0,
    transparent: false,
    renderFrame: (_i, t) => opts.renderFrame(t),
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
  viewerDownload(blob, `${viewerFileBase(opts.baseName)}.gif`);
}
