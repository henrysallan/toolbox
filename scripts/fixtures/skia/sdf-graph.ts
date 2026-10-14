// SDF trees through the Skia SDF terminals (Wave 2 family 5): every tree is
// wired into the native terminal (`n_<tree>`) AND its Skia port →
// Skia Fill → Skia Canvas (`s_<tree>`), so compare:skia proves the
// generated SkSL against compileSdf's GLSL on the same values:
//
//   npm run compare:skia -- --a sdf:n_prims --b sdf:s_prims
//
// Trees (shared by several terminals where noted):
//   prims    every primitive (circle, rect + corner radius, line segment,
//            polygon, triangle, star) in a 6-way Union, three painted;
//            keyframed circle radius + star sharpness
//   bool     intersection, subtraction, smooth union / intersection /
//            subtraction, each in its own corner; keyframed smoothness
//   mods     round, onion, morph (keyframed amount) circle ↔ star
//   pos      translate → scale → rotate (keyframed), mirror (both axes),
//            polar (6 sectors), twist
//   repeat   bounded repeat with rotation / position / scale jitter, and
//            an infinite repeat (keyframed spacing) of rotated segments
//   field    scalar fields: per-tile rotation from a Noise field sampled at
//            the repeat's cell id, a polygon whose side count is a field
//   spline   SDF Spline of a closed Star spline (keyframed radius) and of
//            an open Sine Wave thickened by Round
//   mat      painted smooth-union blob (colour blends across the join),
//            SDF Material override with a keyframed colour
// Terminals: Rasterize on all eight (+ `clear`: translucent fill on a
// transparent background); to Mask (plain + inverted), to Distance Image,
// Bevel (4 styles), Shade (4 configurations incl. height_mode=curve, and
// the aux layers — `<tree>_<layer>`, the native side read through an
// identity GLSL Expression so mask layers get the engine's mask → image
// coercion); `ramp`: SDF to Mask feeding Color Ramp, i.e. the SDF program
// as a fused child of another Skia shader.
//
// Measured 2026-10-13, 512², frames 0/30/60 (and 640×360 for prims, pos,
// bevel, shade): all 28 pairs MATCH, max 1/255 — except where alpha is
// low: `clear` max 15/255 and `shade_glow` max 255/255, both confined to
// translucent pixels (RGB error ∝ 1/alpha: a Skia surface is premultiplied
// 8-bit, so an un-premultiplied colour at alpha a has 1/(255·a) steps; alpha
// itself differs by ≤ 1/255).

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const SDF_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
export const SDF_FRAMES = [0, 30, 60];

type K = [frame: number, value: number | string, easing: EasingPreset];
const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * 1000, value, easingOut })),
});

const NATIVE: Record<string, string> = {
  rasterize: "sdf-rasterize",
  mask: "sdf-to-mask",
  distance: "sdf-to-distance-image",
  bevel: "sdf-bevel",
  shade: "sdf-shade",
};
const SKIA: Record<string, string> = {
  rasterize: "skia-sdf-rasterize",
  mask: "skia-sdf-to-mask",
  distance: "skia-sdf-to-distance-image",
  bevel: "skia-sdf-bevel",
  shade: "skia-sdf-shade",
};

export interface SdfFixturePair {
  name: string;
  native: string;
  skia: string;
}

