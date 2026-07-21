// Planar-face machinery for the Shape Builder tool (Spline Draw, spec
// 071926_spline-draw-authoring-upgrade.md M3) and the future Shape Builder
// node (M5). Engine-side and pure so both share it verbatim.
//
// The idea: the paths' boundaries partition the plane into atomic faces,
// and any face is fully identified by its COVERAGE SIGNATURE — an N-char
// '0'/'1' string saying which operands contain it. Operands are the SIMPLE
// LOOPS of every subpath (each subpath's flattened ring split at its
// self-crossings — see PlanarShape), so a self-overlapping path's lobes and
// wound-over regions are distinct faces too. "The face under the cursor" is
// N point-in-polygon tests, and the face's geometry is a direct composition
// of boolean ops: intersect the bit=1 loops, subtract the bit=0 ones. No
// planar-arrangement library needed.
//
// Conventions (shared with spline-boolean.ts, whose flatten/convert
// primitives this reuses): every subpath is treated as CLOSED (open
// subpaths get their implicit fill silhouette — same treatment as the
// spline→mask coercion). Geometry is flattened polylines in the shared
// SCALE space; output subpaths are polygonal with collinear vertices
// culled — the same fidelity as the Spline Boolean node (accepted for v1 in
// the spec's Q&A).

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import type { SplineSubpath } from "./types";
import {
  SCALE,
  geomToSpline,
  pointInGeom,
  subpathToRing,
} from "./spline-boolean";
import { roundCornersPerAnchor } from "./spline-math";

// '1'/'0' per subpath index — "which subpaths cover this face".
export type FaceSignature = string;

// Flattening resolution (line segments per cubic). Editor-interaction use —
// one fixed value rather than a param; matches the Spline Boolean node's
// default fidelity tier.
const PLANAR_STEPS = 24;

// A SELF-OVERLAPPING subpath encloses multiple distinct regions (lobes, the
// wound-over interior), and one containment bit can't tell them apart — so
// the signature operands are the subpath's SIMPLE LOOPS, split at every
// self-crossing, not the subpath itself. A figure-eight becomes two loop
// operands (each lobe gets its own signature); a loop-the-loop becomes an
// outer + inner loop (the wound-over region reads "inside both"). Cutting
// still happens per SUBPATH — `owner` maps each operand back to its source.
export interface PlanarShape {
  count: number; // operand (loop) count — the signature length
  // Per-LOOP cleaned solid geometry in the shared scaled space.
  geoms: Array<MultiPolygon | null>;
  // Operand index → source subpath index.
  owner: number[];
  // Per-SUBPATH even-odd geometry (xor of its loops — matches how the
  // rasterizer resolves a self-overlap) — the base the cut remainder is
  // taken from. null = degenerate.
  subpathGeoms: Array<MultiPolygon | null>;
  subpathCount: number;
}

// Runaway guard: a pathological pencil scribble can self-cross hundreds of
// times; past this many loops per subpath we stop splitting and keep the
// remainder as one operand (faces degrade gracefully, nothing breaks).
const MAX_LOOPS_PER_SUBPATH = 64;

// Proper-interior intersection of segments a→b and c→d: parameters strictly
// inside both spans (vertex touches excluded — that's what terminates the
// decomposition). Returns the split point + parameter along a→b, or null.
function properSegHit(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number]
): { x: number; y: number; t: number } | null {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-12) return null;
  const t =
    ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u =
    ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  const eps = 1e-6;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, t };
}

// Self-touch weld tolerance in scaled units (≈ 6e-6 normalized — far below
// any visible distance). Flattening routinely lands a sample vertex exactly
// ON a crossing (uniform LUTs + symmetric geometry), which turns the proper
// interior crossing into a vertex touch — so the decomposition must split at
// touches too, not only at edge-interior crossings.
const WELD_EPS = 0.05;

