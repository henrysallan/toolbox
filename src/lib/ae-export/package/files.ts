// The AE package's static files (spec 091926_after-effects-handoff.md §5.1):
// AeSceneBuild → scene.json, build.jsx, presets/*.ffx, shaders/<id>.tbxfx,
// the scene's extra text files, toolbox.json and README.txt. Pure — no DOM,
// no I/O — so scripts/ae-export/check-package-files.mts gates the file list,
// the README report and the refusals offline. Footage (bakes, copied assets)
// is the runner's job (runner.ts); this module only checks that every
// footage path the scene names is something the runner will write.
//
// Path rules mirror electron/safe-paths.js vetRelativePath, which main
// enforces on every nested write; here they turn a bad path into a readable
// problem before anything is written (check-package-paths holds the two to
// the same corpus).

import { BUILD_JSX_FILE, BUILD_JSX_SOURCE, BUILD_JSX_VERSION } from "../runtime";
import { validateAeScene } from "../runtime/validate";
import { writeTbxfx } from "../shader/tbxfx";
import { validateAeShader } from "../shader/validate";
import type { AePlanReport, AeReportLine, AeScene, AeShaderBundle } from "../types";
import type { AeBakeRequest, AeSceneBuild } from "../scene";

export const AE_PACKAGE_EXT = ".aepkg";
export const SCENE_FILE = "scene.json";
export const README_FILE = "README.txt";
export const MANIFEST_FILE = "toolbox.json";
const RESERVED = new Set([SCENE_FILE, BUILD_JSX_FILE, README_FILE, MANIFEST_FILE, "build-log.json"]);

export interface AePackageFile {
  // Relative to the package root, forward slashes.
  path: string;
  text?: string;
  bytes?: Uint8Array;
}

