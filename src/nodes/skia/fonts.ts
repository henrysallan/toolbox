import type { AssetIR } from "@/engine/skia/scene-ir";
import type { FontParamValue } from "@/engine/types";
import { CURATED_FONTS, GOOGLE_FONT_WEIGHTS, getCustomFontBuffer } from "@/lib/fonts";
import { parseVariableAxes, type FontAxis } from "@/lib/font-parse";

// The fonts a Skia layer can draw text with — and why every other family
// can't (specdocs/101326_skia-target.md §3.4b). A Skia layer ships its fonts
// inside the export (spec §4: system fonts are a parity hazard), so a face
// is drawable only when toolbox has its FILE and may redistribute it:
//
//   bundled   public/fonts — Geist Regular and Inter (variable), both SIL
//             Open Font License 1.1, the licence text beside each file.
//             Inter is also what the editor's Text node draws for "Inter"
//             (globals.css registers this very file under that name).
//   custom    a font the user uploaded as the Text node's Custom font: its
//             bytes are in this session (lib/fonts.ts), and they ship as a
//             data: asset. Its licence is the uploader's responsibility.
//
// Everything else the Text node offers — the curated Google families
// (open licences, but toolbox doesn't bundle their files), the system
// families (licensed with the OS), installed local fonts — refuses with
// its reason, and the preview draws Inter meanwhile.
//
// A node's compute is pure and can't parse a bundled file it hasn't loaded,
// so the bundled faces' metrics are tabled here, read from each file's
// head / hhea / OS/2 / fvar tables (check-skia-text holds them to the
// files). Uploaded fonts are parsed from their bytes (readSfntMetrics).
//
// Variable faces draw their DEFAULT instance in Skia layers, everywhere:
// React Native Skia 3.4's native text ignores font variations
// (cpp/api/JsiSkTextStyle.h never reads `fontVariations`; only the web
// build passes them to CanvasKit), so an axis value the preview applied
// would not reach a phone. The Text node draws the default optical size
// too: Chromium would apply `opsz` automatically (= the font size in px,
// clamped to the axis; Inter 8.2 % narrower at ≥ 32 px), so the engine's
// text rasterizer turns that off (text-raster.ts applyAxisStyling,
// font-optical-sizing: none).

export interface SkiaFontFace {
  family: string;
  asset: AssetIR;
  unitsPerEm: number;
  // OS/2 sTypoAscender / −sTypoDescender (font units; descender positive):
  // the em box Chromium's textBaseline "middle" splits (hhea when a font
  // has no OS/2 table).
  ascender: number;
  descender: number;
  // A variable font draws its default instance in Skia.
  variable?: string;
  // fvar axes (variable faces only).
  axes?: FontAxis[];
  // OS/2 usWeightClass — the weight a static face draws.
  weight: number;
  // Where it comes from (bundled file + licence, or an upload).
  source: "bundled" | "custom";
}

export const SKIA_FONTS: Record<string, SkiaFontFace> = {
  Geist: {
    family: "Geist",
    // The OFL text ships beside the font in every exported bundle.
    asset: { id: "geist", kind: "font", mime: "font/ttf", url: "/fonts/Geist-Regular.ttf", license: "/fonts/Geist-OFL.txt" },
    unitsPerEm: 1000,
    ascender: 1005,
    descender: 295,
    weight: 400,
    source: "bundled",
  },
  Inter: {
    family: "Inter",
    asset: {
      id: "inter",
      kind: "font",
      mime: "font/ttf",
      url: "/fonts/Inter-VariableFont_opsz,wght.ttf",
      license: "/fonts/Inter-OFL.txt",
    },
    unitsPerEm: 2048,
    ascender: 1984,
    descender: 494,
    variable: "opsz 14, wght 400 (the file's default instance)",
    axes: [
      { tag: "opsz", name: "Optical size", min: 14, default: 14, max: 32 },
      { tag: "wght", name: "Weight", min: 100, default: 400, max: 900 },
    ],
    weight: 400,
    source: "bundled",
  },
};

export const SKIA_FONT_FAMILIES = Object.keys(SKIA_FONTS);

// The Text node's system families: licensed with the operating system.
const SYSTEM_FAMILIES = new Set(["Helvetica", "Arial", "Georgia", "Times New Roman", "Courier New"]);

