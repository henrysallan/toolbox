// convert/coords.ts (spec 091926_after-effects-handoff.md §4.1, Appendix B):
// canvas01 ↔ layer px round trips at three aspects, the sim-kernel mapping the
// spline rasterizer uses, uv01's Y-up inversion, stroke units, degrees, and
// live corners → Round Corners or baked fillets.

import { makeChecker } from "./harness.mts";
import { aspectCorrectY } from "@/engine/aspect";
import { subpathToCanvasPx } from "@/engine/sim-kernel";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import type { SplineSubpath } from "@/engine/types";
import {
  aeRoundCornersPath,
  canvasDeltaToPx,
  canvasToPx,
  canvasToUv01,
  degToRad,
  pathDeviationPx,
  planCorners,
  pxToCanvas,
  pxToUv01,
  radToDeg,
  splineToAePaths,
  strokeWidthToPx,
  subpathToAePath,
  uv01ToCanvas,
  uv01ToPx,
  widthRelativeToPx,
  type AeCanvas,
} from "@/lib/ae-export/convert";

const ASPECTS: AeCanvas[] = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
  { width: 1000, height: 1000 },
];

function square(cx: number, cy: number, h: number, r?: number): SplineSubpath {
  const a = (x: number, y: number) => ({ pos: [x, y] as [number, number], ...(r !== undefined ? { cornerRadius: r } : {}) });
  return { closed: true, anchors: [a(cx - h, cy - h), a(cx + h, cy - h), a(cx + h, cy + h), a(cx - h, cy + h)] };
}

