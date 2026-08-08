// Vector kernel facade — kurbo compiled to WASM (rust/toolbox-vector-kernel).
// Spec: specdocs/archive/attractor-vector-kernel-spec.md.
//
// Owns two things:
//  1. Kernel lifecycle: lazy init from public/wasm/v1 (browser fetch) or
//     bytes (Node check scripts). Callers gate on kernelReady() and kick
//     ensureVectorKernel() — the engine stays synchronous.
//  2. The SplineValue ↔ PathData adapter (§5.4): relative-handle normalized
//     Y-down anchors ↔ absolute-control-point verbs/coords in CANVAS PX
//     (§7.1 — normalized space is anisotropic, so metric ops run in px).
//
// Wire format (mirror of rust/toolbox-vector-kernel/src/wire.rs):
// verbs 0 MoveTo / 1 LineTo / 2 QuadTo / 3 CurveTo / 4 ClosePath;
// coords packed x,y f64 pairs consumed in verb order.

import initKernel, {
  initSync,
  simplify as wasmSimplify,
  kernel_version,
} from "@/wasm/pkg/kernel";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";

export const KERNEL_WASM_URL = "/wasm/v1/kernel_bg.wasm";

let ready = false;
let loading: Promise<void> | null = null;

export function kernelReady(): boolean {
  return ready;
}

// Browser path: fetch the binary served from public/. Safe to call
// repeatedly; concurrent callers share one in-flight init.
export function ensureVectorKernel(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!loading) {
    loading = initKernel({ module_or_path: KERNEL_WASM_URL })
      .then(() => {
        ready = true;
      })
      .catch((err) => {
        loading = null; // allow a retry on transient fetch failure
        throw err;
      });
  }
  return loading;
}

// Node path (scripts/check-kernel.mts): init synchronously from bytes.
export function initVectorKernelFromBytes(bytes: BufferSource): void {
  if (ready) return;
  initSync({ module: bytes });
  ready = true;
}

export function vectorKernelVersion(): string {
  return kernel_version();
}

export interface OptimizeOptions {
  // Max deviation from the source, in canvas px.
  tolerancePx: number;
  // 'adaptive' = subdivide (fast, ~µs; per-frame safe). 'optimal' =
  // optimized subdivision points (fewest segments, ~50-400x slower —
  // export / user-invoked quality passes only).
  mode: "adaptive" | "optimal";
  // Joins whose tangent angle exceeds this are hard corners: fitting runs
  // split there and the corner survives exactly. Degrees, clamped to
  // [0, 89.9] (kurbo's test is on tan(angle), which folds past 90°).
  cornerAngleDeg: number;
  // 0..1 pre-fit denoise: Laplacian smoothing of handle-less anchor
  // positions (Relax's spline convention) before tangent estimation, so
  // the fitter chases the intended shape instead of the jitter. 0 = off.
  smoothing?: number;
  // Drop subpaths whose approximate arc length (canvas px) is below this —
  // the dust that tracing/marching-squares leaves behind. 0 = off.
  cullMinLengthPx?: number;
}

// Approximate arc length in canvas px. Exact for straight chords; curved
// segments sample at 8 steps — plenty for a cull threshold.
function subpathLengthPx(sub: SplineSubpath, w: number, h: number): number {
  const n = sub.anchors.length;
  if (n < 2) return 0;
  let total = 0;
  const segs = sub.closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = sub.anchors[s];
    const b = sub.anchors[(s + 1) % n];
    const p0x = a.pos[0] * w;
    const p0y = a.pos[1] * h;
    const p3x = b.pos[0] * w;
    const p3y = b.pos[1] * h;
    if (!a.outHandle && !b.inHandle) {
      total += Math.hypot(p3x - p0x, p3y - p0y);
      continue;
    }
    const p1x = (a.pos[0] + (a.outHandle?.[0] ?? 0)) * w;
    const p1y = (a.pos[1] + (a.outHandle?.[1] ?? 0)) * h;
    const p2x = (b.pos[0] + (b.inHandle?.[0] ?? 0)) * w;
    const p2y = (b.pos[1] + (b.inHandle?.[1] ?? 0)) * h;
    let px = p0x;
    let py = p0y;
    for (let k = 1; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      const x =
        u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
      const y =
        u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
      total += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
  }
  return total;
}

