// Guards the M0 transform math for layer transforms + parenting
// (specdocs/101526_layer-transforms-parenting.md §1):
//   - composeOpsToCanvasAffine is rigid in pixels on non-square canvases and
//     lands an image exactly where a shape under the same ops lands;
//   - decomposeAffineToTrs round-trips TRS, refuses shear / mirror /
//     collapse, and gives the parenting compensation that holds a child's
//     world placement.
//   - the aspect-rigid image TRS (specdocs/101526_aspect-rigid-rotation.md):
//     the shaders' inverse map (imageTrsInverseUv, line for line with
//     TRANSFORM_FS / FIT_FS / Text) equals composeOpsToCanvasAffine for
//     Transform / Image / Video, is rigid for Text while keeping its uv01
//     translate, reproduces the old per-axis shader exactly for legacySkew,
//     and the TransformGizmo's frame box lands on the image's corners.
// Also prints the per-axis skew the legacySkew path keeps, as a measurement.
//
//   npx tsx scripts/check-layer-transform-math.mts

import type { TransformOp } from "../src/engine/types.ts";
import { aspectCorrectY } from "../src/engine/aspect.ts";
import { pointsFromArray } from "../src/engine/points.ts";
import { aspectUncorrectY } from "../src/engine/aspect.ts";
import {
  applyTransformToPoints,
  composeOpsToAffine,
  composeOpsToCanvasAffine,
  composeTransform,
  decomposeAffineToTrs,
  imageTrsInverseUv,
  imageTrsUniforms,
  invertAffine,
  multiplyAffine,
  opFromParams,
  trsAspect,
  trsToAffine,
  type Affine2D,
} from "../src/engine/transform-value.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

function affineClose(m: Affine2D, n: Affine2D, eps = 1e-6): boolean {
  return (
    close(m.a, n.a, eps) &&
    close(m.b, n.b, eps) &&
    close(m.c, n.c, eps) &&
    close(m.d, n.d, eps) &&
    close(m.tx, n.tx, eps) &&
    close(m.ty, n.ty, eps)
  );
}

const fmt = (m: Affine2D) =>
  `[${[m.a, m.b, m.tx, m.c, m.d, m.ty].map((v) => v.toFixed(5)).join(", ")}]`;

const op = (o: Partial<TransformOp>): TransformOp => ({
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotateDeg: 0,
  pivotX: 0.5,
  pivotY: 0.5,
  ...o,
});

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(1015);
const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
const randomOp = (uniform = false): TransformOp => {
  const sx = between(0.3, 2.5);
  return op({
    translateX: between(-0.4, 0.4),
    translateY: between(-0.4, 0.4),
    scaleX: sx,
    scaleY: uniform ? sx : between(0.3, 2.5),
    rotateDeg: between(-180, 180),
    pivotX: between(0, 1),
    pivotY: between(0, 1),
  });
};

// Linear part of a canvas01 affine, measured in pixels on a W×H canvas:
// D · L · D⁻¹ with D = diag(W, H).
function pixelLinear(m: Affine2D, W: number, H: number) {
  return { a: m.a, b: (m.b * W) / H, c: (m.c * H) / W, d: m.d };
}
function columnAngleDeg(l: { a: number; b: number; c: number; d: number }) {
  const dot = l.a * l.b + l.c * l.d;
  const n1 = Math.hypot(l.a, l.c);
  const n2 = Math.hypot(l.b, l.d);
  return (Math.acos(dot / (n1 * n2)) * 180) / Math.PI;
}

const W = 1920;
const H = 1080;
const aspect = W / H;

// ── Measurement: the legacySkew per-axis image path on 16:9 ────────────
{
  const l = pixelLinear(composeOpsToAffine([op({ rotateDeg: 45 })]), W, H);
  const angle = columnAngleDeg(l);
  const stretch = Math.hypot(l.a, l.c) / Math.hypot(l.b, l.d);
  console.log(
    `MEASURE  legacySkew canvas01 45° rotate on ${W}×${H}: pixel axes at ${angle.toFixed(
      2
    )}° (rigid = 90°), axis length ratio ${stretch.toFixed(3)} (rigid = 1)`
  );
}

// ── composeOpsToCanvasAffine ───────────────────────────────────────────
{
  const ops = [op({ rotateDeg: 45 })];
  const l = pixelLinear(composeOpsToCanvasAffine(ops, aspect), W, H);
  check(
    "canvas affine: 45° rotate keeps pixel axes perpendicular on 16:9",
    close(columnAngleDeg(l), 90, 1e-6),
    `got ${columnAngleDeg(l)}°`
  );
  check(
    "canvas affine: 45° rotate keeps pixel axis lengths equal on 16:9",
    close(Math.hypot(l.a, l.c), Math.hypot(l.b, l.d)),
    `got ${Math.hypot(l.a, l.c)} vs ${Math.hypot(l.b, l.d)}`
  );
}

