import type {
  ForceDescriptor,
  ImageValue,
  NodeDefinition,
  NodeOutput,
  ParticlesValue,
  RenderContext,
  SocketValue,
} from "@/engine/types";
import { ensureWebGPUDevice } from "@/engine/webgpu/device";
import {
  BYTES_PER_PARTICLE,
  FLOATS_PER_PARTICLE,
  createParticleBuffers,
  destroyParticleBuffers,
  pickSquare,
  pingPong,
  type ParticleBuffers,
} from "@/engine/webgpu/buffers";
import { ComputePipelineCache, type PipelineKey } from "@/engine/webgpu/pipelines";
import {
  BOUNDS_BOUNCE,
  BOUNDS_CLAMP,
  BOUNDS_KILL,
  BOUNDS_OFF,
  BOUNDS_WRAP,
  FORCE_KIND_DRAG,
  FORCE_KIND_GRAVITY,
  FORCE_KIND_POINT,
  FORCE_KIND_TURBULENCE,
  FORCE_KIND_VORTEX,
  FORCE_KIND_WIND,
  PARAMS_BYTES,
  PARAMS_FORCE_A_OFFSET,
  PARAMS_FORCE_B_OFFSET,
  PARAMS_FORCE_KINDS_OFFSET,
  buildIntegrateWgsl,
} from "@/engine/webgpu/wgsl/integrate";
import { particleSimulatorWebGLNode } from "./particle-simulator-webgl";

// =====================================================================
// Particle Simulator — WebGPU compute path (Phase 1)
// =====================================================================
//
// Mirror of particle-simulator-webgl.ts but with the per-frame
// integration step running as a WGSL compute kernel on real GPU
// storage buffers. Phase 1 supports gravity / drag forces and
// off/bounce/wrap/clamp/kill bounds; other forces and ALL emitters /
// colliders are stubbed (zero contribution). Spawning is hardcoded —
// every slot is initialized once with a random position and a
// sentinel infinite lifetime so there's something to integrate. Real
// emitter-driven spawning lands in Phase 3.
//
// Engine-loop integration
// -----------------------
// Node compute() is synchronous; WebGPU readback is not (no
// gl.readPixels equivalent). So this node runs ONE frame behind:
//
//   Frame N enters compute() →
//     1. Drain any completed readback into a fresh WebGL ImageValue.
//        That ImageValue is what we return THIS frame.
//     2. Submit this frame's compute pass on the GPU.
//     3. If no readback is in flight, copy the new write-side buffer
//        into the staging buffer and kick off mapAsync(). When the
//        resolver fires (later in the frame), it stashes the float
//        array on state.pendingUpload for the next compute() to pick
//        up.
//
// Net latency: 1 frame (~16ms at 60fps). Acceptable for Phase 1; the
// permanent fix is Phase 5 where Particles to Image renders directly
// from the GPU buffer with no readback at all.

const FORCE_KIND_MAP: Record<ForceDescriptor["kind"], number> = {
  gravity: FORCE_KIND_GRAVITY,
  drag: FORCE_KIND_DRAG,
  point: FORCE_KIND_POINT,
  vortex: FORCE_KIND_VORTEX,
  wind: FORCE_KIND_WIND,
  turbulence: FORCE_KIND_TURBULENCE,
};

const BOUNDS_MODE_MAP: Record<string, number> = {
  off: BOUNDS_OFF,
  bounce: BOUNDS_BOUNCE,
  wrap: BOUNDS_WRAP,
  clamp: BOUNDS_CLAMP,
  kill: BOUNDS_KILL,
};

const MAX_FORCES = 8;
const FORCE_INPUTS_MAX = MAX_FORCES;
// Emitter / collider gathering is stubbed in Phase 1 (no spawn, no
// collision). The slot caps are intentionally not referenced here —
// the WebGL backend still reads them from the shared schema, and the
// shader does nothing with them yet. Phase 3 / 4 will reintroduce.

interface PackedForce {
  kind: number;
  a: [number, number, number, number];
  b: [number, number, number, number];
}

function packForce(d: ForceDescriptor): PackedForce {
  const a: [number, number, number, number] = [0, 0, 0, 0];
  const b: [number, number, number, number] = [0, 0, 0, 0];
  switch (d.kind) {
    case "gravity":
      a[0] = d.gx;
      a[1] = d.gy;
      break;
    case "drag":
      a[0] = d.coeff;
      break;
    case "point":
      a[0] = d.px;
      a[1] = d.py;
      a[2] = d.strength;
      a[3] = d.falloff;
      b[0] = d.sign;
      b[1] = d.radius;
      break;
    case "vortex":
      a[0] = d.px;
      a[1] = d.py;
      a[2] = d.strength;
      a[3] = d.falloff;
      b[1] = d.radius;
      break;
    case "wind":
      a[0] = d.dx;
      a[1] = d.dy;
      a[2] = d.strength;
      break;
    case "turbulence":
      a[0] = d.scale;
      a[1] = d.strength;
      a[2] = d.speed;
      break;
  }
  return { kind: FORCE_KIND_MAP[d.kind], a, b };
}

