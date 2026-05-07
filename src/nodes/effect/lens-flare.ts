import type { NodeDefinition } from "@/engine/types";

// Lens Flare. Produces ghosts (lens-internal reflections), a halo
// ring around screen centre, and an optional anamorphic streak. The
// node OUTPUTS THE FLARE LAYER ONLY — composite it back over the
// source with a Merge (additive) so users can pre-blur or tint the
// flare layer in between if they want.
//
// Pipeline:
//   1. Threshold (soft-knee, downsample to ½) — re-extract the
//      bright pass.
//   2. Ghost pass — sample the bright pass with center-flipped UVs
//      at N decreasing scales; per-channel offsets give chromatic
//      aberration. Each ghost falls off toward the screen edges
//      so we don't get a fake "always-on" halo at the corners.
//   3. Halo pass — bright sample at a fixed offset along the line
//      from the centre to the current pixel, falloff by a thin
//      annulus mask. Adds the classic "ring" you see when the sun
//      is just out of frame.
//   4. Streak pass — 1D blur of the bright pass along a
//      configurable axis (horizontal / vertical / diagonal), with
//      a long tail and a bright core.
//   5. Composite the three layers into the output.

const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2  u_invSrc;
uniform float u_threshold;
uniform float u_softKnee;
out vec4 outColor;
vec3 brightenSample(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = max(u_softKnee * u_threshold, 1e-4);
  float t = u_threshold - knee;
  float c2 = max(knee * 2.0, 1e-4);
  float d  = 0.25 / c2;
  float rq = clamp(br - t, 0.0, c2);
  rq = (rq * rq) * d;
  float gain = max(rq, br - u_threshold) / max(br, 1e-5);
  return c * max(gain, 0.0);
}
void main() {
  vec2 o = u_invSrc;
  vec3 c0 = brightenSample(texture(u_src, v_uv + o * vec2(-0.5, -0.5)).rgb);
  vec3 c1 = brightenSample(texture(u_src, v_uv + o * vec2( 0.5, -0.5)).rgb);
  vec3 c2 = brightenSample(texture(u_src, v_uv + o * vec2(-0.5,  0.5)).rgb);
  vec3 c3 = brightenSample(texture(u_src, v_uv + o * vec2( 0.5,  0.5)).rgb);
  outColor = vec4((c0 + c1 + c2 + c3) * 0.25, 1.0);
}`;

// Combined ghost + halo. UVs centre at (0.5, 0.5); we work in
// shifted space `texCoord = v_uv - 0.5`.
//
// Ghosts: for i in [1..N], sample bright at `centre + (-direction * i * dispersal)`.
//   `direction` = (centre - v_uv); flipping the sign and stepping
//   along it places ghosts on the line through the centre on the
//   opposite side from the source highlight, which is how lens
//   flares behave.
// Each ghost is sampled per-channel with an offset to fake CA.
//
// Halo: sample bright at `centre + normalize(direction) * haloWidth`.
// Mask by a thin radial annulus so it forms a ring rather than a
// disk.
const GHOST_HALO_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_bright;
uniform int   u_numGhosts;       // 1..8
uniform float u_dispersal;       // 0..1, ghost spacing
uniform float u_distortion;      // 0..1, chromatic aberration
uniform float u_haloWidth;       // 0..1, ring radius
uniform float u_haloIntensity;   // 0..1, ring brightness
out vec4 outColor;

vec3 ghostSample(vec2 uv, float dist) {
  // Per-channel offset for chromatic aberration. Offset is along
  // the direction from centre — slightly different for R, G, B —
  // so the ghosts split into rainbow rings the way real lens
  // flares do. The dist arg makes the offset grow with how far
  // the ghost is from centre (the wider the ghost, the wider the
  // rainbow).
  vec2 dir = (vec2(0.5) - uv) * u_distortion * dist;
  float r = texture(u_bright, uv + dir * 1.0).r;
  float g = texture(u_bright, uv + dir * 0.0).g;
  float b = texture(u_bright, uv - dir * 1.0).b;
  return vec3(r, g, b);
}

float edgeFalloff(vec2 uv) {
  // Soft mask that goes to 0 near the screen edges so ghosts /
  // halos don't suddenly clip against the frame.
  vec2 d = vec2(1.0) - 2.0 * abs(uv - 0.5);
  return clamp(min(d.x, d.y), 0.0, 1.0);
}

void main() {
  vec2 ghostVec = (vec2(0.5) - v_uv) * u_dispersal;
  vec3 ghosts = vec3(0.0);
  // Start from i=1 — i=0 would just resample the source at v_uv.
  for (int i = 1; i <= 8; i++) {
    if (i > u_numGhosts) break;
    vec2 uv = fract(v_uv + ghostVec * float(i));
    float weight = pow(1.0 - distance(uv, vec2(0.5)) * 2.0, 6.0);
    weight = max(weight, 0.0);
    ghosts += ghostSample(uv, float(i)) * weight;
  }
  ghosts *= edgeFalloff(v_uv);

  // Halo ring.
  vec2 haloDir = normalize(vec2(0.5) - v_uv) * u_haloWidth;
  vec2 haloUv = v_uv + haloDir;
  float haloWeight =
    pow(1.0 - abs(distance(haloUv, vec2(0.5)) - 0.45), 12.0);
  haloWeight = max(haloWeight, 0.0);
  vec3 halo =
    ghostSample(haloUv, 1.0) * haloWeight * u_haloIntensity;
  halo *= edgeFalloff(v_uv);

  outColor = vec4(ghosts + halo, 1.0);
}`;

