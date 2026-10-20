// End-to-end After Effects package run on this Mac (spec
// 091926_after-effects-handoff.md §9's live protocol for the package lane).
// NOT a gate: it needs After Effects 26.5 + aerender, the installed Toolbox
// Shader host, tbxshader-render, and Electron. The offline halves are
// check-package-{paths,files,runner}.mts.
//
//   npx tsx scripts/ae-export/e2e-package.mts                 every case
//   npx tsx scripts/ae-export/e2e-package.mts shader bake     cases whose name contains a filter
//   npx tsx scripts/ae-export/e2e-package.mts --out DIR       main's export folder (default: a temp dir)
//
// For each case it runs the REAL runner (createAeExportRunner + folderSink)
// against the REAL main-process code — electron/files.js nested writes,
// electron/ffmpeg.js folder-target encodes, electron/ae.js createPackage /
// build / render — served by scripts/ae-export/e2e-electron-host.cjs over
// stdio. Then it renders frames 0 and N with aerender and compares them:
//   - fixtures a–e (scripts/fixtures/ae-export): pixels scene.json implies
//     (the M0 spike's non-GUI expectations);
//   - "shader": a GLSL Expression → bundleFromGlslExpression → a TBX Shader
//     effect, against tbxshader-render of the same bundle at the same time;
//   - "bake-qtrle" / "bake-prores": baked footage, against the frames the
//     stand-in renderNodeFrames streamed into the encoder.
// The startup hook is removed after every build (ae.js); the After Effects
// GUI, if open, is never contacted.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { loadRegistry } from "./harness.mts";
import { syncChannelInputs } from "@/engine/expr-channels";
import { compareRgba } from "@/lib/glsl-translation/compare";
import { createAeExportRunner, folderSink } from "@/lib/ae-export/package";
import type { AeFrameRenderer } from "@/lib/ae-export/package";
import type { AeSceneBuild } from "@/lib/ae-export/scene";
import { synthesizeScenePresets } from "@/lib/ae-export/runtime/ffx";
import { DEFAULT_AE_POLICY, tbxShaderParamMatch, type AeExportPlan, type AeLayer, type AeScene } from "@/lib/ae-export/types";
import type { AeBuildResult, AePackageFolder, AeRenderResult, NativeVideoEncodeSpec, Platform } from "@/lib/platform/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FIXTURES = join(REPO, "scripts/fixtures/ae-export");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(tmpdir(), `toolbox-ae-e2e-${Date.now()}`);
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The Electron host
// ---------------------------------------------------------------------------

const electronBin: string = createRequire(import.meta.url)("electron");
const host = spawn(electronBin, [join(HERE, "e2e-electron-host.cjs")], {
  env: { ...process.env, TOOLBOX_AE_EXPORT_DIR: OUT, ELECTRON_ENABLE_LOGGING: "0" },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
let nextId = 1;
let ready: () => void;
const readyP = new Promise<void>((r) => (ready = r));
let buf = "";
host.stdout!.on("data", (d) => {
  buf += d;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // Electron's own chatter
    }
    if (msg.ready) ready();
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(dec(msg.value));
    else p.reject(new Error(msg.error));
  }
});
const enc = (v: any): any =>
  v instanceof Uint8Array || v instanceof Uint8ClampedArray
    ? { __b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") }
    : v instanceof ArrayBuffer
      ? { __b64: Buffer.from(v).toString("base64") }
      : Array.isArray(v)
        ? v.map(enc)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]))
          : v;
const dec = (v: any): any =>
  v && typeof v === "object" && typeof v.__b64 === "string"
    ? new Uint8Array(Buffer.from(v.__b64, "base64"))
    : Array.isArray(v)
      ? v.map(dec)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))
        : v;
function call<T = any>(channel: string, ...a: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.stdin!.write(`${JSON.stringify({ id, channel, args: enc(a) })}\n`);
  });
}

