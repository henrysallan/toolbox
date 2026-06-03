// =====================================================================
// WebGPU Particle Test Scene — Phase 0 spike
// =====================================================================
//
// Self-contained WebGPU particle scene used by the WebGPU Particle Test
// node + overlay. The whole purpose of this module is to validate the
// system boundaries described in specdocs/webgpu-particles.md before we
// rewrite the real simulator:
//
//   - Device boots, kernels compile, pipelines bind.
//   - Compute → render → present round-trips on a dedicated canvas.
//   - 100k particles at 60fps comfortably.
//
// No graph integration, no socket types, no force/emitter/collider
// descriptors. Just `pos += vel * dt`, gravity, bounds-bounce, and
// instanced quad rendering. Everything here is throwaway once Phase 1
// ports the real simulator — that work will build proper
// device.ts / buffers.ts / pipelines.ts modules.

// Clip-space layout. Each particle is a vec4 (x, y, _, _).
const FLOATS_PER_PARTICLE = 4;
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4;

// std140-ish uniform block: 4 × f32 = 16 bytes (minimum buffer size on
// some adapters is 16). Layout MUST match the WGSL struct below.
//   dt:       f32  — seconds since last step
//   gravity:  f32  — applied to v.y each step
//   damping:  f32  — air-drag multiplier (1.0 = no drag)
//   count:    u32  — live particle count
const UNIFORM_BYTES = 16;

const COMPUTE_WGSL = /* wgsl */ `
struct Params {
  dt: f32,
  gravity: f32,
  damping: f32,
  count: u32,
};

@group(0) @binding(0) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }

  var p = pos[i];
  var v = vel[i];

  v.y = v.y + params.gravity * params.dt;
  v.x = v.x * params.damping;
  v.y = v.y * params.damping;

  p.x = p.x + v.x * params.dt;
  p.y = p.y + v.y * params.dt;

  // Bounds bounce in clip space [-1, 1], with energy loss so particles
  // settle into the bottom instead of resonating forever.
  let restitution = 0.78;
  if (p.x < -1.0) { p.x = -1.0; v.x = -v.x * restitution; }
  if (p.x >  1.0) { p.x =  1.0; v.x = -v.x * restitution; }
  if (p.y < -1.0) { p.y = -1.0; v.y = -v.y * restitution; }
  if (p.y >  1.0) { p.y =  1.0; v.y = -v.y * restitution; }

  pos[i] = p;
  vel[i] = v;
}
`;

const RENDER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pos: array<vec4<f32>>;

