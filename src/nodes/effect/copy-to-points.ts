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
import {
  ensurePointArray,
  gatherAttributes,
  pointsFromArray,
} from "@/engine/points";
import { renderStyledTextToImage } from "@/engine/text-raster";

// Duplicate an "instance" at every target point.
//
// The instance type is polymorphic — image, spline, or points — and the
// `mode` param picks which. resolveInputs/resolvePrimaryOutput wire the
// right socket types to match the mode, just like the Transform node.
//
// Anchor: each copy rotates and scales around its anchor, then
// translates so the anchor lands at the target point's `pos`. The
// `anchor` param picks it: "content center" (default — the instance's
// visible bounds center; for images this also crops each quad to the
// alpha bbox, a big fill-rate win), "canvas center" (the legacy
// (0.5, 0.5) convention — nodes saved before the param keep it), or
// "custom" (explicit X/Y). Matches user intuition that "a scattered
// tree at point P has its trunk at P."
//
// Variant pick: when the instance carries variants — groupIndex tags
// on splines / points, or the items of an image group — `pick_mode`
// chooses which variant lands on each target point:
//   all          every variant at every point (default)
//   image        sample the `pick` input's luminance at the point;
//                [0,1] maps to an index into the variant set
//                (noise → spatial assortment)
//   random       seeded per-point hash, no wiring needed
//   cycle        round-robin by target point index
//   by index     pair variant i with target point i (1:1, clamped) —
//                lands Points-to-Text's string[i] on point[i]
//   target group pair the target point's own groupIndex with the
//                matching variant
// Nodes saved before pick_mode existed behaved image-driven whenever a
// pick was wired; a missing param resolves to "image" for them.
//
// Aspect note: authored UV maps to pixels uniformly (see
// engine/aspect.ts — y offsets scale by W just like x), so rotating
// offsets in UV space here renders undistorted; the GPU path's center
// remap is that same mapping. The three modes agree on non-square
// canvases by construction.
//
// Image mode runs entirely on the GPU via instanced quads — one
// draw call regardless of point count. The vertex shader fetches
// each instance's transform (position, rotation, scale) from a
// 2-row data texture, so we're not bottlenecked by CPU-side
// drawImage loops or uniform-array size limits.
//
// Spline and point modes are pure CPU math.

// Vertex shader: every instance is a unit quad in [0,1]². For the
// instance with id `gl_InstanceID`, fetch three RGBA32F texels from
// u_xforms — a tiled data texture, u_xformTileW instances per row-triple
// (instance counts beyond MAX_TEXTURE_SIZE would fail as a single row;
// tiling removes the ceiling):
//   row 3k   = (posX, posY, rotation, scaleX)
//   row 3k+1 = (scaleY, tintR, tintG, tintB)
//   row 3k+2 = (opacity, _, _, _)     ← two slots still free (M4)
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
uniform int u_xformTileW;
// First transform slot for this draw — image-group variants issue one
// draw per item over a contiguous segment of the packed transforms.
uniform int u_instBase;
uniform vec2 u_canvasRes;
uniform vec2 u_instSize;
// Sampled sub-rect of the instance image (x, y, w, h in its UV space).
// Full image = (0,0,1,1); the content-center anchor crops to the alpha
// bbox so mostly-transparent instances stop costing full-canvas fill.
uniform vec4 u_uvRect;
// Anchor within the sub-rect (normalized). The anchor lands on the
// target point and is the rotate/scale pivot.
uniform vec2 u_anchor;

uniform float u_scaleMul;
uniform float u_rotateAdd;
uniform sampler2D u_scaleField;
uniform int u_useScaleField;
uniform float u_scaleFieldLo;
uniform float u_scaleFieldHi;
uniform sampler2D u_rotateField;
uniform int u_useRotateField;
uniform float u_rotateFieldAmount;
// Per-instance tint + opacity from named point channels — packed into
// the second and third rows (081326_point-attributes.md M4). Opacity
// packs its OFF state as 1.0, so no enable uniform is needed.
uniform int u_useTint;
out vec3 v_tint;
out float v_opacity;

void main() {
  int id = gl_InstanceID + u_instBase;
  ivec2 cell = ivec2(id % u_xformTileW, (id / u_xformTileW) * 3);
  vec4 t1 = texelFetch(u_xforms, cell, 0);
  vec4 t2 = texelFetch(u_xforms, cell + ivec2(0, 1), 0);
  vec4 t3 = texelFetch(u_xforms, cell + ivec2(0, 2), 0);
  vec2 pos = t1.xy;
  float rot = t1.z;
  float sx = t1.w;
  float sy = t2.x;
  v_tint = u_useTint == 1 ? t2.yzw : vec3(1.0);
  v_opacity = t3.x;

  // Aspect-correct the instance center so copies sit on the rendered points
  // (and on aspect-corrected geometry); the instance quad stays in pixels, so
  // it remains round. Square canvas = no change. Computed BEFORE the field
  // sampling below — fields must sample at the instance's true canvas
  // position, not its authored one.
  float aspect = u_canvasRes.x / u_canvasRes.y;
  vec2 center = vec2(pos.x, 0.5 + (pos.y - 0.5) * aspect);
  // Field sample UV: center is canvas Y-DOWN; textures sample Y-UP.
  // Sampling the fields at raw authored pos (the old code) drifted on
  // non-square canvases (authored y is aspect-compressed) AND was
  // vertically mirrored — invisible with noise fields, obvious the
  // moment a localized field (Cursor falloff) drives scale.
  vec2 fieldUv = vec2(center.x, 1.0 - center.y);

  // Per-instance scale modulation.
  float fieldMul = 1.0;
  if (u_useScaleField == 1) {
    // Sample R channel at the instance's canvas position. Map [0,1]
    // linearly into [lo, hi] so the user can pick the dynamic range.
    float r = texture(u_scaleField, fieldUv).r;
    fieldMul = mix(u_scaleFieldLo, u_scaleFieldHi, r);
  }
  // Unclamped on purpose — a negative multiplier point-mirrors copies
  // through their anchor. Matches the CPU modes.
  sx *= fieldMul * u_scaleMul;
  sy *= fieldMul * u_scaleMul;

  // Per-instance rotation modulation. Rotate field maps R [0,1]
  // to [-amount, +amount] so 0.5 = no extra rotation.
  float rotMod = u_rotateAdd;
  if (u_useRotateField == 1) {
    float r = texture(u_rotateField, fieldUv).r;
    rotMod += (r - 0.5) * 2.0 * u_rotateFieldAmount;
  }
  rot += rotMod;

  vec2 local = (a_pos - u_anchor) * u_instSize * u_uvRect.zw * vec2(sx, sy);
  float c = cos(rot);
  float s = sin(rot);
  vec2 r2 = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vec2 pixel = center * u_canvasRes + r2;
  vec2 clip = (pixel / u_canvasRes) * 2.0 - 1.0;
  // Pipeline UV is Y-down; clip space is Y-up. Flip vertically.
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  // The whole quad is laid out Y-DOWN — the point center, the clip flip
  // above, and the content rect (getContentRect reads back row 0 = visual
  // top) are all Y-down — but GL textures sample Y-UP. Convert v here so
  // the instance lands upright AND the alpha-bbox crop selects the right
  // region; sampling the Y-down rect as-is mirrored every copy vertically
  // (and pulled off-center content from the wrong half of the source).
  v_uv = vec2(u_uvRect.x + a_pos.x * u_uvRect.z,
              1.0 - (u_uvRect.y + a_pos.y * u_uvRect.w));
}`;

const COPY_INST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_tint;
in float v_opacity;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // v_uv already carries the Y-down→Y-up conversion (see the VS), so we
  // sample the upstream pipeline texture directly here. The per-instance
  // tint multiplies rgb only, opacity multiplies alpha only — straight
  // alpha throughout (engine invariant); both are 1.0 when no channel is
  // chosen.
  outColor = texture(u_src, v_uv);
  outColor.rgb *= v_tint;
  outColor.a *= v_opacity;
}`;

