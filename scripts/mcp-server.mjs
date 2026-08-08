// Toolbox MCP server (spec 070926_claude-mcp-bridge.md, milestone 1).
//
// Speaks MCP over stdio to the Claude app (Claude Code / Claude Desktop) and
// hosts a localhost WebSocket that the running Toolbox editor tab connects to
// via src/lib/mcp-bridge. Tools marshal to the tab; the tab executes against
// EffectsApp state and answers. This process is stateless glue — no engine,
// no graph.
//
// Register:   claude mcp add toolbox -- node scripts/mcp-server.mjs
// or run:     npm run mcp   (prints the pairing code, waits for the editor)
//
// IMPORTANT: stdout is the MCP protocol channel — all logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createSourceReader } from "./mcp-source.mjs";

const VERSION = "0.1.0";
const PORT = Number(process.env.TOOLBOX_MCP_PORT ?? 38275);
const CMD_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 30_000; // reserved for milestone 2

// 4-digit pairing code, minted once per server boot. The editor shows the
// code it received in a confirm dialog; the user checks it against this
// stderr line. Same boot ⇒ same code, so a page reload re-pairs silently.
const PAIRING_CODE = String(Math.floor(1000 + Math.random() * 9000));

const log = (...args) => console.error("[toolbox-mcp]", ...args);

// ---------------------------------------------------------------------------
// Editor connection (one at a time; last-connected wins).
// ---------------------------------------------------------------------------
let editor = null; // { ws, paired, appVersion }
let nextId = 1;
const pending = new Map(); // id → { resolve, reject, timer }

const NOT_CONNECTED =
  "No Toolbox editor is connected. Open Toolbox and enable the bridge via " +
  `Toolbox menu → "Connect to Claude…" (pairing code ${PAIRING_CODE}).`;

function failPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

// CSWSH defense. WebSocket handshakes are exempt from the same-origin policy,
// so a plain loopback bind isn't enough: any web page the user visits can
// `new WebSocket("ws://127.0.0.1:38275")` and drive the editor. But browsers
// ALWAYS attach an `Origin` header to the handshake and a page can't forge it,
// so we reject any handshake whose Origin is a non-loopback web page. Absent
// Origin = a non-browser client (the CLI, the e2e harness) — no drive-by
// vector — and is allowed; a local malicious *process* is out of scope here
// (it already has code execution) and is the reason pairing also validates the
// echoed code below.
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser client (no Origin header)
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ origin }) => {
    if (isAllowedOrigin(origin)) return true;
    log(`rejected WebSocket handshake from disallowed Origin: ${origin}`);
    return false;
  },
});

wss.on("connection", (ws) => {
  if (editor) {
    // Last-connected wins — tell the old tab it's been replaced.
    try {
      editor.ws.send(JSON.stringify({ type: "replaced" }));
      editor.ws.close();
    } catch {
      // already dead
    }
    failPending("Editor connection was replaced by a new tab.");
  }
  editor = { ws, paired: false, appVersion: null };
  log("editor connected, awaiting pairing confirmation…");
  ws.send(
    JSON.stringify({ type: "hello", code: PAIRING_CODE, serverVersion: VERSION })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "pair" && msg.ok) {
      // The client must echo the exact pairing code it received in `hello`.
      // On its own this is weak (the code is in the frame we sent), but it
      // closes the "any {pair:ok} frame pairs you" foot-gun and pairs with the
      // Origin gate above: a browser drive-by can't complete the handshake at
      // all, so it never sees the code to echo.
      if (String(msg.code) !== PAIRING_CODE) {
        log("rejected pair frame with a missing/incorrect code");
        return;
      }
      editor.paired = true;
      editor.appVersion = msg.appVersion ?? "unknown";
      log(`paired with editor (app v${editor.appVersion})`);
      return;
    }
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "editor returned an error"));
    }
  });

  ws.on("close", () => {
    if (editor?.ws === ws) {
      editor = null;
      log("editor disconnected");
      failPending("Editor disconnected mid-command.");
    }
  });
  ws.on("error", () => {
    // close handler does the cleanup
  });
});

