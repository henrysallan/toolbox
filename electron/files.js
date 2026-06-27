// Native file I/O handlers (main process) — backing for the file-I/O half of
// the toolboxNative bridge. The renderer only ever asks for intent-level
// operations ("save these bytes", "pick a folder"); the actual path is chosen
// by the user via an OS dialog, never supplied by the page. See spec Security.
"use strict";

const { ipcMain, dialog, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

// Folders the user explicitly picked this session. writeFileInFolder only
// honors tokens from this set, so the renderer can't coerce a write to an
// arbitrary path by inventing a token.
const pickedFolders = new Set();

const EXT_FILTERS = {
  video: { name: "Video", extensions: ["mp4", "mov", "webm", "mkv", "m4v", "avi"] },
  audio: { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },
  image: { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
  toolbox: { name: "Toolbox project", extensions: ["toolbox"] },
};

function filtersForKind(kind) {
  const all = { name: "All Files", extensions: ["*"] };
  switch (kind) {
    case "media":
      return [EXT_FILTERS.video, EXT_FILTERS.audio, all];
    case "video":
    case "audio":
    case "image":
    case "toolbox":
      return [EXT_FILTERS[kind], all];
    default:
      return [all];
  }
}

const MIME = {
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  m4v: "video/x-m4v", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", flac: "audio/flac",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp",
  toolbox: "application/zip", zip: "application/zip",
};

function mimeFor(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

function winFrom(event) {
  return BrowserWindow.fromWebContents(event.sender) || undefined;
}

function registerFileHandlers() {
  ipcMain.handle("toolbox:saveFile", async (event, { bytes, suggestedName, filters }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(winFrom(event), {
      defaultPath: suggestedName,
      filters: filters && filters.length ? filters : undefined,
    });
    if (canceled || !filePath) return { saved: false };
    await fs.writeFile(filePath, Buffer.from(bytes));
    return { saved: true, path: filePath };
  });

  ipcMain.handle("toolbox:pickSaveFolder", async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(winFrom(event), {
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths.length) return null;
    const dir = filePaths[0];
    pickedFolders.add(dir);
    return { token: dir, name: path.basename(dir) };
  });

  ipcMain.handle("toolbox:writeFileInFolder", async (_event, token, name, bytes) => {
    if (!pickedFolders.has(token)) throw new Error("writeFileInFolder: unknown folder token");
    // Strip any directory components from the page-supplied name.
    const safe = path.basename(String(name));
    if (!safe || safe === "." || safe === "..") throw new Error("writeFileInFolder: invalid name");
    await fs.writeFile(path.join(token, safe), Buffer.from(bytes));
  });

  ipcMain.handle("toolbox:pickOpenFiles", async (event, { kind, multiple }) => {
    const properties = ["openFile"];
    if (multiple) properties.push("multiSelections");
    const { canceled, filePaths } = await dialog.showOpenDialog(winFrom(event), {
      properties,
      filters: filtersForKind(kind),
    });
    if (canceled || !filePaths.length) return null;
    const out = [];
    for (const fp of filePaths) {
      // NOTE: eager full-file read. Fine for projects/typical media; revisit
      // with a streamed handle if huge video relinks become common.
      const buf = await fs.readFile(fp);
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      out.push({ name: path.basename(fp), type: mimeFor(fp), bytes });
    }
    return out;
  });
}

module.exports = { registerFileHandlers };
