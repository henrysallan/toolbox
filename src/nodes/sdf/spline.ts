import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  RenderContext,
  SdfValue,
  SplineValue,
} from "@/engine/types";
import { flattenSpline, splineGeomHash } from "@/engine/spline-flatten";
import { SDF_PAINT_PARAMS, paintSdf } from "@/engine/sdf-material";

// SDF primitive — distance to a spline. The spline gets pre-
// flattened on the CPU into line segments (cubic Béziers
// subdivided), packed into a 1×N RGBA32F data texture, and then
// looped over per-pixel in the compiled SDF shader. Sign comes from
// a horizontal-ray winding count when the spline is closed; open
// splines emit unsigned distance (acts like a stroke).
//
// The texture is cached per-node-instance and re-uploaded only when
// the spline's geometry changes (anchor positions / handles), not
// when downstream params or unrelated inputs change.
//
// Limits: 1024 segments hard-coded in the shader loop. With the
// default 16 subdivisions per cubic, that's room for ~64 cubic
// curves' worth of geometry — enough for typical illustration
// splines. Lower the Subdivisions param for denser splines.

interface SplineSdfState {
  texture?: WebGLTexture;
  width?: number;
  // Identity-cache the spline source so we re-upload only when the
  // spline really changed. Combines geometry hash + subdivisions
  // count so changing either invalidates.
  sourceTag?: string;
  segCount?: number;
  closed?: boolean;
}

const MAX_SEGMENTS = 1024;

function rootOfPosition(v: unknown): PositionNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "position") {
    return (v as PositionValue).root;
  }
  return { kind: "canvasUv" };
}

function ensureState(ctx: RenderContext, nodeId: string): SplineSdfState {
  const key = `sdf-spline:${nodeId}`;
  let s = ctx.state[key] as SplineSdfState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

function uploadSegments(
  ctx: RenderContext,
  state: SplineSdfState,
  data: Float32Array,
  segCount: number
): WebGLTexture | null {
  const gl = ctx.gl;
  const width = Math.max(1, segCount);
  // (Re)allocate the texture if width changed. RGBA32F — 4 floats per
  // texel matches our (ax, ay, bx, by) packing exactly.
  if (!state.texture || state.width !== width) {
    if (state.texture) gl.deleteTexture(state.texture);
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    state.texture = tex;
    state.width = width;
  }
  // Pad data to width*4 floats — the shader's loop is bounded by
  // segCount uniform anyway, so trailing texels are never read.
  const expected = width * 4;
  let payload: Float32Array;
  if (data.length === expected) {
    payload = data;
  } else if (data.length < expected) {
    payload = new Float32Array(expected);
    payload.set(data);
  } else {
    // Truncate (segCount > MAX_SEGMENTS — clamped above).
    payload = data.subarray(0, expected);
  }
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    width,
    1,
    0,
    gl.RGBA,
    gl.FLOAT,
    payload
  );
  return state.texture;
}

function emptySdf(): SdfValue {
  return { kind: "sdf", root: { kind: "empty" } };
}

export const sdfSplineNode: NodeDefinition = {
  type: "sdf-spline",
  name: "SDF Spline",
  category: "utility",
  description:
    "SDF primitive — signed distance to a spline (flattened to line segments on CPU, looped per-pixel in the SDF shader). Closed splines compose like polygons (use Round / Smooth Union / etc.); open splines act as strokes (unsigned distance — wrap with Round to expand into a fill). Cap is 1024 segments; lower Subdivisions if you have many anchors.",
  backend: "webgl2",
  inputs: [
    { name: "spline", type: "spline", required: true, label: "Spline" },
    { name: "position", type: "position", required: false, label: "Position" },
  ],
  params: [
    {
      name: "subdivisions",
      label: "Subdivisions / curve",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 32,
      step: 1,
      default: 16,
    },
    {
      name: "force_open",
      label: "Force Open (stroke)",
      type: "boolean",
      default: false,
    },
    ...SDF_PAINT_PARAMS,
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.spline;
    if (!src || src.kind !== "spline") {
      return { primary: emptySdf() };
    }
    const splineVal = src as SplineValue;
    const subdivisions = Math.max(
      1,
      Math.round((params.subdivisions as number) ?? 16)
    );
    const forceOpen = !!params.force_open;
    const state = ensureState(ctx, nodeId);

    // Re-flatten only when geometry or subdivision count changes.
    // Most frames hit the cache.
    const tag = `${splineGeomHash(splineVal)}:${subdivisions}`;
    if (
      state.sourceTag !== tag ||
      state.segCount === undefined ||
      !state.texture
    ) {
      const flat = flattenSpline(splineVal, subdivisions);
      const segCount = Math.min(MAX_SEGMENTS, flat.segCount);
      const tex = uploadSegments(ctx, state, flat.segments, segCount);
      if (!tex) return { primary: emptySdf() };
      state.sourceTag = tag;
      state.segCount = segCount;
      state.closed = flat.allClosed;
    }

    const closed = state.closed === true && !forceOpen;
    const out: SdfValue = {
      kind: "sdf",
      root: paintSdf(
        {
          kind: "splineSdf",
          position: rootOfPosition(inputs.position),
          segmentTexture: state.texture!,
          segCount: state.segCount!,
          closed,
        },
        params
      ),
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `sdf-spline:${nodeId}`;
    const state = ctx.state[key] as SplineSdfState | undefined;
    if (state?.texture) ctx.gl.deleteTexture(state.texture);
    delete ctx.state[key];
  },
};
