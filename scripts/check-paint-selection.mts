// check-paint-selection: the Paint editor's selection geometry
// (101526_paint-selection-transform.md M1), pure half — the DOM-free helpers
// in paint-editor/selection.ts:
//
// - alphaBBox: bbox of pixels at ≥ 50% alpha; null for an empty mask (= no
//   selection); soft pixels under the threshold don't count.
// - alphaEdges: the pixel-boundary outline (the marching ants) as merged
//   horizontal/vertical runs — a rect is exactly 4 runs, a hole adds its
//   own 4, every run is axis-aligned and lies on a selected/unselected
//   boundary, and the total edge length equals the region's perimeter.
// - marqueeRect: press→cursor in any direction, Shift-square on the
//   dominant axis, Alt-from-center, outward pixel snapping, canvas clamp,
//   null when off-canvas or degenerate.
// - unionRect.
// - floating.ts's affine math (M2): compose order, applyAffine, bounds of a
//   placed source (snap + clamp + off-canvas null), and fitCentered (centers,
//   scales DOWN to fit, never up).
// - transform.ts (M3): affine inverse; handle drags — proportional corner
//   scale by default (Shift frees it), Alt about the center, edge handles one
//   axis, the opposite handle fixed; rotation about the content center with
//   Shift snapping to 15°; Cmd-edge skew keeping the opposite edge; gizmo
//   hit-testing (handle > inside = move > corner ring = rotate > move),
//   rotated resize cursors, the matrix ⇄ readout round trip, and flips.
// - M4: floodRegion (contiguous stays inside its run, global finds every
//   match, tolerance, alpha participates, off-data seed → null), the exact
//   distance transform behind Expand / Contract (vs brute force), growAlpha
//   (grow/shrink by r with a soft 1 px edge, empty in → empty out),
//   snap45 and pointsBBox.
//
// The canvas compositing (combine modes, invert, clip, delete/fill) and the
// overlay gestures are live-app questions.
//
//   npx tsx scripts/check-paint-selection.mts

import {
  alphaBBox,
  alphaEdges,
  marqueeRect,
  distanceToSet,
  floodRegion,
  growAlpha,
  pointsBBox,
  regionAlpha,
  snap45,
  unionRect,
  type PxRect,
} from "../src/components/effects/paint-editor/selection.ts";
import {
  IDENTITY,
  affineBounds,
  applyAffine,
  compose,
  fitCentered,
  translation,
} from "../src/components/effects/paint-editor/floating.ts";
import {
  buildTransform,
  dragTransform,
  flipTransform,
  handleCursor,
  handlePoints,
  hitGizmo,
  invertAffine,
  readTransform,
} from "../src/components/effects/paint-editor/transform.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const eqRect = (a: PxRect | null, b: PxRect | null) =>
  JSON.stringify(a) === JSON.stringify(b);

// RGBA mask w×h from a predicate on (x, y) → alpha.
function mask(w: number, h: number, alpha: (x: number, y: number) => number) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = alpha(x, y);
  return d;
}
const inRect = (r: PxRect) => (x: number, y: number) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? 255 : 0;

function runs(e: Int32Array) {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < e.length; i += 4) out.push([e[i], e[i + 1], e[i + 2], e[i + 3]]);
  return out;
}
const totalLength = (e: Int32Array) =>
  runs(e).reduce((s, [x1, y1, x2, y2]) => s + Math.abs(x2 - x1) + Math.abs(y2 - y1), 0);

// ── alphaBBox ────────────────────────────────────────────────────────
check("empty mask → null (no selection)", alphaBBox(mask(8, 6, () => 0), 8, 6) === null);
check(
  "rect mask → its bbox",
  eqRect(alphaBBox(mask(10, 8, inRect({ x: 2, y: 3, w: 4, h: 2 })), 10, 8), { x: 2, y: 3, w: 4, h: 2 })
);
check(
  "soft pixels under 50% alpha are outside the bbox",
  eqRect(
    alphaBBox(mask(10, 8, (x, y) => (x === 0 ? 100 : inRect({ x: 4, y: 4, w: 2, h: 2 })(x, y))), 10, 8),
    { x: 4, y: 4, w: 2, h: 2 }
  )
);
check("full mask → whole canvas", eqRect(alphaBBox(mask(5, 4, () => 255), 5, 4), { x: 0, y: 0, w: 5, h: 4 }));

