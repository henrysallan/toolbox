// M4 lane 4 (SDF hard chains → shape layers) scene fixtures, `s-` prefixed.
// fixtures.mts appends them to SCENE_FIXTURES, so every scene gate (and the
// headless round trip) runs them; scripts/ae-export-spike/calibrate/sdf.mts
// renders each one in toolbox and in After Effects and compares the pixels.
//
// One toolbox layer each, so a layer's AE render IS that fixture's compare.
// Geometry is authored in pixels and converted to SDF space, which is Y-UP
// and width-relative: x = X/W, y = 0.5 − (Y − H/2)/W, lengths /W.
//
// Runtime imports from fixtures.mts are avoided (it imports this module).

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { GraphBuilder, SceneFixture } from "./fixtures.mts";

const W = 1280;
const H = 720;
const comp = { width: W, height: H, fps: 30, frames: 30 };
const sx = (X: number) => X / W;
const sy = (Y: number) => 0.5 - (Y - H / 2) / W;
const len = (px: number) => px / W;

function track(keys: [number, unknown, string?][]): any {
  return { animated: true, trackVisible: true, keyframes: keys.map(([f, v, e]) => ({ tick: f * 1000, value: v, easingOut: e ?? "linear" })) };
}

const circle = (g: GraphBuilder, L: string, id: string, X: number, Y: number, R: number, extra: Record<string, unknown> = {}) =>
  g.node(L, id, "sdf-circle", { x: sx(X), y: sy(Y), radius: len(R), ...extra });
const rect = (g: GraphBuilder, L: string, id: string, X: number, Y: number, w: number, h: number, corner = 0) =>
  g.node(L, id, "sdf-rectangle", { x: sx(X), y: sy(Y), width: len(w), height: len(h), corner_radius: len(corner) });

