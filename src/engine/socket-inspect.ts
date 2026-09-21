// JSON-safe dump of a live socket value for MCP / agent debugging.
// Geometry is the point: bounds plus the first N points or anchors, with
// the authored-space convention spelled out so nobody has to measure pixels.

import type { NodeOutput, SocketValue, SplineAnchor, SplineValue } from "./types";
import { is3DPoints } from "./points";
import { readSubpathDriver } from "./spline-attrs";
import { describeListItem } from "./list-value";

export const INSPECT_DEFAULT_LIMIT = 32;
export const INSPECT_MAX_LIMIT = 256;

export type SocketInspect = Record<string, unknown>;

function clampLimit(limit: unknown): number {
  const n = Math.round(Number(limit));
  if (!Number.isFinite(n) || n < 1) return INSPECT_DEFAULT_LIMIT;
  return Math.min(INSPECT_MAX_LIMIT, n);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function pair(x: number, y: number): [number, number] {
  return [round(x), round(y)];
}

function triple(x: number, y: number, z: number): [number, number, number] {
  return [round(x), round(y), round(z)];
}

function compactAttrs(
  attrs: Record<string, number | number[]> | undefined
): Record<string, number | number[]> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, number | number[]> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = Array.isArray(v) ? v.map(round) : round(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function compactAnchor(a: SplineAnchor): Record<string, unknown> {
  const row: Record<string, unknown> = { pos: pair(a.pos[0], a.pos[1]) };
  if (a.id) row.id = a.id;
  if (a.inHandle) row.inHandle = pair(a.inHandle[0], a.inHandle[1]);
  if (a.outHandle) row.outHandle = pair(a.outHandle[0], a.outHandle[1]);
  if (a.broken) row.broken = true;
  if (a.cornerRadius) row.cornerRadius = round(a.cornerRadius);
  if (a.cornerStyle) row.cornerStyle = a.cornerStyle;
  if (a.width !== undefined && a.width !== 1) row.width = round(a.width);
  const attrs = compactAttrs(a.attrs);
  if (attrs) row.attrs = attrs;
  return row;
}

function splineBounds(src: SplineValue): {
  min: [number, number];
  max: [number, number];
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of src.subpaths) {
    for (const a of sub.anchors) {
      const x = a.pos[0];
      const y = a.pos[1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX)
    ? { min: pair(minX, minY), max: pair(maxX, maxY) }
    : null;
}

function inspectSpline(v: SplineValue, limit: number): SocketInspect {
  const subpaths: Record<string, unknown>[] = [];
  let shown = 0;
  let totalAnchors = 0;
  // Attribute names are gathered over the WHOLE value, not just the rows
  // that fit `limit`, and always reported — an empty list means "none
  // present anywhere", which a truncated dump can't otherwise prove.
  const anchorAttrNames = new Set<string>();
  const subpathAttrNames = new Set<string>();
  let groupTagged = 0;
  let driven = 0;
  for (let i = 0; i < v.subpaths.length; i++) {
    const sub = v.subpaths[i];
    totalAnchors += sub.anchors.length;
    if (sub.attrs) for (const k of Object.keys(sub.attrs)) subpathAttrNames.add(k);
    if (sub.groupIndex !== undefined) groupTagged++;
    const hasDriver =
      sub.attrs?.driver !== undefined || sub.driver !== undefined;
    if (hasDriver) driven++;
    for (const a of sub.anchors) {
      if (a.attrs) for (const k of Object.keys(a.attrs)) anchorAttrNames.add(k);
    }
    if (shown >= limit) continue;
    const take = Math.min(sub.anchors.length, limit - shown);
    const row: Record<string, unknown> = {
      i,
      closed: sub.closed,
      anchorCount: sub.anchors.length,
      anchors: sub.anchors.slice(0, take).map(compactAnchor),
    };
    if (sub.groupIndex !== undefined) row.groupIndex = sub.groupIndex;
    // `driver` reads through the subpath schema (attrs.driver first, the
    // legacy field second) so the row agrees with what Rasterize sees.
    if (hasDriver) row.driver = round(readSubpathDriver(sub));
    const attrs = compactAttrs(sub.attrs);
    if (attrs) row.attrs = attrs;
    if (take < sub.anchors.length) row.truncated = true;
    subpaths.push(row);
    shown += take;
  }
  const bounds = splineBounds(v);
  return {
    kind: "spline",
    space: "normalized [0,1]² Y-down (row 0 at top)",
    subpathCount: v.subpaths.length,
    anchorCount: totalAnchors,
    truncated: totalAnchors > limit,
    ...(bounds ? { bounds } : {}),
    // Per-anchor channels (SplineAnchor.attrs) and per-subpath channels
    // (SplineSubpath.attrs), plus how many subpaths carry a groupIndex /
    // driver — the two built-in per-subpath tags.
    attrNames: [...anchorAttrNames].sort(),
    subpathAttrNames: [...subpathAttrNames].sort(),
    groupTaggedSubpaths: groupTagged,
    drivenSubpaths: driven,
    subpaths,
  };
}

function inspectPoints(v: import("./types").PointsValue, limit: number): SocketInspect {
  const three = is3DPoints(v);
  const count = v.count;
  const take = Math.min(count, limit);
  const points: Record<string, unknown>[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = v.positions[i * 2];
    const y = v.positions[i * 2 + 1];
    const z = v.z?.[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z !== undefined) {
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (i >= take) continue;
    const row: Record<string, unknown> = { i, x: round(x), y: round(y) };
    if (z !== undefined) row.z = round(z);
    if (v.rotations) row.rotation = round(v.rotations[i]);
    if (v.scales) row.scale = pair(v.scales[i * 2], v.scales[i * 2 + 1]);
    if (v.groupIndices) row.group = v.groupIndices[i];
    if (v.normals) {
      row.normal = triple(
        v.normals[i * 3],
        v.normals[i * 3 + 1],
        v.normals[i * 3 + 2]
      );
    }
    if (v.attributes) {
      const attrs: Record<string, number | number[]> = {};
      for (const [name, a] of Object.entries(v.attributes)) {
        if (a.arity === 1) attrs[name] = round(a.data[i]);
        else {
          const vals: number[] = [];
          for (let c = 0; c < a.arity; c++) vals.push(round(a.data[i * a.arity + c]));
          attrs[name] = vals;
        }
      }
      if (Object.keys(attrs).length) row.attrs = attrs;
    }
    points.push(row);
  }
  const bounds = Number.isFinite(minX)
    ? three && Number.isFinite(minZ)
      ? { min: triple(minX, minY, minZ), max: triple(maxX, maxY, maxZ) }
      : { min: pair(minX, minY), max: pair(maxX, maxY) }
    : undefined;
  return {
    kind: three ? "points3d" : "points",
    space: three
      ? "world meters Y-up"
      : "normalized [0,1]² Y-down (row 0 at top)",
    count,
    truncated: count > limit,
    ...(bounds ? { bounds } : {}),
    // Always present: [] means the value carries no named attributes.
    attrNames: v.attributes ? Object.keys(v.attributes).sort() : [],
    points,
  };
}

export function inspectSocketValue(
  value: SocketValue | undefined | null,
  limit?: unknown
): SocketInspect {
  const cap = clampLimit(limit);
  if (!value) return { kind: "empty" };
  switch (value.kind) {
    case "spline":
      return inspectSpline(value, cap);
    case "points":
      return inspectPoints(value, cap);
    case "list": {
      const take = Math.min(value.items.length, cap);
      return {
        kind: "list",
        count: value.items.length,
        truncated: value.items.length > cap,
        items: value.items.slice(0, take).map((item) => {
          if (
            item.kind === "points" ||
            item.kind === "spline" ||
            item.kind === "list"
          ) {
            return inspectSocketValue(item, Math.min(8, cap));
          }
          if (item.kind === "scalar") return { kind: "scalar", value: item.value };
          if (
            item.kind === "vec2" ||
            item.kind === "vec3" ||
            item.kind === "vec4"
          ) {
            return { kind: item.kind, value: item.value };
          }
          return { kind: item.kind, summary: describeListItem(item) };
        }),
      };
    }
    case "scalar":
      return { kind: "scalar", value: value.value };
    case "vec2":
    case "vec3":
    case "vec4":
      return { kind: value.kind, value: value.value };
    case "image":
    case "mask":
    case "uv":
      return { kind: value.kind, width: value.width, height: value.height };
    default:
      return { kind: value.kind };
  }
}

export function pickInspectSocket(
  output: NodeOutput | undefined,
  socket?: unknown
): { socket: string; value: SocketValue | undefined } {
  if (!output) return { socket: "out", value: undefined };
  const raw = typeof socket === "string" ? socket.trim() : "";
  if (raw === "out" || raw === "" || raw === "primary") {
    if (output.primary) return { socket: "out", value: output.primary };
  } else if (raw.startsWith("aux:")) {
    const name = raw.slice(4);
    return { socket: `aux:${name}`, value: output.aux?.[name] };
  } else if (output.aux && raw in output.aux) {
    return { socket: `aux:${raw}`, value: output.aux[raw] };
  }
  if (output.primary) return { socket: "out", value: output.primary };
  if (output.aux) {
    for (const [name, v] of Object.entries(output.aux)) {
      if (v?.kind === "points" || v?.kind === "spline") {
        return { socket: `aux:${name}`, value: v };
      }
    }
    const first = Object.entries(output.aux)[0];
    if (first) return { socket: `aux:${first[0]}`, value: first[1] };
  }
  return { socket: "out", value: undefined };
}
