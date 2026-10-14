// Stage splitting — the cost model's over-budget path
// (specdocs/101326_skia-target.md §3.3, "built and measured").
//
// A fused program re-evaluates a gather's upstream once per TAP (fuse.ts:
// `$src(uv2)` calls the upstream's function again), so a 9-tap sharpen over
// a 4-unit noise costs 36 units per pixel and a 113-tap kuwahara 452 before
// its own math. When the program is over the phone budget
// (PHONE_PIXEL_BUDGET, helpers-gather.ts) the splitter renders the upstream
// ONCE into an offscreen layer and lets the gather read that layer instead:
//
//   fill(K(U))   →   group { layer: [runtime filter K(content)] }
//                      └─ fill(U)            (blendMode src, default paint)
//
// The group is React Native Skia's `<Group layer={<Paint><RuntimeShader/>
// </Paint>}>`: the layer renders U's own fused program, then the runtime
// image filter runs K's program once per pixel over it, reading the layer
// through its one child shader, `content` (scene-ir.ts ImageFilterIR
// runtime). Preview and export read this same IR: scene-render.ts draws it
// (emulating the runtime filter over a snapshot, as CanvasKit has no factory
// for it) and scene-emit.ts emits it, so the editor shows what ships.
//
// Reading the layer. Every gather already clamps its sample point to the
// outermost texel centres (tbx_texel_clamp, library/texel.ts). A tap ON the
// pixel grid (sharpen, edge detect, kuwahara: SkslLibFunctionDef.gridTaps)
// then lands exactly on a texel centre: one fetch returns what the fused
// program computed there, quantized to the layer's 8-bit premultiplied
// pixel. A tap OFF the grid (flow blur, displace, a bevel's soften-scaled
// stencil, any tap inside an off-grid gather) reads tbx.split.bilinear@1:
// the four texel centres around it, mixed — the GL texture's LINEAR +
// CLAMP_TO_EDGE rule, which the GL node the port mirrors uses too. Either
// way the program only ever fetches texel centres, so the result does not
// depend on the sampler (the preview's emulation samples nearest, native
// Skia linear).
//
// The decision is STRUCTURAL, like the fuser's SkSL: declared taps and
// costs (estimateShaderCost's default), never bind values, so animating a
// radius can't flip a split on at some frame and change the exported
// scene's structure (scene-plan.ts refuses that). The `at: "params"` readout
// says what the current values really cost.
//
// Greedy. While a stage costs more than the budget, try every distinct
// upstream U that feeds a gather input, as a split: the stage's program
// with every read of U replaced by the layer (per slot: a fetch or the
// bilinear) and U as the layer's own program. Take the one that saves the
// most (old − new filter − U − SPLIT_LAYER_COST), if any saves anything,
// then plan both halves again — U may itself be over budget (a chain), and
// the new filter may have another gather whose upstream CONTAINS the layer
// (that upstream becomes the next, outer layer). A stage reads at most ONE
// layer (RN's <RuntimeShader> binds the rendered content as the program's
// only child) and no other child shader, so a split that would need a
// second layer or keep an image / gradient / SkSL Shader child in the
// filter is not taken. Fan-out comes for free: U is replaced wherever the
// stage reads it — several gathers, and plain (pure) reads — by one layer.
//
// A layer is a color image, so it clips straight values outside [0, 1]
// where the fused program (and the GL node's fp16 texture) keep them. An
// upstream containing an `unbounded` function (sharpen's overshoot, edge
// detect's magnitude × strength; registry.ts) is therefore never rendered
// into a layer — measured on Edge(Sharpen(noise)), clipping the sharpen
// would put 1 % of pixels ≥ 42/255 off the fused program; the planner
// stages the noise instead.
//
// What a split does not keep (documented in the Fill's facts and §3.3):
//   - precision: the layer is the canvas's format (8-bit unless the RN
//     canvas is highBitDepth); a fused program carries fp32 between the
//     upstream and the gather;
//   - off-grid taps: bilinear between texel centres where the fused program
//     saw the exact function (the GL node sees bilinear too);
//   - an enclosing Skia Group's opacity / blendMode reach the layer's
//     CONTENT draw (RN applies both per draw, and a layer composites
//     srcOver), not the filter's output. The Fill's own color alpha and
//     opacity do scale the output (tbx.split.paint@1); a Fill with its own
//     non-srcOver blendMode is not split (the IR's layer has no blend mode).

