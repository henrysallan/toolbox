// Masks and mattes (spec §4.4; M0 §13 for the Compositing Options rule).
//
// Toolbox has three matte forms; AE gets the tidiest one that is exact:
//
//   a spline into a node's universal `mask` (a source: the mask multiplies
//   the output) → layer masks on that layer, mode add (later subpaths
//   Difference — the spline→mask coercion fills even-odd), when the
//   layer's transform is still the comp frame (a layer mask moves with the
//   layer); otherwise a hidden white shape layer as its ALPHA matte;
//
//   an image into a mask socket → that image's layer, hidden, as a LUMA
//   matte (image → mask is luma × alpha, coerce.ts);
//
//   a mask on an effect (`mix(input, output, mask)`) → the effected layer
//   matted, over an un-effected copy below; a spline mask on an AE effect →
//   the effect's Compositing Options mask instead (one layer, exact): the
//   referenced mask is mode add, which AE then stops applying to the layer.

import { getNodeDef } from "@/engine/registry";
import { splineToAePaths, splineTrackToAe } from "../convert";
import type { AeLayer, AeMask, AePath, AeProp, AeShapeItem } from "../types";
import { keyCtx, windowFrames } from "./context";
import { parseOut } from "./graph";
import { BakeSignal, collapse, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { animatedUpstream, geometry, splineAt } from "./shape";

// Does this endpoint carry a spline?
export function isSplineEndpoint(scope: Scope, endpoint: string): boolean {
  const { id, out } = parseOut(endpoint);
  const n = scope.ctx.graph.node(id);
  const def = n ? getNodeDef(n.type) : undefined;
  if (!def) return false;
  if (out === "out:primary") return def.primaryOutput === "spline";
  const aux = out.slice("out:aux:".length);
  return (def.auxOutputs ?? []).some((a) => a.name === aux && a.type === "spline");
}

// The spline at `endpoint` as AE mask paths (one per subpath), static,
// path-keyed (a keyed Spline Draw) or per frame.
export function maskPaths(scope: Scope, endpoint: string): AeProp<AePath>[] {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  if (!animatedUpstream(ctx, id)) return splineToAePaths(splineAt(scope, endpoint, scope.clock.inFrame), ctx.canvas).map((p) => ({ v: p }));
  const n = ctx.graph.node(id)!;
  const sblock = ctx.graph.block(id, "spline");
  if (n.type === "spline-draw" && sblock && sblock.keyframes.length > 1 && ctx.graph.into(id).length === 0) {
    const r = splineTrackToAe(sblock, ctx.canvas, keyCtx(ctx, scope.clock));
    if ("error" in r) throw new BakeSignal(`mask path animation: ${r.error}`);
    if (r.roundCorners) throw new BakeSignal("a mask with live corners on a keyed path");
    ctx.report.track(id, "mask path", r.report);
    return r.paths;
  }
  const [f0, f1] = windowFrames(scope.clock);
  const frames: AePath[][] = [];
  for (let f = f0; f <= f1; f++) frames.push(splineToAePaths(splineAt(scope, endpoint, f), ctx.canvas));
  const counts = frames[0].map((p) => p.vertices.length);
  for (const fr of frames)
    if (fr.length !== counts.length || fr.some((p, i) => p.vertices.length !== counts[i])) throw new BakeSignal("animated mask path changes its vertex count");
  ctx.report.sampled(id, `animated mask path → mask keys every frame ${f0}–${f1}`);
  return counts.map((_, i) => ({
    keys: frames.map((fr, k) => ({ t: (f0 + k) / ctx.fps, v: fr[i], inInterp: "linear" as const, outInterp: "linear" as const })),
    dims: 1 as const,
  }));
}

export function splineMasks(scope: Scope, endpoint: string, opts: { inverted?: boolean; name?: string } = {}): AeMask[] {
  return maskPaths(scope, endpoint).map((path, i) => ({
    name: `${opts.name ?? scope.ctx.graph.name(parseOut(endpoint).id)}${i ? ` ${i + 1}` : ""}`,
    path,
    // The silhouette fills even-odd: each further subpath toggles coverage.
    mode: i === 0 ? (opts.inverted ? "subtract" : "add") : "difference",
    inverted: false,
    feather: { v: [0, 0] },
    expansion: { v: 0 },
    opacity: { v: 100 },
  }));
}

// A hidden layer whose pixels are the matte at `endpoint`.
export function matteSource(scope: Scope, endpoint: string): { layers: AeLayer[]; matte: AeLayer; type: "ALPHA" | "LUMA" } {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  if (isSplineEndpoint(scope, endpoint)) {
    const g = geometry(scope, endpoint, { top: false, canHoist: false, explicit: false });
    const contents: AeShapeItem[] = [{ kind: "group", name: "matte", contents: [...g.items, { kind: "fill", color: { v: [1, 1, 1] }, opacity: { v: 100 }, rule: "evenodd" }] }];
    const L = newLayer(scope, "shape", `${ctx.graph.name(id)} matte`, [id], { contents, enabled: false });
    return { layers: [L], matte: L, type: "ALPHA" };
  }
  const r = collapse(scope, scope.render(endpoint), `${ctx.graph.name(id)} matte`);
  const m = r.main!;
  m.enabled = false;
  return { layers: r.layers, matte: m, type: "LUMA" };
}

// The universal mask on a node WITHOUT a base image: the mask multiplies the
// output (a source, a shape's style node).
export function applyImageMask(scope: Scope, r: Rendered, id: string, maskEp: string): Rendered {
  const { ctx } = scope;
  const s = collapse(scope, r, ctx.graph.name(id));
  const main = s.main!;
  if (isSplineEndpoint(scope, maskEp) && ctx.free.has(main)) {
    main.masks = [...(main.masks ?? []), ...splineMasks(scope, maskEp)];
    ctx.report.note(id, "spline mask → layer mask (add)");
    return s;
  }
  const m = matteSource(scope, maskEp);
  main.matte = { layer: m.matte.id, type: m.type };
  ctx.report.note(id, m.type === "ALPHA" ? "spline mask → a hidden shape layer as ALPHA track matte (the layer transform is taken)" : "image mask → LUMA track matte (luma × alpha)");
  return { layers: [...m.layers, ...s.layers.filter((l) => l !== main), main].filter((l, i, a) => a.indexOf(l) === i), main };
}

export function withMatte(main: AeLayer, m: { layers: AeLayer[]; matte: AeLayer; type: "ALPHA" | "LUMA" }, inverted: boolean): Rendered {
  main.matte = { layer: m.matte.id, type: inverted ? (m.type === "ALPHA" ? "ALPHA_INVERTED" : "LUMA_INVERTED") : m.type };
  return rendered(main, m.layers);
}
