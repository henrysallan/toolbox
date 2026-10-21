// planAeExport (src/lib/ae-export/plan.ts, spec §6) on fixture graphs built
// from the REAL registry: the routes, regions, bakes, blockers, budgets and
// windows the analysis promises, plus determinism.

import { makeChecker, loadRegistry } from "./harness.mts";
import type { AeExportPlan, AeExportPolicy, AePlanWindow } from "@/lib/ae-export/types";
import type { AePlanInput, AePlanLayerInput, AePlanTrack, PlanEdge, PlanNodeInfo } from "@/lib/ae-export/plan";

interface FxNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  tracks?: AePlanTrack[];
  parent?: string;
}
interface FxLayer {
  id: string;
  name?: string;
  nodes: FxNode[];
  edges: PlanEdge[];
  output?: string;
  blendMode?: string;
  windows?: AePlanWindow[];
}

export default async function run(): Promise<number> {
  const c = makeChecker("plan");
  await loadRegistry();
  const { getNodeDef } = await import("@/engine/registry");
  const { withMaskInput } = await import("@/engine/conventions");
  const { SETTABLE_PARAM_TYPES } = await import("@/engine/node-catalog");
  const { planAeExport, describeAePlan } = await import("@/lib/ae-export/plan");

  const info = (type: string, params: Record<string, unknown>): PlanNodeInfo => {
    const def = getNodeDef(type);
    if (!def) throw new Error(`fixture uses unknown type ${type}`);
    let ins = def.inputs;
    try {
      ins = def.resolveInputs?.(params) ?? def.inputs;
    } catch {
      ins = def.inputs;
    }
    ins = withMaskInput(ins, def);
    return {
      inputs: ins.map((i) => ({ name: i.name, type: i.type as string })),
      primaryOutput: (def.primaryOutput ?? undefined) as string | undefined,
      auxOutputs: (def.auxOutputs ?? []).map((a) => ({ name: a.name, type: a.type as string })),
      readsTime: !!def.facts?.reads?.includes("time"),
      simulation: !!def.simulation,
      params: def.params
        .filter((p) => SETTABLE_PARAM_TYPES.has(p.type))
        .map((p) => ({ name: p.name, type: p.type as string, min: p.min, max: p.max, options: p.options as string[] | undefined, default: p.default })),
    };
  };
  const defaults = (type: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const p of getNodeDef(type)!.params) out[p.name] = p.default;
    return out;
  };

  // Fresh objects every call — determinism must not lean on object identity.
  const build = (layers: FxLayer[], policy?: Partial<AeExportPolicy>, extra: Partial<AePlanInput> = {}): AePlanInput => {
    const all = layers.flatMap((l) => l.nodes);
    const values = new Map(all.map((n) => [n.id, { ...defaults(n.type), ...(n.params ?? {}) }]));
    const byId = new Map(all.map((n) => [n.id, n]));
    const planLayers: AePlanLayerInput[] = layers.map((l) => ({
      id: l.id,
      name: l.name ?? l.id,
      nodes: l.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        params: { ...(n.params ?? {}) },
        keyframed: (n.tracks ?? []).map((t) => t.param),
        ...(n.parent ? { parent: n.parent } : {}),
      })),
      edges: l.edges.map((e) => ({ ...e })),
      output: l.output,
      ...(l.blendMode ? { blendMode: l.blendMode } : {}),
      ...(l.windows ? { windows: l.windows.map((w) => ({ ...w })) } : {}),
    }));
    return {
      composition: { id: "comp-1", name: "Main", width: 1920, height: 1080, fps: 30, durationFrames: 120 },
      layers: planLayers,
      infoOf: (id) => {
        const n = byId.get(id);
        return n && getNodeDef(n.type) ? info(n.type, values.get(id)!) : undefined;
      },
      valuesOf: (id) => values.get(id) ?? {},
      tracksOf: (id) => (byId.get(id)?.tracks ?? []).map((t) => ({ ...t, frames: [...t.frames], easings: [...t.easings] })),
      ...(policy ? { policy } : {}),
      ...extra,
    };
  };
  const one = (l: Omit<FxLayer, "id">, policy?: Partial<AeExportPolicy>, extra?: Partial<AePlanInput>) =>
    planAeExport(build([{ id: "layer-1", name: "Layer 1", ...l }], policy, extra));
  const node = (p: AeExportPlan, id: string) => p.layers.flatMap((l) => l.nodes).find((n) => n.id === id);

  // --- (A) circle → transform (keys) → fill + spline mask ⇒ direct --------------------
  const fxA: Omit<FxLayer, "id"> = {
    nodes: [
      { id: "circle", type: "circle" },
      {
        id: "xf",
        type: "transform",
        params: { mode: "spline" },
        tracks: [
          { param: "translateX", frames: [0, 30, 60], easings: ["easeOutBack", "easeInOutSine", "linear"], type: "scalar" },
          { param: "rotate", frames: [0, 60], easings: ["easeOutCubic", "linear"], type: "scalar" },
        ],
      },
      { id: "fill", type: "spline-fill" },
      { id: "rect", type: "rectangle" },
    ],
    edges: [
      { from: "circle:out", to: "xf:in:image" },
      { from: "xf:out", to: "fill:in:path" },
      { from: "rect:out", to: "fill:in:mask" },
    ],
    output: "fill:out",
  };
  {
    const p = one(fxA);
    c.check("(A) circle → transform keys → fill + spline mask routes direct", p.route === "direct", p.route);
    c.check("(A) no shader regions, bakes or blockers", !p.shaderRegions.length && !p.bakes.length && !p.blocked.length, JSON.stringify({ s: p.shaderRegions, b: p.bakes, x: p.blocked }));
    c.check(
      "(A) the only approximations are easing best-fit notes",
      p.approximations.length >= 1 && p.approximations.every((a) => /best-fit/.test(a.note)),
      JSON.stringify(p.approximations)
    );
    c.check("(A) easeInOutSine is the named best fit; easeOutBack / easeOutCubic are exact", p.approximations.some((a) => a.note.includes("easeInOutSine")) && !p.approximations.some((a) => /Back|Cubic/.test(a.note)));
    const L = p.layers[0];
    c.check("(A) one vector segment → one shape layer holding all four nodes", L.segments.length === 1 && L.segments[0].kind === "vector" && L.segments[0].aeLayer === "shape" && ["circle", "xf", "fill", "rect"].every((x) => L.segments[0].nodes.includes(x)), JSON.stringify(L.segments));
    c.check("(A) the spline into the mask socket is a layer mask path", node(p, "rect")?.class === "mask" && node(p, "rect")?.ae === "mask:path" && node(p, "rect")?.fidelity === "exact");
    c.check("(A) circle stays a parametric ellipse; transform is the layer transform", node(p, "circle")?.ae === "shape:ellipse" && node(p, "xf")?.class === "transform");
    c.check("(A) segment output is the layer output", L.segments[0].output === "fill:out", L.segments[0].output);
    c.check("(A) keyframes counted (5 keys)", p.estimates.keyframes >= 5, String(p.estimates.keyframes));
    const ex = one(fxA, { fidelity: "exact" });
    c.check("(A) Exact policy: no approximations, more keys", ex.approximations.length === 0 && ex.estimates.keyframes > p.estimates.keyframes, JSON.stringify({ a: ex.approximations, k: [ex.estimates.keyframes, p.estimates.keyframes] }));
    c.check("(A) report text names the route and the native nodes", describeAePlan(p).startsWith("After Effects export plan — route: direct") && describeAePlan(p).includes("Native (4)"), describeAePlan(p).slice(0, 300));
  }

  // --- (B) noise → color-ramp → displace ⇒ exactly one shader region ------------------
  const fxB: Omit<FxLayer, "id"> = {
    nodes: [
      { id: "noise", type: "noise", params: { scale: 3 } },
      { id: "ramp", type: "color-ramp" },
      { id: "noise2", type: "noise", params: { seed: 7 } },
      { id: "disp", type: "displace", params: { amountX: 0.05 } },
    ],
    edges: [
      { from: "noise:out", to: "ramp:in:image" },
      { from: "ramp:out", to: "disp:in:image" },
      { from: "noise2:out", to: "disp:in:displacement" },
    ],
    output: "disp:out",
  };
  {
    const p = one(fxB);
    c.check("(B) noise → color-ramp → displace is exactly one shader region", p.shaderRegions.length === 1, JSON.stringify(p.shaderRegions));
    const r = p.shaderRegions[0];
    c.check("(B) the region fuses all four nodes and targets the layer output", !!r && ["noise", "ramp", "noise2", "disp"].every((x) => r.nodes.includes(x)) && r.target === "disp:out", JSON.stringify(r));
    c.check("(B) route direct+shader; displace fused instead of the Displacement Map approx", p.route === "direct+shader" && node(p, "disp")?.class === "shader" && !p.approximations.some((a) => a.id === "disp"), JSON.stringify({ route: p.route, disp: node(p, "disp"), approx: p.approximations }));
    c.check("(B) the region embeds a planTranslation summary and parity frames", !!r?.summary && /4 nodes fused/.test(r.summary) && r.frames.length >= 1, r?.summary);
    c.check("(B) one shader segment on a solid", p.layers[0].segments.length === 1 && p.layers[0].segments[0].kind === "shader" && p.layers[0].segments[0].aeLayer === "solid", JSON.stringify(p.layers[0].segments));

    // shaderHost: false ⇒ the region bakes.
    const nh = one(fxB, { shaderHost: false });
    c.check("(B') shaderHost false routes direct+bake with no shader regions", nh.route === "direct+bake" && nh.shaderRegions.length === 0 && nh.bakes.length >= 1, JSON.stringify({ route: nh.route, bakes: nh.bakes }));
    c.check("(B') every shader node is baked; displace stays a native approx effect on the footage", ["noise", "ramp", "noise2"].every((x) => node(nh, x)?.class === "bake") && node(nh, "disp")?.class === "effect", JSON.stringify(nh.layers[0].nodes.map((n) => [n.id, n.class])));
    c.check("(B') bake reasons name the missing host", nh.bakes.every((b) => /shaderHost/.test(b.reason)), JSON.stringify(nh.bakes.map((b) => b.reason)));
  }

  // --- (C) particles → particles-to-image ⇒ bake ------------------------------------------
  {
    const p = one({
      nodes: [
        { id: "sim", type: "particle-simulator" },
        { id: "p2i", type: "particles-to-image" },
      ],
      edges: [{ from: "sim:out", to: "p2i:in:particles" }],
      output: "p2i:out",
    });
    c.check("(C) particles → particles-to-image routes direct+bake", p.route === "direct+bake", p.route);
    const b = p.bakes[0];
    c.check("(C) one bake of p2i:out over the whole comp, simulation absorbed", p.bakes.length === 1 && b.output === "p2i:out" && b.frames[0] === 0 && b.frames[1] === 119 && node(p, "sim")?.class === "bake", JSON.stringify(p.bakes));
    c.check("(C) the bake carries an MB estimate from codec and size", b.codec === "prores4444" && b.estimatedMB > 100 && b.estimatedMB < 400 && p.estimates.footageMB === b.estimatedMB, JSON.stringify(b));
    const q = one({ nodes: [{ id: "sim", type: "particle-simulator" }, { id: "p2i", type: "particles-to-image" }], edges: [{ from: "sim:out", to: "p2i:in:particles" }], output: "p2i:out" }, { bakeCodec: "qtrle", bakeWarnMB: 100 });
    c.check("(C) qtrle estimates larger and the bake warning fires over bakeWarnMB", q.bakes[0].estimatedMB > b.estimatedMB && q.warnings.some((w) => /MB exceeds/.test(w)), JSON.stringify({ mb: q.bakes[0].estimatedMB, w: q.warnings }));
  }

  // --- (D) a pointer-driven param ⇒ blocked, naming the node ----------------------------------
  {
    const p = one({
      nodes: [
        { id: "ptr", type: "pointer" },
        { id: "split", type: "split-vec2" },
        { id: "circle", type: "circle" },
        { id: "fill", type: "spline-fill" },
      ],
      edges: [
        { from: "ptr:out", to: "split:in:in" },
        { from: "split:out", to: "circle:param:centerX" },
        { from: "circle:out", to: "fill:in:path" },
      ],
      output: "fill:out",
    });
    c.check("(D) a pointer-driven param blocks the export", p.route === "blocked", p.route);
    c.check("(D) the blocker names the pointer node and what it drives", p.blocked.length === 1 && p.blocked[0].id === "ptr" && p.blocked[0].type === "pointer" && /record a take/.test(p.blocked[0].reason) && p.blocked[0].reason.includes("split"), JSON.stringify(p.blocked));
    const e = p.expressions.find((x) => x.drives === "circle:param:centerX");
    c.check("(D) the driver chain is an expression item, sampled (a live input can't compile)", !!e && e.sampled && e.nodes.join() === "ptr,split", JSON.stringify(p.expressions));
    c.check("(D) value drivers carry the segment of the property they drive", node(p, "split")?.segment === node(p, "circle")?.segment && (node(p, "circle")?.segment ?? -1) >= 0);
  }

  // --- (E) a 500-point copy-to-points ⇒ layer-budget warning --------------------------------
  {
    const p = one({
      nodes: [
        { id: "pts", type: "scatter-points", params: { count: 500 } },
        { id: "circle", type: "circle", params: { fill_enabled: true } },
        { id: "copy", type: "copy-to-points" },
      ],
      edges: [
        { from: "pts:out", to: "copy:in:points" },
        { from: "circle:aux:image", to: "copy:in:instance" },
      ],
      output: "copy:out",
    });
    c.check("(E) 500 instances warn against the 200-layer budget", p.warnings.some((w) => w.includes("500") && /200-layer budget/.test(w)), JSON.stringify(p.warnings));
    c.check("(E) the estimate counts the exploded layers", p.estimates.layers >= 500, String(p.estimates.layers));
    c.check("(E) points + copy form one instances segment; the instance is its own shape", p.layers[0].segments.some((s) => s.kind === "instances" && s.nodes.includes("pts") && s.nodes.includes("copy")) && p.layers[0].segments.some((s) => s.kind === "vector" && s.nodes.includes("circle")), JSON.stringify(p.layers[0].segments));
    const g = one({
      nodes: [
        { id: "grid", type: "grid", params: { countX: 20, countY: 25 } },
        { id: "circle", type: "circle" },
        { id: "copy", type: "copy-to-points" },
      ],
      edges: [
        { from: "grid:out", to: "copy:in:points" },
        { from: "circle:aux:image", to: "copy:in:instance" },
      ],
      output: "copy:out",
    });
    c.check("(E) a 20×25 grid with one instance uses Repeaters, no budget warning", !g.warnings.some((w) => /budget/.test(w)) && node(g, "copy")!.notes.some((n) => /Repeater/.test(n)), JSON.stringify({ w: g.warnings, n: node(g, "copy")?.notes }));
    const k = one(
      { nodes: [{ id: "pts", type: "scatter-points", params: { count: 10 } }, { id: "circle", type: "circle" }, { id: "copy", type: "copy-to-points" }], edges: [{ from: "pts:out", to: "copy:in:points" }, { from: "circle:aux:image", to: "copy:in:instance" }], output: "copy:out" },
      undefined,
      { countOf: (ep) => (ep === "pts:out" ? 900 : undefined) }
    );
    c.check("(E) the host's evaluated count wins over the params", k.warnings.some((w) => w.includes("900")), JSON.stringify(k.warnings));
  }

  // --- (F) blur ⇒ approx Gaussian Blur ---------------------------------------------------------
  const fxF: Omit<FxLayer, "id"> = {
    nodes: [
      { id: "img", type: "image-source" },
      { id: "blur", type: "blur", params: { radius: 12 } },
    ],
    edges: [{ from: "img:out", to: "blur:in:image" }],
    output: "blur:out",
  };
  {
    const p = one(fxF);
    const a = p.approximations.find((x) => x.id === "blur");
    c.check("(F) blur is a named Gaussian Blur approximation (calibrated radius map)", !!a && /Gaussian Blur/.test(a.note) && /calibrat/.test(a.note) && node(p, "blur")?.ae === "ADBE Gaussian Blur 2", JSON.stringify(p.approximations));
    c.check("(F) route direct: footage + an effect on the same layer", p.route === "direct" && p.layers[0].segments.map((s) => `${s.kind}/${s.aeLayer}`).join() === "source/footage,raster/footage", JSON.stringify(p.layers[0].segments));
    c.check("(F) footage is a requirement, not a bake", !!node(p, "img")?.requires?.includes("footage") && p.bakes.length === 0);
    const strict = one(fxF, { acceptApprox: false });
    c.check("(F') acceptApprox false turns the blur into a shader region", strict.route === "direct+shader" && strict.shaderRegions.length === 1 && strict.shaderRegions[0].nodes.join() === "blur" && !strict.approximations.some((x) => /Gaussian/.test(x.note)), JSON.stringify({ r: strict.shaderRegions, a: strict.approximations }));
    const bokeh = one({ ...fxF, nodes: [fxF.nodes[0], { id: "blur", type: "blur", params: { mode: "bokeh", radius: 8 } }] });
    c.check("(F) bokeh mode → Camera Lens Blur", node(bokeh, "blur")?.ae === "ADBE Camera Lens Blur");
  }

  // --- (G) Merge with Average ⇒ shader ----------------------------------------------------------
  {
    const p = one({
      nodes: [
        { id: "solid", type: "solid-color" },
        { id: "grad", type: "gradient" },
        { id: "merge", type: "merge", params: { layers: [{ id: "L1", mode: "average", opacity: 1 }] } },
      ],
      edges: [
        { from: "solid:out", to: "merge:in:base" },
        { from: "grad:out", to: "merge:in:layer:L1" },
      ],
      output: "merge:out",
    });
    c.check("(G) Merge with Average becomes one shader region", p.route === "direct+shader" && p.shaderRegions.length === 1 && p.shaderRegions[0].nodes.join() === "merge", JSON.stringify(p.shaderRegions));
    c.check("(G) the note names the missing mode; solid + Gradient Ramp stay native inputs", /Average/.test(node(p, "merge")!.notes.join(" ")) && node(p, "solid")?.class === "effect" && node(p, "grad")?.ae === "ADBE Ramp" && /2 layer inputs/.test(p.shaderRegions[0].summary ?? ""), JSON.stringify({ n: node(p, "merge")?.notes, s: p.shaderRegions[0].summary }));
    const screen = one({
      nodes: [
        { id: "solid", type: "solid-color" },
        { id: "grad", type: "gradient" },
        { id: "merge", type: "merge", params: { layers: [{ id: "L1", mode: "screen", opacity: 1 }] } },
      ],
      edges: [
        { from: "solid:out", to: "merge:in:base" },
        { from: "grad:out", to: "merge:in:layer:L1" },
      ],
      output: "merge:out",
    });
    c.check("(G) Merge with Screen stays native (a composite precomp)", screen.route === "direct" && node(screen, "merge")?.class === "layer" && screen.layers[0].segments.some((s) => s.kind === "composite" && s.aeLayer === "precomp"), JSON.stringify(screen.layers[0].segments));
    // A gradient fill on animated geometry: the walk bakes it (its points
    // follow the shape), so the plan must too; on static geometry it is native.
    const gradFill = (tracks?: AePlanTrack[]) =>
      one({
        nodes: [
          { id: "disc", type: "circle", params: { stroke_enabled: false }, ...(tracks ? { tracks } : {}) },
          { id: "paint", type: "rasterize-spline", params: { enable_stroke: false, fill_source: "gradient", gradient_kind: "linear" } },
        ],
        edges: [{ from: "disc:out", to: "paint:in:path" }],
        output: "paint:out",
      });
    const still = gradFill();
    const moving = gradFill([{ param: "radiusX", frames: [0, 60], easings: ["linear", "linear"], type: "scalar" }]);
    c.check("(G) a gradient fill on static geometry: native, its stops via .ffx", node(still, "paint")?.class === "style" && still.route === "direct", node(still, "paint"));
    c.check("(G) a gradient fill on animated geometry bakes (as the scene walk does)", node(moving, "paint")?.class === "bake" && /animated geometry/.test(node(moving, "paint")?.notes.join(" ") ?? "") && moving.bakes.length === 1, node(moving, "paint"));
    const polar = one({ nodes: [{ id: "grad", type: "gradient", params: { mode: "polar" } }], edges: [], output: "grad:out" });
    c.check("(G) a polar gradient (no Gradient Ramp form) is a shader region", polar.route === "direct+shader" && polar.shaderRegions[0]?.nodes.join() === "grad");
  }

  // --- (I) two layers with clips ⇒ two plan layers with their windows -----------------------------
  {
    const shape = (p: string): FxNode[] => [
      { id: `${p}-circle`, type: "circle" },
      { id: `${p}-fill`, type: "spline-fill" },
    ];
    const p = planAeExport(
      build([
        { id: "layer-a", name: "A", nodes: shape("a"), edges: [{ from: "a-circle:out", to: "a-fill:in:path" }], output: "a-fill:out", windows: [{ inFrame: 0, outFrame: 60, sourceInFrame: 0 }] },
        { id: "layer-b", name: "B", nodes: shape("b"), edges: [{ from: "b-circle:out", to: "b-fill:in:path" }], output: "b-fill:out", windows: [{ inFrame: 30, outFrame: 120, sourceInFrame: 10 }] },
      ])
    );
    c.check("(I) two layers → two plan layers in stack order", p.layers.map((l) => l.id).join() === "layer-a,layer-b", p.layers.map((l) => l.id).join());
    c.check(
      "(I) each carries its clip window",
      JSON.stringify(p.layers.map((l) => l.windows)) === JSON.stringify([[{ inFrame: 0, outFrame: 60, sourceInFrame: 0 }], [{ inFrame: 30, outFrame: 120, sourceInFrame: 10 }]]),
      JSON.stringify(p.layers.map((l) => l.windows))
    );
    c.check("(I) both are direct shape layers", p.route === "direct" && p.layers.every((l) => l.segments.length === 1 && l.segments[0].aeLayer === "shape"));
    const nowin = one({ nodes: shape("c"), edges: [{ from: "c-circle:out", to: "c-fill:in:path" }], output: "c-fill:out" });
    c.check("(I) no clips → one window over the whole comp", JSON.stringify(nowin.layers[0].windows) === JSON.stringify([{ inFrame: 0, outFrame: 120, sourceInFrame: 0 }]));
    const avg = planAeExport(build([{ id: "layer-a", nodes: shape("a"), edges: [{ from: "a-circle:out", to: "a-fill:in:path" }], output: "a-fill:out", blendMode: "phoenix" }]));
    c.check("(I) a layer blended with Phoenix needs a shader for its composite", avg.route === "direct+shader" && avg.shaderRegions[0]?.target === "layer-a:out" && avg.warnings.some((w) => /Phoenix/.test(w)), JSON.stringify(avg.shaderRegions));
  }

  // --- text, fonts, unknown types, color tracks -------------------------------------------------------
  {
    const t = one({ nodes: [{ id: "txt", type: "text", params: { font_family: "Poppins" } }], edges: [], output: "txt:out" });
    c.check("text → a text layer, approx, and its font is listed", t.route === "direct" && t.fonts.join() === "Poppins" && t.approximations.some((a) => a.id === "txt") && t.layers[0].segments[0].aeLayer === "text", JSON.stringify({ f: t.fonts, s: t.layers[0].segments }));
    const u = planAeExport({ ...build([{ id: "layer-1", nodes: [{ id: "fill", type: "spline-fill" }], edges: [], output: "fill:out" }]), layers: [{ id: "layer-1", name: "L", nodes: [{ id: "x", type: "mystery-node" }, { id: "fill", type: "spline-fill" }], edges: [{ from: "x:out", to: "fill:in:path" }], output: "fill:out" }] });
    c.check("an unknown type is unsupported with a warning — never guessed", u.route === "blocked" && u.blocked[0]?.id === "x" && u.warnings.some((w) => /mystery-node .* not in the After Effects class table/.test(w)), JSON.stringify({ b: u.blocked, w: u.warnings }));
    const col = one({
      nodes: [
        { id: "circle", type: "circle", params: { fill_enabled: true }, tracks: [{ param: "fill_color", frames: [0, 60], easings: ["linear", "linear"], type: "color" }] },
        { id: "img", type: "image-source" },
        { id: "bloom", type: "bloom", tracks: [{ param: "tint_low", frames: [0, 60], easings: ["linear", "linear"], type: "color" }] },
      ],
      edges: [{ from: "img:out", to: "bloom:in:image" }],
      output: "circle:aux:image",
    });
    c.check("OKLab color on a shape → expression (§11.4)", node(col, "circle")!.notes.some((n) => /fill_color: OKLab tween → an expression/.test(n)), JSON.stringify(node(col, "circle")?.notes));
    const dense = one({ nodes: [{ id: "img", type: "image-source" }, { id: "bloom", type: "bloom", tracks: [{ param: "tint_low", frames: [0, 60], easings: ["linear", "linear"], type: "color" }] }], edges: [{ from: "img:out", to: "bloom:in:image" }], output: "bloom:out" });
    c.check("OKLab color on an effect → dense keys (§11.4)", node(dense, "bloom")!.notes.some((n) => /dense RGB keys/.test(n)) && dense.estimates.keyframes >= 63, JSON.stringify(node(dense, "bloom")?.notes));
    const animRamp = one({ nodes: [{ id: "noise", type: "noise" }, { id: "ramp", type: "color-ramp", tracks: [{ param: "ramp_c:stops:stop-a", frames: [0, 60], easings: ["linear", "linear"], type: "color" }] }], edges: [{ from: "noise:out", to: "ramp:in:image" }], output: "ramp:out" });
    c.check("animated ramp stops bake (the host's ramps are static LUTs)", animRamp.route === "direct+bake" && node(animRamp, "ramp")?.class === "bake", JSON.stringify({ r: animRamp.route, b: animRamp.bakes }));
    const proc = one({ nodes: [{ id: "wave", type: "lissajous-2d", tracks: [{ param: "phase", frames: [0, 60], easings: ["linear", "linear"] }] }, { id: "stroke", type: "spline-stroke" }], edges: [{ from: "wave:out", to: "stroke:in:path" }], output: "stroke:out" });
    c.check("an animated evaluated path warns about anchor-count stability", proc.warnings.some((w) => /constant anchor count/.test(w)), JSON.stringify(proc.warnings));
    const stable = one({ nodes: [{ id: "wave", type: "lissajous-2d", tracks: [{ param: "phase", frames: [0, 60], easings: ["linear", "linear"] }] }, { id: "rs", type: "spline-resample" }, { id: "stroke", type: "spline-stroke" }], edges: [{ from: "wave:out", to: "rs:in:path" }, { from: "rs:out", to: "stroke:in:path" }], output: "stroke:out" });
    c.check("…unless a Spline Resample fixes the count downstream", !node(stable, "wave")!.notes.some((n) => /constant vertex count/.test(n)), JSON.stringify(node(stable, "wave")?.notes));
  }

  // A multipass effect after a shader region stays native (its fused form is
  // itself approximate and costly).
  {
    const p = one({
      nodes: [...fxB.nodes, { id: "blur", type: "blur", params: { radius: 6 } }],
      edges: [...fxB.edges, { from: "disp:out", to: "blur:in:image" }],
      output: "blur:out",
    });
    c.check("a blur after a shader region stays a native Gaussian Blur", p.shaderRegions.length === 1 && !p.shaderRegions[0].nodes.includes("blur") && node(p, "blur")?.class === "effect", JSON.stringify(p.shaderRegions));
  }

  // --- editor glue: real editor nodes → flatten → per-layer scopes ----------------------------------
  {
    const { makeInstanceNode, createLayer } = await import("@/state/graph-ops");
    const { planAeExportForEditor, aePlanReport, vetAePolicy } = await import("@/lib/ae-export/editor");
    type GN = ReturnType<typeof makeInstanceNode>;
    let nodes: GN[] = [makeInstanceNode("output", { x: 800, y: 0 })];
    let edges: { id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }[] = [];
    const add = (layerId: string, type: string, extra: Partial<GN["data"]> = {}): GN => {
      const n = makeInstanceNode(type, { x: 0, y: 0 });
      n.data.parentId = layerId;
      Object.assign(n.data, extra);
      nodes.push(n);
      return n;
    };
    const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
      edges.push({ id: `e${edges.length}`, source, sourceHandle, target, targetHandle });
    const goOf = (layerId: string) => nodes.find((n) => n.data.parentId === layerId && n.data.defType === "group-output")!;

    const a = createLayer(nodes, edges as never, { name: "Back" });
    nodes = a.nodes;
    edges = a.edges as typeof edges;
    const back = nodes.find((n) => n.id === a.layerId)!;
    back.data.clips = [{ inTick: 0, outTick: 60_000, sourceInTick: 0, enabled: true }];
    const circle = add(a.layerId, "circle", {
      animation: {
        radiusX: {
          animated: true,
          trackVisible: true,
          keyframes: [
            { tick: 0, value: 0.1, easingOut: "easeInOutSine" },
            { tick: 30_000, value: 0.3, easingOut: "linear" },
          ],
        },
      },
    });
    const fill = add(a.layerId, "spline-fill");
    const bypassed = add(a.layerId, "blur", { bypassed: true });
    wire(circle.id, "out:primary", fill.id, "in:path");
    wire(fill.id, "out:primary", bypassed.id, "in:image");
    wire(bypassed.id, "out:primary", goOf(a.layerId).id, "in:image");

    const b = createLayer(nodes, edges as never, { name: "Front" });
    nodes = b.nodes;
    edges = b.edges as typeof edges;
    const sim = add(b.layerId, "particle-simulator");
    const p2i = add(b.layerId, "particles-to-image");
    wire(sim.id, "out:primary", p2i.id, "in:particles");
    wire(p2i.id, "out:primary", goOf(b.layerId).id, "in:image");

    const env = { composition: { id: "main", name: "Main", width: 1280, height: 720, fps: 30, durationFrames: 90 } };
    const p = planAeExportForEditor(nodes, edges as never, env);
    c.check("(editor) the Output's stack → two scopes, bottom first", p.layers.map((l) => l.id).join() === `${a.layerId},${b.layerId}`, p.layers.map((l) => `${l.id}:${l.name}`).join());
    c.check("(editor) the clipped layer carries its window", JSON.stringify(p.layers[0].windows) === JSON.stringify([{ inFrame: 0, outFrame: 60, sourceInFrame: 0 }]), JSON.stringify(p.layers[0].windows));
    c.check("(editor) a bypassed node passes its input through (not planned)", !p.layers[0].nodes.some((n) => n.id === bypassed.id) && p.layers[0].segments[0]?.output === `${fill.id}:out`, JSON.stringify(p.layers[0].segments));
    c.check("(editor) keyframes come through with their easing", p.approximations.some((x) => x.id === circle.id && /radiusX: easeInOutSine/.test(x.note)), JSON.stringify(p.approximations));
    c.check("(editor) the sim layer bakes over the comp → direct+bake", p.route === "direct+bake" && p.bakes.length === 1 && p.bakes[0].output === `${p2i.id}:out` && p.bakes[0].frames.join() === "0,89", JSON.stringify(p.bakes));
    const t = planAeExportForEditor(nodes, edges as never, { ...env, target: circle.id });
    c.check("(editor) target plans the branch feeding that node, in its layer", t.layers.length === 1 && t.layers[0].id === a.layerId && t.layers[0].nodes.map((n) => n.id).join() === circle.id, JSON.stringify(t.layers.map((l) => l.nodes.map((n) => n.id))));
    const s = planAeExportForEditor(nodes, edges as never, { ...env, scope: b.layerId });
    c.check("(editor) scope plans one layer", s.layers.length === 1 && s.layers[0].id === b.layerId);
    let threw = "";
    try {
      planAeExportForEditor(nodes, edges as never, { ...env, scope: "nope" });
    } catch (e) {
      threw = String(e);
    }
    c.check("(editor) an unknown scope is an error, not an empty plan", /not a layer/.test(threw), threw);
    const report = aePlanReport(p);
    c.check("(editor) the report leads with the route, then the five lines, then the JSON plan", /^After Effects export plan — route: direct\+bake\n/.test(report) && /\nBaked \(1\):/.test(report) && JSON.parse(report.slice(report.indexOf("JSON plan:\n") + 11)).route === "direct+bake", report.slice(0, 400));
    const bad = (x: unknown) => {
      try {
        vetAePolicy(x);
        return "";
      } catch (e) {
        return String(e);
      }
    };
    c.check(
      "(editor) policy is vetted key by key",
      JSON.stringify(vetAePolicy({ shaderHost: false, layerBudget: 50 })) === '{"shaderHost":false,"layerBudget":50}' && /unknown policy key "budget"/.test(bad({ budget: 3 })) && /fidelity must be one of/.test(bad({ fidelity: "perfect" })) && /must be an object/.test(bad("x")),
      bad({ budget: 3 })
    );
  }

  // --- (J) determinism -----------------------------------------------------------------------------
  {
    const a = JSON.stringify(one(fxB));
    const b = JSON.stringify(one(fxB));
    const input = build([{ id: "layer-1", name: "Layer 1", ...fxA }]);
    const c1 = JSON.stringify(planAeExport(input));
    const c2 = JSON.stringify(planAeExport(input));
    c.check("(J) the same input gives byte-identical JSON (fresh inputs and the same object)", a === b && c1 === c2, a === b ? "same-object differs" : "fresh inputs differ");
  }

  return c.failures;
}
