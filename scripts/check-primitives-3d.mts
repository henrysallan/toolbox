// check-primitives-3d: 081926 M1 — new mesh factory rows + shared
// flat_shade / sweep / sides / arc. Offline; three via the package
// import (absolute node_modules path not needed with tsx).
//
//   npx tsx scripts/check-primitives-3d.mts

import * as THREE from "three";
import type { NodeDefinition, NodeOutput, RenderContext } from "../src/engine/types.ts";
import type { GeometryValue } from "../src/engine/three-types.ts";
import {
  capsule3DNode,
  cone3DNode,
  cube3DNode,
  cylinder3DNode,
  plane3DNode,
  polyhedron3DNode,
  ring3DNode,
  roundedCube3DNode,
  sphere3DNode,
  torus3DNode,
  torusKnot3DNode,
} from "../src/nodes/three/primitives.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function evalGeom(
  def: NodeDefinition,
  params: Record<string, unknown>,
  nodeId = "n"
): { geom: THREE.BufferGeometry; sig: string; ctx: RenderContext } {
  const ctx = makeCtx();
  const out = def.compute({
    inputs: {},
    auxIn: {},
    params,
    ctx,
    nodeId,
  }) as NodeOutput;
  const primary = out.primary as GeometryValue | undefined;
  if (!primary || primary.kind !== "geometry") {
    throw new Error(`${def.type}: no geometry`);
  }
  const st = ctx.state[`${def.type}:${nodeId}`] as
    | { geometry: THREE.BufferGeometry; geomSig: string }
    | undefined;
  if (!st) throw new Error(`${def.type}: missing retained state`);
  return { geom: primary.geometry, sig: st.geomSig, ctx };
}

function attrF32(g: THREE.BufferGeometry, name: string): Float32Array {
  const a = g.getAttribute(name);
  if (!a) throw new Error(`missing attribute ${name}`);
  return a.array as Float32Array;
}

function buffersEqual(a: THREE.BufferGeometry, b: THREE.BufferGeometry, label: string) {
  const pa = attrF32(a, "position");
  const pb = attrF32(b, "position");
  check(
    `${label}: position length`,
    pa.length === pb.length,
    `${pa.length} vs ${pb.length}`
  );
  let posOk = pa.length === pb.length;
  if (posOk) {
    for (let i = 0; i < pa.length; i++) {
      if (pa[i] !== pb[i]) {
        posOk = false;
        break;
      }
    }
  }
  check(`${label}: position bytes`, posOk);

  const ia = a.index?.array;
  const ib = b.index?.array;
  const sameIndex =
    (ia == null && ib == null) ||
    (!!ia &&
      !!ib &&
      ia.length === ib.length &&
      Array.from(ia).every((v, i) => v === ib[i]));
  check(`${label}: index bytes`, sameIndex, `a=${ia?.length} b=${ib?.length}`);
}

function signedVolume(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute("position");
  if (!pos) return NaN;
  const triple = (i0: number, i1: number, i2: number) => {
    const ax = pos.getX(i0),
      ay = pos.getY(i0),
      az = pos.getZ(i0);
    const bx = pos.getX(i1),
      by = pos.getY(i1),
      bz = pos.getZ(i1);
    const cx = pos.getX(i2),
      cy = pos.getY(i2),
      cz = pos.getZ(i2);
    return (
      ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
    );
  };
  let acc = 0;
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      acc += triple(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      acc += triple(i, i + 1, i + 2);
    }
  }
  return acc / 6;
}

function vertCount(g: THREE.BufferGeometry): number {
  return g.getAttribute("position")?.count ?? 0;
}

function faceCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : vertCount(g) / 3;
}

function firstTriangleFlat(g: THREE.BufferGeometry): boolean {
  if (g.index) return false;
  const nrm = g.getAttribute("normal");
  const pos = g.getAttribute("position");
  if (!nrm || !pos || pos.count < 3) return false;
  const nx = nrm.getX(0),
    ny = nrm.getY(0),
    nz = nrm.getZ(0);
  const close = (i: number) =>
    Math.abs(nrm.getX(i) - nx) < 1e-5 &&
    Math.abs(nrm.getY(i) - ny) < 1e-5 &&
    Math.abs(nrm.getZ(i) - nz) < 1e-5;
  if (!close(1) || !close(2)) return false;
  const abx = pos.getX(1) - pos.getX(0);
  const aby = pos.getY(1) - pos.getY(0);
  const abz = pos.getZ(1) - pos.getZ(0);
  const acx = pos.getX(2) - pos.getX(0);
  const acy = pos.getY(2) - pos.getY(0);
  const acz = pos.getZ(2) - pos.getZ(0);
  const fx = aby * acz - abz * acy;
  const fy = abz * acx - abx * acz;
  const fz = abx * acy - aby * acx;
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-12) return false;
  const nl = Math.hypot(nx, ny, nz);
  const dot = (nx * fx + ny * fy + nz * fz) / (nl * fl);
  return Math.abs(Math.abs(dot) - 1) < 1e-4;
}

// ── vertex/index sanity ──────────────────────────────────────────

for (const def of [
  capsule3DNode,
  roundedCube3DNode,
  torusKnot3DNode,
  polyhedron3DNode,
  ring3DNode,
]) {
  const { geom } = evalGeom(def, {});
  check(`${def.type}: has verts`, vertCount(geom) >= 3);
  check(`${def.type}: has faces`, faceCount(geom) >= 1);
}

// ── watertight (signed volume > 0) ─────────────────────────────

