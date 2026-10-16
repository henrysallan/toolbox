// check-layer-properties: the Layers editor's property model
// (specdocs/101526_layer-transforms-parenting.md §5, M2) — the P / S / R / T
// / A / U reveal state machine, grouped-lane display blocks, member-key
// selection, and D5's bar-slide key shift.
//
//   npx tsx scripts/check-layer-properties.mts

import type { KeyframeAnimationBlock } from "../src/engine/keyframes.ts";
import {
  animatedProperties,
  applyRevealKey,
  LAYER_PROPERTIES,
  memberKeysAt,
  mergeLaneBlocks,
  revealedProperties,
  revealKeyFor,
  shiftBlocks,
  toggleRevealAll,
  type Reveal,
} from "../src/components/effects/timeline/layer-properties.ts";
import { buildGroupBases, staggerKeyframes } from "../src/components/effects/timeline/keyframe-ops.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const show = (m: ReadonlyMap<string, Reveal>) => JSON.stringify([...m]);

const block = (ticks: number[], values: unknown[] = ticks, animated = true): KeyframeAnimationBlock => ({
  animated,
  trackVisible: true,
  keyframes: ticks.map((tick, i) => ({ tick, value: values[i], easingOut: "linear" })),
});

// ── Letters ─────────────────────────────────────────────────────────────
check(
  "letters: A/P/S/R/T/U map to their properties, case-insensitively",
  revealKeyFor("a") === "anchor" && revealKeyFor("P") === "position" && revealKeyFor("s") === "scale" &&
    revealKeyFor("R") === "rotation" && revealKeyFor("t") === "opacity" && revealKeyFor("U") === "animated" &&
    revealKeyFor("x") === null
);
check(
  "properties: AE order Anchor, Position, Scale, Rotation, Opacity",
  LAYER_PROPERTIES.map((p) => p.key).join(",") === "anchor,position,scale,rotation,opacity"
);
check(
  "properties: grouped params",
  JSON.stringify(LAYER_PROPERTIES.map((p) => p.params)) ===
    JSON.stringify([["pivotX", "pivotY"], ["translateX", "translateY"], ["scaleX", "scaleY"], ["rotate"], ["opacity"]])
);

const none = () => [] as const;

// ── Bare keys ───────────────────────────────────────────────────────────
{
  const s1 = applyRevealKey(new Map(), ["L1", "L2"], "position", false, none);
  check("bare P: solos Position on every target", show(s1) === '[["L1",["position"]],["L2",["position"]]]', show(s1));
  const s2 = applyRevealKey(s1, ["L1", "L2"], "position", false, none);
  check("bare P again: collapses when every target already solos it", s2.size === 0, show(s2));
  const s3 = applyRevealKey(new Map([["L1", ["position"] as Reveal]]), ["L1", "L2"], "position", false, none);
  check("bare P on mixed targets: solos all rather than collapsing", s3.size === 2 && show(s3).includes('"L2",["position"]'), show(s3));
  const s4 = applyRevealKey(new Map([["L1", "all" as Reveal]]), ["L1"], "rotation", false, none);
  check("bare R on an all-row: replaces with Rotation only", show(s4) === '[["L1",["rotation"]]]', show(s4));
  const s5 = applyRevealKey(new Map([["L9", ["scale"] as Reveal]]), ["L1"], "scale", false, none);
  check("bare key leaves non-target rows alone", s5.get("L9")?.toString() === "scale" && s5.get("L1")?.toString() === "scale");
  check("no targets: no change", applyRevealKey(s5, [], "scale", false, none).size === s5.size);
}

