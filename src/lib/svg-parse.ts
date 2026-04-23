import type {
  SplineAnchor,
  SplineSubpath,
  SvgFileParamValue,
} from "@/engine/types";

// SVG → cubic-bezier parser for SVG Source.
//
// Output convention:
//   - All geometry is converted to cubic-bezier subpaths.
//   - Points are normalized to [0,1]² Y-DOWN, aspect-preserved inside the
//     source viewBox (contain-style fit, centered).
//   - Arcs become cubic approximations (≤90° per segment; standard kappa
//     approximation) — visually indistinguishable from the source.
//   - Quadratic curves become cubics via degree elevation.
//   - Group transforms (translate/scale/rotate/matrix) are flattened into
//     the emitted geometry so downstream nodes never see them.
//
// What this parser DOESN'T handle (yet):
//   - <use>, <symbol>, <defs> references
//   - CSS-based styling (we only read `d`, `transform`, and geometry attrs)
//   - Percentage units, em/rem, or non-user-space length units
//   - clip-path / mask / filter
// The common "Export as SVG" output from Figma and Illustrator is fully
// supported; hand-written SVGs that lean on referenced symbols are not.

// ---- math helpers -------------------------------------------------------

// 2×3 affine (column-major-ish): [ a c e ]
//                                 [ b d f ]
// Point (x,y) → (a*x + c*y + e, b*x + d*y + f).
type Mat23 = [number, number, number, number, number, number];
const IDENTITY: Mat23 = [1, 0, 0, 1, 0, 0];

function mul(a: Mat23, b: Mat23): Mat23 {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m: Mat23, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Parse an SVG `transform` attribute. Supports the commonly-emitted subset:
// translate / scale / rotate / skewX / skewY / matrix. Multiple functions
// concatenate (left-to-right = outer-to-inner in SVG terms).
function parseTransform(s: string | null): Mat23 {
  if (!s) return IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m: Mat23 = IDENTITY;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s))) {
    const name = match[1];
    const args = match[2]
      .split(/[\s,]+/)
      .filter((t) => t.length)
      .map(Number);
    let t: Mat23 = IDENTITY;
    if (name === "matrix" && args.length === 6) {
      t = [args[0], args[1], args[2], args[3], args[4], args[5]];
    } else if (name === "translate") {
      t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    } else if (name === "scale") {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      t = [sx, 0, 0, sy, 0, 0];
    } else if (name === "rotate") {
      const rad = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      if (args.length >= 3) {
        // rotate(a, cx, cy) == translate(cx,cy) rotate(a) translate(-cx,-cy)
        const cx = args[1];
        const cy = args[2];
        t = mul(
          mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]),
          [1, 0, 0, 1, -cx, -cy]
        );
      } else {
        t = [cos, sin, -sin, cos, 0, 0];
      }
    } else if (name === "skewX") {
      t = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
    } else if (name === "skewY") {
      t = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = mul(m, t);
  }
  return m;
}

// ---- path `d` tokenizer -------------------------------------------------

// Returns [command, args] pairs. Each command keeps its original case (upper =
// absolute, lower = relative).
function tokenizePath(d: string): Array<[string, number[]]> {
  const tokens: Array<[string, number[]]> = [];
  const numRe =
    /([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?)/g;
  const cmdRe = /([MmLlHhVvCcSsQqTtAaZz])/;
  // Split around commands, keeping them.
  const parts = d.split(cmdRe).filter((p) => p.trim().length);
  let i = 0;
  while (i < parts.length) {
    const cmd = parts[i];
    if (!/^[MmLlHhVvCcSsQqTtAaZz]$/.test(cmd)) {
      i++;
      continue;
    }
    const argStr = parts[i + 1] ?? "";
    const nums: number[] = [];
    let m: RegExpExecArray | null;
    numRe.lastIndex = 0;
    while ((m = numRe.exec(argStr))) nums.push(Number(m[1]));
    tokens.push([cmd, nums]);
    i += 2;
  }
  return tokens;
}

// ---- primitive conversions ---------------------------------------------

// Degree-elevation: quadratic (P0, P1, P2) → cubic (P0, C1, C2, P2).
function quadToCubic(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number]
): { c1: [number, number]; c2: [number, number] } {
  return {
    c1: [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])],
    c2: [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])],
  };
}

