// One-command desktop dev: starts the Next dev server, waits for it to listen,
// then launches Electron pointed at it (TOOLBOX_DEV_URL). Ctrl+C or quitting
// the app tears both down. Use `npm run dev:desktop`.
import { spawn } from "node:child_process";
import http from "node:http";

const DEV_URL = "http://localhost:3000";
const children = [];

function run(cmd, args) {
  const c = spawn(cmd, args, { stdio: "inherit", env: process.env });
  children.push(c);
  return c;
}

function killAll() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
}

process.on("SIGINT", () => {
  killAll();
  process.exit(0);
});
process.on("exit", killAll);

const dev = run("npm", ["run", "dev"]);
dev.on("exit", () => {
  killAll();
  process.exit(0);
});

// Poll until the dev server answers, then launch Electron.
(function waitReady() {
  http
    .get(DEV_URL, (res) => {
      res.resume();
      const elec = run("npm", ["run", "electron:dev"]);
      elec.on("exit", () => {
        killAll();
        process.exit(0);
      });
    })
    .on("error", () => setTimeout(waitReady, 400));
})();