{
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const ops = [randomOp(true), randomOp(true)];
    const l = pixelLinear(composeOpsToCanvasAffine(ops, aspect), W, H);
    worst = Math.max(worst, Math.abs(columnAngleDeg(l) - 90));
  }
  check(
    "canvas affine: uniform-scale chains stay rigid in pixels (200 random)",
    worst < 1e-6,
    `worst deviation ${worst}°`
  );
}

{
  const ops = [randomOp(), randomOp()];
  check(
    "canvas affine: aspect 1 equals composeOpsToAffine",
    affineClose(composeOpsToCanvasAffine(ops, 1), composeOpsToAffine(ops))
  );
}

{
  // A shape point authored at p renders at canvas (p.x, aspectCorrectY(p.y)).
  // Under the same ops, the image path must land that canvas point where
  // the geometry path lands the shape.
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const ops = [randomOp(), randomOp()];
    const t = { kind: "transform" as const, ops };
    const px = between(0, 1);
    const py = between(0, 1);
    const moved = applyTransformToPoints(
      pointsFromArray([{ pos: [px, py], rotation: 0, scale: [1, 1] }]),
      t
    );
    const gx = moved.positions[0];
    const gy = aspectCorrectY(moved.positions[1], aspect);
    const m = composeOpsToCanvasAffine(ops, aspect);
    const cy = aspectCorrectY(py, aspect);
    const ix = m.a * px + m.b * cy + m.tx;
    const iy = m.c * px + m.d * cy + m.ty;
    worst = Math.max(worst, Math.hypot(ix - gx, iy - gy));
  }
  check(
    "canvas affine: image lands where geometry lands (200 random, 16:9)",
    worst < 1e-6,
    `worst error ${worst}`
  );
}

// ── Aspect-rigid image TRS (101526_aspect-rigid-rotation.md) ───────────
// Params as the nodes store them; scales positive like Transform's clamp.
const randomParams = (): Record<string, number> => ({
  translateX: between(-0.4, 0.4),
  translateY: between(-0.4, 0.4),
  scaleX: between(0.3, 2.5),
  scaleY: between(0.3, 2.5),
  rotate: between(-180, 180),
  pivotX: between(0, 1),
  pivotY: between(0, 1),
});
// v_uv (Y-up) ↔ canvas01 (Y-down).
const flip = (p: [number, number]): [number, number] => [p[0], 1 - p[1]];
const apply = (m: Affine2D, p: [number, number]): [number, number] => [
  m.a * p[0] + m.b * p[1] + m.tx,
  m.c * p[0] + m.d * p[1] + m.ty,
];
// Pixel-space linear part of the FORWARD map the inverse sampler `inv`
// implies, by central differences (inv is affine, so this is exact up to
// rounding): D · J⁻¹ · D⁻¹ with J the canvas01 Jacobian of inv.
function pixelLinearOfInverse(
  inv: (uv: [number, number]) => [number, number],
  W: number,
  H: number
) {
  const h = 1e-3;
  const at = (x: number, y: number) => flip(inv(flip([x, y])));
  const dx0 = at(0.5 + h, 0.5);
  const dx1 = at(0.5 - h, 0.5);
  const dy0 = at(0.5, 0.5 + h);
  const dy1 = at(0.5, 0.5 - h);
  const j = {
    a: (dx0[0] - dx1[0]) / (2 * h),
    c: (dx0[1] - dx1[1]) / (2 * h),
    b: (dy0[0] - dy1[0]) / (2 * h),
    d: (dy0[1] - dy1[1]) / (2 * h),
  };
  const fwd = invertAffine({ ...j, tx: 0, ty: 0 })!;
  return pixelLinear(fwd, W, H);
}

{
  // Transform / Image / Video: the shader inverse IS composeOpsToCanvasAffine.
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const params = randomParams();
    const u = imageTrsUniforms(params, aspect);
    const inv = invertAffine(
      composeOpsToCanvasAffine([opFromParams(params)], aspect)
    )!;
    for (let k = 0; k < 4; k++) {
      const uv: [number, number] = [between(-0.5, 1.5), between(-0.5, 1.5)];
      const got = imageTrsInverseUv(u, uv);
      const want = flip(apply(inv, flip(uv)));
      worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1]));
    }
  }
  check(
    "rigid image TRS: shader inverse ≡ composeOpsToCanvasAffine⁻¹ (200 random, 16:9)",
    worst < 1e-9,
    `worst error ${worst}`
  );
}

