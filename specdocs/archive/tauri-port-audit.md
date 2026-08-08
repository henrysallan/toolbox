# Tauri / Rust Port Audit — "toolbox"

> Feasibility audit for porting the app from a Next.js web app to a Tauri
> (Rust + system-webview) desktop app. Snapshot date: 2026-06-06.

## TL;DR

**Very little of the *actual app* needs to be rebuilt.** This is a ~75k-line
React + WebGL2 application. The engine, all 131 nodes, the UI, state management,
export pipeline, and AI features are framework-agnostic React/TypeScript that run
inside a webview essentially as-is.

What actually needs rebuilding is the **shell, not the app**: the Next.js server
layer, the Supabase cloud backend (auth + DB + storage + sharing), and a few
browser-API edge cases that behave differently in macOS's WKWebView.

Honest framing: **"Tauri port" ≈ "replace the cloud-and-server ~10% and re-host
the other ~90%."** The big strategic question isn't technical feasibility — it's
*what you give up* (cloud sharing, the `/live` gallery, accounts) by going
desktop-first.

---

## What the codebase actually is

| Area | Files | Lines | Role |
|---|---|---|---|
| `src/nodes` | 131 | 30.9k | The 131 effect/source/sdf/output nodes |
| `src/components` | 60 | 29.9k | React UI (node editor, panels, timeline, gizmos) |
| `src/engine` | 29 | 7.5k | Graph evaluator + WebGL2/WebGPU backends |
| `src/lib` | 31 | 5.8k | Export, AI, Supabase, live-viewer |
| `src/app` | 11 | 0.6k | Next.js App Router pages |
| `src/state` | 3 | 0.3k | History/undo + session (plain React hooks) |
| **Total** | **267** | **~75k** | (excludes `node_modules` + `export-template`) |

Rendering is **WebGL2-first** — every node uses fragment shaders, and SDF nodes
compile to GLSL on the fly via `sdf-compile.ts`. **WebGPU is used in exactly two
places** — the WebGPU particle simulator and stipple relaxation — and **both
already have WebGL2/CPU fallbacks.**

---

## Portability tiers

### ✅ Runs as-is in a webview (~90% / ~68k lines)

- **The entire engine** — `evaluator.ts`, `gl.ts`, `sdf-compile.ts`, plus
  caching/fingerprinting. Pure TS + WebGL2, zero framework deps.
- **~80 of 131 nodes** — all SDF, all math/utility, all image effects (bloom,
  blur, dither, color-correct), particle sim, reaction-diffusion. Shaders move
  verbatim.
- **All UI** (`src/components`) — plain React 19. Only the root page touches Next.
- **State** (`src/state`) — plain hooks + module-level snapshot. No changes.
- **AI features** — `bg-remove` (Transformers.js + ONNX/wasm) and OpenAI
  image-gen are client-side `fetch`/wasm. IndexedDB model cache works in webview.
- **Export pipeline** — ffmpeg.wasm (already single-threaded, so no
  SharedArrayBuffer / COOP-COEP header requirement) and WebCodecs both work in a
  webview.

### ⚠️ Needs rewiring, not rewriting (~5%)

- **Browser-media nodes** — `video` (369), `webcam` (353), `audio` (233),
  `image-source`. These use `HTMLVideoElement` / `getUserMedia` / file pickers.
  They *mostly* work in a webview, but file access should go through Tauri's
  `fs`/dialog APIs instead of browser file inputs.
- **`text` node** (868) — uses Canvas2D + `@font-face` variable-font loading.
  Works in webview, but font discovery differs on desktop.
- **Persistence** — `serializeGraph` / `deserializeGraph` already exist and are
  clean; just need a new save target (local files / SQLite) instead of Supabase.

### 🔴 Must be rebuilt or dropped (~5% / the real work)

