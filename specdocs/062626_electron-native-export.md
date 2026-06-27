# Electron desktop build + native export / file I/O (spec, 2026-06-26)

Status: **in progress** (updated 2026-06-27). Goal of this doc: dual-deploy the
existing web app as a macOS Electron app whose **only** behavioral difference is
that heavy export runs through **native ffmpeg** and file open/save goes through
**native OS dialogs** — with zero duplicated feature work between the two targets.

Implementation status:
- **M1 shell + platform adapter** — done.
- **M2 native file I/O** (save/open/folder dialogs, .toolbox, media relink) — done.
- **M3 native ffmpeg video export** (rawvideo→stdin streaming) — done; verified.
- **M3.1 transcode-on-import** — added: videos Electron's Chromium can't decode
  (10-bit/4:2:2 H.264, HEVC, ProRes) are transcoded via native ffmpeg on import
  (10-bit→VP9 profile 2, 8-bit→H.264). Not in the original plan; surfaced in testing.
- **M4 GIF + sequence** — sequence delivery is native via M2; GIF works in the
  desktop build via the existing ffmpeg.wasm + gifsicle-wasm path (runs fine in
  Electron's Chromium). Native GIF *encoding* deferred per this doc's own hedge
  (below) — it's a perf optimization, not a fix, and GIF isn't the pain point.
- **M5 packaging** — electron-builder config (lean `files`, asarUnpack ffmpeg-static,
  unsigned mac dmg); `npm run electron:build`. Verified a `--dir` build (app.asar
  lean, ffmpeg binary unpacked & executable). Notarization still deferred.
- **M6 docs/devlist** — pending.

## Problem

Big exports choke on the web "max" tier. Confirmed cause in
[export-ffmpeg.ts](../src/lib/export-ffmpeg.ts):

- `getFfmpeg()` loads **single-threaded** ffmpeg.wasm (no SharedArrayBuffer),
  so encoding can't use multiple cores ([export-ffmpeg.ts:31](../src/lib/export-ffmpeg.ts#L31)).
- The capture loop writes **every PNG frame into in-memory MEMFS** before
  encoding ([export-ffmpeg.ts:199](../src/lib/export-ffmpeg.ts#L199)). A long /
  high-res / ProRes export exhausts the wasm heap and the tab's memory ceiling.

Native ffmpeg in a desktop process fixes both: real threads, real RAM, and we
can **stream frames** to it instead of buffering them all.

## Decisions (locked with owner, 2026-06-26)

1. **App loading**: Electron is a **thin shell that loads the deployed web
   URL** (the live Vercel site). Native power is injected via a preload bridge.
   No second deployment, no embedded server. (Future option: embed a
   standalone build for offline — explicitly out of scope now.)
2. **ffmpeg binary**: **bundle `ffmpeg-static`** inside the app. Zero user
   setup, version-locked.
3. **v1 scope**: native **export AND full native file I/O** (open dialogs,
   .toolbox open/save, media relink, export delivery) — all behind one adapter.
4. **OS targets**: **macOS only** for now. Architecture must not preclude
   Windows/Linux later (per-OS ffmpeg binary + build target is all it takes).

## Non-goals (v1)

- Offline / embedded app server. (Loads remote URL; needs internet.)
- Auto-update, notarized public distribution, App Store. (Local/ad-hoc build is
  fine for now; notarization is a packaging task we can add later.)
- Changing the web app's behavior at all. Web keeps its current 3 tiers, FSA
  folder mode, and anchor-download delivery untouched.
- Touching `src/engine/**` or `src/nodes/**` (invariant #1 — they get copied
  verbatim into exported apps and must stay platform-agnostic).

## The seamlessness contract (why this won't fork the codebase)

The whole design rests on **one capability-detected adapter**:

```
src/lib/platform/
  index.ts        platform — the single accessor. Detects window.toolboxNative.
  types.ts        Platform interface (the stable seam).
  web.ts          Web implementation: current behavior, verbatim.
  native.ts       Electron implementation: calls window.toolboxNative.*
```

```ts
// src/lib/platform/index.ts (sketch)
import { webPlatform } from "./web";
import { nativePlatform } from "./native";
export const isNative = typeof window !== "undefined" && !!window.toolboxNative;
export const platform: Platform = isNative ? nativePlatform : webPlatform;
```

Rules that keep maintenance single-track:

- **The same JS bundle runs on both targets.** Electron loads the same Vercel
  URL, so `native.ts` ships in the normal web bundle and is simply inert when
  `window.toolboxNative` is absent. Nothing is conditionally compiled.
- **Feature code never branches on platform.** It calls `platform.saveFile(...)`
  / `platform.encodeVideo(...)`. New export features get the native path for
  free the moment they go through the adapter.
- **The interface is small and append-only.** Adding a capability = one method
  in `types.ts` + one impl in each of `web.ts` / `native.ts`. The web impl is
  always "what we do today," so the web target can never regress.
- **All Electron-only code lives in a top-level `electron/` dir** that is *not*
  part of the Next build. The Next app gains only `src/lib/platform/**` plus an
  ambient type for `window.toolboxNative`. The `next build` output is unchanged.

## Architecture

### Process map

```
┌─ Electron main (Node) ──────────────────────────────┐
│  electron/main.ts      BrowserWindow → loads URL     │
│  electron/preload.ts   contextBridge → window.toolboxNative
│  electron/ffmpeg.ts    spawn ffmpeg-static, stream stdin, parse progress
│  electron/files.ts     dialog.showSave/OpenDialog, fs read/write
│  electron/ipc.ts       ipcMain handlers (validated)  │
└──────────────────────────────────────────────────────┘
        ▲  contextBridge (contextIsolation: true, sandbox)
        │  window.toolboxNative.* (narrow, validated API)
┌─ Renderer (Chromium) = the deployed web app ─────────┐
│  src/lib/platform/native.ts  → window.toolboxNative   │
│  src/lib/platform/web.ts     → DOM / FSA / ffmpeg.wasm│
│  EffectsApp + export-*.ts call platform.*             │
│  WebGL/WebGPU engine + renderFrame loop UNCHANGED     │
└──────────────────────────────────────────────────────┘
```

### Dev vs prod loading (the only env branch in Electron)

```ts
// electron/main.ts
const url = process.env.TOOLBOX_DEV_URL          // "http://localhost:3000" in dev
         ?? "https://<your-vercel-domain>";       // deployed app in prod
win.loadURL(url);
```

So `npm run dev` + Electron-in-dev points at the live `next dev`; the packaged
app points at Vercel. Same renderer code either way.

## Native ffmpeg export — data flow (the core of v1)

The renderer keeps owning the **frame loop and the engine settle logic** (the
two-pass deterministic render in EffectsApp must stay renderer-side — it drives
WebGL/WebGPU and `awaitMediaSettle`). Only the **encode tail** moves to native.

Streaming design (no whole-export buffering, no temp PNG pile):

1. **Begin** — renderer: `const session = await platform.encodeVideoBegin(spec)`
   where `spec` mirrors today's `FfmpegExportOptions` (container, codec, crf,
   proresProfile, alpha, fps, width, height, durationFrames, audioWav?) **minus**
   `canvas`/`renderFrame` (those stay in the loop) **plus** a chosen output path.
   - Native main spawns `ffmpeg-static` reading **`-f rawvideo -pix_fmt rgba -s
     WxH -framerate N -i -`** from **stdin** (rawvideo = no PNG encode/decode
     cost; straight alpha preserved — the engine already keeps straight alpha
     and `blitToCanvas` disables BLEND, so canvas pixels are non-premultiplied,
     consistent with the ProRes-alpha note in the devguide).
   - Encoder args reuse the **exact** `buildEncoderArgs()` / `buildAudioArgs()`
     logic from [export-ffmpeg.ts:96](../src/lib/export-ffmpeg.ts#L96) — lift
     that pure arg-building into a **shared module** (`export-ffmpeg-args.ts`)
     imported by both the wasm path and the native main process, so ProRes/
     H.265/alpha behavior is byte-identical across targets and maintained once.
2. **Per frame** — renderer runs the existing loop: `renderFrame(i,t)` → settle →
   read pixels (`gl.readPixels` / `getImageData`, RGBA8) → `await
   platform.encodeVideoFrame(session, pixelBuffer)`. The `await` provides
   **backpressure** (resolves only when main has drained the chunk into
   ffmpeg.stdin; main pauses reads when `stdin.write` returns false).
3. **End** — `await platform.encodeVideoEnd(session)` closes stdin; main awaits
   ffmpeg exit. Audio: write the same WAV the wasm path builds
   ([export-audio.ts](../src/lib/export-audio.ts) `audioBufferToWav`) to a temp
   file and add `-i audio.wav` (simplest, robust) — or a second pipe later.
4. **Progress** — main parses ffmpeg stderr `frame=`/`time=` → IPC events →
   existing `onProgress(label, fraction)` so the UI is unchanged.
5. **Delivery** — output is written straight to the user-chosen path from the
   native save dialog. No Blob, no download anchor, no memory copy.

Fallback path (rawvideo issues / cross-platform later): write PNGs to a temp
dir via the bridge and run image2 demuxer. Same args module. Pipe is primary.

GIF and image-sequence get the same treatment: GIF reuses native ffmpeg
palettegen/paletteuse + (later) native gifsicle; sequence writes stills to a
chosen folder via native fs instead of the FSA `showDirectoryPicker` path.

## Native file I/O

Adapter methods, each with a web impl (current behavior) and a native impl:

| Capability | Web impl (today) | Native impl (Electron) |
|---|---|---|
| `saveFile(blob/bytes, suggestedName)` | `downloadBlob` ([export.ts:51](../src/lib/export.ts#L51)) | `dialog.showSaveDialog` → `fs.writeFile` |
| `saveToFolder()` + `writeFileInFolder` | FSA `showDirectoryPicker` (Chromium-only; exportSequence/renderQueue) | `dialog.showOpenDialog({properties:['openDirectory']})` → `fs.writeFile` |
| `pickOpenFiles({kind, multiple})` | FSA `showOpenFilePicker` / `<input>` ([media-relink.ts:173](../src/lib/media-relink.ts#L173)) | `dialog.showOpenDialog` → return paths→`File`-like |
| `readProjectFile` / `writeProjectFile` (.toolbox) | JSZip Blob in/out ([project-file.ts](../src/lib/project-file.ts)) | same JSZip, but read/write bytes via native fs path |

Notes:
- Media relink's IndexedDB FSA-handle persistence is web-only; native simply
  re-reads from the stored absolute path (more robust — paths don't expire like
  FSA permissions do). The `matchFilesToMissing` fuzzy match is unchanged.
- `.toolbox` packaging logic (hashing, manifest, asset inlining) is identical;
  only the byte source/sink swaps. Keep `crypto.subtle.digest` (available in
  Electron renderer).

## Seam-by-seam change list

Renderer (Next app) — minimal, additive:

- **New**: `src/lib/platform/{index,types,web,native}.ts`.
- **New**: `src/types/toolbox-native.d.ts` — ambient `Window.toolboxNative`.
- **Refactor (no behavior change)**: extract `buildEncoderArgs`/`buildAudioArgs`
  from [export-ffmpeg.ts](../src/lib/export-ffmpeg.ts) into
  `src/lib/export-ffmpeg-args.ts`; import in both wasm + native.
- **Reroute calls** (web path stays default): `downloadBlob` callsites,
  FSA folder blocks in `exportSequence`/`renderQueue`, `pickMediaFiles`,
  `readProjectFile`/`writeProjectFile`, and the export-tier selection in
  `exportVideo` (`platform.canEncodeNative` → native streaming path, else
  existing wasm/webcodecs/MediaRecorder tiers).

Electron (new top-level dir, outside Next build):

- `electron/main.ts`, `electron/preload.ts`, `electron/ffmpeg.ts`,
  `electron/files.ts`, `electron/ipc.ts`.
- `package.json`: add `electron`, `electron-builder`, `ffmpeg-static` as
  devDeps; scripts `electron:dev`, `electron:build` (macOS target). The
  existing `dev`/`build`/`start` web scripts are untouched.

## Security (loading a REMOTE url with native powers — must get right)

Loading remote content into a process that can spawn ffmpeg and write files is
the real risk here. Mitigations are mandatory, not optional:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Renderer
  never sees Node — only the narrow `window.toolboxNative` surface.
- **The bridge exposes intent-level operations, not primitives.** No
  `writeFile(path, data)` taking an arbitrary path from the page. Instead
  `saveFile(bytes, suggestedName)` where **the path comes from a native dialog
  the user clicks** — the page proposes a name, the OS/user chooses location.
  ffmpeg is spawned only with our own arg builder + validated codec enum, never
  a page-supplied command line.
- Lock navigation to the trusted origin: `will-navigate` / `setWindowOpenHandler`
  reject anything off-origin; external links open in the system browser.
- Pin the production URL; consider a CSP and (later) loading only over HTTPS
  with cert checks. Document that compromising the deployed site = native
  exposure, which is why the bridge stays narrow.

## Risks / open questions

- **Auth/cookies in Electron**: Supabase OAuth in a desktop window — verify the
  `auth/callback` flow works in `BrowserWindow` (likely fine; may need
  `setWindowOpenHandler` to keep the OAuth popup in-app or route back). Test
  early.
- **rawvideo size on the pipe**: 4K RGBA ≈ 33MB/frame; backpressure handling
  must be correct or we balloon memory. The `await` per frame is the guard;
  validate with a long 4K ProRes export.
- **ffmpeg-static codecs**: confirm the bundled build has `prores_ks`,
  `libx265`, `libvpx-vp9`, `libaom-av1` (the codecs `buildEncoderArgs` emits).
  If not, swap to a fuller static build. This gates which tiers go native.
- **App size**: ffmpeg-static adds ~70–80MB. Acceptable per decision #2.
- **gifsicle**: native gifsicle binary vs keeping `gifsicle-wasm` in renderer.
  v1 can keep gifsicle-wasm and only move the ffmpeg palettegen stage native;
  revisit if GIFs are also a pain point.

## Milestones

1. **Electron shell** — `electron/main.ts` + preload loading the dev URL;
   `window.toolboxNative` stub (returns "not implemented"); `platform` adapter
   scaffold with web impls = current behavior (no renderer behavior change).
   Verify the app boots, renders, and exports exactly as web today.
2. **Native file I/O** — implement `saveFile`, folder save, `pickOpenFiles`,
   .toolbox open/save over native dialogs+fs; reroute the renderer callsites
   through `platform`. Verify save/open/relink on macOS, web still identical.
3. **Native ffmpeg video export** — shared `export-ffmpeg-args.ts`; main-process
   spawn + rawvideo stdin streaming + stderr progress; reroute `exportVideo`'s
   heavy tier. Verify a big ProRes-4444-alpha export that previously failed on
   web now completes natively, alpha intact.
4. **Native GIF + sequence** — route palettegen + sequence delivery native.
5. **Packaging** — `electron-builder` macOS target bundling ffmpeg-static;
   `electron:build` produces a runnable `.app`. (Notarization deferred.)
6. **Docs** — update [061226_devguide.md](061226_devguide.md) Export +
   Persistence sections with the platform-adapter seam; add a devlist entry.

## Verification checklist

- Web target unchanged: existing export tiers, FSA folder mode, downloads all
  behave as before (the web impls are the old code, verbatim).
- Electron: big export that OOM'd on web completes; ProRes alpha preserved;
  GIF opens in macOS Preview (the existing gifsicle constraint); save/open
  dialogs are native; `.toolbox` round-trips.
- One feature, both targets: add a trivial new "save X" call through
  `platform.saveFile` and confirm it works on web (download) and Electron
  (dialog) with no per-target code.
