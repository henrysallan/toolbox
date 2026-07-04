// Local (OS-installed) font access, via the Chromium-only Local Font Access
// API (`window.queryLocalFonts`). This is the primary font source for the
// Text node's picker: on desktop (Electron — Chromium) and Chromium web it
// enumerates the user's installed families; everywhere else
// (`localFontsSupported() === false`) the picker degrades to the curated
// baseline + upload.
//
// Two tiers (see specdocs / the devguide "fonts" notes):
//   1. EDITING — reference-by-name. canvas2d already renders any installed
//      family by name, so selecting a local font needs zero loading. We just
//      tell lib/fonts.ts which families are installed so `ensureFontLoaded`
//      skips the (pointless) Google CDN injection for them.
//   2. PORTABILITY — `getLocalFontBytes` reads a face's raw bytes so a save /
//      export can BUNDLE the font (same path as an uploaded custom font), since
//      a referenced-by-name local font won't render on a recipient's machine.
//      Best-effort: commercial / sandboxed fonts (e.g. some Adobe-activated
//      faces) reject `.blob()` — callers fall back to name-reference.

import { registerLocalFamilies } from "./fonts";

export interface LocalFontFace {
  postscriptName: string;
  fullName: string;
  style: string;
}

export interface LocalFontFamily {
  family: string;
  faces: LocalFontFace[];
}

export function localFontsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.queryLocalFonts === "function";
}

// Cache the enumeration (and the raw FontData objects, keyed by postscript
// name, for later byte retrieval). queryLocalFonts re-prompts only the first
// time per origin; subsequent calls resolve silently — but we cache anyway so
// the picker doesn't re-query on every open.
let familyCache: LocalFontFamily[] | null = null;
let enumInflight: Promise<LocalFontFamily[]> | null = null;
const faceByPostscript = new Map<string, FontData>();

// Enumerate installed families, grouped and sorted. Returns [] when the API
// is unavailable or the user denies permission. MUST be reachable from a user
// gesture the first time (the permission prompt requires it) — the picker
// calls this on open (a click), which satisfies that.
export async function enumerateLocalFonts(): Promise<LocalFontFamily[]> {
  if (!localFontsSupported()) return [];
  if (familyCache) return familyCache;
  if (enumInflight) return enumInflight;

  enumInflight = (async () => {
    try {
      const data = await window.queryLocalFonts!();
      const byFamily = new Map<string, LocalFontFamily>();
      for (const f of data) {
        faceByPostscript.set(f.postscriptName, f);
        let entry = byFamily.get(f.family);
        if (!entry) {
          entry = { family: f.family, faces: [] };
          byFamily.set(f.family, entry);
        }
        entry.faces.push({
          postscriptName: f.postscriptName,
          fullName: f.fullName,
          style: f.style,
        });
      }
      const families = [...byFamily.values()].sort((a, b) =>
        a.family.localeCompare(b.family)
      );
      // Tell the loader these resolve by name (no Google injection needed).
      registerLocalFamilies(families.map((fam) => fam.family));
      familyCache = families;
      return families;
    } catch {
      // Permission denied, or the API threw — degrade to "no local fonts".
      return [];
    } finally {
      enumInflight = null;
    }
  })();
  return enumInflight;
}

// Synchronous view of the already-enumerated families (null if not yet
// enumerated). Lets the picker render instantly on re-open.
export function cachedLocalFonts(): LocalFontFamily[] | null {
  return familyCache;
}

// Pick the representative face to bundle for a family: prefer a variable /
// "Regular" upright face so the bundled file covers the common case (and, for
// variable fonts, the whole axis range). Falls back to the first face.
function representativeFace(fam: LocalFontFamily): LocalFontFace | undefined {
  const norm = (s: string) => s.toLowerCase();
  return (
    fam.faces.find((f) => norm(f.style) === "regular") ??
    fam.faces.find(
      (f) => !/italic|oblique|bold|light|thin|black|condensed/.test(norm(f.style))
    ) ??
    fam.faces[0]
  );
}

// Read raw bytes for a family's representative face, for save/export
// bundling. Returns null when the family isn't a known local font, when its
// bytes are unreadable (sandboxed/commercial fonts reject `.blob()`), or when
// enumeration hasn't run. Best-effort by contract — callers fall back to
// name-reference.
export async function getLocalFontBytes(
  family: string
): Promise<ArrayBuffer | null> {
  const families = familyCache ?? (await enumerateLocalFonts());
  const fam = families.find((f) => f.family === family);
  if (!fam) return null;
  const face = representativeFace(fam);
  if (!face) return null;
  const fontData = faceByPostscript.get(face.postscriptName);
  if (!fontData) return null;
  try {
    const blob = await fontData.blob();
    return await blob.arrayBuffer();
  } catch {
    return null;
  }
}
