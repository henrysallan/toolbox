import type {
  ImageValue,
  MaskValue,
  NodeDefinition,
  PositionNode,
  PositionValue,
  RenderContext,
  SdfValue,
} from "@/engine/types";
import { computeSDF } from "@/engine/sdf";

// Image → SDF. Turns a raster image into a signed distance field that
// composes with the rest of the SDF graph (Union, Morph, Round, Smooth
// Union, Rasterize, …).
//
// Two modes:
//  • Distance (JFA) — threshold the chosen channel into a binary mask,
//    then run the jump-flooding distance transform (engine/sdf.ts) to get
//    a true signed field (inside negative). The field ramps over `Spread`
//    pixels; beyond that it clamps, so pick a spread wide enough for the
//    biggest downstream Offset / Smooth-Union you intend.
//  • Raw — the image already encodes a distance field (0.5 = boundary),
//    e.g. a baked SDF or the output of SDF → Distance. Skip the transform
//    and sample the channel straight through, scaled by `Range`.
//
// computeSDF reads "inside" from the source ALPHA, so the Distance pre-
// pass writes the mask into the alpha channel. The resulting normalized
// distance texture is sampled by the `sdfFromImage` compiler kind, which
// un-normalizes (R-0.5)*2*range back to canvas-UV signed distance.
//
// The distance texture is held in node state (released + replaced each
// eval) so it stays valid for the downstream Rasterize within the frame —
// the same lifetime contract SDF Spline / Text use.

const CHANNEL_INDEX: Record<string, number> = {
  luminance: 0,
  alpha: 1,
  red: 2,
  green: 3,
  blue: 4,
};

// Build a binary mask (carried in ALL channels incl. alpha, since
// computeSDF tests alpha) from the selected channel + threshold.
const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
uniform float u_invert;
uniform int u_channel;
out vec4 outColor;
float pick(vec4 c) {
  if (u_channel == 1) return c.a;
  if (u_channel == 2) return c.r;
  if (u_channel == 3) return c.g;
  if (u_channel == 4) return c.b;
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  // Flip Y: pipeline images are row-0-bottom, but the sdfFromImage
  // compiler kind re-flips on sample (it was tuned for Text's row-0-top
  // canvas raster). Pre-flipping here cancels that so the field stays
  // upright relative to the source image.
  float v = pick(texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y)));
  float inside = step(u_threshold, v);
  if (u_invert > 0.5) inside = 1.0 - inside;
  outColor = vec4(inside, inside, inside, inside);
}`;

// Raw mode: copy the chosen channel into R (where sdfFromImage samples)
// without any transform — the image is assumed to already be a distance
// field with 0.5 at the boundary.
const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_channel;
out vec4 outColor;
float pick(vec4 c) {
  if (u_channel == 1) return c.a;
  if (u_channel == 2) return c.r;
  if (u_channel == 3) return c.g;
  if (u_channel == 4) return c.b;
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  // Y-flip to match the sdfFromImage sampler's re-flip (see threshold
  // shader) so the raw field overlays the source image upright.
  outColor = vec4(pick(texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y))), 0.0, 0.0, 1.0);
}`;

interface FromImageState {
  // The current distance texture (pooled, owned-by-reference: released
  // before each recompute and on dispose).
  sdf?: MaskValue;
  // Cache identity: upstream re-renders hand us a NEW ImageValue object
  // exactly when the source content changed (same convention Bevel &
  // Emboss relies on), so object identity + a params tag invalidate
  // precisely when a recompute is actually needed. Dragging an unrelated
  // slider (e.g. SDF Morph's Amount) re-evals the graph but hits this
  // cache instead of re-running the threshold + JFA passes.
  srcRef?: ImageValue;
  tag?: string;
  range?: number;
}

function ensureState(ctx: RenderContext, nodeId: string): FromImageState {
  const key = `sdf-from-image:${nodeId}`;
  let s = ctx.state[key] as FromImageState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

function rootOfPosition(v: unknown): PositionNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "position") {
    return (v as PositionValue).root;
  }
  return { kind: "canvasUv" };
}

function emptySdf(): SdfValue {
  return { kind: "sdf", root: { kind: "empty" } };
}

