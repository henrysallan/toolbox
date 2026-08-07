// CSV parsing + per-column type inference for the CSV node.
//
// Engine-side and self-contained (invariant #1): no imports outside the engine
// subtree, no GL, no DOM. Pure functions + a small identity-keyed memo so the
// node's compute() and its resolveAuxOutputs() (which both parse the same
// stored value every eval / socket-refresh) share one parse.
//
// The parser is a hand-rolled RFC-4180-ish state machine (quoted fields,
// doubled-quote escapes, CRLF/LF, a caller-chosen or sniffed delimiter). No
// dependency. Inference decides, per column, whether every non-empty cell is a
// finite number — that column then drives `scalar` sockets; otherwise `string`.
// This is the only bridge that lets numeric CSV columns reach scalar inputs
// (there is deliberately no string→scalar coercion in the engine).

import type { CsvFileParamValue } from "./types";

export type CsvDelimiter = "auto" | "comma" | "tab" | "semicolon";
export type CsvColumnType = "number" | "string";

export interface CsvColumn {
  header: string;
  type: CsvColumnType;
  // Raw string cell per data row (length === rowCount). For a `number`
  // column, `numbers[i]` holds the parsed value (empty/garbage → 0).
  cells: string[];
  numbers?: number[];
}

export interface ParsedCsv {
  headers: string[];
  columns: CsvColumn[];
  rowCount: number;
  // Delimiter actually used (after auto-sniff), for display/debug.
  delimiter: string;
}

export interface CsvParseOptions {
  hasHeader: boolean;
  delimiter: CsvDelimiter;
}

const EMPTY: ParsedCsv = {
  headers: [],
  columns: [],
  rowCount: 0,
  delimiter: ",",
};

const DELIM_CHAR: Record<Exclude<CsvDelimiter, "auto">, string> = {
  comma: ",",
  tab: "\t",
  semicolon: ";",
};

// Pick the delimiter that appears most on the first physical line. Ties and
// no-hits fall back to comma. Cheap and good enough — the manual override is
// there for the rare ambiguous file.
function sniffDelimiter(text: string): string {
  const nl = text.indexOf("\n");
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;
  for (const c of candidates) {
    let n = 0;
    for (let i = 0; i < firstLine.length; i++) if (firstLine[i] === c) n++;
    if (n > bestCount) {
      bestCount = n;
      best = c;
    }
  }
  return best;
}

// Split raw CSV text into rows of string fields, honoring quotes. A field
// wrapped in double quotes may contain the delimiter, newlines, and doubled
// quotes (`""` → a literal `"`). Handles both CRLF and LF line endings.
//
// Exported because the List node's parser reuses it (080526_list-socket.md):
// newline + delimiter + quote handling in one pass is exactly what a general
// list parser needs — it just flattens the rows instead of keeping them.
export function parseRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delim) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // Swallow CRLF as one break; a lone CR also ends the row.
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush the trailing field/row unless the text ended exactly on a newline
  // (which already pushed the row) with nothing after it.
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

// Clean a raw cell down to a number, or null if it isn't one. Trims, strips a
// leading currency mark and a trailing percent, and removes thousands commas —
// but only accepts the result if what's left is a plain numeric literal, so
// text like "N/A" or "12 apples" stays a string. `%` divides by 100.
export function parseNumericCell(raw: string): number | null {
  let s = raw.trim();
  if (s === "") return null;
  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  if (s[0] === "$" || s[0] === "€" || s[0] === "£") s = s.slice(1).trim();
  s = s.replace(/,/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return percent ? v / 100 : v;
}

// A column is numeric iff it has at least one non-empty cell and every
// non-empty cell parses. Empty cells are ignored for the decision and become 0
// in the emitted numbers array.
function inferColumn(header: string, cells: string[]): CsvColumn {
  let sawValue = false;
  let allNumeric = true;
  for (const c of cells) {
    if (c.trim() === "") continue;
    sawValue = true;
    if (parseNumericCell(c) === null) {
      allNumeric = false;
      break;
    }
  }
  if (sawValue && allNumeric) {
    const numbers = cells.map((c) => parseNumericCell(c) ?? 0);
    return { header, type: "number", cells, numbers };
  }
  return { header, type: "string", cells };
}

// Parse raw CSV text into columns with inferred types. Pure — see parseCsv()
// for the memoized entry point the node actually calls.
export function parseCsvText(text: string, opts: CsvParseOptions): ParsedCsv {
  if (!text || text.trim() === "") return EMPTY;
  const delim =
    opts.delimiter === "auto" ? sniffDelimiter(text) : DELIM_CHAR[opts.delimiter];
  const rows = parseRows(text, delim).filter(
    // Drop fully-blank lines (a single empty field) so a trailing newline or
    // blank separator row doesn't become a phantom data row.
    (r) => !(r.length === 1 && r[0].trim() === "")
  );
  if (rows.length === 0) return EMPTY;

  const headerRow = opts.hasHeader ? rows[0] : null;
  const dataRows = opts.hasHeader ? rows.slice(1) : rows;
  const width = Math.max(
    headerRow?.length ?? 0,
    ...dataRows.map((r) => r.length),
    1
  );

  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    const h = headerRow?.[c]?.trim();
    headers.push(h && h !== "" ? h : `col ${c + 1}`);
  }

  const columns: CsvColumn[] = [];
  for (let c = 0; c < width; c++) {
    const cells = dataRows.map((r) => r[c] ?? "");
    columns.push(inferColumn(headers[c], cells));
  }

  return { headers, columns, rowCount: dataRows.length, delimiter: delim };
}

// Identity-keyed memo. The node passes the SAME CsvFileParamValue object on
// every eval and every resolveAuxOutputs() call until the user edits it, so a
// WeakMap keyed on that object (sub-keyed by the parse options) means we parse
// each distinct CSV once, GC it with the value, and never leak.
const memo = new WeakMap<CsvFileParamValue, Map<string, ParsedCsv>>();

export function parseCsv(
  value: CsvFileParamValue | null | undefined,
  opts: CsvParseOptions
): ParsedCsv {
  if (!value || !value.text) return EMPTY;
  const key = `${opts.hasHeader ? "h" : "n"}:${opts.delimiter}`;
  let byOpts = memo.get(value);
  if (!byOpts) {
    byOpts = new Map();
    memo.set(value, byOpts);
  }
  const cached = byOpts.get(key);
  if (cached) return cached;
  const parsed = parseCsvText(value.text, opts);
  byOpts.set(key, parsed);
  return parsed;
}

// The cell at (column, row) as a display string. Out-of-range → "".
export function csvCellString(col: CsvColumn, row: number): string {
  return col.cells[row] ?? "";
}
