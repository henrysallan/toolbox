// Snapshot comparison for emitted bundles that tolerates last-bit float
// noise. Bundles carry raw doubles (sampled series, xforms), and Math.sin /
// cos / exp are not bit-identical across V8 builds — Node on macOS arm64
// (where snapshots are written) and Linux x64 (CI) differ in the last ulp —
// so byte equality fails on CI for a correct export. Everything outside
// numeric literals must match exactly; numbers must agree to `tol` relative
// (absolute below 1). A real change (a different value, a rounding flip in a
// toFixed'd number, a new field) still fails.

const NUM = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

export function sameUpToFloatNoise(a: string, b: string, tol = 1e-12): boolean {
  if (a === b) return true;
  if (a.replace(NUM, "#") !== b.replace(NUM, "#")) return false;
  const na = a.match(NUM) ?? [];
  const nb = b.match(NUM) ?? [];
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    if (na[i] === nb[i]) continue;
    const x = Number(na[i]);
    const y = Number(nb[i]);
    if (!(Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y)))) return false;
  }
  return true;
}

// The first line of `have` / `want` that differs beyond float noise, as
// "<file>:<line>" plus both sides around the first differing character —
// or "" when the texts agree.
export function snapshotDrift(file: string, have: string, want: string): string {
  if (sameUpToFloatNoise(have, want)) return "";
  const a = have.split("\n");
  const b = want.split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const la = a[i] ?? "";
    const lb = b[i] ?? "";
    if (sameUpToFloatNoise(la, lb)) continue;
    let c = 0;
    while (c < la.length && la[c] === lb[c]) c++;
    const from = Math.max(0, c - 60);
    const cut = (s: string) => `${from > 0 ? "…" : ""}${s.slice(from, c + 60)}${s.length > c + 60 ? "…" : ""}`;
    return `${file}:${i + 1} (first difference at column ${c + 1})\n       snapshot: ${cut(la)}\n       emitted:  ${cut(lb)}`;
  }
  return `${file}: line structure differs`;
}
