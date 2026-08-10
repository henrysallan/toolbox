import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
  SdfValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  bindSdfUniforms,
  compileSdf,
  structuralHash,
} from "@/engine/sdf-compile";
import { marchingSquares } from "@/engine/marching-squares";

// Extract the iso-line of an SDF as a spline. The pipeline:
//
//   1. Compile the SDF tree to a "raw distance" shader (R channel
//      stores signed distance, RGBA16F).
//   2. Render to a small RGBA16F image at the chosen resolution.
//   3. Read pixels back.
//   4. Run marching squares on the R channel.
//   5. Output the resulting subpaths as a SplineValue.
//
// The readback is the expensive step — and NOT because of its size. A
// synchronous readPixels waits for every GPU command queued before it,
// so on a GPU-saturated graph this node was billed the whole pipeline
// drain: measured 28.4 ms/frame during playback in a real project, of
// which ~24 ms was queue-stall and ~7 ms the sync call's fixed latency
// floor (a 254² and a 128² read cost the same). The march itself is ~1 ms.
//
// So the opt-in `async_readback` mode reads back asynchronously:
// readPixels lands in a PIXEL_PACK_BUFFER behind a fence, compute
// returns the PREVIOUS frame's contour, and the buffer is mapped (fence
// already signaled — no wait) on a later eval. The spline lags its SDF
// input by one frame during playback; steady state (paused) converges to
// the exact sync result. Cost drops to the march alone.
//
// These stay fully synchronous — same output as the original node:
//   - the toggle off (the default — existing saves are untouched);
//   - `ctx.offline` (export renders): every frame must be exact, and
//     export throughput doesn't suffer interactive queue pressure.
//   - cold start (no previous result yet): avoids an empty-spline flash
//     when the node first evaluates.
//
// `iso` is the contour level (default 0 = the SDF zero-crossing).
// Negative iso values trace inside the shape (concentric loops);
// positive iso traces outside (puffed-out boundary). At collect time the
// march uses the CURRENT iso on the pending grid, so paused iso drags
// respond immediately against the (static) field.

interface AsyncSlot {
  buf: WebGLBuffer;
  bytes: number;
  sync: WebGLSync | null;
  w: number;
  h: number;
  seq: number;
}

interface ScratchState {
  // Reusable RGBA16F target for the distance render. Resized in place
  // when the resolution param changes.
  image?: ImageValue;
  width?: number;
  height?: number;
  // Async readback machinery. `slots` is a 2-entry round-robin of PBO
  // reads in flight; `last` is the most recent marched contour.
  fbo?: WebGLFramebuffer;
  slots?: AsyncSlot[];
  issueSeq?: number;
  floatOk?: boolean;
  last?: SplineSubpath[];
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

// Pull the R channel into a contiguous Float32 grid (Y-flipped:
// readPixels returns rows bottom-up, spline coords are Y-DOWN) and
// march it.
function marchGrid(
  data: Float32Array,
  w: number,
  h: number,
  iso: number
): SplineSubpath[] {
  const grid = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      grid[y * w + x] = data[(srcY * w + x) * 4];
    }
  }
  return marchingSquares(grid, w, h, {
    iso,
    uvOrigin: [0, 0],
    uvSize: [1, 1],
  });
}

// Drop in-flight reads without mapping them (their content is stale —
// used when an offline eval takes over, where exactness matters).
// Buffers are kept for reuse; only the fences die.
function discardPending(gl: WebGL2RenderingContext, state: ScratchState) {
  for (const slot of state.slots ?? []) {
    if (slot.sync) {
      gl.deleteSync(slot.sync);
      slot.sync = null;
    }
  }
}

// Map the NEWEST signaled slot (fence already passed — getBufferSubData
// does not wait) and march it with the current iso. Older signaled slots
// are retired unread. Unsignaled slots stay pending. Never blocks.
function collectReady(
  gl: WebGL2RenderingContext,
  state: ScratchState,
  iso: number
) {
  let newest: AsyncSlot | null = null;
  for (const slot of state.slots ?? []) {
    if (!slot.sync) continue;
    const status = gl.clientWaitSync(slot.sync, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) continue;
    gl.deleteSync(slot.sync);
    slot.sync = null;
    if (!newest || slot.seq > newest.seq) newest = slot;
  }
  if (!newest) return;
  const out = new Float32Array(newest.w * newest.h * 4);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, newest.buf);
  gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
  // PIXEL_PACK_BUFFER binding is GLOBAL state — leaving it bound would
  // redirect every later readPixels in the app into this buffer.
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  state.last = marchGrid(out, newest.w, newest.h, iso);
}

