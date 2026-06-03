// =====================================================================
// Particle buffer helpers — Phase 1 infrastructure
// =====================================================================
//
// Allocation + ping-pong management for the WebGPU particle simulator.
// The layout deliberately mirrors the WebGL simulator's texture
// channel packing so the kernel logic ports 1:1:
//
//   pos[i] = vec4<f32>(x, y, age, lifetime)   // age 0 = dead
//   vel[i] = vec4<f32>(vx, vy, _, _)
//
// We retain the (width, height) abstraction the WebGL path uses —
// every count rounds up to a square so future algorithms that want a
// 2D tile layout (sort, scan, neighbor binning per Phase post-1) keep
// it as an option without re-plumbing.

import { peekWebGPUDevice } from "./device";
import type { RenderContext } from "@/engine/types";

export const FLOATS_PER_PARTICLE = 4;
export const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4;

export interface ParticleBuffers {
  // Ping-pong pair. The kernel reads from posRead/velRead and writes
  // to posWrite/velWrite; the consumer flips `readIdx` between frames.
  posA: GPUBuffer;
  posB: GPUBuffer;
  velA: GPUBuffer;
  velB: GPUBuffer;
  // Staging buffer for sync readback (CPU bridge to the WebGL renderer
  // in Phase 1). Sized for the position buffer only — velocity isn't
  // read on the WebGL side. Reused across frames.
  staging: GPUBuffer;
  capacity: number; // particles
  width: number;
  height: number;
}

// Round `count` up to a square edge. count=1000 → 32×32=1024.
export function pickSquare(count: number): { w: number; h: number } {
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { w: side, h: side };
}

export function createParticleBuffers(
  device: GPUDevice,
  count: number
): ParticleBuffers {
  const { w, h } = pickSquare(count);
  const capacity = w * h;
  const byteLen = capacity * BYTES_PER_PARTICLE;
  const make = (label: string) =>
    device.createBuffer({
      label,
      size: byteLen,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  const posA = make("particle:pos-a");
  const posB = make("particle:pos-b");
  const velA = make("particle:vel-a");
  const velB = make("particle:vel-b");
  const staging = device.createBuffer({
    label: "particle:staging",
    size: byteLen,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  // Zero-init. Without this, dead-slot detection (age == 0) would
  // randomly bring slots alive based on whatever was left in memory.
  const zero = new Float32Array(capacity * FLOATS_PER_PARTICLE);
  device.queue.writeBuffer(posA, 0, zero);
  device.queue.writeBuffer(posB, 0, zero);
  device.queue.writeBuffer(velA, 0, zero);
  device.queue.writeBuffer(velB, 0, zero);
  return { posA, posB, velA, velB, staging, capacity, width: w, height: h };
}

export function destroyParticleBuffers(b: ParticleBuffers): void {
  b.posA.destroy();
  b.posB.destroy();
  b.velA.destroy();
  b.velB.destroy();
  b.staging.destroy();
}

// Read-side / write-side selection for the current frame. Centralized
// so callers don't reimplement the bookkeeping.
export interface PingPongView {
  readPos: GPUBuffer;
  readVel: GPUBuffer;
  writePos: GPUBuffer;
  writeVel: GPUBuffer;
}

export function pingPong(
  b: ParticleBuffers,
  readIdx: 0 | 1
): PingPongView {
  if (readIdx === 0) {
    return {
      readPos: b.posA,
      readVel: b.velA,
      writePos: b.posB,
      writeVel: b.velB,
    };
  }
  return {
    readPos: b.posB,
    readVel: b.velB,
    writePos: b.posA,
    writeVel: b.velA,
  };
}

// Convenience: dispose all buffers referenced by a state object held
// in ctx.state. No-op if the device wasn't booted (callers can drop
// the whole state object in that case).
export function disposeIfBooted(
  ctx: RenderContext,
  buffers: ParticleBuffers
): void {
  const status = peekWebGPUDevice(ctx);
  if (!status?.ok) return;
  destroyParticleBuffers(buffers);
}
