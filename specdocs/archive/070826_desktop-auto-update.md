# Desktop auto-update (spec 070826)

Status: **in progress** (started 2026-07-08)

In-app updater for both desktop builds (macOS + Windows), extending
070626_windows-desktop-build.md. UX (locked with owner): Toolbox checks for a
new release quietly ~10s after launch when online (and via a manual
"Check for Updates…" item); if one exists, an **"Update Toolbox to vX.Y.Z"**
item appears in the **Toolbox menu**; clicking it downloads with a **corner
progress toast** (bar + % + speed), which flips to **"Restart to Update"**;
that quits, installs over the old version, and relaunches.

## Mechanism: electron-updater over GitHub Releases

We don't write a custom download/install script — `electron-updater` (the
electron-builder companion) does the whole flow natively, and **our CI already
publishes its feed**: `latest.yml` / `latest-mac.yml` + `.blockmap` files have
been on every release since v0.2.0 (electron-builder emits them for the GitHub
publish provider). Blockmaps give **differential downloads** — users pull only
changed blocks, not the full 136–170 MB installer.

- **Windows (NSIS)**: supported unsigned (our current state). Update installs
  silently (`quitAndInstall(true, true)` → NSIS `/S` + relaunch).
- **macOS**: Squirrel.Mac **requires a signed app** (ours is signed +
  notarized ✓) and installs from a **`.zip`, not the dmg** — so the mac build
  gains a `zip` target alongside `dmg` (dmg stays for the landing download;
  the zip + its blockmap ride on the release for the updater).
- `app-update.yml` (feed pointer) is embedded automatically at package time
  from the `publish` block in package.json. Reads GitHub Releases *latest*.
- Dev / unpackaged runs (`dev:desktop`, `npm run electron`): updater no-ops
  (`app.isPackaged` guard) — manual check reports "Up to Date".

## The packaging wrinkle: vendor-bundling electron-updater

Our electron-builder `files` config deliberately excludes `node_modules/**`
(the Next standalone carries its own traced copy; the top-level tree must not
ship). So `require("electron-updater")` would not resolve in the packaged
app, and whitelisting it means chasing ~15 transitive deps that drift.

Instead, `desktop:prepare` **bundles it once with esbuild** into
`electron/vendor/electron-updater.cjs` (platform=node, external:electron) —
standard practice in electron-vite templates. The `electron/**/*` files glob
ships it; `electron/vendor/` is gitignored. `electron/updater.js` lazy-requires
the bundle in a try/catch, so dev runs (where it may not exist) and any bundle
failure degrade to "updater unavailable", never a crash.

## Architecture (same seam pattern as windowControls)

- **`electron/updater.js`** (new): hosts `autoUpdater` (`autoDownload=false`).
  IPC: `toolbox:update:check` / `:download` (invoke), `:install` (send →
  `quitAndInstall(true, true)`). All updater events broadcast one
  **`toolbox:update:state`** payload to every window:
  `{ state: "checking"|"available"|"none"|"downloading"|"ready"|"error",
     version?, percent?, bytesPerSecond?, message? }` — renderer state is
  driven purely by these pushes (works across electron-updater versions;
  no reliance on `checkForUpdates()`'s resolved shape).
- **`electron/preload.js`**: `updates.{check,download,install,onState}`
  (onState returns an unsubscribe, same shape as `onMaximizeChange`).
- **Platform seam**: optional `updates` capability on `Platform` +
  `UpdateState` type (types.ts); native.ts forwards with optional-chaining
  guards (an old shell loading a newer remote renderer just lacks the
  capability); web.ts omits it — UI gates on presence.
- **`useDesktopUpdates`** (new hook, components/effects): subscribes to
  onState, fires the one launch check (10s post-mount, native only, silent on
  failure), exposes `{ status, check, download, install }`. Single consumer:
  MenuBar. Client-side it also derives the transient "Up to Date ✓" display
  after a *manual* check (launch checks stay silent when nothing's new).
- **MenuBar**: one state-driven slot in the Toolbox menu, right under the
  version row: "Check for Updates…" → "Checking…" → "Update Toolbox to vX" →
  "Downloading update… NN%" → "Restart to Update" (or transient "Up to
  Date ✓"). Errors revert to "Check for Updates…" (logged to console).
- **`UpdateToast`** (new, rendered by MenuBar): fixed bottom-right card.
  Downloading: title + progress bar + % + MB/s. Ready: "Restart to Update"
  button + dismiss (dismiss hides the toast; the menu item still shows
  "Restart to Update"). `autoInstallOnAppQuit` stays default-on, so a
  downloaded-but-not-restarted update installs on next quit anyway.

## Release/versioning notes

- A release now touches **three version spots**: package.json `version`,
  `CURRENT_VERSION` via a new entry in src/lib/changelog.ts (the menu label),
  and the git tag. Keep them in sync.
- CI needs **no changes**: the mac job picks up the added zip target
  automatically; `-p always` uploads feed files as before.
- **Testing reality**: the full update loop can only be proven across two
  releases — ship v0.3.0 (first updater-capable build), then cut v0.3.1 and
  watch v0.3.0 offer/download/install it, on both OSes. Pre-release smoke
  test: local `--dir` build → launch → manual check runs cleanly against the
  live feed (expects "Up to Date" since local version ≥ latest).

## Deferred

- Update channels / prereleases (beta feed) — `releaseType: "release"` only.
- Release notes display in-app (changelog popover already exists).
- Auto-download without user click (kept manual by design).
