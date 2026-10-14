// planSceneExport — resolve every Bind in a Skia scene (scene-ir.ts) into
// something React Native Skia can replay exactly (specdocs/101326_skia-target.md
// §3.4, §3.5a): a static value, a timeline track, a per-frame sampled
// series, the master clock, or a refusal with a reason.
//
//   ref → keyframed param   track (the M0 keyframe → TimelineKey conversion)
//   ref → wired param       follow the wire to a driver exactly as
//                           planSkiaExport does (Animated Value / Constant /
//                           Color); any other driver refuses
//   ref → plain param       static (the producer's evaluated `v`)
//   deps (derived value)    sampled per frame when any dep animates, else
//                           static
//   uniforms.iTime, untagged  the master clock (seconds)
//
// Pure: no GL, no evaluator. The caller hands in the scene at tick 0 and,
// optionally, `sampleAt(tick)` — the same producer re-evaluated at another
// tick (exportSkia passes one that runs the real graph). With a sampler the
// planner also VERIFIES: it samples every frame once and
//   - refuses when anything but a bound value changes (the emitter writes
//     structure statically: node kinds, child counts, styles, SkSL…);
//   - falls back to sampling (with a warning) when a track does not
//     reproduce the producer's value at some frame (a producer that
//     transformed the param but tagged a plain `ref`), or when an untagged
//     value moves.
// So an export is exact at every frame tick whatever the producers tag;
// the tags only decide how compact and scrubbable it is.
//
// Binds are addressed by their path through the tree ("root.children.0.
// paint.color"), which is how sampled scenes are matched to the tick-0 one.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ExprInput } from "@/engine/types";
import { channelKind } from "@/engine/expr-channels";
import { LAYER_TYPE } from "@/engine/groups";
import type { Keyframe } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import {
  SKIA_IR_VERSION,
  type AssetIR,
  type Bind,
  type BindRef,
  type GeomIR,
  type ImageFilterIR,
  type PaintIR,
  type ShaderIR,
  type SkiaNode,
  type SkiaScene,
} from "@/engine/skia/scene-ir";
import { hexToTuple, liveBlock, resolveDriver, toTimelineKey, type DriverBinding } from "./drivers";
import { evaluateTrack, type TimelineKey, type TimelineTrack } from "./runtime/toolbox-timeline";

export type BindValue = number | number[] | string;

// How the emitter types and reads a bind.
//   number  a scalar prop / uniform
//   array   number[] (colors, vectors, matrices, point lists, xforms)
//   string  text
//   path    SVG path data (GeomIR path `d`)
export type BindRole = "number" | "array" | "string" | "path";

export type BindPlan =
  | { kind: "static"; value: BindValue; from: string }
  // One track ⇒ its value (or component `pick` of a color track); several
  // ⇒ a vector, one scalar track per component.
  | { kind: "track"; tracks: TimelineTrack[]; pick?: number; from: string }
  // Seconds on the master clock (a fused program's iTime).
  | { kind: "clock"; from: string }
  // The producer's value at every frame 0..frames-1 (dense; scene-emit
  // compresses). Exact at frame ticks.
  | { kind: "sampled"; values: BindValue[]; from: string }
  | { kind: "refused"; reason: string };

export interface PlannedBind {
  // Emitted key ("b0"…), in walk order.
  id: string;
  path: string;
  role: BindRole;
  plan: BindPlan;
}

export interface ScenePlan {
  name: string;
  // The tick-0 scene the emitter walks.
  scene: SkiaScene;
  canvas: { width: number; height: number };
  timeline: { fps: number; ticksPerFrame: number; durationTicks: number; frames: number };
  binds: PlannedBind[];
  // The same, keyed by the Bind objects of `scene` (the emitter walks the
  // tree and looks each one up by identity).
  bindFor: Map<Bind<unknown>, PlannedBind>;
  // Referenced assets only, in first-use order.
  assets: AssetIR[];
  // Frames the sampler was run for (0 = never).
  sampledFrames: number;
  warnings: string[];
}

export interface ScenePlanOptions {
  name: string;
  timeline: { fps: number; ticksPerFrame: number; sceneDurationTicks: number };
  // The producer's scene at `tick` (null: nothing reaches the canvas then).
  sampleAt?: (tick: number) => SkiaScene | null;
  // Sample every frame to verify structure and tracks (default: on when a
  // sampler is given).
  verify?: boolean;
}