// ── Shift (additive) ────────────────────────────────────────────────────
{
  const p = new Map([["L1", ["position"] as Reveal]]);
  const s1 = applyRevealKey(p, ["L1"], "rotation", true, none);
  check("Shift+R adds Rotation, kept in AE order", show(s1) === '[["L1",["position","rotation"]]]', show(s1));
  const s2 = applyRevealKey(s1, ["L1"], "anchor", true, none);
  check("Shift+A adds Anchor ahead of Position (canonical order)", show(s2) === '[["L1",["anchor","position","rotation"]]]', show(s2));
  const s3 = applyRevealKey(s2, ["L1"], "position", true, none);
  check("Shift+P removes Position when shown", show(s3) === '[["L1",["anchor","rotation"]]]', show(s3));
  const s4 = applyRevealKey(new Map([["L1", ["opacity"] as Reveal]]), ["L1"], "opacity", true, none);
  check("Shift removing the last property collapses the row", s4.size === 0, show(s4));
  const s5 = applyRevealKey(new Map([["L1", "all" as Reveal]]), ["L1"], "scale", true, none);
  check(
    "Shift+S on an all-row removes Scale (explicit subset, promoted dropped)",
    show(s5) === '[["L1",["anchor","position","rotation","opacity"]]]',
    show(s5)
  );
  const s6 = applyRevealKey(new Map([["L1", "all" as Reveal]]), ["L1", "L2"], "scale", true, none);
  check("Shift+S where one target lacks it: adds to L2, L1 stays all", s6.get("L1") === "all" && show(s6).includes('"L2",["scale"]'), show(s6));
}

// ── U (animated) ────────────────────────────────────────────────────────
{
  const animatedOf = (id: string) => (id === "L1" ? (["rotation", "position"] as const) : ([] as const));
  const s1 = applyRevealKey(new Map([["L2", ["scale"] as Reveal]]), ["L1", "L2"], "animated", false, animatedOf);
  check("bare U: animated properties per row (AE order); a row with none collapses", show(s1) === '[["L1",["position","rotation"]]]', show(s1));
  const s2 = applyRevealKey(s1, ["L1"], "animated", false, animatedOf);
  check("bare U again: collapses", s2.size === 0, show(s2));
  const s3 = applyRevealKey(new Map([["L1", ["opacity"] as Reveal]]), ["L1", "L2"], "animated", true, animatedOf);
  check("Shift+U adds the animated ones; a row with none is left as it was", show(s3) === '[["L1",["position","rotation","opacity"]]]', show(s3));
}

// ── Chevron + revealed ──────────────────────────────────────────────────
{
  const s1 = toggleRevealAll(new Map(), "L1");
  check("chevron opens to all", s1.get("L1") === "all");
  check("chevron closes", toggleRevealAll(s1, "L1").size === 0);
  const all = revealedProperties("all");
  check("all → every property plus promoted params", all.properties.length === 5 && all.promoted);
  const sub = revealedProperties(["scale"]);
  check("subset → just those, no promoted", sub.properties.map((p) => p.key).join() === "scale" && !sub.promoted);
  check("collapsed → nothing", revealedProperties(undefined).properties.length === 0);
}

// ── animatedProperties ──────────────────────────────────────────────────
{
  const anim: Record<string, KeyframeAnimationBlock> = {
    translateY: block([0, 10]),
    rotate: block([0, 10], [0, 1], false), // keys but disabled
    opacity: block([]),
  };
  const got = animatedProperties("L", (_n, p) => anim[p]);
  check("animated: one keyed member makes the group animated; disabled / empty blocks don't", got.join() === "position", got.join());
}