function gatherForces(
  inputs: Record<string, SocketValue | undefined>
): ForceDescriptor[] {
  const out: ForceDescriptor[] = [];
  for (let i = 0; i < FORCE_INPUTS_MAX; i++) {
    const v = inputs[`force${i + 1}`];
    if (v && v.kind === "force") out.push(v.descriptor);
  }
  return out;
}

interface WebGPUSimState {
  device: GPUDevice;
  buffers: ParticleBuffers;
  paramsBuffer: GPUBuffer;
  pipelineCache: ComputePipelineCache;
  count: number;
  texW: number;
  texH: number;
  readIdx: 0 | 1;
  lastTime: number;
  resetNextFrame: boolean;
  // Latest WebGL-side ImageValue we've produced via uploadFloat32ToImage.
  // Returned from compute() each frame. One-frame stale relative to
  // the most recent GPU state (mapAsync latency).
  outputImage: ImageValue | null;
  // Auxiliary zero-filled texture for the ParticlesValue.velocityTex
  // slot. No current consumer reads velocity from a ParticlesValue,
  // but the type requires it. Allocated once.
  zeroVelocityImage: ImageValue;
  // If non-null, a completed mapAsync has produced this Float32Array
  // and the next compute() should upload it. Cleared after upload.
  pendingUpload: Float32Array | null;
  // True between issuing the staging copy + mapAsync and the
  // resolver firing. Prevents stacking readbacks on top of each
  // other.
  readbackBusy: boolean;
}

function stateKey(nodeId: string) {
  // First `:` segment MUST be the registered type ("particle-simulator") or the
  // evaluator's dispose sweep skips it (getNodeDef miss) and this backend's GPU
  // buffers leak on delete. The `:webgpu` suffix keeps it distinct from the
  // WebGL backend's key while still sweeping under the same node id. See
  // 072226 audit #6.
  return `particle-simulator:${nodeId}:webgpu`;
}

function disposeState(ctx: RenderContext, st: WebGPUSimState) {
  destroyParticleBuffers(st.buffers);
  st.paramsBuffer.destroy();
  if (st.outputImage) ctx.releaseTexture(st.outputImage.texture);
  ctx.releaseTexture(st.zeroVelocityImage.texture);
}

