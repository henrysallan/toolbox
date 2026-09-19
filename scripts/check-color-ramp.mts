// Guards the shared color-ramp sampler (specdocs/091626_ramp-space-interp.md):
// offset wrapping (offset 0 keeps t=1 on the last stop; any other offset
// slides t and wraps so 1.2 ≡ 0.2), every interpolation curve (through-
// the-stops modes land on the stops, monotone never overshoots, constant
// holds the left stop), every blend color space (OKLab mid-grey, linear
// light, OKLCH hue direction + gamut mapping), the GPU LUT bake, and that
// every ramp-bearing node declares the full shared vocabulary.
//
//   npx tsx scripts/check-color-ramp.mts

import {
  COLOR_RAMP_INTERP_OPTIONS,
  COLOR_RAMP_LUT_SIZE,
  COLOR_RAMP_SPACE_OPTIONS,
  buildColorRampLutData,
  makeColorRampSampler,
  normalizeRampInterp,
  normalizeRampSpace,
  offsetRampT,
  rgba01ToCss,
  sampleColorRamp,
  sampleColorRampRgba01,
  type ColorRampInterp,
  type ColorRampSpace,
  type ColorRampStop,
} from "../src/engine/color-ramp.ts";
import { rgbToOklab } from "../src/engine/color-space.ts";
import { colorRampNode } from "../src/nodes/effect/color-ramp.ts";
import { rasterizeSplineNode } from "../src/nodes/effect/rasterize-spline.ts";
import { strokeNode } from "../src/nodes/effect/stroke.ts";
import { diffusionCurvesNode } from "../src/nodes/effect/diffusion-curves.ts";
import { asciiNode } from "../src/nodes/effect/ascii.ts";
import { shapeCellsNode } from "../src/nodes/source/shape-cells.ts";
import { sdfMaterialNode } from "../src/nodes/sdf/material.ts";
import { instanceColor3DNode } from "../src/nodes/three/instance-color.ts";
import { material3DNode } from "../src/nodes/three/material.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}
const closeRgb = (a: number[], b: number[], eps = 1e-6) =>
  close(a[0], b[0], eps) && close(a[1], b[1], eps) && close(a[2], b[2], eps);

// ---- offset wrap -----------------------------------------------------------
{
  check("offset 0 leaves t=0", close(offsetRampT(0, 0), 0));
  check("offset 0 leaves t=1 (last stop, not fract-to-0)", close(offsetRampT(1, 0), 1));
  check("offset 0.25 slides t=0", close(offsetRampT(0, 0.25), 0.25));
  check("offset 0.25 wraps t=0.9 past 1", close(offsetRampT(0.9, 0.25), 0.15));
  check("offset 1.2 ≡ 0.2 at t=0", close(offsetRampT(0, 1.2), offsetRampT(0, 0.2)));
  check("offset 2 ≡ 0 at t=0.3", close(offsetRampT(0.3, 2), offsetRampT(0.3, 0)));
  check("negative offset wraps backward", close(offsetRampT(0.1, -0.3), 0.8));
}

{
  const stops: ColorRampStop[] = [
    { id: "a", position: 0, color: "#000000" },
    { id: "b", position: 1, color: "#ffffff" },
  ];
  const at = (t: number, offset = 0) =>
    sampleColorRampRgba01(stops, t, "linear", offset);

  check("unoffset t=0 is black", close(at(0)[0], 0));
  check("unoffset t=1 is white", close(at(1)[0], 1));
  check("offset 0.5 at t=0 is mid-gray", close(at(0, 0.5)[0], 0.5));
  check(
    "offset 0.25 at t=0.9 loops onto the start of the ramp",
    close(at(0.9, 0.25)[0], 0.15)
  );
  check(
    "offset 1.25 matches offset 0.25",
    close(at(0.4, 1.25)[0], at(0.4, 0.25)[0])
  );
  check(
    "offset applies to every mode (smooth, oklch)",
    close(
      sampleColorRampRgba01(stops, 0.9, "smooth", 0.25, "oklch")[0],
      sampleColorRampRgba01(stops, 0.15, "smooth", 0, "oklch")[0],
      1e-6
    )
  );
}

