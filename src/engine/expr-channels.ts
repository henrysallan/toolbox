// Expression channels — the Houdini-style tunables shared by Point
// Expression and GLSL Expression (specdocs/090426_expression-channel-kinds.md).
//
// A channel is a named reference in the SOURCE — ch("k", 0.5) — that the
// panel's Sync button (or a committed recipe / MCP expression write) turns
// into a row on the node's `expr_inputs` param: a slider / pill / toggle /
// swatch / ramp / curve that is also, for socketed kinds, a wireable input.
// The code reads it by NAME; the row holds the default; a wire wins.
//
// Kinds (JS call form for Point Expression; the same text as a `//` comment
// declares it in GLSL Expression, whose template then mints the uniform):
//   ch("k", default, min, max)          scalar  → slider, scalar socket
//   pick("mode", "a", "b", …)           enum    → segmented (≤3) / dropdown
//   toggle("on", true)                  toggle  → pill, scalar socket (≠0)
//   color("tint", "#ff8800")            color   → swatch, vec4 socket
//   ramp("ink", t, "#000000", "#fff…")  ramp    → ramp editor, color_ramp socket
//   curve("falloff", x, 1, 0)           curve   → curve editor (no socket)
// Seeds are LITERALS after the name (`ch` positional; the rest by type), so
// the runtime `t` / `x` args in the JS form are skipped by the scanner and
// one grammar serves both nodes. Sync is add-only and id-stable.
//
// Engine-side because the recipe builder, the MCP handlers, the panel and
// both node defs need the same scanner, socket typing and value rules
// (invariant #1 — nothing here imports from nodes/ or components/).

import type {
  ExprChannelKind,
  ExprInput,
  NodeDefinition,
  ParamDef,
  SocketType,
  SocketValue,
} from "./types";
import { vetParamValue } from "./node-catalog";
import { COLOR_RAMP_MAX_STOPS, vetColorRampStops, newColorRampStopId, type ColorRampStop } from "./color-ramp";
import {
  computeMonotoneTangents,
  evalMonotoneCubic,
  newCurvePointId,
  sanitizeFloatCurve,
  vetFloatCurvePoints,
  type CurvePoint,
} from "./float-curve";

// ---------------------------------------------------------------------------
// Ids + kind derivation
// ---------------------------------------------------------------------------

// Stable socket key for a row (`in:<id>`) — never reused across renames so
// wires survive a name change. Shared with the scalar Expression node.
export function newExprInputId(): string {
  return `ein-${Math.random().toString(36).slice(2, 8)}`;
}

// Rows saved before `kind` existed carry only `options` (enum) or nothing
// (scalar) — derive, never require.
export function channelKind(e: ExprInput): ExprChannelKind {
  if (e.kind) return e.kind;
  return e.options ? "enum" : "scalar";
}