// ── alphaEdges ───────────────────────────────────────────────────────
{
  const r = { x: 2, y: 1, w: 5, h: 3 };
  const e = alphaEdges(mask(10, 8, inRect(r)), 10, 8);
  const rs = runs(e);
  check("rect outline is exactly 4 runs", rs.length === 4, `${rs.length} runs`);
  check("rect outline length = perimeter", totalLength(e) === 2 * (r.w + r.h));
  check(
    "rect outline sits on the pixel-corner boundary",
    rs.some(([x1, y1, x2, y2]) => x1 === 2 && y1 === 1 && x2 === 7 && y2 === 1) &&
      rs.some(([x1, y1, x2, y2]) => x1 === 2 && y1 === 4 && x2 === 7 && y2 === 4) &&
      rs.some(([x1, y1, x2, y2]) => x1 === 2 && y1 === 1 && x2 === 2 && y2 === 4) &&
      rs.some(([x1, y1, x2, y2]) => x1 === 7 && y1 === 1 && x2 === 7 && y2 === 4)
  );
  check("every run is axis-aligned", rs.every(([x1, y1, x2, y2]) => x1 === x2 || y1 === y2));
}
{
  // Frame with a hole: outer 8×8 minus inner 4×4 → 8 runs, both perimeters.
  const outer = inRect({ x: 1, y: 1, w: 8, h: 8 });
  const inner = inRect({ x: 3, y: 3, w: 4, h: 4 });
  const e = alphaEdges(mask(10, 10, (x, y) => (outer(x, y) && !inner(x, y) ? 255 : 0)), 10, 10);
  check("a hole adds its own outline (8 runs)", runs(e).length === 8, `${runs(e).length} runs`);
  check("hole outline length = outer + inner perimeter", totalLength(e) === 32 + 16);
}
{
  const e = alphaEdges(mask(4, 3, () => 255), 4, 3);
  check("full mask outlines the data border", runs(e).length === 4 && totalLength(e) === 14);
}
check("empty mask has no edges", alphaEdges(mask(6, 6, () => 0), 6, 6).length === 0);
{
  // L-shape: 6 runs, staircase perimeter.
  const L = (x: number, y: number) => ((x < 2 && y < 5) || (y >= 3 && y < 5 && x < 5) ? 255 : 0);
  const e = alphaEdges(mask(6, 6, L), 6, 6);
  check("L-shape outline is 6 runs", runs(e).length === 6, `${runs(e).length} runs`);
  check("L-shape outline length = its perimeter", totalLength(e) === 2 * (5 + 5));
}

// ── marqueeRect ──────────────────────────────────────────────────────
const C = { width: 100, height: 80 };
const mr = (s: [number, number], c: [number, number], square = false, fromCenter = false) =>
  marqueeRect(s, c, { square, fromCenter, ...C });
check("down-right drag", eqRect(mr([10, 10], [30, 20]), { x: 10, y: 10, w: 20, h: 10 }));
check("up-left drag normalises", eqRect(mr([30, 20], [10, 10]), { x: 10, y: 10, w: 20, h: 10 }));
check("fractional ends snap outward", eqRect(mr([10.6, 10.2], [20.1, 19.5]), { x: 10, y: 10, w: 11, h: 10 }));
check("Shift squares on the dominant axis", eqRect(mr([10, 10], [40, 20], true), { x: 10, y: 10, w: 30, h: 30 }));
check(
  "Shift square keeps the drag direction",
  eqRect(mr([50, 50], [40, 20], true), { x: 20, y: 20, w: 30, h: 30 })
);
check("Alt grows from the center", eqRect(mr([50, 40], [60, 45], false, true), { x: 40, y: 35, w: 20, h: 10 }));
check(
  "Shift+Alt: centered square",
  eqRect(mr([50, 40], [60, 45], true, true), { x: 40, y: 30, w: 20, h: 20 })
);
check("clamped to the canvas", eqRect(mr([-20, -5], [30, 200]), { x: 0, y: 0, w: 30, h: 80 }));
check("entirely off-canvas → null", mr([120, 10], [150, 30]) === null);
check("zero-area → null", mr([10, 10], [10, 30]) === null);

// ── unionRect ────────────────────────────────────────────────────────
check("union with null is the other rect", eqRect(unionRect(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 }));
check(
  "union covers both",
  eqRect(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 1, w: 2, h: 4 }), { x: 0, y: 0, w: 7, h: 5 })
);