// Decompose a (possibly self-intersecting) closed ring into simple loops.
// Three detectors, in priority order per pass:
//   (a) vertex-vertex self-touch (two ring vertices within WELD_EPS) —
//       split into the two loops meeting at that point;
//   (b) proper edge-interior crossing — split at the intersection;
//   (c) vertex on a non-adjacent edge's interior — insert a copy of the
//       vertex into that edge, so the next pass's (a) splits there.
// Repeat until simple. O(n²) per pass — fine at editor flattening densities,
// and built once per edit. (Exported for tests.)
export function decomposeRing(ring: Ring): Ring[] {
  const out: Ring[] = [];
  const stack: Ring[] = [ring];
  const W2 = WELD_EPS * WELD_EPS;
  // Hard iteration cap — no self-touch topology should cycle, but a cap
  // turns any surprise into graceful degradation instead of a hang.
  let passes = 0;
  while (stack.length > 0) {
    if (++passes > MAX_LOOPS_PER_SUBPATH * 8) {
      out.push(...stack);
      break;
    }
    const r = stack.pop()!;
    const n = r.length;
    if (n < 3) continue;
    if (out.length + stack.length >= MAX_LOOPS_PER_SUBPATH) {
      out.push(r);
      continue;
    }
    let split = false;

    // (a) vertex-vertex self-touch. Both resulting loops must keep ≥ 3
    // points (j−i and n−(j−i)), which also excludes the wrap-adjacent pair.
    for (let i = 0; i < n && !split; i++) {
      for (let j = i + 3; j < n; j++) {
        if (n - (j - i) < 3) break; // farther j only shrinks the other loop
        const dx = r[i][0] - r[j][0];
        const dy = r[i][1] - r[j][1];
        if (dx * dx + dy * dy > W2) continue;
        stack.push(r.slice(i, j));
        stack.push([...r.slice(j), ...r.slice(0, i)]);
        split = true;
        break;
      }
    }
    if (split) continue;

    // (b) proper edge-interior crossing.
    for (let i = 0; i < n && !split; i++) {
      const a = r[i];
      const b = r[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // wrap-adjacent
        const c = r[j];
        const d = r[(j + 1) % n];
        const hit = properSegHit(a, b, c, d);
        if (!hit) continue;
        const P: [number, number] = [hit.x, hit.y];
        // Loop 1: r[0..i], P, r[j+1..n-1] — the ring with the span (i..j]
        // excised. Loop 2: P, r[i+1..j] — the excised span closed at P.
        stack.push([...r.slice(0, i + 1), P, ...r.slice(j + 1)]);
        stack.push([P, ...r.slice(i + 1, j + 1)]);
        split = true;
        break;
      }
    }
    if (split) continue;

    // (c) vertex on a non-adjacent edge's interior → mint the touch vertex
    // into the edge; the next pass's (a) splits there. Requires topological
    // separation so a collinear neighbor can't retrigger forever.
    for (let k = 0; k < n && !split; k++) {
      const v = r[k];
      for (let i = 0; i < n; i++) {
        if (i === k || (i + 1) % n === k) continue; // edges incident to v
        const insertPos = i + 1;
        const topoDist = Math.min(
          (k - insertPos + n) % n,
          (insertPos - k + n) % n
        );
        if (topoDist < 2) continue;
        const a = r[i];
        const b = r[(i + 1) % n];
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const len2 = abx * abx + aby * aby;
        if (len2 < 1e-12) continue;
        const t = ((v[0] - a[0]) * abx + (v[1] - a[1]) * aby) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const px = a[0] + abx * t;
        const py = a[1] + aby * t;
        const dx = v[0] - px;
        const dy = v[1] - py;
        if (dx * dx + dy * dy > W2) continue;
        stack.push([
          ...r.slice(0, i + 1),
          [px, py] as [number, number],
          ...r.slice(i + 1),
        ]);
        split = true;
        break;
      }
    }
    if (!split) out.push(r);
  }
  return out;
}

// Flatten each subpath, split its ring into simple loops, and self-clean
// each loop once; everything else composes from this.
export function buildPlanarShape(subpaths: SplineSubpath[]): PlanarShape {
  const geoms: Array<MultiPolygon | null> = [];
  const owner: number[] = [];
  const subpathGeoms: Array<MultiPolygon | null> = [];
  subpaths.forEach((s, si) => {
    if (s.anchors.length < 2) {
      subpathGeoms.push(null);
      return;
    }
    const ring = subpathToRing(s, PLANAR_STEPS);
    if (ring.length < 3) {
      subpathGeoms.push(null);
      return;
    }
    const loops = decomposeRing(ring).filter((r) => r.length >= 3);
    const loopGeoms: MultiPolygon[] = [];
    for (const loop of loops) {
      const g = polygonClipping.union([loop] as [Ring]);
      if (g.length === 0) continue;
      geoms.push(g);
      owner.push(si);
      loopGeoms.push(g);
    }
    if (loopGeoms.length === 0) {
      subpathGeoms.push(null);
    } else if (loopGeoms.length === 1) {
      subpathGeoms.push(loopGeoms[0]);
    } else {
      // Even-odd across the subpath's own loops — matches the rasterizer's
      // fill rule for a self-overlap (the wound-over region is a hole).
      subpathGeoms.push(
        polygonClipping.xor(loopGeoms[0], ...loopGeoms.slice(1))
      );
    }
  });
  return {
    count: geoms.length,
    geoms,
    owner,
    subpathGeoms,
    subpathCount: subpaths.length,
  };
}

// The coverage signature of the face containing `p` (normalized coords, the
// anchors' own space). Null when p lies in no subpath — the background is
// not a face.
export function signatureAt(
  shape: PlanarShape,
  p: [number, number]
): FaceSignature | null {
  const x = p[0] * SCALE;
  const y = p[1] * SCALE;
  let sig = "";
  let any = false;
  for (const g of shape.geoms) {
    const inside = g ? pointInGeom(g, x, y) : false;
    sig += inside ? "1" : "0";
    if (inside) any = true;
  }
  return any ? sig : null;
}

