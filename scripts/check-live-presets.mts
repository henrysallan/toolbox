// check-live-presets: every live-link style preset has its CSS, and the
// registries stay well-formed.
//
// A preset is a registry entry in lib/live-viewer/design.ts PLUS a rule
// block in design-presets.css scoped on `.live-root[data-<class>="<id>"]`
// (081426_live-link-designer.md M4). The two halves live in different files
// and nothing else ties them together — a registry entry without a block
// renders as "classic" silently, which is exactly the kind of drift a
// picker full of look-alike options would hide. "classic" (first entry)
// deliberately has no block: the components' fallbacks are that look.
//
//   npx tsx scripts/check-live-presets.mts

import { readFileSync } from "node:fs";
import path from "node:path";

const {
  DROPDOWN_PRESETS,
  FONT_PRESETS,
  NUMERIC_PRESETS,
  SLIDER_PRESETS,
  TRANSPORT_PRESETS,
  fromSavedLiveDesign,
} = await import("@/lib/live-viewer/design");

const css = readFileSync(
  path.resolve("src/lib/live-viewer/design-presets.css"),
  "utf8"
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const classes: [string, { id: string; label: string }[], string][] = [
  ["slider", SLIDER_PRESETS, "--ps-slider-"],
  ["dropdown", DROPDOWN_PRESETS, "--ps-dd-"],
  ["numeric", NUMERIC_PRESETS, "--ps-num-"],
  ["transport", TRANSPORT_PRESETS, "--ps-tr-"],
];

for (const [cls, registry, varPrefix] of classes) {
  check(`${cls}: first entry is "classic"`, registry[0]?.id === "classic");
  check(
    `${cls}: at least three packs beyond classic`,
    registry.length >= 4,
    String(registry.length)
  );
  const ids = registry.map((p) => p.id);
  check(`${cls}: ids unique`, new Set(ids).size === ids.length);
  check(
    `${cls}: "classic" has no CSS block (fallbacks ARE the classic look)`,
    !css.includes(`[data-${cls}="classic"]`)
  );
  for (const p of registry.slice(1)) {
    const selector = `.live-root[data-${cls}="${p.id}"]`;
    const start = css.indexOf(`${selector} {`);
    check(`${cls}/${p.id}: has a rule block`, start >= 0);
    if (start < 0) continue;
    const block = css.slice(start, css.indexOf("}", start));
    check(
      `${cls}/${p.id}: block sets ${varPrefix}* variables`,
      block.includes(varPrefix)
    );
    check(
      `${cls}/${p.id}: no literal colors (tokens only)`,
      !/#[0-9a-f]{3,8}\b/i.test(block),
      block.match(/#[0-9a-f]{3,8}\b/i)?.[0]
    );
  }
}

// Every non-classic preset must set the SAME variable set (the contract:
// never a subset, so nothing half-inherits the fallbacks).
for (const [cls, registry, varPrefix] of classes) {
  const sets = registry.slice(1).map((p) => {
    const selector = `.live-root[data-${cls}="${p.id}"] {`;
    const start = css.indexOf(selector);
    const block = css.slice(start, css.indexOf("}", start));
    return {
      id: p.id,
      vars: [...block.matchAll(/(--ps-[a-z-]+):/g)].map((m) => m[1]).sort(),
    };
  });
  const ref = sets[0];
  for (const s of sets.slice(1)) {
    check(
      `${cls}/${s.id}: sets the same ${varPrefix}* set as ${ref.id}`,
      JSON.stringify(s.vars) === JSON.stringify(ref.vars),
      JSON.stringify(
        s.vars.filter((v) => !ref.vars.includes(v)).concat(
          ref.vars.filter((v) => !s.vars.includes(v)).map((v) => `missing ${v}`)
        )
      )
    );
  }
}

check("font: at least five stacks", FONT_PRESETS.length >= 5, String(FONT_PRESETS.length));
check(
  "font: every stack ends in a generic family",
  FONT_PRESETS.every((f) => /(sans-serif|serif|monospace)\s*$/.test(f.stack))
);

// Validation round-trips known ids and degrades unknown ones to classic.
const d = fromSavedLiveDesign({
  presets: { slider: "dot", dropdown: "inline", numeric: "split", transport: "round", font: "serif" },
});
check(
  "fromSavedLiveDesign keeps known preset ids",
  d.presets.slider === "dot" &&
    d.presets.dropdown === "inline" &&
    d.presets.numeric === "split" &&
    d.presets.transport === "round" &&
    d.presets.font === "serif",
  JSON.stringify(d.presets)
);
const u = fromSavedLiveDesign({ presets: { slider: "gone", dropdown: 3 } });
check(
  "unknown / absent preset ids degrade to the first entry",
  u.presets.slider === "classic" &&
    u.presets.dropdown === "classic" &&
    u.presets.transport === "classic",
  JSON.stringify(u.presets)
);

console.log(failures === 0 ? "\ncheck-live-presets: all passed" : `\ncheck-live-presets: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
