// check-points-3d: 3D Mesh to Points (vertex domain), 3D Scatter
// Points grid mode, and Instance Transform scale polarity. Offline —
// BufferGeometry in, points3d out. Values go through coerceValue the
// way the evaluator would (TESTING.md: a points3d socket is kind
// "points" + z, and coerceValue is the gate).
//
//   npx tsx scripts/check-points-3d.mts

import * as THREE from "three";
import type {
  NodeOutput,
  NoiseFieldValue,
  PointsValue,
  RenderContext,
  SocketType,
  SocketValue,
} from "../src/engine/types.ts";
import type { GeometryValue, InstancesValue } from "../src/engine/three-types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { is3DPoints } from "../src/engine/points.ts";
import { meshToPoints3DNode } from "../src/nodes/three/mesh-to-points.ts";
import { scatterPoints3DNode } from "../src/nodes/three/scatter-points-3d.ts";
import { instanceTransform3DNode } from "../src/nodes/three/instance-transform.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
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

function geometryValue(
  geometry: THREE.BufferGeometry,
  transform?: Partial<GeometryValue["transform"]>
): GeometryValue {
  return {
    kind: "geometry",
    geometry,
    transform: {
      position: [0, 0, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
      ...transform,
    },
    materials: [],
  };
}

function evalNode(
  def: typeof meshToPoints3DNode,
  input: SocketValue | undefined,
  socket: SocketType,
  params: Record<string, unknown>
): PointsValue | undefined {
  const ctx = makeCtx();
  const coerced = coerceValue(input, socket, ctx);
  const out = def.compute({
    inputs: { source: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "n",
  }) as NodeOutput;
  return out.primary?.kind === "points" ? out.primary : undefined;
}

function triangleGeom(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
  );
  g.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
  );
  return g;
}

{
  const pts = evalNode(
    meshToPoints3DNode,
    geometryValue(triangleGeom()),
    "geometry",
    {}
  );
  check("mesh-to-points: 3 vertices → 3 points", pts?.count === 3);
  check("mesh-to-points: is 3D", !!pts && is3DPoints(pts));
  check(
    "mesh-to-points: vertex 0 at origin",
    !!pts && close(pts.positions[0], 0) && close(pts.positions[1], 0) && close(pts.z![0], 0)
  );
  check(
    "mesh-to-points: vertex 1 at (1,0,0)",
    !!pts && close(pts.positions[2], 1) && close(pts.positions[3], 0) && close(pts.z![1], 0)
  );
  check(
    "mesh-to-points: vertex 2 at (0,1,0)",
    !!pts && close(pts.positions[4], 0) && close(pts.positions[5], 1) && close(pts.z![2], 0)
  );
  check(
    "mesh-to-points: carries vertex normals",
    !!pts &&
      close(pts.normals![0], 0) &&
      close(pts.normals![1], 0) &&
      close(pts.normals![2], 1)
  );
}

{
  const pts = evalNode(
    meshToPoints3DNode,
    geometryValue(triangleGeom(), { position: [2, 0, 0] }),
    "geometry",
    {}
  );
  check(
    "mesh-to-points: carried translate lands in world space",
    !!pts && close(pts.positions[0], 2) && close(pts.positions[2], 3)
  );
}

{
  const box = new THREE.BoxGeometry(1, 1, 1);
  const pts = evalNode(
    meshToPoints3DNode,
    geometryValue(box),
    "geometry",
    {}
  );
  check(
    "mesh-to-points: BoxGeometry emits position.count vertices",
    pts?.count === box.getAttribute("position").count
  );
  if (pts) {
    let minX = Infinity,
      maxX = -Infinity;
    for (let i = 0; i < pts.count; i++) {
      minX = Math.min(minX, pts.positions[i * 2]);
      maxX = Math.max(maxX, pts.positions[i * 2]);
    }
    check("mesh-to-points: box spans ±0.5 on X", close(minX, -0.5) && close(maxX, 0.5));
  }
}

{
  const empty = evalNode(meshToPoints3DNode, undefined, "geometry", {});
  check("mesh-to-points: unwired source → empty 3D points", empty?.count === 0);
  check("mesh-to-points: empty still tagged 3D", !!empty && is3DPoints(empty));
}

{
  const pts = evalNode(
    scatterPoints3DNode,
    undefined,
    "geometry",
    {
      mode: "grid",
      count_x: 2,
      count_y: 1,
      count_z: 2,
      spacing_x: 1,
      spacing_y: 1,
      spacing_z: 1,
    }
  );
  check("scatter grid: 2×1×2 → 4 points", pts?.count === 4);
  check("scatter grid: is 3D", !!pts && is3DPoints(pts));
  const want = [
    [-0.5, 0, -0.5],
    [0.5, 0, -0.5],
    [-0.5, 0, 0.5],
    [0.5, 0, 0.5],
  ];
  let gridOk = !!pts;
  if (pts) {
    for (let i = 0; i < 4; i++) {
      if (
        !close(pts.positions[i * 2], want[i][0]) ||
        !close(pts.positions[i * 2 + 1], want[i][1]) ||
        !close(pts.z![i], want[i][2])
      ) {
        gridOk = false;
      }
    }
  }
  check("scatter grid: centered lattice (x-fast, z-slow)", gridOk);
  check(
    "scatter grid: world-up normals",
    !!pts &&
      close(pts.normals![0], 0) &&
      close(pts.normals![1], 1) &&
      close(pts.normals![2], 0)
  );
}

