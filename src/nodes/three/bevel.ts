import * as THREE from "three";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { analyzeRegions, edgeKey } from "@/engine/three-mesh";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";

// =====================================================================
// 3D Bevel — rounded feature edges (M8, the one we parked at the Q&A)
// =====================================================================
//
// The constrained-v1 design agreed in the 081026 spec: every FEATURE
// edge (between two regions found by the angle threshold — the shared
// engine/three-mesh.ts machinery) gets a rounded strip; per-edge
// selection and messy-mesh robustness stay future work. Construction:
//
//   1. INSET — each region's boundary vertices slide inward, tangent to
//      the surface, `width` away from their feature edges (mitered at
//      region corners, clamped so sharp corners don't explode; open-mesh
//      boundary edges don't inset — only feature edges bevel).
//   2. STRIPS — each feature edge grows a `segments`-row arc sweeping
//      from region A's inset edge to region B's, blending CHORD (straight
//      chamfer) toward ARC (circular round) by the PROFILE curve: the
//      float_curve maps sweep position → bulge, so flat-1 = round,
//      flat-0 = chamfer, dips and steps = grooves and flutes.
//   3. CORNERS — vertices where ≥3 feature edges meet get a fan patch
//      over the hole, ordered by walking region adjacency around the
//      corner.
//
// Winding is SELF-CORRECTING: every strip/corner triangle compares its
// flat normal against the smooth (slerped) normal and flips when
// opposed — no per-case orientation derivation, verified watertight by
// the signed-volume smoke. Width auto-clamps to 45% of the shortest
// feature edge so bevels can't self-intersect along an edge.
//
// Smooth-shaded: region tris keep source normals; strip normals slerp
// between the two regions' per-vertex normals; corner normals point away
// from the original corner. UVs: region tris keep theirs, strips/corners
// get zeros (Texture Projection regenerates when needed). §1.2 rule:
// fresh soup per compute, input untouched.

// Rotate `a` toward `b` by fraction t of their angle (common-plane arc),
// lengths lerped — the circular bevel sweep.
function slerpVec(
  a: THREE.Vector3,
  b: THREE.Vector3,
  t: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const la = a.length();
  const lb = b.length();
  if (la < 1e-12 || lb < 1e-12) return out.copy(a).lerp(b, t);
  const na = a.clone().divideScalar(la);
  const nb = b.clone().divideScalar(lb);
  const d = Math.max(-1, Math.min(1, na.dot(nb)));
  const ang = Math.acos(d);
  if (ang < 1e-6) return out.copy(a).lerp(b, t);
  const axis = na.clone().cross(nb);
  if (axis.lengthSq() < 1e-12) return out.copy(a).lerp(b, t);
  axis.normalize();
  out.copy(na).applyAxisAngle(axis, ang * t);
  return out.multiplyScalar(la + (lb - la) * t);
}

interface BevelState {
  geometry: THREE.BufferGeometry | null;
}