export interface ScenePlanResult {
  plan: ScenePlan | null;
  problems: string[];
  // Every bind's resolution, also when the plan is refused (the editor's
  // export dialog lists them).
  binds: PlannedBind[];
}

// ---- walking the IR ------------------------------------------------------------

export function isBind(x: unknown): x is Bind<unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  return keys.includes("v") && keys.every((k) => k === "v" || k === "ref" || k === "deps");
}

interface FoundBind {
  path: string;
  bind: Bind<unknown>;
  role: BindRole;
}

// Every Bind under the root, depth-first in key order (the emitter walks the
// same tree and looks binds up by path, so order only names the ids).
export function collectBinds(root: SkiaNode): FoundBind[] {
  const out: FoundBind[] = [];
  const visit = (x: unknown, path: string, parentK: string | undefined, key: string) => {
    if (isBind(x)) {
      const v = x.v;
      const role: BindRole =
        typeof v === "string" ? (parentK === "path" && key === "d" ? "path" : "string") : Array.isArray(v) ? "array" : "number";
      out.push({ path, bind: x, role });
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((c, i) => visit(c, `${path}.${i}`, parentK, String(i)));
      return;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const k = typeof o.k === "string" ? o.k : parentK;
      for (const [kk, c] of Object.entries(o)) visit(c, `${path}.${kk}`, k, kk);
    }
  };
  visit(root, "root", undefined, "root");
  return out;
}

// The scene with every bound value blanked: what must not change over time.
// Keys sorted, so a producer that builds its objects in a different order
// at another tick is not a "structure change".
function structureOf(s: SkiaScene): unknown {
  const strip = (x: unknown): unknown => {
    if (isBind(x)) return "§";
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const v = (x as Record<string, unknown>)[k];
        if (v !== undefined) o[k] = strip(v);
      }
      return o;
    }
    return x;
  };
  return {
    version: s.version,
    width: s.width,
    height: s.height,
    background: s.background ?? null,
    assets: Object.keys(s.assets ?? {}).sort(),
    root: strip(s.root),
  };
}

// First path where two stripped structures differ ("" = equal).
function structuralDiff(a: unknown, b: unknown, path: string): string {
  if (Object.is(a, b)) return "";
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path} (length ${a.length} → ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const d = structuralDiff(a[i], b[i], `${path}.${i}`);
      if (d) return d;
    }
    return "";
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    for (const k of new Set([...ka, ...kb])) {
      const d = structuralDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return "";
  }
  return `${path} (${JSON.stringify(a)?.slice(0, 40)} → ${JSON.stringify(b)?.slice(0, 40)})`;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return Object.is(a, b);
}

function shapeOf(v: unknown): "number" | "array" | "string" | "other" {
  return typeof v === "number" ? "number" : typeof v === "string" ? "string" : Array.isArray(v) ? "array" : "other";
}

// ---- structural validation (what the emitter cannot express) ----------------------

