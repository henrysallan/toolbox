// External assets folders (main process) — backing for the toolboxNative
// `assets` bridge. The renderer never supplies a base path: main remembers the
// directory of the most-recently-opened .toolbox (recordOpenedToolbox, called
// from files.js / recents.js) and only ever lists/reads files under an assets
// folder it has itself scanned or the user explicitly picked. See
// specdocs/archive/062926_assets.md (and the desktop spec's Security section).
"use strict";

const { ipcMain, dialog, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

// The assets/ folder beside the most-recently-opened .toolbox.
let lastAssetsDir = null;
// Every assets dir scanned or picked this session — read() validates against
// this set so the page can't read an arbitrary path by inventing a ref.
const allowedDirs = new Set();

// Only surface recognized media (drag-to-create handles these). Others are
// hidden to keep the panel clean (assets spec open-question lean).
const MEDIA_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg",
  "mp4", "mov", "webm", "mkv", "m4v", "avi",
  "mp3", "wav", "m4a", "aac", "ogg", "flac",
  "ttf", "otf", "woff", "woff2",
]);

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", m4v: "video/x-m4v", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", flac: "audio/flac",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};

const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();
const mimeFor = (p) => MIME[extOf(p)] || "application/octet-stream";

function winFrom(event) {
  return BrowserWindow.fromWebContents(event.sender) || undefined;
}

// List the media files directly inside `dir`. Returns null if the directory
// doesn't exist / isn't readable (e.g. no sibling assets/ folder).
async function listMediaFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = [];
  for (const d of entries) {
    if (!d.isFile()) continue;
    const ext = extOf(d.name);
    if (!MEDIA_EXT.has(ext)) continue;
    const full = path.join(dir, d.name);
    let size;
    try {
      size = (await fs.stat(full)).size;
    } catch {
      /* size optional */
    }
    files.push({ ref: full, name: d.name, ext, size });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

// Arm the sibling `assets/` folder of a just-opened/saved .toolbox path.
function recordOpenedToolbox(filePath) {
  try {
    lastAssetsDir = path.join(path.dirname(String(filePath)), "assets");
  } catch {
    /* ignore */
  }
}

function registerAssetsHandlers() {
  ipcMain.handle("toolbox:assets:scanCurrent", async () => {
    if (!lastAssetsDir) return null;
    const files = await listMediaFiles(lastAssetsDir);
    if (!files) return null; // no assets/ folder next to the project
    allowedDirs.add(lastAssetsDir);
    return {
      name: path.basename(path.dirname(lastAssetsDir)),
      files,
    };
  });

  ipcMain.handle("toolbox:assets:pick", async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(winFrom(event), {
      properties: ["openDirectory"],
    });
    if (canceled || !filePaths.length) return null;
    const dir = filePaths[0];
    const files = await listMediaFiles(dir);
    if (!files) return null;
    allowedDirs.add(dir);
    return { name: path.basename(dir), files };
  });

  ipcMain.handle("toolbox:assets:read", async (_event, ref) => {
    const full = path.resolve(String(ref));
    const allowed = [...allowedDirs].some(
      (d) => full === d || full.startsWith(d + path.sep)
    );
    if (!allowed) {
      throw new Error("assets.read: path is not inside an allowed assets folder");
    }
    let buf;
    try {
      buf = await fs.readFile(full);
    } catch {
      return null;
    }
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      name: path.basename(full),
      type: mimeFor(full),
    };
  });
}

module.exports = { recordOpenedToolbox, registerAssetsHandlers };
