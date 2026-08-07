import type {
  ImageValue,
  NodeDefinition,
  ParamDef,
  RenderContext,
  SocketValue,
} from "@/engine/types";
// panel-window-dom, not panel-window: this file is reachable from the
// docs pages' server graph via src/nodes/index.ts, and the latter is a
// "use client" module.
import { broadcastAppEvent } from "@/components/effects/layout/panel-window-dom";

// Color value source — emits vec4 (r, g, b, a) values without rasterizing
// them. Solid Color produces a full-frame image; this one produces raw
// color values, which color-math nodes (and any vec4 consumer) can read
// directly without a rasterize → sample round trip.
//
// Multi-output: a `count` param (1..MAX_COLORS) unlocks `color2..colorN`
// params and mints a matching vec4 aux output per extra color
// (`resolveAuxOutputs`). Each colorN is a DECLARED color param — not an
// array item — so keyframing / expose / exported-app controls all work
// through the standard param machinery. The single `alpha` applies to
// every output. Primary output stays color 1 for back-compat (old saves
// have no `count` → 1). Spec: 071026_color-node-multi-output.md.
//
// Palette mode: an optional `image` input flips the source of truth. When
// wired, the stored colors are ignored and every output comes from a
// k-means palette extraction over a 32×32 downsample of the image
// (`count` = palette size, color 1 = most dominant). Extraction is
// deterministic (luminance-quantile seeding, no RNG) so results are
// stable across evals and cache correctly; the input's fingerprint
// re-runs it when the image changes (video re-extracts per frame). The
// node dispatches "color-node-palette" when the palette changes so the
// on-node swatches can display it (render-queue-progress precedent).

export const MAX_COLORS = 8;