// ---- normalizers -----------------------------------------------------------
{
  check("normalizeRampInterp keeps legacy values", normalizeRampInterp("ease") === "ease" && normalizeRampInterp("constant") === "constant");
  check("normalizeRampInterp defaults unknown → linear", normalizeRampInterp("bogus") === "linear" && normalizeRampInterp(undefined) === "linear");
  check("normalizeRampSpace defaults unknown → srgb", normalizeRampSpace(undefined) === "srgb" && normalizeRampSpace("oklch_long") === "oklch_long");
}

// ---- curves ----------------------------------------------------------------
const FOUR: ColorRampStop[] = [
  { id: "a", position: 0, color: "#0b1e5b" },
  { id: "b", position: 0.35, color: "#ff4d6d", alpha: 0.5 },
  { id: "c", position: 0.6, color: "#ffd166" },
  { id: "d", position: 1, color: "#06d6a0" },
];
const hex01 = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
{
  const throughStops: ColorRampInterp[] = [
    "linear", "ease", "smoother", "sine", "ease_in", "ease_out", "cardinal", "monotone", "smooth",
  ];
  for (const interp of throughStops) {
    const s = makeColorRampSampler(FOUR, { interp });
    check(
      `${interp}: end stops exact`,
      closeRgb(s(0), hex01(FOUR[0].color), 1e-6) && closeRgb(s(1), hex01(FOUR[3].color), 1e-6),
      `${rgba01ToCss(s(0))} / ${rgba01ToCss(s(1))}`
    );
    let finite = true;
    let inRange = true;
    for (let i = 0; i <= 200; i++) {
      const c = s(i / 200);
      if (!c.every(Number.isFinite)) finite = false;
      if (c.some((v) => v < 0 || v > 1)) inRange = false;
    }
    check(`${interp}: finite and within 0..1 everywhere`, finite && inRange);
  }
  for (const interp of ["linear", "ease", "smoother", "sine", "ease_in", "ease_out", "cardinal", "monotone"] as ColorRampInterp[]) {
    const s = makeColorRampSampler(FOUR, { interp });
    check(
      `${interp}: passes through interior stops (color + alpha)`,
      closeRgb(s(0.35), hex01(FOUR[1].color), 1e-6) && close(s(0.35)[3], 0.5, 1e-6) && closeRgb(s(0.6), hex01(FOUR[2].color), 1e-6),
      rgba01ToCss(s(0.35))
    );
  }

  // Per-interval eases agree with their formulas at the interval midpoint.
  const bw: ColorRampStop[] = [
    { id: "a", position: 0, color: "#000000" },
    { id: "b", position: 1, color: "#ffffff" },
  ];
  const mid = (interp: ColorRampInterp, t: number) => sampleColorRampRgba01(bw, t, interp)[0];
  check("ease = smoothstep", close(mid("ease", 0.25), 0.25 * 0.25 * (3 - 0.5)));
  check("smoother = quintic", close(mid("smoother", 0.25), 0.25 ** 3 * (0.25 * (0.25 * 6 - 15) + 10)));
  check("sine = raised cosine", close(mid("sine", 0.25), 0.5 - 0.5 * Math.cos(Math.PI * 0.25)));
  check("ease_in = f²", close(mid("ease_in", 0.5), 0.25));
  check("ease_out = 1-(1-f)²", close(mid("ease_out", 0.5), 0.75));
  check("ease_in and ease_out are mirror images", close(mid("ease_in", 0.3), 1 - mid("ease_out", 0.7)));

  // Constant holds the left stop over the whole interval.
  const con = makeColorRampSampler(FOUR, { interp: "constant" });
  check(
    "constant: holds the left stop",
    closeRgb(con(0.34), hex01(FOUR[0].color)) && closeRgb(con(0.36), hex01(FOUR[1].color)) && closeRgb(con(0.99), hex01(FOUR[2].color)) && closeRgb(con(1), hex01(FOUR[3].color))
  );

  // A monotone channel stays monotone under monotone; cardinal may not.
  const ramp3: ColorRampStop[] = [
    { id: "a", position: 0, color: "#000000" },
    { id: "b", position: 0.2, color: "#f0f0f0" },
    { id: "c", position: 1, color: "#ffffff" },
  ];
  const isMonotone = (interp: ColorRampInterp) => {
    const s = makeColorRampSampler(ramp3, { interp });
    let prev = -1;
    for (let i = 0; i <= 400; i++) {
      const v = s(i / 400)[0];
      if (v < prev - 1e-9) return false;
      prev = v;
    }
    return true;
  };
  check("monotone: no overshoot on a steep-then-flat ramp", isMonotone("monotone"));
  check("cardinal: overshoots that ramp (documented trade-off)", !isMonotone("cardinal"));
  check("linear stays monotone", isMonotone("linear"));

  // Splines are smooth across the stop: the slope just before and just
  // after an interior knot agree (linear's kink does not).
  const slopeJump = (interp: ColorRampInterp) => {
    const s = makeColorRampSampler(FOUR, { interp: interp, space: "linear" });
    const h = 1e-3;
    const p = 0.6;
    const before = (s(p)[1] - s(p - h)[1]) / h;
    const after = (s(p + h)[1] - s(p)[1]) / h;
    return Math.abs(after - before);
  };
  check("cardinal is C¹ at a stop", slopeJump("cardinal") < 0.02, String(slopeJump("cardinal")));
  check("monotone is C¹ at a stop", slopeJump("monotone") < 0.02, String(slopeJump("monotone")));
  check("bspline is C¹ at a stop", slopeJump("bspline") < 0.02, String(slopeJump("bspline")));
  check("linear kinks at a stop", slopeJump("linear") > 0.1, String(slopeJump("linear")));

  // B-spline: end stops exact (reflected phantoms), interior approximated.
  const bs = makeColorRampSampler(FOUR, { interp: "bspline" });
  check("bspline: end stops exact", closeRgb(bs(0), hex01(FOUR[0].color), 1e-6) && closeRgb(bs(1), hex01(FOUR[3].color), 1e-6));
  check("bspline: interior stop is approximated, not pinned", !closeRgb(bs(0.35), hex01(FOUR[1].color), 1e-3));

  // Smooth: rounds the kink off but keeps ends.
  check("smooth: no plateau at stops (still moving)", Math.abs(slopeJump("smooth")) < 0.02);

  // Degenerate inputs.
  const one = makeColorRampSampler([FOUR[1]], { interp: "cardinal" });
  check("single stop: constant color", closeRgb(one(0), hex01(FOUR[1].color)) && closeRgb(one(1), hex01(FOUR[1].color)));
  const none = makeColorRampSampler([], { interp: "bspline", space: "oklch" });
  check("no stops: identity grey", closeRgb(none(0.3), [0.3, 0.3, 0.3]));
  const dup: ColorRampStop[] = [
    { id: "a", position: 0.5, color: "#ff0000" },
    { id: "b", position: 0.5, color: "#0000ff" },
  ];
  for (const interp of COLOR_RAMP_INTERP_OPTIONS) {
    const s = makeColorRampSampler(dup, { interp });
    check(`${interp}: coincident stops stay finite`, [0, 0.5, 1].every((t) => s(t).every(Number.isFinite)));
  }
}

