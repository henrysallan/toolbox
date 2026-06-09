// =====================================================================
// Stipple relaxation — WebGPU runner
// =====================================================================
//
// Owns the GPU resources and dispatch sequence for the relaxation
// kernel in wgsl/stipple-relax.ts. The stipple node holds one
// `StippleRelaxGPU` in its per-node state and calls `runStippleRelax`
// whenever it needs a fresh relaxed point set. Buffers are reused
// frame-to-frame and only reallocated when capacity grows or the cell
// grid changes — important because the bottleneck case (animated source
// fed into packed mode) rebakes every frame.
//
// The single CPU↔GPU round trip per bake: positions in (writeBuffer,
// tiny) + source image in (writeBuffer, the big upload) → K iterations
// of clear/bin/relax → positions out (mapAsync, tiny). Pipelines compile
// once on first use and are cached on the resource object.

import STIPPLE_RELAX_WGSL from "./wgsl/stipple-relax";

// Max points per cell the bin lists hold. The CPU relaxation has no cap;
// with density-weighted jittered points on a grid sized to the output
// cell grid, cells almost never exceed a handful. 32 is generous.
export const STIPPLE_BIN_CAP = 32;

const WORKGROUP = 64;
const PARAMS_BYTES = 48; // 12 × 4-byte scalars, 16-byte aligned

export interface StippleRelaxGPU {
  device: GPUDevice;
  bgl: GPUBindGroupLayout;
  clearPipeline: GPUComputePipeline;
  binPipeline: GPUComputePipeline;
  relaxPipeline: GPUComputePipeline;

  uniform: GPUBuffer;
  posA: GPUBuffer;
  posB: GPUBuffer;
  src: GPUBuffer;
  counts: GPUBuffer;
  bins: GPUBuffer;
  staging: GPUBuffer;

  // Bind groups for the two ping-pong orientations. bgAB reads posA /
  // writes posB; bgBA reads posB / writes posA. Rebuilt on realloc.
  bgAB: GPUBindGroup;
  bgBA: GPUBindGroup;

  // Capacities the current buffers were allocated for.
  posCap: number; // points
  srcCap: number; // floats (imgW*imgH*4)
  cellCap: number; // cells (cellsX*cellsY)
  cap: number; // bin cap baked into the layout/dispatch

  // Reused scratch so we don't allocate a fresh interleaved array every
  // bake. Grown alongside posCap.
  scratch: Float32Array;
}

function makeBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  usage: number
): GPUBuffer {
  return device.createBuffer({ label, size, usage });
}

function buildBindGroups(g: StippleRelaxGPU): void {
  const common = (readPos: GPUBuffer, writePos: GPUBuffer): GPUBindGroup =>
    g.device.createBindGroup({
      label: "stipple-relax:bg",
      layout: g.bgl,
      entries: [
        { binding: 0, resource: { buffer: g.uniform } },
        { binding: 1, resource: { buffer: readPos } },
        { binding: 2, resource: { buffer: writePos } },
        { binding: 3, resource: { buffer: g.src } },
        { binding: 4, resource: { buffer: g.counts } },
        { binding: 5, resource: { buffer: g.bins } },
      ],
    });
  g.bgAB = common(g.posA, g.posB);
  g.bgBA = common(g.posB, g.posA);
}