for (const [label, negate, authoredY] of [
  ["Transform / Image / Video", false, true],
  ["Text", true, false],
] as const) {
  const u = imageTrsUniforms({ rotate: 45, scaleX: 1, scaleY: 1 }, aspect, authoredY);
  const l = pixelLinearOfInverse((uv) => imageTrsInverseUv(u, uv, negate), W, H);
  check(
    `rigid image TRS (${label}): 45° keeps pixel axes perpendicular and equal on 16:9`,
    close(columnAngleDeg(l), 90, 1e-6) &&
      close(Math.hypot(l.a, l.c), Math.hypot(l.b, l.d), 1e-6),
    `axes ${columnAngleDeg(l)}°, lengths ${Math.hypot(l.a, l.c)} / ${Math.hypot(l.b, l.d)}`
  );
}

{
  // Text keeps uv01 translate / pivot: the pivot lands at pivot + translate.
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const params = randomParams();
    const u = imageTrsUniforms(params, aspect, false);
    const px = params.pivotX as number;
    const py = params.pivotY as number;
    const out = flip([
      px + (params.translateX as number),
      py + (params.translateY as number),
    ]);
    const src = flip(imageTrsInverseUv(u, out, true));
    worst = Math.max(worst, Math.hypot(src[0] - px, src[1] - py));
  }
  check(
    "rigid Text TRS: uv01 pivot lands at pivot + translate (200 random, 16:9)",
    worst < 1e-9,
    `worst error ${worst}`
  );
}

{
  // legacySkew: aspect 1, raw uniforms, and the old shader bit for bit.
  let exact = true;
  for (let i = 0; i < 200; i++) {
    const params: Record<string, number | boolean> = { ...randomParams(), legacySkew: true };
    const a = trsAspect(params, W, H);
    const u = imageTrsUniforms(params, a);
    exact &&=
      a === 1 &&
      u.translate[0] === params.translateX &&
      u.translate[1] === params.translateY &&
      u.pivot[0] === params.pivotX &&
      u.pivot[1] === params.pivotY;
    // The pre-v13 TRANSFORM_FS / FIT_FS inverse, transcribed.
    const uv: [number, number] = [between(0, 1), between(0, 1)];
    const piv = [u.pivot[0], 1 - u.pivot[1]];
    let x = uv[0] - u.translate[0] - piv[0];
    let y = uv[1] + u.translate[1] - piv[1];
    const c = Math.cos(u.angle);
    const s = Math.sin(u.angle);
    [x, y] = [c * x - s * y, s * x + c * y];
    const old = [x / u.scale[0] + piv[0], y / u.scale[1] + piv[1]];
    const got = imageTrsInverseUv(u, uv);
    exact &&= got[0] === old[0] && got[1] === old[1];
  }
  check(
    "legacySkew: aspect 1, raw uniforms, inverse bit-identical to the pre-v13 shader (200 random)",
    exact
  );
  check(
    "trsAspect: W / H unless legacySkew; 1 for a degenerate size",
    trsAspect({}, W, H) === aspect &&
      trsAspect({ legacySkew: true }, W, H) === 1 &&
      trsAspect({}, W, 0) === 1
  );
}

{
  // TransformGizmo with frameBounds: its rest box is y ∈ [aspectUncorrectY(0),
  // aspectUncorrectY(1)] in node space, and its fwd (authored TRS about the
  // world pivot, drawn through aspectCorrectY) must land each box corner on
  // the rigid image's corner — K applied to the canvas01 frame corner.
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const params = randomParams();
    const o = opFromParams(params);
    const rad = (o.rotateDeg * Math.PI) / 180;
    const fwd = (sx: number, sy: number) => {
      const dx = (sx - o.pivotX) * o.scaleX;
      const dy = (sy - o.pivotY) * o.scaleY;
      return [
        o.translateX + o.pivotX + Math.cos(rad) * dx - Math.sin(rad) * dy,
        o.translateY + o.pivotY + Math.sin(rad) * dx + Math.cos(rad) * dy,
      ];
    };
    const K = composeOpsToCanvasAffine([o], aspect);
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const g = fwd(cx, aspectUncorrectY(cy, aspect));
      const screen = [g[0], aspectCorrectY(g[1], aspect)];
      const img = apply(K, [cx, cy]);
      worst = Math.max(worst, Math.hypot(screen[0] - img[0], screen[1] - img[1]));
    }
  }
  check(
    "gizmo frameBounds: the box's corners land on the rigid image's corners (200 random, 16:9)",
    worst < 1e-9,
    `worst error ${worst}`
  );
}

