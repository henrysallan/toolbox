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
import { RESERVED_POINT_ATTR_NAMES } from "@/engine/points";

export interface AttrNameInfo {
  // True when the socket's wired upstream produced an evaluated points/
  // spline value — i.e. `names` is authoritative, and a name that isn't
  // in it genuinely doesn't exist. False = unwired or not evaluated:
  // nothing can be verified, so nothing gets flagged.
  known: boolean;
  names: string[];
}

const UNKNOWN: AttrNameInfo = { known: false, names: [] };

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
// names union both domains (anchor + subpath).
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

// The one invalid-name rule, shared by both surfaces: a reserved name is
// always wrong (writers refuse it, and it can never be a channel), and a
// consumer's name (`require`) is wrong when the upstream is KNOWN and
// doesn't carry it. Empty is never flagged — it reads as "not set yet",
// and the placeholder does the talking.
export function isAttrNameInvalid(
  name: string,
  info: AttrNameInfo,
  require: boolean
): boolean {
  const n = name.trim();
  if (!n) return false;
  if (RESERVED_POINT_ATTR_NAMES.has(n)) return true;
  return require && info.known && !info.names.includes(n);
}
