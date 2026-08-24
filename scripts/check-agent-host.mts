// check-agent-host: end-to-end check of the assistant panel's agent host
// (spec 080826_claude-agent-panel.md, milestone 1).
//
// Spawns scripts/agent-host.mjs and connects TWO fake editor windows to it,
// each answering tool calls with different state. Proves the M1 ship gate:
// two windows get two independent sessions, and neither can see or steal the
// other's tools.
//
// This makes REAL inference calls against the user's logged-in `claude`
// binary (two short prompts), so it is not part of `npm run check`.
//
//   npx tsx scripts/check-agent-host.mts

import { spawn } from "node:child_process";
import { WebSocket as RawWS } from "ws";

const PORT = "38298";
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function waitFor(pred: () => boolean, ms = 90_000, what = "condition") {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- boot the host ---------------------------------------------------------
const host = spawn("node", ["scripts/agent-host.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, TOOLBOX_AGENT_PORT: PORT },
  stdio: ["ignore", "pipe", "pipe"],
});

// However this script dies, take the host with it — an orphan squats the port.
const killHost = () => {
  try {
    host.kill("SIGTERM");
  } catch {
    /* already gone */
  }
};
process.on("exit", killHost);
process.on("uncaughtException", (e) => {
  console.error("FAIL", e);
  killHost();
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("FAIL", e);
  killHost();
  process.exit(1);
});

let token = "";
let hostReady = false;
host.stdout.on("data", (b) => {
  for (const line of String(b).split("\n").filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      if (j.ready) {
        token = j.token;
        hostReady = true;
      }
    } catch {
      /* not the handshake line */
    }
  }
});
host.stderr.on("data", (b) => {
  if (process.env.VERBOSE) process.stderr.write(b);
});

await waitFor(() => hostReady, 10_000, "host boot");
check("host boots and prints a handshake token", !!token && token.length > 20);

// --- a fake editor window --------------------------------------------------
interface Win {
  ws: RawWS;
  name: string;
  ready: boolean;
  cmds: string[];
  events: Record<string, unknown>[];
  text: string;
  done: boolean;
  errored: string | null;
}

function openWindow(
  name: string,
  status: Record<string, unknown>,
  catalog?: string
): Promise<Win> {
  const ws = new RawWS(`ws://127.0.0.1:${PORT}`);
  const w: Win = {
    ws,
    name,
    ready: false,
    cmds: [],
    events: [],
    text: "",
    done: false,
    errored: null,
  };
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "ready") w.ready = true;
    else if (m.type === "denied") w.errored = m.reason;
    else if (m.type === "error") w.errored = m.message;
    else if (m.type === "closed") w.done = true;
    else if (m.type === "cmd") {
      // Act as the editor: answer from THIS window's state.
      w.cmds.push(m.cmd);
      const result =
        m.cmd === "get_status"
          ? status
          : m.cmd === "get_catalog" && catalog
            ? catalog
            : { ok: true };
      ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result }));
    } else if (m.type === "event") {
      w.events.push(m.message);
      const msg = m.message;
      if (msg.type === "assistant")
        for (const b of msg.message?.content ?? [])
          if (b.type === "text") w.text += b.text;
      if (msg.type === "result") w.done = true;
    }
  });
  return new Promise((resolve) => {
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          sessionKey: name,
          appVersion: "check",
        })
      );
      resolve(w);
    });
  });
}

// --- bad token is rejected -------------------------------------------------
{
  const bad = new RawWS(`ws://127.0.0.1:${PORT}`);
  let denied = false;
  bad.on("message", (raw) => {
    if (JSON.parse(String(raw)).type === "denied") denied = true;
  });
  await new Promise<void>((r) =>
    bad.on("open", () => {
      bad.send(JSON.stringify({ type: "hello", token: "wrong", sessionKey: "x" }));
      r();
    })
  );
  await waitFor(() => denied, 5000, "bad-token denial");
  check("a bad control token is rejected", denied);
  bad.close();
}

