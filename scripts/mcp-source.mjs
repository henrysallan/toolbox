// Source-reading tools for the Toolbox MCP server (spec
// 071226_mcp-node-source-tools.md). Read-only access to the node defs + the
// engine helpers they delegate to, so Claude can dive into how a node actually
// works and ground "how do I build this?" answers in real behavior.
//
// These do NOT touch the editor bridge: the server runs from the repo checkout,
// so source sits on disk next to it (node:fs). GitHub raw — pinned to the
// paired editor's version tag — is the version-skew fallback only (a hosted /
// packaged app drifted from the local checkout). Local checkout is the primary
// path; unpaired or same-version ⇒ local, no note.

import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// The readable scope: node defs + the engine helpers they call. This is exactly
// the subtree exported apps ship verbatim (engine self-containment invariant),
// so it holds no secrets by construction. Widening is a one-line change.
const SCOPE_DIRS = ["src/nodes", "src/engine"];

const GITHUB_RAW = "https://raw.githubusercontent.com/henrysallan/toolbox";

// A def header is `type: "x",` immediately followed by `name:` — which skips
// the `type:` noise in param/input/output declarations and handles multi-def
// files (three/primitives.ts registers six).
const DEF_HEADER = /type:\s*"([a-z0-9_-]+)",\s*\n\s*name:/g;
// Hidden legacy aliases live in index.ts: registerNode({ ...fooNode, type: "old", hidden: true }).
const ALIAS_RE = /registerNode\(\{\s*\.\.\.(\w+),\s*type:\s*"([a-z0-9_-]+)"/g;
// index.ts imports that tell us which file each def variable comes from.
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.\/[^"]+)"/g;
// A node file's engine dependencies — the real math usually lives here.
const ENGINE_IMPORT_RE = /from\s+"(@\/engine\/[^"]+)"/g;

const MAX_UNRANGED_LINES = 1500;
const SEARCH_MATCH_CAP = 200;
const MATCH_LINE_MAX = 240;
const SEARCH_EXTS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs",
  ".glsl", ".frag", ".vert", ".wgsl",
]);

function toPosixRel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

// Line-number a block cat -n style: `<n>\t<text>`, right-aligned to the widest
// number so the columns line up. firstLineNo is the real 1-based line number of
// lines[0].
function numberLines(lines, firstLineNo) {
  const width = String(firstLineNo + lines.length - 1).length;
  return lines
    .map((l, i) => `${String(firstLineNo + i).padStart(width)}\t${l}`)
    .join("\n");
}

function engineImports(text) {
  const out = new Set();
  let m;
  ENGINE_IMPORT_RE.lastIndex = 0;
  while ((m = ENGINE_IMPORT_RE.exec(text))) out.add(m[1]);
  return [...out];
}

