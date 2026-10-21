// Exposed knobs → After Effects controls (scene/knobs.ts; M4 lane 6, results
// in specdocs/ae-m4/essential-properties.md), offline:
//
//   * the U fixtures: the main comp's Controls null (one Expression Control
//     per knob, in panel order), a group's precomp with its own Controls in
//     the Essential Graphics, and the report line per knob;
//   * every linked expression, evaluated in a small shim of AE's expression
//     objects (thisComp / comp() / layer() / effect()(1) / value), gives the
//     property's own value at rest — and, with a control changed, exactly
//     what the scene walk writes when the same change is made in toolbox
//     (the offline twin of essential/roundtrip.mts);
//   * variations: a keyed knob, a local pivot, a calibrated effect's affine
//     and enum params (Dropdown), a toolbox layer's promoted input and its
//     opacity, a group that is not a precomp, a baked knob, a structural one,
//     one feeding a value graph, a Toolbox Shader channel, knobExpression;
//   * validateAeScene's rules for menuItems, essential and placeholders.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { loadRegistry, makeChecker } from "./harness.mts";
import type { AeComp, AeLayer, AeScene } from "@/lib/ae-export/types";

const W = 1280;
const H = 720;
const COMP = { width: W, height: H, fps: 30, frames: 60 };