{
  const decoy = geometryValue(triangleGeom());
  const pts = evalNode(scatterPoints3DNode, decoy, "geometry", {
    mode: "grid",
    count_x: 1,
    count_y: 1,
    count_z: 1,
    spacing_x: 0.5,
    spacing_y: 0.5,
    spacing_z: 0.5,
  });
  check(
    "scatter grid: ignores source (1×1×1 at origin, not the triangle)",
    !!pts &&
      pts.count === 1 &&
      close(pts.positions[0], 0) &&
      close(pts.positions[1], 0) &&
      close(pts.z![0], 0)
  );
}

{
  const sockets = scatterPoints3DNode.resolveInputs?.({ mode: "grid" }) ?? [];
  check("scatter grid: resolveInputs hides source", sockets.length === 0);
  const surface = scatterPoints3DNode.resolveInputs?.({ mode: "surface" }) ?? [];
  check(
    "scatter surface: source socket still required",
    surface.length === 1 && surface[0].name === "source" && surface[0].required === true
  );
}

{
  const box = new THREE.BoxGeometry(1, 1, 1);
  const pts = evalNode(scatterPoints3DNode, geometryValue(box), "geometry", {
    mode: "surface",
    count: 12,
    seed: 3,
  });
  check("scatter surface: count honored", pts?.count === 12);
  check("scatter surface: is 3D with normals", !!pts && is3DPoints(pts) && !!pts.normals);
}

{
  const coerced = coerceValue(
    evalNode(
      meshToPoints3DNode,
      geometryValue(triangleGeom()),
      "geometry",
      {}
    ),
    "points3d",
    makeCtx()
  ) as PointsValue | undefined;
  check(
    "coerceValue(points3d) keeps mesh-to-points output",
    coerced?.count === 3 && is3DPoints(coerced)
  );
}

// Instance Transform: Centered noise is bipolar for offset, unipolar
// for scale — a large Scale Y must not cross zero and invert copies.
{
  const n = 48;
  const positions = new Float32Array(n * 3);
  const quaternions = new Float32Array(n * 4);
  const scales = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (i % 8) * 0.4 - 1.4;
    positions[i * 3 + 1] = Math.floor(i / 8) * 0.4 - 1.0;
    positions[i * 3 + 2] = 0;
    quaternions[i * 4 + 3] = 1;
    scales[i * 3] = scales[i * 3 + 1] = scales[i * 3 + 2] = 1;
  }
  const src: InstancesValue = {
    kind: "instances",
    source: geometryValue(new THREE.BoxGeometry(0.1, 0.1, 0.1)),
    count: n,
    positions,
    quaternions,
    scales,
    retainKey: {},
  };
  const field: NoiseFieldValue = {
    kind: "noise_field",
    noiseType: "simplex",
    scale: 1.5,
    octaves: 1,
    persistence: 0.5,
    lacunarity: 2,
    offset: [0, 0],
    seed: 7,
    w: 0,
    contrast: 1,
  };
  const ctx = makeCtx();
  const instances = coerceValue(src, "instances", ctx);
  const noise = coerceValue(field, "noise_field", ctx);
  const out = instanceTransform3DNode.compute({
    inputs: { instances, noise },
    auxIn: {},
    params: {
      centered: true,
      scale_x: 1,
      scale_y: 200,
      scale_z: 1,
      offset_x: 0,
      offset_y: 2,
      offset_z: 0,
      rot_x: 0,
      rot_y: 0,
      rot_z: 0,
    },
    ctx,
    nodeId: "it",
  }) as NodeOutput;
  const result = out.primary as InstancesValue | undefined;
  let minSy = Infinity;
  let maxSy = -Infinity;
  let minDy = Infinity;
  let maxDy = -Infinity;
  let anyNegativeScale = false;
  if (result) {
    for (let i = 0; i < n; i++) {
      const sy = result.scales[i * 3 + 1];
      if (sy < minSy) minSy = sy;
      if (sy > maxSy) maxSy = sy;
      if (sy < 0) anyNegativeScale = true;
      const dy = result.positions[i * 3 + 1] - positions[i * 3 + 1];
      if (dy < minDy) minDy = dy;
      if (dy > maxDy) maxDy = dy;
    }
  }
  check("instance transform: centered noise + Scale Y 200 emits", !!result);
  check(
    "instance transform: scale stays non-negative",
    !!result && !anyNegativeScale,
    `minSy=${minSy}`
  );
  check(
    "instance transform: scale mixes 1 → target (never below rest)",
    !!result && minSy >= 1 - 1e-5 && maxSy <= 200 + 1e-5,
    `minSy=${minSy} maxSy=${maxSy}`
  );
  check(
    "instance transform: offset stays bipolar under Centered",
    !!result && minDy < -0.05 && maxDy > 0.05,
    `minDy=${minDy} maxDy=${maxDy}`
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
if (failures) process.exit(1);
