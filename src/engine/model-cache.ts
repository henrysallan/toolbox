// Shared 3D model cache (081626_glb-scene-import.md §1).
//
// One parse per file URL, refcounted, shared by every Import 3D node that
// references it — the GLB scene-group expansion puts N interior nodes on
// the SAME file, and N parses (or N retained copies of a 50 MB scene) are
// not acceptable. Engine-side so the export bundle (src/engine +
// src/nodes) stays self-contained.
//
// What a loaded entry holds, per TOP-LEVEL object of the scene root
// (Blender's object list): a merged BufferGeometry in the object's LOCAL
// frame plus the object's decomposed world TRS, so the expansion can bake
// the pose into the node's transform params and each object stays
// movable/gizmo-editable from where the file placed it. Matrices that
// don't decompose to TRS (shear — rare) fall back to world-frame baking
// with `trs: null`. The whole-scene merge (`object` param = "", today's
// behavior, all STL/OBJ) is assembled lazily from the per-object parts
// with their world matrices re-applied — same result as merging the raw
// scene directly, up to float noise.
//
// Lifecycle: nodes acquire(url) with an identity token (their per-context
// state object) and release on dispose / url change; geometries dispose
// when the last token leaves. Loading is async — `pipeline-bump`
// re-evaluates the graph when a parse lands, and MODEL_CACHE_EVENT lets
// the `model_object` picker control re-render (it reads options off this
// cache, the EXR-layer-picker pattern, since the object list lives here
// and not on the param value). A failed parse parks the entry in "error"
// (no retry storm); re-picking the file mints a new object URL and a
// fresh entry.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MaterialDesc } from "./three-types";
import { makeMaterialDesc } from "./three-geometry";

export type ModelFormat = "glb" | "gltf" | "obj" | "stl";

// Fired on window whenever an entry finishes loading (alongside
// `pipeline-bump`) so UI reading peekModelObjects can re-render.
export const MODEL_CACHE_EVENT = "model-cache-updated";

// `object` param grammar: "" = whole scene merged; "top:<i>" = the i-th
// top-level child of the scene root.
export const MODEL_OBJECT_ALL = "";
export function modelObjectToken(index: number): string {
  return `top:${index}`;
}

export interface ModelTRS {
  position: [number, number, number];
  rotationEuler: [number, number, number];
  scale: [number, number, number];
}

export interface ModelObjectInfo {
  index: number;
  name: string; // raw scene-node name, may be ""
  label: string; // display name (name, or "Mesh <n>" fallback)
  meshCount: number;
  // null ⇒ the object's world matrix didn't decompose (shear): its
  // geometry is world-frame baked and pose params should stay default.
  trs: ModelTRS | null;
  // The seed material carried a baseColor texture (M4 extraction cue).
  hasBaseColorTex: boolean;
  // Scalar look of the subtree's first standard material (what seeds
  // slot 0) — the expansion bakes these into a Material node when it
  // also wires an extracted texture. Null = no standard material found.
  seed: { baseColor: string; roughness: number; metalness: number } | null;
}

// Lights/cameras recorded at parse time (world-space plain data) so the
// GLB scene-group expansion can bake them into Light / Camera nodes —
// the raw three scene is disposed after the split, so this is the only
// place they survive. `target` = position + world forward (glTF lights
// and cameras both look down their node's −Z).
export interface ModelLightInfo {
  kind: "directional" | "point" | "spot";
  name: string;
  label: string;
  color: string; // #rrggbb
  intensity: number;
  position: [number, number, number];
  target: [number, number, number];
  angleDeg?: number; // spot cone angle
  penumbra?: number; // spot
  distance?: number; // spot (0 = ∞)
}

export interface ModelCameraInfo {
  name: string;
  label: string;
  projection: "perspective" | "orthographic";
  fov: number; // vertical degrees (perspective)
  near: number;
  far: number;
  orthoHeight?: number;
  position: [number, number, number];
  target: [number, number, number];
}

// The loaded file's full scene inventory — what the expansion consumes.
export interface ModelSceneIndex {
  format: ModelFormat;
  objects: ModelObjectInfo[];
  lights: ModelLightInfo[];
  cameras: ModelCameraInfo[];
}