// ── decomposeAffineToTrs ───────────────────────────────────────────────
{
  let worst = 0;
  let nulls = 0;
  for (let i = 0; i < 500; i++) {
    const o = randomOp();
    const d = decomposeAffineToTrs(trsToAffine(o), o.pivotX, o.pivotY, o.rotateDeg);
    if (!d) {
      nulls++;
      continue;
    }
    worst = Math.max(
      worst,
      Math.abs(d.translateX - o.translateX),
      Math.abs(d.translateY - o.translateY),
      Math.abs(d.scaleX - o.scaleX),
      Math.abs(d.scaleY - o.scaleY),
      Math.abs(d.rotateDeg - o.rotateDeg)
    );
  }
  check(
    "decompose: TRS round-trips exactly (500 random, non-uniform scale)",
    nulls === 0 && worst < 1e-6,
    `nulls ${nulls}, worst ${worst}`
  );
}

{
  // Rotation picks the 360° turn nearest the hint.
  const m = trsToAffine(op({ rotateDeg: 350 }));
  const near = decomposeAffineToTrs(m, 0.5, 0.5, 350);
  const raw = decomposeAffineToTrs(m, 0.5, 0.5);
  check(
    "decompose: rotation follows the nearRotateDeg hint",
    !!near && close(near.rotateDeg, 350) && !!raw && close(raw.rotateDeg, -10),
    `near ${near?.rotateDeg}, raw ${raw?.rotateDeg}`
  );
}

{
  // A different pivot than the source op still reproduces the affine.
  const o = op({ translateX: 0.1, rotateDeg: 30, scaleX: 1.5, scaleY: 0.8 });
  const m = trsToAffine(o);
  const d = decomposeAffineToTrs(m, 0.2, 0.9, 30);
  check(
    "decompose: re-expresses about a different pivot",
    !!d && affineClose(trsToAffine(d), m),
    d ? fmt(trsToAffine(d)) : "null"
  );
}

{
  // Rotated child under a non-uniformly scaled parent = shear.
  const parent = trsToAffine(op({ scaleX: 2, scaleY: 1 }));
  const child = trsToAffine(op({ rotateDeg: 30 }));
  check(
    "decompose: refuses shear (rotated child, non-uniform parent)",
    decomposeAffineToTrs(multiplyAffine(parent, child), 0.5, 0.5) === null
  );
}

{
  const mirror: Affine2D = { a: -1, b: 0, tx: 1, c: 0, d: 1, ty: 0 };
  const collapsed: Affine2D = { a: 1, b: 0, tx: 0, c: 0, d: 0, ty: 0.5 };
  check(
    "decompose: refuses a mirror (det < 0)",
    decomposeAffineToTrs(mirror, 0.5, 0.5) === null
  );
  check(
    "decompose: refuses a collapsed axis",
    decomposeAffineToTrs(collapsed, 0.5, 0.5) === null
  );
}

// ── Parenting compensation (§7): newLocal = P⁻¹ ∘ C_world ─────────────
{
  let worst = 0;
  let nulls = 0;
  for (let i = 0; i < 300; i++) {
    const parentOps = [randomOp(true), randomOp(true)];
    const child = randomOp();
    const childWorld = trsToAffine(child); // unparented: world = local
    const inv = invertAffine(composeOpsToAffine(parentOps));
    if (!inv) continue;
    const local = decomposeAffineToTrs(
      multiplyAffine(inv, childWorld),
      child.pivotX,
      child.pivotY,
      child.rotateDeg
    );
    if (!local) {
      nulls++;
      continue;
    }
    const parented = composeTransform(
      { kind: "transform", ops: parentOps },
      local
    );
    const after = composeOpsToAffine(parented.ops);
    worst = Math.max(
      worst,
      ...(["a", "b", "c", "d", "tx", "ty"] as const).map((k) =>
        Math.abs(after[k] - childWorld[k])
      )
    );
  }
  check(
    "compensation: parenting under uniform-scale parents holds world placement (300 random)",
    nulls === 0 && worst < 1e-6,
    `nulls ${nulls}, worst ${worst}`
  );
}

{
  // Unparenting: newLocal = C_world (the old parent's world ∘ local).
  const parentOps = [op({ rotateDeg: 90 }), op({ translateX: 0.1 })];
  const local = op({ translateX: 0.25, rotateDeg: 15 });
  const world = composeOpsToAffine(
    composeTransform({ kind: "transform", ops: parentOps }, local).ops
  );
  const d = decomposeAffineToTrs(world, local.pivotX, local.pivotY, local.rotateDeg);
  check(
    "compensation: unparenting bakes the parent into the child's TRS",
    !!d && affineClose(trsToAffine(d), world) && close(d.rotateDeg, 105),
    d ? `${fmt(trsToAffine(d))} rot ${d.rotateDeg}` : "null"
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
