import type {
  ColliderDescriptor,
  ForceDescriptor,
  ImageValue,
  RenderContext,
  SocketValue,
  SplineAnchor,
  SplineSubpath,
} from "./types";
import { snoise } from "./noise";

// Shared CPU simulation kernel for the spline physics nodes (Rope
// Simulator, Rigid Body Simulator). Extracted verbatim from
// rope-simulator.ts (milestone 0 of 072026_rigid-body-simulator.md) so
// the sims can't drift: a force or collider node must feel IDENTICAL
// against a rope and a rigid body, and both must mirror the Particle
// Simulator's GLSL math exactly.
//
// Everything here follows the two-space convention documented in the
// rope sim: solvers run in canvas-pixel Y-down space; force/collider/
// bounds response runs in normalized [0,1]² UV space (the shared
// descriptors are specified in UV, matching the particle shader).

// ---- seeding helpers -------------------------------------------------

export function scaleSubpath(
  s: SplineSubpath,
  kx: number,
  ky: number
): SplineSubpath {
  return {
    ...s,
    anchors: s.anchors.map((a) => {
      const out: SplineAnchor = {
        pos: [a.pos[0] * kx, a.pos[1] * ky],
      };
      if (a.inHandle) out.inHandle = [a.inHandle[0] * kx, a.inHandle[1] * ky];
      if (a.outHandle)
        out.outHandle = [a.outHandle[0] * kx, a.outHandle[1] * ky];
      return out;
    }),
  };
}

// Redistribute a dense polyline to `count` EXACTLY evenly spaced points.
// resampleSubpath alone isn't enough: it maps arc length to bezier t
// linearly per segment, and on a handle-less (polyline) segment the
// degenerate cubic travels as smoothstep(t) — a straight 2-anchor line
// would seed particles ~1.5× sparser mid-span than at its ends. Dense-
// sampling first, then walking true polyline distances, is exact.
export function evenPolylinePoints(
  dense: Array<[number, number]>,
  closed: boolean,
  count: number
): number[] {
  const segs = closed ? dense.length : dense.length - 1;
  const cum = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[segs];
  const div = closed ? count : count - 1;
  const out: number[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / div) * total;
    while (seg < segs - 1 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = dense[seg];
    const b = dense[(seg + 1) % dense.length];
    out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  }
  return out;
}

// Position at arc-length fraction t along a dense polyline — the
// follow_input sampler (same dense-polyline trick as seeding, so a
// pin's fraction lands exactly where the equivalent particle seeded).
export function samplePolylineAt(
  dense: Array<[number, number]>,
  closed: boolean,
  t: number
): [number, number] {
  const segs = closed ? dense.length : dense.length - 1;
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segs; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (target <= len || i === segs - 1) {
      const f = len > 0 ? target / len : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    target -= len;
  }
  return dense[dense.length - 1];
}

// ---- force application (CPU port of the Particle Simulator GLSL) ----

// 2D curl noise — exact port of the shader's curl2 (orthogonal gradient
// of a simplex potential, advected diagonally through time).
function curlX(px: number, py: number, t: number): number {
  const eps = 0.01;
  return (
    (snoise(px + t, py + eps - t) - snoise(px + t, py - eps - t)) / (2 * eps)
  );
}
function curlY(px: number, py: number, t: number): number {
  const eps = 0.01;
  return (
    -(snoise(px + eps + t, py - t) - snoise(px - eps + t, py - t)) / (2 * eps)
  );
}

