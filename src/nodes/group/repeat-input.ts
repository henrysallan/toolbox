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

export const repeatInputNode: NodeDefinition = {
  type: "repeat-input",
  name: "Repeat Input",
  hidden: true,
  category: "utility",
  description:
    "The Repeat zone's source of per-pass values: index (0…count−1), t (0…1), and a seeded random. Passthrough sockets are the loop state — wire an initial spline (or points) in from outside; after the first pass, matching collect sockets on Repeat Output feed back into the same names. Count is how many generations run.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
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
      max: 16,
      softMax: 8,
      step: 1,
      default: 4,
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
    const real = readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: s.type as SocketType,
    }));
    return [...real, { name: VIRTUAL_SOCKET, type: "image" as SocketType }];
  },
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
