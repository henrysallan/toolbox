import type {
  ColliderDescriptor,
  ForceDescriptor,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketValue,
  SplineAnchor,
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

// Rigid Body Simulator — 2D rigid body dynamics over splines.
// Spec: specdocs/072026_rigid-body-simulator.md.
//
// Each input subpath becomes one BODY: its particles are pulled toward
// the best-fit rigid transform of their rest shape every constraint
// iteration (Müller-style shape matching), instead of the Rope
// Simulator's chain constraints. Rigidity 1 is a pure projection
// (perfectly rigid, output = the original beziers under the fitted
// rotation + translation); below 1 the pull is partial (jelly) and the
// output rebuilds from particles. Open subpaths are rigid bent wires;
// closed subpaths collide as boundary shells (containers work).
//
// Body↔body collision is the headline (owner priority): particles test
// against the SEGMENTS of other bodies (edge capsules) — not just other
// particles — so coarsely-sampled straight edges stay solid. Contact
// pairs are discovered once per substep via the kernel spatial hash,
// then RE-PROJECTED every iteration interleaved with the shape match:
// matching pulls particles back into body shape, contacts push bodies
// apart, and they must converge together or stacks breathe and jitter.
//
// Glue is the rope's tear, inverted: while `glue` > 0, a body↔body
// contact mints a particle↔particle distance bond (rest = the contact
// distance) that holds the bodies together; a bond strained past
// `glue_break × its strength` snaps, emitting a point on the `snaps`
// aux output that frame. The glue map scales bond strength per particle
// (a strength field — weaker glue breaks sooner).
//
// Forces/colliders/bounds/maps ride the shared sim kernel (same
// descriptor nodes, same CPU math as the rope — a collider feels
// identical in every sim). Coordinate spaces follow the rope
// convention (see sim-kernel.ts header): geometry sockets are AUTHORED
// space, solver in true canvas-px Y-down, bounds/masks in canvas UV,
// force + analytic-collider descriptors evaluated in authored coords.
// Stepping follows the house sim contract: playback evals advance,
// paused evals re-emit without stepping.

const MAX_FORCE_SLOTS = 6;
const MAX_COLLIDER_SLOTS = 6;
// Pinned particles anchor the shape-match fit with a large finite
// weight (invMass 0 already makes them immovable): one pin = the fit
// rotates about it (hinge/pendulum), two+ = effectively frozen.
const PIN_FIT_WEIGHT = 1e4;
// Contacts are considered "still touching" for the velocity-response
// pass a hair beyond the projection distance — after projection pairs
// sit exactly AT thickness, and the response must still see them.
const CONTACT_SLACK = 1.05;
const MAX_BONDS_PER_PARTICLE = 4;

interface RigidBody {
  start: number; // first particle index
  count: number;
  closed: boolean;
  srcIndex: number; // source subpath index (aux groupIndex)
  srcGroup?: number; // source subpath's own groupIndex tag, if any
  // Fit-weighted rest centroid (px) and Σ fit weights, finalized at
  // reseed AFTER all pinning (pins carry PIN_FIT_WEIGHT, so they move
  // the weighted centroid).
  restCx: number;
  restCy: number;
  weightSum: number;
  // The original subpath scaled to px — the exact-output source: at
  // rigidity 1 these anchors transform by the fitted (R, t) verbatim.
  srcAnchorsPx: SplineAnchor[];
  // Current fitted transform (updated by every fit; read at output).
  angle: number;
  cx: number;
  cy: number;
}

interface RigidSimState {
  count: number;
  // Interleaved px-space positions, current + previous (Verlet).
  pos: Float32Array;
  prev: Float32Array;
  invMass: Float32Array; // 0 = pinned
  fitWeight: Float32Array; // 1 free / PIN_FIT_WEIGHT pinned
  // Rest positions relative to each body's weighted rest centroid (px).
  restLocal: Float32Array;
  bodies: RigidBody[];
  particleBody: Int32Array;
  // Per-particle material attrs: base param × map sample (unwired = 1).
  attrFriction: Float32Array;
  attrBounce: Float32Array;
  attrGlue: Float32Array;
  // Contact records, discovered once per substep, re-projected every
  // iteration. conB = -1 marks a particle↔particle pair (self-collision);
  // otherwise (conA, conB) is the edge the particle conP presses on.
  conP: Int32Array;
  conA: Int32Array;
  conB: Int32Array;
  conCount: number;
  // Glue bonds: particle↔particle distance constraints minted at
  // body↔body contacts, killed by strain (flat arrays + alive flags,
  // the rope's tear machinery inverted). bondStrength = the pair's
  // effective glue at mint time; the break threshold scales by it.
  bondP: Int32Array;
  bondQ: Int32Array;
  bondRest: Float32Array;
  bondStrength: Float32Array;
  bondAlive: Uint8Array;
  bondCount: number;
  bondDead: number;
  bondNum: Uint8Array; // live bonds per particle (cap 4)
  bondKeys: Set<number>; // live pair keys (min·count + max)
  // Pin-to-points: which input point each captured particle tracks
  // (−1 = not point-pinned); captured greedily at reseed, snapped to
  // the point's CURRENT position each eval (puppet-dragging).
  pinPointIdx: Int32Array;
  // follow_input targets: ends/map-pinned particles record their
  // source subpath + arc-length fraction at seed; with follow_input on
  // they re-sample the LIVE input spline there each eval.
  followSub: Int32Array;
  followT: Float32Array;
  hash?: SpatialHash;
  seedSig: string;
  lastTime: number;
  width: number;
  height: number;
  maskCache?: Array<MaskColliderCacheEntry | undefined>;
  mapCache?: Record<string, MapCacheEntry | undefined>;
}

function stateKey(nodeId: string): string {
  return `rigid-body-simulator:${nodeId}`;
}

// ---- seeding ---------------------------------------------------------

function seedState(
  src: SplineValue,
  segPx: number,
  maxPoints: number,
  pinMode: string,
  W: number,
  H: number,
  seedSig: string
): RigidSimState {
  interface Seeded {
    pts: number[]; // interleaved px positions
    closed: boolean;
    srcIndex: number;
    srcGroup?: number;
    srcAnchorsPx: SplineAnchor[];
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
    seeded.push({
      pts,
      closed: sub.closed,
      srcIndex: si,
      srcGroup: sub.groupIndex,
      srcAnchorsPx: pxSub.anchors,
    });
    total += count;
    if (total >= maxPoints) break;
  }

  const count = seeded.reduce((n, s) => n + s.pts.length / 2, 0);
  const pos = new Float32Array(count * 2);
  const prev = new Float32Array(count * 2);
  const invMass = new Float32Array(count).fill(1);
  const fitWeight = new Float32Array(count).fill(1);
  const particleBody = new Int32Array(count);
  const bodies: RigidBody[] = [];

  let cursor = 0;
  for (const s of seeded) {
    const n = s.pts.length / 2;
    const start = cursor;
    pos.set(s.pts, start * 2);
    prev.set(s.pts, start * 2);
    particleBody.fill(bodies.length, start, start + n);
    if (!s.closed) {
      if (pinMode === "start" || pinMode === "both") {
        invMass[start] = 0;
        fitWeight[start] = PIN_FIT_WEIGHT;
      }
      if (pinMode === "end" || pinMode === "both") {
        invMass[start + n - 1] = 0;
        fitWeight[start + n - 1] = PIN_FIT_WEIGHT;
      }
    }
    bodies.push({
      start,
      count: n,
      closed: s.closed,
      srcIndex: s.srcIndex,
      srcGroup: s.srcGroup,
      restCx: 0,
      restCy: 0,
      weightSum: 1,
      srcAnchorsPx: s.srcAnchorsPx,
      angle: 0,
      cx: 0,
      cy: 0,
    });
    cursor += n;
  }

  return {
    count,
    pos,
    prev,
    invMass,
    fitWeight,
    restLocal: new Float32Array(count * 2),
    bodies,
    particleBody,
    attrFriction: new Float32Array(count).fill(1),
    attrBounce: new Float32Array(count).fill(1),
    attrGlue: new Float32Array(count).fill(1),
    conP: new Int32Array(256),
    conA: new Int32Array(256),
    conB: new Int32Array(256),
    conCount: 0,
    bondP: new Int32Array(64),
    bondQ: new Int32Array(64),
    bondRest: new Float32Array(64),
    bondStrength: new Float32Array(64),
    bondAlive: new Uint8Array(64),
    bondCount: 0,
    bondDead: 0,
    bondNum: new Uint8Array(count),
    bondKeys: new Set<number>(),
    pinPointIdx: new Int32Array(count).fill(-1),
    followSub: new Int32Array(count).fill(-1),
    followT: new Float32Array(count),
    seedSig,
    lastTime: 0,
    width: W,
    height: H,
  };
}

// Recompute every body's fit-weighted rest centroid + restLocal from the
// SEED positions. Runs at reseed AFTER all pinning (ends, pin map,
// point capture) has assigned fit weights — a pin shifts the weighted
// centroid, which is what anchors the fit to it.
function finalizeRestGeometry(st: RigidSimState): void {
  const { pos, fitWeight, restLocal } = st;
  for (const body of st.bodies) {
    const end = body.start + body.count;
    let wsum = 0;
    let rcx = 0;
    let rcy = 0;
    for (let i = body.start; i < end; i++) {
      const w = fitWeight[i];
      wsum += w;
      rcx += w * pos[i * 2];
      rcy += w * pos[i * 2 + 1];
    }
    rcx /= wsum;
    rcy /= wsum;
    for (let i = body.start; i < end; i++) {
      restLocal[i * 2] = pos[i * 2] - rcx;
      restLocal[i * 2 + 1] = pos[i * 2 + 1] - rcy;
    }
    body.restCx = rcx;
    body.restCy = rcy;
    body.weightSum = wsum;
    body.angle = 0;
    body.cx = rcx;
    body.cy = rcy;
  }
}

// ---- shape matching --------------------------------------------------

// Weighted best-fit rigid transform of a body's rest shape onto its
// current particles, then pull every free particle toward its goal by
// k. 2D makes the polar decomposition closed form: θ maximizes
// Σ w p′·(R q′), giving θ = atan2(Σ w (p′y q′x − p′x q′y), Σ w p′·q′)
// — one atan2 over two accumulated sums, no SVD. k = 1 (rigidity 1) is
// an idempotent projection; the caller pre-computes the
// iteration-independent k for softer bodies. Updates the body's stored
// (angle, cx, cy) so the output transform is always the latest fit.
function shapeMatchBody(st: RigidSimState, body: RigidBody, k: number): void {
  const { pos, restLocal, fitWeight, invMass } = st;
  const end = body.start + body.count;
  let cx = 0;
  let cy = 0;
  for (let i = body.start; i < end; i++) {
    const w = fitWeight[i];
    cx += w * pos[i * 2];
    cy += w * pos[i * 2 + 1];
  }
  cx /= body.weightSum;
  cy /= body.weightSum;
  let S = 0;
  let T = 0;
  for (let i = body.start; i < end; i++) {
    const w = fitWeight[i];
    const px = pos[i * 2] - cx;
    const py = pos[i * 2 + 1] - cy;
    const qx = restLocal[i * 2];
    const qy = restLocal[i * 2 + 1];
    S += w * (px * qx + py * qy);
    T += w * (py * qx - px * qy);
  }
  // Degenerate fit (all particles coincident): hold the last angle
  // rather than snapping to 0.
  const angle = Math.abs(S) + Math.abs(T) > 1e-9 ? Math.atan2(T, S) : body.angle;
  body.angle = angle;
  body.cx = cx;
  body.cy = cy;
  if (k === 0) return; // fit-only call (output transform refresh)
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = body.start; i < end; i++) {
    if (invMass[i] === 0) continue;
    const qx = restLocal[i * 2];
    const qy = restLocal[i * 2 + 1];
    const gx = c * qx - s * qy + cx;
    const gy = s * qx + c * qy + cy;
    pos[i * 2] += (gx - pos[i * 2]) * k;
    pos[i * 2 + 1] += (gy - pos[i * 2 + 1]) * k;
  }
}