// Pre-fit denoise: pᵢ ← pᵢ + ½·(avg(neighbors) − pᵢ) per iteration (the
// Relax node's spline convention), restricted to HANDLE-LESS anchors —
// anchors with explicit handles are deliberate geometry and stay pinned,
// as do open-subpath endpoints; closed subpaths wrap. strength 0..1 maps
// to 0..20 iterations. Shrinkage is negligible at trace densities (the
// per-step pull is the chord sagitta, ~hundredths of a px).
function smoothHandleless(
  sub: SplineSubpath,
  strength: number,
  w: number,
  h: number,
  cosCorner: number
): SplineSubpath {
  const iters = Math.round(Math.min(1, Math.max(0, strength)) * 20);
  const n = sub.anchors.length;
  if (iters === 0 || n < 3) return sub;
  const movable = sub.anchors.map((a, i) => {
    if (a.inHandle || a.outHandle) return false;
    if (!sub.closed && (i === 0 || i === n - 1)) return false;
    // Corners detected on the RAW positions stay pinned — otherwise the
    // Laplacian erodes spike tips before corner detection (which runs on
    // the smoothed geometry in buildEmitAnchors) ever sees them. Measured
    // in px space (normalized space is anisotropic).
    const prev = sub.anchors[i === 0 ? n - 1 : i - 1].pos;
    const next = sub.anchors[i === n - 1 ? 0 : i + 1].pos;
    const ax = (a.pos[0] - prev[0]) * w;
    const ay = (a.pos[1] - prev[1]) * h;
    const bx = (next[0] - a.pos[0]) * w;
    const by = (next[1] - a.pos[1]) * h;
    const norm = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (norm > 1e-18 && ax * bx + ay * by < cosCorner * norm) return false;
    return true;
  });
  if (!movable.some(Boolean)) return sub;
  let xs = sub.anchors.map((a) => a.pos[0]);
  let ys = sub.anchors.map((a) => a.pos[1]);
  for (let it = 0; it < iters; it++) {
    const nx = xs.slice();
    const ny = ys.slice();
    for (let i = 0; i < n; i++) {
      if (!movable[i]) continue;
      const ip = i === 0 ? n - 1 : i - 1; // i=0 only movable when closed
      const inx = i === n - 1 ? 0 : i + 1;
      nx[i] = xs[i] + 0.5 * ((xs[ip] + xs[inx]) / 2 - xs[i]);
      ny[i] = ys[i] + 0.5 * ((ys[ip] + ys[inx]) / 2 - ys[i]);
    }
    xs = nx;
    ys = ny;
  }
  return {
    ...sub,
    anchors: sub.anchors.map((a, i) =>
      movable[i] ? { ...a, pos: [xs[i], ys[i]] as [number, number] } : a
    ),
  };
}

