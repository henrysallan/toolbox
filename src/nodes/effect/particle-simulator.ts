import type { NodeDefinition } from "@/engine/types";
import { particleSimulatorWebGLNode } from "./particle-simulator-webgl";
import { particleSimulatorWebGPUNode } from "./particle-simulator-webgpu";

// =====================================================================
// Particle Simulator — backend router
// =====================================================================
//
// Single registered "particle-simulator" node. Routes compute / init /
// dispose to either the legacy WebGL fragment-GPGPU implementation
// (particle-simulator-webgl.ts) or the in-progress WebGPU compute
// kernel (particle-simulator-webgpu.ts) based on the node's `backend`
// param (default "webgl").
//
// Surfacing the choice as a per-node param (rather than a global
// preference) is deliberate during the migration: you can drop two
// simulators into the same graph with one on each backend and
// compare visual output side-by-side. Once the WebGPU path reaches
// parity (post-Phase 4 in specdocs/archive/webgpu-particles.md) we flip the
// default to "webgpu"; one stable release later the legacy file
// gets deleted along with this router.
//
// Both backends share the same input/param schema (re-exported from
// the WebGL node). Switching backends mid-session discards the live
// simulation state — state is keyed distinctly per backend
// (`particle-simulator:<id>` vs `particle-simulator:<id>:webgpu`, both
// under the registered type so the dispose sweep reaches them) — and
// the kernel resets on the next compute().

function pickBackend(params: Record<string, unknown>): NodeDefinition {
  return params.backend === "webgpu"
    ? particleSimulatorWebGPUNode
    : particleSimulatorWebGLNode;
}

export const particleSimulatorNode: NodeDefinition = {
  type: "particle-simulator",
  name: "Particle Simulator",
  category: "effect",
  description: particleSimulatorWebGLNode.description,
  // Reported as "webgl2" for graph-coloring purposes since the WebGL
  // path is still the default. The actual backend in use is resolved
  // per-compute via the `backend` param. When WebGPU becomes the
  // default we'll flip this to "webgpu".
  backend: "webgl2",
  stable: false,
  // Both backends accumulate across frames. The flag has to live on the
  // ROUTER — this is the def the registry hands out, and the export
  // drivers read it off the registry, not off the routed-to node.
  simulation: true,
  inputs: particleSimulatorWebGLNode.inputs,
  resolveInputs: particleSimulatorWebGLNode.resolveInputs,
  resolveAuxOutputs: particleSimulatorWebGLNode.resolveAuxOutputs,
  params: particleSimulatorWebGLNode.params,
  primaryOutput: particleSimulatorWebGLNode.primaryOutput,
  auxOutputs: particleSimulatorWebGLNode.auxOutputs,
  fingerprintExtras(params, ctx) {
    // Include the backend tag in the fingerprint so flipping the
    // param busts the eval cache and a fresh frame routes through
    // the new backend immediately. Without this the cached output
    // from the prior backend would stick until something else
    // invalidates the node.
    const tag = params.backend === "webgpu" ? "wgpu" : "wgl2";
    const base =
      particleSimulatorWebGLNode.fingerprintExtras?.(params, ctx) ?? "";
    return base + `|${tag}`;
  },

  compute(args) {
    return pickBackend(args.params).compute(args);
  },
  dispose(ctx, nodeId) {
    // On dispose, tear down BOTH backends' state. We don't know which
    // one was last active without bookkeeping, and the disposers are
    // both idempotent (no-op if their state key isn't present), so
    // calling both is the safe play.
    particleSimulatorWebGLNode.dispose?.(ctx, nodeId);
    particleSimulatorWebGPUNode.dispose?.(ctx, nodeId);
  },
};
