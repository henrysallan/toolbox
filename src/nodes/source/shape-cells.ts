import { OPACITY_PARAM } from "@/engine/conventions";
import type { NodeDefinition } from "@/engine/types";
import {
  colorRampLutGlsl,
  getColorRampLut,
  normalizeRampInterp,
  normalizeRampSpace,
  rampInterpParam,
  rampSpaceParam,
  releaseColorRampLut,
  type ColorRampLutState,
  type ColorRampStop,
} from "@/engine/color-ramp";

// Shape Cells — a grid generator where every cell renders nested concentric
// copies of a shape primitive (circle / square / triangle). Each cell's
// shape, copy count, base hue position on the color ramp, and animation
// phase are seeded by hashing the cell index, so the layout is deterministic
// given a seed.
//
// The whole grid renders in a single fullscreen fragment pass. Per pixel:
//   1. Figure out which cell we're in (cellId) and the local position
//      inside that cell (cellLocal, in pixels, aspect-preserving).
//   2. Hash (cellId, seed) into a few independent randoms — choose shape,
//      copy count, base ramp position, per-cell time phase.
//   3. Iterate copies outermost → innermost. Each copy's scale lives in its
//      own band of [scaleMin, scaleMax] (so ring i is never larger than
//      ring i-1) and oscillates within that band over time. Paint with
//      the ramp sampled at `(baseHue + i * hueShift) mod 1`. Later
//      iterations overwrite earlier ones, so the smallest shape ends up
//      on top.
//
// Anim time comes from the `time` input socket (Scene Time → here). If
// nothing is wired, falls back to ctx.time so the node still animates
// during normal playback. `stable: false` so the evaluator re-runs us
// each frame.

const MAX_COPIES = 8;

export const SHAPE_CELLS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform vec2  u_resolution;
uniform vec2  u_grid;            // (cols, rows)
uniform float u_cellSize;        // 0..1 fraction of grid-cell filled by largest shape
uniform float u_time;
uniform float u_speed;
uniform float u_seed;
uniform int   u_copiesMin;
uniform int   u_copiesMax;
uniform float u_scaleMin;
uniform float u_scaleMax;
uniform float u_hueShift;
uniform vec4  u_bg;
uniform int   u_shapeMask;       // bit 0: circle, bit 1: square, bit 2: triangle
uniform int   u_lockBase;        // 1: outermost copy is pinned to scaleMax

// Ramp: baked 1-D LUT (engine/color-ramp.ts), one filtered fetch.
${colorRampLutGlsl("sampleRamp", "u_lut", "u_constant")}

out vec4 outColor;

const float TAU = 6.28318530718;

// 2D integer hash → 4 floats in [0,1). PCG-style, cheap and decent.
vec4 hash44(ivec2 cell, float seedF) {
  uint x = uint(cell.x) * 1973u;
  uint y = uint(cell.y) * 9277u;
  uint s = uint(seedF) * 26699u;
  uint h = x ^ y ^ s;
  vec4 r;
  for (int i = 0; i < 4; i++) {
    h = h * 747796405u + 2891336453u;
    uint word = ((h >> ((h >> 28) + 4u)) ^ h) * 277803737u;
    word = (word >> 22) ^ word;
    r[i] = float(word & 0xffffffu) / float(0x1000000u);
  }
  return r;
}

float sdCircle(vec2 p, float r) { return length(p) - r; }

