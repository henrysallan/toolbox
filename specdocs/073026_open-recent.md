# File → Open Recent (2026-07-30)

A native-style "Open Recent ▸" submenu in the File menu listing the
projects the user most recently opened — cloud rows and local `.toolbox`
files alike — reopenable with one click. Backed by a **local cache**
(localStorage + IndexedDB), never the cloud: recents are per-machine.

## Design decisions

- **One merged list, recency-sorted.** Cloud and local entries interleave
  by `lastOpened`; each row shows a dim right-side hint (`cloud` / `local`)
  in the slot MenuRow already renders shortcuts in. Display cap: 10.
- **Three entry kinds**, one storage story each:
  - `cloud` — `{id, name}` in localStorage (`toolbox.openRecent`).
    Reopen = the existing `handleLoadProject(id)` path.
  - `local` (web) — the File System Access `FileSystemFileHandle` persisted
    in IndexedDB (handles don't survive in localStorage), metadata
    `{refId, name}` in the same localStorage list. Reopen = get handle →
    `requestPermission({mode:"read"})` (menu click = user activation) →
    `getFile()` → the existing `loadToolboxFile(file)`. Only recorded when
    the browser has `showOpenFilePicker` (Chromium — same degrade posture
    as local-fonts); the legacy `<input type=file>` fallback can't reopen
    a file, so those opens are deliberately not recorded.
  - `local-native` (desktop) — NOT stored by the renderer. Merged at list
    time from the existing Electron recents (`platform.recents.list()`,
    recorded automatically by files.js on native open/save dialogs, dead
    paths pruned by main). Reopen = the existing `handleOpenLocalRecent`.
    Single source of truth stays in main; the LoadGrid "Local" tab and
    this menu read the same list.
- **Web File → Load… upgrade:** on Chromium the web branch now uses
  `showOpenFilePicker` (so the handle can be recorded) and falls back to
  the old `<input type=file>` only when the API is missing. A picker
  cancel does nothing (no fallback dialog).
- **Recording sites** (all in EffectsApp): cloud load, every successful
  cloud save (update / save-as insert / save-as overwrite / copy-on-save
  fork / incremental — a saved row is an openable recent), rename patches
  the stored name WITHOUT bumping recency. Local web opens record at
  pick time (matches desktop, which records at dialog time). Desktop
  opens/saves are recorded by main already — the renderer just refreshes.
- **Cloud prune policy: none on failure.** `loadProject` returns null for
  not-found AND network errors indistinguishably, so a failed open only
  toasts — it never drops the entry (a flaky connection must not eat the
  list). Web-local entries DO self-prune when the handle's file is gone
  (NotFoundError on `getFile`), mirroring main's path pruning.
- **Clear Menu** clears everything: the localStorage list, the IDB
  handles, and each native recent via `platform.recents.remove`. That
  also empties the desktop LoadGrid "Local" tab — intentional; they are
  the same "recent local files" concept (macOS Clear Menu behaves the
  same w.r.t. OS recents).
- **No unsaved-work prompt** before opening a recent — matches the
  existing Load…/Projects… behavior (loaders push an undo snapshot only
  after a successful deserialize).

## Pieces

- `src/lib/recent-projects.ts` (NEW) — entry types, localStorage list
  (cap 20), tiny inline IDB helper (`toolbox-recent-files`/`handles`),
  FSA picker-with-record, open-by-refId with permission dance + prune,
  native merge in `listRecentProjects()`, subscribe/notify so EffectsApp
  state refreshes on any mutation. SSR-safe (no window at module scope).
- `MenuBar.tsx` — `MenuItem` gains `{kind:"submenu", label, items}`
  (one level); MenuDropdown tracks the hovered submenu row and renders
  the flyout at `left:100%` inside the row's relative wrapper (wrapper
  containment keeps it open crossing the border; hovering a sibling row
  closes it). File menu: New / Load… / Projects… / **Open Recent ▸** /
  Assets. Empty list → disabled "No Recent Projects".
- `EffectsApp.tsx` — `recentProjects` state + subscribe effect, record
  calls at the sites above, `handleOpenRecent` fan-out (cloud → cloud
  loader, local-native → recents.open, local → handle open), Clear wiring,
  explicit refresh after desktop-side records (loadToolboxFile /
  handleSaveToFile) since those mutate main's list out-of-band.

## Verification

Manual (no test runner): web Chromium — open cloud project → appears in
submenu; reopen from submenu; Load… a .toolbox → reopen from submenu
(permission prompt once); delete the file on disk → open attempt toasts
and the entry disappears; Safari-profile (no FSA) → Load… still works via
input, no local entry recorded; Clear Menu empties the list. Desktop —
native recents appear merged with cloud rows.