// --- two windows, two sessions --------------------------------------------
const a = await openWindow("window-A", {
  project: "ALPHA-PROJECT",
  fps: 24,
  frame: 0,
  nodes: 3,
});
const b = await openWindow("window-B", {
  project: "BETA-PROJECT",
  fps: 30,
  frame: 12,
  nodes: 9,
});
await waitFor(() => a.ready && b.ready, 10_000, "both windows ready");
check("two windows authorize independently", a.ready && b.ready);

// --- prompt window A only --------------------------------------------------
a.ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Call get_status and reply with ONLY the project name, nothing else.",
  })
);

await waitFor(() => a.done, 120_000, "window A turn to finish");

check("window A's tool call reached window A", a.cmds.includes("get_status"), a.cmds.join(","));
check(
  "window A saw its OWN state",
  a.text.includes("ALPHA-PROJECT"),
  JSON.stringify(a.text.slice(0, 120))
);
check("window A streamed events", a.events.length > 0, `${a.events.length} events`);
check("window A had no error", !a.errored, a.errored ?? "");

// The isolation claim: B was never touched while A ran a full turn.
check("window B received NO tool calls", b.cmds.length === 0, b.cmds.join(","));
check("window B received NO events", b.events.length === 0, `${b.events.length}`);

// --- now prompt window B ---------------------------------------------------
b.ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Call get_status and reply with ONLY the project name, nothing else.",
  })
);
await waitFor(() => b.done, 120_000, "window B turn to finish");

check("window B's tool call reached window B", b.cmds.includes("get_status"), b.cmds.join(","));
check(
  "window B saw its OWN state, not A's",
  b.text.includes("BETA-PROJECT") && !b.text.includes("ALPHA"),
  JSON.stringify(b.text.slice(0, 120))
);

// --- built-in tools are absent, not merely denied --------------------------
const toolNames = new Set<string>();
for (const e of [...a.events, ...b.events])
  if ((e as { type?: string }).type === "assistant")
    for (const blk of ((e as { message?: { content?: { type: string; name?: string }[] } })
      .message?.content ?? []))
      if (blk.type === "tool_use" && blk.name) toolNames.add(blk.name);

check(
  "only toolbox tools were called",
  [...toolNames].every((n) => n.startsWith("mcp__toolbox__")),
  [...toolNames].join(",") || "(none)"
);

// --- built-ins are absent, PROVEN by tempting the model -------------------
// The earlier assertion ("only toolbox tools were called") passed vacuously:
// a trivial task never reaches for Read or Bash, so it proved nothing. A real
// session WAS offered Read and Bash. This asks for a file read explicitly and
// asserts the model has no such tool.
const c = await openWindow("window-C", { project: "GAMMA", fps: 24, frame: 0 });
await waitFor(() => c.ready, 10_000, "window C ready");
c.ws.send(
  JSON.stringify({
    type: "prompt",
    text:
      "Read the file /etc/hosts and tell me its first line. If you have no " +
      "tool that can read files, say exactly: NO FILE TOOL.",
  })
);
await waitFor(() => c.done, 120_000, "window C turn to finish");

const cTools = new Set<string>();
for (const e of c.events)
  if ((e as { type?: string }).type === "assistant")
    for (const blk of ((e as { message?: { content?: { type: string; name?: string }[] } })
      .message?.content ?? []))
      if (blk.type === "tool_use" && blk.name) cTools.add(blk.name);

// Read EXISTS (it is how spilled tool results are recovered) but is scoped to
// spill files, so an arbitrary path must be refused. Bash and friends must not
// appear at all.
const shellish = [...cTools].filter(
  (n) => !n.startsWith("mcp__toolbox__") && n !== "Read"
);
check("no shell/write tool is available", shellish.length === 0, shellish.join(",") || "(none)");
check(
  "reading an arbitrary path is refused",
  /no file tool/i.test(c.text) || /limited to/i.test(c.text),
  JSON.stringify(c.text.slice(0, 160))
);

