// planSceneExport — resolve every Bind in a Skia scene (scene-ir.ts) into
// something React Native Skia can replay exactly (specdocs/101326_skia-target.md
// §3.4, §3.5a): a static value, a timeline track, a compiled procedural
// driver (§3.5e), a per-frame sampled series, the master clock, or a
// refusal with a reason.
//
//   ref → keyframed param   track (the M0 keyframe → TimelineKey conversion)
//   ref → wired param       follow the wire to a driver exactly as
//                           planSkiaExport does (Animated Value / Constant /
//                           Color → track / static; a procedural driver —
//                           Expression, LFO, Math, Scene Time, Random — →
//                           expr, a compiled program of the tick, or sampled
//                           when only the compiler can't express it); any
//                           other driver refuses
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
import { LAYER_OPACITY_PREFIX } from "@/engine/conventions";
import type { Keyframe } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import {
  SKIA_IR_VERSION,
  type AssetIR,
  type Bind,
  type BindRef,
  type ImageFilterIR,
  type PaintIR,
  type PathEffectIR,
  type ShaderIR,
  type SkiaNode,
  type SkiaScene,
  type SkslProgramIR,
} from "@/engine/skia/scene-ir";
import {
  channelKeyTrack,
  hexToTuple,
  liveBlock,
  resolveDriver,
  toTimelineKey,
  type DriverBinding,
} from "./drivers";
import { evaluateTrack, type TimelineKey, type TimelineTrack } from "./runtime/toolbox-timeline";
import type { SkiaExportAssets } from "./api";
import { assetWarnings, type AssetUse } from "./asset-bundle";
import { compileDriver, PROCEDURAL_DRIVER_TYPES } from "./procedural/compile";
import { evaluateProgram, type ProcProgram } from "./procedural/ir";
import { timelineSpringOf } from "./spring";

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
  // A procedural driver subgraph (Expression / LFO / Math / Scene Time /
  // Random / Constant / Animated Value) compiled to a scalar program of the
  // tick (procedural/, spec §3.5e) — a worklet in sampleBinds, SkSL when
  // baked; `scale` is a BindRef scale applied after it. Additive
  // (2026-10-14, Wave 3 lane P).
  | { kind: "expr"; program: ProcProgram; scale?: number; from: string }
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
  // The same with the drawings that use them (additive, Wave 3 lane I),
  // and the resolved bytes the emitter bundles (SkiaExportRequest.assets).
  assetUses?: AssetUse[];
  assetBytes?: SkiaExportAssets;
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
  // Asset bytes resolved before the export (SkiaExportRequest.assets).
  assets?: SkiaExportAssets;
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
  // The nearest enclosing SkiaNode's `id` — the engine node that produced
  // the value (resolves `deps: []`, "derived from my inputs").
  owner?: string;
}

// Every Bind under the root, depth-first in key order (the emitter walks the
// same tree and looks binds up by path, so order only names the ids).
export function collectBinds(root: SkiaNode): FoundBind[] {
  const out: FoundBind[] = [];
  const visit = (x: unknown, path: string, parentK: string | undefined, key: string, owner: string | undefined) => {
    if (isBind(x)) {
      const v = x.v;
      const role: BindRole =
        typeof v === "string" ? (parentK === "path" && key === "d" ? "path" : "string") : Array.isArray(v) ? "array" : "number";
      out.push({ path, bind: x, role, ...(owner ? { owner } : {}) });
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((c, i) => visit(c, `${path}.${i}`, parentK, String(i), owner));
      return;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const k = typeof o.k === "string" ? o.k : parentK;
      // Only SkiaNodes carry an `id` next to their `k`.
      const own = typeof o.k === "string" && typeof o.id === "string" ? o.id : owner;
      for (const [kk, c] of Object.entries(o)) visit(c, `${path}.${kk}`, k, kk, own);
    }
  };
  visit(root, "root", undefined, "root", undefined);
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

// Equal up to float rounding (relative 1e-12).
export function closeValue(a: unknown, b: unknown): boolean {
  const close = (x: unknown, y: unknown) =>
    typeof x === "number" && typeof y === "number" ? Object.is(x, y) || Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x), Math.abs(y)) : Object.is(x, y);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  return close(a, b);
}

