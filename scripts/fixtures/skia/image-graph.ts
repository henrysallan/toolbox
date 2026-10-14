// Images + assets fixture (specdocs/101326_skia-target.md §3.8 items 2–3,
// Wave 3 lane I). One procedural 96×64 RGBA picture (gradients, an 8 px
// checker, a transparent hole with a half-alpha ring) — the same PNG bytes
// in the browser and in Node (imageFixturePng) — shown several ways:
//
//   compare:skia pairs on a 320×180 canvas (`--a image:<pair>n --b image:<pair>d|s`)
//     <pair>n   Image Source (the GL node)
//     <pair>d   Image (Skia)'s drawing → Skia Canvas
//     <pair>s   Image (Skia)'s shader → Skia Fill → Skia Canvas (the image
//               leaf fused into tbx.image.fit's program)
//     cover     fit cover, no transform
//     contain   fit contain (letterboxed)
//     trs       fit stretch, translate / scale / rotate about an off-centre pivot
//               (the rotation shears on the 16:9 canvas, as Image Source's does)
//     cvtrs     fit cover, transformed (the drawing clips to its moved rect)
//   and an image wired into a Skia shader node:
//     ccn       Image Source (contain) → Color Correction
//     ccs       Image (Skia) shader → Color Correction (Skia) → Skia Fill → Skia Canvas
//
//   the SkSL Shader parity slot (imageEffectGraph, `--fixture image`,
//   skia-harness/src/bundle-image, `parity:skia -- --bundle image`): an
//   Image Source (stretch, rotated) into iImage1 of an SkSL Shader that
//   tints the picture through a ramp channel and a curve channel, mixed
//   by a keyframed channel — an image asset, two LUT children and a track.
//
// The bitmap: build() is synchronous, so the browser fixture starts the
// decode on its first build (compare:skia's info()) and later builds use it;
// Node callers (the CLI, check-skia-assets) pass a stand-in registered with
// its PNG bytes (lib/image-bytes.ts registerImageOriginal), which is all the
// planner and Image (Skia) read.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { syncChannelInputs } from "@/engine/expr-channels";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import { registerImageOriginal } from "@/lib/image-bytes";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const IMAGE_W = 96;
export const IMAGE_H = 64;
export const IMAGE_CANVAS: [number, number] = [320, 180];
export const IMAGE_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
export const IMAGE_FRAMES = [0, 45, 90, 120, 150, 200, 240, 299];

// The picture, RGBA8 unpremultiplied, row 0 = top.
export function imageFixturePixels(): Uint8Array {
  const out = new Uint8Array(IMAGE_W * IMAGE_H * 4);
  for (let y = 0; y < IMAGE_H; y++) {
    for (let x = 0; x < IMAGE_W; x++) {
      const i = (y * IMAGE_W + x) * 4;
      const check = ((x >> 3) + (y >> 3)) % 2 ? 0.82 : 1;
      const u = x / (IMAGE_W - 1);
      const v = y / (IMAGE_H - 1);
      out[i] = Math.round(255 * check * (0.15 + 0.85 * u));
      out[i + 1] = Math.round(255 * check * (0.2 + 0.7 * v));
      out[i + 2] = Math.round(255 * check * (0.55 + 0.45 * Math.sin(3 * u + 2 * v) * 0.9));
      const d = Math.hypot(x + 0.5 - 70, y + 0.5 - 22);
      out[i + 3] = d < 9 ? 0 : d < 13 ? 128 : 255;
    }
  }
  return out;
}

