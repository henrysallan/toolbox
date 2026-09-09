// WebCodecs decode access to a Video Source's file, via mediabunny (already
// a dependency for the WebCodecs export path). The frame store
// (video-frame-store.ts) uses it on the PAUSED path only — scrubbing and
// frame stepping — to fill a window of decoded frames around the playhead
// (specs 090426_video-frame-cache.md, 090526_video-scrub-optimizations.md).
// Playback, audio and offline export keep using the <video> element.
//
// One source per VideoFileParamValue, created lazily on first request and
// never awaited by the node: compute calls ensureVideoDecodeSource() and
// keeps drawing from the element until `ready` flips, at which point the
// init fires a pipeline-bump so a paused editor re-evaluates. Any failure
// (no WebCodecs — which also means an insecure context —, an undecodable
// codec, a container mediabunny can't read, a cross-origin URL that
// refuses range requests) parks the entry as `unavailable` and the node
// silently stays on the element path.
//
// Timestamps: mediabunny reports presentation timestamps in the track's
// own timeline; HTMLMediaElement.currentTime puts the first frame at 0.
// `firstTs` is subtracted from every sample so cache timestamps share the
// element's origin. mediabunny is imported dynamically so neither the
// editor nor the exported app pays for it until a video is scrubbed.
//
// Decoder proxy (M4): on platforms that register a ScrubProxyProvider
// (the Electron build — ffmpeg-static), a source whose long side exceeds
// VIDEO_CACHE_MAX_DIM or whose keyframe interval is long asks for a 1080p
// all-intra re-encode and, once it exists, decodes from that instead:
// every cold miss then starts at the previous frame instead of a keyframe
// up to 250 frames back. The element never sees the proxy. Proxy frames
// are a re-encode, so the store marks them non-exact and the element
// refines the picture when the playhead rests.
import type { VideoFileParamValue } from "./types";
import type {
  EncodedPacketSink,
  Input,
  InputVideoTrack,
  VideoSample,
  VideoSampleSink,
} from "mediabunny";
import { VIDEO_CACHE_MAX_DIM } from "./video-frame-cache";

export interface VideoDecodeInfo {
  // Display size after rotation — what a drawn frame measures.
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  // Presentation timestamp of the first frame in the track's timeline.
  firstTs: number;
  duration: number;
  // Average frame rate (packets per second) — sizes GOP windows.
  fps: number;
}

export interface VideoDecodeSource {
  // The original file's geometry (what the element shows).
  readonly info: VideoDecodeInfo;
  // Geometry of what samples() yields right now — the original, or the
  // proxy once one is attached.
  readonly frameInfo: VideoDecodeInfo;
  // True once frames come from a re-encoded proxy (never pixel-exact).
  readonly proxy: boolean;
  // Frames in presentation order with `start <= ts < end` — ts in the
  // element's origin (first frame = 0). The iterator decodes from the
  // preceding keyframe internally and discards what falls before `start`,
  // so the caller pays uploads only for the window. Each yielded sample
  // MUST be closed by the consumer (the decoder's frame pool stalls
  // otherwise), and only one iterator should run at a time per source.
  samples(start: number, end: number): AsyncGenerator<VideoSample, void, unknown>;
  // The GOP containing media time `t`: [keyframe ≤ t, next keyframe or
  // duration). Null when the packet index can't answer.
  gopAround(t: number): Promise<{ start: number; end: number } | null>;
  dispose(): void;
}

// A byte-range reader over a proxy file living wherever the platform put
// it (a temp path on desktop). Sizes are bytes; ranges are [start, end).
export interface ScrubProxyHandle {
  size: number;
  read(start: number, end: number): Promise<ArrayBuffer>;
  dispose(): void;
}

export type ScrubProxyProvider = (
  file: VideoFileParamValue,
  info: VideoDecodeInfo
) => Promise<ScrubProxyHandle | null>;

// GOP longer than this (seconds) qualifies a source for a proxy even when
// it is small enough to cache exact — the cold-miss cost is the keyframe
// distance, not the pixel count.
export const PROXY_GOP_SECS = 2;

let proxyProvider: ScrubProxyProvider | null = null;

