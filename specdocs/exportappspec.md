# Spec: Export App

A button on the Output node that bundles the current graph into a
self-contained, runnable artifact. The user gets back a zip containing
everything needed to ship their patch as a standalone web app — no
Toolbox account required, no editor included, just the engine + their
graph + a small control panel.

The end state: a designer makes a patch in Toolbox, hits Export App,
sends the zip to a client, the client double-clicks `index.html` and
sees the running effect. Or hosts the zip's contents on any static
host (Vercel, Netlify, S3, GitHub Pages) and shares a link.

---

## 0. Design principles

- **No code generation.** The exported app ships the same engine,
  evaluator, and node defs that the editor uses. The graph is data;
  the engine is code; both are bundled. We don't try to rewrite
  per-node compute functions into a single concatenated script.
  This means a node bug fix in the editor automatically improves
  every future export — and it means an export bug isn't living in
  some parallel codegen path.
- **Two artifacts, one zip.** A static `dist/` folder (drop into
  any host, runs anywhere) AND a Vite project source tree (so
  developers can edit, rebuild, deploy through their normal
  pipeline). Both share the same control manifest and graph JSON.
- **Single-file `index.html` is the default user-facing artifact.**
  Easy to email, easy to open, no servers required. The Vite source
  tree is bonus for power users.
- **Controls are an opt-in, per-param toggle.** Live next to (but
  distinct from) the existing "expose" toggle. Expose is an engine
  concept; control is an export concept. Both can be on for the
  same param.

---

## 1. Current state to build on

- **Graph serialization** already exists end-to-end —
  `serializeGraph` / `deserializeGraph` in
  [src/lib/project.ts](src/lib/project.ts) produce / consume the
  exact JSON the engine eats. The exported app uses these same
  paths, unchanged. Only edge/node TYPE imports come from
  `@xyflow/react` (just `Node` / `Edge` interfaces) — easily
  replaced with local plain-object types in the export bundle.
- **The engine entry points are small:**
  - `createEngineBackend(width, height)` in
    [src/engine/gl.ts](src/engine/gl.ts) — sets up WebGL2.
  - `evaluateGraph(nodes, edges, ctx, cache, activeNodeId)` in
    [src/engine/evaluator.ts](src/engine/evaluator.ts) — runs one
    frame.
  - `registerAllNodes()` in [src/nodes/index.ts](src/nodes/index.ts)
    — populates the node registry.
- **The engine has zero editor-surface dependencies.** Verified by
  walking imports: every file under `src/engine/` and `src/nodes/`
  imports only from `src/engine/types`, `src/state/graph`
  (evaluator.ts, only for the two helpers `paramSocketType` /
  `parseTargetHandleKind`), and three small `src/lib/` helpers
  (`fonts.ts`, `audio.ts`, `svg-parse.ts`). No React, no
  `@xyflow/react`, no Supabase, no Next.js. Means the export
  bundle's runtime is the engine + node defs + a tiny React panel,
  not the whole editor.
- **Reachability is already computed.** `computeNeededSet(nodes,
  edges, activeNodeId)` in evaluator.ts (line 176) returns the set
  of nodes reachable from a terminal. The export pipeline reuses
  it to decide which nodes to bundle (see §6) and which file
  inputs to auto-include (see §8). Don't reinvent.
- **`ParamControl`** in ParamPanel.tsx (line 543) is a self-
  contained dispatcher: takes a `ParamDef`, current value, and
  `onChange`, dispatches to the right renderer. The simple types
  (scalar, vec*, color, enum, boolean, string) are inline in that
  component with no editor-only state — directly liftable into
  the export panel.
- **File-bearing param types**: `file` (image — currently 5 nodes
  use it, of which `image-source` is the canonical), `video_file`
  (video), `audio_file` (audio), `svg_file` (svg-source), `font`
  (text node). `file` (image) already round-trips through
  `serializeParams` as a base64 data URL; the other four serialize
  to `null` and require re-upload on load. The export inherits
  these semantics — see §11 for the asset embedding policy.

---

## 2. The author's experience

1. User builds a graph in the editor as normal.
2. For each param they want exposed in the final app, they click a
   new **control** toggle in ParamPanel — sits alongside the
   existing **expose** toggle.
