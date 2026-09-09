// Guards color-ramp offset wrapping: offset 0 keeps t=1 on the last stop;
// any other offset slides t and wraps so 1.2 ≡ 0.2 (the gradient loops
// instead of pinning at the end).
//
//   npx tsx scripts/check-color-ramp.mts

import {
  offsetRampT,
  sampleColorRampRgba01,
  type ColorRampStop,
} from "../src/engine/color-ramp.ts";
import { colorRampNode } from "../src/nodes/effect/color-ramp.ts";
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
}

{
  const names = colorRampNode.params.map((p) => p.name);
  check("Color Ramp declares offset", names.includes("offset"));
  const names2 = rasterizeSplineNode.params.map((p) => p.name);
  check(
    "Rasterize Spline declares stroke_ramp_offset",
    names2.includes("stroke_ramp_offset")
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll color-ramp offset checks passed.");
