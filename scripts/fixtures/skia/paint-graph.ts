// The Skia paint family's parity fixture (specdocs/101326_skia-target.md §7
// Wave 2, family F8): native toolbox chains beside their Skia-layer
// mirrors, each pair drawing the same spline. Every native side is the
// toolbox node's own image; every Skia side is a Skia Canvas (CanvasKit).
//
//   pair   native (A)                                   Skia (B)
//   s1     star → Stroke (miter, butt, 14 px)          star → Stroke (Skia)
//   s2     hexagon → Stroke dashed                      hexagon → Stroke (Skia) dashed
//   s3     circle → Stroke dotted                       circle → Stroke (Skia) dotted
//   s4     S-curve → Stroke 3 % translucent, round      S-curve → Stroke (Skia)
//   d1     hexagon → Stroke dashed                      hexagon → Stroke (Skia) → Dash (Skia)
//   f1     two circles → Fill (stacked, translucent)    → Fill (Skia)
//   f2     two circles → Fill (one path, evenodd)       → Fill (Skia)
//   tr1    star → Trim Path (end keyed 0→1) → Stroke    star → Stroke (Skia) → Trim Path (Skia)
//   tr2    hexagon → Trim Path (offset keyed, wraps)    → Trim Path (Skia)
//   tr3    Circle → Trim Path → Stroke                  Circle (Skia) → Trim Path (Skia)
//   rc1    star → Round Corners → Stroke                star → Stroke (Skia) → Round Corners (Skia, fillet)
//   rc2    (same native)                                … Round Corners (Skia, corner effect)
//   rc3    star → Round Corners → Fill                  star → Fill (Skia) → Round Corners (Skia)
//   g1     star → Rasterize gradient (linear, shape)    star → Fill (Skia) → Gradient Fill (Skia)
//   g2     circle → Rasterize gradient (radial, OKLab)  … radial
//   g3     two circles → Rasterize gradient (conic,     … conic, vary index
//          canvas frame 45°, vary index)
//   t1     Text "Hello Skia" 64 px centered             Text (Skia), paragraph shaping
//   t1l    (same native)                                Text (Skia), simple runs (<Text>)
//   t2     Text two lines, left, top, box + translate  Text (Skia)
//   t3     Text wrapped in a 0.62-wide box, centered    Text (Skia) wrap (one <Paragraph>)
//   t4     Text at opacity 0.5                          Text (Skia) inside a Skia Group at opacity 0.5
//
//   npm run compare:skia -- --a paint:s1n --b paint:s1s --expect close
//
// The Trim Paths (tr*) are measure = arc length, what a new node gets and
// what React Native's <Path start end> does; a segment-measure Trim Path
// (an old save) cuts up to ~10 % of a segment away on these straight edges.
//
// Fonts: Geist Regular (public/fonts, OFL 1.1) on both sides — the Text
// node through a FontFace registered here, the Skia side through its scene
// asset. Both are fetched when the fixture is first built (info) and must
// have landed by the time the compare prepares its sides; if not, build
// throws instead of letting the Text node silently draw a fallback face.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import type { CanvasKit } from "canvaskit-wasm";
import { makeSceneAssetResolver } from "@/engine/skia/scene-assets";
import { makeCircleSubpath } from "@/nodes/source/circle";
import { SKIA_FONTS } from "@/nodes/skia/fonts";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const PAINT_TIMELINE = { fps: 30, ticksPerFrame: 1000 };
export const PAINT_SCENE_TICKS = 60_000;
export const PAINT_SIZE = 512;
// The Text node's family for the fixture's Geist FontFace.
export const FIXTURE_FONT_FAMILY = "tbx-fixture-geist";
export const FIXTURE_FONT = SKIA_FONTS.Geist;

// ---- geometry (canvas01, Y-down) ----------------------------------------------------

type P = [number, number];
const poly = (pts: P[], closed = true): SplineSubpath => ({ closed, anchors: pts.map((pos): SplineAnchor => ({ pos })) });

function star(cx: number, cy: number, R: number, r: number, n: number): SplineSubpath {
  const pts: P[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? r : R;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return poly(pts);
}

function ngon(cx: number, cy: number, R: number, n: number): SplineSubpath {
  const pts: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
  }
  return poly(pts);
}

