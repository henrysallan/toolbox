import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  Point,
  PointsValue,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { transformSubpath } from "@/engine/spline-transform";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Tile an instance into a 2D grid.
//
// The instance type is polymorphic — image, spline, or points — and the
// `mode` param picks which. resolveInputs/resolvePrimaryOutput rewire the
// sockets to match, exactly like the Copy to Points node.
//
// Image mode runs as a single full-screen pass: each output pixel figures
// out which cell it lies in, computes a cell-local UV, applies the inverse
// per-copy transform, and samples the source — O(1) per pixel regardless
// of cell count. Image-mode modulator sockets (mod_scale / mod_pos /
// mod_rot) sample upstream images at each cell's center.
//
// Spline / point modes are pure CPU geometry. For each cell, the input
// subpaths or points are transformed into the cell's center with the
// per-copy local translate / rotate / scale applied. The optimization
// pattern parallels Copy to Points: just affine math through the existing
// transformSubpath helper, no GPU readback. Per-instance modulator inputs
// don't apply (matching copy-to-points convention — feed Jitter or
// Transform downstream for noise / uniform tweaks).

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

  if (idxF.x < 0.0 || idxF.x >= u_count.x ||
      idxF.y < 0.0 || idxF.y >= u_count.y) {
    outColor = vec4(0.0);
    return;
  }

  vec2 cellCenter = (idxF + 0.5) * u_stepSize + u_patternOffset;

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

function modeOf(params: Record<string, unknown>): "image" | "spline" | "point" {
  const m = params.mode;
  if (m === "spline") return "spline";
  if (m === "point") return "point";
  return "image";
}

