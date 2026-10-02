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

// The weights Google serves for each curated family, in the CSS2 API's
// `wght@` syntax: a variable family's axis span ("400..900") or a static
// family's instances ("400;700"). Google answers HTTP 400 — no stylesheet at
// all — for a range wider than the family's axis and for any range on a
// static family, so these must match its catalog
// (fonts.google.com/metadata/fonts, checked 2026-09-23). A curated family
// missing here, or one Google later rejects, falls back to a plain request,
// which serves the regular weight.
export const GOOGLE_FONT_WEIGHTS: Readonly<Record<string, string>> = {
  Inter: "100..900",
  Roboto: "100..900",
  "Open Sans": "300..800",
  Lato: "100;300;400;700;900",
  Montserrat: "100..900",
  Poppins: "100;200;300;400;500;600;700;800;900",
  "Work Sans": "100..900",
  "DM Sans": "100..1000",
  Nunito: "200..1000",
  Raleway: "100..900",
  Oswald: "200..700",
  "Bebas Neue": "400",
  "Playfair Display": "400..900",
  Merriweather: "300..900",
  "Crimson Text": "400;600;700",
  "Cormorant Garamond": "300..700",
  "Space Mono": "400;700",
  "JetBrains Mono": "100..800",
};

const SYSTEM_FONTS = new Set([
  "Helvetica",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
]);

// Curated families fetched from the Google CDN (everything but the system set).
const GOOGLE_FAMILIES = new Set(CURATED_FONTS.filter((f) => !SYSTEM_FONTS.has(f)));

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

// `display=swap` shows a fallback immediately rather than hiding DOM text
// while the file downloads (the canvas rasterizers gate on isFontReady).
export function googleFontsHref(family: string, weights?: string): string {
  const slug = family.replace(/ /g, "+");
  const axis = weights ? `:wght@${weights}` : "";
  return `https://fonts.googleapis.com/css2?family=${slug}${axis}&display=swap`;
}

// What a raster is about to draw. Google splits a family into one file per
// weight (static families) and per unicode-range subset (latin, latin-ext,
// cyrillic, …), each fetched on demand, so readiness depends on the weight,
// style and characters — not just the family. A TextStyle fits this shape.
export interface FontQuery {
  weight?: number;
  italic?: boolean;
  text?: string;
}

// ---- Load state -------------------------------------------------------------
//
// `document.fonts.check()` alone can't say whether a family is ready: per the
// CSS Font Loading spec it returns true when NO registered FontFace matches,
// so a Google family nothing has fetched yet reads as loaded and canvas2d
// draws the generic fallback. It only means something once the family's faces
// are registered — so a Google family's stylesheet is tracked here, and
// check() is consulted only after it has landed.

type SheetState = "idle" | "loading" | "loaded" | "failed";

interface FamilyState {
  // Google stylesheet phase, or null when the family isn't fetched from
  // Google: something registered its faces first (globals.css's Inter, an
  // uploaded or bundled font), or the OS resolves it by name.
  sheet: SheetState | null;
  sheetLoad: Promise<void> | null;
  // See fontVersion.
  version: number;
}

const families = new Map<string, FamilyState>();
// In-flight loads keyed by query, so repeated calls join one.
const pendingLoads = new Map<string, Promise<void>>();
// Queries whose load settled (or timed out) with check() still false — a face
// that errored, or one still downloading. Stop gating on them: the raster
// draws the fallback instead of staying blank, and a late arrival bumps again.
const gaveUp = new Set<string>();
const GAVE_UP_CAP = 256;

// How long a stylesheet or face load may take before the rasterizers stop
// waiting and draw the fallback. Also bounds an export frame held on a load.
const FONT_LOAD_TIMEOUT_MS = 10_000;

// Decided once, on first use: installed fonts and families whose faces are
// already registered render as they are; only a curated Google family with
// nothing behind its name is fetched.
function familyState(family: string): FamilyState {
  let fam = families.get(family);
  if (!fam) {
    const google =
      GOOGLE_FAMILIES.has(family) &&
      !localFamilies.has(family) &&
      !hasRegisteredFaces(family);
    fam = { sheet: google ? "idle" : null, sheetLoad: null, version: 0 };
    families.set(family, fam);
  }
  return fam;
}

