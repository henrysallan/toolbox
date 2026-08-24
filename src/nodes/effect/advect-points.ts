import type {
  ImageValue,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  copyPointsWith,
  EMPTY_POINTS,
  gatherPoints,
} from "@/engine/points";

// Advect Points — move points through a velocity field derived from an
// image. Unlike Displace (one sample, one push), advection re-samples the
// field at every step, so points follow the field's curves like leaves in
// a stream. Spec: specdocs/archive/071926_advect-points.md.
//
// Two modes:
//   integrate  — stateless. Every eval the input points are seeds and the
//                node integrates `steps × step_size` from scratch.
//                Deterministic (scrub-safe, cache-friendly, offline-exact).
//                The `trails` aux emits each point's path as a polyline
//                subpath — the flow-field streamline look.
//   accumulate — stateful. Persistent positions in ctx.state advance
//                `substeps` steps once per FRAME (only when the clock
//                actually moved — paused param tweaks don't step). Points
//                drift indefinitely and respond to the field as it
//                animates, no Simulation Zone required. Resets on scene
//                loop (like Sim Start); seed-count changes MIGRATE
//                instead of resetting — growth joins new points into the
//                running flow, shrink truncates from the top.
//
// Field interpretations (field_mode):
//   angle    — luminance → heading (θ = (luma·turns + offset)·2π), unit
//              speed. The classic Perlin flow-field.
//   vector   — v = 2·(R − midlevel), 2·(G − midlevel). Signed RG map,
//              Displace's channel convention.
//   gradient — normalized ∇luminance; points flow toward bright. Flat
//              regions stall (zero velocity) — a plateau has no downhill.
//   contour  — gradient rotated 90°; points orbit the field's level sets.
//
// Caching note: integrate-mode trails are built UNCONDITIONALLY (not
// consumedOutputs-gated). The node is cacheable, and a cache hit reuses
// the previous NodeOutput verbatim — a consumer wired to the aux later
// would read a stale empty spline forever. The integration loop dominates
// the cost either way; trail anchors are simple polyline objects.
// Accumulate mode recomputes every frame (time in fingerprintExtras), so
// its trail HISTORY ring is consumption-gated safely (Text's precedent).

const FIELD_SIZE = 256;
const TWO_PI = Math.PI * 2;
const GRAD_EPS = 1e-6;

// ─── Field readback + bilinear sampling ────────────────────────────────────

interface FieldBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

// Identity-cached CPU readback slot. A static field costs one readback
// total; an animated one costs one small (≤256²) readback per new value.
interface FieldSlot {
  source?: ImageValue;
  buf?: FieldBuffer;
}

interface TrailRing {
  buf: Float32Array; // entry-major: [entry][point][xy]
  len: number;
  head: number; // index of the most recent entry
  filled: number;
}

interface AccumState {
  positions: Float32Array;
  count: number;
  alive: Uint8Array;
  initialized: boolean;
  lastTime: number;
  trail?: TrailRing;
}

interface AdvectState {
  field: FieldSlot;
  speed: FieldSlot;
  accum?: AccumState;
}

function ensureState(ctx: RenderContext, nodeId: string): AdvectState {
  const key = `advect-points:${nodeId}`;
  let s = ctx.state[key] as AdvectState | undefined;
  if (!s) {
    s = { field: {}, speed: {} };
    ctx.state[key] = s;
  }
  return s;
}

function readField(
  ctx: RenderContext,
  slot: FieldSlot,
  img: ImageValue
): FieldBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  // Value-object identity = "upstream recomputed" signal (devguide-blessed).
  if (slot.source === img && slot.buf) return slot.buf;
  const w = Math.min(FIELD_SIZE, img.width);
  const h = Math.min(FIELD_SIZE, img.height);
  const data = ctx.readImagePixels(img, w, h);
  if (!data) return null;
  slot.source = img;
  slot.buf = { data, w, h };
  return slot.buf;
}

