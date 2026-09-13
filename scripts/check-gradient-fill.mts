// Guards Rasterize Spline's per-subpath gradient fill
// (specdocs/091026_local-gradient-fill.md): the geometry-derived frame
// follows a copy's rotation / scale / mirror, the extent lands on the
// outline, ramp → Canvas stops honor each interp + the wrap seam, and a
// degenerate frame falls back to a solid color instead of painting
// nothing.
//
//   npx tsx scripts/check-gradient-fill.mts

import type { SplineSubpath } from "../src/engine/types.ts";
import type { ColorRampStop } from "../src/engine/color-ramp.ts";
import {
  makeSubpathGradientFn,
  rampToGradientStops,
  subpathGradientFrame,
  type GradientCanvas,
} from "../src/engine/spline-gradient-fill.ts";
import { transformSubpath } from "../src/engine/spline-transform.ts";
import { rasterizeSplineNode } from "../src/nodes/effect/rasterize-spline.ts";

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

// Circle-ordered square (top, right, bottom, left — the primitive's anchor
// order) centered at (0.5, 0.5), half-size 0.1.
function square(): SplineSubpath {
  return {
    closed: true,
    anchors: [
      { pos: [0.5, 0.4] },
      { pos: [0.6, 0.5] },
      { pos: [0.5, 0.6] },
      { pos: [0.4, 0.5] },
    ],
  };
}

// 4-cubic circle, radius r, Circle primitive layout.
function circle(cx: number, cy: number, r: number): SplineSubpath {
  const k = 0.5522847498 * r;
  return {
    closed: true,
    anchors: [
      { pos: [cx, cy - r], inHandle: [-k, 0], outHandle: [k, 0] },
      { pos: [cx + r, cy], inHandle: [0, -k], outHandle: [0, k] },
      { pos: [cx, cy + r], inHandle: [k, 0], outHandle: [-k, 0] },
      { pos: [cx - r, cy], inHandle: [0, k], outHandle: [0, -k] },
    ],
  };
}

const xf = (sub: SplineSubpath, o: Partial<Parameters<typeof transformSubpath>[1]>) =>
  transformSubpath(sub, {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
    rotateDeg: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    ...o,
  });

// ---- frame: shape mode --------------------------------------------------
{
  const f = subpathGradientFrame(square(), "shape", 0)!;
  check("shape frame origin = anchor mean", close(f.cx, 0.5) && close(f.cy, 0.5));
  check(
    "first anchor at top ⇒ angle 0 is left→right",
    close(f.dirX, 1) && close(f.dirY, 0),
    `dir=(${f.dirX}, ${f.dirY})`
  );
  check(
    "extent lands on the outline (±0.1 along x)",
    close(f.minProj, -0.1) && close(f.maxProj, 0.1),
    `[${f.minProj}, ${f.maxProj}]`
  );
  check("radius = farthest outline point", close(f.radius, 0.1));

  const f45 = subpathGradientFrame(square(), "shape", 45)!;
  check(
    "angle 45 projects the diamond's corner span",
    close(f45.maxProj - f45.minProj, 0.2 * Math.SQRT1_2 * 2, 1e-6) ||
      close(f45.maxProj - f45.minProj, 0.2 * Math.SQRT1_2, 1e-6),
    `span=${f45.maxProj - f45.minProj}`
  );
  check(
    "angle 90 is top→bottom (+y in Y-down)",
    close(subpathGradientFrame(square(), "shape", 90)!.dirY, 1)
  );
}

