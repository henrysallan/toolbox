// Sample a PointTrack at an integer scene frame. Binary-search the sparse
// arrays; exact hit uses that sample, a miss follows gap_fill. Smoothing
// is applied to the full arrays once (caller caches) and passed in.
// Spec: 082226_motion-tracking.md §5.1, §9.1.

import type { PointTrack, TrackSampleStatus } from "../types";
import { lowerBound, sampleIndex } from "./track-data";
import {
  smoothArrays,
  type SampleArrays,
  type SmoothMode,
} from "./filters";

export function trackToArrays(track: PointTrack): SampleArrays {
  return {
    frames: track.frames,
    x: track.x,
    y: track.y,
    rot: track.rot,
    scale: track.scale,
    conf: track.conf,
    status: track.status,
  };
}

export function smoothTrack(
  track: PointTrack,
  radius: number,
  mode: SmoothMode
): SampleArrays {
  const arrays = trackToArrays(track);
  if (radius <= 0 || track.frames.length === 0) return arrays;
  return smoothArrays(arrays, radius, mode);
}

export interface TrackSample {
  x: number;
  y: number;
  rot: number;
  scale: number;
  conf: number;
  status: TrackSampleStatus;
  held: boolean;
}

export function sampleTrackAtFrame(
  track: PointTrack,
  frame: number,
  gapFill: "hold" | "interpolate",
  smoothed?: SampleArrays
): TrackSample | null {
  const frames = track.frames;
  if (frames.length === 0) {
    return {
      x: track.ref.x + track.offset[0],
      y: track.ref.y + track.offset[1],
      rot: 0,
      scale: 1,
      conf: 0,
      status: 4,
      held: true,
    };
  }
  const src = smoothed ?? trackToArrays(track);
  const hit = sampleIndex(frames, frame);
  if (hit >= 0) {
    return withOffset(track, {
      x: src.x[hit]!,
      y: src.y[hit]!,
      rot: src.rot?.[hit] ?? 0,
      scale: src.scale?.[hit] ?? 1,
      conf: track.conf[hit]!,
      status: track.status[hit]!,
      held: false,
    });
  }
  const i = lowerBound(frames, frame);
  const prev = i - 1;
  const next = i < frames.length ? i : -1;
  if (gapFill === "interpolate" && prev >= 0 && next >= 0) {
    const t0 = frames[prev]!;
    const t1 = frames[next]!;
    const u = t1 === t0 ? 0 : (frame - t0) / (t1 - t0);
    return withOffset(track, {
      x: src.x[prev]! + (src.x[next]! - src.x[prev]!) * u,
      y: src.y[prev]! + (src.y[next]! - src.y[prev]!) * u,
      rot: (src.rot?.[prev] ?? 0) + ((src.rot?.[next] ?? 0) - (src.rot?.[prev] ?? 0)) * u,
      scale: (src.scale?.[prev] ?? 1) + ((src.scale?.[next] ?? 1) - (src.scale?.[prev] ?? 1)) * u,
      conf: Math.min(track.conf[prev]!, track.conf[next]!),
      status: 2,
      held: false,
    });
  }
  const use = prev >= 0 ? prev : next;
  if (use < 0) return null;
  return withOffset(track, {
    x: src.x[use]!,
    y: src.y[use]!,
    rot: src.rot?.[use] ?? 0,
    scale: src.scale?.[use] ?? 1,
    conf: use === prev ? track.conf[use]! : 0,
    status: use === prev ? track.status[use]! : 4,
    held: true,
  });
}

function withOffset(track: PointTrack, s: TrackSample): TrackSample {
  return {
    ...s,
    x: s.x + track.offset[0],
    y: s.y + track.offset[1],
  };
}

export function firstSample(track: PointTrack): { x: number; y: number } | null {
  if (track.frames.length === 0) return null;
  return { x: track.x[0]!, y: track.y[0]! };
}

export const TRACK_PALETTE = [
  "#60a5fa",
  "#f472b6",
  "#34d399",
  "#facc15",
  "#fb923c",
  "#a78bfa",
  "#22d3ee",
  "#f87171",
];

export function trackColor(index: number): string {
  return TRACK_PALETTE[((index % TRACK_PALETTE.length) + TRACK_PALETTE.length) % TRACK_PALETTE.length]!;
}