3. When ready, they click **Export App** on the Output node.
4. A modal asks for app name, optionally a description, and
   confirms which file inputs the engine detected (those will be
   auto-included; can't be unchecked).
5. They hit Export. A `<app-name>.zip` downloads.
6. Inside the zip:
   - `index.html` — single-file standalone, runnable by double-clicking.
   - `dist/` — same thing, split into html + assets, host-ready.
   - `source/` — full Vite project, for devs who want to edit.
   - `README.md` — what's what, how to run/host/edit.

---

## 3. The user's experience (consumer of the export)

Three tiers, picked based on technical comfort:

**Tier A — double-click `index.html`.** Works in any modern browser.
Single self-contained HTML file with the engine, the graph, and any
asset thumbnails inlined as data URIs. No server, no install. Some
caveats with `file://` URLs (see §7), all of which we work around
in the build.

**Tier B — drop `dist/` on a static host.** For sharing online.
Drag the folder into a Vercel/Netlify deploy or push to GitHub
Pages. A normal static site.

**Tier C — `cd source/ && npm install && npm run dev`.** For devs
who want to fork the app, swap fonts, add their own UI chrome, or
embed the canvas in a larger page. Standard Vite workflow.

---

## 4. Dependencies — the education aside

You asked. Here's the honest landscape:

**The exported app's RUNTIME dependencies (what the user's browser needs):**
- Nothing. WebGL2 is built into every browser from 2017 onward.
  No npm install, no plugins, no internet connection at run time.
- The single-file HTML inlines its JavaScript, so even external CDN
  fetches aren't needed.

**The exported app's BUILD dependencies (what we use to make the
bundle):** Hidden from the user entirely. The export pipeline runs
on the editor's server (or in a cloud function — see §11) and ships
the user a finished bundle. They never see a `package.json` unless
they crack open the `source/` tree.

**For Tier C users who do want to rebuild:**
- Node.js 20+
- That's it. `npm install` pulls Vite + a few small libraries; `npm
  run build` produces the dist folder. About 2-3 minutes from clone
  to running on first install, ~5 seconds for incremental rebuilds.

So in practice: zero install for the casual user, one install for
the dev. The reason this works is that the engine itself has very
few dependencies — basically just React for the panel and the
WebGL2 native API for rendering. Everything else (the spline math,
the bezier helpers, the node defs) is plain TypeScript that ships
in the bundle.

---

## 5. The export bundle — file shape

```
my-app.zip
├── index.html                  Tier A: single-file standalone
├── dist/
│   ├── index.html              Tier B: split, references ./assets
│   └── assets/
│       ├── app-<hash>.js
│       └── app-<hash>.css
├── source/                     Tier C: editable Vite project
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx           App entry
│       ├── App.tsx            Canvas + control panel layout
│       ├── ControlPanel.tsx   Renders the controls from manifest
│       ├── graph.json         The serialized graph
│       ├── manifest.json      Control + file-input manifest
│       └── engine/            Copy of engine + node defs (see §6)
│           ├── evaluator.ts
│           ├── gl.ts
│           ├── types.ts
│           └── nodes/         Just the node defs the graph uses
└── README.md
```

`source/src/engine/` is a **flat copy** of the editor's `src/engine/`
plus the relevant subset of `src/nodes/`. We compute the relevant
subset by walking the graph and including only the node types it
actually references — see §10 (tree-shaking).

---

## 6. The engine, packaged

The engine code is identical to what the editor runs — same files,
same types, same evaluator. The exact set of files that goes into
`source/src/engine/` is deterministic from the import graph:

```
source/src/engine/
├── coerce.ts
├── conventions.ts
├── evaluator.ts
├── gl.ts
├── placeholder-tex.ts
├── registry.ts
├── sdf.ts
├── spline-math.ts
├── spline-raster.ts
├── spline-transform.ts
├── types.ts
├── wire-geometry.ts
├── graph-helpers.ts             ← lifted from src/state/graph.ts (see below)
├── lib/                         ← node-side helpers
│   ├── audio.ts                 from src/lib/audio.ts
│   ├── fonts.ts                 from src/lib/fonts.ts
│   └── svg-parse.ts             from src/lib/svg-parse.ts
└── nodes/                       full node registry (Mode A)
    ├── index.ts                 generated registerAllNodes()
    ├── source/...
    ├── effect/...
    └── output/output.ts