function validateScene(scene: SkiaScene, problems: string[], assetsUsed: Map<string, AssetIR>) {
  if (scene.version !== SKIA_IR_VERSION) problems.push(`Scene IR version ${scene.version} — this exporter reads version ${SKIA_IR_VERSION}.`);
  const noteAsset = (id: string, kinds: AssetIR["kind"][], where: string) => {
    const a = scene.assets?.[id];
    if (!a) {
      problems.push(`${where} draws asset "${id}", which the scene does not list.`);
      return;
    }
    if (!kinds.includes(a.kind)) {
      problems.push(`${where} draws asset "${id}" (${a.kind}) — it needs ${kinds.join(" or ")}${a.kind === "svg" ? "; SVG assets don't export yet" : ""}.`);
      return;
    }
    if (!assetsUsed.has(id)) assetsUsed.set(id, a);
  };
  const shader = (s: ShaderIR, where: string) => {
    if (s.k === "runtime") for (const c of s.program.children) shader(c.shader, `${where} child ${c.name}`);
    if (s.k === "image") noteAsset(s.asset, ["image"], where);
  };
  const imageFilter = (f: ImageFilterIR, where: string) => {
    if (f.k === "displacement") shader(f.map, `${where} displacement map`);
    if (f.k === "runtime" && f.program.children.length) {
      problems.push(`${where}: a RuntimeShader image filter reads only the rendered content — extra child shaders (${f.program.children.map((c) => c.name).join(", ")}) don't export (React Native Skia binds the content as the program's only child).`);
    }
  };
  const paint = (p: PaintIR, where: string, geom?: GeomIR) => {
    if (p.shader) shader(p.shader, where);
    if (geom && p.pathEffects?.some((e) => e.k === "trim") && geom.k === "points" && geom.mode !== "polygon") {
      problems.push(`${where}: trimming ${geom.mode} needs a path — only polygon points trim.`);
    }
  };
  const visit = (n: SkiaNode, path: string) => {
    const where = `${path} (${n.k}${n.id ? ` from ${n.id}` : ""})`;
    switch (n.k) {
      case "group":
        if (n.clip?.geom.k === "line") problems.push(`${where}: a line has no area to clip to.`);
        if (n.clip?.geom.k === "points" && n.clip.geom.mode !== "polygon") problems.push(`${where}: only polygon points clip.`);
        for (const f of n.layer?.imageFilters ?? []) imageFilter(f, where);
        n.children.forEach((c, i) => visit(c, `${path}.children.${i}`));
        return;
      case "fill":
        paint(n.paint, where);
        return;
      case "shape":
        paint(n.paint, where, n.geom);
        return;
      case "image":
        noteAsset(n.asset, ["image"], where);
        return;
      case "text":
        noteAsset(n.font.asset, ["font"], where);
        paint(n.paint, where);
        // With `width` the IR means a PARAGRAPH laid out to that width,
        // top-left at (x, y) (scene-ir.ts; scene-render draws it so). The
        // <Paragraph> emitter lands with the text family; until then refuse
        // rather than ship single-line text that won't match the preview.
        if (n.width) problems.push(`${where}: text with a width is a wrapped paragraph — paragraph export lands with the text family (spec §7 Wave 2); remove the width for single-line text.`);
        return;
      case "atlas":
        noteAsset(n.asset, ["image"], where);
        if (Array.isArray(n.xforms.v) && n.xforms.v.length !== n.sprites.length * 4) {
          problems.push(`${where}: ${n.sprites.length} sprites need ${n.sprites.length * 4} xform floats, got ${n.xforms.v.length}.`);
        }
        return;
      default:
        problems.push(`${path}: node kind "${(n as { k: string }).k}" has no React Native Skia lowering in this exporter.`);
    }
  };
  visit(scene.root, "root");
}

// ---- resolving one bind --------------------------------------------------------------

// Derived from animated deps: decided by the sampler.
type NeedsSample = { kind: "needs-sample"; from: string };
// Not animated: the producer's own `v` (it may have converted units).
type Plain = { kind: "plain"; from: string };

interface Ctx {
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
}

function refLabel(r: BindRef): string {
  return `${r.node}.${r.param}${r.component === undefined ? "" : `[${r.component}]`}`;
}

function channelRow(node: GraphNode, name: string): ExprInput | undefined {
  const rows = node.params.inputs;
  return Array.isArray(rows) ? (rows as ExprInput[]).find((r) => r.name === name) : undefined;
}

// The edge that overrides a param / channel, as the evaluator sees it: an
// `in:param:` wire only counts when the param is exposed.
function wireInto(c: Ctx, node: GraphNode, param: string): GraphEdge | undefined {
  if (param.startsWith("ch:")) {
    const row = channelRow(node, param.slice(3));
    if (!row) return undefined;
    return c.edges.find((e) => e.target === node.id && (e.targetHandle === `in:in:${row.id}` || e.targetHandle === `in:${row.id}`));
  }
  if (!(node.exposedParams ?? []).includes(param)) return undefined;
  return c.edges.find((e) => e.target === node.id && e.targetHandle === `in:param:${param}`);
}

// Could this ref's value change over the scene? (keyframed, wired —
// including an input socket of that name — or clipped). Over-approximate:
// sampling collapses a value that turns out constant.
// Virtual sub-keys that animate PART of a param (engine/conventions.ts): a
// ramp's stops (`ramp_c|a|p:<param>:<stopId>`), a Merge's layer opacities,
// a multipoint gradient's points. Keyframed or wired, they move the param.
function subKeysOf(node: GraphNode, param: string): (key: string) => boolean {
  const t = getNodeDef(node.type)?.params.find((p) => p.name === param)?.type;
  return (key) =>
    key.startsWith(`ramp_c:${param}:`) ||
    key.startsWith(`ramp_a:${param}:`) ||
    key.startsWith(`ramp_p:${param}:`) ||
    (t === "merge_layers" && key.startsWith("layer_opacity:")) ||
    (t === "gradient_points" && /^gpoint_[xyc]:/.test(key));
}

