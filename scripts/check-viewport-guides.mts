// check-viewport-guides: the pure half of viewport rulers + guides
// (specdocs/091726_viewport-rulers.md) — the persistence gate, the snap
// helpers every gizmo rides, the ruler tick ladder and the px readout.
//
//   - fromSavedViewportGuides drops anything not shaped like a guide (an
//     untrusted .toolbox / cloud blob), collapses exact duplicates, keeps
//     off-canvas positions (dropping a guide on the ruler is the delete).
//   - snapValueToLines / snapSpanToLines pick the SMALLEST correction: a
//     box near a guide snaps whichever of its edges / centre is closest,
//     and nothing beyond the threshold snaps at all.
//   - rulerTickPlan only ever emits 1 / 2 / 5 × 10ⁿ steps, keeps labels at
//     least minLabelPx apart, and subdivides only while the minors stay
//     legible.
//   - guidePosFromClient lands on the project pixel grid; formatGuidePx
//     reads whole pixels as integers.
//
//   npx tsx scripts/check-viewport-guides.mts

import {
  formatGuidePx,
  fromSavedViewportGuides,
  guideLinesOn,
  guidePosFromClient,
  rulerTickPlan,
  snapSpanToLines,
  snapValueToLines,
} from "@/lib/viewport-guides";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- persistence gate -----------------------------------------------------

check("gate: non-array → []", fromSavedViewportGuides(undefined).length === 0);
check("gate: junk entries dropped", fromSavedViewportGuides([1, null, "x", {}]).length === 0);
check(
  "gate: bad axis / non-finite pos dropped",
  fromSavedViewportGuides([
    { axis: "z", pos: 0.5 },
    { axis: "x", pos: NaN },
    { axis: "y", pos: Infinity },
    { axis: "x", pos: "0.5" },
  ]).length === 0
);
{
  const g = fromSavedViewportGuides([
    { axis: "x", pos: 0.25 },
    { axis: "y", pos: -0.1 },
    { axis: "x", pos: 0.25 },
    { axis: "x", pos: 1.4, extra: true },
  ]);
  check("gate: well-formed guides survive, duplicates collapse", g.length === 3, JSON.stringify(g));
  check(
    "gate: off-canvas positions kept (delete is a ruler drop, not a clamp)",
    g.some((e) => e.pos === -0.1) && g.some((e) => e.pos === 1.4)
  );
  check(
    "gate: output carries only axis + pos",
    g.every((e) => Object.keys(e).sort().join(",") === "axis,pos")
  );
  check(
    "guideLinesOn splits by axis",
    guideLinesOn(g, "x").join(",") === "0.25,1.4" && guideLinesOn(g, "y").join(",") === "-0.1"
  );
}

// --- snapping -------------------------------------------------------------

check("snapValue: nothing within threshold → null", snapValueToLines(0.5, [0.2, 0.9], 0.05) === null);
{
  const s = snapValueToLines(0.52, [0.2, 0.5, 0.9], 0.05);
  check("snapValue: nearest line wins, delta corrects onto it", !!s && near(s.at, 0.5) && near(s.delta, -0.02));
}
{
  // Exactly representable operands so the tie is a real tie in fp.
  const s = snapValueToLines(0.5, [0.25, 0.75], 0.3);
  check("snapValue: exact tie → first line seen", !!s && near(s.at, 0.25));
}
{
  // Box [0.30, 0.50]; guide at 0.52 → the MAX edge is closest (0.02).
  const s = snapSpanToLines(0.3, 0.5, [0.52], 0.05);
  check("snapSpan: max edge snaps", !!s && near(s.delta, 0.02) && near(s.at, 0.52));
}
{
  // Box [0.30, 0.50], centre 0.40; guide at 0.41 → centre wins over edges.
  const s = snapSpanToLines(0.3, 0.5, [0.41], 0.05);
  check("snapSpan: centre snaps when it is the closest feature", !!s && near(s.delta, 0.01));
}
{
  // Box [0.30, 0.50]; guide at 0.27 → min edge (0.03 away).
  const s = snapSpanToLines(0.3, 0.5, [0.27], 0.05);
  check("snapSpan: min edge snaps", !!s && near(s.delta, -0.03));
}
{
  const s = snapSpanToLines(0.5, 0.3, [0.27], 0.05);
  check("snapSpan: flipped span (min > max) tolerated", !!s && near(s.delta, -0.03));
}
check("snapSpan: beyond threshold → null", snapSpanToLines(0.3, 0.5, [0.7], 0.05) === null);
{
  // Two guides; the box's max edge is 0.02 from one, its min edge 0.01
  // from the other — the smaller correction wins even across features.
  const s = snapSpanToLines(0.3, 0.5, [0.52, 0.29], 0.05);
  check("snapSpan: smallest correction wins across guides", !!s && near(s.delta, -0.01) && near(s.at, 0.29));
}

// --- ruler ladder ---------------------------------------------------------

const is125 = (v: number) => {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / mag;
  return [1, 2, 5].some((k) => near(m, k, 1e-9));
};
{
  let allRound = true;
  let allSpaced = true;
  let minorLegible = true;
  for (const ppu of [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 4, 8, 16]) {
    const { major, minor } = rulerTickPlan(ppu, 64);
    if (!is125(major)) allRound = false;
    if (major * ppu < 64) allSpaced = false;
    if (minor !== major && minor * ppu < 6) minorLegible = false;
    if (!(major % minor === 0 || near(major / minor, Math.round(major / minor)))) allRound = false;
  }
  check("ladder: major is always 1/2/5 × 10ⁿ", allRound);
  check("ladder: labels never closer than minLabelPx", allSpaced);
  check("ladder: minors only while ≥ 6px apart", minorLegible);
}
{
  const a = rulerTickPlan(1, 64); // 1:1 — 100px labels, 20px minors
  check("ladder: 1:1 → 100 / 20", a.major === 100 && a.minor === 20, JSON.stringify(a));
  const b = rulerTickPlan(0.5, 64); // 50% — 200 (100px) / 40 (20px)
  check("ladder: 50% → 200 / 40", b.major === 200 && b.minor === 40, JSON.stringify(b));
  const c = rulerTickPlan(8, 64); // 800% — 10 (80px) / 2 (16px)
  check("ladder: 800% → 10 / 2", c.major === 10 && c.minor === 2, JSON.stringify(c));
  const d = rulerTickPlan(0, 64);
  check("ladder: degenerate zoom falls back sanely", Number.isFinite(d.major) && d.major > 0);
}

// --- pixel grid + readout -------------------------------------------------

{
  // Canvas 1920 wide drawn 960px wide starting at client x=100: client
  // 100.7 → 1.4 project px → rounds to 1 → 1/1920.
  const p = guidePosFromClient(100.7, 100, 960, 1920);
  check("guidePosFromClient: lands on the project pixel grid", near(p, 1 / 1920));
  check("guidePosFromClient: centre stays exactly 0.5", guidePosFromClient(580, 100, 960, 1920) === 0.5);
  check("guidePosFromClient: negative (off-canvas) positions allowed", guidePosFromClient(90, 100, 960, 1920) < 0);
  check("guidePosFromClient: zero-size canvas → 0", guidePosFromClient(50, 0, 0, 1920) === 0);
}
check("formatGuidePx: whole pixels read as integers", formatGuidePx(0.5, 1080) === "540");
check("formatGuidePx: off-grid reads one decimal", formatGuidePx(1 / 3, 1000) === "333.3");

if (failures > 0) {
  console.error(`\ncheck-viewport-guides: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-viewport-guides: all passed");