// The renderer's platform seam, over the host (what native.ts does over IPC).
const tokens = new WeakMap<object, string>();
async function createPackage(name: string, folderToken?: string): Promise<AePackageFolder> {
  const r = await call("toolbox:ae:createPackage", { name, ...(folderToken ? { folderToken } : {}) });
  const pkg: AePackageFolder = {
    name: r.name,
    path: r.path,
    aerenderSafe: r.aerenderSafe,
    ...(r.aerenderReason ? { aerenderReason: r.aerenderReason } : {}),
    writeFile: (n, data) => call("toolbox:writeFileInFolder", r.token, n, data as Uint8Array),
    writeFileAt: (rel, data) => call("toolbox:writeFileInFolderAt", r.token, rel, data as Uint8Array),
  };
  tokens.set(pkg, r.token);
  return pkg;
}
const platform: Pick<Platform, "encodeVideo" | "canEncodeNative"> = {
  canEncodeNative: true,
  async encodeVideo(spec: NativeVideoEncodeSpec) {
    const { into, ...rest } = spec;
    const begun = await call("toolbox:encodeVideoBegin", { ...rest, ...(into ? { target: { token: tokens.get(into.folder), path: into.path } } : {}) });
    const sid = begun.sessionId;
    return {
      writeFrame: (rgba: Uint8Array) => call("toolbox:encodeVideoFrame", sid, rgba),
      finish: () => call("toolbox:encodeVideoEnd", sid),
      abort: () => call("toolbox:encodeVideoAbort", sid),
    };
  },
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface Pixel {
  frame: number;
  x: number;
  y: number;
  want: (number | null)[];
  tol?: number;
  label: string;
}

interface Case {
  name: string;
  // Live checks against the Electron host after the package is written.
  extra?(): Promise<void>;
  build: AeSceneBuild;
  frames: number[];
  pixels?: Pixel[];
  // Reference frames (straight RGBA at comp size) to compareRgba against.
  reference?(frame: number, pkgDir: string): Promise<Uint8Array>;
  renderFrames?: AeFrameRenderer;
  readAsset?(path: string): Promise<Uint8Array | null>;
  expectWarnings?: RegExp[];
  // A folder (the user's pick) the package goes in instead of main's export folder.
  folder?: string;
  // The render must be refused with this, not attempted.
  expectRenderRefusal?: RegExp;
  expectExportWarnings?: RegExp[];
}

function planOf(scene: AeScene): AeExportPlan {
  const main = scene.comps.find((c) => c.id === scene.main)!;
  return {
    route: scene.report.route,
    composition: { id: "fixture", name: main.name, width: main.width, height: main.height, fps: main.fps, durationFrames: Math.round(main.duration * main.fps) },
    layers: [],
    shaderRegions: [],
    bakes: [],
    expressions: [],
    blocked: [],
    approximations: [],
    estimates: { layers: 0, keyframes: 0, footageMB: 0 },
    fonts: scene.report.requires.fonts,
    policy: DEFAULT_AE_POLICY,
    warnings: [],
  };
}

function wrap(scene: AeScene, extra: Partial<AeSceneBuild> = {}): AeSceneBuild {
  const presets = synthesizeScenePresets(scene).map((p) => ({ id: scene.presets.find((x) => x.path === p.path)!.id, path: p.path, bytes: p.bytes }));
  return { plan: planOf(scene), scene, bakes: [], bundles: [], presets, files: [], assets: [], problems: [], warnings: [], ...extra };
}

const fixture = (f: string) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as AeScene;

async function dotPng(): Promise<Uint8Array> {
  const n = 64;
  const px = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      px.set([255, 200, 0, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) < 28 ? 255 : 0], o);
    }
  return new Uint8Array(await sharp(px, { raw: { width: n, height: n, channels: 4 } }).png().toBuffer());
}

const solid = (id: string, color: [number, number, number], w: number, h: number, dur: number, extra: Partial<AeLayer> = {}): AeLayer =>
  ({
    id,
    name: id,
    kind: "solid",
    inPoint: 0,
    outPoint: dur,
    startTime: 0,
    blendingMode: "normal",
    solid: { color, width: w, height: h },
    transform: { anchor: { v: [w / 2, h / 2] }, position: { v: [w / 2, h / 2] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } },
    ...extra,
  }) as AeLayer;

function sceneOf(name: string, w: number, h: number, fps: number, dur: number, layers: AeLayer[], more: Partial<AeScene> = {}): AeScene {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-20T00:00:00.000Z",
    toolboxVersion: "e2e",
    project: { bitsPerChannel: 8, linearBlending: false, expressionEngine: "javascript-1.0" },
    footage: [],
    presets: [],
    comps: [{ id: "main", name, width: w, height: h, fps, duration: dur, layers }],
    main: "main",
    report: { route: "direct", native: [], approx: [], shader: [], baked: [], blocked: [], warnings: [], requires: { fonts: [] } },
    ...more,
  };
}