// What toolbox.json records: enough for compare_ae_renders to render the
// same thing on the toolbox side, and for a reader to know what made it.
export interface AePackageManifest {
  format: "toolbox-ae-package";
  version: 1;
  name: string;
  toolboxVersion: string;
  builder: string;
  exportedAt: string;
  composition: AeSceneBuild["plan"]["composition"];
  // The toolbox node whose image the main comp reproduces ("<id>:out").
  output?: string;
  main: { id: string; name: string; width: number; height: number; fps: number; duration: number };
  bundles: { id: number; name: string; hostMin: string; path: string }[];
  bakes: { id: string; output: string; path: string; frames: [number, number]; codec: string }[];
}

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /["'`\\:*?<>|\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// The package's base name: what electron/safe-paths.js sanitizeBaseName makes
// of the export name (main may still add " 2" when the folder exists).
export function aePackageBaseName(raw: string, fallback = "toolbox-export"): string {
  let s = String(raw ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"'`\\:*?<>|/]/g, "_")
    .trim()
    .replace(/\.aepkg$/i, "")
    .trim()
    .replace(/^[.~\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback;
}

// electron/safe-paths.js vetRelativePath, verbatim in rules.
export function vetPackagePath(rel: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof rel !== "string") return { ok: false, reason: "path must be a string" };
  if (!rel) return { ok: false, reason: "path is empty" };
  if (rel.length > 512) return { ok: false, reason: "path is longer than 512 characters" };
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return { ok: false, reason: `"${rel}" is absolute` };
  if (BAD_CHARS.test(rel)) return { ok: false, reason: `"${rel}" contains a quote, backslash, reserved or control character` };
  for (const s of rel.split("/")) {
    if (!s) return { ok: false, reason: `"${rel}" has an empty segment` };
    if (s === "." || s === "..") return { ok: false, reason: `"${rel}" leaves its folder` };
    if (s.startsWith(".")) return { ok: false, reason: `"${rel}" names a hidden file` };
    if (s.startsWith("~")) return { ok: false, reason: `"${rel}" starts a segment with ~` };
    if (s.endsWith(" ") || s.endsWith(".")) return { ok: false, reason: `"${rel}" has a segment ending in a space or dot` };
    if (s.length > 128) return { ok: false, reason: `"${rel}" has a segment longer than 128` };
  }
  return { ok: true };
}

export const shaderBundlePath = (b: Pick<AeShaderBundle, "id">) => `shaders/${b.id}.tbxfx`;

// Endpoint → the node + handle renderNodeFrames takes.
export function endpointTarget(endpoint: string): { node: string; handle: string } {
  const aux = /^(.*):aux:([A-Za-z0-9_-]+)$/.exec(endpoint);
  if (aux) return { node: aux[1], handle: `out:aux:${aux[2]}` };
  return { node: endpoint.replace(/:out$/, ""), handle: "out:primary" };
}

// ---------------------------------------------------------------------------
// The report (README + AeExportResult.report)
// ---------------------------------------------------------------------------

export interface AeBakeOutcome {
  id: string;
  path: string;
  frames: [number, number];
  codec: string;
  bytes?: number;
  error?: string;
}

const lineName = (l: AeReportLine) => `${l.name ?? l.type} (${l.id})${l.note ? ` — ${l.note}` : ""}`;

function section(title: string, items: string[]): string[] {
  if (!items.length) return [`${title} (0): none`];
  return [`${title} (${items.length}):`, ...items.map((s) => `  - ${s}`)];
}

// What the AE user must install: the host when a bundle ships, fonts named.
export function aePackageNeeds(build: AeSceneBuild): { shaderHost?: string; fonts: string[] } {
  const r = build.scene.report;
  const hosts = [r?.requires?.shaderHost, ...build.bundles.map((b) => b.hostMin)].filter((v): v is string => !!v);
  const newest = hosts.sort(compareSemver).pop();
  const fonts = [...new Set([...(r?.requires?.fonts ?? []), ...(build.plan.fonts ?? [])])].sort();
  return { ...(newest ? { shaderHost: newest } : {}), fonts };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// Native / approximate / sampled / shader / baked / blocked, the needs, and
// the scene's warnings — the text the modal shows and the tool returns.
export function aePackageReport(build: AeSceneBuild, bakes: AeBakeOutcome[] = []): string {
  const r: AePlanReport = build.scene.report ?? {
    route: build.plan.route,
    native: [],
    approx: [],
    shader: [],
    baked: [],
    blocked: [],
    warnings: [],
    requires: { fonts: [] },
  };
  const lines = [...r.native, ...r.approx, ...r.shader, ...r.baked, ...r.blocked];
  const sampled = lines.filter((l) => l.fidelity === "sampled");
  const native = r.native.filter((l) => l.fidelity !== "sampled");
  const approx = r.approx.filter((l) => l.fidelity !== "sampled");
  const bakeLines = build.bakes.map((b) => {
    const done = bakes.find((x) => x.id === b.id);
    const size = done?.bytes != null ? `, ${(done.bytes / 1048576).toFixed(1)} MB` : "";
    const why = r.baked.find((l) => l.id === b.id || `${l.id}:out` === b.output)?.note;
    return `${b.path} — ${b.output}, frames ${b.frames[0]}–${b.frames[1]}, ${b.size[0]}×${b.size[1]}, ${b.codec}${size}${done?.error ? ` — FAILED: ${done.error}` : ""}${why ? ` — ${why}` : ""}`;
  });
  // Report lines for baked nodes that no AeBakeRequest names (a bake the
  // scene folded into another) still show.
  for (const l of r.baked) if (!build.bakes.some((b) => b.id === l.id || b.output === `${l.id}:out`)) bakeLines.push(lineName(l));
  const needs = aePackageNeeds(build);
  const out = [
    `Route: ${r.route}`,
    ...section("Native", native.map(lineName)),
    ...section("Approximate", approx.map(lineName)),
    ...section("Sampled to per-frame keys", sampled.map(lineName)),
    ...section("Toolbox Shader regions", r.shader.filter((l) => l.fidelity !== "sampled").map(lineName)),
    ...section("Shader bundles", build.bundles.map((b) => `${b.name} → ${shaderBundlePath(b)} (Toolbox Shader ${b.hostMin} or later)`)),
    ...section("Baked footage", bakeLines),
    ...section("Blocked", r.blocked.map(lineName)),
    `Needs: ${needs.shaderHost ? `the Toolbox Shader plug-in ${needs.shaderHost} or later` : "no plug-ins"}; fonts: ${needs.fonts.length ? needs.fonts.join(", ") : "none"}.`,
  ];
  const warnings = [...new Set([...(r.warnings ?? []), ...build.warnings])];
  if (warnings.length) out.push(...section("Warnings", warnings));
  return out.join("\n");
}

export function aeReadme(
  build: AeSceneBuild,
  // `root`: the folder the package landed in (main adds " 2" when the name
  // is taken), which names the .aep build.jsx saves.
  opts: { name: string; toolboxVersion: string; exportedAt: string; bakes?: AeBakeOutcome[]; files: string[]; root?: string }
): string {
  const c = build.plan.composition;
  const base = opts.root ? opts.root.replace(/\.aepkg$/i, "") : aePackageBaseName(opts.name);
  const needs = aePackageNeeds(build);
  const presets = build.scene.presets.length;
  return [
    `${base} — an After Effects package from Toolbox ${opts.toolboxVersion}`,
    `Exported ${opts.exportedAt}. Composition "${c.name}": ${c.width}×${c.height}, ${c.fps} fps, ${c.durationFrames} frames.`,
    "",
    "HOW TO BUILD IT",
    "1. Open After Effects (built and checked in After Effects 2026, 26.5).",
    "2. File → Scripts → Run Script File…, and pick build.jsx in this folder.",
    `   It builds the project from scene.json, saves ${base}.aep in this folder, opens the main`,
    "   comp and shows a summary. Nothing in build.jsx is project data; it only reads scene.json.",
    "3. Keep the folder together: footage/, presets/ and shaders/ are found next to the .aep.",
    "   If After Effects says a script can't write files: Settings → Scripting & Expressions →",
    '   "Allow Scripts to Write Files and Access Network" (needed for build-log.json only).',
    ...(presets
      ? [
          `   ${presets} gradient preset${presets === 1 ? "" : "s"} (presets/*.ffx) apply only when build.jsx runs inside the`,
          "   After Effects app; a headless build skips them with a warning in build-log.json.",
        ]
      : []),
    "The Toolbox desktop app's \"Build in After Effects\" does steps 1–2 headless and then opens",
    "the saved .aep in After Effects.",
    "",
    "WHAT THE AFTER EFFECTS MACHINE NEEDS",
    `- ${needs.shaderHost ? `The Toolbox Shader plug-in, version ${needs.shaderHost} or later (shaders/ holds ${build.bundles.length} bundle${build.bundles.length === 1 ? "" : "s"}).` : "No third-party plug-ins."}`,
    `- ${needs.fonts.length ? `Fonts: ${needs.fonts.join(", ")}.` : "No fonts."}`,
    "",
    "REPORT",
    aePackageReport(build, opts.bakes),
    "",
    "FILES",
    ...opts.files.map((f) => `- ${f}`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AeAssembleOptions {
  name: string;
  toolboxVersion: string;
  // ISO time; the gate pins it.
  exportedAt: string;
  // toolbox.json's `output`.
  output?: string;
}

export interface AeAssembly {
  // "<base>.aepkg" — the folder name, and the zip's root folder.
  root: string;
  // Everything but footage and README.txt (written last, once the bakes'
  // sizes are known — aeReadme).
  files: AePackageFile[];
  manifest: AePackageManifest;
  // Footage the runner must write: bakes it renders + assets it copies.
  footage: { bakes: AeBakeRequest[]; assets: AeSceneBuild["assets"] };
  problems: string[];
  warnings: string[];
}

export function assembleAePackage(build: AeSceneBuild, opts: AeAssembleOptions): AeAssembly {
  const problems: string[] = [...build.problems];
  const warnings: string[] = [...build.warnings];
  const scene: AeScene = build.scene;
  const files: AePackageFile[] = [];
  const claimed = new Map<string, string>();
  const claim = (path: string, what: string) => {
    const v = vetPackagePath(path);
    if (!v.ok) return void problems.push(`${what}: ${v.reason}`);
    const key = path.toLowerCase(); // macOS volumes are case-insensitive
    const prev = claimed.get(key);
    if (prev) problems.push(`${what}: "${path}" is also ${prev}`);
    else claimed.set(key, what);
  };
  for (const r of RESERVED) claimed.set(r.toLowerCase(), `the package's own ${r}`);

  if (scene) for (const p of validateAeScene(scene)) problems.push(`scene.json: ${p}`);

  // Presets: every scene preset needs its bytes.
  for (const p of scene?.presets ?? []) {
    const got = build.presets.find((x) => x.id === p.id || x.path === p.path);
    if (!got) problems.push(`preset "${p.id}" (${p.path}) has no .ffx bytes in the scene build`);
    else if (got.path !== p.path) problems.push(`preset "${p.id}": the scene says ${p.path}, the build wrote ${got.path}`);
  }
  for (const p of build.presets) {
    claim(p.path, `preset ${p.id}`);
    files.push({ path: p.path, bytes: p.bytes });
  }

  // Shader bundles: every effect's bundle ships, each bundle passes the pure
  // validator (the compile check is validate_ae_shader's, on the desktop).
  const used = new Set<string>();
  for (const c of scene?.comps ?? [])
    for (const l of c.layers) for (const fx of l.effects ?? []) if (fx.bundle != null && fx.bundle !== "") used.add(String(fx.bundle));
  for (const id of used) if (!build.bundles.some((b) => String(b.id) === id)) problems.push(`an effect names shader bundle ${id}, which the scene build has no bundle for`);
  for (const b of build.bundles) {
    const path = shaderBundlePath(b);
    claim(path, `shader bundle ${b.name}`);
    const v = validateAeShader(b);
    for (const e of v.errors) problems.push(`shader bundle ${b.name} (${b.id}): ${e.message}${e.line ? ` (GLSL line ${e.line})` : ""}`);
    for (const w of v.warnings) warnings.push(`shader bundle ${b.name}: ${w}`);
    if (!used.has(String(b.id))) warnings.push(`shader bundle ${b.name} (${b.id}) ships but no effect uses it`);
    files.push({ path, text: writeTbxfx(b) });
  }

  for (const f of build.files) {
    claim(f.path, `file ${f.path}`);
    files.push({ path: f.path, text: f.text });
  }

  // Footage: each scene footage path is a bake, a copied asset or a file.
  for (const b of build.bakes) {
    claim(b.path, `baked footage ${b.id}`);
    if (!/\.mov$/i.test(b.path)) problems.push(`baked footage ${b.id}: ${b.path} must be a .mov (QuickTime Animation / ProRes 4444)`);
    if (!(b.frames[1] >= b.frames[0] && b.frames[0] >= 0)) problems.push(`baked footage ${b.id}: frames ${b.frames[0]}–${b.frames[1]} is not a range`);
    if (!(b.size[0] >= 2 && b.size[1] >= 2)) problems.push(`baked footage ${b.id}: size ${b.size[0]}×${b.size[1]}`);
  }
  for (const a of build.assets) claim(a.path, `asset ${a.id}`);
  for (const f of scene?.footage ?? []) {
    const covered =
      build.bakes.some((b) => b.path === f.path) || build.assets.some((a) => a.path === f.path) || build.files.some((x) => x.path === f.path);
    if (!covered) problems.push(`footage "${f.id}" (${f.path}) is neither baked, copied nor written by the scene build`);
  }

  const main = scene?.comps.find((c) => c.id === scene.main);
  if (scene && !main) problems.push(`scene.json's main comp "${scene.main}" is not one of its comps`);
  const manifest: AePackageManifest = {
    format: "toolbox-ae-package",
    version: 1,
    name: aePackageBaseName(opts.name),
    toolboxVersion: opts.toolboxVersion,
    builder: BUILD_JSX_VERSION,
    exportedAt: opts.exportedAt,
    composition: build.plan.composition,
    ...(opts.output ? { output: opts.output } : {}),
    main: main
      ? { id: main.id, name: main.name, width: main.width, height: main.height, fps: main.fps, duration: main.duration }
      : { id: "", name: "", width: 0, height: 0, fps: 0, duration: 0 },
    bundles: build.bundles.map((b) => ({ id: b.id, name: b.name, hostMin: b.hostMin, path: shaderBundlePath(b) })),
    bakes: build.bakes.map((b) => ({ id: b.id, output: b.output, path: b.path, frames: b.frames, codec: b.codec })),
  };

  files.unshift(
    { path: SCENE_FILE, text: `${JSON.stringify(scene, null, 1)}\n` },
    { path: BUILD_JSX_FILE, text: BUILD_JSX_SOURCE },
    { path: MANIFEST_FILE, text: `${JSON.stringify(manifest, null, 1)}\n` }
  );
  return {
    root: `${aePackageBaseName(opts.name)}${AE_PACKAGE_EXT}`,
    files,
    manifest,
    footage: { bakes: build.bakes, assets: build.assets },
    problems,
    warnings: [...new Set(warnings)],
  };
}

// Every path the finished package holds, sorted (README's FILES list).
export function aePackagePaths(assembly: AeAssembly): string[] {
  return [
    ...assembly.files.map((f) => f.path),
    ...assembly.footage.bakes.map((b) => b.path),
    ...assembly.footage.assets.map((a) => a.path),
    README_FILE,
  ].sort((a, b) => (a === README_FILE ? -1 : b === README_FILE ? 1 : a.localeCompare(b)));
}
