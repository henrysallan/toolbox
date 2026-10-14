// Skia Bake at export (specdocs/101326_skia-target.md §3.2, the `bake`
// class; Wave 3 lane B). A Skia Bake node draws an ENGINE image inside a
// Skia layer as the asset `bake:<nodeId>`. The scene exporter can't lower
// that image — it is whatever the engine renders — so it ships pixels:
//
//   static    nothing upstream changes over the timeline → ONE PNG of the
//             frame at canvas size; the IR is the node's own `image` draw.
//   animated  a SPRITE SHEET (AssetIR.sheet): one cell per baked frame at
//             the bake fps (default: the timeline's), in a grid capped at
//             max_sheet px per side (frames shrink to fit, with a warning).
//             The draw becomes a clipped Group holding the whole sheet,
//             offset so the current frame's cell sits on the node's rect:
//
//               <Group clip={rect(x, y, w, h)}>
//                 <Image image={sheet} x={X(f)} y={Y(f)} width={SW} height={SH} fit="fill" />
//
//             X / Y are HOLD binds (scene-ir.ts Bind.hold): sampled at every
//             exported frame and stepped — never interpolated — between
//             frames, so every tick shows exactly the editor's frame
//             (floor(tick) at the bake fps). In every animation mode they
//             ride sampleBinds: worklet (the master clock), baked (non-
//             program binds stay on the worklet timeline), native (the
//             linear clock shared value). With the sheet at scale 1 the
//             offsets are whole pixels and Linear sampling lands on texel
//             centres: the drawn cell is the frame, bit for bit
//             (check-skia-bake measures it, and the alternatives).
//
// The bytes come from rendering the bake's input with the real engine —
// the editor (EffectsApp), MCP, or the Electron CLI harness — through the
// export's asset seam (editor.ts SkiaExportEnv.resolveAsset): this module
// plans, rewrites the IR, composes sheets and resolves `bake:` URLs given a
// frame renderer; it does no GL itself.
//
// "auto" decides static vs animated from the graph (keyframes, clip
// windows, time-driven defs, and fingerprintExtras that move with the
// tick — Noise's `animated`, an SkSL Shader reading iTime) and the
// editor's export then checks it against the rendered frames: an "animated"
// bake whose frames are all identical ships as one PNG, a "static" one
// whose sample frames differ ships as a sheet (editor.ts re-exports once).

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { getNodeDef } from "@/engine/registry";
import { BAKE_IMAGE_HANDLE, bakeNodeOfUrl, bakeUrl, SKIA_BAKE_TYPE } from "@/engine/skia/bake-frames";
import { bindStatic, type AssetIR, type AssetSheetIR, type Bind, type ShaderIR, type SkiaNode, type SkiaScene } from "@/engine/skia/scene-ir";
import { liveBlock } from "./drivers";
import { encodePng } from "./png";
import { dataOnlyContext } from "./scene-sample";

export { BAKE_IMAGE_HANDLE };
// Gutter around every cell, repeating its edge pixels: a scaled or
// sub-pixel draw of the sheet never samples the neighbouring cell.
export const BAKE_SHEET_PAD = 1;
export const BAKE_DEFAULT_CAP = 4096;
const CAPS = new Set([2048, 4096, 8192]);
// Frames a static auto bake renders to confirm nothing moves.
const STATIC_PROBES = 5;

export type BakeMode = "static" | "animated";
export type BakeRequest = "auto" | BakeMode;

export interface BakeSource {
  node: string;
  handle: string;
}

export interface SheetLayout {
  frameWidth: number;
  frameHeight: number;
  cols: number;
  rows: number;
  pad: number;
  sheetWidth: number;
  sheetHeight: number;
  cap: number;
  // Frames are smaller than the canvas (they didn't fit at full size).
  scaled: boolean;
}

