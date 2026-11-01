/**
 * Token-sort ratio, implemented here (no dependency). Shared by the entity resolver (B5) and the rules (B6).
 * Pure. Score is 0..100: lower-case, punctuation to spaces, tokens sorted alphabetically, then
 * 100 * 2 * LCS / (len(a) + len(b)) on the joined strings (the same Indel ratio most fuzzy libraries use).
 */

export function nameTokens(input: string): string[] {
  return input.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export function tokenSortRatio(a: string, b: string): number {
  const sa = nameTokens(a).sort().join(" ");
  const sb = nameTokens(b).sort().join(" ");
  if (!sa || !sb) return 0;
  return (100 * 2 * lcsLength(sa, sb)) / (sa.length + sb.length);
}

/** Best ratio over all pairs of names; 0 when either side has none. */
export function bestNameRatio(namesA: readonly string[], namesB: readonly string[]): number {
  let best = 0;
  for (const x of namesA) for (const y of namesB) best = Math.max(best, tokenSortRatio(x, y));
  return best;
}

/** One decimal, no trailing ".0": 80 -> "80", 85.714 -> "85.7". */
export const formatRatio = (r: number): string => String(Math.round(r * 10) / 10);
