import type { NodeDefinition, SdfValue } from "@/engine/types";
import {
  bindSdfUniforms,
  compileSdf,
  structuralHash,
} from "@/engine/sdf-compile";

// SDF Bevel — terminal that rasterizes an SDF with two-light bevel
// shading. Works by inlining the SDF's distance expression at the
// pixel and 4 neighbors (compileSdf's `bevel` output mode), then
// deriving a normal via finite differences on a per-style height
// field. Same look spread as the Image-input Bevel & Emboss
// (Outer / Inner / Emboss / Pillow), but with pin-sharp distances
// and zero JFA — the gradient comes straight from the SDF.
//
// This sits at the END of an SDF chain, replacing SDF Rasterize
// when you want a 3D-button look. Compose with SDF Smooth Union /
// Round / Repeat etc. upstream.

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
function lightDir(angleDeg: number, elevDeg: number): [number, number, number] {
  const az = (angleDeg * Math.PI) / 180;
  const el = (elevDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [Math.cos(az) * ce, Math.sin(az) * ce, Math.sin(el)];
}

export const sdfBevelNode: NodeDefinition = {
  type: "sdf-bevel",
  name: "SDF Bevel",
  category: "utility",
  description:
    "Terminal that rasterizes an SDF with two-light bevel shading. Outer / Inner / Emboss / Pillow styles. Each light has its own angle / elevation / opacity; highlight + shadow colors and blend modes are shared. Replaces SDF Rasterize when you want a 3D-button or relief look.",
  backend: "webgl2",
  inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
  params: [
    {
      name: "style",
      label: "Style",
      type: "enum",
      options: STYLES as unknown as string[],
      default: "inner-bevel",
    },
    // Depth is in canvas-UV units here (not pixels) — matches the
    // rest of the SDF graph where every distance lives in the same
    // [0, 1] coordinate space.
    {
      name: "depth",
      label: "Depth",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.1,
      step: 0.001,
      default: 0.04,
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
    // Base fill (matches SDF Rasterize's foreground/background).
    {
      name: "foreground",
      label: "Foreground",
      type: "color",
      default: "#cccccc",
    },
    {
      name: "fg_alpha",
      label: "FG Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "background",
      label: "Background",
      type: "color",
      default: "#000000",
    },
    {
      name: "bg_alpha",
      label: "BG Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
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
    {
      name: "aspect_correct",
      label: "Aspect Correct",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const sdf = inputs.sdf;
    if (!sdf || sdf.kind !== "sdf") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const sdfVal = sdf as SdfValue;

    const compiled = compileSdf(sdfVal.root, "bevel");
    const cacheKey = `sdf-bevel/${structuralHash(sdfVal.root)}`;
    const prog = ctx.getShader(cacheKey, compiled.source);

    const styleId = styleToInt((params.style as string) ?? "inner-bevel");
    const depth = (params.depth as number) ?? 0.04;
    const soften = Math.max(0, (params.soften as number) ?? 1);

    const [fr, fg, fb] = hexToRgb((params.foreground as string) ?? "#cccccc");
    const [br, bg, bb] = hexToRgb((params.background as string) ?? "#000000");
    const fgAlpha = (params.fg_alpha as number) ?? 1;
    const bgAlpha = (params.bg_alpha as number) ?? 1;

    const l1 = lightDir(
      (params.l1_angle as number) ?? 135,
      (params.l1_elevation as number) ?? 30
    );
    const l2 = lightDir(
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
    const aspectCorrect = (params.aspect_correct as boolean) ?? true;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_canvasSize"),
        output.width,
        output.height
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_aspectCorrect"),
        aspectCorrect ? 1 : 0
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_style"), styleId);
      gl.uniform1f(gl.getUniformLocation(prog, "u_depth"), depth);
      gl.uniform1f(gl.getUniformLocation(prog, "u_soften"), soften);

      gl.uniform3f(
        gl.getUniformLocation(prog, "u_l1Dir"),
        l1[0],
        l1[1],
        l1[2]
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
        l2[0],
        l2[1],
        l2[2]
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_l2HiOp"),
        (params.l2_hi_op as number) ?? 0
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_l2ShOp"),
        (params.l2_sh_op as number) ?? 0
      );

      gl.uniform3f(gl.getUniformLocation(prog, "u_fgColor"), fr, fg, fb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_bgColor"), br, bg, bb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_fgAlpha"), fgAlpha);
      gl.uniform1f(gl.getUniformLocation(prog, "u_bgAlpha"), bgAlpha);
      gl.uniform3f(gl.getUniformLocation(prog, "u_hiColor"), hr, hg, hb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_shColor"), sr, sg, sb);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hiBlend"), hiBlendId);
      gl.uniform1i(gl.getUniformLocation(prog, "u_shBlend"), shBlendId);

      // Colour-bleed radius — inert until the shading terminal reads
      // the accumulator (see SDF Rasterize).
      const bleedLoc = gl.getUniformLocation(prog, "u_bleedInv");
      if (bleedLoc) gl.uniform1f(bleedLoc, 0);

      bindSdfUniforms(gl, prog, compiled.uniforms);
    });

    return { primary: output };
  },
};
