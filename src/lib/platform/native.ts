// Native (Electron) platform implementation — maps the Platform seam onto the
// narrow `window.toolboxNative` bridge the preload injects. Everything crosses
// the bridge as ArrayBuffer / opaque tokens (structured-clone-safe).
//
// In Milestone 1 the bridge methods are stubs that throw; nothing in the
// renderer calls these yet (callsites are rerouted in M2/M3), so this module is
// safe to ship inert in the shared web bundle.

import type {
  FolderHandle,
  NativeVideoEncodeSpec,
  Platform,
  SaveFileOptions,
  VideoEncodeSession,
} from "./types";

function bridge(): ToolboxNativeBridge {
  const b = typeof window !== "undefined" ? window.toolboxNative : undefined;
  if (!b) throw new Error("toolboxNative bridge is unavailable");
  return b;
}

async function toArrayBuffer(data: Blob | Uint8Array): Promise<ArrayBuffer> {
  if (data instanceof Blob) return data.arrayBuffer();
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function viewToArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

async function saveFile(data: Blob | Uint8Array, opts: SaveFileOptions): Promise<void> {
  await bridge().saveFile({
    bytes: await toArrayBuffer(data),
    suggestedName: opts.suggestedName,
    filters: opts.filters,
  });
}

async function pickSaveFolder(): Promise<FolderHandle | null> {
  const r = await bridge().pickSaveFolder();
  if (!r) return null;
  const { token, name } = r;
  return {
    name,
    async writeFile(fileName: string, data: Blob | Uint8Array) {
      await bridge().writeFileInFolder(token, fileName, await toArrayBuffer(data));
    },
  };
}

async function pickOpenFiles(opts: {
  kind: "video" | "audio" | "media" | "image" | "toolbox";
  multiple?: boolean;
}): Promise<File[] | null> {
  const r = await bridge().pickOpenFiles(opts);
  if (!r) return null;
  return r.map((f) => new File([f.bytes], f.name, { type: f.type }));
}

async function encodeVideo(
  spec: NativeVideoEncodeSpec,
  onProgress?: (label: string, fraction: number) => void
): Promise<VideoEncodeSession | null> {
  const b = bridge();
  const begun = await b.encodeVideoBegin({
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    durationFrames: spec.durationFrames,
    container: spec.container,
    codec: spec.codec,
    crf: spec.crf,
    proresProfile: spec.proresProfile,
    alpha: spec.alpha,
    audioWav: spec.audioWav ? viewToArrayBuffer(spec.audioWav) : undefined,
    suggestedName: spec.suggestedName,
  });
  if (!begun) return null; // user cancelled the save dialog
  const { sessionId } = begun;
  const unsub = onProgress
    ? b.onEncodeProgress((e) => {
        if (e.sessionId === sessionId) onProgress(e.label, e.fraction);
      })
    : () => {};
  return {
    async writeFrame(rgba: Uint8Array) {
      await b.encodeVideoFrame(sessionId, viewToArrayBuffer(rgba));
    },
    async finish() {
      try {
        await b.encodeVideoEnd(sessionId);
      } finally {
        unsub();
      }
    },
    async abort() {
      try {
        await b.encodeVideoAbort(sessionId);
      } finally {
        unsub();
      }
    },
  };
}

export const nativePlatform: Platform = {
  isNative: true,
  get canEncodeNative() {
    return !!(typeof window !== "undefined" && window.toolboxNative?.canEncodeNative);
  },
  saveFile,
  pickSaveFolder,
  pickOpenFiles,
  encodeVideo,
};