// Expansion rule (081626_glb-scene-import.md §2): only scene-container
// formats, and only when there is something to split — more than one
// mesh-bearing top-level object, or any lights/cameras. A single bare
// mesh stays a plain Import 3D node. Engine-side (not with the fragment
// builder) because the loader consults it at parse time to decide
// whether base-color bitmaps are worth extracting before the raw scene
// is disposed.
export function shouldExpandModel(index: ModelSceneIndex): boolean {
  if (index.format !== "glb" && index.format !== "gltf") return false;
  return (
    index.objects.length > 1 ||
    index.lights.length > 0 ||
    index.cameras.length > 0
  );
}

interface ObjectData {
  info: ModelObjectInfo;
  geometry: THREE.BufferGeometry; // local frame (world frame when trs null)
  material: MaterialDesc | null;
  worldMatrix: THREE.Matrix4; // identity when trs null (already baked)
  // Transient during load: the seed material's baseColor texture image,
  // converted to `baseColorBitmap` (straight-alpha) before the raw scene
  // is disposed — only when the file will expand (M4).
  baseColorImage?: ImageBitmapSource | null;
  baseColorBitmap?: ImageBitmap | null;
}

export interface ModelCacheEntry {
  url: string;
  format: ModelFormat;
  status: "loading" | "ready" | "error";
}

interface InternalEntry extends ModelCacheEntry {
  objects: ObjectData[];
  lights: ModelLightInfo[];
  cameras: ModelCameraInfo[];
  whole: { geometry: THREE.BufferGeometry; material: MaterialDesc | null } | null;
  refs: Set<object>;
  promise: Promise<void>; // settles when the load lands (never rejects)
  disposeTimer: ReturnType<typeof setTimeout> | null;
}

interface LoadedModel {
  objects: ObjectData[];
  lights: ModelLightInfo[];
  cameras: ModelCameraInfo[];
}

const cache = new Map<string, InternalEntry>();

function bump() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("pipeline-bump"));
  window.dispatchEvent(new Event(MODEL_CACHE_EVENT));
}

// ---------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------

// Normalize a set of geometries to a shared attribute layout so
// mergeGeometries never bails: position always, normal computed where
// missing, uv zero-filled where missing (if any part has it), everything
// else stripped. Same policy the pre-cache Import 3D used.
function normalizeParts(parts: THREE.BufferGeometry[]) {
  const wantUv = parts.some((g) => g.getAttribute("uv"));
  for (const g of parts) {
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    if (wantUv && !g.getAttribute("uv")) {
      g.setAttribute(
        "uv",
        new THREE.BufferAttribute(
          new Float32Array(g.getAttribute("position").count * 2),
          2
        )
      );
    }
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv")
        g.deleteAttribute(name);
    }
    g.morphAttributes = {};
  }
}

function seedMaterial(m: THREE.Material | THREE.Material[] | undefined): {
  desc: MaterialDesc | null;
  hasBaseColorTex: boolean;
  scalars: { baseColor: string; roughness: number; metalness: number } | null;
  mapImage: ImageBitmapSource | null;
} {
  const first = Array.isArray(m) ? m[0] : m;
  if (!first || !(first as THREE.MeshStandardMaterial).isMeshStandardMaterial)
    return { desc: null, hasBaseColorTex: false, scalars: null, mapImage: null };
  const std = first as THREE.MeshStandardMaterial;
  const scalars = {
    baseColor: `#${std.color.getHexString()}`,
    roughness: std.roughness,
    metalness: std.metalness,
  };
  return {
    desc: makeMaterialDesc({
      ...scalars,
      transmission: 0,
      ior: 1.5,
      alpha: 1,
    }),
    hasBaseColorTex: !!std.map,
    scalars,
    mapImage: (std.map?.image as ImageBitmapSource | undefined) ?? null,
  };
}

// Merge every mesh under `root` (inclusive) into one BufferGeometry with
// each mesh's world transform re-based into `frame` (pass null for plain
// world-frame baking). Also captures the subtree's first standard
// material as the slot-0 seed.
function mergeSubtree(
  root: THREE.Object3D,
  frame: THREE.Matrix4 | null
): {
  geometry: THREE.BufferGeometry | null;
  material: MaterialDesc | null;
  meshCount: number;
  hasBaseColorTex: boolean;
  scalars: { baseColor: string; roughness: number; metalness: number } | null;
  mapImage: ImageBitmapSource | null;
} {
  const parts: THREE.BufferGeometry[] = [];
  let material: MaterialDesc | null = null;
  let hasBaseColorTex = false;
  let scalars: { baseColor: string; roughness: number; metalness: number } | null =
    null;
  let mapImage: ImageBitmapSource | null = null;
  let meshCount = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshCount++;
    let g: THREE.BufferGeometry = mesh.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    if (frame) {
      g.applyMatrix4(
        new THREE.Matrix4().multiplyMatrices(frame, mesh.matrixWorld)
      );
    } else {
      g.applyMatrix4(mesh.matrixWorld);
    }
    parts.push(g);
    if (!material) {
      const seed = seedMaterial(mesh.material);
      material = seed.desc;
      hasBaseColorTex = seed.hasBaseColorTex;
      scalars = seed.scalars;
      mapImage = seed.mapImage;
    }
  });
  const empty = {
    geometry: null,
    material: null,
    meshCount,
    hasBaseColorTex,
    scalars,
    mapImage,
  };
  if (!parts.length) return empty;
  normalizeParts(parts);
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return { ...empty, geometry: merged };
}

