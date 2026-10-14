import { TBX_GATHER_FLAT } from "@/engine/skia/library/helpers-gather";
import type { Bind } from "@/engine/skia/scene-ir";
import type { NodeDefinition, SkiaShaderValue, SocketValue } from "@/engine/types";

// Wiring-aware Skia gathers. Several GL gathers change behavior with what is
// WIRED, not only with params — Displace passes through without a map,
// Vector Field passes its `field` through without a source, Flow Blur and
// Kuwahara compute an internal (multipass) field when theirs is unwired.
// defineSkslNode's `binds` / `unsupported` see params only, so this wrapper
// runs before the factory's compute and:
//
//   1. records which `skia_shader` inputs are wired, under WIRED_KEY in the
//      params the factory sees (read it back with wiredInputs());
//   2. optionally rewrites the inputs (Displace feeds a constant midlevel
//      map; Bevel & Emboss reads its image as the height when height is
//      unwired).
//
// Nothing is stored: WIRED_KEY exists only in the params object handed to
// the factory for this evaluation. Callers without wiring (validateParams,
// the recipe validator, skslNodeProblems) get null from wiredInputs() and
// must not report wiring problems.
//
// Proposed upstream as an additive contract change: `wired` on
// SkslBindArgs and a second `wired` argument to `unsupported`.

const WIRED_KEY = "__skia_wired";

export type ShaderInputs = Record<string, SocketValue | undefined>;

export function wiredInputs(params: Record<string, unknown>): ReadonlySet<string> | null {
  const v = params[WIRED_KEY];
  return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === "string")) : null;
}

export function isShader(v: SocketValue | undefined): boolean {
  return !!v && v.kind === "skia_shader";
}

// A constant data value as a shader input (tbx.gather.flat@1, no color
// conversion) — what a rewrite feeds an unwired input.
export function flatShader(node: string, value: Bind<number[]>): SkiaShaderValue {
  return { kind: "skia_shader", expr: { k: "call", fn: TBX_GATHER_FLAT.id, node, params: { value }, inputs: {} } };
}

export function withWiring(
  def: NodeDefinition,
  rewrite?: (inputs: ShaderInputs, params: Record<string, unknown>, nodeId: string) => ShaderInputs
): NodeDefinition {
  const base = def.compute;
  return {
    ...def,
    compute(args) {
      const wired = def.inputs.filter((i) => isShader(args.inputs[i.name])).map((i) => i.name);
      const inputs = rewrite ? rewrite(args.inputs, args.params, args.nodeId) : args.inputs;
      return base({ ...args, inputs, params: { ...args.params, [WIRED_KEY]: wired } });
    },
  };
}
