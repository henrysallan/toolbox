import type { NodeDefinition, SplineSubpath, SplineValue } from "@/engine/types";
import { marchingSquares } from "@/engine/marching-squares";

// Points to Surface — "meshing" for particle clumps (spec
// 072726_points-to-surface.md): build a scalar field around a points
// cloud, extract its iso-contour with the engine's marching squares,
// and emit the result as a spline. Wire the Matter Simulator's points
// aux in and liquid gets a surface; works identically on the Particle
// Simulator's points output, Scatter Points, or anything else points.
// The spline output rides the spline→mask coercion, so it wires
// straight into any mask/image socket as a filled silhouette — or into
// Rasterize Spline / Stroke for styled surfaces (per-blob groupIndex
// tags mean ramp fills can color each blob differently).
//
// Two tried-and-true surfacing algorithms, toggleable:
//   metaballs   — Blinn blobbies: sum a smooth falloff kernel
//                 (1 − q²)³ per particle, threshold the field. The
//                 classic lava-lamp merge look; bulges where particles
//                 crowd.
//   zhu-bridson — Zhu & Bridson 2005 ("Animating Sand as a Fluid"),
//                 THE standard SPH surfacing: signed distance to the
//                 kernel-weighted AVERAGE of nearby particle positions,
//                 φ(x) = |x − x̄| − r̄. Flat resting surfaces and calm
//                 concave regions where metaballs go lumpy — the liquid
//                 look.
//
// Everything runs CPU-side in one pass over a pixel-square sample grid
// (`detail` across the width): counting-sort spatial binning at the
// influence radius, field evaluation from the 3×3 bin neighborhood,
// marching squares at iso 0 (negative inside), optional
// neighbor-average smoothing, and a min-area speck cull (shoelace, in
// canvas-area fraction). Pure function of inputs — cacheable, scrubs,
// exports exactly.

const EPS = 1e-9;

interface Field {
  grid: Float32Array;
  w: number;
  h: number;
}

// Sample positions + counting-sort bins in SAMPLE space (pixel-square:
// x·(w−1), y·(h−1); the influence radius is isotropic there).
function buildField(
  positions: Float32Array,
  count: number,
  w: number,
  h: number,
  radiusSamples: number,
  algorithm: string,
  threshold: number
): Field {
  const grid = new Float32Array(w * h);
  const R = Math.max(1e-3, radiusSamples);
  const invR2 = 1 / (R * R);

  // ---- bin particles (bin size = R) ----
  const bw = Math.max(1, Math.ceil(w / R));
  const bh = Math.max(1, Math.ceil(h / R));
  const nBins = bw * bh;
  const binOf = new Int32Array(count);
  const counts = new Int32Array(nBins + 1);
  const px = new Float32Array(count);
  const py = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const sx = positions[i * 2] * (w - 1);
    const sy = positions[i * 2 + 1] * (h - 1);
    px[i] = sx;
    py[i] = sy;
    const bx = Math.max(0, Math.min(bw - 1, Math.floor(sx / R)));
    const by = Math.max(0, Math.min(bh - 1, Math.floor(sy / R)));
    const b = by * bw + bx;
    binOf[i] = b;
    counts[b + 1]++;
  }
  for (let b = 0; b < nBins; b++) counts[b + 1] += counts[b];
  const order = new Int32Array(count);
  const cursor = counts.slice(0, nBins);
  for (let i = 0; i < count; i++) {
    order[cursor[binOf[i]]++] = i;
  }

  const zb = algorithm === "zhu-bridson";
  const rBar = threshold * R; // ZB surface radius
  const far = R; // "far outside" value for empty ZB samples

  for (let gy = 0; gy < h; gy++) {
    const byC = Math.max(0, Math.min(bh - 1, Math.floor(gy / R)));
    for (let gx = 0; gx < w; gx++) {
      const bxC = Math.max(0, Math.min(bw - 1, Math.floor(gx / R)));
      let sumW = 0;
      let sumX = 0;
      let sumY = 0;
      let field = 0;
      for (let by = Math.max(0, byC - 1); by <= Math.min(bh - 1, byC + 1); by++) {
        for (let bx = Math.max(0, bxC - 1); bx <= Math.min(bw - 1, bxC + 1); bx++) {
          const b = by * bw + bx;
          for (let k = counts[b]; k < counts[b + 1]; k++) {
            const i = order[k];
            const dx = px[i] - gx;
            const dy = py[i] - gy;
            const q2 = (dx * dx + dy * dy) * invR2;
            if (q2 >= 1) continue;
            const t = 1 - q2;
            const wgt = t * t * t;
            if (zb) {
              sumW += wgt;
              sumX += wgt * px[i];
              sumY += wgt * py[i];
            } else {
              field += wgt;
            }
          }
        }
      }
      const idx = gy * w + gx;
      if (zb) {
        if (sumW < EPS) {
          grid[idx] = far;
        } else {
          const ax = sumX / sumW - gx;
          const ay = sumY / sumW - gy;
          grid[idx] = Math.sqrt(ax * ax + ay * ay) - rBar;
        }
      } else {
        // negative-inside convention for the marcher
        grid[idx] = threshold - field;
      }
    }
  }
  return { grid, w, h };
}