// --- a full-size catalog survives the MCP output cap ----------------------
// The real get_catalog is ~174k chars / ~48k tokens. Claude Code caps MCP
// tool results at MAX_MCP_OUTPUT_TOKENS (default 25k), so on the default the
// model silently receives a TRUNCATED catalog — which is what made a real
// session say "the catalog is too large to fetch in one piece" and start
// probing for node types with throwaway recipes.
//
// Sentinel at the very END: it can only be reported if nothing was cut.
const SENTINEL = "ZZQX-CATALOG-END-MARKER";
const bigCatalog =
  Array.from(
    { length: 520 },
    (_, i) =>
      `node-type-${i} (Node ${i}) [effect] ~dyn: image -> image aux=none | opacity, seed, scale, rotation, offsetX, offsetY` +
      `\n# A synthetic catalog line standing in for the real node vocabulary, padded to a realistic width.`
  ).join("\n") + `\nFINAL_LINE_TOKEN=${SENTINEL}\n`;

const d = await openWindow("window-D", { project: "DELTA" }, bigCatalog);
await waitFor(() => d.ready, 10_000, "window D ready");
d.ws.send(
  JSON.stringify({
    type: "prompt",
    text:
      "Call get_catalog. It ends with a line `FINAL_LINE_TOKEN=<value>`. " +
      "Reply with ONLY that value.",
  })
);
await waitFor(() => d.done, 180_000, "window D turn to finish");

// The real catalog (~174k chars) always spills to a file; recovery via the
// scoped Read is what makes it usable. Without it the model probes blindly
// for node types — the exact failure a real session showed.
check(
  `a ${Math.round(bigCatalog.length / 1000)}k-char catalog is recovered in full`,
  d.text.includes(SENTINEL),
  JSON.stringify(d.text.slice(0, 160))
);

d.ws.close();
c.ws.close();
a.ws.close();
b.ws.close();
killHost();

// --- missing Claude Code binary -------------------------------------------
// Option B drives the user's installed CLI, so "not installed" is a real
// state the panel must report rather than hang on. Costs no inference: the
// host refuses before spawning anything.
{
  const PORT2 = "38297";
  const host2 = spawn("node", ["scripts/agent-host.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TOOLBOX_AGENT_PORT: PORT2,
      TOOLBOX_CLAUDE_BIN: "/nonexistent/claude",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill2 = () => {
    try {
      host2.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", kill2);

  let tok2 = "";
  host2.stdout.on("data", (b) => {
    for (const line of String(b).split("\n").filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (j.ready) tok2 = j.token;
      } catch {
        /* not the handshake line */
      }
    }
  });
  await waitFor(() => !!tok2, 10_000, "second host boot");

  const ws2 = new RawWS(`ws://127.0.0.1:${PORT2}`);
  let readyFrame: Record<string, unknown> | null = null;
  let errText: string | null = null;
  ws2.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "ready") readyFrame = m;
    if (m.type === "error") errText = m.message;
  });
  await new Promise<void>((r) =>
    ws2.on("open", () => {
      ws2.send(JSON.stringify({ type: "hello", token: tok2, sessionKey: "nobin" }));
      r();
    })
  );
  await waitFor(() => readyFrame !== null, 10_000, "ready frame");

  const rf = readyFrame as unknown as {
    claudeBin: string | null;
    binaryMessage: string | null;
  };
  check("missing binary → ready reports claudeBin: null", rf.claudeBin === null);
  check(
    "missing binary → ready carries an install message",
    !!rf.binaryMessage && /install/i.test(rf.binaryMessage)
  );

  ws2.send(JSON.stringify({ type: "prompt", text: "hello" }));
  await waitFor(() => errText !== null, 10_000, "refusal");
  check("missing binary → a prompt is refused, not hung", !!errText);

  ws2.close();
  kill2();
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}`);
process.exit(failures === 0 ? 0 : 1);
