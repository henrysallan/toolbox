import type { FontParamValue } from "@/engine/types";

// Curated set of Google Fonts plus a handful of system families. System
// families resolve instantly; Google families load on first use via an
// injected <link>.
export const CURATED_FONTS: string[] = [
  // Google — sans
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Work Sans",
  "DM Sans",
  "Nunito",
  "Raleway",
  // Google — display
  "Oswald",
  "Bebas Neue",
  // Google — serif
  "Playfair Display",
  "Merriweather",
  "Crimson Text",
  "Cormorant Garamond",
  // Google — mono
  "Space Mono",
  "JetBrains Mono",
  // System — always available, no network
  "Helvetica",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
];

const SYSTEM_FONTS = new Set([
  "Helvetica",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
]);

// Deduplicate stylesheet injection and font-load promises so repeated calls
// for the same family don't fire new network requests.
const injectedFamilies = new Set<string>();
const loadPromises = new Map<string, Promise<void>>();

function googleFontsHref(family: string): string {
  const slug = family.replace(/ /g, "+");
  // Pull regular + bold so the rasterizer can switch weights later without
  // re-injecting the stylesheet. `display=block` avoids the fallback-first
  // flash while loading.
  return `https://fonts.googleapis.com/css2?family=${slug}:wght@400;700&display=block`;
}

// Idempotent: kicks off (or returns an in-flight) promise that resolves when
// `family` is loaded and usable via canvas 2D / CSS. Returns immediately for
// system families and for fonts already registered (e.g. user-uploaded).
export function ensureFontLoaded(family: string): Promise<void> {
  if (!family) return Promise.resolve();
  if (SYSTEM_FONTS.has(family)) return Promise.resolve();
  const cached = loadPromises.get(family);
  if (cached) return cached;

  const promise = (async () => {
    if (!injectedFamilies.has(family)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = googleFontsHref(family);
      document.head.appendChild(link);
      injectedFamilies.add(family);
    }
    try {
      // `load` triggers the actual file download and resolves once the font
      // is usable. The size is arbitrary but required by the CSS font shorthand.
      await document.fonts.load(`16px "${family}"`);
    } catch {
      // Non-fatal — the rasterizer will fall back to the next CSS family.
    }
  })();
  // Notify any text nodes currently rendering placeholders that they should
  // re-evaluate now that the font is live. Fires exactly once per family
  // because this code only runs when we first create the promise.
  promise.finally(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("pipeline-bump"));
    }
  });
  loadPromises.set(family, promise);
  return promise;
}

// Register a user-uploaded font file. The @font-face family name is synthetic
// (collision-resistant) so uploading two fonts with the same internal name
// doesn't clobber each other.
export async function registerCustomFont(
  file: File
): Promise<FontParamValue> {
  const buffer = await file.arrayBuffer();
  const family = `toolbox-custom-${Math.random().toString(36).slice(2, 10)}`;
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
  // Pre-warm the loadPromises cache so callers asking `ensureFontLoaded`
  // with the synthetic family skip the network path.
  loadPromises.set(family, Promise.resolve());
  return { family, filename: file.name };
}

// Synchronous availability check — used by the text node to decide whether
// to rasterize now or schedule a re-evaluation after the async load resolves.
export function isFontReady(family: string): boolean {
  if (!family) return true;
  if (SYSTEM_FONTS.has(family)) return true;
  try {
    return document.fonts.check(`16px "${family}"`);
  } catch {
    return false;
  }
}
