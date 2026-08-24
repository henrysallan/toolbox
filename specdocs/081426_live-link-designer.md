# Live Link Designer — spec (2026-08-14)

Status: designed with owner (Q&A 2026-08-14). M0–M3 implemented
2026-08-14 → 2026-08-17 (gates green; in-browser verification pending).
M4 (real preset packs) blocked on owner references. Implementation
deltas from this spec: no export-gif.ts core refactor was needed — its
`renderFrame` callback shape already fit the viewer, so the viewer GIF
is frame-stepped (deterministic, better than the planned live capture)
with an additive `signal` option for cancel; viewer-export.ts is fully
self-contained (own download/mime helpers) because lib/export.ts routes
through the platform seam, which the template bundle shouldn't carry.
Prereq reading: devguide § Export (exported apps / manifest), § Repo map
(`lib/live-viewer/`), archive/exportappspec.md (§ post-v1 lists control
reordering + custom panel themes — this spec is those, grown up).

## What this is

A **Live Link Designer**: a full-screen authoring surface (menubar stays
visible, content inset with padding) opened from **File → Live Link…**,
where the author styles and arranges the live link's presentation, previews
the UI accurately, and saves the result **into the project**. One design
drives **both** viewer surfaces — the hosted `/live/[slug]` page and the
exported standalone app — because they already share
`lib/live-viewer/LiveViewer.tsx` + `ControlPanel.tsx` + the manifest.

Customization is **bounded, not infinite**: layout and theme are manually
tweakable within fixed enums; control chrome (slider / dropdown / numeric
styles) and fonts come only from **curated preset packs** the owner
authors. v1 ships the preset *machinery* with a single "classic" pack;
real packs land later when the owner supplies references.

Second half: a **basic viewer-facing export** (image / video / gif) so
visitors can capture what they made, gated per-mode by author toggles in
the designer. Default: all off (existing links unchanged).

Non-goals (deferred, § Deferred): control grouping/sections, hiding
controls in the designer (un-toggle `controlParams` in the editor instead),
link version pinning, embed/iframe mode, webfont preset loading, audio in
viewer video capture, choosing a different output node per link.

## Current state (what we're building on)