const VERB_MOVE = 0;
const VERB_LINE = 1;
const VERB_QUAD = 2;
const VERB_CURVE = 3;
const VERB_CLOSE = 4;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Per-anchor emit info, canvas px, absolute control points. Two hard-won
// encoding rules live here (both verified empirically — see the spec's
// "Kernel input shaping" note):
//
// 1. NEVER hand the kernel a fitting run whose endpoints coincide (a smooth
//    closed loop traversed in full): the fit's chord frame degenerates and
//    output fragments to ~1.5 curves per INPUT segment. Closed loops are
//    split into two half-arcs by the caller.
// 2. NEVER hand it raw polyline (LineTo) runs: kurbo's subdivide mode
//    halves at t=0.5, and when a run's segment count is 2^k-aligned every
//    subdivision boundary lands exactly on a vertex, where the one-sided
//    tangent poisons the fit's endpoint conditions (a 128-segment
//    semicircle fragments to 245 verbs; 129 segments fits to 22). So
//    handle-less anchors get Catmull-Rom-style tangents estimated here —
//    one-sided at joins sharper than the corner angle, so corners stay
//    corners — and every segment emits as a G1 cubic. This is also what
//    kurbo's own docs ask for: point-sequence input should be presented as
//    a smooth spline, not jittery line segments.
interface EmitAnchor {
  x: number;
  y: number;
  // Absolute control points for the incoming (c2) / outgoing (c1) side;
  // null = no explicit handle and no usable tangent (degenerates to the
  // anchor itself, i.e. a straight approach).
  cin: [number, number] | null;
  cout: [number, number] | null;
  // Unit tangent fallbacks used to synthesize cin/cout per segment (they
  // need the chord length, so they resolve at emit time).
  tin: [number, number] | null;
  tout: [number, number] | null;
}

function buildEmitAnchors(
  sub: SplineSubpath,
  w: number,
  h: number,
  cornerAngleRad: number
): EmitAnchor[] {
  const n = sub.anchors.length;
  const px = sub.anchors.map((a) => [a.pos[0] * w, a.pos[1] * h] as [number, number]);
  const unit = (dx: number, dy: number): [number, number] | null => {
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : [dx / len, dy / len];
  };
  const cosCorner = Math.cos(cornerAngleRad);
  return sub.anchors.map((a, i) => {
    const e: EmitAnchor = {
      x: px[i][0],
      y: px[i][1],
      cin: null,
      cout: null,
      tin: null,
      tout: null,
    };
    if (a.inHandle) {
      e.cin = [e.x + a.inHandle[0] * w, e.y + a.inHandle[1] * h];
    }
    if (a.outHandle) {
      e.cout = [e.x + a.outHandle[0] * w, e.y + a.outHandle[1] * h];
    }
    if (e.cin && e.cout) return e;
    // Geometric tangents for the handle-less sides. Closed subpaths wrap.
    const prev = i > 0 ? px[i - 1] : sub.closed ? px[n - 1] : null;
    const next = i < n - 1 ? px[i + 1] : sub.closed ? px[0] : null;
    const dPrev = prev ? unit(e.x - prev[0], e.y - prev[1]) : null;
    const dNext = next ? unit(next[0] - e.x, next[1] - e.y) : null;
    let tin = dPrev;
    let tout = dNext;
    if (dPrev && dNext) {
      const dot = dPrev[0] * dNext[0] + dPrev[1] * dNext[1];
      if (dot >= cosCorner) {
        // Smooth join: shared bisector tangent (Catmull-Rom flavor).
        const t = unit(dPrev[0] + dNext[0], dPrev[1] + dNext[1]);
        if (t) {
          tin = t;
          tout = t;
        }
      }
      // else: hard corner — keep the one-sided directions, kurbo's
      // angle_thresh flush splits the fitting run here.
    }
    if (!e.cin) e.tin = tin;
    if (!e.cout) e.tout = tout;
    return e;
  });
}

// One OPEN run of emit anchors -> verbs/coords. Every segment is a cubic;
// tangent fallbacks scale by chord/3 (auto-smooth convention).
function encodeOpenRun(anchors: EmitAnchor[]): {
  verbs: Uint8Array;
  coords: Float64Array;
} {
  const verbs: number[] = [VERB_MOVE];
  const coords: number[] = [anchors[0].x, anchors[0].y];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    const chord = Math.hypot(b.x - a.x, b.y - a.y) / 3;
    const c1 = a.cout ?? (a.tout ? [a.x + a.tout[0] * chord, a.y + a.tout[1] * chord] : [a.x, a.y]);
    const c2 = b.cin ?? (b.tin ? [b.x - b.tin[0] * chord, b.y - b.tin[1] * chord] : [b.x, b.y]);
    verbs.push(VERB_CURVE);
    coords.push(c1[0], c1[1], c2[0], c2[1], b.x, b.y);
  }
  return { verbs: new Uint8Array(verbs), coords: new Float64Array(coords) };
}

