# Copy to toolbox (Figma plugin)

Select a frame → **Convert** → **Copy to clipboard** → ⌘V over toolbox's node
editor. The frame arrives as a wired node graph in its own layer: Merge for
the layer order, Spline Draw → Rasterize Spline for shapes, Image Source for
images. Design notes and the full mapping: `specdocs/092326_figma-import.md`.

## Run it

From the repo root:

```bash
npm run figma-plugin:build
```

Then in the Figma **desktop app** (development plugins don't load in the
browser): **Plugins → Development → Import plugin from manifest…** and pick
`figma-plugin/manifest.json`. Run it from **Plugins → Development → Copy to
toolbox**.

While iterating, keep a watcher running and turn on **Plugins → Development
→ Hot reload plugin**:

```bash
npm run figma-plugin:watch
```

Logs from the plugin: **Plugins → Development → Open console**.

## Options

- **Include Figma's render** — adds Figma's own PNG of the frame. Toolbox
  places it as a detached "Figma reference" node for A/B checks. Roughly
  doubles the payload; leave it off for everyday copies.
- **Download JSON** — the same payload as a file. Drop it on toolbox's node
  editor when a frame is too big for the clipboard (others report copy
  failures above ~5 MB), or put it in `scripts/fixtures/figma-import/` to
  make it a regression test.

## Layout

| File | What it does |
|---|---|
| `src/code.ts` | Main thread: selection tracking, Convert, stale detection after edits |
| `src/extract.ts` | The walk: Figma frame → `FigmaScene` (`src/lib/figma-import/scene.ts`) |
| `src/ui.ts`, `src/ui.html` | The panel; the clipboard write happens here |
| `build.mjs` | esbuild → `dist/code.js` + `dist/ui.html` (UI inlined: Figma loads it as one string) |

`npm run figma-plugin:typecheck` type-checks both threads. If Figma rejects
the manifest's `id`, create an id with **Plugins → Development → New
plugin…** and paste it into `manifest.json`.
