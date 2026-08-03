import type {
  ImageValue,
  MaskValue,
  NodeDefinition,
  RenderContext,
  SdfValue,
  SocketValue,
} from "@/engine/types";
import {
  bindSdfUniforms,
  compileSdf,
  structuralHash,
} from "@/engine/sdf-compile";
import { sdfHexToRgb01 } from "@/engine/sdf-material";
import { sampleFloatCurve, type CurvePoint } from "@/engine/float-curve";

// The shading terminal. Reads an SDF as a continuum rather than a binary
// inside/outside, and composites five optional layers in ONE analytic
// pass: background <- glow <- fill (lit) <- contour.
//
// It exists because the looks it targets are combinations. With one
// terminal per effect, "emboss AND glow" means rasterizing the tree twice
// and merging, and every extra layer costs another branch. Here the
// sections are boolean-gated params over a single shader.
//
// Colour comes from the tree, not from here: SDF Material / a primitive's
// Paint swatch set each shape's colour, combiners blend them, and this
// node's Fill Color is only the fallback for unpainted shapes. Bleed then
// dials between winner-takes-all colour and a distance-weighted wash of
// every painted leaf.
//
// Aux outputs share the compiled program via a `u_channel` uniform — one
// extra draw each, and consumption-gated, so an unwired one costs nothing.
// Spec: 080226_sdf-materials-and-shading.md.

const HEIGHT_MODES = ["outer", "inner", "emboss", "pillow", "curve"] as const;
const HIGHLIGHT_BLENDS = ["screen", "add", "normal"] as const;
const SHADOW_BLENDS = ["multiply", "linear-burn", "color-burn", "normal"] as const;
const GLOW_BLENDS = ["normal", "add", "screen"] as const;
const GLOW_COLOR_MODES = ["material", "fixed"] as const;

const CURVE_LUT_SIZE = 256;

interface ShadeState {
  curveLut?: WebGLTexture;
  curveTag?: string;
}

function idx(list: readonly string[], v: unknown, fallback = 0): number {
  const i = list.indexOf(String(v));
  return i < 0 ? fallback : i;
}

function lightDir(angleDeg: number, elevDeg: number): [number, number, number] {
  const az = (angleDeg * Math.PI) / 180;
  const el = (elevDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [Math.cos(az) * ce, Math.sin(az) * ce, Math.sin(el)];
}

// Height-profile LUT for `curve` mode. RGBA8 for the same reason the
// material ramp is: float textures aren't linearly filterable in WebGL2
// without OES_texture_float_linear, and an incomplete texture samples as
// black — which here would read as "the relief vanished".
function buildCurveLut(
  ctx: RenderContext,
  state: ShadeState,
  pts: CurvePoint[]
): WebGLTexture | null {
  const tag = JSON.stringify(pts);
  if (state.curveLut && state.curveTag === tag) return state.curveLut;
  const gl = ctx.gl;
  if (!state.curveLut) {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    state.curveLut = tex;
  }
  const data = new Uint8Array(CURVE_LUT_SIZE * 4);
  for (let i = 0; i < CURVE_LUT_SIZE; i++) {
    const y = sampleFloatCurve(pts, (i + 0.5) / CURVE_LUT_SIZE);
    const v = Math.round(Math.max(0, Math.min(1, y)) * 255);
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, state.curveLut);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    CURVE_LUT_SIZE,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data
  );
  state.curveTag = tag;
  return state.curveLut;
}

const lit = (p: Record<string, unknown>) => p.light === true;
const glowing = (p: Record<string, unknown>) => p.glow === true;

