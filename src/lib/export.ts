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
