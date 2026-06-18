import * as THREE from "three";
import { OPACITY_PARAM } from "@/engine/conventions";
import type { NodeDefinition, RenderContext } from "@/engine/types";

// =====================================================================
// M0 — 3D render-bridge spike (path B: isolated three.js context)
// =====================================================================
//
// Proves the 2D↔3D bridge end-to-end before any of the 3D-context
// architecture lands. A self-contained node that:
//   1. owns its OWN three.js WebGLRenderer on a separate canvas/context
//      (zero shared GL state with the engine — no state-collision risk),
//   2. renders a lit, spinning cube each frame,
//   3. uploads three's canvas into an RGBA8 texture via texImage2D
//      (a GPU-side copy, no CPU Float32 roundtrip),
//   4. blits that into the engine's RGBA16F pool with a Y-flip, exactly
//      like Video Source does for a <video> element.
//
// Output is a plain `image`, so it drops into the existing 2D graph with
// no new socket types. See specdocs/061626_3d-nodes-and-context.md §4 / §11.
//
// Conventions pinned here (spec §5):
//   - three renders straight-alpha (premultipliedAlpha:false) on a
//     transparent clear, matching the engine's straight-alpha compositing.
//   - three's default sRGB outputColorSpace is kept, so the 8-bit canvas
//     holds sRGB-encoded color — the same way imported images sit in the
//     pool. The 3D render therefore looks consistent with 2D sources.
//   - Y-flip happens at the sample boundary (canvas is DOM y-down; the
//     fullscreen pass samples 1.0 - v_uv.y), same as Video Source.

// Fullscreen blit: sample the uploaded three canvas, flipped vertically,
// straight into the 16F target. No fit math — three already renders at the
// engine canvas resolution.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface CubeState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  canvas: HTMLCanvasElement;
  // Engine-side RGBA8 texture that three's canvas is uploaded into each
  // frame (then blitted to the 16F pool output). Mirrors Video Source.
  tex: WebGLTexture;
  lastW: number;
  lastH: number;
  // Null when renderer construction failed (e.g. no WebGL2) — compute then
  // degrades to a debug clear instead of throwing every frame.
  ok: boolean;
}

const STATE_PREFIX = "cube-3d-test";

function ensureState(ctx: RenderContext, nodeId: string): CubeState | null {
  const key = `${STATE_PREFIX}:${nodeId}`;
  const existing = ctx.state[key] as CubeState | undefined;
  if (existing) return existing;

  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("cube-3d-test: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  let renderer: THREE.WebGLRenderer | null = null;
  const canvas = document.createElement("canvas");
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      premultipliedAlpha: false, // straight alpha, matches the engine
      antialias: true,
      // Keep the drawing buffer readable by texImage2D after render() in
      // the same synchronous compute() — avoids a black-frame debug loop.
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0); // transparent so the cube composites
  } catch {
    renderer = null;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(2.4, 1.8, 2.4);
  camera.lookAt(0, 0, 0);

  // Low metalness + no env map ⇒ the cube reads as a clearly-lit solid
  // (a metallic material with no environment would render black).
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xff6633, metalness: 0.1, roughness: 0.45 })
  );
  scene.add(mesh);

  // Physical lights (three ≥ r165 dropped legacy lighting). Generous
  // intensities since there's no IBL to fill shadows.
  const key1 = new THREE.DirectionalLight(0xffffff, 3.0);
  key1.position.set(3, 5, 2);
  scene.add(key1);
  const fill = new THREE.DirectionalLight(0xbbccff, 1.0);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const s: CubeState = {
    renderer: renderer as THREE.WebGLRenderer,
    scene,
    camera,
    mesh,
    canvas,
    tex,
    lastW: 0,
    lastH: 0,
    ok: !!renderer,
  };
  ctx.state[key] = s;
  return s;
}

export const cube3DTestNode: NodeDefinition = {
  type: "cube-3d-test",
  name: "3D Cube (Test)",
  category: "image",
  subcategory: "generator",
  description:
    "M0 render-bridge spike: a lit, spinning cube rendered by three.js on its own WebGL context and composited into the 2D graph. Proof-of-concept for the 3D context.",
  backend: "webgl2",
  // Spins with scene time — recompute every eval.
  stable: false,
  inputs: [],
  params: [
    OPACITY_PARAM,
    { name: "color", label: "Color", type: "color", default: "#ff6633" },
    {
      name: "speed",
      label: "Spin speed",
      type: "scalar",
      min: -4,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 0.6,
    },
    {
      name: "metalness",
      label: "Metalness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
    },
    {
      name: "roughness",
      label: "Roughness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.45,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const state = ensureState(ctx, nodeId);

    // Renderer failed to construct (no WebGL2 / context lost): degrade to a
    // visible debug clear instead of throwing every frame.
    if (!state || !state.ok) {
      ctx.clearTarget(output, [0.4, 0, 0.4, 1]);
      return { primary: output };
    }

    const w = output.width;
    const h = output.height;

    // Resync three's render target + camera aspect to the engine canvas.
    if (w !== state.lastW || h !== state.lastH) {
      state.renderer.setSize(w, h, false);
      state.camera.aspect = w / h;
      state.camera.updateProjectionMatrix();
      state.lastW = w;
      state.lastH = h;
    }

    // Material params (cheap to set every frame; three no-ops if unchanged).
    const colorHex = (params.color as string) ?? "#ff6633";
    state.mesh.material.color.set(colorHex);
    state.mesh.material.metalness = (params.metalness as number) ?? 0.1;
    state.mesh.material.roughness = (params.roughness as number) ?? 0.45;

    // Spin from scene time (deterministic per tick ⇒ offline export safe).
    const speed = (params.speed as number) ?? 0.6;
    const t = ctx.time * speed;
    state.mesh.rotation.set(t * 0.9, t, 0);

    state.renderer.render(state.scene, state.camera);

    // Upload three's canvas into our RGBA8 texture (GPU copy), then blit
    // into the 16F pool output with the Y-flip — the Video Source path.
    const gl = ctx.gl;
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        state.canvas
      );
    } catch {
      // Canvas not yet uploadable — leave whatever was last there.
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    const prog = ctx.getShader("cube-3d-test/blit", BLIT_FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.tex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = `${STATE_PREFIX}:${nodeId}`;
    const state = ctx.state[key] as CubeState | undefined;
    if (state) {
      if (state.tex) ctx.gl.deleteTexture(state.tex);
      state.mesh.geometry.dispose();
      state.mesh.material.dispose();
      // Frees three's WebGL context (browsers cap simultaneous contexts).
      state.renderer?.dispose();
    }
    delete ctx.state[key];
  },
};
