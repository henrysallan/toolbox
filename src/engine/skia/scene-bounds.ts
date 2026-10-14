// Analytic bounds of a Skia scene IR subtree (scene-ir.ts), in scene px —
// what Copy to Points (Skia) anchors "content center" on and sizes an atlas
// sprite sheet by. The GL Copy to Points finds its content center from an
// alpha bbox of the rendered instance (a ≤128 px readback); Skia-layer
// nodes are data-only (no GL, no CanvasKit in compute), so this reads the
// geometry instead:
//
//   shapes   the geometry's tight box (cubic / quadratic extrema for SVG
//            path data), grown by half the stroke width (× the miter limit
//            for miter joins, × √2 for square caps) and 3σ of a blur mask
//   images   their destination rect;  atlases  every sprite's mapped corners
//   groups   the children through the group transform, cut by a clip,
//            grown by the layer's native image filters (blur 3σ, shadow,
//            offset, morphology, displacement)
//
// Draws with no finite extent — a Fill, a runtime image filter — and text
// (whose glyph extents need the font) make the result `unbounded`: callers
// treat the instance as the canvas (the GL node's instance IS a canvas-sized
// image), with `why` saying which draw did it.
//
// Pure and deterministic: the same tree gives the same box at every tick, so
// a static instance anchors identically in the preview and in every sampled
// export frame.

import type { GeomIR, ImageFilterIR, PaintIR, SkiaNode } from "./scene-ir";
import { transformMatrix } from "./scene-render";

// [x0, y0, x1, y1]
export type Box = [number, number, number, number];

export interface SceneBounds {
  // The union of every bounded draw; null when nothing bounded draws.
  box: Box | null;
  // Some draw has no analytic extent (fill, runtime filter, text).
  unbounded: boolean;
  why: string[];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return out;
}

function mapBox(m: number[], b: Box): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[0], b[3]],
    [b[2], b[3]],
  ]) {
    const w = m[6] * x + m[7] * y + m[8] || 1;
    xs.push((m[0] * x + m[1] * y + m[2]) / w);
    ys.push((m[3] * x + m[4] * y + m[5]) / w);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function grow(b: Box | null, d: number): Box | null {
  return b && d > 0 ? [b[0] - d, b[1] - d, b[2] + d, b[3] + d] : b;
}

function finite(b: Box | null): Box | null {
  return b && b.every((v) => Number.isFinite(v)) ? b : null;
}

// Largest axis scale of a 2×2 (for filter radii given in parent units).
function maxScale(m: number[]): number {
  return Math.max(Math.hypot(m[0], m[3]), Math.hypot(m[1], m[4]));
}

const nv = (b: { v: unknown } | undefined, d: number) => (b && typeof b.v === "number" && Number.isFinite(b.v) ? b.v : d);

// ---- SVG path data ------------------------------------------------------------------

// Extrema of one cubic / quadratic coordinate on (0, 1).
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts
    .filter((t) => t > 0 && t < 1)
    .map((t) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    });
}

function quadExtrema(p0: number, p1: number, p2: number): number[] {
  const den = p0 - 2 * p1 + p2;
  if (Math.abs(den) < 1e-12) return [];
  const t = (p0 - p1) / den;
  if (!(t > 0 && t < 1)) return [];
  const u = 1 - t;
  return [u * u * p0 + 2 * u * t * p1 + t * t * p2];
}

