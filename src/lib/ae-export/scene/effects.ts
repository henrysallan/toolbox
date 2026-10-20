// Source and raster segments (spec §3 rung 2, §4.1).
//
// source   solid-color  → a comp-sized solid (alpha × opacity → layer Opacity;
//                         its color as an OKLab expression when keyed, §11.4)
//          gradient     → Gradient Ramp on a solid for 2-stop linear / radial
//          image-source → footage (AeAssetCopy), fit → Scale, its own TRS on
//                         a precomp (toolbox crops the fitted image to the frame)
//          video-source → footage, played from the layer's start
// raster   built-in effects through calibration.ts's aeEffectMap(type): static
//          params via `map`, keyed ones through the map's `linear` rule (each
//          key's value mapped, speeds scaled), driven ones per frame. A map
//          with measured: false is reported "approx, uncalibrated". No map, or
//          one whose applies() refuses the node's params → the node is a
//          shader region of its own (a fused node in opts.fused) or bakes.
//          An image Transform → the layer transform (or a precomp's, when
//          something already sits between).
//
// Effects run on a layer before its transform and track matte, so a layer
// whose transform or matte is taken collapses into a precomp first.

import { evaluateKeyframesAt, type KeyframeAnimationBlock } from "@/engine/keyframes";
import { aeEffectMap, type AeEffectContext, type AeParamMap } from "../calibration";
import { numericTrackToAe, sampledTrackToAe, uv01AxisAffine } from "../convert";
import type { AeEffect, AeLayer, AePlanNode, AeProp } from "../types";
import {
  colorProp,
  driverOf,
  isAnimatedParam,
  markDriven,
  keyCtx,
  scalarProp,
  staticNumber,
  trackSource,
  windowFrames,
  type WalkCtx,
} from "./context";
import { numbersOf, parseOut, sourceEndpoint } from "./graph";
import {
  BakeSignal,
  collapse,
  compSolid,
  mainInputOf,
  newLayer,
  over,
  rendered,
  type Emitters,
  type Rendered,
  type Scope,
} from "./layers";
import { applyImageMask, isSplineEndpoint, matteSource, splineMasks } from "./masks";
import { nodeTransform, nodeTrs, type NodeTrs } from "./trs";

export function effectContext(ctx: WalkCtx): AeEffectContext {
  return { width: ctx.canvas.width, height: ctx.canvas.height, bitsPerChannel: ctx.policy.bitsPerChannel };
}

// One layer an effect / transform can go on: collapsed when its transform
// or track matte is already taken. An effect also needs a comp-sized buffer:
// toolbox filters canvas-sized images, while AE hands a shape or text
// layer's effects a buffer cropped to its content (measured: a blur on a
// shape layer neither spills past the shape nor — with Repeat Edge Pixels —
// fades its edge), so those collapse into a comp-sized precomp first.
export function effectTarget(scope: Scope, r: Rendered, name: string, forTransform = false): Rendered & { main: AeLayer } {
  const { ctx } = scope;
  let s = collapse(scope, r, name);
  const m = s.main!;
  const cropped = !forTransform && (m.kind === "shape" || m.kind === "text");
  const busy = cropped || !!m.matte || !ctx.free.has(m) || (forTransform && (m.effects?.length ?? 0) > 0);
  if (busy) s = collapse(scope, { layers: s.layers }, name);
  return s as Rendered & { main: AeLayer };
}

// --- sources ---------------------------------------------------------------------------