// ---- contacts ----------------------------------------------------------

// Grow-on-demand contact push (flat parallel arrays, reused).
function pushContact(
  st: RigidSimState,
  p: number,
  a: number,
  b: number
): number {
  if (st.conCount === st.conP.length) {
    const cap = st.conP.length * 2;
    const np = new Int32Array(cap);
    const na = new Int32Array(cap);
    const nb = new Int32Array(cap);
    np.set(st.conP);
    na.set(st.conA);
    nb.set(st.conB);
    st.conP = np;
    st.conA = na;
    st.conB = nb;
  }
  const slot = st.conCount++;
  st.conP[slot] = p;
  st.conA[slot] = a;
  st.conB[slot] = b;
  return slot;
}

// Discover contact pairs for this substep: particle↔edge across bodies
// (the capsule test that keeps coarse edges solid), particle↔particle
// within a body (soft-body self-folding). Edge contacts dedupe per
// (particle, other body) keeping only the DEEPEST — a particle near a
// corner otherwise gets pushed by both adjoining edges and pops.
function discoverContacts(
  st: RigidSimState,
  thickness: number,
  bodyCollide: boolean,
  selfCollide: boolean,
  W: number,
  H: number
): void {
  st.conCount = 0;
  const { pos, bodies, particleBody, count } = st;
  const hash = (st.hash = buildSpatialHash(
    pos,
    count,
    thickness,
    W,
    H,
    st.hash
  ));
  const { counts, entries, gw, gh, cell } = hash;
  const nBodies = bodies.length;

  if (bodyCollide && nBodies > 1) {
    // key = particle * nBodies + otherBodyIndex → contact slot; depth
    // tracked alongside so a deeper edge of the same body replaces the
    // shallower one in place.
    const best = new Map<number, number>();
    const bestDepth = new Map<number, number>();
    for (let bi = 0; bi < nBodies; bi++) {
      const body = bodies[bi];
      const edgeCount = body.count - 1 + (body.closed ? 1 : 0);
      for (let e = 0; e < edgeCount; e++) {
        const a = body.start + e;
        const b = e === body.count - 1 ? body.start : body.start + e + 1;
        const ax = pos[a * 2];
        const ay = pos[a * 2 + 1];
        const bx = pos[b * 2];
        const by = pos[b * 2 + 1];
        const minCx = Math.max(
          0,
          Math.floor((Math.min(ax, bx) - thickness) / cell)
        );
        const maxCx = Math.min(
          gw - 1,
          Math.floor((Math.max(ax, bx) + thickness) / cell)
        );
        const minCy = Math.max(
          0,
          Math.floor((Math.min(ay, by) - thickness) / cell)
        );
        const maxCy = Math.min(
          gh - 1,
          Math.floor((Math.max(ay, by) + thickness) / cell)
        );
        const ex = bx - ax;
        const ey = by - ay;
        const eLen2 = ex * ex + ey * ey;
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cxc = minCx; cxc <= maxCx; cxc++) {
            const c = cy * gw + cxc;
            for (let k = cellStart(hash, c); k < counts[c]; k++) {
              const p = entries[k];
              if (particleBody[p] === bi) continue;
              const px = pos[p * 2];
              const py = pos[p * 2 + 1];
              let t = 0;
              if (eLen2 > 1e-9) {
                t = ((px - ax) * ex + (py - ay) * ey) / eLen2;
                t = Math.max(0, Math.min(1, t));
              }
              const dx = px - (ax + ex * t);
              const dy = py - (ay + ey * t);
              const d = Math.hypot(dx, dy);
              if (d >= thickness) continue;
              const depth = thickness - d;
              const key = p * nBodies + bi;
              const prevDepth = bestDepth.get(key);
              if (prevDepth === undefined) {
                bestDepth.set(key, depth);
                best.set(key, pushContact(st, p, a, b));
              } else if (depth > prevDepth) {
                const slot = best.get(key)!;
                bestDepth.set(key, depth);
                st.conA[slot] = a;
                st.conB[slot] = b;
              }
            }
          }
        }
      }
    }
  }

  if (selfCollide) {
    // Particle↔particle within a body, ring distance > 2 (adjacent
    // particles are held by the shape match; contacts would fight it).
    for (let i = 0; i < count; i++) {
      const bi = particleBody[i];
      const body = bodies[bi];
      const cx = Math.max(0, Math.min(gw - 1, Math.floor(pos[i * 2] / cell)));
      const cy = Math.max(
        0,
        Math.min(gh - 1, Math.floor(pos[i * 2 + 1] / cell))
      );
      for (let oy = -1; oy <= 1; oy++) {
        const yy = cy + oy;
        if (yy < 0 || yy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = cx + ox;
          if (xx < 0 || xx >= gw) continue;
          const c = yy * gw + xx;
          for (let k = cellStart(hash, c); k < counts[c]; k++) {
            const j = entries[k];
            if (j <= i || particleBody[j] !== bi) continue;
            const la = i - body.start;
            const lb = j - body.start;
            let rd = Math.abs(la - lb);
            if (body.closed) rd = Math.min(rd, body.count - rd);
            if (rd <= 2) continue;
            const dx = pos[j * 2] - pos[i * 2];
            const dy = pos[j * 2 + 1] - pos[i * 2 + 1];
            if (Math.hypot(dx, dy) >= thickness) continue;
            pushContact(st, i, j, -1);
          }
        }
      }
    }
  }
}

