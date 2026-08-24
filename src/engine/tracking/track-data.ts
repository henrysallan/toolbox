// Pure helpers over PointTrackerData / PlanarTrackerData. Every edit
// returns a NEW object with `rev` bumped from a module-level monotonic
// counter (not `rev + 1`) so undo/redo branches can't collide. Overlay
// and panel never mutate in place — cached outputs share structure.
// Spec: 082226_motion-tracking.md §4.1, §4.4.

import type {
  PlanarTrackerData,
  PointTrack,
  PointTrackerData,
  TrackSampleStatus,
} from "../types";

let nextRev = 1;
function bumpRev(): number {
  return nextRev++;
}

/** Identity-token used by evaluator `stableStringify`. Constant-cost. */
export function trackDataFingerprintToken(v: unknown): string | null {
  if (
    v != null &&
    typeof v === "object" &&
    (v as { kind?: unknown }).kind === "track_data" &&
    typeof (v as { rev?: unknown }).rev === "number"
  ) {
    return "trk:" + (v as { rev: number }).rev;
  }
  return null;
}

const POS_DECIMALS = 6;
const CONF_DECIMALS = 3;

function roundN(v: number, n: number): number {
  const p = 10 ** n;
  return Math.round(v * p) / p;
}

function compactPos(v: number): number {
  return roundN(v, POS_DECIMALS);
}

function compactConf(v: number): number {
  return roundN(v, CONF_DECIMALS);
}

export function emptyPointTrackerData(): PointTrackerData {
  return { kind: "track_data", version: 1, rev: bumpRev(), nextId: 1, tracks: [] };
}

export function asPointTrackerData(v: unknown): PointTrackerData {
  if (
    v &&
    typeof v === "object" &&
    (v as PointTrackerData).kind === "track_data" &&
    Array.isArray((v as PointTrackerData).tracks)
  ) {
    return v as PointTrackerData;
  }
  return emptyPointTrackerData();
}

export function emptyPlanarTrackerData(
  corners: [number, number][] = [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ]
): PlanarTrackerData {
  return {
    kind: "track_data",
    version: 1,
    rev: bumpRev(),
    ref: { frame: 0, corners: corners.map(([x, y]) => [compactPos(x), compactPos(y)]) },
    frames: [],
    corners: [],
    H: [],
    conf: [],
    status: [],
  };
}

export function defaultPointTrack(
  id: number,
  ref: { frame: number; x: number; y: number },
  sizes?: { patternW?: number; patternH?: number; searchW?: number; searchH?: number }
): PointTrack {
  const patternW = sizes?.patternW ?? 31;
  const patternH = sizes?.patternH ?? 31;
  const searchW = sizes?.searchW ?? 61;
  const searchH = sizes?.searchH ?? 61;
  return {
    id,
    name: `Track ${id}`,
    enabled: true,
    offset: [0, 0],
    ref: { frame: ref.frame, x: compactPos(ref.x), y: compactPos(ref.y) },
    patternW,
    patternH,
    searchW,
    searchH,
    frames: [],
    x: [],
    y: [],
    conf: [],
    status: [],
  };
}

function cloneTrack(t: PointTrack): PointTrack {
  return {
    ...t,
    offset: [t.offset[0], t.offset[1]],
    ref: { ...t.ref },
    frames: t.frames.slice(),
    x: t.x.slice(),
    y: t.y.slice(),
    rot: t.rot?.slice(),
    scale: t.scale?.slice(),
    conf: t.conf.slice(),
    status: t.status.slice(),
  };
}

export function addTrack(
  data: PointTrackerData,
  ref: { frame: number; x: number; y: number },
  sizes?: { patternW?: number; patternH?: number; searchW?: number; searchH?: number }
): PointTrackerData {
  const id = data.nextId;
  return {
    ...data,
    rev: bumpRev(),
    nextId: id + 1,
    tracks: [...data.tracks.map(cloneTrack), defaultPointTrack(id, ref, sizes)],
  };
}

export function removeTrack(data: PointTrackerData, id: number): PointTrackerData {
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.filter((t) => t.id !== id).map(cloneTrack),
  };
}

