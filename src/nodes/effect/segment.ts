import type { NodeDefinition, RenderContext } from "@/engine/types";
import { pushMediaSettle } from "@/engine/offline-settle";
import {
  getDecodedMask,
  hasDecodedMask,
  peekSegmentSession,
  prefetchMaskDecodes,
  recordScopedFrame,
  requestMaskDecode,
  type MaskKind,
} from "@/lib/ai/segment-session";

// Segment Anything node. The user clicks dots on the canvas (overlay in
// EffectsApp) to pick what to segment; SlimSAM runs in the browser via
// Transformers.js. ML inference NEVER runs inside compute() — it's
// triggered by dot clicks (live single-frame mask) and the Bake button
// (per-frame masks over an in/out range), both of which write into the
// session store (lib/ai/segment-session.ts). Compute only resolves "which
// mask bitmap applies at ctx.frame", uploads it to a texture, and runs the
// cutout shader — so playback over a static chain costs nothing (the
// evaluator's fingerprint cache holds) and playback over a baked range
// costs one small texture upload per frame.
//
// The baked cache is session-only: dots / in / out / edge params serialize
// with the project, the masks themselves don't — reopening a project means
// one re-bake click.

interface SegmentTexCache {
  mask: WebGLTexture | null;
  maskRef: ImageBitmap | null;
  maskW: number;
  maskH: number;
  // Kind of the currently uploaded texture — decides the shader path even
  // when this frame's bitmap is still decoding (stale-texture draw).
  kind: MaskKind;
}

function ensureCache(ctx: RenderContext, nodeId: string): SegmentTexCache {
  const key = `segment:${nodeId}`;
  let s = ctx.state[key] as SegmentTexCache | undefined;
  if (!s) {
    s = { mask: null, maskRef: null, maskW: 0, maskH: 0, kind: "alpha" };
    ctx.state[key] = s;
  }
  return s;
}

function uploadBitmap(
  gl: WebGL2RenderingContext,
  bitmap: ImageBitmap,
  reuse: WebGLTexture | null,
  kind: MaskKind
): WebGLTexture | null {
  const tex = reuse ?? gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  // Index masks carry slot IDs in pixel values: no color management on
  // upload, and NEAREST filtering — interpolating between slot ids would
  // invent segments at boundaries.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  const filter = kind === "index" ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function disposeCache(ctx: RenderContext, nodeId: string) {
  const key = `segment:${nodeId}`;
  const s = ctx.state[key] as SegmentTexCache | undefined;
  if (s) {
    if (s.mask) ctx.gl.deleteTexture(s.mask);
    delete ctx.state[key];
  }
}

// Cutout — RGB from the LIVE upstream input (pipeline texture, Y-up, no
// flip), alpha from the mask post-processed with feather + threshold. The
// mask texture is an uploaded bitmap (Y-down), hence the flipped read —
// same convention as bg-remove. Unlike bg-remove the source is not frozen
// at bake time: a baked mask rides on top of the flowing video.
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

float processedMask(vec2 uv) {
  float r = u_feather * 8.0;
  vec2 t = u_invMask * r;
  float w0 = 0.4;
  float w1 = 0.25;
  float w2 = 0.05;
  float a = 0.0;
  a += maskAt(uv) * w0;
  a += maskAt(uv + vec2( t.x, 0.0)) * w1;
  a += maskAt(uv + vec2(-t.x, 0.0)) * w1;
  a += maskAt(uv + vec2(0.0,  t.y)) * w1;
  a += maskAt(uv + vec2(0.0, -t.y)) * w1;
  a += maskAt(uv + vec2( t.x,  t.y)) * w2;
  a += maskAt(uv + vec2(-t.x,  t.y)) * w2;
  a += maskAt(uv + vec2( t.x, -t.y)) * w2;
  a += maskAt(uv + vec2(-t.x, -t.y)) * w2;
  float knee = max(0.05 - abs(u_threshold - 0.5) * 0.05, 0.005);
  return smoothstep(u_threshold - knee, u_threshold + knee, a);
}

