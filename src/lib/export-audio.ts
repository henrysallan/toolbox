// Audio muxing support for video export. Reconstructs the audio that feeds
// the Output node's `audio` socket into a single AudioBuffer covering the
// export window, then hands it to the encoders (mediabunny's
// AudioBufferSource for the offline tiers; a WAV blob for ffmpeg.wasm).
//
// Only file-mode Audio Source can be rendered offline deterministically —
// we decode the file and let an OfflineAudioContext re-create the exact
// playback (start offset, looping, volume) for [0, durationSec). Mic input
// has no offline representation, so it's skipped here and captured live in
// the Fast (MediaRecorder) path instead.

import type { AudioFileParamValue } from "@/engine/types";

// The playback-relevant slice of an Audio Source node's params, plus the
// originating node id (needed to reach mic state for the live path).
export interface ExportAudioSpec {
  nodeId: string;
  mode: "file" | "microphone";
  file: AudioFileParamValue | null;
  volume: number;
  loop: boolean;
  sync: boolean;
  startOffset: number;
}

// Decode + render the file-mode audio into an AudioBuffer covering the
// export window [0, durationSec). Honors start_offset (sync mode only),
// loop, and volume by letting an OfflineAudioContext do the looping and
// any resampling. Returns null for mic mode or when no file is loaded.
export async function renderExportAudioBuffer(
  spec: ExportAudioSpec,
  durationSec: number
): Promise<AudioBuffer | null> {
  if (spec.mode !== "file" || !spec.file?.url || durationSec <= 0) return null;

  // Decode the source file. A throwaway AudioContext is only used to
  // decode; the deterministic render runs in an OfflineAudioContext.
  const resp = await fetch(spec.file.url);
  const encoded = await resp.arrayBuffer();
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const decodeCtx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(encoded.slice(0));
  } finally {
    void decodeCtx.close();
  }

  const sampleRate = decoded.sampleRate;
  const channels = Math.max(1, decoded.numberOfChannels);
  const frames = Math.max(1, Math.ceil(durationSec * sampleRate));
  const offline = new OfflineAudioContext(channels, frames, sampleRate);

  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.loop = spec.loop;
  if (spec.loop) {
    src.loopStart = 0;
    src.loopEnd = decoded.duration;
  }
  const gain = offline.createGain();
  gain.gain.value = spec.volume;
  src.connect(gain).connect(offline.destination);

  // start(when, offset): begin `offset` seconds into the buffer. Only sync
  // mode applies the start offset; free-run plays from 0. Wrap the offset
  // into the clip when looping so a large value stays valid.
  let offset = spec.sync ? spec.startOffset : 0;
  if (spec.loop && decoded.duration > 0) {
    offset = ((offset % decoded.duration) + decoded.duration) % decoded.duration;
  } else {
    offset = Math.max(0, offset);
  }
  src.start(0, offset);

  return await offline.startRendering();
}

// 16-bit PCM WAV bytes from an AudioBuffer — the ffmpeg path writes this
// into the wasm FS and muxes it as a second input.
export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(out);
}
