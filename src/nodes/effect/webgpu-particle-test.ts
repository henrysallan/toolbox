import type { NodeDefinition } from "@/engine/types";

// =====================================================================
// WebGPU Particle Test — Phase 0 spike
// =====================================================================
//
// Decision-gate node for the WebGPU migration plan in
// specdocs/archive/webgpu-particles.md. Adding this node to a project mounts a
// dedicated WebGPU canvas overlaid on the main preview canvas. The
// overlay runs its own compute + render passes on real WebGPU buffers
// — there's no WebGL2 readback in either direction.
//
// This node intentionally does NO graph-level work. Its compute() is a
// no-op; the actual WebGPU pipeline is driven by
// `components/effects/WebGPUParticleOverlay.tsx`, which observes this
// node's presence in the React graph and mounts/unmounts the overlay
// accordingly. The split keeps WebGPU code out of the engine eval loop
// for v0 — Phase 1 will move dispatch into a proper WebGPU eval bucket.
//
// What we're validating:
//   - Device boots, WGSL kernels compile, pipelines bind correctly.
//   - Dual-canvas overlay composes acceptably (z-order, alpha, DPR,
//     resize) with the WebGL2 preview canvas.
//   - 100k particles at 60fps with headroom.
//
// If any of those fail, this node and its overlay get ripped out and
// the migration plan reconsiders Option 1 (per-frame readback).

const COUNT_OPTIONS = ["1k", "10k", "100k", "500k"] as const;
const COUNT_VALUES: Record<(typeof COUNT_OPTIONS)[number], number> = {
  "1k": 1_000,
  "10k": 10_000,
  "100k": 100_000,
  "500k": 500_000,
};

export function resolveParticleTestCount(label: unknown): number {
  const key = (typeof label === "string" ? label : "100k") as
    | keyof typeof COUNT_VALUES
    | string;
  return (
    COUNT_VALUES[key as keyof typeof COUNT_VALUES] ?? COUNT_VALUES["100k"]
  );
}

export const webgpuParticleTestNode: NodeDefinition = {
  type: "webgpu-particle-test",
  name: "WebGPU Particle Test",
  category: "effect",
  description:
    "Phase 0 spike for the WebGPU particle migration. Renders an isolated WebGPU particle system on an overlay canvas. Validates device boot, kernel compile, dual-canvas compositing, and 100k particles @ 60fps before the real simulator is ported. Not a graph node — produces no output.",
  backend: "webgpu",
  // No inputs and no outputs; the node is a scene-level "tag" that the
  // overlay component reacts to. Marking terminal so the evaluator
  // doesn't skip it as a dead branch.
  terminal: true,
  // Params change at most once per user interaction; nothing in this
  // node reads time, so cache freely.
  stable: true,
  inputs: [],
  params: [
    {
      name: "count",
      label: "Count",
      type: "enum",
      options: [...COUNT_OPTIONS],
      default: "100k",
    },
    {
      name: "gravity",
      label: "Gravity",
      type: "scalar",
      min: -5,
      max: 5,
      step: 0.01,
      default: 0.8,
    },
    {
      name: "damping",
      label: "Damping",
      type: "scalar",
      min: 0.9,
      max: 1.0,
      step: 0.001,
      default: 0.999,
    },
    {
      name: "pointSize",
      label: "Point size (px)",
      type: "scalar",
      min: 1,
      max: 12,
      step: 0.1,
      default: 2.5,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1_000_000,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: null,
  auxOutputs: [],
  compute() {
    // Intentionally empty. The overlay component reads this node's
    // params straight off the React graph and drives WebGPU directly.
    return;
  },
};