export const SDF_SCENE_FIXTURES: SceneFixture[] = [
  // Booleans: (circle ∪ rounded rect) − hexagon, a red contour, on a dark
  // background → Merge Paths Add, then Subtract; Stroke + Fill + a comp Rect.
  {
    name: "s-boolean",
    title: "S boolean",
    comp,
    build(g) {
      const L = g.layer("LS0", "Boolean");
      circle(g, L, "disc", 520, 360, 160);
      rect(g, L, "slab", 760, 360, 360, 200, 40);
      g.node(L, "hex", "sdf-polygon", { x: sx(600), y: sy(360), radius: len(90), sides: 6 });
      g.node(L, "both", "sdf-union");
      g.node(L, "cut", "sdf-subtraction");
      g.node(L, "ras", "sdf-rasterize", { foreground: "#ffcc00", background: "#101820", contour: "#ff0000", contour_alpha: 1, contour_width: 3 });
      g.wire("disc:out", "both:in:a");
      g.wire("slab:out", "both:in:b");
      g.wire("both:out", "cut:in:a");
      g.wire("hex:out", "cut:in:b");
      g.wire("cut:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 420, y: 360, want: [255, 204, 0, 255], tol: 3, label: "inside the disc: foreground" },
        { frame: 0, x: 600, y: 360, want: [16, 24, 32, 255], tol: 3, label: "the hexagon is subtracted (Merge Paths Subtract keeps the first operand)" },
        { frame: 0, x: 880, y: 360, want: [255, 204, 0, 255], tol: 3, label: "inside the slab: foreground" },
        { frame: 0, x: 1100, y: 600, want: [16, 24, 32, 255], tol: 3, label: "outside: background" },
        { frame: 0, x: 360, y: 360, want: [255, 0, 0, 255], tol: 40, label: "the disc's left edge carries the contour" },
      ],
    },
  },
  // Edge softness 3 px: past AE's own anti-aliasing, so the fill gets a
  // Gaussian Blur 2 and the background its own layer underneath.
  {
    name: "s-soft",
    title: "S soft",
    comp,
    build(g) {
      const L = g.layer("LS9", "Soft");
      circle(g, L, "dome", 520, 360, 150);
      rect(g, L, "plate", 760, 400, 320, 160, 30);
      g.node(L, "both", "sdf-union");
      g.node(L, "ras", "sdf-rasterize", { foreground: "#ffffff", background: "#000000", softness: 3 });
      g.wire("dome:out", "both:in:a");
      g.wire("plate:out", "both:in:b");
      g.wire("both:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 520, y: 360, want: [255, 255, 255, 255], tol: 3, label: "inside: white" },
        { frame: 0, x: 1000, y: 600, want: [0, 0, 0, 255], tol: 3, label: "outside: black" },
        { frame: 0, x: 370, y: 360, want: [128, 128, 128, 255], tol: 40, label: "on the edge: grey (the blurred fill over the opaque background)" },
      ],
    },
  },
  // Offsets: round(star) (Offset Paths, Round join), onion(circle) (a ring:
  // offset out minus offset in), a capsule, round(triangle) → to-mask.
  {
    name: "s-offsets",
    title: "S offsets",
    comp,
    build(g) {
      const L = g.layer("LS1", "Offsets");
      g.node(L, "star", "sdf-star", { x: sx(240), y: sy(360), radius: len(150), points: 5, sharpness: 2.5 });
      g.node(L, "soft", "sdf-round", { radius: len(16) });
      circle(g, L, "ringc", 560, 360, 110);
      g.node(L, "ring", "sdf-onion", { thickness: len(20) });
      g.node(L, "bar", "sdf-line-segment", { ax: sx(760), ay: sy(200), bx: sx(960), by: sy(520), thickness: len(28) });
      g.node(L, "tri", "sdf-triangle", { ax: sx(1130), ay: sy(220), bx: sx(1010), by: sy(500), cx: sx(1240), cy: sy(500) });
      g.node(L, "tround", "sdf-round", { radius: len(12) });
      g.node(L, "all", "sdf-union", { slots: ["a", "b", "c", "d", "e"] });
      g.node(L, "mask", "sdf-to-mask");
      g.wire("star:out", "soft:in:sdf");
      g.wire("ringc:out", "ring:in:sdf");
      g.wire("tri:out", "tround:in:sdf");
      g.wire("soft:out", "all:in:a");
      g.wire("ring:out", "all:in:b");
      g.wire("bar:out", "all:in:c");
      g.wire("tround:out", "all:in:d");
      g.wire("all:out", "mask:in:sdf");
      g.out(L, "mask:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 240, y: 360, want: [255, 255, 255, 255], tol: 3, label: "star centre: white" },
        { frame: 0, x: 560, y: 360, want: [0, 0, 0, 255], tol: 3, label: "inside the ring: black (onion = out − in)" },
        { frame: 0, x: 560, y: 250, want: [255, 255, 255, 255], tol: 3, label: "on the ring (r 110 ± 20): white" },
        { frame: 0, x: 860, y: 360, want: [255, 255, 255, 255], tol: 3, label: "the capsule's middle: white" },
        { frame: 0, x: 1130, y: 420, want: [255, 255, 255, 255], tol: 3, label: "the rounded triangle: white" },
        { frame: 0, x: 700, y: 650, want: [0, 0, 0, 255], tol: 3, label: "outside: black" },
      ],
    },
  },
  // Offset signs: a grown polygon stays sharp (polySdf is an edge-line
  // distance), an eroded star rounds its inner corners and keeps sharp tips,
  // an eroded triangle shrinks sharp, an eroded rounded rect loses its
  // corner radius (max(r − δ, 0)).
  {
    name: "s-erode",
    title: "S erode",
    comp,
    build(g) {
      const L = g.layer("LS10", "Erode");
      g.node(L, "hex", "sdf-polygon", { x: sx(200), y: sy(360), radius: len(110), sides: 6 });
      g.node(L, "grow", "sdf-round", { radius: len(20) });
      g.node(L, "star", "sdf-star", { x: sx(520), y: sy(360), radius: len(170), points: 6, sharpness: 3 });
      g.node(L, "thin", "sdf-round", { radius: len(-14) });
      g.node(L, "tri", "sdf-triangle", { ax: sx(820), ay: sy(180), bx: sx(700), by: sy(540), cx: sx(960), cy: sy(540) });
      g.node(L, "tthin", "sdf-round", { radius: len(-12) });
      rect(g, L, "box", 1130, 360, 200, 260, 12);
      g.node(L, "bthin", "sdf-round", { radius: len(-20) });
      g.node(L, "all", "sdf-union", { slots: ["a", "b", "c", "d", "e"] });
      g.node(L, "ras", "sdf-rasterize");
      g.wire("hex:out", "grow:in:sdf");
      g.wire("star:out", "thin:in:sdf");
      g.wire("tri:out", "tthin:in:sdf");
      g.wire("box:out", "bthin:in:sdf");
      g.wire("grow:out", "all:in:a");
      g.wire("thin:out", "all:in:b");
      g.wire("tthin:out", "all:in:c");
      g.wire("bthin:out", "all:in:d");
      g.wire("all:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 200, y: 360, want: [255, 255, 255, 255], tol: 3, label: "grown hexagon centre" },
        { frame: 0, x: 200, y: 232, want: [255, 255, 255, 255], tol: 3, label: "grown hexagon: its top vertex moved out to 110 + 20/cos 30° ≈ 133 px (128 px up is inside)" },
        { frame: 0, x: 520, y: 360, want: [255, 255, 255, 255], tol: 3, label: "eroded star centre" },
        { frame: 0, x: 820, y: 420, want: [255, 255, 255, 255], tol: 3, label: "eroded triangle" },
        { frame: 0, x: 1130, y: 360, want: [255, 255, 255, 255], tol: 3, label: "eroded box" },
        { frame: 0, x: 1040, y: 360, want: [0, 0, 0, 255], tol: 3, label: "the box shrank 20 px per side (its edge was x 1030)" },
      ],
    },
  },
  // Domain transforms: rotate(30°) → rect, scale(1.6, 0.6) → circle,
  // translate → polygon: group transforms (SDF space is Y-up: −30° in AE).
  {
    name: "s-chain",
    title: "S chain",
    comp,
    build(g) {
      const L = g.layer("LS2", "Chain");
      g.node(L, "turn", "sdf-rotate", { rotation: 30, cx: sx(300), cy: sy(360) });
      rect(g, L, "plank", 300, 360, 320, 80);
      g.node(L, "squash", "sdf-scale", { sx: 1.6, sy: 0.6, cx: sx(700), cy: sy(360) });
      circle(g, L, "egg", 700, 360, 100);
      g.node(L, "shift", "sdf-translate", { tx: len(120), ty: len(-150) });
      g.node(L, "pent", "sdf-polygon", { x: sx(900), y: sy(360), radius: len(90), sides: 5 });
      g.node(L, "all", "sdf-union", { slots: ["a", "b", "c", "d"] });
      g.node(L, "ras", "sdf-rasterize", { foreground: "#ffffff", background: "#000000" });
      g.wire("turn:out", "plank:in:position");
      g.wire("squash:out", "egg:in:position");
      g.wire("shift:out", "pent:in:position");
      g.wire("plank:out", "all:in:a");
      g.wire("egg:out", "all:in:b");
      g.wire("pent:out", "all:in:c");
      g.wire("all:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0],
      pixels: [
        // The plank turned 30° counter-clockwise (Y-up): its right end rises.
        { frame: 0, x: 420, y: 290, want: [255, 255, 255, 255], tol: 3, label: "rotated plank: right end up-right (CCW on screen)" },
        { frame: 0, x: 420, y: 430, want: [0, 0, 0, 255], tol: 3, label: "…not down-right" },
        { frame: 0, x: 850, y: 360, want: [255, 255, 255, 255], tol: 3, label: "the circle stretched 1.6× wide reaches x 850" },
        { frame: 0, x: 700, y: 440, want: [0, 0, 0, 255], tol: 3, label: "…and 0.6× tall stops short of y 440" },
        { frame: 0, x: 1020, y: 510, want: [255, 255, 255, 255], tol: 3, label: "the pentagon moved +120 px right and 150 px down (ty −150 in Y-up)" },
      ],
    },
  },
  // Folds: mirror x of a disc crossing the fold (kept half + reflection),
  // a bounded 2 × 1 repeat of a fitting disc (Repeaters), polar ×6 of a bar
  // that crosses its wedge (clipped copies).
  {
    name: "s-folds",
    title: "S folds",
    comp,
    build(g) {
      const L = g.layer("LS3", "Folds");
      g.node(L, "mir", "sdf-mirror", { axis: "x", center_x: sx(240), center_y: sy(360) });
      circle(g, L, "lens", 300, 360, 100);
      g.node(L, "rep", "sdf-repeat", { spacing_x: len(120), spacing_y: len(120), center_x: sx(560), center_y: sy(360), bounded: true, limit_x: 1, limit_y: 0 });
      circle(g, L, "dot", 560, 360, 40);
      g.node(L, "pol", "sdf-polar", { segments: 6, center_x: sx(1000), center_y: sy(360), rotation: 0 });
      rect(g, L, "spoke", 1100, 360, 180, 60);
      g.node(L, "all", "sdf-union", { slots: ["a", "b", "c", "d"] });
      g.node(L, "ras", "sdf-rasterize");
      g.wire("mir:out", "lens:in:position");
      g.wire("rep:out", "dot:in:position");
      g.wire("pol:out", "spoke:in:position");
      g.wire("lens:out", "all:in:a");
      g.wire("dot:out", "all:in:b");
      g.wire("spoke:out", "all:in:c");
      g.wire("all:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 180, y: 360, want: [255, 255, 255, 255], tol: 3, label: "mirror: the reflection of the kept half (x 180)" },
        { frame: 0, x: 395, y: 360, want: [255, 255, 255, 255], tol: 3, label: "mirror: the kept half reaches x 400" },
        { frame: 0, x: 70, y: 360, want: [0, 0, 0, 255], tol: 3, label: "…and its reflection stops at x 80 (the discarded half is gone)" },
        { frame: 0, x: 440, y: 360, want: [255, 255, 255, 255], tol: 3, label: "repeat: copy −1 at x 440" },
        { frame: 0, x: 680, y: 360, want: [255, 255, 255, 255], tol: 3, label: "repeat: copy +1 at x 680" },
        { frame: 0, x: 800, y: 360, want: [0, 0, 0, 255], tol: 3, label: "repeat: bounded — no copy +2 at x 800" },
        // Copies every 60° counter-clockwise (Y-up): 100 px out at 120° is (950, 273).
        { frame: 0, x: 950, y: 273, want: [255, 255, 255, 255], tol: 3, label: "polar: the copy at 120°" },
        { frame: 0, x: 1000, y: 260, want: [0, 0, 0, 255], tol: 3, label: "polar: nothing at 90° (between copies)" },
        { frame: 0, x: 1000, y: 360, want: [0, 0, 0, 255], tol: 3, label: "polar: the hub stays open (the spoke starts 10 px out)" },
      ],
    },
  },
  // An unbounded repeat whose disc overflows its cell: every copy is the
  // disc ∩ the cell (one clipped Repeater pair over the visible cells).
  {
    name: "s-tiles",
    title: "S tiles",
    comp,
    build(g) {
      const L = g.layer("LS4", "Tiles");
      g.node(L, "grid", "sdf-repeat", { spacing_x: len(160), spacing_y: len(160), center_x: sx(640), center_y: sy(360) });
      // Off-centre in its 160 px cell: its right side overflows the cell.
      circle(g, L, "blob", 680, 360, 70);
      g.node(L, "ras", "sdf-rasterize", { foreground: "#33ccff", background: "#000000" });
      g.wire("grid:out", "blob:in:position");
      g.wire("blob:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 680, y: 360, want: [51, 204, 255, 255], tol: 3, label: "the centre cell's disc" },
        { frame: 0, x: 715, y: 360, want: [51, 204, 255, 255], tol: 3, label: "…filled up to its cell edge at x 720" },
        { frame: 0, x: 735, y: 360, want: [0, 0, 0, 255], tol: 3, label: "the overflow past the cell edge is clipped (unclipped it reaches x 750)" },
        { frame: 0, x: 575, y: 360, want: [0, 0, 0, 255], tol: 3, label: "the left neighbour's overflow is clipped at x 560 too" },
        { frame: 0, x: 40, y: 40, want: [51, 204, 255, 255], tol: 3, label: "a far copy near the corner (centre 40, 40)" },
      ],
    },
  },
  // Keys: a keyed radius (easeOutCubic → exact AE keys on the Ellipse size)
  // and a keyed translate (exact keys on the group position).
  {
    name: "s-animated",
    title: "S animated",
    comp,
    build(g) {
      const L = g.layer("LS5", "Animated");
      g.node(L, "move", "sdf-translate", {}, { tx: track([[0, 0, "easeOutCubic"], [24, len(300), "linear"]]) });
      g.node(L, "pulse", "sdf-circle", { x: sx(400), y: sy(360) }, { radius: track([[0, len(60), "easeOutCubic"], [24, len(140), "linear"]]) });
      g.node(L, "ras", "sdf-rasterize", { foreground: "#ffffff", background: "#000000", bg_alpha: 0 });
      g.wire("move:out", "pulse:in:position");
      g.wire("pulse:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
    probe: {
      frames: [0, 24],
      pixels: [
        { frame: 0, x: 400, y: 360, want: [255, 255, 255, 255], tol: 3, label: "frame 0: the disc at x 400" },
        { frame: 0, x: 480, y: 360, want: [null, null, null, 0], label: "frame 0: radius 60 — empty at x 480 (bg_alpha 0)" },
        { frame: 24, x: 700, y: 360, want: [255, 255, 255, 255], tol: 3, label: "frame 24: moved 300 px" },
        { frame: 24, x: 830, y: 360, want: [255, 255, 255, 255], tol: 3, label: "frame 24: radius 140" },
      ],
    },
  },
  // sdf-to-spline as geometry: its tree's outline stroked, and as the mask
  // of a slab (an ALPHA matte from the Merge Paths outline).
  {
    name: "s-contour",
    title: "S contour",
    comp,
    build(g) {
      const L = g.layer("LS6", "Contour");
      circle(g, L, "a", 380, 360, 140);
      rect(g, L, "b", 560, 360, 300, 140);
      g.node(L, "u", "sdf-union");
      g.node(L, "trace", "sdf-to-spline", { resolution: 512 });
      g.node(L, "line", "spline-stroke", { color: "#ff3366", thickness: 6 });
      g.wire("a:out", "u:in:a");
      g.wire("b:out", "u:in:b");
      g.wire("u:out", "trace:in:sdf");
      g.wire("trace:out", "line:in:path");
      g.node(L, "c2", "sdf-circle", { x: sx(1000), y: sy(360), radius: len(120) });
      g.node(L, "trace2", "sdf-to-spline", { resolution: 512 });
      g.node(L, "slab", "rectangle", { originX: 1000 / W, originY: 0.5, width: 300 / W, height: 400 / W, stroke_enabled: false, fill_enabled: true, fill_color: "#ffffff" });
      g.node(L, "stack", "merge", { layers: [{ id: "m1", mode: "normal", opacity: 1 }] });
      g.wire("c2:out", "trace2:in:sdf");
      g.wire("line:out", "stack:in:base");
      g.wire("slab:aux:image", "stack:in:layer:m1");
      // The traced circle is the slab's per-layer matte (a spline → ALPHA).
      g.wire("trace2:out", "stack:in:mask:m1");
      g.out(L, "stack:out");
    },
    probe: {
      frames: [0],
      pixels: [
        { frame: 0, x: 240, y: 360, want: [255, 51, 102, 255], tol: 30, label: "the stroke on the disc's left edge" },
        { frame: 0, x: 500, y: 360, want: [null, null, null, 0], label: "inside the union: no stroke (the outline is merged)" },
        { frame: 0, x: 1000, y: 360, want: [255, 255, 255, 255], tol: 3, label: "slab inside the traced circle" },
        { frame: 0, x: 1000, y: 520, want: [null, null, null, 0], label: "slab outside the traced circle: masked out" },
      ],
    },
  },
  // What stays on the shader route: a smooth union under a rasterize (a
  // shader region), and a twist under sdf-to-spline (bakes).
  {
    name: "s-shader",
    title: "S shader",
    comp,
    build(g) {
      const L = g.layer("LS7", "Smooth");
      circle(g, L, "l", 520, 360, 120);
      circle(g, L, "r", 760, 360, 120);
      g.node(L, "blend", "sdf-smooth-union", { smoothness: len(60) });
      g.node(L, "ras", "sdf-rasterize");
      g.wire("l:out", "blend:in:a");
      g.wire("r:out", "blend:in:b");
      g.wire("blend:out", "ras:in:sdf");
      g.out(L, "ras:out");
    },
  },
  {
    name: "s-twist",
    title: "S twist",
    comp,
    build(g) {
      const L = g.layer("LS8", "Twisted");
      g.node(L, "tw", "sdf-twist", { center_x: sx(640), center_y: sy(360), strength: 4 });
      rect(g, L, "arm", 640, 360, 500, 60);
      g.node(L, "trace", "sdf-to-spline");
      g.node(L, "paint", "spline-fill", { color: "#ffffff" });
      g.wire("tw:out", "arm:in:position");
      g.wire("arm:out", "trace:in:sdf");
      g.wire("trace:out", "paint:in:path");
      g.out(L, "paint:out");
    },
  },
];
