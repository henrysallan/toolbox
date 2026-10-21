// One After Effects run at a time on this Mac. Parallel sessions (each in its
// own worktree) share one Scripts/Startup folder, and every runner installs
// and removes its one-launch hook there around an aerender launch, so two
// runs at once remove each other's hook mid-launch. mkdir is atomic: the lock
// directory holds an `owner` file (pid + who); a lock whose pid is gone, or
// with no owner after a minute, is stale and taken over. Re-entrant within
// one process.
//
// Every script that launches aerender takes it: calibrate/ae.mts (runAeJob,
// renderQueue), run.mts, scripts/ae-export/e2e-package.mts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AE_LOCK = process.env.TBX_AE_LOCK ?? "/tmp/toolbox-ae.lock";

let held = 0;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(): string {
  try {
    return readFileSync(join(AE_LOCK, "owner"), "utf8").trim();
  } catch {
    return "";
  }
}

function stale(owner: string): boolean {
  if (owner) return !alive(Number(owner.split(" ")[0]));
  try {
    return Date.now() - statSync(AE_LOCK).mtimeMs > 60_000;
  } catch {
    return false;
  }
}

function drop() {
  held = 0;
  rmSync(AE_LOCK, { recursive: true, force: true });
}

// Resolves once this process holds the lock; the returned function releases
// it (also released on exit).
export async function acquireAeLock(who: string, timeoutMs = 3_600_000): Promise<() => void> {
  const release = () => {
    if (held > 0 && --held === 0) {
      process.off("exit", drop);
      drop();
    }
  };
  if (held > 0) {
    held++;
    return release;
  }
  const t0 = Date.now();
  let said = false;
  for (;;) {
    try {
      mkdirSync(AE_LOCK);
      writeFileSync(join(AE_LOCK, "owner"), `${process.pid} ${who} ${process.cwd()}\n`);
      held = 1;
      process.on("exit", drop);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const owner = readOwner();
    if (stale(owner)) {
      rmSync(AE_LOCK, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`After Effects lock ${AE_LOCK} still held by ${owner || "?"} after ${Math.round(timeoutMs / 60_000)} min`);
    if (!said) {
      console.log(`waiting for the After Effects lock ${AE_LOCK} (held by ${owner || "?"})`);
      said = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function withAeLock<T>(who: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireAeLock(who);
  try {
    return await fn();
  } finally {
    release();
  }
}
