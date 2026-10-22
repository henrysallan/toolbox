// planAeExport — the exportability analysis (spec 091926_after-effects-handoff.md
// §6, Design B). Given a composition's layers as GroupSpec-shaped scopes plus
// registry lookups, decide per node which rung of the §3 ladder it lands on,
// partition each layer into segments (one shape layer, an effect chain, a
// shader region, a bake…), score fidelity, and route the whole composition:
// direct / direct+bake / direct+shader / blocked.
//
// Pure like planTranslation (src/lib/glsl-translation/plan.ts): no engine, no
// registry, no React. lib/ae-export/editor.ts builds the input from editor
// state; scripts/ae-export/check-plan.mts builds it from fixtures. The same
// input always yields byte-identical JSON — "the plan said X" stays a
// debuggable claim.
//
// Order of the passes, per layer:
//   1. reach      every node upstream of the Layer Output (value wires too)
//   2. classify   the class table, refined by params and the policy
//   3. bakes      bake / live seeds, consumers first; each absorbs its
//                 exclusive upstream (a bake renders everything feeding it)
//   4. shaders    approx single-pass effects fed by a shader node fuse into it
//                 (the host is already required); then each remaining shader node,
//                 consumers first, is one planTranslation target — its region
//                 is the AE shader region. No host → step 3 bakes them.
//   5. segments   class transitions along the main input; regions are atomic
//   6. scoring    easing, color, gradients, widths, instances, anchors,
//                 fonts, pivots → notes / approximations / warnings
// then the composition: route, estimates, warnings.

import { translationEntry, type TranslationEntry } from "@/lib/glsl-translation/classes";
import {
  parseEndpoint,
  planTranslation,
  type PlanEdge,
  type PlanNode,
  type PlanNodeInfo,
  type TranslationPlan,
} from "@/lib/glsl-translation/plan";
import {
  AE_MISSING_BLEND_MODES,
  aeBlendModeOf,
  aeExportEntry,
  isAeClassified,
  isGlslFusable,
  SDF_CHAIN_TYPES,
} from "./classes";
import { punchesHoles, rasterizeBakeReason } from "./rasterize-rules";
import { SDF_NATIVE_CONSUMERS, sdfChainVerdict, type SdfChainGraph } from "./sdf-chain";
import { planScene3d, scene3dEntry } from "./three-plan";
import {
  DEFAULT_AE_POLICY,
  TBX_SHADER_MATCH_NAME,
  type AeBakeCodec,
  type AeBakeItem,
  type AeBlocker,
  type AeExportClass,
  type AeExportEntry,
  type AeExportPlan,
  type AeExportPolicy,
  type AeExpressionItem,
  type AeLayerKind,
  type AePlanLayer,
  type AePlanNode,
  type AePlanWindow,
  type AeRequirement,
  type AeSegment,
  type AeSegmentKind,
  type AeShaderRegion,
} from "./types";

export type { PlanEdge, PlanNode, PlanNodeInfo } from "@/lib/glsl-translation/plan";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// One animated track of a node: a param or a virtual key (ramp_c:<param>:<stop>,
// anchor_p:<id>, layer_opacity:<id>, gpoint_c:<id>…).
export interface AePlanTrack {
  param: string;
  // Keyframe frames on the layer's clock, ascending.
  frames: number[];
  // Outgoing easing per key (EasingPreset names); the last key's is unused.
  easings: string[];
  // Param type ("scalar", "color", "vec2", "spline_anchors"…) when known.
  type?: string;
  // Color tracks: the interpolation space (toolbox default "oklab").
  colorSpace?: "oklab" | "rgb";
}

// One toolbox layer — its interior as one scope (nested groups flattened in,
// zone members carrying `parent`), the endpoint its Layer Output shows, and
// the layer's own compositing facts.
export interface AePlanLayerInput {
  id: string;
  name: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  // "<id>:out" | "<id>:aux:<name>" wired into the Layer Output image. Absent:
  // the layer shows nothing.
  output?: string;
  blendMode?: string;
  opacity?: number;
  // The layer node's own animated params (opacity, TRS).
  keyframed?: string[];
  // Enabled clip windows in composition frames; absent = the whole comp.
  windows?: AePlanWindow[];
  // Parent layer id (AE parenting).
  parent?: string;
}