function shapeOf(v: unknown): "number" | "array" | "string" | "other" {
  return typeof v === "number" ? "number" : typeof v === "string" ? "string" : Array.isArray(v) ? "array" : "other";
}

// ---- structural validation (what the emitter cannot express) ----------------------

// What a program declares: its non-shader uniforms and its child shaders,
// in declaration order (comments stripped; good enough for the fuser's and
// the SkSL node's output — CanvasKit is the real judge, in the gates).
export function skslDeclarations(sksl: string): { uniforms: string[]; children: string[] } {
  const code = sksl.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const uniforms: string[] = [];
  const children: string[] = [];
  const re = /\buniform\s+(?:layout\s*\([^)]*\)\s+)?(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g;
  for (let m = re.exec(code); m; m = re.exec(code)) (m[1] === "shader" ? children : uniforms).push(m[2]);
  return { uniforms, children };
}

function validateScene(
  scene: SkiaScene,
  problems: string[],
  warnings: string[],
  assetsUsed: Map<string, AssetIR>,
  // Asset id → the drawings (SkiaNode ids) that use it.
  assetOwners: Map<string, Set<string>> = new Map()
) {
  if (scene.version !== SKIA_IR_VERSION) problems.push(`Scene IR version ${scene.version} — this exporter reads version ${SKIA_IR_VERSION}.`);
  // The innermost SkiaNode with an id being visited (an asset's owner).
  let drawId: string | undefined;
  // React Native Skia throws on a declared uniform without a value and binds
  // children by position.
  const program = (p: SkslProgramIR, where: string, content?: string) => {
    const d = skslDeclarations(p.sksl);
    const missing = d.uniforms.filter((u) => !(u in p.uniforms));
    if (missing.length) problems.push(`${where}: the program declares uniform${missing.length > 1 ? "s" : ""} ${missing.join(", ")} with no bind — React Native Skia throws on a missing uniform.`);
    const want = content !== undefined ? [content] : p.children.map((c) => c.name);
    if (d.children.join() !== want.join()) {
      problems.push(`${where}: the program declares child shaders (${d.children.join(", ") || "none"}) but binds (${want.join(", ") || "none"}) — React Native Skia binds children by position.`);
    }
  };
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
    if (drawId) {
      const set = assetOwners.get(id) ?? new Set<string>();
      set.add(drawId);
      assetOwners.set(id, set);
    }
  };
  const shader = (s: ShaderIR, where: string) => {
    if (s.k === "runtime") {
      program(s.program, where);
      for (const c of s.program.children) shader(c.shader, `${where} child ${c.name}`);
    }
    if (s.k === "image") noteAsset(s.asset, ["image"], where);
  };
  const imageFilter = (f: ImageFilterIR, where: string) => {
    if (f.k === "displacement") shader(f.map, `${where} displacement map`);
    if (f.k === "runtime") {
      if (f.program.children.length) {
        problems.push(`${where}: a RuntimeShader image filter reads only the rendered content — extra child shaders (${f.program.children.map((c) => c.name).join(", ")}) don't export (React Native Skia binds the content as the program's only child).`);
      } else program(f.program, where, f.content);
      warnings.push(`${where}: a runtime image filter (<RuntimeShader>) is not playable on React Native Skia web — CanvasKit has no factory for it; native only.`);
    }
  };
  const paint = (p: PaintIR, where: string) => {
    if (p.shader) shader(p.shader, where);
    const effects = (p.pathEffects ?? []).filter((e: PathEffectIR) => e.k !== "trim");
    if (effects.length > 1) {
      warnings.push(`${where}: ${effects.length} composed path effects (${effects.map((e) => e.k).join(" → ")}) are not playable on React Native Skia web — CanvasKit can't compose path effects; native only.`);
    }
  };
  const visit = (n: SkiaNode, path: string) => {
    const outer = drawId;
    if (n && typeof n.id === "string") drawId = n.id;
    try {
      visitNode(n, path);
    } finally {
      drawId = outer;
    }
  };
  const visitNode = (n: SkiaNode, path: string) => {
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
        paint(n.paint, where);
        return;
      case "image":
        noteAsset(n.asset, ["image"], where);
        return;
      case "text": {
        noteAsset(n.font.asset, ["font"], where);
        paint(n.paint, where);
        // With a width it ships as <Paragraph>, whose run takes one
        // foreground paint built from the color and opacity.
        const p = n.paint;
        const extra = [
          p.style === "stroke" && "stroke style",
          p.shader && "a shader",
          p.maskFilter && "a mask filter",
          p.colorFilters?.length && "color filters",
          p.pathEffects?.length && "path effects",
          p.blendMode && p.blendMode !== "srcOver" && "a blend mode",
        ].filter(Boolean);
        if (n.width && extra.length) {
          problems.push(`${where}: text with a width exports as a Paragraph, which takes the paint's color and opacity only — not ${extra.join(", ")}.`);
        }
        return;
      }
      case "atlas":
        if (n.texture) {
          // A sub-scene sprite sheet (RN useTexture): its programs and
          // assets ship like the rest of the scene; its binds must be
          // static (checked once the binds are planned).
          const r = n.texture.rect;
          if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v)) || r[2] <= 0 || r[3] <= 0) {
            problems.push(`${where}: the sprite sheet's rect must be 4 finite numbers with a positive size.`);
          }
          visit(n.texture.node, `${path}.texture.node`);
        } else noteAsset(n.asset, ["image"], where);
        if (Array.isArray(n.xforms.v) && n.xforms.v.length !== n.sprites.length * 4) {
          problems.push(`${where}: ${n.sprites.length} sprites need ${n.sprites.length * 4} xform floats, got ${n.xforms.v.length}.`);
        }
        if ((n.rotate || n.scale) && !(Array.isArray(n.pivots?.v) && n.pivots.v.length === n.sprites.length * 2)) {
          problems.push(`${where}: a sprite spin / zoom needs ${n.sprites.length * 2} pivot floats.`);
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
  // Notes the resolution leaves for the export (wire-over-keyframes…).
  warnings: string[];
  // The export clock procedural drivers compile against.
  timeline: { fps: number; ticksPerFrame: number };
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

// Could anything feeding `nodeId` (itself included) change over the scene?
// For `deps: []` — a value derived from the producer's INPUTS (Skia Shape's
// path from its spline wire), which a compute can't name.
function upstreamAnimates(c: Ctx, nodeId: string): string | null {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = c.byId.get(id);
    if (!n) continue;
    const def = getNodeDef(n.type);
    if (Object.keys(n.animation ?? {}).some((k) => liveBlock(n, k))) return `${id} is keyframed`;
    if (n.clips?.some((cl) => cl.enabled)) return `${id} sits on a clip window`;
    if (def?.tickDriven || def?.stable === false) return `${id} (${n.type}) is time-driven`;
    for (const e of c.edges) if (e.target === id) stack.push(e.source);
  }
  return null;
}

