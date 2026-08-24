import type { AudioFileParamValue } from "@/engine/types";

// Load a user-picked audio file and return a persistent HTMLAudioElement
// bound to it. The element plays directly to the system's default output
// — we don't wire it into a WebAudio graph in v1. Compute() in Audio
// Source drives play/pause/seek against scene time.

export async function registerAudioFile(
  file: File
): Promise<AudioFileParamValue> {
  return loadAudioElement(URL.createObjectURL(file), {
    filename: file.name,
    size: file.size,
  });
}

// Load a cloud-hosted clip by URL (spec 081626 §7.4). Same element wiring
// as a local File, minus the ObjectURL; crossOrigin="anonymous" keeps the
// Web Audio analysis taps working on cross-origin media (a non-CORS
// element feeds MediaElementSource silence).
export async function registerAudioUrl(
  url: string,
  meta: { filename: string; size?: number }
): Promise<AudioFileParamValue> {
  return loadAudioElement(url, meta);
}

async function loadAudioElement(
  url: string,
  meta: { filename: string; size?: number }
): Promise<AudioFileParamValue> {
  const element = document.createElement("audio");
  element.src = url;
  element.crossOrigin = "anonymous";
  element.preload = "auto";
  element.loop = true;

  await new Promise<void>((resolve, reject) => {
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Audio load failed: ${meta.filename}`));
    };
    const cleanup = () => {
      element.removeEventListener("loadedmetadata", onMeta);
      element.removeEventListener("error", onErr);
    };
    element.addEventListener("loadedmetadata", onMeta);
    element.addEventListener("error", onErr);
  });

  return {
    element,
    url,
    filename: meta.filename,
    size: meta.size,
    duration: element.duration,
  };
}

export function disposeAudioFile(v: AudioFileParamValue | null | undefined) {
  if (!v) return;
  try {
    v.element.pause();
    v.element.src = "";
    URL.revokeObjectURL(v.url);
  } catch {
    // Best-effort cleanup — element might already be gone if the DOM
    // tore down around us.
  }
}

// Request microphone access and return an HTMLAudioElement driven by the
// live stream. getUserMedia prompts the user; the returned promise
// rejects on denial. The audio element's muted flag stays false so the
// mic is audible for monitoring — users who don't want to hear
// themselves can mute at the OS level.
export async function requestMicrophone(): Promise<{
  element: HTMLAudioElement;
  stream: MediaStream;
}> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone not available in this browser");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const element = document.createElement("audio");
  element.srcObject = stream;
  element.autoplay = true;
  // Chrome requires a muted element for autoplay; setting muted true
  // means you won't hear the mic via this element. For live monitoring
  // we keep it unmuted — the user has already granted permission, so
  // this is within the "allowed after user gesture" policy.
  element.muted = false;
  return { element, stream };
}

export function disposeMicrophone(stream: MediaStream | null | undefined) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}
