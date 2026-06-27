import type { VideoFileParamValue } from "@/engine/types";
import { platform } from "./platform";

// Load a user-picked video file and wire it up so the pipeline re-evaluates
// on every new frame.
//
// Two re-eval paths depending on browser support:
//   • `requestVideoFrameCallback` (Chrome / Safari): fires exactly when a
//     new frame is decoded — gives us frame-accurate driven playback with
//     no jitter between scene-time and texture content.
//   • `timeupdate` + `seeked` fallback (Firefox older versions): coarser
//     (~4 Hz), but keeps things moving.
//
// The returned value owns the <video> element and its ObjectURL; we don't
// revoke until the caller replaces or clears the param.
export async function registerVideoFile(
  file: File,
  onStatus?: (message: string) => void
): Promise<VideoFileParamValue> {
  try {
    return await loadVideoElement(file);
  } catch (err) {
    // Desktop fallback: Electron's bundled Chromium decodes fewer formats
    // than a system browser, so files it can't play (10-bit / 4:2:2 H.264,
    // HEVC, ProRes, …) fail with MediaError code 4. Transcode via the bundled
    // native ffmpeg to a Chromium-playable form and retry. Original
    // filename/size are kept for relink/display.
    if (platform.canEncodeNative && platform.transcodeVideoForPlayback) {
      onStatus?.("Transcoding video for playback…");
      const res = await platform.transcodeVideoForPlayback(
        await file.arrayBuffer(),
        file.name
      );
      if (res) {
        const playable = new File([res.bytes], file.name, { type: res.type });
        const v = await loadVideoElement(playable);
        return { ...v, filename: file.name, size: file.size };
      }
    }
    throw err;
  }
}

async function loadVideoElement(file: File): Promise<VideoFileParamValue> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.loop = true;
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      // Free this failed attempt's ObjectURL before we reject (the transcode
      // fallback creates a fresh element/URL).
      try {
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      } catch {
        // best-effort
      }
      // Surface the MediaError so codec problems are diagnosable. Code 4
      // (SRC_NOT_SUPPORTED) typically means the build can't decode this
      // format — common in Electron, whose bundled Chromium decodes fewer
      // codecs than a system browser (e.g. HEVC/H.265, ProRes).
      const me = video.error;
      const detail = me
        ? ` (MediaError code ${me.code}${me.message ? `: ${me.message}` : ""})`
        : "";
      reject(new Error(`Video load failed: ${file.name}${detail}`));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
  });

  type RVFC = (cb: (now: number) => void) => number;
  const rvfc = (
    video as unknown as { requestVideoFrameCallback?: RVFC }
  ).requestVideoFrameCallback;

  const dispatch = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("pipeline-bump"));
    }
  };

  if (rvfc) {
    const loop = () => {
      rvfc.call(video, loop);
      dispatch();
    };
    rvfc.call(video, loop);
  } else {
    video.addEventListener("timeupdate", dispatch);
    video.addEventListener("seeked", dispatch);
  }

  return {
    video,
    url,
    filename: file.name,
    size: file.size,
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}

export function disposeVideoFile(v: VideoFileParamValue | null | undefined) {
  if (!v) return;
  try {
    v.video.pause();
    v.video.removeAttribute("src");
    v.video.load();
  } catch {
    // Non-fatal; the URL revoke below is what actually frees memory.
  }
  URL.revokeObjectURL(v.url);
}
