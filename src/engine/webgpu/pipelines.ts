// =====================================================================
// Pipeline cache — Phase 1 infrastructure
// =====================================================================
//
// Compute pipelines are expensive to build (shader module + pipeline
// compile is on the order of tens of milliseconds per call on a cold
// adapter). We cache them keyed on the *structural* shape of the
// graph wired to a node — i.e. which kinds of force / emitter /
// collider are present in what order — so that a stable wiring
// resolves to one compile per session.
//
// Same trick the SDF compiler uses for its WebGL fragment programs
// (see engine/sdf-compile.ts). The cache key is a small string and
// lookups are O(1). Pipelines aren't released — they're tiny GPU-side
// objects and the graph's structural variety is bounded.

export interface PipelineKey {
  // Kind integers in slot order. Mirrors the WebGL kernel's
  // FORCE_KIND / EMITTER_KIND / COLLIDER_KIND maps.
  forceKinds: number[];
  emitterKinds: number[];
  colliderKinds: number[];
  // Screen-bounds resolver mode. 0=off 1=bounce 2=wrap 3=clamp 4=kill.
  boundsMode: number;
}

// Serialize a key into a short canonical string. We don't sort —
// kernel branching follows slot order, so two configs with the same
// kinds in a different order are genuinely different pipelines.
export function structuralKey(k: PipelineKey): string {
  return (
    "f[" + k.forceKinds.join(",") +
    "]e[" + k.emitterKinds.join(",") +
    "]c[" + k.colliderKinds.join(",") +
    "]b" + k.boundsMode
  );
}

// Source-builder callback. The cache calls this only on a miss; it
// returns the full WGSL source. Building the source inside the
// callback (rather than passing a string) avoids the upfront cost on
// every frame even when the cache hits.
export type WgslBuilder = (key: PipelineKey) => string;

export class ComputePipelineCache {
  private cache = new Map<string, GPUComputePipeline>();
  // Shader modules and pipelines together — we keep the module handle
  // in case future code wants to inspect compilation messages.
  private modules = new Map<string, GPUShaderModule>();

  get(
    device: GPUDevice,
    key: PipelineKey,
    builder: WgslBuilder,
    label = "particle-sim"
  ): GPUComputePipeline {
    const k = structuralKey(key);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const code = builder(key);
    const shaderModule = device.createShaderModule({
      label: `${label}:module:${k}`,
      code,
    });
    const pipeline = device.createComputePipeline({
      label: `${label}:pipeline:${k}`,
      layout: "auto",
      compute: { module: shaderModule, entryPoint: "main" },
    });
    this.modules.set(k, shaderModule);
    this.cache.set(k, pipeline);
    return pipeline;
  }

  // Diagnostic — current cache size. Useful for asserting that
  // structural variety isn't blowing up in long sessions.
  size(): number {
    return this.cache.size;
  }
}