function ensureState(
  ctx: RenderContext,
  device: GPUDevice,
  nodeId: string,
  count: number
): WebGPUSimState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as WebGPUSimState | undefined;
  const { w, h } = pickSquare(count);
  if (
    existing &&
    existing.texW === w &&
    existing.texH === h &&
    existing.device === device
  ) {
    return existing;
  }
  if (existing) disposeState(ctx, existing);

  const buffers = createParticleBuffers(device, count);
  const paramsBuffer = device.createBuffer({
    label: "particle-sim-webgpu:params",
    size: PARAMS_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const zeroVelocityImage = ctx.allocImage({
    width: buffers.width,
    height: buffers.height,
  });
  ctx.clearTarget(zeroVelocityImage, [0, 0, 0, 0]);

  const st: WebGPUSimState = {
    device,
    buffers,
    paramsBuffer,
    pipelineCache: new ComputePipelineCache(),
    count: buffers.capacity,
    texW: buffers.width,
    texH: buffers.height,
    readIdx: 0,
    lastTime: ctx.time,
    resetNextFrame: true,
    outputImage: null,
    zeroVelocityImage,
    pendingUpload: null,
    readbackBusy: false,
  };
  ctx.state[key] = st;
  return st;
}

function writeParams(
  device: GPUDevice,
  buffer: GPUBuffer,
  args: {
    dt: number;
    time: number;
    seed: number;
    boundsRest: number;
    count: number;
    boundsMode: number;
    resetFlag: number;
    forces: PackedForce[];
  }
) {
  const data = new ArrayBuffer(PARAMS_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  f32[0] = args.dt;
  f32[1] = args.time;
  f32[2] = args.seed;
  f32[3] = args.boundsRest;
  u32[4] = args.count;
  u32[5] = args.forces.length;
  u32[6] = args.boundsMode;
  u32[7] = args.resetFlag;
  // forceKinds at byte offset 32 → u32 index 8.
  const forceKindsBase = PARAMS_FORCE_KINDS_OFFSET / 4;
  const forceABase = PARAMS_FORCE_A_OFFSET / 4;
  const forceBBase = PARAMS_FORCE_B_OFFSET / 4;
  for (let i = 0; i < args.forces.length && i < MAX_FORCES; i++) {
    const p = args.forces[i];
    u32[forceKindsBase + i] = p.kind;
    f32[forceABase + i * 4 + 0] = p.a[0];
    f32[forceABase + i * 4 + 1] = p.a[1];
    f32[forceABase + i * 4 + 2] = p.a[2];
    f32[forceABase + i * 4 + 3] = p.a[3];
    f32[forceBBase + i * 4 + 0] = p.b[0];
    f32[forceBBase + i * 4 + 1] = p.b[1];
    f32[forceBBase + i * 4 + 2] = p.b[2];
    f32[forceBBase + i * 4 + 3] = p.b[3];
  }
  device.queue.writeBuffer(buffer, 0, data);
}

// Used by the router to obtain the input/param schema without
// duplicating it. Sharing the WebGL node's surface keeps the two
// backends pin-compatible from the editor's perspective.
export const PARTICLE_SIM_SHARED_SCHEMA = {
  inputs: particleSimulatorWebGLNode.inputs,
  resolveInputs: particleSimulatorWebGLNode.resolveInputs,
  resolveAuxOutputs: particleSimulatorWebGLNode.resolveAuxOutputs,
  params: particleSimulatorWebGLNode.params,
  primaryOutput: particleSimulatorWebGLNode.primaryOutput,
  auxOutputs: particleSimulatorWebGLNode.auxOutputs,
  fingerprintExtras: particleSimulatorWebGLNode.fingerprintExtras,
} as const;

export const particleSimulatorWebGPUNode: NodeDefinition = {
  type: "particle-simulator",
  name: "Particle Simulator",
  category: "effect",
  description: particleSimulatorWebGLNode.description,
  backend: "webgpu",
  stable: false,
  simulation: true,
  inputs: PARTICLE_SIM_SHARED_SCHEMA.inputs,
  resolveInputs: PARTICLE_SIM_SHARED_SCHEMA.resolveInputs,
  resolveAuxOutputs: PARTICLE_SIM_SHARED_SCHEMA.resolveAuxOutputs,
  params: PARTICLE_SIM_SHARED_SCHEMA.params,
  primaryOutput: PARTICLE_SIM_SHARED_SCHEMA.primaryOutput,
  auxOutputs: PARTICLE_SIM_SHARED_SCHEMA.auxOutputs,
  fingerprintExtras: PARTICLE_SIM_SHARED_SCHEMA.fingerprintExtras,

  compute({ inputs, params, ctx, nodeId }) {
    const statusKey = `${stateKey(nodeId)}:status`;
    // Cached status from a prior frame — synchronous read. The first
    // frame after node insertion goes through the async path below.
    const cachedStatus = ctx.state[statusKey] as
      | { ok: true; device: GPUDevice }
      | { ok: false; reason: string }
      | undefined;

    if (!cachedStatus) {
      // Kick off the device boot. While waiting, this node produces
      // no output — Particles to Image will render an empty frame.
      // Once resolved (typically within ~50ms), subsequent compute()
      // calls take the fast path below.
      void ensureWebGPUDevice(ctx).then((status) => {
        if (status.ok) {
          ctx.state[statusKey] = { ok: true, device: status.device };
        } else {
          ctx.state[statusKey] = { ok: false, reason: status.message };
        }
      });
      return;
    }
    if (!cachedStatus.ok) {
      // Surface the error via the engine's error channel. Throwing
      // here once is enough — the evaluator records the message and
      // the user-facing inspector renders it on the node.
      throw new Error(cachedStatus.reason);
    }
    const device = cachedStatus.device;

    const count = Math.max(
      64,
      Math.min(262144, Math.floor((params.count as number) ?? 4096))
    );
    const dt = Math.max(
      0.001,
      Math.min(0.1, (params.fixedDt as number) ?? 1 / 60)
    );

    const st = ensureState(ctx, device, nodeId, count);

    // Reset on time wrap — same heuristic as WebGL. Also reset on
    // first frame after (re)allocation, which the constructor sets
    // via resetNextFrame.
    const wasNonZero = st.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const resetTimeWrap = wasNonZero && isNearZero;
    const reset = st.resetNextFrame || resetTimeWrap;
    st.resetNextFrame = false;
    st.lastTime = ctx.time;

    // TODO (072226 sim #2): this backend still advances on EVERY compute, so
    // it double-steps on the offline settle re-render and split view's 2nd
    // pass (unlike rope/rigid/particle-webgl, which gate on
    // `ctx.playing || (ctx.offline && ctx.time > st.lastTime + 1e-6)`). The
    // gate is non-trivial here because the readback pipeline is a frame behind
    // (skipping a dispatch must not strand the pendingUpload chain); left for
    // a pass that can verify against a real WebGPU device. Opt-in backend.

    // ---- Drain pending readback into a WebGL texture --------------
    // This is what compute() returns this frame. Always one frame
    // behind the GPU state for the latency reasons documented above.
    if (st.pendingUpload) {
      // Release the previous output image's texture before allocating
      // a new one — the pool can reuse it.
      if (st.outputImage) ctx.releaseTexture(st.outputImage.texture);
      st.outputImage = ctx.uploadFloat32ToImage(
        st.pendingUpload,
        st.texW,
        st.texH
      );
      st.pendingUpload = null;
    }

    // ---- Pack params + dispatch compute ---------------------------
    const forceDescriptors = gatherForces(inputs).slice(0, MAX_FORCES);
    const packedForces = forceDescriptors.map(packForce);

    const boundsName = (params.boundsMode as string) ?? "off";
    const boundsMode = BOUNDS_MODE_MAP[boundsName] ?? BOUNDS_OFF;
    const boundsRest = Math.max(
      0,
      Math.min(1, (params.boundsRestitution as number) ?? 0.6)
    );

    writeParams(device, st.paramsBuffer, {
      dt,
      time: ctx.time,
      seed: ctx.frame * 0.013,
      boundsRest,
      count: st.count,
      boundsMode,
      resetFlag: reset ? 1 : 0,
      forces: packedForces,
    });

    const pipelineKey: PipelineKey = {
      forceKinds: packedForces.map((p) => p.kind),
      emitterKinds: [],
      colliderKinds: [],
      boundsMode,
    };
    const pipeline = st.pipelineCache.get(
      device,
      pipelineKey,
      buildIntegrateWgsl,
      "particle-sim-webgpu"
    );

    const view = pingPong(st.buffers, st.readIdx);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: view.readPos } },
        { binding: 1, resource: { buffer: view.readVel } },
        { binding: 2, resource: { buffer: view.writePos } },
        { binding: 3, resource: { buffer: view.writeVel } },
        { binding: 4, resource: { buffer: st.paramsBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder({
      label: "particle-sim-webgpu:step",
    });
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(st.count / 64));
      pass.end();
    }

    // Encode the readback copy on the same command buffer if no
    // earlier mapAsync is still pending. Tying the copy to the
    // compute encoder keeps the GPU pipeline tight and avoids a
    // device.queue.submit() race against a still-mapped staging
    // buffer.
    let kickReadback = false;
    if (!st.readbackBusy) {
      encoder.copyBufferToBuffer(
        view.writePos,
        0,
        st.buffers.staging,
        0,
        st.count * BYTES_PER_PARTICLE
      );
      kickReadback = true;
      st.readbackBusy = true;
    }
    device.queue.submit([encoder.finish()]);

    if (kickReadback) {
      const staging = st.buffers.staging;
      staging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          // The simulator state can be disposed between submit and
          // resolve (user removed the node, scrubbed, etc.). Guard
          // against acting on a dead state.
          if (ctx.state[stateKey(nodeId)] !== st) {
            try {
              staging.unmap();
            } catch {
              // Already unmapped or destroyed.
            }
            return;
          }
          const copy = new Float32Array(
            st.count * FLOATS_PER_PARTICLE
          );
          copy.set(
            new Float32Array(
              staging.getMappedRange(0, st.count * BYTES_PER_PARTICLE)
            )
          );
          staging.unmap();
          st.pendingUpload = copy;
          st.readbackBusy = false;
        })
        .catch((err) => {
          console.warn("particle-sim-webgpu: mapAsync rejected:", err);
          st.readbackBusy = false;
        });
    }

    // Flip ping-pong for next frame.
    st.readIdx = st.readIdx === 0 ? 1 : 0;

    // ---- Return last frame's image --------------------------------
    if (!st.outputImage) {
      // First frame — no data yet. Returning nothing lets Particles
      // to Image render an empty frame; one tick later we have data.
      return;
    }
    const out: ParticlesValue = {
      kind: "particles",
      positionTex: st.outputImage.texture,
      velocityTex: st.zeroVelocityImage.texture,
      width: st.texW,
      height: st.texH,
      count: st.count,
    };
    const result: NodeOutput = { primary: out };
    return result;
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const st = ctx.state[key] as WebGPUSimState | undefined;
    if (st) {
      disposeState(ctx, st);
      delete ctx.state[key];
    }
    delete ctx.state[`${key}:status`];
  },
};
