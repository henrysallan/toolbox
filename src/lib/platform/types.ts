// The platform seam. Feature code (export, file open/save) talks to `platform`
// from ./index and NEVER branches on web-vs-native itself. Web and native each
// provide a full implementation; the web impl is exactly today's behavior, so
// the web target can't regress as native capabilities are added.
//
// Spec: specdocs/archive/062626_electron-native-export.md

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
  /** Write at a nested relative path ("footage/a.mov"), creating folders.
   *  Native only: main checks the path stays inside the folder (relative,
   *  forward slashes, no "..", quotes or control characters). */
  writeFileAt?(relPath: string, data: Blob | Uint8Array): Promise<void>;
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
  /** Export log sink id (ExportLogSink.id): the native encoder appends the
   *  spawned command line and ffmpeg's stderr to that file. */
  logId?: string;
  /** Write into this folder at a relative path (its extension = `container`)
   *  instead of asking with a Save dialog — the After Effects package's
   *  baked footage. Only folders from pickSaveFolder / runAfterEffects. */
  into?: { folder: FolderHandle; path: string };
}

/** A live native encode. The renderer drives the frame loop and pushes RGBA8
 *  frames; `finish` resolves when the file is fully written to disk. */
export interface VideoEncodeSession {
  /** width*height*4 bytes, straight (non-premultiplied) alpha. Awaits backpressure. */
  writeFrame(rgba: Uint8Array): Promise<void>;
  /** Resolves with where the file landed and its size when the shell reports it. */
  finish(): Promise<{ path?: string; bytes?: number }>;
  abort(): Promise<void>;
}

/** One export run's log file (lib/export-log.ts writes through it). `id` is
 *  what the native encoder takes as `NativeVideoEncodeSpec.logId` so ffmpeg's
 *  own output lands in the same file; `path` is shown to the user on failure. */
export interface ExportLogSink {
  readonly id: string | null;
  readonly path: string | null;
  append(line: string): void;
  close(): Promise<void>;
}

/** After Effects on this machine (electron/ae.js; macOS only for now). */
export interface AeCapabilities {
  /** aerender and the After Effects app were found. */
  available: boolean;
  /** Why not, when `available` is false. */
  reason?: string;
  version?: string | null;
  dir?: string;
  aerender?: string;
  app?: string;
  /** The user Scripts/Startup folder headless builds hook into. */
  startupFolder?: string;
  /** Where main looked: TOOLBOX_AE_DIR first, then the release folders. */
  candidates: { dir: string; source: "env" | "default"; found: boolean }[];
  /** The Toolbox Shader host plug-in (shader regions). */
  shaderHost: { installed: boolean; path?: string; version?: string | null };
  /** tbxshader-check (TOOLBOX_SHADER_CHECK or ../AE_Plugins/toolbox-shader/build). */
  shaderCheck: string | null;
  /** The bundled ffmpeg is there (footage encodes, TIFF decodes). */
  canEncode?: boolean;
  /** Main's own export folder (tool exports with no picked folder). */
  exportRoot?: string;
}

/** A package folder main created: nested writes, its absolute path, and
 *  whether aerender can take that path (no quote / backslash / control). */
export interface AePackageFolder extends FolderHandle {
  readonly path: string;
  readonly aerenderSafe: boolean;
  readonly aerenderReason?: string;
  writeFileAt(relPath: string, data: Blob | Uint8Array): Promise<void>;
}

export interface AeBuildResult {
  ok: boolean;
  /** The saved project, <package>/<name>.aep. */
  aep?: string;
  /** build-log.json as written by build.jsx ("" when AE could not write it). */
  log: string;
  /** build-log.json parsed. */
  result: unknown;
  /** Why it failed / what to check, in words. */
  notes: string[];
  /** The .aep was handed to the After Effects app (open -a). */
  opened: boolean;
  seconds: number;
  aerender: { code: number | null; timedOut: boolean; output: string };
}

export interface AeRenderedFrame {
  frame: number;
  width?: number;
  height?: number;
  /** Straight-alpha RGBA8, row 0 = top (unpremultiplied from aerender's TIFF). */
  rgba?: Uint8Array;
  /** The TIFF aerender wrote, inside the package's renders/. */
  file?: string;
  error?: string;
  seconds?: number;
}

