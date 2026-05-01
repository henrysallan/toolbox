import type { NodeDefinition, SdfValue } from "@/engine/types";
import { compileSdf, structuralHash } from "@/engine/sdf-compile";

// Render an SDF as a grayscale distance visualization. Useful for
// debugging the field, driving Displace downstream, or exporting a
// distance map that another node consumes via Sample / Displace / etc.
//
// Distances are remapped through a 3-stop ramp via |d|/range. Default
// colors give a black-inside / mid-gray-zero / white-outside grayscale
// look. `range` controls how much of the field is visible — 0.5 means
// distances from -0.5 to +0.5 span the full ramp (anything past clamps
// to the endpoint colors).

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

export const sdfToDistanceImageNode: NodeDefinition = {
  type: "sdf-to-distance-image",
  name: "SDF to Distance Image",
  category: "utility",
  description:
    "Render an SDF as a grayscale distance visualization. Range sets how much of the field spans the full ramp — smaller values reveal fine detail near the boundary. Negative / Zero / Positive colors customize the ramp.",
  backend: "webgl2",
  inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
  params: [
    {
      name: "range",
      label: "Range",
      type: "scalar",
      min: 0.001,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "neg_color",
      label: "Inside Color",
      type: "color",
      default: "#000000",
    },
    {
      name: "zero_color",
      label: "Zero Color",
      type: "color",
      default: "#808080",
    },
    {
      name: "pos_color",
      label: "Outside Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
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

    const compiled = compileSdf(sdfVal.root, "distance");
    const cacheKey = `sdf-distance/${structuralHash(sdfVal.root)}`;
    const prog = ctx.getShader(cacheKey, compiled.source);

    const range = Math.max(1e-5, (params.range as number) ?? 0.5);
    const [nr, ng, nb] = hexToRgb((params.neg_color as string) ?? "#000000");
    const [zr, zg, zb] = hexToRgb((params.zero_color as string) ?? "#808080");
    const [pr, pg, pb] = hexToRgb((params.pos_color as string) ?? "#ffffff");
    const alpha = (params.alpha as number) ?? 1;
    const aspectCorrect = (params.aspect_correct as boolean) ?? true;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1f(gl.getUniformLocation(prog, "u_range"), range);
      gl.uniform3f(gl.getUniformLocation(prog, "u_negColor"), nr, ng, nb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_zeroColor"), zr, zg, zb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_posColor"), pr, pg, pb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), alpha);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_canvasSize"),
        output.width,
        output.height
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_aspectCorrect"),
        aspectCorrect ? 1 : 0
      );

      let samplerUnit = 0;
      for (const u of compiled.uniforms) {
        const loc = gl.getUniformLocation(prog, u.name);
        if (!loc) continue;
        if (u.type === "float") {
          gl.uniform1f(loc, u.value as number);
        } else if (u.type === "vec2") {
          const v = u.value as [number, number];
          gl.uniform2f(loc, v[0], v[1]);
        } else {
          gl.activeTexture(gl.TEXTURE0 + samplerUnit);
          gl.bindTexture(gl.TEXTURE_2D, u.value as WebGLTexture);
          gl.uniform1i(loc, samplerUnit);
          samplerUnit++;
        }
      }
    });

    return { primary: output };
  },
};
