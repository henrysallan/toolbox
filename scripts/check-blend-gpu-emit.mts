// Stage 1 of check:blend-gpu — build the corpus jobs, pack them exactly the
// way the live GPU path does (same packFieldJob), and write the
// texture-ready payload for the Electron harness (check-blend-gpu.cjs).
// The CPU reference grids are NOT emitted; the verify stage recomputes them
// from the shared corpus module, keeping this file small.
//
//   npx tsx scripts/check-blend-gpu-emit.mts <cases.json>
import { writeFileSync } from "node:fs";
import { buildCorpus } from "./blend-gpu-corpus.mts";
import { buildFieldJob } from "../src/engine/spline-blend-intersections.ts";
import {
  BLEND_FIELD_FS,
  packFieldJob,
} from "../src/engine/spline-blend-intersections-gpu.ts";

const cases = [];
for (const c of buildCorpus()) {
  const job = buildFieldJob(c.spline, c.canvasW, c.canvasH, c.opts);
  if (!job) throw new Error(`corpus case ${c.name} produced no field job`);
  const packed = packFieldJob(job);
  cases.push({
    name: c.name,
    gw: job.gw,
    gh: job.gh,
    dataW: packed.dataW,
    segRows: packed.segRows,
    candRows: packed.candRows,
    bCols: job.bCols,
    bRows: job.bRows,
    uniforms: {
      bx0: job.bx0,
      by0: job.by0,
      cell: job.cell,
      bucket: job.bucket,
      influence: job.influence,
      influenceSq: job.influenceSq,
      r: job.r,
      k: job.k,
      farSlack: job.farSlack,
    },
    segTexels: Array.from(packed.segTexels),
    metaTexels: Array.from(packed.metaTexels),
    bucketTexels: Array.from(packed.bucketTexels),
    candTexels: Array.from(packed.candTexels),
  });
}

writeFileSync(
  process.argv[2] ?? ".blendgpu.cases.json",
  JSON.stringify({ fs: BLEND_FIELD_FS, cases })
);
console.log(`emitted ${cases.length} blend-field cases`);