// Registered by the platform layer (lib/video.ts on the native build).
// Engine code never imports the platform — invariant #1.
export function setScrubProxyProvider(p: ScrubProxyProvider | null): void {
  proxyProvider = p;
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
// replaced or cleared. Node dispose only releases the node's use of the
// shared frame store — the source belongs to the param value, which may
// outlive the node.
export function disposeVideoDecodeSource(v: VideoFileParamValue): void {
  const e = entries.get(v);
  if (!e) return;
  entries.delete(v);
  e.source?.dispose();
}

type MB = typeof import("mediabunny");

interface Opened {
  input: Input;
  track: InputVideoTrack;
  sink: VideoSampleSink;
  packets: EncodedPacketSink;
  info: VideoDecodeInfo;
}

async function openInput(
  MB: MB,
  source: ConstructorParameters<typeof MB.Input>[0]["source"]
): Promise<Opened | null> {
  const input: Input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const [firstTs, duration, stats] = await Promise.all([
      track.getFirstTimestamp(),
      track.computeDuration(),
      track.computePacketStats(200).catch(() => null),
    ]);
    return {
      input,
      track,
      sink: new MB.VideoSampleSink(track),
      packets: new MB.EncodedPacketSink(track),
      info: {
        width: track.displayWidth,
        height: track.displayHeight,
        rotation: track.rotation,
        firstTs,
        duration: duration - firstTs,
        fps: stats?.averagePacketRate ?? 30,
      },
    };
  } catch (err) {
    input.dispose();
    throw err;
  }
}

async function openSource(
  v: VideoFileParamValue
): Promise<VideoDecodeSource | null> {
  if (typeof VideoDecoder === "undefined") return null;
  const MB = await import("mediabunny");
  const isBlob = v.url.startsWith("blob:");
  // An ObjectURL over the picked (or transcoded) File — fetching it hands
  // back a Blob over the same bytes, no copy. Cloud media streams with
  // range requests; the media domain's CORS policy allows GET from any
  // origin (spec 081626 §7.4).
  const original = await openInput(
    MB,
    isBlob
      ? new MB.BlobSource(await (await fetch(v.url)).blob())
      : new MB.UrlSource(v.url)
  );
  if (!original) return null;

  let current: Opened = original;
  let proxied: Opened | null = null;
  let proxyHandle: ScrubProxyHandle | null = null;
  let disposed = false;

  const source: VideoDecodeSource = {
    info: original.info,
    get frameInfo() {
      return current.info;
    },
    get proxy() {
      return current !== original;
    },
    async *samples(start, end) {
      const o = current;
      const t0 = o.info.firstTs;
      for await (const sample of o.sink.samples(start + t0, end + t0)) {
        // Re-origin in place so consumers never see the raw timeline.
        sample.setTimestamp(sample.timestamp - t0);
        yield sample;
      }
    },
    async gopAround(t) {
      const o = current;
      try {
        const key = await o.packets.getKeyPacket(t + o.info.firstTs, {
          metadataOnly: true,
        });
        if (!key) return null;
        const next = await o.packets.getNextKeyPacket(key, { metadataOnly: true });
        return {
          start: key.timestamp - o.info.firstTs,
          end: next ? next.timestamp - o.info.firstTs : o.info.duration,
        };
      } catch {
        return null;
      }
    },
    dispose() {
      disposed = true;
      original.input.dispose();
      proxied?.input.dispose();
      proxyHandle?.dispose();
    },
  };

  // Proxy (M4): decided after the source is usable so the first scrub
  // never waits on ffmpeg. Local files only — a cloud clip's bytes are not
  // here to transcode.
  if (proxyProvider && isBlob) {
    void (async () => {
      try {
        if (!(await wantsProxy(source))) return;
        const handle = await proxyProvider!(v, original.info);
        if (!handle || disposed) {
          handle?.dispose();
          return;
        }
        const opened = await openInput(
          MB,
          new MB.StreamSource({
            getSize: () => handle.size,
            read: async (s, e) => new Uint8Array(await handle.read(s, e)),
            maxCacheSize: 32 * 1024 * 1024,
            prefetchProfile: "fileSystem",
          })
        );
        if (!opened || disposed) {
          opened?.input.dispose();
          handle.dispose();
          return;
        }
        proxied = opened;
        proxyHandle = handle;
        current = opened;
        bump();
      } catch (err) {
        console.warn("video-decode-source: proxy skipped —", err);
      }
    })();
  }

  return source;
}

// A proxy pays off when the cache can't be exact anyway (source larger
// than the cache cap) or when cold misses are dominated by keyframe
// distance (long GOP).
async function wantsProxy(source: VideoDecodeSource): Promise<boolean> {
  const { width, height, duration } = source.info;
  if (Math.max(width, height) > VIDEO_CACHE_MAX_DIM) return true;
  const gop = await source.gopAround(Math.min(duration / 2, 1));
  return !!gop && gop.end - gop.start > PROXY_GOP_SECS;
}
