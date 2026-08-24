// =====================================================================
// geometry → object3d wrap + MaterialDesc resolution
// =====================================================================
//
// The scene-side half of the modeling chain (081026 spec §1.3): a
// `geometry` value auto-wraps into a THREE.Mesh wherever an `object3d` is
// expected (coerce.ts calls wrapGeometryAsObject). The wrap is RETAINED,
// keyed on the value's BufferGeometry — which is itself retained by the
// producing node and stable across param drags — so a TRS/color drag
// updates one mesh in place instead of minting meshes per eval (the exact
// behavior primitives had when they owned their meshes).
//
// Lifecycle: when a producer disposes its BufferGeometry, the WeakMap
// entry (and the wrap's material) go with GC. We never dispose the
// BufferGeometry here (producer-owned); the materials we mint hold no
// textures in M1, and three's per-shape program cache is shared, so the
// GC-mediated teardown is bounded. The texture bridge (M4) manages its
// DataTextures with its own explicit lifecycle.
//
// Known parity limitation (same as raw object3d wiring today): one
// GeometryValue coerced by TWO consumers yields one mesh that three
// reparents — last consumer wins. Fine for normal single-consumer wiring;
// Scene Merge/Combine chains are the multi-consumer answer.

import * as THREE from "three";
import type {
  GeometryValue,
  InstancesValue,
  MaterialDesc,
  Object3DValue,
} from "./three-types";
import type { ImageValue, RenderContext } from "./types";
import {
  sampleColorRampRgba01,
  type ColorRampInterp,
  type ColorRampStop,
} from "./color-ramp";

// -- MaterialDesc construction ----------------------------------------

// Stable identity ids for texture-channel ImageValues (sig needs a string;
// texture object identity is the honest input identity).
let nextTexId = 1;
const texIds = new WeakMap<object, number>();
function chanSig(c: string | number | ImageValue): string {
  if (typeof c === "string" || typeof c === "number") return String(c);
  let id = texIds.get(c);
  if (id === undefined) {
    id = nextTexId++;
    texIds.set(c, id);
  }
  return `tex${id}`;
}

// Build a MaterialDesc with its sig computed. All producers (primitives'
// default params now, the Material node in M4) go through this so sig
// stays consistent.
export function makeMaterialDesc(
  fields: Omit<MaterialDesc, "kind" | "sig">
): MaterialDesc {
  const sig = [
    chanSig(fields.baseColor),
    chanSig(fields.roughness),
    chanSig(fields.metalness),
    fields.transmission,
    fields.ior,
    chanSig(fields.alpha),
    fields.shading ?? "standard",
    fields.toonRamp ? `t:${toonRampKey(fields.toonRamp)}` : "t:0",
    fields.bump
      ? `b:${chanSig(fields.bump.map)}:${fields.bump.strength}:${fields.bump.mode}`
      : "b:0",
    fields.lineart
      ? `l:${fields.lineart.technique}:${fields.lineart.color}:${fields.lineart.thickness}:${fields.lineart.opacity}:${fields.lineart.angle}`
      : "l:0",
  ].join("|");
  return { kind: "material", ...fields, sig };
}

// -- the texture bridge (M4, 081026 spec §6.2) -------------------------
//
// Engine pool textures live on the ENGINE's GL context; three runs on its
// own isolated context (path B), and WebGL cannot share textures across
// contexts — so an image channel crosses by COPY: readImagePixels (CPU
// readback, capped at ≤1024 on the long side — material textures don't
// need canvas res) → THREE.DataTexture. Rows come back top-down (canvas
// order — see READBACK_FS in gl.ts), so flipY re-orients for three's
// v=0-at-bottom sampling.
//
// Lifecycle is PER-MATERIAL and deterministic: each material owns its
// bridged textures in userData (keyed by channel slot), re-resolving only
// when the channel's ImageValue identity moves (a static texture crosses
// once; an animated one pays per upstream recompute — the honest cost).
// The 'dispose' event tears them down with the material, so no GPU
// residue outlives its owner on three's context.

const BRIDGE_MAX_SIDE = 1024;

interface BridgeEntry {
  src: ImageValue;
  tex: THREE.DataTexture;
}

