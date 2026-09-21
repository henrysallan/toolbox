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

// Well-known named channel stamped by time-integrating point sims
// (Accumulator points / spline mode, Advect Points accumulate mode): seconds since
// the point joined that node's state. Any writer can still set it, but
// those sims own the name on their output and overwrite any incoming `age`.
export const POINT_AGE_ATTR = "age";

// ---------------------------------------------------------------------------
// Attribute schema (092026_unified-attributes.md §4.1)
//
// Every per-point value is an attribute addressed by name. The BUILT-INS
// below are the ones the renderer consumes on its own; they live in the
// packed typed arrays and this table says how a by-name read or write
// routes to them (storage, arity, default, coercion). Anything not in the
// table is a NAMED CHANNEL in `PointsValue.attributes`. There is no
// reserved-name list any more: `withPointAttr(p, "scale", …)` is how a
// generic writer lands a scale the renderer honors, exactly as
// `readPointAttr(p, "scale", i)` has always read one.
// ---------------------------------------------------------------------------

export type BuiltinPointAttrName =
  | "index"
  | "position"
  | "scale"
  | "rotation"
  | "group"
  | "z"
  | "normal";

export interface PointAttrSchema {
  name: BuiltinPointAttrName;
  // Per-lane short names a picker offers and a reader / writer accepts
  // (`x` → position lane 0, `sx` → scale lane 0, `nx` → normal lane 0).
  // Arity-1 schemas list just their own name. The generic `<name>.<axis>`
  // and `<name> <axis>` lane forms resolve for every vector schema too.
  laneNames: readonly string[];
  arity: 1 | 2 | 3;
  // Per-lane value an absent optional array reads as, and the value a
  // non-finite write falls back to. Position is required (never absent).
  default: readonly number[];
  kind: "float" | "int"; // int rounds on write (group is an identity tag)
  unit: "canvas01" | "radians" | "multiplier" | "unitless" | "world";
  storage:
    | "positions"
    | "scales"
    | "rotations"
    | "groupIndices"
    | "z"
    | "normals"
    | "derived";
  // index is the row number; z / normals would retag a 2D value as 3D,
  // which is a socket-type change and belongs to an explicit node.
  writable: boolean;
  required: boolean;
  // An arity-1 write fills every lane (uniform scale). Off, a scalar write
  // lands in lane 0 and keeps the rest.
  broadcastScalar: boolean;
}

export const POINT_ATTR_SCHEMA: readonly PointAttrSchema[] = [
  {
    name: "index",
    laneNames: ["index"],
    arity: 1,
    default: [0],
    kind: "int",
    unit: "unitless",
    storage: "derived",
    writable: false,
    required: true,
    broadcastScalar: false,
  },
  {
    name: "position",
    laneNames: ["x", "y"],
    arity: 2,
    default: [0, 0],
    kind: "float",
    unit: "canvas01",
    storage: "positions",
    writable: true,
    required: true,
    broadcastScalar: false,
  },
  {
    name: "scale",
    laneNames: ["scale.x", "scale.y"],
    arity: 2,
    default: [1, 1],
    kind: "float",
    unit: "multiplier",
    storage: "scales",
    writable: true,
    required: false,
    broadcastScalar: true,
  },
  {
    name: "rotation",
    laneNames: ["rotation"],
    arity: 1,
    default: [0],
    kind: "float",
    unit: "radians",
    storage: "rotations",
    writable: true,
    required: false,
    broadcastScalar: false,
  },
  {
    name: "group",
    laneNames: ["group"],
    arity: 1,
    default: [0],
    kind: "int",
    unit: "unitless",
    storage: "groupIndices",
    writable: true,
    required: false,
    broadcastScalar: false,
  },
  {
    name: "z",
    laneNames: ["z"],
    arity: 1,
    default: [0],
    kind: "float",
    unit: "world",
    storage: "z",
    writable: false,
    required: false,
    broadcastScalar: false,
  },
  {
    name: "normal",
    laneNames: ["nx", "ny", "nz"],
    arity: 3,
    default: [0, 0, 0],
    kind: "float",
    unit: "world",
    storage: "normals",
    writable: false,
    required: false,
    broadcastScalar: false,
  },
];

const ATTR_AXIS = ["x", "y", "z", "w"] as const;