export const sdfShadeNode: NodeDefinition = {
  type: "sdf-shade",
  name: "SDF Shade",
  category: "utility",
  description:
    "Shading terminal for SDFs: fill, color bleed, relief lighting, glow and contours composited in one pass. Per-shape colors come from SDF Material / a primitive's Paint swatch; Fill Color is the fallback for unpainted shapes. Aux outputs expose the normal, height, glow and bleed layers for re-compositing.",
  backend: "webgl2",
  inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
  params: [
    // ── Fill
    { name: "fill_color", label: "Fill Color", type: "color", default: "#ffffff" },
    { name: "fill_alpha", label: "Fill Alpha", type: "scalar", min: 0, max: 1, step: 0.001, default: 1 },
    { name: "background", label: "Background", type: "color", default: "#000000" },
    { name: "bg_alpha", label: "BG Alpha", type: "scalar", min: 0, max: 1, step: 0.001, default: 1 },
    { name: "softness", label: "Softness (px)", type: "scalar", min: 0, max: 16, softMax: 4, step: 0.1, default: 1 },

    // ── Bleed
    { name: "bleed", label: "Color Bleed", type: "boolean", default: false },
    { name: "bleed_mix", label: "Bleed Mix", type: "scalar", min: 0, max: 1, step: 0.001, default: 1, visibleIf: (p) => p.bleed === true },
    { name: "bleed_radius", label: "Bleed Radius", type: "scalar", min: 0.001, max: 2, softMax: 0.5, step: 0.001, default: 0.15, visibleIf: (p) => p.bleed === true },
    { name: "bleed_inside", label: "Saturate Interiors", type: "boolean", default: true, visibleIf: (p) => p.bleed === true },

    // ── Light
    { name: "light", label: "Lighting", type: "boolean", default: false },
    { name: "height_mode", label: "Height", type: "enum", options: HEIGHT_MODES as unknown as string[], default: "inner", visibleIf: lit },
    { name: "height_curve", label: "Height Profile", type: "float_curve", default: [{ id: "hc-a", x: 0, y: 0 }, { id: "hc-b", x: 1, y: 1 }] as CurvePoint[], visibleIf: (p) => lit(p) && p.height_mode === "curve" },
    { name: "depth", label: "Depth", type: "scalar", min: 0, max: 0.5, softMax: 0.1, step: 0.001, default: 0.04, visibleIf: lit },
    { name: "soften", label: "Soften (px)", type: "scalar", min: 0, max: 32, softMax: 8, step: 0.1, default: 1, visibleIf: lit },
    { name: "l1_angle", label: "Light 1 Angle (°)", type: "scalar", min: -360, max: 360, step: 0.5, default: 135, visibleIf: lit },
    { name: "l1_elevation", label: "Light 1 Elevation (°)", type: "scalar", min: 0, max: 90, step: 0.5, default: 30, visibleIf: lit },
    { name: "l1_hi_op", label: "Light 1 Highlight", type: "scalar", min: 0, max: 2, softMax: 1, step: 0.01, default: 1, visibleIf: lit },
    { name: "l1_sh_op", label: "Light 1 Shadow", type: "scalar", min: 0, max: 2, softMax: 1, step: 0.01, default: 0.75, visibleIf: lit },
    { name: "l2_angle", label: "Light 2 Angle (°)", type: "scalar", min: -360, max: 360, step: 0.5, default: -45, visibleIf: lit },
    { name: "l2_elevation", label: "Light 2 Elevation (°)", type: "scalar", min: 0, max: 90, step: 0.5, default: 60, visibleIf: lit },
    { name: "l2_hi_op", label: "Light 2 Highlight", type: "scalar", min: 0, max: 2, softMax: 1, step: 0.01, default: 0, visibleIf: lit },
    { name: "l2_sh_op", label: "Light 2 Shadow", type: "scalar", min: 0, max: 2, softMax: 1, step: 0.01, default: 0, visibleIf: lit },
    { name: "highlight_color", label: "Highlight Color", type: "color", default: "#ffffff", visibleIf: lit },
    { name: "shadow_color", label: "Shadow Color", type: "color", default: "#000000", visibleIf: lit },
    { name: "highlight_blend", label: "Highlight Blend", type: "enum", options: HIGHLIGHT_BLENDS as unknown as string[], default: "screen", visibleIf: lit },
    { name: "shadow_blend", label: "Shadow Blend", type: "enum", options: SHADOW_BLENDS as unknown as string[], default: "multiply", visibleIf: lit },

    // ── Glow
    { name: "glow", label: "Glow", type: "boolean", default: false },
    { name: "glow_radius", label: "Glow Radius", type: "scalar", min: 0.001, max: 2, softMax: 0.4, step: 0.001, default: 0.08, visibleIf: glowing },
    { name: "glow_intensity", label: "Glow Intensity", type: "scalar", min: 0, max: 4, softMax: 2, step: 0.01, default: 1, visibleIf: glowing },
    { name: "glow_color_mode", label: "Glow Color From", type: "enum", options: GLOW_COLOR_MODES as unknown as string[], default: "material", visibleIf: glowing },
    { name: "glow_color", label: "Glow Color", type: "color", default: "#ffffff", visibleIf: (p) => glowing(p) && p.glow_color_mode === "fixed" },
    { name: "glow_blend", label: "Glow Blend", type: "enum", options: GLOW_BLENDS as unknown as string[], default: "screen", visibleIf: glowing },

    // ── Contour
    { name: "contour", label: "Contour", type: "boolean", default: false },
    { name: "contour_color", label: "Contour Color", type: "color", default: "#000000", visibleIf: (p) => p.contour === true },
    { name: "contour_alpha", label: "Contour Alpha", type: "scalar", min: 0, max: 1, step: 0.001, default: 1, visibleIf: (p) => p.contour === true },
    { name: "contour_width", label: "Contour Width (px)", type: "scalar", min: 0, max: 32, softMax: 8, step: 0.1, default: 1.5, visibleIf: (p) => p.contour === true },
    { name: "contour_spacing", label: "Contour Spacing", type: "scalar", min: 0, max: 1, softMax: 0.2, step: 0.001, default: 0, visibleIf: (p) => p.contour === true },

    { name: "aspect_correct", label: "Aspect Correct", type: "boolean", default: true },
  ],
  primaryOutput: "image",
  auxOutputs: [
    { name: "normal", type: "image", label: "Normal" },
    { name: "height", type: "mask", label: "Height" },
    { name: "glow", type: "image", label: "Glow" },
    { name: "bleed", type: "image", label: "Bleed" },
    { name: "mask", type: "mask", label: "Mask" },
  ],

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const output = ctx.allocImage();
    const sdf = inputs.sdf;
    if (!sdf || sdf.kind !== "sdf") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const sdfVal = sdf as SdfValue;

    const compiled = compileSdf(sdfVal.root, "shade");
    const prog = ctx.getShader(
      `sdf-shade/${structuralHash(sdfVal.root)}`,
      compiled.source
    );

    const state = (ctx.state[`sdf-shade:${nodeId}`] ??= {}) as ShadeState;
    const heightMode = idx(HEIGHT_MODES, params.height_mode, 1);
    const curveLut =
      heightMode === 4
        ? buildCurveLut(
            ctx,
            state,
            (params.height_curve as CurvePoint[]) ?? []
          )
        : null;

    const fill = sdfHexToRgb01((params.fill_color as string) ?? "#ffffff");
    const bg = sdfHexToRgb01((params.background as string) ?? "#000000");
    const hiC = sdfHexToRgb01((params.highlight_color as string) ?? "#ffffff");
    const shC = sdfHexToRgb01((params.shadow_color as string) ?? "#000000");
    const glowC = sdfHexToRgb01((params.glow_color as string) ?? "#ffffff");
    const contourC = sdfHexToRgb01((params.contour_color as string) ?? "#000000");
    const l1 = lightDir(
      (params.l1_angle as number) ?? 135,
      (params.l1_elevation as number) ?? 30
    );
    const l2 = lightDir(
      (params.l2_angle as number) ?? -45,
      (params.l2_elevation as number) ?? 60
    );

    const bleedOn = params.bleed === true;
    const bleedRadius = Math.max(1e-3, (params.bleed_radius as number) ?? 0.15);
    // `bleed_inside` decides whether interiors saturate at weight 1 (a firm
    // core) or keep growing so the nearest shape dominates hard. The shader
    // reads it through the clamp in sLeaf, so it rides the same uniform.
    const bleedInside = params.bleed_inside !== false;

    const draw = (target: ImageValue | MaskValue, channel: number) => {
      ctx.drawFullscreen(prog, target, (gl) => {
        const u = (n: string) => gl.getUniformLocation(prog, n);
        gl.uniform2f(u("u_canvasSize"), target.width, target.height);
        gl.uniform1f(
          u("u_aspectCorrect"),
          (params.aspect_correct ?? true) ? 1 : 0
        );
        gl.uniform1i(u("u_channel"), channel);

        gl.uniform1f(u("u_softness"), Math.max(0, (params.softness as number) ?? 1));
        gl.uniform3f(u("u_fillColor"), fill[0], fill[1], fill[2]);
        gl.uniform1f(u("u_fillAlpha"), (params.fill_alpha as number) ?? 1);
        gl.uniform3f(u("u_bgColor"), bg[0], bg[1], bg[2]);
        gl.uniform1f(u("u_bgAlpha"), (params.bg_alpha as number) ?? 1);

        // Bleed off => radius 0 => every leaf weight is 1 and the mix is
        // ignored, so the accumulator stays inert.
        gl.uniform1f(u("u_bleedInv"), bleedOn ? 1 / bleedRadius : 0);
        gl.uniform1f(
          u("u_bleedMix"),
          bleedOn ? ((params.bleed_mix as number) ?? 1) : 0
        );
        gl.uniform1i(u("u_bleedInside"), bleedInside ? 1 : 0);

        gl.uniform1i(u("u_lightOn"), params.light === true ? 1 : 0);
        gl.uniform1i(u("u_heightMode"), heightMode);
        gl.uniform1f(u("u_depth"), (params.depth as number) ?? 0.04);
        gl.uniform1f(u("u_soften"), Math.max(0, (params.soften as number) ?? 1));
        gl.uniform3f(u("u_l1Dir"), l1[0], l1[1], l1[2]);
        gl.uniform1f(u("u_l1HiOp"), (params.l1_hi_op as number) ?? 1);
        gl.uniform1f(u("u_l1ShOp"), (params.l1_sh_op as number) ?? 0.75);
        gl.uniform3f(u("u_l2Dir"), l2[0], l2[1], l2[2]);
        gl.uniform1f(u("u_l2HiOp"), (params.l2_hi_op as number) ?? 0);
        gl.uniform1f(u("u_l2ShOp"), (params.l2_sh_op as number) ?? 0);
        gl.uniform3f(u("u_hiColor"), hiC[0], hiC[1], hiC[2]);
        gl.uniform3f(u("u_shColor"), shC[0], shC[1], shC[2]);
        gl.uniform1i(u("u_hiBlend"), idx(HIGHLIGHT_BLENDS, params.highlight_blend, 0));
        gl.uniform1i(u("u_shBlend"), idx(SHADOW_BLENDS, params.shadow_blend, 0));

        gl.uniform1i(u("u_glowOn"), params.glow === true ? 1 : 0);
        gl.uniform1f(u("u_glowRadius"), Math.max(1e-3, (params.glow_radius as number) ?? 0.08));
        gl.uniform1f(u("u_glowIntensity"), (params.glow_intensity as number) ?? 1);
        gl.uniform1i(u("u_glowColorMode"), idx(GLOW_COLOR_MODES, params.glow_color_mode, 0));
        gl.uniform3f(u("u_glowColor"), glowC[0], glowC[1], glowC[2]);
        gl.uniform1i(u("u_glowBlend"), idx(GLOW_BLENDS, params.glow_blend, 2));

        gl.uniform1i(u("u_contourOn"), params.contour === true ? 1 : 0);
        gl.uniform3f(u("u_contourColor"), contourC[0], contourC[1], contourC[2]);
        gl.uniform1f(u("u_contourAlpha"), (params.contour_alpha as number) ?? 1);
        gl.uniform1f(u("u_contourWidth"), Math.max(0, (params.contour_width as number) ?? 1.5));
        gl.uniform1f(u("u_contourSpacing"), Math.max(0, (params.contour_spacing as number) ?? 0));

        // The per-leaf uniforms consume texture units from 0; the height
        // curve takes the next free one so it can't collide with a
        // Displace/Spline sampler in the tree.
        const nextUnit = bindSdfUniforms(gl, prog, compiled.uniforms);
        const curveLoc = u("u_heightCurve");
        if (curveLoc) {
          gl.activeTexture(gl.TEXTURE0 + nextUnit);
          gl.bindTexture(gl.TEXTURE_2D, curveLut ?? null);
          gl.uniform1i(curveLoc, nextUnit);
        }
      });
    };

    draw(output, 0);

    // Aux passes are one extra draw each and only run when something
    // reads them (a wire, or the viewport showing that socket).
    const aux: Record<string, SocketValue> = {};
    const wants = (name: string) => consumedOutputs?.has(`aux:${name}`) ?? false;
    if (wants("normal")) {
      const t = ctx.allocImage();
      draw(t, 1);
      aux.normal = t;
    }
    if (wants("height")) {
      const t = ctx.allocMask();
      draw(t, 2);
      aux.height = t;
    }
    if (wants("glow")) {
      const t = ctx.allocImage();
      draw(t, 3);
      aux.glow = t;
    }
    if (wants("bleed")) {
      const t = ctx.allocImage();
      draw(t, 4);
      aux.bleed = t;
    }
    if (wants("mask")) {
      const t = ctx.allocMask();
      draw(t, 5);
      aux.mask = t;
    }

    return { primary: output, aux };
  },

  dispose(ctx, nodeId) {
    const key = `sdf-shade:${nodeId}`;
    const state = ctx.state[key] as ShadeState | undefined;
    if (state?.curveLut) ctx.gl.deleteTexture(state.curveLut);
    delete ctx.state[key];
  },
};