function bridgeTexture(
  mat: THREE.Material,
  slot: string,
  img: ImageValue,
  srgb: boolean,
  ctx: RenderContext
): THREE.DataTexture | null {
  const cache = ((mat.userData._bridge ??= {}) as Record<
    string,
    BridgeEntry | undefined
  >);
  const prev = cache[slot];
  if (prev && prev.src === img) return prev.tex;
  if (prev) prev.tex.dispose();
  cache[slot] = undefined;

  const scale = Math.min(
    1,
    BRIDGE_MAX_SIDE / Math.max(1, img.width, img.height)
  );
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const data = ctx.readImagePixels(img, w, h);
  if (!data) return null;

  // Copy out of the readback buffer (it may be pooled/reused).
  const tex = new THREE.DataTexture(
    new Uint8Array(data),
    w,
    h,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  tex.flipY = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cache[slot] = { src: img, tex };
  return tex;
}

function disposeBridgeTextures(mat: THREE.Material): void {
  const cache = mat.userData._bridge as
    | Record<string, BridgeEntry | undefined>
    | undefined;
  if (!cache) return;
  for (const k of Object.keys(cache)) {
    cache[k]?.tex.dispose();
    cache[k] = undefined;
  }
}

// -- MaterialDesc → three material ------------------------------------

function scalarChan(c: number | ImageValue, fallback: number): number {
  return typeof c === "number" ? c : fallback;
}

// The four material classes a desc can resolve to (Tier 2 adds toon +
// matcap). Class identity drives rebuild-vs-update in the wrap and the
// instances resolver.
export type MaterialClass = "standard" | "physical" | "toon" | "matcap";
export function materialClassFor(
  desc: MaterialDesc | null | undefined
): MaterialClass {
  if (!desc) return "standard";
  if (desc.shading === "toon") return "toon";
  if (desc.shading === "matcap") return "matcap";
  return desc.transmission > 0 ? "physical" : "standard";
}
type AnyMat =
  | THREE.MeshStandardMaterial
  | THREE.MeshPhysicalMaterial
  | THREE.MeshToonMaterial
  | THREE.MeshMatcapMaterial;

// Toon band structure: a color ramp baked into the gradient map
// (2026-08-17 — was an N-step grayscale). Multi-stop band colors at
// arbitrary positions; "constant" interp = hard bands (NearestFilter so
// edges stay razor), linear/ease = painterly gradient shading
// (LinearFilter). Baked at 256 texels via the shared CPU ramp sampler,
// stops converted sRGB → linear (three's gradientMap samples raw — no
// colorspace decode on that slot, and lighting is linear). Cached per
// material, keyed on the ramp's serialized content; disposed with the
// material.
type ToonRamp = NonNullable<MaterialDesc["toonRamp"]>;

// Default 3-band ramp. The mid stop is #bcbcbc — the sRGB value whose
// LINEAR intensity is ~0.5, matching the look of the retired grayscale
// default (which wrote 0.5 linear directly).
const DEFAULT_TOON_RAMP: ToonRamp = {
  stops: [
    { id: "toon-a", position: 0, color: "#000000" },
    { id: "toon-b", position: 0.3333, color: "#bcbcbc" },
    { id: "toon-c", position: 0.6667, color: "#ffffff" },
  ],
  interp: "constant",
};

function toonRampKey(r: ToonRamp): string {
  return `${r.interp}|${r.stops
    .map((s) => `${s.position}_${s.color}_${s.alpha ?? 1}`)
    .join(",")}`;
}

const TOON_LUT_N = 256;

function toonRampTexture(
  mat: THREE.Material,
  ramp: ToonRamp | undefined
): THREE.DataTexture {
  const r = ramp ?? DEFAULT_TOON_RAMP;
  const key = toonRampKey(r);
  const cached = mat.userData._toonGrad as
    | { key: string; tex: THREE.DataTexture }
    | undefined;
  if (cached && cached.key === key) return cached.tex;
  if (cached) cached.tex.dispose();
  const stops: ColorRampStop[] = Array.isArray(r.stops) ? r.stops : [];
  const interp: ColorRampInterp = r.interp ?? "constant";
  const data = new Uint8Array(TOON_LUT_N * 4);
  const c = new THREE.Color();
  for (let i = 0; i < TOON_LUT_N; i++) {
    const [sr, sg, sb] = sampleColorRampRgba01(
      stops,
      i / (TOON_LUT_N - 1),
      interp
    );
    // sRGB stop colors → linear working space (default color management).
    c.setRGB(sr, sg, sb, THREE.SRGBColorSpace);
    data[i * 4] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, TOON_LUT_N, 1, THREE.RGBAFormat);
  const filter =
    interp === "constant" ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = filter;
  tex.magFilter = filter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  mat.userData._toonGrad = { key, tex };
  return tex;
}

// Default matcap: a lit clay ball, generated once (module singleton —
// one tiny texture, deliberately never disposed). Used when matcap mode
// has no image wired, so the mode reads instantly.
let defaultMatcapTex: THREE.DataTexture | null = null;
function defaultMatcap(): THREE.DataTexture {
  if (defaultMatcapTex) return defaultMatcapTex;
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  const lx = 0.4;
  const ly = 0.6;
  const lz = 0.69;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x / (S - 1)) * 2 - 1;
      const ny = 1 - (y / (S - 1)) * 2;
      const r2 = nx * nx + ny * ny;
      const o = (y * S + x) * 4;
      if (r2 <= 1) {
        const nz = Math.sqrt(1 - r2);
        const d = Math.max(0, nx * lx + ny * ly + nz * lz);
        const spec = Math.pow(d, 24) * 90;
        const v = Math.min(255, Math.round(35 + 200 * Math.pow(d, 1.4) + spec));
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
      }
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  defaultMatcapTex = tex;
  return tex;
}

