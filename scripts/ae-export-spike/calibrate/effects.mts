// List the effects installed in After Effects headlessly and dump the
// property trees of the ones the effect-class nodes map to.
//
//   npx tsx scripts/ae-export-spike/calibrate/effects.mts [--work DIR]
//
// Writes calibrate/measured/effects.json: the verified match names (with
// display name / category) of every effect check-calibration allows, and
// each one's property tree. The full app.effects list goes to <work>.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, runAeJob } from "./ae.mts";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-calibrate-${Date.now()}`);

// Candidates: the classes.ts names plus the alternatives a node may route to.
export const CANDIDATES = [
  "ADBE Gaussian Blur 2",
  "ADBE Camera Lens Blur",
  "ADBE Mosaic",
  "ADBE Geometry2",
  "ADBE Posterize",
  "ADBE Threshold2",
  "ADBE Mirror",
  "ADBE Polar Coordinates",
  "ADBE Displacement Map",
  "ADBE Glo2",
  "VISINF Grain Implant",
  "ADBE Noise",
  "ADBE Find Edges",
  "ADBE HUE SATURATION",
  "ADBE Brightness & Contrast 2",
  "ADBE Sharpen",
  "ADBE Unsharp Mask2",
  "ADBE Tile",
  "ADBE Echo",
  "Mettle SkyBox Chromatic Aberrat",
  "ADBE Apply Color LUT2",
  "ADBE Linear Color Key2",
  "ADBE Color Key",
  "ADBE Extract",
  "Keylight 906",
  "ADBE Bevel Alpha",
  "ADBE Ramp",
  "ADBE Shift Channels",
  "ADBE Offset",
  "ADBE Easy Levels2",
  "ADBE Emboss",
  "ADBE Color Emboss",
  "ADBE Exposure2",
  "ADBE Tint",
  "ADBE Fill",
  "ADBE Invert",
  "ADBE Set Matte3",
  "ADBE CHANNEL MIXER",
  "ADBE Pro Levels2",
  "CC Threshold RGB",
];

// Adding these opens a modal dialog in aerender's core and hangs it forever:
// Apply Color LUT asks for a .cube file on apply (FILE_DoOpenDialog under
// AE_APPLYCOLORLUT::EffectMainShared, sampled 2026-10-20). Listed, not added.
export const DIALOG_ON_APPLY = ["ADBE Apply Color LUT2"];

const r = await runAeJob("effects", "effects.jsx", { dump: CANDIDATES.filter((m) => !DIALOG_ON_APPLY.includes(m)) }, WORK, 180_000);
console.log(`aerender ${r.code} in ${r.seconds.toFixed(1)} s; ${r.out.effects?.length ?? 0} effects; errors: ${JSON.stringify(r.out.errors)}`);
writeFileSync(join(WORK, "app-effects.json"), JSON.stringify(r.out.effects, null, 1));
const byMatch = new Map<string, { displayName: string; category: string }>(r.out.effects.map((e: { matchName: string; displayName: string; category: string }) => [e.matchName, e]));
const verified: Record<string, { displayName: string; category: string }> = {};
for (const m of CANDIDATES) {
  const e = byMatch.get(m);
  console.log(`${e ? "ok  " : "MISS"} ${m}${e ? ` — ${e.displayName} (${e.category})` : ""}`);
  if (e) verified[m] = { displayName: e.displayName, category: e.category };
}
mkdirSync(join(HERE, "measured"), { recursive: true });
writeFileSync(
  join(HERE, "measured", "effects.json"),
  JSON.stringify({ ae: r.out.ae, installed: r.out.effects.length, verified, dialogOnApply: DIALOG_ON_APPLY, trees: r.out.trees }, null, 1) + "\n"
);
console.log(`work: ${WORK}`);
