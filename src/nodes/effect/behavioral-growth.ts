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
  authoredToPxY,
  buildSpatialHash,
  cellStart,
  pxToAuthoredY,
  readMapBuffer,
  sampleMap,
  type MapBuffer,
  type MapCacheEntry,
  type SpatialHash,
} from "@/engine/sim-kernel";
import { EMPTY_POINTS, makePoints } from "@/engine/points";

// Behavioral Growth — specdocs/080226_behavioral-growth.md.
//
// Family C of the growth survey: fixed population, positions evolve, the
// output is the CURRENT state rather than an accumulated record. That is
// what separates it from Accretive Growth — there is no monotone trace to
// slice, so the timeline is Advect Points' `integrate | accumulate` pair
// rather than a `progress` reveal.
//
// Structurally this IS Advect Points with a neighbour term, and it
// deliberately inherits that node's field sampler, advance gate, reset and
// count-migration rules, and trail ring buffer.
//
// On "goals and rewards" (design Q&A): no reinforcement learning. Learned
// policies are nondeterministic, slow to converge and un-art-directable —
// the opposite of what a scrubbable timeline needs. The two framings that
// FEEL like goals and stay deterministic are `steering` (utility weights,
// where every slider maps to visible behaviour) and `physarum` (the
// "reward" is a decaying field the agents both write and read, so
// optimisation emerges AND is renderable).
//
// Everything runs in true canvas pixels so radii and speeds are circular
// on screen rather than in the normalized square. The geometry sockets
// carry AUTHORED coordinates (engine/aspect.ts), so the seams go through
// authoredToPxY / pxToAuthoredY (engine/sim-kernel.ts) — x = u*W, but
// y = v*W + (H-W)/2, NOT v*H. Using v*H treated authored points as canvas
// UV and squashed the whole population toward the vertical middle of the
// pixel canvas, which is what put the [0,W]×[0,H] boundary box (wrap and
// bounce both) well outside the visible frame at 16:9. Canvas-aligned
// lookups — the flow / obstacle field samplers — stay canvas UV (x/W,
// y/H), because those images really are canvas-sized. Square canvas =
// identity, which is why this only ever showed up on non-square projects.

