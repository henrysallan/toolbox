// Tracker backend interface. The session doesn't care which implementation
// produced a sample — classical (v1) or a deferred deep backend occupy the
// same three calls. Spec: 082226_motion-tracking.md §7.3.

import type { GrayImage } from "./gray";
import type { WarpType } from "./lk";

export type { GrayImage };

export interface SeedOpts {
  patternW: number;
  patternH: number;
  searchW: number;
  searchH: number;
  warp?: WarpType;
}

export interface TrackerHandle {
  x: number;
  y: number;
  rot: number;
  scale: number;
  patternW: number;
  patternH: number;
  searchW: number;
  searchH: number;
  warp: WarpType;
  /** Template pixels (patternW × patternH). */
  pattern: Float32Array;
}

export interface StepResult {
  x: number;
  y: number;
  rot?: number;
  scale?: number;
  conf: number;
  sharpness: number;
}

export interface PointTrackerBackend {
  seed(img: GrayImage, x: number, y: number, opts: SeedOpts): TrackerHandle;
  step(
    handle: TrackerHandle,
    img: GrayImage,
    predicted: { x: number; y: number }
  ): StepResult;
  regrab(handle: TrackerHandle, img: GrayImage, x: number, y: number): void;
}