// The socket a row exposes, or null for panel-only kinds (enum, curve —
// there is no float_curve socket type; see the spec's decision 3).
export function channelSocketType(e: ExprInput): SocketType | null {
  switch (channelKind(e)) {
    case "scalar":
    case "toggle":
      return "scalar";
    case "color":
      return "vec4";
    case "ramp":
      return "color_ramp";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function normalizeChannelHex(raw: string): string | null {
  const s = raw.trim();
  if (!HEX_RE.test(s)) return null;
  let h = s.slice(1).toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  // A fully opaque 8-digit collapses to the 6-digit canonical form.
  if (h.length === 8 && h.endsWith("ff")) h = h.slice(0, 6);
  return `#${h}`;
}

// Evenly spaced stops from a hex list; black→white when empty.
export function rampStopsFromHexes(hexes: string[]): ColorRampStop[] {
  const list = hexes.length ? hexes : ["#000000", "#ffffff"];
  const n = list.length;
  return list.slice(0, COLOR_RAMP_MAX_STOPS).map((hex, i) => {
    const norm = normalizeChannelHex(hex) ?? "#000000";
    const alpha = norm.length === 9 ? parseInt(norm.slice(7, 9), 16) / 255 : 1;
    return {
      id: newColorRampStopId(),
      position: n === 1 ? 0 : i / (n - 1),
      color: norm.slice(0, 7),
      ...(alpha < 1 ? { alpha } : {}),
    };
  });
}

// Evenly spaced points from a y list; identity 0→1 when fewer than two.
export function curvePointsFromYs(ys: number[]): CurvePoint[] {
  const list = ys.length >= 2 ? ys : [0, 1];
  const n = list.length;
  return list.map((y, i) => ({
    id: newCurvePointId(),
    x: i / (n - 1),
    y: Math.max(0, Math.min(1, y)),
  }));
}

export function defaultChannelValue(kind: ExprChannelKind): unknown {
  switch (kind) {
    case "scalar":
      return 1;
    case "enum":
      return "";
    case "toggle":
      return false;
    case "color":
      return "#ffffff";
    case "ramp":
      return rampStopsFromHexes([]);
    case "curve":
      return curvePointsFromYs([]);
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface ChannelRef {
  name: string;
  kind: ExprChannelKind;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
  stops?: ColorRampStop[];
  points?: CurvePoint[];
}

// `fn("name"` — the name is always a string literal (never a bare
// identifier), so channel names can't collide with built-ins.
const CALL_RE = /\b(ch|pick|toggle|color|ramp|curve)\s*\(\s*(['"])([A-Za-z_$][\w$]*)\2/g;
const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const STR_RE = /^(['"])([^'"]*)\1$/;

type Lit =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "expr" };

function classify(arg: string): Lit {
  const s = arg.trim();
  if (s === "true" || s === "false") return { t: "bool", v: s === "true" };
  if (NUM_RE.test(s)) return { t: "num", v: Number(s) };
  const m = STR_RE.exec(s);
  if (m) return { t: "str", v: m[2] };
  return { t: "expr" };
}

// Split the call's remaining args (after the name literal) at top-level
// commas until its closing paren. Strings and nested brackets are respected.
// A newline at depth 0 ends the call: declarations are one-liners, and this
// keeps a typo'd `// ch("k", 1` in a GLSL comment from swallowing the file.
function readCallArgs(source: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += source[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (!started) {
      if (c === "," ) {
        started = true;
        continue;
      }
      if (c === " " || c === "\t") continue;
      // `)` or anything else before the first comma: no args.
      return args;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        args.push(cur);
        return args;
      }
      depth--;
      cur += c;
      continue;
    }
    if (c === "\n" && depth === 0) {
      args.push(cur);
      return args;
    }
    if (c === "," && depth === 0) {
      args.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (started) args.push(cur);
  return args;
}

function numAt(lits: Lit[], i: number): number | undefined {
  const l = lits[i];
  return l && l.t === "num" && Number.isFinite(l.v) ? l.v : undefined;
}

function refFor(fn: string, name: string, lits: Lit[]): ChannelRef | null {
  switch (fn) {
    case "ch":
      return {
        name,
        kind: "scalar",
        default: numAt(lits, 0),
        min: numAt(lits, 1),
        max: numAt(lits, 2),
      };
    case "pick": {
      const options = lits.filter((l) => l.t === "str").map((l) => (l as { v: string }).v);
      if (!options.length) return null;
      return { name, kind: "enum", options, default: options[0] };
    }
    case "toggle": {
      const l = lits.find((x) => x.t === "bool" || x.t === "num");
      const on = l ? (l.t === "bool" ? l.v : l.t === "num" ? l.v !== 0 : false) : false;
      return { name, kind: "toggle", default: on };
    }
    case "color": {
      const l = lits.find((x) => x.t === "str" && normalizeChannelHex(x.v));
      return {
        name,
        kind: "color",
        default: l && l.t === "str" ? normalizeChannelHex(l.v)! : "#ffffff",
      };
    }
    case "ramp": {
      const hexes = lits
        .filter((l) => l.t === "str" && normalizeChannelHex(l.v))
        .map((l) => (l as { v: string }).v);
      return { name, kind: "ramp", stops: rampStopsFromHexes(hexes) };
    }
    case "curve": {
      const ys = lits.filter((l) => l.t === "num").map((l) => (l as { v: number }).v);
      return { name, kind: "curve", points: curvePointsFromYs(ys) };
    }
    default:
      return null;
  }
}

// Scan a source for channel references (first occurrence of a name wins).
export function scanChannelRefs(source: string): ChannelRef[] {
  const out: ChannelRef[] = [];
  const seen = new Set<string>();
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(source)) !== null) {
    const name = m[3];
    if (seen.has(name)) continue;
    const lits = readCallArgs(source, m.index + m[0].length).map(classify);
    const ref = refFor(m[1], name, lits);
    if (!ref) continue;
    seen.add(name);
    out.push(ref);
  }
  return out;
}

function rowFromRef(ref: ChannelRef): ExprInput {
  const id = newExprInputId();
  switch (ref.kind) {
    case "enum":
      return {
        id,
        name: ref.name,
        kind: "enum",
        default: (ref.default as string) ?? "",
        options: ref.options ?? [],
      };
    case "toggle":
      return { id, name: ref.name, kind: "toggle", default: ref.default === true };
    case "color":
      return {
        id,
        name: ref.name,
        kind: "color",
        default: typeof ref.default === "string" ? ref.default : "#ffffff",
      };
    case "ramp":
      return { id, name: ref.name, kind: "ramp", default: ref.stops ?? rampStopsFromHexes([]) };
    case "curve":
      return { id, name: ref.name, kind: "curve", default: ref.points ?? curvePointsFromYs([]) };
    default:
      return {
        id,
        name: ref.name,
        default: typeof ref.default === "number" ? ref.default : 1,
        ...(ref.min !== undefined ? { min: ref.min } : {}),
        ...(ref.max !== undefined ? { max: ref.max } : {}),
      };
  }
}

// Merge channel references from `source` into an existing row list. Add-only
// (Houdini's "create from channel references"): new names are appended with
// their seed + control metadata; existing ones keep their id, wires, and
// user-tuned value. Callers prune with the row × button. Returns the SAME
// array (referentially) when nothing changed, so the panel skips a no-op write.
export function syncChannelInputs(existing: ExprInput[], source: string): ExprInput[] {
  const have = new Set(existing.map((e) => e.name));
  const additions: ExprInput[] = [];
  for (const ref of scanChannelRefs(source)) {
    if (have.has(ref.name)) continue;
    have.add(ref.name);
    additions.push(rowFromRef(ref));
  }
  return additions.length === 0 ? existing : [...existing, ...additions];
}

// ---------------------------------------------------------------------------
// Panel + vetting: the row as a ParamDef
// ---------------------------------------------------------------------------

// What the panel renders for a row (and what set_param vets against). The
// scalar range here is the INFERRED base (the "reset" fallback derived from
// the default); an explicit ch(…, min, max) range rides on top as a
// rangeOverride — see channelRangeOverride — so the standard
// SliderRangeEditor's diff-vs-default logic works unchanged.
export function channelParamDef(e: ExprInput): ParamDef {
  switch (channelKind(e)) {
    case "enum": {
      const options = e.options ?? [];
      return {
        name: e.name,
        type: "enum",
        options,
        default: options[0] ?? "",
        ...(options.length <= 3 ? { control: "segmented" as const } : {}),
      };
    }
    case "toggle":
      return { name: e.name, type: "boolean", default: false };
    case "color":
      return { name: e.name, type: "color", default: "#ffffff", alpha: true };
    case "ramp":
      return { name: e.name, type: "color_ramp", default: rampStopsFromHexes([]) };
    case "curve":
      return { name: e.name, type: "float_curve", default: curvePointsFromYs([]) };
    default: {
      const d = typeof e.default === "number" ? e.default : 0;
      const inferMin = d < 0 ? d * 2 : 0;
      const inferMax = d === 0 ? 1 : Math.abs(d) * 2;
      const step =
        e.step ??
        (inferMax >= 100 ? 1 : inferMax >= 10 ? 0.1 : inferMax >= 1 ? 0.01 : 0.001);
      return { name: e.name, type: "scalar", default: d, min: inferMin, max: inferMax, step };
    }
  }
}

// The scalar row's explicit range (from ch args or the right-click editor).
// Undefined when nothing's set ⇒ the slider uses the inferred base.
export function channelRangeOverride(
  e: ExprInput
): { min?: number; max?: number; softMax?: number } | undefined {
  const r: { min?: number; max?: number; softMax?: number } = {};
  if (e.min !== undefined) r.min = e.min;
  if (e.max !== undefined) r.max = e.max;
  if (e.softMax !== undefined) r.softMax = e.softMax;
  return Object.keys(r).length ? r : undefined;
}

// Vet a remotely supplied value for a row (set_param by channel name). The
// simple kinds ride vetParamValue via the synthesized def; ramp / curve
// take their plain-JSON shapes with ids minted here. Scalars clamp to the
// row's explicit range when it has one (the slider's hard bounds).
export function vetChannelValue(
  e: ExprInput,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const kind = channelKind(e);
  if (kind === "ramp") return vetColorRampStops(value);
  // Same vetting as a `float_curve` param (vetParamValue) — one shape for
  // both: [{x, y}] with optional ids.
  if (kind === "curve") return vetFloatCurvePoints(value);
  const def = channelParamDef(e);
  if (kind === "scalar") {
    const r = channelRangeOverride(e);
    if (r?.min !== undefined) def.min = r.min;
    if (r?.max !== undefined) def.max = r.max;
    else delete def.max; // an inferred max is a slider hint, not a bound
    if (r?.min === undefined) delete def.min;
  }
  if (kind === "toggle" && typeof value === "number" && Number.isFinite(value))
    value = value !== 0;
  const vet = vetParamValue(def, value);
  if (!vet.ok) return vet;
  return { ok: true, value: kind === "color" ? normalizeChannelHex(String(vet.value)) ?? "#ffffff" : vet.value };
}

// Valid JS identifier — Expression variable names and grow-on-wire.
export const EXPR_VAR_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// The channelSync expr_inputs param on a def, if any.
export function channelListParam(def: NodeDefinition): ParamDef | undefined {
  return def.params.find((p) => p.type === "expr_inputs" && p.channelSync);
}

// Any expr_inputs param. Prefers the channelSync list (Point / GLSL
// Expression) so a node that also had a non-sync list wouldn't steal
// lookups; the scalar Expression node has only the non-sync one.
export function exprInputsParam(def: NodeDefinition): ParamDef | undefined {
  return channelListParam(def) ?? def.params.find((p) => p.type === "expr_inputs");
}

// A channel / Expression variable looked up by authored name (`ink`, `x`)
// or minted id (`ein-…`). Name wins a collision so recipes that address
// by name stay stable. Looks at channelSync rows first, then the scalar
// Expression `inputs` list — without this, Expression sockets were
// invisible to recipe/MCP wiring (the validator rejected even `ein-x0`).
export function findExprChannel(
  def: NodeDefinition,
  params: Record<string, unknown>,
  name: string
): ExprInput | undefined {
  const p = exprInputsParam(def);
  if (!p) return undefined;
  const list = (params[p.name] as ExprInput[]) ?? [];
  return list.find((e) => e.name === name) ?? list.find((e) => e.id === name);
}

// Restricted authoring shape for the scalar Expression node's `inputs`
// param (not channelSync — those rows are declared in the source). Same
// spirit as vetMergeLayers: [{name, default?}, …], ids preserved BY INDEX
// so existing wires never dangle.
export function vetExprInputList(
  value: unknown,
  existing?: ExprInput[]
): { ok: true; value: ExprInput[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: "expected a non-empty [{name, default?}, …] list" };
  }
  if (value.length > 16) {
    return { ok: false, reason: "at most 16 Expression inputs" };
  }
  const out: ExprInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const rec =
      typeof raw === "string"
        ? { name: raw }
        : raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
    const name = typeof rec?.name === "string" ? rec.name.trim() : "";
    if (!EXPR_VAR_NAME_RE.test(name)) {
      return {
        ok: false,
        reason: `inputs[${i}]: name must be a JS identifier (got ${JSON.stringify(rec?.name)})`,
      };
    }
    if (seen.has(name)) {
      return { ok: false, reason: `inputs[${i}]: duplicate name "${name}"` };
    }
    seen.add(name);
    const prev = existing?.[i];
    const id =
      prev && typeof prev.id === "string" && prev.id
        ? prev.id
        : newExprInputId();
    let deflt: number | undefined;
    if (rec && "default" in rec) {
      if (typeof rec.default !== "number" || !Number.isFinite(rec.default)) {
        return { ok: false, reason: `inputs[${i}].default must be a finite number` };
      }
      deflt = rec.default;
    } else if (typeof prev?.default === "number") {
      deflt = prev.default;
    } else {
      deflt = 1;
    }
    out.push({ id, name, default: deflt });
  }
  return { ok: true, value: out };
}

// set_param by channel name: returns the params with that row's value
// replaced (same array shape the panel writes), or the vetting failure.
export function setExprChannelValue(
  def: NodeDefinition,
  params: Record<string, unknown>,
  name: string,
  value: unknown
):
  | { ok: true; params: Record<string, unknown>; listParam: string; value: unknown }
  | { ok: false; reason: string } {
  const p = exprInputsParam(def);
  if (!p) return { ok: false, reason: "node has no channels" };
  const list = (params[p.name] as ExprInput[]) ?? [];
  const row = list.find((e) => e.name === name);
  if (!row) return { ok: false, reason: `no channel "${name}"` };
  const vet = vetChannelValue(row, value);
  if (!vet.ok) return vet;
  const next = list.map((e) =>
    e.id === row.id ? { ...e, default: vet.value as ExprInput["default"] } : e
  );
  return { ok: true, params: { ...params, [p.name]: next }, listParam: p.name, value: vet.value };
}

// ---------------------------------------------------------------------------
// Runtime values
// ---------------------------------------------------------------------------

export type Rgba01 = [number, number, number, number];

export function hexToRgba01Channel(hex: string): Rgba01 {
  const norm = normalizeChannelHex(hex) ?? "#ffffff";
  const h = norm.slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

// Per-eval value of one row: the wired socket if present (scalar → number,
// scalar → toggle via ≠ 0, vec4 → color, color_ramp → stops), else the row.
export type ExprChannelValue =
  | number
  | string
  | boolean
  | Rgba01
  | ColorRampStop[]
  | CurvePoint[];

export function readChannelValue(
  e: ExprInput,
  sock: SocketValue | undefined
): ExprChannelValue {
  switch (channelKind(e)) {
    case "scalar":
      return sock && sock.kind === "scalar"
        ? sock.value
        : typeof e.default === "number"
          ? e.default
          : 0;
    case "toggle":
      if (sock && sock.kind === "scalar") return sock.value !== 0;
      return typeof e.default === "boolean"
        ? e.default
        : typeof e.default === "number"
          ? e.default !== 0
          : false;
    case "enum":
      return typeof e.default === "string" ? e.default : (e.options?.[0] ?? "");
    case "color":
      if (sock && sock.kind === "vec4") return [...sock.value] as Rgba01;
      return hexToRgba01Channel(typeof e.default === "string" ? e.default : "#ffffff");
    case "ramp":
      if (sock && sock.kind === "color_ramp") return sock.stops;
      return Array.isArray(e.default) && e.default.length
        ? (e.default as ColorRampStop[])
        : rampStopsFromHexes([]);
    case "curve":
      return sanitizeFloatCurve(e.default);
  }
}

export function readChannelValues(
  entries: ExprInput[],
  inputs: Record<string, SocketValue | undefined>
): Record<string, ExprChannelValue> {
  const out: Record<string, ExprChannelValue> = {};
  for (const e of entries) out[e.name] = readChannelValue(e, inputs[`in:${e.id}`]);
  return out;
}

// Samplers — built once per eval, called per element / per LUT texel.
// Ramp: sort + hex-parse once, then bracket + linear mix (straight alpha,
// clamped ends — the Color Ramp node's `linear` semantics).
export function makeRampSampler(stops: ColorRampStop[]): (t: number) => Rgba01 {
  const sorted = stops
    .filter((s) => typeof s.position === "number")
    .slice(0, COLOR_RAMP_MAX_STOPS)
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const c = hexToRgba01Channel(s.color);
      c[3] = Math.max(0, Math.min(1, s.alpha ?? 1));
      return { p: s.position, c };
    });
  const n = sorted.length;
  return (t: number): Rgba01 => {
    const tc = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
    if (n === 0) return [tc, tc, tc, 1];
    if (n === 1 || tc <= sorted[0].p) return [...sorted[0].c] as Rgba01;
    if (tc >= sorted[n - 1].p) return [...sorted[n - 1].c] as Rgba01;
    for (let i = 0; i < n - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (tc >= a.p && tc <= b.p) {
        const span = b.p - a.p;
        const f = span > 1e-8 ? (tc - a.p) / span : 0;
        return [
          a.c[0] + (b.c[0] - a.c[0]) * f,
          a.c[1] + (b.c[1] - a.c[1]) * f,
          a.c[2] + (b.c[2] - a.c[2]) * f,
          a.c[3] + (b.c[3] - a.c[3]) * f,
        ];
      }
    }
    return [...sorted[n - 1].c] as Rgba01;
  };
}

export function makeCurveSampler(points: CurvePoint[]): (x: number) => number {
  const pts = sanitizeFloatCurve(points);
  const tangents = computeMonotoneTangents(pts);
  return (x: number) => evalMonotoneCubic(pts, tangents, Number.isFinite(x) ? x : 0);
}

// 256×1 RGBA lookup tables for the GLSL side (uploaded with
// ctx.uploadFloat32ToImage; the pool's LINEAR + CLAMP_TO_EDGE sampling
// makes `texture(lut, vec2(t, 0.5))` the whole lookup).
export const CHANNEL_LUT_SIZE = 256;

export function buildRampLut(stops: ColorRampStop[], size = CHANNEL_LUT_SIZE): Float32Array {
  const sample = makeRampSampler(stops);
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const c = sample(i / (size - 1));
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = c[3];
  }
  return out;
}

export function buildCurveLut(points: CurvePoint[], size = CHANNEL_LUT_SIZE): Float32Array {
  const sample = makeCurveSampler(points);
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const v = sample(i / (size - 1));
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 1;
  }
  return out;
}

// Compact, id-free view of a node's channels for get_graph / the agent.
export function describeChannels(
  entries: ExprInput[]
): { name: string; kind: ExprChannelKind; value: unknown; options?: string[]; socket?: SocketType }[] {
  return entries.map((e) => {
    const kind = channelKind(e);
    let value: unknown = e.default;
    if (kind === "ramp" && Array.isArray(e.default))
      value = (e.default as ColorRampStop[]).map((s) => ({
        position: s.position,
        color: s.color,
        ...(s.alpha !== undefined && s.alpha < 1 ? { alpha: s.alpha } : {}),
      }));
    else if (kind === "curve" && Array.isArray(e.default))
      value = (e.default as CurvePoint[]).map((p) => ({ x: p.x, y: p.y }));
    const socket = channelSocketType(e);
    return {
      name: e.name,
      kind,
      value,
      ...(e.options ? { options: e.options } : {}),
      ...(socket ? { socket } : {}),
    };
  });
}
