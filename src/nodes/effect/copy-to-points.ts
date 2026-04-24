import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { transformSubpath } from "@/engine/spline-transform";

// Duplicate an "instance" at every target point.
//
// The instance type is polymorphic — image, spline, or points — and the
// `mode` param picks which. resolveInputs/resolvePrimaryOutput wire the
// right socket types to match the mode, just like the Transform node.
//
// Convention: the instance is anchored at its own (0.5, 0.5) center.
// Each copy rotates and scales around that anchor, then translates so
// the anchor lands at the target point's `pos`. Matches user intuition
// that "a scattered tree at point P has its trunk at P."
//
// Image mode uses a 2D-canvas readback → draw-at-each-point → upload
// back to GL. CPU-bound but easy; fine up to a few hundred copies.
// Spline and point modes are pure CPU math.

const COPY_BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // 2D canvas is row-0-top; pipeline is Y-up. Flip on sample.
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface CopyState {
  instanceCanvas: HTMLCanvasElement;
  outputCanvas: HTMLCanvasElement;
  outputTex: WebGLTexture | null;
  lastSig: string | null;
}

function modeOf(params: Record<string, unknown>): "image" | "spline" | "point" {
  const m = params.mode;
  if (m === "spline") return "spline";
  if (m === "point") return "point";
  return "image";
}

