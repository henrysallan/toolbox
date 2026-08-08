import type {
  ColliderDescriptor,
  ForceDescriptor,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  catmullRomSubpath,
  measureSubpath,
  resampleSubpath,
} from "@/engine/spline-math";
import {
  applyForceCpu,
  authoredToPxY,
  buildSpatialHash,
  cellStart,
  evenPolylinePoints,
  fillAttrFromMap,
  packColliders,
  pxToAuthoredY,
  readMapBuffer,
  resolveBoundsCpu,
  resolveCollidersCpu,
  sampleMap,
  samplePolylineAt,
  subpathToCanvasPx,
  type MapCacheEntry,
  type MaskColliderCacheEntry,
  type PackedCollider,
  type SpatialHash,
} from "@/engine/sim-kernel";
import { makePoints } from "@/engine/points";

// Rope Simulator — 2D string dynamics over splines.
// Spec: specdocs/archive/071926_rope-simulator.md (milestone 1).
//
// Each input subpath is resampled into a chain of particles joined by
// distance constraints (plus i↔i+2 bending constraints), stepped with
// position-based Verlet. Forces and colliders reuse the SAME descriptor
// nodes as the Particle Simulator — the CPU ports (engine/sim-kernel.ts,
// shared with the Rigid Body Simulator) mirror that shader's math
// exactly so a collider behaves identically in every sim.
//
// Three coordinate spaces, deliberately (see sim-kernel.ts header):
//   - Geometry sockets carry AUTHORED coordinates (engine/aspect.ts) —
//     the space splines/points are stored and rendered in.
//   - The solver (constraints, rest lengths, self-collision) runs in
//     TRUE canvas-pixel space, Y-down, via the rasterizer's mapping
//     (subpathToCanvasPx), so segment spacing, stiffness, and thickness
//     are isotropic ON SCREEN at any canvas aspect.
//   - Canvas bounds, mask colliders, and property maps use canvas UV;
//     force and analytic-collider descriptors are evaluated in authored
//     coordinates (matching the Particle Simulator verbatim).
//
// State is session-only (bake convention): seeded from the input spline
// on reset, advanced on PLAYBACK evals only (the house sim contract —
// paused evals re-emit output without stepping, so a parked playhead
// holds its pose). Reset = seed-relevant param change, input TOPOLOGY
// change (subpath/anchor counts — shape animation does not reset),
// canvas resize, or scene-time wrap.

const MAX_FORCE_SLOTS = 6;
const MAX_COLLIDER_SLOTS = 6;

interface RopeChain {
  start: number; // first particle index
  count: number;
  closed: boolean;
  edgeBase: number; // first edge index (chain-local edge i = edgeBase+i)
  srcIndex: number; // source subpath index (aux points groupIndex)
  srcGroup?: number; // source subpath's own groupIndex tag, if any
}

interface RopeSimState {
  count: number;
  // Interleaved px-space positions, current + previous (Verlet).
  pos: Float32Array;
  prev: Float32Array;
  invMass: Float32Array; // 0 = pinned
  // Distance constraints as flat pair lists — a list (not chain-implicit
  // adjacency) so tearing can kill entries.
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeRest: Float32Array;
  edgeAlive: Uint8Array;
  // XPBD Lagrange-multiplier accumulator, zeroed each substep. Needed
  // for stretchiness: naive per-iteration softening washes out over
  // iterations × substeps (16 passes ≈ rigid again); the λ form
  // converges to the true compliant equilibrium instead.
  edgeLambda: Float32Array;
  edgeCount: number;
  bendA: Uint32Array;
  bendB: Uint32Array;
  bendRest: Float32Array;
  // The two edges each bend constraint spans — a bend dies with either
  // one, so a torn rope doesn't stay stiff across the break.
  bendE1: Uint32Array;
  bendE2: Uint32Array;
  bendCount: number;
  chains: RopeChain[];
  // Per-particle material attributes: base param × map sample.
  // friction/bounce/stretch/stick are multipliers (unwired map = 1);
  // tear is a WEAKNESS (unwired = 0, white = tears at a touch).
  attrFriction: Float32Array;
  attrBounce: Float32Array;
  attrStretch: Float32Array;
  attrTear: Float32Array;
  attrStick: Float32Array;
  // Which chain each particle belongs to (self-collision skips pairs
  // within 2 ring-neighbors of the same chain).
  particleChain: Int32Array;
  // Pin-to-points: which input point each captured particle tracks
  // (−1 = not point-pinned). Captured at reseed by nearest-within-
  // radius; per eval the particle snaps to the point's CURRENT
  // position, so an animated points input drags the rope around.
  pinPointIdx: Int32Array;
  // follow_input targets: every pinned particle (ends / pin map)
  // records its source subpath + arc-length fraction at seed; with
  // follow_input on, the pin re-samples the LIVE input spline there
  // each eval instead of holding the frozen rest position.
  followSub: Int32Array;
  followT: Float32Array;
  // Sticky welds: per particle, the packed-collider slot it's stuck to
  // (−1 = free), the anchor payload (circle: offset from center in UV;
  // line/mask: world UV), and the collider kind at weld time so a
  // rewired slot releases instead of mis-anchoring.
  weldSlot: Int32Array;
  weldKind: Int8Array;
  weldAx: Float32Array;
  weldAy: Float32Array;
  // Spatial-hash scratch for self-collision, rebuilt each substep
  // (kernel counting-sort hash; arrays reused across builds).
  hash?: SpatialHash;
  seedSig: string;
  lastTime: number;
  width: number;
  height: number;
  // Per-collider-slot CPU contact fields for image_mask colliders,
  // reused while the mask's ImageValue identity (value-object identity
  // = "upstream recomputed" — the devguide caching rule) and threshold
  // are unchanged.
  maskCache?: Array<MaskColliderCacheEntry | undefined>;
  // Per-map-slot CPU readbacks of the property maps (same identity-
  // reuse rule as maskCache), keyed by input socket name.
  mapCache?: Record<string, MapCacheEntry | undefined>;
}