const watertight: Array<[NodeDefinition, Record<string, unknown>, string]> = [
  [capsule3DNode, {}, "capsule-3d"],
  [roundedCube3DNode, {}, "rounded-cube-3d"],
  [torusKnot3DNode, {}, "torus-knot-3d"],
  [polyhedron3DNode, { shape: "icosahedron" }, "polyhedron-3d/icosahedron"],
  [polyhedron3DNode, { shape: "octahedron" }, "polyhedron-3d/octahedron"],
  [polyhedron3DNode, { shape: "tetrahedron" }, "polyhedron-3d/tetrahedron"],
  [polyhedron3DNode, { shape: "dodecahedron" }, "polyhedron-3d/dodecahedron"],
];
for (const [def, params, tag] of watertight) {
  const { geom } = evalGeom(def, params, `wt-${tag}`);
  const vol = signedVolume(geom);
  check(`${tag}: watertight volume > 0`, vol > 0, `vol=${vol}`);
}

// ── sweep volume decreases monotonically ──────────────────────────

function sweepVolumes(
  def: NodeDefinition,
  key: string,
  values: number[],
  rest: Record<string, unknown> = {}
): number[] {
  return values.map((v, i) => {
    const { geom } = evalGeom(def, { ...rest, [key]: v }, `sw-${def.type}-${i}`);
    return Math.abs(signedVolume(geom));
  });
}

function monotonicDown(name: string, vols: number[]) {
  let ok = true;
  for (let i = 1; i < vols.length; i++) {
    if (vols[i] > vols[i - 1] + 1e-8) ok = false;
  }
  check(
    `${name}: sweep volume monotone`,
    ok && vols[0] > vols[vols.length - 1],
    vols.map((v) => v.toFixed(5)).join(" → ")
  );
}

monotonicDown("sphere sweep_h", sweepVolumes(sphere3DNode, "sweep_h", [360, 270, 180, 90]));
monotonicDown("sphere sweep_v", sweepVolumes(sphere3DNode, "sweep_v", [180, 135, 90, 45]));
monotonicDown("cylinder arc", sweepVolumes(cylinder3DNode, "arc", [360, 270, 180, 90]));
monotonicDown("cone arc", sweepVolumes(cone3DNode, "arc", [360, 270, 180, 90]));
monotonicDown("torus arc", sweepVolumes(torus3DNode, "arc", [360, 270, 180, 90]));

// ── flat_shade ───────────────────────────────────────────────────

{
  const { geom, sig } = evalGeom(cube3DNode, { size: 1, flat_shade: true }, "flat");
  check("flat_shade cube: non-indexed", geom.index === null);
  check("flat_shade cube: per-face normals", firstTriangleFlat(geom));
  check("flat_shade cube: sig tagged", sig.endsWith("|flat"), sig);
  const smooth = evalGeom(cube3DNode, { size: 1 }, "smooth");
  check("flat_shade off: sig untagged", smooth.sig === "1", smooth.sig);
}

{
  const { geom } = evalGeom(sphere3DNode, { radius: 0.6, flat_shade: true }, "sflat");
  check("flat_shade sphere: non-indexed", geom.index === null);
  check("flat_shade sphere: per-face normals", firstTriangleFlat(geom));
}

// ── sides: 6 → 6 side quads ────────────────────────────────────

{
  const { geom } = evalGeom(cylinder3DNode, { sides: 6 }, "hex");
  const body = geom.groups[0];
  const quads = body ? body.count / 6 : NaN;
  check("cylinder sides=6: 6 side quads", quads === 6, `group0.count/6=${quads}`);
}

// ── geomSig + buffers identical at defaults ────────────────────

{
  const { geom, sig } = evalGeom(cube3DNode, { size: 1 });
  check("cube default geomSig", sig === "1", sig);
  buffersEqual(geom, new THREE.BoxGeometry(1, 1, 1), "cube default");
}
{
  const { geom, sig } = evalGeom(sphere3DNode, { radius: 0.6 });
  check("sphere default geomSig", sig === "0.6", sig);
  buffersEqual(geom, new THREE.SphereGeometry(0.6, 48, 32), "sphere default");
}
{
  const { geom, sig } = evalGeom(plane3DNode, { width: 2, height: 2 });
  check("plane default geomSig", sig === "2,2", sig);
  buffersEqual(geom, new THREE.PlaneGeometry(2, 2), "plane default");
}
{
  const { geom, sig } = evalGeom(cylinder3DNode, { radius: 0.5, height: 1.2 });
  check("cylinder default geomSig", sig === "0.5,1.2", sig);
  buffersEqual(geom, new THREE.CylinderGeometry(0.5, 0.5, 1.2, 48), "cylinder default");
}
{
  const { geom, sig } = evalGeom(cone3DNode, { radius: 0.6, height: 1.2 });
  check("cone default geomSig", sig === "0.6,1.2", sig);
  buffersEqual(geom, new THREE.ConeGeometry(0.6, 1.2, 48), "cone default");
}
{
  const { geom, sig } = evalGeom(torus3DNode, { radius: 0.6, tube: 0.22 });
  check("torus default geomSig", sig === "0.6,0.22", sig);
  buffersEqual(geom, new THREE.TorusGeometry(0.6, 0.22, 24, 64), "torus default");
}

// omitted new params ≡ explicit defaults (sig + buffers)
{
  const omit = evalGeom(sphere3DNode, { radius: 0.6 }, "omit");
  const expl = evalGeom(sphere3DNode, { radius: 0.6, sweep_h: 360, sweep_v: 180 }, "expl");
  check("sphere omit≡explicit sig", omit.sig === expl.sig, `${omit.sig} vs ${expl.sig}`);
  buffersEqual(omit.geom, expl.geom, "sphere omit≡explicit");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall primitives-3d checks passed");