export interface AePlanInput {
  composition: AeExportPlan["composition"];
  // Bottom → top (the stack order; AE layer index runs the other way).
  layers: AePlanLayerInput[];
  infoOf: (id: string) => PlanNodeInfo | undefined;
  // Full current params (defaults included).
  valuesOf: (id: string) => Record<string, unknown>;
  tracksOf?: (id: string) => AePlanTrack[];
  // Evaluated element count at an endpoint (points, subpaths), when the host
  // has one — sharpens the layer-budget check. Fixtures estimate from params.
  countOf?: (endpoint: string) => number | undefined;
  policy?: Partial<AeExportPolicy>;
  classOf?: (type: string) => AeExportEntry;
  // Playhead frame handed to planTranslation (its static-graph frame).
  frame?: number;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// §4.2, per EasingPreset: how one toolbox segment exports under each policy.
//   exact     one AE segment, no error
//   fit       Editable: one best-fit cubic (max error %); Exact: `exactKeys`
//   keys      extra interior keys under both policies (error % if not exact)
//   frames    per-frame keys (exact at frames, not graph-editable)
interface EasingRule {
  editable: { kind: "exact" | "fit" | "keys" | "frames"; err?: number; keys?: number };
  exact: { kind: "exact" | "keys" | "frames"; keys?: number };
}
const EXACT: EasingRule = { editable: { kind: "exact" }, exact: { kind: "exact" } };
const EASING: Record<string, EasingRule> = {
  linear: EXACT,
  hold: EXACT,
  customBezier: EXACT,
  cubicBezier: EXACT,
  easeInQuad: EXACT,
  easeOutQuad: EXACT,
  easeIn: EXACT,
  easeOut: EXACT,
  easeInCubic: EXACT,
  easeOutCubic: EXACT,
  // The exact back cubics (§4.2, App. A) — the editor's table lacks them.
  easeInBack: EXACT,
  easeOutBack: EXACT,
  easeInOutQuad: { editable: { kind: "fit", err: 0.37 }, exact: { kind: "keys", keys: 1 } },
  easeInOut: { editable: { kind: "fit", err: 0.37 }, exact: { kind: "keys", keys: 1 } },
  easeInOutCubic: { editable: { kind: "fit", err: 0.27 }, exact: { kind: "keys", keys: 1 } },
  easeInSine: { editable: { kind: "fit", err: 0.13 }, exact: { kind: "frames" } },
  easeOutSine: { editable: { kind: "fit", err: 0.05 }, exact: { kind: "frames" } },
  easeInOutSine: { editable: { kind: "fit", err: 0.25 }, exact: { kind: "frames" } },
  easeInExpo: { editable: { kind: "fit", err: 0.09 }, exact: { kind: "frames" } },
  easeOutExpo: { editable: { kind: "fit", err: 0.1 }, exact: { kind: "frames" } },
  // Bounce is exact as 5 keys; elastic fits 8 keys within 0.61% (§4.2).
  easeOutBounce: { editable: { kind: "keys", keys: 3 }, exact: { kind: "keys", keys: 3 } },
  easeOutElastic: { editable: { kind: "keys", keys: 6, err: 0.61 }, exact: { kind: "frames" } },
  // No cubic follows an oscillating spring: per-frame keys either way.
  spring: { editable: { kind: "frames" }, exact: { kind: "frames" } },
};

// Dense RGB keys an OKLab tween needs per segment to stay within 2/255 —
// the §4.3 worst measured case (red→blue 63); an upper bound for estimates.
const DENSE_COLOR_KEYS_PER_SEGMENT = 63;

// Bits per pixel per frame, for the footage estimate. ProRes 4444 ≈ 330 Mb/s
// at 1080p29.97 (5.3 bpp) plus alpha; QuickTime Animation is lossless RLE and
// content-dependent — half of raw RGBA is the planning number.
const BAKE_BITS_PER_PIXEL: Record<AeBakeCodec, number> = { prores4444: 6, qtrle: 16 };

// Socket types that carry values (expression drivers), not pictures.
const VALUE_SOCKETS: ReadonlySet<string> = new Set([
  "scalar",
  "vec2",
  "vec3",
  "vec4",
  "color",
  "string",
  "list",
  "float_curve",
  "color_ramp",
  "scalar_field",
]);

// Point sources whose params say how many instances they make.
const INSTANCE_PASSTHROUGH: ReadonlySet<string> = new Set([
  "attribute-blur",
  "attribute-math",
  "attribute-transfer",
  "map-attribute",
  "modulate-points",
  "sample-texture-at-points",
  "set-named-attribute",
  "stagger",
  "relax",
  "filter-points",
  "point-expression",
]);

const NATIVE_PREFIX = "__ae_native__:";
const NATIVE_ENTRY: TranslationEntry = {
  class: "opaque",
  note: "Native in After Effects — stays an AE object and feeds the shader as a layer input.",
};

const RAMP_KEY_RE = /^ramp_[cap]:/;

// The universal `mask` input, and Merge's per-layer `mask:<id>` mattes.
const isMaskSocket = (h: string) => h === "in:mask" || h.startsWith("in:mask:");

// ---------------------------------------------------------------------------
// Working state
// ---------------------------------------------------------------------------

interface Wire {
  from: string;
  fromId: string;
  fromHandle: string;
  toId: string;
  toHandle: string;
  type: string;
}

interface Region {
  kind: "shader" | "bake";
  nodes: Set<string>;
  target: string;
  reason: string;
  segment?: number;
  glsl?: TranslationPlan;
}

interface NodeState {
  node: PlanNode;
  entry: AeExportEntry;
  notes: string[];
  requires: Set<AeRequirement>;
  mask?: boolean;
  region?: Region;
  segment: number;
  // Member of a native 3-D scene (three-plan.ts): the Scene Render's id.
  scene3d?: string;
}

interface SegmentBuild {
  kind: AeSegmentKind;
  nodes: string[];
  aeLayer: AeLayerKind;
  region?: Region;
}

interface Acc {
  policy: AeExportPolicy;
  shaderRegions: AeShaderRegion[];
  bakes: AeBakeItem[];
  expressions: AeExpressionItem[];
  blocked: AeBlocker[];
  approximations: { id: string; type: string; note: string }[];
  warnings: string[];
  fonts: Set<string>;
  keyframes: number;
  aeLayers: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const titleCase = (s: string) => s.replace(/(^|-)([a-z])/g, (_m, a: string, b: string) => `${a ? " " : ""}${b.toUpperCase()}`);

function outputType(info: PlanNodeInfo | undefined, handle: string): string | undefined {
  if (!info) return undefined;
  if (handle === "out") return info.primaryOutput;
  if (handle.startsWith("aux:")) return info.auxOutputs.find((a) => a.name === handle.slice(4))?.type;
  return undefined;
}

function inputType(info: PlanNodeInfo | undefined, handle: string): string | undefined {
  if (!info) return undefined;
  if (handle.startsWith("in:")) return info.inputs.find((i) => i.name === handle.slice(3))?.type;
  if (handle.startsWith("param:")) return info.params.find((p) => p.name === handle.slice(6))?.type;
  return undefined;
}

export function resolveAePolicy(p?: Partial<AeExportPolicy>): AeExportPolicy {
  return { ...DEFAULT_AE_POLICY, ...(p ?? {}) };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export function planAeExport(input: AePlanInput): AeExportPlan {
  const policy = resolveAePolicy(input.policy);
  const acc: Acc = {
    policy,
    shaderRegions: [],
    bakes: [],
    expressions: [],
    blocked: [],
    approximations: [],
    warnings: [],
    fonts: new Set(),
    keyframes: 0,
    aeLayers: 0,
  };
  const comp = input.composition;
  const layers: AePlanLayer[] = [];
  if (!input.layers.length) acc.warnings.push(`Composition "${comp.name}" has no layers and nothing wired into its Output.`);
  for (const L of input.layers) layers.push(planLayer(L, input, acc));

  const footageMB = round1(acc.bakes.reduce((s, b) => s + b.estimatedMB, 0));
  if (footageMB > policy.bakeWarnMB)
    acc.warnings.push(`Baked footage ≈ ${footageMB} MB exceeds the ${policy.bakeWarnMB} MB warning (§11.5) — confirm before exporting, or shorten the baked ranges.`);

  const route: AeExportPlan["route"] = acc.blocked.length
    ? "blocked"
    : acc.shaderRegions.length
      ? "direct+shader"
      : acc.bakes.length
        ? "direct+bake"
        : "direct";

  return {
    route,
    composition: { ...comp },
    layers,
    shaderRegions: acc.shaderRegions,
    bakes: acc.bakes,
    expressions: acc.expressions,
    blocked: acc.blocked,
    approximations: acc.approximations,
    estimates: { layers: acc.aeLayers, keyframes: acc.keyframes, footageMB },
    fonts: [...acc.fonts].sort(),
    policy,
    warnings: acc.warnings,
  };
}

function planLayer(L: AePlanLayerInput, input: AePlanInput, acc: Acc): AePlanLayer {
  const { policy } = acc;
  const comp = input.composition;
  const classOf = input.classOf ?? aeExportEntry;
  const tracksOf = input.tracksOf ?? (() => []);
  const label = `Layer "${L.name}"`;
  const windows = layerWindows(L, comp.durationFrames);
  if (windows.length > 1) acc.warnings.push(`${label} has ${windows.length} clip windows — one AE layer each.`);

  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  const infoOf = (id: string) => input.infoOf(id);

  // --- wires ------------------------------------------------------------------
  const inputsOf = new Map<string, Wire[]>();
  for (const e of L.edges) {
    const f = parseEndpoint(e.from);
    const t = parseEndpoint(e.to);
    if (!byId.has(f.id) || !byId.has(t.id)) continue; // boundary / other-scope endpoints
    const type =
      outputType(infoOf(f.id), f.handle) ?? inputType(infoOf(t.id), t.handle) ?? (t.handle.startsWith("param:") ? "param" : "unknown");
    const w: Wire = { from: e.from, fromId: f.id, fromHandle: f.handle, toId: t.id, toHandle: t.handle, type };
    (inputsOf.get(t.id) ?? inputsOf.set(t.id, []).get(t.id)!).push(w);
  }

  // --- 1. reach (postorder ⇒ producers first) -------------------------------------
  const outEp = L.output ? parseEndpoint(L.output) : undefined;
  const order: string[] = [];
  const reach = new Set<string>();
  const visit = (id: string) => {
    if (reach.has(id) || !byId.has(id)) return;
    reach.add(id);
    for (const w of inputsOf.get(id) ?? []) visit(w.fromId);
    order.push(id);
  };
  if (outEp && byId.has(outEp.id)) visit(outEp.id);
  else if (L.output) acc.warnings.push(`${label}: its output "${L.output}" is not in the layer — nothing to plan.`);
  else acc.warnings.push(`${label} has nothing wired into its Layer Output — it exports as an empty layer.`);
  // Zone members ride with their shell.
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of L.nodes)
      if (n.parent && reach.has(n.parent) && !reach.has(n.id)) {
        visit(n.id);
        grew = true;
      }
  }
  // Consumers, restricted to reached nodes: a dead branch exports nothing,
  // so it neither shares a producer nor blocks a bake's exclusivity.
  const outputsOf = new Map<string, Wire[]>();
  for (const id of order)
    for (const w of inputsOf.get(id) ?? []) (outputsOf.get(w.fromId) ?? outputsOf.set(w.fromId, []).get(w.fromId)!).push(w);
  const topo = new Map(order.map((id, i) => [id, i]));
  const reverse = [...order].reverse();

  // animated: keyed, reads the clock, simulates, or fed by something that does.
  const animated = new Set<string>();
  for (const id of order) {
    const n = byId.get(id)!;
    const info = infoOf(id);
    if ((n.keyframed?.length ?? 0) > 0 || tracksOf(id).length > 0 || info?.readsTime || info?.simulation) animated.add(id);
    else if ((inputsOf.get(id) ?? []).some((w) => animated.has(w.fromId))) animated.add(id);
    else if (n.parent && animated.has(n.parent)) animated.add(id);
  }