// Create or grow the GPU resources for a bake of `n` points over a
// `cellsX × cellsY` grid with a source image of `srcFloats` floats.
// Pipelines are built once; buffers grow monotonically (never shrink) so
// a settled scene stops reallocating.
export function ensureStippleRelaxGPU(
  device: GPUDevice,
  prev: StippleRelaxGPU | null,
  n: number,
  cells: number,
  srcFloats: number
): StippleRelaxGPU {
  const cap = STIPPLE_BIN_CAP;

  let g = prev;
  if (!g || g.device !== device) {
    // First build: compile pipelines + explicit shared layout so all
    // three kernels reuse the same two bind groups.
    const shaderModule = device.createShaderModule({
      label: "stipple-relax:module",
      code: STIPPLE_RELAX_WGSL,
    });
    const storage = (ro: boolean): GPUBindGroupLayoutEntry["buffer"] => ({
      type: ro ? "read-only-storage" : "storage",
    });
    const bgl = device.createBindGroupLayout({
      label: "stipple-relax:bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      ],
    });
    const layout = device.createPipelineLayout({
      label: "stipple-relax:layout",
      bindGroupLayouts: [bgl],
    });
    const pipe = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `stipple-relax:${entryPoint}`,
        layout,
        compute: { module: shaderModule, entryPoint },
      });
    g = {
      device,
      bgl,
      clearPipeline: pipe("clearCounts"),
      binPipeline: pipe("bin"),
      relaxPipeline: pipe("relax"),
      uniform: makeBuffer(
        device,
        "stipple-relax:uniform",
        PARAMS_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      ),
      // Placeholders; (re)allocated just below.
      posA: null as unknown as GPUBuffer,
      posB: null as unknown as GPUBuffer,
      src: null as unknown as GPUBuffer,
      counts: null as unknown as GPUBuffer,
      bins: null as unknown as GPUBuffer,
      staging: null as unknown as GPUBuffer,
      bgAB: null as unknown as GPUBindGroup,
      bgBA: null as unknown as GPUBindGroup,
      posCap: 0,
      srcCap: 0,
      cellCap: 0,
      cap,
      scratch: new Float32Array(0),
    };
  }

  let realloc = false;

  if (n > g.posCap) {
    g.posA?.destroy();
    g.posB?.destroy();
    g.staging?.destroy();
    const bytes = n * 2 * 4;
    const posUsage =
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    g.posA = makeBuffer(device, "stipple-relax:posA", bytes, posUsage);
    g.posB = makeBuffer(device, "stipple-relax:posB", bytes, posUsage);
    g.staging = makeBuffer(
      device,
      "stipple-relax:staging",
      bytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    );
    g.scratch = new Float32Array(n * 2);
    g.posCap = n;
    realloc = true;
  }

  if (srcFloats > g.srcCap) {
    g.src?.destroy();
    g.src = makeBuffer(
      device,
      "stipple-relax:src",
      srcFloats * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    );
    g.srcCap = srcFloats;
    realloc = true;
  }

  if (cells > g.cellCap) {
    g.counts?.destroy();
    g.bins?.destroy();
    g.counts = makeBuffer(
      device,
      "stipple-relax:counts",
      cells * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    );
    g.bins = makeBuffer(
      device,
      "stipple-relax:bins",
      cells * cap * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    );
    g.cellCap = cells;
    realloc = true;
  }

  if (realloc) buildBindGroups(g);
  return g;
}

export function destroyStippleRelaxGPU(g: StippleRelaxGPU): void {
  g.uniform.destroy();
  g.posA?.destroy();
  g.posB?.destroy();
  g.src?.destroy();
  g.counts?.destroy();
  g.bins?.destroy();
  g.staging?.destroy();
}

export interface StippleRelaxArgs {
  cellsX: number;
  cellsY: number;
  imgW: number;
  imgH: number;
  invert: boolean;
  curve: number;
  stepBase: number;
  iterations: number;
}

