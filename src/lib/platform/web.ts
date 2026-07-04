// Web platform implementation — this is the app's CURRENT behavior, factored
// behind the Platform seam verbatim. Touching `window`/`document` only inside
// method bodies (never at module load) so this is import-safe during SSR.

import type {
  AssetsFolderHandle,
  FolderHandle,
  OpenFileKind,
  Platform,
  SaveFileOptions,
} from "./types";

function acceptFor(kind: OpenFileKind): string {
  switch (kind) {
    case "video":
      return "video/*";
    case "audio":
      return "audio/*";
    case "image":
      return "image/*";
    case "media":
      return "video/*,audio/*";
    case "toolbox":
      return ".toolbox,application/zip";
  }
}

// The browser delivery primitive (object-URL + anchor click). This lives here
// — the web side of the seam — so export.ts's downloadBlob can switch on
// platform without an import cycle.
async function saveFile(data: Blob | Uint8Array, opts: SaveFileOptions): Promise<void> {
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data as BlobPart], { type: opts.mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function pickSaveFolder(): Promise<FolderHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (!picker) return null; // non-Chromium — caller falls back (zip/sequential)
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await picker();
  } catch {
    return null; // user cancelled
  }
  return {
    name: dir.name,
    async writeFile(name: string, data: Blob | Uint8Array) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data instanceof Blob ? data : new Blob([data as BlobPart]));
      await w.close();
    },
  };
}

function pickOpenFiles(opts: { kind: OpenFileKind; multiple?: boolean }): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptFor(opts.kind);
    if (opts.multiple) input.multiple = true;
    input.style.display = "none";
    let settled = false;
    const done = (files: File[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => done(input.files ? Array.from(input.files) : null);
    // Modern browsers fire `cancel` when the dialog is dismissed.
    input.oncancel = () => done(null);
    document.body.appendChild(input);
    input.click();
  });
}

// Wrap a File System Access directory handle as an AssetsFolderHandle: snapshot
// the (top-level) file entries now, read bytes lazily by name.
async function fsaFolder(
  dir: FileSystemDirectoryHandle
): Promise<AssetsFolderHandle> {
  const files: AssetsFolderHandle["files"] = [];
  // `entries()` is an async iterator on the directory handle (not yet in the
  // lib DOM types) — cast to read it.
  const entries = (
    dir as unknown as {
      entries(): AsyncIterable<[string, { kind: string }]>;
    }
  ).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind !== "file") continue;
    const dot = name.lastIndexOf(".");
    files.push({ ref: name, name, ext: dot >= 0 ? name.slice(dot + 1).toLowerCase() : "" });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    name: dir.name,
    files,
    async read(ref: string) {
      try {
        const fh = await dir.getFileHandle(ref);
        const file = await fh.getFile();
        return { bytes: await file.arrayBuffer(), name: file.name, type: file.type };
      } catch {
        return null;
      }
    },
  };
}

async function pickAssetsFolder(): Promise<AssetsFolderHandle | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) return null; // non-Chromium
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await picker();
  } catch {
    return null; // user cancelled
  }
  return fsaFolder(dir);
}

export const webPlatform: Platform = {
  isNative: false,
  canEncodeNative: false,
  saveFile,
  pickSaveFolder,
  pickOpenFiles,
  // encodeVideo intentionally undefined — web uses the existing
  // ffmpeg.wasm / WebCodecs / MediaRecorder tiers.
  assets: {
    // Web can't auto-scan a sibling folder (no path); only the picker applies.
    pick: pickAssetsFolder,
  },
};
