import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// ─── Main shader ──────────────────────────────────────────────────────────
// Each output pixel figures out which cell it belongs to, computes a local
// UV inside that cell, applies the inverse of the per-copy transform, and
// samples the source — O(1) per pixel regardless of cell count.
//
// Modulator inputs are sampled once per cell (at the cell's center UV in
// canvas space), so connecting e.g. a noise image to `mod_scale` gives each
// copy a different scale based on its location.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_modScale;
uniform sampler2D u_modPos;
uniform sampler2D u_modRot;
uniform int u_hasModScale;
uniform int u_hasModPos;
uniform int u_hasModRot;
uniform vec2 u_count;           // (countX, countY)
uniform vec2 u_stepSize;        // UV per cell
uniform vec2 u_patternOffset;   // UV offset of whole grid
uniform vec2 u_localOffset;     // per-copy translation (UV units, cell-local)
uniform float u_localAngle;     // per-copy rotation radians
uniform vec2 u_localScale;      // per-copy scale
uniform float u_modScaleAmt;    // modulator strength (maps 0..1 to 0..Amt*2)
uniform float u_modPosAmt;
uniform float u_modRotAmt;
out vec4 outColor;

void main() {
  vec2 gridUv = v_uv - u_patternOffset;
  vec2 idxF = floor(gridUv / u_stepSize);
  vec2 localUv = fract(gridUv / u_stepSize);

  // Out-of-grid pixels are transparent.
  if (idxF.x < 0.0 || idxF.x >= u_count.x ||
      idxF.y < 0.0 || idxF.y >= u_count.y) {
    outColor = vec4(0.0);
    return;
  }

  // Cell center in canvas UV — what modulators are sampled at.
  vec2 cellCenter = (idxF + 0.5) * u_stepSize + u_patternOffset;

  // Modulator samples. Map 0..1 source → -amt..+amt (for pos/rot) or
  // 1-amt..1+amt (for scale). Gives sensible behavior when the modulator
  // defaults to 0.5 grey (no change).
  vec2 effScale = u_localScale;
  if (u_hasModScale == 1) {
    float m = texture(u_modScale, cellCenter).r;
    effScale *= (1.0 + (m - 0.5) * 2.0 * u_modScaleAmt);
  }
  vec2 effOffset = u_localOffset;
  if (u_hasModPos == 1) {
    vec4 p = texture(u_modPos, cellCenter);
    effOffset += vec2(p.r - 0.5, p.g - 0.5) * 2.0 * u_modPosAmt;
  }
  float effAngle = u_localAngle;
  if (u_hasModRot == 1) {
    float r = texture(u_modRot, cellCenter).r;
    effAngle += (r - 0.5) * 2.0 * u_modRotAmt;
  }

  // Inverse transform cell-local UV back to the source texture.
  vec2 p = localUv - vec2(0.5);
  p -= effOffset;
  float c = cos(-effAngle);
  float s = sin(-effAngle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p /= max(effScale, vec2(0.0001));
  vec2 srcUv = p + vec2(0.5);

  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, srcUv);
}`;

// Per-cell normalized index as a one-channel image. Useful as a driver for
// downstream effects ("color ramp by index", "displace per cell", etc.).
const INDEX_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_count;
uniform vec2 u_stepSize;
uniform vec2 u_patternOffset;
uniform int u_rowFirst; // 0 = columns flow first, 1 = rows flow first
out vec4 outColor;

void main() {
  vec2 gridUv = v_uv - u_patternOffset;
  vec2 idxF = floor(gridUv / u_stepSize);
  if (idxF.x < 0.0 || idxF.x >= u_count.x ||
      idxF.y < 0.0 || idxF.y >= u_count.y) {
    outColor = vec4(0.0);
    return;
  }
  float total = max(u_count.x * u_count.y, 1.0);
  float idx = u_rowFirst == 1
    ? idxF.y * u_count.x + idxF.x
    : idxF.x * u_count.y + idxF.y;
  float t = idx / max(total - 1.0, 1.0);
  outColor = vec4(t, t, t, 1.0);
}`;

