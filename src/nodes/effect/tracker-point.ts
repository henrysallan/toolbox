import type {
  NodeDefinition,
  OutputSocketDef,
  SocketValue,
} from "@/engine/types";
import { EMPTY_POINTS, makePoints } from "@/engine/points";
import {
  TRACKING_PREPROCESS_PARAMS,
  preprocessTrackingImage,
  trackingMaskToImage,
} from "@/engine/tracking/preprocess";
import { asPointTrackerData } from "@/engine/tracking/track-data";
import {
  firstSample,
  sampleTrackAtFrame,
  smoothTrack,
} from "@/engine/tracking/sample";
import type { SmoothMode } from "@/engine/tracking/filters";

export const TRACKER_POINT_TYPE = "tracker-point";

export const trackerPointNode: NodeDefinition = {
  type: TRACKER_POINT_TYPE,
  name: "Point Tracker",
  category: "point",
  subcategory: "generator",
  searchAliases: ["tracker", "track", "matchmove", "point track", "ncc"],
  description:
    "Track N image features across frames. Place tracks on the preview, then step or run the transport in the Parameters tab. Outputs live points (and per-track vec2 sockets) from authored track data — tracking itself runs in the editor, not in compute.",
  backend: "webgl2",
  stable: false,
  noMaskInput: true,
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "mask", type: "mask", required: false },
  ],
  params: [
    {
      name: "pattern_size",
      label: "Pattern",
      type: "scalar",
      min: 9,
      max: 201,
      step: 2,
      default: 31,
      group: "pattern",
      groupHeader: true,
    },
    {
      name: "search_size",
      label: "Search",
      type: "scalar",
      min: 17,
      max: 511,
      softMax: 255,
      step: 2,
      default: 61,
      group: "pattern",
    },
    {
      name: "warp",
      label: "Warp",
      type: "enum",
      options: [
        "translate",
        "translate_rotate",
        "translate_scale",
        "translate_rotate_scale",
      ],
      default: "translate",
      group: "pattern",
    },
    {
      name: "predict",
      label: "Predict",
      type: "boolean",
      default: true,
      group: "tracking",
      groupHeader: true,
    },
    {
      name: "regrab",
      label: "Re-grab",
      type: "enum",
      options: ["never", "adaptive", "every_frame", "every_n"],
      default: "adaptive",
      group: "tracking",
    },
    {
      name: "regrab_n",
      label: "Re-grab every N",
      type: "scalar",
      min: 1,
      max: 30,
      step: 1,
      default: 5,
      group: "tracking",
      visibleIf: (p) => p.regrab === "every_n",
    },
    {
      name: "lost_below",
      label: "Lost below",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
      group: "tracking",
    },
    {
      name: "verify",
      label: "Forward-backward",
      type: "boolean",
      default: false,
      group: "tracking",
    },
    {
      name: "stop_when_lost",
      label: "Stop when lost",
      type: "boolean",
      default: true,
      group: "tracking",
    },
    ...TRACKING_PREPROCESS_PARAMS,
    {
      name: "smooth_radius",
      label: "Smooth radius",
      type: "scalar",
      min: 0,
      max: 48,
      step: 1,
      default: 0,
      group: "output",
      groupHeader: true,
    },
    {
      name: "smooth_mode",
      label: "Smooth mode",
      type: "enum",
      options: ["gaussian", "savgol"],
      default: "gaussian",
      group: "output",
      visibleIf: (p) => (p.smooth_radius as number) > 0,
    },
    {
      name: "gap_fill",
      label: "Gap fill",
      type: "enum",
      options: ["hold", "interpolate"],
      default: "hold",
      group: "output",
    },
    {
      name: "reference",
      label: "Reference",
      type: "enum",
      options: ["none", "first_sample"],
      default: "none",
      group: "output",
    },
    {
      name: "confidence_sockets",
      label: "Confidence sockets",
      type: "boolean",
      default: false,
      group: "output",
    },
    {
      name: "tracks",
      label: "Tracks",
      type: "track_data",
      default: { kind: "track_data", version: 1, rev: 0, nextId: 1, tracks: [] },
      hidden: true,
    },
    {
      name: "place_mode",
      label: "Place",
      type: "boolean",
      default: false,
      hidden: true,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [
    { name: "image", type: "image", description: "Input passthrough, or the tracking image when View tracking image is on." },
    { name: "path", type: "spline", description: "Raw trajectories, one open subpath per track." },
  ],

  resolveAuxOutputs(params): OutputSocketDef[] {
    const tracks = asPointTrackerData(params.tracks);
    const reference = (params.reference as string) ?? "none";
    const confSock = !!params.confidence_sockets;
    const out: OutputSocketDef[] = [
      { name: "image", type: "image" },
      { name: "path", type: "spline" },
    ];
    for (const t of tracks.tracks) {
      out.push({
        name: `position_${t.id}`,
        label: t.name || `Track ${t.id}`,
        type: "vec2",
      });
      if (reference === "first_sample") {
        out.push({
          name: `offset_${t.id}`,
          label: `${t.name || `Track ${t.id}`} offset`,
          type: "vec2",
        });
      }
      if (confSock) {
        out.push({
          name: `confidence_${t.id}`,
          label: `${t.name || `Track ${t.id}`} conf`,
          type: "scalar",
        });
      }
    }
    return out;
  },

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const src = inputs.image;
    const tracks = asPointTrackerData(params.tracks);
    const gapFill = ((params.gap_fill as string) ?? "hold") === "interpolate" ? "interpolate" : "hold";
    const smoothRadius = Math.max(0, Math.round((params.smooth_radius as number) ?? 0));
    const smoothMode = ((params.smooth_mode as string) ?? "gaussian") as SmoothMode;
    const reference = (params.reference as string) ?? "none";
    const viewTracking = !!params.view_tracking_image;
    const tpf = ctx.ticksPerFrame || 1000;
    const frame = Math.floor(ctx.tick / tpf);

    const cacheKey = `tracker-smooth:${nodeId}`;
    type Cache = { rev: number; radius: number; mode: string; maps: Map<number, ReturnType<typeof smoothTrack>> };
    let cache = ctx.state[cacheKey] as Cache | undefined;
    if (
      !cache ||
      cache.rev !== tracks.rev ||
      cache.radius !== smoothRadius ||
      cache.mode !== smoothMode
    ) {
      const maps = new Map<number, ReturnType<typeof smoothTrack>>();
      for (const t of tracks.tracks) {
        maps.set(t.id, smoothTrack(t, smoothRadius, smoothMode));
      }
      cache = { rev: tracks.rev, radius: smoothRadius, mode: smoothMode, maps };
      ctx.state[cacheKey] = cache;
    }

    const enabled = tracks.tracks.filter((t) => t.enabled);
    const n = enabled.length;
    const pts = n === 0 ? EMPTY_POINTS : makePoints(n, {
      withRotations: true,
      withScales: true,
      withGroupIndices: true,
    });
    const confAttr = n > 0 ? new Float32Array(n) : new Float32Array(0);
    const aux: Record<string, SocketValue> = {};

    let ei = 0;
    for (let i = 0; i < tracks.tracks.length; i++) {
      const t = tracks.tracks[i]!;
      const smoothed = cache.maps.get(t.id);
      const s = sampleTrackAtFrame(t, frame, gapFill, smoothed);
      const x = s?.x ?? t.ref.x + t.offset[0];
      const y = s?.y ?? t.ref.y + t.offset[1];
      const rot = s?.rot ?? 0;
      const scale = s?.scale ?? 1;
      const conf = s?.conf ?? 0;
      aux[`position_${t.id}`] = { kind: "vec2", value: [x, y] };
      if (reference === "first_sample") {
        const first = firstSample(t);
        const fx = (first?.x ?? t.ref.x) + t.offset[0];
        const fy = (first?.y ?? t.ref.y) + t.offset[1];
        aux[`offset_${t.id}`] = { kind: "vec2", value: [x - fx, y - fy] };
      }
      if (params.confidence_sockets) {
        aux[`confidence_${t.id}`] = { kind: "scalar", value: conf };
      }
      if (!t.enabled) continue;
      pts.positions[ei * 2] = x;
      pts.positions[ei * 2 + 1] = y;
      pts.rotations![ei] = rot;
      pts.scales![ei * 2] = scale;
      pts.scales![ei * 2 + 1] = scale;
      pts.groupIndices![ei] = i;
      confAttr[ei] = conf;
      ei++;
    }
    if (n > 0) {
      pts.attributes = { confidence: { arity: 1, data: confAttr } };
    }

    const wantPath = !consumedOutputs || consumedOutputs.has("aux:path");
    if (wantPath) {
      aux.path = {
        kind: "spline",
        subpaths: tracks.tracks.map((t, i) => ({
          closed: false,
          groupIndex: i,
          anchors: t.frames.map((_, k) => ({
            pos: [t.x[k]! + t.offset[0], t.y[k]! + t.offset[1]] as [number, number],
          })),
        })),
      };
    }

    if (src?.kind === "image") {
      if (viewTracking) {
        const mask = inputs.mask?.kind === "mask" ? inputs.mask : null;
        const tracking = preprocessTrackingImage(ctx, src, params, mask);
        aux.image = trackingMaskToImage(ctx, tracking);
        ctx.releaseTexture(tracking.texture);
      } else {
        aux.image = src;
      }
    }

    return { primary: pts, aux };
  },
};