export function emitSource(scope: Scope, endpoint: string, pn: AePlanNode, em: Emitters): Rendered | null {
  const { ctx, clock } = scope;
  const { id } = parseOut(endpoint);
  const n = ctx.graph.node(id)!;
  const name = ctx.graph.name(id);
  let r: Rendered | null = null;
  if (n.type === "solid-color") {
    const c = colorProp(ctx, clock, id, "color", { shapeOrSolid: true, fallback: "#808080" });
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    // A solid's own color is not keyable in AE: a keyed color is a
    // comp-sized rectangle on a shape layer, its Fill keyed.
    const L =
      "v" in c.color
        ? compSolid(scope, name, [id], c.color.v)
        : newLayer(scope, "shape", name, [id], {
            contents: [{ kind: "group", name, contents: [{ kind: "rect", size: { v: [W, H] }, position: { v: [W / 2, H / 2] }, roundness: { v: 0 } }, { kind: "fill", color: c.color, opacity: { v: 100 }, rule: "nonzero" }] }],
          });
    if (!("v" in c.color)) ctx.report.note(id, "keyed color → a comp-sized rectangle whose Fill carries the keys");
    const alpha = scalarProp(ctx, clock, id, "alpha", { map: { scale: 100, offset: 0 }, fallback: 1 });
    L.transform.opacity = productOpacity(scope, id, alpha);
    r = rendered(L);
  } else if (n.type === "gradient") {
    r = gradientRamp(scope, id, name);
  } else if (n.type === "image-source" || n.type === "video-source") {
    r = footage(scope, id, n.type);
  } else if (n.type === "transform") {
    return null;
  } else {
    // An effect-class generator with no input (a map may exist for it).
    const L = compSolid(scope, name, [id]);
    const fx = mapEffect(scope, id, pn);
    if (!fx) return shaderOrBake(scope, endpoint, pn, em, "no AE effect map");
    L.effects = [fx];
    r = rendered(L);
  }
  if (!r) return null;
  const mask = ctx.graph.wireInto(id, "in:mask");
  return mask ? applyImageMask(scope, r, id, sourceEndpoint(mask)) : r;
}

// The node's universal `opacity` (OPACITY_PARAM) × another percent prop.
function productOpacity(scope: Scope, id: string, other: AeProp<number>): AeProp<number> {
  const { ctx, clock } = scope;
  const op = staticNumber(ctx, id, "opacity", 1);
  if (isAnimatedParam(ctx, id, "opacity")) {
    if ("v" in other && other.v === 100) return scalarProp(ctx, clock, id, "opacity", { map: { scale: 100, offset: 0 }, fallback: 1 });
    ctx.report.sampled(id, "opacity × alpha both animate → per-frame opacity keys");
    const p = sampledTrackToAe(windowFrames(clock), (tick) => [100 * staticAt(ctx, id, "opacity", tick, 1) * staticAt(ctx, id, "alpha", tick, 1)], keyCtx(ctx, clock));
    return "v" in p.prop ? { v: p.prop.v[0] } : { keys: p.prop.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 };
  }
  if (op === 1) return other;
  if ("v" in other) return { v: other.v * op };
  return { ...other, keys: other.keys.map((k) => ({ ...k, v: k.v * op, ...(k.easeIn ? { easeIn: k.easeIn.map((e) => ({ ...e, speed: e.speed * op })) } : {}), ...(k.easeOut ? { easeOut: k.easeOut.map((e) => ({ ...e, speed: e.speed * op })) } : {}) })) };
}

// A param's value at a tick: wire > keyframes > constant.
function staticAt(ctx: WalkCtx, id: string, param: string, tick: number, fallback: number): number {
  const d = driverOf(ctx, id, param);
  if (d) return numbersOf(ctx.graph.valueAt(d, tick))?.[0] ?? fallback;
  const s = trackSource(ctx, id, param, fallback);
  if (typeof s === "number") return s;
  if (Array.isArray(s)) return s[0] ?? fallback;
  return s ? evalScalar(s, tick, fallback) : fallback;
}
function evalScalar(b: KeyframeAnimationBlock, tick: number, fallback: number): number {
  const v = evaluateKeyframesAt(b, "scalar", tick);
  return typeof v === "number" ? v : fallback;
}

// Gradient Ramp (ADBE Ramp): Start of Ramp, Start Color, End of Ramp, End
// Color, Ramp Shape (1 linear, 2 radial), Ramp Scatter, Blend With Original.
const RAMP = (k: number) => `ADBE Ramp-${String(k).padStart(4, "0")}`;

