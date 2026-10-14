import {
  defineSkslNode,
  type SkslLibFunctionDef,
  type SkslNodeInput,
  type SkslNodeSpec,
} from "@/engine/skia/library";
import type { NodeDefinition, SocketValue } from "@/engine/types";

// One Skia node whose SkSL function depends on STRUCTURAL settings — an
// enum that picks an algorithm, a toggle that adds a clock, a socket that
// is wired or not — built on the frozen defineSkslNode factory
// (engine/skia/library/define-node.ts) without changing it.
//
// Each variant is a complete defineSkslNode def (its own library function,
// sockets and binds); the public def shows the union of the sockets and
// delegates compute to the variant `pick` selects. So a fused program holds
// only the code the node's current settings run: Noise (Skia) on perlin
// ships perlin, not NOISE_FS's eleven-way dispatch, and only a looping
// noise reads iTime (Skia Fill re-renders per frame only then).
//
// Why not one function with an int `type` uniform: every program would
// carry all eleven algorithms (register pressure on phones is the union of
// the branches), the cost model could not tell phasor (9 taps) from value
// noise, and a non-looping noise would still read iTime.
//
// Switching a variant changes the program text, which is what the exporter
// treats as structure: a keyframed `type` refuses to export with the frame
// it changes at (scene-plan.ts verification), instead of shipping a wrong
// algorithm.
//
// Variant 0 is the default and is registered under the public type, so
// skslNodeSpec(type) answers for the node; the others register under
// `<type>~<key>` (internal — never passed to registerNode).

export interface SkslVariant {
  key: string;
  fn: SkslLibFunctionDef;
  // Sockets that feed this variant's function (a subset of `sockets`).
  inputs?: SkslNodeInput[];
  binds?: SkslNodeSpec["binds"];
}

export interface SkslVariantNodeSpec extends Omit<SkslNodeSpec, "fn" | "inputs" | "binds"> {
  variants: SkslVariant[];
  // Every shader socket the node shows, whatever the variant.
  sockets?: SkslNodeInput[];
  // The variant key for these params and this wiring.
  pick(params: Record<string, unknown>, wired: (socket: string) => boolean): string;
}

export function defineSkslVariantNode(spec: SkslVariantNodeSpec): NodeDefinition {
  const { variants, sockets = [], pick, ...common } = spec;
  if (!variants.length) throw new Error(`${spec.type}: defineSkslVariantNode needs at least one variant`);
  const defs = new Map<string, NodeDefinition>();
  variants.forEach((v, i) => {
    if (defs.has(v.key)) throw new Error(`${spec.type}: variant "${v.key}" is declared twice`);
    defs.set(
      v.key,
      defineSkslNode({
        ...common,
        type: i === 0 ? spec.type : `${spec.type}~${v.key}`,
        fn: v.fn,
        ...(v.inputs ? { inputs: v.inputs } : {}),
        ...(v.binds ? { binds: v.binds } : {}),
      })
    );
  });
  const base = defs.get(variants[0].key)!;
  const select = (params: Record<string, unknown>, inputs: Record<string, SocketValue | undefined>) => {
    const key = pick(params, (name) => inputs[name]?.kind === "skia_shader");
    return defs.get(key) ?? base;
  };
  return {
    ...base,
    inputs: sockets.map((i) => ({
      name: i.name,
      ...(i.label ? { label: i.label } : {}),
      type: "skia_shader",
      required: false,
    })),
    // The fingerprint cannot see the wiring: a variant that reads the clock
    // must be decidable from params, so ask both wiring extremes.
    fingerprintExtras(params, ctx, nodeId) {
      const none = defs.get(pick(params, () => false)) ?? base;
      const all = defs.get(pick(params, () => true)) ?? base;
      const a = none.fingerprintExtras?.(params, ctx, nodeId) ?? "";
      const b = all.fingerprintExtras?.(params, ctx, nodeId) ?? "";
      return a === b ? a : `${a}|${b}`;
    },
    compute(args) {
      return select(args.params, args.inputs).compute(args);
    },
  };
}
