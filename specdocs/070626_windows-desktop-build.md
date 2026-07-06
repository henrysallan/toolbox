# Windows desktop build + native window controls (spec 070626)

Status: **in progress** (started 2026-07-06)

Extends the macOS Electron work (062626_electron-native-export.md). Goal: ship
the same app as a **Windows** desktop build alongside the mac one, from one
codebase, with **Windows-native window controls** in the custom title bar.

The 062626 spec already called this out (Decision #4, "OS targets"): *"macOS
only for now. Architecture must not preclude Windows/Linux later — per-OS ffmpeg
binary + build target is all it takes."* This spec is that follow-through, plus
the one piece that isn't free: the frameless-window controls are macOS-shaped
(traffic lights, left, no maximize) and need a Windows variant.

## Decisions (locked with owner 2026-07-06)

1. **Control placement: top-right** (Windows convention), not left. The mac
   build keeps its left traffic lights; only the Windows build moves them right.
2. **Button set: minimize / maximize-restore / close** — the true Windows set.
   This adds a real maximize/restore toggle (new IPC + maximized-state
   tracking + glyph swap). Fullscreen (the mac build's third light) is dropped
   from the Windows row (F11 territory, not a caption button on Windows).
3. **Signing: unsigned for now.** Mirrors how the mac build started. Users get a
   SmartScreen "unknown publisher" prompt they can bypass ("More info → Run
   anyway"). CI is structured so a cert can be dropped in later with no rework.
4. **Package format: NSIS installer** (`.exe`), assisted (not one-click):
   Start-menu shortcut, uninstaller, user-chosen install dir. x64 only
   (Windows-on-ARM is niche; add an arm64 target later if needed).

## What's already cross-platform (no change)

Confirmed by audit — these need nothing:

- `next.config.ts` `DESKTOP_BUILD` → `output:'standalone'` gating.
- `scripts/prepare-standalone.mjs` (`cpSync`/`path.join`, pure Node).
- `electron/server.js` (`utilityProcess.fork`, `path.join`, pinned
  `127.0.0.1:38274`), `electron/files.js`, `recents.js`, `assets.js`.
- `electron/ffmpeg.js` — `require("ffmpeg-static")` resolves `ffmpeg.exe` on
  win32 automatically; the `app.asar`→`app.asar.unpacked` string redirect works
  on Windows paths. `npm ci` on a Windows runner fetches the win32-x64 binary.
- `electron/main.js` platform guards: `setDevDockIcon` early-returns off
  darwin; `window-all-closed` already quits off darwin (correct Windows
  behavior).
- The `-webkit-app-region` drag/no-drag regions in `MenuBar.tsx` — Electron
  honors them on Windows too.

## The renderer gap: OS is invisible to the UI

`electron/preload.js` exposes `platform: process.platform` on the raw bridge,
but the clean `Platform` seam (`src/lib/platform/`) never surfaces it, and no
renderer code reads it. So today the UI can't tell Windows from Mac, and
`WindowControls.tsx` renders mac traffic lights on every native target.

Fix: add a single **`os`** discriminator to the `Platform` interface
(append-only, per the seam's rules).

## Milestones

### M1 — Plumbing: OS field + maximize IPC

Platform seam (`src/lib/platform/`):
- `types.ts`: add `readonly os: "mac" | "windows" | "linux"` to `Platform`.
  Extend the optional `windowControls` capability with `toggleMaximize(): void`,
  `isMaximized(): Promise<boolean>`, and
  `onMaximizeChange(cb: (max: boolean) => void): () => void` (unsubscribe
  return). Existing `minimize`/`toggleFullscreen`/`close` stay.
- `native.ts`: `get os()` maps `bridge().platform` (`darwin`→`mac`,
  `win32`→`windows`, else `linux`). Forward the three new `windowControls`
  methods to the bridge.
- `web.ts`: `get os()` best-effort from `navigator` (SSR-guarded, default
  `"mac"`). `windowControls` stays absent (gates controls off on web).

Bridge:
- `src/types/toolbox-native.d.ts`: add `toggleMaximize`, `isMaximized`,
  `onMaximizeChange` to the `window` block.
- `electron/preload.js`: `toggleMaximize` → `send("toolbox:win:toggleMaximize")`;
  `isMaximized` → `invoke("toolbox:win:isMaximized")`; `onMaximizeChange` →
  `ipcRenderer.on("toolbox:win:maximize-changed", …)` returning a remover.

Main (`electron/main.js`):
- `registerWindowControls`: add `ipcMain.on("toolbox:win:toggleMaximize")` →
  `w.isMaximized() ? w.unmaximize() : w.maximize()`; `ipcMain.handle(
  "toolbox:win:isMaximized")` → `!!w?.isMaximized()`.
- In `createWindow`, wire `win.on("maximize"|"unmaximize")` →
  `webContents.send("toolbox:win:maximize-changed", win.isMaximized())` so the
  glyph tracks native maximize (e.g. Win+Up, snap, double-click title bar).

### M2 — Windows-native controls + right-side placement

- `WindowControls.tsx`: branch on `platform.os`. Mac path unchanged (traffic
  lights). Windows path renders three flush, full-height, 46px-wide **caption
  buttons** (minimize / maximize-restore / close), Segoe Fluent Icons / Segoe
  MDL2 Assets glyphs (``/``/``/``), Windows hover
  states (subtle light overlay on min/max, `#c42b1c` red on close), maximize↔
  restore glyph driven by `onMaximizeChange`. `WebkitAppRegion:"no-drag"`.
- `MenuBar.tsx`: render `<WindowControls/>` on the **left** only when
  frameless-and-mac; render it flush in the **top-right** corner when
  frameless-and-windows (drop the bar's right padding there so the caption
  buttons touch the edge, Win11-style). Bar height (`BAR_HEIGHT+10 = 32`)
  already matches the Win11 title bar.
- `Landing.tsx`: same OS branch for its standalone `<WindowControls/>` (top-left
  on mac, top-right on windows).

### M3 — electron-builder Windows target

- `package.json` `build`: add a `win` block (`target: nsis`, `arch: [x64]`,
  `icon: build/icon.ico`) + an `nsis` block (`oneClick:false`,
  `perMachine:false`, `allowToChangeInstallationDirectory:true`). Shared
  `files`/`asarUnpack`/`publish` already apply.
- `build/icon.ico`: generate a multi-res ICO from the existing app art, commit
  it (CI needs it present; unsigned build otherwise needs no Windows assets).
- Scripts: `electron:build:win`, `desktop:build:win`,
  `desktop:publish:win` (`… && electron-builder --win [-p always]`). Left
  `electron:dev` (the bash-env-prefix dev-URL variant) mac-only — on Windows,
  dev via `dev:desktop` (the portable `.mjs` runner) or `electron` (embedded
  server, no env prefix). Not worth a `cross-env` dependency for a dev-only
  convenience script.

### M4 — CI: parallel Windows job

Rework `.github/workflows/release.yml` (still `v*`-tag / `workflow_dispatch`
triggered) into three jobs:
- `ensure-release` (ubuntu): the existing "pre-create the GitHub Release" guard,
  extracted so **both** OS jobs attach to one release instead of racing to
  create it. (Two parallel `gh release create`s would collide.)
- `build-mac` (`macos-14`, `needs: ensure-release`): unchanged steps; drops its
  own inline ensure step.
- `build-win` (`windows-latest`, `needs: ensure-release`): checkout →
  setup-node@20 → `npm ci` → build export template → `npm run
  desktop:publish:win`. Env: the two `NEXT_PUBLIC_SUPABASE_*` build vars +
  `GH_TOKEN`. No Apple/CSC secrets. `shell: bash` on the scripted steps (github
  runners ship Git Bash).

### M5 — Docs

Update `061226_devguide.md` "Desktop (Electron) build": it's now mac **and**
Windows; note the `platform.os` discriminator, the Windows caption-button
variant, the maximize IPC additions, and the `win`/`nsis` build config + CI
job. Land a devlist entry.

## Invariants preserved

- **Seam append-only**: `os` + three `windowControls` methods are additive; the
  mac contract is untouched. `src/engine` + `src/nodes` stay platform-agnostic.
- **One bundle, no platform branching in feature code**: only `WindowControls`,
  `MenuBar`, and `Landing` (the title-bar surface) read `platform.os`, and only
  to pick control chrome — same pattern as the existing `isNative` gate.
- **Web can't regress**: `windowControls` absent on web ⇒ no controls render;
  `os` there is cosmetic and unused.

## Open / deferred

- Windows code signing (cert + CI secrets) — deferred; structure is ready.
- arm64 Windows target — deferred.
- Auto-update (electron-updater) — not used on mac either; out of scope.
- Landing Download button (`Landing.tsx`) is **OS-contextual**: it sniffs the
  visitor's OS (`platform.os` via navigator on web) and leads with a primary
  pill for that platform (macOS / Windows), with the other platform as a quieter
  "Also for …" link below — both builds one click away. Both point at the
  `releases/latest/download/` redirect with version-less asset names
  (`Toolbox-arm64.dmg` / `Toolbox-Setup.exe`), so the URLs are stable across
  releases. Linux/unknown visitors lead with macOS (no Linux build).