// ── Grouped display block ───────────────────────────────────────────────
{
  const x = block([0, 10, 20], [0, 0.5, 0.5]);
  const y = block([10, 30], [1, 1]);
  const m = mergeLaneBlocks([x, y])!;
  check("merge: one diamond per distinct tick across members", m.keyframes.map((k) => k.tick).join() === "0,10,20,30");
  check(
    "merge: value is the members' evaluated values (holds before / after their keys)",
    JSON.stringify(m.keyframes.map((k) => k.value)) === "[[0,1],[0.5,1],[0.5,1],[0.5,1]]",
    JSON.stringify(m.keyframes.map((k) => k.value))
  );
  check(
    "merge: a segment where only one member is keyed but nothing changes reads as holding",
    JSON.stringify(m.keyframes[2].value) === JSON.stringify(m.keyframes[3].value)
  );
  const withEmpty = mergeLaneBlocks([x, undefined])!;
  check("merge: a member with no keys contributes null", withEmpty.keyframes.every((k) => (k.value as unknown[])[1] === null));
  check("merge: single-member lane passes its block through", mergeLaneBlocks([x]) === x);
  check("merge: no keys anywhere → an existing (empty) block or undefined", mergeLaneBlocks([undefined, undefined]) === undefined);
}

// ── Member keys ─────────────────────────────────────────────────────────
{
  const anim: Record<string, KeyframeAnimationBlock> = { translateX: block([0, 10]), translateY: block([10]) };
  const get = (_n: string, p: string) => anim[p];
  const at10 = memberKeysAt("L", ["translateX", "translateY"], 10, get);
  check("member keys at a shared tick: both params", at10.map((k) => k.paramName).join() === "translateX,translateY");
  const at0 = memberKeysAt("L", ["translateX", "translateY"], 0, get);
  check("member keys at a one-member tick: only that param", at0.map((k) => k.paramName).join() === "translateX");
}

// ── D5 shift ────────────────────────────────────────────────────────────
{
  const snap = new Map<string, KeyframeAnimationBlock>([
    ["opacity", block([0, 30])],
    ["rotate", block([15])],
    ["scaleX", block([])],
  ]);
  const ups = shiftBlocks("L", snap, 12);
  check("shift: every keyed own block moves by Δ; empty blocks are skipped", ups.length === 2);
  check(
    "shift: ticks offset from the snapshot",
    ups.find((u) => u.paramName === "opacity")?.next?.keyframes.map((k) => k.tick).join() === "12,42" &&
      ups.find((u) => u.paramName === "rotate")?.next?.keyframes[0].tick === 27
  );
  check("shift: snapshot is not mutated", snap.get("opacity")!.keyframes[0].tick === 0);
  const back = shiftBlocks("L", snap, -5);
  check("shift: negative Δ from the same snapshot (no compounding)", back.find((u) => u.paramName === "opacity")?.next?.keyframes[0].tick === -5);
}

// ── Stagger with grouped lanes (review fix) ───────────────────────────
{
  const anim: Record<string, KeyframeAnimationBlock> = {
    translateX: block([1000]),
    translateY: block([1000]),
    rotate: block([1000]),
  };
  const sel = ["translateX", "translateY", "rotate"].map((paramName) => ({ nodeId: "L", paramName, tick: 1000 }));
  const bases = buildGroupBases(sel, (_n, p) => anim[p]);
  const lane: Record<string, number> = { translateX: 0, translateY: 0, rotate: 1 };
  const grouped = staggerKeyframes(bases, 1000, { snap: true, ticksPerFrame: 1000 }, (b) => lane[b.paramName]);
  const tickOf = (r: typeof grouped, p: string) => r.updates.find((u) => u.paramName === p)?.keyframes[0].tick;
  check(
    "stagger: a grouped lane's members move together; the next lane steps once",
    tickOf(grouped, "translateX") === 1000 && tickOf(grouped, "translateY") === 1000 && tickOf(grouped, "rotate") === 2000,
    JSON.stringify(grouped.updates.map((u) => [u.paramName, u.keyframes[0].tick]))
  );
  const plain = staggerKeyframes(bases, 1000, { snap: true, ticksPerFrame: 1000 });
  check(
    "stagger: default (no laneOf) still fans every base — Tracks behaviour unchanged",
    tickOf(plain, "translateX") === 1000 && tickOf(plain, "translateY") === 2000 && tickOf(plain, "rotate") === 3000
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall layer-property checks passed");
