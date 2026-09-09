// Guards Image Trace: SVG→spline mapping (pixel Y-down → canvas01),
// fill color/driver, binarize-over-white, and the vendored VTracer WASM
// glue. Potrace (esm-potrace-wasm) is not imported here — its Node ESM
// path requires("node:fs") and blows up under tsx.
//
//   npx tsx scripts/check-image-trace.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";

const g = globalThis as any;
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: () => ({ getContext: () => null, style: {} }) };
g.navigator ??= { userAgent: "node" };

import type { NodeOutput, RenderContext, SplineValue } from "@/engine/types";
import { coerceValue } from "@/engine/coerce";
import { aspectUncorrectY } from "@/engine/aspect";
import {
  binarizeRgba,
  extractSvgPaths,
  fitTraceSize,
  initVtracerFromBytes,
  invertRgba,
  parseFillColor,
  svgToSpline,
  traceRgba,
  type ImageTraceOptions,
} from "@/engine/image-trace";
import { imageTraceNode } from "@/nodes/effect/image-trace";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function vtracerOpts(
  extra: Partial<ImageTraceOptions> = {}
): ImageTraceOptions {
  return {
    engine: "vtracer",
    invert: false,
    threshold: 0.5,
    turdsize: 2,
    alphamax: 1,
    opttolerance: 0.2,
    turnpolicy: "minority",
    clustering: "color",
    hierarchical: "stacked",
    filterSpeckle: 4,
    colorPrecision: 6,
    layerDifference: 16,
    cornerThreshold: 60,
    pathMode: "spline",
    ...extra,
  };
}

// ---- 1. fill parsing ----------------------------------------------------
{
  const black = parseFillColor("#000000");
  check("parseFillColor #000", close(black[0], 0) && close(black[2], 0));
  const red = parseFillColor("#f00");
  check("parseFillColor #f00", close(red[0], 1) && close(red[1], 0));
  const lime = parseFillColor("#00ff00");
  check("parseFillColor #00ff00", close(lime[1], 1) && close(lime[0], 0));
  check("parseFillColor none is black", parseFillColor("none")[0] === 0);
  const rgb = parseFillColor("rgb(255, 128, 0)");
  check(
    "parseFillColor rgb()",
    close(rgb[0], 1) && close(rgb[1], 128 / 255, 1e-4)
  );
}

{
  const paths = extractSvgPaths(
    `<svg><path d="M0 0 L1 0" fill="#ff0000"/><path style="fill:#00ff00" d="M0 1 L1 1"/></svg>`
  );
  check("extractSvgPaths finds 2 paths", paths.length === 2);
  check("extractSvgPaths fill attr", close(paths[0]?.fill[0] ?? -1, 1));
  check("extractSvgPaths style fill", close(paths[1]?.fill[1] ?? -1, 1));
  check("extractSvgPaths empty SVG", extractSvgPaths("<svg></svg>").length === 0);
}

// ---- 2. fit / binarize / invert ----------------------------------------
{
  check("fitTraceSize under cap is identity", (() => {
    const s = fitTraceSize(100, 80, 512);
    return s.w === 100 && s.h === 80;
  })());
  check("fitTraceSize scales the long edge to max_size", (() => {
    const s = fitTraceSize(1000, 500, 512);
    return s.w === 512 && s.h === 256;
  })());
}

{
  const src = new Uint8ClampedArray([
    0, 0, 0, 255, // opaque black → foreground
    255, 255, 255, 255, // opaque white → background
    0, 0, 0, 0, // transparent black → composite white → background
  ]);
  const bin = binarizeRgba(src, 0.5);
  check("binarize opaque black is fg (0)", bin[0] === 0);
  check("binarize opaque white is bg (255)", bin[4] === 255);
  check("binarize transparent is bg (255)", bin[8] === 255);
  const inv = invertRgba(src);
  check("invertRgba flips RGB only", inv[0] === 255 && inv[3] === 255);
}

// ---- 3. SVG → canvas01 mapping -----------------------------------------
{
  // 32×32 image, left-half rect. Square canvas → UV y is y/imgH.
  const svg = `<svg><path d="M 0 0 L 16 0 L 16 32 L 0 32 Z" fill="#000000"/></svg>`;
  const s = svgToSpline(svg, 32, 32, 32, 32);
  check("svgToSpline square: one closed subpath", s.subpaths.length === 1 && s.subpaths[0].closed);
  const xs = s.subpaths[0]?.anchors.map((a) => a.pos[0]) ?? [];
  const ys = s.subpaths[0]?.anchors.map((a) => a.pos[1]) ?? [];
  check(
    "svgToSpline square: x in [0, 0.5]",
    xs.length >= 4 && xs.every((x) => x >= -1e-6 && x <= 0.5 + 1e-6)
  );
  check(
    "svgToSpline square: y spans [0, 1]",
    ys.some((y) => close(y, 0)) && ys.some((y) => close(y, 1))
  );
  const fill = s.subpaths[0]?.attrs?.color;
  check(
    "svgToSpline stamps attrs.color black",
    Array.isArray(fill) && close(fill[0], 0) && close(fill[1], 0)
  );
  check("svgToSpline driver is Rec.709 of black", close(s.subpaths[0]?.driver ?? 1, 0));
}