// Without a RenderContext (older callers, offline paths) texture channels
// fall back to neutral constants — the desc shape is honored either way.
function applyDesc(mat: AnyMat, desc: MaterialDesc, ctx?: RenderContext): void {
  const cls = materialClassFor(desc);

  // Base color: texture (sRGB) with a white multiplier, or flat hex. In
  // matcap mode a wired image IS the matcap (view-space shading lookup).
  if (typeof desc.baseColor === "string") {
    mat.color.set(desc.baseColor);
    if (cls !== "matcap") (mat as THREE.MeshStandardMaterial).map = null;
    if (cls === "matcap")
      (mat as THREE.MeshMatcapMaterial).matcap = defaultMatcap();
  } else if (cls === "matcap") {
    mat.color.set("#ffffff");
    (mat as THREE.MeshMatcapMaterial).matcap = ctx
      ? (bridgeTexture(mat, "matcap", desc.baseColor, true, ctx) ??
        defaultMatcap())
      : defaultMatcap();
  } else {
    mat.color.set("#ffffff");
    (mat as THREE.MeshStandardMaterial).map = ctx
      ? bridgeTexture(mat, "map", desc.baseColor, true, ctx)
      : null;
  }

  // PBR channels — standard/physical only (toon/matcap have no
  // roughness/metalness in their lighting models).
  if (cls === "standard" || cls === "physical") {
    const std = mat as THREE.MeshStandardMaterial;
    if (typeof desc.roughness === "number") {
      std.roughness = desc.roughness;
      std.roughnessMap = null;
    } else {
      std.roughness = 1;
      std.roughnessMap = ctx
        ? bridgeTexture(std, "roughnessMap", desc.roughness, false, ctx)
        : null;
      if (!std.roughnessMap) std.roughness = 0.5;
    }
    if (typeof desc.metalness === "number") {
      std.metalness = desc.metalness;
      std.metalnessMap = null;
    } else {
      std.metalness = 1;
      std.metalnessMap = ctx
        ? bridgeTexture(std, "metalnessMap", desc.metalness, false, ctx)
        : null;
      if (!std.metalnessMap) std.metalness = 0;
    }
  } else if (cls === "toon") {
    (mat as THREE.MeshToonMaterial).gradientMap = toonRampTexture(
      mat,
      desc.toonRamp
    );
  }

  // Bump / normal perturbation — all four classes expose bumpMap/
  // normalMap, but the shared AnyMat union doesn't, so go through a
  // structural cast. Strength maps to bumpScale (height derivative) or
  // normalScale (tangent-space intensity).
  {
    const bmp = mat as unknown as {
      bumpMap: THREE.Texture | null;
      bumpScale: number;
      normalMap: THREE.Texture | null;
      normalScale: THREE.Vector2;
    };
    if (desc.bump && ctx) {
      const isNormal = desc.bump.mode === "normal";
      const tex = bridgeTexture(
        mat,
        isNormal ? "normalMap" : "bumpMap",
        desc.bump.map,
        false,
        ctx
      );
      bmp.bumpMap = isNormal ? null : tex;
      bmp.normalMap = isNormal ? tex : null;
      if (isNormal) bmp.normalScale.set(desc.bump.strength, desc.bump.strength);
      else bmp.bumpScale = desc.bump.strength;
    } else {
      bmp.bumpMap = null;
      bmp.normalMap = null;
    }
  }

  // Alpha: three's alphaMap reads the GREEN channel (fine for both masks
  // and grayscale images). Supported by all four classes.
  let alphaScalar = 1;
  if (typeof desc.alpha === "number") {
    alphaScalar = desc.alpha;
    mat.alphaMap = null;
  } else {
    mat.alphaMap = ctx
      ? bridgeTexture(mat, "alphaMap", desc.alpha, false, ctx)
      : null;
  }
  mat.opacity = alphaScalar;
  mat.transparent =
    alphaScalar < 1 ||
    mat.alphaMap !== null ||
    (cls === "physical" && desc.transmission > 0);
  if (mat instanceof THREE.MeshPhysicalMaterial) {
    mat.transmission = desc.transmission;
    mat.ior = desc.ior;
  }
  mat.needsUpdate = true;
}