// Run `iterations` of the relaxation on the GPU. `xs`/`ys` are the
// CPU-sampled point positions in UV space (length n); `srcData` is the
// raw RGBA float image. Returns fresh relaxed xs/ys. Async because the
// final position readback goes through mapAsync — WebGPU has no
// synchronous buffer read.
export async function runStippleRelax(
  g: StippleRelaxGPU,
  xs: Float32Array,
  ys: Float32Array,
  srcData: Float32Array,
  args: StippleRelaxArgs
): Promise<{ xs: Float32Array; ys: Float32Array }> {
  const { device } = g;
  const n = xs.length;
  const cells = args.cellsX * args.cellsY;

  // Nothing to relax (e.g. a near-white image rejected almost every
  // sample). Zero-size buffer ops are invalid, so bail with the input.
  if (n === 0) return { xs: new Float32Array(0), ys: new Float32Array(0) };

  // ----- Uniforms -----
  const ub = new ArrayBuffer(PARAMS_BYTES);
  const dv = new DataView(ub);
  dv.setUint32(0, args.imgW, true);
  dv.setUint32(4, args.imgH, true);
  dv.setUint32(8, args.cellsX, true);
  dv.setUint32(12, args.cellsY, true);
  dv.setUint32(16, n, true);
  dv.setUint32(20, g.cap, true);
  dv.setUint32(24, args.invert ? 1 : 0, true);
  dv.setUint32(28, 0, true);
  dv.setFloat32(32, args.stepBase, true);
  dv.setFloat32(36, args.curve, true);
  device.queue.writeBuffer(g.uniform, 0, ub);

  // ----- Inputs: interleave positions, upload src -----
  // Pass typed-array views (not .buffer) so writeBuffer respects each
  // view's byteOffset — readImageToFloat32 / scratch could be subarrays.
  const scratch = g.scratch;
  for (let i = 0; i < n; i++) {
    scratch[i * 2] = xs[i];
    scratch[i * 2 + 1] = ys[i];
  }
  device.queue.writeBuffer(g.posA, 0, scratch.buffer, scratch.byteOffset, n * 2 * 4);
  device.queue.writeBuffer(
    g.src, 0, srcData.buffer, srcData.byteOffset, args.imgW * args.imgH * 4 * 4
  );

  // ----- Dispatch K iterations -----
  const encoder = device.createCommandEncoder({ label: "stipple-relax:encode" });
  const pointGroups = Math.ceil(n / WORKGROUP);
  const cellGroups = Math.ceil(cells / WORKGROUP);

  // Each stage is its own compute pass: WebGPU guarantees the writes from
  // one pass are visible to the next, so bin sees a cleared counts buffer
  // and relax sees fully-populated bins — no manual barriers, no reliance
  // on intra-pass ordering. Track which buffer holds the latest positions:
  // we start reading from posA (bgAB writes posB), so the latest flips each
  // iteration.
  let latestIsB = false;
  for (let iter = 0; iter < args.iterations; iter++) {
    const bg = latestIsB ? g.bgBA : g.bgAB; // read = latest, write = other
    const clearPass = encoder.beginComputePass({ label: `stipple-relax:clear${iter}` });
    clearPass.setBindGroup(0, bg);
    clearPass.setPipeline(g.clearPipeline);
    clearPass.dispatchWorkgroups(cellGroups);
    clearPass.end();

    const binPass = encoder.beginComputePass({ label: `stipple-relax:bin${iter}` });
    binPass.setBindGroup(0, bg);
    binPass.setPipeline(g.binPipeline);
    binPass.dispatchWorkgroups(pointGroups);
    binPass.end();

    const relaxPass = encoder.beginComputePass({ label: `stipple-relax:relax${iter}` });
    relaxPass.setBindGroup(0, bg);
    relaxPass.setPipeline(g.relaxPipeline);
    relaxPass.dispatchWorkgroups(pointGroups);
    relaxPass.end();

    latestIsB = !latestIsB;
  }

  const latest = latestIsB ? g.posB : g.posA;
  encoder.copyBufferToBuffer(latest, 0, g.staging, 0, n * 2 * 4);
  device.queue.submit([encoder.finish()]);

  // ----- Readback -----
  await g.staging.mapAsync(GPUMapMode.READ, 0, n * 2 * 4);
  const mapped = new Float32Array(g.staging.getMappedRange(0, n * 2 * 4));
  const outX = new Float32Array(n);
  const outY = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    outX[i] = mapped[i * 2];
    outY[i] = mapped[i * 2 + 1];
  }
  g.staging.unmap();
  return { xs: outX, ys: outY };
}
