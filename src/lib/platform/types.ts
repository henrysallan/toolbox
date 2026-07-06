// The platform seam. Feature code (export, file open/save) talks to `platform`
// from ./index and NEVER branches on web-vs-native itself. Web and native each
// provide a full implementation; the web impl is exactly today's behavior, so
// the web target can't regress as native capabilities are added.
//
// Spec: specdocs/062626_electron-native-export.md

export type OpenFileKind = "video" | "audio" | "media" | "image" | "toolbox";

export interface SaveFileOptions {
  /** Filename proposed to the user (web: the download name; native: dialog default). */
  suggestedName: string;
  /** MIME used to build the Blob on web; ignored natively. */
  mimeType?: string;
  /** Native Save-dialog type filters; ignored on web. */
  filters?: { name: string; extensions: string[] }[];
}

/** A destination folder, abstracted over FSA (web) and a native dir (Electron). */
export interface FolderHandle {
  /** Display label (web: directory name; native: folder name). */
  readonly name: string;
  writeFile(name: string, data: Blob | Uint8Array): Promise<void>;
}

/** Mirrors the wasm path's FfmpegExportOptions minus canvas/renderFrame (those
 *  stay in the renderer's frame loop) plus the output filename. */
export interface NativeVideoEncodeSpec {
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  container: string;
  codec: string;
  crf: number;
  /** ProRes profile index 0–5 (proxy/lt/standard/hq/4444/4444xq). */
  proresProfile?: number;
  alpha?: boolean;
  audioWav?: Uint8Array;
  suggestedName: string;
}

/** A live native encode. The renderer drives the frame loop and pushes RGBA8
 *  frames; `finish` resolves when the file is fully written to disk. */
export interface VideoEncodeSession {
  /** width*height*4 bytes, straight (non-premultiplied) alpha. Awaits backpressure. */
  writeFrame(rgba: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export interface Platform {
  /** True inside Electron (the native bridge is present). */
  readonly isNative: boolean;
  /** Host OS. On the native build this is the real `process.platform`; on web
   *  it's a best-effort guess and unused (window controls don't render there).
   *  Used only by the title-bar surface to pick control chrome (mac traffic
   *  lights vs. Windows caption buttons). */
  readonly os: "mac" | "windows" | "linux";
  /** True when `encodeVideo` will actually run a native encoder. */
  readonly canEncodeNative: boolean;

  /** Persist bytes to a user-chosen location (web: download; native: Save dialog). */
  saveFile(data: Blob | Uint8Array, opts: SaveFileOptions): Promise<void>;

  /** Pick a destination folder. null = cancelled or unsupported (web non-Chromium). */
  pickSaveFolder(): Promise<FolderHandle | null>;

  /** Open file picker. null = cancelled. */
  pickOpenFiles(opts: { kind: OpenFileKind; multiple?: boolean }): Promise<File[] | null>;

  /** Begin a native streaming encode. null = user cancelled the save dialog.
   *  Only meaningful when `canEncodeNative` is true. */
  encodeVideo?(
    spec: NativeVideoEncodeSpec,
    onProgress?: (label: string, fraction: number) => void
  ): Promise<VideoEncodeSession | null>;

  /** Transcode a video the renderer's <video> couldn't decode into a
   *  Chromium-playable form (native ffmpeg). Returns the playable bytes +
   *  mime, or null. Only present on the native build. */
  transcodeVideoForPlayback?(
    bytes: ArrayBuffer,
    name: string
  ): Promise<{ bytes: ArrayBuffer; type: string } | null>;

  /** Frameless-window controls (the renderer draws its own title-bar controls —
   *  macOS traffic lights or Windows caption buttons). Present only on the
   *  native desktop build. */
  windowControls?: {
    minimize(): void;
    /** Toggle maximize/restore (Windows caption button). */
    toggleMaximize(): void;
    toggleFullscreen(): void;
    close(): void;
    /** Current maximized state, for the initial maximize/restore glyph. */
    isMaximized(): Promise<boolean>;
    /** Subscribe to native maximize/restore changes; returns an unsubscribe fn. */
    onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  };

  /** Recently-opened local .toolbox files (native desktop only). Recorded
   *  automatically on .toolbox open/save. */
  recents?: {
    list(): Promise<LocalRecent[]>;
    open(path: string): Promise<{ bytes: ArrayBuffer; name: string } | null>;
    remove(path: string): Promise<void>;
  };

  /** External assets folders (the `assets/` next to a .toolbox, or a folder the
   *  user picks). Capability-gated: desktop auto-scans the sibling folder; web
   *  (and desktop) can pick one. See specdocs/062926_assets.md. */
  assets?: {
    /** The `assets/` folder beside the most-recently-opened .toolbox (desktop).
     *  null when none exists or no .toolbox was opened this session. */
    scanCurrent?(): Promise<AssetsFolderHandle | null>;
    /** Let the user choose an assets folder (web FSA / native dir dialog).
     *  null = cancelled / unsupported (non-Chromium web). */
    pick?(): Promise<AssetsFolderHandle | null>;
  };
}

export interface LocalRecent {
  path: string;
  name: string;
  lastOpened: number;
}

/** One file inside an assets folder. `ref` is an opaque handle passed back to
 *  `read()` — a native absolute path, or the entry name on web. */
export interface AssetFileRef {
  ref: string;
  name: string;
  ext: string;
  size?: number;
}

/** An external assets folder (the `assets/` beside a .toolbox on desktop, or a
 *  user-picked folder), abstracted over native FS and the File System Access
 *  API. `files` is a snapshot; bytes are read lazily via `read`. */
export interface AssetsFolderHandle {
  readonly name: string;
  readonly files: AssetFileRef[];
  read(
    ref: string
  ): Promise<{ bytes: ArrayBuffer; name: string; type: string } | null>;
}
