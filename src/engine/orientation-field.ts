import type { ImageValue, RenderContext } from "@/engine/types";

// The orientation-field wire convention (spec 082426_orientation-field.md).
//
// An orientation field EXTENDS the velocity-field image convention
// (velocity-field.ts, spec 072526_flow-fields.md) — same socket (plain
// image), same RG encoding, same Y-DOWN isotropic axes — by populating
// the previously unused B channel:
//
//   R = 0.5 + tx * 0.5     unit tangent (velocity encoding, midlevel 0.5)
//   G = 0.5 + ty * 0.5
//   B = coherence A ∈ [0,1]  ((λ1−λ2)/(λ1+λ2); 0 = isotropic/flat)
//   A = 1
//
// Semantics on top of the velocity rules (which all still apply — Y-DOWN
// tangent, `uv ± vec2(t.x, -t.y * aspect) * k` stepping, never matte an
// encoded field):
//   - t is the TANGENT: the direction ALONG edges (minor eigenvector of
//     the smoothed structure tensor), unit length, screen-space.
//   - Orientation is π-PERIODIC — t and −t name the same orientation.
//     Producers encode the representative with tx > 0 (ties: ty ≥ 0).
//     Consumers that use the axis directly (Kuwahara ellipse, bilateral,
//     shock, FDoG) read it as-is; consumers that WALK streamlines must
//     step sign-coherently via coherentStep() below, or every path kinks
//     at the near-vertical canonicalization seam.
//   - Plain velocity images are VALID inputs to orientation consumers:
//     B = 0 honestly decodes as "no anisotropy". Consumers whose look
//     depends on coherence expose how to handle that (see the Kuwahara
//     spec's `anisotropy` / floor params).
//
// Producers: Image Flow Field (image-flow-field.ts). Consumers: Flow
// Blur, and the rest of the painterly program as it lands. Any velocity
// consumer (Advect Image/Points, Displace) reads the RG of an
// orientation field as a unit velocity for free.

export const ORIENTATION_DECODE_GLSL = `
vec2 decodeTangent(vec4 c) {
  vec2 t = 2.0 * (c.rg - vec2(0.5));
  float len = length(t);
  return len < 1e-5 ? vec2(0.0) : t / len;
}
float decodeCoherence(vec4 c) { return c.b; }
// Sign-coherent streamline stepping: flip the π-periodic tangent to
// agree with the previous step's direction.
vec2 coherentStep(vec2 t, vec2 prev) { return dot(t, prev) < 0.0 ? -t : t; }
`;

export const ORIENTATION_ENCODE_GLSL = `
vec4 encodeOrientation(vec2 t, float coherence) {
  if (t.x < 0.0 || (t.x == 0.0 && t.y < 0.0)) t = -t;
  return vec4(clamp(t, vec2(-1.0), vec2(1.0)) * 0.5 + 0.5,
              clamp(coherence, 0.0, 1.0), 1.0);
}
`;

// Neutral (no orientation, no coherence) — for clearTarget on empty output.
export const ORIENTATION_NEUTRAL: [number, number, number, number] = [
  0.5, 0.5, 0.0, 1.0,
];

// ---------------------------------------------------------------------------
// Shared structure-tensor field compute.
//
// Used by the Image Flow Field node AND by painterly consumers whose
// optional `field` input is unwired (the consumer contract: every
// painterly node works standalone). Passes: [separable pre-blur of the
// source] → Sobel structure tensor → separable tensor blur → eigen
// decode + encode. Smoothing happens on TENSORS, never on angles — the
// tensor is linear under blurring, so the π-wraparound that breaks
// angle averaging never arises.
//
// The tensor texture packs (E, F, G) = (gx², gx·gy, gy²) as
// (E, 0.5 + F·0.5, G): E and G are non-negative but F is signed, and
// pool textures fall back to RGBA8 on some devices, which clamps to
// [0,1] — the affine encoding survives both formats (and stays affine,
// so blurring the encoded value IS the encoded blurred value).
//
// Gradients are taken on COVERAGE-WEIGHTED luminance (lum × alpha,
// matching the image→mask coercion semantics) so a shape drawn on
// transparency gets its silhouette's orientation, not the surround's.
// The Sobel runs per-texel (square pixels ⇒ screen-isotropic); the
// eigen pass flips tangent y from GL's Y-UP v_uv space to the wire
// convention's Y-DOWN at encode time.

// Exported for scripts/emit-shaders.mts (compile/link coverage under
// npm run check:shaders — the blendField precedent).
export const GAUSS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_dir;    // one-tap texel step (x pass or y pass)
uniform float u_sigma;
uniform int u_radius;  // taps per side, <= 32
out vec4 outColor;

