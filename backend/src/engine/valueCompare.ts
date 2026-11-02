/**
 * Pure value comparison helpers for the rules (B6). Inputs are already normalized by B4 (assertions.ts).
 */
import { valueKindOf } from "./assertions";

/** Case, punctuation and whitespace insensitive text key (addresses and other free text). */
export function textKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const identifierKey = (s: string): string => s.normalize("NFC").replace(/\s+/g, "").toUpperCase();

/** Parses a plain decimal string ("-1200.50") into integer hundredths-of-a-cent (4 decimals) as bigint. null if not a decimal. */
export function toScaled(s: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(4, "0");
  if (frac.length > 4 && /[1-9]/.test(frac.slice(4))) return null; // more than 4 significant decimals: do not round silently
  const v = BigInt((m[2] ?? "0") + frac.slice(0, 4));
  return m[1] === "-" ? -v : v;
}

export const SCALE_PER_CENT = 100n; // 4 decimals => one cent is 100 units

export function amountsEqual(a: string, b: string): boolean {
  const x = toScaled(a), y = toScaled(b);
  return x !== null && y !== null && x === y;
}

export function formatScaled(v: bigint): string {
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(5, "0");
  const whole = abs.slice(0, -4), frac = abs.slice(-4).replace(/0{1,2}$/, "");
  return `${neg ? "-" : ""}${whole}.${frac.padEnd(2, "0")}`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isoParts(s: string): { y: number; m: number; d: number } | null {
  const m = ISO.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/** True when two ISO dates differ only by swapping day and month (and that swap is a real date). */
export function isDayMonthSwap(a: string, b: string): boolean {
  const x = isoParts(a), y = isoParts(b);
  return !!x && !!y && x.y === y.y && x.m !== x.d && x.m === y.d && x.d === y.m && x.m <= 12 && x.d <= 12;
}

/** Equality for the "exact" match method, by the value kind of the semantic type. */
export function exactEqual(semanticType: string, a: string, b: string): boolean {
  switch (valueKindOf(semanticType)) {
    case "identifier": return identifierKey(a) === identifierKey(b);
    case "amount": return amountsEqual(a, b);
    case "date": return a === b;
    default: return textKey(a) === textKey(b);
  }
}
