// Filename tokens for wedge batch renders (spec
// 071026_wedge-render-batching.md). Applied to the Output node's sanitized
// `filename` base by every export path that can run a batch. Tokens:
//
//   {i}    the batch iteration index, 0-based
//   {i:N}  zero-padded to width N (1–6), e.g. {i:3} → 007
//
// A batch (total > 1) whose base names no token gets `_{i:3}` appended
// automatically so variations never collide into the generic `-2` de-dupe
// suffixes. Single renders resolve tokens too (i = 0), so a token in the
// filename is always honored, never leaks into the file name literally.
//
// `{wedge:Name}` (value-based tokens) is specced but not implemented yet.

const TOKEN_RE = /\{i(?::([1-6]))?\}/g;

export function hasWedgeToken(base: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(base);
}

export function resolveWedgeName(
  base: string,
  index: number,
  total: number
): string {
  let name = base;
  if (!hasWedgeToken(name)) {
    if (total <= 1) return name;
    name = `${name}_{i:3}`;
  }
  TOKEN_RE.lastIndex = 0;
  return name.replace(TOKEN_RE, (_m, width) =>
    width ? String(index).padStart(Number(width), "0") : String(index)
  );
}