function hasRegisteredFaces(family: string): boolean {
  const want = family.toLowerCase();
  let found = false;
  try {
    document.fonts.forEach((face) => {
      if (face.family.replace(/^["']|["']$/g, "").toLowerCase() === want) {
        found = true;
      }
    });
  } catch {
    // No FontFaceSet (non-DOM caller) — nothing is registered.
  }
  return found;
}

// The shorthand check() / load() match against: the weight and style
// text-raster puts in `c2d.font`, at a nominal size.
function fontShorthand(family: string, query?: FontQuery): string {
  const w = query?.weight;
  const weight =
    typeof w === "number" && Number.isFinite(w)
      ? Math.min(1000, Math.max(1, Math.round(w)))
      : 400;
  return `${query?.italic ? "italic " : ""}${weight} 16px "${family}"`;
}

// Only the character SET matters to check() / load() (it picks the subsets),
// so the sample is the sorted distinct characters: load keys stay put while
// text grows within a set — per-frame label strings included. Memoized on
// the last input, since a gate and its load ask about the same text.
let lastText = "";
let lastSample = " ";
function queryText(query?: FontQuery): string {
  const text = query?.text;
  if (!text) return " ";
  if (text !== lastText) {
    lastText = text;
    lastSample = Array.from(new Set(text)).sort().join("");
  }
  return lastSample;
}

function loadKey(font: string, text: string): string {
  return `${font}|${text}`;
}

function facesReady(family: string, query?: FontQuery): boolean {
  const font = fontShorthand(family, query);
  const text = queryText(query);
  try {
    if (document.fonts.check(font, text)) return true;
  } catch {
    return true; // no FontFaceSet, or a family name the parser rejects
  }
  return gaveUp.has(loadKey(font, text));
}

// Record that `fam` may render differently now, and re-drive evaluation so a
// paused editor picks it up.
function touch(fam: FamilyState): void {
  fam.version++;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

// Resolve once `p` settles or `ms` pass, whichever is first; `onLate` runs if
// `p` settles after the deadline.
function within(p: Promise<unknown>, ms: number, onLate: () => void): Promise<void> {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, ms);
    const settle = () => {
      if (timedOut) {
        onLate();
      } else {
        clearTimeout(timer);
        resolve();
      }
    };
    p.then(settle, settle);
  });
}

type SheetOutcome = "load" | "error" | "timeout";

// Resolves on the <link>'s load / error event, or after the timeout;
// `onLateLoad` runs if the sheet lands after that.
function appendStylesheet(href: string, onLateLoad: () => void): Promise<SheetOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SheetOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), FONT_LOAD_TIMEOUT_MS);
    try {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.addEventListener("load", () => (settled ? onLateLoad() : finish("load")), {
        once: true,
      });
      link.addEventListener("error", () => finish("error"), { once: true });
      document.head.appendChild(link);
    } catch {
      finish("error");
    }
  });
}

function ensureSheet(family: string, fam: FamilyState): Promise<void> {
  if (!fam.sheetLoad) {
    fam.sheet = "loading";
    fam.sheetLoad = (async () => {
      const weights = GOOGLE_FONT_WEIGHTS[family];
      // Landed after the timeout: the faces are registered after all, so
      // re-open the gate and let the next eval load them.
      const late = () => {
        fam.sheet = "loaded";
        touch(fam);
      };
      let outcome = await appendStylesheet(googleFontsHref(family, weights), late);
      // Google rejected the weights (its catalog moved since the table above
      // was written) — the plain request still serves the regular weight.
      if (outcome === "error" && weights) {
        outcome = await appendStylesheet(googleFontsHref(family), late);
      }
      fam.sheet = outcome === "load" ? "loaded" : "failed";
      // Failing flips readiness to true (draw the fallback), so re-render. A
      // loaded sheet needs no bump yet: the face load that follows fires one.
      if (fam.sheet === "failed") touch(fam);
    })();
  }
  return fam.sheetLoad;
}