// ---- frame covariance: rotate / scale / mirror --------------------------
{
  const base = subpathGradientFrame(square(), "shape", 0)!;
  const rot = xf(square(), { rotateDeg: 30 });
  const fr = subpathGradientFrame(rot, "shape", 0)!;
  // Expected: the axis turned by exactly the angle the first anchor turned.
  const a0 = square().anchors[0].pos;
  const a1 = rot.anchors[0].pos;
  const delta =
    Math.atan2(a1[1] - fr.cy, a1[0] - fr.cx) -
    Math.atan2(a0[1] - base.cy, a0[0] - base.cx);
  const ex = Math.cos(delta) * base.dirX - Math.sin(delta) * base.dirY;
  const ey = Math.sin(delta) * base.dirX + Math.cos(delta) * base.dirY;
  check(
    "rotated copy ⇒ axis rotates with it",
    close(fr.dirX, ex, 1e-6) && close(fr.dirY, ey, 1e-6) && !close(delta, 0),
    `delta=${(delta * 180) / Math.PI}° dir=(${fr.dirX}, ${fr.dirY}) exp=(${ex}, ${ey})`
  );
  check(
    "rotated copy keeps its span",
    close(fr.maxProj - fr.minProj, base.maxProj - base.minProj, 1e-6)
  );

  const big = subpathGradientFrame(xf(square(), { scaleX: 2, scaleY: 2 }), "shape", 0)!;
  check(
    "scaled copy ⇒ span and radius scale",
    close(big.maxProj - big.minProj, 0.4, 1e-6) && close(big.radius, 0.2, 1e-6)
  );

  const mir = subpathGradientFrame(xf(square(), { scaleX: -1 }), "shape", 0)!;
  check(
    "mirrored copy ⇒ axis mirrors (left→right becomes right→left)",
    close(mir.dirX, -1, 1e-6) && close(mir.dirY, 0, 1e-6),
    `dir=(${mir.dirX}, ${mir.dirY})`
  );
  const mir90 = subpathGradientFrame(xf(square(), { scaleX: -1 }), "shape", 90)!;
  check(
    "mirror about a vertical axis keeps top→bottom",
    close(mir90.dirY, 1, 1e-6),
    `dir=(${mir90.dirX}, ${mir90.dirY})`
  );

  const canvasRot = subpathGradientFrame(rot, "canvas", 0)!;
  check(
    "canvas frame ignores the copy's rotation",
    close(canvasRot.dirX, 1) && close(canvasRot.dirY, 0)
  );
  const canvasMir = subpathGradientFrame(xf(square(), { scaleX: -1 }), "canvas", 0)!;
  check("canvas frame ignores mirroring", close(canvasMir.dirX, 1));
}

// ---- curved outline: sampled extent tracks the bezier --------------------
{
  const c = subpathGradientFrame(circle(0.3, 0.7, 0.12), "shape", 0)!;
  check("circle radius from sampled outline", close(c.radius, 0.12, 0.12 * 0.005), `r=${c.radius}`);
  const c45 = subpathGradientFrame(circle(0.3, 0.7, 0.12), "shape", 45)!;
  check(
    "circle span at 45° ≈ diameter (not the control-point hull)",
    close(c45.maxProj - c45.minProj, 0.24, 0.24 * 0.005),
    `span=${c45.maxProj - c45.minProj}`
  );
}

