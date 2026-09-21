# Named live links — `/@handle/project-title`

2026-09-21. An opt-in, readable alias for a public project's live link.

## Why

Live links are `/live/<12 random base36 chars>`. Fine for a paste, hopeless
to say out loud or remember. Project titles are the obvious source of a
readable slug, but titles are not unique across users, so a bare
`/live/orbit` would be a first-come land grab. Prefixing the owner's
handle scopes uniqueness to one person: `/@hallan/orbit`.

## Shape

| | |
|---|---|
| URL | `/@<handle>/<slug>` — route `src/app/[handle]/[slug]/page.tsx` |
| handle | `profiles.handle`, unique, `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, 3–32 chars, reserved list |
| slug | `projects.vanity_slug`, nullable, unique per `(user_id, vanity_slug)`, 1–64 chars, same charset |
| rules | `src/lib/vanity-slug.ts` (client) ⇄ `specdocs/vanity-live-links-migration.sql` (DB). Keep in sync by hand; `check-vanity-slug` guards the client half. |

Decisions:

- **`@` prefix.** Next resolves static segments before dynamic ones, so the
  root `[handle]` route only ever sees two-segment URLs nothing else
  claimed — but a bare `/<user>/<slug>` would still turn every future
  top-level route into a retroactively reserved handle. `@` keeps the two
  namespaces disjoint. The page 404s anything not shaped `@<valid handle>`.
- **Alias, not replacement.** `public_slug` is untouched and permanent.
  `/live/<public_slug>` always resolves; the panel's share code and
  "Editor" link keep coming from it on the vanity page too. Turning the
  named link off just nulls `vanity_slug`.
- **Frozen at save.** The slug is derived from the title when the user
  hits Save, never kept in sync. A rename can't silently move a shared
  link. When the title drifts, the settings row shows an "Update link"
  action that seeds a fresh draft.
- **Explicit Save.** The other Project Settings rows apply live. This one
  is toggle → preview → Save because the write can fail on uniqueness and
  the user needs to see the address before it lands.
- **Live-only.** `/p/<public_slug>` (the editor) has no vanity form. The
  toggle is locked until the project is public; turning OFF stays allowed
  on an owned row so a link can be retired after a private flip.
- **Handles are seeded**, not claimed: the migration mints one per profile
  from the email local part (`mint_handle`: base, base-2, base-3 …), and
  the signup trigger does the same. Most users never touch it. The account
  menu (top-right) has the editor.

## Data flow

- `loadProject` / `loadEditorProjectBySlug` select `vanity_slug` (with a
  42703 retry for pre-migration DBs) and fetch `owner_handle` only when a
  vanity slug exists. Both land on `currentProject` in EffectsApp.
- Own rows read the handle live from `useOwnHandle()` (module cache +
  subscription in `lib/supabase/profiles.ts`) so a handle change in the
  account menu updates the settings preview and the pill's copy button
  without a reload.
- `setProjectVanitySlug(id, slug | null, expectedUpdatedAt)` — CAS like
  rename / visibility; 23505 → `taken`, 42703 → `migration`, 23514 →
  `invalid`. Success returns the new `updated_at`, mirrored onto
  `currentProject`.
- `loadPublicProjectByVanity(client, handle, slug)` — profile by handle,
  then the PUBLIC row by `(user_id, vanity_slug)`. Two anon-readable
  queries; no new RLS.
- The file-name pill's "Copy live link" prefers `liveVanityPath` when the
  row is public and opted in. The load grid's right-click popover still
  hands out the random link (it lists via `BASE_COLS`, which this change
  leaves alone).

## Not done

- Load-grid popover: no vanity URL (see above).
- No canonical / redirect between the two live URLs; both serve.
- No handle history: a changed handle 404s old `/@old/...` links (the
  random link is the stable one, and the docs say so).
