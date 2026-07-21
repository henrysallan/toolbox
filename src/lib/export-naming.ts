// Filename tokens for wedge batch renders (spec
// 071026_wedge-render-batching.md). Applied to the Output node's sanitized
// `filename` base by every export path that can run a batch. Tokens:
//
//   {i}           the batch iteration index, 0-based
//   {i:N}         zero-padded to width N (1–6), e.g. {i:3} → 007
//   {wedge}       the first upstream wedge's value at this iteration
//   {wedge:Name}  the value of the wedge node named Name (display name,
//                 case-insensitive) — e.g. "logo_seed{wedge:Seed}"
//
// A batch (total > 1) whose base names no token gets `_{i:3}` appended
// automatically so variations never collide into the generic `-2` de-dupe
// suffixes. Single renders resolve tokens too (i = 0), so a token in the
// filename is always honored, never leaks into the file name literally.

const INDEX_RE = /\{i(?::([1-6]))?\}/g;
const NAMED_RE = /\{wedge(?::([^}]*))?\}/gi;

// One upstream wedge's contribution at the current iteration — built by the
// export drivers from wedge-batch.ts info + wedgeTokenValue.
export interface WedgeTokenSource {
  name: string;
  value: string;
}

export function hasWedgeToken(base: string): boolean {
  INDEX_RE.lastIndex = 0;
  NAMED_RE.lastIndex = 0;
  return INDEX_RE.test(base) || NAMED_RE.test(base);
}

// Token values may be arbitrary user strings (a string-type wedge's rows) —
// strip the same filesystem-unsafe set as sanitizeFilename.
function sanitizeTokenValue(v: string): string {
  return v.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
}

export function resolveWedgeName(
  base: string,
  index: number,
  total: number,
  wedges?: WedgeTokenSource[]
): string {
  let name = base;
  if (!hasWedgeToken(name)) {
    if (total <= 1) return name;
    name = `${name}_{i:3}`;
  }
  INDEX_RE.lastIndex = 0;
  name = name.replace(INDEX_RE, (_m, width) =>
    width ? String(index).padStart(Number(width), "0") : String(index)
  );
  NAMED_RE.lastIndex = 0;
  name = name.replace(NAMED_RE, (_m, rawName) => {
    if (!wedges || wedges.length === 0) return "";
    if (!rawName) return sanitizeTokenValue(wedges[0].value);
    const want = String(rawName).trim().toLowerCase();
    const hit = wedges.find((w) => w.name.trim().toLowerCase() === want);
    return hit ? sanitizeTokenValue(hit.value) : "";
  });
  // A base that was ONLY an unresolvable token must still yield a distinct,
  // non-empty name per variation.
  return name || String(index);
}

// Container name for a delivery that spans ALL variations (the sequence
// export's single zip): tokens come out rather than resolving to one index,
// plus any separator they leave dangling ("logo_{i}" → "logo"). Empty after
// stripping falls back to the raw base so a filename that was ONLY a token
// still yields something usable.
export function stripWedgeTokens(base: string): string {
  INDEX_RE.lastIndex = 0;
  NAMED_RE.lastIndex = 0;
  const stripped = base
    .replace(INDEX_RE, "")
    .replace(NAMED_RE, "")
    .replace(/[-_. ]+$/, "")
    .replace(/^[-_. ]+/, "");
  return stripped || base;
}