float sdBox(vec2 p, float r) {
  vec2 d = abs(p) - vec2(r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Equilateral triangle pointing up, "radius" = half the bbox side. This is
// the standard IQ formulation — circumscribes the unit triangle in a
// box of side 2r so it visually matches the square at the same r.
float sdTriangle(vec2 p, float r) {
  const float k = 1.7320508; // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

// Pick a shape index (0 circle, 1 square, 2 triangle) from the enabled
// mask. If nothing is enabled, fall back to circle so we never render
// empty cells silently.
int pickShape(int mask, float r) {
  int count = 0;
  int slots[3];
  slots[0] = 0; slots[1] = 0; slots[2] = 0;
  if ((mask & 1) != 0) { slots[count] = 0; count++; }
  if ((mask & 2) != 0) { slots[count] = 1; count++; }
  if ((mask & 4) != 0) { slots[count] = 2; count++; }
  if (count == 0) return 0;
  int idx = int(r * float(count));
  if (idx >= count) idx = count - 1;
  return slots[idx];
}

void main() {
  vec2 uv = v_uv;
  // Grid the canvas. Cell coords in [0, grid). Local coords in [0, 1).
  vec2 gridPos = uv * u_grid;
  ivec2 cellId = ivec2(floor(gridPos));
  vec2 cellLocal = gridPos - vec2(cellId);

  // Aspect-preserving local pixel space, centered. The shape extent
  // uses the shorter cell axis so a circle stays a circle even when
  // rows/cols don't match the canvas aspect.
  vec2 cellPx = u_resolution / u_grid;
  float cellMinPx = min(cellPx.x, cellPx.y);
  vec2 p = (cellLocal - 0.5) * cellPx;

  // Per-cell randomness. Two hash calls give us 8 independent floats —
  // more than we need but cheap and lets us split unrelated decisions
  // across calls.
  vec4 r1 = hash44(cellId, u_seed);
  vec4 r2 = hash44(cellId, u_seed + 17.0);

  int shape = pickShape(u_shapeMask, r1.x);

  int copyRange = u_copiesMax - u_copiesMin + 1;
  int copies = u_copiesMin + int(r1.y * float(copyRange));
  copies = clamp(copies, 1, ${MAX_COPIES});

  float baseHue = r1.z;
  float cellPhase = r1.w * TAU;

  // Outermost band's high end is u_scaleMax * u_cellSize. Innermost
  // band's low end is u_scaleMin * u_cellSize. Each ring gets a slice
  // of that range so its animated scale can't escape its slot.
  float maxR = 0.5 * u_cellSize * cellMinPx;

  vec4 color = u_bg;

  for (int i = 0; i < ${MAX_COPIES}; i++) {
    if (i >= copies) break;

    float fOuter = float(i) / float(copies);          // band top fraction
    float fInner = float(i + 1) / float(copies);      // band bottom fraction
    // Bands span the [scaleMin, scaleMax] window, so ring 0's TOP is
    // scaleMax and the innermost ring's BOTTOM is scaleMin.
    float bandHi = mix(u_scaleMax, u_scaleMin, fOuter);
    float bandLo = mix(u_scaleMax, u_scaleMin, fInner);

    // Per-copy oscillation phase. Different multipliers per ring so
    // they don't pulse in lockstep.
    float copyPhase = float(i) * 1.7 + r2.x * TAU;
    float osc = 0.5 + 0.5 * sin(u_time * u_speed + cellPhase + copyPhase);
    float scaleFrac = mix(bandLo, bandHi, osc);
    if (u_lockBase != 0 && i == 0) scaleFrac = u_scaleMax;

    float r = scaleFrac * maxR;
    float d;
    if (shape == 0) d = sdCircle(p, r);
    else if (shape == 1) d = sdBox(p, r);
    else d = sdTriangle(p, r);

    float aa = fwidth(d);
    float alpha = 1.0 - smoothstep(-aa, aa, d);
    if (alpha > 0.0) {
      float rampPos = fract(baseHue + float(i) * u_hueShift + 1.0);
      vec4 c = sampleRamp(rampPos);
      color = mix(color, vec4(c.rgb, 1.0), alpha * c.a);
    }
  }

  outColor = color;
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

const stateKey = (nodeId: string) => `shape-cells:${nodeId}`;

// Default ramp matches the reference palette: pink, red, mustard, navy,
// cream, light gray. Spaced evenly across the ramp so a `hueShift` of
// ~0.17 walks one stop per copy.
const DEFAULT_STOPS: ColorRampStop[] = [
  { id: "sc-stop-0", position: 0.0,  color: "#e9479f" },
  { id: "sc-stop-1", position: 0.17, color: "#e32826" },
  { id: "sc-stop-2", position: 0.34, color: "#dba232" },
  { id: "sc-stop-3", position: 0.51, color: "#243e8a" },
  { id: "sc-stop-4", position: 0.68, color: "#f4ecd5" },
  { id: "sc-stop-5", position: 0.85, color: "#a8a8b0" },
  { id: "sc-stop-6", position: 1.0,  color: "#e9479f" },
];

export const shapeCellsNode: NodeDefinition = {
  type: "shape-cells",
  name: "Shape Cells",
  category: "image",
  subcategory: "generator",
  description:
    "Grid of cells with nested concentric shape copies. Per-cell shape, copy count and base hue are seeded; copy scales animate over time. Pipe Scene Time into `time` to drive motion.",
  facts: {
    space: { "in:time": "time" },
    reads: ["time"],
    gotchas: [
      "time falls back to ctx.time when the time input is unwired, so the grid keeps animating during normal playback even without Scene Time wired.",
      "If useCircle/useSquare/useTriangle are all off, pickShape falls back to circle rather than an empty cell.",
      "copiesMin/copiesMax pick a per-cell copy count via hashed seed, clamped to 1..8; lockBaseShape pins only the outermost ring to scaleMax.",
      "cellSize is a 0..1 fraction of the shorter cell axis (aspect-preserving), not the full cell width or height.",
      "hueShift advances the ramp per concentric copy: rampPos = fract(baseHue + i*hueShift), so 0.17 on the default 6-stop ramp moves one stop per ring.",
    ],
  },
  backend: "webgl2",
  stable: false,
  inputs: [
    { name: "time", type: "scalar", required: false },
  ],
  params: [
    OPACITY_PARAM,
    { name: "rows", label: "Rows", type: "scalar", min: 1, max: 64, step: 1, default: 5 },
    { name: "cols", label: "Columns", type: "scalar", min: 1, max: 64, step: 1, default: 9 },
    {
      name: "cellSize", label: "Cell Size", type: "scalar",
      min: 0.05, max: 1, step: 0.01, default: 0.8,
    },
    { name: "lockBaseShape", label: "Lock Base Shape", type: "boolean", default: true },
    { name: "useCircle", label: "Use Circle", type: "boolean", default: true },
    { name: "useSquare", label: "Use Square", type: "boolean", default: true },
    { name: "useTriangle", label: "Use Triangle", type: "boolean", default: true },
    { name: "copiesMin", label: "Copies Min", type: "scalar", min: 1, max: MAX_COPIES, step: 1, default: 1 },
    { name: "copiesMax", label: "Copies Max", type: "scalar", min: 1, max: MAX_COPIES, step: 1, default: 3 },
    {
      name: "scaleMin", label: "Scale Min", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 0.15,
    },
    {
      name: "scaleMax", label: "Scale Max", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 1.0,
    },
    {
      name: "ramp", label: "Color Ramp", type: "color_ramp",
      default: DEFAULT_STOPS,
    },
    rampInterpParam({ name: "interpolation", label: "Ramp Interp", default: "constant" }),
    rampSpaceParam({ name: "space", label: "Ramp Color Space" }),
    {
      name: "hueShift", label: "Hue Shift", type: "scalar",
      min: -1, max: 1, step: 0.01, default: 0.17,
    },
    { name: "speed", label: "Speed", type: "scalar", min: 0, max: 10, step: 0.01, default: 0.4 },
    { name: "seed", label: "Seed", type: "scalar", min: 0, max: 9999, step: 1, default: 42 },
    { name: "background", label: "Background", type: "color", default: "#000000" },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();

    const cols = Math.max(1, Math.floor((params.cols as number) ?? 9));
    const rows = Math.max(1, Math.floor((params.rows as number) ?? 5));
    const cellSize = Math.max(0.001, (params.cellSize as number) ?? 0.8);
    const copiesMinRaw = Math.max(1, Math.floor((params.copiesMin as number) ?? 1));
    const copiesMaxRaw = Math.max(1, Math.floor((params.copiesMax as number) ?? 3));
    const copiesMin = Math.min(copiesMinRaw, copiesMaxRaw);
    const copiesMax = Math.max(copiesMinRaw, copiesMaxRaw);
    const scaleMinRaw = Math.max(0, (params.scaleMin as number) ?? 0.15);
    const scaleMaxRaw = Math.max(0, (params.scaleMax as number) ?? 1);
    const scaleMin = Math.min(scaleMinRaw, scaleMaxRaw);
    const scaleMax = Math.max(scaleMinRaw, scaleMaxRaw);
    const hueShift = (params.hueShift as number) ?? 0.17;
    const speed = (params.speed as number) ?? 0.4;
    const seed = Math.floor((params.seed as number) ?? 42);

    const shapeMask =
      ((params.useCircle as boolean) ? 1 : 0) |
      ((params.useSquare as boolean) ? 2 : 0) |
      ((params.useTriangle as boolean) ? 4 : 0);
    const lockBase = (params.lockBaseShape as boolean) ?? true;

    const bgHex = (params.background as string) ?? "#000000";
    const [br, bg, bb] = hexToRgb(bgHex);

    // Pull time from socket if wired; else fall back to scene time so
    // the node animates during normal playback even when unwired.
    const timeIn = inputs["time"];
    const time = timeIn && timeIn.kind === "scalar" ? timeIn.value : ctx.time;

    const rawStops = Array.isArray(params.ramp)
      ? (params.ramp as ColorRampStop[])
      : [];
    const interp = normalizeRampInterp(params.interpolation ?? "constant");
    const space = normalizeRampSpace(params.space);
    const key = stateKey(nodeId);
    const lutState = (ctx.state[key] ??= {} as ColorRampLutState) as ColorRampLutState;
    const lut = getColorRampLut(ctx, lutState, rawStops, interp, space);

    const prog = ctx.getShader("shape-cells/fs-lut", SHAPE_CELLS_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, lut.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_lut"), 0);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_constant"),
        interp === "constant" ? 1 : 0
      );
      gl.uniform2f(gl.getUniformLocation(prog, "u_resolution"), output.width, output.height);
      gl.uniform2f(gl.getUniformLocation(prog, "u_grid"), cols, rows);
      gl.uniform1f(gl.getUniformLocation(prog, "u_cellSize"), cellSize);
      gl.uniform1f(gl.getUniformLocation(prog, "u_time"), time);
      gl.uniform1f(gl.getUniformLocation(prog, "u_speed"), speed);
      gl.uniform1f(gl.getUniformLocation(prog, "u_seed"), seed);
      gl.uniform1i(gl.getUniformLocation(prog, "u_copiesMin"), copiesMin);
      gl.uniform1i(gl.getUniformLocation(prog, "u_copiesMax"), copiesMax);
      gl.uniform1f(gl.getUniformLocation(prog, "u_scaleMin"), scaleMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_scaleMax"), scaleMax);
      gl.uniform1f(gl.getUniformLocation(prog, "u_hueShift"), hueShift);
      gl.uniform4f(gl.getUniformLocation(prog, "u_bg"), br, bg, bb, 1.0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_shapeMask"), shapeMask);
      gl.uniform1i(gl.getUniformLocation(prog, "u_lockBase"), lockBase ? 1 : 0);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    releaseColorRampLut(ctx, ctx.state[key] as ColorRampLutState | undefined);
    delete ctx.state[key];
  },
};
