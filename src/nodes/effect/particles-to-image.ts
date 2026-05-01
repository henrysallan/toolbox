import type { ImageValue, NodeDefinition, RenderContext } from "@/engine/types";

// Render a particles socket to an image as point sprites. Each pixel of
// the simulator's position texture becomes one point — `gl_VertexID`
// indexes into the texture via texelFetch in the vertex shader, so we
// draw `count` points with no attribute buffers (saves a per-frame
// upload of ~64k floats).
//
// Dead particles (age == 0 || age >= lifetime) collapse to gl_PointSize
// = 0 so they don't paint. Color, size, and opacity are uniform across
// all live particles for v1; per-particle color from velocity / age is a
// small follow-up (one extra varying).

const VS = `#version 300 es
precision highp float;
uniform sampler2D u_pos;
uniform vec2 u_texSize;
uniform float u_pointSize;

out float v_alive;
out float v_lifeFrac;

void main() {
  int idx = gl_VertexID;
  int w = int(u_texSize.x);
  int x = idx - (idx / w) * w;
  int y = idx / w;
  vec4 pState = texelFetch(u_pos, ivec2(x, y), 0);
  vec2 pos = pState.xy;
  float age = pState.z;
  float lifetime = pState.w;
  bool alive = age > 0.0 && age < lifetime && lifetime > 0.0;
  v_alive = alive ? 1.0 : 0.0;
  v_lifeFrac = lifetime > 0.0 ? clamp(age / lifetime, 0.0, 1.0) : 0.0;

  // Canvas-UV (Y-DOWN) → clip-space. The engine renders to RGBA16F
  // framebuffers whose pixel (0,0) is bottom-left; flipping y here
  // matches the convention every other source uses.
  vec2 clip = pos * 2.0 - 1.0;
  clip.y = -clip.y;

  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = alive ? max(1.0, u_pointSize) : 0.0;
}
`;

const FS = `#version 300 es
precision highp float;
in float v_alive;
in float v_lifeFrac;
uniform vec4 u_color;
uniform float u_opacity;
uniform int u_fadeOut;
out vec4 outColor;
void main() {
  if (v_alive < 0.5) discard;
  // Soft round point: dist from center in [0..1].
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float falloff = smoothstep(1.0, 0.6, r);
  float a = u_color.a * u_opacity * falloff;
  if (u_fadeOut == 1) {
    a *= (1.0 - v_lifeFrac);
  }
  outColor = vec4(u_color.rgb * a, a);
}
`;

interface ProgramCache {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
}

const PROGRAM_KEY = "__particles_to_image_program__";

function getProgram(ctx: RenderContext): ProgramCache {
  const existing = ctx.state[PROGRAM_KEY] as ProgramCache | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, VS);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error(
      `particles-to-image VS compile failed: ${gl.getShaderInfoLog(vs)}`
    );
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, FS);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error(
      `particles-to-image FS compile failed: ${gl.getShaderInfoLog(fs)}`
    );
  }
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      `particles-to-image link failed: ${gl.getProgramInfoLog(program)}`
    );
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  // Empty VAO — we draw with gl_VertexID, no attribute buffers.
  const vao = gl.createVertexArray()!;
  const cache: ProgramCache = { program, vao };
  ctx.state[PROGRAM_KEY] = cache;
  return cache;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export const particlesToImageNode: NodeDefinition = {
  type: "particles-to-image",
  name: "Particles to Image",
  category: "effect",
  description:
    "Render a particles socket as point sprites onto an image. Each particle becomes a soft-edged dot; size, color, and blend mode are uniform.",
  backend: "webgl2",
  // The particles input is unstable (the simulator advances every
  // frame); this node has no internal state of its own but its output
  // depends on the particle textures, so it should re-render every
  // frame too.
  stable: false,
  inputs: [
    { name: "particles", type: "particles", required: true },
    // Optional background — particles composite over it. Without one,
    // particles render onto a transparent black canvas.
    { name: "background", type: "image", required: false },
  ],
  params: [
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "opacity",
      label: "Opacity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "pointSize",
      label: "Point size",
      type: "scalar",
      min: 1,
      max: 64,
      step: 0.5,
      default: 4,
    },
    {
      name: "blendMode",
      label: "Blend",
      type: "enum",
      options: ["additive", "alpha"],
      default: "additive",
    },
    {
      name: "fadeOut",
      label: "Fade with age",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  fingerprintExtras(_params, ctx) {
    // Particle textures change every frame; force re-eval each tick.
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx }) {
    const particles = inputs.particles;
    if (!particles || particles.kind !== "particles") {
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    const bg = inputs.background;
    const out = ctx.allocImage();

    const gl = ctx.gl;
    const { program, vao } = getProgram(ctx);

    // Composite background first (if any) so particles overlay it.
    if (bg && bg.kind === "image") {
      // Use the engine's blit helper. allocImage clears nothing; we
      // need to copy bg into out as the starting canvas state.
      const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;
      const copyProg = ctx.getShader("particles-to-image/copy", COPY_FS);
      ctx.drawFullscreen(copyProg, out, (gl2) => {
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, bg.texture);
        gl2.uniform1i(gl2.getUniformLocation(copyProg, "u_src"), 0);
      });
    } else {
      ctx.clearTarget(out, [0, 0, 0, 0]);
    }

    // Now draw points additively (or alpha-blended) on top.
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      out.texture,
      0
    );
    gl.viewport(0, 0, out.width, out.height);
    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, particles.positionTex);
    gl.uniform1i(gl.getUniformLocation(program, "u_pos"), 0);
    gl.uniform2f(
      gl.getUniformLocation(program, "u_texSize"),
      particles.width,
      particles.height
    );
    gl.uniform1f(
      gl.getUniformLocation(program, "u_pointSize"),
      (params.pointSize as number) ?? 4
    );

    const colorHex = (params.color as string) ?? "#ffffff";
    const [r, g, b] = hexToRgb(colorHex);
    gl.uniform4f(gl.getUniformLocation(program, "u_color"), r, g, b, 1);
    gl.uniform1f(
      gl.getUniformLocation(program, "u_opacity"),
      (params.opacity as number) ?? 1
    );
    gl.uniform1i(
      gl.getUniformLocation(program, "u_fadeOut"),
      params.fadeOut ? 1 : 0
    );

    const additive = ((params.blendMode as string) ?? "additive") === "additive";
    gl.enable(gl.BLEND);
    if (additive) {
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.drawArrays(gl.POINTS, 0, particles.count);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const result: ImageValue = out;
    return { primary: result };
  },
};