// SVG arc (endpoint parameterization) → cubic bezier segments. Splits the
// swept angle into ≤90° chunks and uses the standard 4-point approximation
// per chunk. The endpoint→center conversion follows the W3C appendix:
// https://www.w3.org/TR/SVG11/implnote.html#ArcImplementationNotes
function arcToCubics(
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  xAxisRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x1: number,
  y1: number
): Array<{ c1: [number, number]; c2: [number, number]; end: [number, number] }> {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    // Degenerate → straight line. Emit a single cubic with CPs at the
    // endpoints so the downstream treats it as a line (collapsed handles).
    return [{ c1: [x0, y0], c2: [x1, y1], end: [x1, y1] }];
  }
  const rad = (xAxisRotDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const x1p = cosR * dx + sinR * dy;
  const y1p = -sinR * dx + cosR * dy;

  // Radius adjustment per W3C: ensure radii are large enough for the arc.
  let rx2 = rx * rx;
  let ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const lambda = x1p2 / rx2 + y1p2 / ry2;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
    rx2 = rx * rx;
    ry2 = ry * ry;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const sq = Math.max(
    0,
    (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2)
  );
  const coef = sign * Math.sqrt(sq);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  const cx = cosR * cxp - sinR * cyp + (x0 + x1) / 2;
  const cy = sinR * cxp + cosR * cyp + (y0 + y1) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    if (d === 0) return 0;
    let c = (ux * vx + uy * vy) / d;
    c = Math.max(-1, Math.min(1, c));
    const s = ux * vy - uy * vx >= 0 ? 1 : -1;
    return s * Math.acos(c);
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  else if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  // Split into ≤90° segments.
  const nSegs = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const dTheta = deltaTheta / nSegs;
  const t = (4 / 3) * Math.tan(dTheta / 4); // kappa-like scaling
  const out: Array<{
    c1: [number, number];
    c2: [number, number];
    end: [number, number];
  }> = [];

  const pointOnArc = (th: number): [number, number] => {
    const xr = rx * Math.cos(th);
    const yr = ry * Math.sin(th);
    return [cosR * xr - sinR * yr + cx, sinR * xr + cosR * yr + cy];
  };

  for (let i = 0; i < nSegs; i++) {
    const a0 = theta1 + i * dTheta;
    const a1 = a0 + dTheta;
    const p0 = pointOnArc(a0);
    const p3 = pointOnArc(a1);
    // Tangent directions at the segment endpoints in original-circle space,
    // then rotated into ellipse / x-axis-rotation space.
    const t0x = -rx * Math.sin(a0);
    const t0y = ry * Math.cos(a0);
    const t1x = -rx * Math.sin(a1);
    const t1y = ry * Math.cos(a1);
    const r0x = cosR * t0x - sinR * t0y;
    const r0y = sinR * t0x + cosR * t0y;
    const r1x = cosR * t1x - sinR * t1y;
    const r1y = sinR * t1x + cosR * t1y;
    out.push({
      c1: [p0[0] + t * r0x, p0[1] + t * r0y],
      c2: [p3[0] - t * r1x, p3[1] - t * r1y],
      end: p3,
    });
  }
  return out;
}

// ---- path `d` → subpaths ------------------------------------------------

