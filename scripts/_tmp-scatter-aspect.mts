// Temporary: scatter-points canvas-fill vs authored-y on non-square canvases.
import { scatterPointsNode } from "@/nodes/effect/scatter-points";
import { aspectCorrectY } from "@/engine/aspect";
import type { PointsValue } from "@/engine/types";

function run(w: number, h: number) {
  const out = scatterPointsNode.compute({
    inputs: {},
    auxIn: {},
    params: {
      count: 800,
      seed: 7,
      rotation_deg: 0,
      rotation_jitter_deg: 0,
      scale: 1,
      scale_jitter: 0,
    },
    ctx: { width: w, height: h, state: {} } as never,
    nodeId: "s1",
  }) as { primary: PointsValue };
  const pts = out.primary;
  const aspect = w / h;
  let minA = Infinity,
    maxA = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (let i = 0; i < pts.count; i++) {
    const ay = pts.positions[i * 2 + 1];
    const cy = aspectCorrectY(ay, aspect);
    if (ay < minA) minA = ay;
    if (ay > maxA) maxA = ay;
    if (cy < minC) minC = cy;
    if (cy > maxC) maxC = cy;
  }
  return { minA, maxA, minC, maxC, n: pts.count };
}

function near(label: string, v: number, lo: number, hi: number) {
  const ok = v >= lo && v <= hi;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${v.toFixed(4)} (want ${lo}..${hi})`);
  if (!ok) process.exitCode = 1;
}

for (const [name, w, h] of [
  ["square", 1024, 1024],
  ["landscape 16:9", 1920, 1080],
  ["portrait 9:16", 1080, 1920],
] as const) {
  const r = run(w, h);
  console.log(`\n${name} ${w}x${h}`);
  // Canvas-space coverage: points must span (nearly) the full height.
  near("canvas y min", r.minC, 0, 0.05);
  near("canvas y max", r.maxC, 0.95, 1);
  const aspect = w / h;
  const authoredLo = 0.5 + (0 - 0.5) / aspect;
  const authoredHi = 0.5 + (1 - 0.5) / aspect;
  near("authored y min near canvas-0", r.minA, authoredLo - 0.05, authoredLo + 0.05);
  near("authored y max near canvas-1", r.maxA, authoredHi - 0.05, authoredHi + 0.05);
}

const fp = scatterPointsNode.fingerprintExtras?.({}, {
  width: 1920,
  height: 1080,
} as never);
console.log(`\nfingerprintExtras: ${fp}`);
if (fp !== "1920x1080") {
  console.log("FAIL fingerprintExtras");
  process.exitCode = 1;
}