function stateKey(nodeId: string): string {
  return `rope-simulator:${nodeId}`;
}

// ---- seeding -------------------------------------------------------
// (subpathToCanvasPx / evenPolylinePoints / samplePolylineAt live in
// the shared sim kernel.)

function seedState(
  src: SplineValue,
  segPx: number,
  maxPoints: number,
  pinMode: string,
  W: number,
  H: number,
  seedSig: string
): RopeSimState {
  interface Seeded {
    pts: number[]; // interleaved px positions
    closed: boolean;
    srcIndex: number;
    srcGroup?: number;
  }
  const seeded: Seeded[] = [];
  let total = 0;
  for (let si = 0; si < src.subpaths.length; si++) {
    const sub = src.subpaths[si];
    if (sub.anchors.length < 2) continue;
    const pxSub = subpathToCanvasPx(sub, W, H);
    const m = measureSubpath(pxSub);
    if (m.total <= 1e-3) continue;
    const minCount = sub.closed ? 3 : 2;
    // Open chains get the +1 fencepost anchor; closed chains sample the
    // loop without duplicating the seam (resampleSubpath convention).
    let count = Math.max(
      minCount,
      Math.round(m.total / segPx) + (sub.closed ? 0 : 1)
    );
    if (total + count > maxPoints) count = maxPoints - total;
    if (count < minCount) break; // budget exhausted
    const denseCount = Math.min(2048, Math.max(count * 3, 16));
    const rs = resampleSubpath(pxSub, denseCount);
    const pts = evenPolylinePoints(
      rs.anchors.map((a) => a.pos),
      sub.closed,
      count
    );
    seeded.push({ pts, closed: sub.closed, srcIndex: si, srcGroup: sub.groupIndex });
    total += count;
    if (total >= maxPoints) break;
  }

  const count = seeded.reduce((n, s) => n + s.pts.length / 2, 0);
  const pos = new Float32Array(count * 2);
  const prev = new Float32Array(count * 2);
  const invMass = new Float32Array(count).fill(1);
  const particleChain = new Int32Array(count);
  const chains: RopeChain[] = [];

  let edgeCap = 0;
  let bendCap = 0;
  for (const s of seeded) {
    const n = s.pts.length / 2;
    edgeCap += n - 1 + (s.closed ? 1 : 0);
    bendCap += Math.max(0, n - 2) + (s.closed ? 2 : 0);
  }
  const edgeA = new Uint32Array(edgeCap);
  const edgeB = new Uint32Array(edgeCap);
  const edgeRest = new Float32Array(edgeCap);
  const bendA = new Uint32Array(bendCap);
  const bendB = new Uint32Array(bendCap);
  const bendRest = new Float32Array(bendCap);
  const bendE1 = new Uint32Array(bendCap);
  const bendE2 = new Uint32Array(bendCap);

  const dist = (a: number, b: number): number =>
    Math.hypot(pos[b * 2] - pos[a * 2], pos[b * 2 + 1] - pos[a * 2 + 1]);

  let cursor = 0;
  let ei = 0;
  let bi = 0;
  for (const s of seeded) {
    const n = s.pts.length / 2;
    const start = cursor;
    pos.set(s.pts, start * 2);
    prev.set(s.pts, start * 2);
    particleChain.fill(chains.length, start, start + n);
    chains.push({
      start,
      count: n,
      closed: s.closed,
      edgeBase: ei,
      srcIndex: s.srcIndex,
      srcGroup: s.srcGroup,
    });
    // Rest lengths are the ACTUAL seeded distances (not segPx) so a
    // chain whose sampling came out slightly uneven is born at rest.
    // Chain-local edge order: 0..n-2 are (i, i+1); a closed chain's
    // wrap edge (n-1, 0) is last — the bend→edge indices below rely
    // on this layout.
    const edgeBase = ei;
    for (let i = 0; i < n - 1; i++) {
      edgeA[ei] = start + i;
      edgeB[ei] = start + i + 1;
      edgeRest[ei] = dist(start + i, start + i + 1);
      ei++;
    }
    if (s.closed) {
      edgeA[ei] = start + n - 1;
      edgeB[ei] = start;
      edgeRest[ei] = dist(start + n - 1, start);
      ei++;
    }
    for (let i = 0; i < n - 2; i++) {
      bendA[bi] = start + i;
      bendB[bi] = start + i + 2;
      bendRest[bi] = dist(start + i, start + i + 2);
      bendE1[bi] = edgeBase + i;
      bendE2[bi] = edgeBase + i + 1;
      bi++;
    }
    if (s.closed && n >= 3) {
      bendA[bi] = start + n - 2;
      bendB[bi] = start;
      bendRest[bi] = dist(start + n - 2, start);
      bendE1[bi] = edgeBase + n - 2;
      bendE2[bi] = edgeBase + n - 1; // wrap edge
      bi++;
      bendA[bi] = start + n - 1;
      bendB[bi] = start + 1;
      bendRest[bi] = dist(start + n - 1, start + 1);
      bendE1[bi] = edgeBase + n - 1; // wrap edge
      bendE2[bi] = edgeBase;
      bi++;
    }
    if (!s.closed && n >= 1) {
      if (pinMode === "start" || pinMode === "both") invMass[start] = 0;
      if (pinMode === "end" || pinMode === "both") invMass[start + n - 1] = 0;
    }
    cursor += n;
  }

  return {
    count,
    pos,
    prev,
    invMass,
    edgeA,
    edgeB,
    edgeRest,
    edgeAlive: new Uint8Array(ei).fill(1),
    edgeLambda: new Float32Array(ei),
    edgeCount: ei,
    bendA,
    bendB,
    bendRest,
    bendE1,
    bendE2,
    bendCount: bi,
    chains,
    attrFriction: new Float32Array(count).fill(1),
    attrBounce: new Float32Array(count).fill(1),
    attrStretch: new Float32Array(count).fill(1),
    attrTear: new Float32Array(count),
    attrStick: new Float32Array(count).fill(1),
    particleChain,
    pinPointIdx: new Int32Array(count).fill(-1),
    followSub: new Int32Array(count).fill(-1),
    followT: new Float32Array(count),
    weldSlot: new Int32Array(count).fill(-1),
    weldKind: new Int8Array(count),
    weldAx: new Float32Array(count),
    weldAy: new Float32Array(count),
    seedSig,
    lastTime: 0,
    width: W,
    height: H,
  };
}

