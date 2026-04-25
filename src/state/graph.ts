import type { ParamType, SocketType } from "@/engine/types";

export type NodeDataPayload = {
  defType: string;
  params: Record<string, unknown>;
  // Names of params that have been "exposed" — rendered as extra typed input
  // sockets on the node. When an exposed param has an incoming edge, the
  // edge's value overrides the stored param value at evaluation time.
  exposedParams?: string[];
  // User-defined slider range overrides keyed by param name. Each entry
  // can override `min`, `max`, and/or `softMax` from the param def.
  // Set via the right-click "Edit range" popover on a scalar slider;
  // saved with the project so the customization survives reload. The
  // engine doesn't read these — they're purely for the param-panel UI.
  paramOverrides?: Record<
    string,
    { min?: number; max?: number; softMax?: number }
  >;
  error?: string;
  auxOutputs: { name: string; type: string; disabled?: boolean }[];
  inputs: { name: string; label?: string; type: string }[];
  primaryOutput: string | null;
  name: string;
  terminal?: boolean;
  active?: boolean;
  bypassed?: boolean;
  [key: string]: unknown;
};

export function makeSourceHandleId(kind: "primary" | "aux", name?: string) {
  return kind === "primary" ? "out:primary" : `out:aux:${name}`;
}

export function makeTargetHandleId(name: string) {
  return `in:${name}`;
}

export function makeParamTargetHandleId(paramName: string) {
  return `in:param:${paramName}`;
}

// Parse a React Flow target handle ID. Regular input sockets are `in:<name>`;
// exposed param sockets are `in:param:<name>`. Returns null for unrecognized.
export function parseTargetHandleKind(
  handle: string
): { kind: "input"; name: string } | { kind: "param"; name: string } | null {
  if (handle.startsWith("in:param:")) {
    return { kind: "param", name: handle.slice("in:param:".length) };
  }
  if (handle.startsWith("in:")) {
    return { kind: "input", name: handle.slice("in:".length) };
  }
  return null;
}

// Map a ParamType to the socket type that drives it. Returns null for param
// types that don't have a meaningful data-socket representation (paint,
// color_ramp, curves, merge_layers, file, enum).
export function paramSocketType(type: ParamType): SocketType | null {
  switch (type) {
    case "scalar":
    case "boolean":
      return "scalar";
    case "vec2":
      return "vec2";
    case "vec3":
      return "vec3";
    case "color":
    case "vec4":
      return "vec4";
    default:
      return null;
  }
}

export function newNodeId(type: string) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}`;
}
