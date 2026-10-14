import "@/engine/skia/library/helpers-noise";
import {
  COLOR_RAMP_INTERP_OPTIONS,
  COLOR_RAMP_MAX_STOPS,
  COLOR_RAMP_SPACE_OPTIONS,
  normalizeRampInterp,
  normalizeRampSpace,
} from "@/engine/color-ramp";
import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { shapeCellsNode } from "../source/shape-cells";
import { packRampStops } from "./color-ramp";

// Shape Cells (Skia) — the Skia-layer port of Shape Cells (SHAPE_CELLS_FS,
// src/nodes/source/shape-cells.ts). The grid, the band/oscillation math,
// the three SDFs and the ramp walk are line for line; three things cannot
// be, under Skia's strict ES2:
//
//   1. The cell hash. The GL node's `hash44` is a uint PCG round (multiply,
//      xor, shifts). Here it is tbx.noise.cellhash (Hoskins' float hash44,
//      helpers-noise.ts) on (cell.x, cell.y, seed, 0) and (…, seed + 17, 0),
//      so every per-cell draw — shape, copy count, base hue, phase — differs
//      from the GL node for the same seed: same distribution, different
//      layout. With one shape, one copy and lockBaseShape the layout is
//      hash-free and the two match (the `cells_fixed` compare pair).
//   2. pickShape's bitmask and slot array become a walk over the three
//      use* flags (same selection rule).
//   3. fwidth(d): no derivatives in Skia, so the AA width is the SDF's
//      one-pixel forward differences |Δx d| + |Δy d| (p is in pixels). Same
//      inside a cell; the GL node's derivative also spikes on the pixel
//      pairs straddling a cell border (neighbouring cells' shapes differ),
//      which drew faint 1-px seams there — the Skia version has none.
//
// The ramp is evaluated per pixel from the stops (like Color Ramp (Skia))
// instead of the GL node's 1024-texel LUT; `constant` keeps the LUT's
// 1/1024 grid. The `time` input is not mirrored: the shader reads the clock
// (iTime, what Shape Cells falls back to unwired); retime with `speed`.

const MAX = COLOR_RAMP_MAX_STOPS;
const MAX_COPIES = 8;
const INTERP_INDEX = (name: string) => (COLOR_RAMP_INTERP_OPTIONS as readonly string[]).indexOf(name);
const SPACE_INDEX = (name: string) => (COLOR_RAMP_SPACE_OPTIONS as readonly string[]).indexOf(name);
const UNPORTED_INTERP = new Set(["cardinal", "monotone", "bspline", "smooth"]);
const UNPORTED_SPACE = new Set(["oklch", "oklch_long"]);