- **Supabase backend** (~700 lines across `src/lib/supabase` +
  `auth/callback/route.ts`): auth (Google OAuth), `projects` DB,
  thumbnail/image storage buckets, `user_preferences`, ratings.
  → replace with **local SQLite (Tauri SQL plugin) + filesystem**, API keys in a
  local store.
- **Next.js server layer**: `auth/callback/route.ts`, the SSR `generateMetadata`
  + server-side `loadPublicProjectBySlug` in `/p/[slug]` and `/live/[slug]`.
  → these dynamic server routes don't exist in a Tauri SPA; logic moves
  client-side.
- **Cloud sharing** (`/live/<slug>`, `/p/<slug>`, public gallery, ratings): this
  is **fundamentally a web feature.** Desktop can export/import project files,
  but "share a URL" requires keeping a web deployment around.

---

## The two genuinely hard problems

**1. WebGPU on macOS WKWebView.** Tauri uses the *system* webview — WKWebView on
macOS, where WebGPU is experimental/unreliable; WebView2 (Windows) and recent
WebKitGTK (Linux) are better. The two WebGPU nodes have fallbacks, so this isn't
a blocker, but you'd ship the slower path on Mac unless you bridge compute to
native `wgpu` in Rust. WebGL2 itself is fully supported on all three platforms.

**2. Why Tauri at all?** Worth being explicit, because it changes the plan.
- If the goal is *native file handling, offline use, no hosting costs, a real app
  icon* → Tauri is a great fit and the port is modest (weeks).
- If the goal is *performance* → the heavy lifting is already on the GPU via
  WebGL2, and Tauri's webview runs the same WebGL2, so you gain **little raw
  speed** unless you also move specific kernels (fracture's Delaunay/Lloyd's,
  particle sim, stipple) into native Rust `wgpu`/`rayon` — a separate, larger
  effort.

---

## Effort estimate

| Path | Scope | Estimate |
|---|---|---|
| **MVP desktop** | Tauri shell, WebGL2 only, local file save/load, drop cloud sharing & accounts, keep all nodes + UI + export | **~2–3 weeks** |
| **Full-featured** | Above + SQLite project library, local prefs/API keys, native media/file dialogs, font handling, keep a web gallery for sharing | **~4–6 weeks** |
| **Performance-native** | Above + move WebGPU compute (particles/stipple) and CPU-heavy nodes (fracture) to Rust `wgpu`/`rayon`, native WebGPU on Mac | **+1–3 months** |

The first row is the real answer to "how much needs to be rebuilt": **the app
survives; you write a Tauri shell, swap Supabase for local storage, and delete
the Next.js server routes.**

---

## Recommended sequencing

1. **Stand up the Tauri shell** wrapping `EffectsApp` as a static SPA (Next
   static export, or swap to Vite). Confirm WebGL2 + the node graph render in
   WKWebView.
2. **Cut the server cord**: remove `auth/callback`, make `/p` and `/live`
   client-only, stub Supabase behind an interface.
3. **Local persistence**: implement save/load to disk (`serializeGraph` is
   ready), then a SQLite-backed library if you want browsing/thumbnails.
4. **Native file/media**: route `image-source` / `video` / `audio` file access
   through Tauri dialogs + `fs`.
5. **Decide sharing**: keep a thin web deployment for `/live` URLs, or drop it
   for export-file sharing.
6. *(Optional, later)* native compute for the WebGPU/heavy nodes.

---

## Appendix — subsystem detail

### Engine (`src/engine`, 7.5k lines)

- **Backend: WebGL2** (`gl.ts`, 470 lines). Single persistent context on a hidden
  `HTMLCanvasElement`; RGBA16F/R16F textures with 8-bit fallback. Display via a
  visible 2D canvas `drawImage` blit.
- **WebGPU** (`webgpu/`, compute-only, ~470 WGSL lines across two kernels:
  `integrate.ts` particle sim, `stipple-relax.ts`). Lazy device boot, graceful
  null on unavailable.
