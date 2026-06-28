import type { NextConfig } from "next";

// DESKTOP_BUILD=1 produces a self-contained standalone server (.next/standalone)
// that the Electron desktop app runs locally — full route + auth parity, works
// offline. The web/Vercel build (no env var) is unchanged.
const nextConfig: NextConfig = {
  output: process.env.DESKTOP_BUILD ? "standalone" : undefined,
};

export default nextConfig;