export const bevel3DNode: NodeDefinition = {
  type: "bevel-3d",
  name: "3D Bevel",
  category: "3d",
  description:
    "Rounds the sharp edges of 3D geometry — width, segments, and a profile curve (full = round, zero = flat chamfer, dips = grooves). Edges are found by the angle threshold, like 3D Extrude's faces.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "geometry", type: "geometry", required: true }],
  params: [
    {
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0.001,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "segments",
      label: "Segments",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 3,
    },
    {
      name: "profile",
      label: "Profile",
      type: "float_curve",
      default: defaultFloatCurve(1, 1),
    },
    {
      name: "angle",
      label: "Angle (°)",
      type: "scalar",
      min: 0.1,
      max: 180,
      softMax: 60,
      step: 0.1,
      default: 30,
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};
    const key = `bevel-3d:${nodeId}`;
    let st = ctx.state[key] as BevelState | undefined;
    if (!st) {
      st = { geometry: null };
      ctx.state[key] = st;
    }

    const segments = Math.max(1, Math.min(8, Math.round((params.segments as number) ?? 3)));
    const angle = (params.angle as number) ?? 30;
    const profilePts = sanitizeFloatCurve(params.profile, 1, 1);
    // Sample the profile once per row (t=0 and t=1 pin to the surfaces).
    const prof: number[] = [];
    for (let r = 0; r <= segments; r++) {
      const t = r / segments;
      prof.push(
        t === 0 || t === 1
          ? 1
          : Math.max(0, Math.min(1, sampleFloatCurve(profilePts, t)))
      );
    }

    const analysis = analyzeRegions(src.geometry, angle);
    if (!analysis) return {};
    const { tris, regions, regionOf, canonicalPos, edgeTris } = analysis;

    // ---- feature edges + width clamp ---------------------------------
    interface Feature {
      c0: number;
      c1: number;
      a: number; // region ids
      b: number;
    }
    const features: Feature[] = [];
    for (const [k, ts] of edgeTris) {
      if (ts.length !== 2) continue;
      const ra = regionOf[ts[0]];
      const rb = regionOf[ts[1]];
      if (ra === rb) continue;
      const [c0s, c1s] = k.split(":");
      features.push({
        c0: +c0s,
        c1: +c1s,
        a: Math.min(ra, rb),
        b: Math.max(ra, rb),
      });
    }
    if (features.length === 0) {
      // Nothing to bevel (single smooth region) — pass through.
      if (st.geometry) {
        st.geometry.dispose();
        st.geometry = null;
      }
      return { primary: { ...src, nodeId } };
    }
    // Width clamp — only edges that MEET A CORNER (≥3 features at an
    // endpoint) can self-overlap along their length, so only those bound
    // the width. (A cylinder rim is many short collinear feature edges
    // with 2-feature endpoints — clamping on those would cap the bevel
    // at one rim segment's length.)
    const featCount = new Map<number, number>();
    for (const f of features) {
      featCount.set(f.c0, (featCount.get(f.c0) ?? 0) + 1);
      featCount.set(f.c1, (featCount.get(f.c1) ?? 0) + 1);
    }
    let minEdgeLen = Infinity;
    for (const f of features) {
      if ((featCount.get(f.c0) ?? 0) < 3 && (featCount.get(f.c1) ?? 0) < 3)
        continue;
      const dx = canonicalPos[f.c0 * 3] - canonicalPos[f.c1 * 3];
      const dy = canonicalPos[f.c0 * 3 + 1] - canonicalPos[f.c1 * 3 + 1];
      const dz = canonicalPos[f.c0 * 3 + 2] - canonicalPos[f.c1 * 3 + 2];
      minEdgeLen = Math.min(minEdgeLen, Math.hypot(dx, dy, dz));
    }
    const width = Math.min(
      (params.width as number) ?? 0.05,
      minEdgeLen * 0.45 // Infinity when no corners ⇒ no clamp
    );

    // Deterministic feature order (edge key order varies with Map): sort.
    features.sort((p, q) => p.c0 - q.c0 || p.c1 - q.c1);
    const featureKeys = new Set(features.map((f) => edgeKey(f.c0, f.c1)));

    // ---- per-region data ----------------------------------------------
    // Per-vertex region normals (area-weighted) + boundary adjacency.
    const srcNrm = src.geometry.getAttribute("normal") as
      | THREE.BufferAttribute
      | undefined;
    const srcPos = src.geometry.getAttribute("position") as THREE.BufferAttribute;

    // regionNormal.get(r).get(c) → averaged unit normal of region r at c.
    const regionNormal = new Map<number, Map<number, THREE.Vector3>>();
    for (let r = 0; r < regions.length; r++) {
      const m = new Map<number, THREE.Vector3>();
      for (const t of regions[r]) {
        const tt = tris[t];
        for (const c of [tt.c0, tt.c1, tt.c2]) {
          let v = m.get(c);
          if (!v) {
            v = new THREE.Vector3();
            m.set(c, v);
          }
          v.x += tt.nx * tt.area;
          v.y += tt.ny * tt.area;
          v.z += tt.nz * tt.area;
        }
      }
      for (const v of m.values()) {
        if (v.lengthSq() > 1e-16) v.normalize();
      }
      regionNormal.set(r, m);
    }

    // Per region: for each vertex on a FEATURE boundary, the inward inset
    // offset (mitered between its adjacent feature edges within this
    // region, tangent to the surface).
    const orig = (c: number, out: THREE.Vector3) =>
      out.set(canonicalPos[c * 3], canonicalPos[c * 3 + 1], canonicalPos[c * 3 + 2]);
    const insetOffset = new Map<number, Map<number, THREE.Vector3>>();
    {
      const eDir = new THREE.Vector3();
      const inward = new THREE.Vector3();
      const pa = new THREE.Vector3();
      const pb = new THREE.Vector3();
      for (let r = 0; r < regions.length; r++) {
        // Directed boundary edges of region r that are FEATURE edges,
        // with winding (region on the left → inward = n × dir).
        const dirCount = new Map<string, { ca: number; cb: number; n: number }>();
        const add = (ca: number, cb: number) => {
          const uk = edgeKey(ca, cb);
          const e = dirCount.get(uk);
          if (e) e.n++;
          else dirCount.set(uk, { ca, cb, n: 1 });
        };
        for (const t of regions[r]) {
          const tt = tris[t];
          add(tt.c0, tt.c1);
          add(tt.c1, tt.c2);
          add(tt.c2, tt.c0);
        }
        const perVertex = new Map<number, THREE.Vector3[]>();
        for (const [uk, e] of dirCount) {
          if (e.n !== 1) continue; // interior
          if (!featureKeys.has(uk)) continue; // open boundary — no bevel
          orig(e.ca, pa);
          orig(e.cb, pb);
          eDir.subVectors(pb, pa).normalize();
          for (const c of [e.ca, e.cb]) {
            const n = regionNormal.get(r)!.get(c);
            if (!n) continue;
            inward.copy(n).cross(eDir).normalize();
            let arr = perVertex.get(c);
            if (!arr) {
              arr = [];
              perVertex.set(c, arr);
            }
            arr.push(inward.clone());
          }
        }
        const offsets = new Map<number, THREE.Vector3>();
        for (const [c, dirs] of perVertex) {
          const m = new THREE.Vector3();
          for (const d of dirs) m.add(d);
          if (m.lengthSq() < 1e-12) continue;
          m.normalize();
          // Miter: keep `width` distance from each edge; clamp for sharp
          // corners (dot small ⇒ long miters).
          const d0 = Math.max(0.35, m.dot(dirs[0]));
          offsets.set(c, m.multiplyScalar(width / d0));
        }
        insetOffset.set(r, offsets);
      }
    }
    const insetPos = (r: number, c: number, out: THREE.Vector3): THREE.Vector3 => {
      orig(c, out);
      const off = insetOffset.get(r)?.get(c);
      if (off) out.add(off);
      return out;
    };

    // ---- emit ----------------------------------------------------------
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const srcUv = src.geometry.getAttribute("uv") as
      | THREE.BufferAttribute
      | undefined;
    const hasUv = !!srcUv;

    const pushTri = (
      p: THREE.Vector3[],
      n: THREE.Vector3[],
      uv: [number, number][] | null
    ) => {
      // Self-correcting winding: flip when the flat normal opposes the
      // smooth normals' average.
      const ux = p[1].x - p[0].x;
      const uy = p[1].y - p[0].y;
      const uz = p[1].z - p[0].z;
      const vx = p[2].x - p[0].x;
      const vy = p[2].y - p[0].y;
      const vz = p[2].z - p[0].z;
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      const sx = n[0].x + n[1].x + n[2].x;
      const sy = n[0].y + n[1].y + n[2].y;
      const sz = n[0].z + n[1].z + n[2].z;
      const order = fx * sx + fy * sy + fz * sz >= 0 ? [0, 1, 2] : [0, 2, 1];
      for (const i of order) {
        positions.push(p[i].x, p[i].y, p[i].z);
        normals.push(n[i].x, n[i].y, n[i].z);
        if (hasUv) uvs.push(uv ? uv[i][0] : 0, uv ? uv[i][1] : 0);
      }
    };

    // 1. Region triangles at inset positions, source normals/uvs.
    {
      const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (let t = 0; t < tris.length; t++) {
        const tt = tris[t];
        const r = regionOf[t];
        const cs = [tt.c0, tt.c1, tt.c2];
        const is = [tt.i0, tt.i1, tt.i2];
        for (let k = 0; k < 3; k++) {
          insetPos(r, cs[k], p[k]);
          if (srcNrm) n[k].fromBufferAttribute(srcNrm, is[k]);
          else n[k].set(tt.nx, tt.ny, tt.nz);
        }
        const uv: [number, number][] | null = hasUv
          ? is.map((i) => [srcUv!.getX(i), srcUv!.getY(i)] as [number, number])
          : null;
        pushTri(p, n, uv);
      }
    }

    // 2. Edge strips. Row r at end c: blend(chord, arc, prof[r]).
    //
    // The ARC is the circle tangent to both faces at their inset points —
    // centered at C = P + (a + b)/(1 + â·b̂) (a, b = the two inset
    // offsets; perpendicular faces reduce to C = P + a + b), swept by
    // slerping the C-relative spokes. Sweeping around P itself would
    // scoop INWARD (the bug the volume smoke caught: "round" measured
    // less volume than chamfer). Convex edges bulge out, concave edges
    // fillet in — both fall out of the same tangent-center construction.
    const P = new THREE.Vector3();
    const offA = new THREE.Vector3();
    const offB = new THREE.Vector3();
    const center = new THREE.Vector3();
    const spokeA = new THREE.Vector3();
    const spokeB = new THREE.Vector3();
    const arc = new THREE.Vector3();
    const rowPoint = (
      f: Feature,
      c: number,
      row: number,
      out: THREE.Vector3
    ): THREE.Vector3 => {
      const t = row / segments;
      orig(c, P);
      insetPos(f.a, c, offA).sub(P);
      insetPos(f.b, c, offB).sub(P);
      // chord = lerp of the two inset points, relative to P
      out.copy(offA).lerp(offB, t);
      const la = offA.length();
      const lb = offB.length();
      if (la > 1e-12 && lb > 1e-12) {
        const denom = 1 + offA.dot(offB) / (la * lb);
        if (denom > 0.05) {
          center.copy(offA).add(offB).divideScalar(denom); // C − P
          spokeA.copy(offA).sub(center);
          spokeB.copy(offB).sub(center);
          slerpVec(spokeA, spokeB, t, arc).add(center); // arc offset from P
          out.lerp(arc, prof[row]);
        }
      }
      return out.add(P);
    };
    const rowNormal = (
      f: Feature,
      c: number,
      row: number,
      out: THREE.Vector3
    ): THREE.Vector3 => {
      const t = row / segments;
      const na = regionNormal.get(f.a)!.get(c) ?? new THREE.Vector3(0, 1, 0);
      const nb = regionNormal.get(f.b)!.get(c) ?? na;
      slerpVec(na, nb, t, out);
      return out.normalize();
    };

    {
      const p00 = new THREE.Vector3();
      const p01 = new THREE.Vector3();
      const p10 = new THREE.Vector3();
      const p11 = new THREE.Vector3();
      const n00 = new THREE.Vector3();
      const n01 = new THREE.Vector3();
      const n10 = new THREE.Vector3();
      const n11 = new THREE.Vector3();
      for (const f of features) {
        for (let r = 0; r < segments; r++) {
          rowPoint(f, f.c0, r, p00);
          rowPoint(f, f.c1, r, p01);
          rowPoint(f, f.c0, r + 1, p10);
          rowPoint(f, f.c1, r + 1, p11);
          rowNormal(f, f.c0, r, n00);
          rowNormal(f, f.c1, r, n01);
          rowNormal(f, f.c0, r + 1, n10);
          rowNormal(f, f.c1, r + 1, n11);
          pushTri([p00.clone(), p01.clone(), p11.clone()], [n00.clone(), n01.clone(), n11.clone()], null);
          pushTri([p00.clone(), p11.clone(), p10.clone()], [n00.clone(), n11.clone(), n10.clone()], null);
        }
      }
    }

    // 3. Corner patches: vertices with ≥3 feature edges. Walk region
    // adjacency to order the edges cyclically, gather each strip's end
    // row, fan from the centroid.
    {
      const byVertex = new Map<number, Feature[]>();
      for (const f of features) {
        for (const c of [f.c0, f.c1]) {
          let arr = byVertex.get(c);
          if (!arr) {
            arr = [];
            byVertex.set(c, arr);
          }
          arr.push(f);
        }
      }
      for (const [c, fs] of byVertex) {
        if (fs.length < 3) continue;
        // Cyclic order: chain edges that share a region.
        const ordered: { f: Feature; from: number; to: number }[] = [];
        const remaining = fs.slice();
        const cur = remaining.shift()!;
        ordered.push({ f: cur, from: cur.a, to: cur.b });
        let closes = true;
        while (remaining.length) {
          const want = ordered[ordered.length - 1].to;
          const idx = remaining.findIndex((f) => f.a === want || f.b === want);
          if (idx === -1) {
            closes = false;
            break;
          }
          const nf = remaining.splice(idx, 1)[0];
          ordered.push({
            f: nf,
            from: want,
            to: nf.a === want ? nf.b : nf.a,
          });
        }
        if (!closes || ordered[ordered.length - 1].to !== ordered[0].from)
          continue; // non-manifold corner — leave the (tiny) hole
        // Hole boundary: each edge's end row at c, oriented from→to.
        const loop: THREE.Vector3[] = [];
        const loopN: THREE.Vector3[] = [];
        for (const o of ordered) {
          for (let r = 0; r < segments; r++) {
            // orient: row 0 is region a's side — reverse when from is b.
            const row = o.from === o.f.a ? r : segments - r;
            loop.push(rowPoint(o.f, c, row, new THREE.Vector3()).clone());
            loopN.push(rowNormal(o.f, c, row, new THREE.Vector3()).clone());
          }
        }
        // Triangulate the hole from its own rim (fan from loop[0]) — no
        // invented apex vertex. An apex must sit EXACTLY on the missing
        // sphere octant or the corner dents/bulges (a centroid apex
        // measurably dented: all 72 cube-corner tris wound inward, volume
        // NEGATIVE); the rim fan is flat-ish but can never dent, and at
        // bevel-scale widths reads fine. Spherical corner grids are the
        // known upgrade (spec §8 note).
        for (let i = 1; i < loop.length - 1; i++) {
          pushTri(
            [loop[0].clone(), loop[i], loop[i + 1]],
            [loopN[0].clone(), loopN[i], loopN[i + 1]],
            null
          );
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3)
    );
    geom.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(normals), 3)
    );
    if (hasUv)
      geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));

    if (st.geometry) st.geometry.dispose();
    st.geometry = geom;

    const out: GeometryValue = {
      kind: "geometry",
      geometry: geom,
      nodeId,
      transform: src.transform,
      materials: src.materials,
    };
    return { primary: out };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `bevel-3d:${nodeId}`;
    const st = ctx.state[key] as BevelState | undefined;
    if (st?.geometry) st.geometry.dispose();
    delete ctx.state[key];
  },
};