export const sdfFromImageNode: NodeDefinition = {
  type: "sdf-from-image",
  name: "SDF From Image",
  category: "utility",
  description:
    "Convert an image into a signed distance field. Distance mode thresholds a channel and runs a jump-flooding distance transform (inside negative); Raw mode treats the image as an already-baked distance field (0.5 = edge). Output composes with Union / Morph / Round / Rasterize.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true, label: "Image" },
    { name: "position", type: "position", required: false, label: "Position" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["distance", "raw"],
      default: "distance",
    },
    {
      name: "source",
      label: "Source",
      type: "enum",
      options: ["luminance", "alpha", "red", "green", "blue"],
      default: "luminance",
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode !== "raw",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.mode !== "raw",
    },
    {
      // Half-range (in pixels) over which the field ramps before it
      // clamps. Widen it for big Offset / Smooth Union downstream.
      name: "spread",
      label: "Spread (px)",
      type: "scalar",
      min: 1,
      max: 1024,
      softMax: 256,
      step: 1,
      default: 128,
      visibleIf: (p) => p.mode !== "raw",
    },
    {
      // Raw mode only: canvas-UV distance that the channel's [0,1] range
      // maps to (value 0.5 = boundary → 0 distance).
      name: "range",
      label: "Distance range",
      type: "scalar",
      min: 0.001,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "raw",
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const img = inputs.image;
    if (!img || img.kind !== "image") {
      return { primary: emptySdf() };
    }
    const src = img as ImageValue;
    const state = ensureState(ctx, nodeId);

    const mode = (params.mode as string) ?? "distance";
    const channel = CHANNEL_INDEX[(params.source as string) ?? "luminance"] ?? 0;
    const maxDim = Math.max(ctx.width, ctx.height, 1);
    const spreadPx = Math.max(1, (params.spread as number) ?? 128);
    const threshold = Math.min(
      1,
      Math.max(0, (params.threshold as number) ?? 0.5)
    );
    const invert = params.invert ? 1 : 0;
    const rawRange = Math.max(0.001, (params.range as number) ?? 0.5);

    const tag =
      mode === "raw"
        ? `raw:${channel}:${rawRange}`
        : `d:${channel}:${threshold}:${invert}:${spreadPx}:${ctx.width}x${ctx.height}`;

    if (!state.sdf || state.srcRef !== src || state.tag !== tag) {
      // Release the previous field before computing the new one (its
      // downstream consumers ran last eval; the old AST won't be
      // re-sampled because this input change invalidates their sigs too).
      if (state.sdf) {
        ctx.releaseTexture(state.sdf.texture);
        state.sdf = undefined;
      }

      if (mode === "raw") {
        // Pass the channel through unchanged as the distance field.
        const out = ctx.allocMask();
        const prog = ctx.getShader("sdf-from-image/copy", COPY_FS);
        ctx.drawFullscreen(prog, out, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, src.texture);
          g.uniform1i(g.getUniformLocation(prog, "u_src"), 0);
          g.uniform1i(g.getUniformLocation(prog, "u_channel"), channel);
        });
        state.sdf = out;
        state.range = rawRange;
      } else {
        // Threshold → binary mask (alpha) → jump-flood distance transform.
        const mask = ctx.allocImage();
        const prog = ctx.getShader("sdf-from-image/threshold", THRESHOLD_FS);
        ctx.drawFullscreen(prog, mask, (g) => {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, src.texture);
          g.uniform1i(g.getUniformLocation(prog, "u_src"), 0);
          g.uniform1f(g.getUniformLocation(prog, "u_threshold"), threshold);
          g.uniform1f(g.getUniformLocation(prog, "u_invert"), invert);
          g.uniform1i(g.getUniformLocation(prog, "u_channel"), channel);
        });
        state.sdf = computeSDF(ctx, mask, spreadPx);
        ctx.releaseTexture(mask.texture);
        // Match computeSDF's normalization so downstream sees canvas-UV
        // signed distance.
        state.range = spreadPx / maxDim;
      }
      state.srcRef = src;
      state.tag = tag;
    }

    if (!state.sdf) return { primary: emptySdf() };
    const range = state.range ?? 0.5;

    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "sdfFromImage",
        position: rootOfPosition(inputs.position),
        image: state.sdf.texture,
        range,
      },
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `sdf-from-image:${nodeId}`;
    const state = ctx.state[key] as FromImageState | undefined;
    if (state?.sdf) ctx.releaseTexture(state.sdf.texture);
    delete ctx.state[key];
  },
};