// Bilinear luminance at Y-DOWN UV. readImagePixels returns ImageData row
// order (row 0 = top), matching point UVs with no flip (Displace/Jitter
// precedent). Nearest sampling banded visibly under hundreds of iterated
// steps — bilinear is required here.
function lumaAt(buf: FieldBuffer, u: number, v: number): number {
  const { data, w, h } = buf;
  let fx = u * w - 0.5;
  let fy = v * h - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const l00 = 0.2126 * data[i00] + 0.7152 * data[i00 + 1] + 0.0722 * data[i00 + 2];
  const l10 = 0.2126 * data[i10] + 0.7152 * data[i10 + 1] + 0.0722 * data[i10 + 2];
  const l01 = 0.2126 * data[i01] + 0.7152 * data[i01 + 1] + 0.0722 * data[i01 + 2];
  const l11 = 0.2126 * data[i11] + 0.7152 * data[i11 + 1] + 0.0722 * data[i11 + 2];
  const a = l00 + (l10 - l00) * tx;
  const b = l01 + (l11 - l01) * tx;
  return (a + (b - a) * ty) / 255;
}

// Bilinear R and G (0..1) for vector mode.
function rgAt(
  buf: FieldBuffer,
  u: number,
  v: number,
  out: [number, number]
): void {
  const { data, w, h } = buf;
  let fx = u * w - 0.5;
  let fy = v * h - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 2; c++) {
    const a = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * tx;
    const b = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * tx;
    out[c] = (a + (b - a) * ty) / 255;
  }
}

// ─── Velocity field ────────────────────────────────────────────────────────

type VelocityFn = (u: number, v: number, out: [number, number]) => void;

function makeVelocityFn(
  fieldMode: string,
  buf: FieldBuffer,
  angleTurns: number,
  angleOffset: number,
  midlevel: number
): VelocityFn {
  if (fieldMode === "vector") {
    const tmp: [number, number] = [0, 0];
    return (u, v, out) => {
      rgAt(buf, u, v, tmp);
      out[0] = 2 * (tmp[0] - midlevel);
      out[1] = 2 * (tmp[1] - midlevel);
    };
  }
  if (fieldMode === "gradient" || fieldMode === "contour") {
    const contour = fieldMode === "contour";
    const e = 1 / Math.max(buf.w, buf.h);
    return (u, v, out) => {
      const gx = lumaAt(buf, u + e, v) - lumaAt(buf, u - e, v);
      const gy = lumaAt(buf, u, v + e) - lumaAt(buf, u, v - e);
      const len = Math.hypot(gx, gy);
      if (len < GRAD_EPS) {
        out[0] = 0;
        out[1] = 0;
        return;
      }
      if (contour) {
        out[0] = -gy / len;
        out[1] = gx / len;
      } else {
        out[0] = gx / len;
        out[1] = gy / len;
      }
    };
  }
  // angle (default)
  return (u, v, out) => {
    const theta = (lumaAt(buf, u, v) * angleTurns + angleOffset) * TWO_PI;
    out[0] = Math.cos(theta);
    out[1] = Math.sin(theta);
  };
}

// ─── Stepping ──────────────────────────────────────────────────────────────

const B_CLAMP = 0;
const B_WRAP = 1;
const B_KILL = 2;

const STEP_MOVED = 0;
const STEP_STALLED = 1;
const STEP_DIED = 2;