type ParamKind = "scalar" | "vec2" | "vec3" | "vec4" | "color" | "boolean" | "enum" | "other";

function paramKindOf(
  node: GraphNode,
  param: string
): { kind: ParamKind; alpha: boolean; label: string; options?: string[]; row?: ExprInput } {
  if (param.startsWith("ch:")) {
    const row = channelRow(node, param.slice(3));
    const k = row ? channelKind(row) : "other";
    const kind: ParamKind = k === "scalar" || k === "color" ? k : k === "toggle" ? "boolean" : k === "enum" ? "enum" : "other";
    return { kind, alpha: true, label: row ? k : "missing", ...(row ? { row } : {}) };
  }
  // A Merge-style layer's opacity (engine/conventions.ts LAYER_OPACITY_PREFIX)
  // is a scalar keyframed under its own virtual key; Skia Merge binds to it.
  // Added 2026-10-13 by Wave 2 family 6 (merge & blend).
  if (param.startsWith(LAYER_OPACITY_PREFIX) && getNodeDef(node.type)?.params.some((p) => p.type === "merge_layers")) {
    return { kind: "scalar", alpha: false, label: "scalar" };
  }
  const pdef = getNodeDef(node.type)?.params.find((p) => p.name === param);
  if (pdef) {
    const t = pdef.type;
    const kind: ParamKind =
      t === "scalar" || t === "vec2" || t === "vec3" || t === "vec4" || t === "color" || t === "boolean" || t === "enum" ? t : "other";
    return { kind, alpha: !!pdef.alpha, label: t, ...(pdef.options ? { options: pdef.options } : {}) };
  }
  // No registered def (a fixture, a type from a newer build): infer from
  // the stored value.
  const v = node.params[param];
  if (typeof v === "number") return { kind: "scalar", alpha: false, label: "scalar" };
  if (typeof v === "boolean") return { kind: "boolean", alpha: false, label: "boolean" };
  if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) return { kind: "color", alpha: false, label: "color" };
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === "number")) {
    const kind = (["vec2", "vec3", "vec4"] as const)[v.length - 2];
    return { kind, alpha: false, label: kind };
  }
  return { kind: "other", alpha: false, label: typeof v };
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
    if (k.easingOut === "spring") key.spring = timelineSpringOf(k.spring);
    out.push(key);
  }
  return { kind: "scalar", keys: out };
}