const SHAPE_CELLS_SKSL = `// sdCircle / sdBox / sdTriangle (IQ) by shape index 0 / 1 / 2.
float tbx_shape_cells_sd(float shape, float2 p, float r) {
  if (shape < 0.5) return length(p) - r;
  if (shape < 1.5) {
    float2 d = abs(p) - float2(r);
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = float2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

// pickShape: the r-th enabled shape in circle, square, triangle order;
// circle when none is enabled.
float tbx_shape_cells_pick(float useCircle, float useSquare, float useTriangle, float r) {
  float c = useCircle > 0.5 ? 1.0 : 0.0;
  float s = useSquare > 0.5 ? 1.0 : 0.0;
  float t = useTriangle > 0.5 ? 1.0 : 0.0;
  float count = c + s + t;
  if (count < 0.5) return 0.0;
  float idx = floor(r * count);
  if (idx >= count) idx = count - 1.0;
  if (c > 0.5) {
    if (idx < 0.5) return 0.0;
    idx -= 1.0;
  }
  if (s > 0.5) {
    if (idx < 0.5) return 1.0;
    idx -= 1.0;
  }
  return 2.0;
}

float3 tbx_shape_cells_to_working(float3 c, int space) {
  if (space == ${SPACE_INDEX("linear")}) return tbx_srgb_to_linear3(c);
  if (space == ${SPACE_INDEX("oklab")}) return tbx_srgb_to_oklab(c);
  return c;
}

float4 tbx_shape_cells_from_working(float4 v, int space) {
  float3 c;
  if (space == ${SPACE_INDEX("linear")}) c = tbx_linear_to_srgb3(clamp(v.rgb, 0.0, 1.0));
  else if (space == ${SPACE_INDEX("oklab")}) c = tbx_linear_to_srgb3(clamp(tbx_oklab_to_linear(v.rgb), 0.0, 1.0));
  else c = clamp(v.rgb, 0.0, 1.0);
  return float4(c, clamp(v.a, 0.0, 1.0));
}

float4 tbx_shape_cells_knot(float4 c, int space) {
  return float4(tbx_shape_cells_to_working(c.rgb, space), clamp(c.a, 0.0, 1.0));
}

float tbx_shape_cells_remap(float f, int interp) {
  if (interp == ${INTERP_INDEX("ease")}) return f * f * (3.0 - 2.0 * f);
  if (interp == ${INTERP_INDEX("smoother")}) return f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  if (interp == ${INTERP_INDEX("sine")}) return 0.5 - 0.5 * cos(3.141592653589793 * f);
  if (interp == ${INTERP_INDEX("ease_in")}) return f * f;
  if (interp == ${INTERP_INDEX("ease_out")}) return 1.0 - (1.0 - f) * (1.0 - f);
  return f;
}

// The ramp at t (makeColorRampSampler on sorted stops; Color Ramp (Skia)'s
// walk), straight RGBA. The GL node's LUT sampler clamps t and snaps a
// constant ramp to its 1/1024 texel grid.
float4 tbx_shape_cells_ramp(float t, float stops_pos[${MAX}], float4 stops_color[${MAX}],
                            float stops_count, int interpolation, int space) {
  t = clamp(t, 0.0, 1.0);
  if (interpolation == ${INTERP_INDEX("constant")}) t = (floor(t * 1024.0) + 0.5) / 1024.0;
  if (stops_count < 0.5) return float4(t, t, t, 1.0);
  float pfirst = stops_pos[0];
  float4 cfirst = stops_color[0];
  float pa = pfirst;
  float4 ca = cfirst;
  float pb = pfirst;
  float4 cb = cfirst;
  float plast = pfirst;
  float4 clast = cfirst;
  bool found = false;
  for (int i = 1; i < ${MAX}; i++) {
    if (float(i) >= stops_count) break;
    plast = stops_pos[i];
    clast = stops_color[i];
    if (!found) {
      pb = plast;
      cb = clast;
      if (t <= pb) found = true;
      else {
        pa = pb;
        ca = cb;
      }
    }
  }
  float4 w;
  if (t <= pfirst) w = tbx_shape_cells_knot(cfirst, space);
  else if (t >= plast) w = tbx_shape_cells_knot(clast, space);
  else if (interpolation == ${INTERP_INDEX("constant")}) w = tbx_shape_cells_knot(ca, space);
  else {
    float4 wa = tbx_shape_cells_knot(ca, space);
    float4 wb = tbx_shape_cells_knot(cb, space);
    float f = tbx_shape_cells_remap((t - pa) / max(pb - pa, 1e-4), interpolation);
    w = wa + (wb - wa) * f;
  }
  return tbx_shape_cells_from_working(w, space);
}

float4 tbx_shape_cells(float2 uv, float2 res, float rows, float cols, float cellSize,
                       float lockBaseShape, float useCircle, float useSquare, float useTriangle,
                       float copiesMin, float copiesMax, float scaleMin, float scaleMax,
                       float ramp_pos[${MAX}], float4 ramp_color[${MAX}], float ramp_count,
                       int interpolation, int space, float hueShift, float speed, float seed,
                       float4 background, float opacity) {
  const float TAU = 6.28318530718;
  // Shape Cells normalizes these in compute before the draw.
  float2 grid = float2(max(1.0, floor(cols)), max(1.0, floor(rows)));
  float cs = max(0.001, cellSize);
  float cmin0 = max(1.0, floor(copiesMin));
  float cmax0 = max(1.0, floor(copiesMax));
  float cmin = min(cmin0, cmax0);
  float cmax = max(cmin0, cmax0);
  float smin0 = max(0.0, scaleMin);
  float smax0 = max(0.0, scaleMax);
  float smin = min(smin0, smax0);
  float smax = max(smin0, smax0);
  float seedI = floor(seed);

  // Grid the canvas: cell coords in [0, grid), local coords in [0, 1).
  float2 gridPos = uv * grid;
  float2 cellId = floor(gridPos);
  float2 cellLocal = gridPos - cellId;
  // Aspect-preserving local pixel space, centered on the cell.
  float2 cellPx = res / grid;
  float cellMinPx = min(cellPx.x, cellPx.y);
  float2 p = (cellLocal - 0.5) * cellPx;

  // Per-cell randomness: the float cell hash (see the file header).
  float4 r1 = tbx_noise2_cellhash(float4(cellId, seedI, 0.0));
  float4 r2 = tbx_noise2_cellhash(float4(cellId, seedI + 17.0, 0.0));

  float shape = tbx_shape_cells_pick(useCircle, useSquare, useTriangle, r1.x);
  float copyRange = cmax - cmin + 1.0;
  float copies = clamp(cmin + floor(r1.y * copyRange), 1.0, ${MAX_COPIES.toFixed(1)});
  float baseHue = r1.z;
  float cellPhase = r1.w * TAU;
  float maxR = 0.5 * cs * cellMinPx;

  float4 color = float4(background.rgb, 1.0);
  for (int i = 0; i < ${MAX_COPIES}; i++) {
    float fi = float(i);
    if (fi >= copies) break;
    // Ring i owns the band [bandLo, bandHi] of [scaleMin, scaleMax].
    float fOuter = fi / copies;
    float fInner = (fi + 1.0) / copies;
    float bandHi = mix(smax, smin, fOuter);
    float bandLo = mix(smax, smin, fInner);
    float copyPhase = fi * 1.7 + r2.x * TAU;
    float osc = 0.5 + 0.5 * sin(iTime * speed + cellPhase + copyPhase);
    float scaleFrac = mix(bandLo, bandHi, osc);
    if (lockBaseShape > 0.5 && i == 0) scaleFrac = smax;

    float r = scaleFrac * maxR;
    float d = tbx_shape_cells_sd(shape, p, r);
    // fwidth(d) without derivatives: one-pixel forward differences.
    float aa = abs(tbx_shape_cells_sd(shape, p + float2(1.0, 0.0), r) - d)
             + abs(tbx_shape_cells_sd(shape, p + float2(0.0, 1.0), r) - d);
    float alpha = 1.0 - smoothstep(-aa, aa, d);
    if (alpha > 0.0) {
      float rampPos = fract(baseHue + fi * hueShift + 1.0);
      float4 c = tbx_shape_cells_ramp(rampPos, ramp_pos, ramp_color, ramp_count, interpolation, space);
      color = mix(color, float4(c.rgb, 1.0), alpha * c.a);
    }
  }
  return float4(color.rgb, color.a * opacity);
}`;

