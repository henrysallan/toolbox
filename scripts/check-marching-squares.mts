// Guards engine/marching-squares.ts.
//
// The chaining was rewritten for speed (string endpoint hashes -> integer
// keys, no per-cell closures, no per-endpoint objects): 5.7x faster, and it
// feeds six callers — blend-intersections, sdf-to-spline, text, spline-flow,
// points-to-surface, growth-emit — so a regression here is broad.
//
// The rewrite was verified byte-identical against the previous implementation
// on this corpus. That comparison can't live in the repo (it needs the old
// code), so it's replaced by two things that can: geometric invariants that
// any correct implementation must satisfy, and characterization counts that
// pin the current chaining behavior.
//
// The counts are NOT sacred. Several of them record imperfect chaining —
// `two-overlapping` yields 9 subpaths with only 1 closed, where 1 closed ring
// is geometrically right; rings fragment into open chains at saddles, which
// is why blend-intersections re-closes and drops debris downstream. If you
// deliberately improve chaining these numbers SHOULD move; update them and
// say so. They exist to make an accidental change loud.
//
// Run: npx tsx scripts/check-marching-squares.mts
import { marchingSquares } from "../src/engine/marching-squares.ts";

let failures = 0;
let checks = 0;
function check(cond: boolean, msg: string): void {
  checks++;
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
}

interface Field { name: string; grid: Float32Array; w: number; h: number }

// Exercises closed rings, nested rings, saddles, thin sub-cell features, and
// the degenerate all-in / all-out grids.
function fields(): Field[] {
  const out: Field[] = [];
  const mk = (name: string, w: number, h: number, f: (x: number, y: number) => number) => {
    const grid = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) grid[y * w + x] = f(x / (w - 1), y / (h - 1));
    }
    out.push({ name, grid, w, h });
  };
  const circ = (x: number, y: number, cx: number, cy: number, r: number) =>
    Math.hypot(x - cx, y - cy) - r;

  mk("circle", 64, 64, (x, y) => circ(x, y, 0.5, 0.5, 0.3));
  mk("two-overlapping", 96, 96, (x, y) =>
    Math.min(circ(x, y, 0.38, 0.5, 0.25), circ(x, y, 0.62, 0.5, 0.25)));
  mk("nested-ring", 96, 96, (x, y) =>
    Math.max(circ(x, y, 0.5, 0.5, 0.4), -circ(x, y, 0.5, 0.5, 0.2)));
  mk("saddles", 64, 64, (x, y) => Math.sin(x * 25) * Math.sin(y * 25));
  mk("thin-bar", 128, 128, (x, y) => Math.abs(x - y) - 0.012);
  mk("all-inside", 32, 32, () => -1);
  mk("all-outside", 32, 32, () => 1);
  mk("blob-field", 160, 160, (x, y) => {
    let d = Infinity;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      d = Math.min(d, circ(x, y, 0.5 + 0.3 * Math.cos(a * 3), 0.5 + 0.3 * Math.sin(a * 5), 0.07));
    }
    return d;
  });
  return out;
}

// Characterization: [subpaths, total points, closed count] as produced by the
// implementation this test was written against.
const EXPECTED: Record<string, [number, number, number]> = {
  circle: [1, 152, 1],
  "two-overlapping": [9, 256, 1],
  "nested-ring": [6, 460, 2],
  saddles: [26, 946, 18],
  "thin-bar": [2, 504, 0],
  "all-inside": [0, 0, 0],
  "all-outside": [0, 0, 0],
  "blob-field": [34, 1276, 6],
};