// ---- self-collision ------------------------------------------------

// Kernel spatial hash (counting sort, px space, cell = thickness).
// Every pair closer than `thickness` separates symmetrically
// (mass-weighted); pairs within 2 ring-neighbors of the same chain are
// skipped so the rope doesn't fight its own bending. Contact friction
// damps the pair's relative tangential velocity by writing into `prev`
// (velocity changes without position changes).
function resolveSelfCollisions(
  st: RopeSimState,
  thickness: number,
  friction: number,
  W: number,
  H: number
): void {
  const { pos, prev, invMass, count } = st;
  const hash = (st.hash = buildSpatialHash(
    pos,
    count,
    thickness,
    W,
    H,
    st.hash
  ));
  const { counts, entries, gw, gh, cell } = hash;
  const cellX = (i: number): number =>
    Math.max(0, Math.min(gw - 1, Math.floor(pos[i * 2] / cell)));
  const cellY = (i: number): number =>
    Math.max(0, Math.min(gh - 1, Math.floor(pos[i * 2 + 1] / cell)));

  const ringDist = (a: number, b: number): number => {
    const chain = st.chains[st.particleChain[a]];
    const la = a - chain.start;
    const lb = b - chain.start;
    const d = Math.abs(la - lb);
    return chain.closed ? Math.min(d, chain.count - d) : d;
  };

  for (let i = 0; i < count; i++) {
    const cx = cellX(i);
    const cy = cellY(i);
    for (let oy = -1; oy <= 1; oy++) {
      const yy = cy + oy;
      if (yy < 0 || yy >= gh) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = cx + ox;
        if (xx < 0 || xx >= gw) continue;
        const c = yy * gw + xx;
        for (let k = cellStart(hash, c); k < counts[c]; k++) {
          const j = entries[k];
          if (j <= i) continue; // each pair once
          const wA = invMass[i];
          const wB = invMass[j];
          const wSum = wA + wB;
          if (wSum === 0) continue;
          if (
            st.particleChain[i] === st.particleChain[j] &&
            ringDist(i, j) <= 2
          ) {
            continue;
          }
          const dx = pos[j * 2] - pos[i * 2];
          const dy = pos[j * 2 + 1] - pos[i * 2 + 1];
          const d = Math.hypot(dx, dy);
          if (d >= thickness || d < 1e-6) continue;
          const nx = dx / d;
          const ny = dy / d;
          const push = (thickness - d) / wSum;
          pos[i * 2] -= nx * push * wA;
          pos[i * 2 + 1] -= ny * push * wA;
          pos[j * 2] += nx * push * wB;
          pos[j * 2 + 1] += ny * push * wB;
          const fr =
            friction * 0.5 * (st.attrFriction[i] + st.attrFriction[j]);
          if (fr > 0) {
            // Relative velocity (px per substep), tangential part.
            const rvx =
              pos[i * 2] - prev[i * 2] - (pos[j * 2] - prev[j * 2]);
            const rvy =
              pos[i * 2 + 1] - prev[i * 2 + 1] - (pos[j * 2 + 1] - prev[j * 2 + 1]);
            const rvn = rvx * nx + rvy * ny;
            const tx = (rvx - rvn * nx) * fr;
            const ty = (rvy - rvn * ny) * fr;
            // Raising prev toward pos kills velocity without moving.
            prev[i * 2] += tx * (wA / wSum);
            prev[i * 2 + 1] += ty * (wA / wSum);
            prev[j * 2] -= tx * (wB / wSum);
            prev[j * 2 + 1] -= ty * (wB / wSum);
          }
        }
      }
    }
  }
}

// ---- input gathering -----------------------------------------------

function gatherDescriptors<T>(
  inputs: Record<string, SocketValue | undefined>,
  prefix: string,
  max: number,
  unpack: (v: SocketValue) => T | null
): T[] {
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const v = inputs[`${prefix}${i + 1}`];
    if (!v) continue;
    const u = unpack(v);
    if (u) out.push(u);
  }
  return out;
}

// ---- node ----------------------------------------------------------