// Position-level projection of every cached contact — run EVERY
// iteration, interleaved with the shape match (the stacking-stability
// lever; see file header). Geometry (closest point, normal, depth) is
// recomputed from current positions each pass.
function projectContacts(st: RigidSimState, thickness: number): void {
  const { pos, invMass, conP, conA, conB, conCount } = st;
  for (let k = 0; k < conCount; k++) {
    const p = conP[k];
    const a = conA[k];
    const b = conB[k];
    if (b < 0) {
      // particle↔particle (self-collision)
      const wP = invMass[p];
      const wA = invMass[a];
      const wSum = wP + wA;
      if (wSum === 0) continue;
      const dx = pos[a * 2] - pos[p * 2];
      const dy = pos[a * 2 + 1] - pos[p * 2 + 1];
      const d = Math.hypot(dx, dy);
      if (d >= thickness || d < 1e-6) continue;
      const push = (thickness - d) / d / wSum;
      pos[p * 2] -= dx * push * wP;
      pos[p * 2 + 1] -= dy * push * wP;
      pos[a * 2] += dx * push * wA;
      pos[a * 2 + 1] += dy * push * wA;
      continue;
    }
    // particle↔edge: C = |p − closest(seg)| − thickness < 0. Gradients
    // ∂C/∂p = n, ∂C/∂a = −n(1−t), ∂C/∂b = −n·t → the standard PBD
    // point–edge split with generalized inverse mass
    // wP + wA(1−t)² + wB t².
    const ax = pos[a * 2];
    const ay = pos[a * 2 + 1];
    const ex = pos[b * 2] - ax;
    const ey = pos[b * 2 + 1] - ay;
    const eLen2 = ex * ex + ey * ey;
    let t = 0;
    if (eLen2 > 1e-9) {
      t = ((pos[p * 2] - ax) * ex + (pos[p * 2 + 1] - ay) * ey) / eLen2;
      t = Math.max(0, Math.min(1, t));
    }
    const dx = pos[p * 2] - (ax + ex * t);
    const dy = pos[p * 2 + 1] - (ay + ey * t);
    const d = Math.hypot(dx, dy);
    if (d >= thickness || d < 1e-6) continue;
    const nx = dx / d;
    const ny = dy / d;
    const wP = invMass[p];
    const wA = invMass[a] * (1 - t);
    const wB = invMass[b] * t;
    const denom = wP + wA * (1 - t) + wB * t;
    if (denom === 0) continue;
    const s = (thickness - d) / denom;
    pos[p * 2] += nx * s * wP;
    pos[p * 2 + 1] += ny * s * wP;
    pos[a * 2] -= nx * s * wA;
    pos[a * 2 + 1] -= ny * s * wA;
    pos[b * 2] -= nx * s * wB;
    pos[b * 2 + 1] -= ny * s * wB;
  }
}

