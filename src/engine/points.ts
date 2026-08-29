// Helpers for the typed-array PointsValue shape. See specdocs/typed-
// array-points-refactor.md for the migration plan.
//
// Authoritative storage is typed arrays (positions/scales/rotations/
// groupIndices). The `points: Point[]` field on PointsValue is a lazy
// compatibility view — call `ensurePointArray()` before iterating it
// in code that hasn't been migrated to read typed arrays directly.

import type { Point, PointAttribute, PointsValue } from "./types";

// Sentinel cached on PointsValue to memoize ensurePointArray() output.
// We use a WeakMap keyed by the value so we can attach internal state
// without polluting the public type. The key is the PointsValue itself
// (which is unique per producer eval), the value is the count we last
// built `points` for.
const builtFor = new WeakMap<PointsValue, number>();

export const EMPTY_POINTS: PointsValue = Object.freeze({
  kind: "points",
  count: 0,
  positions: new Float32Array(0),
  points: [],
}) as PointsValue;

// Channel names that would shadow the built-in point schema in UIs and
// by-name lookups (the spreadsheet's fixed columns). Attribute writers
// (Set Named Attribute, Point Expression's setattr) refuse them.
export const RESERVED_POINT_ATTR_NAMES: ReadonlySet<string> = new Set([
  "position",
  "x",
  "y",
  "index",
  "rotation",
  "scale",
  "group",
  "z",
  "nx",
  "ny",
  "nz",
]);

// Well-known named channel stamped by time-integrating point sims
// (Accumulator points mode, Advect Points accumulate mode): seconds since
// the point joined that node's state. Not reserved — Set Named Attribute
// can still write it — but those sims own the name on their output and
// overwrite any incoming `age`.
export const POINT_AGE_ATTR = "age";

// Spreadsheet keys for the built-in columns, plus the aliases a by-name
// reader accepts (`scale` → scale.x, `position` → x). Writers still refuse
// the reserved set above; consumers (Map Attribute) can read any of these.
const BUILTIN_POINT_ATTR_ALIASES: ReadonlySet<string> = new Set([
  "index",
  "x",
  "y",
  "z",
  "position",
  "position.x",
  "position.y",
  "position x",
  "position y",
  "rotation",
  "scale",
  "scale.x",
  "scale.y",
  "scale x",
  "scale y",
  "sx",
  "sy",
  "group",
  "nx",
  "ny",
  "nz",
]);

const ATTR_AXIS = ["x", "y", "z", "w"] as const;

export function isBuiltinPointAttrName(name: string): boolean {
  return BUILTIN_POINT_ATTR_ALIASES.has(name.trim());
}

// Built-in columns a picker should offer for this value. Always-readable
// fallbacks (scale 1, rotation/group 0) are listed even when the typed
// array is absent; z / normals only when the value actually carries them.
export function builtinPointAttrNames(p: PointsValue): string[] {
  const names: string[] = [
    "index",
    "x",
    "y",
    "scale.x",
    "scale.y",
    "rotation",
    "group",
  ];
  if (p.z) names.push("z");
  if (p.normals) names.push("nx", "ny", "nz");
  return names;
}

// 2D fallback when the upstream hasn't evaluated yet — the columns every
// points value can answer. Map Attribute offers these while unwired.
export const BUILTIN_POINT_ATTR_SUGGESTIONS_2D: readonly string[] = [
  "index",
  "x",
  "y",
  "scale.x",
  "scale.y",
  "rotation",
  "group",
];

