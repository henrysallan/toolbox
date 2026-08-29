// Upstream attribute-name lookup — ONE implementation serving both
// surfaces that render an attribute-name field (the ParamPanel row and
// EffectNode's on-node input), so suggestions and the invalid-name tint
// can never disagree (081326_point-attributes.md M3).
//
// EffectsApp registers the reader (a closure over its edges + eval-cache
// read); consumers call readUpstreamAttrNames during render. Reading a
// module singleton in render is the paneCameraStash/peek pattern: the
// answer refreshes whenever the consumer re-renders (param edits,
// selection), which can lag one eval behind a purely-upstream change —
// same freshness contract as the suggestions themselves.

import type { SocketValue } from "@/engine/types";
import {
  BUILTIN_POINT_ATTR_SUGGESTIONS_2D,
  builtinPointAttrNames,
  isBuiltinPointAttrName,
  RESERVED_POINT_ATTR_NAMES,
} from "@/engine/points";

export interface AttrNameInfo {
  // True when the socket's wired upstream produced an evaluated points/
  // spline value — i.e. `names` is authoritative, and a name that isn't
  // in it genuinely doesn't exist. False = unwired or not evaluated:
  // nothing can be verified, so nothing gets flagged.
  known: boolean;
  names: string[];
  // Built-in point columns present/readable on the upstream value
  // (index, x, y, …). Empty for splines and unknown reads. Merged into
  // the picker only when the param sets `suggestAttrsIncludeBuiltins`.
  builtins: string[];
}

const UNKNOWN: AttrNameInfo = { known: false, names: [], builtins: [] };

let reader:
  | ((nodeId: string, socketName: string) => AttrNameInfo)
  | null = null;

export function registerAttrNameReader(
  fn: (nodeId: string, socketName: string) => AttrNameInfo
): void {
  reader = fn;
}

export function readUpstreamAttrNames(
  nodeId: string,
  socketName: string
): AttrNameInfo {
  return reader?.(nodeId, socketName) ?? UNKNOWN;
}

// Channel names carried by an evaluated points/spline value. Spline
// names union both domains (anchor + subpath). Built-in point columns
// are NOT in this list — see `builtinsFromValue`.
export function attrNamesFromValue(v: SocketValue | undefined): string[] {
  if (!v) return [];
  if (v.kind === "points") {
    return v.attributes ? Object.keys(v.attributes) : [];
  }
  if (v.kind === "spline") {
    const names = new Set<string>();
    for (const sub of v.subpaths) {
      if (sub.attrs) for (const k of Object.keys(sub.attrs)) names.add(k);
      for (const a of sub.anchors) {
        if (a.attrs) for (const k of Object.keys(a.attrs)) names.add(k);
      }
    }
    return [...names];
  }
  return [];
}

export function builtinsFromValue(v: SocketValue | undefined): string[] {
  if (!v || v.kind !== "points") return [];
  return builtinPointAttrNames(v);
}

// Picker contents for a `suggestAttrsFrom` field. Built-ins first (stable
// schema), then named channels. Unwired Map Attribute still offers the
// 2D built-in set so the name is pickable before a wire lands.
export function attrNameSuggestions(
  info: AttrNameInfo,
  includeBuiltins: boolean
): string[] {
  const builtins = includeBuiltins
    ? info.builtins.length > 0
      ? info.builtins
      : [...BUILTIN_POINT_ATTR_SUGGESTIONS_2D]
    : [];
  if (builtins.length === 0 && info.names.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...builtins, ...info.names]) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// The one invalid-name rule, shared by both surfaces. Empty is never
// flagged — it reads as "not set yet", and the placeholder does the talking.
// Writers (`require` false): a reserved name is always wrong (and it can
// never be a channel). Consumers (`require` true): a verified-missing name
// is wrong, unless `includeBuiltins` and the name is a readable built-in
// (index / x / y / …) or a component of a present named channel (`color.y`).
export function isAttrNameInvalid(
  name: string,
  info: AttrNameInfo,
  require: boolean,
  includeBuiltins = false
): boolean {
  const n = name.trim();
  if (!n) return false;
  if (includeBuiltins) {
    if (isBuiltinPointAttrName(n)) return false;
    if (!info.known) return false;
    if (info.names.includes(n)) return false;
    const dot = n.lastIndexOf(".");
    if (dot > 0 && info.names.includes(n.slice(0, dot))) return false;
    return require;
  }
  if (RESERVED_POINT_ATTR_NAMES.has(n)) return true;
  return require && info.known && !info.names.includes(n);
}
