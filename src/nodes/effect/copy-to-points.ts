import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SplineSubpath,
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
// Pick source (spline / point modes, optional): when the instance
// carries groupIndex tags (i.e. came through a Group node), connecting
// a `pick` image samples it per-target-point to select which group
// index to instance at that point. The sampled luminance in [0, 1]
// maps to an integer index into the sorted distinct groupIndex set.
// Feed a noise image for a pseudo-random assortment; feed a UV / any
// image to drive the assortment spatially.
//
// Image mode runs entirely on the GPU via instanced quads — one
// draw call regardless of point count. The vertex shader fetches
// each instance's transform (position, rotation, scale) from a
// 2-row data texture, so we're not bottlenecked by CPU-side
// drawImage loops or uniform-array size limits.
//
// Spline and point modes are pure CPU math.

// Vertex shader: every instance is a unit quad in [0,1]². For the
// instance with id `gl_InstanceID`, fetch two RGBA32F texels from
// u_xforms (a Nx2 data texture):
//   row 0 = (posX, posY, rotation, scaleX)
//   row 1 = (scaleY, _, _, _)
//
// Per-instance modulation:
//   - u_scaleMul: global scalar multiplier (audio amplitude, etc.)
//   - u_rotateAdd: global additive rotation
//   - u_scaleField + u_useScaleField: optional image sampled at the
//     instance's own UV; R-channel mapped to a multiplier in
//     [u_scaleFieldLo, u_scaleFieldHi]. Lets noise / mask drive
//     per-copy size variation.
//   - u_rotateField + u_useRotateField: optional image sampled at the
//     instance's own UV; R-channel scaled by u_rotateFieldAmount and
//     added to rotation. Lets noise / gradient drive per-copy spin.
//
// Apply scale, rotate around the quad's center, translate to the
// point's UV-space position scaled by the canvas resolution. Quad
// is anchored at its own (0.5, 0.5) so per-instance scale grows
// outward from the point — matches the existing drawImage
// convention "trunk of the tree at the point."
const COPY_INST_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
uniform sampler2D u_xforms;
uniform vec2 u_canvasRes;
uniform vec2 u_instSize;

uniform float u_scaleMul;
uniform float u_rotateAdd;
uniform sampler2D u_scaleField;
uniform int u_useScaleField;
uniform float u_scaleFieldLo;
uniform float u_scaleFieldHi;
uniform sampler2D u_rotateField;
uniform int u_useRotateField;
uniform float u_rotateFieldAmount;

void main() {
  vec4 t1 = texelFetch(u_xforms, ivec2(gl_InstanceID, 0), 0);
  vec4 t2 = texelFetch(u_xforms, ivec2(gl_InstanceID, 1), 0);
  vec2 pos = t1.xy;
  float rot = t1.z;
  float sx = t1.w;
  float sy = t2.x;

  // Per-instance scale modulation.
  float fieldMul = 1.0;
  if (u_useScaleField == 1) {
    // Sample R channel at the instance's UV. Map [0,1] linearly
    // into [lo, hi] so the user can pick the dynamic range.
    float r = texture(u_scaleField, pos).r;
    fieldMul = mix(u_scaleFieldLo, u_scaleFieldHi, r);
  }
  float globalMul = max(0.0, u_scaleMul);
  sx *= fieldMul * globalMul;
  sy *= fieldMul * globalMul;

  // Per-instance rotation modulation. Rotate field maps R [0,1]
  // to [-amount, +amount] so 0.5 = no extra rotation.
  float rotMod = u_rotateAdd;
  if (u_useRotateField == 1) {
    float r = texture(u_rotateField, pos).r;
    rotMod += (r - 0.5) * 2.0 * u_rotateFieldAmount;
  }
  rot += rotMod;

  vec2 local = (a_pos - 0.5) * u_instSize * vec2(sx, sy);
  float c = cos(rot);
  float s = sin(rot);
  vec2 r2 = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vec2 pixel = pos * u_canvasRes + r2;
  vec2 clip = (pixel / u_canvasRes) * 2.0 - 1.0;
  // Pipeline UV is Y-down; clip space is Y-up. Flip vertically.
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_pos;
}`;

const COPY_INST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // Sampling the upstream pipeline texture directly — no Y flip
  // needed (we'd only flip if reading back from a 2D canvas, which
  // the new GPU path no longer does).
  outColor = texture(u_src, v_uv);
}`;