// --- shader: a GLSL Expression through the translator into the host ---------
const SHADER_BODY = `// ch("radius", 0.35, 0.0, 1.0)
// color("tint", "#ff8000")
vec2 p = v_uv - 0.5;
p.x *= u_res.x / u_res.y;
float d = length(p);
float ring = 1.0 - smoothstep(radius - 0.01, radius + 0.01, d);
float wave = 0.5 + 0.5 * sin(u_time * 3.0 + v_uv.x * 6.2831853);
fragColor = vec4(tint.rgb * wave, ring);`;

async function shaderCase(): Promise<Case> {
  const { bundleFromGlslExpression } = await import("@/lib/ae-export/shader/bundle");
  const { writeTbxfx } = await import("@/lib/ae-export/shader/tbxfx");
  const W = 640, H = 360, FPS = 30, DUR = 2;
  const params = { inputs: syncChannelInputs([], SHADER_BODY), expression: SHADER_BODY };
  const r = bundleFromGlslExpression(params, { name: "E2E Ring", fps: FPS, loopFrames: 0, canvas: { width: W, height: H } });
  if (!r.ok) throw new Error(`bundle: ${JSON.stringify(r.errors)}`);
  const bundle = r.bundle;
  const slider = bundle.params.find((p) => p.name === "radius")!;
  const color = bundle.params.find((p) => p.name === "tint")!;
  const radius = 0.3;
  const tint = [0.2, 0.6, 1, 1];
  const fxLayer = solid("ringLayer", [0, 0, 0], W, H, DUR, {
    name: "Ring",
    effects: [
      {
        match: "TBX Shader",
        bundle: String(bundle.id),
        props: {
          [tbxShaderParamMatch("bundle")]: { v: bundle.id },
          [tbxShaderParamMatch("slider", slider.slot)]: { v: radius },
          [tbxShaderParamMatch("color", color.slot)]: { v: tint },
          [tbxShaderParamMatch("time")]: { v: 1 },
          // Not one of this bundle's controls: build.jsx must skip it (AE
          // refuses hidden controls) and say so.
          [tbxShaderParamMatch("slider", 9)]: { v: 0.5 },
        },
      },
    ],
  });
  const scene = sceneOf("E2E Shader", W, H, FPS, DUR, [fxLayer]);
  scene.report.shader = [{ id: "glsl-1", type: "glsl-expression", name: "Ring", class: "shader", fidelity: "exact", note: `bundle ${bundle.id}` }];
  scene.report.requires.shaderHost = bundle.hostMin;
  const render = join(dirname(findChecker()!), "tbxshader-render");
  return {
    name: "shader",
    // validate_ae_shader's desktop half: main resolves tbxshader-check and
    // runs it on the bundle; a broken MSL comes back on its source.msl line.
    async extra() {
      const { hostCheckResult } = await import("@/lib/ae-export/package/shader-check");
      const okChk = await call("toolbox:ae:checkShader", { text: writeTbxfx(bundle) });
      check(`checkShader (main's ${okChk.checker?.split("/").slice(-3).join("/")}): the bundle compiles`, okChk.available && okChk.status === 0 && hostCheckResult(okChk).ok, okChk);
      const msl = bundle.source.msl!;
      const broken = { ...bundle, source: { ...bundle.source, msl: msl.replace(/return /, "return missing_value + ") } };
      const badChk = await call("toolbox:ae:checkShader", { text: writeTbxfx(broken) });
      const res = hostCheckResult(badChk);
      const line = msl.split("\n").findIndex((l) => l.includes("return ")) + 1;
      check(
        `checkShader: a broken source.msl fails with its line (${res.diagnostics?.[0]?.mslLine} = ${line})`,
        !res.ok && res.diagnostics?.[0]?.mslLine === line && /missing_value/.test(res.diagnostics[0].message),
        res
      );
    },
    build: wrap(scene, { bundles: [bundle] }),
    frames: [0, 45],
    expectWarnings: [/skipped TBX Shader-0028 - not a control of shader bundle E2E Ring/],
    async reference(frame, pkgDir) {
      const file = join(pkgDir, "renders", `ref-${frame}.png`);
      const bundleFile = join(pkgDir, "shaders", `${bundle.id}.tbxfx`);
      const p = spawnSync(render, [bundleFile, "--size", `${W}x${H}`, "--time", String(frame / FPS), "--set", `radius=${radius}`, "--set", `tint=${tint.slice(0, 3).join(",")}`, "--depth", "8", "-o", file], { encoding: "utf8" });
      if (p.status !== 0) throw new Error(`tbxshader-render: ${p.stderr}${p.stdout}`);
      const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return new Uint8Array(data);
    },
  };
}

