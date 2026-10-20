// Registry graphs for the scene walk (buildAeSceneForEditor): the spec §9
// fixtures A–D plus text, gradients, dashes + trim, parenting, clips and
// Copy to Points under / over the layer budget. Built from REAL editor nodes
// (makeInstanceNode / makeLayerNodes) with deterministic ids, so the scene
// JSON snapshots next to this file are stable.
//
// Used by scripts/ae-export/check-scene-*.mts (offline gates) and by
// roundtrip.mts in this folder (the headless After Effects build + render).
// Every fixture may carry `probe`: pixels the AE render must show, in the
// spike runner's terms (scripts/ae-export-spike/run.mts).
//
// Call loadRegistry() (scripts/ae-export/harness.mts) before build().

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Edge } from "@xyflow/react";
import type { GraphNode } from "@/state/graph-ops";
import type { AeSceneOptions } from "@/lib/ae-export/scene";

export interface FixturePixel {
  frame: number;
  x: number;
  y: number;
  // Straight-alpha 8-bit RGBA, null = unchecked. Omitted: a partial alpha
  // (0 < a < 255) is expected — a soft edge.
  want?: (number | null)[];
  tol?: number;
  label: string;
}

export interface SceneFixture {
  name: string;
  title: string;
  comp: { width: number; height: number; fps: number; frames: number };
  build(g: GraphBuilder): void;
  opts?: Partial<Omit<AeSceneOptions, "env" | "name" | "toolboxVersion">> & { policy?: AeSceneOptions["env"]["policy"] };
  probe?: { frames: number[]; pixels: FixturePixel[] };
}

type Key = [frame: number, value: unknown, easing?: string];

export function track(keys: Key[], extra: Record<string, unknown> = {}): any {
  return { animated: true, trackVisible: true, keyframes: keys.map(([f, v, e]) => ({ tick: f * 1000, value: v, easingOut: e ?? "linear" })), ...extra };
}

export class GraphBuilder {
  nodes: GraphNode[] = [];
  edges: Edge[] = [];
  private stackTop: string | null = null;
  private mods: { makeInstanceNode: any; makeLayerNodes: any };

  constructor(mods: { makeInstanceNode: any; makeLayerNodes: any }) {
    this.mods = mods;
    const out = mods.makeInstanceNode("output", { x: 1200, y: 0 });
    out.id = "output";
    this.nodes.push(out);
  }

  private edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
    this.edges = this.edges.filter((e) => !(e.target === target && e.targetHandle === targetHandle));
    this.edges.push({ id: `e${this.edges.length + 1}-${target}`, source, sourceHandle, target, targetHandle } as Edge);
  }

  // A root layer on top of the stack. Ids: <id>, <id>.in, <id>.out.
  layer(id: string, name: string, data: { params?: Record<string, unknown>; animation?: Record<string, unknown>; clips?: unknown[] } = {}): string {
    const { layer, groupInput, groupOutput } = this.mods.makeLayerNodes(name, { x: 0, y: 0 });
    layer.id = id;
    groupInput.id = `${id}.in`;
    groupOutput.id = `${id}.out`;
    groupInput.data.parentId = id;
    groupOutput.data.parentId = id;
    Object.assign(layer.data.params, data.params ?? {});
    if (data.animation) layer.data.animation = data.animation;
    if (data.clips) layer.data.clips = data.clips;
    this.nodes.push(layer, groupInput, groupOutput);
    if (this.stackTop) this.edge(this.stackTop, "out:primary", id, "in:stack");
    this.edge(id, "out:primary", "output", "in:image");
    this.stackTop = id;
    return id;
  }

  node(parent: string | null, id: string, type: string, params: Record<string, unknown> = {}, animation?: Record<string, unknown>, data: Record<string, unknown> = {}): string {
    const n = this.mods.makeInstanceNode(type, { x: 0, y: 0 });
    n.id = id;
    if (parent) n.data.parentId = parent;
    Object.assign(n.data.params, params);
    if (animation) n.data.animation = animation;
    Object.assign(n.data, data);
    this.nodes.push(n);
    return id;
  }

  // "<id>:out" | "<id>:aux:<name>"  →  "<id>:in:<socket>" | "<id>:param:<name>"
  wire(from: string, to: string) {
    const aux = /^(.*):aux:(.+)$/.exec(from);
    const src = aux ? aux[1] : from.replace(/:out$/, "");
    const sh = aux ? `out:aux:${aux[2]}` : "out:primary";
    const m = /^(.*):(in|param):(.+)$/.exec(to);
    if (!m) throw new Error(`bad wire target ${to}`);
    this.edge(src, sh, m[1], m[2] === "param" ? `in:param:${m[3]}` : `in:${m[3]}`);
  }

  // The layer's content: <endpoint> → <layer>.out in:image.
  out(layer: string, from: string) {
    this.wire(from, `${layer}.out:in:image`);
  }

  // Root-level content (no layers).
  root(from: string) {
    this.wire(from, "output:in:image");
  }

  // The layer `child` follows `parent` (the layer Parent wire).
  parent(child: string, parent: string) {
    this.edge(parent, "out:aux:transform", child, "in:transform");
  }
}

