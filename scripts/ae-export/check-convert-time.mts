// convert/time.ts (spec 091926_after-effects-handoff.md §4.6): ticks →
// seconds, and a layer's clip windows → AE inPoint / outPoint / startTime with
// the evaluator's interior-clock rule.

import { makeChecker } from "./harness.mts";
import type { ClipBlock } from "@/engine/clips";
import { layerClockOffsetTicks, layerTimings, localTickToCompSeconds, ticksToSeconds } from "@/lib/ae-export/convert";

const clip = (inTick: number, outTick: number, sourceInTick = 0, enabled = true): ClipBlock => ({ inTick, outTick, sourceInTick, enabled });

export default async function run(): Promise<number> {
  const c = makeChecker("convert-time");
  const tb = { fps: 60 };
  c.near("60000 ticks at 60 fps = 1 s", ticksToSeconds(60000, tb), 1, 0);
  c.near("1500 ticks at 24 fps = 0.0625 s", ticksToSeconds(1500, { fps: 24 }), 0.0625, 0);
  c.near("a custom ticksPerFrame", ticksToSeconds(300, { fps: 30, ticksPerFrame: 100 }), 0.1, 1e-15);
  c.near("interior key at local 0.25 s on a layer offset 0.5 s → comp 0.75 s", localTickToCompSeconds(15000, 30000, tb), 0.75, 1e-15);

  const none = layerTimings(undefined, 300000, tb);
  c.check("no clips → the whole comp at offset 0", none.length === 1 && none[0].inPoint === 0 && none[0].outPoint === 5 && none[0].startTime === 0);
  const one = layerTimings([clip(30000, 90000)], 300000, tb);
  c.check("one window → in 0.5 s, out 1.5 s, startTime 0.5 s", one.length === 1 && one[0].inPoint === 0.5 && one[0].outPoint === 1.5 && one[0].startTime === 0.5, one);
  const slipped = layerTimings([clip(30000, 90000, 12000)], 300000, tb);
  c.near("a slipped window (sourceInTick) moves startTime earlier", slipped[0].startTime, 0.3, 1e-15);
  // A razor cut keeps the clock (splitClipsAt slips the second piece's
  // sourceInTick by the cut), so the two halves are one AE layer.
  const cut = layerTimings([clip(30000, 60000, 0), clip(60000, 90000, 30000)], 300000, tb);
  c.check("a razor cut stays one AE layer", cut.length === 1 && cut[0].inPoint === 0.5 && cut[0].outPoint === 1.5 && cut[0].windows.length === 2, cut);
  const gap = layerTimings([clip(0, 30000), clip(60000, 90000, 60000)], 300000, tb);
  c.check("a gap between windows → two AE layers on the same clock", gap.length === 2 && gap[0].startTime === 0 && gap[1].startTime === 0 && gap[1].inPoint === 1);
  const slid = layerTimings([clip(0, 30000), clip(30000, 60000, 0)], 300000, tb);
  c.check("a window slid onto its own clock → its own AE layer", slid.length === 2 && slid[1].startTime === 0.5);
  const off = layerTimings([clip(0, 30000, 0, false)], 300000, tb);
  c.check("disabled windows don't gate (an unclipped layer)", off.length === 1 && off[0].outPoint === 5 && off[0].windows.length === 0);
  const unordered = layerTimings([clip(60000, 90000, 60000), clip(0, 30000)], 300000, tb);
  c.check("windows sort by in point", unordered[0].inPoint === 0 && unordered[1].inPoint === 1);

  // The evaluator's clock reference: active, else next ahead, else last behind.
  const clips = [clip(30000, 60000, 0), clip(90000, 120000, 10000)];
  c.check("clock offset inside the first window", layerClockOffsetTicks(clips, 40000) === 30000);
  c.check("clock offset before any window = the next one's", layerClockOffsetTicks(clips, 0) === 30000);
  c.check("clock offset between windows = the next one's", layerClockOffsetTicks(clips, 70000) === 80000);
  c.check("clock offset after every window = the last one's", layerClockOffsetTicks(clips, 200000) === 80000);
  c.check("…and each AE layer's offset agrees inside its own window", layerTimings(clips, 300000, tb).every((t) => layerClockOffsetTicks(clips, t.inPoint * 60000) === t.offsetTicks));
  return c.failures;
}