interface CopyState {
  // Scratch canvas for pick-source readback. Created lazily so spline
  // and point modes without a pick input don't allocate.
  pickCanvas: HTMLCanvasElement | null;
  // GPU resources for instanced image-mode rendering. Lazily created
  // on first image-mode eval so spline/point users never pay for
  // them. Lifetime is the node — disposed alongside the node.
  instProgram: WebGLProgram | null;
  instVao: WebGLVertexArrayObject | null;
  instQuadVbo: WebGLBuffer | null;
  instFbo: WebGLFramebuffer | null;
  // Per-instance transform data texture. Width = N (point count),
  // height = 2 (two RGBA32F rows per instance — see VS comment).
  instXformTex: WebGLTexture | null;
  instXformWidth: number;
  // CPU staging buffer for the data-texture upload. Reused across
  // evals; resized when N grows.
  instXformBuf: Float32Array | null;
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
  const s: CopyState = {
    pickCanvas: null,
    instProgram: null,
    instVao: null,
    instQuadVbo: null,
    instFbo: null,
    instXformTex: null,
    instXformWidth: 0,
    instXformBuf: null,
  };
  ctx.state[key] = s;
  return s;
}

// Lazy GL setup — compiles the instanced shader pair, creates the
// quad VAO + a private FBO + the data texture. Only runs the first
// time image mode is actually used on this node; spline/point users
// never pay this cost.
function ensureInstResources(ctx: RenderContext, state: CopyState): boolean {
  const gl = ctx.gl;
  if (!state.instProgram) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return false;
    gl.shaderSource(vs, COPY_INST_VS);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.warn(
        "copy-to-points instanced VS:",
        gl.getShaderInfoLog(vs)
      );
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.shaderSource(fs, COPY_INST_FS);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.warn(
        "copy-to-points instanced FS:",
        gl.getShaderInfoLog(fs)
      );
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn(
        "copy-to-points instanced link:",
        gl.getProgramInfoLog(prog)
      );
      gl.deleteProgram(prog);
      return false;
    }
    state.instProgram = prog;
  }
  if (!state.instQuadVbo || !state.instVao) {
    state.instQuadVbo = gl.createBuffer();
    state.instVao = gl.createVertexArray();
    // Unit-quad corners as a TRIANGLE_STRIP.
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    gl.bindVertexArray(state.instVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.instQuadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    // a_pos is at attribute location 0 — matches the VS's `in vec2 a_pos`.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(null);
  }
  if (!state.instFbo) {
    state.instFbo = gl.createFramebuffer();
  }
  if (!state.instXformTex) {
    state.instXformTex = gl.createTexture();
    if (!state.instXformTex) return false;
    gl.bindTexture(gl.TEXTURE_2D, state.instXformTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  return true;
}

// Builds a luminance sampler from an image input by reading it back
// through a 2D canvas once. Returns a closure that maps UV → 0..1
// luminance. The readback isn't cheap but only runs for spline/point
// modes when a pick is actually connected, and the samples themselves
// are in-memory lookups.
function buildPickSampler(
  ctx: RenderContext,
  state: CopyState,
  pick: ImageValue
): ((u: number, v: number) => number) | null {
  if (pick.width <= 0 || pick.height <= 0) return null;
  const canvas = state.pickCanvas ?? document.createElement("canvas");
  state.pickCanvas = canvas;
  if (canvas.width !== pick.width || canvas.height !== pick.height) {
    canvas.width = pick.width;
    canvas.height = pick.height;
  }
  try {
    ctx.blitToCanvas(pick, canvas);
  } catch {
    return null;
  }
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) return null;
  const img = c2d.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const w = canvas.width;
  const h = canvas.height;
  return (u: number, v: number): number => {
    // UV is Y-up; 2D canvas rows are Y-down. Flip on sample.
    const px = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
    const py = Math.max(0, Math.min(h - 1, Math.floor((1 - v) * h)));
    const i = (py * w + px) * 4;
    return (
      (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
    );
  };
}

// Collects the sorted distinct groupIndex values present on a
// spline's subpaths or a points' points. Untagged items default to 0.
function collectDistinctGroupIndices(
  indices: Array<number | undefined>
): number[] {
  const set = new Set<number>();
  for (const g of indices) set.add(g ?? 0);
  return Array.from(set).sort((a, b) => a - b);
}

// Maps a sampled luminance value to an integer group-index choice.
// Clamps to [0, distinct.length - 1] so a value of exactly 1 still
// lands on the last index rather than rolling over.
function luminanceToIndexPick(
  distinct: number[],
  luma: number
): number | null {
  if (distinct.length === 0) return null;
  const N = distinct.length;
  const raw = Math.floor(luma * N);
  const clamped = Math.max(0, Math.min(N - 1, raw));
  return distinct[clamped];
}

export const copyToPointsNode: NodeDefinition = {
  type: "copy-to-points",
  name: "Copy to Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Duplicate an image, spline, or point at every target point. Each copy respects per-point rotation and scale. The instance anchors at its (0.5, 0.5) center so a scattered tree keeps its trunk on the point. Image mode supports per-instance modulation: scalar inputs drive every copy uniformly (e.g. audio amplitude on `scale_mul` makes everything pulse), and image inputs are sampled at each copy's UV (e.g. noise on `scale_field` gives every copy a different size). For grouped splines / points, an optional `pick` image drives per-target group selection.",
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "instance", type: "image", required: true },
    { name: "pick", type: "image", required: false },
    { name: "scale_mul", type: "scalar", required: false },
    { name: "rotate_add", type: "scalar", required: false },
    { name: "scale_field", type: "image", required: false },
    { name: "rotate_field", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = modeOf(params);
    const instType: SocketType =
      mode === "spline" ? "spline" : mode === "point" ? "points" : "image";
    const base: InputSocketDef[] = [
      { name: "points", type: "points", required: true },
      { name: "instance", type: instType, required: true },
    ];
    // Pick only applies to spline / point modes — image mode has no
    // groupIndex concept, so suppress the socket there.
    if (mode !== "image") {
      base.push({ name: "pick", type: "image", required: false });
    }
    // Per-instance modulation inputs — image mode only. Spline / point
    // outputs are CPU geometry, modulation there should go through
    // dedicated nodes (Jitter for noise, Transform for uniform).
    if (mode === "image") {
      base.push(
        { name: "scale_mul", type: "scalar", required: false, label: "Scale × (uniform)" },
        { name: "rotate_add", type: "scalar", required: false, label: "Rotate + (uniform)" },
        { name: "scale_field", type: "image", required: false, label: "Scale field" },
        { name: "rotate_field", type: "image", required: false, label: "Rotate field" },
      );
    }
    return base;
  },
  params: [
    {
      name: "mode",
      label: "Instance type",
      type: "enum",
      options: ["image", "spline", "point"],
      default: "image",
    },
    // Modulation params — only meaningful in image mode. These give
    // the user knobs to set even before they wire any modulation
    // input; once a corresponding socket is connected, the wired
    // value overrides via the standard exposed-param semantics.
    {
      name: "scale_mul_default",
      label: "Scale × default",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p) => modeOf(p) === "image",
    },
    {
      name: "rotate_add_default",
      label: "Rotate + default (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
      visibleIf: (p) => modeOf(p) === "image",
    },
    {
      name: "scale_field_lo",
      label: "Scale field — black",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      // Map field=0 to 0.5× scale by default — gives a balanced
      // "shrink half / grow half" range when paired with hi=1.5.
      default: 0.5,
      visibleIf: (p) => modeOf(p) === "image",
    },
    {
      name: "scale_field_hi",
      label: "Scale field — white",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1.5,
      visibleIf: (p) => modeOf(p) === "image",
    },
    {
      name: "rotate_field_amount",
      label: "Rotate field amount (rad)",
      type: "scalar",
      min: 0,
      max: Math.PI,
      softMax: Math.PI,
      step: 0.001,
      default: Math.PI,
      visibleIf: (p) => modeOf(p) === "image",
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
    const state = ensureState(ctx, nodeId);

    // ---- spline mode ------------------------------------------------
    if (mode === "spline") {
      const inst = inputs.instance;
      if (!inst || inst.kind !== "spline" || points.length === 0) {
        const empty: SplineValue = { kind: "spline", subpaths: [] };
        return { primary: empty };
      }
      const distinct = collectDistinctGroupIndices(
        inst.subpaths.map((s) => s.groupIndex)
      );
      const pickIn = inputs.pick;
      const sampler =
        pickIn?.kind === "image" && distinct.length > 1
          ? buildPickSampler(ctx, state, pickIn)
          : null;

      const outSubpaths: SplineValue["subpaths"] = [];
      for (const pt of points) {
        // Decide which subpaths to emit for THIS point. Without a
        // sampler, emit every subpath (pre-groupIndex behavior).
        let subpathsForPt: SplineSubpath[];
        if (sampler) {
          const luma = sampler(pt.pos[0], pt.pos[1]);
          const chosen = luminanceToIndexPick(distinct, luma);
          subpathsForPt = inst.subpaths.filter(
            (s) => (s.groupIndex ?? 0) === chosen
          );
        } else {
          subpathsForPt = inst.subpaths;
        }
        const sx = pt.scale?.[0] ?? 1;
        const sy = pt.scale?.[1] ?? 1;
        const rotDeg = ((pt.rotation ?? 0) * 180) / Math.PI;
        for (const sub of subpathsForPt) {
          const transformed = transformSubpath(sub, {
            translateX: pt.pos[0] - 0.5,
            translateY: pt.pos[1] - 0.5,
            pivotX: 0.5,
            pivotY: 0.5,
            rotateDeg: rotDeg,
            scaleX: sx,
            scaleY: sy,
          });
          // Preserve instance groupIndex on the output so downstream
          // per-index nodes can still key off it.
          outSubpaths.push({
            ...transformed,
            groupIndex: sub.groupIndex,
          });
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
      const distinct = collectDistinctGroupIndices(
        srcPoints.map((p) => p.groupIndex)
      );
      const pickIn = inputs.pick;
      const sampler =
        pickIn?.kind === "image" && distinct.length > 1
          ? buildPickSampler(ctx, state, pickIn)
          : null;

      const outPoints: Point[] = [];
      for (const target of points) {
        const tRot = target.rotation ?? 0;
        const tCos = Math.cos(tRot);
        const tSin = Math.sin(tRot);
        const tSx = target.scale?.[0] ?? 1;
        const tSy = target.scale?.[1] ?? 1;
        let srcForTarget: Point[];
        if (sampler) {
          const luma = sampler(target.pos[0], target.pos[1]);
          const chosen = luminanceToIndexPick(distinct, luma);
          srcForTarget = srcPoints.filter(
            (p) => (p.groupIndex ?? 0) === chosen
          );
        } else {
          srcForTarget = srcPoints;
        }
        for (const src of srcForTarget) {
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
            groupIndex: src.groupIndex,
          });
        }
      }
      const out: PointsValue = { kind: "points", points: outPoints };
      return { primary: out };
    }

    // ---- image mode --------------------------------------------------
    // Instanced GPU draw: one drawArraysInstanced regardless of point
    // count. Per-instance transforms ride a small data texture
    // (Nx2 RGBA32F), uploaded once per eval. No CPU readback / 2D-
    // canvas drawImage in the hot path — orders of magnitude faster
    // than the old implementation past ~50 points.
    const output = ctx.allocImage();
    const inst = inputs.instance as ImageValue | undefined;
    if (!inst || inst.kind !== "image" || points.length === 0) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    if (!ensureInstResources(ctx, state)) {
      // Shader compile / GL alloc failed — emit empty rather than
      // crashing the pipeline.
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const gl = ctx.gl;
    const W = ctx.width;
    const H = ctx.height;
    const N = points.length;

    // Pack per-instance transforms. Layout matches the VS:
    //   row 0 = (posX, posY, rotation, scaleX)
    //   row 1 = (scaleY, 0, 0, 0)
    // The data texture is Nx2 RGBA32F, so the buffer is 2 * N * 4
    // floats laid out as [...row0..., ...row1...].
    const needBufFloats = N * 8;
    if (
      !state.instXformBuf ||
      state.instXformBuf.length < needBufFloats
    ) {
      state.instXformBuf = new Float32Array(needBufFloats);
    }
    const buf = state.instXformBuf;
    for (let i = 0; i < N; i++) {
      const pt = points[i];
      // row 0 — instances laid out contiguously starting at index 0
      const o1 = i * 4;
      buf[o1 + 0] = pt.pos[0];
      buf[o1 + 1] = pt.pos[1];
      buf[o1 + 2] = pt.rotation ?? 0;
      buf[o1 + 3] = pt.scale?.[0] ?? 1;
      // row 1 — laid out starting at index N*4 so the texel at
      // (i, 1) is at byte-offset (N + i) * 4 floats.
      const o2 = (N + i) * 4;
      buf[o2 + 0] = pt.scale?.[1] ?? 1;
      buf[o2 + 1] = 0;
      buf[o2 + 2] = 0;
      buf[o2 + 3] = 0;
    }
    // Upload to the data texture. Re-allocate when the width
    // (instance count) changes; otherwise just texSubImage2D the
    // fresh values into place.
    gl.bindTexture(gl.TEXTURE_2D, state.instXformTex!);
    if (state.instXformWidth !== N) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        N,
        2,
        0,
        gl.RGBA,
        gl.FLOAT,
        // The view length must match exactly N*2*4 floats. Slice
        // the staging buffer to exactly the needed length.
        buf.subarray(0, N * 8)
      );
      state.instXformWidth = N;
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        N,
        2,
        gl.RGBA,
        gl.FLOAT,
        buf.subarray(0, N * 8)
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Bind output texture as the framebuffer's color attachment.
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.instFbo!);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      output.texture,
      0
    );
    gl.viewport(0, 0, output.width, output.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Standard alpha-over blending so stacked instances composite
    // like the old drawImage path did.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA
    );
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(state.instProgram!);
    gl.bindVertexArray(state.instVao!);

    // Texture unit 0 → instance image (the thing being copied).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inst.texture);
    gl.uniform1i(
      gl.getUniformLocation(state.instProgram!, "u_src"),
      0
    );
    // Texture unit 1 → per-instance transform data.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.instXformTex!);
    gl.uniform1i(
      gl.getUniformLocation(state.instProgram!, "u_xforms"),
      1
    );
    gl.uniform2f(
      gl.getUniformLocation(state.instProgram!, "u_canvasRes"),
      W,
      H
    );
    gl.uniform2f(
      gl.getUniformLocation(state.instProgram!, "u_instSize"),
      inst.width,
      inst.height
    );

    // Resolve uniform-modulation values: scalar input wins over
    // the matching default param. The audio→scalar coercion path
    // handles `Audio Source` plugged into scale_mul automatically.
    const scaleMulIn = inputs.scale_mul;
    const rotateAddIn = inputs.rotate_add;
    const scaleMul =
      scaleMulIn?.kind === "scalar"
        ? scaleMulIn.value
        : (params.scale_mul_default as number) ?? 1;
    const rotateAdd =
      rotateAddIn?.kind === "scalar"
        ? rotateAddIn.value
        : (params.rotate_add_default as number) ?? 0;
    gl.uniform1f(
      gl.getUniformLocation(state.instProgram!, "u_scaleMul"),
      scaleMul
    );
    gl.uniform1f(
      gl.getUniformLocation(state.instProgram!, "u_rotateAdd"),
      rotateAdd
    );

    // Per-instance image fields. Bind to texture units 2 and 3.
    // When unconnected, the field uniforms stay disabled — the VS
    // skips the texture sample so we don't pay for one and don't
    // need a placeholder texture bound.
    // Narrow once and reuse — TS can't carry the discriminator
    // through a separate boolean variable.
    const scaleFieldImg =
      inputs.scale_field?.kind === "image" ? inputs.scale_field : null;
    const rotateFieldImg =
      inputs.rotate_field?.kind === "image" ? inputs.rotate_field : null;
    const useScaleField = scaleFieldImg ? 1 : 0;
    const useRotateField = rotateFieldImg ? 1 : 0;
    if (scaleFieldImg) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, scaleFieldImg.texture);
    }
    if (rotateFieldImg) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, rotateFieldImg.texture);
    }
    gl.uniform1i(
      gl.getUniformLocation(state.instProgram!, "u_scaleField"),
      2
    );
    gl.uniform1i(
      gl.getUniformLocation(state.instProgram!, "u_useScaleField"),
      useScaleField
    );
    gl.uniform1f(
      gl.getUniformLocation(state.instProgram!, "u_scaleFieldLo"),
      (params.scale_field_lo as number) ?? 0.5
    );
    gl.uniform1f(
      gl.getUniformLocation(state.instProgram!, "u_scaleFieldHi"),
      (params.scale_field_hi as number) ?? 1.5
    );
    gl.uniform1i(
      gl.getUniformLocation(state.instProgram!, "u_rotateField"),
      3
    );
    gl.uniform1i(
      gl.getUniformLocation(state.instProgram!, "u_useRotateField"),
      useRotateField
    );
    gl.uniform1f(
      gl.getUniformLocation(state.instProgram!, "u_rotateFieldAmount"),
      (params.rotate_field_amount as number) ?? Math.PI
    );

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, N);

    // Tear down: unbind so the next node sees clean GL state.
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      null,
      0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { primary: output };
  },

  resolveAuxOutputs(): OutputSocketDef[] {
    return [];
  },

  dispose(ctx, nodeId) {
    const key = `copy-to-points:${nodeId}`;
    const state = ctx.state[key] as CopyState | undefined;
    if (state) {
      const gl = ctx.gl;
      if (state.instProgram) gl.deleteProgram(state.instProgram);
      if (state.instVao) gl.deleteVertexArray(state.instVao);
      if (state.instQuadVbo) gl.deleteBuffer(state.instQuadVbo);
      if (state.instFbo) gl.deleteFramebuffer(state.instFbo);
      if (state.instXformTex) gl.deleteTexture(state.instXformTex);
    }
    delete ctx.state[key];
  },
};
