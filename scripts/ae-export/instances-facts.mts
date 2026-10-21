// The instances lane's scene facts (M4, specdocs/ae-m4/instances.md), run by
// check-scene-facts: every r- fixture's copies against toolbox's own
// (scripts/fixtures/ae-export/graphs/instances-reference.mts), the Repeater
// forms (lattices, Array, opacity ramps), keys, effects, and what still bakes.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Checker } from "./harness.mts";
import type { AeLayer, AeShapeItem } from "@/lib/ae-export/types";
import type { AeSceneBuild } from "@/lib/ae-export/scene";

type V2 = [number, number];

// Centres of every copy a shape layer's contents draw (Repeaters expanded,
// group transforms applied), in drawing order; `leaf` gives an item's centre.
function copyCenters(list: AeShapeItem[], leaf: (it: AeShapeItem) => V2 | null): V2[] {
  let pts: V2[] = [];
  for (const it of list) {
    if (it.kind === "group") {
      const t = it.transform ?? {};
      const a = ((t.anchor as any)?.v ?? [0, 0]) as V2;
      const p = ((t.position as any)?.v ?? [0, 0]) as V2;
      const s = ((t.scale as any)?.v ?? [100, 100]) as V2;
      const r = (((t.rotation as any)?.v ?? 0) * Math.PI) / 180;
      for (const q of copyCenters(it.contents, leaf)) {
        const dx = ((q[0] - a[0]) * s[0]) / 100;
        const dy = ((q[1] - a[1]) * s[1]) / 100;
        pts.push([p[0] + Math.cos(r) * dx - Math.sin(r) * dy, p[1] + Math.sin(r) * dx + Math.cos(r) * dy]);
      }
    } else if (it.kind === "repeater") {
      const d = (it.transform.position as any).v as V2;
      const out: V2[] = [];
      for (let c = 0; c < (it.copies as any).v; c++) for (const q of pts) out.push([q[0] + c * d[0], q[1] + c * d[1]]);
      pts = out;
    } else {
      const l = leaf(it);
      if (l) pts.push(l);
    }
  }
  return pts;
}

const centerOf = (it: AeShapeItem): V2 | null => (it.kind === "polystar" || it.kind === "rect" || it.kind === "ellipse" ? ((it.position as any).v as V2) : null);
const flatItems = (xs: AeShapeItem[] | undefined, out: AeShapeItem[] = []): AeShapeItem[] => {
  for (const it of xs ?? []) {
    out.push(it);
    if (it.kind === "group") flatItems(it.contents, out);
  }
  return out;
};
const worstPair = (a: V2[], b: V2[]) => (a.length !== b.length ? Infinity : Math.max(0, ...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))));

