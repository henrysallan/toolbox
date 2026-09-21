// Source-reading tools for the Toolbox MCP server (spec
// 071226_mcp-node-source-tools.md). Read-only access to the node defs + the
// engine helpers they delegate to, so Claude can dive into how a node actually
// works and ground "how do I build this?" answers in real behavior.
//
// These do NOT touch the editor bridge: the server runs from the repo checkout,
// so source sits on disk next to it (node:fs). When the paired editor runs a
// DIFFERENT released version than this checkout, every tool — get_node_source,
// read_source AND search_source — reads the source tree at that version's tag
// instead: `git archive v<ref>` from the local object store first (offline,
// ~50 ms), the GitHub release tarball as the fallback (one ~6 MB download per
// version, cached for the life of the process). Only when neither is
// reachable does a tool fall back to the local checkout, and then it says so.
// Unpaired or same-version ⇒ local, no note.

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileP = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// The readable scope: node defs + the engine helpers they call. This is exactly
// the subtree exported apps ship verbatim (engine self-containment invariant),
// so it holds no secrets by construction. Widening is a one-line change.
const SCOPE_DIRS = ["src/nodes", "src/engine"];

const GITHUB_RAW = "https://raw.githubusercontent.com/henrysallan/toolbox";
const GITHUB_TARBALL = "https://codeload.github.com/henrysallan/toolbox/tar.gz/refs/tags";
const TARBALL_TIMEOUT_MS = 30_000;
const GIT_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

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
const INDEX_EXTS = new Set([".ts", ".tsx"]);

function toPosixRel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

