// Figma text layout → toolbox Text node pieces (specdocs/092326_figma-import.md
// §Text). Pure — the gate drives it without a DOM.
//
// The Plugin API has no layout info, but Figma's own SVG export of a text
// node with live text (svgOutlineText off) does: one <tspan x y> per laid-out
// line run, y = the baseline, text with the case transform applied, one
// <text> element per style. That gives Figma's real line breaks and
// baselines, which the importer reproduces exactly instead of re-wrapping.
//
// Grouping: a single-style text becomes ONE Text node (native alignment,
// lines joined with "\n"). Mixed styles become left-aligned pieces placed at
// their runs' x, merging runs that share a style and an x on consecutive
// lines — a highlighted word in a paragraph is 3 nodes (the paragraph's
// line starts, the highlight, the rest of its line), not one per run.

import type { FigmaTextNode, FigmaTextSegment } from "./scene";

export interface SvgTextRun {
  x: number; // node-local px (unrotated text)
  y: number; // baseline, node-local px
  text: string; // as laid out — case transform applied
  fill: string | null; // SVG fill attr: a colour, or url(#…) for gradients
  fontFamily: string | null;
  fontSize: number | null;
  fontWeight: number | null;
  italic: boolean;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

// The runs of a Figma text SVG export, or null when the export can't be
// placed as flat text (a transformed <text>, no runs).
export function parseFigmaTextSvg(svg: string | undefined): SvgTextRun[] | null {
  if (!svg) return null;
  const runs: SvgTextRun[] = [];
  for (const block of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = attrs(block[1]);
    if (a.transform) return null; // rotated / skewed text — the caller falls back
    const size = a["font-size"] ? parseFloat(a["font-size"]) : NaN;
    const weight = a["font-weight"] ? parseFloat(a["font-weight"]) : NaN;
    for (const t of block[2].matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)) {
      const ta = attrs(t[1]);
      const x = parseFloat(ta.x ?? "0");
      const y = parseFloat(ta.y ?? "NaN");
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      runs.push({
        x,
        y,
        text: decodeXml(t[2].replace(/<[^>]*>/g, "")),
        fill: a.fill ?? null,
        fontFamily: a["font-family"] ?? null,
        fontSize: Number.isFinite(size) ? size : null,
        fontWeight: Number.isFinite(weight) ? weight : null,
        italic: a["font-style"] === "italic",
      });
    }
  }
  return runs.length ? runs : null;
}

export interface TextPiece {
  // Display lines in ORIGINAL case when the case transform is one toolbox
  // reproduces (upper / lower) — so editing keeps Figma's intent.
  lines: string[];
  textCase: "none" | "upper" | "lower";
  align: "left" | "center" | "right";
  // Node-local px: the left edge (left), centre (center) or right edge
  // (right) the lines align to.
  anchorX: number;
  boxWidth: number; // node-local px
  firstBaseline: number; // node-local px
  // Line advance in px — Figma's measured step for multi-line pieces; null
  // for a single line (the caller uses the style's line height).
  step: number | null;
  segment: FigmaTextSegment;
  label: string;
  // Runs in this piece whose style came from the SVG only (no segment
  // matched) — the caller reports it.
  unmatched: boolean;
}

// Line / paragraph separators (Figma writes a soft line break as U+2028)
// and trailing blanks. Built from char codes: as literals the separators
// would end a regex literal early.
const SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029, 0x0a, 0x0d) + "]", "g");
const TRAILING_BLANKS = new RegExp("[" + String.fromCharCode(0x20, 0x09, 0xa0) + "]+$");

// Visible end of a run: trailing whitespace hangs in Figma's layout (it
// never shifts alignment), so drop it — and any line/paragraph separators.
function trimRunEnd(s: string): string {
  return s.replace(SEPARATORS, "").replace(TRAILING_BLANKS, "");
}