// verbs/coords (canvas px) -> subpaths in normalized space. Handles become
// relative offsets; a closing segment that lands back on the first anchor
// folds its incoming handle onto that anchor and is dropped.
function decodeSubpaths(
  verbs: Uint8Array,
  coords: Float64Array,
  w: number,
  h: number
): SplineSubpath[] {
  const subpaths: SplineSubpath[] = [];
  let anchors: SplineAnchor[] = [];
  let closed = false;
  let ci = 0;
  const flush = () => {
    if (anchors.length > 0) subpaths.push({ anchors, closed });
    anchors = [];
    closed = false;
  };
  const setHandle = (
    anchor: SplineAnchor,
    key: "inHandle" | "outHandle",
    ax: number,
    ay: number
  ) => {
    const hx = ax / w - anchor.pos[0];
    const hy = ay / h - anchor.pos[1];
    if (!near(hx, 0) || !near(hy, 0)) anchor[key] = [hx, hy];
  };
  for (const verb of verbs) {
    if (verb === VERB_MOVE) {
      flush();
      anchors.push({ pos: [coords[ci] / w, coords[ci + 1] / h] });
      ci += 2;
    } else if (verb === VERB_LINE) {
      anchors.push({ pos: [coords[ci] / w, coords[ci + 1] / h] });
      ci += 2;
    } else if (verb === VERB_QUAD) {
      // Degree-elevate to cubic (kurbo's simplify emits cubics, but the
      // wire format allows quads for generality).
      const prev = anchors[anchors.length - 1];
      const px = prev.pos[0] * w;
      const py = prev.pos[1] * h;
      const qx = coords[ci];
      const qy = coords[ci + 1];
      const ex = coords[ci + 2];
      const ey = coords[ci + 3];
      ci += 4;
      const anchor: SplineAnchor = { pos: [ex / w, ey / h] };
      setHandle(prev, "outHandle", px + (2 / 3) * (qx - px), py + (2 / 3) * (qy - py));
      setHandle(anchor, "inHandle", ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey));
      anchors.push(anchor);
    } else if (verb === VERB_CURVE) {
      const prev = anchors[anchors.length - 1];
      const c1x = coords[ci];
      const c1y = coords[ci + 1];
      const c2x = coords[ci + 2];
      const c2y = coords[ci + 3];
      const ex = coords[ci + 4];
      const ey = coords[ci + 5];
      ci += 6;
      const anchor: SplineAnchor = { pos: [ex / w, ey / h] };
      setHandle(prev, "outHandle", c1x, c1y);
      setHandle(anchor, "inHandle", c2x, c2y);
      anchors.push(anchor);
    } else if (verb === VERB_CLOSE) {
      closed = true;
      if (anchors.length > 1) {
        const first = anchors[0];
        const last = anchors[anchors.length - 1];
        if (near(first.pos[0], last.pos[0]) && near(first.pos[1], last.pos[1])) {
          if (last.inHandle) first.inHandle = last.inHandle;
          anchors.pop();
        }
      }
      flush();
    }
  }
  flush();
  return subpaths;
}

interface SimplifyArgs {
  accuracy: number;
  optimize: boolean;
  angleThresh: number;
}

// Simplify one open emit-anchor run through the kernel. The fit preserves
// run endpoints exactly, so the first/last anchors survive by construction.
function simplifyOpenRun(
  anchors: EmitAnchor[],
  args: SimplifyArgs,
  w: number,
  h: number
): SplineAnchor[] {
  const { verbs, coords } = encodeOpenRun(anchors);
  const result = wasmSimplify(
    verbs,
    coords,
    args.accuracy,
    args.optimize,
    args.angleThresh
  );
  const decoded = decodeSubpaths(result.verbs, result.coords, w, h);
  result.free();
  if (decoded.length !== 1 || decoded[0].anchors.length < 2) {
    throw new Error("unexpected kernel output shape for open run");
  }
  return decoded[0].anchors;
}