const MAX_STEPS = 400;
const MAX_AGENTS = 200_000;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic per-agent value in [0,1) — wander phase and tumble draws
// keyed on index so they stay stable frame to frame.
function hash01(i: number, seed: number): number {
  let h = (i ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

interface BGState {
  pos: Float32Array;
  vel: Float32Array;
  count: number;
  // Physarum trail field, `fw` x `fh`.
  field: Float32Array | null;
  fieldScratch: Float32Array | null;
  fw: number;
  fh: number;
  trail: { buf: Float32Array; head: number; len: number; cap: number } | null;
  initialized: boolean;
  lastTime: number;
  lastMode: string;
  hash?: SpatialHash;
  maps: Record<string, MapCacheEntry | undefined>;
}

const stateKey = (nodeId: string) => `behavioral-growth:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): BGState {
  let s = ctx.state[stateKey(nodeId)] as BGState | undefined;
  if (!s) {
    s = {
      pos: new Float32Array(0),
      vel: new Float32Array(0),
      count: 0,
      field: null,
      fieldScratch: null,
      fw: 0,
      fh: 0,
      trail: null,
      initialized: false,
      lastTime: -1,
      lastMode: "",
      maps: {},
    };
    ctx.state[stateKey(nodeId)] = s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface SimParams {
  mode: string;
  boundary: string;
  speed: number;
  seed: number;
  // steering
  wSep: number;
  rSep: number;
  wAlign: number;
  wCohesion: number;
  rNeighbor: number;
  wSeek: number;
  wArrive: number;
  arriveRadius: number;
  wWander: number;
  wanderRate: number;
  wFlow: number;
  wAvoid: number;
  maxForce: number;
  predatorPrey: boolean;
  maxNeighbors: number;
  // vicsek
  noise: number;
  // physarum
  sensorAngle: number;
  sensorDist: number;
  turnRate: number;
  deposit: number;
  decay: number;
  diffuse: number;
  // chemotaxis
  tumbleRate: number;
  runBias: number;
}

interface Fields {
  field: MapBuffer | null;
  obstacles: MapBuffer | null;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function sampleTrail(
  field: Float32Array,
  fw: number,
  fh: number,
  x: number,
  y: number,
  W: number,
  H: number
): number {
  const gx = Math.floor((x / W) * fw);
  const gy = Math.floor((y / H) * fh);
  if (gx < 0 || gy < 0 || gx >= fw || gy >= fh) return 0;
  return field[gy * fw + gx];
}

// Separable box blur + multiplicative decay. Cheap enough at 512² that the
// whole field can live on the CPU next to the agents, which is the point:
// a hybrid CPU-agent / GPU-field design would need a full readback EVERY
// frame just to let the agents sense what they wrote.
function diffuseDecay(
  field: Float32Array,
  scratch: Float32Array,
  fw: number,
  fh: number,
  radius: number,
  decay: number
): void {
  const r = Math.max(0, Math.round(radius));
  if (r > 0) {
    const norm = 1 / (r * 2 + 1);
    for (let y = 0; y < fh; y++) {
      const row = y * fw;
      for (let x = 0; x < fw; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          s += field[row + Math.max(0, Math.min(fw - 1, x + k))];
        }
        scratch[row + x] = s * norm;
      }
    }
    for (let x = 0; x < fw; x++) {
      for (let y = 0; y < fh; y++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          s += scratch[Math.max(0, Math.min(fh - 1, y + k)) * fw + x];
        }
        field[y * fw + x] = s * norm * (1 - decay);
      }
    }
  } else {
    const keep = 1 - decay;
    for (let i = 0; i < field.length; i++) field[i] *= keep;
  }
}

// ---------------------------------------------------------------------------
// One simulation step
// ---------------------------------------------------------------------------

function step(
  st: BGState,
  p: SimParams,
  f: Fields,
  targets: Float32Array | null,
  groups: Int32Array | null,
  W: number,
  H: number,
  rng: () => number
): void {
  const n = st.count;
  if (n === 0) return;
  const pos = st.pos;
  const vel = st.vel;

  const needNeighbours =
    p.mode === "vicsek" ||
    (p.mode === "steering" &&
      (p.wSep !== 0 || p.wAlign !== 0 || p.wCohesion !== 0 || p.predatorPrey));
  const queryR = Math.max(p.rSep, p.rNeighbor, 1);
  if (needNeighbours) {
    st.hash = buildSpatialHash(pos, n, queryR, W, H, st.hash);
  }
  const hash = st.hash;

  for (let i = 0; i < n; i++) {
    const x = pos[i * 2];
    const y = pos[i * 2 + 1];
    let vx = vel[i * 2];
    let vy = vel[i * 2 + 1];

    if (p.mode === "physarum") {
      // Jones 2010: sample the trail ahead and ±sensor_angle, rotate
      // toward the strongest, step, deposit.
      const heading = Math.atan2(vy, vx);
      const fld = st.field!;
      let best = -Infinity;
      let bestTurn = 0;
      for (let s = -1; s <= 1; s++) {
        const a = heading + s * p.sensorAngle;
        const sx = x + Math.cos(a) * p.sensorDist;
        const sy = y + Math.sin(a) * p.sensorDist;
        const v = sampleTrail(fld, st.fw, st.fh, sx, sy, W, H);
        if (v > best) {
          best = v;
          bestTurn = s;
        }
      }
      let nh = heading;
      if (bestTurn !== 0) nh += bestTurn * p.turnRate;
      else if (best <= 0) nh += (rng() - 0.5) * 2 * p.turnRate;
      vx = Math.cos(nh) * p.speed;
      vy = Math.sin(nh) * p.speed;
    } else if (p.mode === "vicsek") {
      // Alignment + angular noise and nothing else. `noise` alone drives
      // a genuine order/disorder transition.
      let sx = 0;
      let sy = 0;
      if (hash) {
        const r2 = p.rNeighbor * p.rNeighbor;
        const gw = hash.gw, gh = hash.gh, cell = hash.cell;
        const cx0 = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
        const cy0 = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
        let nb = 0;
        outer: for (let oy = -1; oy <= 1; oy++) {
          const gy = cy0 + oy;
          if (gy < 0 || gy >= gh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const gx = cx0 + ox;
            if (gx < 0 || gx >= gw) continue;
            const c = gy * gw + gx;
            const end = hash.counts[c];
            for (let e = cellStart(hash, c); e < end; e++) {
              if (nb >= p.maxNeighbors) break outer;
              const j = hash.entries[e];
              if (j === i) continue;
              const dx = x - pos[j * 2];
              const dy = y - pos[j * 2 + 1];
              if (dx * dx + dy * dy > r2) continue;
              nb++;
              sx += vel[j * 2];
              sy += vel[j * 2 + 1];
            }
          }
        }
      }
      let h = sx === 0 && sy === 0 ? Math.atan2(vy, vx) : Math.atan2(sy, sx);
      h += (rng() - 0.5) * 2 * Math.PI * p.noise;
      vx = Math.cos(h) * p.speed;
      vy = Math.sin(h) * p.speed;
    } else if (p.mode === "chemotaxis") {
      // Run-and-tumble: keep going while the field improves, otherwise
      // reorient at random. The run bias is what makes it read as
      // SEARCHING rather than sliding down a gradient.
      let h = Math.atan2(vy, vx);
      let improving = false;
      if (f.field) {
        const here = sampleMap(f.field, x / W, y / H);
        const ax = x + Math.cos(h) * p.sensorDist;
        const ay = y + Math.sin(h) * p.sensorDist;
        const ahead = sampleMap(f.field, ax / W, ay / H);
        improving = ahead > here;
      }
      const pTumble = improving ? p.tumbleRate * (1 - p.runBias) : p.tumbleRate;
      if (rng() < pTumble) h = rng() * Math.PI * 2;
      vx = Math.cos(h) * p.speed;
      vy = Math.sin(h) * p.speed;
    } else {
      // ---- steering ----
      let fx = 0;
      let fy = 0;
      if (hash) {
        let sepX = 0;
        let sepY = 0;
        let alX = 0;
        let alY = 0;
        let cohX = 0;
        let cohY = 0;
        let nCoh = 0;
        let preyX = 0;
        let preyY = 0;
        let nPrey = 0;
        const myGroup = groups ? groups[i] : 0;
        const iAmPredator = p.predatorPrey && myGroup !== 0;
        // Inlined rather than routed through a callback: at 10k agents
        // with the default neighbour radius this body runs millions of
        // times per frame, and the per-pair closure invocation alone was
        // costing more than the arithmetic (137ms -> single digits).
        const rSep2 = p.rSep * p.rSep;
        const rNb2 = p.rNeighbor * p.rNeighbor;
        const gw = hash.gw, gh = hash.gh, cell = hash.cell;
        const cx0 = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
        const cy0 = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
        // Interaction is TOPOLOGICAL, not metric: each agent considers at
        // most `max_neighbors` others. A fixed radius makes neighbour
        // count grow with density, so the whole simulation degrades to
        // O(n^2) — 10k agents cost 59ms and 50k cost 1146ms. Capping is
        // also the better model: real starlings track ~7 neighbours
        // regardless of how dense the flock is (Ballerini et al. 2008).
        let nb = 0;
        outer: for (let oy = -1; oy <= 1; oy++) {
          const gy = cy0 + oy;
          if (gy < 0 || gy >= gh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const gx = cx0 + ox;
            if (gx < 0 || gx >= gw) continue;
            const c = gy * gw + gx;
            const end = hash.counts[c];
            for (let e = cellStart(hash, c); e < end; e++) {
              if (nb >= p.maxNeighbors) break outer;
              const j = hash.entries[e];
              if (j === i) continue;
              const dx = x - pos[j * 2];
              const dy = y - pos[j * 2 + 1];
              const d2 = dx * dx + dy * dy;
              if (d2 > rNb2 && d2 > rSep2) continue;
              nb++;
              if (p.predatorPrey && (groups ? groups[j] : 0) !== myGroup) {
                if (d2 > rNb2) continue;
                preyX += dx;
                preyY += dy;
                nPrey++;
                continue;
              }
              if (d2 < rSep2 && d2 > 1e-12) {
                sepX += dx / d2;
                sepY += dy / d2;
              }
              if (d2 < rNb2) {
                alX += vel[j * 2];
                alY += vel[j * 2 + 1];
                cohX += pos[j * 2];
                cohY += pos[j * 2 + 1];
                nCoh++;
              }
            }
          }
        }
        fx += sepX * p.wSep * p.rSep;
        fy += sepY * p.wSep * p.rSep;
        if (nCoh > 0) {
          const al = Math.hypot(alX, alY);
          if (al > 1e-6) {
            fx += (alX / al) * p.wAlign * p.speed;
            fy += (alY / al) * p.wAlign * p.speed;
          }
          fx += (cohX / nCoh - x) * p.wCohesion;
          fy += (cohY / nCoh - y) * p.wCohesion;
        }
        if (nPrey > 0) {
          const sign = iAmPredator ? -1 : 1;
          fx += preyX * sign * p.wSep * 2;
          fy += preyY * sign * p.wSep * 2;
        }
      }

      if (targets && targets.length >= 2 && (p.wSeek !== 0 || p.wArrive !== 0)) {
        // Nearest target; negative `w_seek` is flee, so one slider covers
        // both directions.
        let bx = targets[0];
        let by = targets[1];
        let bd = Infinity;
        for (let t = 0; t < targets.length; t += 2) {
          const dx = targets[t] - x;
          const dy = targets[t + 1] - y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            bx = targets[t];
            by = targets[t + 1];
          }
        }
        let dx = bx - x;
        let dy = by - y;
        const d = Math.hypot(dx, dy) || 1;
        dx /= d;
        dy /= d;
        fx += dx * p.wSeek * p.speed;
        fy += dy * p.wSeek * p.speed;
        if (p.wArrive !== 0) {
          // Scale the approach down inside the arrive radius so agents
          // settle onto a target instead of orbiting it forever.
          const ease = Math.min(1, d / Math.max(1e-6, p.arriveRadius));
          fx += dx * p.wArrive * p.speed * ease;
          fy += dy * p.wArrive * p.speed * ease;
        }
      }

      if (p.wWander !== 0) {
        const a =
          hash01(i, p.seed) * Math.PI * 2 + rng() * p.wanderRate * Math.PI * 2;
        fx += Math.cos(a) * p.wWander * p.speed;
        fy += Math.sin(a) * p.wWander * p.speed;
      }

      if (p.wFlow !== 0 && f.field) {
        const a = sampleMap(f.field, x / W, y / H) * Math.PI * 2;
        fx += Math.cos(a) * p.wFlow * p.speed;
        fy += Math.sin(a) * p.wFlow * p.speed;
      }

      if (p.wAvoid !== 0 && f.obstacles) {
        const e = Math.max(1, p.rSep * 0.5);
        const c = sampleMap(f.obstacles, x / W, y / H);
        const gx = sampleMap(f.obstacles, (x + e) / W, y / H) - c;
        const gy = sampleMap(f.obstacles, x / W, (y + e) / H) - c;
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-6) {
          fx -= (gx / gl) * p.wAvoid * p.speed;
          fy -= (gy / gl) * p.wAvoid * p.speed;
        }
      }

      // Clamp the accumulated force, then the resulting speed. Without
      // both clamps the weights compound instead of blending and the
      // flock explodes as soon as two behaviours agree.
      const fl = Math.hypot(fx, fy);
      if (fl > p.maxForce) {
        fx = (fx / fl) * p.maxForce;
        fy = (fy / fl) * p.maxForce;
      }
      vx += fx;
      vy += fy;
      const vl = Math.hypot(vx, vy);
      if (vl > p.speed) {
        vx = (vx / vl) * p.speed;
        vy = (vy / vl) * p.speed;
      }
    }

    let nx = x + vx;
    let ny = y + vy;
    if (p.boundary === "wrap") {
      if (nx < 0) nx += W;
      else if (nx >= W) nx -= W;
      if (ny < 0) ny += H;
      else if (ny >= H) ny -= H;
    } else {
      if (nx < 0 || nx > W) {
        vx = -vx;
        nx = clamp(nx, 0, W);
      }
      if (ny < 0 || ny > H) {
        vy = -vy;
        ny = clamp(ny, 0, H);
      }
    }
    pos[i * 2] = nx;
    pos[i * 2 + 1] = ny;
    vel[i * 2] = vx;
    vel[i * 2 + 1] = vy;

    if (p.mode === "physarum") {
      const gx = Math.floor((nx / W) * st.fw);
      const gy = Math.floor((ny / H) * st.fh);
      if (gx >= 0 && gy >= 0 && gx < st.fw && gy < st.fh) {
        st.field![gy * st.fw + gx] += p.deposit;
      }
    }
  }

  if (p.mode === "physarum") {
    diffuseDecay(
      st.field!,
      st.fieldScratch!,
      st.fw,
      st.fh,
      p.diffuse,
      p.decay
    );
  }
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

const isSteer = (p: Record<string, unknown>): boolean =>
  (p.mode ?? "steering") === "steering";

export const behavioralGrowthNode: NodeDefinition = {
  type: "behavioral-growth",
  name: "Behavioral Growth",
  category: "point",
  subcategory: "modifier",
  description:
    "Give points rules and let them move — flocking, schooling, crowds, slime networks. Steering stacks the classic behaviours as weights you can mix: separation, alignment and cohesion for a flock, Seek toward wired Targets (negative values flee), Wander for restlessness, Flow to follow a wired field as an angle map, and Avoid to steer around Obstacles; tag agents with different group indices and turn on Predator/prey to watch a flock split around a chaser. Physarum is the slime-mould network — each agent sniffs the trail ahead and to each side, turns toward the strongest, and deposits its own trail, which diffuses and decays; the Deposit image aux is usually what you actually render. Vicsek is alignment plus angular noise alone, and the noise slider alone takes it from ordered swirls to chaos. Chemotaxis runs and tumbles up a wired field, searching rather than sliding. Integrate re-runs from the seed points every frame (deterministic and scrub-safe, and the Trails aux gives streamline art); Accumulate keeps the agents moving frame to frame as a living system.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  simulation: true,
  inputs: [
    { name: "points", label: "Agents", type: "points", required: true },
    { name: "field", label: "Field", type: "mask", required: false },
    { name: "targets", label: "Targets", type: "points", required: false },
    { name: "obstacles", label: "Obstacles", type: "mask", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["steering", "physarum", "vicsek", "chemotaxis"],
      default: "steering",
    },
    {
      name: "timeline",
      label: "Timeline",
      type: "enum",
      options: ["accumulate", "integrate"],
      default: "accumulate",
      // Physarum's field is inherently path-dependent, so it cannot be
      // re-derived from scratch each eval.
      visibleIf: (p) => p.mode !== "physarum",
    },
    {
      name: "steps",
      label: "Steps",
      type: "scalar",
      min: 1,
      max: MAX_STEPS,
      softMax: 200,
      step: 1,
      default: 100,
      visibleIf: (p) => p.timeline === "integrate" && p.mode !== "physarum",
    },
    {
      name: "substeps",
      label: "Substeps",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 1,
      visibleIf: (p) => p.timeline !== "integrate" || p.mode === "physarum",
    },
    {
      name: "speed",
      label: "Speed",
      type: "scalar",
      min: 0.0002,
      max: 0.02,
      step: 0.0001,
      default: 0.002,
    },
    {
      name: "boundary",
      label: "Boundary",
      type: "enum",
      options: ["wrap", "bounce"],
      default: "wrap",
    },
    // ---- steering ----
    {
      name: "w_separation",
      label: "Separation",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.01,
      default: 1.2,
      visibleIf: isSteer,
    },
    {
      name: "r_separation",
      label: "Separation radius",
      type: "scalar",
      min: 0.002,
      max: 0.2,
      step: 0.001,
      default: 0.015,
      visibleIf: (p) => isSteer(p) || p.mode === "vicsek",
    },
    {
      name: "w_alignment",
      label: "Alignment",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: isSteer,
    },
    {
      name: "w_cohesion",
      label: "Cohesion",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.01,
      default: 0.6,
      visibleIf: isSteer,
    },
    {
      name: "r_neighbor",
      label: "Neighbour radius",
      type: "scalar",
      min: 0.005,
      max: 0.5,
      step: 0.001,
      default: 0.06,
      visibleIf: (p) => isSteer(p) || p.mode === "vicsek",
    },
    {
      name: "w_seek",
      label: "Seek / flee",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0,
      visibleIf: isSteer,
    },
    {
      name: "w_arrive",
      label: "Arrive",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0,
      visibleIf: isSteer,
    },
    {
      name: "arrive_radius",
      label: "Arrive radius",
      type: "scalar",
      min: 0.005,
      max: 0.5,
      step: 0.005,
      default: 0.1,
      visibleIf: (p) => isSteer(p) && num(p.w_arrive, 0) !== 0,
    },
    {
      name: "w_wander",
      label: "Wander",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.1,
      visibleIf: isSteer,
    },
    {
      name: "wander_rate",
      label: "Wander rate",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      visibleIf: isSteer,
    },
    {
      name: "w_flow",
      label: "Flow follow",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0,
      visibleIf: isSteer,
    },
    {
      name: "w_avoid",
      label: "Obstacle avoid",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.01,
      default: 0,
      visibleIf: isSteer,
    },
    {
      name: "max_force",
      label: "Max force",
      type: "scalar",
      min: 0.01,
      max: 2,
      step: 0.01,
      default: 0.15,
      visibleIf: isSteer,
    },
    {
      name: "max_neighbors",
      label: "Max neighbours",
      type: "scalar",
      min: 4,
      max: 256,
      softMax: 64,
      step: 1,
      default: 24,
      visibleIf: (p) => isSteer(p) || p.mode === "vicsek",
    },
    {
      name: "predator_prey",
      label: "Predator / prey",
      type: "boolean",
      default: false,
      visibleIf: isSteer,
    },
    // ---- vicsek ----
    {
      name: "noise",
      label: "Noise",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.15,
      visibleIf: (p) => p.mode === "vicsek",
    },
    // ---- physarum ----
    {
      name: "sensor_angle",
      label: "Sensor angle",
      type: "scalar",
      min: 5,
      max: 90,
      step: 0.5,
      default: 22.5,
      visibleIf: (p) => p.mode === "physarum",
    },
    {
      name: "sensor_distance",
      label: "Sensor distance",
      type: "scalar",
      min: 0.002,
      max: 0.1,
      step: 0.0005,
      default: 0.012,
      visibleIf: (p) => p.mode === "physarum" || p.mode === "chemotaxis",
    },
    {
      name: "turn_rate",
      label: "Turn rate",
      type: "scalar",
      min: 1,
      max: 180,
      step: 1,
      default: 45,
      visibleIf: (p) => p.mode === "physarum",
    },
    {
      name: "deposit_amount",
      label: "Deposit",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
      visibleIf: (p) => p.mode === "physarum",
    },
    {
      name: "decay",
      label: "Decay",
      type: "scalar",
      min: 0.001,
      max: 0.5,
      step: 0.001,
      default: 0.08,
      visibleIf: (p) => p.mode === "physarum",
    },
    {
      name: "diffuse_radius",
      label: "Diffuse",
      type: "scalar",
      min: 0,
      max: 5,
      step: 1,
      default: 1,
      visibleIf: (p) => p.mode === "physarum",
    },
    {
      name: "field_resolution",
      label: "Field resolution",
      type: "scalar",
      min: 64,
      max: 1024,
      softMax: 512,
      step: 1,
      default: 384,
      visibleIf: (p) => p.mode === "physarum",
    },
    // ---- chemotaxis ----
    {
      name: "tumble_rate",
      label: "Tumble rate",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
      visibleIf: (p) => p.mode === "chemotaxis",
    },
    {
      name: "run_bias",
      label: "Run bias",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.8,
      visibleIf: (p) => p.mode === "chemotaxis",
    },
    // ---- output ----
    {
      name: "trail_length",
      label: "Trail length",
      type: "scalar",
      min: 2,
      max: 240,
      softMax: 120,
      step: 1,
      default: 24,
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
  ],
  primaryOutput: "points",
  auxOutputs: [
    { name: "trails", type: "spline" },
    { name: "deposit", type: "image" },
  ],

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const st = getState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count === 0) {
      st.initialized = false;
      st.count = 0;
      return {
        primary: EMPTY_POINTS,
        aux: { trails: { kind: "spline", subpaths: [] } satisfies SplineValue },
      };
    }

    const mode = typeof params.mode === "string" ? params.mode : "steering";
    // Physarum is stateful by construction: its field is path-dependent,
    // so there is nothing to re-derive from scratch.
    const timeline =
      mode === "physarum"
        ? "accumulate"
        : params.timeline === "integrate"
          ? "integrate"
          : "accumulate";

    const p: SimParams = {
      mode,
      boundary: params.boundary === "bounce" ? "bounce" : "wrap",
      speed: clamp(num(params.speed, 0.002), 0.0002, 0.02) * W,
      seed: Math.max(0, Math.round(num(params.seed, 0))),
      wSep: clamp(num(params.w_separation, 1.2), 0, 4),
      rSep: clamp(num(params.r_separation, 0.015), 0.002, 0.2) * W,
      wAlign: clamp(num(params.w_alignment, 1), 0, 4),
      wCohesion: clamp(num(params.w_cohesion, 0.6), 0, 4),
      rNeighbor: clamp(num(params.r_neighbor, 0.06), 0.005, 0.5) * W,
      wSeek: clamp(num(params.w_seek, 0), -2, 2),
      wArrive: clamp(num(params.w_arrive, 0), 0, 2),
      arriveRadius: clamp(num(params.arrive_radius, 0.1), 0.005, 0.5) * W,
      wWander: clamp(num(params.w_wander, 0.1), 0, 2),
      wanderRate: clamp(num(params.wander_rate, 0.3), 0, 1),
      wFlow: clamp(num(params.w_flow, 0), 0, 2),
      wAvoid: clamp(num(params.w_avoid, 0), 0, 4),
      maxForce: clamp(num(params.max_force, 0.15), 0.01, 2) * W * 0.01,
      predatorPrey: params.predator_prey === true,
      maxNeighbors: clamp(Math.round(num(params.max_neighbors, 24)), 4, 256),
      noise: clamp(num(params.noise, 0.15), 0, 1),
      sensorAngle:
        (clamp(num(params.sensor_angle, 22.5), 5, 90) * Math.PI) / 180,
      sensorDist: clamp(num(params.sensor_distance, 0.012), 0.002, 0.1) * W,
      turnRate: (clamp(num(params.turn_rate, 45), 1, 180) * Math.PI) / 180,
      deposit: clamp(num(params.deposit_amount, 0.2), 0, 1),
      decay: clamp(num(params.decay, 0.08), 0.001, 0.5),
      diffuse: clamp(Math.round(num(params.diffuse_radius, 1)), 0, 5),
      tumbleRate: clamp(num(params.tumble_rate, 0.2), 0, 1),
      runBias: clamp(num(params.run_bias, 0.8), 0, 1),
    };

    const count = Math.min(src.count, MAX_AGENTS);
    const trailLen = clamp(Math.round(num(params.trail_length, 24)), 2, 240);
    const fRes = clamp(Math.round(num(params.field_resolution, 384)), 64, 1024);

    const fields: Fields = {
      field: readMapBuffer(ctx, st.maps, "field", inputs.field),
      obstacles: readMapBuffer(ctx, st.maps, "obstacles", inputs.obstacles),
    };
    let targets: Float32Array | null = null;
    const tin = inputs.targets;
    if (tin && tin.kind === "points" && tin.count > 0) {
      targets = new Float32Array(tin.count * 2);
      for (let i = 0; i < tin.count; i++) {
        targets[i * 2] = tin.positions[i * 2] * W;
        targets[i * 2 + 1] = authoredToPxY(tin.positions[i * 2 + 1], W, H);
      }
    }

    const seedInto = (from: number, to: number): void => {
      const rng = mulberry32(p.seed ^ 0x51ed);
      for (let i = from; i < to; i++) {
        st.pos[i * 2] = src.positions[i * 2] * W;
        st.pos[i * 2 + 1] = authoredToPxY(src.positions[i * 2 + 1], W, H);
        const a = hash01(i, p.seed) * Math.PI * 2 + rng() * 1e-6;
        st.vel[i * 2] = Math.cos(a) * p.speed;
        st.vel[i * 2 + 1] = Math.sin(a) * p.speed;
      }
    };

    const time = ctx.time;
    const wrapped = st.lastTime > 0.05 && time < 0.05;
    const modeSwitched = st.lastMode !== mode;
    const reset =
      !st.initialized || wrapped || timeline === "integrate" || modeSwitched;

    if (reset || st.count !== count) {
      const old = st.count;
      const grew = !reset && count > old;
      const prevPos = st.pos;
      const prevVel = st.vel;
      st.pos = new Float32Array(count * 2);
      st.vel = new Float32Array(count * 2);
      st.count = count;
      if (grew) {
        // Count changes MIGRATE, never reset: an animated Scatter streams
        // new agents into a running flock while every existing agent keeps
        // its evolved position (Advect Points' rule).
        st.pos.set(prevPos.subarray(0, Math.min(old, count) * 2));
        st.vel.set(prevVel.subarray(0, Math.min(old, count) * 2));
        seedInto(old, count);
      } else if (!reset && count < old) {
        st.pos.set(prevPos.subarray(0, count * 2));
        st.vel.set(prevVel.subarray(0, count * 2));
      } else {
        seedInto(0, count);
      }
      st.initialized = true;
      st.trail = null;
    }
    st.lastMode = mode;

    if (mode === "physarum") {
      const fh = Math.max(4, Math.round((fRes * H) / W));
      if (!st.field || st.fw !== fRes || st.fh !== fh) {
        st.fw = fRes;
        st.fh = fh;
        st.field = new Float32Array(fRes * fh);
        st.fieldScratch = new Float32Array(fRes * fh);
      }
      if (reset) {
        st.field.fill(0);
      }
    }

    const wantTrails = consumedOutputs?.has("aux:trails") ?? false;
    const advance = time !== st.lastTime;

    if (timeline === "integrate") {
      // Stateless: seeds are the input points and the whole run happens
      // now, so the node stays a pure function of params + inputs.
      const steps = clamp(Math.round(num(params.steps, 100)), 1, MAX_STEPS);
      const rng = mulberry32(p.seed);
      // Trails are built UNCONDITIONALLY here: this arm is cacheable, and
      // the evaluator reuses a cached NodeOutput verbatim, so a consumer
      // wired later would otherwise read a stale empty spline forever
      // (the Advect Points divergence, same reason).
      const hist = new Float32Array(count * steps * 2);
      for (let s = 0; s < steps; s++) {
        step(st, p, fields, targets, src.groupIndices ?? null, W, H, rng);
        for (let i = 0; i < count; i++) {
          hist[(s * count + i) * 2] = st.pos[i * 2];
          hist[(s * count + i) * 2 + 1] = st.pos[i * 2 + 1];
        }
      }
      const subpaths: SplineSubpath[] = [];
      for (let i = 0; i < count; i++) {
        const anchors: SplineAnchor[] = [];
        for (let s = 0; s < steps; s++) {
          const x = hist[(s * count + i) * 2];
          const y = hist[(s * count + i) * 2 + 1];
          if (s > 0) {
            const px = hist[((s - 1) * count + i) * 2];
            const py = hist[((s - 1) * count + i) * 2 + 1];
            // A wrap teleport must break the trail, not draw across the
            // whole canvas.
            if (Math.abs(x - px) > W * 0.5 || Math.abs(y - py) > H * 0.5) {
              if (anchors.length >= 2) {
                subpaths.push({
                  anchors,
                  closed: false,
                  groupIndex: src.groupIndices?.[i],
                });
              }
              anchors.length = 0;
            }
          }
          anchors.push({ pos: [x / W, pxToAuthoredY(y, W, H)] });
        }
        if (anchors.length >= 2) {
          subpaths.push({
            anchors,
            closed: false,
            groupIndex: src.groupIndices?.[i],
          });
        }
      }
      return {
        primary: emitPoints(st, src, W, H),
        aux: { trails: { kind: "spline", subpaths } satisfies SplineValue },
      };
    }

    // ---- accumulate ----
    if (advance) {
      const substeps = clamp(Math.round(num(params.substeps, 1)), 1, 16);
      const rng = mulberry32(p.seed ^ Math.imul(ctx.frame | 0, 0x9e3779b9));
      for (let s = 0; s < substeps; s++) {
        step(st, p, fields, targets, src.groupIndices ?? null, W, H, rng);
      }
      if (wantTrails) {
        if (!st.trail || st.trail.cap !== count || st.trail.len !== trailLen) {
          st.trail = {
            buf: new Float32Array(count * trailLen * 2),
            head: 0,
            len: trailLen,
            cap: count,
          };
          // Backfill so a joining agent's trail starts as a dot rather
          // than a line from the origin.
          for (let i = 0; i < count; i++) {
            for (let k = 0; k < trailLen; k++) {
              st.trail.buf[(i * trailLen + k) * 2] = st.pos[i * 2];
              st.trail.buf[(i * trailLen + k) * 2 + 1] = st.pos[i * 2 + 1];
            }
          }
        }
        const t = st.trail;
        for (let i = 0; i < count; i++) {
          t.buf[(i * t.len + t.head) * 2] = st.pos[i * 2];
          t.buf[(i * t.len + t.head) * 2 + 1] = st.pos[i * 2 + 1];
        }
        t.head = (t.head + 1) % t.len;
      }
      st.lastTime = time;
    }

    const aux: Record<string, unknown> = {
      trails: buildRingTrails(st, src, W, H, wantTrails),
    };
    if (mode === "physarum" && st.field) {
      aux.deposit = uploadField(ctx, st);
    }
    return { primary: emitPoints(st, src, W, H), aux: aux as never };
  },

  fingerprintExtras(params, ctx) {
    // `integrate` is a pure function of params + inputs, so it keeps full
    // fingerprint caching; only the stateful arm busts per frame.
    const mode = typeof params.mode === "string" ? params.mode : "steering";
    if (mode !== "physarum" && params.timeline === "integrate") return "";
    return `t:${ctx.time}`;
  },

  dispose(ctx, nodeId) {
    delete ctx.state[stateKey(nodeId)];
  },
};

function emitPoints(
  st: BGState,
  src: PointsValue,
  W: number,
  H: number
): PointsValue {
  const n = st.count;
  const out = makePoints(n, {
    withScales: true,
    withRotations: true,
    withGroupIndices: true,
  });
  for (let i = 0; i < n; i++) {
    out.positions[i * 2] = st.pos[i * 2] / W;
    out.positions[i * 2 + 1] = pxToAuthoredY(st.pos[i * 2 + 1], W, H);
    out.rotations![i] = Math.atan2(st.vel[i * 2 + 1], st.vel[i * 2]);
    // Attributes are re-read from the CURRENT seed input by index, so an
    // animated upstream keeps driving scale and group while only the
    // positions come from state.
    const sx = src.scales ? src.scales[i * 2] : 1;
    const sy = src.scales ? src.scales[i * 2 + 1] : 1;
    out.scales![i * 2] = sx;
    out.scales![i * 2 + 1] = sy;
    out.groupIndices![i] = src.groupIndices ? src.groupIndices[i] : 0;
  }
  return out;
}

function buildRingTrails(
  st: BGState,
  src: PointsValue,
  W: number,
  H: number,
  want: boolean
): SplineValue {
  const t = st.trail;
  if (!want || !t) return { kind: "spline", subpaths: [] };
  const subpaths: SplineSubpath[] = [];
  for (let i = 0; i < st.count; i++) {
    let anchors: SplineAnchor[] = [];
    let px = 0;
    let py = 0;
    for (let k = 0; k < t.len; k++) {
      const idx = (t.head + k) % t.len;
      const x = t.buf[(i * t.len + idx) * 2];
      const y = t.buf[(i * t.len + idx) * 2 + 1];
      if (k > 0 && (Math.abs(x - px) > W * 0.5 || Math.abs(y - py) > H * 0.5)) {
        if (anchors.length >= 2) {
          subpaths.push({
            anchors,
            closed: false,
            groupIndex: src.groupIndices?.[i],
          });
        }
        anchors = [];
      }
      anchors.push({ pos: [x / W, pxToAuthoredY(y, W, H)] });
      px = x;
      py = y;
    }
    if (anchors.length >= 2) {
      subpaths.push({
        anchors,
        closed: false,
        groupIndex: src.groupIndices?.[i],
      });
    }
  }
  return { kind: "spline", subpaths };
}

// The trail field as a renderable image. Agents live on the CPU, so this
// is the one place the field crosses to the GPU — once per frame, at the
// field's own resolution rather than the canvas's.
function uploadField(ctx: RenderContext, st: BGState): ImageValue {
  const out = ctx.allocImage({ width: st.fw, height: st.fh });
  const n = st.fw * st.fh;
  const rgba = new Uint8Array(n * 4);
  const field = st.field!;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, Math.round(field[i] * 255)));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const gl = ctx.gl;
  gl.bindTexture(gl.TEXTURE_2D, out.texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    st.fw,
    st.fh,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    rgba
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return out;
}