// Mutates vel[0..1] (UV/sec). Positions in UV, dt in seconds — same
// units as the shader's applyForce.
export function applyForceCpu(
  f: ForceDescriptor,
  u: number,
  v: number,
  vel: Float32Array,
  dt: number,
  time: number
): void {
  switch (f.kind) {
    case "gravity":
      vel[0] += f.gx * dt;
      vel[1] += f.gy * dt;
      break;
    case "drag": {
      const s = Math.max(0, 1 - f.coeff * dt);
      vel[0] *= s;
      vel[1] *= s;
      break;
    }
    case "point": {
      const dx = u - f.px;
      const dy = v - f.py;
      const r = Math.hypot(dx, dy);
      if (r < f.radius && r > 1e-5) {
        const t = Math.max(0, Math.min(1, 1 - r / f.radius));
        const fo = f.strength * Math.pow(t, f.falloff);
        vel[0] += (dx / r) * fo * f.sign * dt;
        vel[1] += (dy / r) * fo * f.sign * dt;
      }
      break;
    }
    case "vortex": {
      const dx = u - f.px;
      const dy = v - f.py;
      const r = Math.hypot(dx, dy);
      if (r < f.radius && r > 1e-5) {
        const t = Math.max(0, Math.min(1, 1 - r / f.radius));
        const fo = f.strength * Math.pow(t, f.falloff);
        vel[0] += (-dy / r) * fo * dt;
        vel[1] += (dx / r) * fo * dt;
      }
      break;
    }
    case "wind": {
      const l = Math.hypot(f.dx, f.dy);
      if (l > 1e-5) {
        vel[0] += (f.dx / l) * f.strength * dt;
        vel[1] += (f.dy / l) * f.strength * dt;
      }
      break;
    }
    case "turbulence": {
      const t = time * f.speed;
      vel[0] += curlX(u * f.scale, v * f.scale, t) * f.strength * dt;
      vel[1] += curlY(u * f.scale, v * f.scale, t) * f.strength * dt;
      break;
    }
  }
}

// ---- collider contact fields ----------------------------------------

// A mask collider's CPU contact field: per-texel penetration depth
// (0 = outside the solid), built once per mask change by a two-pass
// chamfer distance transform over the thresholded alpha. Unlike the
// particle shader's alpha-gradient nudge (which stalls deep inside a
// solid, where the gradient is zero), the distance field gives every
// penetrating particle an exact depth + normal, so expulsion is a
// single projection — a rope draped INTO a shape resolves onto its
// surface in one substep.
export interface MaskBuffer {
  dist: Float32Array; // texel units; >0 = inside the solid
  w: number;
  h: number;
}

export function buildMaskField(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number
): MaskBuffer {
  const INF = 1e9;
  const t255 = threshold * 255;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dist[i] = data[i * 4 + 3] >= t255 ? INF : 0;
  }
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 1);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + D);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + D);
      }
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 1);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + D);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + D);
      }
      dist[i] = d;
    }
  }
  return { dist, w, h };
}

// Bilinear penetration-depth sample at texel coords (Y-down; the
// readback rows are top-down ImageData order, matching point/spline UV
// with no flip — unlike the shader, which samples the Y-up texture).
export function sampleDist(buf: MaskBuffer, x: number, y: number): number {
  const cx = Math.max(0, Math.min(buf.w - 1.001, x - 0.5));
  const cy = Math.max(0, Math.min(buf.h - 1.001, y - 0.5));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = y0 * buf.w + x0;
  const top = buf.dist[i00] * (1 - fx) + buf.dist[i00 + 1] * fx;
  const bot =
    buf.dist[i00 + buf.w] * (1 - fx) + buf.dist[i00 + buf.w + 1] * fx;
  return top * (1 - fy) + bot * fy;
}

// ---- collider response (CPU port, UV space) --------------------------

// Colliders prepacked once per eval: circle/line pass their descriptor
// fields through; image_mask carries its CPU alpha readback.
export type PackedCollider =
  | {
      kind: "circle";
      cx: number;
      cy: number;
      radius: number;
      inside: boolean;
      restitution: number;
    }
  | { kind: "line"; nx: number; ny: number; d: number; restitution: number }
  | { kind: "mask"; restitution: number; buf: MaskBuffer };

