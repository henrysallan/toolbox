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
  PANEL_WIDTH_RANGE,
  ROW_GAP_RANGE,
  SLIDER_PRESETS,
  TRANSPORT_PRESETS,
  UI_SCALE_RANGE,
  designTokens,
  fromSavedLiveDesign,
  panelWidthToPct,
  pctToPanelWidth,
  pctToUiScale,
  uiScaleToPct,
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

// --- layout / theme sliders (2026-09-16) ------------------------------------
// panelWidth, uiScale and textBrightness: a pre-slider blob must read as
// today's look (default BEFORE clamping — the range floor is not "absent"),
// out-of-range values clamp, non-numbers default, and the designer's 0–100 %
// calibration puts the defaults where the owner framed them: panel width
// 25 %, UI scale 50 %.

const legacy = fromSavedLiveDesign({
  layout: { canvas: "inset" },
  theme: { mode: "dark" },
});
check(
  "legacy blob: panelWidth 280 / uiScale 1 / rowGap 10 / textBrightness 1",
  legacy.layout.panelWidth === 280 &&
    legacy.layout.uiScale === 1 &&
    legacy.layout.rowGap === 10 &&
    legacy.theme.textBrightness === 1,
  JSON.stringify([
    legacy.layout.panelWidth,
    legacy.layout.uiScale,
    legacy.layout.rowGap,
    legacy.theme.textBrightness,
  ])
);
const wild = fromSavedLiveDesign({
  layout: { panelWidth: 5000, uiScale: 0.01, rowGap: -7 },
  theme: { textBrightness: -3 },
});
check(
  "out-of-range slider values clamp to their bounds",
  wild.layout.panelWidth === PANEL_WIDTH_RANGE.max &&
    wild.layout.uiScale === UI_SCALE_RANGE.min &&
    wild.layout.rowGap === ROW_GAP_RANGE.min &&
    wild.theme.textBrightness === 0,
  JSON.stringify([
    wild.layout.panelWidth,
    wild.layout.uiScale,
    wild.layout.rowGap,
    wild.theme.textBrightness,
  ])
);
const junk = fromSavedLiveDesign({
  layout: { panelWidth: "wide", uiScale: null, rowGap: "roomy" },
  theme: { textBrightness: "x" },
});
check(
  "non-numeric slider values read as the defaults, not the floor",
  junk.layout.panelWidth === 280 &&
    junk.layout.uiScale === 1 &&
    junk.layout.rowGap === 10 &&
    junk.theme.textBrightness === 1,
  JSON.stringify([
    junk.layout.panelWidth,
    junk.layout.uiScale,
    junk.layout.rowGap,
    junk.theme.textBrightness,
  ])
);
check(
  "rowGap rounds to whole px and caps at the range max",
  fromSavedLiveDesign({ layout: { rowGap: 12.6 } }).layout.rowGap === 13 &&
    fromSavedLiveDesign({ layout: { rowGap: 400 } }).layout.rowGap ===
      ROW_GAP_RANGE.max
);
check(
  "fromSavedLiveDesign rounds panelWidth to whole px",
  fromSavedLiveDesign({ layout: { panelWidth: 300.4 } }).layout.panelWidth === 300
);

// Pan / zoom control (091826_live-pan-zoom.md): a boolean layout flag, off
// unless the blob says exactly `true` — a pre-flag design keeps its fixed
// framing and the panel shows no button.
check(
  "panZoom: absent → off, true → on, junk → off",
  fromSavedLiveDesign({}).layout.panZoom === false &&
    fromSavedLiveDesign({ layout: { panZoom: true } }).layout.panZoom === true &&
    fromSavedLiveDesign({ layout: { panZoom: "yes" } }).layout.panZoom === false &&
    fromSavedLiveDesign({ layout: { panZoom: 1 } }).layout.panZoom === false
);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
check(
  "designer calibration: 280 px ↔ 25 %, 1× ↔ 50 %, ½× ↔ 0 %, 2× ↔ 100 %",
  near(panelWidthToPct(280), 25) &&
    near(uiScaleToPct(1), 50) &&
    near(uiScaleToPct(0.5), 0) &&
    near(uiScaleToPct(2), 100),
  JSON.stringify([
    panelWidthToPct(280),
    uiScaleToPct(1),
    uiScaleToPct(0.5),
    uiScaleToPct(2),
  ])
);
check(
  "calibration round-trips every integer percent",
  Array.from({ length: 101 }, (_, p) => p).every(
    (p) =>
      Math.round(panelWidthToPct(pctToPanelWidth(p))) === p &&
      Math.round(uiScaleToPct(pctToUiScale(p))) === p
  )
);
check(
  "pct → value lands inside the validated ranges at both ends",
  pctToPanelWidth(0) === PANEL_WIDTH_RANGE.min &&
    pctToPanelWidth(100) === PANEL_WIDTH_RANGE.max &&
    pctToUiScale(0) === UI_SCALE_RANGE.min &&
    pctToUiScale(100) === UI_SCALE_RANGE.max,
  JSON.stringify([
    pctToPanelWidth(0),
    pctToPanelWidth(100),
    pctToUiScale(0),
    pctToUiScale(100),
  ])
);

// Text brightness only ever touches ink: --text* and the neutral ramp's
// ink steps move toward the panel surface (down in dark mode, up in
// light), while surfaces, borders, the accent and the whole sheet at 100 %
// stay byte-identical.
const lum = (hex: string) =>
  parseInt(hex.slice(1, 3), 16) +
  parseInt(hex.slice(3, 5), 16) +
  parseInt(hex.slice(5, 7), 16);
for (const mode of ["dark", "light"] as const) {
  const full = designTokens(fromSavedLiveDesign({ theme: { mode } }));
  const same = designTokens(
    fromSavedLiveDesign({ theme: { mode, textBrightness: 1 } })
  );
  const half = designTokens(
    fromSavedLiveDesign({ theme: { mode, textBrightness: 0.5 } })
  );
  check(
    `${mode}: textBrightness 1 leaves the token sheet byte-identical`,
    JSON.stringify(full) === JSON.stringify(same)
  );
  const towardSurface = (name: string) =>
    mode === "dark"
      ? lum(half[name]) < lum(full[name])
      : lum(half[name]) > lum(full[name]);
  check(
    `${mode}: textBrightness 0.5 fades --text* and the ink ramp toward the panel`,
    towardSurface("--text") &&
      towardSurface("--text-dim") &&
      towardSurface("--text-faint") &&
      towardSurface("--tb-n-16") &&
      towardSurface("--tb-n-13") &&
      towardSurface("--tb-n-10"),
    JSON.stringify({ text: [full["--text"], half["--text"]] })
  );
  check(
    `${mode}: textBrightness 0.5 leaves surfaces, borders and the accent alone`,
    half["--bg"] === full["--bg"] &&
      half["--bg-2"] === full["--bg-2"] &&
      half["--border"] === full["--border"] &&
      half["--tb-n-3"] === full["--tb-n-3"] &&
      half["--tb-n-9"] === full["--tb-n-9"] &&
      half["--accent"] === full["--accent"] &&
      half["--panel-bg"] === full["--panel-bg"]
  );
}

console.log(failures === 0 ? "\ncheck-live-presets: all passed" : `\ncheck-live-presets: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
