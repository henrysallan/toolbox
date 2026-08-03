// Shared by the codemod and the audit: which byte offsets of a source file
// sit inside a string literal.
//
// This exists because the first codemod pass scanned line-by-line and so
// couldn't see a hex inside a MULTI-LINE template literal — EffectNode.tsx's
// `linear-gradient(\n  …\n), #18181b` slipped through, and the Layer IO
// nodes stayed dark in light mode. Tracking template literals across
// newlines is the whole point.

/**
 * A byte-per-offset mask: 1 where the character is inside a string or
 * template literal, 0 elsewhere. Comments are skipped so a hex mentioned in
 * prose is never rewritten.
 */
export function stringMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = ++i;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        // Template literals run across newlines; plain quotes cannot. Bailing
        // at the newline stops an apostrophe in JSX prose ("don't") from
        // masking the rest of the file.
        if (quote !== "`" && src[i] === "\n") break;
        i++;
      }
      for (let j = start; j < i && j < src.length; j++) mask[j] = 1;
      i++;
      continue;
    }
    i++;
  }
  return mask;
}

/** Maps a byte offset to its 1-based line number. */
export function lineIndex(src: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (off: number) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The full text of the line containing `offset`. */
export function lineTextAt(src: string, offset: number): string {
  const start = src.lastIndexOf("\n", offset) + 1;
  const end = src.indexOf("\n", offset);
  return src.slice(start, end === -1 ? src.length : end);
}