// Per-collider-slot cache entry for an image_mask collider's contact
// field, reused while the mask's ImageValue identity (value-object
// identity = "upstream recomputed" — the devguide caching rule) and
// threshold are unchanged.
export interface MaskColliderCacheEntry {
  src: ImageValue;
  threshold: number;
  buf: MaskBuffer;
}

// Pack raw collider descriptors for the CPU solver; image_mask reads
// its alpha to CPU through `maskCache` (one entry per slot, identity-
// reused). Trims stale cache slots. A kill-mode mask acts as a plain
// solid (a connected chain/body can't lose one particle).
export function packColliders(
  ctx: RenderContext,
  raw: ColliderDescriptor[],
  maskCache: Array<MaskColliderCacheEntry | undefined>
): PackedCollider[] {
  const colliders: PackedCollider[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c.kind !== "image_mask") {
      colliders.push(c);
      continue;
    }
    let entry = maskCache[i];
    if (!entry || entry.src !== c.mask || entry.threshold !== c.threshold) {
      // Scaled readback: a 512-cap contact field resolves ~1.5px
      // features at canvas res — full-res masks buy nothing but
      // readback + transform cost. Sampling is UV-normalized.
      const scale = Math.min(1, 512 / Math.max(c.mask.width, c.mask.height, 1));
      const rw = Math.max(1, Math.round(c.mask.width * scale));
      const rh = Math.max(1, Math.round(c.mask.height * scale));
      const data = ctx.readImagePixels(c.mask, rw, rh);
      if (!data) continue;
      entry = {
        src: c.mask,
        threshold: c.threshold,
        buf: buildMaskField(data, rw, rh, c.threshold),
      };
      maskCache[i] = entry;
    }
    colliders.push({
      kind: "mask",
      restitution: c.restitution,
      buf: entry.buf,
    });
  }
  maskCache.length = raw.length;
  return colliders;
}

// Shared contact response: positional correction already applied by the
// caller; here velocity splits into normal + tangent. Normal reflects
// with (collider restitution × material bounciness) when approaching;
// tangent is scaled by (1 − friction) on EVERY contact, so resting
// bodies stop sliding (resting drag, not just impact response).
export function contactResponse(
  p: Float32Array,
  nx: number,
  ny: number,
  restitution: number,
  friction: number,
  bounciness: number
): void {
  const vn = p[2] * nx + p[3] * ny;
  const vtx = p[2] - vn * nx;
  const vty = p[3] - vn * ny;
  const kt = 1 - friction;
  const vnAfter = vn < 0 ? -vn * restitution * bounciness : vn;
  p[2] = nx * vnAfter + vtx * kt;
  p[3] = ny * vnAfter + vty * kt;
}

