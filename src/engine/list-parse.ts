// List parsing for the List node (080526_list-socket.md).
//
// Engine-side and self-contained (invariant #1): no imports outside the engine
// subtree, no GL, no DOM. Pure functions + a small bounded memo so the node's
// compute() and its resolveAuxOutputs() (both of which parse the same text on
// every eval / socket refresh) share one parse.
//
// The job: turn "whatever the user pasted" into an ordered list of typed items.
// Where the CSV parser answers "what are the rows and columns", this answers
// "what are the items" — and reuses that same parser to do it, since
// `parseRows` already handles newlines, a delimiter, and RFC-4180 quoting in
// one pass. A list is flat by definition, so rows get flattened; the CSV node
// remains the one that cares about table shape.
//
// Item typing mirrors the CSV node's column inference at item granularity: a
// cell that parses as a finite number becomes a `scalar` item, everything else
// a `string` item. That is the only bridge from pasted text to a scalar socket
// (there is deliberately no string→scalar coercion in the engine).

import { parseNumericCell, parseRows } from "./csv-parse";
import type { SocketValue } from "./types";

export type ListFormat =
  | "auto"
  | "lines"
  | "comma"
  | "semicolon"
  | "tab"
  | "pipe"
  | "whitespace"
  | "json"
  | "range";

export interface ListParseOptions {
  format: ListFormat;
  trim: boolean;
  dropEmpty: boolean;
  dedupe: boolean;
}

export interface ParsedList {
  // The typed items, ready to become a ListValue.
  items: SocketValue[];
  // Raw text of each item, pre-typing — what the param-panel preview shows and
  // what `dedupe` compares on.
  cells: string[];
  // Which branch of the sniff actually ran, for the UI summary ("24 items ·
  // lines"). Also the honest answer when `auto` guesses wrong.
  format: Exclude<ListFormat, "auto">;
  // True when every item typed as a number — the List node's `item` aux output
  // becomes a `scalar` socket instead of a `string` one.
  allNumeric: boolean;
}

const EMPTY: ParsedList = {
  items: [],
  cells: [],
  format: "lines",
  allNumeric: false,
};

// Expansion guard for range shorthand: a typo like `1..1e9` must not try to
// build a billion items.
const MAX_RANGE_ITEMS = 10000;

const DELIM_CHAR: Record<"comma" | "semicolon" | "tab" | "pipe", string> = {
  comma: ",",
  semicolon: ";",
  tab: "\t",
  pipe: "|",
};

// Leading list markers stripped from bulleted / numbered lines: "- a", "* a",
// "• a", "– a", "1. a", "1) a", "(1) a".
const MARKER_RE = /^\s*(?:[-*•–—]|\(?\d+[.)])\s+/;

// ---------------------------------------------------------------------------
// Range shorthand
// ---------------------------------------------------------------------------

// `1..10` / `1-10` / `0..20 step 2` / `0..20 x2` / `a..e` / `A..Z`.
// The whole text must be one range expression — anything else (a stray comma,
// a second line) falls through to the normal splitters, so "10-4, 12-6" stays
// a two-item list of strings rather than becoming two expansions.
const NUM_RANGE_RE =
  /^([+-]?\d+(?:\.\d+)?)\s*(?:\.\.\.?|-|–|to)\s*([+-]?\d+(?:\.\d+)?)(?:\s*(?:step|x|by)\s*([+-]?\d+(?:\.\d+)?))?$/i;
const CHAR_RANGE_RE = /^([a-z])\s*(?:\.\.\.?|-|–|to)\s*([a-z])$/i;