// Shared resolver — the coercion wrap here and the instances resolver
// both use it so "what a MaterialDesc means" has one home. The desc's
// shading (+ transmission) picks the class (materialClassFor). Bridged
// channel textures and the toon gradient die with the material
// (dispose event).
export function buildMaterial(
  desc: MaterialDesc | null | undefined,
  ctx?: RenderContext
): AnyMat {
  const cls = materialClassFor(desc);
  const mat: AnyMat =
    cls === "physical"
      ? new THREE.MeshPhysicalMaterial()
      : cls === "toon"
        ? new THREE.MeshToonMaterial()
        : cls === "matcap"
          ? new THREE.MeshMatcapMaterial()
          : new THREE.MeshStandardMaterial();
  mat.addEventListener("dispose", () => {
    disposeBridgeTextures(mat);
    const grad = mat.userData._toonGrad as
      | { tex: THREE.DataTexture }
      | undefined;
    grad?.tex.dispose();
    delete mat.userData._toonGrad;
  });
  if (desc) applyDesc(mat, desc, ctx);
  return mat;
}

// -- lineart (inverted hull + crease lines) ----------------------------
//
// Lineart is NOT a material property — it's extra retained objects
// managed at the object3d boundary, children of the base mesh so they
// inherit its transform (and, instanced, share its instanceMatrix so
// billboards/matrix rewrites carry the outline for free).
//
//   fast    — inverted hull only: the same geometry drawn back-face with
//             each vertex pushed along its object-space normal. One extra
//             draw call, no CPU work. Clean silhouettes; no interior
//             lines.
//   quality — hull + crease lines: EdgesGeometry at the crease-angle
//             threshold adds interior feature edges (hairline width —
//             GPU line rasterization). Costs an edge extraction per
//             geometry/angle change and a second extra draw. Meshes
//             only; instanced streams draw the hull without creases.

function lineartSigOf(desc: MaterialDesc | null | undefined): string {
  const la = desc?.lineart;
  return la
    ? `${la.technique}|${la.color}|${la.thickness}|${la.opacity}|${la.angle}`
    : "";
}

// Displacement rides `transformed` BEFORE instanceMatrix/modelView in
// three's vertex chain, so the offset is object-space — instanced copies
// outline correctly, and mesh scale scales the outline with the object.
function makeHullMaterial(
  la: NonNullable<MaterialDesc["lineart"]>
): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: la.color,
    side: THREE.BackSide,
    transparent: la.opacity < 1,
    opacity: la.opacity,
  });
  const thickness = la.thickness;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: thickness };
    shader.vertexShader =
      "uniform float uOutline;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n\ttransformed += normalize( normal ) * uOutline;"
      );
  };
  // One shared program for every hull (thickness is a uniform, per
  // material) — keep the cache key distinct from plain basic materials.
  mat.customProgramCacheKey = () => "toolbox-lineart-hull";
  return mat;
}

// -- geometry → object3d wrap -----------------------------------------

interface WrapState {
  mesh: THREE.Mesh<THREE.BufferGeometry, AnyMat>;
  matSig: string | null; // null = default material
  lineartSig: string;
  hull: THREE.Mesh | null;
  edges: THREE.LineSegments | null;
}