function styleKey(s: FigmaTextSegment): string {
  const fills = s.fills
    .filter((p) => p.visible)
    .map((p) => (p.type === "SOLID" ? `${p.color.r},${p.color.g},${p.color.b},${p.opacity}` : p.type))
    .join("+");
  return [
    s.fontFamily,
    s.fontStyle,
    s.fontSize,
    s.fontWeight,
    s.italic,
    s.textCase,
    s.textDecoration,
    s.letterSpacing.unit,
    s.letterSpacing.value,
    fills,
  ].join("|");
}

interface MappedRun extends SvgTextRun {
  start: number | null; // UTF-16 offset into characters, when found
  segment: FigmaTextSegment;
  unmatched: boolean;
}

// Attach each run (reading order) to its characters and style segment. The
// runs' text is the laid-out text — case transformed, separators included —
// so a case-insensitive scan from a cursor finds each one; anything that
// changes length under case mapping (ß → SS) falls back to the SVG's style.
function mapRuns(node: FigmaTextNode, runs: SvgTextRun[]): MappedRun[] {
  const chars = node.text.characters;
  const lower = chars.toLowerCase();
  const segs = node.text.segments;
  const segAt = (i: number) => segs.find((s) => i >= s.start && i < s.end) ?? segs[segs.length - 1];
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  let cursor = 0;
  return sorted.map((r) => {
    const needle = r.text.toLowerCase();
    const at = needle.length ? lower.indexOf(needle, cursor) : -1;
    if (at >= 0) {
      cursor = at + needle.length;
      // A run can straddle segments only if they share a style (Figma
      // splits runs on style changes), so its first visible character
      // decides.
      const firstVisible = at + (needle.length - needle.trimStart().length);
      return { ...r, start: at, segment: segAt(Math.min(firstVisible, chars.length - 1)), unmatched: false };
    }
    return { ...r, start: null, segment: bestSegmentForSvg(segs, r), unmatched: true };
  });
}

function bestSegmentForSvg(segs: FigmaTextSegment[], r: SvgTextRun): FigmaTextSegment {
  return (
    segs.find(
      (s) =>
        (r.fontSize == null || Math.abs(s.fontSize - r.fontSize) < 0.01) &&
        (r.fontWeight == null || Math.abs(s.fontWeight - r.fontWeight) < 0.5) &&
        (r.fontFamily == null || s.fontFamily === r.fontFamily)
    ) ?? segs[0]
  );
}

// The run's text in original case when the segment's transform is one the
// Text node reproduces; otherwise the laid-out text and case "none".
function runDisplay(node: FigmaTextNode, r: MappedRun): { text: string; textCase: TextPiece["textCase"] } {
  const tc = r.segment.textCase;
  if (r.start != null && (tc === "UPPER" || tc === "LOWER" || tc === "ORIGINAL")) {
    const original = node.text.characters.slice(r.start, r.start + r.text.length);
    return { text: original, textCase: tc === "UPPER" ? "upper" : tc === "LOWER" ? "lower" : "none" };
  }
  return { text: r.text, textCase: "none" };
}

const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// A text layer's name defaults to its whole content — too long to tell a
// paragraph's pieces apart in the Merge stack, which shows ~80 chars.
function shortName(name: string, max = 28): string {
  return name.length > max ? `${name.slice(0, max).trimEnd()}…` : name;
}

interface Line {
  y: number;
  runs: MappedRun[]; // by x
}