- `/live/[slug]`: `page.tsx` (server, force-dynamic) →
  `LiveClient.tsx` (builds the manifest in-browser via
  `buildExportManifest`) → `LiveViewer.tsx` (deserialize → RAF →
  `evaluateGraph` → blit) + `ControlPanel.tsx` (fixed 280px right
  sidebar; transport + File Inputs + Controls sections; each control row
  delegates to the editor's `ParamControl`).
- Control membership = per-node `controlParams` string arrays
  (state/graph.ts:48). Order = graph-walk order. No config object exists
  anywhere for ordering, labels, theme, or layout.
- Appearance = hardcoded dark palette in `lib/live-viewer/styles.css`
  (`--bg`/`--text`/`--accent` on `.live-root`) + the shared
  `form-controls.css` chrome. `scripts/theme-scope.mts` deliberately
  excludes live-viewer from the editor theme system (user artifacts).
- The exported app reuses LiveViewer + styles.css verbatim
  (`src/export-template/src/App.tsx`), fed by an embedded blob instead of
  Supabase. The manifest (`lib/live-viewer/manifest-types.ts`,
  `schemaVersion: 1`) is the serializable intermediate powering both.
- Export machinery (image snapshot, 3 video tiers, gif via ffmpeg.wasm +
  gifsicle) is mature but editor-only: encoders are standalone libs, the
  *drivers* live in EffectsApp tangled with editor refs.

Two defects found while mapping, fixed in M0:

1. **/live renders every project at 1024×1024.** LiveClient.tsx:95-99
   hardcodes `canvasRes` with a stale comment claiming resolution isn't
   saved — `SavedScene.width/height` exists (project.ts:204-205) and is
   written on every save. Non-square projects render wrong-aspect today.
   (Export App passes the real res; only /live is affected.)
2. **`lib/live-viewer/ExportParamControl.tsx` is dead** — superseded by
   the shared `ParamControl`; no longer imported. Delete.

## Data model — `LiveDesign`

New module **`src/lib/live-viewer/design.ts`** owns the shape. It must
live under `lib/live-viewer/` (not `components/` or `theme/`) because the
export template bundles it; nothing in it may import editor-only modules
(watch the vite alias/shim rules in devguide § Exported apps).

```ts
export interface LiveDesign {
  version: 1;
  layout: {
    canvas: "inset" | "full-bleed";
    // inset  = today's contain-in-padded-area (+ radius, shadow)
    // full-bleed = canvas scales to COVER the viewport, crop overflow
    panelSide: "left" | "right";
    panelMode: "full-height" | "floating";
    // full-height = flanking column (today); floating = overlay card
    // positioned over the canvas area on panelSide, max-height capped,
    // internally scrolling
    panelAlign: "top" | "middle" | "bottom";
    // vertical anchor of the floating card (added 2026-08-17);
    // full-height ignores it
    cornerRadius: "none" | "small" | "large";
    // enum, not px — bounded customization. design.ts maps to px
    // (0 / 10 / 20) applied to the inset canvas rect and the floating
    // panel card. Ignored where meaningless (full-bleed canvas,
    // full-height panel edges).
  };
  theme: {
    mode: "dark" | "light";
    tintHue: number | null;   // degrees; null = neutral greys
    tintStrength: number;     // 0..1, chroma scale — same semantics as
                              // the editor theme's grey tint
    panelOpacity: number;     // control-panel bg alpha, 0..1 (added
                              // 2026-08-17; --panel-bg token)
    panelBlur: number;        // control-panel backdrop blur px, 0..40
                              // (--panel-backdrop, emitted only when >0)
  };
  presets: {
    slider: string;   // preset ids into the registries in design.ts;
    dropdown: string; // unknown id → "classic" (forward compat when a
    numeric: string;  // pack is removed)
    font: string;
  };
  controls: {
    order: string[];  // refs "<nodeId>::<paramName>" — same key format
                      // ControlPanel already uses. One list covering
                      // both Controls and File Inputs entries; each
                      // section sorts its own members by index here.
                      // Unlisted entries append after ordered ones in
                      // manifest order; stale refs are dropped silently
                      // (nodes get deleted — never error).
    labels: Record<string, string>; // ref → rename override. Applies to
                                    // control + file-input rows. Empty
                                    // string = fall back to default.
  };
  export: {
    image: boolean;   // all default FALSE — absent design block or
    video: boolean;   // absent flags = today's behavior, no export UI
    gif: boolean;
    resolution: [number, number] | null;
    // canvas-size override for the whole live link (render + capture),
    // null = project resolution (added 2026-08-17; surfaced in the
    // designer's Export section via the shared res-controls fields,
    // applied by both manifest producers onto manifest.canvasRes)
  };
}
```

Rules, following the `SavedProject.layout` precedent (project.ts:240-247):

- **Storage**: `SavedProject.liveDesign?: unknown` — additive, opaque in
  project.ts, schema stays 10. Older builds ignore + drop it on resave,
  losing only the design. `design.ts` owns
  `fromSavedLiveDesign(unknown): LiveDesign` (validates untrusted blobs
  field-by-field, defaulting anything malformed — a live link renders
  attacker-adjacent public rows) and `DEFAULT_LIVE_DESIGN`.
- **Attach/apply**: EffectsApp holds the working copy in state
  (`liveDesignRef` + state, exactly like `layout`): attached
  post-serialize at the cloud + .toolbox save sites, applied on all
  three load paths (cloud / .toolbox / public `/p/`), reset by File →
  New. Saving from the designer marks the project dirty.
- **Delivery to the viewers**: `ExportManifest` gains optional
  `design?: LiveDesign` (schemaVersion stays 1 — additive; old bundled
  viewers ignore it). LiveClient sets
  `manifest.design = fromSavedLiveDesign(graph.liveDesign)`;
  `runExportApp` does the same at package time. LiveViewer/ControlPanel
  read **only** `manifest.design` — they never see SavedProject, which
  keeps the template contract unchanged.

## Viewer rendering (M1)

All changes scoped to `lib/live-viewer/` and keyed off
`manifest.design ?? DEFAULT_LIVE_DESIGN` (absent = pixel-identical to
today: dark, right, full-height, inset, classic, no export).

### Layout

`.live-root` gets data attributes from the design
(`data-canvas`, `data-panel-side`, `data-panel-mode`, `data-radius`,
`data-slider`, …) and styles.css branches on them:

- `panelSide: left` — flex order swap + border side flip.
- `panelMode: floating` — sidebar becomes an absolutely-positioned card
  (top/side offset ~16px, max-height `calc(100% - 32px)`, own scroll,
  radius + shadow) over the canvas area; canvas area takes full width.
- `canvas: full-bleed` — canvas area drops its padding; the canvas
  element scales to cover (compute cover-fit in LiveViewer's existing
  resize handler — CSS `object-fit: cover` doesn't apply to a
  fixed-buffer canvas without explicit width/height, so keep the sizing
  where the contain math already lives).
- `cornerRadius` — px on the inset canvas + floating card.

### Theme + tokens — the accuracy trap

Today the viewer's *chrome* colors come from `.live-root`'s hardcoded
vars, but the *form controls* (form-controls.css) are unscoped
`var(--tb-n-*, fallback)` rules. On `/live` the app's global
theme-tokens.css **does** define `--tb-n-*`, so sliders there silently
track the app-level theme; in the exported app they fall back to
literals. And inside the designer's preview (which renders `.live-root`
in the editor document) they would inherit the **editor's** current
theme — exactly the inaccuracy the owner said is unacceptable.

