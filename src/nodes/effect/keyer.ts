import type { NodeDefinition } from "@/engine/types";
import { hexToRgba01 } from "@/engine/spline-fill";

// Keyer — luma / color / chroma / sample keying. Computes a keep-matte
// from the input and multiplies it into the alpha channel, so keyed
// regions turn transparent and the result drops straight onto a Merge
// stack. The matte is also exposed as a `mask` aux output for driving
// other nodes.
//
// Modes:
//   luma   — matte from Rec. 709 luminance vs `threshold`. Dark pixels
//            key out by default; Invert keys out the bright side.
//   color  — matte from straight RGB distance to `key_color`. Literal
//            "remove this color" — good for flat/graphic sources.
//   chroma — distance on the CbCr plane only (luminance ignored), the
//            green-screen keyer: shadows and highlights of the backing
//            color key together instead of needing a huge tolerance.
//   sample — distance to the NEAREST of a drawn color set. The user
//            scrubs across the preview canvas (KeyerSampleOverlay in
//            the UI layer) and each distinct color under the cursor
//            lands in the hidden `sample_colors` param; pixels near ANY
//            sample key out. Nearest-of-set is what makes an irregular
//            selection work — scrubbing a backdrop's shadows and
//            highlights covers its whole range without a huge tolerance.
//
// `softness` feathers the matte edge (smoothstep window; 0 = hard cut).
// `spill` suppresses the key color bleeding on kept pixels by clamping
// the key's dominant channel to the max of the other two — the standard
// cheap despill (green vest turns gray, green rim-light disappears). In
// sample mode the despill reference is the mean of the sampled colors.

// Uniform-array capacity for sample mode; the overlay dedupes and caps
// its writes to the same bound.
export const KEYER_MAX_SAMPLES = 64;

const KEYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_src;
uniform int   u_mode;        // 0 luma, 1 color, 2 chroma, 3 sample
uniform float u_threshold;   // luma pivot
uniform float u_tolerance;   // color/chroma/sample key radius
uniform float u_softness;    // feather width past threshold/tolerance
uniform vec3  u_keyColor;
uniform float u_spill;       // 0..1 despill strength (non-luma modes)
uniform int   u_invert;
uniform vec3  u_samples[${KEYER_MAX_SAMPLES}];  // drawn color set (sample mode)
uniform int   u_sampleCount;

out vec4 outColor;

// BT.709 chroma-plane coordinates, each in [-0.5, 0.5]. Distance here
// ignores luminance, which is what makes the chroma mode hold up across
// the brightness variation of a real backing screen.
vec2 cbcr(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748);
}

// Clamp the key color's dominant channel toward the max of the other
// two. Applied uniformly (scaled by u_spill) — matte-weighted despill
// can't reach the kept edge pixels where spill actually lives.
vec3 despill(vec3 rgb) {
  if (u_keyColor.g >= u_keyColor.r && u_keyColor.g >= u_keyColor.b) {
    rgb.g = mix(rgb.g, min(rgb.g, max(rgb.r, rgb.b)), u_spill);
  } else if (u_keyColor.b >= u_keyColor.r) {
    rgb.b = mix(rgb.b, min(rgb.b, max(rgb.r, rgb.g)), u_spill);
  } else {
    rgb.r = mix(rgb.r, min(rgb.r, max(rgb.g, rgb.b)), u_spill);
  }
  return rgb;
}

void main() {
  vec4 c = texture(u_src, v_uv);

  // matte: 1 = keep, 0 = keyed out.
  float matte;
  if (u_mode == 0) {
    float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    // Symmetric window around the threshold (same convention as the
    // Threshold node) so softness doesn't bias the cut off-center.
    matte = (u_softness <= 0.0)
      ? step(u_threshold, luma)
      : smoothstep(u_threshold - u_softness * 0.5,
                   u_threshold + u_softness * 0.5, luma);
  } else {
    // sqrt(3) normalization puts RGB distances in 0..1 so tolerance
    // reads on the same scale across modes (CbCr distance tops out
    // near 1.2 for opposing hues).
    float dist;
    if (u_mode == 1) {
      dist = distance(c.rgb, u_keyColor) * 0.57735;
    } else if (u_mode == 2) {
      dist = distance(cbcr(c.rgb), cbcr(u_keyColor));
    } else {
      // sample: nearest of the drawn color set. Empty set leaves dist
      // huge, so nothing keys until the first scrub lands.
      float minD = 1e9;
      for (int i = 0; i < ${KEYER_MAX_SAMPLES}; i++) {
        if (i >= u_sampleCount) break;
        minD = min(minD, distance(c.rgb, u_samples[i]));
      }
      dist = minD * 0.57735;
    }
    // Inside tolerance = keyed; softness feathers OUTWARD from the
    // tolerance edge so tightening softness never eats into the keep.
    matte = (u_softness <= 0.0)
      ? step(u_tolerance, dist)
      : smoothstep(u_tolerance, u_tolerance + u_softness, dist);
  }
  if (u_invert == 1) matte = 1.0 - matte;

  vec3 rgb = c.rgb;
  if (u_mode != 0 && u_spill > 0.0) rgb = despill(rgb);

  // Straight alpha: matte multiplies coverage, color stays un-matted.
  outColor = vec4(rgb, c.a * matte);
}`;

// The matte aux is exactly the keyed output's alpha (matte × source
// coverage), so it's derived from the primary render instead of
// duplicating the key math.
const MATTE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_keyed;
out vec4 outColor;
void main() {
  float m = texture(u_keyed, v_uv).a;
  outColor = vec4(m, m, m, 1.0);
}`;

