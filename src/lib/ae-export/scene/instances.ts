// Instances (spec §3 rung 4, owner budget §11.5).
//
// Copy to Points, image mode, static points:
//   a regular Grid source and an instance that renders as one plain shape
//   layer → that layer's contents placed at the first point plus two
//   Repeaters (X copies, then Y copies — Grid's row-major order, later on
//   top), one layer, editable;
//   otherwise → the instance collapsed into ONE precomp, placed once per
//   point (anchor = the instance's content center, position = the point,
//   rotation / scale from the point), up to policy.layerBudget; past it a
//   warning and a bake.
// Spline mode copies are geometry: the vector emitter writes their evaluated
// paths (shape.ts), or the same Repeaters (repeaterGeom below).
// Modulated copies (pick / scale / rotate fields, tint / opacity attributes)
// and animated points bake for now.

import type { PointsValue, SplineValue } from "@/engine/types";
import { canvasToPx, radToDeg } from "../convert";
import type { AeComp, AeLayer, AePlanNode, AeShapeItem } from "../types";
import { parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, collapse, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { animatedUpstream, geometry, localTick, type Geom } from "./shape";

const MODULATION = ["in:pick", "in:scale_mul", "in:rotate_add", "in:scale_field", "in:rotate_field", "in:driver_field"];

interface Grid {
  cols: number;
  rows: number;
  // First point and steps, canvas01.
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

function gridOf(scope: Scope, pointsEp: string): Grid | null {
  const { ctx } = scope;
  const { id, out } = parseOut(pointsEp);
  const n = ctx.graph.node(id);
  if (!n || n.type !== "grid" || out !== "out:primary" || animatedUpstream(ctx, id) || ctx.graph.into(id).length) return null;
  const p = ctx.graph.params(id);
  const cols = Math.max(1, Math.floor(Number(p.countX ?? 5)));
  const rows = Math.max(1, Math.floor(Number(p.countY ?? 5)));
  const step = p.spacingMode === "step";
  const dx = step ? Number(p.spacingX ?? 0.1) : cols > 1 ? Number(p.width ?? 0.8) / (cols - 1) : 0;
  const dy = step ? Number(p.spacingY ?? 0.1) : rows > 1 ? Number(p.height ?? 0.8) / (rows - 1) : 0;
  const cx = Number(p.x ?? 0.5);
  const cy = Number(p.y ?? 0.5);
  return { cols, rows, dx, dy, x0: cx - (dx * (cols - 1)) / 2, y0: cy - (dy * (rows - 1)) / 2 };
}

function pointsAt(scope: Scope, ep: string): PointsValue {
  const v = scope.ctx.graph.valueAt(ep, localTick(scope, scope.clock.inFrame));
  if (!v || v.kind !== "points") throw new BakeSignal(`${ep} evaluated to ${v ? v.kind : "nothing"}, not points`);
  return v;
}

function checkPlain(scope: Scope, id: string): void {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  for (const h of MODULATION) if (ctx.graph.wireInto(id, h)) throw new BakeSignal(`Copy to Points ${h.slice(3)} modulation (per-copy values) is not mapped yet`);
  if ((p.pick_mode ?? "all") !== "all") throw new BakeSignal(`Copy to Points pick_mode ${String(p.pick_mode)}`);
  if (p.tint_attr || p.opacity_attr) throw new BakeSignal("Copy to Points tint / opacity attributes");
  if ((p.draw_order ?? "points order") !== "points order") throw new BakeSignal(`Copy to Points draw_order ${String(p.draw_order)}`);
  for (const k of ["scale_mul_default", "rotate_add_default"]) if (ctx.graph.block(id, k)) throw new BakeSignal(`keyed ${k}`);
}

// The instance's content center (canvas01) — the copies' anchor.
function anchorOf(scope: Scope, id: string, instanceEp: string): [number, number] {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  const mode = String(p.anchor ?? "canvas center");
  if (mode === "custom") return [Number(p.anchor_x ?? 0.5), Number(p.anchor_y ?? 0.5)];
  if (mode === "canvas center") return [0.5, 0.5];
  // Content center: toolbox measures the instance image's alpha bounds; the
  // spline behind a vector instance gives the same box without a readback.
  const s = instanceSpline(scope, instanceEp);
  if (s) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const sub of s.subpaths)
      for (const a of sub.anchors) {
        minX = Math.min(minX, a.pos[0]);
        maxX = Math.max(maxX, a.pos[0]);
        minY = Math.min(minY, a.pos[1]);
        maxY = Math.max(maxY, a.pos[1]);
      }
    if (Number.isFinite(minX)) {
      ctx.report.approx(id, "content-center anchor from the instance's spline bounds (toolbox reads its alpha bounds — strokes widen them)");
      return [(minX + maxX) / 2, (minY + maxY) / 2];
    }
  }
  ctx.report.approx(id, "content-center anchor unknown offline — canvas center used");
  return [0.5, 0.5];
}

