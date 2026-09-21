import { isBuiltinPointAttrName } from "./points";
import {
  locateSplineAt,
  locateSubpathAt,
  measureSubpath,
  type SplineLengths,
  type SubpathLengths,
} from "./spline-math";
import type {
  PointAttribute,
  SplineSubpath,
  SplineValue,
} from "./types";

// Points ↔ spline named-channel packing (081326_point-attributes.md).
// Points store SoA `PointsValue.attributes`; spline anchors/subpaths
// store object-attached `attrs`. These helpers are the one conversion
// so Points to Spline, Spline to Points, Rope, Points on Path, and
// Copy to Points all agree on number vs number[] and arity.

export type ObjectAttrs = Record<string, number | number[]>;

function asVec(v: number | number[] | undefined): number[] {
  if (v === undefined) return [];
  return typeof v === "number" ? [v] : v;
}

function storeVec(vec: number[]): number | number[] {
  return vec.length <= 1 ? (vec[0] ?? 0) : vec;
}

export function cloneObjectAttrs(
  src?: ObjectAttrs
): ObjectAttrs | undefined {
  if (!src) return undefined;
  const out: ObjectAttrs = {};
  let any = false;
  for (const k of Object.keys(src)) {
    const v = src[k];
    out[k] = Array.isArray(v) ? v.slice() : v;
    any = true;
  }
  return any ? out : undefined;
}

// Overlay wins on name collision. Empty inputs collapse to undefined.
export function mergeObjectAttrs(
  base?: ObjectAttrs,
  overlay?: ObjectAttrs
): ObjectAttrs | undefined {
  if (!base) return cloneObjectAttrs(overlay);
  if (!overlay) return cloneObjectAttrs(base);
  const out = cloneObjectAttrs(base)!;
  for (const k of Object.keys(overlay)) {
    const v = overlay[k];
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

// One SoA row → object-attached attrs. Arity 1 stores a number; wider
// channels store a number[]. Missing map → undefined.
export function namedAttrsAt(
  attrs: Record<string, PointAttribute> | undefined,
  i: number
): ObjectAttrs | undefined {
  if (!attrs) return undefined;
  const out: ObjectAttrs = {};
  let any = false;
  for (const name of Object.keys(attrs)) {
    const a = attrs[name];
    const k = a.arity;
    if (k === 1) {
      out[name] = a.data[i];
    } else {
      const row = new Array<number>(k);
      for (let c = 0; c < k; c++) row[c] = a.data[i * k + c];
      out[name] = row;
    }
    any = true;
  }
  return any ? out : undefined;
}

export function lerpObjectAttrs(
  a: ObjectAttrs | undefined,
  b: ObjectAttrs | undefined,
  t: number
): ObjectAttrs | undefined {
  if (!a && !b) return undefined;
  const u = Math.max(0, Math.min(1, t));
  const names = new Set<string>([
    ...(a ? Object.keys(a) : []),
    ...(b ? Object.keys(b) : []),
  ]);
  const out: ObjectAttrs = {};
  for (const name of names) {
    const va = asVec(a?.[name]);
    const vb = asVec(b?.[name]);
    const n = Math.max(va.length, vb.length, 1);
    const vec = new Array<number>(n);
    for (let c = 0; c < n; c++) {
      const x = va[c] ?? 0;
      const y = vb[c] ?? 0;
      vec[c] = x + (y - x) * u;
    }
    out[name] = storeVec(vec);
  }
  return out;
}

// Interpolate per-anchor attrs at t ∈ [0,1] of this subpath, with
// per-subpath attrs as the base (anchor wins on collision). Segment
// locate matches sampleSubpathAt so a scatter lands on the same
// material point its position came from.
export function sampleSubpathAttrs(
  sub: SplineSubpath,
  lengths: SubpathLengths,
  t: number
): ObjectAttrs | undefined {
  const n = sub.anchors.length;
  const loc = locateSubpathAt(lengths, t);
  let lerped: ObjectAttrs | undefined;
  if (loc && n >= 2) {
    const ia = loc.segIdx;
    const ib =
      ia + 1 < n ? ia + 1 : sub.closed ? 0 : n - 1;
    lerped = lerpObjectAttrs(
      sub.anchors[ia]?.attrs,
      sub.anchors[ib]?.attrs,
      loc.localT
    );
  } else if (n === 1) {
    lerped = cloneObjectAttrs(sub.anchors[0].attrs);
  }
  return mergeObjectAttrs(sub.attrs, lerped);
}

export function sampleSplineAttrs(
  spline: SplineValue,
  lengths: SplineLengths,
  t: number
): ObjectAttrs | undefined {
  const loc = locateSplineAt(lengths, t);
  if (!loc) return undefined;
  return sampleSubpathAttrs(
    spline.subpaths[loc.subIdx],
    lengths.perSubpath[loc.subIdx],
    loc.localT
  );
}

// N object-attr rows → SoA map. First-seen arity wins; later rows
// pad/truncate. Built-in point names (`scale`, `x`, …) are skipped: this
// builds the NAMED-channel map only, and the callers (Spline to Points,
// Points on Path…) set the built-in columns from geometry themselves.
export function attributesFromObjectAttrs(
  rows: Array<ObjectAttrs | undefined>,
  count: number
): Record<string, PointAttribute> | undefined {
  if (count <= 0) return undefined;
  const arity = new Map<string, 1 | 2 | 3 | 4>();
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const name of Object.keys(row)) {
      if (isBuiltinPointAttrName(name) || arity.has(name)) continue;
      const v = row[name];
      const n = typeof v === "number" ? 1 : Math.max(1, Math.min(4, v.length));
      arity.set(name, n as 1 | 2 | 3 | 4);
    }
  }
  if (arity.size === 0) return undefined;
  const out: Record<string, PointAttribute> = {};
  for (const [name, k] of arity) {
    const data = new Float32Array(count * k);
    for (let i = 0; i < count; i++) {
      const vec = asVec(rows[i]?.[name]);
      for (let c = 0; c < k; c++) data[i * k + c] = vec[c] ?? 0;
    }
    out[name] = { arity: k, data };
  }
  return out;
}

