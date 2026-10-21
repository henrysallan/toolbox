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
//
// A region that is ONE node with a host spec (shader/node-shaders.ts: Noise)
// needs no fused node: emitNodeShader builds the bundle from the node's own
// fragment shader, its params become the effect's controls (keyed → keys,
// wired → an expression or per-frame keys, like any effect param), and the
// node's mask and universal opacity apply as for any source or effect.

import { numericTrackToAe, sampledTrackToAe } from "../convert";
import { bundleFromGlslExpression, TBX_SHADER_HOST_MIN } from "../shader";
import { bundleFromNodeShader, controlLabel, nodeShaderParams } from "../shader/node-bundle";
import { nodeShaderSpec, type NodeShaderEnv } from "../shader/node-shaders";
import { TBX_SHADER_MATCH_NAME, tbxShaderParamMatch, type AeEffect, type AeLayer, type AePlanNode, type AeProp, type AeShaderBundle, type AeShaderRegion } from "../types";
import { colorProp, evalBlock, isAnimatedParam, keyCtx, markDriven, scalarProp, windowFrames, type WalkCtx } from "./context";
import { maskedOver, withNodeOpacity } from "./effects";
import { exprProp } from "./expressions";
import { numbersOf, parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, collapse, compSolid, type Rendered, type Scope } from "./layers";
import { applyImageMask, isSplineEndpoint } from "./masks";
import { isSdfContour } from "./sdf";

