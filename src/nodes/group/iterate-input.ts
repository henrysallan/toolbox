import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  SocketType,
  SocketValue,
} from "@/engine/types";
import {
  VIRTUAL_SOCKET,
  readBoundarySockets,
  readReservedSockets,
} from "@/engine/groups";

// Iteration Input — the parameter/source half of an Iterate zone
// (071926_iterate-zone-view.md rev 3). Carries the loop params (count /
// seed / the random range) and, during the shell's nested evaluation,
// emits the per-iteration values on its aux outputs:
//
//   index   0 … count−1
//   random  seeded per-iteration hash mapped into [random_min,
//           random_max] (the range the user asked for — wire it into an
//           exposed param and each iteration lands somewhere in it)
//   t       index / (count−1) — 0…1 across the loop
//
// Passthrough sockets mint alongside the reserved three: the exterior
// face (this node's `in:` side) takes wires from outside the zone;
// flatten reroutes those onto the shell's hidden `zi__` inputs so the
// values are evaluated outer-side, and this compute re-emits them per
// iteration from ctx.iteration.values.
//
// The node is a zone member (parentId = the shell), so it only ever
// computes inside the nested evaluation; outside one (ctx.iteration
// unset) it's inert. Its params are read RAW by the shell out of the
// interior stash — keyframes/wires on count/seed don't apply (yet).
//
// ownsTextures:false is load-bearing — passthrough values include
// borrowed exterior textures, which the private cache must never
// release on eviction.

export const iterateInputNode: NodeDefinition = {
  type: "iterate-input",
  name: "Iteration Input",
  hidden: true,
  category: "utility",
  description:
    "The Iterate zone's source of per-iteration values: index (0…count−1), t (0…1 across the loop), and a seeded random mapped into the min/max range below. Wire them into any member node's exposed params to vary each iteration. Iteration count and seed live here too. Passthrough sockets bring exterior values into the loop.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    // Exterior face: one input per minted passthrough socket, plus the
    // trailing virtual port that mints a new one when wired.
    const reserved = new Set(readReservedSockets(params));
    const out: InputSocketDef[] = readBoundarySockets(params)
      .filter((s) => !reserved.has(s.name))
      .map((s) => ({
        name: s.name,
        type: s.type as SocketType,
        required: false,
      }));
    out.push({
      name: VIRTUAL_SOCKET,
      type: "image" as SocketType,
      required: false,
    });
    return out;
  },
  params: [
    {
      name: "count",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 16,
      step: 1,
      default: 6,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
    },
    {
      name: "random_min",
      label: "Random min",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "random_max",
      label: "Random max",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    // Interior face: the reserved iteration values + every minted
    // passthrough, plus the virtual port (wiring it into a member mints
    // a passthrough from the inside).
    const real = readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: s.type as SocketType,
    }));
    return [...real, { name: VIRTUAL_SOCKET, type: "image" as SocketType }];
  },
  // The private interior cache keys iterations apart through this: the
  // node runs K times per shell compute (index) and again on the next
  // shell compute (runId — passthrough values can change with no index
  // change).
  fingerprintExtras(_params, ctx) {
    const it = ctx.iteration;
    return it ? `it:${it.runId}:${it.index}` : "";
  },
  compute({ params, ctx }) {
    const it = ctx.iteration;
    if (!it) return {};
    const aux: Record<string, SocketValue> = {};
    for (const s of readBoundarySockets(params)) {
      if (s.name === "index") {
        aux[s.name] = { kind: "scalar", value: it.index };
      } else if (s.name === "t") {
        aux[s.name] = { kind: "scalar", value: it.t };
      } else if (s.name === "random") {
        aux[s.name] = { kind: "scalar", value: it.random };
      } else {
        const v = it.values[s.name];
        if (v) aux[s.name] = v;
      }
    }
    return { aux, ownsTextures: false };
  },
};
