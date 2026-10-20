// Path rules the main process enforces before it writes a file the renderer
// named, or hands a path to After Effects (spec 091926_after-effects-handoff.md
// §8). Pure CommonJS with no Electron imports, so the offline gate
// (scripts/ae-export/check-package-paths.mts) tests exactly what main runs.
//
// Two separate questions:
//   - vetRelativePath: may the renderer write `rel` inside a folder main
//     controls? Relative, forward slashes, no `..`, no absolute or drive
//     paths, no quotes, no control characters, no hidden segments.
//   - aerenderSafe: may this absolute path reach aerender's command line?
//     aerender pastes its arguments into JavaScript UNESCAPED (spec §13): a
//     `"` hangs its render core, a backslash or a line terminator breaks the
//     string. A `'` measured fine (2026-10-20). Only main-built paths that
//     pass this ever reach aerender.
"use strict";

const path = require("path");

const MAX_SEGMENT = 128;
const MAX_RELATIVE = 512;
// Quotes, Windows-reserved characters, backslash and every control
// character (C0, DEL, C1) plus the JS line terminators U+2028 / U+2029.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /["'`\\:*?<>|\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const AERENDER_BAD = /["\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// → { ok: true, segments } | { ok: false, reason }.
function vetRelativePath(rel) {
  if (typeof rel !== "string") return { ok: false, reason: "path must be a string" };
  if (!rel) return { ok: false, reason: "path is empty" };
  if (rel.length > MAX_RELATIVE) return { ok: false, reason: `path is longer than ${MAX_RELATIVE} characters` };
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return { ok: false, reason: `"${rel}" is absolute` };
  if (BAD_CHARS.test(rel)) return { ok: false, reason: `"${rel}" contains a quote, backslash, reserved or control character` };
  const segments = rel.split("/");
  for (const s of segments) {
    if (!s) return { ok: false, reason: `"${rel}" has an empty segment` };
    if (s === "." || s === "..") return { ok: false, reason: `"${rel}" leaves its folder` };
    if (s.startsWith(".")) return { ok: false, reason: `"${rel}" names a hidden file` };
    if (s.startsWith("~")) return { ok: false, reason: `"${rel}" starts a segment with ~` };
    if (s.endsWith(" ") || s.endsWith(".")) return { ok: false, reason: `"${rel}" has a segment ending in a space or dot` };
    if (s.length > MAX_SEGMENT) return { ok: false, reason: `"${rel}" has a segment longer than ${MAX_SEGMENT}` };
  }
  return { ok: true, segments };
}

// `root/rel` after vetRelativePath, re-checked to sit strictly inside root.
// Throws with the reason; never returns a path outside root.
function resolveInside(root, rel) {
  const v = vetRelativePath(rel);
  if (!v.ok) throw new Error(`refused: ${v.reason}`);
  const abs = path.resolve(root, ...v.segments);
  const back = path.relative(path.resolve(root), abs);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) throw new Error(`refused: "${rel}" resolves outside its folder`);
  return abs;
}

// → { ok: true } | { ok: false, reason }.
function aerenderSafe(abs) {
  if (typeof abs !== "string" || !abs) return { ok: false, reason: "no path" };
  if (!path.isAbsolute(abs)) return { ok: false, reason: `"${abs}" is not absolute` };
  if (AERENDER_BAD.test(abs))
    return {
      ok: false,
      reason: `"${abs}" contains a double quote, backslash or control character, which After Effects' command-line renderer cannot take — move the package to a plain folder`,
    };
  return { ok: true };
}

// A package / file base name main can create: the user's export name with
// path and quoting characters replaced, never empty, never hidden.
function sanitizeBaseName(raw, fallback = "toolbox-export") {
  let s = String(raw == null ? "" : raw)
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"'`\\:*?<>|/]/g, "_") // eslint-disable-line no-control-regex
    .trim()
    .replace(/\.aepkg$/i, "")
    .trim()
    .replace(/^[.~\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback;
}

module.exports = { vetRelativePath, resolveInside, aerenderSafe, sanitizeBaseName, MAX_SEGMENT, MAX_RELATIVE };