// An open S-curve with handles.
export const S_CURVE: SplineSubpath = {
  closed: false,
  anchors: [
    { pos: [0.18, 0.7], outHandle: [0.12, -0.35] },
    { pos: [0.5, 0.5], inHandle: [-0.14, 0], outHandle: [0.14, 0] },
    { pos: [0.82, 0.3], inHandle: [-0.12, 0.35] },
  ],
};

export const STAR = star(0.5, 0.5, 0.36, 0.16, 5);
export const HEXAGON = ngon(0.5, 0.5, 0.3, 6);
export const CIRCLE = makeCircleSubpath(0.5, 0.5, 0.3, 0.3);
export const TWO_CIRCLES = [makeCircleSubpath(0.4, 0.45, 0.22, 0.22), makeCircleSubpath(0.6, 0.55, 0.22, 0.22)];

// ---- graph helpers --------------------------------------------------------------------

type K = [frame: number, value: number, easing: EasingPreset];
const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * PAINT_TIMELINE.ticksPerFrame, value, easingOut })),
});

const draw = (id: string, subpaths: SplineSubpath[]): GraphNode => ({
  id,
  type: "spline-draw",
  params: { spline: { kind: "spline", subpaths }, stroke_enabled: false, fill_enabled: false, trim_start: 0, trim_end: 1, trim_offset: 0, opacity: 1 },
});

const edge = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

// The stroke params both Stroke and Stroke (Skia) read.
const STROKE_BASE = { color: "#ffffff", thickness: 4, units: "px", style: "solid", dash_length: 10, dash_gap: 8, dot_spacing: 12, cap: "round", join: "round", miter_limit: 10, close_open_paths: false };
const RAMP3 = [
  { id: "stop-a", position: 0, color: "#ff5f6d" },
  { id: "stop-b", position: 0.5, color: "#ffc371" },
  { id: "stop-c", position: 1, color: "#3a7bd5" },
];
const GRADIENT_BASE = {
  fill_ramp: RAMP3,
  ramp_interp: "linear",
  ramp_space: "srgb",
  gradient_kind: "linear",
  gradient_frame: "shape",
  gradient_angle: 0,
  gradient_scale: 1,
  gradient_offset: 0,
  gradient_vary: "none",
  gradient_vary_amount: 0.5,
  ramp_seed: 0,
  ramp_angle: 0,
};
const TEXT_BASE = {
  opacity: 1,
  text: "Hello Skia",
  font_size: 64,
  units: "px",
  color: "#ffffff",
  alignment: "center",
  vAlign: "middle",
  leading: 1.2,
  boxWidth: 1,
  boxHeight: 1,
  wrap: false,
  translateX: 0,
  translateY: 0,
};

// ---- fonts (browser only) ---------------------------------------------------------------

let face: FontFace | null = null;
let fontAsset: ReturnType<typeof makeSceneAssetResolver> | null = null;

// First build: start both loads. Later builds: they must have landed.
function fixtureFonts(): void {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return;
  if (!face) {
    face = new FontFace(FIXTURE_FONT_FAMILY, `url(${FIXTURE_FONT.asset.url})`);
    document.fonts.add(face);
    void face.load().catch(() => {});
    // The scene asset cache (scene-assets.ts) fetches fonts without CanvasKit.
    fontAsset = makeSceneAssetResolver(null as unknown as CanvasKit);
    fontAsset(FIXTURE_FONT.asset.id, "font", FIXTURE_FONT.asset);
    return;
  }
  const skia = fontAsset?.(FIXTURE_FONT.asset.id, "font", FIXTURE_FONT.asset);
  if (face.status !== "loaded" || !document.fonts.check(`64px "${FIXTURE_FONT_FAMILY}"`, "Hello Skia")) {
    throw new Error(`paint fixture: the Text node's font ${FIXTURE_FONT.asset.url} is ${face.status}, not loaded — refusing to compare a fallback face`);
  }
  if (!skia) {
    throw new Error(`paint fixture: the Skia font asset ${FIXTURE_FONT.asset.url} is ${skia === undefined ? "still loading" : "unavailable"}`);
  }
}

// ---- the graph ----------------------------------------------------------------------------