// Allocate a points value with reserved capacity. Caller fills the
// returned typed arrays in place. `points` starts empty (lazy).
// `withZ` mints a 3D value (world-space — rides `points3d` sockets, see
// the PointsValue comment in types.ts); `withNormals` implies 3D use.
export function makePoints(
  count: number,
  opts: {
    withScales?: boolean;
    withRotations?: boolean;
    withGroupIndices?: boolean;
    withZ?: boolean;
    withNormals?: boolean;
  } = {}
): PointsValue {
  return {
    kind: "points",
    count,
    positions: new Float32Array(count * 2),
    scales: opts.withScales ? new Float32Array(count * 2) : undefined,
    rotations: opts.withRotations ? new Float32Array(count) : undefined,
    groupIndices: opts.withGroupIndices ? new Int32Array(count) : undefined,
    z: opts.withZ || opts.withNormals ? new Float32Array(count) : undefined,
    normals: opts.withNormals ? new Float32Array(count * 3) : undefined,
    points: [],
  };
}

// The 2D/3D discriminator: presence of the z array ⇔ the value is
// world-space 3D data and belongs on a `points3d` socket. Cheap enough
// to call anywhere.
export function is3DPoints(p: PointsValue): boolean {
  return p.z !== undefined;
}

// Convert a legacy `Point[]` into the typed-array shape. Use this in
// any producer that hasn't been ported yet to write the typed shape
// directly — one-line drop-in.
export function pointsFromArray(pts: Point[]): PointsValue {
  const count = pts.length;
  if (count === 0) {
    return {
      kind: "points",
      count: 0,
      positions: new Float32Array(0),
      points: [],
    };
  }
  const positions = new Float32Array(count * 2);
  let hasScale = false;
  let hasRot = false;
  let hasGroup = false;
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    positions[i * 2] = p.pos[0];
    positions[i * 2 + 1] = p.pos[1];
    if (p.scale !== undefined) hasScale = true;
    if (p.rotation !== undefined) hasRot = true;
    if (p.groupIndex !== undefined) hasGroup = true;
  }
  let scales: Float32Array | undefined;
  let rotations: Float32Array | undefined;
  let groupIndices: Int32Array | undefined;
  if (hasScale) {
    scales = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const s = pts[i].scale;
      scales[i * 2] = s ? s[0] : 1;
      scales[i * 2 + 1] = s ? s[1] : 1;
    }
  }
  if (hasRot) {
    rotations = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      rotations[i] = pts[i].rotation ?? 0;
    }
  }
  if (hasGroup) {
    groupIndices = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      groupIndices[i] = pts[i].groupIndex ?? 0;
    }
  }
  return {
    kind: "points",
    count,
    positions,
    scales,
    rotations,
    groupIndices,
    // Reuse the input array as the lazy view — the source-of-truth has
    // already been copied into typed arrays so subsequent edits to
    // `points` would be incorrect; in practice producers hand off and
    // forget. If a caller wants to keep mutating its array, it should
    // pass a copy.
    points: pts,
  };
}

// Build (and memoize) the legacy `Point[]` view from the typed arrays.
// Idempotent and cheap on re-call. Call this in any UI/inspector path
// that iterates `value.points` directly.
export function ensurePointArray(p: PointsValue): Point[] {
  // 2D-ONLY view: Point.pos is [x, y], so building it from a 3D value
  // silently drops z/normals — the flattening bug the 081026 spec's
  // split-wire design exists to prevent. 3D code reads typed arrays
  // directly; a call landing here means a shared code path needs a port.
  if (process.env.NODE_ENV !== "production" && p.z !== undefined) {
    console.warn(
      "ensurePointArray() called on a 3D points value — z/normals are " +
        "dropped by the legacy Point[] view. Read the typed arrays instead."
    );
  }
  // Empty value: the view is already `[]`. Return it WITHOUT the
  // `p.points = out` rebuild below — that assignment would throw on the
  // frozen shared `EMPTY_POINTS` sentinel (emitted by e.g. an empty
  // simulation zone). Behaviour-identical to the rebuild for count 0.
  if (p.count === 0) return p.points;
  if (builtFor.get(p) === p.count && p.points.length === p.count) {
    return p.points;
  }
  const { count, positions, scales, rotations, groupIndices } = p;
  const out: Point[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const pt: Point = {
      pos: [positions[i * 2], positions[i * 2 + 1]],
    };
    if (scales) pt.scale = [scales[i * 2], scales[i * 2 + 1]];
    if (rotations) pt.rotation = rotations[i];
    if (groupIndices) pt.groupIndex = groupIndices[i];
    out[i] = pt;
  }
  // Mutating the field is fine — `points` is a view, not a separate
  // identity. Future calls hit the memo.
  p.points = out;
  builtFor.set(p, count);
  return out;
}

