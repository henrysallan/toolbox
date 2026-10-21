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
import { SDF_SCENE_FIXTURES } from "./sdf-fixtures.mts";
import { buildCorpus, P_EXPRESSION_CASES } from "./expressions-corpus.mts";
import { axesModel, writeGlb } from "../../../ae-export-spike/calibrate/model3d.mts";

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
  // Import 3D node id → the model file's bytes (the round trips write them
  // where the scene's model footage points; the gates never read them).
  models?: Record<string, () => Uint8Array>;
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
    // The first ":in:" / ":param:" ends the node id ("fused:in:in:ch-gain"
    // is a GLSL channel socket, in:<row id>).
    const m = /^(.*?):(in|param):(.+)$/.exec(to);
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
        { frame: 15, x: 820, y: 360, want: [255, 255, 255, 255], tol: 2, label: "frame 15: the driver (an AE expression) grew it to 192 px" },
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

// --- M4 lane 4: hard SDF chains (sdf-fixtures.mts) ----------------------------------
SCENE_FIXTURES.push(...SDF_SCENE_FIXTURES);
// --- the value graph as AE expressions (M4 lane 1): one case per node type and consumer --------
// (expressions-corpus.mts; check-expressions holds the whole corpus, and
// expressions-roundtrip.mts reads AE's valueAtTime back for both).
SCENE_FIXTURES.push({
  name: "p-expressions",
  title: "P expressions",
  comp,
  build(g) {
    buildCorpus(g, P_EXPRESSION_CASES);
  },
});
// --- U (lane 6): exposed knobs → Expression Controls / Essential Properties -------------
SCENE_FIXTURES.push(
  {
    // Control-toggled knobs in the main comp: a Transform's rotate and
    // translateX, a fill color, and a Constant wired into the rectangle's
    // width and height → one Controls null, expressions on the driven props.
    name: "u-controls",
    title: "U controls",
    comp,
    build(g) {
      const L = g.layer("LU0", "Chip");
      g.node(L, "size", "constant", { value: 160 / W }, undefined, { name: "Size", controlParams: ["value"] });
      g.node(L, "chip", "rectangle", { originX: 400 / W, originY: 0.5, width: 0.1, height: 0.1, stroke_enabled: false }, undefined, { exposedParams: ["width", "height"] });
      g.node(L, "turn", "transform", { space: "global", pivotX: 400 / W, pivotY: 0.5, rotate: 30, translateX: 100 / W }, undefined, { name: "Turn", controlParams: ["rotate", "translateX"] });
      g.node(L, "paint", "spline-fill", { color: "#ff8000" }, undefined, { name: "Paint", controlParams: ["color"] });
      g.wire("size:out", "chip:param:width");
      g.wire("size:out", "chip:param:height");
      g.wire("chip:out", "turn:in:image");
      g.wire("turn:out", "paint:in:path");
      g.out(L, "paint:out");
    },
    probe: {
      frames: [0],
      pixels: [
        // A 160 px square about (500, 360), turned 30°: its top corner sits
        // at (470.7, 250.7), the top edge at y 256 for x 480.
        { frame: 0, x: 500, y: 360, want: [255, 128, 0, 255], tol: 2, label: "chip centre: Paint's color, moved by Turn's translateX" },
        { frame: 0, x: 400, y: 360, want: [null, null, null, 0], label: "the untranslated centre is empty" },
        { frame: 0, x: 480, y: 262, want: [255, 128, 0, 255], tol: 2, label: "the turned top corner reaches above the unturned edge (y 280)" },
      ],
    },
  },
  {
    // A node-group with two promoted inputs (one fanned out to radiusX and
    // radiusY) → a precomp of its own whose Controls are Essential Properties.
    name: "u-group-essential",
    title: "U group essential",
    comp,
    build(g) {
      const L = g.layer("LU1", "Badges");
      const sockets = [{ name: "Radius", type: "scalar" }, { name: "Color", type: "vec4" }];
      g.node(L, "badge", "node-group", { interface: { inputs: sockets, outputs: [{ name: "image", type: "image" }] }, inputValues: { Radius: 90 / W, Color: "#33cc66" } }, undefined, { name: "Badge" });
      g.node("badge", "badge.in", "group-input", { sockets });
      g.node("badge", "badge.out", "group-output", { sockets: [{ name: "image", type: "image" }] });
      g.node("badge", "disc", "circle", { centerX: 640 / W, centerY: 0.5, radiusX: 0.05, radiusY: 0.05, stroke_enabled: false }, undefined, { exposedParams: ["radiusX", "radiusY"] });
      g.node("badge", "tint", "spline-fill", { color: "#ffffff" }, undefined, { exposedParams: ["color"] });
      g.wire("badge.in:aux:Radius", "disc:param:radiusX");
      g.wire("badge.in:aux:Radius", "disc:param:radiusY");
      g.wire("badge.in:aux:Color", "tint:param:color");
      g.wire("disc:out", "tint:in:path");
      g.wire("tint:out", "badge.out:in:image");
      g.out(L, "badge:aux:image");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 640, y: 360, want: [51, 204, 102, 255], tol: 2, label: "the badge: its Color input" },
        { frame: 0, x: 720, y: 360, want: [51, 204, 102, 255], tol: 2, label: "inside its Radius input (90 px)" },
        { frame: 0, x: 740, y: 360, want: [null, null, null, 0], label: "outside it" },
      ],
    },
  }
);