Fix: `design.ts` exports `designTokens(design): Record<string, string>`
— the complete token sheet, computed in TS:

- Base palettes for `dark` and `light` (the light palette is new;
  authored in design.ts, NOT derived from editor theme).
- Tint applied as one OKLCH round-trip per grey token (hue pushed onto
  neutrals, chroma × strength — same math as editor theme.ts; copy the
  ~40 lines of pure OKLCH conversion into design.ts or extract a leaf
  color module both can import — decide at implementation; the template
  build must stay green either way).
- The sheet defines **every** custom property the viewer consumes:
  the `.live-root` `--bg`/`--text`/… family AND explicit values for the
  `--tb-*` names form-controls.css reads, so no surface — /live,
  exported app, or in-editor preview — can inherit anything from its
  host document. Applied as inline style on `.live-root`.
- `color-scheme` follows `theme.mode` (native pickers/scrollbars).

This also makes /live deterministic for anonymous visitors (today it
half-follows app tokens).

### Control style presets

New `lib/live-viewer/design-presets.css`: per-preset rules scoped
`.live-root[data-slider="<id>"] input[type=range]::-webkit-slider-*` etc.
Each rule block **fully re-specifies** track/thumb/appearance from design
tokens — never relying on the unscoped form-controls.css values — so a
preset can't half-inherit editor chrome. Same pattern for
`data-dropdown` (select styling) and `data-numeric` (number input +
spinner). Font preset = a `font-family` stack on `.live-root`
(`FONT_PRESETS` in design.ts: `{ id, label, stack }`; v1 ships
system-stack entries only — sans / mono at minimum; webfont loading is
deferred until the owner's references arrive, but keep an optional
`webfontUrl` field in the registry type so packs can carry one later).

v1 registries ship **one "classic" preset per class** (pixel-identical
to today) — machinery proven end-to-end, packs added by appending
registry entries + CSS blocks.

### Order + rename

ControlPanel sorts each section's rows by `design.controls.order` index
(ref `${nodeId}::${paramName}`, the existing `paramKey` format) and
overrides row labels from `design.controls.labels`. Both fall through
gracefully: unlisted → manifest order after ordered entries; stale refs
ignored; missing label → today's `"<nodeName> — <paramLabel>"`.