export async function instanceFacts(c: Checker): Promise<void> {
  const ref = await import("../fixtures/ae-export/graphs/instances-reference.mts");
  const { sceneOf, buildFixture, track } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  const { makeAeGraph } = await import("@/lib/ae-export/scene/graph");
  const { latticeOf, opacityRamp } = await import("@/lib/ae-export/scene/instances");
  const { validateAeScene } = await import("@/lib/ae-export/runtime/validate");
  const builds = new Map<string, AeSceneBuild>();
  const build = async (name: string, opts: Record<string, unknown> = {}) => {
    const f = ref.fixtureNamed(name);
    if (!Object.keys(opts).length && builds.has(name)) return builds.get(name)!;
    const b = await sceneOf({ ...f, opts: { ...f.opts, ...opts } });
    if (!Object.keys(opts).length) builds.set(name, b);
    return b;
  };
  const all = (b: AeSceneBuild) => b.scene.comps.flatMap((x) => x.layers);
  // The copy layers of a node, in the precomp of the toolbox layer holding it.
  const copiesIn = (b: AeSceneBuild, layer: string, copy: string) => (ref.layerComp(b.scene, layer)?.layers ?? []).filter((l) => l.kind === "precomp" && l.origin?.includes(copy));

  // --- every copy against toolbox's -------------------------------------------------------
  for (const k of ref.INSTANCE_CASES) {
    const b = await build(k.fixture);
    c.check(`(r) ${k.fixture}/${k.copy}: maps — no bake, no problem`, b.bakes.length === 0 && b.problems.length === 0 && validateAeScene(b.scene).length === 0, [...b.problems, ...b.bakes.map((x) => x.reason)]);
    const want = await ref.toolboxCopies(ref.fixtureNamed(k.fixture), k.copy, k.frames);
    for (let n = 0; n < k.frames.length; n++) {
      const got = await ref.sceneCopies(b.scene, k, k.frames[n]);
      ref.compareCopies(`(r) ${k.fixture}/${k.copy} frame ${k.frames[n]}`, got, want[n], c, { rotTol: k.rotTol, flat: k.colors[0] });
    }
  }

  // --- structure ------------------------------------------------------------------------------
  {
    const b = await build("r-tint-opacity");
    const dots = copiesIn(b, "Tinted dots", "copy");
    const boxes = copiesIn(b, "Tinted boxes", "copy2");
    c.check("(r tint) a white instance takes a Fill effect (its colour × the tint), one per copy", dots.length === 8 && dots.every((l) => l.effects?.length === 1 && l.effects[0].match === "ADBE Fill" && Object.keys(l.effects[0].props).join() === "ADBE Fill-0002"), dots.map((l) => l.effects?.map((e) => e.match)));
    c.check("(r tint) a two-colour instance takes a Channel Mixer (R-R, G-G, B-B = 100 · tint)", boxes.length === 3 && boxes.every((l) => l.effects?.[0].match === "ADBE CHANNEL MIXER" && Object.keys(l.effects[0].props).join() === "ADBE CHANNEL MIXER-0001,ADBE CHANNEL MIXER-0006,ADBE CHANNEL MIXER-0011"), boxes.map((l) => l.effects?.map((e) => e.match)));
    c.check("(r tint) every copy of a node shares ONE instance precomp", new Set(dots.map((l) => l.source)).size === 1 && new Set(boxes.map((l) => l.source)).size === 1);
  }
  {
    const b = await build("r-picks");
    const cases = [["pick_rand", "Random picks"], ["pick_cycle", "Cycled by y"], ["pick_attr", "Attribute picks"], ["pick_all", "Every variant"]];
    const comps = ([copy, layer]: string[]) => new Set(copiesIn(b, layer, copy).map((l) => l.source));
    c.check("(r picks) three variants → three instance precomps per node, each a Combine item", cases.every((x) => comps(x).size === 3), cases.map((x) => comps(x).size));
    const every = copiesIn(b, "Every variant", "pick_all");
    c.check("(r picks) pick all: every variant at every point (2 × 3 layers, named point.variant)", every.length === 6 && every.every((l) => /\d\.\d$/.test(l.name)), every.map((l) => l.name));
  }
  {
    const b = await build("r-keyed");
    const copies = copiesIn(b, "Keyed modulation", "copy");
    const sk = copies.map((l) => (l.transform.scale as any).keys?.length);
    const rk = copies.map((l) => (l.transform.rotation as any).keys?.length);
    c.check("(r keyed) keyed scale × / rotate + → each copy's Scale and Rotation keyed from the tracks (2 keys each, not per frame)", sk.every((n) => n === 2) && rk.every((n) => n === 2), { sk, rk });
    const e = (copies[0].transform.scale as any).keys[0].easeOut;
    c.check("(r keyed) the easeOutBack ease rides every copy (per-dimension, speed scaled by the point's scale)", e?.length === 2 && e[0].influence > 33 && e[0].influence < 34 && Math.abs(e[0].speed - e[1].speed) < 1e-9, e);
    c.check("(r keyed) the rotate + track is reported (best-fit easing)", b.scene.report.approx.some((l) => l.id === "copy" && /rotate_add_default/.test(l.note ?? "")), b.scene.report.approx.find((l) => l.id === "copy"));
  }
  {
    const b = await build("r-stagger");
    const st = copiesIn(b, "Staggered", "copy");
    const kn = st.map((l) => (l.transform.scale as any).keys?.length ?? 0);
    c.check("(r stagger) Stagger phases → per-copy Scale / Rotation keys, linear stretches merged (≤ 4 keys a copy, not 60)", st.length === 6 && kn.every((n) => n >= 2 && n <= 4), kn);
    // A copy starts at its last zero-scale key.
    const starts = st.map((l) => Math.max(...(l.transform.scale as any).keys.filter((k: any) => k.v[0] === 0).map((k: any) => k.t))).sort((x, y) => x - y);
    c.check("(r stagger) each copy starts 5 frames after the previous", starts.every((t, i) => i === 0 || Math.abs(t - starts[i - 1] - 5 / 30) < 1e-9), starts);
    c.check("(r stagger) the report says the copies are keyed every frame", [...b.scene.report.native, ...b.scene.report.approx].some((l) => l.id === "copy" && /per-copy transforms every frame/.test(l.note ?? "")));
  }
  {
    const b = await build("r-switch");
    const sw = copiesIn(b, "Switching", "copy");
    const ops = sw.map((l) => l.transform.opacity as any);
    c.check("(r switch) a pick that changes over time → a layer per variant a point uses (4 × 2), HOLD opacity keys", sw.length === 8 && ops.every((o) => o.keys?.every((k: any) => k.inInterp === "hold" && k.outInterp === "hold")), ops.map((o) => o.keys?.length));
  }
  {
    const b = await build("r-ramp");
    const reps = (layer: string) => flatItems(all(b).find((l) => l.name === layer)?.contents).filter((i) => i.kind === "repeater") as any[];
    const row = reps("Ramp row");
    const t = (r: any) => [r.composite, Math.round(r.transform.startOpacity.v * 1e4) / 1e4, Math.round(r.transform.endOpacity.v * 1e4) / 1e4, Math.round(r.transform.position.v[0] * 1e3) / 1e3, Math.round(r.transform.position.v[1] * 1e3) / 1e3].join();
    // AE: copy i of n = Start + (End − Start)·i/n. 0.2 … 1 over 5 copies runs
    // backwards from the last copy: Start 100, End 0 → 100, 80, 60, 40, 20.
    c.check("(r ramp) opacity linear along the row → ONE shape layer, a Repeater from the last copy back (Composite Below, Start 100 → End 0)", all(b).length === 2 && row.length === 1 && row[0].copies.v === 5 && t(row[0]) === "below,100,0,-192,0", row.map(t));
    const rowInst = flatItems(all(b).find((l) => l.name === "Ramp row")?.contents).find((i) => i.kind === "group" && /instance/.test(i.name ?? "")) as any;
    c.check("(r ramp) …the instance placed at the last copy", Math.abs(rowInst?.transform?.position?.v?.[0] - 384) < 1e-3, rowInst?.transform);
    const grid = reps("Ramp grid");
    const bad = structuredClone(b.scene);
    const rr = flatItems(bad.comps.flatMap((x) => x.layers).find((l) => l.name === "Ramp row")?.contents).find((i) => i.kind === "repeater") as any;
    rr.transform.endOpacity = { v: 140 };
    c.check("(r ramp) the validator refuses a Repeater opacity outside 0–100 (AE does: \"Value 140 out of range 0 to 100\")", validateAeScene(bad).some((x) => /endOpacity.*outside AE's 0–100/.test(x)), validateAeScene(bad));
    c.check("(r ramp) a separable ramp (0.4 + 0.3·col)(0.5 + 0.25·row) → columns 100 → 10 %, rows 100 → 25 %, both from the last copy", grid.length === 2 && t(grid[0]) === "below,100,10,-192,0" && t(grid[1]) === "below,100,25,0,-192", grid.map(t));
  }
  {
    const f = ref.fixtureNamed("r-array");
    const b = await build("r-array");
    const { nodes, edges } = await buildFixture(f);
    const g = makeAeGraph(nodes, edges, undefined, { width: f.comp.width, height: f.comp.height }, f.comp.fps);
    const W = f.comp.width;
    const H = f.comp.height;
    const px = (p: number[]): V2 => [p[0] * W, H / 2 + (p[1] - 0.5) * W];
    const means = (ep: string): V2[] =>
      ((g.valueAt(ep, 0) as any)?.subpaths ?? []).map((s: any) => px([s.anchors.reduce((a: number, x: any) => a + x.pos[0], 0) / s.anchors.length, s.anchors.reduce((a: number, x: any) => a + x.pos[1], 0) / s.anchors.length]));
    const layerOf = (name: string) => all(b).find((l) => l.name === name)!;
    const arr = layerOf("Spline array");
    const ar = flatItems(arr.contents).filter((i) => i.kind === "repeater") as any[];
    c.check("(r array) Array, spline mode → two Repeaters (4 columns of 0.12·W, 2 rows of 0.12·W) on the fill's shape layer", ar.length === 2 && ar[0].copies.v === 4 && Math.abs(ar[0].transform.position.v[0] - 0.12 * W) < 1e-9 && ar[1].copies.v === 2 && Math.abs(ar[1].transform.position.v[1] - 0.12 * W) < 1e-9, ar.map((r) => [r.copies, r.transform.position]));
    const inst = flatItems(arr.contents).find((i) => i.kind === "group" && /instance/.test(i.name ?? "")) as any;
    c.check("(r array) the copy rotate / scale is the instance group's transform (20°, 80 %) about the canvas centre", inst?.transform?.rotation?.v === 20 && inst.transform.scale.v.join() === "80,80" && inst.transform.anchor.v.join() === `${W / 2},${H / 2}`, inst?.transform);
    const d1 = worstPair(copyCenters(arr.contents!, centerOf), means("arr:out"));
    c.near("(r array) every star lands where toolbox's array puts it (px)", d1, 0, 1e-6);
    const pa = layerOf("Point array");
    const pr = flatItems(pa.contents).filter((i) => i.kind === "repeater") as any[];
    c.check("(r array) Array, point mode → Copy to Points sees a 3×2 lattice → two Repeaters on the box", pr.length === 2 && pr[0].copies.v === 3 && pr[1].copies.v === 2 && pa.kind === "shape", pr.map((r) => r.copies));
    const pts = g.valueAt("arr2:out", 0) as any;
    const want: V2[] = Array.from({ length: pts.count }, (_, i) => px([pts.positions[i * 2], pts.positions[i * 2 + 1]]));
    c.near("(r array) every box centre on its array point (px)", worstPair(copyCenters(pa.contents!, centerOf), want), 0, 1e-3);
    const pg = flatItems(pa.contents).find((i) => i.kind === "group" && /instance/.test(i.name ?? "")) as any;
    c.check("(r array) …rotated 30°, scaled 80 % (the array's per-copy TRS on the points)", Math.abs(pg?.transform?.rotation?.v - 30) < 1e-4 && pg.transform.scale.v.every((s: number) => Math.abs(s - 80) < 1e-4), pg?.transform);
    const rl = layerOf("Rotated lattice");
    const rr = flatItems(rl.contents).filter((i) => i.kind === "repeater") as any[];
    c.check("(r array) a rotated lattice from a Point Expression → Repeaters along its tilted steps (spline mode)", rr.length === 2 && rr[0].copies.v === 4 && rr[1].copies.v === 3 && Math.abs(Math.atan2(rr[0].transform.position.v[1], rr[0].transform.position.v[0]) - 0.4) < 1e-4, rr.map((r) => r.transform.position));
    c.near("(r array) every triangle where toolbox's copies put it (px)", worstPair(copyCenters(rl.contents!, centerOf), means("copies:out")), 0, 1e-3);
  }
  {
    const none = await build("r-field", { fieldPixels: undefined });
    c.check("(r field) without the editor's readback both layers' copies bake, saying why", none.bakes.length === 2 && none.bakes.every((x) => /readback/.test(x.reason ?? "")), none.bakes.map((x) => x.reason));
    const b = await build("r-field");
    c.check("(r field) sampled fields are reported approx (8-bit readback)", b.scene.report.approx.some((l) => l.id === "copy" && /scale_field sampled/.test(l.note ?? "") && /rotate_field sampled/.test(l.note ?? "")));
    // Spline mode: each triangle's width = base × (0.5 + 1.5 · the nearest
    // ≤ 256 px luminance texel under its point).
    const tris = flatItems(all(b).find((l) => l.name === "Field paths")?.contents).filter((i) => i.kind === "path") as any[];
    const widths = tris.map((t) => Math.max(...t.path.v.vertices.map((v: number[]) => v[0])) - Math.min(...t.path.v.vertices.map((v: number[]) => v[0])));
    const f = ref.fixtureNamed("r-field");
    const W = f.comp.width;
    const base = 0.025 * Math.sqrt(3) * W;
    const want = Array.from({ length: 6 }, (_, i) => {
      const x = 0.1 + (0.8 * i) / 5;
      const tex = Math.min(255, Math.floor(x * 256));
      const v = Math.round((255 * (tex + 0.5)) / 256) / 255;
      return base * (0.5 + 1.5 * v);
    });
    c.check("(r field, spline mode) the node's own sampler on the readback → static paths, each copy sized by its texel", tris.length === 6 && widths.every((w, i) => Math.abs(w - want[i]) < 1e-3), { widths, want });
  }

  // --- what still bakes --------------------------------------------------------------------
  const adhoc = (name: string, fn: (g: any) => void, opts: Record<string, unknown> = {}) => sceneOf({ name, title: name, comp: { width: 1280, height: 720, fps: 30, frames: 30 }, build: fn, opts } as any);
  const base = (g: any, extra: (L: string) => string, params: Record<string, unknown> = {}) => {
    const L = g.layer("LX", "X");
    g.node(L, "dot", "circle", { radiusX: 0.02, radiusY: 0.02, stroke_enabled: false, fill_enabled: true });
    const src = extra(L);
    g.node(L, "copy", "copy-to-points", { mode: "image", ...params });
    g.wire(src, "copy:in:points");
    g.wire("dot:aux:image", "copy:in:instance");
    g.out(L, "copy:out");
  };
  const swapY = await adhoc("swap", (g) =>
    base(
      g,
      (L) => {
        g.node(L, "row", "grid", { countX: 2, countY: 1, width: 0.4, height: 0 });
        g.node(L, "sw", "point-expression", { expression: "y = py + (index === 0 ? 1 : -1) * 0.1 * Math.sin(t * 3);" });
        g.wire("row:out", "sw:in:points");
        return "sw:out";
      },
      { draw_order: "by y" }
    )
  );
  c.check("(r bakes) draw_order by y whose order changes over time → bake (AE can't reorder layers)", swapY.bakes.length === 1 && /reorders the copies/.test(swapY.bakes[0].reason ?? ""), swapY.bakes.map((x) => x.reason));
  const grow = await adhoc("grow", (g) =>
    base(g, (L) => {
      g.node(L, "few", "scatter-points", { seed: 2 }, { count: track([[0, 3, "linear"], [20, 9, "linear"]]) });
      return "few:out";
    })
  );
  c.check("(r bakes) a point count that changes over time → bake", grow.bakes.length === 1 && /point count changes/.test(grow.bakes[0].reason ?? ""), grow.bakes.map((x) => x.reason));
  const anim = await adhoc(
    "animfield",
    (g) => {
      base(g, (L) => {
        g.node(L, "pts", "grid", { countX: 3, countY: 1 });
        g.node(L, "n", "gradient", { mode: "linear" }, { start_x: track([[0, 0, "linear"], [20, 0.5, "linear"]]) });
        return "pts:out";
      });
      g.wire("n:out", "copy:in:scale_field");
    },
    { fieldPixels: () => new Uint8Array(1280 * 720 * 4) }
  );
  c.check("(r bakes) an animated image field → bake", anim.bakes.length === 1 && /animated image field/.test(anim.bakes[0].reason ?? ""), anim.bakes.map((x) => x.reason));
  const dens = await adhoc("density", (g) =>
    base(g, (L) => {
      g.node(L, "img", "gradient", { mode: "linear" });
      g.node(L, "sc", "scatter-points", { count: 10 });
      g.wire("img:out", "sc:in:density");
      return "sc:out";
    })
  );
  c.check("(r bakes) points scattered by a density image → bake (the walk has no pixels for it), naming the node", dens.bakes.length === 1 && /the points read an image at .*\(sc\) density/.test(dens.bakes[0].reason ?? ""), dens.bakes.map((x) => x.reason));
  const over = await adhoc(
    "overtint",
    (g) =>
      base(
        g,
        (L) => {
          g.node(L, "many", "scatter-points", { count: 40 });
          g.node(L, "hue", "set-named-attribute", { attr_name: "tint", kind: "color", source: "random" });
          g.wire("many:out", "hue:in:points");
          return "hue:out";
        },
        { tint_attr: "tint" }
      ),
    { policy: { layerBudget: 20 } }
  );
  c.check("(r budget) tinted copies over the budget → bake", over.bakes.length === 1 && /layer budget/.test(over.bakes[0].reason ?? ""), over.bakes.map((x) => x.reason));
  const kept = await sceneOf({ name: "overtint2", title: "overtint2", comp: { width: 1280, height: 720, fps: 30, frames: 30 }, build: (g: any) => base(g, (L) => {
    g.node(L, "many", "scatter-points", { count: 40 });
    g.node(L, "hue", "set-named-attribute", { attr_name: "tint", kind: "color", source: "random" });
    g.wire("many:out", "hue:in:points");
    return "hue:out";
  }, { tint_attr: "tint" }), opts: { policy: { layerBudget: 20 }, overrides: { copy: "procedural" } } } as any);
  const kl = (ref.layerComp(kept.scene, "X")?.layers ?? []).filter((l: AeLayer) => l.origin?.includes("copy") && l.kind === "precomp");
  c.check("(r budget, keep procedural) the 40 tinted copies explode anyway, with a warning", kept.bakes.length === 0 && kl.length === 40 && kept.warnings.some((w) => /past the 20-layer budget/.test(w)), [kept.bakes.length, kl.length]);

  // --- the lattice and ramp detectors ----------------------------------------------------
  const pos = (xs: V2[]) => xs.flat();
  c.check("(lattice) row-major 3×2 → fast 3, slow 2", JSON.stringify(latticeOf(pos([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]), 6)) === JSON.stringify({ k: 1, fast: 3, slow: 2, d1: [1, 0], d2: [0, 1] }));
  c.check("(lattice) column-major → fast along y", latticeOf(pos([[0, 0], [0, 1], [1, 0], [1, 1]]), 4)?.d1.join() === "0,1");
  c.check("(lattice) a jittered point → no lattice", latticeOf(pos([[0, 0], [1, 0], [2.001, 0]]), 3) === null);
  c.check("(lattice) a 2-point pattern repeated per cell (k = 2)", latticeOf(pos([[0, 0], [0.1, 0.2], [1, 0], [1.1, 0.2]]), 4, 2)?.fast === 2);
  const L = latticeOf(pos([[0, 0], [1, 0], [2, 0]]), 3)!;
  const r1 = opacityRamp([0.5, 0.75, 1], L);
  c.check("(ramp) 0.5 → 1 over 3 copies → backwards: Start 100, End 25 (100, 75, 50 by AE's i/n)", r1?.inner?.reversed === true && Math.abs(r1.inner.start - 1) < 1e-9 && Math.abs(r1.inner.end - 0.25) < 1e-9 && r1.group === 1, r1);
  const r2 = opacityRamp([1, 0.75, 0.5], L);
  c.check("(ramp) 1 → 0.5 forwards: Start 100, End 25", r2?.inner?.reversed === false && Math.abs(r2.inner!.end - 0.25) < 1e-9, r2);
  const r3 = opacityRamp([0.25, 0.375, 0.5], L);
  c.check("(ramp) a ramp peaking below 1 → the group opacity carries the peak (50 %)", Math.abs((r3?.group ?? 0) - 0.5) < 1e-9 && r3?.inner?.start === 1, r3);
  c.check("(ramp) 0.2 → 1 over 3 copies needs End 140 % or Start < 0 → none", opacityRamp([0.2, 0.6, 1], L) === null);
  c.check("(ramp) not linear → none", opacityRamp([0.2, 0.9, 1], L) === null);
  const L2 = latticeOf(pos([[0, 0], [1, 0], [0, 1], [1, 1]]), 4)!;
  c.check("(ramp) a sum, not a product, of the indices → none (Repeater opacities multiply)", opacityRamp([0.2, 0.4, 0.4, 0.6], L2) === null);
}