export const arrayNode: NodeDefinition = {
  type: "array",
  name: "Array",
  category: "utility",
  description:
    "Tile the input image into a grid. Fit mode scales cells to fill the canvas; Step mode gives cells a fixed size. Plug noise/gradient images into the modulator inputs for per-cell scale/position/rotation variation.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  // Modulator sockets only surface when the feature they drive makes sense.
  // Always-visible would clutter the default node; resolveInputs lets us
  // add them when the user wants them (here, always — but stubbed if the
  // "distribution" enum grows).
  resolveInputs() {
    const list: InputSocketDef[] = [
      { name: "image", label: "image", type: "image", required: true },
      {
        name: "mod_scale",
        label: "scale mod",
        type: "image",
        required: false,
      },
      {
        name: "mod_pos",
        label: "pos mod",
        type: "image",
        required: false,
      },
      {
        name: "mod_rot",
        label: "rot mod",
        type: "image",
        required: false,
      },
    ];
    return list;
  },
  params: [
    {
      name: "distribution",
      label: "Distribution",
      type: "enum",
      options: ["grid"],
      default: "grid",
    },
    {
      name: "countX",
      label: "Count X",
      type: "scalar",
      min: 1,
      max: 64,
      step: 1,
      default: 3,
    },
    {
      name: "countY",
      label: "Count Y",
      type: "scalar",
      min: 1,
      max: 64,
      step: 1,
      default: 3,
    },
    {
      name: "sizeMode",
      label: "Size Mode",
      type: "enum",
      options: ["fit", "step"],
      default: "fit",
    },
    {
      name: "sizeW",
      label: "Cell W",
      type: "scalar",
      min: 0.01,
      max: 2,
      step: 0.001,
      default: 0.333,
      visibleIf: (p) => p.sizeMode === "step",
    },
    {
      name: "sizeH",
      label: "Cell H",
      type: "scalar",
      min: 0.01,
      max: 2,
      step: 0.001,
      default: 0.333,
      visibleIf: (p) => p.sizeMode === "step",
    },
    {
      name: "patternOffsetX",
      label: "Pattern X",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "patternOffsetY",
      label: "Pattern Y",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "direction",
      label: "Direction",
      type: "enum",
      options: ["flow-columns", "flow-rows"],
      default: "flow-rows",
    },
    // Per-copy transform (applied uniformly to every cell, then modulated).
    {
      name: "localX",
      label: "Copy X",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "localY",
      label: "Copy Y",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "localRotate",
      label: "Copy Rotate",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "localScaleX",
      label: "Copy Scale X",
      type: "scalar",
      min: 0.01,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "localScaleY",
      label: "Copy Scale Y",
      type: "scalar",
      min: 0.01,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    // Modulator strengths. 0 disables the effect even if an input is wired.
    {
      name: "modScaleAmount",
      label: "Scale Mod Amt",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "modPosAmount",
      label: "Pos Mod Amt",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "modRotAmount",
      label: "Rot Mod Amt",
      type: "scalar",
      min: 0,
      max: 360,
      softMax: 180,
      step: 0.5,
      default: 90,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "index",
      type: "image",
      description: "Per-cell normalized index as grayscale (0..1).",
    },
  ],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    const indexOut = ctx.allocImage();
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      ctx.clearTarget(indexOut, [0, 0, 0, 0]);
      return { primary: output, aux: { index: indexOut } };
    }

    // Compute step size based on mode.
    const countX = Math.max(1, Math.floor((params.countX as number) ?? 3));
    const countY = Math.max(1, Math.floor((params.countY as number) ?? 3));
    const sizeMode = (params.sizeMode as string) ?? "fit";
    const stepX =
      sizeMode === "fit" ? 1 / countX : (params.sizeW as number) ?? 0.333;
    const stepY =
      sizeMode === "fit" ? 1 / countY : (params.sizeH as number) ?? 0.333;
    const patternX = (params.patternOffsetX as number) ?? 0;
    const patternY = (params.patternOffsetY as number) ?? 0;
    const localX = (params.localX as number) ?? 0;
    const localY = (params.localY as number) ?? 0;
    const localAngle =
      (((params.localRotate as number) ?? 0) * Math.PI) / 180;
    const localScaleX = Math.max(
      0.0001,
      (params.localScaleX as number) ?? 1
    );
    const localScaleY = Math.max(
      0.0001,
      (params.localScaleY as number) ?? 1
    );
    const modScaleAmt = (params.modScaleAmount as number) ?? 1;
    const modPosAmt = (params.modPosAmount as number) ?? 0.25;
    const modRotAmtRad =
      (((params.modRotAmount as number) ?? 90) * Math.PI) / 180;

    const placeholderKey = `array:${nodeId}:zero`;
    const placeholder = getPlaceholderTex(ctx.gl, ctx.state, placeholderKey);

    const resolveMod = (
      sv: ImageValue | undefined
    ): { has: 0 | 1; tex: WebGLTexture } => {
      if (sv && sv.kind === "image") {
        return { has: 1, tex: sv.texture };
      }
      return { has: 0, tex: placeholder };
    };

    const modScale = resolveMod(inputs.mod_scale as ImageValue | undefined);
    const modPos = resolveMod(inputs.mod_pos as ImageValue | undefined);
    const modRot = resolveMod(inputs.mod_rot as ImageValue | undefined);

    const prog = ctx.getShader("array/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, modScale.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_modScale"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, modPos.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_modPos"), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, modRot.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_modRot"), 3);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModScale"), modScale.has);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModPos"), modPos.has);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModRot"), modRot.has);
      gl.uniform2f(gl.getUniformLocation(prog, "u_count"), countX, countY);
      gl.uniform2f(gl.getUniformLocation(prog, "u_stepSize"), stepX, stepY);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_patternOffset"),
        patternX,
        patternY
      );
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_localOffset"),
        localX,
        localY
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_localAngle"), localAngle);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_localScale"),
        localScaleX,
        localScaleY
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_modScaleAmt"),
        modScaleAmt
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_modPosAmt"), modPosAmt);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_modRotAmt"),
        modRotAmtRad
      );
    });

    // Index aux output.
    const direction = (params.direction as string) ?? "flow-rows";
    const rowFirst = direction === "flow-rows" ? 1 : 0;
    const indexProg = ctx.getShader("array/index", INDEX_FS);
    ctx.drawFullscreen(indexProg, indexOut, (gl) => {
      gl.uniform2f(gl.getUniformLocation(indexProg, "u_count"), countX, countY);
      gl.uniform2f(
        gl.getUniformLocation(indexProg, "u_stepSize"),
        stepX,
        stepY
      );
      gl.uniform2f(
        gl.getUniformLocation(indexProg, "u_patternOffset"),
        patternX,
        patternY
      );
      gl.uniform1i(gl.getUniformLocation(indexProg, "u_rowFirst"), rowFirst);
    });

    return { primary: output, aux: { index: indexOut } };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `array:${nodeId}:zero`);
  },
};