export function paintGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    draw("star", [STAR]),
    draw("hex", [HEXAGON]),
    draw("circle", [CIRCLE]),
    draw("scurve", [S_CURVE]),
    draw("two", TWO_CIRCLES),
  ];
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode, from?: [string, string]) => {
    nodes.push(n);
    if (from) edges.push(edge(from[0], n.id, from[1]));
  };
  // A Skia chain ending in its own Skia Canvas `<pair>s`.
  const canvas = (pair: string, last: string) => add({ id: `${pair}s`, type: "skia-canvas", params: { background_on: false } }, [last, "in:scene"]);

  // ---- stroke ----
  const strokePair = (pair: string, src: string, p: Record<string, unknown>) => {
    add({ id: `${pair}n`, type: "spline-stroke", params: { ...STROKE_BASE, ...p } }, [src, "in:path"]);
    add({ id: `${pair}k`, type: "skia-stroke", params: { ...STROKE_BASE, ...p } }, [src, "in:path"]);
    canvas(pair, `${pair}k`);
  };
  strokePair("s1", "star", { thickness: 14, join: "miter", miter_limit: 10, cap: "butt", color: "#ffd166" });
  strokePair("s2", "hex", { thickness: 8, style: "dashed", dash_length: 24, dash_gap: 12, cap: "butt" });
  strokePair("s3", "circle", { thickness: 10, style: "dotted", dot_spacing: 22, color: "#06d6a0" });
  strokePair("s4", "scurve", { thickness: 3, units: "%", cap: "round", join: "round", color: "#4fc3f7aa" });

  // ---- dash modifier: the same dashes as s2, from a solid Skia stroke ----
  add({ id: "d1k", type: "skia-stroke", params: { ...STROKE_BASE, thickness: 8, cap: "butt" } }, ["hex", "in:path"]);
  add({ id: "d1d", type: "skia-dash", params: { style: "dashed", dash_length: 24, dash_gap: 12, dot_spacing: 12, dash_offset: 0, units: "px" } }, ["d1k", "in:drawing"]);
  canvas("d1", "d1d");

  // ---- fill ----
  add({ id: "f1n", type: "spline-fill", params: { color: "#ff8a65aa", stack_subpaths: true, rule: "evenodd" } }, ["two", "in:path"]);
  add({ id: "f1k", type: "skia-spline-fill", params: { color: "#ff8a65aa", stack_subpaths: true, rule: "evenodd" } }, ["two", "in:path"]);
  canvas("f1", "f1k");
  add({ id: "f2n", type: "spline-fill", params: { color: "#9b5de5", stack_subpaths: false, rule: "evenodd" } }, ["two", "in:path"]);
  add({ id: "f2k", type: "skia-spline-fill", params: { color: "#9b5de5", stack_subpaths: false, rule: "evenodd" } }, ["two", "in:path"]);
  canvas("f2", "f2k");

  // ---- trim (keyframed on both sides with the same keys) ----
  const trimEnd = { trim_end: block([[0, 0.05, "easeInOutCubic"], [40, 1, "linear"], [60, 1, "linear"]]) };
  add({ id: "tr1t", type: "trim-path", params: { mode: "combined", measure: "arc length", trim_start: 0, trim_end: 0.05, trim_offset: 0 }, animation: trimEnd }, ["star", "in:path"]);
  add({ id: "tr1n", type: "spline-stroke", params: { ...STROKE_BASE, thickness: 10, cap: "butt", join: "miter", color: "#ef476f" } }, ["tr1t", "in:path"]);
  add({ id: "tr1k", type: "skia-stroke", params: { ...STROKE_BASE, thickness: 10, cap: "butt", join: "miter", color: "#ef476f" } }, ["star", "in:path"]);
  add({ id: "tr1x", type: "skia-trim-path", params: { mode: "combined", measure: "arc length", trim_start: 0, trim_end: 0.05, trim_offset: 0 }, animation: trimEnd }, ["tr1k", "in:drawing"]);
  canvas("tr1", "tr1x");
  const trimOffset = { trim_offset: block([[0, 0, "linear"], [60, 1, "linear"]]) };
  add({ id: "tr2t", type: "trim-path", params: { mode: "combined", measure: "arc length", trim_start: 0, trim_end: 0.4, trim_offset: 0 }, animation: trimOffset }, ["hex", "in:path"]);
  add({ id: "tr2n", type: "spline-stroke", params: { ...STROKE_BASE, thickness: 12, cap: "butt", join: "miter" } }, ["tr2t", "in:path"]);
  add({ id: "tr2k", type: "skia-stroke", params: { ...STROKE_BASE, thickness: 12, cap: "butt", join: "miter" } }, ["hex", "in:path"]);
  add({ id: "tr2x", type: "skia-trim-path", params: { mode: "combined", measure: "arc length", trim_start: 0, trim_end: 0.4, trim_offset: 0 }, animation: trimOffset }, ["tr2k", "in:drawing"]);
  canvas("tr2", "tr2x");

  // Trim on Circle (Skia)'s oval: redrawn as toolbox's circle, so the
  // window starts at the top like Circle → Trim Path.
  const circleParams = { centerX: 0.5, centerY: 0.5, radiusX: 0.3, radiusY: 0.3, opacity: 1, trim_start: 0, trim_end: 1, trim_offset: 0 };
  add({ id: "tcirc", type: "circle", params: { ...circleParams, stroke_enabled: false, fill_enabled: false } });
  add({ id: "tr3t", type: "trim-path", params: { mode: "combined", measure: "arc length", trim_start: 0.1, trim_end: 0.45, trim_offset: 0 } }, ["tcirc", "in:path"]);
  add({ id: "tr3n", type: "spline-stroke", params: { ...STROKE_BASE, thickness: 10, color: "#ffd166" } }, ["tr3t", "in:path"]);
  add({ id: "tr3c", type: "skia-circle", params: { ...circleParams, stroke_enabled: true, stroke_thickness: 10, stroke_units: "px", stroke_color: "#ffd166", fill_enabled: false, fill_color: "#ffffff" } });
  add({ id: "tr3x", type: "skia-trim-path", params: { mode: "combined", measure: "arc length", trim_start: 0.1, trim_end: 0.45, trim_offset: 0 } }, ["tr3c", "in:drawing"]);
  canvas("tr3", "tr3x");

  // ---- round corners ----
  add({ id: "rc", type: "round-corners", params: { radius: 0.06 } }, ["star", "in:path"]);
  add({ id: "rc1n", type: "spline-stroke", params: { ...STROKE_BASE, thickness: 8, color: "#118ab2" } }, ["rc", "in:path"]);
  add({ id: "rc1k", type: "skia-stroke", params: { ...STROKE_BASE, thickness: 8, color: "#118ab2" } }, ["star", "in:path"]);
  add({ id: "rc1x", type: "skia-round-corners", params: { radius: 0.06, method: "fillet" } }, ["rc1k", "in:drawing"]);
  canvas("rc1", "rc1x");
  add({ id: "rc2x", type: "skia-round-corners", params: { radius: 0.06, method: "corner" } }, ["rc1k", "in:drawing"]);
  canvas("rc2", "rc2x");
  add({ id: "rc3n", type: "spline-fill", params: { color: "#ffffff", stack_subpaths: true, rule: "evenodd" } }, ["rc", "in:path"]);
  add({ id: "rc3k", type: "skia-spline-fill", params: { color: "#ffffff", stack_subpaths: true, rule: "evenodd" } }, ["star", "in:path"]);
  add({ id: "rc3x", type: "skia-round-corners", params: { radius: 0.06, method: "fillet" } }, ["rc3k", "in:drawing"]);
  canvas("rc3", "rc3x");

  // ---- gradient fill ----
  const gradientPair = (pair: string, src: string, p: Record<string, unknown>) => {
    const g = { ...GRADIENT_BASE, ...p };
    add({ id: `${pair}n`, type: "rasterize-spline", params: { ...g, enable_fill: true, fill_source: "gradient", enable_stroke: false, stack_subpaths: true } }, [src, "in:path"]);
    add({ id: `${pair}k`, type: "skia-spline-fill", params: { color: "#ffffff", stack_subpaths: true, rule: "evenodd" } }, [src, "in:path"]);
    add({ id: `${pair}x`, type: "skia-gradient-fill", params: g }, [`${pair}k`, "in:drawing"]);
    canvas(pair, `${pair}x`);
  };
  gradientPair("g1", "star", { gradient_kind: "linear", gradient_angle: 30 });
  gradientPair("g2", "circle", { gradient_kind: "radial", ramp_space: "oklab", gradient_scale: 1.2 });
  gradientPair("g3", "two", { gradient_kind: "conic", gradient_frame: "canvas", gradient_angle: 45, gradient_vary: "index", gradient_vary_amount: 0.5 });

  // ---- text ----
  const customFont = { family: FIXTURE_FONT_FAMILY, filename: "Geist-Regular.ttf" };
  const textPair = (pair: string, p: Record<string, unknown>, skia: Record<string, unknown> = {}) => {
    add({
      id: `${pair}n`,
      type: "text",
      params: {
        ...TEXT_BASE,
        font_family: "Inter",
        custom_font: customFont,
        font_weight: 400,
        italic: false,
        fillMode: "solid",
        strokeEnabled: false,
        textCase: "none",
        letter_spacing: 0,
        scaleX: 1,
        scaleY: 1,
        rotate: 0,
        pivotX: 0.5,
        pivotY: 0.5,
        ...p,
      },
    });
    add({ id: `${pair}k`, type: "skia-text", params: { ...TEXT_BASE, font_family: "Geist", shaping: "paragraph", ...p, ...skia } });
  };
  textPair("t1", {});
  canvas("t1", "t1k");
  add({ id: "t1lk", type: "skia-text", params: { ...TEXT_BASE, font_family: "Geist", shaping: "line" } });
  canvas("t1l", "t1lk");
  textPair("t2", {
    text: "Skia layers\nship as code",
    alignment: "left",
    vAlign: "top",
    font_size: 48,
    leading: 1.4,
    boxWidth: 0.8,
    boxHeight: 0.6,
    // Whole-pixel moves at 512 px: the Text node translates its raster
    // in a resampling pass, so a fractional move blurs ITS edges (bilinear
    // over straight alpha, dark fringes); the Skia side lays out exactly.
    translateX: 20 / 512,
    translateY: -26 / 512,
    color: "#ffd166",
  });
  canvas("t2", "t2k");
  // Wrapped: the Text node's leading set to Geist's paragraph line height
  // at 40 px (round(52) / 40 = 1.3), which the Skia paragraph uses.
  textPair("t3", { text: "Paragraphs wrap inside the text box, exactly where the Text node breaks them.", font_size: 40, wrap: true, boxWidth: 0.62, vAlign: "top", leading: 52 / 40, alignment: "center", color: "#a0e7e5" });
  canvas("t3", "t3k");
  // Group opacity over a paragraph (RN paints a Paragraph with its own paint;
  // the exporter folds the group's opacity into it).
  add({
    id: "t4n",
    type: "text",
    params: { ...TEXT_BASE, font_family: "Inter", custom_font: customFont, font_weight: 400, italic: false, fillMode: "solid", strokeEnabled: false, textCase: "none", letter_spacing: 0, scaleX: 1, scaleY: 1, rotate: 0, pivotX: 0.5, pivotY: 0.5, opacity: 0.5, text: "Half opacity", font_size: 72 },
  });
  add({ id: "t4k", type: "skia-text", params: { ...TEXT_BASE, font_family: "Geist", shaping: "paragraph", text: "Half opacity", font_size: 72 } });
  add({ id: "t4g", type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 0.5, blendMode: "srcOver" } }, ["t4k", "in:child1"]);
  canvas("t4", "t4g");

  return { nodes, edges };
}