// ---- color spaces ----------------------------------------------------------
{
  const bw: ColorRampStop[] = [
    { id: "a", position: 0, color: "#000000" },
    { id: "b", position: 1, color: "#ffffff" },
  ];
  const midOf = (space: ColorRampSpace) => sampleColorRampRgba01(bw, 0.5, "linear", 0, space);
  check("srgb mid-grey is 0.5", close(midOf("srgb")[0], 0.5));
  // linear light 0.5 → sRGB ≈ 0.7354
  check("linear mid-grey encodes to ≈0.735", close(midOf("linear")[0], 0.7354, 1e-3), String(midOf("linear")[0]));
  // OKLab L=0.5 → linear 0.125 → sRGB ≈ 0.3885
  check("oklab mid-grey has L=0.5 (sRGB ≈0.389)", close(midOf("oklab")[0], 0.3885, 1e-3), String(midOf("oklab")[0]));
  check("oklab mid-grey is neutral", close(midOf("oklab")[0], midOf("oklab")[1]) && close(midOf("oklab")[1], midOf("oklab")[2]));
  check("oklch between two greys stays grey", close(midOf("oklch")[0], midOf("oklch")[2]) && close(midOf("oklch")[0], midOf("oklab")[0], 1e-6));

  for (const space of COLOR_RAMP_SPACE_OPTIONS) {
    const s = makeColorRampSampler(FOUR, { space });
    check(`${space}: end stops round-trip exactly`, closeRgb(s(0), hex01(FOUR[0].color), 2e-6) && closeRgb(s(1), hex01(FOUR[3].color), 2e-6), rgba01ToCss(s(0)));
    let ok = true;
    for (let i = 0; i <= 200; i++) {
      const c = s(i / 200);
      if (!c.every(Number.isFinite) || c.some((v) => v < 0 || v > 1)) ok = false;
    }
    check(`${space}: every sample finite and in gamut`, ok);
  }

  // OKLab: lightness moves evenly (the point of the space).
  const by: ColorRampStop[] = [
    { id: "a", position: 0, color: "#1a4bff" },
    { id: "b", position: 1, color: "#ffd60a" },
  ];
  const Lof = (space: ColorRampSpace, t: number) => {
    const c = sampleColorRampRgba01(by, t, "linear", 0, space);
    return rgbToOklab(c[0], c[1], c[2])[0];
  };
  const L0 = Lof("oklab", 0);
  const L1 = Lof("oklab", 1);
  check("oklab: L at t=0.5 is the midpoint of the end lightnesses", close(Lof("oklab", 0.5), (L0 + L1) / 2, 1e-3));
  check("srgb: L at t=0.5 dips below the midpoint (the muddy middle)", Lof("srgb", 0.5) < (L0 + L1) / 2 - 0.02);

  // OKLCH short vs long: blue→yellow hue difference ≈ 160°; the short
  // path passes through green-ish, the long path through magenta/red.
  const shortMid = sampleColorRampRgba01(by, 0.5, "linear", 0, "oklch");
  const longMid = sampleColorRampRgba01(by, 0.5, "linear", 0, "oklch_long");
  check("oklch short: blue→yellow midpoint is green-dominant", shortMid[1] > shortMid[0] && shortMid[1] > shortMid[2], rgba01ToCss(shortMid));
  check("oklch long: blue→yellow midpoint is red-dominant", longMid[0] > longMid[1], rgba01ToCss(longMid));
  // Chroma stays up in OKLCH where OKLab desaturates.
  const chroma = (c: number[]) => {
    const [, a, b] = rgbToOklab(c[0], c[1], c[2]);
    return Math.hypot(a, b);
  };
  check("oklch keeps more chroma mid-ramp than oklab", chroma(shortMid) > chroma(sampleColorRampRgba01(by, 0.5, "linear", 0, "oklab")) + 0.02);

  // Hue unwrap across a grey: grey stop borrows a neighbour's hue, so no
  // spurious turn is introduced (red → grey → red stays red-hued).
  const rgr: ColorRampStop[] = [
    { id: "a", position: 0, color: "#ff0000" },
    { id: "b", position: 0.5, color: "#808080" },
    { id: "c", position: 1, color: "#ff0000" },
  ];
  const q = sampleColorRampRgba01(rgr, 0.25, "linear", 0, "oklch");
  check("oklch: grey stop borrows neighbour hue (no green detour)", q[0] > q[1] && q[0] > q[2], rgba01ToCss(q));

  // Same hue under oklch_long = a full turn (documented behaviour).
  const rr: ColorRampStop[] = [
    { id: "a", position: 0, color: "#ff0000" },
    { id: "b", position: 1, color: "#ff0000" },
  ];
  const half = sampleColorRampRgba01(rr, 0.5, "linear", 0, "oklch_long");
  check("oklch_long between identical hues makes a full rainbow turn", half[0] < 0.5 && (half[1] > 0.3 || half[2] > 0.3), rgba01ToCss(half));

  // Spline in OKLCH is still through the stops.
  const sp = makeColorRampSampler(FOUR, { interp: "monotone", space: "oklch" });
  check("monotone × oklch: stops exact", closeRgb(sp(0.35), hex01(FOUR[1].color), 2e-4) && closeRgb(sp(0.6), hex01(FOUR[2].color), 2e-4), rgba01ToCss(sp(0.35)));
}

