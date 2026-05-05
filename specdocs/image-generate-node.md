# Image Generate node — spec

A first-class **Image Generate** node that surfaces an OpenAI chat
interface in the parameters area. The user types prompts; the node
streams generated images into a thumbnail strip; clicking a thumbnail
makes that image the node's output. Drag a thumbnail into the node
editor to spawn an independent Image Source node.

This is the first BYO-key, conversational, async-asset node we ship.
The architecture choices below are written so we can re-use the
storage + key-management plumbing for future AI nodes (image-edit,
video gen, audio gen, etc.) without further design work.

---

## 1. User-facing summary

- New node type: `image-generate` under category `image`,
  subcategory `generator`.
- Active user must be signed in AND have an OpenAI API key in their
  user preferences (new modal, see §3). No key → the node renders an
  empty disabled state with a "Set API Key…" CTA. The node still
  exists in the graph but outputs transparent.
- Three image input sockets: `ref_a`, `ref_b`, `ref_c`. When any of
  these are wired the rasterized result is sent to OpenAI as a
  reference image alongside the next prompt.
- One image output socket: the currently-selected generated image
  (or transparent if none selected).
- Param panel takes over with a custom layout — see §4.
- Per-node settings (image size, output format) accessed via a gear
  icon in a node-specific menu bar at the top of the param panel.

---

## 2. Out of scope (v1)

- Streaming text replies from the model. We only consume images.
- Sharing generations across users. Chat history + non-selected
  thumbnails are strictly private to the user who generated them.
- In-browser image editing (mask tools, etc.). The model does the
  iteration via prompt context.
- Cost dashboards / spend caps. The user owns their key; we don't
  meter.
- Server-side proxy. We call OpenAI directly from the browser using
  the user's key — same security model as a desktop app where the
  user has trusted us with their key. (See §6 for the consequences.)

---

## 3. User preferences modal

A new modal opened from the menu bar, sibling to "Project Settings":

- Menu entry: `Edit → User Preferences…` (or a settings icon next to
  Project Settings in the menu bar — TBD pick one path).
- Body fields:
  - **OpenAI API key** — password-style input, masked. Show last 4
    chars when set.
  - "Test connection" button — issues a `models.list()` request and
    surfaces success / 401 / rate-limit error.
  - **Save** + **Cancel** buttons. Save persists to Supabase.
- Storage: new Supabase table `user_preferences`:
  ```
  id                uuid    pk
  user_id           uuid    references auth.users(id)  unique
  openai_api_key    text    nullable
  created_at, updated_at
  ```
  RLS: row readable + writable only by `auth.uid() = user_id`.
- The key sits in plain text in the table. We're not building a
  secrets manager; the table is RLS-locked and the user agreed to
  trust the platform with the key by entering it.
- Client cache: load on sign-in, keep in a React context. Re-fetch
  on user-preferences modal close. No localStorage mirror — too easy
  to leak via shared machines.
- Future-proof: extend with `enabled_features`, `default_size`, etc.
  by adding columns. Reserve `meta jsonb` for low-stakes prefs.

---

## 4. Param panel layout — split view

When an Image Generate node is selected, the param panel renders a
two-column custom view that overrides the standard ParamPanel body:

```
┌─────────── node menu bar ─────────────┐
│  [Image Generate]   ⚙ size & format    │  ← gear opens settings popover
├──────────────┬─────────────────────────┤
│              │                         │
│  chat log    │  thumbnails             │
│              │  ┌──┬──┬──┐             │
│  > prompt 1  │  │  │  │  │  …          │
│  > prompt 2  │  └──┴──┴──┘             │
│  > prompt 3  │  selected: prompt 2#3   │
│  …           │                         │
│              │  view: [grid] list      │
│              │                         │
│ ┌──────────┐ │                         │
│ │ Send …   │ │                         │
│ └──────────┘ │                         │
└──────────────┴─────────────────────────┘
```

### Left column — chat input

- Read-only log of the user's previous prompts in this node's
  conversation. No model replies (per §1 — images-only). Each row
  shows: prompt text, timestamp, # of images returned, status icon
  (pending / done / error).
- Input box at the bottom: textarea + "Send" button (Cmd+Enter
  shortcut). Disabled while a request is in-flight.
