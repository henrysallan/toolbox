import type { NextConfig } from "next";

// DESKTOP_BUILD=1 produces a self-contained standalone server (.next/standalone)
// that the Electron desktop app runs locally — full route + auth parity, works
// offline. The web/Vercel build (no env var) is unchanged.
const desktop = !!process.env.DESKTOP_BUILD;

// @huggingface/transformers is a large, browser-only ML library — dynamically
// imported in the renderer (src/lib/ai/*), never used by the Next server. Next's
// output tracing otherwise copies it into the standalone server bundle, where on
// Windows its deep node_modules paths break electron-builder's packaging (7-Zip
// "cannot find the path specified" on a partial trace-copy). Exclude it from the
// desktop trace: the renderer loads it from the compiled client chunks, so the
// server copy is dead weight. Gated on DESKTOP_BUILD so the web build is untouched.
const nextConfig: NextConfig = {
  output: desktop ? "standalone" : undefined,
  ...(desktop
    ? { outputFileTracingExcludes: { "**": ["node_modules/@huggingface/**"] } }
    : {}),
};

export default nextConfig;
