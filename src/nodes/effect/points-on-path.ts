import type {
  ImageValue,
  NodeDefinition,
  OutputSocketDef,
  PointsValue,
  RenderContext,
  SocketValue,
  UvValue,
} from "@/engine/types";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";
import { pointsFromArray } from "@/engine/points";

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

// Renders positions into the aux UV texture. Positions are sampled from an
// RGBA32F data texture (width = count, height = 1; RG = x,y) by texel index via
// texelFetch — NOT a fixed-size uniform array, so there's no GPU
// uniform-array ceiling and count scales up to MAX_POINTS. The output stays a
// pooled RGBA16F `uv` texture (same precision as the old uniform-array path).
const MAX_POINTS = 4096;
const POSITIONS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform highp sampler2D u_positions;
uniform int u_count;
out vec4 outColor;
void main() {
  int idx = int(floor(v_uv.x * float(u_count)));
  idx = clamp(idx, 0, u_count - 1);
  vec2 p = texelFetch(u_positions, ivec2(idx, 0), 0).xy;
  outColor = vec4(p.x, p.y, 0.0, 1.0);
}`;

interface PointsState {
  vizCanvas: HTMLCanvasElement;
  vizTex: WebGLTexture | null;
  // RGBA32F data texture holding the sampled positions (width = count, 1 row);
  // sampled by POSITIONS_FS. Re-specified each eval when count changes.
  posDataTex: WebGLTexture | null;
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
  // Positions data texture — NEAREST + CLAMP; sampled by exact texel index, so
  // no filtering/wrap ever comes into play. Data (RGBA32F) is uploaded per eval.
  const posTex = gl.createTexture();
  if (!posTex)
    throw new Error("points-on-path: failed to create positions data texture");
  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: PointsState = {
    vizCanvas: document.createElement("canvas"),
    vizTex: tex,
    posDataTex: posTex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const pointsOnPathNode: NodeDefinition = {
  type: "points-on-path",
  name: "Points on Path",
  category: "point",
  subcategory: "generator",
  description:
    "Emit N evenly-spaced positions along a spline. Optionally aligns each point's rotation to the path tangent or normal, so Copy-to-Points orients copies along the path. Turn on Animate to slide the points along the path with the Offset slider — points that reach the end wrap back to the start (a continuous stream; keyframe Offset or wire a Scene Time / LFO ramp to drive it). Primary output is a `points` value for direct wiring into Copy-to-Points / Set Position / etc. Aux outputs: a UV texture of positions (one pixel per point) and a dot visualization image.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: MAX_POINTS,
      softMax: 1024,
      step: 1,
      default: 24,
    },
    {
      // Slide points along the path (see `offset`). Off = the original
      // static distribution (back-compat with every existing save).
      name: "animate",
      label: "Animate",
      type: "boolean",
      default: false,
    },
    {
      // Fraction of the total arc length to slide every point along the
      // path; wraps at the end so a point leaving the tip re-enters at the
      // start (0..1 = one full loop). Keyframe it or wire a Scene Time / LFO
      // ramp for continuous flow. Values outside [0,1] (from a wire) wrap
      // too; negative runs the stream backward. In animate mode points are
      // distributed as a uniform loop (count divisions) so they stay evenly
      // spaced across the wrap seam instead of colliding at a shared endpoint.
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) => !!p.animate,
    },
    {
      // Bake a per-point orientation into each point's `rotation`
      // attribute from the path's local direction, so downstream
      // Copy-to-Points / Transform orients each copy along the path.
      // `tangent` = angle of travel; `normal` = perpendicular (+90°).
      // `off` leaves rotation at 0 (back-compat with older saves).
      name: "align",
      label: "Align to path",
      type: "enum",
      options: ["off", "tangent", "normal"],
      control: "segmented",
      default: "off",
    },
    {
      // Extra spin added on top of the aligned angle (degrees). Handy to
      // flip a normal 180° or nudge the facing. Hidden when not aligning.
      name: "align_offset",
      label: "Angle offset",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.align !== "off",
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
  primaryOutput: "points",
  auxOutputs: [
    { name: "positions", type: "uv" },
    // Dot visualization image — auxiliary; useful for previewing the
    // sample positions on canvas. Wire it into a Merge or Output if
    // you want it rendered.
    { name: "viz", type: "image" },
  ],
  // The viz aux is skipped when nothing consumes it (below). This def is
  // cacheable, so the consumed-handle set must fold into the fingerprint —
  // without it, wiring the viz for the first time would cache-hit and hand
  // back a texture that was never rendered. See NodeDefinition.gatesOutputs.
  gatesOutputs: true,

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const src = inputs.path;
    const W = ctx.width;
    const H = ctx.height;
    const state = ensureState(ctx, nodeId);

    // Collect sample positions (normalized Y-DOWN). Bounded by MAX_POINTS as a
    // sanity ceiling (the positions data texture + CPU points scale to it).
    const count = Math.max(
      1,
      Math.min(MAX_POINTS, Math.floor((params.count as number) ?? 24))
    );
    const positions: Array<[number, number]> = [];
    // Per-point orientation (radians), baked from the path tangent when
    // `align` is on. Parallel to `positions` for the sampled prefix.
    const rotations: number[] = [];
    // Resolve the alignment mode once. tangent is a unit vec2 in the same
    // normalized Y-DOWN space as positions, so atan2(ty, tx) is the angle
    // that orients a shape's +X axis along the direction of travel.
    const align = (params.align as string) ?? "off";
    const alignOffsetRad = (((params.align_offset as number) ?? 0) * Math.PI) / 180;
    const angleFor = (tangent: [number, number]): number => {
      if (align === "off") return 0;
      const base = Math.atan2(tangent[1], tangent[0]);
      const normal = align === "normal" ? Math.PI / 2 : 0;
      return base + normal + alignOffsetRad;
    };
    // Track how many of those positions are actual samples vs. the
    // zero padding below — the points aux output needs to know so it
    // doesn't emit `count` phantom points at (0,0) when the input is
    // missing.
    let sampledCount = 0;
    const animate = !!params.animate;
    const offset = (params.offset as number) ?? 0;
    if (src && src.kind === "spline") {
      const lengths = measureSpline(src);
      if (lengths.total > 0) {
        // Static distribution: for open paths, include both endpoints; for a
        // closed spline the last sample would coincide with the first, so stop
        // just before that to avoid a duplicate.
        const hasClosed = src.subpaths.some((s) => s.closed);
        const divisor = hasClosed ? count : Math.max(1, count - 1);
        for (let i = 0; i < count; i++) {
          let t: number;
          if (animate) {
            // Uniform loop (divisor = count) so points stay evenly spaced
            // across the wrap seam; slide by `offset` and wrap into [0,1).
            // A point crossing t=1 re-enters at t=0 — the "kill at the end,
            // respawn at the start" behavior (a seam-free circulation on a
            // closed path; a visible teleport on an open one, as intended).
            t = i / count + offset;
            t -= Math.floor(t);
          } else {
            t = count === 1 ? 0 : i / divisor;
          }
          const s = sampleSplineAt(src, lengths, t);
          positions.push(s.pos);
          rotations.push(angleFor(s.tangent));
        }
        sampledCount = count;
      }
    }

    // ---- Aux: dot-visualization image ----
    // Full-canvas Canvas2D repaint + upload + fullscreen pass — built ONLY
    // when something actually consumes it (a wire, or the viewport preview).
    // With Animate on, the repaint re-runs every frame, so an unconsumed viz
    // was a full-canvas GPU pass + a canvas-sized upload for nothing.
    // `gatesOutputs` on the def makes this safe for a cacheable node; the
    // sig check below still repaints correctly on first consumption because
    // lastSig only advances when the viz is actually built.
    const wantViz = !consumedOutputs || consumedOutputs.has("aux:viz");
    let image: ImageValue | null = null;
    if (wantViz) {
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

      image = ctx.allocImage();
      const vizProg = ctx.getShader("points-on-path/viz", VIZ_FS);
      ctx.drawFullscreen(vizProg, image, (gl2) => {
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, state.vizTex);
        gl2.uniform1i(gl2.getUniformLocation(vizProg, "u_src"), 0);
      });
    }

    // ---- Aux: positions UV texture, width=count, height=1 ----
    const positionsTex: UvValue = ctx.allocUv({ width: count, height: 1 });
    const posProg = ctx.getShader("points-on-path/positions", POSITIONS_FS);
    // Upload the sampled positions into the RGBA32F data texture (count×1,
    // RG = x,y) that the shader reads by texel index. Any unsampled tail (from
    // a missing input) stays zero. Replaces the old vec2[256] uniform array,
    // so the ceiling is MAX_POINTS with no GPU uniform-array limit.
    const data = new Float32Array(count * 4);
    const n = Math.min(positions.length, count);
    for (let i = 0; i < n; i++) {
      data[i * 4] = positions[i][0];
      data[i * 4 + 1] = positions[i][1];
      data[i * 4 + 3] = 1;
    }
    const glp = ctx.gl;
    glp.bindTexture(glp.TEXTURE_2D, state.posDataTex);
    glp.texImage2D(
      glp.TEXTURE_2D,
      0,
      glp.RGBA32F,
      count,
      1,
      0,
      glp.RGBA,
      glp.FLOAT,
      data
    );
    glp.bindTexture(glp.TEXTURE_2D, null);
    ctx.drawFullscreen(posProg, positionsTex, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.posDataTex);
      gl2.uniform1i(gl2.getUniformLocation(posProg, "u_positions"), 0);
      gl2.uniform1i(gl2.getUniformLocation(posProg, "u_count"), count);
    });

    // ---- Aux: points (CPU-side) ----
    // Use `sampledCount` rather than `count` so missing / empty
    // inputs yield an empty points value instead of a stack at origin.
    const pointsValue: PointsValue = pointsFromArray(
      positions.slice(0, sampledCount).map((p, i) => ({
        pos: [p[0], p[1]],
        rotation: rotations[i],
        scale: [1, 1],
      }))
    );

    const aux: Record<string, SocketValue> = { positions: positionsTex };
    if (image) aux.viz = image;
    return { primary: pointsValue, aux };
  },

  dispose(ctx, nodeId) {
    const key = `points-on-path:${nodeId}`;
    const state = ctx.state[key] as PointsState | undefined;
    if (state?.vizTex) ctx.gl.deleteTexture(state.vizTex);
    if (state?.posDataTex) ctx.gl.deleteTexture(state.posDataTex);
    delete ctx.state[key];
  },
};
