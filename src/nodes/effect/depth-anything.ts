import type { NodeDefinition, RenderContext } from "@/engine/types";
import { pushMediaSettle } from "@/engine/offline-settle";
import {
  getDecodedDepth,
  hasDecodedDepth,
  peekDepthSession,
  prefetchDepthDecodes,
  recordScopedFrame,
  requestDepthDecode,
} from "@/lib/ai/depth-session";

// Depth Anything node. Monocular depth estimation via Transformers.js
// (Depth Anything V2). As with Segment Anything, ML inference NEVER runs
// inside compute() — it's triggered by the panel's Preview button (live
// single-frame depth) and the Bake button (per-frame depth over an in/out
// range), both of which write into the session store (lib/ai/depth-session).
// compute() only resolves "which depth bitmap applies at ctx.frame", uploads
// it to a texture, and runs the depth or normal shader — so a static chain
// caches as a constant and a baked range costs one small texture upload per
// frame.
//
// The baked cache is session-only: model / mode / range params serialize with
// the project, the depth maps themselves don't — reopening means one re-bake.

interface DepthTexCache {
  tex: WebGLTexture | null;
  ref: ImageBitmap | null;
  w: number;
  h: number;
}

function ensureCache(ctx: RenderContext, nodeId: string): DepthTexCache {
  const key = `depth-anything:${nodeId}`;
  let s = ctx.state[key] as DepthTexCache | undefined;
  if (!s) {
    s = { tex: null, ref: null, w: 0, h: 0 };
    ctx.state[key] = s;
  }
  return s;
}

function uploadBitmap(
  gl: WebGL2RenderingContext,
  bitmap: ImageBitmap,
  reuse: WebGLTexture | null
): WebGLTexture | null {
  const tex = reuse ?? gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  // Depth values live in the pixel bytes — no color management on upload.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  // LINEAR is fine for depth (smooth) and for the normal-map gradient.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function disposeCache(ctx: RenderContext, nodeId: string) {
  const key = `depth-anything:${nodeId}`;
  const s = ctx.state[key] as DepthTexCache | undefined;
  if (s) {
    if (s.tex) ctx.gl.deleteTexture(s.tex);
    delete ctx.state[key];
  }
}

// Depth — sampled grayscale (uploaded bitmap is Y-down, hence the flipped
// read) with invert + near/far black/white-point remap. Output is grayscale
// RGB (R=G=B=depth) so it reads as both an image and a single-channel mask.
const DEPTH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_depth;
uniform float u_invert;   // 0 / 1
uniform float u_near;     // black point
uniform float u_far;      // white point
out vec4 outColor;

