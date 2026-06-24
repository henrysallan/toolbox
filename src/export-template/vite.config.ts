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
      // The shared param-controls UI (@/lib/param-controls, used by the live
      // viewer) imports this one bundle-safe leaf component from the editor
      // tree. Map it through so the export build resolves it; it pulls in
      // nothing but React + an engine type.
      "@/components/effects/KeyframeDiamond": path.resolve(
        srcRoot,
        "components/effects/KeyframeDiamond"
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
