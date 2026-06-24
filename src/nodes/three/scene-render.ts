import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import type { CameraValue, Object3DValue } from "@/engine/three-types";
import {
  blitCanvasToImage,
  disposeUploadTexture,
  ensureUploadTexture,
} from "@/engine/three-bridge";
import {
  publishSceneRender,
  unpublishSceneRender,
} from "@/engine/three-viewport-registry";

// =====================================================================
// Scene Render — the 3D→2D boundary (M1)
// =====================================================================
//
// The convergence point of the 3D dataflow: whatever object3d values reach
// here (plus the camera) ARE the scene (spec §2). Owns a retained three.js
// WebGLRenderer + Scene on its own isolated context (path B — no shared GL
// state with the engine), reconciles the scene contents each eval, renders,
// and bridges the canvas into the engine's RGBA16F pool as an `image`.
//
// M1 takes 4 fixed object inputs; Scene Merge (M1b) will collapse an
// arbitrary number of objects into one for bigger scenes. This node also
// previews the eventual Scene Output boundary of the layer-style container.
//
// Reconciliation here is clear-and-re-add (cheap for small scenes): the
// object3d values carry retained three.Object3D refs owned by the producing
// nodes, so we only manage scene membership, never geometry. Diff-based
// reconciliation is the optimization for large scenes (spec §3.3).

const OBJECT_SLOTS = 4;

const DEFAULT_CAMERA: CameraValue = {
  kind: "camera",
  projection: "perspective",
  fov: 45,
  near: 0.1,
  far: 100,
  position: [2.4, 1.8, 2.4],
  target: [0, 0, 0],
};

interface SceneRuntime {
  renderer: THREE.WebGLRenderer | null;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  // Added only when the incoming objects include no light, so a lone cube
  // isn't pure black under MeshStandardMaterial.
  fallbackLight: THREE.AmbientLight;
  // Bokeh post-process — lazily built the first time a camera enables DOF.
  composer: EffectComposer | null;
  renderPass: RenderPass | null;
  bokehPass: BokehPass | null;
  lastW: number;
  lastH: number;
}

function ensureRuntime(ctx: RenderContext, nodeId: string): SceneRuntime {
  const key = `scene-render:${nodeId}`;
  const existing = ctx.state[key] as SceneRuntime | undefined;
  if (existing) return existing;

  const canvas = document.createElement("canvas");
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      premultipliedAlpha: false, // straight alpha, matches the engine
      antialias: true,
      preserveDrawingBuffer: true, // readable by texImage2D post-render
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0); // transparent → composites in 2D
  } catch {
    renderer = null;
  }

  const runtime: SceneRuntime = {
    renderer,
    canvas,
    scene: new THREE.Scene(),
    persp: new THREE.PerspectiveCamera(45, 1, 0.1, 100),
    ortho: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
    fallbackLight: new THREE.AmbientLight(0xffffff, 0.4),
    composer: null,
    renderPass: null,
    bokehPass: null,
    lastW: 0,
    lastH: 0,
  };
  ctx.state[key] = runtime;
  return runtime;
}

// Lazily build the DOF post-process pipeline (RenderPass → BokehPass →
// OutputPass). OutputPass matches the direct-render color/tone-map output.
function ensureComposer(
  rt: SceneRuntime
): { composer: EffectComposer; renderPass: RenderPass; bokeh: BokehPass } | null {
  if (!rt.renderer) return null;
  if (rt.composer && rt.renderPass && rt.bokehPass) {
    return { composer: rt.composer, renderPass: rt.renderPass, bokeh: rt.bokehPass };
  }
  const composer = new EffectComposer(rt.renderer);
  const renderPass = new RenderPass(rt.scene, rt.persp);
  const bokeh = new BokehPass(rt.scene, rt.persp, {
    focus: 6,
    aperture: 0.025,
    maxblur: 0.01,
  });
  composer.addPass(renderPass);
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());
  rt.composer = composer;
  rt.renderPass = renderPass;
  rt.bokehPass = bokeh;
  return { composer, renderPass, bokeh };
}

function setupCamera(rt: SceneRuntime, desc: CameraValue, aspect: number): THREE.Camera {
  const [px, py, pz] = desc.position;
  const [tx, ty, tz] = desc.target;
  if (desc.projection === "orthographic") {
    const halfH = (desc.orthoHeight ?? 3) / 2;
    const halfW = halfH * aspect;
    rt.ortho.left = -halfW;
    rt.ortho.right = halfW;
    rt.ortho.top = halfH;
    rt.ortho.bottom = -halfH;
    rt.ortho.near = desc.near;
    rt.ortho.far = desc.far;
    rt.ortho.position.set(px, py, pz);
    rt.ortho.lookAt(tx, ty, tz);
    rt.ortho.updateProjectionMatrix();
    return rt.ortho;
  }
  rt.persp.fov = desc.fov;
  rt.persp.aspect = aspect;
  rt.persp.near = desc.near;
  rt.persp.far = desc.far;
  rt.persp.position.set(px, py, pz);
  rt.persp.lookAt(tx, ty, tz);
  rt.persp.updateProjectionMatrix();
  return rt.persp;
}

