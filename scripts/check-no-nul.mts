// check-no-nul: fails when any tracked source file contains a literal
// NUL (0x00) byte. A raw NUL makes grep/git treat the file as binary and
// silently return nothing — which has now bitten twice (TrackEditor's
// selKey separator, 070326 review; then EffectsApp's media-load key).
// Key separators must use the backslash-u0000 ESCAPE, never the raw byte.
//
//   npx tsx scripts/check-no-nul.mts

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Text sources only — binary assets (images, wasm, fonts) legitimately
// contain NULs.
const TEXT_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|scss|md|html|svg|yml|yaml|sql|txt|glsl|wgsl)$/i;

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && TEXT_EXT.test(f));

const offenders: string[] = [];
for (const file of files) {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // deleted-but-staged etc.
  }
  const at = buf.indexOf(0);
  if (at >= 0) {
    const line = buf.subarray(0, at).toString("utf8").split("\n").length;
    offenders.push(`${file}:${line}`);
  }
}

if (offenders.length > 0) {
  console.error("Literal NUL byte(s) found — use the \\u0000 escape instead:");
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`  ok  no NUL bytes in ${files.length} tracked text files`);