function ensureState(ctx: RenderContext, nodeId: string): CopyState {
  const key = `copy-to-points:${nodeId}`;
  const existing = ctx.state[key] as CopyState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("copy-to-points: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: CopyState = {
    instanceCanvas: document.createElement("canvas"),
    outputCanvas: document.createElement("canvas"),
    outputTex: tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const copyToPointsNode: NodeDefinition = {
  type: "copy-to-points",
  name: "Copy to Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Duplicate an image, spline, or point at every target point. Each copy respects per-point rotation and scale. The instance anchors at its (0.5, 0.5) center so a scattered tree keeps its trunk on the point.",
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "instance", type: "image", required: true },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = modeOf(params);
    const instType: SocketType =
      mode === "spline" ? "spline" : mode === "point" ? "points" : "image";
    return [
      { name: "points", type: "points", required: true },
      { name: "instance", type: instType, required: true },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Instance type",
      type: "enum",
      options: ["image", "spline", "point"],
      default: "image",
    },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params): SocketType {
    const mode = modeOf(params);
    if (mode === "spline") return "spline";
    if (mode === "point") return "points";
    return "image";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const mode = modeOf(params);
    const pts = inputs.points;
    const points = pts?.kind === "points" ? pts.points : [];

    // ---- spline mode ------------------------------------------------
    if (mode === "spline") {
      const inst = inputs.instance;
      if (!inst || inst.kind !== "spline" || points.length === 0) {
        const empty: SplineValue = { kind: "spline", subpaths: [] };
        return { primary: empty };
      }
      const outSubpaths: SplineValue["subpaths"] = [];
      for (const pt of points) {
        const sx = pt.scale?.[0] ?? 1;
        const sy = pt.scale?.[1] ?? 1;
        const rotDeg = ((pt.rotation ?? 0) * 180) / Math.PI;
        for (const sub of inst.subpaths) {
          outSubpaths.push(
            transformSubpath(sub, {
              translateX: pt.pos[0] - 0.5,
              translateY: pt.pos[1] - 0.5,
              pivotX: 0.5,
              pivotY: 0.5,
              rotateDeg: rotDeg,
              scaleX: sx,
              scaleY: sy,
            })
          );
        }
      }
      const out: SplineValue = { kind: "spline", subpaths: outSubpaths };
      return { primary: out };
    }

    // ---- point mode (Cartesian product) ----------------------------
    if (mode === "point") {
      const inst = inputs.instance;
      const srcPoints =
        inst?.kind === "points" ? inst.points : [];
      if (points.length === 0 || srcPoints.length === 0) {
        const empty: PointsValue = { kind: "points", points: [] };
        return { primary: empty };
      }
      const outPoints: Point[] = [];
      for (const target of points) {
        const tRot = target.rotation ?? 0;
        const tCos = Math.cos(tRot);
        const tSin = Math.sin(tRot);
        const tSx = target.scale?.[0] ?? 1;
        const tSy = target.scale?.[1] ?? 1;
        for (const src of srcPoints) {
          // Translate source's (0.5, 0.5) anchor to (0, 0), apply
          // target's rotate/scale, then translate to target.pos.
          const dx = (src.pos[0] - 0.5) * tSx;
          const dy = (src.pos[1] - 0.5) * tSy;
          const rx = tCos * dx - tSin * dy;
          const ry = tSin * dx + tCos * dy;
          outPoints.push({
            pos: [target.pos[0] + rx, target.pos[1] + ry],
            rotation: (src.rotation ?? 0) + tRot,
            scale: [
              (src.scale?.[0] ?? 1) * tSx,
              (src.scale?.[1] ?? 1) * tSy,
            ],
          });
        }
      }
      const out: PointsValue = { kind: "points", points: outPoints };
      return { primary: out };
    }

    // ---- image mode --------------------------------------------------
    const output = ctx.allocImage();
    const inst = inputs.instance as ImageValue | undefined;
    if (!inst || inst.kind !== "image" || points.length === 0) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const state = ensureState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    // Signature: instance texture identity + point list + canvas size.
    // When the instance texture re-allocates (upstream re-eval), identity
    // changes and we re-raster.
    const sig = JSON.stringify({
      tex: (inst.texture as unknown as { __id__?: number }).__id__ ?? 0,
      tw: inst.width,
      th: inst.height,
      pts: points,
      W,
      H,
    });

    // The sig above doesn't include the texture bit-pattern, so an
    // identical texture identity with new pixels won't bust the cache.
    // To be safe we invalidate every eval when in image mode — this is
    // still cheap vs. downloading every frame if the source is static.
    // TODO: a proper content hash (via a tiny sentinel uniform or a
    // hash-of-sig with texture pointer) would let us skip on true
    // no-op evals. For now the repaint cost is bounded by 2D canvas
    // drawImage speed, which handles hundreds of copies comfortably.
    const needsRepaint = sig !== state.lastSig;

    if (needsRepaint || true) {
      // Readback instance to a 2D canvas at its full resolution. Used
      // as the source for every drawImage call below.
      if (
        state.instanceCanvas.width !== inst.width ||
        state.instanceCanvas.height !== inst.height
      ) {
        state.instanceCanvas.width = inst.width;
        state.instanceCanvas.height = inst.height;
      }
      try {
        ctx.blitToCanvas(inst, state.instanceCanvas);
      } catch {
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }

      if (state.outputCanvas.width !== W || state.outputCanvas.height !== H) {
        state.outputCanvas.width = W;
        state.outputCanvas.height = H;
      }
      const c2d = state.outputCanvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        // The instance is anchored at its own (0.5, 0.5) center — i.e.
        // (instW/2, instH/2) in pixel space. translate, rotate, and
        // scale around that center for each point.
        const iw = inst.width;
        const ih = inst.height;
        for (const pt of points) {
          const sx = pt.scale?.[0] ?? 1;
          const sy = pt.scale?.[1] ?? 1;
          const rot = pt.rotation ?? 0;
          c2d.save();
          c2d.translate(pt.pos[0] * W, pt.pos[1] * H);
          if (rot !== 0) c2d.rotate(rot);
          if (sx !== 1 || sy !== 1) c2d.scale(sx, sy);
          c2d.drawImage(state.instanceCanvas, -iw / 2, -ih / 2, iw, ih);
          c2d.restore();
        }

        const gl = ctx.gl;
        gl.bindTexture(gl.TEXTURE_2D, state.outputTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          state.outputCanvas
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      state.lastSig = sig;
    }

    const prog = ctx.getShader("copy-to-points/blit", COPY_BLIT_FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.outputTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: output };
  },

  resolveAuxOutputs(): OutputSocketDef[] {
    return [];
  },

  dispose(ctx, nodeId) {
    const key = `copy-to-points:${nodeId}`;
    const state = ctx.state[key] as CopyState | undefined;
    if (state?.outputTex) ctx.gl.deleteTexture(state.outputTex);
    delete ctx.state[key];
  },
};
