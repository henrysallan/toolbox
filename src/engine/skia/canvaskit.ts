// CanvasKit (Skia compiled to WASM) — the renderer behind the SkSL Shader
// node (specdocs/101326_skia-target.md). The node previews the SAME SkSL
// that ships to React Native Skia, compiled and run by Skia itself, so
// "renders in toolbox" means "compiles and renders on Skia" rather than
// "a GLSL translation of it renders".
//
// Pinned to the canvaskit-wasm that react-native-skia's web target ships
// (react-native-skia 3.4.0 → canvaskit-wasm 0.41.0) so the SkSL front end
// that accepts or rejects a shader here is the one the RN web build runs.
// Native RN Skia builds Skia from its own milestone (m154 for 3.4.0); the
// compiler rules (ES2 strict) are the same, but the version is not.
//
// Lifecycle mirrors vector-kernel.ts: the engine stays synchronous — a
// compute gates on canvasKit() and kicks ensureCanvasKit(); when the WASM
// lands a `pipeline-bump` re-evaluates and the node's fingerprint (which
// folds in canvasKitReady()) busts its cached transparent frame.
//
// The browser build is loaded as a classic <script> from public/ (copied by
// scripts/copy-canvaskit.mjs) rather than bundled: the emscripten glue has
// node-only `require("fs")` branches that webpack would try to resolve, and
// a script tag works the same in Next, Electron and the headless harnesses.

import type { CanvasKit } from "canvaskit-wasm";

export const CANVASKIT_VERSION = "0.41.0";
export const CANVASKIT_BASE = `/canvaskit/${CANVASKIT_VERSION}/`;

type CanvasKitInitFn = (opts?: {
  locateFile?: (file: string) => string;
  wasmBinary?: ArrayBuffer;
}) => Promise<CanvasKit>;

let kit: CanvasKit | null = null;
let loading: Promise<CanvasKit> | null = null;
let loadError: string | null = null;

export function canvasKit(): CanvasKit | null {
  return kit;
}

export function canvasKitReady(): boolean {
  return kit !== null;
}

// Sticky: a failed fetch is reported on the node rather than retried every
// frame (a missing public/canvaskit would otherwise hammer the server).
export function canvasKitError(): string | null {
  return loadError;
}

export function ensureCanvasKit(): Promise<CanvasKit> {
  if (kit) return Promise.resolve(kit);
  if (loadError) return Promise.reject(new Error(loadError));
  if (!loading) {
    loading = (async () => {
      const init = await resolveInit();
      const k = await init({ locateFile: (f) => CANVASKIT_BASE + f });
      kit = k;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("pipeline-bump"));
      }
      return k;
    })().catch((err: unknown) => {
      loading = null;
      loadError = `CanvasKit failed to load: ${
        err instanceof Error ? err.message : String(err)
      }`;
      throw err;
    });
  }
  return loading;
}

// Node gates and the Electron harnesses initialise CanvasKit themselves
// (from the npm package or injected script text) and hand it over.
export function setCanvasKit(k: CanvasKit): void {
  kit = k;
  loadError = null;
}

async function resolveInit(): Promise<CanvasKitInitFn> {
  const g = globalThis as { CanvasKitInit?: CanvasKitInitFn };
  if (g.CanvasKitInit) return g.CanvasKitInit;
  if (typeof document === "undefined") {
    throw new Error("no document to load canvaskit.js into — call setCanvasKit()");
  }
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${CANVASKIT_BASE}canvaskit.js`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not fetch ${s.src}`));
    document.head.appendChild(s);
  });
  if (!g.CanvasKitInit) throw new Error("canvaskit.js loaded but defined no CanvasKitInit");
  return g.CanvasKitInit;
}
