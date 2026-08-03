// Codemod: inline colour literals → theme custom properties.
// Spec: 080226_theme-modes.md. Kept in-tree because it documents exactly what
// was rewritten, and re-running it is the sane way to sweep up new hardcoded
// colours later. Idempotent — a clean run reports 0 replacements.
//
//   npx tsx scripts/codemod-theme-tokens.mts            # dry run + report
//   npx tsx scripts/codemod-theme-tokens.mts --apply    # write
//
// WHAT IT REWRITES
//
//  - Hexes named in NEUTRAL_ALIASES / ACCENTS / TINTS → their token.
//  - Unnamed greys → nearest ramp step by OKLCH lightness (see foldNeutral).
//  - White/black translucent washes → color-mix over --tb-lift / --tb-sink.
//  - Near-black translucent SURFACES (alpha ≥ 0.8) → color-mix over --tb-n-0.
//  - Translucent accent fills → color-mix over that accent's token.
//
// WHAT IT DELIBERATELY WON'T TOUCH
//
//  - Canvas 2D colours (fillStyle / strokeStyle / shadowColor). `var()` is a
//    CSS construct; the 2D context resolves none of it and would paint black.
//  - Shadows, and low-alpha black scrims (< 0.8). Both should stay dark in
//    light mode — a white modal scrim reads as a bug.
//  - Pure #ffffff / #000000 — mixed roles (param defaults, colour-picker
//    gradient stops). Their real chrome uses were converted by hand.
//  - Saturated identity colour (macOS traffic lights, record red, status
//    dots) — outside the tint window, so it keeps its value in both modes.
//  - Gizmos and canvas overlays, socket colours, live-viewer, export
//    template, engine, nodes. See theme-scope.mts.
//  - Anything marked `theme-ignore` in a nearby comment — the escape hatch
//    for colour that is DATA (persisted into a project, handed to the
//    engine, painted into a canvas) rather than presentation.
//
// SVG presentation attributes ARE rewritten: they parse as CSS declarations,
// so var() substitutes normally there (verified in Chromium, our Electron
// target).

import { readFileSync, writeFileSync } from "node:fs";
import {
  ACCENT_ALIASES,
  NEUTRAL_RAMP,
  accentVar,
  neutralVar,
  tokenForHex,
} from "@/components/effects/theme/tokens";
import { hexToOklch } from "@/components/effects/theme/oklch";
import { inScopeFiles } from "./theme-scope.mts";
import { lineTextAt, stringMask } from "./theme-lex.mts";

const APPLY = process.argv.includes("--apply");

/**
 * Greys the ramp doesn't name explicitly (#222225, #0e0e10, #8b8b94 — the
 * long tail of near-duplicates) fold onto their nearest step by perceptual
 * lightness. Hand-listing every one would be busywork, and missing one is
 * worse than folding it: an unthemed #222225 panel stays a black box.
 *
 * Gated so it can only catch greys. Chroma alone isn't enough — a pale
 * `#f0f9ff` banner wash (C 0.0125) scores LOWER than the honest grey
 * `#8b8b94` (C 0.0133), and folding a pale-blue background onto the ink end
 * of the ramp would turn it near-black. Channel spread separates them: the
 * tints run 13–19 apart, the greys ≤ 12.
 */
const NEUTRAL_CHROMA_MAX = 0.02;
const NEUTRAL_SPREAD_MAX = 12;

const rampLightness = NEUTRAL_RAMP.map((p) => hexToOklch(p.dark).l);

function foldNeutral(hex: string): string | null {
  if (hex.length !== 7) return null;
  if (hex === "#ffffff" || hex === "#000000") return null;

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_SPREAD_MAX) return null;

  const { l, c } = hexToOklch(hex);
  if (c > NEUTRAL_CHROMA_MAX) return null;

  let best = 0;
  for (let i = 1; i < rampLightness.length; i++) {
    if (Math.abs(rampLightness[i] - l) < Math.abs(rampLightness[best] - l)) best = i;
  }
  return neutralVar(best);
}

/** Canvas colour and gradient stops can't take var(); skip those lines. */
const SKIP_LINE =
  /(fillStyle|strokeStyle|shadowColor)\s*=|data:image\/svg\+xml|createLinearGradient|addColorStop/;

/** A shadow stays dark in light mode, so its rgba is left alone. */
const SHADOW_LINE = /(boxShadow|textShadow|filter|drop-shadow|Shadow\s*:)/;

/**
 * Opt-out marker. Put `theme-ignore` in a comment on the line, or within the
 * few lines above it, and the colour is left alone forever.
 *
 * This exists because the codemod cannot tell presentation from DATA. A
 * colour that gets PERSISTED into a project file, handed to the engine, or
 * painted into a canvas has to stay a literal — `var()` resolves nowhere in
 * any of those. Without the marker, a later run would silently re-break the
 * hand-reverted sites.
 */