// ── floating.ts affine math ──────────────────────────────────────────
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
{
  const p = applyAffine(compose(translation(5, 0), [2, 0, 0, 2, 0, 0]), 1, 1);
  check("compose(a, b) applies b first", near(p[0], 7) && near(p[1], 2), p.join(","));
  const q = applyAffine(compose(IDENTITY, translation(3, 4)), 0, 0);
  check("identity is neutral", near(q[0], 3) && near(q[1], 4));
}
check(
  "bounds of a translated source",
  eqRect(affineBounds(translation(10.5, 3), 4, 5, 100, 80), { x: 10, y: 3, w: 5, h: 5 })
);
check(
  "bounds clamp to the canvas",
  eqRect(affineBounds(translation(-2, 78), 10, 10, 100, 80), { x: 0, y: 78, w: 8, h: 2 })
);
check("bounds fully off-canvas → null", affineBounds(translation(200, 0), 10, 10, 100, 80) === null);
{
  const m = fitCentered(400, 100, 100, 80);
  const [x0, y0] = applyAffine(m, 0, 0);
  const [x1, y1] = applyAffine(m, 400, 100);
  check("fit: scaled down to the canvas width", near(m[0], 0.25) && near(x0, 0) && near(x1, 100));
  check("fit: centered vertically", near(y0, 27.5) && near(y1, 52.5), `${y0}..${y1}`);
  const small = fitCentered(10, 10, 100, 80);
  check("fit never scales up", near(small[0], 1) && near(small[4], 45) && near(small[5], 35));
}