// Spread-and-replace copy — the per-point-transform primitive
// (081326_point-attributes.md M0). New value object; the named arrays are
// replaced, EVERYTHING else is shared by reference (the InstancesValue
// convention: "copy the value, replace the arrays you change, share the
// rest"). An explicit `undefined` replacement drops that channel. The lazy
// `points` view resets — it's memoized per value object. A transform built
// on this can never silently strand z/normals (or, later, named
// attributes) the way a hand-rolled literal can.
export function copyPointsWith(
  src: PointsValue,
  replacements: Partial<
    Pick<
      PointsValue,
      | "count"
      | "positions"
      | "scales"
      | "rotations"
      | "groupIndices"
      | "z"
      | "normals"
      | "attributes"
    >
  >
): PointsValue {
  return {
    kind: "points",
    count: src.count,
    positions: src.positions,
    scales: src.scales,
    rotations: src.rotations,
    groupIndices: src.groupIndices,
    z: src.z,
    normals: src.normals,
    attributes: src.attributes,
    ...replacements,
    points: [],
  };
}

// Overlay the well-known `age` channel: age[i] = max(0, time − births[i]).
// Births are scene-time join stamps (parallel to the current index order);
// deriving age on emit keeps pause/scrub honest. Empty sets pass through
// unchanged (no empty `age` channel on EMPTY_POINTS).
export function overlayAge(
  pts: PointsValue,
  births: ArrayLike<number>,
  time: number
): PointsValue {
  const n = pts.count;
  if (n === 0) return pts;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.max(0, time - births[i]);
  return copyPointsWith(pts, {
    attributes: {
      ...pts.attributes,
      [POINT_AGE_ATTR]: { arity: 1, data },
    },
  });
}

// Gather a named-channel map through an index map — the attributes half
// of gatherPoints, exported for consumers whose geometry doesn't come
// from a plain gather (Copy to Points' instance product carries the
// TARGET's channels through its own expansion map).
export function gatherAttributes(
  attrs: Record<string, PointAttribute> | undefined,
  map: Int32Array | number[],
  count: number
): Record<string, PointAttribute> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, PointAttribute> = {};
  for (const name of Object.keys(attrs)) {
    const a = attrs[name];
    const k = a.arity;
    const data = new Float32Array(count * k);
    for (let w = 0; w < count; w++) {
      const i = map[w];
      for (let c = 0; c < k; c++) data[w * k + c] = a.data[i * k + c];
    }
    out[name] = { arity: a.arity, color: a.color, data };
  }
  return out;
}

// Subset/reorder gather — the index-map primitive (081326_point-attributes.md
// M0). Row w of the result is row map[w] of the source, for positions and
// every present optional array uniformly (filter-points' canonical pattern,
// hoisted). `count` defaults to the whole map; pass it to use a prefix of a
// pre-sized map (the compaction idiom).
export function gatherPoints(
  src: PointsValue,
  map: Int32Array | number[],
  count: number = map.length
): PointsValue {
  const positions = new Float32Array(count * 2);
  const scales = src.scales ? new Float32Array(count * 2) : undefined;
  const rotations = src.rotations ? new Float32Array(count) : undefined;
  const groupIndices = src.groupIndices ? new Int32Array(count) : undefined;
  const z = src.z ? new Float32Array(count) : undefined;
  const normals = src.normals ? new Float32Array(count * 3) : undefined;
  for (let w = 0; w < count; w++) {
    const i = map[w];
    positions[w * 2] = src.positions[i * 2];
    positions[w * 2 + 1] = src.positions[i * 2 + 1];
    if (scales) {
      scales[w * 2] = src.scales![i * 2];
      scales[w * 2 + 1] = src.scales![i * 2 + 1];
    }
    if (rotations) rotations[w] = src.rotations![i];
    if (groupIndices) groupIndices[w] = src.groupIndices![i];
    if (z) z[w] = src.z![i];
    if (normals) {
      normals[w * 3] = src.normals![i * 3];
      normals[w * 3 + 1] = src.normals![i * 3 + 1];
      normals[w * 3 + 2] = src.normals![i * 3 + 2];
    }
  }
  return {
    kind: "points",
    count,
    positions,
    scales,
    rotations,
    groupIndices,
    z,
    normals,
    attributes: gatherAttributes(src.attributes, map, count),
    points: [],
  };
}

