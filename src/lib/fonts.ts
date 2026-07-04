import type { FontParamValue } from "@/engine/types";
import { parseVariableAxes } from "./font-parse";

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

// Families the OS already has installed (populated by local-fonts.ts after
// `queryLocalFonts`). These resolve by name via canvas2d/CSS with no network,
// so `ensureFontLoaded` must NOT inject a Google <link> for them (the request
// would 404 and the family is already usable). See specdocs local-fonts notes.
const localFamilies = new Set<string>();

export function registerLocalFamilies(names: Iterable<string>): void {
  for (const n of names) localFamilies.add(n);
}

export function isLocalFamily(family: string): boolean {
  return localFamilies.has(family);
}

// Deduplicate stylesheet injection and font-load promises so repeated calls
// for the same family don't fire new network requests.
const injectedFamilies = new Set<string>();
const loadPromises = new Map<string, Promise<void>>();

function googleFontsHref(family: string): string {
  const slug = family.replace(/ /g, "+");
  // Request the full weight RANGE (`100..900`), not two fixed instances —
  // this delivers the variable font so the Text node's weight axis (and
  // arbitrary in-between weights) actually interpolate. Google clamps the
  // range to whatever the family supports, so static families still
  // resolve to their available weights. `display=swap` shows a fallback
  // immediately rather than hiding text while the file downloads.
  return `https://fonts.googleapis.com/css2?family=${slug}:wght@100..900&display=swap`;
}

// Idempotent: kicks off (or returns an in-flight) promise that resolves when
// `family` is loaded and usable via canvas 2D / CSS. Returns immediately for
// system families and for fonts already registered (e.g. user-uploaded).
export function ensureFontLoaded(family: string): Promise<void> {
  if (!family) return Promise.resolve();
  if (SYSTEM_FONTS.has(family)) return Promise.resolve();
  // Installed locally (queryLocalFonts) — renders by name, no CDN fetch.
  if (localFamilies.has(family)) return Promise.resolve();
  const cached = loadPromises.get(family);
  if (cached) return cached;
  // Not curated and not a known local family, but the browser already has it
  // (e.g. a system font outside SYSTEM_FONTS, or one enumerated in another
  // tab) — treat as ready rather than injecting a doomed Google request.
  try {
    if (typeof document !== "undefined" && document.fonts.check(`16px "${family}"`)) {
      const ready = Promise.resolve();
      loadPromises.set(family, ready);
      return ready;
    }
  } catch {
    // fall through to the Google CDN path
  }

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

// Raw bytes of every custom font registered this session, keyed by the
// synthetic family. Retained so a project save can bundle the font into the
// cloud row / `.toolbox` (project.ts) instead of dropping it. See
// specdocs/062926_assets.md.
const customFontBuffers = new Map<string, ArrayBuffer>();

export function getCustomFontBuffer(family: string): ArrayBuffer | undefined {
  return customFontBuffers.get(family);
}

// Register a custom font from raw bytes. Shared by the upload path
// (registerCustomFont) and the load path (deserializing a bundled font). The
// @font-face family is synthetic (collision-resistant) unless one is supplied
// (load reuses the saved family so the param resolves identically).
export async function registerCustomFontFromBuffer(
  buffer: ArrayBuffer,
  opts?: { family?: string; filename?: string }
): Promise<FontParamValue> {
  const family =
    opts?.family ?? `toolbox-custom-${Math.random().toString(36).slice(2, 10)}`;
  customFontBuffers.set(family, buffer);
  const face = new FontFace(family, buffer);
  try {
    await face.load();
    document.fonts.add(face);
  } catch {
    // Non-fatal — the rasterizer falls back to the next CSS family.
  }
  loadPromises.set(family, Promise.resolve());
  // Best-effort `fvar` parse so the Text node knows which axis sliders to
  // expose. Returns null for non-variable fonts and for formats we don't
  // unpack here (WOFF/WOFF2) — both cases just mean "no axis sliders".
  let axes;
  try {
    axes = parseVariableAxes(buffer) ?? undefined;
  } catch {
    axes = undefined;
  }
  return { family, filename: opts?.filename, axes };
}

// Register a user-uploaded font file. The @font-face family name is synthetic
// (collision-resistant) so uploading two fonts with the same internal name
// doesn't clobber each other.
export async function registerCustomFont(
  file: File
): Promise<FontParamValue> {
  const buffer = await file.arrayBuffer();
  return registerCustomFontFromBuffer(buffer, { filename: file.name });
}

// Synchronous availability check — used by the text node to decide whether
// to rasterize now or schedule a re-evaluation after the async load resolves.
export function isFontReady(family: string): boolean {
  if (!family) return true;
  if (SYSTEM_FONTS.has(family)) return true;
  if (localFamilies.has(family)) return true;
  try {
    return document.fonts.check(`16px "${family}"`);
  } catch {
    return false;
  }
}