- **Evaluation** (`evaluator.ts`, 718 lines): topological sort → per-node
  `compute(ComputeArgs) → NodeOutput`, with stable fingerprint caching, clip
  gates / local-time remaps, keyframe + wired-param overrides, universal mask
  blend.
- **Type system** (`types.ts`, 989 lines): `SocketValue` union (image, mask, uv,
  scalar, vecN, spline, points, audio, force/emitter/collider/particles, sdf,
  position, scalar_field, image_group); `RenderContext` is the sole node contract.
- **SDF compiler** (`sdf-compile.ts`, 1085 lines): SDF/Position AST → single
  cached GLSL fragment shader.
- Web APIs used: `HTMLCanvasElement`, WebGL2, `requestAnimationFrame`,
  `ImageBitmap` (params only), `HTMLVideoElement`/`HTMLAudioElement`/`MediaStream`
  (media nodes), Web Audio (`createMediaStreamSource`, `AnalyserNode`).

### Nodes (`src/nodes`, 30.9k lines, 131 files)

- **source** — 27 nodes / 7.5k: generators (image, video, webcam, perlin,
  voronoi, fracture, text, gradient, shape-cells, scene-time, cursor, audio…).
- **effect** — 74 nodes / 19.7k: filters, transforms, simulations, analyzers
  (bloom, dither, blur, stipple, particle sims, reaction-diffusion, copy-to-points,
  hand/object trackers, bg-remove, ascii, math, color-correction…).
- **sdf** — 28 nodes / 3.2k: primitives, boolean ops, transforms, modifiers,
  rasterize/to-mask/to-spline.
- **output** — 1 node / 0.15k: terminal canvas sink.
- Node contract: `NodeDefinition` with `compute(args)` pure function +
  `RenderContext`. Stateless; per-node state in `ctx.state`. The clean isolation
  is what makes the port easy.
- External libs: `d3-delaunay` (fracture, pure JS), `@mediapipe/tasks-vision`
  (hand/object trackers, lazy-loads `.task` from CDN), Transformers.js (bg-remove,
  ONNX/wasm). No three.js / ffmpeg / heavy math libs inside nodes.

### Lib / backend (`src/lib`, 5.8k lines)

- **Supabase** (`src/lib/supabase`, ~700 lines): Google OAuth, `projects` table
  (graph JSON + thumbnail), `project_ratings`, `user_preferences` (OpenAI/HF
  keys), `profiles`, `image_gen_sessions`; storage buckets for thumbnails and
  generated images. **Cloud-only → rewrite to SQLite + filesystem.**
- **Export** — `export-ffmpeg.ts` (266, ffmpeg.wasm transcode), `export-webcodecs.ts`
  (148, mediabunny/WebCodecs), `export-manifest.ts` (197), `export-packager.ts`
  (206, standalone Vite app from `export-template`). **Portable, minor changes.**
- **AI** — `ai/bg-remove.ts` (305, BRIA RMBG via Transformers.js, IndexedDB
  cache), `openai/image-generate.ts` (208, OpenAI Responses API, BYO key).
  **Portable as-is.**
- **Live viewer** (`lib/live-viewer`, ~825 lines): headless evaluator + canvas
  renderer + control panel for exposed params. Component portable; the cloud
  `/live` routing disappears.

### Next.js coupling (`src/app`, 0.6k lines)

- High coupling: `auth/callback/route.ts` (server OAuth exchange); `/p/[slug]`
  and `/live/[slug]` use `force-dynamic` + server-side `loadPublicProjectBySlug`
  + `generateMetadata`. **Remove / move client-side.**
- Low coupling: root `page.tsx` (client wrapper around `EffectsApp`),
  `globals.css`, `layout.tsx`. No middleware.

### State (`src/state`, 0.3k lines)

- `useHistory()` — undo/redo (max 50, 700ms coalesce window).
- `editor-session.ts` — module-level snapshot surviving React unmount/remount.
- `graph.ts` — `NodeDataPayload` + handle-id helpers.
- **Plain React hooks, fully portable.**