// A channel's wire. Its socket is "in:<row id>" (glsl-expression
// resolveInputs), so the handle is "in:in:<id>"; "in:<id>" as the Skia
// planner also accepts.
function channelWire(ctx: WalkCtx, fusedId: string, name: string) {
  const rows = (ctx.graph.params(fusedId).inputs as { id?: string; name?: string }[] | undefined) ?? [];
  const id = rows.find((r) => r.name === name)?.id ?? name;
  return ctx.graph.wireInto(fusedId, `in:in:${id}`) ?? ctx.graph.wireInto(fusedId, `in:${id}`);
}

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
    const lone = members.length === 1 && members[0] === id;
    if (lone && nodeShaderSpec(ctx.graph.node(id)?.type)) return emitNodeShader(scope, endpoint, pn, region);
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
    layerInput(scope, sourceEndpoint(w), `${ctx.graph.name(w.source)} → ${slot}`, slot, props, helpers);
  }
  const kc = keyCtx(ctx, clock);
  for (const p of bundle.params) {
    const key = tbxShaderParamMatch(p.kind, p.slot);
    if (p.kind === "slider") {
      // A knob channel (a promoted input, a Constant knob) reads its control.
      const knob = ctx.knobs.tbx(ctx, clock, fusedId, p.name, ctx.graph.name(fusedId));
      if (knob) {
        props[key] = knob;
        continue;
      }
      const wired = channelWire(ctx, fusedId, p.name);
      const keyed = ctx.graph.block(fusedId, `ch:${p.name}`);
      if (wired) {
        const src = sourceEndpoint(wired);
        const oracle = (tick: number) => [numbersOf(ctx.graph.valueAt(src, tick))?.[0] ?? Number(p.default)];
        // The channel's driver as an expression on the slider, else per frame.
        const ex = exprProp(ctx, clock, { label: `channel ${p.name}`, owner: fusedId, inputs: [{ endpoint: src, fallback: Number(p.default) }], out: (v) => [v[0]], oracle });
        if ("prop" in ex) {
          props[key] = ex.prop;
          continue;
        }
        const r = sampledTrackToAe(windowFrames(clock), oracle, kc, `channel ${p.name}`);
        props[key] = "v" in r.prop ? { v: r.prop.v[0] } : { keys: r.prop.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 };
        if (!("v" in r.prop)) markDriven(ctx, fusedId, p.name, src, `channel ${p.name}: driven by ${src} → per-frame slider keys (${ex.refused})`, ex.refused);
      } else if (keyed && keyed.keyframes.length > 1) {
        const r = numericTrackToAe(keyed, "scalar", kc);
        ctx.report.track(fusedId, `channel ${p.name}`, r.report);
        props[key] = r.prop;
      } else props[key] = { v: Number(p.default) };
    } else if (p.kind === "color") {
      const c = Array.isArray(p.default) ? (p.default as number[]) : [1, 1, 1, 1];
      props[key] = { v: [c[0], c[1], c[2]] };
      if (channelWire(ctx, fusedId, p.name) || ctx.graph.block(fusedId, `ch:${p.name}`))
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

// A layer param reads the referenced layer's own pixels: a comp-sized
// precomp with an identity transform is comp space exactly.
function layerInput(scope: Scope, source: string, name: string, slot: AeShaderBundle["inputs"][number], props: Record<string, AeProp>, helpers: AeLayer[]): void {
  const { ctx } = scope;
  const inner = scope.render(source);
  const plainPrecomp = inner.main && inner.main.kind === "precomp" && inner.layers.length === 1 && ctx.free.has(inner.main);
  const ref = plainPrecomp ? inner : collapse(scope, { layers: inner.layers }, name);
  ref.main!.enabled = false;
  helpers.push(...ref.layers);
  props[tbxShaderParamMatch("layer", slot.charCodeAt(0) - 96)] = { v: { layerRef: ref.main!.id } };
}

// One node's own fragment shader on the host (shader/node-shaders.ts).
function emitNodeShader(scope: Scope, endpoint: string, pn: AePlanNode, region: AeShaderRegion | undefined): Rendered {
  const { ctx, clock } = scope;
  const { id } = parseOut(endpoint);
  const node = ctx.graph.node(id)!;
  const spec = nodeShaderSpec(node.type)!;
  const name = ctx.graph.name(id);
  if (endpoint !== `${id}:out`) throw new BakeSignal(`${name}: only its image output runs as its own shader on the host, not ${endpoint}`);
  for (const p of spec.bakes ?? [])
    if (isAnimatedParam(ctx, id, p)) throw new BakeSignal(`${name}: ${p} is keyed or wired, but the host bakes it into the shader (it has no popups) — the region bakes`);

  // What arrives on each wired input (the mask applies outside the shader).
  const inputs: NodeShaderEnv["inputs"] = {};
  for (const w of ctx.graph.into(id)) {
    const socket = w.targetHandle.replace(/^in:/, "");
    if (!w.targetHandle.startsWith("in:") || socket.startsWith("param:") || socket === "mask" || socket.startsWith("mask:")) continue;
    inputs[socket] = scope.nodes.get(w.source)?.class === "expression" ? "value" : "image";
  }
  // Bundle defaults: a keyed control starts at its value on the window's first frame.
  const params = nodeShaderParams(spec, ctx.graph.params(id));
  const first = clock.inFrame * ctx.tpf - clock.offsetTicks;
  for (const d of spec.node.params) {
    const b = ctx.graph.block(id, d.name);
    if (d.type === "scalar" && b && b.keyframes.length > 1) params[d.name] = evalBlock(b, first, Number(params[d.name]) || 0);
  }
  const res = bundleFromNodeShader(node.type, params, inputs, {
    name: `${ctx.name} ${region?.id ?? id}`,
    fps: ctx.fps,
    canvas: { width: ctx.canvas.width, height: ctx.canvas.height },
  });
  if (!res.ok) {
    if ("refused" in res) throw new BakeSignal(`${name}: ${res.refused}`);
    const e = res.errors[0];
    const w = `${name}'s own shader does not translate to MSL (${res.errors.length} error${res.errors.length === 1 ? "" : "s"}; line ${e?.line ?? "?"}: ${e?.message ?? "?"}) — the region bakes`;
    ctx.out.warnings.push(w);
    throw new BakeSignal(w);
  }
  const bundle = res.bundle;
  if (!ctx.out.bundles.some((b) => b.id === bundle.id)) ctx.out.bundles.push(bundle);
  ctx.report.shaderHost = TBX_SHADER_HOST_MIN;
  ctx.report.reclass(id, "shader", pn.fidelity === "approx" ? "approx" : "exact", `its own shader → Toolbox Shader bundle ${bundle.id}, ${res.controls.length} controls named after its params (no conversion step)`);
  const defs = new Map(spec.node.params.map((d) => [d.name, d]));
  if (res.baked.length) ctx.report.note(id, `baked into the shader at their current values (the host has no popups): ${res.baked.map((p) => `${p} = ${JSON.stringify(params[p])}`).join(", ")}`);

  const props: Record<string, AeProp> = { [tbxShaderParamMatch("bundle")]: { v: bundle.id } };
  const helpers: AeLayer[] = [];
  for (const [socket, slot] of Object.entries(res.inputs)) {
    const w = ctx.graph.wireInto(id, `in:${socket}`)!;
    layerInput(scope, sourceEndpoint(w), `${ctx.graph.name(w.source)} → ${name} ${socket}`, slot, props, helpers);
  }
  for (const c of res.controls) {
    const def = defs.get(c.param)!;
    const key = tbxShaderParamMatch(c.kind, c.slot);
    const label = `${name} ${controlLabel(def)}`;
    if (c.kind === "slider") props[key] = scalarProp(ctx, clock, id, c.param, { fallback: Number(def.default) || 0, label });
    else if (c.kind === "color") props[key] = colorProp(ctx, clock, id, c.param, { shapeOrSolid: false, fallback: String(def.default), label }).color;
    else props[key] = checkboxProp(scope, id, c.param, params[c.param] === true, label);
  }
  const fx: AeEffect = { match: TBX_SHADER_MATCH_NAME, name, props, bundle: String(bundle.id) };
  const L = compSolid(scope, `${region?.id ?? "shader"} (${name})`, [id]);
  L.id = ctx.uid(region?.id ?? `shader:${id}`);
  L.startTime = clock.offsetTicks / (ctx.tpf * ctx.fps);
  L.effects = [fx];
  let out: Rendered = { layers: [...helpers, L], main: L };

  // The evaluator's order: the universal mask (mix over the def's first
  // image input when it has one), then the universal opacity. AE applies a
  // layer's masks BEFORE its effects, and the shader writes every pixel
  // (measured: the solid's spline mask left the shader unclipped), so a
  // spline mask goes on a precomp of the shader layer.
  const mask = ctx.graph.wireInto(id, "in:mask");
  if (mask) {
    const maskEp = sourceEndpoint(mask);
    const baseSocket = spec.node.noMaskBase ? undefined : spec.node.inputs.find((i) => i.type === "image" && i.name !== "mask")?.name;
    const base = baseSocket ? ctx.graph.wireInto(id, `in:${baseSocket}`) : undefined;
    if (base) out = maskedOver(scope, id, out, scope.render(sourceEndpoint(base)), maskEp);
    else {
      if (isSplineEndpoint(scope, maskEp) && !isSdfContour(scope, maskEp)) out = collapse(scope, out, name, true);
      out = applyImageMask(scope, out, id, maskEp);
    }
  }
  return withNodeOpacity(scope, id, out);
}

// A boolean param → a checkbox: keyed → hold keys (a toggle has no
// in-between); wired → its current value, reported.
function checkboxProp(scope: Scope, id: string, param: string, now: boolean, label: string): AeProp {
  const { ctx, clock } = scope;
  const b = ctx.graph.block(id, param);
  if (b && b.keyframes.length > 1)
    return {
      keys: b.keyframes.map((k) => ({ t: (k.tick + clock.offsetTicks) / (ctx.tpf * ctx.fps), v: k.value === true ? 1 : 0, inInterp: "hold" as const, outInterp: "hold" as const })),
      dims: 1,
    };
  if (isAnimatedParam(ctx, id, param)) ctx.report.approx(id, `${label}: wired — exported at its current value`);
  return { v: now ? 1 : 0 };
}
