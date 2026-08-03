import type { NodeDefinition, SplineValue } from "@/engine/types";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";
import {
  VELOCITY_DECODE_GLSL,
  VELOCITY_ENCODE_GLSL,
  VELOCITY_NEUTRAL,
} from "@/engine/velocity-field";

// Spline Flow Field — draw a curve, get a divergence-free velocity field
// that follows it. The control-curve flow-authoring primitive (spec
// 072526_flow-fields.md): wire the output into Advect Image / Advect
// Points (field mode "vector") / Displace and content streams along the
// drawn path.
//
// Method: a ribbon of regularized VORTEX DIPOLES along the curve. Each
// arc-length sample places a counter-rotating vortex pair straddling the
// curve at ±width along the normal — between the pair, flow runs along
// the tangent; far away the dipole decays like 1/r², so influence stays
// local (no 2D-Stokeslet log growth). A sum of point vortices is the curl
// of a scalar potential, so the field is divergence-free by construction
// (no sinks or sources — mass-conserving-looking motion for free).
// "Orbit" mode drops the pairing and keeps single same-sign vortices, so
// flow circulates AROUND the whole stroke like a vortex filament.
//
// Space: everything is computed in isotropic Y-DOWN canvas-width units
// (X = x, Y = y/aspect) per the velocity-field convention, so the flow
// pattern stays round on non-square canvases. Sample positions/tangents
// come from arc-length-uniform sampleSplineAt over the concatenated
// subpaths; per-sample circulation is strength-normalized so a long
// straight run moves at ≈ `strength` regardless of the sample count.
// (Arc lengths are measured in normalized anisotropic space — on extreme
// aspect ratios the per-sample weighting is approximate; the field stays
// exactly divergence-free either way.)
//
// The optional `field` input is the composition seam: an upstream field
// (Perlin curl, another Spline Flow Field) is decoded, summed with this
// curve's contribution, and re-encoded — chain nodes to build one flow.

const MAX_SAMPLES = 96;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec4 u_samples[${MAX_SAMPLES}]; // xy = pos (isotropic y-down), zw = tangent * ds
uniform int u_count;
uniform int u_mode;      // 0 = along, 1 = orbit
uniform float u_gain;    // signed strength / normalization
uniform float u_width;   // dipole half-separation (canvas-width units)
uniform float u_eps2;    // regularization ε²
uniform float u_aspect;  // canvas width / height
uniform sampler2D u_field;
uniform int u_hasField;
out vec4 outColor;
${VELOCITY_DECODE_GLSL}
${VELOCITY_ENCODE_GLSL}

vec2 rot90(vec2 r) { return vec2(-r.y, r.x); }