import type { Bind, PaintIR, RGBA, ShaderIR, SkiaNode, SkslProgramIR } from "./scene-ir";
import type { ShaderExpr } from "./shader-expr";
import { estimateShaderCost, fuseShader, shaderExprKey, type FuseOptions } from "./fuse";
import { getSkslFunction, registerSkslFunction, type SkslLibFunctionDef } from "./library/registry";
import { PHONE_PIXEL_BUDGET } from "./library/helpers-gather";
import { TEXEL_HELPER } from "./library/texel";

export { PHONE_PIXEL_BUDGET };

type CallExpr = Extract<ShaderExpr, { k: "call" }>;
type LeafExpr = Extract<ShaderExpr, { k: "leaf" }>;

// One offscreen layer per pixel, in cost units: an extra full-screen write
// and read of an 8-bit layer (≈ 24 MB/frame at 3 M px) — bandwidth, where
// the budget is ALU. An estimate, like the budget itself.
export const SPLIT_LAYER_COST = 2;

// ---- library functions the splitter emits ----------------------------------------

// An off-grid read of a layer: the four texel centres around `uv`, mixed —
// what a LINEAR, CLAMP_TO_EDGE texture returns, from centre fetches only.
// Its upstream is the layer (the stage's content child), read through the
// fuser's child wrapper (uv → Skia px, un-premultiply, working space →
// sRGB), so it mixes STRAIGHT sRGB, as the GL texture's texels are.
export const TBX_SPLIT_BILINEAR: SkslLibFunctionDef = {
  id: "tbx.split.bilinear@1",
  entry: "tbx_split_bilinear",
  source: `float4 tbx_split_bilinear(float2 uv, float2 res) {
  // uv arrives clamped by its reader (tbx_texel_clamp); clamp the centres anyway.
  float2 p = clamp(uv * res - 0.5, float2(0.0), res - 1.0);
  float2 i = floor(p);
  float2 f = p - i;
  float2 j = min(i + 1.0, res - 1.0);
  float2 a = tbx_texel_clamp((i + 0.5) / res, res);
  float2 b = tbx_texel_clamp((j + 0.5) / res, res);
  float4 c00 = $src(a);
  float4 c10 = $src(float2(b.x, a.y));
  float4 c01 = $src(float2(a.x, b.y));
  float4 c11 = $src(b);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}`,
  params: [],
  inputs: [{ name: "src", mode: "gather", taps: 4 }],
  uses: [TEXEL_HELPER],
  gridTaps: ["src"],
  cost: 0.2,
};

// The split Fill's paint on the filter's output: a Skia Fill's shader keeps
// its color's alpha and its opacity (scene-ir.ts PaintIR), which must fade
// the FILTERED result, not the layer's content. Straight alpha in and out;
// main's tbx_cm_out premultiplies.
export const TBX_SPLIT_PAINT: SkslLibFunctionDef = {
  id: "tbx.split.paint@1",
  entry: "tbx_split_paint",
  source: `float4 tbx_split_paint(float2 uv, float2 res, float4 color, float opacity, float4 src) {
  return float4(src.rgb, src.a * clamp(color.a, 0.0, 1.0) * clamp(opacity, 0.0, 1.0));
}`,
  params: [
    { name: "color", type: "color" },
    { name: "opacity", type: "float" },
  ],
  inputs: [{ name: "src", mode: "pure" }],
  cost: 0,
};

registerSkslFunction(TBX_SPLIT_BILINEAR);
registerSkslFunction(TBX_SPLIT_PAINT);

