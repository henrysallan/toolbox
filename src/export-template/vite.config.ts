import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

// BUILD_SINGLEFILE=1 enables vite-plugin-singlefile so the resulting
// dist-single/index.html inlines all JS/CSS — Tier A double-click artifact.
const singleFile = process.env.BUILD_SINGLEFILE === "1";

const root = path.resolve(__dirname);
const srcRoot = path.resolve(__dirname, "..");

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), ...(singleFile ? [viteSingleFile()] : [])],
  resolve: {
    alias: {
      "@engine": path.resolve(srcRoot, "engine"),
      "@nodes": path.resolve(srcRoot, "nodes"),
      "@lib": path.resolve(srcRoot, "lib"),
      // The editor's `@/` aliases are reused inside engine/nodes/lib source
      // files. Map the subset we need into the upstream tree, and shim the
      // editor-only paths so the type-only imports in lib/project.ts and
      // friends resolve at typecheck and at bundle time.
      "@/engine": path.resolve(srcRoot, "engine"),
      "@/nodes": path.resolve(srcRoot, "nodes"),
      "@/lib": path.resolve(srcRoot, "lib"),
      // engine/vector-kernel.ts imports the wasm-pack glue from @/wasm.
      // The binary itself is fetched lazily at runtime (kernelReady()
      // gating), so only the JS glue needs to resolve here.
      "@/wasm": path.resolve(srcRoot, "wasm"),
      // The shared param-controls UI (@/lib/param-controls, used by the live
      // viewer) imports this one bundle-safe leaf component from the editor
      // tree. Map it through so the export build resolves it; it pulls in
      // nothing but React + an engine type.
      "@/components/effects/KeyframeDiamond": path.resolve(
        srcRoot,
        "components/effects/KeyframeDiamond"
      ),
      // The React-free half, imported directly by node definitions that
      // broadcast app events (nodes/source/color-literal.ts). Listed
      // separately because alias matching is exact-or-followed-by-slash:
      // the "panel-window" entry below does NOT cover "panel-window-dom".
      "@/components/effects/layout/panel-window-dom": path.resolve(
        srcRoot,
        "components/effects/layout/panel-window-dom"
      ),
      // param-controls also reaches for the panel-window helpers
      // (ownerWindow/ownerDocument for portal targets + hit-testing,
      // usePanelWindow for listener binding). Mapped to the real module
      // rather than shimmed: with no provider above it — which is always
      // the case in an exported app, there are no popout windows —
      // usePanelWindow already returns null, so the behaviour is
      // identical and there's no shim to keep in sync. Costs React only.
      "@/components/effects/layout/panel-window": path.resolve(
        srcRoot,
        "components/effects/layout/panel-window"
      ),
      "@/state/graph-ops": path.resolve(srcRoot, "state/graph-ops"),
      "@/state/graph": path.resolve(root, "src/shims/state-graph.ts"),
      "@xyflow/react": path.resolve(root, "src/shims/xyflow-react.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
  },
});