// Concatenate point sets — the combiner primitive. Channel presence
// unions across sources: a channel any source carries exists on the
// output, with rows from channel-less sources filled with the channel's
// default (scale 1, everything else 0). Named attributes union by name;
// the first-seen arity wins and a later same-name-different-arity source
// zero-fills (an honest conflict answer that never mixes strides).
// `groupIndexFromSource` overwrites groupIndices with each source's
// ordinal — Collect's identity-tagging convention.
export function concatPoints(
  sources: PointsValue[],
  opts: { groupIndexFromSource?: boolean } = {}
): PointsValue {
  let total = 0;
  for (const s of sources) total += s.count;
  if (total === 0) return EMPTY_POINTS;
  const hasScales = sources.some((s) => s.scales);
  const hasRots = sources.some((s) => s.rotations);
  const hasGroups =
    opts.groupIndexFromSource || sources.some((s) => s.groupIndices);
  const hasZ = sources.some((s) => s.z);
  const hasNormals = sources.some((s) => s.normals);
  const positions = new Float32Array(total * 2);
  const scales = hasScales ? new Float32Array(total * 2) : undefined;
  const rotations = hasRots ? new Float32Array(total) : undefined;
  const groupIndices = hasGroups ? new Int32Array(total) : undefined;
  const z = hasZ ? new Float32Array(total) : undefined;
  const normals = hasNormals ? new Float32Array(total * 3) : undefined;
  let attributes: Record<string, PointAttribute> | undefined;
  for (const s of sources) {
    if (!s.attributes) continue;
    attributes ??= {};
    for (const name of Object.keys(s.attributes)) {
      attributes[name] ??= {
        arity: s.attributes[name].arity,
        color: s.attributes[name].color,
        data: new Float32Array(total * s.attributes[name].arity),
      };
    }
  }
  let base = 0;
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const c = s.count;
    positions.set(s.positions.subarray(0, c * 2), base * 2);
    if (scales) {
      if (s.scales) scales.set(s.scales.subarray(0, c * 2), base * 2);
      else scales.fill(1, base * 2, (base + c) * 2);
    }
    if (rotations && s.rotations) {
      rotations.set(s.rotations.subarray(0, c), base);
    }
    if (groupIndices) {
      if (opts.groupIndexFromSource) {
        groupIndices.fill(si, base, base + c);
      } else if (s.groupIndices) {
        groupIndices.set(s.groupIndices.subarray(0, c), base);
      }
    }
    if (z && s.z) z.set(s.z.subarray(0, c), base);
    if (normals && s.normals) {
      normals.set(s.normals.subarray(0, c * 3), base * 3);
    }
    if (attributes) {
      for (const name of Object.keys(attributes)) {
        const dst = attributes[name];
        const srcA = s.attributes?.[name];
        if (srcA && srcA.arity === dst.arity) {
          dst.data.set(
            srcA.data.subarray(0, c * dst.arity),
            base * dst.arity
          );
        }
      }
    }
    base += c;
  }
  return {
    kind: "points",
    count: total,
    positions,
    scales,
    rotations,
    groupIndices,
    z,
    normals,
    attributes,
    points: [],
  };
}

