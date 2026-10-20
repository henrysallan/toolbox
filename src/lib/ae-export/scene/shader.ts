// Shader regions → the Toolbox Shader host (spec §7.3; host facts in
// side-session notes "toolbox-shader-host-findings").
//
// A region whose target has a fused glsl-expression in opts.fused becomes a
// TBX Shader effect on a comp-sized solid (u_aspect and canvas01 then match
// the toolbox canvas). The bundle comes from bundleFromGlslExpression on the
// fused node; the effect's props go by tbxShaderParamMatch, in the order the
// host needs: Bundle ID FIRST (setting it loads the bundle and resets every
// un-keyed control to the bundle's defaults, and hides the slots the bundle
// does not use — AE refuses setValue on a hidden param), then only the
// bundle's own slots: layer inputs a–d as AeLayerRefs to hidden precomps
// rendering the fused node's image inputs (the region's frontier), then its
// sliders / colors / checkboxes. A wired slider channel is sampled per frame;
// a keyed one (ch:<name>) keeps its keys.
//
// The solid's startTime puts the layer's own time on the toolbox layer's
// clock (u_time = layer seconds × Time Speed 1).

import { numericTrackToAe, sampledTrackToAe } from "../convert";
import { bundleFromGlslExpression, TBX_SHADER_HOST_MIN } from "../shader";
import { TBX_SHADER_MATCH_NAME, tbxShaderParamMatch, type AeEffect, type AeLayer, type AePlanNode, type AeProp, type AeShaderRegion } from "../types";
import { keyCtx, markDriven, windowFrames } from "./context";
import { numbersOf, parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, collapse, compSolid, type Rendered, type Scope } from "./layers";

export function regionFor(scope: Scope, endpoint: string): AeShaderRegion | undefined {
  const { id } = parseOut(endpoint);
  const regions = scope.ctx.plan.shaderRegions;
  return regions.find((r) => r.target === endpoint) ?? regions.find((r) => r.nodes.includes(id));
}