// Velocity-level response, once per substep after the position solve:
// pair friction damps relative tangential velocity; restitution
// reflects an approaching relative normal velocity. Both write through
// `prev` (velocity change with no position change — the Verlet trick),
// split by the same weights as the projection. Pair material values are
// the endpoints' attr averages × the base params.
function contactVelocityResponse(
  st: RigidSimState,
  thickness: number,
  friction: number,
  bounciness: number
): void {
  if (friction <= 0 && bounciness <= 0) return;
  const { pos, prev, invMass, conP, conA, conB, conCount } = st;
  const attrF = st.attrFriction;
  const attrB = st.attrBounce;
  const touch = thickness * CONTACT_SLACK;
  for (let k = 0; k < conCount; k++) {
    const p = conP[k];
    const a = conA[k];
    const b = conB[k];
    const isPair = b < 0;
    const ax = pos[a * 2];
    const ay = pos[a * 2 + 1];
    let t = 0;
    let cxp: number;
    let cyp: number;
    if (isPair) {
      cxp = ax;
      cyp = ay;
    } else {
      const ex = pos[b * 2] - ax;
      const ey = pos[b * 2 + 1] - ay;
      const eLen2 = ex * ex + ey * ey;
      if (eLen2 > 1e-9) {
        t = ((pos[p * 2] - ax) * ex + (pos[p * 2 + 1] - ay) * ey) / eLen2;
        t = Math.max(0, Math.min(1, t));
      }
      cxp = ax + ex * t;
      cyp = ay + ey * t;
    }
    const dx = pos[p * 2] - cxp;
    const dy = pos[p * 2 + 1] - cyp;
    const d = Math.hypot(dx, dy);
    if (d >= touch || d < 1e-6) continue;
    const nx = dx / d;
    const ny = dy / d;
    const wP = invMass[p];
    const wA = isPair ? invMass[a] : invMass[a] * (1 - t);
    const wB = isPair ? 0 : invMass[b] * t;
    const denom = isPair ? wP + wA : wP + wA * (1 - t) + wB * t;
    if (denom === 0) continue;
    const otherF = isPair ? attrF[a] : attrF[a] * (1 - t) + attrF[b] * t;
    const otherB = isPair ? attrB[a] : attrB[a] * (1 - t) + attrB[b] * t;
    const fr = friction * 0.5 * (attrF[p] + otherF);
    const bo = bounciness * 0.5 * (attrB[p] + otherB);
    // Relative velocity (px per substep) of the particle against the
    // contact point on the other side.
    const vpx = pos[p * 2] - prev[p * 2];
    const vpy = pos[p * 2 + 1] - prev[p * 2 + 1];
    let vex: number;
    let vey: number;
    if (isPair) {
      vex = pos[a * 2] - prev[a * 2];
      vey = pos[a * 2 + 1] - prev[a * 2 + 1];
    } else {
      vex =
        (pos[a * 2] - prev[a * 2]) * (1 - t) + (pos[b * 2] - prev[b * 2]) * t;
      vey =
        (pos[a * 2 + 1] - prev[a * 2 + 1]) * (1 - t) +
        (pos[b * 2 + 1] - prev[b * 2 + 1]) * t;
    }
    const rvx = vpx - vex;
    const rvy = vpy - vey;
    const vn = rvx * nx + rvy * ny;
    // Desired change in RELATIVE velocity: kill friction × tangential;
    // reflect the normal part to −bounciness × vn when approaching.
    let dvx = -(rvx - vn * nx) * fr;
    let dvy = -(rvy - vn * ny) * fr;
    if (vn < 0 && bo > 0) {
      dvx += nx * -(1 + bo) * vn;
      dvy += ny * -(1 + bo) * vn;
    } else if (vn < 0) {
      // Perfectly inelastic: cancel the remaining approach so resting
      // stacks don't keep grinding into each other.
      dvx += nx * -vn;
      dvy += ny * -vn;
    }
    // v = pos − prev, so adding Δv to a particle means prev −= Δv.
    prev[p * 2] -= dvx * (wP / denom);
    prev[p * 2 + 1] -= dvy * (wP / denom);
    if (isPair) {
      prev[a * 2] += dvx * (wA / denom);
      prev[a * 2 + 1] += dvy * (wA / denom);
    } else {
      // wA/wB already carry the barycentric factors (invMass × share).
      prev[a * 2] += (dvx * wA) / denom;
      prev[a * 2 + 1] += (dvy * wA) / denom;
      prev[b * 2] += (dvx * wB) / denom;
      prev[b * 2 + 1] += (dvy * wB) / denom;
    }
  }
}

