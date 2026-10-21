// Hard SDF chains → shape layers (M4 lane 4, specdocs/ae-m4/sdf.md):
//
//   1. sdfChainVerdict (src/lib/ae-export/sdf-chain.ts) on small trees: what
//      is native, and the node + reason for what is not.
//   2. planAeExport on the `s-` fixtures: a hard chain is vector (one
//      segment, consumer approx, tree exact); a smooth one stays a shader
//      region and says why; a soft chain under sdf-to-spline bakes.
//   3. The scene walk's facts on the `s-` fixtures: Merge Paths order, the
//      offsets on the leaves, group transforms (Y-up → −degrees), mirror
//      halves, Repeaters, exact keys, the contour as geometry and as a matte.
//   4. The editor's plan_glsl_translation handler, end to end on a real
//      graph: an sdf-rasterize fed by an sdf-circle fuses as one region (the
//      table gap that used to cut it out).
//
//   npx tsx scripts/check-ae-export.mts sdf

/* eslint-disable @typescript-eslint/no-explicit-any */

import { makeChecker, loadRegistry } from "./harness.mts";
import type { AeComp, AeLayer, AeShapeItem } from "@/lib/ae-export/types";
import type { AeSceneBuild } from "@/lib/ae-export/scene";
import type { SdfChainGraph } from "@/lib/ae-export/sdf-chain";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

