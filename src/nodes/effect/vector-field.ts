import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  SdfValue,
  SocketType,
} from "@/engine/types";
import {
  bindSdfUniforms,
  compileSdfSnippet,
  structuralHash,
} from "@/engine/sdf-compile";
import {
  VELOCITY_DECODE_GLSL,
  VELOCITY_ENCODE_GLSL,
  VELOCITY_NEUTRAL,
} from "@/engine/velocity-field";
import { getPlaceholderTex } from "@/engine/placeholder-tex";

// Vector Field — turn a scalar image or an SDF into a signed-RG velocity
// field (engine/velocity-field.ts). The missing producer for "pinch /
// wrap / isoline" warps: attract pulls toward the feature, repel pushes
// away, orbit circulates, isoline follows level sets at unit speed.
//
// SDF: analytic finite-difference of the compiled distance (same splice
// as Liquid Glass), falloff by |d| over `radius`. Attract is inward
// (−∇d); a white-on-black image attract is toward bright (+∇luma).
// Image: luminance gradient; `radius` is the FD tap so a hard mask
// still mints a soft shell (Flow Obstacle's trick). Blur the mask
// upstream for a volumetric well — a binary mask only has gradient at
// the rim.
//
// Optional `field` input sums an upstream velocity (Spline Flow Field /
// Perlin curl chain). Don't matte the output — matte the consumer.

const MODE_ATTRACT = 0;
const MODE_REPEL = 1;
const MODE_ORBIT = 2;
const MODE_ISOLINE = 3;

function modeIndex(mode: string | undefined): number {
  if (mode === "repel") return MODE_REPEL;
  if (mode === "orbit") return MODE_ORBIT;
  if (mode === "isoline") return MODE_ISOLINE;
  return MODE_ATTRACT;
}

const SHARED_GLSL = `
${VELOCITY_DECODE_GLSL}
${VELOCITY_ENCODE_GLSL}

vec2 fromNormal(vec2 n, float metric) {
  float w;
  if (u_mode == ${MODE_ISOLINE}) {
    w = metric < u_radius ? 1.0 : 0.0;
  } else {
    w = 1.0 - smoothstep(0.0, max(u_radius, 1e-5), metric);
  }
  vec2 dir;
  if (u_mode == ${MODE_ATTRACT}) dir = n * u_polarity;
  else if (u_mode == ${MODE_REPEL}) dir = n * (-u_polarity);
  else dir = vec2(-n.y, n.x) * u_polarity;
  return dir * u_strength * w * u_invert;
}
`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const VECTOR_FIELD_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform int u_hasField;
uniform int u_mode;
uniform float u_strength;
uniform float u_radius;
uniform float u_aspect;
uniform float u_polarity;
uniform float u_invert;
out vec4 outColor;
${SHARED_GLSL}

float luma(vec2 uv) {
  vec3 c = texture(u_src, uv).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  float dx = max(u_radius, 0.002);
  float dy = dx * u_aspect;
  float gx = luma(v_uv + vec2(dx, 0.0)) - luma(v_uv - vec2(dx, 0.0));
  float gyUp = luma(v_uv + vec2(0.0, dy)) - luma(v_uv - vec2(0.0, dy));
  vec2 g = vec2(gx, -gyUp);
  float len = length(g);
  vec2 v = vec2(0.0);
  if (len > 1e-6) v = fromNormal(g / len, 0.0);
  if (u_hasField == 1) v += decodeVelocity(texture(u_field, v_uv));
  outColor = encodeVelocity(v);
}
`;

export function buildVectorFieldSdfFS(
  sdfDecls: string,
  distExpr: string
): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform int u_hasField;
uniform int u_mode;
uniform float u_strength;
uniform float u_radius;
uniform float u_aspect;
uniform float u_polarity;
uniform float u_invert;
uniform vec2 u_canvasSize;
uniform float u_aspectCorrect;
out vec4 outColor;
${sdfDecls}
${SHARED_GLSL}

void main() {
  vec2 p = v_uv;
  if (u_aspectCorrect > 0.5) {
    float aspect = u_canvasSize.x / u_canvasSize.y;
    p = vec2(p.x, (p.y - 0.5) / aspect + 0.5);
  }
  vec2 p_orig = p;
  float d = ${distExpr};
  float eps = 0.002;
  p = p_orig + vec2(eps, 0.0);
  float dR = ${distExpr};
  p = p_orig - vec2(eps, 0.0);
  float dL = ${distExpr};
  p = p_orig + vec2(0.0, eps);
  float dU = ${distExpr};
  p = p_orig - vec2(0.0, eps);
  float dD = ${distExpr};
  vec2 g = vec2(dR - dL, -(dU - dD));
  float len = length(g);
  vec2 v = vec2(0.0);
  if (len > 1e-6) v = fromNormal(g / len, abs(d));
  if (u_hasField == 1) v += decodeVelocity(texture(u_field, v_uv));
  outColor = encodeVelocity(v);
}
`;
}