// ---- glue bonds --------------------------------------------------------

function pushBond(
  st: RigidSimState,
  p: number,
  q: number,
  rest: number,
  strength: number
): void {
  if (st.bondCount === st.bondP.length) {
    const cap = st.bondP.length * 2;
    const np = new Int32Array(cap);
    const nq = new Int32Array(cap);
    const nr = new Float32Array(cap);
    const ns = new Float32Array(cap);
    const na = new Uint8Array(cap);
    np.set(st.bondP);
    nq.set(st.bondQ);
    nr.set(st.bondRest);
    ns.set(st.bondStrength);
    na.set(st.bondAlive);
    st.bondP = np;
    st.bondQ = nq;
    st.bondRest = nr;
    st.bondStrength = ns;
    st.bondAlive = na;
  }
  const slot = st.bondCount++;
  st.bondP[slot] = p;
  st.bondQ[slot] = q;
  st.bondRest[slot] = rest;
  st.bondStrength[slot] = strength;
  st.bondAlive[slot] = 1;
  st.bondNum[p]++;
  st.bondNum[q]++;
  st.bondKeys.add(Math.min(p, q) * st.count + Math.max(p, q));
}

// Mint bonds from this substep's cross-body contacts: the particle
// bonds to the NEARER endpoint of the edge it presses on, at the
// current pair distance (glued bodies hold their contact offset).
function mintBonds(st: RigidSimState, glue: number): void {
  const { pos, conP, conA, conB, conCount, attrGlue, bondNum } = st;
  for (let k = 0; k < conCount; k++) {
    const b = conB[k];
    if (b < 0) continue; // self-contacts never glue
    const p = conP[k];
    const a = conA[k];
    const da = Math.hypot(pos[a * 2] - pos[p * 2], pos[a * 2 + 1] - pos[p * 2 + 1]);
    const db = Math.hypot(pos[b * 2] - pos[p * 2], pos[b * 2 + 1] - pos[p * 2 + 1]);
    const q = da <= db ? a : b;
    if (
      bondNum[p] >= MAX_BONDS_PER_PARTICLE ||
      bondNum[q] >= MAX_BONDS_PER_PARTICLE
    ) {
      continue;
    }
    const key = Math.min(p, q) * st.count + Math.max(p, q);
    if (st.bondKeys.has(key)) continue;
    const strength = glue * 0.5 * (attrGlue[p] + attrGlue[q]);
    if (strength <= 0.001) continue;
    pushBond(st, p, q, Math.max(1, Math.min(da, db)), strength);
  }
}