// ── transform.ts ─────────────────────────────────────────────────────
const nearPt = (p: [number, number], x: number, y: number, eps = 1e-6) =>
  Math.abs(p[0] - x) < eps && Math.abs(p[1] - y) < eps;
{
  const m: [number, number, number, number, number, number] = [1.3, 0.4, -0.2, 0.9, 7, -3];
  const back = applyAffine(compose(invertAffine(m), m), 3, 5);
  check("invertAffine undoes the matrix", nearPt(back, 3, 5));
}
{
  const m0 = translation(10, 10);
  const content = { x: 0, y: 0, w: 20, h: 10 };
  const free = { shift: false, alt: false };
  const prop = dragTransform("scale", 4, m0, content, [30, 20], [50, 20], free);
  check("corner drag scales proportionally by default",
    nearPt(applyAffine(prop, 20, 10), 50, 30) && nearPt(applyAffine(prop, 0, 0), 10, 10));
  const loose = dragTransform("scale", 4, m0, content, [30, 20], [50, 20], { shift: true, alt: false });
  check("Shift frees the corner", nearPt(applyAffine(loose, 20, 10), 50, 20));
  const centered = dragTransform("scale", 4, m0, content, [30, 20], [40, 25], { shift: false, alt: true });
  check("Alt scales about the center", nearPt(applyAffine(centered, 10, 5), 20, 15) &&
    nearPt(applyAffine(centered, 20, 10), 40, 25));
  const edge = dragTransform("scale", 3, m0, content, [30, 15], [40, 99], free);
  check("an edge handle scales its axis only",
    nearPt(applyAffine(edge, 20, 10), 40, 20) && nearPt(applyAffine(edge, 0, 0), 10, 10));
  const through = dragTransform("scale", 3, m0, content, [30, 15], [0, 15], free);
  check("dragging through the anchor flips", applyAffine(through, 20, 5)[0] < 10);
  const rot = dragTransform("rotate", -1, m0, content, [30, 15], [20, 25], free);
  check("rotation turns about the content center", nearPt(applyAffine(rot, 10, 5), 20, 15) &&
    nearPt(applyAffine(rot, 0, 0), 25, 5), applyAffine(rot, 0, 0).join(","));
  const a50 = (50 * Math.PI) / 180;
  const snapped = dragTransform("rotate", -1, m0, content, [30, 15], [20 + 10 * Math.cos(a50), 15 + 10 * Math.sin(a50)], { shift: true, alt: false });
  const ang = readTransform(snapped, content).angle;
  check("Shift snaps rotation to 15°", Math.abs(ang - 45) < 1e-6, `${ang}`);
}
{
  const content = { x: 0, y: 0, w: 10, h: 10 };
  const sk = dragTransform("skew", 1, IDENTITY, content, [5, 0], [8, 0], { shift: false, alt: false });
  check("skewing the top edge slides it, bottom stays",
    nearPt(applyAffine(sk, 0, 0), 3, 0) && nearPt(applyAffine(sk, 0, 10), 0, 10));
  const sk2 = dragTransform("skew", 3, IDENTITY, content, [10, 5], [10, 9], { shift: false, alt: false });
  check("skewing the right edge slides it vertically, left stays",
    nearPt(applyAffine(sk2, 10, 0), 10, 4) && nearPt(applyAffine(sk2, 0, 0), 0, 0));
}
{
  const hs = handlePoints({ x: 100, y: 100, w: 100, h: 50 });
  const h = hs.map(([x, y]) => [x, y] as [number, number]);
  check("hit: a handle grabs scale", (() => { const r = hitGizmo(h, [201, 151], false); return r.kind === "scale" && r.handle === 4; })());
  check("hit: Cmd on an edge handle skews", hitGizmo(h, [150, 100], true).kind === "skew");
  check("hit: Cmd on a corner still scales", hitGizmo(h, [100, 100], true).kind === "scale");
  check("hit: inside the box moves", hitGizmo(h, [150, 125], false).kind === "move");
  check("hit: just outside a corner rotates", hitGizmo(h, [85, 88], false).kind === "rotate");
  check("hit: far away still moves", hitGizmo(h, [400, 400], false).kind === "move");
  check("cursor: right edge is ew", handleCursor(h, 3) === "ew-resize");
  check("cursor: bottom-right corner is nwse", handleCursor(h, 4) === "nwse-resize");
  // Rotate the box 90°: the right-edge handle now points down.
  const rotated = h.map(([x, y]) => [150 - (y - 125), 125 + (x - 150)] as [number, number]);
  check("cursor follows the box rotation", handleCursor(rotated, 3) === "ns-resize");
}
{
  const content = { x: 2, y: 2, w: 30, h: 20 };
  const m: [number, number, number, number, number, number] = [0.8, 0.6, -0.9, 1.4, 40, 12];
  const r = readTransform(m, content);
  const back = buildTransform(r, content);
  check("readout ⇄ matrix round trip (incl. shear)",
    back.every((v, i) => Math.abs(v - m[i]) < 1e-9), back.join(","));
  const r2 = readTransform(translation(10, 10), content);
  check("identity-scale readout is 100% / 0°",
    Math.abs(r2.w - 100) < 1e-9 && Math.abs(r2.h - 100) < 1e-9 && Math.abs(r2.angle) < 1e-9 &&
    Math.abs(r2.x - 27) < 1e-9 && Math.abs(r2.y - 22) < 1e-9);
  const flipped = flipTransform(translation(10, 10), content, "h");
  check("flip H mirrors about the content center", nearPt(applyAffine(flipped, 2, 2), 42, 12));
  const fr = readTransform(flipped, content);
  check("a flip reads back as one negative axis (det < 0)", fr.w * fr.h < 0, `${fr.w} × ${fr.h}`);
  check("flip keeps the center put", nearPt(applyAffine(flipped, 17, 12), 27, 22));
}

// ── M4: floodRegion ──────────────────────────────────────────────────
{
  // 8×4 RGBA: left 3 columns red, a black wall at x=3, right side red again.
  const W = 8, H = 4;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      d[i] = x === 3 ? 0 : 200; d[i + 3] = 255;
    }
  const count = (r: Uint8Array | null) => (r ? r.reduce((s, v) => s + v, 0) : -1);
  const c = floodRegion(d, W, H, 0, 0, 0.05, true);
  check("contiguous region stops at the wall", count(c) === 3 * H, `${count(c)}`);
  const g = floodRegion(d, W, H, 0, 0, 0.05, false);
  check("global region finds every match", count(g) === 7 * H, `${count(g)}`);
  const all = floodRegion(d, W, H, 0, 0, 1, true);
  check("tolerance 1 reaches everything", count(all) === W * H);
  check("off-data seed → null", floodRegion(d, W, H, -1, 0, 0.1, true) === null);
  // Alpha participates: same RGB, transparent half is a different region.
  const a2 = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) a2[i * 4 + 3] = i % W < 4 ? 255 : 0;
  check("alpha participates in matching", count(floodRegion(a2, W, H, 6, 1, 0.1, true)) === 4 * H);
}

