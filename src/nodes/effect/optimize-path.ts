import type {
  ImageValue,
  NodeDefinition,
  OutputSocketDef,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import {
  ensureVectorKernel,
  kernelReady,
  optimizeSpline,
} from "@/engine/vector-kernel";
import { buildPath2D } from "@/engine/spline-raster";
import { aspectCorrectY } from "@/engine/aspect";

// Optimize Path — refit messy spline data to the fewest clean cubic Bézier
// segments within a pixel tolerance (specdocs/archive/attractor-vector-kernel-spec.md
// §1.2). Backed by kurbo's simplify/fit machinery compiled to WASM; corner
// joins sharper than `corner_angle` split the fitting runs, so hard corners
// survive exactly while smooth-but-noisy spans collapse to minimal curves.
//
// The kernel loads lazily (77 KB fetch from public/wasm/v1). Until it
// arrives, compute passes the input through unchanged and re-evaluates on
// the pipeline-bump when init resolves — fingerprintExtras carries the
// ready flag so the cached passthrough busts at that moment.
//
// Debug skeleton: `show_debug` mints an `image` aux rendering the source
// path (faint grey) under the optimized result with its anchors + handles
// (pen-tool style) and an anchor-count readout. Because the viewport's
// preview fallback prefers a selected spline node's `image` aux, toggling
// it on and selecting the node shows the skeleton with zero wiring — same
// mechanism as the spline primitives' bundled rasterizer.

const EMPTY: SplineValue = { kind: "spline", subpaths: [] };

// Y-flip blit: the 2D canvas is row-0-top; flip to the pipeline's Y-up.
// (Same pattern as Bezier Handles, which owns the full styled version of
// this visualization — this is the fixed-style debug flavor.)
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface DebugState {
  canvas: HTMLCanvasElement;
  tex: WebGLTexture | null;
}

function stateKey(nodeId: string): string {
  return `optimize-path:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): DebugState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as DebugState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("optimize-path: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: DebugState = { canvas: document.createElement("canvas"), tex };
  ctx.state[key] = s;
  return s;
}

const countAnchors = (s: SplineValue) =>
  s.subpaths.reduce((n, sub) => n + sub.anchors.length, 0);

function renderDebug(
  ctx: RenderContext,
  nodeId: string,
  src: SplineValue,
  out: SplineValue
): ImageValue {
  const W = ctx.width;
  const H = ctx.height;
  const state = ensureState(ctx, nodeId);
  const canvas = state.canvas;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const c2d = canvas.getContext("2d");
  if (c2d) {
    c2d.clearRect(0, 0, W, H);
    c2d.lineJoin = "round";
    c2d.lineCap = "round";
    c2d.setLineDash([]);

    // Same mapping as Bezier Handles / buildPath2D so overlay dots sit
    // exactly on the aspect-corrected path.
    const aspect = W / H;
    const toPx = (p: [number, number]): [number, number] => [
      p[0] * W,
      aspectCorrectY(p[1], aspect) * H,
    ];

    // (1) source path, faint grey — the "before".
    const srcPath = buildPath2D(src.subpaths, W, H, false);
    if (srcPath) {
      c2d.strokeStyle = "rgba(140,140,140,0.55)";
      c2d.lineWidth = 1;
      c2d.stroke(srcPath);
    }

    // (2) optimized path, bright — the "after".
    const outPath = buildPath2D(out.subpaths, W, H, false);
    if (outPath) {
      c2d.strokeStyle = "rgba(232,232,232,0.95)";
      c2d.lineWidth = 1.5;
      c2d.stroke(outPath);
    }

    // (3) handle lines + handle dots + anchor dots, pen-tool style.
    const handleLines = new Path2D();
    const handleEnds: [number, number][] = [];
    const anchorPts: [number, number][] = [];
    for (const sub of out.subpaths) {
      for (const a of sub.anchors) {
        const ap = toPx(a.pos);
        anchorPts.push(ap);
        for (const hnd of [a.inHandle, a.outHandle]) {
          if (!hnd || (hnd[0] === 0 && hnd[1] === 0)) continue;
          const e = toPx([a.pos[0] + hnd[0], a.pos[1] + hnd[1]]);
          handleLines.moveTo(ap[0], ap[1]);
          handleLines.lineTo(e[0], e[1]);
          handleEnds.push(e);
        }
      }
    }
    c2d.strokeStyle = "#4a90ff";
    c2d.lineWidth = 1;
    c2d.stroke(handleLines);
    c2d.fillStyle = "#4a90ff";
    for (const [x, y] of handleEnds) {
      c2d.beginPath();
      c2d.arc(x, y, 3, 0, Math.PI * 2);
      c2d.fill();
    }
    for (const [x, y] of anchorPts) {
      c2d.beginPath();
      c2d.arc(x, y, 4, 0, Math.PI * 2);
      c2d.fillStyle = "#ffffff";
      c2d.fill();
      c2d.strokeStyle = "#4a90ff";
      c2d.lineWidth = 1.5;
      c2d.stroke();
    }

    // (4) anchor-count readout, top-left.
    const fs = Math.max(11, Math.round(H * 0.022));
    c2d.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const label = `${countAnchors(src)} → ${countAnchors(out)} anchors`;
    c2d.fillStyle = "rgba(0,0,0,0.55)";
    const pad = Math.round(fs * 0.45);
    const tw = c2d.measureText(label).width;
    c2d.fillRect(pad, pad, tw + pad * 2, fs + pad * 1.4);
    c2d.fillStyle = "#d8d8d8";
    c2d.fillText(label, pad * 2, pad + fs);

    const gl = ctx.gl;
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  const image = ctx.allocImage();
  const prog = ctx.getShader("optimize-path/blit", BLIT_FS);
  ctx.drawFullscreen(prog, image, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, state.tex);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
  });
  return image;
}

export const optimizePathNode: NodeDefinition = {
  type: "optimize-path",
  name: "Optimize Path",
  category: "spline",
  subcategory: "modifier",
  description:
    "Refit messy spline data — traces, scribbles, simulation output — to the fewest clean Bézier segments within a pixel tolerance. Corners sharper than the corner angle are preserved exactly; smooth spans are refit with far fewer anchors. Smoothing denoises jittery input before fitting (handle-less anchors only — authored geometry never moves); Cull specks drops subpaths shorter than the given length, the dust tracing leaves behind. Optimal mode searches for the true minimum segment count (slower — use for finals, not per-frame animation). Debug skeleton overlays the source path with the optimized result's anchors and handles (select the node to see it in the viewport) and mints it as an image output.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "tolerance",
      label: "Tolerance (px)",
      type: "scalar",
      min: 0.01,
      max: 50,
      softMax: 5,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["adaptive", "optimal"],
      default: "adaptive",
      control: "segmented",
    },
    {
      name: "corner_angle",
      label: "Corner angle (°)",
      type: "scalar",
      min: 1,
      max: 89,
      step: 1,
      default: 30,
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "cull_length",
      label: "Cull specks (px)",
      type: "scalar",
      min: 0,
      max: 1000,
      softMax: 50,
      step: 0.5,
      default: 0,
    },
    {
      name: "show_debug",
      label: "Debug skeleton",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    return params.show_debug === true ? [{ name: "image", type: "image" }] : [];
  },

  // Bust the cached passthrough the moment the WASM kernel finishes loading.
  fingerprintExtras: () => (kernelReady() ? "vk1" : "vk0"),

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: EMPTY };
    }
    let out: SplineValue;
    if (!kernelReady()) {
      ensureVectorKernel()
        .then(() => window.dispatchEvent(new Event("pipeline-bump")))
        .catch((err) =>
          console.warn("[optimize-path] vector kernel failed to load:", err)
        );
      out = src;
    } else {
      out = optimizeSpline(
        src,
        {
          tolerancePx: (params.tolerance as number) ?? 0.5,
          mode: params.mode === "optimal" ? "optimal" : "adaptive",
          cornerAngleDeg: (params.corner_angle as number) ?? 30,
          smoothing: (params.smoothing as number) ?? 0,
          cullMinLengthPx: (params.cull_length as number) ?? 0,
        },
        ctx.width,
        ctx.height
      );
    }
    if (params.show_debug !== true) {
      return { primary: out };
    }
    return { primary: out, aux: { image: renderDebug(ctx, nodeId, src, out) } };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as DebugState | undefined;
    if (state?.tex) ctx.gl.deleteTexture(state.tex);
    delete ctx.state[key];
  },
};