struct RenderParams {
  pointSize: f32,
  aspect: f32,
};
@group(0) @binding(1) var<uniform> render_params: RenderParams;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
};

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> VertexOut {
  // Two triangles, six verts, unit quad in [-1, 1].
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let local = quad[vi];
  let particle = pos[ii];
  // Compensate aspect so points stay round on non-square canvases.
  let offset = vec2<f32>(
    local.x * render_params.pointSize,
    local.y * render_params.pointSize * render_params.aspect,
  );
  var out: VertexOut;
  out.position = vec4<f32>(particle.x + offset.x, particle.y + offset.y, 0.0, 1.0);
  out.local = local;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  // Soft falloff. Pre-multiplied alpha so additive-ish blending stacks
  // nicely without needing a separate pass.
  let a = pow(1.0 - d, 1.6) * 0.65;
  let c = vec3<f32>(1.0, 0.78, 0.45) * a;
  return vec4<f32>(c, a);
}
`;

export interface TestSceneOptions {
  count: number;
  gravity: number;
  damping: number;
  // CSS-pixel size of each rendered point. Translated to clip-space
  // size internally using the current canvas dimensions.
  pointSizePx: number;
}

export class WebGPUTestScene {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;

  private posBuffer: GPUBuffer;
  private velBuffer: GPUBuffer;
  private simUniform: GPUBuffer;
  private renderUniform: GPUBuffer;

  private computePipeline: GPUComputePipeline;
  private renderPipeline: GPURenderPipeline;
  private computeBindGroup: GPUBindGroup;
  private renderBindGroup: GPUBindGroup;

  count: number;
  options: TestSceneOptions;
  // Dimensions of the underlying canvas's framebuffer in device pixels.
  // Owned here so resize() can rebuild things if we ever need to (the
  // context itself doesn't need re-configuring on size change — WebGPU
  // sizes the swap chain off the canvas attributes directly).
  private fbWidth = 0;
  private fbHeight = 0;
  private disposed = false;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    options: TestSceneOptions
  ) {
    this.device = device;
    this.canvas = canvas;
    this.options = options;
    this.count = options.count;

    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("WebGPU canvas context unavailable.");
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device,
      format: this.format,
      alphaMode: "premultiplied",
    });

    // ---- Buffers ---------------------------------------------------
    const byteLen = options.count * BYTES_PER_PARTICLE;
    this.posBuffer = device.createBuffer({
      label: "particle-test:pos",
      size: byteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.velBuffer = device.createBuffer({
      label: "particle-test:vel",
      size: byteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.simUniform = device.createBuffer({
      label: "particle-test:sim-uniform",
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.renderUniform = device.createBuffer({
      label: "particle-test:render-uniform",
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.seedParticles();

    // ---- Pipelines -------------------------------------------------
    const computeModule = device.createShaderModule({
      label: "particle-test:compute",
      code: COMPUTE_WGSL,
    });
    this.computePipeline = device.createComputePipeline({
      label: "particle-test:compute-pipeline",
      layout: "auto",
      compute: { module: computeModule, entryPoint: "step" },
    });

    const renderModule = device.createShaderModule({
      label: "particle-test:render",
      code: RENDER_WGSL,
    });
    this.renderPipeline = device.createRenderPipeline({
      label: "particle-test:render-pipeline",
      layout: "auto",
      vertex: { module: renderModule, entryPoint: "vs" },
      fragment: {
        module: renderModule,
        entryPoint: "fs",
        targets: [
          {
            format: this.format,
            blend: {
              // Pre-multiplied alpha. Matches the .configure() alphaMode
              // above, and the fragment shader's pre-multiplied output.
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.computeBindGroup = device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.posBuffer } },
        { binding: 1, resource: { buffer: this.velBuffer } },
        { binding: 2, resource: { buffer: this.simUniform } },
      ],
    });
    this.renderBindGroup = device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.posBuffer } },
        { binding: 1, resource: { buffer: this.renderUniform } },
      ],
    });
  }

  // Re-randomize positions and velocities. Called from the ctor and
  // whenever the user hits "restart" on the node.
  seedParticles() {
    const data = new Float32Array(this.options.count * FLOATS_PER_PARTICLE);
    for (let i = 0; i < this.options.count; i++) {
      const o = i * FLOATS_PER_PARTICLE;
      // Spawn in a centered disc so the initial frame reads as a
      // recognizable shape rather than uniform static.
      const r = Math.sqrt(Math.random()) * 0.5;
      const a = Math.random() * Math.PI * 2;
      data[o + 0] = Math.cos(a) * r;
      data[o + 1] = Math.sin(a) * r;
    }
    this.device.queue.writeBuffer(this.posBuffer, 0, data);
    const vel = new Float32Array(this.options.count * FLOATS_PER_PARTICLE);
    for (let i = 0; i < this.options.count; i++) {
      const o = i * FLOATS_PER_PARTICLE;
      vel[o + 0] = (Math.random() - 0.5) * 1.2;
      vel[o + 1] = (Math.random() - 0.5) * 1.2;
    }
    this.device.queue.writeBuffer(this.velBuffer, 0, vel);
  }

  // Update tunables without rebuilding pipelines. count changes require
  // a full rebuild (buffer size changes) — caller should dispose and
  // recreate the scene for those.
  setOptions(opts: Partial<Omit<TestSceneOptions, "count">>) {
    this.options = { ...this.options, ...opts };
  }

  // Track the underlying canvas's framebuffer size so the render pass
  // matches it. Doesn't reconfigure the context — `canvas.width/height`
  // already drive the swap chain extent.
  resize(fbWidth: number, fbHeight: number) {
    this.fbWidth = fbWidth;
    this.fbHeight = fbHeight;
  }

  step(dt: number) {
    if (this.disposed) return;
    const u = new ArrayBuffer(UNIFORM_BYTES);
    const f = new Float32Array(u);
    const i32 = new Uint32Array(u);
    f[0] = dt;
    f[1] = this.options.gravity;
    f[2] = this.options.damping;
    i32[3] = this.count;
    this.device.queue.writeBuffer(this.simUniform, 0, u);

    const encoder = this.device.createCommandEncoder({
      label: "particle-test:step",
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    const workgroups = Math.ceil(this.count / 64);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  render() {
    if (this.disposed) return;
    if (this.fbWidth === 0 || this.fbHeight === 0) return;

    const pointClip = (this.options.pointSizePx / this.fbWidth) * 2;
    const aspect = this.fbWidth / Math.max(1, this.fbHeight);
    const ru = new ArrayBuffer(UNIFORM_BYTES);
    const rf = new Float32Array(ru);
    rf[0] = pointClip;
    rf[1] = aspect;
    this.device.queue.writeBuffer(this.renderUniform, 0, ru);

    const encoder = this.device.createCommandEncoder({
      label: "particle-test:render",
    });
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    // 6 verts per instance, one instance per particle.
    pass.draw(6, this.count, 0, 0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.posBuffer.destroy();
    this.velBuffer.destroy();
    this.simUniform.destroy();
    this.renderUniform.destroy();
    // Releasing the canvas context isn't strictly required, but
    // unconfiguring it stops the swap chain from holding onto resources
    // after the overlay unmounts.
    try {
      this.context.unconfigure();
    } catch {
      // Older Safari versions don't expose unconfigure; ignore.
    }
  }
}