## The Designer surface (M2)

**Entry**: File → **"Live Link…"** in MenuBar (near Export…). Always
enabled — you can author the design before publishing; publishing stays
where it is (visibility popover).

**Shell**: full-screen overlay inside EffectsApp (Landing/LoadGrid
precedent — editor state stays mounted underneath), top edge below the
menubar, ~16-24px padding all around. Escape = cancel-with-confirm if
dirty. New directory `src/components/effects/livelink/` —
`LiveLinkDesigner.tsx` + panels. This is editor-side code and may use
editor theme tokens for its OWN chrome (the settings column); only the
preview is design-token land.

**Structure**: settings column (left, editor-themed) + preview (rest).

Settings sections:

1. **Layout** — canvas mode, panel side, panel mode, corner radius
   (segmented pills).
2. **Theme** — dark/light toggle, tint hue wheel/slider + strength,
   live-updating.
3. **Styles** — preset pickers for slider / dropdown / numeric / font
   (dropdowns now; can grow visual swatch rows when real packs land).
4. **Controls** — the reorder/rename list: one row per manifest control
   and file input (section-tagged), drag handle to reorder (pointer-based,
   the `useTileDrag` pattern from LoadGrid is the precedent), label
   double-click/pencil to rename inline, reset-label affordance.
5. **Export** — three toggles: Image / Video / GIF, defaults off.

Save / Cancel in a footer. Save = `setLiveDesign(next)` in EffectsApp +
dirty mark (design persists on the next project save — same lifecycle as
layout presets; no separate DB write). Cancel discards.

### Preview

Owner decision: canvas *content* fidelity is unimportant; **UI fidelity
is mandatory**. So:

- The preview renders the **real** `.live-root` DOM — actual
  `ControlPanel` + a placeholder canvas — inside an **iframe**
  (same-origin, `createPortal` into its body — the PanelPopout
  window-portal precedent, iframe flavor). The iframe is what guarantees
  accuracy: editor globals, Tailwind, and `:root` theme tokens cannot
  cascade in. Inject `styles.css` + `form-controls.css` +
  `design-presets.css` into the iframe head (clone the `<link>`/`<style>`
  nodes on mount, the same trick PanelPopout uses).
  - Fallback if the iframe-portal fights React in practice: same-document
    render is acceptable **only because** designTokens defines every
    consumed var on `.live-root` — but iframe is the primary plan.
- No engine in the preview. The canvas slot renders a static poster at
  the project's real aspect (`canvasRes` from scene): one-shot
  `drawImage` of the editor's preview canvas taken when the designer
  opens; fallback = flat `--bg`-adjacent rect. Correct aspect matters
  (full-bleed vs inset is the thing being authored); pixels don't.
- Manifest: built live from the current editor graph via
  `buildExportManifest` (what ExportAppModal already does) — the
  designer works on unpublished projects.
- Controls in the preview are interactive with **ephemeral** values — a
  local `Map` seeded from node params, never written to the project (no
  undo entries, no autokey). Auditioning a slider is for feeling the
  chrome, not editing the patch. Transport buttons render but are inert.
- Preview renders 1:1 in the available rect with a size readout;
  viewport-size simulation (phone/desktop presets) is deferred.

## Viewer export (M3)

New **`src/lib/live-viewer/viewer-export.ts`** — lean drivers taking
`(canvas, scene: {fps, loopFrames}, appName)`. Deliberately NOT the
editor drivers: no Output-node params, no resolution brackets, no sim
preroll, no tiers. Canvas-resolution capture of what the visitor sees.

- **Image** — `canvas.toBlob("image/png")` → download
  `<appName>.png`. (The live canvas is a 2D blit target, same as the
  editor preview — `toBlob` just works.)
