// Minimal OpenType fvar-table parser. Reads the variation axes a
// font declares so we can expose a slider per axis. No dependency
// on opentype.js / fonkit / etc. — fvar is small and fixed-format,
// and we only need axis tag / name / min / default / max.
//
// Supports raw .ttf / .otf (sfnt) bytes. WOFF / WOFF2 are wrapped
// formats; they need separate decompression paths and are rare in
// practice for direct uploads — return null silently so the caller
// just treats the font as non-variable. Foundries that ship
// variable fonts almost always provide a .ttf/.otf alongside.
//
// Ref: https://learn.microsoft.com/en-us/typography/opentype/spec/fvar

export interface FontAxis {
  tag: string; // 4-char OpenType tag, e.g. "wght"
  name: string; // Human label resolved from the font's name table
  min: number;
  max: number;
  default: number;
}

const BUILTIN_AXIS_LABELS: Record<string, string> = {
  wght: "Weight",
  wdth: "Width",
  slnt: "Slant",
  ital: "Italic",
  opsz: "Optical Size",
  GRAD: "Grade",
  XHGT: "X-Height",
  XOPQ: "X Opaque",
  XTRA: "X Transparent",
  YOPQ: "Y Opaque",
  YTAS: "Ascender",
  YTDE: "Descender",
  YTFI: "Figure Height",
  YTLC: "Lowercase",
  YTUC: "Uppercase",
};

export function parseVariableAxes(buffer: ArrayBuffer): FontAxis[] | null {
  if (buffer.byteLength < 12) return null;
  const v = new DataView(buffer);
  const sfntVersion = v.getUint32(0);
  // Accept TrueType (0x00010000) and PostScript-flavoured OpenType
  // ("OTTO" → 0x4F54544F). Skip TrueType collections + WOFF
  // wrappers; those need separate handlers we're not adding for v1.
  const isSfnt =
    sfntVersion === 0x00010000 || sfntVersion === 0x4f54544f;
  if (!isSfnt) return null;

  const numTables = v.getUint16(4);
  if (12 + numTables * 16 > buffer.byteLength) return null;

  let fvarOffset = -1;
  let nameOffset = -1;

  for (let i = 0; i < numTables; i++) {
    const recordOff = 12 + i * 16;
    const tag =
      String.fromCharCode(v.getUint8(recordOff)) +
      String.fromCharCode(v.getUint8(recordOff + 1)) +
      String.fromCharCode(v.getUint8(recordOff + 2)) +
      String.fromCharCode(v.getUint8(recordOff + 3));
    const offset = v.getUint32(recordOff + 8);
    if (tag === "fvar") fvarOffset = offset;
    else if (tag === "name") nameOffset = offset;
  }

  // Non-variable font — no fvar table. Treat as success-with-empty
  // (caller turns null/empty into "no axes").
  if (fvarOffset < 0) return null;

  // fvar header is 16 bytes. Bail defensively if the file's truncated.
  if (fvarOffset + 16 > buffer.byteLength) return null;
  const majorVersion = v.getUint16(fvarOffset);
  if (majorVersion !== 1) return null;
  const axesArrayOffset = v.getUint16(fvarOffset + 4);
  const axisCount = v.getUint16(fvarOffset + 8);
  const axisSize = v.getUint16(fvarOffset + 10);

  const nameLookup =
    nameOffset >= 0
      ? parseNameTable(v, nameOffset, buffer.byteLength)
      : new Map<number, string>();

  const axes: FontAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const axisOff = fvarOffset + axesArrayOffset + i * axisSize;
    if (axisOff + 20 > buffer.byteLength) break;
    const tag =
      String.fromCharCode(v.getUint8(axisOff)) +
      String.fromCharCode(v.getUint8(axisOff + 1)) +
      String.fromCharCode(v.getUint8(axisOff + 2)) +
      String.fromCharCode(v.getUint8(axisOff + 3));
    const min = v.getInt32(axisOff + 4) / 65536;
    const def = v.getInt32(axisOff + 8) / 65536;
    const max = v.getInt32(axisOff + 12) / 65536;
    const nameID = v.getUint16(axisOff + 18);
    const name =
      nameLookup.get(nameID) ||
      BUILTIN_AXIS_LABELS[tag] ||
      tag;
    axes.push({ tag, name, min, max, default: def });
  }

  return axes.length > 0 ? axes : null;
}

// Best-effort name-table parser. We only need English strings for
// the axis labels — return them keyed on nameID. Skips records
// whose offsets are out of range so a malformed/locked-down font
// can't crash us.
function parseNameTable(
  v: DataView,
  offset: number,
  totalLength: number
): Map<number, string> {
  const out = new Map<number, string>();
  if (offset + 6 > totalLength) return out;
  const count = v.getUint16(offset + 2);
  const stringOffset = v.getUint16(offset + 4);
  const recordsStart = offset + 6;
  if (recordsStart + count * 12 > totalLength) return out;

  // Priority list: pick the first English variant we see for each
  // nameID. Windows + en-US is the most-shipped combo, but plenty
  // of older fonts only ship Mac Roman strings.
  const ENGLISH_LANGS = new Set([
    0x0409, // Windows en-US
    0x0809, // Windows en-GB
    0x0c09, // Windows en-AU
    0,      // Macintosh + Unicode = English
  ]);

  for (let i = 0; i < count; i++) {
    const recordOff = recordsStart + i * 12;
    const platformID = v.getUint16(recordOff);
    const encodingID = v.getUint16(recordOff + 2);
    const languageID = v.getUint16(recordOff + 4);
    const nameID = v.getUint16(recordOff + 6);
    const length = v.getUint16(recordOff + 8);
    const stringOff = v.getUint16(recordOff + 10);
    if (out.has(nameID)) continue;
    if (!ENGLISH_LANGS.has(languageID)) continue;
    const stringStart = offset + stringOffset + stringOff;
    if (stringStart + length > totalLength) continue;
    const isUtf16 =
      platformID === 0 ||
      platformID === 3; // Unicode + Windows are UTF-16 BE
    let s = "";
    try {
      if (isUtf16) {
        for (let j = 0; j + 1 < length; j += 2) {
          s += String.fromCharCode(v.getUint16(stringStart + j));
        }
      } else {
        // Macintosh Roman — best-effort ASCII fallback.
        for (let j = 0; j < length; j++) {
          const b = v.getUint8(stringStart + j);
          if (b < 0x80) s += String.fromCharCode(b);
        }
      }
    } catch {
      continue;
    }
    if (s.length > 0) out.set(nameID, s);
    // Suppress unused-var warning — encodingID isn't needed but
    // exists in the format and is worth keeping in scope for
    // future encoding-aware parsing.
    void encodingID;
  }
  return out;
}