export interface BakePlan {
  nodeId: string;
  assetId: string;
  source: BakeSource;
  requested: BakeRequest;
  mode: BakeMode;
  // Why that mode ("Bake is set to Static PNG", "noise is keyframed", …).
  why: string;
  // The frame size the engine renders at: the canvas.
  width: number;
  height: number;
  // Animated only: cells per second, the grid, exported frame → cell, and
  // the tick (exported clock) each cell is rendered at.
  fps?: number;
  layout?: SheetLayout;
  cellOfFrame?: number[];
  ticks?: number[];
}

export interface BakeTimeline {
  fps: number;
  ticksPerFrame: number;
  sceneDurationTicks: number;
}

// Frames the scene planner samples (0 … duration inclusive) — scene-plan.ts.
export function exportedFrames(t: BakeTimeline): number {
  return Math.max(1, Math.ceil(t.sceneDurationTicks / t.ticksPerFrame) + 1);
}

export function bakeSourceOf(edges: GraphEdge[], bakeId: string): BakeSource | null {
  const e = edges.find((x) => x.target === bakeId && x.targetHandle === BAKE_IMAGE_HANDLE);
  return e ? { node: e.source, handle: e.sourceHandle || "out:primary" } : null;
}

// Is an edge the input wire of a Skia Bake? The scene sampler stops there:
// the engine graph behind it is rendered by the bake renderer, never by
// the GL-less sampler.
export function isBakeInputEdge(e: GraphEdge, byId: Map<string, GraphNode>): boolean {
  return e.targetHandle === BAKE_IMAGE_HANDLE && byId.get(e.target)?.type === SKIA_BAKE_TYPE;
}

export function bakeRequestOf(params: Record<string, unknown> | undefined): BakeRequest {
  const m = params?.mode;
  return m === "static" || m === "animated" ? m : "auto";
}

// ---- time dependence -------------------------------------------------------------------

// Why what feeds `bakeId`'s image could change over the timeline, or null
// when nothing can. Walks the flattened graph upstream of the input wire:
// keyframes, clip windows, time-driven defs (stable: false, tickDriven),
// and fingerprintExtras that differ between ticks (how Noise's `animated`,
// Gradient's phase animation or an SkSL Shader reading iTime tell the
// evaluator they move). A def it can't probe counts as moving.
export function bakeTimeDependence(
  nodes: GraphNode[],
  edges: GraphEdge[],
  bakeId: string,
  canvas: { width: number; height: number },
  timeline: BakeTimeline
): string | null {
  const src = bakeSourceOf(edges, bakeId);
  if (!src) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const frames = exportedFrames(timeline);
  const probes = [...new Set([0, 1, Math.floor((frames - 1) / 2), frames - 1])].filter((f) => f < frames);
  const ctx = dataOnlyContext(canvas, timeline);
  const at = (f: number) => {
    ctx.tick = f * timeline.ticksPerFrame;
    ctx.frame = f;
    ctx.time = f / timeline.fps;
  };
  const seen = new Set<string>();
  const stack = [src.node];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    const def = getNodeDef(n.type);
    if (!def) return `${id} (${n.type}) is not a registered node type — assumed to animate`;
    const keyed = Object.keys(n.animation ?? {}).find((k) => liveBlock(n, k));
    if (keyed) return `${id} (${n.type}) is keyframed (${keyed})`;
    if (n.clips?.some((c) => c.enabled)) return `${id} (${n.type}) sits on a clip window`;
    if (def.stable === false || def.tickDriven) return `${id} (${n.type}) is time-driven`;
    if (def.fingerprintExtras) {
      try {
        const seenFp = new Set<string>();
        for (const f of probes) {
          at(f);
          seenFp.add(String(def.fingerprintExtras(n.params, ctx, n.id) ?? ""));
        }
        if (seenFp.size > 1) return `${id} (${n.type}) changes with the playhead`;
      } catch {
        return `${id} (${n.type})'s time dependence could not be probed — assumed to animate`;
      }
    }
    for (const e of edges) if (e.target === id) stack.push(e.source);
  }
  return null;
}

