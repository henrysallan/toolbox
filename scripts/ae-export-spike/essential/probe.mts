// Essential Properties lane (M4 lane 6): the headless support question.
// Runs probe.jsx in aerender's render core (one launch, calibrate/ae.mts's
// env-gated startup hook, under the AE lock), renders the saved project's
// queued frame in a second plain launch, and prints what After Effects did.
//
//   npx tsx scripts/ae-export-spike/essential/probe.mts [--work DIR]
//   npx tsx scripts/ae-export-spike/essential/probe.mts --second   probe2.jsx (no render)
//   npx tsx scripts/ae-export-spike/essential/probe.mts --ocio     probe-ocio.jsx: the
//       startup project's color management (a sticky "last project" setting)
//
// Writes <work>/essential-probe.json (the job's readings) and prints the
// pixel checks: instance A keeps the comp's own control values, instance B
// carries Essential Properties overrides, and both reach the dot through
// expressions on the precomp's internal properties.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAeFrame, renderQueue, renderedFile, runAeJob } from "../calibrate/ae.mts";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-essential-${Date.now()}`);
const renders = join(WORK, "renders");
mkdirSync(renders, { recursive: true });
const project = join(WORK, "essential-probe.aep");

if (args.includes("--ocio")) {
  const j3 = await runAeJob("essential-ocio", "../essential/probe-ocio.jsx", { project: join(WORK, "essential-ocio-none.aep") }, WORK, 120_000);
  console.log(JSON.stringify(j3.out, null, 2));
  process.exit(0);
}
if (args.includes("--second")) {
  const j2 = await runAeJob("essential-probe2", "../essential/probe2.jsx", { project: join(WORK, "essential-probe2.aep"), renders }, WORK, 180_000);
  console.log(`job: ${j2.seconds.toFixed(1)} s, aerender exit ${j2.code}`);
  console.log(JSON.stringify(j2.out, null, 2));
  process.exit(j2.out.errors.length ? 1 : 0);
}

const job = await runAeJob("essential-probe", "../essential/probe.jsx", { project, renders }, WORK, 180_000);
console.log(`job: ${job.seconds.toFixed(1)} s, aerender exit ${job.code}`);
console.log(JSON.stringify(job.out, null, 2));
const r = await renderQueue(project, WORK, 180_000);
console.log(`render: ${r.seconds.toFixed(1)} s, exit ${r.code}`);
const file = renderedFile(renders, "main_f0");
if (!file) {
  console.log("no frame rendered");
  process.exit(1);
}
const img = await readAeFrame(file);
const px = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)).map((v) => Math.round(v * 255));
const checks: [string, number[], number[]][] = [
  ["A centre: the comp's own Tint (green)", px(100, 100), [0, 255, 0, 255]],
  // Outside every layer the frame is transparent (the comp background is
  // not part of the alpha).
  ["A at r = 50: outside its own Radius 30", px(150, 100), [0, 0, 0, 0]],
  ["B centre: overridden Tint (red)", px(300, 100), [255, 0, 0, 255]],
  ["B at r = 50: inside its overridden Radius 70", px(350, 100), [255, 0, 0, 255]],
];
let bad = 0;
for (const [label, got, want] of checks) {
  const ok = got.every((v, i) => Math.abs(v - want[i]) <= 3);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
process.exit(bad ? 1 : 0);
