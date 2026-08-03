import { platform } from "./platform";

// Browser support for MediaRecorder mime types varies — Chrome and Safari
// accept H.264-in-mp4 on recent versions, Firefox still only accepts webm.
// We probe a ranked candidate list at runtime and fall back gracefully.

export function pickVideoMime(
  requested: "mp4" | "webm",
  // When the captured stream carries an audio track, prefer mime strings
  // that name an audio codec so MediaRecorder actually writes the audio.
  withAudio = false
): { mime: string; ext: "mp4" | "webm" } | null {
  const mp4Candidates = withAudio
    ? [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4;codecs=h264,aac",
        "video/mp4",
      ]
    : [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4;codecs=avc1",
        "video/mp4;codecs=h264",
        "video/mp4",
      ];
  const webmCandidates = withAudio
    ? [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]
    : [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];

  const tryList = (list: string[], ext: "mp4" | "webm") => {
    for (const m of list) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
        return { mime: m, ext };
      }
    }
    return null;
  };

  if (requested === "mp4") {
    return tryList(mp4Candidates, "mp4") ?? tryList(webmCandidates, "webm");
  }
  return tryList(webmCandidates, "webm") ?? tryList(mp4Candidates, "mp4");
}

// Resolves the Output node's export-resolution params (resolution /
// resScale / resWidth / resHeight — see EXPORT_PARAMS in
// src/nodes/output/output.ts) to concrete pixel dimensions. "canvas" (and
// any old save that predates the params) exports at the project canvas
// resolution — deliberately NOT the preview render resolution, so a
// lowered preview render scale never leaks into exports. `even` rounds
// down to even dimensions for the video paths (H.264/H.265 encoders
// reject odd sizes). Spec: 073126_export-resolution-and-app-slim.md.
export function resolveExportResolution(
  params: Record<string, unknown>,
  canvasRes: [number, number],
  opts?: { even?: boolean }
): [number, number] {
  const mode = (params.resolution as string) ?? "canvas";
  let w = canvasRes[0];
  let h = canvasRes[1];
  if (mode === "scale") {
    const s = Number(params.resScale ?? 1);
    const k = Number.isFinite(s) && s > 0 ? s : 1;
    w = Math.round(canvasRes[0] * k);
    h = Math.round(canvasRes[1] * k);
  } else if (mode === "custom") {
    const cw = Number(params.resWidth ?? canvasRes[0]);
    const ch = Number(params.resHeight ?? canvasRes[1]);
    if (Number.isFinite(cw) && cw > 0) w = Math.round(cw);
    if (Number.isFinite(ch) && ch > 0) h = Math.round(ch);
  }
  w = Math.min(8192, Math.max(2, w));
  h = Math.min(8192, Math.max(2, h));
  if (opts?.even) {
    w &= ~1;
    h &= ~1;
  }
  return [w, h];
}

// Single delivery switch-point for the whole app. On web this is the same
// anchor-download as before (implemented in platform/web.ts); on the Electron
// build it routes to a native Save dialog + disk write. Kept synchronous /
// fire-and-forget so the many existing callsites are unchanged.
export function downloadBlob(blob: Blob, filename: string) {
  void platform.saveFile(blob, { suggestedName: filename }).catch((e) => {
    console.error("saveFile failed:", e);
  });
}

// Strips filesystem-unsafe characters and any trailing extension. Empty or
// whitespace-only input returns "" so the caller can fall back to a default.
export function sanitizeFilename(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const noExt = trimmed.replace(/\.[a-z0-9]{1,5}$/i, "");
  return noExt.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
}

export function defaultFilename(ext: string): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
    d.getDate()
  )}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `toolbox-${stamp}.${ext}`;
}
