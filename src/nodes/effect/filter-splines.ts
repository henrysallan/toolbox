import type {
  NodeDefinition,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Keep or discard whole SUBPATHS by predicate — the spline sibling of
// Filter Points. The unit of selection is one subpath (one shape / one
// stroke), never an anchor: anchors are never added, moved, or removed, so
// downstream morphs and Path Animation see topology-stable geometry for
// whatever survives.
//
// Five modes:
//
//   bbox:   test the subpath's axis-aligned bounds against the
//           [x_min..x_max] × [y_min..y_max] window. Test picks what
//           "inside" means — the bbox CENTER is in (the direct analog of
//           Filter Points' point test), the WHOLE bbox is in, or the bbox
//           merely OVERLAPS. Invert flips kept ↔ dropped.
//
//   mask:   sample the wired image's luminance and keep subpaths at or
//           above threshold. Sample picks where: at the bbox center (what
//           a point would do — right for blobs), or averaged along the
//           path (right for long open strokes, whose center often isn't
//           on the curve at all).
//
//   size:   keep subpaths whose length or area falls in [min..max]. This
//           is the spline-specific one, and the reason to reach for this
//           node after a boolean / trace / marching-squares: raise Min a
//           hair and the speck fragments vanish while the real shapes stay.
//
//   index:  keep 1 of every N subpaths (Every) at a phase (Offset) — a
//           deterministic decimation. Invert drops that set.
//
//   random: keep a stable random subset. Each subpath's keep/drop is a
//           frame-independent hash of its index, so shapes don't flicker
//           in and out — raising Amount only ever REVEALS more of the same
//           subpaths (monotonic), and Seed re-rolls which are chosen
//           without changing the count. Same triple32 hash as Filter
//           Points and Point Expression's `rand()`, so the three agree.
//
// Output count is unbounded by the input — an empty spline is valid.
// Surviving subpaths pass through BY REFERENCE, so anchors, `closed`,
// `groupIndex` and `driver` are all preserved exactly (group tags are NOT
// renumbered — they're identity, same as Filter Points).
//
// Stability note (index/random): both key off the subpath's INDEX, so a
// fixed upstream spline stays put frame-to-frame. If the incoming subpath
// count changes, which indices exist changes with it.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// Line samples per curve when reducing a subpath to a polyline for bounds
// / length / area. Cheap and plenty accurate for a predicate — this is a
// measurement, not geometry we emit.
const SAMPLES_PER_CURVE = 16;

interface ImageBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function readImage(
  ctx: RenderContext,
  img: { texture: WebGLTexture; width: number; height: number }
): ImageBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  const data = ctx.readImagePixels({
    kind: "image",
    texture: img.texture,
    width: img.width,
    height: img.height,
  });
  if (!data) return null;
  return { data, w: img.width, h: img.height };
}

function sampleLuma(buf: ImageBuffer, u: number, v: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  const i = (py * buf.w + px) * 4;
  return (
    (0.2126 * buf.data[i] +
      0.7152 * buf.data[i + 1] +
      0.0722 * buf.data[i + 2]) /
    255
  );
}

// Frame-independent per-seed hash → [0,1). triple32 (Wellons) — strong
// avalanche on sequential integer seeds (0,1,2,…), our exact input
// pattern. Byte-identical to Filter Points' hash so a "random" cull of
// points and of the splines built from them select the same indices.
function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

const MODES = ["bbox", "mask", "size", "index", "random"] as const;
type Mode = (typeof MODES)[number];

interface SubMetrics {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  // Polyline arc length, normalized units (a full-canvas-width path ≈ 1).
  length: number;
  // |shoelace| of the polyline, implicitly closed. For an open subpath
  // this is the area of the shape you'd get by joining its ends.
  area: number;
  // Flattened [x0,y0, x1,y1, …] polyline, kept for mask averaging.
  pts: number[];
}