// Tight box of SVG path data (M L H V C S Q T A Z, absolute and relative).
// Arcs are boxed conservatively (each end ± the larger radius).
export function svgPathBox(d: string): Box | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return null;
  let box: Box | null = null;
  const add = (x: number, y: number) => {
    box = union(box, [x, y, x, y]);
  };
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  const num = () => Number(tokens[i++]);
  const more = () => i < tokens.length && !/[A-Za-z]/.test(tokens[i]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) return box;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    if (C === "Z") {
      cx = sx;
      cy = sy;
      lastC = lastQ = null;
      if (!more()) continue;
      cmd = "";
      continue;
    }
    if (!more()) return box;
    switch (C) {
      case "M": {
        cx = ox + num();
        cy = oy + num();
        sx = cx;
        sy = cy;
        add(cx, cy);
        cmd = rel ? "l" : "L";
        lastC = lastQ = null;
        break;
      }
      case "L":
        cx = ox + num();
        cy = oy + num();
        add(cx, cy);
        lastC = lastQ = null;
        break;
      case "H":
        cx = ox + num();
        add(cx, cy);
        lastC = lastQ = null;
        break;
      case "V":
        cy = oy + num();
        add(cx, cy);
        lastC = lastQ = null;
        break;
      case "C":
      case "S": {
        let x1: number;
        let y1: number;
        if (C === "C") {
          x1 = ox + num();
          y1 = oy + num();
        } else {
          x1 = lastC ? 2 * cx - lastC[0] : cx;
          y1 = lastC ? 2 * cy - lastC[1] : cy;
        }
        const x2 = ox + num();
        const y2 = oy + num();
        const x = ox + num();
        const y = oy + num();
        add(x, y);
        // Each axis's extrema widen that axis only (the curve's other
        // coordinate there lies inside what the ends already span or is
        // that axis's own extremum).
        const xs = cubicExtrema(cx, x1, x2, x);
        const ys = cubicExtrema(cy, y1, y2, y);
        const bx = box as Box | null;
        if (bx && (xs.length || ys.length)) box = [Math.min(bx[0], ...xs), Math.min(bx[1], ...ys), Math.max(bx[2], ...xs), Math.max(bx[3], ...ys)];
        lastC = [x2, y2];
        lastQ = null;
        cx = x;
        cy = y;
        break;
      }
      case "Q":
      case "T": {
        let x1: number;
        let y1: number;
        if (C === "Q") {
          x1 = ox + num();
          y1 = oy + num();
        } else {
          x1 = lastQ ? 2 * cx - lastQ[0] : cx;
          y1 = lastQ ? 2 * cy - lastQ[1] : cy;
        }
        const x = ox + num();
        const y = oy + num();
        add(x, y);
        const xs = quadExtrema(cx, x1, x);
        const ys = quadExtrema(cy, y1, y);
        const bx = box as Box | null;
        if (bx && (xs.length || ys.length)) box = [Math.min(bx[0], ...xs), Math.min(bx[1], ...ys), Math.max(bx[2], ...xs), Math.max(bx[3], ...ys)];
        lastQ = [x1, y1];
        lastC = null;
        cx = x;
        cy = y;
        break;
      }
      case "A": {
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        num();
        num();
        num();
        const x = ox + num();
        const y = oy + num();
        const r = Math.max(rx, ry);
        box = union(box, [Math.min(cx, x) - r, Math.min(cy, y) - r, Math.max(cx, x) + r, Math.max(cy, y) + r]);
        cx = x;
        cy = y;
        lastC = lastQ = null;
        break;
      }
      default:
        return box;
    }
  }
  return box;
}

// ---- geometry + paint ----------------------------------------------------------------

export function geomBox(g: GeomIR): Box | null {
  switch (g?.k) {
    case "rect":
    case "oval": {
      const x = nv(g.x, 0);
      const y = nv(g.y, 0);
      const w = nv(g.w, 0);
      const h = nv(g.h, 0);
      return [Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)];
    }
    case "circle": {
      const r = Math.abs(nv(g.r, 0));
      const cx = nv(g.cx, 0);
      const cy = nv(g.cy, 0);
      return [cx - r, cy - r, cx + r, cy + r];
    }
    case "line": {
      const x1 = nv(g.p1[0], 0);
      const y1 = nv(g.p1[1], 0);
      const x2 = nv(g.p2[0], 0);
      const y2 = nv(g.p2[1], 0);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    }
    case "path":
      return typeof g.d?.v === "string" ? svgPathBox(g.d.v) : null;
    case "points": {
      const p = Array.isArray(g.pts?.v) ? g.pts.v : [];
      let b: Box | null = null;
      for (let i = 0; i + 1 < p.length; i += 2) b = union(b, [p[i], p[i + 1], p[i], p[i + 1]]);
      return b;
    }
    default:
      return null;
  }
}

// How far a paint draws outside its geometry.
function paintGrowth(p: PaintIR | undefined, g?: GeomIR): number {
  if (!p) return 0;
  let d = 0;
  // Points draw as dots / lines of the stroke width whatever the style.
  if (p.style === "stroke" || g?.k === "points" || g?.k === "line") {
    const w = Math.max(0, nv(p.strokeWidth, 0)) / 2;
    const join = p.strokeJoin === "miter" ? Math.max(1, p.strokeMiter ?? 4) : 1;
    const cap = p.strokeCap === "square" ? Math.SQRT2 : 1;
    d += w * Math.max(join, cap);
    // A hairline (width 0) still covers about a pixel.
    if (w === 0) d += 0.5;
  }
  if (p.maskFilter?.k === "blur") d += 3 * Math.max(0, nv(p.maskFilter.sigma, 0));
  return d;
}

