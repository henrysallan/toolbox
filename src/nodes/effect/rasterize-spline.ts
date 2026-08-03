import type {
  NodeDefinition,
  RenderContext,
  SplineSubpath,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";
import {
  compositeSplineFill,
  makeZeroTex,
  type SplineFillFit,
} from "@/engine/spline-fill";
import { type ColorRampStop } from "@/engine/color-ramp";
import {
  makeSubpathColorFn,
  type ColorRampBy,
} from "@/engine/spline-color-source";
import { resolveStrokePx, strokeUnitsParam } from "@/engine/stroke-units";
import { SPLINE_FILL_INPUT } from "@/nodes/source/spline-raster-aux";

// One-shot rasterizer that does Fill + Stroke in a single Canvas2D pass.
// Equivalent to wiring a Fill into a Stroke through a Merge, but skips
// the intermediate framebuffers and the second canvas. Either pass can
// be toggled off independently. Fill draws first so the stroke sits on
// top — matches what you'd get from compositing Fill under Stroke.

const RASTER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

function makeTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("rasterize-spline: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

interface RasterState {
  rasterCanvas: HTMLCanvasElement;
  // Single-bake fill+stroke (flat-fill path).
  rasterTex: WebGLTexture | null;
  // Image-fill path layers, created lazily.
  fillTex: WebGLTexture | null;
  strokeTex: WebGLTexture | null;
  zeroTex: WebGLTexture | null;
  lastSig: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): RasterState {
  const key = `rasterize-spline:${nodeId}`;
  const existing = ctx.state[key] as RasterState | undefined;
  if (existing) return existing;
  const s: RasterState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: makeTex(ctx.gl),
    fillTex: null,
    strokeTex: null,
    zeroTex: null,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

function uploadCanvas(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  c: HTMLCanvasElement
) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// ---- Hole islands (the `holes` param) -----------------------------------
//
// Per-subpath fills (stacking, ramp colors, layered mode) paint nested
// contours SOLID — a donut's inner ring, a letter's counter, a liquid
// surface's air pocket all fill over. With `holes` on, subpaths are
// grouped into containment ISLANDS — an even-nesting-depth outer plus
// the odd-depth contours directly inside it — and each island fills as
// ONE even-odd path (color from its outer), so negative space punches
// while per-island colors and stacking order survive.

interface HoleIsland {
  root: number;
  holes: number[];
}

// Flatten a subpath to polyline vertices (normalized coords) for
// containment tests — 8 samples per cubic is plenty for nesting.
function flattenForContainment(sub: SplineSubpath): number[] {
  const pts: number[] = [];
  const anchors = sub.anchors;
  const n = anchors.length;
  if (n === 0) return pts;
  const segs = sub.closed ? n : n - 1;
  for (let k = 0; k < Math.max(1, segs); k++) {
    const a = anchors[k];
    const b = anchors[(k + 1) % n];
    const p0x = a.pos[0];
    const p0y = a.pos[1];
    const p1x = p0x + (a.outHandle?.[0] ?? 0);
    const p1y = p0y + (a.outHandle?.[1] ?? 0);
    const p3x = b.pos[0];
    const p3y = b.pos[1];
    const p2x = p3x + (b.inHandle?.[0] ?? 0);
    const p2y = p3y + (b.inHandle?.[1] ?? 0);
    for (let s = 0; s < 8; s++) {
      const t = s / 8;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      pts.push(
        w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x,
        w0 * p0y + w1 * p1y + w2 * p2y + w3 * p3y
      );
    }
  }
  return pts;
}

function pointInPoly(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function polyArea(poly: number[]): number {
  let acc = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    acc += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return Math.abs(acc) * 0.5;
}

// Group subpaths into containment islands. Returns null when there's
// nothing to group (or too many subpaths to test affordably — legacy
// behavior is the fallback).
function groupHoleIslands(subpaths: SplineSubpath[]): HoleIsland[] | null {
  const n = subpaths.length;
  if (n < 2 || n > 256) return null;
  const polys = subpaths.map(flattenForContainment);
  const containers: number[][] = [];
  for (let i = 0; i < n; i++) {
    const c: number[] = [];
    const px = polys[i][0];
    const py = polys[i][1];
    if (polys[i].length >= 6) {
      for (let j = 0; j < n; j++) {
        if (j === i || polys[j].length < 6) continue;
        if (pointInPoly(px, py, polys[j])) c.push(j);
      }
    }
    containers.push(c);
  }
  const islands = new Map<number, HoleIsland>();
  const orphanRoots: number[] = [];
  for (let i = 0; i < n; i++) {
    const depth = containers[i].length;
    if (depth % 2 === 0) {
      orphanRoots.push(i);
    }
  }
  for (const r of orphanRoots) islands.set(r, { root: r, holes: [] });
  for (let i = 0; i < n; i++) {
    const depth = containers[i].length;
    if (depth % 2 === 0) continue;
    // Attach the hole to its immediate container: the containing
    // subpath one level up, smallest area on ties.
    let parent = -1;
    let parentArea = Infinity;
    for (const j of containers[i]) {
      if (containers[j].length !== depth - 1) continue;
      const a = polyArea(polys[j]);
      if (a < parentArea) {
        parent = j;
        parentArea = a;
      }
    }
    const island = parent >= 0 ? islands.get(parent) : undefined;
    if (island) island.holes.push(i);
    else islands.set(i, { root: i, holes: [] }); // degenerate — solo it
  }
  return [...islands.values()].sort((a, b) => a.root - b.root);
}

// Fill the spline into the 2D context with `colorStyle` (a real color for the
// baked path; "#ffffff" for the image-fill coverage mask). Honors the
// stack-subpaths / fill-rule / holes params.
function drawSplineFill(
  c2d: CanvasRenderingContext2D,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>,
  W: number,
  H: number,
  colorStyle: string
) {
  c2d.fillStyle = colorStyle;
  const islands = params.holes === true ? groupHoleIslands(subpaths) : null;
  if (islands) {
    for (const isl of islands) {
      const members = [subpaths[isl.root], ...isl.holes.map((h) => subpaths[h])];
      const path = buildPath2D(members, W, H, true);
      if (path) c2d.fill(path, "evenodd");
    }
    return;
  }
  if (params.stack_subpaths !== false) {
    for (const sub of subpaths) {
      const path = buildPath2D([sub], W, H, true);
      if (path) c2d.fill(path);
    }
  } else {
    const path = buildPath2D(subpaths, W, H, true);
    if (path) c2d.fill(path, (params.fill_rule as CanvasFillRule) ?? "evenodd");
  }
}

// Apply the configured stroke style (solid / dashed / dotted, cap / join /
// miter, `stroke_color`) to the 2D context. Split out so both the combined
// stroke (flatten mode) and the per-subpath stroke (layered mode) share it.
// `colorStyle` overrides the flat stroke_color for per-subpath ramp colors.
function applyStrokeStyle(
  c2d: CanvasRenderingContext2D,
  params: Record<string, unknown>,
  W: number,
  colorStyle?: string
) {
  const style = (params.style as string) ?? "solid";
  const units = params.units;
  c2d.lineWidth = Math.max(
    0,
    resolveStrokePx((params.thickness as number) ?? 4, units, W)
  );
  c2d.strokeStyle =
    colorStyle ?? hexToRgba((params.stroke_color as string) ?? "#000000");
  c2d.lineJoin =
    (params.join as CanvasLineJoin) ?? ("round" as CanvasLineJoin);
  if (params.join === "miter") {
    c2d.miterLimit = (params.miter_limit as number) ?? 10;
  }
  if (style === "dashed") {
    const dash = Math.max(
      0.5,
      resolveStrokePx((params.dash_length as number) ?? 10, units, W)
    );
    const gap = Math.max(
      0.5,
      resolveStrokePx((params.dash_gap as number) ?? 8, units, W)
    );
    c2d.setLineDash([dash, gap]);
    c2d.lineCap = (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
  } else if (style === "dotted") {
    const spacing = Math.max(
      1,
      resolveStrokePx((params.dot_spacing as number) ?? 12, units, W)
    );
    c2d.setLineDash([0, spacing]);
    c2d.lineCap = "round";
  } else {
    c2d.setLineDash([]);
    c2d.lineCap = (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
  }
}

// Stroke the spline. Flat color strokes all subpaths in ONE pass (a single
// stroke() composites once, so translucent stroke colors don't double-blend
// where subpaths overlap — the legacy behavior). A stroke ramp needs a
// distinct color per subpath, so it strokes each one individually.
function drawSplineStroke(
  c2d: CanvasRenderingContext2D,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>,
  W: number,
  H: number
) {
  if ((params.stroke_source as string) === "ramp") {
    const colorAt = makeStrokeColorFn(subpaths, params);
    for (let i = 0; i < subpaths.length; i++) {
      const path = buildPath2D(
        [subpaths[i]],
        W,
        H,
        !!params.close_open_paths
      );
      if (!path) continue;
      applyStrokeStyle(c2d, params, W, colorAt(i, subpaths[i]));
      c2d.stroke(path);
    }
    return;
  }
  const path = buildPath2D(subpaths, W, H, !!params.close_open_paths);
  if (!path) return;
  applyStrokeStyle(c2d, params, W);
  c2d.stroke(path);
}

// Builds a per-subpath fill-color resolver. With `fill_source: "ramp"` each
// subpath samples the `fill_ramp` by its ordinal index / a seeded hash / its
// groupIndex / centroid position; otherwise every subpath uses the flat
// `fill_color`. The per-subpath sourcing lives engine-side (shared with the
// Stroke node) — this adapts the node's `fill_*` params onto it.
function makeFillColorFn(
  subpaths: SplineSubpath[],
  params: Record<string, unknown>
): (i: number, sub: SplineSubpath) => string {
  return makeSubpathColorFn(subpaths, {
    source: (params.fill_source as string) === "ramp" ? "ramp" : "flat",
    flatColor: (params.fill_color as string) ?? "#ffffff",
    stops: Array.isArray(params.fill_ramp)
      ? (params.fill_ramp as ColorRampStop[])
      : [],
    by: ((params.ramp_by as ColorRampBy) ?? "index"),
    seed: Math.floor((params.ramp_seed as number) ?? 0),
    angleDeg: (params.ramp_angle as number) ?? 0,
    interp: ((params.ramp_interp as string) ?? "linear") as
      | "linear"
      | "ease"
      | "constant",
  });
}

// The stroke-side twin of makeFillColorFn: adapts the node's `stroke_*`
// params onto the same shared per-subpath sourcing, with its own
// independent by/seed/angle/interp so fill and stroke can key differently.
function makeStrokeColorFn(
  subpaths: SplineSubpath[],
  params: Record<string, unknown>
): (i: number, sub: SplineSubpath) => string {
  return makeSubpathColorFn(subpaths, {
    source: (params.stroke_source as string) === "ramp" ? "ramp" : "flat",
    flatColor: (params.stroke_color as string) ?? "#000000",
    stops: Array.isArray(params.stroke_ramp)
      ? (params.stroke_ramp as ColorRampStop[])
      : [],
    by: ((params.stroke_ramp_by as ColorRampBy) ?? "index"),
    seed: Math.floor((params.stroke_ramp_seed as number) ?? 0),
    angleDeg: (params.stroke_ramp_angle as number) ?? 0,
    interp: ((params.stroke_ramp_interp as string) ?? "linear") as
      | "linear"
      | "ease"
      | "constant",
  });
}

// Draw the flat (non-image) fill + stroke composite into the 2D context,
// honoring the overlap mode:
//   flatten — all fills, then all strokes on top (subpath strokes always
//             visible — the classic "x-ray" over the union fill).
//   layered — each subpath filled then stroked in order, so a later shape's
//             opaque fill occludes earlier shapes' strokes (solid stacking).
// Per-subpath fill/stroke colors come from makeFillColorFn /
// makeStrokeColorFn (each independently flat or ramp).
function drawSplineFlat(
  c2d: CanvasRenderingContext2D,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>,
  W: number,
  H: number,
  enableFill: boolean,
  enableStroke: boolean
) {
  const fillColorAt = makeFillColorFn(subpaths, params);
  const strokeColorAt = makeStrokeColorFn(subpaths, params);
  const useRamp = (params.fill_source as string) === "ramp";
  const strokeRamp = (params.stroke_source as string) === "ramp";
  const layered = (params.overlap as string) === "layered";
  const closeStroke = !!params.close_open_paths;
  // Hole islands: nested contours punch out of their container while
  // per-island colors and stacking order survive (see groupHoleIslands).
  const islands =
    enableFill && params.holes === true ? groupHoleIslands(subpaths) : null;

  if (layered) {
    if (islands) {
      // Fill each island even-odd, then stroke its members — a later
      // island's fill still occludes earlier strokes (layered promise).
      for (const isl of islands) {
        const members = [
          subpaths[isl.root],
          ...isl.holes.map((h) => subpaths[h]),
        ];
        if (enableFill) {
          const p = buildPath2D(members, W, H, true);
          if (p) {
            c2d.fillStyle = fillColorAt(isl.root, subpaths[isl.root]);
            c2d.fill(p, "evenodd");
          }
        }
        if (enableStroke) {
          if (strokeRamp) {
            // Each member strokes in its own ramp color (holes included).
            for (const idx of [isl.root, ...isl.holes]) {
              const p = buildPath2D([subpaths[idx]], W, H, closeStroke);
              if (p) {
                applyStrokeStyle(c2d, params, W, strokeColorAt(idx, subpaths[idx]));
                c2d.stroke(p);
              }
            }
          } else {
            const p = buildPath2D(members, W, H, closeStroke);
            if (p) {
              applyStrokeStyle(c2d, params, W);
              c2d.stroke(p);
            }
          }
        }
      }
      return;
    }
    for (let i = 0; i < subpaths.length; i++) {
      const sub = subpaths[i];
      if (enableFill) {
        const p = buildPath2D([sub], W, H, true);
        if (p) {
          c2d.fillStyle = fillColorAt(i, sub);
          c2d.fill(p);
        }
      }
      if (enableStroke) {
        const p = buildPath2D([sub], W, H, closeStroke);
        if (p) {
          applyStrokeStyle(c2d, params, W, strokeColorAt(i, sub));
          c2d.stroke(p);
        }
      }
    }
    return;
  }

  // flatten: all fills first, then all strokes on top.
  if (enableFill) {
    if (islands) {
      for (const isl of islands) {
        const members = [
          subpaths[isl.root],
          ...isl.holes.map((h) => subpaths[h]),
        ];
        const p = buildPath2D(members, W, H, true);
        if (p) {
          c2d.fillStyle = fillColorAt(isl.root, subpaths[isl.root]);
          c2d.fill(p, "evenodd");
        }
      }
    } else if (useRamp || params.stack_subpaths !== false) {
      // Ramp needs distinct per-subpath colors, and stacked subpaths union;
      // both draw per subpath. Only flat-color + stack-off collapses to one
      // even-odd fill (nested subpaths punch holes).
      for (let i = 0; i < subpaths.length; i++) {
        const sub = subpaths[i];
        const p = buildPath2D([sub], W, H, true);
        if (p) {
          c2d.fillStyle = fillColorAt(i, sub);
          c2d.fill(p);
        }
      }
    } else {
      const p = buildPath2D(subpaths, W, H, true);
      if (p) {
        c2d.fillStyle = fillColorAt(0, subpaths[0]);
        c2d.fill(p, (params.fill_rule as CanvasFillRule) ?? "evenodd");
      }
    }
  }
  if (enableStroke) drawSplineStroke(c2d, subpaths, params, W, H);
}

export const rasterizeSplineNode: NodeDefinition = {
  type: "rasterize-spline",
  name: "Rasterize Spline",
  category: "spline",
  subcategory: "modifier",
  description:
    "Rasterize a spline as fill, stroke, or both in a single pass. Fill draws underneath the stroke. Toggle each independently. Fill and stroke colors can each be a flat color or a per-subpath ramp keyed by index, seeded random, group, centroid position, or driver — sourced independently, so e.g. fill by index and stroke by random. A wired fill image can drive the fill, the stroke, or both via the Image → fill / Image → stroke toggles.",
  backend: "webgl2",
  inputs: [
    { name: "path", type: "spline", required: true },
    // Optional fill image — sampled (per fill_fit) by whichever passes the
    // image_fill / image_stroke toggles route it to. Defaults (fill on,
    // stroke off) reproduce the original fills-only behavior.
    SPLINE_FILL_INPUT,
  ],
  params: [
    // ---- Overlap ----
    // How overlapping subpaths composite. "flatten" (legacy) draws all fills
    // then all strokes on top, so every stroke floats over the union fill
    // (the "x-ray" look). "layered" fills + strokes each subpath in order, so
    // a later shape's opaque fill occludes earlier shapes' strokes — solid
    // stacked cards, the intended combo with a per-spline ramp fill.
    {
      name: "overlap",
      label: "Overlap",
      type: "enum",
      options: ["flatten", "layered"],
      default: "flatten",
    },
    // Punch negative space: contours nested inside another contour cut
    // OUT of it (text counters, donuts, air pockets in a Points to
    // Surface skin) instead of filling solid. Works with ramp colors
    // (each island takes its outer contour's color) and both overlap
    // modes. Off by default — existing saves render identically.
    {
      name: "holes",
      label: "Punch holes",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.enable_fill !== false,
    },

    // ---- Fill ----
    {
      name: "enable_fill",
      label: "Fill",
      type: "boolean",
      default: true,
    },
    // Flat color vs. a per-subpath color ramp. Ramp colors each subpath by
    // its ordinal index / a seeded hash / its groupIndex (see ramp_by). A
    // wired `fill` image still overrides both.
    {
      name: "fill_source",
      label: "Fill source",
      type: "enum",
      options: ["flat", "ramp"],
      default: "flat",
      visibleIf: (p) => p.enable_fill !== false,
    },
    // alpha: consumed via spline-color-source's flatColor (hexToRgba) and
    // compositeSplineFill's fillColorHex (hexToRgba01) — both 8-digit-safe;
    // the raster signatures key on the raw hex.
    {
      name: "fill_color",
      label: "Fill color",
      type: "color",
      default: "#ffffff",
      alpha: true,
      visibleIf: (p) =>
        p.enable_fill !== false && p.fill_source !== "ramp",
    },
    {
      name: "fill_ramp",
      label: "Fill ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#000000" },
      ] as ColorRampStop[],
      visibleIf: (p) =>
        p.enable_fill !== false && p.fill_source === "ramp",
    },
    // Which value drives each subpath's position along the ramp.
    //   index    — ordinal 0→N-1 mapped left→right (gradient across copies)
    //   random   — seeded per-subpath hash (scattered; seed reshuffles)
    //   group    — the subpath's groupIndex, normalized over distinct groups
    //   position — the subpath's centroid projected on a steerable axis
    //              (ramp_angle). Color tracks WHERE a region is, not its array
    //              index, so it stays put when the subpath count/order churns
    //              frame to frame — the fix for the color flicker you get
    //              rasterizing Spline Merge Flow's regions (which are re-
    //              extracted, so index/count jump every frame).
    {
      name: "ramp_by",
      label: "Ramp by",
      type: "enum",
      options: ["index", "random", "group", "position", "driver"],
      default: "index",
      visibleIf: (p) =>
        p.enable_fill !== false && p.fill_source === "ramp",
    },
    {
      name: "ramp_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.enable_fill !== false &&
        p.fill_source === "ramp" &&
        p.ramp_by === "random",
    },
    {
      // Gradient axis for `position` mode, in degrees. 0 = left→right (color
      // by centroid x), 90 = top→bottom (by y), any angle in between.
      name: "ramp_angle",
      label: "Gradient angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.enable_fill !== false &&
        p.fill_source === "ramp" &&
        p.ramp_by === "position",
    },
    {
      name: "ramp_interp",
      label: "Ramp interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) =>
        p.enable_fill !== false && p.fill_source === "ramp",
    },
    {
      name: "fill_fit",
      label: "Fill fit",
      type: "enum",
      options: ["window", "contain", "cover"],
      default: "window",
      visibleIf: (p) => p.enable_fill !== false,
    },
    // Which passes sample a wired `fill` image. Fill defaults ON (the
    // pre-toggle behavior — invariant #2); stroke defaults OFF. With
    // image→fill off the flat/ramp fill color renders as usual and the
    // image can drive the stroke alone. No-ops with nothing wired.
    {
      name: "image_fill",
      label: "Image → fill",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.enable_fill !== false,
    },
    // Stack/fill-rule only matter for the flatten mode with a flat color —
    // layered and ramp both draw per subpath.
    {
      name: "stack_subpaths",
      label: "Stack subpaths",
      type: "boolean",
      default: true,
      visibleIf: (p) =>
        p.enable_fill !== false &&
        p.overlap !== "layered" &&
        p.fill_source !== "ramp",
    },
    {
      name: "fill_rule",
      label: "Fill rule",
      type: "enum",
      options: ["evenodd", "nonzero"],
      default: "evenodd",
      visibleIf: (p) =>
        p.enable_fill !== false &&
        p.stack_subpaths === false &&
        p.overlap !== "layered" &&
        p.fill_source !== "ramp",
    },

    // ---- Stroke ----
    {
      name: "enable_stroke",
      label: "Stroke",
      type: "boolean",
      default: true,
    },
    // Flat color vs. a per-subpath color ramp — the same sourcing the fill
    // has (see fill_source), with its own independent by/seed/angle/interp
    // so fill and stroke can key differently. A wired image with
    // Image → stroke on still overrides both.
    {
      name: "stroke_source",
      label: "Stroke source",
      type: "enum",
      options: ["flat", "ramp"],
      default: "flat",
      visibleIf: (p) => p.enable_stroke !== false,
    },
    // alpha: consumed through hexToRgba into the Canvas strokeStyle
    // (8-digit-safe); the raster signature keys on the raw hex.
    {
      name: "stroke_color",
      label: "Stroke color",
      type: "color",
      default: "#000000",
      alpha: true,
      visibleIf: (p) =>
        p.enable_stroke !== false && p.stroke_source !== "ramp",
    },
    {
      name: "stroke_ramp",
      label: "Stroke ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#000000" },
      ] as ColorRampStop[],
      visibleIf: (p) =>
        p.enable_stroke !== false && p.stroke_source === "ramp",
    },
    // Which value drives each subpath's position along the stroke ramp —
    // same modes as the fill's ramp_by (see that comment for semantics).
    {
      name: "stroke_ramp_by",
      label: "Ramp by",
      type: "enum",
      options: ["index", "random", "group", "position", "driver"],
      default: "index",
      visibleIf: (p) =>
        p.enable_stroke !== false && p.stroke_source === "ramp",
    },
    {
      name: "stroke_ramp_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.enable_stroke !== false &&
        p.stroke_source === "ramp" &&
        p.stroke_ramp_by === "random",
    },
    {
      name: "stroke_ramp_angle",
      label: "Gradient angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.enable_stroke !== false &&
        p.stroke_source === "ramp" &&
        p.stroke_ramp_by === "position",
    },
    {
      name: "stroke_ramp_interp",
      label: "Ramp interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) =>
        p.enable_stroke !== false && p.stroke_source === "ramp",
    },
    // See image_fill above — lets the wired `fill` image color the stroke
    // (its coverage stays the configured thickness/style/dashes).
    {
      name: "image_stroke",
      label: "Image → stroke",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.enable_stroke !== false,
    },
    {
      name: "thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
      visibleIf: (p) => p.enable_stroke !== false,
    },
    // px = absolute pixels (legacy); % = percent of canvas width, so the
    // stroke keeps its look at any resolution (#174). Applies to thickness
    // and the dash/dot metrics below.
    strokeUnitsParam("units", (p) => p.enable_stroke !== false),
    {
      name: "style",
      label: "Style",
      type: "enum",
      options: ["solid", "dashed", "dotted"],
      default: "solid",
      visibleIf: (p) => p.enable_stroke !== false,
    },
    {
      name: "dash_length",
      label: "Dash length",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 10,
      visibleIf: (p) => p.enable_stroke !== false && p.style === "dashed",
    },
    {
      name: "dash_gap",
      label: "Dash gap",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 8,
      visibleIf: (p) => p.enable_stroke !== false && p.style === "dashed",
    },
    {
      name: "dot_spacing",
      label: "Dot spacing",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 12,
      visibleIf: (p) => p.enable_stroke !== false && p.style === "dotted",
    },
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["round", "butt", "square"],
      default: "round",
      visibleIf: (p) => p.enable_stroke !== false && p.style !== "dotted",
    },
    {
      name: "join",
      label: "Join",
      type: "enum",
      options: ["round", "miter", "bevel"],
      default: "round",
      visibleIf: (p) => p.enable_stroke !== false,
    },
    {
      name: "miter_limit",
      label: "Miter limit",
      type: "scalar",
      min: 1,
      max: 20,
      step: 0.1,
      default: 10,
      visibleIf: (p) => p.enable_stroke !== false && p.join === "miter",
    },
    {
      name: "close_open_paths",
      label: "Close open paths",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.enable_stroke !== false,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const state = ensureState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;
    const gl = ctx.gl;

    const enableFill = params.enable_fill !== false;
    const enableStroke = params.enable_stroke !== false;

    // Which passes the wired image drives (image_fill defaults on — the
    // pre-toggle behavior; image_stroke defaults off).
    const wiredImage = inputs.fill?.kind === "image" ? inputs.fill : null;
    const imgToFill = !!wiredImage && enableFill && params.image_fill !== false;
    const imgToStroke =
      !!wiredImage && enableStroke && params.image_stroke === true;

    if (!imgToFill && !imgToStroke) {
      // --- Flat path: bake fill (under) + stroke (over) into one canvas. ---
      const sig = JSON.stringify({
        mode: "flat",
        subRef: src.subpaths,
        ov: params.overlap,
        hol: params.holes,
        ef: enableFill,
        fsrc: params.fill_source,
        fc: params.fill_color,
        ramp: params.fill_source === "ramp" ? params.fill_ramp : null,
        rby: params.ramp_by,
        rseed: params.ramp_seed,
        rangle: params.ramp_by === "position" ? params.ramp_angle : null,
        rint: params.ramp_interp,
        stack: params.stack_subpaths,
        fr: params.fill_rule,
        es: enableStroke,
        ssrc: params.stroke_source,
        sc: params.stroke_color,
        sramp: params.stroke_source === "ramp" ? params.stroke_ramp : null,
        sby: params.stroke_ramp_by,
        sseed: params.stroke_ramp_seed,
        sangle:
          params.stroke_ramp_by === "position"
            ? params.stroke_ramp_angle
            : null,
        sint: params.stroke_ramp_interp,
        t: params.thickness,
        u: params.units,
        st: params.style,
        dl: params.dash_length,
        dg: params.dash_gap,
        ds: params.dot_spacing,
        cap: params.cap,
        jn: params.join,
        ml: params.miter_limit,
        close: !!params.close_open_paths,
        W,
        H,
      });
      if (sig !== state.lastSig) {
        const canvas = state.rasterCanvas;
        if (canvas.width !== W || canvas.height !== H) {
          canvas.width = W;
          canvas.height = H;
        }
        const c2d = canvas.getContext("2d");
        if (c2d) {
          c2d.clearRect(0, 0, W, H);
          drawSplineFlat(
            c2d,
            src.subpaths,
            params,
            W,
            H,
            enableFill,
            enableStroke
          );
          uploadCanvas(gl, state.rasterTex!, canvas);
        }
        state.lastSig = sig;
      }

      const prog = ctx.getShader("rasterize-spline/blit", RASTER_FS);
      ctx.drawFullscreen(prog, output, (gl2) => {
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
        gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      });
      return { primary: output };
    }

    // --- Image path: fill + stroke layers, composite the wired image into
    // whichever passes sample it. ---
    if (!state.fillTex) state.fillTex = makeTex(gl);
    if (!state.strokeTex) state.strokeTex = makeTex(gl);
    if (!state.zeroTex) state.zeroTex = makeZeroTex(gl);

    // The layers don't depend on the image pixels, so dragging only the
    // upstream image re-composites without re-rastering. (When the image
    // doesn't drive the fill, the fill layer bakes its real colors — those
    // params join the signature.)
    const sig = JSON.stringify({
      mode: "img",
      subRef: src.subpaths,
      imf: imgToFill,
      ims: imgToStroke,
      ef: enableFill,
      ov: params.overlap,
      hol: params.holes,
      fsrc: params.fill_source,
      fc: params.fill_color,
      ramp: params.fill_source === "ramp" ? params.fill_ramp : null,
      rby: params.ramp_by,
      rseed: params.ramp_seed,
      rangle: params.ramp_by === "position" ? params.ramp_angle : null,
      rint: params.ramp_interp,
      stack: params.stack_subpaths,
      fr: params.fill_rule,
      es: enableStroke,
      ssrc: params.stroke_source,
      sc: params.stroke_color,
      sramp: params.stroke_source === "ramp" ? params.stroke_ramp : null,
      sby: params.stroke_ramp_by,
      sseed: params.stroke_ramp_seed,
      sangle:
        params.stroke_ramp_by === "position" ? params.stroke_ramp_angle : null,
      sint: params.stroke_ramp_interp,
      t: params.thickness,
      u: params.units,
      st: params.style,
      dl: params.dash_length,
      dg: params.dash_gap,
      ds: params.dot_spacing,
      cap: params.cap,
      jn: params.join,
      ml: params.miter_limit,
      close: !!params.close_open_paths,
      W,
      H,
    });
    if (sig !== state.lastSig) {
      const canvas = state.rasterCanvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        // Fill layer: coverage (white-on-transparent) when the image drives
        // the fill; otherwise the finished flat/ramp fill in its real colors,
        // passed to the compositor as a precolored layer.
        c2d.clearRect(0, 0, W, H);
        if (imgToFill) {
          drawSplineFill(c2d, src.subpaths, params, W, H, "#ffffff");
        } else if (enableFill) {
          drawSplineFlat(c2d, src.subpaths, params, W, H, true, false);
        }
        uploadCanvas(gl, state.fillTex, canvas);
        // Stroke layer in its own color (its alpha is the coverage the
        // compositor recolors when image→stroke is on).
        c2d.clearRect(0, 0, W, H);
        if (enableStroke) drawSplineStroke(c2d, src.subpaths, params, W, H);
        uploadCanvas(gl, state.strokeTex, canvas);
      }
      state.lastSig = sig;
    }

    const fit = ((params.fill_fit as string) ?? "window") as SplineFillFit;
    compositeSplineFill(ctx, output, {
      fillMaskTex: enableFill ? state.fillTex : state.zeroTex,
      strokeTex: enableStroke ? state.strokeTex : null,
      fillImage: wiredImage,
      fillColorHex: (params.fill_color as string) ?? "#ffffff",
      fit,
      subpaths: src.subpaths,
      zeroTex: state.zeroTex,
      // With image→fill off, the fill layer is already its final colors
      // (or zeroTex when fill is disabled) — use it verbatim.
      fillPrecolored: !imgToFill,
      strokeFromImage: imgToStroke,
    });
    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = `rasterize-spline:${nodeId}`;
    const state = ctx.state[key] as RasterState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    if (state?.fillTex) ctx.gl.deleteTexture(state.fillTex);
    if (state?.strokeTex) ctx.gl.deleteTexture(state.strokeTex);
    if (state?.zeroTex) ctx.gl.deleteTexture(state.zeroTex);
    delete ctx.state[key];
  },
};