// The shorthands to load for a query. A static Google family ships one file
// per weight: load them all, so a weight drag or keyframe never lands on a
// face that isn't there yet. A variable family's one face spans its axis.
function faceFonts(family: string, fam: FamilyState, query?: FontQuery): string[] {
  const fonts = [fontShorthand(family, query)];
  const weights = fam.sheet !== null ? GOOGLE_FONT_WEIGHTS[family] : undefined;
  if (weights && !weights.includes("..")) {
    for (const w of weights.split(";")) {
      fonts.push(fontShorthand(family, { ...query, weight: Number(w) }));
    }
  }
  return fonts;
}

async function loadFaces(
  family: string,
  fam: FamilyState,
  query: FontQuery | undefined,
  key: string
): Promise<void> {
  const text = queryText(query);
  const loads = faceFonts(family, fam, query).map((font) => {
    try {
      return document.fonts.load(font, text);
    } catch {
      return Promise.resolve([]);
    }
  });
  await within(Promise.all(loads), FONT_LOAD_TIMEOUT_MS, () => touch(fam));
  if (!facesReady(family, query)) {
    gaveUp.add(key);
    if (gaveUp.size > GAVE_UP_CAP) {
      gaveUp.delete(gaveUp.values().next().value as string);
    }
  }
  touch(fam);
}

// Changes whenever a load for `family` settles — lands, fails, times out, or
// arrives late. Anything caching pixels drawn in the family (Text's raster
// signature, a node's fingerprintExtras) folds it in, so a placeholder or
// fallback raster never outlives the real font, in the node or downstream.
export function fontVersion(family: string): number {
  return families.get(family)?.version ?? 0;
}

// Idempotent: starts (or joins) the load that makes `query` drawable in
// `family`, resolving once it settles — loaded, failed or timed out; never
// rejects. Each settle bumps fontVersion and fires `pipeline-bump`.
export function ensureFontLoaded(family: string, query?: FontQuery): Promise<void> {
  if (isFontReady(family, query)) return Promise.resolve();
  const fam = familyState(family);
  const key = loadKey(fontShorthand(family, query), queryText(query));
  let load = pendingLoads.get(key);
  if (!load) {
    load = (async () => {
      try {
        if (fam.sheet !== null) {
          await ensureSheet(family, fam);
          if (fam.sheet === "failed") return;
        }
        await loadFaces(family, fam, query, key);
      } catch {
        // Non-fatal — the rasterizer falls back to the next CSS family.
      }
    })();
    pendingLoads.set(key, load);
    void load.then(() => pendingLoads.delete(key));
  }
  return load;
}

// Raw bytes of every custom font registered this session, keyed by the
// synthetic family. Retained so a project save can bundle the font into the
// cloud row / `.toolbox` (project.ts) instead of dropping it. See
// specdocs/archive/062926_assets.md.
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
    // A family already decided or drawn before this face existed (a bundle
    // restored under a curated name) re-resolves against it.
    const fam = families.get(family);
    if (fam) {
      if (fam.sheet === "idle") fam.sheet = null;
      touch(fam);
    }
  } catch {
    // Non-fatal — the rasterizer falls back to the next CSS family.
  }
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

// Synchronous — the rasterizers decide per eval whether to draw now or paint
// a placeholder and call ensureFontLoaded (which bumps when it settles). A
// load that failed counts as ready: the fallback face is all there is, and
// blank text would be worse.
export function isFontReady(family: string, query?: FontQuery): boolean {
  if (!family || SYSTEM_FONTS.has(family)) return true;
  const fam = familyState(family);
  if (fam.sheet === "idle" || fam.sheet === "loading") return false;
  if (fam.sheet === "failed") return true;
  if (fam.sheet === null && localFamilies.has(family)) return true;
  return facesReady(family, query);
}