```

**`graph-helpers.ts` is a renamed extract of `src/state/graph.ts`.**
That file currently provides `paramSocketType`,
`parseTargetHandleKind`, `paramTargetHandleId`, and the
`NodeDataPayload` type used by the evaluator and the editor. The
export only needs the helper functions (the type definitions are
already covered by `engine/types.ts`); we lift them into the
engine subtree so the export doesn't need to drag in
`src/state/`.

(Editor refactor for v1: actually move `paramSocketType` and
`parseTargetHandleKind` into `src/engine/graph-helpers.ts` so
both the editor and the export consume them from the same place.
One-time tidy that pays off once exports start shipping.)

**`source/src/lib/project.ts` (graph (de)serialization)** is also
copied into the bundle. Its only "editor" dep is the type-only
`import type { Edge, Node } from "@xyflow/react"`, which the
export build replaces with a 5-line local type alias.

**Mode A: full engine (default for v1).** Includes every node def
the editor knows about. Bundle size after minification + gzip:
~400KB engine + ~300KB node defs + ~100KB React + panel UI ≈
**~800KB total**, plus the user's graph JSON and any embedded
assets. The full-registry approach keeps the export pipeline
simple — no per-node tree-shaking, no risk of missing a transitive
dep.

**Mode B: tree-shaken (post-v1).** Only ship the node defs the
graph references. Vite handles this for free if our nodes/index.ts
is structured so each node is in its own export and we generate a
slimmer entry file at export time:

```ts
// source/src/engine/registerNodes.ts (generated by export)
import { registerNode } from "./registry";
import { perlinNoiseNode } from "./nodes/perlin-noise";
import { bloomNode } from "./nodes/bloom";
import { outputNode } from "./nodes/output";
// ...only the ones the graph uses

export function registerAllNodes() {
  registerNode(perlinNoiseNode);
  registerNode(bloomNode);
  registerNode(outputNode);
}
```

Saves 200-500KB on most exports. v1 ships the full registry to
keep the export pipeline simple.

---

## 7. The single-file `index.html` (Tier A)

The double-click-to-run experience requires more care than it sounds:

- **No external script imports.** Everything inlined as `<script>`
  blocks. Use Vite plugin
  [vite-plugin-singlefile](https://www.npmjs.com/package/vite-plugin-singlefile)
  — handles the inlining for you.
- **No ES module imports from `file://`.** Browsers refuse to load
  modules over `file://` for CORS reasons. The single-file build
  uses traditional `<script>` (no `type="module"`), which is what
  vite-plugin-singlefile does automatically.
- **No external assets.** Image / video / audio files the graph
  references stay as user-upload-on-load. Don't try to inline a
  10MB video into the HTML. Default fallback assets (a placeholder
  texture for unloaded images) are inlined as data URIs.
- **WebGL2 works fine over `file://`** — no special permission
  needed.

The single-file HTML ends up around 1-2MB for a typical patch
(engine + graph + panel UI). Email-able, share-able, no setup.

---

## 8. The Control Panel

Layout: fixed width sidebar on the right of the canvas, similar to
the editor. Top-down sections:

```
┌──────────────────────────────────┐
│ ▶ Play   ⏮ Reset                 │  ← Always present
├──────────────────────────────────┤
│ FILE INPUTS                      │  ← Auto-detected, mandatory
│ Image: [Choose File…] foo.jpg    │
│ Video: [Choose File…] —          │
├──────────────────────────────────┤
│ CONTROLS                         │  ← User-marked controls
│ Bloom intensity   ────●────────  │
│ Bloom threshold   ──●──────────  │
│ Color            [█████]         │
│ Mode             [smooth ▾]      │
└──────────────────────────────────┘
```

**Always-present section** (top, locked):
- ▶/⏸ play-pause
- ⏮ reset to start

**File inputs section** (auto-included, no opt-out):
The exporter walks the graph (using `computeNeededSet` so it only
sees nodes that actually drive the output) and finds every param
of these five types:

| ParamType    | Used by node      | Runtime ParamValue              |
|--------------|-------------------|---------------------------------|
| `file`       | image-source      | `ImageBitmap`                   |
| `video_file` | video             | `VideoFileParamValue` (HTMLVideoElement + URL) |
| `audio_file` | audio             | `AudioFileParamValue` (HTMLAudioElement + URL) |
| `svg_file`   | svg-source        | `SvgFileParamValue` (parsed subpaths) |
| `font`       | text              | `FontParamValue` (registered font family) |