const IGNORE_MARKER = /theme-ignore/;
const IGNORE_LOOKBACK = 5;

function ignored(src: string, offset: number): boolean {
  const lineStart = src.lastIndexOf("\n", offset) + 1;
  const lineEnd = src.indexOf("\n", offset);
  if (IGNORE_MARKER.test(src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd)))
    return true;
  let start = lineStart;
  for (let i = 0; i < IGNORE_LOOKBACK && start > 0; i++) {
    const prevStart = src.lastIndexOf("\n", start - 2) + 1;
    if (IGNORE_MARKER.test(src.slice(prevStart, start))) return true;
    start = prevStart;
  }
  return false;
}

const pct = (a: number): string => {
  const v = a * 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
};

const mix = (token: string, alpha: number): string =>
  `color-mix(in srgb, var(${token}) ${pct(alpha)}, transparent)`;

const toHex = (r: number, g: number, b: number): string =>
  "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/**
 * A translucent colour → a color-mix over the right token, or null to leave
 * it exactly as it is.
 */
function rewriteRgba(
  r: number,
  g: number,
  b: number,
  a: number,
  line: string
): string | null {
  if (a >= 1) return null; // opaque rgb() — rare, and the hex path covers it.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const isShadow = SHADOW_LINE.test(line);

  // A white wash means "lighten what's behind me", which has to invert on a
  // light surface. Always safe to convert; never a shadow.
  if (min >= 240) return mix("--tb-lift", a);

  // Black. As a shadow or a modal scrim it must STAY dark — only convert when
  // it's opaque enough to be a surface in its own right.
  if (max <= 24) {
    if (isShadow || a < 0.8) return null;
    return mix("--tb-n-0", a);
  }

  // A translucent accent fill (selection tint, error wash) — ride the
  // accent's own token so it flips with everything else.
  const accent = ACCENT_ALIASES[toHex(r, g, b)];
  if (accent && !isShadow) return mix(accentVar(accent), a);

  return null;
}

let filesChanged = 0;
let hexReplacements = 0;
let rgbaReplacements = 0;
const unmapped = new Map<string, number>();
const folded = new Map<string, number>();

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (const file of inScopeFiles()) {
  const src = readFileSync(file, "utf8");
  if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(src)) continue;

  const mask = stringMask(src);
  const edits: { start: number; end: number; text: string }[] = [];

  for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const at = m.index!;
    if (!mask[at]) continue;
    const line = lineTextAt(src, at);
    if (SKIP_LINE.test(line)) continue;
    if (ignored(src, at)) continue;

    const raw = m[0];
    const h = raw.toLowerCase();
    const norm =
      h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
    if (norm.length !== 7) continue; // 4/8-digit alpha forms: leave alone.

    let token = tokenForHex(raw);
    if (!token) {
      token = foldNeutral(norm);
      if (token) bump(folded, `${norm} → ${token}`);
    }
    if (!token) {
      bump(unmapped, norm);
      continue;
    }
    edits.push({ start: at, end: at + raw.length, text: `var(${token})` });
    hexReplacements++;
  }

  for (const m of src.matchAll(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g
  )) {
    const at = m.index!;
    if (!mask[at]) continue;
    const line = lineTextAt(src, at);
    if (SKIP_LINE.test(line)) continue;
    if (ignored(src, at)) continue;

    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const a = m[4] === undefined ? 1 : Number(m[4]);
    const out = rewriteRgba(r, g, b, a, line);
    if (!out) continue;
    edits.push({ start: at, end: at + m[0].length, text: out });
    rgbaReplacements++;
  }

  if (!edits.length) continue;
  edits.sort((x, y) => x.start - y.start);
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += src.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += src.slice(cursor);

  filesChanged++;
  if (APPLY) writeFileSync(file, out);
}

console.log(APPLY ? "APPLIED" : "DRY RUN");
console.log(`  files changed:      ${filesChanged}`);
console.log(`  hex → token:        ${hexReplacements}`);
console.log(`  rgba → color-mix:   ${rgbaReplacements}`);

if (folded.size) {
  console.log(`\n  Auto-folded near-neutrals:`);
  for (const [k, n] of [...folded].sort((a, b) => b[1] - a[1]))
    console.log(`    ${k}  ×${n}`);
}
if (unmapped.size) {
  console.log(`\n  Left as-is (identity colour, or needs a human):`);
  for (const [hex, n] of [...unmapped].sort((a, b) => b[1] - a[1]))
    console.log(`    ${hex}  ×${n}`);
}
