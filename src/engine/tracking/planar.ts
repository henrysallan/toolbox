// Planar tracker pipeline: Shi–Tomasi features inside the quad, each
// tracked with the point kernel (translate warp), RANSAC homography
// (ref → current, so no chaining drift), optional ESM polish.
// Spec: 082226_motion-tracking.md §5.2.

import type { GrayImage } from "./gray";
import { detectShiTomasi, type Feature } from "./features";
import {
  applyH,
  applyHToCorners,
  cornersCross,
  identityH,
  invertH,
  isDegenerateH,
  ransacHomography,
  type Homography,
} from "./homography";
import { refineEsm } from "./esm";
import { classicalBackend } from "./classical";
import type { TrackerHandle } from "./backend";

export interface PlanarFeature {
  handle: TrackerHandle;
  refX: number;
  refY: number;
  x: number;
  y: number;
  miss: number;
}

export interface PlanarHandle {
  refImg: GrayImage;
  refCorners: Array<[number, number]>;
  features: PlanarFeature[];
  H: Homography;
  featureCount: number;
  inlierPx: number;
  pattern: number;
}

export interface PlanarStepResult {
  H: Homography;
  corners: Array<[number, number]>;
  conf: number;
  lost: boolean;
}

export function seedPlanar(
  img: GrayImage,
  corners: Array<[number, number]>,
  opts?: { featureCount?: number; inlierPx?: number; pattern?: number }
): PlanarHandle {
  const featureCount = opts?.featureCount ?? 64;
  const inlierPx = opts?.inlierPx ?? 1.5;
  const pattern = opts?.pattern ?? 15;
  const feats = detectShiTomasi(img, { count: featureCount, quad: corners });
  const features: PlanarFeature[] = feats.map((f) => ({
    handle: classicalBackend.seed(img, f.x, f.y, {
      patternW: pattern,
      patternH: pattern,
      searchW: pattern + 24,
      searchH: pattern + 24,
      warp: "translate",
    }),
    refX: f.x,
    refY: f.y,
    x: f.x,
    y: f.y,
    miss: 0,
  }));
  return {
    refImg: img,
    refCorners: corners.map((c) => [c[0], c[1]] as [number, number]),
    features,
    H: identityH(),
    featureCount,
    inlierPx,
    pattern,
  };
}

export function stepPlanar(
  handle: PlanarHandle,
  img: GrayImage,
  opts?: { refine?: "none" | "esm"; lostBelow?: number }
): PlanarStepResult {
  const lostBelow = opts?.lostBelow ?? 0.3;
  const refine = opts?.refine ?? "esm";

  for (const f of handle.features) {
    const pred = applyH(handle.H, f.refX, f.refY);
    const search = Math.round(f.handle.searchW);
    f.handle.searchW = search;
    f.handle.searchH = search;
    const r = classicalBackend.step(f.handle, img, { x: pred[0], y: pred[1] });
    f.x = r.x;
    f.y = r.y;
    if (r.conf < 0.5) f.miss += 1;
    else f.miss = 0;
  }

  const live = handle.features.filter((f) => f.miss < 2);
  const src = live.map((f) => [f.refX, f.refY] as [number, number]);
  const dst = live.map((f) => [f.x, f.y] as [number, number]);
  const ransac = ransacHomography(src, dst, { threshold: handle.inlierPx });

  let H = ransac?.H ?? handle.H;
  let conf = ransac?.inlierRatio ?? 0;

  if (refine === "esm") {
    H = refineEsm(handle.refImg, img, H, handle.refCorners);
  }

  const corners = applyHToCorners(H, handle.refCorners);
  const lost =
    conf < lostBelow || isDegenerateH(H) || cornersCross(corners);

  // Drop persistent outliers; re-detect when inliers drop below half.
  if (ransac) {
    const inSet = new Set(ransac.inliers);
    handle.features = live.filter((_, i) => inSet.has(i) || live[i]!.miss === 0);
  } else {
    handle.features = live;
  }
  if (handle.features.length < handle.featureCount / 2 && !lost) {
    const more = detectShiTomasi(img, {
      count: handle.featureCount - handle.features.length,
      quad: corners,
    });
    const Hi = invertH(H);
    for (const f of more) {
      const ref = Hi ? applyH(Hi, f.x, f.y) : [f.x, f.y];
      handle.features.push({
        handle: classicalBackend.seed(img, f.x, f.y, {
          patternW: handle.pattern,
          patternH: handle.pattern,
          searchW: handle.pattern + 24,
          searchH: handle.pattern + 24,
          warp: "translate",
        }),
        refX: ref[0],
        refY: ref[1],
        x: f.x,
        y: f.y,
        miss: 0,
      });
    }
  }

  handle.H = H;
  return { H, corners, conf, lost };
}

export type { Feature };
