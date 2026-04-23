import type { AudioFileParamValue } from "@/engine/types";

// Load a user-picked audio file and return a persistent HTMLAudioElement
// bound to it. The element plays directly to the system's default output
// — we don't wire it into a WebAudio graph in v1. Compute() in Audio
// Source drives play/pause/seek against scene time.

export async function registerAudioFile(
  file: File
): Promise<AudioFileParamValue> {
  const url = URL.createObjectURL(file);
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
      reject(new Error(`Audio load failed: ${file.name}`));
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
    filename: file.name,
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