function inScope(rel) {
  return SCOPE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
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

// ---------------------------------------------------------------------------
// Tar reading. Both `git archive` and GitHub's codeload tarballs are POSIX
// ustar with pax extended headers for long paths (git also emits one pax
// GLOBAL header carrying the commit id). We only need regular files inside
// the scope, decoded as UTF-8.
// ---------------------------------------------------------------------------

function tarString(buf, start, len) {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + len ? start + len : end;
  return buf.toString("utf8", start, stop);
}

function tarOctal(buf, start, len) {
  const s = tarString(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

// pax extended header body: `<len> <key>=<value>\n` records.
function paxPath(body) {
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(" ", i);
    if (sp === -1) break;
    const len = Number(body.slice(i, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = body.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq !== -1 && rec.slice(0, eq) === "path") return rec.slice(eq + 1);
    i += len;
  }
  return null;
}

// Parse a tar buffer into Map<path, text>, keeping only entries `keep(path)`
// accepts. `strip` drops that many leading path segments (GitHub tarballs
// wrap everything in `<repo>-<ref>/`).
/**
 * @param {Buffer} buf
 * @param {{ keep?: (rel: string) => boolean, strip?: number }} [opts]
 * @returns {Map<string, string>}
 */
export function readTar(buf, { keep = () => true, strip = 0 } = {}) {
  const files = new Map();
  let off = 0;
  let pendingPath = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header[0] === 0) break; // end-of-archive zero blocks
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const magic = tarString(header, 257, 6);
    let name = tarString(header, 0, 100);
    if (magic.startsWith("ustar")) {
      const prefix = tarString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pendingPath = paxPath(buf.toString("utf8", dataStart, dataEnd));
      continue;
    }
    if (type === "L") {
      pendingPath = tarString(buf, dataStart, size);
      continue;
    }
    if (type === "g") continue; // pax global header (git archive's commit id)
    const full = pendingPath ?? name;
    pendingPath = null;
    if (type !== "0" && type !== "\0") continue; // dirs, links, …
    const parts = full.split("/");
    const rel = parts.slice(strip).join("/");
    if (!rel || !keep(rel)) continue;
    files.set(rel, buf.toString("utf8", dataStart, dataEnd));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Type index: node type string → def file. Built over any file tree (the
// local checkout or a tag's archive) from the same regexes.
// ---------------------------------------------------------------------------

async function buildTypeIndex(listFiles, readRel) {
  const index = new Map();
  const files = (await listFiles("src/nodes")).filter((rel) => INDEX_EXTS.has(path.extname(rel)));
  const importMap = new Map(); // def var → relPath (for alias resolution)
  let indexTsSrc = "";
  for (const rel of files) {
    const src = await readRel(rel);
    if (src == null) continue;
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
  return index;
}

// Last-ditch resolve for a def whose header the regex didn't catch: find a
// scope file that contains the quoted type literal.
async function grepTypeIn(type, listFiles, readRel) {
  const needle = `"${type}"`;
  const files = (await listFiles("src/nodes")).filter((rel) => INDEX_EXTS.has(path.extname(rel)));
  for (const rel of files) {
    const src = await readRel(rel);
    if (src != null && src.includes(needle)) return rel;
  }
  return null;
}

export function createSourceReader() {
  // Re-read per call, not once at boot: a server that outlived a `git pull`
  // or a release commit would otherwise keep reporting the old version and
  // fetch a tag for source that is already on disk.
  function localVersion() {
    try {
      return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
    } catch {
      return "unknown"; // skew detection just no-ops (always reads local)
    }
  }

  let localIndex = null; // Promise<Map<type, relPath>>, built once per boot
  const fetchCache = new Map(); // `${ref}:${rel}` → text | null(miss)
  const treeCache = new Map(); // ref → Promise<{files: Map, source} | null>
  const refIndexCache = new Map(); // ref → Promise<Map<type, relPath>>

  // --- the local checkout --------------------------------------------------

  async function walkLocal(dirRel, exts) {
    const out = [];
    let entries;
    try {
      entries = await readdir(path.join(REPO_ROOT, dirRel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ent of entries) {
      const childRel = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) out.push(...(await walkLocal(childRel, exts)));
      else if (!exts || exts.has(path.extname(ent.name))) out.push(childRel);
    }
    return out;
  }

  async function readLocal(rel) {
    try {
      return await readFile(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      return null;
    }
  }

  function localTypeIndex() {
    if (!localIndex) localIndex = buildTypeIndex((dir) => walkLocal(dir, INDEX_EXTS), readLocal);
    return localIndex;
  }

  // --- a released version's source tree -----------------------------------

  // The scope subtree at tag v<ref>: {files: Map<rel, text>, source}. Local
  // git objects first (the checkout usually has the tag), GitHub's tarball
  // second, null when neither is reachable. Cached per ref — including the
  // miss, so an offline session doesn't retry the download on every call.
  function treeFor(ref) {
    if (!treeCache.has(ref)) treeCache.set(ref, loadTree(ref));
    return treeCache.get(ref);
  }

  async function loadTree(ref) {
    const tag = `v${ref}`;
    try {
      const { stdout } = await execFileP(
        "git",
        ["archive", "--format=tar", tag, "--", ...SCOPE_DIRS],
        { cwd: REPO_ROOT, encoding: "buffer", maxBuffer: GIT_ARCHIVE_MAX_BYTES }
      );
      const files = readTar(stdout, { keep: inScope });
      if (files.size) return { files, source: "local git tag" };
    } catch {
      // tag not fetched locally, or no git — try the release tarball
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TARBALL_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`${GITHUB_TARBALL}/${tag}`, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const gz = Buffer.from(await res.arrayBuffer());
      const files = readTar(gunzipSync(gz), { keep: inScope, strip: 1 });
      if (files.size) return { files, source: "GitHub tag" };
    } catch {
      // offline / aborted
    }
    return null;
  }

  function refTypeIndex(ref, tree) {
    if (!refIndexCache.has(ref)) {
      const listFiles = async (dir) =>
        [...tree.files.keys()].filter((rel) => rel === dir || rel.startsWith(`${dir}/`));
      const readRel = async (rel) => tree.files.get(rel) ?? null;
      refIndexCache.set(ref, buildTypeIndex(listFiles, readRel));
    }
    return refIndexCache.get(ref);
  }

  function skewRef(appVersion) {
    // Anchored + `/`-free by construction: appVersion is attacker-controllable
    // once paired, and it's interpolated into the GitHub fetch URLs as the
    // tag segment (`/v${ref}/…`) and into a git argument. An unanchored
    // regex let e.g. "1.0.0/../../../evil/repo/main" normalize to an
    // arbitrary repo (SSRF / source-substitution). A strict x.y.z gate can't
    // contain a slash or a leading dash, so neither the URL host/org/repo nor
    // the git command line can be escaped. Non-matching versions (prerelease,
    // build metadata) fall back to the local checkout — safe.
    if (!appVersion || !/^\d+\.\d+\.\d+$/.test(appVersion)) return null;
    if (appVersion === localVersion()) return null;
    return appVersion;
  }

  const fetchedNote = (ref, source) =>
    `Paired editor is v${ref}; showing source from the v${ref} tag ` +
    `(${source}; your local checkout is v${localVersion()}).`;
  const localFallbackNote = (ref) =>
    `Paired editor is v${ref} but the v${ref} tag couldn't be read ` +
    `(no local tag and GitHub unreachable, or the path changed at that tag) — showing your LOCAL ` +
    `checkout (v${localVersion()}), which may differ.`;
  const searchNote = (ref, source) =>
    `Search ran on the v${ref} tag (${source}) — the version the paired editor is running; ` +
    `your local checkout is v${localVersion()}.`;
  const searchSkewNote = (ref) =>
    `Search ran on your LOCAL checkout (v${localVersion()}); paired editor is ` +
    `v${ref} and its tag couldn't be read (no local tag, GitHub unreachable), so matches may not reflect the running version.`;

  function safeResolve(input) {
    const cleaned = String(input ?? "").replace(/^\.\//, "").replace(/^\/+/, "");
    const abs = path.resolve(REPO_ROOT, cleaned);
    const rel = toPosixRel(abs);
    if (!inScope(rel) || rel.startsWith("..")) return null;
    return { abs, rel };
  }

  // Read a scope file at the paired version when skewed, local otherwise.
  // Returns {text, versionNote} or throws when the file exists nowhere.
  async function loadFile(rel, ref) {
    if (ref) {
      const tree = await treeFor(ref);
      if (tree) {
        const t = tree.files.get(rel);
        if (t != null) return { text: t, versionNote: fetchedNote(ref, tree.source) };
        // Not in the tag's tree — a path that moved. Per-file raw is
        // pointless here (same tag); fall through to local with the note.
      } else {
        // No tree at all — the per-file raw fetch is a cheaper last try.
        const key = `${ref}:${rel}`;
        if (!fetchCache.has(key)) {
          try {
            const res = await fetch(`${GITHUB_RAW}/v${ref}/${rel}`);
            fetchCache.set(key, res.ok ? await res.text() : null);
          } catch {
            fetchCache.set(key, null);
          }
        }
        const cached = fetchCache.get(key);
        if (cached != null) return { text: cached, versionNote: fetchedNote(ref, "GitHub raw") };
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
    get localVersion() {
      return localVersion();
    },
    // Exposed for the check gate (and any caller wanting the tree itself).
    treeFor,
    skewRef,

    async getNodeSource({ type, appVersion } = {}) {
      if (!type) return { error: "get_node_source needs a `type` (a catalog node type string)." };
      const ref = skewRef(appVersion);
      // Resolve type → file against the version we'll read, so a def that
      // moved files between releases still lands on the right one.
      const tree = ref ? await treeFor(ref) : null;
      const index = tree ? await refTypeIndex(ref, tree) : await localTypeIndex();
      let rel = index.get(type);
      if (!rel) {
        rel = tree
          ? await grepTypeIn(
              type,
              async (dir) => [...tree.files.keys()].filter((r) => r.startsWith(`${dir}/`)),
              async (r) => tree.files.get(r) ?? null
            )
          : await grepTypeIn(type, (dir) => walkLocal(dir, INDEX_EXTS), readLocal);
      }
      if (!rel) {
        const near = nearMisses(type, [...index.keys()]);
        return {
          error:
            `Unknown node type "${type}"${tree ? ` at v${ref}` : ""}. ` +
            (near.length
              ? `Did you mean: ${near.join(", ")}? `
              : "") +
            "Call get_catalog for the full list.",
        };
      }
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
      const ref = skewRef(appVersion);
      // Skewed ⇒ search the paired version's tree; the local checkout is
      // only the fallback when that tree can't be read.
      const tree = ref ? await treeFor(ref) : null;
      let files;
      let readRel;
      if (tree) {
        files = [...tree.files.keys()].filter((rel) => SEARCH_EXTS.has(path.extname(rel)));
        readRel = async (rel) => tree.files.get(rel) ?? null;
      } else {
        files = [];
        for (const dir of SCOPE_DIRS) files.push(...(await walkLocal(dir, SEARCH_EXTS)));
        readRel = readLocal;
      }
      files.sort();
      const hits = [];
      let truncated = false;
      for (const rel of files) {
        if (globRe && !globRe.test(rel)) continue;
        const src = await readRel(rel);
        if (src == null) continue;
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
      if (ref) head.push(`// ${tree ? searchNote(ref, tree.source) : searchSkewNote(ref)}`);
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