function toLines(runs: MappedRun[]): Line[] {
  const lines: Line[] = [];
  for (const r of runs) {
    const line = lines.find((l) => near(l.y, r.y, 0.01));
    if (line) line.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  lines.sort((a, b) => a.y - b.y);
  for (const l of lines) l.runs.sort((a, b) => a.x - b.x);
  return lines;
}

export function buildTextPieces(node: FigmaTextNode, runs: SvgTextRun[]): TextPiece[] {
  if (node.text.segments.length === 0) return [];
  const mapped = mapRuns(node, runs).filter((r) => trimRunEnd(r.text).length > 0);
  if (mapped.length === 0) return [];
  const lines = toLines(mapped);
  const keys = new Set(mapped.map((r) => styleKey(r.segment)));
  const name = node.name;

  if (keys.size === 1) {
    // One style: one piece per run of evenly stepped lines (paragraph
    // spacing breaks the step; a blank line is a whole-step gap).
    const align: TextPiece["align"] =
      node.text.alignHorizontal === "CENTER" ? "center" : node.text.alignHorizontal === "RIGHT" ? "right" : "left";
    const anchorX = align === "center" ? node.width / 2 : align === "right" ? node.width : 0;
    const pieces: TextPiece[] = [];
    let cur: { lines: string[]; ys: number[]; runs: MappedRun[]; step: number | null } | null = null;
    const flush = () => {
      if (!cur) return;
      const first = cur.runs[0];
      const disp = runDisplay(node, first);
      const leftX = align === "left" ? Math.min(...cur.runs.map((r) => r.x)) : anchorX;
      pieces.push({
        lines: cur.lines,
        textCase: disp.textCase,
        align,
        anchorX: leftX,
        boxWidth: align === "left" ? Math.max(1, node.width - leftX) : node.width,
        firstBaseline: cur.ys[0],
        step: cur.step,
        segment: first.segment,
        label: pieces.length ? `${shortName(name)} · ${pieces.length + 1}` : name,
        unmatched: cur.runs.some((r) => r.unmatched),
      });
      cur = null;
    };
    for (const line of lines) {
      const text = trimRunEnd(line.runs.map((r) => runDisplay(node, r).text).join(""));
      const leftX = line.runs[0].x;
      if (cur) {
        const lastY = cur.ys[cur.ys.length - 1];
        const gap = line.y - lastY;
        const step = cur.step ?? gap;
        const k = Math.round(gap / step);
        const sameIndent = align !== "left" || near(leftX, cur.runs[0].x);
        if (step > 0 && k >= 1 && near(gap, k * step) && sameIndent) {
          for (let i = 1; i < k; i++) cur.lines.push("");
          cur.lines.push(text);
          cur.ys.push(line.y);
          cur.runs.push(line.runs[0]);
          cur.step = step;
          continue;
        }
        flush();
      }
      cur = { lines: [text], ys: [line.y], runs: [line.runs[0]], step: null };
    }
    flush();
    return pieces;
  }

  // Mixed styles: every run left-aligned at its own x, merged down the page
  // with the run directly below that shares its x and style.
  interface Open {
    runs: MappedRun[];
    lines: string[];
    ys: number[];
    lineIndex: number;
    key: string;
    step: number | null;
  }
  const done: Open[] = [];
  let open: Open[] = [];
  lines.forEach((line, li) => {
    const next: Open[] = [];
    for (const r of line.runs) {
      const key = styleKey(r.segment);
      const text = trimRunEnd(runDisplay(node, r).text);
      const match = open.find(
        (o) =>
          o.lineIndex === li - 1 &&
          o.key === key &&
          near(o.runs[0].x, r.x) &&
          (o.step == null || near(line.y - o.ys[o.ys.length - 1], o.step))
      );
      if (match) {
        match.step = line.y - match.ys[match.ys.length - 1];
        match.runs.push(r);
        match.lines.push(text);
        match.ys.push(line.y);
        match.lineIndex = li;
        open = open.filter((o) => o !== match);
        next.push(match);
      } else {
        next.push({ runs: [r], lines: [text], ys: [line.y], lineIndex: li, key, step: null });
      }
    }
    done.push(...open); // runs with nothing below them
    open = next;
  });
  done.push(...open);
  done.sort((a, b) => a.ys[0] - b.ys[0] || a.runs[0].x - b.runs[0].x);
  return done.map((o, i) => {
    const first = o.runs[0];
    const disp = runDisplay(node, first);
    const snippet = trimRunEnd(first.text).trim().slice(0, 18);
    return {
      lines: o.lines,
      textCase: disp.textCase,
      align: "left" as const,
      anchorX: first.x,
      boxWidth: Math.max(1, node.width - first.x),
      firstBaseline: o.ys[0],
      step: o.step,
      segment: first.segment,
      label: i === 0 ? name : `${shortName(name)} · “${snippet}”`,
      unmatched: o.runs.some((r) => r.unmatched),
    };
  });
}
