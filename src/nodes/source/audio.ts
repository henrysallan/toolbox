import type {
  AudioChainElementLeaf,
  AudioFileParamValue,
  AudioValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { requestMicrophone } from "@/lib/audio";

// Audio source. Two modes:
//
//   file       — user uploads a file; element plays synced to scene time.
//   microphone — persistent mic stream; element plays live.
//
// The node emits an AudioValue referencing its HTMLAudioElement. The
// element plays directly to the system's default output — no WebAudio
// routing in v1, so downstream processing nodes would need to attach
// their own analysers to `ctx.state`. Play/pause is gated on ctx.playing
// so the audio follows the scene's playback state; scrub also silences
// the mic (mic doesn't really "scrub" — the gate keeps things quiet).
//
// Speaker audibility is gated on routing: the element only un-mutes when
// this source's primary output is wired into the Output node's `audio`
// socket (ctx.audioRoutedToOutput, computed per-eval). When it's used
// only for data — e.g. amplitude driving a parameter — the element keeps
// advancing so that data stays live, but plays muted. Re-wiring takes
// effect on the next eval.
//
// Limitation: if the user disconnects Audio Source from the graph
// entirely mid-playback, its compute stops running and the element keeps
// playing briefly until the next param change or delete. Known issue;
// acceptable for v1. Workaround is to stop scene playback first.

interface AudioState {
  // Microphone-mode state only — file mode keeps its element on the
  // param value itself so the element survives across re-evals without
  // touching ctx.state.
  micElement: HTMLAudioElement | null;
  micStream: MediaStream | null;
  micRequested: boolean;
  micError: string | null;
  // Cached element-leaf chain descriptor (080826_audio-nodes.md). The
  // descriptor must be IDENTITY-stable across evals while the element is
  // unchanged — this node is stable:false, so without the cache every
  // frame would mint a new object and defeat the audio reconciler's
  // identity short-circuit.
  leaf: AudioChainElementLeaf | null;
}

function ensureState(ctx: RenderContext, nodeId: string): AudioState {
  const key = `audio-source:${nodeId}`;
  const existing = ctx.state[key] as AudioState | undefined;
  if (existing) return existing;
  const s: AudioState = {
    micElement: null,
    micStream: null,
    micRequested: false,
    micError: null,
    leaf: null,
  };
  ctx.state[key] = s;
  return s;
}

// Element-leaf descriptor for this source, reused while the element (and
// url) are unchanged. Lets downstream chain nodes (Filter, Audio Merge)
// embed this source; the reconciler wraps the element via the shared
// element-source registry only when a chain actually processes it, so a
// bare Source → Output wire keeps today's element-direct path.
function ensureLeaf(
  state: AudioState,
  nodeId: string,
  element: HTMLMediaElement,
  source: "file" | "mic",
  url: string | null,
  // Offline playback hints (080926 M-B) — snapshotted params so an export
  // can re-create the audible behavior from the url alone.
  hints?: { sync: boolean; loop: boolean; startOffset: number; volume: number }
): AudioChainElementLeaf {
  const prev = state.leaf;
  if (
    prev &&
    prev.element === element &&
    prev.url === url &&
    prev.source === source &&
    prev.sync === hints?.sync &&
    prev.loop === hints?.loop &&
    prev.startOffset === hints?.startOffset &&
    prev.volume === hints?.volume
  ) {
    return prev;
  }
  const leaf: AudioChainElementLeaf = {
    kind: "element",
    nodeId,
    element,
    source,
    url,
    ...(hints ?? {}),
  };
  state.leaf = leaf;
  return leaf;
}

export const audioSourceNode: NodeDefinition = {
  type: "audio-source",
  name: "Audio Source",
  category: "audio",
  subcategory: "generator",
  description:
    "Play an audio file or pipe microphone input into the graph. Connect the output to the Output node's audio socket to hear it during playback.",
  backend: "webgl2",
  // stable:false — the element's currentTime / mic stream changes out-
  // of-band with params. Always re-evaluate so play/pause tracks
  // ctx.playing.
  stable: false,
  inputs: [],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["file", "microphone"],
      default: "file",
    },
    {
      name: "file",
      label: "Audio file",
      type: "audio_file",
      default: null,
      visibleIf: (p) => p.mode === "file",
    },
    {
      name: "volume",
      label: "Volume",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "loop",
      label: "Loop",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.mode === "file",
    },
    {
      name: "sync_to_scene_time",
      label: "Sync to scene time",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.mode === "file",
    },
    {
      name: "start_offset",
      label: "Start offset (s)",
      type: "scalar",
      min: 0,
      max: 600,
      softMax: 30,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.mode === "file",
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const mode = (params.mode as string) ?? "file";
    const state = ensureState(ctx, nodeId);
    const volume = Math.max(0, Math.min(1, (params.volume as number) ?? 1));

    // Speakers only when this source is wired into the Output node's audio
    // socket. Otherwise the element still advances (so amplitude/data stays
    // live for downstream nodes) but is muted. Absent set (non-eval
    // callers) defaults to audible.
    const audible = ctx.audioRoutedToOutput?.has(nodeId) ?? true;

    if (mode === "microphone") {
      // Lazily request mic access. The first compute fires
      // getUserMedia — browser shows its permission prompt. Subsequent
      // evals reuse the stream. If the user denies, we record the
      // error and stop trying.
      if (!state.micRequested && !state.micError) {
        state.micRequested = true;
        requestMicrophone()
          .then(({ element, stream }) => {
            state.micElement = element;
            state.micStream = stream;
            element.volume = volume;
            window.dispatchEvent(new Event("pipeline-bump"));
          })
          .catch((err) => {
            state.micError = err instanceof Error ? err.message : String(err);
            window.dispatchEvent(new Event("pipeline-bump"));
          });
      }
      const el = state.micElement;
      if (!el) {
        // Nothing to emit until the stream resolves. Returning no
        // primary keeps downstream nodes from seeing a stale element.
        return {};
      }
      el.volume = volume;
      // Mic is always "live" — gate audibility on ctx.playing so a
      // paused scene goes quiet without terminating the stream, and on
      // routing so an unconnected mic monitors silently. Layer pre-roll
      // counts as not-playing (nothing may be audible before the cut).
      el.muted = !ctx.playing || !!ctx.preroll || !audible;
      return {
        primary: {
          kind: "audio",
          element: el,
          source: "mic",
          // Mic has no offline form — url stays null and exports render
          // this leaf silent.
          chain: ensureLeaf(state, nodeId, el, "mic", null),
        } satisfies AudioValue,
      };
    }

    // ---- file mode ----
    const paramFile = params.file as AudioFileParamValue | null | undefined;
    if (!paramFile?.element) {
      return {};
    }
    const el = paramFile.element;
    el.volume = volume;
    el.loop = !!params.loop;
    // Keep advancing for data, but only reach the speakers when routed to
    // the Output node's audio socket.
    el.muted = !audible;

    const sync = !!params.sync_to_scene_time;
    const startOffset = (params.start_offset as number) ?? 0;

    if (sync) {
      // Seek to scene time (+ offset). Nudge only when drift is > 100 ms
      // so we don't stutter on every frame. Play/pause follows the
      // scene's RAF — when the user hits Play the element resumes from
      // the current scene position; when they Pause it stops.
      const dur = Math.max(0.0001, el.duration || paramFile.duration || 1);
      let target = ctx.time + startOffset;
      if (params.loop) {
        target = ((target % dur) + dur) % dur;
      } else {
        target = Math.max(0, Math.min(dur - 0.0001, target));
      }
      if (Math.abs(el.currentTime - target) > 0.1) {
        try {
          el.currentTime = target;
        } catch {
          // Some browsers throw if metadata isn't fully decoded yet.
          // Next eval will retry.
        }
      }
      // Layer pre-roll holds the element paused (parked at the entry
      // point by the seek above) so audio never leads the cut.
      if (ctx.playing && !ctx.preroll) {
        if (el.paused) {
          el.play().catch(() => {
            // Autoplay can be blocked until first user gesture; retry
            // next frame after the user interacts.
          });
        }
      } else {
        if (!el.paused) el.pause();
      }
    } else {
      // Free-run mode: pressing scene Play starts the element, Pause
      // stops it. No time syncing beyond that. Layer pre-roll counts as
      // paused so audio never leads the cut.
      if (ctx.playing && !ctx.preroll && el.paused) {
        el.play().catch(() => {});
      } else if ((!ctx.playing || ctx.preroll) && !el.paused) {
        el.pause();
      }
    }

    return {
      primary: {
        kind: "audio",
        element: el,
        source: "file",
        chain: ensureLeaf(state, nodeId, el, "file", paramFile.url ?? null, {
          sync,
          loop: !!params.loop,
          startOffset,
          volume,
        }),
      } satisfies AudioValue,
    };
  },

  dispose(ctx, nodeId) {
    const key = `audio-source:${nodeId}`;
    const state = ctx.state[key] as AudioState | undefined;
    if (state?.micStream) {
      for (const track of state.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    if (state?.micElement) {
      try {
        state.micElement.pause();
      } catch {
        // ignore
      }
    }
    delete ctx.state[key];
  },
};
