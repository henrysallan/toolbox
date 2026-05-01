import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
  SdfValue,
  SplineValue,
} from "@/engine/types";
import { compileSdf, structuralHash } from "@/engine/sdf-compile";
import { marchingSquares } from "@/engine/marching-squares";

// Extract the iso-line of an SDF as a spline. The pipeline:
//
//   1. Compile the SDF tree to a "raw distance" shader (R channel
//      stores signed distance, RGBA16F).
//   2. Render to a small RGBA16F image at the chosen resolution.
//   3. Read pixels back via ctx.readImageToFloat32.
//   4. Run marching squares on the R channel.
//   5. Output the resulting subpaths as a SplineValue.
//
// The CPU readback is the expensive step. Resolution defaults to 256
// — high enough for smooth curves on most shapes, low enough to keep
// the readback under a millisecond. For finer detail, raise resolution
// or follow with Smooth Path / Resample downstream.
//
// `iso` is the contour level (default 0 = the SDF zero-crossing).
// Negative iso values trace inside the shape (concentric loops);
// positive iso traces outside (puffed-out boundary).

interface ScratchState {
  // Reusable RGBA16F target for the distance render. Resized in place
  // when the resolution param changes.
  image?: ImageValue;
  width?: number;
  height?: number;
}

function ensureState(ctx: RenderContext, nodeId: string): ScratchState {
  const key = `sdf-to-spline:${nodeId}`;
  let s = ctx.state[key] as ScratchState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

function ensureTarget(
  ctx: RenderContext,
  state: ScratchState,
  size: number
): ImageValue {
  if (
    !state.image ||
    state.width !== size ||
    state.height !== size
  ) {
    if (state.image) ctx.releaseTexture(state.image.texture);
    state.image = ctx.allocImage({ width: size, height: size });
    state.width = size;
    state.height = size;
  }
  return state.image;
}

export const sdfToSplineNode: NodeDefinition = {
  type: "sdf-to-spline",
  name: "SDF to Spline",
  category: "utility",
  description:
    "Extract the iso-line of an SDF as a spline (closed where loops form, open where chains run off the grid). Resolution sets the marching-squares grid size — 256 is a good default; raise it for smoother curves at the cost of a bigger CPU readback.",
  backend: "webgl2",
  // CPU readback every frame — not cacheable.
  stable: false,
  inputs: [{ name: "sdf", type: "sdf", required: true, label: "SDF" }],
  params: [
    {
      name: "iso",
      label: "Iso Level",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0,
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 32,
      max: 1024,
      softMax: 512,
      step: 1,
      default: 256,
    },
    {
      name: "aspect_correct",
      label: "Aspect Correct",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const sdf = inputs.sdf;
    const empty: SplineValue = { kind: "spline", subpaths: [] };
    if (!sdf || sdf.kind !== "sdf") {
      return { primary: empty };
    }
    const sdfVal = sdf as SdfValue;

    const resolution = Math.max(
      32,
      Math.min(1024, Math.round((params.resolution as number) ?? 256))
    );
    const iso = (params.iso as number) ?? 0;
    const aspectCorrect = (params.aspect_correct as boolean) ?? true;

    const state = ensureState(ctx, nodeId);
    const target = ensureTarget(ctx, state, resolution);

    const compiled = compileSdf(sdfVal.root, "raw");
    const cacheKey = `sdf-raw/${structuralHash(sdfVal.root)}`;
    const prog = ctx.getShader(cacheKey, compiled.source);

    ctx.drawFullscreen(prog, target, (gl) => {
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_canvasSize"),
        target.width,
        target.height
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

    // Sync readback. Float32Array length = w*h*4 (RGBA), R channel
    // holds the signed distance.
    const data = ctx.readImageToFloat32(target);
    const w = target.width;
    const h = target.height;

    // Pull just the R channel into a contiguous Float32 grid so
    // marching squares doesn't have to stride. Also Y-flip: readPixels
    // returns rows bottom-up, but our spline coords are Y-DOWN.
    const grid = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcY = h - 1 - y;
        grid[y * w + x] = data[(srcY * w + x) * 4];
      }
    }

    const subpaths = marchingSquares(grid, w, h, {
      iso,
      uvOrigin: [0, 0],
      uvSize: [1, 1],
    });

    return { primary: { kind: "spline", subpaths } };
  },

  dispose(ctx, nodeId) {
    const key = `sdf-to-spline:${nodeId}`;
    const state = ctx.state[key] as ScratchState | undefined;
    if (state?.image) ctx.releaseTexture(state.image.texture);
    delete ctx.state[key];
  },
};