// One advection step, in place on `pos`. `k` is the signed per-step
// distance in canvas-width fraction; the y component is scaled by aspect
// (w/h) so speed is isotropic in PIXELS and orbits stay round on
// non-square canvases (invariant #4, decided explicitly). `vOut` receives
// the velocity used, for align_rotation headings.
function stepOnce(
  pos: [number, number],
  vel: VelocityFn,
  speedBuf: FieldBuffer | null,
  k: number,
  aspect: number,
  boundary: number,
  vOut: [number, number]
): number {
  vel(pos[0], pos[1], vOut);
  let vx = vOut[0];
  let vy = vOut[1];
  if (vx === 0 && vy === 0) return STEP_STALLED;
  if (speedBuf) {
    const m = lumaAt(speedBuf, pos[0], pos[1]);
    vx *= m;
    vy *= m;
    if (vx === 0 && vy === 0) return STEP_STALLED;
  }
  let nx = pos[0] + vx * k;
  let ny = pos[1] + vy * k * aspect;
  if (boundary === B_WRAP) {
    nx -= Math.floor(nx);
    ny -= Math.floor(ny);
  } else if (boundary === B_CLAMP) {
    if (nx < 0) nx = 0;
    else if (nx > 1) nx = 1;
    if (ny < 0) ny = 0;
    else if (ny > 1) ny = 1;
  } else if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    pos[0] = nx;
    pos[1] = ny;
    return STEP_DIED;
  }
  pos[0] = nx;
  pos[1] = ny;
  return STEP_MOVED;
}

// Frame-independent per-index hash → [0,1). triple32 (Wellons), the same
// primitive as Point Expression's rand(seed) — strong avalanche on
// sequential integer inputs.
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

// ─── Trails ────────────────────────────────────────────────────────────────

// Append one recorded polyline (flat [x0,y0,x1,y1,…]) as subpath(s).
// In wrap mode a jump > 0.5 on either axis is a torus seam — split there
// so trails don't draw a line across the whole canvas.
function pushTrailSubpaths(
  subpaths: SplineSubpath[],
  rec: number[],
  groupIndex: number | undefined,
  splitOnJumps: boolean
): void {
  const n = rec.length / 2;
  if (n < 2) return;
  let anchors: SplineAnchor[] = [{ pos: [rec[0], rec[1]] }];
  for (let i = 1; i < n; i++) {
    const x = rec[i * 2];
    const y = rec[i * 2 + 1];
    if (
      splitOnJumps &&
      (Math.abs(x - rec[(i - 1) * 2]) > 0.5 ||
        Math.abs(y - rec[(i - 1) * 2 + 1]) > 0.5)
    ) {
      if (anchors.length >= 2) {
        subpaths.push({ anchors, closed: false, groupIndex });
      }
      anchors = [];
    }
    anchors.push({ pos: [x, y] });
  }
  if (anchors.length >= 2) {
    subpaths.push({ anchors, closed: false, groupIndex });
  }
}

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// ─── Node definition ───────────────────────────────────────────────────────