export function reorderTracks(
  data: PointTrackerData,
  order: number[]
): PointTrackerData {
  const byId = new Map(data.tracks.map((t) => [t.id, t]));
  const tracks: PointTrack[] = [];
  for (const id of order) {
    const t = byId.get(id);
    if (t) tracks.push(cloneTrack(t));
  }
  for (const t of data.tracks) {
    if (!order.includes(t.id)) tracks.push(cloneTrack(t));
  }
  return { ...data, rev: bumpRev(), tracks };
}

export function updateTrack(
  data: PointTrackerData,
  id: number,
  patch: Partial<Pick<PointTrack, "name" | "enabled" | "offset" | "patternW" | "patternH" | "searchW" | "searchH" | "ref">>
): PointTrackerData {
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.map((t) => {
      if (t.id !== id) return cloneTrack(t);
      const next = { ...cloneTrack(t), ...patch };
      if (patch.offset) next.offset = [compactPos(patch.offset[0]), compactPos(patch.offset[1])];
      if (patch.ref) {
        next.ref = {
          frame: patch.ref.frame,
          x: compactPos(patch.ref.x),
          y: compactPos(patch.ref.y),
        };
      }
      return next;
    }),
  };
}

export interface SampleWrite {
  x: number;
  y: number;
  conf: number;
  status: TrackSampleStatus;
  rot?: number;
  scale?: number;
}

function insertAt(track: PointTrack, frame: number, sample: SampleWrite): PointTrack {
  const t = cloneTrack(track);
  const i = lowerBound(t.frames, frame);
  const x = compactPos(sample.x);
  const y = compactPos(sample.y);
  const conf = compactConf(sample.conf);
  if (i < t.frames.length && t.frames[i] === frame) {
    t.x[i] = x;
    t.y[i] = y;
    t.conf[i] = conf;
    t.status[i] = sample.status;
    if (sample.rot !== undefined) {
      t.rot = t.rot ?? t.frames.map(() => 0);
      t.rot[i] = sample.rot;
    }
    if (sample.scale !== undefined) {
      t.scale = t.scale ?? t.frames.map(() => 1);
      t.scale[i] = sample.scale;
    }
    return t;
  }
  t.frames.splice(i, 0, frame);
  t.x.splice(i, 0, x);
  t.y.splice(i, 0, y);
  t.conf.splice(i, 0, conf);
  t.status.splice(i, 0, sample.status);
  if (t.rot) t.rot.splice(i, 0, sample.rot ?? 0);
  else if (sample.rot !== undefined) {
    t.rot = t.frames.map((_, k) => (k === i ? sample.rot! : 0));
  }
  if (t.scale) t.scale.splice(i, 0, sample.scale ?? 1);
  else if (sample.scale !== undefined) {
    t.scale = t.frames.map((_, k) => (k === i ? sample.scale! : 1));
  }
  return t;
}

export function upsertSample(
  data: PointTrackerData,
  id: number,
  frame: number,
  sample: SampleWrite
): PointTrackerData {
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.map((t) => (t.id === id ? insertAt(t, frame, sample) : cloneTrack(t))),
  };
}

export function setSampleManual(
  data: PointTrackerData,
  id: number,
  frame: number,
  x: number,
  y: number
): PointTrackerData {
  const track = data.tracks.find((t) => t.id === id);
  const i = track ? lowerBound(track.frames, frame) : -1;
  const hit = track && i >= 0 && i < track.frames.length && track.frames[i] === frame;
  return upsertSample(data, id, frame, {
    x,
    y,
    conf: hit ? track.conf[i]! : 1,
    status: 1,
    rot: hit ? track.rot?.[i] : undefined,
    scale: hit ? track.scale?.[i] : undefined,
  });
}

export function removeSample(
  data: PointTrackerData,
  id: number,
  frame: number
): PointTrackerData {
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.map((t) => {
      if (t.id !== id) return cloneTrack(t);
      const next = cloneTrack(t);
      const i = lowerBound(next.frames, frame);
      if (i >= next.frames.length || next.frames[i] !== frame) return next;
      next.frames.splice(i, 1);
      next.x.splice(i, 1);
      next.y.splice(i, 1);
      next.conf.splice(i, 1);
      next.status.splice(i, 1);
      next.rot?.splice(i, 1);
      next.scale?.splice(i, 1);
      return next;
    }),
  };
}

