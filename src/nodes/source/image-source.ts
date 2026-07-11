import { OPACITY_PARAM } from "@/engine/conventions";
import {
  aspectFitMeasure,
  emptyElement,
  renderRegionToRect,
  type ElementFit,
} from "@/engine/element";
import type {
  ElementValue,
  ExrImageParamValue,
  NodeDefinition,
} from "@/engine/types";
import {
  decodeExrLayerAsync,
  findExrLayer,
  isExrImageValue,
  type ExrDecodeResult,
} from "@/engine/exr";
import { pushMediaSettle } from "@/engine/offline-settle";

// u_hasUvIn: 0 = no UV field connected (use v_uv), 1 = UV texture, 2 = scalar
// broadcast (whole frame samples the same point). Fit math runs on the
// resolved UV so warps happen in output/canvas space before the aspect fit.
const FIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;
void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  vec2 s = 0.5 + (uv - 0.5) * u_invScale;
  if (u_letterbox > 0.5 && (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Source bitmap is uploaded without UNPACK_FLIP_Y (unreliable for ImageBitmap across browsers).
  // Flip vertically here so row 0 of the bitmap ends up at the top of the WebGL-Y-up render target.
  outColor = texture(u_src, vec2(s.x, 1.0 - s.y));
}`;

interface SourceState {
  bitmapRef: ImageBitmap | null;
  tex: WebGLTexture | null;
  // 1×1 placeholder so the u_uvIn sampler has a valid binding even when no
  // UV field is connected (WebGL requires every declared sampler to be
  // bound to something).
  zeroTex: WebGLTexture | null;
  // ── EXR still state ──────────────────────────────────────────────────
  // The param value the EXR state belongs to (a new pick resets), the
  // decode identity we want / have uploaded (layer id + unpremultiply), a
  // landed-but-not-yet-uploaded decode, and the uploaded texture's true
  // pixel size. The node is cached (stable), so fingerprintExtras folds
  // wantKey/uploadedKey/pending into the fingerprint — a decode landing
  // re-fingerprints and the next eval uploads it.
  exrRef: ExrImageParamValue | null;
  exrWantKey: string | null;
  exrUploadedKey: string | null;
  exrPending: ExrDecodeResult | null;
  exrW: number;
  exrH: number;
}

function ensureState(
  ctx: import("@/engine/types").RenderContext,
  nodeId: string
): SourceState {
  const stateKey = `image-source:${nodeId}`;
  let st = ctx.state[stateKey] as SourceState | undefined;
  if (!st) {
    st = {
      bitmapRef: null,
      tex: null,
      zeroTex: null,
      exrRef: null,
      exrWantKey: null,
      exrUploadedKey: null,
      exrPending: null,
      exrW: 0,
      exrH: 0,
    };
    ctx.state[stateKey] = st;
  }
  return st;
}

export const imageSourceNode: NodeDefinition = {
  type: "image-source",
  name: "Image Source",
  category: "image",
  subcategory: "generator",
  description:
    "Uploads an image and produces it as the canonical output. Accepts EXR files (single or multilayer, scene-linear HDR) with a layer picker.",
  backend: "webgl2",
  inputs: [
    { name: "uv_in", label: "UV", type: "uv", required: false },
  ],
  params: [
    OPACITY_PARAM,
    { name: "file", label: "Image", type: "file", default: null },
    // EXR files only: which layer/AOV feeds the output. Options come from
    // the loaded file's header (the `exr_layer` control reads them off the
    // `file` value); stored value is the layer's stable id, "" = default.
    {
      name: "exr_layer",
      label: "Layer",
      type: "enum",
      options: [],
      control: "exr_layer",
      default: "",
      visibleIf: (p) => isExrImageValue(p.file),
    },
    // EXR stores associated (premultiplied) alpha; the engine is straight-
    // alpha. Off = trust the file / keep premultiplied math downstream.
    {
      name: "exr_unpremultiply",
      label: "Un-premultiply alpha",
      type: "boolean",
      default: true,
      visibleIf: (p) => isExrImageValue(p.file),
    },
    {
      name: "fit",
      label: "Fit",
      type: "enum",
      options: ["cover", "contain", "stretch"],
      default: "cover",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "element",
      type: "element",
      description:
        "The source bitmap as an intrinsically-sized element for Auto Layout — natural size is the bitmap's own pixels, so aspect is correct and resampling stays crisp without a Frame node. The primary output's canvas fit doesn't apply; the layout slot's fit does.",
    },
  ],

  // The node is cached (stable); an EXR decode lands asynchronously, so its
  // progress has to show up in the fingerprint or the cached black frame
  // would stick. wantKey changes on layer/alpha edits, "p" appears when a
  // decode lands, uploadedKey once it's on the GPU.
  fingerprintExtras(params, ctx, nodeId) {
    if (!isExrImageValue(params.file)) return "";
    const st = ctx.state[`image-source:${nodeId}`] as SourceState | undefined;
    if (!st) return "exr:";
    return `exr:${st.exrUploadedKey ?? ""}${st.exrPending ? "|p" : ""}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const gl = ctx.gl;
    const fileVal = params.file as
      | ImageBitmap
      | ExrImageParamValue
      | null
      | undefined;

    // Resolve (texture, source px size) from either source kind.
    let srcTex: WebGLTexture | null = null;
    let srcW = 0;
    let srcH = 0;

    if (isExrImageValue(fileVal)) {
      const st = ensureState(ctx, nodeId);
      const layer = findExrLayer(fileVal.layers, params.exr_layer as string);
      const unpremultiply = (params.exr_unpremultiply as boolean) ?? true;
      const wantKey = `${layer?.id ?? ""}|${unpremultiply}`;

      if (st.exrRef !== fileVal) {
        // New file picked — drop everything from the previous one.
        st.exrRef = fileVal;
        st.exrWantKey = null;
        st.exrUploadedKey = null;
        st.exrPending = null;
        if (st.tex) {
          gl.deleteTexture(st.tex);
          st.tex = null;
        }
        st.bitmapRef = null;
      }

      if (st.exrWantKey !== wantKey) {
        // Layer / alpha selection changed (or first eval) — kick a decode.
        // The last-good texture keeps showing until the new one lands.
        st.exrWantKey = wantKey;
        st.exrPending = null;
        const p = fileVal.blob
          .arrayBuffer()
          .then((buf) => decodeExrLayerAsync(buf, { layer, unpremultiply }))
          .then((res) => {
            if (st.exrRef !== fileVal || st.exrWantKey !== wantKey) return;
            st.exrPending = res;
            if (typeof window !== "undefined") {
              window.dispatchEvent(new Event("pipeline-bump"));
            }
          })
          .catch((e) => {
            console.warn("EXR still decode failed:", e);
          });
        if (ctx.offline) pushMediaSettle(ctx, p);
      }

      if (st.exrPending) {
        // Landed since last eval — upload as RGBA16F (HDR values intact,
        // straight alpha, rows already in ImageBitmap order).
        const res = st.exrPending;
        st.exrPending = null;
        if (st.tex) gl.deleteTexture(st.tex);
        const tex = gl.createTexture();
        if (!tex) throw new Error("image-source: failed to create texture");
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA16F,
          res.width,
          res.height,
          0,
          gl.RGBA,
          gl.FLOAT,
          res.data
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        st.tex = tex;
        st.exrW = res.width;
        st.exrH = res.height;
        st.exrUploadedKey = wantKey;
      }

      srcTex = st.tex;
      srcW = st.exrW;
      srcH = st.exrH;
    } else if (fileVal instanceof ImageBitmap) {
      const bitmap = fileVal;
      const st = ensureState(ctx, nodeId);
      if (st.bitmapRef !== bitmap || !st.tex) {
        if (st.tex) gl.deleteTexture(st.tex);
        const tex = gl.createTexture();
        if (!tex) throw new Error("image-source: failed to create texture");
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
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
        st.tex = tex;
        st.bitmapRef = bitmap;
        st.exrRef = null;
        st.exrUploadedKey = null;
      }
      srcTex = st.tex;
      srcW = bitmap.width;
      srcH = bitmap.height;
    }

    if (!srcTex || !srcW || !srcH) {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output, aux: { element: emptyElement() } };
    }

    const st = ensureState(ctx, nodeId);
    if (!st.zeroTex) {
      st.zeroTex = makeZeroTex(gl);
    }

    const uvIn = inputs.uv_in;
    let uvInMode = 0;
    let uvInTex: WebGLTexture | null = st.zeroTex;
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = uvIn.texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    const imgAspect = srcW / srcH;
    const outAspect = output.width / output.height;
    const alpha = imgAspect / outAspect;
    const fit = (params.fit as string) ?? "cover";

    let invScale: [number, number];
    let letterbox = 0;
    if (fit === "stretch") {
      invScale = [1, 1];
    } else if (fit === "cover") {
      invScale = alpha > 1 ? [1 / alpha, 1] : [1, alpha];
    } else {
      invScale = alpha > 1 ? [1, alpha] : [1 / alpha, 1];
      letterbox = 1;
    }

    const prog = ctx.getShader("image-source/fit", FIT_FS);
    const boundTex = srcTex;
    const boundUvTex = uvInTex;
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, boundTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_invScale"),
        invScale[0],
        invScale[1]
      );
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_letterbox"), letterbox);

      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, boundUvTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_uvIn"), 1);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );
    });

    // Auto Layout element: natural size is the source's own pixels.
    // Render samples the uploaded texture directly — the negative-
    // height region flips its Y-down rows into engine orientation, same
    // job FIT_FS's `1.0 - s.y` does for the primary.
    const elemTex = srcTex;
    const elemW = srcW;
    const elemH = srcH;
    const nodeFit = fit as ElementFit;
    const element: ElementValue = {
      kind: "element",
      // Aspect-aware: a hug/fixed-on-one-axis slot keeps the bitmap's
      // ratio and scales with the layout, instead of pinning to the full
      // bitmap resolution (which is what made fill+cover blow up when the
      // container got wide).
      measure: (c) => aspectFitMeasure(elemW, elemH, c),
      render: (rctx, width, height, opts) =>
        renderRegionToRect(
          rctx,
          { texture: elemTex, width: elemW, height: elemH },
          { x: 0, y: 1, width: 1, height: -1 },
          width,
          height,
          opts?.fit ?? nodeFit,
          opts?.alignX,
          opts?.alignY
        ),
      // Bitmap px routinely dwarf the layout — advise fixed so a fresh
      // slot doesn't blow out to a 4000px child.
      preferredSizing: { width: "fixed", height: "fixed" },
    };

    return { primary: output, aux: { element } };
  },

  dispose(ctx, nodeId) {
    const stateKey = `image-source:${nodeId}`;
    const cached = ctx.state[stateKey] as SourceState | undefined;
    if (cached?.tex) ctx.gl.deleteTexture(cached.tex);
    if (cached?.zeroTex) ctx.gl.deleteTexture(cached.zeroTex);
    delete ctx.state[stateKey];
  },
};

// 1×1 RGBA8 zero texture — a stand-in bound to u_uvIn when no UV field is
// connected so the sampler stays valid without affecting the output.
function makeZeroTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("image-source: failed to create placeholder texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0])
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