// ---- the plan ----------------------------------------------------------------------

// One program of a staged draw. `marker` is the leaf standing for the layer
// this stage reads (set iff `content` is): a transparent color leaf with a
// unique ref, removed from the fused program's children again — it is the
// RuntimeShader's `content`, not a child the IR lists.
export interface ShaderStage {
  expr: ShaderExpr;
  marker: LeafExpr | null;
  content: ShaderStage | null;
  // Some read of the layer is off the texel grid (tbx.split.bilinear@1).
  bilinear: boolean;
}

export interface StageCost {
  // fill = the innermost program (a plain Skia Fill shader); filter = a
  // runtime image filter over the stage inside it.
  role: "fill" | "filter";
  // Units per pixel: declared (what the split decided with) and at the
  // current bind values.
  declared: number;
  atParams: number;
  fused: string[];
  bilinear: boolean;
}

export interface StagePlanReport {
  budget: number;
  before: { declared: number; atParams: number };
  // Innermost first (the order the layers render). `total` adds
  // SPLIT_LAYER_COST per layer.
  stages: StageCost[];
  after: { declared: number; atParams: number };
  layers: number;
  // Over budget and no split saves anything (or none is allowed): why.
  notes: string[];
}

export interface StagePlanOptions {
  // Default PHONE_PIXEL_BUDGET.
  budget?: number;
  // Namespaces the layer markers (the Skia Fill's node id).
  id: string;
}

const declaredCost = (e: ShaderExpr) => estimateShaderCost(e).cost;
const paramsCost = (e: ShaderExpr) => estimateShaderCost(e, { at: "params" }).cost;

function isGatherInput(fn: SkslLibFunctionDef | undefined, name: string): boolean {
  return fn?.inputs.find((i) => i.name === name)?.mode === "gather";
}

// Is a gather input OFF the texel grid even when its function is on it?
function offGridInput(fn: SkslLibFunctionDef | undefined, name: string): boolean {
  return isGatherInput(fn, name) && !(fn?.gridTaps ?? []).includes(name);
}

type Kind = "grid" | "off";

// Where each subexpression is evaluated: at pixel centres ("grid": main, and
// on-grid taps from there) and/or off them ("off": inside an off-grid
// gather, or an on-grid gather evaluated off-grid).
function coordKinds(root: ShaderExpr): Map<string, Set<Kind>> {
  const kinds = new Map<string, Set<Kind>>();
  const stack: [ShaderExpr, Kind][] = [[root, "grid"]];
  let guard = 0;
  while (stack.length && guard++ < 100_000) {
    const [e, k] = stack.pop()!;
    const key = shaderExprKey(e);
    let s = kinds.get(key);
    if (!s) kinds.set(key, (s = new Set()));
    if (s.has(k)) continue;
    s.add(k);
    if (e.k !== "call") continue;
    const fn = getSkslFunction(e.fn);
    for (const [name, child] of Object.entries(e.inputs)) stack.push([child, offGridInput(fn, name) ? "off" : k]);
  }
  return kinds;
}