// The picture as a PNG — the same bytes everywhere (a browser canvas would
// round half-alpha pixels through its premultiplied storage): 8-bit RGBA,
// filter 0, stored (uncompressed) deflate blocks. Pure, so the browser
// fixture and the Node CLI / gates encode it identically.
export function imageFixturePng(rgba: Uint8Array = imageFixturePixels(), w = IMAGE_W, h = IMAGE_H): Uint8Array {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const chunk = (type: string, data: Uint8Array) => {
    const td = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
    td.set(data, 4);
    return [...u32(data.length), ...td, ...u32(crc(td))];
  };
  // Scanlines with filter byte 0.
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  // zlib: header, stored blocks (≤ 65535 bytes each), adler32.
  const z: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    z.push(i + len >= raw.length ? 1 : 0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let k = 0; k < len; k++) z.push(raw[i + k]);
  }
  let a = 1;
  let b = 0;
  for (const x of raw) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  z.push(...u32(((b << 16) | a) >>> 0));
  const ihdr = new Uint8Array([...u32(w), ...u32(h), 8, 6, 0, 0, 0]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", ihdr), ...chunk("IDAT", new Uint8Array(z)), ...chunk("IEND", new Uint8Array(0))]);
}

// ---- graphs ---------------------------------------------------------------------------

const edge = (source: string, target: string, targetHandle: string, sourceHandle = "out:primary"): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

const TRS_ID = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotate: 0, pivotX: 0.5, pivotY: 0.5 };
export const IMAGE_PAIRS: Record<string, Record<string, unknown>> = {
  cover: { fit: "cover", ...TRS_ID },
  contain: { fit: "contain", ...TRS_ID },
  trs: { fit: "stretch", translateX: 0.08, translateY: -0.06, scaleX: 0.7, scaleY: 0.55, rotate: 23, pivotX: 0.4, pivotY: 0.6 },
  cvtrs: { fit: "cover", translateX: -0.05, translateY: 0.04, scaleX: 0.8, scaleY: 0.9, rotate: -14, pivotX: 0.5, pivotY: 0.5 },
};

// The compare pairs. `file` is the bitmap (or a stand-in).
export function imageCompareGraph(file: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const [pair, p] of Object.entries(IMAGE_PAIRS)) {
    const params = { opacity: 1, file, ...p };
    nodes.push({ id: `${pair}n`, type: "image-source", params });
    // The drawing.
    nodes.push({ id: `${pair}i`, type: "skia-image", params });
    nodes.push({ id: `${pair}d`, type: "skia-canvas", params: { background_on: false } });
    edges.push(edge(`${pair}i`, `${pair}d`, "in:scene"));
    // The shader: the image leaf fused into a program, filled over the canvas.
    nodes.push({ id: `${pair}f`, type: "skia-fill", params: { color: "#000000", opacity: 1 } });
    edges.push(edge(`${pair}i`, `${pair}f`, "in:shader", "out:aux:shader"));
    nodes.push({ id: `${pair}s`, type: "skia-canvas", params: { background_on: false } });
    edges.push(edge(`${pair}f`, `${pair}s`, "in:scene"));
  }
  // An image wired into a Skia shader node.
  const cc = { hue: 25, saturation: 1.35, contrast: 1.15, brightness: 0.04 };
  const img = { opacity: 1, file, ...IMAGE_PAIRS.contain };
  nodes.push({ id: "ccimg", type: "image-source", params: img });
  nodes.push({ id: "ccn", type: "color-correction", params: cc });
  edges.push(edge("ccimg", "ccn", "in:image"));
  nodes.push({ id: "ccski", type: "skia-image", params: img });
  nodes.push({ id: "cck", type: "skia-color-correction", params: cc });
  edges.push(edge("ccski", "cck", "in:image", "out:aux:shader"));
  nodes.push({ id: "ccf", type: "skia-fill", params: { color: "#000000", opacity: 1 } });
  edges.push(edge("cck", "ccf", "in:shader"));
  nodes.push({ id: "ccs", type: "skia-canvas", params: { background_on: false } });
  edges.push(edge("ccf", "ccs", "in:scene"));
  return { nodes, edges };
}

