import type {
  ImageValue,
  MaskValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { computeSDF } from "@/engine/sdf";

// Bevel & Emboss — synthesizes a fake-3D raised-edge look from a
// height field derived from the input image. Four styles cover the
// classic Photoshop layer-style spread:
//
//   outer-bevel : bevel rises OUTSIDE the alpha edge (puffed-up
//                 stamp around the shape)
//   inner-bevel : bevel rises INSIDE the alpha edge (lip on the
//                 shape itself — most common for buttons)
//   emboss      : the input's luminance IS the height field —
//                 no JFA, fast, gives a relief-engraving look
//   pillow-emboss : ramps in both directions from the alpha edge
//                 (stitched-fabric / quilted look)
//
// Two lights — each contributes a highlight on its lit side and a
// shadow on its unlit side. Sharing the highlight/shadow colors and
// blend modes keeps the param surface manageable; per-light angle,
// elevation, and opacity give plenty of look variation.
//
// JFA caching: outer/inner/pillow need a signed-distance height
// field, computed via the existing engine/sdf.ts JFA helper. The
// result is cached by source ImageValue identity so static-image
// inputs only JFA once. Animated inputs (video, generative noise)
// pay the JFA cost per frame.

const STYLES = ["outer-bevel", "inner-bevel", "emboss", "pillow-emboss"] as const;

const HIGHLIGHT_BLENDS = ["screen", "add", "linear-dodge", "normal"] as const;
const SHADOW_BLENDS = ["multiply", "linear-burn", "color-burn", "normal"] as const;

function styleToInt(s: string): number {
  switch (s) {
    case "outer-bevel":
      return 0;
    case "inner-bevel":
      return 1;
    case "emboss":
      return 2;
    case "pillow-emboss":
      return 3;
    default:
      return 1;
  }
}

function highlightBlendToInt(s: string): number {
  switch (s) {
    case "screen":
      return 0;
    case "add":
    case "linear-dodge":
      return 1;
    case "normal":
      return 2;
    default:
      return 0;
  }
}

function shadowBlendToInt(s: string): number {
  switch (s) {
    case "multiply":
      return 0;
    case "linear-burn":
      return 1;
    case "color-burn":
      return 2;
    case "normal":
      return 3;
    default:
      return 0;
  }
}

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

// JFA-derived signed distance for outer/inner/pillow. The JFA helper
// returns a MaskValue whose R channel encodes signed distance as
// `0.5 + 0.5 * (signed / range)` clamped — same convention the Text
// node and SDF From Image use. We need a generous range so the bevel
// at full Depth has room; 192 px lets Depth slide up to ~190 before
// the field clamps.
const JFA_RANGE_PX = 192;

interface BevelState {
  // Cached JFA result. Invalidated when the input ImageValue object
  // identity changes (the engine evaluator allocates a fresh
  // ImageValue every time the upstream source recomputes).
  jfa?: MaskValue;
  jfaSource?: ImageValue;
}

function ensureState(ctx: RenderContext, nodeId: string): BevelState {
  const key = `bevel-emboss:${nodeId}`;
  let s = ctx.state[key] as BevelState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_src;
uniform sampler2D u_height;
// 0 = derive height from src luminance (emboss); 1 = derive from
// the JFA distance map bound to u_height (outer/inner/pillow).
uniform int u_heightFromJfa;
uniform int u_style;
uniform vec2 u_pixelSize;
uniform float u_depth;       // px
uniform float u_soften;      // px (multiplier on the central-diff step)
uniform float u_feather;     // px (blur radius applied to the height field)

uniform vec3 u_l1Dir;        // unit vector in (x, y, z) — z = up out of page
uniform float u_l1HiOp;
uniform float u_l1ShOp;
uniform vec3 u_l2Dir;
uniform float u_l2HiOp;
uniform float u_l2ShOp;

uniform vec3 u_hiColor;
uniform vec3 u_shColor;
uniform int u_hiBlend;
uniform int u_shBlend;

// JFA range (in canvas-UV units) for converting the encoded distance
// back to a real signed value. Matches JFA_RANGE_PX / max(canvas dim).
uniform float u_jfaRange;

out vec4 outColor;

float decodeJfaSigned(vec2 uv) {
  // R channel: [0, 1] with 0.5 = boundary. computeSDF writes the field in
  // the SAME orientation as the source image (both sampled and written at
  // v_uv), so we sample straight here — NO Y flip. (A previous flip mirrored
  // the height field vertically against the shape, so the bevel landed on
  // the wrong edges for any non-symmetric input.)
  float r = texture(u_height, uv).r;
  return (r - 0.5) * 2.0 * u_jfaRange;
}

float heightAt(vec2 uv) {
  if (u_heightFromJfa == 0) {
    // Emboss: luminance of the source image (alpha-weighted so
    // transparent areas don't show ghost relief).
    vec4 c = texture(u_height, uv);
    return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
  }
  // d in canvas-UV units. Negative inside the alpha; positive
  // outside.
  float d = decodeJfaSigned(uv);
  // depth slider is in pixels — convert to canvas-UV units via
  // pixelSize (= 1 / dim). Use min component so non-square canvases
  // still feel right.
  float depthN = u_depth * min(u_pixelSize.x, u_pixelSize.y);
  if (depthN < 1e-6) depthN = 1e-6;
  if (u_style == 0) {
    // Outer Bevel: full inside; ramps down 1 → 0 from boundary out
    // to depth.
    if (d <= 0.0) return 1.0;
    return 1.0 - smoothstep(0.0, depthN, d);
  } else if (u_style == 1) {
    // Inner Bevel: 0 outside; ramps up 0 → 1 from boundary in.
    if (d >= 0.0) return 0.0;
    return smoothstep(0.0, depthN, -d);
  } else if (u_style == 3) {
    // Pillow Emboss: rises in both directions from the boundary.
    return 1.0 - smoothstep(0.0, depthN, abs(d));
  }
  // Style 2 (emboss) handled above; defensive fallthrough.
  return 0.0;
}

// Height sampled through a small Gaussian blur whose radius is the Feather
// param (px). Where Soften widens the slope stencil (a wider, but still
// hard-shouldered, bevel), Feather rounds the height field itself so the
// relief eases in and falls away smoothly — the difference between a thicker
// bevel and one that melts into the surface. Emboss gets a soft, creamy
// relief from it. A 3x3 (1-2-1) kernel spanning ±feather/2 px; skipped
// entirely when Feather is off so the common case stays single-tap.
float heightFeathered(vec2 uv) {
  if (u_feather < 0.5) return heightAt(uv);
  vec2 r = u_pixelSize * u_feather * 0.5;
  float s = 0.0;
  s += heightAt(uv + vec2(-r.x, -r.y)) * 1.0;
  s += heightAt(uv + vec2( 0.0, -r.y)) * 2.0;
  s += heightAt(uv + vec2( r.x, -r.y)) * 1.0;
  s += heightAt(uv + vec2(-r.x,  0.0)) * 2.0;
  s += heightAt(uv)                    * 4.0;
  s += heightAt(uv + vec2( r.x,  0.0)) * 2.0;
  s += heightAt(uv + vec2(-r.x,  r.y)) * 1.0;
  s += heightAt(uv + vec2( 0.0,  r.y)) * 2.0;
  s += heightAt(uv + vec2( r.x,  r.y)) * 1.0;
  return s / 16.0;
}

vec3 normalAt(vec2 uv) {
  // Step grows with the Soften param — a wider stencil softens the
  // normal (highlights spread over more pixels).
  vec2 step = u_pixelSize * (1.0 + u_soften * 0.5);
  float hL = heightFeathered(uv - vec2(step.x, 0.0));
  float hR = heightFeathered(uv + vec2(step.x, 0.0));
  float hD = heightFeathered(uv - vec2(0.0, step.y));
  float hU = heightFeathered(uv + vec2(0.0, step.y));
  // Central-difference gradient of the height field in y-up sample space.
  // The outward-facing surface normal is the NEGATIVE gradient, so x uses
  // (left - right) and y uses (down - up) — they must share sign convention
  // or the relief is lit from opposite vertical/horizontal directions.
  float gx = (hL - hR) / (2.0 * step.x);
  float gy = (hD - hU) / (2.0 * step.y);
  // Normalize the in-plane slope by Depth so Depth controls bevel WIDTH
  // (how far the ramp reaches) while the face angle stays consistent —
  // previously a larger Depth gave a flatter, weaker bevel. For Emboss
  // (raw-luminance height) the same factor lets Depth act as relief
  // strength. z = 1 is the apparent surface height.
  float reliefScale = max(u_depth * min(u_pixelSize.x, u_pixelSize.y), 1e-6);
  vec3 n = vec3(gx * reliefScale, gy * reliefScale, 1.0);
  return normalize(n);
}

vec3 hiBlend(vec3 base, vec3 layer, float a) {
  if (u_hiBlend == 0) {
    // Screen
    return mix(base, vec3(1.0) - (vec3(1.0) - base) * (vec3(1.0) - layer), a);
  } else if (u_hiBlend == 1) {
    // Add / Linear Dodge
    return mix(base, min(base + layer, vec3(1.0)), a);
  }
  // Normal
  return mix(base, layer, a);
}

vec3 shBlend(vec3 base, vec3 layer, float a) {
  if (u_shBlend == 0) {
    // Multiply
    return mix(base, base * layer, a);
  } else if (u_shBlend == 1) {
    // Linear Burn
    return mix(base, max(base + layer - vec3(1.0), vec3(0.0)), a);
  } else if (u_shBlend == 2) {
    // Color Burn (clamped)
    vec3 cb = vec3(1.0) - clamp((vec3(1.0) - base) / max(layer, vec3(1e-3)), 0.0, 1.0);
    return mix(base, cb, a);
  }
  // Normal
  return mix(base, layer, a);
}

void applyLight(inout vec3 col, vec3 n, vec3 lightDir, float hiOp, float shOp) {
  // diff > 0 → surface tilts toward the light (highlight side).
  // diff < 0 → surface tilts away (shadow side).
  float diff = dot(n, normalize(lightDir));
  if (diff > 0.0) {
    col = hiBlend(col, u_hiColor, hiOp * diff);
  } else if (diff < 0.0) {
    col = shBlend(col, u_shColor, shOp * (-diff));
  }
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 n = normalAt(v_uv);

  float outA = src.a;
  vec3 base = src.rgb;

  // Outer Bevel and Pillow Emboss raise relief OUTSIDE the source alpha.
  // If we just copy src.a the rim falls on transparent pixels and the whole
  // effect is invisible — so widen alpha across the outer band (matching the
  // height falloff) and light a neutral, premultiplied-to-black base there so
  // the rim is predictable regardless of upstream RGB in clear pixels.
  if (u_heightFromJfa == 1 && (u_style == 0 || u_style == 3)) {
    float d = decodeJfaSigned(v_uv);
    if (d > 0.0) {
      float depthN = max(u_depth * min(u_pixelSize.x, u_pixelSize.y), 1e-6);
      float band = 1.0 - smoothstep(0.0, depthN, d);
      base = src.rgb * src.a;
      outA = max(outA, band);
    }
  }

  vec3 col = base;
  applyLight(col, n, u_l1Dir, u_l1HiOp, u_l1ShOp);
  applyLight(col, n, u_l2Dir, u_l2HiOp, u_l2ShOp);
  outColor = vec4(col, outA);
}`;

function lightDirection(angleDeg: number, elevDeg: number): [number, number, number] {
  const az = (angleDeg * Math.PI) / 180;
  const el = (elevDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [Math.cos(az) * ce, Math.sin(az) * ce, Math.sin(el)];
}

export const bevelEmbossNode: NodeDefinition = {
  type: "bevel-emboss",
  name: "Bevel & Emboss",
  category: "image",
  subcategory: "modifier",
  description:
    "Bevel & Emboss — fake-3D raised edge from a height source. Outer / Inner / Emboss / Pillow Emboss styles. Two lights (each with angle, elevation, opacity) shade the height field with shared highlight + shadow colors and blend modes. Outer/Inner/Pillow use a JFA-derived signed-distance height (cached per input image); Emboss uses the input's luminance directly.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    {
      name: "height",
      type: "image",
      required: false,
      label: "Height (override)",
    },
  ],
  params: [
    {
      name: "style",
      label: "Style",
      type: "enum",
      options: STYLES as unknown as string[],
      default: "inner-bevel",
    },
    {
      name: "depth",
      label: "Depth (px)",
      type: "scalar",
      min: 0,
      max: 192,
      softMax: 64,
      step: 0.5,
      default: 16,
    },
    {
      name: "soften",
      label: "Soften (px)",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 8,
      step: 0.1,
      default: 1,
    },
    {
      name: "feather",
      label: "Feather (px)",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.1,
      default: 0,
    },

    // Light 1
    {
      name: "l1_angle",
      label: "Light 1 Angle (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 135,
    },
    {
      name: "l1_elevation",
      label: "Light 1 Elevation (°)",
      type: "scalar",
      min: 0,
      max: 90,
      step: 0.5,
      default: 30,
    },
    {
      name: "l1_hi_op",
      label: "Light 1 Highlight",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "l1_sh_op",
      label: "Light 1 Shadow",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0.75,
    },

    // Light 2
    {
      name: "l2_angle",
      label: "Light 2 Angle (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: -45,
    },
    {
      name: "l2_elevation",
      label: "Light 2 Elevation (°)",
      type: "scalar",
      min: 0,
      max: 90,
      step: 0.5,
      default: 60,
    },
    {
      name: "l2_hi_op",
      label: "Light 2 Highlight",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "l2_sh_op",
      label: "Light 2 Shadow",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0,
    },

    // Shared shading
    {
      name: "highlight_color",
      label: "Highlight Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "shadow_color",
      label: "Shadow Color",
      type: "color",
      default: "#000000",
    },
    {
      name: "highlight_blend",
      label: "Highlight Blend",
      type: "enum",
      options: HIGHLIGHT_BLENDS as unknown as string[],
      default: "screen",
    },
    {
      name: "shadow_blend",
      label: "Shadow Blend",
      type: "enum",
      options: SHADOW_BLENDS as unknown as string[],
      default: "multiply",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const styleStr = (params.style as string) ?? "inner-bevel";
    const styleId = styleToInt(styleStr);
    const needsJfa = styleId !== 2; // emboss is the only style that doesn't.

    const state = ensureState(ctx, nodeId);

    // Pick the height source. If the user wired a custom height
    // image, prefer that and JFA *its* alpha. Otherwise JFA the
    // src alpha. For emboss we don't JFA — we sample the image's
    // luminance directly.
    const heightSrc =
      inputs.height && inputs.height.kind === "image"
        ? (inputs.height as ImageValue)
        : src;

    let heightTex = heightSrc.texture;
    let heightFromJfa = 0;
    let jfaRange = 1;
    if (needsJfa) {
      // Cache by source identity. Texture from a re-rendered upstream
      // is a new ImageValue object, so identity comparison invalidates
      // exactly when the source changed.
      if (!state.jfa || state.jfaSource !== heightSrc) {
        if (state.jfa) ctx.releaseTexture(state.jfa.texture);
        state.jfa = computeSDF(ctx, heightSrc, JFA_RANGE_PX);
        state.jfaSource = heightSrc;
      }
      heightTex = state.jfa.texture;
      heightFromJfa = 1;
      jfaRange = JFA_RANGE_PX / Math.max(heightSrc.width, heightSrc.height);
    } else {
      // Emboss path: drop any cached JFA so we don't pin its texture
      // when the user toggles style.
      if (state.jfa) {
        ctx.releaseTexture(state.jfa.texture);
        state.jfa = undefined;
        state.jfaSource = undefined;
      }
    }

    const depth = (params.depth as number) ?? 16;
    const soften = (params.soften as number) ?? 1;
    const feather = (params.feather as number) ?? 0;

    const l1Dir = lightDirection(
      (params.l1_angle as number) ?? 135,
      (params.l1_elevation as number) ?? 30
    );
    const l2Dir = lightDirection(
      (params.l2_angle as number) ?? -45,
      (params.l2_elevation as number) ?? 60
    );

    const [hr, hg, hb] = hexToRgb((params.highlight_color as string) ?? "#ffffff");
    const [sr, sg, sb] = hexToRgb((params.shadow_color as string) ?? "#000000");
    const hiBlendId = highlightBlendToInt(
      (params.highlight_blend as string) ?? "screen"
    );
    const shBlendId = shadowBlendToInt(
      (params.shadow_blend as string) ?? "multiply"
    );

    const prog = ctx.getShader("bevel-emboss/main", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_height"), 1);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_heightFromJfa"),
        heightFromJfa
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_jfaRange"), jfaRange);

      gl.uniform1i(gl.getUniformLocation(prog, "u_style"), styleId);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_pixelSize"),
        1 / output.width,
        1 / output.height
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_depth"), depth);
      gl.uniform1f(gl.getUniformLocation(prog, "u_soften"), soften);
      gl.uniform1f(gl.getUniformLocation(prog, "u_feather"), feather);

      gl.uniform3f(
        gl.getUniformLocation(prog, "u_l1Dir"),
        l1Dir[0],
        l1Dir[1],
        l1Dir[2]
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_l1HiOp"),
        (params.l1_hi_op as number) ?? 1
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_l1ShOp"),
        (params.l1_sh_op as number) ?? 0.75
      );
      gl.uniform3f(
        gl.getUniformLocation(prog, "u_l2Dir"),
        l2Dir[0],
        l2Dir[1],
        l2Dir[2]
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_l2HiOp"),
        (params.l2_hi_op as number) ?? 0
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_l2ShOp"),
        (params.l2_sh_op as number) ?? 0
      );

      gl.uniform3f(gl.getUniformLocation(prog, "u_hiColor"), hr, hg, hb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_shColor"), sr, sg, sb);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hiBlend"), hiBlendId);
      gl.uniform1i(gl.getUniformLocation(prog, "u_shBlend"), shBlendId);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = `bevel-emboss:${nodeId}`;
    const state = ctx.state[key] as BevelState | undefined;
    if (state?.jfa) ctx.releaseTexture(state.jfa.texture);
    delete ctx.state[key];
  },
};