function resolveRef(c: Ctx, r: BindRef, path: string): BindPlan | Plain | NeedsSample {
  const node = c.byId.get(r.node);
  const label = refLabel(r);
  if (!node) return { kind: "refused", reason: `${path} reads ${label}, but node "${r.node}" is not in the graph.` };
  if (node.clips?.some((cl) => cl.enabled)) {
    return { kind: "refused", reason: `${path} reads ${label}, which sits on a clip window — retimed values don't export yet.` };
  }
  // (A layer's clip offset is fine: the interior's keys are on the layer's
  // local clock, which is the clock the export plays from 0.)
  const isChannel = r.param.startsWith("ch:");
  const pk = paramKindOf(node, r.param);
  if (isChannel && pk.label === "missing") {
    return { kind: "refused", reason: `${path} reads channel "${r.param.slice(3)}", which node "${r.node}" does not have.` };
  }
  const comp = r.component;
  const isVec = pk.kind === "vec2" || pk.kind === "vec3" || pk.kind === "vec4";
  const block = liveBlock(node, r.param);

  // 1. Wire > keyframes > constant.
  const edge = wireInto(c, node, r.param);
  if (edge) {
    if (block) c.warnings.push(`${path}: ${label} is wired — its own keyframes are ignored (wire > keyframes), in the editor and in this export.`);
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
      tail: "only Animated Value (scalar), Constant (scalar), Color (color) and the procedural drivers (Expression, LFO, Math, Scene Time, Random) drive an exported Skia value.",
    });
    if (!res.binding && driverKind === "scalar" && PROCEDURAL_DRIVER_TYPES.has(src.type)) {
      // A procedural driver (spec §3.5e): compiled to a program of the tick.
      // When only the compiler can't express it (unsupported syntax, an
      // option it doesn't lower) and every node upstream is a deterministic
      // driver, the scene falls back to sampling the producer per frame.
      const socket = isVec ? pk.kind : "scalar";
      const cr = compileDriver(edge, c.byId, c.edges, c.timeline, isVec ? { socket: socket as "vec2" | "vec3" | "vec4", component: comp } : { socket: "scalar" });
      if (cr.ok) {
        c.warnings.push(...cr.warnings.map((w) => `${path}: ${w}`));
        return { kind: "expr", program: cr.program, from: `${label} ← ${cr.from}` };
      }
      if (cr.sampleable) {
        c.warnings.push(`${path} (${label}) is driven by ${src.type} "${src.id}", which doesn't compile to a worklet: ${cr.reason} — sampled per frame instead.`);
        return { kind: "needs-sample", from: `${label} ← ${src.type} ${src.id} (not compiled: ${cr.reason})` };
      }
      return { kind: "refused", reason: `${path} (${label}) is driven by ${src.type} "${src.id}", which doesn't export: ${cr.reason}.` };
    }
    if (res.problems.length || !res.binding) return { kind: "refused", reason: res.problems.join(" ") };
    return bindingToPlan(res.binding, pk.kind === "color" ? comp : undefined);
  }

  // 2. Keyframes on the node itself.
  if (block) {
    const def = getNodeDef(node.type);
    const clock = def?.clockInput;
    if (clock && c.edges.some((e) => e.target === node.id && e.targetHandle === `in:${clock.input}`)) {
      return { kind: "refused", reason: `${path} reads ${label}, whose keyframes sample at a wired clock (${clock.input}) — only playhead-driven keyframes export.` };
    }
    const n = block.keyframes.length;
    const from = `keyframes ${node.id}.${r.param} (${n} keys)`;
    if (isChannel && pk.row) {
      // Lane L4's channel keyframes (`ch:<name>` on the node itself).
      const problems: string[] = [];
      const track = channelKeyTrack(pk.row, block, problems);
      if (!track) return { kind: "refused", reason: `${path}: ${problems.join(" ")}` };
      return {
        kind: "track",
        tracks: [track],
        ...(comp === undefined || track.kind !== "color" ? {} : { pick: comp }),
        from: `channel keyframes ${node.id}.${r.param} (${n} keys${track.kind === "color" ? `, ${track.colorSpace}` : ""})`,
      };
    }
    if (pk.kind === "scalar") {
      if (block.keyframes.some((k) => typeof k.value !== "number")) {
        return { kind: "refused", reason: `${path}: keyframes on ${label} hold non-numbers.` };
      }
      return { kind: "track", tracks: [{ kind: "scalar", keys: block.keyframes.map((k) => toTimelineKey(k, "scalar")) }], from };
    }
    if (pk.kind === "boolean" || pk.kind === "enum") {
      // Step-only params snap (keyframes.ts isStepOnly); the producer binds
      // the number it uploads: 0 | 1, or the option index (define-node.ts).
      const num = (v: unknown) =>
        pk.kind === "boolean" ? (v === true || (typeof v === "number" && v !== 0) ? 1 : 0) : Math.max(0, (pk.options ?? []).indexOf(String(v)));
      return {
        kind: "track",
        tracks: [{ kind: "scalar", keys: block.keyframes.map((k) => ({ tick: k.tick, value: num(k.value), easing: "hold" })) }],
        from: `${from}, stepped`,
      };
    }
    if (isVec) {
      const width = Number(pk.kind.slice(3));
      const comps = comp === undefined ? Array.from({ length: width }, (_, i) => i) : [comp];
      const tracks = comps.map((i) => componentTrack(block.keyframes, i));
      if (tracks.some((t) => !t)) return { kind: "refused", reason: `${path}: keyframes on ${label} are not ${pk.kind} values.` };
      return { kind: "track", tracks: tracks as TimelineTrack[], from };
    }
    if (pk.kind === "color") {
      // A color param stores hex: every sample snaps to 8 bits
      // (colorValueToHex). Its alpha byte survives only on ParamDef.alpha
      // params — exactly what quantizeAlpha replays; elsewhere a translucent
      // key keeps its alpha AT the key and loses it between keys, which no
      // track reproduces.
      const translucent = block.keyframes.some((k) => hexToTuple(k.value)[3] !== 1);
      if (translucent && !pk.alpha) {
        return { kind: "refused", reason: `${path}: keyframes on ${label} carry alpha, which this param drops between keys — make the keys opaque (or animate an opacity).` };
      }
      const keys = block.keyframes.map((k) => toTimelineKey(k, "color"));
      const track: TimelineTrack = pk.alpha
        ? { kind: "color", colorSpace: block.colorSpace ?? "oklab", quantize8: true, quantizeAlpha: true, keys }
        : { kind: "color", colorSpace: block.colorSpace ?? "oklab", quantize8: true, alpha: 1, keys };
      return { kind: "track", tracks: [track], ...(comp === undefined ? {} : { pick: comp }), from: `${from}, ${track.colorSpace}` };
    }
    return { kind: "refused", reason: `${path} reads keyframed ${label} (${pk.label}) — only scalar, vector, color, boolean and enum keyframes export.` };
  }

  // 3. A plain param: whatever the producer evaluated.
  return { kind: "plain", from: `static ${label}` };
}