export function emitShader(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx, clock } = scope;
  const { id } = parseOut(endpoint);
  if (!ctx.policy.shaderHost) return null;
  const region = regionFor(scope, endpoint);
  const target = region?.target ?? endpoint;
  const members = region?.nodes ?? [id];
  const fusedId = ctx.fused[target] ?? ctx.fused[endpoint];
  if (!fusedId) {
    throw new BakeSignal(`${region?.id ?? "shader region"} (${target}) has no fused GLSL Expression in opts.fused — run the graph-to-glsl loop on it ("Convert shader regions with Claude") for an editable Toolbox Shader; until then it bakes`);
  }
  const fused = ctx.graph.node(fusedId);
  if (!fused || fused.type !== "glsl-expression") throw new BakeSignal(`opts.fused["${target}"] = "${fusedId}" is not a GLSL Expression node in this composition`);
  const name = `${ctx.name} ${region?.id ?? id}`;
  const res = bundleFromGlslExpression(fused.params, {
    name,
    fps: ctx.fps,
    loopFrames: ctx.durationFrames,
    canvas: { width: ctx.canvas.width, height: ctx.canvas.height },
  });
  if (!res.ok) {
    const first = res.errors[0];
    const w = `fused shader ${fusedId} does not translate to MSL (${res.errors.length} error${res.errors.length === 1 ? "" : "s"}; body line ${first ? first.line - res.preludeLines : "?"}: ${first?.message ?? "?"}) — the region bakes`;
    ctx.out.warnings.push(w);
    throw new BakeSignal(w);
  }
  const bundle = res.bundle;
  for (const w of res.warnings) ctx.report.note(fusedId, w);
  if (!ctx.out.bundles.some((b) => b.id === bundle.id)) ctx.out.bundles.push(bundle);
  ctx.report.shaderHost = TBX_SHADER_HOST_MIN;
  ctx.report.ensure(fusedId, "glsl-expression", "shader", ctx.graph.name(fusedId));
  ctx.report.note(fusedId, `fused shader for ${target} → Toolbox Shader bundle ${bundle.id}`);
  for (const m of members) ctx.report.reclass(m, "shader", pn.fidelity === "approx" && m === id ? "approx" : "exact", `fused into ${fusedId} → Toolbox Shader bundle ${bundle.id}`);

  // Bundle ID first, then the bundle's own slots.
  const props: Record<string, AeProp> = { [tbxShaderParamMatch("bundle")]: { v: bundle.id } };
  const helpers: AeLayer[] = [];
  for (const slot of bundle.inputs) {
    const w = ctx.graph.wireInto(fusedId, `in:${slot}`);
    if (!w) throw new BakeSignal(`fused shader ${fusedId} samples input ${slot}, but nothing is wired into it`);
    // A layer param reads the referenced layer's own pixels: a comp-sized
    // precomp with an identity transform is comp space exactly.
    const inner = scope.render(sourceEndpoint(w));
    const plainPrecomp = inner.main && inner.main.kind === "precomp" && inner.layers.length === 1 && ctx.free.has(inner.main);
    const ref = plainPrecomp ? inner : collapse(scope, { layers: inner.layers }, `${ctx.graph.name(w.source)} → ${slot}`);
    ref.main!.enabled = false;
    helpers.push(...ref.layers);
    props[tbxShaderParamMatch("layer", slot.charCodeAt(0) - 96)] = { v: { layerRef: ref.main!.id } };
  }
  const kc = keyCtx(ctx, clock);
  for (const p of bundle.params) {
    const key = tbxShaderParamMatch(p.kind, p.slot);
    if (p.kind === "slider") {
      const wired = ctx.graph.wireInto(fusedId, `in:${p.name}`);
      const keyed = ctx.graph.block(fusedId, `ch:${p.name}`);
      if (wired) {
        const src = sourceEndpoint(wired);
        const r = sampledTrackToAe(windowFrames(clock), (tick) => [numbersOf(ctx.graph.valueAt(src, tick))?.[0] ?? Number(p.default)], kc, `channel ${p.name}`);
        props[key] = "v" in r.prop ? { v: r.prop.v[0] } : { keys: r.prop.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 };
        if (!("v" in r.prop)) markDriven(ctx, fusedId, p.name, src, `channel ${p.name}: driven by ${src} → per-frame slider keys`);
      } else if (keyed && keyed.keyframes.length > 1) {
        const r = numericTrackToAe(keyed, "scalar", kc);
        ctx.report.track(fusedId, `channel ${p.name}`, r.report);
        props[key] = r.prop;
      } else props[key] = { v: Number(p.default) };
    } else if (p.kind === "color") {
      const c = Array.isArray(p.default) ? (p.default as number[]) : [1, 1, 1, 1];
      props[key] = { v: [c[0], c[1], c[2]] };
      if (ctx.graph.wireInto(fusedId, `in:${p.name}`) || ctx.graph.block(fusedId, `ch:${p.name}`))
        ctx.report.approx(fusedId, `color channel ${p.name} is wired / keyed — exported at its current value`);
    } else if (p.kind === "checkbox") {
      props[key] = { v: p.default === true ? 1 : 0 };
    } else {
      ctx.report.approx(fusedId, `point channel ${p.name}: not set (host proposal only)`);
    }
  }
  const fx: AeEffect = { match: TBX_SHADER_MATCH_NAME, name: ctx.graph.name(fusedId), props, bundle: String(bundle.id) };
  const L = compSolid(scope, `${region?.id ?? "shader"} (${ctx.graph.name(id)})`, [...members, fusedId]);
  L.id = ctx.uid(region?.id ?? `shader:${id}`);
  L.startTime = clock.offsetTicks / (ctx.tpf * ctx.fps);
  L.effects = [fx];
  return { layers: [...helpers, L], main: L };
}