export function flattenSplineAnchorPositions(spline: SplineValue): {
  count: number;
  positions: Float32Array;
  runs: Array<{ start: number; count: number; closed: boolean }>;
} {
  let count = 0;
  for (const sub of spline.subpaths) count += sub.anchors.length;
  const positions = new Float32Array(count * 2);
  const runs: Array<{ start: number; count: number; closed: boolean }> = [];
  let i = 0;
  for (const sub of spline.subpaths) {
    const start = i;
    for (const a of sub.anchors) {
      positions[i * 2] = a.pos[0];
      positions[i * 2 + 1] = a.pos[1];
      i++;
    }
    runs.push({ start, count: sub.anchors.length, closed: sub.closed });
  }
  return { count, positions, runs };
}

export function readSplineAnchorChannel(
  spline: SplineValue,
  name: string
): { arity: 1 | 2 | 3 | 4; data: Float32Array } | undefined {
  const n = flattenSplineAnchorPositions(spline).count;
  if (!name || n === 0) return undefined;
  let arity: 1 | 2 | 3 | 4 | undefined;
  const peek = (v: number | number[] | undefined) => {
    if (v === undefined || arity) return;
    arity = (typeof v === "number" ? 1 : Math.max(1, Math.min(4, v.length))) as
      | 1
      | 2
      | 3
      | 4;
  };
  for (const sub of spline.subpaths) {
    peek(sub.attrs?.[name]);
    for (const a of sub.anchors) peek(a.attrs?.[name]);
    if (arity) break;
  }
  if (!arity) return undefined;
  const data = new Float32Array(n * arity);
  let i = 0;
  for (const sub of spline.subpaths) {
    for (const a of sub.anchors) {
      const vec = asVec(a.attrs?.[name] ?? sub.attrs?.[name]);
      for (let c = 0; c < arity; c++) data[i * arity + c] = vec[c] ?? 0;
      i++;
    }
  }
  return { arity, data };
}