wss.on("error", (e) => {
  log(`WebSocket server error: ${e.message}`);
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} is in use — is another toolbox-mcp running?`);
    process.exit(1);
  }
});

function callEditor(cmd, args = {}, timeoutMs = CMD_TIMEOUT_MS) {
  if (!editor) return Promise.reject(new Error(NOT_CONNECTED));
  if (!editor.paired)
    return Promise.reject(
      new Error(
        "The editor is connected but pairing isn't confirmed yet — confirm " +
          `code ${PAIRING_CODE} in the Toolbox dialog.`
      )
    );
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Editor did not answer "${cmd}" within ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    editor.ws.send(JSON.stringify({ type: "cmd", id, cmd, args }));
  });
}

// ---------------------------------------------------------------------------
// MCP tools. Results marshal to text content; errors become isError results
// so the model can read and react (repair loop).
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "toolbox", version: VERSION });

// Source-reading tools (spec 071226_mcp-node-source-tools.md). These read the
// repo checkout directly — no bridge round-trip, so they work unpaired. The
// paired editor's version (when it differs from this checkout) triggers the
// GitHub-tag fallback so Claude reads the code the user is actually running.
const source = createSourceReader();
const pairedAppVersion = () => (editor?.paired ? editor.appVersion : null);
function sourceResult(r) {
  return r.error ? toolError(new Error(r.error)) : textResult(r.text);
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text", text }] };
}

function toolError(e) {
  return {
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

server.registerTool(
  "get_status",
  {
    description:
      "Current state of the connected Toolbox editor: project name, canvas " +
      "size, fps, playhead frame, playing/paused, loop length, selected node, " +
      "and the current editing scope (root or a group id).",
  },
  async () => {
    try {
      return textResult(await callEditor("get_status"));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_catalog",
  {
    description:
      "The full node catalog of the running Toolbox editor — one line per " +
      "node type in a compact DSL: `type (Name) [category] ~dyn: in " +
      "sockets -> output aux=… | settable params`, with a # description " +
      "line. Fetch once per session; it's stable while the app runs.",
  },
  async () => {
    try {
      return textResult(await callEditor("get_catalog"));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_graph",
  {
    description:
      "The current node graph as JSON: nodes (id, type, display name, " +
      "settable param values, exposed + keyframed params, and — for " +
      "dynamic-socket nodes like Merge or Point Expression — the REAL " +
      "resolved input sockets under `inputs`), edges " +
      "(\"<id>:out\"/\"<id>:aux:<name>\" → \"<id>:in:<socket>\"/" +
      "\"<id>:param:<name>\"), and the scope's boundary interface. Omit " +
      "`scope` for the root composition (the layer chain); pass a group or " +
      "layer id to see its interior. Always call this before edit_group or " +
      "set_param — node ids are minted by the editor and can't be guessed.",
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe('Group or layer node id, or "root" (default).'),
    },
  },
  async ({ scope }) => {
    try {
      return textResult(await callEditor("get_graph", { scope }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "screenshot",
  {
    description:
      "Capture the editor's rendered canvas as a PNG image — use this to " +
      "SEE the result of your changes and validate visually. Optional: " +
      "`frame` renders a specific frame (the paused editor is restored to " +
      "the user's playhead afterwards); `nodeId` previews a specific node's " +
      "output instead of the terminal; `maxSize` caps the long edge " +
      "(default 1024px). For motion, take 2–3 screenshots at " +
      "representative frames rather than many.",
    inputSchema: {
      nodeId: z.string().optional().describe("Preview this node's output."),
      frame: z.number().optional().describe("Render this frame (integer)."),
      maxSize: z.number().optional().describe("Long-edge pixel cap, 64–2048."),
    },
  },
  async (args) => {
    try {
      const r = await callEditor("screenshot", args, SCREENSHOT_TIMEOUT_MS);
      return {
        content: [
          { type: "image", data: r.base64, mimeType: r.mimeType },
          { type: "text", text: `frame ${r.frame}, ${r.width}×${r.height}` },
        ],
      };
    } catch (e) {
      return toolError(e);
    }
  }
);

const RECIPE_CONTRACT =
  "RecipeGraph shape: {name, description?, nodes:[{id, type, params?}], " +
  "edges?:[{from, to}], inputs?:[{name, from, type}], outputs:[{name, from, " +
  "type}] (at least one), exposed?:[{name, node, param}]}. Node ids are " +
  "local strings you choose. `type` strings MUST come from get_catalog. " +
  "Edge grammar — from: \"<id>:out\" | \"<id>:aux:<name>\"; to: " +
  "\"<id>:in:<socket>\" | \"<id>:param:<name>\". Set only params the " +
  "catalog lists (respect ranges/options). Allowed cross-type wires: " +
  "mask↔image, spline→mask, scalar→vec2/vec3/vec4/uv, image|mask→scalar, " +
  "audio→scalar, image↔element; anything else must match exactly. The " +
  "graph must be acyclic. Expression/Point Expression `expression` params " +
  "are JavaScript: assignments only (never `return`), declare temporaries " +
  "with let/const. Point Expression ch(\"name\", default) channels become " +
  "sliders automatically AND are wireable by name (\"<id>:in:<channelName>\"). " +
  "Merge nodes: size the stack with params.layers = [{mode, opacity}, …] " +
  "and wire ordinally — \"<id>:in:layer1\", \"<id>:in:layer2\", … " +
  "(\"<id>:in:mask1\", … for per-layer mattes); wiring layerN past the end " +
  "grows the stack.";

server.registerTool(
  "insert_recipe",
  {
    description:
      "Build and insert a new node-group into the Toolbox editor from a " +
      "RecipeGraph. Validation errors come back as the tool error — fix " +
      "them and call again. On success returns the new group's id (interior " +
      "node ids are minted at insert; call get_graph with scope=groupId " +
      "before editing further). The user sees a toast and can undo. " +
      RECIPE_CONTRACT,
    inputSchema: {
      recipe: z.record(z.string(), z.unknown()).describe("The RecipeGraph object."),
    },
  },
  async ({ recipe }) => {
    try {
      return textResult(await callEditor("insert_recipe", { recipe }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "edit_group",
  {
    description:
      "Apply a minimal patch to an existing node-group OR layer's interior " +
      "(layers are the root-level building blocks — their content is edited " +
      "the same way; a layer shell's own params like blendMode are also " +
      "settable). Call get_graph with scope=groupId first and reference " +
      "nodes by their REAL ids. " +
      "Ops (ordered): set_param{node,param,value} · add_node{id,type," +
      "params?} (fresh local id you then wire) · remove_node{node} · " +
      "add_edge{from,to} · remove_edge{from,to} · expose_param{node,param," +
      "label?} · unexpose_param{node,param} · rename_node{node,name}. Edge " +
      "grammar and param rules are the same as insert_recipe. A param " +
      "listed under `keyframed` is animated — setting its static value " +
      "does nothing. Change by exception; never rebuild what you can patch. " +
      "Validation errors return as the tool error — fix and retry.",
    inputSchema: {
      groupId: z.string().describe("The node-group or layer id."),
      ops: z.array(z.record(z.string(), z.unknown())).describe("Ordered edit operations."),
      summary: z
        .string()
        .optional()
        .describe("One short sentence shown to the user."),
    },
  },
  async (args) => {
    try {
      return textResult(await callEditor("edit_group", args));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "set_param",
  {
    description:
      "Set one settable param on any node in the project (get ids from " +
      "get_graph). Values are vetted against the param's type/range/options. " +
      "Prefer this over edit_group for single tweaks — it's the same path " +
      "the UI sliders use (undo + auto-keyframing included).",
    inputSchema: {
      nodeId: z.string(),
      param: z.string(),
      value: z.unknown().describe("New value matching the param type."),
    },
  },
  async (args) => {
    try {
      return textResult(await callEditor("set_param", args));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "screenshot_strip",
  {
    description:
      "Sample several frames and return them tiled into ONE labelled grid " +
      "image — the cheap way to judge motion. Pass explicit `frames` " +
      "(2–12), or a `start`/`end`/`every` range (defaults: 0 → loop end, " +
      "~6 samples). Each cell is labelled f<frame>. Pick the count that " +
      "represents the motion: a slow drift needs 3, a stagger burst needs " +
      "8 — don't default to many.",
    inputSchema: {
      frames: z.array(z.number()).optional().describe("Explicit frame numbers (2–12)."),
      start: z.number().optional().describe("Range start frame (default 0)."),
      end: z.number().optional().describe("Range end frame (default loop end)."),
      every: z.number().optional().describe("Sample every N frames."),
      nodeId: z.string().optional().describe("Preview this node's output."),
      maxSize: z.number().optional().describe("Long-edge cap for the WHOLE grid (default 1400)."),
    },
  },
  async (args) => {
    try {
      const r = await callEditor("screenshot_strip", args, SCREENSHOT_TIMEOUT_MS);
      return {
        content: [
          { type: "image", data: r.base64, mimeType: r.mimeType },
          {
            type: "text",
            text: `frames [${r.frames.join(", ")}] in a ${r.grid.cols}×${r.grid.rows} grid, ${r.width}×${r.height}`,
          },
        ],
      };
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_keyframes",
  {
    description:
      "Read a node's keyframe animation. With `param`: that track's keys " +
      "as {frame, value, easing}. Without: an overview — every keyed track " +
      "(param, animated, key frames) plus which params are keyframable. " +
      "Frames are fps-relative (see get_status).",
    inputSchema: {
      nodeId: z.string(),
      param: z.string().optional().describe("Omit for the whole-node overview."),
    },
  },
  async (args) => {
    try {
      return textResult(await callEditor("get_keyframes", args));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "set_keyframes",
  {
    description:
      "REPLACE a param's keyframe track. `keys` = [{frame, value, " +
      "easing?}]; values match the param's type (vetted like set_param); " +
      "easing presets: linear, easeIn/Out/InOut + Sine/Quad/Cubic, " +
      "easeInExpo, easeOutExpo, easeInBack, easeOutBack (overshoot), " +
      "easeOutBounce, easeOutElastic, hold (default easeInOutQuad; " +
      "boolean/enum params force hold). `easing` shapes the segment AFTER " +
      "its key. Empty `keys` clears the track entirely; `animated: false` " +
      "keeps keys but disables them. While a track is animated, its static " +
      "param value is ignored (wire > keyframes > static). Undo-able; the " +
      "user sees a toast.",
    inputSchema: {
      nodeId: z.string(),
      param: z.string(),
      keys: z
        .array(
          z.object({
            frame: z.number(),
            value: z.unknown(),
            easing: z.string().optional(),
          })
        )
        .describe("The full track, replacing whatever exists."),
      animated: z.boolean().optional().describe("Track enabled (default true)."),
    },
  },
  async (args) => {
    try {
      return textResult(await callEditor("set_keyframes", args));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "validate_expression",
  {
    description:
      "Compile + smoke-run a Point Expression source without touching the " +
      "graph. Catches syntax errors, strict-mode ReferenceErrors " +
      "(undeclared temps — use let/const), and `return`-style blocks. Use " +
      "before inserting/patching an expression.",
    inputSchema: {
      source: z.string().describe("The per-point JavaScript block."),
    },
  },
  async (args) => {
    try {
      return textResult(await callEditor("validate_expression", args));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "transport",
  {
    description:
      "Control playback: play, pause, or seek to a frame. Seek while " +
      "paused re-renders immediately — pair with screenshot to inspect " +
      "specific moments.",
    inputSchema: {
      action: z.enum(["play", "pause", "seek"]),
      frame: z.number().optional().describe("Target frame (seek only)."),
    },
  },
  async (args) => {
    try {
      return textResult(await callEditor("transport", args));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_node_source",
  {
    description:
      "Read the actual source of a node from the public repo — use this to " +
      "understand HOW a node works beyond its catalog summary, or to explain " +
      "to the user exactly how to build a tree. Pass a `type` from " +
      "get_catalog; returns the node's definition file (line-numbered) plus " +
      "the `@/engine/*` helpers it imports (the real math usually lives " +
      "there — follow up with read_source). Prefer get_catalog for a quick " +
      "interface check; reach here when you need behavior, not just sockets. " +
      "Cite file:line when explaining behavior to the user.",
    inputSchema: {
      type: z.string().describe("A node type string from get_catalog (e.g. \"spline-merge\")."),
    },
  },
  async ({ type }) => {
    try {
      return sourceResult(await source.getNodeSource({ type, appVersion: pairedAppVersion() }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "read_source",
  {
    description:
      "Read a file from the engine or node source (scope: src/nodes/ + " +
      "src/engine/ — where node behavior and the shared math live, e.g. " +
      "coerce.ts, types.ts, evaluator.ts, spline-boolean.ts). Line-numbered; " +
      "pass `start`/`end` (1-based, inclusive) to read a slice of a big file. " +
      "Use get_node_source first to find the right file for a node.",
    inputSchema: {
      path: z.string().describe("Repo-relative path under src/nodes/ or src/engine/."),
      start: z.number().optional().describe("First line (1-based, inclusive)."),
      end: z.number().optional().describe("Last line (1-based, inclusive)."),
    },
  },
  async ({ path, start, end }) => {
    try {
      return sourceResult(await source.readSource({ path, start, end, appVersion: pairedAppVersion() }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "search_source",
  {
    description:
      "Regex-search the engine + node source (src/nodes/ + src/engine/) and " +
      "get `path:line: text` matches — the way to FIND where something is " +
      "defined or used before reading it (a symbol, a socket type, a coercion, " +
      "a shader key). `pattern` is a JavaScript regex source; optional `glob` " +
      "filters paths (e.g. \"*.ts\", \"src/engine/*\"). Capped at 200 matches.",
    inputSchema: {
      pattern: z.string().describe("JavaScript regex source (case-sensitive)."),
      glob: z.string().optional().describe("Path filter, e.g. \"*.ts\" or \"src/engine/*\"."),
    },
  },
  async ({ pattern, glob }) => {
    try {
      return sourceResult(await source.searchSource({ pattern, glob, appVersion: pairedAppVersion() }));
    } catch (e) {
      return toolError(e);
    }
  }
);

// --- performance (spec 080726_perf-profiler.md M2) --------------------------

server.registerTool(
  "set_perf_capture",
  {
    description:
      "Arm or disarm the evaluator performance trace. Capture is OFF by " +
      "default and costs nothing until armed. Level 1 records per-node time " +
      "and WHY each node recomputed; level 2 adds data volume (point/subpath " +
      "counts), texture create/delete churn, and fingerprint size. Arming " +
      "always clears the previous trace, so the sequence is: " +
      "set_perf_capture -> drive the workload (transport play, a set_param " +
      "edit, a scrub) -> get_perf. The editor only evaluates on playback, a " +
      "param change, or a graph change — an idle editor records no frames.",
    inputSchema: {
      level: z
        .number()
        .optional()
        .describe("0 = off, 1 = timings + reasons, 2 = + volume/churn (default)."),
      frames: z
        .number()
        .optional()
        .describe("Ring size in frames (default 600, ~10s at 60fps)."),
    },
  },
  async ({ level, frames }) => {
    try {
      return textResult(await callEditor("set_perf_capture", { level, frames }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_perf",
  {
    description:
      "Aggregated performance summary of the captured frames. Returns frame " +
      "stats (mean/p50/p95/max eval ms, effective fps), a phase breakdown per " +
      "frame (flatten, topo, fingerprint, compute, post, blit, plus an " +
      "`unattributed` residual), texture churn, and the top nodes by cost — " +
      "each with p95, recompute RATE and dominant REASON (`hit`, `params`, " +
      "`input`, `unstable`, `anim`, `extras`, `cold`), plus ns-per-point where " +
      "the node emits points. Also returns `poisonRoots`: uncacheable nodes " +
      "(stable:false and friends) ranked by how much DOWNSTREAM recompute " +
      "they force — usually the most actionable number in the payload, since " +
      "a node whose reason is `input` is being dragged by an ancestor rather " +
      "than doing anything wrong itself. Pass groupBy:\"type\" to collapse " +
      "instances and see which KIND of node is expensive.",
    inputSchema: {
      frames: z
        .number()
        .optional()
        .describe("Only summarize the most recent N frames (default: all)."),
      top: z.number().optional().describe("How many nodes to return (default 20)."),
      groupBy: z
        .enum(["node", "type"])
        .optional()
        .describe('"type" collapses instances by node type.'),
    },
  },
  async ({ frames, top, groupBy }) => {
    try {
      return textResult(await callEditor("get_perf", { frames, top, groupBy }));
    } catch (e) {
      return toolError(e);
    }
  }
);

server.registerTool(
  "get_perf_frame",
  {
    description:
      "One frame's complete node list by sequence number — use it to " +
      "interrogate a spike found in get_perf's aggregate (e.g. why p95 is far " +
      "above p50). Samples tagged depth > 0 come from inside an Iterate " +
      "interior and their time is ALREADY counted in the enclosing shell's " +
      "depth-0 sample, so sum only depth-0 entries for a frame total.",
    inputSchema: {
      seq: z.number().describe("Frame sequence number, from a get_perf frame."),
    },
  },
  async ({ seq }) => {
    try {
      return textResult(await callEditor("get_perf_frame", { seq }));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ---------------------------------------------------------------------------
await server.connect(new StdioServerTransport());
log(`ready — MCP on stdio, editor bridge on ws://127.0.0.1:${PORT}`);
log(`pairing code: ${PAIRING_CODE}`);

// The MCP client (Claude app / test harness) owns this process's lifetime:
// when the stdio channel closes — clean shutdown OR client crash — exit so
// the WebSocket server releases the port instead of living on as an orphan.
server.server.onclose = () => {
  log("stdio channel closed — shutting down");
  process.exit(0);
};
process.stdin.on("end", () => {
  log("stdin ended — shutting down");
  process.exit(0);
});