// Every distinct call that feeds a gather input somewhere, in a
// deterministic (depth-first, input order) sequence.
function gatherUpstreams(root: ShaderExpr): CallExpr[] {
  const out: CallExpr[] = [];
  const seen = new Set<string>();
  const taken = new Set<string>();
  const visit = (e: ShaderExpr, depth: number) => {
    if (e.k !== "call" || depth > 256) return;
    const key = shaderExprKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    const fn = getSkslFunction(e.fn);
    for (const [name, child] of Object.entries(e.inputs)) {
      if (isGatherInput(fn, name) && child.k === "call" && child.fn !== TBX_SPLIT_BILINEAR.id) {
        const ck = shaderExprKey(child);
        if (!taken.has(ck)) {
          taken.add(ck);
          out.push(child);
        }
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

// A call in `root` whose output can leave [0, 1] (SkslLibFunctionDef
// `unbounded`): its node id, or null. Conservative — any such call inside
// the expression, whatever comes after it.
function unboundedIn(root: ShaderExpr): string | null {
  const seen = new Set<string>();
  const visit = (e: ShaderExpr): string | null => {
    if (e.k !== "call") return null;
    const k = shaderExprKey(e);
    if (seen.has(k)) return null;
    seen.add(k);
    if (getSkslFunction(e.fn)?.unbounded) return e.node;
    for (const c of Object.values(e.inputs)) {
      const hit = visit(c);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root);
}

function containsKey(root: ShaderExpr, key: string): boolean {
  const seen = new Set<string>();
  const visit = (e: ShaderExpr): boolean => {
    const k = shaderExprKey(e);
    if (k === key) return true;
    if (e.k !== "call" || seen.has(k)) return false;
    seen.add(k);
    return Object.values(e.inputs).some(visit);
  };
  return visit(root);
}

// Child shaders (leaves / SkSL programs) other than `allowed` (a marker key).
function foreignChildren(root: ShaderExpr, allowed: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (e: ShaderExpr) => {
    const k = shaderExprKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    if (e.k === "call") Object.values(e.inputs).forEach(visit);
    else if (k !== allowed) out.push(e.k === "program" ? `SkSL Shader ${e.node}` : `a ${e.shader.k} shader`);
  };
  visit(root);
  return out;
}

// `root` with every read of `targetKey` replaced by the layer: `content`
// where the read is at texel centres, `bilinear` (over `content`) where it
// is not. Calls are rebuilt once per node id (same object everywhere it
// appears), as the fuser requires.
function replaceUpstream(
  root: ShaderExpr,
  targetKey: string,
  content: LeafExpr,
  bilinear: CallExpr
): { expr: ShaderExpr; bilinear: boolean } {
  const kinds = coordKinds(root);
  const memo = new Map<string, ShaderExpr>();
  let usedBilinear = false;
  const rebuild = (e: ShaderExpr, depth: number): ShaderExpr => {
    if (e.k !== "call" || depth > 256) return e;
    const key = shaderExprKey(e);
    const hit = memo.get(key);
    if (hit) return hit;
    const fn = getSkslFunction(e.fn);
    const here = kinds.get(key) ?? new Set<Kind>(["grid"]);
    const inputs: Record<string, ShaderExpr> = {};
    let changed = false;
    for (const [name, child] of Object.entries(e.inputs)) {
      if (shaderExprKey(child) === targetKey) {
        const off = offGridInput(fn, name) || here.has("off");
        if (off) usedBilinear = true;
        inputs[name] = off ? bilinear : content;
        changed = true;
      } else {
        const r = rebuild(child, depth + 1);
        inputs[name] = r;
        if (r !== child) changed = true;
      }
    }
    const out: ShaderExpr = changed ? { ...e, inputs } : e;
    memo.set(key, out);
    return out;
  };
  return { expr: rebuild(root, 0), bilinear: usedBilinear };
}

function markerFor(id: string, upstream: CallExpr): { marker: LeafExpr; bilinear: CallExpr } {
  const tag = `${id}~layer:${upstream.node}`;
  const marker: LeafExpr = {
    k: "leaf",
    shader: { k: "color", color: { v: [0, 0, 0, 0], ref: { node: tag, param: SPLIT_CONTENT_PARAM } } },
  };
  const bilinear: CallExpr = { k: "call", fn: TBX_SPLIT_BILINEAR.id, node: `${tag}~bilinear`, params: {}, inputs: { src: marker } };
  return { marker, bilinear };
}

// The ref param that marks a layer leaf (never a real param).
export const SPLIT_CONTENT_PARAM = "__tbx_split_content";

function isMarkerShader(s: ShaderIR): boolean {
  return s.k === "color" && s.color.ref?.param === SPLIT_CONTENT_PARAM;
}

// Plan the stages of one Skia Fill's shader. Never throws; a stage tree with
// no `content` means "draw it fused" (in budget, or nothing helps).
export function planShaderStages(expr: ShaderExpr, opts: StagePlanOptions): { plan: ShaderStage; notes: string[] } {
  const budget = opts.budget ?? PHONE_PIXEL_BUDGET;
  const notes: string[] = [];
  const plan = (e: ShaderExpr, inner: { stage: ShaderStage; marker: LeafExpr; bilinear: boolean } | null, depth: number): ShaderStage => {
    const stage: ShaderStage = { expr: e, marker: inner?.marker ?? null, content: inner?.stage ?? null, bilinear: inner?.bilinear ?? false };
    if (e.k !== "call" || depth > 32) return stage;
    const cost = declaredCost(e);
    if (cost <= budget) return stage;
    const oldMarker = stage.marker ? shaderExprKey(stage.marker) : null;
    let best: { gain: number; upstream: CallExpr; filter: ShaderExpr; marker: LeafExpr; bilinear: boolean } | null = null;
    const blocked: string[] = [];
    for (const u of gatherUpstreams(e)) {
      // A stage reads one layer: an upstream that doesn't contain the layer
      // this stage already reads would need a second one.
      if (oldMarker && !containsKey(u, oldMarker)) continue;
      // A layer is a color image: it would clip an overshooting upstream.
      const over = unboundedIn(u);
      if (over) {
        blocked.push(`not at ${u.node}: ${over === u.node ? "its" : `${over}'s`} output can leave [0, 1], which a layer would clip`);
        continue;
      }
      const m = markerFor(opts.id, u);
      const r = replaceUpstream(e, shaderExprKey(u), m.marker, m.bilinear);
      const foreign = foreignChildren(r.expr, shaderExprKey(m.marker));
      if (foreign.length) {
        blocked.push(`splitting at ${u.node} would leave ${foreign.join(", ")} in the filter (a RuntimeShader filter's only child is the layer)`);
        continue;
      }
      const gain = cost - declaredCost(r.expr) - declaredCost(u) - SPLIT_LAYER_COST;
      if (!best || gain > best.gain) best = { gain, upstream: u, filter: r.expr, marker: m.marker, bilinear: r.bilinear };
    }
    const fresh = blocked.filter((b) => !notes.includes(`skipped a split ${b}`));
    if (!best || best.gain <= 0) {
      notes.push(
        `${depth === 0 ? "" : "a stage: "}${cost.toFixed(1)} units/px is over the ${budget}-unit budget and ${best ? `no split saves anything (best: ${best.upstream.node}, ${best.gain.toFixed(1)})` : "no gather upstream can be split"}${fresh.length ? `; ${fresh.join("; ")}` : ""}`
      );
      return stage;
    }
    for (const b of fresh) notes.push(`skipped a split ${b}`);
    const contentStage = plan(best.upstream, inner, depth + 1);
    return plan(best.filter, { stage: contentStage, marker: best.marker, bilinear: best.bilinear }, depth + 1);
  };
  return { plan: plan(expr, null, 0), notes };
}

// The plan's cost readout (innermost stage first).
export function reportShaderStages(expr: ShaderExpr, plan: ShaderStage, notes: string[], budget = PHONE_PIXEL_BUDGET): StagePlanReport {
  const stages: StageCost[] = [];
  const walk = (s: ShaderStage) => {
    if (s.content) walk(s.content);
    stages.push({
      role: s.content ? "filter" : "fill",
      declared: declaredCost(s.expr),
      atParams: paramsCost(s.expr),
      fused: fusedIds(s.expr),
      bilinear: s.bilinear,
    });
  };
  walk(plan);
  const layers = stages.length - 1;
  const sum = (k: "declared" | "atParams") => stages.reduce((a, s) => a + s[k], 0) + layers * SPLIT_LAYER_COST;
  return {
    budget,
    before: { declared: declaredCost(expr), atParams: paramsCost(expr) },
    stages,
    after: { declared: sum("declared"), atParams: sum("atParams") },
    layers,
    notes,
  };
}

function fusedIds(e: ShaderExpr): string[] {
  const ids = new Set<string>();
  const seen = new Set<string>();
  const visit = (x: ShaderExpr) => {
    const k = shaderExprKey(x);
    if (seen.has(k)) return;
    seen.add(k);
    if (x.k === "call") {
      ids.add(x.fn);
      Object.values(x.inputs).forEach(visit);
    } else if (x.k === "leaf" && isMarkerShader(x.shader)) ids.add("layer");
  };
  visit(e);
  return [...ids];
}

// ---- IR ----------------------------------------------------------------------------

export interface StagedFillPaint {
  color: Bind<RGBA>;
  opacity: Bind<number>;
}

export interface StagedDraw {
  node: SkiaNode;
  // Every program in it (layer content fills and filters), innermost first.
  programs: SkslProgramIR[];
}

// The staged draw for a plan with at least one layer: groups with a runtime
// filter, the innermost a Skia Fill (blendMode src into its fresh layer).
// The outermost filter carries the Fill's paint alpha (tbx.split.paint@1).
// Returns problems instead when a stage doesn't fuse into the shape the IR
// needs (never expected — the planner checked the children).
export function buildStagedDraw(
  plan: ShaderStage,
  id: string,
  paint: StagedFillPaint,
  opts: FuseOptions
): { draw: StagedDraw; problems: [] } | { draw: null; problems: string[] } {
  const programs: SkslProgramIR[] = [];
  const problems: string[] = [];
  const build = (s: ShaderStage, outer: boolean): SkiaNode | null => {
    if (!s.content || !s.marker) {
      const f = fuseShader(s.expr, opts);
      if (!f.shader) {
        problems.push(...f.problems);
        return null;
      }
      if (f.shader.k === "runtime") programs.push(f.shader.program);
      const p: PaintIR = { style: "fill", shader: f.shader, blendMode: "src" };
      return { k: "fill", id, paint: p };
    }
    const inner = build(s.content, false);
    if (!inner) return null;
    const expr: ShaderExpr = outer
      ? { k: "call", fn: TBX_SPLIT_PAINT.id, node: id, params: { color: paint.color as Bind<number[]>, opacity: paint.opacity }, inputs: { src: s.expr } }
      : s.expr;
    const f = fuseShader(expr, opts);
    if (!f.shader) {
      problems.push(...f.problems);
      return null;
    }
    if (f.shader.k !== "runtime") {
      problems.push(`stage ${id}: the filter did not fuse into a runtime program`);
      return null;
    }
    const marker = s.marker.shader;
    const kids = f.shader.program.children;
    const layer = kids.find((c) => c.shader === marker);
    const others = kids.filter((c) => c.shader !== marker);
    if (!layer || others.length) {
      problems.push(`stage ${id}: a runtime filter must read the layer as its only child (got ${kids.map((c) => c.name).join(", ") || "none"})`);
      return null;
    }
    const program: SkslProgramIR = { ...f.shader.program, children: [] };
    programs.push(program);
    return { k: "group", id, layer: { imageFilters: [{ k: "runtime", program, content: layer.name }] }, children: [inner] };
  };
  const node = build(plan, true);
  if (!node) return { draw: null, problems: problems.length ? problems : [`stage ${id}: nothing to draw`] };
  return { draw: { node, programs }, problems: [] };
}

// Does a staged draw (or any node) read iTime in any program? (Skia Fill's
// fingerprint folds the clock in when it does.)
export function stageProgramsOf(node: SkiaNode): ShaderIR[] {
  const out: ShaderIR[] = [];
  const visit = (n: SkiaNode) => {
    if (n.k === "group") {
      for (const f of n.layer?.imageFilters ?? []) if (f.k === "runtime") out.push({ k: "runtime", program: f.program });
      n.children.forEach(visit);
    } else if (n.k === "fill" && n.paint.shader) out.push(n.paint.shader);
  };
  visit(node);
  return out;
}
