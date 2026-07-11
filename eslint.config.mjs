import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Built artifacts and vendored bundles — not ours to lint.
    "src/export-template/dist/**",
    "src/export-template/node_modules/**",
    "public/export-template/**",
    "electron/vendor/**",
    "dist-electron/**",
  ]),
  // Electron main-process files are CommonJS by design (they run unbundled
  // in Electron's Node; ESM would need a build step for no benefit).
  {
    files: ["electron/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
