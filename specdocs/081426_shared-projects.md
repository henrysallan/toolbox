# Shared projects — collaborators, advisory editing lease, safe saves

Multiple users open, edit, and save ONE project row. No realtime layer —
no websockets, no live cursors, no Supabase Realtime. Everything is
plain reads/writes plus three tiny RPC groups, consistent with the
egress-aware philosophy in projects.ts (staleness is opted into via the
refresh button, never fought with polling).

---

## HANDOFF STATE (08/19/26)

**Implemented and gates-green: M1, M2, M3, and the first slice of M4
(local recovery autosave).** All milestone sections below are written
AS BUILT — they describe shipped code, not TODOs. The only unbuilt work
is in "Remaining work" at the bottom.

**Nothing is committed.** The entire feature exists as working-tree
changes, interleaved with the owner's concurrent live-link work (they
edit EffectsApp.tsx / MenuBar.tsx / FileNameMenu.tsx between and during
sessions — re-read any region before editing it; a duplicate
`saveStateRef` collision has already happened once this way). Committing
is the owner's call.

### Pending owner actions

1. **Run the three migrations, in order**, in the Supabase SQL editor
   (all idempotent, safe to re-run):
   1. `specdocs/shared-projects-migration.sql` (M1 — collaborators,
      updated_by, triggers, RLS, Storage policies)
   2. `specdocs/shared-invites-migration.sql` (M2 — invites + RPCs)
   3. `specdocs/shared-lease-migration.sql` (M3 — lease + RPCs)
   Until they run, the app degrades exactly to pre-feature behavior:
   collaborator lookups → false/[], Shared tab empty, `/join` 404s,
   lease calls no-op, conflict dialog shows "someone" with no stamp.
   (M4's recovery autosave needs no migration — purely local.)
2. After running them, the two-account manual checklist under
   "Verification" below.
3. Once verified, move the three `.sql` files to `specdocs/sql_archive/`
   (house convention: migrations start in specdocs/, archive after run).

### File inventory

New files:

| File | Role |
|---|---|
| `specdocs/shared-projects-migration.sql` | M1 SQL (authoritative — supersedes any schema sketch) |
| `specdocs/shared-invites-migration.sql` | M2 SQL |
| `specdocs/shared-lease-migration.sql` | M3 SQL |
| `src/lib/supabase/project-collaborators.ts` | M2 data layer: members, invite links, join RPC wrappers |
| `src/lib/supabase/project-editing.ts` | M3 data layer: lease RPC wrappers, keepalive release, badge listing |
| `src/lib/recovery-autosave.ts` | M4 IndexedDB snapshot store |
| `src/components/effects/SaveConflictModal.tsx` | M1 named conflict dialog |
| `src/components/effects/CollaboratorsModal.tsx` | M2 member list + invite link UI |
| `src/components/effects/EditingLeaseUi.tsx` | M3 take-over dialog + watching/lost banners |
| `src/components/effects/useEditingLease.ts` | M3 lease lifecycle hook |
| `src/components/effects/RecoveryModal.tsx` | M4 snapshot browser |
| `src/app/join/[token]/page.tsx` + `JoinClient.tsx` | M2 invite redemption route |

Modified files (grep the marker to find the touch-points):

- `src/lib/supabase/projects.ts` — `updateProject` grew an `ownerId`
  param (assets/thumbnails to the OWNER's Storage prefix);
  `loadProject` caches OWN rows only, always fetches non-owned fresh,
  and returns `shared_with_me` + `has_collaborators`;
  `listSharedProjects()`; `getProjectSaveStamp()`; `sharedListCache`.
- `src/components/effects/EffectsApp.tsx` — save flow (collaborator
  in-place CAS vs fork-a-copy), conflict state + three resolution
  handlers, lease hook wiring + acquire on collaborative load,
  recovery-autosave clock (`graphRevRef` bumped in the five
  dirty-flip wrappers) + restore handler, all modal renders,
  `onCollaborators` / `onRecoverAutosave` MenuBar props.
- `src/components/effects/LoadGrid.tsx` — Shared tab, "● editing"
  badges (leases fetched with the listing), Collaborators popover
  entry + modal instance.
- `src/components/effects/RateProjectPopover.tsx` — "Collaborators…"
  row (own rows).
- `src/components/effects/MenuBar.tsx` / `FileNameMenu.tsx` —
  Collaborators… in the file-name pill; File → Recover Autosave….
- `specdocs/061226_devguide.md` — shared-projects bullets in the
  Supabase section (kept in sync with this doc).

### Invariants — do not break these

- **Assets live under the OWNER's Storage prefix, always.**
  Collaborator saves pass the owner's user_id into `updateProject` →
  `uploadGraphAssets`/`uploadThumbnail`/`pruneProjectAssets`.
  `resolveAssetRefs` resolves against `row.user_id`; an auth-uid-keyed
  upload from a collaborator would strand every media ref.
- **The save CAS is the correctness layer; the lease is courtesy.**
  Never let any lease/banner state gate a save or an open. Overwrite-
  after-conflict must CAS against the FRESH stamp the dialog fetched —
  never unconditional (a third writer can race the dialog).
- **The overwrite-by-name save path (last-writer-wins, no CAS) must
  never target a shared row.** It's fenced today because
  `findConflict` searches `privateRows` (own rows only). Keep it that
  way if listings change.
- **`pruneProjectAssets` assumes the just-written row is the sole
  referencer of the project's asset prefix.** True through M1–M3.
  `project_versions` (unbuilt) BREAKS it — the keep-set must become
  the union of refs across live row + retained versions.
- **`LEASE_EXPIRY_MS` (project-editing.ts) mirrors the hardcoded
  `interval '8 minutes'` in `acquire_project_lease`.** Change both or
  neither. Heartbeat (2 min) must stay comfortably under expiry.
- **The recovery-autosave payload assembly mirrors `saveToRow`'s
  (minus thumbnail).** A new field riding the graph (like `liveDesign`
  did) must be added in both places — grep "keep the two in sync".
- **RLS membership checks go through the SECURITY DEFINER helpers**
  (`is_project_owner` / `is_project_collaborator` /
  `is_collaborator_asset`). Cross-referencing the tables directly in
  policies recurses (Postgres errors).
- **Invite redemption is an explicit click through the RPC, never on
  page load** (prefetch must not grant membership), and redeemers can
  never SELECT the invites table. Revocation is a flag flip; there is
  deliberately no DELETE grant on invites.
- **Pre-migration graceful degrade is load-bearing**: data-layer reads
  swallow 42P01/42703/42883 into false/[]/null. Keep new lookups on
  that pattern.
- **electron/main.js is untouched by design** — `pagehide` (+ fetch
  keepalive) covers Electron window close for the lease release, and
  IndexedDB covers desktop persistence for recovery snapshots.

### Known edges (accepted, documented)

- A collaborator opening a public shared row via `/p/[slug]` is
  treated as a public viewer (fork-on-save) — the slug route's
  `initialProject` payload never checks membership. The Shared tab is
  the collaborative entry point. Fix candidate: membership probe in
  `EditorClient` bootstrap.
- `has_collaborators` rides `loadProject`'s 60-min own-row cache — a
  collaborator added mid-session starts leasing on the owner's next
  fresh load, not instantly.
- Removing a collaborator doesn't notify their open editor; their next
  save RLS-fails into the fork-a-copy path, and their Shared tab drops
  the row on next refresh. Advisory by design.
- Restore-from-autosave always lands as an UNSAVED untitled graph
  (currentProject null) even when the snapshot came from a cloud
  project — deliberate: re-attaching to the row would need a fresh CAS
  stamp to avoid a stale LWW write. Save As is the safe re-entry.

---

## Design

The organizing principle, and the answer to every "but what if they go
offline mid-edit" spiral:

> **Saves are safe. Locks are advisory.**

Correctness lives entirely in the save path — the compare-and-swap on
`updated_at` (`updateProject`/`expectedUpdatedAt` in
src/lib/supabase/projects.ts). A stale editor's save matches zero rows
and surfaces a conflict instead of clobbering. That guarantee holds no
matter what any lock says, so the M3 lease never needs to be *right* —
only *useful*: it prevents most conflicts before an hour of work is
invested, and when it's stale or stolen the CAS is the backstop.

Hard locking ("if a shared project is open, another user can't open
it") is explicitly rejected: every hard-lock design degrades into
lease-with-expiry anyway (the crashed-laptop problem has no other
solution), and a hard lock that outlives a dead client locks the owner
out of their own project — strictly worse than any conflict dialog.

The offline scenario, end to end: A edits, wifi dies. A's lease lapses
after 8 min. B opens — project reads free, B acquires, edits, saves. A
comes back and saves → CAS conflict → "B saved 20 minutes ago" → A picks
Save as copy. Nobody was blocked; nothing was lost; no distributed-state
correctness was ever required of the lease.

### Decisions

- **CAS is truth, lease is courtesy.** Nothing blocks an open or
  silently discards work. Every conflict resolves to Save a copy /
  Overwrite / Discard — with the other person's name on it.
- **No enforced read-only mode.** A banner, not a disabled UI —
  enforcing read-only across the whole editor is a huge project for
  marginal benefit when saves are already safe.
- **Presence = lease heartbeat, not autosave.** The "actually using it
  vs. left a tab open" signal is a tiny interaction-gated row update,
  not a graph snapshot. Recovery autosave is a separate LOCAL feature.
- **Owner-only surface stays owner-only**: rename, visibility, delete,
  folder moves, collaborator management — DB trigger enforced (RLS
  can't distinguish columns within one UPDATE policy), mirrored in UI.
- **Invites are links, not name lookup** — avoids building user search
  and avoids account enumeration.
- Owner-resolved (08/14/26): single `editor` role; take-over always
  allowed; rename owner-only; Shared is its own load-grid tab; 8 min
  expiry / 2 min heartbeat confirmed.

## Schema

The three migration files are the authoritative schema — each carries
its own design commentary (RLS recursion, trigger timing, token
security). Summary:

- `project_collaborators` (project_id, user_id, role='editor',
  invited_by) — owner NOT stored here; `projects.user_id` stays owner.
- `projects.updated_by` — stamped by a `before update of updated_at`
  trigger, so exactly CAS-participating writes stamp it (the ratings
  aggregate refresh doesn't touch updated_at and never pollutes it).
- A `before update` trigger guards owner-only columns (name,
  is_public, public_slug, folder_id, user_id) against non-owner
  writes; null-uid contexts (service role) pass through.
- `project_invites` (token PK, expiry default 7d, revoked flag) — no
  redeemer-facing policies; preview + redemption via SECURITY DEFINER
  RPCs `get_project_invite` / `redeem_project_invite`.
- `project_editing` (project_id PK = one holder per project) — writes
  only via `acquire_project_lease(pid, steal)` (one atomic upsert) /
  `renew_project_lease` / `release_project_lease`; members may SELECT
  for badges.
- Storage: both buckets' write policies gain a collaborator clause via
  `is_collaborator_asset(owner_folder, project_key)` — note thumbnails
  parse the project id from the FILENAME, assets from folder[2].

## M1 — Safe shared saves (as built)

- Collaborators can SELECT + UPDATE shared rows (RLS); owner-only
  columns trigger-guarded. `updated_by` feeds the conflict dialog.
- `loadProject` serves its 60-min cache for OWN rows only — any row
  someone else can write to fetches fresh (a stale open would
  guarantee a conflict). Returns `shared_with_me` (collaborator row
  exists) and `has_collaborators` (own rows, limit-1 probe).
- `handleSave` (EffectsApp): own row OR `sharedWithMe` → in-place CAS
  update; non-owned public row → fork `"_copy"` (pre-existing
  behavior, untouched).
- On CAS conflict, `saveToRow` fetches `getProjectSaveStamp` (fresh
  updated_at + updated_by + profile name) and arms SaveConflictModal:
  "**Alice** saved 5 minutes ago" → Save a copy (green default) /
  Overwrite (CAS'd against the dialog's fresh stamp; re-conflict
  re-arms with a newer stamp) / Discard mine (invalidate caches +
  reload). The thrown error carries `isSaveConflict` so callers skip
  their generic toast.
- Collaborator saves thread `currentProject.ownerId` into
  `updateProject` → assets + thumbnails land under the owner's prefix.
- "Shared" tab in LoadGrid (`listSharedProjects()`, own tab between
  Private and Public, author labels). Tile rename/delete were already
  gated on `row.user_id` — nothing extra needed.
- Non-owner UI gating (rename pill, visibility, delete) predates this
  work and remains owner-only, now also DB-enforced.

## M2 — Invite links (as built)

- Owner surfaces: "Collaborators…" in the load grid right-click
  popover AND the file-name pill dropdown → CollaboratorsModal:
  member list (remove per row), ONE live invite link per project —
  "Copy invite link" mints-or-reuses on first click (opening the modal
  creates nothing), "Reset link" revokes all live links and mints
  fresh, so a leaked URL dies immediately.
- `/join/<token>`: server component resolves the preview through
  `get_project_invite` (works signed-out — a token is a bearer
  secret, holders seeing the project name is intended; force-dynamic
  so revoked links die on next load). Client shows explicit **Join
  project**; `redeem_project_invite` inserts membership and the
  project appears in the Shared tab (`invalidateProjectCaches()` on
  redeem). Statuses handled: valid / expired / revoked / owner /
  member / signed-out.
- Tokens: 16-char base36 (~82 bits), minted client-side.

## M3 — Advisory editing lease (as built)

Constants: expiry 8 min (SQL + `LEASE_EXPIRY_MS`), heartbeat 2 min
(`LEASE_HEARTBEAT_MS`), interval tick 30s (gates do the pacing).

- **Acquire** on load of COLLABORATIVE rows only (`shared_with_me ||
  has_collaborators`) — solo projects pay zero lease writes. Held →
  silent. Held by another → LeaseHeldDialog: "Alice is editing (active
  3 min ago)" → *Open anyway* (watching banner) / *Take over*
  (steal=true; always allowed — the victim is protected by the CAS).
- **Heartbeat, interaction-gated** (`useEditingLease`): window-capture
  pointerdown/keydown/wheel bump `lastInteractionRef`; a beat fires
  only if there was interaction since the last one. Idle tab → lease
  lapses → reads as free. A `false` renew re-acquires WITHOUT steal to
  learn who took it — if that acquire succeeds (they left), stay
  silent; else show the "lost" banner ("Bob took over — Save a copy").
  A `null` (offline/degraded) renew keeps believing rather than
  false-alarming.
- **Release**: self-healing effect keyed on `currentProjectId` covers
  project switch / New / file load / sign-out / post-conflict fork
  with zero per-path plumbing; `pagehide` fires a fetch-keepalive RPC
  call authenticated by a pre-cached access token (getSession can't be
  awaited in pagehide). Expiry is the crash backstop.
- **Badges**: LoadGrid fetches `listActiveLeases(ids)` with the
  private/shared listings → "● Alice" overlay on tiles, inline in list
  rows, "● you" for your own other window. Refresh button, no polling.

## M4 slice 1 — Local recovery autosave (as built)

- `lib/recovery-autosave.ts`: IndexedDB (`toolbox-recovery`), META and
  GRAPHS stores sharing one auto-increment id — listing reads only
  meta, never the multi-MB graphs. 5 snapshots per bucket (bucket =
  cloud project id or `"untitled"`), oldest pruned. Structured clone,
  no JSON.stringify pass. Every call fails soft without IndexedDB.
- Clock (EffectsApp): every 30s tick, snapshot iff pill dirty AND
  `graphRevRef` advanced since the last snapshot AND ≥2 min since the
  last one. `graphRevRef` is bumped by the same five wrappers that
  flip the pill dirty (pushGraph/pushPaint/undo/redo/saveEasing) — so
  idling while dirty never re-snapshots. Payload mirrors `saveToRow`
  minus thumbnail.
- Successful CLOUD saves clear the working bucket (in `saveToRow`,
  both insert + update paths). File saves deliberately don't — the
  pill stays cloud-dirty there and a snapshot under a deletable file
  is still a net win.
- File → **Recover Autosave…** → RecoveryModal (list newest-first,
  Restore / Delete per row) → restore deserializes cloud-style
  (deferRemoteMedia + streamPendingMedia — snapshots of cloud-loaded
  projects carry Storage-URL envelopes) into an UNSAVED editor:
  currentProject null, pill dirty, snapshot survives until explicit
  save or manual delete.

## Verification

Standard gates (`npm run typecheck`, `npm run check`,
`npm run lint:ratchet` — see TESTING.md). All green as of 08/17/26.

Manual passes needing two browsers on different accounts (after the
migrations run):

- **M1**: collaborator save round-trips media — inspect Storage paths
  land under the OWNER's prefix; stale-window saves from each side hit
  the named conflict dialog and each resolution path works; rename /
  visibility / delete rejected for the collaborator AT THE DB (not
  just hidden — try via console); overwrite-by-name can't touch a
  shared row.
- **M2**: invite link round-trip (copy → other account joins → row in
  Shared tab, saveable); reset kills the old link (revoked state on
  /join); expiry copy; owner/member/signed-out states on /join.
- **M3**: idle tab lapses after ~8 min (badge clears on refresh);
  kill -9 a client → other side can acquire after expiry; steal →
  victim sees the lost banner within a heartbeat (~2 min); clean
  close/switch releases immediately; solo own project never touches
  `project_editing` (watch the network tab).
- **M4**: edit ≥2 min unsaved → snapshot appears in Recover
  Autosave…; idle-while-dirty adds no duplicates; cloud save clears
  the bucket; restore lands dirty + untitled; works signed-out.

## Remaining work (optional — nothing depends on it)

1. **`project_versions` history**: last N explicit saves (row copy on
   save, trigger-pruned). Post-Tier-2 rows are tiny and assets
   content-addressed, so versions SHARE media objects — history is
   nearly free. REQUIRED: `pruneProjectAssets`' keep-set must become
   the union of refs across live row + retained versions (see
   Invariants), or prune only on version expiry. Landing this would
   make Overwrite-on-conflict genuinely safe → could relax the
   conflict dialog's defaults.
2. **Take-over handoff draft**: active editor's periodic cloud
   autosave in a per-(project, user) draft slot; take-over offers
   "Alice's unsaved work from 4 min ago" vs her last save. Only worth
   building if real usage shows take-over losing meaningful work.
   (The recovery-autosave serialize path is the natural payload
   source.)
3. **`/p/[slug]` membership probe** (small): let a collaborator
   opening a public shared row via its slug link get the in-place
   save path instead of fork-on-save.
