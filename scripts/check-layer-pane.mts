// check-layer-pane: the Layers editor label pane's width clamp, which
// optional columns fit (Blend drops first, then Parent), and the per-viewer
// storage round trip including a throwing / missing storage
// (specdocs/101526_layer-transforms-parenting.md §6, M3).
//
//   npx tsx scripts/check-layer-pane.mts

import {
  BLEND_SLOT,
  clampCardWidth,
  LABEL_CARD_DEFAULT,
  LABEL_CARD_MAX,
  LABEL_CARD_MIN,
  LABEL_WIDTH_STORAGE_KEY,
  NAME_MIN,
  PARENT_SLOT,
  paneColumns,
  readCardWidth,
  ROW_FIXED,
  writeCardWidth,
} from "../src/components/effects/timeline/layer-pane.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Clamp ───────────────────────────────────────────────────────────────
check("clamp: below min → min", clampCardWidth(20) === LABEL_CARD_MIN);
check("clamp: above max → max", clampCardWidth(5000) === LABEL_CARD_MAX);
check("clamp: rounds", clampCardWidth(301.6) === 302);
check("clamp: NaN / Infinity → default", clampCardWidth(NaN) === LABEL_CARD_DEFAULT && clampCardWidth(Infinity) === LABEL_CARD_DEFAULT);

// ── Columns ─────────────────────────────────────────────────────────────
{
  const blendAt = ROW_FIXED + NAME_MIN + BLEND_SLOT;
  check("columns: the default width shows Blend", paneColumns(LABEL_CARD_DEFAULT, false).blend);
  check(
    "columns: the default width shows Blend AND Parent",
    paneColumns(LABEL_CARD_DEFAULT, true).blend && paneColumns(LABEL_CARD_DEFAULT, true).parent
  );
  check("columns: Blend shows exactly at its threshold", paneColumns(blendAt, false).blend && !paneColumns(blendAt - 1, false).blend);
  check("columns: the min width shows neither", !paneColumns(LABEL_CARD_MIN, true).blend && !paneColumns(LABEL_CARD_MIN, true).parent);
  const both = ROW_FIXED + NAME_MIN + BLEND_SLOT + PARENT_SLOT;
  const p = paneColumns(both, true);
  check("columns: wide enough shows Blend and Parent", p.blend && p.parent);
  const narrower = paneColumns(both - 1, true);
  check("columns: narrowing drops Blend first, Parent stays", !narrower.blend && narrower.parent);
  const parentOnly = ROW_FIXED + NAME_MIN + PARENT_SLOT;
  check("columns: then Parent drops", paneColumns(parentOnly, true).parent && !paneColumns(parentOnly - 1, true).parent);
  check("columns: without a Parent column, Blend gets the space", paneColumns(blendAt, false).blend && !paneColumns(blendAt, false).parent);
  // Monotone: widening never hides a column.
  let ok = true;
  let prev = { blend: false, parent: false };
  for (let w = LABEL_CARD_MIN; w <= LABEL_CARD_MAX; w++) {
    const c = paneColumns(w, true);
    if ((prev.blend && !c.blend && !(c.parent && !prev.parent)) || (prev.parent && !c.parent)) ok = false;
    prev = c;
  }
  check("columns: widening never hides Parent, and only hides Blend when Parent claims the space", ok);
}

// ── Storage ─────────────────────────────────────────────────────────────
{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  check("storage: empty → default", readCardWidth(storage) === LABEL_CARD_DEFAULT);
  writeCardWidth(storage, 333.4);
  check("storage: round trip (clamped, rounded)", readCardWidth(storage) === 333 && mem.get(LABEL_WIDTH_STORAGE_KEY) === "333");
  mem.set(LABEL_WIDTH_STORAGE_KEY, "9999");
  check("storage: an out-of-range saved value is clamped on read", readCardWidth(storage) === LABEL_CARD_MAX);
  mem.set(LABEL_WIDTH_STORAGE_KEY, "garbage");
  check("storage: junk → default", readCardWidth(storage) === LABEL_CARD_DEFAULT);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  let threw = false;
  try {
    check("storage: a throwing storage reads the default", readCardWidth(throwing) === LABEL_CARD_DEFAULT);
    writeCardWidth(throwing, 300);
  } catch {
    threw = true;
  }
  check("storage: a throwing storage never throws out", !threw);
  check("storage: missing storage reads the default", readCardWidth(null) === LABEL_CARD_DEFAULT && readCardWidth(undefined) === LABEL_CARD_DEFAULT);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall layer-pane checks passed");
