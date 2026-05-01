import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
} from "@/engine/types";

// Per-point modulation. Reads a points input and writes per-point
// `scale` / `rotation` based on:
//   - uniform scalar inputs (scale_mul, rotate_add) — multiply / add
//     the same value to every point.
//   - image field inputs (scale_field, rotate_field) — sampled at each
//     point's UV. Field luminance maps via the configured lo/hi range
//     for scale, or via amount × luma for rotation.
//
// Existing per-point scale/rotation values are preserved and combined:
// new scale = old scale × (uniform × field_value), new rotation =
// old rotation + (uniform + field_value × amount). Stack multiple
// Modulate Points nodes to layer modulations.
//
// Image-mode Copy-to-Points already samples its own scale_field /
// rotate_field on the GPU. This node is the equivalent for the CPU
// pipeline (spline / point modes of Copy-to-Points) and the place to
// modulate any other points consumer.

// Fields are sampled at low frequency relative to image content — scale
// and rotation modulation does not benefit from 1080p detail. Downsample
// to a fixed working size to cut readback bandwidth (a 1920×1080 RGBA
// readback is ~8MB; 128×128 is ~64KB, ~128× less to copy). 128 is
// already higher resolution than the perceptual frequency of typical
// scale/rotate fields.
const FIELD_SAMPLE_SIZE = 128;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

interface CachedField {
  // Identity check: when the evaluator returns a cached upstream value
  // it hands back the same ImageValue object. A new object means the
  // upstream recomputed and we must re-issue the blit + readback.
  source: ImageValue;
  data: Uint8Array;
  width: number;
  height: number;
}

interface SamplerSlot {
  smallImage?: ImageValue;
  // Persistent JS-side buffer; reused every frame, no per-frame alloc.
  data?: Uint8Array;
  cache?: CachedField;
  // Async readback: we ping-pong a single PIXEL_PACK_BUFFER. Each
  // frame, if a fence is pending and ready, we map the buffer (no
  // stall). Then we issue the next blit + async readPixels into the
  // same PBO and place a new fence. The sampler returns last-frame's
  // data — one frame of latency in exchange for zero GPU stall.
  pbo?: WebGLBuffer;
  fence?: WebGLSync;
  // Source the in-flight read was issued for. When the fence resolves
  // we record this on `cache` so the identity check still works.
  inflightSource?: ImageValue;
}

interface SamplerState {
  scale: SamplerSlot;
  rotate: SamplerSlot;
}

function ensureState(ctx: RenderContext, nodeId: string): SamplerState {
  const key = `modulate-points:${nodeId}`;
  let s = ctx.state[key] as Partial<SamplerState> | undefined;
  if (!s) s = {};
  // Backward-compat: older runtime state may be `{}` from the previous
  // implementation. Heal it in-place so slot reads are always defined.
  if (!s.scale) s.scale = {};
  if (!s.rotate) s.rotate = {};
  ctx.state[key] = s;
  return s as SamplerState;
}

export function disposeSamplerSlot(ctx: RenderContext, slot: SamplerSlot) {
  const gl = ctx.gl;
  if (slot.smallImage) {
    gl.deleteTexture(slot.smallImage.texture);
    slot.smallImage = undefined;
  }
  if (slot.fence) {
    gl.deleteSync(slot.fence);
    slot.fence = undefined;
  }
  if (slot.pbo) {
    gl.deleteBuffer(slot.pbo);
    slot.pbo = undefined;
  }
  slot.cache = undefined;
  slot.data = undefined;
  slot.inflightSource = undefined;
}