function resolveBind(c: Ctx, fb: FoundBind, sampler: boolean): BindPlan | NeedsSample {
  const b = fb.bind;
  const deps = b.deps;
  if (deps && !deps.length && !b.ref) {
    // `deps: []`: derived from the producer's inputs (a compute can't see
    // the graph) — resolve the producer from the tree and walk its wires.
    if (!fb.owner || !c.byId.has(fb.owner)) {
      return sampler
        ? { kind: "needs-sample", from: "derived from an unnamed producer's inputs" }
        : { kind: "refused", reason: `${fb.path} is derived from its producer's inputs, but the tree names no producer node (id) — it needs the per-frame sampler.` };
    }
    const why = upstreamAnimates(c, fb.owner);
    const from = `derived from ${fb.owner}'s inputs`;
    if (!why) return { kind: "static", value: b.v as BindValue, from };
    return sampler
      ? { kind: "needs-sample", from: `${from} (${why})` }
      : { kind: "refused", reason: `${fb.path} is ${from}, and ${why} — it needs a per-frame sampler (exportSkia supplies one).` };
  }
  if (deps?.length) {
    const all = b.ref ? [...deps, b.ref] : deps;
    const missing = all.find((d) => !c.byId.has(d.node));
    if (missing) return { kind: "refused", reason: `${fb.path} depends on ${refLabel(missing)}, but node "${missing.node}" is not in the graph.` };
    const moving = all.filter((d) => refAnimates(c, d));
    const from = `derived from ${all.map(refLabel).join(", ")}`;
    if (!moving.length) return { kind: "static", value: b.v as BindValue, from };
    return sampler
      ? { kind: "needs-sample", from: `${from} (animated: ${moving.map(refLabel).join(", ")})` }
      : { kind: "refused", reason: `${fb.path} is ${from} (animated: ${moving.map(refLabel).join(", ")}) — it needs a per-frame sampler (exportSkia supplies one).` };
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
    if (scale !== undefined && r.kind === "expr") return { ...r, scale, from: `${r.from} × ${scale}` };
    return r;
  }
  if (/\.program\.uniforms\.iTime$/.test(fb.path)) return { kind: "clock", from: "master clock (seconds)" };
  return { kind: "static", value: b.v as BindValue, from: "static" };
}