// Bilinear sample of the grid at a UV point, for the on-contour invariant.
function sampleGrid(f: Field, u: number, v: number): number {
  const gx = u * (f.w - 1);
  const gy = v * (f.h - 1);
  const x0 = Math.max(0, Math.min(f.w - 2, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(f.h - 2, Math.floor(gy)));
  const fx = gx - x0;
  const fy = gy - y0;
  const a = f.grid[y0 * f.w + x0];
  const b = f.grid[y0 * f.w + x0 + 1];
  const c = f.grid[(y0 + 1) * f.w + x0];
  const d = f.grid[(y0 + 1) * f.w + x0 + 1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

const all = fields();

console.log("geometric invariants");
for (const f of all) {
  const subs = marchingSquares(f.grid, f.w, f.h, { iso: 0, uvOrigin: [0, 0], uvSize: [1, 1] });
  const cell = 1 / (f.w - 1);

  let nonFinite = 0;
  let offContour = 0;
  let worstOff = 0;
  let jumps = 0;
  let pts = 0;
  for (const s of subs) {
    pts += s.anchors.length;
    for (const a of s.anchors) {
      if (!Number.isFinite(a.pos[0]) || !Number.isFinite(a.pos[1])) { nonFinite++; continue; }
      // Every emitted point must lie ON the iso-contour. Marching squares
      // places points by linear interpolation along a cell edge, so the
      // bilinear field there is ~0 up to the field's own curvature over one
      // cell. This is the invariant that catches a mis-indexed corner or a
      // wrong edge assignment — the kind of bug a point count would miss.
      const v = Math.abs(sampleGrid(f, a.pos[0], a.pos[1]));
      if (v > cell) offContour++;
      if (v > worstOff) worstOff = v;
    }
    // Consecutive points come from adjacent cells, so they can never be more
    // than ~2 cells apart. A larger jump means two unrelated chains were
    // spliced together.
    for (let i = 1; i < s.anchors.length; i++) {
      const dx = s.anchors[i].pos[0] - s.anchors[i - 1].pos[0];
      const dy = s.anchors[i].pos[1] - s.anchors[i - 1].pos[1];
      if (Math.hypot(dx, dy) > cell * 2.5) jumps++;
    }
  }
  check(nonFinite === 0, `${f.name}: ${nonFinite} non-finite points`);
  check(offContour === 0, `${f.name}: ${offContour} points off the iso-contour (worst |f| = ${worstOff.toFixed(5)}, cell = ${cell.toFixed(5)})`);
  check(jumps === 0, `${f.name}: ${jumps} discontinuous jumps between consecutive points`);

  const exp = EXPECTED[f.name];
  const closed = subs.filter((s) => s.closed).length;
  check(
    subs.length === exp[0] && pts === exp[1] && closed === exp[2],
    `${f.name}: got [${subs.length}, ${pts}, ${closed}], expected [${exp.join(", ")}]`
  );
}

console.log("determinism");
{
  const f = all.find((x) => x.name === "blob-field")!;
  const a = marchingSquares(f.grid, f.w, f.h, { iso: 0 });
  const b = marchingSquares(f.grid, f.w, f.h, { iso: 0 });
  check(JSON.stringify(a) === JSON.stringify(b), "two runs on the same grid differ");
}

console.log("uv mapping");
{
  // uvOrigin/uvSize must place the contour inside the requested window —
  // blend-intersections samples only the network bbox, so an error here
  // silently offsets every contour it produces.
  const f = all.find((x) => x.name === "circle")!;
  const subs = marchingSquares(f.grid, f.w, f.h, {
    iso: 0, uvOrigin: [0.25, 0.5], uvSize: [0.5, 0.25],
  });
  let inside = true;
  let n = 0;
  for (const s of subs) {
    for (const a of s.anchors) {
      n++;
      if (a.pos[0] < 0.25 - 1e-9 || a.pos[0] > 0.75 + 1e-9) inside = false;
      if (a.pos[1] < 0.5 - 1e-9 || a.pos[1] > 0.75 + 1e-9) inside = false;
    }
  }
  check(n > 0, "windowed march produced no points");
  check(inside, "windowed march produced points outside uvOrigin/uvSize");
}

console.log("degenerate grids");
{
  check(marchingSquares(new Float32Array(4), 2, 2, { iso: 0 }).length === 0, "2x2 zero grid should yield nothing");
  const tiny = new Float32Array([1, 1, 1, -1]);
  const r = marchingSquares(tiny, 2, 2, { iso: 0 });
  check(r.every((s) => s.anchors.every((a) => Number.isFinite(a.pos[0]))), "2x2 single-corner grid produced non-finite points");
}

console.log(
  failures === 0
    ? `\nALL GREEN — ${checks} checks passed`
    : `\n${failures} of ${checks} checks FAILED`
);
process.exit(failures === 0 ? 0 : 1);