// Builds a UV → 0..1 luminance sampler. Renders the field into a small
// RGBA8 texture and reads it back asynchronously through a
// PIXEL_PACK_BUFFER + fence sync. The sampler returns whatever data is
// most recently READY — one frame of latency, but no GPU stall in the
// frame's hot path. Cache by source identity so a static field paired
// with animating points reuses the previous map.
function buildLumaSampler(
  ctx: RenderContext,
  slot: SamplerSlot,
  img: ImageValue
): ((u: number, v: number) => number) | null {
  if (img.width <= 0 || img.height <= 0) return null;

  const gl = ctx.gl;
  const targetW = Math.min(FIELD_SAMPLE_SIZE, img.width);
  const targetH = Math.min(FIELD_SAMPLE_SIZE, img.height);
  const byteSize = targetW * targetH * 4;

  // Reallocate the small render target / PBO if size changed (rare —
  // only on first use or if the upstream image dimensions change).
  if (
    !slot.smallImage ||
    slot.smallImage.width !== targetW ||
    slot.smallImage.height !== targetH
  ) {
    if (slot.smallImage) gl.deleteTexture(slot.smallImage.texture);
    if (slot.fence) {
      gl.deleteSync(slot.fence);
      slot.fence = undefined;
    }
    if (slot.pbo) gl.deleteBuffer(slot.pbo);
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      targetW,
      targetH,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    slot.smallImage = {
      kind: "image",
      texture: tex,
      width: targetW,
      height: targetH,
    };
    slot.data = new Uint8Array(byteSize);

    const pbo = gl.createBuffer();
    if (!pbo) return null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteSize, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.pbo = pbo;
    slot.cache = undefined;
    slot.inflightSource = undefined;
  }

  // Step 1: drain a previously-issued readback if its fence has
  // resolved. This is non-blocking — we pass timeout=0 and bail if
  // it's not ready yet, leaving the existing cache in place.
  if (slot.fence) {
    const status = gl.clientWaitSync(slot.fence, 0, 0);
    if (
      status === gl.ALREADY_SIGNALED ||
      status === gl.CONDITION_SATISFIED
    ) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo!);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, slot.data!);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(slot.fence);
      slot.fence = undefined;
      slot.cache = {
        source: slot.inflightSource ?? img,
        data: slot.data!,
        width: targetW,
        height: targetH,
      };
    }
    // If still pending, fall through and use the previous cache below.
  }

  // Step 2: if no fence is in flight AND we don't have a fresh cache
  // for this source, kick off a new async readback.
  const needsKick =
    !slot.fence && (!slot.cache || slot.cache.source !== img);
  if (needsKick) {
    const prog = ctx.getShader("modulate-points-blit", BLIT_FS);
    ctx.drawFullscreen(prog, slot.smallImage!, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, img.texture);
      const loc = gl2.getUniformLocation(prog, "u_src");
      gl2.uniform1i(loc, 0);
    });
    // drawFullscreen leaves the engine's shared FBO bound with our
    // small image as COLOR_ATTACHMENT0 — readPixels reads from there.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo!);
    gl.readPixels(0, 0, targetW, targetH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.fence = fence ?? undefined;
    slot.inflightSource = img;
  }

  // No data yet (first frame after wiring up): no sampler. Caller
  // treats null as "no field" and skips the modulation.
  if (!slot.cache) return null;
  const data = slot.cache.data;

  const w = targetW;
  const h = targetH;
  const wMinus = w - 1;
  const hMinus = h - 1;
  return (u: number, v: number): number => {
    // Point/subpath UVs are Y-DOWN (v=0 = top). readPixels returns
    // pixels Y-UP (row 0 is the bottom of the framebuffer), so flip v
    // when indexing into the buffer.
    let px = (u * w) | 0;
    let py = ((1 - v) * h) | 0;
    if (px < 0) px = 0;
    else if (px > wMinus) px = wMinus;
    if (py < 0) py = 0;
    else if (py > hMinus) py = hMinus;
    const i = (py * w + px) * 4;
    return (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
  };
}

