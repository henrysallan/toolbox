import type { VideoFileParamValue } from "@/engine/types";
import { platform } from "./platform";
import {
  disposeVideoDecodeSource,
  setScrubProxyProvider,
} from "@/engine/video-decode-source";
import { disposeFrameStore } from "@/engine/video-frame-store";

// Desktop only: the engine asks for a decoder proxy when a source is large
// or long-GOP (specdocs/090526_video-scrub-optimizations.md M4). The bytes
// go to the main process the same way transcode-on-import's do; the proxy
// lives in tmp and is read back by range. Local files only — a cloud
// clip's bytes are not here — and nothing over 2 GB.
const PROXY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
if (platform.makeScrubProxy) {
  const make = platform.makeScrubProxy;
  setScrubProxyProvider(async (v) => {
    if (!v.url.startsWith("blob:")) return null;
    const blob = await (await fetch(v.url)).blob();
    if (blob.size > PROXY_MAX_BYTES) return null;
    return make(await blob.arrayBuffer(), v.filename ?? "video");
  });
}

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

// Load a cloud-hosted clip by URL (spec 081626 §7.4) — the same element
// wiring as a local File, minus the ObjectURL. crossOrigin="anonymous" is
// already set below, which the WebGL texture upload requires for
// cross-origin media; playback streams with range requests instead of
// downloading first. The media-domain CORS policy allows GET from any
// origin, so this works in the editor, live viewer, and exported apps.
export async function registerVideoUrl(
  url: string,
  meta: { filename: string; size?: number }
): Promise<VideoFileParamValue> {
  return loadVideoElement(url, {
    filename: meta.filename,
    size: meta.size,
    isObjectUrl: false,
  });
}

async function loadVideoElement(file: File): Promise<VideoFileParamValue>;
async function loadVideoElement(
  src: string,
  meta: { filename: string; size?: number; isObjectUrl: boolean }
): Promise<VideoFileParamValue>;
async function loadVideoElement(
  fileOrSrc: File | string,
  meta?: { filename: string; size?: number; isObjectUrl: boolean }
): Promise<VideoFileParamValue> {
  const isFile = typeof fileOrSrc !== "string";
  const url = isFile ? URL.createObjectURL(fileOrSrc) : fileOrSrc;
  const filename = isFile ? fileOrSrc.name : (meta?.filename ?? "video");
  const size = isFile ? fileOrSrc.size : meta?.size;
  const ownsObjectUrl = isFile || meta?.isObjectUrl === true;
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
        if (ownsObjectUrl) URL.revokeObjectURL(url);
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
      reject(new Error(`Video load failed: ${filename}${detail}`));
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
    // rvfc fires only when a NEW frame is presented — a completed seek that
    // lands inside the currently-displayed source frame presents nothing, so
    // rvfc alone can miss it. `seeked` always fires, and the re-eval it
    // forces is what lets the seek coalescing in nodes/source/video.ts chain
    // to the freshest playhead target instead of stalling mid-scrub.
    video.addEventListener("seeked", dispatch);
  } else {
    video.addEventListener("timeupdate", dispatch);
    video.addEventListener("seeked", dispatch);
  }

  return {
    video,
    url,
    filename,
    size,
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}

export function disposeVideoFile(v: VideoFileParamValue | null | undefined) {
  if (!v) return;
  // The WebCodecs decode source and the shared frame store (scrub frame
  // cache) belong to the value.
  disposeFrameStore(v);
  disposeVideoDecodeSource(v);
  try {
    v.video.pause();
    v.video.removeAttribute("src");
    v.video.load();
  } catch {
    // Non-fatal; the URL revoke below is what actually frees memory.
  }
  URL.revokeObjectURL(v.url);
}
