import type { NodeDefinition } from "@/engine/types";

// Sharpen filter with four kernel shapes. All are single-pass 3×3
// convolutions that amplify the difference between a pixel and its
// neighbors — the amount param controls how strong that amplification
// is (0 = identity, ~1 = classic sharpen, higher = increasingly crisp
// and eventually artifact-y).
//
// Algorithms:
//   - box:     4-neighbor Laplacian (N/S/E/W only). Rectilinear,
//              emphasizes horizontal/vertical edges.
//   - diamond: 8-neighbor Laplacian (full 3×3). Emphasizes edges in
//              all directions; stronger than box at the same amount.
//   - cross:   Diagonal-only (4 corners). Unusual — emphasizes
//              diagonal edges while leaving axis-aligned edges alone.
//              Good for textures with a dominant diagonal structure.
//   - unsharp: Gaussian-weighted 3×3 unsharp mask. The classic
//              "pro" sharpen — softer falloff, less ringing than
//              Laplacian-style kernels at equal amount.
//
// Alpha is passed through untouched. RGB is not clamped — output can
// overshoot [0,1] on edges, which downstream nodes can handle or clip
// as they see fit.

const SHARPEN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
uniform float u_amount;
uniform int u_algo; // 0 box, 1 diamond, 2 cross, 3 unsharp
out vec4 outColor;

void main() {
  vec2 o = u_invRes;
  vec4 c = texture(u_src, v_uv);
  vec3 center = c.rgb;
  vec3 rgb;

  if (u_algo == 0) {
    // Box: 4-neighbor Laplacian. Output = center*(1+4A) - A*(N+S+E+W).
    vec3 n = texture(u_src, v_uv + vec2( 0.0, -o.y)).rgb;
    vec3 s = texture(u_src, v_uv + vec2( 0.0,  o.y)).rgb;
    vec3 e = texture(u_src, v_uv + vec2( o.x,  0.0)).rgb;
    vec3 w = texture(u_src, v_uv + vec2(-o.x,  0.0)).rgb;
    rgb = center * (1.0 + 4.0 * u_amount) - u_amount * (n + s + e + w);
  } else if (u_algo == 1) {
    // Diamond: 8-neighbor Laplacian. Full 3×3 ring, equal weights.
    vec3 nw = texture(u_src, v_uv + vec2(-o.x, -o.y)).rgb;
    vec3 n  = texture(u_src, v_uv + vec2( 0.0, -o.y)).rgb;
    vec3 ne = texture(u_src, v_uv + vec2( o.x, -o.y)).rgb;
    vec3 w  = texture(u_src, v_uv + vec2(-o.x,  0.0)).rgb;
    vec3 e  = texture(u_src, v_uv + vec2( o.x,  0.0)).rgb;
    vec3 sw = texture(u_src, v_uv + vec2(-o.x,  o.y)).rgb;
    vec3 s  = texture(u_src, v_uv + vec2( 0.0,  o.y)).rgb;
    vec3 se = texture(u_src, v_uv + vec2( o.x,  o.y)).rgb;
    vec3 ring = nw + n + ne + w + e + sw + s + se;
    rgb = center * (1.0 + 8.0 * u_amount) - u_amount * ring;
  } else if (u_algo == 2) {
    // Cross: four diagonal neighbors only. Enhances diagonal edges.
    vec3 nw = texture(u_src, v_uv + vec2(-o.x, -o.y)).rgb;
    vec3 ne = texture(u_src, v_uv + vec2( o.x, -o.y)).rgb;
    vec3 sw = texture(u_src, v_uv + vec2(-o.x,  o.y)).rgb;
    vec3 se = texture(u_src, v_uv + vec2( o.x,  o.y)).rgb;
    rgb = center * (1.0 + 4.0 * u_amount) - u_amount * (nw + ne + sw + se);
  } else {
    // Unsharp mask via Gaussian 3×3 (corners 1, edges 2, center 4;
    // sum 16). The closed-form sharpen kernel that comes out of
    // "image + amount * (image - blur(image))" has these weights:
    //   center = 1 + 0.75*A,  edges = -A/8,  corners = -A/16.
    vec3 nw = texture(u_src, v_uv + vec2(-o.x, -o.y)).rgb;
    vec3 n  = texture(u_src, v_uv + vec2( 0.0, -o.y)).rgb;
    vec3 ne = texture(u_src, v_uv + vec2( o.x, -o.y)).rgb;
    vec3 w  = texture(u_src, v_uv + vec2(-o.x,  0.0)).rgb;
    vec3 e  = texture(u_src, v_uv + vec2( o.x,  0.0)).rgb;
    vec3 sw = texture(u_src, v_uv + vec2(-o.x,  o.y)).rgb;
    vec3 s  = texture(u_src, v_uv + vec2( 0.0,  o.y)).rgb;
    vec3 se = texture(u_src, v_uv + vec2( o.x,  o.y)).rgb;
    float cw = 1.0 + 0.75 * u_amount;
    float ew = -u_amount / 8.0;
    float corn = -u_amount / 16.0;
    rgb = center * cw + (n + s + e + w) * ew + (nw + ne + sw + se) * corn;
  }

  outColor = vec4(rgb, c.a);
}`;

export const sharpenNode: NodeDefinition = {
  type: "sharpen",
  name: "Sharpen",
  category: "image",
  subcategory: "modifier",
  description:
    "Sharpen an image with one of four kernel shapes. Box/diamond/cross are Laplacian-style (crisp); unsharp uses a Gaussian reference for softer falloff.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "algorithm",
      label: "Algorithm",
      type: "enum",
      options: ["box", "diamond", "cross", "unsharp"],
      default: "box",
    },
    {
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 5,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const amount = (params.amount as number) ?? 1;
    const algo = (params.algorithm as string) ?? "box";
    const algoIdx =
      algo === "diamond" ? 1 : algo === "cross" ? 2 : algo === "unsharp" ? 3 : 0;

    const prog = ctx.getShader("sharpen/main", SHARPEN_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_invRes"),
        1 / src.width,
        1 / src.height
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_amount"), amount);
      gl.uniform1i(gl.getUniformLocation(prog, "u_algo"), algoIdx);
    });

    return { primary: output };
  },
};