function expandRange(text: string): string[] | null {
  const s = text.trim();

  const num = NUM_RANGE_RE.exec(s);
  if (num) {
    const start = Number(num[1]);
    const end = Number(num[2]);
    // A negative or zero step is a typo, not a direction — direction comes
    // from start/end. `Math.abs` keeps `1..10 step -2` sane.
    const rawStep = num[3] === undefined ? 1 : Math.abs(Number(num[3]));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const step = rawStep > 0 ? rawStep : 1;
    const span = Math.abs(end - start);
    const n = Math.floor(span / step) + 1;
    if (n > MAX_RANGE_ITEMS) return null;
    const dir = end >= start ? 1 : -1;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      // Build by multiply-from-start rather than accumulate, so a fractional
      // step (0.1) doesn't drift; toFixed(6) scrubs the residue the same way
      // the Constant node's quantize does.
      const v = start + dir * step * i;
      out.push(String(parseFloat(v.toFixed(6))));
    }
    return out;
  }

  const ch = CHAR_RANGE_RE.exec(s);
  if (ch) {
    // Case follows the FIRST endpoint, so `a..E` reads as a lowercase run.
    const lower = ch[1] === ch[1].toLowerCase();
    const a = ch[1].toLowerCase().charCodeAt(0);
    const b = ch[2].toLowerCase().charCodeAt(0);
    const dir = b >= a ? 1 : -1;
    const out: string[] = [];
    for (let c = a; dir > 0 ? c <= b : c >= b; c += dir) {
      const letter = String.fromCharCode(c);
      out.push(lower ? letter : letter.toUpperCase());
    }
    return out;
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON / array-literal
// ---------------------------------------------------------------------------

// Items come back as their raw text: numbers and strings verbatim, nested
// arrays/objects re-stringified as JSON (v1 has no vec2/composite item typing —
// see the spec's M3). null/undefined become "".
function jsonItemText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function parseJsonArray(text: string): string[] | null {
  const s = text.trim();
  if (!s.startsWith("[")) return null;
  const attempt = (src: string): string[] | null => {
    try {
      const v: unknown = JSON.parse(src);
      return Array.isArray(v) ? v.map(jsonItemText) : null;
    } catch {
      return null;
    }
  };
  const strict = attempt(s);
  if (strict) return strict;
  // Tolerant retry for Python/JS-ish input: trailing commas, and single-quoted
  // strings — but ONLY when there are no double quotes anywhere, so real JSON
  // is never mangled by the quote swap.
  let loose = s.replace(/,\s*([\]}])/g, "$1");
  if (!loose.includes('"')) loose = loose.replace(/'/g, '"');
  return attempt(loose);
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

// Which delimiter appears consistently across the first few lines. Consistency
// (not raw count) is the test: one stray comma inside a line of prose shouldn't
// turn a pasted paragraph list into fragments, but a real delimited list has
// the same character on most lines.
function sniffDelimited(text: string): "comma" | "semicolon" | "tab" | "pipe" | null {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, 8);
  if (lines.length === 0) return null;
  let best: "comma" | "semicolon" | "tab" | "pipe" | null = null;
  let bestScore = 0;
  for (const name of ["tab", "pipe", "semicolon", "comma"] as const) {
    const ch = DELIM_CHAR[name];
    let linesWith = 0;
    let total = 0;
    for (const l of lines) {
      let n = 0;
      for (let i = 0; i < l.length; i++) if (l[i] === ch) n++;
      if (n > 0) linesWith++;
      total += n;
    }
    // Present on every non-empty line (single-line input: present at all).
    if (linesWith !== lines.length) continue;
    if (total > bestScore) {
      bestScore = total;
      best = name;
    }
  }
  return best;
}

function looksBulleted(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  const marked = lines.filter((l) => MARKER_RE.test(l)).length;
  // "Most" rather than "all" — a pasted list often has one unmarked
  // continuation line or a trailing note.
  return marked >= Math.ceil(lines.length * 0.6);
}

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function splitBulleted(text: string): string[] {
  return splitLines(text).map((l) => l.replace(MARKER_RE, ""));
}

// Delimited: reuse the CSV row parser (quotes, embedded newlines, CRLF) and
// flatten. `"a,b"` stays one item; `a,b\nc,d` becomes four.
function splitDelimited(text: string, delim: string): string[] {
  return parseRows(text, delim).flat();
}