// What a track plan evaluates to at `tick` (the emitted sampler's math;
// the runtime applies a track's scale and quantizeAlpha).
// …and what an expr plan evaluates to (the interpreter performs the emitted
// worklet's JS operations in its order; a BindRef scale multiplies after).
export function evaluateExprPlan(p: { program: ProcProgram; scale?: number }, tick: number): number {
  const v = evaluateProgram(p.program, tick);
  return p.scale === undefined ? v : v * p.scale;
}

export function evaluateTrackPlan(p: { tracks: TimelineTrack[]; pick?: number }, tick: number): number | number[] {
  if (p.tracks.length === 1) {
    const v = evaluateTrack(p.tracks[0], tick);
    return p.pick !== undefined && Array.isArray(v) ? v[p.pick] : v;
  }
  return p.tracks.map((t) => evaluateTrack(t, tick) as number);
}

// ---- the planner ----------------------------------------------------------------------

// The runtime program owning a `….program.uniforms.iTime` bind path, and
// whether its source uses iTime beyond the `uniform float iTime;` line.
function programReadsTime(scene: SkiaScene, path: string): boolean {
  const programPath = path.replace(/\.uniforms\.iTime$/, "").split(".");
  let at: unknown = scene;
  for (const key of programPath) {
    if (at == null || typeof at !== "object") return true;
    at = (at as Record<string, unknown>)[key];
  }
  const sksl = (at as { sksl?: unknown } | undefined)?.sksl;
  if (typeof sksl !== "string") return true;
  return /\biTime\b/.test(sksl.replace(/uniform\s+float\s+iTime\s*;/g, ""));
}