// ---- css string path -------------------------------------------------------
{
  const wb: ColorRampStop[] = [
    { id: "a", position: 0, color: "#ffffff" },
    { id: "b", position: 1, color: "#000000", alpha: 0.5 },
  ];
  check("sampleColorRamp: rgba() string, 8-bit channels, float alpha", sampleColorRamp(wb, 0.5) === "rgba(128, 128, 128, 0.75)", sampleColorRamp(wb, 0.5));
  check("sampleColorRamp: space arg honoured", sampleColorRamp(wb, 0.5, "linear", 0, "oklab") !== sampleColorRamp(wb, 0.5), sampleColorRamp(wb, 0.5, "linear", 0, "oklab"));
}

// ---- GPU LUT bake ----------------------------------------------------------
{
  const data = buildColorRampLutData(FOUR, "monotone", "oklab");
  check("LUT: 1024 RGBA texels", data.length === COLOR_RAMP_LUT_SIZE * 4);
  const s = makeColorRampSampler(FOUR, { interp: "monotone", space: "oklab" });
  const i = 300;
  const c = s((i + 0.5) / COLOR_RAMP_LUT_SIZE);
  check("LUT: texel i holds the sample at its centre", close(data[i * 4], c[0]) && close(data[i * 4 + 3], c[3]));
  check("LUT: first / last texels sit on the end colors (±1/2048)", close(data[0], hex01(FOUR[0].color)[0], 0.01) && close(data[(COLOR_RAMP_LUT_SIZE - 1) * 4 + 2], hex01(FOUR[3].color)[2], 0.01));
}