// Wrap-path lineart children, keyed on the desc's lineart fields. This
// path owns its children explicitly (rebuild ⇒ dispose); only the final
// WrapState teardown is GC-mediated, like the wrap's own material.
function ensureLineart(st: WrapState, desc: MaterialDesc | null): void {
  const sig = lineartSigOf(desc);
  if (st.lineartSig === sig) return;
  if (st.hull) {
    st.mesh.remove(st.hull);
    (st.hull.material as THREE.Material).dispose();
    st.hull = null;
  }
  if (st.edges) {
    st.mesh.remove(st.edges);
    st.edges.geometry.dispose();
    (st.edges.material as THREE.Material).dispose();
    st.edges = null;
  }
  const la = desc?.lineart;
  if (la) {
    const hull = new THREE.Mesh(st.mesh.geometry, makeHullMaterial(la));
    st.mesh.add(hull);
    st.hull = hull;
    if (la.technique === "quality") {
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(st.mesh.geometry, la.angle),
        new THREE.LineBasicMaterial({
          color: la.color,
          transparent: la.opacity < 1,
          opacity: la.opacity,
        })
      );
      st.mesh.add(lines);
      st.edges = lines;
    }
  }
  st.lineartSig = sig;
}

function classOfMaterial(m: THREE.Material): MaterialClass {
  // Physical extends Standard — check the subclass first.
  if (m instanceof THREE.MeshPhysicalMaterial) return "physical";
  if (m instanceof THREE.MeshToonMaterial) return "toon";
  if (m instanceof THREE.MeshMatcapMaterial) return "matcap";
  return "standard";
}

const wrapCache = new WeakMap<THREE.BufferGeometry, WrapState>();

const DEFAULT_SIG = "__default__";

function ensureMaterial(
  st: WrapState,
  desc: MaterialDesc | null,
  ctx?: RenderContext
): void {
  const sig = desc ? desc.sig : DEFAULT_SIG;
  if (st.matSig === sig) return;
  const wantClass = materialClassFor(desc);
  const isClass = classOfMaterial(st.mesh.material);
  if (st.matSig === null || wantClass !== isClass) {
    // First build, or a shading-class switch: replace wholesale.
    st.mesh.material.dispose();
    st.mesh.material = buildMaterial(desc, ctx);
  } else if (desc) {
    applyDesc(st.mesh.material, desc, ctx);
  } else {
    st.mesh.material.dispose();
    st.mesh.material = buildMaterial(null, ctx);
  }
  st.matSig = sig;
}

// -- instances → object3d resolution (M4.5, 081026 spec §4.4) ----------
//
// The instance-domain boundary: an InstancesValue resolves into ONE
// retained THREE.InstancedMesh (single draw call), keyed on the value's
// `retainKey` — a stable object the PRODUCING node retains across
// recomputes, so the mesh survives cache churn and its state dies with
// the producer (call disposeInstancesFor in the producer's dispose).
// Matrix rewrites are skipped when the exact same value object comes
// back (cache hit upstream, consumer re-eval for other reasons).

interface InstResolveState {
  imesh: THREE.InstancedMesh;
  capacity: number;
  geomRef: THREE.BufferGeometry;
  matSig: string | null;
  lastValue: InstancesValue | null;
  hadColors: boolean;
  // Lineart hull (silhouette shell) — a child InstancedMesh SHARING the
  // base mesh's instanceMatrix attribute, so matrix rewrites (including
  // render-time billboards) carry the outline with zero extra sync.
  hull: THREE.InstancedMesh | null;
  hullSig: string;
}

const instCache = new WeakMap<object, InstResolveState>();

function teardownInstState(st: InstResolveState): void {
  if (st.hull) {
    st.imesh.remove(st.hull);
    (st.hull.material as THREE.Material).dispose();
    st.hull.dispose();
    st.hull = null;
  }
  st.imesh.dispose();
  (st.imesh.material as THREE.Material).dispose();
}

export function disposeInstancesFor(retainKey: object): void {
  const st = instCache.get(retainKey);
  if (st) {
    teardownInstState(st);
    instCache.delete(retainKey);
  }
}