export const modulatePointsNode: NodeDefinition = {
  type: "modulate-points",
  name: "Modulate Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Modulate per-point scale and rotation on a points value. Uniform inputs apply to every point; image fields are sampled at each point's UV and mapped through the configured ranges. Stack to layer modulations; feed the result into Copy to Points (or any consumer that respects per-point attributes).",
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    {
      name: "scale_mul",
      type: "scalar",
      required: false,
      label: "Scale × (uniform)",
    },
    {
      name: "rotate_add",
      type: "scalar",
      required: false,
      label: "Rotate + (uniform)",
    },
    {
      name: "scale_field",
      type: "image",
      required: false,
      label: "Scale field",
    },
    {
      name: "rotate_field",
      type: "image",
      required: false,
      label: "Rotate field",
    },
  ],
  resolveInputs(): InputSocketDef[] {
    return [
      { name: "points", type: "points", required: true },
      {
        name: "scale_mul",
        type: "scalar",
        required: false,
        label: "Scale × (uniform)",
      },
      {
        name: "rotate_add",
        type: "scalar",
        required: false,
        label: "Rotate + (uniform)",
      },
      {
        name: "scale_field",
        type: "image",
        required: false,
        label: "Scale field",
      },
      {
        name: "rotate_field",
        type: "image",
        required: false,
        label: "Rotate field",
      },
    ];
  },
  params: [
    {
      name: "scale_mul_default",
      label: "Scale × default",
      type: "scalar",
      min: 0,
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
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") {
      const empty: PointsValue = {
        kind: "points",
        count: 0,
        positions: new Float32Array(0),
        points: [],
      };
      return { primary: empty };
    }

    // Uniform scalars: wired value (if present) wins; else fall back
    // to the configured defaults.
    const uniformScale =
      inputs.scale_mul?.kind === "scalar"
        ? inputs.scale_mul.value
        : ((params.scale_mul_default as number) ?? 1);
    const uniformRot =
      inputs.rotate_add?.kind === "scalar"
        ? inputs.rotate_add.value
        : ((params.rotate_add_default as number) ?? 0);

    const scaleLo = (params.scale_field_lo as number) ?? 0.5;
    const scaleHi = (params.scale_field_hi as number) ?? 1.5;
    const rotAmount = (params.rotate_field_amount as number) ?? Math.PI;

    const state = ensureState(ctx, nodeId);
    let scaleSampler: ((u: number, v: number) => number) | null = null;
    if (inputs.scale_field?.kind === "image") {
      scaleSampler = buildLumaSampler(ctx, state.scale, inputs.scale_field);
    } else {
      // Drop the cached readback so we don't pin a stale image's data.
      state.scale.cache = undefined;
    }
    let rotSampler: ((u: number, v: number) => number) | null = null;
    if (inputs.rotate_field?.kind === "image") {
      rotSampler = buildLumaSampler(ctx, state.rotate, inputs.rotate_field);
    } else {
      state.rotate.cache = undefined;
    }

    // Fast path: nothing to do — return the input unchanged. Sharing
    // the typed-array buffers is safe because the evaluator treats
    // PointsValue as immutable across consumers.
    const noUniformScale = uniformScale === 1;
    const noUniformRot = uniformRot === 0;
    if (noUniformScale && noUniformRot && !scaleSampler && !rotSampler) {
      return { primary: src };
    }

    // Hot path: read straight from the source typed arrays and write
    // into freshly allocated ones. Zero per-point object allocations
    // — V8 stays in monomorphic typed-array territory and the loop
    // becomes a tight arithmetic kernel.
    const n = src.count;
    const inPos = src.positions;
    const inScales = src.scales;
    const inRots = src.rotations;
    const inGroups = src.groupIndices;

    // Positions are unchanged — share the buffer.
    const outPositions = inPos;
    // Scales / rotations always materialize on output: even if the
    // input had none, we may have written into them.
    const outScales = new Float32Array(n * 2);
    const outRotations = new Float32Array(n);
    const scaleSpan = scaleHi - scaleLo;

    for (let i = 0; i < n; i++) {
      const px = inPos[i * 2];
      const py = inPos[i * 2 + 1];

      let scaleFactor = uniformScale;
      if (scaleSampler) {
        scaleFactor *= scaleLo + scaleSpan * scaleSampler(px, py);
      }
      let rotAdd = uniformRot;
      if (rotSampler) {
        rotAdd += rotSampler(px, py) * rotAmount;
      }

      const oldSx = inScales ? inScales[i * 2] : 1;
      const oldSy = inScales ? inScales[i * 2 + 1] : 1;
      outScales[i * 2] = oldSx * scaleFactor;
      outScales[i * 2 + 1] = oldSy * scaleFactor;
      outRotations[i] = (inRots ? inRots[i] : 0) + rotAdd;
    }

    const out: PointsValue = {
      kind: "points",
      count: n,
      positions: outPositions,
      scales: outScales,
      rotations: outRotations,
      groupIndices: inGroups,
      points: [],
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `modulate-points:${nodeId}`;
    const state = ctx.state[key] as SamplerState | undefined;
    if (!state) return;
    disposeSamplerSlot(ctx, state.scale);
    disposeSamplerSlot(ctx, state.rotate);
    delete ctx.state[key];
  },
};