export const advectPointsNode: NodeDefinition = {
  type: "advect-points",
  name: "Advect Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Move points through a velocity field derived from an image — the field is re-sampled at every step, so points follow its curves (unlike Displace's single push). Integrate mode traces N deterministic steps per eval and emits streamline trails (flow-field line art: noise → Advect → trails → Stroke). Accumulate mode keeps persistent positions and advances once per frame — endless drift that responds to an animating field, no Simulation Zone needed. Field modes: angle (luminance → heading), vector (signed RG map), gradient (flow toward bright), contour (orbit level sets).",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  simulation: true,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "field", type: "image", required: true, label: "Field" },
    { name: "speed", type: "image", required: false, label: "Speed field" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["integrate", "accumulate"],
      default: "integrate",
    },
    {
      name: "field_mode",
      label: "Field",
      type: "enum",
      options: ["angle", "vector", "gradient", "contour"],
      default: "angle",
    },
    {
      name: "steps",
      label: "Steps",
      type: "scalar",
      min: 1,
      max: 1000,
      softMax: 200,
      step: 1,
      default: 100,
      visibleIf: (p) => (p.mode ?? "integrate") === "integrate",
    },
    {
      name: "substeps",
      label: "Substeps / frame",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 1,
      visibleIf: (p) => p.mode === "accumulate",
    },
    {
      name: "step_size",
      label: "Step size",
      type: "scalar",
      min: 0,
      max: 0.1,
      softMax: 0.02,
      step: 0.0001,
      default: 0.002,
    },
    { name: "invert", label: "Invert flow", type: "boolean", default: false },
    {
      name: "angle_turns",
      label: "Angle range (turns)",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p) => (p.field_mode ?? "angle") === "angle",
    },
    {
      name: "angle_offset",
      label: "Angle offset (turns)",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => (p.field_mode ?? "angle") === "angle",
    },
    {
      name: "midlevel",
      label: "Midlevel",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.field_mode === "vector",
    },
    {
      name: "boundary",
      label: "Boundary",
      type: "enum",
      options: ["clamp", "wrap", "kill"],
      default: "clamp",
    },
    {
      name: "speed_jitter",
      label: "Speed jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 1,
    },
    {
      name: "align_rotation",
      label: "Align rotation to flow",
      type: "boolean",
      default: false,
    },
    {
      name: "trail_stride",
      label: "Trail stride",
      type: "scalar",
      min: 1,
      max: 10,
      step: 1,
      default: 1,
      visibleIf: (p) => (p.mode ?? "integrate") === "integrate",
    },
    {
      name: "trail_length",
      label: "Trail length (frames)",
      type: "scalar",
      min: 2,
      max: 240,
      softMax: 120,
      step: 1,
      default: 24,
      visibleIf: (p) => p.mode === "accumulate",
    },
  ],
  primaryOutput: "points",
  auxOutputs: [
    {
      name: "trails",
      type: "spline",
      description:
        "Streamlines: one open polyline subpath per point tracing its path (integration steps in integrate mode; the last trail-length frames in accumulate mode). groupIndex = the source point's group. Wire into Stroke or Rasterize Spline for flow-field line art.",
    },
  ],

  // Accumulate mode's output depends on persistent state, so its cache
  // must bust every tick; integrate mode stays fully cacheable (a static
  // 200-step integration computes once). No `stable` flag — time in the
  // extras is equivalent and mode-scoped.
  fingerprintExtras(params, ctx) {
    return params.mode === "accumulate"
      ? `m:acc|t:${ctx.time.toFixed(4)}`
      : "";
  },

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const src = inputs.points;
    const mode = (params.mode as string) ?? "integrate";
    const state = ensureState(ctx, nodeId);

    // Leaving accumulate drops its state, so switching back re-seeds
    // (spec's "mode switched back from integrate" reset rule).
    if (mode !== "accumulate") state.accum = undefined;

    if (!src || src.kind !== "points" || src.count === 0) {
      return { primary: EMPTY_POINTS, aux: { trails: EMPTY_SPLINE } };
    }

    const fieldBuf =
      inputs.field?.kind === "image"
        ? readField(ctx, state.field, inputs.field)
        : null;
    let speedBuf: FieldBuffer | null = null;
    if (inputs.speed?.kind === "image") {
      speedBuf = readField(ctx, state.speed, inputs.speed);
    } else {
      state.speed.source = undefined;
      state.speed.buf = undefined;
    }
    if (!fieldBuf) {
      state.field.source = undefined;
      state.field.buf = undefined;
      // No field: integrate passes seeds through; accumulate holds its
      // current positions (handled below with a null velocity).
      if (mode !== "accumulate") {
        return { primary: src, aux: { trails: EMPTY_SPLINE } };
      }
    }

    const fieldMode = (params.field_mode as string) ?? "angle";
    const stepSize = (params.step_size as number) ?? 0.002;
    const sign = params.invert ? -1 : 1;
    const boundary =
      ((params.boundary as string) ?? "clamp") === "wrap"
        ? B_WRAP
        : ((params.boundary as string) ?? "clamp") === "kill"
          ? B_KILL
          : B_CLAMP;
    const jitter = (params.speed_jitter as number) ?? 0;
    const seed = Math.floor((params.seed as number) ?? 1);
    const seedBase = ((seed >>> 0) * 2654435761) >>> 0;
    const alignRotation = !!params.align_rotation;
    const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;

    const vel = fieldBuf
      ? makeVelocityFn(
          fieldMode,
          fieldBuf,
          (params.angle_turns as number) ?? 1,
          (params.angle_offset as number) ?? 0,
          (params.midlevel as number) ?? 0.5
        )
      : null;

    if (mode === "accumulate") {
      return computeAccumulate(
        src,
        state,
        vel,
        speedBuf,
        params,
        ctx,
        consumedOutputs,
        { stepSize, sign, boundary, jitter, seedBase, alignRotation, aspect }
      );
    }
    return computeIntegrate(src, vel!, speedBuf, params, {
      stepSize,
      sign,
      boundary,
      jitter,
      seedBase,
      alignRotation,
      aspect,
    });
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`advect-points:${nodeId}`];
  },
};