void main() {
  if (u_radius <= 0) { outColor = texture(u_src, v_uv); return; }
  float twoS2 = 2.0 * u_sigma * u_sigma;
  vec4 acc = texture(u_src, v_uv);
  float wsum = 1.0;
  for (int i = 1; i <= 32; i++) {
    if (i > u_radius) break;
    float w = exp(-float(i * i) / twoS2);
    acc += w * (texture(u_src, v_uv + u_dir * float(i)) +
                texture(u_src, v_uv - u_dir * float(i)));
    wsum += 2.0 * w;
  }
  outColor = acc / wsum;
}`;

export const TENSOR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
out vec4 outColor;

float lum(vec2 uv) {
  vec4 c = texture(u_src, uv);
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
}

void main() {
  vec2 o = u_invRes;
  float tl = lum(v_uv + vec2(-o.x,  o.y));
  float tc = lum(v_uv + vec2( 0.0,  o.y));
  float tr = lum(v_uv + vec2( o.x,  o.y));
  float ml = lum(v_uv + vec2(-o.x,  0.0));
  float mr = lum(v_uv + vec2( o.x,  0.0));
  float bl = lum(v_uv + vec2(-o.x, -o.y));
  float bc = lum(v_uv + vec2( 0.0, -o.y));
  float br = lum(v_uv + vec2( o.x, -o.y));
  float gx = (tr + 2.0 * mr + br - tl - 2.0 * ml - bl) / 8.0;
  float gy = (tl + 2.0 * tc + tr - bl - 2.0 * bc - br) / 8.0; // +v = up
  outColor = vec4(gx * gx, 0.5 + gx * gy * 0.5, gy * gy, 1.0);
}`;

export const EIGEN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
${ORIENTATION_ENCODE_GLSL}

void main() {
  vec4 p = texture(u_src, v_uv);
  float E = p.r;
  float F = (p.g - 0.5) * 2.0;
  float G = p.b;
  float h = 0.5 * (E + G);
  float d = sqrt(max(0.0, 0.25 * (E - G) * (E - G) + F * F));
  float l1 = h + d;
  float l2 = max(0.0, h - d);
  float coh = (l1 + l2) > 1e-7 ? (l1 - l2) / (l1 + l2) : 0.0;
  // Minor eigenvector (tangent, along edges), Y-UP v_uv space.
  vec2 t = vec2(l1 - E, -F);
  if (dot(t, t) < 1e-12) t = (E >= G) ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  t = normalize(t);
  t.y = -t.y; // wire convention is Y-DOWN
  outColor = encodeOrientation(t, coh);
}`;

// σ → taps per side. Below ~0.3px a Gaussian is a no-op; cap at the
// shader's fixed loop bound.
function gaussRadius(sigma: number): number {
  if (!(sigma > 0.3)) return 0;
  return Math.min(32, Math.ceil(sigma * 3));
}

// Generic separable Gaussian between pool textures — exported for other
// painterly passes that blur non-color data (Line Art's luminance
// pyramid) and must NOT ride convolve/'s premultiply boundary.
export function blurSeparable(
  ctx: RenderContext,
  srcTex: WebGLTexture,
  dst: ImageValue,
  sigma: number
) {
  const prog = ctx.getShader("orientation-field/gauss", GAUSS_FS);
  const radius = gaussRadius(sigma);
  const tmp = ctx.allocImage();
  const pass = (
    from: WebGLTexture,
    to: ImageValue,
    dir: [number, number]
  ) => {
    ctx.drawFullscreen(prog, to, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_dir"), dir[0], dir[1]);
      gl.uniform1f(gl.getUniformLocation(prog, "u_sigma"), sigma);
      gl.uniform1i(gl.getUniformLocation(prog, "u_radius"), radius);
    });
  };
  pass(srcTex, tmp, [1 / ctx.width, 0]);
  pass(tmp.texture, dst, [0, 1 / ctx.height]);
  ctx.releaseTexture(tmp.texture);
}

export interface OrientationFieldOpts {
  preBlur: number; // σ px on the source before the gradient (noise gate)
  smooth: number; // σ px of the tensor blur (stroke coherence scale)
}

// Compute an encoded orientation field from an image. Allocates and
// returns a pool texture the CALLER owns (return it as an output, or
// release it after use — the consumer-fallback case).
export function computeOrientationField(
  ctx: RenderContext,
  source: ImageValue,
  opts: OrientationFieldOpts
): ImageValue {
  let work = source.texture;
  let pre: ImageValue | null = null;
  if (gaussRadius(opts.preBlur) > 0) {
    pre = ctx.allocImage();
    blurSeparable(ctx, source.texture, pre, opts.preBlur);
    work = pre.texture;
  }

  const tensor = ctx.allocImage();
  const tensorProg = ctx.getShader("orientation-field/tensor", TENSOR_FS);
  ctx.drawFullscreen(tensorProg, tensor, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, work);
    gl.uniform1i(gl.getUniformLocation(tensorProg, "u_src"), 0);
    gl.uniform2f(
      gl.getUniformLocation(tensorProg, "u_invRes"),
      1 / ctx.width,
      1 / ctx.height
    );
  });
  if (pre) ctx.releaseTexture(pre.texture);

  let tensorFinal = tensor;
  if (gaussRadius(opts.smooth) > 0) {
    const smoothed = ctx.allocImage();
    blurSeparable(ctx, tensor.texture, smoothed, opts.smooth);
    ctx.releaseTexture(tensor.texture);
    tensorFinal = smoothed;
  }

  const field = ctx.allocImage();
  const eigenProg = ctx.getShader("orientation-field/eigen", EIGEN_FS);
  ctx.drawFullscreen(eigenProg, field, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tensorFinal.texture);
    gl.uniform1i(gl.getUniformLocation(eigenProg, "u_src"), 0);
  });
  ctx.releaseTexture(tensorFinal.texture);

  return field;
}
