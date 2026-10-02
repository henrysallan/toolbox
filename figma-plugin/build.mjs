// Builds the Figma plugin (specdocs/092326_figma-import.md):
//   dist/code.js   the main-thread bundle (the sandbox with the `figma` API)
//   dist/ui.html   the UI iframe — Figma loads it as ONE HTML string, so the
//                  UI bundle is inlined into src/ui.html's placeholder.
//
//   node figma-plugin/build.mjs            one-shot build
//   node figma-plugin/build.mjs --watch    rebuild on save (pair with Figma's
//                                          Plugins → Development → Hot reload)
//
// Uses the repo's own esbuild; paths resolve from this file, so it runs from
// any cwd.

import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const version = JSON.parse(
  await readFile(join(here, "package.json"), "utf8")
).version;

await mkdir(join(here, "dist"), { recursive: true });

const inlineUi = {
  name: "inline-ui",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      // A literal "</script" inside the bundle would end the inline tag early.
      const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
      const html = await readFile(join(here, "src/ui.html"), "utf8");
      await writeFile(
        join(here, "dist/ui.html"),
        html.replace("/*__UI_JS__*/", () => js)
      );
    });
  },
};

const common = {
  bundle: true,
  target: "es2020",
  format: "iife",
  logLevel: "info",
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
};
const main = {
  ...common,
  entryPoints: [join(here, "src/code.ts")],
  outfile: join(here, "dist/code.js"),
};
const ui = {
  ...common,
  entryPoints: [join(here, "src/ui.ts")],
  write: false,
  plugins: [inlineUi],
};

if (watch) {
  await (await esbuild.context(main)).watch();
  await (await esbuild.context(ui)).watch();
} else {
  await esbuild.build(main);
  await esbuild.build(ui);
}