// ---- node surface: every ramp-bearing node shares the vocabulary ----------
{
  const expectInterp = [...COLOR_RAMP_INTERP_OPTIONS];
  const expectSpace = [...COLOR_RAMP_SPACE_OPTIONS];
  const same = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  const sites: Array<[string, { params: Array<{ name: string; options?: string[]; default: unknown }> }, string, string, string]> = [
    ["Color Ramp", colorRampNode, "interpolation", "space", "linear"],
    ["Rasterize Spline fill", rasterizeSplineNode, "ramp_interp", "ramp_space", "linear"],
    ["Rasterize Spline stroke", rasterizeSplineNode, "stroke_ramp_interp", "stroke_ramp_space", "linear"],
    ["Stroke", strokeNode, "ramp_interp", "ramp_space", "linear"],
    ["Diffusion Curves", diffusionCurvesNode, "ramp_interp", "ramp_space", "linear"],
    ["ASCII fg", asciiNode, "fg_ramp_interp", "fg_ramp_space", "linear"],
    ["ASCII bg", asciiNode, "bg_ramp_interp", "bg_ramp_space", "linear"],
    ["Shape Cells", shapeCellsNode, "interpolation", "space", "constant"],
    ["SDF Material", sdfMaterialNode, "interpolation", "space", "linear"],
    ["Instance Color", instanceColor3DNode, "ramp_interp", "ramp_space", "linear"],
    ["Material (toon)", material3DNode, "toon_interp", "toon_space", "constant"],
  ];
  for (const [label, node, interpName, spaceName, def] of sites) {
    const byName = new Map(node.params.map((p) => [p.name, p]));
    const ip = byName.get(interpName);
    const sp = byName.get(spaceName);
    check(`${label}: ${interpName} offers every curve (default ${def})`, !!ip && same(ip.options, expectInterp) && ip.default === def, JSON.stringify(ip?.options));
    check(`${label}: ${spaceName} offers every space (default srgb)`, !!sp && same(sp.options, expectSpace) && sp.default === "srgb", JSON.stringify(sp?.options));
  }
  const names2 = rasterizeSplineNode.params.map((p) => p.name);
  check("Rasterize Spline declares stroke_ramp_offset", names2.includes("stroke_ramp_offset"));
  // Space param follows its interp param's visibility.
  const vis = (node: { params: Array<{ name: string; visibleIf?: (p: Record<string, unknown>) => boolean }> }, name: string, p: Record<string, unknown>) =>
    node.params.find((x) => x.name === name)?.visibleIf?.(p) ?? true;
  const g = { enable_fill: true, fill_source: "gradient" };
  check("ramp_space visible with gradient fill", vis(rasterizeSplineNode, "ramp_space", g) && !vis(rasterizeSplineNode, "ramp_space", { enable_fill: true, fill_source: "flat" }));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll color-ramp checks passed.");
