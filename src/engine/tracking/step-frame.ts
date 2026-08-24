// One-frame point-track step: ZNCC+LK over a gray region, online lost
// handling (predict, grow search, re-acquire). Pure besides the GrayImage
// it is handed. Spec: 082226_motion-tracking.md §9.2 online.

import type { PointTrack, PointTrackerData, TrackSampleStatus } from "../types";
import { authoredToCanvasPx, canvasPxToAuthored } from "./space";
import { upsertSample, sampleIndex } from "./track-data";
import { classicalBackend, forwardBackwardError } from "./classical";
import type { TrackerHandle } from "./backend";
import type { WarpType } from "./lk";
import { predictPosition } from "./filters";
import type { GrayImage } from "./gray";
import { makeGray } from "./gray";

export interface TrackStepSettings {
  warp: WarpType;
  predict: boolean;
  regrab: "never" | "adaptive" | "every_frame" | "every_n";
  regrabN: number;
  lostBelow: number;
  verify: boolean;
  stopWhenLost: boolean;
}

export interface TrackRuntime {
  handle: TrackerHandle | null;
  predictedStreak: number;
  searchScale: number;
  lastFrame: number | null;
}

export function emptyRuntime(): TrackRuntime {
  return { handle: null, predictedStreak: 0, searchScale: 1, lastFrame: null };
}

export interface StepFrameInput {
  data: PointTrackerData;
  trackIds: number[];
  frame: number;
  dir: 1 | -1;
  img: GrayImage;
  canvasW: number;
  canvasH: number;
  settings: TrackStepSettings;
  runtimes: Map<number, TrackRuntime>;
  prevImg?: GrayImage;
}

export interface StepFrameResult {
  data: PointTrackerData;
  lostIds: number[];
  confMean: number;
}

function odd(n: number): number {
  const v = Math.max(9, Math.round(n));
  return v % 2 === 0 ? v + 1 : v;
}

export function stepTracksOnImage(input: StepFrameInput): StepFrameResult {
  const { img, canvasW, canvasH, settings, dir } = input;
  let data = input.data;
  const lostIds: number[] = [];
  let confSum = 0;
  let confN = 0;

  for (const id of input.trackIds) {
    const track = data.tracks.find((t) => t.id === id);
    if (!track || !track.enabled) continue;
    let rt = input.runtimes.get(id);
    if (!rt) {
      rt = emptyRuntime();
      input.runtimes.set(id, rt);
    }

    const seedAuth = seedAuthored(track, input.frame, dir);
    const [sx, sy] = authoredToCanvasPx(seedAuth.x, seedAuth.y, canvasW, canvasH);
    if (!rt.handle) {
      rt.handle = classicalBackend.seed(img, sx, sy, {
        patternW: odd(track.patternW),
        patternH: odd(track.patternH),
        searchW: Math.max(odd(track.searchW), odd(track.patternW) + 8),
        searchH: Math.max(odd(track.searchH), odd(track.patternH) + 8),
        warp: settings.warp,
      });
    }

    let predX = sx;
    let predY = sy;
    if (settings.predict && track.frames.length >= 1) {
      const p = predictPosition(
        track.frames,
        track.x.map((x, i) => authoredToCanvasPx(x, track.y[i]!, canvasW, canvasH)[0]),
        track.y.map((y, i) => authoredToCanvasPx(track.x[i]!, y, canvasW, canvasH)[1]),
        track.status,
        rt.lastFrame ?? input.frame - dir,
        input.frame,
        rt.predictedStreak
      );
      predX = p.x;
      predY = p.y;
    }

    rt.handle.searchW = Math.round(
      Math.min(track.searchW * 3, track.searchW * rt.searchScale)
    );
    rt.handle.searchH = rt.handle.searchW;
    rt.handle.warp = settings.warp;

    const result = classicalBackend.step(rt.handle, img, { x: predX, y: predY });
    let conf = result.conf;
    let sharpness = result.sharpness;
    if (settings.verify && input.prevImg && rt.lastFrame != null) {
      const fb = forwardBackwardError(
        classicalBackend,
        rt.handle,
        input.prevImg,
        img,
        predX,
        predY,
        result.x,
        result.y
      );
      if (fb > 1) conf = Math.min(conf, settings.lostBelow - 0.01);
    }

    const lost =
      conf < settings.lostBelow || sharpness < 1.15;
    let status: TrackSampleStatus = 0;
    let ox = result.x;
    let oy = result.y;
    if (lost) {
      rt.predictedStreak++;
      rt.searchScale = Math.min(3, rt.searchScale * 1.5);
      const p = predictPosition(
        track.frames,
        track.x.map((x, i) => authoredToCanvasPx(x, track.y[i]!, canvasW, canvasH)[0]),
        track.y.map((y, i) => authoredToCanvasPx(track.x[i]!, y, canvasW, canvasH)[1]),
        track.status,
        rt.lastFrame ?? input.frame - dir,
        input.frame,
        rt.predictedStreak
      );
      ox = p.x;
      oy = p.y;
      status = 3;
      lostIds.push(id);
    } else {
      const reacq = rt.predictedStreak > 0 && conf >= settings.lostBelow + 0.1;
      rt.predictedStreak = 0;
      rt.searchScale = 1;
      status = 0;
      if (
        settings.regrab === "every_frame" ||
        (settings.regrab === "every_n" &&
          input.frame % Math.max(1, settings.regrabN) === 0) ||
        (settings.regrab === "adaptive" &&
          conf < 0.85 &&
          conf >= settings.lostBelow) ||
        reacq
      ) {
        classicalBackend.regrab(rt.handle, img, ox, oy);
      }
    }

    const [ax, ay] = canvasPxToAuthored(ox, oy, canvasW, canvasH);
    data = upsertSample(data, id, input.frame, {
      x: ax,
      y: ay,
      conf,
      status,
      rot: result.rot,
      scale: result.scale,
    });
    rt.lastFrame = input.frame;
    confSum += conf;
    confN++;
  }

  return {
    data,
    lostIds,
    confMean: confN ? confSum / confN : 0,
  };
}

function seedAuthored(
  track: PointTrack,
  frame: number,
  dir: 1 | -1
): { x: number; y: number } {
  const hit = sampleIndex(track.frames, frame);
  if (hit >= 0) return { x: track.x[hit]!, y: track.y[hit]! };
  if (track.frames.length === 0) return { x: track.ref.x, y: track.ref.y };
  // Nearest sample in the opposite direction of travel (the one we just came from).
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < track.frames.length; i++) {
    const d = (frame - track.frames[i]!) * dir;
    if (d >= 0 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD === Infinity) {
    const i = dir > 0 ? 0 : track.frames.length - 1;
    return { x: track.x[i]!, y: track.y[i]! };
  }
  return { x: track.x[best]!, y: track.y[best]! };
}

/** Build a GrayImage from a region Float32Array (R-channel, 0..1). */
export function grayFromRegion(
  data: Float32Array,
  w: number,
  h: number
): GrayImage {
  if (data.length === w * h) return { data, width: w, height: h };
  const out = makeGray(w, h);
  const n = Math.min(w * h, Math.floor(data.length / 4) * 4 === data.length && data.length === w * h * 4 ? w * h : data.length);
  if (data.length === w * h * 4) {
    for (let i = 0; i < w * h; i++) out.data[i] = data[i * 4]!;
  } else {
    out.data.set(data.subarray(0, n));
  }
  return out;
}

export function grayFromFullFrame(
  data: Float32Array,
  w: number,
  h: number
): GrayImage {
  return grayFromRegion(data, w, h);
}
