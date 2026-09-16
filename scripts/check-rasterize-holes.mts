// Guards Rasterize Spline hole islands: Punch holes vs Fill holes share
// the same containment grouping, and Fill holes is a separate toggle that
// paints the nested contours instead of the outer.
//
//   npx tsx scripts/check-rasterize-holes.mts

import type { SplineSubpath } from "../src/engine/types.ts";
import {
  groupHoleIslands,
  rasterizeSplineNode,
} from "../src/nodes/effect/rasterize-spline.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function closedSquare(cx: number, cy: number, half: number): SplineSubpath {
  return {
    closed: true,
    anchors: [
      { pos: [cx, cy - half] },
      { pos: [cx + half, cy] },
      { pos: [cx, cy + half] },
      { pos: [cx - half, cy] },
    ],
  };
}

{
  const outer = closedSquare(0.5, 0.5, 0.2);
  const inner = closedSquare(0.5, 0.5, 0.08);
  const islands = groupHoleIslands([outer, inner]);
  check(
    "donut: outer is the island root, inner is its hole",
    !!islands &&
      islands.length === 1 &&
      islands[0].root === 0 &&
      islands[0].holes.length === 1 &&
      islands[0].holes[0] === 1,
    JSON.stringify(islands)
  );
}

{
  const outer = closedSquare(0.5, 0.5, 0.2);
  const inner = closedSquare(0.5, 0.5, 0.08);
  const islands = groupHoleIslands([inner, outer]);
  check(
    "donut reversed: larger contour is still the root",
    !!islands &&
      islands.length === 1 &&
      islands[0].root === 1 &&
      islands[0].holes.length === 1 &&
      islands[0].holes[0] === 0,
    JSON.stringify(islands)
  );
}

{
  const a = closedSquare(0.25, 0.5, 0.1);
  const b = closedSquare(0.75, 0.5, 0.1);
  const islands = groupHoleIslands([a, b]);
  check(
    "side-by-side: two hole-less islands (fill_holes paints nothing)",
    !!islands &&
      islands.length === 2 &&
      islands.every((isl) => isl.holes.length === 0),
    JSON.stringify(islands)
  );
}

{
  const outer = closedSquare(0.5, 0.5, 0.3);
  const mid = closedSquare(0.5, 0.5, 0.18);
  const inner = closedSquare(0.5, 0.5, 0.06);
  const islands = groupHoleIslands([outer, mid, inner]);
  const byRoot = new Map(islands?.map((isl) => [isl.root, isl]) ?? []);
  check(
    "three nested rings: outer punches mid; inner is its own island",
    !!islands &&
      byRoot.get(0)?.holes.length === 1 &&
      byRoot.get(0)?.holes[0] === 1 &&
      byRoot.get(2)?.holes.length === 0 &&
      !byRoot.has(1),
    JSON.stringify(islands)
  );
}

{
  check("single contour is not an island group", groupHoleIslands([closedSquare(0.5, 0.5, 0.1)]) === null);
}

{
  const byName = new Map(rasterizeSplineNode.params.map((p) => [p.name, p]));
  const fillHoles = byName.get("fill_holes");
  check("declares fill_holes", !!fillHoles && fillHoles.type === "boolean" && fillHoles.default === false);
  const vis = (name: string, p: Record<string, unknown>) =>
    byName.get(name)?.visibleIf?.(p) ?? true;
  check("fill_holes shows with fill on", vis("fill_holes", { enable_fill: true }));
  check("fill_holes hides with fill off", !vis("fill_holes", { enable_fill: false }));
  check(
    "punch holes hides while fill_holes is on",
    vis("holes", { enable_fill: true }) &&
      !vis("holes", { enable_fill: true, fill_holes: true })
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