export default async function run(): Promise<number> {
  const c = makeChecker("sdf");
  await loadRegistry();
  const { sdfChainVerdict } = await import("@/lib/ae-export/sdf-chain");
  const { getNodeDef } = await import("@/engine/registry");

  // ---- 1. verdicts ------------------------------------------------------------------
  {
    type N = { type: string; params?: Record<string, unknown>; animated?: string[] };
    const graph = (nodes: Record<string, N>, wires: [string, string][]): SdfChainGraph => {
      const into = new Map<string, { id: string; handle: string }>();
      for (const [from, to] of wires) {
        const [fid, ...fh] = from.split(":");
        into.set(to, { id: fid, handle: fh.join(":") || "out" });
      }
      return {
        type: (id) => nodes[id]?.type,
        values: (id) => {
          const def = getNodeDef(nodes[id]?.type ?? "");
          const d: Record<string, unknown> = {};
          for (const p of def?.params ?? []) d[p.name] = p.default;
          return { ...d, ...(nodes[id]?.params ?? {}) };
        },
        input: (id, socket) => into.get(`${id}:${socket}`),
        animated: (id) => new Set(nodes[id]?.animated ?? []),
      };
    };
    const v = (nodes: Record<string, N>, wires: [string, string][], consumer = "ras") => sdfChainVerdict(consumer, graph(nodes, wires));
    const ras: N = { type: "sdf-rasterize" };
    const basic = v({ c: { type: "sdf-circle" }, ras }, [["c", "ras:sdf"]]);
    c.check("(1) circle → rasterize is native, fill = the foreground", basic.native && basic.nodes.join() === "c" && (basic as any).fill?.param === "foreground", basic);
    const smooth = v({ a: { type: "sdf-circle" }, b: { type: "sdf-rectangle" }, s: { type: "sdf-smooth-union" }, ras }, [["a", "s:a"], ["b", "s:b"], ["s", "ras:sdf"]]);
    c.check("(1) a smooth union refuses at the smooth union, with the reason", !smooth.native && smooth.node === "s" && /smooth blend/.test(smooth.reason), smooth);
    const hardSmooth = v({ a: { type: "sdf-circle" }, b: { type: "sdf-rectangle" }, s: { type: "sdf-smooth-union", params: { smoothness: 0 } }, ras }, [["a", "s:a"], ["b", "s:b"], ["s", "ras:sdf"]]);
    c.check("(1) …at smoothness 0 it is the hard union (native, noted)", hardSmooth.native && (hardSmooth as any).notes.some((x: string) => /smoothness ≤ 0/.test(x)), hardSmooth);
    const field = v({ n: { type: "noise" }, p: { type: "sdf-polygon" }, ras }, [["n:aux:field", "p:sides_field"], ["p", "ras:sdf"]]);
    c.check("(1) a polygon with a sides field refuses (per-pixel)", !field.native && field.node === "p" && /sides field/.test(field.reason), field);
    const frac = v({ p: { type: "sdf-polygon", params: { sides: 5.5 } }, ras }, [["p", "ras:sdf"]]);
    c.check("(1) a fractional side count refuses", !frac.native && /fractional side/.test(frac.reason), frac);
    const keyedSides = v({ p: { type: "sdf-star", animated: ["points"] }, ras }, [["p", "ras:sdf"]]);
    c.check("(1) keyed star points refuse (structure)", !keyedSides.native && /points is animated/.test(keyedSides.reason), keyedSides);
    const jitter = v({ r: { type: "sdf-repeat", params: { rotation_jitter: 0.2 } }, c: { type: "sdf-circle" }, ras }, [["r", "c:position"], ["c", "ras:sdf"]]);
    c.check("(1) repeat jitter refuses at the repeat", !jitter.native && jitter.node === "r" && /rotation_jitter/.test(jitter.reason), jitter);
    const lim = v({ r: { type: "sdf-repeat", params: { bounded: true, limit_x: 2.5 } }, c: { type: "sdf-circle" }, ras }, [["r", "c:position"], ["c", "ras:sdf"]]);
    c.check("(1) fractional repeat limits refuse", !lim.native && /fractional repeat limits/.test(lim.reason), lim);
    const twist = v({ t: { type: "sdf-twist" }, m: { type: "sdf-translate" }, c: { type: "sdf-circle" }, ras }, [["t", "m:position"], ["m", "c:position"], ["c", "ras:sdf"]]);
    c.check("(1) a twist anywhere in the position chain refuses at the twist", !twist.native && twist.node === "t", twist);
    const angle = v({ n: { type: "noise" }, r: { type: "sdf-rotate" }, c: { type: "sdf-rectangle" }, ras }, [["n:aux:field", "r:angle_field"], ["r", "c:position"], ["c", "ras:sdf"]]);
    c.check("(1) a per-pixel rotation field refuses at the rotate", !angle.native && angle.node === "r" && /angle field/.test(angle.reason), angle);
    const cell = v({ r: { type: "sdf-repeat" }, c: { type: "sdf-circle" }, ras }, [["r:aux:cell_id", "c:position"], ["c", "ras:sdf"]]);
    c.check("(1) a repeat's cell_id as a position refuses", !cell.native && /per-cell id/.test(cell.reason), cell);
    const two = { a: { type: "sdf-circle", params: { paint: true, color: "#ff0000" } }, b: { type: "sdf-circle", params: { paint: true, color: "#0000ff" } }, u: { type: "sdf-union" } } as Record<string, N>;
    const twoW: [string, string][] = [["a", "u:a"], ["b", "u:b"], ["u", "ras:sdf"]];
    const colors = v({ ...two, ras }, twoW);
    c.check("(1) per-shape colours under a rasterize refuse (nearest-surface colour)", !colors.native && /different colours/.test(colors.reason), colors);
    const maskColors = v({ ...two, mask: { type: "sdf-to-mask" } }, [["a", "u:a"], ["b", "u:b"], ["u", "mask:sdf"]], "mask");
    c.check("(1) …but sdf-to-mask ignores materials (distance only)", maskColors.native, maskColors);
    const one = v({ m: { type: "sdf-material", params: { color: "#00ff00" } }, a: { type: "sdf-circle" }, b: { type: "sdf-rectangle" }, u: { type: "sdf-union" }, ras }, [["a", "u:a"], ["b", "u:b"], ["u", "m:sdf"], ["m", "ras:sdf"]]);
    c.check("(1) one material painting everything is the fill colour", one.native && (one as any).fill?.node === "m", one);
    const spline = v({ s: { type: "sdf-spline" }, ras }, [["s", "ras:sdf"]]);
    c.check("(1) sdf-spline refuses (a per-eval distance texture)", !spline.native && spline.node === "s" && /spline texture/.test(spline.reason), spline);
    const shade = v({ c: { type: "sdf-circle" }, sh: { type: "sdf-shade" } }, [["c", "sh:sdf"]], "sh");
    c.check("(1) a shading consumer refuses (it shades the field)", !shade.native && shade.node === "sh", shade);
    const empty = v({ ras }, []);
    c.check("(1) an unwired consumer is native and empty", empty.native && empty.nodes.length === 0, empty);
  }

  const { SCENE_FIXTURES, sceneOf } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  const build = async (name: string) => {
    const f = SCENE_FIXTURES.find((x) => x.name === name);
    if (!f) throw new Error(`no fixture ${name}`);
    return sceneOf(f);
  };
  const mainOf = (b: AeSceneBuild): AeComp => b.scene.comps.find((x) => x.id === b.scene.main)!;
  const allLayers = (b: AeSceneBuild): AeLayer[] => b.scene.comps.flatMap((x) => x.layers);
  const items = (xs: AeShapeItem[] | undefined, out: AeShapeItem[] = []): AeShapeItem[] => {
    for (const it of xs ?? []) {
      out.push(it);
      if (it.kind === "group") items(it.contents, out);
    }
    return out;
  };
  // Every shape item of the scene (the consumer may be a blurred fill layer
  // over a background layer, precomposed).
  const everything = (b: AeSceneBuild) => allLayers(b).flatMap((l) => items(l.contents));
  const group = (b: AeSceneBuild, _layerId: string, name: string) => everything(b).find((i) => i.kind === "group" && i.name === name) as Extract<AeShapeItem, { kind: "group" }> | undefined;
  const planNode = (b: AeSceneBuild, id: string) => b.plan.layers.flatMap((l) => l.nodes).find((n) => n.id === id);

  // ---- 2. the plan ---------------------------------------------------------------------
  {
    const b = await build("s-boolean");
    const L = b.plan.layers[0];
    const ras = planNode(b, "ras")!;
    c.check("(2) s-boolean: the rasterize is vector / approx (its edges), route direct", ras.class === "vector" && ras.fidelity === "approx" && b.plan.route === "direct", [ras, b.plan.route]);
    c.check("(2) …every tree node is vector / exact", ["disc", "slab", "hex", "both", "cut"].every((x) => planNode(b, x)?.class === "vector" && planNode(b, x)?.fidelity === "exact"), L.nodes.map((n) => [n.id, n.class, n.fidelity]));
    c.check("(2) …and the whole chain is ONE vector segment (one shape layer)", L.segments.length === 1 && L.segments[0].kind === "vector" && L.segments[0].nodes.length === 6 && L.segments[0].output === "ras:out", L.segments);
    c.check("(2) …the tree nodes name their AE objects", planNode(b, "disc")?.ae === "shape:ellipse" && planNode(b, "hex")?.ae === "shape:polystar" && planNode(b, "cut")?.ae === "shape:merge", L.nodes.map((n) => [n.id, n.ae]));
    const sh = await build("s-shader");
    const r = planNode(sh, "ras")!;
    c.check("(2) s-shader: a smooth union keeps the shader route, and the rasterize says why", r.class === "shader" && r.notes.some((n) => /SDF chain stays a shader region — sdf-smooth-union \(blend\): a smooth blend/.test(n)), r);
    const region = sh.plan.shaderRegions.find((x) => x.target === "ras:out");
    c.check("(2) …one shader region holds the whole tree (the GLSL table lists the tree nodes)", !!region && ["l", "r", "blend", "ras"].every((x) => region.nodes.includes(x)), sh.plan.shaderRegions);
    const tw = await build("s-twist");
    const tr = planNode(tw, "trace")!;
    c.check("(2) s-twist: sdf-to-spline on a twisted chain bakes, naming the twist", tr.class === "bake" && tr.notes.some((n) => /sdf-twist \(tw\): twist bends/.test(n)), tr);
    const ct = await build("s-contour");
    c.check("(2) s-contour: the traced contour feeding a matte is a mask whose note names the ALPHA matte", planNode(ct, "trace2")?.class === "mask" && /ALPHA track matte/.test(planNode(ct, "trace2")?.notes.join(" ") ?? ""), planNode(ct, "trace2"));
  }

  // ---- 3. scene facts -------------------------------------------------------------------
  {
    const b = await build("s-boolean");
    const m = mainOf(b);
    c.check("(3) s-boolean: one shape layer (softness 1 px: AE's own anti-aliasing, no blur), no problems", m.layers.length === 1 && m.layers[0].kind === "shape" && !m.layers[0].effects?.length && !b.problems.length, [m.layers.map((l) => l.kind), b.problems]);
    const { sdfEdgeBlurriness } = await import("@/lib/ae-export/scene/sdf");
    c.check("(3) edge blur: none below 1.5 px; √(soft²/5 − 1/12) / 0.2858 from there", sdfEdgeBlurriness(1) === 0 && sdfEdgeBlurriness(1.4) === 0 && near(sdfEdgeBlurriness(2), Math.sqrt(4 / 5 - 1 / 12) / 0.2858, 1e-12) && near(sdfEdgeBlurriness(4), 6.17708, 1e-4), [sdfEdgeBlurriness(2), sdfEdgeBlurriness(4)]);
    const cut = group(b, m.layers[0].id, "SDF Subtraction")!;
    const kinds = cut?.contents.map((i) => (i.kind === "merge" ? `merge:${i.mode}` : i.kind === "group" ? `group:${i.name}` : i.kind));
    c.check("(3) …Subtract: the minuend group first, the hexagon second, then Merge Paths Subtract", JSON.stringify(kinds) === JSON.stringify(["group:SDF Union", "polystar", "merge:subtract"]), kinds);
    const uni = group(b, m.layers[0].id, "SDF Union")!;
    c.check("(3) …the union is Ellipse + Rect + Merge Paths Add", uni.contents.map((i) => (i.kind === "merge" ? i.mode : i.kind)).join() === "ellipse,rect,add", uni.contents.map((i) => i.kind));
    const ell = uni.contents[0] as any;
    c.check("(3) …the disc: size 320 px at (520, 360) — Y-up SDF space mapped back to pixels", near(ell.size.v[0], 320) && near(ell.position.v[0], 520) && near(ell.position.v[1], 360), ell);
    const rect = uni.contents[1] as any;
    c.check("(3) …the slab: 360×200 px, Roundness 40", near(rect.size.v[0], 360) && near(rect.size.v[1], 200) && near(rect.roundness.v, 40), rect);
    const hex = cut.contents[1] as any;
    c.check("(3) …the hexagon: Polystar polygon, 6 points, outer radius 90, rotation 0 (first vertex up, as polySdf)", hex.type === "polygon" && hex.points.v === 6 && near(hex.outerRadius.v, 90) && hex.rotation.v === 0, hex);
    const all = everything(b);
    const stroke = all.find((i) => i.kind === "stroke") as any;
    c.check("(3) …contour → a red Stroke 2·3 = 6 px wide", stroke && near(stroke.width.v, 6) && JSON.stringify(stroke.color.v) === "[1,0,0]", stroke);
    const fills = all.filter((i) => i.kind === "fill") as any[];
    c.check("(3) …Fill = foreground #ffcc00, the background a comp-sized Rect filled #101820", fills.length === 2 && near(fills[0].color.v[1], 0.8) && near(fills[1].color.v[2], 32 / 255) && all.some((i) => i.kind === "rect" && (i as any).name === "frame" && (i as any).size.v[0] === 1280), fills);
  }
  {
    const b = await build("s-soft");
    const m = mainOf(b);
    const shapes = allLayers(b).filter((l) => l.kind === "shape");
    c.check("(3) s-soft: softness 3 px → the blurred fill layer over its own background layer, one precomp in the main comp", m.layers.length === 1 && m.layers[0].kind === "precomp" && shapes.map((l) => l.name).join() === "SDF Rasterize,SDF Rasterize background", [m.layers.map((l) => l.kind), shapes.map((l) => l.name)]);
    const blur = shapes[0].effects?.[0] as any;
    c.check("(3) …Gaussian Blur 2 on the fill: Blurriness √(9/5 − 1/12) / 0.2858, both dimensions, Repeat Edge Pixels off", blur?.match === "ADBE Gaussian Blur 2" && near(blur.props["ADBE Gaussian Blur 2-0001"].v, Math.sqrt(9 / 5 - 1 / 12) / 0.2858, 1e-9) && blur.props["ADBE Gaussian Blur 2-0002"].v === 1 && blur.props["ADBE Gaussian Blur 2-0003"].v === 0, blur);
    c.check("(3) …the background layer has no effects", !shapes[1].effects?.length);
  }
  {
    const b = await build("s-offsets");
    const L = mainOf(b).layers[0];
    const all = everything(b);
    const star = group(b, L.id, "SDF Star offset")!;
    c.check("(3) s-offsets: round(star) → Polystar star + Offset Paths 16 px, Round join", star.contents[0].kind === "polystar" && (star.contents[1] as any).kind === "offset" && near((star.contents[1] as any).amount.v, 16) && (star.contents[1] as any).join === "round", star);
    const st = star.contents[0] as any;
    // starSdf's inner vertex: r·sin(π/m − π/n)/sin(π/m), m = 2.5, n = 5.
    c.check("(3) …the star's inner radius = r·sin(π/2.5 − π/5)/sin(π/2.5)", near(st.innerRadius.v, (150 * Math.sin(Math.PI / 2.5 - Math.PI / 5)) / Math.sin(Math.PI / 2.5), 1e-6) && near(st.outerRadius.v, 150), st);
    const ring = group(b, L.id, "SDF Onion")!;
    const ringSizes = ring?.contents.filter((i) => i.kind === "ellipse").map((i: any) => i.size.v[0]);
    c.check("(3) …onion(circle) → the circle grown 20 px minus the circle shrunk 20 px (Subtract)", JSON.stringify(ringSizes) === "[260,180]" && (ring.contents[2] as any).mode === "subtract", ring?.contents);
    const seg = group(b, L.id, "SDF Line Segment segment")!;
    const cap = seg?.contents[0] as any;
    const lenPx = Math.hypot(200, 320);
    c.check("(3) …the line segment → a capsule Rect |b − a| + 2·28 long, Roundness 28, turned atan2(320, 200)", near(cap.size.v[0], lenPx + 56, 1e-6) && near(cap.size.v[1], 56) && near(cap.roundness.v, 28) && near((seg.transform!.rotation as any).v, (Math.atan2(320, 200) * 180) / Math.PI, 1e-9), seg);
    const tri = group(b, L.id, "SDF Triangle offset")!;
    c.check("(3) …round(triangle) → a Path + Offset Paths 12 px", tri?.contents[0].kind === "path" && near((tri.contents[1] as any).amount.v, 12), tri);
    const fills = all.filter((i) => i.kind === "fill") as any[];
    c.check("(3) …to-mask → white shapes over a black comp Rect", JSON.stringify(fills.map((f) => f.color.v)) === "[[1,1,1],[0,0,0]]", fills);
  }
  {
    const b = await build("s-erode");
    const all = everything(b);
    const hex = all.find((i) => i.kind === "polystar" && (i as any).type === "polygon") as any;
    c.check("(3) s-erode: round(+20) on a hexagon → a bigger sharp Polystar, outer radius 110 + 20/cos 30°", hex && near(hex.outerRadius.v, 110 + 20 / Math.cos(Math.PI / 6), 1e-9) && hex.outerRoundness.v === 0, hex);
    const star = group(b, "", "SDF Star offset") as any;
    c.check("(3) …round(−14) on a star → Offset Paths −14 px, Round join (rounds the inner corners)", star && near(star.contents[1].amount.v, -14) && star.contents[1].join === "round", star);
    const tri = group(b, "", "SDF Triangle offset") as any;
    c.check("(3) …round(−12) on a triangle → Offset Paths −12 px", tri && near(tri.contents[1].amount.v, -12), tri);
    const box = all.find((i) => i.kind === "rect" && (i as any).name === "SDF Rectangle") as any;
    c.check("(3) …round(−20) on a 12-px-rounded box → 160 × 220, Roundness max(12 − 20, 0) = 0", box && near(box.size.v[0], 160) && near(box.size.v[1], 220) && near(box.roundness.v, 0), box);
  }
  {
    const b = await build("s-chain");
    const L = mainOf(b).layers[0];
    const turn = group(b, L.id, "SDF Rotate")!;
    c.check("(3) s-chain: rotate 30° → group Rotation −30 about the pivot (SDF space is Y-up)", (turn.transform!.rotation as any).v === -30 && JSON.stringify((turn.transform!.anchor as any).v) === "[300,360]" && JSON.stringify((turn.transform!.position as any).v) === "[300,360]", turn.transform);
    const sq = group(b, L.id, "SDF Scale")!;
    c.check("(3) …scale (1.6, 0.6) → group Scale [160, 60] about (700, 360)", near((sq.transform!.scale as any).v[0], 160) && near((sq.transform!.scale as any).v[1], 60) && JSON.stringify((sq.transform!.anchor as any).v) === "[700,360]", sq.transform);
    const sh = group(b, L.id, "SDF Translate")!;
    c.check("(3) …translate (0.09375, −0.1171875) → group Position [120, 150] px (y flips)", near((sh.transform!.position as any).v[0], 120) && near((sh.transform!.position as any).v[1], 150), sh.transform);
  }
  {
    const b = await build("s-folds");
    const mir = everything(b).find((i) => i.kind === "group" && i.name === "SDF Mirror" && i.contents.some((x) => x.kind === "merge")) as any;
    const flip = mir?.contents.find((x: any) => x.kind === "group" && /reflection/.test(x.name));
    c.check("(3) s-folds: mirror → the kept half + its reflection (Scale −100 about the center), Merge Add", !!flip && JSON.stringify(flip.transform.scale.v) === "[-100,100]" && JSON.stringify(flip.transform.anchor.v) === "[240,360]" && mir.contents.at(-1).mode === "add", mir);
    const half = mir?.contents[0];
    c.check("(3) …the disc crosses the line: its kept half is an Intersect with the half-plane", half?.kind === "group" && /clip/.test(half.name) && half.contents.at(-1).mode === "intersect", half);
    const reps = everything(b).filter((i) => i.kind === "repeater") as any[];
    const rx = reps.find((r) => r.name === "SDF Repeat x");
    c.check("(3) …bounded repeat (limit 1, 0): one Repeater, 3 copies from −1, 120 px apart, no y Repeater", rx && rx.copies.v === 3 && rx.offset.v === -1 && JSON.stringify(rx.transform.position.v) === "[120,0]" && !reps.some((r) => r.name === "SDF Repeat y"), reps);
    const polar = reps.find((r) => r.name === "SDF Polar copies");
    c.check("(3) …polar ×6 → a Repeater of 6 turning 60° about (1000, 360)", polar && polar.copies.v === 6 && polar.transform.rotation.v === 60 && JSON.stringify(polar.transform.anchor.v) === "[1000,360]", polar);
    const sector = everything(b).find((i) => i.kind === "path" && /sector/.test((i as any).name)) as any;
    c.check("(3) …the spoke crosses its 60° wedge: each copy is clipped by the sector path", !!sector && sector.path.v.vertices.length === 4, sector);
  }
  {
    const b = await build("s-tiles");
    const reps = everything(b).filter((i) => i.kind === "repeater") as any[];
    const copies = reps.find((r) => r.name === "SDF Repeat x").copies.v * reps.find((r) => r.name === "SDF Repeat y").copies.v;
    c.check("(3) s-tiles: an unbounded repeat covers the visible cells (9 × 5)", copies === 45 && reps.find((r) => r.name === "SDF Repeat x").offset.v === -4, reps.map((r) => [r.name, r.copies.v, r.offset.v]));
    const clip = everything(b).find((i) => i.kind === "rect" && (i as any).name === "SDF Repeat cell") as any;
    c.check("(3) …the off-centre disc overflows its cell in x only: every copy is clipped to the 160 px column", clip && near(clip.size.v[0], 160) && clip.size.v[1] > 160 && near(clip.position.v[0], 640) && near(clip.position.v[1], 360), clip);
  }
  {
    const b = await build("s-animated");
    const L = mainOf(b).layers[0];
    const ell = everything(b).find((i) => i.kind === "ellipse") as any;
    const ks = ell?.size?.keys;
    c.check("(3) s-animated: a keyed radius → exact Ellipse Size keys (2 keys, 120 → 280 px)", ks?.length === 2 && near(ks[0].v[0], 120) && near(ks[1].v[0], 280) && near(ks[1].t, 0.8), ell?.size);
    c.check("(3) …easeOutCubic carried as the exact cubic (out influence 33.33 %)", near(ks?.[0]?.easeOut?.[0]?.influence, 100 / 3, 1e-6), ks?.[0]);
    const mv = group(b, L.id, "SDF Translate")!;
    const pk = (mv?.transform?.position as any)?.keys;
    c.check("(3) …a keyed translate → exact spatial Position keys [0, 0] → [300, 0]", pk?.length === 2 && near(pk[1].v[0], 300) && near(pk[1].v[1], 0), mv?.transform);
    const ln = (b.scene.report.native.concat(b.scene.report.approx)).find((x) => x.id === "pulse");
    c.check("(3) …nothing sampled (no per-frame keys)", !/per-frame/.test(JSON.stringify(b.scene)) && ln?.fidelity !== "sampled", ln);
  }
  {
    const b = await build("s-contour");
    const all = allLayers(b);
    const strokeLayer = all.find((l) => items(l.contents).some((i) => i.kind === "stroke"));
    const sg = items(strokeLayer?.contents).find((i) => i.kind === "group" && i.contents.some((x) => x.kind === "stroke")) as any;
    c.check("(3) s-contour: the stroke strokes the union's merged outline (Ellipse + Rect + Merge Add)", !!sg && sg.contents[0].kind === "group" && sg.contents[0].contents.map((x: any) => x.kind === "merge" ? x.mode : x.kind).join() === "ellipse,rect,add", sg?.contents);
    const slab = all.find((l) => l.matte);
    const matte = slab ? all.find((l) => l.id === slab.matte!.layer) : undefined;
    c.check("(3) …the traced circle mattes the slab: a hidden shape layer of its Ellipse, ALPHA", slab?.matte?.type === "ALPHA" && matte?.enabled === false && items(matte?.contents).some((i) => i.kind === "ellipse"), [slab?.matte, matte?.contents]);
    c.check("(3) …no evaluated contour was needed (no bakes)", !b.bakes.length && b.scene.report.route === "direct", b.scene.report.route);
  }

  // ---- 4. plan_glsl_translation, the editor handler --------------------------------------
  {
    const { buildMcpHandlers } = await import("@/components/effects/mcp-handlers");
    const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");
    const nodes: any[] = [];
    const edges: any[] = [];
    const { layer: Ln, groupInput, groupOutput } = makeLayerNodes("L", { x: 0, y: 0 });
    Ln.id = "L";
    groupInput.id = "L.in";
    groupOutput.id = "L.out";
    groupInput.data.parentId = "L";
    groupOutput.data.parentId = "L";
    nodes.push(Ln, groupInput, groupOutput);
    const mk = (id: string, type: string) => {
      const n = makeInstanceNode(type, { x: 0, y: 0 });
      n.id = id;
      n.data.parentId = "L";
      nodes.push(n);
    };
    mk("mv", "sdf-translate");
    mk("circ", "sdf-circle");
    mk("ras", "sdf-rasterize");
    edges.push({ id: "e1", source: "mv", sourceHandle: "out:primary", target: "circ", targetHandle: "in:position" });
    edges.push({ id: "e2", source: "circ", sourceHandle: "out:primary", target: "ras", targetHandle: "in:sdf" });
    const deps: any = { status: { selectedNodeId: null, loopFrames: 60, canvasWidth: 1280, canvasHeight: 720 }, nodesRef: { current: nodes }, edgesRef: { current: edges }, fpsRef: { current: 30 }, timeRef: { current: 0 } };
    const plan: any = await (buildMcpHandlers(deps) as any).plan_glsl_translation({ target: "ras" });
    c.check("(4) plan_glsl_translation (editor handler): translate → circle → rasterize fuses whole, zero frontier", !plan.refusal && plan.region.join() === "mv,circ,ras" && plan.frontier.length === 0, { region: plan.region, refusal: plan.refusal, frontier: plan.frontier });
  }

  return c.failures;
}