// Does a simulation (NodeDefinition.simulation, not bypassed) feed `source`?
// Then its frames only reproduce when rendered in order from frame 0 —
// a renderer steps every frame, not just the baked ones (lib/sim-preroll.ts
// is the editor-graph twin).
export function bakeNeedsSequential(nodes: GraphNode[], edges: GraphEdge[], source: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [source];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (n && !n.bypassed && getNodeDef(n.type)?.simulation) return true;
    for (const e of edges) if (e.target === id) stack.push(e.source);
  }
  return false;
}

// ---- frames and the sheet --------------------------------------------------------------

// Exported frame → cell at `bakeFps` (≤ fps), and the tick each cell holds:
// cell k shows from the first frame that maps to it, so frame f shows the
// newest baked frame at or before f.
export function bakeFrameMap(frames: number, fps: number, bakeFps: number, ticksPerFrame: number): { cellOfFrame: number[]; ticks: number[] } {
  const r = Math.min(1, bakeFps / fps);
  const cellOfFrame = Array.from({ length: frames }, (_, f) => Math.floor(f * r + 1e-9));
  const cells = cellOfFrame[frames - 1] + 1;
  const ticks = Array.from({ length: cells }, (_, k) => Math.ceil(k / r - 1e-9) * ticksPerFrame);
  return { cellOfFrame, ticks };
}

// The grid for `count` frames of width × height under `cap` px per side:
// full size when it fits, else the largest aspect-kept frame that does.
// Null when not even 1-px frames fit.
export function layoutSheet(width: number, height: number, count: number, cap: number, pad = BAKE_SHEET_PAD): SheetLayout | null {
  const grid = (fw: number, fh: number) => {
    const cols = Math.min(count, Math.floor(cap / (fw + 2 * pad)));
    if (cols < 1) return null;
    const rows = Math.ceil(count / cols);
    return rows * (fh + 2 * pad) <= cap ? { cols, rows } : null;
  };
  let fw = width;
  let fh = height;
  let g = grid(fw, fh);
  if (!g) {
    let lo = 1;
    let hi = width - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (grid(mid, Math.max(1, Math.round((mid * height) / width)))) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (!best) return null;
    fw = best;
    fh = Math.max(1, Math.round((best * height) / width));
    g = grid(fw, fh)!;
  }
  // As few empty cells as the row count allows.
  const rows = g.rows;
  const cols = Math.ceil(count / rows);
  return {
    frameWidth: fw,
    frameHeight: fh,
    cols,
    rows,
    pad,
    sheetWidth: cols * (fw + 2 * pad),
    sheetHeight: rows * (fh + 2 * pad),
    cap,
    scaled: fw !== width || fh !== height,
  };
}

// Cell k's top-left in sheet px (inside its gutter).
export function cellOrigin(layout: SheetLayout, k: number): [number, number] {
  const col = k % layout.cols;
  const row = Math.floor(k / layout.cols);
  return [col * (layout.frameWidth + 2 * layout.pad) + layout.pad, row * (layout.frameHeight + 2 * layout.pad) + layout.pad];
}

// Area-averaged resample of straight RGBA8, in premultiplied space (so a
// transparent neighbour never darkens an edge). Box filter: exact for
// integer ratios, the usual average otherwise.
export function resampleRgba(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return new Uint8Array(src);
  const taps = (n: number, m: number) =>
    Array.from({ length: m }, (_, d) => {
      const a = (d * n) / m;
      const b = ((d + 1) * n) / m;
      const out: [number, number][] = [];
      for (let s = Math.floor(a); s < Math.min(n, Math.ceil(b)); s++) {
        const w = Math.min(b, s + 1) - Math.max(a, s);
        if (w > 0) out.push([s, w]);
      }
      return out;
    });
  const tx = taps(sw, dw);
  const ty = taps(sh, dh);
  // Horizontal pass → premultiplied floats (dw × sh × 4).
  const mid = new Float64Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (const [s, w] of tx[x]) {
        const i = (y * sw + s) * 4;
        const al = src[i + 3] / 255;
        r += w * src[i] * al;
        g += w * src[i + 1] * al;
        b += w * src[i + 2] * al;
        a += w * al;
        wsum += w;
      }
      const o = (y * dw + x) * 4;
      mid[o] = r / wsum;
      mid[o + 1] = g / wsum;
      mid[o + 2] = b / wsum;
      mid[o + 3] = a / wsum;
    }
  }
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (const [s, w] of ty[y]) {
        const i = (s * dw + x) * 4;
        r += w * mid[i];
        g += w * mid[i + 1];
        b += w * mid[i + 2];
        a += w * mid[i + 3];
        wsum += w;
      }
      const o = (y * dw + x) * 4;
      a /= wsum;
      out[o + 3] = Math.round(a * 255);
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / wsum / a));
        out[o + 1] = Math.min(255, Math.round(g / wsum / a));
        out[o + 2] = Math.min(255, Math.round(b / wsum / a));
      }
    }
  }
  return out;
}