// Rigid distance projection over the alive bonds (equality constraint —
// unlike contacts, bonds pull back together too). Run every iteration.
function projectBonds(st: RigidSimState): void {
  const { pos, invMass, bondP, bondQ, bondRest, bondAlive, bondCount } = st;
  for (let k = 0; k < bondCount; k++) {
    if (!bondAlive[k]) continue;
    const p = bondP[k];
    const q = bondQ[k];
    const wP = invMass[p];
    const wQ = invMass[q];
    const wSum = wP + wQ;
    if (wSum === 0) continue;
    const dx = pos[q * 2] - pos[p * 2];
    const dy = pos[q * 2 + 1] - pos[p * 2 + 1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    const diff = (d - bondRest[k]) / (d * wSum);
    pos[p * 2] += dx * diff * wP;
    pos[p * 2 + 1] += dy * diff * wP;
    pos[q * 2] -= dx * diff * wQ;
    pos[q * 2 + 1] -= dy * diff * wQ;
  }
}

// Per-eval bond break check (rope-tear cadence), run AFTER the final
// fit. Strain is the wrong signal here: bond projection runs last in
// the iteration loop, so a yanked bond stays satisfied (d ≈ rest) while
// it RIPS its endpoints away from their body's rigid pose instead. The
// break length is therefore pixel-denominated and tested two ways:
//   - overstretch (d − rest) — catches pinned↔pinned bonds the solver
//     genuinely can't satisfy;
//   - endpoint displacement from its body's fitted goal — catches a
//     bond fighting the body (the sticky-weld break rule, inverted).
function breakBonds(
  st: RigidSimState,
  glueBreak: number,
  W: number,
  H: number
): number[] {
  const {
    pos,
    restLocal,
    bodies,
    particleBody,
    invMass,
    bondP,
    bondQ,
    bondRest,
    bondStrength,
    bondAlive,
    bondCount,
  } = st;
  const dispFromGoal = (i: number): number => {
    if (invMass[i] === 0) return 0; // pins sit on their pose by definition
    const b = bodies[particleBody[i]];
    const c = Math.cos(b.angle);
    const s = Math.sin(b.angle);
    const gx = c * restLocal[i * 2] - s * restLocal[i * 2 + 1] + b.cx;
    const gy = s * restLocal[i * 2] + c * restLocal[i * 2 + 1] + b.cy;
    return Math.hypot(pos[i * 2] - gx, pos[i * 2 + 1] - gy);
  };
  const snaps: number[] = [];
  for (let k = 0; k < bondCount; k++) {
    if (!bondAlive[k]) continue;
    const p = bondP[k];
    const q = bondQ[k];
    const breakLen = glueBreak * bondStrength[k];
    const d = Math.hypot(pos[q * 2] - pos[p * 2], pos[q * 2 + 1] - pos[p * 2 + 1]);
    if (
      d - bondRest[k] <= breakLen &&
      dispFromGoal(p) <= breakLen &&
      dispFromGoal(q) <= breakLen
    ) {
      continue;
    }
    bondAlive[k] = 0;
    st.bondDead++;
    st.bondNum[p]--;
    st.bondNum[q]--;
    st.bondKeys.delete(Math.min(p, q) * st.count + Math.max(p, q));
    snaps.push(
      (pos[p * 2] + pos[q * 2]) / 2 / W,
      pxToAuthoredY((pos[p * 2 + 1] + pos[q * 2 + 1]) / 2, W, H)
    );
  }
  // Compact when the dead fraction dominates (stick-slip contact can
  // mint and break bonds continuously; the arrays must not grow forever).
  if (st.bondDead > 64 && st.bondDead * 2 > st.bondCount) {
    let w = 0;
    for (let k = 0; k < st.bondCount; k++) {
      if (!bondAlive[k]) continue;
      st.bondP[w] = bondP[k];
      st.bondQ[w] = bondQ[k];
      st.bondRest[w] = bondRest[k];
      st.bondStrength[w] = bondStrength[k];
      st.bondAlive[w] = 1;
      w++;
    }
    st.bondCount = w;
    st.bondDead = 0;
  }
  return snaps;
}

function clearBonds(st: RigidSimState): void {
  if (st.bondCount === 0) return;
  st.bondCount = 0;
  st.bondDead = 0;
  st.bondNum.fill(0);
  st.bondKeys.clear();
}

// ---- input gathering ---------------------------------------------------

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

// ---- node ----------------------------------------------------------------

export const rigidBodySimulatorNode: NodeDefinition = {
  type: "rigid-body-simulator",
  name: "Rigid Body Simulator",
  category: "spline",
  subcategory: "modifier",
  description:
    "2D rigid body dynamics: each input subpath becomes a rigid body that falls, tumbles, and stacks — colliding with collider nodes, the canvas bounds, and other bodies (edge-accurate contacts). Glue makes touching bodies bond and snap apart under stress. Rigidity below 1 turns bodies to jelly. At full rigidity the output is your original curves under each body's rotation + translation. Resets when scene time returns to 0.",
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
    // at reset by default; friction/bounce/glue have live toggles.
    // pin_map is baked-only (a pin is a rest-position constraint).
    out.push(
      { name: "friction_map", type: "mask", required: false },
      { name: "bounce_map", type: "mask", required: false },
      { name: "glue_map", type: "mask", required: false },
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
      default: "none",
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
      name: "rigidity",
      label: "Rigidity",
      type: "scalar",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 1,
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
      default: 0.2,
    },
    {
      name: "glue",
      label: "Glue",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "glue_break",
      label: "Glue break (px)",
      type: "scalar",
      min: 0.5,
      max: 64,
      softMax: 24,
      step: 0.5,
      default: 6,
      visibleIf: (p) => ((p.glue as number) ?? 0) > 0,
    },
    {
      name: "body_collide",
      label: "Body collisions",
      type: "boolean",
      default: true,
    },
    {
      name: "self_collide",
      label: "Self-collision",
      type: "boolean",
      default: false,
    },
    {
      name: "thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 1,
      max: 32,
      step: 0.5,
      default: 4,
      visibleIf: (p) => p.body_collide !== false || p.self_collide === true,
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
      name: "glue_map_live",
      label: "Glue map: live",
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
      default: 6,
    },
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 6,
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
      // At rigidity 1 the output is always the exact transformed
      // original — there is no resampling to choose between.
      visibleIf: (p) => ((p.rigidity as number) ?? 1) < 0.999,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [
    // One point per body at its centroid, rotation = the fitted angle —
    // wire into Copy-to-Points and images stamp onto the simulated
    // bodies.
    { name: "bodies", type: "points" },
    { name: "points", type: "points" },
    // Glue-bond break locations for the current frame only (empty most
    // frames) — trigger flashes/particles at each snap.
    { name: "snaps", type: "points" },
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
      return {
        primary: { kind: "spline", subpaths: [] } satisfies SplineValue,
      };
    }

    const segPx = Math.max(2, (params.segment_px as number) ?? 8);
    const maxPoints = Math.max(
      16,
      Math.floor((params.max_points as number) ?? 2000)
    );
    const pinMode = (params.pin_mode as string) ?? "none";
    const pinRadius = Math.max(2, (params.pin_radius as number) ?? 12);
    const followInput = !!(params.follow_input as boolean);
    const gx = (params.gravity_x as number) ?? 0;
    const gy = (params.gravity_y as number) ?? 0.35;
    const rigidity = Math.max(
      0.05,
      Math.min(1, (params.rigidity as number) ?? 1)
    );
    const damping = (params.damping as number) ?? 0.02;
    const friction = Math.max(0, Math.min(1, (params.friction as number) ?? 0.2));
    const bounciness = Math.max(
      0,
      Math.min(1, (params.bounciness as number) ?? 0.2)
    );
    const glue = Math.max(0, Math.min(1, (params.glue as number) ?? 0));
    const glueBreak = Math.max(0.5, (params.glue_break as number) ?? 6);
    const bodyCollide = params.body_collide !== false;
    const selfCollide = params.self_collide === true;
    const thickness = Math.max(1, (params.thickness as number) ?? 4);
    const substeps = Math.max(
      1,
      Math.min(16, Math.floor((params.substeps as number) ?? 6))
    );
    const iterations = Math.max(
      1,
      Math.min(16, Math.floor((params.iterations as number) ?? 6))
    );
    const fixedDt = Math.max(
      0.001,
      Math.min(0.1, (params.fixedDt as number) ?? 1 / 60)
    );
    const boundsMode = (params.boundsMode as string) ?? "off";
    const boundsRestitution = (params.boundsRestitution as number) ?? 0.5;
    const outputMode = (params.output_mode as string) ?? "smooth";
    const pinPts =
      inputs.pins && inputs.pins.kind === "points" ? inputs.pins : null;

    // Topology-only signature: shape animation flows through without
    // resetting (follow_input needs that); adding/removing subpaths or
    // anchors reseeds. Pins-count changes re-capture via a full reseed.
    const topoSig = src.subpaths
      .map((s) => `${s.anchors.length}${s.closed ? "c" : "o"}`)
      .join(",");
    const seedSig = `${segPx}|${maxPoints}|${pinMode}|${W}x${H}|${topoSig}|p:${pinPts?.count ?? 0}:${pinRadius}`;

    let st = ctx.state[key] as RigidSimState | undefined;
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
    const mapCache = (st.mapCache ??= {});
    const mapAttrs = [
      {
        name: "friction_map",
        out: st.attrFriction,
        live: !!params.friction_map_live,
      },
      { name: "bounce_map", out: st.attrBounce, live: !!params.bounce_map_live },
      { name: "glue_map", out: st.attrGlue, live: !!params.glue_map_live },
    ];
    for (const m of mapAttrs) {
      const buf = readMapBuffer(ctx, mapCache, m.name, inputs[m.name]);
      if (!buf) {
        if (reseeded) m.out.fill(1);
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
          if (
            sampleMap(pinBuf, st.pos[i * 2] / W, st.pos[i * 2 + 1] / H) >= 0.5
          ) {
            st.invMass[i] = 0;
            st.fitWeight[i] = PIN_FIT_WEIGHT;
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
          let bestI = -1;
          let bestD = pinRadius;
          for (let i = 0; i < st.count; i++) {
            if (st.pinPointIdx[i] >= 0) continue;
            const d = Math.hypot(st.pos[i * 2] - px, st.pos[i * 2 + 1] - py);
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          }
          if (bestI >= 0) {
            st.pinPointIdx[bestI] = k;
            st.invMass[bestI] = 0;
            st.fitWeight[bestI] = PIN_FIT_WEIGHT;
          }
        }
      }
      // Rest geometry must incorporate ALL pin weights (the weighted
      // centroid is what anchors the fit to a pin).
      finalizeRestGeometry(st);
      // follow_input targets: ends/map-pinned particles record where
      // they sit along their source subpath (point-pins win; recorded
      // always so the toggle works mid-run without a reseed).
      for (const body of st.bodies) {
        const div = body.closed ? body.count : body.count - 1;
        for (let i = 0; i < body.count; i++) {
          const g = body.start + i;
          if (st.invMass[g] !== 0 || st.pinPointIdx[g] >= 0) continue;
          st.followSub[g] = body.srcIndex;
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
    const colliders: PackedCollider[] = packColliders(
      ctx,
      rawColliders,
      (st.maskCache ??= [])
    );

    const { pos, prev, invMass, count, bodies } = st;
    const h = fixedDt / substeps;
    // Frame-rate/substep-independent damping: `damping` is the fraction
    // of velocity lost per 60fps frame.
    const dampFactor = Math.pow(1 - Math.min(damping, 0.999), h * 60);
    const vel = new Float32Array(2); // scratch, UV/sec
    const pp = new Float32Array(4); // scratch [u, v, velU, velV]
    const hasColliders = colliders.length > 0 || boundsMode !== "off";
    const doContacts = (bodyCollide && bodies.length > 1) || selfCollide;
    if (glue <= 0) clearBonds(st);
    // Solver-rate-independent softness: the per-pull k must compose to
    // `rigidity` per EVAL across every pull (iterations × substeps), or
    // 36 pulls/frame at defaults reads as rigid at any slider value.
    // rigidity 1 ⇒ k = 1, a pure idempotent projection.
    const k =
      rigidity >= 0.999
        ? 1
        : 1 - Math.pow(1 - rigidity, 1 / (iterations * substeps));

    // Animated pin targets, applied once per eval: point-pins snap to
    // their point's CURRENT position (drag the points, drag the body);
    // follow_input pins re-sample the live input spline at their
    // recorded arc-length fraction, so keyframed spline animation
    // drives the body with secondary motion on top.
    if (pinPts) {
      for (let i = 0; i < count; i++) {
        const pk = st.pinPointIdx[i];
        if (pk < 0 || pk >= pinPts.count) continue;
        pos[i * 2] = prev[i * 2] = pinPts.positions[pk * 2] * W;
        pos[i * 2 + 1] = prev[i * 2 + 1] = authoredToPxY(
          pinPts.positions[pk * 2 + 1],
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
      // Per-particle force application is what makes torque emergent —
      // wind catching one end of a plank spins it with no torque code.
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

      if (doContacts) {
        discoverContacts(st, thickness, bodyCollide, selfCollide, W, H);
        if (glue > 0 && bodyCollide) mintBonds(st, glue);
      } else {
        st.conCount = 0;
      }

      // The interleaved solve (see file header): shape matching, glue
      // bonds, and contact projection must converge TOGETHER, or
      // stacks breathe and glued clumps drift.
      const haveBonds = st.bondCount > st.bondDead;
      for (let it = 0; it < iterations; it++) {
        for (const body of bodies) shapeMatchBody(st, body, k);
        if (haveBonds) projectBonds(st);
        if (st.conCount > 0) projectContacts(st, thickness);
      }

      // Contact response in UV space, kernel math (shader-identical).
      if (hasColliders) {
        for (let i = 0; i < count; i++) {
          if (invMass[i] === 0) continue;
          const fr = friction * st.attrFriction[i];
          const bo = bounciness * st.attrBounce[i];
          pp[0] = pos[i * 2] / W;
          pp[1] = pos[i * 2 + 1] / H;
          pp[2] = (pos[i * 2] - prev[i * 2]) / (h * W);
          pp[3] = (pos[i * 2 + 1] - prev[i * 2 + 1]) / (h * H);
          resolveCollidersCpu(colliders, pp, fr, bo, aspect);
          resolveBoundsCpu(boundsMode, boundsRestitution, pp, fr, bo);
          // Clamp mode pins position but leaves the inward velocity
          // untouched (kernel/rope semantics) — for a RESTING body that
          // phantom velocity accumulates gravity forever and vibrates
          // the shape-match fit. Kill it at the wall.
          if (boundsMode === "clamp") {
            if ((pp[0] <= 0 && pp[2] < 0) || (pp[0] >= 1 && pp[2] > 0)) {
              pp[2] = 0;
            }
            if ((pp[1] <= 0 && pp[3] < 0) || (pp[1] >= 1 && pp[3] > 0)) {
              pp[3] = 0;
            }
          }
          pos[i * 2] = pp[0] * W;
          pos[i * 2 + 1] = pp[1] * H;
          prev[i * 2] = pos[i * 2] - pp[2] * h * W;
          prev[i * 2 + 1] = pos[i * 2 + 1] - pp[3] * h * H;
        }
      }

      if (st.conCount > 0) {
        contactVelocityResponse(st, thickness, friction, bounciness);
      }
    }

    // Final fit per body so the output transform reflects the fully
    // solved positions (contacts included), not the last iteration's
    // intermediate state. k = 0 fits without moving particles. Must
    // run BEFORE the break check — breaks measure displacement from
    // these fitted goals.
    for (const body of bodies) shapeMatchBody(st, body, 0);

    const snapUv = glue > 0 && active ? breakBonds(st, glueBreak, W, H) : [];

    // ---- outputs ----
    const exact = rigidity >= 0.999;
    const subpaths: SplineSubpath[] = [];
    for (const body of bodies) {
      let sp: SplineSubpath;
      if (exact) {
        const c = Math.cos(body.angle);
        const sn = Math.sin(body.angle);
        const anchors: SplineAnchor[] = body.srcAnchorsPx.map((a) => {
          const rx = a.pos[0] - body.restCx;
          const ry = a.pos[1] - body.restCy;
          const out: SplineAnchor = {
            pos: [
              (c * rx - sn * ry + body.cx) / W,
              pxToAuthoredY(sn * rx + c * ry + body.cy, W, H),
            ],
          };
          // Handles are offsets from pos — they rotate, never translate
          // (authored offsets are px/W on BOTH axes; see subpathToCanvasPx).
          if (a.inHandle) {
            out.inHandle = [
              (c * a.inHandle[0] - sn * a.inHandle[1]) / W,
              (sn * a.inHandle[0] + c * a.inHandle[1]) / W,
            ];
          }
          if (a.outHandle) {
            out.outHandle = [
              (c * a.outHandle[0] - sn * a.outHandle[1]) / W,
              (sn * a.outHandle[0] + c * a.outHandle[1]) / W,
            ];
          }
          return out;
        });
        sp = { anchors, closed: body.closed };
      } else {
        const uvPts: [number, number][] = [];
        for (let i = body.start; i < body.start + body.count; i++) {
          uvPts.push([pos[i * 2] / W, pxToAuthoredY(pos[i * 2 + 1], W, H)]);
        }
        sp =
          outputMode === "polyline"
            ? { anchors: uvPts.map((p) => ({ pos: p })), closed: body.closed }
            : catmullRomSubpath(uvPts, body.closed);
      }
      if (body.srcGroup !== undefined) sp.groupIndex = body.srcGroup;
      subpaths.push(sp);
    }

    const out: { primary: SplineValue; aux?: Record<string, SocketValue> } = {
      primary: { kind: "spline", subpaths },
    };

    const aux: Record<string, SocketValue> = {};
    if (!consumedOutputs || consumedOutputs.has("aux:bodies")) {
      const pts = makePoints(bodies.length, {
        withRotations: true,
        withGroupIndices: true,
      });
      for (let bi = 0; bi < bodies.length; bi++) {
        const body = bodies[bi];
        pts.positions[bi * 2] = body.cx / W;
        pts.positions[bi * 2 + 1] = pxToAuthoredY(body.cy, W, H);
        pts.rotations![bi] = body.angle;
        pts.groupIndices![bi] = body.srcIndex;
      }
      aux.bodies = pts;
    }
    if (!consumedOutputs || consumedOutputs.has("aux:points")) {
      const pts = makePoints(count, { withGroupIndices: true });
      for (let i = 0; i < count; i++) {
        pts.positions[i * 2] = pos[i * 2] / W;
        pts.positions[i * 2 + 1] = pxToAuthoredY(pos[i * 2 + 1], W, H);
        pts.groupIndices![i] = bodies[st.particleBody[i]].srcIndex;
      }
      aux.points = pts;
    }
    if (!consumedOutputs || consumedOutputs.has("aux:snaps")) {
      const pts = makePoints(snapUv.length / 2);
      pts.positions.set(snapUv);
      aux.snaps = pts;
    }
    if (Object.keys(aux).length > 0) out.aux = aux;

    return out;
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
