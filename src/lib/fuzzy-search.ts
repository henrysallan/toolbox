// Fuzzy string scoring for the node add menus.
//
// Two matching strategies, combined per query token (best wins):
//
//   1. Subsequence (fzy-style DP): query chars must appear in order but
//      not adjacent — "rastspline" finds "Rasterize Spline". Scoring
//      favors word-boundary hits, consecutive runs, and early matches,
//      so "sim" ranks "Simplex Noise" above "Particle Simulator".
//   2. Typo tolerance (Damerau-Levenshtein per word): catches what a
//      subsequence can't — transpositions and wrong letters, so
//      "guassian" still finds "Gaussian Blur". Budget: 1 edit for
//      4+ char tokens, 2 edits for 8+. Scores below strategy 1 so
//      clean matches always outrank typo matches.
//
// Multi-token queries ("part sim") require every token to match, each
// against its best-scoring field, so tokens can hit different fields
// ("spline blur" → blur nodes in the spline category).
//
// All scores are positive; higher = better; null = no match.

const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":", "("]);

// Bonus for matching hay[i], based on what precedes it.
function boundaryBonus(hay: string, i: number): number {
  if (i === 0) return 1.5;
  return SEPARATORS.has(hay[i - 1]) ? 1.0 : 0;
}

// fzy-style dynamic program. D[j][i] = best score with needle[j] matched
// exactly at hay[i]; M[j][i] = best score with needle[0..j] matched
// anywhere in hay[0..i]. Each matched char is worth 1 plus bonuses;
// gaps cost a little so tight matches in short names win ties.
function subsequenceScore(needle: string, hay: string): number | null {
  const n = needle.length;
  const m = hay.length;
  if (n === 0 || n > m) return null;
  const NEG = -Infinity;
  let prevD: number[] = new Array(m).fill(NEG);
  let prevM: number[] = new Array(m).fill(NEG);
  for (let j = 0; j < n; j++) {
    const curD: number[] = new Array(m).fill(NEG);
    const curM: number[] = new Array(m).fill(NEG);
    const c = needle[j];
    for (let i = j; i < m; i++) {
      if (hay[i] === c) {
        if (j === 0) {
          // Leading gap: cheap, so mid-name matches stay viable.
          curD[i] = 1 + boundaryBonus(hay, i) - i * 0.01;
        } else {
          const afterGap =
            prevM[i - 1] === NEG ? NEG : prevM[i - 1] + 1 + boundaryBonus(hay, i);
          const consecutive =
            prevD[i - 1] === NEG
              ? NEG
              : prevD[i - 1] + 1 + Math.max(boundaryBonus(hay, i), 1);
          curD[i] = Math.max(afterGap, consecutive);
        }
      }
      const gapped = i > j && curM[i - 1] !== NEG ? curM[i - 1] - 0.03 : NEG;
      curM[i] = Math.max(curD[i], gapped);
    }
    prevD = curD;
    prevM = curM;
  }
  const best = prevM[m - 1];
  return best === NEG ? null : Math.max(best, 0.01);
}

// Optimal-string-alignment distance (Levenshtein + adjacent transposition),
// early-exiting once a row exceeds `cap`. Returns cap+1 when over budget.
function osaDistance(a: string, b: string, cap: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > cap) return cap + 1;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: m + 1 }, (_, i) => i);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2![j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

// Compare the token against each word of the hay — both the whole word
// and its prefix of the token's length, so a typo'd partial word
// ("guassi" → "gaussian") still lands.
function typoScore(token: string, hay: string): number | null {
  if (token.length < 4) return null;
  const budget = token.length >= 8 ? 2 : 1;
  let best: number | null = null;
  for (const word of hay.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    let d = osaDistance(token, word, budget);
    if (word.length > token.length) {
      d = Math.min(d, osaDistance(token, word.slice(0, token.length), budget));
    }
    if (d <= budget) {
      const s = Math.max(token.length * 0.5 - d * 0.5, 0.01);
      if (best === null || s > best) best = s;
    }
  }
  return best;
}

// token and text must already be lowercase.
function scoreToken(token: string, text: string): number | null {
  const sub = subsequenceScore(token, text);
  const typo = typoScore(token, text);
  if (sub === null && typo === null) return null;
  return Math.max(sub ?? 0, typo ?? 0);
}

export interface FuzzyField {
  text: string;
  // Multiplier on the field's score — rank name hits above type hits
  // above category hits.
  weight: number;
}

// Score a whitespace-separated query against a set of weighted fields.
// Every token must match at least one field; each contributes its
// best weighted field score. Null = at least one token matched nothing.
export function fuzzyScoreFields(
  query: string,
  fields: readonly FuzzyField[]
): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const lowered = fields.map((f) => ({
    text: f.text.toLowerCase(),
    weight: f.weight,
  }));
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    for (const f of lowered) {
      const s = scoreToken(token, f.text);
      if (s !== null) {
        const weighted = s * f.weight;
        if (best === null || weighted > best) best = weighted;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

// Single-field convenience.
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyScoreFields(query, [{ text, weight: 1 }]);
}
