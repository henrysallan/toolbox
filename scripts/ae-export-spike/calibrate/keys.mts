// The AE behaviours convert/keys.ts could not measure (spec §14), measured in
// AE 26.5 by keying properties and reading valueAtTime back densely:
//
//   1. one-ease COLOR speed units      (keys.ts magnitude(), mode "color")
//   2. SHAPE (path) ease speed units   (AE_SHAPE_EASE_MAGNITUDE)
//   3. influences summing past 100 %   (easeInOutCubic's Editable fit: 125 %)
//   4. a one-ease color past its keys  (a fit's control-point overshoot)
//
//   npx tsx scripts/ae-export-spike/calibrate/keys.mts [--work DIR]
//
// Writes calibrate/measured/keys.json: every test's keys and AE's samples.
// check-calibration replays the samples through evaluateAeKeys /
// evaluateAePathProp and holds the recorded errors.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, runAeJob } from "./ae.mts";
import { aeEasingRow, pieceEases } from "@/lib/ae-export/convert/easing";
import type { AeKey, AePath } from "@/lib/ae-export/types";
import { replayKeyTest, type KeyTest } from "./keys-replay.mts";

const args = process.argv.slice(2);
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-keys-${Date.now()}`);
mkdirSync(WORK, { recursive: true });

const N = 120;
const times = Array.from({ length: N + 1 }, (_, i) => 0.25 + (1.5 * i) / N); // keys at 0.25 and 1.25; past both ends
const T0 = 0.25;
const T1 = 1.25;
const bez = (t: number, v: unknown, easeIn?: [number, number], easeOut?: [number, number]): AeKey => ({
  t,
  v,
  inInterp: "bezier",
  outInterp: "bezier",
  ...(easeIn ? { easeIn: [{ speed: easeIn[0], influence: easeIn[1] }] } : {}),
  ...(easeOut ? { easeOut: [{ speed: easeOut[0], influence: easeOut[1] }] } : {}),
});

const tests: KeyTest[] = [];
// 1. color: [r, g, b, a] 0–1.
const RED = [1, 0, 0, 1];
const BLUE = [0, 0, 1, 1];
for (const s of [0.5, 1.5, 3]) tests.push({ id: `color-rb-s${s}`, kind: "color", keys: [bez(T0, RED, [0, 33.3], [s, 60]), bez(T1, BLUE, [0, 40], [0, 33.3])], times });
tests.push({ id: "color-bw-s1.5", kind: "color", keys: [bez(T0, [0, 0, 0, 1], [0, 33.3], [1.5, 60]), bez(T1, [1, 1, 1, 1], [0.8, 40], [0, 33.3])], times });
tests.push({ id: "color-small-s0.5", kind: "color", keys: [bez(T0, [0.2, 0.2, 0.2, 1], [0, 33.3], [0.5, 60]), bez(T1, [0.5, 0.2, 0.2, 1], [0, 40], [0, 33.3])], times });
// 4. a one-ease color with negative speeds (a fit's dip below its key).
const C0_ = [0.2, 0.5, 0.8, 1];
const C1_ = [0.8, 0.5, 0.2, 1];
tests.push({ id: "color-neg", kind: "color", keys: [bez(T0, C0_, [0, 33.3], [-100, 50]), bez(T1, C1_, [-100, 50], [0, 33.3])], times });
tests.push({ id: "color-linear", kind: "color", keys: [{ t: T0, v: RED, inInterp: "linear", outInterp: "linear" }, { t: T1, v: BLUE, inInterp: "linear", outInterp: "linear" }], times });

// One-ease handles that would leave the key range (AE caps their influence)
// and negative speeds (AE stores 0), on color, path and spatial Position.
const C0 = [0.2, 0.5, 0.8, 1];
const C1 = [0.8, 0.5, 0.2, 1];
const LC = 255 * Math.hypot(0.6, 0, 0.6);
for (const y of [0.96, 1.2, 1.8, 3]) tests.push({ id: `color-cap-out${y}`, kind: "color", keys: [bez(T0, C0, [0, 33.3], [(y * LC) / 0.6, 60]), bez(T1, C1, [0, 40], [0, 33.3])], times });
tests.push({ id: "color-cap-in3", kind: "color", keys: [bez(T0, C0, [0, 33.3], [0, 40]), bez(T1, C1, [(3 * LC) / 0.6, 60], [0, 33.3])], times });
const P0 = [100, 120];
const P1 = [300, 220];
const LP = Math.hypot(200, 100);
for (const y of [0.6, 1.8]) tests.push({ id: `position-out${y}`, kind: "position", keys: [bez(T0, P0, [0, 33.3], [(y * LP) / 0.6, 60]), bez(T1, P1, [0, 40], [0, 33.3])], times });
tests.push({ id: "position-neg", kind: "position", keys: [bez(T0, P0, [0, 33.3], [-100, 50]), bez(T1, P1, [-100, 50], [0, 33.3])], times });

// 2. path: a square that grows, one that moves far, one that barely moves.
const square = (cx: number, cy: number, h: number): AePath => ({
  vertices: [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]],
  inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  closed: true,
});
tests.push({ id: "path-neg", kind: "path", keys: [bez(T0, square(200, 200, 50), [0, 33.3], [-1, 50]), bez(T1, square(200, 200, 100), [-1, 50], [0, 33.3])], times });
tests.push({ id: "path-cap-in3", kind: "path", keys: [bez(T0, square(200, 200, 50), [0, 33.3], [0, 40]), bez(T1, square(200, 200, 100), [3, 60], [0, 33.3])], times });
for (const s of [0.5, 1.5, 3, 5]) tests.push({ id: `path-grow-s${s}`, kind: "path", keys: [bez(T0, square(200, 200, 50), [0, 33.3], [s, 60]), bez(T1, square(200, 200, 100), [0, 40], [0, 33.3])], times });
tests.push({ id: "path-move-s1.5", kind: "path", keys: [bez(T0, square(60, 60, 20), [0, 33.3], [1.5, 60]), bez(T1, square(340, 300, 30), [0.6, 40], [0, 33.3])], times });
tests.push({ id: "path-tiny-s1.5", kind: "path", keys: [bez(T0, square(200, 200, 50), [0, 33.3], [1.5, 60]), bez(T1, square(201, 200, 50), [0, 40], [0, 33.3])], times });

// 3. influence sums on a scalar (Rotation, degrees): 100 % control, the
// easeInOutCubic Editable fit (125 %), 150 %, 190 %.
const row = aeEasingRow("easeInOutCubic")!;
if (row.editable.kind !== "pieces") throw new Error("easeInOutCubic editable is not one piece");
const e = pieceEases(row.editable.pieces[0], 1, 100);
tests.push({ id: "infl-125-easeInOutCubic", kind: "scalar", keys: [bez(T0, 0, [0, 33.3], [e.out.speed, e.out.influence]), bez(T1, 100, [e.in.speed, e.in.influence], [0, 33.3])], times });
for (const [o, i] of [[50, 50], [75, 75], [95, 95], [90, 30]]) tests.push({ id: `infl-${o + i}-o${o}-i${i}`, kind: "scalar", keys: [bez(T0, 0, [0, 33.3], [20, o]), bez(T1, 100, [40, i], [0, 33.3])], times });

const r = await runAeJob("keys", "keys.jsx", { tests }, WORK, 180_000);
if (r.out.errors.length) console.log("errors:", r.out.errors);
const results = r.out.results as { id: string; kind: string; eases: unknown; values: unknown[] }[];

const out = tests.map((t) => {
  const got = results.find((x) => x.id === t.id);
  return { ...t, ae: got?.values ?? null, aeEases: got?.eases ?? null };
});
for (const t of out) {
  if (!t.ae) {
    console.log(`${t.id}: no AE result`);
    continue;
  }
  const rep = replayKeyTest(t as KeyTest & { ae: unknown[] });
  console.log(`${t.id.padEnd(26)} ${JSON.stringify(rep)}`);
}
mkdirSync(join(HERE, "measured"), { recursive: true });
// One test per line, numbers to 10 significant digits (far inside the replay
// tolerances).
const sig = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(10)) : v);
writeFileSync(
  join(HERE, "measured", "keys.json"),
  `{"ae":${JSON.stringify(r.out.ae)},"measured":${JSON.stringify(new Date().toISOString().slice(0, 10))},"tests":[\n${out.map((t) => JSON.stringify(t, sig)).join(",\n")}\n]}\n`
);
console.log(`wrote ${join(HERE, "measured", "keys.json")}; work ${WORK}`);