export function writeSplineAnchorChannel(
  spline: SplineValue,
  name: string,
  data: Float32Array,
  arity: 1 | 2 | 3 | 4
): SplineValue {
  let i = 0;
  const subpaths = spline.subpaths.map((sub) => ({
    ...sub,
    anchors: sub.anchors.map((a) => {
      const stored: number | number[] =
        arity === 1
          ? data[i]
          : Array.from(data.subarray(i * arity, i * arity + arity));
      i++;
      return { ...a, attrs: { ...a.attrs, [name]: stored } };
    }),
  }));
  return { kind: "spline", subpaths };
}

// ---------------------------------------------------------------------------
// Subpath attribute schema (092026_unified-attributes.md §4.4). Two names
// route to fields: `group` ↔ groupIndex (an int identity tag) and `driver`
// ↔ attrs.driver, with the legacy `SplineSubpath.driver` field as the read
// fallback during the shim window and 0.5 as the default (an absent driver
// sits mid-ramp, as it always has). Everything else is `attrs[name]`.
// ---------------------------------------------------------------------------

export const SUBPATH_DRIVER_ATTR = "driver";
export const SUBPATH_DRIVER_DEFAULT = 0.5;

// The value under `name` on this subpath — number or number[] as stored,
// `group` as its groupIndex (0 when untagged), `driver` through the
// fallback chain. Undefined for a channel the subpath doesn't carry.
export function readSubpathAttr(
  sub: SplineSubpath,
  name: string
): number | number[] | undefined {
  const n = name.trim();
  if (!n) return undefined;
  if (n === "group") return sub.groupIndex ?? 0;
  const v = sub.attrs?.[n];
  if (v !== undefined) return v;
  if (n === SUBPATH_DRIVER_ATTR) return sub.driver ?? SUBPATH_DRIVER_DEFAULT;
  return undefined;
}

// The per-subpath driver in [0,1]: `attrs[attr || "driver"]` (component 0)
// → the legacy `sub.driver` field → 0.5. A named attr that is missing on
// this subpath falls back the same way (the pre-schema behaviour Rasterize
// / Stroke users rely on). The one read every `by: "driver"` consumer
// (ramps and thickness) goes through.
export function readSubpathDriver(sub: SplineSubpath, attr?: string): number {
  const name = (attr ?? "").trim() || SUBPATH_DRIVER_ATTR;
  const v = sub.attrs?.[name];
  const x = Array.isArray(v) ? v[0] : v;
  if (typeof x === "number" && Number.isFinite(x)) {
    return Math.min(1, Math.max(0, x));
  }
  const d = sub.driver;
  if (typeof d === "number" && Number.isFinite(d)) {
    return Math.min(1, Math.max(0, d));
  }
  return SUBPATH_DRIVER_DEFAULT;
}

// Store `value` under `name` on a copy of the subpath: `group` rounds into
// groupIndex; `driver` lands in attrs AND the legacy field (so readers
// still on `sub.driver` agree during the shim window); anything else is a
// plain attrs write. Empty name → the subpath unchanged.
export function withSubpathAttr(
  sub: SplineSubpath,
  name: string,
  value: number | number[]
): SplineSubpath {
  const n = name.trim();
  if (!n) return sub;
  const scalar = Array.isArray(value) ? value[0] ?? 0 : value;
  if (n === "group") {
    return {
      ...sub,
      groupIndex: Math.round(Number.isFinite(scalar) ? scalar : 0),
    };
  }
  const out: SplineSubpath = { ...sub, attrs: { ...sub.attrs, [n]: value } };
  if (n === SUBPATH_DRIVER_ATTR) {
    out.driver = Number.isFinite(scalar) ? scalar : SUBPATH_DRIVER_DEFAULT;
  }
  return out;
}

// Component 0 of a named channel at arc-length t, with subpath attrs as
// the constant fallback (sampleSubpathAttrs merge). Missing → 0.
export function sampleSubpathAttrScalar(
  sub: SplineSubpath,
  t: number,
  name: string
): number {
  const n = name.trim();
  if (!n) return 0;
  const attrs = sampleSubpathAttrs(sub, measureSubpath(sub), t);
  const v = attrs?.[n];
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
