import type { VideoFileParamValue } from "@/engine/types";

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
  file: File
): Promise<VideoFileParamValue> {
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
      reject(new Error(`Video load failed: ${file.name}`));
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