function gradientRamp(scope: Scope, id: string, name: string): Rendered {
  const { ctx, clock } = scope;
  const p = ctx.graph.params(id);
  const mode = String(p.mode ?? "linear");
  if (mode !== "linear" && mode !== "radial") throw new BakeSignal(`Gradient mode ${mode} has no Gradient Ramp form`);
  if (ctx.graph.wireInto(id, "in:uv_in") || ctx.graph.wireInto(id, "in:angle_mod")) throw new BakeSignal("Gradient with a wired UV / angle modulator");
  if (isAnimatedParam(ctx, id, "softness") || staticNumber(ctx, id, "softness", 1) !== 1) ctx.report.approx(id, "softness ≠ 1 has no Gradient Ramp knob — linear blend");
  const u = uv01AxisAffine("u", ctx.canvas);
  const v = uv01AxisAffine("v", ctx.canvas);
  const pt = (px: string, py: string, dx: number, dy: number) => pairPoint(scope, id, px, py, dx, dy, u, v);
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  let start: AeProp;
  let end: AeProp;
  if (mode === "linear") {
    start = pt("start_x", "start_y", 0, 0.5);
    end = pt("end_x", "end_y", 1, 0.5);
    const sx = staticNumber(ctx, id, "start_x", 0);
    const sy = staticNumber(ctx, id, "start_y", 0.5);
    const ex = staticNumber(ctx, id, "end_x", 1);
    const ey = staticNumber(ctx, id, "end_y", 0.5);
    if (W !== H && Math.abs(sx - ex) > 1e-9 && Math.abs(sy - ey) > 1e-9)
      ctx.report.approx(id, "a diagonal ramp on a non-square comp: toolbox's isolines are perpendicular in uv01, AE's in pixels");
  } else {
    start = pt("center_x", "center_y", 0.5, 0.5);
    const cx = staticNumber(ctx, id, "center_x", 0.5);
    const cy = staticNumber(ctx, id, "center_y", 0.5);
    const rad = staticNumber(ctx, id, "radius", 0.5);
    if (isAnimatedParam(ctx, id, "radius") || isAnimatedParam(ctx, id, "center_x") || isAnimatedParam(ctx, id, "center_y")) {
      const frames = windowFrames(clock);
      const r = sampledTrackToAe(frames, (tick) => [W * (staticAt(ctx, id, "center_x", tick, 0.5) + staticAt(ctx, id, "radius", tick, 0.5)), H * (1 - staticAt(ctx, id, "center_y", tick, 0.5))], keyCtx(ctx, clock));
      end = r.prop;
      ctx.report.sampled(id, "animated radial gradient → End of Ramp per frame");
    } else end = { v: [W * (cx + rad), H * (1 - cy)] };
    if (W !== H) ctx.report.approx(id, "radial gradient: toolbox's radius is per-axis uv01 (an ellipse on a non-square comp), AE's is circular in pixels");
  }
  const a = colorProp(ctx, clock, id, "color_a", { shapeOrSolid: false, fallback: "#000000" });
  const b = colorProp(ctx, clock, id, "color_b", { shapeOrSolid: false, fallback: "#ffffff" });
  const L = compSolid(scope, name, [id]);
  L.effects = [
    {
      match: "ADBE Ramp",
      name: "Gradient Ramp",
      props: { [RAMP(1)]: start, [RAMP(2)]: a.color, [RAMP(3)]: end, [RAMP(4)]: b.color, [RAMP(5)]: { v: mode === "radial" ? 2 : 1 }, [RAMP(6)]: { v: 0 }, [RAMP(7)]: { v: 0 } },
    },
  ];
  L.transform.opacity = productOpacity(scope, id, scalarProp(ctx, clock, id, "alpha", { map: { scale: 100, offset: 0 }, fallback: 1 }));
  ctx.report.note(id, `Gradient Ramp ${mode} (Ramp Scatter 0)`);
  return rendered(L);
}

function pairPoint(scope: Scope, id: string, px: string, py: string, dx: number, dy: number, u: { scale: number; offset: number }, v: { scale: number; offset: number }): AeProp {
  const { ctx, clock } = scope;
  if ([px, py].some((p) => isAnimatedParam(ctx, id, p))) {
    const r = sampledTrackToAe(windowFrames(clock), (tick) => [u.scale * staticAt(ctx, id, px, tick, dx) + u.offset, v.scale * staticAt(ctx, id, py, tick, dy) + v.offset], keyCtx(ctx, clock));
    if (!("v" in r.prop)) ctx.report.sampled(id, `${px}/${py} animate → per-frame point keys`);
    return r.prop;
  }
  return { v: [u.scale * staticNumber(ctx, id, px, dx) + u.offset, v.scale * staticNumber(ctx, id, py, dy) + v.offset] };
}