- **Video** — `canvas.captureStream(fps)` + MediaRecorder with
  `pickVideoMime` (lib/export.ts — pure, safe to import), recording
  exactly one loop (`loopFrames / fps` seconds); no loop set → cap at
  10s. Download `.webm`/`.mp4` per mime. **Silent in v1** (audio
  requires tapping the shared AudioContext through a
  MediaStreamDestination — deferred). Known trap (TESTING.md): a
  backgrounded window records zero frames — surface a "keep this tab
  visible" note in the recording UI.
- **GIF** — capture PNG frames live during one loop at ~15fps
  (`canvasToPngBytes`), then the ffmpeg palettegen/paletteuse +
  gifsicle-normalize pipeline. Refactor `export-gif.ts` so its core
  (`framesToGif(frames, opts)`) is callable without Output-node params;
  the editor path passes its params, the viewer passes fixed defaults
  (128 colors, dither on, no lossy, opaque). Requires network for the
  ffmpeg core (unpkg — matches editor behavior); in an offline exported
  app the GIF button degrades to a clear error toast on first failure.

**UI**: an "Export" row in ControlPanel's transport section — one button
per enabled mode (`design.export.*`), with an in-progress state
(recording / encoding) and a cancel for video/gif. No modes enabled →
row absent (today's UI exactly).

Bundle note: viewer-export + the gif core get bundled into the export
template — verify `npm run build:export-template` stays green and the
template's dist doesn't accidentally inline the ffmpeg wasm (it loads
from unpkg at runtime; keep it that way).

## Milestones

**M0 — groundwork + fixes** (no visible design features)
- Fix /live canvasRes: use `scene.width/height` (active composition's
  compat mirror), fallback 1024² only when genuinely absent; delete the
  stale comment. Verify a non-square public project renders right.
- Delete `ExportParamControl.tsx`.
- `design.ts`: types, `DEFAULT_LIVE_DESIGN`, `fromSavedLiveDesign`,
  `designTokens` (incl. OKLCH tint), preset registries ("classic").
- `SavedProject.liveDesign` carry + EffectsApp attach/apply at the
  layout-block sites + File → New reset.
- `manifest.design` threading (LiveClient + runExportApp).
- Gates: typecheck, lint ratchet, `npm run check`,
  `npm run build:export-template`.

**M1 — viewer honors the design**
- styles.css data-attr branches (layout modes, radius), token sheet
  applied inline, design-presets.css with classic presets, order +
  labels in ControlPanel.
- Acceptance: a hand-authored `liveDesign` blob in a saved project
  changes /live and a fresh Export App identically; absent block =
  pixel-identical to today; light mode + tint legible across every
  control type (scalar, vec, color, ramp, dropdown, file rows).

**M2 — the Designer**
- File → Live Link… full-screen surface; iframe-portal preview with
  poster canvas; Layout/Theme/Styles/Controls/Export sections; drag
  reorder + inline rename; ephemeral control audition; Save/Cancel with
  dirty confirm; design lands in project state and survives save/load
  round-trips (cloud + .toolbox).

**M3 — viewer export**
- `viewer-export.ts` drivers; `export-gif.ts` core refactor (editor gif
  export must be behaviorally unchanged); ControlPanel export row gated
  on toggles; designer Export section wired.
- Acceptance: on a published link — PNG downloads at canvas res; video
  records one loop and plays in QuickTime/Chrome; GIF opens in macOS
  Preview (the gifsicle-normalize requirement); all three absent when
  toggles are off; Export App build green and its export buttons work.

**M4 — preset packs (blocked on owner references)**
- Real slider/dropdown/numeric/font packs from the owner's references;
  possible webfont loading; swatch-style preset pickers in the designer.

## Deferred / open

- Control grouping into labeled sections; hiding controls from the
  designer; per-link output-node choice (heuristic stays).
- Link version pinning (link tracks head today — editing silently
  changes shared links; separate feature).
- Embed/iframe mode (exportappspec post-v1 note stands).
- Audio track in viewer video capture; offline-capable GIF encode.
- Viewport-size simulation in the preview.

On ship: update devguide (§ Repo map live-viewer entry, § Export exported
apps paragraph, § Specdocs) and the in-app docs page for live links.