// canvas01 y for a pixel row on a W×H comp (y_px = H/2 + (y − 0.5)·W).
export const cy = (W: number, H: number, py: number) => 0.5 + (py - H / 2) / W;

const W = 1280;
const H = 720;
const comp = { width: W, height: H, fps: 30, frames: 60 };

export const SCENE_FIXTURES: SceneFixture[] = [
  // --- A: circle → transform keys (easeOutBack) → fill + spline mask ---------------
  {
    name: "a-circle-mask",
    title: "A circle mask",
    comp,
    build(g) {
      const L = g.layer("LA", "Circle");
      g.node(L, "circle", "circle", { centerX: 400 / W, centerY: cy(W, H, 300), radiusX: 120 / W, radiusY: 120 / W, stroke_enabled: false });
      g.node(L, "move", "transform", { space: "global" }, {
        translateX: track([[0, 0, "easeOutBack"], [30, 0.2, "linear"]]),
        rotate: track([[0, 0, "easeOutCubic"], [30, 45, "linear"]]),
      });
      g.node(L, "fill", "spline-fill", { color: "#3399ff" });
      g.node(L, "matte", "rectangle", { originX: 320 / W, originY: 0.5, width: 320 / W, height: 1, stroke_enabled: false });
      g.wire("circle:out", "move:in:image");
      g.wire("move:out", "fill:in:path");
      g.wire("matte:out", "fill:in:mask");
      g.out(L, "fill:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 400, y: 260, want: [51, 153, 255, 255], tol: 2, label: "inside circle and mask: fill color" },
        { frame: 0, x: 500, y: 300, want: [null, null, null, 0], label: "inside circle, outside the spline mask (x > 480)" },
        { frame: 0, x: 100, y: 100, want: [null, null, null, 0], label: "outside the circle" },
      ],
    },
  },

  // --- B: two layers, Merge with a luma matte + Screen, blur -----------------------
  {
    name: "b-merge-matte",
    title: "B merge matte",
    comp,
    build(g) {
      const back = g.layer("LB0", "Back");
      g.node(back, "navy", "solid-color", { color: "#0d1a4d" });
      g.out(back, "navy:out");
      const front = g.layer("LB1", "Front", { params: { blendMode: "screen" } });
      g.node(front, "clear", "solid-color", { color: "#000000", alpha: 0 });
      g.node(front, "dot", "circle", { centerX: 0.5, centerY: 0.5, radiusX: 200 / W, radiusY: 200 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ff801a" });
      g.node(front, "soft", "blur", { radius: 6 });
      g.node(front, "band", "rectangle", { originX: 0.5, originY: cy(W, H, 300), width: 1, height: 200 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
      g.node(front, "mix", "merge", { layers: [{ id: "L1", mode: "normal", opacity: 1 }] });
      g.wire("dot:aux:image", "soft:in:image");
      g.wire("clear:out", "mix:in:base");
      g.wire("soft:out", "mix:in:layer:L1");
      g.wire("band:aux:image", "mix:in:mask:L1");
      g.out(front, "mix:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 640, y: 300, want: [255, 141, 95, 255], tol: 4, label: "circle × luma band, Screen over navy" },
        { frame: 0, x: 640, y: 480, want: [13, 26, 77, 255], tol: 3, label: "circle outside the band: navy only" },
        { frame: 0, x: 100, y: 300, want: [13, 26, 77, 255], tol: 3, label: "outside the circle: navy" },
      ],
    },
  },

  // --- C: noise → color-ramp → displace, a hand-written fused shader ----------------
  {
    name: "c-shader",
    title: "C shader",
    comp,
    build(g) {
      const L = g.layer("LC", "Shader");
      g.node(L, "noise", "noise", { scale: 3 });
      g.node(L, "ramp", "color-ramp");
      g.node(L, "noise2", "noise", { seed: 7 });
      g.node(L, "disp", "displace", { amountX: 0.05 });
      g.wire("noise:out", "ramp:in:image");
      g.wire("ramp:out", "disp:in:image");
      g.wire("noise2:out", "disp:in:displacement");
      g.out(L, "disp:out");
      // The agent's fused node, inserted unwired downstream (graph-to-glsl).
      g.node(L, "fused", "glsl-expression", {
        expression: "// ch(\"gain\", 0.5, 0, 1)\nfragColor = vec4(v_uv.x, v_uv.y * gain * 2.0, 0.25, 1.0);",
        inputs: [{ id: "ch-gain", name: "gain", default: 0.5, min: 0, max: 1 }],
      });
      // A region with an image input: the native shape feeds the host as a
      // layer (input a → an AeLayerRef to a hidden precomp of it).
      const T = g.layer("LC1", "Tinted");
      g.node(T, "plate", "rectangle", { originX: 0.5, originY: 0.5, width: 0.25, height: 0.25, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
      g.node(T, "tint", "color-ramp");
      g.wire("plate:aux:image", "tint:in:image");
      g.out(T, "tint:out");
      g.node(T, "fused2", "glsl-expression", { expression: "vec4 c = texture(u_a, v_uv);\nfragColor = vec4(c.r, c.g * 0.5, c.b * 0.25, c.a);" });
      g.wire("plate:aux:image", "fused2:in:a");
    },
    opts: { fused: { "disp:out": "fused", "tint:out": "fused2" } },
    probe: {
      frames: [0],
      pixels: [
        // The tinted plate (the host reading input a), over the first shader.
        { frame: 0, x: 640, y: 360, want: [255, 128, 64, 255], tol: 3, label: "input a through the host: the plate, tinted" },
        // v_uv Y-up over the layer: uv = ((x + .5)/W, 1 − (y + .5)/H).
        { frame: 0, x: 320, y: 180, want: [64, 191, 64, 255], tol: 3, label: "fused shader at (320, 180): [u, v, .25]" },
        { frame: 0, x: 960, y: 540, want: [191, 64, 64, 255], tol: 3, label: "fused shader at (960, 540)" },
      ],
    },
  },

  // --- D: particles → bake ---------------------------------------------------------------
  {
    name: "d-particles",
    title: "D particles",
    comp,
    build(g) {
      const L = g.layer("LD", "Particles");
      g.node(L, "sim", "particle-simulator");
      g.node(L, "p2i", "particles-to-image");
      g.wire("sim:out", "p2i:in:particles");
      g.out(L, "p2i:out");
    },
    // roundtrip.mts's placeholder clip: magenta at 50 %.
    probe: { frames: [0], pixels: [{ frame: 0, x: 640, y: 360, want: [255, 0, 255, 128], tol: 3, label: "the baked footage layer shows (placeholder clip)" }] },
  },

  // --- text ------------------------------------------------------------------------------------
  {
    name: "e-text",
    title: "E text",
    comp,
    build(g) {
      const L = g.layer("LE", "Title");
      g.node(L, "title", "text", { text: "Hello AE", font_family: "Inter", font_size: 120, font_weight: 700, color: "#ffcc00", alignment: "center", letter_spacing: 6 });
      g.out(L, "title:out");
    },
    probe: {
      frames: [0],
      pixels: [{ frame: 0, x: 40, y: 40, want: [null, null, null, 0], label: "corner: no text" }],
    },
  },

  // --- gradients: a stroke ramped per subpath + a gradient fill -------------------------
  {
    name: "f-gradient",
    title: "F gradient",
    comp,
    build(g) {
      const L = g.layer("LF", "Gradient");
      g.node(L, "disc", "circle", { centerX: 0.5, centerY: 0.5, radiusX: 0.2, radiusY: 0.2, stroke_enabled: false });
      g.node(L, "paint", "rasterize-spline", {
        enable_stroke: false,
        fill_source: "gradient",
        gradient_kind: "linear",
        gradient_frame: "canvas",
        fill_ramp: [
          { id: "s0", position: 0, color: "#ff0000" },
          { id: "s1", position: 1, color: "#0000ff" },
        ],
      });
      g.node(L, "bars", "grid", { countX: 4, countY: 1, width: 0.6, height: 0, y: cy(W, H, 620) });
      g.node(L, "tick", "line", {});
      g.node(L, "copies", "copy-to-points", { mode: "spline", anchor: "content center", output_tag: "copy index" });
      g.node(L, "ink", "spline-stroke", {
        color_source: "ramp",
        ramp_by: "index",
        thickness: 10,
        color_ramp: [
          { id: "a", position: 0, color: "#00ff00" },
          { id: "b", position: 1, color: "#ff00ff" },
        ],
      });
      g.node(L, "both", "merge", { layers: [{ id: "L1", mode: "normal", opacity: 1 }] });
      g.wire("disc:out", "paint:in:path");
      g.wire("bars:out", "copies:in:points");
      g.wire("tick:out", "copies:in:instance");
      g.wire("copies:out", "ink:in:path");
      g.wire("paint:out", "both:in:base");
      g.wire("ink:out", "both:in:layer:L1");
      g.out(L, "both:out");
    },
    probe: {
      frames: [0],
      pixels: [
        // The disc spans x 384–896: t = (x − 384) / 512 along red → blue (sRGB).
        { frame: 0, x: 400, y: 360, want: [247, 0, 8, 255], tol: 8, label: "SVG-seeded gradient: red at the disc's left" },
        { frame: 0, x: 640, y: 360, want: [128, 0, 127, 255], tol: 8, label: "…the sRGB midpoint at its center" },
        { frame: 0, x: 880, y: 360, want: [8, 0, 247, 255], tol: 8, label: "…blue at its right" },
        { frame: 0, x: 40, y: 40, want: [null, null, null, 0], label: "corner: transparent" },
      ],
    },
  },

  // --- dashes + trim ----------------------------------------------------------------------------
  {
    name: "g-dash-trim",
    title: "G dash trim",
    comp,
    build(g) {
      const L = g.layer("LG", "Dash Trim");
      g.node(L, "ring", "circle", { centerX: 0.3, centerY: 0.5, radiusX: 0.12, radiusY: 0.12, stroke_enabled: true, stroke_thickness: 12, stroke_color: "#ffffff" }, { trim_end: track([[0, 0.25, "easeInOutCubic"], [30, 1, "linear"]]) });
      g.node(L, "rule", "line", {});
      g.node(L, "dash", "spline-stroke", { style: "dashed", dash_length: 30, dash_gap: 20, thickness: 6, cap: "butt", color: "#ff4040" });
      g.node(L, "cut", "trim-path", { trim_start: 0.1, trim_end: 0.9 });
      g.node(L, "both", "merge", { layers: [{ id: "L1", mode: "normal", opacity: 1 }] });
      g.wire("rule:out", "cut:in:path");
      g.wire("cut:out", "dash:in:path");
      g.wire("ring:aux:image", "both:in:base");
      g.wire("dash:out", "both:in:layer:L1");
      g.out(L, "both:out");
    },
    probe: {
      frames: [0],
      pixels: [
        // Ring: center (384, 360), r 153.6; trim end 0.25 at frame 0 = the
        // first quadrant from 12 o'clock, clockwise (toolbox's start point).
        { frame: 0, x: 493, y: 251, want: [255, 255, 255, 255], tol: 3, label: "trimmed ring: the top-right quadrant is drawn" },
        { frame: 0, x: 275, y: 469, want: [null, null, null, 0], label: "trimmed ring: the bottom-left quadrant is not" },
      ],
    },
  },

  // --- parenting -------------------------------------------------------------------------------
  {
    name: "h-parenting",
    title: "H parenting",
    comp,
    build(g) {
      const P = g.layer("LP", "Parent", { animation: { translateX: track([[0, 0, "easeOutQuad"], [30, 0.1, "linear"]]) } });
      g.node(P, "base", "rectangle", { originX: 0.3, originY: 0.5, width: 0.1, height: 0.1, stroke_enabled: false, fill_enabled: true, fill_color: "#ff0000" });
      g.out(P, "base:aux:image");
      const C = g.layer("LC2", "Child", { params: { rotate: 30, pivotX: 0.3, pivotY: 0.5, opacity: 0.5 } });
      g.node(C, "kid", "rectangle", { originX: 0.45, originY: 0.5, width: 0.05, height: 0.05, stroke_enabled: false, fill_enabled: true, fill_color: "#00ff00" });
      g.out(C, "kid:aux:image");
      g.parent(C, P);
    },
    probe: {
      frames: [0, 30],
      pixels: [
        { frame: 0, x: 384, y: 360, want: [255, 0, 0, 255], tol: 2, label: "parent at rest" },
        // Child: (576, 360) rotated 30° about (384, 360) → (550.3, 456), 50 %.
        { frame: 0, x: 550, y: 456, want: [0, 255, 0, 128], tol: 3, label: "child rotated about its pivot, half opacity" },
        { frame: 30, x: 512, y: 360, want: [255, 0, 0, 255], tol: 2, label: "parent moved +128 px" },
        { frame: 30, x: 678, y: 456, want: [0, 255, 0, 128], tol: 3, label: "the child followed its parent" },
      ],
    },
  },

  // --- clips --------------------------------------------------------------------------------------
  {
    name: "i-clips",
    title: "I clips",
    comp,
    build(g) {
      const A = g.layer("LI0", "Windowed", { clips: [{ inTick: 10_000, outTick: 40_000, sourceInTick: 0, enabled: true }] });
      g.node(A, "pulse", "circle", { stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" }, { radiusX: track([[0, 0.05, "linear"], [20, 0.15, "linear"]]), radiusY: track([[0, 0.05, "linear"], [20, 0.15, "linear"]]) });
      g.out(A, "pulse:aux:image");
      const B = g.layer("LI1", "Two cuts", {
        clips: [
          { inTick: 0, outTick: 15_000, sourceInTick: 0, enabled: true },
          { inTick: 30_000, outTick: 50_000, sourceInTick: 5_000, enabled: true },
        ],
      });
      g.node(B, "box", "rectangle", { originX: 0.8, width: 0.2, height: 0.2, stroke_enabled: false, fill_enabled: true, fill_color: "#00ccff" }, { rotate: track([[0, 0, "linear"], [30, 90, "linear"]]) });
      g.out(B, "box:aux:image");
    },
    probe: {
      frames: [5, 10, 20, 40],
      pixels: [
        { frame: 5, x: 640, y: 360, want: [null, null, null, 0], label: "before the window: hidden" },
        { frame: 20, x: 740, y: 360, want: [255, 255, 255, 255], tol: 2, label: "inside the window on the local clock: radius 128" },
        { frame: 20, x: 790, y: 360, want: [null, null, null, 0], label: "…and not radius 192 (the comp clock)" },
        { frame: 10, x: 1024, y: 360, want: [0, 204, 255, 255], tol: 2, label: "first cut shows the box" },
        { frame: 20, x: 1024, y: 360, want: [null, null, null, 0], label: "between the cuts: hidden" },
        { frame: 40, x: 1024, y: 360, want: [0, 204, 255, 255], tol: 2, label: "second cut shows the box" },
      ],
    },
  },

  // --- Copy to Points under the budget: grid → Repeaters; scatter → exploded --------------
  {
    name: "j-copies",
    title: "J copies",
    comp,
    build(g) {
      const L = g.layer("LJ0", "Grid copies");
      g.node(L, "dot", "circle", { radiusX: 0.02, radiusY: 0.02, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
      g.node(L, "grid", "grid", { countX: 4, countY: 3, width: 0.6, height: 0.3 });
      g.node(L, "copy", "copy-to-points", { mode: "image", anchor: "content center" });
      g.wire("grid:out", "copy:in:points");
      g.wire("dot:aux:image", "copy:in:instance");
      g.out(L, "copy:out");
      const M = g.layer("LJ1", "Scattered");
      g.node(M, "sq", "rectangle", { width: 0.03, height: 0.03, stroke_enabled: false, fill_enabled: true, fill_color: "#ff8800" });
      g.node(M, "spray", "scatter-points", { count: 12 });
      g.node(M, "copy2", "copy-to-points", { mode: "image", anchor: "content center" });
      g.wire("spray:out", "copy2:in:points");
      g.wire("sq:aux:image", "copy2:in:instance");
      g.out(M, "copy2:out");
    },
    probe: {
      frames: [0],
      pixels: [
        // Grid x = 256 + 256·i, y = 168 + 192·j; dots r 25.6.
        { frame: 0, x: 256, y: 168, want: [255, 255, 255, 255], tol: 2, label: "first grid copy (Repeaters)" },
        { frame: 0, x: 1024, y: 552, want: [255, 255, 255, 255], tol: 2, label: "last grid copy" },
        { frame: 0, x: 640, y: 168, want: [null, null, null, 0], label: "between grid columns" },
      ],
    },
  },

  // --- Copy to Points over the budget → warning + bake -----------------------------------------
  {
    name: "k-copies-over",
    title: "K copies over",
    comp,
    build(g) {
      const L = g.layer("LK", "Too many");
      g.node(L, "sq", "rectangle", { width: 0.01, height: 0.01, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
      g.node(L, "spray", "scatter-points", { count: 300 });
      g.node(L, "copy", "copy-to-points", { mode: "image", anchor: "content center" });
      g.wire("spray:out", "copy:in:points");
      g.wire("sq:aux:image", "copy:in:instance");
      g.out(L, "copy:out");
    },
    opts: { policy: { layerBudget: 200 } },
    probe: { frames: [0], pixels: [{ frame: 0, x: 640, y: 360, want: [255, 0, 255, 128], tol: 3, label: "the static bake shows as a still (placeholder)" }] },
  },
];

// --- wired drivers and keyed colors ------------------------------------------------------
SCENE_FIXTURES.push(
  {
    name: "l-driver",
    title: "L driver",
    comp,
    build(g) {
      const L = g.layer("LL", "Driven");
      g.node(L, "wobble", "lfo", { frequency: 0.5, amplitude: 0.05, offset: 0.1 });
      g.node(L, "blob", "circle", { stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" }, undefined, { exposedParams: ["radiusX", "radiusY"] });
      g.wire("wobble:out", "blob:param:radiusX");
      g.wire("wobble:out", "blob:param:radiusY");
      g.out(L, "blob:aux:image");
    },
    probe: {
      frames: [0, 15],
      pixels: [
        // r = 0.1 + 0.05·sin(2π·0.5·t): 128 px at frame 0, 192 px at frame 15.
        { frame: 0, x: 760, y: 360, want: [255, 255, 255, 255], tol: 2, label: "frame 0: radius 128 covers x 760" },
        { frame: 0, x: 820, y: 360, want: [null, null, null, 0], label: "frame 0: …but not x 820" },
        { frame: 15, x: 820, y: 360, want: [255, 255, 255, 255], tol: 2, label: "frame 15: the sampled driver grew it to 192 px" },
      ],
    },
  },
  {
    name: "m-color",
    title: "M color",
    comp,
    build(g) {
      const A = g.layer("LM0", "Ramp");
      g.node(A, "sky", "gradient", { mode: "linear", start_x: 0, start_y: 0.5, end_x: 1, end_y: 0.5, color_a: "#000000", color_b: "#ffffff" });
      g.out(A, "sky:out");
      const B = g.layer("LM1", "Tween", { params: { opacity: 0.5 } });
      g.node(B, "flash", "solid-color", {}, { color: track([[0, "#ff0000", "linear"], [30, "#0000ff", "linear"]]) });
      g.out(B, "flash:out");
    },
    probe: {
      frames: [0, 15, 30],
      pixels: [
        // Ramp black → white along x (sRGB mix), under a 50 % red layer.
        { frame: 0, x: 0, y: 360, want: [128, 0, 0, 255], tol: 3, label: "left: black ramp under 50 % red" },
        // OKLab midpoint of red → blue is [140, 83, 162] (spec §4.3); AE's own
        // RGB lerp would give [128, 0, 128] — the expression must win.
        { frame: 15, x: 0, y: 360, want: [70, 41, 81, 255], tol: 4, label: "mid-tween: the OKLab expression, not AE's RGB lerp" },
        { frame: 30, x: 1279, y: 360, want: [128, 128, 255, 255], tol: 4, label: "right: white ramp under 50 % blue (the OKLab expression's end)" },
      ],
    },
  }
);

// --- masks on effects, and an image Transform -----------------------------------------
SCENE_FIXTURES.push({
  name: "n-effect-masks",
  title: "N effect masks",
  comp,
  build(g) {
    // A spline mask on an AE effect → its Compositing Options mask.
    const A = g.layer("LN0", "Spline mask");
    g.node(A, "slab", "rectangle", { originX: 400 / W, originY: 0.5, width: 400 / W, height: 320 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
    g.node(A, "soften", "blur", { radius: 20 });
    g.node(A, "lens", "circle", { centerX: 200 / W, centerY: 0.5, radiusX: 60 / W, radiusY: 60 / W, stroke_enabled: false });
    g.wire("slab:aux:image", "soften:in:image");
    g.wire("lens:out", "soften:in:mask");
    g.out(A, "soften:out");
    // An image mask on an effect → the effected copy matted over the original.
    const B = g.layer("LN1", "Image mask");
    g.node(B, "slab2", "rectangle", { originX: 900 / W, originY: 0.5, width: 400 / W, height: 320 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
    g.node(B, "soften2", "blur", { radius: 20 });
    g.node(B, "half", "rectangle", { originX: 1090 / W, originY: 0.5, width: 380 / W, height: 1, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
    g.wire("slab2:aux:image", "soften2:in:image");
    g.wire("half:aux:image", "soften2:in:mask");
    g.out(B, "soften2:out");
    // An image Transform mid-chain → the layer transform.
    const C = g.layer("LN2", "Turned");
    g.node(C, "chip", "rectangle", { originX: 0.5, originY: cy(W, H, 640), width: 60 / W, height: 60 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ff0000" });
    g.node(C, "turn", "transform", { rotate: 45, pivotX: 0.5, pivotY: cy(W, H, 640) });
    g.wire("chip:aux:image", "turn:in:image");
    g.out(C, "turn:out");
  },
  probe: {
    frames: [0],
    pixels: [
      // Slab 1 spans x 200–600, y 200–520; the lens covers its left edge for y 300–420.
      { frame: 0, x: 195, y: 360, label: "inside the compositing mask: the left edge is blurred (partial alpha)" },
      { frame: 0, x: 195, y: 490, want: [null, null, null, 0], label: "outside the mask: the edge stays sharp (nothing left of x 200)" },
      { frame: 0, x: 205, y: 490, want: [255, 255, 255, 255], tol: 2, label: "…and solid just inside it" },
      // Slab 2 spans x 700–1100; the image mask covers x ≥ 900.
      { frame: 0, x: 1105, y: 360, label: "inside the image mask: the right edge is blurred" },
      { frame: 0, x: 695, y: 360, want: [null, null, null, 0], label: "outside the image mask: the left edge stays sharp" },
      // The red chip turned 45° about its center (640, 640): a diamond.
      { frame: 0, x: 640, y: 600, want: [255, 0, 0, 255], tol: 2, label: "rotated chip: its top corner reaches y 598" },
      { frame: 0, x: 612, y: 612, want: [null, null, null, 0], label: "rotated chip: the old top-left corner is empty" },
    ],
  },
});

// --- calibrated effect chains: Levels → Posterize, a displacement map layer ------------
SCENE_FIXTURES.push({
  name: "o-calibrated",
  title: "O calibrated",
  comp,
  build(g) {
    // Black → white along x, posterized to 4 levels: toolbox rounds v·3.
    const A = g.layer("LO0", "Posterized");
    g.node(A, "ramp", "gradient", { mode: "linear", start_x: 0, start_y: 0.5, end_x: 1, end_y: 0.5, color_a: "#000000", color_b: "#ffffff" });
    g.node(A, "bands", "posterize", { levels: 4 });
    g.wire("ramp:out", "bands:in:image");
    g.out(A, "bands:out");
    // A slab pushed left by a white map: (1 − 0.5)·0.05·W = 32 px.
    const B = g.layer("LO1", "Displaced");
    g.node(B, "slab", "rectangle", { originX: 500 / W, originY: cy(W, H, 660), width: 200 / W, height: 80 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ff0000" });
    g.node(B, "map", "solid-color", { color: "#ffffff" });
    g.node(B, "push", "displace", { amountX: 0.05, amountY: 0 });
    g.wire("slab:aux:image", "push:in:image");
    g.wire("map:out", "push:in:displacement");
    g.out(B, "push:out");
  },
  probe: {
    frames: [0],
    pixels: [
      { frame: 0, x: 100, y: 200, want: [0, 0, 0, 255], tol: 3, label: "posterize: v 0.08 → level 0" },
      { frame: 0, x: 300, y: 200, want: [85, 85, 85, 255], tol: 3, label: "posterize: v 0.23 → 1/3 (Levels makes AE's floor round like toolbox)" },
      { frame: 0, x: 900, y: 200, want: [170, 170, 170, 255], tol: 3, label: "posterize: v 0.70 → 2/3" },
      { frame: 0, x: 1200, y: 200, want: [255, 255, 255, 255], tol: 3, label: "posterize: v 0.94 → 1" },
      { frame: 0, x: 380, y: 660, want: [255, 0, 0, 255], tol: 3, label: "displaced slab: its left edge moved from 400 to 368" },
      // v = 585.5/1280 = 0.46 → level 1/3: the ramp, not the red slab.
      { frame: 0, x: 585, y: 660, want: [85, 85, 85, 255], tol: 3, label: "…and its right edge from 600 to 568 (the ramp shows through)" },
    ],
  },
});

export async function buildFixture(f: SceneFixture): Promise<{ nodes: GraphNode[]; edges: Edge[] }> {
  const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");
  const g = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
  f.build(g);
  return { nodes: g.nodes, edges: g.edges };
}

export async function sceneOf(f: SceneFixture) {
  const { buildAeSceneForEditor } = await import("@/lib/ae-export/scene");
  const { nodes, edges } = await buildFixture(f);
  const { policy, ...rest } = f.opts ?? {};
  return buildAeSceneForEditor(nodes, edges, {
    env: { composition: { id: `comp-${f.name}`, name: f.title, width: f.comp.width, height: f.comp.height, fps: f.comp.fps, durationFrames: f.comp.frames }, ...(policy ? { policy } : {}) },
    name: f.title,
    toolboxVersion: "fixture",
    generatedAt: "2026-10-20T00:00:00.000Z",
    ...rest,
  });
}
