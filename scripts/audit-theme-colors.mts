// Reports every colour literal still unthemed in in-scope files, grouped by
// kind, so the theme sweep can be finished by evidence rather than by eye.
//
//   npx tsx scripts/audit-theme-colors.mts [--context]
//
// Unlike the codemod's original line-based scan, this walks each file as a
// character stream and tracks template literals ACROSS lines — that's how
// `linear-gradient(\n  …\n), #18181b` in EffectNode.tsx slipped the first
// pass and left the Layer IO nodes dark in light mode.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { EXCLUDED, inScopeFiles } from "./theme-scope.mts";

const SHOW_CONTEXT = process.argv.includes("--context");

interface Hit {
  file: string;
  line: number;
  text: string;
  value: string;
  kind: "hex" | "rgba";
}

/**
 * Spans of `src` that are inside a string or template literal, skipping
 * comments. Returns a predicate over absolute offsets.
 */
function stringMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = ++i;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        // Template literals end at the backtick, not at a newline; plain
        // quotes can't span lines, so bail to avoid runaway masking on an
        // apostrophe inside JSX text.
        if (quote !== "`" && src[i] === "\n") break;
        i++;
      }
      for (let j = start; j < i && j < src.length; j++) mask[j] = 1;
      i++;
      continue;
    }
    i++;
  }
  return mask;
}

const files = inScopeFiles();
const hits: Hit[] = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const mask = stringMask(src);
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (off: number): number => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const push = (m: RegExpExecArray, kind: Hit["kind"]) => {
    if (!mask[m.index]) return;
    const ln = lineOf(m.index);
    const text = src.slice(lineStarts[ln], lineStarts[ln + 1] ?? src.length).trim();
    hits.push({ file, line: ln + 1, text, value: m[0], kind });
  };

  for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g))
    push(m as RegExpExecArray, "hex");
  for (const m of src.matchAll(/rgba?\(\s*[\d.]+[^)]*\)/g))
    push(m as RegExpExecArray, "rgba");
}

const byValue = new Map<string, Hit[]>();
for (const h of hits) {
  const key = `${h.kind}:${h.value.toLowerCase().replace(/\s+/g, "")}`;
  if (!byValue.has(key)) byValue.set(key, []);
  byValue.get(key)!.push(h);
}

console.log(`in-scope files: ${files.length}   (excluded: ${EXCLUDED.length})`);
console.log(`unthemed colour literals: ${hits.length}\n`);

const sorted = [...byValue].sort((a, b) => b[1].length - a[1].length);
for (const [key, list] of sorted) {
  console.log(`${key.padEnd(46)} ×${list.length}`);
  if (SHOW_CONTEXT) {
    for (const h of list.slice(0, 6))
      console.log(`      ${h.file}:${h.line}  ${h.text.slice(0, 96)}`);
    if (list.length > 6) console.log(`      … ${list.length - 6} more`);
  }
}