// The sheet's RGBA8: every frame resampled to the cell size (when scaled),
// written into its cell, its gutter filled with its own edge pixels.
// Cells past the last frame stay transparent.
export function composeSheet(frames: (Uint8Array | Uint8ClampedArray)[], srcW: number, srcH: number, layout: SheetLayout): Uint8Array {
  const { frameWidth: fw, frameHeight: fh, pad, sheetWidth: SW } = layout;
  const out = new Uint8Array(layout.sheetWidth * layout.sheetHeight * 4);
  frames.forEach((frame, k) => {
    const cell = resampleRgba(frame, srcW, srcH, fw, fh);
    const [cx, cy] = cellOrigin(layout, k);
    for (let y = -pad; y < fh + pad; y++) {
      const sy = Math.min(fh - 1, Math.max(0, y));
      for (let x = -pad; x < fw + pad; x++) {
        const sx = Math.min(fw - 1, Math.max(0, x));
        const i = (sy * fw + sx) * 4;
        const o = ((cy + y) * SW + (cx + x)) * 4;
        out[o] = cell[i];
        out[o + 1] = cell[i + 1];
        out[o + 2] = cell[i + 2];
        out[o + 3] = cell[i + 3];
      }
    }
  });
  return out;
}

// ---- planning ------------------------------------------------------------------------------

function capOf(params: Record<string, unknown>): number {
  const n = Number(params.max_sheet);
  return CAPS.has(n) ? n : BAKE_DEFAULT_CAP;
}

export function planBake(
  node: GraphNode,
  source: BakeSource,
  nodes: GraphNode[],
  edges: GraphEdge[],
  canvas: { width: number; height: number },
  timeline: BakeTimeline,
  assetId: string
): { plan: BakePlan | null; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const requested = bakeRequestOf(node.params);
  const base = { nodeId: node.id, assetId, source, requested, width: canvas.width, height: canvas.height };
  let mode: BakeMode;
  let why: string;
  if (requested === "static") {
    mode = "static";
    why = "Bake is set to Static PNG";
  } else if (requested === "animated") {
    mode = "animated";
    why = "Bake is set to Sprite sheet";
  } else {
    const dep = bakeTimeDependence(nodes, edges, node.id, canvas, timeline);
    mode = dep ? "animated" : "static";
    why = dep ?? "nothing upstream of its image changes over the timeline";
  }
  const frames = exportedFrames(timeline);
  if (mode === "static" || frames < 2) return { plan: { ...base, mode: "static", why }, problems, warnings };

  const raw = Number(node.params.fps);
  const bakeFps = Number.isFinite(raw) && raw > 0 ? Math.min(raw, timeline.fps) : timeline.fps;
  const map = bakeFrameMap(frames, timeline.fps, bakeFps, timeline.ticksPerFrame);
  const cap = capOf(node.params);
  const layout = layoutSheet(canvas.width, canvas.height, map.ticks.length, cap);
  const label = `Skia Bake "${node.id}"`;
  if (!layout) {
    problems.push(`${label}: ${map.ticks.length} frames don't fit a ${cap}×${cap} sprite sheet even at 1 px — lower Bake FPS or raise Max sheet.`);
    return { plan: null, problems, warnings };
  }
  if (map.ticks.length === 1) return { plan: { ...base, mode: "static", why: `${why}; one frame at ${bakeFps} fps` }, problems, warnings };
  if (layout.scaled) {
    warnings.push(
      `${label}: ${map.ticks.length} frames at ${canvas.width}×${canvas.height} don't fit a ${cap}×${cap} sprite sheet — baked at ${layout.frameWidth}×${layout.frameHeight} (${((layout.frameWidth / canvas.width) * 100).toFixed(1)} %) and scaled up on device. Lower Bake FPS, shorten the timeline or raise Max sheet to keep full resolution.`
    );
  }
  if (bakeFps < timeline.fps) {
    warnings.push(`${label}: baked at ${bakeFps} fps — each baked frame holds until the next (${(timeline.fps / bakeFps).toFixed(2)} timeline frames); the editor previews every frame.`);
  }
  const mb = (layout.sheetWidth * layout.sheetHeight * 4) / 1048576;
  if (mb > 32) {
    warnings.push(`${label}: the ${layout.sheetWidth}×${layout.sheetHeight} sheet decodes to ${mb.toFixed(0)} MB of GPU memory on device.`);
  }
  return {
    plan: { ...base, mode: "animated", why, fps: bakeFps, layout, cellOfFrame: map.cellOfFrame, ticks: map.ticks },
    problems,
    warnings,
  };
}