function refAnimates(c: Ctx, r: BindRef): boolean {
  const node = c.byId.get(r.node);
  if (!node) return false;
  if (liveBlock(node, r.param)) return true;
  if (wireInto(c, node, r.param)) return true;
  const sub = subKeysOf(node, r.param);
  if (Object.keys(node.animation ?? {}).some((k) => sub(k) && liveBlock(node, k))) return true;
  if (c.edges.some((e) => e.target === node.id && e.targetHandle.startsWith("in:param:") && sub(e.targetHandle.slice("in:param:".length)))) {
    return true;
  }
  if (c.edges.some((e) => e.target === node.id && e.targetHandle === `in:${r.param}`)) return true;
  return !!node.clips?.some((cl) => cl.enabled);
}

type ParamKind = "scalar" | "vec2" | "vec3" | "vec4" | "color" | "other";

function paramKindOf(node: GraphNode, param: string): { kind: ParamKind; alpha: boolean; label: string } {
  if (param.startsWith("ch:")) {
    const row = channelRow(node, param.slice(3));
    const k = row ? channelKind(row) : "other";
    return { kind: k === "scalar" || k === "color" ? k : "other", alpha: true, label: row ? k : "missing" };
  }
  const pdef = getNodeDef(node.type)?.params.find((p) => p.name === param);
  if (pdef) {
    const t = pdef.type;
    const kind: ParamKind = t === "scalar" || t === "vec2" || t === "vec3" || t === "vec4" || t === "color" ? t : "other";
    return { kind, alpha: !!pdef.alpha, label: t };
  }
  // No registered def (a fixture, a type from a newer build): infer from
  // the stored value.
  const v = node.params[param];
  if (typeof v === "number") return { kind: "scalar", alpha: false, label: "scalar" };
  if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) return { kind: "color", alpha: false, label: "color" };
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === "number")) {
    const kind = (["vec2", "vec3", "vec4"] as const)[v.length - 2];
    return { kind, alpha: false, label: kind };
  }
  return { kind: "other", alpha: false, label: typeof v };
}

// The layer (if any) whose clip windows put this node on local time.
function retimingLayer(c: Ctx, node: GraphNode): GraphNode | null {
  const seen = new Set<string>();
  let cur: GraphNode | undefined = node.parentId ? c.byId.get(node.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === LAYER_TYPE && cur.clips?.some((cl) => cl.enabled && cl.inTick !== cl.sourceInTick)) return cur;
    cur = cur.parentId ? c.byId.get(cur.parentId) : undefined;
  }
  return null;
}

// A static driver is "plain": the producer's `v` already holds its value
// (in whatever units the producer draws in).
function bindingToPlan(b: DriverBinding, pick: number | undefined): BindPlan | Plain {
  if (b.track) return { kind: "track", tracks: [b.track], ...(pick === undefined ? {} : { pick }), from: b.from };
  return { kind: "plain", from: b.from };
}

// A vec param's keys as one scalar track per component. The engine lerps
// vectors per component with the eased t; customBezier handles apply to
// scalars only (a vec segment plays easeOf("customBezier") = linear).
function componentTrack(keys: Keyframe[], c: number): TimelineTrack | null {
  const out: TimelineKey[] = [];
  for (const k of keys) {
    const v = k.value;
    if (!Array.isArray(v) || typeof v[c] !== "number") return null;
    const key: TimelineKey = { tick: k.tick, value: v[c], easing: k.easingOut === "customBezier" ? "linear" : k.easingOut };
    if (k.easingOut === "cubicBezier" && k.bezier) key.bezier = { ...k.bezier };
    out.push(key);
  }
  return { kind: "scalar", keys: out };
}