void main() {
  // Pixel position in isotropic Y-DOWN canvas-width units.
  vec2 P = vec2(v_uv.x, (1.0 - v_uv.y) / u_aspect);
  vec2 v = u_hasField == 1 ? decodeVelocity(texture(u_field, v_uv)) : vec2(0.0);
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (i >= u_count) break;
    vec4 s = u_samples[i];
    vec2 tw = s.zw;               // unit tangent * ds
    float ds = length(tw);
    if (ds < 1e-8) continue;
    if (u_mode == 0) {
      // Dipole pair at C ± width * n. With n = rot90(t̂), positive gain
      // drives flow along +t̂ between the pair (see spec derivation).
      vec2 n = rot90(tw) / ds;
      vec2 rA = P - (s.xy + u_width * n);
      vec2 rB = P - (s.xy - u_width * n);
      v += (u_gain * ds) *
        (rot90(rA) / (dot(rA, rA) + u_eps2) -
         rot90(rB) / (dot(rB, rB) + u_eps2));
    } else {
      // Single vortex — circulation around the stroke.
      vec2 r = P - s.xy;
      v += (u_gain * ds) * rot90(r) / (dot(r, r) + u_eps2);
    }
  }
  outColor = encodeVelocity(v);
}`;

export const splineFlowFieldNode: NodeDefinition = {
  type: "spline-flow-field",
  name: "Spline Flow Field",
  category: "spline",
  subcategory: "modifier",
  description:
    "Turn a drawn spline into a divergence-free velocity field (encoded as a signed-RG image, midlevel 0.5): content wired through Advect Image / Advect Points (field mode `vector`) / Displace streams along the curve. `along` mode flows down the path's direction inside a ribbon of `width`; `orbit` circulates around the whole stroke like a vortex filament. Negative strength reverses the flow. Chain fields through the optional `field` input (e.g. Perlin Noise curl for ambient turbulence + this for direction) — contributions sum into one flow. The field has no sources or sinks by construction, so advected content swirls instead of piling up.",
  backend: "webgl2",
  inputs: [
    { name: "spline", type: "spline", required: true },
    { name: "field", label: "Field (add)", type: "image", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["along", "orbit"],
      control: "segmented",
      default: "along",
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
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0.005,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0.06,
    },
    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0.05,
      max: 2,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "samples",
      label: "Samples",
      type: "scalar",
      min: 8,
      max: MAX_SAMPLES,
      step: 1,
      default: 48,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const spline = inputs.spline as SplineValue | undefined;
    const base = inputs.field;
    const baseTex = base && base.kind === "image" ? base.texture : null;
    const aspect = ctx.width / ctx.height;

    const strength = (params.strength as number) ?? 0.5;
    const width = Math.max(0.005, (params.width as number) ?? 0.06);
    const softness = (params.softness as number) ?? 0.5;
    const mode = ((params.mode as string) ?? "along") === "orbit" ? 1 : 0;
    const count = Math.max(
      8,
      Math.min(MAX_SAMPLES, Math.round((params.samples as number) ?? 48))
    );

    // Sample the spline arc-length-uniformly into the uniform array.
    const data = new Float32Array(MAX_SAMPLES * 4);
    let used = 0;
    if (spline && spline.kind === "spline" && spline.subpaths.length > 0) {
      const lengths = measureSpline(spline);
      if (lengths.total > 1e-6) {
        const ds = lengths.total / count;
        for (let i = 0; i < count; i++) {
          const s = sampleSplineAt(spline, lengths, (i + 0.5) / count);
          // Isotropic y-down space: Y = y / aspect. Tangent directions map
          // through the same scale, then renormalize.
          let tx = s.tangent[0];
          let ty = s.tangent[1] / aspect;
          const tl = Math.hypot(tx, ty);
          if (tl < 1e-8) continue;
          tx /= tl;
          ty /= tl;
          const j = used * 4;
          data[j] = s.pos[0];
          data[j + 1] = s.pos[1] / aspect;
          data[j + 2] = tx * ds;
          data[j + 3] = ty * ds;
          used++;
        }
      }
    }

    if (used === 0 && !baseTex) {
      ctx.clearTarget(output, VELOCITY_NEUTRAL);
      return { primary: output };
    }

    // Normalize so a long straight run advects at ≈ strength at the curve.
    // Along: continuous dipole sheet gives speed 2πγ at the center-line;
    // orbit: vortex sheet gives ≈ πγ beside it (γ = circulation density).
    const gain = mode === 0 ? strength / (2 * Math.PI) : strength / Math.PI;
    const eps = Math.max(1e-3, softness * width);

    const prog = ctx.getShader("spline-flow-field/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform4fv(gl.getUniformLocation(prog, "u_samples[0]"), data);
      gl.uniform1i(gl.getUniformLocation(prog, "u_count"), used);
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      gl.uniform1f(gl.getUniformLocation(prog, "u_gain"), gain);
      gl.uniform1f(gl.getUniformLocation(prog, "u_width"), width);
      gl.uniform1f(gl.getUniformLocation(prog, "u_eps2"), eps * eps);
      gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), aspect);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, baseTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasField"), baseTex ? 1 : 0);
    });

    return { primary: output };
  },
};
