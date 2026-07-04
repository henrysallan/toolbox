// The Local Font Access API (`window.queryLocalFonts`) isn't in TypeScript's
// DOM lib yet — it's a Chromium-only (desktop) API behind the `local-fonts`
// permission. Declare the slice we use. See src/lib/local-fonts.ts.
//
// Spec: https://developer.mozilla.org/en-US/docs/Web/API/Window/queryLocalFonts

interface FontData {
  /** The font's PostScript name, e.g. "Helvetica-Bold". Unique per face. */
  readonly postscriptName: string;
  /** Full human name, e.g. "Helvetica Bold". */
  readonly fullName: string;
  /** Family name, e.g. "Helvetica" — what canvas2d / CSS resolve by. */
  readonly family: string;
  /** Style/subfamily, e.g. "Bold", "Italic", "Regular". */
  readonly style: string;
  /** Raw font-file bytes (sfnt). May reject for sandboxed/locked fonts. */
  blob(): Promise<Blob>;
}

interface QueryLocalFontsOptions {
  /** Restrict the result to these PostScript names. */
  postscriptNames?: string[];
}

interface Window {
  queryLocalFonts?(options?: QueryLocalFontsOptions): Promise<FontData[]>;
}
