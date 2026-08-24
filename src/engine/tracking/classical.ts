// Classical point-tracker backend: ZNCC coarse search + Lucas–Kanade
// sub-pixel refinement over an image pyramid. Deterministic, no GL.
// Spec: 082226_motion-tracking.md §7.3.

import type {
  PointTrackerBackend,
  SeedOpts,
  StepResult,
  TrackerHandle,
} from "./backend";
import { grabPatch, patchToImage, type GrayImage } from "./gray";
import { precomputeLk, refineLk, type WarpType } from "./lk";
import { buildPyramid, pyramidLevelCount } from "./pyramid";
import { znccAt } from "./zncc";

function odd(n: number): number {
  const v = Math.max(3, Math.round(n));
  return v % 2 === 0 ? v + 1 : v;
}

export const classicalBackend: PointTrackerBackend = {
  seed(img, x, y, opts) {
    const patternW = odd(opts.patternW);
    const patternH = odd(opts.patternH);
    const searchW = Math.max(patternW + 8, Math.round(opts.searchW));
    const searchH = Math.max(patternH + 8, Math.round(opts.searchH));
    const warp: WarpType = opts.warp ?? "translate";
    return {
      x,
      y,
      rot: 0,
      scale: 1,
      patternW,
      patternH,
      searchW,
      searchH,
      warp,
      pattern: grabPatch(img, x, y, patternW, patternH),
    };
  },

  step(handle, img, predicted) {
    const { patternW, patternH, searchW, searchH, warp, pattern } = handle;
    let x = predicted.x;
    let y = predicted.y;
    let sw = searchW;
    let sh = searchH;

    // Pyramid only when the search window is large enough that a full-res
    // ZNCC would be expensive. Coarse peak recenters a tighter fine search.
    const levels = pyramidLevelCount(Math.max(searchW, searchH));
    if (levels > 1 && Math.max(searchW, searchH) > 80) {
      const pyr = buildPyramid(img, levels);
      const coarsest = pyr.length - 1;
      const scale = 1 / 2 ** coarsest;
      const pwC = Math.max(3, odd(Math.round(patternW * scale)));
      const phC = Math.max(3, odd(Math.round(patternH * scale)));
      const patC = downsamplePattern(pattern, patternW, patternH, pwC, phC);
      const coarse = znccAt(
        pyr[coarsest]!,
        x * scale,
        y * scale,
        patC,
        pwC,
        phC,
        Math.max(pwC + 4, Math.round(searchW * scale)),
        Math.max(phC + 4, Math.round(searchH * scale))
      );
      x = coarse.x / scale;
      y = coarse.y / scale;
      sw = Math.min(searchW, patternW + 24);
      sh = Math.min(searchH, patternH + 24);
    }

    const fine = znccAt(img, x, y, pattern, patternW, patternH, sw, sh);
    x = fine.x;
    y = fine.y;
    const conf = fine.conf;
    const sharpness = fine.sharpness;

    const templ = precomputeLk(patchToImage(pattern, patternW, patternH), warp);
    if (templ) {
      const lk = refineLk(img, templ, x, y, {
        rot: handle.rot,
        scale: handle.scale,
      });
      x = lk.x;
      y = lk.y;
      handle.rot = lk.rot;
      handle.scale = lk.scale;
    }
    handle.x = x;
    handle.y = y;
    return {
      x,
      y,
      rot: warp === "translate" ? undefined : handle.rot,
      scale: warp === "translate" || warp === "translate_rotate" ? undefined : handle.scale,
      conf,
      sharpness,
    };
  },

  regrab(handle, img, x, y) {
    handle.pattern = grabPatch(img, x, y, handle.patternW, handle.patternH);
    handle.x = x;
    handle.y = y;
  },
};

function downsamplePattern(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Float32Array {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = (x * sw) / dw;
      const y0 = (y * sh) / dh;
      const x1 = ((x + 1) * sw) / dw;
      const y1 = ((y + 1) * sh) / dh;
      let s = 0;
      let n = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1) && yy < sh; yy++) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1) && xx < sw; xx++) {
          s += src[yy * sw + xx]!;
          n++;
        }
      }
      out[y * dw + x] = n ? s / n : 0;
    }
  }
  return out;
}

export function forwardBackwardError(
  backend: PointTrackerBackend,
  handle: TrackerHandle,
  imgA: GrayImage,
  imgB: GrayImage,
  xa: number,
  ya: number,
  xb: number,
  yb: number
): number {
  const saved = {
    pattern: new Float32Array(handle.pattern),
    x: handle.x,
    y: handle.y,
    rot: handle.rot,
    scale: handle.scale,
    searchW: handle.searchW,
    searchH: handle.searchH,
  };
  // Appearance-based FB: grab at the forward result on B, track back to A.
  backend.regrab(handle, imgB, xb, yb);
  const back = backend.step(handle, imgA, { x: xb, y: yb });
  handle.pattern = saved.pattern;
  handle.x = saved.x;
  handle.y = saved.y;
  handle.rot = saved.rot;
  handle.scale = saved.scale;
  handle.searchW = saved.searchW;
  handle.searchH = saved.searchH;
  return Math.hypot(back.x - xa, back.y - ya);
}

export type { StepResult, TrackerHandle, SeedOpts };