function isStatic(b: Bind<number> | undefined): boolean {
  return !!b && typeof b.v === "number" && Number.isFinite(b.v) && !b.ref && !b.deps && !b.hold;
}

// Every way a scene can reference an asset other than an `image` draw.
function nonDrawUses(n: SkiaNode, out: Set<string>): void {
  const shader = (s: ShaderIR | undefined) => {
    if (!s) return;
    if (s.k === "image") out.add(s.asset);
    if (s.k === "runtime") s.program.children.forEach((c) => shader(c.shader));
  };
  switch (n.k) {
    case "group":
      for (const f of n.layer?.imageFilters ?? []) {
        if (f.k === "displacement") shader(f.map);
      }
      n.children.forEach((c) => nonDrawUses(c, out));
      return;
    case "fill":
    case "shape":
    case "text":
      shader(n.paint.shader);
      return;
    case "atlas":
      out.add(n.asset);
      // A sprite texture (Copy to Points (Skia)) renders its sub-scene ONCE:
      // a sheet inside it could never step.
      if (n.texture?.node) {
        const inner: Extract<SkiaNode, { k: "image" }>[] = [];
        imageDraws(n.texture.node, inner);
        for (const d of inner) out.add(d.asset);
        nonDrawUses(n.texture.node, out);
      }
      return;
    default:
      return;
  }
}

function imageDraws(n: SkiaNode, out: Extract<SkiaNode, { k: "image" }>[]): void {
  if (n.k === "group") n.children.forEach((c) => imageDraws(c, out));
  else if (n.k === "image") out.push(n);
}

export interface SceneBakes {
  plans: BakePlan[];
  problems: string[];
  warnings: string[];
  // The scene the exporter plans and emits at `tick`: animated bakes'
  // draws become the clipped sheet draw for that tick's cell.
  rewrite(scene: SkiaScene | null, tick: number): SkiaScene | null;
}

