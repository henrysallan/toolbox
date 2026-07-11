// check-mcp: end-to-end check of the Claude MCP bridge (spec
// 070926_claude-mcp-bridge.md, milestone 1) — real MCP client ⇄ scripts/mcp-server.mjs ⇄
// real src/lib/mcp-bridge client acting as the editor tab.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectBridge, type BridgeClient, type BridgeStatus } from "@/lib/mcp-bridge";
import { registerAllNodes } from "@/nodes";
import { buildCatalogDsl } from "@/lib/ai/generate-recipe-client";

registerAllNodes();

const REPO = process.cwd();
const PORT = "38299";
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
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
// However this script dies, take the spawned server with it — an orphaned
// server squats the port and poisons the next run.
process.on("uncaughtException", (e) => {
  console.error("FAIL", e);
  void client.close().finally(() => process.exit(1));
});
process.on("unhandledRejection", (e) => {
  console.error("FAIL", e);
  void client.close().finally(() => process.exit(1));
});
await client.connect(transport);

const EXPECTED_TOOLS = [
  "edit_group",
  "get_catalog",
  "get_graph",
  "get_keyframes",
  "get_status",
  "insert_recipe",
  "screenshot",
  "screenshot_strip",
  "set_keyframes",
  "set_param",
  "transport",
  "validate_expression",
];
const tools = await client.listTools();
check(
  "tools listed",
  tools.tools.map((t) => t.name).sort().join(",") === EXPECTED_TOOLS.join(","),
  tools.tools.map((t) => t.name).join(",")
);

// --- 1. no editor connected → friendly error ---
const r1 = await client.callTool({ name: "get_status", arguments: {} });
check("no-editor error", isError(r1) && textOf(r1).includes("No Toolbox editor"), textOf(r1).slice(0, 60));

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
    get_catalog: () => buildCatalogDsl(),
    get_graph: ({ scope }) => ({ name: scope ?? "root", nodes: [], edges: [] }),
    screenshot: ({ maxSize }) => ({
      kind: "image",
      mimeType: "image/png",
      base64: TINY_PNG,
      width: Number(maxSize) || 1,
      height: 1,
      frame: 7,
    }),
    insert_recipe: () => {
      throw new Error("Recipe not applied — fix these and retry:\n- UNKNOWN_TYPE example");
    },
    transport: ({ action }) => ({ ok: true, action, playing: action === "play" }),
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
const r3 = await client.callTool({ name: "get_status", arguments: {} });
const status = JSON.parse(textOf(r3));
check("get_status round-trips", !isError(r3) && status.projectName === "E2E Test" && status.frame === 12);

const r4 = await client.callTool({ name: "get_catalog", arguments: {} });
check(
  "get_catalog returns the DSL",
  !isError(r4) && textOf(r4).includes("point-expression (Point Expression)"),
  `${textOf(r4).length} chars`
);

// --- 3b. milestone 2-4 tools marshal correctly ---
const rg = await client.callTool({ name: "get_graph", arguments: { scope: "layer-x" } });
check("get_graph forwards scope", !isError(rg) && JSON.parse(textOf(rg)).name === "layer-x");

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

// --- 4. editor disconnects → back to friendly error ---
bridge.close();
await new Promise((r) => setTimeout(r, 200));
const r5 = await client.callTool({ name: "get_status", arguments: {} });
check("post-disconnect error", isError(r5) && textOf(r5).includes("No Toolbox editor"));

await client.close();
process.exit(failures ? 1 : 0);