// Why a Text node font family can't draw in a Skia layer (null: it can —
// it is one of SKIA_FONTS). Every curated family has an answer
// (check-skia-text walks CURATED_FONTS).
export function skiaFamilyRefusal(family: string): string | null {
  if (SKIA_FONTS[family]) return null;
  if (family in GOOGLE_FONT_WEIGHTS) {
    return `"${family}" is a Google Fonts family toolbox doesn't bundle — a Skia layer draws only fonts that ship inside the export: Inter, Geist, or a font uploaded as Custom font (when its licence allows redistribution).`;
  }
  if (SYSTEM_FAMILIES.has(family)) {
    return `"${family}" is a system font licensed with the operating system — it can't ship inside an app. Use Inter or Geist, or upload a font you may redistribute as Custom font.`;
  }
  return `"${family}" isn't a font a Skia layer can ship (an installed font?) — upload its file as Custom font if its licence allows redistribution, or use Inter or Geist.`;
}

// Families of the Text node's curated list (lib/fonts.ts), for the gate.
export const TEXT_NODE_FAMILIES: readonly string[] = CURATED_FONTS;

// ---- sfnt tables ----------------------------------------------------------------

export interface SfntMetrics {
  flavor: "ttf" | "otf";
  unitsPerEm: number;
  hheaAscender: number;
  hheaDescender: number; // positive
  typoAscender: number | null;
  typoDescender: number | null; // positive
  useTypoMetrics: boolean;
  weightClass: number;
}

// head / hhea / OS/2 of a TrueType or CFF OpenType file; null for anything
// else (WOFF, WOFF2, collections, a truncated file).
export function readSfntMetrics(bytes: ArrayBuffer | Uint8Array): SfntMetrics | null {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 12) return null;
  const tag = v.getUint32(0);
  const flavor = tag === 0x00010000 || tag === 0x74727565 ? "ttf" : tag === 0x4f54544f ? "otf" : null;
  if (!flavor) return null;
  const n = v.getUint16(4);
  if (12 + n * 16 > u8.byteLength) return null;
  const tables: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const name = String.fromCharCode(u8[r], u8[r + 1], u8[r + 2], u8[r + 3]);
    tables[name] = v.getUint32(r + 8);
  }
  const head = tables.head;
  const hhea = tables.hhea;
  if (head === undefined || hhea === undefined || head + 20 > u8.byteLength || hhea + 8 > u8.byteLength) return null;
  const os2 = tables["OS/2"];
  const hasOs2 = os2 !== undefined && os2 + 72 <= u8.byteLength;
  return {
    flavor,
    unitsPerEm: v.getUint16(head + 18),
    hheaAscender: v.getInt16(hhea + 4),
    hheaDescender: -v.getInt16(hhea + 6),
    typoAscender: hasOs2 ? v.getInt16(os2 + 68) : null,
    typoDescender: hasOs2 ? -v.getInt16(os2 + 70) : null,
    useTypoMetrics: hasOs2 ? (v.getUint16(os2 + 62) & 0x80) !== 0 : false,
    weightClass: hasOs2 && os2 + 6 <= u8.byteLength ? v.getUint16(os2 + 4) : 400,
  };
}

function base64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return btoa(s);
}

// ---- uploaded fonts ---------------------------------------------------------------

// One face per uploaded buffer (the data: URL is built once and the same
// asset object is handed out every frame).
const customFaces = new WeakMap<ArrayBuffer, SkiaFontFace | string>();

// The face for a Text node Custom font, or why it can't draw.
export function customSkiaFace(font: FontParamValue): SkiaFontFace | string {
  const bytes = getCustomFontBuffer(font.family);
  const label = font.filename ? `"${font.filename}"` : "The uploaded font";
  if (!bytes) return `${label} has no bytes in this session (fonts uploaded before a reload must be uploaded again).`;
  const hit = customFaces.get(bytes);
  if (hit) return hit;
  const m = readSfntMetrics(bytes);
  let out: SkiaFontFace | string;
  if (!m) {
    out = `${label} isn't a TrueType / OpenType file (.ttf / .otf) — WOFF, WOFF2 and collections don't export; upload the .ttf or .otf.`;
  } else {
    const typo = m.typoAscender !== null && m.typoDescender !== null && m.typoAscender + m.typoDescender > 0;
    const mime = m.flavor === "otf" ? "font/otf" : "font/ttf";
    const axes = parseVariableAxes(bytes) ?? undefined;
    out = {
      family: font.family,
      asset: {
        id: `font-${font.family.replace(/[^A-Za-z0-9_-]/g, "_")}`,
        kind: "font",
        mime,
        url: `data:${mime};base64,${base64(new Uint8Array(bytes))}`,
      },
      unitsPerEm: m.unitsPerEm,
      ascender: typo ? m.typoAscender! : m.hheaAscender,
      descender: typo ? m.typoDescender! : m.hheaDescender,
      ...(axes ? { axes, variable: axes.map((a) => `${a.tag} ${a.default}`).join(", ") + " (the file's default instance)" } : {}),
      weight: m.weightClass,
      source: "custom",
    };
  }
  customFaces.set(bytes, out);
  return out;
}