// Face geometry for a signature: ∩ of the bit=1 subpaths minus every bit=0
// subpath. Null when the signature names no subpaths or the region is empty
// (e.g. a stale signature after an edit).
export function faceGeometry(
  shape: PlanarShape,
  sig: FaceSignature
): MultiPolygon | null {
  if (sig.length !== shape.count) return null;
  const ins: MultiPolygon[] = [];
  const outs: MultiPolygon[] = [];
  for (let i = 0; i < shape.count; i++) {
    const g = shape.geoms[i];
    if (!g) continue;
    (sig[i] === "1" ? ins : outs).push(g);
  }
  if (ins.length === 0) return null;
  let acc = ins[0];
  for (let i = 1; i < ins.length; i++) {
    acc = polygonClipping.intersection(acc, ins[i]);
    if (acc.length === 0) return null;
  }
  if (outs.length > 0) {
    acc = polygonClipping.difference(acc, ...outs);
  }
  return acc.length > 0 ? acc : null;
}

// A face reference — how gestures (and the future node's ops param) name a
// face. The signature says WHICH loops cover it; the seed (a normalized
// point inside the face) says WHICH connected component of the signature's
// composition it is: two disconnected regions can share a signature (e.g.
// "inside the loop and inside one triangle, outside the rest" can hold in
// two separate places), and a face is always ONE connected region.
export interface FaceRef {
  sig: FaceSignature;
  seed: [number, number];
}

// The face under a point: signature + the connected component of its
// composition that actually contains the point. Null over background, or on
// a numeric boundary edge.
export function facePickAt(
  shape: PlanarShape,
  p: [number, number]
): { ref: FaceRef; geom: MultiPolygon; component: number } | null {
  const sig = signatureAt(shape, p);
  if (!sig) return null;
  const full = faceGeometry(shape, sig);
  if (!full) return null;
  const x = p[0] * SCALE;
  const y = p[1] * SCALE;
  for (let ci = 0; ci < full.length; ci++) {
    const single: MultiPolygon = [full[ci]];
    if (pointInGeom(single, x, y)) {
      return { ref: { sig, seed: p }, geom: single, component: ci };
    }
  }
  return null;
}

// Containment test against a picked face's geometry (normalized point).
export function faceContains(
  geom: MultiPolygon,
  p: [number, number]
): boolean {
  return pointInGeom(geom, p[0] * SCALE, p[1] * SCALE);
}

// A face's rings (outer + holes, multipolygon flattened in order) converted
// back to normalized coords — for the editor's highlight-fill preview.
export function faceRingsNormalized(
  geom: MultiPolygon
): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  for (const poly of geom) {
    for (const ring of poly) {
      out.push(ring.map(([x, y]) => [x / SCALE, y / SCALE] as [number, number]));
    }
  }
  return out;
}

// Apply one Shape Builder gesture to a stored subpath list. `faces` are the
// signatures the gesture touched (one for a click, several for a drag);
// "merge" unions them into new subpath(s), "delete" just removes their area.
// Semantics: the merged face area M is cut OUT of every INVOLVED subpath —
// one that owns any bit=1 loop. A subpath whose loops are all bit=0 cannot
// overlap M's interior (the face lies outside every one of its loops, hence
// outside its even-odd fill) and passes through BY REFERENCE (keeping
// handles, live corners, groupIndex). Involved subpaths are rebuilt
// polygonal from their remainder (their fillet radii bake in — this is the
// destructive authoring tool). Never returns an empty list (Spline Draw's
// envelope invariant); returns the INPUT ARRAY when the gesture resolves to
// nothing (caller can identity-check).
export function applyShapeBuilderOp(
  stored: SplineSubpath[],
  faces: FaceRef[],
  op: "merge" | "delete"
): SplineSubpath[] {
  // Work on the EFFECTIVE geometry (Live Corners resolved) — what's on
  // screen is what the gesture cuts.
  const effective = roundCornersPerAnchor(stored);
  const shape = buildPlanarShape(effective);

  const faceGeoms: MultiPolygon[] = [];
  const involved = new Set<number>(); // SUBPATH indices (via operand owners)
  for (const ref of faces) {
    // Re-derive from the seed — component-precise (the signature alone can
    // name two disconnected regions), and a stale ref simply resolves to
    // nothing instead of failing the gesture.
    const pick = facePickAt(shape, ref.seed);
    if (!pick) continue;
    faceGeoms.push(pick.geom);
    const sig = pick.ref.sig;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] === "1") involved.add(shape.owner[i]);
    }
  }
  if (faceGeoms.length === 0) return stored;
  const M =
    faceGeoms.length === 1
      ? faceGeoms[0]
      : polygonClipping.union(faceGeoms[0], ...faceGeoms.slice(1));

  const out: SplineSubpath[] = [];
  stored.forEach((s, i) => {
    if (!involved.has(i)) {
      out.push(s);
      return;
    }
    // Remainder base = the subpath's even-odd geometry (what it renders as),
    // so a self-overlap's wound-over hole stays a hole in the remainder.
    const g = shape.subpathGeoms[i];
    if (!g) {
      out.push(s);
      return;
    }
    const rem = polygonClipping.difference(g, M);
    if (rem.length > 0) out.push(...geomToSpline(rem).subpaths);
  });
  if (op === "merge") out.push(...geomToSpline(M).subpaths);
  return out.length > 0 ? out : [{ anchors: [], closed: false }];
}