function parsePathD(d: string, transform: Mat23): SplineSubpath[] {
  const tokens = tokenizePath(d);
  const subpaths: SplineSubpath[] = [];
  // Explicit union annotation so TS's flow narrowing doesn't collapse to
  // `null` after closures mutate `current`.
  type MaybeSub = SplineSubpath | null;
  let current: MaybeSub = null;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // Previous-control memory for smooth-curve reflection.
  let lastCubicC2: [number, number] | null = null;
  let lastQuadC1: [number, number] | null = null;

  const pushAnchor = (a: SplineAnchor) => {
    if (!current) {
      current = { anchors: [], closed: false };
      subpaths.push(current);
    }
    current.anchors.push(a);
  };
  // Attach an out-handle to the last-pushed anchor (the segment's start).
  const setLastOutHandle = (ox: number, oy: number) => {
    if (!current || current.anchors.length === 0) return;
    const last = current.anchors[current.anchors.length - 1];
    const [ax, ay] = apply(transform, cx, cy);
    const [hx, hy] = apply(transform, ox, oy);
    last.outHandle = [hx - ax, hy - ay];
  };

  const lineTo = (nx: number, ny: number) => {
    // Emit a cubic whose handles collapse to the endpoints — renders as a
    // straight line but keeps the data uniform (every segment is a cubic).
    const [ax, ay] = apply(transform, nx, ny);
    pushAnchor({ pos: [ax, ay] });
    cx = nx;
    cy = ny;
    lastCubicC2 = null;
    lastQuadC1 = null;
  };

  const moveTo = (nx: number, ny: number) => {
    current = { anchors: [], closed: false };
    subpaths.push(current);
    const [ax, ay] = apply(transform, nx, ny);
    current.anchors.push({ pos: [ax, ay] });
    cx = nx;
    cy = ny;
    startX = nx;
    startY = ny;
    lastCubicC2 = null;
    lastQuadC1 = null;
  };

  const cubicTo = (
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    nx: number,
    ny: number
  ) => {
    setLastOutHandle(c1x, c1y);
    const [ex, ey] = apply(transform, nx, ny);
    const [hx, hy] = apply(transform, c2x, c2y);
    pushAnchor({
      pos: [ex, ey],
      inHandle: [hx - ex, hy - ey],
    });
    cx = nx;
    cy = ny;
    lastCubicC2 = [c2x, c2y];
    lastQuadC1 = null;
  };

  for (const [cmd, args] of tokens) {
    const abs = cmd === cmd.toUpperCase();
    const up = cmd.toUpperCase();
    // Argument groups per command — many SVG commands accept multiple
    // coordinate pairs back-to-back, with the second+ treated as implicit
    // repeats (M after the first implicit pair is L, for example).
    switch (up) {
      case "M": {
        for (let i = 0; i < args.length; i += 2) {
          const x = abs ? args[i] : cx + args[i];
          const y = abs ? args[i + 1] : cy + args[i + 1];
          if (i === 0) moveTo(x, y);
          else lineTo(x, y);
        }
        break;
      }
      case "L": {
        for (let i = 0; i < args.length; i += 2) {
          const x = abs ? args[i] : cx + args[i];
          const y = abs ? args[i + 1] : cy + args[i + 1];
          lineTo(x, y);
        }
        break;
      }
      case "H": {
        for (let i = 0; i < args.length; i++) {
          const x = abs ? args[i] : cx + args[i];
          lineTo(x, cy);
        }
        break;
      }
      case "V": {
        for (let i = 0; i < args.length; i++) {
          const y = abs ? args[i] : cy + args[i];
          lineTo(cx, y);
        }
        break;
      }
      case "C": {
        for (let i = 0; i < args.length; i += 6) {
          const c1x = abs ? args[i] : cx + args[i];
          const c1y = abs ? args[i + 1] : cy + args[i + 1];
          const c2x = abs ? args[i + 2] : cx + args[i + 2];
          const c2y = abs ? args[i + 3] : cy + args[i + 3];
          const nx = abs ? args[i + 4] : cx + args[i + 4];
          const ny = abs ? args[i + 5] : cy + args[i + 5];
          cubicTo(c1x, c1y, c2x, c2y, nx, ny);
        }
        break;
      }
      case "S": {
        for (let i = 0; i < args.length; i += 4) {
          const c1x = lastCubicC2 ? 2 * cx - lastCubicC2[0] : cx;
          const c1y = lastCubicC2 ? 2 * cy - lastCubicC2[1] : cy;
          const c2x = abs ? args[i] : cx + args[i];
          const c2y = abs ? args[i + 1] : cy + args[i + 1];
          const nx = abs ? args[i + 2] : cx + args[i + 2];
          const ny = abs ? args[i + 3] : cy + args[i + 3];
          cubicTo(c1x, c1y, c2x, c2y, nx, ny);
        }
        break;
      }
      case "Q": {
        for (let i = 0; i < args.length; i += 4) {
          const qx = abs ? args[i] : cx + args[i];
          const qy = abs ? args[i + 1] : cy + args[i + 1];
          const nx = abs ? args[i + 2] : cx + args[i + 2];
          const ny = abs ? args[i + 3] : cy + args[i + 3];
          const { c1, c2 } = quadToCubic([cx, cy], [qx, qy], [nx, ny]);
          cubicTo(c1[0], c1[1], c2[0], c2[1], nx, ny);
          lastQuadC1 = [qx, qy];
          lastCubicC2 = null;
        }
        break;
      }
      case "T": {
        for (let i = 0; i < args.length; i += 2) {
          const qx: number = lastQuadC1 ? 2 * cx - lastQuadC1[0] : cx;
          const qy: number = lastQuadC1 ? 2 * cy - lastQuadC1[1] : cy;
          const nx = abs ? args[i] : cx + args[i];
          const ny = abs ? args[i + 1] : cy + args[i + 1];
          const { c1, c2 } = quadToCubic([cx, cy], [qx, qy], [nx, ny]);
          cubicTo(c1[0], c1[1], c2[0], c2[1], nx, ny);
          lastQuadC1 = [qx, qy];
          lastCubicC2 = null;
        }
        break;
      }
      case "A": {
        for (let i = 0; i < args.length; i += 7) {
          const rx = args[i];
          const ry = args[i + 1];
          const rot = args[i + 2];
          const large = !!args[i + 3];
          const sweep = !!args[i + 4];
          const nx = abs ? args[i + 5] : cx + args[i + 5];
          const ny = abs ? args[i + 6] : cy + args[i + 6];
          const segs = arcToCubics(cx, cy, rx, ry, rot, large, sweep, nx, ny);
          for (const seg of segs) {
            cubicTo(seg.c1[0], seg.c1[1], seg.c2[0], seg.c2[1], seg.end[0], seg.end[1]);
          }
        }
        break;
      }
      case "Z": {
        // Last pushed subpath is always the open one; close it if non-empty.
        const sub = subpaths[subpaths.length - 1];
        if (sub && sub.anchors.length > 0) {
          sub.closed = true;
          cx = startX;
          cy = startY;
        }
        lastCubicC2 = null;
        lastQuadC1 = null;
        break;
      }
    }
  }
  return subpaths.filter((s) => s.anchors.length > 0);
}