// ── M4: distance transform / grow ────────────────────────────────────
{
  const W = 13, H = 9;
  const set = new Uint8Array(W * H);
  set[4 * W + 6] = 1;
  set[1 * W + 1] = 1;
  const d = distanceToSet(set, W, H);
  let worst = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const brute = Math.min(Math.hypot(x - 6, y - 4), Math.hypot(x - 1, y - 1));
      worst = Math.max(worst, Math.abs(d[y * W + x] - brute));
    }
  check("distance transform is exact (vs brute force)", worst < 1e-5, `max err ${worst}`);
}
{
  const W = 21, H = 21;
  const alpha = new Uint8Array(W * H);
  for (let y = 8; y < 13; y++) for (let x = 8; x < 13; x++) alpha[y * W + x] = 255; // 5×5 at 8..12
  const grown = growAlpha(alpha, W, H, 3);
  check("grow keeps the original", grown[10 * W + 10] === 255);
  check("grow reaches r px out", grown[10 * W + 15] === 255 && grown[10 * W + 5] === 255);
  check("grow stops past r", grown[10 * W + 17] === 0);
  // (5, 6) is √13 ≈ 3.6 px from the square: inside the r..r+1 soft band.
  check("grow edge is soft (antialiased corner)", grown[6 * W + 5] > 0 && grown[6 * W + 5] < 255, `${grown[6 * W + 5]}`);
  check("grow corners are round (Euclidean, not square)", grown[5 * W + 5] === 0);
  const shrunk = growAlpha(alpha, W, H, -1);
  check("shrink removes the outer ring", shrunk[8 * W + 10] === 0 && shrunk[10 * W + 12] === 0);
  check("shrink keeps the core", shrunk[10 * W + 10] === 255 && shrunk[9 * W + 9] === 255);
  check("shrink past the size empties it", growAlpha(alpha, W, H, -3).every((v) => v === 0));
  check("grow of an empty mask stays empty", growAlpha(new Uint8Array(W * H), W, H, 4).every((v) => v === 0));
}

// ── M4: wand anti-alias ──────────────────────────────────────────────
{
  const W = 12, H = 10;
  const region = new Uint8Array(W * H);
  // An L-ish blob with a diagonal step.
  for (let y = 2; y < 8; y++) for (let x = 2; x < (y < 5 ? 9 : 6); x++) region[y * W + x] = 1;
  const hard = regionAlpha(region, W, H, false);
  const soft = regionAlpha(region, W, H, true);
  const rgba = (al: Uint8Array) => {
    const d = new Uint8ClampedArray(W * H * 4);
    al.forEach((v, i) => (d[i * 4 + 3] = v));
    return d;
  };
  check("AA keeps the region's bbox", eqRect(alphaBBox(rgba(soft), W, H), alphaBBox(rgba(hard), W, H)));
  check("AA keeps the ants (same 50% outline)",
    alphaEdges(rgba(soft), W, H).join(",") === alphaEdges(rgba(hard), W, H).join(","));
  check("AA leaves the interior solid", soft[4 * W + 4] === 255);
  check("AA softens just outside the edge", soft[4 * W + 1] > 0 && soft[4 * W + 1] < 128);
  check("AA softens just inside the edge", soft[2 * W + 2] < 255 && soft[2 * W + 2] >= 128);
  check("no AA is a hard copy", hard.every((v, i) => v === (region[i] ? 255 : 0)));
}

// ── M4: polygon helpers ──────────────────────────────────────────────
{
  const s1 = snap45([0, 0], [10, 1]);
  check("snap45: near-horizontal → horizontal", Math.abs(s1[1]) < 1e-9 && Math.abs(s1[0] - 10) < 1e-9);
  const s2 = snap45([0, 0], [10, 9]);
  check("snap45: near-diagonal → 45°, projected length",
    Math.abs(s2[0] - s2[1]) < 1e-9 && Math.abs(s2[0] - 9.5) < 1e-9, s2.join(","));
  check("pointsBBox snaps outward + clamps",
    eqRect(pointsBBox([[1.5, 2.2], [9.1, 4], [-3, 6.5]], 8, 8), { x: 0, y: 2, w: 8, h: 5 }));
  check("pointsBBox of nothing → null", pointsBBox([], 8, 8) === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall paint-selection checks passed");