function resolveRef(c: Ctx, r: BindRef, path: string): BindPlan | Plain {
  const node = c.byId.get(r.node);
  const label = refLabel(r);
  if (!node) return { kind: "refused", reason: `${path} reads ${label}, but node "${r.node}" is not in the graph.` };
  if (node.clips?.some((cl) => cl.enabled)) {
    return { kind: "refused", reason: `${path} reads ${label}, which sits on a clip window — retimed values don't export yet.` };
  }
  const layer = retimingLayer(c, node);
  if (layer) {
    return { kind: "refused", reason: `${path} reads ${label} inside layer "${layer.id}", whose clip shifts its local time — retimed layers don't export yet.` };
  }
  const isChannel = r.param.startsWith("ch:");
  const pk = paramKindOf(node, r.param);
  if (isChannel && pk.label === "missing") {
    return { kind: "refused", reason: `${path} reads channel "${r.param.slice(3)}", which node "${r.node}" does not have.` };
  }
  const comp = r.component;
  const isVec = pk.kind === "vec2" || pk.kind === "vec3" || pk.kind === "vec4";

  // 1. Wire > keyframes > constant.
  const edge = wireInto(c, node, r.param);
  if (edge) {
    const src = c.byId.get(edge.source);
    if (!src) return { kind: "refused", reason: `${path} reads ${label}, wired from a missing node "${edge.source}".` };
    let driverKind: string;
    if (pk.kind === "scalar" || pk.kind === "color") driverKind = pk.kind;
    else if (isVec && comp !== undefined) driverKind = "scalar"; // scalar → vecN broadcasts (coerce.ts)
    else if (isVec) {
      return { kind: "refused", reason: `${path} reads the whole wired vector ${label} — bind one component per value (component) so each can follow a scalar driver.` };
    } else driverKind = pk.label;
    const res = resolveDriver(src, edge, c.edges, driverKind, r.param, {
      colorAlpha: isChannel ? "node" : pk.alpha ? "hex-alpha" : "hex",
      subject: `${path} (${label})`,
      tail: "only Animated Value (scalar), Constant (scalar) and Color (color) drive an exported Skia value.",
    });
    if (res.problems.length || !res.binding) return { kind: "refused", reason: res.problems.join(" ") };
    return bindingToPlan(res.binding, pk.kind === "color" ? comp : undefined);
  }

  // 2. Keyframes on the node itself.
  const block = liveBlock(node, r.param);
  if (block) {
    const def = getNodeDef(node.type);
    const clock = def?.clockInput;
    if (clock && c.edges.some((e) => e.target === node.id && e.targetHandle === `in:${clock.input}`)) {
      return { kind: "refused", reason: `${path} reads ${label}, whose keyframes sample at a wired clock (${clock.input}) — only playhead-driven keyframes export.` };
    }
    const n = block.keyframes.length;
    const from = `keyframes ${node.id}.${r.param} (${n} keys)`;
    if (pk.kind === "scalar") {
      if (block.keyframes.some((k) => typeof k.value !== "number")) {
        return { kind: "refused", reason: `${path}: keyframes on ${label} hold non-numbers.` };
      }
      return { kind: "track", tracks: [{ kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) }], from };
    }
    if (isVec) {
      const width = Number(pk.kind.slice(3));
      const comps = comp === undefined ? Array.from({ length: width }, (_, i) => i) : [comp];
      const tracks = comps.map((i) => componentTrack(block.keyframes, i));
      if (tracks.some((t) => !t)) return { kind: "refused", reason: `${path}: keyframes on ${label} are not ${pk.kind} values.` };
      return { kind: "track", tracks: tracks as TimelineTrack[], from };
    }
    if (pk.kind === "color") {
      if (block.keyframes.some((k) => hexToTuple(k.value)[3] !== 1)) {
        return { kind: "refused", reason: `${path}: keyframes on ${label} carry alpha — translucent color keys don't export yet (animate an opacity instead).` };
      }
      const track: TimelineTrack = isChannel
        ? { kind: "color", colorSpace: block.colorSpace ?? "oklab", keys: block.keyframes.map((k) => toTimelineKey(k, "color")) }
        : // A color param stores hex: every sample snaps to 8 bits (colorValueToHex).
          { kind: "color", colorSpace: block.colorSpace ?? "oklab", quantize8: true, alpha: 1, keys: block.keyframes.map((k) => toTimelineKey(k, "color")) };
      return { kind: "track", tracks: [track], ...(comp === undefined ? {} : { pick: comp }), from: `${from}, ${track.colorSpace}` };
    }
    return { kind: "refused", reason: `${path} reads keyframed ${label} (${pk.label}) — only scalar, vector and color keyframes export.` };
  }

  // 3. A plain param: whatever the producer evaluated.
  return { kind: "plain", from: `static ${label}` };
}