export function planSceneExport(
  scene: SkiaScene,
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: ScenePlanOptions
): ScenePlanResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const c: Ctx = { byId: new Map(nodes.map((n) => [n.id, n])), edges, warnings, timeline: { fps: opts.timeline.fps, ticksPerFrame: opts.timeline.ticksPerFrame } };
  const assetsUsed = new Map<string, AssetIR>();
  const assetOwners = new Map<string, Set<string>>();
  validateScene(scene, problems, warnings, assetsUsed, assetOwners);
  const assetUses: AssetUse[] = [...assetsUsed.values()].map((a) => ({
    asset: a,
    owners: [...(assetOwners.get(a.id) ?? [])].map((id) => {
      const t = c.byId.get(id)?.type;
      return t ? `${t} "${id}"` : `"${id}"`;
    }),
  }));
  warnings.push(...assetWarnings(assetUses, opts.assets));

  const tl = opts.timeline;
  const frames = Math.max(1, Math.ceil(tl.sceneDurationTicks / tl.ticksPerFrame) + 1);
  const found = collectBinds(scene.root);
  const resolutions = found.map((fb) => resolveBind(c, fb, !!opts.sampleAt));

  // A resolved track whose value shape disagrees with the producer's `v`
  // can't be what the producer draws: let the sampler decide.
  resolutions.forEach((r, i) => {
    if (r.kind !== "track" && r.kind !== "expr") return;
    const want = r.kind === "track" ? evaluateTrackPlan(r, 0) : evaluateExprPlan(r, 0);
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
      // A scaled track (BindRef.scale) multiplies after evaluation; the
      // producer may have rounded `(deg * π) / 180` instead of
      // `deg * (π / 180)` — equal within a few ulps, never bit for bit.
      const eq = r.tracks.some((t) => t.scale !== undefined) ? closeValue : sameValue;
      const bad = vals.findIndex((v, f) => !eq(evaluateTrackPlan(r, f * tl.ticksPerFrame), v));
      if (bad < 0) plan = r;
      else {
        warnings.push(`${fb.path}: ${r.from} does not reproduce the producer's value at frame ${bad} (a transformed param tagged as a plain ref?) — sampled instead.`);
        plan = sampled(r.from);
      }
    } else if (r.kind === "expr") {
      // The compiled driver must reproduce the producer at every frame — bit
      // for bit (within float rounding when a BindRef scale multiplies).
      const eq = r.scale !== undefined ? closeValue : sameValue;
      const bad = vals.findIndex((v, f) => !eq(evaluateExprPlan(r, f * tl.ticksPerFrame), v));
      if (bad < 0) plan = r;
      else {
        warnings.push(`${fb.path}: ${r.from} does not reproduce the producer's value at frame ${bad} — sampled instead.`);
        plan = sampled(r.from);
      }
    } else if (r.kind === "clock") {
      const bad = vals.findIndex((v, f) => !Object.is(v, (f * tl.ticksPerFrame) / (tl.ticksPerFrame * tl.fps)));
      // A program that only DECLARES iTime (every fused program does) can't
      // show the difference: its producer may have cached frame 0's value
      // because nothing upstream moves. Drive it from the clock, no warning.
      if (bad < 0 || !programReadsTime(scene, fb.path)) plan = r;
      else {
        warnings.push(`${fb.path}: iTime is not the scene clock at frame ${bad} — sampled instead.`);
        plan = sampled("iTime");
      }
    } else plan = r;
    return { id, path: fb.path, role: fb.role, plan };
  });

  // An atlas sprite sheet drawn from a sub-scene renders ONCE (RN
  // useTexture): nothing inside it may animate. (Lane A, 2026-10-14.)
  const sheetMoves = binds.filter((b) => /\.texture\.node(\.|$)/.test(b.path) && b.plan.kind !== "static" && b.plan.kind !== "refused");
  if (sheetMoves.length) {
    const first = sheetMoves[0];
    let at: unknown = { root: scene.root };
    for (const key of first.path.split(".texture.node")[0].split(".")) at = (at as Record<string, unknown> | undefined)?.[key];
    const id = (at as { id?: unknown } | undefined)?.id;
    const owner = typeof id === "string" ? id : undefined;
    problems.push(
      `${first.path} animates (${(first.plan as { from?: string }).from ?? first.plan.kind})${sheetMoves.length > 1 ? ` (+${sheetMoves.length - 1} more)` : ""}, but it sits in an atlas sprite sheet${owner ? ` drawn by ${owner}` : ""}, which renders once — set that Copy to Points (Skia) strategy to groups to animate the instance.`
    );
  }

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
    assetUses,
    ...(opts.assets ? { assetBytes: opts.assets } : {}),
    sampledFrames,
    warnings,
  };
  return { plan: problems.length ? null : plan, problems, binds };
}