function findChecker(): string | null {
  for (let dir = REPO, i = 0; i < 8; i++, dir = dirname(dir)) {
    const p = join(dirname(dir), "AE_Plugins", "toolbox-shader", "build", "tbxshader-check");
    if (existsSync(p)) return p;
  }
  return null;
}

// --- bakes: footage streamed by a stand-in renderNodeFrames -------------------
// A disc moving left → right with a horizontal ramp and a soft (partly
// transparent) edge — the alpha path is what a bake most often breaks.
function bakeFrame(tick: number, w: number, h: number): Uint8Array {
  const f = tick / 1000;
  const px = new Uint8Array(w * h * 4);
  const cx = 40 + f * 8, cy = h / 2, r = 50;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, (r - d) / 12));
      const o = (y * w + x) * 4;
      px[o] = Math.round((255 * x) / w);
      px[o + 1] = 160;
      px[o + 2] = Math.round(255 - (255 * y) / h);
      px[o + 3] = Math.round(255 * a);
    }
  return px;
}

function bakeCase(codec: "qtrle" | "prores4444"): Case {
  const W = 320, H = 180, FPS = 30, DUR = 1;
  const footage = solid("unused", [0, 0, 0], W, H, DUR);
  const layer: AeLayer = { ...footage, id: "bakeLayer", name: "Baked disc", kind: "footage", source: "bake1" } as AeLayer;
  delete (layer as any).solid;
  const scene = sceneOf(`E2E Bake ${codec}`, W, H, FPS, DUR, [layer], {
    footage: [{ id: "bake1", path: "footage/disc.mov", kind: "video", alpha: "straight", fps: FPS }],
  });
  scene.report.baked = [{ id: "disc", type: "particles", class: "bake", fidelity: "bake", note: "simulation" }];
  scene.report.route = "direct+bake";
  return {
    name: `bake-${codec}`,
    build: wrap(scene, { bakes: [{ id: "bake1", output: "disc:out", frames: [0, FPS * DUR - 1], size: [W, H], codec, path: "footage/disc.mov" }] }),
    frames: [0, FPS * DUR - 1],
    renderFrames: async (target, ticks, size, onFrame) => {
      if (target.node !== "disc" || target.handle !== "out:primary") throw new Error(`unexpected target ${JSON.stringify(target)}`);
      let i = 0;
      for (const tick of [...new Set(ticks)].sort((a, b) => a - b)) await onFrame({ tick, index: i++, rgba: bakeFrame(tick, size.width, size.height) });
    },
    async reference(frame) {
      return bakeFrame(frame * 1000, W, H);
    },
  };
}

const PIXELS: Record<string, Pixel[]> = {
  "a-circle": [
    { frame: 0, x: 340, y: 240, want: [51, 153, 255, 255], tol: 1, label: "inside circle and mask: fill color" },
    { frame: 0, x: 495, y: 300, want: [null, null, null, 0], label: "inside circle, outside the spline mask" },
    { frame: 0, x: 100, y: 100, want: [null, null, null, 0], label: "outside the circle" },
  ],
  "b-matte-blur": [
    { frame: 0, x: 760, y: 300, want: [255, 141, 95, 255], tol: 3, label: "Screen of the glow over the background" },
    { frame: 0, x: 760, y: 480, want: [13, 26, 77, 255], tol: 2, label: "below the luma matte: background only" },
    { frame: 25, x: 760, y: 440, want: [255, 141, 95, 255], tol: 3, label: "frame 25: the parented matte moved down" },
  ],
  "c-gradient": [{ frame: 0, x: 600, y: 480, want: [128, 192, 128, 255], tol: 8, label: "SVG imported as shapes: cyan → orange midpoint" }],
  "d-text": [],
  "e-kitchen-sink": [{ frame: 0, x: 20, y: 980, want: [null, null, null, 255], label: "base solid renders under the adjustment layer" }],
};
const LAST: Record<string, number> = { "a-circle": 15, "b-matte-blur": 25, "c-gradient": 15, "d-text": 30, "e-kitchen-sink": 24 };