// A built-in name resolved to its schema row and (for a lane form) the
// lane it addresses. `lane` undefined = the whole vector.
export interface ResolvedPointAttr {
  schema: PointAttrSchema;
  lane: number | undefined;
}

const SCHEMA_BY_NAME = new Map<string, PointAttrSchema>(
  POINT_ATTR_SCHEMA.map((s) => [s.name, s])
);

// Extra short lane aliases beyond `laneNames` — the historical spellings
// readers accepted (Attribute Transfer / Map Attribute pickers).
const EXTRA_LANE_ALIASES: Record<string, [BuiltinPointAttrName, number]> = {
  sx: ["scale", 0],
  sy: ["scale", 1],
};

function resolveUncached(n: string): ResolvedPointAttr | null {
  if (!n) return null;
  const direct = SCHEMA_BY_NAME.get(n);
  if (direct) return { schema: direct, lane: undefined };
  for (const s of POINT_ATTR_SCHEMA) {
    if (s.arity === 1) continue;
    const lane = s.laneNames.indexOf(n);
    if (lane >= 0) return { schema: s, lane };
  }
  const extra = EXTRA_LANE_ALIASES[n];
  if (extra) return { schema: SCHEMA_BY_NAME.get(extra[0])!, lane: extra[1] };
  const m = /^([a-z]+)[ .]([xyz])$/.exec(n);
  if (m) {
    const s = SCHEMA_BY_NAME.get(m[1]);
    const lane = ATTR_AXIS.indexOf(m[2] as (typeof ATTR_AXIS)[number]);
    if (s && s.arity > 1 && lane >= 0 && lane < s.arity) {
      return { schema: s, lane };
    }
  }
  return null;
}

// Memoized: readers call this per element (Map Attribute's per-point
// readPointAttr), so the regex path must not run n times. Misses (named
// channels) are cached too, bounded so arbitrary user names can't grow it
// without limit.
const resolveCache = new Map<string, ResolvedPointAttr | null>();
export function resolveBuiltinPointAttr(name: string): ResolvedPointAttr | null {
  const n = name.trim();
  const hit = resolveCache.get(n);
  if (hit !== undefined) return hit;
  const r = resolveUncached(n);
  if (resolveCache.size > 1024) resolveCache.clear();
  resolveCache.set(n, r);
  return r;
}

export function isBuiltinPointAttrName(name: string): boolean {
  return resolveBuiltinPointAttr(name) !== null;
}

// The schema row for a built-in (canonical or lane form); undefined for a
// named channel.
export function pointAttrSchema(name: string): PointAttrSchema | undefined {
  return resolveBuiltinPointAttr(name)?.schema;
}

// Can `withPointAttr` store this name? Every named channel: yes. Built-ins:
// per the schema (index / z / normals: no). Empty: no.
export function isWritablePointAttr(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  const r = resolveBuiltinPointAttr(n);
  return r ? r.schema.writable : true;
}

// Every spelling that resolves to a built-in — the canonical names, the
// lane names, and the `<name>.<axis>` / `<name> <axis>` forms. What
// `attributesFromObjectAttrs` skips when packing object attrs back onto a
// points value, and what node-facts treats as well-known.
export const BUILTIN_POINT_ATTR_NAMES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const s of POINT_ATTR_SCHEMA) {
    out.add(s.name);
    for (const l of s.laneNames) out.add(l);
    if (s.arity > 1) {
      for (let c = 0; c < s.arity; c++) {
        out.add(`${s.name}.${ATTR_AXIS[c]}`);
        out.add(`${s.name} ${ATTR_AXIS[c]}`);
      }
    }
  }
  for (const k of Object.keys(EXTRA_LANE_ALIASES)) out.add(k);
  return out;
})();

// Built-in columns a picker should offer for this value. Always-readable
// fallbacks (scale 1, rotation/group 0) are listed even when the typed
// array is absent; z / normals only when the value actually carries them.
export function builtinPointAttrNames(p: PointsValue): string[] {
  const names: string[] = [];
  for (const s of POINT_ATTR_SCHEMA) {
    if (s.storage === "z" && !p.z) continue;
    if (s.storage === "normals" && !p.normals) continue;
    names.push(...s.laneNames);
  }
  return names;
}

