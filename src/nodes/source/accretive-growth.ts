import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { readDriver } from "@/engine/driver-reduce";
import { EMPTY_POINTS } from "@/engine/points";
import {
  computeBranchIds,
  computeDaVinciWidths,
  emitGrowth,
  EMPTY_TRACE,
  type GrowthEmitOptions,
  type GrowthIdMode,
  type GrowthTrace,
} from "@/engine/growth-emit";

// Accretive Growth — branching structures that accumulate and never move
// (specdocs/080226_accretive-growth.md). M1 shipped the spine plus
// `space_colonization`; M2 added the grid modes `dla` and `percolation`
// plus `boundary` emission; M3 added `laplacian`; M4 adds the network
// modes `crack` and `hyphal` plus closed venation. L-systems in M5.
//
// Space colonization (Runions et al. 2005): scatter attractors, let every
// tree node step toward the mean direction of the attractors it is nearest
// to, and consume attractors as branches reach them. Branching is
// emergent — two attractor clusters pulling one node apart resolve into
// two children on the next pass. The attractor cloud is a points socket
// and the growable area is a mask, so the art direction is spatial:
// scatter into a text silhouette and the tree grows into the letters.
//
// DLA (Witten & Sander 1981): off-lattice random walkers released on a
// ring outside the cluster stick where they touch it. Frost, lichen,
// electrodeposition. Off-lattice (continuous positions, tangent contact)
// reads far more organic than the grid version at no extra cost.
//
// Laplacian / DBM (Niemeyer, Pietronero & Wiesmann 1984): solve Laplace's
// equation with the growing shape held at potential 0 and the domain edge
// at 1, then grow into a boundary cell with probability proportional to
// phi^eta. `eta` is the one knob that morphs the whole family — 0 gives a
// compact Eden blob, 1 approximates DLA coral, and large values let only
// the most exposed tip advance, which is lightning.
//
// Crack and hyphal share one tip-walker engine. Tips advance under a
// heading, wander, branch stochastically, and DIE ON CONTACT with existing
// growth — recording a non-tree edge as they go. That edge is the point:
// a crack T-ing into an older crack, or two hyphae anastomosing, are joins
// a parent array cannot express, so they ride `extraEdges` and force the
// emitter off its root-to-leaf chain walk. What separates the two modes is
// seeding: cracks NUCLEATE at scattered origins each propagating both
// ways, while hyphae RADIATE from their seeds as one connected organism.
//
// Percolation: a frontier over an occupancy grid. `invasion` always eats
// the lowest-resistance neighbour — wire an image and growth burrows
// through its dark regions and stalls at the light ones. `eden` picks
// uniformly at random from the frontier instead, giving compact
// rough-edged blobs (bacterial colonies, spreading stains).
//
// Timeline: the whole growth run is simulated ONCE into a trace cached in
// ctx.state, and `progress` slices it (Space Fill's model). Scrubbing
// either direction is free and offline export is exact. The trace rebuilds
// only when a structural param changes or a wired input's value identity
// changes — an animated attractor cloud therefore re-grows per frame for
// free, which is why the spec's `cached | live` enum isn't needed here.

const MAX_ITERS = 4000;
// Rejection-sampling budget multiplier when scattering attractors into a
// masked region — a thin region can reject a lot before it lands.
const SCATTER_TRIES = 40;
// How much of a node's own lineage is ignored when looking for a closed-
// venation fusion partner.
const FUSE_ANCESTOR_SKIP = 32;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Deterministic PRNG — every random draw in a trace flows through one
// mulberry32 stream, so a seed fully determines the structure and offline
// export matches the viewport exactly (no Math.random anywhere).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface AccretiveState {
  // Thresholded region/obstacle bitmap (1 = blocked), rebuilt only when an
  // input's value-object identity changes. Null when neither is wired.
  blocked: Uint8Array | null;
  baseW: number;
  baseH: number;
  regionRef: unknown;
  obstaclesRef: unknown;
  seedsRef: unknown;
  attractorsRef: unknown;
  fieldRef: unknown;
  // Resistance field read at the percolation grid resolution.
  fieldBuf: Float32Array | null;
  fieldGrid: string;
  // The cached trace + the structural signature that built it.
  trace: GrowthTrace | null;
  traceSig: string;
  // Memo of the last emitted slice (progress / emit / id params only).
  emitKey: string;
  emitTrace: GrowthTrace | null;
  emitSpline: SplineValue | null;
  emitPoints: PointsValue | null;
}

