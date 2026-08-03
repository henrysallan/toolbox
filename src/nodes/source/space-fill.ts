import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { readDriver } from "@/engine/driver-reduce";
import { EMPTY_POINTS, makePoints } from "@/engine/points";
import { hash01 } from "@/engine/spline-color-source";

// Space Fill — packed self-avoiding walk spline generator (specdocs/
// 072726_space-fill.md). Port of the owner's p5.js "flo" sketch: a walker
// draws a line step by step over a px occupancy grid, always choosing the
// free cell closest to "dead ahead" (an acos scoring with a per-step
// exponent jitter — the source of the 45°/90° kinks), stamping a fat
// neighborhood occupied so later lines pack against earlier ones. When it
// jams (or hits its step budget) a new line starts nearby with fresh
// per-line character. Dense maze-like packing, parallel runs, and
// nested-frame illusions are all emergent — nothing is modeled explicitly.
//
// Spline-native: one open polyline subpath per line, anchors at turns only
// (collinear steps merge), groupIndex from a selectable ID mode so the
// existing group-ramp styling downstream (Rasterize fill, Stroke color /
// per-subpath thickness) colors lines. Per-line weight rides the subpath
// `driver` channel (see spline-color-source.ts's driver mode).
//
// Sim-state model: the full trace (deterministic in seed + structural
// params + region/obstacle content) is built once and cached in ctx.state;
// the keyframable `progress` param just SLICES it — scrubbing either way is
// cheap, and a line's identity/weight never changes while it draws (ids are
// assigned from the completed trace).

// Runaway guards: total steps across the trace, and consecutive lines that
// failed to take a single step before we declare the grid jammed.
const MAX_TRACE_STEPS = 500_000;
const MAX_JAM_RUN = 8;
// Start-cell rejection-sampling budgets (near-previous / random) before the
// deterministic scan fallback.
const NEAR_TRIES = 16;
const RAND_TRIES = 64;

// Grid cell codes.
const FREE = 0; // walkable, unoccupied
const TAKEN = 1; // walkable, stamped by a line
const BLOCKED = 2; // outside region / obstacle / margin

// Deterministic PRNG — every random draw in the trace flows through one
// mulberry32 stream so a seed fully determines the picture.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

interface TraceLine {
  // Anchor px pairs [x0,y0, x1,y1, …], y-down, turns only.
  ax: Float32Array;
  // Line-local cumulative step index at each anchor (stepOf[0] = 0).
  stepOf: Int32Array;
  steps: number; // successful moves in this line
  weightU: number; // raw uniform 0..1 → weight range applied at emit
  startX: number;
  startY: number;
  rankT: number; // 0..1 length rank over the finished trace (size id mode)
}

interface Trace {
  lines: TraceLine[];
  totalSteps: number;
  // Walkable bbox px [x0, y0, x1, y1] (inclusive) — cluster-id frame.
  bbox: [number, number, number, number];
}

interface SpaceFillState {
  // Thresholded region/obstacle bitmap (BLOCKED / FREE), rebuilt only when
  // an input's value-object identity changes (the devguide's "upstream
  // recomputed" signal). Null when neither input is wired.
  baseBlocked: Uint8Array | null;
  baseW: number;
  baseH: number;
  regionRef: unknown;
  obstaclesRef: unknown;
  // The cached trace + the structural-param signature that built it.
  trace: Trace | null;
  traceSig: string;
  // Memo of the last emitted slice (progress/id/weight params only).
  emitKey: string;
  emitTrace: Trace | null;
  emitSpline: SplineValue | null;
  emitPoints: PointsValue | null;
}