function bindCommon(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  params: Record<string, unknown>,
  aspect: number,
  polarity: number,
  fieldTex: WebGLTexture | null,
  dummyTex: WebGLTexture
): void {
  gl.uniform1i(
    gl.getUniformLocation(prog, "u_mode"),
    modeIndex(params.mode as string)
  );
  gl.uniform1f(
    gl.getUniformLocation(prog, "u_strength"),
    (params.strength as number) ?? 0.5
  );
  gl.uniform1f(
    gl.getUniformLocation(prog, "u_radius"),
    Math.max(0.001, (params.radius as number) ?? 0.15)
  );
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), aspect);
  gl.uniform1f(gl.getUniformLocation(prog, "u_polarity"), polarity);
  gl.uniform1f(
    gl.getUniformLocation(prog, "u_invert"),
    params.invert ? -1 : 1
  );
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fieldTex ?? dummyTex);
  gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 0);
  gl.uniform1i(
    gl.getUniformLocation(prog, "u_hasField"),
    fieldTex ? 1 : 0
  );
}

export const vectorFieldNode: NodeDefinition = {
  type: "vector-field",
  name: "Vector Field",
  category: "image",
  subcategory: "modifier",
  description:
    "Turn an image or SDF into a signed-RG velocity field (the encoding Advect Points / Advect Image / Displace / Point Expression already read). Attract pulls toward the feature (inward on an SDF, toward bright on an image); repel pushes away; orbit circulates; isoline follows level sets at unit speed. `radius` is falloff-from-surface on an SDF, and the finite-difference tap on an image (blur a mask upstream for a volumetric well — a hard edge only has gradient at the rim). Chain an upstream field through the optional `field` input to sum flows. Don't matte a field image — matte the consumer.",
  facts: {
    space: { "in:source": ["raster", "canvas01"], "param:radius": "canvas01" },
    gotchas: [
      "radius/falloff is a canvas01 width-relative, aspect-corrected distance in both modes; in SDF mode only, turning off aspect_correct makes it a uv01 per-axis fraction instead.",
      "mode=isoline uses a hard band (metric < radius) instead of the smoothstep falloff the other three modes use.",
      "field additively sums an already RG-encoded velocity field; chain upstream fields here instead of matting the output image.",
      "On an image source, radius also sets the finite-difference tap, so a hard binary mask only has gradient at its rim — blur it upstream for a volumetric well.",
      "Attract pulls inward on an SDF (−∇d) but toward brighter pixels on an image (+∇luma); repel/orbit rotate or invert that same gradient.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "source", type: "image", required: false, label: "Source" },
    { name: "field", type: "image", required: false, label: "Field (add)" },
  ],
  resolveInputs(_params, ctx): InputSocketDef[] {
    const t = ctx?.connectedTypes?.source;
    const inType: SocketType = t === "sdf" ? "sdf" : "image";
    return [
      {
        name: "source",
        type: inType,
        required: false,
        label: inType === "sdf" ? "SDF" : "Source",
      },
      { name: "field", type: "image", required: false, label: "Field (add)" },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["attract", "repel", "orbit", "isoline"],
      control: "segmented",
      default: "attract",
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: -2,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.15,
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
    {
      name: "aspect_correct",
      label: "Aspect Correct",
      type: "boolean",
      default: true,
      visibleIf: (_p, meta) =>
        meta?.inputTypes?.source === "sdf" || meta?.inputTypes?.source == null,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.source;
    const field =
      inputs.field && inputs.field.kind === "image" ? inputs.field : null;
    const fieldTex = field?.texture ?? null;
    const aspect = ctx.width / ctx.height;

    const isSdf = src && src.kind === "sdf";
    const isImage = src && src.kind === "image";

    if (!isSdf && !isImage) {
      if (field) return { primary: field };
      ctx.clearTarget(output, VELOCITY_NEUTRAL);
      return { primary: output };
    }

    const dummy = getPlaceholderTex(ctx.gl, ctx.state, "vector-field:dummy");
    if (isSdf) {
      const sdfVal = src as SdfValue;
      const snippet = compileSdfSnippet(sdfVal.root);
      const cacheKey = `vector-field/sdf/${structuralHash(sdfVal.root)}`;
      const prog = ctx.getShader(
        cacheKey,
        buildVectorFieldSdfFS(snippet.decls, snippet.distExpr)
      );
      ctx.drawFullscreen(prog, output, (gl) => {
        bindCommon(gl, prog, params, aspect, -1, fieldTex, dummy);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_canvasSize"),
          output.width,
          output.height
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_aspectCorrect"),
          ((params.aspect_correct as boolean) ?? true) ? 1 : 0
        );
        bindSdfUniforms(gl, prog, snippet.uniforms, 1);
      });
      return { primary: output };
    }

    const img = src as ImageValue;
    const prog = ctx.getShader("vector-field/image", VECTOR_FIELD_IMAGE_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      bindCommon(gl, prog, params, aspect, 1, fieldTex, dummy);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, img.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 1);
    });
    return { primary: output };
  },
};