  // --- 2. classify --------------------------------------------------------------------
  const st = new Map<string, NodeState>();
  for (const id of order) {
    const n = byId.get(id)!;
    const s: NodeState = { node: n, entry: classOf(n.type), notes: [], requires: new Set(classOf(n.type).requires ?? []), segment: -1 };
    if (!isAeClassified(n.type) && !input.classOf)
      acc.warnings.push(`${n.type} (${id}) is not in the After Effects class table — treated as unsupported.`);
    refine(s, input.valuesOf(id), tracksOf(id), policy);
    // A polymorphic node on points or a spline (Mirror, …): the class table
    // lists its image form, but the walk evaluates its points / path.
    const carries = infoOf(id)?.primaryOutput;
    if ((carries === "points" || carries === "spline") && (s.entry.class === "effect" || s.entry.class === "shader")) {
      s.entry =
        carries === "points"
          ? { class: "instances", fidelity: "exact", note: "On points → the evaluated points as instance positions (static values; animated → per-frame keys)." }
          : { class: "vector", ae: "shape:path", fidelity: "sampled", note: "On a spline → the evaluated path (static → exact; animated → path keys per frame)." };
      s.requires = new Set();
      s.notes = [];
    }
    st.set(id, s);
  }
  // Rasterize Spline settings the walk bakes for (rasterize-rules.ts), and
  // hole punching on animated geometry (its contour nesting is read once).
  for (const id of order) {
    const s = st.get(id)!;
    if (s.node.type !== "rasterize-spline" || s.entry.class === "bake") continue;
    const values = input.valuesOf(id);
    const wires = inputsOf.get(id) ?? [];
    const path = wires.find((w) => w.toHandle === "in:path");
    const reason =
      rasterizeBakeReason(values, (x) => wires.some((w) => w.toHandle === `in:${x}`)) ??
      (punchesHoles(values) && path && animated.has(path.fromId) ? "hole punching on animated geometry — the contour nesting is read once" : null);
    if (!reason) continue;
    s.entry = { class: "bake", ae: "layer:footage", fidelity: "bake", requires: ["footage"], note: `${reason}; bakes.` };
    s.requires = new Set(["footage"]);
    s.notes = [];
  }
  // Spline Merge's Flow runs on the GPU, which the walk's evaluator has not:
  // on a still input the editor's own outline exports (scene/shape.ts
  // splineAt); on moving geometry it bakes.
  for (const id of order) {
    const s = st.get(id)!;
    if (s.node.type !== "spline-merge" || s.entry.class === "bake" || input.valuesOf(id).flow === false) continue;
    if ((inputsOf.get(id) ?? []).some((w) => animated.has(w.fromId))) {
      s.entry = { class: "bake", ae: "layer:footage", fidelity: "bake", requires: ["footage"], note: "Flow on moving geometry simulates on the GPU every frame, which the export can't replay; bakes." };
      s.requires = new Set(["footage"]);
    } else s.notes.push("Flow on a still input → its settled outline, from the editor's own evaluation (the export's evaluator has no GPU).");
  }
  // A gradient fill spans each subpath's own frame, so on animated geometry
  // its points move every frame, which a preset can't key: the walk bakes it
  // (scene/style.ts subpathsOf), and so does the plan.
  for (const id of order) {
    const s = st.get(id)!;
    if (s.node.type !== "rasterize-spline" || s.entry.class === "bake" || input.valuesOf(id).fill_source !== "gradient") continue;
    const path = (inputsOf.get(id) ?? []).find((w) => w.toHandle === "in:path");
    if (!path || !animated.has(path.fromId)) continue;
    s.entry = { class: "bake", ae: "layer:footage", fidelity: "bake", requires: ["footage"], note: "Gradient fill on animated geometry — its points follow the shape every frame, which a .ffx preset can't key; bakes." };
    s.requires = new Set(["footage"]);
    s.notes = s.notes.filter((x) => !/\.ffx/.test(x));
  }
  // 3-D scenes (M4 lane 5, three-plan.ts): a Scene Render whose objects are
  // Import 3D models (under Transform 3D) and lights, seen by a Camera node,
  // rebuilds natively as a 3-D precomp; its members leave the bake rung.
  for (const id of order) {
    const s = st.get(id)!;
    if (s.node.type !== "scene-render") continue;
    const v = planScene3d({
      sceneId: id,
      type: (x) => byId.get(x)?.type,
      values: input.valuesOf,
      inputs: (x) => (inputsOf.get(x) ?? []).map((w) => ({ fromId: w.fromId, toHandle: w.toHandle })),
    });
    if (!v.native) {
      s.entry = { ...s.entry, note: `three.js render — bakes (not native: ${v.reason}).` };
      continue;
    }
    s.entry = scene3dEntry("scene");
    s.requires = new Set();
    s.notes.push(...v.notes);
    for (const [m, role] of v.members) {
      const ms = st.get(m);
      if (!ms) continue;
      ms.entry = scene3dEntry(role, v.ortho);
      ms.requires = new Set(ms.entry.requires ?? []);
      ms.scene3d = id;
    }
  }

  const isValue = (id: string) => {
    const s = st.get(id)!;
    if (s.entry.class === "expression") return true;
    return s.entry.class === "unsupported" && VALUE_SOCKETS.has(infoOf(id)?.primaryOutput ?? "");
  };

  // SDF chains (sdf-chain.ts): a hard tree under sdf-rasterize / sdf-to-mask /
  // sdf-to-spline is one shape layer's geometry (vector); any other keeps the
  // shader route — or, under sdf-to-spline (a GPU-traced contour), bakes —
  // and says which node stopped it.
  const sdfTree = planSdfChains(order, st, byId, inputsOf, outputsOf, input, tracksOf);

  // Spline producers that only feed universal `mask` sockets are layer masks.
  for (const id of reverse) {
    const s = st.get(id)!;
    if (s.entry.class !== "vector") continue;
    const outs = outputsOf.get(id) ?? [];
    if (!outs.length) continue;
    const allMask = outs.every(
      (w) => (isMaskSocket(w.toHandle) && (w.type === "spline" || w.type === "unknown")) || st.get(w.toId)?.mask
    );
    if (!allMask) continue;
    s.mask = true;
    // An SDF outline is Merge Paths geometry, which no mask path holds.
    const sdfOutline = sdfTree.has(id) || s.node.type === "sdf-to-spline";
    s.entry = {
      ...s.entry,
      class: "mask",
      ae: sdfOutline ? "shape:merge" : "mask:path",
      note: sdfOutline
        ? "→ an ALPHA track matte: a hidden shape layer of the SDF tree's outline (Merge Paths cannot be a mask path)."
        : "→ a mask path on the consuming layer (mode add); on an effect → its Compositing Options mask.",
    };
  }

  // Blockers: live inputs anywhere upstream of the output.
  for (const id of order) {
    const s = st.get(id)!;
    if (s.entry.class !== "unsupported") continue;
    const drives = (outputsOf.get(id) ?? []).map((w) => `${w.toId}:${w.toHandle}`);
    acc.blocked.push({
      id,
      type: s.node.type,
      reason: `${s.entry.note ?? "Unsupported."}${drives.length ? ` Drives ${drives.slice(0, 3).join(", ")}${drives.length > 3 ? "…" : ""}.` : ""}`,
    });
  }

  // --- 3–4. regions ------------------------------------------------------------------------
  const regions: Region[] = [];
  const endpointOut = (id: string, inRegion: (x: string) => boolean): string => {
    if (outEp && outEp.id === id && L.output) return L.output;
    const w = (outputsOf.get(id) ?? []).find((x) => !inRegion(x.toId));
    return w?.from ?? `${id}:out`;
  };
  const growBake = (seed: string, reason: string): Region => {
    const nodes = new Set<string>([seed]);
    const up = new Set<string>();
    const walk = (id: string) => {
      for (const w of inputsOf.get(id) ?? []) {
        if (up.has(w.fromId) || nodes.has(w.fromId) || st.get(w.fromId)?.region) continue;
        up.add(w.fromId);
        walk(w.fromId);
      }
    };
    walk(seed);
    // Consumers before producers: a producer joins only when every consumer did.
    for (const id of reverse) {
      if (!up.has(id)) continue;
      const outs = outputsOf.get(id) ?? [];
      const isOutput = outEp?.id === id;
      if (!isOutput && outs.length && outs.every((w) => nodes.has(w.toId))) nodes.add(id);
    }
    // Zone members go with an absorbed shell.
    for (const id of order) {
      const p = byId.get(id)!.parent;
      if (p && nodes.has(p)) nodes.add(id);
    }
    const r: Region = { kind: "bake", nodes, target: endpointOut(seed, (x) => nodes.has(x)), reason };
    for (const id of nodes) st.get(id)!.region = r;
    regions.push(r);
    return r;
  };

  const shaderClass = (id: string) => st.get(id)!.entry.class === "shader";
  for (const id of reverse) {
    const s = st.get(id)!;
    if (s.region) continue;
    const c = s.entry.class;
    if (c === "bake") growBake(id, s.entry.note ?? `${s.node.type} bakes.`);
    else if (c === "unsupported" && !isValue(id))
      growBake(id, `${s.node.type} is a live input — bakes once a take is recorded.`);
    else if (c === "shader" && !policy.shaderHost)
      growBake(id, `Shader region with the Toolbox Shader host off (policy.shaderHost = false) — bakes look-exact.${s.entry.note ? ` ${s.node.type}: ${s.entry.note}` : ""}`);
  }

