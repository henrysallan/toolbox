import { getAudioFrame, rms } from "./audio-analysis";
import { elementToCanvasImage, wrapImageAsElement } from "./element";
import type {
  RenderContext,
  SocketType,
  SocketValue,
} from "./types";

// Shared 1×1 scratch canvas for the image/mask → scalar readback. Lives
// on ctx.state so it persists across evals without re-allocating, and
// gets torn down with the render context. Each eval reuses the same
// canvas; content is overwritten by blitToCanvas.
const SCRATCH_KEY = "__coerce_scratch_1x1__";

function getScratchCanvas(ctx: RenderContext): HTMLCanvasElement {
  const existing = ctx.state[SCRATCH_KEY] as HTMLCanvasElement | undefined;
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  ctx.state[SCRATCH_KEY] = canvas;
  return canvas;
}

// Sample the representative value of an image-like texture by blitting it
// through a 1×1 framebuffer (the WebGL hiddenCanvas inside blitToCanvas
// resizes to match the target), then reading that one pixel back. The
// sampled UV is the fullscreen triangle's fragment center ≈ (0.5, 0.5),
// so for smooth inputs (noise, gradients) this is the visual "middle
// value." For high-contrast images it's just whatever single pixel the
// linear-filter sampler lands on — good enough for the common case of
// wiring noise → scalar params.
function sampleImageRed(
  value: { texture: WebGLTexture; width: number; height: number },
  ctx: RenderContext
): number | null {
  const canvas = getScratchCanvas(ctx);
  try {
    ctx.blitToCanvas(
      { kind: "image", texture: value.texture, width: value.width, height: value.height },
      canvas
    );
  } catch {
    return null;
  }
  const c2d = canvas.getContext("2d");
  if (!c2d) return null;
  const data = c2d.getImageData(0, 0, 1, 1).data;
  return data[0] / 255;
}

const MASK_TO_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  float m = texture(u_src, v_uv).r;
  outColor = vec4(m, m, m, 1.0);
}`;

// Image → mask is luminance WEIGHTED BY COVERAGE (alpha). For an opaque
// image (alpha == 1 everywhere: noise, gradients, photos) this is exactly the
// old luminance behavior — no regression. For a shape drawn on transparency
// (Rectangle/Circle/Text/SVG rasters, SDF fills) the alpha term zeroes the
// transparent surround (so the mask is the silhouette, not whatever stale RGB
// sits in the cleared region) and passes the drawn coverage through. Net: a
// bright-filled shape mattes by its shape; a grayscale image still mattes by
// brightness. (A dark-*colored* fill still reads dim — use a light fill, or
// the shape's alpha via a coverage source, if you want color-independent.)
const IMAGE_TO_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(l * c.a, 0.0, 0.0, 1.0);
}`;

export function coerceValue(
  value: SocketValue | undefined,
  target: SocketType,
  ctx: RenderContext
): SocketValue | undefined {
  if (!value) return undefined;
  if (value.kind === target) return value;

  if (value.kind === "mask" && target === "image") {
    const out = ctx.allocImage({ width: value.width, height: value.height });
    const program = ctx.getShader("__mask_to_image__", MASK_TO_IMAGE_FS);
    ctx.drawFullscreen(program, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_src"), 0);
    });
    return out;
  }

  if (value.kind === "image" && target === "mask") {
    const out = ctx.allocMask({ width: value.width, height: value.height });
    const program = ctx.getShader("__image_to_mask__", IMAGE_TO_MASK_FS);
    ctx.drawFullscreen(program, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_src"), 0);
    });
    return out;
  }

  if (value.kind === "scalar") {
    const v = value.value;
    if (target === "vec2") return { kind: "vec2", value: [v, v] };
    if (target === "vec3") return { kind: "vec3", value: [v, v, v] };
    if (target === "vec4") return { kind: "vec4", value: [v, v, v, v] };
    // Scalar → UV passes through as a ScalarValue. UV-accepting nodes branch
    // on `.kind` and broadcast the scalar in-shader as a uniform vec2, which
    // avoids allocating a 1×1 texture per scalar coercion per evaluation.
    if (target === "uv") return value;
  }

  // Image / mask → scalar. Sample the source's "middle value" via a 1×1
  // readback. Intentionally general so any scalar-typed input or exposed
  // param accepts an image — noise wired into Transform scale, gradient
  // wired into rotation, etc. The readback is a sync GPU stall but only
  // fires when a consumer actually requests the coercion, and only on
  // one pixel.
  if ((value.kind === "image" || value.kind === "mask") && target === "scalar") {
    const v = sampleImageRed(value, ctx);
    if (v == null) return undefined;
    return { kind: "scalar", value: v };
  }

  // Audio → scalar. Reads the shared analysis frame (one AnalyserNode per
  // element, cached per frame in audio-analysis.ts) and emits the RMS of
  // the current time-domain buffer: 0 when silent, ~1 on a loud signal.
  // Wire Audio Source into Transform's scale, a Math node, a Remap's
  // input, etc. — anywhere a scalar belongs.
  if (value.kind === "audio" && target === "scalar") {
    const frame = getAudioFrame(value, ctx);
    if (!frame) return { kind: "scalar", value: 0 };
    return { kind: "scalar", value: rms(frame.timeDomain) };
  }

  // Image → element. Wraps the texture as a deferred renderable whose
  // natural size is the image's own px dimensions. This is what makes
  // ANY existing image chain wirable into Auto Layout directly
  // (Image Source → Blur → Auto Layout, no adapter node). Identity-
  // cached inside the helper so per-eval cost is near-zero.
  if (value.kind === "image" && target === "element") {
    return wrapImageAsElement(value);
  }

  // Element → image. Renders at natural size (clamped to canvas) and
  // composites centered onto a transparent canvas-sized image — element
  // wires become acceptable to every existing image consumer, and the
  // preview canvas works. Identity-cached inside the helper.
  if (value.kind === "element" && target === "image") {
    return elementToCanvasImage(value, ctx);
  }

  return undefined;
}