async function fixtureCase(file: string): Promise<Case> {
  const name = file.replace(/\.scene\.json$/, "");
  const scene = fixture(file);
  const files = scene.footage.filter((f) => f.kind === "svg").map((f) => ({ path: f.path, text: readFileSync(join(FIXTURES, "assets", f.path.split("/").pop()!), "utf8") }));
  const assets = scene.footage
    .filter((f) => f.kind !== "svg")
    .map((f) => ({ id: f.id, path: f.path, source: { kind: "image" as const, ref: `generated:${f.path}` } }));
  return {
    name,
    build: wrap(scene, { files, assets }),
    frames: [0, LAST[name] ?? 0],
    pixels: PIXELS[name] ?? [],
    readAsset: async (path) => (path.endsWith("dot.png") ? dotPng() : null),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await loadRegistry();
await readyP;
const caps = await call("toolbox:ae:capabilities");
console.log(`After Effects: ${caps.available ? `${caps.app} (${caps.version}), startup ${caps.startupFolder}` : `not available — ${caps.reason}`}`);
console.log(`Toolbox Shader host: ${caps.shaderHost.installed ? `${caps.shaderHost.path} ${caps.shaderHost.version}` : "not installed"}; tbxshader-check: ${caps.shaderCheck ?? "none"}`);
console.log(`export folder (main's): ${OUT}`);
if (!caps.available) {
  await call("test:quit").catch(() => {});
  process.exit(2);
}

const all: (() => Promise<Case>)[] = [
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".scene.json"))
    .sort()
    .map((f) => () => fixtureCase(f)),
  shaderCase,
  async () => bakeCase("qtrle"),
  async () => bakeCase("prores4444"),
  // A picked folder whose path has a double quote: the build passes
  // aerender no path, so it works; a render would paste the path into
  // aerender's JavaScript unescaped (a `"` hangs its core), so main refuses.
  async () => {
    const dir = join(OUT, 'picked "quoted" folder');
    mkdirSync(dir, { recursive: true });
    const base = await fixtureCase("a-circle.scene.json");
    return {
      ...base,
      name: "quoted-folder",
      folder: dir,
      pixels: [],
      expectRenderRefusal: /aerender project: .*double quote/,
      expectExportWarnings: [/command-line renderer can't open this folder/],
    };
  },
];

let failures = 0;
const report: Record<string, unknown> = {};
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

for (const make of all) {
  const c = await make();
  if (filters.length && !filters.some((f) => c.name.includes(f))) continue;
  console.log(`\n${c.name}`);
  const row: Record<string, unknown> = {};
  report[c.name] = row;
  let built: AeBuildResult | null = null;
  const t0 = Date.now();
  const run = createAeExportRunner({
    toolboxVersion: "e2e",
    buildScene: () => c.build,
    renderFrames: c.renderFrames ?? (async () => { throw new Error("no renderer for this case"); }),
    readAsset: (a) => (c.readAsset ? c.readAsset(a.path) : Promise.resolve(null)),
    openSink: async (_dest, root) => {
      if (!c.folder) return folderSink(await createPackage(root), platform);
      await call("test:registerFolder", c.folder);
      return folderSink(await createPackage(root, c.folder), platform);
    },
    build: async (loc) => (built = await call<AeBuildResult>("toolbox:ae:build", loc, { open: false })),
    now: () => new Date("2026-10-20T12:00:00Z"),
  });
  const res = await run({ policy: {}, overrides: {}, fused: {}, name: `e2e ${c.name}`, destination: "folder", build: true });
  row.exportSeconds = (Date.now() - t0) / 1000;
  check(`package written: ${res.location}`, res.ok && !!res.location, res.problems);
  if (!res.location) continue;
  const listed = readdirSync(res.location, { recursive: true }).map(String).sort();
  row.files = listed.filter((f) => !f.startsWith("renders"));
  check("every README file is on disk", (res.files ?? []).every((f) => listed.includes(f)), (res.files ?? []).filter((f) => !listed.includes(f)));
  const b = built as AeBuildResult | null;
  check(`headless build ok (${b?.seconds.toFixed(1)} s): ${b?.aep}`, !!b?.ok && !!b.aep, b ? { notes: b.notes, aerender: b.aerender } : "no build");
  row.buildSeconds = b?.seconds;
  const log = b?.result as any;
  row.buildProblems = log?.problems;
  row.buildWarnings = log?.warnings;
  check("build-log.json reports 0 problems", Array.isArray(log?.problems) && log.problems.length === 0, log?.problems);
  for (const re of c.expectWarnings ?? []) check(`build warns ${re}`, (log?.warnings ?? []).some((w: string) => re.test(w)), log?.warnings);
  for (const re of c.expectExportWarnings ?? []) check(`export warns ${re}`, res.warnings.some((w) => re.test(w)), res.warnings);
  if (c.extra) await c.extra();
  if (!b?.ok) continue;
  if (c.expectRenderRefusal) {
    const t = Date.now();
    const refused = await call("toolbox:ae:render", res.location, { frames: [0] }).then(
      () => "",
      (e: Error) => e.message
    );
    check(`render refused before aerender starts (${((Date.now() - t) / 1000).toFixed(2)} s): ${refused.slice(0, 90)}…`, c.expectRenderRefusal.test(refused) && Date.now() - t < 2000, refused);
    continue;
  }

  const t1 = Date.now();
  let rendered: AeRenderResult;
  try {
    const r = await call("toolbox:ae:render", res.location, { frames: c.frames });
    rendered = { ...r, frames: r.frames.map((f: any) => ({ ...f, rgba: f.rgba ? new Uint8Array(f.rgba) : undefined })) };
  } catch (e) {
    check("aerender frames", false, (e as Error).message);
    continue;
  }
  row.renderSeconds = (Date.now() - t1) / 1000;
  const { width: W, height: H } = rendered.comp;
  for (const f of rendered.frames) check(`aerender -s ${f.frame} -e ${f.frame}: ${W}×${H} frame (${f.seconds?.toFixed(1)} s)`, !!f.rgba, f.error);
  const frameOf = (n: number) => rendered.frames.find((f) => f.frame === n)?.rgba;
  for (const p of c.pixels ?? []) {
    const px = frameOf(p.frame);
    if (!px) {
      check(p.label, false, `frame ${p.frame} not rendered`);
      continue;
    }
    const o = (p.y * W + p.x) * 4;
    const got = [px[o], px[o + 1], px[o + 2], px[o + 3]];
    const tol = p.tol ?? 2;
    check(`f${p.frame} (${p.x}, ${p.y}) ${p.label}`, p.want.every((v, i) => v === null || Math.abs(got[i] - v) <= tol), { got, want: p.want });
  }
  if (c.reference) {
    const metrics: unknown[] = [];
    for (const n of c.frames) {
      const px = frameOf(n);
      if (!px) continue;
      const ref = await c.reference(n, res.location);
      const m = compareRgba(ref, px, W, H);
      metrics.push({ frame: n, meanAbs: +m.meanAbs.toFixed(5), p95Abs: +m.p95Abs.toFixed(5), alphaMeanAbs: +m.alphaMeanAbs.toFixed(5), verdict: m.verdict });
      check(`f${n} vs reference: ${m.verdict} (meanAbs ${m.meanAbs.toFixed(4)}, p95 ${m.p95Abs.toFixed(4)}, alpha ${m.alphaMeanAbs.toFixed(4)})`, m.verdict === "match", m);
      await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(res.location, "renders", `ae-${n}.png`));
    }
    row.metrics = metrics;
  }
}

writeFileSync(join(OUT, "e2e-report.json"), JSON.stringify(report, null, 1));
console.log(`\nreport: ${join(OUT, "e2e-report.json")}`);
await call("test:quit").catch(() => {});
console.log(failures ? `\ne2e-package: ${failures} FAILED` : "\ne2e-package: all passed");
process.exit(failures ? 1 : 0);