  if (policy.shaderHost) {
    // An approx effect fed by a shader node fuses into that region: the host is
    // already required, and the parity loop beats the AE stand-in. Not for
    // multipass effects (blur, bloom…): their fused form is itself a one-pass
    // approximation and costs ~N² upstream taps, so the native effect wins.
    for (const id of order) {
      const s = st.get(id)!;
      if (s.region || s.entry.class !== "effect" || s.entry.fidelity !== "approx" || !isGlslFusable(s.node.type)) continue;
      if (translationEntry(s.node.type).class === "multipass") continue;
      const main = mainInput(id);
      if (!main || !shaderClass(main.fromId) || st.get(main.fromId)!.region) continue;
      s.notes.push(`Fused into the shader region — the host is already required, so the parity loop replaces the ${s.entry.ae} approximation.`);
      s.entry = shaderEntryFor(s.node.type, s.entry);
      s.requires.add("host");
    }
    for (const id of reverse) {
      const s = st.get(id)!;
      if (s.region || s.entry.class !== "shader") continue;
      const eligible = (x: string) => reach.has(x) && shaderClass(x) && !st.get(x)!.region;
      const target = endpointOut(id, eligible);
      let glsl: TranslationPlan | undefined;
      let why = "";
      const planRegion = (edges: typeof L.edges) =>
        planTranslation({
          nodes: L.nodes.map((n) => (reach.has(n.id) && eligible(n.id) ? n : { ...n, type: NATIVE_PREFIX + n.type })),
          edges,
          target: parseEndpoint(target).handle === "out" ? id : target,
          scopeId: L.id,
          infoOf,
          valuesOf: input.valuesOf,
          keyframeFramesOf: (x) => tracksOf(x).flatMap((t) => t.frames),
          classOf: (type) =>
            type.startsWith(NATIVE_PREFIX)
              ? NATIVE_ENTRY
              : SDF_CHAIN_TYPES.has(type)
                ? { class: "compiled", note: "SDF tree node — compiles into its consumer." }
                : translationEntry(type),
          frame: input.frame ?? 0,
          fps: comp.fps,
          loopFrames: comp.durationFrames,
          canvas: { width: comp.width, height: comp.height },
        });
      try {
        // A node the host runs as its own shader takes its universal mask
        // outside the shader (an AE layer mask or matte, as any source), so
        // a spline there doesn't stop it — when it is a region alone.
        const maskOf = (e: (typeof L.edges)[number]) => {
          const t = parseEndpoint(e.to);
          return t.id === id && isMaskSocket(t.handle);
        };
        const alone = classOf(s.node.type).ownShader && L.edges.some(maskOf) ? planRegion(L.edges.filter((e) => !maskOf(e))) : undefined;
        glsl = alone && alone.region.length === 1 && alone.region[0] === id && !alone.refusal ? alone : planRegion(L.edges);
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      const members = (glsl?.region ?? []).filter((x) => eligible(x));
      if (!glsl || !members.includes(id)) {
        const reason = why || glsl?.refusal || glsl?.excluded.find((x) => x.id === id)?.reason || "the GLSL planner cannot fuse it";
        growBake(id, `${s.node.type} cannot become a shader region (${reason}) — bakes.`);
        continue;
      }
      const r: Region = { kind: "shader", nodes: new Set(members), target, reason: "", glsl };
      for (const x of members) st.get(x)!.region = r;
      regions.push(r);
    }
  }

  function mainInput(id: string): Wire | undefined {
    const ins = (inputsOf.get(id) ?? []).filter(
      (w) => w.toHandle.startsWith("in:") && !isMaskSocket(w.toHandle) && !isValue(w.fromId) && !st.get(w.fromId)?.mask
    );
    if (!ins.length) return undefined;
    const sockets = infoOf(id)?.inputs.map((i) => `in:${i.name}`) ?? [];
    const rank = (w: Wire) => {
      const i = sockets.indexOf(w.toHandle);
      return i < 0 ? sockets.length : i;
    };
    return [...ins].sort((a, b) => rank(a) - rank(b))[0];
  }

  // --- 5. segments ------------------------------------------------------------------------
  const segs: SegmentBuild[] = [];
  const zoneShell = (id: string) => {
    const p = byId.get(id)!.parent;
    return p && reach.has(p) ? p : undefined;
  };
  for (const id of order) {
    const s = st.get(id)!;
    // A native SDF tree joins its consumer's segment (one shape layer).
    if (isValue(id) || s.mask || zoneShell(id) || sdfTree.has(id) || s.scene3d) continue;
    if (s.region) {
      if (s.region.segment === undefined) {
        s.region.segment = segs.length;
        segs.push({
          kind: s.region.kind,
          nodes: [],
          aeLayer: s.region.kind === "shader" ? "solid" : "footage",
          region: s.region,
        });
      }
      s.segment = s.region.segment;
      segs[s.segment].nodes.push(id);
      continue;
    }
    const main = mainInput(id);
    const kind = segmentKind(s, !!main);
    const prev = main ? st.get(main.fromId)! : undefined;
    const prevSeg = prev && prev.segment >= 0 ? segs[prev.segment] : undefined;
    const exclusive =
      !!main &&
      (outputsOf.get(main.fromId) ?? []).filter((w) => !isValue(w.toId) && !st.get(w.toId)?.mask).every((w) => w.toId === id);
    if (prevSeg && !prevSeg.region && exclusive && joinable(prevSeg.kind, s.entry.class, kind)) {
      s.segment = prev!.segment;
      prevSeg.nodes.push(id);
      continue;
    }
    s.segment = segs.length;
    segs.push({ kind, nodes: [id], aeLayer: aeLayerFor(kind, s, prevSeg) });
  }
  // Masks, value drivers and zone members join the segment they serve.
  for (const id of reverse) {
    const s = st.get(id)!;
    if (s.segment >= 0) continue;
    const shell = zoneShell(id);
    if (shell && st.get(shell)!.segment >= 0) s.segment = st.get(shell)!.segment;
    else {
      const to = (outputsOf.get(id) ?? []).map((w) => st.get(w.toId)!).find((c) => c.segment >= 0);
      if (to) s.segment = to.segment;
    }
    if (s.segment >= 0 && !isValue(id)) segs[s.segment].nodes.push(id);
  }
  for (const seg of segs) seg.nodes.sort((a, b) => topo.get(a)! - topo.get(b)!);

  const segments: AeSegment[] = segs.map((seg, i) => {
    const inSeg = (x: string) => st.get(x)?.segment === i;
    let output = seg.region?.target;
    if (!output) {
      const last = seg.nodes[seg.nodes.length - 1];
      output = endpointOut(last, inSeg);
    }
    return { kind: seg.kind, nodes: seg.nodes, output, aeLayer: seg.aeLayer };
  });

  // --- regions → plan items -----------------------------------------------------------------
  const win = windows[0];
  for (const r of regions) {
    if (r.kind === "shader") {
      const g = r.glsl!;
      const nodes = g.region.filter((x) => r.nodes.has(x));
      const id = `shader-${acc.shaderRegions.length + 1}`;
      // One node the host runs as its own shader (node-shaders.ts): no
      // fused node needed. The scene walk still bakes a state its spec
      // refuses, and says why.
      const lone = nodes.length === 1 && r.target === `${nodes[0]}:out` ? byId.get(nodes[0]) : undefined;
      const kernel = lone && classOf(lone.type).ownShader ? { kernel: "node" as const } : {};
      const summary = "kernel" in kernel ? ownShaderSummary(g, lone!) : shaderSummary(g, nodes, byId);
      acc.shaderRegions.push({ id, target: r.target, nodes, frames: g.time.frames, summary, ...kernel });
      for (const x of nodes) st.get(x)!.notes.push(`In ${id} (Toolbox Shader, target ${r.target}).`);
    } else {
      const anim = [...r.nodes].some((x) => animated.has(x));
      const frames: [number, number] = anim ? [win.inFrame, Math.max(win.inFrame, win.outFrame - 1)] : [win.inFrame, win.inFrame];
      const count = anim ? windows.reduce((sum, w) => sum + Math.max(0, w.outFrame - w.inFrame), 0) : 1;
      const id = `bake-${acc.bakes.length + 1}`;
      const mb = bakeMB(policy.bakeCodec, comp.width, comp.height, count);
      acc.bakes.push({ id, output: r.target, frames, codec: policy.bakeCodec, estimatedMB: mb, reason: r.reason });
      for (const x of r.nodes) st.get(x)!.notes.push(`Baked into ${id} (${r.target}).`);
    }
  }

  // Layer blend modes AE lacks: the layer's composite over the stack.
  const layerBlend = L.blendMode ?? "normal";
  if (!aeBlendModeOf(layerBlend)) {
    const mode = titleCase(layerBlend);
    if (AE_MISSING_BLEND_MODES.has(layerBlend) && policy.shaderHost) {
      const id = `shader-${acc.shaderRegions.length + 1}`;
      acc.shaderRegions.push({
        id,
        target: `${L.id}:out`,
        nodes: [L.id],
        frames: [win.inFrame],
        summary: `Layer blend ${mode} has no AE mode — a Toolbox Shader on an adjustment layer blends this layer (input a) over the stack below.`,
      });
      acc.warnings.push(`${label} blends with ${mode}, which AE lacks — ${id} reproduces it.`);
    } else {
      const frames: [number, number] = [win.inFrame, Math.max(win.inFrame, win.outFrame - 1)];
      const id = `bake-${acc.bakes.length + 1}`;
      acc.bakes.push({
        id,
        output: `${L.id}:out`,
        frames,
        codec: policy.bakeCodec,
        estimatedMB: bakeMB(policy.bakeCodec, comp.width, comp.height, frames[1] - frames[0] + 1),
        reason: `Layer blend ${mode} has no AE mode${AE_MISSING_BLEND_MODES.has(layerBlend) ? " and the shader host is off" : ""} — bakes this layer composited over the stack below.`,
      });
      acc.warnings.push(`${label} blends with ${mode}, which AE lacks — ${id} bakes the composite.`);
    }
  }

  // --- expressions (§3 rung 3) --------------------------------------------------------------
  for (const id of order) {
    if (!isValue(id) || st.get(id)!.region) continue;
    for (const w of outputsOf.get(id) ?? []) {
      const c = st.get(w.toId)!;
      if (isValue(w.toId) || c.region?.kind === "bake") continue;
      const closure = new Set<string>();
      let sampled = false;
      const up = (x: string) => {
        if (closure.has(x)) return;
        closure.add(x);
        const sx = st.get(x)!;
        if (sx.entry.fidelity === "sampled" || sx.entry.class === "unsupported") sampled = true;
        for (const iw of inputsOf.get(x) ?? []) {
          if (isValue(iw.fromId)) up(iw.fromId);
          else if (iw.type !== "spline") sampled = true; // a path is a reference (pointOnPath); anything else samples
        }
      };
      up(id);
      acc.expressions.push({
        drives: `${w.toId}:${w.toHandle}`,
        nodes: [...closure].sort((a, b) => topo.get(a)! - topo.get(b)!),
        sampled,
      });
    }
  }

  // --- 6. scoring ------------------------------------------------------------------------------
  const approx = (id: string, note: string) => {
    const s = st.get(id)!;
    acc.approximations.push({ id, type: s.node.type, note });
  };
  const resampleDownstream = (id: string): boolean => {
    const seen = new Set<string>();
    const walk = (x: string): boolean => {
      for (const w of outputsOf.get(x) ?? []) {
        if (seen.has(w.toId)) continue;
        seen.add(w.toId);
        const t = st.get(w.toId)!;
        if (t.node.type === "spline-resample") return true;
        if ((t.entry.class === "vector" || t.entry.class === "mask") && walk(w.toId)) return true;
      }
      return false;
    };
    return walk(id);
  };
  let unstablePaths = 0;
  for (const id of order) {
    const s = st.get(id)!;
    const n = s.node;
    const values = input.valuesOf(id);
    const baked = s.region?.kind === "bake";

    // Keyframe tracks: easing (§4.2) and color (§4.3).
    if (!baked) {
      for (const t of tracksOf(id)) {
        acc.keyframes += t.frames.length;
        const fitNotes = new Map<string, number>();
        for (let i = 0; i + 1 < t.frames.length; i++) {
          const easing = t.easings[i] ?? "linear";
          const rule = EASING[easing];
          const span = Math.max(1, Math.round(t.frames[i + 1] - t.frames[i]));
          if (!rule) {
            s.notes.push(`${t.param}: easing "${easing}" is unknown to the converter — per-frame keys.`);
            acc.keyframes += span - 1;
            continue;
          }
          const r = policy.fidelity === "exact" ? rule.exact : rule.editable;
          if (r.kind === "fit") fitNotes.set(easing, (rule.editable.err ?? 0));
          else if (r.kind === "keys") {
            acc.keyframes += r.keys ?? 0;
            const err = policy.fidelity === "editable" ? rule.editable.err : undefined;
            if (err) fitNotes.set(easing, err);
            else s.notes.push(`${t.param}: ${easing} → +${r.keys} keys per segment (exact).`);
          } else if (r.kind === "frames") {
            acc.keyframes += span - 1;
            s.notes.push(`${t.param}: ${easing} → per-frame keys (exact at frames, not graph-editable).`);
          }
        }
        for (const [easing, err] of fitNotes) {
          const note =
            easing === "easeOutElastic"
              ? `${t.param}: easeOutElastic → 8 keys, best-fit cubics (≤${err}%); Exact policy keys every frame.`
              : `${t.param}: ${easing} → best-fit cubic (≤${err}%); Exact policy ${EASING[easing].exact.kind === "keys" ? "adds a midpoint key" : "keys every frame"}.`;
          s.notes.push(note);
          approx(id, note);
        }
        const isColor = t.type === "color" || t.param.startsWith("ramp_c:") || t.param.startsWith("gpoint_c:");
        if (isColor && (t.colorSpace ?? "oklab") === "oklab" && t.frames.length > 1) {
          const segsN = t.frames.length - 1;
          const shapeOrSolid = ["vector", "style", "mask", "text"].includes(s.entry.class) || n.type === "solid-color";
          const mode = policy.color === "auto" ? (shapeOrSolid ? "expression" : "dense") : policy.color;
          if (mode === "expression") s.notes.push(`${t.param}: OKLab tween → an expression OKLab-lerping between the keys (exact, not graph-editable).`);
          else if (mode === "dense") {
            acc.keyframes += segsN * DENSE_COLOR_KEYS_PER_SEGMENT;
            s.notes.push(`${t.param}: OKLab tween → dense RGB keys within ${policy.colorTolerance}/255 (≤${DENSE_COLOR_KEYS_PER_SEGMENT} per segment).`);
          } else approx(id, `${t.param}: RGB interpolation in AE vs OKLab in toolbox — mid-tween colors differ (hue-changing tweens worst).`);
        }
      }
    }
    if (baked) continue;

    // A still evaluated path or point set is exact: nothing is keyed per
    // frame (the walk reports it sampled where it does sample).
    if ((s.entry.class === "vector" || s.entry.class === "mask" || s.entry.class === "instances") && s.entry.fidelity === "sampled" && !animated.has(id)) s.entry = { ...s.entry, fidelity: "exact" };
    // Anchor-count stability for sampled (evaluated) paths.
    if ((s.entry.class === "vector" || s.entry.class === "mask") && s.entry.fidelity === "sampled" && animated.has(id) && !resampleDownstream(id)) {
      s.notes.push("Animated evaluated path → path keys per frame; AE needs a constant vertex count — add a Spline Resample downstream, or the segment bakes.");
      unstablePaths++;
    }
    // Per-anchor width on drawn paths.
    if (n.type === "spline-draw" && anchorsHaveWidth(values.spline)) {
      const note = "Per-anchor width (variable-width stroke) has no AE form — Stroke Taper approximates monotonic tapers, else outline it (Spline Outline → fill).";
      s.notes.push(note);
      approx(id, note);
    }
    // Instances vs the layer budget.
    if (s.requires.has("explode")) {
      const ptsWire = (inputsOf.get(id) ?? []).find((w) => w.toHandle === "in:points");
      const count = ptsWire ? instanceCount(ptsWire, input, inputsOf, byId) : undefined;
      const instanceWire = (inputsOf.get(id) ?? []).find((w) => w.toHandle === "in:instance");
      const fields = (inputsOf.get(id) ?? []).some((w) => /^in:(pick|scale_mul|rotate_add|scale_field|rotate_field|driver_field)$/.test(w.toHandle));
      const gridSource = ptsWire && byId.get(ptsWire.fromId)?.type === "grid";
      if (n.type === "copy-to-points" && gridSource && instanceWire && !fields) {
        s.notes.push("Regular grid with one instance → two Repeaters on one shape layer (no explode).");
        acc.aeLayers += 1;
      } else if (count === undefined) {
        s.notes.push("Instance count unknown until evaluated — the exporter checks it against the layer budget.");
      } else {
        acc.aeLayers += count;
        s.notes.push(`~${count} instances → ${count} exploded layers.`);
        if (count > policy.layerBudget)
          acc.warnings.push(
            `${n.type} (${id}) makes ~${count} instances — over the ${policy.layerBudget}-layer budget (§11.5). Ask before exploding; a Repeater only covers a regular grid/array with one instance; otherwise bake it.`
          );
      }
    }
    // Fonts.
    if (s.entry.class === "text") {
      const custom = values.custom_font as { family?: unknown } | null | undefined;
      const fam = typeof values.font_family === "string" ? values.font_family : undefined;
      if (custom && typeof custom === "object") {
        acc.fonts.add(String(custom.family ?? "custom font"));
        s.notes.push("Custom (uploaded) font — install the same file in AE; the PostScript name resolves at export.");
      } else if (fam) acc.fonts.add(fam);
    }
    // space=local pivots on animated geometry (§4.1).
    if (n.type === "transform" && (values.space ?? "local") === "local") {
      const main = mainInput(id);
      const spun =
        (n.keyframed ?? []).some((k) => /^(rotate|scaleX|scaleY)$/.test(k)) ||
        num(values.rotate, 0) !== 0 ||
        num(values.scaleX, 1) !== 1 ||
        num(values.scaleY, 1) !== 1;
      if (main && animated.has(main.fromId) && spun)
        s.notes.push("space=local pivot on animated geometry → the anchor point is keyed per frame (or switch the node to a canvas pivot).");
    }
    // Static approximations by name (§3 rung 2), once per node.
    if (s.entry.fidelity === "approx" && s.entry.note) approx(id, s.entry.note);
  }
  if (unstablePaths)
    acc.warnings.push(`${label}: ${unstablePaths} animated evaluated path${unstablePaths === 1 ? "" : "s"} need a constant anchor count for path keys (see the node notes).`);

  // --- AE layer estimate -------------------------------------------------------------------------
  let aeLayers = 0;
  for (const seg of segs) if (seg.kind !== "raster" || seg.aeLayer === "adjustment") aeLayers++;
  for (const id of order)
    for (const w of inputsOf.get(id) ?? []) if (isMaskSocket(w.toHandle) && !st.get(w.fromId)!.mask) aeLayers++; // track-matte sources
  if (aeLayers > 1) aeLayers++; // the layer becomes a precomp in the main comp
  acc.aeLayers += aeLayers * Math.max(1, windows.length);
  acc.keyframes += (L.keyframed?.length ?? 0) * 2;

  const nodes: AePlanNode[] = order.map((id) => {
    const s = st.get(id)!;
    const notes = [...(s.entry.note ? [s.entry.note] : []), ...s.notes];
    return {
      id,
      type: s.node.type,
      ...(s.node.name ? { name: s.node.name } : {}),
      class: s.region?.kind === "bake" ? "bake" : s.entry.class,
      ...(s.region?.kind === "bake" ? { ae: "layer:footage" } : s.entry.ae ? { ae: s.entry.ae } : {}),
      fidelity: s.region?.kind === "bake" ? "bake" : s.entry.fidelity,
      notes,
      segment: s.segment,
      ...(s.requires.size ? { requires: [...s.requires].sort() } : {}),
    };
  });
  return { id: L.id, name: L.name, windows, segments, nodes };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

// AE objects a native SDF tree node becomes (scene/sdf.ts).
const SDF_AE: Record<string, { ae: string; note: string }> = {
  "sdf-circle": { ae: "shape:ellipse", note: "→ an Ellipse (radius + offsets)." },
  "sdf-rectangle": { ae: "shape:rect", note: "→ a Rect (corner radius → Roundness; offsets grow both)." },
  "sdf-line-segment": { ae: "shape:rect", note: "→ a capsule: a Rect of length |b − a| + 2·thickness, Roundness = thickness, turned to the segment." },
  "sdf-polygon": { ae: "shape:polystar", note: "→ a Polystar polygon (its SDF is the edge-line distance, so offsets keep sharp corners: circumradius + δ/cos(π/n))." },
  "sdf-star": { ae: "shape:polystar", note: "→ a Polystar star (inner radius r·sin(π/m − π/n)/sin(π/m)); an offset adds Offset Paths, Round join." },
  "sdf-triangle": { ae: "shape:path", note: "→ a Path; an offset adds Offset Paths, Round join." },
  "sdf-union": { ae: "shape:merge", note: "→ Merge Paths Add." },
  "sdf-smooth-union": { ae: "shape:merge", note: "→ Merge Paths Add (smoothness ≤ 0)." },
  "sdf-intersection": { ae: "shape:merge", note: "→ Merge Paths Intersect." },
  "sdf-smooth-intersection": { ae: "shape:merge", note: "→ Merge Paths Intersect (smoothness ≤ 0)." },
  "sdf-subtraction": { ae: "shape:merge", note: "→ Merge Paths Subtract (a, then b)." },
  "sdf-smooth-subtraction": { ae: "shape:merge", note: "→ Merge Paths Subtract (smoothness ≤ 0)." },
  "sdf-round": { ae: "shape:group", note: "→ an offset of every leaf below it (round distributes over min / max)." },
  "sdf-onion": { ae: "shape:merge", note: "→ the tree offset out by `thickness` minus the tree offset in by it (Merge Paths Subtract)." },
  "sdf-material": { ae: "shape:fill", note: "→ the fill colour (distance-only consumers ignore it)." },
  "sdf-translate": { ae: "shape:group", note: "→ a group Position." },
  "sdf-rotate": { ae: "shape:group", note: "→ a group Rotation about the pivot (SDF space is Y-up: −degrees)." },
  "sdf-scale": { ae: "shape:group", note: "→ a group Scale about its center." },
  "sdf-mirror": { ae: "shape:group", note: "→ the kept half and its reflection (scale −100), Merge Paths Add." },
  "sdf-repeat": { ae: "shape:repeater", note: "→ a Repeater per axis over the cell (clipped where the shape overflows it)." },
  "sdf-polar": { ae: "shape:repeater", note: "→ a Repeater turning 360°/segments about the center (clipped to the wedge where needed)." },
};

const SDF_CONSUMER_NOTE: Record<string, string> = {
  "sdf-rasterize": "Hard SDF chain → one shape layer: the tree as Merge Paths, Fill = foreground, Stroke = contour, a comp-sized Rect = background. Edges: AE's coverage anti-aliasing vs toolbox's smoothstep of the distance (edge pixels only).",
  "sdf-to-mask": "Hard SDF chain → a white-on-black shape layer (luma matte where it masks); threshold → an offset. Edges: AE's coverage anti-aliasing vs toolbox's smoothstep.",
  "sdf-to-spline": "Hard SDF chain → its exact outline as Merge Paths geometry for the consumer (toolbox traces the contour on a resolution² grid); iso → an offset.",
};

function planSdfChains(
  order: string[],
  st: Map<string, NodeState>,
  byId: Map<string, PlanNode>,
  inputsOf: Map<string, Wire[]>,
  outputsOf: Map<string, Wire[]>,
  input: AePlanInput,
  tracksOf: (id: string) => AePlanTrack[]
): Set<string> {
  const g: SdfChainGraph = {
    type: (id) => byId.get(id)?.type,
    values: (id) => input.valuesOf(id),
    input(id, socket) {
      const w = (inputsOf.get(id) ?? []).find((x) => x.toHandle === `in:${socket}`);
      return w ? { id: w.fromId, handle: w.fromHandle } : undefined;
    },
    animated: (id) =>
      new Set([
        ...(byId.get(id)?.keyframed ?? []),
        ...tracksOf(id).map((t) => t.param),
        ...(inputsOf.get(id) ?? []).filter((w) => w.toHandle.startsWith("param:")).map((w) => w.toHandle.slice(6)),
      ]),
  };
  const native = new Set<string>();
  const consumers: string[] = [];
  for (const id of order) {
    const s = st.get(id)!;
    if (!SDF_NATIVE_CONSUMERS.has(s.node.type) || s.entry.class === "bake" || s.entry.class === "unsupported") continue;
    const v = sdfChainVerdict(id, g);
    if (v.native) {
      consumers.push(id);
      for (const x of v.nodes) native.add(x);
      s.entry = { class: "vector", ae: "shape:merge", fidelity: "approx", note: SDF_CONSUMER_NOTE[s.node.type] };
      s.requires = new Set();
      for (const n of v.notes) s.notes.push(n);
      continue;
    }
    const at = `${v.type} (${v.node}): ${v.reason}`;
    if (s.node.type === "sdf-to-spline") {
      s.entry = { class: "bake", ae: "layer:footage", fidelity: "bake", requires: ["footage"], note: `SDF chain AE can't draw — ${at}. Its contour is traced on the GPU per frame, so it bakes with what it feeds.` };
      s.requires = new Set(["footage"]);
    } else s.notes.push(`SDF chain stays a shader region — ${at}.`);
  }
  // A tree node that also feeds something outside the native trees (another
  // consumer's shader region) keeps its shader class there.
  const ok = (x: string) => native.has(x) || consumers.includes(x);
  for (let changed = true; changed; ) {
    changed = false;
    for (const x of [...native])
      if ((outputsOf.get(x) ?? []).some((w) => !ok(w.toId))) {
        native.delete(x);
        changed = true;
      }
  }
  for (const x of native) {
    const s = st.get(x);
    if (!s) continue;
    const m = SDF_AE[s.node.type];
    s.entry = { class: "vector", ae: m?.ae ?? "shape:group", fidelity: "exact", note: `SDF tree node ${m?.note ?? "→ shape-layer geometry."}` };
    s.requires = new Set();
  }
  return native;
}

function layerWindows(L: AePlanLayerInput, durationFrames: number): AePlanWindow[] {
  const end = Math.max(1, Math.round(durationFrames));
  const ws = (L.windows ?? [])
    .map((w) => ({
      inFrame: Math.max(0, Math.round(w.inFrame)),
      outFrame: Math.min(end, Math.round(w.outFrame)),
      sourceInFrame: Math.round(w.sourceInFrame ?? 0),
    }))
    .filter((w) => w.outFrame > w.inFrame)
    .sort((a, b) => a.inFrame - b.inFrame);
  return ws.length ? ws : [{ inFrame: 0, outFrame: end, sourceInFrame: 0 }];
}

// Param- and policy-driven refinements of a node's static entry.
function refine(s: NodeState, values: Record<string, unknown>, tracks: AePlanTrack[], policy: AeExportPolicy): void {
  const t = s.node.type;
  const keyed = new Set([...(s.node.keyframed ?? []), ...tracks.map((x) => x.param)]);
  const rampKeyed = [...keyed].some((k) => RAMP_KEY_RE.test(k));
  const bakeFor = (note: string) => {
    s.entry = { class: "bake", ae: "layer:footage", fidelity: "bake", requires: ["footage"], note };
    s.requires = new Set(["footage"]);
  };
  const toShader = (note: string, approx = false) => {
    s.entry = { class: "shader", ae: TBX_SHADER_MATCH_NAME, fidelity: approx ? "approx" : "exact", requires: ["host"], note };
    s.requires = new Set(["host"]);
  };

  if (t === "gradient") {
    const mode = String(values.mode ?? "linear");
    if (mode !== "linear" && mode !== "radial") toShader(`Gradient mode ${mode} has no Gradient Ramp form — fused shader.`);
  } else if (t === "blur" || t === "gaussian-blur") {
    const mode = String(values.mode ?? "gaussian");
    if (mode === "bokeh")
      s.entry = { ...s.entry, ae: "ADBE Camera Lens Blur", note: "Bokeh blur → Camera Lens Blur (iris shape/rotation map; radius calibrated in convert/)." };
    else if (mode === "convolve" && isGlslFusable(t)) toShader("Convolve blur has no AE effect — fused shader (one-pass approximation).", true);
  } else if (t === "merge") {
    const lays = Array.isArray(values.layers) ? (values.layers as { mode?: unknown }[]) : [];
    const missing = [...new Set(lays.map((l) => String(l?.mode ?? "normal")).filter((m) => AE_MISSING_BLEND_MODES.has(m)))];
    if (missing.length)
      toShader(`Blend mode${missing.length > 1 ? "s" : ""} ${missing.map(titleCase).join(", ")} ha${missing.length > 1 ? "ve" : "s"} no AE mode — the Merge fuses into a shader.`);
  } else if (t === "rectangle") {
    if (values.corner_style === "squircle" && num(values.corner_radius, 0) > 0)
      s.entry = { ...s.entry, fidelity: "approx", note: "Squircle corners have no AE form — Roundness (circular) approximates." };
  } else if (t === "transform") {
    if (values.tile === true)
      s.entry = { ...s.entry, ae: "ADBE Tile", fidelity: "approx", note: "Tiled transform → Motion Tile (approx: tile counts/unfold)." };
  } else if (t === "spline-stroke") {
    if (values.color_source === "ramp") {
      s.requires.add("ffx");
      s.notes.push("color_source ramp → Gradient Stroke with stops via a synthesized .ffx (static only), or one stroke per subpath for index/group ramps.");
    }
    if (values.thickness_source === "vary") {
      s.entry = { ...s.entry, fidelity: "approx", note: "Varying thickness → one stroke per subpath (index/random/group) or Stroke Taper (approx)." };
    } else if (num(values.repeats, 1) > 1) {
      s.entry = { ...s.entry, fidelity: "approx", note: "Stroke repeats → Offset Paths copies (approx spacing/overlap)." };
    }
    if (rampKeyed) bakeFor("Animated stroke ramp stops — AE gradient stops are not scriptable, so the stroke bakes.");
  } else if (t === "rasterize-spline") {
    if (values.fill_source === "gradient") {
      if (values.gradient_kind === "conic") bakeFor("Conic gradient fill — no AE gradient type and Rasterize Spline cannot fuse; bakes.");
      else {
        s.requires.add("ffx");
        s.notes.push("Gradient fill → Gradient Fill with stops via a synthesized .ffx (static only; headless builds skip presets).");
      }
    }
    if (rampKeyed && s.entry.class !== "bake") bakeFor("Animated gradient/ramp stops — AE gradient stops are not scriptable, so the fill bakes.");
  } else if (t === "text") {
    if (values.fillMode && values.fillMode !== "solid") bakeFor(`Text fill ${String(values.fillMode)} (gradient / image) has no plain text-layer form — the text bakes.`);
    const anims = Object.keys(values).filter((k) => /^anim_.*_enabled$/.test(k) && values[k] === true).map((k) => k.slice(5, -8));
    if (anims.length)
      s.notes.push("Text animators → AE text animators: a linear cascade is a Range Selector (exact), an eased one Ease High / Low within tolerance, random order and other easings an Expression Selector (exact).");
    const field = anims.filter((p) => values[`anim_${p}_driver`] === "field");
    if (field.length) bakeFor(`Text animator${field.length > 1 ? "s" : ""} ${field.join(", ")} driven by an image field — no AE selector samples an image per character; the text bakes.`);
    const shapeKeyed = anims.flatMap((p) => ["softness", "direction", "seed", "easing", "ease_intensity", "by", "driver"].filter((x) => keyed.has(`anim_${p}_${x}`)).map((x) => `${p} ${x}`));
    if (shapeKeyed.length) bakeFor(`Animated text animator ${shapeKeyed.join(", ")} — an AE selector's shape is built once; the text bakes.`);
    if (rampKeyed) bakeFor("Animated gradient text fill stops — bakes.");
  } else if (t === "random") {
    if (values.mode === "frame")
      s.entry = { ...s.entry, fidelity: "approx", note: "Frame mode re-rolls Math.random() every evaluation → AE's seedRandom(seed, false); random(): the same statistics, other numbers." };
  } else if (t === "math") {
    if (values.mode === "uv") s.notes.push("uv mode is a per-pixel shader, not a value — a driver through it is sampled.");
  } else if (t === "audio-source") {
    if (values.mode === "microphone")
      s.entry = { class: "unsupported", fidelity: "bake", requires: ["footage"], note: "Microphone input — record a take (it then bakes) or use a file." };
  } else if (s.entry.class === "shader" && rampKeyed) {
    // The host's ramps / curves are static LUT textures (§7.3).
    bakeFor(`Animated ramp stops on ${t} — the host's ramps are static LUTs (§7.3), so it bakes.`);
  }

  if (!policy.acceptApprox && s.entry.class === "effect" && s.entry.fidelity === "approx") {
    const was = s.entry.ae;
    if (isGlslFusable(t)) {
      s.entry = shaderEntryFor(t, s.entry);
      s.requires = new Set(["host"]);
      s.notes.push(`policy.acceptApprox = false — the ${was} approximation becomes a shader region.`);
    } else bakeFor(`policy.acceptApprox = false and ${t} cannot fuse — bakes instead of the ${was} approximation.`);
  }
}

function shaderEntryFor(type: string, from: AeExportEntry): AeExportEntry {
  const multipass = translationEntry(type).class === "multipass";
  return {
    class: "shader",
    ae: TBX_SHADER_MATCH_NAME,
    fidelity: multipass ? "approx" : "exact",
    requires: ["host"],
    note: multipass
      ? `Fused shader (one-pass approximation of the multipass ${type}).`
      : `Fused shader (instead of ${from.ae ?? "the AE stand-in"}).`,
  };
}

function segmentKind(s: NodeState, hasMain: boolean): AeSegmentKind {
  switch (s.entry.class) {
    case "vector":
    case "style":
    case "mask":
      return "vector";
    case "layer":
      return "composite";
    case "instances":
      return "instances";
    case "text":
      return "text";
    case "shader":
      return "shader";
    case "bake":
    case "unsupported":
      return "bake";
    case "effect":
      return hasMain ? "raster" : "source";
    case "transform":
      return hasMain ? "raster" : "source"; // mid-chain → Transform effect; a Gizmo → a null layer
    default:
      return "raster";
  }
}

function joinable(prev: AeSegmentKind, cls: AeExportClass, kind: AeSegmentKind): boolean {
  if (cls === "transform") return true; // the layer transform (or a Transform effect mid-chain)
  if (prev === "vector") return kind === "vector";
  if (prev === "raster") return kind === "raster";
  if (prev === "instances") return kind === "instances";
  return false;
}

function aeLayerFor(kind: AeSegmentKind, s: NodeState, prev: SegmentBuild | undefined): AeLayerKind {
  switch (kind) {
    case "vector":
      return "shape";
    case "composite":
      return "precomp";
    case "text":
      return "text";
    case "shader":
      return "solid";
    case "bake":
      return "footage";
    case "instances":
      return s.node.type === "copy-to-points" ? "precomp" : "shape";
    case "source":
      return s.entry.ae === "layer:footage" ? "footage" : s.entry.ae === "layer:null" ? "null" : "solid";
    case "raster":
      return prev?.aeLayer ?? "adjustment";
  }
}

function anchorsHaveWidth(spline: unknown): boolean {
  const subs = (spline as { subpaths?: { anchors?: { width?: unknown }[] }[] } | undefined)?.subpaths;
  if (!Array.isArray(subs)) return false;
  return subs.some((sp) => (sp.anchors ?? []).some((a) => typeof a?.width === "number" && a.width !== 1));
}

// Instances a points wire carries: the host's evaluated count, else the
// source's params, through attribute/modifier nodes.
function instanceCount(
  w: Wire,
  input: AePlanInput,
  inputsOf: Map<string, Wire[]>,
  byId: Map<string, PlanNode>,
  depth = 0
): number | undefined {
  const known = input.countOf?.(w.from);
  if (known !== undefined) return known;
  const src = byId.get(w.fromId);
  if (!src || depth > 32) return undefined;
  const v = input.valuesOf(src.id);
  switch (src.type) {
    case "grid":
      return Math.max(0, Math.round(num(v.countX, 5))) * Math.max(0, Math.round(num(v.countY, 5)));
    case "scatter-points":
    case "points-on-path":
      return Math.max(0, Math.round(num(v.count, 0)));
    case "point":
      return Math.max(1, Math.round(num(v.count, 1)));
  }
  if (INSTANCE_PASSTHROUGH.has(src.type)) {
    const up = (inputsOf.get(src.id) ?? []).find((x) => x.toHandle === "in:points");
    return up ? instanceCount(up, input, inputsOf, byId, depth + 1) : undefined;
  }
  return undefined;
}

function bakeMB(codec: AeBakeCodec, width: number, height: number, frames: number): number {
  return round1((BAKE_BITS_PER_PIXEL[codec] * width * height * Math.max(1, frames)) / 8 / 1e6);
}

function ownShaderSummary(g: TranslationPlan, n: PlanNode): string {
  return [
    `${n.type}'s own shader → Toolbox Shader (no conversion; its params are the effect's controls)`,
    g.time.dependent ? `animated — parity frames ${g.time.frames.join(", ")}` : `static (frame ${g.time.frames[0]})`,
  ].join("; ");
}

function shaderSummary(g: TranslationPlan, nodes: string[], byId: Map<string, PlanNode>): string {
  const chain = nodes.map((x) => byId.get(x)?.type ?? x).join(" → ");
  const inputs = new Set(g.frontier.filter((f) => f.kind === "image").map((f) => f.from)).size;
  const channels = g.frontier.filter((f) => f.kind === "channel").length;
  const multipass = g.nodes.some((x) => x.class === "multipass");
  return [
    `${nodes.length} node${nodes.length === 1 ? "" : "s"} fused (${chain})`,
    `${inputs} layer input${inputs === 1 ? "" : "s"}${channels ? ` + ${channels} wired channel${channels === 1 ? "" : "s"}` : ""}`,
    `~${g.cost.evaluationsPerPixel} evals/px`,
    g.time.dependent ? `animated — parity frames ${g.time.frames.join(", ")}` : `static (frame ${g.time.frames[0]})`,
    ...(multipass ? ["multipass one-pass approximation"] : []),
    ...(g.warnings.length ? [`${g.warnings.length} GLSL warning${g.warnings.length === 1 ? "" : "s"} — run plan_glsl_translation on ${g.target.id}`] : []),
  ].join("; ");
}

// ---------------------------------------------------------------------------
// The readable report (plan_ae_export's text, the modal's summary)
// ---------------------------------------------------------------------------

export function describeAePlan(plan: AeExportPlan): string {
  const all = plan.layers.flatMap((l) => l.nodes.map((n) => ({ ...n, layer: l.name })));
  const name = (n: { id: string; type: string; name?: string }) => `${n.name ?? n.type} (${n.id})`;
  const list = (xs: string[], max = 12) => (xs.length ? `${xs.slice(0, max).join(", ")}${xs.length > max ? `, … +${xs.length - max}` : ""}` : "none");
  const native = all.filter((n) => n.class !== "shader" && n.class !== "bake" && n.class !== "unsupported" && n.fidelity !== "approx");
  const c = plan.composition;
  const lines = [
    `After Effects export plan — route: ${plan.route}`,
    `Composition "${c.name}": ${c.width}×${c.height} @ ${c.fps} fps, ${c.durationFrames} frames; ${plan.layers.length} layer${plan.layers.length === 1 ? "" : "s"}; policy ${plan.policy.fidelity}/${plan.policy.color}${plan.policy.shaderHost ? "" : ", no shader host"}${plan.policy.acceptApprox ? "" : ", approximations refused"}.`,
    `Native (${native.length}): ${list(native.map(name))}`,
    `Approx (${plan.approximations.length}): ${plan.approximations.length ? plan.approximations.map((a) => `${a.type} (${a.id}) — ${a.note}`).join(" | ") : "none"}`,
    `Shader (${plan.shaderRegions.length}): ${plan.shaderRegions.length ? plan.shaderRegions.map((r) => `${r.id} → ${r.target}: ${r.summary ?? r.nodes.join(", ")}`).join(" | ") : "none"}`,
    `Baked (${plan.bakes.length}): ${plan.bakes.length ? plan.bakes.map((b) => `${b.id} ${b.output} frames ${b.frames[0]}–${b.frames[1]} ${b.codec} ≈${b.estimatedMB} MB — ${b.reason}`).join(" | ") : "none"}`,
    `Blocked (${plan.blocked.length}): ${plan.blocked.length ? plan.blocked.map((b) => `${b.type} (${b.id}) — ${b.reason}`).join(" | ") : "none"}`,
    `Expressions: ${plan.expressions.length}${plan.expressions.some((e) => e.sampled) ? ` (${plan.expressions.filter((e) => e.sampled).length} sampled to per-frame keys)` : ""}. Fonts: ${plan.fonts.length ? plan.fonts.join(", ") : "none"}. Estimates: ~${plan.estimates.layers} AE layers, ~${plan.estimates.keyframes} keys, ≈${plan.estimates.footageMB} MB footage.`,
  ];
  if (plan.warnings.length) lines.push("Warnings:", ...plan.warnings.map((w) => `- ${w}`));
  return lines.join("\n");
}