// 2D fallback when the upstream hasn't evaluated yet — the columns every
// points value can answer. Map Attribute offers these while unwired.
export const BUILTIN_POINT_ATTR_SUGGESTIONS_2D: readonly string[] =
  POINT_ATTR_SCHEMA.filter(
    (s) => s.storage !== "z" && s.storage !== "normals"
  ).flatMap((s) => [...s.laneNames]);

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

// One lane of a built-in, with the schema default where the optional
// array is absent (the same defaults the render path uses).
function readBuiltinLane(
  p: PointsValue,
  s: PointAttrSchema,
  lane: number,
  i: number
): number {
  switch (s.storage) {
    case "derived":
      return i;
    case "positions":
      return p.positions[i * 2 + lane];
    case "scales":
      return p.scales ? p.scales[i * 2 + lane] : s.default[lane];
    case "rotations":
      return p.rotations ? p.rotations[i] : s.default[0];
    case "groupIndices":
      return p.groupIndices ? p.groupIndices[i] : s.default[0];
    case "z":
      return p.z ? p.z[i] : s.default[0];
    case "normals":
      return p.normals ? p.normals[i * 3 + lane] : s.default[lane];
  }
}

// `color.y` → the channel `color` and lane 1, when that channel exists
// with enough components. Null for anything else.
function resolveChannelLane(
  p: PointsValue,
  n: string
): { name: string; attr: PointAttribute; lane: number } | null {
  const dot = n.lastIndexOf(".");
  if (dot <= 0) return null;
  const base = n.slice(0, dot);
  const a = p.attributes?.[base];
  const c = ATTR_AXIS.indexOf(n.slice(dot + 1) as (typeof ATTR_AXIS)[number]);
  if (a && c >= 0 && c < a.arity) return { name: base, attr: a, lane: c };
  return null;
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
  const r = resolveBuiltinPointAttr(n);
  if (r) return readBuiltinLane(p, r.schema, r.lane ?? 0, i);
  const attr = p.attributes?.[n];
  if (attr) return attr.data[i * attr.arity];
  const cl = resolveChannelLane(p, n);
  if (cl) return cl.attr.data[i * cl.attr.arity + cl.lane];
  return undefined;
}

// Vec2 companion to readPointAttr. Two-component built-ins (`position`,
// `scale`) return both axes; a named channel returns its first two
// components (arity-1 pads y = 0); a dotted / scalar name returns
// `[value, 0]`. Missing named channels return undefined — same contract
// as the scalar reader.
export function readPointAttrVec2(
  p: PointsValue,
  name: string,
  i: number
): [number, number] | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const r = resolveBuiltinPointAttr(n);
  if (r && r.lane === undefined && r.schema.arity >= 2) {
    return [
      readBuiltinLane(p, r.schema, 0, i),
      readBuiltinLane(p, r.schema, 1, i),
    ];
  }
  const attr = r ? undefined : p.attributes?.[n];
  if (attr) {
    const base = i * attr.arity;
    return [attr.data[base], attr.arity > 1 ? attr.data[base + 1] : 0];
  }
  const s = readPointAttr(p, n, i);
  if (s === undefined) return undefined;
  return [s, 0];
}

// True when `name` is a built-in (always readable) or a named channel
// actually present on this value (including `name.x` component access).
export function pointAttrExists(p: PointsValue, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (isBuiltinPointAttrName(n)) return true;
  if (p.attributes?.[n]) return true;
  return resolveChannelLane(p, n) !== null;
}

// Components per element the name addresses on this value: a built-in's
// schema arity (1 for a lane form), a named channel's arity (1 for a
// dotted lane). Undefined when the name is nothing on this value.
export function pointAttrArity(p: PointsValue, name: string): number | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const r = resolveBuiltinPointAttr(n);
  if (r) return r.lane === undefined ? r.schema.arity : 1;
  const attr = p.attributes?.[n];
  if (attr) return attr.arity;
  return resolveChannelLane(p, n) ? 1 : undefined;
}