// ---- the Text node's font params → a face ---------------------------------------

export interface SkiaTextFace {
  face: SkiaFontFace;
  // Why the drawing isn't the face / style the params ask for (the export
  // refuses; the preview draws `face`).
  problems: string[];
}

const axisDefault = (face: SkiaFontFace, tag: string) => face.axes?.find((a) => a.tag === tag)?.default;

// A constant font_variations entry (the Text node's AxisInput), else null.
function constantAxis(v: unknown): number | null | "modulated" {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && (v as { mode?: unknown }).mode === "constant") {
    const x = (v as { value?: unknown }).value;
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  }
  return "modulated";
}

// Resolve the Text node's font params (custom_font, font_family,
// font_weight, italic, font_variations) to what a Skia layer draws.
export function resolveSkiaTextFace(params: Record<string, unknown>): SkiaTextFace {
  const problems: string[] = [];
  let face = SKIA_FONTS.Inter;
  const custom = params.custom_font as FontParamValue | null | undefined;
  if (custom && typeof custom === "object" && typeof custom.family === "string" && custom.family) {
    const c = customSkiaFace(custom);
    if (typeof c === "string") problems.push(c);
    else face = c;
  } else {
    const family = typeof params.font_family === "string" ? params.font_family : "Inter";
    const why = skiaFamilyRefusal(family);
    if (why) problems.push(why);
    else face = SKIA_FONTS[family];
  }
  const weight = typeof params.font_weight === "number" && Number.isFinite(params.font_weight) ? params.font_weight : 400;
  const wghtDefault = axisDefault(face, "wght");
  if (wghtDefault !== undefined) {
    if (Math.round(weight) !== wghtDefault) {
      problems.push(
        `${face.family} draws its default instance (wght ${wghtDefault}) in a Skia layer — React Native Skia's native text ignores variable-font axes, so weight ${Math.round(weight)} can't ship.`
      );
    }
  } else if (weight >= 600 && face.weight < 600) {
    problems.push(`${face.family} ships only its ${face.weight} weight — the Text node synthesizes bold at weight ${Math.round(weight)}, a Skia layer can't.`);
  }
  if (params.italic === true) {
    problems.push(`${face.family} has no italic face to ship — the Text node slants it synthetically, a Skia layer can't.`);
  }
  const vars = params.font_variations;
  if (vars && typeof vars === "object") {
    for (const [tag, v] of Object.entries(vars as Record<string, unknown>)) {
      const c = constantAxis(v);
      if (c === null) continue;
      const def = axisDefault(face, tag);
      if (c === "modulated") problems.push(`Per-character "${tag}" modulation doesn't export — a Skia layer draws ${face.family}'s default instance.`);
      else if (def !== undefined && c !== def) {
        problems.push(`${face.family}'s "${tag}" axis at ${c} can't ship — React Native Skia's native text ignores variable-font axes (default instance: ${def}).`);
      }
    }
  }
  return { face, problems };
}

// ---- layout constants -------------------------------------------------------------

// Where Chromium's Canvas2D puts the ALPHABETIC baseline below a `middle`
// baseline (textBaseline = "middle", what the Text node draws with): half
// of ascent − descent of the em box, the em box being the typo ascent /
// descent normalized to sum to the font size and snapped to 1/64 px
// (Blink's TextMetrics::GetFontBaseline + NormalizedTypoAscentAndDescent,
// LayoutUnit). Measured equal to TextMetrics.alphabeticBaseline in
// Electron for both fonts at 37 / 64 / 96 px.
export function canvasMiddleToAlphabetic(face: SkiaFontFace, size: number): number {
  const lu = (v: number) => Math.round(v * 64) / 64;
  const a = lu((size * face.ascender) / (face.ascender + face.descender));
  const d = lu(size) - a;
  return (a - d) / 2;
}

// SkParagraph's line box for one run of this face at `size` (no strut, no
// height override): ascent / descent from the font, the line height rounded
// to whole pixels (ParagraphStyle's rounding hack, on in CanvasKit and in
// React Native Skia), the rounding taken up above the baseline — so the
// first baseline sits `baseline` below the paragraph's top and lines are
// `height` apart.
export function paragraphLineBox(face: SkiaFontFace, size: number): { baseline: number; height: number } {
  const asc = (size * face.ascender) / face.unitsPerEm;
  const desc = (size * face.descender) / face.unitsPerEm;
  const height = Math.round(asc + desc);
  return { baseline: asc + (height - (asc + desc)), height };
}
