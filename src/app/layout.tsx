import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Used for /docs body prose. Editor UI keeps its monospace look;
// Inter just lands in the docs layout's reading surface.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Toolbox.Design",
  description: "Node-graph motion design tool",
};

// Editor app — disable system pinch-zoom and double-tap-zoom so the
// canvas / node-editor's own pan/zoom gestures don't fight the
// browser's. Standard for tools-style apps. `viewportFit: "cover"`
// lets us draw under the iPad notch / home indicator if we ever
// want to; `100dvh` already handles the URL-bar bookkeeping on the
// content side.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// Theme, applied BEFORE first paint. A wrong-mode flash is far more jarring
// than the font swap ui-font.ts tolerates, so this can't wait for hydration.
//
// It stays this dumb on purpose: reading `mode` flips the [data-theme]
// attribute that theme-tokens.css keys off, and the brightness trim is
// replayed from a cache that theme.ts writes whenever the trim changes —
// so the OKLCH maths lives in exactly one place (theme/oklch.ts) instead of
// being duplicated into this string. `v` voids the cache when the token
// table moves under a returning user; keep it in step with
// THEME_CSS_VERSION in theme/theme.ts (currently 2).
const THEME_BOOTSTRAP = `
try {
  var s = localStorage.getItem("toolbox:theme");
  var mode = s ? (JSON.parse(s).mode === "light" ? "light" : "dark") : "dark";
  document.documentElement.dataset.theme = mode;
  var c = localStorage.getItem("toolbox:theme-css");
  if (c) {
    var p = JSON.parse(c);
    if (p && p.v === 2 && p.mode === mode && p.css)
      document.documentElement.style.cssText += p.css;
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} h-full antialiased`}
      // The bootstrap script writes data-theme before React hydrates, so the
      // server's markup (no attribute) never matches. Suppressing is correct
      // here rather than a papered-over bug.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