export type ClearMode = "all" | "after" | "before" | "lost";

export function clearRange(
  data: PointTrackerData,
  ids: number[],
  mode: ClearMode,
  playheadFrame = 0
): PointTrackerData {
  const want = new Set(ids);
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.map((t) => {
      if (!want.has(t.id)) return cloneTrack(t);
      if (mode === "all") {
        const next = cloneTrack(t);
        next.frames = [];
        next.x = [];
        next.y = [];
        next.conf = [];
        next.status = [];
        delete next.rot;
        delete next.scale;
        return next;
      }
      const keep: number[] = [];
      for (let i = 0; i < t.frames.length; i++) {
        const f = t.frames[i]!;
        const st = t.status[i]!;
        if (mode === "after" && f > playheadFrame) continue;
        if (mode === "before" && f < playheadFrame) continue;
        if (mode === "lost" && (st === 4 || st === 3)) continue;
        keep.push(i);
      }
      return gatherIndices(t, keep);
    }),
  };
}

function gatherIndices(t: PointTrack, keep: number[]): PointTrack {
  const next = cloneTrack(t);
  next.frames = keep.map((i) => t.frames[i]!);
  next.x = keep.map((i) => t.x[i]!);
  next.y = keep.map((i) => t.y[i]!);
  next.conf = keep.map((i) => t.conf[i]!);
  next.status = keep.map((i) => t.status[i]!);
  if (t.rot) next.rot = keep.map((i) => t.rot![i]!);
  if (t.scale) next.scale = keep.map((i) => t.scale![i]!);
  return next;
}

export function shiftSamplesAfter(
  data: PointTrackerData,
  id: number,
  fromFrame: number,
  dx: number,
  dy: number
): PointTrackerData {
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.map((t) => {
      if (t.id !== id) return cloneTrack(t);
      const next = cloneTrack(t);
      for (let i = 0; i < next.frames.length; i++) {
        if (next.frames[i]! >= fromFrame) {
          next.x[i] = compactPos(next.x[i]! + dx);
          next.y[i] = compactPos(next.y[i]! + dy);
          if (next.frames[i] === fromFrame) next.status[i] = 1;
        }
      }
      return next;
    }),
  };
}

export function replaceTrackSamples(
  data: PointTrackerData,
  id: number,
  track: PointTrack
): PointTrackerData {
  return {
    ...data,
    rev: bumpRev(),
    tracks: data.tracks.map((t) => (t.id === id ? cloneTrack(track) : cloneTrack(t))),
  };
}

export function upsertPlanarSample(
  data: PlanarTrackerData,
  frame: number,
  corners: number[],
  H: number[],
  conf: number,
  status: TrackSampleStatus
): PlanarTrackerData {
  const c8 = corners.slice(0, 8).map(compactPos);
  while (c8.length < 8) c8.push(0);
  const h9 = H.slice(0, 9);
  while (h9.length < 9) h9.push(0);
  const next: PlanarTrackerData = {
    ...data,
    rev: bumpRev(),
    frames: data.frames.slice(),
    corners: data.corners.slice(),
    H: data.H.slice(),
    conf: data.conf.slice(),
    status: data.status.slice(),
  };
  const i = lowerBound(next.frames, frame);
  const confR = compactConf(conf);
  if (i < next.frames.length && next.frames[i] === frame) {
    for (let k = 0; k < 8; k++) next.corners[i * 8 + k] = c8[k]!;
    for (let k = 0; k < 9; k++) next.H[i * 9 + k] = h9[k]!;
    next.conf[i] = confR;
    next.status[i] = status;
    return next;
  }
  next.frames.splice(i, 0, frame);
  next.corners.splice(i * 8, 0, ...c8);
  next.H.splice(i * 9, 0, ...h9);
  next.conf.splice(i, 0, confR);
  next.status.splice(i, 0, status);
  return next;
}

export function lowerBound(frames: readonly number[], frame: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]! < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sampleIndex(frames: readonly number[], frame: number): number {
  const i = lowerBound(frames, frame);
  return i < frames.length && frames[i] === frame ? i : -1;
}