function splitWhitespace(text: string): string[] {
  return text.trim().split(/\s+/);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function cellsForFormat(
  text: string,
  format: Exclude<ListFormat, "auto">
): string[] {
  switch (format) {
    case "range":
      return expandRange(text) ?? [text];
    case "json":
      return parseJsonArray(text) ?? [text];
    case "comma":
    case "semicolon":
    case "tab":
    case "pipe":
      return splitDelimited(text, DELIM_CHAR[format]);
    case "whitespace":
      return splitWhitespace(text);
    case "lines":
      return looksBulleted(text) ? splitBulleted(text) : splitLines(text);
  }
}

// First match wins. Order matters: the most specific, least ambiguous shapes
// are tested before the general splitters.
function sniff(text: string): Exclude<ListFormat, "auto"> {
  if (expandRange(text)) return "range";
  if (parseJsonArray(text)) return "json";
  if (looksBulleted(text)) return "lines";
  const delim = sniffDelimited(text);
  if (delim) return delim;
  if (/\r|\n/.test(text.trim())) return "lines";
  if (/\s/.test(text.trim())) return "whitespace";
  return "lines";
}

/** Parse raw list text into typed items. Pure — see `parseList` for the memo. */
export function parseListText(text: string, opts: ListParseOptions): ParsedList {
  if (!text || text.trim() === "") return EMPTY;

  const format = opts.format === "auto" ? sniff(text) : opts.format;
  let cells = cellsForFormat(text, format);

  if (opts.trim) cells = cells.map((c) => c.trim());
  if (opts.dropEmpty) cells = cells.filter((c) => c.trim() !== "");
  if (opts.dedupe) {
    const seen = new Set<string>();
    cells = cells.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  }

  if (cells.length === 0) return { ...EMPTY, format };

  // Item typing, at item granularity (the CSV node does this per column).
  // `allNumeric` drives the retyped `item` output socket, so it has to agree
  // exactly with the per-item kinds below: EVERY cell must parse, empties
  // included. That diverges from the CSV node, which ignores empty cells for
  // the decision and emits 0 for them — here, someone who turned `dropEmpty`
  // off did it to keep the blanks, and typing them as 0 would erase what they
  // asked to preserve. So a list with a hole stays a list of strings.
  let allNumeric = true;
  for (const c of cells) {
    if (c.trim() === "" || parseNumericCell(c) === null) {
      allNumeric = false;
      break;
    }
  }

  const items: SocketValue[] = cells.map((c) =>
    allNumeric
      ? { kind: "scalar", value: parseNumericCell(c) ?? 0 }
      : { kind: "string", value: c }
  );

  return { items, cells, format, allNumeric };
}

/**
 * Memoized parse. The key is the text plus the options, so unlike the CSV
 * node's WeakMap (keyed on a stored value OBJECT) this needs an explicit cap:
 * the List node's text is a plain string param, and a user typing into the
 * textarea would otherwise mint an entry per keystroke. FIFO-evicted at
 * MEMO_MAX — kept small deliberately, since the key EMBEDS the text and a
 * pasted list can be large. A handful of live List nodes plus a few edits of
 * history is all this needs to cover; the hit that matters is compute() and
 * resolveAuxOutputs() sharing one parse within an eval.
 */
const MEMO_MAX = 8;
const memo = new Map<string, ParsedList>();

export function parseList(
  text: string | null | undefined,
  opts: ListParseOptions
): ParsedList {
  if (!text || text.trim() === "") return EMPTY;
  const key = `${opts.format}|${opts.trim ? 1 : 0}${opts.dropEmpty ? 1 : 0}${
    opts.dedupe ? 1 : 0
  }|${text}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const parsed = parseListText(text, opts);
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, parsed);
  return parsed;
}

/** Read the four parse options off a node's params, with the defaults. */
export function listParseOptions(
  params: Record<string, unknown>
): ListParseOptions {
  return {
    format: (params.format as ListFormat) ?? "auto",
    trim: params.trim !== false,
    dropEmpty: params.dropEmpty !== false,
    dedupe: params.dedupe === true,
  };
}
