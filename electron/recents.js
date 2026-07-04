// Recently-opened local .toolbox files (desktop). Main owns the list (in
// userData) so it survives restarts/rebuilds and so it can validate which
// paths the renderer may read back. Entries are recorded automatically by
// files.js whenever a .toolbox path is opened or saved through a native dialog.
"use strict";

const { app, ipcMain } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { recordOpenedToolbox } = require("./assets");

const MAX = 30;

function storeFile() {
  return path.join(app.getPath("userData"), "toolbox-recents.json");
}

function readList() {
  try {
    const v = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeList(list) {
  try {
    await fsp.writeFile(storeFile(), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* best-effort */
  }
}

// Move/insert `filePath` to the front with a fresh timestamp.
async function recordRecent(filePath, name) {
  const list = readList().filter((r) => r.path !== filePath);
  list.unshift({ path: filePath, name, lastOpened: Date.now() });
  await writeList(list);
}

function registerRecentsHandlers() {
  // List, pruning entries whose files have since moved/been deleted.
  ipcMain.handle("toolbox:recents:list", async () => {
    const list = readList();
    const alive = [];
    for (const r of list) {
      try {
        await fsp.access(r.path);
        alive.push(r);
      } catch {
        /* file gone — drop it */
      }
    }
    if (alive.length !== list.length) await writeList(alive);
    return alive;
  });

  // Read a recent's bytes (only paths already in the list are allowed).
  ipcMain.handle("toolbox:recents:open", async (_e, p) => {
    const list = readList();
    const entry = list.find((r) => r.path === p);
    if (!entry) return null;
    let buf;
    try {
      buf = await fsp.readFile(p);
    } catch {
      await writeList(list.filter((r) => r.path !== p));
      return null;
    }
    entry.lastOpened = Date.now();
    await writeList(list);
    recordOpenedToolbox(p);
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      name: entry.name,
    };
  });

  ipcMain.handle("toolbox:recents:remove", async (_e, p) => {
    await writeList(readList().filter((r) => r.path !== p));
  });
}

module.exports = { recordRecent, registerRecentsHandlers };