// The native / Skia node of every pair (the gate exports every `…s`).
export const PAINT_PAIRS: { pair: string; a: string; b: string; frames: number[] }[] = [
  ...["s1", "s2", "s3", "s4", "f1", "f2", "tr3", "rc1", "rc3", "g1", "g2", "g3", "t1", "t2", "t3", "t4"].map((p) => ({ pair: p, a: `${p}n`, b: `${p}s`, frames: [0] })),
  { pair: "d1", a: "s2n", b: "d1s", frames: [0] },
  { pair: "rc2", a: "rc1n", b: "rc2s", frames: [0] },
  { pair: "t1l", a: "t1n", b: "t1ls", frames: [0] },
  { pair: "tr1", a: "tr1n", b: "tr1s", frames: [0, 12, 24, 40] },
  { pair: "tr2", a: "tr2n", b: "tr2s", frames: [0, 20, 45] },
];

export const fixture: SkiaGraphFixture = {
  description: "Skia paint family: native Stroke / Fill / Trim Path / Round Corners / gradient fill / Text vs their Skia-layer mirrors (`<pair>n` vs `<pair>s`)",
  timeline: PAINT_TIMELINE,
  frames: [0],
  size: PAINT_SIZE,
  build: () => {
    fixtureFonts();
    return paintGraph();
  },
};