function footage(scope: Scope, id: string, type: string): Rendered | null {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  const isVideo = type === "video-source";
  if (ctx.graph.wireInto(id, "in:uv_in")) throw new BakeSignal(`${type} with a wired UV`);
  if (p.legacySkew === true) throw new BakeSignal(`${type} with legacySkew (per-axis TRS)`);
  if (isVideo && (p.source_kind ?? "video") === "sequence") throw new BakeSignal("image sequences are not mapped yet");
  if (isVideo && (staticNumber(ctx, id, "speed", 1) !== 1 || staticNumber(ctx, id, "start_offset", 0) !== 0 || isAnimatedParam(ctx, id, "speed")))
    throw new BakeSignal("video speed / start offset → time remap is not mapped yet");
  const file = (isVideo ? p.file : p.file) as { width?: number; height?: number; videoWidth?: number; videoHeight?: number; name?: string } | null | undefined;
  if (!file) {
    ctx.report.note(id, "no file loaded — nothing to export");
    return { layers: [] };
  }
  const fid = ctx.uid(`footage:${id}`);
  const ext = isVideo ? "mov" : "png";
  const path = `footage/${fid.replace(/[^A-Za-z0-9_.-]+/g, "_")}.${ext}`;
  ctx.out.footage.push({ id: fid, path, kind: isVideo ? "video" : "image", alpha: "straight", name: ctx.graph.name(id) });
  ctx.out.assets.push({ id: fid, path, source: { kind: isVideo ? "video" : "image", ref: id } });
  const w = file.width ?? file.videoWidth;
  const h = file.height ?? file.videoHeight;
  const fit = String(p.fit ?? "cover");
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  // A video plays from the toolbox layer's local time 0 (sync_to_scene_time).
  const L = newLayer(scope, "footage", ctx.graph.name(id), [id], { source: fid, startTime: isVideo ? scope.clock.offsetTicks / (ctx.tpf * ctx.fps) : 0 });
  if (w && h) {
    const sx = fit === "stretch" ? W / w : fit === "cover" ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    const sy = fit === "stretch" ? H / h : sx;
    L.transform = { anchor: { v: [w / 2, h / 2] }, position: { v: [W / 2, H / 2] }, scale: { v: [sx * 100, sy * 100] }, rotation: { v: 0 }, opacity: { v: 100 } };
  } else {
    // Size unknown at export: let AE fit it.
    const fitExpr =
      fit === "stretch"
        ? "[thisComp.width / thisLayer.width * 100, thisComp.height / thisLayer.height * 100]"
        : `var s = Math.${fit === "cover" ? "max" : "min"}(thisComp.width / thisLayer.width, thisComp.height / thisLayer.height) * 100; [s, s]`;
    L.transform = {
      anchor: { v: [W / 2, H / 2], expression: "[thisLayer.width / 2, thisLayer.height / 2]" },
      position: { v: [W / 2, H / 2] },
      scale: { v: [100, 100], expression: fitExpr },
      rotation: { v: 0 },
      opacity: { v: 100 },
    };
    ctx.report.note(id, `fit ${fit} by expression (the file's size is unknown here)`);
  }
  ctx.free.delete(L);
  L.transform.opacity = productOpacity(scope, id, { v: 100 });
  let r: Rendered = rendered(L);
  const tracks = nodeTrs(ctx, id);
  if (!tracks.identity) {
    // Toolbox crops the fitted image to the frame, then moves it.
    r = collapse(scope, { layers: [L] }, ctx.graph.name(id));
    if (fit === "contain" || fit === "stretch" || !w) r = collapse(scope, { layers: r.layers }, ctx.graph.name(id));
    setLayerTrs(scope, r.main!, id, tracks);
  }
  return r;
}

// A node's TRS as a layer transform (wired params sampled — trs.ts).
export function setLayerTrs(scope: Scope, L: AeLayer, id: string, t: NodeTrs): void {
  const { ctx, clock } = scope;
  const r = nodeTransform(ctx, clock, id, t, { space: "global" });
  L.transform = { ...r.transform, opacity: L.transform.opacity };
  ctx.free.delete(L);
}

