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

export const foreachInputNode: NodeDefinition = {
  type: "foreach-input",
  name: "For Each Input",
  hidden: true,
  category: "utility",
  description:
    "The For Each Element zone's per-element values: element (the current subpath or point), index, count, t (0…1 across the list), and a seeded random. Wire Geometry on the For Each Output node — this node only emits the slice. Seed and the random range live here; max elements caps the loop.",
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
      name: "domain",
      label: "Domain",
      type: "enum",
      options: ["subpaths", "points"],
      control: "segmented",
      default: "subpaths",
    },
    {
      name: "max_elements",
      label: "Max elements",
      type: "scalar",
      min: 1,
      max: 1024,
      softMax: 256,
      step: 1,
      default: 256,
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
    const elementType: SocketType =
      (params.domain as string) === "points" ? "points" : "spline";
    const real = readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: (s.name === "element" ? elementType : s.type) as SocketType,
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
      } else if (s.name === "count") {
        aux[s.name] = { kind: "scalar", value: it.count };
      } else {
        const v = it.values[s.name];
        if (v) aux[s.name] = v;
      }
    }
    return { aux, ownsTextures: false };
  },
};