// Plan every Skia Bake the tick-0 scene draws (its `bake:` assets).
export function planSceneBakes(
  scene: SkiaScene,
  nodes: GraphNode[],
  edges: GraphEdge[],
  canvas: { width: number; height: number },
  timeline: BakeTimeline
): SceneBakes {
  const problems: string[] = [];
  const warnings: string[] = [];
  const plans: BakePlan[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const other = new Set<string>();
  nonDrawUses(scene.root, other);
  const draws: Extract<SkiaNode, { k: "image" }>[] = [];
  imageDraws(scene.root, draws);
  for (const [assetId, asset] of Object.entries(scene.assets ?? {})) {
    const id = bakeNodeOfUrl(asset?.url);
    if (!id) continue;
    const node = byId.get(id);
    if (!node || node.type !== SKIA_BAKE_TYPE) {
      problems.push(`Asset "${assetId}" is a bake (${asset.url}), but "${id}" is not a Skia Bake node in this graph.`);
      continue;
    }
    const source = bakeSourceOf(edges, id);
    if (!source) {
      problems.push(
        `Skia Bake "${id}" has nothing wired into its image — build the engine image outside the Skia layer and wire it in through a Layer Input socket.`
      );
      continue;
    }
    const r = planBake(node, source, nodes, edges, canvas, timeline, assetId);
    problems.push(...r.problems);
    warnings.push(...r.warnings);
    if (!r.plan) continue;
    if (r.plan.mode === "animated") {
      const mine = draws.filter((d) => d.asset === assetId);
      if (other.has(assetId)) {
        problems.push(`Skia Bake "${id}": an animated bake ships as a sprite sheet, which only an image draw can step through — it is used as a shader, an atlas or inside a Copy to Points (Skia) sprite texture here (set Bake to Static PNG there).`);
        continue;
      }
      const bad = mine.find((d) => d.fit !== "fill" || ![d.x, d.y, d.w, d.h].every(isStatic));
      if (bad) {
        problems.push(`Skia Bake "${id}": an animated bake draws at a fixed rect with fit "fill" — move it with a Skia Group instead.`);
        continue;
      }
    }
    plans.push(r.plan);
  }

  const animated = new Map(plans.filter((p) => p.mode === "animated").map((p) => [p.assetId, p]));
  const sheetAssets = new Map<string, AssetIR>();
  for (const p of animated.values()) {
    const L = p.layout!;
    const sheet: AssetSheetIR = {
      frameWidth: L.frameWidth,
      frameHeight: L.frameHeight,
      cols: L.cols,
      rows: L.rows,
      pad: L.pad,
      ticks: p.ticks!,
      fps: p.fps!,
      sourceWidth: p.width,
      sourceHeight: p.height,
    };
    sheetAssets.set(p.assetId, { id: p.assetId, kind: "image", mime: "image/png", url: bakeUrl(p.nodeId), width: L.sheetWidth, height: L.sheetHeight, sheet });
  }

  const rewrite = (s: SkiaScene | null, tick: number): SkiaScene | null => {
    if (!s || !animated.size) return s;
    const frame = Math.max(0, Math.round(tick / timeline.ticksPerFrame));
    const map = (n: SkiaNode): SkiaNode => {
      if (n.k === "group") {
        const kids = n.children.map(map);
        return kids.every((c, i) => c === n.children[i]) ? n : { ...n, children: kids };
      }
      const p = n.k === "image" ? animated.get(n.asset) : undefined;
      if (n.k !== "image" || !p) return n;
      const cells = p.cellOfFrame!;
      return bakeSheetDraw(n, p.layout!, cells[Math.min(cells.length - 1, frame)]);
    };
    const assets: Record<string, AssetIR> = { ...s.assets };
    for (const [id, a] of sheetAssets) assets[id] = a;
    return { ...s, root: map(s.root), assets };
  };

  return { plans, problems, warnings, rewrite };
}

// An image draw of a sprite sheet showing cell `k` on the draw's own rect:
// the whole sheet, scaled so one cell covers the rect and offset so cell k
// sits on it, clipped to the rect. The offsets are HOLD binds.
export function bakeSheetDraw(n: Extract<SkiaNode, { k: "image" }>, L: SheetLayout, k: number): SkiaNode {
  const x0 = n.x.v;
  const y0 = n.y.v;
  const w = n.w.v;
  const h = n.h.v;
  const sx = w / L.frameWidth;
  const sy = h / L.frameHeight;
  const [cx, cy] = cellOrigin(L, k);
  return {
    k: "group",
    ...(n.id ? { id: n.id } : {}),
    clip: { geom: { k: "rect", x: bindStatic(x0), y: bindStatic(y0), w: bindStatic(w), h: bindStatic(h) } },
    children: [
      {
        k: "image",
        ...(n.id ? { id: n.id } : {}),
        asset: n.asset,
        x: { v: x0 - cx * sx, hold: true },
        y: { v: y0 - cy * sy, hold: true },
        w: bindStatic(L.sheetWidth * sx),
        h: bindStatic(L.sheetHeight * sy),
        fit: "fill",
      },
    ],
  };
}

// ---- resolving `bake:` assets (editor / MCP / CLI) -----------------------------------------

export interface BakeRenderTarget {
  nodeId: string;
  source: BakeSource;
}

// Straight RGBA8 (row 0 = top) of what is wired into the bake's image, at
// `size`, rendered by the real engine at each COMPOSITION tick (ascending;
// the resolver adds a late layer's offset). A null entry = that frame
// failed to render.
export type BakeFrameRenderer = (
  bake: BakeRenderTarget,
  ticks: number[],
  size: { width: number; height: number }
) => Promise<(Uint8Array | Uint8ClampedArray | null)[]>;

// `render` with every frame it has drawn remembered (by bake, size and
// tick): a second export round (an Auto flip) re-renders nothing.
export function cachingBakeRenderer(render: BakeFrameRenderer): BakeFrameRenderer {
  const cache = new Map<string, Uint8Array | Uint8ClampedArray>();
  return async (bake, ticks, size) => {
    const key = (t: number) => `${bake.nodeId}|${bake.source.node}|${bake.source.handle}|${size.width}x${size.height}|${t}`;
    const need = [...new Set(ticks.filter((t) => !cache.has(key(t))))].sort((a, b) => a - b);
    if (need.length) {
      const got = await render(bake, need, size);
      need.forEach((t, i) => {
        const px = got[i];
        if (px) cache.set(key(t), px);
      });
    }
    return ticks.map((t) => cache.get(key(t)) ?? null);
  };
}

export interface BakeReport {
  nodeId: string;
  requested: BakeRequest;
  shipped: BakeMode;
  frames: number;
  distinct: number;
  bytes: number;
  // The rendered frames disagree with what "auto" chose: re-export as this.
  flip?: BakeMode;
}

function fnv(px: Uint8Array | Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) {
    h ^= px[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${h >>> 0}:${px.length}`;
}

function sameBytes(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface BakeResolverOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  timeline: BakeTimeline;
  canvas: { width: number; height: number };
  // Exported clock → composition clock (a late Skia layer's in-point).
  clockOffsetTicks?: number;
  render: BakeFrameRenderer;
  encode?: (rgba: Uint8Array, w: number, h: number) => Promise<Uint8Array>;
}

export interface BakeAssetResolver {
  // PNG bytes for a `bake:` asset (null: not a bake, or it failed — see
  // problems()).
  resolveAsset(asset: AssetIR): Promise<Uint8Array | null>;
  reports(): BakeReport[];
  problems(): string[];
  warnings(): string[];
}

export function makeBakeAssetResolver(o: BakeResolverOptions): BakeAssetResolver {
  const byId = new Map(o.nodes.map((n) => [n.id, n]));
  const offset = o.clockOffsetTicks ?? 0;
  const encode = o.encode ?? encodePng;
  const cache = new Map<string, Uint8Array | Uint8ClampedArray>();
  const reports = new Map<string, BakeReport>();
  const problems: string[] = [];
  const warnings: string[] = [];

  const frames = async (target: BakeRenderTarget, ticks: number[], size: { width: number; height: number }) => {
    const key = (t: number) => `${target.nodeId}|${size.width}x${size.height}|${t}`;
    const need = [...new Set(ticks.filter((t) => !cache.has(key(t))))].sort((a, b) => a - b);
    if (need.length) {
      const got = await o.render(target, need.map((t) => t + offset), size);
      need.forEach((t, i) => {
        const px = got[i];
        if (px && px.length === size.width * size.height * 4) cache.set(key(t), px);
      });
    }
    return ticks.map((t) => cache.get(key(t)) ?? null);
  };

  return {
    reports: () => [...reports.values()],
    problems: () => [...problems],
    warnings: () => [...warnings],
    async resolveAsset(asset) {
      const id = bakeNodeOfUrl(asset.url);
      if (!id) return null;
      const node = byId.get(id);
      const source = bakeSourceOf(o.edges, id);
      const label = `Skia Bake "${id}"`;
      if (!node || !source) {
        problems.push(`${label}: not in the exported graph, or nothing is wired into its image.`);
        return null;
      }
      const requested = bakeRequestOf(node.params);
      const target = { nodeId: id, source };
      const sheet = asset.sheet;
      if (!sheet) {
        const size = { width: asset.width ?? o.canvas.width, height: asset.height ?? o.canvas.height };
        const all = exportedFrames(o.timeline);
        const probe =
          requested === "auto"
            ? [...new Set(Array.from({ length: STATIC_PROBES }, (_, i) => Math.round((i * (all - 1)) / (STATIC_PROBES - 1))))].map(
                (f) => f * o.timeline.ticksPerFrame
              )
            : [0];
        const got = await frames(target, probe, size);
        const first = got[0];
        if (!first) {
          problems.push(`${label}: the engine could not render its image at frame 0.`);
          return null;
        }
        const moved = got.findIndex((px) => px && !sameBytes(px, first));
        const png = await encode(new Uint8Array(first), size.width, size.height);
        reports.set(id, {
          nodeId: id,
          requested,
          shipped: "static",
          frames: 1,
          distinct: 1,
          bytes: png.length,
          ...(moved > 0 ? { flip: "animated" as const } : {}),
        });
        if (moved > 0) {
          warnings.push(`${label}: shipped as one PNG, but its image at frame ${probe[moved] / o.timeline.ticksPerFrame} differs from frame 0 — set Bake to Sprite sheet.`);
        }
        return png;
      }
      const size = { width: sheet.sourceWidth, height: sheet.sourceHeight };
      const got = await frames(target, sheet.ticks, size);
      const missing = got.findIndex((px) => !px);
      if (missing >= 0) {
        problems.push(`${label}: the engine could not render its image at frame ${sheet.ticks[missing] / o.timeline.ticksPerFrame}.`);
        return null;
      }
      const px = got as (Uint8Array | Uint8ClampedArray)[];
      const distinct = new Set(px.map(fnv)).size;
      const layout: SheetLayout = {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        cols: sheet.cols,
        rows: sheet.rows,
        pad: sheet.pad,
        sheetWidth: asset.width ?? sheet.cols * (sheet.frameWidth + 2 * sheet.pad),
        sheetHeight: asset.height ?? sheet.rows * (sheet.frameHeight + 2 * sheet.pad),
        cap: 0,
        scaled: sheet.frameWidth !== size.width || sheet.frameHeight !== size.height,
      };
      const png = await encode(composeSheet(px, size.width, size.height, layout), layout.sheetWidth, layout.sheetHeight);
      const constant = distinct === 1;
      reports.set(id, {
        nodeId: id,
        requested,
        shipped: "animated",
        frames: px.length,
        distinct,
        bytes: png.length,
        ...(constant && requested === "auto" ? { flip: "static" as const } : {}),
      });
      if (constant && requested !== "auto") {
        warnings.push(`${label}: all ${px.length} baked frames are identical — set Bake to Static PNG to ship one frame instead of a ${layout.sheetWidth}×${layout.sheetHeight} sheet.`);
      }
      return png;
    },
  };
}

// The request's graph with each bake's `mode` replaced (a copy; the editor
// graph is untouched) — how the editor re-exports a bake whose rendered
// frames contradict "auto".
export function withBakeModes(nodes: GraphNode[], modes: ReadonlyMap<string, BakeMode>): GraphNode[] {
  if (!modes.size) return nodes;
  return nodes.map((n) => {
    const m = modes.get(n.id);
    return m && n.type === SKIA_BAKE_TYPE ? { ...n, params: { ...n.params, mode: m } } : n;
  });
}