const usesKeyColor = (p: Record<string, unknown>) =>
  p.mode === "color" || p.mode === "chroma";
const usesTolerance = (p: Record<string, unknown>) =>
  p.mode === "color" || p.mode === "chroma" || p.mode === "sample";

export const keyerNode: NodeDefinition = {
  type: "keyer",
  name: "Keyer",
  category: "image",
  subcategory: "modifier",
  description:
    "Keys pixels transparent by luminance (luma key), RGB similarity to a key color (color key), chroma-plane similarity (chroma key — the green-screen mode, brightness-independent), or similarity to a drawn color selection (sample mode — select the node and scrub across the canvas to sample the colors to remove). Softness feathers the matte edge, Spill Suppression desaturates key-color bleed on kept pixels, and Invert swaps keep/key. The matte is also available as a mask aux output.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "mode", label: "Mode", type: "enum",
      options: ["luma", "color", "chroma", "sample"], default: "luma",
      control: "segmented",
    },
    {
      name: "threshold", label: "Threshold", type: "scalar",
      min: 0, max: 1, step: 0.001, default: 0.5,
      visibleIf: (p) => (p.mode ?? "luma") === "luma",
    },
    {
      name: "key_color", label: "Key Color", type: "color",
      default: "#00ff00", visibleIf: usesKeyColor,
    },
    {
      name: "tolerance", label: "Tolerance", type: "scalar",
      min: 0, max: 1, step: 0.001, default: 0.2,
      visibleIf: usesTolerance,
    },
    {
      name: "softness", label: "Softness", type: "scalar",
      min: 0, max: 1, softMax: 0.5, step: 0.001, default: 0.1,
    },
    {
      name: "spill", label: "Spill Suppression", type: "scalar",
      min: 0, max: 1, step: 0.001, default: 0,
      visibleIf: usesTolerance,
    },
    { name: "invert", label: "Invert", type: "boolean", default: false },
    // Sample-mode color set in hex, written by the canvas overlay
    // (KeyerSampleOverlay) and managed by the panel's swatch row. Plain
    // JSON smuggled through a string-typed param so it round-trips
    // through save/load untouched — same trick as Segment's `dots`.
    {
      name: "sample_colors",
      label: "Sampled Colors",
      type: "string",
      default: [],
      hidden: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "matte",
      type: "mask",
      description:
        "The keep-matte (white = kept, black = keyed out), weighted by the source's own alpha.",
    },
  ],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const matteOut = ctx.allocMask();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      ctx.clearTarget(matteOut, [0, 0, 0, 1]);
      return { primary: output, aux: { matte: matteOut } };
    }

    const mode = (params.mode as string) ?? "luma";
    const modeInt =
      mode === "color" ? 1 : mode === "chroma" ? 2 : mode === "sample" ? 3 : 0;
    const threshold = (params.threshold as number) ?? 0.5;
    const tolerance = (params.tolerance as number) ?? 0.2;
    const softness = Math.max(0, (params.softness as number) ?? 0.1);
    const spill = Math.max(0, Math.min(1, (params.spill as number) ?? 0));
    const invert = params.invert ? 1 : 0;
    let [kr, kg, kb] = hexToRgba01((params.key_color as string) ?? "#00ff00");

    // Sample-mode color set → flat vec3 array + count. The mean sample
    // stands in as the despill reference (u_keyColor) so Spill
    // Suppression targets whatever hue family the user scrubbed.
    const samples = (
      Array.isArray(params.sample_colors) ? params.sample_colors : []
    )
      .filter((s): s is string => typeof s === "string")
      .slice(0, KEYER_MAX_SAMPLES);
    const sampleVec = new Float32Array(samples.length * 3);
    if (mode === "sample" && samples.length > 0) {
      let mr = 0, mg = 0, mb = 0;
      for (let i = 0; i < samples.length; i++) {
        const [r, g, b] = hexToRgba01(samples[i]);
        sampleVec[i * 3] = r;
        sampleVec[i * 3 + 1] = g;
        sampleVec[i * 3 + 2] = b;
        mr += r; mg += g; mb += b;
      }
      kr = mr / samples.length;
      kg = mg / samples.length;
      kb = mb / samples.length;
    }

    const prog = ctx.getShader("keyer/main", KEYER_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), modeInt);
      gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
      gl.uniform1f(gl.getUniformLocation(prog, "u_tolerance"), tolerance);
      gl.uniform1f(gl.getUniformLocation(prog, "u_softness"), softness);
      gl.uniform3f(gl.getUniformLocation(prog, "u_keyColor"), kr, kg, kb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_spill"), spill);
      gl.uniform1i(gl.getUniformLocation(prog, "u_invert"), invert);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_sampleCount"),
        mode === "sample" ? samples.length : 0
      );
      if (mode === "sample" && sampleVec.length > 0) {
        gl.uniform3fv(gl.getUniformLocation(prog, "u_samples"), sampleVec);
      }
    });

    const matteProg = ctx.getShader("keyer/matte", MATTE_FS);
    ctx.drawFullscreen(matteProg, matteOut, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, output.texture);
      gl.uniform1i(gl.getUniformLocation(matteProg, "u_keyed"), 0);
    });

    return { primary: output, aux: { matte: matteOut } };
  },
};