// Deep copy a points value (typed arrays are cloned). Use when you
// need a value you'll mutate without disturbing the upstream cache.
export function clonePoints(p: PointsValue): PointsValue {
  let attributes: Record<string, PointAttribute> | undefined;
  if (p.attributes) {
    attributes = {};
    for (const name of Object.keys(p.attributes)) {
      const a = p.attributes[name];
      attributes[name] = {
        arity: a.arity,
        color: a.color,
        data: new Float32Array(a.data),
      };
    }
  }
  return {
    kind: "points",
    count: p.count,
    positions: new Float32Array(p.positions),
    scales: p.scales ? new Float32Array(p.scales) : undefined,
    rotations: p.rotations ? new Float32Array(p.rotations) : undefined,
    groupIndices: p.groupIndices ? new Int32Array(p.groupIndices) : undefined,
    z: p.z ? new Float32Array(p.z) : undefined,
    normals: p.normals ? new Float32Array(p.normals) : undefined,
    attributes,
    points: [],
  };
}

// Read helpers for typed-array consumers. Kept tiny and inlinable.
export function getPos(
  p: PointsValue,
  i: number,
  out: [number, number]
): [number, number] {
  out[0] = p.positions[i * 2];
  out[1] = p.positions[i * 2 + 1];
  return out;
}

export function getScaleX(p: PointsValue, i: number): number {
  return p.scales ? p.scales[i * 2] : 1;
}
export function getScaleY(p: PointsValue, i: number): number {
  return p.scales ? p.scales[i * 2 + 1] : 1;
}
export function getRotation(p: PointsValue, i: number): number {
  return p.rotations ? p.rotations[i] : 0;
}
export function getGroupIndex(p: PointsValue, i: number): number {
  return p.groupIndices ? p.groupIndices[i] : 0;
}

// By-name read of a built-in column or named channel (component 0, or a
// dotted axis like `color.y`). Missing named channels return undefined;
// absent optional built-ins (no scales array, no z) return the same
// defaults the render path uses. Empty name → undefined.
export function readPointAttr(
  p: PointsValue,
  name: string,
  i: number
): number | undefined {
  const n = name.trim();
  if (!n) return undefined;
  switch (n) {
    case "index":
      return i;
    case "x":
    case "position":
    case "position.x":
    case "position x":
      return p.positions[i * 2];
    case "y":
    case "position.y":
    case "position y":
      return p.positions[i * 2 + 1];
    case "z":
      return p.z ? p.z[i] : 0;
    case "rotation":
      return getRotation(p, i);
    case "scale":
    case "scale.x":
    case "scale x":
    case "sx":
      return getScaleX(p, i);
    case "scale.y":
    case "scale y":
    case "sy":
      return getScaleY(p, i);
    case "group":
      return getGroupIndex(p, i);
    case "nx":
      return p.normals ? p.normals[i * 3] : 0;
    case "ny":
      return p.normals ? p.normals[i * 3 + 1] : 0;
    case "nz":
      return p.normals ? p.normals[i * 3 + 2] : 0;
  }
  const attr = p.attributes?.[n];
  if (attr) return attr.data[i * attr.arity];
  const dot = n.lastIndexOf(".");
  if (dot > 0) {
    const a = p.attributes?.[n.slice(0, dot)];
    const c = ATTR_AXIS.indexOf(n.slice(dot + 1) as (typeof ATTR_AXIS)[number]);
    if (a && c >= 0 && c < a.arity) return a.data[i * a.arity + c];
  }
  return undefined;
}

// True when `name` is a built-in (always readable) or a named channel
// actually present on this value (including `name.x` component access).
export function pointAttrExists(p: PointsValue, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (isBuiltinPointAttrName(n)) return true;
  if (p.attributes?.[n]) return true;
  const dot = n.lastIndexOf(".");
  if (dot > 0) {
    const a = p.attributes?.[n.slice(0, dot)];
    const c = ATTR_AXIS.indexOf(n.slice(dot + 1) as (typeof ATTR_AXIS)[number]);
    if (a && c >= 0 && c < a.arity) return true;
  }
  return false;
}