// Mutates p = [u, v, velU, velV]. Returns the index of the last
// collider contacted this call (−1 = none) — sticky welds anchor to it.
export function resolveCollidersCpu(
  colliders: PackedCollider[],
  p: Float32Array,
  friction: number,
  bounciness: number
): number {
  let contact = -1;
  for (let ci = 0; ci < colliders.length; ci++) {
    const c = colliders[ci];
    if (c.kind === "circle") {
      const dx = p[0] - c.cx;
      const dy = p[1] - c.cy;
      const r = Math.hypot(dx, dy);
      const penetrating = c.inside ? r > c.radius : r < c.radius;
      if (penetrating && r > 1e-5) {
        const sgn = c.inside ? -1 : 1;
        const nx = (dx / r) * sgn;
        const ny = (dy / r) * sgn;
        // Both cases project back to the surface along the center ray.
        p[0] = c.cx + (dx / r) * c.radius;
        p[1] = c.cy + (dy / r) * c.radius;
        contactResponse(p, nx, ny, c.restitution, friction, bounciness);
        contact = ci;
      }
    } else if (c.kind === "line") {
      const dist = c.nx * p[0] + c.ny * p[1] - c.d;
      if (dist < 0) {
        p[0] -= dist * c.nx;
        p[1] -= dist * c.ny;
        contactResponse(p, c.nx, c.ny, c.restitution, friction, bounciness);
        contact = ci;
      }
    } else {
      // image mask: contact in buffer-texel space (the readback keeps
      // the mask's aspect, so texels are ~square in canvas px and the
      // response is as isotropic as the solver itself).
      const bw = c.buf.w;
      const bh = c.buf.h;
      const x = p[0] * bw;
      const y = p[1] * bh;
      const d = sampleDist(c.buf, x, y);
      if (d > 0) {
        // Normal = downhill gradient of penetration depth; a flat-top
        // plateau (deep inside a wide solid) falls back to reversed
        // velocity, matching the shader's convention.
        const gx = sampleDist(c.buf, x + 1, y) - sampleDist(c.buf, x - 1, y);
        const gy = sampleDist(c.buf, x, y + 1) - sampleDist(c.buf, x, y - 1);
        const gl = Math.hypot(gx, gy);
        let nx: number;
        let ny: number;
        if (gl > 1e-5) {
          nx = -gx / gl;
          ny = -gy / gl;
        } else {
          const vl = Math.hypot(p[2] * bw, p[3] * bh);
          nx = vl > 1e-5 ? (-p[2] * bw) / vl : 0;
          ny = vl > 1e-5 ? (-p[3] * bh) / vl : -1;
        }
        // Project fully out of the solid (+half-texel skin).
        p[0] = (x + nx * (d + 0.5)) / bw;
        p[1] = (y + ny * (d + 0.5)) / bh;
        // Velocity response in texel space so the normal is orthonormal.
        p[2] *= bw;
        p[3] *= bh;
        contactResponse(p, nx, ny, c.restitution, friction, bounciness);
        p[2] /= bw;
        p[3] /= bh;
        contact = ci;
      }
    }
  }
  return contact;
}

export function resolveBoundsCpu(
  mode: string,
  restitution: number,
  p: Float32Array,
  friction: number,
  bounciness: number
): void {
  if (mode === "off") return;
  const reflect = mode === "bounce";
  const rest = restitution * bounciness;
  const kt = 1 - friction;
  if (p[0] < 0) {
    p[0] = 0;
    if (reflect && p[2] < 0) p[2] = -p[2] * rest;
    p[3] *= kt;
  } else if (p[0] > 1) {
    p[0] = 1;
    if (reflect && p[2] > 0) p[2] = -p[2] * rest;
    p[3] *= kt;
  }
  if (p[1] < 0) {
    p[1] = 0;
    if (reflect && p[3] < 0) p[3] = -p[3] * rest;
    p[2] *= kt;
  } else if (p[1] > 1) {
    p[1] = 1;
    if (reflect && p[3] > 0) p[3] = -p[3] * rest;
    p[2] *= kt;
  }
}

// ---- property maps ---------------------------------------------------

// A property map's CPU sample buffer: single-channel float, R channel
// of the coerced mask readback (rows top-down, Y-down UV — no flip).
export interface MapBuffer {
  data: Float32Array;
  w: number;
  h: number;
}

export interface MapCacheEntry {
  src: SocketValue;
  buf: MapBuffer;
}

export function sampleMap(buf: MapBuffer, u: number, v: number): number {
  const cx = Math.max(0, Math.min(buf.w - 1.001, u * buf.w - 0.5));
  const cy = Math.max(0, Math.min(buf.h - 1.001, v * buf.h - 0.5));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = y0 * buf.w + x0;
  const top = buf.data[i00] * (1 - fx) + buf.data[i00 + 1] * fx;
  const bot =
    buf.data[i00 + buf.w] * (1 - fx) + buf.data[i00 + buf.w + 1] * fx;
  return top * (1 - fy) + bot * fy;
}