void main() {
  float a = processedMask(v_uv);
  vec3 rgb = texture(u_source, v_uv).rgb;
  outColor = vec4(rgb, a);
}`;

// Mask-as-image — the post-processed mask as grayscale.
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
  float w0 = 0.4;
  float w1 = 0.25;
  float w2 = 0.05;
  float a = 0.0;
  a += maskAt(v_uv) * w0;
  a += maskAt(v_uv + vec2( t.x, 0.0)) * w1;
  a += maskAt(v_uv + vec2(-t.x, 0.0)) * w1;
  a += maskAt(v_uv + vec2(0.0,  t.y)) * w1;
  a += maskAt(v_uv + vec2(0.0, -t.y)) * w1;
  a += maskAt(v_uv + vec2( t.x,  t.y)) * w2;
  a += maskAt(v_uv + vec2(-t.x,  t.y)) * w2;
  a += maskAt(v_uv + vec2( t.x, -t.y)) * w2;
  a += maskAt(v_uv + vec2(-t.x, -t.y)) * w2;
  float knee = max(0.05 - abs(u_threshold - 0.5) * 0.05, 0.005);
  a = smoothstep(u_threshold - knee, u_threshold + knee, a);
  outColor = vec4(a, a, a, 1.0);
}`;

const PASSTHROUGH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

// Auto modes: the mask texture holds per-pixel segment SLOT IDS (R channel,
// 0 = background). Colorize procedurally — golden-angle hue per slot keeps
// colors maximally separated and, because color derives from the STABLE
// slot id (not per-frame rank), consistent across the whole video.
const INDEX_COLOR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mask;
out vec4 outColor;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  float slot = floor(
    texture(u_mask, vec2(v_uv.x, 1.0 - v_uv.y)).r * 255.0 + 0.5
  );
  if (slot < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float hue = fract(slot * 0.61803398875);
  outColor = vec4(hsv2rgb(vec3(hue, 0.62, 1.0)), 1.0);
}`;

// Slot id normalized by the levels param — a grayscale id map that feeds
// Color Ramp (and the typed mask socket) for arbitrary palettes.
const INDEX_ID_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mask;
uniform float u_levels;
out vec4 outColor;

void main() {
  float slot = floor(
    texture(u_mask, vec2(v_uv.x, 1.0 - v_uv.y)).r * 255.0 + 0.5
  );
  float g = clamp(slot / max(u_levels, 1.0), 0.0, 1.0);
  outColor = vec4(g, g, g, 1.0);
}`;