export const sceneRenderNode: NodeDefinition = {
  type: "scene-render",
  name: "3D Scene",
  category: "3d",
  description:
    "Renders the wired 3D objects from the given camera into an image. The convergence point of the 3D context — whatever reaches here is the scene.",
  backend: "webgl2",
  // Caches on its inputs: re-renders only when an upstream object/camera
  // (or its params) changes. Orbit/animation in M1b will revisit this.
  stable: true,
  // Pure 3D inputs + image out; no universal mask socket while bootstrapping.
  noMaskInput: true,
  inputs: [
    { name: "object:1", label: "object 1", type: "object3d", required: false },
    { name: "object:2", label: "object 2", type: "object3d", required: false },
    { name: "object:3", label: "object 3", type: "object3d", required: false },
    { name: "object:4", label: "object 4", type: "object3d", required: false },
    { name: "camera", label: "camera", type: "camera", required: false },
  ],
  params: [],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, ctx, nodeId }) {
    const rt = ensureRuntime(ctx, nodeId);

    if (!rt.renderer) {
      const output = ctx.allocImage();
      ctx.clearTarget(output, [0.4, 0, 0.4, 1]); // debug magenta = no WebGL
      return { primary: output };
    }

    // Collect the converged scene objects.
    const objs: Object3DValue[] = [];
    for (let i = 1; i <= OBJECT_SLOTS; i++) {
      const v = inputs[`object:${i}`];
      if (v && v.kind === "object3d") objs.push(v as Object3DValue);
    }
    const cameraIn = inputs["camera"];
    const camera =
      cameraIn && cameraIn.kind === "camera"
        ? (cameraIn as CameraValue)
        : DEFAULT_CAMERA;

    // Reconcile scene membership: detach everything, re-add the current set.
    // (Objects are retained by their producing nodes — clear() only detaches.)
    rt.scene.clear();
    let hasLight = false;
    for (const o of objs) {
      rt.scene.add(o.object);
      if (o.variant === "light") hasLight = true;
    }
    if (!hasLight) rt.scene.add(rt.fallbackLight);

    // Publish the live scene for the orbit viewport (M1b) — it renders this
    // same scene graph with its own renderer + editor camera.
    publishSceneRender(nodeId, { scene: rt.scene, cameraDesc: camera });

    const w = ctx.width;
    const h = ctx.height;
    if (w !== rt.lastW || h !== rt.lastH) {
      rt.renderer.setSize(w, h, false);
      rt.composer?.setSize(w, h);
      rt.lastW = w;
      rt.lastH = h;
    }

    const cam = setupCamera(rt, camera, w / h);

    if (camera.dof) {
      // Depth of field: post-process the scene through the bokeh composer.
      const c = ensureComposer(rt);
      if (c) {
        c.composer.setSize(w, h); // no-op when unchanged; safe after lazy init
        c.renderPass.camera = cam;
        c.bokeh.camera = cam;
        // BokehPass.uniforms is typed as `{}` in the addon types; the
        // runtime object has focus/aperture/maxblur uniforms.
        const u = c.bokeh.uniforms as Record<string, { value: number }>;
        u.focus.value = camera.dof.focus;
        u.aperture.value = camera.dof.aperture;
        u.maxblur.value = camera.dof.maxblur;
        c.composer.render();
      } else {
        rt.renderer.render(rt.scene, cam);
      }
    } else {
      rt.renderer.render(rt.scene, cam);
    }

    // Bridge three's canvas into the pool (upload + Y-flip blit). This
    // leases and returns the pool image — our only output texture.
    const uploadTex = ensureUploadTexture(ctx, `scene-render:${nodeId}`);
    const img = blitCanvasToImage(ctx, rt.canvas, uploadTex);
    return { primary: img };
  },

  dispose(ctx, nodeId) {
    const key = `scene-render:${nodeId}`;
    const rt = ctx.state[key] as SceneRuntime | undefined;
    if (rt) {
      rt.scene.clear();
      rt.composer?.dispose();
      rt.renderer?.dispose();
    }
    unpublishSceneRender(nodeId);
    disposeUploadTexture(ctx, `scene-render:${nodeId}`);
    delete ctx.state[key];
  },
};