export const ropeSimulatorNode: NodeDefinition = {
  type: "rope-simulator",
  name: "Rope Simulator",
  category: "spline",
  subcategory: "modifier",
  description:
    "2D rope/string dynamics: each input subpath becomes a chain of particles with distance and bending constraints, pulled by gravity and force nodes, colliding with collider nodes and the canvas bounds. Pin the ends and the rope hangs and swings; output is a live spline. Resets when scene time returns to 0.",
  backend: "webgl2",
  // Output depends on persistent per-node state — advance every eval.
  stable: false,
  simulation: true,
  // Spline output — the universal matte has nothing to matte.
  noMaskInput: true,
  inputs: [{ name: "splines", type: "spline", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const fc = Math.max(
      0,
      Math.min(MAX_FORCE_SLOTS, Math.floor((params.forceCount as number) ?? 1))
    );
    const cc = Math.max(
      0,
      Math.min(
        MAX_COLLIDER_SLOTS,
        Math.floor((params.colliderCount as number) ?? 1)
      )
    );
    const out: InputSocketDef[] = [
      { name: "splines", type: "spline", required: true },
    ];
    for (let i = 0; i < fc; i++) {
      out.push({ name: `force${i + 1}`, type: "force", required: false });
    }
    for (let i = 0; i < cc; i++) {
      out.push({ name: `collider${i + 1}`, type: "collider", required: false });
    }
    // Puppet pins: each point captures the nearest particle at reset
    // and drags it (points inputs animate).
    out.push({ name: "pins", type: "points", required: false });
    // Property maps (mask-typed: images and splines coerce in). Baked
    // at reset by default; each has a live re-sample toggle. pin_map
    // is baked-only — the world-space variant of "pin" is stickiness.
    out.push(
      { name: "friction_map", type: "mask", required: false },
      { name: "bounce_map", type: "mask", required: false },
      { name: "stretch_map", type: "mask", required: false },
      { name: "tear_map", type: "mask", required: false },
      { name: "stick_map", type: "mask", required: false },
      { name: "pin_map", type: "mask", required: false }
    );
    return out;
  },
  params: [
    {
      name: "segment_px",
      label: "Segment length (px)",
      type: "scalar",
      min: 2,
      max: 64,
      step: 1,
      default: 8,
    },
    {
      name: "max_points",
      label: "Max points",
      type: "scalar",
      min: 16,
      max: 32768,
      softMax: 8000,
      step: 16,
      default: 2000,
    },
    {
      name: "pin_mode",
      label: "Pin ends",
      type: "enum",
      options: ["none", "start", "end", "both"],
      default: "both",
    },
    {
      name: "pin_radius",
      label: "Pin capture radius (px)",
      type: "scalar",
      min: 2,
      max: 64,
      step: 1,
      default: 12,
    },
    {
      name: "follow_input",
      label: "Follow input",
      type: "boolean",
      default: false,
    },
    {
      name: "gravity_x",
      label: "Gravity X",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0,
    },
    {
      name: "gravity_y",
      label: "Gravity Y",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0.35,
    },
    {
      name: "stiffness",
      label: "Stiffness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
    },
    {
      name: "damping",
      label: "Damping",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.02,
    },
    {
      name: "friction",
      label: "Friction",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
    },
    {
      name: "bounciness",
      label: "Bounciness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
    },
    {
      name: "stretchiness",
      label: "Stretchiness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "stickiness",
      label: "Stickiness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "stick_strength",
      label: "Stick strength",
      type: "scalar",
      min: 0,
      max: 5,
      step: 0.01,
      default: 1,
      visibleIf: (p) => ((p.stickiness as number) ?? 0) > 0,
    },
    {
      name: "self_collide",
      label: "Self-collision",
      type: "boolean",
      default: true,
    },
    {
      name: "thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 1,
      max: 32,
      step: 0.5,
      default: 4,
      visibleIf: (p) => p.self_collide !== false,
    },
    {
      name: "tearing",
      label: "Tearing",
      type: "boolean",
      default: false,
    },
    {
      name: "tear_threshold",
      label: "Tear threshold",
      type: "scalar",
      min: 0.01,
      max: 4,
      softMax: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => !!p.tearing,
    },
    {
      name: "friction_map_live",
      label: "Friction map: live",
      type: "boolean",
      default: false,
    },
    {
      name: "bounce_map_live",
      label: "Bounce map: live",
      type: "boolean",
      default: false,
    },
    {
      name: "stretch_map_live",
      label: "Stretch map: live",
      type: "boolean",
      default: false,
    },
    {
      name: "tear_map_live",
      label: "Tear map: live",
      type: "boolean",
      default: false,
    },
    {
      name: "stick_map_live",
      label: "Stick map: live",
      type: "boolean",
      default: false,
    },
    {
      name: "substeps",
      label: "Substeps",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 4,
    },
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 4,
    },
    {
      name: "fixedDt",
      label: "Frame dt",
      type: "scalar",
      min: 0.001,
      max: 0.1,
      step: 0.001,
      default: 1 / 60,
    },
    {
      name: "forceCount",
      label: "Force slots",
      type: "scalar",
      min: 0,
      max: MAX_FORCE_SLOTS,
      step: 1,
      default: 1,
    },
    {
      name: "colliderCount",
      label: "Collider slots",
      type: "scalar",
      min: 0,
      max: MAX_COLLIDER_SLOTS,
      step: 1,
      default: 1,
    },
    {
      name: "boundsMode",
      label: "Canvas bounds",
      type: "enum",
      options: ["off", "bounce", "clamp"],
      default: "off",
    },
    {
      name: "boundsRestitution",
      label: "Bounds bounce",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.boundsMode === "bounce",
    },
    {
      name: "output_mode",
      label: "Output",
      type: "enum",
      options: ["smooth", "polyline"],
      default: "smooth",
      control: "segmented",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [
    { name: "points", type: "points" },
    // Break locations for the current frame only (empty most frames) —
    // wire into emitters/effects to trigger something at each snap.
    { name: "tears", type: "points" },
  ],

  fingerprintExtras(_params, ctx) {
    // Force per-frame re-eval; the sim advances every tick.
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const src = inputs.splines;
    const W = Math.max(1, ctx.width);
    const H = Math.max(1, ctx.height);
    const aspect = W / H;
    const key = stateKey(nodeId);

    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      delete ctx.state[key];
      return { primary: { kind: "spline", subpaths: [] } satisfies SplineValue };
    }

    const segPx = Math.max(2, (params.segment_px as number) ?? 8);
    const maxPoints = Math.max(16, Math.floor((params.max_points as number) ?? 2000));
    const pinMode = (params.pin_mode as string) ?? "both";
    const gx = (params.gravity_x as number) ?? 0;
    const gy = (params.gravity_y as number) ?? 0.35;
    const stiffness = (params.stiffness as number) ?? 0.1;
    const damping = (params.damping as number) ?? 0.02;
    const friction = Math.max(0, Math.min(1, (params.friction as number) ?? 0.2));
    const bounciness = Math.max(0, Math.min(1, (params.bounciness as number) ?? 0.3));
    const stretchiness = Math.max(0, Math.min(1, (params.stretchiness as number) ?? 0));
    const tearing = !!(params.tearing as boolean);
    const tearThreshold = Math.max(0.01, (params.tear_threshold as number) ?? 0.5);
    const stickiness = Math.max(0, Math.min(1, (params.stickiness as number) ?? 0));
    const stickStrength = Math.max(0, (params.stick_strength as number) ?? 1);
    const selfCollide = params.self_collide !== false;
    const thickness = Math.max(1, (params.thickness as number) ?? 4);
    const pinRadius = Math.max(2, (params.pin_radius as number) ?? 12);
    const followInput = !!(params.follow_input as boolean);
    const pinPts =
      inputs.pins && inputs.pins.kind === "points" ? inputs.pins : null;
    const substeps = Math.max(1, Math.min(16, Math.floor((params.substeps as number) ?? 4)));
    const iterations = Math.max(1, Math.min(16, Math.floor((params.iterations as number) ?? 4)));
    const fixedDt = Math.max(0.001, Math.min(0.1, (params.fixedDt as number) ?? 1 / 60));
    const boundsMode = (params.boundsMode as string) ?? "off";
    const boundsRestitution = (params.boundsRestitution as number) ?? 0.5;
    const outputMode = (params.output_mode as string) ?? "smooth";

    // Topology-only signature: shape animation flows through without
    // resetting (needed for milestone 5's follow_input); adding/removing
    // subpaths or anchors reseeds.
    const topoSig = src.subpaths
      .map((s) => `${s.anchors.length}${s.closed ? "c" : "o"}`)
      .join(",");
    // Pins-count changes re-capture via a full reseed (cheap, and the
    // capture rule depends on rest positions anyway).
    const seedSig = `${segPx}|${maxPoints}|${pinMode}|${W}x${H}|${topoSig}|p:${pinPts?.count ?? 0}:${pinRadius}`;

    let st = ctx.state[key] as RopeSimState | undefined;
    const timeWrapped = st ? st.lastTime > 0.05 && ctx.time < 0.05 : false;
    const reseeded = !st || st.seedSig !== seedSig || timeWrapped;
    if (reseeded) {
      st = seedState(src, segPx, maxPoints, pinMode, W, H, seedSig);
      ctx.state[key] = st;
    }
    st = st!;
    // Step gating — the house sim contract (matter-simulator precedent):
    // paused evals (param tweaks, graph edits, re-renders at a parked
    // playhead) re-emit output without advancing, so frame 0 keeps its
    // seed pose and the near-zero blind spot of the wrap check above
    // can't accumulate drift.
    const active =
      ctx.playing || (ctx.offline && ctx.time > st.lastTime + 1e-6);
    st.lastTime = ctx.time;

    // Property maps. Baked maps sample once at (re)seed, at rest
    // positions; a live map re-samples every eval at CURRENT positions
    // (world-space field). pin_map is baked-only.
    const mapAttrs: Array<{
      name: string;
      out: Float32Array;
      live: boolean;
      unwired: number;
    }> = [
      { name: "friction_map", out: st.attrFriction, live: !!params.friction_map_live, unwired: 1 },
      { name: "bounce_map", out: st.attrBounce, live: !!params.bounce_map_live, unwired: 1 },
      { name: "stretch_map", out: st.attrStretch, live: !!params.stretch_map_live, unwired: 1 },
      { name: "tear_map", out: st.attrTear, live: !!params.tear_map_live, unwired: 0 },
      { name: "stick_map", out: st.attrStick, live: !!params.stick_map_live, unwired: 1 },
    ];
    const mapCache = (st.mapCache ??= {});
    for (const m of mapAttrs) {
      const buf = readMapBuffer(ctx, mapCache, m.name, inputs[m.name]);
      if (!buf) {
        if (reseeded) m.out.fill(m.unwired);
        continue;
      }
      if (reseeded || m.live) {
        fillAttrFromMap(buf, st.pos, st.count, m.out, W, H);
      }
    }
    if (reseeded) {
      const pinBuf = readMapBuffer(ctx, mapCache, "pin_map", inputs.pin_map);
      if (pinBuf) {
        for (let i = 0; i < st.count; i++) {
          if (sampleMap(pinBuf, st.pos[i * 2] / W, st.pos[i * 2 + 1] / H) >= 0.5) {
            st.invMass[i] = 0;
          }
        }
      }
      // Point capture: each input point grabs the nearest still-free
      // particle within pin_radius (greedy, one particle per point).
      // Points are authored-space, like the splines.
      if (pinPts) {
        for (let k = 0; k < pinPts.count; k++) {
          const px = pinPts.positions[k * 2] * W;
          const py = authoredToPxY(pinPts.positions[k * 2 + 1], W, H);
          let best = -1;
          let bestD = pinRadius;
          for (let i = 0; i < st.count; i++) {
            if (st.pinPointIdx[i] >= 0) continue;
            const d = Math.hypot(st.pos[i * 2] - px, st.pos[i * 2 + 1] - py);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          if (best >= 0) {
            st.pinPointIdx[best] = k;
            st.invMass[best] = 0;
          }
        }
      }
      // follow_input targets: every ends/map-pinned particle records
      // where it sits along its source subpath (recorded always, so
      // the toggle works mid-run without a reseed; point-pins win).
      for (const c of st.chains) {
        const div = c.closed ? c.count : c.count - 1;
        for (let i = 0; i < c.count; i++) {
          const g = c.start + i;
          if (st.invMass[g] !== 0 || st.pinPointIdx[g] >= 0) continue;
          st.followSub[g] = c.srcIndex;
          st.followT[g] = div > 0 ? i / div : 0;
        }
      }
    }

    const forces = gatherDescriptors<ForceDescriptor>(
      inputs,
      "force",
      MAX_FORCE_SLOTS,
      (v) => (v.kind === "force" ? v.descriptor : null)
    );
    const rawColliders = gatherDescriptors<ColliderDescriptor>(
      inputs,
      "collider",
      MAX_COLLIDER_SLOTS,
      (v) => (v.kind === "collider" ? v.descriptor : null)
    );
    // Pack colliders (kernel): image_mask reads its alpha to CPU, cached
    // per slot while the mask's ImageValue identity is unchanged. A
    // kill-mode mask acts as a plain solid for ropes (a chain can't lose
    // one particle; tearing handles breaks, not kills).
    const colliders: PackedCollider[] = packColliders(
      ctx,
      rawColliders,
      (st.maskCache ??= [])
    );

    const { pos, prev, invMass, count } = st;
    const h = fixedDt / substeps;
    // Frame-rate/substep-independent damping: `damping` is the fraction
    // of velocity lost per 60fps frame.
    const dampFactor = Math.pow(1 - Math.min(damping, 0.999), h * 60);
    const vel = new Float32Array(2); // scratch, UV/sec
    const pp = new Float32Array(4); // scratch [u, v, velU, velV]
    const hasContacts = colliders.length > 0 || boundsMode !== "off";

    // Animated pin targets, applied once per eval: point-pins snap to
    // their point's CURRENT position (drag the points, drag the rope);
    // follow_input pins re-sample the live input spline at their
    // recorded arc-length fraction, so keyframed spline animation
    // drives the rope with secondary motion on top.
    if (pinPts) {
      for (let i = 0; i < count; i++) {
        const k = st.pinPointIdx[i];
        if (k < 0 || k >= pinPts.count) continue;
        pos[i * 2] = prev[i * 2] = pinPts.positions[k * 2] * W;
        pos[i * 2 + 1] = prev[i * 2 + 1] = authoredToPxY(
          pinPts.positions[k * 2 + 1],
          W,
          H
        );
      }
    }
    if (followInput) {
      const denseCache = new Map<number, Array<[number, number]>>();
      for (let i = 0; i < count; i++) {
        if (invMass[i] !== 0 || st.followSub[i] < 0 || st.pinPointIdx[i] >= 0) {
          continue;
        }
        const si = st.followSub[i];
        const sub = src.subpaths[si];
        if (!sub) continue;
        let dense = denseCache.get(si);
        if (!dense) {
          const rs = resampleSubpath(
            subpathToCanvasPx(sub, W, H),
            Math.min(2048, Math.max(sub.anchors.length * 8, 32))
          );
          dense = rs.anchors.map((a) => a.pos);
          denseCache.set(si, dense);
        }
        const p = samplePolylineAt(dense, sub.closed, st.followT[i]);
        pos[i * 2] = prev[i * 2] = p[0];
        pos[i * 2 + 1] = prev[i * 2 + 1] = p[1];
      }
    }

    const stepCount = active ? substeps : 0;
    for (let s = 0; s < stepCount; s++) {
      // Integrate: recover velocity from Verlet positions (AUTHORED
      // units/sec — both axes are W px, so the shared force descriptors
      // keep Particle Simulator units at any aspect), damp, apply
      // gravity + forces at the particle's authored position, advance.
      for (let i = 0; i < count; i++) {
        if (invMass[i] === 0) {
          prev[i * 2] = pos[i * 2];
          prev[i * 2 + 1] = pos[i * 2 + 1];
          continue;
        }
        vel[0] = ((pos[i * 2] - prev[i * 2]) / (h * W)) * dampFactor;
        vel[1] = ((pos[i * 2 + 1] - prev[i * 2 + 1]) / (h * W)) * dampFactor;
        vel[0] += gx * h;
        vel[1] += gy * h;
        const u = pos[i * 2] / W;
        const v = pxToAuthoredY(pos[i * 2 + 1], W, H);
        for (const f of forces) applyForceCpu(f, u, v, vel, h, ctx.time);
        prev[i * 2] = pos[i * 2];
        prev[i * 2 + 1] = pos[i * 2 + 1];
        pos[i * 2] += vel[0] * h * W;
        pos[i * 2 + 1] += vel[1] * h * W;
      }

      // Constraint relaxation (px space). Distance constraints are
      // XPBD: compliance α maps off stretchiness (α = (s·mean stretch
      // attr)² × 1e-3 px/force-unit, α̃ = α/h² per the XPBD paper, so
      // stiffness is substep-rate independent), and the λ accumulator
      // makes the softness iteration-robust — the rope elongates to
      // elastic equilibrium under load and springs back. s = 0 keeps
      // α̃ = 0, which is exactly rigid PBD projection.
      st.edgeLambda.fill(0);
      const invH2 = 1 / (h * h);
      for (let it = 0; it < iterations; it++) {
        for (let e = 0; e < st.edgeCount; e++) {
          if (!st.edgeAlive[e]) continue;
          const a = st.edgeA[e];
          const b = st.edgeB[e];
          const wA = invMass[a];
          const wB = invMass[b];
          const wSum = wA + wB;
          if (wSum === 0) continue;
          const dx = pos[b * 2] - pos[a * 2];
          const dy = pos[b * 2 + 1] - pos[a * 2 + 1];
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          const s = stretchiness * 0.5 * (st.attrStretch[a] + st.attrStretch[b]);
          const alphaTilde = s > 0 ? s * s * 1e-3 * invH2 : 0;
          const C = len - st.edgeRest[e];
          const dLambda =
            (-C - alphaTilde * st.edgeLambda[e]) / (wSum + alphaTilde);
          st.edgeLambda[e] += dLambda;
          const nx = dx / len;
          const ny = dy / len;
          pos[a * 2] -= nx * dLambda * wA;
          pos[a * 2 + 1] -= ny * dLambda * wA;
          pos[b * 2] += nx * dLambda * wB;
          pos[b * 2 + 1] += ny * dLambda * wB;
        }
        if (stiffness > 0) {
          for (let e = 0; e < st.bendCount; e++) {
            if (!st.edgeAlive[st.bendE1[e]] || !st.edgeAlive[st.bendE2[e]]) {
              continue; // torn rope isn't stiff across the break
            }
            const a = st.bendA[e];
            const b = st.bendB[e];
            const wA = invMass[a];
            const wB = invMass[b];
            const wSum = wA + wB;
            if (wSum === 0) continue;
            const dx = pos[b * 2] - pos[a * 2];
            const dy = pos[b * 2 + 1] - pos[a * 2 + 1];
            const len = Math.hypot(dx, dy);
            // One-sided: only resist folding (i↔i+2 shorter than rest).
            // Longer can't happen while the two edges hold, so a
            // two-sided constraint would only fight them.
            if (len < 1e-6 || len >= st.bendRest[e]) continue;
            const diff = ((len - st.bendRest[e]) / (len * wSum)) * stiffness;
            pos[a * 2] += dx * diff * wA;
            pos[a * 2 + 1] += dy * diff * wA;
            pos[b * 2] -= dx * diff * wB;
            pos[b * 2 + 1] -= dy * diff * wB;
          }
        }
      }

      // Contact response in UV space, shader-identical math. Velocity
      // is re-derived from the constrained positions, reflected, and
      // written back through `prev` (PBD-style).
      if (hasContacts) {
        for (let i = 0; i < count; i++) {
          if (invMass[i] === 0) continue;
          const fr = friction * st.attrFriction[i];
          const bo = bounciness * st.attrBounce[i];
          pp[0] = pos[i * 2] / W;
          pp[1] = pos[i * 2 + 1] / H;
          pp[2] = (pos[i * 2] - prev[i * 2]) / (h * W);
          pp[3] = (pos[i * 2 + 1] - prev[i * 2 + 1]) / (h * H);
          const hit = resolveCollidersCpu(colliders, pp, fr, bo, aspect);
          resolveBoundsCpu(boundsMode, boundsRestitution, pp, fr, bo);
          pos[i * 2] = pp[0] * W;
          pos[i * 2 + 1] = pp[1] * H;
          prev[i * 2] = pos[i * 2] - pp[2] * h * W;
          prev[i * 2 + 1] = pos[i * 2 + 1] - pp[3] * h * H;
          // Sticky weld creation: a sticking particle anchors to the
          // collider it touched (circle: offset from center, so an
          // animated collider carries it; line: point re-projected
          // onto the moving plane; mask: world point). Circle/line
          // anchors live in the descriptors' AUTHORED space; mask
          // anchors in canvas UV — weldKind disambiguates.
          const stickEff = stickiness * st.attrStick[i];
          if (hit >= 0 && stickEff > 0.001 && st.weldSlot[i] < 0) {
            const c = colliders[hit];
            const av = 0.5 + (pp[1] - 0.5) / aspect;
            st.weldSlot[i] = hit;
            if (c.kind === "circle") {
              st.weldKind[i] = 0;
              st.weldAx[i] = pp[0] - c.cx;
              st.weldAy[i] = av - c.cy;
            } else if (c.kind === "line") {
              st.weldKind[i] = 1;
              st.weldAx[i] = pp[0];
              st.weldAy[i] = av;
            } else {
              st.weldKind[i] = 2;
              st.weldAx[i] = pp[0];
              st.weldAy[i] = pp[1];
            }
          }
        }
      }

      if (selfCollide) {
        resolveSelfCollisions(st, thickness, friction, W, H);
      }

      // Weld enforcement: measure how far this substep's forces +
      // constraints dragged a stuck particle off its anchor. Within
      // the break length it snaps back (position AND velocity); past
      // it, the weld releases — and a still-touching particle simply
      // re-welds at the new contact, giving stick-slip sliding.
      for (let i = 0; i < count; i++) {
        const slot = st.weldSlot[i];
        if (slot < 0) continue;
        const stickEff = stickiness * st.attrStick[i];
        const c = colliders[slot];
        const kindOk =
          c &&
          ((st.weldKind[i] === 0 && c.kind === "circle") ||
            (st.weldKind[i] === 1 && c.kind === "line") ||
            (st.weldKind[i] === 2 && c.kind === "mask"));
        if (!kindOk || stickEff <= 0.001) {
          st.weldSlot[i] = -1;
          continue;
        }
        let ax: number;
        let ay: number;
        if (c.kind === "circle") {
          ax = c.cx + st.weldAx[i];
          ay = c.cy + st.weldAy[i];
        } else if (c.kind === "line") {
          const dd = c.nx * st.weldAx[i] + c.ny * st.weldAy[i] - c.d;
          ax = st.weldAx[i] - dd * c.nx;
          ay = st.weldAy[i] - dd * c.ny;
          st.weldAx[i] = ax;
          st.weldAy[i] = ay;
        } else {
          ax = st.weldAx[i];
          ay = st.weldAy[i];
        }
        const axPx = ax * W;
        // Mask anchors are canvas UV; circle/line anchors are authored.
        const ayPx = st.weldKind[i] === 2 ? ay * H : authoredToPxY(ay, W, H);
        const drift = Math.hypot(pos[i * 2] - axPx, pos[i * 2 + 1] - ayPx);
        if (drift > stickEff * stickStrength) {
          st.weldSlot[i] = -1;
        } else {
          pos[i * 2] = axPx;
          pos[i * 2 + 1] = ayPx;
          prev[i * 2] = axPx;
          prev[i * 2 + 1] = ayPx;
        }
      }
    }

    // Tearing: an edge whose post-solve strain exceeds its effective
    // threshold breaks. The tear map is a WEAKNESS field: threshold ×
    // (1 − max endpoint weakness), so white tears at a touch and
    // unwired/black keeps the base threshold.
    const tearUv: number[] = [];
    if (tearing && active) {
      for (let e = 0; e < st.edgeCount; e++) {
        if (!st.edgeAlive[e] || st.edgeRest[e] < 1e-6) continue;
        const a = st.edgeA[e];
        const b = st.edgeB[e];
        const len = Math.hypot(
          pos[b * 2] - pos[a * 2],
          pos[b * 2 + 1] - pos[a * 2 + 1]
        );
        const strain = (len - st.edgeRest[e]) / st.edgeRest[e];
        const weak = Math.min(0.995, Math.max(st.attrTear[a], st.attrTear[b]));
        if (strain > tearThreshold * (1 - weak)) {
          st.edgeAlive[e] = 0;
          tearUv.push(
            (pos[a * 2] + pos[b * 2]) / 2 / W,
            pxToAuthoredY((pos[a * 2 + 1] + pos[b * 2 + 1]) / 2, W, H)
          );
        }
      }
    }

    // ---- outputs ----
    // Rebuild subpaths from ALIVE edges: an untorn chain is one run;
    // each dead edge splits it. A torn closed chain opens (runs wrap
    // around the seam between dead edges). Single-particle runs are
    // dropped from the spline (nothing to draw) but stay in aux points.
    const subpaths: SplineSubpath[] = [];
    for (const c of st.chains) {
      const runs: number[][] = [];
      let stillClosed = c.closed;
      if (!c.closed) {
        let run: number[] = [c.start];
        for (let i = 0; i < c.count - 1; i++) {
          if (st.edgeAlive[c.edgeBase + i]) {
            run.push(c.start + i + 1);
          } else {
            runs.push(run);
            run = [c.start + i + 1];
          }
        }
        runs.push(run);
      } else {
        const dead: number[] = [];
        for (let i = 0; i < c.count; i++) {
          if (!st.edgeAlive[c.edgeBase + i]) dead.push(i);
        }
        if (dead.length === 0) {
          const all: number[] = [];
          for (let i = 0; i < c.count; i++) all.push(c.start + i);
          runs.push(all);
        } else {
          stillClosed = false;
          for (let k = 0; k < dead.length; k++) {
            // Run from the particle after this dead edge to the first
            // particle of the next one (edge i joins i → (i+1)%n).
            const until = dead[(k + 1) % dead.length];
            const run: number[] = [];
            let i = (dead[k] + 1) % c.count;
            for (;;) {
              run.push(c.start + i);
              if (i === until) break;
              i = (i + 1) % c.count;
            }
            runs.push(run);
          }
        }
      }
      for (const run of runs) {
        if (run.length < 2) continue;
        const uvPts: [number, number][] = run.map((g) => [
          pos[g * 2] / W,
          pxToAuthoredY(pos[g * 2 + 1], W, H),
        ]);
        const sp: SplineSubpath =
          outputMode === "polyline"
            ? { anchors: uvPts.map((p) => ({ pos: p })), closed: stillClosed }
            : catmullRomSubpath(uvPts, stillClosed);
        if (c.srcGroup !== undefined) sp.groupIndex = c.srcGroup;
        subpaths.push(sp);
      }
    }

    const out: { primary: SplineValue; aux?: Record<string, SocketValue> } = {
      primary: { kind: "spline", subpaths },
    };

    const aux: Record<string, SocketValue> = {};
    if (!consumedOutputs || consumedOutputs.has("aux:points")) {
      const pts = makePoints(count, { withGroupIndices: true });
      for (let i = 0; i < count; i++) {
        pts.positions[i * 2] = pos[i * 2] / W;
        pts.positions[i * 2 + 1] = pxToAuthoredY(pos[i * 2 + 1], W, H);
      }
      for (const c of st.chains) {
        for (let i = 0; i < c.count; i++) {
          pts.groupIndices![c.start + i] = c.srcIndex;
        }
      }
      aux.points = pts;
    }
    if (!consumedOutputs || consumedOutputs.has("aux:tears")) {
      const tearPts = makePoints(tearUv.length / 2);
      tearPts.positions.set(tearUv);
      aux.tears = tearPts;
    }
    if (Object.keys(aux).length > 0) out.aux = aux;

    return out;
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