// The whole column as `count × arity` interleaved floats (the
// PointAttribute.data layout) — a built-in packed from its typed array
// (defaults where absent), a named channel's own data (SHARED, do not
// mutate), or a lane of either packed to arity 1. Undefined when the name
// is nothing on this value.
export function readPointAttrColumn(
  p: PointsValue,
  name: string
): { arity: 1 | 2 | 3 | 4; data: Float32Array; color?: boolean } | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const count = p.count;
  const r = resolveBuiltinPointAttr(n);
  if (r) {
    const s = r.schema;
    if (r.lane === undefined && s.storage === "positions") {
      return { arity: 2, data: new Float32Array(p.positions.subarray(0, count * 2)) };
    }
    const k = r.lane === undefined ? s.arity : 1;
    const data = new Float32Array(count * k);
    if (r.lane === undefined) {
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < k; c++) data[i * k + c] = readBuiltinLane(p, s, c, i);
      }
    } else {
      for (let i = 0; i < count; i++) data[i] = readBuiltinLane(p, s, r.lane, i);
    }
    return { arity: k, data };
  }
  const attr = p.attributes?.[n];
  if (attr) return { arity: attr.arity, data: attr.data, color: attr.color };
  const cl = resolveChannelLane(p, n);
  if (cl) {
    const data = new Float32Array(count);
    const k = cl.attr.arity;
    for (let i = 0; i < count; i++) data[i] = cl.attr.data[i * k + cl.lane];
    return { arity: 1, data };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Unified write (092026_unified-attributes.md §4.2)
// ---------------------------------------------------------------------------

export type PointAttrWriteMode = "set" | "multiply" | "add";

export interface WithPointAttrOpts {
  // Components per element in `data`. Default: data.length / count (1 when
  // the value is empty). Pass it when `data` is longer than count × arity.
  arity?: number;
  // `set` replaces; `multiply` / `add` combine with the current value (an
  // absent optional built-in reads as its schema default; a missing named
  // channel reads as the op's identity).
  mode?: PointAttrWriteMode;
  // Named channels only: tag the channel as a color (spreadsheet swatch,
  // Copy to Points tint). Ignored for built-ins.
  color?: boolean;
}

const warnedNotWritable = new Set<string>();
function warnNotWritable(name: string): void {
  if (process.env.NODE_ENV === "production" || warnedNotWritable.has(name)) {
    return;
  }
  warnedNotWritable.add(name);
  console.warn(
    `[points] attribute "${name}" is not writable (index is the row number; ` +
      `z / normals would retag a 2D value as 3D) — write ignored`
  );
}

function combine(cur: number, v: number, mode: PointAttrWriteMode): number {
  return mode === "multiply" ? cur * v : mode === "add" ? cur + v : v;
}

// Store a whole built-in column (k lanes, count × k) back into a copy of
// `p`, routed by storage. z / normals never reach here (not writable).
function storeBuiltinColumn(
  p: PointsValue,
  s: PointAttrSchema,
  col: Float32Array
): PointsValue {
  switch (s.storage) {
    case "positions":
      return copyPointsWith(p, { positions: col });
    case "scales":
      return copyPointsWith(p, { scales: col });
    case "rotations":
      return copyPointsWith(p, { rotations: col });
    case "groupIndices": {
      const groupIndices = new Int32Array(p.count);
      for (let i = 0; i < p.count; i++) groupIndices[i] = col[i];
      return copyPointsWith(p, { groupIndices });
    }
    default:
      return p;
  }
}

function withBuiltinPointAttr(
  p: PointsValue,
  r: ResolvedPointAttr,
  data: Float32Array,
  srcArity: number,
  mode: PointAttrWriteMode
): PointsValue {
  const s = r.schema;
  const n = p.count;
  const k = s.arity;
  // Start from the current column (defaults where the array is absent) so
  // a lane write, a shorter write, or a multiply/add keeps what it doesn't
  // touch.
  const col = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) col[i * k + c] = readBuiltinLane(p, s, c, i);
  }
  // Which lanes this write lands in, and which component of `data` feeds
  // each: a lane name → that lane from component 0; a scalar into a
  // broadcast target → every lane from component 0; otherwise lane c from
  // component c for the leading min(srcArity, k) lanes.
  let lanes: number[];
  let comp: (li: number) => number;
  if (r.lane !== undefined) {
    lanes = [r.lane];
    comp = () => 0;
  } else if (srcArity === 1 && s.broadcastScalar) {
    lanes = Array.from({ length: k }, (_, c) => c);
    comp = () => 0;
  } else {
    const m = Math.min(srcArity, k);
    lanes = Array.from({ length: m }, (_, c) => c);
    comp = (li) => li;
  }
  const isInt = s.kind === "int";
  for (let i = 0; i < n; i++) {
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      const idx = i * k + lane;
      let v = combine(col[idx], data[i * srcArity + comp(li)], mode);
      if (!Number.isFinite(v)) v = s.default[lane];
      if (isInt) v = Math.round(v);
      col[idx] = v;
    }
  }
  return storeBuiltinColumn(p, s, col);
}