// The node's universal `opacity` (OPACITY_PARAM) on what it rendered: one
// layer's opacity, after any mask (the evaluator's order: mask, then opacity).
export function withNodeOpacity(scope: Scope, id: string, r: Rendered): Rendered {
  const { ctx, clock } = scope;
  const animated = isAnimatedParam(ctx, id, "opacity");
  const op = staticNumber(ctx, id, "opacity", 1);
  if (!animated && op === 1) return r;
  let s = collapse(scope, r, ctx.graph.name(id));
  const cur = s.main!.transform.opacity;
  if (animated && !("v" in cur && cur.v === 100)) s = collapse(scope, { layers: s.layers }, ctx.graph.name(id));
  const main = s.main!;
  const now = main.transform.opacity;
  main.transform.opacity = animated ? scalarProp(ctx, clock, id, "opacity", { map: { scale: 100, offset: 0 }, fallback: 1 }) : "v" in now ? { ...now, v: now.v * op } : now;
  if (!animated && !("v" in now)) main.transform.opacity = { ...now, keys: now.keys.map((k) => ({ ...k, v: k.v * op })) };
  return s;
}

// --- raster ------------------------------------------------------------------------------

function mapParam(scope: Scope, id: string, param: string, m: AeParamMap, ectx: AeEffectContext): AeProp {
  const { ctx, clock } = scope;
  if (m.kind === "color") return colorProp(ctx, clock, id, param, { shapeOrSolid: false }).color as AeProp;
  const kc = keyCtx(ctx, clock);
  const d = driverOf(ctx, id, param);
  const b = ctx.graph.block(id, param);
  if (!d && b && b.keyframes.length > 1) {
    if (m.linear && (m.kind === "scalar")) {
      const r = numericTrackToAe(b, "scalar", { ...kc, map: m.linear(ectx) });
      ctx.report.track(id, param, r.report);
      return r.prop;
    }
    if (m.kind === "enum" || m.kind === "bool") {
      return { keys: b.keyframes.map((k) => ({ t: (k.tick + clock.offsetTicks) / (ctx.tpf * ctx.fps), v: m.map(k.value, ectx), inInterp: "hold" as const, outInterp: "hold" as const })), dims: 1 };
    }
  }
  if (d || (b && b.keyframes.length > 1)) {
    if (d) markDriven(ctx, id, param, d, `${param}: driven by ${d} → per-frame keys through the effect map`);
    else ctx.report.sampled(id, `${param}: keys through a non-linear effect map → per-frame keys`);
    const r = sampledTrackToAe(
      windowFrames(clock),
      (tick) => {
        const v = d ? numbersOf(ctx.graph.valueAt(d, tick))?.[0] : evalScalar(b!, tick, 0);
        const ae = m.map(v, ectx);
        return Array.isArray(ae) ? (ae as number[]) : [Number(ae)];
      },
      kc
    );
    if ("v" in r.prop) return { v: r.prop.v.length === 1 ? r.prop.v[0] : r.prop.v };
    return r.prop.dims === 1 ? { keys: r.prop.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 } : r.prop;
  }
  const raw = b?.keyframes[0]?.value ?? ctx.graph.params(id)[param];
  return { v: m.map(raw, ectx) };
}

// The AE effect for a node through its calibration map, or null.
export function mapEffect(scope: Scope, id: string, pn: AePlanNode): AeEffect | null {
  const { ctx } = scope;
  const n = ctx.graph.node(id)!;
  const map = aeEffectMap(n.type);
  if (!map) return null;
  const values = ctx.graph.params(id);
  if (map.applies && !map.applies(values)) return null;
  const ectx = effectContext(ctx);
  const props: Record<string, AeProp> = {};
  for (const [k, v] of Object.entries(map.fixed ?? {})) props[k] = { v };
  for (const [param, m] of Object.entries(map.params)) props[m.prop] = mapParam(scope, id, param, m, ectx);
  if (!map.measured) ctx.report.approx(id, `approx, uncalibrated: ${map.match}${map.note ? ` — ${map.note}` : ""}`);
  else if (map.fidelity === "approx") ctx.report.approx(id, `${map.match}${map.note ? ` — ${map.note}` : ""}`);
  void pn;
  return { match: map.match, name: ctx.graph.name(id), props };
}