interface StepConfig {
  stepSize: number;
  sign: number;
  boundary: number;
  jitter: number;
  seedBase: number;
  alignRotation: boolean;
  aspect: number;
}

// ─── Integrate mode ────────────────────────────────────────────────────────

function computeIntegrate(
  src: PointsValue,
  vel: VelocityFn,
  speedBuf: FieldBuffer | null,
  params: Record<string, unknown>,
  cfg: StepConfig
): { primary: PointsValue; aux: { trails: SplineValue } } {
  const steps = Math.max(1, Math.floor((params.steps as number) ?? 100));
  const stride = Math.max(1, Math.floor((params.trail_stride as number) ?? 1));
  const n = src.count;
  const inPos = src.positions;
  const inGroups = src.groupIndices;

  const outPositions = new Float32Array(n * 2);
  const headings = cfg.alignRotation ? new Float32Array(n) : null;
  const alive = new Uint8Array(n);
  let aliveCount = 0;

  const subpaths: SplineSubpath[] = [];
  const pos: [number, number] = [0, 0];
  const vOut: [number, number] = [0, 0];
  const rec: number[] = [];

  for (let i = 0; i < n; i++) {
    pos[0] = inPos[i * 2];
    pos[1] = inPos[i * 2 + 1];
    const jf = 1 - cfg.jitter * hash01((cfg.seedBase + i) >>> 0);
    const k = cfg.stepSize * cfg.sign * jf;

    rec.length = 0;
    rec.push(pos[0], pos[1]);
    let died = false;
    let lastVx = 0;
    let lastVy = 0;
    let recordedAt = 0; // step index of the last trail record

    for (let s = 0; s < steps; s++) {
      const r = stepOnce(pos, vel, speedBuf, k, cfg.aspect, cfg.boundary, vOut);
      if (r === STEP_STALLED) break;
      lastVx = vOut[0];
      lastVy = vOut[1];
      if ((s + 1) % stride === 0) {
        rec.push(pos[0], pos[1]);
        recordedAt = s + 1;
      }
      if (r === STEP_DIED) {
        died = true;
        if (recordedAt !== s + 1) rec.push(pos[0], pos[1]);
        break;
      }
      if (s === steps - 1 && recordedAt !== s + 1) {
        rec.push(pos[0], pos[1]);
      }
    }

    pushTrailSubpaths(
      subpaths,
      rec,
      inGroups ? inGroups[i] : undefined,
      cfg.boundary === B_WRAP
    );

    if (!died) {
      alive[i] = 1;
      aliveCount++;
      outPositions[i * 2] = pos[0];
      outPositions[i * 2 + 1] = pos[1];
      if (headings) headings[i] = Math.atan2(lastVy * cfg.sign, lastVx * cfg.sign);
    }
  }

  const trails: SplineValue = { kind: "spline", subpaths };
  return {
    primary: compactPoints(src, outPositions, headings, alive, aliveCount),
    aux: { trails },
  };
}