// CPU-side luminance samplers built from image inputs (pick / scale
// field / rotate field). Cached per slot, keyed on the source
// ImageValue's identity — the evaluator hands back the same value
// object while an upstream is cached, so identity ⇒ same pixels.
type LumaSampler = (u: number, v: number) => number;
type SamplerSlot = "pick" | "scale" | "rotate";
interface LumaSamplerEntry {
  src: ImageValue;
  sample: LumaSampler;
}

// UV-space sub-rect of an instance image (Y-down, like all authored UVs).
interface UvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const FULL_RECT: UvRect = { x: 0, y: 0, w: 1, h: 1 };

interface CopyState {
  samplers: Partial<Record<SamplerSlot, LumaSamplerEntry>>;
  // Alpha-bbox cache for the content-center anchor, keyed on ImageValue
  // identity (same contract as the sampler cache). WeakMap so group
  // items and animated instances don't accumulate.
  contentRects: WeakMap<ImageValue, UvRect>;
  // GPU resources for instanced image-mode rendering. Lazily created
  // on first image-mode eval so spline/point users never pay for
  // them. Lifetime is the node — disposed alongside the node.
  instProgram: WebGLProgram | null;
  instVao: WebGLVertexArrayObject | null;
  instQuadVbo: WebGLBuffer | null;
  instFbo: WebGLFramebuffer | null;
  // Uniform locations, resolved once at link time instead of ~14
  // getUniformLocation calls per draw.
  instLocs: Record<string, WebGLUniformLocation | null> | null;
  // Per-instance transform data texture, tiled XFORM_TILE_W instances
  // per row-pair (two RGBA32F rows per instance — see VS comment).
  instXformTex: WebGLTexture | null;
  instXformWidth: number;
  instXformHeight: number;
  // CPU staging buffer for the data-texture upload. Reused across
  // evals; resized when N grows.
  instXformBuf: Float32Array | null;
  // The PointsValue last packed+uploaded (single-instance path only).
  // Identity match + same ordering ⇒ the texture already holds these
  // transforms; skip the pack and upload.
  lastPoints: PointsValue | null;
  lastOrderKey: string;
  // DOM-attached scratch canvas for text-mode per-copy rasterizing (must
  // be attached for variable-font axes to resolve — see text.ts). Lazily
  // created; only text-mode users pay for it.
  textCanvas: HTMLCanvasElement | null;
}

function modeOf(
  params: Record<string, unknown>
): "image" | "spline" | "point" | "text" {
  const m = params.mode;
  if (m === "spline") return "spline";
  if (m === "point") return "point";
  if (m === "text") return "text";
  return "image";
}

function ensureState(ctx: RenderContext, nodeId: string): CopyState {
  const key = `copy-to-points:${nodeId}`;
  const existing = ctx.state[key] as CopyState | undefined;
  if (existing) return existing;
  const s: CopyState = {
    samplers: {},
    contentRects: new WeakMap(),
    instProgram: null,
    instVao: null,
    instQuadVbo: null,
    instFbo: null,
    instLocs: null,
    instXformTex: null,
    instXformWidth: 0,
    instXformHeight: 0,
    instXformBuf: null,
    lastPoints: null,
    lastOrderKey: "",
    textCanvas: null,
  };
  ctx.state[key] = s;
  return s;
}

// DOM-attached scratch canvas for text-mode rasterizing. Attached off-screen
// so Chromium resolves variable-font axes (same requirement as the Text node).
function ensureTextCanvas(state: CopyState): HTMLCanvasElement {
  if (state.textCanvas) return state.textCanvas;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-toolbox-text-raster", "1");
  canvas.style.position = "fixed";
  canvas.style.left = "-99999px";
  canvas.style.top = "-99999px";
  canvas.style.pointerEvents = "none";
  canvas.style.visibility = "hidden";
  if (typeof document !== "undefined" && document.body) {
    document.body.appendChild(canvas);
  }
  state.textCanvas = canvas;
  return canvas;
}

// Instances per row-pair in the transform data texture. 2048 is the
// WebGL2-guaranteed MAX_TEXTURE_SIZE floor, so the tiled layout works
// on every conformant GPU; height grows as ceil(N / 2048) * 2.
const XFORM_TILE_W = 2048;