export function sdfGraph(): { nodes: GraphNode[]; edges: GraphEdge[]; pairs: SdfFixturePair[]; canvases: string[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const pairs: SdfFixturePair[] = [];
  const canvases: string[] = [];
  const add = (id: string, type: string, params: Record<string, unknown>, extra: Partial<GraphNode> = {}) => {
    nodes.push({ id, type, params, ...extra });
    return id;
  };
  const wire = (source: string, target: string, socket: string, sourceHandle = "out:primary") => {
    edges.push({ id: `${source}>${target}:${socket}`, source, sourceHandle, target, targetHandle: `in:${socket}` });
  };
  const union = (id: string, inputs: string[]) => {
    const slots = inputs.map((_, i) => String.fromCharCode(97 + i));
    add(id, "sdf-union", { slots: [...slots, String.fromCharCode(97 + inputs.length)] });
    inputs.forEach((src, i) => wire(src, id, slots[i]));
    return id;
  };
  // Native terminal + its Skia port → Skia Fill → Skia Canvas.
  const terminal = (name: string, mode: string, sdf: string, params: Record<string, unknown>, aux: string[] = []) => {
    add(`n_${name}`, NATIVE[mode], params);
    wire(sdf, `n_${name}`, "sdf");
    add(`k_${name}`, SKIA[mode], params);
    wire(sdf, `k_${name}`, "sdf");
    for (const handle of ["primary", ...aux]) {
      const tag = handle === "primary" ? name : `${name}_${handle}`;
      add(`f_${tag}`, "skia-fill", { color: "#ffffff", opacity: 1, blendMode: "srcOver" });
      wire(`k_${name}`, `f_${tag}`, "shader", handle === "primary" ? "out:primary" : `out:aux:${handle}`);
      add(`s_${tag}`, "skia-canvas", { background_on: false });
      wire(`f_${tag}`, `s_${tag}`, "scene");
      canvases.push(`s_${tag}`);
      if (handle !== "primary") {
        // A native aux layer read the way a consumer reads it: through an
        // identity GLSL Expression, so a MASK layer (R only on the GPU)
        // goes through the engine's mask → image coercion (m, m, m, 1).
        add(`n_${tag}`, "glsl-expression", { inputs: [], expression: "fragColor = texture(u_a, v_uv);", on_error: "transparent" });
        wire(`n_${name}`, `n_${tag}`, "a", `out:aux:${handle}`);
      }
      pairs.push({ name: tag, native: handle === "primary" ? `n_${name}` : `n_${tag}`, skia: `s_${tag}` });
    }
  };

  // ---- prims ----
  add("p_circle", "sdf-circle", { x: 0.2, y: 0.28, radius: 0.1, paint: true, color: "#ff4d4d" }, {
    animation: { radius: block([[0, 0.08, "easeInOutCubic"], [60, 0.13, "linear"]]) },
  });
  add("p_rect", "sdf-rectangle", { x: 0.5, y: 0.28, width: 0.24, height: 0.15, corner_radius: 0.03, paint: true, color: "#4dff88" });
  add("p_seg", "sdf-line-segment", { ax: 0.68, ay: 0.18, bx: 0.9, by: 0.36, thickness: 0.025 });
  add("p_poly", "sdf-polygon", { x: 0.2, y: 0.66, radius: 0.11, sides: 6, quantize_sides: true, paint: true, color: "#4d8bff" });
  add("p_tri", "sdf-triangle", { ax: 0.4, ay: 0.56, bx: 0.6, by: 0.56, cx: 0.5, cy: 0.78 });
  add("p_star", "sdf-star", { x: 0.8, y: 0.66, radius: 0.13, points: 5, sharpness: 2.5 }, {
    animation: { sharpness: block([[0, 2.2, "easeOutQuad"], [60, 4, "linear"]]) },
  });
  const prims = union("p_union", ["p_circle", "p_rect", "p_seg", "p_poly", "p_tri", "p_star"]);
  terminal("prims", "rasterize", prims, {
    foreground: "#f2e6c9",
    background: "#101820",
    contour: "#ff8800",
    contour_alpha: 1,
    contour_width: 2,
    softness: 1.5,
  });
  terminal("mask", "mask", prims, { threshold: 0.01, softness: 2 });
  terminal("maskinv", "mask", prims, { threshold: -0.02, softness: 1, invert: true });

  // ---- bool ----
  add("b_c1", "sdf-circle", { x: 0.22, y: 0.25, radius: 0.13 });
  add("b_r1", "sdf-rectangle", { x: 0.3, y: 0.25, width: 0.2, height: 0.2 });
  add("b_int", "sdf-intersection", {});
  wire("b_c1", "b_int", "a");
  wire("b_r1", "b_int", "b");
  add("b_r2", "sdf-rectangle", { x: 0.75, y: 0.25, width: 0.3, height: 0.2, corner_radius: 0.02 });
  add("b_c2", "sdf-circle", { x: 0.82, y: 0.2, radius: 0.08 });
  add("b_sub", "sdf-subtraction", {});
  wire("b_r2", "b_sub", "a");
  wire("b_c2", "b_sub", "b");
  add("b_c3", "sdf-circle", { x: 0.18, y: 0.72, radius: 0.09 });
  add("b_c4", "sdf-circle", { x: 0.34, y: 0.72, radius: 0.07 });
  add("b_su", "sdf-smooth-union", { smoothness: 0.06 }, {
    animation: { smoothness: block([[0, 0.02, "easeInOutSine"], [60, 0.12, "linear"]]) },
  });
  wire("b_c3", "b_su", "a");
  wire("b_c4", "b_su", "b");
  add("b_c5", "sdf-circle", { x: 0.62, y: 0.7, radius: 0.1 });
  add("b_c6", "sdf-circle", { x: 0.7, y: 0.7, radius: 0.1 });
  add("b_si", "sdf-smooth-intersection", { smoothness: 0.04 });
  wire("b_c5", "b_si", "a");
  wire("b_c6", "b_si", "b");
  add("b_r3", "sdf-rectangle", { x: 0.85, y: 0.85, width: 0.2, height: 0.16 });
  add("b_c7", "sdf-circle", { x: 0.8, y: 0.8, radius: 0.07 });
  add("b_ss", "sdf-smooth-subtraction", { smoothness: 0.03 });
  wire("b_r3", "b_ss", "a");
  wire("b_c7", "b_ss", "b");
  const bool = union("b_union", ["b_int", "b_sub", "b_su", "b_si", "b_ss"]);
  terminal("bool", "rasterize", bool, { foreground: "#e0f7ff", background: "#202830", softness: 1 });
  terminal("dist", "distance", bool, { range: 0.25, neg_color: "#ff3060", zero_color: "#ffffff", pos_color: "#3060ff", alpha: 1 });

  // ---- mods ----
  add("m_rect", "sdf-rectangle", { x: 0.25, y: 0.3, width: 0.22, height: 0.12 });
  add("m_round", "sdf-round", { radius: 0.04 });
  wire("m_rect", "m_round", "sdf");
  add("m_circle", "sdf-circle", { x: 0.72, y: 0.3, radius: 0.15 });
  add("m_onion", "sdf-onion", { thickness: 0.015 });
  wire("m_circle", "m_onion", "sdf");
  add("m_c", "sdf-circle", { x: 0.5, y: 0.72, radius: 0.12 });
  add("m_s", "sdf-star", { x: 0.5, y: 0.72, radius: 0.18, points: 6, sharpness: 3 });
  add("m_morph", "sdf-morph", { amount: 0.5 }, { animation: { amount: block([[0, 0, "easeInOutCubic"], [60, 1, "linear"]]) } });
  wire("m_c", "m_morph", "a");
  wire("m_s", "m_morph", "b");
  const mods = union("m_union", ["m_round", "m_onion", "m_morph"]);
  terminal("mods", "rasterize", mods, { foreground: "#fff3b0", background: "#1d1a2f", softness: 1 });
  terminal("bevel2", "bevel", mods, {
    style: "outer-bevel",
    depth: 0.05,
    soften: 2,
    highlight_blend: "linear-dodge",
    shadow_blend: "color-burn",
    l2_hi_op: 0.5,
    l2_sh_op: 0.4,
    shadow_color: "#402010",
  });

  // ---- pos ----
  add("q_t", "sdf-translate", { tx: 0.02, ty: -0.03 });
  add("q_s", "sdf-scale", { sx: 1.3, sy: 0.8, cx: 0.75, cy: 0.75 });
  wire("q_t", "q_s", "position");
  add("q_r", "sdf-rotate", { rotation: 20, cx: 0.75, cy: 0.75 }, {
    animation: { rotation: block([[0, 0, "easeInOutQuad"], [60, 90, "linear"]]) },
  });
  wire("q_s", "q_r", "position");
  add("q_rect", "sdf-rectangle", { x: 0.75, y: 0.75, width: 0.2, height: 0.08 });
  wire("q_r", "q_rect", "position");
  add("q_m", "sdf-mirror", { axis: "both", center_x: 0.25, center_y: 0.25 });
  add("q_mc", "sdf-circle", { x: 0.33, y: 0.32, radius: 0.05 });
  wire("q_m", "q_mc", "position");
  add("q_p", "sdf-polar", { segments: 6, center_x: 0.75, center_y: 0.25, rotation: 0.3 });
  add("q_pl", "sdf-line-segment", { ax: 0.79, ay: 0.25, bx: 0.92, by: 0.25, thickness: 0.018 });
  wire("q_p", "q_pl", "position");
  add("q_w", "sdf-twist", { center_x: 0.25, center_y: 0.75, strength: 8 });
  add("q_wr", "sdf-rectangle", { x: 0.25, y: 0.75, width: 0.3, height: 0.05 });
  wire("q_w", "q_wr", "position");
  const pos = union("q_union", ["q_rect", "q_mc", "q_pl", "q_wr"]);
  terminal("pos", "rasterize", pos, { foreground: "#ffffff", background: "#0b3d2e", softness: 1 });
  terminal("bevel", "bevel", pos, { style: "inner-bevel", depth: 0.03 });

  // ---- repeat ----
  add("r_rep", "sdf-repeat", {
    spacing_x: 0.16,
    spacing_y: 0.16,
    center_x: 0.5,
    center_y: 0.5,
    bounded: true,
    limit_x: 2,
    limit_y: 1,
    rotation_jitter: 0.6,
    position_jitter_x: 0.02,
    position_jitter_y: 0.015,
    scale_jitter: 0.3,
    seed: 7,
  });
  add("r_rect", "sdf-rectangle", { x: 0.5, y: 0.5, width: 0.08, height: 0.05, corner_radius: 0.01 });
  wire("r_rep", "r_rect", "position");
  add("r_inf", "sdf-repeat", { spacing_x: 0.1, spacing_y: 0.1, center_x: 0.05, center_y: 0.05 }, {
    animation: { spacing_x: block([[0, 0.1, "linear"], [60, 0.12, "linear"]]) },
  });
  add("r_rot", "sdf-rotate", { rotation: 30, cx: 0.05, cy: 0.05 });
  wire("r_inf", "r_rot", "position");
  add("r_seg", "sdf-line-segment", { ax: 0.03, ay: 0.05, bx: 0.07, by: 0.05, thickness: 0.006 });
  wire("r_rot", "r_seg", "position");
  const rep = union("r_union", ["r_rect", "r_seg"]);
  terminal("repeat", "rasterize", rep, { foreground: "#ffd166", background: "#073b4c", softness: 1 });

  // ---- field ----
  // Scalar fields (Noise's `field` output -- not a Skia-layer node, so this
  // tree proves the generator only): per-tile rotation from a noise sampled
  // at the repeat's cell id, and a polygon whose side count is a field.
  add("v_rep", "sdf-repeat", { spacing_x: 0.125, spacing_y: 0.125, center_x: 0.0625, center_y: 0.0625 });
  add("v_noise", "noise", { type: "simplex", scale: 2, octaves: 2, persistence: 0.5, lacunarity: 2, seed: 3, field_lo: -1.5, field_hi: 1.5 });
  wire("v_rep", "v_noise", "field_position", "out:aux:cell_id");
  add("v_rot", "sdf-rotate", { rotation: 0, cx: 0.0625, cy: 0.0625 });
  wire("v_rep", "v_rot", "position");
  wire("v_noise", "v_rot", "angle_field", "out:aux:field");
  add("v_seg", "sdf-line-segment", { ax: 0.03, ay: 0.0625, bx: 0.095, by: 0.0625, thickness: 0.008 });
  wire("v_rot", "v_seg", "position");
  add("v_noise2", "noise", { type: "simplex", scale: 1.5, octaves: 1, seed: 9, field_lo: 3, field_hi: 9 });
  add("v_poly", "sdf-polygon", { x: 0.5, y: 0.5, radius: 0.3, quantize_sides: true });
  wire("v_noise2", "v_poly", "sides_field", "out:aux:field");
  add("v_onion", "sdf-onion", { thickness: 0.01 });
  wire("v_poly", "v_onion", "sdf");
  const field = union("v_union", ["v_seg", "v_onion"]);
  terminal("field", "rasterize", field, { foreground: "#ffffff", background: "#3a0ca3", softness: 1 });

  // ---- spline ----
  add("l_star", "star", { centerX: 0.3, centerY: 0.45, points: 5, outerRadius: 0.22, innerRadius: 0.09, rotation: 0 }, {
    animation: { outerRadius: block([[0, 0.18, "easeInOutCubic"], [60, 0.26, "linear"]]) },
  });
  add("l_sdf1", "sdf-spline", { subdivisions: 16 });
  wire("l_star", "l_sdf1", "spline");
  add("l_wave", "wave", { centerX: 0.7, centerY: 0.5, width: 0.45, amplitude: 0.12, cycles: 1.5, phase: 0, resolution: 8 });
  add("l_sdf2", "sdf-spline", { subdivisions: 4 });
  wire("l_wave", "l_sdf2", "spline");
  add("l_round", "sdf-round", { radius: 0.012 });
  wire("l_sdf2", "l_round", "sdf");
  const spl = union("l_union", ["l_sdf1", "l_round"]);
  terminal("spline", "rasterize", spl, { foreground: "#caffbf", background: "#22223b", softness: 1 });

  // ---- mat ----
  add("c_a", "sdf-circle", { x: 0.36, y: 0.4, radius: 0.14, paint: true, color: "#ff5a36" });
  add("c_b", "sdf-circle", { x: 0.6, y: 0.42, radius: 0.12, paint: true, color: "#2f6bff" });
  add("c_r", "sdf-rectangle", { x: 0.48, y: 0.62, width: 0.3, height: 0.1, corner_radius: 0.03, paint: true, color: "#ffd23f" });
  add("c_blob", "sdf-smooth-union", { slots: ["a", "b", "c", "d"], smoothness: 0.08 });
  wire("c_a", "c_blob", "a");
  wire("c_b", "c_blob", "b");
  wire("c_r", "c_blob", "c");
  add("c_tri", "sdf-triangle", { ax: 0.72, ay: 0.72, bx: 0.9, by: 0.72, cx: 0.81, cy: 0.9 });
  add("c_mat", "sdf-material", { color_mode: "constant", color: "#3ddc97" }, {
    animation: { color: block([[0, "#3ddc97", "easeInOutQuad"], [60, "#b05cff", "linear"]]) },
  });
  wire("c_tri", "c_mat", "sdf");
  const mat = union("c_union", ["c_blob", "c_mat"]);
  terminal("mat", "rasterize", mat, { foreground: "#ffffff", background: "#111111", softness: 1 });
  terminal("bevel3", "bevel", mat, { style: "emboss", depth: 0.04, highlight_blend: "normal", shadow_blend: "linear-burn", l1_angle: 60 });
  terminal("bevel4", "bevel", bool, { style: "pillow-emboss", depth: 0.03, highlight_blend: "add", shadow_blend: "normal", l2_hi_op: 0.3 });
  terminal(
    "shade",
    "shade",
    mat,
    { light: true, height_mode: "inner", depth: 0.05, glow: true, glow_radius: 0.05, glow_blend: "screen", contour: true, contour_width: 1.5, contour_color: "#ffffff", contour_alpha: 0.8 },
    ["normal", "height", "glow", "bleed", "mask"]
  );
  terminal("shade2", "shade", mat, {
    bleed: true,
    bleed_mix: 0.7,
    bleed_radius: 0.2,
    light: true,
    height_mode: "emboss",
    glow: true,
    glow_blend: "add",
    glow_color_mode: "fixed",
    glow_color: "#ffcc00",
    background: "#000000",
    bg_alpha: 1,
  });
  // height_mode=curve: the profile is a monotone curve through four points
  // (the native samples a 256-texel 8-bit LUT of it); normal layer too.
  terminal(
    "shade4",
    "shade",
    bool,
    {
      light: true,
      height_mode: "curve",
      height_curve: [
        { id: "hc0", x: 0, y: 0 },
        { id: "hc1", x: 0.3, y: 0.85 },
        { id: "hc2", x: 0.6, y: 0.35 },
        { id: "hc3", x: 1, y: 1 },
      ],
      depth: 0.06,
      soften: 1.5,
      l2_hi_op: 0.4,
    },
    ["normal", "height"]
  );
  terminal("shade3", "shade", prims, {
    light: true,
    height_mode: "pillow",
    highlight_blend: "add",
    shadow_blend: "color-burn",
    glow: true,
    glow_blend: "normal",
    contour: true,
    contour_spacing: 0.04,
    contour_width: 1,
    bleed: true,
    bleed_inside: false,
    bleed_radius: 0.1,
  });

  // ---- translucent: transparent background, translucent fill ----
  terminal("clear", "rasterize", mods, {
    foreground: "#ffcc66",
    fg_alpha: 0.85,
    bg_alpha: 0,
    contour: "#ff3366",
    contour_alpha: 0.6,
    contour_width: 3,
    softness: 2,
  });

  // ---- ramp: the SDF program as a FUSED CHILD of another Skia shader ----
  // native SDF to Mask → Color Ramp vs Skia SDF to Mask → Color Ramp (Skia)
  // (the fuser samples the SDF program through its child wrapper).
  const stops = [
    { id: "s0", position: 0, color: "#1b1b3a" },
    { id: "s1", position: 0.5, color: "#ff6b6b" },
    { id: "s2", position: 1, color: "#ffe66d" },
  ];
  const rampParams = { stops, offset: 0, interpolation: "linear", space: "srgb" };
  add("n_ramp", "color-ramp", rampParams);
  wire("n_mask", "n_ramp", "image");
  add("k_ramp", "skia-color-ramp", rampParams);
  wire("k_mask", "k_ramp", "image");
  add("f_ramp", "skia-fill", { color: "#ffffff", opacity: 1, blendMode: "srcOver" });
  wire("k_ramp", "f_ramp", "shader");
  add("s_ramp", "skia-canvas", { background_on: false });
  wire("f_ramp", "s_ramp", "scene");
  canvases.push("s_ramp");
  pairs.push({ name: "ramp", native: "n_ramp", skia: "s_ramp" });

  return { nodes, edges, pairs, canvases };
}

export const fixture: SkiaGraphFixture = {
  description:
    "SDF trees: native SDF terminals (`n_<tree>`) vs their Skia ports → Skia Fill → Skia Canvas (`s_<tree>`); trees prims, bool, mods, pos, repeat, field, spline, mat; terminals rasterize, mask, distance, bevel, shade (+ aux)",
  timeline: SDF_TIMELINE,
  frames: SDF_FRAMES,
  size: 512,
  build: () => {
    const g = sdfGraph();
    return { nodes: g.nodes, edges: g.edges };
  },
};
