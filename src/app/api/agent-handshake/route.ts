// GET /api/agent-handshake — hand the assistant panel the local agent host's
// port + control token (spec 080826_claude-agent-panel.md, milestone 1).
//
// The host (scripts/agent-host.mjs) mints a 32-byte token per boot and writes
// it to a 0600 file in the system temp dir. A browser page can't read files,
// so this route reads it server-side and returns it.
//
// WHY THIS IS NOT AN OPEN DOOR. The token gates starting an agent, so it must
// not be readable by a random page the user happens to visit. The control is
// same-origin enforcement, not authentication:
//
//   - A cross-origin page CAN issue this request, but cannot read the
//     response — no CORS headers are sent, so the browser withholds the body.
//   - It also can't reach the host directly: agent-host.mjs rejects WebSocket
//     handshakes whose Origin isn't loopback.
//   - We additionally require Sec-Fetch-Site to be same-origin, which closes
//     the no-Origin-header (non-browser) case and makes the intent explicit.
//
// A Supabase session is deliberately NOT required. This capability is
// entirely local — the user's own machine, their own logged-in `claude`
// binary, no server cost — so gating it on cloud auth would add friction and
// break the offline desktop story without addressing the threat above.
//
// Electron does not use this route at all: main reads the same file and hands
// the token to the window directly (electron/agent.js).

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
// The token changes on every host boot; caching it would hand out a stale one.
export const dynamic = "force-dynamic";

// Keep in sync with HANDSHAKE_FILE in scripts/agent-host.mjs.
const HANDSHAKE_FILE = join(tmpdir(), "toolbox-agent.json");

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request) {
  // Same-origin only. Browsers set Sec-Fetch-Site on every fetch and a page
  // cannot forge it; `none` covers a direct address-bar hit, which is a
  // developer checking the endpoint, not an attack.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    return Response.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403, headers: NO_STORE }
    );

  let raw: string;
  try {
    raw = await readFile(HANDSHAKE_FILE, "utf8");
  } catch {
    return Response.json(
      {
        error:
          "The Toolbox agent host isn't running. Start it with `npm run agent`.",
        running: false,
      },
      { status: 503, headers: NO_STORE }
    );
  }

  let parsed: { port?: number; token?: string; pid?: number };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json(
      { error: "The agent handshake file is unreadable.", running: false },
      { status: 500, headers: NO_STORE }
    );
  }

  if (!parsed.token || !parsed.port)
    return Response.json(
      { error: "The agent handshake file is incomplete.", running: false },
      { status: 500, headers: NO_STORE }
    );

  // A stale file from a crashed host would hand out a dead token. Cheap
  // liveness check: does the recorded pid still exist?
  if (parsed.pid) {
    try {
      process.kill(parsed.pid, 0);
    } catch {
      return Response.json(
        {
          error:
            "The Toolbox agent host is no longer running. Restart it with " +
            "`npm run agent`.",
          running: false,
        },
        { status: 503, headers: NO_STORE }
      );
    }
  }

  return Response.json(
    { running: true, port: parsed.port, token: parsed.token },
    { headers: NO_STORE }
  );
}