export const skiaShapeCellsNode = defineSkslNode({
  type: "skia-shape-cells",
  name: "Shape Cells (Skia)",
  mirrors: "shape-cells",
  subcategory: "generator",
  description:
    "Skia-layer Shape Cells: a grid of cells with nested concentric circle / square / triangle copies whose scales oscillate over time, colored from the ramp, as an SkSL function that fuses into the layer's one runtime shader. Same params as Shape Cells; the per-cell randomness uses a float hash, so the layout differs from Shape Cells for the same seed.",
  searchAliases: ["shape cells", "grid", "concentric", "pattern", "skia", "sksl"],
  facts: {
    reads: ["time"],
    gotchas: [
      "Per-cell shape, copy count, base hue and phase come from a float hash (Skia has no uint), so the layout differs from Shape Cells for the same seed; one shape + one copy + lockBaseShape matches.",
      "No time input: the shader reads the clock (iTime, Shape Cells' unwired fallback); speed scales it.",
      "Edges antialias over the SDF's one-pixel forward differences instead of fwidth, so the GL node's faint 1-px seams on cell borders are absent.",
      "cellSize is a 0..1 fraction of the shorter cell axis (aspect-preserving); copies are clamped to 1..8 and lockBaseShape pins only the outermost ring to scaleMax.",
      "interpolation cardinal/monotone/bspline/smooth and space oklch/oklch_long are not ported: the node emits transparent and reports them.",
      "The output is opaque (background, alpha 1) times opacity, which is folded into the shader's alpha.",
    ],
  },
  fn: {
    id: "tbx.shape_cells@1",
    entry: "tbx_shape_cells",
    source: SHAPE_CELLS_SKSL,
    params: [
      { name: "rows", type: "float" },
      { name: "cols", type: "float" },
      { name: "cellSize", type: "float" },
      { name: "lockBaseShape", type: "float" },
      { name: "useCircle", type: "float" },
      { name: "useSquare", type: "float" },
      { name: "useTriangle", type: "float" },
      { name: "copiesMin", type: "float" },
      { name: "copiesMax", type: "float" },
      { name: "scaleMin", type: "float" },
      { name: "scaleMax", type: "float" },
      { name: "ramp_pos", type: "float", count: MAX },
      { name: "ramp_color", type: "color", count: MAX },
      { name: "ramp_count", type: "float" },
      { name: "interpolation", type: "int" },
      { name: "space", type: "int" },
      { name: "hueShift", type: "float" },
      { name: "speed", type: "float" },
      { name: "seed", type: "float" },
      { name: "background", type: "color" },
      { name: "opacity", type: "float" },
    ],
    inputs: [],
    uses: ["tbx.noise.cellhash", "tbx.color.srgb", "tbx.color.oklab"],
    usesTime: true,
    // Up to 8 rings × 3 SDF evaluations + a 16-stop ramp walk per ring hit.
    cost: 3,
  },
  params: mirrorParams(shapeCellsNode, [
    "opacity",
    "rows",
    "cols",
    "cellSize",
    "lockBaseShape",
    "useCircle",
    "useSquare",
    "useTriangle",
    "copiesMin",
    "copiesMax",
    "scaleMin",
    "scaleMax",
    "ramp",
    "interpolation",
    "space",
    "hueShift",
    "speed",
    "seed",
    "background",
  ]),
  // The ramp is one param split into the three uniform arrays.
  binds({ params, nodeId }) {
    const { pos, color, count } = packRampStops(params.ramp);
    const deps = [{ node: nodeId, param: "ramp" }];
    return {
      ramp_pos: bindDerived(pos, deps),
      ramp_color: bindDerived(color, deps),
      ramp_count: bindDerived(count, deps),
    };
  },
  unsupported(params) {
    const out: string[] = [];
    const interp = normalizeRampInterp(params.interpolation ?? "constant");
    const space = normalizeRampSpace(params.space);
    if (UNPORTED_INTERP.has(interp)) {
      out.push(`Shape Cells (Skia) does not port interpolation=${interp} yet (linear, ease, smoother, sine, ease_in, ease_out, constant).`);
    }
    if (UNPORTED_SPACE.has(space)) {
      out.push(`Shape Cells (Skia) does not port space=${space} yet (srgb, linear, oklab).`);
    }
    return out;
  },
});