export function resolveInstancesAsObject(
  value: InstancesValue,
  ctx?: RenderContext
): Object3DValue {
  const n = value.count;
  const desc = value.source.materials[0] ?? null;
  const sig = desc ? desc.sig : DEFAULT_SIG;

  let st = instCache.get(value.retainKey);
  if (!st || st.geomRef !== value.source.geometry || n > st.capacity) {
    if (st) teardownInstState(st);
    const imesh = new THREE.InstancedMesh(
      value.source.geometry,
      buildMaterial(desc, ctx),
      Math.max(1, n)
    );
    imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (value.source.nodeId) imesh.userData.nodeId = value.source.nodeId;
    st = {
      imesh,
      capacity: Math.max(1, n),
      geomRef: value.source.geometry,
      matSig: sig,
      lastValue: null,
      hadColors: false,
      hull: null,
      hullSig: "",
    };
    instCache.set(value.retainKey, st);
  } else if (st.matSig !== sig) {
    (st.imesh.material as THREE.Material).dispose();
    st.imesh.material = buildMaterial(desc, ctx);
    st.matSig = sig;
  }
  const imesh = st.imesh;

  // Lineart hull (silhouette only in the instance domain — crease lines
  // would need instanced line rendering; documented mesh-only).
  const laSig = lineartSigOf(desc);
  if (st.hullSig !== laSig) {
    if (st.hull) {
      imesh.remove(st.hull);
      (st.hull.material as THREE.Material).dispose();
      st.hull.dispose();
      st.hull = null;
    }
    const la = desc?.lineart;
    if (la) {
      const hull = new THREE.InstancedMesh(
        value.source.geometry,
        makeHullMaterial(la),
        st.capacity
      );
      hull.instanceMatrix = imesh.instanceMatrix;
      // Shared-attribute bounds aren't tracked per mesh — skip culling.
      hull.frustumCulled = false;
      imesh.add(hull);
      st.hull = hull;
    }
    st.hullSig = laSig;
  }

  if (st.lastValue !== value) {
    imesh.count = n;
    // Source pre-transform — the instance's own carried TRS.
    const t = value.source.transform;
    const mSrc = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotationEuler)),
      new THREE.Vector3(...t.scale)
    );
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(
        value.positions[i * 3],
        value.positions[i * 3 + 1],
        value.positions[i * 3 + 2]
      );
      q.set(
        value.quaternions[i * 4],
        value.quaternions[i * 4 + 1],
        value.quaternions[i * 4 + 2],
        value.quaternions[i * 4 + 3]
      );
      s.set(
        value.scales[i * 3],
        value.scales[i * 3 + 1],
        value.scales[i * 3 + 2]
      );
      m.compose(p, q, s).multiply(mSrc);
      imesh.setMatrixAt(i, m);
    }
    imesh.instanceMatrix.needsUpdate = true;

    // Billboard marker → stashed for the render-time apply
    // (applyInstanceBillboards below; Scene Render + the orbit viewport
    // call it with their cameras each render). mSrc is precomputed here
    // so the per-frame apply is pure compose work.
    if (value.billboard) {
      imesh.userData._billboard = { value, mSrc: mSrc.clone() };
    } else {
      delete imesh.userData._billboard;
    }

    // Per-instance tint → instanceColor (linear RGB). Program defines key
    // on instanceColor PRESENCE, so flipping it needs a material
    // recompile (the classic three gotcha) — hence hadColors tracking.
    const hasColors = !!value.colors;
    if (value.colors) {
      if (!imesh.instanceColor || imesh.instanceColor.count < n) {
        imesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(st.capacity * 3),
          3
        );
      }
      (imesh.instanceColor.array as Float32Array).set(
        value.colors.subarray(0, n * 3)
      );
      imesh.instanceColor.needsUpdate = true;
    } else if (imesh.instanceColor) {
      // No colors on this stream — neutral white so a stale tint from a
      // disconnected Instance Color node doesn't linger.
      (imesh.instanceColor.array as Float32Array).fill(1);
      imesh.instanceColor.needsUpdate = true;
    }
    if (hasColors !== st.hadColors) {
      (imesh.material as THREE.Material).needsUpdate = true;
      st.hadColors = hasColors;
    }

    imesh.computeBoundingSphere();
    st.lastValue = value;
  }
  if (st.hull) st.hull.count = imesh.count;

  return { kind: "object3d", object: imesh, variant: "instanced" };
}

// -- render-time billboarding (M12) ------------------------------------
//
// Walk a scene for InstancedMeshes carrying the resolver's billboard
// stash and rewrite their instance matrices to face `renderCamPos` (or
// the marker's own pinned camera when Align to Camera has one wired).
// Called by Scene Render before each render AND by the orbit viewport
// each frame — same math, different cameras, which is exactly the point.