// Build the output PointsValue, culling dead points. When nothing died,
// attribute buffers are shared with the source (evaluator treats
// PointsValue as immutable across consumers); positions are always fresh.
// Riding copyPointsWith/gatherPoints means every channel — including any
// the value grows later — carries or gathers uniformly
// (081326_point-attributes.md M0).
function compactPoints(
  src: PointsValue,
  positions: Float32Array,
  headings: Float32Array | null,
  alive: Uint8Array,
  aliveCount: number
): PointsValue {
  const n = src.count;
  const merged = copyPointsWith(src, {
    positions,
    rotations: headings ?? src.rotations,
  });
  if (aliveCount === n) return merged;
  const map = new Int32Array(aliveCount);
  let j = 0;
  for (let i = 0; i < n; i++) if (alive[i]) map[j++] = i;
  return gatherPoints(merged, map);
}

// ─── Accumulate mode ───────────────────────────────────────────────────────

// Migrate accumulate state to a new seed count without resetting the sim.
// Indices 0..keep-1 carry their evolved positions / alive flags across;
// grown indices seed from the current input. The trail ring reallocates
// (its layout is entry-major, count-dependent) with history preserved for
// surviving indices and new points backfilled with their seed position,
// so a joining point's trail starts as a dot instead of a bogus line.
function resizeAccumState(
  st: AccumState,
  src: PointsValue,
  n: number
): void {
  const old = st.count;
  const keep = Math.min(old, n);
  const positions = new Float32Array(n * 2);
  positions.set(st.positions.subarray(0, keep * 2));
  const alive = new Uint8Array(n);
  alive.set(st.alive.subarray(0, keep));
  for (let i = old; i < n; i++) {
    positions[i * 2] = src.positions[i * 2];
    positions[i * 2 + 1] = src.positions[i * 2 + 1];
    alive[i] = 1;
  }
  if (st.trail) {
    const ring = st.trail;
    const buf = new Float32Array(n * ring.len * 2);
    for (let e = 0; e < ring.filled; e++) {
      const entry = (ring.head - ring.filled + 1 + e + ring.len) % ring.len;
      const srcBase = entry * old * 2;
      const dstBase = entry * n * 2;
      buf.set(ring.buf.subarray(srcBase, srcBase + keep * 2), dstBase);
      for (let i = old; i < n; i++) {
        buf[dstBase + i * 2] = positions[i * 2];
        buf[dstBase + i * 2 + 1] = positions[i * 2 + 1];
      }
    }
    ring.buf = buf;
  }
  st.positions = positions;
  st.alive = alive;
  st.count = n;
}