// ---- ramp → Canvas stops --------------------------------------------------
{
  const wb: ColorRampStop[] = [
    { id: "a", position: 0, color: "#ffffff" },
    { id: "b", position: 1, color: "#000000" },
  ];
  const lin = rampToGradientStops(wb, "linear", 0);
  check(
    "linear: one stop per ramp stop",
    lin.length === 2 &&
      lin[0].pos === 0 &&
      lin[0].color === "rgba(255, 255, 255, 1)" &&
      lin[1].pos === 1 &&
      lin[1].color === "rgba(0, 0, 0, 1)",
    JSON.stringify(lin)
  );

  const rb: ColorRampStop[] = [
    { id: "a", position: 0, color: "#ff0000" },
    { id: "b", position: 0.5, color: "#0000ff" },
  ];
  const con = rampToGradientStops(rb, "constant", 0);
  check(
    "constant: doubled stops hold each interval's left color",
    con.length === 4 &&
      con[0].pos === 0 &&
      con[0].color === "rgba(255, 0, 0, 1)" &&
      con[1].pos === 0.5 &&
      con[1].color === "rgba(255, 0, 0, 1)" &&
      con[2].pos === 0.5 &&
      con[2].color === "rgba(0, 0, 255, 1)" &&
      con[3].pos === 1 &&
      con[3].color === "rgba(0, 0, 255, 1)",
    JSON.stringify(con)
  );

  const ease = rampToGradientStops(wb, "ease", 0);
  const monotone = ease.every((s, i) => i === 0 || s.pos >= ease[i - 1].pos);
  check(
    "ease: subdivided, monotone, ends preserved",
    ease.length > 2 &&
      monotone &&
      ease[0].color === "rgba(255, 255, 255, 1)" &&
      ease[ease.length - 1].color === "rgba(0, 0, 0, 1)",
    JSON.stringify(ease)
  );
  const mid = ease.find((s) => close(s.pos, 0.5, 1e-9));
  check("ease: midpoint is the smoothstep midpoint (128)", mid?.color === "rgba(128, 128, 128, 1)", mid?.color);

  const off = rampToGradientStops(wb, "linear", 0.25);
  const seam = off.filter((s) => close(s.pos, 0.75, 1e-9));
  check(
    "offset 0.25: seam at u=0.75 with a doubled stop (black | white)",
    seam.length === 2 &&
      seam[0].color === "rgba(0, 0, 0, 1)" &&
      seam[1].color === "rgba(255, 255, 255, 1)",
    JSON.stringify(off)
  );
  check(
    "offset 0.25: u=0 samples t=0.25",
    off[0].pos === 0 && off[0].color === "rgba(191, 191, 191, 1)",
    off[0].color
  );
  const offInt = rampToGradientStops(wb, "linear", 1);
  check(
    "integer offset: end stop stays the last color (no fract-to-0 glitch)",
    offInt[offInt.length - 1].color === "rgba(0, 0, 0, 1)",
    JSON.stringify(offInt)
  );

  const none = rampToGradientStops([], "linear", 0);
  check(
    "no stops: black→white fallback",
    none.length === 2 &&
      none[0].color === "rgba(0, 0, 0, 1)" &&
      none[1].color === "rgba(255, 255, 255, 1)"
  );
}

