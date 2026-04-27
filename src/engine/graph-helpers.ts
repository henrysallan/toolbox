// Engine-side graph helpers. Lives here (rather than in src/state/graph.ts)
// so the engine subtree is fully self-contained — the export bundle copies
// `src/engine/` and friends without dragging in editor state.
//
// `src/state/graph.ts` re-exports these for back-compat with editor imports.

import type { ParamType, SocketType } from "./types";

// Parse a React-Flow target handle ID. Regular input sockets are `in:<name>`;
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
// color_ramp, curves, merge_layers, file, enum, ...).
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
