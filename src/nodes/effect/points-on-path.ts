import type {
  NodeDefinition,
  OutputSocketDef,
  PointsValue,
  RenderContext,
  UvValue,
} from "@/engine/types";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";

// Emit N evenly-spaced positions along the total arc length of a spline.
//
// Primary output: a canvas-sized IMAGE visualization (dots at each sample
// position) so you can see what the node is doing. Useful on its own as a
// dotted-line render, and as a quick sanity check while wiring.
//
// Aux output: `positions` — a UV texture of width=count, height=1. Pixel i
// encodes (R=x, G=y) of sample i in normalized [0,1]² Y-DOWN. That's the
// same layout an N×1 Array grid samples with (each cell's center UV
// (i+0.5)/N, 0.5 lines up with pixel i's center). Because the UV storage
// is half-float, position precision is ~11 bits per axis — well beyond any
// visible error at typical canvas sizes.

const VIZ_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // 2D canvas is row-0-top; flip Y on sample to match Y-up pipeline.
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

// Renders positions into the aux UV texture. Positions come in as a uniform
// vec2 array; for pixel i (of `count` pixels) we emit its position as RG.
// Max array size 256 — WebGL 2 guarantees space for this and it covers
// every realistic path-scatter use case.
const MAX_POINTS = 256;
const POSITIONS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_positions[${MAX_POINTS}];
uniform int u_count;
out vec4 outColor;
void main() {
  int idx = int(floor(v_uv.x * float(u_count)));
  idx = clamp(idx, 0, u_count - 1);
  vec2 p = u_positions[idx];
  outColor = vec4(p.x, p.y, 0.0, 1.0);
}`;

interface PointsState {
  vizCanvas: HTMLCanvasElement;
  vizTex: WebGLTexture | null;
  lastSig: string | null;
}

function hexToRgba(hex: string, alpha = 1): string {
  const h = hex.replace("#", "");
  let r = 0, g = 0, b = 0, a = alpha;
  if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function ensureState(ctx: RenderContext, nodeId: string): PointsState {
  const key = `points-on-path:${nodeId}`;
  const existing = ctx.state[key] as PointsState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("points-on-path: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: PointsState = {
    vizCanvas: document.createElement("canvas"),
    vizTex: tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const pointsOnPathNode: NodeDefinition = {
  type: "points-on-path",
  name: "Points on Path",
  category: "effect",
  description:
    "Emit N evenly-spaced positions along a spline. Primary output is a dot visualization; aux output 'positions' is a UV texture (one pixel per point) for downstream sampling.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: MAX_POINTS,
      softMax: 64,
      step: 1,
      default: 24,
    },
    {
      name: "dot_radius",
      label: "Dot radius (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 10,
      step: 0.5,
      default: 3,
    },
    {
      name: "dot_color",
      label: "Dot color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "show_viz",
      label: "Show visualization",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    { name: "positions", type: "uv" },
    // CPU-side points value — same samples as the UV texture, just
    // as a native `points` socket so Copy-to-Points, Set Position,
    // Transform (point mode), etc. can consume them without a
    // sample-from-image round trip.
    { name: "points", type: "points" },
  ],
  resolveAuxOutputs(): OutputSocketDef[] {
    return [{ name: "positions", type: "uv" }];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    const W = ctx.width;
    const H = ctx.height;
    const state = ensureState(ctx, nodeId);

    // Collect sample positions (normalized Y-DOWN). Cap at MAX_POINTS so the
    // shader's uniform array size stays in bounds.
    const count = Math.max(
      1,
      Math.min(MAX_POINTS, Math.floor((params.count as number) ?? 24))
    );
    const positions: Array<[number, number]> = [];
    // Track how many of those positions are actual samples vs. the
    // zero padding below — the points aux output needs to know so it
    // doesn't emit `count` phantom points at (0,0) when the input is
    // missing.
    let sampledCount = 0;
    if (src && src.kind === "spline") {
      const lengths = measureSpline(src);
      if (lengths.total > 0) {
        // Distribute: for open paths, include both endpoints. For a closed
        // spline, the last sample would coincide with the first, so stop
        // just before that to avoid a duplicate.
        const hasClosed = src.subpaths.some((s) => s.closed);
        const divisor = hasClosed ? count : Math.max(1, count - 1);
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0 : i / divisor;
          const s = sampleSplineAt(src, lengths, t);
          positions.push(s.pos);
        }
        sampledCount = count;
      }
    }
    // Pad with zeros so the uniform upload is always full-sized (avoids
    // re-linking the shader when count changes).
    while (positions.length < MAX_POINTS) positions.push([0, 0]);

    // ---- Primary: visualization image ----
    const showViz = !!params.show_viz;
    const vizSig = JSON.stringify({
      pos: positions.slice(0, count),
      r: params.dot_radius,
      c: params.dot_color,
      sv: showViz,
      W,
      H,
    });
    const needsRepaint = vizSig !== state.lastSig;
    if (needsRepaint) {
      const canvas = state.vizCanvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        if (showViz && positions.length > 0 && src?.kind === "spline") {
          c2d.fillStyle = hexToRgba((params.dot_color as string) ?? "#ffffff");
          const r = Math.max(0, (params.dot_radius as number) ?? 3);
          for (let i = 0; i < count; i++) {
            const p = positions[i];
            c2d.beginPath();
            c2d.arc(p[0] * W, p[1] * H, r, 0, Math.PI * 2);
            c2d.fill();
          }
        }
        const gl = ctx.gl;
        gl.bindTexture(gl.TEXTURE_2D, state.vizTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          canvas
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      state.lastSig = vizSig;
    }

    const image = ctx.allocImage();
    const vizProg = ctx.getShader("points-on-path/viz", VIZ_FS);
    ctx.drawFullscreen(vizProg, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.vizTex);
      gl2.uniform1i(gl2.getUniformLocation(vizProg, "u_src"), 0);
    });

    // ---- Aux: positions UV texture, width=count, height=1 ----
    const positionsTex: UvValue = ctx.allocUv({ width: count, height: 1 });
    const posProg = ctx.getShader("points-on-path/positions", POSITIONS_FS);
    // Flatten to Float32Array — uniform2fv accepts sequential (x,y) pairs.
    const flat = new Float32Array(MAX_POINTS * 2);
    for (let i = 0; i < MAX_POINTS; i++) {
      flat[i * 2] = positions[i][0];
      flat[i * 2 + 1] = positions[i][1];
    }
    ctx.drawFullscreen(posProg, positionsTex, (gl2) => {
      gl2.uniform2fv(gl2.getUniformLocation(posProg, "u_positions"), flat);
      gl2.uniform1i(gl2.getUniformLocation(posProg, "u_count"), count);
    });

    // ---- Aux: points (CPU-side) ----
    // Use `sampledCount` rather than `count` so missing / empty
    // inputs yield an empty points value instead of a stack at origin.
    const pointsValue: PointsValue = {
      kind: "points",
      points: positions.slice(0, sampledCount).map((p) => ({
        pos: [p[0], p[1]],
        rotation: 0,
        scale: [1, 1],
      })),
    };

    return {
      primary: image,
      aux: { positions: positionsTex, points: pointsValue },
    };
  },

  dispose(ctx, nodeId) {
    const key = `points-on-path:${nodeId}`;
    const state = ctx.state[key] as PointsState | undefined;
    if (state?.vizTex) ctx.gl.deleteTexture(state.vizTex);
    delete ctx.state[key];
  },
};
