import * as THREE from "three";
import type { ImageValue, NodeDefinition, RenderContext } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { bakeAmbientOcclusion } from "@/engine/ao-bake";

// =====================================================================
// Ambient Occlusion — UV-space bake (geometry → image)
// =====================================================================
//
// Side-branch baker, not flow-through: feed the mesh (after Texture
// Projection if you need unique UVs), get a grayscale image whose UVs
// match the mesh, then wire that into Material's `ao_map` — or into
// roughness / alpha / base color for a dirt/cavity look.
//
// Split BEFORE Material so the graph stays acyclic:
//   cube → [AO] → Material.ao_map
//        → Material.geometry
//
// CPU hemisphere rays against a BVH of the mesh, rasterized into the
// UV atlas. Cached in ctx.state on (geometry identity, transform,
// params). Convex meshes (a cube, a sphere) have almost no self-
// occlusion; crevices, torus inners, and `inside` (flipped normals,
// rooms) are where it reads.

interface AoState {
  tex: WebGLTexture | null;
  image: ImageValue | null;
  sig: string;
  geom: THREE.BufferGeometry | null;
}

function allocRgba8(
  gl: WebGL2RenderingContext,
  w: number,
  h: number
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("ambient-occlusion-3d: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function packed(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, n: number): Float32Array {
  const out = new Float32Array(attr.count * n);
  if (n === 3) {
    for (let i = 0; i < attr.count; i++) {
      out[i * 3] = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    }
  } else {
    for (let i = 0; i < attr.count; i++) {
      out[i * 2] = attr.getX(i);
      out[i * 2 + 1] = attr.getY(i);
    }
  }
  return out;
}

function worldPositions(
  local: Float32Array,
  count: number,
  matrix: THREE.Matrix4
): Float32Array {
  const out = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!).applyMatrix4(matrix);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

function worldNormals(
  local: Float32Array,
  count: number,
  matrix: THREE.Matrix4
): Float32Array {
  const out = new Float32Array(count * 3);
  const n = new THREE.Vector3();
  const nMat = new THREE.Matrix3().getNormalMatrix(matrix);
  for (let i = 0; i < count; i++) {
    n.set(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!)
      .applyMatrix3(nMat)
      .normalize();
    out[i * 3] = n.x;
    out[i * 3 + 1] = n.y;
    out[i * 3 + 2] = n.z;
  }
  return out;
}

export const ambientOcclusion3DNode: NodeDefinition = {
  type: "ambient-occlusion-3d",
  name: "Ambient Occlusion",
  category: "3d",
  searchAliases: ["ao", "occlusion", "bake", "cavity"],
  description:
    "Bakes a UV-mapped ambient occlusion image from 3D geometry. White is open, black is occluded. Wire the image into Material's AO map (or any other image channel). Uses the mesh's UVs — run Texture Projection first if they overlap or are missing.",
  facts: {
    space: { "param:radius": "world3d" },
    gotchas: [
      "radius is a world-space ray distance after applying the input geometry's own position/rotation/scale, not relative to mesh bounds.",
      "Bakes into the mesh's own UV atlas; overlapping or missing UVs need Texture Projection first or the result looks wrong.",
      "Split before Material so geometry feeds both this node and Material.geometry directly; routing geometry through AO first would make the graph circular.",
      "inside flips the ray hemisphere for interior surfaces (flipped normals, room interiors) instead of exterior convex bakes.",
      "Cached per node on geometry identity plus transform and params, so it only re-bakes when one of those changes.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "geometry", type: "geometry", required: true }],
  params: [
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "samples",
      label: "Samples",
      type: "scalar",
      min: 4,
      max: 64,
      step: 1,
      default: 16,
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 64,
      max: 1024,
      step: 64,
      default: 256,
    },
    {
      name: "gamma",
      label: "Contrast",
      type: "scalar",
      min: 0.2,
      max: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "inside",
      label: "Inside",
      type: "boolean",
      default: false,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};
    const geom = src.geometry;
    const posAttr = geom.getAttribute("position");
    if (!posAttr) return {};

    const radius = (params.radius as number) ?? 1;
    const samples = (params.samples as number) ?? 16;
    const resolution = (params.resolution as number) ?? 256;
    const gamma = (params.gamma as number) ?? 1;
    const inside = !!params.inside;
    const seed = (params.seed as number) ?? 1;
    const t = src.transform;
    const sig = [
      radius,
      samples,
      resolution,
      gamma,
      inside ? 1 : 0,
      seed,
      t.position.join(","),
      t.rotationEuler.join(","),
      t.scale.join(","),
    ].join("|");

    const key = `ambient-occlusion-3d:${nodeId}`;
    let st = ctx.state[key] as AoState | undefined;
    if (st && st.sig === sig && st.geom === geom && st.image) return { primary: st.image };

    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          t.rotationEuler[0],
          t.rotationEuler[1],
          t.rotationEuler[2]
        )
      ),
      new THREE.Vector3(...t.scale)
    );
    const localPos = packed(posAttr, 3);
    const positions = worldPositions(localPos, posAttr.count, matrix);
    const nrmAttr = geom.getAttribute("normal");
    const normals = nrmAttr
      ? worldNormals(packed(nrmAttr, 3), nrmAttr.count, matrix)
      : undefined;
    const uvAttr = geom.getAttribute("uv");
    const uvs = uvAttr ? packed(uvAttr, 2) : undefined;
    const idx = geom.index ? Array.from(geom.index.array) : null;

    const baked = bakeAmbientOcclusion({
      positions,
      normals,
      uvs,
      index: idx,
      vertexCount: posAttr.count,
      resolution,
      samples,
      radius,
      seed,
      invertNormals: inside,
      gamma,
    });

    const gl = ctx.gl;
    if (!st) {
      st = { tex: null, image: null, sig: "", geom: null };
      ctx.state[key] = st;
    }
    if (
      !st.tex ||
      !st.image ||
      st.image.width !== baked.width ||
      st.image.height !== baked.height
    ) {
      if (st.tex) gl.deleteTexture(st.tex);
      st.tex = allocRgba8(gl, baked.width, baked.height);
    }
    gl.bindTexture(gl.TEXTURE_2D, st.tex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      baked.width,
      baked.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      baked.pixels
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    // New ImageValue so the material texture bridge sees identity move.
    st.image = {
      kind: "image",
      texture: st.tex,
      width: baked.width,
      height: baked.height,
    };
    st.sig = sig;
    st.geom = geom;
    return { primary: st.image };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = `ambient-occlusion-3d:${nodeId}`;
    const st = ctx.state[key] as AoState | undefined;
    if (st?.tex) ctx.gl.deleteTexture(st.tex);
    delete ctx.state[key];
  },
};
