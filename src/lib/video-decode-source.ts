// WebCodecs decode access to a Video Source's file, via mediabunny (already
// a dependency for the WebCodecs export path). The Video Source node uses
// it on the PAUSED path only — scrubbing and frame stepping — to fill a
// window of decoded frames around the playhead (engine/video-frame-cache.ts,
// spec 090426_video-frame-cache.md). Playback, audio and offline export
// keep using the <video> element.
//
// One source per VideoFileParamValue, created lazily on first request and
// never awaited by the node: compute calls ensureVideoDecodeSource() and
// keeps drawing from the element until `ready` flips, at which point the
// init fires a pipeline-bump so a paused editor re-evaluates. Any failure
// (no WebCodecs, an undecodable codec, a container mediabunny can't read,
// a cross-origin URL that refuses range requests) parks the entry as
// `unavailable` and the node silently stays on the element path.
//
// Timestamps: mediabunny reports presentation timestamps in the track's
// own timeline; HTMLMediaElement.currentTime puts the first frame at 0.
// `firstTs` is subtracted from every sample so cache timestamps share the
// element's origin. mediabunny is imported dynamically so neither the
// editor nor the exported app pays for it until a video is scrubbed.
import type { VideoFileParamValue } from "@/engine/types";
import type { Input, InputVideoTrack, VideoSample, VideoSampleSink } from "mediabunny";

export interface VideoDecodeInfo {
  // Display size after rotation — what a drawn frame measures.
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  // Presentation timestamp of the first frame in the track's timeline.
  firstTs: number;
  duration: number;
}

export interface VideoDecodeSource {
  readonly info: VideoDecodeInfo;
  // Frames in presentation order with `start <= ts < end` — ts in the
  // element's origin (first frame = 0). The iterator decodes from the
  // preceding keyframe internally and discards what falls before `start`,
  // so the caller pays uploads only for the window. Each yielded sample
  // MUST be closed by the consumer (the decoder's frame pool stalls
  // otherwise), and only one iterator should run at a time per source.
  samples(start: number, end: number): AsyncGenerator<VideoSample, void, unknown>;
  dispose(): void;
}

interface Entry {
  status: "init" | "ready" | "unavailable";
  source: VideoDecodeSource | null;
}

const entries = new WeakMap<VideoFileParamValue, Entry>();

function bump(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

// Kick (once) the async init for a file. Returns immediately.
export function ensureVideoDecodeSource(v: VideoFileParamValue): void {
  if (entries.has(v)) return;
  const entry: Entry = { status: "init", source: null };
  entries.set(v, entry);
  void openSource(v)
    .then((source) => {
      // The param value may have been disposed while we were opening.
      if (entries.get(v) !== entry) {
        source?.dispose();
        return;
      }
      if (source) {
        entry.source = source;
        entry.status = "ready";
      } else {
        entry.status = "unavailable";
      }
      bump();
    })
    .catch((err) => {
      if (entries.get(v) === entry) entry.status = "unavailable";
      console.warn("video-decode-source: unavailable —", err);
      bump();
    });
}

// The ready source, or null while initializing / when unavailable.
export function getVideoDecodeSource(
  v: VideoFileParamValue
): VideoDecodeSource | null {
  const e = entries.get(v);
  return e?.status === "ready" ? e.source : null;
}

export function videoDecodeStatus(
  v: VideoFileParamValue
): "none" | "init" | "ready" | "unavailable" {
  return entries.get(v)?.status ?? "none";
}

// Called from disposeVideoFile (lib/video.ts) when a file value is
// replaced or cleared. Node dispose only drops the node's own textures —
// the source belongs to the param value, which may outlive the node.
export function disposeVideoDecodeSource(v: VideoFileParamValue): void {
  const e = entries.get(v);
  if (!e) return;
  entries.delete(v);
  e.source?.dispose();
}

async function openSource(
  v: VideoFileParamValue
): Promise<VideoDecodeSource | null> {
  if (typeof VideoDecoder === "undefined") return null;
  const MB = await import("mediabunny");
  let source: InstanceType<typeof MB.BlobSource> | InstanceType<typeof MB.UrlSource>;
  if (v.url.startsWith("blob:")) {
    // An ObjectURL over the picked (or transcoded) File — fetching it
    // hands back a Blob over the same bytes, no copy.
    const blob = await (await fetch(v.url)).blob();
    source = new MB.BlobSource(blob);
  } else {
    // Cloud media streams with range requests; the media domain's CORS
    // policy allows GET from any origin (spec 081626 §7.4).
    source = new MB.UrlSource(v.url);
  }
  const input: Input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  let track: InputVideoTrack | null = null;
  try {
    track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const [firstTs, duration] = await Promise.all([
      track.getFirstTimestamp(),
      track.computeDuration(),
    ]);
    const sink: VideoSampleSink = new MB.VideoSampleSink(track);
    const info: VideoDecodeInfo = {
      width: track.displayWidth,
      height: track.displayHeight,
      rotation: track.rotation,
      firstTs,
      duration: duration - firstTs,
    };
    return {
      info,
      async *samples(start, end) {
        for await (const sample of sink.samples(start + firstTs, end + firstTs)) {
          // Re-origin in place so consumers never see the raw timeline.
          sample.setTimestamp(sample.timestamp - firstTs);
          yield sample;
        }
      },
      dispose() {
        input.dispose();
      },
    };
  } catch (err) {
    input.dispose();
    throw err;
  }
}