// ---- resolver against a recording canvas ---------------------------------
interface FakeGradient {
  kind: string;
  args: number[];
  stops: Array<[number, string]>;
  addColorStop(p: number, c: string): void;
}
function fakeCanvas(): GradientCanvas & { made: FakeGradient[] } {
  const made: FakeGradient[] = [];
  const mk = (kind: string, args: number[]): CanvasGradient => {
    const g: FakeGradient = {
      kind,
      args,
      stops: [],
      addColorStop(p, c) {
        this.stops.push([p, c]);
      },
    };
    made.push(g);
    return g as unknown as CanvasGradient;
  };
  return {
    made,
    createLinearGradient: (...a: number[]) => mk("linear", a),
    createRadialGradient: (...a: number[]) => mk("radial", a),
    createConicGradient: (...a: number[]) => mk("conic", a),
  };
}
const wb: ColorRampStop[] = [
  { id: "a", position: 0, color: "#ffffff" },
  { id: "b", position: 1, color: "#000000" },
];
const baseCfg = {
  kind: "linear" as const,
  frame: "shape" as const,
  angleDeg: 0,
  scale: 1,
  offset: 0,
  stops: wb,
  interp: "linear" as const,
  vary: "none" as const,
  varyAmount: 0.5,
  seed: 0,
  varyAngleDeg: 0,
};
{
  const c2d = fakeCanvas();
  const at = makeSubpathGradientFn(c2d, [square()], baseCfg, 1920, 1080);
  const g = at(0, square()) as unknown as FakeGradient;
  check(
    "linear: endpoints in device px with aspect-corrected y",
    g.kind === "linear" &&
      close(g.args[0], 0.4 * 1920) &&
      close(g.args[1], 540) &&
      close(g.args[2], 0.6 * 1920) &&
      close(g.args[3], 540),
    JSON.stringify(g.args)
  );
  check("linear: stops copied onto the gradient", g.stops.length === 2 && g.stops[1][1] === "rgba(0, 0, 0, 1)");

  const rad = makeSubpathGradientFn(c2d, [square()], { ...baseCfg, kind: "radial", scale: 2 }, 1000, 1000)(0, square()) as unknown as FakeGradient;
  check(
    "radial: centered, radius = outline radius × scale × W",
    rad.kind === "radial" &&
      close(rad.args[0], 500) &&
      close(rad.args[1], 500) &&
      close(rad.args[2], 0) &&
      close(rad.args[5], 0.1 * 2 * 1000, 1e-6),
    JSON.stringify(rad.args)
  );

  const con = makeSubpathGradientFn(c2d, [square()], { ...baseCfg, kind: "conic", angleDeg: 90 }, 1000, 1000)(0, square()) as unknown as FakeGradient;
  check(
    "conic: start angle follows the frame (90° ⇒ +y)",
    con.kind === "conic" && close(con.args[0], Math.PI / 2, 1e-9) && close(con.args[1], 500),
    JSON.stringify(con.args)
  );

  const scaled = makeSubpathGradientFn(c2d, [square()], { ...baseCfg, scale: 0.5 }, 1000, 1000)(0, square()) as unknown as FakeGradient;
  check(
    "scale 0.5 halves the span about the middle",
    close(scaled.args[0], 450) && close(scaled.args[2], 550),
    JSON.stringify(scaled.args)
  );

  const dot: SplineSubpath = { closed: true, anchors: [{ pos: [0.5, 0.5] }] };
  const solid = makeSubpathGradientFn(c2d, [dot], baseCfg, 1000, 1000)(0, dot);
  check("degenerate frame ⇒ solid rgba string, not an empty gradient", typeof solid === "string" && solid.startsWith("rgba("), String(solid));

  const subs = [square(), xf(square(), { translateX: 0.3 })];
  const varied = makeSubpathGradientFn(c2d, subs, { ...baseCfg, vary: "index", varyAmount: 0.5 }, 1000, 1000);
  const g0 = varied(0, subs[0]) as unknown as FakeGradient;
  const g1 = varied(1, subs[1]) as unknown as FakeGradient;
  check(
    "vary=index shifts the second copy's phase (seam appears), first stays put",
    g0.stops.length === 2 && g1.stops.length > 2 && g1.stops.some(([p]) => close(p, 0.5, 1e-3)),
    `g0=${JSON.stringify(g0.stops)} g1=${JSON.stringify(g1.stops)}`
  );
}

// ---- node surface ---------------------------------------------------------
{
  const byName = new Map(rasterizeSplineNode.params.map((p) => [p.name, p]));
  const fs = byName.get("fill_source");
  check(
    "fill_source offers gradient",
    !!fs && Array.isArray(fs.options) && fs.options.includes("gradient")
  );
  for (const n of [
    "gradient_kind",
    "gradient_frame",
    "gradient_angle",
    "gradient_scale",
    "gradient_offset",
    "gradient_vary",
    "gradient_vary_amount",
  ]) {
    check(`declares ${n}`, byName.has(n));
  }
  const vis = (name: string, p: Record<string, unknown>) =>
    byName.get(name)?.visibleIf?.(p) ?? true;
  const g = { enable_fill: true, fill_source: "gradient" };
  check("gradient hides stack_subpaths / fill_rule", !vis("stack_subpaths", g) && !vis("fill_rule", { ...g, stack_subpaths: false }));
  check("gradient shows fill_ramp + ramp_interp", vis("fill_ramp", g) && vis("ramp_interp", g));
  check("gradient_angle hidden for radial", !vis("gradient_angle", { ...g, gradient_kind: "radial" }));
  check("gradient_scale hidden for conic", !vis("gradient_scale", { ...g, gradient_kind: "conic" }));
  check("ramp_seed follows gradient_vary=random", vis("ramp_seed", { ...g, gradient_vary: "random" }) && !vis("ramp_seed", { ...g, gradient_vary: "index" }));
  check("driver_attr follows gradient_vary=driver", vis("driver_attr", { ...g, gradient_vary: "driver" }));
  check("legacy save (no fill_source) still shows stack_subpaths", vis("stack_subpaths", { enable_fill: true }));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll gradient-fill checks passed.");