// Read a map input (mask-typed socket — images/splines coerce in
// upstream, so the value here is always a texture-backed mask; its R
// channel is the map) into a single-channel float buffer, reused while
// the value's object identity is unchanged.
export function readMapBuffer(
  ctx: RenderContext,
  cache: Record<string, MapCacheEntry | undefined>,
  name: string,
  val: SocketValue | undefined
): MapBuffer | null {
  if (!val || (val.kind !== "mask" && val.kind !== "image")) return null;
  const hit = cache[name];
  if (hit && hit.src === val) return hit.buf;
  // Property maps drive material feel, not contact geometry — 256 is
  // plenty and keeps a live (per-frame) readback cheap.
  const scale = Math.min(1, 256 / Math.max(val.width, val.height, 1));
  const rw = Math.max(1, Math.round(val.width * scale));
  const rh = Math.max(1, Math.round(val.height * scale));
  const data = ctx.readImagePixels(
    {
      kind: "image",
      texture: val.texture,
      width: val.width,
      height: val.height,
    },
    rw,
    rh
  );
  if (!data) return null;
  const chan = new Float32Array(rw * rh);
  for (let i = 0; i < rw * rh; i++) chan[i] = data[i * 4] / 255;
  const buf: MapBuffer = { data: chan, w: rw, h: rh };
  cache[name] = { src: val, buf };
  return buf;
}

// Fill a per-particle attribute from map(position). Baked maps call
// this once at seed (positions = rest positions); live maps call it
// every eval (positions = current — the map becomes a world field).
export function fillAttrFromMap(
  buf: MapBuffer,
  pos: Float32Array,
  count: number,
  out: Float32Array,
  W: number,
  H: number
): void {
  for (let i = 0; i < count; i++) {
    out[i] = sampleMap(buf, pos[i * 2] / W, pos[i * 2 + 1] / H);
  }
}

// ---- spatial hash ----------------------------------------------------

// Uniform grid over canvas px space, counting sort into flat reusable
// arrays. After build, `counts[c]` is the END offset of cell c's run in
// `entries` (== start of cell c+1); read a cell as
// [cellStart(hash, c), counts[c]). Rebuild every substep; arrays are
// reallocated only when the grid dimensions or particle count grow.
export interface SpatialHash {
  counts: Int32Array; // length gw*gh + 1 (the +1 makes scatter cheap)
  entries: Int32Array;
  gw: number;
  gh: number;
  cell: number;
}

export function buildSpatialHash(
  pos: Float32Array,
  count: number,
  cellSize: number,
  W: number,
  H: number,
  reuse?: SpatialHash
): SpatialHash {
  const cell = Math.max(1, cellSize);
  const gw = Math.max(1, Math.ceil(W / cell));
  const gh = Math.max(1, Math.ceil(H / cell));
  let hash = reuse;
  if (!hash || hash.gw !== gw || hash.gh !== gh) {
    hash = {
      counts: new Int32Array(gw * gh + 1),
      entries: new Int32Array(Math.max(count, 1)),
      gw,
      gh,
      cell,
    };
  } else {
    hash.cell = cell;
  }
  if (hash.entries.length < count) hash.entries = new Int32Array(count);
  const { counts, entries } = hash;
  counts.fill(0);
  const cellOf = (i: number): number => {
    const cx = Math.max(0, Math.min(gw - 1, Math.floor(pos[i * 2] / cell)));
    const cy = Math.max(
      0,
      Math.min(gh - 1, Math.floor(pos[i * 2 + 1] / cell))
    );
    return cy * gw + cx;
  };
  for (let i = 0; i < count; i++) counts[cellOf(i) + 1]++;
  for (let c = 0; c < gw * gh; c++) counts[c + 1] += counts[c];
  // counts[c] now holds the start offset for cell c; scatter walks it
  // forward, leaving counts[c] = END of cell c (hence the +1 layout).
  for (let i = 0; i < count; i++) {
    entries[counts[cellOf(i)]++] = i;
  }
  return hash;
}

export function cellStart(hash: SpatialHash, c: number): number {
  return c === 0 ? 0 : hash.counts[c - 1];
}