- A small "ref images" badge next to Send shows how many of the
  three input sockets are currently wired (`a/b/c`). On hover,
  preview thumbnails of the resolved input images.
- A "Clear conversation" button at the top-right of the chat
  column that nukes the local conversation thread and starts fresh.

### Right column — thumbnails

- Grid (default) or list view of every image generated in this
  conversation, newest first. Each thumbnail:
  - Click → make this the selected image (= node output).
  - Drag → spawns a new Image Source node in the node editor at
    the drop position, owning its own copy of the asset (§7).
  - Right-click → "Save to disk", "Use as input" (sends back into
    the next prompt as an additional reference), "Delete".
  - Selected thumbnail has the same white-stroke treatment we use
    for selected tracks.
- Status row at bottom: which prompt the selected image came from,
  generation timestamp, OpenAI model + size used.
- Grid / list toggle is local to the node (lives in node `data`,
  default `grid`).

### Settings popover (gear icon)

- **Size**: dropdown of curated options +
  `auto` (model-chooses). Curated set:
  `auto`, `1024×1024`, `1536×1024`, `1024×1536`, `2048×2048`,
  `3840×2160`. Default `1024×1024`. Anything in OpenAI's general
  size constraints (max edge ≤ 3840, both edges multiples of 16,
  aspect ≤ 3:1, total pixels 655 360 – 8 294 400) would also work,
  but we don't expose a free-form picker in v1 — overkill.
- **Quality**: `auto` (default), `low`, `medium`, `high`. Higher
  quality = more output tokens = more cost. Outputs above
  2560×1440 total pixels are flagged "experimental" by OpenAI.
- **Output format**: `PNG` (default, lossless), `JPEG`, or
  `WebP`. PNG is the pipeline-friendly choice; JPEG / WebP
  surface an additional `compression` slider (0–100) per
  OpenAI's `output_compression` param.
- **Moderation strictness**: `auto` (default) or `low`. Maps
  1:1 to the `moderation` field in the request.