// Param name for the nth color (1-based): "color", "color2", … "color8".
export function colorParamName(n: number): string {
  return n <= 1 ? "color" : `color${n}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

function rgb01ToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function colorCount(params: Record<string, unknown>): number {
  const raw = typeof params.count === "number" ? params.count : 1;
  return Math.max(1, Math.min(MAX_COLORS, Math.floor(raw)));
}

// --- palette extraction ----------------------------------------------------

// Deterministic k-means over RGBA float pixels (length divisible by 4,
// 0..1-ish — HDR values are clamped on ingest). Transparent pixels
// (a < 0.1) are excluded. No RNG anywhere, so the same image always
// yields the same palette (results must be stable across evals and
// cacheable). Three-stage shape, tuned so small-but-distinct colors
// survive and "dominant" means mode, not mean:
//   1. OVER-cluster (k+4 clusters, capped 12) with deterministic maximin
//      seeding — first seed nearest the global mean, then repeatedly the
//      point farthest from every seed so far, which guarantees each
//      distinct color mode gets a seed.
//   2. Lloyd iterations.
//   3. Merge near-identical clusters (population-weighted), sort by
//      population, return the top `k` (dominant first) — so k=1 yields
//      the dominant color, not the image's muddy average. Fewer distinct
//      colors than k pads cyclically.
// Returns null when the image has no opaque pixels. Exported for tests.
export function extractPaletteFromPixels(
  px: Float32Array,
  k: number
): Array<[number, number, number]> | null {
  const pts: number[] = [];
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 0.1) continue;
    pts.push(
      Math.max(0, Math.min(1, px[i])),
      Math.max(0, Math.min(1, px[i + 1])),
      Math.max(0, Math.min(1, px[i + 2]))
    );
  }
  const n = pts.length / 3;
  if (n === 0) return null;

  const kk = Math.min(12, Math.min(n, k + 4));

  // Maximin seeding. Anchor at the point nearest the global mean, then
  // grow with the farthest-remaining point — deterministic k-means++.
  let mr = 0,
    mg = 0,
    mb = 0;
  for (let i = 0; i < n; i++) {
    mr += pts[i * 3];
    mg += pts[i * 3 + 1];
    mb += pts[i * 3 + 2];
  }
  mr /= n;
  mg /= n;
  mb /= n;
  const distTo = (i: number, r: number, g: number, b: number) => {
    const dr = pts[i * 3] - r;
    const dg = pts[i * 3 + 1] - g;
    const db = pts[i * 3 + 2] - b;
    return dr * dr + dg * dg + db * db;
  };
  let seed0 = 0;
  let seed0D = Infinity;
  for (let i = 0; i < n; i++) {
    const d = distTo(i, mr, mg, mb);
    if (d < seed0D) {
      seed0D = d;
      seed0 = i;
    }
  }
  const centers: Array<[number, number, number]> = [
    [pts[seed0 * 3], pts[seed0 * 3 + 1], pts[seed0 * 3 + 2]],
  ];
  // minD[i] = distance to the nearest chosen seed so far.
  const minD = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    minD[i] = distTo(i, centers[0][0], centers[0][1], centers[0][2]);
  }
  while (centers.length < kk) {
    let far = 0;
    let farD = -1;
    for (let i = 0; i < n; i++) {
      if (minD[i] > farD) {
        farD = minD[i];
        far = i;
      }
    }
    const c: [number, number, number] = [
      pts[far * 3],
      pts[far * 3 + 1],
      pts[far * 3 + 2],
    ];
    centers.push(c);
    for (let i = 0; i < n; i++) {
      const d = distTo(i, c[0], c[1], c[2]);
      if (d < minD[i]) minD[i] = d;
    }
  }

  // Lloyd iterations.
  const assign = new Int32Array(n).fill(-1);
  const counts = new Int32Array(kk);
  const sums = new Float64Array(kk * 3);
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = distTo(i, centers[c][0], centers[c][1], centers[c][2]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
    counts.fill(0);
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      sums[c * 3] += pts[i * 3];
      sums[c * 3 + 1] += pts[i * 3 + 1];
      sums[c * 3 + 2] += pts[i * 3 + 2];
    }
    for (let c = 0; c < kk; c++) {
      if (counts[c] === 0) continue; // keep the seed — harmless duplicate
      centers[c] = [
        sums[c * 3] / counts[c],
        sums[c * 3 + 1] / counts[c],
        sums[c * 3 + 2] / counts[c],
      ];
    }
  }

  // Merge near-identical clusters (population-weighted), most-populous
  // first, then take the top k. ~0.075 RGB distance reads as "the same
  // color" at swatch size.
  const MERGE_EPS_SQ = 0.075 * 0.075;
  const byPop = centers
    .map((c, i) => ({ c, pop: counts[i], i }))
    .filter((x) => x.pop > 0)
    .sort((a, b) => b.pop - a.pop || a.i - b.i);
  const merged: Array<{ c: [number, number, number]; pop: number }> = [];
  for (const x of byPop) {
    let host: { c: [number, number, number]; pop: number } | null = null;
    for (const m of merged) {
      const dr = m.c[0] - x.c[0];
      const dg = m.c[1] - x.c[1];
      const db = m.c[2] - x.c[2];
      if (dr * dr + dg * dg + db * db < MERGE_EPS_SQ) {
        host = m;
        break;
      }
    }
    if (host) {
      const total = host.pop + x.pop;
      host.c = [
        (host.c[0] * host.pop + x.c[0] * x.pop) / total,
        (host.c[1] * host.pop + x.c[1] * x.pop) / total,
        (host.c[2] * host.pop + x.c[2] * x.pop) / total,
      ];
      host.pop = total;
    } else {
      merged.push({ c: [...x.c], pop: x.pop });
    }
  }
  merged.sort((a, b) => b.pop - a.pop);

  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < k; i++) out.push(merged[i % merged.length].c);
  return out;
}

// Downsample the wired image to a small grid and extract on the CPU. The
// 32×32 point-sample is a statistical sample of the frame — plenty for a
// palette — and keeps the sync readPixels stall negligible.
const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

const SAMPLE_SIZE = 32;

function extractPaletteGL(
  ctx: RenderContext,
  image: ImageValue,
  k: number
): Array<[number, number, number]> | null {
  const small = ctx.allocImage({ width: SAMPLE_SIZE, height: SAMPLE_SIZE });
  try {
    const prog = ctx.getShader("color-literal/copy", COPY_FS);
    ctx.drawFullscreen(prog, small, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, image.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    });
    const px = ctx.readImageToFloat32(small);
    return extractPaletteFromPixels(px, k);
  } finally {
    ctx.releaseTexture(small);
  }
}

// Last announced palette per node, parked on globalThis (segment-session
// precedent): compute only runs on cache misses, so a remounting
// EffectNode reads the current palette from here (`getExtractedPalette`)
// instead of waiting for an event that may never re-fire.
const PALETTE_STORE_KEY = "__toolboxColorNodePalettes__";
function paletteStore(): Map<string, string[]> {
  const g = globalThis as Record<string, unknown>;
  if (!(g[PALETTE_STORE_KEY] instanceof Map)) {
    g[PALETTE_STORE_KEY] = new Map<string, string[]>();
  }
  return g[PALETTE_STORE_KEY] as Map<string, string[]>;
}

export function getExtractedPalette(nodeId: string): string[] | null {
  return paletteStore().get(nodeId) ?? null;
}

// Announce the extracted palette (or its absence) to the editor so the
// on-node swatches can mirror it. Only dispatched when the value actually
// changed.
function announcePalette(nodeId: string, hexes: string[] | null) {
  if (typeof window === "undefined") return;
  const store = paletteStore();
  const prev = store.get(nodeId);
  const prevKey = prev ? prev.join(",") : "";
  const nextKey = hexes ? hexes.join(",") : "";
  if (prevKey === nextKey) return;
  if (hexes) store.set(nodeId, hexes);
  else store.delete(nodeId);
  // Broadcast: the node body listening for this may be in a popped-out
  // node editor (080226_panel-popout-windows.md).
  broadcastAppEvent(
    () =>
      new CustomEvent("color-node-palette", {
        detail: { nodeId, colors: hexes },
      })
  );
}

const colorParams: ParamDef[] = Array.from(
  { length: MAX_COLORS },
  (_, i): ParamDef => {
    const n = i + 1;
    return {
      name: colorParamName(n),
      label: n === 1 ? "Color" : `Color ${n}`,
      type: "color",
      default: "#ffffff",
      ...(n === 1
        ? {}
        : { visibleIf: (params) => colorCount(params) >= n }),
    };
  }
);

export const colorLiteralNode: NodeDefinition = {
  type: "color-literal",
  name: "Color",
  category: "utility",
  description:
    "Emits one or more colors as vec4 values (not images). The + on the node header adds another color output; each color square on the node opens a picker in place, and the H/S/L/A row at the bottom edits whichever square is selected. Wire an image into the palette input and the outputs switch to a palette extracted from it (color 1 = most dominant). Use to drive color-math nodes or any exposed color param.",
  backend: "webgl2",
  stable: true,
  inputs: [
    {
      name: "image",
      label: "palette from",
      type: "image",
      required: false,
    },
  ],
  params: [
    ...colorParams,
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "count",
      label: "Colors",
      type: "scalar",
      min: 1,
      max: MAX_COLORS,
      step: 1,
      default: 1,
      visibleIf: (params) => colorCount(params) > 1,
    },
  ],
  primaryOutput: "vec4",
  auxOutputs: [],
  resolveAuxOutputs(params) {
    const count = colorCount(params);
    const out = [];
    for (let n = 2; n <= count; n++) {
      out.push({
        name: colorParamName(n),
        label: `color ${n}`,
        type: "vec4" as const,
      });
    }
    return out;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const a = (params.alpha as number) ?? 1;
    const count = colorCount(params);

    // Palette mode: a wired image overrides the stored colors entirely.
    const img = inputs["image"];
    let palette: Array<[number, number, number]> | null = null;
    if (img && img.kind === "image") {
      palette = extractPaletteGL(ctx, img, count);
    }
    announcePalette(
      nodeId,
      palette ? palette.map((c) => rgb01ToHex(c[0], c[1], c[2])) : null
    );

    const valueFor = (n: number): SocketValue => {
      if (palette) {
        const c = palette[Math.min(n - 1, palette.length - 1)];
        return { kind: "vec4", value: [c[0], c[1], c[2], a] };
      }
      const hex = params[colorParamName(n)];
      const [r, g, b] = hexToRgb(
        typeof hex === "string" ? hex : "#ffffff"
      );
      return { kind: "vec4", value: [r, g, b, a] };
    };

    const aux: Record<string, SocketValue> = {};
    for (let n = 2; n <= count; n++) {
      aux[colorParamName(n)] = valueFor(n);
    }
    return { primary: valueFor(1), aux };
  },

  dispose(_ctx, nodeId) {
    paletteStore().delete(nodeId);
  },
};
