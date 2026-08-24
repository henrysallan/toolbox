import type {
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketType,
  SocketValue,
} from "@/engine/types";

// Sample & Hold — latch `value` on each rising edge of `trigger`
// (081726_pointer-interaction.md §3.3). The generalization of "sticky
// click position": latch the cursor on a Pointer click, an audio level
// on a beat, a Random on every press. `type` retypes the value socket
// (scalar / vec2 / vec3 / vec4) — the Switch pattern.
//
// `initial: follow` passes the input through until the first trigger
// (the node is transparent until it has something to hold);
// `initial: zero` rests at 0 until then.

type HoldType = "scalar" | "vec2" | "vec3" | "vec4";
const ARITY: Record<HoldType, number> = { scalar: 1, vec2: 2, vec3: 3, vec4: 4 };

interface HoldState {
  lastTrigger: number;
  latched: number[] | null;
}

function stateKey(nodeId: string): string {
  return `sample-hold:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): HoldState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as HoldState | undefined;
  if (existing) return existing;
  const s: HoldState = { lastTrigger: 0, latched: null };
  ctx.state[key] = s;
  return s;
}

function holdType(params: Record<string, unknown>): HoldType {
  const t = params.type;
  return t === "vec2" || t === "vec3" || t === "vec4" ? t : "scalar";
}

// Wired value → number[] of the socket's arity. The evaluator's coercion
// already widened/broadcast compatible kinds onto the socket type; this
// only unpacks, padding defensively if an unexpected kind slips through.
function readComponents(value: SocketValue | undefined, arity: number): number[] {
  const out = new Array<number>(arity).fill(0);
  if (!value) return out;
  if (value.kind === "scalar") {
    out.fill(value.value);
    return out;
  }
  if (value.kind === "vec2" || value.kind === "vec3" || value.kind === "vec4") {
    for (let i = 0; i < arity; i++) out[i] = value.value[i] ?? 0;
    return out;
  }
  return out;
}

function pack(type: HoldType, c: number[]): SocketValue {
  if (type === "scalar") return { kind: "scalar", value: c[0] ?? 0 };
  if (type === "vec2") return { kind: "vec2", value: [c[0] ?? 0, c[1] ?? 0] };
  if (type === "vec3")
    return { kind: "vec3", value: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0] };
  return {
    kind: "vec4",
    value: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0],
  };
}

export const sampleHoldNode: NodeDefinition = {
  type: "sample-hold",
  name: "Sample & Hold",
  category: "utility",
  subcategory: "modifier",
  description:
    "Latch a value on each rising edge of the trigger and hold it until the next one. Latch the Pointer's position on click, an audio level on a beat, a Random per press. Type retypes the value socket (scalar / vec2 / vec3 / vec4). Follow mode passes the input through until the first trigger; zero rests at 0.",
  backend: "webgl2",
  // Edge + latch state — recompute every eval.
  stable: false,
  retimeable: false,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    return [
      { name: "value", type: holdType(params), required: false },
      { name: "trigger", type: "scalar", required: false },
    ];
  },
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: ["scalar", "vec2", "vec3", "vec4"],
      default: "scalar",
    },
    {
      name: "initial",
      label: "Before first trigger",
      type: "enum",
      options: ["follow", "zero"],
      default: "follow",
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params): SocketType {
    return holdType(params);
  },
  auxOutputs: [],

  // Output only changes when the latch changes (or while following) —
  // fold the latched components so downstream caches bust exactly then.
  // Follow-mode passthrough is covered by the input's own fingerprint.
  fingerprintExtras(_params, ctx, nodeId) {
    const s = nodeId
      ? (ctx.state[stateKey(nodeId)] as HoldState | undefined)
      : undefined;
    if (!s || !s.latched) return "sh:none";
    return `sh:${s.latched.map((v) => v.toFixed(5)).join(",")}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const s = ensureState(ctx, nodeId);
    const type = holdType(params);
    const arity = ARITY[type];

    const trig = inputs.trigger?.kind === "scalar" ? inputs.trigger.value : 0;
    const rising = s.lastTrigger <= 0.5 && trig > 0.5;
    s.lastTrigger = trig;
    if (rising) s.latched = readComponents(inputs.value, arity);

    // A type change mid-session leaves a latch of the wrong arity —
    // re-read it at the new arity (pad/truncate) rather than clearing.
    if (s.latched && s.latched.length !== arity) {
      const fixed = new Array<number>(arity).fill(0);
      for (let i = 0; i < Math.min(arity, s.latched.length); i++)
        fixed[i] = s.latched[i];
      s.latched = fixed;
    }

    if (s.latched) return { primary: pack(type, s.latched) };
    if (params.initial === "zero")
      return { primary: pack(type, new Array<number>(arity).fill(0)) };
    return { primary: pack(type, readComponents(inputs.value, arity)) };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