Note: gpt-image-2 does not currently support transparent
backgrounds — we don't surface a `background` param; images come
back opaque. (When OpenAI flips this on we'll add a `background:
transparent` toggle.)

---

## 5. Conversation + generation model

### State per node

Stored in node `data` (project-saved fields):
```ts
{
  defType: "image-generate",
  params: {
    size: "1024x1024" | "1024x1536" | "1536x1024",
    format: "png" | "webp",
    view: "grid" | "list",
    selectedImageId: string | null,  // points into the user-scoped
                                     // session below
  },
}
```

The chat history + every generation is **NOT** in node data — it's
stored in a user-scoped Supabase row keyed on (user, project, node):

```
image_gen_sessions
  id            uuid pk
  user_id       uuid fk
  project_id    uuid fk
  node_id       text   -- node id within the project
  messages      jsonb  -- [{ id, prompt, refImagePaths[], createdAt,
                       --    status, imageIds[], error? }, …]
  created_at, updated_at
  unique (user_id, project_id, node_id)

image_gen_images
  id            uuid pk
  session_id    uuid fk
  storage_path  text   -- "private/<userId>/<projectId>/<nodeId>/<imageId>.png"
  width, height int
  format        text
  created_at
```

RLS on both tables: read/write only when `auth.uid() = user_id`
(via `image_gen_sessions.user_id`). Other users opening the project
get an empty chat for this node.

### Storage bucket

New private Supabase Storage bucket `image-gen-private`. Object
paths: `<userId>/<projectId>/<nodeId>/<imageId>.<ext>`. RLS:
authenticated read+write only when the path's first segment matches
the caller's `auth.uid()`.

### Public output (the selected thumbnail)

When the user selects a thumbnail, we **copy** the bytes to a public
bucket so viewers of the project can see the output:

- Bucket: `image-gen-public` (new).
- Path: `<projectId>/<nodeId>/<imageId>.<ext>`.
- RLS: public read; write restricted to project owner via a small
  edge-function-style check (auth.uid() must match `projects.owner`
  for the project_id in the path).

The node's saved output reference is the **public-bucket URL**, so
shared / public projects render the image for everyone, while the
chat + alternate thumbnails stay private.

When the user changes the selection, we delete the previous public
copy. Single-image footprint per node, regardless of how many
generations were tried.

### Why this split

- Other users loading a public project see the curated output, never
  the discarded variants or the prompts. (Matches §7 of the original
  Q&A — chat + thumbnails are private.)
- The user's own re-opens of the project resurrect the full chat by
  fetching their `image_gen_sessions` row.
- Forking the project (Save As → new project_id) starts a clean
  session — desired behavior, prevents accidental cross-project
  leakage.

---

## 6. OpenAI integration

### Model

- **Model id**: `gpt-image-2` (latest snapshot at the time of
  writing: `gpt-image-2-2026-04-21`).
- Multimodal in (text + image), image out.
- Tier-1 OpenAI accounts hit a 5 img/min rate limit; tier-5 lands
  at 250 img/min. We surface 429s through the chat status icons.
- gpt-image-2 does **not** currently support transparent
  backgrounds. The node param can offer `background: opaque` only
  until OpenAI flips this on; we'll keep the param hidden for now.
- The `input_fidelity` parameter from gpt-image-1 should NOT be
  sent — gpt-image-2 always processes inputs at high fidelity.

### Endpoints + auth

Two endpoint paths are relevant:

| Use case                              | Endpoint                                    |
|---------------------------------------|---------------------------------------------|
| Single-shot generation (no context)   | `POST /v1/images/generations`               |
| Multi-turn conversational generation  | `POST /v1/responses` (image_generation tool) |

We use the **Responses API** as the default path because it's the
only one that gives us multi-turn iteration via
`previous_response_id`. The plain `/v1/images/generations` endpoint
is kept as a fallback for the very first prompt in a session when
we have no previous_response_id yet (and no ref images to wire as
content parts), purely for latency parity — the Responses API
handles this case fine, so we may drop the fallback after a perf
check.

All calls go direct from the browser:

```
fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${userKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(requestBody),
});
```

Risks of client-direct, accepted:
- Key sits in browser memory while the user is signed in. Not in
  localStorage; flushed on sign-out / refresh + re-fetch.
- A malicious site can't read it (Supabase RLS blocks); a malicious
  browser extension could. Standard BYO-key risk profile.
- Spend visibility is the user's responsibility (their OpenAI
  dashboard).

### Request shape — first prompt in a conversation

```jsonc
POST /v1/responses
{
  "model": "gpt-image-2",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "<user prompt>" },
        // For each wired ref socket — see §6 "Reference images":
        { "type": "input_image",
          "image_url": "data:image/png;base64,<...>" }
      ]
    }
  ],
  "tools": [
    {
      "type": "image_generation",
      "size": "1024x1024",        // from node param
      "quality": "auto",          // from node param: low|medium|high|auto
      "output_format": "png",     // png|jpeg|webp; from node param
      "moderation": "auto"        // auto|low
      // omit input_fidelity (gpt-image-2 ignores it)
    }
  ],
  "stream": false                  // we don't render partials in v1
}
```

### Request shape — follow-up turns

Every subsequent prompt for the same node sends the prior response
id and the new prompt only. The model already holds the prior
images + prompts in context.

```jsonc
POST /v1/responses
{
  "model": "gpt-image-2",
  "previous_response_id": "<id from last response>",
  "input": [
    { "role": "user",
      "content": [
        { "type": "input_text", "text": "<follow-up prompt>" },
        // Newly wired or refreshed ref images attach here.
      ]
    }
  ],
  "tools": [{ "type": "image_generation",
              "size": "1024x1024", "quality": "auto",
              "output_format": "png" }]
}
```

If the chain is older than the API's retention window (stored
responses retain for 30 days), the next call returns
`invalid_request_error` referencing the missing previous_response_id.
On that failure we re-stitch context by replaying the chat record
into a single fresh `input` array — every prior user prompt as
`input_text`, every selected image as `input_image` — and start a
new chain.

### Response shape

```jsonc
{
  "id": "resp_…",
  "output": [
    {
      "type": "image_generation_call",
      "id": "ig_…",
      "status": "completed",
      "revised_prompt": "<model-rewritten prompt>",
      "result": "<base64 image>"
    }
    // potentially multiple if `n > 1` was requested via tool config
  ],
  "usage": { /* tokens etc. */ }
}
```

We capture, per response:
- `response.id` — persisted into `image_gen_sessions.last_response_id`.
- For every `image_generation_call` part in `output[]`: decode
  base64 → blob → upload to private bucket → insert row in
  `image_gen_images` with `revised_prompt` saved alongside.

### Reference images from input sockets

The three sockets (`ref_a`, `ref_b`, `ref_c`) are resolved at
send time. Each wired ref turns into an `input_image` content
part on that turn.

- For each connected socket:
  1. Read the upstream eval cache for the connected node's primary
     image output.
  2. Render the texture to a PNG blob via canvas readback (same
     path the export pipeline uses).
  3. **Hash + cache by content**: SHA-256 the bytes; if a row
     already exists in `image_gen_images_refs` for `(user_id,
     hash)`, reuse its storage path. Otherwise upload to
     `image-gen-private/<userId>/refs/<hash>.png`.
  4. Generate a short-lived signed URL (1 hour) and pass it as
     `{ "type": "input_image", "image_url": "<signed URL>" }`.
     OpenAI fetches the URL once when the request is processed.

Why signed URL and not base64:
- Avoids a multi-MB JSON payload on every turn.
- Signed URL still respects the bucket's RLS (hash-based dedup
  + private bucket = the URL is the only access path; OpenAI
  consumes it during the request and discards it).
- Falls back to base64 inline if the bucket is unreachable.

The chat-message record stores the **content hashes** of the ref
images used on that turn. When the user re-opens the project we
can re-show "this prompt used 2 reference images" without having
to dereference the actual bytes.

### Lifecycle of a request

```
user types prompt → click Send
  ↓