const bbUp = new THREE.Vector3(0, 1, 0);
const bbP = new THREE.Vector3();
const bbTarget = new THREE.Vector3();
const bbM = new THREE.Matrix4();
const bbQ = new THREE.Quaternion();
const bbQNow = new THREE.Quaternion();
const bbQDelta = new THREE.Quaternion();
const bbS = new THREE.Vector3();
// +90° about X maps local +Y onto +Z (lookAt's facing axis).
const bbYtoZ = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2
);

export function applyInstanceBillboards(
  root: THREE.Object3D,
  renderCamPos: THREE.Vector3
): void {
  root.traverse((o) => {
    const bb = o.userData._billboard as
      | { value: InstancesValue; mSrc: THREE.Matrix4 }
      | undefined;
    if (!bb) return;
    const imesh = o as THREE.InstancedMesh;
    const { value, mSrc } = bb;
    const marker = value.billboard;
    if (!marker) return;
    const camX = marker.camera ? marker.camera[0] : renderCamPos.x;
    const camY = marker.camera ? marker.camera[1] : renderCamPos.y;
    const camZ = marker.camera ? marker.camera[2] : renderCamPos.z;
    // Downstream rotation deltas (Instance Transform AFTER Align to
    // Camera): the marker holds the quaternions as of the Align node; a
    // different (same-length) array on the final value means a modifier
    // rotated copies afterwards, and that delta composes on top of the
    // billboard orientation in the copy's local frame.
    const base = marker.baseQuats;
    const deltas =
      base && base !== value.quaternions && base.length === value.quaternions.length
        ? base
        : null;
    const n = Math.min(value.count, imesh.count);
    for (let i = 0; i < n; i++) {
      bbP.set(
        value.positions[i * 3],
        value.positions[i * 3 + 1],
        value.positions[i * 3 + 2]
      );
      bbTarget.set(camX, marker.mode === "y" ? bbP.y : camY, camZ);
      if (bbTarget.distanceToSquared(bbP) < 1e-12) {
        // Camera on top of the copy — keep the base orientation.
        bbQ.set(
          value.quaternions[i * 4],
          value.quaternions[i * 4 + 1],
          value.quaternions[i * 4 + 2],
          value.quaternions[i * 4 + 3]
        );
      } else {
        // Object3D.lookAt's non-camera construction: +Z faces the target.
        bbM.lookAt(bbTarget, bbP, bbUp);
        bbQ.setFromRotationMatrix(bbM);
        if (marker.face === "y") bbQ.multiply(bbYtoZ);
        if (deltas) {
          // bbQ ⊗ (base⁻¹ ⊗ now) — apply the accumulated post-Align local
          // rotation in the billboarded frame.
          bbQNow.set(
            value.quaternions[i * 4],
            value.quaternions[i * 4 + 1],
            value.quaternions[i * 4 + 2],
            value.quaternions[i * 4 + 3]
          );
          bbQDelta
            .set(deltas[i * 4], deltas[i * 4 + 1], deltas[i * 4 + 2], deltas[i * 4 + 3])
            .conjugate()
            .multiply(bbQNow);
          bbQ.multiply(bbQDelta);
        }
      }
      bbS.set(
        value.scales[i * 3],
        value.scales[i * 3 + 1],
        value.scales[i * 3 + 2]
      );
      bbM.compose(bbP, bbQ, bbS).multiply(mSrc);
      imesh.setMatrixAt(i, bbM);
    }
    imesh.instanceMatrix.needsUpdate = true;
  });
}

export function wrapGeometryAsObject(
  value: GeometryValue,
  ctx?: RenderContext
): Object3DValue {
  let st = wrapCache.get(value.geometry);
  if (!st) {
    st = {
      mesh: new THREE.Mesh(value.geometry, buildMaterial(null, ctx)),
      matSig: DEFAULT_SIG,
      lineartSig: "",
      hull: null,
      edges: null,
    };
    wrapCache.set(value.geometry, st);
  }
  const m = st.mesh;
  const t = value.transform;
  m.position.set(t.position[0], t.position[1], t.position[2]);
  m.rotation.set(t.rotationEuler[0], t.rotationEuler[1], t.rotationEuler[2]);
  m.scale.set(t.scale[0], t.scale[1], t.scale[2]);
  ensureMaterial(st, value.materials[0] ?? null, ctx);
  ensureLineart(st, value.materials[0] ?? null);
  if (value.nodeId) m.userData.nodeId = value.nodeId;
  return { kind: "object3d", object: m, variant: "mesh" };
}