// Reduce one subpath to a polyline and the scalar measurements every mode
// needs. Straight segments (no handles on either end) emit one line;
// curves get SAMPLES_PER_CURVE. Mirrors spline-flatten.ts's subdivision.
// Returns null for an empty subpath — nothing to test.
function measure(sub: SplineSubpath): SubMetrics | null {
  const anchors = sub.anchors;
  const n = anchors.length;
  if (n === 0) return null;

  const pts: number[] = [anchors[0].pos[0], anchors[0].pos[1]];
  const segCount = n < 2 ? 0 : sub.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    const p0x = a.pos[0];
    const p0y = a.pos[1];
    const p1x = p0x + (a.outHandle?.[0] ?? 0);
    const p1y = p0y + (a.outHandle?.[1] ?? 0);
    const p3x = b.pos[0];
    const p3y = b.pos[1];
    const p2x = p3x + (b.inHandle?.[0] ?? 0);
    const p2y = p3y + (b.inHandle?.[1] ?? 0);
    const straight = p1x === p0x && p1y === p0y && p2x === p3x && p2y === p3y;
    if (straight) {
      pts.push(p3x, p3y);
      continue;
    }
    for (let k = 1; k <= SAMPLES_PER_CURVE; k++) {
      const t = k / SAMPLES_PER_CURVE;
      const u = 1 - t;
      const uu = u * u;
      const uuu = uu * u;
      const tt = t * t;
      const ttt = tt * t;
      pts.push(
        uuu * p0x + 3 * uu * t * p1x + 3 * u * tt * p2x + ttt * p3x,
        uuu * p0y + 3 * uu * t * p1y + 3 * u * tt * p2y + ttt * p3y
      );
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let length = 0;
  let twiceArea = 0;
  const count = pts.length / 2;
  for (let i = 0; i < count; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    // Wrap to vertex 0 on the last step so the shoelace closes; the
    // closing chord contributes to area but not to the drawn length.
    const j = i + 1 === count ? 0 : i + 1;
    const nx = pts[j * 2];
    const ny = pts[j * 2 + 1];
    if (j !== 0) length += Math.hypot(nx - x, ny - y);
    twiceArea += x * ny - nx * y;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    length,
    area: Math.abs(twiceArea) / 2,
    pts,
  };
}

export const filterSplinesNode: NodeDefinition = {
  type: "filter-splines",
  name: "Filter Splines",
  category: "spline",
  subcategory: "modifier",
  description:
    "Keep or discard whole subpaths of a spline by predicate — the spline sibling of Filter Points. Bbox tests each subpath's bounds against an XY window (by center, fully inside, or overlapping); Mask keeps subpaths where the wired image's luminance is ≥ threshold, sampled at the center or averaged along the path; Size keeps subpaths whose length or area falls in a range (raise Min to cull speck fragments after a boolean or trace); Index keeps 1 of every N subpaths; Random keeps a stable random subset (hashed on index, so shapes don't flicker in/out — raising Amount reveals more of the same subpaths, Seed re-rolls the selection). Invert flips which side is kept. Anchors are never touched, so surviving subpaths keep their exact geometry, group tags, and drivers.",
  backend: "webgl2",
  inputs: [
    { name: "path", type: "spline", required: true },
    { name: "mask", type: "image", required: false, label: "Mask" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "bbox",
    },
    {
      name: "x_min",
      label: "X min",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "x_max",
      label: "X max",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "y_min",
      label: "Y min",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "y_max",
      label: "Y max",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      // A subpath has extent, so "inside" is ambiguous where a point's
      // isn't. center == what Filter Points does to a point.
      name: "test",
      label: "Test",
      type: "enum",
      options: ["center", "inside", "overlap"],
      default: "center",
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "mask",
    },
    {
      // A long open stroke's bbox center is usually off the curve, so
      // "average" exists for those; "center" is right for closed blobs.
      name: "mask_sample",
      label: "Sample",
      type: "enum",
      options: ["center", "average"],
      default: "center",
      visibleIf: (p) => p.mode === "mask",
    },
    {
      name: "size_metric",
      label: "Metric",
      type: "enum",
      options: ["length", "area"],
      default: "length",
      visibleIf: (p) => p.mode === "size",
    },
    {
      // Normalized units: length ~1 spans the canvas width, area is the
      // fraction of the canvas the shape covers. Defaults keep everything
      // so the mode is a no-op until you drag Min up off zero.
      name: "size_min",
      label: "Min",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "size",
    },
    {
      name: "size_max",
      label: "Max",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 1,
      step: 0.001,
      default: 4,
      visibleIf: (p) => p.mode === "size",
    },
    {
      // index mode: keep 1 of every N subpaths.
      name: "every",
      label: "Keep 1 of every",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 10,
      step: 1,
      default: 2,
      visibleIf: (p) => p.mode === "index",
    },
    {
      // index mode: phase — which residue class survives.
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 10,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "index",
    },
    {
      // random mode: fraction kept. Monotonic — raising this only ever
      // adds subpaths, so dragging it reads as a reveal, not a reshuffle.
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "random",
    },
    {
      // random mode: re-roll WHICH subpaths are kept (not how many).
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: EMPTY_SPLINE };
    }

    const mode = ((params.mode as string) ?? "bbox") as Mode;
    const invert = !!params.invert;
    const subs = src.subpaths;
    const n = subs.length;

    // Only the geometric modes need the polyline reduction — index and
    // random never look at the shape.
    const needsGeometry = mode === "bbox" || mode === "mask" || mode === "size";
    const metrics: (SubMetrics | null)[] = needsGeometry
      ? subs.map(measure)
      : [];

    const keep = new Uint8Array(n);
    let keepCount = 0;
    const mark = (i: number, pass: boolean) => {
      if (invert ? !pass : pass) {
        keep[i] = 1;
        keepCount++;
      }
    };

    if (mode === "bbox") {
      const xMin = (params.x_min as number) ?? 0;
      const xMax = (params.x_max as number) ?? 1;
      const yMin = (params.y_min as number) ?? 0;
      const yMax = (params.y_max as number) ?? 1;
      const lo = Math.min(xMin, xMax);
      const hi = Math.max(xMin, xMax);
      const tlo = Math.min(yMin, yMax);
      const thi = Math.max(yMin, yMax);
      const test = (params.test as string) ?? "center";
      for (let i = 0; i < n; i++) {
        const m = metrics[i];
        // An empty subpath has nothing to test — it fails (and Invert
        // therefore keeps it, same as any other failing subpath).
        if (!m) continue;
        let inside: boolean;
        if (test === "inside") {
          inside =
            m.minX >= lo && m.maxX <= hi && m.minY >= tlo && m.maxY <= thi;
        } else if (test === "overlap") {
          inside =
            m.maxX >= lo && m.minX <= hi && m.maxY >= tlo && m.minY <= thi;
        } else {
          inside = m.cx >= lo && m.cx <= hi && m.cy >= tlo && m.cy <= thi;
        }
        mark(i, inside);
      }
    } else if (mode === "size") {
      const metric = (params.size_metric as string) ?? "length";
      const a = (params.size_min as number) ?? 0;
      const b = (params.size_max as number) ?? 4;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = 0; i < n; i++) {
        const m = metrics[i];
        if (!m) continue;
        const v = metric === "area" ? m.area : m.length;
        mark(i, v >= lo && v <= hi);
      }
    } else if (mode === "index") {
      const every = Math.max(1, Math.round((params.every as number) ?? 2));
      const offset = Math.round((params.offset as number) ?? 0);
      for (let i = 0; i < n; i++) {
        // Floor-mod so negative offsets still land on a stable residue.
        mark(i, (((i + offset) % every) + every) % every === 0);
      }
    } else if (mode === "random") {
      const amount = Math.max(0, Math.min(1, (params.amount as number) ?? 0.5));
      const seed = Math.round((params.seed as number) ?? 0);
      // Mix the seed in strongly so adjacent seeds give unrelated
      // selections. seed 0 collapses to hash01(index), matching Filter
      // Points and Point Expression's rand(index).
      const seedMix = Math.imul(seed, 0x9e3779b1);
      for (let i = 0; i < n; i++) {
        // Strict `<`: amount 0 keeps nothing, amount 1 keeps everything.
        mark(i, hash01(i ^ seedMix) < amount);
      }
    } else {
      // mask mode
      const maskImg = inputs.mask;
      if (!maskImg || maskImg.kind !== "image") {
        // No mask wired — pass through unchanged so the user can wire it.
        return { primary: src };
      }
      const buf = readImage(ctx, maskImg);
      if (!buf) return { primary: src };
      const threshold = (params.threshold as number) ?? 0.5;
      const average = ((params.mask_sample as string) ?? "center") === "average";
      for (let i = 0; i < n; i++) {
        const m = metrics[i];
        if (!m) continue;
        let luma: number;
        if (average) {
          const count = m.pts.length / 2;
          let acc = 0;
          for (let k = 0; k < count; k++) {
            acc += sampleLuma(buf, m.pts[k * 2], m.pts[k * 2 + 1]);
          }
          luma = count > 0 ? acc / count : 0;
        } else {
          luma = sampleLuma(buf, m.cx, m.cy);
        }
        mark(i, luma >= threshold);
      }
    }

    if (keepCount === n) return { primary: src };
    if (keepCount === 0) return { primary: EMPTY_SPLINE };

    // Subpaths pass through by reference — we never mutate them, so
    // anchors / closed / groupIndex / driver survive untouched. Group tags
    // are deliberately NOT renumbered (they're identity, matching Filter
    // Points' handling of groupIndices).
    const out: SplineSubpath[] = [];
    for (let i = 0; i < n; i++) {
      if (keep[i]) out.push(subs[i]);
    }
    return { primary: { kind: "spline", subpaths: out } };
  },
};
