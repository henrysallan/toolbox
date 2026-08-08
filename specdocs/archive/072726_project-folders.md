# Project folders — Private-tab folder hierarchy (spec, 2026-07-27)

Per-user folders for organizing cloud projects in the Private tab of the
load grid. Folders nest arbitrarily (Finder-style), navigation is
drill-in (folders render as tiles you click into, a breadcrumb returns
you up the chain), and projects/folders move via drag & drop. Purely an
organization layer over the listing — the editor, save paths, public
listings, live links, and `.toolbox` files are untouched.

Design decisions (owner Q&A):

- **Arbitrary nesting** — folders can contain folders. Cycle prevention
  on move (client guard + DB trigger backstop).
- **Drill-in tiles** — folders appear first in the grid/list alongside
  projects; clicking one enters it; a breadcrumb ("All › Work › WIP")
  in the toolbar navigates back up. No sidebar, no always-expanded
  sections.
- **Delete never deletes projects** — deleting a folder re-homes its
  contents (subfolders + projects) to the deleted folder's *parent*;
  DB-level `on delete set null` FKs are the safety net (contents fall
  to root if a row is deleted outside the client path).

## Data model (specdocs/project-folders-migration.sql)

- `public.project_folders`: `id uuid pk`, `user_id → profiles (cascade)`,
  `name text`, `parent_id → project_folders (set null)`, timestamps.
  RLS owner-only for all four verbs — folders are a private-tab concept;
  nothing about them is ever public.
- `public.projects.folder_id uuid → project_folders (set null)` —
  `null` = root. Public/live queries ignore it entirely.
- Guard trigger `project_folders_guard` (before insert/update of
  parent_id): rejects self-parenting, cycles (bounded ancestor walk),
  and cross-user parents. Runs as invoker, so RLS doubles as the
  "parent must be yours" check (another user's folder id reads as
  nonexistent).
- Idempotent, transactional, run by hand in the Supabase SQL editor —
  same contract as every other `specdocs/*-migration.sql`.

## Client API (src/lib/supabase/project-folders.ts)

Sibling module to `projects.ts`, same egress-aware conventions
(60-min session cache keyed to the signed-in user, 6s timeout,
offline degradation to cache/[], every mutation invalidates).

- `listFolders()` — ALL of the user's folders, flat; callers build the
  tree from `parent_id`. Returns `[]` on any error, which is also the
  **rollout-safe path**: if the migration hasn't been run, the folder
  fetch fails, the grid renders flat exactly as before, and folder
  mutations no-op with a console error.
- `createFolder(name, parentId)` / `renameFolder(id, name)` /
  `moveFolder(id, parentId)` — row CRUD. Move relies on the client
  cycle guard for UX and the DB trigger for enforcement.
- `deleteFolder(id, parentId)` — re-parents child folders and child
  projects to `parentId` first, then deletes the row. Partial failure
  is benign (children already moved, folder remains).
- `moveProjectToFolder(projectId, folderId | null)` — updates
  `projects.folder_id` **without bumping `updated_at`**: a drag into a
  folder must not conflict an open editor's optimistic-concurrency save
  (CAS matches on `updated_at`) and must not reorder the date sort.
- `projects.ts`: `ProjectRow` gains optional `folder_id`;
  `listPrivateProjects` selects it and retries without the column on a
  42703 (undefined column) so pre-migration DBs keep listing.

## UI (LoadGrid.tsx, Private tab only)

- **State**: `folderId: string | null` (current location, reset on tab
  switch or when the folder vanishes on refresh) + the fetched flat
  folder list. Visible items = folders with `parent_id === folderId`
  (sorted by the active sort key, name for "author"), then projects
  with `folder_id === folderId`. Folders always precede projects; the
  New Project tile keeps slot 0.
- **Toolbar**: breadcrumb chips appear in the flexible gap while inside
  a folder — "All" (root) then each ancestor; click to jump. A
  new-folder icon button (private tab, signed in) creates "New Folder"
  in the current location and immediately opens inline rename.
- **Folder tile/row**: folder glyph + name + direct-item count. Click
  enters. Right-click opens a small context menu (Rename / Delete —
  same fixed-position, click-outside-dismiss pattern as
  RateProjectPopover). Rename is an inline input on the tile label
  (Enter/blur commits, Escape cancels). Delete confirms via
  `window.confirm` and notes that contents move up a level.
- **Drag & drop** (pointer-based, `useTileDrag` in LoadGrid.tsx —
  native HTML5 DnD's washed-out static snapshot was replaced in the M4
  visual pass): pointerdown on a tile arms a gesture; past a 5px
  threshold the tile "lifts" into a fixed-position ghost (a React
  replica of the tile — list rows compact to a chip) that chases the
  cursor with a short rAF-lerp ease, grabbed at the exact click point.
  The source tile dims while its ghost flies. Drop targets — folder
  tiles/rows and breadcrumb chips (including "All" = root) — carry
  `data-drop-target="f:<id>"|"root"` and are hit-tested under the
  pointer with `elementFromPoint` (the ghost is pointer-events:none so
  it's seen through); a folder can't land on itself or any descendant.
  A valid release fades the ghost out in place; an invalid one glides
  it back to where it was picked up; Escape cancels (suppression holds
  until the button actually comes up so the cancel can't click
  through). The ghost's outer transform is owned exclusively by the
  rAF loop — it is deliberately NOT in the React style prop, or any
  re-render would snap it back to its start. Dragging with the pointer
  inside the scroll container within 36px of its top/bottom edge
  auto-scrolls the list each frame (speed scales with edge proximity;
  the hit test re-runs after each scroll since targets slide under a
  stationary pointer; hovering the toolbar/breadcrumbs never scrolls).
  Moves are **optimistic**:
  local state updates immediately, the row write runs behind it, and a
  failed write bumps the manual-refresh counter to resync. Plain
  clicks stay clicks — nothing engages below the threshold, and a real
  drag suppresses the click that follows pointerup.
- Public and Local tabs render exactly as before (no folder context is
  passed down). Empty folder shows "This folder is empty — drag
  projects here."
- New saves always land at root (`folder_id null`) — the save path
  doesn't know grid state; filing is a grid gesture. ("Save into
  current folder" is possible future work.)

## Milestones

- **M1 — data**: migration SQL, `project-folders.ts`, `folder_id` on
  `ProjectRow` with the 42703 fallback. *(shipped)*
- **M2 — navigation + folder CRUD**: drill-in filtering, breadcrumb,
  folder tiles/rows in both views, create/rename/delete with context
  menu + inline rename. *(shipped)*
- **M3 — drag & drop**: project→folder, folder→folder with cycle
  guard, breadcrumb drops, optimistic moves. *(shipped)*
- **M4 — drag visual pass**: HTML5 DnD replaced with the pointer-based
  lifted-ghost drag described above. *(shipped)*

## Future work (non-blocking)

- "Move to…" context-menu item on project tiles (keyboard/no-drag path).
- Save-into-current-folder from the editor.
- Folder color/emoji tags; folder thumbnails from contained projects.