// Decompose a world matrix into TRS, verifying the recomposition actually
// reproduces it (decompose() is lossy under shear — those fall back to
// world-frame baking rather than silently skewing the object).
function decomposeTRS(m: THREE.Matrix4): ModelTRS | null {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  const re = new THREE.Matrix4().compose(p, q, s);
  let scale = 1;
  let diff = 0;
  for (let i = 0; i < 16; i++) {
    scale = Math.max(scale, Math.abs(m.elements[i]));
    diff = Math.max(diff, Math.abs(m.elements[i] - re.elements[i]));
  }
  if (diff > 1e-4 * scale) return null;
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return {
    position: [p.x, p.y, p.z],
    rotationEuler: [e.x, e.y, e.z],
    scale: [s.x, s.y, s.z],
  };
}

function objectLabel(name: string, index: number): string {
  const trimmed = name.trim();
  return trimmed || `Mesh ${index + 1}`;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        for (const k in m) {
          const v = (m as unknown as Record<string, unknown>)[k];
          if (v && (v as THREE.Texture).isTexture)
            (v as THREE.Texture).dispose();
        }
        m.dispose();
      }
    }
  });
}

// Split a loaded scene into per-top-level-object data (raw scene is
// disposed afterwards — only the merged geometries are retained).
function splitScene(root: THREE.Object3D): ObjectData[] {
  root.updateWorldMatrix(true, true);
  const out: ObjectData[] = [];
  root.children.forEach((child, index) => {
    const trs = decomposeTRS(child.matrixWorld);
    const frame = trs
      ? new THREE.Matrix4().copy(child.matrixWorld).invert()
      : null;
    const sub = mergeSubtree(child, frame);
    if (!sub.geometry) return; // no meshes in this subtree (light/camera rigs)
    out.push({
      info: {
        index,
        name: child.name ?? "",
        label: objectLabel(child.name ?? "", index),
        meshCount: sub.meshCount,
        trs,
        hasBaseColorTex: sub.hasBaseColorTex,
        seed: sub.scalars,
      },
      geometry: sub.geometry,
      material: sub.material,
      worldMatrix: trs
        ? child.matrixWorld.clone()
        : new THREE.Matrix4(),
      baseColorImage: sub.mapImage,
    });
  });
  return out;
}

// World forward (−Z basis) of a node's world matrix — the direction glTF
// lights shine and cameras look. Falls back to −Z on degenerate bases.
function worldForward(m: THREE.Matrix4): THREE.Vector3 {
  const f = new THREE.Vector3(-m.elements[8], -m.elements[9], -m.elements[10]);
  return f.lengthSq() > 0 ? f.normalize() : new THREE.Vector3(0, 0, -1);
}

