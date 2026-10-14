import type { AssetIR } from "@/engine/skia/scene-ir";

// The fonts a Skia layer can draw text with: files bundled under
// public/fonts (both SIL Open Font License 1.1, stated in each file's name
// table; Geist's license text is public/fonts/Geist-OFL.txt), so the
// editor preview, compare:skia and the exported app all read
// the same bytes (spec §4: system fonts are a parity hazard). A node's
// compute is pure and can't parse a font file it hasn't loaded, so the
// vertical metrics placement needs are tabled here, read from each file's
// head / hhea / OS/2 tables (both set USE_TYPO_METRICS and have hhea ==
// typo metrics, so FreeType, Skia and Chromium all see one ascent/descent).

export interface SkiaFontFace {
  family: string;
  asset: AssetIR;
  unitsPerEm: number;
  // OS/2 sTypoAscender / −sTypoDescender (font units; descender positive).
  ascender: number;
  descender: number;
  // A variable font draws its default instance in Skia.
  variable?: string;
}

export const SKIA_FONTS: Record<string, SkiaFontFace> = {
  Geist: {
    family: "Geist",
    // The OFL text ships beside the font in every exported bundle.
    asset: { id: "geist", kind: "font", mime: "font/ttf", url: "/fonts/Geist-Regular.ttf", license: "/fonts/Geist-OFL.txt" },
    unitsPerEm: 1000,
    ascender: 1005,
    descender: 295,
  },
  Inter: {
    family: "Inter",
    asset: { id: "inter", kind: "font", mime: "font/ttf", url: "/fonts/Inter-VariableFont_opsz,wght.ttf" },
    unitsPerEm: 2048,
    ascender: 1984,
    descender: 494,
    variable: "opsz 14, wght 400 (the file's default instance)",
  },
};

export const SKIA_FONT_FAMILIES = Object.keys(SKIA_FONTS);

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
