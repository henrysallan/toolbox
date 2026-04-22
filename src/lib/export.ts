// Browser support for MediaRecorder mime types varies — Chrome and Safari
// accept H.264-in-mp4 on recent versions, Firefox still only accepts webm.
// We probe a ranked candidate list at runtime and fall back gracefully.

export function pickVideoMime(
  requested: "mp4" | "webm"
): { mime: string; ext: "mp4" | "webm" } | null {
  const mp4Candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1",
    "video/mp4;codecs=h264",
    "video/mp4",
  ];
  const webmCandidates = [
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

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