// Cheap "did you mean" — substring overlap or a shared prefix. Enough to catch
// a hyphen/typo without a full edit-distance pass.
function nearMisses(query, types) {
  const q = query.toLowerCase();
  const scored = [];
  for (const t of types) {
    const lt = t.toLowerCase();
    if (lt === q) continue;
    let score = 0;
    if (lt.includes(q) || q.includes(lt)) score = 3;
    else if (lt.slice(0, 3) === q.slice(0, 3)) score = 2;
    else if (lt[0] === q[0]) score = 1;
    if (score) scored.push([score, t]);
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
    .slice(0, 5)
    .map(([, t]) => t);
}

function globToRe(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(esc.replace(/\*/g, ".*").replace(/\?/g, "."));
}

export function createSourceReader() {
  let localVersion = "unknown";
  try {
    localVersion = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    ).version;
  } catch {
    // leave "unknown" — skew detection just no-ops (always reads local)
  }

  let indexCache = null; // Map<type, relPath>, built once per boot from the local tree
  const fetchCache = new Map(); // `${ref}:${rel}` → text | null(miss)

  async function walkTs(dirRel, exts) {
    const out = [];
    let entries;
    try {
      entries = await readdir(path.join(REPO_ROOT, dirRel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ent of entries) {
      const childRel = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) out.push(...(await walkTs(childRel, exts)));
      else if (exts.has(path.extname(ent.name))) out.push(childRel);
    }
    return out;
  }

  async function typeIndex() {
    if (indexCache) return indexCache;
    const index = new Map();
    const files = await walkTs("src/nodes", new Set([".ts", ".tsx"]));
    const importMap = new Map(); // def var → relPath (for alias resolution)
    let indexTsSrc = "";
    for (const rel of files) {
      let src;
      try {
        src = await readFile(path.join(REPO_ROOT, rel), "utf8");
      } catch {
        continue;
      }
      if (rel === "src/nodes/index.ts") {
        indexTsSrc = src;
        continue; // index.ts registers, it doesn't define
      }
      DEF_HEADER.lastIndex = 0;
      let m;
      while ((m = DEF_HEADER.exec(src))) {
        if (!index.has(m[1])) index.set(m[1], rel);
      }
    }
    // Resolve hidden aliases: map imported def var → file, then alias → that file.
    if (indexTsSrc) {
      let im;
      IMPORT_RE.lastIndex = 0;
      while ((im = IMPORT_RE.exec(indexTsSrc))) {
        const names = im[1]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim())
          .filter(Boolean);
        const rel = `src/nodes/${im[2].replace(/^\.\//, "")}.ts`;
        for (const n of names) importMap.set(n, rel);
      }
      let am;
      ALIAS_RE.lastIndex = 0;
      while ((am = ALIAS_RE.exec(indexTsSrc))) {
        const rel = importMap.get(am[1]);
        if (rel && !index.has(am[2])) index.set(am[2], rel);
      }
    }
    indexCache = index;
    return index;
  }

  // Last-ditch resolve for a def whose header the regex didn't catch: find a
  // scope file that contains the quoted type literal.
  async function grepType(type) {
    const needle = `"${type}"`;
    const files = await walkTs("src/nodes", new Set([".ts", ".tsx"]));
    for (const rel of files) {
      try {
        if ((await readFile(path.join(REPO_ROOT, rel), "utf8")).includes(needle)) {
          return rel;
        }
      } catch {
        // skip unreadable
      }
    }
    return null;
  }

  function skewRef(appVersion) {
    if (!appVersion || !/^\d+\.\d+\.\d+/.test(appVersion)) return null;
    if (appVersion === localVersion) return null;
    return appVersion;
  }

  const fetchedNote = (ref) =>
    `Paired editor is v${ref}; showing source from the v${ref} GitHub tag ` +
    `(your local checkout is v${localVersion}).`;
  const localFallbackNote = (ref) =>
    `Paired editor is v${ref} but the v${ref} tag couldn't be fetched ` +
    `(offline, or the path changed at that tag) — showing your LOCAL ` +
    `checkout (v${localVersion}), which may differ.`;
  const searchSkewNote = (ref) =>
    `Search runs on your LOCAL checkout (v${localVersion}); paired editor is ` +
    `v${ref}, so matches may not reflect the running version.`;

  function safeResolve(input) {
    const cleaned = String(input ?? "").replace(/^\.\//, "").replace(/^\/+/, "");
    const abs = path.resolve(REPO_ROOT, cleaned);
    const rel = toPosixRel(abs);
    const inScope = SCOPE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
    if (!inScope || rel.startsWith("..")) return null;
    return { abs, rel };
  }

  // Read a scope file, GitHub-at-tag first when skewed, local otherwise.
  async function loadFile(rel, ref) {
    if (ref) {
      const key = `${ref}:${rel}`;
      if (fetchCache.has(key)) {
        const cached = fetchCache.get(key);
        if (cached != null) return { text: cached, versionNote: fetchedNote(ref) };
      } else {
        try {
          const res = await fetch(`${GITHUB_RAW}/v${ref}/${rel}`);
          if (res.ok) {
            const t = await res.text();
            fetchCache.set(key, t);
            return { text: t, versionNote: fetchedNote(ref) };
          }
          fetchCache.set(key, null); // remember the 404 so we don't refetch
        } catch {
          fetchCache.set(key, null);
        }
      }
      const t = await readFile(path.join(REPO_ROOT, rel), "utf8");
      return { text: t, versionNote: localFallbackNote(ref) };
    }
    const t = await readFile(path.join(REPO_ROOT, rel), "utf8");
    return { text: t, versionNote: null };
  }

  function render(rel, text, extraHeaderLines, versionNote, start, end) {
    const lines = text.split("\n");
    const total = lines.length;
    const hasRange = Number.isFinite(start) || Number.isFinite(end);
    let s = Number.isFinite(start) ? Math.max(1, Math.floor(start)) : 1;
    let e = Number.isFinite(end) ? Math.min(total, Math.floor(end)) : total;
    const notes = [];
    if (versionNote) notes.push(versionNote);
    if (!hasRange && total > MAX_UNRANGED_LINES) {
      e = MAX_UNRANGED_LINES;
      notes.push(
        `File is ${total} lines; showing 1–${e}. Call read_source with ` +
          `start/end for the rest.`
      );
    }
    if (s > total) {
      return `// ${rel}  (${total} lines)\n// start ${s} is past the end of the file.`;
    }
    const header = [`// ${rel}  (${total} lines)`, ...extraHeaderLines, ...notes.map((n) => `// ${n}`)];
    return [...header, "", numberLines(lines.slice(s - 1, e), s)].join("\n");
  }

  return {
    scope: SCOPE_DIRS,
    localVersion,

    async getNodeSource({ type, appVersion } = {}) {
      if (!type) return { error: "get_node_source needs a `type` (a catalog node type string)." };
      const index = await typeIndex();
      let rel = index.get(type) ?? (await grepType(type));
      if (!rel) {
        const near = nearMisses(type, [...index.keys()]);
        return {
          error:
            `Unknown node type "${type}". ` +
            (near.length
              ? `Did you mean: ${near.join(", ")}? `
              : "") +
            "Call get_catalog for the full list.",
        };
      }
      const ref = skewRef(appVersion);
      const { text, versionNote } = await loadFile(rel, ref);
      const imports = engineImports(text);
      const extra = [`// type "${type}"`];
      if (imports.length) {
        extra.push(
          `// engine imports: ${imports.join(", ")}`,
          `//   → read_source these for the underlying helpers.`
        );
      }
      return { text: render(rel, text, extra, versionNote) };
    },

    async readSource({ path: inPath, start, end, appVersion } = {}) {
      const resolved = safeResolve(inPath);
      if (!resolved) {
        return {
          error:
            `Path "${inPath}" is outside the readable scope. Allowed: ` +
            `${SCOPE_DIRS.join(", ")} (e.g. src/engine/coerce.ts).`,
        };
      }
      const ref = skewRef(appVersion);
      let loaded;
      try {
        loaded = await loadFile(resolved.rel, ref);
      } catch {
        return { error: `Could not read "${resolved.rel}" — no such file in the scope.` };
      }
      return { text: render(resolved.rel, loaded.text, [], loaded.versionNote, start, end) };
    },

    async searchSource({ pattern, glob, appVersion } = {}) {
      if (!pattern) return { error: "search_source needs a `pattern` (a JavaScript regex source)." };
      let re;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        return { error: `Invalid regex "${pattern}": ${err instanceof Error ? err.message : String(err)}` };
      }
      const globRe = glob ? globToRe(glob) : null;
      const ref = skewRef(appVersion); // local-only search; ref just flags the note
      const files = [];
      for (const dir of SCOPE_DIRS) files.push(...(await walkTs(dir, SEARCH_EXTS)));
      files.sort();
      const hits = [];
      let truncated = false;
      for (const rel of files) {
        if (globRe && !globRe.test(rel)) continue;
        let src;
        try {
          src = await readFile(path.join(REPO_ROOT, rel), "utf8");
        } catch {
          continue;
        }
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          let text = lines[i].trim();
          if (text.length > MATCH_LINE_MAX) text = `${text.slice(0, MATCH_LINE_MAX)}…`;
          hits.push(`${rel}:${i + 1}: ${text}`);
          if (hits.length >= SEARCH_MATCH_CAP) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      const head = [];
      if (ref) head.push(`// ${searchSkewNote(ref)}`);
      if (!hits.length) {
        return { text: [...head, `No matches for /${pattern}/${glob ? ` in ${glob}` : ""}.`].join("\n") };
      }
      head.push(
        `// ${hits.length}${truncated ? "+" : ""} match${hits.length === 1 ? "" : "es"} for /${pattern}/` +
          `${glob ? ` in ${glob}` : ""}${truncated ? ` (capped at ${SEARCH_MATCH_CAP})` : ""}`
      );
      return { text: [...head, "", ...hits].join("\n") };
    },
  };
}