Each appears in the panel as a file picker, regardless of whether
the user toggled "control" on. The reasoning: an exported app
whose first node is "upload an image" but doesn't expose that
upload is broken — better to force-include than let the user
accidentally ship a crippled app.

The blob-to-ParamValue conversion code is lifted directly from
the matching ParamPanel branches
([file](../src/components/effects/ParamPanel.tsx#L896),
[video_file](../src/components/effects/ParamPanel.tsx#L697),
[audio_file](../src/components/effects/ParamPanel.tsx#L645),
[svg_file](../src/components/effects/ParamPanel.tsx#L751),
[font](../src/components/effects/ParamPanel.tsx#L812)). For
`svg_file` we also need to bundle `lib/svg-parse.ts`. For `font`
we need `lib/fonts.ts` (registers the font with `document.fonts`).

**Controls section** (opt-in):
For each param marked with the new "control" toggle, render the
same React control the editor's ParamPanel uses (slider for
scalar, vec components for vec, picker for color, dropdown for
enum, etc.). The implementation lifts the simple-type branches
from `ParamControl` ([ParamPanel.tsx:543](../src/components/effects/ParamPanel.tsx#L543))
into a smaller `ExportParamControl` component that omits the
design-time-only types (paint, curves, color_ramp,
timeline_curve, merge_layers, spline_anchors). Same look, same
behavior, smaller surface — also makes the export bundle
independent of any future ParamPanel-only state.

The label uses the node name + param label so users can tell
which Bloom they're adjusting if there are several:

```
Bloom — intensity
Bloom (2) — intensity
```

**What we DON'T render:**
- `paint`, `merge_layers`, `curves`, `timeline_curve`,
  `color_ramp`, `spline_anchors` — design-time-only param
  types. If a user toggles "control" on one of these we show a
  warning in the editor that it won't appear in the export.

---

## 9. The new "control" toggle

A second pill button in ParamPanel, immediately to the right of
"expose":

```
[expose] [control]
```

Stored in `NodeDataPayload.controlParams: string[]` (parallel to
`exposedParams`). Persists in the project JSON. Default empty.

`onToggleParamControl(nodeId, paramName)` — same shape as
`onToggleParamExposed`. Adds a setter in EffectsApp, an event handler
in ParamPanel, an array in NodeDataPayload.

A param can be both **exposed** and **controlled**:
- Exposed = appears as an input socket on the node.
- Controlled = appears in the exported app's panel.

When both are on AND the socket is wired, the wired value wins at
runtime (matching current expose semantics) — the panel control still
renders and writes to the stored param, but the wire overrides on
each frame. Equivalent to the editor's "driven" indicator. Probably
worth surfacing the same indicator in the exported app's panel too
so the user understands why their slider isn't doing anything.

---

## 10. The control + file manifest

`source/src/manifest.json` (the schema is what powers
ControlPanel.tsx):

```ts
type ExportManifest = {
  appName: string;
  description?: string;
  // Output node the app renders. The editor's split-viewport
  // mode (see EffectsApp's viewportSplit) lets a graph have two
  // active terminals; the export modal picks one and only that
  // terminal's reachable subgraph is bundled.
  outputNodeId: string;
  canvasRes: [number, number];
  // Auto-detected, force-included. Built from the reachable
  // subgraph (see below) — the modal does NOT include file inputs
  // that aren't actually wired into the chosen output.
  fileInputs: Array<{
    nodeId: string;
    nodeName: string;       // "Image Source", "Video"
    paramName: string;      // "file", "video"
    paramType: "file" | "video_file" | "audio_file" | "svg_file" | "font";
    label: string;          // "Image" / "Video" / etc.
  }>;
  // User-marked. Same reachability filter applied.
  controls: Array<{
    nodeId: string;
    nodeName: string;       // "Bloom"
    paramName: string;      // "intensity"
    paramType: ParamType;   // for picking the right renderer
    label: string;          // "intensity"
    // The full ParamDef (min, max, step, options, default, etc.)
    // is duplicated here so ControlPanel doesn't have to load
    // the node defs just to render. Keeps the panel self-contained.
    def: ParamDef;
  }>;
};
```

**Reachability filter**: the manifest only includes file inputs
and controls from nodes that actually drive the chosen output.
Implemented by calling `computeNeededSet(nodes, edges,
outputNodeId)` from
[evaluator.ts](../src/engine/evaluator.ts#L176) — already a public
function the editor uses for its own per-frame eval. Means a node
that's been disconnected (orphan branch) doesn't show up in the
panel even if it's in the project JSON. Same source of truth the
runtime uses, no drift.

**Split-viewport policy**: in split mode the editor has two
active flags (`active` for viewport 1, `active2` for viewport
2). The export targets exactly one terminal — by default the
viewport-1 active node. The export modal surfaces a dropdown
when both are set so the user can pick. Exporting both as a
two-canvas app is out of scope for v1.

The manifest is generated at export time by the editor — walking
the reachable nodes, filtering by `controlParams`, joining
ParamDefs, listing file-input ParamTypes. Pure data, no codegen.

---

## 11. Where the export pipeline runs

Three options, in order of complexity:

**Option 1: client-side, in the editor.** Use JSZip in the browser
to assemble the zip from a pre-built template + the user's graph
JSON + manifest. Fast (under a second), no server cost, works
offline. The `dist/` and single-file `index.html` inside the zip
are **pre-built artifacts** shipped as part of the editor's static
assets (`public/export-template/v1/`) — we don't run Vite in the
browser. Pre-built once at editor build time, contains the full
node registry. The export pipeline patches in the user's graph +
manifest at zip time as fetched runtime files.

**Option 2: server-side, on demand.** The editor POSTs the graph
to an `/api/export` route, which runs Vite, produces the zip,
streams it back. Slower (5-10 seconds), costs Vercel function
time, but allows true tree-shaking and live-rebuilds when nodes
change.

**Option 3: hybrid.** Client-side for v1 (fast, free, offline).
Add a server-side path later if tree-shaking matters or if the
pre-built artifact ever gets too big.

Recommend: **start with Option 1.** The pre-built dist/index.html
artifacts that the editor serves are loaded on demand at export
time and combined with the user's graph + manifest. Total UX:
"click button → save dialog appears in <1s." If we ever need
trim, switch to Option 2.

**How the pre-built bundle "patches in" data without a rebuild.**
The bundled JS expects to fetch `./graph.json` and `./manifest.json`
from its own directory at startup. The export pipeline writes those
two files into the zip at the right paths and into the single-file
HTML as inlined `<script id="graph-data" type="application/json">`
blocks. App startup reads from window-scoped data when present,
otherwise fetches the JSON files. Both ship with every export so
both Tier A (single file) and Tier B (`dist/`) work without
modification.

A wrinkle on Option 1: the pre-built `index.html` is a fixed
bundle that contains every node def the editor knows about. So
exports are bigger than they need to be (probably 800KB-1MB
gzipped — see §6 — instead of the smaller tree-shaken result).
For v1 that's fine. Bigger wrinkle: every editor release
re-builds the export template, so a graph exported today and an
identical graph exported next month produce different artifacts
(same behavior, different bundle hash). Worth a one-line note in
the README of the export.

---

## 12. The export modal

When the user hits Export App on the Output node:

```
┌─ Export App ────────────────────────────┐
│                                         │
│  Name        [ My App           ]       │
│  Description [                  ]       │
│                                         │
│  File inputs (auto-included):           │
│   ✓ Image Source                        │
│   ✓ Audio Source                        │
│                                         │
│  Controls (3):                          │
│   • Bloom — intensity (scalar)          │
│   • Color Ramp — pos 0 (vec4)           │
│   • Threshold — value (scalar)          │
│                                         │
│  Output size:  1024 × 1024              │
│                                         │
│  [ Export → ]                           │
└─────────────────────────────────────────┘
```

If the graph has zero `controlParams`, show a hint: "No controls
selected. Mark params with the 'control' toggle to expose them in
the exported app. (You can still export — the app will just have
play/pause, reset, and any file inputs.)"

If a "control" toggle is set on a non-exportable type (paint,
curves, etc.), warn before export with a list of what's being
dropped.

---

## 13. Runtime behavior of the exported app

On load:
1. Parse `graph.json`.
2. Initialize the engine — `createEngineBackend(W, H)` and
   `registerAllNodes()`.
3. Render the canvas + panel.
4. Start the playback loop. Default to **paused** so the user
   sees the first frame instead of an animating one (most patches
   look better starting from a known state). Hitting play
   advances time.

When the user adjusts a control:
- Local state updates.
- The graph's stored `params[paramName]` value gets written.
- Next frame's `evaluateGraph` call picks it up automatically (no
  special wiring needed — exactly like ParamPanel does in the
  editor).

When the user uploads a file:
- Same logic as the editor's file param handlers — convert the
  blob into the right ParamValue shape (HTMLImageElement,
  HTMLVideoElement, etc.), assign to the param, next frame
  re-evaluates.

When the user hits reset:
- `time = 0`. Pipeline re-runs. No state preservation across
  frames is reset (e.g. trail accumulators clear on next eval
  because the render-pass cache for that node sees a new time
  fingerprint).

---

## 13b. Editor prerequisites surfaced by this work

Two latent bugs / refactors the export work surfaces. Worth fixing
in the editor first since the export inherits whatever the editor
does:

1. **`def.dispose` is never called.** Many node defs implement
   `dispose(ctx, nodeId)` to free GL textures, framebuffers, audio
   elements, etc. (see `src/nodes/source/audio.ts`,
   `image-source.ts`, `paint.ts`, `text.ts`, etc.). Grep
   confirms zero call sites of `def.dispose` anywhere in the
   editor or engine — the contract is declared but never honored.
   The editor's been getting away with it because it doesn't
   reload graphs in-place at runtime; the page just navigates and
   the GL context is destroyed wholesale. The exported app has
   the same property, so this is *not* an export blocker — but
   the existence of `dispose` hooks on the node defs is misleading
   if it never fires. Either (a) wire `dispose` into a node-
   removal handler in EffectsApp + a context-teardown handler
   in the export's runtime, or (b) drop the `dispose?` field
   from `NodeDefinition` and remove all the dead implementations.
   Either is fine; pick one before users start writing custom
   nodes that rely on cleanup.

2. **`paramSocketType` and `parseTargetHandleKind` live in
   `src/state/graph.ts`** but the engine's evaluator imports them.
   This is the only engine-→-editor import leak. v1 fix: move
   those two functions into a new `src/engine/graph-helpers.ts`
   so the engine is fully self-contained, then update both the
   editor and the export bundle to import from the new home. Pure
   move; no behavior change.

## 14. Implementation milestones

1. **The "control" toggle.** New button in ParamPanel,
   `controlParams` field on NodeDataPayload, persistence through
   serializeGraph/deserializeGraph. Pure UI / state work, no
   export pipeline yet. Validates the toggle UX in isolation.
2. **Manifest builder.** Pure function: takes (nodes, edges)
   → ExportManifest. Detects file inputs, joins controls with
   their ParamDefs, validates against the unsupported-types list.
   Unit-testable in isolation.
3. **Pre-built export template.** A small Vite app
   (`src/export-template/`) that takes a graph + manifest at
   load time and renders. Built once at editor-build time;
   produces a `dist/` and a single-file `index.html` shipped as
   editor static assets.
4. **Client-side packager.** JSZip-based assembler. Reads the
   pre-built artifacts from `/export-templates/v1/`, combines
   with the user's graph and manifest, downloads the zip.
5. **Export App button on the Output node + modal.** Wire the
   trigger.
6. **README generation.** Auto-include a README with run / host /
   edit instructions, customized with the app name.

After v1:
- Server-side build path with tree-shaking.
- "Embed" mode — return an iframe-able URL instead of a zip.
- Custom panel themes / branding.

---

## 15. Asset embedding policy (decided)

The runtime ParamValue lifetime varies by file type, so the
embedding policy varies too:

| Param type    | Embed by default? | Policy                       |
|---------------|-------------------|------------------------------|
| `file` (image)| **Yes**           | Already serialized as base64 data URL by the existing `serializeParams` path. The export inherits this for free — the graph JSON IS the embedded asset. Hard cap at ~5MB per image; warn the user above 2MB. |
| `svg_file`    | **Yes**           | The serialized form is parsed-subpaths JSON, not a binary blob — already round-trips cleanly. Negligible size. |
| `audio_file`  | **Opt-in**        | Add the file as a base64 data URL in the export bundle. Hard cap ~10MB. Off by default; export modal has a per-file checkbox "embed this file?". |
| `video_file`  | **Off (default)** | Videos are too big to inline. The exported app starts with no video loaded; the user re-uploads via the panel. Modal can offer "embed anyway (+NN MB)" for power users with small clips. |
| `font`        | **Yes**           | Custom fonts go in as a base64-encoded font file under 5MB. The runtime registers them via `document.fonts.add(new FontFace(...))` on startup — same API the editor uses today via `lib/fonts.ts`. |

**Total bundle size cap**: 25MB for the zip. Above that the
export modal blocks export with a list of which assets to
unembed. Encourages a cleaner publishing flow without making it
impossible.

These decisions extend the existing `serializeParams` /
`deserializeParams` paths in
[src/lib/project.ts](src/lib/project.ts) — the export's "asset
embedding" is conceptually just a richer serialize step. New
serializer flag `embedAssets: true` triggers the embedded path
for the four otherwise-null types.

## 16. The Export App button

Lives in two places:

1. **Output node header** — small icon button next to "A" /
   "B" / "A1" / "A2", visible only when `defType === "output"`.
   Same pattern as the existing "+" button on the merge node
   ([EffectNode.tsx:253-268](../src/components/effects/EffectNode.tsx#L253-L268)).
   One-click affordance for users who already know what they
   want.
2. **ParamPanel** for an Output node — a primary action button
   at the top of the params panel labelled "Export App →". More
   discoverable for first-time users, plus easier to surface
   metadata (asset size, control count) inline above the button.

Both trigger the same export modal (§12).

## 17. Open questions

- **Where does the pre-built export template live in the repo?**
  Probably `src/export-template/` with its own vite config that
  builds into `public/export-template/v1/`. Build runs as part
  of the editor's build, not on every dev reload.
- **Versioning.** As we add nodes, the engine surface changes.
  Old exports keep working because they bundled the engine they
  were built with — but a user who exports today and re-exports
  the same graph next year will get a different (newer) bundle.
  That's probably fine; it matches how every other compile-once-
  ship-once tool works. Worth a note in the README.
- **Custom (user-defined) nodes.** The
  [custom-node spec](customnodespec.md) introduces user-authored
  scripts. Exports including a custom node should bundle the
  user's script source + the QuickJS runtime. Add a §-in-this-
  spec when that lands.
- **Control ordering.** Today controls appear in node-creation
  order. Worth letting the user reorder them in the export modal?
  Probably yes — drag to reorder in the controls list. Easy to
  add in v1 modal.
- **Light / dark theme.** Default to dark to match the editor.
  Add a theme toggle in v2 if anyone asks.
- **What about unstable nodes (`stable: false`)?** Some source
  nodes (SceneTime, webcam, audio analyzers, MediaPipe trackers)
  have `stable: false` and rely on the editor's per-frame
  re-fingerprinting. The export's runtime calls `evaluateGraph`
  the same way the editor does — `stable: false` works
  identically. No change needed. Worth a smoke test that the
  webcam node in particular survives the export, since it
  asks for a permission grant on first use.
- **Hand-tracker / object-tracker / MediaPipe assets.** These
  nodes ship MediaPipe model binaries that the editor loads from
  CDN at runtime. Exported apps will hit the same CDN unless we
  also bundle the model files. v1: leave them as CDN fetches
  (works online; fails offline). v2: option to bundle.
- **Out-of-bounds canvas zoom / pan.** The editor lets you
  zoom/pan the preview canvas. The exported app probably
  shouldn't — those are editing affordances, not viewing
  affordances. Default: no pan/zoom in the export. Add a
  `viewerPanZoom: boolean` to the manifest if anyone asks.

---

## 18. Things explicitly NOT in this spec

- Live preview of the exported app inside the editor (could come
  later as a "test the export" view).
- Server-rendered / SSR exports. Always client-only canvas.
- Multi-page exports. One graph, one canvas, one panel.
- User accounts inside the exported app. The export is anonymous
  / unauthenticated.
- Analytics / telemetry. The exported app is offline-friendly and
  phones home to nobody.
- Mobile-optimized layout. The panel is desktop-shaped in v1; if
  a mobile use case appears, a separate "compact panel" layout is
  a small follow-up.