// ---- primitive element → subpaths --------------------------------------

function rectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
  transform: Mat23
): SplineSubpath[] {
  // Clamp corner radii the SVG way (can't exceed half of the shorter side).
  const hrx = Math.min(Math.abs(rx), Math.abs(w / 2));
  const hry = Math.min(Math.abs(ry), Math.abs(h / 2));
  // Build a path string and reuse the path parser — saves re-implementing
  // the rounded-rect math for a primitive nobody writes by hand much anyway.
  let d: string;
  if (hrx === 0 && hry === 0) {
    d = `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
  } else {
    d =
      `M${x + hrx} ${y} ` +
      `H${x + w - hrx} ` +
      `A${hrx} ${hry} 0 0 1 ${x + w} ${y + hry} ` +
      `V${y + h - hry} ` +
      `A${hrx} ${hry} 0 0 1 ${x + w - hrx} ${y + h} ` +
      `H${x + hrx} ` +
      `A${hrx} ${hry} 0 0 1 ${x} ${y + h - hry} ` +
      `V${y + hry} ` +
      `A${hrx} ${hry} 0 0 1 ${x + hrx} ${y} Z`;
  }
  return parsePathD(d, transform);
}

function ellipseSubpath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  transform: Mat23
): SplineSubpath[] {
  // Two 180° arcs close a full ellipse.
  const d =
    `M${cx - rx} ${cy} ` +
    `A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
    `A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  return parsePathD(d, transform);
}

// ---- tree traversal ----------------------------------------------------

function parsePoints(s: string): number[] {
  return s
    .split(/[\s,]+/)
    .filter((t) => t.length)
    .map(Number);
}

function traverse(
  el: Element,
  transform: Mat23,
  out: SplineSubpath[]
): void {
  const own = parseTransform(el.getAttribute("transform"));
  const m = mul(transform, own);
  const tag = el.tagName.toLowerCase();

  if (tag === "path") {
    const d = el.getAttribute("d") ?? "";
    if (d.trim()) out.push(...parsePathD(d, m));
  } else if (tag === "rect") {
    const x = Number(el.getAttribute("x") ?? 0);
    const y = Number(el.getAttribute("y") ?? 0);
    const w = Number(el.getAttribute("width") ?? 0);
    const h = Number(el.getAttribute("height") ?? 0);
    const rx = Number(el.getAttribute("rx") ?? el.getAttribute("ry") ?? 0);
    const ry = Number(el.getAttribute("ry") ?? el.getAttribute("rx") ?? 0);
    if (w > 0 && h > 0) out.push(...rectSubpath(x, y, w, h, rx, ry, m));
  } else if (tag === "circle") {
    const cx = Number(el.getAttribute("cx") ?? 0);
    const cy = Number(el.getAttribute("cy") ?? 0);
    const r = Number(el.getAttribute("r") ?? 0);
    if (r > 0) out.push(...ellipseSubpath(cx, cy, r, r, m));
  } else if (tag === "ellipse") {
    const cx = Number(el.getAttribute("cx") ?? 0);
    const cy = Number(el.getAttribute("cy") ?? 0);
    const rx = Number(el.getAttribute("rx") ?? 0);
    const ry = Number(el.getAttribute("ry") ?? 0);
    if (rx > 0 && ry > 0) out.push(...ellipseSubpath(cx, cy, rx, ry, m));
  } else if (tag === "line") {
    const x1 = Number(el.getAttribute("x1") ?? 0);
    const y1 = Number(el.getAttribute("y1") ?? 0);
    const x2 = Number(el.getAttribute("x2") ?? 0);
    const y2 = Number(el.getAttribute("y2") ?? 0);
    out.push(...parsePathD(`M${x1} ${y1} L${x2} ${y2}`, m));
  } else if (tag === "polyline" || tag === "polygon") {
    const pts = parsePoints(el.getAttribute("points") ?? "");
    if (pts.length >= 4) {
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) d += ` L${pts[i]} ${pts[i + 1]}`;
      if (tag === "polygon") d += " Z";
      out.push(...parsePathD(d, m));
    }
  }

  // Recurse through children — <g>, <svg>, <defs>, etc. contribute their
  // children's geometry too (defs is skipped in practice because its
  // children aren't normally rendered, but we tolerate it).
  for (let i = 0; i < el.children.length; i++) {
    traverse(el.children[i], m, out);
  }
}

// ---- entry point -------------------------------------------------------

export function parseSvg(text: string, filename?: string): SvgFileParamValue {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  // DOMParser reports XML errors via a <parsererror> child — surface as a
  // thrown error the node UI can show.
  const errNode = doc.getElementsByTagName("parsererror")[0];
  if (errNode) throw new Error("Invalid SVG: " + errNode.textContent);
  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase() !== "svg") {
    throw new Error("File does not contain an <svg> root element");
  }

  // Figure out the source bounds. `viewBox` is authoritative when present;
  // otherwise fall back to width/height, which may be in CSS units — we
  // accept bare numbers and strip a trailing `px`.
  const vb = svg.getAttribute("viewBox");
  let vx = 0;
  let vy = 0;
  let vw = 0;
  let vh = 0;
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4) {
      vx = p[0];
      vy = p[1];
      vw = p[2];
      vh = p[3];
    }
  }
  if (vw <= 0 || vh <= 0) {
    const w = parseFloat(svg.getAttribute("width") ?? "0");
    const h = parseFloat(svg.getAttribute("height") ?? "0");
    vw = w > 0 ? w : 100;
    vh = h > 0 ? h : 100;
  }

  // Fit viewBox into [0,1]² centered, preserving aspect (contain-style).
  const scale = Math.min(1 / vw, 1 / vh);
  const tx = (1 - vw * scale) / 2 - vx * scale;
  const ty = (1 - vh * scale) / 2 - vy * scale;
  const fitMatrix: Mat23 = [scale, 0, 0, scale, tx, ty];

  const subpaths: SplineSubpath[] = [];
  traverse(svg, fitMatrix, subpaths);

  return {
    subpaths,
    filename,
    aspect: vw / vh,
  };
}