const stateKey = (nodeId: string) => `space-fill:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): SpaceFillState {
  let s = ctx.state[stateKey(nodeId)] as SpaceFillState | undefined;
  if (!s) {
    s = {
      baseBlocked: null,
      baseW: 0,
      baseH: 0,
      regionRef: null,
      obstaclesRef: null,
      trace: null,
      traceSig: "",
      emitKey: "",
      emitTrace: null,
      emitSpline: null,
      emitPoints: null,
    };
    ctx.state[stateKey(nodeId)] = s;
  }
  return s;
}

interface WalkParams {
  seed: number;
  coverage: number;
  maxLines: number;
  marginPx: number;
  stepMin: number;
  stepMax: number;
  metric: string;
  wobble: number;
  wander: number;
  spacingAuto: boolean;
  spacing: number;
  lineSteps: number;
  startMode: string;
  startArea: number;
}

// ---------------------------------------------------------------------------
// The trace builder — the whole sketch lives here.
// ---------------------------------------------------------------------------

function buildTrace(
  baseBlocked: Uint8Array | null,
  W: number,
  H: number,
  p: WalkParams
): Trace {
  const grid = new Uint8Array(W * H);
  if (baseBlocked) grid.set(baseBlocked);

  // Margin border (bufferx/y).
  const m = Math.round(p.marginPx);
  if (m > 0) {
    for (let y = 0; y < H; y++) {
      const inBandY = y < m || y >= H - m;
      const row = y * W;
      if (inBandY) {
        grid.fill(BLOCKED, row, row + W);
      } else {
        for (let x = 0; x < m; x++) grid[row + x] = BLOCKED;
        for (let x = W - m; x < W; x++) grid[row + x] = BLOCKED;
      }
    }
  }

  // Walkable census + bbox.
  let walkable = 0;
  let bx0 = W;
  let by0 = H;
  let bx1 = -1;
  let by1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (grid[row + x] === FREE) {
        walkable++;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  if (walkable === 0 || bx1 < bx0) {
    return { lines: [], totalSteps: 0, bbox: [0, 0, 0, 0] };
  }

  // Start window: centered sub-rect of the walkable bbox (start_area per
  // axis — the sketch's useaddx inner window; walks still wander out of it).
  const bcx = (bx0 + bx1) / 2;
  const bcy = (by0 + by1) / 2;
  const bhw = Math.max(1, ((bx1 - bx0) / 2) * p.startArea);
  const bhh = Math.max(1, ((by1 - by0) / 2) * p.startArea);
  const wx0 = Math.max(bx0, Math.floor(bcx - bhw));
  const wx1 = Math.min(bx1, Math.ceil(bcx + bhw));
  const wy0 = Math.max(by0, Math.floor(bcy - bhh));
  const wy1 = Math.min(by1, Math.ceil(bcy + bhh));

  const rand = mulberry32((p.seed * 2654435761) ^ 0x9e3779b9);
  const randInt = (lo: number, hi: number) =>
    lo + Math.floor(rand() * (hi - lo + 1));

  let covered = 0;
  const target = Math.floor(walkable * p.coverage);

  // Stamp the (2f+1)² neighborhood occupied; counts newly-taken walkable
  // cells toward coverage. Blocked cells stay blocked.
  const stamp = (cx: number, cy: number, f: number) => {
    const x0 = Math.max(0, cx - f);
    const x1 = Math.min(W - 1, cx + f);
    const y0 = Math.max(0, cy - f);
    const y1 = Math.min(H - 1, cy + f);
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        if (grid[row + x] === FREE) {
          grid[row + x] = TAKEN;
          covered++;
        }
      }
    }
  };

  const lines: TraceLine[] = [];
  let totalSteps = 0;
  let jamRun = 0;
  let prevEndX = -1;
  let prevEndY = -1;
  let reach = randInt(p.stepMin, p.stepMax);

  // Start-cell selection: near the previous line's end (stay-on-track),
  // rejection-fallback to a random window cell, then a deterministic scan
  // from a seeded offset. Null = the window is exhausted.
  const pickStart = (r: number): [number, number] | null => {
    if (p.startMode === "near-previous" && prevEndX >= 0) {
      for (let i = 0; i < NEAR_TRIES; i++) {
        const sx = prevEndX + randInt(-(r + 2), r + 2);
        const sy = prevEndY + randInt(-(r + 2), r + 2);
        if (sx < wx0 || sx > wx1 || sy < wy0 || sy > wy1) continue;
        if (grid[sy * W + sx] === FREE) return [sx, sy];
      }
    }
    for (let i = 0; i < RAND_TRIES; i++) {
      const sx = randInt(wx0, wx1);
      const sy = randInt(wy0, wy1);
      if (grid[sy * W + sx] === FREE) return [sx, sy];
    }
    const ww = wx1 - wx0 + 1;
    const wh = wy1 - wy0 + 1;
    const total = ww * wh;
    const off = Math.floor(rand() * total);
    for (let i = 0; i < total; i++) {
      const idx = (off + i) % total;
      const sx = wx0 + (idx % ww);
      const sy = wy0 + Math.floor(idx / ww);
      if (grid[sy * W + sx] === FREE) return [sx, sy];
    }
    return null;
  };

  while (
    lines.length < p.maxLines &&
    covered < target &&
    jamRun < MAX_JAM_RUN &&
    totalSteps < MAX_TRACE_STEPS
  ) {
    // Per-line character: reach drifts ±1 (sizeChoice walk), spacing ties
    // to it (fatness = reach − 1 in auto; manual capped so the walker can
    // still escape its own stamp), weight drawn raw, plm ≈ 1.
    reach = clamp(reach + (rand() < 0.5 ? -1 : 1), p.stepMin, p.stepMax);
    const f = Math.max(
      0,
      p.spacingAuto ? reach - 1 : Math.min(p.spacing, reach - 1)
    );
    const plmBase = 0.99 + rand() * 0.02;
    const weightU = rand();
    let alm = (rand() * 2 - 1) * 0.1;

    const start = pickStart(reach);
    if (!start) break;
    let curX = start[0];
    let curY = start[1];
    // Initial heading: a random non-zero step behind us (the sketch's
    // past = start + random([-1,0,1])).
    let ipx = 0;
    let ipy = 0;
    while (ipx === 0 && ipy === 0) {
      ipx = randInt(-1, 1);
      ipy = randInt(-1, 1);
    }
    let pastX = curX - ipx;
    let pastY = curY - ipy;

    stamp(curX, curY, f);

    // Anchors: grown as plain arrays, collinear runs merged in place.
    const axs: number[] = [curX, curY];
    const stepOf: number[] = [0];
    let lastDx = 0;
    let lastDy = 0;
    let n = 0;

    while (n < p.lineSteps) {
      // Per-step randomness consumed before the scan (deterministic).
      let exp = 1;
      if (p.metric === "straight") {
        const u = rand() * p.wobble;
        exp = clamp(plmBase, 1 - u, 1 + u);
      } else if (p.metric === "weighted") {
        alm = clamp(alm + (rand() * 2 - 1) * p.wander, -10, 10);
      }
      const alm2 = alm * alm;
      const pvx = pastX - curX;
      const pvy = pastY - curY;
      const pvLen = Math.sqrt(pvx * pvx + pvy * pvy);

      let bestS = 0;
      let bestT = 0;
      let found = false;
      // straight minimizes |score − π|; the others maximize. `<=`/`>=`
      // keeps the sketch's last-scanned-wins tie behavior.
      let bestScore = p.metric === "straight" ? Infinity : -Infinity;
      for (let s = -reach; s <= reach; s++) {
        const nx = curX + s;
        if (nx < 0 || nx >= W) continue;
        for (let t = -reach; t <= reach; t++) {
          const ny = curY + t;
          if (ny < 0 || ny >= H) continue;
          if (grid[ny * W + nx] !== FREE) continue;
          let score: number;
          if (p.metric === "farthest") {
            const dx = nx - pastX;
            const dy = ny - pastY;
            score = dx * dx + dy * dy;
            if (score >= bestScore) {
              bestScore = score;
              bestS = s;
              bestT = t;
              found = true;
            }
          } else if (p.metric === "manhattan") {
            score = Math.abs(nx - pastX) + Math.abs(ny - pastY);
            if (score >= bestScore) {
              bestScore = score;
              bestS = s;
              bestT = t;
              found = true;
            }
          } else if (p.metric === "weighted") {
            const ex = pastX * alm - nx * alm2;
            const ey = pastY * alm - ny * alm2;
            score = ex * ex + ey * ey;
            if (score >= bestScore) {
              bestScore = score;
              bestS = s;
              bestT = t;
              found = true;
            }
          } else {
            // straight: angle between the backward vector and the
            // candidate, warped by the per-step exponent; closest to π
            // (= dead ahead) wins. Integer-vector angle quantization is
            // what produces the axis/45° runs.
            const den = pvLen * Math.sqrt(s * s + t * t);
            const rat = den > 0 ? clamp((pvx * s + pvy * t) / den, -1, 1) : 0;
            score = Math.abs(Math.pow(Math.acos(rat), exp) - Math.PI);
            if (score <= bestScore) {
              bestScore = score;
              bestS = s;
              bestT = t;
              found = true;
            }
          }
        }
      }
      if (!found) break; // jammed against the packing — line ends

      pastX = curX;
      pastY = curY;
      curX += bestS;
      curY += bestT;
      stamp(curX, curY, f);
      n++;

      // Collinear merge: same reduced direction extends the last anchor.
      const g = gcd(Math.abs(bestS), Math.abs(bestT));
      const dx = bestS / g;
      const dy = bestT / g;
      if (dx === lastDx && dy === lastDy) {
        axs[axs.length - 2] = curX;
        axs[axs.length - 1] = curY;
        stepOf[stepOf.length - 1] = n;
      } else {
        axs.push(curX, curY);
        stepOf.push(n);
        lastDx = dx;
        lastDy = dy;
      }
    }

    if (n >= 1) {
      lines.push({
        ax: Float32Array.from(axs),
        stepOf: Int32Array.from(stepOf),
        steps: n,
        weightU,
        startX: start[0],
        startY: start[1],
        rankT: 0,
      });
      totalSteps += n;
      jamRun = 0;
      prevEndX = curX;
      prevEndY = curY;
    } else {
      jamRun++;
    }
  }

  // Length ranks for the `size` id mode (0 = shortest … 1 = longest).
  const order = lines
    .map((ln, i) => [ln.steps, i] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const denom = Math.max(1, lines.length - 1);
  order.forEach(([, li], rank) => {
    lines[li].rankT = rank / denom;
  });

  return { lines, totalSteps, bbox: [bx0, by0, bx1, by1] };
}

// ---------------------------------------------------------------------------
// Emit: slice the trace at `progress`, assign ids/weights.
// ---------------------------------------------------------------------------

interface EmitParams {
  progress: number;
  idMode: string;
  idGroups: number;
  clusterGrid: number;
  idSeed: number;
  weightMin: number;
  weightMax: number;
}

function groupIndexFor(
  trace: Trace,
  line: TraceLine,
  index: number,
  e: EmitParams
): number {
  switch (e.idMode) {
    case "random":
      return Math.min(
        e.idGroups - 1,
        Math.floor(hash01(index, e.idSeed) * e.idGroups)
      );
    case "cluster": {
      const [bx0, by0, bx1, by1] = trace.bbox;
      const g = e.clusterGrid;
      const gx = clamp(
        Math.floor(((line.startX - bx0) / Math.max(1, bx1 - bx0)) * g),
        0,
        g - 1
      );
      const gy = clamp(
        Math.floor(((line.startY - by0) / Math.max(1, by1 - by0)) * g),
        0,
        g - 1
      );
      return gy * g + gx;
    }
    case "order":
      return Math.min(
        e.idGroups - 1,
        Math.floor((index / Math.max(1, trace.lines.length)) * e.idGroups)
      );
    case "size":
      return Math.min(e.idGroups - 1, Math.floor(line.rankT * e.idGroups));
    default:
      return index; // "line"
  }
}

function emitSlice(
  trace: Trace,
  W: number,
  H: number,
  e: EmitParams
): { spline: SplineValue; points: PointsValue } {
  const k = Math.round(clamp(e.progress, 0, 1) * trace.totalSteps);
  const wSpan = e.weightMax - e.weightMin;

  const subpaths: SplineSubpath[] = [];
  interface Tip {
    x: number;
    y: number;
    rot: number;
    w: number;
    gi: number;
  }
  const tips: Tip[] = [];

  let stepBase = 0;
  for (let li = 0; li < trace.lines.length; li++) {
    const line = trace.lines[li];
    if (stepBase >= k) break;
    const localK = Math.min(line.steps, k - stepBase);
    stepBase += line.steps;
    if (localK < 1) continue;

    const anchors: SplineAnchor[] = [];
    const ax = line.ax;
    const stepOf = line.stepOf;
    // All anchors reached by localK, then an interpolated tip mid-segment
    // so growth sweeps smoothly instead of jumping turn to turn.
    let last = 0;
    while (last + 1 < stepOf.length && stepOf[last + 1] <= localK) last++;
    for (let a = 0; a <= last; a++) {
      anchors.push({ pos: [ax[a * 2] / W, ax[a * 2 + 1] / H] });
    }
    let tipX = ax[last * 2];
    let tipY = ax[last * 2 + 1];
    if (last + 1 < stepOf.length && localK > stepOf[last]) {
      const frac = (localK - stepOf[last]) / (stepOf[last + 1] - stepOf[last]);
      tipX += (ax[(last + 1) * 2] - tipX) * frac;
      tipY += (ax[(last + 1) * 2 + 1] - tipY) * frac;
      anchors.push({ pos: [tipX / W, tipY / H] });
    }
    if (anchors.length < 2) continue;

    const gi = groupIndexFor(trace, line, li, e);
    const weight = clamp(e.weightMin + line.weightU * wSpan, 0, 1);
    subpaths.push({ anchors, closed: false, groupIndex: gi, driver: weight });

    const prev = anchors[anchors.length - 2].pos;
    const tip = anchors[anchors.length - 1].pos;
    tips.push({
      x: tip[0],
      y: tip[1],
      rot: Math.atan2(tip[1] - prev[1], tip[0] - prev[0]),
      w: weight,
      gi,
    });
  }

  const points = makePoints(tips.length, {
    withScales: true,
    withRotations: true,
    withGroupIndices: true,
  });
  for (let i = 0; i < tips.length; i++) {
    points.positions[i * 2] = tips[i].x;
    points.positions[i * 2 + 1] = tips[i].y;
    points.scales![i * 2] = tips[i].w;
    points.scales![i * 2 + 1] = tips[i].w;
    points.rotations![i] = tips[i].rot;
    points.groupIndices![i] = tips[i].gi;
  }

  return { spline: { kind: "spline", subpaths }, points };
}

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

export const spaceFillNode: NodeDefinition = {
  type: "space-fill",
  name: "Space Fill",
  category: "spline",
  subcategory: "generator",
  description:
    "Fill space with packed self-avoiding walk lines — a walker steps across a pixel grid always heading as straight as it can through free cells, blocking a fat neighborhood as it goes, so lines pack tightly against each other into dense maze-like structure with long parallel runs and 45°/90° kinks. Each line is one open subpath tagged with a group id (ID Mode: per-line, seeded random, spatial cluster, draw order, or length rank) — style downstream with Rasterize Spline / Stroke ramps set to 'group', and map per-line weight with Stroke's thickness 'driver' mode. Progress reveals the drawing over time (keyframe it to watch it draw); Region and Obstacles masks confine where the walk may go. Aux `tips` emits one point per line at its current drawing tip.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "region", label: "Region", type: "mask", required: false },
    { name: "obstacles", label: "Obstacles", type: "mask", required: false },
  ],
  params: [
    // ---- fill ----
    {
      name: "progress",
      label: "Progress",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "coverage",
      label: "Coverage",
      type: "scalar",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.85,
    },
    {
      name: "max_lines",
      label: "Max lines",
      type: "scalar",
      min: 1,
      max: 2000,
      softMax: 500,
      step: 1,
      default: 250,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 0,
    },
    {
      name: "margin",
      label: "Margin",
      type: "scalar",
      min: 0,
      max: 0.25,
      step: 0.005,
      default: 0.02,
    },
    // ---- walk ----
    {
      name: "step_min",
      label: "Step min",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 1,
    },
    {
      name: "step_max",
      label: "Step max",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 4,
    },
    {
      name: "metric",
      label: "Metric",
      type: "enum",
      options: ["straight", "farthest", "manhattan", "weighted"],
      default: "straight",
    },
    {
      name: "wobble",
      label: "Wobble",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => (p.metric ?? "straight") === "straight",
    },
    {
      name: "wander",
      label: "Wander",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      visibleIf: (p) => p.metric === "weighted",
    },
    {
      name: "spacing_auto",
      label: "Auto spacing",
      type: "boolean",
      default: true,
    },
    {
      name: "spacing",
      label: "Spacing (px)",
      type: "scalar",
      min: 0,
      max: 8,
      step: 1,
      default: 2,
      visibleIf: (p) => p.spacing_auto === false,
    },
    {
      name: "line_steps",
      label: "Max line steps",
      type: "scalar",
      min: 16,
      max: 20000,
      softMax: 5000,
      step: 1,
      default: 3000,
    },
    // ---- starts ----
    {
      name: "start_mode",
      label: "Starts",
      type: "enum",
      options: ["near-previous", "anywhere"],
      default: "near-previous",
    },
    {
      name: "start_area",
      label: "Start area",
      type: "scalar",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 1,
    },
    // ---- weight ----
    {
      name: "weight_min",
      label: "Weight min",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    {
      name: "weight_max",
      label: "Weight max",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.9,
    },
    // ---- ids ----
    {
      name: "id_mode",
      label: "ID mode",
      type: "enum",
      options: ["cluster", "random", "order", "size", "line"],
      default: "cluster",
    },
    {
      name: "id_groups",
      label: "ID groups",
      type: "scalar",
      min: 2,
      max: 32,
      step: 1,
      default: 6,
      visibleIf: (p) =>
        p.id_mode === "random" || p.id_mode === "order" || p.id_mode === "size",
    },
    {
      name: "cluster_grid",
      label: "Cluster grid",
      type: "scalar",
      min: 2,
      max: 16,
      step: 1,
      default: 4,
      visibleIf: (p) => (p.id_mode ?? "cluster") === "cluster",
    },
    {
      name: "id_seed",
      label: "ID seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 0,
      visibleIf: (p) => p.id_mode === "random",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "tips", type: "points" }],

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    const regionIn = inputs.region;
    const region = regionIn && regionIn.kind === "mask" ? regionIn : null;
    const obstaclesIn = inputs.obstacles;
    const obstacles =
      obstaclesIn && obstaclesIn.kind === "mask" ? obstaclesIn : null;

    // ---- blocked bitmap (region/obstacle readback, identity-cached) ----
    const regionRef: unknown = region;
    const obstaclesRef: unknown = obstacles;
    if (
      state.regionRef !== regionRef ||
      state.obstaclesRef !== obstaclesRef ||
      state.baseW !== W ||
      state.baseH !== H
    ) {
      let base: Uint8Array | null = null;
      if (region || obstacles) {
        base = new Uint8Array(W * H);
        const reg = region ? readDriver(ctx, null, region, W, H, 1) : null;
        if (reg) {
          for (let i = 0; i < base.length; i++) {
            if (reg[i] < 0.5) base[i] = BLOCKED;
          }
        }
        const obs = obstacles
          ? readDriver(ctx, null, obstacles, W, H, 1)
          : null;
        if (obs) {
          for (let i = 0; i < base.length; i++) {
            if (obs[i] >= 0.5) base[i] = BLOCKED;
          }
        }
      }
      state.baseBlocked = base;
      state.baseW = W;
      state.baseH = H;
      state.regionRef = regionRef;
      state.obstaclesRef = obstaclesRef;
      state.trace = null; // content changed — retrace
    }

    // ---- structural params → trace signature ----
    const stepMin = clamp(Math.round(num(params.step_min, 1)), 1, 8);
    const stepMax = clamp(Math.round(num(params.step_max, 4)), stepMin, 8);
    const wp: WalkParams = {
      seed: Math.max(0, Math.round(num(params.seed, 0))),
      coverage: clamp(num(params.coverage, 0.85), 0.05, 1),
      maxLines: clamp(Math.round(num(params.max_lines, 250)), 1, 2000),
      marginPx: clamp(num(params.margin, 0.02), 0, 0.25) * Math.min(W, H),
      stepMin,
      stepMax,
      metric: typeof params.metric === "string" ? params.metric : "straight",
      wobble: clamp(num(params.wobble, 1), 0, 1),
      wander: clamp(num(params.wander, 0.1), 0, 1),
      spacingAuto: params.spacing_auto !== false,
      spacing: clamp(Math.round(num(params.spacing, 2)), 0, 8),
      lineSteps: clamp(Math.round(num(params.line_steps, 3000)), 16, 20000),
      startMode:
        typeof params.start_mode === "string"
          ? params.start_mode
          : "near-previous",
      startArea: clamp(num(params.start_area, 1), 0.05, 1),
    };
    const traceSig = [
      W,
      H,
      wp.seed,
      wp.coverage,
      wp.maxLines,
      wp.marginPx,
      wp.stepMin,
      wp.stepMax,
      wp.metric,
      wp.wobble,
      wp.wander,
      wp.spacingAuto ? 1 : 0,
      wp.spacing,
      wp.lineSteps,
      wp.startMode,
      wp.startArea,
    ].join("|");
    if (!state.trace || state.traceSig !== traceSig) {
      state.trace = buildTrace(state.baseBlocked, W, H, wp);
      state.traceSig = traceSig;
      state.emitTrace = null; // slices of the old trace are stale
    }
    const trace = state.trace;
    if (trace.lines.length === 0) {
      return {
        primary: { kind: "spline", subpaths: [] } satisfies SplineValue,
        aux: { tips: EMPTY_POINTS },
      };
    }

    // ---- emit-time params → slice (memoized) ----
    const weightMin = clamp(num(params.weight_min, 0.6), 0, 1);
    const ep: EmitParams = {
      progress: clamp(num(params.progress, 1), 0, 1),
      idMode: typeof params.id_mode === "string" ? params.id_mode : "cluster",
      idGroups: clamp(Math.round(num(params.id_groups, 6)), 2, 32),
      clusterGrid: clamp(Math.round(num(params.cluster_grid, 4)), 2, 16),
      idSeed: Math.max(0, Math.round(num(params.id_seed, 0))),
      weightMin,
      weightMax: clamp(num(params.weight_max, 0.9), weightMin, 1),
    };
    const emitKey = [
      ep.progress,
      ep.idMode,
      ep.idGroups,
      ep.clusterGrid,
      ep.idSeed,
      ep.weightMin,
      ep.weightMax,
    ].join("|");
    if (
      state.emitTrace !== trace ||
      state.emitKey !== emitKey ||
      !state.emitSpline ||
      !state.emitPoints
    ) {
      const { spline, points } = emitSlice(trace, W, H, ep);
      state.emitSpline = spline;
      state.emitPoints = points;
      state.emitKey = emitKey;
      state.emitTrace = trace;
    }

    // The tips aux is built unconditionally with the slice (the loop-weave
    // consumedOutputs lesson — this node caches, consumption isn't in the
    // fingerprint).
    return {
      primary: state.emitSpline,
      aux: { tips: state.emitPoints },
    };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[stateKey(nodeId)];
  },
};
