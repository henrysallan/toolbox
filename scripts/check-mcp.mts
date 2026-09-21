// check-mcp: end-to-end check of the Claude MCP bridge (spec
// 070926_claude-mcp-bridge.md, milestone 1) — real MCP client ⇄ scripts/mcp-server.mjs ⇄
// real src/lib/mcp-bridge client acting as the editor tab. Also covers the
// multi-instance hub/proxy handoff (spec 091126_mcp-proxy.md): a second
// server on the same port must proxy through the first and take over when
// the first one's Claude quits.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket as RawWS } from "ws";
import { connectBridge, type BridgeClient, type BridgeStatus } from "@/lib/mcp-bridge";
import { registerAllNodes } from "@/nodes";
import { buildCatalogDsl } from "@/lib/ai/generate-recipe-client";
import { getGlslDocs } from "@/lib/glsl-translation";

registerAllNodes();

const REPO = process.cwd();
const PORT = "38299";
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

{
  const full = buildCatalogDsl();
  const list = buildCatalogDsl({ mode: "list" });
  check(
    "list catalog is much smaller than full",
    list.length < full.length / 8 && list.length < 20_000,
    `list ${list.length} vs full ${full.length}`
  );
  check(
    "list catalog has no param DSL",
    !list.includes(" -> ") && list.includes("point-expression (Point Expression)")
  );
  check(
    "catalog index documents y-stretch",
    list.includes("scales y about 0.5 by W/H")
  );
  check(
    "catalog index documents canvas01 Y-down vs uv01 Y-up",
    list.includes("uv01 (Gradient") && list.includes("Y-up")
  );
  const ramp = buildCatalogDsl({ types: ["color-ramp", "map-attribute"] });
  check(
    "color-ramp stops are listed as settable color_ramp",
    ramp.includes("stops:color_ramp") && !ramp.includes("stops:color_ramp~(not remotely settable)"),
    ramp.slice(0, 400)
  );
  check(
    "map-attribute curve is listed as a settable float_curve with an id-free default",
    ramp.includes('curve:float_curve=[{"x":0,"y":0},{"x":1,"y":1}]') &&
      !ramp.includes("curve:float_curve~(not remotely settable)") &&
      !ramp.includes('"id":"cp-'),
    ramp.slice(ramp.indexOf("map-attribute"), ramp.indexOf("map-attribute") + 400)
  );
  // The vetter behind set_param / recipe params / curve() channels.
  const { vetParamValue } = await import("@/engine/node-catalog");
  const curveDef = { name: "curve", type: "float_curve" as const, default: [] };
  const vetted = vetParamValue(curveDef, [{ x: 0.9, y: 2 }, { x: -1, y: 0.25 }]);
  check(
    "vetParamValue float_curve: sorts by x, clamps to 0..1, mints ids",
    vetted.ok &&
      JSON.stringify((vetted.value as { x: number; y: number }[]).map((p) => [p.x, p.y])) ===
        JSON.stringify([[0, 0.25], [0.9, 1]]) &&
      (vetted.value as { id: string }[]).every((p) => typeof p.id === "string" && p.id.length > 0),
    JSON.stringify(vetted)
  );
  check(
    "vetParamValue float_curve rejects a single point and a non-numeric one",
    !vetParamValue(curveDef, [{ x: 0, y: 0 }]).ok && !vetParamValue(curveDef, [{ x: 0, y: "a" }, { x: 1, y: 1 }]).ok
  );

// get_node_data's geometry dump: attribute names are gathered over the whole
// value and ALWAYS present, so "no attrs in the rows shown" and "no attrs at
// all" are distinguishable (2026-09-20 MCP feedback — it took three reads to
// conclude a Combine had dropped them).
{
  const { inspectSocketValue } = await import("@/engine/socket-inspect");
  const anchor = (x: number, attrs?: Record<string, number>) => ({ pos: [x, 0.5] as [number, number], ...(attrs ? { attrs } : {}) });
  const spline = {
    kind: "spline" as const,
    subpaths: [
      { closed: false, anchors: [anchor(0), anchor(0.1)] },
      { closed: false, anchors: [anchor(0.2), anchor(0.3)], groupIndex: 1 },
      { closed: true, anchors: [anchor(0.4, { heat: 1 }), anchor(0.5)], attrs: { weight: 0.3 }, driver: 0.5 },
    ],
  };
  const truncated = inspectSocketValue(spline, 2) as Record<string, unknown>;
  check(
    "spline inspect reports attrNames from beyond the shown rows",
    truncated.truncated === true &&
      JSON.stringify(truncated.attrNames) === '["heat"]' &&
      JSON.stringify(truncated.subpathAttrNames) === '["weight"]' &&
      truncated.groupTaggedSubpaths === 1 &&
      truncated.drivenSubpaths === 1,
    JSON.stringify(truncated)
  );
  const bare = inspectSocketValue({ kind: "spline", subpaths: [{ closed: false, anchors: [anchor(0), anchor(1)] }] }) as Record<string, unknown>;
  check(
    "spline inspect says [] when no attrs exist anywhere",
    JSON.stringify(bare.attrNames) === "[]" && JSON.stringify(bare.subpathAttrNames) === "[]" && bare.groupTaggedSubpaths === 0
  );
  const pts = inspectSocketValue({ kind: "points", count: 1, positions: new Float32Array([0.5, 0.5]) } as never) as Record<string, unknown>;
  check("points inspect always carries attrNames", JSON.stringify(pts.attrNames) === "[]", JSON.stringify(pts));
}

// Source tools at the paired editor's version (the source reader is pure
// node:fs + git + fetch — exercised directly, no bridge). The tar reader
// must cope with both long-name encodings a producer may use: pax `x`
// headers (bsdtar, git archive, GitHub tarballs) and GNU `L` entries.
{
  const { createSourceReader, readTar } = await import("./mcp-source.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const head = readTar(
    execFileSync("git", ["archive", "--format=tar", "HEAD", "--", "src/engine/coerce.ts"], { maxBuffer: 1 << 26 })
  );
  check(
    "readTar reads a git archive (pax global header skipped)",
    head.size === 1 && (head.get("src/engine/coerce.ts") ?? "").includes("export function coerceValue"),
    [...head.keys()].join(",")
  );
  const dir = mkdtempSync(pathMod.join(tmpdir(), "tb-tar-"));
  try {
    const deep = pathMod.join(dir, "a".repeat(60), "b".repeat(60));
    mkdirSync(deep, { recursive: true });
    writeFileSync(pathMod.join(deep, "long.ts"), "const long = 1;\n");
    for (const fmt of ["pax", "gnu"]) {
      let tar: Buffer | null = null;
      try {
        // COPYFILE_DISABLE: macOS bsdtar otherwise adds AppleDouble `._long.ts`
        // metadata entries beside the file.
        tar = execFileSync("tar", ["--format", fmt, "-cf", "-", "-C", dir, "."], {
          maxBuffer: 1 << 24,
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        });
      } catch {
        // this tar can't emit that format — skip, the other one covers it
      }
      if (!tar) continue;
      const got = readTar(tar, { keep: (rel) => rel.endsWith("/long.ts"), strip: 1 });
      const key = [...got.keys()][0] ?? "";
      check(
        `readTar decodes a >100-char path in ${fmt} format`,
        got.size === 1 && key.endsWith("/long.ts") && key.length > 100 && got.get(key) === "const long = 1;\n",
        key
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const reader = createSourceReader();
  check("skewRef: same version / junk / traversal → local", reader.skewRef(reader.localVersion) === null && reader.skewRef("1.0.0/../x") === null && reader.skewRef("e2e") === null);
  check("skewRef: a different release is a ref", reader.skewRef("0.0.1") === "0.0.1");
  // A real older tag. Its tree comes from local git when the tag is fetched,
  // GitHub otherwise; either way the header must name THAT version, and the
  // local-fallback wording only when neither source answered.
  const skewed = await reader.searchSource({ pattern: "splineSelfMerge", glob: "*.ts", appVersion: "0.5.7" });
  const skewHead = skewed.text?.split("\n")[0] ?? "";
  const tree = await reader.treeFor("0.5.7");
  check(
    tree
      ? `search_source at a skewed version searches the v0.5.7 tag (${tree.source})`
      : "search_source at an unreachable tag falls back to local with a note",
    tree
      ? skewHead.includes("Search ran on the v0.5.7 tag") && (skewed.text ?? "").includes("spline-merge.ts")
      : skewHead.includes("LOCAL checkout") && skewHead.includes("v0.5.7"),
    skewHead
  );
  if (tree) {
    const node = await reader.getNodeSource({ type: "spline-merge", appVersion: "0.5.7" });
    check(
      "get_node_source at a skewed version reads the tag's tree",
      (node.text ?? "").includes("showing source from the v0.5.7 tag") && (node.text ?? "").includes("splineSelfMerge"),
      (node.text ?? node.error ?? "").split("\n").slice(0, 5).join(" | ")
    );
  }
  const same = await reader.searchSource({ pattern: "splineSelfMerge", glob: "*.ts", appVersion: reader.localVersion });
  check("search_source at the local version carries no version note", !(same.text ?? "").includes("Paired editor") && !(same.text ?? "").includes("Search ran on"), (same.text ?? "").split("\n")[0]);
}

  check(
    "full catalog carries NodeFacts slots (Grid writes ix/iy/cellW/cellH)",
    full.includes("# writes: attr:ix, attr:iy, attr:cellW, attr:cellH") && full.includes("# space: ") && full.includes("# ! "),
  );
  const xf = buildCatalogDsl({ types: ["transform"] });
  check(
    "transform space enum includes Canvas/Source labels",
    xf.includes("global=Canvas") && xf.includes("local=Source"),
    xf.slice(0, 500)
  );
  check(
    "types= omits the repeating space/flags preamble",
    !xf.includes("Socket spaces by type") && !xf.startsWith("# "),
    xf.slice(0, 200)
  );
  const spline = buildCatalogDsl({ category: "spline" });
  check(
    "category=spline is full DSL for that category",
    spline.includes("circle (Circle)") &&
      spline.includes(" -> ") &&
      !spline.includes("point-expression (Point Expression)")
  );
  check(
    "spline catalog includes Taper Spline",
    spline.includes("taper-spline (Taper Spline)")
  );
  const few = buildCatalogDsl({ types: ["circle", "repeat"] });
  check(
    "types= fetches full DSL for just those nodes",
    few.includes("circle (Circle)") &&
      few.includes("repeat (Repeat)") &&
      few.includes(" -> ") &&
      !few.includes("point-expression")
  );
  try {
    buildCatalogDsl({ category: "widgets" });
    check("unknown category throws", false);
  } catch (e) {
    check(
      "unknown category throws",
      /Unknown categor/.test((e as Error).message) &&
        (e as Error).message.includes("spline")
    );
  }
}

function textOf(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content;
  return c?.find((b) => b.type === "text")?.text ?? "";
}
function isError(r: unknown): boolean {
  return !!(r as { isError?: boolean }).isError;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- boot the server + MCP client ---
const transport = new StdioClientTransport({
  command: "node",
  args: ["scripts/mcp-server.mjs"],
  cwd: REPO,
  env: { ...process.env, TOOLBOX_MCP_PORT: PORT } as Record<string, string>,
});
const client = new Client({ name: "e2e-test", version: "0.0.0" });
// The second server (3d below) — declared here so the bail-out can reach it.
let client2: Client | null = null;
// However this script dies, take the spawned servers with it — an orphaned
// server squats the port and poisons the next run.
const bail = (e: unknown) => {
  console.error("FAIL", e);
  void Promise.allSettled([client.close(), client2?.close()]).finally(() => process.exit(1));
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);
await client.connect(transport);

const EXPECTED_TOOLS = [
  "compare_renders",
  "edit_group",
  "get_catalog",
  "get_glsl_docs",
  "get_graph",
  "get_keyframes",
  "get_node_data",
  "get_node_source",
  "get_perf",
  "get_perf_frame",
  "get_recent_edits",
  "get_shader_errors",
  "get_status",
  "insert_recipe",
  "plan_glsl_translation",
  "read_source",
  "screenshot",
  "screenshot_strip",
  "search_source",
  "set_keyframes",
  "set_param",
  "set_perf_capture",
  "tidy",
  "transport",
  "validate_expression",
];
const tools = await client.listTools();
check(
  "tools listed",
  tools.tools.map((t) => t.name).sort().join(",") === EXPECTED_TOOLS.join(","),
  tools.tools.map((t) => t.name).join(",")
);
{
  const insert = tools.tools.find((t) => t.name === "insert_recipe");
  const schema = insert?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  check(
    "insert_recipe schema lists replace_output, recipes and dry_run",
    !!schema?.properties?.replace_output && !!schema?.properties?.recipes && !!schema?.properties?.dry_run,
    JSON.stringify(schema?.properties ? Object.keys(schema.properties) : schema)
  );
  const edit = tools.tools.find((t) => t.name === "edit_group");
  const editProps = (edit?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  check("edit_group schema lists dry_run", !!editProps?.dry_run, JSON.stringify(editProps ? Object.keys(editProps) : editProps));
  const sp = tools.tools.find((t) => t.name === "set_param");
  check(
    "set_param docstring documents float_curve [{x, y}] and the rev bump",
    !!sp?.description?.includes("float_curve") && !!sp?.description?.includes("[{x, y}]") && !!sp?.description?.includes("bumps `rev`"),
    (sp?.description ?? "").slice(0, 300)
  );
  const nd = tools.tools.find((t) => t.name === "get_node_data");
  check(
    "get_node_data docstring says attrNames is always present",
    !!nd?.description?.includes("ALWAYS") && !!nd?.description?.includes("subpathAttrNames"),
    (nd?.description ?? "").slice(0, 300)
  );
  check(
    "edit_group docstring shows a literal JSON op",
    !!edit?.description?.includes('"op": "set_param"'),
    (edit?.description ?? "").slice(0, 400)
  );
  check(
    "edit_group docstring returns add_node ids",
    !!edit?.description?.includes("add_node / duplicate_node local id"),
    (edit?.description ?? "").slice(0, 500)
  );
  const shot = tools.tools.find((t) => t.name === "screenshot");
  check(
    "screenshot docstring accepts nodeId:aux:image",
    !!shot?.description?.includes("aux:<name>") && !!shot?.description?.includes("aux:image"),
    (shot?.description ?? "").slice(0, 400)
  );
  check(
    "every tool is tagged [toolbox] for one-search loading",
    tools.tools.every((t) => (t.description ?? "").includes("[toolbox]")),
    tools.tools.filter((t) => !(t.description ?? "").includes("[toolbox]")).map((t) => t.name).join(",")
  );
  const editSchema = edit?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  check(
    "edit_group schema lists verbosity",
    !!editSchema?.properties?.verbosity,
    JSON.stringify(editSchema?.properties ? Object.keys(editSchema.properties) : editSchema)
  );
  const gg = tools.tools.find((t) => t.name === "get_graph");
  const ggSchema = gg?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  check(
    "get_graph schema lists since",
    !!ggSchema?.properties?.since,
    JSON.stringify(ggSchema?.properties ? Object.keys(ggSchema.properties) : ggSchema)
  );
}

// --- 0. source tools work with NO editor connected (they read the checkout,
//        not the bridge) ---
const src1 = await client.callTool({ name: "get_node_source", arguments: { type: "spline-merge" } });
check(
  "get_node_source reads a node def + lists engine imports",
  !isError(src1) &&
    textOf(src1).includes("src/nodes/effect/spline-merge.ts") &&
    textOf(src1).includes("engine imports:") &&
    textOf(src1).includes("splineSelfMerge"),
  textOf(src1).split("\n")[0]
);
const src2 = await client.callTool({ name: "get_node_source", arguments: { type: "spline-merg" } });
check("get_node_source suggests near-misses on a typo", isError(src2) && textOf(src2).includes("spline-merge"), textOf(src2).slice(0, 70));
const src3 = await client.callTool({ name: "read_source", arguments: { path: "src/engine/coerce.ts", start: 1, end: 3 } });
check("read_source returns a line-numbered range", !isError(src3) && /\n\s*1\t/.test(textOf(src3)) && !/\n\s*4\t/.test(textOf(src3)), textOf(src3).split("\n")[0]);
const src4 = await client.callTool({ name: "read_source", arguments: { path: "../../../etc/passwd" } });
check("read_source rejects path traversal", isError(src4) && textOf(src4).includes("outside the readable scope"));
const src5 = await client.callTool({ name: "read_source", arguments: { path: "src/components/effects/EffectsApp.tsx" } });
check("read_source rejects out-of-scope files", isError(src5) && textOf(src5).includes("outside the readable scope"));
const src6 = await client.callTool({ name: "search_source", arguments: { pattern: "splineSelfMerge", glob: "*.ts" } });
check(
  "search_source finds definitions + usages",
  !isError(src6) && textOf(src6).includes("spline-boolean.ts") && textOf(src6).includes("spline-merge.ts"),
  textOf(src6).split("\n").find((l) => l.startsWith("//")) ?? ""
);

// --- 1. no editor connected → friendly error ---
const r1 = await client.callTool({ name: "get_status", arguments: {} });
check("no-editor error", isError(r1) && textOf(r1).includes("No Toolbox editor"), textOf(r1).slice(0, 60));

// --- 1b. CSWSH / rogue-client hardening (a browser drive-by can't complete the
//         handshake; a client that doesn't echo the pairing code can't pair) ---
{
  // (a) A cross-origin handshake (what a malicious web page sends — the browser
  //     forces the Origin header) is rejected before it ever opens.
  const rogue = new RawWS(`ws://127.0.0.1:${PORT}`, {
    headers: { origin: "https://evil.example" },
  });
  let opened = false;
  rogue.on("open", () => {
    opened = true;
  });
  await new Promise((resolve) => {
    rogue.on("error", () => resolve(null)); // handshake refused → error, no open
    rogue.on("unexpected-response", () => resolve(null));
    setTimeout(resolve, 400);
  });
  check("cross-origin WS handshake rejected", !opened);
  try {
    rogue.close();
  } catch {
    /* already refused */
  }

  // (a2) The peer path is for other toolbox-mcp processes only. A browser
  //      page — even a loopback one that the editor path would admit — always
  //      carries an Origin, so it must be refused there.
  const roguePeer = new RawWS(`ws://127.0.0.1:${PORT}/peer`, {
    headers: { origin: "http://localhost:3000" },
  });
  let peerOpened = false;
  roguePeer.on("open", () => {
    peerOpened = true;
  });
  await new Promise((resolve) => {
    roguePeer.on("error", () => resolve(null));
    roguePeer.on("unexpected-response", () => resolve(null));
    setTimeout(resolve, 400);
  });
  check("peer path rejects a browser Origin", !peerOpened);
  try {
    roguePeer.close();
  } catch {
    /* already refused */
  }

  // (b) A same-origin-absent client (allowed to connect) that echoes the WRONG
  //     pairing code must NOT become paired — get_status still errors.
  const noecho = new RawWS(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => {
    noecho.on("open", resolve);
    noecho.on("error", reject);
    setTimeout(() => reject(new Error("rogue connect timeout")), 2000);
  });
  await new Promise((resolve) => {
    noecho.on("message", () => resolve(null)); // wait for the hello frame
    setTimeout(resolve, 400);
  });
  noecho.send(JSON.stringify({ type: "pair", ok: true, code: "0000", appVersion: "rogue" }));
  await new Promise((r) => setTimeout(r, 150));
  const rWrong = await client.callTool({ name: "get_status", arguments: {} });
  check(
    "wrong pairing code does not pair",
    isError(rWrong) && textOf(rWrong).includes("pairing isn't confirmed"),
    textOf(rWrong).slice(0, 60)
  );
  noecho.close();
  await new Promise((r) => setTimeout(r, 200)); // let the slot free before the real editor connects
}

// --- 2. editor connects but pairing NOT confirmed → pairing error ---
const statuses: BridgeStatus[] = [];
// 1×1 opaque black PNG — stands in for the real canvas capture.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const bridge: BridgeClient = connectBridge({
  url: `ws://127.0.0.1:${PORT}`,
  onStatus: (s) => statuses.push(s),
  getHandlers: () => ({
    get_status: () => ({ projectName: "E2E Test", fps: 60, frame: 12, playing: false }),
    get_catalog: (args) =>
      buildCatalogDsl({
        mode: args.mode === "full" ? "full" : args.mode === "list" ? "list" : undefined,
        category: args.category as string | string[] | undefined,
        types: args.types as string | string[] | undefined,
      }),
    get_graph: ({ scope, verbosity, params }) => ({
      name: scope ?? "root",
      nodes: [],
      edges: [],
      verbosity,
      params,
    }),
    get_recent_edits: ({ summary }) => ({
      rev: 0,
      edits: summary ? [{ rev: 0, cmd: "edit_group", summary, status: "ok" }] : [],
    }),
    screenshot: ({ maxSize }) => ({
      kind: "image",
      mimeType: "image/png",
      base64: TINY_PNG,
      width: Number(maxSize) || 1,
      height: 1,
      frame: 7,
    }),
    insert_recipe: ({ recipe, connect, scope, replace_output, dry_run }) => {
      if ((recipe as { name?: string }).name === "echo") {
        return { ok: true, connect, scope, replace_output, dry_run, ids: { a: "n-1" } };
      }
      throw new Error("Recipe not applied — fix these and retry:\n- UNKNOWN_TYPE example");
    },
    edit_group: ({ groupId, ops, dry_run }) => ({
      ok: true,
      groupId,
      applied: (ops as unknown[]).length,
      dry_run,
    }),
    transport: ({ action }) => ({ ok: true, action, playing: action === "play" }),
    tidy: ({ nodes, scope }) => ({ ok: true, moved: Array.isArray(nodes) ? nodes.length : 0, scope: scope ?? "current" }),
    screenshot_strip: ({ frames }) => ({
      kind: "image",
      mimeType: "image/png",
      base64: TINY_PNG,
      width: 300,
      height: 100,
      frames: frames ?? [0, 30, 60],
      grid: { cols: 3, rows: 1 },
    }),
    set_keyframes: ({ param, keys }) => ({
      ok: true,
      param,
      animated: true,
      frames: (keys as { frame: number }[]).map((k) => k.frame),
    }),
    // Perf tools (spec 080726) — echo the args so the checks below can prove
    // optional numbers and enums survive the JSON hop rather than arriving
    // as undefined or strings. The collector's own behaviour is covered by
    // check-profiler.mts.
    set_perf_capture: ({ level, frames }) => ({ ok: true, level, frames }),
    get_perf: ({ frames, top, groupBy }) => ({
      level: 2,
      frames: 120,
      echo: { frames, top, groupBy },
      poisonRoots: [{ id: "text-1", type: "text", downstreamMsPerFrame: 14.2 }],
    }),
    get_perf_frame: ({ seq }) => ({ seq, nodes: [{ id: "n1", ms: 1.5, depth: 0 }] }),
    get_shader_errors: ({ nodeId }) => ({
      compiled: 1,
      failed: 1,
      nodes: [
        {
          nodeId: nodeId ?? "glsl-1",
          type: "glsl-expression",
          ok: false,
          error: "Shader compile failed: ERROR: 0:14: 'foo' : undeclared identifier",
          preludeLines: 13,
        },
      ],
    }),
    get_node_data: ({ nodeId, limit, socket }) => ({
      nodeId,
      limit,
      socket,
      kind: "points",
      count: 0,
    }),
    // Graph → GLSL (091626): the real doc bundle; the planner itself is
    // covered by check-glsl-translation, so echo the args here.
    get_glsl_docs: (args) =>
      getGlslDocs({
        slugs: args.slugs as string[] | string | undefined,
        types: args.types as string[] | string | undefined,
      }),
    plan_glsl_translation: ({ target, maxInputs }) => ({
      target: { id: target ?? "selected", handle: "out", type: "threshold" },
      region: ["thr"],
      maxInputs,
      docs: ["conventions", "fusion", "parity"],
    }),
    compare_renders: ({ a, b, frames }) => ({
      kind: "compare",
      mimeType: "image/png",
      base64: TINY_PNG,
      width: 300,
      height: 100,
      frames: frames ?? [0],
      grid: { cols: 3, rows: (frames as number[] | undefined)?.length ?? 1 },
      a,
      b,
      overall: "close",
      metrics: [{ frame: 0, meanAbs: 0.02, p95Abs: 0.1, alphaMeanAbs: 0, overThreshold: 0.1, compared: 1, worstBox: null, verdict: "close" }],
      summary: `A = ${a} · B = ${b}\nf0: CLOSE — meanAbs 0.0200`,
    }),
  }),
  isCodeTrusted: () => false,
  appVersion: "e2e",
});
await waitFor(() => statuses.some((s) => s.state === "pairing"));
const pairingCode = statuses.find((s) => s.state === "pairing")!;
check("pairing prompt shows a 4-digit code", /^\d{4}$/.test((pairingCode as { code: string }).code));

const r2 = await client.callTool({ name: "get_status", arguments: {} });
check("unpaired error", isError(r2) && textOf(r2).includes("pairing isn't confirmed"), textOf(r2).slice(0, 60));

// --- 3. confirm pairing → tools work ---
bridge.confirmPairing();
await waitFor(() => statuses.some((s) => s.state === "connected"));
// The connected status must identify the MCP client behind the server: the
// initialize-handshake clientInfo plus the spawning process (us — the server
// is our direct child, so its reported pid is this process).
{
  const conn = statuses.find((s) => s.state === "connected") as Extract<
    BridgeStatus,
    { state: "connected" }
  >;
  check(
    "connected status carries the MCP client identity",
    conn.client?.app === "e2e-test" &&
      conn.client?.appVersion === "0.0.0" &&
      conn.client?.pid === process.pid &&
      typeof conn.client?.cwd === "string",
    JSON.stringify(conn.client)
  );
}
const r3 = await client.callTool({ name: "get_status", arguments: {} });
const status = JSON.parse(textOf(r3));
check("get_status round-trips", !isError(r3) && status.projectName === "E2E Test" && status.frame === 12);

{
  const rec = await client.callTool({
    name: "get_recent_edits",
    arguments: { summary: "add pixels" },
  });
  const j = isError(rec) ? {} : JSON.parse(textOf(rec));
  check(
    "get_recent_edits round-trips summary filter",
    !isError(rec) && j.edits?.[0]?.summary === "add pixels",
    textOf(rec).slice(0, 120)
  );
}

const r4 = await client.callTool({ name: "get_catalog", arguments: {} });
check(
  "get_catalog default is a compact index",
  !isError(r4) &&
    textOf(r4).includes("point-expression (Point Expression)") &&
    !textOf(r4).includes(" -> "),
  `${textOf(r4).length} chars`
);
{
  const dsl = textOf(r4);
  check(
    "get_catalog lists Repeat compound zone",
    dsl.includes("repeat (Repeat)"),
    dsl.includes("repeat") ? "present" : "missing"
  );
  check(
    "get_catalog lists For Each compound zone",
    dsl.includes("foreach (For Each Element)"),
    dsl.includes("foreach") ? "present" : "missing"
  );
  check(
    "get_catalog index documents y-stretch",
    dsl.includes("scales y about 0.5 by W/H"),
    dsl.split("\n").slice(0, 3).join(" | ")
  );
}
const r4b = await client.callTool({
  name: "get_catalog",
  arguments: { types: ["repeat"] },
});
check(
  "get_catalog types= returns full DSL",
  !isError(r4b) && textOf(r4b).includes("repeat (Repeat)") && textOf(r4b).includes(" -> "),
  `${textOf(r4b).length} chars`
);

const r4c = await client.callTool({
  name: "get_catalog",
  arguments: { types: ["transform"] },
});
check(
  "get_catalog transform space enum includes Canvas/Source labels",
  !isError(r4c) &&
    textOf(r4c).includes("global=Canvas") &&
    textOf(r4c).includes("local=Source"),
  textOf(r4c).slice(0, 400)
);

// --- 3b. milestone 2-4 tools marshal correctly ---
const rg = await client.callTool({ name: "get_graph", arguments: { scope: "layer-x" } });
check("get_graph forwards scope", !isError(rg) && JSON.parse(textOf(rg)).name === "layer-x");
const rgIds = await client.callTool({
  name: "get_graph",
  arguments: { scope: "layer-x", verbosity: "ids", params: "non_default" },
});
{
  const j = isError(rgIds) ? {} : JSON.parse(textOf(rgIds));
  check(
    "get_graph forwards verbosity + params",
    !isError(rgIds) && j.verbosity === "ids" && j.params === "non_default",
    textOf(rgIds)
  );
}

const rs = await client.callTool({ name: "screenshot", arguments: { maxSize: 512 } });
const imgBlock = (rs as { content: { type: string; data?: string; mimeType?: string }[] }).content.find(
  (b) => b.type === "image"
);
check(
  "screenshot returns MCP image content",
  !isError(rs) && !!imgBlock && imgBlock.data === TINY_PNG && imgBlock.mimeType === "image/png",
  textOf(rs)
);

const rt = await client.callTool({ name: "transport", arguments: { action: "play" } });
check("transport round-trips", !isError(rt) && JSON.parse(textOf(rt)).playing === true);

// --- 3c. perf tools (spec 080726_perf-profiler.md M2) ---
const rpc = await client.callTool({
  name: "set_perf_capture",
  arguments: { level: 2, frames: 300 },
});
{
  const j = isError(rpc) ? {} : JSON.parse(textOf(rpc));
  check(
    "set_perf_capture forwards level + frames as numbers",
    !isError(rpc) && j.level === 2 && j.frames === 300,
    textOf(rpc)
  );
}
// Omitted optionals must arrive as undefined, not "undefined" — the handler
// distinguishes "not passed" (use the default) from an explicit 0.
const rpcBare = await client.callTool({ name: "set_perf_capture", arguments: {} });
{
  const j = isError(rpcBare) ? {} : JSON.parse(textOf(rpcBare));
  check(
    "set_perf_capture omits absent optionals",
    !isError(rpcBare) && !("level" in j) && !("frames" in j),
    textOf(rpcBare)
  );
}
const rp = await client.callTool({
  name: "get_perf",
  arguments: { frames: 60, top: 5, groupBy: "type" },
});
{
  const j = isError(rp) ? {} : JSON.parse(textOf(rp));
  check(
    "get_perf forwards frames/top/groupBy",
    !isError(rp) &&
      j.echo?.frames === 60 &&
      j.echo?.top === 5 &&
      j.echo?.groupBy === "type",
    textOf(rp)
  );
  check(
    "get_perf carries the poisoning report",
    !isError(rp) && j.poisonRoots?.[0]?.downstreamMsPerFrame === 14.2,
    textOf(rp).slice(0, 80)
  );
}
const rpf = await client.callTool({ name: "get_perf_frame", arguments: { seq: 42 } });
check(
  "get_perf_frame forwards seq",
  !isError(rpf) && JSON.parse(textOf(rpf)).seq === 42,
  textOf(rpf)
);
const rse = await client.callTool({
  name: "get_shader_errors",
  arguments: { nodeId: "glsl-1" },
});
check(
  "get_shader_errors forwards nodeId",
  !isError(rse) &&
    JSON.parse(textOf(rse)).nodes?.[0]?.nodeId === "glsl-1" &&
    JSON.parse(textOf(rse)).failed === 1,
  textOf(rse)
);
// Graph → GLSL tools (091626): docs come back as markdown with the core
// three leading and missing slugs named; the plan forwards its args.
{
  const rd = await client.callTool({ name: "get_glsl_docs", arguments: {} });
  check(
    "get_glsl_docs returns the core docs with conventions first",
    !isError(rd) && textOf(rd).startsWith("## conventions") && textOf(rd).includes("## parity"),
    textOf(rd).slice(0, 80)
  );
  const rdMiss = await client.callTool({
    name: "get_glsl_docs",
    arguments: { slugs: ["conventions", "nodes/nope"] },
  });
  check(
    "get_glsl_docs names a missing slug instead of dropping it",
    !isError(rdMiss) && textOf(rdMiss).includes("No doc for: nodes/nope"),
    textOf(rdMiss).slice(-200)
  );
  const rp = await client.callTool({
    name: "plan_glsl_translation",
    arguments: { target: "thr-1", maxInputs: 2 },
  });
  const plan = isError(rp) ? {} : JSON.parse(textOf(rp));
  check(
    "plan_glsl_translation forwards target + maxInputs",
    !isError(rp) && plan.target?.id === "thr-1" && plan.maxInputs === 2,
    textOf(rp).slice(0, 160)
  );
  const rc = await client.callTool({
    name: "compare_renders",
    arguments: { a: "thr-1", b: "glsl-1", frames: [0, 30] },
  });
  const cmpImg = (rc as { content: { type: string; data?: string }[] }).content.find((b) => b.type === "image");
  check(
    "compare_renders marshals as image + metrics text",
    !isError(rc) && !!cmpImg && textOf(rc).includes("CLOSE") && textOf(rc).includes("[0, 30]") && textOf(rc).includes("3×2"),
    textOf(rc)
  );
}

// `seq` is required by the schema — a missing one must fail at the server,
// never reach the editor as NaN.
const rpfBad = await client.callTool({ name: "get_perf_frame", arguments: {} });
check("get_perf_frame rejects a missing seq", isError(rpfBad), textOf(rpfBad).slice(0, 80));

const rstrip = await client.callTool({
  name: "screenshot_strip",
  arguments: { frames: [0, 15, 30] },
});
const stripImg = (rstrip as { content: { type: string; data?: string }[] }).content.find(
  (b) => b.type === "image"
);
check(
  "screenshot_strip returns labelled grid image",
  !isError(rstrip) && !!stripImg && textOf(rstrip).includes("[0, 15, 30]"),
  textOf(rstrip)
);

const rk = await client.callTool({
  name: "set_keyframes",
  arguments: {
    nodeId: "n1",
    param: "opacity",
    keys: [
      { frame: 0, value: 0, easing: "easeOutCubic" },
      { frame: 24, value: 1 },
    ],
  },
});
check(
  "set_keyframes round-trips typed keys",
  !isError(rk) && JSON.parse(textOf(rk)).frames.join(",") === "0,24",
  textOf(rk)
);

const ri = await client.callTool({
  name: "insert_recipe",
  arguments: { recipe: { name: "x", nodes: [], outputs: [] } },
});
check(
  "insert_recipe surfaces validation errors as tool errors",
  isError(ri) && textOf(ri).includes("UNKNOWN_TYPE example"),
  textOf(ri).slice(0, 60)
);
const riEcho = await client.callTool({
  name: "insert_recipe",
  arguments: {
    recipe: { name: "echo" },
    connect: true,
    replace_output: true,
    scope: "parent",
  },
});
{
  const j = isError(riEcho) ? {} : JSON.parse(textOf(riEcho));
  check(
    "insert_recipe forwards replace_output and returns ids",
    !isError(riEcho) && j.replace_output === true && j.ids?.a === "n-1" && !("dry_run" in j),
    textOf(riEcho)
  );
}
{
  const riDry = await client.callTool({
    name: "insert_recipe",
    arguments: { recipe: { name: "echo" }, dry_run: true },
  });
  const j = isError(riDry) ? {} : JSON.parse(textOf(riDry));
  check("insert_recipe forwards dry_run", !isError(riDry) && j.dry_run === true, textOf(riDry));
  const reDry = await client.callTool({
    name: "edit_group",
    arguments: { groupId: "g-1", ops: [{ op: "set_param", node: "n", param: "count", value: 3 }], dry_run: true },
  });
  const k = isError(reDry) ? {} : JSON.parse(textOf(reDry));
  check(
    "edit_group forwards dry_run and ops",
    !isError(reDry) && k.dry_run === true && k.groupId === "g-1" && k.applied === 1,
    textOf(reDry)
  );
}
const rnd = await client.callTool({
  name: "get_node_data",
  arguments: { nodeId: "circ-1", limit: 8, socket: "out" },
});
{
  const j = isError(rnd) ? {} : JSON.parse(textOf(rnd));
  check(
    "get_node_data forwards nodeId/limit/socket",
    !isError(rnd) && j.nodeId === "circ-1" && j.limit === 8 && j.socket === "out",
    textOf(rnd)
  );
}

// --- 3d. a SECOND server on the same port proxies through the first (spec
//         091126_mcp-proxy.md). Claude Desktop spawns two lanes and a Claude
//         Code session adds a third — every one of them must keep working
//         through the one editor socket. ---
const transport2 = new StdioClientTransport({
  command: "node",
  args: ["scripts/mcp-server.mjs"],
  cwd: REPO,
  env: { ...process.env, TOOLBOX_MCP_PORT: PORT } as Record<string, string>,
});
client2 = new Client({ name: "e2e-test-2", version: "0.0.0" });
await client2.connect(transport2);
type Connected = Extract<BridgeStatus, { state: "connected" }>;
{
  const tools2 = await client2.listTools();
  check(
    "proxy instance lists the same tools",
    tools2.tools.map((t) => t.name).sort().join(",") === EXPECTED_TOOLS.join(","),
    tools2.tools.map((t) => t.name).join(",")
  );
  // The hub tells the editor who else is riding the bridge (menu tooltip),
  // and the proxy's identity fills in once its own initialize handshake lands.
  await waitFor(() =>
    statuses.some(
      (s) => s.state === "connected" && !!s.client?.peers?.some((p) => p.app === "e2e-test-2")
    )
  );
  const withPeer = [...statuses].reverse().find((s) => s.state === "connected") as Connected;
  check(
    "editor status lists the proxy as a peer",
    withPeer.client?.peers?.length === 1 && withPeer.client.peers[0].pid === process.pid,
    JSON.stringify(withPeer.client?.peers)
  );
  const viaProxy = await client2.callTool({ name: "get_status", arguments: {} });
  check(
    "tool call via the proxy reaches the editor",
    !isError(viaProxy) && JSON.parse(textOf(viaProxy)).projectName === "E2E Test",
    textOf(viaProxy).slice(0, 80)
  );
  const viaProxyImg = await client2.callTool({ name: "screenshot", arguments: { maxSize: 256 } });
  const img2 = (viaProxyImg as { content: { type: string; data?: string }[] }).content.find(
    (b) => b.type === "image"
  );
  check(
    "image content survives the proxy hop",
    !isError(viaProxyImg) && img2?.data === TINY_PNG,
    textOf(viaProxyImg)
  );
  const viaProxyErr = await client2.callTool({
    name: "insert_recipe",
    arguments: { recipe: { name: "x", nodes: [], outputs: [] } },
  });
  check(
    "editor errors survive the proxy hop",
    isError(viaProxyErr) && textOf(viaProxyErr).includes("UNKNOWN_TYPE example"),
    textOf(viaProxyErr).slice(0, 60)
  );
  const srcViaProxy = await client2.callTool({ name: "get_node_source", arguments: { type: "spline-merge" } });
  check(
    "source tools stay local on a proxy",
    !isError(srcViaProxy) && textOf(srcViaProxy).includes("splineSelfMerge"),
    textOf(srcViaProxy).split("\n")[0]
  );
}

// --- 3e. the hub's Claude quits → the proxy is promoted to hub and the
//         editor re-pairs with it (a new boot means a new code, so the
//         prompt comes back — same as a server restart today). ---
{
  const before = statuses.length;
  await client.close(); // ends server 1's stdin → it exits → the port frees
  await waitFor(() => statuses.slice(before).some((s) => s.state === "pairing"), 10_000);
  const repair = statuses.slice(before).find((s) => s.state === "pairing") as Extract<
    BridgeStatus,
    { state: "pairing" }
  >;
  check("editor re-pairs with the promoted server", /^\d{4}$/.test(repair.code));
  bridge.confirmPairing();
  await waitFor(() =>
    statuses.slice(before).some((s) => s.state === "connected" && s.client?.app === "e2e-test-2")
  );
  const promoted = [...statuses].reverse().find((s) => s.state === "connected") as Connected;
  check(
    "promoted server reports its own client and no peers",
    promoted.client?.app === "e2e-test-2" && (promoted.client.peers?.length ?? 0) === 0,
    JSON.stringify(promoted.client)
  );
  const afterPromotion = await client2.callTool({ name: "get_status", arguments: {} });
  check(
    "tool call works after promotion",
    !isError(afterPromotion) && JSON.parse(textOf(afterPromotion)).frame === 12,
    textOf(afterPromotion).slice(0, 80)
  );
}

// --- 4. editor disconnects → back to friendly error ---
bridge.close();
await new Promise((r) => setTimeout(r, 200));
const r5 = await client2.callTool({ name: "get_status", arguments: {} });
check("post-disconnect error", isError(r5) && textOf(r5).includes("No Toolbox editor"));

await client2.close();
process.exit(failures ? 1 : 0);
