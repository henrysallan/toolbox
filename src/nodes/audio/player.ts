import type {
  AudioFileParamValue,
  AudioValue,
  NodeDefinition,
} from "@/engine/types";

// Player — url-backed buffer playback INSIDE the chain
// (specdocs/080826_audio-nodes.md). The processable sibling of Audio Source:
// Audio Source plays an HTMLAudioElement straight to the speakers (chains
// only wrap it through the one-way MediaElementSource door), while Player
// hands Tone the file URL and the whole signal lives in the chain from the
// first sample — rate/pitch, loop, and every downstream effect apply, and
// offline export decodes the same URL deterministically.
//
// The descriptor carries only the URL; the adapter's Tone.Player is SYNCED
// to the transport, so scene play/pause/seek drive playback (no element on
// the AudioValue — there is nothing element-direct about this node).

export const audioPlayerNode: NodeDefinition = {
  type: "audio-player",
  name: "Player",
  category: "audio",
  subcategory: "generator",
  description:
    "Play an audio file through the chain — unlike Audio Source, the signal is processable, so effects, rate changes, and export mixdown all apply. Audible while the timeline plays and the chain reaches the Output node's audio socket, a Layer Output's audio socket, or the Active node.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "file",
      label: "Audio file",
      type: "audio_file",
      default: null,
    },
    {
      name: "level",
      label: "Level",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.8,
    },
    {
      name: "rate",
      label: "Rate",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "loop",
      label: "Loop",
      type: "boolean",
      default: true,
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
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ params, nodeId }) {
    const paramFile = params.file as AudioFileParamValue | null | undefined;
    if (!paramFile?.url) {
      // No file picked (or the project just reloaded — file params don't
      // serialize). Emitting nothing keeps downstream chains empty rather
      // than feeding them a dead stage.
      return {};
    }
    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "generator",
        nodeId,
        gen: "player",
        params: {
          url: paramFile.url,
          level: (params.level as number) ?? 0.8,
          rate: (params.rate as number) ?? 1,
          loop: (params.loop as boolean) ?? true,
          offset: (params.start_offset as number) ?? 0,
        },
      },
    };
    return { primary: value };
  },
};
