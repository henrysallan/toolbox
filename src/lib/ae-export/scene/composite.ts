// Composite segments (spec §4.4, §4.6).
//
//   merge        base + each enabled layer → AE layers stacked in Merge's
//                order (later layers on top), each with its blend mode, its
//                opacity (layer_opacity:<id> keys carry over) and its matte:
//                mask:<id> → a hidden matte source as LUMA (an image: luma ×
//                alpha) / ALPHA (a spline's silhouette) track matte,
//                maskInvert → the inverted type. Several visible layers: the
//                consumer collapses them into a precomp when it needs one.
//   time-offset  the branch upstream re-rendered on a clock shifted by the
//                offset (keys move by offset/fps — exact for a constant
//                offset); a keyed / wired offset, or a baked node inside the
//                branch, bakes the Time Offset's output instead.
//
// Collect / group-pick / group are not mapped yet (they bake).

import { aeBlendModeOf } from "../classes";
import { numericTrackToAe } from "../convert";
import type { AeLayer, AePlanNode, AeProp } from "../types";
import { isAnimatedParam, keyCtx, scaleProp, staticNumber } from "./context";
import { parseOut, sourceEndpoint } from "./graph";
import { collapse, type Emitters, type Rendered, type Scope } from "./layers";
import { matteSource } from "./masks";

interface MergeLayer {
  id: string;
  mode?: string;
  opacity?: number;
  enabled?: boolean;
  maskInvert?: boolean;
  name?: string;
}

function setOpacity(scope: Scope, main: AeLayer, p: AeProp<number>): boolean {
  const cur = main.transform.opacity;
  if ("v" in cur && cur.v === 100) {
    main.transform.opacity = p;
    return true;
  }
  if ("v" in p) {
    main.transform.opacity = scaleProp(cur, p.v / 100);
    return true;
  }
  if ("v" in cur) {
    main.transform.opacity = scaleProp(p, cur.v / 100);
    return true;
  }
  void scope;
  return false;
}

export function emitComposite(scope: Scope, endpoint: string, pn: AePlanNode, em: Emitters): Rendered | null {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  const n = ctx.graph.node(id)!;
  if (n.type === "time-offset") return timeOffset(scope, endpoint, id, em);
  if (n.type !== "merge") return null;
  void pn;
  const p = ctx.graph.params(id);
  const layers = (Array.isArray(p.layers) ? (p.layers as MergeLayer[]) : []).filter((l) => l && l.enabled !== false);
  const baseWire = ctx.graph.wireInto(id, "in:base");
  if (!baseWire) {
    ctx.report.note(id, "no base wired — toolbox renders opaque black here");
    return null;
  }
  const out: AeLayer[] = [];
  const stack = (ep: string, name: string, maskHandle: string, invert: boolean, mode: string, opacity: AeProp<number>) => {
    let r = collapse(scope, scope.render(ep), name);
    const blend = aeBlendModeOf(mode);
    if (!blend) throw new Error(`merge ${id}: blend ${mode} reached the composite emitter (the plan routes it to a shader)`);
    if (!setOpacity(scope, r.main!, opacity)) {
      r = collapse(scope, { layers: r.layers }, name);
      setOpacity(scope, r.main!, opacity);
    }
    const main = r.main!;
    main.blendingMode = blend;
    main.origin = [...new Set([...(main.origin ?? []), id])];
    const mw = ctx.graph.wireInto(id, maskHandle);
    if (mw) {
      if (main.matte) {
        r = collapse(scope, { layers: r.layers }, name);
      }
      const m = matteSource(scope, sourceEndpoint(mw));
      const target = r.main!;
      target.matte = { layer: m.matte.id, type: invert ? (m.type === "ALPHA" ? "ALPHA_INVERTED" : "LUMA_INVERTED") : m.type };
      ctx.report.note(id, `${name}: ${maskHandle} → ${target.matte.type} track matte`);
      out.unshift(...r.layers);
      out.unshift(...m.layers);
      return;
    }
    out.unshift(...r.layers);
  };
  stack(sourceEndpoint(baseWire), "base", "in:mask:base", false, "normal", { v: 100 });
  layers.forEach((l, i) => {
    const w = ctx.graph.wireInto(id, `in:layer:${l.id}`);
    if (!w) return;
    const name = l.name?.trim() || `layer ${i + 1}`;
    const track = ctx.graph.block(id, `layer_opacity:${l.id}`);
    let opacity: AeProp<number> = { v: Math.max(0, Math.min(1, typeof l.opacity === "number" ? l.opacity : 1)) * 100 };
    if (track && track.keyframes.length > 1) {
      const r = numericTrackToAe(track, "scalar", { ...keyCtx(ctx, scope.clock), map: { scale: 100, offset: 0 } });
      ctx.report.track(id, `${name} opacity`, r.report);
      opacity = r.prop as AeProp<number>;
    }
    stack(sourceEndpoint(w), name, `in:mask:${l.id}`, !!l.maskInvert, String(l.mode ?? "normal"), opacity);
  });
  return { layers: out };
}

function timeOffset(scope: Scope, endpoint: string, id: string, em: Emitters): Rendered | null {
  const { ctx } = scope;
  const w = ctx.graph.wireInto(id, "in:in");
  if (!w) return { layers: [] };
  if (isAnimatedParam(ctx, id, "offset")) return em.bake(scope, endpoint, "a keyed / wired Time Offset (a time warp) — no constant shift");
  const offset = staticNumber(ctx, id, "offset", 0);
  const before = { bakes: ctx.out.bakes.length, footage: ctx.out.footage.length };
  const inner = scope.at({ ...scope.clock, offsetTicks: scope.clock.offsetTicks + offset * ctx.tpf });
  const r = inner.render(sourceEndpoint(w));
  if (ctx.out.bakes.length > before.bakes) {
    // A baked node under the shift: bake the shifted result as a whole (the
    // package renders comp frames; the Time Offset node applies the shift).
    ctx.out.bakes.splice(before.bakes);
    ctx.out.footage.splice(before.footage);
    return em.bake(scope, endpoint, "a baked node inside a Time Offset branch — the whole shifted branch bakes");
  }
  ctx.report.note(id, `offset ${offset} frames → the branch's keys shifted by ${(offset / ctx.fps).toFixed(4)} s`);
  return r;
}