function instanceSpline(scope: Scope, ep: string): SplineValue | null {
  const { ctx } = scope;
  const { id, out } = parseOut(ep);
  const n = ctx.graph.node(id);
  if (!n) return null;
  const at = (e: string) => {
    const v = ctx.graph.valueAt(e, localTick(scope, scope.clock.inFrame));
    return v && v.kind === "spline" ? v : null;
  };
  if (out === "out:aux:image") return at(`${id}:out`);
  const w = ctx.graph.wireInto(id, "in:path");
  return w ? at(sourceEndpoint(w)) : null;
}

export function repeaters(scope: Scope, g: Grid, anchor: [number, number], items: AeShapeItem[], name: string): AeShapeItem[] {
  const { ctx } = scope;
  const W = ctx.canvas.width;
  const p0 = canvasToPx([g.x0, g.y0], ctx.canvas);
  const a = canvasToPx(anchor, ctx.canvas);
  const placed: AeShapeItem = { kind: "group", name: `${name} instance`, contents: items, transform: { position: { v: [p0[0] - a[0], p0[1] - a[1]] } } };
  const rep = (copies: number, d: [number, number], axis: string): AeShapeItem => ({
    kind: "repeater",
    name: `${name} ${axis}`,
    copies: { v: copies },
    offset: { v: 0 },
    composite: "above",
    transform: { anchor: { v: [0, 0] }, position: { v: d }, scale: { v: [100, 100] }, rotation: { v: 0 }, startOpacity: { v: 100 }, endOpacity: { v: 100 } },
  });
  const out: AeShapeItem[] = [placed];
  if (g.cols > 1) out.push(rep(g.cols, [g.dx * W, 0], "columns"));
  const inner: AeShapeItem[] = g.cols > 1 ? [{ kind: "group", name: `${name} row`, contents: out }] : out;
  if (g.rows > 1) inner.push(rep(g.rows, [0, g.dy * W], "rows"));
  return [{ kind: "group", name, contents: inner }];
}