{
  // Same pixel rect on a 16:9 canvas: y is aspect-uncorrected so overlay
  // matches Rasterize/Stroke (text marching-squares / scatter-points).
  const svg = `<svg><path d="M 0 0 L 16 0 L 16 32 L 0 32 Z" fill="#ff0000"/></svg>`;
  const canvasW = 1920;
  const canvasH = 1080;
  const aspect = canvasW / canvasH;
  const s = svgToSpline(svg, 32, 32, canvasW, canvasH);
  const top = aspectUncorrectY(0, aspect);
  const bot = aspectUncorrectY(1, aspect);
  const ys = s.subpaths[0]?.anchors.map((a) => a.pos[1]) ?? [];
  check(
    "svgToSpline landscape: y uses aspectUncorrectY",
    ys.some((y) => close(y, top)) && ys.some((y) => close(y, bot))
  );
  const fill = s.subpaths[0]?.attrs?.color;
  check(
    "svgToSpline stamps attrs.color red",
    Array.isArray(fill) && close(fill[0], 1) && close(fill[1], 0)
  );
  check(
    "svgToSpline driver is Rec.709 of red",
    close(s.subpaths[0]?.driver ?? 0, 0.2126)
  );
}

{
  const empty = svgToSpline("", 32, 32, 32, 32);
  check("svgToSpline empty string → no subpaths", empty.subpaths.length === 0);
  const noPath = svgToSpline("<svg></svg>", 32, 32, 32, 32);
  check("svgToSpline empty SVG → no subpaths", noPath.subpaths.length === 0);
}

{
  // Cubic handle mapping: relative handles survive the pixel→authored map.
  const svg = `<svg><path d="M 0 8 C 0 0 16 0 16 8" fill="#000"/></svg>`;
  const s = svgToSpline(svg, 32, 32, 32, 32);
  const a0 = s.subpaths[0]?.anchors[0];
  const a1 = s.subpaths[0]?.anchors[1];
  check(
    "svgToSpline cubic start",
    !!a0 && close(a0.pos[0], 0) && close(a0.pos[1], 8 / 32)
  );
  check(
    "svgToSpline cubic outHandle is relative",
    !!a0?.outHandle && close(a0.outHandle[0], 0) && close(a0.outHandle[1], -8 / 32)
  );
  check(
    "svgToSpline cubic inHandle is relative",
    !!a1?.inHandle && close(a1.inHandle[0], 0) && close(a1.inHandle[1], -8 / 32)
  );
}

// ---- 4. node empty-input (no GL) ---------------------------------------
{
  const ctx = {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
    allocImage: () => ({ kind: "image", width: 1920, height: 1080, texture: {} }),
    clearTarget: () => {},
  } as unknown as RenderContext;
  const coerced = coerceValue(undefined, "image", ctx);
  const out = imageTraceNode.compute({
    inputs: { image: coerced },
    auxIn: {},
    params: { mode: "potrace" },
    ctx,
    nodeId: "trace",
  }) as NodeOutput;
  const spline = out.primary as SplineValue | undefined;
  check(
    "compute missing image → empty spline",
    spline?.kind === "spline" && spline.subpaths.length === 0
  );
}

// ---- 5. VTracer WASM (committed public/ binary) ------------------------
{
  const wasmPath = path.join(
    process.cwd(),
    "public/wasm/vtracer/vtracer_wasm_bg.wasm"
  );
  await initVtracerFromBytes(readFileSync(wasmPath));

  const w = 32;
  const h = 32;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const black = x < w / 2;
      rgba[i] = black ? 0 : 255;
      rgba[i + 1] = black ? 0 : 255;
      rgba[i + 2] = black ? 0 : 255;
      rgba[i + 3] = 255;
    }
  }

  const spline = await traceRgba(rgba, w, h, w, h, vtracerOpts());
  check(
    "vtracer color-cluster emits at least one subpath",
    spline.subpaths.length >= 1,
    `got ${spline.subpaths.length}`
  );
  const blackSubs = spline.subpaths.filter((sub) => {
    const c = sub.attrs?.color;
    return Array.isArray(c) && c[0] < 0.15 && c[1] < 0.15 && c[2] < 0.15;
  });
  check(
    "vtracer traces a dark region",
    blackSubs.length >= 1,
    `black=${blackSubs.length} total=${spline.subpaths.length}`
  );
  if (blackSubs.length >= 1) {
    const xs = blackSubs.flatMap((sub) => sub.anchors.map((a) => a.pos[0]));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    check(
      "vtracer dark region sits in the left half",
      mean < 0.5,
      `mean x=${mean.toFixed(3)}`
    );
  }

  const bw = await traceRgba(
    rgba,
    w,
    h,
    w,
    h,
    vtracerOpts({ clustering: "bw", threshold: 0.5 })
  );
  check(
    "vtracer clustering=bw emits at least one subpath",
    bw.subpaths.length >= 1,
    `got ${bw.subpaths.length}`
  );
}

console.log(
  `\ncheck-image-trace: ${failures === 0 ? "all passed" : `${failures} failure(s)`}`
);
process.exit(failures ? 1 : 0);