// The SkSL Shader parity slot.
export const IMAGE_EFFECT_SKSL = `// toolbox Wave 3 lane I parity fixture: iImage1 tinted through a ramp,
// shaped by a curve, mixed by a keyframed channel.
// ramp("ink", "#1b1446", "#e2557f", "#ffd27a")
// curve("lift", 0, 0.35, 0.8, 1)
// ch("mixk", 0.5, 0, 1)
half4 main(float2 fragCoord) {
  float4 img = float4(iImage1.eval(fragCoord));
  float a = img.a;
  float3 s = a > 0.0 ? img.rgb / a : float3(0.0);
  float l = dot(s, float3(0.2126, 0.7152, 0.0722));
  float4 t = ink(lift(l));
  float3 c = mix(s, t.rgb, mixk);
  float bg = 0.12 + 0.1 * (fragCoord.y / iResolution.y);
  float3 o = c * a + float3(bg * 0.6, bg * 0.5, bg) * (1.0 - a);
  return half4(float4(o, 1.0));
}
`;

const block = (keys: [number, number][]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value]) => ({ tick: f * 1000, value, easingOut: "easeInOutSine" as const })),
});

export function imageEffectGraph(file: unknown): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const inputs = syncChannelInputs([], IMAGE_EFFECT_SKSL);
  return {
    nodes: [
      {
        id: "photo",
        type: "image-source",
        params: { opacity: 1, file, fit: "stretch", translateX: 0.03, translateY: -0.02, scaleX: 0.86, scaleY: 0.8, rotate: 9, pivotX: 0.5, pivotY: 0.5 },
      },
      {
        id: "tint",
        type: "sksl-shader",
        params: { inputs, expression: IMAGE_EFFECT_SKSL, on_error: "transparent" },
        animation: { "ch:mixk": block([[0, 0], [150, 1], [299, 0.25]]) },
      },
    ],
    edges: [edge("photo", "tint", "in:image1")],
    targetId: "tint",
  };
}

// ---- the bitmap ---------------------------------------------------------------------------

// A Node stand-in for the bitmap: what Image (Skia) and the planner read
// (width, height, the registered original bytes).
export function imageFixtureStandIn(png: Uint8Array): { width: number; height: number } {
  const bmp = { width: IMAGE_W, height: IMAGE_H };
  registerImageOriginal(bmp as unknown as ImageBitmap, new Blob([png as BlobPart], { type: "image/png" }));
  return bmp;
}

let bitmap: ImageBitmap | null = null;
let loading: Promise<void> | null = null;

// Browser: the picture as a decoded ImageBitmap with its PNG registered as
// the original (the import path's contract), started on first use.
export function imageFixtureBitmap(): ImageBitmap | null {
  if (bitmap || typeof createImageBitmap === "undefined") return bitmap;
  loading ??= (async () => {
    const blob = new Blob([imageFixturePng() as BlobPart], { type: "image/png" });
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    registerImageOriginal(bmp, blob);
    bitmap = bmp;
  })();
  return null;
}

export async function imageFixtureReady(): Promise<ImageBitmap> {
  imageFixtureBitmap();
  await loading;
  if (!bitmap) throw new Error("image fixture: the bitmap did not decode");
  return bitmap;
}

export const fixture: SkiaGraphFixture = {
  description:
    "Images + assets: Image Source vs Image (Skia) drawn (`<pair>d`) and fused as an image leaf (`<pair>s`) — pairs cover, contain, trs, cvtrs; `ccn` vs `ccs` an image wired into Color Correction (Skia); `tint` the SkSL Shader parity fixture",
  timeline: { fps: IMAGE_TIMELINE.fps, ticksPerFrame: IMAGE_TIMELINE.ticksPerFrame },
  frames: [0],
  size: IMAGE_CANVAS,
  // compare:skia's first build (info) only reads metadata; the sides are
  // prepared after the decode landed.
  ready: async () => {
    await imageFixtureReady();
  },
  build: () => {
    const bmp = imageFixtureBitmap();
    const g = imageCompareGraph(bmp);
    const effect = imageEffectGraph(bmp);
    return { nodes: [...g.nodes, ...effect.nodes], edges: [...g.edges, ...effect.edges] };
  },
};