function computeAccumulate(
  src: PointsValue,
  state: AdvectState,
  vel: VelocityFn | null,
  speedBuf: FieldBuffer | null,
  params: Record<string, unknown>,
  ctx: RenderContext,
  consumedOutputs: ReadonlySet<string> | undefined,
  cfg: StepConfig
): { primary: PointsValue; aux: { trails: SplineValue } } {
  const substeps = Math.max(1, Math.floor((params.substeps as number) ?? 1));
  const trailLen = Math.max(2, Math.floor((params.trail_length as number) ?? 24));
  const wantTrails = !consumedOutputs || consumedOutputs.has("aux:trails");
  const n = src.count;

  // Reset: first eval or scene-time wrap (Sim Start's rule) only.
  // Seed-count changes do NOT reset the sim: growth joins (new indices
  // seed from the current input while existing points keep their evolved
  // positions — an animated Scatter/Grid count streams points into the
  // flow), shrink truncates from the top (index-aligned upstreams keep
  // the survivors intact). Identity churn from animated upstreams never
  // resets either. Backwards scrub without a wrap keeps state (Sim Zone
  // parity).
  let st = state.accum;
  const timeWrapped = !!st && st.lastTime > 0.05 && ctx.time < 0.05;
  let justReset = false;
  if (!st || !st.initialized || timeWrapped) {
    st = {
      positions: new Float32Array(src.positions),
      count: n,
      alive: new Uint8Array(n).fill(1),
      initialized: true,
      lastTime: ctx.time,
      trail: undefined,
    };
    state.accum = st;
    justReset = true;
  } else if (st.count !== n) {
    resizeAccumState(st, src, n);
  }

  // Trail ring lifecycle: exists only while consumed (history starts when
  // the output is first wired); reallocate on length change.
  if (wantTrails) {
    if (!st.trail || st.trail.len !== trailLen || st.trail.buf.length !== n * trailLen * 2) {
      const ring: TrailRing = {
        buf: new Float32Array(n * trailLen * 2),
        len: trailLen,
        head: 0,
        filled: 1,
      };
      ring.buf.set(st.positions, 0);
      st.trail = ring;
    }
  } else {
    st.trail = undefined;
  }

  // Advance only when the clock actually moved — paused param-tweak
  // re-evals re-emit current state instead of stepping (a deliberate
  // improvement over the Sim Zone, which steps on every eval).
  const advance = !justReset && ctx.time !== st.lastTime && vel !== null;
  if (advance) {
    const pos: [number, number] = [0, 0];
    const vOut: [number, number] = [0, 0];
    for (let i = 0; i < n; i++) {
      if (!st.alive[i]) continue;
      pos[0] = st.positions[i * 2];
      pos[1] = st.positions[i * 2 + 1];
      const jf = 1 - cfg.jitter * hash01((cfg.seedBase + i) >>> 0);
      const k = cfg.stepSize * cfg.sign * jf;
      for (let s = 0; s < substeps; s++) {
        const r = stepOnce(pos, vel!, speedBuf, k, cfg.aspect, cfg.boundary, vOut);
        if (r === STEP_STALLED) break;
        if (r === STEP_DIED) {
          st.alive[i] = 0;
          break;
        }
      }
      st.positions[i * 2] = pos[0];
      st.positions[i * 2 + 1] = pos[1];
    }
    if (st.trail) {
      const ring = st.trail;
      ring.head = (ring.head + 1) % ring.len;
      ring.buf.set(st.positions, ring.head * n * 2);
      if (ring.filled < ring.len) ring.filled++;
    }
  }
  st.lastTime = ctx.time;

  // Emit a COPY — state buffers mutate next frame and emitted PointsValues
  // must stay immutable for downstream consumers/caches. gatherPoints
  // copies positions out of the mutable state buffer and re-reads every
  // other channel from the CURRENT seed input by index, so animated
  // upstream scales/rotations keep flowing; only positions persist.
  let aliveCount = 0;
  for (let i = 0; i < n; i++) if (st.alive[i]) aliveCount++;
  const map = new Int32Array(aliveCount);
  {
    let j = 0;
    for (let i = 0; i < n; i++) if (st.alive[i]) map[j++] = i;
  }
  const out = gatherPoints(
    copyPointsWith(src, { positions: st.positions }),
    map
  );
  // Field-aligned heading wins over the gathered seed rotations.
  if (cfg.alignRotation && vel) {
    const rots = new Float32Array(aliveCount);
    const vOut: [number, number] = [0, 0];
    for (let w = 0; w < aliveCount; w++) {
      vel(out.positions[w * 2], out.positions[w * 2 + 1], vOut);
      rots[w] = Math.atan2(vOut[1] * cfg.sign, vOut[0] * cfg.sign);
    }
    out.rotations = rots;
  }

  let trails: SplineValue = EMPTY_SPLINE;
  if (st.trail && st.trail.filled >= 2) {
    const ring = st.trail;
    const subpaths: SplineSubpath[] = [];
    const rec: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!st.alive[i]) continue;
      rec.length = 0;
      for (let e = 0; e < ring.filled; e++) {
        const entry = (ring.head - ring.filled + 1 + e + ring.len) % ring.len;
        const base = (entry * n + i) * 2;
        rec.push(ring.buf[base], ring.buf[base + 1]);
      }
      pushTrailSubpaths(
        subpaths,
        rec,
        src.groupIndices ? src.groupIndices[i] : undefined,
        cfg.boundary === B_WRAP
      );
    }
    trails = { kind: "spline", subpaths };
  }

  return { primary: out, aux: { trails } };
}