export default async function run(): Promise<number> {
  const c = makeChecker("controls");
  await loadRegistry();
  const { SCENE_FIXTURES, GraphBuilder, buildFixture, track, cy } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");
  const { buildAeSceneForEditor, knobExpression } = await import("@/lib/ae-export/scene");
  const { KnobRegistry, AE_CONTROL } = await import("@/lib/ae-export/scene/knobs");
  const { makeAeGraph } = await import("@/lib/ae-export/scene/graph");
  const { DEFAULT_AE_POLICY } = await import("@/lib/ae-export/types");
  const { validateAeScene } = await import("@/lib/ae-export/runtime/validate");
  const { getNodeDef } = await import("@/engine/registry");

  const opts = (title: string, extra: Record<string, unknown> = {}) => ({
    env: { composition: { id: `comp-${title}`, name: title, width: COMP.width, height: COMP.height, fps: COMP.fps, durationFrames: COMP.frames }, ...(extra.policy ? { policy: extra.policy as any } : {}) },
    name: title,
    toolboxVersion: "fixture",
    generatedAt: "2026-10-21T00:00:00.000Z",
    ...(extra.fused ? { fused: extra.fused as Record<string, string> } : {}),
  });
  const graphOf = (build: (g: any) => void) => {
    const g = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
    build(g);
    return g;
  };
  const walkGraph = (title: string, build: (g: any) => void, patch?: (nodes: any[]) => void, extra?: Record<string, unknown>) => {
    const g = graphOf(build);
    patch?.(g.nodes);
    return buildAeSceneForEditor(g.nodes, g.edges, opts(title, extra));
  };
  const fixture = async (name: string, patch?: (nodes: any[]) => void) => {
    const f = SCENE_FIXTURES.find((x) => x.name === name)!;
    const { nodes, edges } = await buildFixture(f);
    patch?.(nodes);
    return buildAeSceneForEditor(nodes, edges, opts(f.title));
  };
  const P = (nodes: any[], id: string) => nodes.find((n) => n.id === id)!.data.params;
  const mainOf = (s: AeScene): AeComp => s.comps.find((x) => x.id === s.main)!;
  const controlsOf = (comp: AeComp): AeLayer | undefined => comp.layers.find((l) => l.kind === "null" && /^Controls( \d+)?$/.test(l.name) && l.effects?.length);
  const close = (a: unknown, b: unknown, tol = 1e-6): boolean => {
    const x = Array.isArray(a) ? a : [a];
    const y = Array.isArray(b) ? b : [b];
    return x.length >= y.length && y.every((v, i) => typeof x[i] === "number" && Math.abs((x[i] as number) - (v as number)) <= tol);
  };

  // --- the expression shim -----------------------------------------------------------------
  // Control values by "<comp name>/<layer name>" → effect name → value (AE
  // reads a Color Control as [r, g, b, 1]).
  const controlValues = (s: AeScene, override: Record<string, unknown> = {}) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const comp of s.comps)
      for (const L of comp.layers) {
        if (L.kind !== "null" || !L.effects?.length) continue;
        const fx: Record<string, unknown> = {};
        for (const e of L.effects) {
          const p = Object.values(e.props)[0] as any;
          let v = "v" in p ? p.v : p.keys[0].v;
          if (e.match === AE_CONTROL.color.match && Array.isArray(v) && v.length === 3) v = [...v, 1];
          fx[e.name!] = e.name! in override ? override[e.name!] : v;
        }
        out[`${comp.name}/${L.name}`] = fx;
      }
    return out;
  };
  const evaluate = (expr: string, compName: string, controls: Record<string, Record<string, unknown>>, value: unknown) => {
    const layerOf = (cn: string) => (ln: string) => ({
      effect: (en: string) => (i: number) => {
        const v = controls[`${cn}/${ln}`]?.[en];
        if (i !== 1 || v === undefined) throw new Error(`no control ${cn}/${ln}/${en}`);
        return v;
      },
    });
    return new Function("thisComp", "comp", "value", `return (${expr});`)({ layer: layerOf(compName) }, (n: string) => ({ layer: layerOf(n) }), value);
  };
  // Every prop with an expression that reads a Controls layer, by its path.
  const linked = (s: AeScene) => {
    const out = new Map<string, { comp: AeComp; prop: any }>();
    const walk = (o: any, path: string, comp: AeComp) => {
      if (!o || typeof o !== "object") return;
      if (typeof o.expression === "string" && /\.layer\("Controls( \d+)?"\)\.effect\(/.test(o.expression)) out.set(path, { comp, prop: o });
      for (const [k, v] of Object.entries(o)) if (k !== "expression") walk(v, `${path}/${k}`, comp);
    };
    for (const comp of s.comps) for (const L of comp.layers) walk(L, `${comp.id}/${L.id}`, comp);
    return out;
  };
  const restValue = (p: any) => ("v" in p ? p.v : p.keys[0].v);
  // At rest every linked expression gives the property's own value.
  const atRest = (label: string, s: AeScene) => {
    const ctl = controlValues(s);
    const bad: unknown[] = [];
    const links = linked(s);
    for (const [path, { comp, prop }] of links) {
      const got = evaluate(prop.expression, comp.name, ctl, restValue(prop));
      if (!close(got, restValue(prop), 1e-6)) bad.push({ path, got, want: restValue(prop), expr: prop.expression });
    }
    c.check(`${label}: ${links.size} linked expression(s) evaluate to their property's own value at rest`, links.size > 0 && !bad.length, bad);
  };
  // A control changed in AE = the same change made in toolbox.
  const changed = (label: string, s: AeScene, moved: AeScene, override: Record<string, unknown>) => {
    const ctl = controlValues(s, override);
    const after = linked(moved);
    const bad: unknown[] = [];
    let n = 0;
    for (const [path, { comp, prop }] of linked(s)) {
      const twin = after.get(path);
      if (!twin) {
        bad.push({ path, missing: true });
        continue;
      }
      const got = evaluate(prop.expression, comp.name, ctl, restValue(prop));
      n++;
      if (!close(got, restValue(twin.prop), 1e-6)) bad.push({ path, got, want: restValue(twin.prop) });
    }
    c.check(`${label}: with the control changed, ${n} expression(s) = the walk of the same change in toolbox`, n > 0 && !bad.length, bad);
  };

  // --- u-controls -----------------------------------------------------------------------------
  {
    const b = await fixture("u-controls");
    const m = mainOf(b.scene);
    const ctl = controlsOf(m);
    c.check("(U) no problems, the scene validates", !b.problems.length && !validateAeScene(b.scene).length, [b.problems, validateAeScene(b.scene)]);
    c.check("(U) the main comp's top layer is the Controls null, comp space (anchor = position = 0)", m.layers[0] === ctl && ctl.kind === "null" && close((ctl.transform.anchor as any).v, [0, 0]) && close((ctl.transform.position as any).v, [0, 0]));
    c.check(
      "(U) one Expression Control per knob, in panel order: Slider, Angle, Slider, Color",
      JSON.stringify(ctl?.effects?.map((e) => [e.match, e.name])) ===
        JSON.stringify([
          ["ADBE Slider Control", "Size · Value"],
          ["ADBE Angle Control", "Turn · Rotate (°)"],
          ["ADBE Slider Control", "Turn · Translate X"],
          ["ADBE Color Control", "Paint · Color"],
        ]),
      ctl?.effects
    );
    c.check("(U) controls hold toolbox values: 0.125, 30°, 100/W, Paint's color", close(Object.values(ctl!.effects![0].props)[0] && (Object.values(ctl!.effects![0].props)[0] as any).v, 0.125) && (Object.values(ctl!.effects![1].props)[0] as any).v === 30 && close((Object.values(ctl!.effects![2].props)[0] as any).v, 100 / W) && close((Object.values(ctl!.effects![3].props)[0] as any).v, [1, 128 / 255, 0]));
    c.check("(U) main-comp controls are not in the Essential Graphics", ctl!.effects!.every((e) => e.essential === undefined));
    const lines = b.scene.report.controls ?? [];
    c.check("(U) report: four knobs, all on the Controls null, each naming what it drives", lines.length === 4 && lines.every((l) => l.landed === "controls" && l.at.length === 1 && l.drives.length > 0), lines);
    c.check("(U) Size drives the rectangle's width and height (a Constant knob wire)", JSON.stringify(lines[0]?.drives) === JSON.stringify(["Rectangle › size width", "Rectangle › size height"]), lines[0]);
    const chip = [...b.scene.report.native, ...b.scene.report.approx].find((l) => l.id === "chip");
    c.check("(U) the Constant's wire is read as its value, not sampled", chip?.fidelity !== "sampled" && !/sampled/.test(chip?.note ?? ""), chip);
    atRest("(U)", b.scene);
    const moved = await fixture("u-controls", (nodes) => {
      P(nodes, "turn").rotate = 45;
      P(nodes, "turn").translateX = 200 / W;
      P(nodes, "size").value = 0.1875;
      P(nodes, "paint").color = "#0066ff";
    });
    changed("(U)", b.scene, moved.scene, { "Turn · Rotate (°)": 45, "Turn · Translate X": 200 / W, "Size · Value": 0.1875, "Paint · Color": [0, 0.4, 1, 1] });
    c.check("(U) the Constant's step snaps in the expression (0.1875 → 0.188, as toolbox's compute)", JSON.stringify(b.scene).includes("Math.round(thisComp.layer(\\\"Controls\\\").effect(\\\"Size · Value\\\")(1) / 0.001) * 0.001"));
  }

  // --- u-group-essential ------------------------------------------------------------------------
  {
    const b = await fixture("u-group-essential");
    const m = mainOf(b.scene);
    const inner = b.scene.comps.find((x) => x.id !== b.scene.main)!;
    const ctl = controlsOf(inner);
    c.check("(Ug) two comps: the group's precomp and the main comp", b.scene.comps.length === 2 && !b.problems.length, b.problems);
    c.check("(Ug) the main comp: one precomp layer of the group (named after the toolbox layer), no Controls of its own", m.layers.length === 1 && m.layers[0].kind === "precomp" && m.layers[0].source === inner.id && m.layers[0].name === "Badges" && !controlsOf(m), m.layers.map((l) => [l.kind, l.name]));
    c.check(
      "(Ug) the precomp's Controls: Radius (Slider) and Color (Color), both in its Essential Graphics",
      JSON.stringify(ctl?.effects?.map((e) => [e.match, e.name, e.essential])) === JSON.stringify([["ADBE Slider Control", "Radius", "Radius"], ["ADBE Color Control", "Color", "Color"]]),
      ctl?.effects
    );
    c.check("(Ug) their values are the shell's inputValues", close((Object.values(ctl!.effects![0].props)[0] as any).v, 90 / W) && close((Object.values(ctl!.effects![1].props)[0] as any).v, [0.2, 0.8, 0.4]));
    const exprs = [...linked(b.scene).values()];
    c.check("(Ug) inside the precomp, expressions read thisComp's Controls (an instance's override reaches them)", exprs.length === 2 && exprs.every((e) => e.comp === inner && e.prop.expression.includes('thisComp.layer("Controls")')), exprs.map((e) => e.prop.expression));
    const lines = b.scene.report.controls ?? [];
    c.check("(Ug) report: both promoted inputs landed as Essential Properties of the Badge group", lines.length === 2 && lines.every((l) => l.landed === "essential" && l.source === "promoted" && l.owner?.id === "badge"), lines);
    atRest("(Ug)", b.scene);
    const moved = await fixture("u-group-essential", (nodes) => {
      P(nodes, "badge").inputValues = { Radius: 150 / W, Color: "#ff0000" };
    });
    changed("(Ug)", b.scene, moved.scene, { Radius: 150 / W, Color: [1, 0, 0, 1] });
  }

  // --- variations ---------------------------------------------------------------------------
  const chipGraph = (extra: (g: any, L: string) => void) => (g: any) => {
    const L = g.layer("LV", "Chip");
    g.node(L, "chip", "rectangle", { originX: 400 / W, originY: 0.5, width: 0.1, height: 0.1, stroke_enabled: false });
    extra(g, L);
  };
  // Keyed knob: the control carries the keys.
  {
    const build = chipGraph((g, L) => {
      g.node(L, "turn", "transform", { space: "global", pivotX: 400 / W, pivotY: 0.5 }, { rotate: track([[0, 0, "easeOutCubic"], [30, 90, "linear"]]) }, { name: "Turn", controlParams: ["rotate"] });
      g.node(L, "paint", "spline-fill", { color: "#ffffff" });
      g.wire("chip:out", "turn:in:image");
      g.wire("turn:out", "paint:in:path");
      g.out(L, "paint:out");
    });
    const b = walkGraph("keyed", build);
    const ctl = controlsOf(mainOf(b.scene))!;
    const angle = ctl.effects![0].props["ADBE Angle Control-0001"] as any;
    c.check("(keyed) the Angle Control carries the knob's keys and eases", angle?.keys?.length === 2 && angle.keys[1].v === 90 && !!angle.keys[0].easeOut, angle);
    const group = (mainOf(b.scene).layers.find((l) => l.kind === "shape")!.contents![0] as any).contents[0];
    c.check("(keyed) Rotation is static + the expression (the keys live on the control)", "v" in group.transform.rotation && group.transform.rotation.expression?.includes("Turn · Rotate"), group.transform.rotation);
  }
  // Local-space pivot: anchor and position from the input's bounding box.
  {
    const build = chipGraph((g, L) => {
      g.node(L, "turn", "transform", { space: "local", pivotX: 0.25, pivotY: 0.5, rotate: 20, translateX: 50 / W }, undefined, { name: "Turn", controlParams: ["pivotX", "translateX"] });
      g.node(L, "paint", "spline-fill", { color: "#ffffff" });
      g.wire("chip:out", "turn:in:image");
      g.wire("turn:out", "paint:in:path");
      g.out(L, "paint:out");
    });
    const b = walkGraph("local", build);
    atRest("(local pivot)", b.scene);
    const moved = walkGraph("local", build, (nodes) => {
      P(nodes, "turn").pivotX = 0.75;
      P(nodes, "turn").translateX = -80 / W;
    });
    changed("(local pivot)", b.scene, moved.scene, { "Turn · Pivot X": 0.75, "Turn · Translate X": -80 / W });
  }
  // A calibrated effect: an affine param and an enum param (Dropdown).
  {
    const build = (g: any) => {
      const L = g.layer("LD", "Displaced");
      g.node(L, "slab", "rectangle", { originX: 500 / W, originY: cy(W, H, 660), width: 200 / W, height: 80 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ff0000" });
      g.node(L, "map", "solid-color", { color: "#ffffff" });
      g.node(L, "push", "displace", { amountX: 0.05, amountY: 0, channelX: "r" }, undefined, { name: "Push", controlParams: ["amountX", "channelX"] });
      g.wire("slab:aux:image", "push:in:image");
      g.wire("map:out", "push:in:displacement");
      g.out(L, "push:out");
    };
    const b = walkGraph("displace", build);
    const ctl = controlsOf(mainOf(b.scene))!;
    const dd = ctl?.effects?.find((e) => e.match === AE_CONTROL.dropdown.match);
    c.check("(effect) the enum knob is a Dropdown Menu Control: its option labels, value by \"#1\"", !!dd && (dd.menuItems?.length ?? 0) >= 4 && (dd.props["#1"] as any)?.v === 1 && !b.problems.length, [dd, b.problems]);
    atRest("(effect)", b.scene);
    const moved = walkGraph("displace", build, (nodes) => {
      P(nodes, "push").amountX = 0.1;
      P(nodes, "push").channelX = "b";
    });
    const channels = getNodeDef("displace")!.params.find((p) => p.name === "channelX")!.options as string[];
    changed("(effect)", b.scene, moved.scene, { "Push · Amount X": 0.1, "Push · Channel X": channels.indexOf("b") + 1 });
  }
  // A toolbox layer's promoted input and its own opacity knob.
  {
    const build = (g: any) => {
      const L = g.layer("LP", "Promoted", { params: { opacity: 0.5 } });
      const layer = g.nodes.find((n: any) => n.id === L);
      layer.data.controlParams = ["opacity"];
      const gi = g.nodes.find((n: any) => n.id === `${L}.in`);
      gi.data.params.sockets = [...(gi.data.params.sockets ?? []), { name: "Size", type: "scalar" }];
      layer.data.params.inputValues = { Size: 100 / W };
      g.node(L, "dot", "circle", { centerX: 0.5, centerY: 0.5, stroke_enabled: false }, undefined, { exposedParams: ["radiusX"] });
      g.node(L, "paint", "spline-fill", { color: "#ffffff" });
      g.wire(`${L}.in:aux:Size`, "dot:param:radiusX");
      g.wire("dot:out", "paint:in:path");
      g.out(L, "paint:out");
    };
    const b = walkGraph("promoted layer", build);
    const m = mainOf(b.scene);
    const P0 = m.layers.find((l) => l.kind === "precomp");
    const inner = b.scene.comps.find((x) => x.id === P0?.source);
    c.check("(layer) a toolbox layer with a promoted input → its content as a precomp, in the main comp under the layer's name", !!P0 && P0.name === "Promoted" && !!inner && !b.problems.length, [m.layers.map((l) => [l.kind, l.name]), b.problems]);
    const ictl = inner && controlsOf(inner);
    c.check("(layer) the precomp's Controls: Size, in its Essential Graphics", ictl?.effects?.length === 1 && ictl.effects[0].name === "Size" && ictl.effects[0].essential === "Size", ictl?.effects);
    c.check("(layer) the layer's opacity knob → the precomp layer's Opacity reads the main Controls", (P0!.transform.opacity as any).expression?.includes('thisComp.layer("Controls").effect("Promoted · Opacity")') && close((P0!.transform.opacity as any).v, 50), P0?.transform.opacity);
    atRest("(layer)", b.scene);
    const moved = walkGraph("promoted layer", build, (nodes) => {
      P(nodes, "LP").inputValues = { Size: 40 / W };
      P(nodes, "LP").opacity = 0.8;
    });
    changed("(layer)", b.scene, moved.scene, { Size: 40 / W, "Promoted · Opacity": 0.8 });
  }
  // A knob's link under a scaled opacity (a solid's alpha in a 50 % layer):
  // the expression scales with the value.
  {
    const build = (g: any) => {
      const L = g.layer("LS", "Veil", { params: { opacity: 0.5 } });
      g.node(L, "veil", "solid-color", { color: "#3366ff", alpha: 0.8 }, undefined, { name: "Veil", controlParams: ["alpha"] });
      g.out(L, "veil:out");
    };
    const b = walkGraph("scaled", build);
    const op = mainOf(b.scene).layers.find((l) => l.kind === "solid")?.transform.opacity as any;
    c.check("(scaled) the alpha knob's link is scaled by the layer's opacity with the value (40 %)", close(op?.v, 40) && /\) \* 0\.5$/.test(op?.expression ?? ""), op);
    atRest("(scaled)", b.scene);
    const moved = walkGraph("scaled", build, (nodes) => {
      P(nodes, "veil").alpha = 0.3;
    });
    changed("(scaled)", b.scene, moved.scene, { "Veil · Alpha": 0.3 });
  }
  // A group whose output is a spline (the fill is outside it): no precomp —
  // its knob goes on the main Controls, named after the group.
  {
    const build = (g: any) => {
      const L = g.layer("LR", "Ring");
      const sockets = [{ name: "Radius", type: "scalar" }];
      g.node(L, "ring", "node-group", { interface: { inputs: sockets, outputs: [{ name: "spline", type: "spline" }] }, inputValues: { Radius: 120 / W } }, undefined, { name: "Ring" });
      g.node("ring", "ring.in", "group-input", { sockets });
      g.node("ring", "ring.out", "group-output", { sockets: [{ name: "spline", type: "spline" }] });
      g.node("ring", "hoop", "circle", { centerX: 0.5, centerY: 0.5, stroke_enabled: false }, undefined, { exposedParams: ["radiusX"] });
      g.wire("ring.in:aux:Radius", "hoop:param:radiusX");
      g.wire("hoop:out", "ring.out:in:spline");
      g.node(L, "paint", "spline-fill", { color: "#ffffff" });
      g.wire("ring:aux:spline", "paint:in:path");
      g.out(L, "paint:out");
    };
    const b = walkGraph("spline group", build);
    const m = mainOf(b.scene);
    const ctl = controlsOf(m);
    const line = b.scene.report.controls?.[0];
    c.check("(spline group) no precomp; the knob is on the main Controls as \"Ring · Radius\", not essential", b.scene.comps.length === 1 && ctl?.effects?.[0]?.name === "Ring · Radius" && !ctl.effects[0].essential && line?.landed === "controls", [ctl?.effects, line]);
    atRest("(spline group)", b.scene);
  }
  // Baked and structural knobs: report lines with reasons; a value-graph knob links.
  {
    const b = walkGraph(
      "unlinked",
      (g: any) => {
        const A = g.layer("LX0", "Noise");
        g.node(A, "fuzz", "noise", { scale: 3 }, undefined, { controlParams: ["scale"] });
        g.out(A, "fuzz:out");
        const B = g.layer("LX1", "Shapes");
        g.node(B, "dot", "circle", { centerX: 0.5, centerY: 0.5, radiusX: 0.1, radiusY: 0.1, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" }, undefined, { exposedParams: ["radiusX"], controlParams: ["stroke_enabled"] });
        g.node(B, "k", "constant", { value: 0.1 }, undefined, { name: "K", controlParams: ["value"] });
        g.node(B, "twice", "math", { op: "multiply", b: 2 }, undefined, { exposedParams: ["a"] });
        g.wire("k:out", "twice:param:a");
        g.wire("twice:out", "dot:param:radiusX");
        g.out(B, "dot:aux:image");
      },
      undefined,
      { policy: { shaderHost: false } }
    );
    const line = (node: string) => b.scene.report.controls?.find((l) => l.node === node);
    c.check("(unlinked) a knob in baked footage: landed baked, with the reason", line("fuzz")?.landed === "baked" && /baked footage|shader/.test(line("fuzz")?.note ?? ""), line("fuzz"));
    c.check("(unlinked) a structural boolean: unlinked, with a note", line("dot")?.landed === "unlinked" && !!line("dot")?.note && line("dot")?.control === "checkbox", line("dot"));
    // The expression compiler reads a Constant knob through knobExpression:
    // its control is on the Controls null, read by the radius expression.
    const ctl = controlsOf(mainOf(b.scene));
    const radius = JSON.stringify(b.scene.comps.flatMap((x) => x.layers).filter((l) => l !== ctl));
    c.check("(value graph) a Constant feeding a value graph: linked through knobExpression", line("k")?.landed === "controls" && !!line("k")?.drives?.some((d) => /value graph/.test(d)), line("k"));
    c.check("(value graph) its control is the only one on the Controls null, and the compiled expression reads it", ctl?.effects?.length === 1 && ctl.effects[0].name === "K · Value" && radius.includes('effect(\\"K · Value\\")') && !validateAeScene(b.scene).length, { effects: ctl?.effects?.map((e) => e.name), problems: validateAeScene(b.scene) });
  }
  // A Toolbox Shader channel fed by a Constant knob: the TBX slider reads it.
  {
    const f = SCENE_FIXTURES.find((x) => x.name === "c-shader")!;
    const { nodes, edges } = await buildFixture(f);
    const k = makeInstanceNode("constant", { x: 0, y: 0 });
    k.id = "gainKnob";
    k.data.parentId = "LC";
    k.data.params.value = 0.3;
    k.data.name = "Gain";
    k.data.controlParams = ["value"];
    nodes.push(k);
    // The live panel lists knobs the Output reaches: the same Constant also
    // drives the region's noise (as a graph-to-glsl channel mirrors a param).
    edges.push({ id: "e-gain", source: "gainKnob", sourceHandle: "out:primary", target: "fused", targetHandle: "in:in:ch-gain" } as any);
    edges.push({ id: "e-gain2", source: "gainKnob", sourceHandle: "out:primary", target: "noise", targetHandle: "in:param:scale" } as any);
    const b = buildAeSceneForEditor(nodes, edges, { ...opts(f.title), fused: f.opts!.fused! });
    const slider = b.scene.comps.flatMap((x) => x.layers).flatMap((l) => l.effects ?? []).find((e) => e.match === "TBX Shader" && e.props["TBX Shader-0020"])?.props["TBX Shader-0020"] as any;
    c.check("(shader) the TBX Shader slider of a Constant-knob channel reads the Gain control", slider?.expression?.includes('effect("Gain · Value")') && close(slider.v, 0.3), slider);
  }
  // knobExpression: the expression compiler's leaf lookup.
  {
    const g = graphOf((g: any) => {
      const L = g.layer("LK", "Leaves");
      g.node(L, "k", "constant", { value: 0.25 }, undefined, { name: "K", controlParams: ["value"] });
      g.node(L, "push", "displace", { channelX: "g" }, undefined, { name: "Push", controlParams: ["channelX"] });
      g.node(L, "noise", "noise", {}, undefined, { exposedParams: ["scale"] });
      g.wire("k:out", "noise:param:scale");
      g.wire("noise:out", "push:in:image");
      g.wire("noise:out", "push:in:displacement");
      g.out(L, "push:out");
    });
    const graph = makeAeGraph(g.nodes, g.edges, undefined, { width: W, height: H }, 30);
    const knobs = new KnobRegistry(graph);
    const ctx = { graph: knobs.graph, knobs, canvas: { width: W, height: H }, fps: 30, tpf: 1000, durationFrames: 60, policy: DEFAULT_AE_POLICY, report: { note() {}, track() {}, color() {} } } as any;
    const e1 = knobExpression(ctx, "k", "value");
    const e2 = knobExpression(ctx, "push", "channelX");
    c.check("(knobExpression) a Constant knob → its control, snapped to the step", /^\(Math\.round\(\$tbxKnob\d+l\d+\$ \/ 0\.001\) \* 0\.001\)$/.test(e1 ?? ""), e1);
    const channels = getNodeDef("displace")!.params.find((p) => p.name === "channelX")!.options as string[];
    c.check("(knobExpression) an enum knob → the option string by the Dropdown's index", e2 === `${JSON.stringify(channels)}[${/\$tbxKnob\d+l\d+\$/.exec(e2 ?? "")?.[0]} - 1]`, e2);
    c.check("(knobExpression) not a knob → null (noise.scale, wired from K, is one)", knobExpression(ctx, "noise", "seed") === null && !!knobExpression(ctx, "noise", "scale"));
  }

  // --- the validator --------------------------------------------------------------------------
  {
    const b = await fixture("u-controls");
    const bad = (mut: (s: any) => void, want: RegExp, label: string) => {
      const s = JSON.parse(JSON.stringify(b.scene));
      mut(s);
      const p = validateAeScene(s);
      c.check(`(validate) ${label}`, p.some((x) => want.test(x)), p);
    };
    const ctlOf = (s: any) => s.comps.find((x: any) => x.id === s.main).layers[0];
    bad((s) => (ctlOf(s).effects[0].menuItems = ["a"]), /only a Dropdown Menu Control has menu items/, "menuItems on a Slider is refused");
    bad((s) => ctlOf(s).effects.push({ match: "ADBE Dropdown Control", name: "D", menuItems: ["a", "b"], props: { "ADBE Dropdown Control-0001": { v: 1 } } }), /value is "#1"/, "a Dropdown's value keyed by match name is refused");
    bad((s) => ctlOf(s).effects.push({ match: "ADBE Dropdown Control", name: "D", menuItems: [], props: { "#1": { v: 1 } } }), /non-empty item names/, "an empty menu is refused");
    bad((s) => {
      ctlOf(s).effects[0].essential = "X";
      ctlOf(s).effects[1].essential = "X";
    }, /already in this comp's Essential Graphics/, "a duplicate Essential Graphics name is refused");
    bad((s) => (s.comps.find((x: any) => x.id === s.main).layers[1].contents[0].contents[1].color.expression = "$tbxKnob0l0$"), /unresolved knob placeholder/, "an unresolved placeholder is refused");
    bad((s) => (s.report.controls[0].at = []), /names its control/, "a linked report line without its control is refused");
  }
  return c.failures;
}