const stateKey = (nodeId: string) => `accretive-growth:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): AccretiveState {
  let s = ctx.state[stateKey(nodeId)] as AccretiveState | undefined;
  if (!s) {
    s = {
      blocked: null,
      baseW: 0,
      baseH: 0,
      regionRef: null,
      obstaclesRef: null,
      seedsRef: null,
      attractorsRef: null,
      fieldRef: null,
      fieldBuf: null,
      fieldGrid: "",
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

// ---------------------------------------------------------------------------
// Walkable-area helpers (px space, y-down)
// ---------------------------------------------------------------------------

function isWalkable(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  marginPx: number,
  x: number,
  y: number
): boolean {
  if (x < marginPx || y < marginPx || x > W - marginPx || y > H - marginPx) {
    return false;
  }
  if (!blocked) return true;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return false;
  return blocked[iy * W + ix] === 0;
}

// Centre of the walkable area, used as the default seed when nothing is
// wired into `seeds`. Falls back to the walkable cell closest to the
// canvas centre when the centre itself is masked out (a ring region, say).
function defaultSeed(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  marginPx: number
): [number, number] {
  const cx = W / 2;
  const cy = H / 2;
  if (isWalkable(blocked, W, H, marginPx, cx, cy)) return [cx, cy];
  let best = -1;
  let bestD = Infinity;
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      if (!isWalkable(blocked, W, H, marginPx, ix + 0.5, iy + 0.5)) continue;
      const dx = ix + 0.5 - cx;
      const dy = iy + 0.5 - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = iy * W + ix;
      }
    }
  }
  if (best < 0) return [cx, cy];
  return [(best % W) + 0.5, Math.floor(best / W) + 0.5];
}

// ---------------------------------------------------------------------------
// Space colonization
// ---------------------------------------------------------------------------

// Nearest node to (x,y) within `maxDist`, by expanding Chebyshev rings.
//
// The obvious implementation — one hash cell per influence radius, scan
// the 3x3 — examines EVERY node inside the influence radius, which at
// default settings is ~430 of them, per attractor, per iteration. Ring
// search with early exit examines the handful in the nearest cells and
// stops as soon as no further ring could contain anything closer, since a
// node in ring k+1 is at least k*cell away.
//
// Runs over the INCREMENTAL grid, not a counting-sort hash: growth only
// ever appends nodes, so rebuilding a hash per iteration was pure waste —
// and at a small influence radius the grid has tens of thousands of cells,
// making that rebuild the single dominant cost of the whole mode.
//
// Writes into `out` rather than returning an object: this runs
// attractors × iterations times (millions), and the allocation would
// dominate.
function cellGridNearest(
  grid: CellGrid,
  pos: Float32Array,
  x: number,
  y: number,
  maxDist: number,
  out: { idx: number; d2: number }
): void {
  const { gw, gh, cell, head, next } = grid;
  const cx = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
  const cy = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
  const kMax = Math.ceil(maxDist / cell) + 1;
  let bestD2 = maxDist * maxDist;
  let best = -1;
  for (let k = 0; k <= kMax; k++) {
    if (best >= 0) {
      const reach = (k - 1) * cell;
      if (reach > 0 && reach * reach >= bestD2) break;
    }
    const y0 = cy - k;
    const y1 = cy + k;
    const x0 = cx - k;
    const x1 = cx + k;
    for (let gy = y0; gy <= y1; gy++) {
      if (gy < 0 || gy >= gh) continue;
      const rowBase = gy * gw;
      const onEdgeRow = gy === y0 || gy === y1;
      const from = onEdgeRow ? Math.max(0, x0) : x0;
      const to = onEdgeRow ? Math.min(gw - 1, x1) : x1;
      for (let gx = from; gx <= to; gx++) {
        // Interior rows only touch the two side columns.
        if (!onEdgeRow && gx !== x0 && gx !== x1) {
          gx = x1 - 1;
          continue;
        }
        if (gx < 0 || gx >= gw) continue;
        for (let i = head[rowBase + gx]; i >= 0; i = next[i]) {
          const dx = x - pos[i * 2];
          const dy = y - pos[i * 2 + 1];
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
  }
  out.idx = best;
  out.d2 = bestD2;
}

interface ScParams {
  seed: number;
  attractorCount: number;
  influencePx: number;
  killPx: number;
  stepPx: number;
  tropismX: number;
  tropismY: number;
  tropismStrength: number;
  closed: boolean;
  fusePx: number;
  maxElements: number;
  marginPx: number;
  tipWidth: number;
}

function buildSpaceColonization(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  seedsPx: Float32Array | null,
  attractorsPx: Float32Array | null,
  p: ScParams
): GrowthTrace {
  const rng = mulberry32(p.seed);

  // ---- attractors ----
  let ax: Float32Array;
  let ay: Float32Array;
  let aCount = 0;
  // A wired socket is the answer even when it's empty — an attractor set
  // filtered down to nothing means "grow nothing", not "fall back to a
  // random scatter". Only an UNWIRED socket scatters internally.
  if (attractorsPx) {
    const n = attractorsPx.length >> 1;
    ax = new Float32Array(n);
    ay = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = attractorsPx[i * 2];
      const y = attractorsPx[i * 2 + 1];
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) continue;
      ax[aCount] = x;
      ay[aCount] = y;
      aCount++;
    }
  } else {
    const target = p.attractorCount;
    ax = new Float32Array(target);
    ay = new Float32Array(target);
    const budget = target * SCATTER_TRIES;
    for (let t = 0; t < budget && aCount < target; t++) {
      const x = rng() * W;
      const y = rng() * H;
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) continue;
      ax[aCount] = x;
      ay[aCount] = y;
      aCount++;
    }
  }
  if (aCount === 0) return EMPTY_TRACE;
  // Live attractors occupy [0, aliveCount) of ax/ay; consuming one swaps
  // the last live entry into its slot.
  let aliveCount = aCount;

  // ---- node arrays ----
  const cap = p.maxElements;
  const pos = new Float32Array(cap * 2); // interleaved px
  const parent = new Int32Array(cap);
  const depth = new Int32Array(cap);
  const iter = new Int32Array(cap);
  const heading = new Float32Array(cap);
  const rootOf = new Int32Array(cap);
  let count = 0;

  // Cell noticeably finer than the influence radius, so the ring search
  // has small buckets to walk and can bail after one or two rings.
  const grid = makeCellGrid(W, H, Math.max(1, p.influencePx / 4), cap);
  // Cluster bounding box, maintained incrementally — see the O(1) reject
  // in the attractor loop.
  let bbMinX = Infinity;
  let bbMinY = Infinity;
  let bbMaxX = -Infinity;
  let bbMaxY = -Infinity;

  const addNode = (
    x: number,
    y: number,
    par: number,
    dep: number,
    it: number,
    head: number,
    root: number
  ): void => {
    pos[count * 2] = x;
    pos[count * 2 + 1] = y;
    parent[count] = par;
    depth[count] = dep;
    iter[count] = it;
    heading[count] = head;
    rootOf[count] = root;
    cellGridInsert(grid, count, x, y);
    if (x < bbMinX) bbMinX = x;
    if (x > bbMaxX) bbMaxX = x;
    if (y < bbMinY) bbMinY = y;
    if (y > bbMaxY) bbMaxY = y;
    count++;
  };

  // ---- seeds ----
  // Same wired-means-wired rule as attractors: only an unwired socket
  // falls back to the default centre seed.
  if (seedsPx) {
    const n = seedsPx.length >> 1;
    for (let i = 0; i < n && count < cap; i++) {
      const x = seedsPx[i * 2];
      const y = seedsPx[i * 2 + 1];
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) continue;
      addNode(x, y, -1, 0, 0, 0, count);
    }
  } else {
    const [sx, sy] = defaultSeed(blocked, W, H, p.marginPx);
    addNode(sx, sy, -1, 0, 0, 0, 0);
  }
  if (count === 0) return EMPTY_TRACE;

  // Per-iteration growth accumulators, plus the list of node indices
  // actually influenced this pass (see the loop below).
  const dirX = new Float32Array(cap);
  const dirY = new Float32Array(cap);
  const hasDir = new Uint8Array(cap);
  const touched: number[] = [];

  const killSq = p.killPx * p.killPx;
  const influenceSq = p.influencePx * p.influencePx;
  const near = { idx: -1, d2: 0 };
  const extra: number[] = [];
  const anc: number[] = [];
  let it = 0;
  // Nodes added by the previous iteration — the set a stalled pass reaches
  // from. Starts as the seeds.
  let frontStart = 0;

  while (it < MAX_ITERS && aliveCount > 0 && count < cap) {
    // Only a handful of nodes are influenced in a given pass (~5 of
    // several thousand at default settings), so the pass is driven by a
    // list of those nodes rather than by sweeping every node. Clearing
    // three count-length arrays and scanning all of them per iteration
    // was the dominant cost of this mode — O(count) × O(iterations) of
    // pure bookkeeping.
    touched.length = 0;

    // Each alive attractor influences its single NEAREST node (open
    // venation). Attractors already reached are consumed in the same
    // pass — the nearest-node distance is exactly the kill test.
    // Dead attractors are swap-removed rather than flag-skipped, so the
    // scan shrinks as growth consumes the cloud instead of re-walking
    // corpses every iteration.
    for (let a = 0; a < aliveCount; a++) {
      const px = ax[a];
      const py = ay[a];
      // O(1) reject against the cluster's bounding box. When an attractor
      // has nothing in range the ring search has to walk its entire
      // neighbourhood to prove it — and at a small influence radius that's
      // the COMMON case, which was costing 3.4s where the default costs
      // 46ms. Distance to the box is a sound lower bound on distance to
      // any node, so this skips those searches outright.
      const qx = px < bbMinX ? bbMinX - px : px > bbMaxX ? px - bbMaxX : 0;
      const qy = py < bbMinY ? bbMinY - py : py > bbMaxY ? py - bbMaxY : 0;
      if (qx * qx + qy * qy > influenceSq) continue;
      cellGridNearest(grid, pos, px, py, p.influencePx, near);
      const best = near.idx;
      if (best < 0) continue;
      const bestD = near.d2;
      if (bestD <= killSq) {
        aliveCount--;
        ax[a] = ax[aliveCount];
        ay[a] = ay[aliveCount];
        a--;
        continue;
      }
      const dx = px - pos[best * 2];
      const dy = py - pos[best * 2 + 1];
      const len = Math.sqrt(bestD) || 1;
      if (hasDir[best] === 0) {
        hasDir[best] = 1;
        dirX[best] = 0;
        dirY[best] = 0;
        touched.push(best);
      }
      dirX[best] += dx / len;
      dirY[best] += dy / len;
    }

    // Every influenced node extends by one segment. The frontier moves as
    // a whole, which is what makes the `progress` reveal read as growth
    // rather than as a sequential scribble.
    const gen = count;
    let grew = 0;
    for (let k = 0; k < touched.length && count < cap; k++) {
      const i = touched[k];
      let vx = dirX[i];
      let vy = dirY[i];
      const l = Math.hypot(vx, vy);
      // Attractors pulling in opposite directions cancel — the node has
      // nowhere to go this pass and simply waits.
      if (l < 1e-6) continue;
      vx /= l;
      vy /= l;
      if (p.tropismStrength > 0) {
        vx += p.tropismX * p.tropismStrength;
        vy += p.tropismY * p.tropismStrength;
        const tl = Math.hypot(vx, vy);
        if (tl < 1e-6) continue;
        vx /= tl;
        vy /= tl;
      }
      const nx = pos[i * 2] + vx * p.stepPx;
      const ny = pos[i * 2 + 1] + vy * p.stepPx;
      if (!isWalkable(blocked, W, H, p.marginPx, nx, ny)) continue;
      addNode(nx, ny, i, depth[i] + 1, it + 1, Math.atan2(vy, vx), rootOf[i]);
      grew++;

      // Closed venation (Runions et al.): branches that meet FUSE instead
      // of passing each other, which is what turns a strict tree into the
      // reticulate loop network of a real leaf. The join can't live in the
      // parent array, so it rides `extraEdges` — and that in turn forces
      // `segments` emission, since a root→leaf chain walk can't express a
      // graph.
      if (p.closed) {
        const idx = count - 1;
        // Exclude a deep slice of the node's own lineage. A shallow
        // exclusion re-fuses branches with the limb they just left, and
        // with kill_distance as the radius that ran to ~59% of all nodes:
        // a dense mesh, not a vein network. Loop density is now an
        // explicit param rather than an emergent accident.
        anc.length = 0;
        anc.push(idx);
        let up = i;
        for (let k = 0; k < FUSE_ANCESTOR_SKIP && up >= 0; k++) {
          anc.push(up);
          up = parent[up];
        }
        const mate = cellGridNearestExcept(grid, pos, nx, ny, p.fusePx, anc);
        if (mate >= 0) extra.push(idx, mate);
      }
    }
    // Reset only what was set — the whole point of the touched list.
    for (let k = 0; k < touched.length; k++) hasDir[touched[k]] = 0;

    // Stall: no node had an attractor inside its influence radius, so
    // plain Runions would stop dead with an empty (or stunted) tree — the
    // classic "seed sits outside the attractor cloud" failure, which reads
    // to the user as the node being broken. Bridge it: step the frontier
    // node nearest to the nearest surviving attractor, and keep doing so
    // until growth enters influence range. Tropism is deliberately NOT
    // applied to a bridging step — a strong tropism pointing away from the
    // cloud would otherwise stall the bridge forever.
    let bridged = 0;
    if (grew === 0 && count < cap) {
      let bestNode = -1;
      let bestAttr = -1;
      let bestD = Infinity;
      for (let a = 0; a < aliveCount; a++) {
        for (let i = frontStart; i < gen; i++) {
          const dx = ax[a] - pos[i * 2];
          const dy = ay[a] - pos[i * 2 + 1];
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            bestNode = i;
            bestAttr = a;
          }
        }
      }
      // Having paid for the scan, walk the WHOLE way to that attractor
      // rather than taking one step and rescanning next iteration. A small
      // influence radius otherwise stalls on every pass, and rescanning
      // every attractor against the frontier each time turned a routine
      // setting into a 40x cost cliff (measured: influence_radius 0.02 =
      // 3792ms against 93ms at the default).
      if (bestNode >= 0) {
        const tx = ax[bestAttr];
        const ty = ay[bestAttr];
        let from = bestNode;
        while (count < cap && it + bridged < MAX_ITERS) {
          const dx = tx - pos[from * 2];
          const dy = ty - pos[from * 2 + 1];
          const l = Math.hypot(dx, dy);
          // Close enough that ordinary growth takes over next pass.
          if (l <= p.influencePx) break;
          const vx = dx / l;
          const vy = dy / l;
          const nx = pos[from * 2] + vx * p.stepPx;
          const ny = pos[from * 2 + 1] + vy * p.stepPx;
          if (!isWalkable(blocked, W, H, p.marginPx, nx, ny)) break;
          bridged++;
          addNode(
            nx,
            ny,
            from,
            depth[from] + 1,
            it + bridged,
            Math.atan2(vy, vx),
            rootOf[from]
          );
          from = count - 1;
        }
        grew += bridged;
      }
    }

    if (grew === 0) break;
    if (bridged > 0) {
      // The bridge is a chain; only its tip can usefully reach further.
      frontStart = count - 1;
      it += bridged - 1;
    } else {
      frontStart = gen;
    }
    it++;
  }

  return finalizeTrace(
    pos,
    parent,
    depth,
    iter,
    heading,
    rootOf,
    count,
    Math.max(1, it),
    p.tipWidth,
    extra.length > 0 ? Int32Array.from(extra) : undefined
  );
}

// ---------------------------------------------------------------------------
// DLA — diffusion-limited aggregation (Witten & Sander 1981)
// ---------------------------------------------------------------------------

// Incremental uniform grid. buildSpatialHash is a counting sort — great for
// a population that's rebuilt each pass, useless for DLA where one element
// is appended at a time and a rebuild per particle would be O(n²). This is
// the classic head/next linked-list grid: O(1) insert, O(cell) query.
interface CellGrid {
  head: Int32Array;
  next: Int32Array;
  gw: number;
  gh: number;
  cell: number;
}

function makeCellGrid(W: number, H: number, cell: number, cap: number): CellGrid {
  const c = Math.max(1, cell);
  const gw = Math.max(1, Math.ceil(W / c));
  const gh = Math.max(1, Math.ceil(H / c));
  return {
    head: new Int32Array(gw * gh).fill(-1),
    next: new Int32Array(cap).fill(-1),
    gw,
    gh,
    cell: c,
  };
}

function cellGridInsert(g: CellGrid, i: number, x: number, y: number): void {
  const cx = Math.max(0, Math.min(g.gw - 1, Math.floor(x / g.cell)));
  const cy = Math.max(0, Math.min(g.gh - 1, Math.floor(y / g.cell)));
  const c = cy * g.gw + cx;
  g.next[i] = g.head[c];
  g.head[c] = i;
}

// Chebyshev ring distance (in cells) to the nearest occupied cell, or
// kmax+1 if nothing is within kmax rings.
//
// This is what makes DLA tractable. A single cluster bounding radius is a
// hopeless jump bound for a fractal aggregate — most of the area inside
// that radius is empty fjord, so walkers crawl through vast voids one
// contact-radius at a time. Ring search gives a LOCAL emptiness certificate
// instead, and it's cheap exactly when it matters: near the cluster the
// first ring hits immediately, out in a void the loop runs to kmax and
// buys a huge jump.
function cellGridEmptyRings(
  g: CellGrid,
  x: number,
  y: number,
  kmax: number
): number {
  const cx = Math.floor(x / g.cell);
  const cy = Math.floor(y / g.cell);
  for (let k = 0; k <= kmax; k++) {
    const y0 = cy - k;
    const y1 = cy + k;
    const x0 = cx - k;
    const x1 = cx + k;
    for (let gy = y0; gy <= y1; gy++) {
      if (gy < 0 || gy >= g.gh) continue;
      const row = gy * g.gw;
      if (gy === y0 || gy === y1) {
        // Full row along the top/bottom of the ring.
        const a = Math.max(0, x0);
        const b = Math.min(g.gw - 1, x1);
        for (let gx = a; gx <= b; gx++) {
          if (g.head[row + gx] >= 0) return k;
        }
      } else {
        // Only the two side cells on interior rows.
        if (x0 >= 0 && x0 < g.gw && g.head[row + x0] >= 0) return k;
        if (x1 >= 0 && x1 < g.gw && g.head[row + x1] >= 0) return k;
      }
    }
  }
  return kmax + 1;
}

// First particle a swept step enters, as a fraction along the step.
//
// Landing a walker by projecting it tangent to whatever it happened to be
// nearest is wrong in a packed cluster: the projected spot routinely sits
// inside a THIRD particle. Solving for the earliest ray/disc entry instead
// is both the physically correct contact point and overlap-free by
// construction — the first disc entered along a ray from a clear position
// cannot be reached through another disc.
function cellGridSweep(
  g: CellGrid,
  pos: Float32Array,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  contactSum: number,
  out: { t: number; idx: number }
): boolean {
  const x1 = x0 + dx;
  const y1 = y0 + dy;
  const a = dx * dx + dy * dy;
  out.idx = -1;
  out.t = Infinity;
  if (a <= 0) return false;
  // Cells touched by the swept segment plus its contact halo. The step is
  // one contact radius and the cell is two, so a 3x3 around each endpoint
  // covers it.
  const cx0 = Math.floor(Math.min(x0, x1) / g.cell) - 1;
  const cx1 = Math.floor(Math.max(x0, x1) / g.cell) + 1;
  const cy0 = Math.floor(Math.min(y0, y1) / g.cell) - 1;
  const cy1 = Math.floor(Math.max(y0, y1) / g.cell) + 1;
  const r2 = contactSum * contactSum;
  for (let gy = Math.max(0, cy0); gy <= Math.min(g.gh - 1, cy1); gy++) {
    const row = gy * g.gw;
    for (let gx = Math.max(0, cx0); gx <= Math.min(g.gw - 1, cx1); gx++) {
      for (let i = g.head[row + gx]; i >= 0; i = g.next[i]) {
        const ex = x0 - pos[i * 2];
        const ey = y0 - pos[i * 2 + 1];
        const c = ex * ex + ey * ey - r2;
        const b = 2 * (ex * dx + ey * dy);
        if (c <= 0) {
          // Already touching — shouldn't happen, but land here rather
          // than tunnel through.
          out.t = 0;
          out.idx = i;
          return true;
        }
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t >= 0 && t <= 1 && t < out.t) {
          out.t = t;
          out.idx = i;
        }
      }
    }
  }
  return out.idx >= 0;
}

// Walkable pixels that touch a non-walkable one — the silhouette edge that
// `seed_shape: region_edge` seeds along (frost creeping off a shape; with
// no region wired, off the margin frame).
function edgeSeeds(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  marginPx: number,
  want: number
): Float32Array {
  const found: number[] = [];
  const stride = Math.max(1, Math.floor(Math.min(W, H) / 512));
  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {
      if (!isWalkable(blocked, W, H, marginPx, x + 0.5, y + 0.5)) continue;
      if (
        !isWalkable(blocked, W, H, marginPx, x + 0.5 - stride, y + 0.5) ||
        !isWalkable(blocked, W, H, marginPx, x + 0.5 + stride, y + 0.5) ||
        !isWalkable(blocked, W, H, marginPx, x + 0.5, y + 0.5 - stride) ||
        !isWalkable(blocked, W, H, marginPx, x + 0.5, y + 0.5 + stride)
      ) {
        found.push(x + 0.5, y + 0.5);
      }
    }
  }
  const total = found.length >> 1;
  if (total === 0) return new Float32Array(0);
  const n = Math.min(want, total);
  const out = new Float32Array(n * 2);
  // Even stride pick — deterministic and spatially spread, unlike a
  // random subsample which clumps.
  for (let i = 0; i < n; i++) {
    const src = Math.floor((i * total) / n);
    out[i * 2] = found[src * 2];
    out[i * 2 + 1] = found[src * 2 + 1];
  }
  return out;
}

interface DlaParams {
  seed: number;
  particles: number;
  stickProb: number;
  contactPx: number;
  driftX: number;
  driftY: number;
  driftStrength: number;
  seedShape: string;
  edgeSeedCount: number;
  maxElements: number;
  marginPx: number;
  tipWidth: number;
}

const MAX_WALK_STEPS = 20000;
// Ring-search depth for the free-space jump certificate. Deep enough to
// clear a big void in one hop, shallow enough that the scan stays cheap.
const RING_KMAX = 16;
// Consecutive particles that stick nothing before the cluster is declared
// saturated and the run stops.
const DLA_FAIL_RUN = 256;
// Surface bounces one particle may take before being abandoned.
const DLA_MAX_BOUNCES = 512;

function buildDla(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  seedsPx: Float32Array | null,
  p: DlaParams
): GrowthTrace {
  const rng = mulberry32(p.seed);
  const cap = p.maxElements;
  const pos = new Float32Array(cap * 2);
  const parent = new Int32Array(cap);
  const depth = new Int32Array(cap);
  const iter = new Int32Array(cap);
  const heading = new Float32Array(cap);
  const rootOf = new Int32Array(cap);
  let count = 0;

  const contact = p.contactPx;
  const grid = makeCellGrid(W, H, contact * 2, cap);

  const addNode = (
    x: number,
    y: number,
    par: number,
    dep: number,
    head: number,
    root: number
  ): void => {
    pos[count * 2] = x;
    pos[count * 2 + 1] = y;
    parent[count] = par;
    depth[count] = dep;
    iter[count] = count; // DLA accretes one particle at a time
    heading[count] = head;
    rootOf[count] = root;
    cellGridInsert(grid, count, x, y);
    count++;
  };

  // ---- seeds ----
  let seedSet = seedsPx;
  if (!seedSet && p.seedShape === "region_edge") {
    seedSet = edgeSeeds(blocked, W, H, p.marginPx, p.edgeSeedCount);
  }
  if (seedSet) {
    const n = seedSet.length >> 1;
    for (let i = 0; i < n && count < cap; i++) {
      const x = seedSet[i * 2];
      const y = seedSet[i * 2 + 1];
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) continue;
      addNode(x, y, -1, 0, 0, count);
    }
  } else {
    const [sx, sy] = defaultSeed(blocked, W, H, p.marginPx);
    addNode(sx, sy, -1, 0, 0, 0);
  }
  if (count === 0) return EMPTY_TRACE;

  // Fixed launch centre. Keeping it fixed (rather than tracking the moving
  // centroid) keeps the free-space jump bound conservative and therefore
  // correct — a walker can never tunnel through the cluster.
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i++) {
    cx += pos[i * 2];
    cy += pos[i * 2 + 1];
  }
  cx /= count;
  cy /= count;
  let rMax = 0;
  for (let i = 0; i < count; i++) {
    rMax = Math.max(rMax, Math.hypot(pos[i * 2] - cx, pos[i * 2 + 1] - cy));
  }

  const TAU = Math.PI * 2;
  const sweep = { t: 0, idx: -1 };
  // Saturation guard. Once the cluster can't grow — it fills the region,
  // or the region is small and the spawn ring mostly sits outside it —
  // every further particle is a full-length walk that sticks nothing.
  // Without this, raising `particles` costs linearly and returns nothing
  // (measured: 40k particles inside a masked region = 589ms for 2 extra
  // elements). Space Fill's jam-run guard, same idea.
  let sinceStick = 0;
  for (let particle = 0; particle < p.particles && count < cap; particle++) {
    if (sinceStick >= DLA_FAIL_RUN) break;
    sinceStick++;
    let bounces = 0;
    const rSpawn = rMax + contact * 5;
    const rKill = rSpawn * 3 + contact * 20;
    const a0 = rng() * TAU;
    let wx = cx + Math.cos(a0) * rSpawn;
    let wy = cy + Math.sin(a0) * rSpawn;

    for (let step = 0; step < MAX_WALK_STEPS; step++) {
      const d = Math.hypot(wx - cx, wy - cy);
      if (d > rKill) {
        // Re-inject on the spawn ring rather than discarding. A 2D walk
        // escapes often, so killing wastes most of the particle budget —
        // at r_kill >> r_spawn the return angle is near-uniform anyway,
        // which is the standard first-passage approximation.
        const ra = rng() * TAU;
        wx = cx + Math.cos(ra) * rSpawn;
        wy = cy + Math.sin(ra) * rSpawn;
        continue;
      }

      // How far can the walker move without any chance of contact?
      // Global bound first (cheap, dominates the far field), then the
      // local ring certificate for the fjords inside the bounding radius.
      let safe = d - rMax - contact * 2;
      if (safe < contact) {
        const rings = cellGridEmptyRings(grid, wx, wy, RING_KMAX);
        safe = Math.max(safe, (rings - 1) * grid.cell - contact * 2);
      }
      if (safe > contact) {
        const a = rng() * TAU;
        wx += Math.cos(a) * safe;
        wy += Math.sin(a) * safe;
        continue;
      }

      const a = rng() * TAU;
      let dx = Math.cos(a);
      let dy = Math.sin(a);
      if (p.driftStrength > 0) {
        dx += p.driftX * p.driftStrength;
        dy += p.driftY * p.driftStrength;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
      }
      dx *= contact;
      dy *= contact;

      if (!cellGridSweep(grid, pos, wx, wy, dx, dy, contact * 2, sweep)) {
        wx += dx;
        wy += dy;
        continue;
      }

      // Contact point: exactly one contact-distance from what it hit.
      const hit = sweep.idx;
      const hx = pos[hit * 2];
      const hy = pos[hit * 2 + 1];
      const nx = wx + dx * sweep.t;
      const ny = wy + dy * sweep.t;

      // A sub-1 stick probability lets walkers probe deeper into fjords
      // before committing, which densifies the cluster. A bounce resumes
      // from the contact point nudged clear, so the walker keeps skimming
      // the surface instead of re-hitting the same particle forever.
      // A landing outside the growable region abandons the particle. It's
      // tempting to bounce instead, but measurement says otherwise: with a
      // masked region the cluster saturates against the boundary, so
      // bouncing just burns the full step budget on a walker that will
      // never find room (73ms → 877ms) and yields FEWER elements. Cheap
      // failure plus the saturation guard is strictly better.
      if (!isWalkable(blocked, W, H, p.marginPx, nx, ny)) break;

      // A sub-1 stick probability lets walkers probe deeper into fjords
      // before committing, which densifies the cluster. Bounces are capped
      // so a walker wedged in a dead end can't monopolise the budget.
      if (p.stickProb < 1 && rng() >= p.stickProb) {
        if (++bounces > DLA_MAX_BOUNCES) break;
        const ox = (nx - hx) / (contact * 2);
        const oy = (ny - hy) / (contact * 2);
        wx = nx + ox * contact * 0.05;
        wy = ny + oy * contact * 0.05;
        continue;
      }

      sinceStick = 0;
      addNode(
        nx,
        ny,
        hit,
        depth[hit] + 1,
        Math.atan2(ny - hy, nx - hx),
        rootOf[hit]
      );
      rMax = Math.max(rMax, Math.hypot(nx - cx, ny - cy));
      break;
    }
  }

  return finalizeTrace(
    pos,
    parent,
    depth,
    iter,
    heading,
    rootOf,
    count,
    Math.max(1, count - 1),
    p.tipWidth
  );
}

// ---------------------------------------------------------------------------
// Percolation — invasion (lowest resistance) / Eden (uniform random)
// ---------------------------------------------------------------------------

// Flat binary min-heap. Preallocated to one slot per cell because the
// `inFrontier` flag guarantees each cell is pushed exactly once.
class MinHeap {
  private keys: Float32Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float32Array(Math.max(1, cap));
    this.vals = new Int32Array(Math.max(1, cap));
  }
  push(k: number, v: number): void {
    const { keys, vals } = this;
    let i = this.size++;
    keys[i] = k;
    vals[i] = v;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (keys[par] <= keys[i]) break;
      const tk = keys[par];
      const tv = vals[par];
      keys[par] = keys[i];
      vals[par] = vals[i];
      keys[i] = tk;
      vals[i] = tv;
      i = par;
    }
  }
  pop(): number {
    if (this.size === 0) return -1;
    const { keys, vals } = this;
    const top = vals[0];
    this.size--;
    if (this.size > 0) {
      keys[0] = keys[this.size];
      vals[0] = vals[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && keys[l] < keys[m]) m = l;
        if (r < this.size && keys[r] < keys[m]) m = r;
        if (m === i) break;
        const tk = keys[m];
        const tv = vals[m];
        keys[m] = keys[i];
        vals[m] = vals[i];
        keys[i] = tk;
        vals[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

// Deterministic per-cell hash in [0,1) — the resistance noise when no
// field is wired, and the tie-break blend when one is.
function hash01(seed: number, n: number): number {
  let h = (n ^ (seed * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

interface PercParams {
  seed: number;
  variant: string;
  gridW: number;
  contrast: number;
  maxElements: number;
  marginPx: number;
  tipWidth: number;
}

function buildPercolation(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  seedsPx: Float32Array | null,
  field: Float32Array | null,
  p: PercParams
): GrowthTrace {
  const gw = Math.max(4, Math.round(p.gridW));
  const gh = Math.max(4, Math.round((gw * H) / W));
  const cells = gw * gh;
  const cw = W / gw;
  const ch = H / gh;

  // 0 free, 1 taken, 2 blocked.
  const state = new Uint8Array(cells);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const x = (cx + 0.5) * cw;
      const y = (cy + 0.5) * ch;
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) {
        state[cy * gw + cx] = 2;
      }
    }
  }

  // Low cost grows first, so a BRIGHT field resists and a dark one invites:
  // growth eats through the dark parts of an image and stalls at the light.
  const cost = new Float32Array(cells);
  for (let c = 0; c < cells; c++) {
    const noise = hash01(p.seed, c);
    cost[c] = field ? noise + (field[c] - noise) * p.contrast : noise;
  }

  const cap = p.maxElements;
  const pos = new Float32Array(cap * 2);
  const parent = new Int32Array(cap);
  const depth = new Int32Array(cap);
  const iter = new Int32Array(cap);
  const heading = new Float32Array(cap);
  const rootOf = new Int32Array(cap);
  let count = 0;

  const addCell = (c: number, par: number, root: number): number => {
    const cx = c % gw;
    const cy = (c / gw) | 0;
    const x = (cx + 0.5) * cw;
    const y = (cy + 0.5) * ch;
    pos[count * 2] = x;
    pos[count * 2 + 1] = y;
    parent[count] = par;
    depth[count] = par >= 0 ? depth[par] + 1 : 0;
    iter[count] = count; // percolation takes one cell at a time
    heading[count] =
      par >= 0 ? Math.atan2(y - pos[par * 2 + 1], x - pos[par * 2]) : 0;
    rootOf[count] = root;
    state[c] = 1;
    return count++;
  };

  const inFrontier = new Uint8Array(cells);
  const pendingParent = new Int32Array(cells).fill(-1);
  const heap = new MinHeap(cells);
  const bag: number[] = [];
  const eden = p.variant === "eden";
  const rng = mulberry32(p.seed ^ 0x5eed);

  const pushNeighbours = (c: number, elem: number): void => {
    const cx = c % gw;
    const cy = (c / gw) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = cy + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const nc = ny * gw + nx;
      if (state[nc] !== 0 || inFrontier[nc]) continue;
      inFrontier[nc] = 1;
      pendingParent[nc] = elem;
      if (eden) bag.push(nc);
      else heap.push(cost[nc], nc);
    }
  };

  // ---- seeds ----
  if (seedsPx) {
    const n = seedsPx.length >> 1;
    for (let i = 0; i < n && count < cap; i++) {
      const cx = Math.floor(seedsPx[i * 2] / cw);
      const cy = Math.floor(seedsPx[i * 2 + 1] / ch);
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
      const c = cy * gw + cx;
      if (state[c] !== 0) continue;
      pushNeighbours(c, addCell(c, -1, count));
    }
  } else {
    const [sx, sy] = defaultSeed(blocked, W, H, p.marginPx);
    const cx = Math.max(0, Math.min(gw - 1, Math.floor(sx / cw)));
    const cy = Math.max(0, Math.min(gh - 1, Math.floor(sy / ch)));
    const c = cy * gw + cx;
    if (state[c] === 0) pushNeighbours(c, addCell(c, -1, 0));
  }
  if (count === 0) return EMPTY_TRACE;

  while (count < cap) {
    let c = -1;
    if (eden) {
      // Eden growth needs a UNIFORM pick from the live frontier, which a
      // keyed heap can't give (that would be invasion percolation on a
      // random field). Swap-remove from a bag is O(1) and unbiased.
      if (bag.length === 0) break;
      const k = Math.floor(rng() * bag.length);
      c = bag[k];
      bag[k] = bag[bag.length - 1];
      bag.pop();
    } else {
      c = heap.pop();
      if (c < 0) break;
    }
    if (state[c] !== 0) continue;
    const par = pendingParent[c];
    pushNeighbours(c, addCell(c, par, par >= 0 ? rootOf[par] : 0));
  }

  return finalizeTrace(
    pos,
    parent,
    depth,
    iter,
    heading,
    rootOf,
    count,
    Math.max(1, count - 1),
    p.tipWidth
  );
}

// ---------------------------------------------------------------------------
// Laplacian growth / DBM (Niemeyer, Pietronero & Wiesmann 1984)
// ---------------------------------------------------------------------------

interface LapParams {
  seed: number;
  gridW: number;
  eta: number;
  relaxIters: number;
  bias: number;
  maxElements: number;
  marginPx: number;
  tipWidth: number;
}

// Successive over-relaxation factor. ~1.8 is the usual sweet spot for a
// Laplace solve on a uniform grid.
const SOR_OMEGA = 1.8;
// Radius (cells) of the local re-solve after each growth step, and how
// often a full-domain pass runs to keep the far field honest.
const LAP_LOCAL_R = 12;
const LAP_GLOBAL_EVERY = 32;

function buildLaplacian(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  seedsPx: Float32Array | null,
  field: Float32Array | null,
  p: LapParams
): GrowthTrace {
  const gw = Math.max(8, Math.round(p.gridW));
  const gh = Math.max(8, Math.round((gw * H) / W));
  const cells = gw * gh;
  const cw = W / gw;
  const ch = H / gh;
  const rng = mulberry32(p.seed);

  // 1 = part of the discharge (a conductor held at potential 0).
  const solid = new Uint8Array(cells);
  // 1 = outside the growable region; still solved through, never grown into.
  const noGrow = new Uint8Array(cells);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      if (!isWalkable(blocked, W, H, p.marginPx, (cx + 0.5) * cw, (cy + 0.5) * ch)) {
        noGrow[cy * gw + cx] = 1;
      }
    }
  }

  // phi = 1 far away, 0 on the discharge. The grid border is the outer
  // electrode and stays pinned at 1.
  const phi = new Float32Array(cells).fill(1);

  const cap = p.maxElements;
  const pos = new Float32Array(cap * 2);
  const parent = new Int32Array(cap);
  const depth = new Int32Array(cap);
  const iter = new Int32Array(cap);
  const heading = new Float32Array(cap);
  const rootOf = new Int32Array(cap);
  let count = 0;

  let bbMinX = gw;
  let bbMaxX = -1;
  let bbMinY = gh;
  let bbMaxY = -1;

  const addCell = (c: number, par: number, root: number): number => {
    const cx = c % gw;
    const cy = (c / gw) | 0;
    const x = (cx + 0.5) * cw;
    const y = (cy + 0.5) * ch;
    pos[count * 2] = x;
    pos[count * 2 + 1] = y;
    parent[count] = par;
    depth[count] = par >= 0 ? depth[par] + 1 : 0;
    iter[count] = count;
    heading[count] =
      par >= 0 ? Math.atan2(y - pos[par * 2 + 1], x - pos[par * 2]) : 0;
    rootOf[count] = root;
    solid[c] = 1;
    phi[c] = 0;
    if (cx < bbMinX) bbMinX = cx;
    if (cx > bbMaxX) bbMaxX = cx;
    if (cy < bbMinY) bbMinY = cy;
    if (cy > bbMaxY) bbMaxY = cy;
    return count++;
  };

  // Candidate sites: free cells 4-adjacent to the discharge.
  const cand: number[] = [];
  const inCand = new Uint8Array(cells);
  const candParent = new Int32Array(cells).fill(-1);
  const pushNeighbours = (c: number, elem: number): void => {
    const cx = c % gw;
    const cy = (c / gw) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = cy + (k === 2 ? -1 : k === 3 ? 1 : 0);
      // Never grow onto the border — it's the outer electrode.
      if (nx < 1 || ny < 1 || nx >= gw - 1 || ny >= gh - 1) continue;
      const nc = ny * gw + nx;
      if (solid[nc] || noGrow[nc] || inCand[nc]) continue;
      inCand[nc] = 1;
      candParent[nc] = elem;
      cand.push(nc);
    }
  };

  // ---- seeds ----
  if (seedsPx) {
    const n = seedsPx.length >> 1;
    for (let i = 0; i < n && count < cap; i++) {
      const cx = Math.floor(seedsPx[i * 2] / cw);
      const cy = Math.floor(seedsPx[i * 2 + 1] / ch);
      if (cx < 1 || cy < 1 || cx >= gw - 1 || cy >= gh - 1) continue;
      const c = cy * gw + cx;
      if (solid[c] || noGrow[c]) continue;
      pushNeighbours(c, addCell(c, -1, count));
    }
  } else {
    const [sx, sy] = defaultSeed(blocked, W, H, p.marginPx);
    const cx = Math.max(1, Math.min(gw - 2, Math.floor(sx / cw)));
    const cy = Math.max(1, Math.min(gh - 2, Math.floor(sy / ch)));
    const c = cy * gw + cx;
    if (!noGrow[c]) pushNeighbours(c, addCell(c, -1, 0));
  }
  if (count === 0) return EMPTY_TRACE;

  // Solve domain padding around the discharge. The far field barely moves,
  // so relaxing only near the front — rather than over the whole grid —
  // keeps early growth cheap without changing the picture.
  const pad = Math.max(8, Math.round(Math.min(gw, gh) / 6));
  const weights: number[] = [];

  // SOR over an axis-aligned block, skipping conductor cells.
  const relax = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    iters: number
  ): void => {
    const ax0 = Math.max(1, x0);
    const ax1 = Math.min(gw - 2, x1);
    const ay0 = Math.max(1, y0);
    const ay1 = Math.min(gh - 2, y1);
    for (let s = 0; s < iters; s++) {
      for (let cy = ay0; cy <= ay1; cy++) {
        const row = cy * gw;
        for (let cx = ax0; cx <= ax1; cx++) {
          const c = row + cx;
          if (solid[c]) continue;
          const avg =
            (phi[c - 1] + phi[c + 1] + phi[c - gw] + phi[c + gw]) * 0.25;
          phi[c] += SOR_OMEGA * (avg - phi[c]);
        }
      }
    }
  };
  const relaxGlobal = (iters: number): void =>
    relax(bbMinX - pad, bbMaxX + pad, bbMinY - pad, bbMaxY + pad, iters);

  // Integer exponents via repeated multiplication — Math.pow across every
  // candidate on every step is otherwise a top-3 cost here.
  const etaInt = Math.abs(p.eta - Math.round(p.eta)) < 1e-6 ? Math.round(p.eta) : -1;

  // The field has to be converged before the FIRST pick, or the opening
  // moves are made against phi = 1 everywhere and the structure never
  // recovers its character.
  relaxGlobal(p.relaxIters * 8);
  let sinceGlobal = 0;

  while (count < cap && cand.length > 0) {
    // ---- pick a growth site, p ∝ phi^eta ----
    // eta is the whole point of this mode: 0 gives every candidate equal
    // odds (compact Eden blob), 1 approximates DLA (coral), and large eta
    // lets only the most exposed tip grow (lightning).
    let total = 0;
    weights.length = cand.length;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      let v = phi[c];
      if (v < 0) v = 0;
      let w: number;
      if (etaInt === 1) w = v;
      else if (etaInt === 0) w = 1;
      else if (etaInt === 2) w = v * v;
      else if (etaInt === 3) w = v * v * v;
      else if (etaInt === 4) {
        const v2 = v * v;
        w = v2 * v2;
      } else w = Math.pow(v, p.eta);
      if (field && p.bias > 0) w *= 1 + p.bias * field[c] * 8;
      if (!Number.isFinite(w) || w < 0) w = 0;
      weights[i] = w;
      total += w;
    }
    let pick = -1;
    if (total > 0) {
      let r = rng() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      if (pick < 0) pick = weights.length - 1;
    } else {
      // Fully screened front (or eta so high everything underflowed) —
      // fall back to a uniform draw so growth doesn't deadlock.
      pick = Math.floor(rng() * cand.length);
    }

    const c = cand[pick];
    cand[pick] = cand[cand.length - 1];
    cand.pop();
    inCand[c] = 0;
    if (solid[c] || noGrow[c]) continue;
    const par = candParent[c];
    pushNeighbours(c, addCell(c, par, par >= 0 ? rootOf[par] : 0));

    // Re-converge LOCALLY. Grounding one more cell perturbs the potential
    // mostly in its own neighbourhood, so re-relaxing the whole domain
    // every step — which is what the textbook description implies — spends
    // ~all of its time re-deriving a far field that barely moved. A
    // periodic global pass keeps that far field honest.
    // Measured at grid 256 / 5000 elements: 7190ms → ~90ms.
    const ncx = c % gw;
    const ncy = (c / gw) | 0;
    relax(
      ncx - LAP_LOCAL_R,
      ncx + LAP_LOCAL_R,
      ncy - LAP_LOCAL_R,
      ncy + LAP_LOCAL_R,
      p.relaxIters
    );
    if (++sinceGlobal >= LAP_GLOBAL_EVERY) {
      relaxGlobal(p.relaxIters);
      sinceGlobal = 0;
    }
  }

  return finalizeTrace(
    pos,
    parent,
    depth,
    iter,
    heading,
    rootOf,
    count,
    Math.max(1, count - 1),
    p.tipWidth
  );
}

// ---------------------------------------------------------------------------
// Tip networks — crack (T-termination) and hyphal (anastomosis)
// ---------------------------------------------------------------------------

// Nearest element within `radius`, ignoring a short exclusion list.
//
// A propagating tip is always within a step of its own last few elements,
// so an unfiltered proximity test fires instantly on its own tail and
// every tip dies at birth. The exclusion list is the tip's own recent
// ancestry.
function cellGridNearestExcept(
  grid: CellGrid,
  pos: Float32Array,
  x: number,
  y: number,
  radius: number,
  except: number[]
): number {
  const { gw, gh, cell, head, next } = grid;
  const cx = Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
  const cy = Math.max(0, Math.min(gh - 1, Math.floor(y / cell)));
  let best = -1;
  let bestD = radius * radius;
  for (let oy = -1; oy <= 1; oy++) {
    const gy = cy + oy;
    if (gy < 0 || gy >= gh) continue;
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      if (gx < 0 || gx >= gw) continue;
      for (let i = head[gy * gw + gx]; i >= 0; i = next[i]) {
        let skip = false;
        for (let k = 0; k < except.length; k++) {
          if (except[k] === i) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
        const dx = x - pos[i * 2];
        const dy = y - pos[i * 2 + 1];
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) {
          bestD = d2;
          best = i;
        }
      }
    }
  }
  return best;
}

// Central-difference gradient of a field sampled in normalized UV.
function fieldGradient(
  field: Float32Array,
  fw: number,
  fh: number,
  u: number,
  v: number,
  out: { x: number; y: number }
): void {
  const cx = Math.max(1, Math.min(fw - 2, Math.round(u * (fw - 1))));
  const cy = Math.max(1, Math.min(fh - 2, Math.round(v * (fh - 1))));
  const c = cy * fw + cx;
  out.x = (field[c + 1] - field[c - 1]) * 0.5;
  out.y = (field[c + fw] - field[c - fw]) * 0.5;
}

interface TipParams {
  seed: number;
  variant: string;
  tipCount: number;
  stepPx: number;
  branchRate: number;
  branchAngle: number;
  wander: number;
  fieldStrength: number;
  hitPx: number;
  maxElements: number;
  marginPx: number;
  tipWidth: number;
}

// How many of a tip's own trailing elements it ignores for contact.
const TIP_SELF_SKIP = 6;

function countRootsOf(parent: Int32Array, count: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) if (parent[i] < 0) n++;
  return n;
}

interface Tip {
  node: number;
  heading: number;
  recent: number[];
}

function buildTipNetwork(
  blocked: Uint8Array | null,
  W: number,
  H: number,
  seedsPx: Float32Array | null,
  field: Float32Array | null,
  fw: number,
  fh: number,
  p: TipParams
): GrowthTrace {
  const rng = mulberry32(p.seed);
  const cap = p.maxElements;
  const pos = new Float32Array(cap * 2);
  const parent = new Int32Array(cap);
  const depth = new Int32Array(cap);
  const iter = new Int32Array(cap);
  const heading = new Float32Array(cap);
  const rootOf = new Int32Array(cap);
  let count = 0;
  const extra: number[] = [];
  const grid = makeCellGrid(W, H, Math.max(1, p.hitPx * 2), cap);

  const addNode = (
    x: number,
    y: number,
    par: number,
    dep: number,
    it: number,
    head: number,
    root: number
  ): number => {
    pos[count * 2] = x;
    pos[count * 2 + 1] = y;
    parent[count] = par;
    depth[count] = dep;
    iter[count] = it;
    heading[count] = head;
    rootOf[count] = root;
    cellGridInsert(grid, count, x, y);
    return count++;
  };

  const TAU = Math.PI * 2;
  let tips: Tip[] = [];

  // ---- seeding: this is the real structural difference between the two
  // variants. Cracks NUCLEATE — scattered origins, each propagating both
  // ways, so the pattern is a set of independent fractures that later
  // T-into each other. Hyphae RADIATE from their seeds as one connected
  // organism.
  // ONE node per origin, N tips attached to it. Minting a node per tip
  // instead stacks coincident roots at the same position — which for the
  // radial hyphal seeding means every tip immediately "contacts" one of
  // its 29 co-located siblings and fuses on its first step.
  const startOrigin = (x: number, y: number, headings: number[]): void => {
    const idx = addNode(x, y, -1, 0, 0, headings[0], count);
    for (let k = 0; k < headings.length; k++) {
      tips.push({ node: idx, heading: headings[k], recent: [idx] });
    }
  };
  const radial = (n: number, base: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(base + (i / n) * TAU);
    return out;
  };
  if (seedsPx) {
    const n = seedsPx.length >> 1;
    const per = Math.max(1, Math.round(p.tipCount / Math.max(1, n)));
    for (let i = 0; i < n && count < cap; i++) {
      const x = seedsPx[i * 2];
      const y = seedsPx[i * 2 + 1];
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) continue;
      const h = rng() * TAU;
      startOrigin(
        x,
        y,
        p.variant === "crack" ? [h, h + Math.PI] : radial(per, h)
      );
    }
  } else if (p.variant === "crack") {
    const budget = p.tipCount * SCATTER_TRIES;
    let placed = 0;
    for (let t = 0; t < budget && placed < p.tipCount && count < cap; t++) {
      const x = rng() * W;
      const y = rng() * H;
      if (!isWalkable(blocked, W, H, p.marginPx, x, y)) continue;
      const h = rng() * TAU;
      startOrigin(x, y, [h, h + Math.PI]);
      placed++;
    }
  } else {
    const [sx, sy] = defaultSeed(blocked, W, H, p.marginPx);
    startOrigin(sx, sy, radial(p.tipCount, rng() * TAU));
  }
  if (count === 0) return EMPTY_TRACE;

  // Tips leaving a shared origin radially are closer to each other than
  // the contact radius until they have travelled far enough to fan apart:
  // at radius r, n tips sit 2*pi*r/n apart, so they interfere while
  // r < n*hit/(2*pi). Contact testing is suppressed below that depth —
  // otherwise every hyphal tip fuses with a sibling on its first step and
  // the mode produces a stub instead of a network.
  const perOrigin = Math.max(1, Math.round(tips.length / Math.max(1, countRootsOf(parent, count))));
  const graceDepth = Math.min(
    32,
    Math.ceil((perOrigin * p.hitPx) / (Math.PI * 2 * p.stepPx)) + 1
  );

  const grad = { x: 0, y: 0 };
  let it = 0;
  while (tips.length > 0 && count < cap && it < MAX_ITERS) {
    const next: Tip[] = [];
    for (let ti = 0; ti < tips.length && count < cap; ti++) {
      const tip = tips[ti];
      let h = tip.heading + (rng() - 0.5) * p.wander;
      if (field && p.fieldStrength > 0) {
        fieldGradient(
          field,
          fw,
          fh,
          pos[tip.node * 2] / W,
          pos[tip.node * 2 + 1] / H,
          grad
        );
        const gl = Math.hypot(grad.x, grad.y);
        if (gl > 1e-6) {
          // Steer toward the gradient by the shortest angular route.
          const target = Math.atan2(grad.y / gl, grad.x / gl);
          let diff = target - h;
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          h += diff * p.fieldStrength;
        }
      }
      const nx = pos[tip.node * 2] + Math.cos(h) * p.stepPx;
      const ny = pos[tip.node * 2 + 1] + Math.sin(h) * p.stepPx;
      if (!isWalkable(blocked, W, H, p.marginPx, nx, ny)) continue; // tip dies

      const hit =
        depth[tip.node] < graceDepth
          ? -1
          : cellGridNearestExcept(grid, pos, nx, ny, p.hitPx, tip.recent);
      const idx = addNode(
        nx,
        ny,
        tip.node,
        depth[tip.node] + 1,
        it + 1,
        h,
        rootOf[tip.node]
      );
      if (hit >= 0) {
        // Contact ENDS the tip and records a non-tree edge: a crack
        // T-ing into an older crack, or two hyphae fusing. This is the
        // whole reason these modes carry `extraEdges` — the structure is
        // a network, and a parent array cannot express the join.
        extra.push(idx, hit);
        continue;
      }

      tip.node = idx;
      tip.heading = h;
      tip.recent.push(idx);
      if (tip.recent.length > TIP_SELF_SKIP) tip.recent.shift();
      next.push(tip);

      if (rng() < p.branchRate && count < cap) {
        const bh = h + (rng() < 0.5 ? -1 : 1) * p.branchAngle;
        next.push({ node: idx, heading: bh, recent: tip.recent.slice() });
      }
    }
    tips = next;
    it++;
  }

  return finalizeTrace(
    pos,
    parent,
    depth,
    iter,
    heading,
    rootOf,
    count,
    Math.max(1, it),
    p.tipWidth,
    extra.length > 0 ? Int32Array.from(extra) : undefined
  );
}

// ---------------------------------------------------------------------------
// Shared trace finalization
// ---------------------------------------------------------------------------

function finalizeTrace(
  pos: Float32Array,
  parent: Int32Array,
  depth: Int32Array,
  iter: Int32Array,
  heading: Float32Array,
  rootOf: Int32Array,
  count: number,
  iters: number,
  tipWidth: number,
  extraEdges?: Int32Array
): GrowthTrace {
  if (count === 0) return EMPTY_TRACE;
  const parentT = parent.slice(0, count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = pos[i * 2];
    y[i] = pos[i * 2 + 1];
  }
  const iterT = iter.slice(0, count);
  const birth = new Float32Array(count);
  for (let i = 0; i < count; i++) birth[i] = iterT[i] / iters;
  return {
    count,
    x,
    y,
    parent: parentT,
    depth: depth.slice(0, count),
    iter: iterT,
    birth,
    width: computeDaVinciWidths(parentT, count, tipWidth),
    heading: heading.slice(0, count),
    root: rootOf.slice(0, count),
    branch: computeBranchIds(parentT, count),
    iters,
    extraEdges,
  };
}

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

// Normalized [0,1]² points → interleaved px. Null means the socket is
// UNWIRED; a wired-but-empty input returns a zero-length array, which the
// trace builder treats as a real (empty) answer rather than falling back
// to its internal default.
function pointsToPx(
  v: unknown,
  W: number,
  H: number
): Float32Array | null {
  const pv = v as PointsValue | undefined;
  if (!pv || pv.kind !== "points") return null;
  const out = new Float32Array(pv.count * 2);
  for (let i = 0; i < pv.count; i++) {
    out[i * 2] = pv.positions[i * 2] * W;
    out[i * 2 + 1] = pv.positions[i * 2 + 1] * H;
  }
  return out;
}

// Mode-dependent socket sets. `seeds`, `region` and `obstacles` are
// universal; the rest only appear where they mean something.
const SEEDS: InputSocketDef = {
  name: "seeds",
  label: "Seeds",
  type: "points",
  required: false,
};
const REGION: InputSocketDef = {
  name: "region",
  label: "Region",
  type: "mask",
  required: false,
};
const OBSTACLES: InputSocketDef = {
  name: "obstacles",
  label: "Obstacles",
  type: "mask",
  required: false,
};
const SOCKETS: Record<string, InputSocketDef[]> = {
  space_colonization: [
    SEEDS,
    { name: "attractors", label: "Attractors", type: "points", required: false },
    REGION,
    OBSTACLES,
  ],
  dla: [SEEDS, REGION, OBSTACLES],
  percolation: [
    SEEDS,
    REGION,
    OBSTACLES,
    { name: "field", label: "Resistance", type: "mask", required: false },
  ],
  laplacian: [
    SEEDS,
    REGION,
    OBSTACLES,
    { name: "field", label: "Attractor", type: "mask", required: false },
  ],
  crack: [
    SEEDS,
    REGION,
    OBSTACLES,
    { name: "field", label: "Stress", type: "mask", required: false },
  ],
  hyphal: [
    SEEDS,
    REGION,
    OBSTACLES,
    { name: "field", label: "Nutrient", type: "mask", required: false },
  ],
};

// Both grid modes share the `grid` resolution param.
const isGrid = (p: Record<string, unknown>): boolean =>
  p.mode === "percolation" || p.mode === "laplacian";

// The two tip-network modes share one engine and one param block.
const isNet = (p: Record<string, unknown>): boolean =>
  p.mode === "crack" || p.mode === "hyphal";

const isSc = (p: Record<string, unknown>): boolean =>
  (p.mode ?? "space_colonization") === "space_colonization";

export const accretiveGrowthNode: NodeDefinition = {
  type: "accretive-growth",
  name: "Accretive Growth",
  category: "spline",
  subcategory: "generator",
  description:
    "Grow a branching structure that accumulates over time — elements attach to what's already there and never move again, so Progress just reveals the growth (scrub it either way, it's free). Space Colonization scatters attractor points and lets branches race toward them, consuming each as it's reached (influence radius = how far a branch can 'see', kill distance = how close it must get) — trees, veins, river deltas, coral. DLA fires random walkers at the cluster and sticks them where they touch: frost and lichen, with Stickiness below 1 packing it denser and Drift blowing it sideways; seed from the Region edge for frost creeping off a shape. Percolation eats across a grid — Invasion follows the wired Resistance image, burrowing through dark areas and stalling at light ones, while Eden spreads uniformly into compact rough blobs. Laplacian solves the electric field around the growing shape and grows where it's strongest, so one slider (Eta) morphs the whole family: 0 is a compact blob, 1 is DLA-like coral, and high values leave only the most exposed tips growing — lightning. Wire an Attractor mask to steer the discharge toward a target. It is the expensive mode; Grid and Max elements drive its cost. Crack and Hyphal grow networks rather than trees — tips propagate, branch, and stop dead when they touch existing growth, recording the join: Crack nucleates at scattered origins that each spread both ways and T into each other (mud cracks, craquelure, shattered glass), while Hyphal radiates from a single seed and fuses where strands meet (mycelium, neurites). Space Colonization's Venation can also be set to closed, so converging branches fuse into the loops real leaf veins have instead of staying a strict tree. Region (mask or spline) confines any of them: scatter into a text silhouette and growth fills the letters. Branch thickness follows Da Vinci's rule and rides the anchor width channel; age rides the subpath driver channel, so Stroke's driver ramps colour by how old each branch is. Emit as Limbs (one continuous path per branch — the cheap default), Branches (overlapping root-to-tip paths for Trim Path; costly on big trees), Segments (one subpath per edge) or Boundary (the silhouette of the grown mass, for filling).",
  backend: "webgl2",
  noMaskInput: true,
  headerControl: { paramName: "mode" },
  inputs: SOCKETS.space_colonization,
  resolveInputs(params) {
    const mode = (params.mode as string) ?? "space_colonization";
    return SOCKETS[mode] ?? SOCKETS.space_colonization;
  },
  params: [
    // ---- growth ----
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: [
        "space_colonization",
        "dla",
        "percolation",
        "laplacian",
        "crack",
        "hyphal",
      ],
      default: "space_colonization",
    },
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
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 0,
    },
    {
      name: "max_elements",
      label: "Max elements",
      type: "scalar",
      min: 100,
      max: 200000,
      softMax: 20000,
      step: 1,
      default: 5000,
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
    // ---- space colonization ----
    {
      name: "attractor_count",
      label: "Attractors",
      type: "scalar",
      min: 10,
      max: 20000,
      softMax: 5000,
      step: 1,
      default: 2000,
      visibleIf: isSc,
    },
    {
      name: "influence_radius",
      label: "Influence radius",
      type: "scalar",
      min: 0.005,
      max: 0.5,
      step: 0.001,
      default: 0.08,
      visibleIf: isSc,
    },
    {
      name: "kill_distance",
      label: "Kill distance",
      type: "scalar",
      min: 0.001,
      max: 0.2,
      step: 0.001,
      default: 0.015,
      visibleIf: isSc,
    },
    {
      name: "step_length",
      label: "Step length",
      type: "scalar",
      min: 0.001,
      max: 0.05,
      step: 0.0005,
      default: 0.006,
      visibleIf: (p) => isSc(p) || isNet(p),
    },
    {
      name: "venation",
      label: "Venation",
      type: "enum",
      options: ["open", "closed"],
      default: "open",
      visibleIf: isSc,
    },
    {
      name: "fuse_radius",
      label: "Fuse radius",
      type: "scalar",
      min: 0.0005,
      max: 0.05,
      step: 0.0005,
      default: 0.003,
      visibleIf: (p) => isSc(p) && p.venation === "closed",
    },
    {
      name: "tropism_angle",
      label: "Tropism angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 90,
      visibleIf: isSc,
    },
    {
      name: "tropism_strength",
      label: "Tropism",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: isSc,
    },
    // ---- dla ----
    {
      name: "particles",
      label: "Particles",
      type: "scalar",
      min: 100,
      max: 100000,
      softMax: 20000,
      step: 1,
      default: 8000,
      visibleIf: (p) => p.mode === "dla",
    },
    {
      name: "stick_probability",
      label: "Stickiness",
      type: "scalar",
      min: 0.01,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode === "dla",
    },
    {
      name: "contact_radius",
      label: "Particle radius",
      type: "scalar",
      min: 0.001,
      max: 0.05,
      step: 0.0005,
      default: 0.004,
      visibleIf: (p) => p.mode === "dla",
    },
    {
      name: "drift_angle",
      label: "Drift angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "dla",
    },
    {
      name: "drift_strength",
      label: "Drift",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.mode === "dla",
    },
    {
      name: "seed_shape",
      label: "Seed from",
      type: "enum",
      options: ["point", "region_edge"],
      default: "point",
      visibleIf: (p) => p.mode === "dla",
    },
    {
      name: "edge_seeds",
      label: "Edge seeds",
      type: "scalar",
      min: 1,
      max: 2000,
      softMax: 500,
      step: 1,
      default: 200,
      visibleIf: (p) => p.mode === "dla" && p.seed_shape === "region_edge",
    },
    // ---- percolation ----
    {
      name: "variant",
      label: "Variant",
      type: "enum",
      options: ["invasion", "eden"],
      default: "invasion",
      visibleIf: (p) => p.mode === "percolation",
    },
    {
      name: "grid",
      label: "Grid",
      type: "scalar",
      min: 32,
      max: 1024,
      softMax: 512,
      step: 1,
      default: 384,
      visibleIf: isGrid,
    },
    {
      name: "resistance_contrast",
      label: "Resistance",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode === "percolation" && p.variant !== "eden",
    },
    // ---- laplacian ----
    {
      name: "eta",
      label: "Eta",
      type: "scalar",
      min: 0,
      max: 6,
      softMax: 4,
      step: 0.05,
      default: 1,
      visibleIf: (p) => p.mode === "laplacian",
    },
    {
      name: "relax_iters",
      label: "Solver passes",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 24,
      step: 1,
      default: 8,
      visibleIf: (p) => p.mode === "laplacian",
    },
    {
      name: "attractor_bias",
      label: "Attractor bias",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.mode === "laplacian",
    },
    // ---- crack / hyphal ----
    {
      name: "tip_count",
      label: "Tips",
      type: "scalar",
      min: 1,
      max: 2000,
      softMax: 200,
      step: 1,
      default: 24,
      visibleIf: isNet,
    },
    {
      name: "branch_rate",
      label: "Branch rate",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.2,
      step: 0.005,
      default: 0.03,
      visibleIf: isNet,
    },
    {
      name: "branch_angle",
      label: "Branch angle",
      type: "scalar",
      min: 5,
      max: 90,
      step: 1,
      default: 35,
      visibleIf: isNet,
    },
    {
      name: "wander",
      label: "Wander",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
      visibleIf: isNet,
    },
    {
      name: "field_strength",
      label: "Field steering",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: isNet,
    },
    {
      name: "hit_radius",
      label: "Contact radius",
      type: "scalar",
      min: 0.001,
      max: 0.05,
      step: 0.0005,
      default: 0.006,
      visibleIf: isNet,
    },
    // ---- output ----
    {
      name: "emit",
      label: "Emit",
      type: "enum",
      options: ["limbs", "branches", "segments", "boundary"],
      default: "limbs",
    },
    {
      name: "boundary_grid",
      label: "Outline grid",
      type: "scalar",
      min: 64,
      max: 1024,
      softMax: 512,
      step: 1,
      default: 256,
      visibleIf: (p) => p.emit === "boundary",
    },
    {
      name: "boundary_radius",
      label: "Outline radius",
      type: "scalar",
      min: 0.001,
      max: 0.1,
      step: 0.0005,
      default: 0.008,
      visibleIf: (p) => p.emit === "boundary",
    },
    {
      name: "tip_width",
      label: "Tip width",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
    },
    {
      name: "id_mode",
      label: "ID mode",
      type: "enum",
      options: ["branch", "depth", "root", "birth"],
      default: "branch",
    },
    {
      name: "id_groups",
      label: "ID groups",
      type: "scalar",
      min: 2,
      max: 32,
      step: 1,
      default: 6,
      visibleIf: (p) => p.id_mode === "birth",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    const regionIn = inputs.region;
    const region = regionIn && regionIn.kind === "mask" ? regionIn : null;
    const obstaclesIn = inputs.obstacles;
    const obstacles =
      obstaclesIn && obstaclesIn.kind === "mask" ? obstaclesIn : null;

    // ---- blocked bitmap (identity-cached readback) ----
    if (
      state.regionRef !== region ||
      state.obstaclesRef !== obstacles ||
      state.baseW !== W ||
      state.baseH !== H
    ) {
      let base: Uint8Array | null = null;
      if (region || obstacles) {
        base = new Uint8Array(W * H);
        const reg = region ? readDriver(ctx, null, region, W, H, 1) : null;
        if (reg) {
          for (let i = 0; i < base.length; i++) {
            if (reg[i] < 0.5) base[i] = 1;
          }
        }
        const obs = obstacles
          ? readDriver(ctx, null, obstacles, W, H, 1)
          : null;
        if (obs) {
          for (let i = 0; i < base.length; i++) {
            if (obs[i] >= 0.5) base[i] = 1;
          }
        }
      }
      state.blocked = base;
      state.baseW = W;
      state.baseH = H;
      state.regionRef = region;
      state.obstaclesRef = obstacles;
      state.trace = null; // content changed — retrace
    }

    // A wired points input mints a fresh value whenever its upstream
    // recomputes, so identity change IS the "attractors moved" signal.
    // That's what makes an animated attractor cloud re-grow per frame
    // without a separate live/cached mode.
    const seedsIn = inputs.seeds;
    const attractorsIn = inputs.attractors;
    const fieldIn = inputs.field;
    const field = fieldIn && fieldIn.kind === "mask" ? fieldIn : null;
    if (
      state.seedsRef !== seedsIn ||
      state.attractorsRef !== attractorsIn ||
      state.fieldRef !== field
    ) {
      state.seedsRef = seedsIn;
      state.attractorsRef = attractorsIn;
      state.fieldRef = field;
      state.fieldBuf = null;
      state.trace = null;
    }

    // ---- structural params → trace signature ----
    const minDim = Math.min(W, H);
    const mode =
      typeof params.mode === "string" ? params.mode : "space_colonization";
    const maxElements = clamp(
      Math.round(num(params.max_elements, 5000)),
      100,
      200000
    );
    const marginPx = clamp(num(params.margin, 0.02), 0, 0.25) * minDim;
    const seedNum = Math.max(0, Math.round(num(params.seed, 0)));
    const tipWidth = clamp(num(params.tip_width, 0.1), 0, 1);
    const common = [mode, W, H, seedNum, maxElements, marginPx, tipWidth];

    // Screen-space angle: 0 = right, 90 = down (px space is y-down), so
    // the default reads as gravity.
    const tropRad =
      (clamp(num(params.tropism_angle, 90), -180, 180) * Math.PI) / 180;
    const p: ScParams = {
      seed: seedNum,
      attractorCount: clamp(
        Math.round(num(params.attractor_count, 2000)),
        10,
        20000
      ),
      influencePx: clamp(num(params.influence_radius, 0.08), 0.005, 0.5) * W,
      killPx: clamp(num(params.kill_distance, 0.015), 0.001, 0.2) * W,
      stepPx: clamp(num(params.step_length, 0.006), 0.001, 0.05) * W,
      tropismX: Math.cos(tropRad),
      tropismY: Math.sin(tropRad),
      tropismStrength: clamp(num(params.tropism_strength, 0), 0, 1),
      closed: params.venation === "closed",
      fusePx: clamp(num(params.fuse_radius, 0.003), 0.0005, 0.05) * W,
      maxElements,
      marginPx,
      tipWidth,
    };

    const driftRad =
      (clamp(num(params.drift_angle, 0), -180, 180) * Math.PI) / 180;
    const dp: DlaParams = {
      seed: seedNum,
      particles: clamp(Math.round(num(params.particles, 8000)), 100, 100000),
      stickProb: clamp(num(params.stick_probability, 1), 0.01, 1),
      contactPx: clamp(num(params.contact_radius, 0.004), 0.001, 0.05) * W,
      driftX: Math.cos(driftRad),
      driftY: Math.sin(driftRad),
      driftStrength: clamp(num(params.drift_strength, 0), 0, 1),
      seedShape:
        typeof params.seed_shape === "string" ? params.seed_shape : "point",
      edgeSeedCount: clamp(Math.round(num(params.edge_seeds, 200)), 1, 2000),
      maxElements,
      marginPx,
      tipWidth,
    };

    const lp: LapParams = {
      seed: seedNum,
      gridW: clamp(Math.round(num(params.grid, 384)), 32, 1024),
      eta: clamp(num(params.eta, 1), 0, 6),
      relaxIters: clamp(Math.round(num(params.relax_iters, 8)), 1, 64),
      bias: clamp(num(params.attractor_bias, 0), 0, 1),
      maxElements,
      marginPx,
      tipWidth,
    };

    const tp: TipParams = {
      seed: seedNum,
      variant: mode,
      tipCount: clamp(Math.round(num(params.tip_count, 24)), 1, 2000),
      stepPx: clamp(num(params.step_length, 0.006), 0.001, 0.05) * W,
      branchRate: clamp(num(params.branch_rate, 0.03), 0, 0.5),
      branchAngle:
        (clamp(num(params.branch_angle, 35), 5, 90) * Math.PI) / 180,
      wander: clamp(num(params.wander, 0.2), 0, 1),
      fieldStrength: clamp(num(params.field_strength, 0), 0, 1),
      hitPx: clamp(num(params.hit_radius, 0.006), 0.001, 0.05) * W,
      maxElements,
      marginPx,
      tipWidth,
    };

    const pp: PercParams = {
      seed: seedNum,
      variant: typeof params.variant === "string" ? params.variant : "invasion",
      gridW: clamp(Math.round(num(params.grid, 384)), 32, 1024),
      contrast: clamp(num(params.resistance_contrast, 1), 0, 1),
      maxElements,
      marginPx,
      tipWidth,
    };

    // Only the ACTIVE mode's params enter the signature, so tweaking a
    // hidden mode's slider can't force a pointless retrace.
    const traceSig = (
      mode === "dla"
        ? [
            ...common,
            dp.particles,
            dp.stickProb,
            dp.contactPx,
            dp.driftX,
            dp.driftY,
            dp.driftStrength,
            dp.seedShape,
            dp.edgeSeedCount,
          ]
        : mode === "percolation"
          ? [...common, pp.variant, pp.gridW, pp.contrast]
          : mode === "laplacian"
            ? [...common, lp.gridW, lp.eta, lp.relaxIters, lp.bias]
            : mode === "crack" || mode === "hyphal"
              ? [
                  ...common,
                  tp.tipCount,
                  tp.stepPx,
                  tp.branchRate,
                  tp.branchAngle,
                  tp.wander,
                  tp.fieldStrength,
                  tp.hitPx,
                ]
              : [
              ...common,
              p.attractorCount,
              p.influencePx,
              p.killPx,
              p.stepPx,
              p.tropismX,
              p.tropismY,
              p.tropismStrength,
              p.closed ? "closed" : "open",
              p.fusePx,
            ]
    ).join("|");

    if (!state.trace || state.traceSig !== traceSig) {
      const seedsPx = pointsToPx(seedsIn, W, H);
      // The grid modes read their field straight into the sim grid —
      // readDriver box-downsamples on the GPU, so a 4K mask costs one
      // small readback. Identity-cached like every other map input.
      const readField = (gwWanted: number): Float32Array | null => {
        if (!field) return null;
        const gh = Math.max(4, Math.round((gwWanted * H) / W));
        const key = `${gwWanted}x${gh}`;
        if (!state.fieldBuf || state.fieldGrid !== key) {
          state.fieldBuf = readDriver(ctx, null, field, gwWanted, gh, 1);
          state.fieldGrid = key;
        }
        return state.fieldBuf;
      };
      if (mode === "dla") {
        state.trace = buildDla(state.blocked, W, H, seedsPx, dp);
      } else if (mode === "percolation") {
        state.trace = buildPercolation(
          state.blocked,
          W,
          H,
          seedsPx,
          readField(pp.gridW),
          pp
        );
      } else if (mode === "laplacian") {
        state.trace = buildLaplacian(
          state.blocked,
          W,
          H,
          seedsPx,
          readField(lp.gridW),
          lp
        );
      } else if (mode === "crack" || mode === "hyphal") {
        const fgw = 256;
        const fgh = Math.max(4, Math.round((fgw * H) / W));
        state.trace = buildTipNetwork(
          state.blocked,
          W,
          H,
          seedsPx,
          readField(fgw),
          fgw,
          fgh,
          tp
        );
      } else {
        state.trace = buildSpaceColonization(
          state.blocked,
          W,
          H,
          seedsPx,
          pointsToPx(attractorsIn, W, H),
          p
        );
      }
      state.traceSig = traceSig;
      state.emitTrace = null; // slices of the old trace are stale
    }
    const trace = state.trace;
    if (trace.count === 0) {
      return {
        primary: { kind: "spline", subpaths: [] } satisfies SplineValue,
        aux: { points: EMPTY_POINTS },
      };
    }

    // ---- emit-time params → slice (memoized) ----
    const eo: GrowthEmitOptions = {
      progress: clamp(num(params.progress, 1), 0, 1),
      emit:
        params.emit === "segments"
          ? "segments"
          : params.emit === "branches"
            ? "branches"
            : params.emit === "boundary"
              ? "boundary"
              : "limbs",
      idMode:
        typeof params.id_mode === "string"
          ? (params.id_mode as GrowthIdMode)
          : "branch",
      idGroups: clamp(Math.round(num(params.id_groups, 6)), 2, 32),
      boundaryGrid: clamp(Math.round(num(params.boundary_grid, 256)), 64, 1024),
      boundaryRadiusPx:
        clamp(num(params.boundary_radius, 0.008), 0.001, 0.1) * W,
      width: W,
      height: H,
    };
    const emitKey = [
      eo.progress,
      eo.emit,
      eo.idMode,
      eo.idGroups,
      eo.boundaryGrid,
      eo.boundaryRadiusPx,
      W,
      H,
    ].join("|");
    if (
      state.emitTrace !== trace ||
      state.emitKey !== emitKey ||
      !state.emitSpline ||
      !state.emitPoints
    ) {
      const { spline, points } = emitGrowth(trace, eo);
      state.emitSpline = spline;
      state.emitPoints = points;
      state.emitKey = emitKey;
      state.emitTrace = trace;
    }

    // The aux is built unconditionally with the slice: this node caches,
    // so a consumedOutputs gate would hand a later-wired consumer a stale
    // empty value forever (the Advect Points / Loop Weave lesson).
    return {
      primary: state.emitSpline,
      aux: { points: state.emitPoints },
    };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[stateKey(nodeId)];
  },
};