// --- Q (M4 text lane): text animators, text on a path, keyed documents ------------------
SCENE_FIXTURES.push(
  {
    // Type On (a Range Selector), position by word from the centre (a base
    // animator), scale 0 → 1 with an overshooting ease (an Expression
    // Selector carrying the overshoot), random-order rotation (an Expression
    // Selector), a uniform colour sweep (Amount keys).
    name: "q-text-animators",
    title: "Q text animators",
    comp,
    build(g) {
      const L = g.layer("LQ0", "Typed");
      const sweep = track([[0, 0], [30, 1]]);
      g.node(
        L,
        "typed",
        "text",
        {
          text: "Hello AE",
          font_family: "Arial",
          font_size: 96,
          alignment: "center",
          anim_typeon_enabled: true,
          anim_position_enabled: true,
          anim_position_driver: "cascade",
          anim_position_direction: "center",
          anim_position_by: "word",
          anim_position_minX: 0,
          anim_position_maxX: 0,
          anim_position_minY: 40,
          anim_position_maxY: 0,
          anim_scale_enabled: true,
          anim_scale_driver: "cascade",
          anim_scale_easing: "ease-out-back",
          anim_scale_min: 0,
          anim_scale_max: 1,
          anim_rotation_enabled: true,
          anim_rotation_driver: "cascade",
          anim_rotation_direction: "random",
          anim_rotation_seed: 3,
          anim_rotation_min: -30,
          anim_rotation_max: 0,
          anim_color_enabled: true,
          anim_color_driver: "uniform",
          anim_color_min: "#ff3300",
          anim_color_max: "#ffffff",
        },
        { anim_typeon_amount: sweep, anim_position_amount: sweep, anim_scale_amount: sweep, anim_rotation_amount: sweep, anim_color_amount: track([[10, 0], [40, 1]]) }
      );
      g.out(L, "typed:out");
    },
    probe: { frames: [0], pixels: [{ frame: 0, x: 640, y: 360, want: [null, null, null, 0], label: "frame 0: nothing typed on yet" }] },
  },
  {
    // Text on an arc: starts 10 % → 30 % along it (First Margin keys), a
    // half em above the path (baseline shift).
    name: "q-text-path",
    title: "Q text path",
    comp,
    build(g) {
      const L = g.layer("LQ1", "On an arc");
      g.node(L, "arc", "arc", { centerX: 0.5, centerY: cy(W, H, 560), radius: 380 / W, startAngle: 210, endAngle: 330, mode: "open", stroke_enabled: false });
      g.node(L, "label", "text", { text: "Along the arc", font_family: "Arial", font_size: 64, path_align: "start", path_side: "above" }, { path_offset: track([[0, 0.1], [40, 0.3]]) });
      g.wire("arc:out", "label:in:path");
      g.out(L, "label:out");
    },
    probe: { frames: [0], pixels: [{ frame: 0, x: 640, y: 700, want: [null, null, null, 0], label: "below the arc: no text" }] },
  },
  {
    // A keyed font size (Source Text hold keys per frame), keyed fill and
    // stroke colours (Fill / Stroke Color animators) and letter spacing past
    // AE's ±1000 tracking (the rest as a px Tracking animator).
    name: "q-text-doc",
    title: "Q text doc",
    comp,
    build(g) {
      const L = g.layer("LQ2", "Keyed doc");
      g.node(
        L,
        "doc",
        "text",
        { text: "Size", font_family: "Arial", font_size: 80, letter_spacing: 140, strokeEnabled: true, strokeWidth: 4, strokeColor: "#000000" },
        { font_size: track([[0, 80], [20, 120]]), color: track([[0, "#ff0000"], [30, "#0000ff"]]), strokeColor: track([[0, "#000000"], [30, "#ffffff"]]) }
      );
      g.out(L, "doc:out");
    },
    probe: { frames: [0], pixels: [{ frame: 0, x: 40, y: 40, want: [null, null, null, 0], label: "corner: no text" }] },
  }
);
// --- T: native 3-D scenes (M4 lane 5) -------------------------------------------------------------
// A GLB under a keyed Transform 3D, a keyed camera, three lights; an
// orthographic camera over a solid background; and scenes that still bake.
const T_MODEL = { url: "blob:fixture/axes.glb", filename: "axes.glb", size: 3812, format: "glb" };
const tModels = () => ({ model: () => writeGlb(axesModel(), { baseColor: [1, 1, 1], metallic: 0, roughness: 1 }, "axes") });
SCENE_FIXTURES.push({
  name: "t-scene3d",
  title: "T scene 3D",
  comp,
  models: tModels(),
  build(g) {
    const L = g.layer("LT", "3D scene");
    g.node(L, "model", "import-3d", { model: T_MODEL, object: "", rot_y: 20, scale_x: 0.8, scale_y: 0.8, scale_z: 0.8 });
    g.node(L, "spin", "transform-3d", { pos_y: 0.2 }, { rot_y: track([[0, 0, "easeInOutCubic"], [60, 90]]) });
    g.node(L, "cam", "camera-3d", { fov: 35, pos_x: 3, pos_y: 2, pos_z: 4 }, { pos_x: track([[0, 3], [60, -3]]), pos_z: track([[0, 4], [30, 5, "easeOutQuad"], [60, 4]]) });
    g.node(L, "key", "light-3d", { type: "directional", intensity: 2, color: "#ffffff", pos_x: 3, pos_y: 5, pos_z: 2 });
    g.node(L, "fill", "light-3d", { type: "point", intensity: 6, color: "#88aaff", pos_x: -2, pos_y: 1, pos_z: 2 });
    g.node(L, "amb", "light-3d", { type: "ambient", intensity: 0.5 });
    g.node(L, "scene", "scene-render", { background: "transparent" });
    g.wire("model:out", "spin:in:source");
    g.wire("spin:out", "scene:in:object:1");
    g.wire("key:out", "scene:in:object:2");
    g.wire("fill:out", "scene:in:object:3");
    g.wire("amb:out", "scene:in:object:4");
    g.wire("cam:out", "scene:in:camera");
    g.out(L, "scene:out");
  },
  probe: {
    frames: [0, 30],
    pixels: [
      { frame: 0, x: 640, y: 360, want: [null, null, null, 255], label: "the model covers the comp centre (the camera aims at the origin)" },
      { frame: 0, x: 8, y: 8, want: [null, null, null, 0], label: "transparent background" },
      { frame: 30, x: 640, y: 360, want: [null, null, null, 255], label: "frame 30: still centred" },
    ],
  },
});

