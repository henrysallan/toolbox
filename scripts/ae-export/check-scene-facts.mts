// The facts the scene walk promises (spec §5.2, the scene lane's brief), on
// the registry fixtures (scripts/fixtures/ae-export/graphs/fixtures.mts):
// ids and layer order, the matte wiring, keys through convert/, the Toolbox
// Shader's Bundle ID as its first prop, bake requests, text documents,
// Repeaters and the layer budget, parenting and clip windows, sampled
// drivers and the OKLab color expression — plus the policy / override
// variants (no host, no fused node, bake / skip / keep-procedural, the .ffx
// gradient route).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { makeChecker, loadRegistry } from "./harness.mts";
import type { AeComp, AeLayer, AeShapeItem } from "@/lib/ae-export/types";
import type { AeSceneBuild } from "@/lib/ae-export/scene";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

export default async function run(): Promise<number> {
  const c = makeChecker("scene-facts");
  await loadRegistry();
  const { SCENE_FIXTURES, sceneOf, track } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  const { tbxShaderParamMatch, TBX_SHADER_MATCH_NAME } = await import("@/lib/ae-export/types");
  const { parseRifx } = await import("@/lib/ae-export/runtime/ffx");
  const { validateAeScene } = await import("@/lib/ae-export/runtime/validate");
  const { postScriptName } = await import("@/lib/ae-export/scene");

  const fx = (name: string) => {
    const f = SCENE_FIXTURES.find((x) => x.name === name);
    if (!f) throw new Error(`no fixture ${name}`);
    return f;
  };
  const build = (name: string, opts: Record<string, unknown> = {}) => {
    const f = fx(name);
    return sceneOf({ ...f, opts: { ...f.opts, ...opts } });
  };
  const mainOf = (b: AeSceneBuild): AeComp => b.scene.comps.find((x) => x.id === b.scene.main)!;
  const layer = (b: AeSceneBuild, id: string): AeLayer | undefined => b.scene.comps.flatMap((x) => x.layers).find((l) => l.id === id);
  const compOf = (b: AeSceneBuild, id: string): AeComp | undefined => b.scene.comps.find((x) => x.id === id);
  const items = (xs: AeShapeItem[] | undefined, out: AeShapeItem[] = []): AeShapeItem[] => {
    for (const it of xs ?? []) {
      out.push(it);
      if (it.kind === "group") items(it.contents, out);
    }
    return out;
  };
  const lines = (b: AeSceneBuild) => [...b.scene.report.native, ...b.scene.report.approx, ...b.scene.report.shader, ...b.scene.report.baked];
  const line = (b: AeSceneBuild, id: string) => lines(b).find((l) => l.id === id);

  // --- A ---------------------------------------------------------------------------------------
  {
    const b = await build("a-circle-mask");
    const m = mainOf(b);
    c.check("(A) route direct, one comp", b.scene.report.route === "direct" && b.scene.comps.length === 1, b.scene.report.route);
    c.check("(A) main comp: the matte source above the shape, top first", m.layers.map((l) => l.id).join() === "matte,fill", m.layers.map((l) => l.id));
    const fill = layer(b, "fill")!;
    const matte = layer(b, "matte")!;
    c.check("(A) the shape layer takes the mask as an ALPHA track matte (its transform carries the keyed Transform)", fill.matte?.layer === "matte" && fill.matte.type === "ALPHA" && matte.enabled === false);
    c.check("(A) the matte source is a white shape of the mask rectangle", items(matte.contents).some((i) => i.kind === "rect") && items(matte.contents).some((i) => i.kind === "fill"));
    const x = fill.transform.separated?.x as any;
    c.check("(A) easeOutBack overshoots → separated X position with 2 keys", !!x && x.keys?.length === 2 && !fill.transform.position, fill.transform);
    // The exact back cubic (1/3, 1 + c1/3, 2/3, 1): out speed = (y1/x1)·ΔV/D.
    const c1 = 1.70158;
    c.near("(A) easeOutBack out speed = (y1/x1)·ΔV/D (1 s, 256 px)", x?.keys?.[0]?.easeOut?.[0]?.speed, ((1 + c1 / 3) / (1 / 3)) * 256, 1e-6);
    c.near("(A) …influence 33.33 %", x?.keys?.[0]?.easeOut?.[0]?.influence, 100 / 3, 1e-9);
    c.check("(A) X keys at comp seconds 0 and 1, values 640 → 896 (anchor + W·translate)", near(x?.keys?.[0]?.t, 0) && near(x?.keys?.[1]?.t, 1) && near(x?.keys?.[0]?.v, 640) && near(x?.keys?.[1]?.v, 896), x?.keys);
    const rot = fill.transform.rotation as any;
    c.check("(A) rotation keyed 0 → 45 (easeOutCubic, exact)", rot.keys?.length === 2 && rot.keys[1].v === 45);
    const ell = items(fill.contents).find((i) => i.kind === "ellipse") as any;
    c.check("(A) the circle stays a parametric Ellipse (size 240, center px)", ell && JSON.stringify(ell.size.v) === "[240,240]" && near(ell.position.v[0], 400) && near(ell.position.v[1], 300), ell);
    c.check("(A) the fill is the node's color, nonzero (stacked)", items(fill.contents).some((i) => i.kind === "fill" && JSON.stringify((i as any).color.v) === JSON.stringify([0.2, 0.6, 1]) && (i as any).rule === "nonzero"));
    c.check("(A) the shape layer's origin lists the segment's nodes", ["fill", "circle", "move", "matte"].every((n) => fill.origin?.includes(n)), fill.origin);
    c.check("(A) the report names the transform's layer placement", /layer transform/.test(line(b, "move")?.note ?? ""), line(b, "move"));
  }

  // --- B ---------------------------------------------------------------------------------------
  {
    const b = await build("b-merge-matte");
    const m = mainOf(b);
    const pre = m.layers[0];
    c.check("(B) Front → one precomp layer with Screen over the Back solid", m.layers.length === 2 && pre.kind === "precomp" && pre.blendingMode === "screen" && m.layers[1].kind === "solid", m.layers.map((l) => [l.id, l.kind, l.blendingMode]));
    c.check("(B) the precomp layer is named after the toolbox layer", pre.name === "Front" && m.layers[1].name === "Back", [pre.name, m.layers[1].name]);
    const inner = compOf(b, pre.source!)!;
    c.check("(B) Merge order inside: matte source, the matted layer, the base", inner.layers.map((l) => l.id).join() === "band,pre:Circle,clear", inner.layers.map((l) => l.id));
    const blurred = layer(b, "pre:Circle")!;
    c.check("(B) mask:<id> fed an image → LUMA track matte by reference", blurred.matte?.layer === "band" && blurred.matte.type === "LUMA" && layer(b, "band")!.enabled === false);
    const blur = blurred.effects?.[0];
    c.check("(B) blur → ADBE Gaussian Blur 2 through the calibrated map (Blurriness = 1.746349·6, both dimensions, Repeat Edge Pixels on)", blur?.match === "ADBE Gaussian Blur 2" && near((blur.props["ADBE Gaussian Blur 2-0001"] as any).v, 1.746349 * 6) && (blur.props["ADBE Gaussian Blur 2-0002"] as any).v === 1 && (blur.props["ADBE Gaussian Blur 2-0003"] as any).v === 1, blur);
    c.check("(B) …on a comp-sized precomp of the circle (AE crops a shape layer's effect buffer to its content)", blurred.kind === "precomp" && compOf(b, blurred.source!)!.layers.map((l) => l.id).join() === "dot");
    c.check("(B) the measured map is reported approx with its note — no longer \"uncalibrated\"", b.scene.report.approx.some((l) => l.id === "soft" && /Blurriness = 1\.7464/.test(l.note ?? "") && !/uncalibrated/.test(l.note ?? "")), b.scene.report.approx.find((l) => l.id === "soft"));
    c.check("(B) the project keeps Linearize Working Space off (the blur was measured that way)", b.scene.project.linearizeWorkingSpace === false && b.scene.project.linearBlending === false && /un-linearized/.test(line(b, "soft")?.note ?? ""));
    c.check("(B) a transparent base solid keeps alpha 0 as opacity 0", (layer(b, "clear")!.transform.opacity as any).v === 0);
  }

  // --- C ---------------------------------------------------------------------------------------
  {
    const b = await build("c-shader");
    const m = mainOf(b);
    const L = layer(b, "shader-1")!;
    const fxs = L.effects?.[0];
    const b1 = b.bundles.find((x) => x.id === (fxs?.props[tbxShaderParamMatch("bundle")] as any)?.v)!;
    c.check("(C) route direct+shader, two bundles, each on a comp-sized solid", b.scene.report.route === "direct+shader" && b.bundles.length === 2 && L.kind === "solid" && L.solid?.width === 1280 && L.solid.height === 720, b.scene.report.route);
    const keys = Object.keys(fxs?.props ?? {});
    c.check("(C) the TBX Shader effect, Bundle ID its FIRST prop, = the bundle id", fxs?.match === TBX_SHADER_MATCH_NAME && keys[0] === tbxShaderParamMatch("bundle") && !!b1, keys);
    c.check("(C) then only the bundle's own slots: slider 1 = gain 0.5", keys.length === 2 && keys[1] === tbxShaderParamMatch("slider", 1) && (fxs!.props[keys[1]] as any).v === 0.5, keys);
    c.check("(C) a generator region samples no layer inputs", b1.inputs.length === 0);
    const tinted = layer(b, "shader-2")!;
    const tk = Object.keys(tinted.effects![0].props);
    const ref = (tinted.effects![0].props[tbxShaderParamMatch("layer", 1)] as any)?.v?.layerRef;
    const refL = m.layers.find((l) => l.id === ref);
    c.check("(C) image input a → Bundle ID, then layer slot a: an AeLayerRef to a hidden precomp of the plate", tk[0] === tbxShaderParamMatch("bundle") && tk[1] === tbxShaderParamMatch("layer", 1) && refL?.kind === "precomp" && refL.enabled === false && compOf(b, refL.source!)!.layers.some((l) => l.id === "plate"), { tk, ref, refL });
    c.check("(C) every region node + the fused nodes are shader lines; the host is required", ["noise", "ramp", "noise2", "disp", "fused", "tint", "fused2"].every((id) => b.scene.report.shader.some((l) => l.id === id)) && !!b.scene.report.requires.shaderHost, b.scene.report.shader.map((l) => l.id));
    const nf = await build("c-shader", { fused: {} });
    const nfd = nf.bakes.find((x) => x.output === "disp:out");
    c.check("(C, no fused node) each region bakes, saying how to get the shader", nf.bakes.length === 2 && !!nfd && /opts\.fused|Convert/.test(nfd.reason ?? ""), nf.bakes);
    const nh = await build("c-shader", { policy: { shaderHost: false } });
    c.check("(C, shaderHost false) no bundle; the regions bake", nh.bundles.length === 0 && nh.bakes.length >= 1 && nh.scene.report.route === "direct+bake", nh.bakes.map((x) => x.output));
    const pin = await build("c-shader", { fused: {}, overrides: { noise: "procedural" } });
    c.check("(C, keep procedural) a bake it would need is a problem instead", pin.problems.some((p) => /keep procedural/.test(p)) && !pin.bakes.some((x) => x.output === "disp:out"), pin.problems);
  }

  // --- D ---------------------------------------------------------------------------------------
  {
    const b = await build("d-particles");
    const k = b.bakes[0];
    const L = mainOf(b).layers[0];
    c.check("(D) one bake request: p2i:out, every comp frame, ProRes 4444, footage/<id>.mov", b.bakes.length === 1 && k.output === "p2i:out" && k.frames.join() === "0,59" && k.codec === "prores4444" && /^footage\/.+\.mov$/.test(k.path) && k.size.join() === "1280,720", k);
    c.check("(D) a footage layer at the same position, sourced from the bake", L.kind === "footage" && L.source === k.id && b.scene.footage.some((f) => f.id === k.id && f.path === k.path && f.fps === 30), L);
    c.check("(D) the simulation is reported baked with its output", ["sim", "p2i"].every((id) => b.scene.report.baked.some((l) => l.id === id)));
    const pin = await build("d-particles", { overrides: { sim: "procedural" } });
    c.check("(D, keep procedural) refusing a bake is a problem", pin.problems.length === 1 && /procedural/.test(pin.problems[0]), pin.problems);
  }

  // --- text ------------------------------------------------------------------------------------
  {
    const b = await build("e-text");
    const L = mainOf(b).layers[0];
    const d = (L.text?.document as any)?.v;
    c.check("(text) a text layer, Inter 700 → Inter-Bold, 120 px, centered", L.kind === "text" && d?.font === "Inter-Bold" && d.fontSize === 120 && d.justification === "center", d);
    c.near("(text) letter spacing 6 px → tracking 50 (1/1000 em)", d?.tracking, 50, 1e-9);
    c.check("(text) fill color and leading (1.2 em)", JSON.stringify(d?.fillColor) === JSON.stringify([1, 0.8, 0]) && near(d?.leading, 144), d);
    c.check("(text) box text over the toolbox box", d?.box && near(d.box.size[0], 1280), d?.box);
    c.check("(text) the family is in report.requires.fonts", b.scene.report.requires.fonts.includes("Inter"));
    c.check("(text) PostScript names: known tables and the derived rule", postScriptName("Arial", 700, false).name === "Arial-BoldMT" && postScriptName("Inter", 400, true).name === "Inter-Italic" && postScriptName("Playfair Display", 900, false).name === "PlayfairDisplay-Black" && !postScriptName("Playfair Display", 900, false).sure);
    c.near("(text) plain text: toolbox centres the line with its trailing letter spacing → the box moves left by spacing / 2 (3 px)", d?.box?.position[0], -3, 1e-9);
  }

  // --- Q: text animators, text on a path, keyed documents (M4 text lane) -----------------------
  {
    const b = await build("q-text-animators");
    const L = mainOf(b).layers.find((l) => l.kind === "text")!;
    const A = L.text?.animators ?? [];
    const by = (n: string) => A.find((a) => a.name === n);
    const sel = (n: string) => by(n)?.selectors ?? [];
    c.check("(Q animators) no bake; Pivot, Type On, Position, Scale, Rotation, Color — one AE animator each", !b.bakes.length && A.map((a) => a.name).join() === "Pivot,Type On,Position,Scale,Rotation,Color", A.map((a) => a.name));
    const pv = (by("Pivot")?.properties["ADBE Text Anchor Point 3D"] as any)?.v;
    c.check("(Q animators) Pivot: Anchor Point = Position = 0.275 em (Arial's measured canvas middle) above the baseline", near(pv?.[1], -0.275 * 96, 1e-9) && JSON.stringify(by("Pivot")?.properties["ADBE Text Position 3D"]) === JSON.stringify(by("Pivot")?.properties["ADBE Text Anchor Point 3D"]), pv);
    const to = sel("Type On")[0] as any;
    c.check("(Q animators) Type On: Opacity 0, one Ramp Up in index units, the amount keys on Offset", (by("Type On")?.properties["ADBE Text Opacity"] as any)?.v === 0 && to?.shape === "ramp-up" && to?.units === "index" && to?.offset?.keys?.length === 2, to);
    const ps = sel("Position") as any[];
    c.check("(Q animators) Position by word from the centre, rest at max → Ramp Down + Ramp Up (Max), on words", ps.length === 2 && ps.every((x) => x.basedOn === "words") && ps[1].mode === "max" && JSON.stringify((by("Position")?.properties["ADBE Text Position 3D"] as any)?.v) === JSON.stringify([0, 40, 0]), ps);
    const sc = sel("Scale")[0] as any;
    c.check("(Q animators) Scale 0 → 1 with ease-out-back → an Expression Selector; the Scale carries the 1.1 overshoot", sc?.kind === "expression" && /\/ 1\.1/.test(sc.expression) && near((by("Scale")?.properties["ADBE Text Scale 3D"] as any)?.v[0], -10, 1e-3), by("Scale"));
    const rt = sel("Rotation")[0] as any;
    c.check("(Q animators) random rotation → an Expression Selector hashing toolbox's seed 3", rt?.kind === "expression" && /tbxHash\(3 \+ i \* 2654435761\)/.test(rt.expression), rt?.expression);
    const co = sel("Color")[0] as any;
    c.check("(Q animators) uniform colour, rest at the fill → a Range Selector over every character, Amount keyed 100 → 0", co?.shape === "square" && co?.amount?.keys?.[0]?.v === 100 && co?.amount?.keys?.[1]?.v === 0, co);
    c.check("(Q animators) the report names the routes (Range exact, Expression for back / random)", /Type On animator: forward cascade → a Range Selector/.test(line(b, "typed")?.note ?? "") && /Rotation animator: an Expression Selector/.test(line(b, "typed")?.note ?? ""));
    c.check("(Q animators) the scene validates", validateAeScene(b.scene).length === 0, validateAeScene(b.scene).slice(0, 3));

    const p = await build("q-text-path");
    const T = mainOf(p).layers.find((l) => l.kind === "text")!;
    const pd = (T.text?.document as any)?.v;
    c.check("(Q path) the arc → mask 1 (mode none) named as the text path; Path Options on it", T.text?.pathMask === 1 && T.masks?.[0]?.mode === "none" && T.text?.pathOptions?.perpendicular === true && T.text?.pathOptions?.reverse === false, T.masks?.[0]);
    c.check("(Q path) start → left justification, point text (no box), one run", pd?.justification === "left" && !pd?.box && pd?.text === "Along the arc", pd);
    c.near("(Q path) above: baseline shift −(0.275 − ½) em = +14.4 px", pd?.baselineShift, -(0.275 - 0.5) * 64, 1e-9);
    const fm = T.text?.pathOptions?.firstMargin as any;
    const arcLen = (380 * (120 * Math.PI)) / 180;
    c.check("(Q path) keyed offset → First Margin keys 0.1 → 0.3 of the arc's length (toolbox's 512-segment polyline)", fm?.keys?.length === 2 && near(fm.keys[0].v, 0.1 * arcLen, 0.05) && near(fm.keys[1].v, 0.3 * arcLen, 0.15), fm?.keys?.map((k: any) => k.v));

    const k = await build("q-text-doc");
    const D = mainOf(k).layers.find((l) => l.kind === "text")!;
    const keys = (D.text?.document as any)?.keys ?? [];
    c.check("(Q doc) keyed font size → a Source Text hold key per frame while it moves (21), then held", keys.length === 21 && keys.every((x: any) => x.inInterp === "hold" && x.outInterp === "hold") && keys[0].v.fontSize === 80 && keys[20].v.fontSize === 120, keys.length);
    c.check("(Q doc) letter spacing 140 px at 80 px = 1750 → document tracking 1000 (AE's limit)", keys.every((x: any) => x.v.tracking === 1000));
    const ls = D.text?.animators?.find((a) => a.name === "Letter Spacing");
    const amt = ls?.properties["ADBE Text Tracking Amount"] as any;
    c.check("(Q doc) …the rest as a px Tracking (After) animator, per frame with the size (140 − size)", (ls?.properties["ADBE Text Track Type"] as any)?.v === 3 && near(amt?.keys?.[0]?.v, 140 - 80, 1e-9) && near(amt?.keys?.[20]?.v, 140 - 120, 1e-9), amt?.keys?.slice(0, 2));
    const fc = D.text?.animators?.find((a) => a.name === "Fill Color")?.properties["ADBE Text Fill Color"] as any;
    c.check("(Q doc) keyed colour → a Fill Color animator: keys + the OKLab expression (the shapes' route)", fc?.keys?.length >= 2 && /OKLab/.test(fc?.expression ?? ""), fc);
    c.check("(Q doc) keyed stroke colour → a Stroke Color animator", !!D.text?.animators?.find((a) => a.name === "Stroke Color")?.properties["ADBE Text Stroke Color"]);
    c.check("(Q doc) the scene validates (integer tracking, hold keys)", validateAeScene(k.scene).length === 0, validateAeScene(k.scene).slice(0, 3));
  }

  // --- gradients -------------------------------------------------------------------------------
  {
    const svg = await build("f-gradient");
    const paint = layer(svg, "paint")!;
    c.check("(gradient, default route) no presets, no headless caveat when every gradient owns its layer", svg.presets.length === 0 && !svg.warnings.some((w) => /AE app build/.test(w)), svg.warnings);
    c.check("(gradient, svg route) the gradient layer is seeded from an SVG", !!paint.source && svg.scene.footage.some((f) => f.id === paint.source && f.kind === "svg") && svg.files.some((f) => /<linearGradient[^>]*x1="384"[^>]*x2="896"/.test(f.text)), svg.files.map((f) => f.text.slice(0, 200)));
    const ink = layer(svg, "ink")!;
    const strokes = items(ink.contents).filter((i) => i.kind === "stroke") as any[];
    c.check("(gradient) a per-subpath stroke ramp → one stroke per copy, first green, last magenta", strokes.length === 4 && JSON.stringify(strokes[0].color.v) === "[0,1,0]" && JSON.stringify(strokes[3].color.v) === "[1,0,1]", strokes.map((s) => s.color.v));
    const ffx = await build("f-gradient", { gradientRoute: "ffx" });
    const g = items(layer(ffx, "paint")!.contents).find((i) => i.kind === "gradient-fill") as any;
    c.check("(gradient, ffx route) a Gradient Fill spanning the disc (canvas frame: the outline's extent, 384 → 896 px) with a preset", g && g.type === "linear" && near(g.start.v[0], 384) && near(g.end.v[0], 896) && ffx.scene.presets.some((p) => p.id === g.preset), g);
    c.check("(gradient, ffx route) the preset bytes parse back as RIFX, and the build warns it needs the AE app", ffx.presets.length === 1 && parseRifx(ffx.presets[0].bytes).id === "RIFX" && ffx.warnings.some((w) => /After Effects app/.test(w)), ffx.warnings);
    c.check("(gradient, ffx route) still a valid scene", validateAeScene(ffx.scene).length === 0, validateAeScene(ffx.scene));
    // A gradient inside composed contents (a Trim inside the fill's group)
    // cannot own its layer: .ffx by default, with the caveat in the report.
    const composed = await sceneOf({
      name: "composed",
      title: "composed",
      comp: { width: 1280, height: 720, fps: 30, frames: 30 },
      build: (g: any) => {
        const A = g.layer("LG2", "Trimmed gradient");
        g.node(A, "disc", "circle", { radiusX: 0.2, radiusY: 0.2, stroke_enabled: false });
        g.node(A, "cut", "trim-path", { trim_end: 0.75 });
        g.node(A, "paint", "rasterize-spline", { enable_stroke: false, fill_source: "gradient", gradient_frame: "canvas" });
        g.wire("disc:out", "cut:in:path");
        g.wire("cut:out", "paint:in:path");
        g.out(A, "paint:out");
      },
    } as any);
    const cg = items(layer(composed, "paint")!.contents).find((i) => i.kind === "gradient-fill") as any;
    const caveat = "gradient stops need the AE app build; headless builds show AE's default gradient";
    c.check("(gradient, composed contents) → .ffx even on the default route", !layer(composed, "paint")!.source && !!cg?.preset && composed.presets.length === 1, { source: layer(composed, "paint")!.source, preset: cg?.preset });
    c.check("(gradient, composed contents) the report carries the headless caveat", composed.scene.report.warnings.some((w) => w.includes(caveat)) && composed.scene.report.approx.some((l) => l.id === "paint" && (l.note ?? "").includes(caveat)), composed.scene.report.warnings);
    // Gradient group on top, a native group under it: the top moves into the SVG.
    const split = await sceneOf({
      name: "split",
      title: "split",
      comp: { width: 1280, height: 720, fps: 30, frames: 30 },
      build: (g: any) => {
        const A = g.layer("LG3", "Gradient over dashes");
        g.node(A, "disc", "circle", { radiusX: 0.2, radiusY: 0.2, stroke_enabled: false });
        g.node(A, "paint", "rasterize-spline", { enable_stroke: true, style: "dashed", fill_source: "gradient", gradient_frame: "canvas" });
        g.wire("disc:out", "paint:in:path");
        g.out(A, "paint:out");
      },
    } as any);
    const sp = layer(split, "paint")!;
    c.check("(gradient) a dashed stroke in the gradient's own group keeps the layer native (.ffx)", !sp.source && split.presets.length === 1, { source: sp.source, presets: split.presets.length });
  }

  // --- dashes + trim ---------------------------------------------------------------------------
  {
    const b = await build("g-dash-trim");
    const dash = layer(b, "dash")!;
    const s = items(dash.contents).find((i) => i.kind === "stroke") as any;
    c.check("(dash) dashed → one Dash / Gap pair (px), butt caps", s?.dashes?.length === 1 && s.dashes[0].dash.v === 30 && s.dashes[0].gap.v === 20 && s.cap === "butt", s);
    const t = items(dash.contents).find((i) => i.kind === "trim") as any;
    c.check("(dash) Trim Path → Trim Paths 10 % … 90 %, combined → Individually", t && t.start.v === 10 && t.end.v === 90 && t.mode === "individual", t);
    const ring = layer(b, "ring")!;
    const rt = items(ring.contents).find((i) => i.kind === "trim") as any;
    c.check("(trim) the primitive's keyed trim_end → keyed Trim End (·100)", rt?.end?.keys?.length >= 2 && rt.end.keys[0].v === 25 && rt.end.keys[rt.end.keys.length - 1].v === 100, rt?.end);
    c.check("(trim) its segment measure is reported approx", b.scene.report.approx.some((l) => l.id === "ring" && /segment measure/.test(l.note ?? "")));
  }

  // --- parenting -------------------------------------------------------------------------------
  {
    const b = await build("h-parenting");
    const kid = layer(b, "kid")!;
    const base = layer(b, "base")!;
    c.check("(parent) the child's AE layer is parented to the parent's", kid.parent === "base" && !base.parent, [kid.parent, base.parent]);
    c.check("(parent) the parent's layer TRS is keyed (translate 0 → 128 px)", "keys" in (base.transform.position as any) || !!base.transform.separated, base.transform);
    c.check("(parent) the child's own TRS: rotation 30 about its pivot, opacity 50 %", (kid.transform.rotation as any).v === 30 && (kid.transform.opacity as any).v === 50 && JSON.stringify((kid.transform.anchor as any).v) === JSON.stringify([384, 360]), kid.transform);
    c.check("(parent) AE layers carry the toolbox layer names", kid.name === "Child" && base.name === "Parent");
  }

  // --- clips -----------------------------------------------------------------------------------
  {
    const b = await build("i-clips");
    const pulse = layer(b, "pulse")!;
    c.check("(clips) one window → in/out 10/30 … 40/30 s", near(pulse.inPoint, 10 / 30) && near(pulse.outPoint, 40 / 30), [pulse.inPoint, pulse.outPoint]);
    const size = (items(pulse.contents).find((i) => i.kind === "ellipse") as any).size;
    c.check("(clips) interior keys shift onto the comp clock (+10 frames)", size.keys?.length === 2 && near(size.keys[0].t, 10 / 30) && near(size.keys[1].t, 30 / 30), size.keys?.map((k: any) => k.t));
    const cuts = mainOf(b).layers.filter((l) => l.source === layer(b, "LI1")?.source);
    c.check("(clips) two windows on different clocks → one precomp placed twice", cuts.length === 2 && near(cuts[0].startTime, 0) && near(cuts[1].startTime, 25 / 30) && near(cuts[1].inPoint, 1) && near(cuts[1].outPoint, 50 / 30), cuts.map((l) => [l.inPoint, l.outPoint, l.startTime]));
  }

  // --- Copy to Points ----------------------------------------------------------------------------
  {
    const b = await build("j-copies");
    const dot = layer(b, "dot")!;
    const reps = items(dot.contents).filter((i) => i.kind === "repeater") as any[];
    c.check("(copies) a 4×3 grid of one shape → two Repeaters (copies 4 / 3, steps 256 / 192 px)", reps.length === 2 && reps[0].copies.v === 4 && near(reps[0].transform.position.v[0], 256) && reps[0].transform.position.v[1] === 0 && reps[1].copies.v === 3 && near(reps[1].transform.position.v[1], 192), reps.map((r) => [r.copies, r.transform.position]));
    const scattered = compOf(b, mainOf(b).layers[0].source!)!;
    const copies = scattered.layers.filter((l) => l.kind === "precomp");
    c.check("(copies) 12 scattered copies → 12 layers of ONE instance precomp", copies.length === 12 && new Set(copies.map((l) => l.source)).size === 1, copies.length);
    const over = await build("k-copies-over");
    c.check("(copies, over budget) 300 copies → a warning and a bake, not 300 layers", over.bakes.length === 1 && over.bakes[0].output === "copy:out" && over.warnings.some((w) => /200-layer budget/.test(w)) && mainOf(over).layers.length === 1, over.warnings);
    c.check("(copies, over budget) static → one frame, a still (no fps)", over.bakes[0].frames.join() === "0,0" && !over.scene.footage[0].fps);
    const kept = await build("k-copies-over", { overrides: { copy: "procedural" } });
    c.check("(copies, over budget, keep procedural) the copies explode past the budget, with a warning", kept.bakes.length === 0 && kept.problems.length === 0 && kept.warnings.some((w) => /past the 200-layer budget/.test(w)), kept.warnings);
    const raised = await build("k-copies-over", { policy: { layerBudget: 400 } });
    const rc = raised.scene.comps.flatMap((x) => x.layers).filter((l) => l.kind === "precomp" && l.origin?.includes("copy"));
    c.check("(copies) a raised budget explodes the 300 copies instead", raised.bakes.length === 0 && rc.length >= 300, [raised.bakes.length, rc.length]);
  }

  // --- instances lane (M4): the r- fixtures (instances-facts.mts) ---------------------
  await (await import("./instances-facts.mts")).instanceFacts(c);

  // --- drivers and colors ------------------------------------------------------------------------
  {
    const b = await build("l-driver");
    const ell = items(layer(b, "blob")!.contents).find((i) => i.kind === "ellipse") as any;
    c.check("(driver) an LFO wired into the radius → one AE expression on Size, no keys", typeof ell?.size?.expression === "string" && !("keys" in (ell?.size ?? {})) && /Math\.sin/.test(ell.size.expression), ell?.size);
    c.check("(driver) …its static value is frame 0's (2·W·0.1 = 256 px)", JSON.stringify(ell?.size?.v) === "[256,256]", ell?.size?.v);
    c.check("(driver) the report names the live expression and the LFO compiled into it", b.scene.report.native.some((l) => l.id === "blob" && l.fidelity === "exact" && /live AE expression/.test(l.note ?? "")) && b.scene.report.native.some((l) => l.id === "wobble" && /compiled into the AE expression/.test(l.note ?? "")), b.scene.report.native);
    const k = await build("l-driver", { policy: { drivers: "keys" } });
    const kell = items(layer(k, "blob")!.contents).find((i) => i.kind === "ellipse") as any;
    c.check("(driver, drivers: keys) the LFO → per-frame size keys (60)", kell?.size?.keys?.length === 60 && !kell.size.expression, kell?.size?.keys?.length);
    c.near("(driver, drivers: keys) frame 15 = 2·W·(0.1 + 0.05·sin(π/2)) = 384 px", kell?.size?.keys?.[15]?.v?.[0], 384, 1e-6);
    c.check("(driver, drivers: keys) the report marks it sampled", k.scene.report.native.some((l) => l.id === "blob" && l.fidelity === "sampled"));
    const m = await build("m-color");
    const flash = layer(m, "flash")!;
    const fill = items(flash.contents).find((i) => i.kind === "fill") as any;
    c.check("(color) a keyed solid color (OKLab) → a rect Fill with linear keys + the OKLab expression", flash.kind === "shape" && fill?.color?.keys?.length === 2 && /oklab|OKLab|lab/i.test(fill.color.expression ?? ""), fill?.color);
    c.check("(color) the layer's 0.5 opacity rides the shape layer", (flash.transform.opacity as any).v === 50);
    const sky = layer(m, "sky")!;
    const ramp = sky.effects?.[0];
    c.check("(gradient ramp) 2-stop linear → ADBE Ramp on a solid: start/end px, colors, linear shape", ramp?.match === "ADBE Ramp" && JSON.stringify((ramp.props["ADBE Ramp-0001"] as any).v) === "[0,360]" && JSON.stringify((ramp.props["ADBE Ramp-0003"] as any).v) === "[1280,360]" && (ramp.props["ADBE Ramp-0005"] as any).v === 1, ramp?.props);
  }

  // --- masks on effects, image Transform ---------------------------------------------------------------
  {
    const b = await build("n-effect-masks");
    const all = b.scene.comps.flatMap((x) => x.layers);
    const cm = all.find((l) => l.effects?.some((e) => e.compositingMask));
    const e = cm?.effects?.find((x) => x.compositingMask);
    c.check("(effect mask) a spline mask on an AE effect → its Compositing Options mask (mode add, index 1)", !!e && e.compositingMask!.mask === 1 && cm!.masks?.[0]?.mode === "add" && cm!.kind === "precomp", cm && { kind: cm.kind, masks: cm.masks?.map((m) => m.mode) });
    const inner = compOf(b, mainOf(b).layers.find((l) => l.name === "Image mask")!.source!)!;
    const [m0, top, bottom] = inner.layers;
    c.check("(effect mask) an image mask → the effected copy (LUMA matte) over the un-effected one", inner.layers.length === 3 && m0.enabled === false && top.matte?.layer === m0.id && top.matte.type === "LUMA" && !!top.effects?.length && !bottom.effects?.length && !bottom.matte, inner.layers.map((l) => [l.id, l.kind, l.matte?.type, l.effects?.length ?? 0]));
    const chip = all.find((l) => l.origin?.includes("turn"))!;
    c.check("(image transform) → the chip's own layer transform (rotation 45 about its center)", (chip.transform.rotation as any).v === 45 && near((chip.transform.anchor as any).v[0], 640) && near((chip.transform.anchor as any).v[1], 640), chip.transform);
  }

  // --- what still bakes, by design ---------------------------------------------------------------------
  {
    const { GraphBuilder } = await import("../fixtures/ae-export/graphs/fixtures.mts");
    void GraphBuilder;
    const adhoc = (name: string, build: (g: any) => void, opts: Record<string, unknown> = {}) => sceneOf({ name, title: name, comp: { width: 1280, height: 720, fps: 30, frames: 30 }, build, opts } as any);
    const avg = await adhoc("avg", (g) => {
      const A = g.layer("LX0", "Below");
      g.node(A, "s0", "solid-color", { color: "#336699" });
      g.out(A, "s0:out");
      const B = g.layer("LX1", "Average", { params: { blendMode: "average" } });
      g.node(B, "s1", "solid-color", { color: "#ff0000" });
      g.out(B, "s1:out");
    });
    c.check("(layer blend Average, no AE mode) the layer composite bakes in its place", avg.bakes.length === 1 && avg.bakes[0].output === "LX1:out" && mainOf(avg).layers[0].kind === "footage", avg.bakes);
    const neg = await adhoc("neg", (g) => {
      const A = g.layer("LY", "Mix");
      g.node(A, "a", "solid-color", { color: "#336699" });
      g.node(A, "b", "solid-color", { color: "#ff0000" });
      g.node(A, "m", "merge", { layers: [{ id: "L1", mode: "negation", opacity: 1 }] });
      g.wire("a:out", "m:in:base");
      g.wire("b:out", "m:in:layer:L1");
      g.out(A, "m:out");
    });
    c.check("(Merge with Negation) a shader region; without a fused node it bakes", neg.bakes.length === 1 && neg.bakes[0].output === "m:out" && neg.scene.report.baked.some((l) => l.id === "m"), neg.bakes);
    const anim = await adhoc("anim", (g) => {
      const A = g.layer("LZ", "Typed");
      g.node(A, "t", "text", { text: "Type", anim_typeon_enabled: true });
      g.out(A, "t:out");
    });
    const typed = anim.scene.comps.flatMap((x) => x.layers).find((l) => l.kind === "text");
    const typeOn = typed?.text?.animators?.find((a) => a.name === "Type On");
    c.check(
      "(text animators) Type On → an Opacity 0 animator, a Ramp Up Range Selector in index units (no bake)",
      !anim.bakes.length && (typeOn?.properties["ADBE Text Opacity"] as any)?.v === 0 && typeOn?.selectors?.[0]?.kind !== "expression" && (typeOn?.selectors?.[0] as any)?.shape === "ramp-up" && (typeOn?.selectors?.[0] as any)?.units === "index",
      typeOn ?? anim.bakes.map((x) => x.reason)
    );
    const fielded = await adhoc("anim-field", (g) => {
      const A = g.layer("LZ", "Fielded");
      g.node(A, "t", "text", { text: "Field", anim_opacity_enabled: true, anim_opacity_driver: "field" });
      g.out(A, "t:out");
    });
    c.check("(text animators) a field-driven animator bakes, with the reason", fielded.bakes.length === 1 && /image field/.test(fielded.bakes[0].reason ?? ""), fielded.bakes.map((x) => x.reason));
    const box = await adhoc("box", (g) => {
      const A = g.layer("LW", "Boxy");
      g.node(A, "sq", "rectangle", { stroke_enabled: false, fill_enabled: true });
      g.node(A, "bl", "blur", { radius: 4, mode: "bokeh" });
      g.wire("sq:aux:image", "bl:in:image");
      g.out(A, "bl:out");
    });
    c.check("(effect map refuses) blur mode bokeh fails applies() → no Gaussian Blur; it bakes", box.bakes.length === 1 && box.bakes[0].output === "bl:out" && !box.scene.comps.flatMap((x) => x.layers).some((l) => l.effects?.length), box.bakes);
  }

  // --- emitter coverage on small graphs -----------------------------------------------------------------
  {
    const adhoc = (name: string, build: (g: any) => void, opts: Record<string, unknown> = {}) => sceneOf({ name, title: name, comp: { width: 1280, height: 720, fps: 30, frames: 30 }, build, opts } as any);
    const all = (b: AeSceneBuild) => b.scene.comps.flatMap((x) => x.layers);
    const shapes = (b: AeSceneBuild) => all(b).flatMap((l) => items(l.contents));
    const anchor = (x: number, y: number, extra: Record<string, unknown> = {}) => ({ pos: [x, y], ...extra });

    const poly = await adhoc("poly", (g) => {
      const A = g.layer("LP0", "Poly");
      g.node(A, "hex", "polygon", { sides: 6, radius: 0.1, rotation: 15, stroke_enabled: false, fill_enabled: true });
      g.node(A, "st", "star", { points: 5, outerRadius: 0.1, innerRadius: 0.04, stroke_enabled: true, fill_enabled: false });
      g.node(A, "both", "merge", { layers: [{ id: "L1", mode: "normal", opacity: 1 }] });
      g.wire("hex:aux:image", "both:in:base");
      g.wire("st:aux:image", "both:in:layer:L1");
      g.out(A, "both:out");
    });
    const stars = shapes(poly).filter((i) => i.kind === "polystar") as any[];
    c.check("(polystar) polygon / star stay parametric: Points, radii ·W, rotation", stars.length === 2 && stars.some((x) => x.type === "polygon" && x.points.v === 6 && near(x.outerRadius.v, 128) && x.rotation.v === 15) && stars.some((x) => x.type === "star" && x.points.v === 5 && near(x.innerRadius.v, 51.2)), stars.map((x) => [x.type, x.points, x.outerRadius]));
    c.check("(bundled style) a primitive's own raster: stroke round caps / joins over an even-odd fill", shapes(poly).some((i) => i.kind === "stroke" && (i as any).cap === "round" && (i as any).join === "round") && shapes(poly).some((i) => i.kind === "fill" && (i as any).rule === "evenodd"));

    const sq = (s: number) => ({ subpaths: [{ closed: true, anchors: [anchor(0.4, 0.4), anchor(0.4 + s, 0.4), anchor(0.4 + s, 0.4 + s), anchor(0.4, 0.4 + s)] }] });
    const drawn = await adhoc("drawn", (g) => {
      const A = g.layer("LQ", "Drawn");
      g.node(A, "pen", "spline-draw", { stroke_enabled: false, fill_enabled: true, spline: sq(0.1) }, { spline: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: sq(0.1), easingOut: "easeOutCubic" }, { tick: 20_000, value: sq(0.2), easingOut: "linear" }] } });
      g.out(A, "pen:aux:image");
    });
    const pathKeys = (shapes(drawn).find((i) => i.kind === "path") as any)?.path;
    c.check("(path keys) a keyed Spline Draw → AE path keys (splineTrackToAe), not per-frame", pathKeys?.keys?.length === 2 && pathKeys.keys[0].v.vertices.length === 4, pathKeys?.keys?.length);

    const waved = await adhoc("waved", (g) => {
      const A = g.layer("LR", "Wave");
      g.node(A, "w", "wave", { stroke_enabled: true }, { phase: track([[0, 0, "linear"], [29, 1, "linear"]]) });
      g.out(A, "w:aux:image");
    });
    const wk = (shapes(waved).find((i) => i.kind === "path") as any)?.path;
    c.check("(sampled path) an animated procedural path with a constant vertex count → path keys every frame", wk?.keys?.length === 30 && waved.scene.report.native.some((l) => l.id === "w" && l.fidelity === "sampled"), wk?.keys?.length);

    const bool = await adhoc("bool", (g) => {
      const A = g.layer("LS", "Cut");
      g.node(A, "a", "circle", { radiusX: 0.2, radiusY: 0.2 });
      g.node(A, "b", "rectangle", { width: 0.1, height: 0.6 });
      g.node(A, "cut", "spline-boolean", { operation: "subtract", fill_enabled: true, stroke_enabled: false });
      g.wire("a:out", "cut:in:a");
      g.wire("b:out", "cut:in:b");
      g.out(A, "cut:aux:image");
    });
    c.check("(merge paths) Spline Boolean subtract → Merge Paths (subtract) over its two inputs, reported approx", shapes(bool).some((i) => i.kind === "merge" && (i as any).mode === "subtract") && bool.scene.report.approx.some((l) => l.id === "cut"), shapes(bool).map((i) => i.kind));

    const taper = await adhoc("taper", (g) => {
      const A = g.layer("LT", "Taper");
      g.node(A, "pen", "spline-draw", { spline: { subpaths: [{ closed: false, anchors: [anchor(0.2, 0.5, { width: 0.25 }), anchor(0.5, 0.5, { width: 0.5 }), anchor(0.8, 0.5, { width: 1 })] }] } });
      g.node(A, "ink", "spline-stroke", { thickness: 20 });
      g.wire("pen:out", "ink:in:path");
      g.out(A, "ink:out");
    });
    const tp = shapes(taper).find((i) => i.kind === "stroke") as any;
    c.check("(taper) a monotonic per-anchor width → Stroke Taper (start 25 %, over the whole length)", tp?.taper && tp.taper.startWidth.v === 25 && tp.taper.startLength.v === 100 && tp.taper.endWidth.v === 100 && taper.scene.report.approx.some((l) => l.id === "ink"), tp?.taper);

    const pic = await adhoc("pic", (g) => {
      const A = g.layer("LU", "Picture");
      g.node(A, "img", "image-source", { file: { width: 640, height: 640 }, fit: "contain" });
      g.out(A, "img:out");
    });
    const ft = all(pic).find((l) => l.kind === "footage")!;
    c.check("(footage) Image Source → a footage layer + an AeAssetCopy keyed by the node id; contain fit → Scale", pic.assets.length === 1 && pic.assets[0].source.kind === "image" && pic.assets[0].source.ref === "img" && ft.source === pic.assets[0].id && near((ft.transform.scale as any).v[0], 112.5) && JSON.stringify((ft.transform.anchor as any).v) === "[320,320]", { assets: pic.assets, t: ft.transform });

    const clip = (filename: string) =>
      adhoc(`clip-${filename}`, (g) => {
        const A = g.layer("LC", "Clip");
        g.node(A, "vid", "video-source", { file: { width: 1280, height: 720, filename }, fit: "cover" });
        g.out(A, "vid:out");
      });
    const mp4 = await clip("take.MP4");
    c.check("(footage) a video keeps its container: take.MP4 → footage/<id>.mp4", mp4.assets.length === 1 && mp4.assets[0].source.kind === "video" && /^footage\/.+\.mp4$/.test(mp4.assets[0].path) && mp4.bakes.length === 0, mp4.assets);
    const webm = await clip("take.webm");
    c.check("(footage) AE can't import WebM: the video bakes, with the reason", webm.assets.length === 0 && webm.bakes.length === 1 && webm.scene.report.baked.some((l) => l.id === "vid" && /\.webm/.test(l.note ?? "")), webm.scene.report);

    const keyed = await adhoc("keyed", (g) => {
      const A = g.layer("LV", "Keyed blur");
      g.node(A, "sq", "rectangle", { stroke_enabled: false, fill_enabled: true });
      g.node(A, "bl", "blur", {}, { radius: track([[0, 0, "easeInOutQuad"], [20, 10, "linear"]]) });
      g.wire("sq:aux:image", "bl:in:image");
      g.out(A, "bl:out");
    });
    const bk = all(keyed).find((l) => l.effects?.length)?.effects?.[0]?.props["ADBE Gaussian Blur 2-0001"] as any;
    c.check("(effect keys) a keyed effect param → AE keys through the map's linear rule (0 → 1.746349·10, eased)", bk?.keys?.length >= 2 && bk.keys[0].v === 0 && near(bk.keys[bk.keys.length - 1].v, 17.46349) && !!bk.keys[0].easeOut, bk);

    const inv = await adhoc("inv", (g) => {
      const A = g.layer("LW2", "Inverted");
      g.node(A, "base", "solid-color", { color: "#000000" });
      g.node(A, "top", "solid-color", { color: "#ffffff" });
      g.node(A, "hole", "circle", { radiusX: 0.1, radiusY: 0.1 });
      g.node(A, "m", "merge", { layers: [{ id: "L1", mode: "normal", opacity: 1, maskInvert: true }] }, { "layer_opacity:L1": track([[0, 1, "linear"], [20, 0.25, "linear"]]) });
      g.wire("base:out", "m:in:base");
      g.wire("top:out", "m:in:layer:L1");
      g.wire("hole:out", "m:in:mask:L1");
      g.out(A, "m:out");
    });
    const topL = all(inv).find((l) => l.id === "top")!;
    c.check("(maskInvert) a spline mask:<id> with maskInvert → ALPHA_INVERTED track matte", topL.matte?.type === "ALPHA_INVERTED", topL.matte);
    const tk = topL.transform.opacity as any;
    c.check("(layer_opacity) Merge layer opacity keys carry over (100 → 25 %)", tk.keys?.length === 2 && tk.keys[0].v === 100 && tk.keys[1].v === 25, tk);

    const shifted = await adhoc("shifted", (g) => {
      const A = g.layer("LX", "Delayed");
      g.node(A, "dot", "circle", { stroke_enabled: false, fill_enabled: true }, { radiusX: track([[0, 0.1, "linear"], [10, 0.2, "linear"]]), radiusY: track([[0, 0.1, "linear"], [10, 0.2, "linear"]]) });
      g.node(A, "late", "time-offset", { offset: 5 });
      g.wire("dot:aux:image", "late:in:in");
      g.out(A, "late:out");
    });
    const sz = (shapes(shifted).find((i) => i.kind === "ellipse") as any)?.size;
    c.check("(time offset) a constant Time Offset shifts the branch's keys by offset / fps (+5 frames)", sz?.keys?.length === 2 && near(sz.keys[0].t, 5 / 30) && near(sz.keys[1].t, 15 / 30), sz?.keys?.map((k: any) => k.t));
    for (const b of [poly, drawn, waved, bool, taper, pic, keyed, inv, shifted]) c.check(`(${b.scene.comps.at(-1)!.name}) valid, no problems`, b.problems.length === 0 && validateAeScene(b.scene).length === 0, [...b.problems, ...validateAeScene(b.scene)].slice(0, 3));
  }

  // --- the calibrated maps' extended contract -----------------------------------------------------------
  {
    const adhoc = (name: string, build: (g: any) => void, opts: Record<string, unknown> = {}) => sceneOf({ name, title: name, comp: { width: 1280, height: 720, fps: 30, frames: 30 }, build, opts } as any);
    const all = (b: AeSceneBuild) => b.scene.comps.flatMap((x) => x.layers);
    const fxOf = (b: AeSceneBuild) => all(b).flatMap((l) => l.effects ?? []);
    const chain = (src: string, type: string, params: Record<string, unknown> = {}, animation?: Record<string, unknown>) => (g: any) => {
      const A = g.layer("LE0", "Chain");
      g.node(A, "src", src, src === "rectangle" ? { stroke_enabled: false, fill_enabled: true } : {});
      g.node(A, "fx", type, params, animation);
      g.wire(src === "rectangle" ? "src:aux:image" : "src:out", "fx:in:image");
      g.out(A, "fx:out");
    };
    const unsharp = await adhoc("unsharp", chain("rectangle", "sharpen", { algorithm: "unsharp", amount: 2 }));
    const um = fxOf(unsharp).find((f) => f.match === "ADBE Unsharp Mask2");
    c.check("(variants) sharpen unsharp → the Unsharp Mask variant (Amount 100·2, radius 0.5), reported exact", !!um && (um.props["ADBE Unsharp Mask2-0001"] as any).v === 200 && (um.props["ADBE Unsharp Mask2-0002"] as any).v === 0.5 && !unsharp.scene.report.approx.some((l) => l.id === "fx"), um);
    const box = await adhoc("sharpbox", chain("rectangle", "sharpen", { algorithm: "box", amount: 1 }));
    c.check("(variants) sharpen box → Sharpen (Amount 50·1)", fxOf(box).some((f) => f.match === "ADBE Sharpen" && (f.props["ADBE Sharpen-0001"] as any).v === 50));
    const diamond = await adhoc("diamond", chain("rectangle", "sharpen", { algorithm: "diamond" }));
    c.check("(refusal) sharpen diamond → no AE effect; the bake reason is the map's refusal", diamond.bakes.length === 1 && /diamond kernel is not Sharpen's/.test(diamond.bakes[0].reason ?? "") && /only the unsharp kernel/.test(diamond.bakes[0].reason ?? ""), diamond.bakes.map((x) => x.reason));
    const post = await adhoc("post", chain("gradient", "posterize", { levels: 4 }));
    const pf = fxOf(post).map((f) => f.match);
    c.check("(before) posterize → Easy Levels then Posterize on the same layer, after the Gradient Ramp", JSON.stringify(pf) === JSON.stringify(["ADBE Ramp", "ADBE Easy Levels2", "ADBE Posterize"]), pf);
    const lv = fxOf(post).find((f) => f.match === "ADBE Easy Levels2")!;
    c.check("(derived) Levels output range [0.5/L, 1 − 0.5/L] for L = 4", near((lv.props["ADBE Easy Levels2-0006"] as any).v, 0.125) && near((lv.props["ADBE Easy Levels2-0007"] as any).v, 0.875), lv.props);
    const pix = await adhoc("pix", chain("rectangle", "pixelate", { aspect: 1 }, { size: track([[0, 16, "linear"], [20, 32, "linear"]]) }));
    const mos = fxOf(pix).find((f) => f.match === "ADBE Mosaic")?.props["ADBE Mosaic-0001"] as any;
    c.check("(derived, keyed) a keyed param a derived prop reads → that prop per frame (Mosaic blocks = W / size), reported sampled", mos?.keys?.length === 30 && near(mos.keys[0].v, 80) && near(mos.keys[20].v, 40) && pix.scene.report.native.some((l) => l.id === "fx" && l.fidelity === "sampled") === false && [...pix.scene.report.approx, ...pix.scene.report.native].some((l) => l.id === "fx" && /per frame/.test(l.note ?? "")), mos?.keys?.slice(0, 2));
    const disp = await adhoc("disp", (g) => {
      const A = g.layer("LE1", "Displaced");
      g.node(A, "slab", "rectangle", { stroke_enabled: false, fill_enabled: true });
      g.node(A, "map", "solid-color", { color: "#ffffff" });
      g.node(A, "push", "displace", { amountX: 0.05, amountY: 0 });
      g.wire("slab:aux:image", "push:in:image");
      g.wire("map:out", "push:in:displacement");
      g.out(A, "push:out");
    });
    const dmLayer = all(disp).find((l) => l.effects?.some((f) => f.match === "ADBE Displacement Map"))!;
    const dm = dmLayer.effects!.find((f) => f.match === "ADBE Displacement Map")!;
    const mref = (dm.props["ADBE Displacement Map-0001"] as any)?.v?.layerRef;
    const mapL = all(disp).find((l) => l.id === mref);
    c.check("(layer input) displace's displacement socket → an AeLayerRef to a hidden comp-sized precomp in the same comp", !!mapL && mapL.kind === "precomp" && mapL.enabled === false && disp.scene.comps.some((cc) => cc.layers.includes(mapL) && cc.layers.includes(dmLayer)), { mref, kind: mapL?.kind });
    c.near("(layer input) Max Horizontal Displacement = amountX·W/2", (dm.props["ADBE Displacement Map-0003"] as any).v, 32, 1e-9);
    c.check("(layer input) the displaced shape sits on a precomp (a source reader on a comp-sized layer)", dmLayer.kind === "precomp" && validateAeScene(disp.scene).length === 0, validateAeScene(disp.scene));
    const echo = await adhoc("echo", (g) => {
      const A = g.layer("LE2", "Echoed");
      g.node(A, "dot", "circle", { stroke_enabled: false, fill_enabled: true }, { centerX: track([[0, 0.3, "linear"], [29, 0.7, "linear"]]) });
      g.node(A, "soft", "blur", { radius: 4 });
      g.node(A, "tail", "trails", { decay: 0.8 });
      g.wire("dot:aux:image", "soft:in:image");
      g.wire("soft:out", "tail:in:image");
      g.out(A, "tail:out");
    });
    const echoL = all(echo).find((l) => l.effects?.some((f) => f.match === "ADBE Echo"))!;
    const blurL = all(echo).find((l) => l.effects?.some((f) => f.match === "ADBE Gaussian Blur 2"))!;
    c.check("(source readers) Echo after a blur: the blurred layer is precomposed, Echo goes on the precomp", echoL !== blurL && echoL.kind === "precomp" && echoL.effects!.length === 1 && echo.scene.comps.find((cc) => cc.id === echoL.source)!.layers.includes(blurL), { echo: echoL.id, blur: blurL.id });
    const eo = echoL.effects![0].props;
    c.check("(fps in the effect context) Echo Time = −1/fps, echoes from the decay (0.8 → ⌈ln(0.5/255)/ln 0.8⌉ = 28)", near((eo["ADBE Echo-0001"] as any).v, -1 / 30) && (eo["ADBE Echo-0002"] as any).v === 28, eo);
    const cc = await adhoc("cc", chain("rectangle", "color-correction", { brightness: 0.1, hue: 30 }));
    c.check("(before) color-correction → Brightness & Contrast (legacy) before Hue/Saturation", JSON.stringify(fxOf(cc).map((f) => f.match)) === JSON.stringify(["ADBE Brightness & Contrast 2", "ADBE HUE SATURATION"]), fxOf(cc).map((f) => f.match));
    for (const b of [unsharp, box, diamond, post, pix, disp, echo, cc]) c.check(`(${b.scene.comps.at(-1)!.name}) valid, no problems`, b.problems.length === 0 && validateAeScene(b.scene).length === 0, [...b.problems, ...validateAeScene(b.scene)].slice(0, 3));
  }

  // --- overrides on a native graph -------------------------------------------------------------------
  {
    const b = await build("b-merge-matte", { overrides: { soft: "bake" } });
    c.check("(override bake) the blurred circle bakes; the rest stays native", b.bakes.length === 1 && b.bakes[0].output === "soft:out" && !!layer(b, "band") && b.scene.report.baked.some((l) => l.id === "soft"), b.bakes);
    const s = await build("b-merge-matte", { overrides: { soft: "skip" } });
    c.check("(override skip) the blur is dropped: its input passes through", !s.scene.comps.flatMap((x) => x.layers).some((l) => l.effects?.length) && s.problems.length === 0, s.problems);
  }

  // --- T: native 3-D scenes (M4 lane 5, specdocs/ae-m4/3d.md) ------------------------------------------
  {
    const { AE_PX_PER_UNIT, AE_ORTHO_DISTANCE_PX, AE_LIGHT_GAIN, aeZoomOf, aeLightIntensity, srgbEncode } = await import("@/lib/ae-export/convert");
    const O = [640, 360, 0];
    const v = (p: any) => p?.v;
    const b = await build("t-scene3d");
    const m = mainOf(b);
    const pre = m.layers[0];
    const comp3d = compOf(b, pre?.source ?? "");
    c.check("(T) route direct, no bakes; the main comp holds ONE 2-D precomp layer of the 3-D comp", b.scene.report.route === "direct" && b.bakes.length === 0 && m.layers.length === 1 && pre.kind === "precomp" && !pre.threeD && !!comp3d, { route: b.scene.report.route, bakes: b.bakes.length, main: m.layers.map((l) => l.kind) });
    c.check("(T) the 3-D comp: Advanced 3D renderer, comp-sized; camera, lights, null, model (top first)", comp3d?.renderer === "advanced-3d" && comp3d.width === 1280 && comp3d.height === 720 && comp3d.layers.map((l) => l.kind).join() === "camera,light,light,light,null,footage", comp3d?.layers.map((l) => l.kind));
    const ft = b.scene.footage.find((f) => f.kind === "model");
    c.check("(T) the GLB → model footage under footage/ (.glb) and an AeAssetCopy of kind model keyed by the Import 3D node", !!ft && /^footage\/.+\.glb$/.test(ft.path) && b.assets.length === 1 && b.assets[0].source.kind === "model" && b.assets[0].source.ref === "model" && b.assets[0].path === ft.path, { ft, assets: b.assets });
    const model = layer(b, "model")!;
    const spin = layer(b, "spin")!;
    c.check("(T) Import 3D → a 3-D footage layer of the model, parented to the Transform 3D null", model.kind === "footage" && model.threeD === true && model.source === ft?.id && model.parent === "spin" && spin.kind === "null" && spin.threeD === true, model);
    c.check("(T) the model's own TRS in its parent's space: position 0, Scale 80 %, Y Rotation −20 (three Y → AE −Y)", JSON.stringify(v(model.transform.position)) === "[0,0,0]" && JSON.stringify(v(model.transform.scale)) === "[80,80,80]" && v(model.transform.yRotation) === -20 && JSON.stringify(v(model.transform.anchor)) === "[0,0,0]", model.transform);
    c.check("(T) the null sits around the comp centre: pos_y 0.2 → y = 360 − 512·0.2", JSON.stringify(v(spin.transform.position)) === JSON.stringify([640, 360 - AE_PX_PER_UNIT * 0.2, 0]), spin.transform.position);
    const yr = spin.transform.yRotation as any;
    c.check("(T) the keyed rot_y → Y Rotation keys 0 → −90 at 0 s / 2 s (sign flipped, eased)", yr?.keys?.length === 2 && yr.keys[1].v === -90 && near(yr.keys[1].t, 2) && yr.keys[0].outInterp === "bezier", yr);
    const cam = layer(b, "cam")!;
    const sx = cam.transform.separated?.x as any;
    const sz = cam.transform.separated?.z as any;
    c.check("(T) camera: pos_x / pos_z key apart → separated X / Y / Z; X 640 + 512·3 → 640 − 512·3, Z −512·4 …", cam.kind === "camera" && sx?.keys?.length === 2 && sx.keys[0].v === 640 + 3 * AE_PX_PER_UNIT && sx.keys[1].v === 640 - 3 * AE_PX_PER_UNIT && sz?.keys?.length === 3 && sz.keys[0].v === -4 * AE_PX_PER_UNIT && v(cam.transform.separated?.y) === 360 - 2 * AE_PX_PER_UNIT, cam.transform);
    c.check("(T) camera Point of Interest = the target (the comp centre); zoom = (H/2)/tan(fov/2)", JSON.stringify(v(cam.transform.anchor)) === JSON.stringify(O) && near(v(cam.camera?.zoom), aeZoomOf(35, 720)) && near(aeZoomOf(35, 720), 360 / Math.tan((17.5 * Math.PI) / 180)), cam.camera);
    const key = layer(b, "key")!;
    const fill = layer(b, "fill")!;
    const amb = layer(b, "amb")!;
    c.check("(T) directional → Parallel aimed at its target, intensity 100·gain·enc(I/π)", key.light?.type === "parallel" && near(v(key.light.intensity), 100 * AE_LIGHT_GAIN * srgbEncode(2 / Math.PI)) && JSON.stringify(v(key.transform.position)) === JSON.stringify([640 + 3 * 512, 360 - 5 * 512, -2 * 512]) && JSON.stringify(v(key.transform.anchor)) === JSON.stringify(O), key.light);
    c.check("(T) point → Point, Inverse Square Clamped at Radius 512 px, matched at the target's distance (3)", fill.light?.type === "point" && fill.light.falloff === "inverse-square-clamped" && v(fill.light.radius) === 512 && near(v(fill.light.intensity), aeLightIntensity("point", 6, 3)) && near(v(fill.light.intensity), 100 * AE_LIGHT_GAIN * 9 * srgbEncode(6 / (9 * Math.PI))) && !("coneAngle" in fill.light), fill.light);
    c.check("(T) the light color hex → 0–1 RGB (#88aaff)", JSON.stringify(v(fill.light?.color)) === JSON.stringify([0x88 / 255, 0xaa / 255, 1]), fill.light?.color);
    c.check("(T) ambient → Ambient, no falloff", amb.light?.type === "ambient" && !("falloff" in amb.light) && near(v(amb.light.intensity), 100 * srgbEncode(0.5 / Math.PI)), amb.light);
    c.check("(T) report: camera exact, lights + model approx, the scene a layer", line(b, "cam")?.fidelity === "exact" && ["key", "fill", "amb", "model"].every((id) => line(b, id)?.fidelity === "approx") && line(b, "scene")?.class === "layer", ["cam", "key", "model", "spin", "scene"].map((id) => [id, line(b, id)?.class, line(b, id)?.fidelity]));

    const o = await build("t-scene3d-ortho");
    const ocam = layer(o, "cam")!;
    const op = v(ocam.transform.position) as number[];
    const dist = Math.hypot(op[0] - O[0], op[1] - O[1], op[2] - O[2]);
    c.check("(T ortho) orthographic → a camera 2·10⁵ px from its target, along the toolbox view direction, zoom = D·H/(512·ortho_height)", near(dist, AE_ORTHO_DISTANCE_PX, 1e-3) && near(v(ocam.camera?.zoom), (AE_ORTHO_DISTANCE_PX * 720) / (512 * 3)) && near((op[0] - 640) / dist, 2.4 / Math.hypot(2.4, 1.8, 2.4)) && near((op[1] - 360) / dist, -1.8 / Math.hypot(2.4, 1.8, 2.4)), { op, zoom: ocam.camera });
    c.check("(T ortho) the camera is reported approx (AE has no orthographic camera)", line(o, "cam")?.fidelity === "approx", line(o, "cam"));
    const spot = layer(o, "spot")!;
    c.check("(T ortho) spot → Spot: Cone Angle = 2·angle, Feather = 100·penumbra", spot.light?.type === "spot" && v(spot.light.coneAngle) === 50 && near(v(spot.light.coneFeather), 40) && spot.light.falloff === "inverse-square-clamped", spot.light);
    const o3 = compOf(o, mainOf(o).layers[0].source!)!;
    const bg = o3.layers[o3.layers.length - 1];
    c.check("(T ortho) a solid background → a 2-D solid at the bottom of the 3-D comp", bg.kind === "solid" && !bg.threeD && JSON.stringify(bg.solid?.color) === JSON.stringify([0x20 / 255, 0x28 / 255, 0x30 / 255]), bg);

    const k = await build("t-scene3d-bakes");
    const reasons = Object.fromEntries(k.bakes.map((x) => [x.output, x.reason ?? ""]));
    c.check("(T bakes) fog, a primitive mesh, a picked file object → each Scene Render bakes with the reason", k.bakes.length === 3 && /fog \(linear\)/.test(reasons["scene:out"]) && /cube-3d \(box\)/.test(reasons["scene2:out"]) && /top:1/.test(reasons["scene3:out"]) && k.assets.length === 0 && k.scene.footage.every((f) => f.kind !== "model"), reasons);
    c.check("(T bakes) the Import 3D under a baked scene bakes with it", ["model", "pick", "box"].every((id) => line(k, id)?.class === "bake"), ["model", "pick", "box"].map((id) => line(k, id)?.class));

    const adhoc3 = (name: string, build3: (g: any, L: string) => void) =>
      sceneOf({ name, title: name, comp: { width: 1280, height: 720, fps: 30, frames: 30 }, build(g: any) { const L = g.layer("LT9", "3D"); build3(g, L); g.out(L, "scene:out"); } } as any);
    const T_MODEL = { url: "blob:fixture/axes.glb", filename: "axes.glb", format: "glb" };
    const lone = await adhoc3("lone", (g, L) => {
      g.node(L, "model", "import-3d", { model: T_MODEL, object: "" });
      g.node(L, "scene", "scene-render", {});
      g.wire("model:out", "scene:in:object:1");
    });
    const lone3 = lone.scene.comps.find((x) => x.renderer === "advanced-3d");
    const lc = lone3?.layers.find((l) => l.kind === "camera");
    c.check("(T default) no camera → Scene Render's default camera (fov 45 from 2.4, 1.8, 2.4); no light → its 0.4 ambient", !!lc && JSON.stringify(v(lc.transform.position)) === JSON.stringify([640 + 2.4 * 512, 360 - 1.8 * 512, -2.4 * 512]) && near(v(lc.camera?.zoom), aeZoomOf(45, 720)) && lone3!.layers.some((l) => l.light?.type === "ambient" && near(v(l.light.intensity), aeLightIntensity("ambient", 0.4))), lone3?.layers.map((l) => l.kind));
    const dof = await adhoc3("dof", (g, L) => {
      g.node(L, "model", "import-3d", { model: T_MODEL, object: "" });
      g.node(L, "cam", "camera-3d", { dof_enabled: true });
      g.node(L, "scene", "scene-render", {});
      g.wire("model:out", "scene:in:object:1");
      g.wire("cam:out", "scene:in:camera");
    });
    const room = await adhoc3("room", (g, L) => {
      g.node(L, "model", "import-3d", { model: T_MODEL, object: "" });
      g.node(L, "scene", "scene-render", { environment: "room" });
      g.wire("model:out", "scene:in:object:1");
    });
    const stl = await adhoc3("stl", (g, L) => {
      g.node(L, "model", "import-3d", { model: { url: "blob:x", filename: "a.stl", format: "stl" }, object: "" });
      g.node(L, "scene", "scene-render", {});
      g.wire("model:out", "scene:in:object:1");
    });
    c.check("(T bakes) depth of field, the room environment, an STL → bake", [dof, room, stl].every((x) => x.bakes.length === 1) && /depth of field/.test(dof.bakes[0]?.reason ?? "") && /room environment/.test(room.bakes[0]?.reason ?? "") && /STL/.test(stl.bakes[0]?.reason ?? ""), [dof, room, stl].map((x) => x.bakes.map((y) => y.reason)));
    const fovKeyed = await adhoc3("fovkeys", (g, L) => {
      g.node(L, "model", "import-3d", { model: T_MODEL, object: "" });
      g.node(L, "cam", "camera-3d", {}, { fov: track([[0, 30], [29, 60]]) });
      g.node(L, "light", "light-3d", { type: "directional" }, { intensity: track([[0, 1], [29, 3]]) });
      g.node(L, "scene", "scene-render", {});
      g.wire("model:out", "scene:in:object:1");
      g.wire("light:out", "scene:in:object:2");
      g.wire("cam:out", "scene:in:camera");
    });
    const fz = (fovKeyed.scene.comps.flatMap((x) => x.layers).find((l) => l.kind === "camera")?.camera?.zoom ?? {}) as any;
    const fi = (fovKeyed.scene.comps.flatMap((x) => x.layers).find((l) => l.kind === "light")?.light?.intensity ?? {}) as any;
    c.check("(T keyed) a keyed FOV → per-frame zoom keys (zoom is not affine in the FOV); a keyed intensity likewise", fz.keys?.length === 30 && near(fz.keys[0].v, aeZoomOf(30, 720)) && near(fz.keys[29].v, aeZoomOf(60, 720)) && fi.keys?.length === 30 && near(fi.keys[29].v, aeLightIntensity("directional", 3)), { zoom: fz.keys?.length, intensity: fi.keys?.length });
    const noFile = await adhoc3("nofile", (g, L) => {
      g.node(L, "model", "import-3d", { model: null, object: "" });
      g.node(L, "scene", "scene-render", {});
      g.wire("model:out", "scene:in:object:1");
    });
    c.check("(T) an Import 3D with no file loaded exports nothing (as toolbox renders it) and says so", noFile.bakes.length === 0 && noFile.assets.length === 0 && noFile.warnings.some((w) => /no file loaded/.test(w)), noFile.warnings);
    for (const x of [b, o, k, lone, dof, room, stl, fovKeyed, noFile]) c.check(`(T ${x.scene.comps.at(-1)!.name}) valid, no problems`, x.problems.length === 0 && validateAeScene(x.scene).length === 0, [...x.problems, ...validateAeScene(x.scene)].slice(0, 3));

    // The validator holds the 3-D rules build.jsx relies on.
    const bad = JSON.parse(JSON.stringify(b.scene));
    const bad3 = bad.comps.find((x: any) => x.renderer === "advanced-3d");
    delete bad3.renderer;
    bad3.layers.find((l: any) => l.kind === "light" && l.light.type === "point").light.coneAngle = { v: 30 };
    bad3.layers.find((l: any) => l.kind === "camera").camera = {};
    const probs = validateAeScene(bad);
    c.check("(T validate) a model outside an advanced-3d comp, a cone on a point light, a camera without zoom → refused", probs.some((p) => /renderer "advanced-3d"/.test(p)) && probs.some((p) => /only spot lights have a cone/.test(p)) && probs.some((p) => /camera\.zoom: missing/.test(p)), probs);
  }
  return c.failures;
}