// Queue an async read of the freshly rendered target. If both slots are
// still in flight (GPU >2 frames behind) the frame is simply not read —
// the contour freezes on `last` until the queue catches up.
function issueRead(
  gl: WebGL2RenderingContext,
  state: ScratchState,
  target: ImageValue
) {
  const slots = (state.slots ??= []);
  let slot = slots.find((s) => !s.sync);
  if (!slot && slots.length < 2) {
    const buf = gl.createBuffer();
    if (!buf) return;
    slot = { buf, bytes: 0, sync: null, w: 0, h: 0, seq: 0 };
    slots.push(slot);
  }
  if (!slot) return;
  const w = target.width;
  const h = target.height;
  const bytes = w * h * 4 * 4;
  const fbo = (state.fbo ??= gl.createFramebuffer()!);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    target.texture,
    0
  );
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
  if (slot.bytes !== bytes) {
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.DYNAMIC_READ);
    slot.bytes = bytes;
  }
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, 0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  slot.w = w;
  slot.h = h;
  slot.seq = state.issueSeq = (state.issueSeq ?? 0) + 1;
  // Fences only make progress once commands are flushed; a paused editor
  // may not flush again on its own before the next poll.
  gl.flush();
}

export const sdfToSplineNode: NodeDefinition = {
  type: "sdf-to-spline",
  name: "SDF to Spline",
  category: "utility",
  description:
    "Extract the iso-line of an SDF as a spline (closed where loops form, open where chains run off the grid). Resolution sets the marching-squares grid size — 256 is a good default; raise it for smoother curves at the cost of a bigger CPU readback. Async Readback trades a one-frame contour lag during playback for eliminating the sync GPU readback stall (the whole cost of this node in GPU-heavy graphs); exports are frame-exact either way.",
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
    // Opt-in async mode (see the header comment). OFF by default so
    // existing saves keep exact same-frame semantics; flip it on when the
    // node sits in a GPU-heavy graph and its sync readback stalls the
    // frame (measured: 28.4 → ~1-2 ms/frame in a saturated project).
    // Exports are frame-exact either way — offline evals always take the
    // sync path.
    {
      name: "async_readback",
      label: "Async Readback (1-frame lag)",
      type: "boolean",
      default: false,
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
      bindSdfUniforms(gl, prog, compiled.uniforms);
    });

    const gl = ctx.gl;
    if (state.floatOk === undefined) {
      state.floatOk = !!gl.getExtension("EXT_color_buffer_float");
    }

    // Exact sync path: async mode not opted into, exports (every frame
    // must be frame-accurate), cold start (no previous contour to show),
    // and the RGBA8 fallback (async path reads FLOAT).
    const wantAsync = params.async_readback === true;
    if (!wantAsync || ctx.offline || !state.floatOk || !state.last) {
      discardPending(gl, state);
      const data = ctx.readImageToFloat32(target);
      state.last = marchGrid(data, target.width, target.height, iso);
      return { primary: { kind: "spline", subpaths: state.last } };
    }

    // Interactive async path: collect what's ready, queue this frame,
    // return the newest contour we have (one frame behind).
    collectReady(gl, state, iso);
    issueRead(gl, state, target);
    return { primary: { kind: "spline", subpaths: state.last } };
  },

  dispose(ctx, nodeId) {
    const key = `sdf-to-spline:${nodeId}`;
    const state = ctx.state[key] as ScratchState | undefined;
    if (state) {
      const gl = ctx.gl;
      discardPending(gl, state);
      for (const slot of state.slots ?? []) gl.deleteBuffer(slot.buf);
      if (state.fbo) gl.deleteFramebuffer(state.fbo);
      if (state.image) ctx.releaseTexture(state.image.texture);
    }
    delete ctx.state[key];
  },
};
