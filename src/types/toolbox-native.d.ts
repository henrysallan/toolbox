// Ambient type for the bridge the Electron preload injects onto `window`.
// On the plain web target this is simply absent (the adapter falls back to the
// web implementation). Keep this surface NARROW and intent-level — it is the
// only thing remote page code can reach into the native process with.
//
// Everything crosses the contextBridge as structured-clone-safe values:
// bytes are ArrayBuffer (not Blob), folders are opaque tokens (not paths the
// page chose). See specdocs/062626_electron-native-export.md (Security).

export {};

declare global {
  interface ToolboxNativeBridge {
    /** Bridge schema version (bump when the surface changes). */
    readonly version: number;
    /** process.platform of the host ("darwin" | "win32" | "linux"). */
    readonly platform: string;
    /** True once a native ffmpeg encoder is wired up and available. */
    readonly canEncodeNative: boolean;

    // ---- File I/O (Milestone 2) -------------------------------------------
    /** Show a native Save dialog and write bytes to the chosen path. */
    saveFile(opts: {
      bytes: ArrayBuffer;
      suggestedName: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ saved: boolean; path?: string }>;

    /** Show a native folder picker; returns an opaque token + display name. */
    pickSaveFolder(): Promise<{ token: string; name: string } | null>;
    /** Write one file into a previously-picked folder (by token). */
    writeFileInFolder(token: string, name: string, bytes: ArrayBuffer): Promise<void>;

    /** Show a native Open dialog; returns file bytes (null = cancelled). */
    pickOpenFiles(opts: {
      kind: "video" | "audio" | "media" | "image" | "toolbox";
      multiple?: boolean;
    }): Promise<Array<{ name: string; type: string; bytes: ArrayBuffer }> | null>;

    // ---- Native ffmpeg streaming encode (Milestone 3) ---------------------
    /** Open a save dialog + spawn ffmpeg reading rawvideo from stdin. */
    encodeVideoBegin(spec: {
      width: number;
      height: number;
      fps: number;
      durationFrames: number;
      container: string;
      codec: string;
      crf: number;
      proresProfile?: number;
      alpha?: boolean;
      audioWav?: ArrayBuffer;
      suggestedName: string;
    }): Promise<{ sessionId: string; path: string } | null>;
    /** Push one RGBA8 frame; resolves when drained (backpressure). */
    encodeVideoFrame(sessionId: string, rgba: ArrayBuffer): Promise<void>;
    /** Close stdin and await ffmpeg exit; resolves with the written path. */
    encodeVideoEnd(sessionId: string): Promise<{ path: string }>;
    /** Abort the encode and clean up. */
    encodeVideoAbort(sessionId: string): Promise<void>;
    /** Subscribe to encode progress; returns an unsubscribe fn. */
    onEncodeProgress(
      cb: (e: { sessionId: string; label: string; fraction: number }) => void
    ): () => void;
  }

  interface Window {
    toolboxNative?: ToolboxNativeBridge;
  }
}