[1] resolve ref sockets, hash + upload any new ones to refs bucket
[2] insert pending message into image_gen_sessions.messages
    (status: pending), persist optimistically
[3] re-render param panel — message appears with spinner
[4] POST /v1/responses with prompt + ref images + previous_response_id
[5] await completed response (no streaming in v1)
[6] for each image_generation_call in output:
     - decode base64 → blob
     - upload to private bucket: image-gen-private/<userId>/<projectId>/<nodeId>/<imageId>.<ext>
     - insert image_gen_images row with revised_prompt + size/format
[7] update message: status=done, imageIds populated, last_response_id
    set on the session row
[8] re-render param panel — thumbnails appear
[9] selectedImageId stays unchanged unless this is the very first
    generation in the session (auto-select first image of first
    response). Selection update kicks the public-bucket copy in §5.
```

Errors at any step land the message in status `error` with a
human-readable message; the input box re-enables for retry. OpenAI
errors arrive as `{ error: { type, code, message } }` — we surface
`message` verbatim and treat `type=insufficient_quota` /
`code=invalid_api_key` specially, prompting the user to update
their key in Preferences.

### Cost telemetry (informational)

The response includes a `usage` block with input tokens, output
tokens, and (for image gen) image tokens. We persist `usage` on
the message row so the user can total their spend per session
without leaving the app. No spend cap in v1.

---

## 7. Drag thumbnail → spawn Image Source

The drag handle on a thumbnail starts a custom drag. The node
editor's drop handler accepts it.

### Behavior

- Drop inside node editor pane → spawn new `image-source` node at
  the flow position.
- The new node's image is a **copy** of the source bytes, uploaded
  to a NEW path scoped to the new node. This decouples the new node
  from the Image Generate node entirely:
  - Re-running prompts in the originating node won't affect this
    Image Source.
  - Deleting the originating node won't break the Image Source.
  - Forking the project keeps the Image Source intact.

### Implementation hooks

- React DnD-style: thumbnail's `onPointerDown` starts a drag;
  during the drag we render a floating preview at the cursor.
- NodeEditor exposes `onAddFileNode(file, flowPos)` already (used
  by file-drop). We extend it with `onAddImageNodeFromBlob(blob,
  flowPos)`.
- The handler in EffectsApp creates the node, uploads the blob to
  storage, sets the new node's image param to the resulting URL.

---

## 8. Render context — node compute

```ts
compute({ inputs, params, ctx, nodeId, nodeData }) {
  // Read selectedImageId from params; resolve to an Image bitmap
  // via a node-local cache keyed on (selectedImageId, storagePath).
  // Cache is populated by an effect in the param panel that
  // pre-fetches the selected image's blob → ImageBitmap as soon as
  // the selection changes.
  //
  // If no selectedImageId or fetch hasn't completed, output the
  // pre-allocated transparent placeholder.
  //
  // Reference inputs (`ref_a/b/c`) are NOT consumed by compute —
  // they're only read at request time inside the param panel.
}
```

The texture upload uses the same path as Image Source (premultiplied
RGBA, sRGB→linear handled by the engine). Because the node owns the
selected image bitmap as a regular image input, downstream nodes
treat it identically to any other image source — no special-casing
in the engine.

---

## 9. Project save / load

- Saved fields: `params.size`, `params.format`, `params.view`,
  `params.selectedImageId`. These are tiny; round-trip cleanly.
- The selected image's **public-bucket URL** is also embedded in
  the saved project (or derivable from `selectedImageId` +
  conventional path). This lets viewers render the project without
  any DB lookup.
- On load, the node:
  1. Renders the saved selected image immediately (output ready).
  2. Async-fetches the user's `image_gen_sessions` row for this
     (project, node). If found, populates chat + thumbnails. If
     not found, chat is empty.
- Forking (Save As → new project_id) leaves
  `image_gen_sessions` rows behind under the old project_id. The
  fork starts a clean session. Storage paths for the originally-
  selected image still resolve (they're project-keyed, not
  fork-keyed) — duplicate the bytes into the fork's project_id on
  Save As to fully decouple.

---

## 10. Migration / backwards compat

- New node type — no existing-graph migration concerns.
- New tables + buckets — created via Supabase migration
  (`supabase/migrations/<timestamp>_image_gen.sql`).
- Old projects load unchanged.

---

## 11. Open questions / TBDs

1. **Streaming partials.** The Responses API supports
   `response.image_generation_call.partial_image` events when
   `partial_images > 0`. Each partial costs +100 output tokens.
   Skip in v1 (single shot, blob arrives at once). Wire up if
   users complain about the wait on `quality: high`.
2. **`/v1/images/generations` fast path.** First-prompt-no-refs
   could go through the simpler endpoint for slightly lower
   latency. Defer until we measure — it'd diverge the request
   pipelines for a single edge case.
3. **Spend caps.** Should we surface estimated cost per send before
   the user clicks Send? OpenAI's pricing page lists token-based
   image costs (low 1024×1024 ≈ 196 output tokens, scales with
   size/quality). Easy to estimate; default off for v1.
4. **Thumbnail eviction.** How many generations do we cache in the
   browser at once? v1: keep all for the active session, lazy-load
   beyond the first 24. Plenty for normal use.
5. **Drag-thumbnail-to-canvas-area.** Spec covers drag into the
   node editor. Should dragging onto the canvas viewport also
   register as "set this as the active output's source"? Skipping
   for v1 — visually ambiguous.
6. **Lost-chain UX.** When the 30-day Responses retention expires
   and we re-stitch context, do we surface that to the user? v1:
   silent re-stitch on the next prompt; tiny ⓘ tooltip on the
   chat input that says "context refreshed". Cheap to add.

---

## 12. Build phases

**Phase 1 — plumbing**
- `user_preferences` table + RLS + migration.
- User Preferences modal (key field, test connection, save).
- React context exposing the active key.

**Phase 2 — node skeleton**
- Register `image-generate` node with size / format / view /
  selectedImageId params and three ref inputs.
- ParamPanel: detect node type and render the custom split view.
  Stub left + right columns with placeholder content.
- Node compute: output transparent.

**Phase 3 — generations roundtrip**
- `image_gen_sessions` + `image_gen_images` tables + buckets.
- Send button: resolve refs, upload, call OpenAI, store images.
- Render thumbnails + handle click-to-select.
- Wire selectedImageId → public-bucket copy + node output texture.

**Phase 4 — drag to canvas**
- Drag handle on thumbnails.
- Extend NodeEditor + EffectsApp drop handler.
- Asset-copy path to new private bucket scope.

**Phase 5 — polish**
- List view, multi-turn `previous_response_id` chaining, error
  states, retry, "use as input" right-click action, settings popover
  styling, public-bucket cleanup on selection change.

Each phase is independently shippable behind an "experimental nodes"
preference flag if needed.