const INST_UNIFORMS = [
  "u_src",
  "u_xforms",
  "u_xformTileW",
  "u_instBase",
  "u_canvasRes",
  "u_instSize",
  "u_uvRect",
  "u_anchor",
  "u_scaleMul",
  "u_rotateAdd",
  "u_scaleField",
  "u_useScaleField",
  "u_scaleFieldLo",
  "u_scaleFieldHi",
  "u_rotateField",
  "u_useRotateField",
  "u_rotateFieldAmount",
  "u_useTint",
] as const;

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
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const name of INST_UNIFORMS) {
      locs[name] = gl.getUniformLocation(prog, name);
    }
    state.instLocs = locs;
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

// Builds (and caches) a luminance sampler from an image input. The
// source is rendered DOWNSAMPLED to ≤256px on the long edge before the
// CPU readback — pick / field sources are low-frequency selectors, so
// full-resolution readback (~8 MB at 1080p, per eval) is pure waste.
// Same recipe as Scatter Points' density readback. Cached per slot
// keyed on the ImageValue identity: while the upstream node is cached
// the evaluator hands back the same object, so an animated source
// misses (new value each frame) and a static one hits.
function getLumaSampler(
  ctx: RenderContext,
  state: CopyState,
  slot: SamplerSlot,
  img: ImageValue
): LumaSampler | null {
  const cached = state.samplers[slot];
  if (cached && cached.src === img) return cached.sample;
  if (img.width <= 0 || img.height <= 0) return null;
  const MAX = 256;
  const aspect = img.width / img.height;
  let w: number;
  let h: number;
  if (img.width >= img.height) {
    w = Math.min(MAX, img.width);
    h = Math.max(1, Math.round(w / aspect));
  } else {
    h = Math.min(MAX, img.height);
    w = Math.max(1, Math.round(h * aspect));
  }
  const data = ctx.readImagePixels(img, w, h);
  if (!data) return null;
  // Callers pass AUTHORED point coords; the grid covers the canvas.
  // Convert y (authored is aspect-compressed around 0.5) so the sample
  // lands where the point visually sits — without it, localized fields
  // (Cursor falloff) drifted on non-square canvases. The canvas aspect
  // is the right one even if the texture isn't canvas-sized: display
  // stretches the texture over the canvas.
  const canvasAspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
  const sample: LumaSampler = (u, v) => {
    // Authored y-DOWN → canvas y-DOWN (matches image-data row order —
    // row 0 = visual top — so no flip on the read).
    const vc = 0.5 + (v - 0.5) * canvasAspect;
    const px = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
    const py = Math.max(0, Math.min(h - 1, Math.floor(vc * h)));
    const i = (py * w + px) * 4;
    return (
      (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
    );
  };
  state.samplers[slot] = { src: img, sample };
  return sample;
}

// Deterministic per-point hash → [0, 1). Index-stable so a static
// scatter keeps the same variant assignment frame to frame; the seed
// param reshuffles the whole assignment.
function hash01(index: number, seed: number): number {
  let h = (index * 374761393 + seed * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// Resolve which groupIndex to instance at one target point, per the
// pick mode. `null` means "no filtering — emit every variant" (the
// `all` mode, single-group instances, or image mode with no pick wired).
function chooseVariantGroup(opts: {
  pickMode: string;
  distinct: number[];
  index: number;
  sampler: LumaSampler | null;
  u: number;
  v: number;
  targetGroup: number;
  seed: number;
  // "attribute" mode: the target point's channel value (component 0),
  // already clamped to [0,1] by the caller; null when no channel.
  attrValue?: number | null;
}): number | null {
  const { distinct } = opts;
  const n = distinct.length;
  if (n <= 1) return null;
  switch (opts.pickMode) {
    case "image":
      return opts.sampler
        ? luminanceToIndexPick(distinct, opts.sampler(opts.u, opts.v))
        : null;
    case "attribute":
      // Same [0,1]→variant spread as the image sampler's luminance, so
      // an Index/Random-sourced channel maps predictably.
      return opts.attrValue !== null && opts.attrValue !== undefined
        ? luminanceToIndexPick(distinct, opts.attrValue)
        : null;
    case "random": {
      const r = hash01(opts.index, opts.seed);
      return distinct[Math.min(n - 1, Math.floor(r * n))];
    }
    case "cycle":
      return distinct[opts.index % n];
    case "by index":
      // Pair target point i with variant i (1:1), clamping the tail so a
      // longer/shorter variant set still resolves. This is the parallel
      // pairing Points-to-Text relies on: string[i] lands on point[i].
      return distinct[Math.min(n - 1, opts.index)];
    case "target group": {
      // Pair the target point's own groupIndex with the matching
      // instance group; indices outside the instance's set wrap so
      // mismatched group counts still produce something sensible.
      const g = opts.targetGroup;
      return distinct.includes(g) ? g : distinct[((g % n) + n) % n];
    }
    default:
      return null; // "all"
  }
}

// Alpha bounding box of an image in UV space, from a ≤128px readback,
// cached per ImageValue identity. Drives the "content center" anchor:
// the quad is cropped to visible pixels, which both anchors copies at
// their content and removes the fill cost of transparent margins
// (pipeline images are canvas-sized, so uncropped instances are mostly
// empty quads). Fully-transparent or unreadable images fall back to the
// full rect.
function getContentRect(
  ctx: RenderContext,
  state: CopyState,
  img: ImageValue
): UvRect {
  const cached = state.contentRects.get(img);
  if (cached) return cached;
  let rect = FULL_RECT;
  if (img.width > 0 && img.height > 0) {
    const MAX = 128;
    const aspect = img.width / img.height;
    let w: number;
    let h: number;
    if (img.width >= img.height) {
      w = Math.min(MAX, img.width);
      h = Math.max(1, Math.round(w / aspect));
    } else {
      h = Math.min(MAX, img.height);
      w = Math.max(1, Math.round(h * aspect));
    }
    const data = ctx.readImagePixels(img, w, h);
    if (data) {
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) {
        // Pad one downsampled texel so soft edges don't clip.
        minX = Math.max(0, minX - 1);
        minY = Math.max(0, minY - 1);
        maxX = Math.min(w - 1, maxX + 1);
        maxY = Math.min(h - 1, maxY + 1);
        rect = {
          x: minX / w,
          y: minY / h,
          w: (maxX - minX + 1) / w,
          h: (maxY - minY + 1) / h,
        };
      }
    }
    // Failed readback leaves the full rect, which keeps rendering correct.
  }
  state.contentRects.set(img, rect);
  return rect;
}

// Bounds center of a spline instance's anchor positions — the
// "content center" anchor for spline mode. Null when there are no
// anchors (caller falls back to canvas center).
function splineBoundsCenter(
  subpaths: SplineSubpath[]
): [number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of subpaths) {
    for (const a of s.anchors) {
      if (a.pos[0] < minX) minX = a.pos[0];
      if (a.pos[0] > maxX) maxX = a.pos[0];
      if (a.pos[1] < minY) minY = a.pos[1];
      if (a.pos[1] > maxY) maxY = a.pos[1];
    }
  }
  return Number.isFinite(minX)
    ? [(minX + maxX) / 2, (minY + maxY) / 2]
    : null;
}

// Same for a points instance.
function pointsBoundsCenter(pts: Point[]): [number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.pos[0] < minX) minX = p.pos[0];
    if (p.pos[0] > maxX) maxX = p.pos[0];
    if (p.pos[1] < minY) minY = p.pos[1];
    if (p.pos[1] > maxY) maxY = p.pos[1];
  }
  return Number.isFinite(minX)
    ? [(minX + maxX) / 2, (minY + maxY) / 2]
    : null;
}