export const arrayNode: NodeDefinition = {
  type: "array",
  name: "Array",
  category: "utility",
  description:
    "Tile an image, spline, or points into a grid. Image mode supports modulator inputs for per-cell scale/position/rotation variation; spline / point modes emit transformed CPU geometry — feed Jitter or Transform downstream for noise / uniform tweaks.",
  backend: "webgl2",
  inputs: [{ name: "instance", type: "image", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const mode = modeOf(params);
    const instType: SocketType =
      mode === "spline" ? "spline" : mode === "point" ? "points" : "image";
    const list: InputSocketDef[] = [
      { name: "instance", label: "instance", type: instType, required: true },
    ];
    // Image-mode-only modulator sockets. Spline / point geometry edits
    // belong on Jitter / Transform — same convention as Copy to Points.
    if (mode === "image") {
      list.push(
        { name: "mod_scale", label: "scale mod", type: "image", required: false },
        { name: "mod_pos", label: "pos mod", type: "image", required: false },
        { name: "mod_rot", label: "rot mod", type: "image", required: false }
      );
    }
    return list;
  },
  params: [
    {
      name: "mode",
      label: "Instance type",
      type: "enum",
      options: ["image", "spline", "point"],
      default: "image",
    },
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
    {
      name: "modScaleAmount",
      label: "Scale Mod Amt",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => modeOf(p) === "image",
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
      visibleIf: (p) => modeOf(p) === "image",
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
      visibleIf: (p) => modeOf(p) === "image",
    },
  ],
  linkedPairs: [
    { a: "countX", b: "countY" },
    { a: "sizeW", b: "sizeH" },
    { a: "patternOffsetX", b: "patternOffsetY" },
    { a: "localX", b: "localY" },
    { a: "localScaleX", b: "localScaleY" },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params): SocketType {
    const mode = modeOf(params);
    if (mode === "spline") return "spline";
    if (mode === "point") return "points";
    return "image";
  },
  auxOutputs: [
    {
      name: "index",
      type: "image",
      description: "Per-cell normalized index as grayscale (0..1).",
    },
  ],
  resolveAuxOutputs(params): OutputSocketDef[] {
    // The grayscale-index aux is only meaningful in image mode — the
    // other modes emit CPU geometry where per-instance index already
    // lives on each output item via groupIndex.
    if (modeOf(params) !== "image") return [];
    return [
      {
        name: "index",
        type: "image",
        description: "Per-cell normalized index as grayscale (0..1).",
      },
    ];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const mode = modeOf(params);

    // Geometry common: cell-step sizing, ordering, per-copy transform.
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
    const localRotateDeg = (params.localRotate as number) ?? 0;
    const localScaleX = Math.max(
      0.0001,
      (params.localScaleX as number) ?? 1
    );
    const localScaleY = Math.max(
      0.0001,
      (params.localScaleY as number) ?? 1
    );
    const direction = (params.direction as string) ?? "flow-rows";
    const rowFirst = direction === "flow-rows";

    // ---- spline mode -------------------------------------------------
    if (mode === "spline") {
      const inst = inputs.instance;
      if (!inst || inst.kind !== "spline") {
        const empty: SplineValue = { kind: "spline", subpaths: [] };
        return { primary: empty };
      }
      const out: SplineSubpath[] = [];
      const total = countX * countY;
      for (let n = 0; n < total; n++) {
        // Resolve cell (ix, iy) using the same row-first / column-first
        // ordering as the index shader so external indexing matches.
        const ix = rowFirst ? n % countX : Math.floor(n / countY);
        const iy = rowFirst ? Math.floor(n / countX) : n % countY;
        const cellCenterX = (ix + 0.5) * stepX + patternX;
        const cellCenterY = (iy + 0.5) * stepY + patternY;
        // Translate is offset relative to the natural (0.5, 0.5) anchor
        // — match Copy to Points convention so a centered glyph lands
        // its pivot on the cell center, then localX/Y nudges from there.
        const tx = cellCenterX - 0.5 + localX;
        const ty = cellCenterY - 0.5 + localY;
        for (const sub of inst.subpaths) {
          const transformed = transformSubpath(sub, {
            translateX: tx,
            translateY: ty,
            pivotX: 0.5,
            pivotY: 0.5,
            rotateDeg: localRotateDeg,
            scaleX: localScaleX,
            scaleY: localScaleY,
          });
          out.push({ ...transformed, groupIndex: sub.groupIndex });
        }
      }
      return { primary: { kind: "spline", subpaths: out } };
    }

    // ---- point mode --------------------------------------------------
    if (mode === "point") {
      const inst = inputs.instance;
      if (!inst || inst.kind !== "points") {
        const empty: PointsValue = { kind: "points", points: [] };
        return { primary: empty };
      }
      const out: Point[] = [];
      const total = countX * countY;
      const localRot = (localRotateDeg * Math.PI) / 180;
      const cosR = Math.cos(localRot);
      const sinR = Math.sin(localRot);
      for (let n = 0; n < total; n++) {
        const ix = rowFirst ? n % countX : Math.floor(n / countY);
        const iy = rowFirst ? Math.floor(n / countX) : n % countY;
        const cellCenterX = (ix + 0.5) * stepX + patternX;
        const cellCenterY = (iy + 0.5) * stepY + patternY;
        for (const src of inst.points) {
          // Source point's offset from its own (0.5, 0.5) anchor →
          // scale → rotate → place at the cell center + per-copy nudge.
          const dx = (src.pos[0] - 0.5) * localScaleX;
          const dy = (src.pos[1] - 0.5) * localScaleY;
          const rx = cosR * dx - sinR * dy;
          const ry = sinR * dx + cosR * dy;
          out.push({
            pos: [cellCenterX + localX + rx, cellCenterY + localY + ry],
            rotation: (src.rotation ?? 0) + localRot,
            scale: [
              (src.scale?.[0] ?? 1) * localScaleX,
              (src.scale?.[1] ?? 1) * localScaleY,
            ],
            groupIndex: src.groupIndex,
          });
        }
      }
      return { primary: { kind: "points", points: out } };
    }

    // ---- image mode (original full-screen tiling shader) -------------
    const output = ctx.allocImage();
    const indexOut = ctx.allocImage();
    const src = inputs.instance;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      ctx.clearTarget(indexOut, [0, 0, 0, 0]);
      return { primary: output, aux: { index: indexOut } };
    }

    const localAngle = (localRotateDeg * Math.PI) / 180;
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
      gl.uniform1i(
        gl.getUniformLocation(indexProg, "u_rowFirst"),
        rowFirst ? 1 : 0
      );
    });

    return { primary: output, aux: { index: indexOut } };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `array:${nodeId}:zero`);
  },
};