SCENE_FIXTURES.push({
  name: "t-scene3d-ortho",
  title: "T ortho",
  comp,
  models: tModels(),
  build(g) {
    const L = g.layer("LT2", "Ortho scene");
    g.node(L, "model", "import-3d", { model: T_MODEL, object: "" });
    g.node(L, "cam", "camera-3d", { projection: "orthographic", ortho_height: 3, pos_x: 2.4, pos_y: 1.8, pos_z: 2.4 });
    g.node(L, "spot", "light-3d", { type: "spot", intensity: 20, pos_x: 0, pos_y: 3, pos_z: 3, angle: 25, penumbra: 0.4 });
    g.node(L, "scene", "scene-render", { background: "solid", bg_color: "#202830" });
    g.wire("model:out", "scene:in:object:1");
    g.wire("spot:out", "scene:in:object:2");
    g.wire("cam:out", "scene:in:camera");
    g.out(L, "scene:out");
  },
  probe: {
    frames: [0],
    pixels: [
      { frame: 0, x: 8, y: 8, want: [32, 40, 48, 255], tol: 3, label: "the solid background (#202830)" },
      { frame: 0, x: 640, y: 360, want: [null, null, null, 255], label: "the model at the centre" },
    ],
  },
});

SCENE_FIXTURES.push({
  name: "t-scene3d-bakes",
  title: "T bakes",
  comp,
  models: tModels(),
  build(g) {
    // Fog: no AE form → the whole scene bakes.
    const A = g.layer("LT3", "Foggy");
    g.node(A, "model", "import-3d", { model: T_MODEL, object: "" });
    g.node(A, "scene", "scene-render", { fog: "linear" });
    g.wire("model:out", "scene:in:object:1");
    g.out(A, "scene:out");
    // A primitive mesh: three.js geometry with no AE form.
    const B = g.layer("LT4", "Primitive");
    g.node(B, "box", "cube-3d", {});
    g.node(B, "scene2", "scene-render", {});
    g.wire("box:out", "scene2:in:object:1");
    g.out(B, "scene2:out");
    // One object picked out of a file: AE imports the whole file.
    const C = g.layer("LT5", "Picked");
    g.node(C, "pick", "import-3d", { model: T_MODEL, object: "top:1" });
    g.node(C, "scene3", "scene-render", {});
    g.wire("pick:out", "scene3:in:object:1");
    g.out(C, "scene3:out");
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

// --- instances lane (M4): per-copy values, picks, order, time, Repeaters (r-) ----------
// The live round trip of these is instances-roundtrip.mts next to this file:
// it reads every copy's transform, colour and order back from After Effects.
const rDot = (g: GraphBuilder, L: string, id: string, color = "#ffffff", r = 0.02) =>
  g.node(L, id, "circle", { radiusX: r, radiusY: r, stroke_enabled: false, fill_enabled: true, fill_color: color });
const rBox = (g: GraphBuilder, L: string, id: string, color = "#ffffff", s = 0.04, extra: Record<string, unknown> = {}) =>
  g.node(L, id, "rectangle", { width: s, height: s * 0.6, stroke_enabled: false, fill_enabled: true, fill_color: color, ...extra });
const rCopy = (g: GraphBuilder, L: string, id: string, points: string, instance: string, params: Record<string, unknown> = {}, animation?: Record<string, unknown>) => {
  g.node(L, id, "copy-to-points", { mode: "image", anchor: "content center", ...params }, animation);
  g.wire(points, `${id}:in:points`);
  g.wire(instance, `${id}:in:instance`);
  g.out(L, `${id}:out`);
};

// A static horizontal ramp R = G = B = x (the editor's readback stands in).
export function rRampPixels(_ep: string, w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = Math.round((255 * (x + 0.5)) / w);
      px[o] = px[o + 1] = px[o + 2] = v;
      px[o + 3] = 255;
    }
  return px;
}

SCENE_FIXTURES.push(
  {
    name: "r-tint-opacity",
    title: "R tint opacity",
    comp,
    build(g) {
      // White dots tinted by a random colour, faded along the index → a Fill
      // effect (white × tint) and layer opacity per copy.
      const A = g.layer("LR0", "Tinted dots");
      rDot(g, A, "dot", "#ffffff", 0.03);
      g.node(A, "pts", "grid", { countX: 4, countY: 2, width: 0.6, height: 0.2, y: cy(W, H, 220) });
      g.node(A, "hue", "set-named-attribute", { attr_name: "tint", kind: "color", source: "random", seed: 7 });
      g.node(A, "fade", "set-named-attribute", { attr_name: "alpha", kind: "float", source: "index", lo: 0.3, hi: 1 });
      g.wire("pts:out", "hue:in:points");
      g.wire("hue:out", "fade:in:points");
      rCopy(g, A, "copy", "fade:out", "dot:aux:image", { tint_attr: "tint", opacity_attr: "alpha" });
      // A two-colour instance (orange box, white outline) → a Channel Mixer.
      const B = g.layer("LR1", "Tinted boxes");
      rBox(g, B, "box", "#ff8000", 0.06, { stroke_enabled: true, stroke_color: "#ffffff", stroke_thickness: 6 });
      g.node(B, "row", "grid", { countX: 3, countY: 1, width: 0.5, height: 0, y: cy(W, H, 540) });
      g.node(B, "hue2", "set-named-attribute", { attr_name: "tint", kind: "color", source: "random", seed: 11 });
      g.wire("row:out", "hue2:in:points");
      rCopy(g, B, "copy2", "hue2:out", "box:aux:image", { tint_attr: "tint" });
    },
  },
  {
    name: "r-picks",
    title: "R picks",
    comp,
    build(g) {
      // Three variants (Combine a, b, c) picked per point.
      const shapes = (L: string, p: string) => {
        rDot(g, L, `${p}red`, "#ff0000", 0.025);
        rBox(g, L, `${p}green`, "#00ff00", 0.05);
        g.node(L, `${p}blue`, "star", { points: 5, outerRadius: 0.03, innerRadius: 0.013, stroke_enabled: false, fill_enabled: true, fill_color: "#0000ff" });
        g.node(L, `${p}set`, "collect", { mode: "image", slots: ["a", "b", "c", "d"] });
        g.wire(`${p}red:aux:image`, `${p}set:in:a`);
        g.wire(`${p}green:aux:image`, `${p}set:in:b`);
        g.wire(`${p}blue:aux:image`, `${p}set:in:c`);
      };
      const A = g.layer("LR2", "Random picks");
      shapes(A, "a_");
      g.node(A, "a_pts", "grid", { countX: 5, countY: 2, width: 0.7, height: 0.12, y: cy(W, H, 150) });
      rCopy(g, A, "pick_rand", "a_pts:out", "a_set:out", { pick_mode: "random", pick_seed: 3, draw_order: "shuffled" });
      const B = g.layer("LR3", "Cycled by y");
      shapes(B, "b_");
      g.node(B, "b_pts", "scatter-points", { count: 9, seed: 4 });
      rCopy(g, B, "pick_cycle", "b_pts:out", "b_set:out", { pick_mode: "cycle", draw_order: "by y" });
      const C = g.layer("LR4", "Attribute picks");
      shapes(C, "c_");
      g.node(C, "c_pts", "grid", { countX: 6, countY: 1, width: 0.7, height: 0, y: cy(W, H, 600) });
      g.node(C, "c_w", "set-named-attribute", { attr_name: "which", kind: "float", source: "random", seed: 5 });
      g.wire("c_pts:out", "c_w:in:points");
      rCopy(g, C, "pick_attr", "c_w:out", "c_set:out", { pick_mode: "attribute", pick_attr: "which" });
      const D = g.layer("LR5", "Every variant");
      shapes(D, "d_");
      g.node(D, "d_pts", "grid", { countX: 2, countY: 1, width: 0.2, height: 0, y: cy(W, H, 400) });
      rCopy(g, D, "pick_all", "d_pts:out", "d_set:out", { pick_mode: "all" });
    },
  },
  {
    name: "r-keyed",
    title: "R keyed",
    comp,
    build(g) {
      // Keyed scale × / rotate + over static points → per-copy keys with the
      // authored eases (one Scale / Rotation track per copy).
      const A = g.layer("LR6", "Keyed modulation");
      rBox(g, A, "box", "#ffcc00", 0.06);
      g.node(A, "pts", "grid", { countX: 3, countY: 2, width: 0.5, height: 0.25 });
      g.node(A, "tilt", "set-named-attribute", { attr_name: "rotation", kind: "float", source: "index", lo: 0, hi: 0.5 });
      g.wire("pts:out", "tilt:in:points");
      rCopy(g, A, "copy", "tilt:out", "box:aux:image", {}, {
        scale_mul_default: track([[0, 0.4, "easeOutBack"], [30, 1.2, "linear"]]),
        rotate_add_default: track([[0, 0, "easeInOutCubic"], [40, 1.5, "linear"]]),
      });
    },
  },
  {
    name: "r-stagger",
    title: "R stagger",
    comp,
    build(g) {
      // Stagger phase → per-point scale and spin (Modulate Points) → copies
      // keyed every frame, linear stretches merged.
      const A = g.layer("LR7", "Staggered");
      rBox(g, A, "box", "#33ccff", 0.07);
      g.node(A, "pts", "grid", { countX: 6, countY: 1, width: 0.75, height: 0, y: cy(W, H, 260) });
      g.node(A, "lag", "stagger", { unit: "frames", mode: "spacing", spacing: 5, duration: 12 });
      g.node(A, "grow", "modulate-points", { scale_attr: "phase", rotate_attr: "phase", rotate_attr_amount: Math.PI / 2 });
      g.wire("pts:out", "lag:in:points");
      g.wire("lag:out", "grow:in:points");
      rCopy(g, A, "copy", "grow:out", "box:aux:image");
      // Points that move (a timed Point Expression) → per-copy position keys.
      const B = g.layer("LR8", "Bobbing");
      rDot(g, B, "dot", "#ff66aa", 0.02);
      g.node(B, "row", "grid", { countX: 5, countY: 1, width: 0.6, height: 0, y: cy(W, H, 520) });
      g.node(B, "bob", "point-expression", { expression: "y = py + 0.04 * Math.sin(t * Math.PI + index);" });
      g.wire("row:out", "bob:in:points");
      rCopy(g, B, "copy2", "bob:out", "dot:aux:image");
    },
  },
  {
    name: "r-switch",
    title: "R switch",
    comp,
    build(g) {
      // A pick that changes over time (attribute = a Stagger phase): one
      // layer per variant a point uses, HOLD opacity keys.
      const A = g.layer("LR9", "Switching");
      rDot(g, A, "off", "#666666", 0.025);
      rBox(g, A, "on", "#ffffff", 0.05);
      g.node(A, "set", "collect", { mode: "image", slots: ["a", "b", "c"] });
      g.wire("off:aux:image", "set:in:a");
      g.wire("on:aux:image", "set:in:b");
      g.node(A, "pts", "grid", { countX: 4, countY: 1, width: 0.6, height: 0 });
      g.node(A, "lag", "stagger", { unit: "frames", mode: "spacing", spacing: 8, duration: 1 });
      g.wire("pts:out", "lag:in:points");
      rCopy(g, A, "copy", "lag:out", "set:out", { pick_mode: "attribute", pick_attr: "phase" });
    },
  },
  {
    name: "r-ramp",
    title: "R ramp",
    comp,
    build(g) {
      // Opacity exactly linear along the index → Repeater Start / End Opacity.
      const A = g.layer("LR10", "Ramp row");
      rBox(g, A, "box", "#ffffff", 0.05);
      g.node(A, "pts", "grid", { countX: 5, countY: 1, width: 0.6, height: 0, y: cy(W, H, 200) });
      g.node(A, "fade", "set-named-attribute", { attr_name: "alpha", kind: "float", source: "index", lo: 0.2, hi: 1 });
      g.wire("pts:out", "fade:in:points");
      rCopy(g, A, "copy", "fade:out", "box:aux:image", { opacity_attr: "alpha" });
      // Separable in 2-D: (0.4 + 0.3·col)·(0.5 + 0.25·row) on a 3×3 grid.
      const B = g.layer("LR11", "Ramp grid");
      rDot(g, B, "dot", "#ffffff", 0.025);
      g.node(B, "pts2", "grid", { countX: 3, countY: 3, width: 0.3, height: 0.3, y: cy(W, H, 520) });
      g.node(B, "fade2", "point-expression", { expression: 'setattr("alpha", (0.4 + 0.3 * (index % 3)) * (0.5 + 0.25 * Math.floor(index / 3)));' });
      g.wire("pts2:out", "fade2:in:points");
      rCopy(g, B, "copy2", "fade2:out", "dot:aux:image", { opacity_attr: "alpha" });
    },
  },
  {
    name: "r-array",
    title: "R array",
    comp,
    build(g) {
      // Array (spline mode) of a star → Repeaters around the star's path.
      const A = g.layer("LR12", "Spline array");
      g.node(A, "st", "star", { centerX: 0.5, centerY: 0.5, points: 5, outerRadius: 0.04, innerRadius: 0.018, stroke_enabled: false, fill_enabled: false });
      g.node(A, "arr", "array", { mode: "spline", countX: 4, countY: 2, sizeMode: "step", sizeW: 0.12, sizeH: 0.12, patternOffsetX: 0.2, patternOffsetY: 0.3, localRotate: 20, localScaleX: 0.8, localScaleY: 0.8 });
      g.node(A, "ink", "spline-fill", { color: "#ffaa00" });
      g.wire("st:out", "arr:in:instance");
      g.wire("arr:out", "ink:in:path");
      g.out(A, "ink:out");
      // Array (point mode) of one point → Copy to Points: a rotated lattice of
      // boxes → Repeaters on the box's shape layer.
      const B = g.layer("LR13", "Point array");
      rBox(g, B, "box", "#66ff66", 0.05);
      g.node(B, "one", "point", { x: 0.5, y: 0.5 });
      g.node(B, "arr2", "array", { mode: "point", countX: 3, countY: 2, sizeMode: "step", sizeW: 0.1, sizeH: 0.08, patternOffsetX: 0.55, patternOffsetY: 0.3, localRotate: 30, localScaleX: 0.8, localScaleY: 0.8 });
      g.wire("one:out", "arr2:in:instance");
      rCopy(g, B, "copy", "arr2:out", "box:aux:image");
      // A rotated lattice (Point Expression) of a spline triangle, spline mode.
      const C = g.layer("LR14", "Rotated lattice");
      g.node(C, "tri", "polygon", { centerX: 0.5, centerY: 0.5, sides: 3, radius: 0.02, stroke_enabled: false, fill_enabled: false });
      g.node(C, "pts", "grid", { countX: 4, countY: 3, width: 0.24, height: 0.12, x: 0.3, y: cy(W, H, 520) });
      g.node(C, "turn", "point-expression", { expression: "x = 0.3 + (px - 0.3) * Math.cos(0.4) - (py - " + cy(W, H, 520) + ") * Math.sin(0.4); y = " + cy(W, H, 520) + " + (px - 0.3) * Math.sin(0.4) + (py - " + cy(W, H, 520) + ") * Math.cos(0.4);" });
      g.node(C, "copies", "copy-to-points", { mode: "spline", anchor: "content center" });
      g.node(C, "ink2", "spline-fill", { color: "#cc88ff" });
      g.wire("pts:out", "turn:in:points");
      g.wire("turn:out", "copies:in:points");
      g.wire("tri:out", "copies:in:instance");
      g.wire("copies:out", "ink2:in:path");
      g.out(C, "ink2:out");
    },
  },
  {
    name: "r-field",
    title: "R field",
    comp,
    build(g) {
      // Static fields sampled per copy at export: scale from a ramp's R
      // (0.5×…1.5×), rotation from the same (±π/4).
      const A = g.layer("LR15", "Field copies");
      rBox(g, A, "box", "#ffffff", 0.05);
      g.node(A, "ramp", "gradient", { mode: "linear", start_x: 0, start_y: 0.5, end_x: 1, end_y: 0.5, color_a: "#000000", color_b: "#ffffff" });
      g.node(A, "pts", "grid", { countX: 5, countY: 2, width: 0.7, height: 0.25 });
      rCopy(g, A, "copy", "pts:out", "box:aux:image", { rotate_field_amount: Math.PI / 4 });
      g.wire("ramp:out", "copy:in:scale_field");
      g.wire("ramp:out", "copy:in:rotate_field");
      // Spline mode: the node's own CPU sampler (≤ 256 px luminance) runs on
      // the same readback → static paths.
      const B = g.layer("LR16", "Field paths");
      g.node(B, "tri", "polygon", { centerX: 0.5, centerY: 0.5, sides: 3, radius: 0.025, stroke_enabled: false, fill_enabled: false });
      g.node(B, "ramp2", "gradient", { mode: "linear", start_x: 0, start_y: 0.5, end_x: 1, end_y: 0.5, color_a: "#000000", color_b: "#ffffff" });
      g.node(B, "row", "grid", { countX: 6, countY: 1, width: 0.8, height: 0, y: cy(W, H, 600) });
      g.node(B, "sized", "copy-to-points", { mode: "spline", anchor: "content center", scale_field_lo: 0.5, scale_field_hi: 2 });
      g.node(B, "ink", "spline-fill", { color: "#88ccff" });
      g.wire("row:out", "sized:in:points");
      g.wire("tri:out", "sized:in:instance");
      g.wire("ramp2:out", "sized:in:scale_field");
      g.wire("sized:out", "ink:in:path");
      g.out(B, "ink:out");
    },
    opts: { fieldPixels: rRampPixels },
  }
);