// Refit a whole SplineValue to minimal clean cubics. Requires kernelReady().
// Per-subpath: metadata (groupIndex/driver/closed) survives 1:1; a subpath
// the kernel rejects (degenerate input) passes through unchanged.
//
// Closed subpaths are split at two opposite anchors into two open half-arcs,
// each simplified independently, then stitched back into a closed loop —
// see the coincident-endpoint note on encodeOpenRun. Cost: those two split
// anchors always survive into the output (a closed loop pins its seam
// anchor under any encoding, so this only adds one extra pinned anchor).
export function optimizeSpline(
  spline: SplineValue,
  opts: OptimizeOptions,
  canvasWidth: number,
  canvasHeight: number
): SplineValue {
  if (!ready) throw new Error("vector kernel not initialized");
  const w = Math.max(1, canvasWidth);
  const h = Math.max(1, canvasHeight);
  const angleDeg = Math.min(89.9, Math.max(0, opts.cornerAngleDeg));
  const args: SimplifyArgs = {
    accuracy: Math.max(0.001, opts.tolerancePx),
    optimize: opts.mode === "optimal",
    angleThresh: Math.tan((angleDeg * Math.PI) / 180),
  };
  const cornerAngleRad = (angleDeg * Math.PI) / 180;
  const cull = Math.max(0, opts.cullMinLengthPx ?? 0);
  const smoothing = Math.min(1, Math.max(0, opts.smoothing ?? 0));
  const out: SplineSubpath[] = [];
  for (let sub of spline.subpaths) {
    // Cull first so dust never reaches the passthrough branch either.
    if (cull > 0 && subpathLengthPx(sub, w, h) < cull) continue;
    const n = sub.anchors.length;
    if ((!sub.closed && n < 3) || (sub.closed && n < 4)) {
      out.push(sub);
      continue;
    }
    try {
      if (smoothing > 0) {
        sub = smoothHandleless(sub, smoothing, w, h, Math.cos(cornerAngleRad));
      }
      // Tangents resolve over the FULL subpath (closed loops wrap), so the
      // half-arc split below still stitches G1 seams.
      const emit = buildEmitAnchors(sub, w, h, cornerAngleRad);
      let anchors: SplineAnchor[];
      if (!sub.closed) {
        anchors = simplifyOpenRun(emit, args, w, h);
      } else {
        const mid = Math.floor(n / 2);
        const arcA = simplifyOpenRun(emit.slice(0, mid + 1), args, w, h);
        const arcB = simplifyOpenRun([...emit.slice(mid), emit[0]], args, w, h);
        // Stitch: A runs a0..amid, B runs amid..a0. The shared endpoints
        // merge; B's closing approach to a0 becomes a0's inHandle.
        anchors = arcA.slice();
        const joint = anchors[anchors.length - 1];
        if (arcB[0].outHandle) joint.outHandle = arcB[0].outHandle;
        anchors.push(...arcB.slice(1, arcB.length - 1));
        const seamBack = arcB[arcB.length - 1];
        const first = anchors[0];
        if (seamBack.inHandle) {
          first.inHandle = seamBack.inHandle;
        } else {
          delete first.inHandle;
        }
      }
      const d: SplineSubpath = { anchors, closed: sub.closed };
      if (sub.groupIndex !== undefined) d.groupIndex = sub.groupIndex;
      if (sub.driver !== undefined) d.driver = sub.driver;
      out.push(d);
    } catch (err) {
      // Never let one bad subpath take down the node — pass it through.
      console.warn("[vector-kernel] simplify failed for subpath:", err);
      out.push(sub);
    }
  }
  return { kind: "spline", subpaths: out };
}