// Spline-mode Copy to Points on a static grid → Repeaters around the
// instance geometry (shape.ts calls this before falling back to the
// evaluated copies).
export function repeaterGeom(scope: Scope, id: string): Geom | null {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  if ((p.mode ?? "image") !== "spline") return null;
  const pw = ctx.graph.wireInto(id, "in:points");
  const iw = ctx.graph.wireInto(id, "in:instance");
  if (!pw || !iw) return null;
  const g = gridOf(scope, sourceEndpoint(pw));
  if (!g) return null;
  try {
    checkPlain(scope, id);
  } catch {
    return null;
  }
  if (Number(p.scale_mul_default ?? 1) !== 1 || Number(p.rotate_add_default ?? 0) !== 0) return null;
  if ((p.output_tag ?? "instance groups") !== "instance groups") return null;
  const inst = geometry(scope, sourceEndpoint(iw), { top: false, canHoist: false });
  const s = ctx.graph.valueAt(sourceEndpoint(iw), localTick(scope, scope.clock.inFrame));
  const mode = String(p.anchor ?? "canvas center");
  let anchor: [number, number] = [0.5, 0.5];
  if (mode === "custom") anchor = [Number(p.anchor_x ?? 0.5), Number(p.anchor_y ?? 0.5)];
  else if (mode === "content center" && s && s.kind === "spline") {
    const xs = s.subpaths.flatMap((sp) => sp.anchors.map((a) => a.pos[0]));
    const ys = s.subpaths.flatMap((sp) => sp.anchors.map((a) => a.pos[1]));
    if (xs.length) anchor = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  ctx.report.note(id, `regular ${g.cols}×${g.rows} grid, one instance → two Repeaters`);
  return { items: repeaters(scope, g, anchor, inst.items, ctx.graph.name(id)), leaves: 1 };
}

export function emitInstances(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx, clock } = scope;
  const { id } = parseOut(endpoint);
  const n = ctx.graph.node(id);
  if (!n || n.type !== "copy-to-points") return null;
  void pn;
  const p = ctx.graph.params(id);
  if ((p.mode ?? "image") !== "image") return null;
  checkPlain(scope, id);
  const pw = ctx.graph.wireInto(id, "in:points");
  const iw = ctx.graph.wireInto(id, "in:instance");
  if (!pw || !iw) return { layers: [] };
  const pointsEp = sourceEndpoint(pw);
  const instanceEp = sourceEndpoint(iw);
  if (animatedUpstream(ctx, pw.source)) throw new BakeSignal("animated points (per-copy keys) are not mapped yet");
  const scaleMul = Number(p.scale_mul_default ?? 1);
  const rotAdd = Number(p.rotate_add_default ?? 0);
  const anchor = anchorOf(scope, id, instanceEp);
  const name = ctx.graph.name(id);

  // A grid of a plain shape instance → Repeaters on one shape layer.
  const g = gridOf(scope, pointsEp);
  if (g && scaleMul === 1 && rotAdd === 0) {
    const inst = scope.render(instanceEp);
    const m = inst.main;
    if (m && inst.layers.length === 1 && m.kind === "shape" && ctx.free.has(m) && !m.masks && !m.effects && !m.matte && m.contents) {
      ctx.report.note(id, `regular ${g.cols}×${g.rows} grid → two Repeaters on the instance's shape layer`);
      m.contents = repeaters(scope, g, anchor, m.contents, name);
      m.name = name;
      m.origin = [...new Set([...(m.origin ?? []), id])];
      return inst;
    }
  }

  const pts = pointsAt(scope, pointsEp);
  const count = pts.count;
  if (count > ctx.policy.layerBudget) {
    // The plan already warned about the budget; the report says it baked.
    throw new BakeSignal(`${count} copies exceed the layer budget (${ctx.policy.layerBudget})`);
  }
  // One precomp of the instance, placed per point.
  const inst = collapse(scope, scope.render(instanceEp), `${name} instance`);
  let compId = inst.main!.source;
  if (inst.main!.kind !== "precomp" || !compId) {
    const c: AeComp = { id: ctx.uid(`comp:${name} instance`), name: `${ctx.name} · ${name} instance`, width: ctx.canvas.width, height: ctx.canvas.height, fps: ctx.fps, duration: Math.max(ctx.durationFrames, clock.outFrame) / ctx.fps, layers: inst.layers };
    ctx.out.comps.push(c);
    compId = c.id;
  }
  const a = canvasToPx(anchor, ctx.canvas);
  const layers: AeLayer[] = [];
  for (let i = 0; i < count; i++) {
    const pos = canvasToPx([pts.positions[i * 2], pts.positions[i * 2 + 1]], ctx.canvas);
    const sx = (pts.scales ? pts.scales[i * 2] : 1) * scaleMul;
    const sy = (pts.scales ? pts.scales[i * 2 + 1] : 1) * scaleMul;
    const rot = radToDeg((pts.rotations ? pts.rotations[i] : 0) + rotAdd);
    const L = newLayer(scope, "precomp", `${name} ${i + 1}`, [id], {
      source: compId,
      transform: { anchor: { v: a }, position: { v: pos }, scale: { v: [sx * 100, sy * 100] }, rotation: { v: rot }, opacity: { v: 100 } },
    });
    layers.unshift(L);
  }
  ctx.report.note(id, `${count} copies → ${count} layers of one instance precomp`);
  return count === 1 ? rendered(layers[0]) : { layers };
}