function vec3Of(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

// Record every punctual light (KHR_lights_punctual via GLTFLoader) and
// camera in the scene as plain world-space descriptors. Runs before the
// raw scene is disposed.
function collectSceneExtras(root: THREE.Object3D): {
  lights: ModelLightInfo[];
  cameras: ModelCameraInfo[];
} {
  const lights: ModelLightInfo[] = [];
  const cameras: ModelCameraInfo[] = [];
  root.traverse((o) => {
    const pos = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const fwd = worldForward(o.matrixWorld);
    const light = o as THREE.SpotLight;
    if ((o as THREE.Light).isLight) {
      const kind = light.isSpotLight
        ? "spot"
        : (o as THREE.DirectionalLight).isDirectionalLight
          ? "directional"
          : (o as THREE.PointLight).isPointLight
            ? "point"
            : null;
      if (!kind) return; // no ambient/hemisphere in glTF punctual lights
      lights.push({
        kind,
        name: o.name ?? "",
        label: (o.name ?? "").trim() || `Light ${lights.length + 1}`,
        color: `#${(o as THREE.Light).color.getHexString()}`,
        intensity: (o as THREE.Light).intensity,
        position: vec3Of(pos),
        target: vec3Of(pos.clone().add(fwd)),
        ...(kind === "spot"
          ? {
              angleDeg: (light.angle * 180) / Math.PI,
              penumbra: light.penumbra,
              distance: light.distance,
            }
          : {}),
      });
      return;
    }
    const cam = o as THREE.PerspectiveCamera;
    if (cam.isCamera) {
      const ortho = o as unknown as THREE.OrthographicCamera;
      const isOrtho = ortho.isOrthographicCamera === true;
      const len = pos.length();
      const target = pos
        .clone()
        .add(fwd.multiplyScalar(len > 1e-3 ? len : 5));
      cameras.push({
        name: o.name ?? "",
        label: (o.name ?? "").trim() || `Camera ${cameras.length + 1}`,
        projection: isOrtho ? "orthographic" : "perspective",
        fov: cam.isPerspectiveCamera ? cam.fov : 45,
        near: isOrtho ? ortho.near : cam.near,
        far: isOrtho ? ortho.far : cam.far,
        ...(isOrtho ? { orthoHeight: ortho.top - ortho.bottom } : {}),
        position: vec3Of(pos),
        target: vec3Of(target),
      });
    }
  });
  return { lights, cameras };
}

async function loadModel(url: string, format: ModelFormat): Promise<LoadedModel> {
  if (format === "stl") {
    const g = await new STLLoader().loadAsync(url);
    // Binary STLs can carry per-vertex color — strip to the shared
    // attribute set; normals come with the format (compute if absent).
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    }
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    return {
      objects: [
        {
          info: {
            index: 0,
            name: "",
            label: "Mesh 1",
            meshCount: 1,
            trs: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
            hasBaseColorTex: false,
            seed: null,
          },
          geometry: g,
          material: null,
          worldMatrix: new THREE.Matrix4(),
        },
      ],
      lights: [],
      cameras: [],
    };
  }
  if (format === "obj") {
    const grp = await new OBJLoader().loadAsync(url);
    const objects = splitScene(grp);
    disposeObject(grp);
    return { objects, lights: [], cameras: [] };
  }
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateWorldMatrix(true, true);
  const extras = collectSceneExtras(gltf.scene);
  const objects = splitScene(gltf.scene);
  // M4: when this file will expand into a scene group, convert each
  // textured object's baseColor image to a straight-alpha ImageBitmap
  // NOW — the raw scene (and its textures) is disposed next, and this is
  // the only moment the pixels are reachable. Straight alpha because the
  // engine composites non-premultiplied (devguide § alpha) and
  // createImageBitmap's default is premultiplied.
  if (
    typeof createImageBitmap === "function" &&
    shouldExpandModel({ format, objects: objects.map((o) => o.info), ...extras })
  ) {
    await Promise.all(
      objects.map(async (o) => {
        if (!o.baseColorImage) return;
        try {
          o.baseColorBitmap = await createImageBitmap(o.baseColorImage, {
            premultiplyAlpha: "none",
          });
        } catch {
          o.baseColorBitmap = null; // undecodable map — scalars still apply
        }
      })
    );
  }
  for (const o of objects) o.baseColorImage = null;
  disposeObject(gltf.scene);
  return { objects, ...extras };
}

// ---------------------------------------------------------------------
// Cache API
// ---------------------------------------------------------------------

// Acquire (idempotently, per token) the entry for a file URL, starting
// the load on first acquire. `token` is any stable object identifying
// the holder — Import 3D uses its per-context state object, so the same
// node in two evaluator contexts holds two refs.
export function acquireModel(
  url: string,
  format: ModelFormat,
  token: object
): ModelCacheEntry {
  let e = cache.get(url);
  if (e?.disposeTimer) {
    clearTimeout(e.disposeTimer);
    e.disposeTimer = null;
  }
  if (!e) {
    const entry: InternalEntry = {
      url,
      format,
      status: "loading",
      objects: [],
      lights: [],
      cameras: [],
      whole: null,
      refs: new Set(),
      promise: Promise.resolve(),
      disposeTimer: null,
    };
    e = entry;
    cache.set(url, e);
    entry.promise = loadModel(url, format)
      .then((loaded) => {
        if (cache.get(url) !== entry) {
          // Every holder left (or the URL was re-minted) mid-load.
          for (const o of loaded.objects) {
            o.geometry.dispose();
            o.baseColorBitmap?.close();
          }
          return;
        }
        entry.objects = loaded.objects;
        entry.lights = loaded.lights;
        entry.cameras = loaded.cameras;
        entry.status = "ready";
        bump();
      })
      .catch(() => {
        if (cache.get(url) === entry) {
          entry.status = "error";
          bump();
        }
      });
  }
  e.refs.add(token);
  return e;
}