function withNamedPointAttr(
  p: PointsValue,
  n: string,
  data: Float32Array,
  srcArity: number,
  mode: PointAttrWriteMode,
  color: boolean | undefined
): PointsValue {
  const count = p.count;
  const existing = p.attributes?.[n];
  // `color.y` with a `color` channel present → one lane of that channel.
  if (!existing) {
    const cl = resolveChannelLane(p, n);
    if (cl) {
      const k = cl.attr.arity;
      const out = new Float32Array(cl.attr.data.subarray(0, count * k));
      for (let i = 0; i < count; i++) {
        const idx = i * k + cl.lane;
        const v = combine(out[idx], data[i * srcArity], mode);
        out[idx] = Number.isFinite(v) ? v : 0;
      }
      return copyPointsWith(p, {
        attributes: {
          ...p.attributes,
          [cl.name]: { ...cl.attr, data: out },
        },
      });
    }
  }
  const k = Math.max(1, Math.min(4, srcArity)) as 1 | 2 | 3 | 4;
  const identity = mode === "multiply" ? 1 : 0;
  const out = new Float32Array(count * k);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < k; c++) {
      let cur = identity;
      if (mode !== "set" && existing && c < existing.arity) {
        cur = existing.data[i * existing.arity + c];
      }
      const v = combine(cur, data[i * srcArity + c], mode);
      out[i * k + c] = Number.isFinite(v) ? v : 0;
    }
  }
  const attr: PointAttribute = { arity: k, data: out };
  const tag = color ?? (mode !== "set" ? existing?.color : undefined);
  if (tag) attr.color = true;
  return copyPointsWith(p, { attributes: { ...p.attributes, [n]: attr } });
}

// Store an attribute by name into a copy of `p` — the write half of
// readPointAttr. `data` is count × arity interleaved (PointAttribute.data
// layout). Built-ins route to their typed array with the schema's
// coercion (scalar → both scale lanes, `group` rounds, non-finite → the
// lane default, a lane name keeps the other lanes); anything else becomes
// / replaces a named channel (non-finite → 0). A non-writable built-in
// (`index`, `z`, `nx`…) returns `p` unchanged and warns once in dev — the
// caller's name field is the user-facing signal. Empty name → `p`. Never
// mutates `p`.
export function withPointAttr(
  p: PointsValue,
  name: string,
  data: Float32Array,
  opts: WithPointAttrOpts = {}
): PointsValue {
  const n = name.trim();
  if (!n) return p;
  const count = p.count;
  const mode = opts.mode ?? "set";
  const srcArity = Math.max(
    1,
    Math.floor(opts.arity ?? (count > 0 ? data.length / count : 1))
  );
  const r = resolveBuiltinPointAttr(n);
  if (r) {
    if (!r.schema.writable) {
      warnNotWritable(n);
      return p;
    }
    if (count === 0) return p;
    return withBuiltinPointAttr(p, r, data, srcArity, mode);
  }
  return withNamedPointAttr(p, n, data, srcArity, mode, opts.color);
}

// Several attributes in one go (Point Expression's setattr results). Each
// entry follows withPointAttr's rules; only the arrays actually written
// are replaced.
export function withPointAttrs(
  p: PointsValue,
  writes: Record<
    string,
    { data: Float32Array; arity?: number; color?: boolean }
  >,
  mode: PointAttrWriteMode = "set"
): PointsValue {
  let out = p;
  for (const name of Object.keys(writes)) {
    const w = writes[name];
    out = withPointAttr(out, name, w.data, {
      arity: w.arity,
      color: w.color,
      mode,
    });
  }
  return out;
}