// In-place neighbor averaging on a subpath's anchors (circular when
// closed). Cheap contour smoothing that never overshoots.
function smoothSubpath(sub: SplineSubpath, passes: number): void {
  const n = sub.anchors.length;
  if (n < 3 || passes <= 0) return;
  let xs = sub.anchors.map((a) => a.pos[0]);
  let ys = sub.anchors.map((a) => a.pos[1]);
  for (let p = 0; p < passes; p++) {
    const nx = xs.slice();
    const ny = ys.slice();
    const lo = sub.closed ? 0 : 1;
    const hi = sub.closed ? n : n - 1;
    for (let i = lo; i < hi; i++) {
      const ip = (i - 1 + n) % n;
      const inx = (i + 1) % n;
      nx[i] = xs[i] * 0.5 + (xs[ip] + xs[inx]) * 0.25;
      ny[i] = ys[i] * 0.5 + (ys[ip] + ys[inx]) * 0.25;
    }
    xs = nx;
    ys = ny;
  }
  for (let i = 0; i < n; i++) {
    sub.anchors[i] = { pos: [xs[i], ys[i]] };
  }
}

// Signed shoelace area in uv — |area| is the fraction of canvas area.
function subpathArea(sub: SplineSubpath): number {
  const n = sub.anchors.length;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = sub.anchors[i].pos;
    const b = sub.anchors[(i + 1) % n].pos;
    acc += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(acc) * 0.5;
}

const EMPTY: SplineValue = { kind: "spline", subpaths: [] };

export const pointsToSurfaceNode: NodeDefinition = {
  type: "points-to-surface",
  name: "Points to Surface",
  category: "point",
  subcategory: "modifier",
  description:
    "Mesh a surface around particle clumps: builds a field from a points cloud and traces its outline as a spline (marching squares). `zhu-bridson` is the classic liquid surfacing — flat resting surfaces, calm concave regions; `metaballs` is the blobby lava-lamp merge look. Wire the Matter/Particle Simulator's points output in and liquid gets a skin — the spline coerces straight into any mask/image socket as a filled silhouette, or style it via Rasterize Spline / Stroke (each blob carries a groupIndex for per-blob ramp colors). `radius` sets how far particles reach before merging; `threshold` tightens or fattens the surface; `min blob` culls specks.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "algorithm",
      label: "Algorithm",
      type: "enum",
      options: ["zhu-bridson", "metaballs"],
      control: "segmented",
      default: "zhu-bridson",
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.005,
      max: 0.15,
      softMax: 0.06,
      step: 0.001,
      default: 0.025,
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "detail",
      label: "Detail",
      type: "scalar",
      min: 48,
      max: 384,
      step: 8,
      default: 160,
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "min_blob",
      label: "Min blob area",
      type: "scalar",
      min: 0,
      max: 0.01,
      step: 0.0001,
      default: 0.0002,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const pts = inputs.points;
    if (!pts || pts.kind !== "points" || pts.count === 0) {
      return { primary: EMPTY };
    }

    const aspect = ctx.width / ctx.height;
    const detail = Math.max(
      48,
      Math.min(384, Math.round((params.detail as number) ?? 160))
    );
    // Pixel-square sample grid: detail+1 samples across, scaled by
    // aspect vertically.
    const w = detail + 1;
    const h = Math.max(9, Math.round(detail / aspect) + 1);
    const radius = (params.radius as number) ?? 0.025;
    const radiusSamples = Math.max(1.5, radius * (w - 1));
    const algorithm = (params.algorithm as string) ?? "zhu-bridson";
    const threshold = (params.threshold as number) ?? 0.5;

    const field = buildField(
      pts.positions,
      pts.count,
      w,
      h,
      radiusSamples,
      algorithm,
      threshold
    );

    let subpaths = marchingSquares(field.grid, w, h, { iso: 0 });

    const minBlob = (params.min_blob as number) ?? 0.0002;
    if (minBlob > 0) {
      subpaths = subpaths.filter((s) => subpathArea(s) >= minBlob);
    }

    const smoothing = (params.smoothing as number) ?? 0.4;
    const passes = Math.round(smoothing * 6);
    if (passes > 0) {
      for (const sub of subpaths) smoothSubpath(sub, passes);
    }

    // Per-blob group tags — Rasterize's ramp fill / Group Pick key off
    // these.
    subpaths.forEach((s, i) => {
      s.groupIndex = i;
    });

    return { primary: { kind: "spline", subpaths } satisfies SplineValue };
  },
};
