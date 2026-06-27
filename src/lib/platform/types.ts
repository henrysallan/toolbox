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
}