export default async function run(): Promise<number> {
  const c = makeChecker("convert-coords");
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  for (const cv of ASPECTS) {
    const tag = `${cv.width}×${cv.height}`;
    let rt = 0;
    let appB = 0;
    let uv = 0;
    let uvCanvas = 0;
    for (let i = 0; i < 400; i++) {
      const p: [number, number] = [-0.5 + 2 * rnd(), -0.5 + 2 * rnd()];
      const px = canvasToPx(p, cv);
      const back = pxToCanvas(px, cv);
      rt = Math.max(rt, Math.abs(back[0] - p[0]), Math.abs(back[1] - p[1]));
      // Appendix B: px_y = aspectCorrectY(y, W/H)·H = H/2 + (y − 0.5)·W.
      appB = Math.max(appB, Math.abs(px[1] - aspectCorrectY(p[1], cv.width / cv.height) * cv.height), Math.abs(px[1] - (cv.height / 2 + (p[1] - 0.5) * cv.width)), Math.abs(px[0] - p[0] * cv.width));
      const q = uv01ToPx(p, cv);
      const qb = pxToUv01(q, cv);
      uv = Math.max(uv, Math.abs(qb[0] - p[0]), Math.abs(qb[1] - p[1]));
      // uv01 → canvas01 → px lands where uv01 → px does; and back.
      const viaCanvas = canvasToPx(uv01ToCanvas(p, cv), cv);
      const cb = canvasToUv01(uv01ToCanvas(p, cv), cv);
      uvCanvas = Math.max(uvCanvas, Math.abs(viaCanvas[0] - q[0]), Math.abs(viaCanvas[1] - q[1]), Math.abs(cb[0] - p[0]), Math.abs(cb[1] - p[1]));
    }
    c.check(`${tag}: canvas01 → px → canvas01 round trip (${rt.toExponential(1)})`, rt < 1e-12);
    c.check(`${tag}: px matches Appendix B's formulas (${appB.toExponential(1)} px)`, appB < 1e-9);
    c.check(`${tag}: uv01 → px → uv01 round trip (${uv.toExponential(1)})`, uv < 1e-12);
    c.check(`${tag}: uv01 via canvas01 lands on uv01's px, and round-trips (${uvCanvas.toExponential(1)})`, uvCanvas < 1e-9);
    c.check(`${tag}: uv01 is Y-up — v = 1 is the top row`, uv01ToPx([0, 1], cv)[1] === 0 && uv01ToPx([0, 0], cv)[1] === cv.height);
    c.check(`${tag}: canvas center maps to the comp center`, canvasToPx([0.5, 0.5], cv)[0] === cv.width / 2 && canvasToPx([0.5, 0.5], cv)[1] === cv.height / 2);
    c.check(`${tag}: deltas and width-relative radii scale by W on both axes`, canvasDeltaToPx([0.1, 0.2], cv)[1] === 0.2 * cv.width && widthRelativeToPx(0.25, cv) === 0.25 * cv.width);

    // Splines: subpathToAePath ≡ the rasterizer's subpathToCanvasPx.
    const sub: SplineSubpath = {
      closed: true,
      anchors: [
        { pos: [0.2, 0.3], outHandle: [0.1, -0.05] },
        { pos: [0.7, 0.25], inHandle: [-0.1, 0], outHandle: [0.05, 0.2] },
        { pos: [0.6, 0.8] },
        { pos: [0.25, 0.7], inHandle: [0.02, 0.1] },
      ],
    };
    const ae = subpathToAePath(sub, cv);
    const ref = subpathToCanvasPx(sub, cv.width, cv.height);
    let d = 0;
    ref.anchors.forEach((a, i) => {
      d = Math.max(d, Math.abs(a.pos[0] - ae.vertices[i][0]), Math.abs(a.pos[1] - ae.vertices[i][1]));
      const ih = a.inHandle ?? [0, 0];
      const oh = a.outHandle ?? [0, 0];
      d = Math.max(d, Math.abs(ih[0] - ae.inTangents[i][0]), Math.abs(ih[1] - ae.inTangents[i][1]), Math.abs(oh[0] - ae.outTangents[i][0]), Math.abs(oh[1] - ae.outTangents[i][1]));
    });
    c.check(`${tag}: spline → AePath ≡ sim-kernel subpathToCanvasPx (${d.toExponential(1)} px), missing handles = [0, 0], closed kept`, d < 1e-9 && ae.closed && ae.inTangents[0][0] === 0 && ae.outTangents[2][1] === 0);
    const multi = splineToAePaths({ subpaths: [sub, { ...sub, closed: false }] }, cv);
    c.check(`${tag}: one AePath per subpath`, multi.length === 2 && !multi[1].closed && multi[1].vertices.length === 4);
  }

  // Stroke units (stroke-units.ts) and angles.
  const hd = { width: 1920, height: 1080 };
  c.near("stroke px passes through", strokeWidthToPx(4, "px", hd), 4, 0);
  c.near("stroke % resolves against W (2% of 1920 = 38.4 px)", strokeWidthToPx(2, "%", hd), 38.4, 1e-12);
  c.near("π rad = 180°", radToDeg(Math.PI), 180, 1e-12);
  c.near("deg → rad → deg", radToDeg(degToRad(37.25)), 37.25, 1e-12);

  // --- live corners --------------------------------------------------------
  for (const cv of ASPECTS) {
    const tag = `${cv.width}×${cv.height}`;
    // A square with one radius everywhere: AE's Round Corners lands on toolbox's
    // fillet (90° corners, uncapped insets) well within planCorners' 0.25 px.
    // AE's handle is 0.55 of the inset (measured, spec §14), the circle's
    // 0.5523: 0.06–0.12 px apart at these radii (51–96 px).
    const sq = planCorners({ subpaths: [square(0.5, 0.5, 0.2, 0.05)] }, cv);
    c.check(`${tag}: uniform radius on a square → Round Corners (${sq.kind}, ${sq.kind === "uniform" ? sq.maxDeviationPx.toFixed(4) + " px" : ""})`, sq.kind === "uniform" && sq.radius === 0.05 * cv.width && sq.maxDeviationPx < 0.13);
    c.check(`${tag}: …with the raw (unrounded) vertices`, sq.paths[0].vertices.length === 4);
  }
  // Triangles are 60° corners: AE's 0.55 handle (lottie's model) is not toolbox's circular arc.
  const tri: SplineSubpath = {
    closed: true,
    anchors: [
      { pos: [0.5, 0.2], cornerRadius: 0.06 },
      { pos: [0.8, 0.72], cornerRadius: 0.06 },
      { pos: [0.2, 0.72], cornerRadius: 0.06 },
    ],
  };
  const tp = planCorners({ subpaths: [tri] }, hd);
  c.check(`60° corners bake (${tp.kind === "baked" ? tp.reason : tp.kind})`, tp.kind === "baked");
  const want = splineToAePaths({ subpaths: roundCornersPerAnchor([tri]) }, hd);
  c.check("baked fillets ≡ roundCornersPerAnchor → px", tp.kind === "baked" && pathDeviationPx(tp.paths[0], want[0]) < 1e-9);
  const mixed = square(0.5, 0.5, 0.2, 0.05);
  mixed.anchors[2].cornerRadius = 0.08;
  c.check("different radii bake", planCorners({ subpaths: [mixed] }, hd).kind === "baked");
  const partial = square(0.5, 0.5, 0.2, 0.05);
  delete partial.anchors[1].cornerRadius;
  c.check("a corner without a radius bakes (AE would round it)", planCorners({ subpaths: [partial] }, hd).kind === "baked");
  const chamfer = square(0.5, 0.5, 0.2, 0.05);
  chamfer.anchors[0].cornerStyle = "chamfer";
  const cp = planCorners({ subpaths: [chamfer] }, hd);
  c.check(`chamfer style bakes (${cp.kind === "baked" ? cp.reason : cp.kind})`, cp.kind === "baked");
  // A long thin rectangle whose radius is capped by the short edge: toolbox
  // caps both insets, AE only the short-edge one.
  const thin: SplineSubpath = {
    closed: true,
    anchors: [
      { pos: [0.1, 0.45], cornerRadius: 0.08 },
      { pos: [0.9, 0.45], cornerRadius: 0.08 },
      { pos: [0.9, 0.55], cornerRadius: 0.08 },
      { pos: [0.1, 0.55], cornerRadius: 0.08 },
    ],
  };
  const thp = planCorners({ subpaths: [thin] }, hd);
  c.check(`a radius capped by the short edge bakes (${thp.kind === "baked" ? thp.reason : thp.kind})`, thp.kind === "baked");
  c.check("no live corners → raw paths", planCorners({ subpaths: [square(0.5, 0.5, 0.2)] }, hd).kind === "none");
  // An open path's endpoints are not corners for either side.
  const open: SplineSubpath = { closed: false, anchors: [{ pos: [0.1, 0.1] }, { pos: [0.5, 0.5], cornerRadius: 0.04 }, { pos: [0.9, 0.1] }] };
  const op = planCorners({ subpaths: [open] }, hd);
  c.check(`open path with one inner corner → Round Corners (${op.kind})`, op.kind === "uniform");
  const r = aeRoundCornersPath(subpathToAePath(open, hd), 0.04 * hd.width);
  c.check("AE's Round Corners leaves open endpoints alone and splits the inner corner", r.vertices.length === 4);
  return c.failures;
}