function resolveBind(c: Ctx, fb: FoundBind): BindPlan | NeedsSample {
  const b = fb.bind;
  const deps = b.deps ?? [];
  if (deps.length) {
    const all = b.ref ? [...deps, b.ref] : deps;
    const missing = all.find((d) => !c.byId.has(d.node));
    if (missing) return { kind: "refused", reason: `${fb.path} depends on ${refLabel(missing)}, but node "${missing.node}" is not in the graph.` };
    const moving = all.filter((d) => refAnimates(c, d));
    const from = `derived from ${all.map(refLabel).join(", ")}`;
    return moving.length ? { kind: "needs-sample", from: `${from} (animated: ${moving.map(refLabel).join(", ")})` } : { kind: "static", value: b.v as BindValue, from };
  }
  if (b.ref) {
    const r = resolveRef(c, b.ref, fb.path);
    if (r.kind === "plain") return { kind: "static", value: b.v as BindValue, from: r.from };
    const scale = b.ref.scale;
    if (scale !== undefined && r.kind === "track") {
      if (r.tracks.some((t) => t.kind !== "scalar")) {
        return { kind: "refused", reason: `${fb.path} scales ${refLabel(b.ref)} — a scaled ref must be a scalar.` };
      }
      return { ...r, tracks: r.tracks.map((t) => ({ ...t, scale })), from: `${r.from} × ${scale}` };
    }
    return r;
  }
  if (/\.program\.uniforms\.iTime$/.test(fb.path)) return { kind: "clock", from: "master clock (seconds)" };
  return { kind: "static", value: b.v as BindValue, from: "static" };
}

// What a track plan evaluates to at `tick` (the emitted sampler's math).
export function evaluateTrackPlan(p: { tracks: TimelineTrack[]; pick?: number }, tick: number): number | number[] {
  if (p.tracks.length === 1) {
    const v = evaluateTrack(p.tracks[0], tick);
    return p.pick !== undefined && Array.isArray(v) ? v[p.pick] : v;
  }
  return p.tracks.map((t) => evaluateTrack(t, tick) as number);
}

// ---- the planner ----------------------------------------------------------------------