export function releaseModel(url: string, token: object) {
  const e = cache.get(url);
  if (!e) return;
  e.refs.delete(token);
  if (e.refs.size > 0 || e.disposeTimer) return;
  // Grace period before disposal: the scene-group expansion holds a
  // temporary editor token and the inserted nodes only acquire on their
  // first eval, and delete→undo within a beat shouldn't re-parse the
  // file. A re-acquire cancels the timer.
  e.disposeTimer = setTimeout(() => {
    e.disposeTimer = null;
    if (e.refs.size > 0 || cache.get(url) !== e) return;
    for (const o of e.objects) {
      o.geometry.dispose();
      o.baseColorBitmap?.close(); // un-taken extraction
      o.baseColorBitmap = null;
    }
    e.objects = [];
    e.whole?.geometry.dispose();
    e.whole = null;
    cache.delete(url);
  }, 8000);
}

// Resolve an `object` param token against a (ready) entry. "" = the
// whole-scene merge (built lazily, world matrices re-applied); "top:<i>"
// = that top-level object's local-frame merge. Unknown tokens (file
// changed under a saved graph) resolve to null — the node emits nothing
// rather than silently merging the wrong thing.
export function resolveModelGeometry(
  entry: ModelCacheEntry,
  objectToken: string
): { geometry: THREE.BufferGeometry; material: MaterialDesc | null } | null {
  const e = entry as InternalEntry;
  if (e.status !== "ready" || !e.objects.length) return null;
  if (objectToken && objectToken !== MODEL_OBJECT_ALL) {
    const m = /^top:(\d+)$/.exec(objectToken);
    if (!m) return null;
    const index = Number(m[1]);
    const o = e.objects.find((x) => x.info.index === index);
    return o ? { geometry: o.geometry, material: o.material } : null;
  }
  if (!e.whole) {
    const parts = e.objects.map((o) => {
      const g = o.geometry.clone();
      g.applyMatrix4(o.worldMatrix);
      return g;
    });
    normalizeParts(parts);
    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!merged) return null;
    const material = e.objects.find((o) => o.material)?.material ?? null;
    e.whole = { geometry: merged, material };
  }
  return e.whole;
}

// UI-side peek for the `model_object` picker: the loaded file's
// top-level object list, or null while loading/failed.
export function peekModelObjects(url: string): ModelObjectInfo[] | null {
  const e = cache.get(url);
  if (!e || e.status !== "ready") return null;
  return e.objects.map((o) => o.info);
}

// Editor-side await for the expansion: acquire (kicking the load if
// needed, holding a ref under `token`) and resolve with the scene index
// once the parse lands — null on parse failure. The caller releases its
// token when done; the grace period in releaseModel bridges to the
// inserted nodes' first-eval acquires.
export async function acquireModelIndex(
  url: string,
  format: ModelFormat,
  token: object
): Promise<ModelSceneIndex | null> {
  const e = acquireModel(url, format, token) as InternalEntry;
  await e.promise;
  return peekModelSceneIndex(url);
}

// Hand the extracted baseColor bitmaps to the expansion. Take-once:
// ownership moves to the inserted Image Source params, so a later entry
// disposal won't close pixels the graph now owns.
export function takeModelBaseColorMaps(
  url: string
): Map<number, ImageBitmap> | null {
  const e = cache.get(url);
  if (!e || e.status !== "ready") return null;
  const out = new Map<number, ImageBitmap>();
  for (const o of e.objects) {
    if (o.baseColorBitmap) {
      out.set(o.info.index, o.baseColorBitmap);
      o.baseColorBitmap = null;
    }
  }
  return out.size ? out : null;
}

// Full scene inventory for the GLB scene-group expansion (M2): objects +
// lights + cameras, or null while loading/failed.
export function peekModelSceneIndex(url: string): ModelSceneIndex | null {
  const e = cache.get(url);
  if (!e || e.status !== "ready") return null;
  return {
    format: e.format,
    objects: e.objects.map((o) => o.info),
    lights: e.lights,
    cameras: e.cameras,
  };
}