// 1D streak — directional blur. `u_dir` is the (sx, sy) unit step
// per tap; `u_strength` scales overall brightness. 19 taps on each
// side give a soft tail; weights are a triangular fade.
const STREAK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2  u_dir;        // unit-vector × pixel step
uniform float u_length;     // 0..1, total streak length as fraction of frame
uniform float u_strength;   // 0..1, output multiplier
out vec4 outColor;

void main() {
  // Sample 21 points along ±u_dir * length, triangular weights.
  float total = 21.0;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -10; i <= 10; i++) {
    float t = float(i) / 10.0; // -1..1
    float w = 1.0 - abs(t);
    vec2 off = u_dir * t * u_length;
    acc += texture(u_src, v_uv + off).rgb * w;
    wsum += w;
  }
  acc /= max(wsum, 1e-4);
  outColor = vec4(acc * u_strength, 1.0);
  // (suppress unused-uniform warning when total is folded out)
  outColor.a = total / total;
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_ghosts;
uniform sampler2D u_streak;
uniform vec3  u_tint;
uniform float u_intensity;
out vec4 outColor;
void main() {
  vec3 sum = texture(u_ghosts, v_uv).rgb + texture(u_streak, v_uv).rgb;
  outColor = vec4(sum * u_tint * u_intensity, 1.0);
}`;

// ------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

function streakAxisVec(name: string): [number, number] {
  switch (name) {
    case "vertical":
      return [0, 1];
    case "diagonal":
      return [Math.SQRT1_2, Math.SQRT1_2];
    case "horizontal":
    default:
      return [1, 0];
  }
}

export const lensFlareNode: NodeDefinition = {
  type: "lens-flare",
  name: "Lens Flare",
  category: "image",
  subcategory: "modifier",
  description:
    "Lens flare: chromatic ghosts + halo ring + anamorphic streak. Outputs the FLARE LAYER ONLY (transparent background) — composite back over the source with a Merge (additive) so you can pre-blur / tint between if you want.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1.5,
      step: 0.01,
      default: 0.8,
    },
    {
      name: "soft_knee",
      label: "Soft Knee",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "intensity",
      label: "Intensity",
      type: "scalar",
      min: 0,
      max: 5,
      softMax: 2,
      step: 0.01,
      default: 1.0,
    },
    {
      name: "tint",
      label: "Tint",
      type: "color",
      default: "#ffffff",
    },
    // ---- Ghosts ----
    {
      name: "num_ghosts",
      label: "Ghosts",
      type: "scalar",
      min: 0,
      max: 8,
      step: 1,
      default: 4,
    },
    {
      name: "ghost_dispersal",
      label: "Ghost Dispersal",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "chromatic_aberration",
      label: "Chromatic",
      type: "scalar",
      min: 0,
      max: 0.1,
      step: 0.001,
      default: 0.015,
    },
    // ---- Halo ----
    {
      name: "halo_width",
      label: "Halo Width",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "halo_intensity",
      label: "Halo Intensity",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 1.0,
    },
    // ---- Streak ----
    {
      name: "streak_strength",
      label: "Streak Strength",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0.6,
    },
    {
      name: "streak_length",
      label: "Streak Length",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.4,
      step: 0.01,
      default: 0.2,
    },
    {
      name: "streak_axis",
      label: "Streak Axis",
      type: "enum",
      options: ["horizontal", "vertical", "diagonal"],
      default: "horizontal",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.image;
    const output = ctx.allocImage();
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const threshold = (params.threshold as number) ?? 0.8;
    const softKnee = (params.soft_knee as number) ?? 0.4;
    const intensity = (params.intensity as number) ?? 1.0;
    const tintRgb = hexToRgb((params.tint as string) ?? "#ffffff");
    const numGhosts = Math.max(
      0,
      Math.min(8, Math.round((params.num_ghosts as number) ?? 4))
    );
    const ghostDispersal = (params.ghost_dispersal as number) ?? 0.4;
    const chromatic = (params.chromatic_aberration as number) ?? 0.015;
    const haloWidth = (params.halo_width as number) ?? 0.5;
    const haloIntensity = (params.halo_intensity as number) ?? 1.0;
    const streakStrength = (params.streak_strength as number) ?? 0.6;
    const streakLength = (params.streak_length as number) ?? 0.2;
    const streakAxis = (params.streak_axis as string) ?? "horizontal";

    // ---- Bright pass at half res ----
    const baseW = Math.max(2, Math.floor(src.width / 2));
    const baseH = Math.max(2, Math.floor(src.height / 2));
    const bright = ctx.allocImage({ width: baseW, height: baseH });
    {
      const prog = ctx.getShader("lens-flare/threshold", THRESHOLD_FS);
      ctx.drawFullscreen(prog, bright, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_invSrc"),
          1 / src.width,
          1 / src.height
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_threshold"),
          threshold
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_softKnee"),
          softKnee
        );
      });
    }

    // ---- Ghost + halo at half res ----
    const ghostsHalo = ctx.allocImage({ width: baseW, height: baseH });
    {
      const prog = ctx.getShader("lens-flare/ghosts", GHOST_HALO_FS);
      ctx.drawFullscreen(prog, ghostsHalo, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, bright.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_bright"), 0);
        gl.uniform1i(
          gl.getUniformLocation(prog, "u_numGhosts"),
          numGhosts
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_dispersal"),
          ghostDispersal
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_distortion"),
          chromatic
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_haloWidth"),
          haloWidth
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_haloIntensity"),
          haloIntensity
        );
      });
    }

    // ---- Streak (only if enabled) ----
    const streak = ctx.allocImage({ width: baseW, height: baseH });
    if (streakStrength > 0 && streakLength > 0) {
      const prog = ctx.getShader("lens-flare/streak", STREAK_FS);
      const axis = streakAxisVec(streakAxis);
      ctx.drawFullscreen(prog, streak, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, bright.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_dir"),
          axis[0],
          axis[1]
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_length"),
          streakLength
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_strength"),
          streakStrength
        );
      });
    } else {
      ctx.clearTarget(streak, [0, 0, 0, 1]);
    }

    // ---- Composite at full res ----
    {
      const prog = ctx.getShader("lens-flare/composite", COMPOSITE_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ghostsHalo.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_ghosts"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, streak.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_streak"), 1);
        gl.uniform3f(
          gl.getUniformLocation(prog, "u_tint"),
          tintRgb[0],
          tintRgb[1],
          tintRgb[2]
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_intensity"),
          intensity
        );
      });
    }

    ctx.releaseTexture(bright.texture);
    ctx.releaseTexture(ghostsHalo.texture);
    ctx.releaseTexture(streak.texture);

    return { primary: output };
  },
};