export interface AeRenderResult {
  comp: { id: string; name: string; width: number; height: number; fps: number; duration: number };
  frames: AeRenderedFrame[];
  seconds: number;
  /** toolbox.json's `output` and `composition`, when the package has one. */
  manifest?: { output?: string; composition?: { id?: string; name?: string } } | null;
}

export interface AeShaderCheck {
  /** false: no tbxshader-check on this machine (`reason` says where main looked). */
  available: boolean;
  reason?: string;
  checker?: string;
  /** tbxshader-check's exit code: 0 ok, 1 errors, 2 usage / I/O / no device. */
  status?: number | null;
  /** Its --json line. */
  json?: Record<string, unknown> | null;
  stdout?: string;
  stderr?: string;
}

/** The desktop app's After Effects runner (electron/ae.js). Every path it
 *  hands to After Effects is one main built inside a package it created. */
export interface AfterEffectsRunner {
  /** <folder or main's export folder>/<name>.aepkg, fresh (" 2" … when taken). */
  createPackage(name: string, folder?: FolderHandle | null): Promise<AePackageFolder>;
  /** Headless build (aerender + a one-launch startup hook); `open` then opens
   *  the saved .aep in the After Effects app. */
  build(pkg: string, opts?: { open?: boolean }): Promise<AeBuildResult>;
  /** aerender the built main comp at comp frames (1–8, one launch each). */
  render(pkg: string, frames: number[]): Promise<AeRenderResult>;
  /** tbxshader-check --json on a .tbxfx. */
  checkShader(tbxfx: string): Promise<AeShaderCheck>;
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

  /** After Effects on this machine (desktop; null/absent on web or an older
   *  shell). `available` false still reports where main looked. */
  readonly aeCapabilities?: AeCapabilities | null;

  /** Build / render / check After Effects packages (desktop only). */
  runAfterEffects?: AfterEffectsRunner;

  /** Open a per-export log file. null = the shell has no file sink (web, or
   *  an older desktop shell); the exporter then logs to the console only. */
  openExportLog?(name: string): Promise<ExportLogSink | null>;

  /** Transcode a video the renderer's <video> couldn't decode into a
   *  Chromium-playable form (native ffmpeg). Returns the playable bytes +
   *  mime, or null. Only present on the native build. */
  transcodeVideoForPlayback?(
    bytes: ArrayBuffer,
    name: string
  ): Promise<{ bytes: ArrayBuffer; type: string } | null>;

  /** Build a decoder-only scrub proxy (1080p all-intra) for a clip and hand
   *  back a byte-range reader over it (specdocs/090526_video-scrub-
   *  optimizations.md M4). Null when the shell can't. Native build only. */
  makeScrubProxy?(
    bytes: ArrayBuffer,
    name: string
  ): Promise<{
    size: number;
    read(start: number, end: number): Promise<ArrayBuffer>;
    dispose(): void;
  } | null>;

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

  /** Desktop auto-update (electron-updater over GitHub Releases). Present only
   *  on the native build; no-ops in dev/unpackaged runs (check reports "none").
   *  State is push-driven: subscribe via onState. Spec: 070826_desktop-auto-update.md. */
  updates?: {
    /** Trigger a feed check; the outcome arrives via onState. */
    check(): Promise<void>;
    /** Download the available update; progress arrives via onState. */
    download(): Promise<void>;
    /** Quit, silently install, relaunch. */
    install(): void;
    /** Subscribe to update-state pushes; returns an unsubscribe fn. */
    onState(cb: (s: UpdateState) => void): () => void;
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
   *  (and desktop) can pick one. See specdocs/archive/062926_assets.md. */
  assets?: {
    /** The `assets/` folder beside the most-recently-opened .toolbox (desktop).
     *  null when none exists or no .toolbox was opened this session. */
    scanCurrent?(): Promise<AssetsFolderHandle | null>;
    /** Let the user choose an assets folder (web FSA / native dir dialog).
     *  null = cancelled / unsupported (non-Chromium web). */
    pick?(): Promise<AssetsFolderHandle | null>;
  };
}

/** One pushed update-state payload (see Platform.updates). */
export interface UpdateState {
  state: "checking" | "available" | "none" | "downloading" | "ready" | "error";
  /** Target version (available / ready). */
  version?: string;
  /** Download progress 0–100 (downloading). */
  percent?: number;
  /** Download speed in bytes/s (downloading). */
  bytesPerSecond?: number;
  /** Error description (error). */
  message?: string;
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