// Emission order over the target points. "points order" keeps the
// producer's ordering (null = identity, preserves the fast path).
// "by y" sorts top→bottom so lower copies paint over higher ones — the
// painter's-order pseudo-depth trick. "shuffled" is a seeded
// Fisher–Yates (seeded by pick_seed) for when the producer's order
// creates visible stacking patterns. Variant assignment stays keyed on
// the point's own index, so reordering never reshuffles variants.
function buildDrawOrder(
  pts: PointsValue,
  mode: string,
  seed: number
): Int32Array | null {
  const n = pts.count;
  if (n <= 1) return null;
  if (mode === "by y") {
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const pos = pts.positions;
    order.sort((a, b) => pos[a * 2 + 1] - pos[b * 2 + 1]);
    return order;
  }
  if (mode === "shuffled") {
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(hash01(i, seed ^ 0x9e3779) * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    return order;
  }
  return null;
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
    "Duplicate an image (or image group), spline, or point at every target point. Each copy respects per-point rotation and scale, anchored at the instance's content center (or canvas center / custom). Per-instance modulation works in every mode: scalar inputs drive every copy uniformly (e.g. audio amplitude on `scale_mul` makes everything pulse), and image inputs are sampled at each copy's position (e.g. noise on `scale_field` gives every copy a different size). Variants — grouped splines / points, or image-group items — land per point via the pick mode: all, image-driven (`pick` input), seeded random, cycle, by the target point's own group, or by a named attribute on the target points. In image mode, named attributes can also tint each copy (Tint attribute, rgb) and fade it (Opacity attribute, alpha). Draw order controls stacking (painter's by-y, shuffled). In spline/point modes, Tag copies chooses the groupIndex the copies carry out: the instance's own tags, the copy's index (so downstream per-group styling — Stroke color/thickness sources, Select by Index — varies per copy), or the target point's group.",
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
  resolveInputs(params, ctx): InputSocketDef[] {
    const mode = modeOf(params);
    let instType: SocketType =
      mode === "spline"
        ? "spline"
        : mode === "point"
          ? "points"
          : mode === "text"
            ? "text_instance"
            : "image";
    // Image mode also accepts a homogeneous image group — one variant
    // per item, selected per point by the pick mode. The socket retypes
    // to follow what's actually wired (the evaluator's coercion layer
    // drops mismatched kinds, so the declared type must track the
    // connection — same pattern as Math's uv morphing).
    if (mode === "image" && ctx?.connectedTypes?.instance === "image_group") {
      instType = "image_group";
    }
    const base: InputSocketDef[] = [
      { name: "points", type: "points", required: true },
      { name: "instance", type: instType, required: true },
    ];
    // The pick socket only exists when the variant pick actually reads
    // an image; `undefined` covers nodes saved before the enum, whose
    // behavior was always image-driven.
    const pickMode = params.pick_mode as string | undefined;
    if (pickMode === "image" || pickMode === undefined) {
      base.push({ name: "pick", type: "image", required: false });
    }
    // Per-instance modulation inputs — honored in every mode. Image
    // mode consumes them in the shader; spline / point modes apply the
    // same math on the CPU (fields sampled at each target point).
    base.push(
      { name: "scale_mul", type: "scalar", required: false, label: "Scale × (uniform)" },
      { name: "rotate_add", type: "scalar", required: false, label: "Rotate + (uniform)" },
      { name: "scale_field", type: "image", required: false, label: "Scale field" },
      { name: "rotate_field", type: "image", required: false, label: "Rotate field" },
    );
    return base;
  },
  params: [
    {
      name: "mode",
      label: "Instance type",
      type: "enum",
      // "text" is engaged by wiring a Text node's `instances` output; the
      // instance socket retypes to text_instance and each copy is
      // rasterized from the carried style.
      options: ["image", "spline", "point", "text"],
      default: "image",
    },
    // How to choose which instance variant lands on each target point.
    // Variants are groupIndex groups for spline / point instances, and
    // group items for an image-group instance. "all" stamps every
    // variant at every point; "image" samples the `pick` input's
    // luminance; "random" / "cycle" need no extra wiring; "target
    // group" pairs the target point's own groupIndex with the matching
    // variant.
    {
      name: "pick_mode",
      label: "Variant pick",
      type: "enum",
      // "by index" pairs variant i with target point i (1:1, clamped) — the
      // parallel pairing that lands Points-to-Text's string[i] on point[i].
      // "attribute" reads a named channel on the TARGET points (M4) —
      // same [0,1]→variant mapping as image luminance.
      options: [
        "all",
        "image",
        "random",
        "cycle",
        "by index",
        "target group",
        "attribute",
      ],
      default: "all",
    },
    {
      name: "pick_attr",
      label: "Pick attribute",
      type: "string",
      default: "",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      visibleIf: (p) => p.pick_mode === "attribute",
    },
    {
      name: "pick_seed",
      label: "Pick seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.pick_mode === "random",
    },
    // Where the instance hangs on each target point (also the
    // rotate/scale pivot). "content center" anchors at the instance's
    // visible bounds — and, for images, crops each copy's quad to its
    // alpha bbox, a large fill-rate win on mostly-transparent
    // instances. "canvas center" is the legacy (0.5, 0.5) convention
    // for pre-composed full-frame instances; nodes saved before this
    // param keep it. "custom" exposes explicit anchor X/Y.
    {
      name: "anchor",
      label: "Anchor",
      type: "enum",
      options: ["content center", "canvas center", "custom"],
      default: "content center",
    },
    {
      name: "anchor_x",
      label: "Anchor X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.anchor === "custom",
    },
    {
      name: "anchor_y",
      label: "Anchor Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.anchor === "custom",
    },
    // Stacking order for overlapping copies. "by y" gives the classic
    // painter's-order pseudo-depth (lower copies in front); "shuffled"
    // breaks up producer-order stacking patterns (seeded by pick_seed).
    {
      name: "draw_order",
      label: "Draw order",
      type: "enum",
      options: ["points order", "by y", "shuffled"],
      default: "points order",
    },
    // What groupIndex the emitted copies carry (spline / point modes —
    // image mode flattens, so there's nothing to tag). "instance groups"
    // preserves the instance's own tags (legacy; missing param resolves
    // here). "copy index" tags everything emitted for target point i
    // with i — the identity that lets downstream per-group styling
    // (Stroke's color/thickness sources, Select by Index, Modulate
    // Splines) vary PER COPY instead of per instance-part. "target
    // group" inherits the target point's own groupIndex. Keyed on the
    // point's index, not emission order, so draw_order never reshuffles
    // identity. Spec: 071826_copy-identity-stroke-width.md.
    {
      name: "output_tag",
      label: "Tag copies",
      type: "enum",
      options: ["instance groups", "copy index", "target group"],
      default: "instance groups",
      visibleIf: (p) => p.mode === "spline" || p.mode === "point",
    },
    // Modulation params — honored in every mode (shader in image mode,
    // CPU math in spline / point modes). These give the user knobs to
    // set even before they wire any modulation input; once a
    // corresponding socket is connected, the wired value overrides via
    // the standard exposed-param semantics.
    {
      name: "scale_mul_default",
      label: "Scale × default",
      type: "scalar",
      // Negative point-mirrors copies through their anchor.
      min: -4,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
    {
      name: "rotate_add_default",
      label: "Rotate + default (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
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
    },
    // Per-instance tint + opacity (image mode): multiply each copy's rgb
    // by an arity≥3 named channel, and its alpha by any channel's
    // component 0, both read off the target points — Attribute Transfer
    // a photo's colors onto a scatter, then stamp tinted copies that
    // fade by weight. Empty = off (081326_point-attributes.md M4).
    {
      name: "tint_attr",
      label: "Tint attribute",
      type: "string",
      default: "",
      placeholder: "color attribute",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      visibleIf: (p) => p.mode === "image",
    },
    {
      name: "opacity_attr",
      label: "Opacity attribute",
      type: "string",
      default: "",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      visibleIf: (p) => p.mode === "image",
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
    const ptsValue = pts?.kind === "points" ? pts : null;
    const ptCount = ptsValue?.count ?? 0;
    const state = ensureState(ctx, nodeId);

    // Modulation, resolved once for every mode: scalar input wins over
    // the matching default param (audio→scalar coercion makes `Audio
    // Source` into scale_mul work automatically). Image mode passes
    // these to the shader; spline / point modes apply the same math on
    // the CPU so a wired socket never silently does nothing.
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
    const scaleFieldImg =
      inputs.scale_field?.kind === "image" ? inputs.scale_field : null;
    const rotateFieldImg =
      inputs.rotate_field?.kind === "image" ? inputs.rotate_field : null;
    const fieldLo = (params.scale_field_lo as number) ?? 0.5;
    const fieldHi = (params.scale_field_hi as number) ?? 1.5;
    const rotFieldAmt = (params.rotate_field_amount as number) ?? Math.PI;

    // Variant pick mode. Nodes saved before the enum existed behaved
    // image-driven whenever a pick was wired — a missing param maps to
    // "image" so those projects keep working (unwired, "image" degrades
    // to "all").
    const pickMode = (params.pick_mode as string | undefined) ?? "image";
    const pickSeed = Math.floor((params.pick_seed as number) ?? 0);
    // "attribute" pick: the TARGET point's channel (component 0, clamped
    // to [0,1]) drives which variant lands there — shared by every
    // instance mode, since picking is CPU-side (M4).
    const pickAttrName = ((params.pick_attr as string) ?? "").trim();
    const pickAttr =
      pickMode === "attribute" && pickAttrName && ptsValue
        ? ptsValue.attributes?.[pickAttrName]
        : undefined;
    const pickAttrAt = (i: number): number | null =>
      pickAttr
        ? Math.min(1, Math.max(0, pickAttr.data[i * pickAttr.arity]))
        : null;

    // Anchor. Same legacy rule: nodes saved before the param anchored
    // at canvas center, so a missing value keeps that; new nodes
    // default to "content center".
    const anchorMode = (params.anchor as string | undefined) ?? "canvas center";
    const customAnchor: [number, number] = [
      (params.anchor_x as number) ?? 0.5,
      (params.anchor_y as number) ?? 0.5,
    ];

    // Emission/stacking order over the target points (null = producer
    // order, the fast path).
    const drawOrderMode = (params.draw_order as string) ?? "points order";

    // Copy-identity tagging for the CPU modes (see the param comment).
    const outputTag = (params.output_tag as string) ?? "instance groups";
    const tagFor = (
      instanceTag: number | undefined,
      pointIndex: number,
      targetGroup: number | undefined
    ): number | undefined =>
      outputTag === "copy index"
        ? pointIndex
        : outputTag === "target group"
          ? targetGroup ?? 0
          : instanceTag;
    const order = ptsValue
      ? buildDrawOrder(ptsValue, drawOrderMode, pickSeed)
      : null;

    // Per-target modulation for the CPU modes, mirroring the shader:
    // fields sample luminance at the target point's UV; scale maps
    // [0,1] → [lo,hi] multiplicatively, rotate maps to ±amount.
    const makeModAt = (): ((u: number, v: number) => {
      mul: number;
      rot: number;
    }) => {
      const scaleSampler = scaleFieldImg
        ? getLumaSampler(ctx, state, "scale", scaleFieldImg)
        : null;
      const rotateSampler = rotateFieldImg
        ? getLumaSampler(ctx, state, "rotate", rotateFieldImg)
        : null;
      // Unclamped — negative point-mirrors through the anchor (matches
      // the GPU path).
      if (!scaleSampler && !rotateSampler) {
        return () => ({ mul: scaleMul, rot: rotateAdd });
      }
      return (u, v) => {
        let mul = scaleMul;
        if (scaleSampler) {
          mul *= fieldLo + (fieldHi - fieldLo) * scaleSampler(u, v);
        }
        let rot = rotateAdd;
        if (rotateSampler) {
          rot += (rotateSampler(u, v) - 0.5) * 2 * rotFieldAmt;
        }
        return { mul, rot };
      };
    };

    // ---- spline mode ------------------------------------------------
    if (mode === "spline") {
      const inst = inputs.instance;
      if (!inst || inst.kind !== "spline" || ptCount === 0) {
        const empty: SplineValue = { kind: "spline", subpaths: [] };
        return { primary: empty };
      }
      const points = ensurePointArray(ptsValue!);
      const distinct = collectDistinctGroupIndices(
        inst.subpaths.map((s) => s.groupIndex)
      );
      const pickIn = inputs.pick;
      const sampler =
        pickMode === "image" && pickIn?.kind === "image" && distinct.length > 1
          ? getLumaSampler(ctx, state, "pick", pickIn)
          : null;
      const modAt = makeModAt();
      const anchor: [number, number] =
        anchorMode === "custom"
          ? customAnchor
          : anchorMode === "content center"
            ? splineBoundsCenter(inst.subpaths) ?? [0.5, 0.5]
            : [0.5, 0.5];

      const outSubpaths: SplineValue["subpaths"] = [];
      for (let oi = 0; oi < points.length; oi++) {
        const i = order ? order[oi] : oi;
        const pt = points[i];
        // Decide which subpaths to emit for THIS point. `null` means
        // every subpath (the "all" behavior).
        const chosen = chooseVariantGroup({
          pickMode,
          distinct,
          index: i,
          sampler,
          u: pt.pos[0],
          v: pt.pos[1],
          targetGroup: pt.groupIndex ?? 0,
          seed: pickSeed,
          attrValue: pickAttrAt(i),
        });
        const subpathsForPt: SplineSubpath[] =
          chosen === null
            ? inst.subpaths
            : inst.subpaths.filter((s) => (s.groupIndex ?? 0) === chosen);
        const m = modAt(pt.pos[0], pt.pos[1]);
        const sx = (pt.scale?.[0] ?? 1) * m.mul;
        const sy = (pt.scale?.[1] ?? 1) * m.mul;
        const rotDeg = (((pt.rotation ?? 0) + m.rot) * 180) / Math.PI;
        for (const sub of subpathsForPt) {
          const transformed = transformSubpath(sub, {
            translateX: pt.pos[0] - anchor[0],
            translateY: pt.pos[1] - anchor[1],
            pivotX: anchor[0],
            pivotY: anchor[1],
            rotateDeg: rotDeg,
            scaleX: sx,
            scaleY: sy,
          });
          // Tag per output_tag: instance identity (legacy), copy
          // identity, or the target point's group.
          outSubpaths.push({
            ...transformed,
            groupIndex: tagFor(sub.groupIndex, i, pt.groupIndex),
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
        inst?.kind === "points" ? ensurePointArray(inst) : [];
      if (ptCount === 0 || srcPoints.length === 0) {
        const empty: PointsValue = pointsFromArray([]);
        return { primary: empty };
      }
      const points = ensurePointArray(ptsValue!);
      const distinct = collectDistinctGroupIndices(
        srcPoints.map((p) => p.groupIndex)
      );
      const pickIn = inputs.pick;
      const sampler =
        pickMode === "image" && pickIn?.kind === "image" && distinct.length > 1
          ? getLumaSampler(ctx, state, "pick", pickIn)
          : null;
      const modAt = makeModAt();
      const anchor: [number, number] =
        anchorMode === "custom"
          ? customAnchor
          : anchorMode === "content center"
            ? pointsBoundsCenter(srcPoints) ?? [0.5, 0.5]
            : [0.5, 0.5];

      const outPoints: Point[] = [];
      // Original target index per emitted row — the gather map that
      // carries the TARGET's named channels onto the product
      // (081326_point-attributes.md: the instance side's channels drop).
      const targetMap: number[] = [];
      for (let oi = 0; oi < points.length; oi++) {
        const i = order ? order[oi] : oi;
        const target = points[i];
        const m = modAt(target.pos[0], target.pos[1]);
        const tRot = (target.rotation ?? 0) + m.rot;
        const tCos = Math.cos(tRot);
        const tSin = Math.sin(tRot);
        const tSx = (target.scale?.[0] ?? 1) * m.mul;
        const tSy = (target.scale?.[1] ?? 1) * m.mul;
        const chosen = chooseVariantGroup({
          pickMode,
          distinct,
          index: i,
          sampler,
          u: target.pos[0],
          v: target.pos[1],
          targetGroup: target.groupIndex ?? 0,
          seed: pickSeed,
          attrValue: pickAttrAt(i),
        });
        const srcForTarget: Point[] =
          chosen === null
            ? srcPoints
            : srcPoints.filter((p) => (p.groupIndex ?? 0) === chosen);
        for (const src of srcForTarget) {
          // Translate the source's anchor to (0, 0), apply the
          // target's rotate/scale, then translate to target.pos.
          const dx = (src.pos[0] - anchor[0]) * tSx;
          const dy = (src.pos[1] - anchor[1]) * tSy;
          const rx = tCos * dx - tSin * dy;
          const ry = tSin * dx + tCos * dy;
          outPoints.push({
            pos: [target.pos[0] + rx, target.pos[1] + ry],
            rotation: (src.rotation ?? 0) + tRot,
            scale: [
              (src.scale?.[0] ?? 1) * tSx,
              (src.scale?.[1] ?? 1) * tSy,
            ],
            groupIndex: tagFor(src.groupIndex, i, target.groupIndex),
          });
          targetMap.push(i);
        }
      }
      const out: PointsValue = pointsFromArray(outPoints);
      // `out` is fresh and owned here, so attaching the gathered channels
      // directly (rather than re-copying) keeps its lazy view intact.
      out.attributes = gatherAttributes(
        ptsValue!.attributes,
        targetMap,
        out.count
      );
      return { primary: out };
    }

    // ---- image mode --------------------------------------------------
    // Instanced GPU draw: one drawArraysInstanced regardless of point
    // count. Per-instance transforms ride a small data texture
    // (tiled RGBA32F), re-uploaded only when the points value changes.
    // No CPU readback / 2D-
    // canvas drawImage in the hot path — orders of magnitude faster
    // than the old implementation past ~50 points.
    const output = ctx.allocImage();
    const instIn = inputs.instance;
    // Text mode rasterizes the carried style per variant string into pooled
    // textures we OWN (release after compositing). Every other mode reads the
    // instance texture(s) from upstream — never release those.
    let items: ImageValue[];
    let ownedItems = false;
    if (mode === "text") {
      const ti = instIn?.kind === "text_instance" ? instIn : null;
      const strings = ti?.strings ?? [];
      if (ti && strings.length > 0) {
        const canvas = ensureTextCanvas(state);
        // Milestone 1: one raster per variant string, shared base style. Per-
        // copy typographic modulation (size/weight/leading/font) is a later
        // milestone; string variants already land per point via the pick_mode
        // machinery below (the same M>1 path image groups use).
        items = strings.map((s) =>
          renderStyledTextToImage(ctx, canvas, { ...ti.base, text: s })
        );
        ownedItems = true;
      } else {
        items = [];
      }
    } else {
      // Single image or a homogeneous image group — group items are
      // variants, one chosen per point by the pick mode ("all" stamps
      // every item at every point).
      items =
        instIn?.kind === "image_group"
          ? instIn.items
          : instIn?.kind === "image"
            ? [instIn]
            : [];
    }
    const releaseOwned = () => {
      if (ownedItems) for (const it of items) ctx.releaseTexture(it.texture);
    };
    if (items.length === 0 || ptCount === 0) {
      releaseOwned();
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    if (!ensureInstResources(ctx, state)) {
      // Shader compile / GL alloc failed — emit empty rather than
      // crashing the pipeline.
      releaseOwned();
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const gl = ctx.gl;
    const W = ctx.width;
    const H = ctx.height;
    const N = ptCount;
    const M = items.length;
    const positionsTA = ptsValue!.positions;
    const scalesTA = ptsValue!.scales;
    const rotationsTA = ptsValue!.rotations;
    const groupIdxTA = ptsValue!.groupIndices;

    // --- variant assignment → contiguous per-item segments -----------
    // The transforms pack item-major; item k then draws its slice via
    // u_instBase, so one data texture serves M instanced draws.
    // `srcIndex(t)` maps a packed slot to its source point.
    let T: number;
    let segStarts: number[];
    let segCounts: number[];
    let srcIndex: (t: number) => number;
    if (M === 1) {
      T = N;
      segStarts = [0];
      segCounts = [N];
      srcIndex = order ? (t) => order[t] : (t) => t;
    } else {
      const pickIn = inputs.pick;
      const sampler =
        pickMode === "image" && pickIn?.kind === "image"
          ? getLumaSampler(ctx, state, "pick", pickIn)
          : null;
      const distinct = items.map((_, k) => k);
      if (pickMode === "all" || (pickMode === "image" && !sampler)) {
        // Every item at every point. Item-major: later items stack on
        // top, mirroring the spline/point modes' subpath order.
        T = N * M;
        segStarts = items.map((_, k) => k * N);
        segCounts = items.map(() => N);
        srcIndex = (t) => {
          const within = t % N;
          return order ? order[within] : within;
        };
      } else {
        // One item per point.
        const assign = new Int32Array(N);
        for (let i = 0; i < N; i++) {
          assign[i] =
            chooseVariantGroup({
              pickMode,
              distinct,
              index: i,
              sampler,
              u: positionsTA[i * 2],
              v: positionsTA[i * 2 + 1],
              targetGroup: groupIdxTA ? groupIdxTA[i] : 0,
              seed: pickSeed,
              attrValue: pickAttrAt(i),
            }) ?? 0;
        }
        segCounts = new Array<number>(M).fill(0);
        for (let i = 0; i < N; i++) segCounts[assign[i]]++;
        segStarts = [];
        let acc = 0;
        for (let k = 0; k < M; k++) {
          segStarts.push(acc);
          acc += segCounts[k];
        }
        T = N;
        const slots = new Int32Array(N);
        const cursor = segStarts.slice();
        for (let t = 0; t < N; t++) {
          const i = order ? order[t] : t;
          slots[cursor[assign[i]]++] = i;
        }
        srcIndex = (t) => slots[t];
      }
    }

    // Content rects must be resolved BEFORE any GL state is set up —
    // getContentRect's readImagePixels pass rebinds program / FBO /
    // texture state.
    const rects: UvRect[] =
      anchorMode === "content center"
        ? items.map((item) => getContentRect(ctx, state, item))
        : items.map(() => FULL_RECT);
    const anchorXY: [number, number] =
      anchorMode === "custom" ? customAnchor : [0.5, 0.5];

    // Tiled data-texture geometry: up to XFORM_TILE_W instances per
    // row-pair. A single T-wide row would silently exceed
    // MAX_TEXTURE_SIZE past ~16k instances (2k on minimal GPUs);
    // tiling bounds the width and grows rows instead.
    const tileW = Math.min(T, XFORM_TILE_W);
    const texH = Math.ceil(T / tileW) * 3;

    // Skip the pack + upload when the texture already holds exactly
    // this points value in this order (identity ⇒ same data —
    // producers emit a new value object whenever their output
    // changes). Single-item only: group assignment depends on more
    // state than the points value.
    // Per-instance tint + opacity channels (M4): an arity≥3 channel's rgb
    // rides the second row, any channel's component 0 the third row's
    // opacity slot. The names are part of the pack-skip key — the points
    // identity alone can't see a param-only change.
    const tintName = ((params.tint_attr as string) ?? "").trim();
    const tintAttr = tintName ? ptsValue!.attributes?.[tintName] : undefined;
    const tint = tintAttr && tintAttr.arity >= 3 ? tintAttr : undefined;
    const opacityName = ((params.opacity_attr as string) ?? "").trim();
    const opacity = opacityName
      ? ptsValue!.attributes?.[opacityName]
      : undefined;
    const orderKey = `${drawOrderMode}:${pickSeed}:${tint ? tintName : ""}:${opacity ? opacityName : ""}`;
    const xformsCurrent =
      M === 1 &&
      state.lastPoints === ptsValue &&
      state.lastOrderKey === orderKey &&
      state.instXformWidth === tileW &&
      state.instXformHeight === texH;
    if (!xformsCurrent) {
      // Pack per-instance transforms. Layout matches the VS: slot t
      // lives at column (t % tileW), row-triple floor(t / tileW):
      //   row 3k   = (posX, posY, rotation, scaleX)
      //   row 3k+1 = (scaleY, tintR, tintG, tintB)
      //   row 3k+2 = (opacity, 0, 0, 0)
      const needBufFloats = tileW * texH * 4;
      if (
        !state.instXformBuf ||
        state.instXformBuf.length < needBufFloats
      ) {
        state.instXformBuf = new Float32Array(needBufFloats);
      }
      const buf = state.instXformBuf;
      // All PointsValues now carry typed-array storage (`pointsFromArray`
      // wraps legacy producers). Read straight off the Float32Arrays —
      // no per-point object lookup, no optional-chain branch in the
      // inner loop.
      for (let t = 0; t < T; t++) {
        const i = srcIndex(t);
        const col = t % tileW;
        const rowTriple = (t / tileW) | 0;
        const o1 = (rowTriple * 3 * tileW + col) * 4;
        buf[o1 + 0] = positionsTA[i * 2];
        buf[o1 + 1] = positionsTA[i * 2 + 1];
        buf[o1 + 2] = rotationsTA ? rotationsTA[i] : 0;
        buf[o1 + 3] = scalesTA ? scalesTA[i * 2] : 1;
        const o2 = ((rowTriple * 3 + 1) * tileW + col) * 4;
        buf[o2 + 0] = scalesTA ? scalesTA[i * 2 + 1] : 1;
        buf[o2 + 1] = tint ? tint.data[i * tint.arity] : 0;
        buf[o2 + 2] = tint ? tint.data[i * tint.arity + 1] : 0;
        buf[o2 + 3] = tint ? tint.data[i * tint.arity + 2] : 0;
        const o3 = ((rowTriple * 3 + 2) * tileW + col) * 4;
        // OFF packs as fully opaque; ON clamps to [0,1] — negative
        // coverage breaks source-over downstream (the convolve lesson).
        buf[o3 + 0] = opacity
          ? Math.min(1, Math.max(0, opacity.data[i * opacity.arity]))
          : 1;
        buf[o3 + 1] = 0;
        buf[o3 + 2] = 0;
        buf[o3 + 3] = 0;
      }
      // Upload to the data texture. Re-allocate when the tiled
      // dimensions change; otherwise just texSubImage2D the fresh
      // values into place.
      gl.bindTexture(gl.TEXTURE_2D, state.instXformTex!);
      if (state.instXformWidth !== tileW || state.instXformHeight !== texH) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32F,
          tileW,
          texH,
          0,
          gl.RGBA,
          gl.FLOAT,
          // The view length must match the texture extent exactly.
          buf.subarray(0, needBufFloats)
        );
        state.instXformWidth = tileW;
        state.instXformHeight = texH;
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          tileW,
          texH,
          gl.RGBA,
          gl.FLOAT,
          buf.subarray(0, needBufFloats)
        );
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      state.lastPoints = M === 1 ? ptsValue : null;
      state.lastOrderKey = orderKey;
    }

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
    const L = state.instLocs!;

    gl.uniform1i(L.u_src, 0);
    // Texture unit 1 → per-instance transform data.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.instXformTex!);
    gl.uniform1i(L.u_xforms, 1);
    gl.uniform1i(L.u_xformTileW, tileW);
    gl.uniform2f(L.u_canvasRes, W, H);

    // Uniform modulation — resolved once at the top of compute.
    gl.uniform1f(L.u_scaleMul, scaleMul);
    gl.uniform1f(L.u_rotateAdd, rotateAdd);

    // Per-instance image fields. Bind to texture units 2 and 3.
    // When unconnected, the field uniforms stay disabled — the VS
    // skips the texture sample so we don't pay for one and don't
    // need a placeholder texture bound.
    if (scaleFieldImg) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, scaleFieldImg.texture);
    }
    if (rotateFieldImg) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, rotateFieldImg.texture);
    }
    gl.uniform1i(L.u_scaleField, 2);
    gl.uniform1i(L.u_useScaleField, scaleFieldImg ? 1 : 0);
    gl.uniform1f(L.u_scaleFieldLo, fieldLo);
    gl.uniform1f(L.u_scaleFieldHi, fieldHi);
    gl.uniform1i(L.u_rotateField, 3);
    gl.uniform1i(L.u_useRotateField, rotateFieldImg ? 1 : 0);
    gl.uniform1f(L.u_rotateFieldAmount, rotFieldAmt);
    gl.uniform1i(L.u_useTint, tint ? 1 : 0);

    // One instanced draw per item over its packed segment. Texture
    // unit 0 → the item being copied; the rect/anchor uniforms carry
    // its alpha-bbox crop when the content-center anchor is active.
    for (let k = 0; k < M; k++) {
      const count = segCounts[k];
      if (count === 0) continue;
      const item = items[k];
      const rect = rects[k];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, item.texture);
      gl.uniform2f(L.u_instSize, item.width, item.height);
      gl.uniform4f(L.u_uvRect, rect.x, rect.y, rect.w, rect.h);
      gl.uniform2f(L.u_anchor, anchorXY[0], anchorXY[1]);
      gl.uniform1i(L.u_instBase, segStarts[k]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }

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

    releaseOwned();
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
      if (state.textCanvas?.parentNode) {
        state.textCanvas.parentNode.removeChild(state.textCanvas);
      }
    }
    delete ctx.state[key];
  },
};