export function planSceneExport(
  scene: SkiaScene,
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: ScenePlanOptions
): ScenePlanResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const c: Ctx = { byId: new Map(nodes.map((n) => [n.id, n])), edges };
  const assetsUsed = new Map<string, AssetIR>();
  validateScene(scene, problems, assetsUsed);

  const tl = opts.timeline;
  const frames = Math.max(1, Math.ceil(tl.sceneDurationTicks / tl.ticksPerFrame) + 1);
  const found = collectBinds(scene.root);
  const resolutions = found.map((fb) => resolveBind(c, fb));

  // A resolved track whose value shape disagrees with the producer's `v`
  // can't be what the producer draws: let the sampler decide.
  resolutions.forEach((r, i) => {
    if (r.kind !== "track") return;
    const want = evaluateTrackPlan(r, 0);
    if (shapeOf(want) !== shapeOf(found[i].bind.v)) {
      warnings.push(`${found[i].path}: ${r.from} yields a ${shapeOf(want)} but the producer bound a ${shapeOf(found[i].bind.v)} — sampled instead.`);
      resolutions[i] = { kind: "needs-sample", from: r.from };
    }
  });

  const verify = !!opts.sampleAt && opts.verify !== false;
  const needsSample = resolutions.some((r) => r.kind === "needs-sample");
  let sampledFrames = 0;
  let samples: unknown[][] | null = null; // [bind][frame]
  let sampleFailed = false;

  if (needsSample && !opts.sampleAt) {
    resolutions.forEach((r, i) => {
      if (r.kind === "needs-sample") {
        resolutions[i] = { kind: "refused", reason: `${found[i].path} is ${r.from} — it needs a per-frame sampler (exportSkia supplies one).` };
      }
    });
  } else if (opts.sampleAt && (needsSample || verify) && !problems.length) {
    const ref = structureOf(scene);
    const refJson = JSON.stringify(ref);
    samples = found.map(() => new Array(frames));
    for (let f = 0; f < frames; f++) {
      const s = opts.sampleAt(f * tl.ticksPerFrame);
      if (!s) {
        problems.push(`Nothing reaches the canvas at frame ${f} — a scene that appears or disappears over time doesn't export yet.`);
        samples = null;
        sampleFailed = true;
        break;
      }
      const st = structureOf(s);
      if (JSON.stringify(st) !== refJson) {
        problems.push(`The scene's structure changes at frame ${f}: ${structuralDiff(ref, st, "scene")} — only bound values may animate in an export.`);
        samples = null;
        sampleFailed = true;
        break;
      }
      const at = new Map(collectBinds(s.root).map((fb) => [fb.path, fb.bind.v]));
      found.forEach((fb, i) => {
        samples![i][f] = at.get(fb.path);
      });
      sampledFrames = f + 1;
    }
  }

  const binds: PlannedBind[] = found.map((fb, i) => {
    const r = resolutions[i];
    const id = `b${i}`;
    const vals = samples?.[i];
    const sampled = (from: string): BindPlan => ({ kind: "sampled", values: vals as BindValue[], from: `${from}; sampled ${frames} frames` });
    let plan: BindPlan;
    if (r.kind === "needs-sample") {
      if (!vals) plan = { kind: "refused", reason: `${fb.path} is ${r.from} and could not be sampled${sampleFailed ? " (the scene's structure is not stable — above)" : ""}.` };
      else if (vals.every((v) => sameValue(v, vals[0]))) plan = { kind: "static", value: vals[0] as BindValue, from: `${r.from}; constant over the scene` };
      else plan = sampled(r.from);
    } else if (!vals) {
      plan = r;
    } else if (r.kind === "static") {
      if (vals.every((v) => sameValue(v, fb.bind.v))) plan = r;
      else {
        warnings.push(`${fb.path} changes over time but its tags (${r.from}) say static — sampled per frame; tag it with ref/deps in the producer.`);
        plan = sampled(`${r.from} (untagged animation)`);
      }
    } else if (r.kind === "track") {
      const bad = vals.findIndex((v, f) => !sameValue(evaluateTrackPlan(r, f * tl.ticksPerFrame), v));
      if (bad < 0) plan = r;
      else {
        warnings.push(`${fb.path}: ${r.from} does not reproduce the producer's value at frame ${bad} (a transformed param tagged as a plain ref?) — sampled instead.`);
        plan = sampled(r.from);
      }
    } else if (r.kind === "clock") {
      const bad = vals.findIndex((v, f) => !Object.is(v, (f * tl.ticksPerFrame) / (tl.ticksPerFrame * tl.fps)));
      if (bad < 0) plan = r;
      else {
        warnings.push(`${fb.path}: iTime is not the scene clock at frame ${bad} — sampled instead.`);
        plan = sampled("iTime");
      }
    } else plan = r;
    return { id, path: fb.path, role: fb.role, plan };
  });

  // (After a failed sampling run the one structure problem stands for every
  // derived bind it stranded.)
  for (const b of binds) {
    if (b.plan.kind === "refused" && !(sampleFailed && resolutions[Number(b.id.slice(1))].kind === "needs-sample")) problems.push(b.plan.reason);
  }
  const bindFor = new Map<Bind<unknown>, PlannedBind>();
  found.forEach((fb, i) => {
    if (!bindFor.has(fb.bind)) bindFor.set(fb.bind, binds[i]);
  });
  const sampledBytes = binds.reduce((n, b) => n + (b.plan.kind === "sampled" ? JSON.stringify(b.plan.values).length : 0), 0);
  if (sampledBytes > 2_000_000) {
    warnings.push(`Sampled values total ${(sampledBytes / 1e6).toFixed(1)} MB of JSON — consider tracks (keyframe the params directly) for the heavy binds.`);
  }

  const plan: ScenePlan = {
    name: opts.name,
    scene,
    canvas: { width: scene.width, height: scene.height },
    timeline: { fps: tl.fps, ticksPerFrame: tl.ticksPerFrame, durationTicks: tl.sceneDurationTicks, frames },
    binds,
    bindFor,
    assets: [...assetsUsed.values()],
    sampledFrames,
    warnings,
  };
  return { plan: problems.length ? null : plan, problems, binds };
}