// ---- the walk --------------------------------------------------------------------------

function filtered(b: Box | null, filters: ImageFilterIR[], scale: number, why: string[]): { box: Box | null; unbounded: boolean } {
  let box = b;
  for (const f of filters) {
    if (!box) break;
    switch (f?.k) {
      case "blur":
        box = [box[0] - 3 * Math.abs(nv(f.sx, 0)) * scale, box[1] - 3 * Math.abs(nv(f.sy, 0)) * scale, box[2] + 3 * Math.abs(nv(f.sx, 0)) * scale, box[3] + 3 * Math.abs(nv(f.sy, 0)) * scale];
        break;
      case "shadow": {
        const dx = nv(f.dx, 0) * scale;
        const dy = nv(f.dy, 0) * scale;
        const r = 3 * Math.abs(nv(f.blur, 0)) * scale;
        const moved: Box = [box[0] + dx - r, box[1] + dy - r, box[2] + dx + r, box[3] + dy + r];
        box = f.shadowOnly || f.inner ? (f.inner ? box : moved) : union(box, moved);
        break;
      }
      case "offset":
        box = [box[0] + nv(f.dx, 0) * scale, box[1] + nv(f.dy, 0) * scale, box[2] + nv(f.dx, 0) * scale, box[3] + nv(f.dy, 0) * scale];
        break;
      case "morphology":
        if (f.op === "dilate") box = grow(box, Math.abs(nv(f.r, 0)) * scale);
        break;
      case "displacement":
        box = grow(box, (Math.abs(nv(f.scale, 0)) / 2) * scale);
        break;
      default:
        why.push(`a ${String(f?.k)} image filter`);
        return { box, unbounded: true };
    }
  }
  return { box, unbounded: false };
}

function walk(n: SkiaNode, m: number[], out: SceneBounds, depth: number): Box | null {
  if (!n || typeof n !== "object" || depth > 64) return null;
  switch (n.k) {
    case "group": {
      const t = transformMatrix(n.transform);
      const inner = t ? mul3(m, t) : m;
      let b: Box | null = null;
      for (const c of Array.isArray(n.children) ? n.children : []) b = union(b, walk(c, inner, out, depth + 1));
      if (b && n.clip && !n.clip.invert) {
        const cb = geomBox(n.clip.geom);
        if (cb) {
          const cm = mapBox(inner, cb);
          b = [Math.max(b[0], cm[0]), Math.max(b[1], cm[1]), Math.min(b[2], cm[2]), Math.min(b[3], cm[3])];
          if (b[0] >= b[2] || b[1] >= b[3]) b = null;
        }
      }
      if (n.layer?.imageFilters?.length) {
        const f = filtered(b, n.layer.imageFilters, maxScale(m), out.why);
        if (f.unbounded) out.unbounded = true;
        b = f.box;
      }
      return b;
    }
    case "fill":
      out.unbounded = true;
      out.why.push(`a fill${n.id ? ` (${n.id})` : ""}`);
      return null;
    case "shape": {
      const g = geomBox(n.geom);
      return g ? mapBox(m, grow(g, paintGrowth(n.paint, n.geom))!) : null;
    }
    case "image": {
      const x = nv(n.x, 0);
      const y = nv(n.y, 0);
      const w = nv(n.w, 0);
      const h = nv(n.h, 0);
      return mapBox(m, [Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)]);
    }
    case "text":
      out.unbounded = true;
      out.why.push(`text${n.id ? ` (${n.id})` : ""} (its glyph extents need the font)`);
      return null;
    case "atlas": {
      const xf = Array.isArray(n.xforms?.v) ? n.xforms.v : [];
      let b: Box | null = null;
      n.sprites.forEach((s, i) => {
        const [a, c, tx, ty] = [xf[i * 4], xf[i * 4 + 1], xf[i * 4 + 2], xf[i * 4 + 3]];
        if (![a, c, tx, ty].every(Number.isFinite)) return;
        // RSXform as a matrix over the sprite's local px.
        const sm = [a, -c, tx, c, a, ty, 0, 0, 1];
        b = union(b, mapBox(mul3(m, sm), [0, 0, s[2], s[3]]));
      });
      if (n.rotate || n.scale) {
        out.unbounded = true;
        out.why.push("an atlas with a sprite spin / zoom");
      }
      return b;
    }
    default:
      return null;
  }
}

export function sceneBounds(node: SkiaNode): SceneBounds {
  const out: SceneBounds = { box: null, unbounded: false, why: [] };
  out.box = finite(walk(node, IDENTITY, out, 0));
  return out;
}