export const segmentAnythingNode: NodeDefinition = {
  type: "segment-anything",
  name: "Segment Anything",
  category: "image",
  subcategory: "modifier",
  description:
    "Segment images locally via Transformers.js. Dots mode: select the node and click the canvas to drop dots on what you want — each dot adds another object (SlimSAM); outputs a cutout + selection mask. Auto modes need no points and output an evolving multicolor segment map: Semantic (SegFormer classes, inherently stable colors), Panoptic (DETR instances, overlap-matched across frames), Auto Grid (SAM point grid, slow but class-agnostic) — set Levels for the segment count, and use the grayscale id-map aux with a Color Ramp for custom palettes. For animated inputs, Bake runs the model over an in/out frame range and caches a mask per frame; Free Bake clears it.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["dots", "semantic", "panoptic", "grid"],
      default: "dots",
    },
    {
      name: "levels",
      label: "Levels",
      type: "scalar",
      min: 2,
      max: 32,
      step: 1,
      default: 6,
    },
    // Prompt dots in normalized [0,1]² Y-DOWN image space. Written by the
    // canvas overlay; plain JSON so it round-trips through save/load
    // untouched. Hidden — the custom panel + overlay own the UI.
    {
      name: "dots",
      label: "Dots",
      type: "string",
      default: [],
      hidden: true,
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
      name: "mask",
      type: "mask",
      description: "Selection alpha as a single-channel mask.",
    },
    {
      name: "mask_image",
      type: "image",
      description:
        "Selection alpha as a grayscale image (white = selected) — feed into nodes that don't accept the typed `mask` socket.",
    },
  ],

  // Cache key: the session store's version (bumped on live-mask updates,
  // bake commit, free) + which mask applies at the current frame. A static
  // chain with a live mask fingerprints as a constant — playback never
  // re-runs it. A baked range re-fingerprints only when the frame's mask
  // (or its decoded-readiness) changes.
  fingerprintExtras(_params, ctx, nodeId) {
    if (!nodeId) return "";
    const s = peekSegmentSession(nodeId);
    if (s.baked && s.bakeRange) {
      const { inFrame, outFrame } = s.bakeRange;
      const f = Math.min(outFrame, Math.max(inFrame, ctx.frame));
      return `v${s.version}:f${f}:${hasDecodedMask(nodeId, f) ? 1 : 0}`;
    }
    return `v${s.version}:${s.live ? "live" : "none"}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const maskOut = ctx.allocMask();
    const maskImg = ctx.allocImage();
    const src = inputs.image;

    const session = peekSegmentSession(nodeId);
    // Publish this node's own clock so the bake driver keys masks in the
    // same frame space compute will look them up in (layer-local time).
    recordScopedFrame(nodeId, ctx.frame);

    // Resolve which mask bitmap applies right now, and its kind (alpha
    // selection vs segment-index map).
    let bitmap: ImageBitmap | null = null;
    let kind: MaskKind = "alpha";
    if (session.baked && session.bakeRange) {
      kind = session.bakeKind;
      const { inFrame, outFrame } = session.bakeRange;
      // Hold the first/last baked mask outside the range.
      const f = Math.min(outFrame, Math.max(inFrame, ctx.frame));
      bitmap = getDecodedMask(nodeId, f);
      if (!bitmap) {
        // Decode in flight: offline exports must wait for it (frame
        // accuracy); realtime playback re-renders on the bump and shows
        // the previous mask texture for a frame in the meantime.
        const settle = requestMaskDecode(nodeId, f);
        if (ctx.offline) pushMediaSettle(ctx, settle);
      } else {
        // Keep the decode window ahead of sequential playback.
        prefetchMaskDecodes(nodeId, f);
      }
    } else if (session.live) {
      kind = session.liveKind;
      bitmap = session.live;
    }

    const cache = ensureCache(ctx, nodeId);
    if (bitmap && cache.maskRef !== bitmap) {
      cache.mask = uploadBitmap(ctx.gl, bitmap, cache.mask, kind);
      cache.maskRef = bitmap;
      cache.maskW = bitmap.width;
      cache.maskH = bitmap.height;
      cache.kind = kind;
    }

    // No mask at all yet (no dots placed / decode not landed on the very
    // first baked frame) → passthrough with an all-white mask, so users
    // can wire downstream before segmenting. Matches bg-remove's pre-bake
    // behavior.
    if (!cache.mask) {
      if (src && src.kind === "image") {
        const prog = ctx.getShader("segment/passthrough", PASSTHROUGH_FS);
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
      return { primary: output, aux: { mask: maskOut, mask_image: maskImg } };
    }

    // --- Index path (auto modes): multicolor segment map -----------------
    if (cache.kind === "index") {
      const levels = Math.max(1, Math.round((params.levels as number) ?? 6));
      {
        const prog = ctx.getShader("segment/index_color", INDEX_COLOR_FS);
        ctx.drawFullscreen(prog, output, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cache.mask);
          gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 0);
        });
      }
      {
        const prog = ctx.getShader("segment/index_id", INDEX_ID_FS);
        const drawId = (target: typeof maskImg | typeof maskOut) => {
          ctx.drawFullscreen(prog, target, (gl) => {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, cache.mask);
            gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 0);
            gl.uniform1f(gl.getUniformLocation(prog, "u_levels"), levels);
          });
        };
        drawId(maskImg);
        drawId(maskOut);
      }
      return { primary: output, aux: { mask: maskOut, mask_image: maskImg } };
    }

    // --- Alpha path (dots mode): cutout + selection mask ------------------
    const feather = (params.feather as number) ?? 0;
    const threshold = (params.threshold as number) ?? 0.5;

    // Cutout primary — live source RGB × mask alpha.
    if (src && src.kind === "image") {
      const prog = ctx.getShader("segment/cutout", CUTOUT_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_source"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, cache.mask);
        gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 1);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_invMask"),
          1 / Math.max(1, cache.maskW),
          1 / Math.max(1, cache.maskH)
        );
        gl.uniform1f(gl.getUniformLocation(prog, "u_feather"), feather);
        gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
      });
    } else {
      ctx.clearTarget(output, [0, 0, 0, 0]);
    }

    // Mask aux outputs — same post-processing, grayscale.
    {
      const prog = ctx.getShader("segment/mask_image", MASK_IMAGE_FS);
      const drawMask = (target: typeof maskImg | typeof maskOut) => {
        ctx.drawFullscreen(prog, target, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cache.mask);
          gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 0);
          gl.uniform2f(
            gl.getUniformLocation(prog, "u_invMask"),
            1 / Math.max(1, cache.maskW),
            1 / Math.max(1, cache.maskH)
          );
          gl.uniform1f(gl.getUniformLocation(prog, "u_feather"), feather);
          gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
        });
      };
      drawMask(maskImg);
      drawMask(maskOut);
    }

    return { primary: output, aux: { mask: maskOut, mask_image: maskImg } };
  },

  dispose(ctx, nodeId) {
    // GL textures only — the session store (live mask, baked frames)
    // survives engine rebuilds; it's freed by Free Bake / page lifetime.
    disposeCache(ctx, nodeId);
  },
};
