import type { NodeDefinition, RenderContext } from "@/engine/types";

// Background-removal node. The expensive ML inference runs once,
// triggered by the Bake button in the custom param panel
// (BgRemovePanel.tsx). Bake stashes two ImageBitmaps in node
// params:
//
//   bakedSource — the input RGB at bake-time (decoded from the
//                 upstream node's output blob).
//   bakedMask   — the foreground alpha mask, single-channel
//                 packed into RGBA luminance.
//
// Live params (`feather`, `threshold`) post-process the mask each
// frame via a small shader so the user can tweak the cutout edge
// without paying for another inference pass. Upstream changes are
// IGNORED until the user re-bakes — the whole point of the node is
// to freeze a snapshot of the chain so we don't do ML per frame.

interface BakedTex {
  // Local cache of WebGL textures uploaded from the baked
  // ImageBitmaps. Re-uploaded only when the bitmap reference
  // changes (a re-bake mints fresh ImageBitmaps).
  source: WebGLTexture | null;
  sourceRef: ImageBitmap | null;
  sourceW: number;
  sourceH: number;
  mask: WebGLTexture | null;
  maskRef: ImageBitmap | null;
  maskW: number;
  maskH: number;
}

function ensureCache(ctx: RenderContext, nodeId: string): BakedTex {
  const key = `bg-remove:${nodeId}`;
  let s = ctx.state[key] as BakedTex | undefined;
  if (!s) {
    s = {
      source: null,
      sourceRef: null,
      sourceW: 0,
      sourceH: 0,
      mask: null,
      maskRef: null,
      maskW: 0,
      maskH: 0,
    };
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
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    bitmap
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function disposeCache(ctx: RenderContext, nodeId: string) {
  const key = `bg-remove:${nodeId}`;
  const s = ctx.state[key] as BakedTex | undefined;
  if (s) {
    if (s.source) ctx.gl.deleteTexture(s.source);
    if (s.mask) ctx.gl.deleteTexture(s.mask);
    delete ctx.state[key];
  }
}

// Cutout shader — RGB from source, A from the mask post-processed
// with feather (Gaussian blur, radius scaled by `u_feather`) and
// threshold (sigmoid / smoothstep around `u_threshold`).
//
// Y-flip on the source and mask reads because the bake path
// uploads bitmaps without UNPACK_FLIP_Y, which the rest of the
// engine treats as Y-up.
const CUTOUT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_mask;
uniform vec2  u_invMask;     // 1.0 / mask size
uniform float u_feather;     // 0..1 — fraction of mask width
uniform float u_threshold;   // 0..1 — alpha cutoff (0.5 = identity)
out vec4 outColor;

float maskAt(vec2 uv) {
  return texture(u_mask, vec2(uv.x, 1.0 - uv.y)).r;
}

void main() {
  // 9-tap Gaussian feather. Sigma scaled by feather param; radius
  // 1 sigma keeps the kernel cheap. At feather=0 we still do the
  // taps but with zero offset (fall through to single-pixel).
  float r = u_feather * 8.0;
  vec2 t = u_invMask * r;
  float w[3];
  w[0] = 0.4;
  w[1] = 0.25;
  w[2] = 0.05;
  float a = 0.0;
  a += maskAt(v_uv) * w[0];
  a += maskAt(v_uv + vec2( t.x, 0.0)) * w[1];
  a += maskAt(v_uv + vec2(-t.x, 0.0)) * w[1];
  a += maskAt(v_uv + vec2(0.0,  t.y)) * w[1];
  a += maskAt(v_uv + vec2(0.0, -t.y)) * w[1];
  a += maskAt(v_uv + vec2( t.x,  t.y)) * w[2];
  a += maskAt(v_uv + vec2(-t.x,  t.y)) * w[2];
  a += maskAt(v_uv + vec2( t.x, -t.y)) * w[2];
  a += maskAt(v_uv + vec2(-t.x, -t.y)) * w[2];

  // Threshold: smoothstep over a small knee centred at the param.
  // threshold=0.5 with knee 0 = identity; otherwise sharpens or
  // softens the edge.
  float knee = max(0.05 - abs(u_threshold - 0.5) * 0.05, 0.005);
  a = smoothstep(u_threshold - knee, u_threshold + knee, a);

  vec3 rgb = texture(u_source, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
  outColor = vec4(rgb, a);
}`;

// Mask-as-image output: just the post-processed mask as a
// grayscale image. Identical pipeline to the cutout's alpha
// channel.
const MASK_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mask;
uniform vec2  u_invMask;
uniform float u_feather;
uniform float u_threshold;
out vec4 outColor;

float maskAt(vec2 uv) {
  return texture(u_mask, vec2(uv.x, 1.0 - uv.y)).r;
}

void main() {
  float r = u_feather * 8.0;
  vec2 t = u_invMask * r;
  float w[3];
  w[0] = 0.4;
  w[1] = 0.25;
  w[2] = 0.05;
  float a = 0.0;
  a += maskAt(v_uv) * w[0];
  a += maskAt(v_uv + vec2( t.x, 0.0)) * w[1];
  a += maskAt(v_uv + vec2(-t.x, 0.0)) * w[1];
  a += maskAt(v_uv + vec2(0.0,  t.y)) * w[1];
  a += maskAt(v_uv + vec2(0.0, -t.y)) * w[1];
  a += maskAt(v_uv + vec2( t.x,  t.y)) * w[2];
  a += maskAt(v_uv + vec2(-t.x,  t.y)) * w[2];
  a += maskAt(v_uv + vec2( t.x, -t.y)) * w[2];
  a += maskAt(v_uv + vec2(-t.x, -t.y)) * w[2];
  float knee = max(0.05 - abs(u_threshold - 0.5) * 0.05, 0.005);
  a = smoothstep(u_threshold - knee, u_threshold + knee, a);
  outColor = vec4(a, a, a, 1.0);
}`;

// Passthrough — used when no bake exists yet, OR no input is
// connected (we can't even passthrough then; output black). Just
// an identity blit.
const PASSTHROUGH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

export const bgRemoveNode: NodeDefinition = {
  type: "bg-remove",
  name: "Background Remove",
  category: "image",
  subcategory: "modifier",
  description:
    "Remove the background from an image using BRIA's RMBG model running locally via Transformers.js. Bake captures the upstream input + alpha mask once; live `feather` / `threshold` params tweak the edge per frame without a re-bake. Outputs the cutout (primary) plus the mask as both a typed mask aux and a grayscale image aux.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "model",
      label: "Model",
      type: "enum",
      options: ["rmbg-1.4", "rmbg-2.0"],
      default: "rmbg-1.4",
    },
    {
      name: "feather",
      label: "Feather",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0,
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0.1,
      max: 0.9,
      step: 0.01,
      default: 0.5,
    },
    // ImageBitmap params — populated by the Bake button. file-typed
    // so they round-trip through the existing data-URL save/load
    // path in src/lib/project.ts.
    {
      name: "bakedSource",
      label: "Baked Source",
      type: "file",
      default: null,
    },
    {
      name: "bakedMask",
      label: "Baked Mask",
      type: "file",
      default: null,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "mask",
      type: "mask",
      description: "Foreground alpha as a single-channel mask.",
    },
    {
      name: "mask_image",
      type: "image",
      description:
        "Foreground alpha as a grayscale image (white = foreground, black = background) — feed into nodes that don't accept the typed `mask` socket.",
    },
  ],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const maskOut = ctx.allocMask();
    const maskImg = ctx.allocImage();

    const baked = params.bakedSource as ImageBitmap | null | undefined;
    const bakedMask = params.bakedMask as ImageBitmap | null | undefined;
    const src = inputs.image;

    // No bake yet → passthrough so users can wire downstream nodes
    // before the first bake. mask aux is fully white (foreground
    // is "everything" pre-bake).
    if (!baked || !bakedMask) {
      if (src && src.kind === "image") {
        const prog = ctx.getShader("bg-remove/passthrough", PASSTHROUGH_FS);
        ctx.drawFullscreen(prog, output, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.texture);
          gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        });
      } else {
        ctx.clearTarget(output, [0, 0, 0, 0]);
      }
      ctx.clearTarget(maskOut, [1, 1, 1, 1]);
      ctx.clearTarget(maskImg, [1, 1, 1, 1]);
      return {
        primary: output,
        aux: { mask: maskOut, mask_image: maskImg },
      };
    }

    // Upload the baked bitmaps to GL textures (only when the bitmap
    // reference changes — so a re-bake drops the old textures and
    // mints new ones; param tweaks reuse the existing textures).
    const cache = ensureCache(ctx, nodeId);
    if (cache.sourceRef !== baked) {
      cache.source = uploadBitmap(ctx.gl, baked, cache.source);
      cache.sourceRef = baked;
      cache.sourceW = baked.width;
      cache.sourceH = baked.height;
    }
    if (cache.maskRef !== bakedMask) {
      cache.mask = uploadBitmap(ctx.gl, bakedMask, cache.mask);
      cache.maskRef = bakedMask;
      cache.maskW = bakedMask.width;
      cache.maskH = bakedMask.height;
    }
    if (!cache.source || !cache.mask) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      ctx.clearTarget(maskOut, [0, 0, 0, 1]);
      ctx.clearTarget(maskImg, [0, 0, 0, 1]);
      return {
        primary: output,
        aux: { mask: maskOut, mask_image: maskImg },
      };
    }

    const feather = (params.feather as number) ?? 0;
    const threshold = (params.threshold as number) ?? 0.5;

    // Cutout primary output.
    {
      const prog = ctx.getShader("bg-remove/cutout", CUTOUT_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cache.source);
        gl.uniform1i(gl.getUniformLocation(prog, "u_source"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, cache.mask);
        gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 1);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_invMask"),
          1 / cache.maskW,
          1 / cache.maskH
        );
        gl.uniform1f(gl.getUniformLocation(prog, "u_feather"), feather);
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_threshold"),
          threshold
        );
      });
    }

    // Mask as grayscale image — same shader, drawing to maskImg.
    {
      const prog = ctx.getShader("bg-remove/mask_image", MASK_IMAGE_FS);
      const drawMask = (target: typeof maskImg | typeof maskOut) => {
        ctx.drawFullscreen(prog, target, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cache.mask);
          gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 0);
          gl.uniform2f(
            gl.getUniformLocation(prog, "u_invMask"),
            1 / cache.maskW,
            1 / cache.maskH
          );
          gl.uniform1f(gl.getUniformLocation(prog, "u_feather"), feather);
          gl.uniform1f(
            gl.getUniformLocation(prog, "u_threshold"),
            threshold
          );
        });
      };
      drawMask(maskImg);
      drawMask(maskOut);
    }

    return { primary: output, aux: { mask: maskOut, mask_image: maskImg } };
  },

  dispose(ctx, nodeId) {
    disposeCache(ctx, nodeId);
  },
};