// A node with no AE effect: its own shader region (opts.fused) or a bake.
function shaderOrBake(scope: Scope, endpoint: string, pn: AePlanNode, em: Emitters, why: string): Rendered {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  if (ctx.policy.shaderHost && ctx.fused[endpoint]) {
    ctx.report.reclass(id, "shader", "exact", `${why} → its fused shader (${ctx.fused[endpoint]})`);
    const r = em.shader(scope, endpoint, { ...pn, class: "shader" });
    if (r) return r;
  }
  ctx.report.reclass(id, "bake", "bake", `${why} → bakes${ctx.policy.shaderHost ? " (no fused shader for this node in opts.fused — convert it with Claude for an editable Toolbox Shader)" : ""}`);
  return em.bake(scope, endpoint, `${n(ctx, id)}: ${why}`);
}

const n = (ctx: WalkCtx, id: string) => `${ctx.graph.node(id)?.type ?? "node"} (${id})`;

export function emitRaster(scope: Scope, endpoint: string, pn: AePlanNode, em: Emitters): Rendered | null {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  const node = ctx.graph.node(id)!;
  const input = mainInputOf(scope, id);
  if (!input) return emitSource(scope, endpoint, pn, em);
  const maskWire = ctx.graph.wireInto(id, "in:mask");
  const maskEp = maskWire ? sourceEndpoint(maskWire) : undefined;

  if (node.type === "transform") {
    const p = ctx.graph.params(id);
    if (p.tile === true) throw new BakeSignal("Transform tile (Motion Tile) is not mapped yet");
    if (p.legacySkew === true) throw new BakeSignal("Transform with legacySkew (per-axis TRS on a non-square comp)");
    if (ctx.graph.wireInto(id, "in:transform")) throw new BakeSignal("image Transform driven by a wired transform");
    const tracks = nodeTrs(ctx, id);
    const base = scope.render(input);
    if (tracks.identity) return maskEp ? maskedOver(scope, id, base, scope.render(input), maskEp) : base;
    const t = effectTarget(scope, base, ctx.graph.name(id), true);
    setLayerTrs(scope, t.main, id, tracks);
    t.main.origin = [...(t.main.origin ?? []), id];
    if (!maskEp) return t;
    return maskedOver(scope, id, t, scope.render(input), maskEp);
  }

  const fx = mapEffect(scope, id, pn);
  if (!fx) return shaderOrBake(scope, endpoint, pn, em, aeEffectMap(node.type) ? "the AE effect map refuses these params" : "no AE effect map (calibration.ts) for this node");

  const base = effectTarget(scope, scope.render(input), ctx.graph.name(input.split(":")[0]));
  // A spline mask on an AE effect: its Compositing Options mask (one layer).
  if (maskEp && isSplineEndpoint(scope, maskEp)) {
    const masks = splineMasks(scope, maskEp, { name: `${ctx.graph.name(id)} mask` });
    const first = (base.main.masks?.length ?? 0) + 1;
    base.main.masks = [...(base.main.masks ?? []), ...masks];
    if (masks.length > 1) ctx.report.approx(id, "a multi-subpath spline mask: Compositing Options references its first subpath only");
    fx.compositingMask = { mask: first };
    ctx.report.note(id, "spline mask → the effect's Compositing Options mask");
    base.main.effects = [...(base.main.effects ?? []), fx];
    base.main.origin = [...(base.main.origin ?? []), id];
    return withNodeOpacity(scope, id, base);
  }
  base.main.effects = [...(base.main.effects ?? []), fx];
  base.main.origin = [...(base.main.origin ?? []), id];
  if (!maskEp) return withNodeOpacity(scope, id, base);
  return withNodeOpacity(scope, id, maskedOver(scope, id, base, scope.render(input), maskEp));
}

// mix(input, output, mask): the effected layer, matted, over the input.
export function maskedOver(scope: Scope, id: string, effected: Rendered, input: Rendered, maskEp: string): Rendered {
  const { ctx } = scope;
  const top = collapse(scope, effected, ctx.graph.name(id));
  const m = matteSource(scope, maskEp);
  top.main!.matte = { layer: m.matte.id, type: m.type };
  ctx.report.note(id, "mask → the effected layer with the mask as its track matte, over the un-effected input");
  return over({ layers: [...m.layers, ...top.layers] }, input);
}