void main() {
  float d = texture(u_depth, vec2(v_uv.x, 1.0 - v_uv.y)).r;
  if (u_invert > 0.5) d = 1.0 - d;
  d = clamp((d - u_near) / max(1e-4, u_far - u_near), 0.0, 1.0);
  outColor = vec4(d, d, d, 1.0);
}`;

// Normal — tangent-space normal from the depth gradient (Sobel-ish central
// difference scaled by strength). Near/far don't apply here (clamping would
// flatten gradients at the extremes); invert flips the surface orientation.
const NORMAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_depth;
uniform vec2  u_invSize;   // 1.0 / depth size
uniform float u_invert;
uniform float u_strength;
out vec4 outColor;

float depthAt(vec2 uv) {
  float d = texture(u_depth, vec2(uv.x, 1.0 - uv.y)).r;
  return u_invert > 0.5 ? 1.0 - d : d;
}

void main() {
  vec2 t = u_invSize;
  float l = depthAt(v_uv - vec2(t.x, 0.0));
  float r = depthAt(v_uv + vec2(t.x, 0.0));
  float d = depthAt(v_uv - vec2(0.0, t.y));
  float u = depthAt(v_uv + vec2(0.0, t.y));
  // x to the right, y up; scale gradient by strength.
  vec3 n = normalize(vec3((l - r) * u_strength, (d - u) * u_strength, 1.0));
  outColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

const PASSTHROUGH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

export const depthAnythingNode: NodeDefinition = {
  type: "depth-anything",
  name: "Depth Anything",
  category: "image",
  subcategory: "modifier",
  description:
    "Estimate a depth map from an image locally via Transformers.js (Depth Anything V2). The header toggle switches the output between the depth map (grayscale, near=white) and a normal map derived from the depth gradient. Invert flips near/far; Near/Far set the depth black/white points. For animated inputs, Preview runs depth on the current frame and Bake runs the model over an in/out frame range and caches a depth map per frame (held in memory for this session — reopen → re-bake). Note: the model normalizes each frame independently, so brightness can drift over a clip.",
  backend: "webgl2",
  headerControl: { paramName: "outputMode" },
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "outputMode",
      label: "Output",
      type: "enum",
      options: ["depth", "normal"],
      default: "depth",
    },
    {
      name: "model",
      label: "Model",
      type: "enum",
      options: ["v2-small", "v2-base", "v2-large"],
      default: "v2-small",
    },
    {
      // Inference precision (Transformers.js dtype). Higher = better quality;
      // the runtime's default is a blocky quantized model. Inference-time only
      // (panel reads it) — doesn't affect the render path.
      name: "precision",
      label: "Quality",
      type: "enum",
      options: ["fp32", "fp16", "q8"],
      default: "fp32",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
    {
      name: "near",
      label: "Near",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "far",
      label: "Far",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "normalStrength",
      label: "Normal Strength",
      type: "scalar",
      min: 0,
      max: 8,
      softMax: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.outputMode === "normal",
    },
    // Bake range (frames). Edited via the custom panel.
    {
      name: "inFrame",
      label: "In Frame",
      type: "scalar",
      min: 0,
      step: 1,
      default: 0,
      hidden: true,
    },
    {
      name: "outFrame",
      label: "Out Frame",
      type: "scalar",
      min: 0,
      step: 1,
      default: 120,
      hidden: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "depth",
      type: "mask",
      description:
        "Depth as a single-channel mask (always the depth map, even when the primary shows normals).",
    },
  ],

  // Cache key: the session store's version (bumped on live update, bake
  // commit, free) + which depth applies at the current frame. A static chain
  // with a live preview fingerprints as a constant — playback never re-runs
  // it. A baked range re-fingerprints only when the frame's depth (or its
  // decoded-readiness) changes. Param changes (mode/invert/near/far/strength)
  // already fold into the fingerprint via the declared params.
  fingerprintExtras(_params, ctx, nodeId) {
    if (!nodeId) return "";
    const s = peekDepthSession(nodeId);
    if (s.baked && s.bakeRange) {
      const { inFrame, outFrame } = s.bakeRange;
      const f = Math.min(outFrame, Math.max(inFrame, ctx.frame));
      return `v${s.version}:f${f}:${hasDecodedDepth(nodeId, f) ? 1 : 0}`;
    }
    return `v${s.version}:${s.live ? "live" : "none"}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const depthMask = ctx.allocMask();
    const src = inputs.image;

    const session = peekDepthSession(nodeId);
    // Publish this node's own clock so the bake driver keys frames in the same
    // frame space compute will look them up in (layer-local time).
    recordScopedFrame(nodeId, ctx.frame);

    // Resolve which depth bitmap applies right now.
    let bitmap: ImageBitmap | null = null;
    if (session.baked && session.bakeRange) {
      const { inFrame, outFrame } = session.bakeRange;
      // Hold the first/last baked frame outside the range.
      const f = Math.min(outFrame, Math.max(inFrame, ctx.frame));
      bitmap = getDecodedDepth(nodeId, f);
      if (!bitmap) {
        // Decode in flight: offline exports must wait for it (frame accuracy);
        // realtime playback re-renders on the bump and shows the previous
        // depth texture for a frame in the meantime.
        const settle = requestDepthDecode(nodeId, f);
        if (ctx.offline) pushMediaSettle(ctx, settle);
      } else {
        prefetchDepthDecodes(nodeId, f);
      }
    } else if (session.live) {
      bitmap = session.live;
    }

    const cache = ensureCache(ctx, nodeId);
    if (bitmap && cache.ref !== bitmap) {
      cache.tex = uploadBitmap(ctx.gl, bitmap, cache.tex);
      cache.ref = bitmap;
      cache.w = bitmap.width;
      cache.h = bitmap.height;
    }

    // No depth yet (no Preview / first baked frame not decoded) → passthrough
    // the input so downstream wiring works before estimating. Matches the
    // pre-bake behavior of bg-remove / Segment.
    if (!cache.tex) {
      if (src && src.kind === "image") {
        const prog = ctx.getShader("depth/passthrough", PASSTHROUGH_FS);
        ctx.drawFullscreen(prog, output, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.texture);
          gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        });
      } else {
        ctx.clearTarget(output, [0, 0, 0, 0]);
      }
      ctx.clearTarget(depthMask, [0, 0, 0, 1]);
      return { primary: output, aux: { depth: depthMask } };
    }

    const invert = (params.invert as boolean) ? 1 : 0;
    const near = (params.near as number) ?? 0;
    const far = (params.far as number) ?? 1;
    const outputMode = (params.outputMode as string) ?? "depth";

    // Depth grayscale — the aux mask always, and the primary in depth mode.
    {
      const prog = ctx.getShader("depth/depth", DEPTH_FS);
      const drawDepth = (target: typeof output | typeof depthMask) => {
        ctx.drawFullscreen(prog, target, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cache.tex);
          gl.uniform1i(gl.getUniformLocation(prog, "u_depth"), 0);
          gl.uniform1f(gl.getUniformLocation(prog, "u_invert"), invert);
          gl.uniform1f(gl.getUniformLocation(prog, "u_near"), near);
          gl.uniform1f(gl.getUniformLocation(prog, "u_far"), far);
        });
      };
      drawDepth(depthMask);
      if (outputMode !== "normal") drawDepth(output);
    }

    // Normal map — primary only, in normal mode.
    if (outputMode === "normal") {
      const strength = (params.normalStrength as number) ?? 1;
      const prog = ctx.getShader("depth/normal", NORMAL_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cache.tex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_depth"), 0);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_invSize"),
          1 / Math.max(1, cache.w),
          1 / Math.max(1, cache.h)
        );
        gl.uniform1f(gl.getUniformLocation(prog, "u_invert"), invert);
        gl.uniform1f(gl.getUniformLocation(prog, "u_strength"), strength);
      });
    }

    return { primary: output, aux: { depth: depthMask } };
  },

  dispose(ctx, nodeId) {
    // GL textures only — the session store (live + baked frames) survives
    // engine rebuilds; it's freed by Free Bake / page lifetime.
    disposeCache(ctx, nodeId);
  },
};
